// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IBandVRFProvider.sol";
import "../interfaces/IVRFConsumer.sol";

/// @title MockBandVRFProvider — Local devnet mock for Band VRF
/// @notice Simulates the Band VRF Provider for Minitia L2 local testing.
///         In production, this is replaced by Band Protocol's deployed provider.
/// @dev This mock immediately fulfills VRF requests using blockhash-based
///      pseudo-randomness. NOT SUITABLE FOR PRODUCTION — only for local devnet.
///
///      Production flow:
///        requestRandomData() → off-chain VRF proof → on-chain verification → consume()
///
///      Mock flow:
///        requestRandomData() → immediate blockhash-derived result → consume()
contract MockBandVRFProvider is IBandVRFProvider {

    /// @notice Pending request storage
    struct PendingRequest {
        address consumer;
        string  seed;
        uint256 blockNumber;
        bool    exists;
    }

    /// @dev Request counter for unique IDs
    uint256 private _nextRequestId;

    /// @notice All pending requests
    mapping(uint256 => PendingRequest) public pendingRequests;

    /// @notice Track requests by consumer+seed hash for dedup
    mapping(bytes32 => uint256) public requestBySeed;

    /// @notice Whether to auto-fulfill on request (true for devnet)
    bool public autoFulfill;

    /// @notice Contract deployer
    address public owner;

    event MockVRFFulfilled(uint256 indexed requestId, address consumer, bytes32 result);

    constructor(bool _autoFulfill) {
        owner = msg.sender;
        autoFulfill = _autoFulfill;
    }

    /// @inheritdoc IBandVRFProvider
    /// @dev In mock mode: immediately computes a pseudo-random result and calls
    ///      the consumer's consume() function. In manual mode: stores the request
    ///      for later fulfillment via fulfillRequest().
    function requestRandomData(string calldata seed) external payable override {
        uint256 requestId = _nextRequestId++;

        pendingRequests[requestId] = PendingRequest({
            consumer:    msg.sender,
            seed:        seed,
            blockNumber: block.number,
            exists:      true
        });

        bytes32 seedHash = keccak256(abi.encodePacked(msg.sender, seed));
        requestBySeed[seedHash] = requestId;

        emit RandomDataRequested(msg.sender, seed, block.number);

        if (autoFulfill) {
            _fulfill(requestId);
        }
    }

    /// @notice Manually fulfill a pending request (for testing step-by-step)
    /// @param requestId The request to fulfill
    function fulfillRequest(uint256 requestId) external {
        require(msg.sender == owner, "Only owner");
        _fulfill(requestId);
    }

    /// @notice Manually fulfill with a specific result (for deterministic tests)
    /// @param requestId The request to fulfill
    /// @param result    The specific bytes32 to use as VRF output
    function fulfillWithResult(uint256 requestId, bytes32 result) external {
        require(msg.sender == owner, "Only owner");
        PendingRequest storage req = pendingRequests[requestId];
        require(req.exists, "Request not found");

        req.exists = false;

        IVRFConsumer(req.consumer).consume(
            req.seed,
            uint64(block.timestamp),
            result
        );

        emit MockVRFFulfilled(requestId, req.consumer, result);
        emit RandomDataFulfilled(req.consumer, req.seed, result);
    }

    /// @dev Internal fulfillment using blockhash-based pseudo-randomness
    function _fulfill(uint256 requestId) internal {
        PendingRequest storage req = pendingRequests[requestId];
        require(req.exists, "Request not found");

        req.exists = false;

        // Generate pseudo-random result from blockhash + seed + requestId
        // WARNING: This is NOT secure randomness — only for local testing
        bytes32 result = keccak256(
            abi.encodePacked(
                blockhash(block.number - 1),
                req.seed,
                requestId,
                block.timestamp,
                block.prevrandao
            )
        );

        // Call the consumer's callback — same signature as real Band VRF
        IVRFConsumer(req.consumer).consume(
            req.seed,
            uint64(block.timestamp),
            result
        );

        emit MockVRFFulfilled(requestId, req.consumer, result);
        emit RandomDataFulfilled(req.consumer, req.seed, result);
    }

    /// @notice Toggle auto-fulfillment mode
    function setAutoFulfill(bool _auto) external {
        require(msg.sender == owner, "Only owner");
        autoFulfill = _auto;
    }
}
