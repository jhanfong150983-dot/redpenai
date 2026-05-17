
import { useState, useEffect, useCallback, useMemo, useRef, type MouseEvent as ReactMouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import Button from '@/components/ui/Button'
import { shouldAutoFocusOnDesktop } from '@/hooks/useAutoFocusOnDesktop'
import {
  ArrowLeft,
  Loader,
  Sparkles,
  XCircle,
  ImageIcon,
  FileQuestion,

  RefreshCw,
  X,
  AlertTriangle,
  Trash2,
  CheckCircle2,
  CheckSquare,
  ChevronRight,
  ChevronLeft,
  ZoomIn
} from 'lucide-react'
import { db, type Assignment, type Student, type Submission, type Classroom } from '@/lib/db'
import { requestSync, waitForSync } from '@/lib/sync-events'
import {
  gradePhaseA,
  gradePhaseB,
  gradePhaseBFromCache,
  isGeminiAvailable,
  type PhaseAResult,
  type PhaseAQuestionResult,
  type FinalAnswer,
  type PipelineFailure
} from '@/lib/gemini'
import { buildApiUrl } from '@/lib/api-base'
import { startInkSession, closeInkSession, getInkSessionId } from '@/lib/ink-session'
import { downloadImageFromSupabase } from '@/lib/supabase-download'
import { getSubmissionImageUrl, fixCorruptedBase64 } from '@/lib/utils'
import SubmissionThumbnail from '@/components/SubmissionThumbnail'
import { blobToBase64 } from '@/lib/imageCompression'
import { isIndexedDbBlobError, shouldAvoidIndexedDbBlob } from '@/lib/blob-storage'

// 🆕 AI 批改中的有趣話語（給老師看的）
const GRADING_MESSAGES = [
  '今天喝咖啡了嗎？交給我改就好 ☕',
  '你先去休息，我來改就好 😊',
  '你看我做什麼？趕快去休息 👀',
  '改作業的事，就交給專業的來 💪',
  '老師辛苦了，喝杯水休息一下 💧',
  '批改中… 你可以先滑個手機 📱',
  '放心，我會認真改的 ✨',
  '這點小事，包在我身上 🎯',
  '老師去倒杯茶，馬上就好 🍵',
  '正在努力辨識中，請稍候 🔍',
]

// 隨機選取批改訊息
function getRandomGradingMessage(): string {
  return GRADING_MESSAGES[Math.floor(Math.random() * GRADING_MESSAGES.length)]
}

/**
 * 限制並行數的批次執行器
 * @param items 待處理項目
 * @param concurrency 最大同時進行數
 * @param staggerMs 每個任務錯開啟動的延遲（ms）
 * @param fn 每個項目的處理函式，回傳 { ok, result?, error? }
 * @param onDone 每個項目完成時的 callback（可更新 UI 進度）
 */
async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  staggerMs: number,
  fn: (item: T, index: number) => Promise<R | null>,
  onDone: (index: number, result: R | null, error: unknown) => Promise<void> | void,
  abortSignal?: { readonly current: boolean }
): Promise<void> {
  const queue = items.map((item, i) => ({ item, i }))
  let running = 0
  let nextIndex = 0

  await new Promise<void>((resolve) => {
    function startNext() {
      // 立即中斷：abortSignal 為 true 時，不再啟動新任務，等剩餘完成後 resolve
      if (abortSignal?.current) {
        if (running === 0) resolve()
        return
      }
      if (nextIndex >= queue.length && running === 0) {
        resolve()
        return
      }
      while (running < concurrency && nextIndex < queue.length) {
        if (abortSignal?.current) break
        const { item, i } = queue[nextIndex++]
        // 只對初始批次（前 concurrency 個）錯開啟動，避免 API burst
        const delay = i < concurrency ? i * staggerMs : 0
        running++
        const launch = async () => {
          if (delay > 0) await new Promise((r) => setTimeout(r, delay))
          if (abortSignal?.current) {
            running--
            startNext()
            return
          }
          try {
            const result = await fn(item, i)
            await onDone(i, result, null)
          } catch (err) {
            await onDone(i, null, err)
          } finally {
            running--
            startNext()
          }
        }
        void launch()
      }
    }
    startNext()
  })
}

// 2026-05-17: Phase A / Phase B 分離設計——卡片狀態枚舉
// 對應到 user 截圖的 status badge：未繳交 / 未擷取 / 擷取失敗 / 待複核 / 待批改 / 批改失敗 / XX 分
export type CardStage =
  | 'not_submitted'    // 未繳交（無圖、無 submission）
  | 'not_extracted'    // 未擷取（首次、無 phase_a_state）
  | 'phase_a_failed'   // 擷取失敗（pipelineFailure 在 Phase A）
  | 'pending_review'   // 待複核（有題目 AI 沒讀好 / arbiter 標 needs_review）
  | 'pending_grading'  // 待批改（所有題目都有 final answer、未 Phase B）
  | 'phase_b_failed'   // 批改失敗（pipelineFailure 在 Phase B）
  | 'graded'           // XX 分（Phase B 完成）
  | 'manual_marked'    // 手動標記已批改（無圖 stub）

/**
 * 2026-05-17: 從 Submission 衍生卡片狀態
 * 用於：卡片 badge / 動態按鈕邏輯 / Modal 攜截檢查
 */
export function deriveCardStage(sub: Submission | undefined): CardStage {
  if (!sub) return 'not_submitted'
  if (isManualGradeStub(sub)) return 'manual_marked'

  // 'missing' / 'scanned' 沒實際圖
  if (sub.status === 'missing') return 'not_submitted'

  // pipelineFailure 分流：stage 在 Phase A 還是 Phase B
  const failure = (sub.gradingResult as { pipelineFailure?: { stage?: string } } | undefined)?.pipelineFailure
  if (sub.status === 'grading_failed' && failure?.stage) {
    const stage = failure.stage
    const isPhaseBStage = stage === 'accessor' || stage === 'explain' || stage === 'phase_b'
    return isPhaseBStage ? 'phase_b_failed' : 'phase_a_failed'
  }

  // XX 分：明確 graded + 有 score
  if (sub.status === 'graded' && sub.score != null) return 'graded'

  // 從 phase_a_state 判斷 待複核 vs 待批改
  const phaseAState = sub.phaseAState
  if (phaseAState?.arbiterDecisions && phaseAState.arbiterDecisions.length > 0) {
    const hasNeedsReview = phaseAState.arbiterDecisions.some(
      (d) => d.arbiterStatus === 'needs_review'
    )
    return hasNeedsReview ? 'pending_review' : 'pending_grading'
  }

  // 從舊 gradingResult.details 判斷（向下相容：舊資料沒 phase_a_state、但有 gradingResult）
  const details = (sub.gradingResult as { details?: Array<{ arbiterResult?: { arbiterStatus?: string } }> } | undefined)?.details
  if (Array.isArray(details) && details.length > 0) {
    const hasNeedsReview = details.some(
      (d) => d.arbiterResult?.arbiterStatus === 'needs_review'
    )
    return hasNeedsReview ? 'pending_review' : 'pending_grading'
  }

  // synced 但無批改 / 無 phase_a_state → 未擷取
  if (sub.status === 'synced' || sub.status === 'scanned') return 'not_extracted'

  return 'not_extracted'
}

/**
 * 中文 label（給 badge / Modal 列表用）
 */
export const CARD_STAGE_LABEL: Record<CardStage, string> = {
  not_submitted: '未繳交',
  not_extracted: '未擷取',
  phase_a_failed: '擷取失敗',
  pending_review: '待複核',
  pending_grading: '待批改',
  phase_b_failed: '批改失敗',
  graded: '已批改',
  manual_marked: '手動標記已批改'
}

// 偵測「教師手動批改」stub submission：source=teacher_camera、status=graded、無圖、無批改結果。
// 由 /api/data/manual-grade 建立，代表老師宣告已批改但沒有實際影像/評分。
function isManualGradeStub(submission?: Submission) {
  if (!submission) return false
  if (submission.status !== 'graded') return false
  if (submission.source !== 'teacher_camera') return false
  if (submission.gradingResult) return false
  const hasImage =
    Boolean(submission.imageBase64) ||
    (submission.imageBlob?.size ?? 0) > 0 ||
    Boolean(submission.imageUrl) ||
    Boolean(submission.thumbUrl) ||
    Boolean(submission.thumbnailBase64) ||
    (submission.thumbnailBlob?.size ?? 0) > 0 ||
    Boolean(submission.thumbnailUrl)
  return !hasImage
}

function getSubmissionSourceVisual(submission?: Submission) {
  const source = submission?.source
  if (source === 'student_upload' || source === 'student_correction') {
    return {
      label: source === 'student_correction' ? '學生訂正' : '學生上傳',
      seatBadgeClass: 'border-blue-200 bg-blue-50 text-blue-700',
      textClass: 'text-blue-700'
    }
  }

  if (
    source === 'teacher_camera' ||
    source === 'teacher_scan' ||
    source === 'teacher_student_upload'
  ) {
    return {
      label: '老師上傳',
      seatBadgeClass: 'border-emerald-200 bg-emerald-50 text-emerald-700',
      textClass: 'text-emerald-700'
    }
  }

  if (!source && submission?.status === 'scanned') {
    return {
      label: '老師上傳',
      seatBadgeClass: 'border-emerald-200 bg-emerald-50 text-emerald-700',
      textClass: 'text-emerald-700'
    }
  }

  return {
    label: '來源未知',
    seatBadgeClass: 'border-slate-200 bg-slate-100 text-slate-600',
    textClass: 'text-slate-600'
  }
}

const STAGE_LABEL_MAP: Record<string, string> = {
  ReadAnswer: '答案抄寫',
  ReadAnswerFinalOnly: '最終答案抄寫',
  ReadAnswerWork: '計算過程抄寫',
  ReadAnswerRecheck: '答案重讀',
  classify: '題目定位',
  Accessor: '自動評分',
  explain: '錯因解析'
}

const CORRECTION_BLOCKING_STATUSES = new Set(['correction_required', 'correction_in_progress'])

const CORRECTION_STATUS_LABEL_MAP: Record<string, string> = {
  correction_required: '待訂正',
  correction_in_progress: '訂正中'
}

function formatDisplayQuestionId(questionId?: string | null) {
  if (!questionId) return null
  return questionId.startsWith('#') ? questionId.slice(1) : questionId
}

/** 判斷該份批改結果是否需要老師複核（相容舊資料） */
function isSubmissionNeedsReview(gradingResult?: { needsReview?: boolean; manuallyReviewed?: boolean; details?: Array<{ studentAnswer?: string }>; reviewReasons?: string[] }): boolean {
  if (!gradingResult) return false
  // 老師手動點過「標記已複核」→ 直接視為不需複核
  if (gradingResult.manuallyReviewed) return false
  // 「未作答」全是學生明確沒寫，不需老師確認 → 過濾掉純「未作答」reasons
  const isBlankReason = (r: string) =>
    !!r && (r.includes('辨識為未作答') || r.includes('題未作答'))
  const reasons = gradingResult.reviewReasons || []
  const meaningfulReasons = reasons.filter((r) => !isBlankReason(r))
  if (gradingResult.needsReview) {
    // 若 server 標記 needsReview 但 reasons 全都是「未作答」相關 → 視為不需複核（老的 grading 紀錄）
    if (reasons.length > 0 && meaningfulReasons.length === 0) return false
    return true
  }
  const details = gradingResult.details ?? []
  return details.some((d) => d.studentAnswer === '無法辨識' || d.studentAnswer === 'AI無法辨識')
}

function toUserFriendlyReviewReason(rawReason: string) {
  const raw = (rawReason || '').trim()
  if (!raw) return ''

  const stageMatch = raw.match(/^\[([^\]]+)\]\s*(.+)$/)
  const stageKey = stageMatch?.[1]?.trim() || ''
  const body = (stageMatch?.[2] || raw).trim()
  const stageLabel = STAGE_LABEL_MAP[stageKey] || stageKey

  const calcMismatchMatch = body.match(
    /^CALC_ANSWER_MISMATCH\s+questionId=([^\s]+)\s+calc=([^\s]+)\s+stated=([^\s]+)/i
  )
  if (calcMismatchMatch) {
    const questionId = formatDisplayQuestionId(calcMismatchMatch[1]) || calcMismatchMatch[1]
    const calcValue = calcMismatchMatch[2]
    const statedValue = calcMismatchMatch[3]
    return `第${questionId}題：算式結果 ${calcValue} 與作答答案 ${statedValue} 不一致`
  }

  const finalMismatchDetectedMatch = body.match(/^FINAL_ANSWER_MISMATCH_DETECTED\s+count=(\d+)/i)
  if (finalMismatchDetectedMatch) {
    return `偵測到 ${finalMismatchDetectedMatch[1]} 題最終答案不一致，建議人工複核`
  }

  const finalMismatchUnresolvedMatch = body.match(/^FINAL_ANSWER_MISMATCH_UNRESOLVED\s+count=(\d+)/i)
  if (finalMismatchUnresolvedMatch) {
    return `有 ${finalMismatchUnresolvedMatch[1]} 題最終答案不一致且無法自動修正`
  }

  const alignmentCoverageMatch = raw.match(/Question alignment coverage\s+(\d+)%/i)
  if (alignmentCoverageMatch) {
    return `題目定位覆蓋率僅 ${alignmentCoverageMatch[1]}%，可能有題目未正確對齊`
  }

  const unreadableCountMatch = raw.match(/Unreadable answers:\s*(\d+)/i)
  if (unreadableCountMatch) {
    return `有 ${unreadableCountMatch[1]} 題答案無法辨識`
  }

  const requestFailedMatch = body.match(/^REQUEST_FAILED(?:\s+status=(\d+))?/i)
  if (requestFailedMatch) {
    const statusText = requestFailedMatch[1] ? `（狀態碼 ${requestFailedMatch[1]}）` : ''
    return `${stageLabel || '系統'}請求失敗${statusText}`
  }

  if (/^JSON_PARSE_FAILED$/i.test(body)) {
    return `${stageLabel || '系統'}回傳格式異常，需人工複核`
  }

  if (/^EXECUTION_ERROR$/i.test(body)) {
    return `${stageLabel || '系統'}執行失敗，需人工複核`
  }

  if (stageLabel && stageMatch) {
    return `${stageLabel}：${body}`
  }

  return raw
}

function getBatchFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message.trim()
  }
  if (typeof error === 'string') {
    return error.trim()
  }
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>
    if (typeof record.message === 'string') {
      return record.message.trim()
    }
    if (typeof record.error === 'string') {
      return record.error.trim()
    }
  }
  return ''
}

function toUserFriendlyBatchFailureReason(rawMessage: string): string {
  const message = rawMessage.trim()
  if (!message || message === '[object Object]') return '這次不太順，再試一次看看 🔄'

  const phaseBStatusMatch = message.match(/Phase [AB] failed:\s*(\d{3})/i)
  if (phaseBStatusMatch) {
    const code = Number(phaseBStatusMatch[1])
    if (code === 504 || code === 408) return 'AI 想太久卡住了，請再試一次 🕐'
    if (code === 429) return 'AI 有點忙不過來，稍等一下再試試 😅'
    if (code === 500 || code === 502 || code === 503) return 'AI 這邊暫時有點小狀況，等一下再試試 🛠️'
    if (code === 400) return '批改資料好像有點問題，請重新批改一次'
    if (code === 401 || code === 403) return '登入狀態過期了，重新整理頁面後再試試 🔑'
    return `AI 批改沒有成功（錯誤碼 ${code}），請重試`
  }

  if (/timeout/i.test(message)) return 'AI 想太久卡住了，請再試一次 🕐'
  if (/Failed to fetch|network|ERR_NETWORK/i.test(message)) return '好像找不到網路，確認一下再試試？ 📡'
  if (/rate.?limit|quota|resource.?exhaust/i.test(message)) return 'AI 有點忙不過來，稍等一下再試試 😅'
  if (/empty response/i.test(message)) return 'AI 這次沒有回答，請再試一次'
  if (/ink.*insufficient|balance|餘額不足/i.test(message)) return '點數用完了，加值後就可以繼續批改喔 💳'
  if (/JSON|parse|Unexpected token/i.test(message)) return 'AI 的回答有點混亂，請再試一次'
  if (/\[object Object\]/i.test(message)) return '這次不太順，再試一次看看 🔄'

  if (message.length > 100) {
    return `${message.slice(0, 100)}...`
  }

  return message
}

interface GradingPageProps {
  assignmentId: string
  batchAssignmentIds?: string[]
  onBack?: () => void
  onRequireInkTopUp?: () => void
  onGradingPhaseChange?: (phase: GradingPhase) => void
  embedded?: boolean
}

type CorrectionDashboardStudentLite = {
  studentId?: string
  name?: string
  seatNumber?: number | null
  status?: string
}

type CorrectionDashboardLite = {
  dispatchActive?: boolean
  students?: CorrectionDashboardStudentLite[]
}

type CorrectionBlockedStudent = {
  studentId: string
  seatNumber: number | null
  name: string
  status: string
}

type CorrectionGuardModalState = {
  title: string
  description: string
  blockedStudents?: CorrectionBlockedStudent[]
}

type GradeResultNotice = {
  stopped: boolean
  successCount: number
  failCount: number
  totalCount: number
  failReasons: string[]
  failedEntries: BatchPhaseAEntry[]
}

/**
 * 從 Base64 重建 Blob（自動修復損壞的 Base64）
 */
function rebuildBlobFromBase64(base64: string): Blob {
  try {
    console.log('🔍 rebuildBlobFromBase64 輸入前100字:', base64.substring(0, 100))

    // 先修復損壞的 Base64
    const fixedBase64 = fixCorruptedBase64(base64)
    console.log('🔧 修復後前100字:', fixedBase64.substring(0, 100))

    // 提取純 Base64 數據（去掉 data URL 前綴）
    const parts = fixedBase64.split(',')
    if (parts.length < 2) {
      throw new Error(`Base64 格式錯誤：缺少逗號分隔符。格式: ${fixedBase64.substring(0, 100)}`)
    }
    const base64Data = parts[1]
    console.log('📝 純 Base64 前50字:', base64Data?.substring(0, 50))

    if (!base64Data || base64Data.length === 0) {
      throw new Error('Base64 數據為空')
    }

    const mimeMatch = fixedBase64.match(/data:([^;]+);/)
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg'
    console.log('🎨 MIME 類型:', mimeType)

    // 轉換為 Blob
    console.log('🔄 開始 atob 解碼…')
    const byteString = atob(base64Data)
    console.log(`✅ atob 解碼成功，長度: ${byteString.length}`)

    const arrayBuffer = new ArrayBuffer(byteString.length)
    const uint8Array = new Uint8Array(arrayBuffer)
    for (let i = 0; i < byteString.length; i++) {
      uint8Array[i] = byteString.charCodeAt(i)
    }

    const blob = new Blob([arrayBuffer], { type: mimeType })
    console.log('✅ Blob 創建成功:', { size: blob.size, type: blob.type })

    // 驗證 Blob
    if (blob.size === 0) {
      throw new Error('創建的 Blob 大小為 0')
    }

    return blob
  } catch (error) {
    console.error('❌ rebuildBlobFromBase64 失敗:', error)
    console.error('輸入 Base64 前200字:', base64.substring(0, 200))
    throw new Error(`Blob 重建失敗: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// ─── Phase A/B 一致性審查類型 ─────────────────────────────────────────────────

type GradingPhase = 'idle' | 'phase_a_running' | 'awaiting_review' | 'phase_b_running' | 'report_running'

interface ConsistencyDecision {
  questionId: string
  source: 'ai_read1' | 'ai_read2' | 'ai_arbiter' | 'manual' | 'unrecognizable' | 'blank'
  finalAnswer: string
  confirmed: boolean
}

interface BatchPhaseAEntry {
  submissionId: string
  studentId: string
  phaseAResult: PhaseAResult
  decisions: Map<string, ConsistencyDecision>
  imageBlob: Blob
}

// ─── Peer baseline outlier detection (post-batch revisit) ──────────────────
// 用 batch 內其他已成功的 sub 算 per-qid bbox median 當基準、
// 檢查當前 sub 是否有大量 bbox 跟基準明顯不同（partial 或全 shift）。
// 設計理由：classify 階段不用 ref bbox（紙張對齊風險）、改用 cross-sub peer
// 作為 outlier 偵測訊號。只在 answer_only 模式啟用。

function _median(arr: number[]): number {
  if (arr.length === 0) return 0
  const s = [...arr].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

type Bbox = { x: number; y: number; w: number; h: number }

function computePeerBaseline(entries: BatchPhaseAEntry[], excludeSubId: string): Map<string, Bbox> {
  const bboxesByQid = new Map<string, Bbox[]>()
  for (const entry of entries) {
    if (entry.submissionId === excludeSubId) continue
    for (const qr of entry.phaseAResult.questionResults) {
      const bb = qr.answerBbox as Bbox | undefined
      if (!bb || typeof bb.x !== 'number') continue
      if (!bboxesByQid.has(qr.questionId)) bboxesByQid.set(qr.questionId, [])
      bboxesByQid.get(qr.questionId)!.push(bb)
    }
  }
  const baseline = new Map<string, Bbox>()
  for (const [qid, list] of bboxesByQid) {
    baseline.set(qid, {
      x: _median(list.map((b) => b.x)),
      y: _median(list.map((b) => b.y)),
      w: _median(list.map((b) => b.w)),
      h: _median(list.map((b) => b.h)),
    })
  }
  return baseline
}

function checkPeerOutliers(
  entry: BatchPhaseAEntry,
  peerBaseline: Map<string, Bbox>,
  threshold = 0.025,
  minOutlierCount = 10
): { trip: boolean; outlierCount: number; outlierQids: string[]; metrics: { dy_med: number; dx_med: number } } {
  // 只看 dy：AI classify 在 dx 方向變異很大（注釋類 handwriting-sizing），dx outlier 雜訊太多。
  // dy 變異較小、shifted case 通常 dy 一致偏移 — 用 dy 訊號乾淨很多。
  // minOutlierCount=10：代表至少整個 section（10 題）一致偏、不會被零星 AI 變異誤判。
  const outlierQids: string[] = []
  const dys: number[] = []
  const dxs: number[] = []
  for (const qr of entry.phaseAResult.questionResults) {
    const bb = qr.answerBbox as Bbox | undefined
    const peer = peerBaseline.get(qr.questionId)
    if (!bb || !peer) continue
    const dy = bb.y - peer.y
    const dx = bb.x - peer.x
    dys.push(dy)
    dxs.push(dx)
    if (Math.abs(dy) > threshold) {
      outlierQids.push(qr.questionId)
    }
  }
  return {
    trip: outlierQids.length >= minOutlierCount,
    outlierCount: outlierQids.length,
    outlierQids,
    metrics: { dy_med: +_median(dys).toFixed(4), dx_med: +_median(dxs).toFixed(4) },
  }
}

// SubmissionThumbnail extracted to @/components/SubmissionThumbnail.tsx

// ─── ForensicSupportBadge ─────────────────────────────────────────────────────

function ForensicSupportBadge({ support }: { support?: string }) {
  if (!support) return null
  const styles: Record<string, string> = {
    strong: 'bg-green-100 text-green-700 border border-green-300',
    weak: 'bg-orange-100 text-orange-700 border border-orange-300',
    unsupported: 'bg-red-100 text-red-700 border border-red-300',
  }
  const labels: Record<string, string> = {
    strong: '強',
    weak: '弱',
    unsupported: '無依據',
  }
  return (
    <span className={`inline-block px-1 rounded text-[10px] font-semibold ${styles[support] ?? ''}`}>
      {labels[support] ?? support}
    </span>
  )
}

// ─── GradingPipelineOverlay ───────────────────────────────────────────────────
// Full-screen lock mask + floating modal card shown during Phase A / Phase B

type PipelineStageStatus = 'pending' | 'active' | 'done'

interface PipelineStageProps {
  index: number
  label: string
  sublabel: string
  status: PipelineStageStatus
}

function PipelineStage({ index, label, sublabel, status }: PipelineStageProps) {
  const colors = {
    pending: { circle: '#e5e7eb', text: '#9ca3af', sub: '#d1d5db' },
    active: { circle: '#7c3aed', text: '#374151', sub: '#6b7280' },
    done: { circle: '#16a34a', text: '#374151', sub: '#6b7280' },
  }
  const c = colors[status]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.4rem', minWidth: '90px' }}>
      <div style={{
        width: '2.5rem', height: '2.5rem', borderRadius: '50%',
        background: c.circle,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        position: 'relative',
        boxShadow: status === 'active' ? '0 0 0 4px #ede9fe' : undefined,
      }}>
        {status === 'done' ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : status === 'active' ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 1.2s linear infinite' }}>
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
        ) : (
          <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#9ca3af' }}>{index}</span>
        )}
      </div>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '0.8rem', fontWeight: 700, color: c.text, whiteSpace: 'nowrap' }}>{label}</div>
        <div style={{ fontSize: '0.7rem', color: c.sub, marginTop: '0.1rem', whiteSpace: 'nowrap' }}>{sublabel}</div>
      </div>
    </div>
  )
}


interface GradingPipelineOverlayProps {
  phase: 'phase_a_running' | 'phase_b_running'
  phaseAProgress: { current: number; total: number }
  phaseBProgress: { current: number; total: number }
  phaseANeedsReviewCount: number
  phaseATotalQuestionCount: number
  gradingMessage: string
  stopRequested: boolean
  onStop: () => void
}

function GradingPipelineOverlay({
  phase,
  phaseAProgress,
  phaseBProgress,
  phaseANeedsReviewCount,
  phaseATotalQuestionCount,
  gradingMessage,
  stopRequested,
  onStop,
}: GradingPipelineOverlayProps) {
  const isPhaseA = phase === 'phase_a_running'
  const isAfterPhaseA = !isPhaseA

  const stageA: PipelineStageStatus = isPhaseA ? 'active' : 'done'
  const stageReview: PipelineStageStatus = isAfterPhaseA ? 'done' : 'pending'
  const stageB: PipelineStageStatus = isAfterPhaseA ? 'active' : 'pending'

  const aPercent = phaseAProgress.total > 0
    ? Math.round((phaseAProgress.current / phaseAProgress.total) * 100)
    : 0
  const aLabel = isPhaseA ? `${aPercent}%` : '100%'
  const bLabel = phaseBProgress.total > 0
    ? `${phaseBProgress.current}/${phaseBProgress.total}`
    : '批改中…'

  const reviewLabel = phaseANeedsReviewCount > 0
    ? `需審查 ${phaseANeedsReviewCount}/${phaseATotalQuestionCount} 題`
    : isPhaseA ? '統計中…' : '已確認'

  return (
    <>
      {/* Lock mask */}
      <div style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
        zIndex: 9998, backdropFilter: 'blur(2px)',
      }} />
      {/* Floating card */}
      <div style={{
        position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
        zIndex: 9999, background: '#fff', borderRadius: '1.25rem',
        boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
        padding: '2rem 2.5rem', minWidth: '520px', maxWidth: '90vw',
        display: 'flex', flexDirection: 'column', gap: '1.5rem', alignItems: 'center',
      }}>
        {/* Title */}
        <div style={{ textAlign: 'center' }} role="status" aria-live="polite">
          <div style={{ fontSize: '1rem', fontWeight: 700, color: '#111827' }}>AI 批改進行中</div>
          <div style={{ fontSize: '0.8rem', color: '#6b7280', marginTop: '0.25rem' }}>{gradingMessage}</div>
        </div>

        {/* Pipeline stages */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'center', width: '100%', padding: '0 0.25rem', gap: '0.75rem' }}>
          <PipelineStage index={1} label="擷取學生答案" sublabel={aLabel} status={stageA} />
          <PipelineStage index={2} label="教師人工審查" sublabel={reviewLabel} status={stageReview} />
          <PipelineStage index={3} label="AI批改評分" sublabel={bLabel} status={stageB} />
        </div>

        {/* 人工審查提醒（Phase A 執行中且已有需審查題目）
            用「AI 自動處理率」正向敘事、級別依比例而非絕對數、避免大班大量題目時嚇到老師 */}
        {isPhaseA && phaseANeedsReviewCount > 0 && phaseATotalQuestionCount > 0 && (() => {
          const reviewCount = phaseANeedsReviewCount
          const total = phaseATotalQuestionCount
          const autoCount = Math.max(0, total - reviewCount)
          const reviewRatio = reviewCount / total
          const autoPercent = (autoCount / total * 100).toFixed(1)

          let level: 'excellent' | 'normal' | 'attention' | 'concerning' | 'critical'
          if (reviewRatio < 0.05) level = 'excellent'
          else if (reviewRatio < 0.15) level = 'normal'
          else if (reviewRatio < 0.30) level = 'attention'
          else if (reviewRatio < 0.60) level = 'concerning'
          else level = 'critical'

          const palette = {
            excellent:  { bg: '#f0fdf4', border: '#86efac', title: '#166534', sub: '#16a34a', icon: '🎯' },
            normal:     { bg: '#eff6ff', border: '#93c5fd', title: '#1e40af', sub: '#2563eb', icon: '✅' },
            attention:  { bg: '#fffbeb', border: '#fcd34d', title: '#92400e', sub: '#b45309', icon: '👀' },
            concerning: { bg: '#fff7ed', border: '#fb923c', title: '#c2410c', sub: '#ea580c', icon: '⚠️' },
            critical:   { bg: '#fef2f2', border: '#f87171', title: '#991b1b', sub: '#dc2626', icon: '🛑' },
          }[level]

          const tip = {
            excellent:  '完成後請來確認少數題目、即可開始批改',
            normal:     '完成後請來確認、再開始批改',
            attention:  '字跡稍多較難辨識、完成後請確認',
            concerning: '字跡偏難辨識、或可提醒學生書寫工整',
            critical:   '需審查比例過高、建議檢查掃描品質或答題卡狀態',
          }[level]

          return (
            <div style={{
              background: palette.bg, border: `1px solid ${palette.border}`, borderRadius: '0.75rem',
              padding: '0.6rem 1rem', textAlign: 'center', width: '100%',
            }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 600, color: palette.title }}>
                {palette.icon} AI 已自動處理 {autoCount.toLocaleString()} 題（{autoPercent}%）
              </div>
              <div style={{ fontSize: '0.78rem', color: palette.sub, marginTop: '0.25rem' }}>
                剩 {reviewCount.toLocaleString()} 題需老師確認 · {tip}
              </div>
            </div>
          )
        })()}

        {/* Stop button */}
        <button
          onClick={onStop}
          disabled={stopRequested}
          style={{
            padding: '0.5rem 1.75rem', borderRadius: '0.75rem', border: 'none',
            cursor: stopRequested ? 'not-allowed' : 'pointer',
            background: stopRequested ? '#e5e7eb' : '#fee2e2',
            color: stopRequested ? '#9ca3af' : '#dc2626',
            fontWeight: 600, fontSize: '0.875rem',
            transition: 'background 0.2s',
          }}
        >
          {stopRequested ? '正在停止…' : '停止批改'}
        </button>
        {stopRequested && (
          <p style={{ fontSize: '0.75rem', color: '#dc2626', marginTop: '-1rem' }}>將在完成當前作業後停止</p>
        )}
      </div>
      {/* CSS keyframe for spin */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </>
  )
}

// ─── ConsistencyQuestionCard ──────────────────────────────────────────────────

function ConsistencyQuestionCard({
  studentId: _studentId,
  questionResult,
  decision,
  onDecision,
  disabled,
}: {
  studentId: string
  questionResult: PhaseAQuestionResult
  decision?: ConsistencyDecision
  onDecision: (questionId: string, update: Partial<ConsistencyDecision>) => void
  disabled: boolean
}) {
  const [manualInput, setManualInput] = useState('')
  const [zoomedImg, setZoomedImg] = useState(false)
  const [zoomScale, setZoomScale] = useState(1)
  const [zoomOffset, setZoomOffset] = useState({ x: 0, y: 0 })
  const zoomDragRef = useRef<{ active: boolean; startX: number; startY: number; originX: number; originY: number }>({
    active: false, startX: 0, startY: 0, originX: 0, originY: 0
  })
  const { questionId, consistencyStatus, consistencyReason, readAnswer1, readAnswer2, answerCropImageUrl, arbiterResult } = questionResult
  const isUnstable = consistencyStatus === 'unstable'
  const isConfirmed = decision?.confirmed

  const borderClass = isConfirmed
    ? 'border-green-200 bg-green-50'
    : isUnstable
    ? 'border-red-200 bg-red-50'
    : 'border-orange-200 bg-orange-50'

  const badgeClass = isConfirmed
    ? 'bg-green-100 text-green-700'
    : isUnstable
    ? 'bg-red-100 text-red-700'
    : 'bg-orange-100 text-orange-700'

  const badgeLabel = isConfirmed ? '已確認' : isUnstable ? '無法判讀' : '讀取不一致'

  // 從計算題/應用題完整文字中提取最終答案（純顯示用，與 server 端 extractFinalAnswerFromCalc 邏輯一致）
  const extractFinalAnswer = (raw: string): string | null => {
    const s = raw.trim()
    if (!s) return null
    // 1. 答：xxx / 答:xxx / A:xxx
    const prefixMatch = s.match(/(?:答[：:：]|[Aa](?:ns)?[：:\s])\s*[（(]?\s*(.+?)\s*[）)]?[\s。，,]*$/u)
    if (prefixMatch?.[1]?.trim()) return prefixMatch[1].trim()
    // 2. =(xxx) bracket
    const firstSeg = s.split(/[,，\n]/)[0]
    const bracketMatch = firstSeg.match(/=\s*[（(]\s*([^）)，,\n]+?)\s*[）)]/u)
    if (bracketMatch?.[1]?.trim()) return bracketMatch[1].trim()
    // 3. last =
    const lastEq = s.lastIndexOf('=')
    if (lastEq >= 0) {
      const val = s.slice(lastEq + 1).trim().replace(/[。.，,]+$/, '')
      if (val) return val
    }
    return null
  }

  const isCalcType = questionResult.questionType === 'calculation' || questionResult.questionType === 'word_problem'

  // 計算題：最終答案不同 → 只顯示最終答案；最終答案相同 → 顯示完整步驟
  const calcFinal1 = isCalcType ? extractFinalAnswer(readAnswer1.studentAnswer) : null
  const calcFinal2 = isCalcType ? extractFinalAnswer(readAnswer2.studentAnswer) : null
  const calcFinalsSame = isCalcType && calcFinal1 && calcFinal2 && calcFinal1 === calcFinal2

  const getAnswerText = (r: { status: string; studentAnswer: string }): string | null => {
    if (r.status !== 'read') return null
    if (isCalcType && !calcFinalsSame) {
      // 最終答案不同 → 只顯示最終答案，讓老師快速選
      const final = extractFinalAnswer(r.studentAnswer)
      if (final) return final
    }
    // 最終答案相同或非計算題 → 顯示完整內容
    return r.studentAnswer || '空白'
  }

  const formatAnswer = (r: { status: string; studentAnswer: string }) => {
    const text = getAnswerText(r)
    if (text !== null) return `「${text}」`
    if (r.status === 'blank') return '（空白）'
    if (r.status === 'unreadable') return '（無法截取）'
    return `（${r.status}）`
  }

  // Diff highlighting: compare two strings character by character and return JSX with colored spans
  const renderDiffHighlight = (text: string, otherText: string | null): React.ReactNode => {
    if (!otherText || text === otherText) return `「${text}」`
    // Simple char-level diff: walk both strings, highlight mismatches
    const parts: React.ReactNode[] = ['「']
    let i = 0
    while (i < text.length) {
      // Find next diff region
      if (i < otherText.length && text[i] === otherText[i]) {
        // Same char — collect consecutive same chars
        let end = i
        while (end < text.length && end < otherText.length && text[end] === otherText[end]) end++
        parts.push(<span key={`s${i}`}>{text.slice(i, end)}</span>)
        i = end
      } else {
        // Different — collect consecutive different chars
        let end = i
        while (end < text.length && (end >= otherText.length || text[end] !== otherText[end])) end++
        parts.push(
          <span key={`d${i}`} className="bg-yellow-200 text-red-700 font-bold rounded px-0.5">{text.slice(i, end)}</span>
        )
        i = end
      }
    }
    parts.push('」')
    // If other text is longer, show trailing extra
    if (otherText.length > text.length) {
      parts.push(<span key="extra" className="text-gray-500 text-[9px] ml-1">（對方多 {otherText.length - text.length} 字）</span>)
    }
    return <>{parts}</>
  }

  // 切換到人工輸入時，以讀取1為預填基底（方便修改）
  // 計算題/應用題只預填最終答案，避免老師看到一大串算式
  const switchToManual = () => {
    let prefill = manualInput || ''
    if (!prefill && readAnswer1.studentAnswer) {
      prefill = isCalcType
        ? (extractFinalAnswer(readAnswer1.studentAnswer) ?? readAnswer1.studentAnswer)
        : readAnswer1.studentAnswer
    }
    setManualInput(prefill)
    onDecision(questionId, {
      source: 'manual',
      finalAnswer: prefill,
      confirmed: prefill.trim().length > 0,
    })
  }

  return (
    <div className={`rounded-lg border p-3 space-y-2 text-xs ${borderClass}`}>
      <div className="flex items-center justify-between">
        <span className="font-semibold text-gray-800">題目 {questionId}</span>
        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${badgeClass}`}>
          {badgeLabel}
        </span>
      </div>

      {consistencyReason && (
        <div className="flex items-start gap-1.5 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
          <span className="shrink-0">💡</span>
          <span>不一致原因：{consistencyReason}</span>
        </div>
      )}

      {/* AI3 鑑識結果（幫助老師判斷，非可選） */}
      {arbiterResult && (arbiterResult.forensicMode === 'agree_review' ? arbiterResult.agreementSupport : arbiterResult.ai1Support || arbiterResult.ai2Support) && (
        <div className="flex items-start gap-1.5 text-[11px] text-blue-700 bg-blue-50 border border-blue-200 rounded px-2 py-1">
          <span className="shrink-0">🔍</span>
          {arbiterResult.forensicMode === 'agree_review' ? (
            <span>
              <span className="font-semibold">鑑識結果：</span>共識支持程度{' '}
              <ForensicSupportBadge support={arbiterResult.agreementSupport} />
            </span>
          ) : (
            <span>
              <span className="font-semibold">鑑識結果：</span>
              AI細節派 <ForensicSupportBadge support={arbiterResult.ai1Support} />
              {'　'}AI全局派 <ForensicSupportBadge support={arbiterResult.ai2Support} />
            </span>
          )}
        </div>
      )}

      {answerCropImageUrl && (
        <div className="relative group/crop">
          <img
            src={answerCropImageUrl}
            alt={`題目 ${questionId} 答案區`}
            className="w-full rounded border border-gray-200 max-h-24 object-contain bg-white cursor-zoom-in"
            onClick={() => setZoomedImg(true)}
          />
          <button
            type="button"
            onClick={() => setZoomedImg(true)}
            className="absolute top-1 right-1 bg-white/90 rounded-full p-0.5 shadow opacity-0 group-hover/crop:opacity-100 transition-opacity"
            title="放大檢視"
          >
            <ZoomIn className="w-3 h-3 text-gray-600" />
          </button>
        </div>
      )}
      {zoomedImg && answerCropImageUrl && (
        <div
          className="fixed inset-0 z-[300] bg-black/80 flex flex-col items-center justify-center"
          onClick={() => { setZoomedImg(false); setZoomScale(1); setZoomOffset({ x: 0, y: 0 }) }}
        >
          {/* 縮放控制列 */}
          <div
            className="relative z-10 flex items-center gap-2 mb-3 bg-black/60 rounded-full px-3 py-1.5"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setZoomScale(s => Math.max(0.5, +(s - 0.5).toFixed(1)))}
              className="w-7 h-7 rounded-full bg-white/20 hover:bg-white/40 text-white flex items-center justify-center text-base font-bold leading-none"
              title="縮小"
            >−</button>
            <span className="text-white text-xs w-10 text-center tabular-nums">{Math.round(zoomScale * 100)}%</span>
            <button
              type="button"
              onClick={() => setZoomScale(s => Math.min(8, +(s + 0.5).toFixed(1)))}
              className="w-7 h-7 rounded-full bg-white/20 hover:bg-white/40 text-white flex items-center justify-center text-base font-bold leading-none"
              title="放大"
            >+</button>
            <div className="w-px h-4 bg-white/30 mx-1" />
            <button
              type="button"
              onClick={() => { setZoomScale(1); setZoomOffset({ x: 0, y: 0 }) }}
              className="text-white/70 hover:text-white text-[10px] px-2"
              title="重設"
            >重設</button>
            <button
              type="button"
              onClick={() => { setZoomedImg(false); setZoomScale(1); setZoomOffset({ x: 0, y: 0 }) }}
              className="ml-1 w-6 h-6 rounded-full bg-white/20 hover:bg-white/40 text-white flex items-center justify-center"
              title="關閉"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* 圖片容器（可拖曳） */}
          <div
            className="overflow-hidden"
            style={{ width: '90vw', height: '75vh', cursor: zoomScale > 1 ? 'grab' : 'default' }}
            onClick={(e) => e.stopPropagation()}
            onWheel={(e) => {
              e.preventDefault()
              const delta = e.deltaY < 0 ? 0.25 : -0.25
              setZoomScale(s => Math.min(8, Math.max(0.5, +(s + delta).toFixed(2))))
            }}
            onMouseDown={(e) => {
              if (zoomScale <= 1) return
              zoomDragRef.current = { active: true, startX: e.clientX, startY: e.clientY, originX: zoomOffset.x, originY: zoomOffset.y }
            }}
            onMouseMove={(e) => {
              if (!zoomDragRef.current.active) return
              setZoomOffset({
                x: zoomDragRef.current.originX + (e.clientX - zoomDragRef.current.startX),
                y: zoomDragRef.current.originY + (e.clientY - zoomDragRef.current.startY),
              })
            }}
            onMouseUp={() => { zoomDragRef.current.active = false }}
            onMouseLeave={() => { zoomDragRef.current.active = false }}
          >
            <img
              src={answerCropImageUrl}
              alt={`題目 ${questionId} 答案區（放大）`}
              draggable={false}
              onDoubleClick={() => { setZoomScale(1); setZoomOffset({ x: 0, y: 0 }) }}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'contain',
                transformOrigin: 'center center',
                transform: `scale(${zoomScale}) translate(${zoomOffset.x / zoomScale}px, ${zoomOffset.y / zoomScale}px)`,
                transition: zoomDragRef.current.active ? 'none' : 'transform 0.15s ease',
                userSelect: 'none',
              }}
            />
          </div>
          <p className="text-white/50 text-[10px] mt-2">滾輪縮放・拖曳平移・雙擊重設・點擊背景關閉</p>
        </div>
      )}

      <div className={`grid grid-cols-2 gap-2 ${disabled ? 'opacity-60' : ''}`}>
        {/* 讀取 1 */}
        <button
          type="button"
          disabled={disabled}
          onClick={() => onDecision(questionId, { source: 'ai_read1', finalAnswer: readAnswer1.studentAnswer, confirmed: true })}
          className={`flex flex-col gap-0.5 rounded-lg border-2 px-3 py-2.5 text-left text-xs transition-colors disabled:cursor-not-allowed ${
            decision?.source === 'ai_read1'
              ? 'border-purple-500 bg-purple-50 shadow-sm'
              : 'border-gray-200 bg-white hover:border-purple-300 hover:bg-purple-50/40'
          }`}
        >
          <span className={`font-semibold text-[11px] ${decision?.source === 'ai_read1' ? 'text-purple-700' : 'text-gray-500'}`}>{isCalcType ? (calcFinalsSame ? 'AI1 完整算式' : 'AI1 最終答案') : 'AI1 客觀抄寫'}</span>
          <span className={`font-medium break-all leading-snug ${decision?.source === 'ai_read1' ? 'text-purple-900' : 'text-gray-800'}`}>
            {(() => {
              const t1 = getAnswerText(readAnswer1)
              const t2 = getAnswerText(readAnswer2)
              return t1 !== null && t2 !== null && t1 !== t2 ? renderDiffHighlight(t1, t2) : formatAnswer(readAnswer1)
            })()}
          </span>
        </button>

        {/* AI2 全局讀取 */}
        <button
          type="button"
          disabled={disabled}
          onClick={() => onDecision(questionId, { source: 'ai_read2', finalAnswer: readAnswer2.studentAnswer, confirmed: true })}
          className={`flex flex-col gap-0.5 rounded-lg border-2 px-3 py-2.5 text-left text-xs transition-colors disabled:cursor-not-allowed ${
            decision?.source === 'ai_read2'
              ? 'border-purple-500 bg-purple-50 shadow-sm'
              : 'border-gray-200 bg-white hover:border-purple-300 hover:bg-purple-50/40'
          }`}
        >
          <span className={`font-semibold text-[11px] ${decision?.source === 'ai_read2' ? 'text-purple-700' : 'text-gray-500'}`}>{isCalcType ? (calcFinalsSame ? 'AI2 完整算式' : 'AI2 最終答案') : 'AI2 校對審查'}</span>
          <span className={`font-medium break-all leading-snug ${decision?.source === 'ai_read2' ? 'text-purple-900' : 'text-gray-800'}`}>
            {(() => {
              const t1 = getAnswerText(readAnswer1)
              const t2 = getAnswerText(readAnswer2)
              return t1 !== null && t2 !== null && t1 !== t2 ? renderDiffHighlight(t2, t1) : formatAnswer(readAnswer2)
            })()}
          </span>
        </button>

        {/* 空白 */}
        <button
          type="button"
          disabled={disabled}
          onClick={() => onDecision(questionId, { source: 'blank', finalAnswer: '', confirmed: true })}
          className={`flex items-center justify-center rounded-lg border-2 px-3 py-2.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed ${
            decision?.source === 'blank'
              ? 'border-gray-400 bg-gray-100 text-gray-700 shadow-sm'
              : 'border-gray-200 bg-white text-gray-500 hover:border-gray-400 hover:bg-gray-50'
          }`}
        >
          空白（未作答）
        </button>

        {/* 無法辨識 */}
        <button
          type="button"
          disabled={disabled}
          onClick={() => onDecision(questionId, { source: 'unrecognizable', finalAnswer: '無法辨識', confirmed: true })}
          className={`flex items-center justify-center rounded-lg border-2 px-3 py-2.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed ${
            decision?.source === 'unrecognizable'
              ? 'border-red-400 bg-red-50 text-red-700 shadow-sm'
              : 'border-gray-200 bg-white text-red-500 hover:border-red-300 hover:bg-red-50/40'
          }`}
        >
          無法辨識
        </button>

        {/* 人工輸入（跨兩欄） */}
        <div className="col-span-2">
          <button
            type="button"
            disabled={disabled}
            onClick={!disabled ? switchToManual : undefined}
            className={`w-full rounded-lg border-2 px-3 py-2.5 text-left text-xs font-semibold transition-colors disabled:cursor-not-allowed ${
              decision?.source === 'manual'
                ? 'border-blue-400 bg-blue-50 text-blue-800 shadow-sm'
                : 'border-gray-200 bg-white text-blue-600 hover:border-blue-300 hover:bg-blue-50/40'
            }`}
          >
            {decision?.source === 'manual' && manualInput ? `人工輸入：${manualInput}` : '人工輸入…'}
          </button>
          {decision?.source === 'manual' && (
            <textarea
              rows={2}
              value={manualInput}
              disabled={disabled}
              placeholder={isCalcType ? '輸入最終答案（不需要寫算式）' : '輸入答案…'}
              className="mt-1.5 w-full rounded-lg border border-blue-300 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:opacity-50 resize-y"
              autoFocus={shouldAutoFocusOnDesktop()}
              onChange={(e) => {
                setManualInput(e.target.value)
                onDecision(questionId, {
                  source: 'manual',
                  finalAnswer: e.target.value,
                  confirmed: e.target.value.trim().length > 0,
                })
              }}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// ─── BatchConsistencyReviewSection ──────────────────────────────────────────

function BatchConsistencyReviewSection({
  entries,
  allStudents,
  onDecision,
  onStudentConfirmed,
  onAllDone,
  phaseBScoredCount = 0,
  phaseBTotalCount = 0,
}: {
  entries: BatchPhaseAEntry[]
  allStudents: Student[]
  onDecision: (studentId: string, questionId: string, update: Partial<ConsistencyDecision>) => void
  onStudentConfirmed: (entry: BatchPhaseAEntry) => void
  onAllDone: () => void
  phaseBScoredCount?: number
  phaseBTotalCount?: number
}) {
  // isPhaseBRunning 不再使用（Accessor 在背景跑）
  // Helper: determine if a question needs human review
  // New architecture: use arbiterResult.arbiterStatus; fall back to consistencyStatus for old data
  const isNeedsReview = (q: PhaseAQuestionResult) => {
    if (q.arbiterResult) return q.arbiterResult.arbiterStatus === 'needs_review'
    return q.consistencyStatus !== 'stable'  // legacy fallback
  }

  // 按學生分組：只收集需審查的學生
  const needsReviewEntries = entries.filter(e =>
    e.phaseAResult.questionResults.some(q => isNeedsReview(q))
  )
  const stableCount = entries.length - needsReviewEntries.length

  // 一次一個學生：追蹤目前審查到第幾個
  const [currentReviewIdx, setCurrentReviewIdx] = useState(0)
  const [confirmedStudentIds, setConfirmedStudentIds] = useState<Set<string>>(new Set())

  const currentEntry = needsReviewEntries[currentReviewIdx]
  const currentReviewQs = currentEntry
    ? currentEntry.phaseAResult.questionResults.filter(q => isNeedsReview(q))
    : []
  const currentAllConfirmed = currentEntry
    ? currentReviewQs.every(q => currentEntry.decisions.get(q.questionId)?.confirmed)
    : false

  const reviewSectionRef = useRef<HTMLDivElement>(null)

  const handleConfirmAndNext = () => {
    if (!currentEntry) return
    setConfirmedStudentIds(prev => new Set([...prev, currentEntry.studentId]))
    onStudentConfirmed(currentEntry)
    if (currentReviewIdx < needsReviewEntries.length - 1) {
      setCurrentReviewIdx(prev => prev + 1)
      // 切換學生後滾到審查區塊頂部，從第一題開始看
      setTimeout(() => reviewSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100)
    } else {
      // 全部審查完
      onAllDone()
    }
  }

  const allDone = confirmedStudentIds.size >= needsReviewEntries.length

  return (
    <div ref={reviewSectionRef} className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
      {/* Header + 背景進度 */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-bold text-gray-900 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-orange-500" />
            人工審查
          </h2>
          <p className="text-xs text-gray-500 mt-0.5">
            {needsReviewEntries.length > 0
              ? `${needsReviewEntries.length} 位學生需要確認`
              : '所有答案已自動確認'}
          </p>
        </div>
        <span className="text-sm font-semibold px-3 py-1.5 rounded-full bg-blue-100 text-blue-700">
          評分進度 {phaseBScoredCount}/{phaseBTotalCount}
        </span>
      </div>

      {/* 穩定學生 */}
      {stableCount > 0 && (
        <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-2.5 text-sm text-green-700 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0 text-green-500" />
          <span><strong>{stableCount} 位</strong>同學答案一致，自動評分中</span>
        </div>
      )}

      {/* 當前審查的學生 — 一次一個 */}
      {currentEntry && !allDone && (() => {
        const student = allStudents.find(s => s.id === currentEntry.studentId)

        return (
          <div className="rounded-lg border border-orange-200 bg-orange-50 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="inline-flex min-w-[28px] items-center justify-center rounded-md border border-orange-300 bg-orange-200 text-orange-800 px-2 py-1 text-sm font-bold">
                  {student?.seatNumber ?? '?'}
                </span>
                <span className="text-sm font-bold text-gray-900">{student?.name ?? currentEntry.studentId}</span>
                <span className="text-xs text-gray-500">({currentReviewQs.length} 題待確認)</span>
              </div>
              <span className="text-xs text-gray-500">
                {currentReviewIdx + 1}/{needsReviewEntries.length}
              </span>
            </div>

            {/* 這個學生的所有待審查題目 */}
            <div className="space-y-2">
              {currentReviewQs.map(q => (
                <ConsistencyQuestionCard
                  key={q.questionId}
                  studentId={currentEntry.studentId}
                  questionResult={q}
                  decision={currentEntry.decisions.get(q.questionId)}
                  onDecision={(questionId, update) => onDecision(currentEntry.studentId, questionId, update)}
                  disabled={false}
                />
              ))}
            </div>

            {/* 確認送出按鈕 */}
            <button
              onClick={handleConfirmAndNext}
              disabled={!currentAllConfirmed}
              className="w-full py-2.5 rounded-xl bg-purple-600 text-white font-bold text-sm hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
            >
              {currentAllConfirmed
                ? currentReviewIdx < needsReviewEntries.length - 1
                  ? `確認送出 → 下一位（${currentReviewIdx + 2}/${needsReviewEntries.length}）`
                  : '確認送出（最後一位）'
                : `請先選擇所有題目的答案`}
            </button>
          </div>
        )
      })()}

      {/* 全部審查完 */}
      {allDone && (
        <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-700 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0 text-green-500" />
          <span>
            <strong>全部審查完成！</strong>
            {phaseBScoredCount < phaseBTotalCount
              ? ` 等待最後 ${phaseBTotalCount - phaseBScoredCount} 位學生評分完成…`
              : ' 所有學生評分完成！'}
          </span>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

export default function GradingPage({
  assignmentId,
  batchAssignmentIds,
  onBack,
  onRequireInkTopUp,
  onGradingPhaseChange,
  embedded = false
}: GradingPageProps) {
  const navigate = useNavigate()
  const isBatchMode = !!(batchAssignmentIds && batchAssignmentIds.length > 1)
  const PREVIEW_LENS_SIZE = 140
  const PREVIEW_ZOOM_SCALE = 2.3
  const PREVIEW_ZOOM_PANEL_SIZE = 250

  const [assignment, setAssignment] = useState<Assignment | null>(null)
  const [classroom, setClassroom] = useState<Classroom | null>(null)
  const [students, setStudents] = useState<Student[]>([])
  const [submissions, setSubmissions] = useState<Map<string, Submission>>(new Map())

  // ── 批次模式：多班級資料 ──
  const [batchTemplateName, setBatchTemplateName] = useState('')
  const [batchClassrooms, setBatchClassrooms] = useState<Map<string, Classroom>>(new Map())
  const [_batchAssignments, setBatchAssignments] = useState<Map<string, Assignment>>(new Map())
  // submissionClassroomMap: studentId → classroomId（用於分組顯示）
  const [submissionClassroomMap, setSubmissionClassroomMap] = useState<Map<string, string>>(new Map())
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isGrading, setIsGrading] = useState(false)
  const [isDownloading, setIsDownloading] = useState(false)
  const [isCheckingCorrectionState, setIsCheckingCorrectionState] = useState(false)
  const [gradingProgress, setGradingProgress] = useState({ current: 0, total: 0 })
  const [downloadProgress, setDownloadProgress] = useState({ current: 0, total: 0 })
  const [error, setError] = useState<string | null>(null)
  const [inkSessionReady, setInkSessionReady] = useState(false)
  const [inkSessionError, setInkSessionError] = useState<string | null>(null)
  const [isClosingSession, setIsClosingSession] = useState(false)

  const inkSessionStartRef = useRef<string | null>(null)
  const hasClosedSessionRef = useRef(false)
  const skipInkSessionCleanupRef = useRef(import.meta.env.DEV)
  const correctionStatusByStudentIdRef = useRef<Map<string, string>>(new Map())
  const correctionStatusFetchedAtRef = useRef(0)
  // 卡片顯示用：跟 ref 同步、但用 state 觸發 re-render
  const [correctionStatusByStudent, setCorrectionStatusByStudent] = useState<Record<string, string>>({})

  const [selectedSubmission, setSelectedSubmission] = useState<{
    submission: Submission
    student: Student
  } | null>(null)
  const [previewLensActive, setPreviewLensActive] = useState(false)
  const [previewLensState, setPreviewLensState] = useState({
    x: 0,
    y: 0,
    lensLeft: 0,
    lensTop: 0,
    width: 0,
    height: 0,
    clientX: 0,
    clientY: 0
  })

  // 🆕 停止批改相關
  const [stopRequested, setStopRequested] = useState(false)
  const stopRequestedRef = useRef(false)

  // 🆕 確認對話框
  const [showGradeConfirm, setShowGradeConfirm] = useState(false)
  const [gradeCandidates, setGradeCandidates] = useState<Submission[]>([])
  const [isRegrade, setIsRegrade] = useState(false)
  const [selectedSubmissionIds, setSelectedSubmissionIds] = useState<Set<string>>(new Set())
  const [correctionGuardModal, setCorrectionGuardModal] = useState<CorrectionGuardModalState | null>(
    null
  )
  const [isRevokingCorrection, setIsRevokingCorrection] = useState(false)
  const [revokeError, setRevokeError] = useState<string | null>(null)
  // 守門 modal 被關掉之前、被擋下的批改流程從哪繼續。退回成功後呼叫此 ref 恢復流程。
  const pendingGradeResumeRef = useRef<(() => void) | null>(null)
  const [gradeResultNotice, setGradeResultNotice] = useState<GradeResultNotice | null>(null)
  const [manualGradingStudentId, setManualGradingStudentId] = useState<string | null>(null)

  // 🆕 進度詳情
  const [_currentGradingStudent, setCurrentGradingStudent] = useState<string>('')
  const [_gradingStartTime, setGradingStartTime] = useState<number>(0)
  const [_completedReviewCount, setCompletedReviewCount] = useState(0)
  const [gradingMessage, setGradingMessage] = useState<string>('AI 批改中…')
  const [_nowTs, setNowTs] = useState(() => Date.now())

  // 答案卷版本狀態
  const [answerKeyStatus, setAnswerKeyStatus] = useState<'normal' | 'updated' | 'deleted'>('normal')

  // Phase A/B 批次一致性審查
  const [gradingPhase, setGradingPhase] = useState<GradingPhase>('idle')
  const backgroundPhaseBPromises = useRef<Promise<void>[]>([])
  const [batchPhaseAEntries, setBatchPhaseAEntries] = useState<BatchPhaseAEntry[]>([])
  // 跨 review UI 持有 Phase A pipeline 失敗（最終 dialog 才會顯示）
  const [pendingPhaseAFailures, setPendingPhaseAFailures] = useState<Array<{ submissionId: string; studentId: string; failure: PipelineFailure }>>([])
  const [phaseANeedsReviewCount, setPhaseANeedsReviewCount] = useState(0)
  const [phaseATotalQuestionCount, setPhaseATotalQuestionCount] = useState(0)
  // qualityCheckRetryCount removed — quality checks are now internal (server-side)
  const [postRetryWarnings, setPostRetryWarnings] = useState<Array<{ submissionId: string; studentLabel: string; unreadCount: number }>>([])


  useEffect(() => {
    onGradingPhaseChange?.(gradingPhase)
  }, [gradingPhase, onGradingPhaseChange])

  // 題目詳情（可編輯）
  const [editableDetails, setEditableDetails] = useState<any[]>([])
  const [isSavingScore, setIsSavingScore] = useState(false)

  const avoidBlobStorage = shouldAvoidIndexedDbBlob()
  const isBusy = isGrading || isDownloading
  const selectedSubmissionCount = selectedSubmissionIds.size

  // 2026-05-17: Phase A / Phase B 分離設計——卡片狀態彙總（給按鈕邏輯用）
  // 規則：無勾選 = 全部（排除未繳交 + 手動標記）、有勾選 = 對勾選
  const stageAggregates = useMemo(() => {
    const allSubs = Array.from(submissions.values())
    const hasSelection = selectedSubmissionIds.size > 0
    const inScope = hasSelection
      ? allSubs.filter((s) => selectedSubmissionIds.has(s.id))
      : allSubs.filter((s) => {
          const stage = deriveCardStage(s)
          // 全部批改情境排除：未繳交 / 手動標記
          return stage !== 'not_submitted' && stage !== 'manual_marked'
        })

    const stageList: CardStage[] = []
    const stageMap: Record<CardStage, Submission[]> = {
      not_submitted: [], not_extracted: [], phase_a_failed: [],
      pending_review: [], pending_grading: [], phase_b_failed: [],
      graded: [], manual_marked: []
    }
    for (const sub of inScope) {
      const stage = deriveCardStage(sub)
      stageList.push(stage)
      stageMap[stage].push(sub)
    }

    return {
      hasSelection,
      inScope,
      stageMap,
      counts: {
        not_extracted: stageMap.not_extracted.length,
        phase_a_failed: stageMap.phase_a_failed.length,
        pending_review: stageMap.pending_review.length,
        pending_grading: stageMap.pending_grading.length,
        phase_b_failed: stageMap.phase_b_failed.length,
        graded: stageMap.graded.length
      }
    }
  }, [submissions, selectedSubmissionIds])

  // 2026-05-17: 「重新截取」按鈕變身規則
  // 🟢 primary：有 未擷取 / 擷取失敗 卡片
  // 🟡 secondary（emit warning modal）：有 待複核 / 待批改 / 已批改 / 批改失敗
  // 🔘 disabled：空（無 in-scope 卡片）
  const recaptureButtonState = useMemo(() => {
    const { counts, inScope } = stageAggregates
    if (inScope.length === 0) return { variant: 'disabled' as const, needsWarning: false }
    const hasFreshWork = counts.not_extracted > 0 || counts.phase_a_failed > 0
    const hasDataToClear = counts.pending_review > 0 || counts.pending_grading > 0
      || counts.graded > 0 || counts.phase_b_failed > 0
    return {
      variant: hasFreshWork ? ('primary' as const) : ('secondary' as const),
      needsWarning: hasDataToClear
    }
  }, [stageAggregates])

  // 2026-05-17: 「批改作業」按鈕變身規則
  // 🚫 block + modal：有 未擷取 / 擷取失敗 卡片（必須先截取）
  // 🚫 block + modal：有 待複核（必須先補答）
  // 🟢 primary：有 待批改（happy path）
  // 🟡 warning modal：有 已批改 / 批改失敗（會覆寫舊分數）
  // 🔘 disabled：空
  const gradeButtonState = useMemo(() => {
    const { counts, inScope } = stageAggregates
    if (inScope.length === 0) return { variant: 'disabled' as const, block: null as null | 'needs_extract' | 'needs_review', needsWarning: false }
    if (counts.not_extracted > 0 || counts.phase_a_failed > 0) {
      return { variant: 'secondary' as const, block: 'needs_extract' as const, needsWarning: false }
    }
    if (counts.pending_review > 0) {
      return { variant: 'secondary' as const, block: 'needs_review' as const, needsWarning: false }
    }
    if (counts.pending_grading > 0) {
      const hasOverwrite = counts.graded > 0 || counts.phase_b_failed > 0
      return { variant: 'primary' as const, block: null, needsWarning: hasOverwrite }
    }
    // 只剩 已批改 / 批改失敗 → secondary + warning
    return { variant: 'secondary' as const, block: null, needsWarning: true }
  }, [stageAggregates])
  
  // 🆕 計算待複核數量
  const needsReviewCount = useMemo(() => {
    return Array.from(submissions.values()).filter(s => isSubmissionNeedsReview(s.gradingResult)).length
  }, [submissions])

  // 🆕 獲取所有待複核的學生（按座號排序）
  const needsReviewStudents = useMemo(() => {
    return students
      .filter(student => {
        const sub = submissions.get(student.id)
        return isSubmissionNeedsReview(sub?.gradingResult)
      })
      .sort((a, b) => a.seatNumber - b.seatNumber)
  }, [students, submissions])

  // 🆕 跳轉到下一個待複核
  const jumpToNextReview = useCallback(() => {
    if (needsReviewStudents.length === 0) return
    
    const currentStudentId = selectedSubmission?.student.id
    let nextIndex = 0
    
    if (currentStudentId) {
      const currentIdx = needsReviewStudents.findIndex(s => s.id === currentStudentId)
      if (currentIdx >= 0 && currentIdx < needsReviewStudents.length - 1) {
        nextIndex = currentIdx + 1
      }
    }
    
    const nextStudent = needsReviewStudents[nextIndex]
    const sub = submissions.get(nextStudent.id)
    if (sub) {
      setSelectedSubmission({ submission: sub, student: nextStudent })
    }
  }, [needsReviewStudents, selectedSubmission, submissions])

  // 🆕 跳轉到上一個待複核
  const jumpToPrevReview = useCallback(() => {
    if (needsReviewStudents.length === 0) return
    
    const currentStudentId = selectedSubmission?.student.id
    let prevIndex = needsReviewStudents.length - 1
    
    if (currentStudentId) {
      const currentIdx = needsReviewStudents.findIndex(s => s.id === currentStudentId)
      if (currentIdx > 0) {
        prevIndex = currentIdx - 1
      }
    }
    
    const prevStudent = needsReviewStudents[prevIndex]
    const sub = submissions.get(prevStudent.id)
    if (sub) {
      setSelectedSubmission({ submission: sub, student: prevStudent })
    }
  }, [needsReviewStudents, selectedSubmission, submissions])

  // ─── Batch Phase B: 正式批改（全班）────────────────────────────────────────
  // phaseBScoredCount: 背景 Accessor 已完成的學生數（用於進度追蹤）
  const [phaseBScoredCount, setPhaseBScoredCount] = useState(0)
  const [phaseBTotalCount, setPhaseBTotalCount] = useState(0)

  const executeBatchPhaseB = useCallback(async (
    entriesToProcess?: BatchPhaseAEntry[],
    background = false,
    upstreamPhaseAFailures?: Array<{ submissionId: string; studentId: string; failure: PipelineFailure }>
  ) => {
    const entries = entriesToProcess ?? batchPhaseAEntries
    if (entries.length === 0) {
      // 🆕 全部 Phase A 失敗時 entries=[]、之前直接 return 導致 spinner 永遠卡住
      // 改成：有 upstream failures 時、不是 background、清 spinner 並彈失敗 dialog
      if (!background && upstreamPhaseAFailures && upstreamPhaseAFailures.length > 0) {
        const failReasons = upstreamPhaseAFailures.map((f) => {
          const stu = students.find((s) => s.id === f.studentId)
          const label = stu ? `${stu.seatNumber}號 ${stu.name}` : f.submissionId.slice(0, 8)
          return `${label}：${f.failure.userMessage} ${f.failure.userAction}`
        })
        setBatchPhaseAEntries([])
        setPendingPhaseAFailures([])
        setGradingPhase('idle')
        setIsGrading(false)
        setGradingProgress({ current: 0, total: 0 })
        setGradeResultNotice({
          stopped: false,
          successCount: 0,
          failCount: upstreamPhaseAFailures.length,
          totalCount: upstreamPhaseAFailures.length,
          failReasons,
          failedEntries: [],
        })
      }
      return
    }

    if (!background) {
      setGradingPhase('phase_b_running')
      setGradingMessage('AI 批改評分中…')
      setIsGrading(true)
      setGradingStartTime(Date.now())
      setGradingProgress({ current: 0, total: entries.length })
    }
    if (!background) setPhaseBTotalCount(prev => prev + entries.length)
    setCompletedReviewCount(0)

    // 多選題依年級分流：高中（10-12）走大考中心固定扣 2 分；國小國中或抓不到 grade → 'k9'（現行公式）
    // 一份作業對應一個 classroom，整批共用 gradeBand
    const phaseBClassroom = assignment?.classroomId
      ? await db.classrooms.get(assignment.classroomId)
      : null
    const phaseBGradeBand: 'k9' | 'high' = (phaseBClassroom?.grade ?? 0) >= 10 ? 'high' : 'k9'

    let successCount = 0
    let failCount = 0
    let completedB = 0
    const failReasons: string[] = []
    const failedEntries: BatchPhaseAEntry[] = []

    await runWithConcurrency(
      entries,
      5,  // Phase B 每人 1 request（Accessor+Explain server 端串連）
      300,
      async (entry) => {
        if (stopRequestedRef.current) return null
        const finalAnswers: FinalAnswer[] = entry.phaseAResult.questionResults.map((qr) => {
          const decision = entry.decisions.get(qr.questionId)
          const src = decision?.source ?? 'ai_read1'
          return {
            questionId: qr.questionId,
            finalStudentAnswer: src === 'unrecognizable' ? '無法辨識' : src === 'blank' ? '' : (decision?.finalAnswer ?? qr.readAnswer1.studentAnswer),
            finalAnswerSource: src === 'blank' ? 'manual' : src,
          }
        })
        const gradingResult = await gradePhaseB(entry.imageBlob, entry.phaseAResult, finalAnswers, assignment?.domain, assignment?.id, assignment?.answerSheetMode, entry.submissionId, phaseBGradeBand)
        return { entry, gradingResult }
      },
      async (_i, result, err) => {
        completedB++
        setPhaseBScoredCount(prev => prev + 1)
        if (!background) setGradingProgress({ current: completedB, total: entries.length })
        if (err || !result) {
          console.error(`Phase B failed for ${entries[_i]?.submissionId}:`, err)
          failCount++
          const failedEntry = entries[_i]
          if (failedEntry && !stopRequestedRef.current) failedEntries.push(failedEntry)
          const failedStudent = failedEntry ? students.find((s) => s.id === failedEntry.studentId) : undefined
          const studentLabel = failedStudent
            ? `${failedStudent.seatNumber}號 ${failedStudent.name}`
            : failedEntry
              ? `作業 ${failedEntry.submissionId.slice(0, 8)}`
              : `第 ${_i + 1} 份作業`
          const rawMessage = !err && stopRequestedRef.current
            ? '已略過（手動停止）'
            : getBatchFailureMessage(err)
          const reason = toUserFriendlyBatchFailureReason(rawMessage || '未知錯誤')
          failReasons.push(`${studentLabel}：${reason}`)
          return
        }
        const { entry, gradingResult } = result
        const totalScore = typeof gradingResult.totalScore === 'number' ? gradingResult.totalScore : 0
        const student = students.find((s) => s.id === entry.studentId)
        if (student) setCurrentGradingStudent(`${student.seatNumber}號 ${student.name}`)

        // 嵌入 concept code：批改完成當下凍結，與答案鍵未來的改動脫鉤
        const conceptTags = assignment?.conceptTags
        if (conceptTags && gradingResult.details) {
          for (const detail of gradingResult.details) {
            const tag = conceptTags[detail.questionId]
            if (tag) {
              detail.conceptCode = tag.code
              detail.conceptLabel = tag.label
            }
          }
        }

        const gradedAtMs = Date.now()
        await db.submissions.update(entry.submissionId, {
          status: 'graded',
          score: totalScore,
          aiScore: totalScore,
          scoreSource: 'ai',
          gradingResult,
          gradedAt: gradedAtMs,
          updatedAt: gradedAtMs,
        })
        // 直接寫入 Supabase（不依賴 sync push）
        fetch('/api/data/save-grading', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            submissions: [{
              id: entry.submissionId,
              score: totalScore,
              aiScore: totalScore,
              scoreSource: 'ai',
              gradingResult,
              gradedAt: gradedAtMs,
            }]
          })
        }).catch(() => {/* non-fatal, sync will retry */})
        // Fire-and-forget: update forensic log with teacher decisions + Phase B results
        const gradedAt = new Date().toISOString()
        const forensicUpdates = entry.phaseAResult.questionResults.map((qr) => {
          const arbiter = qr.arbiterResult
          const isNeedsReview = arbiter?.arbiterStatus === 'needs_review'
          const decision = entry.decisions.get(qr.questionId)
          const phaseBDetail = gradingResult.details?.find((d) => d.questionId === qr.questionId)
          let teacherReviewPick: string | null = null
          if (isNeedsReview && decision) {
            if (decision.source === 'ai_read1') teacherReviewPick = 'ai1'
            else if (decision.source === 'ai_read2') teacherReviewPick = 'ai2'
            else teacherReviewPick = 'manual'
          }
          return {
            submissionId: entry.submissionId,
            questionId: qr.questionId,
            finalAnswer: decision?.finalAnswer ?? null,
            finalAnswerSource: decision?.source === 'blank' ? 'manual' : (decision?.source ?? null),
            teacherReviewPick,
            reviewedAt: isNeedsReview ? gradedAt : null,
            phaseBIsCorrect: phaseBDetail?.isCorrect ?? null,
            phaseBScore: phaseBDetail?.score ?? null,
            phaseBMaxScore: phaseBDetail?.maxScore ?? null,
            gradedAt,
          }
        })
        fetch('/api/data/update-ai3-forensic-log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ rows: forensicUpdates }),
        }).catch(() => {})

        setSubmissions((prev) => {
          const next = new Map(prev)
          const sub = Array.from(prev.values()).find((s) => s.id === entry.submissionId)
          if (sub) next.set(sub.studentId, { ...sub, status: 'graded', score: totalScore, gradingResult })
          return next
        })

        if (gradingResult.needsReview) setCompletedReviewCount((prev) => prev + 1)
        successCount++
      },
      stopRequestedRef
    )

    requestSync()

    // ── Phase B 品質檢查：偵測 accessor 回應不完整 ──
    // 如果一個學生有 3 題以上 confidence≤70 + score=0 + reason='需人工複核'，
    // 代表 accessor 回應不完整，自動重跑 Phase B
    const phaseBRetryEntries: BatchPhaseAEntry[] = []
    const submissionsMap = new Map<string, Submission>()
    setSubmissions((prev) => { prev.forEach((s) => submissionsMap.set(s.id, s)); return prev })

    for (const entry of entries) {
      const sub = Array.from(submissionsMap.values()).find((s) => s.id === entry.submissionId)
      const gr = sub?.gradingResult
      if (!gr?.details) continue
      const incompleteCount = gr.details.filter((d: any) =>
        d.score === 0 && d.confidence <= 70 && (!d.reason || d.reason === '需人工複核')
      ).length
      if (incompleteCount >= 3) {
        phaseBRetryEntries.push(entry)
      }
    }

    if (phaseBRetryEntries.length > 0 && !stopRequestedRef.current) {
      console.log(`[PhaseB-QC] ${phaseBRetryEntries.length} submissions need retry (accessor incomplete)`)
      setGradingMessage('品質檢測中…')
      let retrySuccess = 0
      for (const entry of phaseBRetryEntries) {
        try {
          const finalAnswers: FinalAnswer[] = entry.phaseAResult.questionResults.map((qr) => {
            const decision = entry.decisions.get(qr.questionId)
            const src = decision?.source ?? 'ai_read1'
            return {
              questionId: qr.questionId,
              finalStudentAnswer: src === 'unrecognizable' ? '無法辨識' : src === 'blank' ? '' : (decision?.finalAnswer ?? qr.readAnswer1.studentAnswer),
              finalAnswerSource: src === 'blank' ? 'manual' : src,
            }
          })
          const gradingResult = await gradePhaseB(entry.imageBlob, entry.phaseAResult, finalAnswers, assignment?.domain, assignment?.id, assignment?.answerSheetMode, entry.submissionId, phaseBGradeBand)
          const totalScore = typeof gradingResult.totalScore === 'number' ? gradingResult.totalScore : 0
          const retryGradedAt = Date.now()
          await db.submissions.update(entry.submissionId, {
            status: 'graded', score: totalScore, aiScore: totalScore, scoreSource: 'ai',
            gradingResult, gradedAt: retryGradedAt, updatedAt: retryGradedAt,
          })
          fetch('/api/data/save-grading', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
            body: JSON.stringify({ submissions: [{ id: entry.submissionId, score: totalScore, aiScore: totalScore, scoreSource: 'ai', gradingResult, gradedAt: retryGradedAt }] })
          }).catch(() => {})
          setSubmissions((prev) => {
            const next = new Map(prev)
            const sub = Array.from(prev.values()).find((s) => s.id === entry.submissionId)
            if (sub) next.set(sub.studentId, { ...sub, status: 'graded', score: totalScore, gradingResult })
            return next
          })
          retrySuccess++
        } catch (err) {
          console.warn(`[PhaseB-QC] retry failed for ${entry.submissionId}:`, err)
        }
      }
      console.log(`[PhaseB-QC] retry complete: ${retrySuccess}/${phaseBRetryEntries.length} succeeded`)
      requestSync()

      // 重跑後再次檢查，仍有問題的顯示警告
      const stillFailing: Array<{ submissionId: string; studentLabel: string; incompleteCount: number }> = []
      for (const entry of phaseBRetryEntries) {
        const sub = Array.from(submissionsMap.values()).find((s) => s.id === entry.submissionId)
        const gr = sub?.gradingResult
        if (!gr?.details) continue
        const incompleteCount = gr.details.filter((d: any) =>
          d.score === 0 && d.confidence <= 70 && (!d.reason || d.reason === '需人工複核')
        ).length
        if (incompleteCount >= 3) {
          const student = students.find((s) => s.id === entry.studentId)
          stillFailing.push({
            submissionId: entry.submissionId,
            studentLabel: student ? `${student.seatNumber}號 ${student.name}` : entry.studentId,
            incompleteCount
          })
        }
      }
      if (stillFailing.length > 0) {
        setPostRetryWarnings((prev) => [
          ...prev,
          ...stillFailing.map((f) => ({
            submissionId: f.submissionId,
            studentLabel: f.studentLabel,
            unreadCount: f.incompleteCount
          }))
        ])
      }
    }

    // 合併品質檢查失敗到結果摘要
    const qualityFails = postRetryWarnings
    const qualityFailReasons = qualityFails.map((f) => `${f.studentLabel}：${f.unreadCount} 題無法讀取，建議重新批改`)
    const qualityFailedEntries = qualityFails.map((f) => batchPhaseAEntries.find((e) => e.submissionId === f.submissionId)).filter(Boolean) as BatchPhaseAEntry[]

    // 合併 Phase A pipeline 失敗（classify/read/arbiter retry 後仍 FAIL）
    const upstreamFails = upstreamPhaseAFailures ?? []
    const upstreamFailReasons = upstreamFails.map((f) => {
      const stu = students.find((s) => s.id === f.studentId)
      const label = stu ? `${stu.seatNumber}號 ${stu.name}` : f.submissionId.slice(0, 8)
      return `${label}：${f.failure.userMessage} ${f.failure.userAction}`
    })
    const totalEntries = entries.length + qualityFails.length + upstreamFails.length

    if (!background) {
      // 前台模式：清理狀態，顯示結果通知
      setBatchPhaseAEntries([])
      setGradingPhase('idle')
      setIsGrading(false)
      setCurrentGradingStudent('')
      setSelectedSubmissionIds(new Set())
      setPostRetryWarnings([])
      setGradeResultNotice({
        stopped: stopRequestedRef.current,
        successCount,
        failCount: failCount + qualityFails.length + upstreamFails.length,
        totalCount: totalEntries,
        failReasons: [...failReasons, ...qualityFailReasons, ...upstreamFailReasons],
        failedEntries: [...failedEntries, ...qualityFailedEntries],
      })
      setStopRequested(false)
      stopRequestedRef.current = false
      setGradingProgress({ current: 0, total: 0 })
    }
    // 背景模式：只累加 phaseBScoredCount（已在上面做了），不動 UI 狀態
  }, [batchPhaseAEntries, students])

  // ─── 背景 Accessor 完成監聽：phaseBScoredCount 達到 total 時關閉 loading ───
  useEffect(() => {
    if (gradingPhase !== 'phase_b_running') return
    if (phaseBTotalCount === 0) return
    if (phaseBScoredCount < phaseBTotalCount) return
    // 全部背景 Accessor 完成
    const total = phaseBTotalCount
    // 加入 Phase A 失敗（classify/read/arbiter retry 後仍 FAIL）— review UI 路徑也要顯示
    const upstreamFails = pendingPhaseAFailures
    const upstreamFailReasons = upstreamFails.map((f) => {
      const stu = students.find((s) => s.id === f.studentId)
      const label = stu ? `${stu.seatNumber}號 ${stu.name}` : f.submissionId.slice(0, 8)
      return `${label}：${f.failure.userMessage} ${f.failure.userAction}`
    })
    setBatchPhaseAEntries([])
    setPendingPhaseAFailures([])
    setGradingPhase('idle')
    setIsGrading(false)
    setGradingProgress({ current: 0, total: 0 })
    setGradeResultNotice({
      stopped: false,
      successCount: total,
      failCount: upstreamFails.length,
      totalCount: total + upstreamFails.length,
      failReasons: upstreamFailReasons,
      failedEntries: [],
    })
    setPhaseBScoredCount(0)
    setPhaseBTotalCount(0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phaseBScoredCount, phaseBTotalCount, gradingPhase])

  // ─── Batch Decision: 老師對單題的決策 ────────────────────────────────────
  const handleBatchDecision = useCallback(
    (studentId: string, questionId: string, update: Partial<ConsistencyDecision>) => {
      setBatchPhaseAEntries((prev) =>
        prev.map((entry) => {
          if (entry.studentId !== studentId) return entry
          const next = new Map(entry.decisions)
          const existing = next.get(questionId)
          next.set(questionId, {
            questionId,
            source: 'ai_read1',
            finalAnswer: '',
            confirmed: false,
            ...existing,
            ...update,
          })
          return { ...entry, decisions: next }
        })
      )
    },
    []
  )

  const handleInkTopUp = useCallback(() => {
    if (onRequireInkTopUp) {
      onRequireInkTopUp()
      return
    }
    navigate('/ink-topup')
  }, [onRequireInkTopUp, navigate])

  const closePreviewLens = useCallback(() => {
    setPreviewLensActive(false)
  }, [])

  const handlePreviewLensMove = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return

    const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
    const x = clamp(event.clientX - rect.left, 0, rect.width)
    const y = clamp(event.clientY - rect.top, 0, rect.height)
    const half = PREVIEW_LENS_SIZE / 2

    const lensLeft = clamp(x - half, 0, Math.max(0, rect.width - PREVIEW_LENS_SIZE))
    const lensTop = clamp(y - half, 0, Math.max(0, rect.height - PREVIEW_LENS_SIZE))

    setPreviewLensState({
      x,
      y,
      lensLeft,
      lensTop,
      width: rect.width,
      height: rect.height,
      clientX: event.clientX,
      clientY: event.clientY
    })
    setPreviewLensActive(true)
  }, [PREVIEW_LENS_SIZE])

  useEffect(() => {
    setPreviewLensActive(false)
  }, [selectedSubmission?.submission.id])

  useEffect(() => {
    const existingSubmissionIds = new Set(Array.from(submissions.values()).map((sub) => sub.id))
    setSelectedSubmissionIds((prev) => {
      if (prev.size === 0) return prev
      const next = new Set(Array.from(prev).filter((id) => existingSubmissionIds.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [submissions])

  const handleExit = useCallback(async () => {
    if (!onBack || isClosingSession) return

    setIsClosingSession(true)
    try {
      if (!hasClosedSessionRef.current) {
        const summary = await closeInkSession()
        hasClosedSessionRef.current = true

        if (summary && typeof summary.chargedPoints === 'number' && summary.chargedPoints > 0) {
          const remaining =
            typeof summary.balanceAfter === 'number'
              ? `，剩餘 ${summary.balanceAfter} 點`
              : ''
          window.alert(`本次批改扣除 ${summary.chargedPoints} 點${remaining}`)
        }
      }
    } catch (error) {
      console.warn('結算批改會話失敗:', error)
    } finally {
      setIsClosingSession(false)
      onBack()
    }
  }, [isClosingSession, onBack])

  const resolveImageBase64 = async (blob?: Blob, base64?: string) => {
    if (base64) return base64
    if (!blob) return undefined
    try {
      return await blobToBase64(blob)
    } catch (error) {
      console.error('?? Base64 轉換失敗:', error)
      return undefined
    }
  }

  const updateSubmissionWithImages = async (
    submissionId: string,
    updates: Partial<Submission>,
    imageBlob?: Blob,
    imageBase64?: string
  ) => {
    const resolvedBase64 = avoidBlobStorage
      ? await resolveImageBase64(imageBlob, imageBase64)
      : imageBase64
    const payload: Partial<Submission> = { ...updates }

    if (resolvedBase64) payload.imageBase64 = resolvedBase64
    if (!avoidBlobStorage && imageBlob) payload.imageBlob = imageBlob
    if (avoidBlobStorage) payload.imageBlob = undefined

    try {
      await db.submissions.update(submissionId, payload)
    } catch (error) {
      if (!avoidBlobStorage && imageBlob && isIndexedDbBlobError(error)) {
        const fallback: Partial<Submission> = { ...updates }
        if (resolvedBase64) fallback.imageBase64 = resolvedBase64
        await db.submissions.update(submissionId, fallback)
      } else {
        throw error
      }
    }
  }

  const fetchCorrectionStatusByStudentId = useCallback(async (): Promise<Map<string, string>> => {
    const query = new URLSearchParams({ assignmentId })
    query.set('_ts', String(Date.now()))
    const response = await fetch(`/api/data/correction-dashboard?${query.toString()}`, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store'
    })
    const data = (await response.json().catch(() => ({}))) as CorrectionDashboardLite & {
      error?: string
    }
    if (!response.ok) {
      throw new Error(data.error || '讀取訂正狀態失敗')
    }

    const nextMap = new Map<string, string>()
    for (const row of Array.isArray(data.students) ? data.students : []) {
      const studentId = typeof row?.studentId === 'string' ? row.studentId : ''
      const status = typeof row?.status === 'string' ? row.status : ''
      if (!studentId || !status) continue
      nextMap.set(studentId, status)
    }

    correctionStatusByStudentIdRef.current = nextMap
    correctionStatusFetchedAtRef.current = Date.now()
    // 同步進 state 觸發卡片 re-render
    setCorrectionStatusByStudent(Object.fromEntries(nextMap))
    return nextMap
  }, [assignmentId])

  // 卡片顯示用 prefetch：mount 進來 + 視窗 focus 回來各拉一次
  // 失敗 silently、卡片就少顯示 badge、不擋批改（批改路徑另有 ensureNoCorrectionConflict 守門）
  useEffect(() => {
    if (!assignmentId) return
    void fetchCorrectionStatusByStudentId().catch(() => {})
    const onFocus = () => { void fetchCorrectionStatusByStudentId().catch(() => {}) }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [assignmentId, fetchCorrectionStatusByStudentId])

  const collectCorrectionBlockedStudents = useCallback(
    (candidateSubs: Submission[], statusMap: Map<string, string>) => {
      const byStudent = new Map<string, CorrectionBlockedStudent>()

      for (const submission of candidateSubs) {
        const studentId = submission.studentId
        if (!studentId || byStudent.has(studentId)) continue
        const status = statusMap.get(studentId) || ''
        if (!CORRECTION_BLOCKING_STATUSES.has(status)) continue
        const student = students.find((s) => s.id === studentId)
        byStudent.set(studentId, {
          studentId,
          seatNumber:
            student && Number.isFinite(student.seatNumber) ? Number(student.seatNumber) : null,
          name: student?.name || studentId,
          status
        })
      }

      return Array.from(byStudent.values()).sort((a, b) => {
        const seatA = a.seatNumber ?? Number.MAX_SAFE_INTEGER
        const seatB = b.seatNumber ?? Number.MAX_SAFE_INTEGER
        if (seatA !== seatB) return seatA - seatB
        return a.name.localeCompare(b.name, 'zh-Hant')
      })
    },
    [students]
  )

  const openCorrectionGuardModal = useCallback(
    (title: string, description: string, blockedStudents: CorrectionBlockedStudent[] = []) => {
      setRevokeError(null)
      setCorrectionGuardModal({
        title,
        description,
        blockedStudents
      })
    },
    []
  )

  // 從守門 modal 直接呼叫 correction-dispatch-toggle stop、退回指定學生的訂正
  // 後端已有 guard：學生的訂正稿正在 AI re-check 時不能退回、會回 blocked list
  const handleRevokeCorrection = useCallback(
    async (studentIds: string[]) => {
      if (studentIds.length === 0) return
      const ok = window.confirm(
        `確定退回 ${studentIds.length} 位學生的訂正？\n\n` +
          '學生已輸入的訂正內容會保留，但派發狀態歸零，老師可重新批改原作業。\n' +
          '若學生正在訂正頁面、需重新整理才會看到狀態變更。'
      )
      if (!ok) return
      setIsRevokingCorrection(true)
      setRevokeError(null)
      try {
        const response = await fetch('/api/data/correction-dispatch-toggle', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            assignmentId,
            action: 'stop',
            studentIds
          })
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
          throw new Error(data?.error || '退回失敗、請稍後再試')
        }
        // 即使 HTTP 200、後端仍可能回 blockedStudents（訂正稿在 AI 重批中無法退回）
        const blocked = Array.isArray(data?.blockedStudents) ? data.blockedStudents : []
        const recalledCount = Number(data?.recalledCount) || 0
        const blockedNames = blocked
          .map(
            (b: { seatNumber?: number; name?: string }) =>
              `${b.seatNumber ?? '?'}號 ${b.name ?? ''}`
          )
          .join('、')

        // 先刷新 status map（即使有 blocked、有退回的部分也要反映出來）
        await fetchCorrectionStatusByStudentId().catch(() => {})

        if (recalledCount === 0 && blocked.length > 0) {
          // 全員無法退回、modal 保持開、顯示具體錯誤
          throw new Error(`無法退回：${blockedNames} 的訂正稿正在 AI 重批中、請等批改完成或到「作業訂正看板」處理`)
        }
        if (recalledCount > 0 && blocked.length > 0) {
          // 部分成功、保留 modal 顯示哪些沒退回
          setRevokeError(
            `已退回 ${recalledCount} 位、但下列學生仍無法退回（AI 重批中）：${blockedNames}`
          )
          return
        }
        if (recalledCount === 0 && blocked.length === 0) {
          // 沒退到任何人、可能本來就沒在 correction 狀態（race condition）
          setRevokeError('沒有可退回的訂正、可能已被其他操作清除、請關閉視窗重試')
          return
        }
        // 全員退回成功 — 若先前有 grading 流程被擋下、自動接續（不要老師再按一次批改）
        const resume = pendingGradeResumeRef.current
        pendingGradeResumeRef.current = null
        setCorrectionGuardModal(null)
        resume?.()
      } catch (err) {
        setRevokeError(err instanceof Error ? err.message : '退回失敗')
      } finally {
        setIsRevokingCorrection(false)
      }
    },
    [assignmentId, fetchCorrectionStatusByStudentId]
  )

  const ensureNoCorrectionConflict = useCallback(
    async (candidateSubs: Submission[]) => {
      const cachedMap = correctionStatusByStudentIdRef.current
      const cachedBlockedStudents = collectCorrectionBlockedStudents(candidateSubs, cachedMap)
      if (cachedBlockedStudents.length > 0) {
        openCorrectionGuardModal(
          '目前無法批改',
          '偵測到訂正中的學生。為避免覆蓋學生端訂正內容，請先到「作業訂正看板」停止訂正後再批改。',
          cachedBlockedStudents
        )
        return false
      }

      const cacheAgeMs = Date.now() - correctionStatusFetchedAtRef.current
      const hasRecentStatus = cachedMap.size > 0 && cacheAgeMs <= 12_000
      if (hasRecentStatus) return true

      setIsCheckingCorrectionState(true)
      try {
        const latestMap = await fetchCorrectionStatusByStudentId()
        const blockedStudents = collectCorrectionBlockedStudents(candidateSubs, latestMap)
        if (blockedStudents.length > 0) {
          openCorrectionGuardModal(
            '目前無法批改',
            '偵測到訂正中的學生。為避免覆蓋學生端訂正內容，請先到「作業訂正看板」停止訂正後再批改。',
            blockedStudents
          )
          return false
        }
        return true
      } catch (error) {
        console.warn('⚠️ 檢查訂正狀態失敗:', error)
        openCorrectionGuardModal(
          '無法確認訂正狀態',
          '系統暫時無法確認是否仍有學生在訂正中，請稍後再試，或先到「作業訂正看板」確認後再批改。'
        )
        return false
      } finally {
        setIsCheckingCorrectionState(false)
      }
    },
    [
      collectCorrectionBlockedStudents,
      fetchCorrectionStatusByStudentId,
      openCorrectionGuardModal
    ]
  )

  const loadData = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const allAssignmentIds = isBatchMode ? batchAssignmentIds! : [assignmentId]

      // 載入所有 assignments
      const allAssignmentsData = await Promise.all(allAssignmentIds.map((id) => db.assignments.get(id)))
      const validAssignments = allAssignmentsData.filter((a): a is Assignment => !!a)
      if (validAssignments.length === 0) throw new Error('找不到作業')

      // 主 assignment（用於 answerKey）
      const assignmentData = validAssignments[0]
      setAssignment(assignmentData)

      // 檢查答案卷版本狀態
      if (assignmentData.answerKeyTemplateId) {
        const tpl = await db.answerKeyTemplates.get(assignmentData.answerKeyTemplateId)
        if (!tpl) {
          setAnswerKeyStatus('deleted')
        } else if (
          typeof assignmentData.boundAnswerKeyVersion === 'number' &&
          typeof tpl.version === 'number' &&
          tpl.version > assignmentData.boundAnswerKeyVersion
        ) {
          setAnswerKeyStatus('updated')
        } else {
          setAnswerKeyStatus('normal')
        }
      } else {
        setAnswerKeyStatus('normal')
      }

      // 載入所有相關班級和學生
      const classroomIds = [...new Set(validAssignments.map((a) => a.classroomId))]
      const allClassrooms = await Promise.all(classroomIds.map((id) => db.classrooms.get(id)))
      const classroomMap = new Map<string, Classroom>()
      for (const c of allClassrooms) { if (c) classroomMap.set(c.id, c) }

      if (isBatchMode) {
        setBatchClassrooms(classroomMap)
        const assignmentMap = new Map<string, Assignment>()
        for (const a of validAssignments) assignmentMap.set(a.id, a)
        setBatchAssignments(assignmentMap)
        // 取答案卷模板名稱
        const templateId = assignmentData.answerKeyTemplateId
        if (templateId) {
          const template = await db.answerKeyTemplates.get(templateId)
          setBatchTemplateName(template?.name || assignmentData.title)
        } else {
          setBatchTemplateName(assignmentData.title)
        }
      }

      const classroomData = classroomMap.get(assignmentData.classroomId)
      if (!classroomData) throw new Error('找不到班級')
      setClassroom(classroomData)

      // 載入所有班級的學生
      const allStudents: Student[] = []
      for (const cid of classroomIds) {
        const stu = await db.students.where('classroomId').equals(cid).sortBy('seatNumber')
        allStudents.push(...stu)
      }
      setStudents(allStudents)

      // 建立 studentId → classroomId 映射（batch mode 用於分組）
      if (isBatchMode) {
        const scMap = new Map<string, string>()
        for (const s of allStudents) scMap.set(s.id, s.classroomId)
        setSubmissionClassroomMap(scMap)
      }

      // 載入所有 submissions
      const submissionsData = isBatchMode
        ? await db.submissions.where('assignmentId').anyOf(allAssignmentIds).toArray()
        : await db.submissions.where('assignmentId').equals(assignmentId).toArray()
      const map = new Map<string, Submission>()

      for (const sub of submissionsData) {
        // 診斷 Blob 狀態
        console.log(`📊 載入作業 ${sub.id}:`, {
          studentId: sub.studentId,
          status: sub.status,
          hasBlob: !!sub.imageBlob,
          blobSize: sub.imageBlob?.size,
          blobType: sub.imageBlob?.type,
          hasBase64: !!sub.imageBase64,
          imageUrl: sub.imageUrl
        })

        // 修復 Blob：如果 Blob 存在但沒有 type 或大小為 0，嘗試修復
        if (sub.imageBlob) {
          if (sub.imageBlob.size === 0 || !sub.imageBlob.type) {
            console.warn(`⚠️ 作業 ${sub.id} 的 Blob 有問題 (size=${sub.imageBlob.size}, type="${sub.imageBlob.type}")`)

            // 嘗試從 Base64 重建 Blob
            if (sub.imageBase64) {
              try {
                console.log(`🔧 嘗試從 Base64 重建 Blob`)
                sub.imageBlob = rebuildBlobFromBase64(sub.imageBase64)
                console.log(`✅ 從 Base64 重建 Blob 成功: size=${sub.imageBlob.size}, type=${sub.imageBlob.type}`)
              } catch (error) {
                console.error(`❌ 從 Base64 重建 Blob 失敗:`, error)
                sub.imageBlob = undefined
              }
            } else {
              // 沒有 Base64 備份，清除無效 Blob
              console.warn(`⚠️ 無 Base64 備份，清除 Blob`)
              sub.imageBlob = undefined
            }
          } else if (sub.imageBlob.type === '') {
            // 如果只是 type 為空字串，嘗試修復
            console.log(`🔧 修復作業 ${sub.id} 的 Blob type`)
            sub.imageBlob = new Blob([sub.imageBlob], { type: 'image/jpeg' })
          }
        }

        if (avoidBlobStorage && sub.imageBlob) {
          try {
            const base64 = sub.imageBase64 ?? await blobToBase64(sub.imageBlob)
            sub.imageBase64 = base64
            await updateSubmissionWithImages(sub.id, {}, sub.imageBlob, base64)
            sub.imageBlob = undefined
          } catch (error) {
            console.warn('⚠️ Base64 轉換失敗，略過 Blob 清理:', error)
          }
        }

        // 訂正提交一律跳過，不放入主 Map（避免蓋掉原始批改結果或產生誤導顯示）
        if (sub.source === 'student_correction') continue
        map.set(sub.studentId, sub)
      }

      setSubmissions(map)
      void fetchCorrectionStatusByStudentId().catch((error) => {
        console.warn('⚠️ 預載訂正狀態失敗:', error)
      })

      // ✅ 先放行 UI：提早結束 loading 狀態，讓畫面能快速顯示
      setIsLoading(false)

      // 補抓：graded 但本地缺少 gradingResult 的 submission（重新登入後 IndexedDB 為空）
      const missingIds = submissionsData
        .filter((s) => s.status === 'graded' && !s.gradingResult)
        .map((s) => s.id)
      if (missingIds.length > 0) {
        try {
          const resp = await fetch(
            buildApiUrl(`/api/data/grading-results?assignmentId=${encodeURIComponent(assignmentId)}`),
            { credentials: 'include' }
          )
          if (resp.ok) {
            const json = await resp.json()
            const gradingResults: Record<string, unknown> = json?.gradingResults ?? {}
            for (const id of missingIds) {
              const gr = gradingResults[id] as any
              if (gr) {
                const totalScore = typeof gr.totalScore === 'number' ? gr.totalScore : undefined
                await db.submissions.update(id, {
                  gradingResult: gr,
                  ...(totalScore !== undefined ? { score: totalScore, aiScore: totalScore, scoreSource: 'ai' as const } : {}),
                  updatedAt: Date.now()
                })
              }
            }
            // 更新 React state
            setSubmissions((prev) => {
              const next = new Map(prev)
              for (const [studentId, sub] of next) {
                if (sub.id && gradingResults[sub.id]) {
                  next.set(studentId, { ...sub, gradingResult: gradingResults[sub.id] as any })
                }
              }
              return next
            })
            console.log(`✅ 補抓 gradingResult 完成：${missingIds.length} 筆`)
          }
        } catch (err) {
          console.warn('⚠️ 補抓 gradingResult 失敗:', err)
        }
      }

      // 背景生成/預取縮圖（避免卡片渲染原圖導致滑動 lag）
      const needsThumbnail = submissionsData.filter(
        (s) => s.source !== 'student_correction' && s.id && !s.thumbnailBlob && !s.thumbnailBase64
      )
      if (needsThumbnail.length > 0) {
        void (async () => {
          const { generateThumbnail } = await import('@/lib/imageCompression')
          const CONCURRENCY = 3
          for (let i = 0; i < needsThumbnail.length; i += CONCURRENCY) {
            const batch = needsThumbnail.slice(i, i + CONCURRENCY)
            await Promise.all(batch.map(async (sub) => {
              try {
                // 優先從本地 imageBlob 生成縮圖（不需網路）
                const sourceBlob = sub.imageBlob && sub.imageBlob.size > 0 ? sub.imageBlob : null
                let thumbBlob: Blob | null = null
                if (sourceBlob) {
                  thumbBlob = await generateThumbnail(sourceBlob, 200)
                } else {
                  // 本地沒有原圖，從 Storage API 下載縮圖
                  const params = new URLSearchParams({ submissionId: sub.id, thumb: 'true' })
                  const resp = await fetch(buildApiUrl(`/api/storage/download?${params.toString()}`), { credentials: 'include' })
                  if (!resp.ok) return
                  const blob = await resp.blob()
                  if (blob.size === 0) return
                  thumbBlob = blob
                }
                if (!thumbBlob) return
                if (avoidBlobStorage) {
                  const base64 = await blobToBase64(thumbBlob)
                  await db.submissions.update(sub.id, { thumbnailBase64: base64 })
                  setSubmissions((prev) => {
                    const next = new Map(prev)
                    const existing = next.get(sub.studentId)
                    if (existing) next.set(sub.studentId, { ...existing, thumbnailBase64: base64 })
                    return next
                  })
                } else {
                  await db.submissions.update(sub.id, { thumbnailBlob: thumbBlob })
                  setSubmissions((prev) => {
                    const next = new Map(prev)
                    const existing = next.get(sub.studentId)
                    if (existing) next.set(sub.studentId, { ...existing, thumbnailBlob: thumbBlob })
                    return next
                  })
                }
              } catch {
                // 縮圖生成/預取失敗，不影響主流程
              }
            }))
          }
        })()
      }

    } catch (err) {
      console.error('載入失敗', err)
      setError(err instanceof Error ? err.message : '載入失敗')
      setIsLoading(false)
    }
  }, [assignmentId, isBatchMode, batchAssignmentIds, fetchCorrectionStatusByStudentId])

  const syncAndReload = useCallback(async (timeoutMs = 15000) => {
    requestSync(true)
    try {
      await waitForSync(timeoutMs)
    } catch (error) {
      console.warn('⚠️ 進頁同步等待逾時，改用目前資料繼續載入', error)
    }
    await loadData()
  }, [loadData])

  useEffect(() => {
    void syncAndReload()
  }, [syncAndReload])

  useEffect(() => {
    let cancelled = false
    const shouldStart = inkSessionStartRef.current !== assignmentId

    const initInkSession = async () => {
      setInkSessionReady(false)
      setInkSessionError(null)
      
      // 已有 session（例如同頁面重載狀態復原）就沿用
      if (getInkSessionId()) {
        console.log('[ink-session] 頁面載入：已有 session，沿用')
        setInkSessionReady(true)
        return
      }
      
      try {
        console.log('[ink-session] 頁面載入：建立新 session...')
        const data = await startInkSession()
        if (cancelled) return
        if (!data?.sessionId) {
          throw new Error('無法建立批改會話')
        }
        console.log('[ink-session] 頁面載入：session 建立成功')
        setInkSessionReady(true)
      } catch (err) {
        if (cancelled) return
        const message = err instanceof Error ? err.message : '無法建立批改會話'
        setInkSessionError(message)
      }
    }

    if (shouldStart) {
      inkSessionStartRef.current = assignmentId
      void initInkSession()
    }

    return () => {
      if (import.meta.env.DEV && skipInkSessionCleanupRef.current) {
        skipInkSessionCleanupRef.current = false
        return
      }
      cancelled = true
      if (hasClosedSessionRef.current) return
      hasClosedSessionRef.current = true
      console.log('[ink-session] 頁面離開：關閉 session...')
      void closeInkSession().catch((e) => {
        console.warn('[ink-session] 頁面離開：關閉 session 失敗:', e)
      })
    }
  }, [assignmentId])

  // 處理瀏覽器關閉/重新整理（unmount 有時候抓不到）
  useEffect(() => {
    const handler = () => {
      if (hasClosedSessionRef.current) return
      hasClosedSessionRef.current = true
      console.log('[ink-session] 瀏覽器關閉/重新整理：嘗試關閉 session...')
      void closeInkSession().catch(() => {})
    }

    window.addEventListener('pagehide', handler)
    window.addEventListener('beforeunload', handler)

    return () => {
      window.removeEventListener('pagehide', handler)
      window.removeEventListener('beforeunload', handler)
    }
  }, [])

  // 將 AI 題目詳情映射到可編輯狀態
  useEffect(() => {
    if (selectedSubmission?.submission?.gradingResult?.details) {
      const details = selectedSubmission.submission.gradingResult.details
      if (Array.isArray(details)) {
        console.log('[grading] details with confidence:', details)
        setEditableDetails(
          details.map((d: any, index: number) => ({
            questionId: d.questionId ?? `#${index + 1}`,
            studentAnswer: d.studentAnswer ?? '',
            reason: d.reason ?? d.comment ?? '',
            comment: d.comment ?? d.reason ?? '',
            confidence:
              typeof d.confidence === 'number' && Number.isFinite(d.confidence)
                ? d.confidence
                : undefined,
            score:
              typeof d.score === 'number' && Number.isFinite(d.score)
                ? d.score
                : 0,
            maxScore:
              typeof d.maxScore === 'number' && Number.isFinite(d.maxScore)
                ? d.maxScore
                : 0,
            isCorrect:
              typeof d.isCorrect === 'boolean'
                ? d.isCorrect
                : d.maxScore
                  ? Number(d.score) >= Number(d.maxScore)
                  : false,
            // table_cell 群組批改：保留每 cell 對錯細節（人工複核 UI 用）
            cellResults: Array.isArray(d.cellResults) ? d.cellResults : undefined
          }))
        )
      } else {
        setEditableDetails([])
      }
    } else {
      setEditableDetails([])
    }
  }, [selectedSubmission])

  // 每 30 秒自動 sync，讓老師即時看到學生上傳的藍色座號卡
  useEffect(() => {
    const interval = setInterval(() => {
      requestSync()
    }, 30_000)
    return () => clearInterval(interval)
  }, [])

  // 批改訊息每 10 秒輪播
  useEffect(() => {
    if (!isGrading && !isDownloading) return
    const interval = setInterval(() => {
      setGradingMessage(getRandomGradingMessage())
    }, 10000)
    return () => clearInterval(interval)
  }, [isGrading, isDownloading])

  useEffect(() => {
    if (!isBusy) return
    const timer = window.setInterval(() => setNowTs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [isBusy])

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true)
    try {
      await syncAndReload()
    } finally {
      setIsRefreshing(false)
    }
  }, [syncAndReload])

  const handleCloseModal = () => {
    setSelectedSubmission(null)
    setEditableDetails([])
  }

  const handleManualGradeStudent = async (student: Student) => {
    if (manualGradingStudentId) return
    if (!window.confirm(`確定將 ${student.seatNumber} 號 ${student.name} 標記為已批改？\n此操作不會執行 AI 批改，僅更新狀態，且無法撤銷。`)) return
    setManualGradingStudentId(student.id)
    try {
      const response = await fetch('/api/data/manual-grade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ assignmentId, studentId: student.id })
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data?.error || '手動標記失敗')
      // 等同步把 server 端建立的 stub submission 拉回本地，UI 才能顯示「已完成批改」
      // 而不是 flicker 回「尚未繳交」。
      await syncAndReload()
    } catch (err) {
      setError(err instanceof Error ? err.message : '手動標記失敗')
    } finally {
      setManualGradingStudentId(null)
    }
  }

  const handleDeleteSubmission = async (submission: Submission, student: Student) => {
    const confirmMessage = `確定要刪除 ${student.seatNumber} 號 ${student.name} 的作業嗎？\n\n此操作無法復原。`

    if (!window.confirm(confirmMessage)) {
      return
    }

    try {
      // 從數據庫中刪除
      await db.answerExtractionCorrections.where('submissionId').equals(submission.id).delete()
      await db.submissions.delete(submission.id)

      // 加入刪除隊列以同步到雲端
      const { queueDelete } = await import('@/lib/sync-delete-queue')
      await queueDelete('submissions', submission.id)

      // 更新本地狀態
      setSubmissions((prev) => {
        const next = new Map(prev)
        next.delete(student.id)
        return next
      })
      setSelectedSubmissionIds((prev) => {
        if (!prev.has(submission.id)) return prev
        const next = new Set(prev)
        next.delete(submission.id)
        return next
      })

      // 如果刪除的是當前選中的作業，清除選中狀態
      if (selectedSubmission?.submission.id === submission.id) {
        setSelectedSubmission(null)
      }

      // 觸發同步
      requestSync()

      console.log(`✅ 已刪除 ${student.name} 的作業`)
    } catch (error) {
      console.error('刪除作業失敗:', error)
      alert('刪除作業失敗，請稍後再試')
    }
  }

  // checkbox 出現條件：本地有圖檔 OR 雲端有圖（status synced/graded、即 server 已存）
  // 之前只認本地、結果跨裝置 / 重新登入後 Blob/Base64 都沒、但 imageUrl 也沒填、
  // 即使 status=synced（伺服器有圖）也看不到 checkbox。
  // 實際批改流程 needPrepare 會自動下載、不用本地有圖也能批。
  const hasSubmissionImage = (submission: Submission) =>
    Boolean(submission.imageBase64) ||
    (submission.imageBlob?.size ?? 0) > 0 ||
    Boolean(submission.imageUrl) ||
    Boolean(submission.thumbUrl) ||
    submission.status === 'synced' ||
    submission.status === 'graded' ||
    submission.status === 'grading_failed'

  const toggleSubmissionSelection = (submissionId: string) => {
    setSelectedSubmissionIds((prev) => {
      const next = new Set(prev)
      if (next.has(submissionId)) {
        next.delete(submissionId)
      } else {
        next.add(submissionId)
      }
      return next
    })
  }

  const handleToggleSelectAll = () => {
    if (selectedSubmissionIds.size > 0) {
      // Has selections → clear all
      setSelectedSubmissionIds(new Set())
    } else {
      // No selections → select all with images
      const allWithImage = Array.from(submissions.values())
        .filter((s) => hasSubmissionImage(s))
        .map((s) => s.id)
      setSelectedSubmissionIds(new Set(allWithImage))
    }
  }

  // 2026-05-17: Phase A / Phase B 分離設計
  // - 重新截取（Phase A only）警告 modal：列出會清空哪幾份卡片的批改紀錄
  // - 批改作業 block modal: 需先截取 / 需先補答
  // - 批改作業 warning modal: 會覆寫已批改的分數
  const [recaptureConfirm, setRecaptureConfirm] = useState<{
    submissions: Submission[]
    cleared: Submission[]  // 會被清空批改紀錄的
  } | null>(null)
  const [gradeBlockModal, setGradeBlockModal] = useState<{
    reason: 'needs_extract' | 'needs_review'
    submissions: Submission[]
  } | null>(null)
  const [gradeOverwriteConfirm, setGradeOverwriteConfirm] = useState<{
    submissions: Submission[]
    overwriting: Submission[]  // 會被覆寫的（已批改 / 批改失敗）
  } | null>(null)

  // 2026-05-17: Phase A only 入口（重新截取按鈕）
  // 步驟：1. 檢查 in-scope 卡片狀態  2. 若會清資料、跳警告 modal  3. 否則直接走 handleGradeAll（暫時 fallback）
  // TODO PR2-5: 改成只跑 Phase A、不接 Phase B
  const handleRecaptureAll = async () => {
    if (recaptureButtonState.variant === 'disabled') return
    const { inScope, stageMap } = stageAggregates
    if (inScope.length === 0) {
      alert('沒有可截取的作業')
      return
    }
    if (recaptureButtonState.needsWarning) {
      const cleared = [
        ...stageMap.pending_review,
        ...stageMap.pending_grading,
        ...stageMap.graded,
        ...stageMap.phase_b_failed
      ]
      setRecaptureConfirm({ submissions: inScope, cleared })
      return
    }
    // 無清空風險、直接跑 Phase A only
    await executeRecaptureOnly(inScope)
  }

  // 2026-05-17: Phase A only 執行器
  // 給 selected/all 候選 submissions 各自跑 Phase A（OCR + classify + read + arbiter）、
  // 跑完後 server 端寫 phase_a_state（PR1）、不自動接 Phase B。
  // 對應「重新截取答案」按鈕觸發、適用「想重讀但不想直接批改」的場景。
  const executeRecaptureOnly = useCallback(async (candidates: Submission[]) => {
    if (candidates.length === 0) return
    if (!assignment?.answerKey) { alert('找不到答案卷'); return }
    if (inkSessionError) { alert(inkSessionError); return }
    if (!inkSessionReady) { alert('批改會話尚未準備完成、請稍候'); return }
    if (!isGeminiAvailable) { alert('Gemini 服務未設定'); return }

    setIsGrading(true)
    setGradingPhase('phase_a_running')
    setGradingMessage('AI 讀取答案中…')
    setError(null)
    setStopRequested(false)
    stopRequestedRef.current = false
    setGradingProgress({ current: 0, total: candidates.length })
    setGradingStartTime(Date.now())

    // 圖片準備（同 executeGradeOnlyCache）
    const needPrepare = candidates.filter((s) => !s.imageBlob)
    if (needPrepare.length > 0) {
      setIsDownloading(true)
      try {
        await runWithConcurrency(
          needPrepare, 5, 0,
          async (sub) => {
            if (stopRequestedRef.current) return null
            try {
              if (sub.imageBase64) sub.imageBlob = rebuildBlobFromBase64(sub.imageBase64)
              else sub.imageBlob = await downloadImageFromSupabase(sub.id)
            } catch (e) { console.error(`圖片準備失敗 ${sub.id}:`, e) }
            return null
          },
          () => {},
          stopRequestedRef
        )
      } finally {
        setIsDownloading(false)
      }
    }

    let completedCount = 0
    let successCount = 0
    let failCount = 0
    const failReasons: string[] = []
    const ANSWER_KEY = assignment.answerKey  // narrowed for closure

    await runWithConcurrency(
      candidates, 5, 2000,
      async (sub) => {
        if (stopRequestedRef.current) return null
        if (!sub.imageBlob) {
          const stu = students.find((s) => s.id === sub.studentId)
          const label = stu ? `${stu.seatNumber}號 ${stu.name}` : sub.id.slice(-8)
          failReasons.push(`${label}: 無圖片`)
          failCount++
          return null
        }
        try {
          const phaseAResult = await gradePhaseA(
            sub.imageBlob,
            ANSWER_KEY,
            sub.pageBreaks,
            assignment?.domain,
            assignment?.id,
            undefined,  // classifyCorrections — 重新截取不帶老師舊修正
            assignment?.answerSheetMode,
            sub.id,
            sub.source
          )
          if (phaseAResult.pipelineFailure) {
            const stu = students.find((s) => s.id === sub.studentId)
            const label = stu ? `${stu.seatNumber}號 ${stu.name}` : sub.id.slice(-8)
            failReasons.push(`${label}: ${phaseAResult.pipelineFailure.userMessage}`)
            failCount++
            // 寫入失敗 status、phaseAState 由 server 端 buildFailureReturn 寫入（PR1）
            const failedGradingResult = { pipelineFailure: phaseAResult.pipelineFailure } as unknown as Submission['gradingResult']
            const failedAtMs = Date.now()
            await db.submissions.update(sub.id, {
              status: 'grading_failed',
              gradingResult: failedGradingResult,
              updatedAt: failedAtMs
            })
            setSubmissions((prev) => {
              const next = new Map(prev)
              const cur = Array.from(prev.values()).find((s) => s.id === sub.id)
              if (cur) next.set(cur.studentId, {
                ...cur,
                status: 'grading_failed',
                gradingResult: failedGradingResult,
                updatedAt: failedAtMs
              })
              return next
            })
            return null
          }
          // Phase A 成功、server 已寫 phase_a_state、local 等 sync 拉回
          // 同時把 questionResults 暫存到 local gradingResult.details、讓 detail modal 立刻能看
          const detailsFromPhaseA = phaseAResult.questionResults.map((qr) => ({
            questionId: qr.questionId,
            questionType: qr.questionType,
            studentAnswer: qr.arbiterResult?.finalAnswer || qr.readAnswer1?.studentAnswer || '',
            isCorrect: false,
            score: 0,
            maxScore: 0,
            reason: '',
            readAnswer1: qr.readAnswer1,
            readAnswer2: qr.readAnswer2,
            arbiterResult: qr.arbiterResult,
            consistencyStatus: qr.consistencyStatus,
            answerBbox: qr.answerBbox,
            answerCropImageUrl: qr.answerCropImageUrl,
          }))
          const phaseAGradingResult = { details: detailsFromPhaseA, totalScore: 0 } as unknown as Submission['gradingResult']
          const updatedAtMs = Date.now()
          await db.submissions.update(sub.id, {
            status: 'synced',  // 待批改 / 待複核（細狀態由 deriveCardStage 從 phase_a_state 算）
            gradingResult: phaseAGradingResult,
            score: undefined,
            aiScore: undefined,
            gradedAt: undefined,
            updatedAt: updatedAtMs
          })
          // 同步更新 React state、detail modal 立刻看到新資料、不用等 sync
          setSubmissions((prev) => {
            const next = new Map(prev)
            const cur = Array.from(prev.values()).find((s) => s.id === sub.id)
            if (cur) next.set(cur.studentId, {
              ...cur,
              status: 'synced',
              gradingResult: phaseAGradingResult,
              score: undefined,
              aiScore: undefined,
              gradedAt: undefined,
              updatedAt: updatedAtMs
            })
            return next
          })
          successCount++
          return phaseAResult
        } catch (err) {
          const stu = students.find((s) => s.id === sub.studentId)
          const label = stu ? `${stu.seatNumber}號 ${stu.name}` : sub.id.slice(-8)
          const msg = err instanceof Error ? err.message : String(err)
          failReasons.push(`${label}: ${msg}`)
          failCount++
          console.error(`[recaptureOnly] failed for ${sub.id}:`, err)
          return null
        }
      },
      (_i, _result) => {
        completedCount++
        setGradingProgress({ current: completedCount, total: candidates.length })
      },
      stopRequestedRef
    )

    setIsGrading(false)
    setGradingPhase('idle')
    setCurrentGradingStudent('')
    requestSync()  // 拉 server 寫的 phase_a_state 回來、卡片才會顯示 待複核/待批改
    setGradeResultNotice({
      stopped: stopRequestedRef.current,
      successCount,
      failCount,
      totalCount: candidates.length,
      failReasons: failReasons.slice(0, 10),
      failedEntries: [],
    })
  }, [
    inkSessionError, inkSessionReady, isGeminiAvailable, assignment, students
  ])

  // 2026-05-17: Phase B only with fromCache 執行器
  // 給 selected/all 候選 submissions 各自跑 Phase B（用 server 端 cached phase_a_state）、
  // 不重跑 Phase A（省 4 min）。對應「批改作業」按鈕觸發。
  const executeGradeOnlyCache = useCallback(async (candidates: Submission[]) => {
    if (candidates.length === 0) return
    if (inkSessionError) { alert(inkSessionError); return }
    if (!inkSessionReady) { alert('批改會話尚未準備完成、請稍候'); return }
    if (!isGeminiAvailable) { alert('Gemini 服務未設定'); return }

    setIsGrading(true)
    setGradingPhase('phase_b_running')
    setGradingMessage('AI 批改評分中（用快取的讀取結果）…')
    setError(null)
    setStopRequested(false)
    stopRequestedRef.current = false
    setPhaseBTotalCount(candidates.length)
    setPhaseBScoredCount(0)
    setGradingStartTime(Date.now())

    // 圖片準備（從 cloud 載 / 從 base64 重建）
    const needPrepare = candidates.filter((s) => !s.imageBlob)
    if (needPrepare.length > 0) {
      setIsDownloading(true)
      try {
        await runWithConcurrency(
          needPrepare, 5, 0,
          async (sub) => {
            if (stopRequestedRef.current) return null
            try {
              if (sub.imageBase64) {
                sub.imageBlob = rebuildBlobFromBase64(sub.imageBase64)
              } else {
                sub.imageBlob = await downloadImageFromSupabase(sub.id)
              }
            } catch (e) {
              console.error(`圖片準備失敗 ${sub.id}:`, e)
            }
            return null
          },
          () => {},
          stopRequestedRef
        )
      } finally {
        setIsDownloading(false)
      }
    }

    const phaseBClassroom = assignment?.classroomId
      ? await db.classrooms.get(assignment.classroomId)
      : null
    const gradeBand: 'k9' | 'high' = (phaseBClassroom?.grade ?? 0) >= 10 ? 'high' : 'k9'

    let completedCount = 0
    let successCount = 0
    let failCount = 0
    const failReasons: string[] = []

    await runWithConcurrency(
      candidates, 5, 1000,
      async (sub) => {
        if (stopRequestedRef.current) return null
        if (!sub.imageBlob) {
          const stu = students.find((s) => s.id === sub.studentId)
          const label = stu ? `${stu.seatNumber}號 ${stu.name}` : sub.id.slice(-8)
          failReasons.push(`${label}: 無圖片`)
          failCount++
          return null
        }
        try {
          const result = await gradePhaseBFromCache(
            sub.imageBlob,
            sub.id,
            assignment?.id,
            assignment?.domain,
            assignment?.answerSheetMode,
            gradeBand,
            sub.finalAnswers as FinalAnswer[] | undefined
          )
          const totalScore = result.totalScore ?? 0
          const gradedAtMs = Date.now()
          await db.submissions.update(sub.id, {
            status: 'graded',
            score: totalScore,
            aiScore: totalScore,
            scoreSource: 'ai',
            gradingResult: result,
            gradedAt: gradedAtMs,
            updatedAt: gradedAtMs,
          })
          // 同步更新 React state、detail modal 立刻看到新分數
          setSubmissions((prev) => {
            const next = new Map(prev)
            const cur = Array.from(prev.values()).find((s) => s.id === sub.id)
            if (cur) next.set(cur.studentId, {
              ...cur,
              status: 'graded',
              score: totalScore,
              aiScore: totalScore,
              scoreSource: 'ai',
              gradingResult: result,
              gradedAt: gradedAtMs,
              updatedAt: gradedAtMs
            })
            return next
          })
          fetch('/api/data/save-grading', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              submissions: [{
                id: sub.id, score: totalScore, aiScore: totalScore, scoreSource: 'ai',
                gradingResult: result, gradedAt: gradedAtMs
              }]
            })
          }).catch(() => {/* non-fatal */})
          successCount++
          return result
        } catch (err) {
          const stu = students.find((s) => s.id === sub.studentId)
          const label = stu ? `${stu.seatNumber}號 ${stu.name}` : sub.id.slice(-8)
          const msg = err instanceof Error ? err.message : String(err)
          failReasons.push(`${label}: ${msg}`)
          failCount++
          console.error(`[gradeOnlyCache] failed for ${sub.id}:`, err)
          return null
        }
      },
      (_i, _result) => {
        completedCount++
        setPhaseBScoredCount(completedCount)
      },
      stopRequestedRef
    )

    setIsGrading(false)
    setGradingPhase('idle')
    setCurrentGradingStudent('')
    requestSync()  // 把 server 端寫的 score / gradingResult 拉回 local
    setGradeResultNotice({
      stopped: stopRequestedRef.current,
      successCount,
      failCount,
      totalCount: candidates.length,
      failReasons: failReasons.slice(0, 10),
      failedEntries: [],
    })
  }, [
    inkSessionError, inkSessionReady, isGeminiAvailable, assignment, students
  ])

  // 2026-05-17: Phase B only 入口（批改作業按鈕）
  // 步驟：1. 檢查 in-scope 卡片狀態  2. 若需先截取或補答、block modal  3. 若會覆寫、warning modal  4. 否則直接跑
  const handleGradeOnly = async () => {
    if (gradeButtonState.variant === 'disabled') return
    const { inScope, stageMap } = stageAggregates
    if (inScope.length === 0) {
      alert('沒有可批改的作業')
      return
    }
    if (gradeButtonState.block === 'needs_extract') {
      setGradeBlockModal({
        reason: 'needs_extract',
        submissions: [...stageMap.not_extracted, ...stageMap.phase_a_failed]
      })
      return
    }
    if (gradeButtonState.block === 'needs_review') {
      setGradeBlockModal({ reason: 'needs_review', submissions: stageMap.pending_review })
      return
    }
    if (gradeButtonState.needsWarning) {
      setGradeOverwriteConfirm({
        submissions: inScope,
        overwriting: [...stageMap.graded, ...stageMap.phase_b_failed]
      })
      return
    }
    // 無風險、直接跑 Phase B only (fromCache)
    await executeGradeOnlyCache(inScope)
  }

  // 2026-05-17: handleGradeAll 已被 handleRecaptureAll + handleGradeOnly 取代、保留作 legacy fallback。
  // 暫不從 UI 移除（showGradeConfirm modal 仍引用 executeGrading）、避免大改 delete。
  // @ts-expect-error TS6133: 暫時 unused、PR4 polish 時清掉
  const _handleGradeAll = async () => {
    if (inkSessionError) {
      alert(inkSessionError)
      return
    }
    if (!inkSessionReady) {
      alert('批改會話尚未準備完成，請稍候')
      return
    }
    if (!isGeminiAvailable) {
      alert('Gemini 服務未設定')
      return
    }

    const allSubs = Array.from(submissions.values()).filter((s) => hasSubmissionImage(s))
    const hasManualSelection = selectedSubmissionIds.size > 0
    const selectedSubs = hasManualSelection
      ? allSubs.filter((s) => selectedSubmissionIds.has(s.id))
      : []
    const candidates = hasManualSelection ? selectedSubs : allSubs

    if (candidates.length === 0) {
      alert(hasManualSelection ? '勾選的作業沒有可批改影像' : '沒有可批改的作業')
      return
    }

    const regrade = candidates.some((s) => s.status === 'graded')

    // 預先設好 resume：守門 modal「全部退回訂正」成功後直接進確認對話框、
    // 不用老師再回去按一次「批改」。
    pendingGradeResumeRef.current = () => {
      setGradeCandidates(candidates)
      setIsRegrade(regrade)
      setShowGradeConfirm(true)
    }
    const canProceed = await ensureNoCorrectionConflict(candidates)
    if (!canProceed) {
      // modal 已開、ref 等退回後恢復
      return
    }
    pendingGradeResumeRef.current = null

    // 🆕 顯示確認對話框
    setGradeCandidates(candidates)
    setIsRegrade(regrade)
    setShowGradeConfirm(true)
  }

  // 🆕 確認後執行批改
  const executeGrading = async () => {
    setShowGradeConfirm(false)
    const candidates = gradeCandidates

    const canProceed = await ensureNoCorrectionConflict(candidates)
    if (!canProceed) {
      return
    }

    setIsGrading(true)
    setGradeResultNotice(null)
    setGradingMessage(getRandomGradingMessage())
    setError(null)
    setStopRequested(false)
    stopRequestedRef.current = false
    setGradingStartTime(Date.now())
    setCompletedReviewCount(0)

    try {
      // 處理需要準備圖片的作業（沒有 Blob 但可能有 Base64 或需要下載）
      // 🔧 重要：強制為所有有 Base64 的作業重新重建 Blob，確保修復損壞的 Base64
      const needRebuild = candidates.filter((s) => s.imageBase64)
      const needPrepare = candidates.filter((s) => !s.imageBlob && !s.imageBase64)
      const prepareErrors: string[] = []

      console.log(`📦 批改前準備: ${needRebuild.length} 份需重建 Blob, ${needPrepare.length} 份需下載`)

      if (needRebuild.length > 0 || needPrepare.length > 0) {
        setIsDownloading(true)
        setCurrentGradingStudent('準備圖片中…')

        const totalTasks = needRebuild.length + needPrepare.length
        let currentTask = 0

        // 先重建所有有 Base64 的 Blob（修復損壞）
        for (const sub of needRebuild) {
          // 🆕 檢查停止請求
          if (stopRequestedRef.current) {
            console.log('🛑 用戶在下載階段請求停止')
            break
          }

          currentTask++
          setDownloadProgress({ current: currentTask, total: totalTasks })
          
          const student = students.find(s => s.id === sub.studentId)
          setCurrentGradingStudent(student ? `${student.seatNumber}號 ${student.name}` : '')

          try {
            console.log(`🔧 從 Base64 重建 Blob: ${sub.id}`)
            sub.imageBlob = rebuildBlobFromBase64(sub.imageBase64!)
            console.log(`✅ 從 Base64 重建成功: size=${sub.imageBlob.size}`)
          } catch (err) {
            console.error('重建 Blob 失敗', err)
            const studentInfo = student ? `${student.seatNumber}號 ${student.name}` : `ID: ${sub.studentId}`
            prepareErrors.push(studentInfo)
          }
        }

        // 再下載沒有 Base64 也沒有 Blob 的作業（並行，最多 5 份同時下載）
        let downloadedCount = 0
        await runWithConcurrency(
          needPrepare,
          5,
          0,
          async (sub) => {
            if (stopRequestedRef.current) return null
            if (sub.status !== 'synced' && sub.status !== 'graded') {
              throw new Error('無圖片數據（無 Blob、Base64 或雲端 URL）')
            }
            console.log(`📥 從雲端下載: ${sub.id}`)
            const blob = await downloadImageFromSupabase(sub.id)
            const base64 = await blobToBase64(blob)
            await updateSubmissionWithImages(sub.id, {}, blob, base64)
            sub.imageBlob = blob
            sub.imageBase64 = base64
            console.log(`✅ 下載成功: size=${blob.size}`)
            return blob
          },
          (_index, _result, error) => {
            downloadedCount++
            setDownloadProgress({ current: needRebuild.length + downloadedCount, total: totalTasks })
            const sub = needPrepare[_index]
            const student = students.find(s => s.id === sub.studentId)
            if (error) {
              console.error('準備圖片失敗', error)
              const studentInfo = student ? `${student.seatNumber}號 ${student.name}` : `ID: ${sub.studentId}`
              prepareErrors.push(studentInfo)
            } else {
              setCurrentGradingStudent(student ? `${student.seatNumber}號 ${student.name}` : '')
            }
          },
          stopRequestedRef
        )

        setIsDownloading(false)

        // 🆕 如果用戶停止，直接結束
        if (stopRequestedRef.current) {
          setIsGrading(false)
          setStopRequested(false)
          setCurrentGradingStudent('')
          setGradeResultNotice({
            stopped: true,
            successCount: 0,
            failCount: 0,
            totalCount: candidates.length,
            failReasons: [],
            failedEntries: [],
          })
          return
        }

        // 如果有準備失敗，詢問是否繼續
        if (prepareErrors.length > 0) {
          const errorMsg = `以下 ${prepareErrors.length} 份作業準備失敗，將無法批改：\n${prepareErrors.join('\n')}\n\n是否繼續批改其他作業？`
          if (!window.confirm(errorMsg)) {
            setIsGrading(false)
            return
          }
        }
      }

      const toGrade = candidates.filter((s) => s.imageBlob)
      if (toGrade.length === 0) {
        alert('沒有可批改的影像')
        setIsGrading(false)
        return
      }

      console.log(`✅ 準備 Phase A，共 ${toGrade.length} 份作業`)
      setGradingProgress({ current: 0, total: toGrade.length })
      setGradingMessage('定位答案中…')
      setGradingPhase('phase_a_running')
      setPhaseANeedsReviewCount(0)

      // 嘗試從 template 解析 answerKey（若 assignment 沒有直接帶）
      if (!assignment?.answerKey && assignment?.answerKeyTemplateId) {
        const template = await db.answerKeyTemplates.get(assignment.answerKeyTemplateId)
        if (template?.answerKey) {
          assignment.answerKey = template.answerKey
        }
      }
      if (!assignment?.answerKey) {
        alert('缺少答案卷，無法批改')
        setIsGrading(false)
        return
      }

      // ── Phase A：每位學生 gradePhaseA 一次（含 OCR-assist classify + read + arbiter）──
      // 統一所有 source 走同一條 path、不再做跨學生中位數校正
      // OCR-assist 已直接消除 classify drift、median 是它上線前的補救手段、現在用不到
      setGradingMessage('讀取答案中…')
      const entries: BatchPhaseAEntry[] = []
      // Phase A pipeline 失敗（classify/read/arbiter retry 後仍 FAIL）— 不進 entries、不進 Phase B
      const phaseAFailures: Array<{ submissionId: string; studentId: string; failure: PipelineFailure }> = []
      let completedA = 0

      await runWithConcurrency(
        toGrade,
        5,  // 2026-05-17: 3→5、Vercel Pro 1000 concurrent 不擋、瓶頸看 Vertex quota 跟 OCR server
        2000, // 每個學生錯開 2 秒，讓前一個學生的 Gemini 請求先被接收
        async (sub, _idx) => {
          if (stopRequestedRef.current) return null
          console.log(`📄 [PhaseA] student=${sub.studentId}`)
          const phaseAResult = await gradePhaseA(
            sub.imageBlob!,
            assignment.answerKey!,
            sub.pageBreaks,
            assignment.domain,
            assignment.id,
            undefined,
            assignment.answerSheetMode,
            sub.id,
            sub.source
          )
          return { sub, phaseAResult }
        },
        (i, result, err) => {
          completedA++
          setGradingProgress({ current: completedA, total: toGrade.length })
          if (stopRequestedRef.current || !result) {
            if (err) console.error(`Phase A failed for ${toGrade[i].id}:`, err)
            return
          }
          const { sub, phaseAResult } = result

          // ── Phase A 失敗：classify/read/arbiter retry 後仍 FAIL ──
          // 不進 entries、不送 Phase B、寫 grading_failed 到 DB、留訊息給最終 dialog
          if (phaseAResult.pipelineFailure) {
            const failure = phaseAResult.pipelineFailure
            phaseAFailures.push({ submissionId: sub.id, studentId: sub.studentId, failure })
            const failureGradingResult = { pipelineFailure: failure } as unknown as import('@/lib/db').GradingResult
            void db.submissions.update(sub.id, {
              status: 'grading_failed',
              gradingResult: failureGradingResult,
              updatedAt: Date.now(),
            }).catch(() => {})
            fetch(buildApiUrl('/api/data/save-grading'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({
                submissions: [{ id: sub.id, status: 'grading_failed', gradingResult: { pipelineFailure: failure } }],
              }),
            }).catch(() => {})
            console.warn(`[PhaseA] ${sub.id} FAILED at ${failure.stage}: ${failure.reasonCode}`, failure.technical)
            return
          }

          const student = students.find((s) => s.id === sub.studentId)
          if (student) setCurrentGradingStudent(`${student.seatNumber}號 ${student.name}`)
          // 即時統計需審查「題數」
          const reviewQuestionCount = phaseAResult.questionResults.filter(
            (qr) => qr.arbiterResult ? qr.arbiterResult.arbiterStatus === 'needs_review' : qr.consistencyStatus !== 'stable'
          ).length
          if (reviewQuestionCount > 0) setPhaseANeedsReviewCount((prev) => prev + reviewQuestionCount)
          setPhaseATotalQuestionCount((prev) => prev + phaseAResult.questionResults.length)
          const decisions = new Map<string, ConsistencyDecision>()
          for (const qr of phaseAResult.questionResults) {
            const arbiter = qr.arbiterResult
            if (arbiter && arbiter.arbiterStatus !== 'needs_review') {
              // 3-AI arch: auto-confirm arbitrated questions
              const source = 'ai_arbiter'  // 一致性判官：一律用 AI1 答案
              // calculation/word_problem：用完整步驟文字（readAnswer1），不用 arbiter 的短答案
              // 否則 accessor 只看到最終答案，會誤判「未列出計算算式」
              const isCalcType = qr.questionType === 'calculation' || qr.questionType === 'word_problem'
              const fullAnswer = isCalcType
                ? qr.readAnswer1.studentAnswer
                : (arbiter.finalAnswer ?? qr.readAnswer1.studentAnswer)
              decisions.set(qr.questionId, {
                questionId: qr.questionId,
                source,
                finalAnswer: fullAnswer,
                confirmed: true,
              })
            } else if (!arbiter && qr.consistencyStatus === 'stable') {
              // Legacy fallback: no arbiterResult → use consistencyStatus
              decisions.set(qr.questionId, {
                questionId: qr.questionId,
                source: 'ai_read1',
                finalAnswer: qr.readAnswer1.studentAnswer,
                confirmed: true,
              })
            }
          }
          entries.push({
            submissionId: sub.id,
            studentId: sub.studentId,
            phaseAResult,
            decisions,
            imageBlob: sub.imageBlob!,
          })
        },
        stopRequestedRef
      )

      if (stopRequestedRef.current) {
        setGradingPhase('idle')
        setBatchPhaseAEntries([])
        setGradeResultNotice({
          stopped: true,
          successCount: 0,
          failCount: 0,
          totalCount: toGrade.length,
          failReasons: [],
          failedEntries: [],
        })
      } else {
        // ── 品質總檢查（所有作業 Phase A 完成後，內部執行不外顯） ──────────────

        const CONSECUTIVE_BLANK_THRESHOLD = 3   // ≥3 題連續空白 → 重跑
        const MIN_SUBMISSIONS_FOR_TYPE = 3       // 至少 N 份才能建立主流類型
        const DOMINANT_TYPE_RATIO = 0.6          // ≥60% 同意才算確立主流

        const anomalousIndices = new Set<number>()
        // 收集每份被標記作業的詳細原因，結束後 POST 到後端
        const flagDetails = new Map<number, {
          conditions: string[]
          consecutiveBlankMax?: number
          abcdMismatchDetails?: Array<{ questionId: string; got: string }>
        }>()
        const getFlag = (i: number) => {
          if (!flagDetails.has(i)) flagDetails.set(i, { conditions: [] })
          return flagDetails.get(i)!
        }

        // 條件一：連續空白/無法辨識 ≥ CONSECUTIVE_BLANK_THRESHOLD 題
        // 只計算「AI1 blank 但 AI2 不是 blank」的不一致空白（可能 bbox 問題）
        // 兩邊都 blank 的跳過（學生真的沒寫，白卷不需要 retry）
        for (let i = 0; i < entries.length; i++) {
          const results = entries[i].phaseAResult.questionResults
          let consecutive = 0
          let maxConsecutive = 0
          for (const qr of results) {
            const s1 = qr.readAnswer1?.status
            const s2 = qr.readAnswer2?.status
            const bothBlank = (s1 === 'blank' || s1 === 'unreadable') && (s2 === 'blank' || s2 === 'unreadable')
            if ((s1 === 'blank' || s1 === 'unreadable') && !bothBlank) {
              consecutive++
              if (consecutive > maxConsecutive) maxConsecutive = consecutive
              if (consecutive >= CONSECUTIVE_BLANK_THRESHOLD) {
                anomalousIndices.add(i)
                const f = getFlag(i)
                f.conditions.push('consecutive_blanks')
                f.consecutiveBlankMax = maxConsecutive
                break
              }
            } else {
              consecutive = 0
            }
          }
        }

        // 條件二（已移除）：fill_blank 答案類型主流不符
        // AI1/AI2 角色分化 + AI3 一致性判官已能攔截此類問題，不再需要跨作業比對重跑

        // 條件三：是非題主流（O/X）但個別作業被讀成 ABCD
        // 若某題 ≥60% 非空白答案是 O/X 類型，標記任何被讀成 A/B/C/D 的作業
        if (entries.length >= MIN_SUBMISSIONS_FOR_TYPE) {
          const isTrueFalseAnswer = (answer: string) => /^[OoXx○×✓✗✕⭕❌是非對錯]$/.test(answer.trim())
          const isABCDAnswer = (answer: string) => /^[A-Da-d]$/.test(answer.trim())

          // 第一輪：統計每題是非題答案佔比
          const tfCountsByQuestion = new Map<string, { tf: number; total: number }>()
          for (const entry of entries) {
            for (const qr of entry.phaseAResult.questionResults) {
              const ans = qr.readAnswer1?.studentAnswer ?? ''
              const status = qr.readAnswer1?.status ?? ''
              if (status === 'blank' || status === 'unreadable' || !ans.trim()) continue
              if (!tfCountsByQuestion.has(qr.questionId)) {
                tfCountsByQuestion.set(qr.questionId, { tf: 0, total: 0 })
              }
              const c = tfCountsByQuestion.get(qr.questionId)!
              c.total++
              if (isTrueFalseAnswer(ans)) c.tf++
            }
          }

          // 確立是非題主流（≥60%）
          const trueFalseQuestions = new Set<string>()
          for (const [qId, { tf, total }] of tfCountsByQuestion) {
            if (total >= MIN_SUBMISSIONS_FOR_TYPE && tf / total >= DOMINANT_TYPE_RATIO) {
              trueFalseQuestions.add(qId)
            }
          }

          // 第二輪：找出是非題被讀成 ABCD 的作業
          if (trueFalseQuestions.size > 0) {
            for (let i = 0; i < entries.length; i++) {
              if (anomalousIndices.has(i)) continue
              const abcdMismatches: Array<{ questionId: string; got: string }> = []
              for (const qr of entries[i].phaseAResult.questionResults) {
                if (!trueFalseQuestions.has(qr.questionId)) continue
                const ans = qr.readAnswer1?.studentAnswer ?? ''
                if (isABCDAnswer(ans)) {
                  abcdMismatches.push({ questionId: qr.questionId, got: ans.trim() })
                }
              }
              if (abcdMismatches.length >= 1) {
                anomalousIndices.add(i)
                const f = getFlag(i)
                f.conditions.push('trueFalse_abcd_mismatch')
                f.abcdMismatchDetails = abcdMismatches
              }
            }
          }
        }

        // 條件四：fill_blank / multi_fill 鄰題答案交叉比對（bbox 偏移檢測）
        // 如果學生某題的答案 ≠ 該題標準答案，但 = 隔壁同型題的標準答案 → bbox 可能偏移
        if (assignment?.answerKey?.questions) {
          const akQuestions = assignment.answerKey.questions
          const isFillType = (q: typeof akQuestions[0]) =>
            (q.questionCategory === 'fill_blank' || q.questionCategory === 'multi_fill') && q.answer
          // 建立填空題（fill_blank + multi_fill）的有序清單（按 questionId）和標準答案 map
          const fillBlankIds = akQuestions
            .filter(isFillType)
            .map((q) => q.id)
            .sort()
          const refAnswerById = new Map(
            akQuestions
              .filter(isFillType)
              .map((q) => [q.id, String(q.answer).trim()])
          )

          // 數值等值比對（簡易版）
          const numEq = (a: string, b: string): boolean => {
            if (!a || !b) return false
            const norm = (s: string) => s.replace(/\s+/g, '').replace(/[，]/g, ',').replace(/[−–—]/g, '-').toLowerCase()
            if (norm(a) === norm(b)) return true
            const toNum = (s: string): number | null => {
              const frac = s.match(/^(-?\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/)
              if (frac) { const d = parseFloat(frac[2]); return d !== 0 ? parseFloat(frac[1]) / d : null }
              if (s.endsWith('%')) { const v = parseFloat(s); return isFinite(v) ? v / 100 : null }
              const v = parseFloat(s); return isFinite(v) ? v : null
            }
            const na = toNum(norm(a)), nb = toNum(norm(b))
            return na !== null && nb !== null && Math.abs(na - nb) < 1e-9
          }

          for (let i = 0; i < entries.length; i++) {
            if (anomalousIndices.has(i)) continue
            const neighborMismatches: Array<{ questionId: string; studentAnswer: string; neighborId: string; neighborRef: string }> = []

            for (const qr of entries[i].phaseAResult.questionResults) {
              if (qr.questionType !== 'fill_blank' && qr.questionType !== 'multi_fill') continue
              const stuAns = qr.readAnswer1?.studentAnswer ?? ''
              if (!stuAns || qr.readAnswer1?.status !== 'read') continue
              const ref = refAnswerById.get(qr.questionId)
              if (!ref) continue
              // 如果答對了（含等值），不檢查
              if (numEq(stuAns, ref)) continue

              // 找相鄰的填空題（fill_blank / multi_fill）
              const idx = fillBlankIds.indexOf(qr.questionId)
              if (idx < 0) continue
              const neighbors = [fillBlankIds[idx - 1], fillBlankIds[idx + 1]].filter(Boolean)
              for (const nId of neighbors) {
                const nRef = refAnswerById.get(nId!)
                if (nRef && numEq(stuAns, nRef)) {
                  neighborMismatches.push({
                    questionId: qr.questionId,
                    studentAnswer: stuAns,
                    neighborId: nId!,
                    neighborRef: nRef,
                  })
                  break
                }
              }
            }

            if (neighborMismatches.length >= 1) {
              anomalousIndices.add(i)
              const f = getFlag(i)
              f.conditions.push('fill_blank_neighbor_match')
              ;(f as any).neighborMatchDetails = neighborMismatches
            }
          }
        }

        // 品質檢查結果 POST 到後端（Vercel log）
        if (anomalousIndices.size > 0 || entries.length > 0) {
          const flags = Array.from(flagDetails.entries()).map(([i, detail]) => ({
            submissionId: entries[i].submissionId,
            studentId: entries[i].studentId,
            conditions: detail.conditions,
            detail: {
              consecutiveBlankMax: detail.consecutiveBlankMax,
              abcdMismatchDetails: detail.abcdMismatchDetails,
              neighborMatchDetails: (detail as any).neighborMatchDetails,
            }
          }))
          fetch('/api/data/quality-check-log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              assignmentId: assignment.id,
              totalSubmissions: entries.length,
              flaggedCount: anomalousIndices.size,
              flags,
            })
          }).catch(() => {/* log 失敗不影響主流程 */})
        }

        // 重跑品質不通過的作業（最多一次）
        if (anomalousIndices.size > 0) {
          setGradingMessage('品質檢測中…')
          const indicesToRetry = Array.from(anomalousIndices)
          await runWithConcurrency(
            indicesToRetry,
            3,  // Phase Read 併發限制（同 Phase Read 主流程）
            2000,
            async (idx) => {
              if (stopRequestedRef.current) return null
              const entry = entries[idx]
              const sub = toGrade.find((s) => s.id === entry.submissionId)
              if (!sub?.imageBlob) return null
              // 組裝 classify 修正提示（各品質檢查條件 → 對應的提醒類型）
              const flag = flagDetails.get(idx)
              const corrections: Array<{ questionId: string; type: 'neighbor_match' | 'consecutive_blank'; neighborId?: string }> = []
              if (flag) {
                // fill_blank_neighbor_match → neighbor_match
                const neighborDetails = (flag as any).neighborMatchDetails as Array<{ questionId: string; neighborId: string }> | undefined
                if (neighborDetails) {
                  for (const m of neighborDetails) {
                    corrections.push({ questionId: m.questionId, type: 'neighbor_match', neighborId: m.neighborId })
                  }
                }
                // consecutive_blanks → consecutive_blank（標記連續空白的題目）
                if (flag.conditions.includes('consecutive_blanks')) {
                  for (const qr of entries[idx].phaseAResult.questionResults) {
                    if (qr.readAnswer1?.status === 'blank' || qr.readAnswer1?.status === 'unreadable') {
                      corrections.push({ questionId: qr.questionId, type: 'consecutive_blank' })
                    }
                  }
                }
                // answer_type_mismatch 已移除（AI3 一致性判官攔截）
              }
              // 品質重試：重跑完整 gradePhaseA（含 OCR-assist classify）、帶 corrections 提示
              const phaseAResult = await gradePhaseA(sub.imageBlob, assignment.answerKey!, sub.pageBreaks, assignment.domain, assignment.id, corrections, assignment.answerSheetMode, sub.id, sub.source)
              return { idx, phaseAResult }
            },
            (_i, result, err) => {
              if (!result) { if (err) console.error('[QualityCheck] retry failed:', err); return }
              const { idx, phaseAResult } = result

              // 品質重跑時也可能 pipeline FAIL（罕見，但要處理）
              // 注意：不能 splice entries（會打亂 indicesToRetry 的 idx）；改成保留 phaseAResult 含 pipelineFailure、
              // 之後組 validEntries 時再 filter 掉
              if (phaseAResult.pipelineFailure) {
                const failedEntry = entries[idx]
                const failure = phaseAResult.pipelineFailure
                phaseAFailures.push({ submissionId: failedEntry.submissionId, studentId: failedEntry.studentId, failure })
                const failureGradingResult = { pipelineFailure: failure } as unknown as import('@/lib/db').GradingResult
                void db.submissions.update(failedEntry.submissionId, {
                  status: 'grading_failed',
                  gradingResult: failureGradingResult,
                  updatedAt: Date.now(),
                }).catch(() => {})
                fetch(buildApiUrl('/api/data/save-grading'), {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  credentials: 'include',
                  body: JSON.stringify({
                    submissions: [{ id: failedEntry.submissionId, status: 'grading_failed', gradingResult: { pipelineFailure: failure } }],
                  }),
                }).catch(() => {})
                // 標記這個 entry 為失敗（保留 phaseAResult，含 pipelineFailure），之後 filter
                entries[idx] = { ...failedEntry, phaseAResult }
                console.warn(`[PhaseA-retry] ${failedEntry.submissionId} FAILED at ${failure.stage}: ${failure.reasonCode}`)
                return
              }

              const decisions = new Map<string, ConsistencyDecision>()
              for (const qr of phaseAResult.questionResults) {
                const arbiter = qr.arbiterResult
                if (arbiter && arbiter.arbiterStatus !== 'needs_review') {
                  const source = 'ai_arbiter'  // 一致性判官：一律用 AI1 答案
                  const isCalcType = qr.questionType === 'calculation' || qr.questionType === 'word_problem'
                  const fullAnswer = isCalcType ? qr.readAnswer1.studentAnswer : (arbiter.finalAnswer ?? qr.readAnswer1.studentAnswer)
                  decisions.set(qr.questionId, { questionId: qr.questionId, source, finalAnswer: fullAnswer, confirmed: true })
                } else if (!arbiter && qr.consistencyStatus === 'stable') {
                  decisions.set(qr.questionId, { questionId: qr.questionId, source: 'ai_read1', finalAnswer: qr.readAnswer1.studentAnswer, confirmed: true })
                }
              }
              entries[idx] = { ...entries[idx], phaseAResult, decisions }
            },
            stopRequestedRef
          )
        }

        // 品質檢查後的二次問題偵測：如果重跑後仍有大量未讀取的題目，標記為失敗
        // 但需要區分「學生真的沒寫（白卷）」和「bbox 定位問題導致的假空白」：
        // - AI1 和 AI2 都讀到 blank → 學生真的沒寫，應該正常進入 Phase B 得 0 分
        // - AI1 讀到內容但 AI2 blank（或反過來）→ 不一致，可能是定位問題
        const phaseAQualityFails: Array<{ submissionId: string; studentLabel: string; unreadCount: number }> = []
        for (const entry of entries) {
          // 只計算「不一致的空白」（一邊讀到東西，另一邊空白 → bbox 問題）
          // 兩邊都 blank 的不算（真的沒寫）
          const suspiciousBlanks = entry.phaseAResult.questionResults.filter((qr) => {
            const s1 = qr.readAnswer1?.status
            const s2 = qr.readAnswer2?.status
            // 兩邊都 blank → 真的沒寫，不算異常
            if ((s1 === 'blank' || s1 === 'unreadable') && (s2 === 'blank' || s2 === 'unreadable')) return false
            // 只有一邊 blank/unreadable → 可能 bbox 問題
            return s1 === 'blank' || s1 === 'unreadable'
          })
          const totalQuestions = entry.phaseAResult.questionResults.length
          // 超過 30% 的題目出現「不一致空白」→ 可能是 bbox 定位問題
          if (totalQuestions > 0 && suspiciousBlanks.length > totalQuestions * 0.3) {
            const student = students.find((s) => s.id === entry.studentId)
            const studentLabel = student ? `${student.seatNumber}號 ${student.name}` : entry.studentId
            phaseAQualityFails.push({ submissionId: entry.submissionId, studentLabel, unreadCount: suspiciousBlanks.length })
          }
        }
        setPostRetryWarnings(phaseAQualityFails)

        // 從批次中移除品質失敗 + Phase A pipeline 失敗的 submissions
        const qualityFailIds = new Set(phaseAQualityFails.map((f) => f.submissionId))
        const phaseAFailureIds = new Set(phaseAFailures.map((f) => f.submissionId))
        const excludeIds = new Set([...qualityFailIds, ...phaseAFailureIds])
        let validEntries = excludeIds.size > 0
          ? entries.filter((e) => !excludeIds.has(e.submissionId) && !e.phaseAResult.pipelineFailure)
          : entries

        // ── Post-batch peer baseline 比對（answer_only only）──
        // 用 batch 內其他 sub 的 bbox median 當基準、回頭檢查每份是否有 partial/全 shift。
        // 跳過條件：非 answer_only、validEntries < 5（peer 太少不可靠）。
        // 失敗動作：retry 整個 Phase A 一次、仍 outlier → grading_failed。
        if (assignment?.answerSheetMode === 'answer_only' && validEntries.length >= 5 && !stopRequestedRef.current) {
          setGradingMessage('Peer baseline 比對中…')
          const peerOutlierTrips: Array<{ entry: BatchPhaseAEntry; outlierCount: number; outlierQids: string[] }> = []
          for (const entry of validEntries) {
            const baseline = computePeerBaseline(validEntries, entry.submissionId)
            if (baseline.size < 3) continue
            const result = checkPeerOutliers(entry, baseline)
            if (result.trip) {
              peerOutlierTrips.push({ entry, outlierCount: result.outlierCount, outlierQids: result.outlierQids })
              console.warn(`[PeerCheck] ${entry.submissionId} 偵測到 ${result.outlierCount} 個 outlier qids`, result.outlierQids.slice(0, 5))
            }
          }

          if (peerOutlierTrips.length > 0) {
            setGradingMessage(`Peer 異常 ${peerOutlierTrips.length} 份、重跑 Phase A 中…`)
            const retriedResults = new Map<string, PhaseAResult>()
            await runWithConcurrency(
              peerOutlierTrips,
              3,
              2000,
              async (item) => {
                if (stopRequestedRef.current) return null
                const sub = toGrade.find((s) => s.id === item.entry.submissionId)
                if (!sub?.imageBlob) return null
                console.log(`📄 [PeerCheck retry] student=${sub.studentId}`)
                const phaseAResult = await gradePhaseA(
                  sub.imageBlob,
                  assignment.answerKey!,
                  sub.pageBreaks,
                  assignment.domain,
                  assignment.id,
                  undefined,
                  assignment.answerSheetMode,
                  sub.id,
                  sub.source
                )
                return { item, phaseAResult }
              },
              (_i, result, err) => {
                if (!result) {
                  if (err) console.error('[PeerCheck retry] failed:', err)
                  return
                }
                const { item, phaseAResult } = result
                retriedResults.set(item.entry.submissionId, phaseAResult)
              },
              stopRequestedRef
            )

            // 處理 retry 結果：更新 validEntries 或加進 phaseAFailures
            const newFailureIds = new Set<string>()
            for (const item of peerOutlierTrips) {
              const newResult = retriedResults.get(item.entry.submissionId)
              if (!newResult) continue  // retry 沒回來

              // retry 本身炸開（pipelineFailure）→ 用該 failure
              if (newResult.pipelineFailure) {
                phaseAFailures.push({ submissionId: item.entry.submissionId, studentId: item.entry.studentId, failure: newResult.pipelineFailure })
                newFailureIds.add(item.entry.submissionId)
                continue
              }

              // 用新結果建構臨時 entry、再驗 peer
              const tempEntry: BatchPhaseAEntry = { ...item.entry, phaseAResult: newResult }
              const baseline = computePeerBaseline(validEntries.filter((e) => e.submissionId !== item.entry.submissionId), item.entry.submissionId)
              const recheck = checkPeerOutliers(tempEntry, baseline)

              if (recheck.trip) {
                // 仍 outlier → grading_failed
                const failure: import('@/lib/gemini').PipelineFailure = {
                  stage: 'classify',
                  reasonCode: 'CLASSIFY_BBOX_PEER_OUTLIER',
                  userMessage: '批改失敗：這份作業的答題框跟其他學生的位置明顯不同，可能 AI 框錯位置。',
                  userAction: '請重新批改這份作業（再跑一次 AI 通常能修正）。',
                  technical: { metrics: { outlierCount: recheck.outlierCount, dy_med: recheck.metrics.dy_med, dx_med: recheck.metrics.dx_med } as Record<string, unknown> }
                }
                phaseAFailures.push({ submissionId: item.entry.submissionId, studentId: item.entry.studentId, failure })
                newFailureIds.add(item.entry.submissionId)
                const failureGradingResult = { pipelineFailure: failure } as unknown as import('@/lib/db').GradingResult
                void db.submissions.update(item.entry.submissionId, {
                  status: 'grading_failed',
                  gradingResult: failureGradingResult,
                  updatedAt: Date.now(),
                }).catch(() => {})
                fetch(buildApiUrl('/api/data/save-grading'), {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  credentials: 'include',
                  body: JSON.stringify({
                    submissions: [{ id: item.entry.submissionId, status: 'grading_failed', gradingResult: { pipelineFailure: failure } }],
                  }),
                }).catch(() => {})
                console.warn(`[PeerCheck] ${item.entry.submissionId} retry 後仍 outlier、grading_failed`)
              } else {
                // retry passed → 在 validEntries 裡替換成新結果
                const idx = validEntries.findIndex((e) => e.submissionId === item.entry.submissionId)
                if (idx >= 0) {
                  // 重新 build decisions
                  const decisions = new Map<string, ConsistencyDecision>()
                  for (const qr of newResult.questionResults) {
                    const arbiter = qr.arbiterResult
                    if (arbiter && arbiter.arbiterStatus !== 'needs_review') {
                      const isCalcType = qr.questionType === 'calculation' || qr.questionType === 'word_problem'
                      const fullAnswer = isCalcType ? qr.readAnswer1.studentAnswer : (arbiter.finalAnswer ?? qr.readAnswer1.studentAnswer)
                      decisions.set(qr.questionId, { questionId: qr.questionId, source: 'ai_arbiter', finalAnswer: fullAnswer, confirmed: true })
                    } else if (!arbiter && qr.consistencyStatus === 'stable') {
                      decisions.set(qr.questionId, { questionId: qr.questionId, source: 'ai_read1', finalAnswer: qr.readAnswer1.studentAnswer, confirmed: true })
                    }
                  }
                  validEntries[idx] = { ...validEntries[idx], phaseAResult: newResult, decisions }
                }
                console.log(`[PeerCheck] ${item.entry.submissionId} retry 後 OK`)
              }
            }

            if (newFailureIds.size > 0) {
              validEntries = validEntries.filter((e) => !newFailureIds.has(e.submissionId))
            }
          }
        }

        setBatchPhaseAEntries(validEntries)
        setPendingPhaseAFailures(phaseAFailures)

        // ── 穩定學生立刻送 Accessor（背景） ──
        const isNeedsReview = (e: BatchPhaseAEntry) =>
          e.phaseAResult.questionResults.some(qr =>
            qr.arbiterResult?.arbiterStatus === 'needs_review'
          )
        const stableEntries = validEntries.filter(e => !isNeedsReview(e))
        const reviewEntries = validEntries.filter(e => isNeedsReview(e))

        if (reviewEntries.length === 0) {
          // 全部穩定，不需審查 → 前台跑全部 Accessor
          console.log('✅ 全部穩定，直接進入 Phase B')
          void executeBatchPhaseB(validEntries, false, phaseAFailures)
        } else {
          // 穩定學生背景先跑 Accessor
          backgroundPhaseBPromises.current = []
          if (stableEntries.length > 0) {
            console.log(`🚀 ${stableEntries.length} 位穩定學生送 Accessor（背景）`)
            backgroundPhaseBPromises.current.push(
              executeBatchPhaseB(stableEntries, true).catch(err =>
                console.error('Background Accessor failed:', err)
              )
            )
          }
          setGradingPhase('awaiting_review')
        }
        // Fire-and-forget: write Phase A forensic data to Supabase for calibration
        const forensicRows = entries.flatMap((entry) =>
          entry.phaseAResult.questionResults.map((qr) => {
            const arbiter = qr.arbiterResult
            const isAutoPass = arbiter && arbiter.arbiterStatus !== 'needs_review'
            return {
              assignmentId,
              studentId: entry.studentId,
              submissionId: entry.submissionId,
              questionId: qr.questionId,
              questionType: qr.questionType ?? '',
              ai1Answer: qr.readAnswer1?.studentAnswer ?? null,
              ai1Status: qr.readAnswer1?.status ?? null,
              ai2Answer: qr.readAnswer2?.studentAnswer ?? null,
              ai2Status: qr.readAnswer2?.status ?? null,
              consistencyStatus: arbiter?.consistent === true ? 'stable' : arbiter?.consistent === false ? 'diff' : (qr.consistencyStatus ?? null),
              forensicMode: arbiter?.consistent !== undefined ? (arbiter.consistent ? 'consistent' : 'inconsistent') : (arbiter?.forensicMode ?? null),
              agreementSupport: arbiter?.reason ?? arbiter?.agreementSupport ?? null,
              ai1Support: arbiter?.ai1Support ?? null,
              ai2Support: arbiter?.ai2Support ?? null,
              systemDecision: arbiter?.arbiterStatus ?? 'needs_review',
              autoConfirmedAnswer: isAutoPass ? (arbiter.finalAnswer ?? null) : null,
            }
          })
        )
        fetch('/api/data/upsert-ai3-forensic-log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ rows: forensicRows }),
        }).catch(() => {})
      }
    } catch (err) {
      console.error('批改失敗', err)
      setError(err instanceof Error ? err.message : '批改失敗')
      setGradingPhase('idle')
    } finally {
      setIsGrading(false)
      setIsDownloading(false)
      setGradingProgress({ current: 0, total: 0 })
      setDownloadProgress({ current: 0, total: 0 })
      setStopRequested(false)
      stopRequestedRef.current = false
      setCurrentGradingStudent('')
      setSelectedSubmissionIds(new Set())
    }
  }

  // 🆕 停止批改
  const handleStopGrading = () => {
    console.log('🛑 用戶請求停止批改')
    setStopRequested(true)
    stopRequestedRef.current = true
  }

  // 單題得分即時更新（自動重算總分並儲存）
  const handleDetailScoreChange = async (index: number, scoreValue: number) => {
    if (isBusy || isSavingScore) return
    if (!selectedSubmission) return

    const updatedDetails = editableDetails.map((d: any, i: number) =>
      i === index ? { ...d, score: scoreValue } : d
    )
    setEditableDetails(updatedDetails)

    const id = selectedSubmission.submission.id
    const submission = await db.submissions.get(id)
    if (!submission) return

    const cleanedDetails = updatedDetails.map((d: any) => {
      const score = Number.isFinite(Number(d.score)) ? Number(d.score) : 0
      const maxScore = Number.isFinite(Number(d.maxScore)) ? Number(d.maxScore) : 0
      const isCorrect = maxScore > 0 ? score >= maxScore : false

      return {
        ...d,
        score,
        maxScore,
        isCorrect,
        reason: d.reason ?? d.comment ?? '',
        comment: d.comment ?? d.reason ?? ''
      }
    })

    const newTotal = cleanedDetails.reduce(
      (sum: number, d: any) => sum + (Number.isFinite(d.score) ? Number(d.score) : 0),
      0
    )

    const newGradingResult: any = submission.gradingResult
      ? { ...submission.gradingResult }
      : { mistakes: [], weaknesses: [], suggestions: [] }

    newGradingResult.details = cleanedDetails
    newGradingResult.totalScore = newTotal
    newGradingResult.needsReview = false
    newGradingResult.reviewReasons = []

    setIsSavingScore(true)
    try {
      const now = Date.now()
      await db.submissions.update(id, {
        score: newTotal,
        aiScore: newTotal,
        scoreSource: 'ai',
        gradingResult: newGradingResult,
        gradedAt: now,
        updatedAt: now
      })
      fetch('/api/data/save-grading', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ submissions: [{ id, score: newTotal, aiScore: newTotal, scoreSource: 'ai', gradingResult: newGradingResult, gradedAt: now }] })
      }).catch(() => {})
      requestSync()

      const updated = await db.submissions.get(id)
      if (updated) {
        setSubmissions((prev) => new Map(prev).set(updated.studentId, updated))
        const student = students.find((s) => s.id === updated.studentId)
        if (student) setSelectedSubmission({ submission: updated, student })
      }
    } finally {
      setIsSavingScore(false)
    }
  }

  const getSubmissionMaxScore = (result?: Submission['gradingResult']) => {
    const answerKeyTotal = assignment?.answerKey?.totalScore
    if (typeof answerKeyTotal === 'number' && answerKeyTotal > 0) return answerKeyTotal

    if (result?.details && Array.isArray(result.details)) {
      const sum = result.details.reduce((acc: number, d: any) => {
        const value = Number(d?.maxScore)
        return Number.isFinite(value) ? acc + value : acc
      }, 0)
      return sum > 0 ? sum : null
    }

    return null
  }

  const getSubmissionCorrectSummary = (result?: Submission['gradingResult']) => {
    if (!result?.details || !Array.isArray(result.details) || result.details.length === 0) {
      return null
    }

    const byQuestion = new Map<string, boolean>()
    result.details.forEach((detail: any, index: number) => {
      const questionId =
        typeof detail?.questionId === 'string' && detail.questionId.trim()
          ? detail.questionId.trim()
          : `#${index + 1}`
      const maxScore = Number(detail?.maxScore)
      const score = Number(detail?.score)
      const isCorrect =
        typeof detail?.isCorrect === 'boolean'
          ? detail.isCorrect
          : Number.isFinite(maxScore) && maxScore > 0 && Number.isFinite(score)
            ? score >= maxScore
            : false

      byQuestion.set(questionId, isCorrect)
    })

    const total = byQuestion.size
    if (total <= 0) return null

    let correct = 0
    byQuestion.forEach((value) => {
      if (value) correct += 1
    })

    return { correct, total, ratio: correct / total }
  }

  // 信心顯示停用後 getSubmissionConfidenceAverage / getSubmissionMinConfidenceInfo 已不需要、移除

  const getDisplayReviewReasons = useCallback(
    (submission: Submission) => {
      const reasons = submission.gradingResult?.reviewReasons ?? []
      if (reasons.length > 0) {
        const parsed = reasons
          .map((reason) => toUserFriendlyReviewReason(reason))
          .map((reason) => reason.trim())
          // 過濾掉「未作答」相關 reason（學生明確沒寫不需老師確認）
          // 包含舊批改紀錄存的「辨識為未作答，請確認」也一併不顯示
          .filter((reason) => reason.length > 0 && !reason.includes('辨識為未作答') && !reason.includes('題未作答'))
        return Array.from(new Set(parsed))
      }

      const derived = new Set<string>()
      const details = submission.gradingResult?.details ?? []

      // 「信心偏低」derive reason 已停用 — 信心數字無實質意義
      const unreadableIds = details
        .filter((detail: any) => detail?.studentAnswer === 'AI無法辨識' || detail?.studentAnswer === '無法辨識')
        .map((detail: any) => formatDisplayQuestionId(detail?.questionId) || detail?.questionId)
        .filter(Boolean)
      if (unreadableIds.length > 0) {
        derived.add(`第 ${unreadableIds.join('、')} 題無法辨識`)
      }
      // 「未作答」（學生明確沒寫）不再列為需要複核理由 — 學生既然空白就空白、不用老師確認
      return Array.from(derived)
    },
    []
  )



  const sortedStudents = useMemo(() => {
    return [...students].sort((a, b) => a.seatNumber - b.seatNumber)
  }, [students])

  // batch mode: 按班級分組的學生列表
  const studentsByClassroom = useMemo(() => {
    if (!isBatchMode) return null
    const groups = new Map<string, { classroom: Classroom; students: Student[] }>()
    for (const s of sortedStudents) {
      const cid = submissionClassroomMap.get(s.id) || s.classroomId
      if (!groups.has(cid)) {
        const c = batchClassrooms.get(cid)
        if (c) groups.set(cid, { classroom: c, students: [] })
      }
      groups.get(cid)?.students.push(s)
    }
    return Array.from(groups.values())
  }, [isBatchMode, sortedStudents, submissionClassroomMap, batchClassrooms])

  const selectedReviewReasons = selectedSubmission
    ? getDisplayReviewReasons(selectedSubmission.submission)
    : []
  // 信心顯示已停用（沒有實質意義、徒增老師認知負擔）
  const selectedConfidenceLabel = null

  if (isLoading) {
    return (
      <div className={`${embedded ? 'min-h-[280px]' : 'min-h-screen'} bg-white flex items-center justify-center`}>
        <div className="text-center">
          <Loader className="w-12 h-12 text-purple-600 mx-auto mb-4 animate-spin" />
          <p className="text-gray-600">載入中…</p>
        </div>
      </div>
    )
  }

  if (inkSessionError) {
    return (
      <div className={`${embedded ? 'min-h-[280px]' : 'min-h-screen'} bg-white flex items-center justify-center p-4`}>
        <div className="bg-white rounded-xl border border-slate-200 p-8 max-w-md">
          <AlertTriangle className="w-16 h-16 text-amber-500 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-gray-900 mb-2 text-center">
            無法進入 AI 批改
          </h2>
          <p className="text-gray-600 text-center mb-6">{inkSessionError}</p>
          <div className="space-y-3">
            <button
              onClick={handleInkTopUp}
              className="w-full px-6 py-3 bg-sky-600 text-white rounded-xl hover:bg-sky-700 transition-colors"
            >
              前往補充墨水
            </button>
            {onBack && (
              <button
                onClick={handleExit}
                className="w-full px-6 py-3 bg-gray-100 text-gray-700 rounded-xl hover:bg-gray-200 transition-colors"
              >
                返回
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className={`${embedded ? 'min-h-[280px]' : 'min-h-screen'} bg-white flex items-center justify-center p-4`}>
        <div className="bg-white rounded-xl border border-slate-200 p-8 max-w-md">
          <XCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-gray-900 mb-2 text-center">載入失敗</h2>
          <p className="text-gray-600 text-center mb-6">{error}</p>
          {onBack && (
            <button
              onClick={handleExit}
              className="w-full px-6 py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-colors"
            >
              返回
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className={`${embedded ? 'bg-white p-0' : 'min-h-screen bg-white p-4'}`}>
      {/* AI 使用計算中 Overlay */}
      {isClosingSession && (
        <div className="fixed inset-0 bg-black/50 z-[120] flex items-center justify-center">
          <div className="bg-white rounded-xl border border-slate-200 p-8 flex flex-col items-center gap-4">
            <Loader className="w-10 h-10 text-blue-500 animate-spin" />
            <div className="text-center">
              <p className="text-lg font-semibold text-gray-800">AI 使用計算中…</p>
              <p className="text-sm text-gray-500 mt-1">正在結算本次批改費用，請稍候</p>
            </div>
          </div>
        </div>
      )}

      {isCheckingCorrectionState && (
        <div className="fixed inset-0 bg-black/30 z-[120] flex items-center justify-center">
          <div className="bg-white rounded-xl border border-slate-200 p-6 w-full max-w-sm mx-4">
            <div className="flex items-center gap-3">
              <Loader className="w-6 h-6 text-sky-600 animate-spin" />
              <div>
                <p className="text-base font-semibold text-gray-900">檢查訂正狀態中…</p>
                <p className="text-sm text-gray-500">避免誤覆蓋學生端訂正內容</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {correctionGuardModal && (
        <div className="fixed inset-0 bg-black/50 z-[120] flex items-center justify-center">
          <div className="bg-white rounded-xl border border-slate-200 p-6 max-w-lg w-full mx-4">
            <div className="flex items-start gap-3 mb-4">
              <AlertTriangle className="w-6 h-6 text-amber-500 mt-0.5 shrink-0" />
              <div>
                <h3 className="text-lg font-bold text-gray-900">{correctionGuardModal.title}</h3>
                <p className="text-sm text-gray-600 mt-1">{correctionGuardModal.description}</p>
              </div>
            </div>

            {Array.isArray(correctionGuardModal.blockedStudents) &&
              correctionGuardModal.blockedStudents.length > 0 && (
                <div className="rounded-lg border border-amber-100 bg-amber-50/60 p-3 mb-4 max-h-52 overflow-y-auto">
                  <p className="text-xs font-semibold text-amber-800 mb-2">訂正中的學生</p>
                  <div className="space-y-1.5">
                    {correctionGuardModal.blockedStudents.map((item) => {
                      const seatText = Number.isFinite(item.seatNumber)
                        ? `${item.seatNumber}號`
                        : '未知座號'
                      const statusLabel = CORRECTION_STATUS_LABEL_MAP[item.status] || item.status
                      return (
                        <div
                          key={item.studentId}
                          className="text-sm text-amber-900 flex items-center justify-between gap-2"
                        >
                          <span className="truncate">{seatText} {item.name}</span>
                          <span className="shrink-0 text-xs rounded bg-white border border-amber-200 px-2 py-0.5">
                            {statusLabel}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

            {revokeError && (
              <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 mb-4 text-xs text-rose-700">
                {revokeError}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  pendingGradeResumeRef.current = null
                  setCorrectionGuardModal(null)
                }}
                disabled={isRevokingCorrection}
                className="px-4 py-2 rounded-lg bg-white border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50 transition-colors disabled:opacity-50"
              >
                知道了
              </button>
              {Array.isArray(correctionGuardModal.blockedStudents) &&
                correctionGuardModal.blockedStudents.length > 0 && (
                  <button
                    onClick={() =>
                      void handleRevokeCorrection(
                        (correctionGuardModal.blockedStudents || []).map((b) => b.studentId)
                      )
                    }
                    disabled={isRevokingCorrection}
                    className="px-4 py-2 rounded-lg bg-rose-600 text-white text-sm font-medium hover:bg-rose-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
                  >
                    {isRevokingCorrection && <Loader className="w-4 h-4 animate-spin" />}
                    全部退回訂正並繼續批改
                  </button>
                )}
            </div>
          </div>
        </div>
      )}

      {/* 2026-05-17: 重新截取警告 modal（會清掉已批改紀錄） */}
      {recaptureConfirm && (
        <div className="fixed inset-0 bg-black/50 z-[120] flex items-center justify-center">
          <div className="bg-white rounded-xl border border-slate-200 p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-bold text-gray-900 mb-3">確認截取答案</h3>
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800 mb-4">
              ⚠️ 以下 {recaptureConfirm.cleared.length} 份作業會被**清空既有的學生答案、批改分數、訂正狀態**。
            </div>
            <div className="max-h-60 overflow-y-auto mb-4 border border-gray-100 rounded-lg">
              <ul className="text-sm divide-y divide-gray-100">
                {recaptureConfirm.cleared.map((sub) => {
                  const stu = students.find((s) => s.id === sub.studentId)
                  const stage = deriveCardStage(sub)
                  return (
                    <li key={sub.id} className="px-3 py-2 flex justify-between items-center">
                      <span className="text-gray-700">{stu ? `${stu.seatNumber}號 ${stu.name}` : sub.id.slice(-8)}</span>
                      <span className="text-xs text-gray-500">{CARD_STAGE_LABEL[stage]}{sub.score != null ? `（${sub.score}分）` : ''}</span>
                    </li>
                  )
                })}
              </ul>
            </div>
            <div className="text-xs text-gray-500 mb-4">共 {recaptureConfirm.submissions.length} 份要截取（含 {recaptureConfirm.cleared.length} 份要清空）</div>
            <div className="flex gap-3">
              <button
                onClick={() => setRecaptureConfirm(null)}
                className="flex-1 px-4 py-3 bg-gray-100 text-gray-700 rounded-xl hover:bg-gray-200 transition-colors font-medium"
              >
                取消
              </button>
              <button
                onClick={() => {
                  const candidates = recaptureConfirm.submissions
                  setRecaptureConfirm(null)
                  void executeRecaptureOnly(candidates)
                }}
                className="flex-1 px-4 py-3 bg-rose-600 text-white rounded-xl hover:bg-rose-700 transition-colors font-medium"
              >
                確認截取
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 2026-05-17: 批改作業 block modal（先補答 / 先截取） */}
      {gradeBlockModal && (
        <div className="fixed inset-0 bg-black/50 z-[120] flex items-center justify-center">
          <div className="bg-white rounded-xl border border-slate-200 p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-bold text-gray-900 mb-3">
              {gradeBlockModal.reason === 'needs_extract' ? '請先截取答案' : '請先補答 / 確認'}
            </h3>
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800 mb-4">
              {gradeBlockModal.reason === 'needs_extract'
                ? `以下 ${gradeBlockModal.submissions.length} 份作業還沒擷取答案、無法直接批改。請先按「截取答案」。`
                : `以下 ${gradeBlockModal.submissions.length} 份作業有題目 AI 不確定（待複核）、請進入個別作業補答後再批改。`}
            </div>
            <div className="max-h-60 overflow-y-auto mb-4 border border-gray-100 rounded-lg">
              <ul className="text-sm divide-y divide-gray-100">
                {gradeBlockModal.submissions.map((sub) => {
                  const stu = students.find((s) => s.id === sub.studentId)
                  const stage = deriveCardStage(sub)
                  return (
                    <li key={sub.id} className="px-3 py-2 flex justify-between items-center">
                      <span className="text-gray-700">{stu ? `${stu.seatNumber}號 ${stu.name}` : sub.id.slice(-8)}</span>
                      <span className="text-xs text-gray-500">{CARD_STAGE_LABEL[stage]}</span>
                    </li>
                  )
                })}
              </ul>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setGradeBlockModal(null)}
                className="flex-1 px-4 py-3 bg-slate-900 text-white rounded-xl hover:bg-slate-700 transition-colors font-medium"
              >
                了解
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 2026-05-17: 批改作業覆寫警告 modal */}
      {gradeOverwriteConfirm && (
        <div className="fixed inset-0 bg-black/50 z-[120] flex items-center justify-center">
          <div className="bg-white rounded-xl border border-slate-200 p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-bold text-gray-900 mb-3">確認重新批改</h3>
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800 mb-4">
              ⚠️ 以下 {gradeOverwriteConfirm.overwriting.length} 份作業已批改過、會被覆寫新分數。
            </div>
            <div className="max-h-60 overflow-y-auto mb-4 border border-gray-100 rounded-lg">
              <ul className="text-sm divide-y divide-gray-100">
                {gradeOverwriteConfirm.overwriting.map((sub) => {
                  const stu = students.find((s) => s.id === sub.studentId)
                  return (
                    <li key={sub.id} className="px-3 py-2 flex justify-between items-center">
                      <span className="text-gray-700">{stu ? `${stu.seatNumber}號 ${stu.name}` : sub.id.slice(-8)}</span>
                      <span className="text-xs text-gray-500">{sub.score != null ? `${sub.score}分` : '失敗'}</span>
                    </li>
                  )
                })}
              </ul>
            </div>
            <div className="text-xs text-gray-500 mb-4">共 {gradeOverwriteConfirm.submissions.length} 份要批改（含 {gradeOverwriteConfirm.overwriting.length} 份要覆寫）</div>
            <div className="flex gap-3">
              <button
                onClick={() => setGradeOverwriteConfirm(null)}
                className="flex-1 px-4 py-3 bg-gray-100 text-gray-700 rounded-xl hover:bg-gray-200 transition-colors font-medium"
              >
                取消
              </button>
              <button
                onClick={() => {
                  const candidates = gradeOverwriteConfirm.submissions
                  setGradeOverwriteConfirm(null)
                  void executeGradeOnlyCache(candidates)
                }}
                className="flex-1 px-4 py-3 bg-purple-600 text-white rounded-xl hover:bg-purple-700 transition-colors font-medium"
              >
                確認重新批改
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 🆕 確認對話框 */}
      {showGradeConfirm && (
        <div className="fixed inset-0 bg-black/50 z-[120] flex items-center justify-center">
          <div className="bg-white rounded-xl border border-slate-200 p-6 max-w-sm w-full mx-4">
            <h3 className="text-lg font-bold text-gray-900 mb-4">
              {isRegrade ? '確認重新批改' : '確認開始批改'}
            </h3>
            
            <div className="space-y-3 mb-6">
              <div className="flex justify-between items-center py-2 border-b border-gray-100">
                <span className="text-gray-600">作業數量</span>
                <span className="font-semibold text-gray-900">{gradeCandidates.length} 份</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-gray-100">
                <span className="text-gray-600">預估扣點</span>
                <span className="font-semibold text-purple-600">約 {gradeCandidates.length} 點</span>
              </div>
              {isRegrade && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-700">
                  ⚠️ 這些作業已批改過，重新批改會覆蓋原有結果
                </div>
              )}
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setShowGradeConfirm(false)}
                className="flex-1 px-4 py-3 bg-gray-100 text-gray-700 rounded-xl hover:bg-gray-200 transition-colors font-medium"
              >
                取消
              </button>
              <button
                onClick={executeGrading}
                className="flex-1 px-4 py-3 bg-gradient-to-r from-purple-600 to-pink-600 text-white rounded-xl hover:from-purple-700 hover:to-pink-700 transition-colors font-medium"
              >
                開始批改
              </button>
            </div>
          </div>
        </div>
      )}

      {gradeResultNotice && (
        <div className="fixed inset-0 bg-black/50 z-[120] flex items-center justify-center">
          <div className="bg-white rounded-xl border border-slate-200 p-6 max-w-xl w-full mx-4">
            <h3 className="text-lg font-bold text-gray-900 mb-4">
              {gradeResultNotice.stopped ? '已停止批改' : '批改完成'}
            </h3>
            <div className="space-y-3 mb-6">
              <div className="flex justify-between items-center py-2 border-b border-gray-100">
                <span className="text-gray-600">成功批改</span>
                <span className="font-semibold text-emerald-600">{gradeResultNotice.successCount} 份</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-gray-100">
                <span className="text-gray-600">失敗/略過</span>
                <span className="font-semibold text-rose-600">{gradeResultNotice.failCount} 份</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-gray-100">
                <span className="text-gray-600">總作業數</span>
                <span className="font-semibold text-gray-900">{gradeResultNotice.totalCount} 份</span>
              </div>
              {gradeResultNotice.failReasons.length > 0 && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2">
                  <p className="text-sm font-medium text-rose-700 mb-2">失敗原因</p>
                  <ul className="space-y-1 max-h-44 overflow-y-auto pr-1">
                    {gradeResultNotice.failReasons.map((reason, index) => (
                      <li key={`${index}-${reason}`} className="text-sm text-rose-700 break-words leading-relaxed">
                        {index + 1}. {reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {gradeResultNotice.stopped && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
                  你已手動停止批改，系統僅保留已完成的批改結果。
                </div>
              )}
            </div>
            <div className="flex flex-col gap-2">
              {gradeResultNotice.failedEntries.length > 0 && (
                <button
                  onClick={() => {
                    const toRetry = gradeResultNotice.failedEntries
                    setGradeResultNotice(null)
                    void executeBatchPhaseB(toRetry)
                  }}
                  className="w-full rounded-xl bg-rose-600 px-4 py-3 text-sm font-medium text-white hover:bg-rose-700 transition-colors"
                >
                  重新批改失敗的 {gradeResultNotice.failedEntries.length} 份
                </button>
              )}
              <button
                onClick={() => setGradeResultNotice(null)}
                className="w-full rounded-xl bg-slate-900 px-4 py-3 text-sm font-medium text-white hover:bg-slate-700 transition-colors"
              >
                關閉
              </button>
            </div>
          </div>
        </div>
      )}
      <div className={`${embedded ? 'max-w-none mx-0 pt-0' : 'max-w-7xl mx-auto pt-8'}`}>
        {onBack && (
          <button
            onClick={handleExit}
            className="mb-4 flex items-center gap-2 text-gray-600 hover:text-gray-900 transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
            返回作業批改
          </button>
        )}

        {/* Header */}
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 pb-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold text-gray-900">
              {isBatchMode ? `批次批改：${batchTemplateName || assignment?.title}` : assignment?.title}
            </h1>
            <p className="mt-1 text-sm text-gray-600">
              {isBatchMode
                ? `${batchClassrooms.size} 個班級 · ${students.length} 位學生`
                : `${classroom?.name} · ${students.length} 位學生`}
            </p>
          </div>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {/* 2026-05-18: 待複核按鈕拿掉、user 在 PR2 設計討論時決定移除（卡片本身會用顏色標出待複核狀態） */}
            <Button
              variant="outline"
              onClick={handleRefresh}
              disabled={isRefreshing}
            >
              <RefreshCw className={`w-5 h-5 ${isRefreshing ? 'animate-spin' : ''}`} />
              重新整理
            </Button>
            <Button
              variant="outline"
              onClick={handleToggleSelectAll}
              disabled={isBusy || !inkSessionReady || submissions.size === 0}
            >
              <CheckSquare className="w-5 h-5" />
              {selectedSubmissionIds.size > 0 ? '取消全選' : '全選'}
            </Button>
            {/*
              2026-05-17: Phase A / Phase B 分離設計——把單一「全部批改」拆成兩顆動態按鈕：
              【🔄 重新截取答案】= 只跑 Phase A（含警告 Modal 攔截、避免清掉已批改資料）
              【✓ 批改作業】     = 只跑 Phase B（用 cached phase_a_state，不重跑 Phase A）

              按鈕顏色依 stageAggregates 動態變化：primary / secondary / disabled
            */}
            <Button
              variant={recaptureButtonState.variant === 'primary' ? 'primary' : 'outline'}
              onClick={handleRecaptureAll}
              disabled={
                recaptureButtonState.variant === 'disabled' ||
                isGrading ||
                isDownloading ||
                isRefreshing ||
                isCheckingCorrectionState ||
                !isGeminiAvailable ||
                !inkSessionReady ||
                answerKeyStatus === 'deleted'
              }
              title="截取每題的學生答案（Phase A）。會清空已有的批改紀錄。"
            >
              <RefreshCw className="w-5 h-5" />
              {selectedSubmissionCount > 0
                ? `截取答案 (${selectedSubmissionCount})`
                : '截取答案'}
            </Button>
            <Button
              variant={gradeButtonState.variant === 'primary' ? 'primary' : 'outline'}
              onClick={handleGradeOnly}
              disabled={
                gradeButtonState.variant === 'disabled' ||
                isGrading ||
                isDownloading ||
                isRefreshing ||
                isCheckingCorrectionState ||
                !isGeminiAvailable ||
                !inkSessionReady ||
                answerKeyStatus === 'deleted'
              }
              title="只跑批改（Phase B）。需要已有讀取結果（待批改狀態）。"
            >
              {isCheckingCorrectionState ? (
                <Loader className="w-5 h-5 animate-spin" />
              ) : (
                <Sparkles className="w-5 h-5" />
              )}
              {isCheckingCorrectionState
                ? '檢查訂正狀態…'
                : selectedSubmissionCount > 0
                  ? `批改作業 (${selectedSubmissionCount})`
                  : '批改作業'}
            </Button>
          </div>
        </div>

        {isRefreshing && !isBusy && (
          <div className="sticky top-4 z-40 mb-4">
            <div className="bg-sky-50 border border-sky-200 rounded-xl px-4 py-2.5 flex items-center gap-3">
              <RefreshCw className="w-4 h-4 text-sky-500 animate-spin shrink-0" />
              <p className="text-sm text-sky-700 font-medium">正在同步最新資料，請稍候…</p>
            </div>
          </div>
        )}

        {/* Grading pipeline overlay (下載圖片、Phase A、Phase B 統一顯示遮罩) */}
        {(isDownloading || gradingPhase === 'phase_a_running' || gradingPhase === 'phase_b_running') && (
          <GradingPipelineOverlay
            phase={gradingPhase === 'phase_b_running' ? 'phase_b_running' : 'phase_a_running'}
            phaseAProgress={
              isDownloading
                ? downloadProgress
                : gradingPhase === 'phase_a_running'
                  ? gradingProgress
                  : { current: gradingProgress.total, total: gradingProgress.total }
            }
            phaseBProgress={
              gradingPhase === 'phase_b_running'
                ? { current: phaseBScoredCount, total: phaseBTotalCount || batchPhaseAEntries.length }
                : { current: 0, total: batchPhaseAEntries.length }
            }
            phaseANeedsReviewCount={phaseANeedsReviewCount}
            phaseATotalQuestionCount={phaseATotalQuestionCount}
            gradingMessage={isDownloading ? '正在下載學生作業圖片…' : gradingMessage}
            stopRequested={stopRequested}
            onStop={handleStopGrading}
          />
        )}

        {!inkSessionReady && (
          <div className="mb-4 bg-amber-50 border border-amber-200 text-amber-700 rounded-xl px-4 py-3 text-sm">
            正在建立批改會話，請稍候…
          </div>
        )}

        {gradingPhase === 'awaiting_review' && batchPhaseAEntries.length > 0 && (
          <BatchConsistencyReviewSection
            entries={batchPhaseAEntries}
            allStudents={students}
            onDecision={handleBatchDecision}
            onStudentConfirmed={(entry) => {
              console.log(`✅ 學生 ${entry.studentId} 確認完成，送 Accessor`)
              backgroundPhaseBPromises.current.push(
                executeBatchPhaseB([entry], true).catch(err =>
                  console.error('Student Accessor failed:', err)
                )
              )
            }}
            onAllDone={() => {
              console.log('✅ 全部審查完成，等待背景 Accessor')
              // total 由此確立，useEffect 監聽 phaseBScoredCount === phaseBTotalCount 自動關閉 loading
              setPhaseBTotalCount(batchPhaseAEntries.length)
              setGradingPhase('phase_b_running')
              setGradingMessage('AI 批改評分中…')
              setIsGrading(true)
            }}
            phaseBScoredCount={phaseBScoredCount}
            phaseBTotalCount={phaseBTotalCount}
          />
        )}


        {/* 答案卷版本狀態提示（放在卡片區塊上方，進頁面立即可見） */}
        {answerKeyStatus === 'updated' && (
          <div className="mb-4 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0" />
            <p className="text-sm text-amber-700 font-medium">
              答案卷已更新，目前成績為舊版批改結果
            </p>
          </div>
        )}
        {answerKeyStatus === 'deleted' && (
          <div className="mb-4 bg-red-50 border border-red-200 rounded-xl px-4 py-3 flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-red-500 shrink-0" />
            <p className="text-sm text-red-700 font-medium">
              答案卷已移除，請重新選擇答案卷
            </p>
          </div>
        )}

        {/* Grid */}
        {isBatchMode && studentsByClassroom ? (
          // 批次模式：按班級分組顯示
          <div className="space-y-6">
            {studentsByClassroom.map(({ classroom: groupClassroom, students: groupStudents }) => (
              <div key={groupClassroom.id}>
                <h3 className="mb-3 text-sm font-semibold text-slate-500 border-b border-slate-200 pb-2">
                  {groupClassroom.name} ({groupStudents.filter((s) => submissions.get(s.id)?.status === 'graded').length}/{groupStudents.length} 批改)
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                  {groupStudents.map((student) => {
                    const submission = submissions.get(student.id)
                    const status = submission?.status ?? 'missing'
                    const sourceVisual = getSubmissionSourceVisual(submission)
                    const gradingResult = submission?.gradingResult
                    const isUnscoredAssignment = assignment?.scoringMode === 'unscored'
                    const maxScore = gradingResult ? getSubmissionMaxScore(gradingResult) : null
                    const scoreValueRaw = Number(gradingResult?.totalScore)
                    const scoreValue = Number.isFinite(scoreValueRaw) ? scoreValueRaw : 0
                    const correctSummary = gradingResult ? getSubmissionCorrectSummary(gradingResult) : null
                    const isLowScore = isUnscoredAssignment
                      ? (correctSummary ? correctSummary.ratio < 0.8 : true)
                      : (typeof maxScore === 'number' && maxScore > 0 ? scoreValue < maxScore * 0.8 : scoreValue < 60)
                    const needsReview = isSubmissionNeedsReview(gradingResult)
                    const isSelected = selectedSubmissionIds.has(submission?.id ?? '')
                    const isStub = isManualGradeStub(submission)
                    return (
                      <div key={student.id} className="relative">
                        {/* 勾選框 */}
                        {submission && hasSubmissionImage(submission) && (
                          <div className="absolute top-2 left-2 z-10" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              className="h-4 w-4 cursor-pointer accent-green-600"
                              checked={isSelected}
                              onChange={() => toggleSubmissionSelection(submission.id)}
                            />
                          </div>
                        )}
                        <button
                          onClick={() => {
                            if (!submission || status === 'missing' || isStub) return
                            setSelectedSubmission({ submission, student })
                          }}
                          className={`w-full rounded-xl border-2 p-0 overflow-hidden transition-colors ${
                            selectedSubmission?.submission.id === submission?.id ? 'border-blue-500 ring-2 ring-blue-200' :
                            needsReview ? 'border-amber-400 ring-1 ring-amber-200' :
                            status === 'graded' ? 'border-green-300' :
                            status === 'missing' ? 'border-dashed border-gray-200' :
                            'border-slate-200 hover:border-slate-300'
                          }`}
                        >
                          <div className="relative aspect-[3/4] bg-gray-100">
                            <SubmissionThumbnail submission={submission} />
                            {status === 'graded' && !isStub && (
                              <div className={`absolute top-1 right-1 rounded-full px-2 py-0.5 text-xs font-bold text-white shadow ${
                                isLowScore ? 'bg-red-500' : 'bg-green-500'
                              }`}>
                                {isUnscoredAssignment && correctSummary ? `${correctSummary.correct}/${correctSummary.total}` : `${scoreValue}分`}
                              </div>
                            )}
                            {isStub && (
                              <div className="absolute top-1 right-1 rounded-full bg-emerald-500 px-2 py-0.5 text-xs font-bold text-white shadow">
                                已批改
                              </div>
                            )}
                            {needsReview && (
                              <div className="absolute top-1 left-1 rounded-full bg-amber-500 px-2 py-0.5 text-xs font-bold text-white shadow">複核</div>
                            )}
                          </div>
                          <div className="px-2 py-2 text-left">
                            <p className="text-sm font-semibold text-gray-900">{student.seatNumber} {student.name}</p>
                            {status !== 'missing' && <p className={`text-[11px] font-medium ${sourceVisual.textClass}`}>{isStub ? '老師手動標記' : sourceVisual.label}</p>}
                            {submission?.id && <p className="text-[9px] text-gray-300 font-mono cursor-pointer hover:text-gray-500 truncate" title={submission.id} onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(submission.id) }}>{submission.id.slice(-8)}</p>}
                          </div>
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {sortedStudents.map((student) => {
            const submission = submissions.get(student.id)
            const status = submission?.status ?? 'missing'
            const sourceVisual = getSubmissionSourceVisual(submission)
            const gradingResult = submission?.gradingResult
            const isUnscoredAssignment = assignment?.scoringMode === 'unscored'
            const maxScore = gradingResult ? getSubmissionMaxScore(gradingResult) : null
            const scoreValueRaw = Number(gradingResult?.totalScore)
            const scoreValue = Number.isFinite(scoreValueRaw) ? scoreValueRaw : 0
            const correctSummary = gradingResult ? getSubmissionCorrectSummary(gradingResult) : null
            const isLowScore = isUnscoredAssignment
              ? (correctSummary ? correctSummary.ratio < 0.8 : true)
              : (
                  typeof maxScore === 'number' && maxScore > 0
                    ? scoreValue < maxScore * 0.8
                    : scoreValue < 60
                )
            const hasGradingResult = isUnscoredAssignment
              ? !!correctSummary
              : !!gradingResult && typeof gradingResult.totalScore === 'number'
            const isStub = isManualGradeStub(submission)
            const showResultBadge =
              hasGradingResult && (status === 'graded' || status === 'synced')
            const needsReview = showResultBadge && isSubmissionNeedsReview(gradingResult)
            const resultBadgeText = isUnscoredAssignment
              ? (correctSummary ? `${correctSummary.correct}/${correctSummary.total}` : '')
              : `${scoreValue} 分`
            // 信心顯示已停用
            const confidenceHint = null

            return (
              <div
                key={student.id}
                className="bg-white rounded-xl hover:border-slate-300 border border-slate-200 transition-colors cursor-pointer group flex flex-col"
                onClick={() => {
                  if (!submission || isStub) return
                  setSelectedSubmission({ submission, student })
                }}
              >
                <div className="relative">
                  <div className="aspect-[4/3] bg-gray-100 rounded-t-xl overflow-hidden flex items-center justify-center relative">
                    <SubmissionThumbnail submission={submission} />
                    {isStub && (
                      <div className="absolute top-2 right-2 px-2 py-1 bg-emerald-500 text-white rounded-full text-xs font-semibold shadow">
                        已批改
                      </div>
                    )}
                    {showResultBadge && gradingResult && (
                      <div className="absolute top-2 right-2 flex flex-col items-end gap-1">
                        {needsReview ? (
                          <>
                            <div className="px-2 py-1 rounded-full text-xs font-bold shadow bg-amber-100 text-amber-700 border border-amber-200">
                              需複核
                            </div>
                            {confidenceHint && (
                              <div className="text-[10px] text-amber-700">
                                {confidenceHint}
                              </div>
                            )}
                          </>
                        ) : (
                          <div
                            className={`px-2 py-1 rounded-full text-xs font-bold shadow ${
                              !isLowScore
                                ? 'bg-green-500 text-white'
                                : 'bg-red-500 text-white'
                            }`}
                          >
                            {resultBadgeText}
                          </div>
                        )}
                      </div>
                    )}
                    {status === 'scanned' && (
                      <div className="absolute top-2 right-2 px-2 py-1 bg-blue-500 text-white rounded-full text-xs font-semibold shadow">
                        已掃描
                      </div>
                    )}
                    {status === 'synced' && !showResultBadge && (
                      <div className="absolute top-2 right-2 px-2 py-1 bg-purple-500 text-white rounded-full text-xs font-semibold shadow">
                        已上傳
                      </div>
                    )}
                    {status === 'synced' && showResultBadge && (
                      <div className="absolute bottom-2 right-2 px-2 py-0.5 bg-purple-100 text-purple-700 rounded-full text-[10px] font-semibold shadow">
                        已上傳
                      </div>
                    )}
                    {status === 'grading_failed' && (
                      <div
                        className="absolute top-2 right-2 px-2 py-1 bg-red-500 text-white rounded-full text-xs font-semibold shadow"
                        title="上次批改失敗、可勾選後重新批改"
                      >
                        批改失敗
                      </div>
                    )}

                    {(status === 'graded' || status === 'synced' || status === 'scanned' || status === 'grading_failed') &&
                      submission && (
                        <>
                          <div
                            className="absolute top-2 left-2 z-10 flex items-center justify-center rounded-md border border-slate-200 bg-white/95 p-1.5 shadow-md"
                            onClick={(e) => e.stopPropagation()}
                            title="勾選加入批次批改"
                          >
                            <input
                              type="checkbox"
                              className="h-4 w-4 cursor-pointer accent-green-600"
                              checked={selectedSubmissionIds.has(submission.id)}
                              onChange={() => toggleSubmissionSelection(submission.id)}
                              onClick={(e) => e.stopPropagation()}
                              disabled={isBusy || !inkSessionReady || !hasSubmissionImage(submission)}
                            />
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              void handleDeleteSubmission(submission, student)
                            }}
                            className="absolute bottom-2 left-2 p-1.5 bg-white/90 text-gray-700 rounded-full shadow-md opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-50 hover:text-red-600 z-10 disabled:opacity-50 disabled:cursor-not-allowed"
                            title="刪除此學生的作業"
                            disabled={isBusy}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </>
                      )}
                  </div>
                </div>

                <div className="p-3 flex-1 flex flex-col">
                  <div className="mb-1 flex items-center gap-2">
                    <span
                      className={`inline-flex min-w-[28px] items-center justify-center rounded-md border px-1.5 py-0.5 text-xs font-semibold ${sourceVisual.seatBadgeClass}`}
                    >
                      {student.seatNumber}
                    </span>
                    <p className="truncate text-sm font-semibold text-gray-900">{student.name}</p>
                  </div>
                  {status !== 'missing' && (
                    <p className={`text-[11px] font-medium ${sourceVisual.textClass}`}>
                      {isStub ? '老師手動標記' : sourceVisual.label}
                    </p>
                  )}
                  {submission?.id && <p className="text-[9px] text-gray-300 font-mono cursor-pointer hover:text-gray-500 truncate" title={submission.id} onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(submission.id) }}>{submission.id.slice(-8)}</p>}
                  {status === 'missing' && (
                    <div className="flex items-center justify-between mt-1">
                      <p className="text-xs text-gray-500">尚未繳交</p>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); void handleManualGradeStudent(student) }}
                        disabled={Boolean(manualGradingStudentId)}
                        className="text-[10px] font-medium text-emerald-600 hover:text-emerald-700 hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {manualGradingStudentId === student.id ? '處理中…' : '手動標記已批改'}
                      </button>
                    </div>
                  )}
                  {isManualGradeStub(submission) && (
                    <p className="text-xs font-medium text-emerald-600 mt-1">已完成批改</p>
                  )}
                  {(() => {
                    const cs = correctionStatusByStudent[student.id]
                    if (cs === 'correction_required') return <p className="text-xs font-medium text-amber-600 mt-1">待訂正</p>
                    if (cs === 'correction_in_progress') return <p className="text-xs font-medium text-blue-600 mt-1">訂正中</p>
                    if (cs === 'correction_pending_review') return <p className="text-xs font-medium text-violet-600 mt-1">待複查</p>
                    if (cs === 'correction_passed') return <p className="text-xs font-medium text-emerald-600 mt-1">已完成訂正</p>
                    if (cs === 'correction_failed') return <p className="text-xs font-medium text-rose-600 mt-1">訂正未通過</p>
                    // 已批改 + 有錯題 + 未進入訂正流程 → 提示老師可派發
                    // 全對學生（mistakes 為空）維持空白、不增加雜訊
                    const mistakeCount = submission?.gradingResult?.mistakes?.length ?? 0
                    if (submission?.status === 'graded' && mistakeCount > 0 && !isManualGradeStub(submission)) {
                      return <p className="text-xs font-medium text-orange-500 mt-1">未派發訂正（{mistakeCount} 題）</p>
                    }
                    return null
                  })()}
                </div>
              </div>
            )
          })}
        </div>
        )}

      </div>
      {/* Modal */}
      {selectedSubmission && (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
          onClick={handleCloseModal}
        >
          <div
            className="bg-white rounded-2xl w-full max-w-6xl h-[90vh] flex overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex-1 bg-gray-100 relative overflow-auto p-4">
              {(() => {
                const imageUrl = getSubmissionImageUrl(selectedSubmission.submission)
                const hasLocalOriginalImage =
                  Boolean(selectedSubmission.submission.imageBase64) ||
                  (selectedSubmission.submission.imageBlob?.size ?? 0) > 0
                const zoomImageUrl =
                  !hasLocalOriginalImage &&
                  selectedSubmission.submission.id
                    ? buildApiUrl(
                        `/api/storage/download?submissionId=${encodeURIComponent(
                          selectedSubmission.submission.id
                        )}`
                      )
                    : imageUrl
                const zoomBackgroundPosX =
                  -(previewLensState.x * PREVIEW_ZOOM_SCALE - PREVIEW_ZOOM_PANEL_SIZE / 2)
                const zoomBackgroundPosY =
                  -(previewLensState.y * PREVIEW_ZOOM_SCALE - PREVIEW_ZOOM_PANEL_SIZE / 2)
                return imageUrl ? (
                  <div className="min-w-full relative">
                    <p className="text-xs text-gray-500 mb-2">
                      可上下滑動查看完整作業
                    </p>
                    <div
                      className="relative w-full cursor-crosshair select-none"
                      onMouseMove={handlePreviewLensMove}
                      onMouseLeave={closePreviewLens}
                    >
                      <img
                        src={imageUrl}
                        alt="作業大圖"
                        className="w-full h-auto shadow-lg"
                        draggable={false}
                      />
                      {previewLensActive && (
                        <div
                          className="pointer-events-none absolute border-2 border-blue-500/90 bg-blue-200/10 shadow-[0_0_0_9999px_rgba(0,0,0,0.15)]"
                          style={{
                            width: PREVIEW_LENS_SIZE,
                            height: PREVIEW_LENS_SIZE,
                            left: previewLensState.lensLeft,
                            top: previewLensState.lensTop
                          }}
                        />
                      )}
                    </div>
                    {previewLensActive && previewLensState.width > 0 && previewLensState.height > 0 && (() => {
                      const panelW = PREVIEW_ZOOM_PANEL_SIZE + 20
                      const panelH = PREVIEW_ZOOM_PANEL_SIZE + 32
                      const offset = 24
                      const rawLeft = previewLensState.clientX + offset
                      const panelLeft = rawLeft + panelW > window.innerWidth
                        ? previewLensState.clientX - offset - panelW
                        : rawLeft
                      const panelTop = Math.max(8, Math.min(window.innerHeight - panelH - 8, previewLensState.clientY - panelH / 2))
                      return (
                      <div className="pointer-events-none fixed z-[120] rounded-xl border border-blue-200 bg-white/95 p-2 shadow-2xl" style={{ left: panelLeft, top: panelTop }}>
                        <div className="mb-1 text-[10px] font-semibold tracking-wide text-blue-700">
                          細節放大
                        </div>
                        <div
                          className="overflow-hidden rounded-lg border border-blue-100 bg-gray-50"
                          style={{
                            width: PREVIEW_ZOOM_PANEL_SIZE,
                            height: PREVIEW_ZOOM_PANEL_SIZE,
                            backgroundImage: zoomImageUrl ? `url(${zoomImageUrl})` : `url(${imageUrl})`,
                            backgroundRepeat: 'no-repeat',
                            backgroundSize: `${previewLensState.width * PREVIEW_ZOOM_SCALE}px ${
                              previewLensState.height * PREVIEW_ZOOM_SCALE
                            }px`,
                            backgroundPosition: `${zoomBackgroundPosX}px ${zoomBackgroundPosY}px`
                          }}
                        />
                      </div>
                    ) })()}
                  </div>
                ) : (
                  <div className="flex items-center justify-center h-full">
                    <div className="text-center text-gray-500">
                      <ImageIcon className="w-16 h-16 mx-auto mb-2" />
                      <p>圖片不可用</p>
                    </div>
                  </div>
                )
              })()}
            </div>

            <div className="w-full max-w-md border-l border-gray-200 flex flex-col bg-white">
              <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-gray-50">
                <div className="flex items-center gap-2">
                  {/* 🆕 複核導航按鈕 */}
                  {needsReviewCount > 0 && (
                    <div className="flex items-center gap-1 mr-2">
                      <button
                        onClick={jumpToPrevReview}
                        className="p-1.5 rounded-full hover:bg-gray-200 text-gray-500"
                        title="上一個待複核"
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </button>
                      <span className="text-xs text-amber-600 font-medium px-1">
                        {needsReviewStudents.findIndex(s => s.id === selectedSubmission.student.id) + 1}/{needsReviewCount}
                      </span>
                      <button
                        onClick={jumpToNextReview}
                        className="p-1.5 rounded-full hover:bg-gray-200 text-gray-500"
                        title="下一個待複核"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                  <div>
                    <h2 className="text-base font-semibold text-gray-900">
                      {selectedSubmission.student.seatNumber} 號 · {selectedSubmission.student.name}
                    </h2>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {classroom?.name} · {assignment?.title}
                    </p>
                  </div>
                </div>
                <button
                  onClick={handleCloseModal}
                  className="p-1 rounded-full hover:bg-gray-100 text-gray-500"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="flex-1 overflow-auto px-5 py-4 space-y-4">
                {/* 🆕 需複核警示 */}
                {isSubmissionNeedsReview(selectedSubmission.submission.gradingResult) && (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-amber-700">需要複核</p>
                        {selectedReviewReasons.length > 0 ? (
                          <ul className="mt-2 list-disc space-y-1.5 pl-5">
                            {selectedReviewReasons.map((reason, index) => (
                              <li
                                key={`${reason}-${index}`}
                                className="text-sm leading-6 text-amber-800 break-words"
                              >
                                {reason}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="mt-2 text-sm leading-6 text-amber-700">AI 建議人工檢查</p>
                        )}
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                      {selectedConfidenceLabel ? (
                        <p className="text-xs text-amber-700">{selectedConfidenceLabel}</p>
                      ) : (
                        <span />
                      )}
                      <button
                        onClick={async () => {
                          const id = selectedSubmission.submission.id
                          const submission = await db.submissions.get(id)
                          if (!submission?.gradingResult) return

                          const newGradingResult = {
                            ...submission.gradingResult,
                            needsReview: false,
                            reviewReasons: [],
                            manuallyReviewed: true
                          }
                          const totalScore = typeof newGradingResult.totalScore === 'number' ? newGradingResult.totalScore : undefined
                          const confirmNow = Date.now()
                          await db.submissions.update(id, {
                            gradingResult: newGradingResult,
                            ...(totalScore !== undefined ? { score: totalScore, aiScore: totalScore, scoreSource: 'ai' as const } : {}),
                            gradedAt: confirmNow,
                            updatedAt: confirmNow
                          })
                          if (totalScore !== undefined) {
                            fetch('/api/data/save-grading', {
                              method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
                              body: JSON.stringify({ submissions: [{ id, score: totalScore, aiScore: totalScore, scoreSource: 'ai', gradingResult: newGradingResult, gradedAt: confirmNow }] })
                            }).catch(() => {})
                          }
                          requestSync()

                          const updated = await db.submissions.get(id)
                          if (updated) {
                            setSubmissions((prev) => new Map(prev).set(updated.studentId, updated))
                            const student = students.find((s) => s.id === updated.studentId)
                            if (student) setSelectedSubmission({ submission: updated, student })
                          }
                        }}
                        className="inline-flex items-center gap-1 rounded-lg bg-amber-100 px-3 py-1.5 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-200"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        標記已複核
                      </button>
                    </div>
                  </div>
                )}

                {assignment?.scoringMode !== 'unscored' && (
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex flex-col gap-1">
                      <div className="flex items-baseline gap-2">
                        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                          總分
                        </span>
                        <span className="text-2xl font-bold text-gray-900">
                          {selectedSubmission.submission.gradingResult?.totalScore ??
                            selectedSubmission.submission.score ??
                            '-'}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500">依各題得分自動加總</p>
                    </div>
                    {selectedSubmission.submission.status === 'graded' && (
                      <span className="px-2 py-1 text-xs rounded-full bg-green-50 text-green-700 border border-green-200 font-semibold">
                        已批改
                      </span>
                    )}
                  </div>
                )}
                {assignment?.scoringMode === 'unscored' && selectedSubmission.submission.status === 'graded' && (
                  <div className="flex items-center justify-end mb-2">
                    <span className="px-2 py-1 text-xs rounded-full bg-green-50 text-green-700 border border-green-200 font-semibold">
                      已批改
                    </span>
                  </div>
                )}

                {/* 題目詳情（可調整） */}
                {editableDetails.length > 0 ? (
                  <div>
                    {isBusy && (
                      <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                        批改進行中，若要編輯請先停止批改
                      </div>
                    )}
                    <h3 className="font-bold text-gray-900 mb-3 flex items-center gap-2 text-sm uppercase tracking-wide">
                      <FileQuestion className="w-4 h-4 text-blue-500" /> 題目詳情
                    </h3>
                    <div className="space-y-3">
                      {editableDetails.map((d: any, i: number) => {
                        const safeScore = Number.isFinite(Number(d.score)) ? Number(d.score) : 0
                        const safeMax = Number.isFinite(Number(d.maxScore)) ? Number(d.maxScore) : 0
                        const isCorrect = safeMax > 0 ? safeScore >= safeMax : false
                        const isPartial = !isCorrect && safeScore > 0 && safeMax > 0
                        const isUnscored = assignment?.scoringMode === 'unscored'
                        const questionId = d.questionId || `#${i + 1}`

                        return (
                          <div
                            key={questionId}
                            className="border border-gray-200 rounded-lg p-3 bg-gray-50 text-xs space-y-2"
                          >
                            <div className="flex justify-between items-center gap-2">
                              <div className="flex items-center gap-2">
                                <span className="font-semibold text-gray-800">
                                  題目 {questionId}
                                </span>
                              </div>
                              <div
                                className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                                  isCorrect
                                    ? 'bg-green-100 text-green-700'
                                    : isPartial
                                      ? 'bg-amber-100 text-amber-700'
                                      : 'bg-red-100 text-red-700'
                                }`}
                              >
                                <span>{isCorrect ? '✓' : isPartial ? '△' : '✗'}</span>
                                {!isUnscored && (
                                  <>
                                  <input
                                    type="text"
                                    inputMode="numeric"
                                    pattern="[0-9]*\.?[0-9]*"
                                    className="w-14 px-1 py-0.5 rounded border border-white/60 bg-white/70 text-gray-800 text-[10px] text-center disabled:opacity-60 disabled:cursor-not-allowed"
                                    value={d.score ?? ''}
                                    disabled={isBusy || isSavingScore}
                                    onFocus={(e) => {
                                      // 點擊時自動選取全部文字，方便清除
                                      e.target.select()
                                    }}
                                    onChange={(e) => {
                                      const v = e.target.value
                                      // 允許數字和小數點
                                      if (v === '' || /^\d*\.?\d*$/.test(v)) {
                                        setEditableDetails((prev) => {
                                          const next = [...prev]
                                          next[i] = { ...next[i], score: v === '' ? '' : (v.endsWith('.') ? v : Number(v)) }
                                          return next
                                        })
                                      }
                                    }}
                                    onBlur={(e) => {
                                      const num = Number(e.target.value)
                                      void handleDetailScoreChange(i, Number.isFinite(num) ? num : 0)
                                    }}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') {
                                        e.preventDefault()
                                        const num = Number((e.target as HTMLInputElement).value)
                                        void handleDetailScoreChange(i, Number.isFinite(num) ? num : 0)
                                      }
                                    }}
                                  />
                                  <span>/ {d.maxScore}</span>
                                  </>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center gap-2 text-gray-700">
                              <span className="flex-1">學生答案：{d.studentAnswer || '—'}</span>
                            </div>

                            <div className="text-xs text-gray-700 flex items-start gap-2">
                              <span className="mt-0.5 shrink-0">理由：</span>
                              <span className="text-gray-600 whitespace-pre-line flex-1">
                                {d.reason || '—'}
                              </span>
                            </div>

                            {/* table_cell 群組批改：顯示每 cell 對錯細節 */}
                            {Array.isArray(d.cellResults) && d.cellResults.length > 0 && (
                              <div className="mt-2 border-t border-gray-200 pt-2">
                                <div className="text-[11px] font-semibold text-gray-600 mb-1.5">每格對錯：</div>
                                <div className="space-y-1">
                                  {d.cellResults.map((cr: any, ci: number) => (
                                    <div
                                      key={`${cr.row}-${cr.col}-${ci}`}
                                      className={`flex items-center gap-2 px-2 py-1 rounded text-[11px] ${
                                        cr.correct
                                          ? 'bg-green-50 border border-green-100'
                                          : 'bg-red-50 border border-red-100'
                                      }`}
                                    >
                                      <span className="shrink-0 font-semibold w-4 text-center">
                                        {cr.correct ? '✓' : '✗'}
                                      </span>
                                      <span className="shrink-0 text-gray-500 min-w-[3rem]">
                                        {cr.label || `r${cr.row}c${cr.col}`}
                                      </span>
                                      <span className="shrink-0 text-gray-700">
                                        學生：<span className="font-medium">{cr.student || '（空）'}</span>
                                      </span>
                                      {!cr.correct && (
                                        <>
                                          <span className="shrink-0 text-gray-400">→</span>
                                          <span className="shrink-0 text-gray-700">
                                            正解：<span className="font-medium text-green-700">{cr.expected}</span>
                                          </span>
                                          {cr.reason && (
                                            <span className="shrink-0 text-red-600 ml-auto truncate">
                                              {cr.reason}
                                            </span>
                                          )}
                                        </>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="bg-yellow-50 border border-yellow-100 rounded-lg p-3 text-xs text-yellow-800">
                    暫無題目詳情
                  </div>
                )}

                {!selectedSubmission.submission.gradingResult?.details &&
                  selectedSubmission.submission.feedback && (
                    <div className="text-gray-500 text-sm text-center italic py-4">
                      這是舊版批改紀錄，建議重新批改更新 AI 結果
                    </div>
                  )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
