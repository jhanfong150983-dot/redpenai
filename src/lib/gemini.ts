import {
  db,
  type Submission,
  type GradingResult,
  type AnswerKey,
  type AnswerKeyQuestion,
  type AnswerExtractionCorrection
} from './db'
import { normalizeLevelRubric, validateLevelRubric } from './levelRubric'
import { mathAnswersEquivalent } from './mathEquivalence'
import { blobToBase64 as blobToDataUrl, compressImageFile } from './imageCompression'
import { isIndexedDbBlobError, shouldAvoidIndexedDbBlob } from './blob-storage'
import { dispatchInkBalance } from './ink-events'
import { getInkSessionId, startInkSession, setInkSessionId, ensureInkSessionFresh } from './ink-session'

const geminiProxyUrl = import.meta.env.VITE_GEMINI_PROXY_URL || '/api/proxy'

// 2026-07-31 學校計費(user 拍板):行政端(學校檢視)期間所有 proxy 呼叫掛 x-school-billing header,
// server 驗證行政身分後改扣學校錢包;教師端無 context、行為完全不變。唯一收口點。
import { getSchoolBillingContext, dispatchSchoolWalletBalance } from '@/lib/school-billing'
async function proxyFetch(init: RequestInit): Promise<Response> {
  const sb = getSchoolBillingContext()
  if (sb) {
    init = { ...init, headers: { ...((init.headers as Record<string, string>) || {}), 'x-school-billing': sb } }
  }
  const res = await fetch(geminiProxyUrl, init)
  // 學校計費回應帶 ink.balanceAfter → 即時廣播給學校檢視 header(clone 不影響原回應)
  if (sb && res.ok) {
    void res
      .clone()
      .json()
      .then((d) => {
        const ink = d?.ink
        if (ink?.schoolBilling && typeof ink.balanceAfter === 'number') {
          dispatchSchoolWalletBalance(ink.balanceAfter)
        }
      })
      .catch(() => {})
  }
  return res
}

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
// 批量批改並行數。2026-06-29：整班批改慢的主因＝這裡鎖 2（30 人=15 輪）。提高到 8（比原始約 4x 快）。
// 實測（同把 key 併發爬坡 local-only/exp-extract-fillblank-2026-06-25）：raw read call 並發到 64 都 0 個 429、
// 延遲優雅成長(31→75s)；Vercel proxy maxDuration=300s（最慢 read 75s 仍 4x 餘裕）；Pro 並發數遠超所需。
// 三關（Gemini 429 / Vercel duration / Vercel 並發）K=8(=16 並發 call) 皆 4x+ 餘裕。
// 可用 VITE_BATCH_GRADING_CONCURRENCY 微調（撞 429 就調降、想更快可推 16；搭 model-adapter 429 Retry-After+jitter 退避）。
const BATCH_GRADING_CONCURRENCY = Math.max(1, Number(import.meta.env?.VITE_BATCH_GRADING_CONCURRENCY) || 8)
// 每個 worker 完成一份後的節流延遲
const BATCH_GRADING_STAGGER_MS = 800

// 2026-06-30：read 階段專屬「全域」限流閘（跨所有批改路徑共用、module 級狀態）。
//   為什麼只 gate read：read1+read2 是多 crop 重 call，高併發下會「整批 mass-blank」(回 HTTP 200 但內容全空、
//   不是 429/504 → 既有以 429 為準的併發監控抓不到) → 兩讀分歧爆 NR、批改跨次極不一致(同卷一次 4 題 NR、一次 17 題)。
//   classify/arbiter/accessor 不過閘、維持各自批次併行(8)——classify 8 沒問題、問題只在 read。
//   因為所有批改路徑(executeGrading / executeRecaptureOnly / 重跑)的 read 都走 gradePhaseA 的 Call 2，
//   在那一支包這個閘就能「一處覆蓋全部路徑、只節流 read」。可用 VITE_READ_STAGE_CONCURRENCY 微調。
// 2026-07-02：預設 8(user：type-split 不太 mass-blank、要 8)。⚠️若關 type-split(走全域 2.5)、8 會較易 mass-blank、宜降回 4。
const READ_STAGE_CONCURRENCY = Math.max(1, Number(import.meta.env?.VITE_READ_STAGE_CONCURRENCY) || 8)
let _readActive = 0
const _readQueue: Array<() => void> = []
async function withReadSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (_readActive >= READ_STAGE_CONCURRENCY) {
    await new Promise<void>((resolve) => { _readQueue.push(resolve) })
  }
  _readActive++
  try { return await fn() } finally {
    _readActive--
    const next = _readQueue.shift()
    if (next) next()
  }
}

// Gemini 圖片壓縮的解析度底線
const GEMINI_MIN_WIDTH = 1200      // 一般字 + 手寫仍清楚
const GEMINI_HARD_MIN_WIDTH = 1024 // 再低就容易糊，寧可大一點

async function compressForGemini(
  blob: Blob,
  targetBytes: number,
  label: string
): Promise<Blob> {
  // 2026-07-02：加 15% 容忍帶——「只超標一點點」不重壓。
  //   實證災難：1205KB 卷只超 1.2MB 門檻 5KB → 重壓 webp q82 只省 56KB(4%)，但已壓縮過的 webp
  //   二次壓縮世代損失讓細手寫行糊掉 → read1 盲讀整句丟字(「It is idea」)、read2 知答讀得出
  //   → 全班 fill_blank 假性 NR(沙盒 100% 重現：原圖 read1 stable 16/16、重壓後 2/16)。
  //   1.38MB(base64 ~1.9MB) 離 Vercel 4.5MB body 限制仍遠、安全。
  if (blob.size <= targetBytes * 1.15) return blob

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
  | 'answer_key.solve'
  | 'answer_key.read_reference'
  | 'answer_key.locate'
  | 'answer_key.reanalyze'
  | 'answer_key.tag_concepts'
  | 'grading.vj_rubric'
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
  // 2026-07-05: partValues＝合題（fill_blank parts）逐空讀值（server questionResults 傳下來、審查卡四小格用）
  readAnswer1: { status: string; studentAnswer: string; partValues?: Array<{ subId: string; student: string }> }
  readAnswer2: { status: string; studentAnswer: string; partValues?: Array<{ subId: string; student: string }> }
  answerCropImageUrl?: string
  answerBbox?: { x: number; y: number; w: number; h: number }
  arbiterResult?: ArbiterResult  // 三AI辯證裁決結果（新架構）
  // 2026-05-28: map_fill per-position readings（server 端 Phase A 3-AI 後產出）
  mapFillReadings?: {
    ai1: Array<{ position_idx: number; student_text: string }>
    ai2: Array<{ position_idx: number; student_text: string }>
    perPosition: Array<{
      idx: number
      name: string
      desc: string
      ai1_text: string
      ai2_text: string
      consistent: boolean
    }>
  }
  // 2026-05-30: VJ 視覺判斷題 per-item blank 分類（server Phase A 單一 PRO blank reader 後產出）
  // auto_not_blank=有畫→自動送 grade；review_blank=空白→老師確認是否作答
  visualJudgment?: {
    itemLabels: string[]
    perItem: Array<{
      idx: number
      label: string
      hasMark: 'yes' | 'no'
      status: 'auto_not_blank' | 'review_blank'
    }>
  }
}

export interface PhaseAContext {
  answerKey?: AnswerKey
  questionIds?: string[]
  classifyResult?: unknown
  readAnswerResult?: unknown
  pipelineRunId?: string
  stagedLogLevel?: string
}

export interface PipelineFailure {
  stage: 'classify' | 'read' | 'arbiter'
  reasonCode: string
  userMessage: string   // 老師看的中文說明
  userAction: string    // 建議的處置方式
  technical?: { warnings?: string[]; metrics?: Record<string, unknown> }  // 收合給工程師看
}

export interface PhaseAResult {
  phaseAComplete: boolean
  pipelineFailure?: PipelineFailure  // 設定時表示 Phase A 失敗、不可進 Phase B
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
  // 2026-05-28: map_fill 每位置確認後的學生文字（給 Phase B 跑 deterministic match）
  mapFillFinalReadings?: Array<{ position_idx: number; student_text: string }>
  // 2026-05-30: VJ 每子元素確認後的 blank 狀態（給 Phase B 決定哪些項要跑 grade）
  vjBlankConfirmed?: Array<{ idx: number; isBlank: boolean }>
}

// 2026-05-18: 5-stage 進度回報、給 UI overlay 顯示「目前跑到第幾階段」
//   classify  = Phase A call 1（版面掃描）
//   read      = Phase A call 2（讀取答案 AI1+AI2）
//   arbiter   = Phase A call 3（仔細校對 AI3）
//   accessor  = Phase B call 1（批改評分）
//   explain   = Phase B call 2（生成引導）
export type GradingStageName = 'classify' | 'read' | 'arbiter' | 'accessor' | 'explain'
export type GradingStageEvent = 'started' | 'completed'
export type GradingStageCallback = (stage: GradingStageName, event: GradingStageEvent) => void

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

  const response = await proxyFetch({
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
// 注意：這個只是 placeholder、server 端 model-config.js 的 STAGE_MODEL 會覆寫掉
// （2026-05-21：server 端 model 分流後、client 傳什麼 server 都不吃；但仍會 log 出來、寫個別讓人誤會的字串）
let currentModelName = import.meta.env.VITE_GEMINI_MODEL || 'gemini-2.5-flash'

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
  /**
   * 題本圖（學生看的乾淨題目卷）。僅 answer_only 模式有效。
   * 若有，AI 在 extract 時可用題幹推導 short_answer 的 rubricsDimensions criteria，
   * 比從答案內容反推大幅準確。
   */
  bookletImages?: Blob[]
  /** @internal 內部使用：fan-out sub-call 跳過 Phase 2/3 locate+crop，由 fan-out entry 在 merge 後統一執行 */
  _skipLocateCrop?: boolean
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
    "answerPos": "front",                    // 僅 fill_blank 輸出：front=答案寫在題號左側獨立答案欄／inline=寫在句中空格。非 fill_blank 省略。判準見 fill_blank Type Spec
    "bucket": "A",                           // A/B/C/D，可省略（系統自動推導）
    "orderMode": "strict",                   // strict | unordered
    "unorderedGroupId": "1",                 // orderMode=unordered 時必填（同組共用）
    "maxScore": 5,                           // 滿分
    "anchorHint": "比率列中有印刷括號（　）/180的空格，位於欄標題「三國演義」正下方",

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
  - ⚠️ 「id 單調遞增」**僅在同一個區塊（section/單元）內**有效。
    若一頁含多個獨立區塊（如左欄「整頁全解」大題 3,4,5 + 右欄「第6單元 練習」大題 1,2,3,4）→
    每區塊內 id 單調即可、區塊之間 id **允許跳號／降序**（如輸出順序 2-3, 2-4, 2-5, 2-1, 2-2, 2-3, 2-4）。
    🚨 嚴禁為了維持單調遞增而**漏抽某區塊的題目**（漏題比 id 不單調糟太多）。
    🚨 嚴禁把右欄區塊的「第 1, 2, 3, 4 題」renumber 成「6, 7, 8, 9」續編（學生在原卷找不到對應題號）。
    ✅ 保留原卷印刷的大題編號當 id 第 2 段、不論順序。
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
  - single_choice / single_check / multi_choice / true_false：**強制使用結構化格式**：
    「位於『<section 標題>』第 N 小題題號前的括號內」
    （N 為該題在 section 內的序號、非全卷流水號）

    <section 標題> 必須從卷面找出該題所屬大段的標題，常見格式：
    * 「題組一」「題組二」「題組三」…
    * 「壹、選擇題」「貳、是非題」「一、單選題」「二、多重選擇」…
    * 「Part A」「Part B」「Section 1」…

    🚨 同一卷若有多個 section（不論大標題是否明顯），**每一題的 anchorHint 都必須帶 section 標題**：
    - 若 section 標題明確印在卷上 → 直接用該標題
    - 若**第一個** section 沒明確大標題、但後面 section 有（例如卷上看到「題組二」、推測前面是「題組一」）→ 推測補上「題組一」
    - 若整卷只有單一連續選擇題 section、可用「壹、選擇題」或實際印刷的 section 名

    ❌ 錯誤示範：「題幹開頭為「擲出來的點數和可能大於1嗎」」（沒 section + 沒題號結構）
    ❌ 錯誤示範：「位於第3小題題號前的括號內」（缺 section 標題）
    ✅ 正確示範：「位於『題組一』第3小題題號前的括號內」
    ✅ 正確示範：「位於『壹、選擇題』第7小題題號前的括號內」
    ✅ 正確示範：「位於『Part A』第2小題題號前的括號內」

    這個格式給後續 bbox 定位 stage 用、必須嚴格遵守、不可改寫成描述性文字。
  - 目標：描述應具體到能唯一定位該格，避免使用位置詞（「左邊第三格」→ 改用欄標題）
- 表格題：請使用 table_cell type（整張表合成 1 題 + cells 陣列），不要逐格建題
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
   ⭐ 先看是不是「矩陣表格勾選」：□（或 ✓ 欄）排成**表格**、每列在多個欄位中勾格
      （如 Yes/No 清單、每天/有時/從不 頻率表、自我檢核表）→ table_check（**整表 1 題**，不要逐列拆 single_check）
   ├─ 勾一個（單列 □ 選項，非表格矩陣）→ single_check
   └─ 勾多個 → multi_check

➍ 寫 ○ 或 ✗ 符號（單一括號內手寫對錯符號）→ true_false

➎ 填寫值（____ ／ □ ／ 表格儲存格 內填值）
   ⚠️ 先做 work area 檢查：題目下方/旁邊有沒有預留空白讓學生**寫算式或計算過程**？
      • 沒 work area / 學生只填了單一值 → 繼續走「純填值」分支
      • 有 work area + 學生實際寫了算式步驟 → 走「填值+算式」分支

   ─ 純填值（無算式步驟）：
   ⭐ 優先檢查：答案位置是否在「規則表格內某 cell」？

      判斷準則（任一強烈訊號 OR 同時滿足三條件即可）：

      【強烈訊號：100% 是 table_cell】
      ★ **統計表**：第 1 列是項目分類（如水果/科目/交通工具/班別）、
         前幾列是已知數據（如人數/票數/數量、含「總計」格如 360/100）、
         最後幾列是學生計算結果（如比率/百分比/分數/平均）。
         即使格線淡化、只要結構是「分類 + 數據 + 計算結果」、必為 table_cell。
      ★ **多項目同類計算**：同一張紙上 5 個項目都要做「同一種計算」
         （如 5 種水果各自算比率、5 個科目各自算平均），整批是 1 個任務、
         不是 5 個獨立 fill_blank。

      【一般判準：以下三條件同時滿足】
      ① 周圍有格線（即使淡、看得出表格網格）
      ② 該答案是表格內多個答案 cell 的其中一個（≥ 2 個 answer cells）
      ③ 同一張表格還有其他答案 cells

   ├─ 是（任一強烈訊號 OR 滿足三條件）→ table_cell（**整張表合成 1 題**，不要拆成多題；見 type spec 細節）
   ├─ 否（_____ 底線、( ) 括號、□ 方框、孤立 cell）→ 一個值 → fill_blank
   └─ 否，多個值（順序無關）→ multi_fill

   🚨 常見錯誤：把統計表「拆成多個 fill_blank」
      範例（錯）：水果 5 種、學生算 5 個比率 → 拆 5 個 fill_blank
      範例（對）：同上 → 1 個 table_cell + cells 陣列 5 元素
      凡同一個任務的多個答案位於規則表格內、都應合併 table_cell。

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
   ├─ 繪製長條圖/圓餅圖等「資料圖表」（有數值/比率）→ diagram_draw
   └─ 在預印圖形上塗色、或描線/畫記/標示一條線或記號（塗色／描柱高／畫對稱軸／標某邊／描輪廓，非資料圖表）→ diagram_color
       ⚠️「用筆描出某條線（如柱高）」是 diagram_color、不是 diagram_draw（diagram_draw 限長條/圓餅等資料圖表）

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
  ⚠️ 題幹可能是克漏字句（句中有空格 ___）：作答區仍是「寫／圈選項代號」的括號、不是句中的空格 → 仍判 single_choice，不要因句中空格誤判 fill_blank。

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

▸ table_check 「表格勾選題」（矩陣勾選、整表群組評分）
  視覺：矩陣表格（多列 × 多欄）+ 部分欄是可勾選欄（如 Yes/No、每天/有時/從不）+ 紅色 ✓/打勾
  動作：學生在**每一列**的可勾選欄中勾選一格（每列勾一個欄）
  ⭐ 整張表作為「1 題」，不要逐列拆成 single_check（逐列拆會失去整表 bbox、且範例列會造成位移）
  🚨 看到「每列都有紅色 ✓ 的矩陣勾選表」**一定要建成 1 個 table_check**，不可整表跳過不建題：
     - 不要因為旁邊標「無需評分」就跳過整表 —— 那只針對被標註的那一欄（如 Note 欄），勾選欄(Yes/No)仍要計分。
     - 不要因為首列是「e.g./範例」示範就把整表當裝飾 —— 範例列底下的真實列就是答題列。
     - 不要因為全部都勾同一欄（如全勾 Yes）就以為是印刷示範 —— 紅色 ✓ 是答案色、就是學生答案。

  必填欄位：
    - id：給整張表（如 "4-I-1"，依大題印刷號）
    - questionCategory：'table_check'
    - answerBbox：**整張表的外框 bbox**（從表格最上格線到最下格線、最左到最右）
    - checkColumns：可勾選的欄標題陣列（如 ["Yes","No"]）。
        ⚠️ **不計分的欄不放進來**（如標「無需評分／範例」的 Note 欄、純說明欄）。
    - rows：每一「計分列」一元素：
        { label: "該列的列標題（如 bedroom）", answer: "被勾欄的欄標題（如 Yes）" }
        ⚠️ answer = checkColumns 之一的欄標題文字（精確比對）。
    - maxScore：整題總分（預設 = rows 數量，老師可調）

  ⚠️ 範例列處理：表格首列若是「e.g./例/範例」示範列 → **不放進 rows**（不計分、僅供學生對位），
     rows 只放真正要計分的列。整表仍是 1 題、不因範例列多算一列。

  範例：「House for Rent」勾選表，欄 = Rooms/Yes/No/Note（Note 標「無需評分」），
        5 個計分列（bedroom/dining room/study room/bathroom/kitchen）全勾 Yes，首列 e.g. living room 為範例：
    {
      "id": "4-I-1",
      "questionCategory": "table_check",
      "maxScore": 5,
      "checkColumns": ["Yes", "No"],
      "rows": [
        { "label": "bedroom",     "answer": "Yes" },
        { "label": "dining room", "answer": "Yes" },
        { "label": "study room",  "answer": "Yes" },
        { "label": "bathroom",    "answer": "Yes" },
        { "label": "kitchen",     "answer": "Yes" }
      ]
    }
  ⚠️ 與 single_check 區別：single_check 是「一列 □ 選項勾 1 個」（單列）；table_check 是「多列矩陣、每列各勾一格」。
  ⚠️ 與 table_cell 區別：table_cell 學生在格內**填值**；table_check 學生在格內**勾選欄位**（answer 是被勾的欄標題）。

▸ true_false 「是非題」
  視覺：單一括號 (   ) 接在敘述句後
  動作：學生在括號內手寫 ○ / ✗ / 對 / 錯 / 是 / 否
  answer：統一 "○" 或 "✗"

▸ fill_blank 「填空題」（支援單空 / 多空兩種模式）
  視覺：____ ／ □ ／ 表格儲存格 + 紅色手寫文字
  動作：學生在空格內填寫一個值（含單位）

  ## 🚨 answerPos 作答位置（fill_blank 必填，值＝ "front" 或 "inline"）
  判斷學生「實際把答案寫在哪」，輸出到該題 JSON 的 answerPos 欄位：
  - **"front"**：題號**左側有一條獨立的答案欄／橫線**（與句子分離、專門寫答案），學生把完整答案寫在那條左欄上。
    常見於「文意字彙／字彙填空」：句子裡可能另有首尾字母提示（如 e___t、f___e），但**真正的作答區是題號左邊那條線**。
  - **"inline"**：答案寫在**句子之中的空格**（____ ／( ) ／□ 夾在題幹文字裡），題號左邊**沒有**獨立答案欄。
  判準（看題號的「左邊」）：題號左側有沒有一條「與句子分離、專門寫答案」的橫線/欄位？
    有 → "front"；沒有、空格在句中 → "inline"。
  ⚠️ 多空模式（parts，短文克漏字／表格子題）一律 "inline"（作答區在句中或格中）。
  ⚠️ 同一大題所有題的 answerPos 通常一致（整個大題同版面）；逐題判斷但結果應一致。

  ## 單空模式（最常見）
  answer：完整正解含單位 — "15 公分" / "彰" / "ㄓㄤ"
  ⚠️ 直式分數格特例：上下格紅色 → "上格/下格"（如 "3/4"）；只有上格紅 → "上格值"

  ## 多空模式（2026-05-25 新增、解 bbox 漂移問題）
  同一道題目同一表達式內出現 N 個空格（N≥2）且兩空之間「沒有等號 =」→
  **合成 1 題 fill_blank、用 parts 陣列**（不拆成 N 個獨立 question）。

  必填欄位（多空模式）：
    - id：給整題（如 "1-2-1"）
    - questionCategory: "fill_blank"
    - answerBbox：**包整句的大 bbox**（含題幹 + 所有空格、不是只框 tiny ( )）
    - parts: 陣列、每空一元素：
        { subId: "a"|"b"|"c"|..., answer: "標準答案", maxScore: 該空配分 }
      ⚠️ subId 依空格由左到右、由上到下順序（不可互換）
    - maxScore: 整題總分 = sum(parts[].maxScore)
    - answer: 留空（多空模式靠 parts、不用 answer 欄位）

  ## 合題 vs 拆題判別（依據＝「主要小題」邊界）

  | 場景 | 處理 |
  |---|---|
  | 單空 | 單題、用 answer 欄位 |
  | 同一個「主要小題」（有自己的題幹／圖／指示語）底下 ≥2 空 —— 不論用 (1)(2)、①②、或無標號、不論跨行跨句跨整段短文、空格之間有 = − × 任何符號 | **合題、用 parts（子標 (1)(2) → subId a/b…）、框一個包整題作答區的大 bbox** |
  | 不同「主要小題」（各自有獨立題幹／圖／提問） | 各自成 entry、不合併 |

  ⭐ 合併單位＝「主要小題」。一個主要小題底下所有空（含 (1)(2)(3)(4) 子標）→ 合成這一題的 parts；不同主要小題 → 各自成題。
  🧭 怎麼分辨「主要小題」vs「子標」：
    • 子標 (1)(2)(3)(4)／①②：共用上面同一句題幹、同一張圖、同一段短文、同一個算式 → 是 parts，要合進同一題。
    • 主要小題：各自有完整獨立的題幹／圖／提問（例：各自一張圖配一個空的單字題、各自獨立編號的題目）→ 各自成題，不合。
  ⛔ 不再有「跨等號鏈式計算拆題」例外（見範例 D）。
  ⛔ 也不要過度合併：不同主要小題（第1題、第2題、第3題）即使相鄰也不可併成一題。

  ## 範例 A：同句多空、合題
  「(1)兩人同向前進、( 2 )分鐘後相距20公尺。(2)反向前進、( 12 )分鐘後相遇。」
  → 1 題 fill_blank、parts 2 個：[{subId:"a",answer:"2"},{subId:"b",answer:"12"}]

  ## 範例 B：短文／克漏字、多句多空、合題（⭐ 英語／國語最常見）
  一段連續短文、題號只有一個，段內挖 5 個空（sleeping/cooking/eating/reading/writing）
  → 1 題 fill_blank、parts 5 個、一個包整段短文的大 bbox。
  ❌ 嚴禁把這段短文拆成 5 個獨立 entry（各一個 tiny bbox）。

  ## 範例 C：堆疊子標、合題（⭐ 數學「下圖…」配 (1)(2)(3)(4) 各一行）
  「2. 下圖是一個四角柱：(1)柱高是( 10 )cm。(2)底面積是( 84 )cm²。(3)體積是( 840 )cm³。(4)表面積是( 688 )cm²。」
  → 這 4 個 (1)(2)(3)(4) 共用「同一張圖、同一個主要小題 2」→ 1 題 fill_blank、parts 4 個、一個包 (1)~(4) 整塊作答區的大 bbox：
  {
    "id": "1-2-2",
    "questionCategory": "fill_blank",
    "answerBbox": { 包第2題 (1)~(4) 整塊 },
    "parts": [
      { "subId": "a", "answer": "10",  "maxScore": 4 },
      { "subId": "b", "answer": "84",  "maxScore": 4 },
      { "subId": "c", "answer": "840", "maxScore": 4 },
      { "subId": "d", "answer": "688", "maxScore": 4 }
    ],
    "maxScore": 16
  }
  ❌ 嚴禁拆成 1-2-2-1 / 1-2-2-2 / 1-2-2-3 / 1-2-2-4 四個 tiny-bbox entry。
  ⚠️ 但第1題（單空 94.2）、第3題、第4題 仍各自是獨立的主要小題 → 不要跟第2題併在一起。

  ## 範例 D：鏈式計算（跨等號）也合題（取代舊拆題規則）
  「底面積 = ( 100 ) − ( 12.56 ) = ( 87.44 )」屬同一主要小題 →
  → 1 題 fill_blank、parts 3 個（每空各自 maxScore，逐空配分不變）：
    parts=[{a:"100"},{b:"12.56"},{c:"87.44"}]
  ⛔ 不再拆成 3 個獨立 entry。

  ❌ 錯誤示範 A：把同一主要小題的多空拆成 N 題、各 tiny bbox → 應合題用 parts
  ❌ 錯誤示範 B：parts 寫成字串 "2, 12" → 必須陣列、每空一元素
  ❌ 錯誤示範 C：把不同主要小題（第1題 vs 第2題）併成一題 → 各自成題

  ## 🚨 fill_blank 核心錨點（避免誤判其他題型）

  - 印刷在卷面上的 ( ) 或 □ 或 _____ **內含紅字（老師寫的答案）** → 一律當「學生要填的空格」、是 fill_blank
  - **不可解讀成「題目給的條件 / 已知值 / 印刷數字」** — 紅字一定是答案、不是已知條件

  🚨 區分「子題標號」vs「答案空格」（兩者外觀都是括號、別混淆）：
  - **子題標號** "(1)" "(2)" "(3)"：印刷的子問題編號、**括號內無紅字**、用於組織同大題下的子題、編到 ID 第 4 段
  - **答案空格** "(  N  )"：印刷的空白括號、**括號內有紅字**、是學生作答區、fill_blank 的目標

  ⚠️ 同一小題可能同時有「子題標號」+「答案空格」：
  範例：「(1) 弟弟是 ( 12 ) 歲，媽媽是 ( 36 ) 歲」
  解析：大題 X 第 Y 小題、子題 (1) 標號、內含 2 個答案空格
  → 1 題 fill_blank with parts、id = "1-X-Y-1"（第 4 段 "1" 來自子題標號 (1)）、parts = [{a:"12"},{b:"36"}]

  ## 🚨 word_problem (應用題) ≠ fill_blank（最常誤判）

  應用題特徵：
  - 題幹較長、有計算過程區（學生寫直式 / 算式）
  - 最後一行「答：...」或「A：...」、紅字答案寫在「答：」後**、不在印刷的 ( ) 內**
  - 即使題幹有 (1) (2) 子問題標號、紅字答案是寫在「答：」後 → **仍是 word_problem、不是 fill_blank**
  - questionCategory = "word_problem"、answer = 「答：...」後的紅字內容

  ❌ 不要把應用題誤分類為 fill_blank：應用題的紅字答案不在印刷 ( ) 內、不符合 fill_blank 錨點

  ⚠️ 與 multi_fill 區別：multi_fill 是「填代號集合，順序無關」；fill_blank 多空模式
     是「每位置有自己的固定答案、順序與位置綁定、不可互換」。

▸ multi_fill 「多項填空題」
  視覺：多個空白框（非 □ 勾選框）+ 紅色代號
  動作：學生在多個格子內填代號（如 ㄅ、ㄇ、ㄉ），順序無關
  answer：代號集合 — "ㄅ、ㄇ、ㄉ"（每子題各自一個 answer）

▸ table_cell 「表格題（群組批改）」
  視覺：規則表格（多列×多欄、清晰格線）+ 部分 cells 內有紅色手寫答案
  動作：學生在表格內多個 cells 填值（每 cell 1 值，數字/文字均可）
  ⭐ 整張表格作為「1 題」，不要拆成多子題

  必填欄位：
    - id：給整張表（如 "2-6-1"，依大題印刷號）
    - questionCategory：'table_cell'
    - maxScore：整題總分（建議預設 = 答案 cells 數，老師可調）
    - answerBbox：**整張表的外框 bbox**（從表格最上格線到最下格線、最左到最右）
    - tableMeta:
        rowHeaders: 列標題陣列（如 ["水果種類","人數(人)","百分率"]）
        colHeaders: 欄標題陣列，第 0 欄通常為列標題欄留空（如 ["", "蘋果","櫻桃","草莓","西瓜"]）
        totalRows: 含 header 總列數
        totalCols: 含 header 總欄數
    - cells: 答案 cells 陣列，每元素：
        { row: 1-based, col: 1-based, label: "對應 header 簡短描述", answer: "標準答案" }
        ⚠️ 只列「需要學生填的 cells」，不列已預印的 header / 已給數值
        ⚠️ row/col 含 header 計數（第 1 列通常是欄標題列）

  範例：「水果統計表」3×5（含 header），學生要填第 3 列百分率（4 個 cells）：
    {
      "id": "2-6-1",
      "questionCategory": "table_cell",
      "maxScore": 4,
      "answerBbox": { "x": 0.04, "y": 0.10, "w": 0.45, "h": 0.18 },
      "tableMeta": {
        "rowHeaders": ["水果種類", "人數(人)", "百分率"],
        "colHeaders": ["", "蘋果", "櫻桃", "草莓", "西瓜"],
        "totalRows": 3, "totalCols": 5
      },
      "cells": [
        { "row": 3, "col": 2, "label": "蘋果", "answer": "27%" },
        { "row": 3, "col": 3, "label": "櫻桃", "answer": "24%" },
        { "row": 3, "col": 4, "label": "草莓", "answer": "26%" },
        { "row": 3, "col": 5, "label": "西瓜", "answer": "23%" }
      ]
    }

  ⚠️ 一張答案卷裡多個獨立表格 → 每張表各 1 個 table_cell question（id 各自編號）
  ⚠️ 不要在 cells 陣列裡 pre-fill header 列／已預印數值（cells 只放需要學生填寫的格子）
  ⚠️ 若表格只有 1 個答案格 → 用 fill_blank 不用 table_cell（table_cell 必須有 ≥ 2 個 answer cells）

▸ matching 「連連看」
  視覺：左欄項目 + 右欄選項 + 紅色連線
  動作：學生連線（1對1 / 1對多 / 多對多）
  answer：每子題填對應右欄文字 — "2公尺/秒"

▸ ordering 「排序題」
  視覺：一組待排序項目（單列或多列網格，如圖片／詞／句）+ 紅色序號 1-N（學生在每項的括號 ( )／格內填序號）
  動作：學生在每項的格內填序號表示順序
  🚨 掃描／輸出順序（**建答案卷與批改讀取必須用同一條規則、否則對不齊**）：
     **由上而下、每一列由左而右**掃描每個項目（多列網格：先掃完上面一列、再下一列）。
     answer = 依此掃描順序、逐項記下「該項格內的序號數字」。
  answer：序號集合（依上述掃描順序）— "3,1,4,2"

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

  🚨 多 final 場景（同題求多個結果）— 合 1 題、不要拆：
       題幹含多個提問（「求...與...」「求...及...」「求 a、b」、或兩個並列「？」）
       → 學生「答：」行通常含多個值、以逗號／頓號／空格／換行分隔
       → 仍為 **1 個 word_problem entry**、answer = 所有 final 拼接（保留學生分隔符）
       範例：題幹「側面長方形的長(AB)大約是多少公分？這個圓柱體的表面積大約是多少？」、
            答「50.24 公分，1406.72 平方公分」
            → 1 entry、answer = "50.24 公分，1406.72 平方公分"
       ❌ 不要拆成 2 entries（如 2-1-1=50.24、2-1-2=1406.72）→ 結構壞、批改端會錯
       💡 counting hint：題幹有 N 個「？」或「求...與/及/，...」→ 預期 N 個 final，全部塞同一 answer string

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

  📍 整張地圖無印刷題號的情境（社會科常見）：
  - 看到一張地圖佔據整頁、沒「1./2./3.」傳統題號 → 仍視為合法答案卷、不可回 {questions: []}
  - 整張地圖建成 **1 個 question**、id 用 "1-1"（photo 1 第 1 題）
  - acceptableAnswers 列出地圖上**全部紅字標籤**（地名/國名），不管 5 個還 30 個都裝同一個陣列
  - maxScore 預設 = 紅字標籤數量
  - referenceAnswer 用方位/相鄰關係描述每個答案的位置（見下方「map_fill 必填位置描述」段）

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

▸ diagram_draw 「圖表繪製題」（**限資料圖表**）
  視覺：預印格線/座標軸/圓 + 紅色繪製的長條/扇形
  動作：學生繪製長條圖/圓餅圖等**資料圖表**（每筆有數值或比率）
  ⚠️「在預印立體圖/圖形上描一條線（如柱高、對稱軸）」**不是** diagram_draw，是 diagram_color
  欄位：referenceAnswer + rubricsDimensions: [數值正確性, 標籤完整性]
  referenceAnswer 範例：
   - 圓餅圖：「番茄汁 2/5, 紅蘿蔔汁 1/10, 蘋果汁 3/20, 葡萄汁 1/4」（每扇形「標籤 比率」）
   - 長條圖：「一月 50, 二月 30, 三月 45, 四月 60」（每長條「標籤 高度/數值」）

▸ diagram_color 「塗色／畫記題」
  視覺：預印圖形 + 紅色塗色 **或** 紅色描線/記號
  動作：學生在預印圖形上**塗色，或描線/畫記/標示一條線或記號**（分數塗色、用筆描出柱高/對稱軸、標某一邊、描輪廓等）
  欄位：referenceAnswer + rubricsDimensions: [塗色比例, 塗色位置, 塗色完整性]（描線類維度可換成 [位置正確性, 線條清晰度]）
  referenceAnswer 範例：
   - 塗色：「塗色：第 1 個圓完整，第 2 個圓左側 2/3，第 3 個圓未塗」
   - 描線：「標示出每個柱體的正確柱高位置（連接兩底面的側稜）」

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
// 級分制（數學應用題）規格。**一般模式與純答案卷模式共用同一份**——
// 這兩支 prompt 是各自獨立的函式，先前級分制只寫在一般模式的數學區塊，
// 純答案卷模式根本看不到，導致純答案卷的應用題永遠不會產生 levelRubric。
const LEVEL_RUBRIC_SPEC = `▸ word_problem 的級分制規準（levelRubric）**不在這裡填**

  應用題的評分規準由後續獨立階段逐題產生（見 detectLevelRubric）。
  原因：主擷取要同時處理整份卷的題號／答案／配分，若再為每題寫完整規準，
  題數一多規準就會被輸出壓力擠掉（實測 9 題應用題：一輪產 9 份、另一輪只產 1 份）。

  你在這裡**只要正確判出 questionCategory = "word_problem" 並填好 answer / maxScore 即可**，
  不需要輸出 levelRubric 欄位。`

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
  - 🚨 同一段文字／同一題幹下多個改正位置 → **合 1 個 fill_blank entry with parts**
    parts 陣列依出現順序記每個改正、answerBbox 框整段文字（含所有改正位置）
    ❌ 不要每個改正位置拆成獨立 entry、各自 tiny bbox → classify 階段 crop 會重疊、批改錯
  - 多段獨立改錯文字（如 1.____, 2.____, 3.____ 各自一段）→ 各為獨立 entry（傳統拆題）
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

  ⚠️ 上面 Step 1/Step 2 看的是「答案卷上有沒有工作區、有沒有答句行」。
     **純答案卷模式（只有答案格、另附題本）沒有工作區也沒有答句行**，這兩步會全部落到 fill_blank。
     此模式一律以「題本參考」章節的規則為準：題幹要求寫出計算／推導過程 → word_problem。
     不要因為答案卷上只看到格子就判成 fill_blank。

  ⚠️ calculation/word_problem 不需要 rubricsDimensions（過程交 Accessor 自行判斷）
  ⚠️「算算看」「計算看看」後若有「答：」行 → word_problem
  ⚠️ 即使括號內只有單一值，只要學生寫了算式步驟 → calculation 或 word_problem

  ${LEVEL_RUBRIC_SPEC}

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

▸ 克漏字題幹的選擇題（🚨 選擇優先於填空）：
  - 英語選擇題常把題幹寫成「克漏字」（句中留一個空格 ___ 或 ( )）。但只要該題「下方／旁邊另有 a/b/c 或 A/B/C 的選項清單」，且「有一個寫代號或圈代號的作答區」→ 一律判**選擇型**：
    • 在空括號 ( ) 內寫一個代號（A/B/C）→ single_choice
    • 圈印刷的 a/b/c 代號 → circle_select_one
  - 題幹句中的空格只是「題幹的一部分」、不是作答格；真正的作答區是那個寫／圈代號的位置。
  - 🚫 嚴禁因為題幹有空格就判 fill_blank。**只有**「完全沒有任何選項清單、單純一個空格要學生填字／填詞」才是 fill_blank。
  - 例：「I'm going to ___. (B)  a. the park  b. the library  c. home」→ 作答區是 (B) 寫代號 → single_choice，不是 fill_blank。

▸ 冠詞圈選＋單字填空題（「You're (a／an) ___ <單字>」型，🚨 複合、兩部分獨立計分）：
  - 版面：題幹給「(a／an)」要學生**圈一個冠詞**，後面接一個**空格填單字**（如動物名），常配圖片或字庫；指示語常見「選出正確的 a 或 an，並完成單字」。
  - 冠詞與單字**都是精確比對、各自獨立計分** → 用 **fill_blank 多空模式（parts）**，視為 1 題、不要拆成兩題、也不要只收單字：
    {
      "questionCategory": "fill_blank",
      "parts": [
        { "subId": "a", "answer": "a" 或 "an", "maxScore": 冠詞配分 },
        { "subId": "b", "answer": "<填入的單字>", "maxScore": 單字配分 }
      ],
      "maxScore": 兩部分配分總和
    }
  - subId 順序固定：冠詞在前（a）、單字在後（b）。answerBbox 框含「(a／an)」與單字空格的整句。
  - 冠詞答案只讀**被圈起來（答案色）的那一個**（a 或 an），不要兩個都收；看不清楚 → 該 part answer 填 "?"。
  - 配分：整題若 N 分、兩部分平分為整數（如 2 分 → 冠詞 1、單字 1）；卷面有明確配分標示則依標示。

▸ 閱讀／聽力「問答題」（Q: … A: …，答句是一整句、句中部分單字加底線=計分關鍵詞）→ 🚨 一律 fill_blank「整句」：
  - questionCategory = "fill_blank"，**單一 answer、不要拆 parts**。
  - answer = **完整答句、逐字照印刷原樣**（含所有單字、冠詞、be 動詞、單位、句末標點）。
    例：「He can get there by plane.」「It is five thousand and nine hundred dollars.」「They are eight hundred and seventy dollars.」「It is Class 512's idea.」
  - maxScore = 題目配分。
  - ❌ 嚴禁判 short_answer / word_problem（會留空 answer、無法比對）。
  - ❌ 嚴禁拆 parts。
  - 🚨 **以下兩類最容易被誤拆、但仍是「一整句答案」、一律整句不拆**：
    ① 逗號分隔的清單：如「a T-shirt, shorts and sneakers」→ answer 整串照抄、**不要**拆成 T-shirt／shorts／sneakers 三個 part。
    ② 數字的英文唸法：如「three thousand one hundred and twenty」「eight hundred and seventy dollars」→ answer 整串照抄、**不要**拆成 three／thousand／… 或 eight／seventy。
  - ❌ 不要只抓底線詞當 answer——answer 要整句完整（底線只是計分提示、批改端自會逐詞比對）。
  - 判別：答句是「一句完整英文句子 / 一串清單 / 一個數字唸法」→ 走本規則、整句一個 answer。

▸ 看圖／聽力「排序」題（給多張圖或多個項目，學生在每個旁邊填 1、2、3…的順序號）→ 🚨 questionCategory = "ordering"：
  - 指示語常見「Listen and Number」「排出順序」「填寫數字 1~N」。
  - ❌ 不要判成 fill_blank（這不是填空、是排序）。
  - answer = 依項目印刷順序串接的序號、逗號分隔（如 "1,6,3,4,5,2,8,7"）。
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
function buildAnswerKeyAnswerOnlyPrompt(domain?: string, hasBooklet = false): string {
  const domainHint = domain && domain !== '其他'
    ? `\n【領域提示】科目：${domain}\n- 影響 fill_blank 答案的單位／格式判讀（例：自然 → SI 單位、英語 → 拼字／時態）\n- 影響 short_answer 的 rubricsDimensions criteria 寫法：\n  · 數學／自然 → 強調「列式正確、過程清晰、單位標注」\n  · 國語／社會 → 強調「論述完整、依據明確、結論清楚」\n  · 英語 → 強調「文法正確、用字精準、句構流暢」\n- 用 domain 推 criteria 比硬從答案內容反推更可靠`
    : ''

  // 題本（學生看的乾淨題目卷）若也一起傳給 AI，用途有二：
  //  ① 推 short_answer 的 rubricsDimensions criteria（比從答案內容反推準確得多）
  //  ② 2026-08-14：**判題型**。純答案卷上只看得到格子，「要求寫出計算／推導過程」這件事
  //     只存在於題本。不看題本 → 應用題一律被判成 fill_blank → 級分制永遠不會觸發，
  //     學生只寫結論就能拿分（老師卻在題本寫了「否則不予計分」）。
  const bookletSection = hasBooklet
    ? `
## ⭐ 題本參考（重要）
你會收到「答案卷圖片」+「題本圖片」兩組。題本不需要逐格抽答案，但有兩個必須用途：

### 用途 1：判斷題型（所有題目都要做）
答案卷上只有格子，看不出題目要求什麼。**必須回題本讀該題的題幹**再決定 questionCategory。

⭐ 最重要的判準：**題幹有沒有要求寫出過程**。
若題幹出現「請寫下計算過程」「請完整寫出解題過程」「並詳細說明」「說明理由」「否則不予計分」等要求
→ 該題為 **word_problem**（走級分制、看整份推導給等第），**即使答案卷上只是一格一格的空格也一樣**。

- 同一大題底下多個小問（(1)(2)(3)…）只要**其中任一小問**要求寫出過程
  → 整個大題合為 **1 個 word_problem entry**，不要拆成多個 fill_blank；
  answer 欄位把各小問的最終答案依序拼接（例：「(1) 6700000-x (2) x>6700000-x (3) x≥5000000 (4) 否」）
- 題幹只要求填值、明寫「不需化簡」「直接寫答案」且無過程要求 → 維持 fill_blank
- 作圖題（grid_geometry 等）不受此規則影響，仍走視覺判斷

### 用途 2：推 short_answer 的評分維度
從題本找出該題的「題目要求」，拆解成兩個 criteria 維度（作答依據 + 結論表達）寫進 rubricsDimensions：
- 例：題本 4-2 寫「比較 A 與 B 兩物體在...時的速度大小，並說明原因」+ 答案卷寫「一樣大」
  → criteria 應是「正確比較速度大小（一樣大／A>B／A<B），並依守恆定律說明原因」，而不是只反推答案的「指出『一樣大』」

⛔ 嚴禁因為看了題本就把題幹文字塞進 answer 欄位——answer/referenceAnswer 一律來自答案卷的格子`
    : ''

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

## 1. questionCategory 規則（必須使用以下 6 種之一）

【規則優先順序】section header 優先於答案內容；答案內容只在 section 不能決定時使用。

### 1A. Section header 強規則（最高優先）
- 「簡答」「問答」「申論」「混合題」「非選擇題的子題之申論」section
  → 該 section 所有題目原則上都是 short_answer
  → 這類題目用 referenceAnswer 欄位（不是 answer），並必填 rubricsDimensions
  → 例外：若該 section 中某題答案明顯是單一字母（A-E）或選項，仍可用 single_choice
- 「單選題」「多選題」「多重選擇題」「複選」section → 對應 single_choice / multi_choice
- 「是非題」「判斷題」「True/False」「正誤判斷」section → 對應 true_false
- 「填充題」「填空題」「非選擇題」「非選」section → 對應 fill_blank

### 1B. 答案內容輔助判斷（當 section 不能決定時）
| 答案內容樣態 | questionCategory | 範例 |
|---|---|---|
| 單一英文字母 A–E | single_choice | "C"、"A" |
| 多個字母（逗號分隔或連寫） | multi_choice | "B,C"、"BC"、"A、D" |
| ○ / ✓ / 對 / Y / T 等「正確」符號 | true_false | "○"、"對"、"T" |
| ✗ / × / 錯 / N / F 等「錯誤」符號 | true_false | "✗"、"錯"、"F" |
| 純數字、公式、含單位的數值 | fill_blank | "240A"、"4/3 B"、"1.0×10⁻²"、"μ₀i/4(1/a-1/b)" |
| 多行推導、長段文字、解釋 | short_answer | "因 a+b=0 故..." |
| 空白 | 看 section：簡答／混合 → short_answer；其他 → fill_blank | "" |

⚠️ true_false 與 single_choice 區分：T/F 兩個字母在「是非題」section 中是 true_false（"T"=對、"F"=錯）；在「單選題」section 中可能是選項代號 → single_choice。**section header 永遠優先**。

### 1B2. 繪圖題（格內正解是「圖」不是文字 → grid_geometry）
- 格內老師的正解**以圖為主**（描邊、畫線段、對稱軸、三視圖、幾何作圖、在格線/圖形上畫記），不是文字或算式
  → questionCategory = "grid_geometry"
- 答案放 referenceAnswer 欄位：一句話描述正解圖的內容與判準（如「畫出該圖形的一條對稱線段（任一條合法的對稱線段皆可）」「依立體圖完成前視圖、右視圖、上視圖」）
- 格內若印有步驟配分（如「步驟1(2分) 步驟2(1分)」）→ maxScore = 各步驟配分總和，並把步驟配分寫進 referenceAnswer
- 不需要 rubricsDimensions（系統會另行對圖生成視覺評分規則）
- ⚠️ 只有「圖為主」的格子才用 grid_geometry；文字／算式推導仍是 short_answer

### 1C. 欄位選擇規則（重要）
- single_choice / multi_choice / fill_blank / true_false → 答案放 answer 欄位
- short_answer → 答案放 referenceAnswer 欄位（不是 answer），且必填 rubricsDimensions
- grid_geometry → 答案放 referenceAnswer 欄位（描述正解圖），不需要 rubricsDimensions
- 即使老師寫的 short_answer 文字很短（如「一樣大」「正確」），仍是 referenceAnswer

### 1D. true_false 答案標準化
不論老師寫什麼符號，answer 欄位請統一輸出：
- 對 / 正確 / ○ / ✓ / Y / T → 統一輸出 "○"
- 錯 / 不正確 / ✗ / × / N / F → 統一輸出 "✗"
（讓批改階段不用處理多種符號變體）

⚠️ 名稱必須完全一致：single_choice / multi_choice / fill_blank / short_answer / true_false / grid_geometry。
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

## 4. answerBbox — 本階段不輸出
bbox 定位由後續的 locate.answer_only 階段視覺搜尋決定。
❌ 禁止在 questions 裡輸出 answerBbox 欄位；輸出了也會被系統忽略。

## 4B. ⚠️ Sub-cell ID 結構（重要）

當表格中某個主欄底下被細分成多個子格時，ID 使用 4 段格式：
- "3-1-1", "3-1-2", "3-1-3" → section 3，大題 1，子格 1/2/3
- idPath 對應：["3","1","1"]、["3","1","2"]、["3","1","3"]
- anchorHint 要標明「位於『三、非選題』第 1 大題的子格 (1)/(2)/(3)」

🚨 嚴禁把 sub-cell 子格（3-1-1 等）視為與主欄同層（誤用 3-1, 3-2, 3-3 來表示）。
   正確做法：父欄若本身也有答案用 3-1；子格用 3-1-1, 3-1-2, 3-1-3。

## 4C. ⚠️ 一格多小題 ＝ 一題多答案 → parts（重要）
當一個格子**沒有實體子格分隔線**、但格內寫了多個小題答案（子標 (1)(2)(3)／①②③、或多行各自獨立的小題答案）：
- 這是「一題、多個答案」→ 輸出 **1 個 entry with parts**。🚨 禁止拆成多題、禁止用 4 段 sub-cell ID。
- parts 陣列每小題一元素：{"subId": "a", "answer": "該小題答案", "maxScore": 該小題配分}
  - subId 依 a / b / c / d… 順序對應 (1)(2)(3)(4)…
  - 各小題配分：卷面有標示就照標示填；沒標示就填「整題總分 ÷ 小題數」（均分、必填、不可省略）
  - 小題答案含推導過程時，answer 只放最終答案（如「答：否」→ "否"）
- 整題 maxScore = 該格標示的總配分（如「3.(4分)」→ 4）
- questionCategory：小題答案是數值／算式／短語 → "fill_blank"（頂層 answer 欄位省略、答案全在 parts）
- 例：格子標「2.(4分)」、內寫 (1) 12 (2) 30 (3) 5:2 (4) 18（題本只要求填值、無過程要求）
  → 1 entry：{"id":"2-2","questionCategory":"fill_blank","maxScore":4,"parts":[{"subId":"a","answer":"12","maxScore":1},{"subId":"b","answer":"30","maxScore":1},{"subId":"c","answer":"5:2","maxScore":1},{"subId":"d","answer":"18","maxScore":1}]}
- ⛔ 只要格內有 ≥2 個子標小題答案，就**必定**輸出 parts——即使其中某小題寫了多行推導，也**禁止**因此把整格改成 short_answer（該小題的 answer 只放最終結論，如「答：否」→ "否"）。

  ⭐ 唯一例外（優先於上面這條 ⛔）：**題本上該題要求寫出計算／推導過程**時
  （出現「請寫下計算過程」「請完整寫出解題過程」「並詳細說明」「否則不予計分」等字樣）
  → 整格改判 **word_problem**、不要輸出 parts，並附上 levelRubric（見下方級分制規格）。
    answer 欄位把各小問最終答案依序拼接，例：「(1) 6700000-x (2) x>6700000-x (3) x≥5000000 (4) 否」
    理由：那種題目只比對結論的話，學生只寫「否」就能拿分，違背老師「否則不予計分」的要求。
- 4B 的 sub-cell 拆題**只適用於卷面有實體子格分隔線**的格子；沒有分隔線一律走本節 parts。

## 4C. 級分制（word_problem 專用）

${LEVEL_RUBRIC_SPEC}

## 5. maxScore 推論
- 優先從 section 標題抓「每題 X 分」（例：「一、單選題（12題 每題4分 共48分）」→ 每題 4 分）
- 找不到「每題 X 分」就從 section 總分均分（總分 / 題數）
- 都沒寫 → 預設 1
- ⛔ 同一 section 除非卷面明標「各題不同配分」，否則每題 maxScore 必須相同（總分均分）；禁止自創遞增／遞減或分段配分
- ⚠️ 答案卡上的「得分換算表」（對題數↔得分的對照列表，如「對題／錯題／得分」表）**不是題目、也不是各題配分**：不可抽成題目、不可據以分配 maxScore
- short_answer：必填 rubricsDimensions（兩維度：作答依據 + 結論表達），兩維度 maxScore 加總 = 該題 maxScore

## 6. _layoutDetected（必填，且要在 questions 之前生成）
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
      "anchorHint": "位於『一、單選題』表格第 1 格"
    },
    {
      "id": "2-1",
      "idPath": ["2","1"],
      "questionCategory": "multi_choice",
      "answer": "B,C",
      "maxScore": 5,
      "anchorHint": "位於『二、多重選擇題』表格第 1 格"
    },
    {
      "id": "3-1",
      "idPath": ["3","1"],
      "questionCategory": "true_false",
      "answer": "○",
      "maxScore": 2,
      "anchorHint": "位於『三、是非題』表格第 1 格（老師寫「對」→ 統一輸出「○」）"
    },
    {
      "id": "3-2",
      "idPath": ["3","2"],
      "questionCategory": "fill_blank",
      "answer": "240A",
      "maxScore": 5,
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
      "anchorHint": "位於『四、混合題』第 3 格"
    }
  ],
  "totalScore": 120
}${domainHint}${bookletSection}

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

/**
 * table_cell 群組批改題型 normalize：
 * - 確保 cells 陣列有效（每元素含 row/col/answer）
 * - maxScore 沒填 → 預設 = cells.length（一格一分）
 * - 移除 legacy tablePosition（與 table_cell 互斥）
 */
function normalizeTableCellQuestion(question: AnswerKeyQuestion): AnswerKeyQuestion {
  if (question.questionCategory !== 'table_cell') return question

  const cells = Array.isArray(question.cells) ? question.cells : []
  const validCells = cells
    .filter((c) => c && Number.isFinite(c.row) && Number.isFinite(c.col) && typeof c.answer === 'string')
    .map((c) => ({
      row: Math.max(1, Math.floor(Number(c.row))),
      col: Math.max(1, Math.floor(Number(c.col))),
      label: typeof c.label === 'string' ? c.label.trim() : undefined,
      answer: String(c.answer).trim()
    }))

  // maxScore 沒填或為 0 → 預設一格一分
  const incomingMax = Number(question.maxScore)
  const maxScore = Number.isFinite(incomingMax) && incomingMax > 0
    ? incomingMax
    : validCells.length

  return {
    ...question,
    cells: validCells,
    maxScore,
    tablePosition: undefined  // 與 table_cell 互斥，避免 server 又走 table-position median
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
    q = normalizeTableCellQuestion(q)
    q = normalizeLevelRubricQuestion(q)
    return q
  })

  return {
    ...answerKey,
    questions: normalizedQuestions
  }
}

/**
 * 2026-08-13 級分制：只有數學 word_problem 留 levelRubric，其餘一律拔掉
 * （AI 偶爾會在鄰近題型上多吐一份，留著會讓那題誤走級分制判官）。
 * 分數一律由 code 依配分換算，AI 若回傳 score 會在 normalizeLevelRubric 裡被丟棄。
 */
function normalizeLevelRubricQuestion(question: AnswerKeyQuestion): AnswerKeyQuestion {
  const raw = (question as AnswerKeyQuestion & { levelRubric?: unknown }).levelRubric
  if (!raw) return question
  if (question.questionCategory !== 'word_problem') {
    const { levelRubric: _drop, ...rest } = question as AnswerKeyQuestion & { levelRubric?: unknown }
    void _drop
    return rest as AnswerKeyQuestion
  }
  const normalized = normalizeLevelRubric(raw as Parameters<typeof normalizeLevelRubric>[0], question.maxScore)
  if (!normalized) {
    const { levelRubric: _drop, ...rest } = question as AnswerKeyQuestion & { levelRubric?: unknown }
    void _drop
    return rest as AnswerKeyQuestion
  }
  return { ...question, levelRubric: normalized }
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
  // 2026-07-31 補登 table_check:extract prompt 強制要求它、白名單卻漏了 →
  // 每張含勾選表的英語卷都被判 invalid_category 白 retry 一次 PRO(answers 在 rows[]、不進 ANSWER_REQUIRED)
  'table_cell', 'table_check',
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
  // Bucket A 全部（含新加入的 calculation / word_problem / table_cell）
  'single_choice', 'multi_choice', 'circle_select_one', 'circle_select_many',
  'single_check', 'multi_check', 'true_false', 'fill_blank', 'multi_fill',
  'table_cell',      // A bucket：answer 在 cells[].answer（quality gate 特殊處理）
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

// Types that legitimately occupy a whole sheet by themselves (1 question per sheet is valid).
// 加新 type 要記得補進來、否則 too_few_questions QG 會把它當 AI 漏題、觸發無謂 retry。
const WHOLE_SHEET_CATEGORIES = new Set(['map_fill', 'map_symbol', 'grid_geometry', 'connect_dots', 'diagram_draw', 'diagram_color', 'mark_in_text'])

function checkAnswerKeyQuality(ak: AnswerKey, pageCount?: number): { shouldRetry: boolean; reasons: string[] } {
  const reasons: string[] = []
  const questions = ak?.questions ?? []

  if (questions.length === 0) { reasons.push('no_questions'); return { shouldRetry: true, reasons } }
  // too_few_questions：1-2 題通常代表 AI 漏題。但 whole-sheet 類型（map_fill 等）本來
  // 就是「整張卷一題」、1 題即合法、不該觸發 retry。
  const allWholeSheet = questions.every((q) => q.questionCategory && WHOLE_SHEET_CATEGORIES.has(q.questionCategory))
  if (questions.length < 3 && !allWholeSheet) reasons.push('too_few_questions')

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
    // table_cell：看 cells 是否至少 1 格有非空 answer
    if (q.questionCategory === 'table_cell') {
      const hasAny = Array.isArray(q.cells) && q.cells.some((c) => {
        const ca = (c?.answer ?? '').trim()
        return ca && !PLACEHOLDER_ANSWERS.has(ca)
      })
      if (!hasAny) missingAnswer++
      continue
    }
    // fill_blank 合題：看 parts 是否每空都有非空 answer
    if (Array.isArray(q.parts) && q.parts.length > 0) {
      const allFilled = q.parts.every((p) => {
        const pa = (p?.answer ?? '').trim()
        return pa && !PLACEHOLDER_ANSWERS.has(pa)
      })
      if (!allFilled) missingAnswer++
      continue
    }
    const ans = (q.answer ?? '').trim()
    const ref = (q.referenceAnswer ?? '').trim()
    if ((!ans || PLACEHOLDER_ANSWERS.has(ans)) && (!ref || PLACEHOLDER_ANSWERS.has(ref))) missingAnswer++
  }
  if (missingAnswer > 0) reasons.push(`missing_answer(${missingAnswer})`)

  // Page-proportional check — whole-sheet 類型不適用（地圖/繪圖每頁 1 題即合法）
  if (pageCount && pageCount > 1 && questions.length / pageCount < 2 && !allWholeSheet) {
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
  // table_cell 專用：給 AI 表頭錨點以視覺定位整表外輪廓
  tableMeta?: {
    rowHeaders?: string[]
    colHeaders?: string[]
    totalRows: number
    totalCols: number
  }
  cellAnchors?: string  // human-readable 描述要找的 cells（如「r3c2 蘋果, r3c3 櫻桃, ...」）
  // fill_blank 合題專用：parts 帶 subId 與 answer、locate AI 用來識別合題並包整段
  parts?: Array<{ subId: string; answer: string }>
  note?: string
}

const LOCATE_VALID_TYPES = new Set([
  // Bucket A
  'single_choice', 'multi_choice', 'circle_select_one', 'circle_select_many',
  'single_check', 'multi_check', 'true_false', 'fill_blank', 'multi_fill',
  'table_cell',
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
    // fill_blank 合題：帶 parts 進 spec、讓 locate AI 知道是合題、bbox 要包整段
    if (Array.isArray(q.parts) && q.parts.length > 0) {
      spec.parts = q.parts.map((p) => ({ subId: p.subId, answer: p.answer }))
      spec.note = '⚠️ 此題為 fill_blank 合題（多空）、bbox 包整段題幹和全部括弧、不是只框 tiny ( )'
    }
    // table_cell：帶 tableMeta 跟 cells 描述（AI 用印刷表頭+答案內容當錨點定位整表）
    if (q.questionCategory === 'table_cell') {
      if (q.tableMeta) {
        spec.tableMeta = {
          rowHeaders: q.tableMeta.rowHeaders,
          colHeaders: q.tableMeta.colHeaders,
          totalRows: q.tableMeta.totalRows,
          totalCols: q.tableMeta.totalCols
        }
      }
      if (Array.isArray(q.cells) && q.cells.length > 0) {
        spec.cellAnchors = q.cells
          .map((c) => `r${c.row}c${c.col}${c.label ? `(${c.label})` : ''}=${c.answer || '?'}`)
          .join(', ')
      }
    }
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
- fill_blank 「填空題」（不論單空或合題、一律包整題幹）：**完整規則見下方專屬區塊**（FILL_BLANK 加強規則）
- multi_fill 「多項填空題」：每子題獨立一個 bbox，TIGHT crop ONLY 該格的單一值，不含鄰格
  ⚠️ 子題 bbox 絕對禁止重疊
  ORDERING：子題 ID 依 TOP-TO-BOTTOM 為主、LEFT-TO-RIGHT 為輔
- table_cell 「表格題（群組批改）」：bbox 框**整張表格外輪廓**（從最上格線到最下格線、最左格線到最右格線）
  ⚠️ 不要只框某一 cell，也不要拆 N 個 bbox
  ⚠️ 必須涵蓋所有 header（列標題列 + 欄標題欄）+ 所有答案 cells
  ⚠️ 上下左右各加少許邊距（約 0.005~0.01）讓格線完整入框
  ⚠️ bbox.h 應該是「整表高度」，通常 0.10~0.30 之間，不會 < 0.05
  範例：3 列 × 5 欄水果統計表 → bbox 框整個 3×5 網格
- matching 「連連看」(group_context)：整個連連看區為單一 bbox — 左欄所有項目 + 右欄所有選項 + 中間所有連線
  ⚠️ 不可只框右欄文字 — 連線本身就是答案，必須完整包含
- ordering 「排序題」：整體一個 bbox，涵蓋所有排序格
- mark_in_text 「圈詞題」：涵蓋整個文章區域，可框大一點以含上下文
- calculation 「計算題」：從第一行算式 → 框到最終答案，**所有算式行（橫式 + 直式 + 結果）整個範圍**
  ⚠️ 不可只框最終數值 — 計算步驟必須在框內
- word_problem 「應用題」：從第一行算式 → 框到最末「答：」或「A：」行整個範圍
  ⚠️ 不可只框「答：」那一行 — 計算步驟也必須在框內

▸ Bucket B — 容多元

- fill_variants 「多元填空題」：同 fill_blank（包整題幹 + 全部空格）
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

═══════════════ FILL_BLANK 加強規則（包整題幹）═══════════════

🚨 **本區塊規則只適用於 questionType === 'fill_blank' 的題目**。
其他題型（single_choice / true_false / multi_check / single_check / multi_fill 等）一律以上方
「Per-Type 涵蓋範圍規則」為準、不受本區塊影響。

🆕 fill_blank 不論單空或合題（parts 多空），bbox **一律包整段題幹 + 全部空格標記**。

【涵蓋範圍】（fill_blank only）
- 從題號（如「1.」「2.」「(1)」）開始 → 框到該題最末字（含單位、句末標點）
- 整段題目（含敘述文字、印刷括號 / 底線 / 方框、紅字答案、單位、標點）必須全部入框
- 兩空之間的印刷字（in / the / is / 是 / 的 / 公尺）**全部在 bbox 內**（與舊 fill_blank 規則相反）

【尺寸常識】（fill_blank only）
- bbox.w 通常 ~0.4 頁寬（單欄佈局）；雙欄佈局單題寬 ~0.42
- bbox.h 看題幹行數：1 行題 ≈ 0.025~0.04；2-3 行題 ≈ 0.06~0.10；4+ 行 ≈ 0.10~0.16
- 上下左右各加少許邊距（約 0.005~0.01）避免切到第一個字 / 最末字

【範例】（fill_blank only）
- 範例 A（單空、單行）：「電扶梯的速率是 0.6 公尺／秒，阿玟行走的速率是 0.5 公尺／秒…5 秒後他移動了( 6.5 )公尺」
   → bbox 包整段題目，從「電扶梯」到「公尺」（含答案括弧 + 單位）
- 範例 B（合題、多行）：「(1) 兩人同時同地同方向前進，( 2 )分鐘後相距 20 公尺。(2) 兩人同時相向前進，( 12 )分鐘後相遇。」
   → bbox 包整段（兩個子句都包），y 從題號到最末「相遇。」
- 範例 C（底線型）：「Mom is _____ in the _____ today.」
   → bbox 包整段，含兩條底線 + "is" / "in the" / "today" 連續文字
- 範例 D（方框型算式）：「2½ □ (4.73 □ 2.73)」
   → bbox 包整個算式行，含兩個 □ 與括號

【⛔ 不要做】（fill_blank only — 不影響其他題型）
- ⛔ fill_blank 不要只框 tiny ( ) 或單一空格 — 那是舊的 fill_blank 規則
  （⚠️ single_choice / true_false 等題型仍照原規則「緊框題號前的空括號 + 小邊距」、不受此條影響）
- ⛔ fill_blank 不要為了避開「元 / 公分」單位字而把 bbox 縮小 — 單位字現在要包進來
- ⛔ fill_blank 不要因為「合題」就拆成多個 bbox — 合題（parts）只有一個 bbox 包整段

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
  // table_cell 的答案在 cells[].answer 而非 q.answer，要單獨判斷
  // fill_blank 合題的答案在 parts[].answer 而非 q.answer，也要單獨判斷
  const locatableQ = questions.filter((q) => {
    if (q.questionCategory === 'table_cell') {
      // 至少 1 個 cell 有非空 answer 就算 locatable
      return Array.isArray(q.cells) && q.cells.some((c) => typeof c?.answer === 'string' && c.answer.trim())
    }
    if (Array.isArray(q.parts) && q.parts.length > 0) {
      // 合題：至少 1 個 part 有非空 answer 就算 locatable
      return q.parts.some((p) => typeof p?.answer === 'string' && p.answer.trim())
    }
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

// ─── answer_only 專用 locate ────────────────────────────────────────────────

function buildAnswerKeyLocateAnswerOnlyPrompt(questions: import('./db').AnswerKeyQuestion[]): string {
  const specs = questions.map(q => ({
    questionId: q.id,
    anchorHint: q.anchorHint ?? '',
    answerText: (typeof (q as any).answer === 'string' && (q as any).answer)
      || (typeof q.referenceAnswer === 'string' && q.referenceAnswer)
      || '',
    questionCategory: q.questionCategory ?? ''
  }))

  return `You are stage ANSWER_KEY_LOCATE (answer_only mode).
任務：在這張「純答題卡」圖片上，為每一個格子找出 answerBbox — 包含答案文字的方框格子。

Question Specs:
${JSON.stringify(specs)}

═══════════════ 搜尋方式（逐題）═══════════════
對每一題：
1. 用 anchorHint 確認格子在哪個 section、哪個位置（如「一、單選題第 5 格」）
2. 用 answerText 在格子裡確認目視到對應的答案文字
3. 框出這個格子的 □ 邊界

═══════════════ bbox 規則（box 方框型，全部格子通用）═══════════════
- bbox 框 □ 整個邊界 + 內部答案文字
- 四邊各向外推 3-5% 頁寬（避免切到 □ 邊框）
- 禁止框到題號 header 列（如表格第一列的「1, 2, 3...12」印刷題號）
- 禁止框到相鄰格子的內容

🚨 Sub-cell 注意：若題目 ID 是 4 段（如 "3-1-1"），表示它是父欄的子格：
- 子格比主欄窄很多（主欄寬 / 子格數）
- 3-1-1 在左、3-1-2 在中、3-1-3 在右（或上/中/下，視版面而定）
- 每個子格的 bbox 必須各自獨立，絕對不可給相同的框

═══════════════ 座標格式（強制）═══════════════
- bbox = { "x": 0.12, "y": 0.34, "w": 0.20, "h": 0.08 }
- (x,y) = 左上角；全部為 0-1 之間的歸一化座標
- ⚠️ 絕對禁止輸出像素座標（x/y/w/h 必須在 0-1 範圍內）
- 視覺定位失敗 → 直接 omit answerBbox（不要硬給空框）

═══════════════ Output ═══════════════
回傳純 JSON，不要 Markdown：
{
  "locations": [
    { "questionId": "1-1", "answerBbox": { "x": 0.12, "y": 0.34, "w": 0.08, "h": 0.06 } }
  ]
}`.trim()
}

async function locateAnswerOnlyBboxesOnPage(
  questions: import('./db').AnswerKeyQuestion[],
  imageBlob: Blob
): Promise<Map<string, NormalizedBbox>> {
  const bboxMap = new Map<string, NormalizedBbox>()
  if (questions.length === 0) return bboxMap

  const prompt = buildAnswerKeyLocateAnswerOnlyPrompt(questions)
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
          console.warn(`[locate.answer_only] dropped invalid bbox for ${qId}:`, loc.answerBbox)
        }
        continue
      }
      bboxMap.set(qId, loc.answerBbox as NormalizedBbox)
    }
  } catch (err) {
    console.warn('[locate.answer_only] page failed:', err instanceof Error ? err.message : err)
  }
  return bboxMap
}

async function locateAnswerOnlyBboxesAcrossPages(
  questions: import('./db').AnswerKeyQuestion[],
  imageBlobs: Blob[]
): Promise<Map<string, NormalizedBbox>> {
  // answer_only 模式：pageIndex 已被上游強制設為 0（單張）或正確值（多張），直接信任
  const byPage = new Map<number, import('./db').AnswerKeyQuestion[]>()
  for (const q of questions) {
    const pageIdx = typeof q.pageIndex === 'number' ? q.pageIndex : 0
    if (!byPage.has(pageIdx)) byPage.set(pageIdx, [])
    byPage.get(pageIdx)!.push(q)
  }

  const startedAt = Date.now()
  console.log(`📍 [locate.answer_only] 開始並行定位 ${byPage.size} 頁...`)

  const results = await Promise.all(
    Array.from(byPage.entries()).map(async ([pageIdx, pageQuestions]) => {
      const blob = imageBlobs[pageIdx]
      if (!blob) {
        console.warn(`[locate.answer_only] page ${pageIdx} 無對應圖片，跳過`)
        return new Map<string, NormalizedBbox>()
      }
      return locateAnswerOnlyBboxesOnPage(pageQuestions, blob)
    })
  )

  const merged = new Map<string, NormalizedBbox>()
  for (const m of results) {
    for (const [k, v] of m) merged.set(k, v)
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log(`📍 [locate.answer_only] 完成：${merged.size}/${questions.length} 題定位成功（${elapsed}s）`)
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

  // ─── Per-page fan-out（每頁 1 個 API call、N 頁 N 個並行 call）─────────
  // 動機：多頁同送 1 個 call、AI 注意力會在頁與頁之間散開，單頁辨識品質下降。
  // Trade-off：每個 sub-call 都要重送一次大 prompt（~7K token × N）成本變高，
  // 換取每頁專注度。inferMode 需要跨頁 pattern inference、不 fan-out。
  // _skipLocateCrop 是 sub-call 旗標，避免重複跑 Phase 2/3。
  if (answerSheetImages.length > 1 && !opts?._skipLocateCrop && opts?.inferMode !== 'infer_blank') {
    const startPage = opts?.startPage ?? 1
    const totalPages = opts?.totalPages ?? answerSheetImages.length
    console.log(`🔀 [AnswerKey] per-page fan-out: ${answerSheetImages.length} 頁 → ${answerSheetImages.length} 個並行 API call (startPage=${startPage}, totalPages=${totalPages})`)

    const perPageResults = await Promise.all(
      answerSheetImages.map((img, i) =>
        extractAnswerKeyFromImages([img], {
          ...opts,
          startPage: startPage + i,
          totalPages,
          _skipLocateCrop: true,
        })
      )
    )

    const merged: AnswerKey = {
      questions: perPageResults.flatMap(r => r.questions),
      totalScore: perPageResults.reduce((sum, r) => sum + (Number(r.totalScore) || 0), 0),
    } as AnswerKey

    // _layoutDetected: sub-call 內看到 photo:1、重寫為全局頁碼
    type Layout = { photo: number; layout: string }
    const allLayouts: Layout[] = []
    perPageResults.forEach((r, i) => {
      const layouts = (r as unknown as { _layoutDetected?: Layout[] })._layoutDetected
      if (Array.isArray(layouts)) {
        for (const l of layouts) allLayouts.push({ ...l, photo: startPage + i })
      }
    })
    if (allLayouts.length > 0) (merged as unknown as { _layoutDetected: Layout[] })._layoutDetected = allLayouts

    merged.questions.sort((a, b) => compareNaturalIds(a.id, b.id))
    console.log(`✅ [AnswerKey fan-out] 合併 ${merged.questions.length} 題、總分 ${merged.totalScore}`)

    // Phase 2/3：在 merged 結果上跑一次（所有圖一起傳給 locate/crop、保持原本跨頁行為）
    if (merged.questions.length > 0) {
      try {
        const isAnswerOnlyMode = opts?.answerSheetMode === 'answer_only'
        const bboxMap = isAnswerOnlyMode
          ? await locateAnswerOnlyBboxesAcrossPages(merged.questions, answerSheetImages)
          : await locateAnswerKeyBboxesAcrossPages(merged.questions, answerSheetImages)
        for (const q of merged.questions) {
          const bbox = bboxMap.get(q.id)
          if (bbox) q.answerBbox = bbox
        }
        const cropMap = await cropAnswerKeyQuestionsOnCanvas(merged.questions, bboxMap, answerSheetImages)
        for (const q of merged.questions) {
          const cropUrl = cropMap.get(q.id)
          if (cropUrl) q.cropImageUrl = cropUrl
        }
        // map_fill positions + VJ rubric Stage A（fan-out 路徑也要跑、否則生不出 positions/vjRubric）
        await runAnswerKeyStageA(merged.questions,
          opts?.answerSheetMode === 'answer_only' ? (opts?.bookletImages ?? []) : [],
          answerSheetImages)
      } catch (err) {
        console.warn('⚠️ [AnswerKey fan-out] locate / crop 階段失敗：', err)
      }
    }

    return merged
  }

  const isInferMode = opts?.inferMode === 'infer_blank'
  const isAnswerOnly = opts?.answerSheetMode === 'answer_only'
  const bookletImages = isAnswerOnly && Array.isArray(opts?.bookletImages) ? opts!.bookletImages! : []
  const hasBooklet = bookletImages.length > 0
  // startPage: page number of the first image in this batch (1-based, default 1)
  // totalPages: total pages across ALL batches
  // needsPagePrefix: 一律加頁碼前綴，避免單張答案卷上有多大題（一/二/三/四）時 AI 用「印刷大題號」當第一段，
  //   導致 server fallback (staged-grading.js:5099) 把印刷大題號當頁碼誤拆圖。
  //   單張時前綴固定 "1-"，多張時依序 "1-" / "2-" / ...
  const startPage = opts?.startPage ?? 1
  const totalPages = opts?.totalPages ?? answerSheetImages.length
  const needsPagePrefix = true

  console.log(`🧾 開始從 ${answerSheetImages.length} 張圖片${isInferMode ? '推論（空白作業模式）' : (isAnswerOnly ? '抽取（純答題卡模式）' : '抽取（解答圖模式）')} AnswerKey... startPage=${startPage} totalPages=${totalPages}${hasBooklet ? ` + 題本 ${bookletImages.length} 頁（用於 short_answer rubric 推導）` : ''}`)

  const prompt = isInferMode
    ? buildInferFromBlankPrompt(opts?.domain)
    : (isAnswerOnly
      ? buildAnswerKeyAnswerOnlyPrompt(opts?.domain, hasBooklet)
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

  const isSingleImage = answerSheetImages.length === 1 && totalPages === 1
  const isSinglePageOfMulti = answerSheetImages.length === 1 && totalPages > 1
  const multiImageNote = isInferMode
    ? `【多張圖片處理】\n- 你會收到 ${answerSheetImages.length} 張空白作業圖片\n- 請從所有圖片中推論所有題目的正確答案，合併成完整 AnswerKey${pageIdRule}`
    : isSingleImage
      ? `【單張答案卷】\n- 你會收到 1 張答案卷圖片\n- ID 前綴一律為 "1-"（即使卷上印有多個大題編號，第一段也固定是 1）\n- totalScore 是所有題目的 maxScore 總和${pageIdRule}`
      : isSinglePageOfMulti
        ? `【多頁模式 - 單頁批次】\n- 此份答案卷共 ${totalPages} 頁，本批次只傳給你「第 ${startPage} 頁」這一張\n- ID 前綴一律為 "${startPage}-"（本批所有題目第一段都固定是 ${startPage}）\n- ❌ 不要試圖生成其他頁的題目、只看眼前這張照片\n- totalScore 是這一頁所有題目的 maxScore 總和\n- _layoutDetected 陣列只放這一張照片的 layout（陣列長度 = 1）${pageIdRule}`
        : `【多張圖片處理 - 多頁模式】\n- 你會收到 ${answerSheetImages.length} 張答案卷圖片，每張照片有獨立的 ID 前綴：${pagePrefixList}\n- ⚠️ 嚴格禁止把第 2 張以後的題目用 "1-" 開頭，必須依照上方對應關係填入正確前綴\n- 請從所有圖片中提取題目，合併成一個完整的 AnswerKey${pageIdRule}\n- totalScore 是所有圖片中所有題目的 maxScore 總和`
  // 2026-06-16 改版：fill_blank 合題依「主要小題」邊界（取代舊的「看是否跨等號」）
  // - 一個主要小題（有自己題幹/圖/指示語）底下所有空 —— 含 (1)(2) 子標、堆疊子題、
  //   短文克漏字、鏈式計算 —— 全合成 1 entry with parts、框一個大 bbox。
  // - 不同主要小題各自成 entry、不過度合併。已移除「跨等號鏈式計算拆 N 題」例外。
  // - 動機：AI 不擅長框小框，合併大框較不易框錯。實驗 local-only/fill_blank_qnum_merge_exp_2026-06-16。
  // 詳細規則見 buildTypeSpecs 的 fill_blank 條目。
  const chainCalcRule = isInferMode || isAnswerOnly ? '' : `\n\n🚨🚨🚨 fill_blank 多空格 — 決策樹（依據＝「主要小題」邊界）：

  ## ⭐ BLOCKING DEFAULT — 一個主要小題底下 ≥2 空 → 合題 with parts

  合併單位是「主要小題」（卷面上有自己題幹／圖／指示語的那一題）。
  一個主要小題底下，凡有 ≥ 2 個答案空格（( )／____／□），**無論**：
    • 用 (1)(2)(3)(4)、①② 子標列出、或無標號
    • 空格分散在不同句子、不同行、橫跨整段短文
    • 空格之間是文字、逗號、句號、換行、=、−、×、任何符號
  → **強制合成 1 個 fill_blank entry with parts**（子標 (1)(2) → subId a/b…），
    answerBbox 包整個主要小題的作答區（一個大框）。

  看到多空，先判斷它們是不是「同一個主要小題」底下；是 → 合題。

  涵蓋（全部走合題）：
    情境 A（同句多空）：「( 2 )分鐘後相距20公尺、( 12 )分鐘後相遇」→ 1 entry, parts×2
    情境 B（短文／克漏字、多句多空 ⭐ 英語／國語最常見）：
       一段連續短文、一個題號、段內挖 5 空 → 1 entry, parts×5, 包整段大 bbox。
    情境 C（堆疊子標 ⭐ 數學「下圖…」配 (1)(2)(3)(4)）：
       「2. 下圖四角柱：(1)柱高( 10 )(2)底面積( 84 )(3)體積( 840 )(4)表面積( 688 )」
       共用同一張圖、同屬主要小題 2 → 1 entry, parts×4, 包 (1)~(4) 整塊。
       ❌ 嚴禁拆成 4 個 tiny-bbox entry。
    情境 D（鏈式計算、跨等號）：「= ( 100 ) − ( 12.56 ) = ( 87.44 )」同屬一主要小題
       → 1 entry, parts×3（每 part 各自 maxScore）。⛔ 取代舊拆題規則。

  ## 🧭 怎麼分辨「主要小題」vs「子標」（決定合併邊界）
  - 子標 (1)(2)(3)(4)／①②：共用上面同一句題幹、同一張圖、同一段短文、同一個算式 → 是 parts，合進同一題。
  - 主要小題：各自有完整獨立的題幹／圖／提問 → 各自成題。
    例：英語單字題每格配一張不同的圖 → 各自成題；數學第1題、第2題、第3題 → 各自成題。

  ## 🚫 沒有「拆題例外」，但也不要過度合併
  - 等號不再是分題依據；同一主要小題的鏈式計算也合題。
  - ⛔ 不同主要小題（第1題 vs 第2題、各自獨立題幹）即使相鄰也不可併成一題。

  ## 自我檢查（送出前）
  ❌ 同一主要小題的空被拆成多個 entry、各 tiny bbox → 應合成 1 entry with parts
  ❌ 不同主要小題被併成一題 → 拆回各自的 entry
  ❌ parts 寫成字串 "2, 12" → 必須陣列、每空一元素
  ❌ 只填第一空、忽略其餘空 → 漏答案、補齊
  ❌ 兩個 fill_blank entry 的 answerBbox 互相重疊（共享同一題幹／同段短文／同張圖）→ 強烈訊號該合題、立刻 merge

  ## 🚨 範例 ID 範圍 disclaimer
  範例 ID（如 "1-2-2"）只示意格式、不代表 section 上限。實際 <大題印刷號> 對應卷上印刷大題號（可 1~10+）。

  ## 🚨 NUMERIC CHECK（強制檢查、避免漏題或誤拆／誤合）
  1. 每個印刷大題都要有對應 questions、漏了回去重看。
  2. 每個「主要小題」對應 1 個 question entry：
     - 單空 → 1 entry（answer）
     - 同一主要小題下多空（含短文克漏字、堆疊子標、鏈式計算）→ **1 entry with parts**（不要拆、不要只填第一空）
     - 不同主要小題 → 各自 1 entry（不要互相合併）
  3. ⛔ 分題只看「主要小題」邊界，不要再依「有沒有等號」去拆 fill_blank。`

  // 2026-06-25 英語 fill_blank carve-out：模型常把「底線計分詞」誤當作答空格 → 觸發下方 chainCalcRule
  //   「≥2空→parts」把整句問答答案拆碎、甚至整題漏掉。實驗 local-only/exp-extract-fillblank-2026-06-25：
  //   3.5-flash 整句命中 58%→92%、漏題 2→0。只在英語領域、prepend 到 chainCalcRule 最前（最高優先）。
  const englishFillBlankCarveOut = (isInferMode || isAnswerOnly || (opts?.domain || '') !== '英語') ? '' : `\n\n🚨🚨🚨🚨 英語領域最優先例外（凌駕下方所有「≥2空→parts」規則）：
判斷「有幾個空格」時，**底線／粗體／顏色標記的單字一律 NOT 算空格**——它們只是計分關鍵詞提示、不是作答空格。
若學生是在「一條連續作答線」上寫一個【完整英文句子 / 一串逗號清單 / 一個數字的英文唸法】當作答 → **永遠是 1 個 answer（整句照抄）、絕不拆 parts**，即使句中有 2 個以上底線詞。
  例：「He wears a T-shirt, shorts and sneakers」有 3 個底線詞 → 仍是 1 個 answer、不拆。
  例：「They are three thousand one hundred and twenty dollars」有 3 個底線詞 → 仍是 1 個 answer、不拆。
只有當卷面有「實體分開、各自獨立的空格欄位（____／( )／□），學生逐格填不同字」時，才考慮 parts。
`

  const multiImagePrompt = `${prompt}\n\n${multiImageNote}${englishFillBlankCarveOut}${chainCalcRule}`.trim()

  // 準備多圖片請求（每張照片前插入頁碼標記，讓 AI 明確知道頁碼）
  const requestParts: GeminiRequestPart[] = [multiImagePrompt]

  // 添加所有圖片，並在每張前插入頁碼標記（使用全域頁碼 startPage+i）
  for (let i = 0; i < answerSheetImages.length; i++) {
    const pageNum = startPage + i
    const pageLabel = needsPagePrefix
      ? `--- 第 ${pageNum} 張答案卷照片（頁碼 ${pageNum}，此頁所有題目 id 前綴為 "${pageNum}-"）---`
      : `--- 第 1 張答案卷照片 ---`
    requestParts.push(pageLabel)
    const imageBase64 = await blobToBase64(answerSheetImages[i])
    const mimeType = answerSheetImages[i].type || 'image/jpeg'
    requestParts.push({
      inlineData: { mimeType, data: imageBase64 }
    })
    console.log(`  📄 已添加第 ${pageNum} 張圖片（頁碼前綴 "${needsPagePrefix ? `${pageNum}-` : '無'}"）`)
  }

  // answer_only 模式：附帶題本圖片（用於 short_answer rubric 推導，不抽答案）
  if (hasBooklet) {
    requestParts.push(`--- 以下為「題本」圖片（${bookletImages.length} 張）：學生看的乾淨題目卷。用途有二：① 判斷每題的 questionCategory（尤其題幹是否要求寫出計算／推導過程 → word_problem）；② 推導 short_answer 的 rubricsDimensions criteria。⛔ 不要從題本抽答案，answer 一律來自答案卷 ---`)
    for (let i = 0; i < bookletImages.length; i++) {
      const imageBase64 = await blobToBase64(bookletImages[i])
      const mimeType = bookletImages[i].type || 'image/jpeg'
      requestParts.push({ inlineData: { mimeType, data: imageBase64 } })
      console.log(`  📚 已添加題本第 ${i + 1} 頁`)
    }
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

  // 設定 pageIndex（0-based），供預覽底圖選取
  // - answer_only 真正單頁答題卡：所有題目都在 page 0（ID 首段是 sectionIdx 不是 photoIdx）
  // - 其他情況（含 fan-out sub-call、totalPages>1）：ID 首段是 photo 序號（1-based）
  const assignPageIndex = (q: AnswerKeyQuestion) => {
    if (isAnswerOnly && answerSheetImages.length === 1 && totalPages === 1) {
      q.pageIndex = 0
      return
    }
    const pageNum = parseInt(String(q.id ?? '').split('-')[0], 10)
    if (pageNum >= 1) q.pageIndex = pageNum - 1
  }
  for (const q of result.questions) assignPageIndex(q)

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
      for (const q of retryResult.questions) assignPageIndex(q)
      // Merge: keep first run's good questions, only override broken ones from retry
      result = mergeAnswerKeyResults(result, retryResult)
    } catch (retryErr) {
      console.warn('[AnswerKey QG] retry failed:', retryErr)
    }
  }

  console.log(`✅ 成功提取 ${result.questions.length} 題，總分 ${result.totalScore}`)

  // ─── Phase 2: locate（並行 per-page）+ Phase 3: canvas crop ──────────────
  // answer_only 模式：走 locateAnswerOnlyBboxesAcrossPages（per-question 視覺搜尋，anchorHint + answerText 雙錨）
  // 一般模式：走 locateAnswerKeyBboxesAcrossPages（25 type 規則）
  // _skipLocateCrop：fan-out sub-call 跳過、由 fan-out entry 在 merge 後統一執行
  if (!opts?._skipLocateCrop && result.questions.length > 0 && answerSheetImages.length > 0) {
    try {
      const bboxMap = isAnswerOnly
        ? await locateAnswerOnlyBboxesAcrossPages(result.questions, answerSheetImages)
        : await locateAnswerKeyBboxesAcrossPages(result.questions, answerSheetImages)
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

    // ─── Phase 4: map_fill 位置偵測 + VJ rubric 偵測（Stage A，共用 helper）─────
    await runAnswerKeyStageA(result.questions, bookletImages, answerSheetImages)
  }

  return result
}

// ─── VJ Stage A0: 看 AnswerKey crop 產生 vjRubric ───────────────────────────
// 對應 server 端 visual-judgment-grader.js 的 buildVjRubricPrompt / parseVjRubricResult（須同步）
/**
 * 級分制規準（應用題）：Stage A 逐題產生，**不在主擷取裡做**。
 *
 * 2026-08-14 實測（國小六年級卷、9 題應用題、同一輸入跑 2 輪）：
 *   輪1 產出 9 份規準、輪2 只產出 1 份 —— 主擷取要同時抽 31 題的題號/答案/配分，
 *   再為 9 題各寫一份完整規準，輸出壓力一大時規準是第一個被放棄的東西。
 *   培英那張卷之所以每次都成功，是因為它只有 1 題應用題（負擔輕）。
 * → 改成逐題單獨呼叫（比照 vjRubric 的 A0），每次只處理一題。
 */
export async function detectLevelRubric(
  q: AnswerKeyQuestion,
  cropImageDataUrl: string,
  bookletImages: Blob[] = [],
): Promise<import('./db').LevelRubric | undefined> {
  const m = cropImageDataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!m) return undefined
  const answer = q.referenceAnswer || (q as { answer?: string }).answer || ''

  const prompt = `這是一份數學考卷上「一題應用題」的區域圖（老師的答案卷，紅字是正解）。
請為這一題產出「級分制評分規準」，供後續 AI 閱卷使用。

【這一題的正解】${answer || '（見圖）'}
【配分】${q.maxScore ?? '未知'} 分

⭐ 使用方式：閱卷 AI 只回報「哪些要素有出現」，級分由系統依 levelRules 計算。
   所以要素與規則的品質＝判分的品質。

【要素怎麼掃出來】（不要自由發揮，照這份清單逐項掃）
會考官方的評分要素不是「想」出來的，是從解題路徑上「必經的點」抓出來的。逐項檢查：
  ① **每個小問的最終答案** → 各一條（必填，且必須獨立成一條）
  ② **求出答案必經的中間值** → 每個一條。
     ⭐ 最有效的做法：看圖中老師正解的算式，**每個等號右邊出現的數字都是候選**。
     例：正解寫「60÷1.5=40／60÷2.5=24／40+24=64」→ 掃出 40、24、64 三個必經值。
  ③ **本題考的關鍵公式或關係** → 一條（梯形面積公式、等差關係、30°-60°-90° 比例…）
  ④ 題目若要求**比較／判斷／檢驗** → 邊界值一條（不足與超過都要寫、且值要正確）
  ⑤ 題目若明文要求**特定作答形式**（例如「合併成一個算式」）→ 一條

【寫法要求】
1. **最終答案必須單獨成為一條**，不可與計算過程綁在一起。
   ❌ 錯誤示範：「運用梯形面積公式正確列式並求出面積為 8」
      —— 綁在一起時，學生只寫「8」也會命中，等於答案對就滿分。
   ✅ 正確：拆成兩條 →「列出算式 (3.75+6¼)×1.6÷2」、「求得答案 8 平方公分」
2. 掃完清單後**至少要有 2 條**（過程 ≥1 ＋ 答案 1）。只給 1 條代表沒掃 ②③⑤，回去重掃。
3. 每條都要寫成**看得到就能勾的具體東西**：具體數值、具體算式、具體結論。
   ❌ 不可以：「推導完整」「解題步驟清楚」「正確運用數學概念」
4. 每條都必須附 ⛔ 否定條件，**指名一個「做到一半」的具體狀態**。
   ✅ 好：「⛔ 只算出 40、沒有再加 24 → 不算」
   ❌ 沒用：「⛔ 未正確計算不算」（同義反覆，等於沒寫）
5. 等值寫法一律算呈現（不同算式、不同命名、不同順序）。

【替代解法】想一遍學生還可能怎麼解（列式 vs 逐項計算、換單位算、兩邊同乘換形式）。
漏列一條＝用該法的學生被判成沒有過程，是誤殺。真的只有一條路才留空。

【levelRules】把級分條件翻成 key 的組合，系統由 3 往下比對、第一條成立即該級分。
  requireAll / requireAny＝要素 key；requireGroups / requireAnyGroup＝替代組 key。
⛔ 除了 level 0（兜底）以外，**每一條都必須有條件**——沒有條件等於全部學生都符合，
   空白卷也會拿到該級分。
⛔ 只寫出最終答案、沒有任何過程 → 必須落在 0 或 1 級。
⛔ **二級分不可以用「requireAny: 全部要素」這種寫法**——那等於只做對一步就給 65% 的分數。
   二級分要表達的是「大致完成、但缺一塊」，寫法應該是：
     requireAll: [關鍵的前段要素…]     ← 已完成的部分要明確列出
   或 requireAll: [主要結論] + requireAnyGroup: [解題路徑]
   自我檢查：把「只命中其中一條要素」代進你的規則，算出來必須 ≤ 1 級。若算出 2 級就是寫錯了。

只輸出 JSON，不要加說明或程式碼框：
{
  "requiredElements": [{ "key": "E1", "desc": "具體敘述 ⛔ 什麼情況不算" }],
  "alternativeGroups": [{ "key": "G1", "desc": "這組在講什麼", "options": [{ "key": "G1a", "desc": "具體敘述" }] }],
  "toleratedFlaws": ["不應降級的瑕疵"],
  "levels": [
    { "level": 3, "criteria": "..." }, { "level": 2, "criteria": "..." },
    { "level": 1, "criteria": "..." }, { "level": 0, "criteria": "..." }
  ],
  "levelRules": [
    { "level": 3, "requireAll": ["E1","E2"] },
    { "level": 2, "requireAll": ["E1"] },
    { "level": 1, "requireAny": ["E1","E2"] },
    { "level": 0 }
  ]
}`

  const parts: GeminiRequestPart[] = [prompt, { inlineData: { mimeType: m[1], data: m[2] } }]
  if (bookletImages.length > 0) {
    parts.push('--- 以下是這一題的**題目全文**（可能是題本，也可能是整張考卷）。'
      + '上面那張小圖只框住作答區、看不到題目在問什麼，所以請在這裡找到本題的題幹，'
      + '依「題目要求什麼」推導要素；題目若明文要求特定作答形式（如「合併成一個算式」）也要納入。'
      + '⛔ 正解仍以上面那張作答區小圖為準，不要從這裡抓答案 ---')
    for (const b of bookletImages) {
      parts.push({ inlineData: { mimeType: b.type || 'image/jpeg', data: await blobToBase64(b) } })
    }
  }
  // 產出後驗證、不合就重試：prompt 講了不一定聽（明寫「至少 2 條」仍會給 1 條），
  // 而這兩種缺陷都是靜默的——要素綁在一起＝只寫答案就滿分；規則兜不攏＝全對卻扣到 1 級。
  let best: import('./db').LevelRubric | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = (await generateGeminiText(currentModelName, parts, {
        routeKey: 'answer_key.locate',  // 復用 locate route（=PRO、proxy 已支援，同 VJ A0）
      })).replace(/```json|```/g, '').trim()
      const lr = normalizeLevelRubric(JSON.parse(raw), q.maxScore ?? 0)
      if (!lr) continue
      const problems = validateLevelRubric(lr)
      if (problems.length === 0) return lr
      best ??= lr   // 留著當退路：有瑕疵的規準仍比完全沒有好（沒有就退回只比對最終答案）
      console.warn(`[LevelRubric A0] ${q.id} 第 ${attempt + 1} 次不合格：${problems.join('、')}`)
    } catch (err) {
      console.warn(`[LevelRubric A0] ${q.id} 第 ${attempt + 1} 次失敗`, err)
    }
  }
  return best
}

export async function detectVisualRubric(
  cropImageDataUrl: string,
  category: string,
  refText: string,
  // 2026-08-14：題本一起餵。原本 A0 只看答案卷 crop + 一句 refText hint，
  // 而 refText 本身是擷取階段產生的——擷取寫得粗糙，判準就跟著粗糙（連鎖劣化）；
  // 加上 crop 可能把關鍵標籤（如對稱軸 L／M）裁在邊界外，A0 就更沒依據。
  // 題本才有題目的原始要求（「先以直線 L…再以直線 M…」），是唯一權威來源。
  bookletImages: Blob[] = []
): Promise<{ itemLabels: string[]; condition: string; gradingDefinition: string } | null> {
  const m = cropImageDataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!m) {
    console.warn('[VJ A0] cropImageUrl 非 dataURL、跳過')
    return null
  }
  const mimeType = m[1]
  const data = m[2]
  const refLine = refText ? `\n【題目要求（hint）】${refText}` : ''

  const prompt = category === 'diagram_color'
    ? `這是一張**數學畫記/塗色題的答案卷**（老師畫的正解）。學生要在每個圖形上畫記或塗色作答。${refLine}

任務：找出**所有需要學生作答的獨立子元素**（每個圖形/區域一個），並寫出評判條件。

【輸出 JSON（純 JSON、無 markdown）】
{
  "itemLabels": ["左上半圓柱體", "右上長方體", "左下三角柱體", "右下五角柱體"],
  "condition": "每個柱體用藍筆描出至少一條合法柱高",
  "gradingDefinition": "柱高=連接前後兩底面的側稜（長度方向的邊）；**任何一條連接兩底面的側稜都算正確**（不只一條標準答案）；畫在底面內的邊／半徑／對角線＝錯。"
}

【規則】
- itemLabels：用「方位 + 圖形名」依「左上→右上→左下→右下」順序列出，每個獨立圖形一項。
- condition：一句話總結學生每項該做什麼。
- gradingDefinition：**寫清楚「什麼樣的作答算對」**，特別是「有多個等價合法位置」時要明講。
- 只看印刷正解、不臆造看不到的圖形。
只輸出 JSON。`
    : `這是一張**視覺作答題的答案卷**（老師畫的正解）。${refLine}

任務：找出所有需要學生作答的獨立子元素，並寫出評判條件。${category === 'map_symbol' ? '學生在地圖/圖上畫符號或標位置。gradingDefinition 要寫清楚「正確符號 + 正確相對位置」的判準。' : '學生在格線上畫指定幾何圖形。gradingDefinition 要寫清楚「正確形狀 + 尺寸(格數) + 位置」的判準，並註明等價的合法畫法。'}

【輸出 JSON】
{ "itemLabels": ["...", "..."], "condition": "...", "gradingDefinition": "..." }

依閱讀順序列出 itemLabels，只看印刷正解、不臆造。只輸出 JSON。`

  const parts: GeminiRequestPart[] = [prompt, { inlineData: { mimeType, data } }]
  if (bookletImages.length > 0) {
    parts.push('--- 以下為「題本」圖片：學生看到的原始題目。'
      + '請找到這一題的題幹，**以題幹寫的要求為準**寫評判標準——'
      + '例如題幹指明「先以直線 L 為對稱軸、再以直線 M」，itemLabels 與 gradingDefinition 就必須寫出是哪一條軸；'
      + '題幹標了各步驟配分，也要照抄。⛔ 不要從題本抓答案，正解一律以答案卷 crop 為準 ---')
    for (const b of bookletImages) {
      const b64 = await blobToBase64(b)
      parts.push({ inlineData: { mimeType: b.type || 'image/jpeg', data: b64 } })
    }
  }
  const rawText = (await generateGeminiText(currentModelName, parts, {
    routeKey: 'answer_key.locate'  // 復用 locate route（=PRO、proxy 已支援、同 map_fill A0）
  })).replace(/```json|```/g, '').trim()

  let parsed
  try { parsed = JSON.parse(rawText) } catch {
    console.warn('[VJ A0] JSON parse 失敗、raw（前 300 字）：', rawText.slice(0, 300))
    return null
  }
  if (!parsed || !Array.isArray(parsed.itemLabels)) {
    console.warn('[VJ A0] 回傳無 itemLabels、raw（前 300 字）：', rawText.slice(0, 300))
    return null
  }
  const itemLabels = parsed.itemLabels.map((s: unknown) => String(s ?? '').trim()).filter(Boolean)
  if (itemLabels.length === 0) return null
  return {
    itemLabels,
    condition: String(parsed.condition ?? '').trim(),
    gradingDefinition: String(parsed.gradingDefinition ?? '').trim()
  }
}

// ─── 答案卷 Stage A 共用 helper：map_fill positions + VJ rubric ──────────────
// 兩條抽取路徑（fan-out 與單次）都呼叫此 helper，避免漏跑。
async function runAnswerKeyStageA(
  questions: AnswerKeyQuestion[],
  bookletImages: Blob[] = [],
  // 一般模式（題目答案同卷）沒有題本，但題幹就印在整頁上——crop 只框作答區，看不到題目在問什麼。
  // 級分制要素必須依題目要求推導，缺題幹時 AI 只寫得出「答案」一條（實測 4-5-1 兩輪都只有 1 條）。
  pageImages: Blob[] = [],
): Promise<void> {
  // map_fill 位置偵測（Direction Y Stage A）
  const mapFillQs = questions.filter((q) => q.questionCategory === 'map_fill' && q.cropImageUrl)
  if (mapFillQs.length > 0) {
    console.log(`📍 [AnswerKey map_fill] ${mapFillQs.length} 題、跑 Stage A 位置偵測...`)
    await Promise.all(
      mapFillQs.map(async (q) => {
        try {
          const positions = await detectMapFillPositions(q.cropImageUrl!, q.acceptableAnswers || [])
          if (positions && positions.length > 0) {
            ;(q as { positions?: Array<{ name: string; desc: string }> }).positions = positions
            console.log(`  ✅ ${q.id}: ${positions.length} positions`)
          } else {
            console.warn(`  ⚠️ ${q.id}: Stage A 回空、無 positions`)
          }
        } catch (e) {
          console.warn(`  ❌ ${q.id}: Stage A 失敗`, e)
        }
      })
    )
  }
  // VJ 視覺判斷題 rubric 偵測（A0）
  const VJ_CATS = ['diagram_color', 'map_symbol', 'grid_geometry']
  const vjQs = questions.filter((q) => VJ_CATS.includes(q.questionCategory ?? '') && q.cropImageUrl)
  if (vjQs.length > 0) {
    console.log(`🎨 [AnswerKey VJ] ${vjQs.length} 題、跑 A0 rubric 偵測...`)
    await Promise.all(
      vjQs.map(async (q) => {
        try {
          const vjRubric = await detectVisualRubric(
            q.cropImageUrl!,
            q.questionCategory ?? '',
            q.referenceAnswer || (q as { answer?: string }).answer || '',
            bookletImages
          )
          if (vjRubric && vjRubric.itemLabels.length > 0) {
            ;(q as { vjRubric?: typeof vjRubric }).vjRubric = vjRubric
            console.log(`  ✅ ${q.id}: ${vjRubric.itemLabels.length} items`)
          } else {
            console.warn(`  ⚠️ ${q.id}: A0 回空、無 vjRubric`)
          }
        } catch (e) {
          console.warn(`  ❌ ${q.id}: A0 失敗`, e)
        }
      })
    )
  }

  // 2026-08-14 應用題級分制規準（A0）：逐題單獨呼叫。
  //   放在主擷取裡時，題數一多就會被輸出壓力擠掉（實測 9 題應用題：輪1 產 9 份、輪2 只產 1 份）。
  const lrQs = questions.filter((q) => q.questionCategory === 'word_problem' && q.cropImageUrl)
  if (lrQs.length > 0) {
    console.log(`📐 [AnswerKey 級分制] ${lrQs.length} 題應用題、逐題產生規準...`)
    await Promise.all(
      lrQs.map(async (q) => {
        try {
          const pageIdx = q.pageIndex ?? 0
          const context = bookletImages.length > 0
            ? bookletImages                                    // 純答案卷：題本才有題目
            : (pageImages[pageIdx] ? [pageImages[pageIdx]] : [])  // 一般模式：該題所在整頁
          const lr = await detectLevelRubric(q, q.cropImageUrl!, context)
          if (lr) {
            ;(q as { levelRubric?: typeof lr }).levelRubric = lr
            console.log(`  ✅ ${q.id}: 要素 ${lr.requiredElements.length} 項、`
              + `規則 ${(lr.levelRules ?? []).length} 條、替代組 ${(lr.alternativeGroups ?? []).length}`)
          } else {
            console.warn(`  ⚠️ ${q.id}: 未產生級分制規準（批改會只比對最終答案）`)
          }
        } catch (e) {
          console.warn(`  ❌ ${q.id}: 級分制 A0 失敗`, e)
        }
      })
    )
  }
}

// ─── map_fill Stage A: 看 AnswerKey crop 偵測每位置 {name, desc} ────────────
// 對應 server 端 map-fill-grader.js 的 buildStageAPrompt / parseStageAResult
async function detectMapFillPositions(
  cropImageDataUrl: string,
  acceptableAnswers: string[]
): Promise<Array<{ name: string; desc: string }> | null> {
  // dataURL → mime + base64
  const m = cropImageDataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!m) {
    console.warn('[map_fill Stage A] cropImageUrl 非 dataURL、跳過')
    return null
  }
  const mimeType = m[1]
  const data = m[2]

  const prompt = `這是一張**填圖題答案卷**：印刷地圖 + 老師印刷的紅字答案標籤（標出每個位置應該填的地名）。

任務：找出**所有**紅字標籤、對每個輸出 (name, location_desc)。

預期會看到約 ${acceptableAnswers.length} 個標籤。

【參考 hint】（已知會出現的地名、僅供比對拼字、不要漏未列出的）：
${acceptableAnswers.join('、')}

【輸出 JSON 格式（純 JSON、無 markdown）】
{
  "positions": [
    {
      "name": "摩洛哥",
      "desc": "地圖最左上方、臨地中海、阿爾及利亞以西"
    },
    {
      "name": "查德",
      "desc": "中央位置、尼日以東、中非以北"
    }
  ]
}

【desc 寫法】
- 用方位詞 + 相鄰關係：「左上方」「中央偏右」「東北角」「鄰 X」「X 以南」
- 描述要**夠精確**、讓人看另一張同一張地圖時能找到同位置
- 1-2 句、中文
- 不要直接寫名字（如「摩洛哥的位置」）、要寫地理特徵（「西北角、臨地中海」）

【重要】
- 列出**所有看到的紅字標籤**、不要漏
- 每個標籤一個 entry、不要合併
- 名字按你**實際看到的**列、不要從 hint 反推

只輸出 JSON。`

  const rawText = (await generateGeminiText(currentModelName, [
    prompt,
    { inlineData: { mimeType, data } }
  ], {
    routeKey: 'answer_key.locate'  // 復用 locate route、純文字回答 + 圖片 input
  })).replace(/```json|```/g, '').trim()

  let parsed
  try { parsed = JSON.parse(rawText) } catch { return null }
  if (!parsed || !Array.isArray(parsed.positions)) return null
  return parsed.positions
    .map((p: { name?: unknown; desc?: unknown }) => ({
      name: String(p?.name ?? '').trim(),
      desc: String(p?.desc ?? '').trim()
    }))
    .filter((p: { name: string; desc: string }) => p.name && p.desc)
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
  submissionId?: string,
  submissionSource?: string,
  onStage?: GradingStageCallback,
  // 2026-06-20: 拆段控制（成本最佳化）。不傳＝原本一氣呵成跑完 3 call（向後相容）。
  //   stopAfterClassify：只跑 call 1(classify)、回 { _phaseAClassifyContext }（含 bbox）給 peer 檢查。
  //   resumeClassifyContext：跳過 call 1、用既有 context 直接跑 call 2(read)+3(arbiter)。
  //   rerunPageNums：call 1 只重跑這幾頁(1-based)、其餘頁沿用 prior context（需配 resume-less 的 call 1 + 帶 prior）。
  //   clearForRerun：重跑前先請 server 清空該卷舊的 phase_a_state/grading_result/score/graded_at（重新截取清除）。
  opts?: { stopAfterClassify?: boolean; resumeClassifyContext?: unknown; rerunPageNums?: number[]; priorClassifyContext?: unknown; clearForRerun?: boolean }
): Promise<PhaseAResult> {
  const normalizedAnswerKey = normalizeAnswerKeyShortAnswerDimensions(answerKey, domain)
  // 2026-05-17: ink session 改在每個 call 之前 ensureInkSessionFresh、不在這裡先拿（拆 3 call 後每個都自己刷一次）

  const compressed = await compressForGemini(submissionImageBlob, GEMINI_SINGLE_IMAGE_TARGET_BYTES, 'phase-a')
  const imageBase64 = await blobToBase64(compressed)
  const mimeType = compressed.type || submissionImageBlob.type || 'image/jpeg'

  // 2026-05-17: Phase A 拆 3 個 HTTP call（classify + read + arbiter）、每個 call 各吃 300s budget
  //   call 1 — grading.phase_a_classify             → OCR + classify + bbox 後處理、回 _phaseAClassifyContext
  //   call 2 — grading.phase_a (帶 ClassifyContext) → crop + AI1 + AI2 read + pre-overrides、回 _phaseAReadContext
  //   call 3 — grading.phase_a_arbiter              → AI3 + 最終 build
  // 解決問題：拆前 5 並行有些 AI1 read 飆 197s 撞 290s budget、現在獨立 300s 後絕對跑得完

  // 共用 fetch helper：自動處理 409 (ink session refresh) + 解析 candidates[0]
  // 2026-06-03: 加暫時性失敗重試（至少 1 次）——解決 502 閘道錯誤（函式 OOM/崩潰）與
  //   504 timeout（server 回 pipelineFailure MODEL_TIMEOUT/503）的偶發單槍失敗。
  //   只重試「重跑可能會好」的暫時性錯誤；400/quality-gate/429 不在此重試（deterministic 或需長退避）。
  const MAX_PHASE_RETRIES = 1
  const TRANSIENT_HTTP_STATUSES = new Set([408, 502, 503, 504])
  const RETRYABLE_FAILURE_CODES = new Set(['MODEL_TIMEOUT', 'MODEL_503_OVERLOAD'])
  const postPhaseOnce = async (body: string): Promise<{ resp: Response; data: any; text: string | undefined }> => {
    let resp = await proxyFetch({
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body
    })
    if (resp.status === 409) {
      console.warn('[gradePhaseA] Ink session not found (409), refreshing...')
      setInkSessionId(null)
      const { sessionId: newSid } = await startInkSession()
      // 重建 body 帶新 sid（簡單做法：呼叫端要傳新 sid 進來，這裡 fallback 用 newSid 套到舊 body）
      const reparsed = JSON.parse(body)
      reparsed.inkSessionId = newSid
      resp = await proxyFetch({
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(reparsed)
      })
    }
    const data = await resp.json().catch(() => null) as Record<string, unknown> | null
    if (typeof (data as any)?.ink?.balanceAfter === 'number' && Number.isFinite((data as any).ink.balanceAfter)) {
      dispatchInkBalance((data as any).ink.balanceAfter)
    }
    const text = (data as any)?.candidates?.[0]?.content?.parts?.[0]?.text as string | undefined
    return { resp, data, text }
  }
  const postPhase = async (body: string): Promise<{ resp: Response; data: any; text: string | undefined }> => {
    let lastResult: { resp: Response; data: any; text: string | undefined } | null = null
    for (let attempt = 0; attempt <= MAX_PHASE_RETRIES; attempt++) {
      const result = await postPhaseOnce(body)
      // 是否為「重跑可能會好」的暫時性失敗：閘道層 5xx，或 server 包好的 timeout/過載 pipelineFailure
      const failureCode = (result.data as any)?.pipelineFailure?.reasonCode
      const isTransient =
        (!result.resp.ok && TRANSIENT_HTTP_STATUSES.has(result.resp.status)) ||
        (typeof failureCode === 'string' && RETRYABLE_FAILURE_CODES.has(failureCode))
      if (isTransient && attempt < MAX_PHASE_RETRIES) {
        const backoffMs = 1500 * (attempt + 1)
        console.warn(
          `[gradePhaseA] 暫時性失敗 (status=${result.resp.status} code=${failureCode || '-'})，` +
          `${backoffMs}ms 後重試 ${attempt + 1}/${MAX_PHASE_RETRIES}...`
        )
        lastResult = result
        await delay(backoffMs)
        continue
      }
      return result
    }
    // 理論上不會到這（迴圈最後一圈一定 return），保險回最後一次結果
    return lastResult as { resp: Response; data: any; text: string | undefined }
  }

  const baseBody = (sid: string | null) => ({
    model: currentModelName,
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data: imageBase64 } }] }],
    ...(sid ? { inkSessionId: sid } : {}),
    ...(domain ? { domain } : {}),
    ...(assignmentId ? { assignmentId } : {}),
    ...(submissionId ? { submissionId } : {}),
    ...(answerSheetMode && answerSheetMode !== 'with_questions' ? { answerSheetMode } : {})
  })

  // ── Call 1: phase_a_classify ────────────────────────────────────────────
  // 2026-06-20: resumeClassifyContext 模式跳過 classify、直接用既有 context 跑 read+arbiter（省 classify 整段）。
  let classifyParsed: any = null
  if (opts?.resumeClassifyContext) {
    classifyParsed = { phaseAClassifyComplete: true, _phaseAClassifyContext: opts.resumeClassifyContext }
    onStage?.('classify', 'completed')
  } else {
    onStage?.('classify', 'started')
    const { sessionId: sid1 } = await ensureInkSessionFresh()
    const body1 = JSON.stringify({
      ...baseBody(sid1),
      routeKey: 'grading.phase_a_classify',
      answerKey: JSON.stringify(normalizedAnswerKey),
      ...(pageBreaks && pageBreaks.length > 0 ? { pageBreaks } : {}),
      ...(submissionSource ? { submissionSource } : {}),
      ...(classifyCorrections && classifyCorrections.length > 0 ? { classifyCorrections } : {}),
      // 2026-06-20: 只重跑指定頁(②)。server 只 AI-classify 這幾頁、其餘頁沿用 priorClassifyContext。
      ...(opts?.rerunPageNums && opts.rerunPageNums.length > 0 ? { rerunPageNums: opts.rerunPageNums } : {}),
      ...(opts?.priorClassifyContext ? { _phaseAClassifyContext: opts.priorClassifyContext } : {}),
      // 2026-06-20: 重跑前請 server 清空舊 phase_a_state/grading_result/score/graded_at（修「重新截取沒清 server 分數」）
      ...(opts?.clearForRerun ? { clearForRerun: true } : {})
    })
    const r1 = await postPhase(body1)
    if (r1.text) { try { classifyParsed = JSON.parse(r1.text) } catch {} }

    if (classifyParsed?.pipelineFailure) {
      console.warn('[gradePhaseA] classify pipelineFailure', classifyParsed.pipelineFailure)
      return classifyParsed as PhaseAResult
    }
    if (!r1.resp.ok && !classifyParsed) {
      throw new Error((r1.data as any)?.error || `Phase A classify failed: ${r1.resp.status}`)
    }
  }
  // 舊版相容：server 一次跑完
  if (classifyParsed?.phaseAComplete) {
    console.log('[gradePhaseA] server 一次跑完（舊版相容路徑）')
    onStage?.('classify', 'completed')
    onStage?.('read', 'started')
    onStage?.('read', 'completed')
    onStage?.('arbiter', 'started')
    onStage?.('arbiter', 'completed')
    return classifyParsed as PhaseAResult
  }
  if (!classifyParsed?.phaseAClassifyComplete || !classifyParsed?._phaseAClassifyContext) {
    throw new Error('Phase A: classify response missing phaseAClassifyComplete')
  }
  onStage?.('classify', 'completed')

  // 2026-06-20: 只跑到 classify（給 peer 檢查），回 { _phaseAClassifyContext }，不跑 read+arbiter。
  if (opts?.stopAfterClassify) {
    return classifyParsed as PhaseAResult
  }
  console.log('[gradePhaseA] classify 完成 → 進入 read call')

  // ── Call 2: phase_a (read) ──────────────────────────────────────────────
  onStage?.('read', 'started')
  const { sessionId: sid2 } = await ensureInkSessionFresh()
  const body2 = JSON.stringify({
    ...baseBody(sid2),
    routeKey: 'grading.phase_a',
    answerKey: JSON.stringify(normalizedAnswerKey),
    phaseAStopBeforeArbiter: true,
    _phaseAClassifyContext: classifyParsed._phaseAClassifyContext,
    ...(submissionSource ? { submissionSource } : {})
  })
  // 2026-06-30：read call 過全域 read 限流閘（防高併發 mass-blank）；classify(Call1)/arbiter(Call3) 不過閘。
  const r2 = await withReadSlot(() => postPhase(body2))
  let readParsed: any = null
  if (r2.text) { try { readParsed = JSON.parse(r2.text) } catch {} }

  if (readParsed?.pipelineFailure) {
    console.warn('[gradePhaseA] read pipelineFailure', readParsed.pipelineFailure)
    return readParsed as PhaseAResult
  }
  if (readParsed?.phaseAComplete) {
    console.log('[gradePhaseA] read 階段一次跑到底（含 arbiter）— 舊版相容')
    onStage?.('read', 'completed')
    onStage?.('arbiter', 'started')
    onStage?.('arbiter', 'completed')
    return readParsed as PhaseAResult
  }
  if (!readParsed?.phaseAReadyForArbiter || !readParsed?._phaseAReadContext) {
    if (!r2.resp.ok) throw new Error((r2.data as any)?.error || `Phase A read failed: ${r2.resp.status}`)
    throw new Error('Phase A: read response missing phaseAReadyForArbiter')
  }
  onStage?.('read', 'completed')
  console.log('[gradePhaseA] read 完成 → 進入 arbiter call')

  // ── Call 3: phase_a_arbiter ─────────────────────────────────────────────
  onStage?.('arbiter', 'started')
  const { sessionId: sid3 } = await ensureInkSessionFresh()
  const body3 = JSON.stringify({
    ...baseBody(sid3),
    routeKey: 'grading.phase_a_arbiter',
    _phaseAReadContext: readParsed._phaseAReadContext
  })
  const r3 = await postPhase(body3)

  if (r3.text) {
    try {
      const arbiterParsed = JSON.parse(r3.text) as PhaseAResult & { pipelineFailure?: unknown }
      if (arbiterParsed?.pipelineFailure) {
        console.warn('[gradePhaseA] arbiter pipelineFailure', arbiterParsed.pipelineFailure)
        return arbiterParsed as PhaseAResult
      }
      if (arbiterParsed?.phaseAComplete) {
        onStage?.('arbiter', 'completed')
        return arbiterParsed
      }
    } catch {}
  }

  if (!r3.resp.ok) throw new Error((r3.data as any)?.error || `Phase A arbiter failed: ${r3.resp.status}`)
  throw new Error('Phase A arbiter: unexpected response format (phaseAComplete missing)')
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
  submissionId?: string,
  gradeBand?: 'k9' | 'high'
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
    skipExplain: true,  // 2026-06-30 錯題引導改 on-demand：Phase B 不跑 explain、只算分
    ...(domain ? { domain } : {}),
    ...(assignmentId ? { assignmentId } : {}),
    ...(submissionId ? { submissionId } : {}),
    ...(answerSheetMode && answerSheetMode !== 'with_questions' ? { answerSheetMode } : {}),
    ...(gradeBand ? { gradeBand } : {})
  })

  let response = await proxyFetch({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: buildPhaseBBody(inkSessionId)
  })

  if (response.status === 409) {
    console.warn('[gradePhaseB] Ink session not found (409), creating new session and retrying...')
    setInkSessionId(null)
    const { sessionId: newSessionId } = await startInkSession()
    response = await proxyFetch({
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
 * 2026-05-17: Phase B 用 server 端 cached phase_a_state 跑（不重跑 Phase A）
 *
 * 用途：「重新批改」按鈕、學生 Phase A 已跑過、最終答案已在 DB（final_answers）、
 * 老師改 grading 標準 / 編輯了 final_answers 後想重新評分、不需要重跑 4 min 的 read。
 *
 * 後端 server 從 submissions.phase_a_state + submissions.final_answers 載入、跑 Phase B、寫結果。
 *
 * @param submissionImageBlob 學生作業圖片（給 Explain 階段看）
 * @param submissionId 要跑哪一份卷子
 * @param assignmentId 作業 id
 * @param finalAnswersOverride 可選——若 client 想用即時編輯的 finalAnswers 覆蓋 DB cached 值
 */
export async function gradePhaseBFromCache(
  submissionImageBlob: Blob,
  submissionId: string,
  assignmentId?: string,
  domain?: string,
  answerSheetMode?: 'with_questions' | 'answer_only',
  gradeBand?: 'k9' | 'high',
  finalAnswersOverride?: FinalAnswer[],
  onStage?: GradingStageCallback,
  withReviewCandidates?: boolean  // 2026-06-30 批兩候選：provisional 趟帶 true、server 算 read1/read2 兩候選分數附 detail
): Promise<GradingResult> {
  const compressed = await compressForGemini(submissionImageBlob, GEMINI_SINGLE_IMAGE_TARGET_BYTES, 'phase-b-cache')
  const imageBase64 = await blobToBase64(compressed)
  const mimeType = compressed.type || submissionImageBlob.type || 'image/jpeg'

  // 2026-05-18: Phase B 拆 2 個 HTTP call（accessor + explain）、各吃獨立 budget、loading UI 可分階段顯示
  //   call 1 — grading.phase_b_accessor  → 批改評分、回 _phaseBAccessorContext
  //   call 2 — grading.phase_b_explain   → 生成引導、回最終 GradingResult

  const postPhaseB = async (body: string): Promise<{ resp: Response; data: any; text: string | undefined }> => {
    let resp = await proxyFetch({
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body
    })
    if (resp.status === 409) {
      console.warn('[gradePhaseBFromCache] Ink session 409、刷新後重試...')
      setInkSessionId(null)
      const { sessionId: newSid } = await startInkSession()
      const reparsed = JSON.parse(body)
      reparsed.inkSessionId = newSid
      resp = await proxyFetch({
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(reparsed)
      })
    }
    const data = await resp.json().catch(() => null) as Record<string, unknown> | null
    if (typeof (data as any)?.ink?.balanceAfter === 'number' && Number.isFinite((data as any).ink.balanceAfter)) {
      dispatchInkBalance((data as any).ink.balanceAfter)
    }
    const text = (data as any)?.candidates?.[0]?.content?.parts?.[0]?.text as string | undefined
    return { resp, data, text }
  }

  const baseBody = (sid: string | null) => ({
    model: currentModelName,
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data: imageBase64 } }] }],
    ...(sid ? { inkSessionId: sid } : {}),
    fromCache: true,
    skipExplain: true,  // 2026-06-30 錯題引導改 on-demand：accessor call 直接回最終結果、不再打 explain
    ...(withReviewCandidates ? { withReviewCandidates: true } : {}),  // 批兩候選：server 算 read1/read2 候選分數
    submissionId,
    ...(finalAnswersOverride && finalAnswersOverride.length > 0 ? { finalAnswers: finalAnswersOverride } : {}),
    ...(domain ? { domain } : {}),
    ...(assignmentId ? { assignmentId } : {}),
    ...(answerSheetMode && answerSheetMode !== 'with_questions' ? { answerSheetMode } : {}),
    ...(gradeBand ? { gradeBand } : {})
  })

  // ── Call 1: phase_b_accessor ────────────────────────────────────────────
  onStage?.('accessor', 'started')
  const { sessionId: sid1 } = await ensureInkSessionFresh()
  const body1 = JSON.stringify({
    ...baseBody(sid1),
    routeKey: 'grading.phase_b_accessor'
  })
  // 2026-07-11: 502/503/504 退避重試——串流模式下 Phase A arbiter 函數（層級鏈使其存活 +11~45s）
  //   與 Phase B 派發重疊、偶發撞 Vercel 併發上限 → proxy 秒回 503（函數未執行、server 零痕跡）。
  //   槽位數秒即釋放、退避重試即過。實案：07-11 早上 32 份全滅＋round8 座11 單份（console 503 實錘）。
  let r1 = await postPhaseB(body1)
  for (let attempt = 0; !r1.resp.ok && [502, 503, 504].includes(r1.resp.status) && attempt < 3; attempt++) {
    const waitMs = 5000 * (attempt + 1) + Math.random() * 3000
    console.warn(`[gradePhaseBFromCache] accessor ${r1.resp.status}、${Math.round(waitMs / 1000)}s 後重試（${attempt + 1}/3）`)
    await new Promise((r) => setTimeout(r, waitMs))
    r1 = await postPhaseB(body1)
  }
  if (!r1.resp.ok) {
    const err = (r1.data as any) || {}
    let errMsg = `Phase B accessor failed: ${r1.resp.status}`
    if (typeof err?.error === 'string' && err.error) errMsg = err.error
    throw new Error(errMsg)
  }
  if (!r1.text) throw new Error('Phase B accessor: empty response text')
  let accessorParsed: any = null
  try { accessorParsed = JSON.parse(r1.text.replace(/```json|```/g, '').trim()) } catch {
    throw new Error('Phase B accessor: 無法解析回傳 JSON')
  }
  // 舊版相容：server 一次跑完（沒拆 accessor/explain）
  if (accessorParsed?.totalScore !== undefined || accessorParsed?.details !== undefined) {
    onStage?.('accessor', 'completed')
    onStage?.('explain', 'started')
    onStage?.('explain', 'completed')
    console.log('[gradePhaseBFromCache] server 一次跑完（舊版相容路徑）')
    return accessorParsed as GradingResult
  }
  if (!accessorParsed?.phaseBAccessorComplete || !accessorParsed?._phaseBAccessorContext) {
    throw new Error('Phase B accessor: 回傳缺少 _phaseBAccessorContext')
  }
  onStage?.('accessor', 'completed')
  console.log('[gradePhaseBFromCache] accessor 完成 → 進入 explain call')

  // ── Call 2: phase_b_explain ─────────────────────────────────────────────
  onStage?.('explain', 'started')
  const { sessionId: sid2 } = await ensureInkSessionFresh()
  const body2 = JSON.stringify({
    ...baseBody(sid2),
    routeKey: 'grading.phase_b_explain',
    _phaseBAccessorContext: accessorParsed._phaseBAccessorContext
  })
  const r2 = await postPhaseB(body2)
  if (!r2.resp.ok) {
    const err = (r2.data as any) || {}
    let errMsg = `Phase B explain failed: ${r2.resp.status}`
    if (typeof err?.error === 'string' && err.error) errMsg = err.error
    throw new Error(errMsg)
  }
  if (!r2.text) throw new Error('Phase B explain: empty response text')
  const parsed = JSON.parse(r2.text.replace(/```json|```/g, '').trim()) as GradingResult
  onStage?.('explain', 'completed')
  return parsed
}

// 2026-06-30 錯題引導 on-demand：學生在訂正卡按「需要引導」、填「哪裡不懂」後生成單題引導。
//   防濫用：消極/空白說明擋下（client 先擋、server 端再擋一次不可繞過）。
//   費用：走 grading.* route → server 端自動把點數歸老師（resolveBillingUserId）。
//   答案保密：標準答案由 server live 抓、絕不經 client（prompt 在 server 組）。
export function isMeaningfulConfusion(text: string): boolean {
  const raw = (text || '').trim()
  if (!raw) return false
  const stripped = raw.replace(/[\s,，。.!！?？、~～:：;；]/g, '')
  if (stripped.length < 4) return false  // 太短（「不會」「不懂」「不知道」）一律擋
  if (/^(這題|這個|題目|整題)?(我)?(都|完全|就是|統統|根本)?(不(知道|曉得|懂|會|清楚|明白|瞭解|知)|看不懂|沒(有|概念|想法)|毫無頭緒|忘記了?|忘了|未填|無|不太懂|不太會)$/.test(stripped)) return false
  const meaningful = stripped.replace(/(不知道|不曉得|不清楚|不明白|看不懂|不懂|不會|沒概念|沒想法|毫無頭緒|忘記了?|忘了|不太懂|不太會|這題|這個|這道|題目|整題|我|都|完全|就是|根本)/g, '')
  if (meaningful.length < 3) return false
  return true
}

export async function generateSingleQuestionGuidance(params: {
  submissionId: string
  questionId: string
  assignmentId: string
  studentConfusion: string
  answerSheetMode?: 'with_questions' | 'answer_only'
}): Promise<{ studentGuidance: string; mistakeType?: string }> {
  const { submissionId, questionId, assignmentId, studentConfusion, answerSheetMode } = params
  if (!isMeaningfulConfusion(studentConfusion)) {
    throw new Error('請具體說明你卡在哪裡（例如：哪個步驟、哪個字看不懂），不要只填「不會 / 不知道」。')
  }
  const { sessionId: sid } = await ensureInkSessionFresh()
  const body = JSON.stringify({
    model: currentModelName,
    contents: [{ role: 'user', parts: [{ text: 'error_guidance' }] }],
    inkSessionId: sid,
    routeKey: 'grading.error_guidance',
    submissionId,
    questionId,
    assignmentId,
    studentConfusion,
    ...(answerSheetMode && answerSheetMode !== 'with_questions' ? { answerSheetMode } : {})
  })
  let resp = await proxyFetch({
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body
  })
  if (resp.status === 409) {
    setInkSessionId(null)
    const { sessionId: newSid } = await startInkSession()
    const reparsed = JSON.parse(body); reparsed.inkSessionId = newSid
    resp = await proxyFetch({
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(reparsed)
    })
  }
  const data = await resp.json().catch(() => null) as Record<string, unknown> | null
  if (typeof (data as any)?.ink?.balanceAfter === 'number') dispatchInkBalance((data as any).ink.balanceAfter)
  if (!resp.ok) {
    const msg = (typeof (data as any)?.error === 'string' && (data as any).error) || '生成引導失敗、請稍後再試'
    throw new Error(msg)
  }
  const text = (data as any)?.candidates?.[0]?.content?.parts?.[0]?.text as string | undefined
  if (!text) throw new Error('生成引導回覆為空')
  const parsed = JSON.parse(text.replace(/```json|```/g, '').trim()) as { studentGuidance?: string; mistakeType?: string }
  const guidance = (parsed?.studentGuidance || '').trim()
  if (!guidance) throw new Error('生成引導回覆為空')
  return { studentGuidance: guidance, mistakeType: parsed?.mistakeType }
}

// 2026-06-30 末端審查「人工輸入」只重批那一題：server 抓答案卷、deterministic 或單題 accessor、回該題分數。
//   （老師端動作 → 計費歸老師自己；答案卷 server live 抓、不經 client。）
export async function gradeOneQuestion(params: {
  submissionId: string
  questionId: string
  assignmentId: string
  studentAnswer: string
  domain?: string
  answerSheetMode?: 'with_questions' | 'answer_only'
  gradeBand?: 'k9' | 'high'
}): Promise<{ questionId: string; score: number; maxScore: number; isCorrect: boolean; studentAnswer: string; scoringReason?: string }> {
  const { submissionId, questionId, assignmentId, studentAnswer, domain, answerSheetMode, gradeBand } = params
  const { sessionId: sid } = await ensureInkSessionFresh()
  const body = JSON.stringify({
    model: currentModelName,
    contents: [{ role: 'user', parts: [{ text: 'grade_one' }] }],
    inkSessionId: sid,
    routeKey: 'grading.grade_one',
    submissionId, questionId, assignmentId, studentAnswer,
    ...(domain ? { domain } : {}),
    ...(answerSheetMode && answerSheetMode !== 'with_questions' ? { answerSheetMode } : {}),
    ...(gradeBand ? { gradeBand } : {})
  })
  let resp = await proxyFetch({ method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body })
  if (resp.status === 409) {
    setInkSessionId(null)
    const { sessionId: newSid } = await startInkSession()
    const rp = JSON.parse(body); rp.inkSessionId = newSid
    resp = await proxyFetch({ method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(rp) })
  }
  const data = await resp.json().catch(() => null) as Record<string, unknown> | null
  if (typeof (data as any)?.ink?.balanceAfter === 'number') dispatchInkBalance((data as any).ink.balanceAfter)
  if (!resp.ok) throw new Error((typeof (data as any)?.error === 'string' && (data as any).error) || '單題批改失敗、請稍後再試')
  const text = (data as any)?.candidates?.[0]?.content?.parts?.[0]?.text as string | undefined
  if (!text) throw new Error('單題批改回覆為空')
  const p = JSON.parse(text.replace(/```json|```/g, '').trim()) as { questionId?: string; score?: number; maxScore?: number; isCorrect?: boolean; studentAnswer?: string; scoringReason?: string }
  // 2026-07-06: 帶回 scoringReason——finalize 手改重批後把 detail 的判定理由一併更新（user 實測：分數變了理由還是舊的）
  return { questionId: p.questionId ?? questionId, score: Number(p.score) || 0, maxScore: Number(p.maxScore) || 0, isCorrect: p.isCorrect === true, studentAnswer: p.studentAnswer ?? studentAnswer, scoringReason: typeof p.scoringReason === 'string' ? p.scoringReason : undefined }
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
  conceptMap: { code: string; label: string; description?: string }[],
  questionBookletImages?: Blob[]
): Promise<Record<string, { code: string; label: string }>> {
  if (!isGeminiAvailable) throw new Error('Gemini 服務未設定')
  if (questions.length === 0 || conceptMap.length === 0) return {}

  // answer_only 模式時，answerSheetImages 只有答案格沒題幹、AI 無法判斷概念。
  // 呼叫方若有題本圖、優先使用題本（題本含題幹）；否則 fallback 到答案卷。
  const sourceImages = (questionBookletImages && questionBookletImages.length > 0)
    ? questionBookletImages
    : answerSheetImages
  const sourceLabel = (questionBookletImages && questionBookletImages.length > 0)
    ? 'booklet'
    : 'answer-sheet'
  console.log(`[tag_concepts] using ${sourceImages.length} ${sourceLabel} image(s)`)

  const imageParts: GeminiRequestPart[] = []
  for (const img of sourceImages) {
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


// ═══════════════════════════════════════════════════════════════════════════
// 生成答案卷：AI 解題起草（answer_key.solve）
//   老師只給題目卷 → ①結構推斷（大題/題數/配分/缺題偵測）→ ②解題×2（分歧標記）
//   → 組 AnswerKey 草稿交人工確認。prompt 取自 2026-09-04 段1 沙盒實證版
//   （國語可解 82.5%、數學 91%、結構推斷 5/5；佐證見 redpenaisever/docs/實驗成本記錄.md）。
//   ⛔ 鐵則：缺題大題（題目印在別處）一律出空答案格請老師補，不得讓 AI 硬編。
// ═══════════════════════════════════════════════════════════════════════════

interface SolveStructureSection {
  section: string
  perScore: number
  totalScore: number
  count: number
  questionsInBooklet: boolean
  questionCategory: string
  /** 大題內混多種題型時的組成（依卷面順序；count 加總=大題題數）。作答卷排版據此分作圖/計算格 */
  typeBreakdown?: Array<{ questionCategory: string; count: number }>
  /** 這個大題從題目卷第幾頁開始（1-based；人工確認畫面自動翻頁用） */
  pageStart?: number
}

const SOLVE_TYPE_MENU =
  'single_choice(單選/配合)、fill_blank(填空/國字注音/列式)、short_answer(簡答/註釋)、true_false(是非)、multi_check(多選勾選)、word_problem(應用題，要求寫出計算過程)、grid_geometry(作圖題)'

function buildSolveStructurePrompt(pageCount: number): string {
  return `你是考卷系統的解析引擎。以下是一份考卷的「題目卷」共 ${pageCount} 頁。
這種考卷有時是分離式：部分大題的題目印在另一張答案卷上，題目卷只有大題標題（例如「一、國字注音（每字1分，共10分，答案請書寫於答案卷）」）。

請盤點每一個大題，輸出：
- section：大題編號與名稱（如「一、國字注音」）
- perScore：每題（或每字）配分
- totalScore：該大題總分
- count：題數——若題目不在題目卷上，就從「每題X分，共Y分」推算
- questionsInBooklet：true/false——這個大題的題目本身是否印在題目卷上（false = 只有標題，需要請老師補標準答案）
- questionCategory：這個大題的主要題型，從這個清單選一個——${SOLVE_TYPE_MENU}
- typeBreakdown：⚠ 大題內若混多種題型（例如「計算作圖題」＝2 題作圖＋1 題計算），
  必須依卷面順序列出組成：[{"questionCategory":"grid_geometry","count":2},{"questionCategory":"word_problem","count":1}]，
  count 加總須等於大題題數；單一題型的大題可省略此欄
- pageStart：這個大題的題目（或標題）從題目卷第幾頁開始（1-based）

注意：「每字1分」的大題若一題考多個字，題數以答案格數計。全卷總分應等於各大題 totalScore 加總，請自我檢查。

只輸出 JSON：
{"sections":[{"section":"一、...","perScore":1,"totalScore":10,"count":10,"questionsInBooklet":true,"questionCategory":"fill_blank"}],"fullTotal":100}`
}

function buildSolvePrompt(domain: string, pageCount: number, idLines: string): string {
  return `你是${domain || '學科'}老師，正在為這份考卷編製標準答案。以下是完整題本 ${pageCount} 頁的圖。

請逐題解題，題號清單（依卷面順序；括號是該題所在大題與序號，卷面印的題號順序與清單一致）：
${idLines}

每一題輸出：
- id：照清單
- questionCategory：從這個清單選一個——${SOLVE_TYPE_MENU}
- answer：標準答案
  ・選擇題：只寫選項代號；⚠ 依卷面實際選項作答——配合題選項可能是 A~J 不只 A~D
  ・要求「列出算式/不等式」的題：只寫式子（用 x 當未知數、<= >= 表示不等號），除非題目也要求解
  ・要求解的題：只寫最終答案（數值或範圍，如 x>=7、無解）
  ・國字注音題：題目給注音要你寫國字 → 只寫那個國字；給國字要你寫注音 → 只寫注音（含調號）
  ・註釋題（解釋詞義）：用最精簡的釋義，可用頓號列多種寫法
- maxScore：這一題在卷面上印的配分（如「(3分)」）；沒印就省略
- spatial3d：true 僅當題目涉及立體圖形／三視圖／展開圖／空間堆疊（這類題請特別小心驗算）；否則省略
- referenceAnswer：作圖題/應用題的完整參考答案（含步驟）；其他題可省略
- vjRubric：只有 grid_geometry（作圖題）要輸出——視覺逐項判準：
  {"itemLabels":["要畫的子項1","子項2"],"itemScores":[2,1],"condition":"學生每項該做什麼（一句話）","gradingDefinition":"什麼樣的作答算對（含⛔什麼不算；判準要具體到圖形特徵）"}
  itemScores 依卷面配分拆（如「步驟1佔2分、步驟2佔1分」）；加總必須等於該題配分。
- levelRubric：只有 word_problem（應用題）要輸出——會考級分制評分規準：
  {"levels":[{"level":3,"score":<滿分>,"criteria":"..."},{"level":2,...},{"level":1,...},{"level":0,"score":0,"criteria":"..."}],
   "levelRules":[{"level":3,"requireAll":["E1",...]},{"level":2,"requireAll":[...],"requireAny":[...]},{"level":1,"requireAny":[...]},{"level":0}],
   "requiredElements":[{"key":"E1","desc":"具體要素（寫出實際式子/數值/圖形特徵）＋⛔註明什麼不算給分"}],
   "toleratedFlaws":["可容忍的寫法差異（單位、同義描述、未化簡）"]}
  要素越具體，之後 AI 批改越準。

規則：
1. 每題認真計算、驗算後再作答；依題本上的文章與題幹作答，不要憑課外記憶猜測。
1a. 有些題目的條件組合起來可能「無解」。若驗算發現所有候選都不滿足條件，答案就誠實寫「無解」，
    不要硬湊數字；但也不要輕率宣告——必須先窮舉/驗算過才能下此結論。
2. 沒把握的題照樣作答，並在 uncertain 欄列出題號。
3. ⛔ 只作答清單上的題，不可自行增加題目。
4. 只輸出 JSON：
{"answers":[{"id":"1-1-1","questionCategory":"fill_blank","answer":"..."}],"uncertain":"沒把握的題號；沒有就空字串"}`
}

// 分歧比對只對「答案是短值」的客觀題型做：描述型題（作圖/應用/計算/簡答）兩次措辭
// 幾乎必不同→永遠標紅=假警報；它們的把關靠 rubric＋人工確認，不靠字串比對。
const SOLVE_DISAGREEMENT_CATEGORIES = new Set([
  'single_choice', 'multi_choice', 'circle_select_one', 'circle_select_many',
  'single_check', 'multi_check', 'table_check', 'true_false',
  'fill_blank', 'multi_fill', 'fill_variants', 'table_cell', 'ordering', 'matching', 'mark_in_text', 'map_fill'
])

/** 解題答案正規化（分歧比對用；同段1c 沙盒） */
function normalizeSolvedAnswer(s: unknown): string {
  return String(s ?? '')
    .replace(/[\s，,。．.（）()「」'"]/g, '')
    .replace(/≤|≦/g, '<=')
    .replace(/≥|≧/g, '>=')
    .replace(/×/g, '*')
    .replace(/÷/g, '/')
    .replace(/[０-９ａ-ｚＡ-Ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toUpperCase()
}

export interface SolveAnswerKeyOptions {
  domain?: string
  onProgress?: (msg: string) => void
  /** 只做結構推斷（題型/題數/配分骨架、全卷缺答），不解題——主路徑：答案由老師手寫參考答案卷回讀 */
  structureOnly?: boolean
}

export async function solveAnswerKeyFromBooklet(
  bookletImages: Blob[],
  opts?: SolveAnswerKeyOptions
): Promise<AnswerKey> {
  if (!bookletImages.length) throw new Error('沒有題目卷可解析')
  const onProgress = opts?.onProgress ?? (() => {})
  const imageParts: GeminiRequestPart[] = []
  for (let i = 0; i < bookletImages.length; i++) {
    imageParts.push(`【第 ${i + 1} 頁】`)
    imageParts.push({
      inlineData: { mimeType: bookletImages[i].type || 'image/jpeg', data: await blobToBase64(bookletImages[i]) }
    })
  }

  // ① 結構推斷
  onProgress('AI 正在分析考卷結構（大題、題數、配分）…')
  const structText = await generateGeminiText(
    currentModelName,
    [buildSolveStructurePrompt(bookletImages.length), ...imageParts],
    { routeKey: 'answer_key.solve' }
  )
  const struct = parseGeminiJsonText(structText) as { sections?: SolveStructureSection[] } | null
  const sections = Array.isArray(struct?.sections) ? struct!.sections! : []
  if (!sections.length) throw new Error('AI 無法辨識考卷結構，請確認題目卷影像清晰完整')

  // 題號骨架（id 慣例 1-<大題>-<序>；anchorHint 供大題標題與排版引擎使用）
  const skeleton = sections.flatMap((sec, si) => {
    const n = Math.max(0, Math.min(200, sec.count | 0))
    // 大題內混題型（如計算作圖題＝作圖×2＋計算×1）：依 typeBreakdown 逐題展開類別
    const perQuestionCategory: string[] = []
    if (Array.isArray(sec.typeBreakdown) && sec.typeBreakdown.length > 0) {
      for (const part of sec.typeBreakdown) {
        for (let i = 0; i < Math.max(0, part.count | 0) && perQuestionCategory.length < n; i++) {
          perQuestionCategory.push(String(part.questionCategory))
        }
      }
    }
    return Array.from({ length: n }, (_, i) => ({
      id: `1-${si + 1}-${i + 1}`,
      section: sec,
      categoryOverride: perQuestionCategory[i],
      anchorHint: `位於『${sec.section}』第 ${i + 1} 格`,
      bookletPageIndex: Number.isFinite(sec.pageStart) ? Math.max(0, (sec.pageStart as number) - 1) : undefined
    }))
  })
  const solvable = opts?.structureOnly ? [] : skeleton.filter((q) => q.section.questionsInBooklet)

  // ② 解題 ×2（分歧標記——不穩定的題請老師優先看）
  let solvedById = new Map<string, { questionCategory?: string; answer?: string; maxScore?: number; spatial3d?: boolean; referenceAnswer?: string; levelRubric?: unknown; vjRubric?: unknown }>()
  let run2ById: typeof solvedById = new Map()
  const disagreementIds = new Set<string>()
  if (solvable.length > 0) {
    onProgress(`AI 正在解 ${solvable.length} 題（跑兩次交叉比對）…`)
    const idLines = solvable.map((q) => `${q.id}（${q.anchorHint}）`).join('\n')
    const solveOnce = async () => {
      const text = await generateGeminiText(
        currentModelName,
        [buildSolvePrompt(opts?.domain ?? '', bookletImages.length, idLines), ...imageParts],
        { routeKey: 'answer_key.solve' }
      )
      const parsed = parseGeminiJsonText(text) as { answers?: Array<{ id: string; questionCategory?: string; answer?: string; maxScore?: number; spatial3d?: boolean; referenceAnswer?: string; levelRubric?: unknown; vjRubric?: unknown }> } | null
      return new Map((parsed?.answers ?? []).map((a) => [String(a.id), a]))
    }
    const [run1, run2] = await Promise.all([solveOnce(), solveOnce()])
    solvedById = run1
    run2ById = run2
    const stringDiffPairs: Array<{ id: string; a1: string; a2: string }> = []
    for (const q of solvable) {
      const a1 = run1.get(q.id)
      const a2 = run2.get(q.id)
      const cat = String(a1?.questionCategory || q.section.questionCategory || '')
      if (!SOLVE_DISAGREEMENT_CATEGORIES.has(cat)) continue
      if (!a1 || !a2) { disagreementIds.add(q.id); continue }
      if (normalizeSolvedAnswer(a1.answer) !== normalizeSolvedAnswer(a2.answer)) {
        // code-first：線性式/數列的等價 code 可精確判定（mathEquivalence），
        // true→不標紅、false→直接標紅（可信）、null→留給 AI 等價 call
        const codeVerdict = mathAnswersEquivalent(String(a1.answer ?? ''), String(a2.answer ?? ''))
        if (codeVerdict === true) continue
        if (codeVerdict === false) { disagreementIds.add(q.id); continue }
        stringDiffPairs.push({ id: q.id, a1: String(a1.answer ?? ''), a2: String(a2.answer ?? '') })
      }
    }
    // 字串不同 ≠ 真分歧：數學等價寫法（x-3 vs x-12+9、頓號 vs 逗號）先用便宜文字 call 自查，
    // 等價→不標紅（採第一輪答案）；真不等價才標紅。只送不一致的題、無圖片，成本 ~NT$0.1/卷。
    if (stringDiffPairs.length > 0) {
      try {
        const eqPrompt = `你是數學/國文老師。以下每組是同一題的兩個作答，判斷兩者是否等價（同一數學式的等價寫法/移項/未化簡 vs 化簡、分隔符差異、同義描述）。
只輸出 JSON：{"verdicts":[{"id":"...","equivalent":true}]}

${stringDiffPairs.map((p) => `id=${p.id}｜答案一：${p.a1}｜答案二：${p.a2}`).join('\n')}`
        const eqText = await generateGeminiText(currentModelName, [eqPrompt], { routeKey: 'answer_key.solve' })
        const eq = parseGeminiJsonText(eqText) as { verdicts?: Array<{ id: string; equivalent?: boolean }> } | null
        const eqById = new Map((eq?.verdicts ?? []).map((v) => [String(v.id), !!v.equivalent]))
        for (const pDiff of stringDiffPairs) {
          if (!eqById.get(pDiff.id)) disagreementIds.add(pDiff.id)
        }
      } catch {
        // 等價自查失敗 → 保守全標紅（寧多看不漏看）
        for (const pDiff of stringDiffPairs) disagreementIds.add(pDiff.id)
      }
    }
  }

  // ③ 組 AnswerKey 草稿
  // 配分保底：AI 沒讀到卷面配分時，大題總分做「整數分配」（10分3題→3,3,4，餘數給最後幾題），
  // 不做小數均分（3.33 會讓總分變 99.99、也不符合老師慣例）。
  const fallbackScoreByQid = new Map<string, number>()
  {
    const bySection = new Map<SolveStructureSection, string[]>()
    for (const q of skeleton) {
      if (!bySection.has(q.section)) bySection.set(q.section, [])
      bySection.get(q.section)!.push(q.id)
    }
    for (const [sec, ids] of bySection) {
      const total = Number(sec.totalScore) > 0 ? Number(sec.totalScore) : Number(sec.perScore) * ids.length
      const n = ids.length
      if (!(total > 0) || n === 0) continue
      const base = Math.floor(total / n)
      const remainder = total - base * n
      ids.forEach((qid, i) => {
        // 餘數平攤到最後 remainder 題（各 +1）；total 含小數時保留原 perScore 行為
        const extra = Number.isInteger(total) ? (i >= n - remainder ? 1 : 0) : 0
        fallbackScoreByQid.set(qid, Number.isInteger(total) ? base + extra : Number(sec.perScore))
      })
    }
  }
  const questions: AnswerKeyQuestion[] = skeleton.map((q) => {
    const solved = q.section.questionsInBooklet ? solvedById.get(q.id) : undefined
    const category = String(solved?.questionCategory || q.categoryOverride || q.section.questionCategory || 'fill_blank')
    // 配分：優先用卷面印的（解題讀出），否則退回大題總分整數分配（老師可改）
    const solvedScore = typeof solved?.maxScore === 'number' && solved.maxScore > 0 && solved.maxScore <= 100 ? solved.maxScore : undefined
    const base: AnswerKeyQuestion = {
      id: q.id,
      questionCategory: category as AnswerKeyQuestion['questionCategory'],
      answer: String(solved?.answer ?? ''),
      maxScore: solvedScore ?? fallbackScoreByQid.get(q.id) ?? q.section.perScore,
      anchorHint: q.anchorHint,
      aiQuestionCategory: category,
      ...(q.bookletPageIndex != null ? { bookletPageIndex: q.bookletPageIndex } : {})
    } as AnswerKeyQuestion
    if (solved?.referenceAnswer) (base as { referenceAnswer?: string }).referenceAnswer = String(solved.referenceAnswer)
    // 評分方式契約（判分方法×題型對照）：word_problem＝級分制 levelRubric；grid_geometry＝VJ vjRubric
    if (solved?.levelRubric && category === 'word_problem') {
      ;(base as { levelRubric?: unknown }).levelRubric = solved.levelRubric
    }
    if (solved?.vjRubric && category === 'grid_geometry') {
      const vr = solved.vjRubric as { itemLabels?: unknown; itemScores?: unknown; condition?: unknown; gradingDefinition?: unknown }
      if (Array.isArray(vr.itemLabels) && vr.itemLabels.length > 0) {
        ;(base as { vjRubric?: unknown }).vjRubric = {
          itemLabels: vr.itemLabels.map(String),
          ...(Array.isArray(vr.itemScores) && vr.itemScores.length === vr.itemLabels.length ? { itemScores: vr.itemScores.map(Number) } : {}),
          ...(vr.condition ? { condition: String(vr.condition) } : {}),
          ...(vr.gradingDefinition ? { gradingDefinition: String(vr.gradingDefinition) } : {})
        }
      }
    }
    // 標紅（強制人工優先確認）的四個來源——全部單調（只加標記不改答案）：
    // ①兩輪答案真分歧 ②「無解」答案（段1f：提示救真無解但會誤傷→兩種都給老師看）
    // ③空間題（立體/三視圖/堆疊＝這代模型穩定天花板，穩定錯不會自我暴露）
    // ④rubric 結構問題：兩輪結構對不上（要素數/逐項配分/級距分數）、配分加總不符、該有 rubric 卻沒有
    let needsReview = disagreementIds.has(q.id) || /無解/.test(String(solved?.answer ?? ''))
    if (solved?.spatial3d === true) needsReview = true
    const r2 = run2ById.get(q.id)
    if (category === 'grid_geometry') {
      const v1 = (base as { vjRubric?: { itemLabels?: unknown[]; itemScores?: number[] } }).vjRubric
      const v2 = (r2?.vjRubric ?? null) as { itemLabels?: unknown[] } | null
      if (!v1) needsReview = true
      else {
        if (Array.isArray(v1.itemScores) && v1.itemScores.length > 0) {
          const sum = v1.itemScores.reduce((t, n) => t + (Number(n) || 0), 0)
          if (base.maxScore != null && Math.abs(sum - base.maxScore) > 1e-9) needsReview = true
        }
        if (Array.isArray(v2?.itemLabels) && Array.isArray(v1.itemLabels) && v2!.itemLabels!.length !== v1.itemLabels.length) needsReview = true
      }
    }
    if (category === 'word_problem') {
      const l1 = (base as { levelRubric?: { levels?: Array<{ score?: number }>; requiredElements?: unknown[] } }).levelRubric
      const l2 = (r2?.levelRubric ?? null) as { requiredElements?: unknown[] } | null
      if (!l1) needsReview = true
      else {
        const top = Array.isArray(l1.levels) ? Number(l1.levels[0]?.score) : NaN
        if (base.maxScore != null && Number.isFinite(top) && Math.abs(top - base.maxScore) > 1e-9) needsReview = true
        if (Array.isArray(l2?.requiredElements) && Array.isArray(l1.requiredElements) && l2!.requiredElements!.length !== l1.requiredElements.length) needsReview = true
      }
    }
    if (needsReview) (base as { solveDisagreement?: boolean }).solveDisagreement = true
    return base
  })

  const totalScore = questions.reduce((t, q) => t + (q.maxScore ?? 0), 0)
  onProgress('解題完成，整理草稿…')
  return normalizeAnswerKeyShortAnswerDimensions({ questions, totalScore }, opts?.domain)
}


// ═══ 生成答案卷：讀老師手寫參考答案（answer_key.read_reference）════════════
//   輸入＝依定版 bbox 裁好的格圖（generatedSheetAlign），一次 call 合批轉錄。
//   prompt 取自段4 端到端實測版（20 格全對）；空白格回 BLANK。
export interface ReferenceCellInput {
  id: string
  dataUrl: string
  /** 題型提示（影響轉錄格式：注音/代號/數學式） */
  hint: string
}

export async function readReferenceAnswerCells(cells: ReferenceCellInput[]): Promise<Map<string, string>> {
  if (!cells.length) return new Map()
  const parts: GeminiRequestPart[] = [
    `以下 ${cells.length} 張圖是老師手寫「參考答案卷」裁出的作答格。逐張轉錄手寫內容：
・數學式：分數寫 a/b、不等號用 <= >=、乘號可省略
・注音：含調號（如 ㄗㄜˋ）
・選項代號：只寫字母
・空白格回 BLANK
只輸出 JSON：{"reads":[{"i":1,"text":"..."}]}`
  ]
  for (let i = 0; i < cells.length; i++) {
    const m = cells[i].dataUrl.match(/^data:([^;]+);base64,(.+)$/)
    if (!m) continue
    parts.push(`【${i + 1}】(${cells[i].hint})`)
    parts.push({ inlineData: { mimeType: m[1], data: m[2] } })
  }
  const text = await generateGeminiText(currentModelName, parts, { routeKey: 'answer_key.read_reference' })
  const parsed = parseGeminiJsonText(text) as { reads?: Array<{ i: number; text?: string }> } | null
  const out = new Map<string, string>()
  for (const r of parsed?.reads ?? []) {
    const cell = cells[r.i - 1]
    if (!cell) continue
    const t = String(r.text ?? '').trim()
    out.set(cell.id, t === 'BLANK' ? '' : t)
  }
  return out
}
