'use client'

import { useState } from 'react'
import { useAccount } from 'wagmi'
import { useInterwovenKit } from '@initia/interwovenkit-react'
import CashierModal from './CashierModal'
import { useWalletBalance } from '../hooks/useWalletBalance'

// ═══════════════════════════════════════════════════════════
//  DATA — All values in INIT
// ═══════════════════════════════════════════════════════════

type GameType = 'holdem' | 'omaha'
interface Table { id: number; name: string; type: GameType; blinds: string; buyIn: string; players: number; max: number; avgPot: string; flop: string; hhr: number; featured?: boolean }
interface Tournament { id: number; name: string; type: GameType; buyIn: number; prize: number; registered: number; minPlayers: number; startingStack: number; blindLevel: string; nextStart: string; vip?: boolean }

const HOLDEM_TABLES: Table[] = [
  { id: 0, name: 'Diamond 01', type: 'holdem', blinds: '25/50', buyIn: '5,000', players: 5, max: 6, avgPot: '420', flop: '48%', hhr: 103, featured: true },
  { id: 1, name: 'Emerald 01', type: 'holdem', blinds: '5/10', buyIn: '1,000', players: 4, max: 6, avgPot: '136', flop: '54%', hhr: 112 },
  { id: 2, name: 'Emerald 02', type: 'holdem', blinds: '5/10', buyIn: '1,000', players: 3, max: 6, avgPot: '98', flop: '50%', hhr: 108 },
  { id: 3, name: 'Ruby 01', type: 'holdem', blinds: '2/4', buyIn: '400', players: 6, max: 6, avgPot: '45', flop: '44%', hhr: 96 },
  { id: 4, name: 'Ruby 02', type: 'holdem', blinds: '2/4', buyIn: '400', players: 4, max: 6, avgPot: '38', flop: '46%', hhr: 99 },
  { id: 5, name: 'Onyx 01', type: 'holdem', blinds: '1/2', buyIn: '200', players: 3, max: 6, avgPot: '21', flop: '49%', hhr: 90 },
  { id: 6, name: 'Onyx 02', type: 'holdem', blinds: '1/2', buyIn: '200', players: 2, max: 6, avgPot: '18', flop: '39%', hhr: 104 },
  { id: 7, name: 'Onyx 03', type: 'holdem', blinds: '1/2', buyIn: '200', players: 0, max: 6, avgPot: '0', flop: '—', hhr: 0 },
]

const OMAHA_TABLES: Table[] = [
  { id: 20, name: 'Omaha Diamond', type: 'omaha', blinds: '25/50', buyIn: '5,000', players: 4, max: 6, avgPot: '580', flop: '62%', hhr: 88, featured: true },
  { id: 21, name: 'Omaha Emerald', type: 'omaha', blinds: '5/10', buyIn: '1,000', players: 3, max: 6, avgPot: '190', flop: '58%', hhr: 95 },
  { id: 22, name: 'Omaha Ruby 01', type: 'omaha', blinds: '2/4', buyIn: '400', players: 5, max: 6, avgPot: '62', flop: '55%', hhr: 92 },
  { id: 23, name: 'Omaha Ruby 02', type: 'omaha', blinds: '2/4', buyIn: '400', players: 2, max: 6, avgPot: '48', flop: '51%', hhr: 90 },
  { id: 24, name: 'Omaha Onyx 01', type: 'omaha', blinds: '1/2', buyIn: '200', players: 4, max: 6, avgPot: '28', flop: '53%', hhr: 86 },
  { id: 25, name: 'Omaha Onyx 02', type: 'omaha', blinds: '1/2', buyIn: '200', players: 0, max: 6, avgPot: '0', flop: '—', hhr: 0 },
]

const VIP_TABLES: Table[] = [
  { id: 30, name: 'VIP Holdem', type: 'holdem', blinds: '500/1,000', buyIn: '100,000', players: 3, max: 6, avgPot: '12,500', flop: '42%', hhr: 72, featured: true },
  { id: 31, name: 'VIP Omaha', type: 'omaha', blinds: '500/1,000', buyIn: '100,000', players: 2, max: 6, avgPot: '18,200', flop: '58%', hhr: 68, featured: true },
]

const TOURNAMENTS: Tournament[] = [
  { id: 100, name: 'Daily Grind', type: 'holdem', buyIn: 1, prize: 25, registered: 18, minPlayers: 8, startingStack: 10000, blindLevel: '10 min', nextStart: '1h 24m' },
  { id: 101, name: 'Mid Stakes Classic', type: 'holdem', buyIn: 10, prize: 250, registered: 12, minPlayers: 8, startingStack: 10000, blindLevel: '10 min', nextStart: '0h 48m' },
  { id: 102, name: 'High Roller', type: 'holdem', buyIn: 100, prize: 2500, registered: 6, minPlayers: 8, startingStack: 10000, blindLevel: '10 min', nextStart: '2h 00m' },
]

const VIP_TOURNAMENT: Tournament = {
  id: 200, name: 'VIP Championship', type: 'holdem', buyIn: 1000, prize: 25000, registered: 5, minPlayers: 8, startingStack: 10000, blindLevel: '10 min', nextStart: '1h 12m', vip: true,
}

const PRIZE_DISTRIBUTION = [
  { place: '1st', pct: 50, color: '#fbbf24' },
  { place: '2nd', pct: 30, color: '#d0d0d0' },
  { place: '3rd', pct: 12, color: '#cd7f32' },
  { place: '4th', pct: 5, color: '#888' },
  { place: '5th', pct: 3, color: '#666' },
]

const BLIND_STRUCTURE = [
  { level: 1, blinds: '50/100', ante: '—', dur: '10 min' },
  { level: 2, blinds: '75/150', ante: '—', dur: '10 min' },
  { level: 3, blinds: '100/200', ante: '25', dur: '10 min' },
  { level: 4, blinds: '150/300', ante: '50', dur: '10 min' },
  { level: 5, blinds: '200/400', ante: '50', dur: '10 min' },
  { level: 6, blinds: '300/600', ante: '75', dur: '10 min' },
  { level: 7, blinds: '500/1,000', ante: '100', dur: '10 min' },
  { level: 8, blinds: '750/1,500', ante: '150', dur: '10 min' },
  { level: 9, blinds: '1,000/2,000', ante: '200', dur: '10 min' },
  { level: 10, blinds: '1,500/3,000', ante: '300', dur: '10 min' },
]

type Tab = 'home' | 'tournament' | 'holdem' | 'omaha' | 'vip'

// ═══════════════════════════════════════════════════════════
//  COMPONENT
// ═══════════════════════════════════════════════════════════

interface LobbyProps { onJoinTable: (tableId: number) => void }

export default function Lobby({ onJoinTable }: LobbyProps) {
  const { address, isConnected } = useAccount()
  const { username, openConnect, openWallet } = useInterwovenKit()
  const { walletBalance, gameBalance, isLoading: balLoading, refetch: refetchBal } = useWalletBalance()
  const [tab, setTab] = useState<Tab>('home')
  const [selectedTable, setSelectedTable] = useState<Table | null>(HOLDEM_TABLES[0])
  const [selectedTournament, setSelectedTournament] = useState<Tournament | null>(null)
  const [cashierOpen, setCashierOpen] = useState(false)

  const truncAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

  const allTables = [...HOLDEM_TABLES, ...OMAHA_TABLES]
  const totalPlayers = [...allTables, ...VIP_TABLES].reduce((a, t) => a + t.players, 0) + TOURNAMENTS.reduce((a, t) => a + t.registered, 0)

  const getTabTables = (): Table[] => {
    if (tab === 'home') return allTables
    if (tab === 'holdem') return HOLDEM_TABLES
    if (tab === 'omaha') return OMAHA_TABLES
    if (tab === 'vip') return VIP_TABLES
    return []
  }

  const getTabTournaments = (): Tournament[] => {
    if (tab === 'home') return TOURNAMENTS
    if (tab === 'tournament') return TOURNAMENTS
    if (tab === 'vip') return [VIP_TOURNAMENT]
    return []
  }

  const computePrize = (t: Tournament) => {
    if (t.registered > t.minPlayers) {
      const extra = (t.registered - t.minPlayers) * t.buyIn
      return t.prize + extra * 0.9
    }
    return t.prize
  }

  const dots = (count: number, max: number) => {
    const d = []
    for (let i = 0; i < max; i++) d.push(<span key={i} style={{ display: 'inline-block', width: '7px', height: '7px', borderRadius: '50%', background: i < count ? '#d0d0d0' : '#2a2a2a', marginRight: '2px' }} />)
    return <span style={{ display: 'inline-flex', alignItems: 'center' }}>{d}</span>
  }

  // ═══ RENDER ═══
  return (
    <div style={s.root}>

      {/* ═══ TOP BAR ═══ */}
      <div style={s.topBar}>
        <div style={s.topLeft}>
          <span style={s.logoB}>INI</span><span style={s.logoL}>Poker</span>
        </div>
        <span style={s.online}>{totalPlayers} Players Online</span>
        <div style={s.topRight}>
          {isConnected && (
            <>
              <span style={s.gameBalLabel}>
                Wallet: <b style={{color:'#fff'}}>{balLoading ? '…' : `${walletBalance} INIT`}</b>
                {' · '}
                Game: <b style={{color:'#4ade80'}}>{balLoading ? '…' : `${gameBalance} INIT`}</b>
              </span>
              <button onClick={() => setCashierOpen(true)} style={s.cashierBtn}>Cashier</button>
            </>
          )}
          {isConnected ? (
            <button onClick={openWallet} style={s.walletBtn}><span style={s.wDot} />{username ?? truncAddr(address!)}</button>
          ) : (
            <><button onClick={openConnect} style={s.loginBtn}>Login</button><button onClick={openConnect} style={s.signupBtn}>Sign-up</button></>
          )}
        </div>
      </div>

      {/* ═══ TAB BAR ═══ */}
      <div style={s.tabBar}>
        {([['home','Home'],['tournament','Tournament'],['holdem',"Hold'em"],['omaha','Omaha'],['vip','VIP Area']] as [Tab,string][]).map(([k,label]) => (
          <button key={k} onClick={() => { setTab(k); setSelectedTournament(null); setSelectedTable(getTabTables()[0] ?? null) }} style={tab === k ? s.tabAct : s.tabBtn}>{label}</button>
        ))}
      </div>

      {/* ═══ MAIN ═══ */}
      <div style={s.main}>

        {/* ── LEFT: Tables + Tournaments ── */}
        <div style={s.left}>

          {/* Tables */}
          {getTabTables().length > 0 && (
            <>
              <div style={s.secHead}><span style={s.secTitle}>{tab === 'vip' ? 'VIP Tables' : 'Cash Games'}</span></div>
              <div style={s.colHdr}>
                <span style={{...s.hc, flex:2}}>Table</span>
                <span style={s.hc}>Blinds</span>
                <span style={s.hc}>Buy-in</span>
                <span style={{...s.hc, flex:1.3}}>Players</span>
                <span style={s.hc}>Avg Pot</span>
                <span style={s.hc}>Flop%</span>
                <span style={s.hc}>H/hr</span>
              </div>
              {getTabTables().map(t => (
                <div key={t.id} onClick={() => { setSelectedTable(t); setSelectedTournament(null) }} style={{...s.row, ...(selectedTable?.id===t.id?s.rowSel:{}), ...(t.featured?s.rowFeat:{})}}>
                  <span style={{...s.c, flex:2}}>{t.featured && <span style={s.star}>★ </span>}<span style={t.featured?s.nameF:s.nameN}>{t.name}</span><span style={s.typeTag}>{t.type === 'holdem' ? 'H' : 'O'}</span></span>
                  <span style={s.c}><b>{t.blinds}</b></span>
                  <span style={s.c}>{t.buyIn} INIT</span>
                  <span style={{...s.c, flex:1.3}}>{dots(t.players, t.max)}</span>
                  <span style={s.c}>{t.avgPot}</span>
                  <span style={s.c}>{t.flop}</span>
                  <span style={s.c}>{t.hhr||'—'}</span>
                </div>
              ))}
            </>
          )}

          {/* Tournaments */}
          {getTabTournaments().length > 0 && (
            <>
              <div style={{...s.secHead, marginTop:'12px'}}><span style={s.secTitle}>Tournaments</span><span style={s.secSub}>Starts every 2h · 8 players min</span></div>
              <div style={s.colHdr}>
                <span style={{...s.hc, flex:2}}>Tournament</span>
                <span style={s.hc}>Buy-in</span>
                <span style={s.hc}>Prize Pool</span>
                <span style={s.hc}>Registered</span>
                <span style={s.hc}>Stack</span>
                <span style={s.hc}>Blinds</span>
                <span style={s.hc}>Next</span>
              </div>
              {getTabTournaments().map(t => (
                <div key={t.id} onClick={() => { setSelectedTournament(t); setSelectedTable(null) }} style={{...s.row, ...(selectedTournament?.id===t.id?s.rowSel:{}), ...(t.vip?s.rowFeat:{})}}>
                  <span style={{...s.c, flex:2}}>{t.vip && <span style={s.star}>★ </span>}<span style={t.vip?s.nameF:s.nameN}>{t.name}</span></span>
                  <span style={s.c}><b>{t.buyIn} INIT</b></span>
                  <span style={{...s.c, color:'#4ade80', fontWeight:700}}>{computePrize(t).toFixed(1)} INIT</span>
                  <span style={s.c}>{t.registered}/{t.minPlayers}</span>
                  <span style={s.c}>{t.startingStack.toLocaleString()}</span>
                  <span style={s.c}>{t.blindLevel}</span>
                  <span style={{...s.c, color:'#fbbf24'}}>{t.nextStart}</span>
                </div>
              ))}
            </>
          )}
        </div>

        {/* ── RIGHT PANEL ── */}
        <div style={s.right}>
          {selectedTournament ? (
            <TournamentPanel t={selectedTournament} computePrize={computePrize} isConnected={isConnected} openConnect={openConnect} />
          ) : selectedTable ? (
            <TablePanel t={selectedTable} onJoin={onJoinTable} isConnected={isConnected} openConnect={openConnect} dots={dots} />
          ) : (
            <div style={s.emptyPanel}>Select a table or tournament</div>
          )}
        </div>
      </div>

      {/* ═══ BOTTOM ═══ */}
      <div style={s.bottom}>
        <span>INIPoker v1.0.0</span>
        <span>● RNG: Band VRF</span>
        <span>● Commit-Reveal</span>
        <span>● Autosign</span>
        <span>Initia Testnet</span>
      </div>

      {/* ═══ CASHIER MODAL ═══ */}
      <CashierModal
        isOpen={cashierOpen}
        onClose={() => setCashierOpen(false)}
        walletBalance={walletBalance}
        gameBalance={gameBalance}
        isLoading={balLoading}
        onRefreshBalances={refetchBal}
      />
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
//  TABLE PREVIEW PANEL
// ═══════════════════════════════════════════════════════════

function TablePanel({ t, onJoin, isConnected, openConnect, dots }: { t: Table; onJoin: (id:number)=>void; isConnected: boolean; openConnect: ()=>void; dots: (c:number,m:number)=>JSX.Element }) {
  return (
    <>
      <div style={s.prevHdr}>{t.blinds} INIT · {t.type === 'holdem' ? "Hold'em" : 'Omaha'}</div>
      <div style={s.miniTable}>
        <div style={s.felt}><span style={s.feltText}>Buy-in: {t.buyIn} INIT<br/>Blinds: {t.blinds} INIT</span></div>
        {[{top:'8%',left:'50%'},{top:'35%',left:'88%'},{top:'78%',left:'80%'},{top:'78%',left:'20%'},{top:'35%',left:'12%'},{top:'55%',left:'50%'}].slice(0,t.max).map((pos,i) => (
          <div key={i} style={{position:'absolute',...pos,transform:'translate(-50%,-50%)'}}>
            {i<t.players ? <div style={s.seatFull}><div style={s.avatar}/><span style={s.sChips}>${(Math.random()*parseInt(t.buyIn.replace(/,/g,''))*0.6+100).toFixed(0)}</span></div> : <div style={s.seatEmpty}/>}
          </div>
        ))}
      </div>
      <div style={s.prevBtns}>
        <button onClick={() => isConnected ? onJoin(t.id) : openConnect()} style={s.openBtn}>Open</button>
        <button onClick={() => isConnected ? onJoin(t.id) : openConnect()} style={t.players<t.max ? s.joinBtn : s.fullBtn}>{t.players<t.max?'Join':'Full'}</button>
      </div>
    </>
  )
}

// ═══════════════════════════════════════════════════════════
//  TOURNAMENT DETAIL PANEL
// ═══════════════════════════════════════════════════════════

function TournamentPanel({ t, computePrize, isConnected, openConnect }: { t: Tournament; computePrize: (t:Tournament)=>number; isConnected: boolean; openConnect: ()=>void }) {
  const [registered, setRegistered] = useState(false)
  const pool = computePrize(t)

  return (
    <div style={{display:'flex', flexDirection:'column', height:'100%', gap:'10px'}}>
      {/* Header */}
      <div style={{textAlign:'center',padding:'8px 0'}}>
        <div style={{fontSize:'15px',fontWeight:700,color:'#fff'}}>{t.name}</div>
        <div style={{fontSize:'11px',color:'#888',marginTop:'2px'}}>{t.type === 'holdem' ? "No-Limit Hold'em" : 'Pot-Limit Omaha'}</div>
      </div>

      {/* Info grid */}
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'6px',fontSize:'11px'}}>
        <div style={s.infoBox}><span style={s.infoLbl}>Buy-in</span><span style={s.infoVal}>{t.buyIn} INIT</span></div>
        <div style={s.infoBox}><span style={s.infoLbl}>Prize Pool</span><span style={{...s.infoVal,color:'#4ade80'}}>{pool.toFixed(1)} INIT</span></div>
        <div style={s.infoBox}><span style={s.infoLbl}>Starting Stack</span><span style={s.infoVal}>{t.startingStack.toLocaleString()}</span></div>
        <div style={s.infoBox}><span style={s.infoLbl}>Blind Levels</span><span style={s.infoVal}>{t.blindLevel}</span></div>
        <div style={s.infoBox}><span style={s.infoLbl}>Registered</span><span style={s.infoVal}>{t.registered} / {t.minPlayers}</span></div>
        <div style={s.infoBox}><span style={s.infoLbl}>Next Start</span><span style={{...s.infoVal,color:'#fbbf24'}}>{t.nextStart}</span></div>
      </div>

      {/* Rules */}
      <div style={{fontSize:'10px',color:'#666',lineHeight:1.6,padding:'6px 0',borderTop:'1px solid #222',borderBottom:'1px solid #222'}}>
        <b style={{color:'#999'}}>Rules:</b> Tournament starts every 2 hours when {t.minPlayers} players registered.
        Starting stack: {t.startingStack.toLocaleString()} INIT ({t.startingStack / 100} big blinds at Level 1).
        Blinds increase every {t.blindLevel}. Late registration closes at Level 3.
        Top 5 places paid.
      </div>

      {/* Prize Distribution */}
      <div>
        <div style={{fontSize:'11px',fontWeight:700,color:'#ccc',marginBottom:'6px'}}>Prize Distribution</div>
        {PRIZE_DISTRIBUTION.map(p => (
          <div key={p.place} style={{display:'flex',alignItems:'center',padding:'4px 0',fontSize:'11px',borderBottom:'1px solid #1a1a1a'}}>
            <span style={{width:'36px',fontWeight:700,color:p.color}}>{p.place}</span>
            <div style={{flex:1,height:'14px',background:'#1a1a1a',borderRadius:'3px',overflow:'hidden'}}>
              <div style={{width:`${p.pct}%`,height:'100%',background:p.color,opacity:0.4,borderRadius:'3px'}} />
            </div>
            <span style={{width:'36px',textAlign:'right' as const,fontWeight:700,color:p.color}}>{p.pct}%</span>
            <span style={{width:'70px',textAlign:'right' as const,color:'#4ade80',fontWeight:600}}>{(pool * p.pct / 100).toFixed(1)}</span>
          </div>
        ))}
      </div>

      {/* Blind Structure (collapsed) */}
      <details style={{fontSize:'10px',color:'#888'}}>
        <summary style={{cursor:'pointer',fontWeight:700,color:'#999',padding:'4px 0'}}>Blind Structure</summary>
        <div style={{marginTop:'4px'}}>
          {BLIND_STRUCTURE.map(b => (
            <div key={b.level} style={{display:'flex',gap:'8px',padding:'2px 0',borderBottom:'1px solid #141414'}}>
              <span style={{width:'20px',color:'#555'}}>L{b.level}</span>
              <span style={{flex:1}}>{b.blinds}</span>
              <span style={{width:'40px'}}>{b.ante}</span>
              <span style={{width:'50px',color:'#555'}}>{b.dur}</span>
            </div>
          ))}
        </div>
      </details>

      {/* Register button */}
      <div style={{marginTop:'auto'}}>
        {registered ? (
          <button onClick={() => setRegistered(false)} style={{...s.regBtn,background:'#333',color:'#888'}}>
            ✓ Registered · Unregister
          </button>
        ) : (
          <button onClick={() => isConnected ? setRegistered(true) : openConnect()} style={s.regBtn}>
            Register · {t.buyIn} INIT
          </button>
        )}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
//  STYLES
// ═══════════════════════════════════════════════════════════

const s: Record<string, React.CSSProperties> = {
  root: { minHeight:'100vh', background:'#0d0d0d', color:'#c0c0c0', fontFamily:'"JetBrains Mono","Fira Code",monospace', display:'flex', flexDirection:'column', fontSize:'12px' },

  topBar: { display:'flex', alignItems:'center', justifyContent:'space-between', padding:'8px 16px', background:'#111', borderBottom:'1px solid #222' },
  topLeft: { display:'flex', alignItems:'baseline' },
  logoB: { fontSize:'22px', fontWeight:800, color:'#fff', letterSpacing:'-1px' },
  logoL: { fontSize:'22px', fontWeight:300, color:'#777', letterSpacing:'-1px' },
  online: { fontSize:'11px', color:'#666' },
  topRight: { display:'flex', gap:'8px' },
  cashierBtn: { background:'#2ecc71', color:'#000', border:'none', borderRadius:'4px', padding:'6px 16px', fontSize:'11px', fontWeight:700, cursor:'pointer', fontFamily:'inherit' },
  gameBalLabel: { fontSize:'11px', color:'#888', display:'flex', alignItems:'center', gap:'4px' },
  walletBtn: { background:'#1a1a1a', color:'#ccc', border:'1px solid #333', borderRadius:'4px', padding:'6px 14px', fontSize:'11px', fontWeight:600, cursor:'pointer', fontFamily:'inherit', display:'flex', alignItems:'center', gap:'6px' },
  wDot: { width:'6px', height:'6px', borderRadius:'50%', background:'#4ade80', display:'inline-block' },
  loginBtn: { background:'#222', color:'#ccc', border:'1px solid #333', borderRadius:'4px', padding:'7px 20px', fontSize:'12px', fontWeight:600, cursor:'pointer', fontFamily:'inherit' },
  signupBtn: { background:'#c0392b', color:'#fff', border:'none', borderRadius:'4px', padding:'7px 20px', fontSize:'12px', fontWeight:700, cursor:'pointer', fontFamily:'inherit' },

  tabBar: { display:'flex', padding:'0 16px', background:'#111', borderBottom:'1px solid #222' },
  tabBtn: { background:'transparent', color:'#666', border:'none', borderBottom:'2px solid transparent', padding:'10px 18px', fontSize:'12px', fontWeight:600, cursor:'pointer', fontFamily:'inherit' },
  tabAct: { background:'#1a1a1a', color:'#fff', border:'none', borderBottom:'2px solid #e0e0e0', padding:'10px 18px', fontSize:'12px', fontWeight:700, cursor:'pointer', fontFamily:'inherit' },

  main: { display:'flex', flex:1, overflow:'hidden' },
  left: { flex:1, overflowY:'auto' as const, borderRight:'1px solid #1a1a1a' },
  right: { width:'300px', background:'#111', padding:'12px', flexShrink:0, overflowY:'auto' as const, display:'flex', flexDirection:'column' },

  secHead: { display:'flex', alignItems:'baseline', gap:'12px', padding:'8px 12px', background:'#141414', borderBottom:'1px solid #1a1a1a' },
  secTitle: { fontSize:'12px', fontWeight:700, color:'#ddd' },
  secSub: { fontSize:'10px', color:'#555' },

  colHdr: { display:'flex', padding:'5px 12px', background:'#141414', borderBottom:'1px solid #1a1a1a' },
  hc: { flex:1, fontSize:'9px', color:'#555', fontWeight:700, letterSpacing:'0.3px', textTransform:'uppercase' as const },

  row: { display:'flex', padding:'6px 12px', borderBottom:'1px solid #1a1a1a', cursor:'pointer' },
  rowSel: { background:'#1a1a1a' },
  rowFeat: { background:'rgba(251,191,36,0.03)', borderLeft:'2px solid #fbbf24' },
  c: { flex:1, display:'flex', alignItems:'center', gap:'4px', fontSize:'11px', color:'#bbb' },
  nameN: { color:'#ddd', fontWeight:500 },
  nameF: { color:'#fbbf24', fontWeight:700 },
  star: { color:'#fbbf24', fontSize:'10px' },
  typeTag: { fontSize:'8px', color:'#555', background:'#1a1a1a', borderRadius:'2px', padding:'1px 4px', marginLeft:'4px' },

  // Table preview
  prevHdr: { textAlign:'center' as const, fontSize:'14px', fontWeight:700, color:'#fff', padding:'8px 0' },
  miniTable: { position:'relative' as const, height:'190px', margin:'4px 0' },
  felt: { position:'absolute' as const, top:'18%', left:'8%', width:'84%', height:'64%', borderRadius:'50%', background:'#162016', border:'2px solid #2a4a2a', display:'flex', alignItems:'center', justifyContent:'center' },
  feltText: { fontSize:'10px', color:'#4a6a4a', textAlign:'center' as const, lineHeight:1.6 },
  seatFull: { display:'flex', flexDirection:'column' as const, alignItems:'center', gap:'1px' },
  avatar: { width:'26px', height:'26px', borderRadius:'50%', background:'#222', border:'2px solid #333' },
  sChips: { fontSize:'9px', color:'#4ade80', fontWeight:700, background:'rgba(0,0,0,0.7)', padding:'1px 5px', borderRadius:'3px' },
  seatEmpty: { width:'26px', height:'26px', borderRadius:'50%', border:'1px dashed #333' },
  prevBtns: { display:'flex', gap:'8px', marginTop:'8px' },
  openBtn: { flex:1, background:'#222', color:'#ccc', border:'1px solid #333', borderRadius:'4px', padding:'8px', fontSize:'12px', fontWeight:600, cursor:'pointer', fontFamily:'inherit' },
  joinBtn: { flex:1, background:'#c0392b', color:'#fff', border:'none', borderRadius:'4px', padding:'8px', fontSize:'12px', fontWeight:700, cursor:'pointer', fontFamily:'inherit' },
  fullBtn: { flex:1, background:'#222', color:'#555', border:'1px solid #1a1a1a', borderRadius:'4px', padding:'8px', fontSize:'12px', cursor:'not-allowed', fontFamily:'inherit' },

  // Tournament panel
  infoBox: { background:'#141414', borderRadius:'4px', padding:'8px', display:'flex', flexDirection:'column' as const, gap:'2px' },
  infoLbl: { fontSize:'9px', color:'#555', fontWeight:600, textTransform:'uppercase' as const },
  infoVal: { fontSize:'13px', fontWeight:700, color:'#ddd' },
  regBtn: { width:'100%', background:'#c0392b', color:'#fff', border:'none', borderRadius:'4px', padding:'10px', fontSize:'13px', fontWeight:700, cursor:'pointer', fontFamily:'inherit' },

  emptyPanel: { color:'#444', textAlign:'center' as const, marginTop:'40px', fontSize:'13px' },

  bottom: { display:'flex', alignItems:'center', gap:'20px', padding:'6px 16px', background:'#111', borderTop:'1px solid #1a1a1a', fontSize:'10px', color:'#444' },
}
