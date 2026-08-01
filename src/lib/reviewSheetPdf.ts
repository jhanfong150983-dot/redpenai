// 學生檢討單 PDF(2026-08-01 Step 9、user 拍板設計):
//   每生一頁起:頁首(考卷/班級/座號姓名/總分)+「需檢討題目」卡片(扣分題+低信心題:
//   作答裁圖+AI 讀值+得分+理由+正解;低信心=黃框醒目標示)+簽名欄。答對題不列(user 拍板省略)。
//   全對學生=一行「本卷全數答對」+簽名欄。
// 管線:client 組 HTML(裁圖=canvas 裁 bbox、零 AI 成本)→ 逐生 POST /api/report/parent-pdf
//   (真 Chrome 渲染、重用家長報告端點)→ pdf-lib 合併成「一班一個 PDF」直接列印(user 拍板,
//   不用 zip——30 個檔對列印不友善)。單生 HTML 一份一 POST 也避開端點 4MB 上限。
import { db, type Submission, type Student, type Assignment } from '@/lib/db'

const PDF_ENDPOINT = '/api/report/parent-pdf'
const FONT_LINK = '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700;800&display=swap" rel="stylesheet">'

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

export type ReviewCard = {
  qid: string
  score: number
  maxScore: number
  studentAnswer: string
  reason: string
  correctAnswer: string
  lowConfidence: boolean
  cropDataUri: string | null
}
export type StudentSheet = {
  studentId: string
  seat: number
  name: string
  score: number | null
  cards: ReviewCard[]
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

// 裁 bbox 區域 → JPEG data URI。小框放大 2 倍(列印清晰);寬上限 560px。
function cropToDataUri(bmp: ImageBitmap, bbox: Bbox, padX = 0.012, padY = 0.005): string | null {
  try {
    const x0 = Math.max(0, (bbox.x - padX)) * bmp.width
    const y0 = Math.max(0, (bbox.y - padY)) * bmp.height
    const x1 = Math.min(1, bbox.x + bbox.w + padX) * bmp.width
    const y1 = Math.min(1, bbox.y + bbox.h + padY) * bmp.height
    const sw = Math.max(1, Math.round(x1 - x0))
    const sh = Math.max(1, Math.round(y1 - y0))
    let scale = 1
    if (sw < 240) scale = 2
    if (sw > 560) scale = 560 / sw
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(sw * scale))
    canvas.height = Math.max(1, Math.round(sh * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bmp, Math.round(x0), Math.round(y0), sw, sh, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.85)
  } catch {
    return null
  }
}

// ── 資料組裝:一個班(assignment)→ 每位已批改學生的檢討卡片 ──
export async function buildClassReviewSheets(
  assignmentId: string,
  onProgress?: ReviewProgress
): Promise<{ assignment: Assignment; className: string; sheets: StudentSheet[]; skipped: number }> {
  const assignment = await db.assignments.get(assignmentId)
  if (!assignment) throw new Error('找不到考卷資料,請先同步')
  const classroom = await db.classrooms.get(assignment.classroomId)
  const students = await db.students.where('classroomId').equals(assignment.classroomId).toArray()
  const stuById = new Map(students.map((s) => [s.id, s]))
  const subs = (await db.submissions.where('assignmentId').equals(assignmentId).toArray())
    .filter((s) => s.status === 'graded' && s.gradingResult)
  // 正解對照:answerKey questions id → answer
  const akQuestions = (assignment.answerKey?.questions ?? []) as Array<{ id?: string; answer?: unknown }>
  const correctById = new Map(akQuestions.map((q) => [String(q.id ?? ''), String(q.answer ?? '')]))

  const ordered = subs
    .map((sub) => ({ sub, stu: stuById.get(sub.studentId) }))
    .filter((x): x is { sub: Submission; stu: Student } => !!x.stu)
    .sort((a, b) => a.stu.seatNumber - b.stu.seatNumber)

  const sheets: StudentSheet[] = []
  let done = 0
  for (const { sub, stu } of ordered) {
    const details = ((sub.gradingResult as { details?: GradingDetail[] } | undefined)?.details ?? [])
    const picked = details.filter((d) => {
      const max = Number(d.maxScore ?? 0)
      const sc = Number(d.score ?? 0)
      return sc < max || isLowConfidence(d)
    })
    let bmp: ImageBitmap | null = null
    if (picked.some((d) => d.answerBbox)) bmp = await getSubmissionBitmap(sub)
    const cards: ReviewCard[] = picked.map((d) => ({
      qid: d.questionId,
      score: Number(d.score ?? 0),
      maxScore: Number(d.maxScore ?? 0),
      studentAnswer: String(d.studentAnswer ?? ''),
      reason: String(d.scoringReason ?? d.reason ?? ''),
      correctAnswer: correctById.get(d.questionId) ?? '',
      lowConfidence: isLowConfidence(d),
      cropDataUri: bmp && d.answerBbox ? cropToDataUri(bmp, d.answerBbox) : null,
    }))
    bmp?.close()
    sheets.push({
      studentId: stu.id,
      seat: stu.seatNumber,
      name: stu.name,
      score: typeof sub.score === 'number' ? sub.score : null,
      cards,
    })
    done++
    onProgress?.('build', done, ordered.length)
  }
  return {
    assignment,
    className: classroom?.name ?? '',
    sheets,
    skipped: subs.length - sheets.length,
  }
}

// ── HTML 版型 ──
const SHEET_CSS = `
.rs-root { width: 794px; box-sizing: border-box; padding: 34px 44px 30px; font-family: 'Noto Sans TC', sans-serif; color: #0f172a; }
.rs-head { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2.5px solid #0f172a; padding-bottom: 10px; }
.rs-title { font-size: 19px; font-weight: 800; }
.rs-sub { font-size: 12px; color: #475569; margin-top: 3px; }
.rs-who { text-align: right; }
.rs-name { font-size: 15px; font-weight: 700; }
.rs-score { font-size: 24px; font-weight: 800; margin-top: 2px; }
.rs-score small { font-size: 12px; font-weight: 500; color: #64748b; }
.rs-section { font-size: 13px; font-weight: 700; margin: 14px 0 8px; }
.rs-card { border: 1.5px solid #cbd5e1; border-radius: 10px; padding: 9px 13px; margin-bottom: 8px; break-inside: avoid; page-break-inside: avoid; }
.rs-card.low { border-color: #f59e0b; background: #fffbeb; }
.rs-lowtag { display: inline-block; font-size: 10.5px; font-weight: 700; color: #b45309; background: #fef3c7; border: 1px solid #fcd34d; border-radius: 999px; padding: 1px 8px; margin-left: 8px; vertical-align: 1px; }
.rs-qline { font-size: 13px; font-weight: 700; }
.rs-qline .pts { color: #dc2626; font-weight: 800; margin-left: 8px; }
.rs-crop { margin: 7px 0 5px; }
.rs-crop img { max-width: 100%; max-height: 110px; border: 1px solid #e2e8f0; border-radius: 6px; display: block; }
.rs-meta { font-size: 12px; color: #334155; line-height: 1.55; }
.rs-meta b { color: #0f172a; }
.rs-reason { font-size: 11.5px; color: #64748b; margin-top: 3px; line-height: 1.5; }
.rs-allpass { border: 1.5px solid #86efac; background: #f0fdf4; color: #15803d; border-radius: 10px; padding: 14px; font-size: 14px; font-weight: 700; text-align: center; margin-top: 14px; }
.rs-sign { margin-top: 22px; border-top: 1.5px dashed #94a3b8; padding-top: 14px; font-size: 12.5px; color: #334155; display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; }
.rs-signline { white-space: nowrap; }
.rs-signline .blank { display: inline-block; width: 110px; border-bottom: 1px solid #64748b; margin: 0 4px; }
`

function renderSheetHtml(sheet: StudentSheet, header: { title: string; className: string; dateText: string }): string {
  const cards = sheet.cards.map((c) => `
    <div class="rs-card${c.lowConfidence ? ' low' : ''}">
      <div class="rs-qline">${esc(c.qid)}<span class="pts">${c.score}/${c.maxScore} 分</span>${c.lowConfidence ? '<span class="rs-lowtag">⚠ 低信心題,請特別核對</span>' : ''}</div>
      ${c.cropDataUri ? `<div class="rs-crop"><img src="${c.cropDataUri}" alt=""></div>` : ''}
      <div class="rs-meta">AI 讀到:<b>${esc(c.studentAnswer || '(未讀到)')}</b>　　正解:<b>${esc(c.correctAnswer || '—')}</b></div>
      ${c.reason ? `<div class="rs-reason">${esc(c.reason)}</div>` : ''}
    </div>`).join('\n')
  return `
  <div class="rs-root">
    <div class="rs-head">
      <div>
        <div class="rs-title">${esc(header.title)}|學生檢討單</div>
        <div class="rs-sub">${esc(header.className)}・批改日期 ${esc(header.dateText)}</div>
      </div>
      <div class="rs-who">
        <div class="rs-name">${sheet.seat} 號 ${esc(sheet.name)}</div>
        <div class="rs-score">${sheet.score ?? '—'}<small> 分</small></div>
      </div>
    </div>
    ${sheet.cards.length > 0
      ? `<div class="rs-section">▍需要檢討的題目(共 ${sheet.cards.length} 題)</div>\n${cards}`
      : '<div class="rs-allpass">本卷全數答對,無需檢討 🎉</div>'}
    <div class="rs-sign">
      <div>本人已核對本卷批改結果,如有疑義已向老師口頭反映。</div>
      <div class="rs-signline">簽名:<span class="blank"></span>日期:<span class="blank" style="width:80px"></span></div>
    </div>
  </div>`
}

function buildPrintDocument(sheet: StudentSheet, header: { title: string; className: string; dateText: string }): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>學生檢討單</title>${FONT_LINK}
<style>
@page { size: A4; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }
${SHEET_CSS}
</style></head><body>${renderSheetHtml(sheet, header)}</body></html>`
}

async function fetchSheetPdf(sheet: StudentSheet, header: { title: string; className: string; dateText: string }): Promise<ArrayBuffer> {
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

// ── 主流程:組資料 → 逐生渲染(併發 3+失敗重試一次) → pdf-lib 依座號合併 → 下載 ──
export async function downloadClassReviewSheetPdf(
  assignmentId: string,
  opts: { onProgress?: ReviewProgress } = {}
): Promise<{ students: number; failed: number }> {
  const { assignment, className, sheets } = await buildClassReviewSheets(assignmentId, opts.onProgress)
  if (sheets.length === 0) throw new Error('此班尚無已批改的卷,請先完成 AI 批改')
  const dateText = new Date().toLocaleDateString('zh-TW')
  const header = { title: assignment.title, className, dateText }

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
