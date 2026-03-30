/**
 * config/network.ts — Shared network constants
 * Update RPC_URL when ngrok restarts.
 */
export const RPC_URL =
  import.meta.env.VITE_RPC_URL ??
  'https://exothermally-multiplated-dannie.ngrok-free.dev'

/** INIT reserved for gas in session wallet (~500 txs) */
export const SESSION_GAS_RESERVE = '0.1'
