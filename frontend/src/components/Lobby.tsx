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
interface Table { id: number; name: string; type: GameType; blinds: string; smallBlind: number; bigBlind: number; buyIn: string; players: number; max: number; avgPot: string; flop: string; hhr: number; featured?: boolean }
interface Tournament { id: number; name: string; type: GameType; buyIn: number; prize: number; registered: number; minPlayers: number; startingStack: number; blindLevel: string; nextStart: string; vip?: boolean }

// ── TEST TABLES (tiny blinds for easy testing) ──
const TEST_TABLES: Table[] = [
  { id: 14, name: 'Test Micro 01', type: 'holdem', blinds: '0.1/0.2', smallBlind: 0.1, bigBlind: 0.2, buyIn: '2–20', players: 0, max: 6, avgPot: '0', flop: '—', hhr: 0, featured: true },
  { id: 15, name: 'Test Micro 02', type: 'holdem', blinds: '0.1/0.2', smallBlind: 0.1, bigBlind: 0.2, buyIn: '2–20', players: 0, max: 6, avgPot: '0', flop: '—', hhr: 0 },
]

const HOLDEM_TABLES: Table[] = [
  { id: 2, name: 'Emerald 01', type: 'holdem', blinds: '1/2', smallBlind: 1, bigBlind: 2, buyIn: '20–200', players: 0, max: 6, avgPot: '136', flop: '54%', hhr: 112 },
  { id: 3, name: 'Emerald 02', type: 'holdem', blinds: '1/2', smallBlind: 1, bigBlind: 2, buyIn: '20–200', players: 0, max: 6, avgPot: '98', flop: '50%', hhr: 108 },
  { id: 4, name: 'Ruby 01', type: 'holdem', blinds: '5/10', smallBlind: 5, bigBlind: 10, buyIn: '100–1,000', players: 0, max: 6, avgPot: '420', flop: '48%', hhr: 103, featured: true },
  { id: 5, name: 'Ruby 02', type: 'holdem', blinds: '5/10', smallBlind: 5, bigBlind: 10, buyIn: '100–1,000', players: 0, max: 6, avgPot: '380', flop: '46%', hhr: 99 },
  { id: 6, name: 'Onyx 01', type: 'holdem', blinds: '25/50', smallBlind: 25, bigBlind: 50, buyIn: '500–5,000', players: 0, max: 6, avgPot: '1,200', flop: '42%', hhr: 90 },
]

const OMAHA_TABLES: Table[] = [
  { id: 7, name: 'Omaha Emerald', type: 'omaha', blinds: '1/2', smallBlind: 1, bigBlind: 2, buyIn: '20–200', players: 0, max: 6, avgPot: '190', flop: '58%', hhr: 95 },
  { id: 8, name: 'Omaha Ruby', type: 'omaha', blinds: '5/10', smallBlind: 5, bigBlind: 10, buyIn: '100–1,000', players: 0, max: 6, avgPot: '580', flop: '62%', hhr: 88, featured: true },
  { id: 9, name: 'Omaha Onyx', type: 'omaha', blinds: '25/50', smallBlind: 25, bigBlind: 50, buyIn: '500–5,000', players: 0, max: 6, avgPot: '2,800', flop: '55%', hhr: 82 },
]

const VIP_TABLES: Table[] = [
  { id: 30, name: 'VIP Holdem', type: 'holdem', blinds: '500/1,000', smallBlind: 500, bigBlind: 1000, buyIn: '10K–100K', players: 0, max: 6, avgPot: '12,500', flop: '42%', hhr: 72, featured: true },
  { id: 31, name: 'VIP Omaha', type: 'omaha', blinds: '500/1,000', smallBlind: 500, bigBlind: 1000, buyIn: '10K–100K', players: 0, max: 6, avgPot: '18,200', flop: '58%', hhr: 68, featured: true },
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
  { place: '1st', pct: 50, color: '#E8DCC8' },
  { place: '2nd', pct: 30, color: '#b0a890' },
  { place: '3rd', pct: 12, color: '#8a7e68' },
  { place: '4th', pct: 5, color: '#555' },
  { place: '5th', pct: 3, color: '#444' },
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

interface LobbyProps { onJoinTable: (tableId: number, bigBlind: number, tableName: string) => void }

export default function Lobby({ onJoinTable }: LobbyProps) {
  const { address, isConnected } = useAccount()
  const { username, openConnect, openWallet } = useInterwovenKit()
  const { walletBalance, gameBalance, isLoading: balLoading, refetch: refetchBal } = useWalletBalance()
  const [tab, setTab] = useState<Tab>('home')
  const [selectedTable, setSelectedTable] = useState<Table | null>(TEST_TABLES[0])
  const [selectedTournament, setSelectedTournament] = useState<Tournament | null>(null)
  const [cashierOpen, setCashierOpen] = useState(false)

  const truncAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

  const allTables = [...TEST_TABLES, ...HOLDEM_TABLES, ...OMAHA_TABLES]
  // Real count: only from on-chain data (mock tables show 0 until we have real data)
  const totalPlayers = [...allTables, ...VIP_TABLES].reduce((a, t) => a + t.players, 0)

  const getTabTables = (): Table[] => {
    if (tab === 'home') return [...TEST_TABLES, ...allTables.filter(t => !TEST_TABLES.includes(t))]
    if (tab === 'holdem') return [...TEST_TABLES, ...HOLDEM_TABLES]
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
    for (let i = 0; i < max; i++) d.push(<span key={i} style={{ display: 'inline-block', width: '6px', height: '6px', borderRadius: '50%', background: i < count ? '#7ECFB3' : '#1C1C1C', marginRight: '2px' }} />)
    return <span style={{ display: 'inline-flex', alignItems: 'center' }}>{d}</span>
  }

  // ═══ RENDER ═══
  return (
    <div style={s.root}>

      {/* ═══ TOP BAR ═══ */}
      <div style={s.topBar}>
        <div style={s.topLeft}>
          <span style={s.logoMark}>◆</span>
          <span style={s.logoB}>INI</span><span style={s.logoL}>Poker</span>
        </div>
        <span style={s.online}>{totalPlayers > 0 ? `${totalPlayers} online` : 'Testnet'}</span>
        <div style={s.topRight}>
          {isConnected && (
            <>
              <span style={s.gameBalLabel}>
                <span style={s.balDot} />
                {balLoading ? '…' : `${walletBalance}`}
                <span style={{color:'#555'}}>|</span>
                <span style={{color:'#7ECFB3'}}>{balLoading ? '…' : gameBalance}</span>
                <span style={{color:'#555',fontSize:'10px'}}>INIT</span>
              </span>
              <button onClick={() => setCashierOpen(true)} style={s.cashierBtn}>Cashier</button>
            </>
          )}
          {isConnected ? (
            <button onClick={openWallet} style={s.walletBtn}>{username ?? truncAddr(address!)}</button>
          ) : (
            <button onClick={openConnect} style={s.loginBtn}>Connect Wallet</button>
          )}
        </div>
      </div>

      {/* ═══ TAB BAR ═══ */}
      <div style={s.tabBar}>
        {([['home','Home'],['tournament','Tournament'],['holdem',"Hold'em"],['omaha','Omaha'],['vip','VIP']] as [Tab,string][]).map(([k,label]) => (
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
              <div style={s.secHead}>
                <span style={s.secTitle}>{tab === 'vip' ? 'VIP Tables' : 'Cash Games'}</span>
                {tab === 'home' && <span style={s.testBadge}>Test tables included</span>}
              </div>
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
                  <span style={{...s.c, flex:2}}>
                    {t.featured && <span style={s.star}>◆ </span>}
                    <span style={t.featured?s.nameF:s.nameN}>{t.name}</span>
                    <span style={s.typeTag}>{t.type === 'holdem' ? 'H' : 'O'}</span>
                    {t.bigBlind <= 0.2 && <span style={s.microTag}>TEST</span>}
                  </span>
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
                  <span style={{...s.c, flex:2}}>{t.vip && <span style={s.star}>◆ </span>}<span style={t.vip?s.nameF:s.nameN}>{t.name}</span></span>
                  <span style={s.c}><b>{t.buyIn} INIT</b></span>
                  <span style={{...s.c, color:'#7ECFB3', fontWeight:700}}>{computePrize(t).toFixed(1)} INIT</span>
                  <span style={s.c}>{t.registered}/{t.minPlayers}</span>
                  <span style={s.c}>{t.startingStack.toLocaleString()}</span>
                  <span style={s.c}>{t.blindLevel}</span>
                  <span style={{...s.c, color:'#E8DCC8'}}>{t.nextStart}</span>
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
        <span style={{color:'#555'}}>INIPoker v1.0</span>
        <span>Band VRF</span>
        <span>Commit-Reveal</span>
        <span>Autosign</span>
        <span style={{marginLeft:'auto',color:'#555'}}>Initia Testnet</span>
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

function TablePanel({ t, onJoin, isConnected, openConnect, dots }: { t: Table; onJoin: (id:number,bb:number,name:string)=>void; isConnected: boolean; openConnect: ()=>void; dots: (c:number,m:number)=>JSX.Element }) {
  return (
    <>
      <div style={s.prevHdr}>
        <span style={{fontSize:'11px',color:'#555',textTransform:'uppercase',letterSpacing:'1px'}}>{t.type === 'holdem' ? "Hold'em" : 'Omaha'}</span>
        <span style={{fontSize:'18px',fontWeight:600,color:'#fff'}}>{t.name}</span>
        <span style={{fontSize:'12px',color:'#8A8A8A'}}>{t.blinds} INIT blinds</span>
      </div>
      <div style={s.miniTable}>
        <div style={s.felt}>
          <span style={s.feltText}>
            <span style={{color:'#7ECFB3',fontWeight:600}}>{t.blinds}</span>
            <br/>{t.buyIn} INIT
          </span>
        </div>
        {[{top:'8%',left:'50%'},{top:'35%',left:'88%'},{top:'78%',left:'80%'},{top:'78%',left:'20%'},{top:'35%',left:'12%'},{top:'55%',left:'50%'}].slice(0,t.max).map((pos,i) => (
          <div key={i} style={{position:'absolute',...pos,transform:'translate(-50%,-50%)'}}>
            {i<t.players ? <div style={s.seatFull}><div style={s.avatar}/><span style={s.sChips}>{(Math.random()*parseInt((t.buyIn).replace(/[^0-9]/g,''))*0.6+10).toFixed(0)}</span></div> : <div style={s.seatEmpty}/>}
          </div>
        ))}
      </div>

      {/* Info */}
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'6px',margin:'8px 0'}}>
        <div style={s.infoBox}><span style={s.infoLbl}>Buy-in range</span><span style={s.infoVal}>{t.buyIn} INIT</span></div>
        <div style={s.infoBox}><span style={s.infoLbl}>Players</span><span style={s.infoVal}>{t.players}/{t.max}</span></div>
      </div>

      <div style={s.prevBtns}>
        <button onClick={() => isConnected ? onJoin(t.id, t.bigBlind, t.name) : openConnect()} style={s.openBtn}>Observe</button>
        <button onClick={() => isConnected ? onJoin(t.id, t.bigBlind, t.name) : openConnect()} style={t.players<t.max ? s.joinBtn : s.fullBtn}>{t.players<t.max?'Play':'Full'}</button>
      </div>

      <div style={{fontSize:'10px',color:'#3a3a3a',marginTop:'8px',lineHeight:1.6}}>
        Buy-in: {t.bigBlind * 10}–{t.bigBlind * 100} INIT ({10}–{100} big blinds)
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
      <div style={{textAlign:'center',padding:'8px 0'}}>
        <div style={{fontSize:'15px',fontWeight:600,color:'#fff'}}>{t.name}</div>
        <div style={{fontSize:'11px',color:'#555',marginTop:'2px'}}>{t.type === 'holdem' ? "No-Limit Hold'em" : 'Pot-Limit Omaha'}</div>
      </div>

      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'6px',fontSize:'11px'}}>
        <div style={s.infoBox}><span style={s.infoLbl}>Buy-in</span><span style={s.infoVal}>{t.buyIn} INIT</span></div>
        <div style={s.infoBox}><span style={s.infoLbl}>Prize Pool</span><span style={{...s.infoVal,color:'#7ECFB3'}}>{pool.toFixed(1)} INIT</span></div>
        <div style={s.infoBox}><span style={s.infoLbl}>Starting Stack</span><span style={s.infoVal}>{t.startingStack.toLocaleString()}</span></div>
        <div style={s.infoBox}><span style={s.infoLbl}>Blind Levels</span><span style={s.infoVal}>{t.blindLevel}</span></div>
        <div style={s.infoBox}><span style={s.infoLbl}>Registered</span><span style={s.infoVal}>{t.registered} / {t.minPlayers}</span></div>
        <div style={s.infoBox}><span style={s.infoLbl}>Next Start</span><span style={{...s.infoVal,color:'#E8DCC8'}}>{t.nextStart}</span></div>
      </div>

      <div style={{fontSize:'10px',color:'#444',lineHeight:1.6,padding:'6px 0',borderTop:'1px solid #161616',borderBottom:'1px solid #161616'}}>
        <b style={{color:'#666'}}>Rules:</b> Tournament starts every 2 hours when {t.minPlayers} players registered.
        Starting stack: {t.startingStack.toLocaleString()} INIT. Top 5 places paid.
      </div>

      <div>
        <div style={{fontSize:'11px',fontWeight:600,color:'#888',marginBottom:'6px'}}>Prize Distribution</div>
        {PRIZE_DISTRIBUTION.map(p => (
          <div key={p.place} style={{display:'flex',alignItems:'center',padding:'4px 0',fontSize:'11px',borderBottom:'1px solid #111'}}>
            <span style={{width:'36px',fontWeight:700,color:p.color}}>{p.place}</span>
            <div style={{flex:1,height:'12px',background:'#111',borderRadius:'3px',overflow:'hidden'}}>
              <div style={{width:`${p.pct}%`,height:'100%',background:p.color,opacity:0.3,borderRadius:'3px'}} />
            </div>
            <span style={{width:'36px',textAlign:'right' as const,fontWeight:600,color:p.color}}>{p.pct}%</span>
            <span style={{width:'70px',textAlign:'right' as const,color:'#7ECFB3',fontWeight:600}}>{(pool * p.pct / 100).toFixed(1)}</span>
          </div>
        ))}
      </div>

      <details style={{fontSize:'10px',color:'#555'}}>
        <summary style={{cursor:'pointer',fontWeight:600,color:'#666',padding:'4px 0'}}>Blind Structure</summary>
        <div style={{marginTop:'4px'}}>
          {BLIND_STRUCTURE.map(b => (
            <div key={b.level} style={{display:'flex',gap:'8px',padding:'2px 0',borderBottom:'1px solid #0F0F0F'}}>
              <span style={{width:'20px',color:'#444'}}>L{b.level}</span>
              <span style={{flex:1}}>{b.blinds}</span>
              <span style={{width:'40px'}}>{b.ante}</span>
              <span style={{width:'50px',color:'#444'}}>{b.dur}</span>
            </div>
          ))}
        </div>
      </details>

      <div style={{marginTop:'auto'}}>
        {registered ? (
          <button onClick={() => setRegistered(false)} style={{...s.regBtn,background:'#161616',color:'#555'}}>
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
//  STYLES — Initia-inspired minimal dark
// ═══════════════════════════════════════════════════════════

const s: Record<string, React.CSSProperties> = {
  root: { minHeight:'100vh', background:'#000', color:'#b0b0b0', fontFamily:'"DM Sans",sans-serif', display:'flex', flexDirection:'column', fontSize:'12px' },

  topBar: { display:'flex', alignItems:'center', justifyContent:'space-between', padding:'10px 20px', background:'#000', borderBottom:'1px solid #161616' },
  topLeft: { display:'flex', alignItems:'center', gap:'6px' },
  logoMark: { color:'#E8DCC8', fontSize:'14px' },
  logoB: { fontSize:'20px', fontWeight:700, color:'#fff', letterSpacing:'-0.5px' },
  logoL: { fontSize:'20px', fontWeight:300, color:'#555', letterSpacing:'-0.5px' },
  online: { fontSize:'11px', color:'#3a3a3a' },
  topRight: { display:'flex', gap:'8px', alignItems:'center' },
  cashierBtn: { background:'#161616', color:'#7ECFB3', border:'1px solid #1C1C1C', borderRadius:'6px', padding:'7px 16px', fontSize:'11px', fontWeight:600, cursor:'pointer', fontFamily:'inherit' },
  gameBalLabel: { fontSize:'11px', color:'#888', display:'flex', alignItems:'center', gap:'6px', fontFamily:'"DM Mono",monospace' },
  balDot: { width:'5px', height:'5px', borderRadius:'50%', background:'#7ECFB3', display:'inline-block' },
  walletBtn: { background:'#111', color:'#ccc', border:'1px solid #1C1C1C', borderRadius:'6px', padding:'7px 14px', fontSize:'11px', fontWeight:500, cursor:'pointer', fontFamily:'"DM Mono",monospace' },
  loginBtn: { background:'#E8DCC8', color:'#000', border:'none', borderRadius:'6px', padding:'8px 20px', fontSize:'12px', fontWeight:600, cursor:'pointer', fontFamily:'inherit' },

  tabBar: { display:'flex', padding:'0 20px', background:'#000', borderBottom:'1px solid #161616' },
  tabBtn: { background:'transparent', color:'#444', border:'none', borderBottom:'2px solid transparent', padding:'10px 18px', fontSize:'12px', fontWeight:500, cursor:'pointer', fontFamily:'inherit', transition:'color 0.2s' },
  tabAct: { background:'transparent', color:'#fff', border:'none', borderBottom:'2px solid #E8DCC8', padding:'10px 18px', fontSize:'12px', fontWeight:600, cursor:'pointer', fontFamily:'inherit' },

  main: { display:'flex', flex:1, overflow:'hidden' },
  left: { flex:1, overflowY:'auto' as const, borderRight:'1px solid #111' },
  right: { width:'300px', background:'#0A0A0A', padding:'14px', flexShrink:0, overflowY:'auto' as const, display:'flex', flexDirection:'column' },

  secHead: { display:'flex', alignItems:'baseline', gap:'12px', padding:'10px 14px', borderBottom:'1px solid #111' },
  secTitle: { fontSize:'11px', fontWeight:600, color:'#888', letterSpacing:'0.5px', textTransform:'uppercase' as const },
  secSub: { fontSize:'10px', color:'#3a3a3a' },
  testBadge: { fontSize:'9px', color:'#7ECFB3', background:'rgba(126,207,179,0.08)', padding:'2px 8px', borderRadius:'4px', fontWeight:600 },

  colHdr: { display:'flex', padding:'5px 14px', borderBottom:'1px solid #111' },
  hc: { flex:1, fontSize:'9px', color:'#3a3a3a', fontWeight:600, letterSpacing:'0.3px', textTransform:'uppercase' as const },

  row: { display:'flex', padding:'7px 14px', borderBottom:'1px solid #0F0F0F', cursor:'pointer', transition:'background 0.15s' },
  rowSel: { background:'#111' },
  rowFeat: { background:'rgba(232,220,200,0.02)', borderLeft:'2px solid #E8DCC8' },
  c: { flex:1, display:'flex', alignItems:'center', gap:'4px', fontSize:'11px', color:'#888' },
  nameN: { color:'#ccc', fontWeight:500 },
  nameF: { color:'#E8DCC8', fontWeight:600 },
  star: { color:'#E8DCC8', fontSize:'10px' },
  typeTag: { fontSize:'8px', color:'#444', background:'#111', borderRadius:'2px', padding:'1px 4px', marginLeft:'4px' },
  microTag: { fontSize:'8px', color:'#7ECFB3', background:'rgba(126,207,179,0.1)', borderRadius:'2px', padding:'1px 5px', marginLeft:'4px', fontWeight:700 },

  // Table preview
  prevHdr: { display:'flex', flexDirection:'column' as const, alignItems:'center', gap:'2px', padding:'8px 0' },
  miniTable: { position:'relative' as const, height:'190px', margin:'4px 0' },
  felt: { position:'absolute' as const, top:'18%', left:'8%', width:'84%', height:'64%', borderRadius:'50%', background:'#0F0F0F', border:'1px solid #1C1C1C', display:'flex', alignItems:'center', justifyContent:'center' },
  feltText: { fontSize:'10px', color:'#555', textAlign:'center' as const, lineHeight:1.6 },
  seatFull: { display:'flex', flexDirection:'column' as const, alignItems:'center', gap:'1px' },
  avatar: { width:'26px', height:'26px', borderRadius:'50%', background:'#161616', border:'1px solid #2a2a2a' },
  sChips: { fontSize:'9px', color:'#7ECFB3', fontWeight:600, background:'rgba(0,0,0,0.8)', padding:'1px 5px', borderRadius:'3px' },
  seatEmpty: { width:'26px', height:'26px', borderRadius:'50%', border:'1px dashed #222' },
  prevBtns: { display:'flex', gap:'8px', marginTop:'8px' },
  openBtn: { flex:1, background:'#111', color:'#888', border:'1px solid #1C1C1C', borderRadius:'6px', padding:'9px', fontSize:'12px', fontWeight:500, cursor:'pointer', fontFamily:'inherit' },
  joinBtn: { flex:1, background:'#E8DCC8', color:'#000', border:'none', borderRadius:'6px', padding:'9px', fontSize:'12px', fontWeight:600, cursor:'pointer', fontFamily:'inherit' },
  fullBtn: { flex:1, background:'#111', color:'#3a3a3a', border:'1px solid #111', borderRadius:'6px', padding:'9px', fontSize:'12px', cursor:'not-allowed', fontFamily:'inherit' },

  // Tournament panel
  infoBox: { background:'#0F0F0F', borderRadius:'6px', padding:'8px', display:'flex', flexDirection:'column' as const, gap:'2px' },
  infoLbl: { fontSize:'9px', color:'#3a3a3a', fontWeight:600, textTransform:'uppercase' as const },
  infoVal: { fontSize:'13px', fontWeight:600, color:'#ccc' },
  regBtn: { width:'100%', background:'#E8DCC8', color:'#000', border:'none', borderRadius:'6px', padding:'10px', fontSize:'13px', fontWeight:600, cursor:'pointer', fontFamily:'inherit' },

  emptyPanel: { color:'#2a2a2a', textAlign:'center' as const, marginTop:'40px', fontSize:'13px' },

  bottom: { display:'flex', alignItems:'center', gap:'20px', padding:'8px 20px', borderTop:'1px solid #111', fontSize:'10px', color:'#2a2a2a' },
}




