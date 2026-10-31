const { ethers } = require("hardhat");

function formatStatus(statusNum) {
  const statuses = [
    "Placed",
    "Shipped",
    "Delivered",
    "Completed",
    "Cancelled",
    "Disputed",
    "Resolved",
  ];
  return statuses[statusNum] || `Unknown (${statusNum})`;
}

function formatUSD(amount) {
  return `${ethers.formatUnits(amount, 6)} mUSD`;
}

async function main() {
  console.log("================================================================================");
  console.log("             FARMER-TO-BUYER MARKETPLACE & ESCROW LIFECYCLE DEMO                ");
  console.log("================================================================================\n");

  const [admin, farmer, buyer, transporter, arbiter, feeRecipient] =
    await ethers.getSigners();

  console.log("PARTICIPANTS & ROLES:");
  console.log(`• Admin:         ${admin.address}`);
  console.log(`• Farmer:        ${farmer.address}`);
  console.log(`• Buyer:         ${buyer.address}`);
  console.log(`• Transporter:   ${transporter.address}`);
  console.log(`• Arbiter:       ${arbiter.address}`);
  console.log(`• Fee Recipient: ${feeRecipient.address}\n`);

  // --- Step 1: Deploy System Contracts ---
  console.log("--------------------------------------------------------------------------------");
  console.log("STEP 1: CONTRACT DEPLOYMENT & ROLE CONFIGURATION");
  console.log("--------------------------------------------------------------------------------");

  const UserRegistryFactory = await ethers.getContractFactory("UserRegistry");
  const userRegistry = await UserRegistryFactory.deploy(admin.address);
  await userRegistry.waitForDeployment();
  console.log(`[Deploy] UserRegistry:       ${await userRegistry.getAddress()}`);

  const TokenFactory = await ethers.getContractFactory("MockStablecoin");
  const token = await TokenFactory.deploy();
  await token.waitForDeployment();
  console.log(`[Deploy] MockStablecoin:     ${await token.getAddress()}`);

  const PLATFORM_FEE_BPS = 200n; // 2%
  const MarketplaceFactory = await ethers.getContractFactory("Marketplace");
  const marketplace = await MarketplaceFactory.deploy(
    await token.getAddress(),
    await userRegistry.getAddress(),
    admin.address,
    feeRecipient.address,
    PLATFORM_FEE_BPS
  );
  await marketplace.waitForDeployment();
  console.log(`[Deploy] Marketplace:        ${await marketplace.getAddress()} (Fee: 2%)`);

  // Grant Arbiter Role
  const ARBITER_ROLE = await marketplace.ARBITER_ROLE();
  await marketplace.connect(admin).grantRole(ARBITER_ROLE, arbiter.address);
  console.log(`[Config] Granted ARBITER_ROLE to ${arbiter.address}`);

  const TrackerFactory = await ethers.getContractFactory("SupplyChainTracker");
  const tracker = await TrackerFactory.deploy(
    await userRegistry.getAddress(),
    await marketplace.getAddress()
  );
  await tracker.waitForDeployment();
  console.log(`[Deploy] SupplyChainTracker: ${await tracker.getAddress()}\n`);

  // --- Step 2: User Registration & Verification ---
  console.log("--------------------------------------------------------------------------------");
  console.log("STEP 2: USER REGISTRATION & ADMIN VERIFICATION");
  console.log("--------------------------------------------------------------------------------");

  await userRegistry.connect(farmer).register(1); // Farmer
  await userRegistry.connect(admin).verifyUser(farmer.address);
  console.log(`[Register & Verify] Farmer:      ${farmer.address} (Role: FARMER, Verified: true)`);

  await userRegistry.connect(buyer).register(2); // Buyer
  await userRegistry.connect(admin).verifyUser(buyer.address);
  console.log(`[Register & Verify] Buyer:       ${buyer.address} (Role: BUYER, Verified: true)`);

  await userRegistry.connect(transporter).register(3); // Transporter
  await userRegistry.connect(admin).verifyUser(transporter.address);
  console.log(`[Register & Verify] Transporter: ${transporter.address} (Role: TRANSPORTER, Verified: true)\n`);

  // Fund Buyer
  const initialBuyerDeposit = ethers.parseUnits("5000", 6);
  await token.mint(buyer.address, initialBuyerDeposit);
  await token.connect(buyer).approve(await marketplace.getAddress(), ethers.MaxUint256);
  console.log(`[Funding] Minted ${formatUSD(initialBuyerDeposit)} to Buyer wallet and approved Marketplace.\n`);

  // --- Step 3: Happy Path Scenario ---
  console.log("================================================================================");
  console.log("                   SCENARIO 1: FULL HAPPY PATH ORDER FLOW                       ");
  console.log("================================================================================\n");

  // 3a. Farmer Lists Batch
  console.log("--- 3a. Farmer Lists Crop Batch ---");
  const unitPrice = ethers.parseUnits("20", 6); // 20 mUSD per unit
  const batchQty = 100n;
  const listTx = await marketplace
    .connect(farmer)
    .listBatch(
      "Organic Honeycrisp Apples",
      batchQty,
      unitPrice,
      Math.floor(Date.now() / 1000),
      "Yakima Valley, WA (GPS: 46.6021, -120.5059)",
      "QmHoneycrispBatchCertHash_2026_US_GradeA"
    );
  await listTx.wait();
  console.log(`[Farmer Action] Listed Batch #1:`);
  console.log(`  • Crop Type:          Organic Honeycrisp Apples`);
  console.log(`  • Total Quantity:     100 units`);
  console.log(`  • Price per Unit:     ${formatUSD(unitPrice)}`);
  console.log(`  • Origin:             Yakima Valley, WA`);
  console.log(`  • Metadata IPFS Hash: QmHoneycrispBatchCertHash_2026_US_GradeA\n`);

  // 3b. Buyer Places Order
  console.log("--- 3b. Buyer Orders 10 Units & Escrow Locks Funds ---");
  const order1Qty = 10n;
  const order1Cost = order1Qty * unitPrice; // 200 mUSD

  console.log(`Balances BEFORE Order #1:`);
  console.log(`  • Buyer Balance:       ${formatUSD(await token.balanceOf(buyer.address))}`);
  console.log(`  • Escrow (Contract):   ${formatUSD(await token.balanceOf(await marketplace.getAddress()))}`);

  const orderTx = await marketplace.connect(buyer).createOrder(1, order1Qty);
  await orderTx.wait();

  let ord1 = await marketplace.getOrder(1);
  console.log(`[Buyer Action] Placed Order #1:`);
  console.log(`  • Quantity:            10 units`);
  console.log(`  • Total Escrow Locked: ${formatUSD(ord1.totalPrice)}`);
  console.log(`  • Order Status:        ${formatStatus(ord1.status)}`);
  console.log(`Balances AFTER Order #1:`);
  console.log(`  • Buyer Balance:       ${formatUSD(await token.balanceOf(buyer.address))}`);
  console.log(`  • Escrow (Contract):   ${formatUSD(await token.balanceOf(await marketplace.getAddress()))}\n`);

  // 3c. Farmer Ships Order with Transporter
  console.log("--- 3c. Farmer Marks Shipped & Assigns Transporter ---");
  const shipTx = await marketplace
    .connect(farmer)
    .shipOrderWithTransporter(1, transporter.address);
  await shipTx.wait();
  ord1 = await marketplace.getOrder(1);
  console.log(`[Farmer Action] Order #1 Shipped:`);
  console.log(`  • Designated Carrier:  ${transporter.address}`);
  console.log(`  • Order Status:        ${formatStatus(ord1.status)}\n`);

  // 3d. Transporter Logs Checkpoints
  console.log("--- 3d. Transporter Logs Checkpoints on SupplyChainTracker ---");
  const cp1 = await tracker
    .connect(transporter)
    .logCheckpoint(1, "Cold Storage Hub - Seattle, WA", 3, "QmTelemetryColdChainNode1");
  await cp1.wait();
  console.log(`[Transporter Action] Logged Checkpoint 1: Seattle Hub | 3°C | QmTelemetryColdChainNode1`);

  const cp2 = await tracker
    .connect(transporter)
    .logCheckpoint(1, "Regional Distribution Center - Portland, OR", 4, "QmTelemetryColdChainNode2");
  await cp2.wait();
  console.log(`[Transporter Action] Logged Checkpoint 2: Portland Hub | 4°C | QmTelemetryColdChainNode2`);

  const history = await tracker.connect(buyer).getCheckpoints(1);
  console.log(`[Audit] Verified ${history.length} telemetry checkpoints stored immutably on-chain.\n`);

  // 3e. Buyer Confirms Delivery & Funds are Settled
  console.log("--- 3e. Buyer Confirms Delivery (Escrow Settles Funds) ---");
  const farmerBeforePay = await token.balanceOf(farmer.address);
  const feeBeforePay = await token.balanceOf(feeRecipient.address);

  console.log(`Balances BEFORE Delivery Confirmation:`);
  console.log(`  • Farmer Balance:      ${formatUSD(farmerBeforePay)}`);
  console.log(`  • Fee Recipient:       ${formatUSD(feeBeforePay)}`);

  const deliverTx = await marketplace.connect(buyer).confirmDelivery(1);
  await deliverTx.wait();

  const farmerAfterPay = await token.balanceOf(farmer.address);
  const feeAfterPay = await token.balanceOf(feeRecipient.address);
  ord1 = await marketplace.getOrder(1);

  const feeAmount = (order1Cost * PLATFORM_FEE_BPS) / 10000n; // 4 mUSD
  const farmerNet = order1Cost - feeAmount; // 196 mUSD

  console.log(`[Buyer Action] Confirmed Delivery for Order #1:`);
  console.log(`  • Final Order Status:  ${formatStatus(ord1.status)}`);
  console.log(`Balances AFTER Settlement:`);
  console.log(`  • Farmer Received:     +${formatUSD(farmerAfterPay - farmerBeforePay)} (Net: ${formatUSD(farmerNet)})`);
  console.log(`  • Platform Fee (2%):   +${formatUSD(feeAfterPay - feeBeforePay)} (Fee: ${formatUSD(feeAmount)})`);
  console.log(`  • Escrow Balance:      ${formatUSD(await token.balanceOf(await marketplace.getAddress()))}\n`);

  // --- Step 4: Dispute & Resolution Scenario ---
  console.log("================================================================================");
  console.log("                   SCENARIO 2: ORDER DISPUTE & ARBITER SPLIT                    ");
  console.log("================================================================================\n");

  // 4a. Buyer Orders 5 Units (Order #2)
  console.log("--- 4a. Buyer Places Order #2 for 5 Units (100 mUSD) ---");
  await marketplace.connect(buyer).createOrder(1, 5);
  let ord2 = await marketplace.getOrder(2);
  console.log(`[Buyer Action] Order #2 Placed: Total Escrow = ${formatUSD(ord2.totalPrice)}`);

  // 4b. Farmer Ships Order #2
  console.log("--- 4b. Farmer Ships Order #2 ---");
  await marketplace.connect(farmer).shipOrder(2);
  ord2 = await marketplace.getOrder(2);
  console.log(`[Farmer Action] Order #2 Shipped: Status = ${formatStatus(ord2.status)}`);

  // 4c. Buyer Raises Dispute Due to Damaged Goods
  console.log("--- 4c. Goods Arrive Damaged: Buyer Raises Dispute ---");
  const disputeEvidenceHash = "QmPhotoEvidence_SpoiledApples_InspectionReport_0x892a";
  await marketplace.connect(buyer).raiseDispute(2, disputeEvidenceHash);
  ord2 = await marketplace.getOrder(2);
  console.log(`[Buyer Action] Dispute Raised for Order #2:`);
  console.log(`  • Status:              ${formatStatus(ord2.status)}`);
  console.log(`  • Evidence IPFS Hash:  ${disputeEvidenceHash}\n`);

  // 4d. Arbiter Resolves Dispute (60% Refund to Buyer, 40% Payout to Farmer)
  console.log("--- 4d. Arbiter Resolves Dispute (60% Refund to Buyer, 40% to Farmer) ---");
  const buyerBalBeforeDispute = await token.balanceOf(buyer.address);
  const farmerBalBeforeDispute = await token.balanceOf(farmer.address);

  const buyerRefundPercent = 60n; // 60%
  const resolveTx = await marketplace
    .connect(arbiter)
    .resolveDispute(2, buyerRefundPercent);
  await resolveTx.wait();

  const buyerBalAfterDispute = await token.balanceOf(buyer.address);
  const farmerBalAfterDispute = await token.balanceOf(farmer.address);
  ord2 = await marketplace.getOrder(2);

  const expectedBuyerRefund = (ord2.totalPrice * buyerRefundPercent) / 100n; // 60 mUSD
  const expectedFarmerPayout = ord2.totalPrice - expectedBuyerRefund; // 40 mUSD

  console.log(`[Arbiter Action] Dispute Resolved:`);
  console.log(`  • Order #2 Status:     ${formatStatus(ord2.status)}`);
  console.log(`  • Buyer Refund (60%):  +${formatUSD(buyerBalAfterDispute - buyerBalBeforeDispute)} (${formatUSD(expectedBuyerRefund)})`);
  console.log(`  • Farmer Payout (40%): +${formatUSD(farmerBalAfterDispute - farmerBalBeforeDispute)} (${formatUSD(expectedFarmerPayout)})`);
  console.log(`  • Escrow Balance:      ${formatUSD(await token.balanceOf(await marketplace.getAddress()))}\n`);

  console.log("================================================================================");
  console.log("                       DEMO RUN COMPLETED SUCCESSFULLY!                         ");
  console.log("================================================================================");
}

main().catch((error) => {
  console.error("Demo failed:", error);
  process.exitCode = 1;
});

