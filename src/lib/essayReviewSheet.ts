// 作文檢討單（原卷註記版）—— 2026-09-20 user 重新定義：**要像老師親手批改的卷子**。
//
// user 的四點要求：
//   ①不要再多一頁（拿掉原本的「批改建議頁」）
//   ②錯別字在該格打叉，旁邊**直式**寫下修改後的字
//   ③原句畫記（波浪線），**旁邊直接附上**「建議可以改成：…」
//   ④總評放在**作文最後、學生沒寫的位置**，比照會考樣卷：白底方框、直式書寫
//
// ⛔ 只印老師確認後留下的：teacherVerdict==='ok' 的錯別字不印、被刪掉的眉批不印。
// 位置全部來自 essayResult.columns[].bbox（批改時算好、合併圖 normalized）＋ loc 的格位，
// 前端不再對齊一次。純 canvas＋pdf-lib、零 server 呼叫。
import type { EssayResult, EssayLoc } from '@/lib/db'

const RED = '#d0021b'
const FONT = '"Noto Sans TC","Microsoft JhengHei","PingFang TC","Heiti TC",sans-serif'
const MAX_W = 2000
/** 原稿淡化程度（蓋一層白的不透明度）：0＝不淡化、1＝全白 */
const FADE = 0.45

export interface EssaySheetMeta {
  title: string
  who: string
  level: number | null
  maxLevel: number
  summary: string
}

type Rect = { x: number; y: number; w: number; h: number }
type Col = EssayResult['columns'][number]

/** 直書：一個字一個字往下畫，回傳實際用掉的高度 */
function drawVertical(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  maxH: number,
): number {
  const step = size * 1.08
  let cy = y
  for (const ch of text) {
    if (cy + step > y + maxH) break
    ctx.fillText(ch, x, cy)
    cy += step
  }
  return cy - y
}

/** 直書換行：寫到底就往左再開一行，回傳用掉的總寬度 */
function drawVerticalBlock(
  ctx: CanvasRenderingContext2D,
  text: string,
  rightX: number,
  topY: number,
  size: number,
  maxH: number,
  colGap: number,
): number {
  const step = size * 1.08
  const perCol = Math.max(1, Math.floor(maxH / step))
  let used = 0
  for (let i = 0; i < text.length; i += perCol) {
    drawVertical(ctx, text.slice(i, i + perCol), rightX - used, topY, size, maxH)
    used += size + colGap
  }
  return used
}

const colOf = (r: EssayResult, page: number, col: number) =>
  r.columns.find((c) => c.page === page && c.col === col)

/** 某一行第 row 格（1-based）在合併圖上的矩形 */
function cellRect(c: Col, rows: number, row: number): Rect | null {
  if (!c.bbox) return null
  const cellH = c.bbox.h / Math.max(1, rows)
  return { x: c.bbox.x, y: c.bbox.y + (row - 1) * cellH, w: c.bbox.w, h: cellH }
}

/** 一頁原卷 + 老師式紅筆註記 → JPEG */
async function renderPage(
  bmp: ImageBitmap,
  slice: { y0: number; y1: number },
  pageNo: number,
  essay: EssayResult,
  meta: EssaySheetMeta,
  isLast: boolean,
): Promise<Blob> {
  const rows = essay.rows ?? 22
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
  // ⭐ 2026-09-20 user：原稿太搶眼，紅筆批改反而看不清楚 → 蓋一層半透明白，讓原稿退到背景。
  //   紅字就能像老師直接寫在卷面上一樣清楚。學生仍看得見自己寫了什麼。
  ctx.fillStyle = `rgba(255,255,255,${FADE})`
  ctx.fillRect(0, 0, W, H)

  // 合併圖 normalized → 本頁像素
  const toY = (ny: number) => ((ny - slice.y0) / (slice.y1 - slice.y0)) * H
  const toX = (nx: number) => nx * W
  const inPage = (ny: number) => ny >= slice.y0 && ny < slice.y1
  const u = W / 1000

  ctx.save()
  ctx.strokeStyle = RED
  ctx.fillStyle = RED
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'

  const fb = essay.feedback

  // ── ① 錯別字：在該格打叉，右側行間直式寫下正確的字 ──
  for (const t of fb?.typos ?? []) {
    if (t.teacherVerdict === 'ok') continue          // 老師判定誤報 → 不印給學生
    const loc = t.loc as EssayLoc | null
    if (!loc?.row) continue
    const c = colOf(essay, loc.page, loc.col)
    if (!c?.bbox) continue
    const r0 = cellRect(c, rows, loc.row)
    if (!r0 || !inPage(r0.y + r0.h / 2)) continue
    const lastRow = Math.min(rows, loc.toRow ?? loc.row)
    // 錯詞可能跨好幾格 → 每一格都打叉
    for (let rr = loc.row; rr <= lastRow; rr++) {
      const rc = cellRect(c, rows, rr)
      if (!rc || !inPage(rc.y + rc.h / 2)) continue
      const x0 = toX(rc.x) + 2 * u
      const x1 = toX(rc.x + rc.w) - 2 * u
      const y0 = toY(rc.y) + 2 * u
      const y1 = toY(rc.y + rc.h) - 2 * u
      ctx.globalAlpha = 0.8
      ctx.lineWidth = Math.max(1.4, 2 * u)
      ctx.beginPath()
      ctx.moveTo(x0, y0); ctx.lineTo(x1, y1)
      ctx.moveTo(x1, y0); ctx.lineTo(x0, y1)
      ctx.stroke()
    }
    // 正確的字寫在該行右側行間（與插入字同一個慣例），直式
    ctx.globalAlpha = 1
    const cellH = toY(r0.y + r0.h) - toY(r0.y)
    const size = Math.max(9, cellH * 0.5)
    ctx.font = `bold ${Math.round(size)}px ${FONT}`
    drawVertical(ctx, t.correct, toX(r0.x + r0.w) - size * 0.5, toY(r0.y), size, cellH * (lastRow - loc.row + 1.8))
  }

  // ── ② 眉批句子：沿該句畫波浪線，**建議直接寫在句子旁邊**（user：不要編號另列清單） ──
  for (const [i, s] of (fb?.sentenceFeedback ?? []).entries()) {
    const loc = s.loc as EssayLoc | null
    if (!loc) continue
    const fromCol = loc.col
    const toCol = loc.toCol ?? loc.col
    for (let cc = fromCol; cc <= toCol; cc++) {
      const c = colOf(essay, loc.page, cc)
      if (!c?.bbox) continue
      const startRow = cc === fromCol ? (loc.row ?? 1) : 1
      const endRow = cc === toCol ? (loc.toRow ?? rows) : rows
      const a = cellRect(c, rows, startRow)
      const b = cellRect(c, rows, Math.max(startRow, endRow))
      if (!a || !b || !inPage(a.y + a.h / 2)) continue
      // 直書的句子沿著行往下走 → 波浪線畫在該行左緣
      const x = toX(c.bbox.x) + 2.5 * u
      const yA = toY(a.y)
      const yB = toY(b.y + b.h)
      ctx.globalAlpha = 0.85
      ctx.lineWidth = Math.max(1.2, 1.8 * u)
      ctx.beginPath()
      const amp = 2.2 * u
      const per = 7 * u
      ctx.moveTo(x, yA)
      for (let y = yA; y < yB; y += per) {
        ctx.quadraticCurveTo(x + amp, y + per / 4, x, y + per / 2)
        ctx.quadraticCurveTo(x - amp, y + (per * 3) / 4, x, y + per)
      }
      ctx.stroke()
      void i
    }
  }

  // 建議文字：寫在該句**左邊那一行**（直書的「旁邊」＝往左），與句子同高、直式、紅筆。
  //   原稿已淡化，寫在學生字上仍讀得清楚——這就是老師在行間寫評語的樣子。
  for (const s of fb?.sentenceFeedback ?? []) {
    const loc = s.loc as EssayLoc | null
    if (!loc) continue
    const startCol = (loc.toCol ?? loc.col) + 1        // col 越大越左 → +1 就是左邊那一行
    const anchor = colOf(essay, loc.page, loc.col)
    const target = colOf(essay, loc.page, startCol) ?? anchor
    if (!anchor?.bbox || !target?.bbox) continue
    const startRow = loc.row ?? 1
    const a0 = cellRect(anchor, rows, startRow)
    if (!a0 || !inPage(a0.y + a0.h / 2)) continue
    const colW = toX(target.bbox.x + target.bbox.w) - toX(target.bbox.x)
    const size = Math.max(9, colW * 0.46)
    const top = toY(a0.y)
    const maxH = toY(anchor.bbox.y + anchor.bbox.h) - top
    ctx.globalAlpha = 1
    ctx.fillStyle = RED
    ctx.textAlign = 'center'
    ctx.font = `bold ${Math.round(size)}px ${FONT}`
    drawVerticalBlock(ctx, s.suggestion, toX(target.bbox.x + target.bbox.w) - size * 0.7, top, size, maxH, size * 0.25)
  }

  // ── ③ 總評：寫在「學生沒寫的空白直行」，白底方框、直式（比照會考樣卷） ──
  if (isLast) {
    const blanks = essay.columns
      .filter((c) => c.page === pageNo && !c.text && c.bbox)
      .sort((a, b) => a.col - b.col)     // col 越大越左；由右往左依序用
    if (blanks.length) {
      const first = blanks[0]
      const bb = first.bbox!
      const colW = toX(bb.x + bb.w) - toX(bb.x)
      const topY = toY(bb.y) + 4 * u
      const maxH = toY(bb.y + bb.h) - topY - 4 * u
      const size = Math.max(10, colW * 0.6)
      const gap = size * 0.4
      const leftLimit = toX(blanks[blanks.length - 1].bbox!.x)

      ctx.globalAlpha = 1
      ctx.textAlign = 'center'
      // ⛔ user：空白處**只保留底白的綜合評語**，逐句建議已經寫在句子旁邊了
      const summary = meta.summary || fb?.summary || ''
      if (summary) {
        // 方框寬度依評語長度算（一直行放得下幾個字 → 需要幾行），再夾在可用的空白範圍內
        const boxTop = topY - 4 * u
        const boxH = maxH + 8 * u
        const perCol = Math.max(1, Math.floor((boxH - 12 * u) / (size * 1.08)))
        const needCols = Math.ceil((summary.length + 3) / perCol)
        const boxRight = toX(bb.x + bb.w)
        const boxLeft = Math.max(leftLimit, boxRight - (needCols * (size + gap) + size))
        ctx.fillStyle = 'rgba(255,255,255,0.95)'
        ctx.fillRect(boxLeft, boxTop, boxRight - boxLeft, boxH)
        ctx.strokeStyle = RED
        ctx.lineWidth = Math.max(1.2, 1.6 * u)
        ctx.strokeRect(boxLeft, boxTop, boxRight - boxLeft, boxH)
        ctx.fillStyle = RED
        ctx.font = `bold ${Math.round(size)}px ${FONT}`
        // ⛔ 全形空白直接寫在樣板字串裡會觸發 no-irregular-whitespace → 用逸脫碼
        const summaryText = '總評' + '　' + summary
        drawVerticalBlock(ctx, summaryText, boxRight - size * 0.8, boxTop + 6 * u, size, boxH - 12 * u, gap)
      }
    }
  }

  // ── 級分：首頁右上角 ──
  if (pageNo === 1 && meta.level != null) {
    ctx.globalAlpha = 1
    ctx.fillStyle = RED
    ctx.font = `bold ${Math.round(30 * u)}px ${FONT}`
    ctx.textAlign = 'right'
    ctx.textBaseline = 'top'
    ctx.fillText(`${meta.level} 級分`, W - 14 * u, 12 * u)
  }
  ctx.restore()

  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('原卷註記輸出失敗'))), 'image/jpeg', 0.88))
}

/**
 * 一位學生的作文檢討單 → JPEG 頁面陣列（**只有原卷本身，不再多一頁**）。
 * 呼叫端負責嵌進 pdf-lib（沿用既有的班級合併流程）。
 */
export async function buildEssayReviewPages(
  bmp: ImageBitmap,
  pageBreaks: number[] | undefined,
  essay: EssayResult,
  meta: EssaySheetMeta,
): Promise<Blob[]> {
  // ⛔ 老師匯入的卷一律沒有 pageBreaks（全庫只有 0.7% 有）→ 用批改當下記錄的頁碼平均切。
  //   不從題號反推（見 feedback_dont_infer_total_pages_from_question_ids）。
  let breaks = (pageBreaks ?? []).filter((b) => b > 0 && b < 1).sort((a, b) => a - b)
  if (breaks.length === 0) {
    const pageCount = Math.max(1, ...essay.columns.map((c) => c.page || 1))
    if (pageCount > 1) breaks = Array.from({ length: pageCount - 1 }, (_, i) => (i + 1) / pageCount)
  }
  const bounds = [0, ...breaks, 1]

  const pages: Blob[] = []
  for (let p = 0; p < bounds.length - 1; p++) {
    pages.push(await renderPage(
      bmp,
      { y0: bounds[p], y1: bounds[p + 1] },
      p + 1,
      essay,
      meta,
      p === bounds.length - 2,
    ))
  }
  return pages
}
