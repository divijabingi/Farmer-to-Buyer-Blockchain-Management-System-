const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  console.log("==================================================");
  console.log("   Deploying Farmer-to-Buyer Marketplace System   ");
  console.log("==================================================");

  const [deployer, feeRecipient, arbiter] = await ethers.getSigners();
  console.log(`Deployer address:      ${deployer.address}`);
  console.log(`Fee Recipient address: ${feeRecipient.address}`);
  console.log(`Arbiter address:       ${arbiter.address}`);

  // 1. Deploy UserRegistry
  console.log("\n[1/4] Deploying UserRegistry...");
  const UserRegistryFactory = await ethers.getContractFactory("UserRegistry");
  const userRegistry = await UserRegistryFactory.deploy(deployer.address);
  await userRegistry.waitForDeployment();
  const userRegistryAddress = await userRegistry.getAddress();
  console.log(`✓ UserRegistry deployed to: ${userRegistryAddress}`);

  // 2. Deploy MockStablecoin
  console.log("\n[2/4] Deploying MockStablecoin (mUSD, 6 decimals)...");
  const TokenFactory = await ethers.getContractFactory("MockStablecoin");
  const token = await TokenFactory.deploy();
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();
  console.log(`✓ MockStablecoin deployed to: ${tokenAddress}`);

  // 3. Deploy Marketplace (200 bps = 2% platform fee)
  const PLATFORM_FEE_BPS = 200;
  console.log(`\n[3/4] Deploying Marketplace (Fee: ${PLATFORM_FEE_BPS / 100}%)...`);
  const MarketplaceFactory = await ethers.getContractFactory("Marketplace");
  const marketplace = await MarketplaceFactory.deploy(
    tokenAddress,
    userRegistryAddress,
    deployer.address,
    feeRecipient.address,
    PLATFORM_FEE_BPS
  );
  await marketplace.waitForDeployment();
  const marketplaceAddress = await marketplace.getAddress();
  console.log(`✓ Marketplace deployed to: ${marketplaceAddress}`);

  // Grant ARBITER_ROLE to arbiter address
  console.log("\nConfiguring roles...");
  const ARBITER_ROLE = await marketplace.ARBITER_ROLE();
  const grantTx = await marketplace.grantRole(ARBITER_ROLE, arbiter.address);
  await grantTx.wait();
  console.log(`✓ Granted ARBITER_ROLE to ${arbiter.address}`);

  // 4. Deploy SupplyChainTracker
  console.log("\n[4/4] Deploying SupplyChainTracker...");
  const TrackerFactory = await ethers.getContractFactory("SupplyChainTracker");
  const tracker = await TrackerFactory.deploy(
    userRegistryAddress,
    marketplaceAddress
  );
  await tracker.waitForDeployment();
  const trackerAddress = await tracker.getAddress();
  console.log(`✓ SupplyChainTracker deployed to: ${trackerAddress}`);

  // Save deployment artifact
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  const deploymentData = {
    network: "localhost",
    chainId: 31337,
    timestamp: new Date().toISOString(),
    contracts: {
      UserRegistry: userRegistryAddress,
      MockStablecoin: tokenAddress,
      Marketplace: marketplaceAddress,
      SupplyChainTracker: trackerAddress,
    },
    roles: {
      admin: deployer.address,
      feeRecipient: feeRecipient.address,
      arbiter: arbiter.address,
    },
    config: {
      platformFeeBps: PLATFORM_FEE_BPS,
      autoReleasePeriodDays: 7,
    },
  };

  const outputPath = path.join(deploymentsDir, "localhost.json");
  fs.writeFileSync(outputPath, JSON.stringify(deploymentData, null, 2));
  console.log(`\n✓ Deployment data saved to: ${outputPath}`);
  console.log("==================================================");
  console.log("              Deployment Completed!               ");
  console.log("==================================================");
}

main().catch((error) => {
  console.error("Deployment failed:", error);
  process.exitCode = 1;
});

