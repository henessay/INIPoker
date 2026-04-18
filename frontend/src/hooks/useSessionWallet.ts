/**
 * hooks/useSessionWallet.ts — Ephemeral wallet for popup-free poker
 * + Client-side hole card reconstruction via Fisher-Yates
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import {
  createWalletClient, createPublicClient, http,
  formatEther, keccak256, toHex, encodePacked,
  type WalletClient, type PublicClient, type Chain,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { POKER_GAME_ADDRESS, POKER_GAME_ABI } from '../config/contract'
import { RPC_URL } from '../config/network'

const SK_PRIV = 'inipoker_session_key'
const SK_MAIN = 'inipoker_main_wallet'

function generateKey(): `0x${string}` {
  const b = crypto.getRandomValues(new Uint8Array(32))
  return ('0x' + Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('')) as `0x${string}`
}

// ══════════════════════════════════════════════════════════
//  FISHER-YATES — exact replica of Solidity _fisherYatesMemory
// ══════════════════════════════════════════════════════════

export function fisherYatesShuffle(deckSeed: `0x${string}`): number[] {
  // Init deck: suit << 4 | value (same as Solidity)
  const deck: number[] = []
  for (let suit = 0; suit < 4; suit++) {
    for (let value = 1; value <= 13; value++) {
      deck.push((suit << 4) | value)
    }
  }
  // Shuffle: identical to Solidity
  let h: `0x${string}` = deckSeed
  for (let i = 1; i < 52; i++) {
    h = keccak256(encodePacked(['bytes32', 'uint8'], [h, i]))
    const j = Number(BigInt(h) % BigInt(i + 1))
    if (i !== j) {
      const tmp = deck[i]; deck[i] = deck[j]; deck[j] = tmp
    }
  }
  return deck
}

export function getHoleCardsFromDeck(
  deck: number[], dealerIndex: number, mySeatIndex: number, playerCount: number
): [number, number] {
  let cursor = 0
  const card0s: number[] = new Array(playerCount).fill(0)
  const card1s: number[] = new Array(playerCount).fill(0)
  // Round 1: first card to each player (starting left of dealer)
  for (let i = 0; i < playerCount; i++) {
    const seatIdx = (dealerIndex + 1 + i) % playerCount
    card0s[seatIdx] = deck[cursor++]
  }
  // Round 2: second card
  for (let i = 0; i < playerCount; i++) {
    const seatIdx = (dealerIndex + 1 + i) % playerCount
    card1s[seatIdx] = deck[cursor++]
  }
  return [card0s[mySeatIndex], card1s[mySeatIndex]]
}

// ══════════════════════════════════════════════════════════

export interface SessionState {
  active: boolean
  address: string | null
  processing: boolean
  status: string
  error: string | null
}

export function useSessionWallet() {
  const [state, setState] = useState<SessionState>({
    active: false, address: null, processing: false, status: '', error: null,
  })
  const wcRef = useRef<WalletClient | null>(null)
  const pcRef = useRef<PublicClient | null>(null)
  const mainRef = useRef<string | null>(null)

  const up = (p: Partial<SessionState>) => setState(s => ({ ...s, ...p }))

  const initClients = useCallback(async (privKey: `0x${string}`) => {
    const account = privateKeyToAccount(privKey)
    const tmp = createPublicClient({ transport: http(RPC_URL) })
    let chainId = 2649570508581093
    try { chainId = await tmp.getChainId() } catch {}
    const chain: Chain = {
      id: chainId, name: 'INIPoker L2',
      nativeCurrency: { name: 'INIT', symbol: 'INIT', decimals: 18 },
      rpcUrls: { default: { http: [RPC_URL] } },
    } as const
    wcRef.current = createWalletClient({ account, chain, transport: http(RPC_URL) })
    pcRef.current = createPublicClient({ chain, transport: http(RPC_URL) })
    return account
  }, [])

  // Restore session on page load
  useEffect(() => {
    const key = sessionStorage.getItem(SK_PRIV) as `0x${string}` | null
    const main = sessionStorage.getItem(SK_MAIN)
    if (key && main) {
      initClients(key).then(acc => {
        mainRef.current = main
        up({ address: acc.address, active: true, status: 'Session restored' })
      }).catch(() => {
        sessionStorage.removeItem(SK_PRIV)
        sessionStorage.removeItem(SK_MAIN)
      })
    }
  }, [initClients])

  const createSession = useCallback(async (mainWallet: string): Promise<string> => {
    mainRef.current = mainWallet
    sessionStorage.setItem(SK_MAIN, mainWallet)
    let key = sessionStorage.getItem(SK_PRIV) as `0x${string}` | null
    if (!key) { key = generateKey(); sessionStorage.setItem(SK_PRIV, key) }
    const acc = await initClients(key)
    up({ address: acc.address })
    return acc.address
  }, [initClients])

  const sWrite = useCallback(async (fn: string, args: unknown[], value?: bigint): Promise<string> => {
    console.log("[SESSION] sWrite called:", fn, args, value?.toString())
    const wc = wcRef.current; const pc = pcRef.current
    if (!wc || !pc) throw new Error('Session not initialized')
    const hash = await wc.writeContract({
      address: POKER_GAME_ADDRESS, abi: POKER_GAME_ABI,
      functionName: fn, args,
      gas: 500_000n, gasPrice: 1_000_000_000n,
      ...(value ? { value } : {}),
    } as any)
    await pc.waitForTransactionReceipt({ hash, timeout: 30_000 })
    return hash
  }, [])

  const depositAndJoin = useCallback(async (tableId: bigint, buyInWei: bigint): Promise<boolean> => {
    up({ processing: true, error: null })
    try {
      console.log("[SESSION] depositAndJoin start, tableId:", tableId.toString(), "buyIn:", buyInWei.toString())
      console.log("[SESSION] session address:", wcRef.current?.account?.address)
      console.log("[SESSION] RPC_URL:", RPC_URL)
      await new Promise(r => setTimeout(r, 2500))
      up({ status: 'Depositing INIT into game contract...' })
      await sWrite('deposit', [], buyInWei)
      up({ status: 'Joining table...' })
      await sWrite('joinTable', [tableId, buyInWei])
      up({ active: true, processing: false, status: 'Seated! All actions are popup-free.' })
      return true
    } catch (err: any) {
      up({ processing: false, error: err.shortMessage ?? err.message })
      return false
    }
  }, [sWrite])

  // ── Game actions (all popup-free) ──
  const gAction = useCallback(async (fn: string, tableId: bigint, extra: unknown[] = []) => {
    up({ error: null })
    try { return await sWrite(fn, [tableId, ...extra]) }
    catch (err: any) { up({ error: err.shortMessage ?? err.message }); return null }
  }, [sWrite])

  const fold           = useCallback((t: bigint) => gAction('playerAction', t, [1, 0n]), [gAction])
  const check          = useCallback((t: bigint) => gAction('playerAction', t, [2, 0n]), [gAction])
  const callAction     = useCallback((t: bigint) => gAction('playerAction', t, [4, 0n]), [gAction])
  const bet            = useCallback((t: bigint, a: bigint) => gAction('playerAction', t, [3, a]), [gAction])
  const raise          = useCallback((t: bigint, a: bigint) => gAction('playerAction', t, [5, a]), [gAction])
  const allIn          = useCallback((t: bigint) => gAction('playerAction', t, [6, 0n]), [gAction])
  const requestDeal    = useCallback((t: bigint) => gAction('requestDeal', t), [gAction])
  const evaluateShowdown = useCallback((t: bigint) => gAction('evaluateShowdown', t), [gAction])

  const commitSalt = useCallback(async (tableId: bigint) => {
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    const hex = toHex(bytes)
    const hash = keccak256(hex as `0x${string}`)
    sessionStorage.setItem(`inipoker_salt_${tableId}`, hex)
    return gAction('commitSalt', tableId, [hash])
  }, [gAction])

  const revealCards = useCallback(async (tableId: bigint) => {
    const salt = sessionStorage.getItem(`inipoker_salt_${tableId}`)
    if (!salt) { up({ error: 'Salt not found' }); return null }
    return gAction('revealHoleCards', tableId, [salt as `0x${string}`])
  }, [gAction])

  // ── Leave + cashout ──
  const leaveAndCashout = useCallback(async (tableId: bigint): Promise<boolean> => {
    const wc = wcRef.current; const pc = pcRef.current
    const mainWallet = mainRef.current; const addr = state.address
    if (!wc || !pc || !mainWallet || !addr) { up({ error: 'Session not initialized' }); return false }
    up({ processing: true, error: null })
    try {
      up({ status: 'Leaving table...' })
      try { await sWrite('leaveTable', [tableId]) }
      catch (err: any) {
        const m = (err.shortMessage ?? err.message ?? '').toLowerCase()
        if (!m.includes('not seated') && !m.includes('not active') && !m.includes('not playing')) throw err
      }
      await new Promise(r => setTimeout(r, 1500))
      let gameBal = 0n
      try {
        gameBal = await pc.readContract({ address: POKER_GAME_ADDRESS, abi: POKER_GAME_ABI,
          functionName: 'getBalance', args: [addr as `0x${string}`] }) as bigint
      } catch {}
      if (gameBal > 0n) {
        up({ status: `Withdrawing ${parseFloat(formatEther(gameBal)).toFixed(2)} INIT...` })
        await sWrite('withdraw', [gameBal])
        await new Promise(r => setTimeout(r, 1500))
      }
      up({ status: 'Returning funds to your wallet...' })
      const nativeBal = await pc.getBalance({ address: addr as `0x${string}` })
      const gasCost = 21_000n * 2_000_000_000n
      const sendBack = nativeBal > gasCost ? nativeBal - gasCost : 0n
      if (sendBack > 0n) {
        const h = await wc.sendTransaction({ account: wc.account!, chain: wc.chain, to: mainWallet as `0x${string}`, value: sendBack, gas: 21_000n, gasPrice: 1_000_000_000n })
        await pc.waitForTransactionReceipt({ hash: h, timeout: 30_000 })
      }
      sessionStorage.removeItem(SK_PRIV); sessionStorage.removeItem(SK_MAIN)
      sessionStorage.removeItem(`inipoker_salt_${tableId}`)
      wcRef.current = null; pcRef.current = null; mainRef.current = null
      const returned = sendBack > 0n ? parseFloat(formatEther(sendBack)).toFixed(4) : '0'
      up({ active: false, address: null, processing: false, status: `Returned ${returned} INIT`, error: null })
      return true
    } catch (err: any) { up({ processing: false, error: err.shortMessage ?? err.message }); return false }
  }, [sWrite, state.address])

  const emergencyRecover = useCallback(async () => {
    const wc = wcRef.current; const pc = pcRef.current
    const mainWallet = mainRef.current; const addr = state.address
    if (!wc || !pc || !mainWallet || !addr) return false
    up({ processing: true, status: 'Emergency recovery...', error: null })
    try {
      try {
        const bal = await pc.readContract({ address: POKER_GAME_ADDRESS, abi: POKER_GAME_ABI,
          functionName: 'getBalance', args: [addr as `0x${string}`] }) as bigint
        if (bal > 0n) { await sWrite('withdraw', [bal]); await new Promise(r => setTimeout(r, 1500)) }
      } catch {}
      const nativeBal = await pc.getBalance({ address: addr as `0x${string}` })
      const gasCost = 21_000n * 2_000_000_000n
      const sendBack = nativeBal > gasCost ? nativeBal - gasCost : 0n
      if (sendBack > 0n) {
        const h = await wc.sendTransaction({ account: wc.account!, chain: wc.chain, to: mainWallet as `0x${string}`, value: sendBack, gas: 21_000n, gasPrice: 1_000_000_000n })
        await pc.waitForTransactionReceipt({ hash: h, timeout: 30_000 })
      }
      sessionStorage.removeItem(SK_PRIV); sessionStorage.removeItem(SK_MAIN)
      wcRef.current = null; pcRef.current = null
      up({ active: false, address: null, processing: false, status: 'Funds recovered' })
      return true
    } catch (err: any) { up({ processing: false, error: err.shortMessage ?? err.message }); return false }
  }, [sWrite, state.address])

  return {
    ...state, createSession, depositAndJoin, leaveAndCashout, emergencyRecover,
    fold, check, callAction, bet, raise, allIn,
    commitSalt, requestDeal, revealCards, evaluateShowdown,
  }
}


