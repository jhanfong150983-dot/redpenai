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
import { resolveStdAnswer } from '@/lib/parentReport'

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
  const akQuestions = (assignment.answerKey?.questions ?? []) as Array<{ id?: string; answer?: string; referenceAnswer?: string; parts?: Array<{ answer?: string }>; maxScore?: number }>

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
        // 2026-08-12 user 抓漏:注釋等語意題正解存 referenceAnswer(answer 為空)、多小題存 parts
        //   → 用家長報告同一個 resolveStdAnswer(answer→referenceAnswer→parts 組合)
        correctAnswer: q ? resolveStdAnswer(q) : '',
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

// ═══ 原卷註記版（2026-09-10 user 逐輪拍板、原型 redpenaisever/local-only/exp-review-overlay/build.mjs）═══
//   學生原卷當底圖，每題作答框右側疊紅筆 ✓／✗（細筆、60% 透明＝壓到字也看得見），
//   每大題扣分一筆寫在該大題最右側空白，右上總分章，底部頁腳。
//   ⛔ 不寫正解（老師逐題朗誦／黑板對答案）、不寫每格扣分、未作答只打 ✗、全對的大題不標。
//   一人一頁（多頁卷依 pageBreaks 逐頁）。純 canvas、零 AI、零 server 呼叫（不經 parent-pdf），pdf-lib 直接嵌 JPEG。
export type ReviewSheetMode = 'overlay' | 'table'
const OV = { red: '#d0021b', markScale: 0.8, markOpacity: 0.6, markStroke: 0.07, maxW: 1800, jpegQ: 0.85 }
const OV_FONT = '"Noto Sans TC","Microsoft JhengHei","PingFang TC","Heiti TC",sans-serif'
// 大題鍵：題號 "頁-大題-小題" → "頁-大題"；"大題-小題" → "大題"
const sectionKeyOf = (qid: string) => { const p = qid.split('-'); return p.length >= 3 ? p.slice(0, 2).join('-') : p[0] }
const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))

type OverlayItem = { qid: string; bbox: Bbox; correct: boolean; lost: number; ref?: string }   // ref＝rubric 題檢討區塊編號（①②…）

function drawMark(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number, ok: boolean) {
  ctx.save()
  ctx.strokeStyle = OV.red
  ctx.globalAlpha = OV.markOpacity
  ctx.lineWidth = Math.max(1.6, s * OV.markStroke)
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'
  ctx.beginPath()
  if (ok) {
    ctx.moveTo(cx - s * 0.45, cy); ctx.lineTo(cx - s * 0.12, cy + s * 0.32); ctx.lineTo(cx + s * 0.5, cy - s * 0.42)
  } else {
    ctx.moveTo(cx - s * 0.4, cy - s * 0.4); ctx.lineTo(cx + s * 0.4, cy + s * 0.4)
    ctx.moveTo(cx + s * 0.4, cy - s * 0.4); ctx.lineTo(cx - s * 0.4, cy + s * 0.4)
  }
  ctx.stroke()
  ctx.restore()
}

// 渲染一張（原卷的一頁）：slice=[y0,y1) 為 pageBreaks 切出的合併圖區段（0~1）
// 2026-09-12 rubric 題（級分／作圖／rubric 判官）檢討註記（user 定案版式、越短越好）：
//   頁面下方加「解題過程檢討」區塊，每題一行標頭＋未呈現要素全文（含應出現的值）；格內 ✗ 旁標 ①② 對應。
//   ⚠ 這是刻意打破「不寫正解」原則：rubric 題的正解就是過程，不寫學生無法檢討也無法申訴（user 拍板）。
type RubricNote = { qid: string; header: string; lines: string[]; ref: string }
const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩']
const LEVEL_NAME_RS: Record<number, string> = { 3: '三級分', 2: '二級分', 1: '一級分', 0: '零級分' }
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = []; let cur = ''
  for (const ch of text) { const t = cur + ch; if (ctx.measureText(t).width > maxW && cur) { out.push(cur); cur = ch } else cur = t }
  if (cur) out.push(cur)
  return out
}

async function renderOverlayPage(
  bmp: ImageBitmap,
  slice: { y0: number; y1: number },
  items: OverlayItem[],
  sections: Array<{ lost: number; yMin: number }>,
  meta: { first: boolean; pageNo: number; pageCount: number; total: number | null; maxTotal: number; wrongCount: number; lost: number; title: string; who: string },
  notes: RubricNote[] = []
): Promise<Blob> {
  const scale = Math.min(1, OV.maxW / bmp.width)
  const sliceH = (slice.y1 - slice.y0) * bmp.height
  const W = Math.max(1, Math.round(bmp.width * scale))
  const H = Math.max(1, Math.round(sliceH * scale))
  const u = W / 1000
  // 先量檢討區塊高度（有 rubric 題未滿分才有），畫布往下加高、原卷不縮
  const measure = document.createElement('canvas').getContext('2d')
  let blockLines: Array<{ text: string; bold: boolean; indent: number }> = []
  if (notes.length && measure) {
    const maxW = W - 48 * u
    for (const n of notes) {
      measure.font = `700 ${Math.round(15 * u)}px ${OV_FONT}`
      for (const l of wrapText(measure, n.header, maxW)) blockLines.push({ text: l, bold: true, indent: 0 })
      measure.font = `400 ${Math.round(14 * u)}px ${OV_FONT}`
      n.lines.forEach((line, i) => { const w = wrapText(measure, `${CIRCLED[i] ?? `(${i + 1})`} ${line}`, maxW - 16 * u); w.forEach((l, k) => blockLines.push({ text: l, bold: false, indent: k === 0 ? 16 : 34 })) })
    }
  }
  const lineH = 19 * u
  const blockH = blockLines.length ? Math.round(30 * u + blockLines.length * lineH + 26 * u) : 0
  const canvas = document.createElement('canvas')
  canvas.width = W; canvas.height = H + blockH
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 不可用')
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H + blockH)
  ctx.drawImage(bmp, 0, Math.round(slice.y0 * bmp.height), bmp.width, Math.round(sliceH), 0, 0, W, H)
  const span = Math.max(1e-6, slice.y1 - slice.y0)
  const toY = (ny: number) => ((ny - slice.y0) / span) * H

  // 每題 ✓／✗（窄格如選擇題：小勾更靠右、不蓋代號）
  for (const it of items) {
    const x = it.bbox.x * W, y = toY(it.bbox.y), w = it.bbox.w * W, hh = (it.bbox.h / span) * H
    const compact = (w / Math.max(1, hh)) < 2.6
    const s = OV.markScale * (compact
      ? Math.max(14 * u, Math.min(hh * 0.62, w * 0.34, 34 * u))
      : Math.max(18 * u, Math.min(hh * 0.9, 40 * u)))
    drawMark(ctx, x + w - s * (compact ? 0.62 : 0.8), y + hh / 2, s, it.correct)
    if (it.ref) {
      ctx.save(); ctx.fillStyle = OV.red; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
      ctx.font = `700 ${Math.round(Math.max(12 * u, Math.min(18 * u, s * 0.5)))}px ${OV_FONT}`
      ctx.fillText(it.ref, x + w - s * (compact ? 0.62 : 0.8) + s * 0.55, y + hh / 2 - s * 0.35)
      ctx.restore()
    }
  }
  // 每大題扣分：右對齊頁緣、對齊該大題第一列
  ctx.save()
  ctx.fillStyle = OV.red
  ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic'
  ctx.font = `700 ${Math.round(26 * u)}px ${OV_FONT}`
  for (const sec of sections) ctx.fillText(`−${fmtNum(sec.lost)}`, W - 8 * u, toY(sec.yMin) + 26 * u * 0.95)
  ctx.restore()
  // 右上總分章（首頁）
  if (meta.first) {
    const stW = 236 * u, stH = 108 * u, sx = W - stW - 22 * u, sy = 18 * u
    ctx.save()
    ctx.globalAlpha = 0.9; ctx.fillStyle = '#fff'
    ctx.beginPath(); ctx.roundRect(sx, sy, stW, stH, 8 * u); ctx.fill()
    ctx.globalAlpha = 1; ctx.lineWidth = 3 * u; ctx.strokeStyle = OV.red; ctx.stroke()
    ctx.fillStyle = OV.red; ctx.textAlign = 'left'
    const scoreTxt = meta.total == null ? '—' : fmtNum(meta.total)
    ctx.font = `700 ${Math.round(54 * u)}px ${OV_FONT}`
    ctx.fillText(scoreTxt, sx + 16 * u, sy + 56 * u)
    const sw = ctx.measureText(scoreTxt).width
    ctx.font = `400 ${Math.round(22 * u)}px ${OV_FONT}`
    ctx.fillText(`/ ${meta.maxTotal}`, sx + 16 * u + sw + 6 * u, sy + 56 * u)
    ctx.font = `400 ${Math.round(15 * u)}px ${OV_FONT}`
    ctx.fillText(`錯 ${meta.wrongCount} 題 · 扣 ${fmtNum(meta.lost)} 分`, sx + 16 * u, sy + 80 * u)
    ctx.font = `400 ${Math.round(12 * u)}px ${OV_FONT}`
    ctx.fillText('✓ 正確　✗ 錯誤　右側紅字＝該大題扣分', sx + 16 * u, sy + 98 * u)
    ctx.restore()
  }
  // 解題過程檢討區塊（原卷下方）
  if (blockH > 0) {
    ctx.save()
    ctx.strokeStyle = OV.red; ctx.lineWidth = 1.5 * u
    ctx.beginPath(); ctx.moveTo(24 * u, H + 8 * u); ctx.lineTo(W - 24 * u, H + 8 * u); ctx.stroke()
    ctx.fillStyle = OV.red; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
    ctx.font = `700 ${Math.round(16 * u)}px ${OV_FONT}`
    ctx.fillText('解題過程檢討', 24 * u, H + 26 * u)
    let yy = H + 30 * u + lineH
    for (const l of blockLines) {
      ctx.fillStyle = l.bold ? '#111' : '#b91c1c'
      ctx.font = `${l.bold ? 700 : 400} ${Math.round((l.bold ? 15 : 14) * u)}px ${OV_FONT}`
      ctx.fillText(l.text, (24 + l.indent) * u, yy)
      yy += lineH
    }
    ctx.restore()
  }
  // 頁腳
  ctx.save()
  ctx.fillStyle = OV.red; ctx.textAlign = 'center'
  ctx.font = `400 ${Math.round(13 * u)}px ${OV_FONT}`
  const pg = meta.pageCount > 1 ? `　第 ${meta.pageNo} / ${meta.pageCount} 頁` : ''
  ctx.fillText(`檢討單　${meta.title}${meta.who ? '　' + meta.who : ''}${pg}`, W / 2, H + blockH - 14 * u)
  ctx.restore()

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob 失敗'))), 'image/jpeg', OV.jpegQ)
  })
}

// 一班 → 原卷註記版 PDF（pdf-lib 直接嵌圖、A4 直式等比置中）
async function buildOverlayClassPdf(
  assignmentId: string,
  onProgress?: ReviewProgress
): Promise<{ assignment: Assignment; className: string; bytes: Uint8Array; students: number; failed: number }> {
  const assignment = await db.assignments.get(assignmentId)
  if (!assignment) throw new Error('找不到考卷資料,請先同步')
  const classroom = await db.classrooms.get(assignment.classroomId)
  const students = await db.students.where('classroomId').equals(assignment.classroomId).toArray()
  const stuById = new Map(students.map((s) => [s.id, s]))
  const subs = (await db.submissions.where('assignmentId').equals(assignmentId).toArray())
    .filter((s) => s.status === 'graded' && s.gradingResult)
  const ordered = subs
    .map((sub) => ({ sub, stu: stuById.get(sub.studentId) }))
    .filter((x): x is { sub: Submission; stu: Student } => !!x.stu)
    .sort((a, b) => a.stu.seatNumber - b.stu.seatNumber)
  if (ordered.length === 0) throw new Error('此班尚無已批改的卷,請先完成 AI 批改')

  const { PDFDocument } = await import('pdf-lib')
  const pdf = await PDFDocument.create()
  const A4 = { w: 595.28, h: 841.89 }
  let done = 0, failed = 0
  for (const { sub, stu } of ordered) {
    try {
      const details = ((sub.gradingResult as { details?: GradingDetail[] } | undefined)?.details ?? [])
      const phaseAligned = (sub.phaseAState?.classifyResult as
        { alignedQuestions?: Array<{ questionId?: string; answerBbox?: Bbox }> } | undefined)?.alignedQuestions ?? []
      const bboxFallback = new Map<string, Bbox>()
      for (const q of phaseAligned) if (q?.questionId && q.answerBbox) bboxFallback.set(String(q.questionId), q.answerBbox)
      const items: OverlayItem[] = []
      const notes: RubricNote[] = []
      const akByQid = new Map((assignment.answerKey?.questions ?? []).map((q) => [String(q.id), q]))
      for (const d of details) {
        const bbox = d.answerBbox || bboxFallback.get(d.questionId)
        if (!bbox || bbox.x == null) continue
        const maxScore = Number(d.maxScore ?? 0), score = Number(d.score ?? 0)
        const item: OverlayItem = { qid: String(d.questionId), bbox, correct: d.isCorrect === true, lost: Math.max(0, maxScore - score) }
        // rubric 題未滿分 → 檢討註記（級分：未呈現要素全文；作圖：未達成項；rubric：未滿分維度）
        if (score < maxScore) {
          const lv = (d as { levelResult?: { level?: number; found?: string[]; evidence?: Array<{ key: string; label?: string; present?: boolean; waived?: boolean }> } }).levelResult
          const vj = (d as { vjItemResults?: Array<{ idx: number; label?: string; verdict?: string }> }).vjItemResults
          const rs = (d as { rubricScores?: Array<{ dimension?: string; score?: number; maxScore?: number }> }).rubricScores
          const akQ = akByQid.get(String(d.questionId)) as { levelRubric?: { requiredElements?: Array<{ key: string; desc?: string }>; alternativeGroups?: Array<{ options?: Array<{ key: string; desc?: string }> }> } } | undefined
          let note: RubricNote | null = null
          if (lv && Array.isArray(lv.evidence) && lv.evidence.length) {
            const descOf = new Map<string, string>()
            for (const e of akQ?.levelRubric?.requiredElements ?? []) descOf.set(e.key, e.desc ?? '')
            for (const g of akQ?.levelRubric?.alternativeGroups ?? []) for (const o of g.options ?? []) descOf.set(o.key, o.desc ?? '')
            const missing = lv.evidence.filter((e) => !e.present && !e.waived)
            const lines = (lv.found?.length ?? 0) === 0 && missing.length === lv.evidence.length
              ? ['未呈現解題過程']
              : missing.map((e) => (descOf.get(e.key) || e.label || e.key).replace(/\s*⛔.*$/u, '').trim())
            note = { qid: String(d.questionId), header: `${d.questionId}（${maxScore} 分）${LEVEL_NAME_RS[Number(lv.level)] ?? ''}，得 ${score} 分。未呈現或表達錯誤：`, lines, ref: '' }
          } else if (Array.isArray(vj) && vj.length) {
            const miss = vj.filter((i) => i.verdict !== 'correct')
            note = { qid: String(d.questionId), header: `${d.questionId}（${maxScore} 分）得 ${score} 分。未達成：`, lines: miss.map((i) => `${i.label || `項目${i.idx}`}（${i.verdict === 'blank' ? '未作答' : '不符'}）`), ref: '' }
          } else if (Array.isArray(rs) && rs.length) {
            const miss = rs.filter((x) => Number(x.score ?? 0) < Number(x.maxScore ?? 0))
            note = { qid: String(d.questionId), header: `${d.questionId}（${maxScore} 分）得 ${score} 分。未滿分：`, lines: miss.map((x) => `${x.dimension ?? '?'} ${Number(x.score ?? 0)}/${Number(x.maxScore ?? 0)}`), ref: '' }
          }
          if (note && note.lines.length) { note.ref = CIRCLED[notes.length] ?? `(${notes.length + 1})`; item.ref = note.ref; notes.push(note) }
        }
        items.push(item)
      }
      const maxTotal = details.reduce((s, d) => s + Number(d.maxScore ?? 0), 0)
      const wrongCount = details.filter((d) => d.isCorrect === false).length
      const lost = items.reduce((s, it) => s + it.lost, 0)
      // 大題扣分（全卷彙總；寫在該大題第一列所在的那一頁）
      const secMap = new Map<string, { lost: number; yMin: number }>()
      for (const it of items) {
        const k = sectionKeyOf(it.qid)
        const sec = secMap.get(k) ?? { lost: 0, yMin: Infinity }
        sec.lost += it.lost; sec.yMin = Math.min(sec.yMin, it.bbox.y)
        secMap.set(k, sec)
      }
      const secAll = Array.from(secMap.values()).filter((s) => s.lost > 0)

      const bmp = await getSubmissionBitmap(sub)
      if (!bmp) throw new Error('無原卷影像')
      const breaks = Array.isArray(sub.pageBreaks) ? sub.pageBreaks.filter((b) => b > 0 && b < 1).sort((a, b) => a - b) : []
      const bounds = [0, ...breaks, 1]
      const who = `${stu.seatNumber}號 ${stu.name ?? ''}`
      for (let p = 0; p < bounds.length - 1; p++) {
        const slice = { y0: bounds[p], y1: bounds[p + 1] }
        const inPage = (ny: number) => ny >= slice.y0 && ny < slice.y1
        const pageItems = items.filter((it) => inPage(it.bbox.y + it.bbox.h / 2))
        const pageSecs = secAll.filter((s) => inPage(s.yMin))
        const pageQids = new Set(pageItems.map((it) => it.qid))
        const pageNotes = notes.filter((n) => pageQids.has(n.qid))
        const blob = await renderOverlayPage(bmp, slice, pageItems, pageSecs, {
          first: p === 0, pageNo: p + 1, pageCount: bounds.length - 1,
          total: typeof sub.score === 'number' ? sub.score : null, maxTotal, wrongCount, lost,
          title: assignment.title, who,
        }, pageNotes)
        const img = await pdf.embedJpg(await blob.arrayBuffer())
        const s = Math.min(A4.w / img.width, A4.h / img.height)
        const dw = img.width * s, dh = img.height * s
        pdf.addPage([A4.w, A4.h]).drawImage(img, { x: (A4.w - dw) / 2, y: (A4.h - dh) / 2, width: dw, height: dh })
      }
      bmp.close()
    } catch (e) {
      console.warn(`[reviewSheet:overlay] 座號${stu.seatNumber} 失敗:`, e)
      failed++
    }
    done++
    onProgress?.('build', done, ordered.length)
  }
  return { assignment, className: classroom?.name ?? '', bytes: await pdf.save(), students: ordered.length - failed, failed }
}

// ── 主流程:組資料 → 逐生渲染(併發 3+失敗循序重試一次) → pdf-lib 依座號合併 → 下載 ──
//   mode='overlay'（預設、2026-09-10）＝原卷註記版；'table'＝逐題表格版（2026-08 定稿）。
export async function downloadClassReviewSheetPdf(
  assignmentId: string,
  opts: { onProgress?: ReviewProgress; mode?: ReviewSheetMode } = {}
): Promise<{ students: number; failed: number }> {
  if ((opts.mode ?? 'overlay') === 'overlay') {
    const r = await buildOverlayClassPdf(assignmentId, opts.onProgress)
    const dateText = new Date().toLocaleDateString('zh-TW')
    const outBuf = new ArrayBuffer(r.bytes.byteLength)
    new Uint8Array(outBuf).set(r.bytes)
    triggerDownload(
      new Blob([outBuf], { type: 'application/pdf' }),
      `檢討單_${safeFileName(r.className)}_${safeFileName(r.assignment.title)}_${dateText.replace(/\//g, '')}.pdf`
    )
    return { students: r.students, failed: r.failed }
  }
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
