import { useState } from 'react'
import {
  Camera,
  Sparkles,
  BarChart3,
  ClipboardCheck,
  ArrowRight,
  Check,
  X,
  Crown,
  CheckCircle2,
  Mail,
  Phone,
  RefreshCw,
  Play
} from 'lucide-react'
import { SUPPORT_EMAIL, SUPPORT_PHONE } from '../lib/legal'
import { buildApiUrl } from '../lib/api-base'
import { TUTORIAL_EPISODES } from '../data/tutorials'

// 教學影片入口區塊用（卡片文案比教學頁的 takeaway 短，首頁只需一句）
const TUTORIAL_CARD_COPY = [
  '建立答案卷、收卷掃描、一鍵 AI 批改。',
  '檢討單、重點題、申訴修正。',
  '試題分析、概念雷達、家長報告。'
]
const TUTORIAL_TOTAL_MIN = Math.round(
  TUTORIAL_EPISODES.reduce((sum, e) => sum + e.durationSec, 0) / 60
)

const LOGIN_ENTRY_STORAGE_KEY = 'redpen-login-entry'
const LOGIN_URL = buildApiUrl('/api/auth/google?entry=teacher')
const STUDENT_LOGIN_URL = buildApiUrl('/api/auth/google?entry=student')

export default function LandingPage() {
  const [loginLoading, setLoginLoading] = useState<'teacher' | 'student' | null>(null)

  const handleLogin = (entry: 'teacher' | 'student') => {
    if (typeof window === 'undefined') return
    setLoginLoading(entry)
    window.localStorage.setItem(LOGIN_ENTRY_STORAGE_KEY, entry)
    // 短暫延遲讓 UI 有回饋後再跳轉
    setTimeout(() => {
      window.location.href = entry === 'student' ? STUDENT_LOGIN_URL : LOGIN_URL
    }, 100)
  }

  return (
    <div className="min-h-screen bg-white">
      {/* Navbar */}
      <nav className="fixed top-0 left-0 right-0 bg-white/95 backdrop-blur-sm border-b border-gray-100 z-50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center gap-2">
              <img src="/logo.png" alt="RedPen AI" className="w-8 h-8" />
              <span className="text-xl font-bold text-gray-900">RedPen AI</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={loginLoading !== null}
                onClick={() => handleLogin('student')}
                className="px-4 py-2 border border-gray-200 bg-white text-gray-700 font-medium rounded-lg text-sm transition-colors duration-200 hover:bg-gray-50 hover:shadow active:scale-95 disabled:opacity-70 disabled:cursor-wait"
              >
                {loginLoading === 'student' ? '登入中…' : '學生入口'}
              </button>
              <button
                type="button"
                disabled={loginLoading !== null}
                onClick={() => handleLogin('teacher')}
                className="px-4 py-2 bg-gray-900 text-white font-semibold rounded-lg text-sm transition-colors duration-200 hover:bg-gray-700 hover:shadow active:scale-95 disabled:opacity-70 disabled:cursor-wait"
              >
                {loginLoading === 'teacher' ? '登入中…' : '教師登入'}
              </button>
            </div>
          </div>
        </div>
      </nav>

      {/* Hero + 影片 */}
      <section className="pt-32 pb-16 sm:pt-40 sm:pb-24 bg-white">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid lg:grid-cols-2 gap-16 items-center">
            {/* 左：文字 */}
            <div className="animate-fade-in-up">
              <h1 className="text-4xl sm:text-5xl font-bold text-gray-900 tracking-tight leading-tight">
                批改更有品質
                <br />
                <span className="text-gray-500">時間更有價值</span>
              </h1>
              <p className="mt-8 text-xl text-gray-500 leading-relaxed">
                RedPen AI 自動批改、追蹤訂正、產出學情報告<br />——你只需要確認和教學。
              </p>
              <div className="mt-10 flex flex-col sm:flex-row gap-4">
                <button
                  type="button"
                  disabled={loginLoading !== null}
                  onClick={() => handleLogin('teacher')}
                  className="inline-flex items-center justify-center px-8 py-4 bg-gray-900 text-white font-semibold rounded-xl text-lg transition-colors duration-200 hover:bg-gray-700 hover:scale-105 hover:shadow-lg active:scale-95 disabled:opacity-70 disabled:cursor-wait"
                >
                  {loginLoading === 'teacher' ? (
                    <><RefreshCw className="w-5 h-5 animate-spin mr-2" />登入中…</>
                  ) : '教師登入'}
                </button>
                <button
                  type="button"
                  disabled={loginLoading !== null}
                  onClick={() => handleLogin('student')}
                  className="inline-flex items-center justify-center px-8 py-4 border-2 border-gray-200 bg-white text-gray-700 font-semibold rounded-xl text-lg transition-colors duration-200 hover:bg-gray-50 hover:scale-105 hover:shadow-lg hover:border-gray-300 active:scale-95 disabled:opacity-70 disabled:cursor-wait"
                >
                  {loginLoading === 'student' ? (
                    <><RefreshCw className="w-5 h-5 animate-spin mr-2" />登入中…</>
                  ) : '學生登入'}
                </button>
              </div>
            </div>

            {/* 右：影片 */}
            <div className="animate-fade-in-up animation-delay-200">
              <div className="relative aspect-video rounded-2xl overflow-hidden shadow-xl bg-gray-900">
                <iframe
                  className="absolute inset-0 w-full h-full"
                  src="https://www.youtube.com/embed/gbTN5zb67To"
                  title="RedPen AI 介紹影片"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  allowFullScreen
                  loading="lazy"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Social Proof Bar */}
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 mt-16 animate-fade-in-up animation-delay-200">
          <div className="border-y border-gray-100 py-8">
            <div className="grid grid-cols-3 gap-8 text-center">
              <div>
                <p className="text-4xl font-bold text-gray-900">500+</p>
                <p className="mt-1 text-sm text-gray-500">位老師正在使用</p>
              </div>
              <div>
                <p className="text-4xl font-bold text-gray-900">10,000+</p>
                <p className="mt-1 text-sm text-gray-500">份作業已批改</p>
              </div>
              <div>
                <p className="text-4xl font-bold text-gray-900">3 分鐘</p>
                <p className="mt-1 text-sm text-gray-500">完成一份作業批改</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 一條龍流程 */}
      <section className="py-16 sm:py-24 bg-gray-50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16 animate-fade-in-up">
            <h2 className="text-3xl sm:text-4xl font-bold text-gray-900">
              一條龍的批改流程
            </h2>
            <p className="mt-4 text-lg text-gray-500">
              五個步驟，從紙本作業到教學分析，全程自動
            </p>
          </div>

          <div className="grid sm:grid-cols-5 gap-4">
            {[
              { step: 1, icon: Camera, title: '上傳作業', desc: '拍照或 PDF 批次匯入' },
              { step: 2, icon: Sparkles, title: 'AI 批改', desc: '自動辨識、標記對錯、計算分數' },
              { step: 3, icon: RefreshCw, title: 'AI 訂正', desc: '學生用手機補交，AI 自動重批' },
              { step: 4, icon: ClipboardCheck, title: '成績登記', desc: '自動彙整全班，一鍵匯出 Excel' },
              { step: 5, icon: BarChart3, title: '學情報告', desc: '分析錯誤類型，提供教學建議' }
            ].map((item, index) => (
              <div key={item.step} className="relative animate-fade-in-up" style={{ animationDelay: `${index * 80}ms` }}>
                <div className="bg-white rounded-2xl p-6 border border-gray-100 h-full">
                  <div className="flex items-center gap-3 mb-3">
                    <span className="text-3xl font-bold text-gray-200">{item.step}</span>
                    <item.icon className="w-5 h-5 text-gray-600" />
                  </div>
                  <h3 className="text-base font-bold text-gray-900">{item.title}</h3>
                  <p className="mt-1 text-sm text-gray-500 leading-relaxed">{item.desc}</p>
                </div>
                {index < 4 && (
                  <div className="hidden sm:flex absolute top-1/2 -right-2 z-10 -translate-y-1/2 items-center justify-center">
                    <ArrowRight className="w-4 h-4 text-gray-300" />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 教學影片入口（完整內容在 /tutorials） */}
      <section className="py-16 sm:py-24 bg-white">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl animate-fade-in-up">
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-gray-400">教學影片</p>
            <h2 className="mt-3 text-3xl sm:text-4xl font-bold text-gray-900">
              三支影片，{TUTORIAL_TOTAL_MIN} 分鐘看完整套流程
            </h2>
            <p className="mt-4 text-lg text-gray-500">
              從答案卷建立到家長報告，每個階段都用真實系統畫面走一遍。不用先註冊。
            </p>
          </div>

          <div className="mt-10 grid gap-5 sm:grid-cols-3">
            {TUTORIAL_EPISODES.map((e, index) => (
              <a
                key={e.id}
                href={`/tutorials#${e.id}`}
                className="group flex flex-col overflow-hidden rounded-2xl border border-gray-100 bg-white transition-all duration-200 hover:-translate-y-1 hover:shadow-lg animate-fade-in-up"
                style={{ animationDelay: `${index * 80}ms` }}
              >
                <div className="relative aspect-video overflow-hidden bg-gray-100">
                  <img
                    src={e.poster}
                    alt={`${e.stage}階段教學影片`}
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
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
                    第{['一', '二', '三'][index]}階段・{e.stage}
                  </span>
                  <h3 className="text-lg font-bold text-gray-900">{e.title}</h3>
                  <p className="text-sm leading-relaxed text-gray-500">{TUTORIAL_CARD_COPY[index]}</p>
                  <span className="mt-auto pt-3 text-sm font-semibold" style={{ color: e.color }}>
                    看這一支 →
                  </span>
                </div>
              </a>
            ))}
          </div>

          <div className="mt-8">
            <a
              href="/tutorials"
              className="inline-flex items-center gap-2 rounded-xl border-2 border-gray-200 bg-white px-6 py-3 text-base font-semibold text-gray-700 transition-colors hover:border-gray-300 hover:bg-gray-50"
            >
              看完整教學中心
              <ArrowRight className="w-4 h-4" />
            </a>
          </div>
        </div>
      </section>

      {/* 功能深挖：AI 批改 */}
      <section className="py-16 sm:py-24 bg-gray-50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid lg:grid-cols-2 gap-16 items-center">
            <div className="animate-fade-in-up">
              <span className="inline-block px-3 py-1 bg-gray-100 text-gray-600 text-sm font-medium rounded-full mb-6">
                AI 批改
              </span>
              <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 leading-tight">
                拍照，三分鐘
                <br />
                批完整班作業
              </h2>
              <p className="mt-6 text-lg text-gray-500 leading-relaxed">
                支援選擇題、填充題、應用題等多種題型。AI 自動比對答案鍵，老師只需最後確認。
              </p>
              <ul className="mt-8 space-y-3">
                {[
                  '智慧辨識手寫答案，支援多種題型',
                  '老師可手動覆蓋 AI 判斷結果',
                  '一致性檢查，確保批改穩定準確'
                ].map((item) => (
                  <li key={item} className="flex items-start gap-3">
                    <CheckCircle2 className="w-5 h-5 text-gray-900 flex-shrink-0 mt-0.5" />
                    <span className="text-gray-600">{item}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="animate-fade-in-up animation-delay-200 rounded-2xl overflow-hidden border border-gray-100 shadow-lg">
              <img src="/screenshot-grading.jpg" alt="AI 批改介面" className="w-full h-auto" />
            </div>
          </div>
        </div>
      </section>

      {/* 功能深挖：AI 訂正 */}
      <section className="py-16 sm:py-24 bg-white">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid lg:grid-cols-2 gap-16 items-center">
            <div className="order-2 lg:order-1 animate-fade-in-up animation-delay-200 rounded-2xl overflow-hidden border border-gray-100 shadow-lg">
              <img src="/screenshot-upload.png" alt="學生訂正入口" className="w-full h-auto" />
            </div>
            <div className="order-1 lg:order-2 animate-fade-in-up">
              <span className="inline-block px-3 py-1 bg-gray-100 text-gray-600 text-sm font-medium rounded-full mb-6">
                AI 訂正
              </span>
              <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 leading-tight">
                學生訂正，
                <br />
                不用帶紙本來找老師
              </h2>
              <p className="mt-6 text-lg text-gray-500 leading-relaxed">
                老師一鍵派發訂正單，學生收到連結、用手機拍照補交，AI 重新批改，進度即時回報。
              </p>
              <ul className="mt-8 space-y-3">
                {[
                  'Google 帳號秒速登入，無需另外註冊',
                  '手機相機直接拍照上傳，隨時補交',
                  '訂正結果即時顯示，老師即時掌握進度'
                ].map((item) => (
                  <li key={item} className="flex items-start gap-3">
                    <CheckCircle2 className="w-5 h-5 text-gray-900 flex-shrink-0 mt-0.5" />
                    <span className="text-gray-600">{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* 功能深挖：學情報告 */}
      <section className="py-16 sm:py-24 bg-gray-50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid lg:grid-cols-2 gap-16 items-center">
            <div className="animate-fade-in-up">
              <span className="inline-block px-3 py-1 bg-gray-100 text-gray-600 text-sm font-medium rounded-full mb-6">
                學情報告
              </span>
              <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 leading-tight">
                哪些概念全班都沒學會，
                <br />
                一眼就看出來
              </h2>
              <p className="mt-6 text-lg text-gray-500 leading-relaxed">
                AI 自動分析錯誤類型，找出高頻錯誤題目，幫助老師決定下一堂課的教學重點。
              </p>
              <ul className="mt-8 space-y-3">
                {[
                  '班級整體錯誤分布一覽',
                  '個別學生弱點追蹤與比較',
                  '可匯出完整成績單與分析報告'
                ].map((item) => (
                  <li key={item} className="flex items-start gap-3">
                    <CheckCircle2 className="w-5 h-5 text-gray-900 flex-shrink-0 mt-0.5" />
                    <span className="text-gray-600">{item}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="animate-fade-in-up animation-delay-200 rounded-2xl overflow-hidden border border-gray-100 shadow-lg">
              <img src="/screenshot-summary.jpg" alt="學情報告" className="w-full h-auto" />
            </div>
          </div>
        </div>
      </section>

      {/* 定價 */}
      <section id="pricing" className="py-16 sm:py-24 bg-white">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16 animate-fade-in-up">
            <h2 className="text-3xl sm:text-4xl font-bold text-gray-900">
              選擇適合你的方案
            </h2>
            <p className="mt-4 text-lg text-gray-500">
              免費開始使用，隨時升級解鎖更多功能
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-8 max-w-4xl mx-auto">
            {/* 免費方案 */}
            <div className="bg-white rounded-2xl p-8 border border-gray-200 animate-fade-in-up">
              <h3 className="text-2xl font-bold text-gray-900">免費體驗</h3>
              <p className="mt-2 text-gray-500">適合初次體驗的老師</p>
              <div className="mt-6">
                <span className="text-4xl font-bold text-gray-900">$0</span>
                <span className="text-gray-500 ml-2">/ 永久免費</span>
              </div>
              <ul className="mt-6 space-y-3">
                {[
                  { label: '班級管理', included: true },
                  { label: '作業管理與匯入', included: true },
                  { label: 'AI 批改（依墨水用量）', included: true },
                  { label: '訂正管理', included: false },
                  { label: '成績管理', included: false },
                  { label: 'AI 學情報告', included: false },
                  { label: '最新模組優先體驗', included: false }
                ].map((item) => (
                  <li key={item.label} className="flex items-center gap-3">
                    {item.included
                      ? <Check className="w-5 h-5 text-gray-900 flex-shrink-0" />
                      : <X className="w-5 h-5 text-gray-300 flex-shrink-0" />
                    }
                    <span className={item.included ? 'text-gray-700' : 'text-gray-500'}>{item.label}</span>
                  </li>
                ))}
              </ul>
              <a
                href={LOGIN_URL}
                className="mt-8 block w-full py-3 text-center border border-gray-200 bg-white text-gray-700 font-semibold rounded-xl hover:bg-gray-50 transition-colors"
              >
                立即免費試用
              </a>
            </div>

            {/* Pro 方案 */}
            <div className="bg-gray-900 rounded-2xl p-8 relative overflow-hidden animate-fade-in-up animation-delay-100">
              <div className="absolute top-4 right-4 px-3 py-1 bg-yellow-400 text-yellow-900 text-xs font-bold rounded-full flex items-center gap-1">
                <Crown className="w-3 h-3" />
                最受老師歡迎
              </div>
              <h3 className="text-2xl font-bold text-white">Pro 方案</h3>
              <p className="mt-2 text-gray-500">解鎖完整功能</p>
              <div className="mt-6">
                <span className="text-4xl font-bold text-white">NT$ 100 起</span>
              </div>
              <p className="text-gray-500 text-sm mt-1">購買墨水即自動升級 Pro</p>

              <div className="mt-4 bg-white/10 rounded-xl p-4">
                <h4 className="text-sm font-semibold text-gray-300 mb-3">墨水方案</h4>
                <ul className="space-y-2 text-sm">
                  <li className="flex justify-between text-gray-300">
                    <span>100 墨水</span>
                    <span className="font-semibold text-white">NT$ 100</span>
                  </li>
                  <li className="flex justify-between text-gray-300">
                    <span>300 墨水</span>
                    <span className="font-semibold text-white">NT$ 280</span>
                  </li>
                  <li className="flex justify-between text-gray-300">
                    <span>1000 墨水</span>
                    <span className="font-semibold text-white">NT$ 800</span>
                  </li>
                </ul>
                <p className="text-xs text-gray-500 mt-3 border-t border-white/10 pt-3">
                  墨水用於 AI 批改用量（依頁數/題數扣點），購買後自動升級 Pro 功能
                </p>
              </div>

              <ul className="mt-6 space-y-3">
                {[
                  '班級管理',
                  '作業管理與匯入',
                  'AI 批改（依墨水用量）',
                  '訂正管理',
                  '成績管理',
                  'AI 學情報告',
                  '最新模組優先體驗'
                ].map((item) => (
                  <li key={item} className="flex items-center gap-3">
                    <Check className="w-5 h-5 text-green-400 flex-shrink-0" />
                    <span className="text-gray-200">{item}</span>
                  </li>
                ))}
              </ul>

              <p className="text-xs text-gray-500 mt-4 text-center">價格皆以新台幣（NT$）計價</p>
              <a
                href={LOGIN_URL}
                className="mt-6 block w-full py-3 text-center bg-white text-gray-900 font-semibold rounded-xl hover:bg-gray-100 transition-colors"
              >
                升級 Pro 方案
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="py-24 sm:py-32 bg-gray-50">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center animate-fade-in-up">
          <h2 className="text-4xl sm:text-6xl font-bold text-gray-900 tracking-tight">
            今天就試試看
          </h2>
          <p className="mt-6 text-xl text-gray-500">
            免費開始，不需信用卡
          </p>
          <div className="mt-10 flex flex-col sm:flex-row gap-4 justify-center">
            <button
              type="button"
              disabled={loginLoading !== null}
              onClick={() => handleLogin('teacher')}
              className="inline-flex items-center justify-center gap-2 px-8 py-4 bg-gray-900 text-white font-semibold rounded-xl text-lg transition-colors duration-200 hover:bg-gray-700 hover:scale-105 hover:shadow-lg active:scale-95 disabled:opacity-70 disabled:cursor-wait"
            >
              {loginLoading === 'teacher' ? (
                <><RefreshCw className="w-5 h-5 animate-spin mr-2" />登入中…</>
              ) : (<>立即試用<ArrowRight className="w-5 h-5" /></>)}
            </button>
            <button
              type="button"
              disabled={loginLoading !== null}
              onClick={() => handleLogin('student')}
              className="inline-flex items-center justify-center gap-2 px-8 py-4 border-2 border-gray-200 bg-white text-gray-700 font-semibold rounded-xl text-lg transition-colors duration-200 hover:bg-gray-50 hover:scale-105 hover:shadow-lg hover:border-gray-300 active:scale-95 disabled:opacity-70 disabled:cursor-wait"
            >
              {loginLoading === 'student' ? '登入中…' : '學生訂正入口'}
            </button>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-12 bg-gray-950">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-8">
            <div className="sm:col-span-2 lg:col-span-1">
              <div className="flex items-center gap-2">
                <img src="/logo.png" alt="RedPen AI" className="w-8 h-8" />
                <span className="text-xl font-bold text-white">RedPen AI</span>
              </div>
              <p className="mt-4 text-gray-500 text-sm">
                AI 輔助批改作業，讓老師把時間還給教學
              </p>
            </div>

            <div>
              <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">
                快速連結
              </h4>
              <ul className="mt-4 space-y-2">
                <li>
                  <a href={LOGIN_URL} className="text-gray-500 hover:text-white transition-colors text-sm">
                    教師登入
                  </a>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => handleLogin('student')}
                    className="text-gray-500 hover:text-white transition-colors text-sm"
                  >
                    學生訂正入口
                  </button>
                </li>
                <li>
                  <a href={LOGIN_URL} className="text-gray-500 hover:text-white transition-colors text-sm">
                    免費試用
                  </a>
                </li>
              </ul>
            </div>

            <div>
              <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">
                聯絡我們
              </h4>
              <ul className="mt-4 space-y-2">
                <li className="flex items-center gap-2 text-gray-500 text-sm">
                  <Mail className="w-4 h-4" />
                  <a href={`mailto:${SUPPORT_EMAIL}`} className="hover:text-white transition-colors">
                    {SUPPORT_EMAIL}
                  </a>
                </li>
                <li className="flex items-center gap-2 text-gray-500 text-sm">
                  <Phone className="w-4 h-4" />
                  <a href={`tel:${SUPPORT_PHONE.replace(/-/g, '')}`} className="hover:text-white transition-colors">
                    {SUPPORT_PHONE}
                  </a>
                </li>
              </ul>
            </div>

            <div>
              <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">
                開始使用
              </h4>
              <a
                href={LOGIN_URL}
                className="mt-4 inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-white text-gray-900 font-semibold rounded-lg hover:bg-gray-100 transition-colors text-sm"
              >
                立即免費試用
                <ArrowRight className="w-4 h-4" />
              </a>
            </div>
          </div>

          <div className="mt-12 pt-8 border-t border-gray-800 text-center">
            <p className="text-gray-600 text-sm">
              Copyright © 2026 黃政昱. All Rights Reserved.
            </p>
          </div>
        </div>
      </footer>

      <style>{`
        @keyframes fade-in-up {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .animate-fade-in-up {
          animation: fade-in-up 0.6s ease-out forwards;
        }

        .animation-delay-100 {
          animation-delay: 100ms;
        }

        .animation-delay-200 {
          animation-delay: 200ms;
        }

        .animation-delay-300 {
          animation-delay: 300ms;
        }
      `}</style>
    </div>
  )
}
