// 定價頁（公開頁 /pricing）：菜單式試算器。
// 2026-08-27 user 拍板：廢除題數級距，改「按考卷內容計價」——模式＋頁數＋題型組成 → 即時預估牌價。
// 左欄＝選配（模式/頁數/人數/題型數量），右欄＝逐項明細＋每份/每班/每年預估。
// 牌價常數＝8 月 production 逐 token 實測成本 × 2.25（維運加成 1.5 × 毛利 1.5）——
//   調整倍率時整組重算，勿只改單一項（見 docs 報價單）。菜單價為承諾價：實際 token 高於菜單由我方吸收。
// 設計原則：沿用 LandingPage 單色系統（白底＋gray-900），互動元件不引入新色。
import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Minus, Plus, FileText, Layers } from 'lucide-react'
import { buildApiUrl } from '../lib/api-base'

const LOGIN_ENTRY_STORAGE_KEY = 'redpen-login-entry'
const LOGIN_URL = buildApiUrl('/api/auth/google?entry=teacher')

const PAGE_TITLE = 'RedPen AI 定價 — 按考卷內容計價，出什麼卷付什麼錢'
const PAGE_DESC = '不分方案、沒有月費。AI 批改按考卷的題型組成計價：選擇題 0.15 元/題起，檢討單、學情分析、成績報表全部包含。用試算器直接估你的考卷。'

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

// ── 牌價常數（NT$；成本×2.25 後取 0.05 階）────────────────────────────────
const UNIT_PRICE = [
  { key: 'choice',  label: '選擇／是非／勾選／配合', hint: '答案是選項代號', price: 0.15 },
  { key: 'fillTxt', label: '填空（文字、英文）',     hint: '答案是詞語或短句', price: 0.2 },
  { key: 'fillMath',label: '填空（數學式）',         hint: '算式、分數、不等式', price: 0.35 },
  { key: 'short',   label: '簡答／問答',             hint: '依評分規準逐項判定', price: 0.3 },
  { key: 'draw',    label: '作圖題',                 hint: 'AI 視覺三重判定', price: 1.6 },
  { key: 'word',    label: '應用題（級分制）',       hint: '會考級分制、逐要素判定', price: 4.5 },
] as const
type UnitKey = typeof UNIT_PRICE[number]['key']

// 每份基本費 = (整卷判分 0.15 + 版面定位建模攤提) × 2.25
//   建模費實測：答案卷模式 ~47/班、原卷作答 ~14.5/頁/班（8 月 production）
const baseFee = (mode: 'ao' | 'wq', pages: number, classSize: number): number => {
  const modelFee = mode === 'ao' ? 47 : 14.5 * pages
  return (0.15 + modelFee / Math.max(1, classSize)) * 2.25
}

const PRESETS: Array<{ label: string; mode: 'ao' | 'wq'; pages: number; counts: Record<UnitKey, number> }> = [
  { label: '數學段考', mode: 'ao', pages: 1, counts: { choice: 0, fillTxt: 0, fillMath: 28, short: 0, draw: 1, word: 2 } },
  { label: '國語段考', mode: 'ao', pages: 2, counts: { choice: 40, fillTxt: 10, fillMath: 0, short: 10, draw: 0, word: 0 } },
  { label: '英語段考', mode: 'wq', pages: 3, counts: { choice: 40, fillTxt: 8, fillMath: 0, short: 0, draw: 0, word: 0 } },
  { label: '社會段考', mode: 'wq', pages: 6, counts: { choice: 31, fillTxt: 1, fillMath: 0, short: 8, draw: 0, word: 0 } },
  { label: '選擇題小考', mode: 'ao', pages: 1, counts: { choice: 25, fillTxt: 0, fillMath: 0, short: 0, draw: 0, word: 0 } },
]

const fmt = (n: number): string => (Math.round(n * 20) / 20).toLocaleString('zh-TW', { maximumFractionDigits: 2 })

function Stepper({ value, onChange, max = 80 }: { value: number; onChange: (v: number) => void; max?: number }) {
  return (
    <div className="flex items-center gap-1">
      <button type="button" aria-label="減少" onClick={() => onChange(Math.max(0, value - 1))}
        className="flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 text-gray-500 transition-colors hover:border-gray-900 hover:text-gray-900">
        <Minus className="h-3.5 w-3.5" />
      </button>
      <input
        type="number" min={0} max={max} value={value}
        onChange={(e) => onChange(Math.min(max, Math.max(0, parseInt(e.target.value, 10) || 0)))}
        className="h-8 w-14 rounded-lg border border-gray-200 text-center font-mono text-sm font-bold tabular-nums text-gray-900 focus:border-gray-900 focus:outline-none"
      />
      <button type="button" aria-label="增加" onClick={() => onChange(Math.min(max, value + 1))}
        className="flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 text-gray-500 transition-colors hover:border-gray-900 hover:text-gray-900">
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

export default function PricingPage() {
  usePageMeta()
  const [mode, setMode] = useState<'ao' | 'wq'>('ao')
  const [pages, setPages] = useState(2)
  const [classSize, setClassSize] = useState(30)
  const [counts, setCounts] = useState<Record<UnitKey, number>>({ choice: 30, fillTxt: 10, fillMath: 0, short: 5, draw: 0, word: 0 })
  const [loginLoading, setLoginLoading] = useState(false)

  const handleLogin = () => {
    if (typeof window === 'undefined') return
    setLoginLoading(true)
    window.localStorage.setItem(LOGIN_ENTRY_STORAGE_KEY, 'teacher')
    setTimeout(() => { window.location.href = LOGIN_URL }, 100)
  }

  const applyPreset = (p: typeof PRESETS[number]) => {
    setMode(p.mode); setPages(p.pages); setCounts({ ...p.counts })
  }

  const calc = useMemo(() => {
    const base = baseFee(mode, pages, classSize)
    const rows = UNIT_PRICE
      .map((u) => ({ ...u, n: counts[u.key], subtotal: counts[u.key] * u.price }))
      .filter((r) => r.n > 0)
    const qTotal = rows.reduce((s, r) => s + r.subtotal, 0)
    const perSheet = base + qTotal
    const totalQ = rows.reduce((s, r) => s + r.n, 0)
    return { base, rows, perSheet, perClass: perSheet * classSize, perYear: perSheet * classSize * 6, totalQ }
  }, [mode, pages, classSize, counts])

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

      <main className="mx-auto max-w-6xl px-4 pb-24 pt-28 sm:px-6 lg:px-8">
        <div className="max-w-2xl">
          <h1 className="text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">按考卷內容計價</h1>
          <p className="mt-4 text-lg leading-relaxed text-gray-500">
            不分方案、沒有月費。AI 批改的花費由你的考卷決定：選擇題幾乎免費，
            應用題、作圖題因為 AI 要做多次判定所以較高——<b className="text-gray-700">怎麼出卷，就怎麼計價</b>。
            檢討單、學情分析、成績報表、家長報告全部包含，不另外收費。
          </p>
        </div>

        {/* 常見卷型快速套用 */}
        <div className="mt-8 flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button key={p.label} type="button" onClick={() => applyPreset(p)}
              className="rounded-full border border-gray-200 px-4 py-1.5 text-sm text-gray-600 transition-colors hover:border-gray-900 hover:text-gray-900">
              {p.label}
            </button>
          ))}
        </div>

        <div className="mt-6 grid items-start gap-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          {/* ── 左：選配 ── */}
          <div className="space-y-6">
            <section className="rounded-2xl border border-gray-200 p-6">
              <h2 className="flex items-center gap-2 font-bold text-gray-900"><Layers className="h-4 w-4" />作答模式</h2>
              <div className="mt-4 grid grid-cols-2 gap-3">
                {([
                  { v: 'ao' as const, t: '答案卷模式', d: '題本與答題卷分開，學生寫在答案卷上' },
                  { v: 'wq' as const, t: '原卷作答', d: '學生直接寫在考卷上' },
                ]).map((o) => (
                  <button key={o.v} type="button" onClick={() => setMode(o.v)}
                    className={`rounded-xl border p-4 text-left transition-colors ${mode === o.v ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-200 text-gray-700 hover:border-gray-400'}`}>
                    <div className="font-semibold">{o.t}</div>
                    <div className={`mt-1 text-xs leading-relaxed ${mode === o.v ? 'text-gray-300' : 'text-gray-400'}`}>{o.d}</div>
                  </button>
                ))}
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-x-8 gap-y-3 text-sm text-gray-600">
                {mode === 'wq' && (
                  <label className="flex items-center gap-3">
                    考卷頁數
                    <Stepper value={pages} onChange={setPages} max={12} />
                  </label>
                )}
                <label className="flex items-center gap-3">
                  班級人數
                  <Stepper value={classSize} onChange={setClassSize} max={60} />
                </label>
              </div>
            </section>

            <section className="rounded-2xl border border-gray-200 p-6">
              <h2 className="flex items-center gap-2 font-bold text-gray-900"><FileText className="h-4 w-4" />題型組成</h2>
              <div className="mt-2 divide-y divide-gray-100">
                {UNIT_PRICE.map((u) => (
                  <div key={u.key} className="flex items-center justify-between gap-4 py-3">
                    <div className="min-w-0">
                      <div className="font-medium text-gray-800">{u.label}</div>
                      <div className="text-xs text-gray-400">{u.hint}・NT$ {fmt(u.price)}/題</div>
                    </div>
                    <Stepper value={counts[u.key]} onChange={(v) => setCounts((c) => ({ ...c, [u.key]: v }))} />
                  </div>
                ))}
              </div>
            </section>
          </div>

          {/* ── 右：預估 ── */}
          <div className="lg:sticky lg:top-24">
            <div className="overflow-hidden rounded-2xl bg-gray-900 text-white">
              <div className="p-7">
                <div className="text-sm text-gray-400">這份考卷（{calc.totalQ} 題）每份預估</div>
                <div className="mt-1 text-5xl font-bold tabular-nums tracking-tight">
                  NT$ {fmt(calc.perSheet)}
                </div>
                <div className="mt-6 space-y-2 border-t border-white/10 pt-5 text-sm">
                  <div className="flex justify-between text-gray-300">
                    <span>每份基本費（卷面定位＋整卷判分）</span>
                    <span className="font-mono tabular-nums">{fmt(calc.base)}</span>
                  </div>
                  {calc.rows.map((r) => (
                    <div key={r.key} className="flex justify-between text-gray-300">
                      <span>{r.label} × {r.n}</span>
                      <span className="font-mono tabular-nums">{fmt(r.subtotal)}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 divide-x divide-white/10 border-t border-white/10 bg-white/5 text-center">
                <div className="p-4">
                  <div className="text-xs text-gray-400">一班（{classSize} 人）</div>
                  <div className="mt-1 font-mono text-xl font-bold tabular-nums">NT$ {Math.round(calc.perClass).toLocaleString()}</div>
                </div>
                <div className="p-4">
                  <div className="text-xs text-gray-400">一年（6 次段考）</div>
                  <div className="mt-1 font-mono text-xl font-bold tabular-nums">NT$ {Math.round(calc.perYear).toLocaleString()}</div>
                </div>
              </div>
            </div>

            <div className="mt-4 rounded-2xl border border-gray-200 p-6 text-sm leading-relaxed text-gray-500">
              <p>・預估價即承諾價：實際 AI 用量高於預估由我們吸收，不追加。</p>
              <p>・批改失敗不扣費；重批照輪計算。</p>
              <p>・檢討單、試題分析、概念雷達、家長報告、成績匯出全部包含。</p>
              <p>・學校學期約／學年約另有折扣，<a href="/#contact" className="font-semibold text-gray-900 underline">預約說明會</a>。</p>
            </div>

            <button onClick={handleLogin} disabled={loginLoading}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-gray-900 py-3.5 font-semibold text-white transition-colors hover:bg-gray-700 disabled:opacity-60">
              免費註冊，用一份真實考卷試跑<ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </main>

      <footer className="border-t border-gray-100 py-10 text-center text-sm text-gray-400">
        © {new Date().getFullYear()} RedPen AI・<a href="/" className="hover:text-gray-600">回首頁</a>
      </footer>
    </div>
  )
}
