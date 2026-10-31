const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Farmer-to-Buyer Marketplace & Escrow System", function () {
  let admin, farmer, buyer, transporter, arbiter, feeRecipient, stranger;
  let userRegistry, token, marketplace, tracker;

  const PRICE_PER_UNIT = ethers.parseUnits("10", 6); // 10 mUSD per unit
  const INITIAL_QUANTITY = 100n;
  const PLATFORM_FEE_BPS = 200n; // 2%
  const SEVEN_DAYS = 7 * 24 * 60 * 60;

  beforeEach(async function () {
    [admin, farmer, buyer, transporter, arbiter, feeRecipient, stranger] =
      await ethers.getSigners();

    // 1. Deploy UserRegistry
    const UserRegistryFactory = await ethers.getContractFactory("UserRegistry");
    userRegistry = await UserRegistryFactory.deploy(admin.address);
    await userRegistry.waitForDeployment();

    // 2. Deploy MockStablecoin
    const TokenFactory = await ethers.getContractFactory("MockStablecoin");
    token = await TokenFactory.deploy();
    await token.waitForDeployment();

    // 3. Deploy Marketplace
    const MarketplaceFactory = await ethers.getContractFactory("Marketplace");
    marketplace = await MarketplaceFactory.deploy(
      await token.getAddress(),
      await userRegistry.getAddress(),
      admin.address,
      feeRecipient.address,
      PLATFORM_FEE_BPS
    );
    await marketplace.waitForDeployment();

    // Grant ARBITER_ROLE to arbiter on Marketplace
    const ARBITER_ROLE = await marketplace.ARBITER_ROLE();
    await marketplace.connect(admin).grantRole(ARBITER_ROLE, arbiter.address);

    // 4. Deploy SupplyChainTracker
    const TrackerFactory = await ethers.getContractFactory("SupplyChainTracker");
    tracker = await TrackerFactory.deploy(
      await userRegistry.getAddress(),
      await marketplace.getAddress()
    );
    await tracker.waitForDeployment();

    // Setup verified roles
    // Farmer = 1, Buyer = 2, Transporter = 3
    await userRegistry.connect(farmer).register(1);
    await userRegistry.connect(admin).verifyUser(farmer.address);

    await userRegistry.connect(buyer).register(2);
    await userRegistry.connect(admin).verifyUser(buyer.address);

    await userRegistry.connect(transporter).register(3);
    await userRegistry.connect(admin).verifyUser(transporter.address);

    // Mint stablecoin to buyer and approve Marketplace
    await token.mint(buyer.address, ethers.parseUnits("50000", 6));
    await token
      .connect(buyer)
      .approve(await marketplace.getAddress(), ethers.MaxUint256);
  });

  // 1. Registration and verification works
  it("1. Registration and verification works", async function () {
    expect(await userRegistry.isVerifiedFarmer(farmer.address)).to.be.true;
    expect(await userRegistry.isVerifiedBuyer(buyer.address)).to.be.true;
    expect(await userRegistry.isVerifiedTransporter(transporter.address)).to.be.true;
    expect(await userRegistry.isVerified(stranger.address)).to.be.false;
  });

  // 2. Only a verified farmer can list a batch
  it("2. Only a verified farmer can list a batch", async function () {
    await expect(
      marketplace
        .connect(stranger)
        .listBatch("Organic Wheat", INITIAL_QUANTITY, PRICE_PER_UNIT, 1750000000, "Fresno, CA", "QmBatchHash123")
    ).to.be.revertedWithCustomError(marketplace, "OnlyVerifiedFarmer");

    await expect(
      marketplace
        .connect(buyer)
        .listBatch("Organic Wheat", INITIAL_QUANTITY, PRICE_PER_UNIT, 1750000000, "Fresno, CA", "QmBatchHash123")
    ).to.be.revertedWithCustomError(marketplace, "OnlyVerifiedFarmer");

    await expect(
      marketplace
        .connect(farmer)
        .listBatch("Organic Wheat", INITIAL_QUANTITY, PRICE_PER_UNIT, 1750000000, "Fresno, CA", "QmBatchHash123")
    )
      .to.emit(marketplace, "BatchListed")
      .withArgs(1, farmer.address, "Organic Wheat", INITIAL_QUANTITY, PRICE_PER_UNIT);

    const batch = await marketplace.getBatch(1);
    expect(batch.farmer).to.equal(farmer.address);
    expect(batch.availableQuantity).to.equal(INITIAL_QUANTITY);
  });

  // 3. Full happy path: list -> order -> ship -> deliver -> farmer paid (check platform fee math)
  it("3. Full happy path: list -> order -> ship -> deliver -> farmer paid (check platform fee math)", async function () {
    // List
    await marketplace
      .connect(farmer)
      .listBatch("Premium Barley", 50, PRICE_PER_UNIT, 1750000000, "Salinas, CA", "QmBarley1");

    // Order 10 units = 100 mUSD
    const orderQty = 10n;
    const expectedTotalPrice = orderQty * PRICE_PER_UNIT; // 100 * 10^6
    await expect(marketplace.connect(buyer).createOrder(1, orderQty))
      .to.emit(marketplace, "OrderPlaced")
      .withArgs(1, 1, buyer.address, farmer.address, orderQty, expectedTotalPrice);

    // Escrow balance check
    expect(await token.balanceOf(await marketplace.getAddress())).to.equal(expectedTotalPrice);

    // Ship
    await expect(marketplace.connect(farmer).shipOrder(1))
      .to.emit(marketplace, "OrderShipped")
      .withArgs(1, ethers.ZeroAddress);

    // Deliver (Buyer confirms delivery)
    const farmerBalBefore = await token.balanceOf(farmer.address);
    const feeRecipientBalBefore = await token.balanceOf(feeRecipient.address);

    const expectedFee = (expectedTotalPrice * PLATFORM_FEE_BPS) / 10000n; // 2 mUSD
    const expectedFarmerPayout = expectedTotalPrice - expectedFee; // 98 mUSD

    await expect(marketplace.connect(buyer).confirmDelivery(1))
      .to.emit(marketplace, "OrderDelivered")
      .withArgs(1)
      .and.to.emit(marketplace, "OrderCompleted")
      .withArgs(1);

    const farmerBalAfter = await token.balanceOf(farmer.address);
    const feeRecipientBalAfter = await token.balanceOf(feeRecipient.address);

    expect(farmerBalAfter - farmerBalBefore).to.equal(expectedFarmerPayout);
    expect(feeRecipientBalAfter - feeRecipientBalBefore).to.equal(expectedFee);

    const ord = await marketplace.getOrder(1);
    expect(ord.status).to.equal(3); // Completed
  });

  // 4. Unverified buyer can't order
  it("4. Unverified buyer can't order", async function () {
    await marketplace
      .connect(farmer)
      .listBatch("Organic Corn", 100, PRICE_PER_UNIT, 1750000000, "Iowa", "QmCorn1");

    await expect(
      marketplace.connect(stranger).createOrder(1, 5)
    ).to.be.revertedWithCustomError(marketplace, "OnlyVerifiedBuyer");
  });

  // 5. Can't order more than the available quantity
  it("5. Can't order more than the available quantity", async function () {
    await marketplace
      .connect(farmer)
      .listBatch("Organic Apples", 10, PRICE_PER_UNIT, 1750000000, "Yakima, WA", "QmApples1");

    await expect(
      marketplace.connect(buyer).createOrder(1, 11)
    ).to.be.revertedWithCustomError(marketplace, "InsufficientQuantity");
  });

  // 6. Can't skip states (e.g. deliver before ship)
  it("6. Can't skip states (e.g. deliver before ship)", async function () {
    await marketplace
      .connect(farmer)
      .listBatch("Sweet Oranges", 50, PRICE_PER_UNIT, 1750000000, "Orlando, FL", "QmOranges1");

    await marketplace.connect(buyer).createOrder(1, 5);

    // Order is currently in 'Placed' state, attempting delivery before ship must fail
    await expect(
      marketplace.connect(buyer).confirmDelivery(1)
    ).to.be.revertedWithCustomError(marketplace, "InvalidOrderStatus");
  });

  // 7. Buyer cancels before shipment -> full refund
  it("7. Buyer cancels before shipment -> full refund", async function () {
    await marketplace
      .connect(farmer)
      .listBatch("Organic Soybeans", 50, PRICE_PER_UNIT, 1750000000, "Illinois", "QmSoy1");

    const orderQty = 10n;
    const cost = orderQty * PRICE_PER_UNIT;

    await marketplace.connect(buyer).createOrder(1, orderQty);

    let batch = await marketplace.getBatch(1);
    expect(batch.availableQuantity).to.equal(40n);

    const buyerBalBefore = await token.balanceOf(buyer.address);

    await expect(marketplace.connect(buyer).cancelOrder(1))
      .to.emit(marketplace, "OrderCancelled")
      .withArgs(1);

    const buyerBalAfter = await token.balanceOf(buyer.address);
    expect(buyerBalAfter - buyerBalBefore).to.equal(cost);

    batch = await marketplace.getBatch(1);
    expect(batch.availableQuantity).to.equal(50n); // Restored available quantity

    const ord = await marketplace.getOrder(1);
    expect(ord.status).to.equal(4); // Cancelled
  });

  // 8. Can't cancel after shipment
  it("8. Can't cancel after shipment", async function () {
    await marketplace
      .connect(farmer)
      .listBatch("Rice", 50, PRICE_PER_UNIT, 1750000000, "Sacramento, CA", "QmRice1");

    await marketplace.connect(buyer).createOrder(1, 10);
    await marketplace.connect(farmer).shipOrder(1);

    await expect(
      marketplace.connect(buyer).cancelOrder(1)
    ).to.be.revertedWithCustomError(marketplace, "InvalidOrderStatus");
  });

  // 9. Auto-release after 7 days (use hardhat time helpers)
  it("9. Auto-release after 7 days (use hardhat time helpers)", async function () {
    await marketplace
      .connect(farmer)
      .listBatch("Tomatoes", 50, PRICE_PER_UNIT, 1750000000, "Naples, FL", "QmTomatoes1");

    const orderQty = 10n;
    const totalPrice = orderQty * PRICE_PER_UNIT;
    await marketplace.connect(buyer).createOrder(1, orderQty);
    await marketplace.connect(farmer).shipOrder(1);

    // Auto-release should fail immediately
    await expect(
      marketplace.connect(farmer).claimAutoRelease(1)
    ).to.be.revertedWithCustomError(marketplace, "AutoReleaseNotReady");

    // Fast-forward 7 days + 10 seconds
    await time.increase(SEVEN_DAYS + 10);

    const farmerBalBefore = await token.balanceOf(farmer.address);
    const fee = (totalPrice * PLATFORM_FEE_BPS) / 10000n;
    const expectedPayout = totalPrice - fee;

    await expect(marketplace.connect(farmer).claimAutoRelease(1))
      .to.emit(marketplace, "AutoReleased")
      .withArgs(1, expectedPayout, fee)
      .and.to.emit(marketplace, "OrderCompleted")
      .withArgs(1);

    const farmerBalAfter = await token.balanceOf(farmer.address);
    expect(farmerBalAfter - farmerBalBefore).to.equal(expectedPayout);

    const ord = await marketplace.getOrder(1);
    expect(ord.status).to.equal(3); // Completed
  });

  // 10. Dispute -> arbiter split resolution pays both sides correctly
  it("10. Dispute -> arbiter split resolution pays both sides correctly", async function () {
    await marketplace
      .connect(farmer)
      .listBatch("Almonds", 50, PRICE_PER_UNIT, 1750000000, "Modesto, CA", "QmAlmonds1");

    const orderQty = 10n;
    const totalPrice = orderQty * PRICE_PER_UNIT; // 100 mUSD
    await marketplace.connect(buyer).createOrder(1, orderQty);
    await marketplace.connect(farmer).shipOrder(1);

    // Buyer raises dispute with evidence hash
    await expect(
      marketplace
        .connect(buyer)
        .raiseDispute(1, "QmDisputeEvidenceSpoiledTransit456")
    )
      .to.emit(marketplace, "DisputeRaised")
      .withArgs(1, buyer.address, "QmDisputeEvidenceSpoiledTransit456");

    let ord = await marketplace.getOrder(1);
    expect(ord.status).to.equal(5); // Disputed

    // Arbiter splits 40% refund to buyer, 60% to farmer
    const buyerRefundPercent = 40n;
    const expectedBuyerRefund = (totalPrice * buyerRefundPercent) / 100n; // 40 mUSD
    const expectedFarmerPayout = totalPrice - expectedBuyerRefund; // 60 mUSD

    const buyerBalBefore = await token.balanceOf(buyer.address);
    const farmerBalBefore = await token.balanceOf(farmer.address);

    await expect(
      marketplace.connect(arbiter).resolveDispute(1, buyerRefundPercent)
    )
      .to.emit(marketplace, "DisputeResolved")
      .withArgs(1, buyerRefundPercent, expectedBuyerRefund, expectedFarmerPayout);

    const buyerBalAfter = await token.balanceOf(buyer.address);
    const farmerBalAfter = await token.balanceOf(farmer.address);

    expect(buyerBalAfter - buyerBalBefore).to.equal(expectedBuyerRefund);
    expect(farmerBalAfter - farmerBalBefore).to.equal(expectedFarmerPayout);

    ord = await marketplace.getOrder(1);
    expect(ord.status).to.equal(6); // Resolved
  });

  // 11. Tracker records checkpoints and returns the history
  it("11. Tracker records checkpoints and returns the history", async function () {
    await marketplace
      .connect(farmer)
      .listBatch("Strawberries", 50, PRICE_PER_UNIT, 1750000000, "Watsonville, CA", "QmBerries1");

    await marketplace.connect(buyer).createOrder(1, 10);
    // Ship and designate transporter
    await marketplace
      .connect(farmer)
      .shipOrderWithTransporter(1, transporter.address);

    // Transporter logs checkpoint 1
    await expect(
      tracker
        .connect(transporter)
        .logCheckpoint(1, "Cold Storage Hub A", 4, "QmCheckpointTelemetry1")
    )
      .to.emit(tracker, "CheckpointLogged");

    // Transporter logs checkpoint 2
    await expect(
      tracker
        .connect(transporter)
        .logCheckpoint(1, "Distribution Center B", 5, "QmCheckpointTelemetry2")
    )
      .to.emit(tracker, "CheckpointLogged");

    // Buyer and farmer can retrieve history
    const buyerView = await tracker.connect(buyer).getCheckpoints(1);
    expect(buyerView.length).to.equal(2);
    expect(buyerView[0].location).to.equal("Cold Storage Hub A");
    expect(buyerView[0].temperature).to.equal(4n);
    expect(buyerView[1].location).to.equal("Distribution Center B");
    expect(buyerView[1].temperature).to.equal(5n);

    // Stranger cannot read or write checkpoints
    await expect(
      tracker.connect(stranger).getCheckpoints(1)
    ).to.be.revertedWithCustomError(tracker, "Unauthorized");

    await expect(
      tracker
        .connect(stranger)
        .logCheckpoint(1, "Unauthorized Point", 10, "QmFake")
    ).to.be.revertedWithCustomError(tracker, "OnlyVerifiedTransporter");
  });

  // 12. Double confirm / double withdrawal fails
  it("12. Double confirm / double withdrawal fails", async function () {
    // Case A: Double Confirm
    await marketplace
      .connect(farmer)
      .listBatch("Carrots", 50, PRICE_PER_UNIT, 1750000000, "Bakersfield, CA", "QmCarrots1");

    await marketplace.connect(buyer).createOrder(1, 10);
    await marketplace.connect(farmer).shipOrder(1);

    // First confirm succeeds
    await marketplace.connect(buyer).confirmDelivery(1);

    // Second confirm fails
    await expect(
      marketplace.connect(buyer).confirmDelivery(1)
    ).to.be.revertedWithCustomError(marketplace, "InvalidOrderStatus");

    // Case B: Double Withdrawal (Auto-release claimed twice)
    await marketplace
      .connect(farmer)
      .listBatch("Potatoes", 50, PRICE_PER_UNIT, 1750000000, "Idaho Falls, ID", "QmPotatoes1");

    await marketplace.connect(buyer).createOrder(2, 10);
    await marketplace.connect(farmer).shipOrder(2);

    await time.increase(SEVEN_DAYS + 10);

    // First auto-release claim succeeds
    await marketplace.connect(farmer).claimAutoRelease(2);

    // Second auto-release claim fails
    await expect(
      marketplace.connect(farmer).claimAutoRelease(2)
    ).to.be.revertedWithCustomError(marketplace, "InvalidOrderStatus");
  });
});

