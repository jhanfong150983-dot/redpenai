import { type ReactNode } from 'react'
import Button from '@/components/ui/Button'

/**
 * 2026-06-01: 共用「墨水花費確認」modal。
 * 任何會消耗墨水（點數）的 AI 動作（智慧批改、重新截取、重新批改、擷取答案卷、產生報告…）都套這個，
 * 確保視覺一致、且每次花費前都有醒目提醒 + 知情同意（同意 / 不同意）。
 *
 * 結構：頂部琥珀色置中警示橫幅（固定）＋ 中間內容框（各處傳入 children）＋ 不同意/同意按鈕（固定）。
 */
export default function InkConfirmModal({
  open,
  warning = '此動作會消耗墨水（點數）',
  confirmLabel = '同意',
  cancelLabel = '不同意',
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean
  /** 琥珀橫幅文字（不含 ⚠️、元件會自動加） */
  warning?: string
  confirmLabel?: string
  cancelLabel?: string
  onConfirm: () => void
  onCancel: () => void
  children?: ReactNode
}) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 px-4">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl">
        {/* 墨水警示橫幅：置中、醒目（固定） */}
        <div className="flex items-center justify-center gap-2 border-b border-amber-200 bg-amber-50 px-6 py-4 text-center">
          <span className="text-base font-bold text-amber-800">⚠️ {warning}</span>
        </div>
        {/* 內容（各處自訂） */}
        <div className="px-6 py-5">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm leading-relaxed text-slate-700">
            {children}
          </div>
        </div>
        {/* 按鈕（固定） */}
        <div className="flex justify-end gap-2 px-6 pb-5">
          <Button variant="outline" onClick={onCancel}>{cancelLabel}</Button>
          <Button variant="primary" onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </div>
    </div>
  )
}
