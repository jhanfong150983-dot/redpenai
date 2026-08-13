// 學校方案（公開頁 /school）：讀者＝教務處、領域召集人、校長。
// 與首頁的差別：說的是「全校統一批改」與採購流程，主要 CTA 是預約說明會而不是免費試用。
// 學生端尚未成熟 → 本頁不宣傳學生功能。
import { useEffect, useState } from 'react'
import {
  ArrowRight, CheckCircle2, Mail, Phone, Users, ScanLine, ShieldCheck,
  LineChart, FileText, Scale
} from 'lucide-react'
import { SUPPORT_EMAIL, SUPPORT_PHONE } from '../lib/legal'
import { buildApiUrl } from '../lib/api-base'

const LOGIN_URL = buildApiUrl('/api/auth/google?entry=teacher')
const PAGE_TITLE = 'RedPen AI 學校方案 — 全校一次段考，統一批改'
const PAGE_DESC = '學校統一批改紙本段考卷：跨班同一套判準、行政端集中送批、1Campus 名冊同步，並批次產出檢討單與家長報告。以學期或學年約計價，學校統一付費。'

const MEET_URL = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('預約 RedPen AI 校內導入說明會')}&body=${encodeURIComponent('學校名稱：\n聯絡人／職稱：\n聯絡電話：\n預計試辦領域與班級數：\n希望說明會時間：')}`

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

/** 學校為什麼要「統一批改」而不是讓老師各自來 */
const WHY = [
  {
    icon: Scale,
    t: '跨班可比較，才談得上公平',
    d: '同一份答案卷、同一套判準，全校用同一個標準批。多個班級可以合併成一個母體重算試題分析——不然「各班平均差 5 分」你無法判斷是學生差異還是改法差異。'
  },
  {
    icon: ScanLine,
    t: '流程集中，老師不必各自摸索',
    d: '行政端建立全校考卷、逐班匯入、集中送批；老師端唯讀看自己班的結果並做最後確認。不需要每位老師都學一整套操作。'
  },
  {
    icon: ShieldCheck,
    t: '名冊不必重建',
    d: '1Campus 學校的班級與學生名冊直接同步，老師登入即自動歸戶到學校，不需要人工建班或對名單。'
  },
  {
    icon: LineChart,
    t: '報表一次到位',
    d: '檢討單、試題分析、概念雷達、家長報告都能整班整校批次產出，含逐題作答影像。'
  }
]

/** 導入流程：先試辦一輪再擴大 */
const STEPS = [
  { n: '01', t: '說明會與試辦範圍', d: '我們到校說明一次（約 40 分鐘），一起挑一個領域、一次段考當試辦。' },
  { n: '02', t: '建立答案卷', d: '出題老師把答案卷上傳、AI 解析題目與配分，我們協助確認。分享碼一貼，全校共用同一份標準。' },
  { n: '03', t: '收卷與匯入', d: '各班按座號收卷、事務機掃描成 PDF，行政端逐班批次匯入。每班一份 PDF、班內依座號是唯一的操作規範。' },
  { n: '04', t: '集中送批與確認', d: '行政端一次送批，系統標記 AI 沒把握的格子；任課老師檢視自己班的結果並確認。' },
  { n: '05', t: '產出與檢討', d: '檢討單發給學生逐題核對，領域會議看試題分析與概念雷達，家長報告依需要批次產出。' },
  { n: '06', t: '決定要不要擴大', d: '跑完一輪再評估。這一輪的資料與報表都留在系統裡，不會因為沒續約而消失。' }
]

const INCLUDED = [
  '全校答案卷建置與分享（不計點）',
  '檢討單、試題分析、概念雷達、成績報表（不計點）',
  '行政端統一批改與逐班匯入',
  '1Campus 班級與名冊同步',
  '教師端唯讀檢視自己班級的批改結果',
  '導入期教育訓練與操作規範文件'
]

const FAQ = [
  {
    q: '老師會不會覺得被行政監控？',
    a: '權限是分開的：行政端負責建立考卷、匯入與送批，任課老師看得到自己班的結果並做最後確認與改分。老師端對學校考卷是唯讀加改分紀錄，不會被拿去做教師評鑑用途——這點建議在校內說明會就講清楚。'
  },
  {
    q: '如果 AI 改錯，責任怎麼算？',
    a: '系統的假設就是 AI 會錯，因此把關設計在流程裡：低信心的格子會標記並集中檢視、檢討單讓學生逐題核對、老師改分留有紀錄且可回復 AI 原判。最終成績以老師確認為準。'
  },
  {
    q: '要花多少錢？誰付？',
    a: '以學期約或學年約計價、由學校統一付費，老師不需自費。費用按批改的考卷規模計算（標準段考卷約 NT$15/份），分析與報表全部包含。實際報價依領域數與班級數估算，說明會時提供。'
  },
  {
    q: '非 1Campus 的學校可以用嗎？',
    a: '可以，但名冊同步與自動歸戶是 1Campus 學校專屬。非 1Campus 學校目前建議以老師個人帳號使用，或與我們討論其他匯入方式。'
  },
  {
    q: '資料保存與隱私？',
    a: '學生作答影像與成績存放在雲端資料庫，僅該班老師與學校指定的行政人員可存取。家長報告每位學生獨立產出。若需要資料處理協議或校內資安審查文件，說明會時可提供。'
  }
]

export default function SchoolPlanPage() {
  usePageMeta()
  const [openFaq, setOpenFaq] = useState(0)

  return (
    <div className="min-h-screen bg-white">
      <nav className="fixed inset-x-0 top-0 z-50 border-b border-gray-100 bg-white/95 backdrop-blur-sm">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-7 px-4 sm:px-6 lg:px-8">
          <a href="/" className="flex items-center gap-2">
            <img src="/logo.png" alt="RedPen AI" className="h-8 w-8" />
            <span className="text-xl font-bold text-gray-900">RedPen AI</span>
          </a>
          <div className="hidden items-center gap-6 text-sm font-medium text-gray-500 md:flex">
            <a href="/" className="transition-colors hover:text-gray-900">給老師</a>
            <a href="/tutorials" className="transition-colors hover:text-gray-900">教學影片</a>
            <span className="font-semibold text-gray-900">學校方案</span>
          </div>
          <a
            href={MEET_URL}
            className="ml-auto rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-gray-700"
          >
            預約說明會
          </a>
        </div>
      </nav>

      {/* Hero */}
      <header className="bg-white pt-28 sm:pt-36">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="grid items-center gap-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-gray-400">學校方案</p>
              <h1 className="mt-3 text-4xl font-bold leading-[1.24] tracking-tight text-gray-900 sm:text-5xl">
                全校一次段考，
                <br />
                統一批改
              </h1>
              <p className="mt-6 text-lg leading-relaxed text-gray-500 sm:text-xl">
                同一份答案卷、同一套判準，全校用同一個標準批完。行政端集中送批，
                老師只需確認自己班的結果；檢討單與家長報告整校批次產出。
              </p>
              <div className="mt-9 flex flex-col gap-4 sm:flex-row">
                <a
                  href={MEET_URL}
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-gray-900 px-7 py-4 text-lg font-semibold text-white transition-colors hover:bg-gray-700"
                >
                  預約校內導入說明會<ArrowRight className="h-5 w-5" />
                </a>
                <a
                  href="/tutorials"
                  className="inline-flex items-center justify-center gap-2 rounded-xl border-2 border-gray-200 bg-white px-7 py-4 text-lg font-semibold text-gray-700 transition-colors hover:border-gray-300 hover:bg-gray-50"
                >
                  先看系統怎麼運作
                </a>
              </div>
              <p className="mt-4 text-sm text-gray-400">
                建議先用一個領域、一次段考試辦，跑完一輪再決定是否擴大。
              </p>
            </div>
            <div className="overflow-hidden rounded-2xl border border-gray-100 shadow-xl">
              <img src="/site/items.jpg" alt="全校試題分析：難易度、鑑別度與答案分布" className="h-auto w-full" />
            </div>
          </div>
        </div>
      </header>

      {/* 為什麼統一批改 */}
      <section className="bg-white py-16 sm:py-24">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl">
            <h2 className="text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">
              為什麼要學校統一批改
            </h2>
            <p className="mt-4 text-lg text-gray-500">
              老師各自批改也能用。但有兩件事，只有全校一起做才成立。
            </p>
          </div>
          <div className="mt-10 grid gap-5 sm:grid-cols-2">
            {WHY.map((w) => (
              <div key={w.t} className="rounded-2xl border border-gray-100 bg-gray-50 p-6">
                <w.icon className="h-6 w-6 text-gray-900" />
                <h3 className="mt-4 text-lg font-bold text-gray-900">{w.t}</h3>
                <p className="mt-2 leading-relaxed text-gray-500">{w.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 導入流程 */}
      <section className="border-y border-gray-100 bg-gray-50 py-16 sm:py-24">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl">
            <h2 className="text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">導入流程</h2>
            <p className="mt-4 text-lg text-gray-500">一次段考走完六步，全部在同一個學期內完成。</p>
          </div>
          <ol className="mt-10 grid list-none gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3">
            {STEPS.map((s) => (
              <li key={s.n} className="rounded-2xl border border-gray-100 bg-white p-6">
                <span className="font-mono text-sm font-bold tracking-widest text-gray-300">{s.n}</span>
                <h3 className="mt-2 text-lg font-bold text-gray-900">{s.t}</h3>
                <p className="mt-2 text-[15px] leading-relaxed text-gray-500">{s.d}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* 方案包含 + 報價 */}
      <section className="bg-white py-16 sm:py-24">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="grid items-start gap-12 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-16">
            <div>
              <h2 className="text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">方案包含什麼</h2>
              <p className="mt-4 text-lg text-gray-500">
                分析與報表不分方案，全部包含。只有 AI 批改本身按考卷規模計算。
              </p>
              <ul className="mt-8 space-y-3">
                {INCLUDED.map((i) => (
                  <li key={i} className="flex items-start gap-3">
                    <CheckCircle2 className="mt-0.5 h-5 w-5 flex-shrink-0 text-gray-900" />
                    <span className="text-gray-600">{i}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="grid gap-4">
              <div className="rounded-2xl bg-gray-900 p-7">
                <div className="flex items-center gap-2">
                  <FileText className="h-5 w-5 text-gray-400" />
                  <h3 className="font-bold text-white">計價方式</h3>
                </div>
                <p className="mt-4 text-3xl font-bold tracking-tight text-white">學期約 / 學年約</p>
                <p className="mt-3 leading-relaxed text-gray-400">
                  按批改的考卷規模計算，標準段考卷（40–60 題）約 NT$15/份；
                  分析、檢討單、成績報表全含。實際報價依領域數與班級數估算。
                </p>
                <p className="mt-4 border-t border-white/10 pt-4 text-sm text-gray-500">
                  由學校統一付費，老師不需自費。量大另有折扣。
                </p>
              </div>
              <div className="rounded-2xl border border-gray-200 p-7">
                <div className="flex items-center gap-2">
                  <Users className="h-5 w-5 text-gray-900" />
                  <h3 className="font-bold text-gray-900">先談一次，再決定</h3>
                </div>
                <p className="mt-3 leading-relaxed text-gray-500">
                  說明會約 40 分鐘，我們會用你們學校自己的一份考卷示範完整流程，並給出試辦估價。
                </p>
                <a
                  href={MEET_URL}
                  className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gray-900 py-3.5 font-semibold text-white transition-colors hover:bg-gray-700"
                >
                  預約說明會<ArrowRight className="h-4 w-4" />
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="border-t border-gray-100 bg-gray-50 py-16 sm:py-24">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
          <h2 className="text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">學校最常問的問題</h2>
          <div className="mt-8 border-t border-gray-200">
            {FAQ.map((f, i) => (
              <div key={f.q} className="border-b border-gray-200">
                <button
                  type="button"
                  onClick={() => setOpenFaq(openFaq === i ? -1 : i)}
                  aria-expanded={openFaq === i}
                  className="flex w-full items-center gap-4 py-5 text-left"
                >
                  <span className="flex-1 text-lg font-semibold text-gray-900">{f.q}</span>
                  <span className="font-mono text-gray-400">{openFaq === i ? '－' : '＋'}</span>
                </button>
                {openFaq === i && <p className="mb-5 leading-relaxed text-gray-500">{f.a}</p>}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="bg-white py-20 sm:py-28">
        <div className="mx-auto max-w-3xl px-4 text-center sm:px-6 lg:px-8">
          <h2 className="text-4xl font-bold tracking-tight text-gray-900 sm:text-5xl">
            下一次段考，就可以試辦
          </h2>
          <p className="mt-5 text-xl text-gray-500">一個領域、一次考試。跑完一輪再決定。</p>
          <div className="mt-9 flex flex-col justify-center gap-4 sm:flex-row">
            <a
              href={MEET_URL}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-gray-900 px-8 py-4 text-lg font-semibold text-white transition-colors hover:bg-gray-700"
            >
              預約校內說明會<ArrowRight className="h-5 w-5" />
            </a>
            <a
              href={LOGIN_URL}
              className="inline-flex items-center justify-center gap-2 rounded-xl border-2 border-gray-200 bg-white px-8 py-4 text-lg font-semibold text-gray-700 transition-colors hover:border-gray-300"
            >
              我是老師，想先自己試
            </a>
          </div>
        </div>
      </section>

      <footer className="bg-gray-950 py-12">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-start justify-between gap-8">
            <div>
              <div className="flex items-center gap-2">
                <img src="/logo.png" alt="RedPen AI" className="h-8 w-8" />
                <span className="text-xl font-bold text-white">RedPen AI</span>
              </div>
              <p className="mt-4 max-w-sm text-sm leading-relaxed text-gray-500">
                批改有品質，時間有價值。RedPen AI，重新定義評量。
              </p>
            </div>
            <ul className="space-y-2">
              <li className="flex items-center gap-2 text-sm text-gray-500">
                <Mail className="h-4 w-4" />
                <a href={`mailto:${SUPPORT_EMAIL}`} className="transition-colors hover:text-white">{SUPPORT_EMAIL}</a>
              </li>
              <li className="flex items-center gap-2 text-sm text-gray-500">
                <Phone className="h-4 w-4" />
                <a href={`tel:${SUPPORT_PHONE.replace(/-/g, '')}`} className="transition-colors hover:text-white">{SUPPORT_PHONE}</a>
              </li>
              <li><a href="/" className="text-sm text-gray-500 transition-colors hover:text-white">給老師的說明</a></li>
              <li><a href="/tutorials" className="text-sm text-gray-500 transition-colors hover:text-white">教學影片</a></li>
            </ul>
          </div>
          <div className="mt-12 border-t border-gray-800 pt-8 text-center">
            <p className="text-sm text-gray-600">Copyright © 2026 黃政昱. All Rights Reserved.</p>
          </div>
        </div>
      </footer>
    </div>
  )
}
