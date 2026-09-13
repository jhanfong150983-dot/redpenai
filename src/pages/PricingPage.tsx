// 定價頁（公開頁 /pricing）。
// 2026-09-13 user 拍板重做：廢除題型試算器、改「校園版三級・每份計價」（Basic 5／PRO 4.5／PROMAX 4 元，起購量分級）。
//   原則：批改相關功能全級別開放（含會考級分模式、作圖判分），只有不影響批改的額外功能分 PRO／PROMAX。
//   個人版（月訂閱 299/599/999）金流未接、暫不上；教師版數字見 2026-09-13 對話紀錄。
//   「聯絡我們」＝開 modal 顯示 LINE 官方帳號（不接表單）。
//   設計沿用 LandingPage 單色系統（白底＋gray-900），只有折扣標籤用品牌紅。
import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { buildApiUrl } from '../lib/api-base'
import { SUPPORT_EMAIL, LINE_OA_URL } from '../lib/legal'

const LOGIN_ENTRY_STORAGE_KEY = 'redpen-login-entry'
const LOGIN_URL = buildApiUrl('/api/auth/google?entry=teacher')

const PAGE_TITLE = 'RedPen AI 定價 — 用多少花多少'
const PAGE_DESC = '校園版每份 5 元起，買幾份學校自己決定。AI 批改全科目全題型，檢討單、成績統計、試題分析全部包含。'

function usePageMeta(): void {
  useEffect(() => {
    const prevTitle = document.title
    const metaEl = document.querySelector('meta[name="description"]')
    const prevDesc = metaEl?.getAttribute('content') ?? null
    document.title = PAGE_TITLE
    metaEl?.setAttribute('content', PAGE_DESC)
    return () => {
      document.title = prevTitle
      if (prevDesc !== null) metaEl?.setAttribute('content', prevDesc)
    }
  }, [])
}

// ── 校園版三級（2026-09-13 定案；成本 3 元/份、最薄 PROMAX 毛利 25%）───────────
type Tier = {
  name: string
  tagline: string
  from: string
  price: string
  listPrice?: string
  discount?: string
  inclFrom?: string
  features: string[]
  primary: boolean
}
const TIERS: Tier[] = [
  {
    name: 'Basic', tagline: '全校段考交給 AI', from: '2,000 份起（NT$1 萬）', price: '5', primary: false,
    features: ['AI 批改，全科目、全題型', '會考級分模式、作圖題判分，全部包含', '學生檢討單、成績統計、試題分析', '份數全校共用，行政端分配'],
  },
  {
    name: 'PRO', tagline: '從批改到家長溝通', from: '8,000 份起（NT$3.6 萬）', price: '4.5', listPrice: '5', discount: '9 折', inclFrom: 'Basic', primary: true,
    features: ['家長報告，學校統一設定內容', '檢討模式、樣態分析、概念雷達', '行政端統一批改、跨班校級報表', '一次到校導入'],
  },
  {
    name: 'PROMAX', tagline: '週考小考也能用', from: '20,000 份起（NT$8 萬）', price: '4', listPrice: '5', discount: '8 折', inclFrom: 'PRO', primary: true,
    features: ['學生訂正與自助批改', '家長推播（1Campus）', '每學期到校、優先支援'],
  },
]

export default function PricingPage() {
  usePageMeta()
  const [loginLoading, setLoginLoading] = useState(false)
  const [contactOpen, setContactOpen] = useState(false)

  useEffect(() => {
    if (!contactOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setContactOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [contactOpen])

  const handleLogin = () => {
    if (typeof window === 'undefined') return
    setLoginLoading(true)
    window.localStorage.setItem(LOGIN_ENTRY_STORAGE_KEY, 'teacher')
    setTimeout(() => { window.location.href = LOGIN_URL }, 100)
  }

  return (
    <div className="min-h-screen bg-white">
      {/* Navbar（鏡像 LandingPage 精簡版） */}
      <nav className="fixed top-0 left-0 right-0 z-50 border-b border-gray-100 bg-white/95 backdrop-blur-sm">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-7 px-4 sm:px-6 lg:px-8">
          <a href="/" className="flex items-center gap-2 font-bold text-gray-900">RedPen AI</a>
          <div className="hidden gap-6 text-sm text-gray-500 sm:flex">
            <a href="/" className="transition-colors hover:text-gray-900">首頁</a>
            <a href="/tutorials" className="transition-colors hover:text-gray-900">教學中心</a>
            <a href="/school" className="transition-colors hover:text-gray-900">學校方案</a>
            <span className="font-semibold text-gray-900">定價</span>
          </div>
          <button onClick={handleLogin} disabled={loginLoading}
            className="ml-auto rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-gray-700 disabled:opacity-60">
            {loginLoading ? '前往登入…' : '老師登入'}
          </button>
        </div>
      </nav>

      <main className="mx-auto max-w-6xl px-4 pb-24 pt-32 text-center sm:px-6 lg:px-8">
        <div className="text-sm text-gray-500">RedPen AI</div>
        <h1 className="mt-2 text-5xl font-black tracking-tight text-gray-900 sm:text-6xl">定價</h1>
        <p className="mt-4 text-lg text-gray-500">用多少花多少</p>

        <div className="mx-auto mt-12 grid max-w-5xl gap-4 text-left md:grid-cols-3">
          {TIERS.map((t) => (
            <div key={t.name} className="relative flex flex-col rounded-2xl border border-gray-200 bg-white p-7">
              {t.discount && (
                <span className="absolute -top-3 left-7 rounded-full bg-red-600 px-3 py-1 text-xs font-bold text-white">{t.discount}</span>
              )}
              <h2 className="text-3xl font-black tracking-tight text-gray-900">{t.name}</h2>
              <p className="mt-1 text-gray-700">{t.tagline}</p>
              <div className="mt-8 text-xs text-gray-500">{t.from}</div>
              <div className="mt-1 flex items-baseline text-4xl font-black tabular-nums tracking-tight text-gray-900">
                {t.listPrice && <s className="mr-2 text-xl font-medium text-gray-400">${t.listPrice}</s>}
                ${t.price}
                <span className="ml-1.5 text-sm font-medium text-gray-500">／每份</span>
              </div>
              <button type="button" onClick={() => setContactOpen(true)}
                className={`mt-6 rounded-full py-3.5 text-sm font-bold transition-colors ${t.primary ? 'bg-gray-900 text-white hover:bg-gray-700' : 'border border-gray-900 text-gray-900 hover:bg-gray-50'}`}>
                聯絡我們 ›
              </button>
              {t.inclFrom ? (
                <div className="mt-7 flex items-center gap-2 border-b border-gray-200 pb-3.5 text-sm font-bold text-gray-900">
                  <span className="text-xs text-red-600">✦</span>{t.inclFrom} 的所有功能，再加上：
                </div>
              ) : <div className="mt-7" />}
              <ul className="mt-3.5 space-y-3 text-sm text-gray-700">
                {t.features.map((f) => (
                  <li key={f} className="flex items-start gap-3"><span className="font-bold text-gray-900">✓</span>{f}</li>
                ))}
              </ul>
              <div className="mt-auto pt-6 text-xs text-gray-400">用完隨時加購，同價</div>
            </div>
          ))}
        </div>
      </main>

      {/* 聯絡我們：LINE 官方帳號（z-index 沿用彈窗慣例 ≥ z-[120]） */}
      {contactOpen && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-gray-900/45 p-6" onClick={() => setContactOpen(false)}>
          <div role="dialog" aria-modal="true" aria-labelledby="contact-title"
            className="relative w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <button type="button" aria-label="關閉" onClick={() => setContactOpen(false)}
              className="absolute right-3 top-3 rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"><X className="h-5 w-5" /></button>
            <h3 id="contact-title" className="text-2xl font-black text-gray-900">聯絡我們</h3>
            <p className="mt-2 text-sm text-gray-500">加入 LINE 官方帳號，直接跟我們談報價與導入。手機點按鈕，電腦掃 QR。</p>
            <img src="/site/line-qr.png" alt="RedPen AI LINE 官方帳號 QR Code" className="mx-auto mt-5 h-44 w-44 rounded-xl border border-gray-100" />
            <a href={LINE_OA_URL} target="_blank" rel="noreferrer"
              className="mt-5 inline-flex items-center justify-center rounded-full px-7 py-3 font-bold text-white transition-opacity hover:opacity-90"
              style={{ backgroundColor: '#06C755' }}>
              加入 LINE 好友
            </a>
            <p className="mt-4 text-xs text-gray-400">或來信 {SUPPORT_EMAIL}</p>
          </div>
        </div>
      )}

      <footer className="border-t border-gray-100 py-10 text-center text-sm text-gray-400">
        © {new Date().getFullYear()} RedPen AI・<a href="/" className="hover:text-gray-600">回首頁</a>
      </footer>
    </div>
  )
}
