import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { registerSW } from 'virtual:pwa-register'
import { installApiBaseFetch } from './lib/api-base'

installApiBaseFetch()

if (import.meta.env.PROD) {
  // 正式環境才註冊 Service Worker，避免開發環境被舊快取干擾
  const updateSW = registerSW({
    onNeedRefresh() {
      // 不自動 reload：新 SW 會在下次使用者重新整理時自然生效
      // 避免老師已看到畫面後又被踢走的問題
      console.log('🔄 發現新版本，將於下次重新整理時生效')
    },
    onRegisteredSW(_url, registration) {
      // 每次載入頁面時檢查新版本（背景下載，不打斷使用者）
      if (registration) {
        void registration.update()
      }
    },
    onOfflineReady() {
      console.log('✅ 應用已可離線使用')
    },
    onRegisterError(error: Error) {
      console.error('❌ Service Worker 註冊失敗:', error)
    }
  })

  window.__SW_UPDATE__ = updateSW
} else if ('serviceWorker' in navigator) {
  // 開發環境主動移除既有 SW，確保不會載入舊版 UI
  navigator.serviceWorker
    .getRegistrations()
    .then((registrations) => {
      registrations.forEach((registration) => {
        void registration.unregister()
      })
    })
    .catch((error) => {
      console.warn('清理 Service Worker 失敗:', error)
    })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
