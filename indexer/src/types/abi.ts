/**
 * types/abi.ts — PokerGame.sol event ABI for viem
 *
 * Maps every Go p2p message type to its on-chain event equivalent:
 *
 *   Go: Handshake + MessagePeerList  → PlayerJoined / PlayerLeft
 *   Go: MessageEncDeck               → HoleCardsCommitted
 *   Go: MessageReady                 → SaltCommitted
 *   Go: MessagePlayerAction          → PlayerActed
 *   Go: GameState.SetStatus()        → StatusChanged
 *   Go: (none — new)                 → ShowdownResult, HoleCardsRevealed
 */

export const POKER_GAME_ABI = [
  // ─── Table lifecycle ───
  {
    type: 'event',
    name: 'TableCreated',
    inputs: [
      { name: 'tableId', type: 'uint256', indexed: true },
      { name: 'creator', type: 'address', indexed: true },
      { name: 'smallBlind', type: 'uint256', indexed: false },
      { name: 'bigBlind', type: 'uint256', indexed: false },
      { name: 'maxPlayers', type: 'uint8', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'PlayerJoined',
    inputs: [
      { name: 'tableId', type: 'uint256', indexed: true },
      { name: 'player', type: 'address', indexed: true },
      { name: 'seat', type: 'uint8', indexed: false },
      { name: 'buyIn', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'PlayerLeft',
    inputs: [
      { name: 'tableId', type: 'uint256', indexed: true },
      { name: 'player', type: 'address', indexed: true },
      { name: 'cashOut', type: 'uint256', indexed: false },
    ],
  },

  // ─── Commit-reveal lifecycle ───
  {
    type: 'event',
    name: 'SaltCommitted',
    inputs: [
      { name: 'tableId', type: 'uint256', indexed: true },
      { name: 'player', type: 'address', indexed: true },
      { name: 'saltHash', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'DealRequested',
    inputs: [
      { name: 'tableId', type: 'uint256', indexed: true },
      { name: 'handId', type: 'uint256', indexed: true },
      { name: 'seed', type: 'string', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'HoleCardsCommitted',
    inputs: [
      { name: 'tableId', type: 'uint256', indexed: true },
      { name: 'handId', type: 'uint256', indexed: true },
      { name: 'player', type: 'address', indexed: true },
      { name: 'commitment', type: 'bytes32', indexed: false },
    ],
  },

  // ─── Game flow ───
  {
    type: 'event',
    name: 'CommunityRevealed',
    inputs: [
      { name: 'tableId', type: 'uint256', indexed: true },
      { name: 'stage', type: 'uint8', indexed: false },
      { name: 'cards', type: 'uint8[5]', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'PlayerActed',
    inputs: [
      { name: 'tableId', type: 'uint256', indexed: true },
      { name: 'player', type: 'address', indexed: true },
      { name: 'action', type: 'uint8', indexed: false },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'StatusChanged',
    inputs: [
      { name: 'tableId', type: 'uint256', indexed: true },
      { name: 'from', type: 'uint8', indexed: false },
      { name: 'to', type: 'uint8', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'PlayerTimedOut',
    inputs: [
      { name: 'tableId', type: 'uint256', indexed: true },
      { name: 'player', type: 'address', indexed: true },
    ],
  },

  // ─── Showdown ───
  {
    type: 'event',
    name: 'HoleCardsRevealed',
    inputs: [
      { name: 'tableId', type: 'uint256', indexed: true },
      { name: 'player', type: 'address', indexed: true },
      { name: 'card0', type: 'uint8', indexed: false },
      { name: 'card1', type: 'uint8', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ShowdownResult',
    inputs: [
      { name: 'tableId', type: 'uint256', indexed: true },
      { name: 'winner', type: 'address', indexed: true },
      { name: 'winningRank', type: 'uint32', indexed: false },
      { name: 'payout', type: 'uint256', indexed: false },
    ],
  },

  // ─── View functions (for initial state hydration) ───
  {
    type: 'function',
    name: 'getSession',
    stateMutability: 'view',
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
    type: 'function',
    name: 'getPlayers',
    stateMutability: 'view',
    inputs: [{ name: 'tableId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address[]' }],
  },
  {
    type: 'function',
    name: 'getPlayerState',
    stateMutability: 'view',
    inputs: [
      { name: 'tableId', type: 'uint256' },
      { name: 'player', type: 'address' },
    ],
    outputs: [
      { name: 'chips', type: 'uint256' },
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
    type: 'function',
    name: 'getCommunityCards',
    stateMutability: 'view',
    inputs: [{ name: 'tableId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint8[5]' }],
  },
  {
    type: 'function',
    name: 'tableCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;
