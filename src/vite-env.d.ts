/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_GEMINI_PROXY_URL?: string
  readonly VITE_API_BASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

// Window 介面擴展
interface Window {
  __SW_UPDATE__?: () => Promise<void>
  Capacitor?: any
}

/** 建置時間戳（vite define 注入、台灣時區）；頁尾顯示用 */
declare const __BUILD_STAMP__: string
