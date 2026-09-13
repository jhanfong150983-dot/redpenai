// 聯絡我們（公開頁 /contact）。2026-09-13 從首頁的聯繫區塊獨立成分頁（user：所有「預約導入」統一改「聯絡我們」並跳到這裡）。
//   官網採預約導入制、不做自助註冊：Email（帶好問題範本）＋ LINE 官方帳號（QR）＋電話。
import { useEffect, useState } from 'react'
import { ArrowRight, Mail, MessageCircle, Phone } from 'lucide-react'
import PublicNav from '../components/PublicNav'
import PublicFooter from '../components/PublicFooter'
import { SUPPORT_EMAIL, SUPPORT_PHONE, LINE_OA_URL } from '../lib/legal'
import { buildApiUrl } from '../lib/api-base'

const PAGE_TITLE = 'RedPen AI 聯絡我們'
const PAGE_DESC = '用你自己的一份考卷示範完整流程，再決定要不要用。Email、LINE 官方帳號、電話。'
const LOGIN_ENTRY_STORAGE_KEY = 'redpen-login-entry'
const LOGIN_URL = buildApiUrl('/api/auth/google?entry=teacher')
const CONTACT_MAIL = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('RedPen AI 導入洽詢')}&body=${encodeURIComponent('學校／單位：\n聯絡人／職稱：\n聯絡電話：\n任教領域與班級數：\n想先了解的事：\n')}`

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

export default function ContactPage() {
  usePageMeta()
  const [loginLoading, setLoginLoading] = useState(false)
  const handleLogin = () => {
    if (typeof window === 'undefined') return
    setLoginLoading(true)
    window.localStorage.setItem(LOGIN_ENTRY_STORAGE_KEY, 'teacher')
    setTimeout(() => { window.location.href = LOGIN_URL }, 100)
  }
  return (
    <div className="min-h-screen bg-white">
      <PublicNav active="contact" />
      <main className="mx-auto max-w-5xl px-4 pb-24 pt-32 sm:px-6 lg:px-8">
        <div className="text-center">
          <h1 className="text-4xl font-black tracking-tight text-gray-900 sm:text-5xl">聯絡我們</h1>
          <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-gray-500">
            先聊一次，用你自己的一份考卷示範完整流程，再決定要不要用。
          </p>
        </div>

        <div className="mt-12 grid gap-5 sm:grid-cols-2">
          <div className="flex flex-col rounded-2xl border border-gray-200 bg-white p-7">
            <Mail className="h-6 w-6 text-gray-900" />
            <h2 className="mt-4 text-xl font-bold text-gray-900">Email 洽詢</h2>
            <p className="mt-2 flex-1 leading-relaxed text-gray-500">
              告訴我們學校／單位、任教領域與班級數，我們會回覆導入方式與時間。
            </p>
            <a href={CONTACT_MAIL}
              className="mt-6 inline-flex items-center justify-center gap-2 rounded-xl bg-gray-900 px-6 py-3.5 font-semibold text-white transition-colors hover:bg-gray-700">
              寄信給我們<ArrowRight className="h-4 w-4" />
            </a>
            <p className="mt-3 text-center text-sm text-gray-400">{SUPPORT_EMAIL}</p>
          </div>

          <div className="flex flex-col rounded-2xl border border-gray-200 bg-white p-7">
            <MessageCircle className="h-6 w-6" style={{ color: '#06C755' }} />
            <h2 className="mt-4 text-xl font-bold text-gray-900">LINE 官方帳號</h2>
            <p className="mt-2 leading-relaxed text-gray-500">
              想先問幾個問題最快的方式。手機直接點加入，電腦可掃右邊 QR。
            </p>
            <div className="mt-5 flex flex-1 items-end gap-5">
              <a href={LINE_OA_URL} target="_blank" rel="noreferrer"
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl px-6 py-3.5 font-semibold text-white transition-opacity hover:opacity-90"
                style={{ backgroundColor: '#06C755' }}>
                加入 LINE 好友
              </a>
              <img src="/site/line-qr.png" alt="RedPen AI LINE 官方帳號 QR Code" className="h-24 w-24 flex-shrink-0 rounded-lg border border-gray-100" loading="lazy" />
            </div>
          </div>
        </div>

        <p className="mt-8 flex items-center justify-center gap-2 text-sm text-gray-500">
          <Phone className="h-4 w-4" />
          <a href={`tel:${SUPPORT_PHONE.replace(/-/g, '')}`} className="hover:text-gray-900">{SUPPORT_PHONE}</a>
        </p>
        <p className="mt-4 text-center text-sm text-gray-400">
          已經是使用者？
          <button type="button" disabled={loginLoading} onClick={handleLogin}
            className="ml-1 font-semibold text-gray-600 underline decoration-gray-300 transition-colors hover:text-gray-900 disabled:opacity-70">
            {loginLoading ? '登入中…' : '教師登入'}
          </button>
        </p>
      </main>
      <PublicFooter />
    </div>
  )
}
