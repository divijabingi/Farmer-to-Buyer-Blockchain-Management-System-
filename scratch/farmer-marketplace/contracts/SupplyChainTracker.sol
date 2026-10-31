// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./UserRegistry.sol";
import "./Marketplace.sol";

/**
 * @title SupplyChainTracker
 * @notice Logs and retrieves checkpoint telemetry for agricultural produce orders during transit.
 */
contract SupplyChainTracker {
    UserRegistry public immutable userRegistry;
    Marketplace public immutable marketplace;

    struct Checkpoint {
        string location;
        int256 temperature;
        string noteHash;
        uint256 timestamp;
        address loggedBy;
    }

    mapping(uint256 => Checkpoint[]) private orderCheckpoints;
    mapping(uint256 => address) public designatedTransporter;

    event CheckpointLogged(
        uint256 indexed orderId,
        address indexed transporter,
        string location,
        int256 temperature,
        string noteHash,
        uint256 timestamp
    );

    error ZeroAddress();
    error EmptyString();
    error OnlyVerifiedTransporter();
    error Unauthorized();
    error OrderNotFound();

    /**
     * @param _userRegistry UserRegistry address.
     * @param _marketplace Marketplace address.
     */
    constructor(address _userRegistry, address _marketplace) {
        if (_userRegistry == address(0) || _marketplace == address(0)) revert ZeroAddress();
        userRegistry = UserRegistry(_userRegistry);
        marketplace = Marketplace(_marketplace);
    }

    /**
     * @notice Verified transporter logs a location and temperature checkpoint for an order.
     */
    function logCheckpoint(
        uint256 orderId,
        string calldata location,
        int256 temperature,
        string calldata noteHash
    ) external {
        if (!userRegistry.isVerifiedTransporter(msg.sender)) revert OnlyVerifiedTransporter();
        if (bytes(location).length == 0 || bytes(noteHash).length == 0) revert EmptyString();

        Marketplace.Order memory ord = marketplace.getOrder(orderId);
        if (ord.orderId == 0) revert OrderNotFound();

        // Enforce authorized transporter for this order
        if (ord.transporter != address(0)) {
            if (ord.transporter != msg.sender) revert Unauthorized();
        } else if (designatedTransporter[orderId] != address(0)) {
            if (designatedTransporter[orderId] != msg.sender) revert Unauthorized();
        } else {
            designatedTransporter[orderId] = msg.sender;
        }

        orderCheckpoints[orderId].push(
            Checkpoint({
                location: location,
                temperature: temperature,
                noteHash: noteHash,
                timestamp: block.timestamp,
                loggedBy: msg.sender
            })
        );

        emit CheckpointLogged(orderId, msg.sender, location, temperature, noteHash, block.timestamp);
    }

    /**
     * @notice Returns the full checkpoint history of an order.
     * @dev Restricted to farmer, buyer, or transporter of that order.
     */
    function getCheckpoints(uint256 orderId) external view returns (Checkpoint[] memory) {
        Marketplace.Order memory ord = marketplace.getOrder(orderId);
        if (ord.orderId == 0) revert OrderNotFound();

        bool isAuthorized = (msg.sender == ord.buyer) ||
            (msg.sender == ord.farmer) ||
            (msg.sender == ord.transporter) ||
            (msg.sender == designatedTransporter[orderId]);

        if (!isAuthorized) revert Unauthorized();

        return orderCheckpoints[orderId];
    }

    /**
     * @notice Returns total number of checkpoints for an order.
     */
    function getCheckpointCount(uint256 orderId) external view returns (uint256) {
        Marketplace.Order memory ord = marketplace.getOrder(orderId);
        if (ord.orderId == 0) revert OrderNotFound();

        bool isAuthorized = (msg.sender == ord.buyer) ||
            (msg.sender == ord.farmer) ||
            (msg.sender == ord.transporter) ||
            (msg.sender == designatedTransporter[orderId]);

        if (!isAuthorized) revert Unauthorized();

        return orderCheckpoints[orderId].length;
    }
}

