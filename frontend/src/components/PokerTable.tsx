/**
 * PokerTable.tsx — On-chain poker with Session Wallet (sign once, play free)
 *
 * SESSION WALLET ARCHITECTURE:
 *   1. Player clicks "Sit Down" → selects buy-in via slider
 *   2. ONE Keplr popup: sends INIT to ephemeral session wallet
 *   3. Session wallet auto: deposit → joinTable (zero popups)
 *   4. All game actions signed by session key (zero popups)
 *   5. "Leave Table": leaveTable → withdraw → return INIT (zero popups)
 */

'use client'

import { useState, useEffect } from 'react'
import { formatEther, parseEther } from 'viem'
import {
  useAccount,
  useReadContract,
  useSendTransaction,
  useWriteContract,
} from 'wagmi'
import { useInterwovenKit } from '@initia/interwovenkit-react'
import { POKER_GAME_ADDRESS, POKER_GAME_ABI } from '../config/contract'
import { SESSION_GAS_RESERVE } from '../config/network'
import CashierModal from './CashierModal'
import { useWalletBalance } from '../hooks/useWalletBalance'
import { useSessionWallet } from '../hooks/useSessionWallet'

// ── Game constants ──
const STATUS_LABELS = ['Waiting', 'Dealing', 'Pre-Flop', 'Flop', 'Turn', 'River', 'Showdown', 'Settled'] as const
const SUITS = ['♠', '♥', '♦', '♣'] as const
const SUIT_COLORS = ['#ccc', '#E07070', '#7EAECF', '#7ECFB3'] as const
const VALUES = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const

function Card({ encoded }: { encoded: number }) {
  if (!encoded) return <span style={s.cardBack}>?</span>
  const suit = encoded >> 4
  const value = encoded & 0x0f
  return <span style={{ ...s.card, color: SUIT_COLORS[suit] }}>{VALUES[value]}{SUITS[suit]}</span>
}

// ══════════════════════════════════════════════════════════
//  BUY-IN MODAL (slider: 10bb – 100bb)
// ══════════════════════════════════════════════════════════

function BuyInModal({ bigBlind, walletBalance, onConfirm, onClose, isProcessing, sessionStatus }: {
  bigBlind: number
  walletBalance: string
  onConfirm: (amount: number) => void
  onClose: () => void
  isProcessing: boolean
  sessionStatus: string
}) {
  const minBuy = bigBlind * 10
  const maxBuy = bigBlind * 100
  const gasReserve = parseFloat(SESSION_GAS_RESERVE)
  const available = Math.max(0, parseFloat(walletBalance) - gasReserve)
  const effectiveMax = Math.min(maxBuy, available)
  const [value, setValue] = useState(Math.min(bigBlind * 50, effectiveMax > minBuy ? effectiveMax : minBuy))
  const canJoin = value >= minBuy && value <= effectiveMax && !isProcessing

  return (
    <div style={s.modalOverlay} onClick={!isProcessing ? onClose : undefined}>
      <div style={s.buyInModal} onClick={e => e.stopPropagation()}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'16px'}}>
          <span style={{fontSize:'16px',fontWeight:600,color:'#fff'}}>Take a Seat</span>
          {!isProcessing && <button onClick={onClose} style={{background:'none',border:'none',color:'#555',fontSize:'18px',cursor:'pointer'}}>✕</button>}
        </div>

        {/* Processing state */}
        {isProcessing ? (
          <div style={{textAlign:'center',padding:'24px 0'}}>
            <div style={{fontSize:'13px',color:'#E8DCC8',marginBottom:'8px'}}>⏳ {sessionStatus || 'Processing...'}</div>
            <div style={{fontSize:'11px',color:'#555'}}>Do not close this window</div>
          </div>
        ) : (
          <>
            {/* Info boxes */}
            <div style={{display:'flex',gap:'8px',marginBottom:'16px'}}>
              <div style={{flex:1,background:'#0F0F0F',borderRadius:'6px',padding:'8px',textAlign:'center'}}>
                <div style={{fontSize:'9px',color:'#555',textTransform:'uppercase',fontWeight:600}}>Big Blind</div>
                <div style={{fontSize:'14px',fontWeight:600,color:'#E8DCC8',marginTop:'2px'}}>{bigBlind} INIT</div>
              </div>
              <div style={{flex:1,background:'#0F0F0F',borderRadius:'6px',padding:'8px',textAlign:'center'}}>
                <div style={{fontSize:'9px',color:'#555',textTransform:'uppercase',fontWeight:600}}>Available</div>
                <div style={{fontSize:'14px',fontWeight:600,color:'#7ECFB3',marginTop:'2px'}}>{available.toFixed(2)} INIT</div>
              </div>
            </div>

            {/* Amount */}
            <div style={{textAlign:'center',margin:'12px 0'}}>
              <div style={{fontSize:'28px',fontWeight:700,color:'#fff',fontFamily:'"DM Mono",monospace'}}>{value.toFixed(1)}</div>
              <div style={{fontSize:'11px',color:'#555'}}>INIT · {Math.round(value / bigBlind)} big blinds</div>
            </div>

            {/* Slider */}
            <div style={{padding:'0 4px',margin:'16px 0'}}>
              <input type="range"
                min={minBuy} max={effectiveMax > minBuy ? effectiveMax : minBuy + bigBlind}
                step={bigBlind} value={value}
                onChange={e => setValue(Number(e.target.value))}
                style={{width:'100%',height:'4px',appearance:'none' as any,
                  background:`linear-gradient(to right, #E8DCC8 ${((value-minBuy)/(effectiveMax-minBuy||1))*100}%, #1C1C1C ${((value-minBuy)/(effectiveMax-minBuy||1))*100}%)`,
                  borderRadius:'2px',outline:'none',cursor:'pointer'}}
              />
              <div style={{display:'flex',justifyContent:'space-between',fontSize:'10px',color:'#3a3a3a',marginTop:'4px'}}>
                <span>{minBuy} (10bb)</span>
                <span>{effectiveMax > 0 ? effectiveMax.toFixed(1) : maxBuy} (max)</span>
              </div>
            </div>

            {/* Quick amounts */}
            <div style={{display:'flex',gap:'6px',marginBottom:'16px'}}>
              {[10, 25, 50, 75, 100].map(bb => {
                const amt = bigBlind * bb
                if (amt > effectiveMax + bigBlind) return null
                return (
                  <button key={bb} onClick={() => setValue(Math.min(amt, effectiveMax))}
                    style={{flex:1,padding:'6px',fontSize:'10px',fontWeight:600,cursor:'pointer',fontFamily:'inherit',
                      background: Math.abs(value - amt) < bigBlind*0.5 ? '#E8DCC8' : '#0F0F0F',
                      color: Math.abs(value - amt) < bigBlind*0.5 ? '#000' : '#666',
                      border:'1px solid #1C1C1C',borderRadius:'4px'}}>
                    {bb}bb
                  </button>
                )
              })}
            </div>

            {available < minBuy && (
              <div style={{padding:'8px',background:'rgba(224,112,112,0.08)',border:'1px solid rgba(224,112,112,0.2)',borderRadius:'6px',fontSize:'11px',color:'#E07070',marginBottom:'12px'}}>
                Not enough wallet balance. Need at least {(minBuy + gasReserve).toFixed(1)} INIT. Use Cashier to deposit.
              </div>
            )}

            <div style={{fontSize:'10px',color:'#555',marginBottom:'12px',lineHeight:1.5}}>
              You will sign <b style={{color:'#E8DCC8'}}>one transaction</b> to fund a session wallet.
              After that, all poker actions (fold, call, raise) fire instantly with zero popups.
              When you leave the table, all remaining INIT returns to your wallet automatically.
            </div>

            <button onClick={() => canJoin && onConfirm(value)} disabled={!canJoin}
              style={{width:'100%',padding:'12px',fontSize:'14px',fontWeight:600,
                cursor:canJoin?'pointer':'not-allowed',fontFamily:'inherit',
                background:canJoin?'#E8DCC8':'#1C1C1C',color:canJoin?'#000':'#3a3a3a',
                border:'none',borderRadius:'8px'}}>
              Sit Down · {value.toFixed(1)} INIT
            </button>
          </>
        )}
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════
//  MAIN COMPONENT
// ══════════════════════════════════════════════════════════

export default function PokerTable({ tableId = 0n, bigBlind = 0.2, tableName = 'Table', onBack }: {
  tableId?: bigint; bigBlind?: number; tableName?: string; onBack?: () => void
}) {
  const { address, isConnected } = useAccount()
  const { username, openConnect, openWallet } = useInterwovenKit()
  const { sendTransactionAsync } = useSendTransaction()
  const { writeContractAsync, isPending: legacyPending } = useWriteContract()

  // ── Session wallet (popup-free play) ──
  const session = useSessionWallet()

  // ── UI state ──
  const [betAmount, setBetAmount] = useState('')
  const [lastTxHash, setLastTxHash] = useState<string | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const [cashierOpen, setCashierOpen] = useState(false)
  const [buyInOpen, setBuyInOpen] = useState(false)
  const [actionPending, setActionPending] = useState(false)

  // ── Balances (main wallet — for display and Cashier) ──
  const { walletBalance, gameBalance, isLoading: balLoading, refetch: refetchBal } = useWalletBalance(tableId)

  // ── The address to read player state for ──
  // When session is active, the player at the table IS the session wallet
  const playerAddr = (session.active && session.address) ? session.address as `0x${string}` : address

  // ── On-chain reads ──
  const hasContract = POKER_GAME_ADDRESS !== '0x0000000000000000000000000000000000000000'

  // Also read MAIN wallet state (to detect legacy seated state)
  const { data: mainWalletState } = useReadContract({
    address: POKER_GAME_ADDRESS, abi: POKER_GAME_ABI,
    functionName: 'getPlayerState', args: [tableId, address!],
    query: { enabled: hasContract && !!address && session.active, refetchInterval: 5000 },
  })
  const mainWalletSeated = mainWalletState ? Boolean(mainWalletState[3]) : false

  const { data: session_data, refetch: refetchSession } = useReadContract({
    address: POKER_GAME_ADDRESS, abi: POKER_GAME_ABI,
    functionName: 'getSession', args: [tableId],
    query: { enabled: hasContract, refetchInterval: 5000 },
  })
  const { data: players, refetch: refetchPlayers } = useReadContract({
    address: POKER_GAME_ADDRESS, abi: POKER_GAME_ABI,
    functionName: 'getPlayers', args: [tableId],
    query: { enabled: hasContract, refetchInterval: 5000 },
  })
  const { data: communityRaw } = useReadContract({
    address: POKER_GAME_ADDRESS, abi: POKER_GAME_ABI,
    functionName: 'getCommunityCards', args: [tableId],
    query: { enabled: hasContract, refetchInterval: 5000 },
  })
  const { data: myState, refetch: refetchMyState } = useReadContract({
    address: POKER_GAME_ADDRESS, abi: POKER_GAME_ABI,
    functionName: 'getPlayerState', args: [tableId, playerAddr!],
    query: { enabled: hasContract && !!playerAddr, refetchInterval: 5000 },
  })
  const { data: totalTables } = useReadContract({
    address: POKER_GAME_ADDRESS, abi: POKER_GAME_ABI,
    functionName: 'tableCount',
    query: { enabled: hasContract },
  })

  // ── Derived values ──
  const status = session_data ? Number(session_data[1]) : 0
  const playerCount = session_data ? Number(session_data[2]) : 0
  const pot = session_data ? session_data[4] : 0n
  const currentBet = session_data ? session_data[5] : 0n
  const communityCount = session_data ? Number(session_data[7]) : 0
  const vrfPending = session_data ? session_data[8] : false
  const saltsCommitted = session_data ? Number(session_data[9]) : 0
  const community = communityRaw
    ? (communityRaw as readonly number[]).filter((_, i) => i < communityCount)
    : []
  const isSeated = myState ? Boolean(myState[3]) : false
  const myStake = myState ? myState[0] as bigint : 0n
  const myBet = myState ? myState[1] as bigint : 0n
  const isActive = myState ? Boolean(myState[3]) : false
  const truncAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

  // Is this address me? (could be main wallet OR session wallet)
  const isMe = (a: string) => {
    if (!a) return false
    const low = a.toLowerCase()
    return low === address?.toLowerCase() || low === session.address?.toLowerCase()
  }

  // Combined error
  const error = localError || session.error

  // Refresh after any action
  const refreshAll = () => {
    setTimeout(() => { refetchSession(); refetchPlayers(); refetchMyState(); refetchBal() }, 2000)
  }

  // ══════════════════════════════════════════════════════════
  //  SIT DOWN FLOW (one Keplr popup → then auto deposit+join)
  // ══════════════════════════════════════════════════════════

  const handleSitDown = async (buyInAmount: number) => {
    setLocalError(null)
    try {
      // 1. Create session wallet
      const sessionAddr = await session.createSession(address!)

      // 2. Fund session wallet: buyIn + gas reserve (ONE Keplr popup)
      const buyInWei = parseEther(buyInAmount.toString())
      const gasReserveWei = parseEther(SESSION_GAS_RESERVE)
      const totalToSend = buyInWei + gasReserveWei

      await sendTransactionAsync({
        to: sessionAddr as `0x${string}`,
        value: totalToSend,
        gas: 50_000n,
        gasPrice: 1_000_000_000n,
      })

      // 3. Session wallet: deposit + join (ZERO popups)
      const ok = await session.depositAndJoin(tableId, buyInWei)
      if (ok) {
        setBuyInOpen(false)
        refreshAll()
      }
    } catch (err: any) {
      setLocalError(err.shortMessage ?? err.message)
    }
  }

  // ══════════════════════════════════════════════════════════
  //  LEAVE TABLE (zero popups — session wallet handles all)
  // ══════════════════════════════════════════════════════════

  const handleLeave = async () => {
    setLocalError(null)
    const ok = await session.leaveAndCashout(tableId)
    if (ok) refreshAll()
  }

  // ══════════════════════════════════════════════════════════
  //  LEGACY LEAVE (for main wallet seated without session)
  //  This requires ONE Keplr popup — only used for migration
  // ══════════════════════════════════════════════════════════

  const handleLegacyLeave = async () => {
    setLocalError(null)
    try {
      await writeContractAsync({
        address: POKER_GAME_ADDRESS,
        abi: POKER_GAME_ABI,
        functionName: 'leaveTable',
        args: [tableId],
        gas: 500_000n,
        gasPrice: 1_000_000_000n,
      })
      refreshAll()
    } catch (err: any) {
      setLocalError(err.shortMessage ?? err.message)
    }
  }

  // ══════════════════════════════════════════════════════════
  //  GAME ACTIONS (all via session wallet — zero popups)
  // ══════════════════════════════════════════════════════════

  const doAction = async (fn: () => Promise<string | null>) => {
    setActionPending(true)
    setLocalError(null)
    const hash = await fn()
    if (hash) setLastTxHash(hash)
    setActionPending(false)
    refreshAll()
  }

  const handleFold      = () => doAction(() => session.fold(tableId))
  const handleCheck     = () => doAction(() => session.check(tableId))
  const handleCall      = () => doAction(() => session.callAction(tableId))
  const handleBet       = () => doAction(() => session.bet(tableId, parseEther(betAmount || '0')))
  const handleRaise     = () => doAction(() => session.raise(tableId, parseEther(betAmount || '0')))
  const handleAllIn     = () => doAction(() => session.allIn(tableId))
  const handleCommit    = () => doAction(() => session.commitSalt(tableId))
  const handleDeal      = () => doAction(() => session.requestDeal(tableId))
  const handleReveal    = () => doAction(() => session.revealCards(tableId))
  const handleEvaluate  = () => doAction(() => session.evaluateShowdown(tableId))

  const txBusy = actionPending || session.processing || legacyPending

  // ══════════════════════════════════════════════════════════
  //  RENDER
  // ══════════════════════════════════════════════════════════

  return (
    <div style={s.root}>

      {/* ── HEADER ── */}
      <header style={s.header}>
        <div style={s.brand}>
          {onBack && <button onClick={onBack} style={s.btnBack}>← Back</button>}
          <span style={{color:'#E8DCC8',fontSize:'14px'}}>◆</span>
          <h1 style={s.title}>{tableName}</h1>
          <span style={s.badge}>Initia</span>
          {session.active && <span style={s.sessionBadge}>Session ●</span>}
        </div>
        <div style={s.headerRight}>
          {isConnected && (
            <button onClick={() => setCashierOpen(true)} style={s.btnCashier}>Cashier</button>
          )}
          {isConnected ? (
            <button onClick={openWallet} style={s.btnWallet}>{username ?? truncAddr(address!)}</button>
          ) : (
            <button onClick={openConnect} style={s.btnConnect}>Connect Wallet</button>
          )}
        </div>
      </header>

      {/* ── STATUS STRIP ── */}
      <div style={s.strip}>
        <span style={{...s.dot, background: isConnected ? '#7ECFB3' : '#E07070'}} />
        <span style={s.dim}>{isConnected ? 'Connected' : 'Disconnected'}</span>
        {isConnected && <span style={s.balVal}>Wallet: {balLoading ? '…' : walletBalance} INIT</span>}
        {isSeated && <span style={{color:'#E8DCC8',fontWeight:600}}>Table: {formatEther(myStake)} INIT</span>}
        {session.active && session.address && (
          <span style={{color:'#555',fontSize:'10px',fontFamily:'"DM Mono",monospace'}}>
            Session: {truncAddr(session.address)}
          </span>
        )}
      </div>

      {/* ── SESSION STATUS / ERRORS ── */}
      {session.status && !session.error && (
        <div style={s.txBar}>{session.status}</div>
      )}
      {error && <div style={s.errorBar}>{error}</div>}
      {lastTxHash && !error && !session.status && (
        <div style={s.txBar}>Tx: <code style={{fontFamily:'"DM Mono",monospace'}}>{lastTxHash.slice(0,18)}…</code></div>
      )}

      {/* ── SESSION INFO (when active but no errors) ── */}
      {session.active && !session.processing && !error && (
        <div style={s.sessionPanel}>
          <div style={{display:'flex',alignItems:'center',gap:'8px'}}>
            <span style={{width:'8px',height:'8px',borderRadius:'50%',background:'#7ECFB3'}} />
            <span style={{color:'#7ECFB3',fontSize:'12px',fontWeight:600}}>Session active</span>
            <span style={{color:'#3a3a3a',fontSize:'11px'}}>All actions are popup-free</span>
          </div>
          {session.address && (
            <button onClick={session.emergencyRecover} style={s.btnRecover} title="Force-return all funds to wallet">
              Recover Funds
            </button>
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

        <div style={s.potArea}>
          <div style={s.potLabel}>POT</div>
          <div style={s.potValue}>{pot ? formatEther(pot as bigint) : '—'}</div>
          {currentBet > 0n && (
            <div style={s.betLabel}>Bet to match: {formatEther(currentBet as bigint)} INIT</div>
          )}
        </div>

        <div style={s.communityArea}>
          {community.length > 0
            ? community.map((c, i) => <Card key={i} encoded={c} />)
            : <span style={s.emptyBoard}>{status >= 2 ? 'Waiting for flop…' : 'No cards dealt'}</span>}
        </div>

        <div style={s.seatsArea}>
          {playerCount > 0 && players ? (
            (players as readonly `0x${string}`[]).map((p, i) => (
              <div key={i} style={{...s.seat, ...(isMe(p) ? s.seatSelf : {})}}>
                <div style={s.seatIdx}>Seat {i}</div>
                <div style={s.seatAddr}>{isMe(p) ? 'You' : truncAddr(p)}</div>
              </div>
            ))
          ) : (
            <div style={s.emptySeats}>
              {isConnected ? 'Empty table — sit down to play!' : 'Connect wallet to play'}
            </div>
          )}
        </div>
        <div style={s.playerCount}>{playerCount} seated</div>
      </main>

      {/* ── ACTION BAR ── */}
      {isConnected && (
        <div style={s.actionBar}>

          {/* ═══ LEGACY: Seated via main wallet (no session) ═══ */}
          {isSeated && !session.active && (status === 0 || status === 7) && (
            <button onClick={handleLegacyLeave} style={s.btnLeave} disabled={txBusy}>
              {legacyPending ? 'Leaving...' : 'Leave Table'}
            </button>
          )}

          {/* ═══ NOT SEATED → Sit Down ═══ */}
          {(status === 0 || status === 7) && !isSeated && !session.processing && (
            <button onClick={() => setBuyInOpen(true)} style={s.btnAction} disabled={txBusy}>
              Sit Down
            </button>
          )}

          {/* ═══ SESSION ACTIVE: Seated, Waiting → Commit Salt / Deal ═══ */}
          {(status === 0 || status === 7) && isSeated && session.active && (
            <>
              {saltsCommitted < playerCount && (
                <button onClick={handleCommit} style={s.btnAction} disabled={txBusy}>Commit Salt</button>
              )}
              {saltsCommitted >= playerCount && playerCount >= 2 && (
                <button onClick={handleDeal} style={s.btnAction} disabled={txBusy}>Deal Cards</button>
              )}
            </>
          )}

          {/* ═══ SESSION ACTIVE: Betting phase → Poker actions ═══ */}
          {status >= 2 && status <= 5 && isActive && session.active && (
            <>
              <button onClick={handleFold} style={s.btnFold} disabled={txBusy}>Fold</button>
              {currentBet === myBet
                ? <button onClick={handleCheck} style={s.btnAction} disabled={txBusy}>Check</button>
                : <button onClick={handleCall} style={s.btnAction} disabled={txBusy}>Call</button>
              }
              <div style={s.betInput}>
                <input type="text" placeholder="INIT" value={betAmount}
                  onChange={e => setBetAmount(e.target.value)} style={s.input} />
                <button onClick={currentBet > 0n ? handleRaise : handleBet} style={s.btnRaise} disabled={txBusy}>
                  {currentBet > 0n ? 'Raise' : 'Bet'}
                </button>
              </div>
              <button onClick={handleAllIn} style={s.btnAllIn} disabled={txBusy}>All-In</button>
            </>
          )}

          {/* ═══ SESSION ACTIVE: Showdown → Reveal + Evaluate ═══ */}
          {status === 6 && isActive && session.active && (
            <>
              <button onClick={handleReveal} style={s.btnAction} disabled={txBusy}>Reveal</button>
              <button onClick={handleEvaluate} style={s.btnAction} disabled={txBusy}>Evaluate</button>
            </>
          )}

          {/* ═══ SESSION ACTIVE: Leave Table ═══ */}
          {isSeated && session.active && (status === 0 || status === 7) && (
            <button onClick={handleLeave} style={s.btnLeave} disabled={txBusy}>
              {session.processing ? 'Leaving...' : 'Leave Table'}
            </button>
          )}

          {txBusy && <span style={s.txPending}>Processing…</span>}
        </div>
      )}

      {/* ── BUY-IN MODAL ── */}
      {buyInOpen && (
        <BuyInModal
          bigBlind={bigBlind}
          walletBalance={walletBalance}
          onConfirm={handleSitDown}
          onClose={() => !session.processing && setBuyInOpen(false)}
          isProcessing={session.processing}
          sessionStatus={session.status}
        />
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
        <span style={{color:'#2a2a2a'}}>INIPoker on Initia</span>
        <span style={s.dim}>Session Wallet · Band VRF · Commit-Reveal</span>
      </footer>
    </div>
  )
}

// ══════════════════════════════════════════════════════════
//  STYLES — Initia-inspired minimal dark
// ══════════════════════════════════════════════════════════

const s: Record<string, React.CSSProperties> = {
  root: { minHeight:'100vh', background:'#000', color:'#b0b0b0', fontFamily:'"DM Sans",sans-serif', display:'flex', flexDirection:'column' },
  header: { display:'flex', justifyContent:'space-between', alignItems:'center', padding:'12px 20px', borderBottom:'1px solid #161616' },
  brand: { display:'flex', alignItems:'center', gap:'10px' },
  btnBack: { background:'#111', color:'#666', border:'1px solid #1C1C1C', borderRadius:'6px', padding:'5px 12px', fontSize:'11px', fontWeight:500, cursor:'pointer', fontFamily:'inherit' },
  title: { fontSize:'16px', fontWeight:600, color:'#fff', margin:0 },
  badge: { fontSize:'9px', fontWeight:600, color:'#E8DCC8', background:'rgba(232,220,200,0.08)', padding:'2px 8px', borderRadius:'4px' },
  sessionBadge: { fontSize:'9px', fontWeight:600, color:'#7ECFB3', background:'rgba(126,207,179,0.08)', padding:'2px 8px', borderRadius:'4px' },
  headerRight: { display:'flex', gap:'8px' },
  btnConnect: { background:'#E8DCC8', color:'#000', border:'none', borderRadius:'6px', padding:'8px 16px', fontSize:'12px', fontWeight:600, cursor:'pointer', fontFamily:'inherit' },
  btnCashier: { background:'#111', color:'#7ECFB3', border:'1px solid #1C1C1C', borderRadius:'6px', padding:'8px 14px', fontSize:'11px', fontWeight:600, cursor:'pointer', fontFamily:'inherit' },
  btnWallet: { background:'#111', color:'#ccc', border:'1px solid #1C1C1C', borderRadius:'6px', padding:'8px 14px', fontSize:'11px', fontWeight:500, cursor:'pointer', fontFamily:'"DM Mono",monospace' },

  strip: { display:'flex', alignItems:'center', gap:'12px', flexWrap:'wrap' as const, padding:'8px 20px', borderBottom:'1px solid #0F0F0F', fontSize:'11px' },
  dot: { width:'6px', height:'6px', borderRadius:'50%', flexShrink:0 },
  dim: { color:'#3a3a3a' },
  balVal: { color:'#888', fontFamily:'"DM Mono",monospace' },

  errorBar: { margin:'0 20px', padding:'8px 14px', background:'rgba(224,112,112,0.06)', border:'1px solid rgba(224,112,112,0.12)', borderRadius:'6px', fontSize:'11px', color:'#E07070' },
  txBar: { margin:'4px 20px 0', padding:'6px 14px', background:'rgba(126,207,179,0.04)', border:'1px solid rgba(126,207,179,0.1)', borderRadius:'6px', fontSize:'11px', color:'#7ECFB3' },

  sessionPanel: { display:'flex', alignItems:'center', justifyContent:'space-between', margin:'8px 20px', padding:'10px 16px', background:'#0A0A0A', border:'1px solid #161616', borderRadius:'8px' },
  btnRecover: { background:'#111', color:'#555', border:'1px solid #1C1C1C', borderRadius:'5px', padding:'4px 10px', fontSize:'10px', cursor:'pointer', fontFamily:'inherit' },

  felt: { flex:1, margin:'16px 20px', background:'radial-gradient(ellipse at center, #0F1A14 0%, #080E0B 60%, #000 100%)', border:'1px solid #1C1C1C', borderRadius:'120px / 80px', padding:'40px 36px', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:'20px', minHeight:'340px' },
  tableInfo: { display:'flex', gap:'10px', alignItems:'center' },
  tableLabel: { fontSize:'12px', color:'#555', fontWeight:500 },
  statusBadge: { fontSize:'10px', fontWeight:600, color:'#7ECFB3', background:'rgba(126,207,179,0.08)', padding:'2px 10px', borderRadius:'10px' },
  vrfBadge: { fontSize:'10px', fontWeight:500, color:'#E8DCC8', background:'rgba(232,220,200,0.08)', padding:'2px 10px', borderRadius:'10px' },
  potArea: { textAlign:'center' as const },
  potLabel: { fontSize:'9px', color:'#555', letterSpacing:'3px', textTransform:'uppercase' as const },
  potValue: { fontSize:'24px', fontWeight:700, color:'#E8DCC8', fontFamily:'"DM Mono",monospace' },
  betLabel: { fontSize:'11px', color:'#555', marginTop:'2px' },
  communityArea: { display:'flex', gap:'8px', justifyContent:'center', padding:'12px 0' },
  card: { display:'inline-flex', alignItems:'center', justifyContent:'center', width:'46px', height:'64px', borderRadius:'6px', background:'#fafaf8', fontWeight:700, fontSize:'15px', boxShadow:'0 2px 8px rgba(0,0,0,0.5)' },
  cardBack: { display:'inline-flex', alignItems:'center', justifyContent:'center', width:'46px', height:'64px', borderRadius:'6px', background:'#111', color:'#333', fontSize:'20px', fontWeight:700, border:'1px solid #1C1C1C' },
  emptyBoard: { color:'#333', fontSize:'12px', fontStyle:'italic' as const },
  seatsArea: { display:'flex', gap:'10px', flexWrap:'wrap' as const, justifyContent:'center', maxWidth:'560px' },
  seat: { background:'rgba(255,255,255,0.02)', border:'1px solid #1C1C1C', borderRadius:'8px', padding:'8px 14px', textAlign:'center' as const, minWidth:'90px' },
  seatSelf: { border:'1px solid rgba(232,220,200,0.3)', background:'rgba(232,220,200,0.03)' },
  seatIdx: { fontSize:'9px', color:'#333', letterSpacing:'1px', textTransform:'uppercase' as const },
  seatAddr: { fontSize:'11px', color:'#888', fontWeight:500, marginTop:'3px', fontFamily:'"DM Mono",monospace' },
  emptySeats: { color:'#333', fontSize:'13px' },
  playerCount: { fontSize:'11px', color:'#333' },

  actionBar: { display:'flex', alignItems:'center', gap:'8px', flexWrap:'wrap' as const, padding:'12px 20px', borderTop:'1px solid #161616' },
  btnAction: { background:'#111', color:'#7ECFB3', border:'1px solid #1C1C1C', borderRadius:'6px', padding:'10px 18px', fontSize:'12px', fontWeight:600, cursor:'pointer', fontFamily:'inherit' },
  btnFold: { background:'rgba(224,112,112,0.06)', color:'#E07070', border:'1px solid rgba(224,112,112,0.15)', borderRadius:'6px', padding:'10px 18px', fontSize:'12px', fontWeight:600, cursor:'pointer', fontFamily:'inherit' },
  btnRaise: { background:'#E8DCC8', color:'#000', border:'none', borderRadius:'0 6px 6px 0', padding:'10px 16px', fontSize:'12px', fontWeight:600, cursor:'pointer', fontFamily:'inherit' },
  btnAllIn: { background:'rgba(232,220,200,0.06)', color:'#E8DCC8', border:'1px solid rgba(232,220,200,0.15)', borderRadius:'6px', padding:'10px 18px', fontSize:'12px', fontWeight:600, cursor:'pointer', fontFamily:'inherit' },
  btnLeave: { background:'rgba(224,112,112,0.06)', color:'#E07070', border:'1px solid rgba(224,112,112,0.15)', borderRadius:'6px', padding:'10px 18px', fontSize:'12px', fontWeight:600, cursor:'pointer', fontFamily:'inherit', marginLeft:'auto' },
  betInput: { display:'flex' },
  input: { background:'#0A0A0A', border:'1px solid #1C1C1C', borderRadius:'6px 0 0 6px', borderRight:'none', padding:'10px 12px', color:'#fff', fontSize:'12px', fontFamily:'"DM Mono",monospace', width:'100px', outline:'none' },
  txPending: { color:'#E8DCC8', fontSize:'11px', fontWeight:600 },

  footer: { padding:'12px 20px', borderTop:'1px solid #0F0F0F', display:'flex', justifyContent:'space-between', fontSize:'11px', color:'#2a2a2a' },

  modalOverlay: { position:'fixed', top:0, left:0, right:0, bottom:0, background:'rgba(0,0,0,0.8)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000, backdropFilter:'blur(4px)' },
  buyInModal: { background:'#0A0A0A', border:'1px solid #1C1C1C', borderRadius:'12px', padding:'22px', width:'380px', maxWidth:'92vw', fontFamily:'"DM Sans",sans-serif' },
}
