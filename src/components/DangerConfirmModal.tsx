import { useEffect, useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'

export interface DangerConfirmAffected {
  id: string
  label: string
  meta?: string
}

export interface DangerConfirmModalProps {
  open: boolean
  title: string
  /** high=核彈級(不可逆、清訂正)、medium=清讀值、low=覆寫分數 */
  severity?: 'high' | 'medium' | 'low'
  /** 會被清除的東西（紅色標籤、資料驅動取代手寫 prose） */
  clears?: string[]
  /** 會保留的東西（綠色標籤、消除「連照片都刪了?」的疑慮） */
  keeps?: string[]
  /** 受影響的逐項清單（可折疊） */
  affected?: DangerConfirmAffected[]
  /** 影響清單的量詞，預設「項」 */
  affectedNoun?: string
  /** 灰色弱確定鈕文字 */
  confirmLabel?: string
  /** 彩色主取消鈕文字 */
  cancelLabel?: string
  /** 有值時顯示勾選同意框；勾了才解鎖確定鈕（severity=high 用） */
  acknowledgeText?: string
  /** 有值時在按鈕上方顯示墨水花費提醒（琥珀色），用於會扣點數的 AI 動作 */
  inkNote?: string
  /** 執行中 → 鎖鈕、確定鈕轉 spinner */
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

const SEVERITY_ICON: Record<'high' | 'medium' | 'low', string> = {
  high: 'text-rose-600',
  medium: 'text-amber-500',
  low: 'text-slate-500',
}

/**
 * 三個批改重跑入口（更換答案卷 / Phase A / Phase B）共用的「危險操作確認」視窗。
 * 反直覺設計：取消＝彩色主鈕（安全選項放大）、確定＝灰色弱鈕（破壞選項弱化）。
 * 「會清除什麼」用 clears/keeps 標籤資料驅動，呼叫端不必再手寫警告文字。
 */
export default function DangerConfirmModal({
  open,
  title,
  severity = 'medium',
  clears = [],
  keeps = [],
  affected = [],
  affectedNoun = '項',
  confirmLabel = '確定',
  cancelLabel = '取消',
  acknowledgeText,
  inkNote,
  busy = false,
  onConfirm,
  onCancel,
}: DangerConfirmModalProps) {
  const [acknowledged, setAcknowledged] = useState(false)

  // 每次開啟重置勾選
  useEffect(() => {
    if (open) setAcknowledged(false)
  }, [open])

  // ESC → 取消（執行中不允許）
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onCancel])

  if (!open) return null

  const needAck = Boolean(acknowledgeText)
  const confirmDisabled = busy || (needAck && !acknowledged)

  return (
    <div
      className="fixed inset-0 bg-black/50 z-[130] flex items-center justify-center"
      onClick={() => { if (!busy) onCancel() }}
    >
      <div
        className="bg-white rounded-xl border border-slate-200 p-6 max-w-md w-full mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 mb-4">
          <AlertTriangle className={`w-6 h-6 shrink-0 ${SEVERITY_ICON[severity]}`} />
          <h3 className="text-lg font-bold text-gray-900">{title}</h3>
        </div>

        {clears.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 mb-2">
            <span className="text-sm text-gray-500 mr-1">會清除</span>
            {clears.map((c) => (
              <span key={c} className="px-2 py-0.5 rounded-md bg-rose-50 text-rose-700 text-xs font-medium border border-rose-100">
                {c}
              </span>
            ))}
          </div>
        )}

        {keeps.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 mb-3">
            <span className="text-sm text-gray-500 mr-1">會保留</span>
            {keeps.map((k) => (
              <span key={k} className="px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 text-xs font-medium border border-emerald-100">
                {k}
              </span>
            ))}
          </div>
        )}

        {affected.length > 0 && (
          <details className="mb-3 group">
            <summary className="text-sm text-gray-600 cursor-pointer select-none list-none flex items-center gap-1">
              <span className="text-gray-400 group-open:rotate-90 transition-transform">▸</span>
              影響 {affected.length} {affectedNoun}（點擊展開）
            </summary>
            <div className="mt-2 max-h-52 overflow-y-auto border border-gray-100 rounded-lg">
              <ul className="text-sm divide-y divide-gray-100">
                {affected.map((a) => (
                  <li key={a.id} className="px-3 py-2 flex justify-between items-center">
                    <span className="text-gray-700">{a.label}</span>
                    {a.meta && <span className="text-xs text-gray-500">{a.meta}</span>}
                  </li>
                ))}
              </ul>
            </div>
          </details>
        )}

        {needAck && (
          <label className="flex items-start gap-2 mb-4 p-3 rounded-lg bg-rose-50 border border-rose-100 cursor-pointer">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5 w-4 h-4 accent-rose-600"
            />
            <span className="text-sm text-rose-800">{acknowledgeText}</span>
          </label>
        )}

        {inkNote && (
          <div className="mb-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm font-medium text-amber-800 text-center">
            ⚠️ {inkNote}
          </div>
        )}

        {/* 反直覺：取消＝彩色主鈕、確定＝灰色弱鈕 */}
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            disabled={busy}
            className="flex-1 px-4 py-3 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 disabled:opacity-50 transition-colors font-semibold"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            disabled={confirmDisabled}
            className="flex-1 px-4 py-3 bg-gray-100 text-gray-600 rounded-xl hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium flex items-center justify-center gap-2"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
