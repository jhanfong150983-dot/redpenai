import {
  db,
  type Submission,
  type GradingResult,
  type AnswerKey,
  type AnswerKeyQuestion,
  type AnswerExtractionCorrection
} from './db'
import { blobToBase64 as blobToDataUrl, compressImageFile } from './imageCompression'
import { isIndexedDbBlobError, shouldAvoidIndexedDbBlob } from './blob-storage'
import { dispatchInkBalance } from './ink-events'
import { getInkSessionId, startInkSession, setInkSessionId, ensureInkSessionFresh } from './ink-session'

const geminiProxyUrl = import.meta.env.VITE_GEMINI_PROXY_URL || '/api/proxy'

// 你這套設計是「一定走 proxy」：有沒有可用最後由 fetch 成功與否決定
export const isGeminiAvailable = true

const GEMINI_SINGLE_IMAGE_TARGET_BYTES = 1200 * 1024
const GEMINI_DUAL_IMAGE_TARGET_BYTES = 900 * 1024

// ============================================
// Feature Flag: 分頁批改（多頁考卷拆分）
// ============================================
// 當啟用時，大圖片會被拆分成多段分別批改，降低單次請求的超時風險
// 設為 true 開啟，false 關閉（使用傳統單次批改）
const ENABLE_PAGED_GRADING = true

// 分頁批改觸發條件：高寬比閾值
// 超過此比例的圖片會被視為「多頁合併圖」，觸發拆分批改
// 例如 A4 紙約 1.4:1，2 頁合併就是 2.8:1
const PAGED_GRADING_ASPECT_RATIO_THRESHOLD = 2.2  // height/width > 2.2 才視為多頁

// 分頁切割時的重疊區域（像素），避免題目被切斷
// 60px 在大多數情況下足夠，且能減少每段圖片大小
const PAGED_GRADING_OVERLAP_PX = 60

// 分頁批改並行數（不要太高，容易觸發 429）
const PAGED_GRADING_CONCURRENCY = 2
// 批量批改並行數（建議保守，避免放大 4-stage 呼叫壓力）
const BATCH_GRADING_CONCURRENCY = 2
// 每個 worker 完成一份後的節流延遲
const BATCH_GRADING_STAGGER_MS = 800

// Gemini 圖片壓縮的解析度底線
const GEMINI_MIN_WIDTH = 1200      // 一般字 + 手寫仍清楚
const GEMINI_HARD_MIN_WIDTH = 1024 // 再低就容易糊，寧可大一點

async function compressForGemini(
  blob: Blob,
  targetBytes: number,
  label: string
): Promise<Blob> {
  if (blob.size <= targetBytes) return blob

  // 策略：逐步降低品質和解析度，但不低於 hardMinWidth
  const strategies = [
    // 優先降品質，保持較高解析度
    { maxWidth: 1600, quality: 0.82 },
    { maxWidth: 1400, quality: 0.78 },
    { maxWidth: GEMINI_MIN_WIDTH, quality: 0.75 },
    // 到達 minWidth 後，只降品質
    { maxWidth: GEMINI_MIN_WIDTH, quality: 0.70 },
    { maxWidth: GEMINI_MIN_WIDTH, quality: 0.65 },
    // 最後手段：降到 hardMinWidth（但不再往下）
    { maxWidth: GEMINI_HARD_MIN_WIDTH, quality: 0.68 },
    { maxWidth: GEMINI_HARD_MIN_WIDTH, quality: 0.62 }
  ]

  let bestResult = blob
  let bestWidth = Infinity  // 追蹤最佳結果的寬度
  
  // 先取得原圖寬度
  try {
    const originalBitmap = await createImageBitmap(blob)
    bestWidth = originalBitmap.width
    originalBitmap.close()
  } catch {
    // 無法讀取原圖尺寸，繼續嘗試壓縮
  }
  
  for (const strategy of strategies) {
    try {
      const compressed = await compressImageFile(blob, strategy)
      
      // ✅ 驗證輸出寬度，確保不低於底線
      let compressedWidth = strategy.maxWidth
      try {
        const bitmap = await createImageBitmap(compressed)
        compressedWidth = bitmap.width
        bitmap.close()
      } catch {
        // 無法讀取，假設為 maxWidth
      }
      
      // 如果寬度低於硬底線，跳過這個策略
      if (compressedWidth < GEMINI_HARD_MIN_WIDTH) {
        console.warn(`⚠️ ${label} 壓縮後寬度 ${compressedWidth}px < 底線 ${GEMINI_HARD_MIN_WIDTH}px，回退`)
        continue
      }
      
      if (compressed.size < bestResult.size) {
        bestResult = compressed
        bestWidth = compressedWidth
      }
      
      if (bestResult.size <= targetBytes) {
        console.log(`✅ ${label} 壓縮成功: ${Math.round(bestResult.size / 1024)}KB (寬度=${bestWidth}px)`)
        return bestResult
      }
    } catch (error) {
      console.warn(`⚠️ ${label} 壓縮策略失敗:`, error)
    }
  }

  // 到達 hardMinWidth 仍超過目標大小：接受較大的圖片，不再壓縮
  // 寧可 650-900KB 也不要再縮解析度
  if (bestResult.size > targetBytes) {
    const sizeKB = Math.round(bestResult.size / 1024)
    if (sizeKB <= 900) {
      console.log(`⚠️ ${label} 已達解析度底線 (寬度=${bestWidth}px)，保持 ${sizeKB}KB 不再壓縮`)
    } else {
      console.warn(`⚠️ ${label} 圖片仍偏大 (${sizeKB}KB)，但已達解析度底線，無法再壓縮`)
    }
  }

  return bestResult
}

// 工具：Blob 轉 Base64（去掉 data: 前綴）
/**
 * 將 Blob 轉換為 Base64 字符串
 *
 * @param blob - 要轉換的 Blob
 * @param timeoutMs - Timeout 時間（毫秒），預設 10 秒
 * @returns Promise<string> - Base64 字符串（不含 data URL 前綴）
 * @throws Error - 如果轉換失敗或超時
 *
 * 修復：添加 timeout 保護，避免平板Chrome記憶體受限時永久掛起
 */
async function blobToBase64(blob: Blob, timeoutMs: number = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    let timeoutId: number | null = null

    // 成功處理
    reader.onloadend = () => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId)
      }
      const result = reader.result as string
      if (result) {
        // 去掉 data URL 前綴，只保留 Base64 數據
        const base64 = result.split(',')[1]
        if (base64) {
          resolve(base64)
        } else {
          reject(new Error('FileReader 返回的結果不包含有效的 Base64 數據'))
        }
      } else {
        reject(new Error('FileReader 返回空結果'))
      }
    }

    // 錯誤處理
    reader.onerror = () => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId)
      }
      reject(
        new Error(`FileReader 錯誤: ${reader.error?.message || '未知錯誤'}`)
      )
    }

    // Timeout 保護
    timeoutId = window.setTimeout(() => {
      timeoutId = null
      reject(
        new Error(
          `FileReader 超時（${timeoutMs}ms）- 可能是記憶體不足、Blob 損壞，或設備性能受限`
        )
      )
    }, timeoutMs)

    reader.readAsDataURL(blob)
  })
}

type GeminiInlineDataPart = {
  inlineData: {
    mimeType: string
    data: string
  }
}

type GeminiRequestPart = string | GeminiInlineDataPart
type GeminiPart = { text: string } | GeminiInlineDataPart
type GeminiRouteKey =
  | 'grading.evaluate'
  | 'grading.phase_a'
  | 'grading.phase_b'
  | 'grading.locate'
  | 'answer_key.extract'
  | 'answer_key.locate'
  | 'answer_key.reanalyze'
  | 'answer_key.tag_concepts'
  | 'report.teacher_summary'
  | 'report.domain_diagnosis'
  | 'unknown'

// ─── Phase A/B 公開類型 ────────────────────────────────────────────────────────

export interface ArbiterResult {
  arbiterStatus: 'arbitrated_agree' | 'needs_review'
  finalAnswer?: string   // AI1 answer when consistent; undefined when needs_review
  // 新 AI3 一致性判官欄位
  consistent?: boolean
  reason?: string
  // 舊 AI3 鑑識欄位（向後相容）
  forensicMode?: string
  agreementSupport?: string
  ai1Support?: string
  ai2Support?: string
}

export interface PhaseAQuestionResult {
  questionId: string
  questionType?: string
  consistencyStatus: 'stable' | 'diff' | 'unstable'
  consistencyReason?: string
  readAnswer1: { status: string; studentAnswer: string }
  readAnswer2: { status: string; studentAnswer: string }
  answerCropImageUrl?: string
  answerBbox?: { x: number; y: number; w: number; h: number }
  arbiterResult?: ArbiterResult  // 三AI辯證裁決結果（新架構）
}

export interface PhaseAContext {
  answerKey?: AnswerKey
  questionIds?: string[]
  classifyResult?: unknown
  readAnswerResult?: unknown
  pipelineRunId?: string
  stagedLogLevel?: string
}

export interface PhaseAResult {
  phaseAComplete: true
  questionResults: PhaseAQuestionResult[]
  stableCount: number
  diffCount: number
  unstableCount: number
  needsReviewCount?: number  // 新架構：需人工審查的題數
  _phaseContext?: PhaseAContext
}

export interface FinalAnswer {
  questionId: string
  finalStudentAnswer: string
  finalAnswerSource: 'ai_read1' | 'ai_read2' | 'ai_arbiter' | 'manual' | 'unrecognizable'
}

// 🆕 AnswerKey 緩存引用（用於跨請求共享）
let cachedAnswerKeyHash: string | null = null
let cachedAnswerKeyJson: string | null = null

/**
 * 設置 AnswerKey 緩存（同一份作業的多次請求共享）
 */
export function setAnswerKeyCache(answerKey: AnswerKey | null): void {
  if (answerKey) {
    cachedAnswerKeyJson = JSON.stringify(normalizeAnswerKeyShortAnswerDimensions(answerKey))
    cachedAnswerKeyHash = null // 等待 proxy 返回 hash
  } else {
    cachedAnswerKeyJson = null
    cachedAnswerKeyHash = null
  }
}

/**
 * 清除 AnswerKey 緩存（作業切換時調用）
 */
export function clearAnswerKeyCache(): void {
  cachedAnswerKeyJson = null
  cachedAnswerKeyHash = null
  console.log('🧹 [AnswerKey] 已清除緩存')
}

function normalizeParts(parts: GeminiRequestPart[]): GeminiPart[] {
  return parts.map((part) => (typeof part === 'string' ? { text: part } : part))
}

/**
 * 比較兩個多段 ID 字串（如 "1-2-1" vs "1-2-10"）。
 * 逐段比較：純數字段用 natural sort，混字母段用字典序。
 * 用於 AnswerKey 題號清單排序，取代過去依 bbox 位置 + 佈局策略的排序。
 */
function compareNaturalIds(idA: unknown, idB: unknown): number {
  const segsA = String(idA ?? '').split('-')
  const segsB = String(idB ?? '').split('-')
  const len = Math.max(segsA.length, segsB.length)
  for (let i = 0; i < len; i++) {
    const sa = segsA[i] ?? ''
    const sb = segsB[i] ?? ''
    if (sa === sb) continue
    const aIsNum = /^\d+$/.test(sa)
    const bIsNum = /^\d+$/.test(sb)
    if (aIsNum && bIsNum) {
      const na = parseInt(sa, 10)
      const nb = parseInt(sb, 10)
      if (na !== nb) return na - nb
    }
    return sa.localeCompare(sb)
  }
  return 0
}

/**
 * 延遲函數（用於退避重試）
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 可恢復的錯誤類型
 */
class RecoverableError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly shouldRetry: boolean = true
  ) {
    super(message)
    this.name = 'RecoverableError'
  }
}

/**
 * 執行單次 Gemini API 請求
 * 
 * @param options.useAnswerKeyCache - 是否使用 AnswerKey 緩存機制
 */
async function executeGeminiRequest(
  modelName: string,
  parts: GeminiRequestPart[],
  inkSessionId: string | null,
  options?: { useAnswerKeyCache?: boolean; routeKey?: GeminiRouteKey; answerSheetMode?: 'with_questions' | 'answer_only' }
): Promise<{ text: string; data: any }> {
  const useAnswerKeyCache = options?.useAnswerKeyCache ?? false
  const routeKey = options?.routeKey || 'unknown'
  const answerSheetMode = options?.answerSheetMode
  const shouldForceFullAnswerKey = routeKey === 'grading.evaluate'
  
  // 🆕 AnswerKey 緩存邏輯
  let answerKeyPayload: { answerKey?: string; answerKeyRef?: string } = {}
  if (useAnswerKeyCache && cachedAnswerKeyJson) {
    if (shouldForceFullAnswerKey) {
      // 批改流程固定傳完整 AnswerKey，避免 ref miss 造成 422 額外往返
      answerKeyPayload = { answerKey: cachedAnswerKeyJson }
      console.log('📤 [AnswerKey] 批改固定完整模式 (' + Math.round(cachedAnswerKeyJson.length / 1024) + 'KB)')
    } else if (cachedAnswerKeyHash) {
      // 有 hash → 只傳引用
      answerKeyPayload = { answerKeyRef: cachedAnswerKeyHash }
      console.log('📎 [AnswerKey] 使用緩存引用:', cachedAnswerKeyHash.substring(0, 8) + '...')
    } else {
      // 沒有 hash → 傳完整 AnswerKey
      answerKeyPayload = { answerKey: cachedAnswerKeyJson }
      console.log('📤 [AnswerKey] 發送完整資料 (' + Math.round(cachedAnswerKeyJson.length / 1024) + 'KB)')
    }
  }

  const response = await fetch(geminiProxyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      model: modelName,
      contents: [{ role: 'user', parts: normalizeParts(parts) }],
      ...(inkSessionId ? { inkSessionId } : {}),
      routeKey,
      ...(answerSheetMode && answerSheetMode !== 'with_questions' ? { answerSheetMode } : {}),
      ...answerKeyPayload
    })
  })

  let data: any = null
  try {
    data = await response.json()
  } catch {
    data = {}
  }

  if (!response.ok) {
    // 🆕 422：AnswerKey 緩存未命中（可恢復）
    if (response.status === 422 && data?.code === 'ANSWER_KEY_CACHE_MISS') {
      console.warn('⚠️ 422 AnswerKey 緩存未命中，將重新發送完整 AnswerKey...')
      // 清除本地 hash，讓下次重試時發送完整 AnswerKey
      cachedAnswerKeyHash = null
      throw new RecoverableError(
        'AnswerKey 緩存已過期，正在重試...',
        422,
        true
      )
    }

    // 409：Session 失效（可恢復）
    if (response.status === 409) {
      throw new RecoverableError(
        data?.error || '批改會話已過期',
        409,
        true
      )
    }

    // 504：Gateway Timeout（可恢復）
    if (response.status === 504) {
      console.warn('⏱️ 504 Gateway Timeout，準備重試...')
      throw new RecoverableError(
        'AI 請求超時，正在重試...',
        504,
        true
      )
    }

    // 503：Service Unavailable（可恢復）
    if (response.status === 503) {
      console.warn('⚠️ 503 Service Unavailable，準備重試...')
      throw new RecoverableError(
        'AI 服務暫時不可用，正在重試...',
        503,
        true
      )
    }

    // 429：Rate Limited（可恢復）
    if (response.status === 429) {
      console.warn('⚠️ 429 Rate Limited，準備重試...')
      throw new RecoverableError(
        'API 請求過於頻繁，正在重試...',
        429,
        true
      )
    }

    // 413：檔案過大（不可恢復）
    if (response.status === 413) {
      throw new Error('檔案總大小過大，超過 AI 處理限制。建議分批上傳檔案。')
    }

    // 其他錯誤（不可恢復）
    const message =
      data?.error?.message ||
      data?.error ||
      `Gemini request failed (${response.status})`

    console.error('🚨 Gemini API 錯誤:', {
      status: response.status,
      model: modelName,
      timestamp: new Date().toISOString(),
      error: message
    })

    throw new Error(message)
  }

  // 🆕 緩存 proxy 返回的 answerKeyHash
  if (useAnswerKeyCache && data?.answerKeyHash && cachedAnswerKeyJson) {
    const newHash = data.answerKeyHash
    if (newHash !== cachedAnswerKeyHash) {
      cachedAnswerKeyHash = newHash
      console.log('📥 [AnswerKey] 已緩存 hash:', newHash.substring(0, 8) + '...')
    }
  }

  // 更新墨水餘額
  const updatedBalance = data?.ink?.balanceAfter
  if (typeof updatedBalance === 'number' && Number.isFinite(updatedBalance)) {
    dispatchInkBalance(updatedBalance)
  }

  const text = (data?.candidates ?? [])
    .flatMap((candidate: any) => candidate?.content?.parts ?? [])
    .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
    .join('')
    .trim()

  if (!text) {
    throw new Error('Gemini response empty')
  }

  return { text, data }
}

/**
 * 帶重試邏輯的 Gemini 文本生成
 * - 409 (Session 失效)：自動建立新 session 並重試
 * - 504/503/429/422：指數退避重試（最多 2 次）
 * 
 * @param options.useAnswerKeyCache - 是否使用 AnswerKey 緩存機制
 */
async function generateGeminiText(
  modelName: string,
  parts: GeminiRequestPart[],
  options?: { useAnswerKeyCache?: boolean; routeKey?: GeminiRouteKey; answerSheetMode?: 'with_questions' | 'answer_only' }
): Promise<string> {
  const MAX_RETRIES = 2
  let lastError: Error | null = null
  const useAnswerKeyCache = options?.useAnswerKeyCache ?? false
  const routeKey = options?.routeKey || 'unknown'
  const answerSheetMode = options?.answerSheetMode

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // 確保 session 有效（第一次嘗試時檢查，重試時可能已經重建）
      let inkSessionId = getInkSessionId()

      // 如果沒有 session，嘗試建立（但不強制，因為用戶可能在非批改流程）
      // ensureInkSessionFresh 會在批改流程中被呼叫

      const result = await executeGeminiRequest(modelName, parts, inkSessionId, {
        useAnswerKeyCache,
        routeKey,
        answerSheetMode
      })
      return result.text
      
    } catch (error) {
      lastError = error as Error
      
      if (error instanceof RecoverableError) {
        // 409：Session 失效 → 直接建立新 session 並立即重試
        // → 不在內層 close，讓「頁面離開」統一 close
        if (error.status === 409) {
          console.log(`🔄 [重試 ${attempt + 1}/${MAX_RETRIES + 1}] 409 Session 失效，直接重建 session...`)
          try {
            await startInkSession()
            continue // 立即重試，不需要等待
          } catch (sessionError) {
            console.error('❌ 建立新 session 失敗:', sessionError)
            throw new Error('批改會話已過期，請重新進入批改頁面')
          }
        }
        
        // 422：AnswerKey 緩存未命中 → 已清除本地 hash，立即重試
        if (error.status === 422) {
          console.log(`🔄 [重試 ${attempt + 1}/${MAX_RETRIES + 1}] 422 AnswerKey 緩存未命中，重新發送...`)
          continue // 立即重試
        }
        
        // 504/503/429：指數退避重試
        if (error.shouldRetry && attempt < MAX_RETRIES) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt), 8000) // 1s, 2s, 4s, max 8s
          console.log(`🔄 [重試 ${attempt + 1}/${MAX_RETRIES + 1}] ${error.status} 錯誤，等待 ${backoffMs}ms 後重試...`)
          await delay(backoffMs)
          continue
        }
        
        // 重試次數已用盡，拋出詳細錯誤
        if (error.status === 504) {
          throw new Error(
            `⏱️ AI 解析超時 (504 Gateway Timeout)\n\n` +
            `已重試 ${MAX_RETRIES} 次仍然失敗。\n\n` +
            `建議解決方式：\n` +
            `1. 稍等 1-2 分鐘後重試\n` +
            `2. 嘗試壓縮圖片後再上傳\n` +
            `3. 如果持續發生，請通知系統管理員`
          )
        }
        
        if (error.status === 503) {
          throw new Error(
            `⚠️ AI 服務暫時無法使用 (503)\n\n` +
            `已重試 ${MAX_RETRIES} 次仍然失敗。\n` +
            `請稍候 5-10 分鐘後重試。`
          )
        }
        
        if (error.status === 429) {
          throw new Error(
            `⚠️ API 請求過於頻繁 (429)\n\n` +
            `請稍候片刻後重試。`
          )
        }
      }
      
      // 不可恢復的錯誤，直接拋出
      throw error
    }
  }
  
  // 不應該到達這裡，但以防萬一
  throw lastError || new Error('Gemini request failed after retries')
}

// 預設使用的模型名稱
let currentModelName = 'gemini-3-flash-preview'

export interface ExtractAnswerKeyOptions {
  domain?: string
  /** 'answer_key'（預設）：從已填寫的解答圖擷取答案；'infer_blank'：從空白作業推論正確答案 */
  inferMode?: 'answer_key' | 'infer_blank'
  /** 108課綱概念清單（依班級年級篩出），用於 AI 標記每題的 concept_code */
  conceptMap?: { code: string; label: string }[]
  /** 這批圖片在整份答案卷中的起始頁碼（1-based）。用於分批上傳時保持頁碼連續，避免重複題號。 */
  startPage?: number
  /** 整份答案卷的總頁數（跨所有批次）。當 totalPages > 1 時啟用頁碼前綴。 */
  totalPages?: number
  /**
   * 文件類型，決定題目排序策略：
   * - 'worksheet'（預設）：習作／直向單欄，依 Y 排序，同列再依 X
   * - 'exam'：考卷／雙欄版面，左欄全部優先，右欄全部其次，各欄內依 Y 排序
   */
  docType?: 'worksheet' | 'exam'
  /**
   * 答案卷模式（決定 server 端 extract pipeline 走哪條分支）：
   * - 'with_questions'（預設）：題目跟答案在同一張紙
   * - 'answer_only'：純答題卡，搭配獨立題本
   */
  answerSheetMode?: 'with_questions' | 'answer_only'
}

export interface GradeSubmissionOptions {
  strict?: boolean
  domain?: string
  skipMissingRetry?: boolean
  /** @internal 內部使用：跳過分頁批改邏輯，避免遞迴 */
  _skipPagedGrading?: boolean
  /** @internal 內部使用：標記這是分頁批改中的部分圖片 */
  _isPartialImage?: boolean
  /** @internal 內部使用：預處理好的圖片資料（跳過壓縮和 base64 步驟） */
  _preparedImage?: {
    base64: string
    mimeType: string
  }
  regrade?: {
    questionIds: string[]
    previousDetails?: Array<{
      questionId?: string
      studentAnswer?: string
      score?: number
      maxScore?: number
      isCorrect?: boolean
      reason?: string
      confidence?: number
    }>
    forceUnrecognizableQuestionIds?: string[]
    mode?: 'correction' | 'missing'
  }
}

const gradingDomainHints: Record<string, string> = {
  國語: `
【最高優先規則：studentAnswer 嚴禁優化】
1. studentAnswer 一律逐字抄寫「圖片中看得到的學生筆跡」，不可摘要、不可改寫、不可修正錯字、不可補全。
2. 需要抓重點/摘要只能寫在 reason 或 mistakes/weaknesses/suggestions，絕對不能寫進 studentAnswer。

【國語作業特別警告：造詞題最容易腦補】
⚠️ 嚴重警告：造詞題空白時，絕不可依據讀音或部首腦補詞語！
- 題目：「ㄋㄨㄥˋ：□□」，學生空白 → 輸出「未作答」（❌ 不可腦補「弄瓦」「弄璋」）
- 題目：「光：□□」，學生空白 → 輸出「未作答」（❌ 不可腦補「光明」「光線」）
- 題目：「辨：□□」，學生空白 → 輸出「未作答」（❌ 不可腦補「辨別」「分辨」）
- 每題獨立判斷：第1格有寫 ≠ 第2格也該有寫，空白就是空白！

【國語作業閱讀方向 - 重要】
⚠️ 國語作業幾乎都是由右往左、由上往下閱讀（直排文字）
- 排序題：要按照「右→左、上→下」的順序判讀學生填寫的內容
- 多欄位題目：右邊的欄位是第一個，左邊的欄位是最後一個
- 例如：選項排列「甲 乙 丙 丁」在圖片中可能是「丁 丙 乙 甲」（從右到左）
- 不要用西式「左→右」的習慣來判讀國語作業

【評分提示（只影響 isCorrect/score/reason，不得影響 studentAnswer）】
1. 文意題：避免主觀推論，只在 reason 說明「缺哪些關鍵字/要點」。
2. 字音造詞題：檢查學生答案讀音是否符合題目要求（如：ㄋㄨㄥˋ 可答「弄瓦」，不可答「巷弄(ㄌㄨㄥˋ)」），讀音錯誤直接 0 分。

【方格框答案擷取】
1. 識別方格區域：確認學生填寫內容在方格框內
2. 擷取規則：
- 單方格 = 單字（□ → "弄"）
- 多方格 = 連續字詞（□□ → "弄瓦"）
- 空白方格 → "未作答"
3. 對齊檢查：確保方格數量與標準答案一致
4. ⚠️ 注意方格排列方向：可能是直排（由右往左、由上往下）

【國語答案擷取特別注意】
1. 相近字造詞題：學生可能寫錯字（如：嗇→普），原樣輸出不修正
2. 同音字造詞題：檢查讀音一致性，但不修正學生用字
3. 開放題/申論題：
- 學生答案可能簡短、不完整、有語病 → 原樣輸出
- 禁止擴寫、補充、修正、優化學生答案
- 即使答案明顯錯誤或不完整，也必須如實記錄「學生實際寫了什麼」
- ⚠️ 學生空白 → 記錄「未作答」，不可腦補內容

【多階段作答題處理】
⚠️ 識別特徵：題目分「步驟一/二」或「第一步/第二步」
- 第一階段（引導）：選擇、分析、構思（通常無對錯，完成即可）
- 第二階段（主要作答）：實際內容（有標準答案）

批改原則：
1. studentAnswer 要包含兩個階段的內容，清楚標示
   例如：「步驟一：動作、想法；步驟二：他揮舞著雙手，心想…」
2. 評分時使用 rubricsDimensions 分階段給分：
   - 第一階段：看「是否完成」不看「是否正確」，有做選擇就給分
   - 第二階段：依據 criteria 判斷內容品質並給分
3. 整題的 isCorrect：以第二階段為準，不因第一階段未完成而判錯
`.trim(),

  數學: `
【數學作業特別警告：計算題最容易腦補】
⚠️ 嚴重警告：計算題空白時，絕不可依據算式或常識腦補答案！
- 題目：「2+3=______」，學生空白 → 輸出「未作答」（❌ 不可腦補「5」）
- 題目：「5×7=______」，學生空白 → 輸出「未作答」（❌ 不可腦補「35」）
- 題目：「周長=______」，學生空白 → 輸出「未作答」（❌ 不可腦補公式或數值）
- 每題獨立判斷：第1題有寫 ≠ 第2題也該有寫，空白就是空白！

【繪圖題型處理】
典型題型：在座標平面上畫點/線/圖形、畫幾何圖形、標註角度等

評分原則（使用 rubricsDimensions）：
- 圖形正確性：形狀、線條是否正確
- 位置精準度：座標位置、角度、比例是否正確
- 標註完整性：必要標註（如角度、長度）是否完整
⚠️ 圖形對 ≠ 答案對，位置和標註也必須正確

【數學答案擷取要點】
計算題保留最終數值與必要單位；需公式時留核心公式。
幾何/代數題可列主要結論，避免冗長過程。
`.trim(),

  社會: `
【社會作業最高警戒：絕對禁止腦補空白】
🚨 最高優先級規則：社會科最容易腦補，必須嚴格檢查！

⚠️ 重要觀念：「輸出記錄」≠「生成答案」！
- ✅ 正確理解：學生空白 → 輸出 studentAnswer: "未作答"（這是輸出記錄）
- ❌ 錯誤理解：學生空白 → 輸出 studentAnswer: "台北"（這是腦補答案）
- 每題都要有記錄，但空白題的記錄內容是「未作答」，不是腦補的答案！

核心原則：
- 圖片上看不到筆跡 = 未作答，不可有任何例外！
- 即使題目「超級簡單」「人人都知道」也絕不可腦補
- 每次輸出前必須自問：「我在圖片上真的看到這些字了嗎？」

🚨 絕對禁止腦補的例子：

填空題：
- 題目：「台灣的首都是______」，學生空白 → 輸出「未作答」（❌ 即使人人都知道是台北，也不可腦補）
- 題目：「第一次世界大戰發生於______年」，學生空白 → 輸出「未作答」（❌ 即使答案是 1914，也不可腦補）
- 題目：「______是台灣最高峰」，學生空白 → 輸出「未作答」（❌ 即使答案是玉山，也不可腦補）
- 題目：「中華民國的國旗是______」，學生空白 → 輸出「未作答」（❌ 不可腦補「青天白日滿地紅」）
- 題目：「台灣四面環______」，學生空白 → 輸出「未作答」（❌ 不可腦補「海」）

勾選題（最容易腦補！）：
🚨 關鍵：只看「方框□內」是否有標記，不要被箭頭等符號誤導！

- 題目：「台灣位於哪一洲？ □亞洲 ↑  □歐洲 ↖  □非洲 →  □美洲 ↓」，四個方框內都空白
  → 輸出「未作答」（❌ 即使人人都知道是亞洲，也不可腦補「亞洲」）
  → ❌ 箭頭（↑ ↖ → ↓）是題目的一部分，不是學生的作答標記！

- 題目：「首都在台北的國家是？ □日本 □中華民國 □韓國」，三個方框內都空白
  → 輸出「未作答」（❌ 不可腦補「中華民國」）
  → ❌ 選項文字（日本、中華民國、韓國）是題目的一部分，不是學生的作答！

⚠️ 判斷標準：
- ✅ 方框□內有打勾 ✓、圈選 ○、劃記 × = 有作答
- ✅ 方框□內完全空白 = 未作答
- ❌ 看到箭頭或選項文字就以為有作答 → 這些都是題目的一部分！
- 只關注「方框內部」是否有學生的筆跡標記

繪圖題（最容易腦補！）：
- 題目：「在地圖上標註台北的位置」，地圖上沒有任何手繪標記
  → 輸出「未作答」（❌ 即使知道台北在哪，也不可腦補「已標註在北部」）
- 題目：「在經緯度圖上標註颱風位置」，圖上沒有任何符號或標記
  → 輸出「未作答」（❌ 不可腦補「已標註颱風符號」）
- ⚠️ 判斷標準：圖上有手繪痕跡 = 有作答；圖上完全沒有手繪痕跡 = 未作答
- ⚠️ 圖片本身的印刷內容（地圖、座標軸）不算學生作答，只有手繪標記才算！

⚠️ 驗證方法：如果你無法在圖片中用手指指出學生寫的每一個字/每一個標記/每一個符號，那就是腦補！
⚠️ 每題獨立判斷：第1題有寫 ≠ 第2題也該有寫，空白就是空白！

【繪圖/繪標記題型處理】
⚠️ 這類題型必須多維度評分，符號對 ≠ 答案對！

典型題型：
- 在地圖上標註位置（如：經緯度交匯處標註颱風符號）
- 在四象限圖中標記座標點
- 在時間軸上標註事件位置
- 在方位圖上畫出指定符號

評分原則（使用 rubricsDimensions）：
1. 符號正確性維度：
   - 檢查學生畫的符號是否正確（如：颱風符號 🌀、星號 ★、圓圈 ○）
   - studentAnswer 描述：「符號：颱風符號」

2. 位置精準度維度（最重要！）：
   🚨 經緯度題目必須精準判斷，不可用「大概」「象限」！

   正確判斷步驟：
   a. 先檢查 AnswerKey 中的 criteria，確認是精準座標還是範圍要求
   b. 讀取圖上的經緯度刻度線（如：120°E、121°E、122°E...）
   c. 判斷學生標記的位置在哪兩條經線之間、哪兩條緯線之間
   d. 依據 criteria 檢查：
      - 如果 criteria 要求精準座標（如：「必須在東經 151.4°E、北緯 15°N 附近（±1°以內）」）
        → 判斷學生標記是否在 150.4°E-152.4°E、14°N-16°N 範圍內
      - 如果 criteria 是範圍要求（如：「121°E 以東、23.5°N 以南」）
        → 判斷學生標記是否在此範圍內
   e. studentAnswer 必須描述精準位置：
      - 精準座標型：「位置：約 151°E、15.5°N（在 151.4°E±1°、15°N±1° 範圍內 ✓）」
      - 範圍型：「位置：約 122°E、23°N（121°E 以東 ✓、23.5°N 以南 ✓）」

   ❌ 絕對禁止的模糊判斷：
   - ❌「大致在第四象限」→ 不夠精準，必須讀取刻度
   - ❌「方向正確」→ 不夠精準，必須檢查經緯度
   - ❌「相對位置正確」→ 不夠精準，必須對照刻度線
   - ❌「約在右下角」→ 不夠精準，必須讀取經緯度數值

   ✅ 正確判斷範例：
   精準座標型：
   - ✅「位置在 151°E 附近、15°N 附近，符合『151.4°E±1°、15°N±1°』要求」→ 位置正確
   - ❌「位置在 122°E、23°N，不符合『151.4°E±1°、15°N±1°』要求」→ 位置錯誤

   範圍型：
   - ✅「位置在 122°E、23°N，符合『121°E 以東、23.5°N 以南』要求」→ 位置正確
   - ❌「位置在 120°E、23°N，不符合『121°E 以東』要求」→ 位置錯誤

3. 整體判斷：
   - 符號對 + 位置精準符合要求 → 滿分
   - 符號對 + 位置不符合精準要求 → 0 分或低分（依 criteria 而定）
   - 符號錯 + 位置對 → 部分分或 0 分（依 criteria 而定）
   - 符號錯 + 位置錯 → 0 分

🚨 常見錯誤（絕對禁止）
- ❌ 只看符號對就給滿分，忽略位置精準度
- ❌ 位置只看「大致在那個象限」就判對 → 必須讀取經緯度刻度
- ❌ 用「方向」「相對位置」判斷 → 必須用經緯度數值判斷
- ❌ criteria 要求精準座標（151.4°E, 15°N），卻用寬鬆範圍判斷（121°E 以東）→ 必須依照 criteria 精準判斷
- ✅ 必須先檢查 criteria，再依照 criteria 的精準度要求判斷位置

【社會答案擷取要點】
名詞、年代、地點、人物要精確；時間題保留年份或朝代。
請專注於同音異字的錯誤，特別是地名。用字錯誤視為錯誤。例如：九州和九洲。
`.trim(),

  自然: `
【自然作業特別警告：概念題最容易腦補】
⚠️ 嚴重警告：概念題空白時，絕不可依據科學知識腦補答案！
- 題目：「光合作用的場所是______」，學生空白 → 輸出「未作答」（❌ 不可腦補「葉綠體」）
- 題目：「水的化學式是______」，學生空白 → 輸出「未作答」（❌ 不可腦補「H₂O」）
- 題目：「植物行光合作用需要______和______」，學生空白 → 輸出「未作答」（❌ 不可腦補「陽光」「水」）
- 每題獨立判斷：第1題有寫 ≠ 第2題也該有寫，空白就是空白！

【繪圖/標註題型處理】
典型題型：繪製實驗裝置圖、標註器官/部位名稱、畫食物鏈/食物網等

評分原則（使用 rubricsDimensions）：
- 圖形正確性：圖形/結構是否正確
- 標註正確性：標註的名稱/位置是否正確
- 完整性：必要元素（如箭頭方向、連結關係）是否完整
⚠️ 圖畫對 ≠ 答案對，標註和關係也必須正確

【自然答案擷取要點】
保留關鍵名詞、數值、實驗結論；單位必須保留，化學式/符號需完整。
`.trim(),

  英語: `
【英語作業特別警告：填空題最容易腦補】
⚠️ 嚴重警告：填空題空白時，絕不可依據文法或常識腦補單字！
- 題目：「I ____ a student.」，學生空白 → 輸出「未作答」（❌ 不可腦補「am」）
- 題目：「apple: ______（中文）」，學生空白 → 輸出「未作答」（❌ 不可腦補「蘋果」）
- 題目：「The cat is ____ the table.」，學生空白 → 輸出「未作答」（❌ 不可腦補「on」「under」）
- 每題獨立判斷：第1題有寫 ≠ 第2題也該有寫，空白就是空白！

【英語答案擷取要點】
拼字需精確；大小寫與標點依題幹要求；完形/選擇用正確選項或必要單字短語。
`.trim()
}

function buildGradingDomainSection(domain?: string) {
  const hint = domain ? gradingDomainHints[domain] : ''
  return hint ? hint.trim() : ''
}

async function getRecentAnswerExtractionCorrections(
  domain?: string,
  limit = 5
): Promise<AnswerExtractionCorrection[]> {
  try {
    let collection = db.answerExtractionCorrections.orderBy('createdAt').reverse()
    if (domain) {
      collection = collection.filter((item: AnswerExtractionCorrection) => item.domain === domain)
    }
    return await collection.limit(limit).toArray()
  } catch (err) {
    console.warn('無法讀取擷取錯誤紀錄', err)
    return []
  }
}

/*
===========================================
舊版 buildAnswerKeyPrompt (2025-12-28 前)
備份原因：決策樹重構，保留舊版以便回滾
===========================================
此備份已移至: src/lib/gemini.ts.backup-20251228
===========================================
*/

/**
 * 建立全域規則（適用於所有領域）
 */
// Part 1：task 指令 + JSON schema + 通用原則 + 顏色辨識
// 永遠排在 prompt 最前面
function buildGlobalTaskAndFormat(): string {
  return `
從標準答案圖片提取可機器批改的答案表。回傳純 JSON（無 Markdown）：

{
  "_layoutDetected": [                    // ⚠️ 必填，且必須在 questions 之前生成。
                                          //   陣列長度 = 本次上傳的照片張數（每張一個元素）。
                                          //   每張照片標出該張的版面類型，值為以下之一：
                                          //     "single-page-single-column" 單頁直向單欄（一般習作）
                                          //     "single-page-two-column"    單頁雙欄（如考卷左右兩欄）
                                          //     "two-page-spread"           跨頁展開（一張照片含左右兩個物理頁面）
                                          //     "other:<簡短描述>"          其他情況請簡述
    { "photo": 1, "layout": "single-page-single-column" },
    { "photo": 2, "layout": "two-page-spread" }
  ],
  "questions": [{
    "id": "1",                              // 題號（必填）
    "idPath": ["1"],                        // 題號階層陣列
    "questionCategory": "fill_blank",        // 25 種 type 之一（必填，見 Decision Tree + Type Specs）
    "bucket": "A",                           // A/B/C/D，可省略（系統自動推導）
    "orderMode": "strict",                   // strict | unordered
    "unorderedGroupId": "1",                 // orderMode=unordered 時必填（同組共用）
    "maxScore": 5,                           // 滿分
    "anchorHint": "比率列中有印刷括號（　）/180的空格，位於欄標題「三國演義」正下方",
    "tablePosition": {"col": 4, "row": 3, "totalCols": 8, "totalRows": 3},

    // ─── 答案欄位（依 bucket 不同）───
    // bucket="A"：精確比對，必填 answer（格式見 Type Specs 各 type）
    "answer": "...",

    // bucket="B"：容多元，必填 referenceAnswer + acceptableAnswers
    "referenceAnswer": "範例答案",
    "acceptableAnswers": ["同義詞1", "同義詞2"],

    // bucket="C"：Rubric，必填 referenceAnswer + rubricsDimensions
    // bucket="D"：複合題，依 type 同時填 answer 部分 + rubricsDimensions 部分
    "rubricsDimensions": [
      {"name": "列式計算", "maxScore": 3, "criteria": "算式正確、步驟清晰"},
      {"name": "答句", "maxScore": 2, "criteria": "以「答：」或「A：」開頭，含數字與單位"}
    ],

    // ⚠️【rubricsDimensions criteria 黃金規則】（C/D bucket 必讀）
    // criteria 必須從【題幹要求】推導，描述「何種答案符合」。
    // 禁止把參考答案的具體名詞直接寫進 criteria（綁死答案）。
    // ✅ "能從圖片中辨識出一種現代較少使用的生活器具"
    // ❌ "能正確指出「灶」被取代"
    // 參考答案（referenceAnswer）只是品質示範，不代表唯一正確答案。

    // 舊資料相容（不建議新題使用，short_answer 不可用）
    "rubric": {"levels": [{"label": "優秀", "min": 9, "max": 10, "criteria": "..."}]},
  }],
  "totalScore": 50
}

【通用原則】
- 題號：只為「有答案/作答區」的題目建立題號，必須輸出 idPath，並讓 id = idPath 用 "-" 串接
- 題號：圖片有就用，無則依題目順序補上（不可跳號）
- 🚨 **questions 陣列必須按閱讀順序輸出**（系統依 ID 排序顯示，不再用 bbox 位置）：
  - 直向單欄：上→下
  - 雙欄考卷：左欄全部 → 右欄全部
  - 雙頁展開（橫向照片）：左頁全部 → 右頁全部
  - 多照片合成：第 1 張全部 → 第 2 張全部
  - 子題（如 "1-1", "1-2"）：依子題編號自然遞增
  - ⚠️ 即使印刷題號跳號或亂序，**AI 輸出的 id 必須單調遞增**，不可逆序
- orderMode（三種情況）：
  ┌──────────────────┬─────────────────────────────────────────────────────────────────────────┐
  │ 情況              │ 說明                                                                    │
  ├──────────────────┼─────────────────────────────────────────────────────────────────────────┤
  │ 非同組（預設）    │ 各題獨立，每格只對應自己的答案 → orderMode: "strict"，不設 unorderedGroupId│
  │ 同組但不可換      │ 同一大題的多個空格，但每格有固定正確答案（如地圖各方向、時序填空）       │
  │                  │ → orderMode: "strict"，不設 unorderedGroupId（同非同組，只是概念上同組）  │
  │ 同組可換          │ 題目明確說明「任意順序填入」或「不限順序」，答案可放進任何格              │
  │                  │ → orderMode: "unordered"，所有子題共用同一 unorderedGroupId              │
  └──────────────────┴─────────────────────────────────────────────────────────────────────────┘
  - ⚠️ 「同組但不可換」= orderMode: "strict"（與非同組相同）。即使多格在同一大題，只要每格有固定答案就用 strict。
  - ⚠️ 以下情況一律用 "strict"，禁止用 "unordered"：
    - 地圖上不同位置的空格（每格對應特定地理方向/箭頭）
    - 時序/流程空格（第一步、第二步…）
    - 圖表各欄位（每欄對應不同項目）
    - 多個注音空格（每格填不同的注音符號）
  - ✅ 只有「題目明文說明答案可任意填入/不限順序」才用 "unordered"，例如：
    - 題目說：「任選 3 個填入空格（順序不限）」
    - 題目說：「將下列詞語依任意順序填入」
  - 同一可互換組的所有子題，必須設定相同 unorderedGroupId（通常用主題號，如 "1"）
  - ⚠️ **設 orderMode="unordered" 時必須同時設 orderModeUncertain: true**
    （AI 的群組判斷不一定 100% 正確，這個 flag 提醒老師到前端複核此題群組是否設對。
     老師確認後可手動清除，前端題號清單會用黃色提醒。strict 不需設此 flag。）
- 配分：圖片有就用，無則估計（是非/選擇 2-5 分，簡答 5-8 分，申論 8-15 分）。⚠️ AI 估計的配分必須為整數（禁止小數）。
- rubricsDimensions 配分規則：每個 dimension 的 maxScore 必須為整數，且所有 dimension 的 maxScore 總和必須等於該題的 maxScore。將 maxScore 盡量均分到各 dimension；若無法整除，將餘數分配給第一個 dimension。例如：maxScore=4, 2 個 dimension → 各 2 分；maxScore=5, 2 個 dimension → 3 分 + 2 分。
- totalScore = 所有 maxScore 總和
- answerBbox：**不需要輸出**。bbox 由獨立的 ANSWER_KEY_LOCATE 階段負責標記，本階段請專注在題目辨識、答案抽取、題型分類、配分。
- anchorHint：每題必填（除 word_problem / calculation / map_symbol / grid_geometry / connect_dots / diagram_draw / diagram_color 外）。用 1-2 句中文描述此答案格附近最能唯一識別其位置的印刷特徵：
  - fill_blank 單格：描述緊鄰的題幹關鍵字或括號前後的文字，例如「括號前為「一定能，可能」，括號後接「大於1」」
  - fill_blank 多格（multi_fill / 表格子題）：優先描述格子本身的視覺外觀（印刷格式、括號樣式、預留空白），再以欄標題或列標題作為輔助定位。例如：「比率列中有印刷括號（　）/180的空格，位於欄標題「三國演義」正下方」「票數列中對應「金銀島」欄的空白數字格」。禁止只寫欄標題文字（如「欄標題為「三國演義」的格子」），因為欄標題本身不是答案格。
  - single_choice / single_check：描述題幹第一句關鍵字，例如「題幹開頭為「擲出來的點數和可能大於1嗎」」
  - 目標：描述應具體到能唯一定位該格，避免使用位置詞（「左邊第三格」→ 改用欄標題）
- tablePosition（表格內的答案格專用，補充欄位）：
  ⚠️ 優先順序：顏色規則 > tablePosition。必須先通過顏色判斷（**答案色**內容 = 答案；印刷主色內容不是答案），確認該格是答案格後，才補上 tablePosition。印刷主色的已知值（如表格中已填好的數字、印刷的範例值）不是答案格，不建題，也不輸出 tablePosition。
  - 僅當答案格位於表格（有可見的格線/欄列結構）中時才輸出

  【格線計數法】（answer_key.extract 和 classify 共用規則，必須完全一致）
  步驟：
  1. 找到表格的外框邊界（最外圍的格線）
  2. 數垂直格線（含左右外框）：從左到右依序編號 V1, V2, V3, ..., V(N+1)。N+1 條垂直線 = N 欄
  3. 數水平格線（含上下外框）：從上到下依序編號 H1, H2, H3, ..., H(M+1)。M+1 條水平線 = M 列
  4. 第 C 欄 = V(C) 與 V(C+1) 之間的空間。第 R 列 = H(R) 與 H(R+1) 之間的空間
  5. totalCols = 垂直格線數 - 1。totalRows = 水平格線數 - 1
  6. 目標格的位置 = 左邊界 V(col), 上邊界 H(row), 寬 = V(col+1) - V(col), 高 = H(row+1) - H(row)

  ⚠️ 自我驗證：數完後，讀取第 1 列各欄的標題文字，列出 col1=「X」, col2=「Y」, ... 的對應表，確認欄數與 totalCols 一致，且每個答案格的 col 對應到正確的欄標題。若不符，重新計數。

  欄位定義：
  - col: 欄位序號（1-based），依格線計數法
  - row: 列序號（1-based），依格線計數法
  - totalCols: 垂直格線數 - 1
  - totalRows: 水平格線數 - 1
  - colspan: 若此格橫跨多欄，填實際跨欄數（預設 1，可省略）
  - rowspan: 若此格縱跨多列，填實際跨列數（預設 1，可省略）
  - 同一表格的所有子題必須共用相同的 totalCols / totalRows
  - 非表格題不需輸出 tablePosition
- 無法辨識時回傳 {"questions": [], "totalScore": 0}

【題號層級（idPath）】
- idPath 是題號階層陣列，例如 ["8","1"] -> id "8-1"
- 層級數 = 題目階層數；只有一層就 ["1"]，兩層就 ["1","1"]
- 只允許「數字或英文字母」；保留英文字母大小寫
- 小寫 a/b/c 就保留小寫；大寫 A/B/C 就保留大寫
- (1)(2) => 1/2；(一)(二) => 1/2
- 中文數字（壹、貳、一、二…）轉成阿拉伯數字
- 移除符號/括號/頓號/句點，不保留符號
- 題號若為 1a/A1 這類組合，保持原樣，不拆分

範例：
- 「八、… 1. …」→ idPath: ["8","1"] → id: "8-1"
- 「A. … a. …」→ idPath: ["A","a"] → id: "A-a"

【顏色辨識規則】（適用於所有領域）

🚨 第一步：先決定「印刷主色」與「答案色」

- **印刷主色** = 整張答案卷上文字數量最多的顏色（通常是黑色，但可能是深棕、深綠、靛藍等）
  - 包含：題目敘述、印刷選項、表格欄位標題、頁碼、範例示範、出版社裝飾、卡通角色對話框
  - **印刷主色內容一律不是答案**
- **答案色** = 老師（或出版社）用來寫標準答案的顏色，**必定與印刷主色明顯不同**
  - 通常是紅色（最常見），但也可能是藍色、綠色、紫色，視老師習慣而定
  - 識別判準：在空白格／括號／底線位置，用與印刷主色明顯不同的顏色寫的內容
  - 「明顯不同」= 即使影印或拍照失真也分得出，不是同色濃淡差異

⚠️ 不要假設「答案色 = 紅色」。要先看這張答案卷的印刷主色是什麼，再找與它對比的顏色。

🚨 第二步：嚴格區分「答案」與「範例」

範例（example/示範/示例）= 印刷在卷面上、用來告訴學生「正確答案長這樣」的示範內容。
範例**絕對不是答案**，不可建題、不可建子題。

範例的識別線索（任一即可判定為範例）：
- 顏色是**印刷主色**（不是答案色）— 老師寫的答案才會用答案色
- 旁邊或上方有「例：」「範例：」「示例」「(例)」「(示範)」字樣
- 被印刷的方框／圓框／卡通對話框／角色插圖包圍
- 出現在第 1 題之前的引導區（如「下面是老師示範的寫法...」）
- 出版社在題目旁邊預印的「正確答案範例」帶有裝飾元素（小圖示、星星、勾號等）

⚠️ **印刷主色 + 文字內容看起來像答案 ≠ 答案**。看到任何「印刷的、看起來填好了的內容」，
   先問「這格有沒有預印的範例標記？」確認後再決定建不建題。

範例情境對照：

| 情境 | 顏色 | 是答案嗎？ | 處理方式 |
|---|---|---|---|
| 空格內紅字（與印刷主色不同色） | 答案色 | ✅ 是 | 建題、提取為 answer |
| 空格內黑字（與印刷主色相同） | 印刷主色 | ❌ 不是 | **不建題**（這是印刷示範或題幹的一部分） |
| 「例：太陽」黑字 | 印刷主色 | ❌ 不是 | **不建題**（印刷範例） |
| 對話框內「角色① 巡視走私的官員」 | 印刷主色 | ❌ 不是 | **不建題**（裝飾範例） |
| 第 1 題之前「示範：…」整段 | 印刷主色 | ❌ 不是 | **不建題**（引導示範） |
| 表格某格只有印刷的數字無紅字 | 印刷主色 | ❌ 不是 | **不建題**（已知值，非答題格） |

🚨 第三步：判斷流程（嚴格按此順序）

1. 找出整張卷面的印刷主色（看哪個顏色的文字最多）
2. 找出與印刷主色明顯不同的顏色 = 答案色（記住是哪個顏色）
3. 對每個候選答題位置：
   a. 該位置是不是答案色寫的？是 → 進到 b；否 → **跳過，不建題**
   b. 該位置周圍有無範例標記（「例：」「(範例)」「示範」等）？有 → **跳過，不建題**；無 → 進到 c
   c. 提取該答案色內容為 answer
4. 如果整張卷找不到明顯的答案色（例如老師沒寫答案），才退回參考題目要求推測答案

⚠️ 寧可漏建題（讓老師手動補），也不要把範例當答案建題（會誤導後續批改）

【括號與作答區的關係】
- 括號 ( ) 是強信號：出現括號**且**括號內有「答案色」內容 → 答題區
- 括號內是印刷主色（黑字）→ **不是答題區**（可能是括號內預印選項或範例值）
- 沒有括號但有「答案色」內容 → 仍可建題

【直式分數格規則】（適用於 fill_blank）
- 若答案區為直式分數格（上格 + 橫線 + 下格），依顏色判斷作答區：
  - 只有上格是答案色 → answer = 上格值
  - 只有下格是答案色 → answer = 下格值
  - 上下格都是答案色 → answer = "上格/下格"（如 "3/4"）
  - 印刷主色的格子是印刷結構，不屬於答案，不可含入 answer 欄位

⚠️ 詳細題型分類見下方 Decision Tree + Type Specs（共 25 種 type，分 4 個 bucket）。
按「學生作答方式」分類，每個 type 有獨立的視覺特徵與 answer 格式。
`.trim()
}

// Part 2：大類別決策樹（4 個 bucket → 25 個 type）
// 給 AI 走的階層判斷流程
function buildDecisionTree(): string {
  return `
【大類別決策樹】
依「學生作答方式」逐層判斷 type。3 層內走到 leaf。

═══════════════════════════════════════════════════
Q1：怎麼判分？  [4 選 1]
─ A. 標準答案 + 精確比對（學生答案要與正解完全相同）
─ B. 標準答案 + 容多元（同義詞、近義詞、多種說法都算對）
─ C. Rubric 給分（依品質給分，無單一正解）
─ D. 複合題（精確比對 + Rubric 並存於同一題）

═══════════════════════════════════════════════════
─── 進入 Bucket A：精確比對 ───
Q2-A：學生主要動作是什麼？  [8 選 1]

➊ 寫代號（在空括號內寫 A/甲/①等）
   ├─ 寫一個 → single_choice
   └─ 寫多個 → multi_choice

➋ 圈印刷選項（括號內預印選項，學生用圈/底線/劃掉標記）
   ├─ 圈一個 → circle_select_one
   └─ 圈多個 → circle_select_many

➌ 在 □ 打勾
   ├─ 勾一個 → single_check
   └─ 勾多個 → multi_check

➍ 寫 ○ 或 ✗ 符號（單一括號內手寫對錯符號）→ true_false

➎ 填寫值（____ ／ □ ／ 表格儲存格 內填值）
   ⚠️ 先做 work area 檢查：題目下方/旁邊有沒有預留空白讓學生**寫算式或計算過程**？
      • 沒 work area / 學生只填了單一值 → 繼續走「純填值」分支
      • 有 work area + 學生實際寫了算式步驟 → 走「填值+算式」分支

   ─ 純填值（無算式步驟）：
   ├─ 一個值 → fill_blank
   └─ 多個值（順序無關）→ multi_fill

   ─ 填值 + 算式步驟（數學題型）：
   ├─ 無「答：」答句行 → calculation（只看最終值，純數值正解）
   └─ 有「答：」答句行 → word_problem（只看最終答案，含單位）

➏ 連線（左右欄之間畫連線）→ matching

➐ 寫序號排序（在格子內填 1/2/3...指定順序）→ ordering

➑ 在文章中圈詞（沒有預先列出的選項，學生在連續文字中圈出特定詞語）→ mark_in_text

═══════════════════════════════════════════════════
─── 進入 Bucket B：容多元 ───
Q2-B：哪一種多元？  [2 選 1]

➊ 單一空格容多種說法（同義詞、近義詞、造詞）→ fill_variants
➋ 多位置-名稱配對（地圖填地名/國名）→ map_fill

═══════════════════════════════════════════════════
─── 進入 Bucket C：Rubric 給分 ───
Q2-C：評鑑標的是文字還是繪圖？  [2 選 1]

➊ 文字
   └─ 自由說明（解釋、舉例、論述）→ short_answer
   ⚠️ calculation / word_problem 已搬到 Bucket A「填值+算式」分支（只看最終答案，過程交 Accessor）

➋ 繪圖
   ├─ 在地圖某位置畫符號（▲/★/●）→ map_symbol
   ├─ 在格線紙上畫幾何圖形（三角形/平行四邊形）→ grid_geometry
   ├─ 把指定點連起來形成圖形 → connect_dots
   ├─ 繪製長條圖/圓餅圖 → diagram_draw
   └─ 在預印圖形上塗色 → diagram_color

═══════════════════════════════════════════════════
─── 進入 Bucket D：複合題（多部分**有依存關係**，必須一起評分）───
Q2-D：哪一種組合？  [7 選 1]

⚠️ Bucket D 與 Bucket C 的關鍵差別：
- Bucket C：rubric 維度**獨立**（如 calculation 算式 + 答案，可分開評）
- Bucket D：部分之間**有依存**（一部分對錯取決於另一部分）

➊ 圈印刷選項 + 寫理由說明 → compound_circle_with_explain
   例：「我認為（同意／不同意），因為...」（理由 must match 圈選）
➋ 在 □ 打勾 + 寫理由 → compound_check_with_explain
➌ 寫代號 + 寫理由 → compound_writein_with_explain
➍ 勾選多個 + 開放「其他：___」欄位 → multi_check_other
➎ 對的打 ○ / 錯的打 ✗ + 改正錯的內容 → compound_judge_with_correction
   例：「以下敘述對的打○、錯的打✗，錯的請改正」（改正錯誤部分）
➏ 寫對/不對 + 解釋為什麼 → compound_judge_with_explain
   例：「他們花的錢一樣多，對不對？(不對) 為什麼？(因為...)」（理由說明判斷）
➐ 表格多 cell，cell 之間 chain 連動 → compound_chain_table
   例：「人物 / 具體事件 / 影響」表格（事件取決於人物，影響取決於事件）

⚠️ ➎ vs ➏ 怎麼分？
- ➎ judge_with_correction：錯的部分要學生「改寫成正確版本」（改字）
- ➏ judge_with_explain：判斷後寫「為什麼」「理由」（解釋因果）

═══════════════════════════════════════════════════
⚠️ 識別優先順序：
1. 先決定印刷主色與答案色 → 找答案色內容（**先看顏色規則**）
2. 確認該位置不是範例（無「例：」「示範」標記、不被裝飾框包圍）
3. 看答題區的視覺結構 → 括號／方框／底線／工作區
4. 看學生實際動作 → 依決策樹判斷
5. 套用該 type 的 answer 格式（見 Type Specs）
`.trim()
}

// Part 3：每個 type 的精確定義
// 25 種 type，每個自帶視覺特徵 + answer 格式
function buildTypeSpecs(): string {
  return `
【Type Specs — 25 種題型完整定義】

每個 type 包含：視覺特徵 / 學生動作 / answer 欄位格式 / 範例。
（answerBbox 由 ANSWER_KEY_LOCATE 階段標記，不在本階段輸出）

═══════════════ Bucket A：精確比對 ═══════════════

▸ single_choice 「選擇題」
  視覺：題號前空括號 (   )；括號外另有 A/B/C/D 等選項清單
  動作：學生在空括號內寫一個代號
  answer：單一代號 — "A" / "甲" / "①" / "1"

▸ multi_choice 「多選選擇題」
  視覺：題號前空括號；題目說「可複選」「選出所有正確的」
  動作：學生在空括號內寫多個代號（逗號分隔）
  answer：多代號用 "," 連接 — "A,C" / "①,③"

▸ circle_select_one 「圈選題」
  視覺：括號內預印多個選項，以 ／ 或 ， 分隔（如 (同意／不同意)、(大於／等於／小於)）
  動作：學生用圈/底線/劃掉等筆跡標記其中一個選項
  answer：被標記選項的文字 — "同意" / "等於"（純文字，不含括號或分隔符）

▸ circle_select_many 「多選圈選題」
  視覺：同 circle_select_one，但學生標記多個選項
  動作：圈/標記多個預印選項
  answer：多選項用 "," 連接 — "同意,大於"

▸ single_check 「勾選題」
  視覺：一列方框 □ + 各對應選項文字（如 □父親 □母親 □祖父）
  動作：學生在一個 □ 內打勾/打叉/塗黑
  answer：1-based 位置編號 — "1" / "2" / "3"...（純數字，不含 □、勾號、選項文字）

▸ multi_check 「多選勾選題」
  視覺：一列方框 □ + 選項；題目說「請勾出所有」
  動作：學生在多個 □ 內打勾
  answer：多位置編號用 "," 連接 — "1,3"

▸ true_false 「是非題」
  視覺：單一括號 (   ) 接在敘述句後
  動作：學生在括號內手寫 ○ / ✗ / 對 / 錯 / 是 / 否
  answer：統一 "○" 或 "✗"

▸ fill_blank 「填空題」
  視覺：____ ／ □ ／ 表格儲存格 + 紅色手寫文字
  動作：學生在空格內填寫一個值（含單位）
  answer：完整正解含單位 — "15 公分" / "彰" / "ㄓㄤ"
  ⚠️ 直式分數格特例：上下格紅色 → "上格/下格"（如 "3/4"）；只有上格紅 → "上格值"
  ⚠️ 一題多空格：同一印刷題目內出現 N 個 □ 或 N 個 _____（每個位置答案不同），
     **拆成 N 個獨立子題**，每子題各自一個 fill_blank、各自一個 answer，按 □ /
     _____ 在版面上的閱讀順序給 idPath（如 ["4","1"], ["4","2"]）。
     範例：題目「2⅕×4.73 − 2.73×2⅕ = 2⅕ □ (4.73 □ 2.73)」第一個 □ 填 "×"、第二個
     填 "−" → 拆成兩題，id=4-1 answer="×"、id=4-2 answer="−"。
     ⚠️ 與 multi_fill 區別：multi_fill 是「填代號集合，順序無關」（每子題的 answer
     是同一個答案池任選一個）；fill_blank 多空格是「每位置有自己的固定答案」，
     順序與位置綁定。

▸ multi_fill 「多項填空題」
  視覺：多個空白框（非 □ 勾選框）+ 紅色代號
  動作：學生在多個格子內填代號（如 ㄅ、ㄇ、ㄉ），順序無關
  answer：代號集合 — "ㄅ、ㄇ、ㄉ"（每子題各自一個 answer）

▸ matching 「連連看」
  視覺：左欄項目 + 右欄選項 + 紅色連線
  動作：學生連線（1對1 / 1對多 / 多對多）
  answer：每子題填對應右欄文字 — "2公尺/秒"

▸ ordering 「排序題」
  視覺：一列待排序項目 + 紅色序號 1-N
  動作：學生在格內填序號表示順序
  answer：序號集合 — "3,1,4,2"

▸ mark_in_text 「圈詞題」
  視覺：一段文章 + 紅色圈/底線散布其中（如「請在文中圈出所有名詞」）
  動作：學生在文中圈出特定詞語
  answer：列出所有被圈詞語 — "桌子,椅子,書本"

▸ calculation 「計算題」（A bucket — 只看最終答案，過程交 Accessor 自行判斷）
  視覺：印刷算式或情境 + 工作區 + 紅色橫式/直式算式（無「答：」答句行）
  動作：學生寫算式步驟 + 在 (   ) 或工作區末尾寫最終值
  answer：純數值正解（不含單位）— "360" / "3/4" / "8.75"
  ⚠️ 不需要 rubricsDimensions（過程交 Accessor 處理）
  ⚠️ 即使括號內只有單一值，只要學生在下方寫了算式步驟，仍歸 calculation

▸ word_problem 「應用題」（A bucket — 只看最終答案，過程交 Accessor 自行判斷）
  視覺：情境敘述 + 工作區 + 紅色算式 + 「答：___」或「A：___」答句行
  動作：學生寫算式 + 答句（含單位或文字答案）
  answer：純最終答案（含單位或文字），**不含「答：」前綴**
       例：「8.75 公里/時」、「120 公尺」、「甲班」、「教師節」
       不對：「答：8.75 公里/時」（不要寫 prefix）
  ⚠️ 不需要 rubricsDimensions（過程交 Accessor 處理）
  ⚠️ 與 calculation 差別：是否有「答：」答句行

═══════════════ Bucket B：容多元 ═══════════════

▸ fill_variants 「多元填空題」
  視覺：空格 + 紅色答案，題目可接受多種寫法（造詞、近義詞）
  動作：學生填一個值，可有多種接受答案
  欄位：referenceAnswer = 範例答案；acceptableAnswers = 所有可接受答案陣列

▸ map_fill 「填圖題」
  視覺：地圖 + 多個標記位置 + 紅色名稱
  動作：學生在地圖上多個位置填寫地名/國名
  欄位：referenceAnswer 描述位置-名稱對應；acceptableAnswers 列出所有正確名稱

═══════════════ Bucket C：Rubric ═══════════════

▸ short_answer 「簡答題」
  視覺：大空白區 + 紅色文字段落
  動作：學生寫文字自由說明
  欄位：referenceAnswer + rubricsDimensions（至少兩維，如「核心結論」+「作答依據」）

  ⚠️ calculation / word_problem 已搬到 Bucket A（精確比對，只看最終答案）。詳見 Bucket A 區段。

▸ map_symbol 「地圖符號標記題」
  視覺：地圖 + 紅色符號（▲/★/●）
  動作：學生在地圖某位置畫符號
  欄位：referenceAnswer + rubricsDimensions: [符號正確性, 位置精準度]
  referenceAnswer 範例：「颱風符號，位置：23.5°N 緯線以南、121°E 經線以東的格子（右下格）」

▸ grid_geometry 「格線幾何繪製題」
  視覺：格線紙 + 紅色繪製的幾何圖形（三角形、平行四邊形等）
  動作：學生在格線紙上依條件畫幾何圖形
  欄位：referenceAnswer + rubricsDimensions: [圖形正確性, 邊長/角度精準度]
  referenceAnswer 範例：「圖形：正方形，大小：邊長 3 格，位置：從第 1 列第 2 格開始」

▸ connect_dots 「連點繪圖題」
  視覺：點陣 + 紅色連線形成圖形
  動作：學生把指定點連起來形成圖形
  欄位：referenceAnswer + rubricsDimensions: [連線正確性, 圖形完整性]
  referenceAnswer 範例：「連線：1→2→3→4→5，形成圖形：Z 字形」

▸ diagram_draw 「圖表繪製題」
  視覺：預印格線/圓 + 紅色繪製
  動作：學生繪製長條圖/圓餅圖等
  欄位：referenceAnswer + rubricsDimensions: [數值正確性, 標籤完整性]
  referenceAnswer 範例：
   - 圓餅圖：「番茄汁 2/5, 紅蘿蔔汁 1/10, 蘋果汁 3/20, 葡萄汁 1/4」（每扇形「標籤 比率」）
   - 長條圖：「一月 50, 二月 30, 三月 45, 四月 60」（每長條「標籤 高度/數值」）

▸ diagram_color 「塗色題」
  視覺：預印圖形 + 紅色塗色
  動作：學生在預印圖形上塗色（如分數塗色）
  欄位：referenceAnswer + rubricsDimensions: [塗色比例, 塗色位置, 塗色完整性]
  referenceAnswer 範例：「塗色：第 1 個圓完整，第 2 個圓左側 2/3，第 3 個圓未塗」

═══════════════ Bucket D：複合題（部分之間有依存關係）═══════════════

⚠️ D bucket referenceAnswer 寫法通則：
- 寫成「**選項，因為理由**」一句話作為示範（自選或必選都這樣寫）
- 配 rubricsDimensions 兩維（圈/勾選 + 理由說明）分別評分
- criteria 內**用「所選/所填/該事件」reference 前面 cell** 表達依存

▸ compound_circle_with_explain 「圈選說明題」
  視覺：括號內預印選項（同意／不同意）+ 圈選 + 下方理由區
  動作：圈印刷選項 1 個 + 寫理由說明（理由 must match 圈選）
  自選情境（任選/你的看法）：
    answer = "" 或 "自選"
    referenceAnswer = "同意，因為讀書是重要出路..."（一句話示範）
    rubricsDimensions:
      [{name:"圈選", criteria:"有圈選任一選項即可，無對錯"},
       {name:"理由", criteria:"說明的理由與**所選選項**一致且合理"}]
  必選情境（判斷/哪個正確）：
    answer = "清朝"（正確選項）
    referenceAnswer = "清朝，因為從文獻記載..."（一句話示範）
    rubricsDimensions:
      [{name:"圈選", criteria:"必須圈選正確選項"},
       {name:"理由", criteria:"說明的理由能支持正確選項，邏輯合理"}]

▸ compound_check_with_explain 「勾選說明題」
  視覺：方框 □ 列 + 勾選 + 下方理由區
  動作：□ 打勾 1 個 + 寫理由
  欄位寫法同 compound_circle_with_explain（自選/必選兩種情境）
  answer = 勾選位置編號（必選時）or "" or "自選"（自選時）
  referenceAnswer = "[選項]，因為[理由]"

▸ compound_writein_with_explain 「寫入說明題」
  視覺：空括號 + 代號 + 下方理由區
  動作：寫代號 + 寫理由
  欄位寫法同 compound_circle_with_explain
  answer = 代號（必選時）or ""（自選時）
  referenceAnswer = "[選項]，因為[理由]"

▸ multi_check_other 「複選含其他題」
  視覺：一列 □ + 最後一個 □ 後接「其他：___」開放欄
  動作：勾多個固定選項 + 在「其他」欄寫開放文字（若勾了其他）
  欄位：answer = 固定選項中被勾的位置編號（不含其他）；
        referenceAnswer = 其他欄寫的文字（若勾且有寫，去掉「答案僅供參考」備注）

▸ compound_judge_with_correction 「判斷改正題」
  視覺：敘述句 + 括號 ○/✗ + 改正空白
  動作：對的打 ○、錯的打 ✗，錯的還要**改正錯的部分**（改正取決於判斷）
  欄位：answer = "○" 或 "✗"；referenceAnswer = 正確改寫文字（改錯字／改錯數值）

▸ compound_judge_with_explain 「判斷說明題」
  視覺：敘述句 + 「對不對？」括號（學生寫對/不對 或 ○/✗）+ 「為什麼？」括號或空白（學生寫理由）
  動作：判斷對錯 + **解釋為什麼**（理由 must match 判斷）
  與 compound_judge_with_correction 差別：
    - judge_with_correction：錯的「改寫成正確版本」（改字）
    - judge_with_explain：「解釋因果」（為什麼對 / 為什麼不對）
  自選情境（題幹是開放性提問，沒有絕對對錯）：
    answer = "" 或 "自選"
    referenceAnswer = "不對，因為他們的畢業旅行總額不同..."（一句話示範）
    rubricsDimensions:
      [{name:"判斷", criteria:"有寫對/不對(或○/✗)即可，無對錯"},
       {name:"理由", criteria:"理由與所判斷的方向一致且邏輯合理"}]
  必選情境（題幹有確定答案）：
    answer = "不對"（正確判斷）
    referenceAnswer = "不對，因為..."（一句話示範）
    rubricsDimensions:
      [{name:"判斷", criteria:"必須判斷為[正確答案]"},
       {name:"理由", criteria:"理由能支持正確判斷，邏輯合理"}]

▸ compound_chain_table 「表格連動題」
  視覺：表格格式，多個 cell（每 cell 不同欄位類型，如人物/事件/影響）
  動作：學生在 row 各 cell 填寫對應內容，**cell 之間 chain 依存**
        （事件取決於人物選誰；影響取決於事件是什麼）
  識別特徵：
    - 表格多欄（≥2 欄），每欄問不同的具體內容
    - 至少一欄是限制範圍的選擇（如「從題目給的人物中選」）
    - 後續欄位的 criteria 必須 reference 前一 cell 的內容
  欄位：
    answer = null（無單一精確答案）
    referenceAnswer = 整 row 範例（如「斯文豪推薦臺灣茶，讓臺灣茶外銷量增加...」）
    rubricsDimensions = 依表格實際欄位數動態（每欄一個維度，名稱用欄標題）
    每維度 criteria：
      第 1 欄（選擇/限制）：直接寫範圍限制
        例：name="人物"，criteria="填入題目給的三位外國人之一"
      第 2 欄起（依存欄）：用「**所填 X**」「**該事件**」reference 前一 cell
        例：name="具體事件"，criteria="舉出**所填人物**做的、與[類別]相關的具體事件"
            name="影響"，criteria="說明**該事件**對臺灣的具體影響"
  orderMode：通常是 strict（列由印刷的「類別」label 固定）
  範例（社會表格題）：
    題目：「請完成下面的表格（貢獻 / 人物 / 具體事件 / 影響）」
    第 1 列「經濟發展」→ id="5-1", questionCategory="compound_chain_table"
      rubricsDimensions=[
        {name:"人物", maxScore:1, criteria:"填入題目給的三位外國人之一"},
        {name:"具體事件", maxScore:1, criteria:"舉出所填人物做的、與經濟發展相關的具體事件"},
        {name:"影響", maxScore:2, criteria:"說明該事件對臺灣經濟的具體影響"}
      ]
    第 2 列「社會福利」→ id="5-2"，rubricsDimensions 類似但 criteria 改為「與社會福利相關」

═══════════════════════════════════════════════════
【反幻覺警告（適用所有 type）】
❌ 禁止猜測答案：看不清楚 → answer 填 "?"
❌ 禁止用語言/學科知識補答案
❌ 禁止修正錯字、不美化字跡
❌ 禁止創造圖中沒有的內容
⚠️ 寧可標 "?"，也不要猜測。
`.trim()
}

/**
 * Part 4：領域加成（refinement layer）
 * 只描述領域特化的細節（如國字注音、社會圈選說明判別、數學 word_problem 邊界），
 * 不重複決策樹的分類邏輯（那部分在 buildDecisionTree + buildTypeSpecs）。
 */
function buildDomainRefinements(domain: string = '其他'): string {
  const domainMap: Record<string, string> = {
    國語: `
【國語領域加成】

領域通用：
- 直排文字閱讀：從右上角開始，往左、往下依序排列
- 選項順序：甲乙丙丁通常從右到左排列
- 題號編排：依直排閱讀順序

▸ 國字注音題（fill_blank 子情境）：
  - 每一個詞語只有一個空格（彩色框/紅字框），另一部分已印在題目中
    → 每個詞語只建一題，不要為同一詞語建兩題
    → ❌ 錯誤：詞語「托（ㄊㄨㄛ）」拆成兩題（一填「托」、一填「ㄊㄨㄛ」）
    → ✅ 正確：詞語「托（ㄊㄨㄛ）」只建一題，answer 填彩色框內的值
  - answer 格式：只填一個值（只讀彩色框內容）
    → 彩色框是國字 → answer 填國字（如 "托"）
    → 彩色框是注音 → answer 填注音（如 "ㄊㄨㄛ"）
    → 不要用斜線格式，不要同時填國字和注音
  🚫 嚴格禁止注音幻覺：禁止用語言知識推算注音，只讀彩色框內實際印出的值。
     若不清楚 → answer 填 "?"

▸ 形近字 / 同音字 / 異音字造詞題（fill_variants）：
  - 形近字：referenceAnswer 必須包含部首說明（如「(言部)辯：辯護、爭辯」）
  - 同音字：referenceAnswer 必須包含讀音說明（如「ㄋㄨㄥˋ讀音的詞語」）
  - 異音字：referenceAnswer 必須包含讀音說明
  - acceptableAnswers 列出標準答案中的所有範例詞

▸ 引導式多段問答題（如「步驟一/步驟二」「承上題選擇並說明」）：
  - 必須視為 1 題（不可拆成多題）
  - questionCategory: short_answer
  - rubricsDimensions 分階段：
    • 第一階段（引導/選擇）：criteria「完成選擇即可，無對錯」
    • 第二階段（主要作答）：criteria 依題幹要求推導

  ⚠️【接題型 criteria 鐵律】當題幹含「承上題」「接續上題」「根據上題」：
    1. criteria 必須從【題幹本身】推導，不得從參考答案複製
    2. 第一階段固定寫：criteria: "任選上題有效選項完成選擇即可，無對錯"
    3. 第二階段依題幹的說明深度推導，例：
       - 題幹說「說明以什麼樣的方式達到這樣的意義」
         → criteria: "具體說明所選層面如何達到效果，不限定選哪個層面"
    4. ❌ 禁止 criteria 包含特定層面/答案內容
    ✅ criteria 描述「格式與深度要求」，不限定「內容方向」

▸ 改錯題（fill_blank 子情境）：
  - answer 填正確的字（不含錯字）
  - 每一個改正位置為一題
`.trim(),
    數學: `
【數學領域加成】

領域通用：
- 數值+單位必須完整（如：5 公分，不是 5）
- 分數格式：「1/2」或「½」；小數格式：「3.14」
- 提取算術符號（+、−、×、÷、=）

▸ fill_blank vs calculation vs word_problem 邊界（依「學生實際作答行為」判斷）：

  ⚠️ 三者皆為 A bucket（精確比對 answer field）。差別在 work area 與「答：」答句。

  Step 1：題目下方/旁邊有沒有 work area（給學生寫算式的空白）？
    - 沒 work area / 學生只填單一值 → fill_blank（answer = 單一值）
    - 有 work area + 學生寫了算式步驟 → 進 Step 2

  Step 2：學生算式末尾有沒有「答：___」或「A：___」答句行？
    - 沒答句行 → calculation
      answer = 純數值（不含單位）"360" / "3/4" / "8.75"
    - 有答句行 → word_problem
      answer = 純最終答案（含單位或文字答案，不含「答：」前綴）"8.75 公里/時" / "甲班"

  典型 fill_blank（無工作區）：
    題目「3 + 5 = (   )」直接接下一題
    → fill_blank, answer = "8"

  典型 calculation（有工作區、無答句）：
    題目「(1) 0.6 ÷ (2.5 - 1.9) - 1/4 = (   )」+ 下方留 4-5 行空白
    學生在括號填 "3/4"，下方寫了 "0.6 ÷ 0.6 = 1; 1 - 1/4 = 3/4"
    → calculation, answer = "3/4"

  典型 word_problem（有工作區 + 有「答：」）：
    題目「小明的速度…？」+ 工作區 + 「答：___」
    學生寫了 "35 ÷ 4 = 8.75" + 「答：8.75 公里/時」
    → word_problem, answer = "8.75 公里/時"（不含「答：」）

  ⚠️ calculation/word_problem 不需要 rubricsDimensions（過程交 Accessor 自行判斷）
  ⚠️「算算看」「計算看看」後若有「答：」行 → word_problem
  ⚠️ 即使括號內只有單一值，只要學生寫了算式步驟 → calculation 或 word_problem

▸ 比例式格式（word_problem 特化）：
  學生可能寫「箭頭式」「÷N 標註式」「括號 + 除以式」三種比例式表達。
  rubric 評分時，列式維度應接受任一種比例式格式為合格列式。
`.trim(),
    英語: `
【英語領域加成】

領域通用：
- 拼字/大小寫需精確（Apple ≠ apple）
- 保留標點符號（Hello! ≠ Hello）
- 保留撇號（don't、it's）、連字號（twenty-one）、空格（I am ≠ Iam）

▸ 所有題型：
  - 嚴格保留原始拼寫格式
  - 不修正錯字、不補大寫
`.trim(),
    社會: `
【社會領域加成】

領域通用：
- 專注同音異字（如：九州 ≠ 九洲）
- 紅色內容是答案，但人名/地名/事件名「即使紅色」也只是參考答案，不限唯一

⚠️【任選/自選題 criteria 通用鐵律】（適用所有題型）
當題幹出現「任選」「選出 N 個」「挑選」或學生可從多個選項自由選擇時：
1. criteria 絕對不可包含特定的人名、地名、事件名、項目名稱
   ❌ "正確填入人物『斯文豪』"（限定特定答案）
   ❌ "說明鐵路建設的影響"（限定特定項目）
   ✅ "填入題目提供的任一有效人物即可"
   ✅ "說明所選人物/建設的具體影響，邏輯合理"
2. criteria 只評內容品質，不要求特定書寫格式
   ❌ "使用因為...所以...格式"
   ✅ "理由合理且與所選相符"
3. 具體名稱只能出現在 referenceAnswer（作為示範），不在 criteria
4. 多行/多格的任選題，所有行的 criteria 必須相同（通用寫法），只有 referenceAnswer 不同

▸ 圈選說明題識別（compound_circle_with_explain 特化）：
  - 識別特徵：題目要求學生先圈選/勾選一個選項，再說明理由
  - 句式：「我（同意/不同意）：因為...」「先圈選，再說明理由」「在□裡打✓，並說明判斷的理由」
  - 必須視為 1 題（絕對不可拆成「圈選」+「理由」兩題）
  - questionCategory 三選一：
    • 圈印刷選項 + 說明 → compound_circle_with_explain
    • □ 打勾 + 說明 → compound_check_with_explain
    • 寫代號 + 說明 → compound_writein_with_explain

  ⚠️【圈選部分自選 vs 必選判斷】（依以下 4 層順序判斷）：
  ① 題幹關鍵字：
     「任選」「你的看法」「你認為」「你覺得」 → 自選
     「判斷」「哪一項正確」「屬於哪個」「根據...判斷」 → 必選
  ② 選項內容：
     立場對立詞（支持/反對、贊成/不贊成）→ 自選
     事實性名詞（歷史時期、人物、地名、科學概念）→ 必選
  ③ 答案卷紅筆：
     老師只在一個選項上標記紅筆 → 必選
     沒圈特定選項 / 兩邊都寫了參考理由 → 自選
  ④ 配分提示：
     「圈選正確答案 N 分」 → 必選
     「圈選 N 分」（沒說「正確」）→ 自選

  → 自選：answer 留空或填 "自選"；圈選維度 criteria："有圈選任一選項即可，無對錯"；
        理由維度 criteria："說明的理由與所選選項一致且合理"
  → 必選：answer 填正確選項（如 "反對"、"清領時期"）；圈選維度 criteria："必須圈選正確選項"；
        理由維度 criteria："說明的理由能支持正確選項，邏輯合理"

  rubricsDimensions 預設兩維（若答案卷有明確配分標示則依標示）：
    1.「圈選」 — 依上述自選/必選規則
    2.「理由說明」 — 依上述自選/必選規則
    （若有「語句通順」獨立配分，加第 3 維 criteria: "語句表達清楚通順"）

▸ 任選+逐項說明題（多行 short_answer 特化）：
  觸發條件（必須同時滿足）：
  ① 題幹明確「任選 N 項」「選出 N 個」「挑選 N 個」（N ≥ 2）
  ② 表格或分行格式，每行有「選擇欄」+「說明欄」
  ③ 說明欄寬度明顯大於選擇欄（學生需寫一句話以上）
  ❌ 禁止：拆成兩題（選擇 + 說明）
  ❌ 禁止：合併成一大題
  ❌ 禁止：歸 multi_fill
  ✅ 正確：每一行 = 獨立 1 題 short_answer
  - orderMode: "unordered"，所有行共用 unorderedGroupId
  - rubricsDimensions（每行）：
    1.「選擇」 criteria: "有填入清單中任一有效項目即可"
    2.「理由說明」 criteria: "說明所選項目的影響或理由，內容合理且與所選相符"
  ⚠️ 任選題鐵律：每行 criteria 不可包含特定項目名稱（見上方通用鐵律）

▸ 圖表代號填入題（multi_fill 特化）：
  - 在地圖/流程圖/示意圖的空白框中填入代號（非地名，如 ㄅ、ㄆ、ㄇ 或 甲、乙）
  - 不要歸類為 map_fill（map_fill 只用於填地名/國名）
  - 每個空白框獨立為一題（拆成子題）
  - referenceAnswer 描述該框在圖中的位置/語意
  - 子題 id 排序：由上而下（y 由小到大），同行由左而右（x 由小到大）

▸ map_fill 必填位置描述（重要）：
  - referenceAnswer 必須包含每個答案的地理相對位置描述
  - 用「方位詞」或「相鄰關係」描述每個答案在地圖上的位置
  - ❌ 禁止只列國名（如「包含：摩洛哥、阿爾及利亞」）
  - ✅ 必須像：「地圖最左上方為摩洛哥，摩洛哥右側（東方）為阿爾及利亞...」
  - 若有印刷標記代號（A、B、C），寫「標記A（左上方）為泰國...」

▸ map_symbol 位置精準度（重要）：
  - 優先抓取題目中的精準座標（如：東經 151.4°E、北緯 15°N）
  - criteria：「必須標註在東經 151.4°E、北緯 15°N 附近（允許誤差 ±1°以內）」
  - ❌ 範圍過於寬鬆（如「經度 121°E 以東」）
`.trim(),
    自然: `
【自然領域加成】

領域通用：
- 名詞/數值/單位必須完整
- 化學式保留下標（H₂O、CO₂）

▸ 自然繪圖/標註題（rubric_text 或 rubric_draw 特化）：
  - 實驗裝置圖、標註器官/部位、畫食物鏈/食物網等
  - 使用 rubricsDimensions 分維度：圖形正確性 / 標註正確性 / 完整性
`.trim(),
  }

  const defaultDomain = `
【${domain}領域】
- 按通則的顏色辨識原則提取（紅色 = 答案）
- 保留原始格式，不修正、不美化
`.trim()

  return domainMap[domain] || defaultDomain
}

/**
 * 建立「從空白作業推論答案」的 Prompt
 * 不需要解答圖，AI 直接根據題目內容與語言/學科知識推論正確答案
 */
function buildInferFromBlankPrompt(domain?: string): string {
  const domainLabel = domain || '小學'
  const decisionTree = buildDecisionTree()
  const typeSpecs = buildTypeSpecs()
  const domainRefinements = buildDomainRefinements(domain || '其他')

  return `
你是一位台灣${domainLabel}老師，請看這份**空白習作**圖片，推論每題的正確標準答案，建立 AnswerKey。

【重要說明】
- 這是**尚未填寫的空白作業**，不是解答圖
- 請根據題目文字、課文語境與你的學科知識，推論正確答案
- 不要憑猜測，有把握的才填；不確定的在 answer/referenceAnswer 後加「（待確認）」

【國字注音題特別說明】
- 看到空白框（□）旁邊有國字 → 請填入該字的正確注音（完整聲母+韻母+聲調，如 ㄓㄤ）
- 看到空白框（□）旁邊有注音 → 請填入對應的正確國字
- 每一個空白框是獨立的一題，不要把多個框合併

${decisionTree}

${typeSpecs}

${domainRefinements}

【輸出格式（JSON）】
{
  "questions": [
    {
      "id": "1-1",
      "questionCategory": "fill_blank",
      "bucket": "A",
      "answer": "彰",
      "maxScore": 1
    }
  ],
  "totalScore": 數字
}

輸出純 JSON，不要 markdown 代碼塊。
`.trim()
}

/**
 * 純答題卡（answer_only）模式專用提取 Prompt。
 *
 * 與一般模式的不同：
 * - 圖片是「純答題卡」，沒有題目內容，只有 section 表格 + 每格答案
 * - 不靠題型推位置、改靠 section header + grid 切每格
 * - questionCategory 由「答案內容」推：
 *   單字母 → single_choice；字母逗號/無分隔 → multi_choice；
 *   公式/數值/單位 → fill_blank；長段文字/推導 → short_answer
 * - 沿用一般模式的 4 種 type，不另創名詞
 */
function buildAnswerKeyAnswerOnlyPrompt(domain?: string): string {
  const domainHint = domain && domain !== '其他' ? `\n【領域提示】科目：${domain}（影響 fill_blank 答案的單位／格式判讀）` : ''

  return `
你會看到一張或多張「純答題卡」圖片：只有答案表格，沒有題目本身。
表格通常依 section 分區（如「一、單選題」「二、多重選擇題」「三、非選題」「四、混合題」），
每個 section 是一個格子表格，每格放一題的答案。

請把每一格的答案 + 題型抽出，回傳純 JSON（無 markdown）。

## 0. 重要原則
1. **不要編造題目內容**。你只能看到答案、不知道題目在問什麼。
2. **每一格 = 一題**，按表格從上到下、從左到右逐格編號。
3. **section 標題**指出大致題型範疇，但每格的 questionCategory 最終由「答案內容」決定。
4. **空格也要建立題目項**（answer 為空），讓老師之後手動填入。

## 1. questionCategory 規則（必須使用以下 4 種之一）

【規則優先順序】section header 優先於答案內容；答案內容只在 section 不能決定時使用。

### 1A. Section header 強規則（最高優先）
- 「簡答」「問答」「申論」「混合題」「非選擇題的子題之申論」section
  → 該 section 所有題目原則上都是 short_answer
  → 這類題目用 referenceAnswer 欄位（不是 answer），並必填 rubricsDimensions
  → 例外：若該 section 中某題答案明顯是單一字母（A-E）或選項，仍可用 single_choice
- 「單選題」「多選題」「多重選擇題」「複選」section → 對應 single_choice / multi_choice
- 「填充題」「填空題」「非選擇題」「非選」section → 對應 fill_blank

### 1B. 答案內容輔助判斷（當 section 不能決定時）
| 答案內容樣態 | questionCategory | 範例 |
|---|---|---|
| 單一英文字母 A–E | single_choice | "C"、"A" |
| 多個字母（逗號分隔或連寫） | multi_choice | "B,C"、"BC"、"A、D" |
| 純數字、公式、含單位的數值 | fill_blank | "240A"、"4/3 B"、"1.0×10⁻²"、"μ₀i/4(1/a-1/b)" |
| 多行推導、長段文字、解釋 | short_answer | "因 a+b=0 故..." |
| 空白 | 看 section：簡答／混合 → short_answer；其他 → fill_blank | "" |

### 1C. 欄位選擇規則（重要）
- single_choice / multi_choice / fill_blank → 答案放 answer 欄位
- short_answer → 答案放 referenceAnswer 欄位（不是 answer），且必填 rubricsDimensions
- 即使老師寫的 short_answer 文字很短（如「一樣大」「正確」），仍是 referenceAnswer

⚠️ 名稱必須完全一致：single_choice / multi_choice / fill_blank / short_answer。
   禁止使用 fill_variants、circle_select_one、compound_* 或其他舊系統名稱。

## 2. 題號規則
- section 序號（一→1、二→2、三→3、四→4），section 內題目從 1 開始
- ID 格式：「<photoIdx>-<sectionIdx>-<questionIdx>」（單張照片時可省略 photoIdx）
  例：第一張照片，「一、單選題」第 5 題 → "1-5"；「三、非選題」第 1 題第 2 子格 → "3-1-2"
- idPath 對應：["1","5"] 或 ["3","1","2"]
- 若一個 section 內有「子題群」（如非選題第 1 題下分 (1)(2)(3) 三格），用第三層編號

## 3. anchorHint（必填）
中文短句描述位置，例：
- "位於『一、單選題』表格第 5 格"
- "位於『三、非選題』第 1 大題的子格 (2)"
- "位於『四、混合題』第 1 格"

## 4. answerBbox（必填）
每格 bbox 用 normalized coordinates [0,1]：
- x, y: 格子左上角；w, h: 格子寬高
- bbox 必須涵蓋整格答案儲存區（不只字本身、要含整格背景），讓批改階段切圖時能對齊
- 對 short_answer 多行作答區：bbox 範圍要包含整個寫字區塊

## 5. maxScore 推論
- 優先從 section 標題抓「每題 X 分」（例：「一、單選題（12題 每題4分 共48分）」→ 每題 4 分）
- 找不到「每題 X 分」就從 section 總分均分（總分 / 題數）
- 都沒寫 → 預設 1
- short_answer：必填 rubricsDimensions（兩維度：作答依據 + 結論表達），兩維度 maxScore 加總 = 該題 maxScore

## 6. tablePosition（建議填，能就填）
若該題位於有多列／多行的表格，填寫表格座標：
{"col": <格子在第幾欄>, "row": <格子在第幾列>, "totalCols": <總欄數>, "totalRows": <總列數>}
答題卡通常是「一列題號 + 一列答案」的兩列表格（totalRows=2），這時 row=2 代表答案格。

## 7. _layoutDetected（必填，且要在 questions 之前生成）
陣列長度 = 上傳照片張數，每張一個元素：
- "answer-only-single-section"：整張照片只有一個 section
- "answer-only-multi-section"：整張照片含多個 section（如單選+多選+非選都在同一張）
- "answer-only-multi-page"：跨頁展開
- "other:<簡述>"：其他

## 輸出範本
{
  "_layoutDetected": [{"photo": 1, "layout": "answer-only-multi-section"}],
  "questions": [
    {
      "id": "1-1",
      "idPath": ["1","1"],
      "questionCategory": "single_choice",
      "answer": "C",
      "maxScore": 4,
      "answerBbox": {"x": 0.113, "y": 0.239, "w": 0.078, "h": 0.081},
      "anchorHint": "位於『一、單選題』表格第 1 格",
      "tablePosition": {"col": 1, "row": 2, "totalCols": 12, "totalRows": 2}
    },
    {
      "id": "2-1",
      "idPath": ["2","1"],
      "questionCategory": "multi_choice",
      "answer": "B,C",
      "maxScore": 5,
      "answerBbox": {"x": 0.085, "y": 0.345, "w": 0.155, "h": 0.067},
      "anchorHint": "位於『二、多重選擇題』表格第 1 格",
      "tablePosition": {"col": 1, "row": 2, "totalCols": 6, "totalRows": 2}
    },
    {
      "id": "3-2",
      "idPath": ["3","2"],
      "questionCategory": "fill_blank",
      "answer": "240A",
      "maxScore": 5,
      "answerBbox": {"x": 0.245, "y": 0.620, "w": 0.13, "h": 0.065},
      "anchorHint": "位於『三、非選題』表格第 2 格"
    },
    {
      "id": "4-2",
      "idPath": ["4","2"],
      "questionCategory": "short_answer",
      "referenceAnswer": "一樣大（即使參考答案文字短，short_answer 仍用 referenceAnswer 欄位）",
      "rubricsDimensions": [
        {"name": "作答依據", "maxScore": 2, "criteria": "正確比較兩者大小關係並說明原因"},
        {"name": "結論表達", "maxScore": 2, "criteria": "明確寫出比較結論"}
      ],
      "maxScore": 4,
      "answerBbox": {"x": 0.30, "y": 0.78, "w": 0.30, "h": 0.10},
      "anchorHint": "位於『四、混合題』第 2 格"
    },
    {
      "id": "4-3",
      "idPath": ["4","3"],
      "questionCategory": "short_answer",
      "referenceAnswer": "因 a+b=0 ⇒ a=-b，代入...（多行推導也是 short_answer）",
      "rubricsDimensions": [
        {"name": "作答依據", "maxScore": 2, "criteria": "明確指出守恆條件並列式推導"},
        {"name": "結論表達", "maxScore": 2, "criteria": "得到具體結果並標注單位"}
      ],
      "maxScore": 4,
      "answerBbox": {"x": 0.62, "y": 0.78, "w": 0.30, "h": 0.10},
      "anchorHint": "位於『四、混合題』第 3 格"
    }
  ],
  "totalScore": 120
}${domainHint}

輸出純 JSON，不要 markdown 代碼塊。
`.trim()
}

/**
 * 建立答案提取 Prompt（重構版 — 決策樹 + 25 type specs + 領域加成）
 */
function buildAnswerKeyPrompt(domain?: string): string {
  const taskAndFormat = buildGlobalTaskAndFormat()
  const decisionTree = buildDecisionTree()
  const typeSpecs = buildTypeSpecs()
  const domainRefinements = buildDomainRefinements(domain || '其他')

  // 順序：通則 → 決策樹 → 25 type specs → 領域加成
  return [taskAndFormat, decisionTree, typeSpecs, domainRefinements].filter(Boolean).join('\n\n')
}

function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10
}

function splitScoreIntoTwo(totalScore: number): [number, number] {
  const safeTotal = Number.isFinite(totalScore) && totalScore > 0 ? totalScore : 0
  if (safeTotal <= 0) return [0, 0]
  const first = roundToTenth(safeTotal / 2)
  const second = roundToTenth(safeTotal - first)
  return [first, second]
}

function ensureShortAnswerRubricsDimensions(question: AnswerKeyQuestion): AnswerKeyQuestion {
  if (question.questionCategory !== 'short_answer') return question

  const maxScore = Number.isFinite(Number(question.maxScore)) ? Number(question.maxScore) : 0
  const criteriaHint = typeof question.referenceAnswer === 'string' ? question.referenceAnswer.trim() : ''
  const safeDimensions = Array.isArray(question.rubricsDimensions)
    ? question.rubricsDimensions
        .map((dim) => ({
          name: typeof dim?.name === 'string' ? dim.name.trim() : '',
          maxScore: Number.isFinite(Number(dim?.maxScore)) ? Number(dim.maxScore) : 0,
          criteria: typeof dim?.criteria === 'string' ? dim.criteria.trim() : ''
        }))
        .filter((dim) => dim.name && dim.criteria)
    : []

  const [firstScore, secondScore] = splitScoreIntoTwo(maxScore)

  let normalizedDimensions = safeDimensions
  if (safeDimensions.length === 0) {
    normalizedDimensions = [
      {
        name: '作答依據',
        maxScore: firstScore,
        criteria: '有根據題目提供的資料或文本作答，指出關鍵依據。'
      },
      {
        name: '結論表達',
        maxScore: secondScore,
        criteria: criteriaHint
          ? `結論與重點相符（參考要點：${criteriaHint}），表達完整清楚。`
          : '結論與重點相符，表達完整清楚。'
      }
    ]
  } else if (safeDimensions.length === 1) {
    normalizedDimensions = [
      { ...safeDimensions[0], maxScore: firstScore },
      {
        name: '結論表達',
        maxScore: secondScore,
        criteria: criteriaHint
          ? `結論與重點相符（參考要點：${criteriaHint}），表達完整清楚。`
          : '結論與重點相符，表達完整清楚。'
      }
    ]
  }

  // ── Fix dimension score mismatch: ensure sum of dimension maxScore == question maxScore ──
  if (normalizedDimensions.length >= 2 && maxScore > 0) {
    const dimSum = normalizedDimensions.reduce((s, d) => s + d.maxScore, 0)
    if (Math.abs(dimSum - maxScore) > 0.01) {
      // Redistribute: preserve AI's relative proportions, scale to fit maxScore
      if (dimSum > 0) {
        // Proportional redistribution (round to integers)
        let remaining = maxScore
        for (let i = 0; i < normalizedDimensions.length; i++) {
          if (i === normalizedDimensions.length - 1) {
            // Last dimension gets the remainder to guarantee exact sum
            normalizedDimensions[i] = { ...normalizedDimensions[i], maxScore: remaining }
          } else {
            const scaled = Math.round((normalizedDimensions[i].maxScore / dimSum) * maxScore)
            normalizedDimensions[i] = { ...normalizedDimensions[i], maxScore: Math.max(scaled, 1) }
            remaining -= normalizedDimensions[i].maxScore
          }
        }
        // Safety: if remaining went negative due to rounding, clamp last to 0
        if (normalizedDimensions[normalizedDimensions.length - 1].maxScore < 0) {
          normalizedDimensions[normalizedDimensions.length - 1] = {
            ...normalizedDimensions[normalizedDimensions.length - 1],
            maxScore: 0
          }
        }
      } else {
        // All dimensions had 0 score — equal split
        const perDim = Math.floor(maxScore / normalizedDimensions.length)
        let remainder = maxScore - perDim * normalizedDimensions.length
        normalizedDimensions = normalizedDimensions.map((d, i) => ({
          ...d,
          maxScore: perDim + (i < remainder ? 1 : 0)
        }))
      }
    }
  }

  return {
    ...question,
    type: 3,
    rubricsDimensions: normalizedDimensions,
    rubric: undefined
  }
}

function normalizeAnswerKeyShortAnswerDimensions(answerKey: AnswerKey, domain?: string): AnswerKey {
  void domain
  const questions = Array.isArray(answerKey?.questions) ? answerKey.questions : []
  if (questions.length === 0) return answerKey

  const normalizedQuestions = questions.map((question) => {
    let q = ensureShortAnswerRubricsDimensions(question)
    q = normalizeChoiceAnswerSymbols(q)
    q = sanitizeUnorderedCriteria(q)
    return q
  })

  return {
    ...answerKey,
    questions: normalizedQuestions
  }
}

/**
 * Fix common OCR misreads in choice-type answers:
 * - ▽/▼/∇/▿ → D (handwritten D misread as triangle)
 * - Ⅴ/ⅴ/∨ → V (but could also be a checkmark — only fix in choice context)
 * Only applies to single_choice, multi_choice, multi_fill, multi_check, single_check
 */
function normalizeChoiceAnswerSymbols(question: AnswerKeyQuestion): AnswerKeyQuestion {
  // OCR 符號正規化適用的「選擇/勾選」類 type（含新增的 circle_select_*）
  const choiceTypes = new Set([
    'single_choice', 'multi_choice',
    'circle_select_one', 'circle_select_many',
    'single_check', 'multi_check',
    'multi_fill',
  ])
  if (!question.questionCategory || !choiceTypes.has(question.questionCategory)) return question
  if (typeof question.answer !== 'string' || !question.answer.trim()) return question

  // Only normalize if answer looks like it should contain A-D letters
  // (i.e., other tokens in the answer are A-Z letters)
  const tokens = question.answer.split(/[,、，;\s]+/).map(t => t.trim()).filter(Boolean)
  const hasLetterTokens = tokens.some(t => /^[A-Ca-c]$/i.test(t))

  if (!hasLetterTokens) return question

  // Replace triangle-like symbols with D (common handwriting misread)
  const normalized = question.answer.replace(/[▽▼∇▿◁△⊿]/g, 'D')
  if (normalized !== question.answer) {
    console.log(`[AnswerKey] normalized answer symbol: "${question.answer}" → "${normalized}" (question ${question.id})`)
    return { ...question, answer: normalized }
  }
  return question
}

/**
 * For unordered (任選) questions, sanitize rubricsDimensions criteria:
 * 1. Remove specific answer content from criteria (names, items)
 * 2. Strip format requirements (因為...所以...)
 * Only applies to questions with orderMode="unordered" and rubricsDimensions.
 */
function sanitizeUnorderedCriteria(question: AnswerKeyQuestion): AnswerKeyQuestion {
  if (question.orderMode !== 'unordered') return question
  if (!Array.isArray(question.rubricsDimensions) || question.rubricsDimensions.length === 0) return question

  const sanitized = question.rubricsDimensions.map((dim) => {
    let criteria = dim.criteria ?? ''
    const nameLower = (dim.name ?? '').toLowerCase()

    // Dimension that looks like a "selection" dimension → force generic criteria
    const isSelectionDim = nameLower.includes('選擇') || nameLower.includes('圈選') ||
      nameLower.includes('勾選') || nameLower.includes('填寫人物') ||
      nameLower.includes('填入') || nameLower.includes('選項')
    if (isSelectionDim) {
      // Check if criteria contains quoted specific content like 「XXX」or 『XXX』
      if (/[「『].*[」』]/.test(criteria)) {
        console.log(`[AnswerKey] sanitize criteria: "${criteria}" → generic (question ${question.id}, dim "${dim.name}")`)
        criteria = '填入題目提供的任一有效選項即可'
      }
    }

    // Strip ANY sentence-format requirements from criteria.
    // AI often copies the question's guided format (因為...所以..., 先...再..., etc.)
    // into the criteria as a grading requirement. But format ≠ grading standard.
    // "語句通順" should mean "clear expression", not "must use specific sentence pattern".
    const isFluentDim = nameLower.includes('通順') || nameLower.includes('語句') ||
      nameLower.includes('表達') || nameLower.includes('文字')
    if (isFluentDim) {
      // If this is a fluency dimension, replace with clean generic criteria
      // regardless of what AI wrote — format should never be a grading standard
      const hasFormatReq = /(?:使用|以|用|須用|需用|必須).{0,20}(?:格式|句式|句型|結構)/.test(criteria) ||
        /因為[.…]*所以/.test(criteria) || /先[.…]*再/.test(criteria)
      if (hasFormatReq) {
        console.log(`[AnswerKey] strip format from fluency dim: "${criteria}" → generic (question ${question.id})`)
        criteria = '語句表達清楚通順'
      }
    } else {
      // For non-fluency dimensions, strip format fragments but keep content criteria
      const formatPatterns = [
        /[，,；;]?\s*(?:使用|以|用|須用|需用|必須使用).{0,30}(?:格式|句式|句型|結構|的方式)[，,；;]?\s*/g,
        /[，,；;]?\s*(?:使用|以|用)因為[.…]*所以[.…]*(?:句式|格式|來)?(?:且|並)?/g,
      ]
      let cleaned = criteria
      for (const p of formatPatterns) {
        cleaned = cleaned.replace(p, '').trim()
      }
      if (cleaned !== criteria) {
        console.log(`[AnswerKey] strip format requirement: "${criteria}" → "${cleaned}" (question ${question.id})`)
        criteria = cleaned || dim.criteria
      }
    }

    return { ...dim, criteria }
  })

  return { ...question, rubricsDimensions: sanitized }
}

function buildTagConceptsPrompt(
  questions: Array<{ id: string; questionCategory?: string; answer?: string }>,
  conceptMap: { code: string; label: string; description?: string }[]
): string {
  const questionList = questions
    .map(q => {
      const answerText = q.answer?.trim() ? `  答案: "${q.answer.trim()}"` : ''
      return `- id: "${q.id}"  題型: ${q.questionCategory ?? '未知'}${answerText}`
    })
    .join('\n')

  // Build concept list: show short label + description for context, but clearly separate them
  const conceptList = conceptMap
    .map(c => c.description
      ? `${c.code}  短標題：「${c.label}」  說明：${c.description}`
      : `${c.code}  短標題：「${c.label}」`)
    .join('\n')

  return `【108課綱概念標記任務 / concept_code_only】
請根據圖片中的題目內容，為下列每一題標記最符合的 108 課綱概念代碼。

題目清單（共 ${questions.length} 題）：
${questionList}

概念代碼清單（格式：代碼  短標題：「...」  說明：...）：
${conceptList}

規則：
- 【重要】題目清單中的每一題都必須出現在回傳的 tags 陣列中，不可遺漏任何題號
- tags 陣列長度必須等於題目清單長度（${questions.length} 筆）
- 每題只選一個最核心的概念代碼（若題目橫跨多個概念，選主要考點）
- 【嚴格禁止】concept_code 只能選上方清單中的代碼，禁止自行創造不在清單中的代碼
- 【嚴格禁止】concept_label 只能填入該代碼對應的「短標題」（即 「」內的文字），禁止把說明文字混入
- 若確實無法從清單中找到對應概念，填 "concept_code": null, "concept_label": null
- 寧可填 null 也不能填清單外的代碼或自訂標題

回傳純 JSON（無 Markdown），格式：
{
  "tags": [
    { "questionId": "1-1", "concept_code": "N-5-10", "concept_label": "解題：比率應用" },
    { "questionId": "1-2", "concept_code": null, "concept_label": null }
  ]
}`.trim()
}

/**
 * 後處理：檢查並補充缺失的題目
 */
function fillMissingQuestions(
  result: GradingResult,
  answerKey: AnswerKey
): { result: GradingResult; missingQuestionIds: string[] } {
  const expectedIds = new Set(answerKey.questions.map((q) => q.id))
  const actualIds = new Set((result.details ?? []).map((d) => d.questionId))
  const missingIds = Array.from(expectedIds).filter((id) => !actualIds.has(id))

  if (missingIds.length > 0) {
    console.warn(`⚠️ AI 遺漏了 ${missingIds.length} 題：${missingIds.join(', ')}`)

    const missingDetails = missingIds.map((id) => {
      const question = answerKey.questions.find((q) => q.id === id)
      return {
        questionId: id,
        studentAnswer: '無法辨識',
        score: 0,
        maxScore: question?.maxScore ?? 0,
        isCorrect: false,
        reason: 'AI未能辨識此題答案，已自動標記為0分，需人工複核',
        confidence: 0
      }
    })

    result.details = [...(result.details ?? []), ...missingDetails]

    // ✅ 依 AnswerKey 排序（避免補題跑到最尾端）
    const order = new Map(answerKey.questions.map((q, i) => [q.id, i]))
    result.details.sort((a, b) => {
      const ai = order.get(a.questionId ?? '') ?? 9999
      const bi = order.get(b.questionId ?? '') ?? 9999
      return ai - bi
    })

    // 重新計算 totalScore
    result.totalScore = parseFloat(result.details.reduce((sum, d) => sum + (d.score ?? 0), 0).toFixed(1))

    // 標記需要複核
    result.needsReview = true
    result.reviewReasons = [
      ...(result.reviewReasons ?? []),
      `AI 遺漏 ${missingIds.length} 題，已自動補上（${missingIds.join(', ')}）`
    ]
  }

  return { result, missingQuestionIds: missingIds }
}

function isEmptyStudentAnswer(ans?: string) {
  const a = (ans ?? '').trim()
  return a === '未作答' || a === '無法辨識' || a === '未作答/無法辨識'
}

type NormalizedBbox = { x: number; y: number; w: number; h: number }
type LocateQuestionRow = {
  questionId: string
  questionBbox?: NormalizedBbox
  answerBbox?: NormalizedBbox
  confidence?: number
}

function buildLocatePrompt(questionIds: string[]): string {
  return `
You are stage Locate.
Task: locate question/answer regions for the provided question IDs on this submission image.

Target question IDs:
${JSON.stringify(questionIds)}

Rules:
- Only return question IDs in the target list.
- If you can find a question stem region, return questionBbox.
- If you can find the student answer region, return answerBbox.
- Bboxes must be normalized to [0,1] using:
  { "x": 0.12, "y": 0.34, "w": 0.20, "h": 0.08 }
- If uncertain, still give the best approximate box and lower confidence.
- Return strict JSON only.

Output:
{
  "locatedQuestions": [
    {
      "questionId": "string",
      "questionBbox": { "x": 0.1, "y": 0.1, "w": 0.2, "h": 0.08 },
      "answerBbox": { "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.1 },
      "confidence": 85
    }
  ]
}
`.trim()
}

function parseGeminiJsonText(rawText: string): unknown | null {
  const cleaned = rawText.replace(/```json|```/gi, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1))
      } catch {
        return null
      }
    }
    return null
  }
}

function normalizeBbox(raw: unknown): NormalizedBbox | null {
  if (!raw || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>
  const toNum = (value: unknown) => (typeof value === 'number' ? value : Number(value))
  let x = toNum(source.x)
  let y = toNum(source.y)
  let w = toNum(source.w)
  let h = toNum(source.h)

  if (![x, y, w, h].every(Number.isFinite)) return null
  if (w <= 0 || h <= 0) return null

  x = Math.max(0, Math.min(1, x))
  y = Math.max(0, Math.min(1, y))
  w = Math.max(0, Math.min(1, w))
  h = Math.max(0, Math.min(1, h))

  if (x >= 1 || y >= 1) return null
  if (x + w > 1) w = 1 - x
  if (y + h > 1) h = 1 - y
  if (w <= 0 || h <= 0) return null

  return { x, y, w, h }
}

function getLocateTargetQuestionIds(details?: GradingResult['details']): string[] {
  if (!Array.isArray(details) || details.length === 0) return []
  const ids: string[] = []

  for (const detail of details) {
    const questionId = (detail?.questionId ?? '').trim()
    if (!questionId) continue
    const isWrong = detail?.isCorrect === false
    const shouldExplain = detail?.needExplain === true
    const hasBbox = Boolean(detail?.questionBbox || detail?.answerBbox)
    if ((isWrong || shouldExplain) && !hasBbox) {
      ids.push(questionId)
    }
  }

  return Array.from(new Set(ids))
}

function parseLocateRows(rawText: string, targetQuestionIds: string[]): LocateQuestionRow[] {
  const parsed = parseGeminiJsonText(rawText)
  if (!parsed || typeof parsed !== 'object') return []
  const parsedRecord = parsed as Record<string, unknown>
  const rows = Array.isArray(parsedRecord.locatedQuestions) ? parsedRecord.locatedQuestions : []
  if (rows.length === 0) return []

  const targetSet = new Set(targetQuestionIds.map((id) => id.trim()).filter(Boolean))
  const byQuestionId = new Map<string, LocateQuestionRow>()

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const rowRecord = row as Record<string, unknown>
    const questionId =
      typeof rowRecord.questionId === 'string' ? rowRecord.questionId.trim() : ''
    if (!questionId || !targetSet.has(questionId)) continue
    const questionBbox = normalizeBbox(rowRecord.questionBbox ?? rowRecord.question_bbox)
    const answerBbox = normalizeBbox(rowRecord.answerBbox ?? rowRecord.answer_bbox)
    if (!questionBbox && !answerBbox) continue
    const confidenceRaw =
      typeof rowRecord.confidence === 'number'
        ? rowRecord.confidence
        : Number(rowRecord.confidence)
    const confidence = Number.isFinite(confidenceRaw) ? confidenceRaw : undefined
    byQuestionId.set(questionId, {
      questionId,
      ...(questionBbox ? { questionBbox } : {}),
      ...(answerBbox ? { answerBbox } : {}),
      ...(confidence !== undefined ? { confidence } : {})
    })
  }

  return Array.from(byQuestionId.values())
}

function applyLocateRowsToDetails(
  details: GradingResult['details'] | undefined,
  locateRows: LocateQuestionRow[]
): number {
  if (!Array.isArray(details) || details.length === 0 || locateRows.length === 0) return 0
  const byQuestionId = new Map(locateRows.map((row) => [row.questionId, row]))
  let appliedCount = 0

  for (const detail of details) {
    const questionId = (detail?.questionId ?? '').trim()
    if (!questionId) continue
    const locate = byQuestionId.get(questionId)
    if (!locate) continue
    let touched = false

    if (!detail.questionBbox && locate.questionBbox) {
      detail.questionBbox = locate.questionBbox
      touched = true
    }
    if (!detail.answerBbox && locate.answerBbox) {
      detail.answerBbox = locate.answerBbox
      touched = true
    }

    if (touched) appliedCount += 1
  }

  return appliedCount
}

async function enrichWrongDetailBboxesWithLocate(
  result: GradingResult,
  submissionBase64: string,
  submissionMimeType: string,
  logPrefix: string = '',
  targetQuestionIds?: string[]
): Promise<void> {
  const targetIds =
    targetQuestionIds && targetQuestionIds.length > 0
      ? Array.from(new Set(targetQuestionIds.map((id) => id.trim()).filter(Boolean)))
      : getLocateTargetQuestionIds(result.details)

  if (targetIds.length === 0) return

  try {
    console.log(`${logPrefix}📍 [Locate fallback] 目標 ${targetIds.length} 題: ${targetIds.join(', ')}`)
    const locatePrompt = buildLocatePrompt(targetIds)
    const locateText = await generateGeminiText(
      currentModelName,
      [locatePrompt, { inlineData: { mimeType: submissionMimeType, data: submissionBase64 } }],
      { routeKey: 'grading.locate' }
    )
    const locateRows = parseLocateRows(locateText, targetIds)
    const appliedCount = applyLocateRowsToDetails(result.details, locateRows)
    console.log(
      `${logPrefix}📍 [Locate fallback] 回傳 ${locateRows.length} 題定位，已套用 ${appliedCount} 題`
    )
  } catch (error) {
    console.warn(`${logPrefix}⚠️ [Locate fallback] 失敗，略過不影響批改:`, error)
  }
}

// ============================================
// 分頁批改輔助函數
// ============================================

/**
 * 檢查圖片是否為多頁合併圖（根據高寬比判斷）
 */
async function isMultiPageImage(imageBlob: Blob): Promise<{ isMultiPage: boolean; width: number; height: number; aspectRatio: number }> {
  try {
    const bitmap = await createImageBitmap(imageBlob)
    const { width, height } = bitmap
    bitmap.close()
    
    const aspectRatio = height / width
    const isMultiPage = aspectRatio > PAGED_GRADING_ASPECT_RATIO_THRESHOLD
    
    return { isMultiPage, width, height, aspectRatio }
  } catch {
    return { isMultiPage: false, width: 0, height: 0, aspectRatio: 0 }
  }
}

/**
 * 將大圖片拆分成多個段落（帶重疊區避免切斷題目）
 * @param imageBlob 原始圖片 Blob
 * @param maxSegments 最大段數（預設 4）
 * @returns 拆分後的圖片 Blob 陣列
 */
async function splitImageIntoSegments(
  imageBlob: Blob,
  maxSegments: number = 4
): Promise<Blob[]> {
  try {
    const bitmap = await createImageBitmap(imageBlob)
    const { width, height } = bitmap
    
    // 用高寬比估算頁數（A4 約 1.4:1）
    const aspectRatio = height / width
    const estimatedPages = Math.round(aspectRatio / 1.4)
    const segments = Math.min(Math.max(estimatedPages, 1), maxSegments)
    
    console.log(`📄 [分頁批改] 圖片尺寸: ${width}x${height}px, 高寬比=${aspectRatio.toFixed(2)}, 估計 ${estimatedPages} 頁, 拆分為 ${segments} 段`)
    
    if (segments <= 1) {
      bitmap.close()
      return [imageBlob]
    }
    
    // 計算每段高度（不含重疊）
    const baseSegmentHeight = Math.ceil(height / segments)
    const overlap = PAGED_GRADING_OVERLAP_PX
    const results: Blob[] = []
    
    for (let i = 0; i < segments; i++) {
      // 計算該段的起始和結束位置（含重疊）
      const baseStartY = i * baseSegmentHeight
      const baseEndY = Math.min((i + 1) * baseSegmentHeight, height)
      
      // 加入重疊區：前面的段落往下延伸，後面的段落往上延伸
      const startY = i === 0 ? 0 : Math.max(0, baseStartY - overlap)
      const endY = i === segments - 1 ? height : Math.min(height, baseEndY + overlap)
      const actualHeight = endY - startY
      
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = actualHeight
      const ctx = canvas.getContext('2d')
      
      if (!ctx) {
        throw new Error('無法建立畫布')
      }
      
      // 從原圖裁切出該段
      ctx.drawImage(
        bitmap,
        0, startY, width, actualHeight,  // source
        0, 0, width, actualHeight         // destination
      )
      
      // 轉為 Blob（用 WebP 高品質保真，後續交給 compressForGemini 壓縮）
      const segmentBlob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (blob) => {
            if (blob) resolve(blob)
            else reject(new Error(`無法建立第 ${i + 1} 段圖片`))
          },
          'image/webp',  // WebP 高品質，比 PNG 小但字跡仍清晰
          0.92
        )
      })
      
      results.push(segmentBlob)
      console.log(`   ✂️ 段落 ${i + 1}/${segments}: Y=${startY}-${endY} (${actualHeight}px), ${Math.round(segmentBlob.size / 1024)}KB (WebP)`)
    }
    
    bitmap.close()
    return results
  } catch (error) {
    console.error('❌ [分頁批改] 拆分圖片失敗:', error)
    // 拆分失敗，返回原圖
    return [imageBlob]
  }
}

/**
 * 合併多個段落的批改結果
 * 選擇策略：可用答案 > score > confidence
 */
function mergeGradingResults(results: GradingResult[], answerKey?: AnswerKey): GradingResult {
  const allDetails: GradingResult['details'] = []
  const allMistakes: GradingResult['mistakes'] = []
  const allWeaknesses: string[] = []
  const allSuggestions: string[] = []
  const allFeedback: string[] = []
  const allReviewReasons: string[] = []
  
  for (const result of results) {
    if (result.details) {
      allDetails.push(...result.details)
    }
    if (result.mistakes) {
      allMistakes.push(...result.mistakes)
    }
    if (result.weaknesses) {
      allWeaknesses.push(...result.weaknesses)
    }
    if (result.suggestions) {
      allSuggestions.push(...result.suggestions)
    }
    if (result.feedback) {
      allFeedback.push(...result.feedback)
    }
    if (result.reviewReasons) {
      allReviewReasons.push(...result.reviewReasons)
    }
  }
  
  // 去除重複的 details（以 questionId 為 key）
  // 選擇策略：可用答案 > confidence > score
  const detailsMap = new Map<string, typeof allDetails[0]>()
  
  const isUsableAnswer = (ans?: string) => {
    const a = (ans ?? '').trim()
    return a !== '' && a !== '未作答' && a !== '無法辨識' && a !== '未作答/無法辨識'
  }
  
  for (const detail of allDetails) {
    const qid = detail.questionId ?? ''
    if (!qid) continue
    
    const existing = detailsMap.get(qid)
    if (!existing) {
      detailsMap.set(qid, detail)
      continue
    }
    
    // 比較優先級：可用答案 > confidence > score
    const existingUsable = isUsableAnswer(existing.studentAnswer)
    const newUsable = isUsableAnswer(detail.studentAnswer)
    
    // 1. 可用答案優先
    if (newUsable && !existingUsable) {
      detailsMap.set(qid, detail)
      continue
    }
    if (existingUsable && !newUsable) {
      continue
    }
    
    // 2. score 優先（跟 AnswerKey 對到的訊號更可靠）
    const existingScore = existing.score ?? 0
    const newScore = detail.score ?? 0
    if (newScore > existingScore) {
      detailsMap.set(qid, detail)
      continue
    }
    if (existingScore > newScore) {
      continue
    }
    
    // 3. confidence 作為 tie-break
    if ((detail.confidence ?? 0) > (existing.confidence ?? 0)) {
      detailsMap.set(qid, detail)
    }
  }
  
  let mergedDetails = Array.from(detailsMap.values())
  
  // 去重工具函數
  const uniqueBy = <T>(arr: T[], key: (x: T) => string) => {
    const seen = new Set<string>()
    return arr.filter((x) => {
      const k = key(x)
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  }
  
  // 去重
  const uniqueWeaknesses = [...new Set(allWeaknesses)]
  const uniqueSuggestions = [...new Set(allSuggestions)]
  const uniqueMistakes = allMistakes.length > 0
    ? uniqueBy(allMistakes, m => `${m.id ?? ''}:${m.reason ?? ''}`)
    : []
  const uniqueReviewReasons = [...new Set(allReviewReasons)]
  
  // 如果有 AnswerKey，按題號順序排序
  if (answerKey && mergedDetails.length > 0) {
    const order = new Map(answerKey.questions.map((q, i) => [q.id, i]))
    mergedDetails.sort((a, b) => {
      const ai = order.get(a.questionId ?? '') ?? 9999
      const bi = order.get(b.questionId ?? '') ?? 9999
      return ai - bi
    })
  }
  
  const totalScore = parseFloat(mergedDetails.reduce((sum, d) => sum + (d.score ?? 0), 0).toFixed(1))
  
  const merged: GradingResult = {
    totalScore,
    details: mergedDetails,
    mistakes: uniqueMistakes.length > 0 ? uniqueMistakes : [],
    weaknesses: uniqueWeaknesses,
    suggestions: uniqueSuggestions,
    feedback: allFeedback.length > 0 ? allFeedback : undefined,
    needsReview: uniqueReviewReasons.length > 0 || results.some(r => r.needsReview),
    reviewReasons: uniqueReviewReasons.length > 0 ? uniqueReviewReasons : undefined
  }
  
  // 🆕 如果 mistakes 為空但有錯誤題目，從 details 生成 mistakes
  if (merged.mistakes.length === 0 && mergedDetails.length > 0) {
    const wrongDetails = mergedDetails.filter(d => d.isCorrect === false && d.studentAnswer !== '未作答')
    if (wrongDetails.length > 0) {
      merged.mistakes = wrongDetails.map(d => ({
        id: d.questionId ?? '',
        question: `題目 ${d.questionId}`,
        reason: d.reason || '答案錯誤'
      }))
    }
  }
  
  // 如果有 AnswerKey，檢查是否有遺漏的題目
  if (answerKey) {
    const answeredIds = new Set(mergedDetails.map(d => d.questionId))
    const missingIds = answerKey.questions
      .map(q => q.id)
      .filter(id => !answeredIds.has(id))
    
    if (missingIds.length > 0) {
      merged.needsReview = true
      merged.reviewReasons = [
        ...(merged.reviewReasons ?? []),
        `分頁批改後仍有 ${missingIds.length} 題未批改: ${missingIds.join(', ')}`
      ]
    }
  }
  
  return merged
}

/**
 * 並行處理工具：限制同時執行數量
 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let currentIndex = 0
  
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (currentIndex < items.length) {
      const index = currentIndex++
      results[index] = await fn(items[index], index)
    }
  })
  
  await Promise.all(workers)
  return results
}

/**
 * 分頁批改：將大圖片拆分後並行批改（不問題號，直接批全題）
 */
async function gradeSubmissionPaged(
  submissionImage: Blob,
  answerKeyImage: Blob | null,
  answerKey: AnswerKey,
  options?: GradeSubmissionOptions
): Promise<GradingResult> {
  const totalStartTime = performance.now()
  console.log(`📄 [分頁批改] 開始分頁批改流程...`)
  
  // 🆕 設置 AnswerKey 緩存（多個段落共用同一份 AnswerKey）
  // 只有當緩存尚未設置時才設置（避免覆蓋批量批改已設置的緩存）
  const shouldSetCache = !cachedAnswerKeyHash && !cachedAnswerKeyJson
  if (shouldSetCache) {
    setAnswerKeyCache(answerKey)
    console.log('📦 [AnswerKey] 已設置分頁批改緩存')
  }
  
  // Step 1: 拆分圖片
  const splitStartTime = performance.now()
  const segments = await splitImageIntoSegments(submissionImage)
  const splitTime = performance.now() - splitStartTime
  console.log(`   ⏱️ 圖片拆分耗時: ${splitTime.toFixed(0)}ms`)
  
  if (segments.length === 1) {
    console.log(`📄 [分頁批改] 無需拆分，使用標準批改流程`)
    return gradeSubmissionCore(submissionImage, answerKeyImage, answerKey, {
      ...options,
      _skipPagedGrading: true
    })
  }

  // 🆕 Step 2: 預取機制 - 預先準備圖片（壓縮 + base64）
  // 使用 Map 緩存 Promise，避免重複準備
  const preparedSegments = new Map<number, Promise<{ blob: Blob; base64: string; mimeType: string }>>()
  
  const prepareSegment = async (index: number) => {
    const segmentBlob = segments[index]
    const prepStartTime = performance.now()
    
    // 壓縮
    const prepared = await compressForGemini(segmentBlob, GEMINI_SINGLE_IMAGE_TARGET_BYTES, `段落${index + 1}`)
    // Base64 編碼
    const base64 = await blobToBase64(prepared)
    const mimeType = prepared.type || 'image/jpeg'
    
    const prepTime = performance.now() - prepStartTime
    console.log(`      🔧 段落 ${index + 1} 預處理完成 (${prepTime.toFixed(0)}ms, ${(prepared.size / 1024).toFixed(0)}KB)`)
    
    return { blob: prepared, base64, mimeType }
  }
  
  // 獲取預處理的段落（如果沒有則啟動）
  const getPreparedSegment = (index: number) => {
    if (!preparedSegments.has(index)) {
      preparedSegments.set(index, prepareSegment(index))
    }
    return preparedSegments.get(index)!
  }
  
  // 預取函數：預熱後續 N 個段落
  const prefetchAhead = (currentIndex: number, count: number = 2) => {
    for (let i = 1; i <= count; i++) {
      const nextIndex = currentIndex + i
      if (nextIndex < segments.length && !preparedSegments.has(nextIndex)) {
        console.log(`      📦 預取段落 ${nextIndex + 1}...`)
        preparedSegments.set(nextIndex, prepareSegment(nextIndex))
      }
    }
  }
  
  // Step 3: 並行批改（使用預取機制）
  console.log(`📄 [分頁批改] 並行批改 ${segments.length} 段 (concurrency=${PAGED_GRADING_CONCURRENCY}, 預取模式)...`)
  const gradeStartTime = performance.now()
  
  // 立即預取前 PAGED_GRADING_CONCURRENCY + 1 個段落
  for (let i = 0; i < Math.min(segments.length, PAGED_GRADING_CONCURRENCY + 1); i++) {
    getPreparedSegment(i)
  }
  
  const results = await mapLimit(segments, PAGED_GRADING_CONCURRENCY, async (_, i) => {
    const segmentStartTime = performance.now()
    console.log(`   📄 段落 ${i + 1}/${segments.length} 開始批改...`)
    
    // 🆕 觸發預取下一批段落（在 API 調用期間準備）
    prefetchAhead(i, PAGED_GRADING_CONCURRENCY)
    
    try {
      // 🆕 等待預處理完成（通常已經完成了）
      const waitStartTime = performance.now()
      const { blob: preparedBlob, base64, mimeType } = await getPreparedSegment(i)
      const waitTime = performance.now() - waitStartTime
      if (waitTime > 10) {
        console.log(`      ⏳ 等待預處理: ${waitTime.toFixed(0)}ms`)
      }
      
      // 直接用預處理好的圖片進行批改
      const result = await gradeSubmissionCoreWithPreparedImage(
        preparedBlob,
        base64,
        mimeType,
        null,
        answerKey,
        {
          ...options,
          _skipPagedGrading: true,
          _isPartialImage: true
        }
      )
      
      const segmentTime = performance.now() - segmentStartTime
      const answeredCount = result.details?.filter(d => 
        d.studentAnswer && d.studentAnswer !== '未作答' && d.studentAnswer !== '無法辨識'
      ).length ?? 0
      console.log(`   ✅ 段落 ${i + 1} 完成，識別 ${answeredCount} 題，耗時 ${segmentTime.toFixed(0)}ms`)
      
      return result
    } catch (error) {
      const segmentTime = performance.now() - segmentStartTime
      console.error(`   ❌ 段落 ${i + 1} 失敗 (耗時 ${segmentTime.toFixed(0)}ms):`, error)
      return {
        totalScore: 0,
        mistakes: [],
        weaknesses: [],
        suggestions: [],
        feedback: [`段落 ${i + 1} 批改失敗: ${(error as Error).message}`],
        needsReview: true,
        reviewReasons: [`段落 ${i + 1} 批改失敗`]
      } as GradingResult
    }
  })
  
  const gradeTime = performance.now() - gradeStartTime
  console.log(`   ⏱️ 全部段落批改耗時: ${gradeTime.toFixed(0)}ms`)
  
  // Step 4: 合併結果
  const mergeStartTime = performance.now()
  const merged = mergeGradingResults(results, answerKey)
  const mergeTime = performance.now() - mergeStartTime

  // Step 5: 分頁模式在合併後才做一次 locate（避免片段座標失真）
  const locateTargetIds = getLocateTargetQuestionIds(merged.details)
  if (locateTargetIds.length > 0) {
    const locateStartTime = performance.now()
    try {
      const preparedForLocate = await compressForGemini(
        submissionImage,
        GEMINI_SINGLE_IMAGE_TARGET_BYTES,
        '作業定位'
      )
      const locateBase64 = await blobToBase64(preparedForLocate)
      const locateMimeType = preparedForLocate.type || 'image/jpeg'
      await enrichWrongDetailBboxesWithLocate(
        merged,
        locateBase64,
        locateMimeType,
        '   ',
        locateTargetIds
      )
      const locateTime = performance.now() - locateStartTime
      console.log(`   ⏱️ 定位補框耗時: ${locateTime.toFixed(0)}ms`)
    } catch (error) {
      console.warn('   ⚠️ 分頁合併後 locate 失敗，略過不影響批改:', error)
    }
  }
  
  const totalTime = performance.now() - totalStartTime
  console.log(`📄 [分頁批改] 完成！總分: ${merged.totalScore}，共 ${merged.details?.length ?? 0} 題`)
  console.log(`   ⏱️ 總耗時: ${totalTime.toFixed(0)}ms (拆分=${splitTime.toFixed(0)}ms, 批改=${gradeTime.toFixed(0)}ms, 合併=${mergeTime.toFixed(0)}ms)`)
  
  // 🆕 如果是我們設置的緩存，則清除
  if (shouldSetCache) {
    clearAnswerKeyCache()
  }
  
  return merged
}

/**
 * 🆕 使用已預處理圖片的批改核心（跳過壓縮和 base64 步驟）
 * 直接調用 gradeSubmissionCore，但傳入預處理選項
 */
async function gradeSubmissionCoreWithPreparedImage(
  preparedImage: Blob,
  imageBase64: string,
  imageMimeType: string,
  answerKeyImage: Blob | null,
  answerKey?: AnswerKey,
  options?: GradeSubmissionOptions
): Promise<GradingResult> {
  // 直接調用核心邏輯，但傳入預處理好的資料
  return await gradeSubmissionCore(preparedImage, answerKeyImage, answerKey, {
    ...options,
    _preparedImage: {
      base64: imageBase64,
      mimeType: imageMimeType
    }
  })
}

/**
 * 單份作業批改入口（自動判斷是否使用分頁批改）
 * 
 * ❗ 注意：Ink session 由「批改頁面」統一管理（mount 時 start，unmount 時 close）
 *    這裡不負責 start/close，只確保有 session 時會自動帶入 sessionId
 */
export async function gradeSubmission(
  submissionImage: Blob,
  answerKeyImage: Blob | null,
  answerKey?: AnswerKey,
  options?: GradeSubmissionOptions
): Promise<GradingResult> {
  if (!isGeminiAvailable) throw new Error('Gemini 服務未設定')

  // 判斷是否應該使用分頁批改（使用高寬比而非檔案大小）
  if (ENABLE_PAGED_GRADING && !options?._skipPagedGrading) {
    const imageInfo = await isMultiPageImage(submissionImage)
    
    if (imageInfo.isMultiPage) {
      // 有 AnswerKey JSON 才能分頁（圖片模式不支援）
      if (answerKey && !answerKeyImage) {
        console.log(`📄 [分頁批改] 偵測到多頁圖片 (${imageInfo.width}x${imageInfo.height}px, 高寬比=${imageInfo.aspectRatio.toFixed(2)})，啟用分頁批改`)
        return await gradeSubmissionPaged(submissionImage, answerKeyImage, answerKey, options)
      } else if (answerKeyImage) {
        // answerKeyImage 模式不支援分頁，發出警告但繼續標準批改
        console.warn(`⚠️ [分頁批改] 偵測到多頁圖片，但使用「答案卷圖片」模式無法分頁批改。建議：改用 AnswerKey JSON 模式以獲得更好的批改效果。`)
      }
    }
  }
  
  return await gradeSubmissionCore(submissionImage, answerKeyImage, answerKey, options)
}

/**
 * 單份作業批改核心邏輯（支援 AnswerKey 與答案卷圖片）
 */
async function gradeSubmissionCore(
  submissionImage: Blob,
  answerKeyImage: Blob | null,
  answerKey?: AnswerKey,
  options?: GradeSubmissionOptions
): Promise<GradingResult> {
  const isPartial = options?._isPartialImage === true
  const logPrefix = isPartial ? '      ' : ''  // 分頁段落縮排
  
  try {
    console.log(`${logPrefix}🧠 使用模型 ${currentModelName} 進行批改...`)

    // 🆕 檢查是否有預處理好的圖片
    let submissionBase64: string
    let submissionMimeType: string
    let compressTime = 0
    let base64Time = 0

    if (options?._preparedImage) {
      // 使用預處理好的圖片（跳過壓縮和 base64 步驟）
      console.log(`${logPrefix}   ✨ 使用預處理圖片`)
      submissionBase64 = options._preparedImage.base64
      submissionMimeType = options._preparedImage.mimeType
    } else {
      // 標準流程：壓縮和 base64 編碼
      const compressStartTime = performance.now()
      const hasAnswerKeyImage = Boolean(answerKeyImage)
      const submissionTarget = hasAnswerKeyImage
        ? GEMINI_DUAL_IMAGE_TARGET_BYTES
        : GEMINI_SINGLE_IMAGE_TARGET_BYTES
      const preparedSubmissionImage = await compressForGemini(
        submissionImage,
        submissionTarget,
        '作業'
      )
      compressTime = performance.now() - compressStartTime

      const base64StartTime = performance.now()
      submissionBase64 = await blobToBase64(preparedSubmissionImage)
      base64Time = performance.now() - base64StartTime
      submissionMimeType = preparedSubmissionImage.type || 'image/jpeg'
    }

    const requestParts: GeminiRequestPart[] = []
    const promptSections: string[] = []

    promptSections.push(
      `
你是一位嚴謹、公正的老師，負責批改學生的紙本作業。
本系統會用在各種科目（例如：國語、英文、數學、自然、社會等），
請主要根據「題目文字」與「標準答案」來判斷對錯，不要憑常識亂猜。
`.trim()
    )

    if (answerKey) {
      const questionIds = answerKey.questions.map((q) => q.id).join(', ')
      
      // 判斷是否為分頁批改的部分圖片
      const isPartialImage = options?._isPartialImage === true
      const partialImageHint = isPartialImage
        ? `
⚠️ 【分頁批改模式】
這張圖片是多頁作業拆分後的其中一段，可能只包含部分題目。
- 只批改你在這張圖片中實際看到的題目，看不到的題號請不要輸出
- 如果某題號在圖片中完全看不到（沒有題目也沒有作答區域），則不輸出該題
- 這不是遺漏，而是該題在其他分頁中
`
        : ''
      
      promptSections.push(
        `
下面是本次作業的標準答案與配分（JSON 格式）：
${JSON.stringify(answerKey)}

【批改流程】
請嚴格依照這份 AnswerKey 逐題批改，請注意「擷取」與「給分」是兩個獨立的步驟：
${partialImageHint}
- ${isPartialImage ? '輸出你在這張圖片中實際看到的題號（可能不是全部）' : `必須輸出所有題號：${questionIds}（共 ${answerKey.questions.length} 題）`}
${isPartialImage
  ? `- 🚨 重要：只要「題目或作答區在本圖片中可見」，即使未作答/空白/無法辨識，也必須輸出該題記錄
- 若題號/題幹/作答區在本圖片完全不可見：不要輸出該題`
  : `- 🚨 重要：即使學生未作答、空白、或無法辨識，也必須輸出該題的記錄`}
  ⚠️ 但「輸出記錄」≠「生成答案」！
  - ✅ 正確：學生空白 → 輸出 {"questionId": "1", "studentAnswer": "未作答", "score": 0, ...}
  - ❌ 錯誤：學生空白 → 腦補答案並輸出 {"questionId": "1", "studentAnswer": "台北", "score": 0, ...}
  - 空白就是空白，必須如實記錄「未作答」，不可腦補任何內容！
- 題號 id 以 AnswerKey 中的 "id" 為主（例如 "1", "1-1"）。

【步驟 1：擷取（嚴格）】
🚨 最高原則：只抄寫圖片中看得到的筆跡，禁止腦補！
- 無論字跡多潦草或有錯別字，studentAnswer 必須原樣保留學生筆跡與錯誤
- 例如學生寫「苹菓」，就輸出「苹菓」，不可改成「蘋果」
- ⚠️ 學生空白 → 必須輸出「未作答」，絕對不可腦補答案

【步驟 2：給分（寬容）】
- 判斷 isCorrect 時：若包含正確關鍵字，即使字跡不完美或有輕微錯別字，仍可視情況判定為正確
- ⚠️ 重要：寬容只影響 isCorrect/score/reason；不得影響 studentAnswer（studentAnswer 永遠原樣抄寫）

【分層評分規則（依 questionCategory）】
- single_choice / true_false / fill_blank / single_check（精確）：使用 answer 字段嚴格對比。完全相符 → 滿分；不符 → 0分
  - fill_blank 單位規則：若 answer 含單位（如「15 公分」），學生答案的單位必須完全相同。公尺 ≠ 公分，errorType='unit'。不接受「等效單位」替換。
- multi_choice / multi_check（部分給分）：answer 字段含逗號分隔的正確選項集合（如 "A,C" 或 "①,③"）。
  - 學生答案也為逗號分隔的選項集合，順序無關。
  - correct = 學生選中 ∩ 正確集合；wrong = 學生選中 − 正確集合
  - score = max(0, round((|correct| − |wrong|) / |正確集合| × maxScore))
  - isCorrect = (score === maxScore)
- 連連看（answerFormat="matching"）：若 answerFormat="matching" 或 answer 形如「左項=右項」：
  - studentAnswer 必須輸出相同格式：左項=右項1,右項2; 左項2=右項3
  - 左項目固定，不可交換左右
  - 同一左項目多個右項目用逗號/頓號分隔
  - 右側順序不影響判斷
- fill_variants / map_fill（多元）：使用 acceptableAnswers 進行語義匹配。完全/語義相符 → 滿分；部分 → 部分分
  - 字音造詞題：若 referenceAnswer 含讀音說明（如「ㄋㄨㄥˋ讀音」），學生答案必須符合該讀音；讀音錯誤直接 0 分
- word_problem / short_answer / map_symbol / grid_geometry / connect_dots（評價）：使用 rubricsDimensions 多維度評分，逐維度累計總分
  - short_answer 必須使用 rubricsDimensions（至少兩維：作答依據、結論表達），不可退回 rubric 四級評量
  - word_problem 單位規則：「答句」維度中，若正解含單位，學生答句的單位必須正確。公尺 ≠ 公分，errorType='unit'。
  - ⚠️ 多維度評分時，每個維度的評分標準不同：
    - 「引導/選擇」維度（如：步驟一選擇面向）：看「是否完成」而非「是否正確」，只要學生有做選擇就給分
    - 「主要作答」維度（如：步驟二具體內容）：依據 criteria 判斷內容品質並給分
  - 整題的 isCorrect 判斷：以「主要作答」維度為準，不因「引導階段」未完成而判為錯誤
- 若題目有 orderMode="unordered" 且同組 unorderedGroupId 相同：
  - 該組子題必須做「集合配對」評分，不可用固定位置（例如 1-1 只能對 1-1）
  - 只要該組答案集合一致，即可判定為正確（同組內位置可互換）
`.trim()
      )
    } else if (answerKeyImage) {
      const preparedAnswerKeyImage = await compressForGemini(
        answerKeyImage,
        GEMINI_DUAL_IMAGE_TARGET_BYTES,
        '標準答案'
      )
      const answerKeyBase64 = await blobToBase64(preparedAnswerKeyImage)
      const answerKeyMimeType = preparedAnswerKeyImage.type || 'image/jpeg'
      promptSections.push(
        `
第一張圖片是「標準答案／解答本」，第二張圖片是「學生作業」。
請先從標準答案圖片中，為每一題抽取「題號、正確答案、配分（可以合理估計）」，
再根據這些標準答案來批改學生作業。
請不要憑空新增題目，也不要改變題號。

【答案卷識別提示】
⚠️ 教師或書商常用「與題目印刷顏色不同的筆」（如紅筆、藍筆）來標示範例答案
- 優先提取這些與印刷文字顏色不同的手寫筆跡作為標準答案
- 判斷依據：顏色對比、位置（答題區/空格/方框內）、筆觸特徵（手寫 vs 印刷）
`.trim()
      )
      requestParts.push({
        inlineData: { mimeType: answerKeyMimeType, data: answerKeyBase64 }
      })
    } else {
      promptSections.push(
        `
目前沒有提供標準答案，只有學生作業圖片。
請執行以下步驟：
1. 先盡量辨識圖片中的「學生原始筆跡」，填入 studentAnswer（不可修改學生內容；不可摘要/不可改寫/不可補全）。
2. 如需保守推測題意或合理答案，只能寫在 reason（或 mistakes/weaknesses/suggestions），不得寫進 studentAnswer。
`.trim()
      )
    }

    const domainHint = buildGradingDomainSection(options?.domain)
    if (domainHint && options?.domain) {
      promptSections.push(`【${options.domain} 批改要點】\n${domainHint}`.trim())
    }

    // 🆕 分頁批改模式：使用精簡版規則
    const isPartialForRules = options?._isPartialImage === true

    if (isPartialForRules) {
      // ============================================
      // 分頁批改精簡版規則（大幅減少 token 數）
      // ============================================
      promptSections.push(
        `
【分頁批改精簡規則】
⚠️ 核心規則（必須遵守）：
1. studentAnswer 只抄寫圖片中看得到的學生筆跡，禁止腦補或修正
2. 填寫區域無筆跡 → 輸出「未作答」
3. 只輸出本段圖片中看得到的題號（看不到的題目不輸出）
4. reason 簡短說明即可（錯誤題必填：概念誤解/計算錯誤/未作答 等）

回傳純 JSON（只需 details）：
{
  "details": [
    {
      "questionId": "題號",
      "studentAnswer": "學生答案（原樣抄寫）",
      "isCorrect": true/false,
      "score": 得分,
      "maxScore": 滿分,
      "confidence": 0-100,
      "reason": "簡短說明"
    }
  ]
}
`.trim()
      )
    } else {
      // ============================================
      // 完整版規則（非分頁模式）
      // ============================================

    if (options?.regrade?.questionIds?.length) {
      const questionIds = options.regrade.questionIds
      const previousDetails = options.regrade.previousDetails ?? []
      const forcedIds = options.regrade.forceUnrecognizableQuestionIds ?? []
      const mode = options.regrade.mode || 'correction'

      if (mode === 'correction') {
        // 人工修正模式：部分題目被標記錯誤
        const markedQuestionsInfo = previousDetails
          .filter((detail) => detail?.questionId && questionIds.includes(detail.questionId))
          .map(
            (detail) =>
              `- 題號 ${detail.questionId}：你之前輸出「${detail?.studentAnswer ?? ''}」（已被老師標記為錯誤）`
          )
          .join('\n')

        const otherQuestionsInfo = previousDetails
          .filter((detail) => detail?.questionId && !questionIds.includes(detail.questionId))
          .map((detail) => `- 題號 ${detail.questionId}：「${detail?.studentAnswer ?? ''}」`)
          .join('\n')

        promptSections.push(
          `
【人工修正模式 - 部分題目需重新檢視】

🔴 以下 ${questionIds.length} 題已被老師標記為錯誤，需要重新仔細檢視圖片：
${markedQuestionsInfo || `題號：${questionIds.join(', ')}`}

✅ 以下題目批改正確，直接使用之前的結果（不要重新批改）：
${otherQuestionsInfo || '（無其他題目）'}

重新批改要求：
1. 標記錯誤的題目：完全忘記之前的判斷，重新從圖片仔細檢視
   - 仔細確認學生筆跡的每一筆畫
   - 確認題目要求（例如：考國字還是注音、選擇題要看打勾位置）
   - 不要再給出和之前一樣的答案（除非你非常確定之前是對的）

2. 其他題目：直接照抄之前的 studentAnswer，不需要重新辨識

3. 必須輸出所有題目（包括正確的和標記錯誤的）

⚠️ 重新批改 ≠ 優化答案
- 「重新檢視」= 重新看圖片上「實際寫了什麼字」，而非「重新理解學生想表達什麼」
- 即使重新批改，studentAnswer 仍必須逐字逐畫對應圖片中的學生筆跡
- 禁止為了「修正錯誤」而優化、補全、或改寫學生答案
- 例如：學生寫「不要讓媽媽著涼」→ 即使第一次漏抓「不」字，重新批改也只能輸出圖片上看得到的文字，不可腦補成「幫媽媽準備壁爐」

❌ 嚴禁：
- 對於標記錯誤的題目：輸出和之前完全相同的內容（這代表你沒有重新思考）
- 對於標記錯誤的題目：為了「合理化」而改寫學生答案（例如：把「不要」改成「要」或腦補成其他內容）
- 對於正確的題目：改動之前的 studentAnswer（這些題目不需要重新批改）
`.trim()
        )
      } else if (mode === 'missing') {
        // 自動補漏模式：第一次完全遺漏的題目
        promptSections.push(
          `
【補漏模式 - AI遺漏題目重新辨識】
第一次批改時你遺漏了以下題目，現在請補上：${questionIds.join(', ')}

要求：
1. 只輸出這 ${questionIds.length} 題（其他題目已經批改過了）
2. 每題都必須有 studentAnswer（即使是「未作答」或「無法辨識」）
3. 不要輸出其他題號

⚠️ 重要：補漏 ≠ 優化答案
- studentAnswer 必須逐字逐畫對應圖片中的學生筆跡，不可優化、補全、或改寫
- 辨識的是「圖片上實際寫了什麼」，而非「學生想表達什麼」
`.trim()
        )
      }

      // 強制無法辨識（優先級最高）
      if (forcedIds.length > 0) {
        promptSections.push(
          `
【強制標記】
以下題目圖片品質太差或筆跡無法辨識，請直接輸出：
${forcedIds.map((id) => `- 題號 ${id}：studentAnswer="無法辨識", score=0, confidence=0`).join('\n')}
`.trim()
        )
      }
    }

    const recentCorrections = await getRecentAnswerExtractionCorrections(options?.domain, 5)
    if (recentCorrections.length > 0) {
      const lines = recentCorrections
        .map((item) => {
          const aiAnswer = item.aiStudentAnswer || '—'
          return `- 題目 ${item.questionId}：AI「${aiAnswer}」→ 正確「${item.correctedStudentAnswer}」`
        })
        .join('\n')

      promptSections.push(`【近期 AI 擷取錯誤參考】\n${lines}`.trim())
    }

    if (options?.strict) {
      promptSections.push(
        `
【嚴謹模式】
- 若題意、字跡或答案不清楚，請判為不給分，並在 reason 說明原因
- 不要推測或補寫；只根據題目文字與標準答案判斷
- 答案不完整或缺少關鍵字/數值時，視為錯誤
- 請再次檢查每題得分與 totalScore 是否一致
`.trim()
      )
    }

    promptSections.push(
      `
【學生答案擷取規則（機械式抄寫）】
核心原則：像 OCR 機器一樣原樣輸出，禁止任何形式的修正或推測。

✅ DO
- 學生寫「光和作用」→ 輸出「光和作用」
- 學生寫「辯別」（錯字）→ 輸出「辯別」（不修正）
- 學生寫「台北」→ 輸出「台北」（不改成「臺北」）
- 學生只填「光合」→ 輸出「光合」（不補全為「光合作用」）
- 筆跡模糊但可辨「光舎」→ 輸出「光舎」（不改成「光合」）

❌ DON'T
- 禁止依上下文推測缺字
- 禁止修正錯字
- 禁止補全答案
- 禁止同義替換
- 禁止為了「合理化」而改寫學生答案
  - 例如：學生寫「不要讓媽媽著涼」，即使漏抓了「不」字，也不可腦補成「幫媽媽準備壁爐」
  - 重新檢視 = 重新看圖片上實際寫了什麼字，而非重新理解學生想表達什麼

🔍 唯一例外
- 完全無法辨識的字跡（墨水塗抹、筆劃模糊）→ 用「[?]」標記
- 例：「光[?]作用」
`.trim()
    )

    promptSections.push(
      `
【空白答案處理（最高優先級：絕對禁止臆測）】
⚠️ 核心原則：學生漏寫 = 未作答，不可腦補！

✅ 正確處理
- 完全未作答（空白方格/空白行）→ 輸出「未作答」
- 只寫了部分 → 輸出可見部分（不補全）
- 無意義符號（如 ???）→ 原樣輸出

❌ 嚴格禁止
- 禁止為空白生成任何內容
- 禁止推測「學生可能想寫什麼」
- 禁止依據題目、標準答案、或常識來補全空白
- 禁止因為「這題很簡單」就腦補答案
- 禁止因為「其他學生都會寫」就腦補答案

🚨 常見錯誤範例（絕對禁止）
填空題：
- 題目問「1+1=?」，學生空白 → ❌ 不可輸出「2」，必須輸出「未作答」
- 題目問「台灣首都」，學生空白 → ❌ 不可輸出「台北」，必須輸出「未作答」
- 造詞題空白 → ❌ 不可依據讀音或部首腦補詞語，必須輸出「未作答」

勾選題（最容易誤判！）：
🚨 關鍵：只看「方框□內」是否有標記，不要被題目的其他符號誤導！

- 題目：「□A ↑  □B ↖  □C →  □D ↓」，四個方框內都沒有打勾/圈選/劃記
  → ❌ 不可腦補「A」或任何選項，必須輸出「未作答」
  → ❌ 箭頭（↑ ↖ → ↓）是題目的一部分，不是學生的作答標記！

- 題目：「□ A. 亞洲  □ B. 歐洲  □ C. 非洲」，三個方框內都是空的
  → ❌ 不可腦補選項，必須輸出「未作答」
  → ❌ 選項文字（A. 亞洲）是題目的一部分，不是學生的作答！

判斷標準（嚴格執行）：
  - ✅ 正確：方框□內有打勾 ✓、圈選 ○、劃記 ×、填滿 ■ → 輸出該選項（如「A」「B」）
  - ✅ 正確：方框□內完全空白，沒有任何標記 → 輸出「未作答」
  - ❌ 錯誤：看到箭頭（↑ ↖ → ↓）就以為有作答 → 箭頭是題目的一部分！
  - ❌ 錯誤：看到選項文字（A、B、亞洲、歐洲）就以為有作答 → 選項文字是題目的一部分！
  - ⚠️ 即使根據題目和答案可以推測出正確選項，也不可腦補！

檢查重點：
  1. 只關注「方框□內部」是否有學生的筆跡標記
  2. 箭頭、選項編號、選項文字都不算學生作答
  3. 如果方框內是空白的 = 未作答

繪圖題：
- 題目：「在地圖上標註颱風位置」，圖上完全沒有任何手繪標記/符號/筆跡
  → ❌ 不可腦補「已標註在某位置」，必須輸出「未作答」
- 題目：「畫出三角形」，圖上沒有任何三角形或線條
  → ❌ 不可腦補「已畫三角形」，必須輸出「未作答」
- 判斷標準：
  - 圖上有手繪標記/符號/線條 → 描述學生實際畫了什麼
  - 圖上完全沒有任何手繪痕跡 → 輸出「未作答」
  - ⚠️ 即使圖片本身有印刷內容（地圖、座標軸等），只要沒有學生手繪標記，就是未作答！

判斷標準（嚴格執行）：
- 填寫區域有筆跡 → 抄寫筆跡內容
- 填寫區域無筆跡/完全空白 → 輸出「未作答」（不可有任何其他內容）
- 有筆跡但完全看不出是什麼 → 輸出「無法辨識」
- 勾選題：方框□內沒有標記（即使有箭頭等符號）→ 輸出「未作答」
- 繪圖題：圖上沒有手繪痕跡（即使有印刷內容）→ 輸出「未作答」

⚠️ 驗證方法：如果你輸出的 studentAnswer 無法在圖片中找到對應的學生筆跡，那就是腦補！
`.trim()
    )

    promptSections.push(
      `
【低成就學生答案處理】
核心原則：保真 > 優化，寧可記錄錯誤，不可美化答案

✅ 正確
- 原樣輸出，不擴寫、不書面化、不補完、不修正
`.trim()
    )

    promptSections.push(
      `
【每題獨立判斷原則（防止連鎖腦補）】
🚨 嚴重警告：前一題的判斷不可影響後續題目！

核心原則：
- 每題都必須獨立從圖片辨識，不受其他題目影響
- 前一題有內容 ≠ 後一題也該有內容
- 前一題空白 ≠ 後一題也該空白
- 每題的 studentAnswer 都必須能在圖片中獨立找到對應的學生筆跡

🚨 常見連鎖腦補錯誤（絕對禁止）
- 第1題腦補了「光合作用」→ 第2題也跟著腦補 ❌
- 第1題有寫答案 → 推測第2題「應該也有寫」而腦補 ❌
- 看到標準答案有5題 → 強迫自己為每題都生成內容 ❌
- 題組中前幾題有答案 → 推測後面的題目「不可能空白」而腦補 ❌

✅ 正確做法
- 第1題：圖片有筆跡 → 輸出筆跡內容
- 第2題：圖片無筆跡 → 輸出「未作答」（即使第1題有寫）
- 第3題：圖片有筆跡 → 輸出筆跡內容（即使第2題空白）
- 獨立判斷，互不影響

⚠️ 自我檢查：批改完成後，檢查是否有「連續多題都有內容，沒有任何未作答」的情況。
如果出現這種情況，很可能是發生了連鎖腦補，請重新逐題檢視圖片。
`.trim()
    )

    promptSections.push(
      `
【單題擷取信心率（0-100）】
- 定義：只反映「擷取時的猶豫程度」（字跡清晰度），與答案正確性無關
- 100：唯一解釋，不需推測
- 80-99：小雜訊但可排除
- 60-79：有兩個以上候選，需要比筆劃
- 0-59：幾乎在猜

常見誤區：
- ❌ 看到錯字就給低信心
- ✅ 字很清楚但答案錯，也應給高信心
`.trim()
    )

    promptSections.push(
      `
【reason 欄位生成規範（錯誤題必填）】
🚨 嚴格禁止以下無效敘述：
- ❌「學生選 A，但正確答案是 B」
- ❌「答案與正確解答不符」
- ❌「因此作答錯誤」
- ❌「學生答案為 X，標準答案為 Y」
- ❌ 僅重述答案對錯，未分析錯誤原因

若 reason 僅比較答案而無思考分析 → 視為「無效輸出」，必須重新生成。

✅ 必要內容（錯誤題的 reason 至少包含一項）：
1. 概念誤解（misconception）— 學生對某概念的理解偏差
2. 解題流程或推理步驟錯誤 — 推論過程中的邏輯斷裂
3. 忽略或誤解題目條件 — 漏看關鍵字或錯誤解讀題意
4. 將不相關資訊誤當關鍵依據 — 受干擾選項影響
5. 對關鍵名詞或情境的錯誤詮釋 — 術語理解錯誤
6. 未作答 — 學生留空或無法辨識

✅ 輸出結構（請完整遵守）：
【錯誤類型】概念誤解／條件忽略／推理步驟錯誤／計算錯誤／策略選擇不當／未作答（擇一或多項）
【學生可能的思考路徑】學生可能認為……因此……（描述為何會做出此錯誤選擇）
【關鍵錯誤點】明確指出導致錯誤的那一步理解或推論

範例（正確）：
- reason: "【錯誤類型】概念誤解【學生可能的思考路徑】學生可能認為「光合作用」只發生在白天，因此選擇了「夜間不進行」【關鍵錯誤點】忽略了植物呼吸作用與光合作用的區別"

範例（錯誤 ❌）：
- reason: "學生答案是 A，但正確答案是 B" ← 無效，必須重寫

⚠️ 正確題目的 reason：
- 可簡短寫「答案正確」或留空
- 不需要詳細分析
`.trim()
    )

    promptSections.push(
      `
【最終硬規則（輸出前自我檢查）】
在輸出 JSON 之前，必須逐題檢查以下項目：

1. 筆跡對應檢查：
   - ✅ 每個 studentAnswer 都必須能在圖片中逐字逐畫對應到學生筆跡
   - ❌ 如果圖片中找不到對應筆跡 → 那就是腦補，必須改為「未作答」

2. 空白腦補檢查：
   - ✅ 填寫區域無筆跡 → 必須輸出「未作答」
   - ❌ 絕不可依據題目、標準答案、常識來為空白生成內容

3. 連鎖腦補檢查：
   - ✅ 每題獨立判斷，互不影響
   - ❌ 不可因為前一題有內容就推測後一題也該有內容
   - ⚠️ 檢查是否有「連續多題都有內容，沒有任何未作答」→ 可能是連鎖腦補

4. 修正限制：
   - ✅ 若你想「修正錯字、補全、換詞、變通語序、抓重點」→ 一律只能寫在 reason
   - ❌ 不得改動 studentAnswer

回傳純 JSON：
{
  "totalScore": 整數,
  "details": [
    {
      "questionId": 題號,
      "studentAnswer": 學生答案,
      "isCorrect": true/false,
      "score": 得分,
      "maxScore": 滿分,
      "reason": "【錯誤類型】...【學生可能的思考路徑】...【關鍵錯誤點】...",
      "confidence": 0-100,
      "matchingDetails": {Type 2: {matchedAnswer, matchType: exact|synonym|keyword}},
      "rubricScores": {Type 3: [{dimension, score, maxScore}]}
    }
  ],
  "mistakes": [{id, question, reason: "同上格式，需包含錯誤類型+思考路徑+關鍵錯誤點"}],
  "weaknesses": [概念],
  "suggestions": [建議]
}

若為「再次批改模式」，details 只回傳被要求重新批改的題號。
`.trim()
    )
    } // 結束 else（完整版規則）

    const prompt = promptSections.join('\n\n')
    requestParts.push(prompt)
    requestParts.push({
      inlineData: { mimeType: submissionMimeType, data: submissionBase64 }
    })

    // Profiling: API 請求
    const apiStartTime = performance.now()
    // 🆕 使用 AnswerKey 緩存（只在有 answerKey 且已設置緩存時啟用）
    const useAnswerKeyCache = Boolean(answerKey) && Boolean(cachedAnswerKeyJson)
    const text = (await generateGeminiText(currentModelName, requestParts, {
      useAnswerKeyCache,
      routeKey: 'grading.evaluate'
    }))
      .replace(/```json|```/g, '')
      .trim()
    const apiTime = performance.now() - apiStartTime

    // Profiling: JSON 解析
    const parseStartTime = performance.now()
    let parsed = JSON.parse(text) as GradingResult
    const parseTime = performance.now() - parseStartTime
    
    // 輸出 profiling 結果
    console.log(`${logPrefix}⏱️ 耗時: 壓縮=${compressTime.toFixed(0)}ms, base64=${base64Time.toFixed(0)}ms, API=${apiTime.toFixed(0)}ms, parse=${parseTime.toFixed(0)}ms`)

    // 硬性覆蓋：強制無法辨識的題目
    if (options?.regrade?.forceUnrecognizableQuestionIds?.length && parsed.details) {
      const forcedIds = new Set(options.regrade.forceUnrecognizableQuestionIds)
      parsed.details = parsed.details.map((detail) => {
        if (forcedIds.has(detail.questionId ?? '')) {
          return {
            ...detail,
            studentAnswer: '無法辨識',
            score: 0,
            isCorrect: false,
            confidence: 0,
            reason: '圖片品質不佳或筆跡無法辨識'
          }
        }
        return detail
      })
    }

    // 檢查：correction 模式下，被標記的題目是否真的重新思考了
    if (
      options?.regrade?.mode === 'correction' &&
      options.regrade.questionIds &&
      options.regrade.previousDetails &&
      parsed.details
    ) {
      const markedIds = new Set(options.regrade.questionIds)
      const previousMap = new Map(
        options.regrade.previousDetails.map((d) => [d.questionId, d.studentAnswer?.trim()])
      )
      const sameAnswerIds: string[] = []
      const changedOtherIds: string[] = []

      parsed.details.forEach((detail) => {
        const qid = detail.questionId ?? ''
        const prevAnswer = previousMap.get(qid)
        const currAnswer = detail.studentAnswer?.trim()

        if (markedIds.has(qid)) {
          // 被標記的題目：應該要不一樣（除非 AI 真的確定之前是對的）
          if (prevAnswer && currAnswer && prevAnswer === currAnswer) {
            sameAnswerIds.push(qid)
          }
        } else {
          // 沒被標記的題目：應該要一樣（直接照抄）
          if (prevAnswer && currAnswer && prevAnswer !== currAnswer) {
            changedOtherIds.push(qid)
          }
        }
      })

      if (sameAnswerIds.length > 0) {
        console.warn(
          `⚠️ 被標記錯誤的題目，AI 重新批改後仍給出相同答案：${sameAnswerIds.join(', ')}`
        )
        parsed.needsReview = true
        parsed.reviewReasons = [
          ...(parsed.reviewReasons ?? []),
          `標記題目 AI 答案未改變（${sameAnswerIds.join(', ')}），可能需人工介入`
        ]
      }

      if (changedOtherIds.length > 0) {
        console.warn(`⚠️ 未標記的題目被 AI 改動了：${changedOtherIds.join(', ')}，已自動還原`)
        // 自動還原未標記題目的答案
        parsed.details = parsed.details.map((detail) => {
          const qid = detail.questionId ?? ''
          if (changedOtherIds.includes(qid)) {
            const prev = options.regrade!.previousDetails!.find((d) => d.questionId === qid)
            if (prev && prev.studentAnswer !== undefined) {
              return {
                ...detail,
                studentAnswer: prev.studentAnswer,
                score: prev.score ?? 0,
                isCorrect: prev.isCorrect ?? false,
                confidence: prev.confidence ?? 0,
                reason: prev.reason ?? ''
              }
            }
          }
          return detail
        })
      }
    }

    const reviewReasons: string[] = [...(parsed.reviewReasons ?? [])]
    if (!parsed.details || !Array.isArray(parsed.details)) {
      reviewReasons.push('缺少逐題詳解')
    }
    if (parsed.totalScore === 0 && (parsed.details?.length ?? 0) === 0) {
      reviewReasons.push('總分為 0 且缺少逐題詳解，請複核')
    }
    if ((parsed.mistakes?.length ?? 0) === 0 && (parsed.details?.length ?? 0) === 0) {
      reviewReasons.push('未偵測到題目或錯誤，請確認解析是否成功')
    }

    const textBlob = [
      ...(parsed.feedback ?? []),
      ...(parsed.suggestions ?? []),
      ...(parsed.weaknesses ?? [])
    ]
      .join(' ')
      .toLowerCase()

    if (/[?？]|模糊|無法|不確定|看不清楚|not sure|uncertain/.test(textBlob)) {
      reviewReasons.push('模型信心不明或表述不確定')
    }

    parsed.needsReview = reviewReasons.length > 0
    parsed.reviewReasons = reviewReasons

    // 步驟 2：後處理補漏（如果有 AnswerKey，且不是分頁批改的部分圖片）
    let missingQuestionIds: string[] = []
    const isPartialForFill = options?._isPartialImage === true
    
    if (answerKey && !options?.regrade?.mode && !isPartialForFill) {
      const fillResult = fillMissingQuestions(parsed, answerKey)
      parsed = fillResult.result
      missingQuestionIds = fillResult.missingQuestionIds
    }

    // 步驟 3：自動重試缺失的題目（除非明確跳過，或是分頁批改的部分圖片）
    if (
      missingQuestionIds.length > 0 &&
      !options?.skipMissingRetry &&
      !options?.regrade?.mode &&
      !isPartialForFill
    ) {
      console.log(`🔄 自動重試批改缺失的 ${missingQuestionIds.length} 題...`)

      try {
        const retryResult = await gradeSubmission(submissionImage, answerKeyImage, answerKey, {
          ...options,
          skipMissingRetry: true,
          regrade: {
            questionIds: missingQuestionIds,
            previousDetails: parsed.details,
            mode: 'missing'
          }
        })

        if (retryResult.details && Array.isArray(retryResult.details)) {
          const retryDetailsMap = new Map(retryResult.details.map((d) => [d.questionId, d]))

          parsed.details = (parsed.details ?? []).map((detail) => {
            const qid = detail.questionId ?? ''
            if (missingQuestionIds.includes(qid) && retryDetailsMap.has(qid)) {
              const retryDetail = retryDetailsMap.get(qid)
              // ✅ 只有重試不是空答案才替換
              if (retryDetail && !isEmptyStudentAnswer(retryDetail.studentAnswer)) {
                console.log(`✅ 重試成功辨識題目 ${qid}`)
                return retryDetail
              }
            }
            return detail
          })

          parsed.totalScore = (parsed.details ?? []).reduce((sum, d) => sum + (d.score ?? 0), 0)

          const stillMissingIds = (parsed.details ?? [])
            .filter(
              (d) => missingQuestionIds.includes(d.questionId ?? '') && isEmptyStudentAnswer(d.studentAnswer)
            )
            .map((d) => d.questionId)

          if (stillMissingIds.length < missingQuestionIds.length) {
            parsed.reviewReasons = (parsed.reviewReasons ?? []).map((reason) =>
              reason.includes('AI 遺漏')
                ? `AI 遺漏 ${missingQuestionIds.length} 題，重試後仍有 ${stillMissingIds.length} 題無法辨識（${stillMissingIds.join(
                    ', '
                  )}）`
                : reason
            )
          }
        }
      } catch (retryError) {
        console.warn('⚠️ 重試批改失敗:', retryError)
      }
    }

    // staged 無法使用時，single-shot fallback 也補齊錯題 bbox
    if (!isPartialForFill) {
      await enrichWrongDetailBboxesWithLocate(parsed, submissionBase64, submissionMimeType, logPrefix)
    }

    return parsed
  } catch (error) {
    console.error(`❌ ${currentModelName} 批改失敗:`, error)

    if ((error as any).message?.includes('404') || (error as any).message?.includes('not found')) {
      return {
        totalScore: 0,
        mistakes: [],
        weaknesses: [],
        suggestions: [],
        feedback: [`模型 ${currentModelName} 不存在或不可用`]
      }
    }

    return {
      totalScore: 0,
      mistakes: [],
      weaknesses: [],
      suggestions: [],
      feedback: ['系統錯誤', (error as Error).message]
    }
  }
}

/**
 * 批改多份作業（一鍵批改）
 */
export async function gradeMultipleSubmissions(
  submissions: Submission[],
  answerKeyBlob: Blob | null,
  onProgress: (current: number, total: number) => void,
  answerKey?: AnswerKey,
  options?: GradeSubmissionOptions & {
    /** 每批改完一份作業時的回調（可用於即時更新 UI） */
    onSubmissionComplete?: (updatedSubmission: Submission, result: GradingResult) => void
    /** 檢查是否應該停止批改（用於用戶取消） */
    shouldStop?: () => boolean
  }
) {
  console.log(`📝 開始批量批改 ${submissions.length} 份作業`)
  const avoidBlobStorage = shouldAvoidIndexedDbBlob()
  
  // 🆕 設置 AnswerKey 緩存（整個批量批改共用同一份 AnswerKey）
  if (answerKey) {
    setAnswerKeyCache(answerKey)
    console.log('📦 [AnswerKey] 已設置批量批改緩存')
  }
  const { onSubmissionComplete, shouldStop, ...gradeOptions } = options ?? {}

  let successCount = 0
  let failCount = 0
  let stopped = false

  // 🆕 跨作業預取機制：預先壓縮下一份作業的圖片
  const preparedSubmissions = new Map<string, Promise<{ blob: Blob; base64: string; mimeType: string } | null>>()
  
  const prepareSubmissionImage = async (sub: Submission): Promise<{ blob: Blob; base64: string; mimeType: string } | null> => {
    if (!sub.imageBlob) return null
    
    try {
      const prepStartTime = performance.now()
      const prepared = await compressForGemini(sub.imageBlob, GEMINI_SINGLE_IMAGE_TARGET_BYTES, '作業')
      const base64 = await blobToBase64(prepared)
      const mimeType = prepared.type || 'image/jpeg'
      const prepTime = performance.now() - prepStartTime
      console.log(`   📦 預處理作業 ${sub.id} 完成 (${prepTime.toFixed(0)}ms, ${(prepared.size / 1024).toFixed(0)}KB)`)
      return { blob: prepared, base64, mimeType }
    } catch (error) {
      console.warn(`   ⚠️ 預處理作業 ${sub.id} 失敗:`, error)
      return null
    }
  }
  
  // 預取下一份作業
  const prefetchNextSubmission = (currentIndex: number) => {
    const nextIndex = currentIndex + 1
    if (nextIndex < submissions.length) {
      const nextSub = submissions[nextIndex]
      if (!preparedSubmissions.has(nextSub.id!) && nextSub.imageBlob) {
        console.log(`   🔮 預取下一份作業 ${nextSub.id}...`)
        preparedSubmissions.set(nextSub.id!, prepareSubmissionImage(nextSub))
      }
    }
  }
  
  // 預取前 2 份作業
  for (let i = 0; i < Math.min(2, submissions.length); i++) {
    const sub = submissions[i]
    if (sub.imageBlob && !preparedSubmissions.has(sub.id!)) {
      preparedSubmissions.set(sub.id!, prepareSubmissionImage(sub))
    }
  }

  const total = submissions.length
  let nextIndex = 0
  let dispatchedCount = 0
  let completedCount = 0
  const concurrency = Math.max(1, Math.min(BATCH_GRADING_CONCURRENCY, total || 1))
  console.log(`🚦 批量批改模式：限流併發 ${concurrency}`)

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  const runWorker = async (workerId: number) => {
    while (true) {
      // 🛑 檢查是否應該停止（僅停止派發新任務，進行中的任務會收尾）
      if (shouldStop?.()) {
        if (!stopped) {
          console.log(`🛑 用戶請求停止批改，已完成 ${successCount} 份`)
        }
        stopped = true
        return
      }

      const i = nextIndex
      nextIndex += 1
      if (i >= total) return

      const sub = submissions[i]
      dispatchedCount += 1
      console.log(
        `\n📄 [W${workerId}] 批改第 ${i + 1}/${total} 份作業: ${sub.id} (派發 ${dispatchedCount}/${total})`
      )

      // 🆕 預取下一份作業（在當前作業批改期間並行準備）
      prefetchNextSubmission(i)

      try {
        if (!sub.imageBlob) {
          console.warn(`⚠️ 跳過沒有 imageBlob 的作業: ${sub.id}`)
          failCount++
          continue
        }

        console.log(`🔍 [W${workerId}] 開始批改作業 ${sub.id}...`)

        // 🆕 檢查是否有預處理好的圖片
        let result: GradingResult
        const preparedPromise = preparedSubmissions.get(sub.id!)

        if (preparedPromise) {
          const prepared = await preparedPromise
          if (prepared) {
            // 使用預處理好的圖片（跳過壓縮步驟）
            console.log(`   ✨ [W${workerId}] 使用預處理圖片批改`)
            result = await gradeSubmissionWithPreparedImage(
              prepared.blob,
              prepared.base64,
              prepared.mimeType,
              answerKeyBlob,
              answerKey,
              gradeOptions
            )
          } else {
            // 預處理失敗，回退到標準流程
            result = await gradeSubmission(sub.imageBlob, answerKeyBlob, answerKey, gradeOptions)
          }
        } else {
          // 沒有預處理，使用標準流程
          result = await gradeSubmission(sub.imageBlob, answerKeyBlob, answerKey, gradeOptions)
        }

        console.log(`📊 [W${workerId}] 批改結果: 得分 ${result.totalScore}`)

        console.log(`💾 [W${workerId}] 儲存批改結果到資料庫...`)
        let imageBase64 = sub.imageBase64
        if (avoidBlobStorage && !imageBase64 && sub.imageBlob) {
          try {
            imageBase64 = await blobToDataUrl(sub.imageBlob)
          } catch (error) {
            console.warn('⚠️ Base64 轉換失敗，將略過 imageBase64:', error)
          }
        }

        const updatePayload: Partial<Submission> = {
          status: 'graded',
          score: result.totalScore,
          gradingResult: result,
          gradedAt: Date.now()
        }
        if (imageBase64) updatePayload.imageBase64 = imageBase64
        if (!avoidBlobStorage && sub.imageBlob) updatePayload.imageBlob = sub.imageBlob
        if (avoidBlobStorage) updatePayload.imageBlob = undefined

        try {
          await db.submissions.update(sub.id!, updatePayload)
        } catch (error) {
          if (!avoidBlobStorage && sub.imageBlob && isIndexedDbBlobError(error)) {
            const fallback: Partial<Submission> = {
              status: updatePayload.status,
              score: updatePayload.score,
              gradingResult: updatePayload.gradingResult,
              gradedAt: updatePayload.gradedAt
            }
            if (imageBase64) fallback.imageBase64 = imageBase64
            await db.submissions.update(sub.id!, fallback)
          } else {
            throw error
          }
        }

        successCount++
        console.log(
          `✅ [W${workerId}] 批改成功 (${i + 1}/${total}): ${sub.id}, 得分: ${result.totalScore}, 累計成功: ${successCount}`
        )

        // 🆕 通知 UI 此份作業已完成，即時更新
        if (onSubmissionComplete) {
          const updatedSubmission: Submission = {
            ...sub,
            status: 'graded',
            score: result.totalScore,
            gradingResult: result,
            gradedAt: Date.now(),
            imageBase64: imageBase64 ?? sub.imageBase64
          }
          onSubmissionComplete(updatedSubmission, result)
        }
      } catch (e) {
        failCount++
        console.error(`❌ [W${workerId}] 批改作業失敗 (${i + 1}/${total}): ${sub.id}`, e)
        console.error(`   累計失敗: ${failCount}`)
      } finally {
        completedCount += 1
        onProgress(completedCount, total)
      }

      // 輕量節流，降低 API 擁塞風險
      if (!stopped && i < total - 1 && BATCH_GRADING_STAGGER_MS > 0) {
        await sleep(BATCH_GRADING_STAGGER_MS)
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, (_, idx) => runWorker(idx + 1)))

  console.log(`\n🏁 批改${stopped ? '已停止' : '完成'}！總計: ${submissions.length}, 成功: ${successCount}, 失敗: ${failCount}`)
  console.log(`📤 返回結果: { successCount: ${successCount}, failCount: ${failCount}, stopped: ${stopped} }`)

  // 🆕 清除 AnswerKey 緩存
  if (answerKey) {
    clearAnswerKeyCache()
  }

  return { successCount, failCount, stopped }
}

/**
 * 🆕 使用已預處理圖片的批改入口（跳過壓縮步驟，但仍走完整流程判斷分頁）
 */
async function gradeSubmissionWithPreparedImage(
  preparedImage: Blob,
  imageBase64: string,
  imageMimeType: string,
  answerKeyBlob: Blob | null,
  answerKey?: AnswerKey,
  options?: GradeSubmissionOptions
): Promise<GradingResult> {
  if (!isGeminiAvailable) throw new Error('Gemini 服務未設定')

  // 判斷是否應該使用分頁批改
  if (ENABLE_PAGED_GRADING && !options?._skipPagedGrading) {
    const imageInfo = await isMultiPageImage(preparedImage)
    
    if (imageInfo.isMultiPage && answerKey && !answerKeyBlob) {
      console.log(`📄 [分頁批改] 偵測到多頁圖片，啟用分頁批改（預處理模式）`)
      // 分頁批改需要原始圖片來切割，所以還是用原始 blob
      return await gradeSubmissionPaged(preparedImage, answerKeyBlob, answerKey, options)
    }
  }
  
  // 使用預處理圖片進行標準批改
  return await gradeSubmissionCoreWithPreparedImage(
    preparedImage,
    imageBase64,
    imageMimeType,
    answerKeyBlob,
    answerKey,
    options
  )
}

// ── Answer Key Quality Gate (client-side, mirrors server-side validateAnswerKeyQuality) ──
// 28 種 type 全部列出（與 db.ts 的 QuestionCategory enum 同步）
const AK_VALID_CATEGORIES = new Set([
  // Bucket A
  'single_choice', 'multi_choice', 'circle_select_one', 'circle_select_many',
  'single_check', 'multi_check', 'true_false', 'fill_blank', 'multi_fill',
  'matching', 'ordering', 'mark_in_text',
  // Bucket B
  'fill_variants', 'map_fill',
  // Bucket C
  'short_answer', 'calculation', 'word_problem',
  'map_symbol', 'grid_geometry', 'connect_dots',
  'diagram_draw', 'diagram_color',
  // Bucket D
  'compound_circle_with_explain', 'compound_check_with_explain',
  'compound_writein_with_explain', 'multi_check_other',
  'compound_judge_with_correction', 'compound_judge_with_explain',
  'compound_chain_table',
])

// 必須填 answer 或 referenceAnswer 的 type
// 驗證邏輯：answer 或 referenceAnswer 至少一個有值（非 placeholder）
// 注意：compound_chain_table 不在此列，因為它沒有單一 answer（純 rubric）
const AK_ANSWER_REQUIRED = new Set([
  // Bucket A 全部（含新加入的 calculation / word_problem）
  'single_choice', 'multi_choice', 'circle_select_one', 'circle_select_many',
  'single_check', 'multi_check', 'true_false', 'fill_blank', 'multi_fill',
  'matching', 'ordering', 'mark_in_text',
  'calculation',     // A bucket：answer = 純數值（過程交 Accessor）
  'word_problem',    // A bucket：answer = 含單位最終值（不含「答：」前綴）
  // Bucket B（用 referenceAnswer + acceptableAnswers）
  'fill_variants',
  // Bucket C（用 referenceAnswer + rubricsDimensions）
  'short_answer',
  'map_symbol', 'grid_geometry', 'connect_dots',
  'diagram_draw', 'diagram_color',
  // Bucket D 中含「精確比對」部分的題型（必選情境）
  'compound_circle_with_explain', 'compound_check_with_explain',
  'compound_writein_with_explain', 'multi_check_other',
  'compound_judge_with_correction', 'compound_judge_with_explain',
  // compound_chain_table 不需要 answer（純 rubric）
])

/**
 * Merge two AnswerKey results question-by-question.
 * Strategy: trust first run (stable), only override specific broken questions from retry.
 * - First has good answer + bbox → keep first
 * - First has "?" answer, retry has real answer → use retry's question
 * - First has no bbox, retry has bbox → take retry's bbox, keep first's answer if valid
 * - Both have "?" → keep first (both failed)
 */
function mergeAnswerKeyResults(first: AnswerKey, retry: AnswerKey): AnswerKey {
  const retryById = new Map(retry.questions.map(q => [q.id, q]))
  let mergedCount = 0

  const mergedQuestions = first.questions.map(q1 => {
    const q2 = retryById.get(q1.id)
    if (!q2) return q1  // retry doesn't have this question → keep first

    const ans1 = (q1.answer ?? '').trim()
    const ref1 = (q1.referenceAnswer ?? '').trim()
    const ans2 = (q2.answer ?? '').trim()
    const ref2 = (q2.referenceAnswer ?? '').trim()
    const PLACEHOLDERS = new Set(['?', '？', '未知', 'unknown', 'N/A', 'n/a'])
    const isBadAnswer1 = (!ans1 || PLACEHOLDERS.has(ans1)) && (!ref1 || PLACEHOLDERS.has(ref1))
    const isBadAnswer2 = (!ans2 || PLACEHOLDERS.has(ans2)) && (!ref2 || PLACEHOLDERS.has(ref2))
    const hasBbox1 = !!(q1.answerBbox)
    const hasBbox2 = !!(q2.answerBbox)

    if (isBadAnswer1 && !isBadAnswer2) {
      // First has bad answer, retry has good answer → use retry's question entirely
      mergedCount++
      console.log(`[AnswerKey merge] ${q1.id}: use retry (answer: "${ans1}"→"${ans2}")`)
      return q2
    }
    if (!hasBbox1 && hasBbox2) {
      // First has no bbox, retry has bbox → take retry's bbox, keep first's answer
      mergedCount++
      console.log(`[AnswerKey merge] ${q1.id}: take retry bbox (answer kept from first)`)
      return { ...q1, answerBbox: q2.answerBbox }
    }
    // Default: keep first (stable)
    return q1
  })

  if (mergedCount > 0) {
    console.log(`[AnswerKey merge] ${mergedCount} questions improved from retry`)
  }

  return {
    ...first,
    questions: mergedQuestions,
    // Use first's totalScore (should be same, but first is authoritative)
    totalScore: first.totalScore
  }
}

function checkAnswerKeyQuality(ak: AnswerKey, pageCount?: number): { shouldRetry: boolean; reasons: string[] } {
  const reasons: string[] = []
  const questions = ak?.questions ?? []

  if (questions.length === 0) { reasons.push('no_questions'); return { shouldRetry: true, reasons } }
  if (questions.length < 3) reasons.push('too_few_questions')

  // Duplicate IDs
  const idSet = new Set<string>()
  let dupCount = 0
  for (const q of questions) {
    const id = (q.id ?? '').trim()
    if (id && idSet.has(id)) dupCount++
    if (id) idSet.add(id)
  }
  if (dupCount > 0) reasons.push(`duplicate_ids(${dupCount})`)

  // Missing IDs
  const missingId = questions.filter(q => !(q.id ?? '').trim()).length
  if (missingId > 0) reasons.push(`missing_ids(${missingId})`)

  // totalScore mismatch
  const scoreSum = questions.reduce((s, q) => s + (typeof q.maxScore === 'number' ? q.maxScore : 0), 0)
  if (typeof ak.totalScore === 'number' && Math.abs(ak.totalScore - scoreSum) > 1) {
    reasons.push(`score_mismatch(total=${ak.totalScore},sum=${scoreSum})`)
  }

  // Invalid categories
  const invalidCat = questions.filter(q => q.questionCategory && !AK_VALID_CATEGORIES.has(q.questionCategory)).length
  if (invalidCat > 0) reasons.push(`invalid_category(${invalidCat})`)

  // Missing or placeholder answers for required categories
  // "?" is a common AI placeholder when it can't read the answer — treat as missing
  const PLACEHOLDER_ANSWERS = new Set(['?', '？', '未知', 'unknown', 'N/A', 'n/a'])
  let missingAnswer = 0
  for (const q of questions) {
    if (!q.questionCategory || !AK_ANSWER_REQUIRED.has(q.questionCategory)) continue
    const ans = (q.answer ?? '').trim()
    const ref = (q.referenceAnswer ?? '').trim()
    if ((!ans || PLACEHOLDER_ANSWERS.has(ans)) && (!ref || PLACEHOLDER_ANSWERS.has(ref))) missingAnswer++
  }
  if (missingAnswer > 0) reasons.push(`missing_answer(${missingAnswer})`)

  // Page-proportional check
  if (pageCount && pageCount > 1 && questions.length / pageCount < 2) {
    reasons.push(`too_few_per_page(${(questions.length / pageCount).toFixed(1)})`)
  }

  // rubricsDimensions score mismatch (dimension sum != maxScore)
  let dimMismatchCount = 0
  for (const q of questions) {
    if (!Array.isArray(q.rubricsDimensions) || q.rubricsDimensions.length === 0) continue
    const dimSum = q.rubricsDimensions.reduce((s: number, d: { maxScore?: number }) => s + (typeof d.maxScore === 'number' ? d.maxScore : 0), 0)
    if (typeof q.maxScore === 'number' && Math.abs(dimSum - q.maxScore) > 0.5) dimMismatchCount++
  }
  if (dimMismatchCount > 0) reasons.push(`dim_score_mismatch(${dimMismatchCount})`)

  // shouldRetry if any critical issue (duplicate, missing id, score mismatch, no questions, too few, invalid category)
  const criticalPatterns = ['no_questions', 'too_few_questions', 'duplicate_ids', 'missing_ids', 'score_mismatch', 'invalid_category', 'missing_answer']
  const shouldRetry = reasons.some(r => criticalPatterns.some(p => r.startsWith(p)))
  return { shouldRetry, reasons }
}

/**
 * 從答案卷圖片中抽取 AnswerKey（給 AssignmentSetup 使用）
 */
export async function extractAnswerKeyFromImage(
  answerSheetImage: Blob,
  opts?: ExtractAnswerKeyOptions
): Promise<AnswerKey> {
  if (!isGeminiAvailable) throw new Error('Gemini 服務未設定')

  const isInferMode = opts?.inferMode === 'infer_blank'
  const isAnswerOnly = opts?.answerSheetMode === 'answer_only'
  console.log(`🧾 開始從圖片${isInferMode ? '推論（空白作業模式）' : (isAnswerOnly ? '抽取（純答題卡模式）' : '抽取（解答圖模式）')} AnswerKey...`)
  const imageBase64 = await blobToBase64(answerSheetImage)
  const mimeType = answerSheetImage.type || 'image/jpeg'

  const prompt = isInferMode
    ? buildInferFromBlankPrompt(opts?.domain)
    : (isAnswerOnly
      ? buildAnswerKeyAnswerOnlyPrompt(opts?.domain)
      : buildAnswerKeyPrompt(opts?.domain))
  console.log('📋 [AnswerKey prompt]', prompt)

  const text = (await generateGeminiText(currentModelName, [
    prompt,
    { inlineData: { mimeType, data: imageBase64 } }
  ], {
    routeKey: 'answer_key.extract',
    answerSheetMode: opts?.answerSheetMode
  }))
    .replace(/```json|```/g, '')
    .trim()

  console.log('📥 [AnswerKey raw response]', text)
  let answerKey = normalizeAnswerKeyShortAnswerDimensions(JSON.parse(text) as AnswerKey, opts?.domain)

  // Quality gate + auto-retry (1 attempt)
  const qg = checkAnswerKeyQuality(answerKey, 1)
  if (qg.shouldRetry) {
    console.warn('[AnswerKey QG] quality FAIL, retrying (1/1):', qg.reasons)
    try {
      const retryText = (await generateGeminiText(currentModelName, [
        prompt,
        { inlineData: { mimeType, data: imageBase64 } }
      ], { routeKey: 'answer_key.extract', answerSheetMode: opts?.answerSheetMode }))
        .replace(/```json|```/g, '').trim()
      const retryAk = normalizeAnswerKeyShortAnswerDimensions(JSON.parse(retryText) as AnswerKey, opts?.domain)
      const retryQg = checkAnswerKeyQuality(retryAk, 1)
      console.log('[AnswerKey QG] retry result:', retryQg.reasons.length === 0 ? 'pass' : retryQg.reasons)
      // Merge: keep first run's good questions, only override broken ones from retry
      answerKey = mergeAnswerKeyResults(answerKey, retryAk)
    } catch (retryErr) {
      console.warn('[AnswerKey QG] retry failed:', retryErr)
    }
  }

  return answerKey
}

// ─── ANSWER_KEY_LOCATE：client 端並行 per-page bbox 定位 ─────────────────────
//
// 為什麼放 client：
// - 每頁一支獨立 Gemini call，client 用 Promise.all 並行 → wall time 從 N×單頁時間
//   降到 ≈ 最慢單頁時間
// - 每支 call 各自走 Vercel function，避免 1 支函式跑 110s 撞 60s/300s timeout
// - canvas 裁切搬到 client，砍掉 server Sharp 依賴與 4.5MB response 風險
// - bbox 規則在 client 編輯，prompt 迭代不需 server deploy
//
// Server 端 ANSWER_KEY_LOCATE pipeline 是無狀態 passthrough，純粹替 client 中轉
// Gemini API（client 沒有 API key）。

interface LocateSpec {
  questionId: string
  questionType: string
  bboxPolicy: 'full_image' | 'group_context' | 'question_context'
  bboxGroupId?: string
  answerText?: string
}

const LOCATE_VALID_TYPES = new Set([
  // Bucket A
  'single_choice', 'multi_choice', 'circle_select_one', 'circle_select_many',
  'single_check', 'multi_check', 'true_false', 'fill_blank', 'multi_fill',
  'matching', 'ordering', 'mark_in_text',
  'calculation', 'word_problem',
  // Bucket B
  'fill_variants', 'map_fill',
  // Bucket C
  'short_answer',
  'map_symbol', 'grid_geometry', 'connect_dots',
  'diagram_draw', 'diagram_color',
  // Bucket D
  'compound_circle_with_explain', 'compound_check_with_explain',
  'compound_writein_with_explain', 'multi_check_other',
  'compound_judge_with_correction', 'compound_judge_with_explain',
  'compound_chain_table'
])

function resolveLocateQuestionType(q: import('./db').AnswerKeyQuestion): string {
  const category = String(q?.questionCategory ?? '').trim()
  if (category === 'map_draw') return 'map_symbol' // legacy compat
  if (LOCATE_VALID_TYPES.has(category)) return category
  return 'fill_blank'
}

function resolveLocateBboxPolicy(questionType: string): LocateSpec['bboxPolicy'] {
  if (questionType === 'map_fill') return 'full_image'
  if (questionType === 'matching') return 'group_context'
  return 'question_context'
}

function resolveLocateGroupId(q: import('./db').AnswerKeyQuestion): string {
  const qRecord = q as unknown as Record<string, unknown>
  const explicit = String(
    qRecord?.bboxGroupId ?? qRecord?.matchingGroupId ?? q?.unorderedGroupId ?? ''
  ).trim()
  if (explicit) return explicit
  if (Array.isArray(q?.idPath) && q.idPath.length > 0) return String(q.idPath[0]).trim()
  const id = String(q?.id ?? '').trim()
  const dash = id.indexOf('-')
  return dash > 0 ? id.slice(0, dash) : id
}

function buildLocateSpecs(questions: import('./db').AnswerKeyQuestion[]): LocateSpec[] {
  return questions.map((q) => {
    const questionType = resolveLocateQuestionType(q)
    const bboxPolicy = resolveLocateBboxPolicy(questionType)
    const spec: LocateSpec = { questionId: q.id, questionType, bboxPolicy }
    if (bboxPolicy === 'group_context') {
      const groupId = resolveLocateGroupId(q)
      if (groupId) spec.bboxGroupId = groupId
    }
    const answerText = (typeof q.answer === 'string' && q.answer)
      || (typeof q.referenceAnswer === 'string' && q.referenceAnswer)
      || ''
    if (answerText) spec.answerText = answerText
    return spec
  })
}

function buildAnswerKeyLocatePrompt(questions: import('./db').AnswerKeyQuestion[]): string {
  const specs = buildLocateSpecs(questions)
  return `You are stage ANSWER_KEY_LOCATE.
任務：在這張答案卷圖片上，為每一題標出 answerBbox — 印刷答案文字／作答區的視覺位置。
🚨 你只做視覺定位，不抽答案、不推論答案。看不到 → omit。

Search key：用 specs 裡的 answerText 當視覺搜尋錨點，找出該段文字印在這張圖上的哪裡。

Question Specs:
${JSON.stringify(specs)}

═══════════════ 座標格式（強制）═══════════════
- bbox = { "x": 0.12, "y": 0.34, "w": 0.20, "h": 0.08 }
  - (x,y) = 左上角；w = 寬；h = 高
  - 全部為 0-1 之間的歸一化座標（相對於本張圖片的寬高）
- ⚠️ 絕對禁止輸出像素座標（如 x: 376, y: 313）。x/y/w/h 必須在 0-1 範圍內。
- bbox 必須 TIGHT 且 ACCURATE — 不可給 placeholder 或估計大小
- 視覺定位失敗 → 直接 omit answerBbox（不要硬給空框或預設框）
- 每題 bbox 獨立，禁止為避免與其他題重疊而偏移座標
- 只用 specs 列出的 questionId

═══════════════ bboxPolicy 三種政策 ═══════════════
- full_image：answerBbox 強制為 {x:0, y:0, w:1, h:1}
- group_context：同一 bboxGroupId 的所有題目共用同一個 answerBbox
- question_context：定位該題自己的答案區（per-type 規則見下）

═══════════════ Per-Type 涵蓋範圍規則 ═══════════════

▸ Bucket A — 精確比對

- single_choice 「選擇題」：緊框題號前的空括號 + 小邊距（25-35% 頁寬），不框題幹
- multi_choice 「多選選擇題」：同 single_choice
- circle_select_one 「圈選題」：括號內含預印多個選項（如「同意／不同意」）。bbox 必須含**全部印刷選項文字** + 圈選筆跡，不能只框筆跡
- circle_select_many 「多選圈選題」：同 circle_select_one
- single_check 「勾選題」：一列方框 □ + 對應選項文字。bbox 涵蓋整列方框 + 對應選項文字
- multi_check 「多選勾選題」：同 single_check
- true_false 「是非題」：緊框接在敘述句後的單一括號 (   )
- fill_blank 「填空題」：規則複雜，**完整規則見下方專屬區塊**（FILL_BLANK 加強規則）
  - 直式分數格特例：上下格各自有紅色 → 兩格都要框入
- multi_fill 「多項填空題」：每子題獨立一個 bbox，TIGHT crop ONLY 該格的單一值，不含鄰格
  ⚠️ 子題 bbox 絕對禁止重疊
  ORDERING：子題 ID 依 TOP-TO-BOTTOM 為主、LEFT-TO-RIGHT 為輔
- matching 「連連看」(group_context)：整個連連看區為單一 bbox — 左欄所有項目 + 右欄所有選項 + 中間所有連線
  ⚠️ 不可只框右欄文字 — 連線本身就是答案，必須完整包含
- ordering 「排序題」：整體一個 bbox，涵蓋所有排序格
- mark_in_text 「圈詞題」：涵蓋整個文章區域，可框大一點以含上下文
- calculation 「計算題」：從第一行算式 → 框到最終答案，**所有算式行（橫式 + 直式 + 結果）整個範圍**
  ⚠️ 不可只框最終數值 — 計算步驟必須在框內
- word_problem 「應用題」：從第一行算式 → 框到最末「答：」或「A：」行整個範圍
  ⚠️ 不可只框「答：」那一行 — 計算步驟也必須在框內

▸ Bucket B — 容多元

- fill_variants 「多元填空題」：同 fill_blank（緊框該空格 + 紅色文字）
- map_fill 「填圖題」(full_image)：強制 {x:0, y:0, w:1, h:1}

▸ Bucket C — Rubric

- short_answer 「簡答題」：框住題幹下方的參考答案文字或 rubric 區
- map_symbol 「地圖符號標記題」：整張地圖 + 題幹
- grid_geometry 「格線幾何繪製題」：整個格線區 + 題幹
- connect_dots 「連點繪圖題」：整個點陣區 + 題幹
- diagram_draw 「圖表繪製題」：整個圖表繪製區 + 題幹
- diagram_color 「塗色題」：整個塗色區 + 題幹

▸ Bucket D — 複合題（兩個部分必須同時在框內！）

🚨 共通要求：bbox 必須**同時涵蓋作答的兩個部分**（圈選/勾選/判斷 + 理由/改正/說明）
🚨 自我檢查：框完後，框內應該能同時看到兩個部分。看不到任何一個 → bbox 飄了，重新標

- compound_circle_with_explain 「圈選說明題」：從圈選括號 ( ) 的左上角 → 框到理由說明文字最末一字（含標點）
  框內必須同時看到「(選項/選項)」+「因為...」整段
- compound_check_with_explain 「勾選說明題」：從第一個方框 □ → 框到理由說明文字最末一字
  框內必須同時看到「□ 選項 □ 選項...」+「因為...」整段
- compound_writein_with_explain 「寫入說明題」：從空括號 ( ) → 框到理由說明文字最末一字
  框內必須同時看到括號 + 寫的代號 + 整段理由
- multi_check_other 「複選含其他題」：從第一個方框 □ → 框到「其他：___」開放欄末端
  框內必須包含全部方框 + 其他開放欄
- compound_judge_with_correction 「判斷改正題」：從判斷括號（○/✗）→ 框到改正寫字區末端
  框內必須同時看到括號 ○/✗ + 改正文字
- compound_judge_with_explain 「判斷說明題」：從第一個括號（對不對？）→ 框到理由說明文字最末一字
  框內必須同時看到「(對/不對)」+「為什麼？(理由...)」整段
- compound_chain_table 「表格連動題」：整 row 框起來（涵蓋該行所有 cell），從第一格到最後一格框成一個 bbox

═══════════════ FILL_BLANK 加強規則（最常切歪，老師最有感）═══════════════

填空題答案卷上的「紅字」= 老師（或出版社）在空白處印刷／手寫的紅色標準答案。
你要做的就是把那段紅字 + 它所在的「印刷空白標記」框起來。

🚨 兩階段：先識別 blankFormat、再依格式算 bbox

【Step 1：識別這格的 blankFormat】

- 視覺結構是「______」（底線）→ blankFormat = "underline"
- 視覺結構是「(    )」（括號）→ blankFormat = "parens"
- 視覺結構是「□」（方框）→ blankFormat = "box"

【Step 2：依 blankFormat 用不同策略算 bbox】

▸ 【underline 底線型】
  視覺：紅字答案蓋在底線上，兩者重疊
  策略：bbox.x = 紅字最左端 = 底線最左端（剛好相同）
  範圍：x → x+w 涵蓋整個底線 + 紅字（含超出底線的尾巴）

▸ 【parens 括號型】
  視覺：紅字寫在 ( ) 中央，與印刷括號**分離**
  ⚠️ 此格式下「紅字位置」≠「答案區位置」
  ⚠️ 不要試圖視覺找 "(" 像素 — 印刷括號太淡你抓不到，bbox 貼著紅字就會切到左/右半
  策略：bbox.x 與 bbox.x+w 分別決定，依括號寬度自適應推 3-10% 頁寬

  決定 bbox.x（左邊界）：
  - bbox.x = 紅字最左端 - left_pad
  - left_pad：緊湊括號 \`(  數字  )\` 用 3-5%；寬括號 \`(        數字        )\` 用 6-10%
  - 上限：不可跨進前一題

  決定 bbox.x + w（右邊界）：
  - bbox.x + w = 紅字最右端 + right_pad
  - right_pad ≈ left_pad（紅字通常居中 → 兩側 gap 對等）
  - 上限：不可包到單位字（元 / 公分 / 公克 / 個）

  範例（緊湊括號 \`(  410  )\`）：
    紅字「410」最左端 x=0.55、最右端 x=0.62
    → bbox.x = 0.55 - 0.04 = 0.51（涵蓋 \`(\`）
    → bbox.x + w = 0.62 + 0.04 = 0.66（涵蓋 \`)\`，但不含「元」）
    → bbox.w = 0.15

  範例（寬括號 \`(        15        )\`）：
    紅字「15」最左端 x=0.50、最右端 x=0.53
    → bbox.x = 0.50 - 0.08 = 0.42（涵蓋遠處的 \`(\`）
    → bbox.x + w = 0.53 + 0.08 = 0.61（涵蓋遠處的 \`)\`）
    → bbox.w = 0.19

▸ 【box 方框型】
  視覺：紅字寫在 □ 內部，□ 邊界明顯可目視
  策略：bbox 框 □ 整個邊界 + 內部紅字（含算式中的 ×/+/− 等運算符）
  🚨 邊距：bbox **不要緊貼 □**，四邊各向外推 3-5% 頁寬，避免切到 □ 邊框或紅字尾巴

  範例：
    □ 邊界 x=0.40~0.48
    → bbox.x = 0.40 - 0.04 = 0.36
    → bbox.x + w = 0.48 + 0.04 = 0.52
    → bbox.w = 0.16

🚨 三種共通規則：
- 上下 = 含紅字高度，含一點上下邊距
- 兩空格之間的印刷字（in / the / is / 是 / 的）必須在 bbox **之外**
- 印刷標記後的單位（元 / 公分 / 公克 / 個）也在 bbox **之外**（除非單位寫在括號**內**）

🔍 自我檢查（每題必做）：
1. 我有先判斷 blankFormat（parens / underline / box）嗎？
2. parens 時：
   a. bbox.x 與紅字最左端的距離應該 ≥ 0.03（頁寬），表示有向左推到 \`(\`
   b. bbox.x + w 與紅字最右端的距離應該 ≥ 0.03（頁寬），表示有向右推到 \`)\`
   c. 寬括號要推更多（≥ 0.06），不要固定 0.04
   d. 左 pad 與右 pad 應該對稱（gap 大致相等）
3. underline 時，bbox.x 應該 = 紅字最左端（不需多推）
4. 框出的 bbox 內**不該**含到題幹文字、相鄰空格的內容、或末尾的單位

❌ 常見 bug（請對照避免）：

【Bug 1：parens 沒向左推 → 切到左半】
  看到「(    150    ) 元」，bbox 直接貼著紅字「150」
  → 印刷括號 "(" 在 bbox 外面 → 裁切結果只看到「)元」或「50    )元」
  ✅ 正確：bbox.x = 紅字最左端 - 0.04 以上

【Bug 2：parens 沒向右推 → 切到右半（寬括號常見）】
  看到「(        15        )」，bbox.x+w 只到「15」右邊一點
  → 印刷括號 ")" 在 bbox 外面 → 裁切結果只看到「(        15」
  ✅ 正確：bbox.x + w = 紅字最右端 + 0.04 以上（寬括號要 +0.08）

【Bug 3：parens 兩側推不對稱 → 切到一半】
  左推 0.08 但右只 +0.02 → 寬括號的 \`)\` 被切
  ✅ 正確：左 pad ≈ 右 pad（紅字居中，兩側 gap 對等）

【Bug 4：parens 推太多 → 含到前一題或單位】
  bbox.x 向左推超過寬括號該有的距離 → 跨進鄰題
  bbox.x + w 向右推超過 \`)\` → 含到「元/公分」
  ✅ 緊湊括號控制 3-5%，寬括號控制 6-10%，依目視判斷

【Bug 5：underline 同行多空把鄰字當 anchor】
  看到「Mom is _____ in the _____」，把 "is" / "the" 當推位置的依據
  → bbox 起點落在 "is" / "in" → 還沒到底線就開始畫，切到鄰字
  ✅ 正確：直接從第 N 條底線最左端的像素起算（= 紅字最左端）

完整範例：
- 緊湊括號型（無單位）：「請填(  3  )」blankFormat=parens
   紅字「3」x=0.40 → bbox.x = 0.36（推 0.04），bbox.x+w = 0.41+0.04 = 0.45
- 緊湊括號型（含單位）：「(    150    ) 元」blankFormat=parens
   紅字「150」x=0.50~0.55 → bbox.x = 0.46，bbox.x+w = 0.59；不含「元」
- 寬括號型：「(        15        )」blankFormat=parens
   紅字「15」x=0.50~0.53 → bbox.x = 0.42（推 0.08），bbox.x+w = 0.61
- 方框型：「2½ □ (4.73 □ 2.73)」blankFormat=box
   目視 □ 邊界框格本身（含紅字 ×/+ 等運算符）
- 底線型：「___ 公尺」blankFormat=underline
   bbox.x = 底線左端 = 紅字左端；w 涵蓋整個底線 + 紅字尾巴；「公尺」在外面
- 同行多空（底線型）：「Mom is _____ in the _____.」
   ✅ 第 1 題 → bbox.x = 第 1 條底線左端
   ✅ 第 2 題 → bbox.x = 第 2 條底線左端
   ❌ 把 "is" / "in" 當 anchor 推位置
- 同行多空（括號型）：「(  3  ) + (  5  ) = (  8  )」
   ✅ 找對應的紅字數字，左右各推 0.03-0.05（緊湊型）
   ❌ bbox.x 直接貼著數字 → 切到 \`(\`

═══════════════ Output ═══════════════
回傳純 JSON，不要 Markdown：
{
  "locations": [
    { "questionId": "1", "answerBbox": { "x": 0.12, "y": 0.34, "w": 0.20, "h": 0.08 } }
  ]
}`.trim()
}

// 收件驗證：bbox 四欄必須是有限數字、在 [0, 2] 範圍、w/h > 0
function isValidLocateBbox(b: unknown): b is NormalizedBbox {
  if (!b || typeof b !== 'object') return false
  const bb = b as Record<string, unknown>
  const inRange = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 2
  return inRange(bb.x) && inRange(bb.y) && inRange(bb.w) && inRange(bb.h)
    && (bb.w as number) > 0 && (bb.h as number) > 0
}

// 對單張頁面圖呼叫一次 locate Gemini，回傳 questionId → bbox
async function locateAnswerKeyBboxesOnPage(
  questions: import('./db').AnswerKeyQuestion[],
  imageBlob: Blob
): Promise<Map<string, NormalizedBbox>> {
  const bboxMap = new Map<string, NormalizedBbox>()
  // 只 locate 有 answerText 的題目（locate 用 answerText 當視覺錨點）
  const locatableQ = questions.filter((q) => {
    const text = (typeof q.answer === 'string' && q.answer)
      || (typeof q.referenceAnswer === 'string' && q.referenceAnswer)
    return Boolean(text)
  })
  if (locatableQ.length === 0) return bboxMap

  const prompt = buildAnswerKeyLocatePrompt(locatableQ)
  const imageBase64 = await blobToBase64(imageBlob)
  const mimeType = imageBlob.type || 'image/jpeg'
  const parts: GeminiRequestPart[] = [
    prompt,
    { inlineData: { mimeType, data: imageBase64 } }
  ]
  try {
    const text = (await generateGeminiText(currentModelName, parts, {
      routeKey: 'answer_key.locate'
    })).replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(text) as { locations?: Array<{ questionId: string; answerBbox?: unknown }> }
    if (!Array.isArray(parsed?.locations)) return bboxMap
    for (const loc of parsed.locations) {
      const qId = String(loc?.questionId ?? '').trim()
      if (!qId) continue
      if (!isValidLocateBbox(loc.answerBbox)) {
        if (loc.answerBbox) {
          console.warn(`[locate] dropped invalid bbox for ${qId}:`, loc.answerBbox)
        }
        continue
      }
      bboxMap.set(qId, loc.answerBbox)
    }
  } catch (err) {
    console.warn('[locate] page failed:', err instanceof Error ? err.message : err)
  }
  return bboxMap
}

// 並行 locate：把 questions 按 pageIndex 分組，每頁一支 Gemini call，全部 Promise.all
async function locateAnswerKeyBboxesAcrossPages(
  questions: import('./db').AnswerKeyQuestion[],
  imageBlobs: Blob[]
): Promise<Map<string, NormalizedBbox>> {
  // 按 pageIndex 分組（沒設就從 ID 首段推算）
  const byPage = new Map<number, import('./db').AnswerKeyQuestion[]>()
  for (const q of questions) {
    const pageIdx = typeof q.pageIndex === 'number'
      ? q.pageIndex
      : Math.max(0, (parseInt(String(q.id ?? '').split('-')[0], 10) || 1) - 1)
    if (!byPage.has(pageIdx)) byPage.set(pageIdx, [])
    byPage.get(pageIdx)!.push(q)
  }

  const startedAt = Date.now()
  console.log(`📍 [locate] 開始並行定位 ${byPage.size} 頁的 bbox...`)

  // 並行所有頁面（核心優勢：N 頁同時打）
  const results = await Promise.all(
    Array.from(byPage.entries()).map(async ([pageIdx, pageQuestions]) => {
      const blob = imageBlobs[pageIdx]
      if (!blob) {
        console.warn(`[locate] page ${pageIdx} 無對應圖片，跳過`)
        return new Map<string, NormalizedBbox>()
      }
      return locateAnswerKeyBboxesOnPage(pageQuestions, blob)
    })
  )

  // 合併結果
  const merged = new Map<string, NormalizedBbox>()
  for (const m of results) {
    for (const [k, v] of m) merged.set(k, v)
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log(`📍 [locate] 完成：${merged.size}/${questions.length} 題定位成功（${elapsed}s）`)
  return merged
}

// Canvas 裁切：對每題 bbox，在對應頁面圖上裁出 jpeg data URL
async function cropAnswerKeyQuestionsOnCanvas(
  questions: import('./db').AnswerKeyQuestion[],
  bboxMap: Map<string, NormalizedBbox>,
  imageBlobs: Blob[]
): Promise<Map<string, string>> {
  const cropMap = new Map<string, string>()
  // 為避免重複載入，cache 每頁的 ImageBitmap
  const bitmapCache = new Map<number, ImageBitmap>()

  for (const q of questions) {
    // 優先用 locate 結果，沒有就 fallback 到 extract 階段已給的 q.answerBbox。
    // 這對 short_answer（無文字答案 → locate 跳過）特別重要，避免 bbox 顯示但無 crop。
    const bbox = bboxMap.get(q.id) ?? q.answerBbox ?? null
    if (!bbox) continue
    const pageIdx = typeof q.pageIndex === 'number'
      ? q.pageIndex
      : Math.max(0, (parseInt(String(q.id ?? '').split('-')[0], 10) || 1) - 1)
    const blob = imageBlobs[pageIdx]
    if (!blob) continue

    let bitmap = bitmapCache.get(pageIdx)
    if (!bitmap) {
      try {
        bitmap = await createImageBitmap(blob)
        bitmapCache.set(pageIdx, bitmap)
      } catch (err) {
        console.warn(`[crop] page ${pageIdx} 建 bitmap 失敗:`, err)
        continue
      }
    }

    const pad = 0.02
    const px = Math.max(0, bbox.x - pad)
    const py = Math.max(0, bbox.y - pad)
    const pw = Math.min(1 - px, bbox.w + pad * 2)
    const ph = Math.min(1 - py, bbox.h + pad * 2)
    const sx = Math.round(bitmap.width * px)
    const sy = Math.round(bitmap.height * py)
    const sw = Math.max(1, Math.round(bitmap.width * pw))
    const sh = Math.max(1, Math.round(bitmap.height * ph))

    const canvas = document.createElement('canvas')
    canvas.width = sw
    canvas.height = sh
    const ctx = canvas.getContext('2d')
    if (!ctx) continue
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh)
    cropMap.set(q.id, canvas.toDataURL('image/jpeg', 0.85))
  }

  // 釋放 bitmap memory
  for (const bm of bitmapCache.values()) bm.close()

  console.log(`✂️ [crop] canvas 裁切完成：${cropMap.size}/${questions.length} 題`)
  return cropMap
}

/**
 * 從多張答案卷圖片中抽取 AnswerKey（一次上傳多張圖片）
 * 支持答案卷跨多頁的情況
 */
export async function extractAnswerKeyFromImages(
  answerSheetImages: Blob[],
  opts?: ExtractAnswerKeyOptions
): Promise<AnswerKey> {
  if (!isGeminiAvailable) throw new Error('Gemini 服務未設定')
  if (answerSheetImages.length === 0) throw new Error('至少需要提供一張圖片')

  const isInferMode = opts?.inferMode === 'infer_blank'
  const isAnswerOnly = opts?.answerSheetMode === 'answer_only'
  // startPage: page number of the first image in this batch (1-based, default 1)
  // totalPages: total pages across ALL batches — determines whether page prefix is needed
  const startPage = opts?.startPage ?? 1
  const totalPages = opts?.totalPages ?? answerSheetImages.length
  const needsPagePrefix = totalPages > 1

  console.log(`🧾 開始從 ${answerSheetImages.length} 張圖片${isInferMode ? '推論（空白作業模式）' : (isAnswerOnly ? '抽取（純答題卡模式）' : '抽取（解答圖模式）')} AnswerKey... startPage=${startPage} totalPages=${totalPages}`)

  const prompt = isInferMode
    ? buildInferFromBlankPrompt(opts?.domain)
    : (isAnswerOnly
      ? buildAnswerKeyAnswerOnlyPrompt(opts?.domain)
      : buildAnswerKeyPrompt(opts?.domain))
  console.log('📋 [AnswerKey prompt]', prompt)

  // 多圖片提示增強
  const pageIdRule = needsPagePrefix
    ? `\n- 【題目 ID 規則（多頁模式）⚠️關鍵】ID 第一段必須是「第幾張照片」的編號，絕對不可使用答案卷上印刷的頁碼。\n  格式：<照片序號>-<大題印刷號>-<第幾小題>-...\n  • <照片序號>：即這張照片是本次上傳的第幾張（1, 2, 3...），與答案卷紙張上印刷的頁碼無關\n  • <大題印刷號>：直接使用答案卷上印刷的大題號（阿拉伯數字）。例如卷上印「三、」或「習答3」→ 用 3；印「4-3」或「習答1」→ 看該大題的實際編號。若無明確印刷號則依出現順序補號。\n  • <第幾小題>：此大題第1小題=1，第2小題=2，依此類推\n  ❌ 錯誤（第1張照片，大題印刷號是3）：用出現順序 → "1-1-1"（bug：忽略了印刷號3）\n  ✅ 正確（第1張照片，大題印刷號是3）→ "1-3-1"；同頁另一大題印刷號是1 → "1-1-1"\n  ⚠️ 同一張照片可能含多個不同印刷號的大題（如左側印「習答3」、右側印「習答1」），各自用各自的印刷號`
    : ''
  // 每張照片的頁碼前綴清單（供 AI 對應）
  const pagePrefixList = needsPagePrefix
    ? Array.from({ length: answerSheetImages.length }, (_, i) => {
        const pageNum = startPage + i
        return `第 ${pageNum} 張 → 前綴 "${pageNum}-"`
      }).join('；')
    : ''

  const multiImageNote = isInferMode
    ? `【多張圖片處理】\n- 你會收到 ${answerSheetImages.length} 張空白作業圖片\n- 請從所有圖片中推論所有題目的正確答案，合併成完整 AnswerKey${pageIdRule}`
    : needsPagePrefix
      ? `【多張圖片處理 - 多頁模式】\n- 你會收到 ${answerSheetImages.length} 張答案卷圖片，每張照片有獨立的 ID 前綴：${pagePrefixList}\n- ⚠️ 嚴格禁止把第 2 張以後的題目用 "1-" 開頭，必須依照上方對應關係填入正確前綴\n- 請從所有圖片中提取題目，合併成一個完整的 AnswerKey${pageIdRule}\n- totalScore 是所有圖片中所有題目的 maxScore 總和`
      : `【多張圖片處理】\n- 你會收到 ${answerSheetImages.length} 張答案卷圖片\n- 這些圖片是同一份作業的不同頁面\n- 請從所有圖片中提取題目，合併成一個完整的 AnswerKey\n- totalScore 是所有圖片中所有題目的 maxScore 總和`
  const multiImagePrompt = `${prompt}\n\n${multiImageNote}`.trim()

  // 準備多圖片請求（每張照片前插入頁碼標記，讓 AI 明確知道頁碼）
  const requestParts: GeminiRequestPart[] = [multiImagePrompt]

  // 添加所有圖片，並在每張前插入頁碼標記（使用全域頁碼 startPage+i）
  for (let i = 0; i < answerSheetImages.length; i++) {
    const pageNum = startPage + i
    const pageLabel = needsPagePrefix
      ? `--- 第 ${pageNum} 張照片（頁碼 ${pageNum}，此頁所有題目 id 前綴為 "${pageNum}-"）---`
      : `--- 第 1 張照片 ---`
    requestParts.push(pageLabel)
    const imageBase64 = await blobToBase64(answerSheetImages[i])
    const mimeType = answerSheetImages[i].type || 'image/jpeg'
    requestParts.push({
      inlineData: { mimeType, data: imageBase64 }
    })
    console.log(`  📄 已添加第 ${pageNum} 張圖片（頁碼前綴 "${needsPagePrefix ? `${pageNum}-` : '無'}"）`)
  }

  console.log('🤖 發送請求到 Gemini API...')
  const text = (await generateGeminiText(currentModelName, requestParts, {
    routeKey: 'answer_key.extract',
    answerSheetMode: opts?.answerSheetMode
  }))
    .replace(/```json|```/g, '')
    .trim()

  console.log('📥 [AnswerKey raw response]', text)
  let result = normalizeAnswerKeyShortAnswerDimensions(JSON.parse(text) as AnswerKey, opts?.domain)

  // 排序：純 ID natural sort（信任 AI 已按閱讀順序生成 ID）
  // 過去用 bbox 位置 + 佈局策略（考卷雙欄 / 習作橫向直向）排序，但：
  // 1. 依賴 bbox 準確度，bbox 不準排序就錯
  // 2. 各種佈局需要不同邏輯（30+ 行特例）
  // 3. AI 本來就被要求按閱讀順序輸出 ID（"依題目順序補上"）
  // 改成純 ID 排序後，所有佈局都共用同一邏輯。
  result.questions.sort((a, b) => compareNaturalIds(a.id, b.id))

  // 根據 ID 首段（照片序號，1-based）設定 pageIndex（0-based），供預覽底圖選取
  for (const q of result.questions) {
    const pageNum = parseInt(String(q.id ?? '').split('-')[0], 10)
    if (pageNum >= 1) q.pageIndex = pageNum - 1
  }

  // Quality gate + auto-retry (1 attempt)
  const qg = checkAnswerKeyQuality(result, answerSheetImages.length)
  if (qg.shouldRetry) {
    console.warn('[AnswerKey QG] quality FAIL, retrying (1/1):', qg.reasons)
    try {
      const retryText = (await generateGeminiText(currentModelName, requestParts, {
        routeKey: 'answer_key.extract'
      })).replace(/```json|```/g, '').trim()
      let retryResult = normalizeAnswerKeyShortAnswerDimensions(JSON.parse(retryText) as AnswerKey, opts?.domain)
      const retryQg = checkAnswerKeyQuality(retryResult, answerSheetImages.length)
      console.log('[AnswerKey QG] retry result:', retryQg.reasons.length === 0 ? 'pass' : retryQg.reasons)
      // Re-apply pageIndex on retry result before merge
      for (const q of retryResult.questions) {
        const pageNum = parseInt(String(q.id ?? '').split('-')[0], 10)
        if (pageNum >= 1) q.pageIndex = pageNum - 1
      }
      // Merge: keep first run's good questions, only override broken ones from retry
      result = mergeAnswerKeyResults(result, retryResult)
    } catch (retryErr) {
      console.warn('[AnswerKey QG] retry failed:', retryErr)
    }
  }

  console.log(`✅ 成功提取 ${result.questions.length} 題，總分 ${result.totalScore}`)

  // ─── Phase 2: locate（並行 per-page）+ Phase 3: canvas crop ──────────────
  // Server 端 extract 只回題目，bbox 由這裡接手
  if (result.questions.length > 0 && answerSheetImages.length > 0) {
    try {
      const bboxMap = await locateAnswerKeyBboxesAcrossPages(result.questions, answerSheetImages)
      // 寫回 answerBbox
      for (const q of result.questions) {
        const bbox = bboxMap.get(q.id)
        if (bbox) q.answerBbox = bbox
      }
      // canvas 裁切 → cropImageUrl
      const cropMap = await cropAnswerKeyQuestionsOnCanvas(result.questions, bboxMap, answerSheetImages)
      for (const q of result.questions) {
        const cropUrl = cropMap.get(q.id)
        if (cropUrl) q.cropImageUrl = cropUrl
      }
    } catch (err) {
      // locate / crop 失敗不應該阻斷 extract（題目辨識已成功）；老師仍可手動框
      console.warn('⚠️ [AnswerKey] locate / crop 階段失敗，跳過自動 bbox：', err)
    }
  }

  return result
}

/**
 * 重新分析被標記的題目
 * 只針對 needsReanalysis === true 的題目重新分析
 */
export async function reanalyzeQuestions(
  answerSheetImages: Blob | Blob[],
  markedQuestions: import('./db').AnswerKeyQuestion[],
  domain?: string
): Promise<import('./db').AnswerKeyQuestion[]> {
  if (!isGeminiAvailable) throw new Error('Gemini 服務未設定')

  if (markedQuestions.length === 0) {
    return []
  }

  console.log(`🔄 重新分析 ${markedQuestions.length} 題...`)

  const images = Array.isArray(answerSheetImages) ? answerSheetImages : [answerSheetImages]
  const needsPagePrefix = images.length > 1
  const questionIds = markedQuestions.map((q) => q.id).join(', ')
  const basePrompt = buildAnswerKeyPrompt(domain)

  const pageIdRule = needsPagePrefix
    ? `\n- 【題目 ID 規則（多頁模式）】ID 第一段為照片序號（1, 2, 3...），與答案卷印刷頁碼無關。`
    : ''
  const pagePrefixList = needsPagePrefix
    ? Array.from({ length: images.length }, (_, i) => `第 ${i + 1} 張 → 前綴 "${i + 1}-"`).join('；')
    : ''

  const reanalyzePrompt = `
${basePrompt}
${needsPagePrefix ? `\n【多張圖片處理 - 多頁模式】\n- 你會收到 ${images.length} 張答案卷圖片，每張照片有獨立的 ID 前綴：${pagePrefixList}\n- ⚠️ 嚴格禁止把第 2 張以後的題目用 "1-" 開頭${pageIdRule}` : ''}

【重新分析模式 - 強制完整輸出】
必須重新分析以下題號：${questionIds}（共 ${markedQuestions.length} 題）

⚠️ 強制要求：
- 必須輸出所有 ${markedQuestions.length} 題的完整資料
- 即使某題在圖片中看不清楚，也必須輸出該題的記錄
  ⚠️ 但「輸出記錄」≠「腦補答案」！
  - ✅ 正確：看不清楚 → 在 referenceAnswer 標記「圖片中無法辨識」
  - ❌ 錯誤：看不清楚 → 腦補一個答案
- 題號順序可以不同，但數量必須完全一致
- 禁止遺漏任何題號

其他題目請忽略，不要輸出。

請仔細辨識這些題目的內容，重新判斷類型並提取答案。
`.trim()

  const parts: GeminiRequestPart[] = [reanalyzePrompt]
  for (let i = 0; i < images.length; i++) {
    if (needsPagePrefix) parts.push(`--- 第 ${i + 1} 張照片（此頁所有題目 id 前綴為 "${i + 1}-"）---`)
    const imageBase64 = await blobToBase64(images[i])
    const mimeType = images[i].type || 'image/jpeg'
    parts.push({ inlineData: { mimeType, data: imageBase64 } })
  }

  const text = (await generateGeminiText(currentModelName, parts, {
    routeKey: 'answer_key.reanalyze'
  }))
    .replace(/```json|```/g, '')
    .trim()

  const result = normalizeAnswerKeyShortAnswerDimensions(
    JSON.parse(text) as import('./db').AnswerKey,
    domain
  )

  const requestedIds = markedQuestions.map((q) => q.id)
  const returnedIds = result.questions.map((q) => q.id)
  const missingIds = requestedIds.filter((id) => !returnedIds.includes(id))

  if (missingIds.length > 0) {
    console.warn(`⚠️ AI 遺漏了 ${missingIds.length} 題：${missingIds.join(', ')}`)
    console.warn(`要求分析：${requestedIds.join(', ')}`)
    console.warn(`實際回傳：${returnedIds.join(', ')}`)

    const placeholderQuestions = missingIds.map((id) => {
      const originalQuestion = markedQuestions.find((q) => q.id === id)!
      return {
        id,
        questionCategory: 'fill_variants' as import('./db').QuestionCategory,
        maxScore: originalQuestion.maxScore || 0,
        referenceAnswer: 'AI 無法從圖片中重新辨識此題，請手動編輯',
        acceptableAnswers: [],
        needsReanalysis: true
      }
    })

    result.questions.push(...placeholderQuestions)
    console.log(`🔧 已自動為遺漏的 ${missingIds.length} 題創建佔位項（需手動編輯）`)
  }

  // 根據 ID 首段設定 pageIndex（0-based）
  for (const q of result.questions) {
    const pageNum = parseInt(String(q.id ?? '').split('-')[0], 10)
    if (pageNum >= 1) q.pageIndex = pageNum - 1
  }

  console.log(`✅ 重新分析完成，共 ${result.questions.length} 題（要求 ${markedQuestions.length} 題）`)

  return result.questions
}

// ─── Phase A：一致性預處理 ────────────────────────────────────────────────────
/**
 * 執行批改 Phase A（Classify + Crop + ReadAnswer×2 + Consistency）
 * 回傳 PhaseAResult，包含每題的一致性狀態與兩次讀取結果。
 * 老師確認後再呼叫 gradePhaseB。
 */
export interface ClassifyCorrection {
  questionId: string
  type: 'neighbor_match' | 'consecutive_blank'
  neighborId?: string
}

export async function gradePhaseA(
  submissionImageBlob: Blob,
  answerKey: AnswerKey,
  pageBreaks?: number[],
  domain?: string,
  assignmentId?: string,
  classifyCorrections?: ClassifyCorrection[],
  answerSheetMode?: 'with_questions' | 'answer_only',
  submissionId?: string
): Promise<PhaseAResult> {
  const normalizedAnswerKey = normalizeAnswerKeyShortAnswerDimensions(answerKey, domain)
  const { sessionId: inkSessionId } = await ensureInkSessionFresh()

  const compressed = await compressForGemini(submissionImageBlob, GEMINI_SINGLE_IMAGE_TARGET_BYTES, 'phase-a')
  const imageBase64 = await blobToBase64(compressed)
  const mimeType = compressed.type || submissionImageBlob.type || 'image/jpeg'

  const buildPhaseABody = (sid: string | null) => JSON.stringify({
    model: currentModelName,
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data: imageBase64 } }] }],
    ...(sid ? { inkSessionId: sid } : {}),
    routeKey: 'grading.phase_a',
    answerKey: JSON.stringify(normalizedAnswerKey),
    ...(domain ? { domain } : {}),
    ...(pageBreaks && pageBreaks.length > 0 ? { pageBreaks } : {}),
    ...(assignmentId ? { assignmentId } : {}),
    ...(submissionId ? { submissionId } : {}),
    ...(classifyCorrections && classifyCorrections.length > 0 ? { classifyCorrections } : {}),
    ...(answerSheetMode && answerSheetMode !== 'with_questions' ? { answerSheetMode } : {})
  })

  let response = await fetch(geminiProxyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: buildPhaseABody(inkSessionId)
  })

  if (response.status === 409) {
    console.warn('[gradePhaseA] Ink session not found (409), creating new session and retrying...')
    setInkSessionId(null)
    const { sessionId: newSessionId } = await startInkSession()
    response = await fetch(geminiProxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: buildPhaseABody(newSessionId)
    })
  }

  if (!response.ok) {
    const err = await response.json().catch(() => ({})) as Record<string, unknown>
    throw new Error((err?.error as string) || `Phase A failed: ${response.status}`)
  }

  const data = await response.json()

  if (typeof data?.ink?.balanceAfter === 'number' && Number.isFinite(data.ink.balanceAfter)) {
    dispatchInkBalance(data.ink.balanceAfter)
  }

  const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error('Phase A: empty response text')

  const parsed = JSON.parse(text) as PhaseAResult
  if (!parsed?.phaseAComplete) throw new Error('Phase A: unexpected response format (phaseAComplete missing)')

  return parsed
}

// ─── Phase Bbox：只跑 Classify，回傳 bbox ─────────────────────────────────
export async function gradeClassifyOnly(
  submissionImageBlob: Blob,
  answerKey: AnswerKey,
  pageBreaks?: number[],
  domain?: string,
  assignmentId?: string,
  answerSheetMode?: 'with_questions' | 'answer_only',
  submissionId?: string
): Promise<{ classifyOnly: true; bboxResults: Array<{ questionId: string; questionType: string; answerBbox: any }> }> {
  const normalizedAnswerKey = normalizeAnswerKeyShortAnswerDimensions(answerKey, domain)
  const { sessionId: inkSessionId } = await ensureInkSessionFresh()
  const compressed = await compressForGemini(submissionImageBlob, GEMINI_SINGLE_IMAGE_TARGET_BYTES, 'classify-only')
  const imageBase64 = await blobToBase64(compressed)
  const mimeType = compressed.type || submissionImageBlob.type || 'image/jpeg'

  const response = await fetch(geminiProxyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      model: currentModelName,
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data: imageBase64 } }] }],
      ...(inkSessionId ? { inkSessionId } : {}),
      routeKey: 'grading.phase_a',
      answerKey: JSON.stringify(normalizedAnswerKey),
      classifyOnly: true,
      ...(domain ? { domain } : {}),
      ...(pageBreaks && pageBreaks.length > 0 ? { pageBreaks } : {}),
      ...(assignmentId ? { assignmentId } : {}),
      ...(submissionId ? { submissionId } : {}),
      ...(answerSheetMode && answerSheetMode !== 'with_questions' ? { answerSheetMode } : {})
    })
  })
  if (!response.ok) throw new Error(`classifyOnly failed: ${response.status}`)
  const raw = JSON.parse(await response.text())
  // Server 包在 candidates 結構裡，需要解出實際內容
  const text = raw?.candidates?.[0]?.content?.parts?.[0]?.text
  return text ? JSON.parse(text) : raw
}

// ─── Phase Read：帶校正 bbox 跑 Read + AI3 ─────────────────────────────────
export interface BboxOverride {
  questionId: string
  answerBbox: { x: number; y: number; w: number; h: number } | null
  corrected?: boolean
}

export async function gradeWithBboxOverrides(
  submissionImageBlob: Blob,
  answerKey: AnswerKey,
  bboxOverrides: BboxOverride[],
  pageBreaks?: number[],
  domain?: string,
  assignmentId?: string,
  answerSheetMode?: 'with_questions' | 'answer_only',
  submissionId?: string
): Promise<PhaseAResult> {
  const normalizedAnswerKey = normalizeAnswerKeyShortAnswerDimensions(answerKey, domain)
  const { sessionId: inkSessionId } = await ensureInkSessionFresh()
  const compressed = await compressForGemini(submissionImageBlob, GEMINI_SINGLE_IMAGE_TARGET_BYTES, 'read-with-overrides')
  const imageBase64 = await blobToBase64(compressed)
  const mimeType = compressed.type || submissionImageBlob.type || 'image/jpeg'

  const response = await fetch(geminiProxyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      model: currentModelName,
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data: imageBase64 } }] }],
      ...(inkSessionId ? { inkSessionId } : {}),
      routeKey: 'grading.phase_a',
      answerKey: JSON.stringify(normalizedAnswerKey),
      bboxOverrides,
      ...(domain ? { domain } : {}),
      ...(pageBreaks && pageBreaks.length > 0 ? { pageBreaks } : {}),
      ...(assignmentId ? { assignmentId } : {}),
      ...(submissionId ? { submissionId } : {}),
      ...(answerSheetMode && answerSheetMode !== 'with_questions' ? { answerSheetMode } : {})
    })
  })
  if (!response.ok) throw new Error(`gradeWithBboxOverrides failed: ${response.status}`)
  const data = await response.json()
  const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error('Phase Read: empty response text')
  const parsed = JSON.parse(text) as PhaseAResult
  if (!parsed?.phaseAComplete) throw new Error('Phase Read: unexpected response format')
  return parsed
}

// ─── Phase B：正式批改（Accessor + Explain）─────────────────────────────────
/**
 * 執行批改 Phase B（Accessor + Explain）
 * 需要老師透過 ConsistencyReviewPanel 確認所有 diff/unstable 題目後再呼叫。
 * @param submissionImageBlob 原始作業圖片（Blob）
 * @param phaseAResult gradePhaseA 回傳的結果（含 _phaseContext）
 * @param finalAnswers 老師確認後的最終答案列表
 */
export async function gradePhaseB(
  submissionImageBlob: Blob,
  phaseAResult: PhaseAResult,
  finalAnswers: FinalAnswer[],
  domain?: string,
  assignmentId?: string,
  answerSheetMode?: 'with_questions' | 'answer_only',
  submissionId?: string
): Promise<GradingResult> {
  const { sessionId: inkSessionId } = await ensureInkSessionFresh()

  const compressed = await compressForGemini(submissionImageBlob, GEMINI_SINGLE_IMAGE_TARGET_BYTES, 'phase-b')
  const imageBase64 = await blobToBase64(compressed)
  const mimeType = compressed.type || submissionImageBlob.type || 'image/jpeg'

  // Strip answerCropImageUrl from questionResults before sending —
  // Phase B server doesn't need them and base64 images make the payload too large for the API.
  const phaseAForServer = {
    ...phaseAResult,
    questionResults: phaseAResult.questionResults.map(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      ({ answerCropImageUrl: _removed, ...qr }) => qr
    ),
  }

  const buildPhaseBBody = (sid: string | null) => JSON.stringify({
    model: currentModelName,
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data: imageBase64 } }] }],
    ...(sid ? { inkSessionId: sid } : {}),
    routeKey: 'grading.phase_b',
    phaseAResult: phaseAForServer,
    finalAnswers,
    ...(domain ? { domain } : {}),
    ...(assignmentId ? { assignmentId } : {}),
    ...(submissionId ? { submissionId } : {}),
    ...(answerSheetMode && answerSheetMode !== 'with_questions' ? { answerSheetMode } : {})
  })

  let response = await fetch(geminiProxyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: buildPhaseBBody(inkSessionId)
  })

  if (response.status === 409) {
    console.warn('[gradePhaseB] Ink session not found (409), creating new session and retrying...')
    setInkSessionId(null)
    const { sessionId: newSessionId } = await startInkSession()
    response = await fetch(geminiProxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: buildPhaseBBody(newSessionId)
    })
  }

  if (!response.ok) {
    const err = await response.json().catch(() => ({})) as Record<string, unknown>
    let errMsg = `Phase B failed: ${response.status}`
    if (typeof err?.error === 'string' && err.error) {
      errMsg = err.error
    } else if (err?.error && typeof err.error === 'object') {
      const nested = err.error as Record<string, unknown>
      errMsg = (typeof nested.message === 'string' && nested.message)
        || (typeof nested.status === 'number' ? `Phase B failed: ${nested.status}` : '')
        || JSON.stringify(err.error).slice(0, 200)
    } else if (typeof err?.message === 'string' && err.message) {
      errMsg = err.message
    }
    throw new Error(errMsg)
  }

  const data = await response.json()

  if (typeof data?.ink?.balanceAfter === 'number' && Number.isFinite(data.ink.balanceAfter)) {
    dispatchInkBalance(data.ink.balanceAfter)
  }

  const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error('Phase B: empty response text')

  const parsed = JSON.parse(text.replace(/```json|```/g, '').trim()) as GradingResult
  return parsed
}

/**
 * 非同步概念標記：對已抽取的答案鍵題目，發送獨立 API 請求取得 108課綱 concept_code
 * 回傳 Record<questionId, { code, label }>，失敗時回傳空物件
 */
function parseTagsResponse(text: string): Record<string, { code: string; label: string }> {
  const parsed = JSON.parse(text.replace(/```json|```/g, '').trim()) as {
    tags: Array<{ questionId: string; concept_code: string | null; concept_label: string | null }>
  }
  const result: Record<string, { code: string; label: string }> = {}
  for (const tag of parsed.tags ?? []) {
    if (tag.questionId && tag.concept_code && tag.concept_label) {
      result[tag.questionId] = { code: tag.concept_code, label: tag.concept_label }
    }
  }
  return result
}

/**
 * 非同步概念標記：對已抽取的答案鍵題目，發送獨立 API 請求取得 108課綱 concept_code
 * 回傳 Record<questionId, { code, label }>，失敗時回傳空物件
 */
export async function tagConceptsForAnswerKey(
  answerSheetImages: Blob[],
  questions: Array<{ id: string; questionCategory?: string; answer?: string }>,
  conceptMap: { code: string; label: string; description?: string }[]
): Promise<Record<string, { code: string; label: string }>> {
  if (!isGeminiAvailable) throw new Error('Gemini 服務未設定')
  if (questions.length === 0 || conceptMap.length === 0) return {}

  const imageParts: GeminiRequestPart[] = []
  for (const img of answerSheetImages) {
    const imageBase64 = await blobToBase64(img)
    imageParts.push({ inlineData: { mimeType: img.type || 'image/jpeg', data: imageBase64 } })
  }

  const callOnce = async (qs: Array<{ id: string; questionCategory?: string }>) => {
    const prompt = buildTagConceptsPrompt(qs, conceptMap)
    const text = (await generateGeminiText(currentModelName, [prompt, ...imageParts], {
      routeKey: 'answer_key.tag_concepts'
    })).replace(/```json|```/g, '').trim()
    return parseTagsResponse(text)
  }

  // 第一次呼叫
  const result = await callOnce(questions)

  // 檢查是否有遺漏題目，最多補一次
  const missingIds = questions.map(q => q.id).filter(id => !(id in result))
  if (missingIds.length > 0) {
    console.warn(`⚠️ [tag_concepts] 遺漏 ${missingIds.length} 題，補標一次：`, missingIds)
    const missingQuestions = questions.filter(q => missingIds.includes(q.id))
    try {
      const retryResult = await callOnce(missingQuestions)
      Object.assign(result, retryResult)
      const stillMissing = missingIds.filter(id => !(id in result))
      if (stillMissing.length > 0) {
        console.warn(`⚠️ [tag_concepts] 補標後仍遺漏 ${stillMissing.length} 題（無對應概念）：`, stillMissing)
      }
    } catch (err) {
      console.warn('⚠️ [tag_concepts] 補標失敗（非致命）', err)
    }
  }

  return result
}
