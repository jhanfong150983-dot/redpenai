// 2026-09-13 公開頁共用頁尾（user：footer 不放任何跳轉，只放政策一排；登入後系統頁尾是同一組政策）。
import { PolicyLinks } from './LegalModals'
import { SUPPORT_EMAIL, SUPPORT_PHONE } from '../lib/legal'

export default function PublicFooter() {
  return (
    <footer className="border-t border-gray-100 bg-white py-4">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-5 gap-y-1 px-4 text-xs text-gray-500 sm:px-6 lg:px-8">
        <PolicyLinks />
        <span className="text-gray-300">|</span>
        <a href={`mailto:${SUPPORT_EMAIL}`} className="hover:text-gray-900">{SUPPORT_EMAIL}</a>
        <a href={`tel:${SUPPORT_PHONE.replace(/-/g, '')}`} className="hover:text-gray-900">{SUPPORT_PHONE}</a>
        <span className="text-gray-300">|</span>
        <span className="text-gray-400">© 2026 黃政昱</span>
      </div>
    </footer>
  )
}
