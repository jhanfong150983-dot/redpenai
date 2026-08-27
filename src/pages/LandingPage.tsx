// 行銷首頁（2026-08-13 重新設計）
// 敘事＝「一份段考卷的旅程」：考試 → 檢討 → 分析，與產品 IA、教學影片一致。
// user 拍板的三個原則：
//   ① 只放可查證的事實，不用無法佐證的累積數字
//   ② 學校方案獨立成 /school，首頁只放入口區塊
//   ③ 定價公開級距、點價寫「約」（保留 B2B 折扣縱深）
//   ④ 學生端尚未成熟 → 首頁不宣傳學生功能；學生登入僅保留 footer 一個功能性連結
import { useState } from 'react'
import {
  ArrowRight,
  CheckCircle2,
  Mail,
  Phone,
  Play,
  ScanLine,
  ShieldCheck,
  Users,
  LineChart,
  MessageCircle
} from 'lucide-react'
import { SUPPORT_EMAIL, SUPPORT_PHONE, LINE_OA_URL } from '../lib/legal'
import { buildApiUrl } from '../lib/api-base'
import { TUTORIAL_EPISODES } from '../data/tutorials'

const LOGIN_ENTRY_STORAGE_KEY = 'redpen-login-entry'
const LOGIN_URL = buildApiUrl('/api/auth/google?entry=teacher')
const STUDENT_LOGIN_URL = buildApiUrl('/api/auth/google?entry=student')

/** 行銷介紹影片（YouTube） */
const PROMO_VIDEO_ID = 'L-1pNKoww5o'

/** 品牌 slogan——文案以此為準，不要另創標語。
 *  主標兩行刻意各 5 字、不帶標點，兩行才會左右對齊。 */
const SLOGAN_MAIN = ['批改有品質', '時間有價值']
const SLOGAN_SUB = 'RedPen AI，重新定義評量'

/** 導入洽詢：官網不做自助試用，一律走預約導入 */
const CONTACT_SUBJECT = 'RedPen AI 導入洽詢'
const CONTACT_MAIL = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(CONTACT_SUBJECT)}&body=${encodeURIComponent('學校／單位：\n聯絡人／職稱：\n聯絡電話：\n任教領域與班級數：\n想了解的部分：\n')}`

/** 可查證的事實（取代無法佐證的累積數字） */
const FACTS = [
  { k: '約 7 分鐘', v: '30 人班的段考卷批完（內部實測）' },
  { k: '手寫題也改', v: '國字注音、注釋、填空、應用、作圖' },
  { k: '對齊 108 課綱', v: '概念雷達用課綱指標，不是自訂分類' },
  { k: '1Campus 整合', v: '學校班級與名冊直接同步' }
]

/** 一份段考卷的旅程：三階段（與產品側欄 IA、教學影片同一套敘事） */
const JOURNEY = [
  {
    n: 1,
    stage: '考試',
    color: '#2563eb',
    goal: '把紙本考卷變成可以分析的資料。',
    steps: ['建立答案卷（AI 解析題目與配分）', '分享碼：全校同一套標準', '收卷、事務機掃描、PDF 批次匯入', '一鍵 AI 批改，低信心自動標記']
  },
  {
    n: 2,
    stage: '檢討',
    color: '#16a34a',
    goal: '先確認沒改錯，再上一堂有依據的檢討課。',
    steps: ['檢討單：每人一份，逐題含原卷影像', '學生逐題核對後簽名', '考卷總覽排出檢討順序', '作答樣態：全班錯成幾種寫法']
  },
  {
    n: 3,
    stage: '分析',
    color: '#7c3aed',
    goal: '回答三個問題：卷子、學生、家長。',
    steps: ['成績統計與匯出', '試題分析：難易度、鑑別度', '概念雷達與知識點補救名單', '家長報告（含逐題作答影像）']
  }
]

const FEATURES = [
  {
    tag: '第一步・建立答案卷',
    color: '#2563eb',
    title: '把你的卷子上傳，AI 讀出每一題',
    desc: '題號、題型、配分、標準答案，AI 一次擷取好，你只需要看過一遍。這是整套流程的地基——標準定得對，後面的批改和分析才有意義。',
    bullets: ['照片或 PDF 都可以，PDF 不限頁數', '支援一般卷與答案卷（題本與答題卡分開）兩種模式', '分享碼一貼，全校同一份標準，跨班成績才可比較'],
    img: '/site/answerkey.jpg',
    alt: '答案卷題目編輯畫面'
  },
  {
    tag: '批改・把關',
    color: '#2563eb',
    title: 'AI 批完，還告訴你哪幾格它沒把握',
    desc: '一整班批完約 7 分鐘。系統把 AI 信心不足的格子集中在一頁，讓你三十秒看完該看的；改了分數隨時可以一鍵回復 AI 原判。',
    bullets: ['低信心集中檢視，標記永久保留可追溯', '評分統計：同一種答案聚成一張卡，整群改分', '老師改過的分數留有紀錄，也能還原'],
    img: '/site/lowconf.jpg',
    alt: '低信心檢視畫面'
  },
  {
    tag: '檢討課',
    color: '#16a34a',
    title: '檢討單發下去，講稿系統幫你排好',
    desc: '每個學生一份檢討單，逐題印出他寫了什麼、標準答案是什麼，AI 沒把握的還特別標示。全班的錯法自動聚成幾疊——那就是你要講的重點。',
    bullets: ['整班合併一份 PDF，直接列印；末尾有簽名欄', '考卷總覽依失分率排出檢討順序', '全班齊答同一個錯答案時自動插旗，提醒你確認題目'],
    img: '/site/patterns.jpg',
    alt: '作答樣態分析畫面'
  },
  {
    tag: '學情分析',
    color: '#7c3aed',
    title: '這份卷子出得好不好，學生哪裡沒學會',
    desc: '試題分析給你難易度與鑑別度——鑑別度低的題，代表好學生和弱學生答對率差不多，那題下次要修。概念雷達對齊 108 課綱指標，凹下去的那一軸就是下個單元要補的地方。',
    bullets: ['試題分析：難易度 P、鑑別度 D、信度 α、答案分布', '概念雷達可下鑽到知識點，直接列出待加強名單', '家長報告含逐題作答影像，家長看得懂也能核對'],
    img: '/site/radar.jpg',
    alt: '概念雷達畫面'
  }
]

const GUARDRAILS = [
  { t: '低信心標記', d: 'AI 自己不確定的格子會標出來、集中一頁讓你複核；標記永久保留，可追溯。' },
  { t: '檢討單當第二道檢查', d: '檢討單把 AI 沒把握的題印成醒目標示，發下去逐題核對後簽名。' },
  { t: '一鍵回復 AI 原判', d: '老師改過的分數留有紀錄；覺得改錯了，隨時還原成 AI 原本的判斷。' },
  { t: '改分留紀錄', d: '疑義當面提出、老師當場判斷，系統負責把紀錄留下來。' }
]

// 2026-08-27 user 拍板：廢除題數級距，改「按考卷內容計價」——定價細節與試算器移到公開頁 /pricing。
const PRICE_HIGHLIGHTS = [
  { label: '選擇／是非題', price: 'NT$ 0.15 /題' },
  { label: '填空題（文字）', price: 'NT$ 0.2 /題' },
  { label: '簡答／問答題', price: 'NT$ 0.3 /題' },
  { label: '應用題・作圖題', price: 'NT$ 1.6–4.5 /題' },
  { label: '檢討單・學情分析・成績報表・家長報告', price: '包含', free: true }
]

const FAQS = [
  {
    q: 'AI 判錯了怎麼辦？',
    a: '系統會把 AI 沒把握的格子標記出來、集中在一頁讓你複核，你也可以直接改分數並隨時回復 AI 原判。檢討單上也會標示這些題，讓學生逐題核對。我們的假設是 AI 會錯，所以整套流程都圍繞「讓你快速發現並修正」設計。'
  },
  {
    q: '我要改變出題方式嗎？',
    a: '不用。你照平常出卷、印卷、考試。唯一多做的一件事是把答案卷上傳一次讓 AI 解析題目——同一份卷子之後重複使用不必再建。'
  },
  {
    q: '手寫的題目也能改嗎？',
    a: '可以，這正是重點。國字注音、注釋、填空、應用題、作圖題都支援；系統會裁出每一格的作答影像，判分時同時看文字與字形。'
  },
  {
    q: '學生的考卷資料安全嗎？',
    a: '資料存放在雲端資料庫，只有該班老師與（學校方案下）學校指定的行政人員能存取。家長報告以每位學生獨立產出，不會互相看到。'
  },
  {
    q: '學校要怎麼採購？',
    a: '學校方案以學期或學年約計價，由學校統一付費、老師不需自費。建議先用一個領域、一次段考試辦，跑完一輪再擴大。歡迎預約校內說明會。'
  }
]

const TUTORIAL_CARD_COPY = [
  '建立答案卷、收卷掃描、一鍵 AI 批改。',
  '檢討單、重點題、講稿怎麼來。',
  '試題分析、概念雷達、家長報告。'
]
const ROMAN = ['一', '二', '三']

export default function LandingPage() {
  const [loginLoading, setLoginLoading] = useState<'teacher' | 'student' | null>(null)
  const [openFaq, setOpenFaq] = useState<number>(0)

  const handleLogin = (entry: 'teacher' | 'student') => {
    if (typeof window === 'undefined') return
    setLoginLoading(entry)
    window.localStorage.setItem(LOGIN_ENTRY_STORAGE_KEY, entry)
    setTimeout(() => {
      window.location.href = entry === 'student' ? STUDENT_LOGIN_URL : LOGIN_URL
    }, 100)
  }

  const totalMin = Math.round(TUTORIAL_EPISODES.reduce((s, e) => s + e.durationSec, 0) / 60)

  return (
    <div className="min-h-screen bg-white">
      {/* Navbar */}
      <nav className="fixed top-0 left-0 right-0 z-50 border-b border-gray-100 bg-white/95 backdrop-blur-sm">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center gap-7">
            <a href="/" className="flex items-center gap-2">
              <img src="/logo.png" alt="RedPen AI" className="h-8 w-8" />
              <span className="text-xl font-bold text-gray-900">RedPen AI</span>
            </a>
            <div className="hidden items-center gap-6 text-sm font-medium text-gray-500 md:flex">
              <a href="#journey" className="transition-colors hover:text-gray-900">運作方式</a>
              <a href="/tutorials" className="transition-colors hover:text-gray-900">教學影片</a>
              <a href="/school" className="transition-colors hover:text-gray-900">學校方案</a>
              <a href="#pricing" className="transition-colors hover:text-gray-900">定價</a>
              <a href="#faq" className="transition-colors hover:text-gray-900">常見問題</a>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                disabled={loginLoading !== null}
                onClick={() => handleLogin('teacher')}
                className="hidden rounded-lg border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-70 sm:inline-flex"
              >
                {loginLoading === 'teacher' ? '登入中…' : '教師登入'}
              </button>
              <a
                href="#contact"
                className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white transition-colors duration-200 hover:bg-gray-700 active:scale-95"
              >
                預約導入
              </a>
            </div>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="bg-white pt-28 sm:pt-36">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="grid items-center gap-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
            <div className="animate-fade-in-up">
              <h1 className="text-5xl font-bold leading-[1.16] tracking-tight text-gray-900 sm:text-6xl lg:text-7xl">
                {SLOGAN_MAIN[0]}
                <br />
                {SLOGAN_MAIN[1]}
              </h1>
              <p className="mt-5 text-base font-medium tracking-wide text-gray-500 sm:text-lg">
                {SLOGAN_SUB}
              </p>
              <div className="mt-9 flex flex-col gap-4 sm:flex-row">
                <a
                  href="#contact"
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-gray-900 px-7 py-4 text-lg font-semibold text-white transition-colors duration-200 hover:bg-gray-700 active:scale-95"
                >
                  預約導入<ArrowRight className="h-5 w-5" />
                </a>
                <a
                  href="/tutorials"
                  className="inline-flex items-center justify-center gap-2 rounded-xl border-2 border-gray-200 bg-white px-7 py-4 text-lg font-semibold text-gray-700 transition-colors duration-200 hover:border-gray-300 hover:bg-gray-50"
                >
                  <Play className="h-4 w-4 fill-gray-700" />看教學影片
                </a>
              </div>
            </div>

            <div className="animate-fade-in-up animation-delay-200">
              <div className="relative aspect-video overflow-hidden rounded-2xl bg-gray-900 shadow-xl">
                <iframe
                  className="absolute inset-0 h-full w-full"
                  src={`https://www.youtube.com/embed/${PROMO_VIDEO_ID}?rel=0&modestbranding=1`}
                  title="RedPen AI 介紹影片"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  allowFullScreen
                  loading="lazy"
                />
              </div>
            </div>
          </div>

          {/* 可查證的事實 */}
          <div className="mt-16 animate-fade-in-up animation-delay-200 border-y border-gray-100 py-8">
            <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
              {FACTS.map((f) => (
                <div key={f.k}>
                  <p className="text-lg font-bold text-gray-900">{f.k}</p>
                  <p className="mt-1 text-sm leading-relaxed text-gray-500">{f.v}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* 三階段旅程 */}
      <section id="journey" className="scroll-mt-20 bg-white py-16 sm:py-24">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl animate-fade-in-up">
            <h2 className="text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">一份段考卷的完整旅程</h2>
            <p className="mt-4 text-lg text-gray-500">
              從考完到分析分三個階段。每個階段你都只需要做判斷，不需要做整理。
            </p>
          </div>
          <div className="mt-10 grid gap-5 lg:grid-cols-3">
            {JOURNEY.map((j, i) => (
              <article
                key={j.stage}
                className="animate-fade-in-up rounded-2xl border border-gray-100 bg-white p-6 shadow-sm"
                style={{ animationDelay: `${i * 80}ms` }}
              >
                <div className="flex items-center gap-3">
                  <span
                    className="grid h-7 w-7 place-items-center rounded-full font-mono text-xs font-bold text-white"
                    style={{ backgroundColor: j.color }}
                  >
                    {j.n}
                  </span>
                  <span className="text-xl font-bold text-gray-900">{j.stage}</span>
                </div>
                <p className="mt-3 min-h-[3rem] text-[15px] leading-relaxed text-gray-500">{j.goal}</p>
                <ul className="mt-3 space-y-2 border-t border-gray-100 pt-4">
                  {j.steps.map((s, k) => (
                    <li key={s} className="grid grid-cols-[20px_1fr] gap-2 text-[15px] leading-snug text-gray-700">
                      <span className="font-mono text-[11px] font-bold text-gray-400">{String(k + 1).padStart(2, '0')}</span>
                      <span>{s}</span>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* 教學影片入口 */}
      <section className="border-y border-gray-100 bg-gray-50 py-16 sm:py-24">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl animate-fade-in-up">
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-gray-400">教學影片</p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">
              三支影片，{totalMin} 分鐘看完整套流程
            </h2>
            <p className="mt-4 text-lg text-gray-500">
              每個階段都用真實系統畫面走一遍。不用先註冊。
            </p>
          </div>
          <div className="mt-10 grid gap-5 sm:grid-cols-3">
            {TUTORIAL_EPISODES.map((e, index) => (
              <a
                key={e.id}
                href={`/tutorials#${e.id}`}
                className="group flex animate-fade-in-up flex-col overflow-hidden rounded-2xl border border-gray-100 bg-white transition-all duration-200 hover:-translate-y-1 hover:shadow-lg"
                style={{ animationDelay: `${index * 80}ms` }}
              >
                <div className="relative aspect-video overflow-hidden bg-gray-100">
                  <img src={e.poster} alt={`${e.stage}階段教學影片`} className="h-full w-full object-cover" loading="lazy" />
                  <span className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: e.color }} />
                  <span className="absolute inset-0 grid place-items-center">
                    <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white/95 shadow-lg transition-transform group-hover:scale-105">
                      <Play className="ml-0.5 h-4 w-4 fill-gray-900 text-gray-900" />
                    </span>
                  </span>
                  <span className="absolute bottom-2 right-2 rounded-md bg-gray-900/85 px-2 py-1 font-mono text-[11px] font-semibold tabular-nums text-white">
                    {e.duration}
                  </span>
                </div>
                <div className="flex flex-1 flex-col gap-2 p-5">
                  <span className="text-[13px] font-bold tracking-wide" style={{ color: e.color }}>
                    <span className="mr-2 font-mono text-[11px] text-gray-400">EP{e.ep}</span>
                    第{ROMAN[index]}階段・{e.stage}
                  </span>
                  <h3 className="text-lg font-bold text-gray-900">{e.title}</h3>
                  <p className="text-sm leading-relaxed text-gray-500">{TUTORIAL_CARD_COPY[index]}</p>
                  <span className="mt-auto pt-3 text-sm font-semibold" style={{ color: e.color }}>看這一支 →</span>
                </div>
              </a>
            ))}
          </div>
          <div className="mt-8">
            <a
              href="/tutorials"
              className="inline-flex items-center gap-2 rounded-xl border-2 border-gray-200 bg-white px-6 py-3 text-base font-semibold text-gray-700 transition-colors hover:border-gray-300 hover:bg-white"
            >
              看完整教學中心<ArrowRight className="h-4 w-4" />
            </a>
          </div>
        </div>
      </section>

      {/* 功能深挖 */}
      <section className="bg-white py-16 sm:py-24">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl animate-fade-in-up">
            <h2 className="text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">
              四件事，決定這套系統能不能真的用
            </h2>
            <p className="mt-4 text-lg text-gray-500">
              不是「有 AI」就夠。真正的差別在答案卷怎麼建、判錯怎麼收拾、檢討課怎麼上、資料怎麼變成教學決策。
            </p>
          </div>

          {FEATURES.map((f, i) => (
            <div
              key={f.tag}
              className="grid items-center gap-12 border-t border-gray-100 py-14 lg:grid-cols-2 lg:gap-16"
            >
              <div className={`animate-fade-in-up ${i % 2 === 1 ? 'lg:order-2' : ''}`}>
                <span
                  className="mb-5 inline-block rounded-full px-3 py-1 text-[13px] font-bold"
                  style={{ backgroundColor: `${f.color}14`, color: f.color }}
                >
                  {f.tag}
                </span>
                <h3 className="text-2xl font-bold leading-snug tracking-tight text-gray-900 sm:text-3xl">{f.title}</h3>
                <p className="mt-5 text-lg leading-relaxed text-gray-500">{f.desc}</p>
                <ul className="mt-7 space-y-3">
                  {f.bullets.map((b) => (
                    <li key={b} className="flex items-start gap-3">
                      <CheckCircle2 className="mt-0.5 h-5 w-5 flex-shrink-0 text-gray-900" />
                      <span className="text-gray-600">{b}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className={`animate-fade-in-up animation-delay-200 overflow-hidden rounded-2xl border border-gray-100 shadow-lg ${i % 2 === 1 ? 'lg:order-1' : ''}`}>
                <img src={f.img} alt={f.alt} className="h-auto w-full" loading="lazy" />
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 對 AI 的態度 */}
      <section className="bg-gray-900 py-16 sm:py-24">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-gray-500">我們對 AI 的態度</p>
          <h2 className="mt-3 max-w-4xl text-3xl font-bold leading-snug tracking-tight text-white sm:text-4xl">
            AI 會判錯。所以把關做在流程裡，不是寫在免責聲明裡
          </h2>
          <p className="mt-5 max-w-3xl text-lg leading-relaxed text-gray-400">
            你可以相信 AI，但你一定要認真檢查——這句話寫在我們的產品裡，也寫在教學影片裡。
            我們的設計目標不是「零錯誤」，是「錯了你三十秒內就會發現」。
          </p>
          <div className="mt-10 grid items-center gap-12 lg:grid-cols-2">
            <ul className="space-y-6">
              {GUARDRAILS.map((g) => (
                <li key={g.t} className="border-l-2 border-white/20 pl-4">
                  <p className="text-lg font-bold text-white">{g.t}</p>
                  <p className="mt-1 leading-relaxed text-gray-400">{g.d}</p>
                </li>
              ))}
            </ul>
            <div className="overflow-hidden rounded-2xl border border-white/10 shadow-xl">
              <img src="/site/reviewsheet.jpg" alt="檢討單：逐題含原卷影像與核對標示" className="h-auto w-full" loading="lazy" />
            </div>
          </div>
        </div>
      </section>

      {/* 學校方案入口 */}
      <section className="border-b border-gray-100 bg-white py-16 sm:py-24">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="grid items-start gap-12 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-16">
            <div className="animate-fade-in-up">
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-gray-400">學校方案</p>
              <h2 className="mt-3 text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">
                全校一次段考，統一批改
              </h2>
              <p className="mt-4 text-lg leading-relaxed text-gray-500">
                老師各自批改也可以，但由學校統一批改能解決兩件老師自己解決不了的事：
                跨班用同一套判準，以及不必每位老師各自摸索一套流程。
              </p>
              <div className="mt-8 grid gap-3 sm:grid-cols-2">
                {[
                  { icon: Users, t: '跨班公平性', d: '同一份答案卷、同一套判準，多班可合併成一個母體重算試題分析。' },
                  { icon: ScanLine, t: '行政統一批改', d: '行政端建立全校考卷、逐班匯入、集中送批。' },
                  { icon: ShieldCheck, t: '1Campus 整合', d: '班級與名冊直接同步，老師登入自動歸戶到學校。' },
                  { icon: LineChart, t: '批次產出報表', d: '檢討單與家長報告整班整校一次產出。' }
                ].map((s) => (
                  <div key={s.t} className="rounded-xl border border-gray-100 bg-gray-50 p-4">
                    <s.icon className="h-5 w-5 text-gray-900" />
                    <p className="mt-2 font-bold text-gray-900">{s.t}</p>
                    <p className="mt-1 text-sm leading-relaxed text-gray-500">{s.d}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="animate-fade-in-up animation-delay-200 rounded-2xl border border-gray-200 bg-white p-7 shadow-sm">
              <h3 className="text-xl font-bold text-gray-900">怎麼開始</h3>
              <p className="mt-3 leading-relaxed text-gray-500">
                先用一個領域、一次段考試辦。我們協助建立答案卷與匯入流程，跑完一輪再決定要不要擴到全校。
              </p>
              <div className="mt-6 grid gap-3">
                <a
                  href="/school"
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-gray-900 px-6 py-3.5 font-semibold text-white transition-colors hover:bg-gray-700"
                >
                  看學校方案<ArrowRight className="h-4 w-4" />
                </a>
                <a
                  href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('預約 RedPen AI 校內導入說明會')}`}
                  className="inline-flex items-center justify-center gap-2 rounded-xl border-2 border-gray-200 px-6 py-3.5 font-semibold text-gray-700 transition-colors hover:border-gray-300 hover:bg-gray-50"
                >
                  預約校內說明會
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 定價 */}
      <section id="pricing" className="scroll-mt-20 bg-gray-50 py-16 sm:py-24">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl animate-fade-in-up">
            <h2 className="text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">
              按考卷內容計價，功能不分方案
            </h2>
            <p className="mt-4 text-lg text-gray-500">
              沒有「升級才能看學情報告」這種事。分析、檢討單、成績報表全部包含在內，
              只有 AI 批改本身按考卷的題型組成計算——怎麼出卷，就怎麼計價。
            </p>
          </div>

          <div className="mt-10 grid items-start gap-8 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
            <div className="animate-fade-in-up">
              <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
                <table className="w-full text-[15px]">
                  <thead>
                    <tr>
                      <th className="bg-gray-50 px-5 py-3 text-left text-xs font-bold uppercase tracking-wider text-gray-400">動作</th>
                      <th className="bg-gray-50 px-5 py-3 text-right text-xs font-bold uppercase tracking-wider text-gray-400">牌價</th>
                    </tr>
                  </thead>
                  <tbody>
                    {PRICE_HIGHLIGHTS.map((r) => (
                      <tr key={r.label} className="border-t border-gray-100">
                        <td className="px-5 py-3 text-gray-700">{r.label}</td>
                        <td className={`px-5 py-3 text-right font-mono font-bold tabular-nums ${r.free ? 'text-green-600' : 'text-gray-900'}`}>
                          {r.price}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-4 text-sm leading-relaxed text-gray-400">
                批改失敗不收費，重批照輪計算。學校學期約與學年約另有折扣。
              </p>
              <a href="/pricing" className="mt-3 inline-flex items-center gap-1.5 font-semibold text-gray-900 underline underline-offset-4 hover:text-gray-600">
                打開試算器，直接估你的考卷<ArrowRight className="h-4 w-4" />
              </a>
            </div>

            <div className="grid animate-fade-in-up animation-delay-100 gap-4">
              <div className="rounded-2xl bg-gray-900 p-7">
                <h3 className="font-bold text-white">一份標準段考卷</h3>
                <p className="mt-3 text-4xl font-bold tracking-tight text-white">約 NT$10–22</p>
                <p className="mt-2 leading-relaxed text-gray-400">
                  依題型組成而定：選擇題為主的卷最省，應用題、作圖題較高。
                  含檢討單與完整分析。
                </p>
                <a href="/pricing" className="mt-4 inline-flex items-center gap-1.5 font-semibold text-white underline underline-offset-4 hover:text-gray-300">
                  用你的考卷試算<ArrowRight className="h-4 w-4" />
                </a>
              </div>
              <div className="rounded-2xl border border-gray-200 bg-white p-7">
                <h3 className="font-bold text-gray-900">先跑一輪再決定</h3>
                <p className="mt-2 leading-relaxed text-gray-500">
                  我們陪你用一份真實的考卷走完整個流程：建答案卷、匯入、批改、產出報表，
                  跑完再談要不要導入。
                </p>
                <a
                  href="#contact"
                  className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-gray-900 py-3 font-semibold text-white transition-colors hover:bg-gray-700"
                >
                  預約導入<ArrowRight className="h-4 w-4" />
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="scroll-mt-20 bg-white py-16 sm:py-24">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
          <h2 className="text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">老師最常問的問題</h2>
          <div className="mt-8 border-t border-gray-100">
            {FAQS.map((f, i) => (
              <div key={f.q} className="border-b border-gray-100">
                <button
                  type="button"
                  onClick={() => setOpenFaq(openFaq === i ? -1 : i)}
                  aria-expanded={openFaq === i}
                  className="flex w-full items-center gap-4 py-5 text-left"
                >
                  <span className="flex-1 text-lg font-semibold text-gray-900">{f.q}</span>
                  <span className="font-mono text-gray-400">{openFaq === i ? '－' : '＋'}</span>
                </button>
                {openFaq === i && (
                  <p className="mb-5 leading-relaxed text-gray-500">{f.a}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 聯繫我們（預約導入制：官網不做自助註冊入口） */}
      <section id="contact" className="scroll-mt-20 border-t border-gray-100 bg-gray-50 py-20 sm:py-28">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
          <div className="text-center">
            <h2 className="text-4xl font-bold tracking-tight text-gray-900 sm:text-5xl">
              下一次段考，就可以開始
            </h2>
            <p className="mx-auto mt-5 max-w-xl text-xl leading-relaxed text-gray-500">
              我們採預約導入制：先聊一次，用你自己的一份考卷示範完整流程，再決定要不要用。
            </p>
          </div>

          <div className="mt-12 grid gap-5 sm:grid-cols-2">
            {/* Email */}
            <div className="flex flex-col rounded-2xl border border-gray-200 bg-white p-7">
              <Mail className="h-6 w-6 text-gray-900" />
              <h3 className="mt-4 text-xl font-bold text-gray-900">Email 洽詢</h3>
              <p className="mt-2 flex-1 leading-relaxed text-gray-500">
                告訴我們學校／單位、任教領域與班級數，我們會回覆導入方式與時間。
              </p>
              <a
                href={CONTACT_MAIL}
                className="mt-6 inline-flex items-center justify-center gap-2 rounded-xl bg-gray-900 px-6 py-3.5 font-semibold text-white transition-colors hover:bg-gray-700"
              >
                寄信給我們<ArrowRight className="h-4 w-4" />
              </a>
              <p className="mt-3 text-center text-sm text-gray-400">{SUPPORT_EMAIL}</p>
            </div>

            {/* LINE 官方帳號 */}
            <div className="flex flex-col rounded-2xl border border-gray-200 bg-white p-7">
              <MessageCircle className="h-6 w-6" style={{ color: '#06C755' }} />
              <h3 className="mt-4 text-xl font-bold text-gray-900">LINE 官方帳號</h3>
              <p className="mt-2 leading-relaxed text-gray-500">
                想先問幾個問題最快的方式。手機直接點加入，電腦可掃右邊 QR。
              </p>
              <div className="mt-5 flex flex-1 items-end gap-5">
                <a
                  href={LINE_OA_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl px-6 py-3.5 font-semibold text-white transition-opacity hover:opacity-90"
                  style={{ backgroundColor: '#06C755' }}
                >
                  加入 LINE 好友
                </a>
                <img
                  src="/site/line-qr.png"
                  alt="RedPen AI LINE 官方帳號 QR Code"
                  className="h-24 w-24 flex-shrink-0 rounded-lg border border-gray-100"
                  loading="lazy"
                />
              </div>
            </div>
          </div>

          <p className="mt-8 text-center text-sm text-gray-400">
            已經是使用者？
            <button
              type="button"
              disabled={loginLoading !== null}
              onClick={() => handleLogin('teacher')}
              className="ml-1 font-semibold text-gray-600 underline decoration-gray-300 transition-colors hover:text-gray-900 disabled:opacity-70"
            >
              {loginLoading === 'teacher' ? '登入中…' : '教師登入'}
            </button>
          </p>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-gray-950 py-12">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            <div className="sm:col-span-2 lg:col-span-1">
              <div className="flex items-center gap-2">
                <img src="/logo.png" alt="RedPen AI" className="h-8 w-8" />
                <span className="text-xl font-bold text-white">RedPen AI</span>
              </div>
              <p className="mt-4 text-sm leading-relaxed text-gray-500">
                {SLOGAN_MAIN.join('')}。{SLOGAN_SUB}。
              </p>
            </div>

            <div>
              <h4 className="text-sm font-semibold uppercase tracking-wider text-gray-500">產品</h4>
              <ul className="mt-4 space-y-2 text-sm">
                <li><a href="#journey" className="text-gray-500 transition-colors hover:text-white">運作方式</a></li>
                <li><a href="/tutorials" className="text-gray-500 transition-colors hover:text-white">教學影片</a></li>
                <li><a href="/school" className="text-gray-500 transition-colors hover:text-white">學校方案</a></li>
                <li><a href="#pricing" className="text-gray-500 transition-colors hover:text-white">定價</a></li>
              </ul>
            </div>

            <div>
              <h4 className="text-sm font-semibold uppercase tracking-wider text-gray-500">聯絡我們</h4>
              <ul className="mt-4 space-y-2">
                <li className="flex items-center gap-2 text-sm text-gray-500">
                  <Mail className="h-4 w-4" />
                  <a href={`mailto:${SUPPORT_EMAIL}`} className="transition-colors hover:text-white">{SUPPORT_EMAIL}</a>
                </li>
                <li className="flex items-center gap-2 text-sm text-gray-500">
                  <Phone className="h-4 w-4" />
                  <a href={`tel:${SUPPORT_PHONE.replace(/-/g, '')}`} className="transition-colors hover:text-white">{SUPPORT_PHONE}</a>
                </li>
              </ul>
            </div>

            <div>
              <h4 className="text-sm font-semibold uppercase tracking-wider text-gray-500">登入</h4>
              <div className="mt-4 flex flex-col items-start gap-3">
                <a
                  href={LOGIN_URL}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-white px-5 py-2.5 text-sm font-semibold text-gray-900 transition-colors hover:bg-gray-100"
                >
                  教師登入<ArrowRight className="h-4 w-4" />
                </a>
                {/* 學生端尚未對外宣傳，僅保留功能性入口供已在使用的學生登入 */}
                <button
                  type="button"
                  onClick={() => handleLogin('student')}
                  className="text-sm text-gray-600 transition-colors hover:text-gray-300"
                >
                  學生登入
                </button>
              </div>
            </div>
          </div>

          <div className="mt-12 border-t border-gray-800 pt-8 text-center">
            <p className="text-sm text-gray-600">Copyright © 2026 黃政昱. All Rights Reserved.</p>
          </div>
        </div>
      </footer>

      <style>{`
        @keyframes fade-in-up {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .animate-fade-in-up { animation: fade-in-up .6s ease-out both; }
        .animation-delay-100 { animation-delay: .1s; }
        .animation-delay-200 { animation-delay: .2s; }
        @media (prefers-reduced-motion: reduce) {
          .animate-fade-in-up { animation: none; }
        }
      `}</style>
    </div>
  )
}
