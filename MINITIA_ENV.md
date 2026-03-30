# MINITIA_ENV — GGPoker L2 Rollup Endpoints

> Generated for chain: `ggpoker-minitia-1` | Runtime: **MiniEVM** | Gas Token: **GAS**

---

## Network Endpoints

| Service         | Protocol   | URL                              | Usage                                    |
|-----------------|------------|----------------------------------|------------------------------------------|
| REST API        | HTTP       | `http://localhost:1317`          | Cosmos LCD queries, bank/staking/gov     |
| Tendermint RPC  | HTTP       | `http://localhost:26657`         | Block queries, tx broadcast, consensus   |
| EVM JSON-RPC    | HTTP       | `http://localhost:8545`          | MetaMask, ethers.js, Hardhat, Foundry    |
| EVM WebSocket   | WS         | `ws://localhost:8546`            | Real-time event subscriptions            |
| gRPC            | gRPC       | `localhost:9090`                 | Protobuf-native queries, high throughput |

## Deployer Credentials (Local Devnet Only)

| Label            | Address                                      | Initial Balance  |
|------------------|----------------------------------------------|------------------|
| `deployer`       | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` | 500,000 GAS      |
| `game_treasury`  | `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` | 200,000 GAS      |
| `faucet`         | `0x90F79bf6EB2c4f870365E785982E1f101E93b906` | 300,000 GAS      |

## EVM Chain Parameters

| Parameter        | Value           |
|------------------|-----------------|
| EVM Chain ID     | `42069`         |
| Block Gas Limit  | `30,000,000`    |
| Min Base Fee     | `1 gwei`        |
| EIP-1559         | Enabled         |

## Hardhat / Foundry Integration

```env
# .env file for contract deployment
RPC_URL=http://localhost:8545
CHAIN_ID=42069
DEPLOYER_PRIVATE_KEY=<insert-local-devnet-key>
GAS_TOKEN=GAS
REST_API=http://localhost:1317
TENDERMINT_RPC=http://localhost:26657
WS_URL=ws://localhost:8546
```

## OPinit Bridge Bot Endpoints

| Bot         | Status      | Key File                             |
|-------------|-------------|--------------------------------------|
| Executor    | Initialized | `./keys/executor_key.json`           |
| Challenger  | Initialized | `./keys/challenger_key.json`         |

### Bridge L1 → L2 Flow

```
Initia L1 ──[IBC/OPinit]──▶ ggpoker-minitia-1 (L2)
   REST: http://localhost:1317/opinit/v1/bridge_info
```

## Deployed Smart Contracts

> Populated by `./deploy.sh` after `forge script` execution.
> Run `./deploy.sh all` to build, test, deploy, and auto-fill these fields.

| Contract              | Address                                      | Description                        |
|-----------------------|----------------------------------------------|------------------------------------|
| `MockBandVRFProvider` | `<DEPLOYED_BY_SCRIPT>`                       | Band VRF mock (auto-fulfill mode)  |
| `PokerGame`           | `<DEPLOYED_BY_SCRIPT>`                       | On-chain Texas Hold'em engine      |
| Default Table         | ID: `0`                                      | 6-max, 0.01/0.02 GAS blinds       |

### Build & Deploy Commands

```bash
# Full pipeline (install → compile → test → deploy → verify):
./deploy.sh all

# Or step by step:
./deploy.sh build        # forge build --sizes
./deploy.sh test         # forge test -vvv --gas-report
./deploy.sh deploy       # forge script → broadcasts to Minitia L2
./deploy.sh verify       # Post-deploy contract verification
```

### Interaction Examples (via `cast`)

```bash
# Join table 0 with 10 GAS buy-in:
cast send --rpc-url http://localhost:8545 --private-key $DEPLOYER_PRIVATE_KEY \
  <POKER_GAME_ADDRESS> 'joinTable(uint256)' 0 --value 10ether

# Request deal (triggers Band VRF → Fisher-Yates shuffle):
cast send --rpc-url http://localhost:8545 --private-key $DEPLOYER_PRIVATE_KEY \
  <POKER_GAME_ADDRESS> 'requestDeal(uint256)' 0

# Check your hole cards:
cast call --rpc-url http://localhost:8545 --from $MY_ADDRESS \
  <POKER_GAME_ADDRESS> 'getMyHoleCards(uint256)' 0

# Read table state:
cast call --rpc-url http://localhost:8545 \
  <POKER_GAME_ADDRESS> 'getSession(uint256)' 0

# Player action (fold):
cast send --rpc-url http://localhost:8545 --private-key $KEY \
  <POKER_GAME_ADDRESS> 'playerAction(uint256,uint8,uint256)' 0 1 0
```

### Key Files

| File                                     | Purpose                                       |
|------------------------------------------|-----------------------------------------------|
| `contracts/src/PokerGame.sol`            | Main contract (1048 LOC, Band VRF + F-Y)      |
| `contracts/src/MockBandVRFProvider.sol`  | Devnet VRF mock with auto-fulfill             |
| `contracts/interfaces/IVRFConsumer.sol`  | Band VRF callback interface                    |
| `contracts/interfaces/IBandVRFProvider.sol` | Band VRF request interface                  |
| `contracts/libraries/PokerLib.sol`       | Card encoding, enums, structs                  |
| `contracts/test/PokerGame.t.sol`         | Foundry test suite (17 tests)                  |
| `script/DeployPokerGame.s.sol`           | Foundry deployment script                      |
| `deploy.sh`                              | Master build/test/deploy automation            |
| `.env`                                   | Environment variables (keys, RPC URLs)         |

---

*⚠ These endpoints are for LOCAL DEVNET only. For testnet/mainnet, replace `localhost` with your node's public IP and ensure firewall rules permit traffic on the listed ports.*
