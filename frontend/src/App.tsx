import { useState, Component, type ReactNode } from 'react'
import Providers from './providers'
import Lobby from './components/Lobby'
import PokerTable from './components/PokerTable'

class ErrorBoundary extends Component<{children: ReactNode}, {error: string | null}> {
  state = { error: null as string | null }
  static getDerivedStateFromError(e: Error) { return { error: e.message } }
  render() {
    if (this.state.error) return (
      <div style={{color:'#E07070',padding:40,fontFamily:'"DM Sans",sans-serif',background:'#000',minHeight:'100vh'}}>
        <h1 style={{color:'#E8DCC8'}}>INIPoker</h1>
        <p style={{marginTop:12}}>App crashed: {this.state.error}</p>
        <button onClick={() => window.location.reload()} style={{marginTop:16,padding:'8px 16px',cursor:'pointer',background:'#161616',color:'#fff',border:'1px solid #2a2a2a',borderRadius:6,fontFamily:'inherit'}}>Reload</button>
      </div>
    )
    return this.props.children
  }
}

type View =
  | { page: 'lobby' }
  | { page: 'table', tableId: number, bigBlind: number, tableName: string }

function AppRouter() {
  const [view, setView] = useState<View>({ page: 'lobby' })

  if (view.page === 'table') {
    return (
      <PokerTable
        tableId={BigInt(view.tableId)}
        bigBlind={view.bigBlind}
        tableName={view.tableName}
        onBack={() => setView({ page: 'lobby' })}
      />
    )
  }

  return (
    <Lobby onJoinTable={(id, bigBlind, tableName) => setView({ page: 'table', tableId: id, bigBlind, tableName })} />
  )
}

export default function App() {
  return (
    <ErrorBoundary>
      <Providers>
        <AppRouter />
      </Providers>
    </ErrorBoundary>
  )
}
