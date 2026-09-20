// 2026-09-19 作文檢討單（原卷註記版）：學生的作文原卷做底，疊紅筆註記；批改建議另起一頁。
//   ⛔ 只印老師確認過的內容——疑似錯別字在複核畫面被移除的、眉批被刪掉的，都不會出現在這裡。
//   紅字位置用 essayResult.columns[].bbox（批改時由四角錨點對齊算好、合併圖 normalized），前端不再對齊一次。
//   純 canvas＋pdf-lib、零 server 呼叫（同既有的原卷註記版）。
import type { EssayResult, EssayLoc } from '@/lib/db'

const RED = '#d0021b'
const FONT = '"Noto Sans TC","Microsoft JhengHei","PingFang TC","Heiti TC",sans-serif'
const MAX_W = 1800
const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫']

export interface EssaySheetMeta {
  title: string
  who: string
  level: number | null
  maxLevel: number
  summary: string
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = []
  let cur = ''
  for (const ch of text) {
    const t = cur + ch
    if (ctx.measureText(t).width > maxW && cur) { out.push(cur); cur = ch } else cur = t
  }
  if (cur) out.push(cur)
  return out
}

const colOf = (r: EssayResult, loc: EssayLoc) =>
  r.columns.find((c) => c.page === loc.page && c.col === loc.col)

/** 一頁原卷 + 紅筆註記 → JPEG */
async function renderPage(
  bmp: ImageBitmap,
  slice: { y0: number; y1: number },
  pageNo: number,
  marks: Array<{ bbox: { x: number; y: number; w: number; h: number }; ref: string }>,
  typos: Array<{ bbox: { x: number; y: number; w: number; h: number }; correct: string }>,
  meta: EssaySheetMeta,
): Promise<Blob> {
  const scale = Math.min(1, MAX_W / bmp.width)
  const sliceH = (slice.y1 - slice.y0) * bmp.height
  const W = Math.max(1, Math.round(bmp.width * scale))
  const H = Math.max(1, Math.round(sliceH * scale))
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('無法建立畫布')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, W, H)
  ctx.drawImage(bmp, 0, Math.round(slice.y0 * bmp.height), bmp.width, Math.round(sliceH), 0, 0, W, H)

  // 這一頁的 y 換算：合併圖 normalized → 本頁像素
  const toY = (ny: number) => (ny - slice.y0) / (slice.y1 - slice.y0) * H
  const u = W / 1000

  ctx.save()
  ctx.strokeStyle = RED
  ctx.fillStyle = RED
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  // ① 有眉批的直行：沿該行「右側」畫一條紅線＋編號（右側是窄欄、不會蓋到字）
  for (const m of marks) {
    const x = (m.bbox.x + m.bbox.w) * W - 2 * u
    const y0 = toY(m.bbox.y)
    const y1 = toY(m.bbox.y + m.bbox.h)
    ctx.globalAlpha = 0.65
    ctx.lineWidth = Math.max(1.6, 2.4 * u)
    ctx.beginPath()
    ctx.moveTo(x, y0)
    ctx.lineTo(x, y1)
    ctx.stroke()
    ctx.globalAlpha = 1
    ctx.font = `bold ${Math.round(16 * u)}px ${FONT}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.fillText(m.ref, x, Math.max(18 * u, y0 - 3 * u))
  }

  // ② 疑似錯別字：在該行右側窄欄寫正字（不圈字，避免蓋掉學生筆跡）
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  for (const t of typos) {
    const x = (t.bbox.x + t.bbox.w) * W - 9 * u
    const y = toY(t.bbox.y + t.bbox.h / 2)
    ctx.font = `bold ${Math.round(13 * u)}px ${FONT}`
    ctx.globalAlpha = 0.9
    ctx.fillText(t.correct, x, y)
  }
  ctx.restore()

  // ③ 首頁右上角：級分
  if (pageNo === 1 && meta.level != null) {
    ctx.save()
    ctx.fillStyle = RED
    ctx.font = `bold ${Math.round(34 * u)}px ${FONT}`
    ctx.textAlign = 'right'
    ctx.textBaseline = 'top'
    ctx.fillText(`${meta.level} 級分`, W - 14 * u, 12 * u)
    ctx.restore()
  }
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('原卷註記輸出失敗'))), 'image/jpeg', 0.85))
}

/** 批改建議頁（眉批全文、錯別字、段落建議、優點、總評）→ JPEG，A4 直式 */
async function renderNotesPage(r: EssayResult, meta: EssaySheetMeta): Promise<Blob> {
  const W = 1240
  const H = 1754 // A4 @150dpi
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('無法建立畫布')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, W, H)
  const M = 64
  let y = M

  ctx.fillStyle = '#111'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.font = `bold 30px ${FONT}`
  ctx.fillText('批改建議', M, y)
  ctx.font = `18px ${FONT}`
  ctx.fillStyle = '#555'
  ctx.fillText(`${meta.title}  ${meta.who}`, M + 140, y + 8)
  if (meta.level != null) {
    ctx.fillStyle = RED
    ctx.font = `bold 26px ${FONT}`
    ctx.textAlign = 'right'
    ctx.fillText(`${meta.level} / ${meta.maxLevel} 級分`, W - M, y + 2)
    ctx.textAlign = 'left'
  }
  y += 52
  ctx.strokeStyle = '#ddd'
  ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(M, y); ctx.lineTo(W - M, y); ctx.stroke()
  y += 22

  const section = (title: string) => {
    ctx.fillStyle = '#111'
    ctx.font = `bold 21px ${FONT}`
    ctx.fillText(title, M, y)
    y += 32
  }
  const para = (text: string, color = '#333', size = 17, indent = 0) => {
    ctx.fillStyle = color
    ctx.font = `${size}px ${FONT}`
    for (const line of wrap(ctx, text, W - M * 2 - indent)) {
      if (y > H - M) return
      ctx.fillText(line, M + indent, y)
      y += size + 9
    }
  }

  const fb = r.feedback
  if (fb?.summary) { section('總評'); para(fb.summary); y += 16 }

  const sents = fb?.sentenceFeedback ?? []
  if (sents.length) {
    section('逐句修改建議')
    sents.forEach((s, i) => {
      if (y > H - M - 60) return
      const ref = CIRCLED[i] ?? `(${i + 1})`
      const loc = s.loc ? `第 ${s.loc.page} 頁・第 ${s.loc.col} 行` : ''
      ctx.fillStyle = RED
      ctx.font = `bold 18px ${FONT}`
      ctx.fillText(`${ref} ${s.dimension}${s.rubricTerm ? `・${s.rubricTerm}` : ''}`, M, y)
      ctx.fillStyle = '#888'
      ctx.font = `14px ${FONT}`
      ctx.fillText(loc, M + 420, y + 3)
      y += 26
      para(`原句：${s.quote}`, '#666', 16, 22)
      para(`問題：${s.problem}`, '#333', 16, 22)
      para(`可以改成：${s.suggestion}`, '#0a5a2a', 16, 22)
      y += 12
    })
    y += 8
  }

  // ⛔ 老師判定「正確無誤」的不印給學生（紀錄仍保留在 essayResult，只是不呈現）
  const typos = (fb?.typos ?? []).filter((t) => t.teacherVerdict !== 'ok')
  if (typos.length) {
    section('錯別字')
    para(typos.map((t) => `${t.wrong}→${t.correct}`).join('　'), '#333', 17, 0)
    y += 18
  }

  const paras = fb?.paragraphFeedback ?? []
  if (paras.length) {
    section('段落與結構')
    for (const p of paras) para(`第 ${p.paragraph} 段：${p.comment}`, '#333', 16, 0)
    y += 18
  }

  const good = fb?.strengths ?? []
  if (good.length) {
    section('寫得好的地方')
    for (const g of good) { para(g.quote, '#333', 16, 0); para(g.why, '#0a5a2a', 15, 22) }
  }

  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('建議頁輸出失敗'))), 'image/jpeg', 0.9))
}

/**
 * 一位學生的作文檢討單 → JPEG 頁面陣列（原卷各頁＋批改建議頁）。
 * 呼叫端負責嵌進 pdf-lib（沿用既有的班級合併流程）。
 */
export async function buildEssayReviewPages(
  bmp: ImageBitmap,
  pageBreaks: number[] | undefined,
  essay: EssayResult,
  meta: EssaySheetMeta,
): Promise<Blob[]> {
  const fb = essay.feedback
  // 只印老師留下來的：複核畫面刪掉的眉批／錯別字不會出現在這裡
  const marksAll = (fb?.sentenceFeedback ?? []).map((s, i) => {
    const c = s.loc ? colOf(essay, s.loc) : undefined
    return c?.bbox ? { bbox: c.bbox, ref: CIRCLED[i] ?? `(${i + 1})` } : null
  }).filter((x): x is { bbox: { x: number; y: number; w: number; h: number }; ref: string } => !!x)
  const typosAll = (fb?.typos ?? []).filter((t) => t.teacherVerdict !== 'ok').map((t) => {
    const c = t.loc ? colOf(essay, t.loc) : undefined
    return c?.bbox ? { bbox: c.bbox, correct: t.correct } : null
  }).filter((x): x is { bbox: { x: number; y: number; w: number; h: number }; correct: string } => !!x)

  // ⛔ 2026-09-20：老師匯入的卷一律沒有 pageBreaks（全庫只有 0.7% 有）。沒有 fallback 的話
  //   bounds=[0,1] → 兩頁作文會被壓成一張、紅筆註記的位置也全錯。
  //   頁數不從題號反推（見 feedback_dont_infer_total_pages_from_question_ids），
  //   改用批改當下就記在 essayResult.columns[].page 的頁碼——那是最可靠的來源。
  let breaks = (pageBreaks ?? []).filter((b) => b > 0 && b < 1).sort((a, b) => a - b)
  if (breaks.length === 0) {
    const pageCount = Math.max(1, ...essay.columns.map((c) => c.page || 1))
    if (pageCount > 1) breaks = Array.from({ length: pageCount - 1 }, (_, i) => (i + 1) / pageCount)
  }
  const bounds = [0, ...breaks, 1]
  const pages: Blob[] = []
  for (let p = 0; p < bounds.length - 1; p++) {
    const slice = { y0: bounds[p], y1: bounds[p + 1] }
    const inPage = (b: { y: number; h: number }) => {
      const mid = b.y + b.h / 2
      return mid >= slice.y0 && mid < slice.y1
    }
    pages.push(await renderPage(
      bmp, slice, p + 1,
      marksAll.filter((m) => inPage(m.bbox)),
      typosAll.filter((t) => inPage(t.bbox)),
      meta,
    ))
  }
  pages.push(await renderNotesPage(essay, meta))
  return pages
}
