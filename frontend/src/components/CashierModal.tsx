'use client'

import { useState, useEffect } from 'react'
import { parseEther } from 'viem'
import { useWriteContract } from 'wagmi'
import { POKER_GAME_ADDRESS, POKER_GAME_ABI } from '../config/contract'

export interface CashierProps {
  isOpen: boolean
  onClose: () => void
  walletBalance: string
  gameBalance: string
  isLoading?: boolean
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
      setFeedback({ type: 'info', msg: 'Confirming deposit...' })
      const hash = await writeContractAsync({
        address: POKER_GAME_ADDRESS,
        abi: POKER_GAME_ABI,
        functionName: 'deposit',
        value: parseEther(amount),
        gas: 500000n,
        gasPrice: 1000000000n,
      })
      setFeedback({ type: 'ok', msg: `Deposited ${amount} INIT!` })
      setAmount('')
      setTimeout(() => onRefreshBalances?.(), 2000)
    } catch (err: any) {
      console.error('Deposit error:', err)
      setFeedback({ type: 'err', msg: err.shortMessage ?? err.message })
    }
  }

  const handleWithdraw = async () => {
    const val = parseFloat(amount)
    if (!val || val <= 0) return setFeedback({ type: 'err', msg: 'Enter a valid amount' })
    try {
      setFeedback({ type: 'info', msg: 'Confirming withdrawal...' })
      const hash = await writeContractAsync({
        address: POKER_GAME_ADDRESS,
        abi: POKER_GAME_ABI,
        functionName: 'withdraw',
        args: [parseEther(amount)],
        gas: 500000n,
        gasPrice: 1000000000n,
      })
      setFeedback({ type: 'ok', msg: `Withdrew ${amount} INIT!` })
      setAmount('')
      setTimeout(() => onRefreshBalances?.(), 2000)
    } catch (err: any) {
      console.error('Withdraw error:', err)
      setFeedback({ type: 'err', msg: err.shortMessage ?? err.message })
    }
  }

  if (!isOpen) return null

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.modal} onClick={e => e.stopPropagation()}>
        <div style={s.header}>
          <h3 style={s.title}>Cashier</h3>
          <button onClick={onClose} style={s.closeBtn}>{'\u2715'}</button>
        </div>
        <div style={s.flow}>
          <div style={s.flowBox}>
            <span style={s.flowLabel}>Wallet</span>
            <span style={s.flowVal}>{isLoading ? '...' : walletBalance}</span>
            <span style={s.flowUnit}>INIT</span>
          </div>
          <div style={s.flowArrow}>{tab === 'deposit' ? '\u2192' : '\u2190'}</div>
          <div style={{...s.flowBox, ...s.flowBoxActive}}>
            <span style={s.flowLabel}>Room</span>
            <span style={{...s.flowVal, color: '#7ECFB3'}}>{isLoading ? '...' : gameBalance}</span>
            <span style={s.flowUnit}>INIT</span>
          </div>
          <div style={s.flowArrow}>{'\u2192'}</div>
          <div style={s.flowBox}>
            <span style={s.flowLabel}>Tables</span>
            <span style={{...s.flowVal, fontSize: '10px', color: '#333'}}>Join to play</span>
          </div>
        </div>
        <div style={s.tabs}>
          <button onClick={() => setTab('deposit')} style={tab === 'deposit' ? s.tabActive : s.tabInactive}>Deposit</button>
          <button onClick={() => setTab('withdraw')} style={tab === 'withdraw' ? s.tabActive : s.tabInactive}>Withdraw</button>
        </div>
        <div style={s.inputRow}>
          <input type="number" placeholder={tab === 'deposit' ? 'Amount to deposit...' : 'Amount to withdraw...'} value={amount} onChange={e => setAmount(e.target.value)} style={s.input} min="0" step="0.01" />
          <span style={s.unit}>INIT</span>
        </div>
        <div style={s.quickAmounts}>
          {['1', '5', '10', '50'].map(a => (
            <button key={a} onClick={() => setAmount(a)} style={s.quickBtn}>{a}</button>
          ))}
          <button onClick={() => setAmount(tab === 'deposit' ? walletBalance : gameBalance)} style={s.quickBtn}>MAX</button>
        </div>
        <button onClick={tab === 'deposit' ? handleDeposit : handleWithdraw} disabled={isPending} style={tab === 'deposit' ? s.depositBtn : s.withdrawBtn}>
          {isPending ? 'Processing...' : tab === 'deposit' ? `Deposit ${amount || '0'} INIT` : `Withdraw ${amount || '0'} INIT`}
        </button>
        {feedback && (
          <div style={feedback.type === 'ok' ? s.feedbackOk : feedback.type === 'err' ? s.feedbackErr : s.feedbackInfo}>{feedback.msg}</div>
        )}
        <button onClick={onRefreshBalances} style={s.refreshBtn}>{'\u21BB'} Refresh Balances</button>
        <p style={s.note}>{tab === 'deposit' ? 'Transfers INIT from your wallet into your room balance.' : 'Returns INIT from your room balance back to your wallet.'}</p>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, backdropFilter: 'blur(4px)' },
  modal: { background: '#0A0A0A', border: '1px solid #1C1C1C', borderRadius: '12px', padding: '22px', width: '420px', maxWidth: '92vw', fontFamily: '"DM Sans", sans-serif' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '18px' },
  title: { margin: 0, fontSize: '16px', fontWeight: 600, color: '#fff' },
  closeBtn: { background: 'none', border: 'none', color: '#444', fontSize: '18px', cursor: 'pointer', padding: '4px 8px' },
  flow: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '18px' },
  flowBox: { flex: 1, background: '#0F0F0F', borderRadius: '6px', padding: '10px 8px', display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: '2px', border: '1px solid #161616' },
  flowBoxActive: { border: '1px solid rgba(126,207,179,0.2)', background: 'rgba(126,207,179,0.02)' },
  flowLabel: { fontSize: '8px', color: '#444', textTransform: 'uppercase' as const, letterSpacing: '0.5px', fontWeight: 600 },
  flowVal: { fontSize: '14px', fontWeight: 700, color: '#fff', fontFamily: '"DM Mono",monospace' },
  flowUnit: { fontSize: '9px', color: '#333', fontWeight: 600 },
  flowArrow: { color: '#2a2a2a', fontSize: '14px', flexShrink: 0 },
  tabs: { display: 'flex', gap: '4px', marginBottom: '16px' },
  tabActive: { flex: 1, padding: '10px', fontSize: '12px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', border: 'none', borderRadius: '6px', background: '#161616', color: '#fff' },
  tabInactive: { flex: 1, padding: '10px', fontSize: '12px', fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', border: 'none', borderRadius: '6px', background: 'transparent', color: '#3a3a3a' },
  inputRow: { display: 'flex', alignItems: 'center', gap: '8px', background: '#0F0F0F', borderRadius: '8px', padding: '4px 12px 4px 4px', border: '1px solid #1C1C1C', marginBottom: '12px' },
  input: { flex: 1, background: 'none', border: 'none', color: '#fff', fontSize: '16px', fontFamily: '"DM Mono",monospace', padding: '10px', outline: 'none' },
  unit: { color: '#444', fontSize: '12px', fontWeight: 600 },
  quickAmounts: { display: 'flex', gap: '6px', marginBottom: '16px' },
  quickBtn: { flex: 1, padding: '6px', fontSize: '11px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', background: '#0F0F0F', border: '1px solid #1C1C1C', borderRadius: '4px', color: '#666' },
  depositBtn: { width: '100%', padding: '14px', fontSize: '14px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', border: 'none', borderRadius: '8px', background: '#7ECFB3', color: '#000', marginBottom: '12px' },
  withdrawBtn: { width: '100%', padding: '14px', fontSize: '14px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', border: 'none', borderRadius: '8px', background: '#E8DCC8', color: '#000', marginBottom: '12px' },
  feedbackOk: { padding: '10px 14px', background: 'rgba(126,207,179,0.06)', border: '1px solid rgba(126,207,179,0.15)', borderRadius: '6px', fontSize: '11px', color: '#7ECFB3', marginBottom: '12px' },
  feedbackErr: { padding: '10px 14px', background: 'rgba(224,112,112,0.06)', border: '1px solid rgba(224,112,112,0.15)', borderRadius: '6px', fontSize: '11px', color: '#E07070', marginBottom: '12px' },
  feedbackInfo: { padding: '10px 14px', background: 'rgba(126,174,207,0.06)', border: '1px solid rgba(126,174,207,0.15)', borderRadius: '6px', fontSize: '11px', color: '#7EAECF', marginBottom: '12px' },
  refreshBtn: { width: '100%', padding: '8px', fontSize: '11px', fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', background: '#0F0F0F', border: '1px solid #1C1C1C', borderRadius: '6px', color: '#555', marginBottom: '12px' },
  note: { fontSize: '10px', color: '#2a2a2a', lineHeight: 1.5, margin: 0 },
}
