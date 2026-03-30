# PROJECT_STATE.md — INIPoker

> Last updated: 2026-03-30

## Architecture: Polymarket-Style Internal Wallet

```
External Wallet (INIT on L2)
     │
     │  deposit()  payable
     ▼
┌──────────────────────────┐
│   Internal Game Balance  │  ← balances[player] in contract
│   (getBalance view)      │
└──────────┬───────────────┘
           │  joinTable(tableId, buyIn)
           ▼
┌──────────────────────────┐
│   Table Chips            │  ← playerStates[tableId][player].chips
│   (getPlayerState view)  │
└──────────┬───────────────┘
           │  leaveTable()
           ▼
     Internal Game Balance
           │
           │  withdraw(amount)
           ▼
     External Wallet
```

## Files Modified

### Smart Contract
| File | Change |
|------|--------|
| `contracts/src/PokerGame.sol` | Added `mapping(address => uint256) balances` + `deposit()` + `withdraw(uint256)` + `getBalance(address)`. `joinTable` now takes `(tableId, buyIn)` from internal balance (was payable). `leaveTable` returns chips to internal balance (was `msg.sender.call`). `receive()` auto-deposits. |
| `contracts/test/PokerGame.t.sol` | Updated `_join` helper: deposits first, then joins. Fixed edge case tests (T07-T09), leave test (T10), gas benchmark (T58). |
| `script/DeployPokerGame.s.sol` | Updated console log instructions. |

### Frontend
| File | Change |
|------|--------|
| `frontend/src/config/contract.ts` | Added ABI: `deposit`, `withdraw`, `getBalance`, `Deposited`, `Withdrawn` events. `joinTable` now `nonpayable` with `(tableId, buyIn)` args. |
| `frontend/src/hooks/useWalletBalance.ts` | 3-tier balance: `walletBalance` (native L2), `gameBalance` (contract internal), `tableChips` (per-table). Reads `getBalance` instead of `getPlayerState` for game balance. |
| `frontend/src/components/CashierModal.tsx` | Real on-chain deposit/withdraw via `useWriteContract`. Amount input + quick amounts. Tx feedback (ok/err/info). No more bridge callbacks. |
| `frontend/src/components/Lobby.tsx` | Top bar shows `Wallet: X INIT · Game: X INIT`. CashierModal simplified props. Removed `openBridge` usage. |
| `frontend/src/components/PokerTable.tsx` | `joinTable` uses `exec('joinTable', [tableId, buyIn])` — no `value`. Status strip shows 3 tiers. Removed bridge buttons. Cashier-only for fund management. |

## Known Remaining Items
- Tournament registration is local state only (no contract call)
- Table data in Lobby is static mock data
- No WebSocket subscription for live game updates
- joinTable buy-in amount is hardcoded 10 INIT — should be configurable per table
- No auto-refresh interval for balances
