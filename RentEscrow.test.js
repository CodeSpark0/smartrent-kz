const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const hash = (text) => ethers.sha256(ethers.toUtf8Bytes(text));
const moveInHash = hash("synthetic:move-in:v1");
const moveOutHash = hash("synthetic:move-out:v1");
const reportHash = hash("synthetic:damage:v1");
const deposit = ethers.parseEther("1");
const duration = 3600;

async function adminCall(wallet, owner2, escrow, method, args = []) {
  const id = await wallet.proposalCount();
  await (await wallet.submit(await escrow.getAddress(),
    escrow.interface.encodeFunctionData(method, args))).wait();
  await (await wallet.confirm(id)).wait();
  await (await wallet.connect(owner2).confirm(id)).wait();
  return wallet.execute(id);
}

async function fixture() {
  expect(network.name).to.equal("hardhat");
  const [owner1, owner2, owner3, tenant, landlord, inspector, otherInspector, outsider] =
    await ethers.getSigners();
  const wallet = await ethers.deployContract("LocalAdminMultisig", [
    [owner1.address, owner2.address, owner3.address]
  ]);
  await wallet.waitForDeployment();
  const escrow = await ethers.deployContract("RentEscrow", [await wallet.getAddress()]);
  await escrow.waitForDeployment();
  const role = ethers.id("INSPECTOR_ROLE");
  for (const account of [inspector, otherInspector]) {
    await (await adminCall(wallet, owner2, escrow, "grantRole", [role, account.address])).wait();
  }
  return { wallet, escrow, role, owner1, owner2, owner3, tenant, landlord,
    inspector, otherInspector, outsider };
}

async function create(f, overrides = {}) {
  const id = await f.escrow.nextLeaseId();
  await (await f.escrow.connect(f.tenant).createLease(
    f.landlord.address, f.inspector.address, moveInHash, duration,
    { value: deposit, ...overrides }
  )).wait();
  return id;
}

async function confirm(f, id) {
  await (await f.escrow.connect(f.landlord).confirmMoveOut(id, moveOutHash)).wait();
  await (await f.escrow.connect(f.inspector).confirmMoveOut(id, moveOutHash)).wait();
}

describe("RentEscrow", function () {
  it("1. Deployment and Role Assignment (Admin & Inspector roles)", async function () {
    const f = await loadFixture(fixture);
    const { escrow, wallet, role, owner1, owner2, outsider } = f;
    expect(await escrow.hasRole(ethers.ZeroHash, await wallet.getAddress())).to.equal(true);
    expect(await escrow.hasRole(ethers.ZeroHash, owner1.address)).to.equal(false);
    expect(await escrow.hasRole(role, f.inspector.address)).to.equal(true);
    expect(await escrow.hasRole(role, outsider.address)).to.equal(false);
    const id = await wallet.proposalCount();
    await wallet.submit(await escrow.getAddress(),
      escrow.interface.encodeFunctionData("grantRole", [role, outsider.address]));
    await wallet.confirm(id);
    await expect(wallet.execute(id)).to.be.revertedWithCustomError(wallet, "NotApproved");
    await expect(wallet.confirm(id)).to.be.revertedWithCustomError(wallet, "InvalidProposal");
    await expect(wallet.connect(outsider).confirm(id))
      .to.be.revertedWithCustomError(wallet, "Unauthorized");
    expect(await escrow.hasRole(role, outsider.address)).to.equal(false);
    await wallet.connect(owner2).confirm(id);
    await wallet.execute(id);
    expect(await escrow.hasRole(role, outsider.address)).to.equal(true);
    await expect(wallet.execute(id)).to.be.revertedWithCustomError(wallet, "InvalidProposal");
  });

  it("2. Creating a Lease and Locking Deposit with moveInHash", async function () {
    const f = await loadFixture(fixture);
    const { escrow, tenant, landlord, inspector } = f;
    await expect(escrow.connect(tenant).createLease(
      landlord.address, inspector.address, moveInHash, duration, { value: deposit }
    )).to.emit(escrow, "LeaseCreated");
    const lease = await escrow.leases(1);
    expect(lease.tenant).to.equal(tenant.address);
    expect(lease.landlord).to.equal(landlord.address);
    expect(lease.inspector).to.equal(inspector.address);
    expect(lease.moveInHash).to.equal(moveInHash);
    expect(lease.deposit).to.equal(deposit);
    expect(lease.status).to.equal(1n);
    expect(lease.deadline).to.equal(BigInt(await time.latest()) + BigInt(duration));
    expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(deposit);
    expect(await escrow.totalLocked()).to.equal(deposit);
    for (const [target, agent, digest, seconds, amount] of [
      [landlord.address, inspector.address, moveInHash, duration, 0n],
      [ethers.ZeroAddress, inspector.address, moveInHash, duration, deposit],
      [tenant.address, inspector.address, moveInHash, duration, deposit],
      [landlord.address, tenant.address, moveInHash, duration, deposit],
      [landlord.address, landlord.address, moveInHash, duration, deposit],
      [landlord.address, f.outsider.address, moveInHash, duration, deposit],
      [landlord.address, inspector.address, ethers.ZeroHash, duration, deposit],
      [landlord.address, inspector.address, moveInHash, 0, deposit]
    ]) {
      await expect(escrow.connect(tenant).createLease(target, agent, digest, seconds,
        { value: amount })).to.be.revertedWithCustomError(escrow, "InvalidInput");
    }
  });

  it("3. Happy Path - Move-Out Confirmation and Automatic Deposit Release", async function () {
    const f = await loadFixture(fixture);
    const { escrow, tenant, landlord, inspector } = f;
    const id = await create(f);
    const secondId = await create(f);
    await expect(escrow.connect(tenant).releaseDeposit(id))
      .to.be.revertedWithCustomError(escrow, "NotConfirmed");
    await escrow.connect(landlord).confirmMoveOut(id, moveOutHash);
    await expect(escrow.connect(landlord).confirmMoveOut(id, moveOutHash))
      .to.be.revertedWithCustomError(escrow, "AlreadyConfirmed");
    await expect(escrow.connect(inspector).confirmMoveOut(id, reportHash))
      .to.be.revertedWithCustomError(escrow, "ConfirmationMismatch");
    await expect(escrow.connect(tenant).releaseDeposit(id))
      .to.be.revertedWithCustomError(escrow, "NotConfirmed");
    await escrow.connect(inspector).confirmMoveOut(id, moveOutHash);
    await expect(escrow.connect(tenant).releaseDeposit(id))
      .to.changeEtherBalances([tenant, escrow], [deposit, -deposit]);
    const lease = await escrow.leases(id);
    expect(lease.status).to.equal(3n);
    expect(lease.deposit).to.equal(0n);
    expect(lease.moveOutHash).to.equal(moveOutHash);
    expect(await escrow.totalLocked()).to.equal(deposit);
    expect((await escrow.leases(secondId)).deposit).to.equal(deposit);
    await expect(escrow.connect(tenant).releaseDeposit(id))
      .to.be.revertedWithCustomError(escrow, "WrongStatus");
    await expect(escrow.connect(tenant).refundOnTimeout(id))
      .to.be.revertedWithCustomError(escrow, "WrongStatus");
  });

  it("4. Dispute Resolution and Deposit Split by Inspector", async function () {
    const f = await loadFixture(fixture);
    const { escrow, tenant, landlord, inspector, otherInspector } = f;
    const id = await create(f);
    const tenantShare = ethers.parseEther("0.7");
    const landlordShare = deposit - tenantShare;
    await escrow.connect(landlord).openDispute(id);
    await expect(escrow.connect(tenant).releaseDeposit(id))
      .to.be.revertedWithCustomError(escrow, "WrongStatus");
    await expect(escrow.connect(otherInspector).resolveDispute(id, tenantShare, landlordShare, reportHash))
      .to.be.revertedWithCustomError(escrow, "Unauthorized");
    await expect(escrow.connect(inspector).resolveDispute(id, deposit, 1, reportHash))
      .to.be.revertedWithCustomError(escrow, "InvalidSplit");
    await expect(escrow.connect(inspector).resolveDispute(id, deposit + 1n, 0, reportHash))
      .to.be.revertedWithCustomError(escrow, "InvalidSplit");
    await expect(escrow.connect(inspector).resolveDispute(id, tenantShare, landlordShare, ethers.ZeroHash))
      .to.be.revertedWithCustomError(escrow, "InvalidInput");
    await expect(escrow.connect(inspector).resolveDispute(id, tenantShare, landlordShare, reportHash))
      .to.changeEtherBalances([tenant, landlord, escrow], [tenantShare, landlordShare, -deposit]);
    expect((await escrow.leases(id)).status).to.equal(4n);
    expect((await escrow.leases(id)).reportHash).to.equal(reportHash);
    await expect(escrow.connect(inspector).resolveDispute(id, tenantShare, landlordShare, reportHash))
      .to.be.revertedWithCustomError(escrow, "WrongStatus");
    // Both zero-share boundaries are valid; neither can mint extra value.
    for (const share of [0n, deposit]) {
      const nextId = await create(f);
      await escrow.connect(tenant).openDispute(nextId);
      await expect(escrow.connect(inspector).resolveDispute(nextId, share, deposit - share, reportHash))
        .to.changeEtherBalances([tenant, landlord, escrow], [share, deposit - share, -deposit]);
    }
    expect(await escrow.totalLocked()).to.equal(0n);
  });

  it("5. Automatic Refund to Tenant After Deadline Timeout", async function () {
    const f = await loadFixture(fixture);
    const { escrow, tenant, landlord, inspector } = f;
    const id = await create(f);
    const confirmedId = await create(f);
    const disputedId = await create(f);
    await escrow.connect(inspector).confirmMoveOut(id, moveOutHash);
    await escrow.connect(landlord).confirmMoveOut(confirmedId, moveOutHash);
    await escrow.connect(landlord).openDispute(disputedId);
    await expect(escrow.connect(tenant).refundOnTimeout(id))
      .to.be.revertedWithCustomError(escrow, "DeadlineNotPassed");
    const deadline = (await escrow.leases(disputedId)).deadline;
    await time.increaseTo(deadline + 1n);
    await expect(escrow.connect(landlord).confirmMoveOut(id, moveOutHash))
      .to.be.revertedWithCustomError(escrow, "DeadlinePassed");
    await expect(escrow.connect(landlord).openDispute(id))
      .to.be.revertedWithCustomError(escrow, "DeadlinePassed");
    await expect(escrow.connect(tenant).refundOnTimeout(confirmedId))
      .to.be.revertedWithCustomError(escrow, "AlreadyConfirmed");
    await expect(escrow.connect(tenant).refundOnTimeout(disputedId))
      .to.be.revertedWithCustomError(escrow, "WrongStatus");
    await expect(escrow.connect(tenant).refundOnTimeout(id))
      .to.changeEtherBalances([tenant, escrow], [deposit, -deposit]);
    expect((await escrow.leases(id)).status).to.equal(5n);
    await expect(escrow.connect(tenant).refundOnTimeout(id))
      .to.be.revertedWithCustomError(escrow, "WrongStatus");
  });

  it("6. Security & Access Control (unauthorized callers and paused-state actions revert)", async function () {
    const f = await loadFixture(fixture);
    const { escrow, wallet, owner2, tenant, landlord, inspector, outsider, role } = f;
    const id = await create(f);
    const disputedId = await create(f);
    await escrow.connect(tenant).openDispute(disputedId);
    await expect(escrow.connect(outsider).grantRole(role, outsider.address))
      .to.be.revertedWithCustomError(escrow, "AccessControlUnauthorizedAccount");
    for (const method of ["pause", "unpause"]) {
      await expect(escrow.connect(outsider)[method]())
        .to.be.revertedWithCustomError(escrow, "AccessControlUnauthorizedAccount");
    }
    for (const [method, args] of [
      ["confirmMoveOut", [id, moveOutHash]], ["openDispute", [id]],
      ["releaseDeposit", [id]], ["refundOnTimeout", [id]]
    ]) {
      await expect(escrow.connect(outsider)[method](...args))
        .to.be.revertedWithCustomError(escrow, "Unauthorized");
    }
    await expect(escrow.connect(landlord).resolveDispute(disputedId, deposit, 0, reportHash))
      .to.be.revertedWithCustomError(escrow, "AccessControlUnauthorizedAccount");
    for (const [method, args] of [
      ["grantRole", [ethers.ZeroHash, outsider.address]],
      ["grantRole", [role, await wallet.getAddress()]],
      ["revokeRole", [role, inspector.address]],
      ["renounceRole", [ethers.ZeroHash, await wallet.getAddress()]]
    ]) {
      await expect(adminCall(wallet, owner2, escrow, method, args))
        .to.be.revertedWithCustomError(escrow, "AdminRestricted");
    }
    await expect(adminCall(wallet, owner2, escrow, "releaseDeposit", [id]))
      .to.be.revertedWithCustomError(escrow, "Unauthorized");
    await expect(escrow.connect(tenant).createLease(await wallet.getAddress(),
      inspector.address, moveInHash, duration, { value: deposit }))
      .to.be.revertedWithCustomError(escrow, "AdminRestricted");
    await expect(escrow.connect(tenant).releaseDeposit(999))
      .to.be.revertedWithCustomError(escrow, "UnknownLease");

    await confirm(f, id);
    await expect(escrow.connect(landlord).openDispute(id))
      .to.be.revertedWithCustomError(escrow, "AlreadyConfirmed");
    await (await adminCall(wallet, owner2, escrow, "pause")).wait();
    const lockedBefore = await escrow.totalLocked();
    for (const [caller, method, args, options] of [
      [tenant, "createLease", [landlord.address, inspector.address, moveInHash, duration], { value: deposit }],
      [landlord, "confirmMoveOut", [id, moveOutHash], {}],
      [tenant, "releaseDeposit", [id], {}],
      [tenant, "openDispute", [id], {}],
      [inspector, "resolveDispute", [disputedId, deposit, 0, reportHash], {}],
      [tenant, "refundOnTimeout", [id], {}]
    ]) {
      await expect(escrow.connect(caller)[method](...args, options))
        .to.be.revertedWithCustomError(escrow, "EnforcedPause");
    }
    expect(await escrow.totalLocked()).to.equal(lockedBefore);
    await (await adminCall(wallet, owner2, escrow, "unpause")).wait();
    await expect(escrow.connect(tenant).releaseDeposit(id))
      .to.changeEtherBalances([tenant, escrow], [deposit, -deposit]);

    const probe = await ethers.deployContract("PayoutProbe", [await escrow.getAddress()]);
    await probe.waitForDeployment();
    await probe.create(landlord.address, inspector.address, moveInHash, duration, { value: deposit });
    const probeId = await probe.leaseId();
    await confirm(f, probeId);
    await probe.setRejectPayment(true);
    await expect(probe.release()).to.be.revertedWithCustomError(escrow, "TransferFailed");
    expect((await escrow.leases(probeId)).deposit).to.equal(deposit);
    expect((await escrow.leases(probeId)).status).to.equal(1n);
    await probe.setRejectPayment(false);
    await expect(probe.release()).to.changeEtherBalances([probe, escrow], [deposit, -deposit]);
    expect(await probe.attempted()).to.equal(true);
    expect(await probe.reentered()).to.equal(false);
    expect((await escrow.leases(probeId)).deposit).to.equal(0n);
    expect(await escrow.totalLocked()).to.equal(deposit); // Only the disputed lease remains.
  });
});
