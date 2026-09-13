// 行銷首頁（2026-08-13 重新設計）
// 敘事＝「一份段考卷的旅程」：考試 → 檢討 → 分析，與產品 IA、教學影片一致。
// user 拍板的三個原則：
//   ① 只放可查證的事實，不用無法佐證的累積數字
//   ② 學校方案區塊已從首頁拿掉（2026-09-13 user）；/school 路由保留
//   ③ 定價、常見問題各自獨立分頁（2026-09-13 user：分頁要是真的分頁不是捲動），首頁不再內嵌
//   ④ 學生端尚未成熟 → 首頁不宣傳學生功能；學生登入僅保留 footer 一個功能性連結
import { ArrowRight, CheckCircle2, Play } from 'lucide-react'
import { TUTORIAL_EPISODES } from '../data/tutorials'
import PublicNav from '../components/PublicNav'
import PublicFooter from '../components/PublicFooter'


/** 行銷介紹影片（YouTube） */
const PROMO_VIDEO_ID = 'L-1pNKoww5o'

/** 品牌 slogan——文案以此為準，不要另創標語。
 *  主標兩行刻意各 5 字、不帶標點，兩行才會左右對齊。 */
const SLOGAN_MAIN = ['批改有品質', '時間有價值']
const SLOGAN_SUB = 'RedPen AI，重新定義評量'

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
    title: '檢討模式：投影上課，一題一題講',
    desc: '全螢幕投影：左邊是題本，可以放大、換頁；右邊是這一題錯幾人、誰錯了、全班最典型的錯法和正確寫法。依失分率排好檢討順序，按 → 換下一題。',
    bullets: ['錯幾人、誰錯了（座號）一眼看到', '典型錯法自動聚成幾種，附學生卷面', '每個學生一份檢討單，逐題印出他寫了什麼'],
    img: '/site/review-mode.jpg',
    alt: '檢討模式畫面'
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

const TUTORIAL_CARD_COPY = [
  '建立答案卷、收卷掃描、一鍵 AI 批改。',
  '檢討單、重點題、講稿怎麼來。',
  '試題分析、概念雷達、家長報告。'
]
const ROMAN = ['一', '二', '三']

export default function LandingPage() {
  const totalMin = Math.round(TUTORIAL_EPISODES.reduce((s, e) => s + e.durationSec, 0) / 60)

  return (
    <div className="min-h-screen bg-white">
      <PublicNav active="home" />

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
                  href="/contact"
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-gray-900 px-7 py-4 text-lg font-semibold text-white transition-colors duration-200 hover:bg-gray-700 active:scale-95"
                >
                  聯絡我們<ArrowRight className="h-5 w-5" />
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
                <img
                  src={f.img} alt={f.alt} className="h-auto w-full" loading="lazy"
                  // 2026-09-13 檢討模式截圖 /site/review-mode.jpg 由 user 補檔；缺檔時顯示灰底文字、不出現破圖
                  onError={(e) => {
                    const el = e.currentTarget
                    el.style.display = 'none'
                    const box = el.parentElement
                    if (box && !box.dataset.fallback) {
                      box.dataset.fallback = '1'
                      box.classList.add('grid', 'place-items-center', 'aspect-video', 'bg-gray-100', 'text-sm', 'text-gray-400')
                      box.append(`${f.alt}（截圖準備中）`)
                    }
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </section>

      <PublicFooter />

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
