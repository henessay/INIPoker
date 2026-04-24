// useGameState — WebSocket hook for INIPoker sync-server.
//
// Subscribes to a tableId on the sync-server and returns the current on-chain
// state of that table (session, players, community) as a typed, always-fresh
// object. All connected clients see the same state at the same time because
// the server polls geth once per second and broadcasts to every subscriber.
//
// This replaces wagmi's useReadContract + refetchInterval polling for table
// state. wagmi is still used for transactions and balance queries.
//
// Protocol:
//   Client → Server: { type: "subscribe",   tableId: N }
//   Client → Server: { type: "unsubscribe", tableId: N }
//   Client → Server: { type: "ping" }
//   Server → Client: { type: "state", tableId: "N", data: { session, players, community } }
//   Server → Client: { type: "pong", t: <ms> }

import { useEffect, useRef, useState } from 'react'

// ─── Config ────────────────────────────────────────────────────────────
const WSS_URL = 'wss://inipoker.duckdns.org/ws'
const RECONNECT_INITIAL_MS = 500
const RECONNECT_MAX_MS = 10_000
const PING_INTERVAL_MS = 20_000

// ─── Types ─────────────────────────────────────────────────────────────
// These mirror the SessionView / PlayerView in sync-server/server.js.
// Numeric primitives arrive as strings from the wire (to preserve uint256)
// and are converted to bigint on read.
export interface SessionView {
  tableId: bigint
  handId: number
  maxPlayers: number
  minBuyIn: bigint
  maxBuyIn: bigint
  status: number
  dealerIndex: number
  activePlayerIndex: number
  playerCount: number
  pot: bigint
  currentBet: bigint
  smallBlind: bigint
  bigBlind: bigint
  vrfPending: boolean
  vrfRequestBlock: bigint
  deckSeed: `0x${string}`
  deckCommitment: `0x${string}`
  deckCursor: number
  communityCount: number
  saltsCommitted: number
  saltsRevealed: number
  lastActionBlock: bigint
  actionTimeout: bigint
}

export interface PlayerView {
  addr: `0x${string}`
  chips: bigint
  currentBet: bigint
  lastAction: number
  isActive: boolean
  seatIndex: number
  holeCommitment: `0x${string}`
  hasRevealed: boolean
  handRank: number
}

export interface GameState {
  session: SessionView | null
  players: PlayerView[]
  community: number[]
}

export interface UseGameStateResult {
  state: GameState | null
  connected: boolean
  lastUpdateAt: number
  // How many times the WS has reconnected — useful for debug overlay.
  reconnectCount: number
}

// ─── Wire-format decoders ──────────────────────────────────────────────
function parseSession(raw: any): SessionView | null {
  if (!raw) return null
  const b = (v: any) => BigInt(v ?? 0)
  return {
    tableId: b(raw.tableId),
    handId: Number(raw.handId ?? 0),
    maxPlayers: Number(raw.maxPlayers ?? 0),
    minBuyIn: b(raw.minBuyIn),
    maxBuyIn: b(raw.maxBuyIn),
    status: Number(raw.status ?? 0),
    dealerIndex: Number(raw.dealerIndex ?? 0),
    activePlayerIndex: Number(raw.activePlayerIndex ?? 0),
    playerCount: Number(raw.playerCount ?? 0),
    pot: b(raw.pot),
    currentBet: b(raw.currentBet),
    smallBlind: b(raw.smallBlind),
    bigBlind: b(raw.bigBlind),
    vrfPending: Boolean(raw.vrfPending),
    vrfRequestBlock: b(raw.vrfRequestBlock),
    deckSeed: (raw.deckSeed ?? '0x0') as `0x${string}`,
    deckCommitment: (raw.deckCommitment ?? '0x0') as `0x${string}`,
    deckCursor: Number(raw.deckCursor ?? 0),
    communityCount: Number(raw.communityCount ?? 0),
    saltsCommitted: Number(raw.saltsCommitted ?? 0),
    saltsRevealed: Number(raw.saltsRevealed ?? 0),
    lastActionBlock: b(raw.lastActionBlock),
    actionTimeout: b(raw.actionTimeout),
  }
}

function parsePlayer(raw: any): PlayerView {
  const b = (v: any) => BigInt(v ?? 0)
  return {
    addr: (raw.addr ?? '0x0') as `0x${string}`,
    chips: b(raw.chips),
    currentBet: b(raw.currentBet),
    lastAction: Number(raw.lastAction ?? 0),
    isActive: Boolean(raw.isActive),
    seatIndex: Number(raw.seatIndex ?? 0),
    holeCommitment: (raw.holeCommitment ?? '0x0') as `0x${string}`,
    hasRevealed: Boolean(raw.hasRevealed),
    handRank: Number(raw.handRank ?? 0),
  }
}

// ─── The hook ──────────────────────────────────────────────────────────
export function useGameState(tableId: bigint | number | null): UseGameStateResult {
  const [state, setState] = useState<GameState | null>(null)
  const [connected, setConnected] = useState(false)
  const [lastUpdateAt, setLastUpdateAt] = useState(0)
  const [reconnectCount, setReconnectCount] = useState(0)

  // Stable refs — we don't want React to retrigger the whole connect lifecycle
  // on every render. Only reconnect when tableId actually changes.
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const closedByUserRef = useRef(false)
  const backoffRef = useRef(RECONNECT_INITIAL_MS)

  useEffect(() => {
    if (tableId === null || tableId === undefined) return
    const tidStr = String(tableId)
    closedByUserRef.current = false

    const connect = () => {
      if (closedByUserRef.current) return
      // Belt-and-suspenders: if a previous socket is still around, drop it.
      if (wsRef.current && wsRef.current.readyState < 2) {
        try { wsRef.current.close() } catch {}
      }

      console.log('[useGameState] connecting to', WSS_URL, 'tableId=', tidStr)
      let ws: WebSocket
      try {
        ws = new WebSocket(WSS_URL)
      } catch (e) {
        console.warn('[useGameState] WebSocket constructor threw:', e)
        scheduleReconnect()
        return
      }
      wsRef.current = ws

      ws.onopen = () => {
        console.log('[useGameState] connected, subscribing table=', tidStr)
        setConnected(true)
        backoffRef.current = RECONNECT_INITIAL_MS // reset backoff on success
        try {
          ws.send(JSON.stringify({ type: 'subscribe', tableId: Number(tidStr) }))
        } catch (e) {
          console.warn('[useGameState] subscribe send failed:', e)
        }
        // Start keepalive pings so proxies don't idle-close the connection.
        if (pingTimerRef.current) clearInterval(pingTimerRef.current)
        pingTimerRef.current = setInterval(() => {
          if (ws.readyState === 1) {
            try { ws.send(JSON.stringify({ type: 'ping' })) } catch {}
          }
        }, PING_INTERVAL_MS)
      }

      ws.onmessage = (ev) => {
        let msg: any
        try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') }
        catch { return }
        if (!msg) return
        if (msg.type === 'state' && String(msg.tableId) === tidStr) {
          const session = parseSession(msg.data?.session)
          const players = Array.isArray(msg.data?.players) ? msg.data.players.map(parsePlayer) : []
          const community = Array.isArray(msg.data?.community) ? msg.data.community.map((x: any) => Number(x)) : [0, 0, 0, 0, 0]
          setState({ session, players, community })
          setLastUpdateAt(Date.now())
        }
        // pong messages are ignored — just keep the socket warm.
      }

      ws.onerror = (ev) => {
        console.warn('[useGameState] socket error', ev)
      }

      ws.onclose = (ev) => {
        console.log('[useGameState] close', ev.code, ev.reason)
        setConnected(false)
        if (pingTimerRef.current) { clearInterval(pingTimerRef.current); pingTimerRef.current = null }
        if (!closedByUserRef.current) scheduleReconnect()
      }
    }

    const scheduleReconnect = () => {
      if (closedByUserRef.current) return
      const delay = backoffRef.current
      backoffRef.current = Math.min(backoffRef.current * 2, RECONNECT_MAX_MS)
      console.log('[useGameState] reconnecting in', delay, 'ms')
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = setTimeout(() => {
        setReconnectCount((c) => c + 1)
        connect()
      }, delay)
    }

    connect()

    return () => {
      closedByUserRef.current = true
      if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null }
      if (pingTimerRef.current) { clearInterval(pingTimerRef.current); pingTimerRef.current = null }
      if (wsRef.current) {
        try {
          if (wsRef.current.readyState === 1) {
            wsRef.current.send(JSON.stringify({ type: 'unsubscribe', tableId: Number(tidStr) }))
          }
          wsRef.current.close()
        } catch {}
        wsRef.current = null
      }
    }
  }, [tableId])

  return { state, connected, lastUpdateAt, reconnectCount }
}
