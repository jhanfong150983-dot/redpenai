// 教學中心（公開頁 /tutorials）：三支教學影片＋章節跳點＋逐字稿。
// 設計原則：沿用 LandingPage 的單色系統（白底＋gray-900），只用三階段色（藍/綠/紫）當每集識別色。
// 影片來源＝YouTube（youtubeId 空字串時顯示「即將上線」的封面狀態）；章節點擊 → 以 ?start= 重載播放器。
import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Play, ChevronDown, Clock } from 'lucide-react'
import { TUTORIAL_EPISODES, formatTime, type TutorialEpisode } from '../data/tutorials'
import { buildApiUrl } from '../lib/api-base'

const LOGIN_ENTRY_STORAGE_KEY = 'redpen-login-entry'
const LOGIN_URL = buildApiUrl('/api/auth/google?entry=teacher')

const PAGE_TITLE = 'RedPen AI 教學中心 — 三支影片走完批改、檢討、分析'
const PAGE_DESC = '三支教學影片，用實際系統畫面帶你走完一次段考：建立答案卷與 AI 批改、檢討單與樣態分析、試題分析與家長報告。附章節跳點與逐字稿。'

/** 設定 <title> / description，離開頁面時還原（本專案沒有 head manager，改用 effect 處理） */
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

/** VideoObject 結構化資料：讓搜尋結果有機會顯示影片縮圖 */
function useVideoSchema(episodes: TutorialEpisode[]): void {
  useEffect(() => {
    const origin = typeof window === 'undefined' ? '' : window.location.origin
    const data = episodes.map((e) => ({
      '@context': 'https://schema.org',
      '@type': 'VideoObject',
      name: `RedPen AI 教學 ${e.ep}：${e.stage}－${e.title}`,
      description: e.takeaway,
      thumbnailUrl: `${origin}${e.poster}`,
      duration: `PT${Math.floor(e.durationSec / 60)}M${e.durationSec % 60}S`,
      ...(e.youtubeId ? { embedUrl: `https://www.youtube.com/embed/${e.youtubeId}` } : {}),
      transcript: e.transcript.map((l) => l.text).join(''),
    }))
    const tag = document.createElement('script')
    tag.type = 'application/ld+json'
    tag.text = JSON.stringify(data)
    document.head.appendChild(tag)
    return () => { document.head.removeChild(tag) }
  }, [episodes])
}

const ROMAN = ['一', '二', '三']

function EpisodeBlock({ episode, index, onLogin }: {
  episode: TutorialEpisode
  index: number
  onLogin: () => void
}) {
  const [startAt, setStartAt] = useState<number | null>(null)
  const [txOpen, setTxOpen] = useState(false)
  const playing = startAt !== null && Boolean(episode.youtubeId)

  const embedSrc = useMemo(() => {
    if (!episode.youtubeId) return ''
    const params = new URLSearchParams({ rel: '0', modestbranding: '1', autoplay: '1' })
    if (startAt) params.set('start', String(startAt))
    return `https://www.youtube.com/embed/${episode.youtubeId}?${params.toString()}`
  }, [episode.youtubeId, startAt])

  const cta = [
    { label: '免費試用，先批一份考卷', action: onLogin },
    { label: '下載檢討單範例', href: '#' },
    { label: '看學校方案', href: '/#pricing' },
  ][index] ?? { label: '免費試用', action: onLogin }

  return (
    <section id={episode.id} className="scroll-mt-24 border-t border-gray-100 py-12 first:border-t-0 sm:py-16">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)] lg:gap-10">
        {/* 播放器＋逐字稿 */}
        <div>
          <div className="overflow-hidden rounded-2xl border border-gray-200 bg-gray-900 shadow-lg">
            <div className="relative aspect-video">
              {playing ? (
                <iframe
                  className="absolute inset-0 h-full w-full"
                  src={embedSrc}
                  title={`RedPen AI 教學 ${episode.ep}：${episode.stage}`}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  allowFullScreen
                />
              ) : (
                <>
                  <img
                    src={episode.poster}
                    alt={`${episode.stage}階段教學影片畫面`}
                    className="absolute inset-0 h-full w-full object-cover"
                    loading={index === 0 ? 'eager' : 'lazy'}
                  />
                  <span className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: episode.color }} />
                  {episode.youtubeId ? (
                    <button
                      type="button"
                      onClick={() => setStartAt(0)}
                      aria-label={`播放教學 ${episode.ep}`}
                      className="group absolute inset-0 flex items-center justify-center bg-gray-900/10 transition-colors hover:bg-gray-900/20"
                    >
                      <span className="flex h-16 w-16 items-center justify-center rounded-full bg-white/95 shadow-xl transition-transform group-hover:scale-105">
                        <Play className="ml-0.5 h-6 w-6 fill-gray-900 text-gray-900" />
                      </span>
                    </button>
                  ) : (
                    <span className="absolute bottom-3 left-4 rounded-lg bg-gray-900/85 px-3 py-1.5 text-xs font-semibold text-white">
                      影片即將上線
                    </span>
                  )}
                  <span className="absolute bottom-3 right-3 rounded-md bg-gray-900/85 px-2 py-1 font-mono text-[11px] font-semibold tabular-nums text-white">
                    {episode.duration}
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="mt-5 border-t border-gray-100 pt-4">
            <button
              type="button"
              onClick={() => setTxOpen((v) => !v)}
              aria-expanded={txOpen}
              className="flex items-center gap-2 text-sm font-semibold text-gray-500 transition-colors hover:text-gray-900"
            >
              {txOpen ? '收合逐字稿' : `展開逐字稿（${episode.transcript.length} 句，可搜尋）`}
              <ChevronDown className={`h-4 w-4 transition-transform ${txOpen ? 'rotate-180' : ''}`} />
            </button>
            {txOpen && (
              <div className="mt-3 space-y-1.5">
                {episode.transcript.map((line) => (
                  <div key={line.t} className="grid grid-cols-[48px_1fr] gap-3 text-[15px] leading-relaxed">
                    <button
                      type="button"
                      onClick={() => episode.youtubeId && setStartAt(line.t)}
                      className="pt-0.5 text-left font-mono text-xs font-semibold tabular-nums text-gray-400 hover:text-gray-900"
                    >
                      {formatTime(line.t)}
                    </button>
                    <p className="m-0 text-gray-600">{line.text}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 標題＋章節＋CTA */}
        <div>
          <div className="flex flex-wrap items-baseline gap-3">
            <span className="font-mono text-xs font-bold tracking-widest text-gray-400">EP{episode.ep}</span>
            <span className="text-[13px] font-bold tracking-wide" style={{ color: episode.color }}>
              第{ROMAN[index]}階段・{episode.stage}
            </span>
          </div>
          <h2 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">{episode.title}</h2>
          <p className="mt-3 text-[15px] leading-relaxed text-gray-500">{episode.takeaway}</p>

          <div className="mt-6">
            <p className="mb-2 text-xs font-bold uppercase tracking-widest text-gray-400">章節</p>
            <ul
              className="m-0 list-none border-l-2 p-0"
              style={{ borderColor: `${episode.color}55` }}
            >
              {episode.chapters.map((c) => (
                <li key={c.t}>
                  <button
                    type="button"
                    onClick={() => episode.youtubeId && setStartAt(c.t)}
                    className="grid w-full grid-cols-[52px_1fr] items-baseline gap-3 rounded-r-lg py-2 pl-3.5 pr-2 text-left text-[15px] leading-snug text-gray-700 transition-colors hover:bg-gray-50 hover:text-gray-900"
                  >
                    <span className="font-mono text-xs font-semibold tabular-nums text-gray-400">{formatTime(c.t)}</span>
                    <span>{c.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            {'action' in cta && cta.action ? (
              <button
                type="button"
                onClick={cta.action}
                className="inline-flex items-center gap-2 rounded-xl bg-gray-900 px-5 py-3 text-[15px] font-semibold text-white transition-colors hover:bg-gray-700"
              >
                {cta.label}
              </button>
            ) : (
              <a
                href={'href' in cta ? cta.href : '/'}
                className="inline-flex items-center gap-2 rounded-xl bg-gray-900 px-5 py-3 text-[15px] font-semibold text-white transition-colors hover:bg-gray-700"
              >
                {cta.label}
              </a>
            )}
            {index < TUTORIAL_EPISODES.length - 1 && (
              <a
                href={`#${TUTORIAL_EPISODES[index + 1].id}`}
                className="inline-flex items-center gap-2 rounded-xl border-2 border-gray-200 bg-white px-5 py-3 text-[15px] font-semibold text-gray-700 transition-colors hover:border-gray-300 hover:bg-gray-50"
              >
                看下一支：{TUTORIAL_EPISODES[index + 1].stage}
                <ArrowRight className="h-4 w-4" />
              </a>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

export default function TutorialsPage() {
  usePageMeta()
  useVideoSchema(TUTORIAL_EPISODES)
  const [loginLoading, setLoginLoading] = useState(false)

  const handleLogin = () => {
    if (typeof window === 'undefined') return
    setLoginLoading(true)
    window.localStorage.setItem(LOGIN_ENTRY_STORAGE_KEY, 'teacher')
    setTimeout(() => { window.location.href = LOGIN_URL }, 100)
  }

  const totalMin = Math.round(TUTORIAL_EPISODES.reduce((s, e) => s + e.durationSec, 0) / 60)

  return (
    <div className="min-h-screen bg-white">
      <nav className="fixed inset-x-0 top-0 z-50 border-b border-gray-100 bg-white/95 backdrop-blur-sm">
        <div className="mx-auto flex h-16 max-w-6xl items-center px-4 sm:px-6 lg:px-8">
          <a href="/" className="flex items-center gap-2 text-lg font-bold text-gray-900">
            <img src="/logo.png" alt="" className="h-8 w-8" />
            RedPen AI
          </a>
          <div className="ml-auto flex items-center gap-3">
            <a href="/" className="hidden text-sm font-semibold text-gray-500 transition-colors hover:text-gray-900 sm:inline">
              回首頁
            </a>
            <button
              type="button"
              onClick={handleLogin}
              disabled={loginLoading}
              className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-gray-700 disabled:opacity-70"
            >
              {loginLoading ? '前往登入…' : '教師登入'}
            </button>
          </div>
        </div>
      </nav>

      <header className="px-4 pb-2 pt-28 sm:px-6 sm:pt-36 lg:px-8">
        <div className="mx-auto max-w-6xl">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-gray-400">教學中心</p>
          <h1 className="mt-3 text-4xl font-bold leading-tight tracking-tight text-gray-900 sm:text-5xl">
            一次段考，走完三個階段
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-relaxed text-gray-500">
            考試、檢討、分析。三支影片用實際操作畫面帶你走完，總共 {totalMin} 分鐘；
            想找特定功能，直接點右邊的章節跳過去。
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-2">
            {TUTORIAL_EPISODES.map((e, i) => (
              <span key={e.id} className="flex items-center gap-2">
                {i > 0 && <span className="h-0.5 w-8 bg-gray-200" aria-hidden="true" />}
                <a
                  href={`#${e.id}`}
                  className="inline-flex items-center gap-2 rounded-full border-2 border-gray-200 px-4 py-2 text-[15px] font-bold text-gray-900 transition-colors hover:border-gray-300 hover:bg-gray-50"
                >
                  <span
                    className="grid h-5 w-5 place-items-center rounded-full font-mono text-[11px] font-bold text-white"
                    style={{ backgroundColor: e.color }}
                  >
                    {e.ep}
                  </span>
                  {e.stage}
                  <span className="flex items-center gap-1 font-mono text-[11px] font-semibold tabular-nums text-gray-400">
                    <Clock className="h-3 w-3" />{e.duration}
                  </span>
                </a>
              </span>
            ))}
          </div>
        </div>
      </header>

      <main className="px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-6xl">
          {TUTORIAL_EPISODES.map((e, i) => (
            <EpisodeBlock key={e.id} episode={e} index={i} onLogin={handleLogin} />
          ))}
        </div>
      </main>

      <section className="mt-8 border-t border-gray-100 bg-gray-50 px-4 py-16 sm:px-6 sm:py-20 lg:px-8">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">看完了，換你試一份</h2>
          <p className="mt-4 text-lg text-gray-500">先用一份考卷體驗完整流程，不需要信用卡。</p>
          <div className="mt-8 flex flex-wrap justify-center gap-4">
            <button
              type="button"
              onClick={handleLogin}
              disabled={loginLoading}
              className="inline-flex items-center gap-2 rounded-xl bg-gray-900 px-8 py-4 text-lg font-semibold text-white transition-colors hover:bg-gray-700 disabled:opacity-70"
            >
              {loginLoading ? '前往登入…' : '免費開始使用'}
              <ArrowRight className="h-5 w-5" />
            </button>
            <a
              href="/"
              className="inline-flex items-center gap-2 rounded-xl border-2 border-gray-200 bg-white px-8 py-4 text-lg font-semibold text-gray-700 transition-colors hover:border-gray-300"
            >
              回首頁看方案
            </a>
          </div>
        </div>
      </section>
    </div>
  )
}
