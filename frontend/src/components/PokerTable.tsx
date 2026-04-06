/**
 * PokerTable.tsx ? Full poker UI with all 10 features
 *
 * 1. Hole cards (Fisher-Yates reconstruction from deckSeed)
 * 2. Whose turn indicator (activePlayerIndex from sessions())
 * 3. Chips/bet/action on each seat
 * 4. Winner announcement
 * 5. Dealer/SB/BB markers
 * 6. Action log
 * 7. Instant refresh after actions
 * 8. Circular seat layout
 * 9. Bet helper buttons (1/2 pot, pot, 2x)
 * 10. Turn timer
 */

'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { formatEther, parseEther } from 'viem'
import { useAccount, useReadContract, useReadContracts, useSendTransaction, useWriteContract } from 'wagmi'
import { useInterwovenKit } from '@initia/interwovenkit-react'
import { POKER_GAME_ADDRESS, POKER_GAME_ABI } from '../config/contract'
import { SESSION_GAS_RESERVE } from '../config/network'
import CashierModal from './CashierModal'
import { useWalletBalance } from '../hooks/useWalletBalance'
import { useSessionWallet, fisherYatesShuffle, getHoleCardsFromDeck } from '../hooks/useSessionWallet'

// -- Constants --
const STATUS_LABELS = ['Waiting','Dealing','Pre-Flop','Flop','Turn','River','Showdown','Settled'] as const
const ACTION_LABELS = ['','Fold','Check','Bet','Call','Raise','All-In'] as const
const HAND_RANKS = ['High Card','One Pair','Two Pair','Three of a Kind','Straight','Flush','Full House','Four of a Kind','Straight Flush','Royal Flush'] as const
const SUITS = ['\u2660','\u2665','\u2666','\u2663'] as const
const SUIT_COLORS = ['#ccc','#E07070','#7EAECF','#7ECFB3'] as const
const VALUES = ['','A','2','3','4','5','6','7','8','9','10','J','Q','K'] as const

// 6-max circular seat positions (percentage of felt container)
const SEAT_POS = [
  { top:'2%',  left:'50%' },  // 0: top center
  { top:'22%', left:'88%' },  // 1: right top
  { top:'68%', left:'85%' },  // 2: right bottom
  { top:'88%', left:'50%' },  // 3: bottom center
  { top:'68%', left:'15%' },  // 4: left bottom
  { top:'22%', left:'12%' },  // 5: left top
]

const TURN_TIMEOUT = 60 // seconds

// -- Card component --
function Card({ encoded, size = 'normal' }: { encoded: number; size?: 'normal' | 'large' }) {
  if (!encoded) return <span style={size === 'large' ? st.cardBackLg : st.cardBack}>?</span>
  const suit = encoded >> 4
  const value = encoded & 0x0f
  const s = size === 'large' ? st.cardLg : st.card
  return <span style={{ ...s, color: SUIT_COLORS[suit] }}>{VALUES[value]}{SUITS[suit]}</span>
}

function handRankName(rank: number): string {
  const cat = rank >> 24
  return HAND_RANKS[cat] ?? `Rank ${cat}`
}

// -- Player state type --
interface PState {
  addr: string
  stake: bigint
  currentBet: bigint
  lastAction: number
  isActive: boolean
  seatIndex: number
  hasRevealed: boolean
  handRank: number
}

// ==========================================================
//  BUY-IN MODAL
// ==========================================================

function BuyInModal({ bigBlind, gameBalance, onConfirm, onClose, isProcessing, sessionStatus }: {
  bigBlind: number; gameBalance: string; onConfirm: (a: number) => void; onClose: () => void
  isProcessing: boolean; sessionStatus: string
}) {
  const minBuy = bigBlind * 10
  const maxBuy = bigBlind * 100
  const gasRes = parseFloat(SESSION_GAS_RESERVE)
  const avail = Math.max(0, parseFloat(gameBalance))
  const effMax = Math.min(maxBuy, avail)
  const [val, setVal] = useState(Math.min(bigBlind * 50, effMax > minBuy ? effMax : minBuy))
  const canJoin = val >= minBuy && val <= effMax && !isProcessing

  return (
    <div style={st.overlay} onClick={!isProcessing ? onClose : undefined}>
      <div style={st.modal} onClick={e => e.stopPropagation()}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'16px'}}>
          <span style={{fontSize:'16px',fontWeight:600,color:'#fff'}}>Take a Seat</span>
          {!isProcessing && <button onClick={onClose} style={{background:'none',border:'none',color:'#555',fontSize:'18px',cursor:'pointer'}}>?</button>}
        </div>
        {isProcessing ? (
          <div style={{textAlign:'center',padding:'24px 0'}}>
            <div style={{fontSize:'13px',color:'#E8DCC8',marginBottom:'8px'}}>⏳ {sessionStatus||'Processing...'}</div>
            <div style={{fontSize:'11px',color:'#555'}}>Do not close this window</div>
          </div>
        ) : (<>
          <div style={{display:'flex',gap:'8px',marginBottom:'14px'}}>
            <div style={{flex:1,background:'#0F0F0F',borderRadius:'6px',padding:'8px',textAlign:'center'}}>
              <div style={{fontSize:'9px',color:'#555',textTransform:'uppercase',fontWeight:600}}>Big Blind</div>
              <div style={{fontSize:'14px',fontWeight:600,color:'#E8DCC8',marginTop:'2px'}}>{bigBlind}</div>
            </div>
            <div style={{flex:1,background:'#0F0F0F',borderRadius:'6px',padding:'8px',textAlign:'center'}}>
              <div style={{fontSize:'9px',color:'#555',textTransform:'uppercase',fontWeight:600}}>Game Balance</div>
              <div style={{fontSize:'14px',fontWeight:600,color:'#7ECFB3',marginTop:'2px'}}>{avail.toFixed(2)}</div>
            </div>
          </div>
          <div style={{textAlign:'center',margin:'10px 0'}}>
            <div style={{fontSize:'28px',fontWeight:700,color:'#fff',fontFamily:'"DM Mono",monospace'}}>{val.toFixed(1)}</div>
            <div style={{fontSize:'11px',color:'#555'}}>INIT {'\u00B7'} {Math.round(val/bigBlind)} bb</div>
          </div>
          <div style={{padding:'0 4px',margin:'14px 0'}}>
            <input type="range" min={minBuy} max={effMax>minBuy?effMax:minBuy+bigBlind} step={bigBlind} value={val}
              onChange={e=>setVal(Number(e.target.value))}
              style={{width:'100%',height:'4px',appearance:'none' as any,
                background:`linear-gradient(to right,#E8DCC8 ${((val-minBuy)/(effMax-minBuy||1))*100}%,#1C1C1C ${((val-minBuy)/(effMax-minBuy||1))*100}%)`,
                borderRadius:'2px',outline:'none',cursor:'pointer'}} />
            <div style={{display:'flex',justifyContent:'space-between',fontSize:'10px',color:'#3a3a3a',marginTop:'4px'}}>
              <span>{minBuy} (10bb)</span><span>{effMax>0?effMax.toFixed(1):maxBuy} (max)</span>
            </div>
          </div>
          <div style={{display:'flex',gap:'6px',marginBottom:'14px'}}>
            {[10,25,50,75,100].map(bb=>{
              const a=bigBlind*bb; if(a>effMax+bigBlind) return null
              return <button key={bb} onClick={()=>setVal(Math.min(a,effMax))} style={{flex:1,padding:'6px',fontSize:'10px',fontWeight:600,cursor:'pointer',fontFamily:'inherit',background:Math.abs(val-a)<bigBlind*0.5?'#E8DCC8':'#0F0F0F',color:Math.abs(val-a)<bigBlind*0.5?'#000':'#666',border:'1px solid #1C1C1C',borderRadius:'4px'}}>{bb}bb</button>
            })}
          </div>
          {avail<minBuy && <div style={{padding:'8px',background:'rgba(224,112,112,0.08)',border:'1px solid rgba(224,112,112,0.2)',borderRadius:'6px',fontSize:'11px',color:'#E07070',marginBottom:'12px'}}>Not enough game balance. Deposit via Cashier. Need {minBuy.toFixed(1)} INIT.</div>}
          <div style={{fontSize:'10px',color:'#555',marginBottom:'12px',lineHeight:1.5}}>
            Sign <b style={{color:'#E8DCC8'}}>one transaction</b> {'\u2192'} all poker actions fire instantly with zero popups. Remaining INIT returns when you leave.
          </div>
          <button onClick={()=>canJoin&&onConfirm(val)} disabled={!canJoin}
            style={{width:'100%',padding:'12px',fontSize:'14px',fontWeight:600,cursor:canJoin?'pointer':'not-allowed',fontFamily:'inherit',background:canJoin?'#E8DCC8':'#1C1C1C',color:canJoin?'#000':'#3a3a3a',border:'none',borderRadius:'8px'}}>
            Sit Down ? {val.toFixed(1)} INIT
          </button>
        </>)}
      </div>
    </div>
  )
}

// ==========================================================
//  MAIN COMPONENT
// ==========================================================

export default function PokerTable({ tableId = 0n, bigBlind = 0.2, tableName = 'Table', onBack }: {
  tableId?: bigint; bigBlind?: number; tableName?: string; onBack?: () => void
}) {
  const { address, isConnected } = useAccount()
  const { username, openConnect, openWallet } = useInterwovenKit()
  const { sendTransactionAsync } = useSendTransaction()
  const { writeContractAsync, isPending: legacyPending } = useWriteContract()
  const session = useSessionWallet()

  // UI state
  const [betAmount, setBetAmount] = useState('')
  const [lastTxHash, setLastTxHash] = useState<string|null>(null)
  const [localError, setLocalError] = useState<string|null>(null)
  const [cashierOpen, setCashierOpen] = useState(false)
  const [buyInOpen, setBuyInOpen] = useState(false)
  const [actionPending, setActionPending] = useState(false)
  const [holeCards, setHoleCards] = useState<[number,number]|null>(null)
  const [actionLog, setActionLog] = useState<string[]>([])
  const [turnTimer, setTurnTimer] = useState(TURN_TIMEOUT)
  const timerRef = useRef<any>(null)
  const logRef = useRef<HTMLDivElement>(null)

  const { walletBalance, gameBalance, isLoading: balLoading, refetch: refetchBal } = useWalletBalance(tableId)

  const playerAddr = (session.active && session.address) ? session.address as `0x${string}` : address
  const hasContract = POKER_GAME_ADDRESS !== '0x0000000000000000000000000000000000000000'

  // -- Read full session (includes deckSeed, activePlayerIndex) --
  const { data: fullSession, refetch: refetchFull } = useReadContract({
    address: POKER_GAME_ADDRESS, abi: POKER_GAME_ABI,
    functionName: 'sessions', args: [tableId],
    query: { enabled: hasContract, refetchInterval: 3000 },
  })

  const { data: players, refetch: refetchPlayers } = useReadContract({
    address: POKER_GAME_ADDRESS, abi: POKER_GAME_ABI,
    functionName: 'getPlayers', args: [tableId],
    query: { enabled: hasContract, refetchInterval: 3000 },
  })

  const { data: communityRaw } = useReadContract({
    address: POKER_GAME_ADDRESS, abi: POKER_GAME_ABI,
    functionName: 'getCommunityCards', args: [tableId],
    query: { enabled: hasContract, refetchInterval: 3000 },
  })

  // -- Read ALL player states via multicall --
  const playerAddrs = (players as readonly `0x${string}`[] | undefined) ?? []
  const playerStateContracts = playerAddrs.map(addr => ({
    address: POKER_GAME_ADDRESS, abi: POKER_GAME_ABI,
    functionName: 'getPlayerState' as const, args: [tableId, addr] as const,
  }))
  const { data: rawPlayerStates, refetch: refetchStates } = useReadContracts({
    contracts: playerStateContracts,
    query: { enabled: playerStateContracts.length > 0, refetchInterval: 3000 },
  })

  // -- Parse all data --
  const fs = fullSession as any
  const status = fs ? Number(fs[5]) : 0
  const dealerIndex = fs ? Number(fs[6]) : 0
  const activePlayerIdx = fs ? Number(fs[7]) : 0
  const playerCount = fs ? Number(fs[8]) : 0
  const pot = fs ? (fs[9] as bigint) : 0n
  const currentBet = fs ? (fs[10] as bigint) : 0n
  const smallBlind = fs ? (fs[11] as bigint) : 0n
  const vrfPending = fs ? Boolean(fs[13]) : false
  const deckSeed = fs ? (fs[15] as `0x${string}`) : null
  const communityCount = fs ? Number(fs[18]) : 0
  const saltsCommitted = fs ? Number(fs[19]) : 0

  const community = communityRaw
    ? (communityRaw as readonly number[]).filter((_, i) => i < communityCount)
    : []

  // Parse individual player states
  const allPlayers: PState[] = playerAddrs.map((addr, i) => {
    const r = rawPlayerStates?.[i]?.result as any
    return {
      addr: addr as string,
      stake: r ? (r[0] as bigint) : 0n,
      currentBet: r ? (r[1] as bigint) : 0n,
      lastAction: r ? Number(r[2]) : 0,
      isActive: r ? Boolean(r[3]) : false,
      seatIndex: r ? Number(r[4]) : i,
      hasRevealed: r ? Boolean(r[6]) : false,
      handRank: r ? Number(r[7]) : 0,
    }
  })

  // My player state
  const myPlayer = allPlayers.find(p => {
    const low = p.addr.toLowerCase()
    return low === address?.toLowerCase() || low === session.address?.toLowerCase()
  })
  const isSeated = myPlayer?.isActive ?? false
  const myStake = myPlayer?.stake ?? 0n
  const myBet = myPlayer?.currentBet ?? 0n
  const mySeatIndex = myPlayer?.seatIndex ?? 0
  const isMyTurn = status >= 2 && status <= 5 && isSeated &&
    allPlayers.length > 0 && activePlayerIdx < allPlayers.length &&
    allPlayers[activePlayerIdx]?.addr?.toLowerCase() === playerAddr?.toLowerCase()

  const isMe = (a: string) => {
    const low = a.toLowerCase()
    return low === address?.toLowerCase() || low === session.address?.toLowerCase()
  }

  const truncAddr = (a: string) => `${a.slice(0,6)}?${a.slice(-4)}`
  const error = localError || session.error

  // -- Hole card reconstruction from deckSeed --
  useEffect(() => {
    if (!deckSeed || deckSeed === '0x0000000000000000000000000000000000000000000000000000000000000000') {
      setHoleCards(null); return
    }
    if (status < 2 || !isSeated || playerCount === 0) {
      setHoleCards(null); return
    }
    try {
      const deck = fisherYatesShuffle(deckSeed)
      const cards = getHoleCardsFromDeck(deck, dealerIndex, mySeatIndex, playerCount)
      setHoleCards(cards)
    } catch { setHoleCards(null) }
  }, [deckSeed, dealerIndex, mySeatIndex, playerCount, status, isSeated])

  // -- Turn timer --
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current)
    if (isMyTurn) {
      setTurnTimer(TURN_TIMEOUT)
      timerRef.current = setInterval(() => setTurnTimer(t => Math.max(0, t - 1)), 1000)
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [isMyTurn, activePlayerIdx])

  // -- Auto-scroll action log --
  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight) }, [actionLog])

  // Winner detection
  const winner = status === 7 ? allPlayers.reduce((best, p) =>
    p.handRank > (best?.handRank ?? 0) ? p : best, null as PState | null) : null

  // -- Refresh helper --
  const refreshAll = useCallback(() => {
    refetchFull(); refetchPlayers(); refetchStates(); refetchBal()
  }, [refetchFull, refetchPlayers, refetchStates, refetchBal])

  const addLog = (msg: string) => setActionLog(prev => [...prev.slice(-19), `${new Date().toLocaleTimeString().slice(0,5)} ${msg}`])

  // ==========================================================
  //  ACTION HANDLERS
  // ==========================================================

  const doAction = async (fn: () => Promise<string|null>, label: string) => {
    setActionPending(true); setLocalError(null)
    const hash = await fn()
    if (hash) { setLastTxHash(hash); addLog(label) }
    setActionPending(false)
    setTimeout(refreshAll, 1000)
    setTimeout(refreshAll, 3000)
  }

  const handleSitDown = async (buyIn: number) => {
    setLocalError(null)
    try {
      const sessionAddr = await session.createSession(address!)
      const buyInWei = parseEther(buyIn.toString())
      const gasReserveWei = parseEther(SESSION_GAS_RESERVE)
      await sendTransactionAsync({ to: sessionAddr as `0x${string}`, value: buyInWei + gasReserveWei, gas: 100_000n, gasPrice: 1_000_000_000n })
      addLog(`Funding session wallet...`)
      const ok = await session.depositAndJoin(tableId, buyInWei)
      if (ok) { setBuyInOpen(false); addLog(`Seated with ${buyIn} INIT`); refreshAll() }
    } catch (err: any) { setLocalError(err.shortMessage ?? err.message) }
  }

  const handleLeave = async () => {
    setLocalError(null); addLog('Leaving table...')
    const ok = await session.leaveAndCashout(tableId)
    if (ok) { addLog('Left table. INIT returned.'); setHoleCards(null); refreshAll() }
  }

  const handleLegacyLeave = async () => {
    setLocalError(null)
    try {
      await writeContractAsync({ address: POKER_GAME_ADDRESS, abi: POKER_GAME_ABI,
        functionName: 'leaveTable', args: [tableId], gas: 500_000n, gasPrice: 1_000_000_000n })
      addLog('Left table (legacy)'); refreshAll()
    } catch (err: any) { setLocalError(err.shortMessage ?? err.message) }
  }

  const handleFold      = () => doAction(() => session.fold(tableId), 'You folded')
  const handleCheck     = () => doAction(() => session.check(tableId), 'You checked')
  const handleCall      = () => doAction(() => session.callAction(tableId), 'You called')
  const handleBet       = () => { const a=betAmount; doAction(() => session.bet(tableId, parseEther(a||'0')), `You bet ${a} INIT`) }
  const handleRaise     = () => { const a=betAmount; doAction(() => session.raise(tableId, parseEther(a||'0')), `You raised ${a} INIT`) }
  const handleAllIn     = () => doAction(() => session.allIn(tableId), 'You went ALL-IN!')
  const handleCommit    = () => doAction(() => session.commitSalt(tableId), 'Salt committed')
  const handleDeal      = () => doAction(() => session.requestDeal(tableId), 'Deal requested')
  const handleReveal    = () => doAction(() => session.revealCards(tableId), 'Cards revealed')
  const handleEvaluate  = () => doAction(() => session.evaluateShowdown(tableId), 'Showdown evaluated')

  const txBusy = actionPending || session.processing || legacyPending
  // Auto commit salt + deal when ready
  const autoRef = useRef(false)
  useEffect(() => {
    if (!session.active || !isSeated || txBusy || autoRef.current) return
    if ((status === 0 || status === 7) && playerCount >= 2) {
      if (saltsCommitted < playerCount) {
        autoRef.current = true
        handleCommit().then(() => { autoRef.current = false })
      } else if (saltsCommitted >= playerCount) {
        autoRef.current = true
        handleDeal().then(() => { autoRef.current = false })
      }
    }
  }, [session.active, isSeated, status, playerCount, saltsCommitted, txBusy])


  // Bet helpers
  const potF = parseFloat(formatEther(pot))
  const setBetHelper = (x: number) => setBetAmount(Math.max(parseFloat(formatEther(currentBet)) + 0.01, x).toFixed(2))

  // ==========================================================
  //  RENDER
  // ==========================================================

  return (
    <div style={st.root}>
      {/* HEADER */}
      <header style={st.header}>
        <div style={st.brand}>
          {onBack && <button onClick={onBack} style={st.btnBack}>{'\u2190'} Back</button>}
          <span style={{color:'#E8DCC8',fontSize:'14px'}}>?</span>
          <h1 style={st.title}>{tableName}</h1>
          <span style={st.badge}>{STATUS_LABELS[status]}</span>
          {session.active && <span style={st.sessionBadge}>{'\u25CF'} Session</span>}
        </div>
        <div style={st.headerRight}>
          {isConnected && <button onClick={()=>setCashierOpen(true)} style={st.btnCashier}>Cashier</button>}
          {isConnected ? <button onClick={openWallet} style={st.btnWallet}>{username??truncAddr(address!)}</button>
            : <button onClick={openConnect} style={st.btnConnect}>Connect Wallet</button>}
        </div>
      </header>

      {/* STATUS STRIP */}
      <div style={st.strip}>
        <span style={{...st.dot,background:isConnected?'#7ECFB3':'#E07070'}} />
        <span style={st.dim}>{isConnected?'Connected':'Disconnected'}</span>
        {isConnected && <span style={st.balVal}>Wallet: {balLoading?'?':walletBalance} INIT</span>}
        {isSeated && <span style={{color:'#E8DCC8',fontWeight:600}}>Stack: {formatEther(myStake)} INIT</span>}
        {isMyTurn && <span style={{color:'#7ECFB3',fontWeight:700,fontSize:'12px'}}>{'\u26A1'} YOUR TURN ({turnTimer}s)</span>}
      </div>

      {/* MESSAGES */}
      {session.status && !session.error && <div style={st.txBar}>{session.status}</div>}
      {error && <div style={st.errorBar}>{error}</div>}

      {/* WINNER BANNER */}
      {winner && status === 7 && (
        <div style={st.winnerBanner}>
          ?? {isMe(winner.addr) ? 'YOU WON!' : truncAddr(winner.addr) + ' wins'}
          {winner.handRank > 0 && ` ? ${handRankName(winner.handRank)}`}
          {pot > 0n && ` ? ${formatEther(pot)} INIT`}
        </div>
      )}

      {/* MAIN CONTENT: FELT + SIDEBAR */}
      <div style={{display:'flex',flex:1,overflow:'hidden'}}>

        {/* FELT TABLE */}
        <main style={st.felt}>
          {/* Pot */}
          <div style={st.potArea}>
            <div style={st.potLabel}>POT</div>
            <div style={st.potValue}>{pot ? formatEther(pot) : '?'}</div>
            {currentBet > 0n && <div style={{fontSize:'10px',color:'#555'}}>Bet: {formatEther(currentBet)} INIT</div>}
          </div>

          {/* Community cards */}
          <div style={st.communityArea}>
            {community.length > 0
              ? community.map((c,i) => <Card key={i} encoded={c} />)
              : <span style={{color:'#333',fontSize:'11px',fontStyle:'italic'}}>{status>=2?'Waiting for cards?':'No cards'}</span>}
          </div>

          {/* Hole cards (YOUR cards) */}
          {holeCards && (
            <div style={st.holeArea}>
              <Card encoded={holeCards[0]} size="large" />
              <Card encoded={holeCards[1]} size="large" />
            </div>
          )}

          {/* CIRCULAR SEATS */}
          <div style={st.seatsContainer}>
            {SEAT_POS.slice(0, Math.max(playerCount, 2) || 6).map((pos, seatIdx) => {
              const player = allPlayers.find(p => p.seatIndex === seatIdx)
              if (!player) return (
                <div key={seatIdx} style={{...st.seatWrap,...pos,transform:'translate(-50%,-50%)'}}>
                  <div style={st.emptySeat}>{seatIdx}</div>
                </div>
              )
              const me = isMe(player.addr)
              const isTurn = status >= 2 && status <= 5 && activePlayerIdx === seatIdx
              const isDealer = dealerIndex === seatIdx
              const isSB = (dealerIndex + 1) % playerCount === seatIdx
              const isBB = (dealerIndex + 2) % playerCount === seatIdx

              return (
                <div key={seatIdx} style={{...st.seatWrap,...pos,transform:'translate(-50%,-50%)'}}>
                  <div style={{...st.seatBox, ...(me?st.seatMe:{}), ...(isTurn?st.seatTurn:{}), ...(!player.isActive?{opacity:0.4}:{})}}>
                    {/* Markers */}
                    <div style={{display:'flex',gap:'3px',position:'absolute',top:'-10px',left:'50%',transform:'translateX(-50%)'}}>
                      {isDealer && <span style={st.markerD}>D</span>}
                      {isSB && <span style={st.markerSB}>SB</span>}
                      {isBB && <span style={st.markerBB}>BB</span>}
                    </div>
                    {/* Name */}
                    <div style={{fontSize:'10px',color:me?'#E8DCC8':'#888',fontWeight:me?600:400,fontFamily:'"DM Mono",monospace'}}>
                      {me ? 'You' : truncAddr(player.addr)}
                    </div>
                    {/* Stack */}
                    <div style={{fontSize:'12px',fontWeight:700,color:'#fff',fontFamily:'"DM Mono",monospace'}}>
                      {parseFloat(formatEther(player.stake)).toFixed(1)}
                    </div>
                    {/* Current bet */}
                    {player.currentBet > 0n && (
                      <div style={{fontSize:'9px',color:'#7ECFB3',fontWeight:600}}>
                        Bet: {parseFloat(formatEther(player.currentBet)).toFixed(2)}
                      </div>
                    )}
                    {/* Last action */}
                    {player.lastAction > 0 && (
                      <div style={{fontSize:'9px',color:player.lastAction===1?'#E07070':'#888',fontWeight:600}}>
                        {ACTION_LABELS[player.lastAction]}
                      </div>
                    )}
                    {/* Turn indicator */}
                    {isTurn && <div style={{fontSize:'8px',color:'#7ECFB3',fontWeight:700,marginTop:'2px'}}>{'\u23CE'} TURN</div>}
                  </div>
                </div>
              )
            })}
          </div>
          <div style={{fontSize:'10px',color:'#333',marginTop:'4px'}}>{playerCount} seated</div>
        </main>

        {/* ACTION LOG SIDEBAR */}
        <div style={st.sidebar}>
          <div style={{fontSize:'11px',fontWeight:600,color:'#555',marginBottom:'6px',textTransform:'uppercase',letterSpacing:'0.5px'}}>Action Log</div>
          <div ref={logRef} style={st.logScroll}>
            {actionLog.length === 0 ? <div style={{color:'#2a2a2a',fontSize:'10px'}}>No actions yet</div>
              : actionLog.map((l,i) => <div key={i} style={{fontSize:'10px',color:'#666',padding:'2px 0',borderBottom:'1px solid #0F0F0F'}}>{l}</div>)}
          </div>
          {/* Table info */}
          <div style={{marginTop:'auto',fontSize:'10px',color:'#333',borderTop:'1px solid #111',paddingTop:'8px'}}>
            <div>Blinds: {smallBlind ? formatEther(smallBlind) : bigBlind*0.5}/{smallBlind ? formatEther(smallBlind * 2n) : bigBlind} INIT</div>
            <div>Table #{tableId.toString()}</div>
            {session.address && <div>Session: {truncAddr(session.address)}</div>}
          </div>
        </div>
      </div>

      {/* ACTION BAR */}
      {isConnected && (
        <div style={st.actionBar}>
          {/* Legacy leave */}
          {isSeated && !session.active && (status===0||status===7) && (
            <button onClick={handleLegacyLeave} style={st.btnLeave} disabled={txBusy}>{legacyPending?'Leaving...':'Leave Table'}</button>
          )}

          {/* Sit Down */}
          {(status===0||status===7) && !isSeated && !session.processing && (
            <button onClick={()=>setBuyInOpen(true)} style={st.btnAction} disabled={txBusy}>Sit Down</button>
          )}

          {/* Auto commit/deal - handled by useEffect */}

          {/* Poker actions */}
          {status>=2 && status<=5 && isSeated && session.active && isMyTurn && (<>
            <button onClick={handleFold} style={st.btnFold} disabled={txBusy}>Fold</button>
            {currentBet === myBet
              ? <button onClick={handleCheck} style={st.btnAction} disabled={txBusy}>Check</button>
              : <button onClick={handleCall} style={st.btnAction} disabled={txBusy}>Call {formatEther(currentBet - myBet)}</button>}
            <div style={{display:'flex'}}>
              <input type="text" placeholder="INIT" value={betAmount} onChange={e=>setBetAmount(e.target.value)} style={st.input} />
              <button onClick={currentBet>0n?handleRaise:handleBet} style={st.btnRaise} disabled={txBusy}>{currentBet>0n?'Raise':'Bet'}</button>
            </div>
            <button onClick={handleAllIn} style={st.btnAllIn} disabled={txBusy}>All-In</button>
            {/* Bet helpers */}
            <div style={{display:'flex',gap:'4px'}}>
              <button onClick={()=>setBetHelper(potF*0.5)} style={st.btnHelper}>{'\u00BD'} Pot</button>
              <button onClick={()=>setBetHelper(potF)} style={st.btnHelper}>Pot</button>
              <button onClick={()=>setBetHelper(potF*2)} style={st.btnHelper}>2? Pot</button>
            </div>
          </>)}

          {/* Not your turn indicator */}
          {status>=2 && status<=5 && isSeated && session.active && !isMyTurn && (
            <span style={{fontSize:'11px',color:'#555'}}>Waiting for opponent...</span>
          )}

          {/* Showdown */}
          {status===6 && isSeated && session.active && (<>
            <button onClick={handleReveal} style={st.btnAction} disabled={txBusy}>Reveal Cards</button>
            <button onClick={handleEvaluate} style={st.btnAction} disabled={txBusy}>Evaluate</button>
          </>)}

          {/* Leave */}
          {isSeated && session.active && (status===0||status===7) && (
            <button onClick={handleLeave} style={st.btnLeave} disabled={txBusy}>{session.processing?'Leaving...':'Leave Table'}</button>
          )}

          {/* Recovery */}
          {session.active && !isSeated && session.address && (status===0||status===7) && (
            <button onClick={session.emergencyRecover} style={st.btnRecover}>Recover Funds</button>
          )}

          {txBusy && <span style={{color:'#E8DCC8',fontSize:'11px',fontWeight:600}}>Processing?</span>}
        </div>
      )}

      {/* MODALS */}
      {buyInOpen && <BuyInModal bigBlind={bigBlind} gameBalance={gameBalance} onConfirm={handleSitDown}
        onClose={()=>!session.processing&&setBuyInOpen(false)} isProcessing={session.processing} sessionStatus={session.status} />}
      <CashierModal isOpen={cashierOpen} onClose={()=>setCashierOpen(false)} walletBalance={walletBalance}
        gameBalance={gameBalance} isLoading={balLoading} onRefreshBalances={refetchBal} />

      <footer style={st.footer}>
        <span style={{color:'#2a2a2a'}}>INIPoker</span>
        <span style={{color:'#1C1C1C'}}>Session Wallet ? Band VRF ? Commit-Reveal</span>
      </footer>
    </div>
  )
}

// ==========================================================
//  STYLES
// ==========================================================
const st: Record<string,React.CSSProperties> = {
  root:{minHeight:'100vh',background:'#000',color:'#b0b0b0',fontFamily:'"DM Sans",sans-serif',display:'flex',flexDirection:'column'},
  header:{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 16px',borderBottom:'1px solid #161616'},
  brand:{display:'flex',alignItems:'center',gap:'8px'},
  btnBack:{background:'#111',color:'#666',border:'1px solid #1C1C1C',borderRadius:'6px',padding:'4px 10px',fontSize:'11px',cursor:'pointer',fontFamily:'inherit'},
  title:{fontSize:'15px',fontWeight:600,color:'#fff',margin:0},
  badge:{fontSize:'9px',fontWeight:600,color:'#7ECFB3',background:'rgba(126,207,179,0.08)',padding:'2px 8px',borderRadius:'4px'},
  sessionBadge:{fontSize:'9px',fontWeight:600,color:'#E8DCC8',background:'rgba(232,220,200,0.08)',padding:'2px 8px',borderRadius:'4px'},
  headerRight:{display:'flex',gap:'6px'},
  btnConnect:{background:'#E8DCC8',color:'#000',border:'none',borderRadius:'6px',padding:'7px 14px',fontSize:'11px',fontWeight:600,cursor:'pointer',fontFamily:'inherit'},
  btnCashier:{background:'#111',color:'#7ECFB3',border:'1px solid #1C1C1C',borderRadius:'6px',padding:'7px 12px',fontSize:'10px',fontWeight:600,cursor:'pointer',fontFamily:'inherit'},
  btnWallet:{background:'#111',color:'#ccc',border:'1px solid #1C1C1C',borderRadius:'6px',padding:'7px 12px',fontSize:'10px',cursor:'pointer',fontFamily:'"DM Mono",monospace'},

  strip:{display:'flex',alignItems:'center',gap:'12px',flexWrap:'wrap' as const,padding:'6px 16px',borderBottom:'1px solid #0F0F0F',fontSize:'11px'},
  dot:{width:'6px',height:'6px',borderRadius:'50%',flexShrink:0},
  dim:{color:'#3a3a3a'},
  balVal:{color:'#888',fontFamily:'"DM Mono",monospace'},

  txBar:{margin:'4px 16px 0',padding:'6px 12px',background:'rgba(126,207,179,0.04)',border:'1px solid rgba(126,207,179,0.1)',borderRadius:'6px',fontSize:'10px',color:'#7ECFB3'},
  errorBar:{margin:'4px 16px 0',padding:'6px 12px',background:'rgba(224,112,112,0.06)',border:'1px solid rgba(224,112,112,0.12)',borderRadius:'6px',fontSize:'10px',color:'#E07070'},

  winnerBanner:{margin:'4px 16px 0',padding:'10px 16px',background:'rgba(232,220,200,0.08)',border:'1px solid rgba(232,220,200,0.2)',borderRadius:'8px',fontSize:'14px',fontWeight:700,color:'#E8DCC8',textAlign:'center' as const},

  felt:{flex:1,margin:'8px',background:'radial-gradient(ellipse at center,#0F1A14 0%,#080E0B 60%,#000 100%)',border:'1px solid #1C1C1C',borderRadius:'100px / 70px',padding:'24px',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:'10px',minHeight:'320px',position:'relative' as const},

  potArea:{textAlign:'center' as const,zIndex:2},
  potLabel:{fontSize:'8px',color:'#555',letterSpacing:'3px',textTransform:'uppercase' as const},
  potValue:{fontSize:'22px',fontWeight:700,color:'#E8DCC8',fontFamily:'"DM Mono",monospace'},

  communityArea:{display:'flex',gap:'6px',justifyContent:'center',padding:'8px 0',zIndex:2},
  card:{display:'inline-flex',alignItems:'center',justifyContent:'center',width:'40px',height:'56px',borderRadius:'5px',background:'#fafaf8',fontWeight:700,fontSize:'13px',boxShadow:'0 2px 6px rgba(0,0,0,0.5)'},
  cardLg:{display:'inline-flex',alignItems:'center',justifyContent:'center',width:'52px',height:'72px',borderRadius:'6px',background:'#fafaf8',fontWeight:700,fontSize:'17px',boxShadow:'0 3px 10px rgba(0,0,0,0.6)'},
  cardBack:{display:'inline-flex',alignItems:'center',justifyContent:'center',width:'40px',height:'56px',borderRadius:'5px',background:'#111',color:'#333',fontSize:'18px',fontWeight:700,border:'1px solid #1C1C1C'},
  cardBackLg:{display:'inline-flex',alignItems:'center',justifyContent:'center',width:'52px',height:'72px',borderRadius:'6px',background:'#111',color:'#333',fontSize:'22px',fontWeight:700,border:'1px solid #1C1C1C'},

  holeArea:{display:'flex',gap:'6px',zIndex:2,padding:'4px 12px',background:'rgba(0,0,0,0.6)',borderRadius:'8px',border:'1px solid rgba(232,220,200,0.2)'},

  seatsContainer:{position:'absolute' as const,top:0,left:0,right:0,bottom:0},
  seatWrap:{position:'absolute' as const,zIndex:1},
  seatBox:{background:'#0A0A0A',border:'1px solid #1C1C1C',borderRadius:'8px',padding:'6px 10px',textAlign:'center' as const,minWidth:'80px',position:'relative' as const,transition:'all 0.3s'},
  seatMe:{border:'1px solid rgba(232,220,200,0.3)',background:'rgba(232,220,200,0.03)'},
  seatTurn:{border:'1px solid rgba(126,207,179,0.5)',boxShadow:'0 0 12px rgba(126,207,179,0.15)'},
  emptySeat:{width:'36px',height:'36px',borderRadius:'50%',border:'1px dashed #1C1C1C',display:'flex',alignItems:'center',justifyContent:'center',fontSize:'10px',color:'#1C1C1C'},

  markerD:{fontSize:'8px',fontWeight:700,color:'#000',background:'#E8DCC8',borderRadius:'50%',width:'16px',height:'16px',display:'flex',alignItems:'center',justifyContent:'center'},
  markerSB:{fontSize:'7px',fontWeight:700,color:'#7EAECF',background:'rgba(126,174,207,0.15)',borderRadius:'3px',padding:'1px 4px'},
  markerBB:{fontSize:'7px',fontWeight:700,color:'#E8DCC8',background:'rgba(232,220,200,0.15)',borderRadius:'3px',padding:'1px 4px'},

  sidebar:{width:'200px',background:'#0A0A0A',borderLeft:'1px solid #111',padding:'10px',display:'flex',flexDirection:'column',flexShrink:0,overflowY:'auto' as const},
  logScroll:{flex:1,overflowY:'auto' as const,maxHeight:'300px'},

  actionBar:{display:'flex',alignItems:'center',gap:'6px',flexWrap:'wrap' as const,padding:'10px 16px',borderTop:'1px solid #161616'},
  btnAction:{background:'#111',color:'#7ECFB3',border:'1px solid #1C1C1C',borderRadius:'6px',padding:'8px 14px',fontSize:'11px',fontWeight:600,cursor:'pointer',fontFamily:'inherit'},
  btnFold:{background:'rgba(224,112,112,0.06)',color:'#E07070',border:'1px solid rgba(224,112,112,0.15)',borderRadius:'6px',padding:'8px 14px',fontSize:'11px',fontWeight:600,cursor:'pointer',fontFamily:'inherit'},
  btnRaise:{background:'#E8DCC8',color:'#000',border:'none',borderRadius:'0 6px 6px 0',padding:'8px 14px',fontSize:'11px',fontWeight:600,cursor:'pointer',fontFamily:'inherit'},
  btnAllIn:{background:'rgba(232,220,200,0.06)',color:'#E8DCC8',border:'1px solid rgba(232,220,200,0.15)',borderRadius:'6px',padding:'8px 14px',fontSize:'11px',fontWeight:600,cursor:'pointer',fontFamily:'inherit'},
  btnLeave:{background:'rgba(224,112,112,0.06)',color:'#E07070',border:'1px solid rgba(224,112,112,0.15)',borderRadius:'6px',padding:'8px 14px',fontSize:'11px',fontWeight:600,cursor:'pointer',fontFamily:'inherit',marginLeft:'auto'},
  btnRecover:{background:'#111',color:'#555',border:'1px solid #1C1C1C',borderRadius:'5px',padding:'6px 10px',fontSize:'10px',cursor:'pointer',fontFamily:'inherit'},
  btnHelper:{background:'#0F0F0F',color:'#666',border:'1px solid #1C1C1C',borderRadius:'4px',padding:'5px 8px',fontSize:'9px',fontWeight:600,cursor:'pointer',fontFamily:'inherit'},
  input:{background:'#0A0A0A',border:'1px solid #1C1C1C',borderRadius:'6px 0 0 6px',borderRight:'none',padding:'8px 10px',color:'#fff',fontSize:'11px',fontFamily:'"DM Mono",monospace',width:'80px',outline:'none'},

  footer:{padding:'8px 16px',borderTop:'1px solid #0F0F0F',display:'flex',justifyContent:'space-between',fontSize:'10px'},

  overlay:{position:'fixed',top:0,left:0,right:0,bottom:0,background:'rgba(0,0,0,0.8)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000,backdropFilter:'blur(4px)'},
  modal:{background:'#0A0A0A',border:'1px solid #1C1C1C',borderRadius:'12px',padding:'22px',width:'380px',maxWidth:'92vw',fontFamily:'"DM Sans",sans-serif'},
}






