// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal local-only 2-of-3 admin demonstrator, not an audited wallet.
/// @dev Fixed owners, zero-value calls, unique proposal IDs and no delegatecall.
contract LocalAdminMultisig {
    mapping(address => bool) public isOwner;
    struct Proposal { address target; bytes data; uint256 approvals; bool executed; }
    Proposal[] private proposals;
    mapping(uint256 => mapping(address => bool)) public approved;
    error Unauthorized();
    error InvalidProposal();
    error NotApproved();
    event Submitted(uint256 indexed id, address indexed target);
    event Confirmed(uint256 indexed id, address indexed owner);
    event Executed(uint256 indexed id);

    modifier onlyOwner() {
        if (!isOwner[msg.sender]) revert Unauthorized();
        _;
    }

    constructor(address[3] memory owners) {
        for (uint256 i; i < 3; ++i) {
            if (owners[i] == address(0) || isOwner[owners[i]]) revert InvalidProposal();
            isOwner[owners[i]] = true;
        }
    }

    function proposalCount() external view returns (uint256) { return proposals.length; }

    function submit(address target, bytes calldata data) external onlyOwner returns (uint256 id) {
        if (target.code.length == 0 || data.length < 4) revert InvalidProposal();
        id = proposals.length;
        proposals.push(Proposal(target, data, 0, false));
        emit Submitted(id, target);
    }

    function confirm(uint256 id) external onlyOwner {
        if (id >= proposals.length || proposals[id].executed || approved[id][msg.sender]) {
            revert InvalidProposal();
        }
        approved[id][msg.sender] = true;
        ++proposals[id].approvals;
        emit Confirmed(id, msg.sender);
    }

    function execute(uint256 id) external onlyOwner {
        if (id >= proposals.length || proposals[id].executed) revert InvalidProposal();
        Proposal storage proposal = proposals[id];
        if (proposal.approvals < 2) revert NotApproved();
        proposal.executed = true;
        (bool success, bytes memory result) = proposal.target.call(proposal.data);
        // Bubble target custom errors; a failed call reverts the executed flag too.
        if (!success) {
            assembly { revert(add(result, 32), mload(result)) }
        }
        emit Executed(id);
    }
}
