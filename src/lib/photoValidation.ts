/**
 * photoValidation.ts
 *
 * 學生端拍照後的批次驗證 + 透視校正整合層。
 *
 * 4 項檢查：
 *   1. 四角偵測成功（detectDocumentCorners 回傳非 null）
 *   2. 四角在引導框內（容許溢出 FRAME_TOLERANCE）
 *   3. 紙張面積佔比 ≥ MIN_PAPER_AREA_RATIO
 *   4. 與其他頁不重複（pHash Hamming distance ≥ DUPLICATE_HASH_THRESHOLD）
 *
 * 全部通過才回傳 correctedBlob，UI 應用這個 blob 取代原圖供送出使用。
 */

import {
  detectDocumentCorners,
  type DocumentCorners,
} from './perspectiveCorrection'
import { computePerceptualHash, hammingDistance } from './perceptualHash'
import {
  CAMERA_FRAME,
  FRAME_TOLERANCE,
  MIN_PAPER_AREA_RATIO,
  DUPLICATE_HASH_THRESHOLD,
} from './cameraGuide'

// ─── Types ──────────────────────────────────────────────────────────────────

export type ValidationErrorType =
  | 'no_corners'        // AI 偵測不到紙張四角
  | 'out_of_frame'      // 四角超出引導框
  | 'too_small'         // 紙張在畫面中佔比太低（拍太遠）
  | 'duplicate'         // 與其他頁照片重複

export interface ValidationError {
  type: ValidationErrorType
  message: string
  // 額外 metadata（依 type 不同）
  paperAreaRatio?: number
  duplicateWithIndex?: number
  duplicateDistance?: number
}

export interface PageValidationResult {
  index: number
  ok: boolean
  errors: ValidationError[]
  // 通過時提供：校正後的 blob，可直接拿去送出
  correctedBlob: Blob | null
  // metadata（cache 用，下次驗證可沿用）
  corners: DocumentCorners | null
  hash: string | null
}

export interface PageInput {
  blob: Blob
  // 上次驗證通過的快取結果。若提供且 ok===true，本次跳過 AI 直接重用。
  cached?: PageValidationResult
}

export interface ValidationResult {
  ok: boolean  // 全部頁面都通過才為 true
  perPage: PageValidationResult[]
}

// ─── Main entry ─────────────────────────────────────────────────────────────

export async function validatePhotos(pages: PageInput[]): Promise<ValidationResult> {
  // Step 1: 平行對每張圖跑 detect + hash（cache 命中的跳過）
  const perPageRaw = await Promise.all(
    pages.map((page, i) => processPageRaw(page, i))
  )

  // Step 2: 跨頁重複偵測（兩兩比對 hash）
  const duplicateMap = detectDuplicates(perPageRaw)

  // Step 3: 整合單頁錯誤 + 重複錯誤，決定 ok 與 correctedBlob
  const perPage = await Promise.all(
    perPageRaw.map(async (raw, i) => {
      const errors: ValidationError[] = [...raw.errors]
      const dupIdx = duplicateMap.get(i)
      if (dupIdx !== undefined) {
        errors.push({
          type: 'duplicate',
          message: `與第 ${dupIdx.otherIndex + 1} 頁照片過於相似，可能拍到同一頁`,
          duplicateWithIndex: dupIdx.otherIndex,
          duplicateDistance: dupIdx.distance,
        })
      }

      const ok = errors.length === 0

      // 透視變換已停用：實測任何插值（nearest/bilinear/bicubic）都會柔化中文字、
      // 底線、選項方框等細節，影響 OCR/classify/read 準確率。
      // 通過驗證的照片直接用原圖，保留最佳畫質。
      const correctedBlob: Blob | null = ok ? pages[i].blob : null

      return {
        index: i,
        ok,
        errors,
        correctedBlob,
        corners: raw.corners,
        hash: raw.hash,
      }
    })
  )

  return {
    ok: perPage.every((p) => p.ok),
    perPage,
  }
}

// ─── Per-page processing ────────────────────────────────────────────────────

interface RawPageResult {
  errors: ValidationError[]
  corners: DocumentCorners | null
  hash: string | null
  correctedBlob: Blob | null  // 從 cache 沿用
}

async function processPageRaw(page: PageInput, index: number): Promise<RawPageResult> {
  // Cache hit：直接沿用上次通過的結果
  if (page.cached && page.cached.ok && page.cached.corners && page.cached.hash) {
    return {
      errors: [],
      corners: page.cached.corners,
      hash: page.cached.hash,
      correctedBlob: page.cached.correctedBlob,
    }
  }

  // 平行跑 corner detection + hash
  const [corners, hash] = await Promise.all([
    detectDocumentCorners(page.blob).catch((err) => {
      console.warn(`[photoValidation] detect corners failed for page ${index + 1}:`, err)
      return null
    }),
    computePerceptualHash(page.blob).catch((err) => {
      console.warn(`[photoValidation] hash failed for page ${index + 1}:`, err)
      return null
    }),
  ])

  const errors: ValidationError[] = []

  if (!corners) {
    errors.push({
      type: 'no_corners',
      message: '系統無法辨識作業紙張的邊緣，請在較亮的環境下重拍',
    })
    return { errors, corners: null, hash, correctedBlob: null }
  }

  // Check 2: 四角在引導框內（含容許值）
  if (!cornersInFrame(corners)) {
    errors.push({
      type: 'out_of_frame',
      message: '作業有部分超出引導框，請重新對齊框線拍攝',
    })
  }

  // Check 3: 紙張面積佔比
  const areaRatio = quadrilateralArea(corners)
  if (areaRatio < MIN_PAPER_AREA_RATIO) {
    errors.push({
      type: 'too_small',
      message: '作業在畫面中太小，請拍近一點讓紙張填滿引導框',
      paperAreaRatio: areaRatio,
    })
  }

  return { errors, corners, hash, correctedBlob: null }
}

// ─── Geometry helpers ───────────────────────────────────────────────────────

function cornersInFrame(c: DocumentCorners): boolean {
  const minX = CAMERA_FRAME.LEFT - FRAME_TOLERANCE
  const maxX = 1 - CAMERA_FRAME.RIGHT + FRAME_TOLERANCE
  const minY = CAMERA_FRAME.TOP - FRAME_TOLERANCE
  const maxY = 1 - CAMERA_FRAME.BOTTOM + FRAME_TOLERANCE

  const points = [c.topLeft, c.topRight, c.bottomLeft, c.bottomRight]
  return points.every((p) => p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY)
}

/**
 * 四邊形面積（normalized 0-1，相對整張圖）
 * 用 Shoelace 公式。
 */
function quadrilateralArea(c: DocumentCorners): number {
  const pts = [c.topLeft, c.topRight, c.bottomRight, c.bottomLeft]
  let sum = 0
  for (let i = 0; i < pts.length; i++) {
    const curr = pts[i]
    const next = pts[(i + 1) % pts.length]
    sum += curr.x * next.y - next.x * curr.y
  }
  return Math.abs(sum) / 2
}

// ─── Duplicate detection ────────────────────────────────────────────────────

/**
 * 兩兩比對 hash，回傳 Map<pageIndex, { otherIndex, distance }>
 * 若一頁與多頁重複，回傳距離最近那一對。
 */
function detectDuplicates(
  pages: RawPageResult[]
): Map<number, { otherIndex: number; distance: number }> {
  const result = new Map<number, { otherIndex: number; distance: number }>()
  for (let i = 0; i < pages.length; i++) {
    const hashI = pages[i].hash
    if (!hashI) continue
    for (let j = i + 1; j < pages.length; j++) {
      const hashJ = pages[j].hash
      if (!hashJ) continue
      const dist = hammingDistance(hashI, hashJ)
      if (dist < DUPLICATE_HASH_THRESHOLD) {
        // 兩頁都標為重複（距離記為與最近的那頁）
        recordIfCloser(result, i, j, dist)
        recordIfCloser(result, j, i, dist)
      }
    }
  }
  return result
}

function recordIfCloser(
  map: Map<number, { otherIndex: number; distance: number }>,
  page: number,
  other: number,
  dist: number
) {
  const existing = map.get(page)
  if (!existing || dist < existing.distance) {
    map.set(page, { otherIndex: other, distance: dist })
  }
}
