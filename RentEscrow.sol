// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/// @notice Local educational escrow. Evidence is SHA-256 digests, never report text.
/// @dev OpenZeppelin Contracts v5.0.2 provides MIT-licensed security modules.
contract RentEscrow is AccessControl, ReentrancyGuard, Pausable {
    bytes32 public constant INSPECTOR_ROLE = keccak256("INSPECTOR_ROLE");
    address public immutable adminWallet;
    uint256 public nextLeaseId = 1;
    uint256 public totalLocked;

    enum Status { None, Active, Disputed, Released, Resolved, Refunded }

    struct Lease {
        address tenant;
        address landlord;
        address inspector;
        uint256 deposit;
        uint256 deadline;
        bytes32 moveInHash;
        bytes32 moveOutHash;
        bytes32 reportHash;
        bool landlordConfirmed;
        bool inspectorConfirmed;
        Status status;
    }

    mapping(uint256 => Lease) public leases;

    error InvalidInput();
    error AdminRestricted();
    error UnknownLease();
    error WrongStatus();
    error Unauthorized();
    error DeadlinePassed();
    error DeadlineNotPassed();
    error ConfirmationMismatch();
    error AlreadyConfirmed();
    error NotConfirmed();
    error InvalidSplit();
    error TransferFailed();

    event LeaseCreated(uint256 indexed leaseId, address indexed tenant, address indexed landlord,
        address inspector, uint256 deposit, uint256 deadline, bytes32 moveInHash);
    event MoveOutConfirmed(uint256 indexed leaseId, address indexed confirmer, bytes32 moveOutHash);
    event DisputeOpened(uint256 indexed leaseId, address indexed participant);
    event DepositSettled(uint256 indexed leaseId, Status status,
        uint256 tenantShare, uint256 landlordShare, bytes32 reportHash);

    constructor(address _adminWallet) {
        if (_adminWallet == address(0)) revert InvalidInput();
        adminWallet = _adminWallet;
        _grantRole(DEFAULT_ADMIN_ROLE, _adminWallet);
    }

    // Narrow inherited AccessControl: no additional admins, revocation or renunciation.
    function grantRole(bytes32 role, address account)
        public override onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (role != INSPECTOR_ROLE || account == adminWallet) revert AdminRestricted();
        if (account == address(0)) revert InvalidInput();
        _grantRole(role, account);
    }

    function revokeRole(bytes32, address) public pure override { revert AdminRestricted(); }
    function renounceRole(bytes32, address) public pure override { revert AdminRestricted(); }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) { _pause(); }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }

    /// @param _duration Seconds until the landlord's response deadline.
    function createLease(address _landlord, address _inspector, bytes32 _moveInHash,
        uint256 _duration) external payable whenNotPaused
    {
        if (msg.sender == adminWallet || _landlord == adminWallet) revert AdminRestricted();
        if (msg.value == 0 || _duration == 0 || _moveInHash == bytes32(0)
            || _landlord == address(0) || _landlord == msg.sender
            || _inspector == msg.sender || _inspector == _landlord
            || !hasRole(INSPECTOR_ROLE, _inspector)) revert InvalidInput();

        uint256 leaseId = nextLeaseId++;
        Lease storage lease = leases[leaseId];
        lease.tenant = msg.sender;
        lease.landlord = _landlord;
        lease.inspector = _inspector;
        lease.deposit = msg.value;
        lease.deadline = block.timestamp + _duration;
        lease.moveInHash = _moveInHash;
        lease.status = Status.Active;
        totalLocked += msg.value;
        emit LeaseCreated(leaseId, msg.sender, _landlord, _inspector,
            msg.value, lease.deadline, _moveInHash);
    }

    /// @notice Both parties must attest to the same nonzero move-out digest.
    function confirmMoveOut(uint256 _leaseId, bytes32 _moveOutHash) external whenNotPaused {
        Lease storage lease = _activeLease(_leaseId);
        bool isLandlord = msg.sender == lease.landlord;
        bool isInspector = msg.sender == lease.inspector && hasRole(INSPECTOR_ROLE, msg.sender);
        if (!isLandlord && !isInspector) revert Unauthorized();
        // A late landlord cannot race the timeout refund. The inspector may finish later.
        if (isLandlord && block.timestamp > lease.deadline) revert DeadlinePassed();
        if (_moveOutHash == bytes32(0)) revert InvalidInput();
        if (lease.moveOutHash != bytes32(0) && lease.moveOutHash != _moveOutHash) {
            revert ConfirmationMismatch();
        }
        if (isLandlord) {
            if (lease.landlordConfirmed) revert AlreadyConfirmed();
            lease.landlordConfirmed = true;
        } else {
            if (lease.inspectorConfirmed) revert AlreadyConfirmed();
            lease.inspectorConfirmed = true;
        }
        lease.moveOutHash = _moveOutHash;
        emit MoveOutConfirmed(_leaseId, msg.sender, _moveOutHash);
    }

    /// @notice The tenant triggers the rule-based full refund after both confirmations.
    function releaseDeposit(uint256 _leaseId) external nonReentrant whenNotPaused {
        Lease storage lease = _activeLease(_leaseId);
        if (msg.sender != lease.tenant) revert Unauthorized();
        if (!lease.landlordConfirmed || !lease.inspectorConfirmed) revert NotConfirmed();
        _settle(_leaseId, lease, Status.Released, lease.deposit, 0, bytes32(0));
    }

    /// @notice A landlord must dispute before the deadline; the tenant may dispute later.
    function openDispute(uint256 _leaseId) external whenNotPaused {
        Lease storage lease = _activeLease(_leaseId);
        if (msg.sender != lease.tenant && msg.sender != lease.landlord) revert Unauthorized();
        if (msg.sender == lease.landlord && block.timestamp > lease.deadline) {
            revert DeadlinePassed();
        }
        if (lease.landlordConfirmed && lease.inspectorConfirmed) revert AlreadyConfirmed();
        lease.status = Status.Disputed;
        emit DisputeOpened(_leaseId, msg.sender);
    }

    /// @notice Only the inspector selected at creation may arbitrate this lease.
    function resolveDispute(uint256 _leaseId, uint256 _tenantShare, uint256 _landlordShare,
        bytes32 _reportHash) external onlyRole(INSPECTOR_ROLE) nonReentrant whenNotPaused
    {
        Lease storage lease = _getLease(_leaseId);
        if (msg.sender != lease.inspector) revert Unauthorized();
        if (lease.status != Status.Disputed) revert WrongStatus();
        if (_reportHash == bytes32(0)) revert InvalidInput();
        if (_tenantShare > lease.deposit || _landlordShare != lease.deposit - _tenantShare) {
            revert InvalidSplit();
        }
        _settle(_leaseId, lease, Status.Resolved, _tenantShare, _landlordShare, _reportHash);
    }

    /// @notice Inspector-only confirmation is not landlord action and cannot block timeout.
    function refundOnTimeout(uint256 _leaseId) external nonReentrant whenNotPaused {
        Lease storage lease = _activeLease(_leaseId);
        if (msg.sender != lease.tenant) revert Unauthorized();
        if (block.timestamp <= lease.deadline) revert DeadlineNotPassed();
        if (lease.landlordConfirmed) revert AlreadyConfirmed();
        _settle(_leaseId, lease, Status.Refunded, lease.deposit, 0, bytes32(0));
    }

    function _getLease(uint256 leaseId) private view returns (Lease storage lease) {
        lease = leases[leaseId];
        if (lease.status == Status.None) revert UnknownLease();
    }

    function _activeLease(uint256 leaseId) private view returns (Lease storage lease) {
        lease = _getLease(leaseId);
        if (lease.status != Status.Active) revert WrongStatus();
    }

    // Checks occur in entry points. All effects precede all external interactions.
    function _settle(uint256 leaseId, Lease storage lease, Status status,
        uint256 tenantShare, uint256 landlordShare, bytes32 reportHash) private
    {
        uint256 amount = lease.deposit;
        lease.status = status;
        lease.deposit = 0;
        lease.reportHash = reportHash;
        totalLocked -= amount;
        emit DepositSettled(leaseId, status, tenantShare, landlordShare, reportHash);
        _pay(lease.tenant, tenantShare);
        _pay(lease.landlord, landlordShare);
    }

    function _pay(address recipient, uint256 amount) private {
        if (amount == 0) return;
        (bool success, ) = payable(recipient).call{value: amount}("");
        if (!success) revert TransferFailed();
    }
}
