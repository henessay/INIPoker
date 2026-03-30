#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  deploy.sh — Build, Test & Deploy GGPoker on Minitia L2
#
#  Prerequisites:
#    1. Foundry installed: curl -L https://foundry.paradigm.xyz | bash && foundryup
#    2. Minitia L2 running: weave rollup launch --config ./config/config.yaml
#    3. .env configured with DEPLOYER_PRIVATE_KEY
#
#  Usage:
#    ./deploy.sh              # Full pipeline: install deps → build → test → deploy
#    ./deploy.sh build        # Compile only
#    ./deploy.sh test         # Run tests only
#    ./deploy.sh deploy       # Deploy to Minitia L2 only
#    ./deploy.sh verify       # Post-deploy verification
# ═══════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Colors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${CYAN}[$(date +%H:%M:%S)]${NC} $1"; }
ok()   { echo -e "${GREEN}  ✓${NC} $1"; }
warn() { echo -e "${YELLOW}  ⚠${NC} $1"; }
err()  { echo -e "${RED}  ✗${NC} $1"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Load .env ──
if [[ -f .env ]]; then
    set -a; source .env; set +a
    ok "Loaded .env"
else
    err ".env not found. Copy .env and fill in DEPLOYER_PRIVATE_KEY"
fi

# ═══════════════════════════════════════════════════════════════════
#  STEP 1: DEPENDENCY INSTALLATION
# ═══════════════════════════════════════════════════════════════════

do_install() {
    log "Installing dependencies..."

    # Check Foundry
    if ! command -v forge &>/dev/null; then
        err "Foundry not found. Install: curl -L https://foundry.paradigm.xyz | bash && foundryup"
    fi
    ok "Foundry $(forge --version | head -1)"

    # Install forge-std if missing
    if [[ ! -d "lib/forge-std" ]]; then
        log "Installing forge-std..."
        forge install foundry-rs/forge-std --no-commit
        ok "forge-std installed"
    else
        ok "forge-std already present"
    fi
}

# ═══════════════════════════════════════════════════════════════════
#  STEP 2: COMPILATION
# ═══════════════════════════════════════════════════════════════════

do_build() {
    log "Compiling contracts..."

    forge build --sizes 2>&1 | tee /tmp/forge_build.log

    if [[ ${PIPESTATUS[0]} -eq 0 ]]; then
        ok "Compilation successful"
        echo ""
        log "Contract sizes:"
        grep -E "PokerGame|MockBand|PokerLib" /tmp/forge_build.log || true
    else
        err "Compilation failed — check errors above"
    fi
}

# ═══════════════════════════════════════════════════════════════════
#  STEP 3: TESTING
# ═══════════════════════════════════════════════════════════════════

do_test() {
    log "Running test suite..."
    echo ""

    forge test \
        -vvv \
        --gas-report \
        --match-contract PokerGameTest \
        2>&1 | tee /tmp/forge_test.log

    if [[ ${PIPESTATUS[0]} -eq 0 ]]; then
        echo ""
        ok "All tests passed"

        # Extract gas benchmarks
        log "Gas benchmarks:"
        grep -E "requestDeal|playerAction|gas" /tmp/forge_test.log | head -10 || true
    else
        err "Tests failed — check output above"
    fi
}

# ═══════════════════════════════════════════════════════════════════
#  STEP 4: DEPLOYMENT
# ═══════════════════════════════════════════════════════════════════

do_deploy() {
    log "Deploying to Minitia L2..."
    log "  RPC:      ${RPC_URL}"
    log "  Chain ID: ${CHAIN_ID}"
    log "  Deployer: $(cast wallet address --private-key ${DEPLOYER_PRIVATE_KEY} 2>/dev/null || echo 'key-hidden')"
    echo ""

    # Check L2 is reachable
    if ! cast chain-id --rpc-url "${RPC_URL}" &>/dev/null; then
        err "Cannot reach Minitia L2 at ${RPC_URL}. Is the rollup running?"
    fi
    ok "Minitia L2 reachable (chain ID: $(cast chain-id --rpc-url ${RPC_URL}))"

    # Check deployer balance
    BALANCE=$(cast balance --rpc-url "${RPC_URL}" \
        "$(cast wallet address --private-key ${DEPLOYER_PRIVATE_KEY})" 2>/dev/null || echo "0")
    log "Deployer balance: ${BALANCE} wei"

    # Run deployment script
    log "Executing DeployPokerGame.s.sol..."
    echo ""

    forge script script/DeployPokerGame.s.sol \
        --rpc-url "${RPC_URL}" \
        --broadcast \
        --chain-id "${CHAIN_ID}" \
        --private-key "${DEPLOYER_PRIVATE_KEY}" \
        -vvvv \
        2>&1 | tee /tmp/forge_deploy.log

    if [[ ${PIPESTATUS[0]} -eq 0 ]]; then
        echo ""
        ok "Deployment successful"

        # Extract deployed addresses from forge output
        VRF_ADDR=$(grep -oP 'MockBandVRFProvider deployed at:\s*\K0x[a-fA-F0-9]+' /tmp/forge_deploy.log | head -1 || echo "")
        POKER_ADDR=$(grep -oP 'PokerGame deployed at:\s*\K0x[a-fA-F0-9]+' /tmp/forge_deploy.log | head -1 || echo "")

        if [[ -n "$VRF_ADDR" && -n "$POKER_ADDR" ]]; then
            ok "VRF Provider:  ${VRF_ADDR}"
            ok "PokerGame:     ${POKER_ADDR}"

            # Update .env
            sed -i "s|^VRF_PROVIDER_ADDRESS=.*|VRF_PROVIDER_ADDRESS=${VRF_ADDR}|" .env
            sed -i "s|^POKER_GAME_ADDRESS=.*|POKER_GAME_ADDRESS=${POKER_ADDR}|" .env
            ok "Updated .env with contract addresses"

            # Update MINITIA_ENV.md
            _update_env_md "${VRF_ADDR}" "${POKER_ADDR}"
        else
            warn "Could not extract addresses from deploy log"
            warn "Check /tmp/forge_deploy.log and update MINITIA_ENV.md manually"
        fi
    else
        err "Deployment failed"
    fi
}

# ═══════════════════════════════════════════════════════════════════
#  STEP 5: POST-DEPLOY VERIFICATION
# ═══════════════════════════════════════════════════════════════════

do_verify() {
    log "Running post-deploy verification..."

    source .env

    if [[ -z "${POKER_GAME_ADDRESS}" ]]; then
        err "POKER_GAME_ADDRESS not set in .env. Deploy first."
    fi

    # Check contract exists
    CODE=$(cast code --rpc-url "${RPC_URL}" "${POKER_GAME_ADDRESS}" 2>/dev/null || echo "0x")
    if [[ "$CODE" == "0x" || -z "$CODE" ]]; then
        err "No contract code at ${POKER_GAME_ADDRESS}"
    fi
    ok "PokerGame contract verified at ${POKER_GAME_ADDRESS}"

    # Check table count
    COUNT=$(cast call --rpc-url "${RPC_URL}" \
        "${POKER_GAME_ADDRESS}" "tableCount()(uint256)" 2>/dev/null || echo "error")
    ok "Table count: ${COUNT}"

    # Check VRF provider
    VRF=$(cast call --rpc-url "${RPC_URL}" \
        "${POKER_GAME_ADDRESS}" "vrfProvider()(address)" 2>/dev/null || echo "error")
    ok "VRF Provider: ${VRF}"

    echo ""
    log "Verification complete. Quick-start commands:"
    echo ""
    echo "  # Join table 0 with 10 GAS buy-in:"
    echo "  cast send --rpc-url ${RPC_URL} --private-key \$DEPLOYER_PRIVATE_KEY \\"
    echo "    ${POKER_GAME_ADDRESS} 'joinTable(uint256)' 0 --value 10ether"
    echo ""
    echo "  # Request deal (triggers VRF + Fisher-Yates shuffle):"
    echo "  cast send --rpc-url ${RPC_URL} --private-key \$DEPLOYER_PRIVATE_KEY \\"
    echo "    ${POKER_GAME_ADDRESS} 'requestDeal(uint256)' 0"
    echo ""
    echo "  # Read table state:"
    echo "  cast call --rpc-url ${RPC_URL} \\"
    echo "    ${POKER_GAME_ADDRESS} 'getSession(uint256)' 0"
}

# ═══════════════════════════════════════════════════════════════════
#  HELPER: Update MINITIA_ENV.md with deployed addresses
# ═══════════════════════════════════════════════════════════════════

_update_env_md() {
    local vrf_addr="$1"
    local poker_addr="$2"
    local env_file="MINITIA_ENV.md"

    # Check if the deployed contracts section already exists
    if grep -q "Deployed Smart Contracts" "$env_file" 2>/dev/null; then
        # Replace existing section
        sed -i '/## Deployed Smart Contracts/,/^## /{/^## Deployed/!{/^## /!d}}' "$env_file"
        sed -i "/## Deployed Smart Contracts/a\\
\\
| Contract              | Address                                      | Description                  |\\
|-----------------------|----------------------------------------------|------------------------------|\\
| \`MockBandVRFProvider\` | \`${vrf_addr}\` | Band VRF mock (devnet)       |\\
| \`PokerGame\`           | \`${poker_addr}\` | On-chain poker engine        |\\
| Default Table         | ID: \`0\`                                      | 6-max, 0.01/0.02 GAS blinds |\\
" "$env_file"
    else
        # Append new section before the warning footer
        cat >> "$env_file" << SECTION

## Deployed Smart Contracts

| Contract              | Address                                      | Description                  |
|-----------------------|----------------------------------------------|------------------------------|
| \`MockBandVRFProvider\` | \`${vrf_addr}\` | Band VRF mock (devnet)       |
| \`PokerGame\`           | \`${poker_addr}\` | On-chain poker engine        |
| Default Table         | ID: \`0\`                                      | 6-max, 0.01/0.02 GAS blinds |

### Interaction Examples

\`\`\`bash
# Join table:
cast send --rpc-url http://localhost:8545 --private-key \$KEY \\
  ${poker_addr} 'joinTable(uint256)' 0 --value 10ether

# Request deal (VRF + Fisher-Yates shuffle):
cast send --rpc-url http://localhost:8545 --private-key \$KEY \\
  ${poker_addr} 'requestDeal(uint256)' 0

# Check your hole cards:
cast call --rpc-url http://localhost:8545 --from \$ADDR \\
  ${poker_addr} 'getMyHoleCards(uint256)' 0
\`\`\`
SECTION
    fi

    ok "Updated MINITIA_ENV.md with contract addresses"
}

# ═══════════════════════════════════════════════════════════════════
#  MAIN DISPATCHER
# ═══════════════════════════════════════════════════════════════════

main() {
    echo ""
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║  GGPoker → Minitia L2 · Build & Deploy Pipeline            ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo ""

    case "${1:-all}" in
        install) do_install ;;
        build)   do_install; do_build ;;
        test)    do_install; do_build; do_test ;;
        deploy)  do_install; do_build; do_test; do_deploy ;;
        verify)  do_verify ;;
        all)
            do_install
            do_build
            do_test
            do_deploy
            do_verify
            echo ""
            echo "╔══════════════════════════════════════════════════════════════╗"
            echo "║  Deployment complete. See MINITIA_ENV.md for all addresses. ║"
            echo "╚══════════════════════════════════════════════════════════════╝"
            ;;
        *)
            echo "Usage: $0 {install|build|test|deploy|verify|all}"
            exit 1
            ;;
    esac
}

main "$@"
