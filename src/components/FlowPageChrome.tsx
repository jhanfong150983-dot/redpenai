import type { CSSProperties, ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'

// 2026-09-19 user 拍板：匯入考卷／AI 批改／檢討考卷 三頁頁首、頁尾統一。
// 頁首＝左上「← 返回考卷批改」＋小標籤（步驟名）＋大標題（考卷名）＋副標（班級與狀態）＋右側各頁工具。
// 頁尾＝左進度、右綠色下一步（條件不符＝反灰，不消失）。檢討考卷是最後一步、不放頁尾。
// 字級與間距用 inline style 寫死：檢討考卷頁有自己的 `.ai-report h1／p` 樣式，class 會被蓋掉。

const EYEBROW_STYLE: CSSProperties = {
  fontSize: 12, lineHeight: '16px', fontWeight: 600, letterSpacing: '0.08em', color: '#64748b', margin: 0,
}
const TITLE_STYLE: CSSProperties = {
  fontSize: 24, lineHeight: '32px', fontWeight: 600, color: '#0f172a', margin: '2px 0 0', overflowWrap: 'anywhere',
}
const SUBTITLE_STYLE: CSSProperties = {
  fontSize: 14, lineHeight: '20px', color: '#475569', margin: '4px 0 0',
}

export function FlowPageHeader({
  onBack,
  backLabel = '返回考卷批改',
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  onBack?: () => void
  backLabel?: string
  eyebrow?: string
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="shrink-0 bg-white">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="mb-3 flex items-center gap-2 text-gray-600 hover:text-gray-900 transition-colors"
          style={{ fontSize: 16, lineHeight: '24px' }}
        >
          <ArrowLeft className="w-5 h-5" />
          {backLabel}
        </button>
      )}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 pb-3">
        <div className="min-w-0 flex-1">
          {eyebrow && <div style={EYEBROW_STYLE}>{eyebrow}</div>}
          <h1 style={TITLE_STYLE}>{title}</h1>
          {subtitle && <p style={SUBTITLE_STYLE}>{subtitle}</p>}
        </div>
        {actions && (
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{actions}</div>
        )}
      </div>
    </div>
  )
}

export function FlowPageFooter({
  doneLabel,
  doneCount,
  pendingLabel,
  pendingCount,
  nextLabel,
  onNext,
  nextDisabled = false,
  nextDisabledHint,
  sticky = false,
}: {
  doneLabel: string
  doneCount: number
  pendingLabel: string
  pendingCount: number
  nextLabel?: string
  onNext?: () => void
  nextDisabled?: boolean
  nextDisabledHint?: string
  /** 頁面自己捲動（AI 批改）→ 黏在可視區底部；整頁 flex 版面（匯入考卷）不需要。
   *  App 的捲動容器有 py-4／md:py-5 內距，bottom-0 會在頁尾下方露出一條內容（穿透）
   *  → 用負的 bottom 蓋到容器邊緣，再用等量的 padding-bottom 把按鈕推回原位。 */
  sticky?: boolean
}) {
  return (
    <div
      className={`shrink-0 bg-white border-t border-slate-200 px-4 pt-3 ${sticky ? 'sticky z-10 mt-6 -bottom-4 pb-7 md:-bottom-5 md:pb-8' : 'pb-3'}`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-4 text-sm">
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-full bg-green-500 inline-block" />
            <span className="text-slate-600">
              {doneLabel} <span className="font-semibold text-green-600">{doneCount}</span>
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-full bg-slate-300 inline-block" />
            <span className="text-slate-600">
              {pendingLabel} <span className="font-semibold text-slate-700">{pendingCount}</span>
            </span>
          </span>
        </div>
        {nextLabel && onNext && (
          <button
            type="button"
            onClick={onNext}
            disabled={nextDisabled}
            title={nextDisabled ? nextDisabledHint : undefined}
            className="px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-xl hover:bg-green-700 transition-colors disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed"
          >
            {nextLabel}
          </button>
        )}
      </div>
    </div>
  )
}
