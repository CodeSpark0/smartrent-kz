const assert = require("node:assert/strict");
const { ethers, network } = require("hardhat");

async function main() {
  assert.equal(network.name, "hardhat");
  const [owner1, owner2, owner3, tenant, landlord, inspector] = await ethers.getSigners();
  console.log("SmartRent KZ | LOCAL SIMULATION | no real funds or personal data");

  const wallet = await ethers.deployContract("LocalAdminMultisig", [
    [owner1.address, owner2.address, owner3.address]
  ]);
  await wallet.waitForDeployment();
  console.log("1. Deployed local 2-of-3 admin:", await wallet.getAddress());
  const escrow = await ethers.deployContract("RentEscrow", [await wallet.getAddress()]);
  await escrow.waitForDeployment();
  const escrowAddress = await escrow.getAddress();
  console.log("2. Deployed RentEscrow:", escrowAddress);

  const role = ethers.id("INSPECTOR_ROLE"); // Role IDs use Keccak-256, not report hashing.
  const data = escrow.interface.encodeFunctionData("grantRole", [role, inspector.address]);
  await (await wallet.submit(escrowAddress, data)).wait();
  await (await wallet.confirm(0)).wait();
  assert.equal(await escrow.hasRole(role, inspector.address), false);
  console.log("3. First owner approved; inspector role is still absent.");
  await (await wallet.connect(owner2).confirm(0)).wait();
  await (await wallet.execute(0)).wait();
  console.log("4. Second owner approved; executed inspector-role grant.");

  // Entirely invented off-chain report bytes. Only their SHA-256 digests are submitted.
  const moveInHash = ethers.sha256(ethers.toUtf8Bytes("synthetic-report:move-in:v1"));
  const moveOutHash = ethers.sha256(ethers.toUtf8Bytes("synthetic-report:move-out:v1"));
  const deposit = ethers.parseEther("1");
  const leaseId = await escrow.nextLeaseId();
  const tenantBefore = await ethers.provider.getBalance(tenant.address);
  const landlordBefore = await ethers.provider.getBalance(landlord.address);
  await (await escrow.connect(tenant).createLease(
    landlord.address, inspector.address, moveInHash, 86400, { value: deposit }
  )).wait();
  console.log("5. Lease", leaseId.toString(), "locked 1 simulated ETH = 100,000 synthetic KZT.");
  console.log("   Fictional display mapping only; no exchange rate, token or KZT transfer.");
  console.log("   moveInHash:", moveInHash);
  console.log("   Escrow balance:", ethers.formatEther(await ethers.provider.getBalance(escrowAddress)));

  await (await escrow.connect(landlord).confirmMoveOut(leaseId, moveOutHash)).wait();
  console.log("6. Landlord confirmed no damage; deposit remains locked.");
  await (await escrow.connect(inspector).confirmMoveOut(leaseId, moveOutHash)).wait();
  console.log("7. Assigned inspector confirmed the identical move-out hash.");

  const beforeRelease = await ethers.provider.getBalance(tenant.address);
  const receipt = await (await escrow.connect(tenant).releaseDeposit(leaseId)).wait();
  const tenantAfter = await ethers.provider.getBalance(tenant.address);
  assert.equal(tenantAfter + receipt.fee - beforeRelease, deposit);
  assert.equal(await escrow.totalLocked(), 0n);
  assert.equal(await ethers.provider.getBalance(escrowAddress), 0n);
  console.log("8. Tenant triggered automatic full-deposit settlement: 1 simulated ETH.");
  console.log("   Refund increase after adding back transaction gas: 1.0 simulated ETH.");
  console.log("9. Final balances (simulated ETH; transaction senders pay simulated gas):");
  console.log("   Tenant before lease:", ethers.formatEther(tenantBefore));
  console.log("   Tenant after refund:", ethers.formatEther(tenantAfter));
  console.log("   Landlord before:", ethers.formatEther(landlordBefore));
  console.log("   Landlord after:", ethers.formatEther(await ethers.provider.getBalance(landlord.address)));
  console.log("   Escrow:", ethers.formatEther(await ethers.provider.getBalance(escrowAddress)));
  console.log("Next, record: npx hardhat test (six test cases).");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
