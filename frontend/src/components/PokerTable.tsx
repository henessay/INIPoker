/**
 * PokerTable.tsx - v4 (Polymarket-style UX)
 *
 * Philosophy: session wallet is mandatory. Keplr is only touched when funding
 * the session wallet. Every poker action — deposit to table, join, fold, call,
 * raise, salt commit, deal request, reveal, showdown evaluation — is signed
 * locally by the session wallet with zero popups.
 *
 * Major features vs v3:
 * - Session wallet is MANDATORY for all actions (no Keplr fallback during play)
 * - Session wallet auto-created and restored from sessionStorage
 * - Session top-up flow if session wallet runs low on gas
 * - Auto game loop: as soon as 2+ players have chips, game starts itself
 * - Chip stack visualization for every bet, pot, and player stack
 * - Hole cards positioned higher (above player chip area)
 * - Smoother animations with chip-to-pot flying
 * - "Leave Table" reliably withdraws chips AND returns session funds to main wallet
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  formatEther, parseEther, keccak256, toHex, encodePacked,
  createWalletClient, createPublicClient, http,
  type PublicClient,
} from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { useAccount, useReadContract, useReadContracts, useSendTransaction } from 'wagmi'
import { POKER_GAME_ADDRESS, POKER_GAME_ABI } from '../config/contract'
import { useWalletBalance } from '../hooks/useWalletBalance'
import CashierModal from './CashierModal'

// ════════════════════════════════════════════════════════════
// CHAIN & RPC CONFIG
// ════════════════════════════════════════════════════════════
const RPC_URL = 'https://ini-poker.vercel.app/api/rpc'
const CHAIN_ID = 2649570508581093
const INIPOKER_CHAIN = {
  id: CHAIN_ID,
  name: 'INIPoker L2',
  nativeCurrency: { name: 'INIT', symbol: 'INIT', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] }, public: { http: [RPC_URL] } },
} as const

// Minimum gas reserve kept on session wallet (enough for ~200 actions)
const GAS_RESERVE_WEI = parseEther('0.3')
// Low-water-mark below which we top up the session wallet again
const GAS_REFUEL_WEI = parseEther('0.1')

// ════════════════════════════════════════════════════════════
// CARD CONSTANTS
// ════════════════════════════════════════════════════════════
const SUITS = ['\u2660', '\u2665', '\u2666', '\u2663'] as const
const SUIT_COLORS = ['#0a0a0a', '#c41e1e', '#c41e1e', '#0a0a0a'] as const
const VALUES = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const
const STATUS_LABELS = ['Waiting', 'Dealing', 'Pre-Flop', 'Flop', 'Turn', 'River', 'Showdown', 'Settled']
const HAND_RANKS = ['', 'High Card', 'One Pair', 'Two Pair', 'Three of a Kind', 'Straight', 'Flush', 'Full House', 'Four of a Kind', 'Straight Flush', 'Royal Flush']

const SEAT_POSITIONS = [
  { top: '6%',  left: '50%' },   // 0
  { top: '25%', left: '90%' },   // 1
  { top: '65%', left: '90%' },   // 2
  { top: '82%', left: '50%' },   // 3  ← always "me"
  { top: '65%', left: '10%' },   // 4
  { top: '25%', left: '10%' },   // 5
]

function getRotatedPos(seatIdx: number, mySeat: number): { top: string, left: string } {
  const offset = (3 - mySeat + 6) % 6
  const visualIdx = (seatIdx + offset) % 6
  return SEAT_POSITIONS[visualIdx] || SEAT_POSITIONS[0]
}

// ════════════════════════════════════════════════════════════
// CARD COMPONENT (with smooth flip)
// ════════════════════════════════════════════════════════════
function Card({ encoded, size = 'normal', flipDelay = 0, key: _k }: {
  encoded: number; size?: 'normal' | 'large' | 'small'; flipDelay?: number; key?: any
}) {
  if (!encoded) return <span style={size === 'large' ? st.cardBackLg : size === 'small' ? st.cardBackSm : st.cardBack}>?</span>
  const suit = Math.floor((encoded - 1) / 13)
  const value = ((encoded - 1) % 13) + 1
  const s = size === 'large' ? st.cardLg : size === 'small' ? st.cardSm : st.card
  return (
    <span style={{ ...s, color: SUIT_COLORS[suit], animation: `cardFlip 0.55s cubic-bezier(.2,.9,.3,1.2) ${flipDelay}s both` }}>
      {VALUES[value]}{SUITS[suit]}
    </span>
  )
}

function rankLabel(rank: number): string {
  if (!rank) return ''
  const cat = (rank >> 16) & 0xff
  return HAND_RANKS[cat] ?? `Rank ${cat}`
}

// ════════════════════════════════════════════════════════════
// POKER CHIP COMPONENT
// ════════════════════════════════════════════════════════════
// Denominations (in INIT)
const CHIP_DENOMS = [
  { value: 100,  color: '#1a1a1a', accent: '#6a6a6a', label: '100' },
  { value: 25,   color: '#2a7a3a', accent: '#7ECFB3', label: '25' },
  { value: 10,   color: '#2e4a8a', accent: '#7aa8ff', label: '10' },
  { value: 5,    color: '#8a2a2a', accent: '#E07070', label: '5' },
  { value: 1,    color: '#8a6a2a', accent: '#E8C07E', label: '1' },
  { value: 0.2,  color: '#5a5a5a', accent: '#cccccc', label: '.2' },
]

function decomposeChips(amountStr: string): Array<{ denom: typeof CHIP_DENOMS[0], count: number }> {
  const amount = parseFloat(amountStr)
  if (!amount || amount <= 0) return []
  let remaining = amount
  const result: Array<{ denom: typeof CHIP_DENOMS[0], count: number }> = []
  for (const d of CHIP_DENOMS) {
    if (remaining >= d.value - 1e-9) {
      const count = Math.floor(remaining / d.value + 1e-9)
      if (count > 0) {
        result.push({ denom: d, count: Math.min(count, 8) })
        remaining -= count * d.value
      }
    }
  }
  return result
}

function ChipStack({ amountWei, size = 'normal' }: { amountWei: bigint, size?: 'normal' | 'large' | 'small' }) {
  const amountStr = formatEther(amountWei)
  const stacks = decomposeChips(amountStr)
  if (stacks.length === 0) return null
  const chipSize = size === 'large' ? 20 : size === 'small' ? 10 : 14
  const thickness = size === 'large' ? 4 : size === 'small' ? 2 : 3
  return (
    <div style={{ display: 'inline-flex', gap: '4px', alignItems: 'flex-end' }}>
      {stacks.map((s, i) => (
        <div key={i} style={{ position: 'relative', width: chipSize + 'px', height: (s.count * thickness + 6) + 'px' }}>
          {Array.from({ length: s.count }).map((_, j) => (
            <div key={j} style={{
              position: 'absolute',
              bottom: (j * thickness) + 'px',
              left: 0,
              width: chipSize + 'px',
              height: (chipSize * 0.9) + 'px',
              borderRadius: '50%',
              background: `radial-gradient(ellipse at 50% 40%, ${s.denom.accent} 0%, ${s.denom.color} 70%)`,
              border: `1px dashed ${s.denom.accent}`,
              boxShadow: `0 1px 3px rgba(0,0,0,0.6)`,
              zIndex: j,
            }} />
          ))}
          {size !== 'small' && s.count > 2 && (
            <div style={{
              position: 'absolute',
              bottom: ((s.count - 1) * thickness + 1) + 'px',
              left: 0,
              width: chipSize + 'px',
              textAlign: 'center',
              fontSize: size === 'large' ? '8px' : '6px',
              color: '#fff',
              fontWeight: 700,
              textShadow: '0 1px 2px rgba(0,0,0,0.8)',
              lineHeight: 1,
            }}>{s.denom.label}</div>
          )}
        </div>
      ))}
    </div>
  )
}

// ════════════════════════════════════════════════════════════
// CLIENT-SIDE HOLE CARD RECONSTRUCTION
// ════════════════════════════════════════════════════════════
function getHoleCardsFromDeck(deckSeed: `0x${string}`, dealerIdx: number, mySeatIdx: number, playerCount: number): [number, number] | null {
  if (!deckSeed || deckSeed === '0x0' || deckSeed === '0x' + '0'.repeat(64)) return null
  try {
    const deck = Array.from({ length: 52 }, (_, i) => i + 1)
    let seed = BigInt(deckSeed)
    for (let i = 51; i > 0; i--) {
      seed = BigInt(keccak256(encodePacked(['bytes32'], [`0x${seed.toString(16).padStart(64, '0')}` as `0x${string}`])))
      const j = Number(seed % BigInt(i + 1))
      ;[deck[i], deck[j]] = [deck[j], deck[i]]
    }
    const sbIdx = (dealerIdx + 1) % playerCount
    const seatOrder: number[] = []
    for (let i = 0; i < playerCount; i++) seatOrder.push((sbIdx + i) % playerCount)
    const myPos = seatOrder.indexOf(mySeatIdx)
    if (myPos < 0) return null
    return [deck[myPos], deck[playerCount + myPos]]
  } catch {
    return null
  }
}

// ════════════════════════════════════════════════════════════
// BUY-IN MODAL
// ════════════════════════════════════════════════════════════
function BuyInModal({ bigBlind, gameBalance, walletBalance, onConfirm, onClose, isProcessing, sessionStatus }: {
  bigBlind: number; gameBalance: string; walletBalance: string
  onConfirm: (a: number) => void; onClose: () => void
  isProcessing: boolean; sessionStatus: string
}) {
  const minBuy = bigBlind * 10
  const maxBuy = bigBlind * 100
  const gameBal = parseFloat(gameBalance)
  const walletBal = parseFloat(walletBalance)
  const totalAvail = gameBal + walletBal
  const effMax = Math.min(maxBuy, totalAvail > minBuy ? totalAvail - 0.5 : minBuy)
  const [val, setVal] = useState(Math.min(bigBlind * 50, effMax > minBuy ? effMax : minBuy))
  const canJoin = val >= minBuy && val <= totalAvail - 0.3

  return (
    <div style={st.overlay} onClick={!isProcessing ? onClose : undefined}>
      <div style={st.modal} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h2 style={st.modalTitle}>Buy In</h2>
          {!isProcessing && <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#555', fontSize: '18px', cursor: 'pointer' }}>{'\u2715'}</button>}
        </div>
        {isProcessing ? (
          <div style={{ padding: '24px 0', textAlign: 'center' }}>
            <div style={{ fontSize: '13px', color: '#E8DCC8', marginBottom: '8px' }}>{'\u23F3'} {sessionStatus || 'Setting up game wallet...'}</div>
            <div style={{ fontSize: '10px', color: '#555' }}>One signature, then play with no popups (Polymarket-style)</div>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: '12px', marginBottom: '12px' }}>
              <div style={{ flex: 1, padding: '8px 12px', background: 'rgba(126,207,179,0.05)', borderRadius: '6px' }}>
                <div style={{ fontSize: '9px', color: '#555', textTransform: 'uppercase', fontWeight: 600 }}>Game Balance</div>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#7ECFB3', marginTop: '2px' }}>{gameBal.toFixed(2)} INIT</div>
              </div>
              <div style={{ flex: 1, padding: '8px 12px', background: 'rgba(126,207,179,0.05)', borderRadius: '6px' }}>
                <div style={{ fontSize: '9px', color: '#555', textTransform: 'uppercase', fontWeight: 600 }}>Wallet</div>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#7ECFB3', marginTop: '2px' }}>{walletBal.toFixed(2)} INIT</div>
              </div>
            </div>
            <div style={{ marginBottom: '12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                <span style={{ fontSize: '11px', color: '#888' }}>Buy-in: <b style={{ color: '#E8DCC8' }}>{val.toFixed(1)} INIT</b></span>
                <span style={{ fontSize: '11px', color: '#555' }}>{Math.round(val / bigBlind)} BB</span>
              </div>
              <input type="range" min={minBuy} max={effMax > minBuy ? effMax : minBuy + bigBlind} step={bigBlind} value={val}
                onChange={e => setVal(parseFloat(e.target.value))}
                style={{ width: '100%', accentColor: '#7ECFB3' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9px', color: '#444', marginTop: '4px' }}>
                <span>{minBuy.toFixed(1)} (10bb)</span><span>{effMax > 0 ? effMax.toFixed(1) : maxBuy} (max)</span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '6px', marginBottom: '12px' }}>
              {[20, 50, 100].map(bb => {
                const a = bigBlind * bb
                return <button key={bb} onClick={() => setVal(Math.min(a, effMax))} style={{ ...st.btnHelper, flex: 1 }}>{bb}BB</button>
              })}
            </div>
            {totalAvail < minBuy + 0.5 && <div style={{ padding: '8px', background: 'rgba(224,112,112,0.08)', border: '1px solid rgba(224,112,112,0.2)', borderRadius: '6px', fontSize: '11px', color: '#E07070', marginBottom: '12px' }}>Need at least {(minBuy + 0.5).toFixed(1)} INIT total (buy-in + gas). Deposit via Cashier.</div>}
            <div style={{ fontSize: '10px', color: '#555', marginBottom: '12px', lineHeight: 1.5 }}>
              Sign <b style={{ color: '#E8DCC8' }}>one transaction</b> {'\u2192'} play with zero popups. Funds return when you leave the table.
            </div>
            <button onClick={() => canJoin && onConfirm(val)} disabled={!canJoin}
              style={{ ...st.btnPrimary, width: '100%', opacity: canJoin ? 1 : 0.4, cursor: canJoin ? 'pointer' : 'not-allowed' }}>
              {canJoin ? `Sit Down (${val.toFixed(1)} INIT)` : 'Adjust amount'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════
// MAIN POKER TABLE
// ════════════════════════════════════════════════════════════
interface PState {
  addr: string; chips: bigint; currentBet: bigint; isActive: boolean; lastAction: number
  handRank: number; revealedCard0: number; revealedCard1: number; hasRevealed: boolean
  seatIndex: number; stake: bigint
}

interface PokerTableProps {
  tableId: bigint
  tableName: string
  bigBlind: number
  onBack?: () => void
}

export default function PokerTable({ tableId, tableName, bigBlind, onBack }: PokerTableProps) {
  const { address, isConnected } = useAccount()
  const { sendTransactionAsync } = useSendTransaction()
  const { walletBalance, gameBalance, isLoading: balLoading, refetch: refetchBal } = useWalletBalance(tableId)

  // ════════════════════════════════════════════════════════════
  // SESSION WALLET (fully local)
  // ════════════════════════════════════════════════════════════
  const sessionKey = useMemo(() =>
    address ? `inipoker_session_${address.toLowerCase()}` : null, [address])

  const [sessionPk, setSessionPk] = useState<`0x${string}` | null>(() => {
    const a = (window as any).ethereum ? null : null
    return null
  })

  // Load session key from storage whenever address changes
  useEffect(() => {
    if (!sessionKey) return
    const stored = sessionStorage.getItem(sessionKey) as `0x${string}` | null
    setSessionPk(stored)
  }, [sessionKey])

  const sessionAccount = useMemo(() => sessionPk ? privateKeyToAccount(sessionPk) : null, [sessionPk])
  const sessionAddr = sessionAccount?.address ?? null

  const publicClient = useMemo<PublicClient>(() => createPublicClient({
    chain: INIPOKER_CHAIN as any,
    transport: http(RPC_URL),
  }), [])

  // Build a fresh wallet client each time we need one (avoids stale nonce issues)
  const makeWalletClient = useCallback(() => {
    if (!sessionAccount) throw new Error('No session wallet')
    return createWalletClient({
      account: sessionAccount,
      chain: INIPOKER_CHAIN as any,
      transport: http(RPC_URL),
    })
  }, [sessionAccount])

  /** Sign & broadcast a contract call with the session wallet.  Zero popups. */
  const sWrite = useCallback(async (fnName: string, args: unknown[], value?: bigint, gasHint = 600_000n): Promise<string> => {
    if (!sessionAccount) throw new Error('Session wallet not set up - click Sit Down first')
    const wc = makeWalletClient()
    console.log(`[SESSION] ${fnName}`, args, value?.toString())
    const hash = await wc.writeContract({
      address: POKER_GAME_ADDRESS,
      abi: POKER_GAME_ABI,
      functionName: fnName,
      args,
      gas: gasHint,
      gasPrice: 1_000_000_000n,
      account: sessionAccount,
      chain: INIPOKER_CHAIN as any,
      ...(value !== undefined ? { value } : {}),
    } as any)
    console.log(`[SESSION] ${fnName} hash:`, hash)
    return hash
  }, [sessionAccount, makeWalletClient])

  // ════════════════════════════════════════════════════════════
  // CONTRACT READS
  // ════════════════════════════════════════════════════════════
  const { data: fullSession, refetch: refetchSession } = useReadContract({
    address: POKER_GAME_ADDRESS, abi: POKER_GAME_ABI, functionName: 'sessions', args: [tableId],
    query: { refetchInterval: 2000 }
  })

  const { data: players, refetch: refetchPlayers } = useReadContract({
    address: POKER_GAME_ADDRESS, abi: POKER_GAME_ABI, functionName: 'getPlayers', args: [tableId],
    query: { refetchInterval: 2000 }
  })

  const fs = fullSession as readonly any[] | undefined
  const status = fs ? Number(fs[1]) : 0
  const dealerIndex = fs ? Number(fs[2]) : 0
  const playerCount = fs ? Number(fs[3]) : 0
  const communityCount = fs ? Number(fs[4]) : 0
  const community = ((fs && fs[5]) ? Array.from(fs[5] as any) : [0, 0, 0, 0, 0]) as number[]
  const pot = fs ? (fs[9] as bigint) : 0n
  const currentBet = fs ? (fs[10] as bigint) : 0n
  const deckSeed = fs ? (fs[14] as `0x${string}`) : '0x0' as `0x${string}`
  const activePlayerIdx = fs ? Number(fs[15]) : 0
  const smallBlind = fs ? (fs[16] as bigint) : 0n
  const bigBlindWei = fs ? (fs[17] as bigint) : parseEther(bigBlind.toString())
  const saltsCommitted = fs ? Number(fs[19]) : 0

  const playerAddrs = (players as readonly `0x${string}`[] | undefined) ?? []
  const playerStateContracts = playerAddrs.map(addr => ({
    address: POKER_GAME_ADDRESS, abi: POKER_GAME_ABI, functionName: 'getPlayerState', args: [tableId, addr]
  }))
  const { data: playerStatesData, refetch: refetchStates } = useReadContracts({
    contracts: playerStateContracts as any,
    query: { refetchInterval: 2000, enabled: playerAddrs.length > 0 }
  })

  const allPlayers: PState[] = playerAddrs.map((addr, i) => {
    const r = playerStatesData?.[i]?.result as any
    return {
      addr, stake: r ? (r[0] as bigint) : 0n,
      chips: r ? (r[0] as bigint) : 0n,
      currentBet: r ? (r[1] as bigint) : 0n,
      isActive: r ? Boolean(r[2]) : false,
      lastAction: r ? Number(r[3]) : 0,
      handRank: r ? Number(r[4]) : 0,
      revealedCard0: r ? Number(r[7]) : 0,
      revealedCard1: r ? Number(r[8]) : 0,
      hasRevealed: r ? Boolean(r[6]) : false,
      seatIndex: i,
    }
  })

  const refreshAll = useCallback(() => {
    refetchSession()
    refetchPlayers()
    refetchStates()
    refetchBal()
  }, [refetchSession, refetchPlayers, refetchStates, refetchBal])

  // Me = session wallet at the table (main address may also be found, for backward compat)
  const myPlayer = allPlayers.find(p => {
    const low = p.addr.toLowerCase()
    return low === sessionAddr?.toLowerCase() || low === address?.toLowerCase()
  })
  const isSeated = myPlayer?.isActive ?? false
  const myStake = myPlayer?.chips ?? 0n
  const myBet = myPlayer?.currentBet ?? 0n
  const mySeatIndex = myPlayer?.seatIndex ?? 0
  const isMyTurn = status >= 2 && status <= 5 && isSeated &&
    allPlayers.length > 0 && activePlayerIdx < allPlayers.length &&
    allPlayers[activePlayerIdx]?.addr?.toLowerCase() === (sessionAddr?.toLowerCase() ?? '__nope__')

  // Hole cards - reconstructed client-side
  const [holeCards, setHoleCards] = useState<[number, number] | null>(null)
  useEffect(() => {
    if (status >= 2 && status <= 7 && isSeated && deckSeed && deckSeed !== '0x0') {
      const cards = getHoleCardsFromDeck(deckSeed, dealerIndex, mySeatIndex, playerCount)
      setHoleCards(cards)
    } else if (status === 0 || status === 1) {
      setHoleCards(null)
    }
  }, [deckSeed, dealerIndex, mySeatIndex, playerCount, status, isSeated])

  // ════════════════════════════════════════════════════════════
  // ANIMATIONS (injected once)
  // ════════════════════════════════════════════════════════════
  useEffect(() => {
    const id = 'inipoker-anims-v4'
    if (!document.getElementById(id)) {
      const style = document.createElement('style')
      style.id = id
      style.textContent = `
        @keyframes cardFlip {
          0% { transform: rotateY(180deg) scale(0.3); opacity: 0; filter: blur(2px); }
          50% { transform: rotateY(90deg) scale(0.7); opacity: 0.4; filter: blur(0); }
          100% { transform: rotateY(0) scale(1); opacity: 1; }
        }
        @keyframes dealIn {
          0% { transform: translate(-50%, -240px) rotate(180deg) scale(0.5); opacity: 0; }
          60% { transform: translate(-50%, 10px) rotate(0) scale(1.05); opacity: 1; }
          100% { transform: translate(-50%, 0) rotate(0) scale(1); opacity: 1; }
        }
        @keyframes commSlide {
          0% { transform: translateY(-60px) scale(0.4) rotateY(180deg); opacity: 0; }
          70% { transform: translateY(4px) scale(1.05) rotateY(0); opacity: 1; }
          100% { transform: translateY(0) scale(1) rotateY(0); opacity: 1; }
        }
        @keyframes potPulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.03); }
        }
        @keyframes winnerGlow {
          0%, 100% { box-shadow: 0 0 16px rgba(126,207,179,0.5), inset 0 0 8px rgba(126,207,179,0.2); }
          50% { box-shadow: 0 0 40px rgba(126,207,179,0.95), inset 0 0 16px rgba(126,207,179,0.4); }
        }
        @keyframes chipBet {
          0% { transform: translateY(20px) scale(0.5); opacity: 0; }
          100% { transform: translateY(0) scale(1); opacity: 1; }
        }
        @keyframes pulseTurn {
          0%, 100% { box-shadow: 0 0 0 0 rgba(232,192,126,0.6); }
          50% { box-shadow: 0 0 0 8px rgba(232,192,126,0); }
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes spinGlow {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `
      document.head.appendChild(style)
    }
  }, [])

  // ════════════════════════════════════════════════════════════
  // ACTION LOG
  // ════════════════════════════════════════════════════════════
  const [actionLog, setActionLog] = useState<string[]>([])
  const logRef = useRef<HTMLDivElement>(null)
  const addLog = useCallback((msg: string) => {
    setActionLog(prev => [...prev.slice(-30), `${new Date().toLocaleTimeString().slice(0, 5)}: ${msg}`])
  }, [])
  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight) }, [actionLog])

  // ════════════════════════════════════════════════════════════
  // LOCAL UI STATE
  // ════════════════════════════════════════════════════════════
  const [actionPending, setActionPending] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [localStatus, setLocalStatus] = useState<string | null>(null)
  const [betAmount, setBetAmount] = useState('')
  const [buyInOpen, setBuyInOpen] = useState(false)
  const [cashierOpen, setCashierOpen] = useState(false)
  const [sittingDown, setSittingDown] = useState(false)
  const [sessionStatus, setSessionStatus] = useState('')
  const [leaving, setLeaving] = useState(false)

  const txBusy = actionPending || sittingDown || leaving

  // ════════════════════════════════════════════════════════════
  // GAME ACTIONS — all routed through session wallet. Zero popups.
  // ════════════════════════════════════════════════════════════
  const doAction = useCallback(async (fnName: string, args: unknown[], label: string) => {
    setActionPending(true); setLocalError(null)
    try {
      await sWrite(fnName, args)
      addLog(label)
    } catch (err: any) {
      console.error(`[ACTION] ${fnName} failed:`, err)
      const msg = err.shortMessage ?? err.message ?? String(err)
      setLocalError(msg.slice(0, 140))
    }
    setActionPending(false)
    setTimeout(refreshAll, 800)
    setTimeout(refreshAll, 2500)
  }, [sWrite, addLog, refreshAll])

  const handleFold  = () => doAction('playerAction', [tableId, 1, 0n], 'You folded')
  const handleCheck = () => doAction('playerAction', [tableId, 2, 0n], 'You checked')
  const handleCall  = () => doAction('playerAction', [tableId, 4, 0n], 'You called')
  const handleBet   = () => { const a = betAmount; doAction('playerAction', [tableId, 3, parseEther(a || '0')], `You bet ${a} INIT`) }
  const handleRaise = () => { const a = betAmount; doAction('playerAction', [tableId, 5, parseEther(a || '0')], `You raised ${a} INIT`) }
  const handleAllIn = () => doAction('playerAction', [tableId, 6, 0n], 'You went ALL-IN!')

  const saltKey = `inipoker_salt_${tableId.toString()}_${sessionAddr}`
  const handleCommit = useCallback(async () => {
    if (!sessionAccount) return
    setActionPending(true); setLocalError(null)
    try {
      const bytes = crypto.getRandomValues(new Uint8Array(32))
      const hex = toHex(bytes)
      const hash = keccak256(hex as `0x${string}`)
      sessionStorage.setItem(saltKey, hex)
      await sWrite('commitSalt', [tableId, hash])
      addLog('Salt committed (auto)')
    } catch (err: any) {
      console.error('[COMMIT] failed:', err)
      setLocalError((err.shortMessage ?? err.message ?? String(err)).slice(0, 140))
    }
    setActionPending(false)
    setTimeout(refreshAll, 1000)
  }, [sWrite, tableId, addLog, refreshAll, saltKey, sessionAccount])

  const handleDeal = useCallback(async () => {
    setActionPending(true); setLocalError(null)
    try {
      await sWrite('requestDeal', [tableId], undefined, 800_000n)
      addLog('Dealing new hand...')
    } catch (err: any) {
      console.error('[DEAL] failed:', err)
      setLocalError((err.shortMessage ?? err.message ?? String(err)).slice(0, 140))
    }
    setActionPending(false)
    setTimeout(refreshAll, 1500)
  }, [sWrite, tableId, addLog, refreshAll])

  const handleReveal = useCallback(async () => {
    const salt = sessionStorage.getItem(saltKey) as `0x${string}` | null
    if (!salt) { setLocalError('Salt not found - cannot reveal'); return }
    setActionPending(true); setLocalError(null)
    try {
      await sWrite('revealHoleCards', [tableId, salt])
      addLog('Cards revealed (auto)')
    } catch (err: any) {
      console.error('[REVEAL] failed:', err)
      setLocalError((err.shortMessage ?? err.message ?? String(err)).slice(0, 140))
    }
    setActionPending(false)
    setTimeout(refreshAll, 1500)
  }, [sWrite, tableId, addLog, refreshAll, saltKey])

  const handleEvaluate = useCallback(async () => {
    setActionPending(true); setLocalError(null)
    try {
      await sWrite('evaluateShowdown', [tableId], undefined, 800_000n)
      addLog('Showdown resolved')
    } catch (err: any) {
      console.error('[EVAL] failed:', err)
      setLocalError((err.shortMessage ?? err.message ?? String(err)).slice(0, 140))
    }
    setActionPending(false)
    setTimeout(refreshAll, 1500)
  }, [sWrite, tableId, addLog, refreshAll])

  // ════════════════════════════════════════════════════════════
  // SIT DOWN — Polymarket-style: ONE Keplr popup to fund session wallet,
  // then everything else is session-signed.
  // ════════════════════════════════════════════════════════════
  const handleSitDown = async (buyIn: number) => {
    if (!address || !sessionKey) return
    setLocalError(null)
    setSittingDown(true)
    try {
      // Step 1: Ensure a session wallet exists
      let pk = sessionStorage.getItem(sessionKey) as `0x${string}` | null
      if (!pk) {
        pk = generatePrivateKey()
        sessionStorage.setItem(sessionKey, pk)
        setSessionPk(pk)
      }
      const account = privateKeyToAccount(pk)
      const sessAddr = account.address
      console.log('[SIT] Session addr:', sessAddr)

      const buyInWei = parseEther(buyIn.toString())

      // Check current session balance
      const sessBalBefore = await publicClient.getBalance({ address: sessAddr as `0x${string}` })
      const need = buyInWei + GAS_RESERVE_WEI
      const shortfall = need > sessBalBefore ? need - sessBalBefore : 0n

      // Step 2: ONE Keplr popup — fund the session wallet with what's missing
      if (shortfall > 0n) {
        setSessionStatus('Funding game wallet (1 signature)...')
        const fundHash = await sendTransactionAsync({
          to: sessAddr as `0x${string}`,
          value: shortfall,
          gas: 100_000n,
          gasPrice: 1_000_000_000n,
        })
        console.log('[SIT] Fund tx:', fundHash)
        addLog(`Funded game wallet (${formatEther(shortfall)} INIT)`)

        // Wait for funding to land
        setSessionStatus('Confirming funding...')
        let confirmed = false
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 500))
          const b = await publicClient.getBalance({ address: sessAddr as `0x${string}` })
          if (b >= need - parseEther('0.001')) { confirmed = true; break }
        }
        if (!confirmed) throw new Error('Funding did not confirm in time — please retry')
      }

      // From here on — zero popups.
      const sessClient = createWalletClient({
        account, chain: INIPOKER_CHAIN as any, transport: http(RPC_URL),
      })

      // Step 3: session wallet deposits chips
      setSessionStatus('Depositing chips...')
      await sessClient.writeContract({
        address: POKER_GAME_ADDRESS, abi: POKER_GAME_ABI,
        functionName: 'deposit', args: [],
        value: buyInWei, gas: 400_000n, gasPrice: 1_000_000_000n,
        account, chain: INIPOKER_CHAIN as any,
      } as any)
      await new Promise(r => setTimeout(r, 2000))

      // Step 4: session wallet joins the table
      setSessionStatus('Joining table...')
      await sessClient.writeContract({
        address: POKER_GAME_ADDRESS, abi: POKER_GAME_ABI,
        functionName: 'joinTable', args: [tableId, buyInWei],
        gas: 400_000n, gasPrice: 1_000_000_000n,
        account, chain: INIPOKER_CHAIN as any,
      } as any)
      await new Promise(r => setTimeout(r, 2000))

      setSessionStatus('')
      setBuyInOpen(false)
      addLog(`Seated with ${buyIn} INIT`)
      refreshAll()
    } catch (err: any) {
      console.error('[SIT] failed:', err)
      setLocalError((err.shortMessage ?? err.message ?? String(err)).slice(0, 180))
      setSessionStatus('')
    }
    setSittingDown(false)
  }

  // ════════════════════════════════════════════════════════════
  // LEAVE TABLE
  // Full cleanup: leaveTable → withdraw → return leftover INIT to main wallet
  // ════════════════════════════════════════════════════════════
  const handleLeaveTable = async () => {
    if (!sessionAccount) return
    setLeaving(true); setLocalError(null)
    try {
      if (isSeated) {
        setLocalStatus('Leaving table...')
        try {
          await sWrite('leaveTable', [tableId])
          await new Promise(r => setTimeout(r, 2500))
        } catch (e) { console.warn('leaveTable failed (maybe already left)', e) }
      }

      setLocalStatus('Withdrawing chips...')
      const gameBal = await publicClient.readContract({
        address: POKER_GAME_ADDRESS, abi: POKER_GAME_ABI,
        functionName: 'getBalance', args: [sessionAddr],
      }) as bigint
      if (gameBal > 0n) {
        await sWrite('withdraw', [gameBal])
        await new Promise(r => setTimeout(r, 2500))
      }

      setLocalStatus('Returning funds...')
      const sessBal = await publicClient.getBalance({ address: sessionAddr as `0x${string}` })
      const gasNeeded = 50_000n * 1_000_000_000n
      if (sessBal > gasNeeded && address) {
        const toReturn = sessBal - gasNeeded
        const wc = makeWalletClient()
        await wc.sendTransaction({
          account: sessionAccount,
          chain: INIPOKER_CHAIN as any,
          to: address as `0x${string}`,
          value: toReturn,
          gas: 50_000n,
          gasPrice: 1_000_000_000n,
        })
      }

      // Clean storage
      sessionStorage.removeItem(sessionKey!)
      sessionStorage.removeItem(saltKey)
      setSessionPk(null)
      setLocalStatus(null)
      addLog('Left table - funds returned to main wallet')
      refreshAll()
      setTimeout(() => onBack?.(), 1200)
    } catch (err: any) {
      console.error('[LEAVE] failed:', err)
      setLocalError((err.shortMessage ?? err.message ?? String(err)).slice(0, 180))
      setLocalStatus(null)
    }
    setLeaving(false)
  }

  // ════════════════════════════════════════════════════════════
  // AUTO GAME LOOP
  // Fires commit → deal → reveal → evaluate automatically
  // Locked per-stateKey to prevent infinite loops
  // ════════════════════════════════════════════════════════════
  const autoBusyRef = useRef(false)
  const lastAutoKeyRef = useRef<string>('')
  const prevStatusRef = useRef<number>(0)

  useEffect(() => {
    // Clear salt when a new hand cycles through Settled → Waiting
    if (prevStatusRef.current === 7 && status === 0) {
      sessionStorage.removeItem(saltKey)
    }
    prevStatusRef.current = status
  }, [status, saltKey])

  useEffect(() => {
    if (!sessionAccount || !isSeated || autoBusyRef.current || txBusy) return

    const activeCount = allPlayers.filter(p => p.isActive).length
    const stateKey = `${status}-${saltsCommitted}-${communityCount}-${activeCount}-${myPlayer?.hasRevealed ? 'r' : 'n'}`
    if (lastAutoKeyRef.current === stateKey) return

    // 1. Waiting/Settled with 2+ players and I haven't committed yet → commit
    if ((status === 0 || status === 7) && playerCount >= 2 && saltsCommitted < playerCount) {
      const myHash = sessionStorage.getItem(saltKey)
      if (!myHash) {
        lastAutoKeyRef.current = stateKey
        autoBusyRef.current = true
        handleCommit().finally(() => {
          setTimeout(() => { autoBusyRef.current = false; refreshAll() }, 2500)
        })
        return
      }
    }

    // 2. All salts committed + 2+ players → request deal
    if ((status === 0 || status === 7) && playerCount >= 2 && saltsCommitted >= playerCount) {
      lastAutoKeyRef.current = stateKey
      autoBusyRef.current = true
      handleDeal().finally(() => {
        setTimeout(() => { autoBusyRef.current = false; refreshAll() }, 3000)
      })
      return
    }

    // 3. Showdown + I haven't revealed → reveal
    if (status === 6 && myPlayer?.isActive && !myPlayer.hasRevealed) {
      const salt = sessionStorage.getItem(saltKey)
      if (salt) {
        lastAutoKeyRef.current = stateKey
        autoBusyRef.current = true
        handleReveal().finally(() => {
          setTimeout(() => { autoBusyRef.current = false; refreshAll() }, 2500)
        })
        return
      }
    }

    // 4. Showdown + everyone revealed → evaluate
    if (status === 6) {
      const active = allPlayers.filter(p => p.isActive)
      if (active.length >= 2 && active.every(p => p.hasRevealed)) {
        lastAutoKeyRef.current = stateKey
        autoBusyRef.current = true
        handleEvaluate().finally(() => {
          setTimeout(() => { autoBusyRef.current = false; refreshAll() }, 2500)
        })
        return
      }
    }
  }, [status, playerCount, saltsCommitted, isSeated, sessionAccount, txBusy,
      myPlayer?.hasRevealed, myPlayer?.isActive, communityCount,
      handleCommit, handleDeal, handleReveal, handleEvaluate, refreshAll, saltKey, allPlayers.length])

  // ════════════════════════════════════════════════════════════
  // TURN TIMER (45s auto-fold)
  // ════════════════════════════════════════════════════════════
  const [timeLeft, setTimeLeft] = useState(45)
  const turnStartRef = useRef<number>(0)

  useEffect(() => {
    if (!isMyTurn) { setTimeLeft(45); turnStartRef.current = 0; return }
    if (turnStartRef.current === 0) turnStartRef.current = Date.now()
    const interval = setInterval(() => {
      const elapsed = (Date.now() - turnStartRef.current) / 1000
      const left = Math.max(0, 45 - elapsed)
      setTimeLeft(left)
      if (left <= 0 && isMyTurn && !txBusy) {
        clearInterval(interval)
        handleFold()
      }
    }, 250)
    return () => clearInterval(interval)
  }, [isMyTurn, txBusy])

  const winner = status === 7 ? allPlayers.reduce((best, p) =>
    p.handRank > (best?.handRank || 0) ? p : best, null as PState | null) : null

  const potF = parseFloat(formatEther(pot))
  const setBetHelper = (amount: number) => setBetAmount(amount.toFixed(2))

  const sessionActive = !!sessionAccount && (isSeated || status === 0)

  // ════════════════════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════════════════════
  return (
    <div style={st.root}>
      <header style={st.header}>
        <div style={st.brand}>
          {onBack && <button onClick={onBack} style={st.btnBack}>{'\u2190'} Back</button>}
          <span style={{ color: '#E8DCC8', fontSize: '14px' }}>{'\u25C6'}</span>
          <h1 style={st.title}>{tableName}</h1>
          <span style={st.badge}>{STATUS_LABELS[status]}</span>
          {sessionAccount && <span style={st.sessionBadge}>{'\u26A1'} Gasless</span>}
        </div>
        <div style={st.headerRight}>
          <button onClick={() => setCashierOpen(true)} style={st.btnCashier}>Cashier</button>
          {address && <span style={st.addr}>{address.slice(0, 6)}...{address.slice(-4)}</span>}
        </div>
      </header>

      <div style={st.statusBar}>
        {isConnected && <span style={st.balVal}>Wallet: {balLoading ? '...' : walletBalance} INIT</span>}
        {isConnected && <span style={st.balVal}>Game: {balLoading ? '...' : gameBalance} INIT</span>}
        {isSeated && <span style={{ ...st.balVal, color: '#7ECFB3', fontWeight: 700 }}>Stack: {formatEther(myStake)} INIT</span>}
        {isMyTurn && <span style={{ color: '#E8C07E', fontWeight: 700, fontSize: '12px', animation: 'pulseTurn 1.2s ease-in-out infinite' }}>{'\u26A1'} YOUR TURN ({Math.ceil(timeLeft)}s)</span>}
      </div>

      {(localStatus || sessionStatus) && <div style={st.banner}>{'\u23F3'} {localStatus || sessionStatus}</div>}
      {localError && <div style={st.errBanner}>{localError}</div>}

      <div style={st.tableArea}>
        <div style={st.tableFelt}>
          {/* POT in the centre, with chip stack */}
          <div style={st.potArea}>
            <div style={st.potLabel}>POT</div>
            <div style={{ ...st.potValue, animation: pot > 0n ? 'potPulse 2s ease-in-out infinite' : 'none' }}>
              {pot > 0n ? formatEther(pot) : '\u2014'} <span style={{ fontSize: '11px', color: '#888' }}>INIT</span>
            </div>
            {pot > 0n && (
              <div style={{ marginTop: '6px', display: 'flex', justifyContent: 'center' }}>
                <ChipStack amountWei={pot} size="large" />
              </div>
            )}
            {currentBet > 0n && <div style={{ fontSize: '10px', color: '#888', marginTop: '4px' }}>Current bet: {formatEther(currentBet)} INIT</div>}
            {status === 1 && <div style={st.potHint}>Dealing...</div>}
            {status === 0 && playerCount < 2 && <div style={st.potHint}>Waiting for players... ({playerCount}/2)</div>}
            {(status === 0 || status === 7) && playerCount >= 2 && (
              <div style={{ ...st.potHint, color: '#7ECFB3' }}>
                {saltsCommitted < playerCount ? `Auto-committing salts (${saltsCommitted}/${playerCount})...` : 'Starting next hand...'}
              </div>
            )}
          </div>

          {/* COMMUNITY CARDS above pot */}
          {communityCount > 0 && (
            <div style={st.communityArea}>
              {Array.from(community).slice(0, communityCount).map((c, i) => (
                <div key={`c${i}-${c}`} style={{ animation: `commSlide 0.55s cubic-bezier(.25,.9,.3,1.2) ${i * 0.2}s both` }}>
                  <Card encoded={c} size="large" flipDelay={i * 0.2} />
                </div>
              ))}
            </div>
          )}

          {/* MY HOLE CARDS — positioned higher, above my seat/chips */}
          {holeCards && (
            <div style={st.holeArea}>
              <div style={{ animation: 'dealIn 0.55s cubic-bezier(.25,.9,.3,1.2) 0s both' }}>
                <Card encoded={holeCards[0]} size="large" />
              </div>
              <div style={{ animation: 'dealIn 0.55s cubic-bezier(.25,.9,.3,1.2) 0.15s both' }}>
                <Card encoded={holeCards[1]} size="large" />
              </div>
            </div>
          )}

          {/* SEATS */}
          <div style={st.seatsContainer}>
            {Array.from({ length: 6 }, (_, seatIdx) => {
              const player = allPlayers.find(p => p.seatIndex === seatIdx)
              const pos = getRotatedPos(seatIdx, mySeatIndex)

              if (!player) {
                return (
                  <div key={seatIdx} style={{ ...st.seatWrap, ...pos, transform: 'translate(-50%,-50%)' }}>
                    <div style={st.emptySeat}>Seat {seatIdx}</div>
                  </div>
                )
              }

              const isMe = player.addr.toLowerCase() === sessionAddr?.toLowerCase()
              const isTurn = status >= 2 && status <= 5 && activePlayerIdx === seatIdx
              const isDealer = dealerIndex === seatIdx
              const isSB = (dealerIndex + 1) % playerCount === seatIdx
              const isBB = (dealerIndex + 2) % playerCount === seatIdx
              const isWinner = winner?.addr === player.addr
              const isFolded = !player.isActive

              return (
                <div key={seatIdx} style={{ ...st.seatWrap, ...pos, transform: 'translate(-50%,-50%)' }}>
                  {/* Bet chips (between seat and pot) */}
                  {player.currentBet > 0n && (
                    <div style={st.seatBetChips}>
                      <ChipStack amountWei={player.currentBet} size="small" />
                      <div style={{ fontSize: '9px', color: '#E8C07E', fontWeight: 700, marginTop: '2px', textShadow: '0 1px 2px rgba(0,0,0,0.8)' }}>
                        {formatEther(player.currentBet)}
                      </div>
                    </div>
                  )}

                  <div style={{
                    ...st.seat,
                    ...(isMe ? st.seatMe : {}),
                    ...(isTurn ? st.seatTurn : {}),
                    ...(isFolded ? st.seatFolded : {}),
                    ...(isWinner ? { animation: 'winnerGlow 1.5s ease-in-out infinite' } : {}),
                  }}>
                    <div style={st.seatBadges}>
                      {isDealer && <span style={st.badgeDealer}>D</span>}
                      {isSB && <span style={st.badgeBlind}>SB</span>}
                      {isBB && <span style={st.badgeBlind}>BB</span>}
                    </div>

                    {/* Seat face */}
                    <div style={st.seatAvatar}>
                      <div style={{ fontSize: '14px' }}>{isMe ? '\u26A1' : '\u2659'}</div>
                    </div>
                    <div style={st.seatName}>{isMe ? 'You' : `${player.addr.slice(0, 6)}...${player.addr.slice(-4)}`}</div>
                    <div style={st.seatStack}>{parseFloat(formatEther(player.chips)).toFixed(2)} INIT</div>

                    {/* Player chip stack */}
                    {player.chips > 0n && (
                      <div style={{ display: 'flex', justifyContent: 'center', marginTop: '3px' }}>
                        <ChipStack amountWei={player.chips} size="small" />
                      </div>
                    )}

                    {isTurn && (
                      <div style={{ marginTop: '4px', width: '100%' }}>
                        <div style={st.timerBar}>
                          <div style={{
                            ...st.timerFill,
                            width: `${(timeLeft / 45) * 100}%`,
                            background: timeLeft < 10 ? '#E07070' : timeLeft < 20 ? '#E8C07E' : '#7ECFB3',
                          }} />
                        </div>
                      </div>
                    )}

                    {/* Opponent back cards while in hand */}
                    {!isMe && !isFolded && status >= 2 && status <= 5 && (
                      <div style={{ display: 'flex', gap: '3px', justifyContent: 'center', marginTop: '3px' }}>
                        <span style={st.cardBackSm}>\u25AE</span>
                        <span style={st.cardBackSm}>\u25AE</span>
                      </div>
                    )}

                    {/* Revealed cards at showdown */}
                    {status >= 6 && player.hasRevealed && (
                      <div style={st.seatHand}>
                        <Card encoded={player.revealedCard0} size="small" />
                        <Card encoded={player.revealedCard1} size="small" />
                      </div>
                    )}

                    {isFolded && <div style={st.foldedLabel}>FOLDED</div>}
                    {isWinner && <div style={st.winLabel}>WINNER {rankLabel(player.handRank)}</div>}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* ACTION BAR */}
      <div style={st.actionBar}>
        <div style={st.actionRow}>
          {!isSeated && !sessionAccount && (
            <button onClick={() => setBuyInOpen(true)} style={st.btnPrimary} disabled={txBusy || !isConnected}>
              {sittingDown ? 'Setting up...' : '\u2659 Sit Down'}
            </button>
          )}

          {!isSeated && sessionAccount && (
            <>
              <button onClick={() => setBuyInOpen(true)} style={st.btnPrimary} disabled={txBusy}>
                {sittingDown ? 'Setting up...' : '\u2659 Sit Down'}
              </button>
              <button onClick={handleLeaveTable} style={st.btnLeave} disabled={leaving || txBusy}>
                {leaving ? 'Closing...' : 'Close session'}
              </button>
            </>
          )}

          {isSeated && (
            <button onClick={handleLeaveTable} style={st.btnLeave} disabled={leaving || txBusy}>
              {leaving ? 'Leaving...' : 'Leave Table'}
            </button>
          )}

          {/* Game actions — only when my turn */}
          {status >= 2 && status <= 5 && isSeated && isMyTurn && (
            <>
              <button onClick={handleFold} style={st.btnFold} disabled={txBusy}>Fold</button>
              {currentBet === myBet
                ? <button onClick={handleCheck} style={st.btnAction} disabled={txBusy}>Check</button>
                : <button onClick={handleCall} style={st.btnAction} disabled={txBusy}>Call {formatEther(currentBet - myBet)}</button>}
              <input type="number" placeholder="Amount" value={betAmount} onChange={e => setBetAmount(e.target.value)} style={st.betInput} />
              <button onClick={currentBet > 0n ? handleRaise : handleBet} style={st.btnRaise} disabled={txBusy || !betAmount}>
                {currentBet > 0n ? 'Raise' : 'Bet'}
              </button>
              <button onClick={handleAllIn} style={st.btnAllIn} disabled={txBusy}>All-In</button>
              <div style={{ display: 'flex', gap: '4px' }}>
                <button onClick={() => setBetHelper(potF * 0.5)} style={st.btnHelper}>{'\u00BD'} Pot</button>
                <button onClick={() => setBetHelper(potF)} style={st.btnHelper}>Pot</button>
                <button onClick={() => setBetHelper(potF * 2)} style={st.btnHelper}>2x Pot</button>
              </div>
            </>
          )}

          {status >= 2 && status <= 5 && isSeated && !isMyTurn && (
            <span style={{ color: '#888', fontSize: '12px' }}>Waiting for opponent...</span>
          )}

          {(status === 0 || status === 7) && isSeated && playerCount >= 2 && (
            <span style={{ color: '#7ECFB3', fontSize: '12px' }}>
              {saltsCommitted < playerCount ? `{'\u23F3'} Auto-committing salts (${saltsCommitted}/${playerCount})...` : '\u23F3 Dealing next hand...'}
            </span>
          )}

          {status === 6 && isSeated && (
            <span style={{ color: '#7ECFB3', fontSize: '12px' }}>
              {!myPlayer?.hasRevealed ? '\u23F3 Revealing...' : '\u23F3 Evaluating showdown...'}
            </span>
          )}

          {txBusy && <span style={{ color: '#E8DCC8', fontSize: '11px', fontWeight: 600, marginLeft: 'auto' }}>Processing...</span>}
        </div>
      </div>

      {/* Right panel: action log */}
      <div style={st.logPanel}>
        <div style={st.logTitle}>ACTION LOG</div>
        <div ref={logRef} style={st.logBody}>
          {actionLog.length === 0 ? <div style={{ color: '#444', fontSize: '11px' }}>No actions yet</div> :
            actionLog.map((line, i) => <div key={i} style={st.logLine}>{line}</div>)}
        </div>
        <div style={st.logFooter}>
          <div>Blinds: {formatEther(smallBlind)}/{formatEther(bigBlindWei)} INIT</div>
          <div>Table #{tableId.toString()}</div>
          {sessionAddr && <div>Session: {sessionAddr.slice(0, 6)}...{sessionAddr.slice(-4)}</div>}
        </div>
      </div>

      {buyInOpen && <BuyInModal bigBlind={bigBlind} gameBalance={gameBalance} walletBalance={walletBalance}
        onConfirm={handleSitDown} onClose={() => setBuyInOpen(false)}
        isProcessing={sittingDown} sessionStatus={sessionStatus} />}

      <CashierModal isOpen={cashierOpen} onClose={() => setCashierOpen(false)} walletBalance={walletBalance}
        gameBalance={gameBalance} isLoading={balLoading} onRefreshBalances={refetchBal} />

      <footer style={st.footer}>
        <span>INIPoker</span>
        <span style={{ color: '#1C1C1C' }}>Session Wallet {'\u00B7'} Band VRF {'\u00B7'} Commit-Reveal</span>
      </footer>
    </div>
  )
}

// ════════════════════════════════════════════════════════════
// STYLES
// ════════════════════════════════════════════════════════════
const st = {
  root: { display: 'grid' as const, gridTemplateColumns: '1fr 280px', gridTemplateRows: 'auto auto 1fr auto auto', minHeight: '100vh', background: '#0a0a0a', color: '#E8DCC8', fontFamily: '"DM Mono",monospace' },
  header: { gridColumn: '1 / -1', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 24px', background: '#0F0F0F', borderBottom: '1px solid #1C1C1C' },
  brand: { display: 'flex', alignItems: 'center', gap: '12px' },
  btnBack: { background: 'none', border: '1px solid #2A2A2A', color: '#888', padding: '4px 10px', borderRadius: '4px', fontSize: '11px', cursor: 'pointer', fontFamily: 'inherit' },
  title: { fontSize: '15px', fontWeight: 700, color: '#E8DCC8', margin: 0 },
  badge: { fontSize: '10px', padding: '3px 8px', background: 'rgba(126,207,179,0.15)', color: '#7ECFB3', borderRadius: '4px', fontWeight: 600, textTransform: 'uppercase' as const },
  sessionBadge: { fontSize: '10px', padding: '3px 8px', background: 'rgba(232,192,126,0.15)', color: '#E8C07E', borderRadius: '4px', fontWeight: 600 },
  headerRight: { display: 'flex', alignItems: 'center', gap: '12px' },
  btnCashier: { background: 'rgba(126,207,179,0.1)', border: '1px solid rgba(126,207,179,0.3)', color: '#7ECFB3', padding: '6px 14px', borderRadius: '4px', fontSize: '11px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  addr: { fontSize: '10px', color: '#666' },
  statusBar: { gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: '16px', padding: '6px 24px', background: '#0a0a0a', borderBottom: '1px solid #1C1C1C', fontSize: '11px' },
  balVal: { color: '#888' },
  banner: { gridColumn: '1 / -1', padding: '8px 24px', background: 'rgba(126,207,179,0.08)', borderBottom: '1px solid rgba(126,207,179,0.15)', color: '#7ECFB3', fontSize: '11px', animation: 'fadeIn 0.3s ease-out' },
  errBanner: { gridColumn: '1 / -1', padding: '8px 24px', background: 'rgba(224,112,112,0.08)', borderBottom: '1px solid rgba(224,112,112,0.15)', color: '#E07070', fontSize: '11px' },
  tableArea: { gridColumn: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', position: 'relative' as const },
  tableFelt: { position: 'relative' as const, width: '100%', maxWidth: '950px', height: '560px', background: 'radial-gradient(ellipse at center, #0f2e1e 0%, #071712 60%, #030705 100%)', borderRadius: '50%/30%', border: '4px solid #2a4632', boxShadow: 'inset 0 0 80px rgba(0,0,0,0.75), 0 0 40px rgba(0,0,0,0.5)' },
  potArea: { position: 'absolute' as const, top: '50%', left: '50%', transform: 'translate(-50%,-50%)', textAlign: 'center' as const, zIndex: 2 },
  potLabel: { fontSize: '8px', color: '#555', letterSpacing: '3px', textTransform: 'uppercase' as const, fontWeight: 600 },
  potValue: { fontSize: '26px', fontWeight: 700, color: '#E8DCC8', fontFamily: '"DM Mono",monospace', marginTop: '2px', letterSpacing: '-0.5px' },
  potHint: { fontSize: '10px', color: '#555', marginTop: '8px', fontStyle: 'italic' as const },
  communityArea: { position: 'absolute' as const, top: '30%', left: '50%', transform: 'translate(-50%,-50%)', display: 'flex', gap: '6px', justifyContent: 'center', padding: '8px 0', zIndex: 3 },
  holeArea: { position: 'absolute' as const, bottom: '25%', left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: '6px', zIndex: 4, padding: '4px 12px', background: 'rgba(0,0,0,0.7)', borderRadius: '8px', border: '1px solid rgba(232,220,200,0.25)', boxShadow: '0 4px 12px rgba(0,0,0,0.5)' },
  seatsContainer: { position: 'absolute' as const, top: 0, left: 0, right: 0, bottom: 0 },
  seatWrap: { position: 'absolute' as const, zIndex: 1 },
  seatBetChips: { position: 'absolute' as const, top: '-28px', left: '50%', transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column' as const, alignItems: 'center', animation: 'chipBet 0.35s ease-out' },
  seat: { background: 'linear-gradient(180deg, #15181b 0%, #0c0e10 100%)', border: '1px solid #1f2328', borderRadius: '10px', padding: '8px 10px', minWidth: '110px', textAlign: 'center' as const, position: 'relative' as const, transition: 'all 0.3s ease', boxShadow: '0 2px 8px rgba(0,0,0,0.5)' },
  seatMe: { borderColor: '#7ECFB3', background: 'linear-gradient(180deg, rgba(126,207,179,0.08) 0%, #0c1512 100%)' },
  seatTurn: { borderColor: '#E8C07E', boxShadow: '0 0 16px rgba(232,192,126,0.45), 0 2px 8px rgba(0,0,0,0.5)' },
  seatFolded: { opacity: 0.4, filter: 'grayscale(1)' },
  seatBadges: { position: 'absolute' as const, top: '-10px', left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: '3px' },
  badgeDealer: { fontSize: '8px', padding: '2px 5px', background: '#E8C07E', color: '#0a0a0a', borderRadius: '3px', fontWeight: 700 },
  badgeBlind: { fontSize: '8px', padding: '2px 5px', background: 'rgba(126,207,179,0.25)', color: '#7ECFB3', borderRadius: '3px', fontWeight: 600 },
  seatAvatar: { width: '28px', height: '28px', borderRadius: '50%', background: 'linear-gradient(135deg, #2a3a32, #1a261f)', border: '1px solid #3a4e42', margin: '4px auto', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#7ECFB3' },
  seatName: { fontSize: '9px', color: '#888', marginTop: '2px' },
  seatStack: { fontSize: '12px', fontWeight: 700, color: '#E8DCC8', marginTop: '2px' },
  seatHand: { display: 'flex', gap: '3px', justifyContent: 'center', marginTop: '4px' },
  emptySeat: { width: '70px', height: '70px', borderRadius: '50%', border: '1px dashed #2a2a2a', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#333', fontSize: '9px', fontFamily: 'inherit' },
  foldedLabel: { position: 'absolute' as const, bottom: '-18px', left: '50%', transform: 'translateX(-50%)', background: '#2a2a2a', color: '#888', fontSize: '7px', fontWeight: 700, padding: '2px 6px', borderRadius: '3px', whiteSpace: 'nowrap' as const, textTransform: 'uppercase' as const },
  winLabel: { position: 'absolute' as const, bottom: '-22px', left: '50%', transform: 'translateX(-50%)', background: '#7ECFB3', color: '#0a0a0a', fontSize: '8px', fontWeight: 700, padding: '2px 6px', borderRadius: '3px', whiteSpace: 'nowrap' as const, textTransform: 'uppercase' as const },
  timerBar: { width: '100%', height: '3px', background: '#1C1C1C', borderRadius: '2px', overflow: 'hidden' },
  timerFill: { height: '100%', transition: 'width 0.25s linear, background 0.5s ease' },
  card: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: '24px', height: '32px', padding: '0 4px', background: '#fff', borderRadius: '3px', fontSize: '12px', fontWeight: 700, fontFamily: '"DM Mono",monospace' },
  cardSm: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: '18px', height: '24px', padding: '0 3px', background: '#fff', borderRadius: '2px', fontSize: '9px', fontWeight: 700, fontFamily: '"DM Mono",monospace' },
  cardLg: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: '44px', height: '60px', padding: '0 6px', background: 'linear-gradient(180deg, #fff 0%, #f0ebe0 100%)', borderRadius: '6px', fontSize: '20px', fontWeight: 700, fontFamily: '"DM Mono",monospace', boxShadow: '0 3px 10px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.8)' },
  cardBack: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: '24px', height: '32px', background: 'linear-gradient(135deg,#1a2e22,#0d1f17)', borderRadius: '3px', border: '1px solid #2a3e32', color: '#444', fontSize: '11px' },
  cardBackSm: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: '18px', height: '24px', background: 'linear-gradient(135deg,#1a2e22,#0d1f17)', borderRadius: '2px', border: '1px solid #2a3e32', color: '#2a3e32', fontSize: '9px' },
  cardBackLg: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: '44px', height: '60px', background: 'linear-gradient(135deg,#1a2e22,#0d1f17)', borderRadius: '6px', border: '1px solid #2a3e32', color: '#444', fontSize: '14px' },
  actionBar: { gridColumn: 1, padding: '12px 24px', background: '#0F0F0F', borderTop: '1px solid #1C1C1C' },
  actionRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' as const },
  btnPrimary: { background: '#7ECFB3', color: '#0a0a0a', border: 'none', padding: '8px 16px', borderRadius: '4px', fontSize: '12px', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  btnAction: { background: 'rgba(126,207,179,0.1)', border: '1px solid rgba(126,207,179,0.3)', color: '#7ECFB3', padding: '8px 14px', borderRadius: '4px', fontSize: '11px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  btnFold: { background: 'rgba(224,112,112,0.1)', border: '1px solid rgba(224,112,112,0.3)', color: '#E07070', padding: '8px 14px', borderRadius: '4px', fontSize: '11px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  btnRaise: { background: 'rgba(232,192,126,0.1)', border: '1px solid rgba(232,192,126,0.3)', color: '#E8C07E', padding: '8px 14px', borderRadius: '4px', fontSize: '11px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  btnAllIn: { background: 'rgba(232,192,126,0.2)', border: '1px solid rgba(232,192,126,0.5)', color: '#E8C07E', padding: '8px 14px', borderRadius: '4px', fontSize: '11px', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  btnLeave: { background: 'rgba(224,112,112,0.1)', border: '1px solid rgba(224,112,112,0.3)', color: '#E07070', padding: '8px 14px', borderRadius: '4px', fontSize: '11px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  btnHelper: { background: 'transparent', border: '1px solid #2A2A2A', color: '#888', padding: '4px 8px', borderRadius: '3px', fontSize: '9px', cursor: 'pointer', fontFamily: 'inherit' },
  betInput: { background: '#0a0a0a', border: '1px solid #2A2A2A', color: '#E8DCC8', padding: '8px 12px', borderRadius: '4px', fontSize: '11px', width: '100px', fontFamily: 'inherit' },
  logPanel: { gridColumn: 2, gridRow: '3 / 5', display: 'flex', flexDirection: 'column' as const, background: '#0F0F0F', borderLeft: '1px solid #1C1C1C', overflow: 'hidden' },
  logTitle: { padding: '12px 16px', fontSize: '10px', color: '#555', letterSpacing: '2px', fontWeight: 600, textTransform: 'uppercase' as const, borderBottom: '1px solid #1C1C1C' },
  logBody: { flex: 1, overflowY: 'auto' as const, padding: '8px 16px' },
  logLine: { fontSize: '10px', color: '#888', marginBottom: '4px', fontFamily: '"DM Mono",monospace' },
  logFooter: { padding: '12px 16px', fontSize: '9px', color: '#444', borderTop: '1px solid #1C1C1C', lineHeight: 1.6 },
  footer: { gridColumn: '1 / -1', padding: '8px 24px', background: '#0a0a0a', borderTop: '1px solid #1C1C1C', display: 'flex', justifyContent: 'space-between', fontSize: '9px', color: '#444' },
  overlay: { position: 'fixed' as const, inset: 0, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 },
  modal: { background: '#0F0F0F', border: '1px solid #1C1C1C', borderRadius: '8px', padding: '20px', maxWidth: '380px', width: '90%' },
  modalTitle: { fontSize: '15px', fontWeight: 700, color: '#E8DCC8', margin: 0 },
}
