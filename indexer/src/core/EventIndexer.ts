/**
 * core/EventIndexer.ts
 *
 * Replaces the ENTIRE Go p2p/ package:
 *
 *   Go: p2p.Server.Start()          → EventIndexer.start()
 *   Go: p2p.TCPTransport.listen()   → viem WebSocket watchContractEvent()
 *   Go: p2p.Server.Connect(addr)    → (not needed — blockchain is the network)
 *   Go: p2p.Server.SendTo()         → (write via walletClient.writeContract)
 *   Go: p2p.Server.Broadcast()      → (events are inherently broadcast)
 *   Go: p2p.msgCh (inbound msgs)    → onLogs callback from WS subscription
 *   Go: p2p.broadCh (outbound msgs) → emitted events (automatic broadcast)
 *   Go: sync.RWMutex                → (not needed — single-threaded)
 *   Go: encoding/gob                → ABI encoding (handled by viem)
 *   Go: net.Conn + Peer tracking    → (blockchain handles peer identity)
 *
 * REORG SAFETY:
 *   Optimistic rollups (Minitia L2) can experience block reverts during
 *   fraud proof disputes. This indexer handles reorgs by:
 *     1. Tracking block hashes at each height
 *     2. Detecting hash mismatches on new blocks
 *     3. Replaying events from the fork point
 *     4. Marking events as "confirmed" only after CONFIRMATION_DEPTH blocks
 *
 *   The confirmation depth is configurable:
 *     - Local devnet: 1 block (fast, minimal reorg risk)
 *     - Testnet: 3 blocks
 *     - Mainnet: 10+ blocks (L2 finality depends on L1 settlement)
 */

import {
  createPublicClient, createWalletClient, webSocket, http,
  type PublicClient, type WalletClient, type Log, type Address,
  type WatchContractEventReturnType, parseAbiItem, getAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { POKER_GAME_ABI } from '../types/abi.js';
import { GameStateManager } from './GameStateManager.js';
import { IndexedEvent, GameStatus } from '../types/game.js';

// ─── Configuration ───

export interface IndexerConfig {
  /** WebSocket RPC endpoint (from MINITIA_ENV.md) */
  wsUrl: string;
  /** HTTP RPC endpoint (fallback + initial hydration) */
  httpUrl: string;
  /** Deployed PokerGame contract address */
  contractAddress: Address;
  /** Blocks before an event is considered confirmed */
  confirmationDepth: number;
  /** Private key for sending transactions (optional — indexer can be read-only) */
  privateKey?: `0x${string}`;
  /** Table IDs to subscribe to (empty = all tables) */
  tableFilter?: bigint[];
  /** Block to start indexing from (0 = latest) */
  fromBlock?: bigint;
}

// ─── Event Names (matching Solidity event signatures) ───

const EVENT_NAMES = [
  'TableCreated', 'PlayerJoined', 'PlayerLeft', 'SaltCommitted',
  'DealRequested', 'HoleCardsCommitted', 'StatusChanged',
  'PlayerActed', 'PlayerTimedOut', 'CommunityRevealed',
  'HoleCardsRevealed', 'ShowdownResult',
] as const;

// ═══════════════════════════════════════════════════════════════
//  MAIN INDEXER CLASS
// ═══════════════════════════════════════════════════════════════

export class EventIndexer {
  private config: IndexerConfig;
  private wsClient!: PublicClient;
  private httpClient!: PublicClient;
  private walletClient?: WalletClient;
  private stateManager: GameStateManager;

  /** Active WebSocket subscriptions (for cleanup) */
  private subscriptions: WatchContractEventReturnType[] = [];

  /** Last processed block for gap detection */
  private lastProcessedBlock = 0n;

  /** Running flag */
  private running = false;

  /** Confirmation check interval */
  private confirmInterval?: ReturnType<typeof setInterval>;

  /** Reconnection state */
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000; // ms, doubles each attempt

  constructor(config: IndexerConfig) {
    this.config = config;
    this.stateManager = new GameStateManager(config.confirmationDepth);
  }

  // ═══════════════════════════════════════════════════════════
  //  LIFECYCLE (replaces Go Server.Start())
  // ═══════════════════════════════════════════════════════════

  /**
   * Start the indexer — connects WebSocket, hydrates state, subscribes.
   *
   * In Go, this was:
   *   server := p2p.NewServer(cfg)
   *   go server.Start()        ← TCP listener
   *   server.Connect(":4000")  ← peer connection
   *
   * Now: single WebSocket to the L2 node replaces all P2P networking.
   */
  async start(): Promise<void> {
    console.log('┌──────────────────────────────────────────────┐');
    console.log('│  EventIndexer starting...                    │');
    console.log('│  Replaces: p2p.Server + TCPTransport + Gob   │');
    console.log('└──────────────────────────────────────────────┘');

    // Create viem clients
    this.httpClient = createPublicClient({ transport: http(this.config.httpUrl) });

    await this.connectWebSocket();

    // Optional: create wallet client for sending transactions
    if (this.config.privateKey) {
      const account = privateKeyToAccount(this.config.privateKey);
      this.walletClient = createWalletClient({
        account,
        transport: http(this.config.httpUrl),
      });
      console.log(`  Wallet: ${account.address}`);
    }

    // ── Phase 1: Hydrate from historical events ──
    await this.hydrateFromHistory();

    // ── Phase 2: Subscribe to live events via WebSocket ──
    await this.subscribeToEvents();

    // ── Phase 3: Start confirmation checker ──
    this.startConfirmationChecker();

    this.running = true;
    console.log('  EventIndexer running. Listening for on-chain events...');
  }

  async stop(): Promise<void> {
    this.running = false;

    // Unsubscribe all watchers
    for (const unsub of this.subscriptions) {
      unsub();
    }
    this.subscriptions = [];

    if (this.confirmInterval) {
      clearInterval(this.confirmInterval);
    }

    console.log('  EventIndexer stopped.');
  }

  // ═══════════════════════════════════════════════════════════
  //  WEBSOCKET CONNECTION (replaces Go TCPTransport)
  // ═══════════════════════════════════════════════════════════

  private async connectWebSocket(): Promise<void> {
    const transport = webSocket(this.config.wsUrl, {
      reconnect: true,
      retryCount: this.maxReconnectAttempts,
      retryDelay: ({ count }) => Math.min(1000 * 2 ** count, 30000),
    });

    this.wsClient = createPublicClient({ transport });

    // Verify connection
    const chainId = await this.wsClient.getChainId();
    const blockNumber = await this.wsClient.getBlockNumber();

    console.log(`  Connected to chain ${chainId} at block ${blockNumber}`);
    console.log(`  WS: ${this.config.wsUrl}`);
    console.log(`  Contract: ${this.config.contractAddress}`);
    console.log(`  Confirmation depth: ${this.config.confirmationDepth} blocks`);

    this.lastProcessedBlock = blockNumber;
    this.reconnectAttempts = 0;
  }

  // ═══════════════════════════════════════════════════════════
  //  HISTORICAL HYDRATION (replaces Go peer discovery + state sync)
  // ═══════════════════════════════════════════════════════════

  /**
   * Fetch all past events to rebuild state from genesis.
   *
   * In Go: new peers would Handshake, exchange PeerList, sync GameState.
   * Now: getLogs() from contract deployment block gives full history.
   */
  private async hydrateFromHistory(): Promise<void> {
    const fromBlock = this.config.fromBlock ?? 0n;

    console.log(`  Hydrating from block ${fromBlock}...`);

    const logs = await this.httpClient.getContractEvents({
      address: this.config.contractAddress,
      abi: POKER_GAME_ABI,
      fromBlock,
      toBlock: 'latest',
    });

    console.log(`  Found ${logs.length} historical events`);

    // Sort by block number, then log index (deterministic ordering)
    const sorted = [...logs].sort((a, b) => {
      const blockDiff = Number(a.blockNumber! - b.blockNumber!);
      if (blockDiff !== 0) return blockDiff;
      return a.logIndex! - b.logIndex!;
    });

    for (const log of sorted) {
      const event = this.logToIndexedEvent(log);
      if (event) {
        event.confirmed = true; // historical events are already confirmed
        this.stateManager.applyEvent(event);
      }
    }

    const tables = this.stateManager.getAllTables();
    console.log(`  Hydrated ${tables.length} table(s)`);

    for (const t of tables) {
      console.log(
        `    Table #${t.tableId}: ${GameStatus[t.status]}, ` +
        `${t.playerCount} players, pot=${t.pot}`
      );
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  LIVE EVENT SUBSCRIPTION (replaces Go msgCh + broadCh)
  // ═══════════════════════════════════════════════════════════

  /**
   * Subscribe to live contract events via WebSocket.
   *
   * In Go: Server.Start() spawned goroutines reading from msgCh.
   *         Each message type had a handler in a switch statement.
   *         Outbound messages were sent via broadCh → Broadcast().
   *
   * Now: viem's watchContractEvent subscribes to eth_subscribe("logs").
   *      Each log is decoded by ABI and routed to GameStateManager.
   *      No need for outbound broadcast — events ARE the broadcast.
   */
  private async subscribeToEvents(): Promise<void> {
    // Build topic filter for specific tables if configured
    const tableFilter = this.config.tableFilter;

    for (const eventName of EVENT_NAMES) {
      const abiEvent = POKER_GAME_ABI.find(
        (item) => item.type === 'event' && item.name === eventName
      );
      if (!abiEvent) continue;

      const unwatch = this.wsClient.watchContractEvent({
        address: this.config.contractAddress,
        abi: POKER_GAME_ABI,
        eventName,
        onLogs: (logs) => {
          for (const log of logs) {
            // Optional table filter
            if (tableFilter && tableFilter.length > 0) {
              const tableId = (log.args as Record<string, unknown>)?.tableId as bigint;
              if (tableId !== undefined && !tableFilter.includes(tableId)) continue;
            }

            this.handleLiveLog(log);
          }
        },
        onError: (error) => {
          console.error(`  WS subscription error [${eventName}]:`, error.message);
          this.handleSubscriptionError(error);
        },
      });

      this.subscriptions.push(unwatch);
    }

    console.log(`  Subscribed to ${EVENT_NAMES.length} event types`);
  }

  /**
   * Process a single live log from the WebSocket subscription.
   * Includes reorg detection before applying to state.
   */
  private handleLiveLog(log: Log): void {
    const event = this.logToIndexedEvent(log);
    if (!event) return;

    // ── Reorg detection ──
    // If we've seen this block number before with a different hash,
    // a reorg has occurred.
    if (this.stateManager.detectReorg(event.blockNumber, event.blockHash)) {
      console.warn(
        `  ⚠ REORG detected at block ${event.blockNumber}! ` +
        `Rebuilding state from fork point...`
      );

      // Fetch canonical events from the fork block
      this.rebuildFromReorg(event.blockNumber).catch((err) => {
        console.error('  Reorg recovery failed:', err);
      });
      return;
    }

    // ── Gap detection ──
    // If we skipped blocks, we might have missed events
    if (event.blockNumber > this.lastProcessedBlock + 1n) {
      console.warn(
        `  Gap detected: blocks ${this.lastProcessedBlock + 1n}..${event.blockNumber - 1n}. ` +
        `Backfilling...`
      );
      this.backfillGap(this.lastProcessedBlock + 1n, event.blockNumber - 1n)
        .catch((err) => console.error('  Backfill failed:', err));
    }

    // Apply the event
    this.stateManager.applyEvent(event);
    this.lastProcessedBlock = event.blockNumber;

    // Log to console (replaces Go's message handling print statements)
    this.logEvent(event);
  }

  // ═══════════════════════════════════════════════════════════
  //  REORG RECOVERY
  // ═══════════════════════════════════════════════════════════

  private async rebuildFromReorg(forkBlock: bigint): Promise<void> {
    // Fetch new canonical events from the fork point
    const newLogs = await this.httpClient.getContractEvents({
      address: this.config.contractAddress,
      abi: POKER_GAME_ABI,
      fromBlock: forkBlock,
      toBlock: 'latest',
    });

    const newEvents = newLogs
      .map((log) => this.logToIndexedEvent(log))
      .filter((e): e is IndexedEvent => e !== null);

    const reorgInfo = this.stateManager.handleReorg(forkBlock, newEvents);

    console.log(
      `  Reorg resolved: removed ${reorgInfo.removedEvents.length} events, ` +
      `replayed ${reorgInfo.replayedEvents.length} events`
    );
  }

  private async backfillGap(from: bigint, to: bigint): Promise<void> {
    const logs = await this.httpClient.getContractEvents({
      address: this.config.contractAddress,
      abi: POKER_GAME_ABI,
      fromBlock: from,
      toBlock: to,
    });

    for (const log of logs) {
      const event = this.logToIndexedEvent(log);
      if (event) this.stateManager.applyEvent(event);
    }

    if (logs.length > 0) {
      console.log(`  Backfilled ${logs.length} events from blocks ${from}-${to}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  CONFIRMATION CHECKER
  // ═══════════════════════════════════════════════════════════

  /**
   * Periodically mark events as confirmed once they're deep enough.
   * This replaces the trust assumptions of Go's P2P gossip —
   * on-chain finality is mathematically guaranteed.
   */
  private startConfirmationChecker(): void {
    this.confirmInterval = setInterval(async () => {
      try {
        const current = await this.httpClient.getBlockNumber();
        const confirmed = this.stateManager.confirmEvents(current);
        if (confirmed > 0) {
          console.log(`  Confirmed ${confirmed} events at block ${current}`);
        }
      } catch {
        // Silently retry on next interval
      }
    }, 5000); // Check every 5 seconds
  }

  // ═══════════════════════════════════════════════════════════
  //  LOG CONVERSION
  // ═══════════════════════════════════════════════════════════

  private logToIndexedEvent(log: Log | Record<string, unknown>): IndexedEvent | null {
    const l = log as Record<string, unknown>;
    const eventName = l.eventName as string;
    if (!eventName) return null;

    return {
      eventName,
      blockNumber: l.blockNumber as bigint,
      blockHash: l.blockHash as `0x${string}`,
      transactionHash: l.transactionHash as `0x${string}`,
      logIndex: Number(l.logIndex ?? 0),
      args: (l.args ?? {}) as Record<string, unknown>,
      confirmed: false,
      timestamp: Date.now(),
    };
  }

  // ═══════════════════════════════════════════════════════════
  //  CONSOLE LOGGING (replaces Go fmt.Printf in handlers)
  // ═══════════════════════════════════════════════════════════

  private logEvent(event: IndexedEvent): void {
    const a = event.args;
    const tag = event.confirmed ? '✓' : '○';
    const block = event.blockNumber;

    switch (event.eventName) {
      case 'PlayerJoined':
        console.log(`  ${tag} [${block}] PlayerJoined: ${shortAddr(a.player)} → table #${a.tableId} (seat ${a.seat})`);
        break;
      case 'PlayerActed':
        console.log(`  ${tag} [${block}] PlayerActed: ${shortAddr(a.player)} → ${actionName(Number(a.action))} ${a.value}`);
        break;
      case 'StatusChanged':
        console.log(`  ${tag} [${block}] StatusChanged: table #${a.tableId} ${GameStatus[Number(a.from)]} → ${GameStatus[Number(a.to)]}`);
        break;
      case 'HoleCardsCommitted':
        console.log(`  ${tag} [${block}] HoleCardsCommitted: ${shortAddr(a.player)} → ${shortHash(a.commitment as string)}`);
        break;
      case 'HoleCardsRevealed':
        console.log(`  ${tag} [${block}] HoleCardsRevealed: ${shortAddr(a.player)} → cards [${a.card0}, ${a.card1}]`);
        break;
      case 'CommunityRevealed':
        console.log(`  ${tag} [${block}] CommunityRevealed: stage=${a.stage}`);
        break;
      case 'ShowdownResult':
        console.log(`  ${tag} [${block}] ShowdownResult: winner=${shortAddr(a.winner)} payout=${a.payout}`);
        break;
      case 'PlayerTimedOut':
        console.log(`  ${tag} [${block}] PlayerTimedOut: ${shortAddr(a.player)}`);
        break;
      default:
        console.log(`  ${tag} [${block}] ${event.eventName}`);
    }
  }

  private handleSubscriptionError(error: Error): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('  Max reconnect attempts reached. Stopping.');
      this.stop();
      return;
    }
    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectDelay * 2 ** this.reconnectAttempts, 30000);
    console.log(`  Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);
    setTimeout(() => this.subscribeToEvents(), delay);
  }

  // ═══════════════════════════════════════════════════════════
  //  PUBLIC ACCESSORS
  // ═══════════════════════════════════════════════════════════

  get state(): GameStateManager { return this.stateManager; }
  get isRunning(): boolean { return this.running; }
}

// ─── Utility functions ───

function shortAddr(addr: unknown): string {
  const s = String(addr);
  return s.length > 10 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

function shortHash(hash: string): string {
  return hash.length > 10 ? `${hash.slice(0, 10)}…` : hash;
}

function actionName(action: number): string {
  return ['None', 'Fold', 'Check', 'Bet', 'Call', 'Raise', 'AllIn'][action] ?? '?';
}
