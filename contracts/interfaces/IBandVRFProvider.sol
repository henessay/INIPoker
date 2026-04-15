// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IBandVRFProvider — Band Protocol VRF request interface
/// @notice Contract deployed by Band Protocol on each supported chain.
///         Consumer contracts call `requestRandomData()` to initiate a VRF round.
/// @dev On Minitia L2 (MiniEVM), the provider address is configured at genesis
///      or registered via Initia's oracle module bridge from the Band L1 relayer.
///
///      Flow:
///        requestRandomData(seed) → emits RandomDataRequested event
///        → Band relayer picks up event → generates VRF proof
///        → relayer submits proof tx → provider verifies proof
///        → provider calls consumer.consume(seed, time, result)
interface IBandVRFProvider {

    /// @notice Request verifiable random data from the Band VRF oracle
    /// @param seed A client-defined string used to uniquely identify this request.
    ///             The same seed will be passed back in the consume() callback.
    ///             Must be unique per request to prevent replay attacks.
    ///             Convention for poker: "POKER:<tableId>:<handId>"
    /// @dev The provider may require a fee (paid in native token) depending on
    ///      network configuration. On Minitia devnet, fees are typically zero.
    ///      The caller MUST implement IVRFConsumer.consume() or the callback
    ///      will revert, and the randomness will be lost.
    function requestRandomData(string calldata seed) external payable;

    /// @notice Emitted when a randomness request is registered
    /// @param caller  The contract requesting randomness (must implement IVRFConsumer)
    /// @param seed    The client-supplied seed string
    /// @param blockNo The block number at which the request was made
    event RandomDataRequested(
        address indexed caller,
        string          seed,
        uint256         blockNo
    );

    /// @notice Emitted when a VRF result is delivered to a consumer
    /// @param consumer The contract that received the randomness via consume()
    /// @param seed     The client-supplied seed string
    /// @param result   The 32-byte VRF output delivered
    event RandomDataFulfilled(
        address indexed consumer,
        string          seed,
        bytes32         result
    );
}
