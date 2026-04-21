'use client'

import { type PropsWithChildren, useEffect } from 'react'
import { createConfig, http, WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  initiaPrivyWalletConnector,
  injectStyles,
  InterwovenKitProvider,
  TESTNET,
} from '@initia/interwovenkit-react'
import css from '@initia/interwovenkit-react/styles.css?inline'

import { COSMOS_CHAIN_ID } from './config/chain'

const RPC = '/api/rpc'

const initiaTestnet = {
  id: 2649570508581093,
  name: 'INIPoker Minitia L2',
  nativeCurrency: { name: 'INIT', symbol: 'INIT', decimals: 18 },
  rpcUrls: {
    default: { http: [RPC] },
  },
} as const

const wagmiConfig = createConfig({
  connectors: [initiaPrivyWalletConnector],
  chains: [initiaTestnet],
  transports: {
    [initiaTestnet.id]: http(RPC, {
      batch: false,
      retryCount: 2,
      retryDelay: 150,
      fetchOptions: {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-store', 'Pragma': 'no-cache' },
      },
    }),
  },
  cacheTime: 0,
})

// React-Query defaults keep query results for 5 minutes (gcTime).
// For a real-time on-chain game that is far too long — a refetch after
// a short pause can return stale data from cache. Tell React-Query to
// treat every query as always stale and never reuse cached responses.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0,
      gcTime: 0,
      refetchOnMount: 'always',
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
  },
})

const AUTOSIGN_PERMISSIONS = {
  [COSMOS_CHAIN_ID]: ['/minievm.evm.v1.MsgCall'],
}

export default function Providers({ children }: PropsWithChildren) {
  useEffect(() => {
    try { injectStyles(css) } catch (e) { console.warn('Style inject:', e) }
  }, [])

  return (
    <QueryClientProvider client={queryClient}>
      <WagmiProvider config={wagmiConfig}>
        <InterwovenKitProvider
          {...TESTNET}
          defaultChainId={COSMOS_CHAIN_ID}
          enableAutoSign={AUTOSIGN_PERMISSIONS}
        >
          {children}
        </InterwovenKitProvider>
      </WagmiProvider>
    </QueryClientProvider>
  )
}
