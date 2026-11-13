// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../RentEscrow.sol";

/// @notice Test-only tenant for rejected payouts and attempted reentrancy.
contract PayoutProbe {
    RentEscrow public immutable escrow;
    uint256 public leaseId;
    bool public rejectPayment;
    bool public attempted;
    bool public reentered;

    constructor(RentEscrow target) { escrow = target; }

    function create(address landlord, address inspector, bytes32 digest, uint256 duration)
        external payable
    {
        leaseId = escrow.nextLeaseId();
        escrow.createLease{value: msg.value}(landlord, inspector, digest, duration);
    }

    function setRejectPayment(bool reject) external { rejectPayment = reject; }
    function release() external { escrow.releaseDeposit(leaseId); }

    receive() external payable {
        require(!rejectPayment, "Test receiver rejects payment");
        if (!attempted) {
            attempted = true;
            (reentered, ) = address(escrow).call(
                abi.encodeCall(RentEscrow.releaseDeposit, (leaseId))
            );
        }
    }
}
