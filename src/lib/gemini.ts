import {
  db,
  type Submission,
  type GradingResult,
  type AnswerKey,
  type AnswerExtractionCorrection
} from './db'
import { blobToBase64 as blobToDataUrl, compressImageFile } from './imageCompression'
import { isIndexedDbBlobError, shouldAvoidIndexedDbBlob } from './blob-storage'
import { dispatchInkBalance } from './ink-events'
import { getInkSessionId, startInkSession } from './ink-session'

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

// 🆕 AnswerKey 緩存引用（用於跨請求共享）
let cachedAnswerKeyHash: string | null = null
let cachedAnswerKeyJson: string | null = null

/**
 * 設置 AnswerKey 緩存（同一份作業的多次請求共享）
 */
export function setAnswerKeyCache(answerKey: AnswerKey | null): void {
  if (answerKey) {
    cachedAnswerKeyJson = JSON.stringify(answerKey)
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
  options?: { useAnswerKeyCache?: boolean }
): Promise<{ text: string; data: any }> {
  const useAnswerKeyCache = options?.useAnswerKeyCache ?? false
  
  // 🆕 AnswerKey 緩存邏輯
  let answerKeyPayload: { answerKey?: string; answerKeyRef?: string } = {}
  if (useAnswerKeyCache && cachedAnswerKeyJson) {
    if (cachedAnswerKeyHash) {
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
  const updatedBalance = Number(data?.ink?.balanceAfter)
  if (Number.isFinite(updatedBalance)) {
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
  options?: { useAnswerKeyCache?: boolean }
): Promise<string> {
  const MAX_RETRIES = 2
  let lastError: Error | null = null
  const useAnswerKeyCache = options?.useAnswerKeyCache ?? false

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // 確保 session 有效（第一次嘗試時檢查，重試時可能已經重建）
      let inkSessionId = getInkSessionId()
      
      // 如果沒有 session，嘗試建立（但不強制，因為用戶可能在非批改流程）
      // ensureInkSessionFresh 會在批改流程中被呼叫
      
      const result = await executeGeminiRequest(modelName, parts, inkSessionId, { useAnswerKeyCache })
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
  priorWeightTypes?: import('./db').QuestionCategoryType[] // Prior Weight：優先級順序

  // @deprecated 已廢棄，請使用 priorWeightTypes 替代
  allowedQuestionTypes?: import('./db').QuestionType[]
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
function buildGlobalRules(): string {
  return `
從標準答案圖片提取可機器批改的答案表。回傳純 JSON（無 Markdown）：

{
  "questions": [{
    "id": "1",           // 題號
    "type": 1 | 2 | 3,   // 題型分類（必填）
    "maxScore": 5,       // 滿分

    // Type 1 專用：標準答案
    "answer": "正確答案",

    // Type 2 專用：可接受的答案變體
    "referenceAnswer": "範例答案",
    "acceptableAnswers": ["同義詞1", "同義詞2"],

    // Type 3 專用：評分規準
    "referenceAnswer": "評分要點",
    "rubricsDimensions": [
      {"name": "計算過程", "maxScore": 3, "criteria": "步驟清晰"},
      {"name": "最終答案", "maxScore": 2, "criteria": "答案正確"}
    ],
    "rubric": {
      "levels": [
        {"label": "優秀", "min": 9, "max": 10, "criteria": "邏輯清晰完整"},
        {"label": "良好", "min": 7, "max": 8, "criteria": "大致正確"},
        {"label": "尚可", "min": 5, "max": 6, "criteria": "部分正確"},
        {"label": "待努力", "min": 1, "max": 4, "criteria": "多處錯誤"}
      ]
    },

    // AI偏離提醒
    "aiDivergedFromPrior": false,
    "aiOriginalDetection": 1
  }],
  "totalScore": 50
}

【通用原則】
- 題號：只為「有答案/作答區」的題目建立題號，必須輸出 idPath，並讓 id = idPath 用 "-" 串接
- 題號：圖片有就用，無則依題目順序補上（不可跳號）
- 配分：圖片有就用，無則估計（是非/選擇 2-5 分，簡答 5-8 分，申論 8-15 分）
- totalScore = 所有 maxScore 總和
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
🚨 判斷原則（最高優先級！）：
- **紅色** = 正確答案（學生需填寫部分）
- **黑色** = 題目提示（原本就印在上面的）

判斷流程（嚴格按此順序）：
1. 第一優先：尋找「與印刷顏色明顯不同的顏色」
   - 題目印刷通常是黑色
   - 答案印刷通嘗試紅色
2. 第二步：提取這些紅色的內容作為答案（不管內容是什麼形式）
3. 第三步：如果沒有明顯紅色，才參考題目要求

【複選題/題組勾選題識別】
⚠️ 勾選題可能是單選或複選，需正確識別為 1 題，不可拆分！

識別特徵：
- 題目有多個選項（□A □B □C □D）
- 題目說明「可複選」「選出所有正確的」「可勾選多個」
- 或題目沒有明確說明，但選項之間是並列關係（不是互斥的）

設定原則：
1. 必須視為 1 題（不可拆成 4 題）
2. 題型選擇：
   - 如果答案固定（如：「正確的是 A、C」）→ Type 1，answer: "A、C" 或 "AC"
   - 如果答案有多種表述（如：「A,C」「A C」「AC」都可以）→ Type 2，acceptableAnswers: ["A、C", "A,C", "AC", "A C"]
3. 題號：使用題目標示的題號（如：「三、」就用 "3"）

範例：
- 題目：「三、下列哪些選項正確？（可複選）□A 太陽從東邊升起 □B 地球是平的 □C 水會往低處流 □D 天空是綠色的」
- 設定：1 題，id: "3", type: 1 或 2, answer: "A、C" 或 acceptableAnswers: ["A、C", "AC", "A,C"]

【題型分類標準】
Type 1（唯一答案）：精確匹配，答案唯一且不可替換
- 例：是非題(O/X)、選擇題(A/B/C)、計算結果(2+3=5)

Type 2（多答案可接受）：核心答案固定但允許不同表述
- 例：詞義解釋「光合作用」vs「植物製造養分」
- 異音字造詞（須記錄讀音於 referenceAnswer）
- 相似字造詞（須記錄部首於 referenceAnswer）

Type 3（依表現給分）：開放式或計算題，需評分規準
- 計算題：用 rubricsDimensions，維度通常包括「計算過程」和「最終答案」
- 申論題：有明確答案要點時用 rubricsDimensions
- 多階段作答題：用 rubricsDimensions 分階段評分（不可拆成多題）
- 純評價題：用 rubric 4級評價（優秀/良好/尚可/待努力）

【反幻覺警告】（適用於所有操作）
❌ 禁止猜測：看不清楚時設 confidence < 0.5
❌ 禁止修正：即使答案錯誤也要保留原貌
❌ 禁止美化：即使字跡潦草也要如實提取
❌ 禁止推測：無法辨識時設 answerText: null
❌ 禁止創造：只提取圖片中實際存在的內容

⚠️ 寧可標記為 null，也不要猜測答案
`.trim()
}

/**
 * 建立領域特化規則（題型判斷式）
 */
function buildDomainRulesWithDecisionTree(domain: string = '其他'): string {
  const domainMap: Record<string, string> = {
    國語: `
【國語領域】

領域通用規則：
- 直排文字閱讀：從右上角開始，往左、往下依序排列
- 選項順序：甲乙丙丁通常是從右到左排列
- 題號編排：依照直排閱讀順序（圖片有題號就用，沒有則按順序編號）

題型判斷與擷取規則：

▸ 如果是「國字注音題」（雙方框結構：國字｜注音）：
  - 判斷為 Type 1
  - 每一個雙方框為一題(國字｜注音)，要獨立判斷考國字或注音(二擇一)，不要過度推論下一題。
  - answer 必須只會是國字與注音其中一個，可以用顏色判斷（範例：「弄(綠底黑字=題目)｜ㄋㄨㄥˋ(白底紅字=答案)」）
  - 如果有連續雙方框結構，強制拆分單獨各為一題，(範例：烘(白底紅字=答案)｜ㄏㄨㄥ(綠底黑字=題目) 烘(白底紅字=答案)｜ㄏㄨㄥ(綠底黑字=題目)，第一題 answer: "烘"，第二題 answer: "烘")

▸ 如果是「相近字造詞題」（如：辨/辯、嗇/普）：
  - 判斷為 Type 2
  - referenceAnswer 必須包含部首說明
  - acceptableAnswers 列出標準答案中的所有範例詞
  - 範例：「(言部)辯：辯護、爭辯」「(辛部)辨：辨別、分辨」

▸ 如果是「同音字造詞題」（如：ㄋㄨㄥˋ：弄/農）：
  - 判斷為 Type 2
  - referenceAnswer 必須包含讀音說明（如：「ㄋㄨㄥˋ讀音的詞語」）
  - acceptableAnswers 列出標準答案中的所有範例詞

▸ 如果是「異音字造詞題」（如：行（ㄏㄤˊ/ㄒㄧㄥˊ））：
  - 判斷為 Type 2
  - referenceAnswer 必須包含讀音說明
  - acceptableAnswers 列出標準答案中的所有範例詞

▸ 如果是「引導式多段問答題」（如：步驟一/步驟二）：
  - 識別特徵：「步驟一/二」「第一步/第二步」「先…再…」
  - 必須視為 1 題（不可拆成多題）
  - 判斷為 Type 3
  - 使用 rubricsDimensions 分階段：
    • 第一階段（引導）：criteria「完成選擇即可，無對錯」
    • 第二階段（主要作答）：criteria 寫具體評分標準

▸ 如果是「方格框題目」（如：□□□□）：
  - 一行連續方格 = 1 題
  - 題號：有引導文字就用，無則按順序編號
  - 注意：方格可能是直排（由右往左、由上往下）

▸ 其他題型：
  - 按照全域規則的顏色辨識原則提取
  - 保留原始格式，不修正、不美化
`.trim(),
    數學: `
【數學領域】

領域通用規則：
- 數值+單位必須完整（如：5 公分，不是 5）
- 公式需包含核心部分
- 提取數字、符號（+、-、×、÷、=）
- 分數格式：「1/2」或「½」
- 小數格式：「3.14」

題型判斷與擷取規則：

▸ 如果是「繪圖題」（在座標平面畫點/線、畫幾何圖形、標註角度等）：
  - 判斷為 Type 3
  - 使用 rubricsDimensions 分維度：
    1. 圖形正確性：{"name": "圖形正確性", "criteria": "圖形/線條是否正確"}
    2. 位置精準度：{"name": "位置精準度", "criteria": "<精準座標>"}
       • 題目給定精準座標（如：點 A(3, 5)）→ criteria：「必須在座標 (3, 5) 附近（允許誤差 ±0.5）」
       • 題目只給範圍（如：第一象限）→ criteria：「必須在第一象限內」
    3. 標註完整性：{"name": "標註完整性", "criteria": "必要標註是否完整"}

▸ 其他題型：
  - 按照全域規則的顏色辨識原則提取
  - 保留原始格式，不修正、不美化
`.trim(),
    英語: `
【英語領域】

領域通用規則：
- 拼字/大小寫需精確
- 保留大小寫（如：Apple ≠ apple）
- 保留標點符號（如：Hello! ≠ Hello）
- 保留撇號（don't、it's）
- 保留連字號（twenty-one）
- 保留空格（I am ≠ Iam）

題型判斷與擷取規則：

▸ 所有題型：
  - 按照全域規則的顏色辨識原則提取字母、單詞、句子
  - 嚴格保留原始拼寫格式
`.trim(),
    社會: `
【社會領域】

領域通用規則：
- 專注同音異字（如：九州≠九洲）

題型判斷與擷取規則：

▸ 如果是「繪圖/標記題」（在地圖上標註位置、畫符號、標記座標等）：
  - 判斷為 Type 3
  - 使用 rubricsDimensions 分成兩個維度：
    1. 符號正確性：{"name": "符號正確性", "criteria": "符號是否正確"}
    2. 位置精準度：{"name": "位置精準度", "criteria": "<精準座標要求>"}

  🚨 位置精準度的 criteria 設定：
  - 優先抓取題目中的精準座標（如：東經 151.4°E、北緯 15°N）
  - 題目明確給定精準座標 → criteria：「必須標註在東經 151.4°E、北緯 15°N 附近（允許誤差 ±1°以內）」
    ❌ 錯誤：「經度 121°E 以東，23.5°N 以北」（範圍過於寬鬆）
    ✅ 正確：「必須標註在東經 151.4°E、北緯 15°N 附近（允許誤差 ±1°以內）」
  - 題目沒有精準座標，只給範圍描述 → criteria 才使用範圍

  ⚠️ 符號對 ≠ 答案對，必須同時檢查符號和位置

▸ 其他題型：
  - 按照全域規則的顏色辨識原則提取
  - 保留原始格式，不修正、不美化
`.trim(),
    自然: `
【自然領域】

領域通用規則：
- 名詞/數值/單位必須完整

題型判斷與擷取規則：

▸ 如果是「繪圖/標註題」（繪製實驗裝置圖、標註器官/部位、畫食物鏈/食物網等）：
  - 判斷為 Type 3
  - 使用 rubricsDimensions 分維度：
    • 圖形正確性
    • 標註正確性
    • 完整性

▸ 其他題型：
  - 按照全域規則的顏色辨識原則提取
  - 保留原始格式，不修正、不美化
`.trim()
  }

  // 其他領域使用通用規則
  const defaultDomain = `
【${domain}領域】

領域通用規則：
- 按照全域規則的顏色辨識原則提取
- 保留原始格式，不修正、不美化

題型判斷與擷取規則：

▸ 所有題型：
  - 提取彩色筆跡內容作為答案
  - 保留原始格式
`.trim()

  return domainMap[domain] || defaultDomain
}

/**
 * 建立 Prior Weight 提示
 */
function buildPriorWeightHint(
  priorWeightTypes?: import('./db').QuestionCategoryType[]
): string {
  if (!priorWeightTypes || priorWeightTypes.length === 0) {
    return ''
  }

  const typeLabels = priorWeightTypes
    .map((t, i) => {
      const priority = i === 0 ? '最優先' : i === 1 ? '次優先' : '最後'
      const typeName =
        t === 1 ? 'Type 1（唯一答案）' : t === 2 ? 'Type 2（多答案可接受）' : 'Type 3（依表現給分）'
      return `${priority}：${typeName}`
    })
    .join('、')

  return `

【Prior Weight - 教師指定題型偏好】
教師指定此作業的題型優先級：${typeLabels}

【遵循 Prior Weight】
- 在證據模糊時，優先選擇權重較高的 Type
- 例如：無法確定是 Type 1 還是 Type 2，且最優先為 Type 1 → 判斷為 Type 1

【偏離 Prior Weight】（Strong Evidence）
只有在「有強烈證據」時才可偏離 Prior Weight，需同時滿足：

1. **視覺特徵完全不符**
   - Prior Weight 偏好 Type 1，但圖片完全無手寫筆跡
   - Prior Weight 偏好 Type 2，但圖片有明顯手寫筆跡
   - Prior Weight 偏好 Type 3，但圖片有方框結構

2. **多重證據一致指向另一個 Type**（至少 3 項）
   - 有方框結構
   - 有空白處
   - 無手寫筆跡
   - 印刷品質高（非手寫）
   - 題目編號清晰（1、2、3...）

3. **極端情況**
   - 完全空白但 Prior Weight 偏好 Type 1（已填寫）
   - 內容豐富但 Prior Weight 偏好 Type 2（空白）

⚠️ 如果只有 1-2 項證據，優先遵循 Prior Weight
⚠️ 偏離時在 reasoning 中說明原因，並設定：
- "aiDivergedFromPrior": true
- "aiOriginalDetection": <你的判斷類型>
`.trim()
}

/**
 * 建立答案提取 Prompt（重構版 - 決策樹架構）
 */
function buildAnswerKeyPrompt(
  domain?: string,
  priorWeightTypes?: import('./db').QuestionCategoryType[]
): string {
  const globalRules = buildGlobalRules()
  const domainRules = buildDomainRulesWithDecisionTree(domain || '其他')
  const priorWeightHint = buildPriorWeightHint(priorWeightTypes)

  return [globalRules, domainRules, priorWeightHint].filter(Boolean).join('\n')
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
    result.totalScore = result.details.reduce((sum, d) => sum + (d.score ?? 0), 0)

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
  
  const totalScore = mergedDetails.reduce((sum, d) => sum + (d.score ?? 0), 0)
  
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

【分層評分規則】
- Type 1（精確）：使用 answer 字段嚴格對比。完全相符 → 滿分；不符 → 0分
- 連連看（Type 1）：若 answerFormat="matching" 或 answer 形如「左項=右項」：
  - studentAnswer 必須輸出相同格式：左項=右項1,右項2; 左項2=右項3
  - 左項目固定，不可交換左右
  - 同一左項目多個右項目用逗號/頓號分隔
  - 右側順序不影響判斷
- Type 2（模糊）：使用 acceptableAnswers 進行語義匹配。完全/語義相符 → 滿分；部分 → 部分分
  - 字音造詞題：若 referenceAnswer 含讀音說明（如「ㄋㄨㄥˋ讀音」），學生答案必須符合該讀音；讀音錯誤直接 0 分
- Type 3（評價）：使用 rubricsDimensions 多維度評分，逐維度累計總分；若無維度則用 rubric 4級標準
  - ⚠️ 多維度評分時，每個維度的評分標準不同：
    - 「引導/選擇」維度（如：步驟一選擇面向）：看「是否完成」而非「是否正確」，只要學生有做選擇就給分
    - 「主要作答」維度（如：步驟二具體內容）：依據 criteria 判斷內容品質並給分
  - 整題的 isCorrect 判斷：以「主要作答」維度為準，不因「引導階段」未完成而判為錯誤
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
      "detectedType": 1|2|3,
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
    const text = (await generateGeminiText(currentModelName, requestParts, { useAnswerKeyCache }))
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

  for (let i = 0; i < submissions.length; i++) {
    // 🛑 檢查是否應該停止
    if (shouldStop?.()) {
      console.log(`🛑 用戶請求停止批改，已完成 ${successCount} 份`)
      stopped = true
      break
    }

    const sub = submissions[i]
    console.log(`\n📄 批改第 ${i + 1}/${submissions.length} 份作業: ${sub.id}`)
    onProgress(i + 1, submissions.length)
    
    // 🆕 預取下一份作業（在當前作業批改期間並行準備）
    prefetchNextSubmission(i)

    try {
      if (!sub.imageBlob) {
        console.warn(`⚠️ 跳過沒有 imageBlob 的作業: ${sub.id}`)
        failCount++
        continue
      }

      console.log(`🔍 開始批改作業 ${sub.id}...`)
      
      // 🆕 檢查是否有預處理好的圖片
      let result: GradingResult
      const preparedPromise = preparedSubmissions.get(sub.id!)
      
      if (preparedPromise) {
        const prepared = await preparedPromise
        if (prepared) {
          // 使用預處理好的圖片（跳過壓縮步驟）
          console.log(`   ✨ 使用預處理圖片批改`)
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
      
      console.log(`📊 批改結果: 得分 ${result.totalScore}`)

      console.log(`💾 儲存批改結果到資料庫...`)
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
        `✅ 批改成功 (${i + 1}/${submissions.length}): ${sub.id}, 得分: ${result.totalScore}, 累計成功: ${successCount}`
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
      console.error(`❌ 批改作業失敗 (${i + 1}/${submissions.length}): ${sub.id}`, e)
      console.error(`   累計失敗: ${failCount}`)
    }

    if (i < submissions.length - 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 2000))
    }
  }

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

/**
 * 從答案卷圖片中抽取 AnswerKey（給 AssignmentSetup 使用）
 */
export async function extractAnswerKeyFromImage(
  answerSheetImage: Blob,
  opts?: ExtractAnswerKeyOptions
): Promise<AnswerKey> {
  if (!isGeminiAvailable) throw new Error('Gemini 服務未設定')

  console.log('🧾 開始從答案卷圖片抽取 AnswerKey...')
  const imageBase64 = await blobToBase64(answerSheetImage)
  const mimeType = answerSheetImage.type || 'image/jpeg'

  let priorWeightTypes = opts?.priorWeightTypes
  if (!priorWeightTypes && opts?.allowedQuestionTypes && opts.allowedQuestionTypes.length > 0) {
    const { migrateLegacyQuestionType } = await import('./db')
    priorWeightTypes = Array.from(new Set(opts.allowedQuestionTypes.map(migrateLegacyQuestionType))).sort() as import(
      './db'
    ).QuestionCategoryType[]
    console.log('📦 已自動遷移 allowedQuestionTypes 為 priorWeightTypes:', priorWeightTypes)
  }

  const prompt = buildAnswerKeyPrompt(opts?.domain, priorWeightTypes)

  const text = (await generateGeminiText(currentModelName, [
    prompt,
    { inlineData: { mimeType, data: imageBase64 } }
  ]))
    .replace(/```json|```/g, '')
    .trim()

  return JSON.parse(text) as AnswerKey
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

  console.log(`🧾 開始從 ${answerSheetImages.length} 張答案卷圖片抽取 AnswerKey...`)

  let priorWeightTypes = opts?.priorWeightTypes
  if (!priorWeightTypes && opts?.allowedQuestionTypes && opts.allowedQuestionTypes.length > 0) {
    const { migrateLegacyQuestionType } = await import('./db')
    priorWeightTypes = Array.from(new Set(opts.allowedQuestionTypes.map(migrateLegacyQuestionType))).sort() as import(
      './db'
    ).QuestionCategoryType[]
    console.log('📦 已自動遷移 allowedQuestionTypes 為 priorWeightTypes:', priorWeightTypes)
  }

  const prompt = buildAnswerKeyPrompt(opts?.domain, priorWeightTypes)

  // 多圖片提示增強
  const multiImagePrompt = `
${prompt}

【多張圖片處理】
- 你會收到 ${answerSheetImages.length} 張答案卷圖片
- 這些圖片可能是同一份作業的不同頁面
- 請從所有圖片中提取題目，並合併成一個完整的 AnswerKey
- 題號必須連續且不重複（如果多張圖片有重複題號，請保留最完整的版本）
- totalScore 是所有圖片中所有題目的 maxScore 總和
`.trim()

  // 準備多圖片請求
  const requestParts: GeminiRequestPart[] = [multiImagePrompt]

  // 添加所有圖片
  for (let i = 0; i < answerSheetImages.length; i++) {
    const imageBase64 = await blobToBase64(answerSheetImages[i])
    const mimeType = answerSheetImages[i].type || 'image/jpeg'
    requestParts.push({
      inlineData: { mimeType, data: imageBase64 }
    })
    console.log(`  📄 已添加第 ${i + 1} 張圖片`)
  }

  console.log('🤖 發送請求到 Gemini API...')
  const text = (await generateGeminiText(currentModelName, requestParts))
    .replace(/```json|```/g, '')
    .trim()

  const result = JSON.parse(text) as AnswerKey
  console.log(`✅ 成功提取 ${result.questions.length} 題，總分 ${result.totalScore}`)

  return result
}

/**
 * 重新分析被標記的題目
 * 只針對 needsReanalysis === true 的題目重新分析
 */
export async function reanalyzeQuestions(
  answerSheetImage: Blob,
  markedQuestions: import('./db').AnswerKeyQuestion[],
  domain?: string,
  priorWeightTypes?: import('./db').QuestionCategoryType[]
): Promise<import('./db').AnswerKeyQuestion[]> {
  if (!isGeminiAvailable) throw new Error('Gemini 服務未設定')

  if (markedQuestions.length === 0) {
    return []
  }

  console.log(`🔄 重新分析 ${markedQuestions.length} 題...`)

  const imageBase64 = await blobToBase64(answerSheetImage)
  const mimeType = answerSheetImage.type || 'image/jpeg'

  const questionIds = markedQuestions.map((q) => q.id).join(', ')
  const basePrompt = buildAnswerKeyPrompt(domain, priorWeightTypes)

  const reanalyzePrompt = `
${basePrompt}

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

  const text = (await generateGeminiText(currentModelName, [
    reanalyzePrompt,
    { inlineData: { mimeType, data: imageBase64 } }
  ]))
    .replace(/```json|```/g, '')
    .trim()

  const result = JSON.parse(text) as import('./db').AnswerKey

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
        type: 2 as import('./db').QuestionCategoryType,
        maxScore: originalQuestion.maxScore || 0,
        referenceAnswer: 'AI 無法從圖片中重新辨識此題，請手動編輯',
        acceptableAnswers: [],
        needsReanalysis: true
      }
    })

    result.questions.push(...placeholderQuestions)
    console.log(`🔧 已自動為遺漏的 ${missingIds.length} 題創建佔位項（需手動編輯）`)
  }

  console.log(`✅ 重新分析完成，共 ${result.questions.length} 題（要求 ${markedQuestions.length} 題）`)

  return result.questions
}
