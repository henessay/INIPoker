/**
 * PokerTable.tsx — Full poker UI v2
 *
 * Changes from v1:
 * - All actions via Keplr writeContractAsync (reliable, 1 popup per action)
 * - Auto-continue: after hand settles, auto commit+deal for next hand
 * - Auto reveal+evaluate at showdown
 * - Leave table: leaveTable() + withdraw() returns all funds
 * - Smooth card animations with CSS keyframes
 * - Player always at bottom of table (seat rotation)
 * - Turn timer with visual countdown
 * - Fixed all Unicode symbols
 */

'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { formatEther, parseEther, keccak256, toHex } from 'viem'
import { useAccount, useReadContract, useReadContracts, useWriteContract } from 'wagmi'
import { useInterwovenKit } from '@initia/interwovenkit-react'
import { POKER_GAME_ADDRESS, POKER_GAME_ABI } from '../config/contract'
import CashierModal from './CashierModal'
import { useWalletBalance } from '../hooks/useWalletBalance'
import { fisherYatesShuffle, getHoleCardsFromDeck } from '../hooks/useSessionWallet'

// ── Constants ──
const STATUS_LABELS = ['Waiting','Dealing','Pre-Flop','Flop','Turn','River','Showdown','Settled'] as const
const ACTION_LABELS = ['','Fold','Check','Bet','Call','Raise','All-In'] as const
const HAND_RANKS = ['High Card','One Pair','Two Pair','Three of a Kind','Straight','Flush','Full House','Four of a Kind','Straight Flush','Royal Flush'] as const
const SUITS = ['\u2660','\u2665','\u2666','\u2663'] as const
const SUIT_COLORS = ['#ccc','#E07070','#7EAECF','#7ECFB3'] as const
const VALUES = ['','A','2','3','4','5','6','7','8','9','10','J','Q','K'] as const
const GAS = 500_000n
const GAS_PRICE = 1_000_000_000n
const TURN_TIMEOUT = 45

// 6-max circular seat positions
const SEAT_POSITIONS = [
  { top:'2%',  left:'50%' },
  { top:'22%', left:'88%' },
  { top:'68%', left:'85%' },
  { top:'88%', left:'50%' },
  { top:'68%', left:'15%' },
  { top:'22%', left:'12%' },
]

function getRotatedPos(seatIdx: number, mySeat: number): {top:string,left:string} {
  const offset = (3 - mySeat + 6) % 6
  const visualIdx = (seatIdx + offset) % 6
  return SEAT_POSITIONS[visualIdx] || SEAT_POSITIONS[0]
}

// ── CSS Animations ──
const ANIM_CSS = `
@keyframes dealHole {
  0% { opacity:0; transform:translateX(-50%) translateY(-60px) scale(0.3); }
  60% { opacity:1; transform:translateX(-50%) translateY(5px) scale(1.05); }
  100% { opacity:1; transform:translateX(-50%) translateY(0) scale(1); }
}
@keyframes dealCommunity {
  0% { opacity:0; transform:rotateY(180deg) scale(0.5); }
  50% { opacity:1; transform:rotateY(90deg) scale(0.9); }
  100% { opacity:1; transform:rotateY(0deg) scale(1); }
}
@keyframes winnerGlow {
  0%, 100% { box-shadow: 0 0 10px rgba(232,220,200,0.3); }
  50% { box-shadow: 0 0 30px rgba(232,220,200,0.6); }
}
@keyframes fadeIn {
  from { opacity:0; transform:translateY(-10px); }
  to { opacity:1; transform:translateY(0); }
}
@keyframes pulseGreen {
  0%, 100% { box-shadow: 0 0 5px rgba(126,207,179,0.2); }
  50% { box-shadow: 0 0 15px rgba(126,207,179,0.5); }
}
@keyframes timerPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
`

// ── Card Component ──
function Card({ encoded, size = 'normal', delay = 0 }: { encoded: number; size?: 'normal' | 'large'; delay?: number }) {
  if (!encoded) return <span style={size === 'large' ? st.cardBackLg : st.cardBack}>?</span>
  const suit = encoded >> 4
  const value = encoded & 0x0f
  const s = size === 'large' ? st.cardLg : st.card
  return (
    <span style={{
      ...s,
      color: SUIT_COLORS[suit],
      animation: size === 'large' ? `dealHole 0.6s ease-out ${delay}s both` : `dealCommunity 0.5s ease-out ${delay}s both`,
    }}>
      {VALUES[value]}{SUITS[suit]}
    </span>
  )
}

function handRankName(rank: number): string {
  const cat = rank >> 24
  return HAND_RANKS[cat] ?? `Rank ${cat}`
}

// ── Types ──
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

// ══════════════════════════════════════════
//  BUY-IN MODAL
// ══════════════════════════════════════════

function BuyInModal({ bigBlind, available, onConfirm, onClose, isProcessing }: {
  bigBlind: number; available: string; onConfirm: (a: number) => void; onClose: () => void
  isProcessing: boolean
}) {
  const minBuy = bigBlind * 10
  const maxBuy = bigBlind * 100
  const avail = Math.max(0, parseFloat(available))
  const effMax = Math.min(maxBuy, avail)
  const [val, setVal] = useState(Math.min(bigBlind * 50, effMax > minBuy ? effMax : minBuy))
  const canJoin = val >= minBuy && val <= effMax && !isProcessing

  return (
    <div style={st.overlay} onClick={!isProcessing ? onClose : undefined}>
      <div style={{...st.modal, animation: 'fadeIn 0.3s ease-out'}} onClick={e => e.stopPropagation()}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'16px'}}>
          <span style={{fontSize:'16px',fontWeight:600,color:'#fff'}}>Take a Seat</span>
          {!isProcessing && <button onClick={onClose} style={{background:'none',border:'none',color:'#555',fontSize:'18px',cursor:'pointer'}}>{'\u2715'}</button>}
        </div>
        {isProcessing ? (
          <div style={{textAlign:'center',padding:'24px 0'}}>
            <div style={{fontSize:'13px',color:'#E8DCC8',marginBottom:'8px'}}>Confirm in Keplr...</div>
            <div style={{fontSize:'11px',color:'#555'}}>2 transactions: deposit + join table</div>
          </div>
        ) : (<>
          <div style={{display:'flex',gap:'8px',marginBottom:'14px'}}>
            <div style={{flex:1,background:'#0F0F0F',borderRadius:'6px',padding:'8px',textAlign:'center'}}>
              <div style={{fontSize:'9px',color:'#555',textTransform:'uppercase',fontWeight:600}}>Big Blind</div>
              <div style={{fontSize:'14px',fontWeight:600,color:'#E8DCC8',marginTop:'2px'}}>{bigBlind}</div>
            </div>
            <div style={{flex:1,background:'#0F0F0F',borderRadius:'6px',padding:'8px',textAlign:'center'}}>
              <div style={{fontSize:'9px',color:'#555',textTransform:'uppercase',fontWeight:600}}>Available</div>
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
          {avail<minBuy && <div style={{padding:'8px',background:'rgba(224,112,112,0.08)',border:'1px solid rgba(224,112,112,0.2)',borderRadius:'6px',fontSize:'11px',color:'#E07070',marginBottom:'12px'}}>Not enough balance. Need {minBuy.toFixed(1)} INIT.</div>}
          <button onClick={()=>canJoin&&onConfirm(val)} disabled={!canJoin}
            style={{width:'100%',padding:'12px',fontSize:'14px',fontWeight:600,cursor:canJoin?'pointer':'not-allowed',fontFamily:'inherit',background:canJoin?'#E8DCC8':'#1C1C1C',color:canJoin?'#000':'#3a3a3a',border:'none',borderRadius:'8px'}}>
            Sit Down {'\u00B7'} {val.toFixed(1)} INIT
          </button>
        </>)}
      </div>
    </div>
  )
}

// ══════════════════════════════════════════
//  MAIN COMPONENT
// ══════════════════════════════════════════

export default function PokerTable({ tableId = 0n, bigBlind = 0.2, tableName = 'Table', onBack }: {
  tableId?: bigint; bigBlind?: number; tableName?: string; onBack?: () => void
}) {
  const { address, isConnected } = useAccount()
  const { username, openConnect, openWallet } = useInterwovenKit()
  const { writeContractAsync, isPending } = useWriteContract()

  const [betAmount, setBetAmount] = useState('')
  const [localError, setLocalError] = useState<string|null>(null)
  const [localStatus, setLocalStatus] = useState<string|null>(null)
  const [cashierOpen, setCashierOpen] = useState(false)
  const [buyInOpen, setBuyInOpen] = useState(false)
  const [actionPending, setActionPending] = useState(false)
  const [holeCards, setHoleCards] = useState<[number,number]|null>(null)
  const [actionLog, setActionLog] = useState<string[]>([])
  const [turnTimer, setTurnTimer] = useState(TURN_TIMEOUT)
  const timerRef = useRef<any>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const autoActionRef = useRef(false)
  const prevStatusRef = useRef(0)

  const { walletBalance, gameBalance, isLoading: balLoading, refetch: refetchBal } = useWalletBalance(tableId)
  const hasContract = POKER_GAME_ADDRESS !== '0x0000000000000000000000000000000000000000'

  // ── Inject CSS ──
  useEffect(() => {
    const id = 'inipoker-anims'
    if (!document.getElementById(id)) {
      const el = document.createElement('style')
      el.id = id; el.textContent = ANIM_CSS
      document.head.appendChild(el)
    }
  }, [])

  // ── Contract reads ──
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

  const playerAddrs = (players as readonly `0x${string}`[] | undefined) ?? []
  const playerStateContracts = playerAddrs.map(addr => ({
    address: POKER_GAME_ADDRESS, abi: POKER_GAME_ABI,
    functionName: 'getPlayerState' as const, args: [tableId, addr] as const,
  }))
  const { data: rawPlayerStates, refetch: refetchStates } = useReadContracts({
    contracts: playerStateContracts,
    query: { enabled: playerStateContracts.length > 0, refetchInterval: 3000 },
  })

  // ── Parse ──
  const fs = fullSession as any
  const status = fs ? Number(fs[5]) : 0
  const dealerIndex = fs ? Number(fs[6]) : 0
  const activePlayerIdx = fs ? Number(fs[7]) : 0
  const playerCount = fs ? Number(fs[8]) : 0
  const pot = fs ? (fs[9] as bigint) : 0n
  const currentBet = fs ? (fs[10] as bigint) : 0n
  const smallBlind = fs ? (fs[11] as bigint) : 0n
  const deckSeed = fs ? (fs[15] as `0x${string}`) : null
  const communityCount = fs ? Number(fs[18]) : 0
  const saltsCommitted = fs ? Number(fs[19]) : 0

  const community = communityRaw
    ? (communityRaw as readonly number[]).filter((_, i) => i < communityCount)
    : []

  const allPlayers: PState[] = playerAddrs.map((addr, i) => {
    const r = rawPlayerStates?.[i]?.result as any
    return {
      addr: addr as string, stake: r ? (r[0] as bigint) : 0n,
      currentBet: r ? (r[1] as bigint) : 0n, lastAction: r ? Number(r[2]) : 0,
      isActive: r ? Boolean(r[3]) : false, seatIndex: r ? Number(r[4]) : i,
      hasRevealed: r ? Boolean(r[6]) : false, handRank: r ? Number(r[7]) : 0,
    }
  })

  const myPlayer = allPlayers.find(p => p.addr.toLowerCase() === address?.toLowerCase())
  const isSeated = myPlayer?.isActive ?? false
  const myStake = myPlayer?.stake ?? 0n
  const myBet = myPlayer?.currentBet ?? 0n
  const mySeatIndex = myPlayer?.seatIndex ?? 0
  const isMyTurn = status >= 2 && status <= 5 && isSeated &&
    allPlayers.length > 0 && activePlayerIdx < allPlayers.length &&
    allPlayers[activePlayerIdx]?.addr?.toLowerCase() === address?.toLowerCase()

  const isMe = (a: string) => a.toLowerCase() === address?.toLowerCase()
  const truncAddr = (a: string) => `${a.slice(0,6)}\u2026${a.slice(-4)}`
  const txBusy = actionPending || isPending

  const winner = status === 7 ? allPlayers.reduce((best, p) =>
    p.handRank > (best?.handRank ?? 0) ? p : best, null as PState | null) : null

  // ── Hole cards ──
  useEffect(() => {
    if (!deckSeed || deckSeed === '0x0000000000000000000000000000000000000000000000000000000000000000') { setHoleCards(null); return }
    if (status < 2 || !isSeated || playerCount === 0) { setHoleCards(null); return }
    try {
      const deck = fisherYatesShuffle(deckSeed)
      setHoleCards(getHoleCardsFromDeck(deck, dealerIndex, mySeatIndex, playerCount))
    } catch { setHoleCards(null) }
  }, [deckSeed, dealerIndex, mySeatIndex, playerCount, status, isSeated])

  // ── Turn timer ──
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current)
    if (isMyTurn) {
      setTurnTimer(TURN_TIMEOUT)
      timerRef.current = setInterval(() => setTurnTimer(t => Math.max(0, t - 1)), 1000)
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [isMyTurn, activePlayerIdx])

  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight) }, [actionLog])

  const refreshAll = useCallback(() => {
    refetchFull(); refetchPlayers(); refetchStates(); refetchBal()
  }, [refetchFull, refetchPlayers, refetchStates, refetchBal])

  const addLog = (msg: string) => setActionLog(prev => [...prev.slice(-29), `${new Date().toLocaleTimeString().slice(0,5)} ${msg}`])

  // ══════════════════════════════════════════
  //  ACTIONS (all Keplr)
  // ══════════════════════════════════════════

  const doAction = async (fnName: string, args: unknown[], label: string, value?: bigint) => {
    setActionPending(true); setLocalError(null)
    try {
      await writeContractAsync({ address: POKER_GAME_ADDRESS, abi: POKER_GAME_ABI, functionName: fnName, args, gas: GAS, gasPrice: GAS_PRICE, ...(value ? { value } : {}) } as any)
      addLog(label)
    } catch (err: any) { console.error(fnName, err); setLocalError(err.shortMessage ?? err.message) }
    setActionPending(false)
    setTimeout(refreshAll, 1500)
    setTimeout(refreshAll, 4000)
  }

  const handleSitDown = async (buyIn: number) => {
    setLocalError(null)
    try {
      const buyInWei = parseEther(buyIn.toString())
      setBuyInOpen(false); setLocalStatus("Depositing...")
      await writeContractAsync({ address: POKER_GAME_ADDRESS, abi: POKER_GAME_ABI, functionName: "deposit", args: [], value: buyInWei, gas: GAS, gasPrice: GAS_PRICE })
      setLocalStatus("Joining table...")
      await writeContractAsync({ address: POKER_GAME_ADDRESS, abi: POKER_GAME_ABI, functionName: "joinTable", args: [tableId, buyInWei], gas: GAS, gasPrice: GAS_PRICE })
      addLog(`Seated with ${buyIn} INIT`); setLocalStatus(null); refreshAll()
    } catch (err: any) { console.error("SitDown:", err); setLocalError(err.shortMessage ?? err.message); setLocalStatus(null) }
  }

  const handleLeave = async () => {
    setLocalError(null); setLocalStatus("Leaving...")
    try {
      await writeContractAsync({ address: POKER_GAME_ADDRESS, abi: POKER_GAME_ABI, functionName: "leaveTable", args: [tableId], gas: GAS, gasPrice: GAS_PRICE })
      addLog("Left table"); setHoleCards(null); setLocalStatus(null); refreshAll()
    } catch (err: any) { console.error("Leave:", err); setLocalError(err.shortMessage ?? err.message); setLocalStatus(null) }
  }

  const handleFold  = () => doAction("playerAction", [tableId, 1, 0n], "You folded")
  const handleCheck = () => doAction("playerAction", [tableId, 2, 0n], "You checked")
  const handleCall  = () => doAction("playerAction", [tableId, 4, 0n], "You called")
  const handleBet   = () => { const a=betAmount; doAction("playerAction", [tableId, 3, parseEther(a||"0")], `You bet ${a} INIT`) }
  const handleRaise = () => { const a=betAmount; doAction("playerAction", [tableId, 5, parseEther(a||"0")], `You raised ${a} INIT`) }
  const handleAllIn = () => doAction("playerAction", [tableId, 6, 0n], "You went ALL-IN!")

  const handleCommit = async () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    const hex = toHex(bytes)
    const hash = keccak256(hex as `0x${string}`)
    sessionStorage.setItem(`inipoker_salt_${tableId}`, hex)
    await doAction("commitSalt", [tableId, hash], "Salt committed")
  }
  const handleDeal = () => doAction("requestDeal", [tableId], "Deal requested")
  const handleReveal = async () => {
    const salt = sessionStorage.getItem(`inipoker_salt_${tableId}`)
    if (!salt) { setLocalError("Salt not found"); return }
    await doAction("revealHoleCards", [tableId, salt as `0x${string}`], "Cards revealed")
  }
  const handleEvaluate = () => doAction("evaluateShowdown", [tableId], "Showdown evaluated")
  // Auto-actions - locked by last processed status to prevent loops
  const lastAutoStatusRef = useRef<string>("")
  useEffect(() => {
    if (autoActionRef.current || txBusy || !isSeated) return
    const stateKey = `${status}-${saltsCommitted}-${playerCount}`
    if (lastAutoStatusRef.current === stateKey) return

    // Auto commit when waiting with 2+ players
    if ((status === 0 || status === 7) && playerCount >= 2 && saltsCommitted < playerCount) {
      const existing = sessionStorage.getItem(`inipoker_salt_${tableId}`)
      if (!existing) {
        lastAutoStatusRef.current = stateKey
        autoActionRef.current = true
        handleCommit().finally(() => { setTimeout(() => { autoActionRef.current = false; refreshAll() }, 3000) })
        return
      }
    }
    // Auto deal
    if ((status === 0 || status === 7) && playerCount >= 2 && saltsCommitted >= playerCount) {
      lastAutoStatusRef.current = stateKey
      autoActionRef.current = true
      handleDeal().finally(() => { setTimeout(() => { autoActionRef.current = false; refreshAll() }, 3000) })
      return
    }
    // Auto reveal
    if (status === 6 && isSeated) {
      const myP = allPlayers.find(p => p.addr.toLowerCase() === address?.toLowerCase())
      if (myP && !myP.hasRevealed) {
        lastAutoStatusRef.current = stateKey + "-reveal"
        autoActionRef.current = true
        handleReveal().finally(() => { setTimeout(() => { autoActionRef.current = false; refreshAll() }, 3000) })
        return
      }
    }
    // Auto evaluate
    if (status === 6) {
      const active = allPlayers.filter(p => p.isActive)
      if (active.length > 0 && active.every(p => p.hasRevealed)) {
        lastAutoStatusRef.current = stateKey + "-eval"
        autoActionRef.current = true
        handleEvaluate().finally(() => { setTimeout(() => { autoActionRef.current = false; refreshAll() }, 3000) })
        return
      }
    }
    // Clear salt for next hand
    if (status === 7 && prevStatusRef.current !== 7) sessionStorage.removeItem(`inipoker_salt_${tableId}`)
    prevStatusRef.current = status
  }, [status, playerCount, saltsCommitted, isSeated, txBusy])
  const potF = parseFloat(formatEther(pot))
  const setBetHelper = (x: number) => setBetAmount(Math.max(parseFloat(formatEther(currentBet)) + 0.01, x).toFixed(2))
  const timerPct = isMyTurn ? (turnTimer / TURN_TIMEOUT) * 100 : 0
  const timerColor = turnTimer > 20 ? '#7ECFB3' : turnTimer > 10 ? '#E8DCC8' : '#E07070'

  // ══════════════════════════════════════════
  //  RENDER
  // ══════════════════════════════════════════
  return (
    <div style={st.root}>
      <header style={st.header}>
        <div style={st.brand}>
          {onBack && <button onClick={onBack} style={st.btnBack}>{'\u2190'} Back</button>}
          <span style={{color:'#E8DCC8',fontSize:'14px'}}>{'\u25C6'}</span>
          <h1 style={st.title}>{tableName}</h1>
          <span style={st.badge}>{STATUS_LABELS[status]}</span>
        </div>
        <div style={st.headerRight}>
          {isConnected && <button onClick={()=>setCashierOpen(true)} style={st.btnCashier}>Cashier</button>}
          {isConnected ? <button onClick={openWallet} style={st.btnWallet}>{username??truncAddr(address!)}</button>
            : <button onClick={openConnect} style={st.btnConnect}>Connect Wallet</button>}
        </div>
      </header>

      <div style={st.strip}>
        <span style={{...st.dot,background:isConnected?'#7ECFB3':'#E07070'}} />
        <span style={st.dim}>{isConnected?'Connected':'Disconnected'}</span>
        {isConnected && <span style={st.balVal}>Game: {balLoading?'...':gameBalance} INIT</span>}
        {isSeated && <span style={{color:'#E8DCC8',fontWeight:600}}>Stack: {parseFloat(formatEther(myStake)).toFixed(1)} INIT</span>}
      </div>

      {isMyTurn && <div style={{height:'3px',background:'#111',margin:'0 16px'}}><div style={{height:'100%',width:`${timerPct}%`,background:timerColor,transition:'width 1s linear',borderRadius:'2px'}} /></div>}

      {localStatus && <div style={st.txBar}>{localStatus}</div>}
      {localError && <div style={st.errorBar}>{localError}</div>}

      {winner && status === 7 && (
        <div style={{...st.winnerBanner, animation:'winnerGlow 1.5s ease-in-out infinite'}}>
          {isMe(winner.addr) ? 'YOU WON!' : truncAddr(winner.addr) + ' wins'}
          {winner.handRank > 0 && ` \u2014 ${handRankName(winner.handRank)}`}
          {pot > 0n && ` \u2014 ${formatEther(pot)} INIT`}
        </div>
      )}

      {isMyTurn && (
        <div style={{textAlign:'center',padding:'4px',fontSize:'13px',fontWeight:700,color:'#7ECFB3',animation:'timerPulse 1s ease-in-out infinite'}}>
          {'\u26A1'} YOUR TURN ({turnTimer}s)
        </div>
      )}

      <div style={{display:'flex',flex:1,overflow:'hidden'}}>
        <main style={st.felt}>
          <div style={st.potArea}>
            <div style={st.potLabel}>POT</div>
            <div style={st.potValue}>{pot ? parseFloat(formatEther(pot)).toFixed(1) : '\u2014'}</div>
            {currentBet > 0n && <div style={{fontSize:'10px',color:'#555'}}>Bet: {parseFloat(formatEther(currentBet)).toFixed(2)} INIT</div>}
          </div>

          <div style={st.communityArea}>
            {community.length > 0
              ? community.map((c,i) => <Card key={`${c}-${i}`} encoded={c} delay={i * 0.15} />)
              : <span style={{color:'#333',fontSize:'11px',fontStyle:'italic'}}>{status>=2?'Dealing...':'No cards'}</span>}
          </div>

          {holeCards && (
            <div style={st.holeArea}>
              <Card encoded={holeCards[0]} size="large" delay={0} />
              <Card encoded={holeCards[1]} size="large" delay={0.2} />
            </div>
          )}

          <div style={st.seatsContainer}>
            {Array.from({length: Math.max(playerCount, 2) || 6}, (_, i) => i).map((seatIdx) => {
              const player = allPlayers.find(p => p.seatIndex === seatIdx)
              if (!player) return (
                <div key={seatIdx} style={{...st.seatWrap,...getRotatedPos(seatIdx, mySeatIndex),transform:'translate(-50%,-50%)'}}>
                  <div style={st.emptySeat}>{seatIdx}</div>
                </div>
              )
              const me = isMe(player.addr)
              const isTurn = status >= 2 && status <= 5 && activePlayerIdx === seatIdx
              const isDealer = dealerIndex === seatIdx
              const isSB = playerCount > 0 && (dealerIndex + 1) % playerCount === seatIdx
              const isBB = playerCount > 0 && (dealerIndex + 2) % playerCount === seatIdx
              const isW = winner?.addr?.toLowerCase() === player.addr.toLowerCase() && status === 7

              return (
                <div key={seatIdx} style={{...st.seatWrap,...getRotatedPos(seatIdx, mySeatIndex),transform:'translate(-50%,-50%)'}}>
                  <div style={{...st.seatBox, ...(me?st.seatMe:{}), ...(isTurn?st.seatTurn:{}), ...(isW?{animation:'winnerGlow 1.5s infinite',border:'1px solid #E8DCC8'}:{}), ...(!player.isActive?{opacity:0.4}:{})}}>
                    <div style={{display:'flex',gap:'3px',position:'absolute',top:'-10px',left:'50%',transform:'translateX(-50%)'}}>
                      {isDealer && <span style={st.markerD}>D</span>}
                      {isSB && <span style={st.markerSB}>SB</span>}
                      {isBB && <span style={st.markerBB}>BB</span>}
                    </div>
                    <div style={{fontSize:'10px',color:me?'#E8DCC8':'#888',fontWeight:me?600:400,fontFamily:'"DM Mono",monospace'}}>{me ? 'You' : truncAddr(player.addr)}</div>
                    <div style={{fontSize:'12px',fontWeight:700,color:'#fff',fontFamily:'"DM Mono",monospace'}}>{parseFloat(formatEther(player.stake)).toFixed(1)}</div>
                    {player.currentBet > 0n && <div style={{fontSize:'9px',color:'#7ECFB3',fontWeight:600}}>Bet: {parseFloat(formatEther(player.currentBet)).toFixed(2)}</div>}
                    {player.lastAction > 0 && <div style={{fontSize:'9px',color:player.lastAction===1?'#E07070':'#888',fontWeight:600}}>{ACTION_LABELS[player.lastAction]}</div>}
                    {isTurn && <div style={{fontSize:'8px',color:'#7ECFB3',fontWeight:700,marginTop:'2px',animation:'timerPulse 1s infinite'}}>{'\u23CE'} TURN</div>}
                  </div>
                </div>
              )
            })}
          </div>
          <div style={{fontSize:'10px',color:'#333',marginTop:'4px'}}>{playerCount} seated</div>
        </main>

        <div style={st.sidebar}>
          <div style={{fontSize:'11px',fontWeight:600,color:'#555',marginBottom:'6px',textTransform:'uppercase',letterSpacing:'0.5px'}}>Action Log</div>
          <div ref={logRef} style={st.logScroll}>
            {actionLog.length === 0 ? <div style={{color:'#2a2a2a',fontSize:'10px'}}>No actions yet</div>
              : actionLog.map((l,i) => <div key={i} style={{fontSize:'10px',color:'#666',padding:'2px 0',borderBottom:'1px solid #0F0F0F'}}>{l}</div>)}
          </div>
          <div style={{marginTop:'auto',fontSize:'10px',color:'#333',borderTop:'1px solid #111',paddingTop:'8px'}}>
            <div>Blinds: {smallBlind ? parseFloat(formatEther(smallBlind)).toFixed(1) : bigBlind*0.5}/{smallBlind ? parseFloat(formatEther(smallBlind * 2n)).toFixed(1) : bigBlind} INIT</div>
            <div>Table #{tableId.toString()}</div>
          </div>
        </div>
      </div>

      {isConnected && (
        <div style={st.actionBar}>
          {(status===0||status===7) && !isSeated && (
            <button onClick={()=>setBuyInOpen(true)} style={st.btnAction} disabled={txBusy}>Sit Down</button>
          )}

          {(status===0||status===7) && isSeated && playerCount >= 2 && (<>
            {saltsCommitted < playerCount && <button onClick={handleCommit} style={{...st.btnAction,opacity:0.6,fontSize:'10px'}} disabled={txBusy}>Commit Salt</button>}
            {saltsCommitted >= playerCount && <button onClick={handleDeal} style={{...st.btnAction,opacity:0.6,fontSize:'10px'}} disabled={txBusy}>Deal</button>}
          </>)}

          {status>=2 && status<=5 && isSeated && isMyTurn && (<>
            <button onClick={handleFold} style={st.btnFold} disabled={txBusy}>Fold</button>
            {currentBet === myBet
              ? <button onClick={handleCheck} style={{...st.btnAction,animation:'pulseGreen 2s infinite'}} disabled={txBusy}>Check</button>
              : <button onClick={handleCall} style={{...st.btnAction,animation:'pulseGreen 2s infinite'}} disabled={txBusy}>Call {parseFloat(formatEther(currentBet - myBet)).toFixed(2)}</button>}
            <div style={{display:'flex'}}>
              <input type="text" placeholder="INIT" value={betAmount} onChange={e=>setBetAmount(e.target.value)} style={st.input} />
              <button onClick={currentBet>0n?handleRaise:handleBet} style={st.btnRaise} disabled={txBusy}>{currentBet>0n?'Raise':'Bet'}</button>
            </div>
            <button onClick={handleAllIn} style={st.btnAllIn} disabled={txBusy}>All-In</button>
            <div style={{display:'flex',gap:'4px'}}>
              <button onClick={()=>setBetHelper(potF*0.5)} style={st.btnHelper}>{'\u00BD'} Pot</button>
              <button onClick={()=>setBetHelper(potF)} style={st.btnHelper}>Pot</button>
              <button onClick={()=>setBetHelper(potF*2)} style={st.btnHelper}>2x Pot</button>
            </div>
          </>)}

          {status>=2 && status<=5 && isSeated && !isMyTurn && <span style={{fontSize:'11px',color:'#555'}}>Waiting for opponent...</span>}

          {status===6 && isSeated && (<>
            <button onClick={handleReveal} style={{...st.btnAction,fontSize:'10px'}} disabled={txBusy}>Reveal</button>
            <button onClick={handleEvaluate} style={{...st.btnAction,fontSize:'10px'}} disabled={txBusy}>Evaluate</button>
          </>)}

          {isSeated && (status===0||status===7) && <button onClick={handleLeave} style={st.btnLeave} disabled={txBusy}>Leave Table</button>}
          {txBusy && <span style={{color:'#E8DCC8',fontSize:'11px',fontWeight:600}}>Processing...</span>}
        </div>
      )}

      {buyInOpen && <BuyInModal bigBlind={bigBlind} available={walletBalance} onConfirm={handleSitDown} onClose={()=>setBuyInOpen(false)} isProcessing={txBusy} />}
      <CashierModal isOpen={cashierOpen} onClose={()=>setCashierOpen(false)} walletBalance={walletBalance} gameBalance={gameBalance} isLoading={balLoading} onRefreshBalances={refetchBal} />

      <footer style={st.footer}>
        <span style={{color:'#2a2a2a'}}>INIPoker</span>
        <span style={{color:'#1C1C1C'}}>Initia L2 {'\u00B7'} Band VRF {'\u00B7'} On-chain Poker</span>
      </footer>
    </div>
  )
}

// ══════════════════════════════════════════
//  STYLES
// ══════════════════════════════════════════
const st: Record<string,React.CSSProperties> = {
  root:{minHeight:'100vh',background:'#000',color:'#b0b0b0',fontFamily:'"DM Sans",sans-serif',display:'flex',flexDirection:'column'},
  header:{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 16px',borderBottom:'1px solid #161616'},
  brand:{display:'flex',alignItems:'center',gap:'8px'},
  btnBack:{background:'#111',color:'#666',border:'1px solid #1C1C1C',borderRadius:'6px',padding:'4px 10px',fontSize:'11px',cursor:'pointer',fontFamily:'inherit'},
  title:{fontSize:'15px',fontWeight:600,color:'#fff',margin:0},
  badge:{fontSize:'9px',fontWeight:600,color:'#7ECFB3',background:'rgba(126,207,179,0.08)',padding:'2px 8px',borderRadius:'4px'},
  headerRight:{display:'flex',gap:'6px'},
  btnConnect:{background:'#E8DCC8',color:'#000',border:'none',borderRadius:'6px',padding:'7px 14px',fontSize:'11px',fontWeight:600,cursor:'pointer',fontFamily:'inherit'},
  btnCashier:{background:'#111',color:'#7ECFB3',border:'1px solid #1C1C1C',borderRadius:'6px',padding:'7px 12px',fontSize:'10px',fontWeight:600,cursor:'pointer',fontFamily:'inherit'},
  btnWallet:{background:'#111',color:'#ccc',border:'1px solid #1C1C1C',borderRadius:'6px',padding:'7px 12px',fontSize:'10px',cursor:'pointer',fontFamily:'"DM Mono",monospace'},
  strip:{display:'flex',alignItems:'center',gap:'12px',flexWrap:'wrap' as const,padding:'6px 16px',borderBottom:'1px solid #0F0F0F',fontSize:'11px'},
  dot:{width:'6px',height:'6px',borderRadius:'50%',flexShrink:0},
  dim:{color:'#3a3a3a'},
  balVal:{color:'#888',fontFamily:'"DM Mono",monospace'},
  txBar:{margin:'4px 16px 0',padding:'6px 12px',background:'rgba(126,207,179,0.04)',border:'1px solid rgba(126,207,179,0.1)',borderRadius:'6px',fontSize:'10px',color:'#7ECFB3',animation:'fadeIn 0.3s ease-out'},
  errorBar:{margin:'4px 16px 0',padding:'6px 12px',background:'rgba(224,112,112,0.06)',border:'1px solid rgba(224,112,112,0.12)',borderRadius:'6px',fontSize:'10px',color:'#E07070',animation:'fadeIn 0.3s ease-out'},
  winnerBanner:{margin:'4px 16px 0',padding:'10px 16px',background:'rgba(232,220,200,0.08)',border:'1px solid rgba(232,220,200,0.2)',borderRadius:'8px',fontSize:'14px',fontWeight:700,color:'#E8DCC8',textAlign:'center' as const},
  felt:{flex:1,margin:'8px',background:'radial-gradient(ellipse at center,#0F1A14 0%,#080E0B 60%,#000 100%)',border:'1px solid #1C1C1C',borderRadius:'100px / 70px',padding:'24px',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:'10px',minHeight:'320px',position:'relative' as const},
  potArea:{textAlign:'center' as const,zIndex:2},
  potLabel:{fontSize:'8px',color:'#555',letterSpacing:'3px',textTransform:'uppercase' as const},
  potValue:{fontSize:'22px',fontWeight:700,color:'#E8DCC8',fontFamily:'"DM Mono",monospace'},
  communityArea:{display:'flex',gap:'6px',justifyContent:'center',padding:'8px 0',zIndex:2},
  card:{display:'inline-flex',alignItems:'center',justifyContent:'center',width:'40px',height:'56px',borderRadius:'5px',background:'#fafaf8',fontWeight:700,fontSize:'13px',boxShadow:'0 2px 6px rgba(0,0,0,0.5)',transition:'transform 0.3s'},
  cardLg:{display:'inline-flex',alignItems:'center',justifyContent:'center',width:'52px',height:'72px',borderRadius:'6px',background:'#fafaf8',fontWeight:700,fontSize:'17px',boxShadow:'0 3px 10px rgba(0,0,0,0.6)',transition:'transform 0.3s'},
  cardBack:{display:'inline-flex',alignItems:'center',justifyContent:'center',width:'40px',height:'56px',borderRadius:'5px',background:'linear-gradient(135deg,#1a1a2e,#16213e)',color:'#333',fontSize:'18px',fontWeight:700,border:'1px solid #1C1C1C'},
  cardBackLg:{display:'inline-flex',alignItems:'center',justifyContent:'center',width:'52px',height:'72px',borderRadius:'6px',background:'linear-gradient(135deg,#1a1a2e,#16213e)',color:'#333',fontSize:'22px',fontWeight:700,border:'1px solid #1C1C1C'},
  holeArea:{display:'flex',gap:'6px',zIndex:10,padding:'6px 14px',background:'rgba(0,0,0,0.7)',borderRadius:'10px',border:'1px solid rgba(232,220,200,0.15)',position:'absolute' as const,bottom:'10%',left:'50%',transform:'translateX(-50%)',backdropFilter:'blur(4px)'},
  seatsContainer:{position:'absolute' as const,top:0,left:0,right:0,bottom:0},
  seatWrap:{position:'absolute' as const,zIndex:1,transition:'all 0.5s ease'},
  seatBox:{background:'#0A0A0A',border:'1px solid #1C1C1C',borderRadius:'8px',padding:'6px 10px',textAlign:'center' as const,minWidth:'80px',position:'relative' as const,transition:'all 0.3s ease'},
  seatMe:{border:'1px solid rgba(232,220,200,0.3)',background:'rgba(232,220,200,0.03)'},
  seatTurn:{border:'1px solid rgba(126,207,179,0.5)',boxShadow:'0 0 12px rgba(126,207,179,0.15)'},
  emptySeat:{width:'36px',height:'36px',borderRadius:'50%',border:'1px dashed #1C1C1C',display:'flex',alignItems:'center',justifyContent:'center',fontSize:'10px',color:'#1C1C1C'},
  markerD:{fontSize:'8px',fontWeight:700,color:'#000',background:'#E8DCC8',borderRadius:'50%',width:'16px',height:'16px',display:'flex',alignItems:'center',justifyContent:'center'},
  markerSB:{fontSize:'7px',fontWeight:700,color:'#7EAECF',background:'rgba(126,174,207,0.15)',borderRadius:'3px',padding:'1px 4px'},
  markerBB:{fontSize:'7px',fontWeight:700,color:'#E8DCC8',background:'rgba(232,220,200,0.15)',borderRadius:'3px',padding:'1px 4px'},
  sidebar:{width:'200px',background:'#0A0A0A',borderLeft:'1px solid #111',padding:'10px',display:'flex',flexDirection:'column',flexShrink:0,overflowY:'auto' as const},
  logScroll:{flex:1,overflowY:'auto' as const,maxHeight:'300px'},
  actionBar:{display:'flex',alignItems:'center',gap:'6px',flexWrap:'wrap' as const,padding:'10px 16px',borderTop:'1px solid #161616'},
  btnAction:{background:'#111',color:'#7ECFB3',border:'1px solid #1C1C1C',borderRadius:'6px',padding:'8px 14px',fontSize:'11px',fontWeight:600,cursor:'pointer',fontFamily:'inherit',transition:'all 0.2s'},
  btnFold:{background:'rgba(224,112,112,0.06)',color:'#E07070',border:'1px solid rgba(224,112,112,0.15)',borderRadius:'6px',padding:'8px 14px',fontSize:'11px',fontWeight:600,cursor:'pointer',fontFamily:'inherit',transition:'all 0.2s'},
  btnRaise:{background:'#E8DCC8',color:'#000',border:'none',borderRadius:'0 6px 6px 0',padding:'8px 14px',fontSize:'11px',fontWeight:600,cursor:'pointer',fontFamily:'inherit',transition:'all 0.2s'},
  btnAllIn:{background:'rgba(232,220,200,0.06)',color:'#E8DCC8',border:'1px solid rgba(232,220,200,0.15)',borderRadius:'6px',padding:'8px 14px',fontSize:'11px',fontWeight:600,cursor:'pointer',fontFamily:'inherit',transition:'all 0.2s'},
  btnLeave:{background:'rgba(224,112,112,0.06)',color:'#E07070',border:'1px solid rgba(224,112,112,0.15)',borderRadius:'6px',padding:'8px 14px',fontSize:'11px',fontWeight:600,cursor:'pointer',fontFamily:'inherit',marginLeft:'auto',transition:'all 0.2s'},
  btnHelper:{background:'#0F0F0F',color:'#666',border:'1px solid #1C1C1C',borderRadius:'4px',padding:'5px 8px',fontSize:'9px',fontWeight:600,cursor:'pointer',fontFamily:'inherit'},
  input:{background:'#0A0A0A',border:'1px solid #1C1C1C',borderRadius:'6px 0 0 6px',borderRight:'none',padding:'8px 10px',color:'#fff',fontSize:'11px',fontFamily:'"DM Mono",monospace',width:'80px',outline:'none'},
  footer:{padding:'8px 16px',borderTop:'1px solid #0F0F0F',display:'flex',justifyContent:'space-between',fontSize:'10px'},
  overlay:{position:'fixed',top:0,left:0,right:0,bottom:0,background:'rgba(0,0,0,0.8)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000,backdropFilter:'blur(4px)'},
  modal:{background:'#0A0A0A',border:'1px solid #1C1C1C',borderRadius:'12px',padding:'22px',width:'380px',maxWidth:'92vw',fontFamily:'"DM Sans",sans-serif'},
}
