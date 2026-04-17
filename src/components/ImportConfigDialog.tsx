import { X } from 'lucide-react'
import { NumericInput } from '@/components/NumericInput'

// ── PDF 檔案資訊（匯入設定對話框用）────────────────────────────────────────

export interface PdfFileInfo {
  file: File
  pageCount: number
  firstPageUrl: string
}

// ── 交錯合併：將多份 PDF 的頁面依學生交叉合併 ─────────────────────────────────

export function interleavePdfPages(pdfPages: Blob[][], pagesPerStudentPerPdf: number): Blob[] {
  if (pdfPages.length === 0) return []
  if (pdfPages.length === 1) return pdfPages[0]

  const chunked = pdfPages.map((pages) => {
    const chunks: Blob[][] = []
    for (let i = 0; i < pages.length; i += pagesPerStudentPerPdf) {
      chunks.push(pages.slice(i, i + pagesPerStudentPerPdf))
    }
    return chunks
  })

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
  pagesPerStudent: number
  onPagesPerStudentChange: (n: number) => void
  startPage: number
  onStartPageChange: (n: number) => void
  endPage: number
  onEndPageChange: (n: number) => void
  maxPage: number
  confirmed: boolean
  onConfirmedChange: (b: boolean) => void
  onConfirm: () => void
  onCancel: () => void
}

export default function ImportConfigDialog({
  files,
  mergeMode,
  onMergeModeChange,
  pagesPerStudentPerPdf,
  onPagesPerStudentPerPdfChange,
  pagesPerStudent,
  onPagesPerStudentChange,
  startPage,
  onStartPageChange,
  endPage,
  onEndPageChange,
  maxPage,
  confirmed,
  onConfirmedChange,
  onConfirm,
  onCancel
}: ImportConfigDialogProps) {
  const isMultiPdf = files.length > 1
  const totalPagesPerStudent =
    isMultiPdf && mergeMode === 'interleave'
      ? pagesPerStudentPerPdf * files.length
      : pagesPerStudent

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 flex-shrink-0">
          <h2 className="text-lg font-semibold text-gray-900">📂 匯入設定</h2>
          <button type="button" onClick={onCancel} className="p-2 rounded-full hover:bg-gray-100">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-6 overflow-y-auto flex-1">

          {/* 1. 預覽檔案 */}
          <section>
            <h3 className="text-sm font-semibold text-gray-700 mb-2">預覽檔案</h3>
            <p className="text-xs text-gray-500 mb-3">請確認下方每個 PDF 的第一頁是否正確。</p>
            <div className="flex gap-3 overflow-x-auto pb-1">
              {files.map((info, i) => (
                <div key={i} className="flex-shrink-0 w-28 text-center">
                  <div className="border border-gray-200 rounded-lg overflow-hidden mb-1.5 bg-gray-50">
                    <img src={info.firstPageUrl} alt={info.file.name} className="w-full h-auto" />
                  </div>
                  <p className="text-xs text-gray-700 truncate font-medium" title={info.file.name}>
                    {info.file.name}
                  </p>
                  <p className="text-xs text-gray-400">{info.pageCount} 頁</p>
                </div>
              ))}
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
            {isMultiPdf && mergeMode === 'interleave' ? (
              <>
                <h3 className="text-sm font-semibold text-gray-700 mb-1">
                  每份 PDF 中每位學生幾頁
                </h3>
                <p className="text-xs text-gray-500 mb-2">
                  每一份 PDF 裡，屬於同一位學生的頁數。合併後每位學生共{' '}
                  <strong>
                    {pagesPerStudentPerPdf} × {files.length} = {totalPagesPerStudent} 頁
                  </strong>
                  。例如：考卷前 2 頁在 PDF1，後 2 頁在 PDF2，請填 2。
                </p>
                <NumericInput
                  min={1}
                  max={8}
                  value={pagesPerStudentPerPdf}
                  onChange={(v) => onPagesPerStudentPerPdfChange(typeof v === 'number' ? v : 1)}
                  className="w-20 px-2 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                />
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

          {/* 4. 頁數範圍 */}
          <section>
            <h3 className="text-sm font-semibold text-gray-700 mb-1">使用頁數範圍</h3>
            <p className="text-xs text-gray-500 mb-2">
              若掃描檔前後有多餘空白頁，可縮小此範圍，只匯入指定頁碼內的頁面（每份 PDF 各自套用）。
            </p>
            <div className="flex items-end gap-3">
              <div>
                <label className="block text-xs text-gray-600 mb-1">開始頁</label>
                <NumericInput
                  min={1}
                  max={maxPage}
                  value={startPage}
                  onChange={(v) => onStartPageChange(typeof v === 'number' ? v : 1)}
                  className="w-20 px-2 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
              <span className="text-gray-400 pb-2">~</span>
              <div>
                <label className="block text-xs text-gray-600 mb-1">結束頁</label>
                <NumericInput
                  min={1}
                  max={maxPage}
                  value={endPage}
                  onChange={(v) => onEndPageChange(typeof v === 'number' ? v : maxPage)}
                  className="w-20 px-2 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
              <span className="text-xs text-gray-400 pb-2">（最多 {maxPage} 頁）</span>
            </div>
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
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3 flex-shrink-0">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!confirmed}
            className="px-4 py-2 text-sm font-semibold text-white bg-green-600 rounded-lg hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
          >
            開始匯入
          </button>
        </div>
      </div>
    </div>
  )
}
