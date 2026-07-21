import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import Button from '@/components/ui/Button'

/**
 * 2026-07-22: 全系統統一「一般確認 / 提示」彈窗，取代散落各頁的 window.confirm / window.alert。
 * 容器樣式對齊 InkConfirmModal / DangerConfirmModal（rounded-2xl、z-[120]、黑半透 backdrop）。
 *
 * 用法（promise 風格、不用各頁自己管 state）：
 *   const confirm = useConfirm()
 *   if (!(await confirm({ title: '刪除作業', message: '…', tone: 'danger' }))) return
 *
 *   const alertModal = useAlertModal()
 *   await alertModal('批改嚴格度已變更…')
 *
 * tone：
 *  - danger  紅色橫幅（刪除/清除批改等破壞性動作）、確定鈕紅色
 *  - warning 琥珀橫幅（會覆蓋/影響既有資料）
 *  - ink     琥珀「消耗墨水」橫幅（花錢動作、文案同 InkConfirmModal）
 *  - neutral 無橫幅（一般確認/提示）
 */
export type ConfirmTone = 'danger' | 'warning' | 'ink' | 'neutral'

export interface ConfirmModalOptions {
  title?: string
  message: ReactNode
  tone?: ConfirmTone
  confirmLabel?: string
  cancelLabel?: string
  /** true = 只有「確定」鈕（取代 window.alert） */
  alertOnly?: boolean
}

type PendingConfirm = ConfirmModalOptions & { resolve: (ok: boolean) => void }

const ConfirmContext = createContext<((opts: ConfirmModalOptions) => Promise<boolean>) | null>(null)

export function useConfirm() {
  const fn = useContext(ConfirmContext)
  if (!fn) throw new Error('useConfirm 必須在 <ConfirmProvider> 內使用')
  return fn
}

/** window.alert 的替代：單鈕提示，await 到使用者按「確定」 */
export function useAlertModal() {
  const confirm = useConfirm()
  return useCallback(
    async (message: ReactNode, opts?: Omit<ConfirmModalOptions, 'message' | 'alertOnly'>) => {
      await confirm({ message, alertOnly: true, tone: 'neutral', ...opts })
    },
    [confirm],
  )
}

const TONE_BANNER: Record<Exclude<ConfirmTone, 'neutral'>, { cls: string; defaultText: string }> = {
  danger: { cls: 'border-red-200 bg-red-50 text-red-800', defaultText: '此動作無法復原' },
  warning: { cls: 'border-amber-200 bg-amber-50 text-amber-800', defaultText: '請確認後再繼續' },
  ink: { cls: 'border-amber-200 bg-amber-50 text-amber-800', defaultText: '此動作會消耗墨水（點數）' },
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  // 佇列：同時多個請求時逐一顯示
  const [queue, setQueue] = useState<PendingConfirm[]>([])
  const current = queue[0] ?? null

  const confirm = useCallback((opts: ConfirmModalOptions) => {
    return new Promise<boolean>((resolve) => {
      setQueue((q) => [...q, { ...opts, resolve }])
    })
  }, [])

  const settle = useCallback((ok: boolean) => {
    setQueue((q) => {
      const [head, ...rest] = q
      head?.resolve(ok)
      return rest
    })
  }, [])

  // Esc = 取消（alertOnly 時 = 確定）
  const settleRef = useRef(settle)
  settleRef.current = settle
  const hasCurrent = !!current
  const currentAlertOnly = !!current?.alertOnly
  useEffect(() => {
    if (!hasCurrent) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') settleRef.current(currentAlertOnly)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hasCurrent, currentAlertOnly])

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {current && (
        // z-[700]：要壓過所有功能型 overlay（大 modal 120/130、圖片放大 300-600），只讓 tutorial(9998+) 更高
        <div className="fixed inset-0 z-[700] flex items-center justify-center bg-black/50 px-4">
          <div className="w-full max-w-md overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl">
            {current.tone && current.tone !== 'neutral' && (
              <div
                className={`flex items-center justify-center gap-2 border-b px-6 py-4 text-center ${TONE_BANNER[current.tone].cls}`}
              >
                <span className="text-base font-bold">
                  ⚠️ {current.title ?? TONE_BANNER[current.tone].defaultText}
                </span>
              </div>
            )}
            <div className="px-6 py-5">
              {(!current.tone || current.tone === 'neutral') && current.title && (
                <div className="mb-3 text-base font-bold text-slate-900">{current.title}</div>
              )}
              <div className="whitespace-pre-line rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm leading-relaxed text-slate-700">
                {current.message}
              </div>
            </div>
            <div className="flex justify-end gap-2 px-6 pb-5">
              {!current.alertOnly && (
                <Button variant="outline" onClick={() => settle(false)}>
                  {current.cancelLabel ?? '取消'}
                </Button>
              )}
              <Button
                variant={current.tone === 'danger' ? 'destructive' : 'primary'}
                onClick={() => settle(true)}
              >
                {current.confirmLabel ?? '確定'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  )
}
