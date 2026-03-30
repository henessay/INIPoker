/**
 * config/contract.ts — PokerGame.sol ABI + deployment address
 *
 * v3: Added sessions() auto-getter (returns deckSeed, activePlayerIndex, etc.)
 *     Added getRevealedCards for showdown card display
 */

export const POKER_GAME_ADDRESS = (
  import.meta.env.VITE_POKER_GAME_ADDRESS ??
  '0x6FEDF1582373d22Fd62725E82E51737811BA27c0'
) as `0x${string}`

export const POKER_GAME_ABI = [
  // ── Events ──
  { type: 'event', name: 'TableCreated', inputs: [{ name: 'tableId', type: 'uint256', indexed: true }, { name: 'creator', type: 'address', indexed: true }, { name: 'smallBlind', type: 'uint256' }, { name: 'bigBlind', type: 'uint256' }, { name: 'maxPlayers', type: 'uint8' }] },
  { type: 'event', name: 'PlayerJoined', inputs: [{ name: 'tableId', type: 'uint256', indexed: true }, { name: 'player', type: 'address', indexed: true }, { name: 'seat', type: 'uint8' }, { name: 'buyIn', type: 'uint256' }] },
  { type: 'event', name: 'StatusChanged', inputs: [{ name: 'tableId', type: 'uint256', indexed: true }, { name: 'from', type: 'uint8' }, { name: 'to', type: 'uint8' }] },
  { type: 'event', name: 'PlayerActed', inputs: [{ name: 'tableId', type: 'uint256', indexed: true }, { name: 'player', type: 'address', indexed: true }, { name: 'action', type: 'uint8' }, { name: 'value', type: 'uint256' }] },
  { type: 'event', name: 'CommunityRevealed', inputs: [{ name: 'tableId', type: 'uint256', indexed: true }, { name: 'stage', type: 'uint8' }, { name: 'cards', type: 'uint8[5]' }] },
  { type: 'event', name: 'ShowdownResult', inputs: [{ name: 'tableId', type: 'uint256', indexed: true }, { name: 'winner', type: 'address', indexed: true }, { name: 'winningRank', type: 'uint32' }, { name: 'payout', type: 'uint256' }] },
  { type: 'event', name: 'Deposited', inputs: [{ name: 'player', type: 'address', indexed: true }, { name: 'amount', type: 'uint256' }, { name: 'newBalance', type: 'uint256' }] },
  { type: 'event', name: 'Withdrawn', inputs: [{ name: 'player', type: 'address', indexed: true }, { name: 'amount', type: 'uint256' }, { name: 'newBalance', type: 'uint256' }] },

  // ── sessions(uint256) — auto-generated getter, returns ALL scalar fields ──
  // Includes deckSeed, activePlayerIndex, smallBlind, bigBlind — not in getSession()
  {
    type: 'function', name: 'sessions', stateMutability: 'view',
    inputs: [{ name: '', type: 'uint256' }],
    outputs: [
      { name: 'tableId', type: 'uint256' },
      { name: 'handId', type: 'uint256' },
      { name: 'maxPlayers', type: 'uint8' },
      { name: 'minBuyIn', type: 'uint256' },
      { name: 'maxBuyIn', type: 'uint256' },
      { name: 'status', type: 'uint8' },
      { name: 'dealerIndex', type: 'uint8' },
      { name: 'activePlayerIndex', type: 'uint8' },
      { name: 'playerCount', type: 'uint8' },
      { name: 'pot', type: 'uint256' },
      { name: 'currentBet', type: 'uint256' },
      { name: 'smallBlind', type: 'uint256' },
      { name: 'bigBlind', type: 'uint256' },
      { name: 'vrfPending', type: 'bool' },
      { name: 'vrfRequestBlock', type: 'uint256' },
      { name: 'deckSeed', type: 'bytes32' },
      { name: 'deckCommitment', type: 'bytes32' },
      { name: 'deckCursor', type: 'uint8' },
      { name: 'communityCount', type: 'uint8' },
      { name: 'saltsCommitted', type: 'uint8' },
      { name: 'saltsRevealed', type: 'uint8' },
      { name: 'lastActionBlock', type: 'uint256' },
      { name: 'actionTimeout', type: 'uint256' },
    ],
  },

  // ── View functions ──
  {
    type: 'function', name: 'getSession', stateMutability: 'view',
    inputs: [{ name: 'tableId', type: 'uint256' }],
    outputs: [
      { name: 'handId', type: 'uint256' }, { name: 'status', type: 'uint8' },
      { name: 'playerCount', type: 'uint8' }, { name: 'dealerIndex', type: 'uint8' },
      { name: 'pot', type: 'uint256' }, { name: 'currentBet', type: 'uint256' },
      { name: 'deckCommitment', type: 'bytes32' }, { name: 'communityCount', type: 'uint8' },
      { name: 'vrfPending', type: 'bool' }, { name: 'saltsCommitted', type: 'uint8' },
      { name: 'saltsRevealed', type: 'uint8' },
    ],
  },
  { type: 'function', name: 'getPlayers', stateMutability: 'view', inputs: [{ name: 'tableId', type: 'uint256' }], outputs: [{ name: '', type: 'address[]' }] },
  {
    type: 'function', name: 'getPlayerState', stateMutability: 'view',
    inputs: [{ name: 'tableId', type: 'uint256' }, { name: 'player', type: 'address' }],
    outputs: [
      { name: 'stake', type: 'uint256' }, { name: 'currentBet', type: 'uint256' },
      { name: 'lastAction', type: 'uint8' }, { name: 'isActive', type: 'bool' },
      { name: 'seatIndex', type: 'uint8' }, { name: 'holeCommitment', type: 'bytes32' },
      { name: 'hasRevealed', type: 'bool' }, { name: 'handRank', type: 'uint32' },
    ],
  },
  {
    type: 'function', name: 'getRevealedCards', stateMutability: 'view',
    inputs: [{ name: 'tableId', type: 'uint256' }, { name: 'player', type: 'address' }],
    outputs: [
      { name: 'c0s', type: 'uint8' }, { name: 'c0v', type: 'uint8' },
      { name: 'c1s', type: 'uint8' }, { name: 'c1v', type: 'uint8' },
    ],
  },
  { type: 'function', name: 'getCommunityCards', stateMutability: 'view', inputs: [{ name: 'tableId', type: 'uint256' }], outputs: [{ name: '', type: 'uint8[5]' }] },
  { type: 'function', name: 'tableCount', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'getBalance', stateMutability: 'view', inputs: [{ name: 'player', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },

  // ── Write functions ──
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
  { type: 'function', name: 'withdraw', stateMutability: 'nonpayable', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'joinTable', stateMutability: 'nonpayable', inputs: [{ name: 'tableId', type: 'uint256' }, { name: 'buyIn', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'leaveTable', stateMutability: 'nonpayable', inputs: [{ name: 'tableId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'commitSalt', stateMutability: 'nonpayable', inputs: [{ name: 'tableId', type: 'uint256' }, { name: 'saltHash', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'requestDeal', stateMutability: 'nonpayable', inputs: [{ name: 'tableId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'playerAction', stateMutability: 'nonpayable', inputs: [{ name: 'tableId', type: 'uint256' }, { name: 'action', type: 'uint8' }, { name: 'value', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'revealHoleCards', stateMutability: 'nonpayable', inputs: [{ name: 'tableId', type: 'uint256' }, { name: 'salt', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'evaluateShowdown', stateMutability: 'nonpayable', inputs: [{ name: 'tableId', type: 'uint256' }], outputs: [] },
] as const
