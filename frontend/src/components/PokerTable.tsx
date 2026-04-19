import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  formatEther, parseEther, keccak256, toHex, encodePacked,
  createWalletClient, createPublicClient, http,
} from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { useAccount, useReadContract, useReadContracts, useSendTransaction, useWriteContract } from 'wagmi'
import { POKER_GAME_ADDRESS, POKER_GAME_ABI } from '../config/contract'
import { useWalletBalance } from '../hooks/useWalletBalance'
import CashierModal from './CashierModal'

const RPC_URL_READ  = 'https://ini-poker.vercel.app/api/rpc'
const RPC_URL_WRITE = 'https://ini-poker.vercel.app/api/rpc'
const CHAIN_ID = 2649570508581093
const INIPOKER_CHAIN = {
  id: CHAIN_ID,
  name: 'INIPoker L2',
  nativeCurrency: { name: 'INIT', symbol: 'INIT', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL_WRITE] }, public: { http: [RPC_URL_WRITE] } },
} as const

const GAS_RESERVE_WEI = parseEther('0.3')
const ZERO_ADDR = '0x0000000000000000000000000000000000000000'

const SUITS = ['\u2660', '\u2665', '\u2666', '\u2663'] as const
const SUIT_COLORS = ['#0a0a0a', '#c41e1e', '#c41e1e', '#0a0a0a'] as const
const VALUES = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const
const STATUS_LABELS = ['Waiting', 'Dealing', 'Pre-Flop', 'Flop', 'Turn', 'River', 'Showdown', 'Settled']
const HAND_RANKS = ['', 'High Card', 'One Pair', 'Two Pair', 'Three of a Kind', 'Straight', 'Flush', 'Full House', 'Four of a Kind', 'Straight Flush', 'Royal Flush']

const SEAT_POSITIONS = [
  { top: '8%', left: '50%' },
  { top: '28%', left: '92%' },
  { top: '62%', left: '92%' },
  { top: '80%', left: '50%' },
  { top: '62%', left: '8%' },
  { top: '28%', left: '8%' },
]

function getRotatedPos(seatIdx: number, mySeat: number): { top: string, left: string } {
  const offset = (3 - mySeat + 6) % 6
  const visualIdx = (seatIdx + offset) % 6
  return SEAT_POSITIONS[visualIdx] || SEAT_POSITIONS[0]
}

function getStoredValue(key: string | null): string | null {
  if (!key || typeof window === 'undefined') return null
  return localStorage.getItem(key) ?? sessionStorage.getItem(key)
}

function setStoredValue(key: string | null, value: string) {
  if (!key || typeof window === 'undefined') return
  localStorage.setItem(key, value)
  sessionStorage.removeItem(key)
}

function removeStoredValue(key: string | null) {
  if (!key || typeof window === 'undefined') return
  localStorage.removeItem(key)
  sessionStorage.removeItem(key)
}

function encodeCardFromDecoded(suit: number, value: number): number {
  if (!suit && !value) return 0
  return (suit << 4) | value
}

function Card({ encoded, size = 'normal', flipDelay = 0 }: {
  encoded: number; size?: 'normal' | 'large' | 'small'; flipDelay?: number
}) {
  if (!encoded) return <span style={size === 'large' ? st.cardBackLg : size === 'small' ? st.cardBackSm : st.cardBack}>?</span>
  const suit = encoded >> 4
  const value = encoded & 0x0f
  const s = size === 'large' ? st.cardLg : size === 'small' ? st.cardSm : st.card
  return (
    <span style={{ ...s, color: SUIT_COLORS[suit], animation: `cardFlip 0.55s cubic-bezier(.2,.9,.3,1.2) ${flipDelay}s both` }}>
      {VALUES[value]}{SUITS[suit]}
    </span>
  )
}

function rankLabel(rank: number): string {
  if (!rank) return ''
  const cat = (rank >> 24) & 0xff
  return HAND_RANKS[cat] ?? `Rank ${cat}`
}

const CHIP_DENOMS = [
  { value: 100,  color: '#0a0a0a', accent: '#808080', label: '100' },
  { value: 25,   color: '#1a5a2a', accent: '#7ECFB3', label: '25'  },
  { value: 10,   color: '#1a3a6a', accent: '#8cb4ff', label: '10'  },
  { value: 5,    color: '#6a1a1a', accent: '#ff8080', label: '5'   },
  { value: 1,    color: '#5a4a1a', accent: '#E8C07E', label: '1'   },
  { value: 0.2,  color: '#3a3a3a', accent: '#cccccc', label: '.2'  },
]

function decomposeChips(amountStr: string) {
  const amount = parseFloat(amountStr)
  if (!amount || amount <= 0) return []
  let remaining = amount
  const result: Array<{ denom: typeof CHIP_DENOMS[0], count: number }> = []
  for (const d of CHIP_DENOMS) {
    if (remaining >= d.value - 1e-9) {
      const count = Math.floor(remaining / d.value + 1e-9)
      if (count > 0) {
        result.push({ denom: d, count: Math.min(count, 6) })
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
  const chipW = size === 'large' ? 24 : size === 'small' ? 12 : 16
  const thick = size === 'large' ? 4 : size === 'small' ? 2 : 3
  return (
    <div style={{ display: 'inline-flex', gap: '4px', alignItems: 'flex-end' }}>
      {stacks.map((s, i) => (
        <div key={i} style={{ position: 'relative', width: chipW + 'px', height: (s.count * thick + 8) + 'px' }}>
          {Array.from({ length: s.count }).map((_, j) => (
            <div key={j} style={{
              position: 'absolute',
              bottom: (j * thick) + 'px',
              left: 0,
              width: chipW + 'px',
              height: (chipW * 0.85) + 'px',
              borderRadius: '50%',
              background: `radial-gradient(ellipse at 50% 35%, ${s.denom.accent} 0%, ${s.denom.color} 75%)`,
              border: `1.5px dashed ${s.denom.accent}`,
              boxShadow: `0 1px 2px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.2)`,
              zIndex: j,
            }} />
          ))}
          {s.count > 1 && size !== 'small' && (
            <div style={{
              position: 'absolute',
              bottom: ((s.count - 1) * thick + 1) + 'px',
              left: 0,
              width: chipW + 'px',
              textAlign: 'center',
              fontSize: size === 'large' ? '8px' : '7px',
              color: '#fff',
              fontWeight: 700,
              textShadow: '0 1px 2px rgba(0,0,0,0.8)',
              lineHeight: 1,
              zIndex: 100,
            }}>{s.denom.label}</div>
          )}
        </div>
      ))}
    </div>
  )
}

function getHoleCardsFromDeck(deckSeed: `0x${string}`, dealerIdx: number, mySeatIdx: number, playerCount: number): [number, number] | null {
  if (!deckSeed || deckSeed === '0x0' || deckSeed === `0x${'0'.repeat(64)}` || playerCount < 2) return null
  try {
    const deck: number[] = []
    for (let suit = 0; suit < 4; suit++) {
      for (let value = 1; value <= 13; value++) {
        deck.push((suit << 4) | value)
      }
    }
    let h: `0x${string}` = deckSeed
    for (let i = 1; i < 52; i++) {
      h = keccak256(encodePacked(['bytes32', 'uint8'], [h, i]))
      const j = Number(BigInt(h) % BigInt(i + 1))
      if (i !== j) {
        const temp = deck[i]
        deck[i] = deck[j]
        deck[j] = temp
      }
    }
    let dealPos = -1
    for (let i = 0; i < playerCount; i++) {
      if ((dealerIdx + 1 + i) % playerCount === mySeatIdx) {
        dealPos = i
        break
      }
    }
    if (dealPos < 0) return null
    return [deck[dealPos], deck[playerCount + dealPos]]
  } catch {
    return null
  }
}

function BuyInModal({ bigBlind, gameBalance, walletBalance, onConfirm, onClose, isProcessing, sessionStatus }: {
  bigBlind: number; gameBalance: string; walletBalance: string
  onConfirm: (a: number) => void; onClose: () => void
  isProcessing: boolean; sessionStatus: string
}) {
  const minBuy = bigBlind * 10
  const maxBuy = bigBlind * 100
  const roomBal = parseFloat(gameBalance)
  const walletBal = parseFloat(walletBalance)
  const effMax = Math.max(minBuy, Math.min(maxBuy, roomBal || minBuy))
  const [val, setVal] = useState(Math.min(bigBlind * 50, effMax))
  const canJoin = roomBal >= minBuy && val >= minBuy && val <= roomBal

  return (
    <div style={st.overlay} onClick={!isProcessing ? onClose : undefined}>
      <div style={st.modal} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h2 style={st.modalTitle}>Buy In</h2>
          {!isProcessing && <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#555', fontSize: '18px', cursor: 'pointer' }}>{'\u2715'}</button>}
        </div>
        {isProcessing ? (
          <div style={{ padding: '24px 0', textAlign: 'center' }}>
            <div style={{ fontSize: '13px', color: '#E8DCC8', marginBottom: '8px' }}>{'\u23F3'} {sessionStatus || 'Preparing session...'}</div>
            <div style={{ fontSize: '10px', color: '#555' }}>Room balance stays on the owner wallet. Session key only plays the hand.</div>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: '12px', marginBottom: '12px' }}>
              <div style={{ flex: 1, padding: '8px 12px', background: 'rgba(126,207,179,0.05)', borderRadius: '6px' }}>
                <div style={{ fontSize: '9px', color: '#555', textTransform: 'uppercase', fontWeight: 600 }}>Room Balance</div>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#7ECFB3', marginTop: '2px' }}>{roomBal.toFixed(2)} INIT</div>
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
                <span>{minBuy.toFixed(1)} (10bb)</span><span>{effMax.toFixed(1)} (max)</span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '6px', marginBottom: '12px' }}>
              {[20, 50, 100].map(bb => {
                const a = bigBlind * bb
                return <button key={bb} onClick={() => setVal(Math.min(a, effMax))} style={{ ...st.btnHelper, flex: 1 }}>{bb}BB</button>
              })}
            </div>
            {roomBal < minBuy && <div style={{ padding: '8px', background: 'rgba(224,112,112,0.08)', border: '1px solid rgba(224,112,112,0.2)', borderRadius: '6px', fontSize: '11px', color: '#E07070', marginBottom: '12px' }}>Need at least {minBuy.toFixed(1)} INIT in room balance. Deposit via Cashier first.</div>}
            <div style={{ fontSize: '10px', color: '#555', marginBottom: '12px', lineHeight: 1.5 }}>
              Buy-in comes from <b style={{ color: '#E8DCC8' }}>room balance</b>. The session wallet only pays gas and signs in-game actions.
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

interface PState {
  addr: string
  chips: bigint
  currentBet: bigint
  isActive: boolean
  lastAction: number
  handRank: number
  revealedCard0: number
  revealedCard1: number
  hasRevealed: boolean
  seatIndex: number
  stake: bigint
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
  const { writeContractAsync: writeMainContractAsync, isPending: mainWritePending } = useWriteContract()
  const { walletBalance, gameBalance, isLoading: balLoading, refetch: refetchBal } = useWalletBalance(tableId)

  const sessionKey = useMemo(() => address ? `inipoker_session_${address.toLowerCase()}` : null, [address])
  const [sessionPk, setSessionPk] = useState<`0x${string}` | null>(null)

  useEffect(() => {
    if (!sessionKey) return
    setSessionPk(getStoredValue(sessionKey) as `0x${string}` | null)
  }, [sessionKey])

  const sessionAccount = useMemo(() => sessionPk ? privateKeyToAccount(sessionPk) : null, [sessionPk])
  const sessionAddr = sessionAccount?.address ?? null

  const publicClient = useMemo(() => createPublicClient({
    chain: INIPOKER_CHAIN as any,
    transport: http(RPC_URL_WRITE),
  }), [])

  const sWrite = useCallback(async (fnName: string, args: unknown[], value?: bigint, gasHint = 600_000n): Promise<`0x${string}`> => {
    if (!sessionAccount) throw new Error('Session wallet not set up')
    const wc = createWalletClient({
      account: sessionAccount,
      chain: INIPOKER_CHAIN as any,
      transport: http(RPC_URL_WRITE),
    })
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
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 })
    if (receipt.status !== 'success') throw new Error(`${fnName} reverted (${hash.slice(0, 10)})`)
    return hash
  }, [publicClient, sessionAccount])

  const { data: fullSession, refetch: refetchSession } = useReadContract({
    address: POKER_GAME_ADDRESS, abi: POKER_GAME_ABI, functionName: 'sessions', args: [tableId],
    query: { refetchInterval: 2000 },
  })
  const { data: players, refetch: refetchPlayers } = useReadContract({
    address: POKER_GAME_ADDRESS, abi: POKER_GAME_ABI, functionName: 'getPlayers', args: [tableId],
    query: { refetchInterval: 2000 },
  })
  const { data: communityData } = useReadContract({
    address: POKER_GAME_ADDRESS, abi: POKER_GAME_ABI, functionName: 'getCommunityCards', args: [tableId],
    query: { refetchInterval: 2000 },
  })

  const fs = fullSession as readonly any[] | undefined
  const handId = fs ? Number(fs[1]) : 0
  const status = fs ? Number(fs[5]) : 0
  const dealerIndex = fs ? Number(fs[6]) : 0
  const activePlayerIdx = fs ? Number(fs[7]) : 0
  const rawPlayerCount = fs ? Number(fs[8]) : 0
  const pot = fs ? (fs[9] as bigint) : 0n
  const currentBet = fs ? (fs[10] as bigint) : 0n
  const smallBlind = fs ? (fs[11] as bigint) : 0n
  const bigBlindWei = fs ? (fs[12] as bigint) : parseEther(bigBlind.toString())
  const vrfPending = fs ? Boolean(fs[13]) : false
  const deckSeed = fs ? (fs[15] as `0x${string}`) : ('0x0' as `0x${string}`)
  const communityCount = fs ? Number(fs[18]) : 0
  const saltsCommitted = fs ? Number(fs[19]) : 0
  const community = (communityData ? Array.from(communityData as any) : [0, 0, 0, 0, 0]) as number[]

  const playerAddrs = ((players as readonly `0x${string}`[] | undefined) ?? []).filter(addr => addr.toLowerCase() !== ZERO_ADDR)
  const playerStateContracts = playerAddrs.map(addr => ({
    address: POKER_GAME_ADDRESS, abi: POKER_GAME_ABI, functionName: 'getPlayerState', args: [tableId, addr],
  }))
  const revealedContracts = playerAddrs.map(addr => ({
    address: POKER_GAME_ADDRESS, abi: POKER_GAME_ABI, functionName: 'getRevealedCards', args: [tableId, addr],
  }))
  const { data: playerStatesData, refetch: refetchStates } = useReadContracts({
    contracts: playerStateContracts as any,
    query: { refetchInterval: 2000, enabled: playerAddrs.length > 0 },
  })
  const { data: revealedCardsData, refetch: refetchRevealed } = useReadContracts({
    contracts: revealedContracts as any,
    query: { refetchInterval: 2000, enabled: playerAddrs.length > 0 },
  })

  const allPlayersRaw: PState[] = playerAddrs.map((addr, i) => {
    const state = playerStatesData?.[i]?.result as any
    const revealed = revealedCardsData?.[i]?.result as any
    return {
      addr,
      stake: state ? (state[0] as bigint) : 0n,
      chips: state ? (state[0] as bigint) : 0n,
      currentBet: state ? (state[1] as bigint) : 0n,
      lastAction: state ? Number(state[2]) : 0,
      isActive: state ? Boolean(state[3]) : false,
      seatIndex: state ? Number(state[4]) : i,
      hasRevealed: state ? Boolean(state[6]) : false,
      handRank: state ? Number(state[7]) : 0,
      revealedCard0: revealed ? encodeCardFromDecoded(Number(revealed[0]), Number(revealed[1])) : 0,
      revealedCard1: revealed ? encodeCardFromDecoded(Number(revealed[2]), Number(revealed[3])) : 0,
    }
  })
  const allPlayers = allPlayersRaw.slice().sort((a, b) => a.seatIndex - b.seatIndex)
  const playerCount = rawPlayerCount

  const refreshAll = useCallback(() => {
    refetchSession()
    refetchPlayers()
    refetchStates()
    refetchRevealed()
    refetchBal()
  }, [refetchSession, refetchPlayers, refetchStates, refetchRevealed, refetchBal])

  const myPlayer = allPlayers.find(p => p.addr.toLowerCase() === address?.toLowerCase())
  const isSeated = !!myPlayer
  const isActiveInHand = !!myPlayer?.isActive
  const isSeatedAsZombie = !!myPlayer && !myPlayer.isActive && status >= 2 && status <= 6
  const myStake = myPlayer?.chips ?? 0n
  const myBet = myPlayer?.currentBet ?? 0n
  const mySeatIndex = myPlayer?.seatIndex ?? 0
  const activeTurnPlayer = allPlayers.find(p => p.seatIndex === activePlayerIdx)
  const isMyTurn = status >= 2 && status <= 5 && isActiveInHand && activeTurnPlayer?.addr?.toLowerCase() === address?.toLowerCase()

  const [holeCards, setHoleCards] = useState<[number, number] | null>(null)
  useEffect(() => {
    if (status >= 2 && status <= 7 && isSeated && deckSeed && deckSeed !== '0x0' && playerCount >= 2) {
      setHoleCards(getHoleCardsFromDeck(deckSeed, dealerIndex, mySeatIndex, playerCount))
    } else if (status <= 1) {
      setHoleCards(null)
    }
  }, [status, isSeated, deckSeed, dealerIndex, mySeatIndex, playerCount])

  useEffect(() => {
    const id = 'inipoker-anims-v6'
    if (!document.getElementById(id)) {
      const style = document.createElement('style')
      style.id = id
      style.textContent = `
        @keyframes cardFlip { 0% { transform: rotateY(180deg) scale(0.3); opacity: 0; filter: blur(2px); } 50% { transform: rotateY(90deg) scale(0.7); opacity: 0.4; filter: blur(0); } 100% { transform: rotateY(0) scale(1); opacity: 1; } }
        @keyframes dealIn { 0% { transform: translate(-50%, -300px) rotate(180deg) scale(0.3); opacity: 0; } 60% { transform: translate(-50%, 12px) rotate(0) scale(1.08); opacity: 1; } 100% { transform: translate(-50%, 0) rotate(0) scale(1); opacity: 1; } }
        @keyframes commSlide { 0% { transform: translateY(-80px) scale(0.3) rotateY(180deg); opacity: 0; } 70% { transform: translateY(6px) scale(1.08) rotateY(0); opacity: 1; } 100% { transform: translateY(0) scale(1) rotateY(0); } }
        @keyframes potPulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.04); } }
        @keyframes winnerGlow { 0%, 100% { box-shadow: 0 0 16px rgba(126,207,179,0.5), inset 0 0 8px rgba(126,207,179,0.2); } 50% { box-shadow: 0 0 48px rgba(126,207,179,0.95), inset 0 0 20px rgba(126,207,179,0.4); } }
        @keyframes chipBet { 0% { transform: translateY(30px) scale(0.3); opacity: 0; } 100% { transform: translateY(0) scale(1); opacity: 1; } }
        @keyframes pulseTurn { 0%, 100% { box-shadow: 0 0 0 0 rgba(232,192,126,0.6); } 50% { box-shadow: 0 0 0 10px rgba(232,192,126,0); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes stackGlow { 0%, 100% { filter: drop-shadow(0 0 4px rgba(126,207,179,0.3)); } 50% { filter: drop-shadow(0 0 12px rgba(126,207,179,0.7)); } }
      `
      document.head.appendChild(style)
    }
  }, [])

  const [actionLog, setActionLog] = useState<string[]>([])
  const logRef = useRef<HTMLDivElement>(null)
  const addLog = useCallback((msg: string) => {
    setActionLog(prev => [...prev.slice(-30), `${new Date().toLocaleTimeString().slice(0, 5)}: ${msg}`])
  }, [])
  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight) }, [actionLog])

  const [actionPending, setActionPending] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [localStatus, setLocalStatus] = useState<string | null>(null)
  const [betAmount, setBetAmount] = useState('')
  const [buyInOpen, setBuyInOpen] = useState(false)
  const [cashierOpen, setCashierOpen] = useState(false)
  const [sittingDown, setSittingDown] = useState(false)
  const [sessionStatus, setSessionStatus] = useState('')
  const [leaving, setLeaving] = useState(false)

  const txBusy = actionPending || sittingDown || leaving || mainWritePending

  // Salt storage scheme:
  //   During Waiting(0)/Settled(7), commit applies to the NEXT hand.
  //   Contract increments handId INSIDE requestDeal, so a salt committed
  //   at handId=N ends up belonging to hand N+1.
  //   During PreFlop..Showdown (2..6) reveal uses the CURRENT hand.
  //   We therefore use 'expected' handId when writing, and a fallback
  //   lookup (current -> +1 -> -1) when reading.
  const saltKeyPrefix = useMemo(
    () => address ? `inipoker_salt_${tableId.toString()}_${address.toLowerCase()}_` : null,
    [address, tableId]
  )
  const expectedHandId = useMemo(() => {
    if (status === 0 || status === 7) return handId + 1
    return handId
  }, [handId, status])
  const saltKey = useMemo(
    () => saltKeyPrefix ? `${saltKeyPrefix}${expectedHandId}` : null,
    [saltKeyPrefix, expectedHandId]
  )
  // Find a salt we stored earlier even if the handId window has shifted.
  // Try current expected, current-1, current+1 — covers any commit/deal race.
  const lookupSalt = useCallback((): { key: string; value: `0x${string}` } | null => {
    if (!saltKeyPrefix) return null
    const candidates = [expectedHandId, expectedHandId - 1, expectedHandId + 1, handId, handId + 1, handId - 1]
    const seen = new Set<number>()
    for (const hid of candidates) {
      if (hid < 0 || seen.has(hid)) continue
      seen.add(hid)
      const k = `${saltKeyPrefix}${hid}`
      const v = getStoredValue(k) as `0x${string}` | null
      if (v) return { key: k, value: v }
    }
    return null
  }, [saltKeyPrefix, expectedHandId, handId])
  // Remove salts for hands that are clearly behind us (> 2 hands old).
  const cleanupOldSalts = useCallback(() => {
    if (!saltKeyPrefix || typeof localStorage === 'undefined') return
    const keep = new Set([handId, handId + 1, handId - 1, expectedHandId])
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (!k || !k.startsWith(saltKeyPrefix)) continue
      const n = Number(k.slice(saltKeyPrefix.length))
      if (!Number.isFinite(n) || keep.has(n)) continue
      try { localStorage.removeItem(k) } catch {}
    }
  }, [saltKeyPrefix, handId, expectedHandId])
  // When a new hand starts (handId increments), wipe stale keys.
  useEffect(() => { cleanupOldSalts() }, [handId, cleanupOldSalts])

  // Auto-loop state must be defined before handlers so they can reset it.
  const autoBusyRef = useRef(false)
  const lastAutoKeyRef = useRef<string | null>(null)
  // Watchdog: if the on-chain state doesn't progress for a while but the loop
  // thinks it already acted, force a retry by clearing the key.
  const watchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // When the session wallet / address / table changes (e.g. user left and
  // came back with a new session), blow away the auto-loop lock so fresh
  // actions can start immediately instead of being blocked by stale refs.
  useEffect(() => {
    autoBusyRef.current = false
    lastAutoKeyRef.current = null
    if (watchdogTimerRef.current) { clearTimeout(watchdogTimerRef.current); watchdogTimerRef.current = null }
  }, [sessionAddr, address, tableId])

  const doAction = useCallback(async (fnName: string, args: unknown[], label: string) => {
    setActionPending(true)
    setLocalError(null)
    try {
      await sWrite(fnName, args)
      addLog(label)
    } catch (err: any) {
      setLocalError((err.shortMessage ?? err.message ?? String(err)).slice(0, 180))
    }
    setActionPending(false)
    setTimeout(refreshAll, 800)
    setTimeout(refreshAll, 2200)
  }, [addLog, refreshAll, sWrite])

  const handleFold  = () => address && doAction('playerActionFor', [tableId, address, 1, 0n], 'You folded')
  const handleCheck = () => address && doAction('playerActionFor', [tableId, address, 2, 0n], 'You checked')
  const handleBet   = () => address && doAction('playerActionFor', [tableId, address, 3, parseEther(betAmount || '0')], `You bet ${betAmount} INIT`)
  const handleCall  = () => address && doAction('playerActionFor', [tableId, address, 4, 0n], 'You called')
  const handleRaise = () => address && doAction('playerActionFor', [tableId, address, 5, parseEther(betAmount || '0')], `You raised ${betAmount} INIT`)
  const handleAllIn = () => address && doAction('playerActionFor', [tableId, address, 6, 0n], 'You went ALL-IN!')

  const handleCommit = useCallback(async () => {
    if (!sessionAccount || !address || !saltKey) return
    setActionPending(true)
    setLocalError(null)
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    const hex = toHex(bytes)
    const hash = keccak256(hex as `0x${string}`)
    setStoredValue(saltKey, hex)
    try {
      await sWrite('commitSaltFor', [tableId, address, hash])
      addLog('Salt committed')
    } catch (err: any) {
      const msg = (err.shortMessage ?? err.message ?? String(err)).slice(0, 180)
      // If commit reverted for any reason, the salt we just stored is useless —
      // remove it so next retry doesn't skip commit by mistake.
      if (!/SaltAlreadyCommitted|Salt already/i.test(String(err?.message ?? err))) {
        try { localStorage.removeItem(saltKey) } catch {}
      }
      setLocalError(msg)
      throw err
    } finally {
      setActionPending(false)
      setTimeout(refreshAll, 1000)
    }
  }, [address, addLog, refreshAll, sWrite, saltKey, sessionAccount, tableId])

  const handleDeal = useCallback(async () => {
    if (!address) return
    setActionPending(true)
    setLocalError(null)
    try {
      await sWrite('requestDealFor', [tableId, address], undefined, 800_000n)
      addLog('Dealing new hand')
    } catch (err: any) {
      const msg = (err.shortMessage ?? err.message ?? String(err)).slice(0, 180)
      setLocalError(msg)
      throw err
    } finally {
      setActionPending(false)
      setTimeout(refreshAll, 1500)
    }
  }, [address, addLog, refreshAll, sWrite, tableId])

  const handleReveal = useCallback(async () => {
    if (!address) return
    const found = lookupSalt()
    if (!found) {
      console.warn('[REVEAL] no salt found for handId', handId, 'expected', expectedHandId)
      // Throw so auto loop clears lastAutoKeyRef and retries; meanwhile a
      // teammate's reveal may still fire or the other side re-commits.
      throw new Error('Salt not found for this hand')
    }
    setActionPending(true)
    setLocalError(null)
    try {
      await sWrite('revealHoleCardsFor', [tableId, address, found.value])
      addLog('Cards revealed')
    } catch (err: any) {
      const msg = (err.shortMessage ?? err.message ?? String(err))
      if (/Not showdown|AlreadyRevealed|reverted/i.test(msg)) {
        console.log('[AUTO] reveal race — state already advanced, ignoring')
        return
      }
      setLocalError(msg.slice(0, 180))
      throw err
    } finally {
      setActionPending(false)
      setTimeout(refreshAll, 1500)
    }
  }, [address, addLog, refreshAll, sWrite, lookupSalt, tableId, handId, expectedHandId])

  const handleEvaluate = useCallback(async () => {
    setActionPending(true)
    setLocalError(null)
    try {
      await sWrite('evaluateShowdown', [tableId], undefined, 800_000n)
      addLog('Showdown resolved')
    } catch (err: any) {
      const msg = (err.shortMessage ?? err.message ?? String(err))
      // Race: the OTHER client already called evaluateShowdown and advanced
      // the table out of Showdown status. Our tx then reverts with "Not showdown".
      // Also handle wagmi-side "reverted" where the underlying cause is status mismatch.
      const isLateDup = /Not showdown|reverted/i.test(msg)
      if (isLateDup) {
        console.log('[AUTO] evaluateShowdown race — other client already settled, ignoring')
        addLog('Showdown resolved (by peer)')
        // Don't surface as an error. Don't rethrow — the state has already
        // advanced to Settled; auto-loop should move on to next-hand commit.
        return
      }
      setLocalError(msg.slice(0, 180))
      throw err
    } finally {
      setActionPending(false)
      setTimeout(refreshAll, 1500)
    }
  }, [addLog, refreshAll, sWrite, tableId])

  const handleSitDown = async (buyIn: number) => {
    if (!address || !sessionKey) return
    setLocalError(null)
    setSittingDown(true)
    // Reset any stale auto-loop locks from a previous rejoin.
    autoBusyRef.current = false
    lastAutoKeyRef.current = null
    try {
      let pk = getStoredValue(sessionKey) as `0x${string}` | null
      if (!pk) {
        pk = generatePrivateKey()
        setStoredValue(sessionKey, pk)
      }
      setSessionPk(pk)
      const account = privateKeyToAccount(pk)
      const sessAddr = account.address

      const onChainPlayers = await publicClient.readContract({
        address: POKER_GAME_ADDRESS,
        abi: POKER_GAME_ABI,
        functionName: 'getPlayers',
        args: [tableId],
      }) as readonly `0x${string}`[]
      if (onChainPlayers.some(p => p.toLowerCase() === address.toLowerCase())) {
        setSessionStatus('Already seated - reattaching session')
        setBuyInOpen(false)
        addLog('Reattached to existing seat')
        setSessionStatus('')
        refreshAll()
        setSittingDown(false)
        return
      }

      const onChainSession = await publicClient.readContract({
        address: POKER_GAME_ADDRESS,
        abi: POKER_GAME_ABI,
        functionName: 'sessions',
        args: [tableId],
      }) as readonly any[]
      const tableStatus = Number(onChainSession[5])
      if (tableStatus !== 0 && tableStatus !== 7) {
        throw new Error(`Cannot join while a hand is in progress (${STATUS_LABELS[tableStatus]}).`)
      }

      const buyInWei = parseEther(buyIn.toString())
      const roomBalance = await publicClient.readContract({
        address: POKER_GAME_ADDRESS,
        abi: POKER_GAME_ABI,
        functionName: 'getBalance',
        args: [address],
      }) as bigint
      if (roomBalance < buyInWei) {
        throw new Error('Not enough room balance. Deposit via Cashier first.')
      }

      const authorized = await publicClient.readContract({
        address: POKER_GAME_ADDRESS,
        abi: POKER_GAME_ABI,
        functionName: 'isSessionAuthorized',
        args: [address, sessAddr],
      }) as boolean

      if (!authorized) {
        setSessionStatus('Authorizing session...')
        const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30)
        const authHash = await writeMainContractAsync({
          address: POKER_GAME_ADDRESS,
          abi: POKER_GAME_ABI,
          functionName: 'authorizeSession',
          args: [sessAddr, expiresAt],
          gas: 300_000n,
          gasPrice: 1_000_000_000n,
        })
        await publicClient.waitForTransactionReceipt({ hash: authHash as `0x${string}`, timeout: 30_000 })
      }

      const sessBalBefore = await publicClient.getBalance({ address: sessAddr as `0x${string}` })
      const shortfall = GAS_RESERVE_WEI > sessBalBefore ? GAS_RESERVE_WEI - sessBalBefore : 0n
      if (shortfall > 0n) {
        setSessionStatus('Funding session gas...')
        const fundHash = await sendTransactionAsync({
          to: sessAddr as `0x${string}`,
          value: shortfall,
          gas: 100_000n,
          gasPrice: 1_000_000_000n,
        })
        await publicClient.waitForTransactionReceipt({ hash: fundHash, timeout: 30_000 })
      }

      setSessionStatus('Joining table...')
      const sessClient = createWalletClient({
        account,
        chain: INIPOKER_CHAIN as any,
        transport: http(RPC_URL_WRITE),
      })
      const joinHash = await sessClient.writeContract({
        address: POKER_GAME_ADDRESS,
        abi: POKER_GAME_ABI,
        functionName: 'joinTableFor',
        args: [tableId, address, buyInWei],
        gas: 500_000n,
        gasPrice: 1_000_000_000n,
        account,
        chain: INIPOKER_CHAIN as any,
      } as any)
      await publicClient.waitForTransactionReceipt({ hash: joinHash, timeout: 30_000 })

      setSessionStatus('')
      setBuyInOpen(false)
      addLog(`Seated with ${buyIn} INIT from room balance`)
      refreshAll()
    } catch (err: any) {
      console.error('[SIT-DOWN] failed:', err)
      const raw = err?.shortMessage ?? err?.message ?? String(err)
      // Detect ABI/address mismatch (viem out-of-bounds decode errors)
      const friendly = /out of bounds|AbiDecodingOutOfBounds|Position \d+/.test(raw)
        ? 'Frontend ABI/address does not match deployed contract. Please refresh or contact support.'
        : raw
      setLocalError(friendly.slice(0, 240))
      setSessionStatus('')
    }
    setSittingDown(false)
  }

  const handleLeaveTable = async () => {
    if (!sessionAccount || !address) return
    setLeaving(true)
    setLocalError(null)
    // Reset auto-loop locks so future rejoins trigger auto-commit again.
    autoBusyRef.current = false
    lastAutoKeyRef.current = null
    try {
      let latestStatus = status
      if (latestStatus === 6 && myPlayer?.isActive && !myPlayer.hasRevealed) {
        const found = lookupSalt()
        if (found) {
          setLocalStatus('Revealing cards...')
          await sWrite('revealHoleCardsFor', [tableId, address, found.value])
          await new Promise(r => setTimeout(r, 1500))
        }
      }

      let latestSession = await publicClient.readContract({
        address: POKER_GAME_ADDRESS,
        abi: POKER_GAME_ABI,
        functionName: 'sessions',
        args: [tableId],
      }) as readonly any[]
      latestStatus = Number(latestSession[5])

      if (latestStatus === 6) {
        const latestPlayers = await publicClient.readContract({
          address: POKER_GAME_ADDRESS,
          abi: POKER_GAME_ABI,
          functionName: 'getPlayers',
          args: [tableId],
        }) as readonly `0x${string}`[]
        const states = await Promise.all(latestPlayers.filter(Boolean).map(player => publicClient.readContract({
          address: POKER_GAME_ADDRESS,
          abi: POKER_GAME_ABI,
          functionName: 'getPlayerState',
          args: [tableId, player],
        }))) as readonly any[]
        const everyoneRevealed = states.every(state => !Boolean(state[3]) || Boolean(state[6]))
        if (everyoneRevealed) {
          setLocalStatus('Settling showdown...')
          await sWrite('evaluateShowdown', [tableId], undefined, 800_000n)
          await new Promise(r => setTimeout(r, 1500))
          latestSession = await publicClient.readContract({
            address: POKER_GAME_ADDRESS,
            abi: POKER_GAME_ABI,
            functionName: 'sessions',
            args: [tableId],
          }) as readonly any[]
          latestStatus = Number(latestSession[5])
        }
      }

      if (latestStatus !== 0 && latestStatus !== 7) {
        throw new Error('You can leave once the current hand finishes.')
      }

      if (isSeated) {
        setLocalStatus('Leaving table...')
        await sWrite('leaveTableFor', [tableId, address], undefined, 500_000n)
      }
      // Purge every salt we ever stored for this table+player (any handId)
      if (saltKeyPrefix && typeof localStorage !== 'undefined') {
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const k = localStorage.key(i)
          if (k && k.startsWith(saltKeyPrefix)) { try { localStorage.removeItem(k) } catch {} }
        }
      }
      setLocalStatus(null)
      addLog('Left table - chips returned to room balance')
      refreshAll()
    } catch (err: any) {
      setLocalError((err.shortMessage ?? err.message ?? String(err)).slice(0, 220))
      setLocalStatus(null)
    }
    setLeaving(false)
  }

  const handleCloseSession = useCallback(() => {
    if (isSeated) return
    removeStoredValue(sessionKey)
    if (saltKeyPrefix && typeof localStorage !== 'undefined') {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i)
        if (k && k.startsWith(saltKeyPrefix)) { try { localStorage.removeItem(k) } catch {} }
      }
    }
    setSessionPk(null)
    setLocalStatus('Session cleared on this device')
    setTimeout(() => setLocalStatus(null), 1500)
  }, [isSeated, saltKeyPrefix, sessionKey])

  useEffect(() => {
    if (!sessionAccount || !address || !isSeated || !saltKeyPrefix || autoBusyRef.current || txBusy) {
      if (isSeated && sessionAccount && (status === 0 || status === 7)) {
        console.log('[AUTO-GUARD]', {
          hasSess: !!sessionAccount, hasAddr: !!address, isSeated,
          hasSaltPrefix: !!saltKeyPrefix, busy: autoBusyRef.current, txBusy,
        })
      }
      return
    }

    const activeCount = allPlayers.filter(p => p.isActive).length
    const playersWithChips = allPlayers.filter(p => p.chips > 0n)
    const enoughChippedPlayers = playersWithChips.length >= 2
    const iHaveChips = (myPlayer?.chips ?? 0n) > 0n

    const stateKey = `${handId}-${status}-${saltsCommitted}-${communityCount}-${activeCount}-${myPlayer?.hasRevealed ? 'r' : 'n'}`
    if (lastAutoKeyRef.current === stateKey) {
      if (status === 0 || status === 7) {
        console.log('[AUTO-SKIP] stateKey unchanged:', stateKey)
      }
      return
    }
    console.log('[AUTO-TICK]', { stateKey, status, saltsCommitted, playerCount, enoughChippedPlayers, iHaveChips })

    const hasAnyUsableSalt = lookupSalt() !== null

    const runAuto = (fn: () => Promise<unknown>, retryDelay = 4000) => {
      lastAutoKeyRef.current = stateKey
      autoBusyRef.current = true
      fn()
        .then(() => {
          setTimeout(() => { autoBusyRef.current = false; refreshAll() }, 2500)
        })
        .catch((err) => {
          console.warn('[AUTO] action failed, retrying:', err)
          setTimeout(() => {
            autoBusyRef.current = false
            lastAutoKeyRef.current = null
            refreshAll()
          }, retryDelay)
        })
    }

    // Commit: only if I have chips AND >=2 chipped players; salt goes under expectedHandId (handId+1).
    if ((status === 0 || status === 7) && playerCount >= 2 && saltsCommitted < playerCount) {
      if (!enoughChippedPlayers || !iHaveChips) return
      // Even if a local salt exists, on-chain state might disagree (stale salt
      // from an earlier contract deploy, a dropped tx, or a pre-leave session).
      // We try to commit anyway — contract will revert with SaltAlreadyCommitted
      // if it turns out we really did commit already, and the loop will move on.
      const existingSalt = getStoredValue(saltKey)
      if (!existingSalt) {
        // No local salt — plain commit path.
      }
      // Short pause after showdown so players can read the winner banner
      const delay = status === 7 ? 5000 : 0
      lastAutoKeyRef.current = stateKey
      autoBusyRef.current = true
      setTimeout(() => {
        handleCommit()
          .then(() => setTimeout(() => { autoBusyRef.current = false; refreshAll() }, 2500))
          .catch((err: any) => {
            const msg = String(err?.message ?? err)
            // If it's SaltAlreadyCommitted, that's fine — clear local stale salt
            // so next hand doesn't inherit it, but don't treat as error.
            if (/SaltAlreadyCommitted|Salt already/i.test(msg)) {
              console.log('[AUTO] salt already committed on-chain, moving on')
            }
            setTimeout(() => {
              autoBusyRef.current = false
              lastAutoKeyRef.current = null
              refreshAll()
            }, 4000)
          })
      }, delay)
      return
    }
    // Deal: all salts in, fire requestDealFor
    if ((status === 0 || status === 7) && playerCount >= 2 && saltsCommitted >= playerCount) {
      if (!enoughChippedPlayers) { console.log('[AUTO-DEAL-SKIP] not enough chipped players'); return }
      console.log('[AUTO-DEAL] firing requestDealFor')
      runAuto(handleDeal)
      return
    }
    // SHOWDOWN PHASE (status===6)
    // Handle last-man-standing FIRST — if only one active player remains
    // (e.g. after a fold), the contract already switched status to Showdown
    // but does NOT auto-settle. A folded seat cannot reveal, and the
    // remaining active player has no incentive/obligation to reveal either.
    // Trying `revealHoleCardsFor` here reverts (0x4f6184a8 from contract),
    // which kept the auto-loop stuck retrying reveal and never calling
    // evaluate/settle. Settle takes priority.
    if (status === 6) {
      const active = allPlayers.filter(p => p.isActive)
      if (active.length === 1) {
        runAuto(handleEvaluate)  // evaluateShowdown handles last-standing path internally
        return
      }
    }
    // Reveal: only when 2+ active remain and this seat hasn't revealed yet.
    if (status === 6 && myPlayer?.isActive && !myPlayer.hasRevealed) {
      const activeNow = allPlayers.filter(p => p.isActive)
      if (activeNow.length >= 2 && hasAnyUsableSalt) {
        runAuto(handleReveal)
        return
      }
    }
    // Evaluate: when all 2+ active players have revealed
    if (status === 6) {
      const active = allPlayers.filter(p => p.isActive)
      if (active.length >= 2 && active.every(p => p.hasRevealed)) {
        runAuto(handleEvaluate)
        return
      }
    }
  }, [address, allPlayers, communityCount, handleCommit, handleDeal, handleEvaluate, handleReveal,
      handId, isSeated, myPlayer?.hasRevealed, myPlayer?.chips, myPlayer?.isActive, playerCount,
      refreshAll, saltKey, saltKeyPrefix, saltsCommitted, sessionAccount, status, txBusy, lookupSalt])

  // Watchdog: every 2s check if we've been stuck (autoBusyRef true) for >8s
  // in the same on-chain state. If so, forcibly release the lock.
  const watchdogStateRef = useRef<{ key: string; at: number }>({ key: '', at: 0 })
  useEffect(() => {
    if (!isSeated || !sessionAccount) return
    const interval = setInterval(() => {
      const key = `${handId}-${status}-${saltsCommitted}-${communityCount}`
      const now = Date.now()
      if (watchdogStateRef.current.key !== key) {
        watchdogStateRef.current = { key, at: now }
        return
      }
      // Same state for how long?
      const stuckMs = now - watchdogStateRef.current.at
      if (autoBusyRef.current && stuckMs > 8000) {
        console.warn('[WATCHDOG] busy 8s in state', key, '- releasing lock')
        autoBusyRef.current = false
        lastAutoKeyRef.current = null
        refreshAll()
        watchdogStateRef.current.at = now  // reset so we don't fire every 2s
      }
    }, 2000)
    return () => clearInterval(interval)
  }, [handId, status, saltsCommitted, communityCount, isSeated, sessionAccount, refreshAll])

  // Track how long we've been stuck in Dealing (VRF callback pending).
  // If longer than 20s, surface a clear UI warning.
  const [vrfStale, setVrfStale] = useState(false)
  const vrfEnteredAtRef = useRef<number>(0)
  useEffect(() => {
    if (status === 1 || vrfPending) {
      if (vrfEnteredAtRef.current === 0) vrfEnteredAtRef.current = Date.now()
      const interval = setInterval(() => {
        if (Date.now() - vrfEnteredAtRef.current > 20_000) setVrfStale(true)
      }, 1000)
      return () => clearInterval(interval)
    }
    vrfEnteredAtRef.current = 0
    if (vrfStale) setVrfStale(false)
  }, [status, vrfPending, vrfStale])

  const [timeLeft, setTimeLeft] = useState(45)
  const turnStartRef = useRef<number>(0)
  useEffect(() => {
    if (!isMyTurn) {
      setTimeLeft(45)
      turnStartRef.current = 0
      return
    }
    if (turnStartRef.current === 0) turnStartRef.current = Date.now()
    const interval = setInterval(() => {
      const elapsed = (Date.now() - turnStartRef.current) / 1000
      setTimeLeft(Math.max(0, 45 - elapsed))
    }, 250)
    return () => clearInterval(interval)
  }, [isMyTurn])

  const winner = status === 7 ? allPlayers.reduce((best, p) => p.handRank > (best?.handRank || 0) ? p : best, null as PState | null) : null
  const potF = parseFloat(formatEther(pot))
  const setBetHelper = (amount: number) => setBetAmount(amount.toFixed(2))

  return (
    <div style={st.root}>
      <header style={st.header}>
        <div style={st.brand}>
          {onBack && <button onClick={onBack} style={st.btnBack}>{'\u2190'} Back</button>}
          <span style={{ color: '#E8DCC8', fontSize: '14px' }}>{'\u25C6'}</span>
          <h1 style={st.title}>{tableName}</h1>
          <span style={st.badge}>{STATUS_LABELS[status]}</span>
          {sessionAccount && <span style={st.sessionBadge}>{'\u26A1'} Session</span>}
        </div>
        <div style={st.headerRight}>
          <button onClick={() => setCashierOpen(true)} style={st.btnCashier}>Cashier</button>
          {address && <span style={st.addr}>{address.slice(0, 6)}...{address.slice(-4)}</span>}
        </div>
      </header>

      <div style={st.statusBar}>
        {isConnected && <span style={st.balVal}>Wallet: {balLoading ? '...' : walletBalance} INIT</span>}
        {isConnected && <span style={st.balVal}>Room: {balLoading ? '...' : gameBalance} INIT</span>}
        {isSeated && <span style={{ ...st.balVal, color: '#7ECFB3', fontWeight: 700 }}>Stack: {formatEther(myStake)} INIT</span>}
        {isMyTurn && <span style={{ color: '#E8C07E', fontWeight: 700, fontSize: '12px', animation: 'pulseTurn 1.2s ease-in-out infinite' }}>{'\u26A1'} YOUR TURN ({Math.ceil(timeLeft)}s)</span>}
      </div>

      {(localStatus || sessionStatus) && <div style={st.banner}>{'\u23F3'} {localStatus || sessionStatus}</div>}
      {localError && <div style={st.errBanner}>{localError}</div>}
      {isSeatedAsZombie && <div style={{ ...st.banner, color: '#E07070' }}>This hand has you folded. Your seat stays reserved until showdown settles.</div>}

      <div style={st.body}>
        <div style={st.mainCol}>
          <div style={st.tableArea}>
            <div style={st.tableFelt}>
              <div style={st.potArea}>
                <div style={st.potLabel}>POT</div>
                <div style={{ ...st.potValue, animation: pot > 0n ? 'potPulse 2s ease-in-out infinite' : 'none' }}>
                  {pot > 0n ? formatEther(pot) : '\u2014'} <span style={{ fontSize: '11px', color: '#888' }}>INIT</span>
                </div>
                {pot > 0n && <div style={{ marginTop: '8px', display: 'flex', justifyContent: 'center', animation: 'stackGlow 2s ease-in-out infinite' }}><ChipStack amountWei={pot} size="large" /></div>}
                {currentBet > 0n && <div style={{ fontSize: '10px', color: '#888', marginTop: '4px' }}>Current bet: {formatEther(currentBet)} INIT</div>}
                {status === 1 && !vrfStale && <div style={st.potHint}>Waiting for VRF callback...</div>}
                {status === 1 && vrfStale && (
                  <div style={{ ...st.potHint, color: '#E07070' }}>
                    VRF callback stuck. Randomness provider did not respond.<br/>
                    <span style={{ fontSize: '10px', color: '#E8C07E' }}>The mock VRF may be misconfigured (autoFulfill=false) or vrfProvider address doesn't match.</span>
                  </div>
                )}
                {status === 0 && playerCount < 2 && <div style={st.potHint}>Waiting for players... ({playerCount}/2)</div>}
                {(status === 0 || status === 7) && playerCount >= 2 && saltsCommitted < playerCount && (
                  <div style={{ ...st.potHint, color: '#7ECFB3' }}>Waiting for all salts ({saltsCommitted}/{playerCount})...</div>
                )}
                {(status === 0 || status === 7) && playerCount >= 2 && saltsCommitted >= playerCount && !vrfPending && (
                  <div style={{ ...st.potHint, color: '#E8C07E' }}>Ready to request deal...</div>
                )}
                {(status === 0 || status === 7) && playerCount >= 2 && saltsCommitted >= playerCount && vrfPending && (
                  <div style={{ ...st.potHint, color: '#E8C07E' }}>Requesting deal...</div>
                )}
              </div>

              {communityCount > 0 && status >= 3 && status <= 7 && playerCount >= 1 && (
                <div style={st.communityArea}>
                  {community.slice(0, communityCount).map((c, i) => (
                    <div key={`c${i}-${c}`} style={{ animation: `commSlide 0.55s cubic-bezier(.25,.9,.3,1.2) ${i * 0.2}s both` }}>
                      <Card encoded={c} size="large" flipDelay={i * 0.2} />
                    </div>
                  ))}
                </div>
              )}

              {holeCards && status >= 2 && status <= 6 && isSeated && (
                <div style={st.holeArea}>
                  <div style={{ animation: 'dealIn 0.55s cubic-bezier(.25,.9,.3,1.2) 0s both' }}><Card encoded={holeCards[0]} size="large" /></div>
                  <div style={{ animation: 'dealIn 0.55s cubic-bezier(.25,.9,.3,1.2) 0.15s both' }}><Card encoded={holeCards[1]} size="large" /></div>
                </div>
              )}

              <div style={st.seatsContainer}>
                {Array.from({ length: 6 }, (_, seatIdx) => {
                  const player = allPlayers.find(p => p.seatIndex === seatIdx)
                  const pos = getRotatedPos(seatIdx, mySeatIndex)
                  if (!player) {
                    return <div key={seatIdx} style={{ ...st.seatWrap, ...pos, transform: 'translate(-50%,-50%)' }}><div style={st.emptySeat}>Seat {seatIdx}</div></div>
                  }
                  const isMe = player.addr.toLowerCase() === address?.toLowerCase()
                  const isTurn = status >= 2 && status <= 5 && activePlayerIdx === seatIdx
                  const isDealer = dealerIndex === seatIdx
                  const isSB = playerCount > 0 && (dealerIndex + 1) % playerCount === seatIdx
                  const isBB = playerCount > 0 && (dealerIndex + 2) % playerCount === seatIdx
                  const isWinner = winner?.addr === player.addr
                  const isFolded = status >= 2 && status <= 6 && !player.isActive
                  return (
                    <div key={seatIdx} style={{ ...st.seatWrap, ...pos, transform: 'translate(-50%,-50%)' }}>
                      {player.currentBet > 0n && (
                        <div style={st.seatBetChips}>
                          <ChipStack amountWei={player.currentBet} size="small" />
                          <div style={{ fontSize: '10px', color: '#E8C07E', fontWeight: 700, marginTop: '3px', textShadow: '0 1px 2px rgba(0,0,0,0.8)' }}>{formatEther(player.currentBet)}</div>
                        </div>
                      )}
                      <div style={{ ...st.seat, ...(isMe ? st.seatMe : {}), ...(isTurn ? st.seatTurn : {}), ...(isFolded ? st.seatFolded : {}), ...(isWinner ? { animation: 'winnerGlow 1.5s ease-in-out infinite' } : {}) }}>
                        <div style={st.seatBadges}>
                          {isDealer && <span style={st.badgeDealer}>D</span>}
                          {isSB && <span style={st.badgeBlind}>SB</span>}
                          {isBB && <span style={st.badgeBlind}>BB</span>}
                        </div>
                        <div style={st.seatAvatar}><div style={{ fontSize: '15px' }}>{isMe ? '\u26A1' : '\u2659'}</div></div>
                        <div style={st.seatName}>{isMe ? 'You' : `${player.addr.slice(0, 6)}...${player.addr.slice(-4)}`}</div>
                        <div style={st.seatStack}>{parseFloat(formatEther(player.chips)).toFixed(2)} INIT</div>
                        {player.chips > 0n && <div style={{ display: 'flex', justifyContent: 'center', marginTop: '4px' }}><ChipStack amountWei={player.chips} size="small" /></div>}
                        {isTurn && <div style={{ marginTop: '5px', width: '100%' }}><div style={st.timerBar}><div style={{ ...st.timerFill, width: `${(timeLeft / 45) * 100}%`, background: timeLeft < 10 ? '#E07070' : timeLeft < 20 ? '#E8C07E' : '#7ECFB3' }} /></div></div>}
                        {!isMe && !isFolded && status >= 2 && status <= 5 && <div style={{ display: 'flex', gap: '3px', justifyContent: 'center', marginTop: '4px' }}><span style={st.cardBackSm}>?</span><span style={st.cardBackSm}>?</span></div>}
                        {status >= 6 && player.hasRevealed && <div style={st.seatHand}><Card encoded={player.revealedCard0} size="small" /><Card encoded={player.revealedCard1} size="small" /></div>}
                        {isFolded && <div style={st.foldedLabel}>FOLDED</div>}
                        {isWinner && <div style={st.winLabel}>WINNER {rankLabel(player.handRank)}</div>}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

          <div style={st.actionBar}>
            <div style={st.actionRow}>
              {!isSeated && !sessionAccount && <button onClick={() => setBuyInOpen(true)} style={st.btnPrimary} disabled={txBusy || !isConnected}>{sittingDown ? 'Setting up...' : '\u2659 Sit Down'}</button>}

              {!isSeated && sessionAccount && (
                <>
                  <button onClick={() => setBuyInOpen(true)} style={st.btnPrimary} disabled={txBusy}>{sittingDown ? 'Setting up...' : '\u2659 Sit Down'}</button>
                  <button onClick={handleCloseSession} style={st.btnLeave} disabled={txBusy}>Close Session</button>
                </>
              )}

              {isSeated && <button onClick={handleLeaveTable} style={st.btnLeave} disabled={leaving || txBusy}>{leaving ? 'Leaving...' : 'Leave Table'}</button>}

              {status >= 2 && status <= 5 && isActiveInHand && isMyTurn && (
                <>
                  <button onClick={handleFold} style={st.btnFold} disabled={txBusy}>Fold</button>
                  {currentBet === myBet ? <button onClick={handleCheck} style={st.btnAction} disabled={txBusy}>Check</button> : <button onClick={handleCall} style={st.btnAction} disabled={txBusy}>Call {formatEther(currentBet - myBet)}</button>}
                  <input type="number" placeholder="Amount" value={betAmount} onChange={e => setBetAmount(e.target.value)} style={st.betInput} />
                  <button onClick={currentBet > 0n ? handleRaise : handleBet} style={st.btnRaise} disabled={txBusy || !betAmount}>{currentBet > 0n ? 'Raise' : 'Bet'}</button>
                  <button onClick={handleAllIn} style={st.btnAllIn} disabled={txBusy}>All-In</button>
                  <div style={{ display: 'flex', gap: '4px' }}>
                    <button onClick={() => setBetHelper(potF * 0.5)} style={st.btnHelper}>{'\u00BD'} Pot</button>
                    <button onClick={() => setBetHelper(potF)} style={st.btnHelper}>Pot</button>
                    <button onClick={() => setBetHelper(potF * 2)} style={st.btnHelper}>2x Pot</button>
                  </div>
                </>
              )}

              {status >= 2 && status <= 5 && isSeated && !isMyTurn && <span style={{ color: '#888', fontSize: '12px' }}>Waiting for opponent...</span>}

              {(status === 0 || status === 7) && isSeated && playerCount >= 2 && (
                <span style={{ color: '#7ECFB3', fontSize: '12px' }}>
                  {saltsCommitted < playerCount
                    ? `\u23F3 Waiting for salts (${saltsCommitted}/${playerCount})`
                    : vrfPending
                      ? '\u23F3 Requesting deal...'
                      : '\u23F3 Ready to deal...'}
                </span>
              )}

              {status === 6 && isSeated && myPlayer?.isActive && (
                <span style={{ color: '#7ECFB3', fontSize: '12px' }}>
                  {!myPlayer.hasRevealed ? '\u23F3 Revealing...' : '\u23F3 Evaluating...'}
                </span>
              )}

              {txBusy && <span style={{ color: '#E8DCC8', fontSize: '11px', fontWeight: 600, marginLeft: 'auto' }}>Processing...</span>}
            </div>
          </div>
        </div>

        <div style={st.logPanel}>
          <div style={st.logTitle}>ACTION LOG</div>
          <div ref={logRef} style={st.logBody}>
            {actionLog.length === 0 ? <div style={{ color: '#444', fontSize: '11px' }}>No actions yet</div> : actionLog.map((line, i) => <div key={i} style={st.logLine}>{line}</div>)}
          </div>
          <div style={st.logFooter}>
            <div>Blinds: {formatEther(smallBlind)}/{formatEther(bigBlindWei)} INIT</div>
            <div>Table #{tableId.toString()}</div>
            {sessionAddr && <div>Session: {sessionAddr.slice(0, 6)}...{sessionAddr.slice(-4)}</div>}
          </div>
        </div>
      </div>

      {buyInOpen && <BuyInModal bigBlind={bigBlind} gameBalance={gameBalance} walletBalance={walletBalance} onConfirm={handleSitDown} onClose={() => setBuyInOpen(false)} isProcessing={sittingDown} sessionStatus={sessionStatus} />}
      <CashierModal isOpen={cashierOpen} onClose={() => setCashierOpen(false)} walletBalance={walletBalance} gameBalance={gameBalance} isLoading={balLoading} onRefreshBalances={refetchBal} />

      <footer style={st.footer}>
        <span>INIPoker</span>
        <span style={{ color: '#1C1C1C' }}>Room Balance · Session Operator · Band VRF</span>
      </footer>
    </div>
  )
}


const st = {
  root: { display: 'flex', flexDirection: 'column' as const, minHeight: '100vh', background: '#0a0a0a', color: '#E8DCC8', fontFamily: '"DM Mono",monospace' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 24px', background: '#0F0F0F', borderBottom: '1px solid #1C1C1C', flexShrink: 0 },
  brand: { display: 'flex', alignItems: 'center', gap: '12px' },
  btnBack: { background: 'none', border: '1px solid #2A2A2A', color: '#888', padding: '4px 10px', borderRadius: '4px', fontSize: '11px', cursor: 'pointer', fontFamily: 'inherit' },
  title: { fontSize: '15px', fontWeight: 700, color: '#E8DCC8', margin: 0 },
  badge: { fontSize: '10px', padding: '3px 8px', background: 'rgba(126,207,179,0.15)', color: '#7ECFB3', borderRadius: '4px', fontWeight: 600, textTransform: 'uppercase' as const },
  sessionBadge: { fontSize: '10px', padding: '3px 8px', background: 'rgba(232,192,126,0.15)', color: '#E8C07E', borderRadius: '4px', fontWeight: 600 },
  headerRight: { display: 'flex', alignItems: 'center', gap: '12px' },
  btnCashier: { background: 'rgba(126,207,179,0.1)', border: '1px solid rgba(126,207,179,0.3)', color: '#7ECFB3', padding: '6px 14px', borderRadius: '4px', fontSize: '11px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  addr: { fontSize: '10px', color: '#666' },
  statusBar: { display: 'flex', alignItems: 'center', gap: '16px', padding: '6px 24px', background: '#0a0a0a', borderBottom: '1px solid #1C1C1C', fontSize: '11px', flexShrink: 0 },
  balVal: { color: '#888' },
  banner: { padding: '8px 24px', background: 'rgba(126,207,179,0.08)', borderBottom: '1px solid rgba(126,207,179,0.15)', color: '#7ECFB3', fontSize: '11px', animation: 'fadeIn 0.3s ease-out', flexShrink: 0 },
  errBanner: { padding: '8px 24px', background: 'rgba(224,112,112,0.08)', borderBottom: '1px solid rgba(224,112,112,0.15)', color: '#E07070', fontSize: '11px', flexShrink: 0 },
  body: { flex: 1, display: 'flex', minHeight: 0 },
  mainCol: { flex: 1, display: 'flex', flexDirection: 'column' as const, minWidth: 0 },
  tableArea: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', position: 'relative' as const, overflow: 'hidden' },
  tableFelt: { position: 'relative' as const, width: '100%', maxWidth: '960px', height: '580px', background: 'radial-gradient(ellipse at center, #0f2e1e 0%, #071712 55%, #030705 100%)', borderRadius: '50%/30%', border: '5px solid #2a4632', boxShadow: 'inset 0 0 80px rgba(0,0,0,0.75), 0 0 50px rgba(0,0,0,0.6)' },
  potArea: { position: 'absolute' as const, top: '48%', left: '50%', transform: 'translate(-50%,-50%)', textAlign: 'center' as const, zIndex: 2 },
  potLabel: { fontSize: '8px', color: '#555', letterSpacing: '3px', textTransform: 'uppercase' as const, fontWeight: 600 },
  potValue: { fontSize: '28px', fontWeight: 700, color: '#E8DCC8', fontFamily: '"DM Mono",monospace', marginTop: '2px', letterSpacing: '-0.5px' },
  potHint: { fontSize: '10px', color: '#555', marginTop: '8px', fontStyle: 'italic' as const },
  communityArea: { position: 'absolute' as const, top: '26%', left: '50%', transform: 'translate(-50%,-50%)', display: 'flex', gap: '6px', justifyContent: 'center', padding: '8px 0', zIndex: 3 },
  holeArea: { position: 'absolute' as const, bottom: '32%', left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: '8px', zIndex: 4, padding: '6px 14px', background: 'rgba(0,0,0,0.8)', borderRadius: '10px', border: '2px solid rgba(232,220,200,0.3)', boxShadow: '0 6px 16px rgba(0,0,0,0.6)' },
  seatsContainer: { position: 'absolute' as const, top: 0, left: 0, right: 0, bottom: 0 },
  seatWrap: { position: 'absolute' as const, zIndex: 1 },
  seatBetChips: { position: 'absolute' as const, top: '-36px', left: '50%', transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column' as const, alignItems: 'center', animation: 'chipBet 0.4s cubic-bezier(.25,.9,.3,1.2) both' },
  seat: { background: 'linear-gradient(180deg, #15181b 0%, #0c0e10 100%)', border: '1px solid #1f2328', borderRadius: '10px', padding: '8px 10px', minWidth: '120px', textAlign: 'center' as const, position: 'relative' as const, transition: 'all 0.3s ease', boxShadow: '0 2px 8px rgba(0,0,0,0.5)' },
  seatMe: { borderColor: '#7ECFB3', background: 'linear-gradient(180deg, rgba(126,207,179,0.12) 0%, #0c1512 100%)' },
  seatTurn: { borderColor: '#E8C07E', boxShadow: '0 0 20px rgba(232,192,126,0.55), 0 2px 8px rgba(0,0,0,0.5)' },
  seatFolded: { opacity: 0.45, filter: 'grayscale(1)' },
  seatBadges: { position: 'absolute' as const, top: '-10px', left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: '3px' },
  badgeDealer: { fontSize: '8px', padding: '2px 5px', background: '#E8C07E', color: '#0a0a0a', borderRadius: '3px', fontWeight: 700 },
  badgeBlind: { fontSize: '8px', padding: '2px 5px', background: 'rgba(126,207,179,0.25)', color: '#7ECFB3', borderRadius: '3px', fontWeight: 600 },
  seatAvatar: { width: '30px', height: '30px', borderRadius: '50%', background: 'linear-gradient(135deg, #2a3a32, #1a261f)', border: '1px solid #3a4e42', margin: '4px auto', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#7ECFB3' },
  seatName: { fontSize: '9px', color: '#888', marginTop: '2px' },
  seatStack: { fontSize: '13px', fontWeight: 700, color: '#E8DCC8', marginTop: '2px' },
  seatHand: { display: 'flex', gap: '3px', justifyContent: 'center', marginTop: '4px' },
  emptySeat: { width: '80px', height: '80px', borderRadius: '50%', border: '1px dashed #2a2a2a', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#333', fontSize: '10px', fontFamily: 'inherit' },
  foldedLabel: { position: 'absolute' as const, bottom: '-18px', left: '50%', transform: 'translateX(-50%)', background: '#2a2a2a', color: '#888', fontSize: '7px', fontWeight: 700, padding: '2px 6px', borderRadius: '3px', whiteSpace: 'nowrap' as const, textTransform: 'uppercase' as const },
  winLabel: { position: 'absolute' as const, bottom: '-22px', left: '50%', transform: 'translateX(-50%)', background: '#7ECFB3', color: '#0a0a0a', fontSize: '8px', fontWeight: 700, padding: '2px 6px', borderRadius: '3px', whiteSpace: 'nowrap' as const, textTransform: 'uppercase' as const },
  timerBar: { width: '100%', height: '3px', background: '#1C1C1C', borderRadius: '2px', overflow: 'hidden' },
  timerFill: { height: '100%', transition: 'width 0.25s linear, background 0.5s ease' },
  card: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: '24px', height: '32px', padding: '0 4px', background: '#fff', borderRadius: '3px', fontSize: '12px', fontWeight: 700, fontFamily: '"DM Mono",monospace' },
  cardSm: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: '20px', height: '28px', padding: '0 3px', background: '#fff', borderRadius: '3px', fontSize: '10px', fontWeight: 700, fontFamily: '"DM Mono",monospace' },
  cardLg: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: '52px', height: '70px', padding: '0 8px', background: 'linear-gradient(180deg, #fff 0%, #f0ebe0 100%)', borderRadius: '7px', fontSize: '22px', fontWeight: 700, fontFamily: '"DM Mono",monospace', boxShadow: '0 4px 12px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.8)' },
  cardBack: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: '24px', height: '32px', background: 'linear-gradient(135deg,#1a2e22,#0d1f17)', borderRadius: '3px', border: '1px solid #2a3e32', color: '#444', fontSize: '11px' },
  cardBackSm: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: '20px', height: '28px', background: 'linear-gradient(135deg,#1a2e22,#0d1f17)', borderRadius: '3px', border: '1px solid #2a3e32', color: '#2a3e32', fontSize: '9px' },
  cardBackLg: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: '52px', height: '70px', background: 'linear-gradient(135deg,#1a2e22,#0d1f17)', borderRadius: '7px', border: '1px solid #2a3e32', color: '#444', fontSize: '14px' },
  actionBar: { padding: '12px 24px', background: '#0F0F0F', borderTop: '1px solid #1C1C1C', flexShrink: 0 },
  actionRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' as const },
  btnPrimary: { background: '#7ECFB3', color: '#0a0a0a', border: 'none', padding: '8px 16px', borderRadius: '4px', fontSize: '12px', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  btnAction: { background: 'rgba(126,207,179,0.1)', border: '1px solid rgba(126,207,179,0.3)', color: '#7ECFB3', padding: '8px 14px', borderRadius: '4px', fontSize: '11px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  btnFold: { background: 'rgba(224,112,112,0.1)', border: '1px solid rgba(224,112,112,0.3)', color: '#E07070', padding: '8px 14px', borderRadius: '4px', fontSize: '11px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  btnRaise: { background: 'rgba(232,192,126,0.1)', border: '1px solid rgba(232,192,126,0.3)', color: '#E8C07E', padding: '8px 14px', borderRadius: '4px', fontSize: '11px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  btnAllIn: { background: 'rgba(232,192,126,0.2)', border: '1px solid rgba(232,192,126,0.5)', color: '#E8C07E', padding: '8px 14px', borderRadius: '4px', fontSize: '11px', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  btnLeave: { background: 'rgba(224,112,112,0.1)', border: '1px solid rgba(224,112,112,0.3)', color: '#E07070', padding: '8px 14px', borderRadius: '4px', fontSize: '11px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  btnHelper: { background: 'transparent', border: '1px solid #2A2A2A', color: '#888', padding: '4px 8px', borderRadius: '3px', fontSize: '9px', cursor: 'pointer', fontFamily: 'inherit' },
  betInput: { background: '#0a0a0a', border: '1px solid #2A2A2A', color: '#E8DCC8', padding: '8px 12px', borderRadius: '4px', fontSize: '11px', width: '100px', fontFamily: 'inherit' },
  logPanel: { width: '280px', display: 'flex', flexDirection: 'column' as const, background: '#0F0F0F', borderLeft: '1px solid #1C1C1C', overflow: 'hidden', flexShrink: 0 },
  logTitle: { padding: '12px 16px', fontSize: '10px', color: '#555', letterSpacing: '2px', fontWeight: 600, textTransform: 'uppercase' as const, borderBottom: '1px solid #1C1C1C' },
  logBody: { flex: 1, overflowY: 'auto' as const, padding: '8px 16px' },
  logLine: { fontSize: '10px', color: '#888', marginBottom: '4px', fontFamily: '"DM Mono",monospace' },
  logFooter: { padding: '12px 16px', fontSize: '9px', color: '#444', borderTop: '1px solid #1C1C1C', lineHeight: 1.6 },
  footer: { padding: '8px 24px', background: '#0a0a0a', borderTop: '1px solid #1C1C1C', display: 'flex', justifyContent: 'space-between', fontSize: '9px', color: '#444', flexShrink: 0 },
  overlay: { position: 'fixed' as const, inset: 0, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 },
  modal: { background: '#0F0F0F', border: '1px solid #1C1C1C', borderRadius: '8px', padding: '20px', maxWidth: '380px', width: '90%' },
  modalTitle: { fontSize: '15px', fontWeight: 700, color: '#E8DCC8', margin: 0 },
}

