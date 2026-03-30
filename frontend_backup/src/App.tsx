import { useState, Component, type ReactNode } from 'react'
import Providers from './providers'
import Lobby from './components/Lobby'
import PokerTable from './components/PokerTable'

class ErrorBoundary extends Component<{children: ReactNode}, {error: string | null}> {
  state = { error: null as string | null }
  static getDerivedStateFromError(e: Error) { return { error: e.message } }
  render() {
    if (this.state.error) return (
      <div style={{color:'#e74c3c',padding:40,fontFamily:'monospace',background:'#0a0c10',minHeight:'100vh'}}>
        <h1 style={{color:'#d4af37'}}>INIPoker</h1>
        <p>App crashed: {this.state.error}</p>
        <button onClick={() => window.location.reload()} style={{marginTop:16,padding:'8px 16px',cursor:'pointer'}}>Reload</button>
      </div>
    )
    return this.props.children
  }
}

type View = { page: 'lobby' } | { page: 'table', tableId: number }

function AppRouter() {
  const [view, setView] = useState<View>({ page: 'lobby' })

  if (view.page === 'table') {
    return (
      <PokerTable
        tableId={BigInt(view.tableId)}
        onBack={() => setView({ page: 'lobby' })}
      />
    )
  }

  return (
    <Lobby onJoinTable={(id) => setView({ page: 'table', tableId: id })} />
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
