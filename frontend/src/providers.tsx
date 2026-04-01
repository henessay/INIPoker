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

// INIPoker L2 EVM — shows "INIPoker L2" not "Ethereum"
const initiaTestnet = {
  id: 2649570508572901,
  name: 'INIPoker L2',
  nativeCurrency: { name: 'INIT', symbol: 'INIT', decimals: 18 },
  rpcUrls: {
    default: { http: ['/api/rpc'] },
  },
} as const

const wagmiConfig = createConfig({
  connectors: [initiaPrivyWalletConnector],
  chains: [initiaTestnet],
  transports: { [initiaTestnet.id]: http() },
})

const queryClient = new QueryClient()

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
