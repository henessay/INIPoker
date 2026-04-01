/**
 * config/network.ts — Shared network constants
 */
export const RPC_URL =
  import.meta.env.VITE_RPC_URL ??
  '/api/rpc'

/** INIT reserved for gas in session wallet (~500 txs) */
export const SESSION_GAS_RESERVE = '0.1'
