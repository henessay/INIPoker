'use client'

import { useState, useEffect } from 'react'
import { parseEther } from 'viem'
import { useWriteContract } from 'wagmi'
import { POKER_GAME_ADDRESS, POKER_GAME_ABI } from '../config/contract'

export interface CashierProps {
  isOpen: boolean
  onClose: () => void
  /** Native L2 wallet balance (formatted) */
  walletBalance: string
  /** Internal contract balance (formatted) */
  gameBalance: string
  isLoading?: boolean
  /** Refetch all balances after tx */
  onRefreshBalances?: () => void
}

export default function CashierModal({
  isOpen, onClose, walletBalance, gameBalance,
  isLoading = false, onRefreshBalances,
}: CashierProps) {
  const [tab, setTab] = useState<'deposit' | 'withdraw'>('deposit')
  const [amount, setAmount] = useState('')
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err' | 'info'; msg: string } | null>(null)
  const { writeContractAsync, isPending } = useWriteContract()

  useEffect(() => { setFeedback(null); setAmount('') }, [tab, isOpen])

  const handleDeposit = async () => {
    const val = parseFloat(amount)
    if (!val || val <= 0) return setFeedback({ type: 'err', msg: 'Enter a valid amount' })
    try {
      setFeedback({ type: 'info', msg: 'Confirming deposit…' })
      await writeContractAsync({
        address: POKER_GAME_ADDRESS,
        abi: POKER_GAME_ABI,
        functionName: 'deposit',
        value: parseEther(amount),
        gas: 200000n,
        gasPrice: 1000000000n,
      })
      setFeedback({ type: 'ok', msg: `Deposited ${amount} INIT to game balance` })
      setAmount('')
      setTimeout(() => onRefreshBalances?.(), 2000)
    } catch (err: any) {
      setFeedback({ type: 'err', msg: err.shortMessage ?? err.message })
    }
  }

  const handleWithdraw = async () => {
    const val = parseFloat(amount)
    if (!val || val <= 0) return setFeedback({ type: 'err', msg: 'Enter a valid amount' })
    try {
      setFeedback({ type: 'info', msg: 'Confirming withdrawal…' })
      await writeContractAsync({
        address: POKER_GAME_ADDRESS,
        abi: POKER_GAME_ABI,
        functionName: 'withdraw',
        args: [parseEther(amount)],
        gas: 200000n,
        gasPrice: 1000000000n,
      })
      setFeedback({ type: 'ok', msg: `Withdrew ${amount} INIT to wallet` })
      setAmount('')
      setTimeout(() => onRefreshBalances?.(), 2000)
    } catch (err: any) {
      setFeedback({ type: 'err', msg: err.shortMessage ?? err.message })
    }
  }

  if (!isOpen) return null

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.modal} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={s.header}>
          <h3 style={s.title}>Cashier</h3>
          <button onClick={onClose} style={s.closeBtn}>✕</button>
        </div>

        {/* Flow diagram */}
        <div style={s.flow}>
          <div style={s.flowBox}>
            <span style={s.flowLabel}>Wallet</span>
            <span style={s.flowVal}>{isLoading ? '…' : walletBalance}</span>
            <span style={s.flowUnit}>INIT</span>
          </div>
          <div style={s.flowArrow}>{tab === 'deposit' ? '→' : '←'}</div>
          <div style={{...s.flowBox, ...s.flowBoxActive}}>
            <span style={s.flowLabel}>Game Balance</span>
            <span style={{...s.flowVal, color: '#4ade80'}}>{isLoading ? '…' : gameBalance}</span>
            <span style={s.flowUnit}>INIT</span>
          </div>
          <div style={s.flowArrow}>→</div>
          <div style={s.flowBox}>
            <span style={s.flowLabel}>Tables</span>
            <span style={{...s.flowVal, fontSize: '10px', color: '#888'}}>Join to play</span>
          </div>
        </div>

        {/* Tabs */}
        <div style={s.tabs}>
          <button onClick={() => setTab('deposit')} style={tab === 'deposit' ? s.tabActive : s.tabInactive}>
            Deposit
          </button>
          <button onClick={() => setTab('withdraw')} style={tab === 'withdraw' ? s.tabActive : s.tabInactive}>
            Withdraw
          </button>
        </div>

        {/* Amount input */}
        <div style={s.inputRow}>
          <input
            type="number"
            placeholder={tab === 'deposit' ? 'Amount to deposit…' : 'Amount to withdraw…'}
            value={amount}
            onChange={e => setAmount(e.target.value)}
            style={s.input}
            min="0"
            step="0.01"
          />
          <span style={s.unit}>INIT</span>
        </div>

        {/* Quick amounts */}
        <div style={s.quickAmounts}>
          {['10', '50', '100', '500'].map(a => (
            <button key={a} onClick={() => setAmount(a)} style={s.quickBtn}>{a}</button>
          ))}
          <button
            onClick={() => setAmount(tab === 'deposit' ? walletBalance : gameBalance)}
            style={s.quickBtn}
          >
            MAX
          </button>
        </div>

        {/* Action button */}
        <button
          onClick={tab === 'deposit' ? handleDeposit : handleWithdraw}
          disabled={isPending}
          style={tab === 'deposit' ? s.depositBtn : s.withdrawBtn}
        >
          {isPending
            ? 'Processing…'
            : tab === 'deposit'
              ? `Deposit ${amount || '0'} INIT`
              : `Withdraw ${amount || '0'} INIT`
          }
        </button>

        {/* Feedback */}
        {feedback && (
          <div style={
            feedback.type === 'ok' ? s.feedbackOk :
            feedback.type === 'err' ? s.feedbackErr : s.feedbackInfo
          }>
            {feedback.msg}
          </div>
        )}

        {/* Refresh */}
        <button onClick={onRefreshBalances} style={s.refreshBtn}>
          ↻ Refresh Balances
        </button>

        <p style={s.note}>
          {tab === 'deposit'
            ? 'Transfers INIT from your wallet into the game contract. Join any table from your game balance.'
            : 'Returns INIT from game balance to your wallet. Leave active tables first.'}
        </p>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════
//  STYLES
// ══════════════════════════════════════════════════════════

const s: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
    background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center',
    justifyContent: 'center', zIndex: 1000, backdropFilter: 'blur(4px)',
  },
  modal: {
    background: '#141414', border: '1px solid #2a2a2a', borderRadius: '14px',
    padding: '24px', width: '440px', maxWidth: '92vw',
    fontFamily: '"JetBrains Mono", monospace',
    boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
  },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' },
  title: { margin: 0, fontSize: '18px', fontWeight: 700, color: '#fff' },
  closeBtn: {
    background: 'none', border: 'none', color: '#666', fontSize: '18px',
    cursor: 'pointer', padding: '4px 8px',
  },

  flow: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '20px' },
  flowBox: {
    flex: 1, background: '#0d0d0d', borderRadius: '8px', padding: '10px 8px',
    display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: '2px',
    border: '1px solid #1a1a1a',
  },
  flowBoxActive: { border: '1px solid rgba(74,222,128,0.3)', background: 'rgba(74,222,128,0.04)' },
  flowLabel: { fontSize: '8px', color: '#666', textTransform: 'uppercase' as const, letterSpacing: '0.5px', fontWeight: 700 },
  flowVal: { fontSize: '14px', fontWeight: 700, color: '#fff' },
  flowUnit: { fontSize: '9px', color: '#555', fontWeight: 600 },
  flowArrow: { color: '#444', fontSize: '14px', flexShrink: 0 },

  tabs: { display: 'flex', gap: '4px', marginBottom: '16px' },
  tabActive: {
    flex: 1, padding: '10px', fontSize: '13px', fontWeight: 700, cursor: 'pointer',
    fontFamily: 'inherit', border: 'none', borderRadius: '6px',
    background: '#2a2a2a', color: '#fff',
  },
  tabInactive: {
    flex: 1, padding: '10px', fontSize: '13px', fontWeight: 600, cursor: 'pointer',
    fontFamily: 'inherit', border: 'none', borderRadius: '6px',
    background: 'transparent', color: '#555',
  },

  inputRow: {
    display: 'flex', alignItems: 'center', gap: '8px',
    background: '#0d0d0d', borderRadius: '8px', padding: '4px 12px 4px 4px',
    border: '1px solid #2a2a2a', marginBottom: '12px',
  },
  input: {
    flex: 1, background: 'none', border: 'none', color: '#fff', fontSize: '16px',
    fontFamily: 'inherit', padding: '10px', outline: 'none',
  },
  unit: { color: '#666', fontSize: '12px', fontWeight: 600 },

  quickAmounts: { display: 'flex', gap: '6px', marginBottom: '16px' },
  quickBtn: {
    flex: 1, padding: '6px', fontSize: '11px', fontWeight: 600, cursor: 'pointer',
    fontFamily: 'inherit', background: '#1a1a1a', border: '1px solid #2a2a2a',
    borderRadius: '4px', color: '#aaa',
  },

  depositBtn: {
    width: '100%', padding: '14px', fontSize: '14px', fontWeight: 700,
    cursor: 'pointer', fontFamily: 'inherit', border: 'none', borderRadius: '8px',
    background: 'linear-gradient(135deg, #2ecc71 0%, #27ae60 100%)', color: '#000',
    marginBottom: '12px',
  },
  withdrawBtn: {
    width: '100%', padding: '14px', fontSize: '14px', fontWeight: 700,
    cursor: 'pointer', fontFamily: 'inherit', border: 'none', borderRadius: '8px',
    background: 'linear-gradient(135deg, #e74c3c 0%, #c0392b 100%)', color: '#fff',
    marginBottom: '12px',
  },

  feedbackOk: {
    padding: '10px 14px', background: 'rgba(46,204,113,0.1)',
    border: '1px solid rgba(46,204,113,0.25)', borderRadius: '6px',
    fontSize: '11px', color: '#2ecc71', marginBottom: '12px',
  },
  feedbackErr: {
    padding: '10px 14px', background: 'rgba(231,76,60,0.1)',
    border: '1px solid rgba(231,76,60,0.25)', borderRadius: '6px',
    fontSize: '11px', color: '#e74c3c', marginBottom: '12px',
  },
  feedbackInfo: {
    padding: '10px 14px', background: 'rgba(52,152,219,0.1)',
    border: '1px solid rgba(52,152,219,0.25)', borderRadius: '6px',
    fontSize: '11px', color: '#3498db', marginBottom: '12px',
  },

  refreshBtn: {
    width: '100%', padding: '8px', fontSize: '11px', fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit', background: '#1a1a1a',
    border: '1px solid #2a2a2a', borderRadius: '6px', color: '#888',
    marginBottom: '12px',
  },

  note: { fontSize: '10px', color: '#3a3a3a', lineHeight: 1.5, margin: 0 },
}
