// 2026-08-29 座號辨識匯入確認畫面（第 3 期）：
//   劃卡辨識結果 → 「頁 → 座號 → 學生」對照，老師必過目才寫入（配錯學生是最嚴重的錯）。
//   紅=需處理（認不出/座號不在名冊）、琥珀=頁數與作業設定不符；每頁可改指定座號或略過。
//   輸出型別對齊 PdfImportPreviewResult，直接重用既有覆蓋確認＋儲存管線。
import { useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle, X } from 'lucide-react'
import Button from '@/components/ui/Button'
import type {
  PdfImportPreviewResult,
  PdfImportPreviewStudent
} from '@/components/PdfImportPreviewDialog'
import type { OmrPageResult } from '@/lib/omrRecognition'

export interface OmrPageItem {
  id: string
  blob: Blob
  url: string
  originLabel: string
  result: OmrPageResult
}

interface OmrImportConfirmDialogProps {
  pages: OmrPageItem[]
  students: PdfImportPreviewStudent[]
  pagesPerStudent: number
  onConfirm: (result: PdfImportPreviewResult) => void | Promise<void>
  onCancel: () => void
}

const SKIP = '__skip__'
const UNASSIGNED = '__unassigned__'

export default function OmrImportConfirmDialog({
  pages,
  students,
  pagesPerStudent,
  onConfirm,
  onCancel
}: OmrImportConfirmDialogProps) {
  const seatToStudent = useMemo(
    () => new Map(students.map((s) => [s.seatNumber, s])),
    [students]
  )

  // 每頁指定值：座號字串 / SKIP / UNASSIGNED；初值=辨識結果（座號不在名冊也先帶入、標紅）
  const [assign, setAssign] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {}
    for (const p of pages) {
      init[p.id] = p.result.seatNumber != null ? String(p.result.seatNumber) : UNASSIGNED
    }
    return init
  })
  const [isSubmitting, setIsSubmitting] = useState(false)

  const pageState = (p: OmrPageItem) => {
    const a = assign[p.id]
    if (a === SKIP) return 'skip' as const
    if (a === UNASSIGNED) return 'unassigned' as const
    if (!seatToStudent.has(Number(a))) return 'notInRoster' as const
    return 'ok' as const
  }

  const perSeatCount = useMemo(() => {
    const m = new Map<number, number>()
    for (const p of pages) {
      const a = assign[p.id]
      if (a === SKIP || a === UNASSIGNED) continue
      const seat = Number(a)
      m.set(seat, (m.get(seat) ?? 0) + 1)
    }
    return m
  }, [pages, assign])

  const problemCount = pages.filter((p) => {
    const s = pageState(p)
    return s === 'unassigned' || s === 'notInRoster'
  }).length
  const autoOkCount = pages.filter((p) => p.result.seatNumber != null).length
  const mismatchSeats = [...perSeatCount.entries()].filter(([, c]) => c !== pagesPerStudent)

  const canConfirm = problemCount === 0 && perSeatCount.size > 0 && !isSubmitting

  const handleConfirm = async () => {
    if (!canConfirm) return
    setIsSubmitting(true)
    try {
      const perStudent = students
        .map((student) => ({
          student,
          pageBlobs: pages
            .filter((p) => assign[p.id] === String(student.seatNumber))
            .map((p) => p.blob) // pages 已是掃描順序
        }))
        .filter((x) => x.pageBlobs.length > 0)
      await onConfirm({ perStudent })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">座號辨識結果確認</h2>
            <p className="text-sm text-slate-500">
              共 {pages.length} 頁，自動辨識 {autoOkCount} 頁
              {problemCount > 0 && (
                <span className="ml-2 font-medium text-red-600">需處理 {problemCount} 頁</span>
              )}
            </p>
          </div>
          <button type="button" onClick={onCancel} className="rounded-xl p-2 hover:bg-slate-100">
            <X className="h-5 w-5 text-slate-600" />
          </button>
        </div>

        {/* 學生彙總列 */}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-100 bg-slate-50 px-5 py-2">
          {[...perSeatCount.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([seat, count]) => {
              const stu = seatToStudent.get(seat)
              const ok = count === pagesPerStudent
              return (
                <span
                  key={seat}
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
                    ok ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'
                  }`}
                  title={ok ? undefined : `頁數 ${count}，與作業設定的每生 ${pagesPerStudent} 頁不同`}
                >
                  {ok ? <CheckCircle className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
                  {String(seat).padStart(2, '0')} {stu?.name ?? '不在名冊'}（{count} 頁）
                </span>
              )
            })}
          {perSeatCount.size === 0 && (
            <span className="text-xs text-slate-500">尚無任何頁面完成指定</span>
          )}
        </div>

        {/* 頁面卡片 */}
        <div className="grid flex-1 grid-cols-2 gap-3 overflow-y-auto p-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {pages.map((p) => {
            const state = pageState(p)
            const border =
              state === 'ok'
                ? 'border-slate-200'
                : state === 'skip'
                  ? 'border-slate-200 opacity-50'
                  : 'border-red-400 ring-1 ring-red-300'
            return (
              <div key={p.id} className={`flex flex-col overflow-hidden rounded-xl border-2 bg-white ${border}`}>
                <div className="flex items-center justify-between bg-slate-50 px-2 py-1">
                  <span className="truncate text-[11px] text-slate-600" title={p.originLabel}>
                    {p.originLabel}
                  </span>
                  {p.result.seatNumber != null ? (
                    <span className="shrink-0 rounded bg-green-600 px-1.5 py-0.5 text-[11px] font-bold text-white">
                      {String(p.result.seatNumber).padStart(2, '0')}
                    </span>
                  ) : (
                    <span className="shrink-0 rounded bg-red-500 px-1.5 py-0.5 text-[10px] font-medium text-white">
                      {p.result.anchorsFound ? '劃卡認不出' : '無標頭'}
                    </span>
                  )}
                </div>
                <div className="aspect-[3/4] overflow-hidden bg-white">
                  <img src={p.url} alt={p.originLabel} className="h-full w-full object-contain" draggable={false} />
                </div>
                {p.result.handwrittenCropUrl && (
                  <div className="border-t border-slate-100 bg-slate-50 px-2 py-1">
                    <div className="text-[10px] text-slate-400">手寫座號（核對用）</div>
                    <img src={p.result.handwrittenCropUrl} alt="手寫座號" className="h-8 object-contain" draggable={false} />
                  </div>
                )}
                <select
                  value={assign[p.id]}
                  onChange={(e) => setAssign((prev) => ({ ...prev, [p.id]: e.target.value }))}
                  className={`m-2 rounded-lg border px-2 py-1.5 text-xs outline-none ${
                    state === 'unassigned' || state === 'notInRoster'
                      ? 'border-red-400 text-red-700'
                      : 'border-slate-300 text-slate-700'
                  }`}
                >
                  <option value={UNASSIGNED}>— 請指定座號 —</option>
                  {state === 'notInRoster' && (
                    <option value={assign[p.id]}>辨識為 {assign[p.id]} 號（不在名冊）</option>
                  )}
                  {students.map((s) => (
                    <option key={s.id} value={String(s.seatNumber)}>
                      {String(s.seatNumber).padStart(2, '0')} {s.name}
                    </option>
                  ))}
                  <option value={SKIP}>略過此頁（不匯入）</option>
                </select>
              </div>
            )
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 border-t border-slate-200 px-5 py-3">
          <div className="text-xs text-slate-500">
            {mismatchSeats.length > 0 && (
              <span className="text-amber-700">
                ⚠ {mismatchSeats.length} 位學生的頁數與每生 {pagesPerStudent} 頁不符，請確認後再匯入。
              </span>
            )}
            {problemCount > 0 && (
              <span className="ml-2 text-red-600">紅框頁面請指定座號或選擇略過。</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={onCancel} disabled={isSubmitting}>
              取消
            </Button>
            <Button onClick={() => void handleConfirm()} disabled={!canConfirm}>
              {isSubmitting ? '匯入中…' : `確認匯入（${perSeatCount.size} 位學生）`}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
