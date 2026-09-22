// 2026-09-22 自備作文稿紙的「稿紙設定」（user 拍板：可選會考稿紙／學測稿紙／自備稿紙；前兩者直接帶入不用上傳、
//   自備稿紙要上傳空白稿紙）。自備：上傳空白稿紙 PDF → 逐頁框格區 → 系統在框內數線、自動填行數／格數／窄欄 → 全幅檢視核對紫線。
//   兩頁可以不同（user：有的稿紙背面滿版）：每一頁各自有框與行列數；第 2 頁沒另外框＝沿用第 1 頁。
//   批改時 server 把老師的空白稿紙與學生卷疊合、再把格子投過去（顏色無關、黑白也可），所以：
//   ⛔ 上傳的空白稿紙必須和學生寫的那張**一模一樣**（同一個檔印的），否則疊不上。
import { useEffect, useMemo, useRef, useState } from 'react'
import { Upload, Crop, RotateCw } from 'lucide-react'
import PageBboxEditorModal, { type NormalizedBbox } from '@/components/PageBboxEditorModal'
import { convertPdfToImages, getFileType, PDF_ONLY_MSG } from '@/lib/pdfToImage'
import { BUILTIN_ESSAY_SHEETS, gutterRatioOf, type EssaySheetChoice, type CustomEssaySheetInput, type CustomPageGrid } from '@/lib/essayByoPreset'
import { analyzeSheetGrid, autoDetectSheetGrid, type SheetGridAnalysis } from '@/lib/essaySheetAnalyze'
import { uprightEssayPages } from '@/lib/essayOrientation'

export interface CustomSheetState extends CustomEssaySheetInput {
  /** 這次上傳的空白稿紙頁圖（存檔時上傳當疊合模板）；編輯既有卷沒重傳＝從 Storage 塞回 */
  blobs: Blob[]
  /** 每頁系統數到的行列數（存檔防火牆用）；key＝page；null＝數不出來 */
  detected?: Record<number, SheetGridAnalysis | null>
}

/** 某一頁實際生效的設定（沒自己的框＝沿用第 1 頁） */
export function effectiveGrid(c: CustomEssaySheetInput, page: number): CustomPageGrid | null {
  return c.grids.find((g) => g.page === page) ?? c.grids.find((g) => g.page === 1) ?? null
}

/** 老師填的與系統數到的差 >1 ＝ 不符（存檔要擋）；回第一個不符的說明 */
export function customSheetMismatch(c: CustomSheetState): string | null {
  for (const g of c.grids) {
    const d = c.detected?.[g.page]
    if (!d) continue
    if (Math.abs(d.cols - g.cols) > 1 || Math.abs(d.rows - g.rows) > 1) {
      return `第 ${g.page} 頁：系統在空白稿紙上數到 ${d.cols} 行、每行 ${d.rows} 格${d.gutter ? '、有窄欄' : ''}，但你填的是 ${g.cols} 行、每行 ${g.rows} 格${g.gutter ? '、有窄欄' : ''}`
    }
  }
  return null
}

interface Props {
  choice: EssaySheetChoice
  onChoice: (c: EssaySheetChoice) => void
  /** 可選的稿紙（依年級過濾：國中小＝會考／自備、高中＝學測／自備）；沒給＝全部 */
  allowed?: EssaySheetChoice[]
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
  { key: 'custom', name: '自備稿紙', hint: '上傳學校自己的空白稿紙，逐頁框出格區；行數／格數系統自動數' },
]

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number(v) || lo))

/** 預覽切格：依框＋行列數畫線（與 server essayTemplateCells／essayPageSpec 同一套均分規則） */
function linesFor(g: CustomPageGrid | null) {
  if (!g) return null
  const box = g.box
  const pitch = box.w / Math.max(1, g.cols)
  const cellW = pitch * gutterRatioOf(g)
  const cellH = box.h / Math.max(1, g.rows)
  const v: number[] = [], vCell: number[] = []
  for (let c = 0; c <= g.cols; c++) v.push(box.x + box.w - c * pitch)
  if (g.gutter) for (let c = 0; c < g.cols; c++) vCell.push(box.x + box.w - c * pitch - pitch + cellW)
  const h: number[] = []
  for (let r = 0; r <= g.rows; r++) h.push(box.y + r * cellH)
  return { v, vCell, h, box }
}

function GridOverlay({ g, thick }: { g: CustomPageGrid | null; thick?: boolean }) {
  const gl = linesFor(g)
  if (!gl) return null
  const k1 = thick ? 0.003 : 0.004, k2 = thick ? 0.0012 : 0.0015
  return (
    <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 1 1" preserveAspectRatio="none">
      {gl.v.map((x, k) => <line key={`v${k}`} x1={x} y1={gl.box.y} x2={x} y2={gl.box.y + gl.box.h} stroke="#7c3aed" strokeWidth={k === 0 || k === gl.v.length - 1 ? k1 : k2} />)}
      {gl.vCell.map((x, k) => <line key={`vc${k}`} x1={x} y1={gl.box.y} x2={x} y2={gl.box.y + gl.box.h} stroke="#a78bfa" strokeWidth={0.0008} strokeDasharray="0.01 0.01" />)}
      {gl.h.map((y, k) => <line key={`h${k}`} x1={gl.box.x} y1={y} x2={gl.box.x + gl.box.w} y2={y} stroke="#7c3aed" strokeWidth={k === 0 || k === gl.h.length - 1 ? k1 : k2} />)}
    </svg>
  )
}

export default function EssaySheetSetup({ choice, onChoice, allowed, grade, custom, onCustom, savedCustomPages = 0, disabled }: Props) {
  const choices = allowed ? CHOICES.filter((c) => allowed.includes(c.key)) : CHOICES
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editorPage, setEditorPage] = useState(0)
  const [editorOpen, setEditorOpen] = useState(false)
  const [zoom, setZoom] = useState<number | null>(null)
  // 老師這一次操作剛框好的那一頁（不是編輯既有卷載入的）→ 偵測完直接彈全幅檢視讓他核對紫線
  const justFramed = useRef<number | null>(null)
  const previewUrls = useMemo(() => custom.blobs.map((b) => URL.createObjectURL(b)), [custom.blobs])
  useEffect(() => () => { previewUrls.forEach((u) => URL.revokeObjectURL(u)) }, [previewUrls])

  const onUpload = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    if (getFileType(file) !== 'pdf') { setError(PDF_ONLY_MSG); return }
    setBusy(true)
    try {
      // 疊合服務內部統一縮到寬 1200；這裡固定 1600（scale 4 再被 maxWidth 壓到 1600）——預設 scale 2 會讓 A4 直式只轉出 1280px、
      //   1px 細格線在自動找格區時漏掉（09-22 TEST 卷 6 行事故）；也給老師框格區看
      const raw = await convertPdfToImages(file, { scale: 4, maxWidth: 1600, minWidth: 1600, hardMinWidth: 1600, quality: 0.9 })
      if (!raw.length) throw new Error('PDF 沒有可用頁面')
      if (raw.length > 2) throw new Error('空白稿紙最多 2 頁（正反面），這份有 ' + raw.length + ' 頁')
      // 作文稿紙一律橫式（user 09-22）：直式頁自動順時針轉 90°，不用老師按轉向
      const blobs = await uprightEssayPages(raw)
      // 上傳後每頁自動找格區＋數線（user 09-22：不用老師框）；找不到的頁留給老師手動框
      const { grids, detected } = await detectPages(blobs)
      onCustom({ ...custom, blobs, pages: blobs.length, grids, detected })
      if (grids.some((g) => g.page === 1)) setZoom(0)
      else setError('系統找不到這張稿紙的格區，請按「框出整片格子」手動框')
    } catch (e) {
      setError(e instanceof Error ? e.message : '讀取失敗')
    } finally { setBusy(false) }
  }

  // 每頁自動找格區＋數線；找不到（或格子太少）的頁不放進 grids、留給老師手動框
  const detectPages = async (blobs: Blob[]) => {
    const grids: CustomPageGrid[] = []
    const detected: Record<number, SheetGridAnalysis | null> = {}
    for (let i = 0; i < blobs.length; i++) {
      let a = null
      try { a = await autoDetectSheetGrid(blobs[i]) } catch { a = null }
      if (a && a.cols >= 3 && a.rows >= 3) { grids.push({ page: i + 1, box: a.box, cols: a.cols, rows: a.rows, gutter: a.gutter, gutterRatio: a.gutterRatio }); detected[i + 1] = { cols: a.cols, rows: a.rows, gutter: a.gutter, gutterRatio: a.gutterRatio, vLines: a.vLines, hLines: a.hLines } }
    }
    return { grids, detected }
  }

  // 旋轉某一頁 90°（user 09-22：PDF 進來還沒轉正就讓老師先轉）：轉的是頁圖本身（存檔上傳的就是轉正後的圖、
  //   批改疊合也對這張），轉完該頁重新自動找格區；沒轉的頁照舊
  const onRotate = async (i: number) => {
    if (!custom.blobs[i] || busy) return
    setBusy(true); setError(null)
    try {
      const { rotateImageBlob } = await import('../lib/imageCompression')
      const rotated = await rotateImageBlob(custom.blobs[i], 90)
      const blobs = custom.blobs.map((b, k) => (k === i ? rotated : b))
      const page = i + 1
      const one = await detectPages([rotated])
      const found = one.grids[0]
      const grids = [...custom.grids.filter((g) => g.page !== page), ...(found ? [{ ...found, page }] : [])].sort((x, y) => x.page - y.page)
      const detected = { ...(custom.detected ?? {}) }
      delete detected[page]
      if (found) detected[page] = one.detected[1]
      onCustom({ ...custom, blobs, grids, detected })
      if (found) setZoom(i)
      else setError(`轉向後系統仍找不到第 ${page} 頁的格區，請按「框出整片格子」手動框`)
    } catch (e) {
      setError(e instanceof Error ? e.message : '旋轉失敗')
    } finally { setBusy(false) }
  }

  // 有自己框的頁：在框內數線 → 自動填入該頁的行數／格數／窄欄（user：不要叫老師按套用）
  const framedKey = custom.grids.map((g) => `${g.page}:${g.box.x.toFixed(4)},${g.box.y.toFixed(4)},${g.box.w.toFixed(4)},${g.box.h.toFixed(4)}`).join('|')
  useEffect(() => {
    let alive = true
    const pending = custom.grids.filter((g) => custom.blobs[g.page - 1] && custom.detected?.[g.page] === undefined)
    if (!pending.length) return
    void (async () => {
      let next = custom
      for (const g of pending) {
        let d: SheetGridAnalysis | null = null
        try { d = await analyzeSheetGrid(custom.blobs[g.page - 1], g.box) } catch { d = null }
        if (!alive) return
        const grids = next.grids.map((x) => (x.page === g.page && d && d.cols > 0 && d.rows > 0 ? { ...x, cols: d.cols, rows: d.rows, gutter: d.gutter, gutterRatio: d.gutterRatio ?? x.gutterRatio } : x))
        next = { ...next, grids, detected: { ...(next.detected ?? {}), [g.page]: d } }
      }
      onCustom(next)
      if (justFramed.current != null) { setZoom(justFramed.current - 1); justFramed.current = null }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [custom.blobs, framedKey])

  const mismatch = customSheetMismatch(custom)
  const scoring = choice === 'gsat' || (choice === 'custom' && typeof grade === 'number' && grade >= 10) ? '學測 25 分制' : '會考 6 級分'
  const setGrid = (page: number, patch: Partial<CustomPageGrid>) => {
    onCustom({ ...custom, grids: custom.grids.map((g) => (g.page === page ? { ...g, ...patch } : g)) })
  }

  return (
    <div className="mb-3 rounded border border-violet-200 bg-violet-50/60 px-3 py-2.5 text-[12px] text-violet-950 leading-relaxed">
      <div className="font-semibold mb-1.5">選擇稿紙</div>
      <div className="flex flex-wrap gap-1.5 mb-1.5">
        {choices.map((c) => (
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
            上傳<b>空白</b>稿紙（PDF，1～2 頁），要和發給學生的那張<b>一模一樣</b>（同一個檔印的）。上傳後系統會自動找出每一頁的格區、
            數出行數／每行格數／有無窄欄，並開全幅檢視讓你核對紫線；找錯了再按「重新框整片格子」手動框。正反面格子不同（例如背面滿版）也會各自偵測。
            頁面進來是橫的、還沒轉正 → 先按該頁的「轉向」轉正（轉完會重新偵測），存檔存的就是轉正後的稿紙。
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-violet-400 bg-white text-violet-900 text-[12px] font-medium ${disabled || busy ? 'opacity-50' : 'cursor-pointer hover:bg-violet-100'}`}>
              <Upload className="w-3.5 h-3.5" />{busy ? '讀取中…' : custom.blobs.length ? '重新上傳空白稿紙' : '上傳空白稿紙 PDF'}
              <input type="file" accept=".pdf,application/pdf" className="hidden" disabled={disabled || busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void onUpload(f) }} />
            </label>
            {custom.blobs.length > 0 && <span className="text-[11px]">已上傳 {custom.blobs.length} 頁</span>}
            {!custom.blobs.length && savedCustomPages > 0 && <span className="text-[11px]">已存 {savedCustomPages} 頁（不重傳就沿用）</span>}
          </div>
          {error && <div className="text-[11px] text-red-700">{error}</div>}
          {previewUrls.length > 0 && (
            <div className="flex flex-wrap gap-3">
              {previewUrls.map((url, i) => {
                const page = i + 1
                const own = custom.grids.find((g) => g.page === page) ?? null
                const eff = effectiveGrid(custom, page)
                const d = custom.detected?.[page]
                const pageMismatch = own && d ? (Math.abs(d.cols - own.cols) > 1 || Math.abs(d.rows - own.rows) > 1) : false
                return (
                  <div key={i} className="inline-block max-w-full">
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      <span className="text-[12px] font-semibold text-violet-900">第 {page} 頁</span>
                      <button type="button" disabled={disabled} onClick={() => { setEditorPage(i); setEditorOpen(true) }}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-violet-400 bg-white text-violet-900 text-[12px] font-medium disabled:opacity-50 hover:bg-violet-100">
                        <Crop className="w-3.5 h-3.5" />{own ? '重新框整片格子' : page === 1 ? '框出整片格子' : '另外框第 2 頁'}
                      </button>
                      <button type="button" disabled={disabled || busy} onClick={() => void onRotate(i)} title="這一頁轉向 90°（轉完會重新自動找格區）"
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-violet-400 bg-white text-violet-900 text-[12px] font-medium disabled:opacity-50 hover:bg-violet-100">
                        <RotateCw className="w-3.5 h-3.5" />轉向
                      </button>
                      {own ? (
                        <>
                          <label className="inline-flex items-center gap-1 text-[12px]">行數
                            <input type="number" min={1} max={60} value={own.cols} disabled={disabled} onChange={(e) => setGrid(page, { cols: clamp(Number(e.target.value), 1, 60) })} className="w-14 px-1.5 py-0.5 border border-violet-300 rounded text-center" />
                          </label>
                          <label className="inline-flex items-center gap-1 text-[12px]">每行格數
                            <input type="number" min={1} max={40} value={own.rows} disabled={disabled} onChange={(e) => setGrid(page, { rows: clamp(Number(e.target.value), 1, 40) })} className="w-14 px-1.5 py-0.5 border border-violet-300 rounded text-center" />
                          </label>
                          <label className="inline-flex items-center gap-1 text-[12px]">
                            <input type="checkbox" checked={own.gutter} disabled={disabled} onChange={(e) => setGrid(page, { gutter: e.target.checked })} />右側有窄欄
                          </label>
                        </>
                      ) : page > 1 && eff ? (
                        <span className="text-[11px] text-violet-700">沿用第 1 頁（{eff.cols} 行 × {eff.rows} 格{eff.gutter ? '、有窄欄' : ''}）；背面格子不同時請另外框</span>
                      ) : null}
                    </div>
                    {own && d && (
                      <div className={`mb-1 text-[11px] rounded px-2 py-1 border ${pageMismatch ? 'bg-red-50 border-red-200 text-red-800' : 'bg-emerald-50 border-emerald-200 text-emerald-800'}`}>
                        系統數到 <b>{d.cols} 行、每行 {d.rows} 格{d.gutter ? '、有窄欄' : '、無窄欄'}</b>
                        {pageMismatch ? '——與你填的不符，存檔會被擋下。' : '——已自動填入，紫線對不齊再自行調整。'}
                        {pageMismatch && (
                          <button type="button" className="ml-2 px-2 py-0.5 rounded border border-current text-[11px] font-medium hover:bg-white/60"
                            onClick={() => setGrid(page, { cols: d.cols, rows: d.rows, gutter: d.gutter, gutterRatio: d.gutterRatio })}>改回偵測值</button>
                        )}
                      </div>
                    )}
                    {own && d === null && <div className="mb-1 text-[11px] text-amber-700">系統數不出這頁的格線（太淡或框到格區外）——請確認框住整片格子，並自行核對行數／格數。</div>}
                    <div className="relative inline-block border border-violet-200 bg-white rounded overflow-hidden">
                      <img src={url} alt={`空白稿紙第 ${page} 頁`} className="block max-h-[28rem] w-auto cursor-zoom-in" onClick={() => setZoom(i)} title="點擊放大" />
                      <GridOverlay g={eff} />
                      {!eff && page === 1 && <div className="absolute inset-x-0 bottom-0 bg-violet-900/70 text-white text-[11px] px-2 py-1">系統沒找到格區，請按「框出整片格子」：用一個矩形把所有格子一次框起來——從最右上那一格的外緣拉到最左下那一格的外緣</div>}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          {custom.grids.length > 0 && (
            <div className="text-[11px] text-violet-800">
              預覽的紫線要壓在稿紙的每一條印刷格線上才算對（只有一條或對不齊＝框錯或行數、格數不對）；不對就重框，或調整該頁的行數／格數／窄欄。
              {mismatch && <span className="text-red-700"> {mismatch}。</span>}
            </div>
          )}
        </div>
      )}
      {zoom != null && previewUrls[zoom] && (
        <div className="fixed inset-0 z-[130] bg-black/70 flex items-center justify-center p-4 cursor-zoom-out" onClick={() => setZoom(null)}>
          <div className="relative max-w-full max-h-full">
            <img src={previewUrls[zoom]} alt="" className="block max-w-[96vw] max-h-[92vh] w-auto h-auto bg-white" />
            <GridOverlay g={effectiveGrid(custom, zoom + 1)} thick />
            <div className="absolute top-2 right-2 text-white text-xs bg-black/60 rounded px-2 py-1">第 {zoom + 1} 頁・點任意處關閉</div>
            {(() => { const d = custom.detected?.[zoom + 1]; const eff = effectiveGrid(custom, zoom + 1); return (
              <div className="absolute bottom-2 inset-x-2 text-center text-white text-sm bg-violet-900/85 rounded px-3 py-2">
                請確認<b>紫線壓在每一條格線上</b>{d ? `（系統數到 ${d.cols} 行、每行 ${d.rows} 格${d.gutter ? '、有窄欄' : ''}）` : eff ? `（${eff.cols} 行 × ${eff.rows} 格）` : ''}；不對就關閉後重新框整片格子。
              </div>) })()}
          </div>
        </div>
      )}
      {editorOpen && custom.blobs.length > 0 && (
        <PageBboxEditorModal
          pageBlobs={custom.blobs}
          questionId="格區"
          initialPage={editorPage}
          initialBbox={effectiveGrid(custom, editorPage + 1)?.box ?? null}
          isAiBbox={false}
          onConfirm={(b: NormalizedBbox, pageIndex: number) => {
            // 只更新被框的那一頁；沒框的頁沿用第 1 頁（server essayPageSpec 找不到該頁就用 grids[0]）
            const page = pageIndex + 1
            const base = effectiveGrid(custom, page)
            const others = custom.grids.filter((g) => g.page !== page)
            const grids = [...others, { page, box: b, cols: base?.cols ?? 20, rows: base?.rows ?? 20, gutter: base?.gutter ?? false }].sort((x, y) => x.page - y.page)
            justFramed.current = page
            const detected = { ...(custom.detected ?? {}) }
            delete detected[page]
            onCustom({ ...custom, grids, detected })
            setEditorOpen(false)
          }}
          onClear={() => {
            const page = editorPage + 1
            const detected = { ...(custom.detected ?? {}) }
            delete detected[page]
            onCustom({ ...custom, grids: custom.grids.filter((g) => g.page !== page), detected })
            setEditorOpen(false)
          }}
          onClose={() => setEditorOpen(false)}
        />
      )}
    </div>
  )
}
