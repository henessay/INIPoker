/**
 * components/PokerTable.tsx — On-chain poker table with autosign UX
 *
 * POLYMARKET-STYLE FUND FLOW:
 *   1. Player deposits INIT into contract    → deposit() payable
 *   2. Player joins table from game balance  → joinTable(tableId, buyIn)
 *   3. All poker actions auto-sign           → playerAction() fires instantly
 *   4. Player leaves table → INIT returns    → leaveTable() → game balance
 *   5. Player withdraws to wallet            → withdraw(amount)
 *
 * AUTOSIGN ARCHITECTURE:
 *   Traditional Web3 poker: every Fold/Call/Raise → MetaMask popup → wait → confirm
 *   With autosign:          Fold/Call/Raise → instant tx → zero popups
 *
 *   The ghost wallet can ONLY call contract functions (MsgCall).
 *   It CANNOT send direct token transfers — those still need manual approval.
 */

'use client'

import { useState, useCallback } from 'react'
import { formatEther, parseEther, keccak256, toHex } from 'viem'
import {
  useAccount,
  useReadContract,
  useWriteContract,
} from 'wagmi'
import { useInterwovenKit } from '@initia/interwovenkit-react'
import { POKER_GAME_ADDRESS, POKER_GAME_ABI } from '../config/contract'
import { COSMOS_CHAIN_ID } from '../config/chain'
import CashierModal from './CashierModal'
import { useWalletBalance } from '../hooks/useWalletBalance'

// ── Game constants ──
const STATUS_LABELS = ['Waiting', 'Dealing', 'Pre-Flop', 'Flop', 'Turn', 'River', 'Showdown', 'Settled'] as const
const ACTION_LABELS = ['None', 'Fold', 'Check', 'Bet', 'Call', 'Raise', 'All-In'] as const
const SUITS = ['♠', '♥', '♦', '♣'] as const
const SUIT_COLORS = ['#c8d6e5', '#e74c3c', '#3498db', '#2ecc71'] as const
const VALUES = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const

// ── Card component ──
function Card({ encoded }: { encoded: number }) {
  if (!encoded) return <span style={s.cardBack}>?</span>
  const suit = encoded >> 4
  const value = encoded & 0x0f
  return (
    <span style={{ ...s.card, color: SUIT_COLORS[suit] }}>
      {VALUES[value]}{SUITS[suit]}
    </span>
  )
}

// ══════════════════════════════════════════════════════════
//  MAIN COMPONENT
// ══════════════════════════════════════════════════════════

export default function PokerTable({ tableId = 0n, onBack }: { tableId?: bigint, onBack?: () => void }) {
  const { address, isConnected } = useAccount()
  const { username, openConnect, openWallet, autoSign } = useInterwovenKit()
  const { writeContractAsync, isPending: txPending } = useWriteContract()

  // ── Local UI state ──
  const [betAmount, setBetAmount] = useState('')
  const [sessionActive, setSessionActive] = useState(false)
  const [lastTxHash, setLastTxHash] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cashierOpen, setCashierOpen] = useState(false)

  // ── Wallet + game balances (live from chain) ──
  const { walletBalance, gameBalance, isLoading: balLoading, refetch: refetchBal } = useWalletBalance(tableId)

  // ── On-chain reads (disabled when contract not deployed) ──
  const hasContract = POKER_GAME_ADDRESS !== '0x0000000000000000000000000000000000000000'
  const { data: session, refetch: refetchSession } = useReadContract({
    address: POKER_GAME_ADDRESS, abi: POKER_GAME_ABI,
    functionName: 'getSession', args: [tableId],
    query: { enabled: hasContract },
  })
  const { data: players } = useReadContract({
    address: POKER_GAME_ADDRESS, abi: POKER_GAME_ABI,
    functionName: 'getPlayers', args: [tableId],
    query: { enabled: hasContract },
  })
  const { data: communityRaw } = useReadContract({
    address: POKER_GAME_ADDRESS, abi: POKER_GAME_ABI,
    functionName: 'getCommunityCards', args: [tableId],
    query: { enabled: hasContract },
  })
  const { data: myState } = useReadContract({
    address: POKER_GAME_ADDRESS, abi: POKER_GAME_ABI,
    functionName: 'getPlayerState', args: [tableId, address!],
    query: { enabled: hasContract && !!address },
  })
  const { data: totalTables } = useReadContract({
    address: POKER_GAME_ADDRESS, abi: POKER_GAME_ABI,
    functionName: 'tableCount',
    query: { enabled: hasContract },
  })

  // ── Derived values ──
  const status = session ? Number(session[1]) : 0
  const playerCount = session ? Number(session[2]) : 0
  const pot = session ? session[4] : 0n
  const currentBet = session ? session[5] : 0n
  const communityCount = session ? Number(session[7]) : 0
  const vrfPending = session ? session[8] : false
  const saltsCommitted = session ? Number(session[9]) : 0
  const isZeroAddr = POKER_GAME_ADDRESS === '0x0000000000000000000000000000000000000000'
  const community = communityRaw
    ? (communityRaw as readonly number[]).filter((_, i) => i < communityCount)
    : []
  const isSeated = myState ? Boolean(myState[3]) : false
  const myStake = myState ? myState[0] as bigint : 0n
  const myBet = myState ? myState[1] as bigint : 0n
  const myLastAction = myState ? Number(myState[2]) : 0
  const isActive = myState ? Boolean(myState[3]) : false
  const isAutoSignReady = false
  const truncAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

  // ══════════════════════════════════════════════════════════
  //  AUTOSIGN SESSION MANAGEMENT
  // ══════════════════════════════════════════════════════════

  /**
   * Start a game session — enables autosign ghost wallet.
   * After this ONE confirmation, all Fold/Call/Raise fire instantly.
   */
  const startSession = useCallback(async () => {
    setError(null)
    try {
      await autoSign.enable()
      setSessionActive(true)
    } catch (err: any) {
      setError(`Session start failed: ${err.message}`)
    }
  }, [autoSign])

  /**
   * End the game session — disables autosign.
   * Future contract calls will require manual wallet approval again.
   */
  const endSession = useCallback(async () => {
    try {
      await autoSign.disable()
      setSessionActive(false)
    } catch (err: any) {
      setError(`Session end failed: ${err.message}`)
    }
  }, [autoSign])

  // ══════════════════════════════════════════════════════════
  //  GAME ACTIONS (auto-signed — zero popups during session)
  // ══════════════════════════════════════════════════════════

  const ensureChain = async () => {
    // Chain switching handled by InterwovenKit
  }

  /** Contract write wrapper — catches errors, stores tx hash */
  const exec = async (fn: string, args: unknown[], value?: bigint) => {
    setError(null)
    try {
      await ensureChain()
      const hash = await writeContractAsync({
        address: POKER_GAME_ADDRESS,
        abi: POKER_GAME_ABI,
        functionName: fn,
        args,
        gas: 500000n,
        gasPrice: 1000000000n,
        ...(value ? { value } : {}),
      } as any)
      setLastTxHash(hash)
      setTimeout(() => { refetchSession(); refetchBal() }, 2000)
      return hash
    } catch (err: any) {
      setError(err.shortMessage ?? err.message)
    }
  }

  // ── Join: deducts from internal game balance ──
  const joinTable = () => exec('joinTable', [tableId, parseEther('10')])

  // ── Leave ──
  const leaveTable = () => exec('leaveTable', [tableId])

  // ── Commit salt (generate random salt client-side) ──
  const commitSalt = async () => {
    const salt = crypto.getRandomValues(new Uint8Array(32))
    const saltHex = toHex(salt)
    const saltHash = keccak256(saltHex as `0x${string}`)
    // Store salt in sessionStorage for later reveal
    sessionStorage.setItem(`salt_${tableId}`, saltHex)
    return exec('commitSalt', [tableId, saltHash])
  }

  // ── Request deal ──
  const requestDeal = () => exec('requestDeal', [tableId])

  // ── Player actions (these fire INSTANTLY with autosign active) ──
  const fold  = () => exec('playerAction', [tableId, 1, 0n])
  const check = () => exec('playerAction', [tableId, 2, 0n])
  const call  = () => exec('playerAction', [tableId, 4, 0n])
  const bet   = () => {
    const amt = parseEther(betAmount || '0')
    return exec('playerAction', [tableId, 3, amt])
  }
  const raise = () => {
    const amt = parseEther(betAmount || '0')
    return exec('playerAction', [tableId, 5, amt])
  }
  const allIn = () => exec('playerAction', [tableId, 6, 0n])

  // ── Reveal hole cards at showdown ──
  const revealCards = () => {
    const salt = sessionStorage.getItem(`salt_${tableId}`)
    if (!salt) { setError('Salt not found — did you commit?'); return }
    return exec('revealHoleCards', [tableId, salt as `0x${string}`])
  }

  // ── Evaluate showdown ──
  const evaluateShowdown = () => exec('evaluateShowdown', [tableId])

  // ══════════════════════════════════════════════════════════
  //  RENDER
  // ══════════════════════════════════════════════════════════

  return (
    <div style={s.root}>

      {/* ── HEADER ── */}
      <header style={s.header}>
        <div style={s.brand}>
          {onBack && (
            <button onClick={onBack} style={s.btnBack}>← Lobby</button>
          )}
          <span style={s.brandIcon}>♠♥♦♣</span>
          <h1 style={s.title}>INIPoker</h1>
          <span style={s.badge}>Minitia L2</span>
          {isAutoSignReady && <span style={s.autosignBadge}>Autosign ON</span>}
        </div>
        <div style={s.headerRight}>
          {isConnected && (
            <button onClick={() => setCashierOpen(true)} style={s.btnCashier}>
              💰 Cashier
            </button>
          )}
          {isConnected ? (
            <button onClick={openWallet} style={s.btnPrimary}>
              {username ?? truncAddr(address!)}
            </button>
          ) : (
            <button onClick={openConnect} style={s.btnPrimary}>Connect Wallet</button>
          )}
        </div>
      </header>

      {/* ── STATUS STRIP ── */}
      <div style={s.strip}>
        <span style={{ ...s.dot, background: isConnected ? '#2ecc71' : '#e74c3c' }} />
        <span style={s.dim}>{isConnected ? 'Initia Testnet' : 'Disconnected'}</span>
        {isConnected && <span style={s.balVal}>Wallet: {balLoading ? '…' : `${walletBalance} INIT`}</span>}
        {isConnected && <span style={s.chipVal}>Game: {balLoading ? '…' : `${gameBalance} INIT`}</span>}
        {isSeated && <span style={{color:'#d4af37',fontWeight:600}}>At Table: {formatEther(myStake)} INIT</span>}
        {totalTables !== undefined && <span style={s.dim}>{totalTables.toString()} table(s)</span>}
      </div>

      {/* ── WARNINGS ── */}
      {isZeroAddr && (
        <div style={s.warning}>
          Contract not deployed. Run <code>./deploy.sh all</code> then set <code>VITE_POKER_GAME_ADDRESS</code>.
        </div>
      )}
      {error && <div style={s.errorBar}>{error}</div>}
      {lastTxHash && (
        <div style={s.txBar}>Last tx: <code>{lastTxHash.slice(0, 18)}…</code></div>
      )}

      {/* ── AUTOSIGN SESSION PANEL ── */}
      {isConnected && (
        <div style={s.sessionPanel}>
          {!isAutoSignReady ? (
            <>
              <div style={s.sessionInfo}>
                <strong style={{ color: '#d4af37' }}>Start a game session</strong>
                <span style={s.dim}>
                  Approve once — then Fold, Call, Raise fire instantly with zero popups.
                </span>
              </div>
              <button
                onClick={startSession}
                style={s.btnSession}
                disabled={autoSign?.isLoading}
              >
                {autoSign?.isLoading ? 'Approving…' : 'Enable Autosign'}
              </button>
            </>
          ) : (
            <>
              <div style={s.sessionInfo}>
                <span style={s.sessionActive}>Session active — ghost wallet signing</span>
                <span style={s.dim}>All poker actions auto-sign. No popups.</span>
              </div>
              <button onClick={endSession} style={s.btnSessionEnd}>End Session</button>
            </>
          )}
        </div>
      )}

      {/* ── FELT TABLE ── */}
      <main style={s.felt}>
        <div style={s.tableInfo}>
          <span style={s.tableLabel}>Table #{tableId.toString()}</span>
          <span style={s.statusBadge}>{STATUS_LABELS[status] ?? '?'}</span>
          {vrfPending && <span style={s.vrfBadge}>VRF Pending…</span>}
        </div>

        {/* Pot */}
        <div style={s.potArea}>
          <div style={s.potLabel}>POT</div>
          <div style={s.potValue}>{pot ? `${formatEther(pot as bigint)} INIT` : '—'}</div>
          {currentBet > 0n && (
            <div style={s.betLabel}>Bet to match: {formatEther(currentBet as bigint)} INIT</div>
          )}
        </div>

        {/* Community cards */}
        <div style={s.communityArea}>
          {community.length > 0
            ? community.map((c, i) => <Card key={i} encoded={c} />)
            : <span style={s.emptyBoard}>{status >= 2 ? 'Waiting for flop…' : 'No cards dealt'}</span>
          }
        </div>

        {/* Seats */}
        <div style={s.seatsArea}>
          {playerCount > 0 && players ? (
            (players as readonly `0x${string}`[]).map((p, i) => (
              <div key={i} style={{ ...s.seat, ...(p === address ? s.seatSelf : {}) }}>
                <div style={s.seatIdx}>Seat {i}</div>
                <div style={s.seatAddr}>{p === address ? 'You' : truncAddr(p)}</div>
              </div>
            ))
          ) : (
            <div style={s.emptySeats}>
              {isConnected ? 'Empty table — join now!' : 'Connect wallet to play'}
            </div>
          )}
        </div>
        <div style={s.playerCount}>{playerCount} players seated</div>
      </main>

      {/* ── ACTION BAR ── */}
      {isConnected && (
        <div style={s.actionBar}>

          {/* Phase: Waiting / Settled — Join or Deal */}
          {(status === 0 || status === 7) && !isSeated && (
            <button onClick={joinTable} style={s.btnAction} disabled={txPending}>
              Join (10 INIT)
            </button>
          )}
          {(status === 0 || status === 7) && isSeated && saltsCommitted < playerCount && (
            <button onClick={commitSalt} style={s.btnAction} disabled={txPending}>
              Commit Salt
            </button>
          )}
          {(status === 0 || status === 7) && isSeated && saltsCommitted >= playerCount && playerCount >= 2 && (
            <button onClick={requestDeal} style={s.btnAction} disabled={txPending}>
              Deal Cards
            </button>
          )}

          {/* Phase: Betting (PreFlop–River) — Poker actions */}
          {status >= 2 && status <= 5 && isActive && (
            <>
              <button onClick={fold} style={s.btnFold} disabled={txPending}>Fold</button>
              {currentBet === myBet
                ? <button onClick={check} style={s.btnAction} disabled={txPending}>Check</button>
                : <button onClick={call} style={s.btnAction} disabled={txPending}>Call</button>
              }
              <div style={s.betInput}>
                <input
                  type="text"
                  placeholder="INIT amount"
                  value={betAmount}
                  onChange={e => setBetAmount(e.target.value)}
                  style={s.input}
                />
                <button onClick={currentBet > 0n ? raise : bet} style={s.btnRaise} disabled={txPending}>
                  {currentBet > 0n ? 'Raise' : 'Bet'}
                </button>
              </div>
              <button onClick={allIn} style={s.btnAllIn} disabled={txPending}>All-In</button>
            </>
          )}

          {/* Phase: Showdown — Reveal + Evaluate */}
          {status === 6 && isActive && (
            <>
              <button onClick={revealCards} style={s.btnAction} disabled={txPending}>
                Reveal Cards
              </button>
              <button onClick={evaluateShowdown} style={s.btnAction} disabled={txPending}>
                Evaluate Hands
              </button>
            </>
          )}

          {/* Leave table */}
          {isSeated && (status === 0 || status === 7) && (
            <button onClick={leaveTable} style={s.btnLeave} disabled={txPending}>Leave Table</button>
          )}

          {/* Loading indicator */}
          {txPending && <span style={s.txPending}>Sending tx…</span>}
        </div>
      )}

      {/* ── CASHIER MODAL ── */}
      <CashierModal
        isOpen={cashierOpen}
        onClose={() => setCashierOpen(false)}
        walletBalance={walletBalance}
        gameBalance={gameBalance}
        isLoading={balLoading}
        onRefreshBalances={refetchBal}
      />

      {/* ── FOOTER ── */}
      <footer style={s.footer}>
        <span>INIPoker on Initia</span>
        <span style={s.dim}>Commit-reveal · Band VRF · Autosign · Bitmask eval</span>
      </footer>
    </div>
  )
}

// ══════════════════════════════════════════════════════════
//  STYLES — dark luxury casino
// ══════════════════════════════════════════════════════════

const s: Record<string, React.CSSProperties> = {
  root: {
    minHeight: '100vh', background: '#0a0c10', color: '#e8e6e1',
    fontFamily: '"JetBrains Mono", "Fira Code", monospace',
    display: 'flex', flexDirection: 'column',
  },

  // Header
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '14px 24px', borderBottom: '1px solid rgba(212,175,55,0.15)',
    background: 'linear-gradient(180deg, rgba(10,12,16,1) 0%, rgba(15,18,25,1) 100%)',
  },
  brand: { display: 'flex', alignItems: 'center', gap: '10px' },
  brandIcon: { fontSize: '16px', color: '#d4af37', letterSpacing: '2px' },
  btnBack: {
    background: 'transparent', color: '#6a6a6a', border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '5px', padding: '5px 12px', fontSize: '11px', fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit', marginRight: '4px',
  },
  title: { fontSize: '18px', fontWeight: 700, color: '#d4af37', margin: 0, letterSpacing: '1.5px' },
  badge: {
    fontSize: '9px', fontWeight: 700, color: '#0a0c10', background: '#d4af37',
    padding: '2px 7px', borderRadius: '3px', letterSpacing: '1px', textTransform: 'uppercase' as const,
  },
  autosignBadge: {
    fontSize: '9px', fontWeight: 700, color: '#0a0c10', background: '#2ecc71',
    padding: '2px 7px', borderRadius: '3px', letterSpacing: '0.5px', textTransform: 'uppercase' as const,
  },
  headerRight: { display: 'flex', gap: '8px' },

  // Buttons
  btnPrimary: {
    background: '#d4af37', color: '#0a0c10', border: 'none', borderRadius: '6px',
    padding: '8px 16px', fontSize: '12px', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
  },
  btnCashier: {
    background: 'rgba(46,204,113,0.12)', color: '#2ecc71', border: '1px solid rgba(46,204,113,0.3)',
    borderRadius: '6px', padding: '8px 14px', fontSize: '12px', fontWeight: 700,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  btnBridge: {
    background: 'transparent', color: '#3498db', border: '1px solid rgba(52,152,219,0.4)',
    borderRadius: '6px', padding: '8px 14px', fontSize: '12px', fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },

  // Status strip
  strip: {
    display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' as const,
    padding: '8px 24px', background: 'rgba(212,175,55,0.03)',
    borderBottom: '1px solid rgba(255,255,255,0.04)', fontSize: '11px',
  },
  dot: { width: '7px', height: '7px', borderRadius: '50%', flexShrink: 0 },
  dim: { color: '#6a6a6a' },
  balVal: { color: '#d4af37', fontWeight: 700 },
  chipVal: { color: '#2ecc71', fontWeight: 600 },

  // Warnings / errors / tx
  warning: {
    margin: '12px 24px', padding: '10px 14px', background: 'rgba(231,76,60,0.08)',
    border: '1px solid rgba(231,76,60,0.25)', borderRadius: '6px', fontSize: '12px', color: '#e74c3c',
  },
  errorBar: {
    margin: '0 24px 0', padding: '8px 14px', background: 'rgba(231,76,60,0.08)',
    border: '1px solid rgba(231,76,60,0.2)', borderRadius: '6px', fontSize: '11px', color: '#e74c3c',
  },
  txBar: {
    margin: '4px 24px 0', padding: '6px 14px', background: 'rgba(46,204,113,0.06)',
    border: '1px solid rgba(46,204,113,0.15)', borderRadius: '6px', fontSize: '11px', color: '#2ecc71',
  },

  // Session panel
  sessionPanel: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    margin: '12px 24px', padding: '14px 20px',
    background: 'rgba(212,175,55,0.04)', border: '1px solid rgba(212,175,55,0.12)',
    borderRadius: '10px', gap: '16px',
  },
  sessionInfo: { display: 'flex', flexDirection: 'column' as const, gap: '4px', fontSize: '12px' },
  sessionActive: { color: '#2ecc71', fontWeight: 600 },
  btnSession: {
    background: '#d4af37', color: '#0a0c10', border: 'none', borderRadius: '8px',
    padding: '10px 24px', fontSize: '13px', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
    whiteSpace: 'nowrap' as const,
  },
  btnSessionEnd: {
    background: 'transparent', color: '#8a8a8a', border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '8px', padding: '10px 20px', fontSize: '12px', fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' as const,
  },

  // Felt table
  felt: {
    flex: 1, margin: '16px 24px',
    background: 'radial-gradient(ellipse at center, #1a3a2a 0%, #0d1f17 60%, #0a0c10 100%)',
    border: '2px solid rgba(212,175,55,0.2)', borderRadius: '160px / 100px',
    padding: '40px 36px', display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', gap: '20px', minHeight: '360px',
    boxShadow: 'inset 0 0 60px rgba(0,0,0,0.5), 0 0 30px rgba(212,175,55,0.04)',
  },
  tableInfo: { display: 'flex', gap: '10px', alignItems: 'center' },
  tableLabel: { fontSize: '13px', color: '#7a7a7a', fontWeight: 600 },
  statusBadge: {
    fontSize: '10px', fontWeight: 700, color: '#2ecc71', background: 'rgba(46,204,113,0.1)',
    padding: '2px 9px', borderRadius: '10px', letterSpacing: '0.6px', textTransform: 'uppercase' as const,
  },
  vrfBadge: {
    fontSize: '10px', fontWeight: 600, color: '#f39c12', background: 'rgba(243,156,18,0.1)',
    padding: '2px 9px', borderRadius: '10px',
  },
  potArea: { textAlign: 'center' as const },
  potLabel: { fontSize: '10px', color: '#7a7a7a', letterSpacing: '3px', textTransform: 'uppercase' as const },
  potValue: { fontSize: '26px', fontWeight: 700, color: '#d4af37' },
  betLabel: { fontSize: '11px', color: '#7a7a7a', marginTop: '2px' },
  communityArea: { display: 'flex', gap: '8px', justifyContent: 'center', padding: '12px 0' },
  card: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '48px', height: '66px', borderRadius: '5px', background: '#fafaf8',
    fontWeight: 700, fontSize: '16px', boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
  },
  cardBack: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '48px', height: '66px', borderRadius: '5px',
    background: 'linear-gradient(135deg, #1a3a6a, #0d1f3a)',
    color: '#4a6fa5', fontSize: '22px', fontWeight: 700,
    boxShadow: '0 2px 6px rgba(0,0,0,0.4)', border: '1px solid rgba(74,111,165,0.25)',
  },
  emptyBoard: { color: '#4a4a4a', fontSize: '12px', fontStyle: 'italic' as const },
  seatsArea: {
    display: 'flex', gap: '12px', flexWrap: 'wrap' as const, justifyContent: 'center', maxWidth: '560px',
  },
  seat: {
    background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)',
    borderRadius: '8px', padding: '8px 14px', textAlign: 'center' as const, minWidth: '90px',
  },
  seatSelf: { border: '1px solid rgba(212,175,55,0.45)', background: 'rgba(212,175,55,0.05)' },
  seatIdx: { fontSize: '9px', color: '#5a5a5a', letterSpacing: '1px', textTransform: 'uppercase' as const },
  seatAddr: { fontSize: '12px', color: '#b8b8b8', fontWeight: 600, marginTop: '3px' },
  emptySeats: { color: '#4a4a4a', fontSize: '13px' },
  playerCount: { fontSize: '11px', color: '#5a5a5a' },

  // Action bar
  actionBar: {
    display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' as const,
    padding: '12px 24px', borderTop: '1px solid rgba(212,175,55,0.1)',
    background: 'rgba(10,12,16,0.95)',
  },
  btnAction: {
    background: '#1a3a2a', color: '#2ecc71', border: '1px solid rgba(46,204,113,0.25)',
    borderRadius: '6px', padding: '10px 18px', fontSize: '12px', fontWeight: 700,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  btnFold: {
    background: 'rgba(231,76,60,0.1)', color: '#e74c3c', border: '1px solid rgba(231,76,60,0.25)',
    borderRadius: '6px', padding: '10px 18px', fontSize: '12px', fontWeight: 700,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  btnRaise: {
    background: '#d4af37', color: '#0a0c10', border: 'none',
    borderRadius: '0 6px 6px 0', padding: '10px 16px', fontSize: '12px', fontWeight: 700,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  btnAllIn: {
    background: 'rgba(243,156,18,0.15)', color: '#f39c12', border: '1px solid rgba(243,156,18,0.3)',
    borderRadius: '6px', padding: '10px 18px', fontSize: '12px', fontWeight: 700,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  btnLeave: {
    background: 'transparent', color: '#6a6a6a', border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '6px', padding: '10px 14px', fontSize: '11px', cursor: 'pointer',
    fontFamily: 'inherit', marginLeft: 'auto',
  },
  betInput: { display: 'flex' },
  input: {
    background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '6px 0 0 6px', borderRight: 'none', padding: '10px 12px',
    color: '#e8e6e1', fontSize: '12px', fontFamily: 'inherit', width: '110px',
    outline: 'none',
  },
  txPending: { color: '#f39c12', fontSize: '11px', fontWeight: 600 },

  // Footer
  footer: {
    padding: '12px 24px', borderTop: '1px solid rgba(255,255,255,0.03)',
    display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#4a4a4a',
  },
}
