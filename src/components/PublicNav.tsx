// 2026-09-13 公開頁共用導覽列（user：分頁要是真的分頁、不是捲動；只留 首頁／定價／教學／常見問題）。
//   首頁 /、定價 /pricing、教學 /tutorials、常見問題 /faq 都是獨立路由（App.tsx PUBLIC_PAGE_PATHS）。
//   右側：教師登入（Google OAuth）＋「聯絡我們」（首頁的聯繫區塊；官網採預約導入制、不做自助註冊）。
import { useState } from 'react'
import { buildApiUrl } from '../lib/api-base'

const LOGIN_ENTRY_STORAGE_KEY = 'redpen-login-entry'
const LOGIN_URL = buildApiUrl('/api/auth/google?entry=teacher')

export type PublicNavKey = 'home' | 'pricing' | 'tutorials' | 'faq'

const LINKS: Array<{ key: PublicNavKey; label: string; href: string }> = [
  { key: 'home', label: '首頁', href: '/' },
  { key: 'pricing', label: '定價', href: '/pricing' },
  { key: 'tutorials', label: '教學', href: '/tutorials' },
  { key: 'faq', label: '常見問題', href: '/faq' },
]

export default function PublicNav({ active }: { active: PublicNavKey }) {
  const [loginLoading, setLoginLoading] = useState(false)
  const handleLogin = () => {
    if (typeof window === 'undefined') return
    setLoginLoading(true)
    window.localStorage.setItem(LOGIN_ENTRY_STORAGE_KEY, 'teacher')
    setTimeout(() => { window.location.href = LOGIN_URL }, 100)
  }
  return (
    <nav className="fixed inset-x-0 top-0 z-50 border-b border-gray-100 bg-white/95 backdrop-blur-sm">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-7 px-4 sm:px-6 lg:px-8">
        <a href="/" className="flex items-center gap-2">
          <img src="/logo.png" alt="RedPen AI" className="h-8 w-8" />
          <span className="text-xl font-bold text-gray-900">RedPen AI</span>
        </a>
        <div className="flex items-center gap-5 text-sm font-medium text-gray-500 sm:gap-6">
          {LINKS.map((l) => (
            l.key === active
              ? <span key={l.key} className="font-semibold text-gray-900" aria-current="page">{l.label}</span>
              : <a key={l.key} href={l.href} className="transition-colors hover:text-gray-900">{l.label}</a>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={handleLogin}
            disabled={loginLoading}
            className="hidden rounded-lg border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-70 sm:inline-flex"
          >
            {loginLoading ? '登入中…' : '教師登入'}
          </button>
          <a
            href="/#contact"
            className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-gray-700"
          >
            聯絡我們
          </a>
        </div>
      </div>
    </nav>
  )
}
