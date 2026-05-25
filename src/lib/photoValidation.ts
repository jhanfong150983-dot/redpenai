/**
 * photoValidation.ts
 *
 * 學生端拍照後的批次驗證 + 透視校正整合層。
 *
 * 5 項檢查：
 *   1. 四角偵測成功（detectDocumentCorners 回 corners 非 null；額度不足 / 服務錯誤
 *      會走獨立的 insufficient_ink / service_unavailable error type，不誤報成 no_corners）
 *   2. 紙張未被相機畫面切到（無角落座標 = 0 或 1）
 *   3. 四角在引導框內（容許溢出 FRAME_TOLERANCE）
 *   4. 紙張面積佔比 ≥ MIN_PAPER_AREA_RATIO
 *   5. 與其他頁不重複（pHash Hamming distance ≥ DUPLICATE_HASH_THRESHOLD）
 *
 * 全部通過才回傳 correctedBlob，UI 應用這個 blob 取代原圖供送出使用。
 */

import {
  detectDocumentCorners,
  cropToCornersBounds,
  type DocumentCorners,
  type DetectCornersFailReason,
} from './perspectiveCorrection'
import { computePerceptualHash, hammingDistance } from './perceptualHash'
import {
  CAMERA_FRAME,
  FRAME_TOLERANCE,
  MIN_PAPER_AREA_RATIO,
  DUPLICATE_HASH_THRESHOLD,
  MIN_EFFECTIVE_WIDTH_BLOCK,
  MIN_EFFECTIVE_WIDTH_WARN,
  MIN_SHARPNESS_P95,
} from './cameraGuide'

// ─── Types ──────────────────────────────────────────────────────────────────

export type ValidationErrorType =
  | 'no_corners'           // AI 偵測不到紙張四角（畫面真的沒紙、或 AI 回的座標不合法）
  | 'cropped_by_camera'    // 紙張被相機畫面切到（任一角座標 = 0 或 1）
  | 'out_of_frame'         // 四角超出引導框（在相機內但偏離框線）
  | 'too_small'            // 紙張在畫面中佔比太低（拍太遠）
  | 'duplicate'            // 與其他頁照片重複
  | 'low_resolution'       // 校正後 worksheet 區域寬度低於閾值（拍太遠 / 鏡頭差 / 已壓縮過）
  | 'low_sharpness'        // 對焦失敗 / 手震（iPad 自動對焦常掉、平板手震也比手機嚴重）
  | 'wrong_orientation'    // 拍攝方向不符（assignment.pageOrientations 指定 portrait/landscape）
  | 'insufficient_ink'     // 學生 / 老師額度用完，proxy 回 HTTP 402，AI 沒被呼叫
  | 'service_unavailable'  // 拍照檢查服務暫時無法使用（其他 HTTP 錯誤、網路錯誤）

export type ValidationWarningType =
  | 'low_resolution_warn'  // 校正後寬度在 warn 區間：允許上傳但 UI 提示可重拍取得更佳識別

export interface ValidationError {
  type: ValidationErrorType
  message: string
  // 額外 metadata（依 type 不同）
  paperAreaRatio?: number
  effectiveWidth?: number
  duplicateWithIndex?: number
  duplicateDistance?: number
  sharpnessP95?: number
  expectedOrientation?: 'portrait' | 'landscape'
  actualOrientation?: 'portrait' | 'landscape'
}

export interface ValidationWarning {
  type: ValidationWarningType
  message: string
  effectiveWidth?: number
}

export interface PageValidationResult {
  index: number
  ok: boolean
  errors: ValidationError[]
  warnings: ValidationWarning[]
  // 通過時提供：校正後的 blob，可直接拿去送出
  correctedBlob: Blob | null
  effectiveWidth: number | null  // 校正後 worksheet 區域寬度（px），null 表示未測或測失敗
  // metadata（cache 用，下次驗證可沿用）
  corners: DocumentCorners | null
  hash: string | null
}

export interface PageInput {
  blob: Blob
  // assignment.pageOrientations[i]、未提供 = 不檢查方向
  expectedOrientation?: 'portrait' | 'landscape'
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
      const warnings: ValidationWarning[] = []
      const dupIdx = duplicateMap.get(i)
      if (dupIdx !== undefined) {
        errors.push({
          type: 'duplicate',
          message: `這頁和第 ${dupIdx.otherIndex + 1} 頁長得幾乎一樣，可能拍到同一頁了。請確認你有翻頁、再重新拍這一頁。`,
          duplicateWithIndex: dupIdx.otherIndex,
          duplicateDistance: dupIdx.distance,
        })
      }

      // 先做裁切（即使後續可能因解析度被擋下，也要量出實際寬度回報）
      let correctedBlob: Blob | null = null
      let effectiveWidth: number | null = null
      const noPreErrors = errors.length === 0
      if (noPreErrors && raw.corners) {
        try {
          correctedBlob = await cropToCornersBounds(pages[i].blob, raw.corners, 0.05)
          effectiveWidth = await measureBlobWidth(correctedBlob)
        } catch (err) {
          console.warn(`[photoValidation] crop failed for page ${i + 1}, fallback to original:`, err)
          correctedBlob = pages[i].blob
          effectiveWidth = await measureBlobWidth(correctedBlob).catch(() => null)
        }
      }

      // 解析度檢查（在所有其他檢查通過後才看；前面已被擋下就不重複提示）
      if (noPreErrors && effectiveWidth !== null) {
        if (effectiveWidth < MIN_EFFECTIVE_WIDTH_BLOCK) {
          errors.push({
            type: 'low_resolution',
            message: '作業在照片裡太模糊了。先試試把手機更靠近作業、讓紙張填滿畫面再拍一次。如果還是不行，可能要換新一點的手機或請老師幫你上傳。',
            effectiveWidth,
          })
        } else if (effectiveWidth < MIN_EFFECTIVE_WIDTH_WARN) {
          warnings.push({
            type: 'low_resolution_warn',
            message: '照片有點不夠清楚、批改可能會看錯字。建議手機靠近作業重拍一次比較準（不重拍也能送出）。',
            effectiveWidth,
          })
        }
      }

      // 銳利度檢查（對焦失敗 / 手震）— iPad 自動對焦常掉，靠這層擋
      // 量 p95 Laplacian（最強 5% 邊緣的平均強度）、跟「字寫多寫少」無關
      if (noPreErrors && correctedBlob) {
        const sharpnessP95 = await measureBlobSharpness(correctedBlob)
        if (sharpnessP95 !== null && sharpnessP95 < MIN_SHARPNESS_P95) {
          errors.push({
            type: 'low_sharpness',
            message: '照片對焦沒對到、看起來糊糊的（老師批改時會認不出字）。請點一下螢幕上的作業讓相機對焦清楚、再拍一次。平板比手機難對焦、可以拿穩一點、距離保持在能看清楚字的位置。',
            sharpnessP95,
          })
        }
      }

      const ok = errors.length === 0
      // 若被 low_resolution block 擋下，仍提供 correctedBlob = null 讓 UI 不誤用
      if (!ok) correctedBlob = null

      return {
        index: i,
        ok,
        errors,
        warnings,
        correctedBlob,
        effectiveWidth,
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

  // Orientation check：在 AI corner detection 前 fail fast、省 Gemini API quota
  // assignment.pageOrientations 由老師建答案卷時自動偵測（AnswerBank.tsx）
  if (page.expectedOrientation) {
    const orientationError = await checkOrientation(page.blob, page.expectedOrientation, index)
    if (orientationError) {
      return { errors: [orientationError], corners: null, hash: null, correctedBlob: null }
    }
  }

  // 平行跑 corner detection + hash
  const [detectResult, hash] = await Promise.all([
    detectDocumentCorners(page.blob).catch((err): { corners: DocumentCorners | null; reason: DetectCornersFailReason } => {
      console.warn(`[photoValidation] detect corners failed for page ${index + 1}:`, err)
      return { corners: null, reason: 'network_error' }
    }),
    computePerceptualHash(page.blob).catch((err) => {
      console.warn(`[photoValidation] hash failed for page ${index + 1}:`, err)
      return null
    }),
  ])

  const errors: ValidationError[] = []
  const corners = detectResult.corners

  if (!corners) {
    errors.push(buildDetectFailureError(detectResult.reason))
    return { errors, corners: null, hash, correctedBlob: null }
  }

  // Check 2: 紙張未被相機畫面切到
  // AI 看到紙張角超出畫面時，依 prompt 指示會 clamp 座標到 0 或 1
  // → 任一座標 ≤ 0.001 或 ≥ 0.999 = 紙張超出相機畫面
  if (isCroppedByCamera(corners)) {
    errors.push({
      type: 'cropped_by_camera',
      message: '作業有一邊跑出畫面外。請把手機拿遠一點，看到整張作業紙都進畫面，再重新拍一次。',
    })
  }

  // Check 3: 四角在引導框內（含容許值）
  if (!cornersInFrame(corners)) {
    errors.push({
      type: 'out_of_frame',
      message: '作業沒有對齊框線。請把作業紙的 4 個角對準畫面上的虛線框，再按拍照。',
    })
  }

  // Check 4: 紙張面積佔比
  const areaRatio = quadrilateralArea(corners)
  if (areaRatio < MIN_PAPER_AREA_RATIO) {
    errors.push({
      type: 'too_small',
      message: '作業離鏡頭太遠了。請把手機靠近作業、讓紙張填滿框線，再重拍。',
      paperAreaRatio: areaRatio,
    })
  }

  return { errors, corners, hash, correctedBlob: null }
}

// ─── Detect failure → user-facing error mapping ────────────────────────────

/**
 * 把 detectDocumentCorners 的失敗 reason 對映成學生看得懂的錯誤訊息。
 *
 * 重點：HTTP 402（額度不足）絕對不能誤報成「找不到作業紙張的邊」，否則學生會
 * 不停重拍永遠不會過。這個函數就是為了根治那條 UX bug 拆出來的。
 */
function buildDetectFailureError(reason: DetectCornersFailReason | undefined): ValidationError {
  switch (reason) {
    case 'insufficient_ink':
      return {
        type: 'insufficient_ink',
        message: '帳號額度已用完，這頁無法檢查與上傳。請聯絡老師補充額度後再試。',
      }
    case 'http_error':
    case 'network_error':
      return {
        type: 'service_unavailable',
        message: '拍照檢查服務暫時無法使用，請確認網路後再試。如持續無法使用請聯絡老師。',
      }
    case 'no_paper':
    case 'invalid_format':
    default:
      return {
        type: 'no_corners',
        message: '找不到作業紙張的邊。請把作業攤平放在乾淨的桌面上，移到光線比較亮的地方再拍一次。',
      }
  }
}

// ─── Orientation check ─────────────────────────────────────────────────────

/**
 * 比對拍照方向 vs 答案卷指定方向。
 *
 * createImageBitmap 在 iOS Safari / Chrome 都會自動套用 EXIF orientation、
 * bitmap.width/height 對應視覺上的方向、不需另外讀 EXIF。
 *
 * 失敗（無法讀圖）回 null = 不擋、由後續流程處理。
 */
async function checkOrientation(
  blob: Blob,
  expected: 'portrait' | 'landscape',
  index: number
): Promise<ValidationError | null> {
  try {
    const bitmap = await createImageBitmap(blob)
    const w = bitmap.width
    const h = bitmap.height
    bitmap.close()
    if (w === 0 || h === 0) return null
    // h === w 罕見、A4 比例本來就不會 1:1。直接 h >= w 判 portrait
    const actual: 'portrait' | 'landscape' = h >= w ? 'portrait' : 'landscape'
    if (actual === expected) return null
    return {
      type: 'wrong_orientation',
      message:
        expected === 'portrait'
          ? `第 ${index + 1} 頁應為「直拍」（紙張較長的一邊跟手機長邊平行）、你拍的是橫的。請把手機豎直、紙張直放再拍一次。`
          : `第 ${index + 1} 頁應為「橫拍」（紙張較長的一邊跟手機長邊垂直）、你拍的是直的。請把手機橫握、紙張橫放再拍一次。`,
      expectedOrientation: expected,
      actualOrientation: actual,
    }
  } catch (err) {
    console.warn(`[photoValidation] checkOrientation failed for page ${index + 1}:`, err)
    return null
  }
}

// ─── Width measurement ─────────────────────────────────────────────────────

/**
 * 量 Blob 圖片的像素寬度。失敗回 null（不擋上傳、由上層決定）。
 * 用於檢查 cropToCornersBounds 後 worksheet 區域實際是不是夠 OCR 用。
 */
async function measureBlobWidth(blob: Blob): Promise<number | null> {
  try {
    const bmp = await createImageBitmap(blob)
    const w = bmp.width
    bmp.close()
    return w
  } catch (err) {
    console.warn('[photoValidation] measureBlobWidth failed:', err)
    return null
  }
}

/**
 * 量銳利度（focus / motion blur）。
 *
 * Downsample 到 512 寬灰階、算 Laplacian abs 的 top 5% 平均（p95 sharpness）。
 * 用 p95 而不是 variance：variance 會被「字寫多寫少」放大、p95 只看最強邊緣
 * 強度、跟內容多寡無關、純測對焦銳利度。
 *
 * 失敗回 null（不擋）。成功回 ~10-200 範圍的數字，閾值見 MIN_SHARPNESS_P95。
 */
async function measureBlobSharpness(blob: Blob): Promise<number | null> {
  try {
    const bmp = await createImageBitmap(blob)
    const targetW = 512
    const scale = targetW / bmp.width
    const targetH = Math.max(1, Math.round(bmp.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = targetW
    canvas.height = targetH
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) {
      bmp.close()
      return null
    }
    ctx.drawImage(bmp, 0, 0, targetW, targetH)
    bmp.close()
    const { data } = ctx.getImageData(0, 0, targetW, targetH)
    const n = targetW * targetH
    const gray = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      gray[i] = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) | 0
    }
    // 3x3 Laplacian: [0,1,0; 1,-4,1; 0,1,0]、收集絕對值
    const lap: number[] = []
    for (let y = 1; y < targetH - 1; y++) {
      for (let x = 1; x < targetW - 1; x++) {
        const i = y * targetW + x
        const v = -4 * gray[i] + gray[i - 1] + gray[i + 1] + gray[i - targetW] + gray[i + targetW]
        const abs = Math.abs(v)
        if (abs > 0) lap.push(abs)
      }
    }
    if (lap.length === 0) return null
    lap.sort((a, b) => b - a)
    const topN = Math.max(1, Math.floor(lap.length * 0.05))
    let sum = 0
    for (let i = 0; i < topN; i++) sum += lap[i]
    return sum / topN
  } catch (err) {
    console.warn('[photoValidation] measureBlobSharpness failed:', err)
    return null
  }
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
 * 檢查紙張是否被相機畫面切到。
 *
 * AI prompt 規定：若紙張角超出相機畫面（cropped），把座標 clamp 到 0 或 1。
 * → 任一座標 ≤ 0.001 或 ≥ 0.999 表示「AI 看不到完整邊」= 紙張被切。
 *
 * 0.001 容忍 floating-point 雜訊；正常對齊引導框拍攝會回 (0.03, 0.05) 這種值，
 * 不會碰邊。
 */
function isCroppedByCamera(c: DocumentCorners): boolean {
  const points = [c.topLeft, c.topRight, c.bottomLeft, c.bottomRight]
  const EDGE = 0.001
  return points.some((p) =>
    p.x <= EDGE || p.x >= 1 - EDGE || p.y <= EDGE || p.y >= 1 - EDGE
  )
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
