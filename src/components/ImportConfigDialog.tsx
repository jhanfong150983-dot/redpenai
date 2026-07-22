import { useMemo } from 'react'
import { X } from 'lucide-react'
import { NumericInput } from '@/components/NumericInput'
import Button from '@/components/ui/Button'

// ── PDF 檔案資訊（匯入設定對話框用）────────────────────────────────────────

export interface PdfFileInfo {
  file: File
  pageCount: number
  // 校稿後實際使用頁數；未提供時 fallback 用 pageCount
  effectivePageCount?: number
  firstPageUrl: string
}

// ── 學生資訊（未交勾選用）────────────────────────────────────────────────

export interface StudentInfo {
  id: string
  seatNumber: number
  name: string
}

// ── 交錯合併：將多份 PDF 的頁面依學生交叉合併（支援每份 PDF 不同頁數）──────
//   reversedFlags[i]=true → 該份 PDF 學生順序相反（最後一號在前、常見於收卷疊反）：
//   以「學生區塊」為單位反轉、每位學生自己的頁序不動（單面掃描=整份反轉、雙面掃描=正反面順序保持）。

export function interleavePdfPages(
  pdfPages: Blob[][],
  pagesPerStudentPerPdf: number | number[],
  reversedFlags?: boolean[]
): Blob[] {
  if (pdfPages.length === 0) return []

  const perPdfArray = Array.isArray(pagesPerStudentPerPdf)
    ? pagesPerStudentPerPdf
    : pdfPages.map(() => pagesPerStudentPerPdf)

  const chunked = pdfPages.map((pages, i) => {
    const chunkSize = perPdfArray[i] ?? 1
    const chunks: Blob[][] = []
    for (let j = 0; j < pages.length; j += chunkSize) {
      chunks.push(pages.slice(j, j + chunkSize))
    }
    if (reversedFlags?.[i]) chunks.reverse()
    return chunks
  })

  if (pdfPages.length === 1) return chunked[0].flat()

  const maxChunks = Math.max(...chunked.map((c) => c.length))
  const result: Blob[] = []
  for (let ci = 0; ci < maxChunks; ci++) {
    for (const pdfChunks of chunked) {
      if (ci < pdfChunks.length) result.push(...pdfChunks[ci])
    }
  }
  return result
}

// ── 匯入設定對話框 ─────────────────────────────────────────────────────────

export interface ImportConfigDialogProps {
  files: PdfFileInfo[]
  mergeMode: 'concat' | 'interleave'
  onMergeModeChange: (m: 'concat' | 'interleave') => void
  pagesPerStudentPerPdf: number
  onPagesPerStudentPerPdfChange: (n: number) => void
  perPdfPagesArray: number[]
  onPerPdfPagesArrayChange: (arr: number[]) => void
  /** 每份 PDF 是否「順序相反（最後一號在前）」：以學生為單位反轉、每生頁序不動 */
  reversedFlags: boolean[]
  onReversedFlagsChange: (arr: boolean[]) => void
  pagesPerStudent: number
  onPagesPerStudentChange: (n: number) => void
  students: StudentInfo[]
  absentSeatNumbers: Set<number>
  onAbsentSeatNumbersChange: (s: Set<number>) => void
  confirmed: boolean
  onConfirmedChange: (b: boolean) => void
  onConfirm: () => void
  onCancel: () => void
  onBack?: () => void
}

const getEffectiveCount = (info: PdfFileInfo) =>
  info.effectivePageCount ?? info.pageCount

export default function ImportConfigDialog({
  files,
  mergeMode,
  onMergeModeChange,
  onPagesPerStudentPerPdfChange,
  perPdfPagesArray,
  onPerPdfPagesArrayChange,
  reversedFlags,
  onReversedFlagsChange,
  pagesPerStudent,
  onPagesPerStudentChange,
  students,
  absentSeatNumbers,
  onAbsentSeatNumbersChange,
  confirmed,
  onConfirmedChange,
  onConfirm,
  onCancel,
  onBack,
}: ImportConfigDialogProps) {
  const isMultiPdf = files.length > 1
  const isInterleave = isMultiPdf && mergeMode === 'interleave'

  // 計算總頁數和每位學生頁數（依校稿後 effectivePageCount）
  const totalUsablePages = useMemo(() => {
    return files.reduce((sum, info) => sum + getEffectiveCount(info), 0)
  }, [files])

  const effectivePagesPerStudent = useMemo(() => {
    if (isInterleave) {
      return perPdfPagesArray.reduce((sum, n) => sum + n, 0)
    }
    return pagesPerStudent
  }, [isInterleave, perPdfPagesArray, pagesPerStudent])

  const expectedStudentCount = effectivePagesPerStudent > 0
    ? Math.floor(totalUsablePages / effectivePagesPerStudent)
    : 0

  const missingCount = Math.max(0, students.length - expectedStudentCount)
  const excessCount = Math.max(0, expectedStudentCount - students.length)

  // 交錯模式各 PDF 學生數一致性檢查
  const perPdfStudentCounts = useMemo(() => {
    if (!isInterleave) return []
    return files.map((info, i) => {
      const usable = getEffectiveCount(info)
      const ppsp = perPdfPagesArray[i] ?? 1
      return Math.floor(usable / ppsp)
    })
  }, [isInterleave, files, perPdfPagesArray])

  const perPdfConsistent = perPdfStudentCounts.length > 0 &&
    perPdfStudentCounts.every((c) => c === perPdfStudentCounts[0])

  // 未交勾選邏輯
  const sortedStudents = useMemo(
    () => [...students].sort((a, b) => a.seatNumber - b.seatNumber),
    [students]
  )

  const absentCountMatch = absentSeatNumbers.size === missingCount

  const toggleAbsent = (seatNumber: number) => {
    const next = new Set(absentSeatNumbers)
    if (next.has(seatNumber)) {
      next.delete(seatNumber)
    } else {
      if (next.size >= missingCount) return // 不能多勾
      next.add(seatNumber)
    }
    onAbsentSeatNumbersChange(next)
  }

  // 確認按鈕可用條件
  const canConfirm = confirmed &&
    (missingCount === 0 || absentCountMatch) &&
    excessCount === 0 &&
    expectedStudentCount > 0 &&
    (!isInterleave || perPdfConsistent)

  // 同步舊的 pagesPerStudentPerPdf（向後兼容）
  const handlePerPdfPageChange = (index: number, value: number) => {
    const next = [...perPdfPagesArray]
    next[index] = value
    onPerPdfPagesArrayChange(next)
    // 同步到舊的全域值（取第一個，保持向後兼容）
    if (index === 0) onPagesPerStudentPerPdfChange(value)
  }

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[120] p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 flex-shrink-0">
          <h2 className="text-lg font-semibold text-gray-900">📂 匯入設定</h2>
          <button type="button" onClick={onCancel} aria-label="關閉" className="p-2 rounded-full hover:bg-gray-100">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-6 overflow-y-auto flex-1">

          {/* 1. 預覽檔案 */}
          <section>
            <h3 className="text-sm font-semibold text-gray-700 mb-2">預覽檔案</h3>
            <p className="text-xs text-gray-500 mb-3">已完成整份校稿，下方顯示校稿後剩餘頁數。若某份掃描時是從最後一號開始（順序相反），勾選該份的「順序相反」，系統會自動反轉回 1 號開始。</p>
            <div className="flex gap-3 overflow-x-auto pb-1">
              {files.map((info, i) => {
                const eff = getEffectiveCount(info)
                const removed = info.pageCount - eff
                return (
                  <div key={i} className="flex-shrink-0 w-28 text-center">
                    <div className="border border-gray-200 rounded-lg overflow-hidden mb-1.5 bg-gray-50">
                      <img src={info.firstPageUrl} alt={info.file.name} className="w-full h-auto" />
                    </div>
                    <p className="text-xs text-gray-700 truncate font-medium" title={info.file.name}>
                      {info.file.name}
                    </p>
                    <p className="text-xs text-gray-400">
                      {removed > 0 ? `${eff}/${info.pageCount} 頁` : `${eff} 頁`}
                      {' · '}
                      {(info.file.size / 1024 / 1024).toFixed(1)}MB
                    </p>
                    {removed > 0 && (
                      <p className="text-[11px] text-amber-600">已刪除 {removed} 頁</p>
                    )}
                    <label className={`mt-1 inline-flex items-center gap-1 cursor-pointer rounded px-1.5 py-0.5 text-[11px] ${reversedFlags[i] ? 'bg-amber-50 text-amber-700 font-medium' : 'text-gray-500 hover:text-gray-700'}`}>
                      <input
                        type="checkbox"
                        checked={reversedFlags[i] ?? false}
                        onChange={() => {
                          const next = [...reversedFlags]
                          next[i] = !next[i]
                          onReversedFlagsChange(next)
                        }}
                        className="w-3.5 h-3.5 accent-amber-600"
                      />
                      順序相反
                    </label>
                  </div>
                )
              })}
            </div>
          </section>

          {/* 2. 合併方式（多 PDF 才顯示） */}
          {isMultiPdf && (
            <section>
              <h3 className="text-sm font-semibold text-gray-700 mb-1">合併方式</h3>
              <p className="text-xs text-gray-500 mb-3">
                <strong>串接：</strong>將所有 PDF 頁面依序排列（PDF1 全部 → PDF2 全部），
                適合每份考卷所有頁面都在同一個 PDF 裡。<br />
                <strong>交錯：</strong>將多份 PDF 中同一位學生的頁面合在一起
                （PDF1 第1位 + PDF2 第1位 → 合給同一位學生），
                適合同一份考卷的不同部分分散在不同 PDF 裡。
              </p>
              <div className="flex gap-5">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    checked={mergeMode === 'concat'}
                    onChange={() => onMergeModeChange('concat')}
                    className="w-4 h-4 text-green-600 accent-green-600"
                  />
                  <span className="text-sm text-gray-700 font-medium">串接</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    checked={mergeMode === 'interleave'}
                    onChange={() => onMergeModeChange('interleave')}
                    className="w-4 h-4 text-green-600 accent-green-600"
                  />
                  <span className="text-sm text-gray-700 font-medium">交錯</span>
                </label>
              </div>
            </section>
          )}

          {/* 3. 每位學生頁數 */}
          <section>
            {isInterleave ? (
              <>
                <h3 className="text-sm font-semibold text-gray-700 mb-1">
                  每份 PDF 中每位學生幾頁
                </h3>
                <p className="text-xs text-gray-500 mb-3">
                  每一份 PDF 裡，屬於同一位學生的頁數（可各自不同）。
                </p>
                <div className="space-y-2">
                  {files.map((info, i) => {
                    const eff = getEffectiveCount(info)
                    return (
                      <div key={i} className="bg-gray-50 rounded-lg px-3 py-2.5">
                        <div className="flex items-center gap-3">
                          <span className="text-xs text-gray-600 truncate flex-1" title={info.file.name}>
                            {info.file.name}
                            <span className="text-gray-400 ml-1">({eff}頁)</span>
                          </span>
                          <span className="text-xs text-gray-500 whitespace-nowrap">每位學生</span>
                          <NumericInput
                            min={1}
                            max={8}
                            value={perPdfPagesArray[i] ?? 1}
                            onChange={(v) => handlePerPdfPageChange(i, typeof v === 'number' ? v : 1)}
                            className="w-14 px-2 py-1 border border-gray-300 rounded-lg text-sm text-center focus:outline-none focus:ring-2 focus:ring-green-500"
                          />
                          <span className="text-xs text-gray-500">頁</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
                <p className="text-xs text-gray-500 mt-2">
                  合併後每位學生共{' '}
                  <strong>{effectivePagesPerStudent} 頁</strong>
                  {perPdfStudentCounts.length > 0 && (
                    perPdfConsistent
                      ? <span className="text-green-600 ml-2">（各 PDF 均為 {perPdfStudentCounts[0]} 人 ✓）</span>
                      : <span className="text-red-600 ml-2">⚠ 各 PDF 學生數不一致：{perPdfStudentCounts.map((c, i) => `${files[i].file.name.slice(0, 10)}=${c}人`).join('、')}</span>
                  )}
                </p>
              </>
            ) : (
              <>
                <h3 className="text-sm font-semibold text-gray-700 mb-1">每位學生頁數</h3>
                <p className="text-xs text-gray-500 mb-2">
                  每份考卷佔幾頁（例如：2 頁正反面）。系統會依照此數字將頁面依序分配給各位學生。
                </p>
                <NumericInput
                  min={1}
                  max={8}
                  value={pagesPerStudent}
                  onChange={(v) => onPagesPerStudentChange(typeof v === 'number' ? v : 1)}
                  className="w-20 px-2 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              </>
            )}
          </section>

          {/* 4. 學生分配 */}
          <section>
            <h3 className="text-sm font-semibold text-gray-700 mb-1">學生分配</h3>
            {expectedStudentCount > 0 && excessCount === 0 && missingCount === 0 && (
              <p className="text-xs text-green-600 mb-2">
                ✓ PDF 可分配 {expectedStudentCount} 人，與班級人數 {students.length} 人一致
              </p>
            )}
            {excessCount > 0 && (
              <p className="text-xs text-red-600 mb-2">
                ⚠ PDF 可分配 {expectedStudentCount} 人，但班上只有 {students.length} 人，頁數多了 {excessCount} 人份，請回上一步刪除多餘頁面
              </p>
            )}
            {missingCount > 0 && (
              <>
                <p className="text-xs text-amber-700 mb-2">
                  班上 {students.length} 人，PDF 可分配 {expectedStudentCount} 人，有 <strong>{missingCount}</strong> 人未交
                </p>
                <p className="text-xs text-gray-500 mb-2">
                  請勾選未交的學生（需勾選 {missingCount} 位）：
                </p>
                <div className="border border-gray-200 rounded-lg p-3 max-h-40 overflow-y-auto">
                  <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5">
                    {sortedStudents.map((s) => {
                      const isChecked = absentSeatNumbers.has(s.seatNumber)
                      const isFull = absentSeatNumbers.size >= missingCount
                      const isDisabled = !isChecked && isFull
                      return (
                        <label
                          key={s.id}
                          className={`flex items-center gap-1.5 px-2 py-1.5 rounded text-xs cursor-pointer transition-colors ${
                            isChecked
                              ? 'bg-red-50 text-red-700 border border-red-200'
                              : isDisabled
                                ? 'text-gray-300 cursor-not-allowed'
                                : 'text-gray-700 hover:bg-gray-50'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            disabled={isDisabled}
                            onChange={() => toggleAbsent(s.seatNumber)}
                            className="w-3.5 h-3.5 accent-red-500"
                          />
                          <span className="font-medium">{s.seatNumber}</span>
                          <span className="truncate">{s.name}</span>
                        </label>
                      )
                    })}
                  </div>
                </div>
                <p className={`text-xs mt-2 font-medium ${absentCountMatch ? 'text-green-600' : 'text-red-600'}`}>
                  {absentCountMatch
                    ? `✓ 已勾選 ${absentSeatNumbers.size} 位，符合`
                    : `已勾選 ${absentSeatNumbers.size} / ${missingCount} 位，還需勾選 ${missingCount - absentSeatNumbers.size} 位`}
                </p>
              </>
            )}
            {expectedStudentCount === 0 && (
              <p className="text-xs text-red-600">⚠ 依目前設定無法分配任何學生，請檢查頁數設定或回上一步調整校稿結果</p>
            )}
          </section>

          {/* 5. 確認勾選框 */}
          <label className="flex items-start gap-3 cursor-pointer p-3 rounded-xl border-2 border-gray-200 hover:border-green-400 transition-colors">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => onConfirmedChange(e.target.checked)}
              className="w-4 h-4 mt-0.5 accent-green-600"
            />
            <span className="text-sm text-gray-700">我已確認上述設定正確，可以開始匯入</span>
          </label>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 flex justify-between gap-3 flex-shrink-0">
          <div>
            {onBack && (
              <Button type="button" variant="outline" onClick={onBack}>
                ← 返回校稿
              </Button>
            )}
          </div>
          <div className="flex gap-3">
            <Button type="button" variant="outline" onClick={onCancel}>
              取消
            </Button>
            <Button type="button" variant="primary" onClick={onConfirm} disabled={!canConfirm}>
              下一步
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
