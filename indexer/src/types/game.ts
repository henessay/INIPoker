/**
 * types/game.ts — On-chain game state types
 *
 * Traceability map (Go P2P → Solidity Event → TypeScript):
 *
 *   Go p2p.Handshake         → PlayerJoined event    → PlayerInfo
 *   Go p2p.MessagePeerList   → getPlayers() view     → TableState.players
 *   Go p2p.MessageEncDeck    → HoleCardsCommitted    → PlayerInfo.holeCommitment
 *   Go p2p.MessagePlayerAction → PlayerActed event   → PlayerAction
 *   Go p2p.GameStatus enum   → StatusChanged event   → GameStatus enum
 *   Go p2p.GameState struct  → Session storage       → TableState
 *   Go p2p.TableState        → getSession() view     → TableState
 *   Go p2p.broadCh channel   → WebSocket event sub   → EventIndexer
 *   Go p2p.msgCh channel     → contract tx receipt   → (tx confirmation)
 *   Go sync.RWMutex          → (not needed)          → (single-threaded JS)
 */

// ─── Mirrors PokerLib.GameStatus enum (p2p.GameStatus) ───

export enum GameStatus {
  Waiting   = 0,   // Go: GameStatusWaiting
  Dealing   = 1,   // Go: GameStatusDealing
  PreFlop   = 2,   // Go: GameStatusPreFlop
  Flop      = 3,   // Go: GameStatusFlop
  Turn      = 4,   // Go: GameStatusTurn
  River     = 5,   // Go: GameStatusRiver
  Showdown  = 6,   // (new — not in Go)
  Settled   = 7,   // (new — not in Go)
}

// ─── Mirrors PokerLib.Action enum (p2p.PlayerAction) ───

export enum PlayerActionType {
  None    = 0,
  Fold    = 1,   // Go: PlayerActionFold
  Check   = 2,   // Go: PlayerActionCheck
  Bet     = 3,   // Go: PlayerActionBet
  Call    = 4,   // (new)
  Raise   = 5,   // (new)
  AllIn   = 6,   // (new)
}

// ─── Card encoding (mirrors PokerLib.encodeCard / deck.Card) ───

export interface Card {
  suit: number;   // 0=Spades, 1=Hearts, 2=Diamonds, 3=Clubs
  value: number;  // 1=Ace .. 13=King
  encoded: number; // (suit << 4) | value
}

export function decodeCard(encoded: number): Card {
  return {
    suit: encoded >> 4,
    value: encoded & 0x0F,
    encoded,
  };
}

export function cardName(c: Card): string {
  const suits = ['♠', '♥', '♦', '♣'];
  const values = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  return `${values[c.value]}${suits[c.suit]}`;
}

// ─── Player state (replaces Go p2p.Peer + GameState player tracking) ───

export interface PlayerInfo {
  address: `0x${string}`;
  chips: bigint;
  currentBet: bigint;
  lastAction: PlayerActionType;
  isActive: boolean;
  seatIndex: number;
  holeCommitment: `0x${string}`;  // keccak256 — opaque until showdown
  hasRevealed: boolean;
  revealedCards?: [Card, Card];    // populated only after Phase 4 reveal
  handRank?: number;               // populated after evaluateShowdown
}

// ─── Table state (replaces Go p2p.GameState + p2p.TableState) ───
//
// In Go, this was maintained via:
//   sync.RWMutex + mutable fields + broadCh broadcasts
//
// Now: reconstructed purely from on-chain events (Single Source of Truth)

export interface TableState {
  tableId: bigint;
  handId: bigint;
  status: GameStatus;
  playerCount: number;
  dealerIndex: number;
  activePlayerIndex: number;
  pot: bigint;
  currentBet: bigint;
  smallBlind: bigint;
  bigBlind: bigint;
  community: Card[];            // 0, 3, 4, or 5 cards
  deckCommitment: `0x${string}`;
  vrfPending: boolean;
  saltsCommitted: number;
  saltsRevealed: number;

  // Player data (replaces Go peers map + playersList)
  players: Map<`0x${string}`, PlayerInfo>;
  seats: (`0x${string}` | null)[];
}

// ─── Event log entry (for reorg-safe replay) ───

export interface IndexedEvent {
  eventName: string;
  blockNumber: bigint;
  blockHash: `0x${string}`;
  transactionHash: `0x${string}`;
  logIndex: number;
  args: Record<string, unknown>;
  confirmed: boolean;   // true after CONFIRMATION_DEPTH blocks
  timestamp: number;    // local receipt time (ms)
}

// ─── Reorg tracking ───

export interface ReorgInfo {
  depth: number;              // how many blocks were reverted
  removedEvents: IndexedEvent[];
  replayedEvents: IndexedEvent[];
  detectedAtBlock: bigint;
}
