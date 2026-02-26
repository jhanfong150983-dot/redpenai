import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { registerSW } from 'virtual:pwa-register'
import { installApiBaseFetch } from './lib/api-base'

installApiBaseFetch()

// 註冊 Service Worker
const updateSW = registerSW({
  onNeedRefresh() {
    console.log('🔄 發現新版本,準備更新...')
    // 自動更新 (autoUpdate 模式)
  },
  onOfflineReady() {
    console.log('✅ 應用已可離線使用')
    // 可選: 顯示通知給使用者
  },
  onRegisterError(error: Error) {
    console.error('❌ Service Worker 註冊失敗:', error)
  }
})

// 開發模式下可手動觸發更新
if (import.meta.env.DEV) {
  window.__SW_UPDATE__ = updateSW
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
