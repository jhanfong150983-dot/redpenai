import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { registerSW } from 'virtual:pwa-register'
import { installApiBaseFetch } from './lib/api-base'

installApiBaseFetch()

if (import.meta.env.PROD) {
  // 正式環境才註冊 Service Worker，避免開發環境被舊快取干擾
  const updateSW = registerSW({
    onNeedRefresh() {
      console.log('🔄 發現新版本，自動更新...')
      void updateSW(true) // 立即啟用新 SW
    },
    onRegisteredSW(_url, registration) {
      // 每次載入頁面時檢查新版本
      if (registration) {
        void registration.update()
      }
    },
    onOfflineReady() {
      console.log('✅ 應用已可離線使用')
      // 可選: 顯示通知給使用者
    },
    onRegisterError(error: Error) {
      console.error('❌ Service Worker 註冊失敗:', error)
    }
  })

  window.__SW_UPDATE__ = updateSW

  // SW 控制權切換時自動重新載入，確保載入最新程式碼
  let refreshing = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!refreshing) {
      refreshing = true
      window.location.reload()
    }
  })
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
    <App />
  </StrictMode>,
)
