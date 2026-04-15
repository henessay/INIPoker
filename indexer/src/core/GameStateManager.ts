/**
 * core/GameStateManager.ts
 *
 * Replaces Go's p2p.GameState struct and all its methods:
 *
 *   Go: GameState.SetStatus()        → applyStatusChanged()
 *   Go: GameState.AddPlayer()        → applyPlayerJoined()
 *   Go: GameState.HandlePlayerAction()→ applyPlayerActed()
 *   Go: GameState.AdvanceStatus()    → applyStatusChanged()
 *   Go: GameState.GetTableState()    → getTable()
 *   Go: sync.RWMutex                 → (not needed — JS is single-threaded)
 *
 * KEY ARCHITECTURE DIFFERENCE:
 *   Go:  State mutated by incoming TCP messages → broadcast to peers
 *   Now: State derived ONLY from confirmed on-chain events (event sourcing)
 *        No mutable state. Each event produces a new state snapshot.
 *        This makes reorg handling trivial: replay events from fork point.
 */

import {
  TableState, PlayerInfo, GameStatus, PlayerActionType,
  IndexedEvent, Card, decodeCard, ReorgInfo,
} from '../types/game.js';

export type StateChangeCallback = (
  tableId: bigint,
  event: IndexedEvent,
  state: TableState
) => void;

export class GameStateManager {
  /** All table states keyed by tableId */
  private tables = new Map<string, TableState>();

  /** Ordered event log per table — enables reorg replay */
  private eventLog = new Map<string, IndexedEvent[]>();

  /** Block hash at each height — for reorg detection */
  private blockHashes = new Map<string, `0x${string}`>();

  /** Confirmation depth before events are considered final */
  private confirmationDepth: number;

  /** State change listeners */
  private listeners: StateChangeCallback[] = [];

  constructor(confirmationDepth = 3) {
    this.confirmationDepth = confirmationDepth;
  }

  // ═══════════════════════════════════════════════════════════
  //  PUBLIC API
  // ═══════════════════════════════════════════════════════════

  onStateChange(cb: StateChangeCallback): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter(l => l !== cb);
    };
  }

  getTable(tableId: bigint): TableState | undefined {
    return this.tables.get(tableId.toString());
  }

  getAllTables(): TableState[] {
    return [...this.tables.values()];
  }

  getEventLog(tableId: bigint): IndexedEvent[] {
    return this.eventLog.get(tableId.toString()) ?? [];
  }

  // ═══════════════════════════════════════════════════════════
  //  EVENT APPLICATION (replaces Go GameState mutation methods)
  // ═══════════════════════════════════════════════════════════

  /**
   * Process an on-chain event and update local state.
   * This is the SINGLE entry point for ALL state mutations.
   *
   * In Go, state was mutated by:
   *   - Server.handleMessage() dispatching to GameState methods
   *   - GameState.SetStatus(), AddPlayer(), HandlePlayerAction()
   *   All protected by sync.RWMutex.
   *
   * Now: one function, no mutex, pure event sourcing.
   */
  applyEvent(event: IndexedEvent): void {
    // Track block hashes for reorg detection
    this.blockHashes.set(
      event.blockNumber.toString(),
      event.blockHash
    );

    const args = event.args;
    const tableId = args.tableId as bigint;
    const key = tableId?.toString();

    // Store in event log
    if (key) {
      const log = this.eventLog.get(key) ?? [];
      log.push(event);
      this.eventLog.set(key, log);
    }

    // Dispatch to specific handler
    switch (event.eventName) {
      case 'TableCreated':
        this.applyTableCreated(args); break;
      case 'PlayerJoined':
        this.applyPlayerJoined(args); break;
      case 'PlayerLeft':
        this.applyPlayerLeft(args); break;
      case 'SaltCommitted':
        this.applySaltCommitted(args); break;
      case 'DealRequested':
        this.applyDealRequested(args); break;
      case 'HoleCardsCommitted':
        this.applyHoleCardsCommitted(args); break;
      case 'StatusChanged':
        this.applyStatusChanged(args); break;
      case 'PlayerActed':
        this.applyPlayerActed(args); break;
      case 'PlayerTimedOut':
        this.applyPlayerTimedOut(args); break;
      case 'CommunityRevealed':
        this.applyCommunityRevealed(args); break;
      case 'HoleCardsRevealed':
        this.applyHoleCardsRevealed(args); break;
      case 'ShowdownResult':
        this.applyShowdownResult(args); break;
    }

    // Notify listeners
    if (key) {
      const state = this.tables.get(key);
      if (state) {
        for (const cb of this.listeners) cb(tableId, event, state);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  REORG HANDLING
  // ═══════════════════════════════════════════════════════════

  /**
   * Handle a chain reorganization.
   *
   * In Go's P2P model, reorgs don't exist — peers trust each other.
   * On-chain, optimistic rollups can revert blocks during disputes.
   *
   * Strategy: remove all events at/after the fork block, then replay
   * any new events from the canonical chain. The event-sourced design
   * makes this trivial — just rebuild state from the event log.
   *
   * @param forkBlock Block number where the reorg occurred
   * @param newEvents Events from the new canonical chain
   */
  handleReorg(forkBlock: bigint, newEvents: IndexedEvent[]): ReorgInfo {
    const removedEvents: IndexedEvent[] = [];
    const affectedTables = new Set<string>();

    // Remove events at/after fork point from all tables
    for (const [key, log] of this.eventLog) {
      const kept: IndexedEvent[] = [];
      for (const ev of log) {
        if (ev.blockNumber >= forkBlock) {
          removedEvents.push(ev);
          affectedTables.add(key);
        } else {
          kept.push(ev);
        }
      }
      this.eventLog.set(key, kept);
    }

    // Remove stale block hashes
    for (const [height] of this.blockHashes) {
      if (BigInt(height) >= forkBlock) {
        this.blockHashes.delete(height);
      }
    }

    // Rebuild affected tables from remaining events
    for (const key of affectedTables) {
      this.tables.delete(key);
      const log = this.eventLog.get(key) ?? [];
      for (const ev of log) {
        // Re-apply without re-logging or notifying
        this.applyEventSilent(ev);
      }
    }

    // Apply new canonical events
    for (const ev of newEvents) {
      this.applyEvent(ev);
    }

    return {
      depth: removedEvents.length,
      removedEvents,
      replayedEvents: newEvents,
      detectedAtBlock: forkBlock,
    };
  }

  /**
   * Detect if a block hash changed (potential reorg indicator).
   */
  detectReorg(blockNumber: bigint, blockHash: `0x${string}`): boolean {
    const stored = this.blockHashes.get(blockNumber.toString());
    return stored !== undefined && stored !== blockHash;
  }

  /**
   * Mark events below a certain depth as confirmed (finalized).
   */
  confirmEvents(currentBlock: bigint): number {
    let confirmed = 0;
    const threshold = currentBlock - BigInt(this.confirmationDepth);

    for (const [, log] of this.eventLog) {
      for (const ev of log) {
        if (!ev.confirmed && ev.blockNumber <= threshold) {
          ev.confirmed = true;
          confirmed++;
        }
      }
    }
    return confirmed;
  }

  // ═══════════════════════════════════════════════════════════
  //  PRIVATE — Event handlers (replace Go GameState methods)
  // ═══════════════════════════════════════════════════════════

  // Replaces Go: NewGameState() + initial table setup
  private applyTableCreated(args: Record<string, unknown>): void {
    const tableId = args.tableId as bigint;
    const state: TableState = {
      tableId,
      handId: 0n,
      status: GameStatus.Waiting,
      playerCount: 0,
      dealerIndex: 0,
      activePlayerIndex: 0,
      pot: 0n,
      currentBet: 0n,
      smallBlind: args.smallBlind as bigint,
      bigBlind: args.bigBlind as bigint,
      community: [],
      deckCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
      vrfPending: false,
      saltsCommitted: 0,
      saltsRevealed: 0,
      players: new Map(),
      seats: [],
    };
    this.tables.set(tableId.toString(), state);
  }

  // Replaces Go: GameState.AddPlayer() + Handshake handling
  private applyPlayerJoined(args: Record<string, unknown>): void {
    const t = this.getTableMut(args.tableId as bigint);
    if (!t) return;

    const addr = args.player as `0x${string}`;
    const seat = Number(args.seat);
    const buyIn = args.buyIn as bigint;

    const player: PlayerInfo = {
      address: addr,
      chips: buyIn,
      currentBet: 0n,
      lastAction: PlayerActionType.None,
      isActive: true,
      seatIndex: seat,
      holeCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
      hasRevealed: false,
    };

    t.players.set(addr, player);
    while (t.seats.length <= seat) t.seats.push(null);
    t.seats[seat] = addr;
    t.playerCount = t.players.size;
  }

  // Replaces Go: peer disconnection handling
  private applyPlayerLeft(args: Record<string, unknown>): void {
    const t = this.getTableMut(args.tableId as bigint);
    if (!t) return;

    const addr = args.player as `0x${string}`;
    const player = t.players.get(addr);
    if (player) {
      t.seats[player.seatIndex] = null;
      t.players.delete(addr);
      t.playerCount = t.players.size;
    }
  }

  // Replaces Go: MessageReady
  private applySaltCommitted(args: Record<string, unknown>): void {
    const t = this.getTableMut(args.tableId as bigint);
    if (!t) return;
    t.saltsCommitted++;
  }

  // Replaces Go: start of dealing phase
  private applyDealRequested(args: Record<string, unknown>): void {
    const t = this.getTableMut(args.tableId as bigint);
    if (!t) return;
    t.handId = args.handId as bigint;
    t.vrfPending = true;
  }

  // Replaces Go: MessageEncDeck (encrypted deck distribution)
  private applyHoleCardsCommitted(args: Record<string, unknown>): void {
    const t = this.getTableMut(args.tableId as bigint);
    if (!t) return;

    const addr = args.player as `0x${string}`;
    const player = t.players.get(addr);
    if (player) {
      player.holeCommitment = args.commitment as `0x${string}`;
    }
    t.vrfPending = false;
  }

  // Replaces Go: GameState.SetStatus() + GameState.AdvanceStatus()
  private applyStatusChanged(args: Record<string, unknown>): void {
    const t = this.getTableMut(args.tableId as bigint);
    if (!t) return;

    t.status = Number(args.to) as GameStatus;

    // Reset per-round state on phase transition
    if (t.status === GameStatus.Settled) {
      t.community = [];
      t.saltsCommitted = 0;
      t.saltsRevealed = 0;
      for (const p of t.players.values()) {
        p.holeCommitment = '0x0000000000000000000000000000000000000000000000000000000000000000';
        p.hasRevealed = false;
        p.revealedCards = undefined;
        p.handRank = undefined;
      }
    }
  }

  // Replaces Go: GameState.HandlePlayerAction()
  private applyPlayerActed(args: Record<string, unknown>): void {
    const t = this.getTableMut(args.tableId as bigint);
    if (!t) return;

    const addr = args.player as `0x${string}`;
    const action = Number(args.action) as PlayerActionType;
    const value = args.value as bigint;
    const player = t.players.get(addr);
    if (!player) return;

    player.lastAction = action;

    switch (action) {
      case PlayerActionType.Fold:
        player.isActive = false;
        break;
      case PlayerActionType.Call: {
        const toCall = t.currentBet - player.currentBet;
        player.chips -= toCall;
        player.currentBet += toCall;
        t.pot += toCall;
        break;
      }
      case PlayerActionType.Bet:
      case PlayerActionType.Raise: {
        const additional = value - player.currentBet;
        player.chips -= additional;
        player.currentBet = value;
        t.currentBet = value;
        t.pot += additional;
        break;
      }
      case PlayerActionType.AllIn: {
        const allIn = player.chips;
        player.currentBet += allIn;
        if (player.currentBet > t.currentBet) t.currentBet = player.currentBet;
        t.pot += allIn;
        player.chips = 0n;
        break;
      }
    }
  }

  // Replaces Go: (no equivalent — auto-fold is new)
  private applyPlayerTimedOut(args: Record<string, unknown>): void {
    const t = this.getTableMut(args.tableId as bigint);
    if (!t) return;
    const player = t.players.get(args.player as `0x${string}`);
    if (player) {
      player.isActive = false;
      player.lastAction = PlayerActionType.Fold;
    }
  }

  // Replaces Go: community card distribution (was part of EncDeck)
  private applyCommunityRevealed(args: Record<string, unknown>): void {
    const t = this.getTableMut(args.tableId as bigint);
    if (!t) return;

    const cardsRaw = args.cards as readonly number[];
    const count = Number(args.stage);

    t.community = [];
    for (let i = 0; i < count; i++) {
      if (cardsRaw[i] !== 0) {
        t.community.push(decodeCard(cardsRaw[i]));
      }
    }
  }

  // Replaces Go: (no equivalent — showdown reveal is new)
  private applyHoleCardsRevealed(args: Record<string, unknown>): void {
    const t = this.getTableMut(args.tableId as bigint);
    if (!t) return;

    const addr = args.player as `0x${string}`;
    const player = t.players.get(addr);
    if (player) {
      player.hasRevealed = true;
      player.revealedCards = [
        decodeCard(Number(args.card0)),
        decodeCard(Number(args.card1)),
      ];
    }
    t.saltsRevealed++;
  }

  // Replaces Go: pot distribution (was manual in Go)
  private applyShowdownResult(args: Record<string, unknown>): void {
    const t = this.getTableMut(args.tableId as bigint);
    if (!t) return;

    const winner = args.winner as `0x${string}`;
    const payout = args.payout as bigint;
    const player = t.players.get(winner);
    if (player) {
      player.chips += payout;
      player.handRank = Number(args.winningRank);
    }
    t.pot = 0n;
  }

  // ─── Helpers ───

  private getTableMut(tableId: bigint): TableState | undefined {
    return this.tables.get(tableId.toString());
  }

  private applyEventSilent(event: IndexedEvent): void {
    const args = event.args;
    switch (event.eventName) {
      case 'TableCreated': this.applyTableCreated(args); break;
      case 'PlayerJoined': this.applyPlayerJoined(args); break;
      case 'PlayerLeft': this.applyPlayerLeft(args); break;
      case 'SaltCommitted': this.applySaltCommitted(args); break;
      case 'DealRequested': this.applyDealRequested(args); break;
      case 'HoleCardsCommitted': this.applyHoleCardsCommitted(args); break;
      case 'StatusChanged': this.applyStatusChanged(args); break;
      case 'PlayerActed': this.applyPlayerActed(args); break;
      case 'PlayerTimedOut': this.applyPlayerTimedOut(args); break;
      case 'CommunityRevealed': this.applyCommunityRevealed(args); break;
      case 'HoleCardsRevealed': this.applyHoleCardsRevealed(args); break;
      case 'ShowdownResult': this.applyShowdownResult(args); break;
    }
  }
}
