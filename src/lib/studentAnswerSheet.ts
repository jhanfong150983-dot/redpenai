// ⏸️ 2026-08-29 當日封存：QR 一對一預印模式因「學校大量油印、全班同卷、跨班共用」需求退場
//   （發卷要對人、責任應回歸學生），改走公版標頭塗卡辨識（見 answerSheetLayout.ts）。
//   本檔保留未接線——若日後小考要「每生一份預印姓名」模式可直接接回。
// 2026-08-29 座號答案卷產生器（QR 對號匯入的前半段）：
//   老師用公版 Word 範本（public/templates/redpen-answer-sheet-template.docx）編好考卷、匯出 PDF，
//   在匯入作業頁選取該空白 PDF → 本模組用 pdf-lib 逐生逐頁蓋「座號＋姓名＋QR」產出整批列印檔。
//   ⛔ 不可拿系統已存的 answerSheetImagePaths 當底圖——那是「填好標準答案」的卷，印給學生=發答案。
//   直接蓋在老師的原始 PDF 上也保留向量列印品質。純 code、零 AI。
import { PDFDocument, rgb } from 'pdf-lib'
import QRCode from 'qrcode'
import type { Assignment, Student } from '@/lib/db'

/** QR payload 版本前綴；格式：RPQR1|assignmentId|classroomId|座號(2位)|頁碼(1起算) */
export const QR_PAYLOAD_PREFIX = 'RPQR1'

export function buildQrPayload(
  assignmentId: string,
  classroomId: string,
  seatNumber: number,
  pageNumber: number
): string {
  return [
    QR_PAYLOAD_PREFIX,
    assignmentId,
    classroomId,
    String(seatNumber).padStart(2, '0'),
    String(pageNumber)
  ].join('|')
}

export interface ParsedQrPayload {
  assignmentId: string
  classroomId: string
  seatNumber: number
  pageNumber: number
}

/** 匯入端（QRcode 模式）解析用；非本系統 QR 回 null */
export function parseQrPayload(text: string): ParsedQrPayload | null {
  if (typeof text !== 'string') return null
  const parts = text.split('|')
  if (parts.length !== 5 || parts[0] !== QR_PAYLOAD_PREFIX) return null
  const seatNumber = parseInt(parts[3], 10)
  const pageNumber = parseInt(parts[4], 10)
  if (!parts[1] || !parts[2] || !Number.isFinite(seatNumber) || !Number.isFinite(pageNumber)) return null
  return { assignmentId: parts[1], classroomId: parts[2], seatNumber, pageNumber }
}

// ── 蓋章版面常數（pt；對齊公版標頭右側「系統座號區」的大致位置）──
const STAMP_MARGIN_TOP = 10
const STAMP_MARGIN_RIGHT = 12
const STAMP_HEIGHT = 96
const QR_SIZE = 88
const INFO_WIDTH = 168
const STAMP_WIDTH = INFO_WIDTH + QR_SIZE + 24 // info + gap + QR + padding

/** 中文（班級/姓名）pdf-lib 標準字型畫不出來 → 用 canvas 畫成 PNG 再嵌入 */
async function renderInfoPng(
  classroomName: string,
  seatLabel: string,
  studentName: string
): Promise<Uint8Array> {
  const scale = 4 // 高解析避免列印鋸齒
  const canvas = document.createElement('canvas')
  canvas.width = INFO_WIDTH * scale
  canvas.height = STAMP_HEIGHT * scale
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('無法建立 canvas')
  ctx.scale(scale, scale)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, INFO_WIDTH, STAMP_HEIGHT)
  ctx.fillStyle = '#111111'
  ctx.textBaseline = 'middle'
  // 大字座號
  ctx.font = 'bold 46px "Noto Sans TC", "Microsoft JhengHei", sans-serif'
  ctx.fillText(seatLabel, 6, 32)
  // 班級＋姓名
  ctx.font = '20px "Noto Sans TC", "Microsoft JhengHei", sans-serif'
  ctx.fillText(classroomName.slice(0, 12), 6, 66)
  ctx.font = 'bold 22px "Noto Sans TC", "Microsoft JhengHei", sans-serif'
  ctx.fillText(studentName.slice(0, 10), 6, 88)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('canvas 轉圖失敗')
  return new Uint8Array(await blob.arrayBuffer())
}

async function renderQrPng(payload: string): Promise<Uint8Array> {
  const dataUrl = await QRCode.toDataURL(payload, {
    errorCorrectionLevel: 'M',
    margin: 1,
    scale: 8
  })
  const base64 = dataUrl.split(',')[1]
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

export interface GenerateSheetOptions {
  assignment: Assignment
  classroomName: string
  students: Student[]
  /** 老師從 Word 匯出的空白考卷 PDF */
  blankPdfBytes: ArrayBuffer
  onProgress?: (done: number, total: number) => void
}

export interface GenerateSheetResult {
  blob: Blob
  pageCountPerStudent: number
  studentCount: number
  /** 空白卷頁數為奇數且多於一頁時，為雙面列印對齊補的空白頁數（每生 0 或 1） */
  paddedBlankPage: boolean
}

/**
 * 產出整班座號答案卷 PDF：學生依座號排序、每人一份完整卷（每頁蓋座號/姓名/QR）。
 * 頁序為「學生1 全頁 → 學生2 全頁 → …」，多頁卷若頁數為奇數會為每生補一張空白頁，
 * 讓雙面列印時不同學生不會印在同一張紙的正反面。
 */
export async function generateStudentAnswerSheetPdf(
  options: GenerateSheetOptions
): Promise<GenerateSheetResult> {
  const { assignment, classroomName, students, blankPdfBytes, onProgress } = options
  const sorted = [...students].sort((a, b) => (a.seatNumber || 0) - (b.seatNumber || 0))
  if (sorted.length === 0) throw new Error('此班級沒有學生名冊')

  const source = await PDFDocument.load(blankPdfBytes)
  const sourcePageCount = source.getPageCount()
  if (sourcePageCount === 0) throw new Error('PDF 沒有任何頁面')

  const needPad = sourcePageCount > 1 && sourcePageCount % 2 === 1
  const out = await PDFDocument.create()

  // 每個學生共用同一張 info PNG；QR 每（生,頁）一張
  const total = sorted.length
  for (let si = 0; si < total; si++) {
    const student = sorted[si]
    const seat = student.seatNumber || 0
    const seatLabel = String(seat).padStart(2, '0')
    const infoPngBytes = await renderInfoPng(classroomName, seatLabel, student.name || '')
    const infoImage = await out.embedPng(infoPngBytes)

    const copied = await out.copyPages(source, source.getPageIndices())
    for (let pi = 0; pi < copied.length; pi++) {
      const page = copied[pi]
      out.addPage(page)
      const { width, height } = page.getSize()
      const zoneX = width - STAMP_MARGIN_RIGHT - STAMP_WIDTH
      const zoneY = height - STAMP_MARGIN_TOP - STAMP_HEIGHT
      // 白底墊在下面，避免老師標頭區沒留乾淨時 QR 解不出來
      page.drawRectangle({
        x: zoneX,
        y: zoneY,
        width: STAMP_WIDTH,
        height: STAMP_HEIGHT,
        color: rgb(1, 1, 1),
        borderColor: rgb(0.72, 0.72, 0.72),
        borderWidth: 0.5
      })
      page.drawImage(infoImage, {
        x: zoneX + 8,
        y: zoneY,
        width: INFO_WIDTH,
        height: STAMP_HEIGHT
      })
      const qrBytes = await renderQrPng(
        buildQrPayload(assignment.id, assignment.classroomId, seat, pi + 1)
      )
      const qrImage = await out.embedPng(qrBytes)
      page.drawImage(qrImage, {
        x: width - STAMP_MARGIN_RIGHT - 8 - QR_SIZE,
        y: zoneY + (STAMP_HEIGHT - QR_SIZE) / 2,
        width: QR_SIZE,
        height: QR_SIZE
      })
    }

    if (needPad) {
      const ref = copied[0].getSize()
      const blank = out.addPage([ref.width, ref.height])
      blank.drawText('(blank page for duplex printing)', {
        x: 40,
        y: 40,
        size: 8,
        color: rgb(0.75, 0.75, 0.75)
      })
      const qrBytes = await renderQrPng(
        buildQrPayload(assignment.id, assignment.classroomId, seat, sourcePageCount + 1)
      )
      const qrImage = await out.embedPng(qrBytes)
      blank.drawImage(qrImage, {
        x: ref.width - STAMP_MARGIN_RIGHT - 8 - QR_SIZE,
        y: ref.height - STAMP_MARGIN_TOP - STAMP_HEIGHT + (STAMP_HEIGHT - QR_SIZE) / 2,
        width: QR_SIZE,
        height: QR_SIZE
      })
    }

    onProgress?.(si + 1, total)
  }

  const bytes = await out.save()
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return {
    blob: new Blob([arrayBuffer], { type: 'application/pdf' }),
    pageCountPerStudent: sourcePageCount + (needPad ? 1 : 0),
    studentCount: sorted.length,
    paddedBlankPage: needPad
  }
}
