// 2026-09-13 公開頁共用頁尾（user：footer 不放任何跳轉，只放政策一排；登入後系統頁尾是同一組政策）。
import { PolicyLinks } from './LegalModals'
import { SUPPORT_EMAIL, SUPPORT_PHONE } from '../lib/legal'

export default function PublicFooter() {
  return (
    <footer className="border-t border-gray-100 bg-white py-10">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-3 px-4 text-center text-sm text-gray-500 sm:px-6 lg:px-8">
        <PolicyLinks />
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
          <a href={`mailto:${SUPPORT_EMAIL}`} className="hover:text-gray-900">{SUPPORT_EMAIL}</a>
          <a href={`tel:${SUPPORT_PHONE.replace(/-/g, '')}`} className="hover:text-gray-900">{SUPPORT_PHONE}</a>
        </div>
        <div className="text-gray-400">Copyright © 2026 黃政昱. All Rights Reserved.</div>
      </div>
    </footer>
  )
}
