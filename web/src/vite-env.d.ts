/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string
  readonly VITE_ICP_RECORD?: string
  readonly VITE_PUBLIC_SECURITY_RECORD?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
