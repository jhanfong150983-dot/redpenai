// 定價頁（公開頁 /pricing）。
// 2026-09-18 user 拍板：砍掉會員／方案等級，功能全部開放；兩版都只賣「份數」。
//   校園版＝三個份數專案（2,000／8,000／20,000 份 → 每份 5／4.5／4 元）、中途補充每份 5 元、份數永不過期。
//   個人版＝每份 5 元、三個禮包送份數（300／600／1,000 份 → 送 15／60／150）、註冊送 10 份、永不過期。
//   舊的 Basic／PRO／PROMAX 三級（2026-09-13）作廢。
//   「聯絡我們」＝開 modal 顯示 LINE 官方帳號（不接表單）。
//   設計沿用 LandingPage 單色系統（白底＋gray-900），只有折扣／贈送標籤用品牌紅。
import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import PublicNav from '../components/PublicNav'
import PublicFooter from '../components/PublicFooter'
import { SUPPORT_EMAIL, LINE_OA_URL } from '../lib/legal'

const PAGE_TITLE = 'RedPen AI 定價 — 用多少花多少'
const PAGE_DESC = '功能全部開放，每份 5 元起、買越多越便宜、份數永不過期。學校一年買一次份數專案，老師個人隨時加購。'

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

// ── 校園版：份數專案（單價隨專案降；補充一律 5 元）───────────────────────────
type SchoolPack = { units: string; total: string; price: string; listPrice?: string; discount?: string; note: string; primary: boolean }
const SCHOOL_PACKS: SchoolPack[] = [
  { units: '2,000 份', total: 'NT$10,000', price: '5', note: '適合一個年級一學期的段考', primary: false },
  { units: '8,000 份', total: 'NT$36,000', price: '4.5', listPrice: '5', discount: '9 折', note: '適合全校一學年的段考', primary: true },
  { units: '20,000 份', total: 'NT$80,000', price: '4', listPrice: '5', discount: '8 折', note: '段考、週考、小考都交給 AI', primary: true },
]

// ── 個人版：每份 5 元；禮包送份數 ─────────────────────────────────────────────
type PersonalPack = { units: string; total: string; bonus?: string; perUnit: string; note: string }
const PERSONAL_PACKS: PersonalPack[] = [
  { units: '自訂份數', total: '每份 NT$5', perUnit: '5', note: '要幾份買幾份' },
  { units: '300 份', total: 'NT$1,500', bonus: '送 15 份', perUnit: '4.76', note: '一個班一學期' },
  { units: '600 份', total: 'NT$3,000', bonus: '送 60 份', perUnit: '4.55', note: '兩三個班一學期' },
  { units: '1,000 份', total: 'NT$5,000', bonus: '送 150 份', perUnit: '4.35', note: '整學年一次買足' },
]

// ── 功能：全部包含，不分等級 ───────────────────────────────────────────────
const FEATURES: string[] = [
  'AI 批改，全科目、全題型',
  '會考級分模式、作圖題判分',
  '學生檢討單、原卷註記版',
  '成績統計、試題分析、樣態分析',
  '概念雷達、學習追蹤',
  '檢討模式（投影全螢幕）',
  '家長報告',
  '行政端統一批改、跨班校級報表',
  '家長推播（需 1Campus）',
]

export default function PricingPage() {
  usePageMeta()
  const [contactOpen, setContactOpen] = useState(false)

  useEffect(() => {
    if (!contactOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setContactOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [contactOpen])

  return (
    <div className="min-h-screen bg-white">
      <PublicNav active="pricing" />

      <main className="mx-auto max-w-6xl px-4 pb-24 pt-32 text-center sm:px-6 lg:px-8">
        <div className="text-sm text-gray-500">RedPen AI</div>
        <h1 className="mt-2 text-5xl font-black tracking-tight text-gray-900 sm:text-6xl">定價</h1>
        <p className="mt-4 text-lg text-gray-500">用多少花多少</p>
        <p className="mx-auto mt-3 max-w-2xl text-sm text-gray-500">
          一份＝一位學生的一份考卷。功能全部開放、不分等級；份數永不過期，買越多越便宜。
        </p>

        {/* ── 校園版 ── */}
        <section className="mt-16 text-left">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-2xl font-black tracking-tight text-gray-900">校園版</h2>
            <p className="text-sm text-gray-500">學校一年買一次份數專案，全校共用、行政端分配。中途不夠，補充每份 NT$5。</p>
          </div>
          <div className="mt-6 grid gap-4 md:grid-cols-3">
            {SCHOOL_PACKS.map((p) => (
              <div key={p.units} className="relative flex flex-col rounded-2xl border border-gray-200 bg-white p-7">
                {p.discount && (
                  <span className="absolute -top-3 left-7 rounded-full bg-red-600 px-3 py-1 text-xs font-bold text-white">{p.discount}</span>
                )}
                <div className="text-3xl font-black tracking-tight text-gray-900">{p.units}</div>
                <p className="mt-1 text-gray-700">{p.note}</p>
                <div className="mt-8 text-xs text-gray-500">{p.total}</div>
                <div className="mt-1 flex items-baseline text-4xl font-black tabular-nums tracking-tight text-gray-900">
                  {p.listPrice && <s className="mr-2 text-xl font-medium text-gray-400">${p.listPrice}</s>}
                  ${p.price}
                  <span className="ml-1.5 text-sm font-medium text-gray-500">／每份</span>
                </div>
                <button type="button" onClick={() => setContactOpen(true)}
                  className={`mt-6 rounded-full py-3.5 text-sm font-bold transition-colors ${p.primary ? 'bg-gray-900 text-white hover:bg-gray-700' : 'border border-gray-900 text-gray-900 hover:bg-gray-50'}`}>
                  聯絡我們 ›
                </button>
                <div className="mt-auto pt-6 text-xs text-gray-400">份數永不過期・補充每份 NT$5</div>
              </div>
            ))}
          </div>
        </section>

        {/* ── 個人版 ── */}
        <section className="mt-16 text-left">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-2xl font-black tracking-tight text-gray-900">個人版</h2>
            <p className="text-sm text-gray-500">老師自己用。登入後隨時加購，註冊即送 10 份。</p>
          </div>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {PERSONAL_PACKS.map((p) => (
              <div key={p.units} className="relative flex flex-col rounded-2xl border border-gray-200 bg-white p-6">
                {p.bonus && (
                  <span className="absolute -top-3 left-6 rounded-full bg-red-600 px-3 py-1 text-xs font-bold text-white">{p.bonus}</span>
                )}
                <div className="text-2xl font-black tracking-tight text-gray-900">{p.units}</div>
                <p className="mt-1 text-sm text-gray-700">{p.note}</p>
                <div className="mt-6 text-2xl font-black tabular-nums tracking-tight text-gray-900">{p.total}</div>
                <div className="mt-1 text-xs text-gray-500">相當於每份 NT${p.perUnit}</div>
                <div className="mt-auto pt-6 text-xs text-gray-400">份數永不過期</div>
              </div>
            ))}
          </div>
          <div className="mt-6 text-center">
            <a href="/" className="inline-flex items-center justify-center rounded-full bg-gray-900 px-7 py-3.5 text-sm font-bold text-white transition-colors hover:bg-gray-700">
              登入加購 ›
            </a>
          </div>
        </section>

        {/* ── 功能全開 ── */}
        <section className="mt-16 rounded-2xl border border-gray-200 bg-gray-50 p-8 text-left">
          <h2 className="text-2xl font-black tracking-tight text-gray-900">功能全部包含</h2>
          <p className="mt-1 text-sm text-gray-500">校園版與個人版都一樣，沒有等級、沒有解鎖。</p>
          <ul className="mt-6 grid gap-x-8 gap-y-3 text-sm text-gray-700 sm:grid-cols-2">
            {FEATURES.map((f) => (
              <li key={f} className="flex items-start gap-3"><span className="font-bold text-gray-900">✓</span>{f}</li>
            ))}
          </ul>
        </section>
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

      <PublicFooter />
    </div>
  )
}
