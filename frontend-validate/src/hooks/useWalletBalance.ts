/**
 * hooks/useWalletBalance.ts — Reads wallet + game balances (all in INIT)
 *
 * walletBalance: Native INIT on Minitia L2 (from wagmi useBalance)
 * gameBalance:   INIT deposited in PokerGame contract (from getBalance)
 * tableStake:    INIT committed at a specific table (from getPlayerState)
 *
 * Polymarket-style flow:
 *   External wallet → deposit() → gameBalance → joinTable() → tableStake
 *   tableStake → leaveTable() → gameBalance → withdraw() → external wallet
 */

import { useAccount, useBalance, useReadContract } from 'wagmi'
import { formatEther } from 'viem'
import { POKER_GAME_ADDRESS, POKER_GAME_ABI } from '../config/contract'

export interface WalletBalances {
  /** Formatted native L2 INIT balance, e.g. "123.45" */
  walletBalance: string
  /** Raw native L2 balance in wei */
  walletBalanceRaw: bigint
  /** Formatted contract INIT balance, e.g. "10.00" */
  gameBalance: string
  /** Raw contract INIT balance in wei */
  gameBalanceRaw: bigint
  /** Formatted INIT at table, e.g. "5.00" */
  tableStake: string
  /** Raw INIT at table in wei */
  tableStakeRaw: bigint
  /** Whether any balance query is still loading */
  isLoading: boolean
  /** Refetch all balances */
  refetch: () => void
}

export function useWalletBalance(tableId?: bigint): WalletBalances {
  const { address, isConnected } = useAccount()
  const hasContract = POKER_GAME_ADDRESS !== '0x0000000000000000000000000000000000000000'

  // ── Native L2 wallet balance ──
  const {
    data: nativeBalance,
    isLoading: nativeLoading,
    refetch: refetchNative,
  } = useBalance({
    address,
    query: { enabled: isConnected && !!address },
  })

  // ── Internal contract INIT balance ──
  const {
    data: contractBalance,
    isLoading: contractLoading,
    refetch: refetchContract,
  } = useReadContract({
    address: POKER_GAME_ADDRESS,
    abi: POKER_GAME_ABI,
    functionName: 'getBalance',
    args: [address!],
    query: { enabled: hasContract && isConnected && !!address },
  })

  // ── Table-specific INIT stake ──
  const {
    data: playerState,
    isLoading: tableLoading,
    refetch: refetchTable,
  } = useReadContract({
    address: POKER_GAME_ADDRESS,
    abi: POKER_GAME_ABI,
    functionName: 'getPlayerState',
    args: [tableId ?? 0n, address!],
    query: { enabled: hasContract && isConnected && !!address && tableId !== undefined },
  })

  const tableStakeRaw = playerState ? (playerState[0] as bigint) : 0n
  const gameRaw = contractBalance ? (contractBalance as bigint) : 0n
  const walletRaw = nativeBalance?.value ?? 0n

  const fmt = (v: bigint) => v > 0n ? parseFloat(formatEther(v)).toFixed(2) : '0.00'

  const refetch = () => {
    refetchNative()
    refetchContract()
    refetchTable()
  }

  return {
    walletBalance: nativeBalance ? fmt(nativeBalance.value) : '0.00',
    walletBalanceRaw: walletRaw,
    gameBalance: fmt(gameRaw),
    gameBalanceRaw: gameRaw,
    tableStake: fmt(tableStakeRaw),
    tableStakeRaw: tableStakeRaw,
    isLoading: nativeLoading || contractLoading || tableLoading,
    refetch,
  }
}
