// 2026-09-22 自備作文稿紙的「稿紙設定」（user 拍板：可選會考稿紙／學測稿紙／自備稿紙；前兩者直接帶入不用上傳、
//   自備稿紙要上傳空白稿紙）。自備：上傳空白稿紙 PDF → 在第 1 頁框格區 → 填行數×每行格數（＋有沒有窄欄）→ 預覽切格。
//   批改時 server 把老師的空白稿紙與學生卷疊合、再把格子投過去（顏色無關、黑白也可），所以：
//   ⛔ 上傳的空白稿紙必須和學生寫的那張**一模一樣**（同一個檔印的），否則疊不上。
import { useEffect, useMemo, useState } from 'react'
import { Upload, Crop } from 'lucide-react'
import PageBboxEditorModal from '@/components/PageBboxEditorModal'
import { convertPdfToImages, getFileType, PDF_ONLY_MSG } from '@/lib/pdfToImage'
import { BUILTIN_ESSAY_SHEETS, type EssaySheetChoice, type CustomEssaySheetInput } from '@/lib/essayByoPreset'

export interface CustomSheetState extends CustomEssaySheetInput {
  /** 這次上傳的空白稿紙頁圖（存檔時上傳當疊合模板）；編輯既有卷沒重傳＝空 */
  blobs: Blob[]
}

interface Props {
  choice: EssaySheetChoice
  onChoice: (c: EssaySheetChoice) => void
  grade?: number | ''
  custom: CustomSheetState
  onCustom: (next: CustomSheetState) => void
  /** 編輯既有卷且當初是自備稿紙：顯示「已存」而不強迫重傳 */
  savedCustomPages?: number
  disabled?: boolean
}

const CHOICES: Array<{ key: EssaySheetChoice; name: string; hint: string }> = [
  { key: 'cap', name: '會考稿紙', hint: BUILTIN_ESSAY_SHEETS.cap.hint + '；直接帶入、不必上傳' },
  { key: 'gsat', name: '學測稿紙', hint: BUILTIN_ESSAY_SHEETS.gsat.hint + '；直接帶入、不必上傳' },
  { key: 'custom', name: '自備稿紙', hint: '上傳學校自己的空白稿紙，框出格區、填行列數' },
]

export default function EssaySheetSetup({ choice, onChoice, grade, custom, onCustom, savedCustomPages = 0, disabled }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 開編輯器時要框哪一頁（0-based）；第 2 頁沒另外框＝沿用第 1 頁
  const [editorPage, setEditorPage] = useState(0)
  const [editorOpen, setEditorOpen] = useState(false)
  const gridOf = (p: number) => custom.grids.find((g) => g.page === p + 1)?.box ?? custom.grids.find((g) => g.page === 1)?.box ?? null
  const previewUrls = useMemo(() => custom.blobs.map((b) => URL.createObjectURL(b)), [custom.blobs])
  useEffect(() => () => { previewUrls.forEach((u) => URL.revokeObjectURL(u)) }, [previewUrls])

  const onUpload = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    if (getFileType(file) !== 'pdf') { setError(PDF_ONLY_MSG); return }
    setBusy(true)
    try {
      // 疊合服務內部統一縮到寬 1200；這裡 1600 夠用、也給老師框格區看
      const blobs = await convertPdfToImages(file, { maxWidth: 1600, minWidth: 1200, quality: 0.9 })
      if (!blobs.length) throw new Error('PDF 沒有可用頁面')
      if (blobs.length > 2) throw new Error('空白稿紙最多 2 頁（正反面），這份有 ' + blobs.length + ' 頁')
      onCustom({ ...custom, blobs, pages: blobs.length, grids: [] })
    } catch (e) {
      setError(e instanceof Error ? e.message : '讀取失敗')
    } finally { setBusy(false) }
  }

  const box = custom.grids[0]?.box ?? null
  const scoring = choice === 'gsat' || (choice === 'custom' && typeof grade === 'number' && grade >= 10) ? '學測 25 分制' : '會考 6 級分'

  // 預覽切格：依框＋行列數畫線（與 server essayTemplateCells 同一套均分規則）；每頁用自己的框（沒有＝第 1 頁的）
  const linesFor = (box: { x: number; y: number; w: number; h: number } | null) => {
    if (!box) return null
    const pitch = box.w / Math.max(1, custom.cols)
    const cellW = pitch * (custom.gutter ? 0.8 : 1)
    const cellH = box.h / Math.max(1, custom.rows)
    const v: number[] = [], vCell: number[] = []
    for (let c = 0; c <= custom.cols; c++) v.push(box.x + box.w - c * pitch)
    if (custom.gutter) for (let c = 0; c < custom.cols; c++) vCell.push(box.x + box.w - c * pitch - pitch + cellW)
    const h: number[] = []
    for (let r = 0; r <= custom.rows; r++) h.push(box.y + r * cellH)
    return { v, vCell, h, box }
  }

  return (
    <div className="mb-3 rounded border border-violet-200 bg-violet-50/60 px-3 py-2.5 text-[12px] text-violet-950 leading-relaxed">
      <div className="font-semibold mb-1.5">稿紙</div>
      <div className="flex flex-wrap gap-1.5 mb-1.5">
        {CHOICES.map((c) => (
          <button key={c.key} type="button" disabled={disabled} onClick={() => onChoice(c.key)} title={c.hint}
            className={`px-2.5 py-1 rounded border text-[12px] ${choice === c.key ? 'bg-white border-violet-500 text-violet-900 font-semibold shadow-sm' : 'bg-white/60 border-violet-200 text-violet-700 hover:border-violet-400'}`}>
            {c.name}
          </button>
        ))}
        <span className="self-center text-[11px] text-violet-700">評分：{scoring}</span>
      </div>
      {choice !== 'custom' && (
        <div className="text-[11px] text-violet-800">
          {BUILTIN_ESSAY_SHEETS[choice].label}——{BUILTIN_ESSAY_SHEETS[choice].hint}。學生請寫在這張公版稿紙上（印出來即可）；
          批改時系統把學生卷疊到公版上找出每一格，彩色或黑白掃描都可以。
        </div>
      )}
      {choice === 'custom' && (
        <div className="space-y-2">
          <div className="text-[11px] text-violet-800">
            上傳<b>空白</b>稿紙（PDF，1～2 頁），要和發給學生的那張<b>一模一樣</b>（同一個檔印的）。然後用一個矩形把<b>整片格子</b>框起來、填行數與每行格數，系統就能切出每一格。
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-violet-400 bg-white text-violet-900 text-[12px] font-medium ${disabled || busy ? 'opacity-50' : 'cursor-pointer hover:bg-violet-100'}`}>
              <Upload className="w-3.5 h-3.5" />{busy ? '讀取中…' : custom.blobs.length ? '重新上傳空白稿紙' : '上傳空白稿紙 PDF'}
              <input type="file" accept=".pdf,application/pdf" className="hidden" disabled={disabled || busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void onUpload(f) }} />
            </label>
            {custom.blobs.length > 0 && <span className="text-[11px]">已上傳 {custom.blobs.length} 頁</span>}
            {!custom.blobs.length && savedCustomPages > 0 && <span className="text-[11px]">已存 {savedCustomPages} 頁（不重傳就沿用）</span>}
            <button type="button" disabled={disabled || !custom.blobs.length} onClick={() => { setEditorPage(0); setEditorOpen(true) }}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-violet-400 bg-white text-violet-900 text-[12px] font-medium disabled:opacity-50 hover:bg-violet-100">
              <Crop className="w-3.5 h-3.5" />{box ? '重新框整片格子' : '框出整片格子'}
            </button>
            {custom.blobs.length > 1 && box && (
              <button type="button" disabled={disabled} onClick={() => { setEditorPage(1); setEditorOpen(true) }} title="背面的格子位置和正面不同時才需要；沒框＝沿用第 1 頁的框"
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-violet-300 bg-white text-violet-800 text-[12px] disabled:opacity-50 hover:bg-violet-100">
                <Crop className="w-3.5 h-3.5" />{custom.grids.some((g) => g.page === 2) ? '重新框第 2 頁' : '另外框第 2 頁'}
              </button>
            )}
            <label className="inline-flex items-center gap-1 text-[12px]">行數
              <input type="number" min={1} max={60} value={custom.cols} disabled={disabled} onChange={(e) => onCustom({ ...custom, cols: Math.max(1, Math.min(60, Number(e.target.value) || 1)) })} className="w-14 px-1.5 py-0.5 border border-violet-300 rounded text-center" />
            </label>
            <label className="inline-flex items-center gap-1 text-[12px]">每行格數
              <input type="number" min={1} max={40} value={custom.rows} disabled={disabled} onChange={(e) => onCustom({ ...custom, rows: Math.max(1, Math.min(40, Number(e.target.value) || 1)) })} className="w-14 px-1.5 py-0.5 border border-violet-300 rounded text-center" />
            </label>
            <label className="inline-flex items-center gap-1 text-[12px]">
              <input type="checkbox" checked={custom.gutter} disabled={disabled} onChange={(e) => onCustom({ ...custom, gutter: e.target.checked })} />每行右側有窄欄（會考式）
            </label>
          </div>
          {error && <div className="text-[11px] text-red-700">{error}</div>}
          {previewUrls.length > 0 && (
            <div className="flex flex-wrap gap-3">
              {previewUrls.map((url, i) => {
                const gl = linesFor(gridOf(i))
                const own = custom.grids.some((g) => g.page === i + 1)
                return (
                  <div key={i} className="inline-block max-w-full">
                    <div className="text-[11px] text-violet-800 mb-0.5">第 {i + 1} 頁{i > 0 ? (own ? '（已另外框）' : '（沿用第 1 頁的框）') : ''}</div>
                    <div className="relative inline-block border border-violet-200 bg-white rounded overflow-hidden">
                      <img src={url} alt={`空白稿紙第 ${i + 1} 頁`} className="block max-h-72 w-auto" />
                      {gl && (
                        <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 1 1" preserveAspectRatio="none">
                          {gl.v.map((x, k) => <line key={`v${k}`} x1={x} y1={gl.box.y} x2={x} y2={gl.box.y + gl.box.h} stroke="#7c3aed" strokeWidth={k === 0 || k === gl.v.length - 1 ? 0.004 : 0.0015} />)}
                          {gl.vCell.map((x, k) => <line key={`vc${k}`} x1={x} y1={gl.box.y} x2={x} y2={gl.box.y + gl.box.h} stroke="#a78bfa" strokeWidth={0.001} strokeDasharray="0.01 0.01" />)}
                          {gl.h.map((y, k) => <line key={`h${k}`} x1={gl.box.x} y1={y} x2={gl.box.x + gl.box.w} y2={y} stroke="#7c3aed" strokeWidth={k === 0 || k === gl.h.length - 1 ? 0.004 : 0.0015} />)}
                        </svg>
                      )}
                      {!gl && i === 0 && <div className="absolute inset-x-0 bottom-0 bg-violet-900/70 text-white text-[11px] px-2 py-1">請按「框出整片格子」：用一個矩形把所有格子一次框起來——從最右上那一格的外緣拉到最左下那一格的外緣，不含旁邊的標題與說明文字</div>}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          {box && (
            <div className="text-[11px] text-violet-800">
              預覽的紫線要壓在稿紙的每一條印刷格線上才算對（只有一條或對不齊＝框錯或行數、格數填錯）；不對就重框，或調整行數／格數／窄欄。第 2 頁{custom.grids.some((g) => g.page === 2) ? '已另外框' : '沿用第 1 頁的框（背面格子位置不同時請按「另外框第 2 頁」）'}。
            </div>
          )}
        </div>
      )}
      {editorOpen && custom.blobs.length > 0 && (
        <PageBboxEditorModal
          pageBlobs={custom.blobs}
          questionId="格區"
          initialPage={editorPage}
          initialBbox={gridOf(editorPage)}
          isAiBbox={false}
          onConfirm={(b, pageIndex) => {
            // 只更新被框的那一頁；沒框的頁沿用第 1 頁（server essayTemplateCells 找不到該頁就用 grids[0]）
            const page = pageIndex + 1
            const others = custom.grids.filter((g) => g.page !== page)
            const grids = [...others, { page, box: b }].sort((x, y) => x.page - y.page)
            onCustom({ ...custom, grids: page === 1 && !others.length ? [{ page: 1, box: b }] : grids })
            setEditorOpen(false)
          }}
          onClear={() => { onCustom({ ...custom, grids: editorPage === 0 ? [] : custom.grids.filter((g) => g.page !== editorPage + 1) }); setEditorOpen(false) }}
          onClose={() => setEditorOpen(false)}
        />
      )}
    </div>
  )
}
