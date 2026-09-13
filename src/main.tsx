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
    // reload 時機由 applyUpdate 依新 SW 的 state 決定（2026-09-13 修：固定 1.5s 會搶在接管前 reload）
    onApply()
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
  let swRegistration: ServiceWorkerRegistration | undefined
  // 2026-09-13 修「按了立即更新還是舊版、還不如 F5」（本機 Chrome 重現）：舊版按下去送 SKIP_WAITING 後
  //   固定 1.5s 就 reload；新 SW 冷啟動＋activate（清 84 筆舊快取）在慢一點的機器超過 1.5s，
  //   reload 便由「還是舊的」active SW 服務 → 舊 index.html → 舊版；等新 SW 接管完成時 waiting 已空、
  //   toast 也不再出現，老師只好 F5（這時才是新版）。改成：盯著新 SW 的 state，到 activated 才 reload；
  //   20s 保險絲防卡死。clientsClaim:false 所以 controllerchange 不會來，不能依賴它。
  const applyUpdate = async () => {
    // 頁面載入時就已有 waiting SW 的情況，'waiting' 事件會早於 onRegisteredSW 一個 microtask → 補抓 registration
    let reg = swRegistration
    if (!reg) { try { reg = await navigator.serviceWorker.getRegistration() } catch { /* 無 SW */ } }
    const target = reg?.waiting ?? reg?.installing ?? null
    void updateSW(true) // 送 SKIP_WAITING（vite-plugin-pwa 的 reload 靠 controllerchange、此處不會觸發）
    let done = false
    const reload = () => { if (done) return; done = true; window.location.reload() }
    if (!target) { setTimeout(reload, 800); return }
    const check = () => { if (target.state === 'activated' || target.state === 'redundant') reload() }
    target.addEventListener('statechange', check)
    check()
    setTimeout(reload, 20_000)
  }
  const updateSW = registerSW({
    onNeedRefresh() {
      // 防迴圈：新 SW 若接管失敗，reload 後又會在頭幾秒再觸發 → 同一分頁只自動套用一次，之後改問
      let autoTried = false
      try { autoTried = sessionStorage.getItem('rp-sw-autoapply') === '1' } catch { /* 無 storage */ }
      if (performance.now() < AUTO_APPLY_WINDOW_MS && !autoTried) {
        try { sessionStorage.setItem('rp-sw-autoapply', '1') } catch { /* 無 storage */ }
        void applyUpdate()
        return
      }
      // SW 設成 skipWaiting:false、不會自動接管現有 tab；改用 toast 提示老師
      // 主動點「立即更新」才會 skipWaiting + reload，避免批改中突然被刷掉
      showUpdateToast(() => { void applyUpdate() })
    },
    onRegisteredSW(_url, registration) {
      swRegistration = registration
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
