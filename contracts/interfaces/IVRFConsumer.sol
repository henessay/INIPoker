// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IVRFConsumer — Band Protocol VRF callback interface
/// @notice Any contract wishing to receive verifiable randomness from Band VRF
///         must implement this interface. The Band VRF Provider calls `consume()`
///         once the off-chain VRF proof has been verified on-chain.
/// @dev Reference: Band Protocol VRF v2 specification
///      https://docs.bandchain.org/products/vrf/
///
///      Lifecycle:
///        1. Consumer calls IBandVRFProvider.requestRandomData(seed)
///        2. Band relayer generates VRF proof off-chain
///        3. Provider contract verifies proof on-chain
///        4. Provider calls consumer.consume(seed, time, result)
///
///      SECURITY: The `consume` function MUST verify that msg.sender is the
///      authorized Band VRF Provider. Failure to do so allows anyone to inject
///      fake randomness and rig the shuffle.
interface IVRFConsumer {

    /// @notice Callback invoked by the Band VRF Provider with verified randomness
    /// @param seed   The client-supplied seed string that was passed to requestRandomData.
    ///               Used to correlate the response with the original request.
    ///               For PokerGame: encoded as "POKER:<tableId>:<handId>"
    /// @param time   The Unix timestamp at which the VRF proof was generated.
    ///               Can be used for freshness validation.
    /// @param result The 32-byte VRF output — cryptographically proven to be
    ///               deterministic yet unpredictable. This is the entropy source
    ///               for the Fisher-Yates shuffle, replacing Go's math/rand.
    function consume(
        string calldata seed,
        uint64          time,
        bytes32         result
    ) external;
}
