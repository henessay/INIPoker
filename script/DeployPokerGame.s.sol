// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../contracts/src/MockBandVRFProvider.sol";
import "../contracts/src/PokerGame.sol";

/// @title DeployPokerGame — Foundry script to deploy PokerGame on Minitia L2
/// @notice Deploys MockBandVRFProvider + PokerGame, creates a default table,
///         and outputs all addresses for MINITIA_ENV.md integration.
///
/// @dev Deployment sequence:
///   1. Deploy MockBandVRFProvider(autoFulfill=true)  — simulates Band VRF on devnet
///   2. Deploy PokerGame(vrfProvider)                  — main poker contract
///   3. Create a default 6-player table               — ready for testing
///
/// Usage:
///   source .env
///   forge script script/DeployPokerGame.s.sol \
///     --rpc-url http://localhost:8545 \
///     --broadcast \
///     --chain-id 42069 \
///     --private-key $DEPLOYER_PRIVATE_KEY

contract DeployPokerGame is Script {

    function run() external {
        // ── Load deployer key from environment ──
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("=== PokerGame Deployment on Minitia L2 ===");
        console.log("Deployer:", deployer);
        console.log("Chain ID:", block.chainid);
        console.log("RPC URL: http://localhost:8545");
        console.log("");

        vm.startBroadcast(deployerPrivateKey);

        // ── Step 1: Deploy Mock Band VRF Provider ──
        // autoFulfill=true means requestRandomData() immediately calls consume()
        // In production: replace with Band Protocol's deployed VRF Provider address
        MockBandVRFProvider vrfProvider = new MockBandVRFProvider(true);
        console.log("[1/3] MockBandVRFProvider deployed at:", address(vrfProvider));

        // ── Step 2: Deploy PokerGame ──
        PokerGame pokerGame = new PokerGame(address(vrfProvider));
        console.log("[2/3] PokerGame deployed at:           ", address(pokerGame));

        // ── Step 3: Create default testing table ──
        //   Small blind:  0.01 GAS
        //   Big blind:    0.02 GAS
        //   Players:      6
        //   Buy-in range: 1–100 GAS
        //   Timeout:      50 blocks (~2.5 min at 3s/block)
        uint256 tableId = pokerGame.createTable({
            smallBlind:     0.01 ether,
            bigBlind:       0.02 ether,
            maxPlayers:     6,
            minBuyIn:       1 ether,
            maxBuyIn:       100 ether,
            timeoutBlocks:  50
        });
        console.log("[3/3] Default table created, ID:       ", tableId);

        vm.stopBroadcast();

        // ── Summary ──
        console.log("");
        console.log("=== Deployment Summary ===");
        console.log("VRF Provider:  ", address(vrfProvider));
        console.log("PokerGame:     ", address(pokerGame));
        console.log("Table #0:       6-max, 0.01/0.02 GAS blinds, 1-100 GAS buy-in");
        console.log("");
        console.log("Next steps:");
        console.log("  1. Add contract addresses to MINITIA_ENV.md");
        console.log("  2. Deposit:     cast send <PokerGame> 'deposit()' --value 10ether");
        console.log("  3. Join table:  cast send <PokerGame> 'joinTable(uint256,uint256)' 0 10000000000000000000");
        console.log("  4. Request deal: cast send <PokerGame> 'requestDeal(uint256)' 0");
    }
}
