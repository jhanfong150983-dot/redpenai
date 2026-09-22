// 作文檢討單（原卷註記版）—— 2026-09-20 user 重新定義：**要像老師親手批改的卷子**。
//
// user 的四點要求：
//   ①不要再多一頁（拿掉原本的「批改建議頁」）
//   ②錯別字圈起來（原要求是打叉；改成圈——老師慣例、不遮筆跡、黑白列印也清楚），旁邊**直式**寫正字
//   ③原句畫波浪線標註＋①②③編號
//   ④級分、總評、逐則建議**全部集中在文章最後的白底方框**（學生沒寫的空白直行）
//
// ⛔ 走過的彎路（實印驗證後推翻，不要再試）：
//   ・建議文字寫在句子「旁邊」（左邊那一行）→ 紅字直接壓在學生的字上，兩邊都看不清
//   ・級分放首頁右上角 → 會壓到第一行的字
//   ・總評字級 0.6 行寬 → 大到有壓迫感，改 0.42
//
// ⛔ 只印老師確認後留下的：teacherVerdict==='ok' 的錯別字不印、被刪掉的眉批不印。
// 位置全部來自 essayResult.columns[].bbox（批改時算好、合併圖 normalized）＋ loc 的格位，
// 前端不再對齊一次。純 canvas＋pdf-lib、零 server 呼叫。
import type { EssayResult, EssayLoc } from '@/lib/db'
import { studentVisibleSentences } from '@/lib/essayFeedbackFilter'
import { essayLevelLabel } from '@/lib/essayScale'

const RED = '#d0021b'
// 老師批改用標楷體（台灣教育類慣例）。Windows＝DFKai-SB／標楷體、macOS＝BiauKai；
//   都沒有才退到明體、最後黑體。⛔ 別只寫黑體——user 09-20 一眼就看出來不是標楷體。
const FONT = '"DFKai-SB","標楷體","BiauKai","Kaiti TC","楷体","Noto Serif TC","PMingLiU",serif'
const MAX_W = 2000
/** 原稿淡化程度（蓋一層白的不透明度）：0＝不淡化、1＝全白 */
const FADE = 0.45
const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫']

export interface EssaySheetMeta {
  title: string
  who: string
  level: number | null
  maxLevel: number
  /** 'gsat'＝學測國寫、成績印等第不印級分；沒給＝會考（原行為） */
  scale?: 'cap' | 'gsat'
  summary: string
}

type Rect = { x: number; y: number; w: number; h: number }
type Col = EssayResult['columns'][number]

// ⭐ 直排標點：canvas 的 fillText 只會畫**橫排字形**，所以直書時位置全錯
//   （user 09-20：「為什麼你的『 上引號會靠右，不是靠左?」）。真正的直排排版要：
//   ・括號類（「」『』（）〔〕《》〈〉【】）與破折號、刪節號 → **轉 90 度**
//   ⛔ 但**句逗類（。，、；：）不要自己移位**：真正的直排排版它們在格子右上，
//     那是因為字型有專門的直排字形；拿橫排字形硬移，反而變成飄在角落、看起來歪掉
//     （user 09-20 實印回報）。維持置中、交給字型原樣呈現。
//   canvas 不會套用字型的 vert/vrt2 直排替代字符，只能自己處理需要旋轉的那幾個。
const ROTATE_PUNCT = new Set([...'「」『』（）〔〕《》〈〉【】〖〗—─－…‥～~'])

/** 畫一個直排字（依標點類別調整方向與位置） */
function drawVChar(ctx: CanvasRenderingContext2D, ch: string, x: number, y: number, size: number) {
  if (ROTATE_PUNCT.has(ch)) {
    ctx.save()
    ctx.translate(x, y + size / 2)
    ctx.rotate(Math.PI / 2)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(ch, 0, 0)
    ctx.restore()
    return
  }
  ctx.fillText(ch, x, y)
}

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
    drawVChar(ctx, ch, x, cy, size)
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

/** 直書、靠**下**對齊（用於方框最後一行最下方的提醒語） */
function drawVerticalBlockBottom(
  ctx: CanvasRenderingContext2D,
  text: string,
  rightX: number,
  bottomY: number,
  size: number,
  maxH: number,
  colGap: number,
): number {
  const step = size * 1.08
  const perCol = Math.max(1, Math.floor(maxH / step))
  let used = 0
  for (let i = 0; i < text.length; i += perCol) {
    const seg = text.slice(i, i + perCol)
    drawVertical(ctx, seg, rightX - used, bottomY - seg.length * step, size, maxH)
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
    const rEnd = cellRect(c, rows, lastRow)
    if (!rEnd) continue
    // ⭐ 2026-09-20 user：不要打叉，也不要螢光筆。改成**整個錯詞圈起來**——
    //   ①這是台灣國文老師的標準慣例，學生一看就懂
    //   ②圈在字的外面、**不會遮住筆跡**（學生要看得到自己寫錯什麼）
    //   ③黑白列印變成灰線圈，照樣清楚；螢光筆在黑白下會變灰塊、反而壓低筆跡對比
    //   ④跟稿紙的直角格線在形狀上分得開（圈是圓的）
    //   詞級錯別字圈**一個**橢圓涵蓋整個詞，不是每格各畫一個（那才像老師圈詞）
    {
      const x0 = toX(r0.x) + 1.5 * u
      const x1 = toX(r0.x + r0.w) - 1.5 * u
      const y0 = toY(r0.y) + 1.5 * u
      const y1 = toY(rEnd.y + rEnd.h) - 1.5 * u
      ctx.globalAlpha = 0.9
      ctx.lineWidth = Math.max(1.5, 2.2 * u)
      ctx.beginPath()
      ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, 0, 0, Math.PI * 2)
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
  // ⛔ 引用到「被老師判定為 AI 抄錯」的眉批不印給學生——那句原句他根本沒寫過。
  //   卷面標註與後面的建議清單要用**同一份**，否則會出現「有標註卻沒有對應建議」。
  const visible = studentVisibleSentences(essay)
  for (const [i, s] of visible.entries()) {
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
      if (cc === fromCol) {
        ctx.globalAlpha = 1
        const size = Math.max(10, 13 * u)
        ctx.font = `bold ${Math.round(size)}px ${FONT}`
        ctx.fillText(CIRCLED[i] ?? `(${i + 1})`, x - size * 0.6, yA - size * 0.15)
      }
    }
  }

  // ── ③ 總評：寫在「學生沒寫的空白直行」，白底方框、直式（比照會考樣卷） ──
  if (isLast) {
    const blanks = essay.columns
      .filter((c) => c.page === pageNo && !c.text && c.bbox)
      .sort((a, b) => a.col - b.col)     // col 越大越左；由右往左依序用
    const summary = meta.summary || fb?.summary || ''
    // ⭐ user：建議欄空間大，「問題」與「建議」分開寫，而且兩個標籤要**等高**。
    //   直書的「等高」＝各自從方框頂端起筆 → 必須拆成兩個 block（同一串文字接著寫就會錯開）。
    const notes = visible.map((x, i) => ({
      problem: `${CIRCLED[i] ?? `(${i + 1})`}問題：${x.problem}`,
      suggestion: `建議：${x.suggestion}`,
    }))
    if (blanks.length && (summary || notes.length)) {
      const bb = blanks[0].bbox!
      const boxRight = toX(bb.x + bb.w)
      const leftLimit = toX(blanks[blanks.length - 1].bbox!.x)
      const boxTop = toY(bb.y)
      const boxH = toY(bb.y + bb.h) - boxTop
      const colW = toX(bb.x + bb.w) - toX(bb.x)

      // 排版順序（user 指定）：建議：①②③ →（空間距）→ 總評：
      // 學測印分數（user 09-22：以分數計、不以等第計）；會考印級分
      const head = meta.level == null ? '' : essayLevelLabel(meta.level, meta.scale ?? 'cap')
      // user 指定：白底方框最後一行最下方加免責提醒（AI 抄寫可能出錯，請人工確認）
      const DISCLAIMER = '※此為AI抄寫後的建議，可能因為字跡、塗改、插入導致錯誤，請務必進行人工確認。'
      const blocks: Array<{ text: string; bold?: boolean; scale?: number; gapAfter?: number; bottom?: boolean }> = []
      if (head) blocks.push({ text: head, bold: true, scale: 1.45, gapAfter: 1.2 })
      if (notes.length) {
        blocks.push({ text: '建議', bold: true, gapAfter: 0.4 })
        for (const nt of notes) {
          // 兩個 block 各自從頂端起筆 → 「問題：」與「建議：」自然等高（user 指定）
          blocks.push({ text: nt.problem, gapAfter: 0.25 })
          blocks.push({ text: nt.suggestion, gapAfter: 1.1 })
        }
        blocks.push({ text: '', gapAfter: 1.6 })          // 建議與總評之間的空間距
      }
      if (summary) {
        blocks.push({ text: '總評', bold: true, gapAfter: 0.4 })
        blocks.push({ text: summary, gapAfter: 1.4 })
      }
      blocks.push({ text: DISCLAIMER, scale: 0.72, bottom: true })

      // ⛔ 上一版把寬度算少了（沒算標題欄與段間距）→ 迴圈提前 break，**最後一則建議被吃掉**
      //   （user 回報「標註有①②，最後只有①的建議」）。改成精算，且**放不下就把字變小**（user 指定）。
      const avail = boxRight - leftLimit
      const widthAt = (size: number) => {
        const gap = size * 0.3
        const perCol = Math.max(1, Math.floor((boxH - size * 1.6) / (size * 1.08)))
        let w = size * 1.6                                  // 左右內距
        for (const b of blocks) {
          const sz = size * (b.scale ?? 1)
          const cols = b.text ? Math.ceil(b.text.length / Math.max(1, Math.floor((boxH - size * 1.6) / (sz * 1.08)))) : 0
          w += cols * (sz + gap) + (b.gapAfter ?? 0.5) * gap
        }
        void perCol
        return w
      }
      let size = Math.max(7, colW * 0.42)
      while (size > 7 && widthAt(size) > avail) size -= 0.5   // 寫不下就縮字，縮到 7px 為底
      const gap = size * 0.3
      const padding = size * 0.8
      const textH = boxH - padding * 2
      const boxLeft = Math.max(leftLimit, boxRight - Math.min(avail, widthAt(size)))

      // 底白方框
      ctx.globalAlpha = 1
      ctx.fillStyle = '#fff'
      ctx.fillRect(boxLeft, boxTop, boxRight - boxLeft, boxH)
      ctx.strokeStyle = RED
      ctx.lineWidth = Math.max(1.2, 1.6 * u)
      ctx.strokeRect(boxLeft, boxTop, boxRight - boxLeft, boxH)

      ctx.fillStyle = RED
      ctx.textAlign = 'center'
      let cx = boxRight - padding - size / 2
      for (const b of blocks) {
        const sz = size * (b.scale ?? 1)
        if (b.text) {
          ctx.font = `${b.bold ? 'bold ' : ''}${Math.round(sz)}px ${FONT}`
          cx -= b.bottom
            ? drawVerticalBlockBottom(ctx, b.text, cx, boxTop + boxH - padding, sz, textH, gap)
            : drawVerticalBlock(ctx, b.text, cx, boxTop + padding, sz, textH, gap)
        }
        cx -= (b.gapAfter ?? 0.5) * gap
        if (cx < boxLeft) break
      }
    }
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
