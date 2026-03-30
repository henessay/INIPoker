/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_POKER_GAME_ADDRESS: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
