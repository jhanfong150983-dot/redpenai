import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { ConfirmProvider } from './components/ConfirmModal'
import { registerSW } from 'virtual:pwa-register'
import { installApiBaseFetch } from './lib/api-base'

installApiBaseFetch()

function showUpdateToast(onApply: () => void) {
  if (document.getElementById('sw-update-toast')) return

  const toast = document.createElement('div')
  toast.id = 'sw-update-toast'
  toast.style.cssText = [
    'position:fixed',
    'bottom:20px',
    'left:50%',
    'transform:translateX(-50%)',
    'background:#1e293b',
    'color:#f8fafc',
    'padding:12px 16px',
    'border-radius:10px',
    'box-shadow:0 12px 32px rgba(15,23,42,0.35)',
    'display:flex',
    'align-items:center',
    'gap:12px',
    'z-index:2147483647',
    'font-size:14px',
    'font-family:system-ui,-apple-system,"Segoe UI",sans-serif',
    'max-width:calc(100vw - 32px)'
  ].join(';')

  const text = document.createElement('span')
  text.textContent = '🔄 有新版本可使用'
  toast.appendChild(text)

  const updateBtn = document.createElement('button')
  updateBtn.type = 'button'
  updateBtn.textContent = '立即更新'
  updateBtn.style.cssText = [
    'background:#38bdf8',
    'color:#0c4a6e',
    'border:none',
    'padding:6px 14px',
    'border-radius:6px',
    'font-weight:600',
    'font-size:13px',
    'cursor:pointer'
  ].join(';')
  updateBtn.addEventListener('click', () => {
    updateBtn.disabled = true
    updateBtn.textContent = '更新中…'
    onApply()
    // updateSW(true) 內部靠 `controllerchange` 事件決定何時 reload；當新 SW
    // 已 active 或沒有現任 controller 時這個事件不會觸發、會卡死在「更新中…」。
    // 1.5s 後不管如何強制 reload 當保險絲（reload 後此 timer 隨頁面消失、無副作用）。
    setTimeout(() => {
      window.location.reload()
    }, 1500)
  })
  toast.appendChild(updateBtn)

  const dismissBtn = document.createElement('button')
  dismissBtn.type = 'button'
  dismissBtn.setAttribute('aria-label', '稍後再說')
  dismissBtn.textContent = '稍後'
  dismissBtn.style.cssText = [
    'background:transparent',
    'color:#cbd5e1',
    'border:none',
    'padding:6px 6px',
    'cursor:pointer',
    'font-size:13px'
  ].join(';')
  dismissBtn.addEventListener('click', () => {
    toast.remove()
  })
  toast.appendChild(dismissBtn)

  document.body.appendChild(toast)
}

if (import.meta.env.PROD) {
  // 正式環境才註冊 Service Worker，避免開發環境被舊快取干擾
  // 2026-09-13：老師桌面捷徑（PWA）開起來停在很舊的版本——新版 SW 早就下載好在 waiting，
  //   但 skipWaiting:false 要等老師按 toast 或把所有 RedPen 視窗全關才會接管；視窗長期不關
  //   （筆電只休眠）就永遠停在舊版。修法：**剛開啟的頭幾秒**發現有新版＝什麼都還沒開始做，
  //   直接套用（一次 reload、無感）；只有「使用中途」才走 toast 問，保留原本不打斷批改的原則。
  const AUTO_APPLY_WINDOW_MS = 10_000
  const updateSW = registerSW({
    onNeedRefresh() {
      // 防迴圈：新 SW 若接管失敗，reload 後又會在頭幾秒再觸發 → 同一分頁只自動套用一次，之後改問
      let autoTried = false
      try { autoTried = sessionStorage.getItem('rp-sw-autoapply') === '1' } catch { /* 無 storage */ }
      if (performance.now() < AUTO_APPLY_WINDOW_MS && !autoTried) {
        try { sessionStorage.setItem('rp-sw-autoapply', '1') } catch { /* 無 storage */ }
        void updateSW(true)
        // updateSW(true) 靠 controllerchange 觸發 reload；保險絲同「立即更新」按鈕
        setTimeout(() => { window.location.reload() }, 1500)
        return
      }
      // SW 設成 skipWaiting:false、不會自動接管現有 tab；改用 toast 提示老師
      // 主動點「立即更新」才會 skipWaiting + reload，避免批改中突然被刷掉
      showUpdateToast(() => {
        void updateSW(true)
      })
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
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </BrowserRouter>
  </StrictMode>,
)
