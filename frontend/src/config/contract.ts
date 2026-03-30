/**
 * config/contract.ts — PokerGame.sol ABI + deployment address
 *
 * Address is populated by deploy.sh → MINITIA_ENV.md
 * Update POKER_GAME_ADDRESS after deployment.
 *
 * v2: Added internal wallet (deposit/withdraw/getBalance) — Polymarket-style
 *     joinTable now takes (tableId, buyIn) from internal balance, not msg.value
 */

/** Set after running: ./deploy.sh all */
export const POKER_GAME_ADDRESS = (
  import.meta.env.VITE_POKER_GAME_ADDRESS ??
  '0x6FEDF1582373d22Fd62725E82E51737811BA27c0'
) as `0x${string}`

/** Subset of PokerGame.sol ABI — events + view functions + write functions */
export const POKER_GAME_ABI = [
  // ── Events ──
  {
    type: 'event', name: 'TableCreated',
    inputs: [
      { name: 'tableId', type: 'uint256', indexed: true },
      { name: 'creator', type: 'address', indexed: true },
      { name: 'smallBlind', type: 'uint256', indexed: false },
      { name: 'bigBlind', type: 'uint256', indexed: false },
      { name: 'maxPlayers', type: 'uint8', indexed: false },
    ],
  },
  {
    type: 'event', name: 'PlayerJoined',
    inputs: [
      { name: 'tableId', type: 'uint256', indexed: true },
      { name: 'player', type: 'address', indexed: true },
      { name: 'seat', type: 'uint8', indexed: false },
      { name: 'buyIn', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event', name: 'StatusChanged',
    inputs: [
      { name: 'tableId', type: 'uint256', indexed: true },
      { name: 'from', type: 'uint8', indexed: false },
      { name: 'to', type: 'uint8', indexed: false },
    ],
  },
  {
    type: 'event', name: 'PlayerActed',
    inputs: [
      { name: 'tableId', type: 'uint256', indexed: true },
      { name: 'player', type: 'address', indexed: true },
      { name: 'action', type: 'uint8', indexed: false },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event', name: 'CommunityRevealed',
    inputs: [
      { name: 'tableId', type: 'uint256', indexed: true },
      { name: 'stage', type: 'uint8', indexed: false },
      { name: 'cards', type: 'uint8[5]', indexed: false },
    ],
  },
  {
    type: 'event', name: 'ShowdownResult',
    inputs: [
      { name: 'tableId', type: 'uint256', indexed: true },
      { name: 'winner', type: 'address', indexed: true },
      { name: 'winningRank', type: 'uint32', indexed: false },
      { name: 'payout', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event', name: 'Deposited',
    inputs: [
      { name: 'player', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'newBalance', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event', name: 'Withdrawn',
    inputs: [
      { name: 'player', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'newBalance', type: 'uint256', indexed: false },
    ],
  },

  // ── View functions ──
  {
    type: 'function', name: 'getSession', stateMutability: 'view',
    inputs: [{ name: 'tableId', type: 'uint256' }],
    outputs: [
      { name: 'handId', type: 'uint256' },
      { name: 'status', type: 'uint8' },
      { name: 'playerCount', type: 'uint8' },
      { name: 'dealerIndex', type: 'uint8' },
      { name: 'pot', type: 'uint256' },
      { name: 'currentBet', type: 'uint256' },
      { name: 'deckCommitment', type: 'bytes32' },
      { name: 'communityCount', type: 'uint8' },
      { name: 'vrfPending', type: 'bool' },
      { name: 'saltsCommitted', type: 'uint8' },
      { name: 'saltsRevealed', type: 'uint8' },
    ],
  },
  {
    type: 'function', name: 'getPlayers', stateMutability: 'view',
    inputs: [{ name: 'tableId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address[]' }],
  },
  {
    type: 'function', name: 'getPlayerState', stateMutability: 'view',
    inputs: [
      { name: 'tableId', type: 'uint256' },
      { name: 'player', type: 'address' },
    ],
    outputs: [
      { name: 'stake', type: 'uint256' },
      { name: 'currentBet', type: 'uint256' },
      { name: 'lastAction', type: 'uint8' },
      { name: 'isActive', type: 'bool' },
      { name: 'seatIndex', type: 'uint8' },
      { name: 'holeCommitment', type: 'bytes32' },
      { name: 'hasRevealed', type: 'bool' },
      { name: 'handRank', type: 'uint32' },
    ],
  },
  {
    type: 'function', name: 'getCommunityCards', stateMutability: 'view',
    inputs: [{ name: 'tableId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint8[5]' }],
  },
  {
    type: 'function', name: 'tableCount', stateMutability: 'view',
    inputs: [], outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function', name: 'getBalance', stateMutability: 'view',
    inputs: [{ name: 'player', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },

  // ── Write functions ──
  {
    type: 'function', name: 'deposit', stateMutability: 'payable',
    inputs: [], outputs: [],
  },
  {
    type: 'function', name: 'withdraw', stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }], outputs: [],
  },
  {
    type: 'function', name: 'joinTable', stateMutability: 'nonpayable',
    inputs: [
      { name: 'tableId', type: 'uint256' },
      { name: 'buyIn', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function', name: 'leaveTable', stateMutability: 'nonpayable',
    inputs: [{ name: 'tableId', type: 'uint256' }], outputs: [],
  },
  {
    type: 'function', name: 'commitSalt', stateMutability: 'nonpayable',
    inputs: [
      { name: 'tableId', type: 'uint256' },
      { name: 'saltHash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function', name: 'requestDeal', stateMutability: 'nonpayable',
    inputs: [{ name: 'tableId', type: 'uint256' }], outputs: [],
  },
  {
    type: 'function', name: 'playerAction', stateMutability: 'nonpayable',
    inputs: [
      { name: 'tableId', type: 'uint256' },
      { name: 'action', type: 'uint8' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function', name: 'revealHoleCards', stateMutability: 'nonpayable',
    inputs: [
      { name: 'tableId', type: 'uint256' },
      { name: 'salt', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function', name: 'evaluateShowdown', stateMutability: 'nonpayable',
    inputs: [{ name: 'tableId', type: 'uint256' }], outputs: [],
  },
] as const
