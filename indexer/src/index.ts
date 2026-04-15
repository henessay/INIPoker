/**
 * index.ts — Main entry point for the GGPoker Event Indexer
 *
 * This single file replaces the ENTIRE Go main.go + p2p/ package:
 *
 *   Go main.go:
 *     node1 := makeServerAndStart(":3000")           ← TCP server
 *     node2 := makeServerAndStart(":4000", ":3000")  ← TCP connect
 *     _ = makeServerAndStart(":5000", ":4000")        ← mesh expansion
 *     select {}                                        ← block forever
 *
 *   TypeScript:
 *     const indexer = new EventIndexer(config);       ← WebSocket client
 *     await indexer.start();                           ← subscribe to events
 *     // No peer management. No TCP. No mesh.
 *     // The blockchain IS the communication layer.
 *
 * Environment variables (from MINITIA_ENV.md):
 *   WS_URL=ws://localhost:8546
 *   RPC_URL=http://localhost:8545
 *   POKER_GAME_ADDRESS=<deployed contract>
 *   CONFIRMATION_DEPTH=3
 */

import { EventIndexer, IndexerConfig } from './core/EventIndexer.js';
import { GameStatus, cardName } from './types/game.js';

// ─── Load configuration from environment (or defaults from MINITIA_ENV.md) ───

const config: IndexerConfig = {
  wsUrl:             process.env.WS_URL              ?? 'ws://localhost:8546',
  httpUrl:           process.env.RPC_URL              ?? 'http://localhost:8545',
  contractAddress:   (process.env.POKER_GAME_ADDRESS  ?? '0x0000000000000000000000000000000000000000') as `0x${string}`,
  confirmationDepth: Number(process.env.CONFIRMATION_DEPTH ?? '3'),
  privateKey:        process.env.PRIVATE_KEY as `0x${string}` | undefined,
  tableFilter:       process.env.TABLE_ID ? [BigInt(process.env.TABLE_ID)] : undefined,
  fromBlock:         process.env.FROM_BLOCK ? BigInt(process.env.FROM_BLOCK) : 0n,
};

// ─── Main ───

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  GGPoker Event Indexer — Minitia L2                        ║');
  console.log('║  Replaces: p2p.Server + TCPTransport + Gob + sync.RWMutex ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  // Validate contract address
  if (config.contractAddress === '0x0000000000000000000000000000000000000000') {
    console.error('  POKER_GAME_ADDRESS not set. Run deploy.sh first.');
    console.error('  Export from MINITIA_ENV.md or .env');
    process.exit(1);
  }

  const indexer = new EventIndexer(config);

  // ── Register state change listener (replaces Go broadCh consumer) ──
  //
  // In Go, the game state was consumed via:
  //   for msg := range s.broadCh {
  //       s.SendTo(msg.To, msg.Payload)
  //   }
  //
  // Now: callback receives the confirmed event and the updated state.
  // The client UI or game logic hooks into this.

  indexer.state.onStateChange((tableId, event, state) => {
    // Example: log key state transitions
    if (event.eventName === 'StatusChanged') {
      const status = GameStatus[state.status];
      console.log(`\n  ═══ Table #${tableId} → ${status} ═══`);
      console.log(`    Players: ${state.playerCount}`);
      console.log(`    Pot:     ${state.pot} wei`);

      if (state.community.length > 0) {
        const communityStr = state.community.map(c => cardName(c)).join(' ');
        console.log(`    Board:   ${communityStr}`);
      }

      // Show player states
      for (const [addr, p] of state.players) {
        const status = p.isActive ? 'active' : 'folded';
        const cards = p.revealedCards
          ? `[${cardName(p.revealedCards[0])} ${cardName(p.revealedCards[1])}]`
          : `[hidden: ${p.holeCommitment.slice(0, 10)}…]`;
        console.log(`    Seat ${p.seatIndex}: ${addr.slice(0, 8)}… ${status} chips=${p.chips} ${cards}`);
      }
    }

    if (event.eventName === 'ShowdownResult') {
      const winner = event.args.winner as string;
      const payout = event.args.payout as bigint;
      console.log(`\n  🏆 Winner: ${winner.slice(0, 10)}… — Payout: ${payout} wei`);
    }
  });

  // ── Start the indexer ──
  await indexer.start();

  // ── Graceful shutdown ──
  const shutdown = async () => {
    console.log('\n  Shutting down...');
    await indexer.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep alive (replaces Go's select{})
  await new Promise(() => {});
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
