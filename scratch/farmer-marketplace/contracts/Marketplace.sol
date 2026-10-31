// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./UserRegistry.sol";

/**
 * @title Marketplace
 * @notice Combines product batch listings, buyer orders, and escrow lifecycle into a single contract.
 */
contract Marketplace is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant ARBITER_ROLE = keccak256("ARBITER_ROLE");

    uint256 public constant MAX_PLATFORM_FEE_BPS = 500; // 5% maximum platform fee
    uint256 public constant AUTO_RELEASE_PERIOD = 7 days;

    IERC20 public immutable paymentToken;
    UserRegistry public immutable userRegistry;

    uint256 public platformFeeBps; // Platform fee in basis points (1% = 100 bps)
    address public feeRecipient;

    uint256 public nextBatchId = 1;
    uint256 public nextOrderId = 1;

    enum OrderStatus {
        Placed,
        Shipped,
        Delivered,
        Completed,
        Cancelled,
        Disputed,
        Resolved
    }

    struct Batch {
        uint256 batchId;
        address farmer;
        string cropType;
        uint256 totalQuantity;
        uint256 availableQuantity;
        uint256 pricePerUnit;
        uint256 harvestDate;
        string originLocation;
        string metadataHash;
        bool isActive;
    }

    struct Order {
        uint256 orderId;
        uint256 batchId;
        address buyer;
        address farmer;
        address transporter;
        uint256 quantity;
        uint256 totalPrice;
        OrderStatus status;
        uint256 createdAt;
        uint256 shippedAt;
        string disputeEvidenceHash;
    }

    mapping(uint256 => Batch) public batches;
    mapping(uint256 => Order) public orders;

    event BatchListed(
        uint256 indexed batchId,
        address indexed farmer,
        string cropType,
        uint256 quantity,
        uint256 pricePerUnit
    );

    event OrderPlaced(
        uint256 indexed orderId,
        uint256 indexed batchId,
        address indexed buyer,
        address farmer,
        uint256 quantity,
        uint256 totalPrice
    );

    event OrderShipped(uint256 indexed orderId, address indexed transporter);
    event OrderDelivered(uint256 indexed orderId);
    event OrderCompleted(uint256 indexed orderId);
    event OrderCancelled(uint256 indexed orderId);
    event AutoReleased(uint256 indexed orderId, uint256 farmerAmount, uint256 feeAmount);
    event DisputeRaised(uint256 indexed orderId, address indexed buyer, string evidenceHash);
    event DisputeResolved(
        uint256 indexed orderId,
        uint256 buyerRefundPercent,
        uint256 buyerAmount,
        uint256 farmerAmount
    );
    event PlatformFeeUpdated(uint256 newFeeBps);
    event FeeRecipientUpdated(address indexed newRecipient);

    error ZeroAddress();
    error ZeroQuantity();
    error ZeroPrice();
    error EmptyString();
    error OnlyVerifiedFarmer();
    error OnlyVerifiedBuyer();
    error Unauthorized();
    error BatchNotFound();
    error BatchInactive();
    error InsufficientQuantity();
    error InvalidOrderStatus();
    error FeeTooHigh();
    error AutoReleaseNotReady();
    error InvalidRefundPercent();

    /**
     * @param _paymentToken ERC20 stablecoin used for payments.
     * @param _userRegistry UserRegistry contract checking verification status.
     * @param _admin Admin address.
     * @param _feeRecipient Recipient address for platform fees.
     * @param _initialFeeBps Initial platform fee in basis points (e.g. 200 = 2%).
     */
    constructor(
        address _paymentToken,
        address _userRegistry,
        address _admin,
        address _feeRecipient,
        uint256 _initialFeeBps
    ) {
        if (
            _paymentToken == address(0) ||
            _userRegistry == address(0) ||
            _admin == address(0) ||
            _feeRecipient == address(0)
        ) revert ZeroAddress();
        if (_initialFeeBps > MAX_PLATFORM_FEE_BPS) revert FeeTooHigh();

        paymentToken = IERC20(_paymentToken);
        userRegistry = UserRegistry(_userRegistry);
        feeRecipient = _feeRecipient;
        platformFeeBps = _initialFeeBps;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(ADMIN_ROLE, _admin);
    }

    /**
     * @notice Verified farmer lists a new crop batch.
     */
    function listBatch(
        string calldata cropType,
        uint256 quantity,
        uint256 pricePerUnit,
        uint256 harvestDate,
        string calldata originLocation,
        string calldata metadataHash
    ) external returns (uint256 batchId) {
        if (!userRegistry.isVerifiedFarmer(msg.sender)) revert OnlyVerifiedFarmer();
        if (quantity == 0) revert ZeroQuantity();
        if (pricePerUnit == 0) revert ZeroPrice();
        if (bytes(cropType).length == 0 || bytes(originLocation).length == 0 || bytes(metadataHash).length == 0) {
            revert EmptyString();
        }

        batchId = nextBatchId++;
        batches[batchId] = Batch({
            batchId: batchId,
            farmer: msg.sender,
            cropType: cropType,
            totalQuantity: quantity,
            availableQuantity: quantity,
            pricePerUnit: pricePerUnit,
            harvestDate: harvestDate,
            originLocation: originLocation,
            metadataHash: metadataHash,
            isActive: true
        });

        emit BatchListed(batchId, msg.sender, cropType, quantity, pricePerUnit);
    }

    /**
     * @notice Verified buyer places an order locking tokens in escrow.
     */
    function createOrder(uint256 batchId, uint256 quantity) external nonReentrant returns (uint256 orderId) {
        if (!userRegistry.isVerifiedBuyer(msg.sender)) revert OnlyVerifiedBuyer();
        if (quantity == 0) revert ZeroQuantity();

        Batch storage batch = batches[batchId];
        if (batch.batchId == 0) revert BatchNotFound();
        if (!batch.isActive) revert BatchInactive();
        if (batch.availableQuantity < quantity) revert InsufficientQuantity();

        batch.availableQuantity -= quantity;
        uint256 totalPrice = quantity * batch.pricePerUnit;

        orderId = nextOrderId++;
        orders[orderId] = Order({
            orderId: orderId,
            batchId: batchId,
            buyer: msg.sender,
            farmer: batch.farmer,
            transporter: address(0),
            quantity: quantity,
            totalPrice: totalPrice,
            status: OrderStatus.Placed,
            createdAt: block.timestamp,
            shippedAt: 0,
            disputeEvidenceHash: ""
        });

        paymentToken.safeTransferFrom(msg.sender, address(this), totalPrice);

        emit OrderPlaced(orderId, batchId, msg.sender, batch.farmer, quantity, totalPrice);
    }

    /**
     * @notice Convenience alias for createOrder.
     */
    function order(uint256 batchId, uint256 quantity) external returns (uint256) {
        return this.createOrder(batchId, quantity);
    }

    /**
     * @notice Buyer cancels order before shipment for a full escrow refund.
     */
    function cancelOrder(uint256 orderId) external nonReentrant {
        Order storage ord = orders[orderId];
        if (ord.orderId == 0) revert InvalidOrderStatus();
        if (msg.sender != ord.buyer) revert Unauthorized();
        if (ord.status != OrderStatus.Placed) revert InvalidOrderStatus();

        ord.status = OrderStatus.Cancelled;
        batches[ord.batchId].availableQuantity += ord.quantity;

        emit OrderCancelled(orderId);

        paymentToken.safeTransfer(ord.buyer, ord.totalPrice);
    }

    /**
     * @notice Farmer marks order as Shipped.
     */
    function shipOrder(uint256 orderId) external {
        _ship(orderId, address(0));
    }

    /**
     * @notice Farmer marks order as Shipped and assigns a designated transporter.
     */
    function shipOrderWithTransporter(uint256 orderId, address transporter) external {
        _ship(orderId, transporter);
    }

    function _ship(uint256 orderId, address transporter) internal {
        Order storage ord = orders[orderId];
        if (ord.orderId == 0) revert InvalidOrderStatus();
        if (msg.sender != ord.farmer) revert Unauthorized();
        if (ord.status != OrderStatus.Placed) revert InvalidOrderStatus();

        ord.status = OrderStatus.Shipped;
        ord.shippedAt = block.timestamp;
        ord.transporter = transporter;

        emit OrderShipped(orderId, transporter);
    }

    /**
     * @notice Marks order delivered. Can be called after shipment.
     */
    function deliverOrder(uint256 orderId) external {
        Order storage ord = orders[orderId];
        if (ord.orderId == 0) revert InvalidOrderStatus();
        if (ord.status != OrderStatus.Shipped) revert InvalidOrderStatus();
        if (msg.sender != ord.buyer && msg.sender != ord.farmer && msg.sender != ord.transporter) {
            revert Unauthorized();
        }

        ord.status = OrderStatus.Delivered;
        emit OrderDelivered(orderId);
    }

    /**
     * @notice Buyer confirms delivery. Releases funds to farmer minus platform fee.
     */
    function confirmDelivery(uint256 orderId) external nonReentrant {
        Order storage ord = orders[orderId];
        if (ord.orderId == 0) revert InvalidOrderStatus();
        if (msg.sender != ord.buyer) revert Unauthorized();
        if (ord.status != OrderStatus.Shipped && ord.status != OrderStatus.Delivered) {
            revert InvalidOrderStatus();
        }

        if (ord.status == OrderStatus.Shipped) {
            ord.status = OrderStatus.Delivered;
            emit OrderDelivered(orderId);
        }

        ord.status = OrderStatus.Completed;
        emit OrderCompleted(orderId);

        _payoutFarmer(ord);
    }

    /**
     * @notice Convenience alias for confirmDelivery.
     */
    function deliver(uint256 orderId) external {
        this.confirmDelivery(orderId);
    }

    /**
     * @notice Farmer claims escrow funds if buyer fails to confirm within 7 days after shipment.
     */
    function claimAutoRelease(uint256 orderId) external nonReentrant {
        Order storage ord = orders[orderId];
        if (ord.orderId == 0) revert InvalidOrderStatus();
        if (msg.sender != ord.farmer) revert Unauthorized();
        if (ord.status != OrderStatus.Shipped && ord.status != OrderStatus.Delivered) {
            revert InvalidOrderStatus();
        }
        if (block.timestamp < ord.shippedAt + AUTO_RELEASE_PERIOD) {
            revert AutoReleaseNotReady();
        }

        ord.status = OrderStatus.Completed;

        uint256 fee = (ord.totalPrice * platformFeeBps) / 10000;
        uint256 farmerAmount = ord.totalPrice - fee;

        emit AutoReleased(orderId, farmerAmount, fee);
        emit OrderCompleted(orderId);

        if (fee > 0) {
            paymentToken.safeTransfer(feeRecipient, fee);
        }
        paymentToken.safeTransfer(ord.farmer, farmerAmount);
    }

    /**
     * @notice Buyer raises a dispute after shipment with an evidence hash.
     */
    function raiseDispute(uint256 orderId, string calldata evidenceHash) external {
        Order storage ord = orders[orderId];
        if (ord.orderId == 0) revert InvalidOrderStatus();
        if (msg.sender != ord.buyer) revert Unauthorized();
        if (ord.status != OrderStatus.Shipped && ord.status != OrderStatus.Delivered) {
            revert InvalidOrderStatus();
        }
        if (bytes(evidenceHash).length == 0) revert EmptyString();

        ord.status = OrderStatus.Disputed;
        ord.disputeEvidenceHash = evidenceHash;

        emit DisputeRaised(orderId, msg.sender, evidenceHash);
    }

    /**
     * @notice Arbiter resolves dispute with a buyer refund percentage (0-100).
     */
    function resolveDispute(uint256 orderId, uint256 buyerRefundPercent) external onlyRole(ARBITER_ROLE) nonReentrant {
        if (buyerRefundPercent > 100) revert InvalidRefundPercent();

        Order storage ord = orders[orderId];
        if (ord.orderId == 0) revert InvalidOrderStatus();
        if (ord.status != OrderStatus.Disputed) revert InvalidOrderStatus();

        ord.status = OrderStatus.Resolved;

        uint256 buyerAmount = (ord.totalPrice * buyerRefundPercent) / 100;
        uint256 farmerAmount = ord.totalPrice - buyerAmount;

        emit DisputeResolved(orderId, buyerRefundPercent, buyerAmount, farmerAmount);

        if (buyerAmount > 0) {
            paymentToken.safeTransfer(ord.buyer, buyerAmount);
        }
        if (farmerAmount > 0) {
            paymentToken.safeTransfer(ord.farmer, farmerAmount);
        }
    }

    function _payoutFarmer(Order storage ord) internal {
        uint256 fee = (ord.totalPrice * platformFeeBps) / 10000;
        uint256 farmerAmount = ord.totalPrice - fee;

        if (fee > 0) {
            paymentToken.safeTransfer(feeRecipient, fee);
        }
        paymentToken.safeTransfer(ord.farmer, farmerAmount);
    }

    /**
     * @notice Admin updates the platform fee (max 5%).
     */
    function setPlatformFee(uint256 newFeeBps) external onlyRole(ADMIN_ROLE) {
        if (newFeeBps > MAX_PLATFORM_FEE_BPS) revert FeeTooHigh();
        platformFeeBps = newFeeBps;
        emit PlatformFeeUpdated(newFeeBps);
    }

    /**
     * @notice Admin updates fee recipient.
     */
    function setFeeRecipient(address newRecipient) external onlyRole(ADMIN_ROLE) {
        if (newRecipient == address(0)) revert ZeroAddress();
        feeRecipient = newRecipient;
        emit FeeRecipientUpdated(newRecipient);
    }

    /**
     * @notice Assigns or updates the transporter on an order if caller is farmer.
     */
    function assignTransporter(uint256 orderId, address transporter) external {
        Order storage ord = orders[orderId];
        if (ord.orderId == 0) revert InvalidOrderStatus();
        if (msg.sender != ord.farmer) revert Unauthorized();
        if (transporter == address(0)) revert ZeroAddress();
        ord.transporter = transporter;
    }

    /**
     * @notice View batch details.
     */
    function getBatch(uint256 batchId) external view returns (Batch memory) {
        return batches[batchId];
    }

    /**
     * @notice View order details.
     */
    function getOrder(uint256 orderId) external view returns (Order memory) {
        return orders[orderId];
    }
}

