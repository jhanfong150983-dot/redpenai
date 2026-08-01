// 學生檢討單 PDF(2026-08-01 Step 9、模板經 user 逐版定稿):
//   全題密排、目標 2 頁。每列=頁數|題號|作答裁圖(等高)|AI 擷取/正解|得分。
//   扣分題紅底+紅邊條(所有列都預留邊條寬度→不位移)、低信心黃底+「⚠核對」;
//   末頁=總分(右、簽名之前)+核對簽名欄;每頁底部置中頁碼。無圖例(黑白列印無意義)。
// ⭐crop-first(user 拍板):裁圖像素「保留原始解析度、絕不重採樣縮小」——列印 300dpi 吃完整像素、
//   顯示尺寸只由 CSS 控制;全題等高(解析度夠、不需為錯題放大)。
// 自適應:列高用裁圖實際尺寸精算 → 迭代找 zoom(縮的是顯示尺寸、不動像素)裝進 2 頁;
//   縮到下限仍裝不下 → 誠實開第 3 頁(不 overflow 藏內容)。
// 管線:client 組 HTML(canvas 裁 bbox、零 AI 成本)→ 逐生 POST /api/report/parent-pdf
//   (重用家長報告 headless Chrome 端點、零 server 改動;逐生 POST 也避開 4MB 上限)
//   → pdf-lib 合併成「一班一個 PDF」直接列印(user 拍板,不用 zip)。
import { db, type Submission, type Student, type Assignment } from '@/lib/db'

const PDF_ENDPOINT = '/api/report/parent-pdf'
const FONT_LINK = '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700;800&display=swap" rel="stylesheet">'

// 版型常數(與 local-only/exp-review-sheet-preview 定稿一致)
const UNIFORM_CROP_H = 32   // 全題統一裁圖顯示高
const CROP_COL_W = 310      // 裁圖固定欄寬 → 「AI 擷取/正解」全卷齊頭
const BUDGET_FIRST = 950    // 頁1 內容區高度
const BUDGET_NEXT = 855     // 後續頁(末頁含總分+簽名)
const ZOOM_FLOOR = 0.85
const ZOOM_CEIL = 1.30

type Bbox = { x: number; y: number; w: number; h: number }
type GradingDetail = {
  questionId: string
  score?: number
  maxScore?: number
  isCorrect?: boolean
  studentAnswer?: string
  scoringReason?: string
  reason?: string
  answerBbox?: Bbox
  scoreConfidence?: number
  errorType?: string
  needsReview?: boolean
}

export type ReviewRow = {
  qid: string
  pageNo: string
  qNum: string
  score: number
  maxScore: number
  studentAnswer: string
  correctAnswer: string
  wrong: boolean
  lowConfidence: boolean
  cropDataUri: string | null
  dispW: number
  dispH: number
  rowH: number
}
export type StudentSheet = {
  studentId: string
  seat: number
  name: string
  score: number | null
  rows: ReviewRow[]
}
export type ReviewProgress = (phase: 'build' | 'pdf', done: number, total: number) => void

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// 低信心(黃燈)判定:與批改頁同精神、欄位防禦式讀取
function isLowConfidence(d: GradingDetail): boolean {
  if (d.needsReview === true) return true
  if (typeof d.scoreConfidence === 'number' && d.scoreConfidence < 60) return true
  if (d.errorType === 'unreadable') return true
  return false
}

async function getSubmissionBitmap(sub: Submission): Promise<ImageBitmap | null> {
  try {
    let blob: Blob | null = sub.imageBlob && sub.imageBlob.size > 0 ? sub.imageBlob : null
    if (!blob) {
      const res = await fetch(`/api/storage/download?submissionId=${encodeURIComponent(sub.id)}`, { credentials: 'include' })
      if (!res.ok) return null
      blob = await res.blob()
      if (!blob || blob.size === 0) return null
    }
    return await createImageBitmap(blob)
  } catch {
    return null
  }
}

// 裁 bbox → JPEG data URI + 原始像素尺寸。⚠ canvas 尺寸=原始像素(不縮),顯示大小交給 CSS。
function cropAtNativeRes(bmp: ImageBitmap, bbox: Bbox, padX = 0.012, padY = 0.004):
  { uri: string; w: number; h: number } | null {
  try {
    const x0 = Math.max(0, bbox.x - padX) * bmp.width
    const y0 = Math.max(0, bbox.y - padY) * bmp.height
    const x1 = Math.min(1, bbox.x + bbox.w + padX) * bmp.width
    const y1 = Math.min(1, bbox.y + bbox.h + padY) * bmp.height
    const sw = Math.round(x1 - x0)
    const sh = Math.round(y1 - y0)
    if (sw < 2 || sh < 2) return null
    const canvas = document.createElement('canvas')
    canvas.width = sw
    canvas.height = sh
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bmp, Math.round(x0), Math.round(y0), sw, sh, 0, 0, sw, sh)
    return { uri: canvas.toDataURL('image/jpeg', 0.88), w: sw, h: sh }
  } catch {
    return null
  }
}

// ── 資料組裝:一個班(assignment)→ 每位已批改學生的全題列 ──
export async function buildClassReviewSheets(
  assignmentId: string,
  onProgress?: ReviewProgress
): Promise<{ assignment: Assignment; className: string; sheets: StudentSheet[] }> {
  const assignment = await db.assignments.get(assignmentId)
  if (!assignment) throw new Error('找不到考卷資料,請先同步')
  const classroom = await db.classrooms.get(assignment.classroomId)
  const students = await db.students.where('classroomId').equals(assignment.classroomId).toArray()
  const stuById = new Map(students.map((s) => [s.id, s]))
  const subs = (await db.submissions.where('assignmentId').equals(assignmentId).toArray())
    .filter((s) => s.status === 'graded' && s.gradingResult)
  // 題序與正解以答案卷為準(考卷原始順序)
  const akQuestions = (assignment.answerKey?.questions ?? []) as Array<{ id?: string; answer?: unknown; maxScore?: number }>

  const ordered = subs
    .map((sub) => ({ sub, stu: stuById.get(sub.studentId) }))
    .filter((x): x is { sub: Submission; stu: Student } => !!x.stu)
    .sort((a, b) => a.stu.seatNumber - b.stu.seatNumber)

  const sheets: StudentSheet[] = []
  let done = 0
  for (const { sub, stu } of ordered) {
    const details = ((sub.gradingResult as { details?: GradingDetail[] } | undefined)?.details ?? [])
    const detailById = new Map(details.map((d) => [d.questionId, d]))
    // bbox 來源:grading_result.details 優先,缺就退 phase_a_state 的 classify 結果
    //（PhaseAStateCached.classifyResult 在 schema 是 unknown、此處窄化取 bbox)
    const phaseAligned = (sub.phaseAState?.classifyResult as
      { alignedQuestions?: Array<{ questionId?: string; answerBbox?: Bbox }> } | undefined)
      ?.alignedQuestions ?? []
    const bboxFallback = new Map<string, Bbox>()
    for (const q of phaseAligned) {
      if (q?.questionId && q.answerBbox) bboxFallback.set(String(q.questionId), q.answerBbox)
    }
    const bmp = await getSubmissionBitmap(sub)

    const rows: ReviewRow[] = []
    for (const q of akQuestions) {
      const qid = String(q?.id ?? '')
      const d = detailById.get(qid)
      if (!qid || !d) continue
      const maxScore = Number(d.maxScore ?? q.maxScore ?? 0)
      const score = Number(d.score ?? 0)
      const bbox = d.answerBbox || bboxFallback.get(qid)
      const c = bmp && bbox ? cropAtNativeRes(bmp, bbox) : null
      // 等比縮進 CROP_COL_W × UNIFORM_CROP_H 盒內(全題等高、不分對錯放大)
      let dispW = 0, dispH = 0
      if (c) {
        const s = Math.min(UNIFORM_CROP_H / c.h, CROP_COL_W / c.w)
        dispW = Math.max(1, Math.round(c.w * s))
        dispH = Math.max(1, Math.round(c.h * s))
      }
      // 題號拆「頁數|題號」:1-A-1 → 頁數 1、題號 A-1
      const m = qid.match(/^(\d+)-(.+)$/)
      rows.push({
        qid,
        pageNo: m ? m[1] : '',
        qNum: m ? m[2] : qid,
        score, maxScore,
        studentAnswer: String(d.studentAnswer ?? ''),
        correctAnswer: String(q?.answer ?? ''),
        wrong: score < maxScore,
        lowConfidence: isLowConfidence(d),
        cropDataUri: c?.uri ?? null,
        dispW, dispH,
        rowH: Math.max(24, dispH + 6),
      })
    }
    bmp?.close()
    sheets.push({
      studentId: stu.id,
      seat: stu.seatNumber,
      name: stu.name,
      score: typeof sub.score === 'number' ? sub.score : null,
      rows,
    })
    done++
    onProgress?.('build', done, ordered.length)
  }
  return { assignment, className: classroom?.name ?? '', sheets }
}

// ── HTML 版型 ──
const SHEET_CSS = `
.page { position:relative; width:794px; height:1123px; box-sizing:border-box; background:#fff; padding:36px 42px 40px; overflow:hidden; font-family:'Noto Sans TC', sans-serif; color:#0f172a; }
.head { display:flex; justify-content:space-between; align-items:baseline; border-bottom:2px solid #0f172a; padding-bottom:6px; margin-bottom:6px }
.head .t { font-size:15px; font-weight:800 } .head .s { font-size:10.5px; color:#64748b; margin-left:10px }
.head .who { font-size:12.5px; font-weight:700 }
.cols { min-height:20px; align-items:center; padding-top:0; padding-bottom:4px; border-bottom:1px solid #cbd5e1 }
.cols > div { font-size:9.5px; font-weight:600; color:#64748b; letter-spacing:.3px; line-height:1.2 }
/* 所有列都預留左邊條寬度 → 扣分題只換顏色、不位移 */
.row { display:flex; align-items:center; gap:8px; border-bottom:1px solid #f1f5f9; padding:2px 0 2px 5px; min-height:26px; border-left:3px solid transparent }
.row.wrong { background:#fef2f2; border-left-color:#ef4444 }
.row.low { background:#fffbeb; border-left-color:#f59e0b }
.c-page { flex:0 0 26px; font-size:10.5px; font-weight:700; text-align:center; color:#64748b }
.c-qid { flex:0 0 42px; font-size:10.5px; font-weight:700 }
.c-crop { flex:0 0 ${CROP_COL_W}px } .c-crop img { display:block; border:1px solid #e2e8f0; border-radius:3px }
.nocrop { font-size:9px; color:#cbd5e1 }
.c-ans { flex:1 1 auto; font-size:10px; color:#334155; line-height:1.35; min-width:0 }
.c-ans b { font-size:10.5px } .corr { margin-left:2px } .corr b { color:#dc2626 }
.lowtag { font-size:8.5px; color:#b45309; background:#fef3c7; border:1px solid #fcd34d; border-radius:99px; padding:0 5px; margin-left:5px }
.c-score { flex:0 0 56px; text-align:right; font-size:10.5px; white-space:nowrap }
.o { color:#16a34a; font-weight:800; margin-right:3px } .x { color:#dc2626; font-weight:800; margin-right:3px }
.pts { font-weight:700 }
.allpass { border:1.5px solid #86efac; background:#f0fdf4; color:#15803d; border-radius:10px; padding:14px; font-size:13px; font-weight:700; text-align:center; margin-top:14px }
.foot { margin-top:10px; border-top:1.5px dashed #94a3b8; padding-top:9px }
.total { display:flex; justify-content:flex-end; align-items:baseline; gap:8px }
.tlabel { font-size:12px; font-weight:700; color:#475569 }
.tval { font-size:30px; font-weight:800; color:#0f172a; border-bottom:3px double #0f172a; padding:0 10px; line-height:1.1 }
.sign { font-size:11px; color:#334155; display:flex; justify-content:space-between; align-items:flex-end; margin-top:12px }
.blank { display:inline-block; width:100px; border-bottom:1px solid #64748b; margin:0 4px }
.pgfoot { position:absolute; left:0; right:0; bottom:14px; text-align:center; font-size:9.5px; color:#94a3b8 }
`

type SheetHeader = { title: string; className: string; dateText: string }

function rowHtml(r: ReviewRow): string {
  const cls = r.wrong ? 'row wrong' : r.lowConfidence ? 'row low' : 'row'
  const mark = r.wrong ? '<span class="x">✗</span>' : '<span class="o">✓</span>'
  const tag = r.lowConfidence ? '<span class="lowtag">⚠核對</span>' : ''
  const img = r.cropDataUri
    ? `<img src="${r.cropDataUri}" style="width:${r.dispW}px;height:${r.dispH}px">`
    : '<span class="nocrop">(無裁圖)</span>'
  return `<div class="${cls}">
    <div class="c-page">${esc(r.pageNo)}</div>
    <div class="c-qid">${esc(r.qNum)}</div>
    <div class="c-crop">${img}</div>
    <div class="c-ans">擷取:<b>${esc(r.studentAnswer || '—')}</b>${r.wrong ? `<span class="corr">　正解:<b>${esc(r.correctAnswer || '—')}</b></span>` : ''}${tag}</div>
    <div class="c-score">${mark}<span class="pts">${r.score}/${r.maxScore}</span></div>
  </div>`
}

// 迭代找 zoom + 分頁(貪婪分頁有殘差、純除法算不準 → 從理想值往下試到裝進 2 頁)
function layout(rows: ReviewRow[]): { zoom: number; pages: ReviewRow[][] } {
  const totalH = rows.reduce((s, r) => s + r.rowH, 0) || 1
  const paginate = (z: number) => {
    const pg: ReviewRow[][] = [[]]
    let h = 0
    for (const r of rows) {
      const budget = (pg.length === 1 ? BUDGET_FIRST : BUDGET_NEXT) / z
      if (h + r.rowH > budget && pg[pg.length - 1].length > 0) { pg.push([]); h = 0 }
      pg[pg.length - 1].push(r)
      h += r.rowH
    }
    return pg
  }
  let zoom = Math.min(ZOOM_CEIL, Math.max(ZOOM_FLOOR, (BUDGET_FIRST + BUDGET_NEXT) / totalH))
  let pages = paginate(zoom)
  while (pages.length > 2 && zoom > ZOOM_FLOOR) {
    zoom = Math.max(ZOOM_FLOOR, zoom - 0.005)
    pages = paginate(zoom)
  }
  return { zoom, pages }
}

const COLS_HTML = `<div class="row cols">
  <div class="c-page">頁數</div>
  <div class="c-qid">題號</div>
  <div class="c-crop">你的作答(裁圖)</div>
  <div class="c-ans">AI 擷取/正解</div>
  <div class="c-score">得分</div>
</div>`

function renderSheetHtml(sheet: StudentSheet, header: SheetHeader): string {
  const { zoom, pages } = layout(sheet.rows)
  const headHtml = `<div class="head">
    <div><span class="t">${esc(header.title)}|學生檢討單</span><span class="s">${esc(header.className)}・${esc(header.dateText)}</span></div>
    <div class="who">${sheet.seat} 號 ${esc(sheet.name)}</div>
  </div>`
  const footHtml = `<div class="foot">
    <div class="total"><span class="tlabel">總分</span><span class="tval">${sheet.score ?? '—'}</span></div>
    <div class="sign">
      <div>本人已逐題核對本卷批改結果,如有疑義已向老師口頭反映。</div>
      <div>簽名:<span class="blank"></span>日期:<span class="blank" style="width:70px"></span></div>
    </div>
  </div>`
  if (sheet.rows.length === 0) {
    return `<div class="page">${headHtml}
      <div class="allpass">本卷尚無可顯示的題目資料</div>
      ${footHtml}
      <div class="pgfoot">第 1 / 1 頁</div>
    </div>`
  }
  return pages.map((pageRows, i) => `<div class="page">
  ${headHtml}
  <div style="zoom:${zoom.toFixed(3)}">
  ${COLS_HTML}
  ${pageRows.map(rowHtml).join('\n')}
  </div>
  ${i === pages.length - 1 ? footHtml : ''}
  <div class="pgfoot">第 ${i + 1} / ${pages.length} 頁</div>
</div>`).join('\n')
}

function buildPrintDocument(sheet: StudentSheet, header: SheetHeader): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>學生檢討單</title>${FONT_LINK}
<style>
@page { size: A4; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }
${SHEET_CSS}
</style></head><body>${renderSheetHtml(sheet, header)}</body></html>`
}

async function fetchSheetPdf(sheet: StudentSheet, header: SheetHeader): Promise<ArrayBuffer> {
  const res = await fetch(PDF_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ html: buildPrintDocument(sheet, header) }),
  })
  if (!res.ok) {
    let msg = `PDF 產生失敗(${res.status})`
    try { const j = await res.json(); if (j?.error) msg = j.error } catch { /* 非 JSON */ }
    throw new Error(msg)
  }
  return await res.arrayBuffer()
}

const safeFileName = (s: string) => String(s).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '').slice(0, 60)

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

// ── 主流程:組資料 → 逐生渲染(併發 3+失敗循序重試一次) → pdf-lib 依座號合併 → 下載 ──
export async function downloadClassReviewSheetPdf(
  assignmentId: string,
  opts: { onProgress?: ReviewProgress } = {}
): Promise<{ students: number; failed: number }> {
  const { assignment, className, sheets } = await buildClassReviewSheets(assignmentId, opts.onProgress)
  if (sheets.length === 0) throw new Error('此班尚無已批改的卷,請先完成 AI 批改')
  const dateText = new Date().toLocaleDateString('zh-TW')
  const header: SheetHeader = { title: assignment.title, className, dateText }

  const results = new Array<ArrayBuffer | null>(sheets.length).fill(null)
  let done = 0
  let idx = 0
  const failedIdx: number[] = []
  await Promise.all(Array.from({ length: Math.min(3, sheets.length) }, async () => {
    while (idx < sheets.length) {
      const i = idx++
      try { results[i] = await fetchSheetPdf(sheets[i], header) }
      catch (e) { console.warn(`[reviewSheet] 座號${sheets[i].seat} 渲染失敗:`, e); failedIdx.push(i) }
      done++
      opts.onProgress?.('pdf', done, sheets.length)
    }
  }))
  // 失敗循序重試一次(併發下 headless Chrome 冷啟動/逾時、單獨重試常會過)
  let failed = 0
  for (const i of failedIdx) {
    try { results[i] = await fetchSheetPdf(sheets[i], header) }
    catch { failed++ }
  }

  const { PDFDocument } = await import('pdf-lib')
  const merged = await PDFDocument.create()
  for (const bytes of results) {
    if (!bytes) continue
    const doc = await PDFDocument.load(bytes)
    const pages = await merged.copyPages(doc, doc.getPageIndices())
    for (const p of pages) merged.addPage(p)
  }
  const out = await merged.save()
  const dateKey = dateText.replace(/\//g, '')
  const outBuf = new ArrayBuffer(out.byteLength)
  new Uint8Array(outBuf).set(out)
  triggerDownload(
    new Blob([outBuf], { type: 'application/pdf' }),
    `檢討單_${safeFileName(className)}_${safeFileName(assignment.title)}_${dateKey}.pdf`
  )
  return { students: sheets.length - failed, failed }
}
