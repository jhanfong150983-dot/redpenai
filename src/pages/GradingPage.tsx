
import { useState, useEffect, useCallback, useMemo, useRef, type MouseEvent as ReactMouseEvent, type WheelEvent as ReactWheelEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import Button from '@/components/ui/Button'
import InkConfirmModal from '@/components/InkConfirmModal'
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
  ChevronDown,
  ZoomIn,
  Plus
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
  type PipelineFailure,
  type GradingStageName
} from '@/lib/gemini'
import { buildApiUrl } from '@/lib/api-base'
import { startInkSession, closeInkSession, getInkSessionId } from '@/lib/ink-session'
import { downloadImageFromSupabase } from '@/lib/supabase-download'
import { getSubmissionImageUrl, fixCorruptedBase64 } from '@/lib/utils'
import SubmissionThumbnail from '@/components/SubmissionThumbnail'
import DangerConfirmModal from '@/components/DangerConfirmModal'
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
// 2026-06-20: 共用併發限制器（令牌桶）。串流管線中 read+arbiter / 乾淨卷 PhaseB / 複核卷 PhaseB
//   共用同一個 semaphore、把同時打 Gemini 的重請求總量壓住，避免撞 Gemini/Vercel 300s → 504。
function makeSemaphore(max: number) {
  let active = 0
  const waiters: Array<() => void> = []
  const acquire = (): Promise<void> =>
    new Promise((resolve) => {
      if (active < max) { active++; resolve() } else waiters.push(resolve)
    })
  const release = () => {
    active = Math.max(0, active - 1)
    const next = waiters.shift()
    if (next) { active++; next() }
  }
  const run = async <T,>(fn: () => Promise<T>): Promise<T> => {
    await acquire()
    try { return await fn() } finally { release() }
  }
  return { run }
}

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
 * 2026-05-28: 判斷 Phase A 是否比 Phase B 新（即「Phase A 重跑後、Phase B 還沒跑」的狀態）
 * 用途：UI 顯示時把這種 case 視為「待批改」、不顯示舊 score / 舊狀態
 * 規則：phaseAState.savedAt > gradedAt （strict >）
 *
 * 為什麼用 timestamp 比、不真的清資料：
 * - 清 sub.score / sub.status 會撞 useSync local-first 規則 (useSync.ts:1083)、
 *   sync 把 server 舊值再 fallback 回來、UI 又看到舊資料
 * - 不動 schema、不動 server、純 client 比 timestamp 是最低風險路徑
 * - Phase B 跑完 gradedAt 會更新到比 savedAt 新、自動「unstale」恢復顯示
 *
 * 2026-05-28 correction_passed 守護:
 * - 訂正完成 = 終點、Phase A 重跑不該蓋掉「已批改」顯示
 * - caller 從 correctionStatusByStudent 拿到 status、傳進來、避免改 deriveCardStage 簽名
 */
export function isPhaseAStale(sub: Submission | undefined, correctionStatus?: string): boolean {
  if (!sub) return false
  if (correctionStatus === 'correction_passed') return false
  const savedAtRaw = sub.phaseAState?.savedAt
  const pasAt = typeof savedAtRaw === 'string' ? new Date(savedAtRaw).getTime()
    : typeof savedAtRaw === 'number' ? savedAtRaw : 0
  const gradedAt = typeof sub.gradedAt === 'number' ? sub.gradedAt : 0
  return pasAt > 0 && pasAt > gradedAt
}

// 2026-05-30: 「需老師確認」的單一定義（卡片 + detail banner + 審查面板 + Phase B 閘門共用）
const VJ_REVIEW_TYPES = ['diagram_color', 'map_symbol', 'grid_geometry']
/**
 * 一題是否需要老師確認 = AI 標 needs_review，或「答案空白」需確認真空白。
 * map_fill / VJ 有自己的逐位置 / 逐柱確認流程（排除、不走這條空白判斷）。
 */
export function questionNeedsConfirm(arbiterStatus?: string, finalAnswer?: string, questionType?: string): boolean {
  if (arbiterStatus === 'needs_review') return true
  if (questionType === 'map_fill' || VJ_REVIEW_TYPES.includes(questionType || '')) return false
  // 空白（arbiter 同意但最終答案空）→ 要老師在審查面板確認「真空白 / 其實有寫」
  if (arbiterStatus === 'arbitrated_agree' && !(finalAnswer || '').trim()) return true
  return false
}

/**
 * 整份卷是否「還有未確認的待複核題」——卡片與 detail banner 的唯一事實來源。
 * - 未審查 / stale → 看 phase_a_state.arbiterDecisions（含 blank 偵測）有沒有未確認題
 * - 已審查（非 stale + 有 finalAnswers）→ 審查面板已逐題確認（含 blank），只剩殘留：
 *     A 漏題（需確認題沒 finalAnswer）。（2026-06-01：B「無法辨識」已移除，不再是資料/觸發源。）
 */
export function submissionPendingReview(sub?: Submission, correctionStatus?: string): boolean {
  if (!sub) return false
  if (sub.gradingResult?.manuallyReviewed) return false // 舊資料相容
  const stale = isPhaseAStale(sub, correctionStatus)
  if (sub.status === 'graded' && !stale) return false // Phase B 完成 = 已處理

  const details = (sub.gradingResult as { details?: Array<{ questionId?: string; questionType?: string; arbiterResult?: { arbiterStatus?: string; finalAnswer?: string } }> } | undefined)?.details ?? []
  const typeByQid = new Map(details.map((d) => [d.questionId, d.questionType]))

  // 已審查：只看「需確認(needs_review/空白)且缺 finalAnswer」的殘留題。
  // 2026-05-30: 不可加 !stale 閘 — isPhaseAStale 對「Phase A 完、還沒 Phase B」一律 true(gradedAt=0)，
  // 會把「已審查確認過、只是還沒批改」的卷誤判成未審查、又拿 arbiterDecisions 重新吐 needs_review。
  // 原本卡片 deriveCardStage 就是無條件看 finalAnswers，這裡跟它對齊。
  // 2026-06-01 Phase4: 移除 hasUnrecognizable —「無法辨識」不再是一種資料/決定（按鈕已改「看原圖」）。
  //   待複核 = needs_review 或 空白；舊卷殘留的 '無法辨識' finalAnswer 不再單獨觸發待複核。
  const finalAnswers = sub.finalAnswers
  if (Array.isArray(finalAnswers) && finalAnswers.length > 0) {
    const finalByQid = new Map(finalAnswers.map((fa) => [fa.questionId, fa.finalStudentAnswer]))
    // 2026-05-31: 「漏題」只算「需確認(needs_review/空白)且沒 finalAnswer」的題。
    // 重跑 Phase A 後只留 manual finalAnswers、其餘清掉、但那些「一致」題即使沒 finalAnswer 也會在
    // Phase B 自動採用新讀取、不需老師看 → 不能算 pending(否則重批完一致題會一直顯示「需要複核」)。
    const decisions = (sub.phaseAState?.arbiterDecisions ?? []) as Array<{ questionId?: string; arbiterStatus?: string; finalAnswer?: string }>
    const needsConfirmMissing = decisions.some((d) =>
      questionNeedsConfirm(d.arbiterStatus, d.finalAnswer, typeByQid.get(d.questionId ?? '')) && !finalByQid.has(d.questionId ?? '')) // A
    return needsConfirmMissing
  }

  // 未審查 / stale：用 arbiterDecisions（含 blank）
  const decisions = (sub.phaseAState?.arbiterDecisions ?? []) as Array<{ questionId?: string; arbiterStatus?: string; finalAnswer?: string }>
  if (decisions.length > 0) {
    return decisions.some((d) => questionNeedsConfirm(d.arbiterStatus, d.finalAnswer, typeByQid.get(d.questionId)))
  }
  if (details.length > 0) {
    return details.some((d) => questionNeedsConfirm(d.arbiterResult?.arbiterStatus, d.arbiterResult?.finalAnswer, d.questionType))
  }
  return false
}

/**
 * 2026-05-17: 從 Submission 衍生卡片狀態
 * 用於：卡片 badge / 動態按鈕邏輯 / Modal 攜截檢查
 * 2026-05-28: 加 correctionStatus 可選參數、correction_passed 學生忽略 stale 判斷
 */
export function deriveCardStage(sub: Submission | undefined, correctionStatus?: string): CardStage {
  if (!sub) return 'not_submitted'
  if (isManualGradeStub(sub)) return 'manual_marked'

  // 'missing' / 'scanned' 沒實際圖
  if (sub.status === 'missing') return 'not_submitted'

  // pipelineFailure 分流：stage 在 Phase A 還是 Phase B
  // 2026-05-25: 若 status=grading_failed 但無 pipelineFailure metadata（例如後端
  // 寫入失敗、或前端 sync race），預設當 phase_a_failed、至少讓老師看到「擷取失敗」
  // 紅色徽章而不是空白卡片。
  const failure = (sub.gradingResult as { pipelineFailure?: { stage?: string } } | undefined)?.pipelineFailure
  if (sub.status === 'grading_failed') {
    if (failure?.stage) {
      const stage = failure.stage
      const isPhaseBStage = stage === 'accessor' || stage === 'explain' || stage === 'phase_b'
      return isPhaseBStage ? 'phase_b_failed' : 'phase_a_failed'
    }
    return 'phase_a_failed'
  }

  // XX 分：明確 graded + 有 score、且 Phase A 沒有比 Phase B 新（避免 Phase A 重跑後顯示舊 score）
  if (sub.status === 'graded' && sub.score != null && !isPhaseAStale(sub, correctionStatus)) return 'graded'

  // 2026-06-01: 「待複核」不再是獨立卡片狀態。Phase A 跑了但人工審查沒做完（還有未確認題）
  //   = Phase A 未完成 = 未擷取（已上傳）；唯有審查完成、finalAnswers 存檔（或乾淨卷無待確認題）
  //   才算擷取完成 → 待批改。模型更乾淨：已上傳 → (Phase A + 審查完成) → 待批改 → 已批改。
  const finalAnswers = sub.finalAnswers
  const phaseAState = sub.phaseAState
  const details = (sub.gradingResult as { details?: unknown[] } | undefined)?.details
  const isExtracted =
    (Array.isArray(finalAnswers) && finalAnswers.length > 0) ||
    (Array.isArray(phaseAState?.arbiterDecisions) && phaseAState.arbiterDecisions.length > 0) ||
    (Array.isArray(details) && details.length > 0)
  if (isExtracted) {
    // 還有待確認題（needs_review/空白）→ 視為未擷取（審查沒做完=Phase A 沒完成）；全部確認 → 待批改
    return submissionPendingReview(sub, correctionStatus) ? 'not_extracted' : 'pending_grading'
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

/**
 * gradePhaseA 拋出 exception（網路斷、JSON parse 失敗、unexpected response shape）時的 DB 持久化。
 *
 * 2026-05-25 修：原本 catch 路徑只 console.error、不寫 DB → 卡片 status 還是 'synced'、
 * 老師看到「已上傳」徽章誤以為還沒批改（李宥均 case：Vercel log 顯示 phase_a_classify 500、
 * 但 DB 沒翻 grading_failed）。
 *
 * 這個 helper 包裝 success-failure 路徑的同等動作：寫 local DB + POST 到 server
 * /api/data/save-grading、塞一個 synthetic pipelineFailure metadata 讓 deriveCardStage
 * 能算出 phase_a_failed、卡片顯示紅色「擷取失敗」徽章。
 */
async function persistGradingFailureFromException(submissionId: string, errorMessage: string, failureOverride?: import('@/lib/gemini').PipelineFailure) {
  const failure: import('@/lib/gemini').PipelineFailure = failureOverride ?? {
    stage: 'classify',
    reasonCode: 'CLIENT_EXCEPTION',
    // 2026-06-20: 老師看友善句（① AI 暫時出錯）；真實錯誤留 technical.metrics.errorMessage 供除錯
    userMessage: '🙂 AI 剛剛有點忙、出了點小差錯。再請它批一次，通常就好了。',
    userAction: '',
    technical: { metrics: { errorMessage } as Record<string, unknown> }
  }
  const failureGradingResult = { pipelineFailure: failure } as unknown as import('@/lib/db').GradingResult
  const updatedAt = Date.now()
  await db.submissions.update(submissionId, {
    status: 'grading_failed',
    gradingResult: failureGradingResult,
    updatedAt,
  }).catch((e) => console.warn('[persistGradingFailureFromException] db update failed', e))
  fetch(buildApiUrl('/api/data/save-grading'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      submissions: [{ id: submissionId, status: 'grading_failed', gradingResult: { pipelineFailure: failure } }],
    }),
  }).catch(() => {})
  return { failure, failureGradingResult, updatedAt }
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

const CORRECTION_BLOCKING_STATUSES = new Set(['correction_required', 'correction_in_progress'])

const CORRECTION_STATUS_LABEL_MAP: Record<string, string> = {
  correction_required: '待訂正',
  correction_in_progress: '訂正中'
}

// 2026-06-01: STAGE_LABEL_MAP / formatDisplayQuestionId / isSubmissionNeedsReview /
//   toUserFriendlyReviewReason 隨「待複核」概念與其 detail 橫幅一併移除。
//   待複核 = 未擷取（deriveCardStage 直接判定）、複核走智慧批改流程、不再有 detail 複核提示。

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
  onNavigateToCorrection?: () => void
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

// 2026-05-18: Phase A only mode 專用 summary
//   - 觸發時機：執行「截取答案」→ Phase A 全部完成（含人工審查或無需審查）
//   - 跟 GradeResultNotice 分開：Phase A 沒有「重新批改」概念、失敗動作叫「重新讀取」
//   - failedCandidates：Phase A pipelineFailure 的 Submission、按鈕重跑 executeRecaptureOnly
type PhaseAResultNotice = {
  stopped: boolean
  successCount: number        // Phase A 成功（含通過審查）的份數
  failCount: number           // Phase A pipelineFailure 的份數
  needsReviewedCount: number  // 進審查頁的份數（已被老師審查完）
  totalCount: number
  failReasons: string[]
  failedCandidates: Submission[]  // 失敗的 Submission、按鈕重跑 executeRecaptureOnly
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

// 2026-06-02: export 供學生自助批改 StudentPortal 重用（單卷複核）。
export interface ConsistencyDecision {
  questionId: string
  source: 'ai_read1' | 'ai_read2' | 'ai_arbiter' | 'manual' | 'unrecognizable' | 'blank'
  finalAnswer: string
  confirmed: boolean
  // 2026-05-28: map_fill 每位置決策（per-position source + 最終文字）
  // 當 questionType === 'map_fill' 時、source 是「整題狀態的彙整」、實際 per-position 結果在這
  mapFillPerPosition?: Array<{
    idx: number
    source: 'ai_read1' | 'ai_read2' | 'blank' | 'manual'
    finalText: string
  }>
  // 2026-05-30: VJ 視覺判斷題 per-item 老師確認「有沒有畫」（只需確認 review_blank 的項）
  vjPerItem?: Array<{ idx: number; isBlank: boolean }>
}

// 2026-05-28: module-level helper — 對單一 questionResult 構造 FinalAnswer
// map_fill 特殊路徑：組 mapFillFinalReadings (per-position confirmed)
// 一致的位置 → 自動用 AI1 read（兩 AI 相同）
// 不一致的位置 → 用 decision.mapFillPerPosition[idx] 老師的選擇
export function buildFinalAnswerForQR(qr: PhaseAQuestionResult, decision: ConsistencyDecision | undefined): FinalAnswer {
  // VJ 視覺判斷題：組 vjBlankConfirmed（auto_not_blank→有畫；review_blank→老師決定，沒選=空白）
  if (qr.questionType && ['diagram_color', 'map_symbol', 'grid_geometry'].includes(qr.questionType)
    && qr.visualJudgment && Array.isArray(qr.visualJudgment.perItem)) {
    const overrides = new Map((decision?.vjPerItem || []).map((d) => [d.idx, d]))
    const confirmed: Array<{ idx: number; isBlank: boolean }> = []
    const summary: string[] = []
    for (const p of qr.visualJudgment.perItem) {
      let isBlank: boolean
      if (p.status === 'auto_not_blank') {
        isBlank = false  // PRO 確定有畫
      } else {
        const od = overrides.get(p.idx)
        isBlank = od ? od.isBlank : true  // review：老師決定，沒選 = 視為空白
      }
      confirmed.push({ idx: p.idx, isBlank })
      summary.push(`${p.label}:${isBlank ? '未作答' : '已作答'}`)
    }
    return {
      questionId: qr.questionId,
      finalStudentAnswer: summary.join('、'),
      finalAnswerSource: 'manual',
      vjBlankConfirmed: confirmed
    }
  }
  if (qr.questionType === 'map_fill' && qr.mapFillReadings && Array.isArray(qr.mapFillReadings.perPosition)) {
    const perPos = qr.mapFillReadings.perPosition
    const overrides = new Map((decision?.mapFillPerPosition || []).map((d) => [d.idx, d]))
    const readings: Array<{ position_idx: number; student_text: string }> = []
    const summaryParts: string[] = []
    for (const p of perPos) {
      let text: string
      if (p.consistent) {
        text = p.ai1_text || ''  // 兩 AI 一致 → 用 AI1
      } else {
        const od = overrides.get(p.idx)
        text = od ? od.finalText : ''  // 不一致：老師決定、沒選 = 空白
      }
      readings.push({ position_idx: p.idx, student_text: text })
      if (text) summaryParts.push(text)
    }
    return {
      questionId: qr.questionId,
      finalStudentAnswer: summaryParts.join(', '),
      finalAnswerSource: 'manual',
      mapFillFinalReadings: readings
    }
  }
  const src = decision?.source ?? 'ai_read1'
  return {
    questionId: qr.questionId,
    // 2026-06-20: qr.readAnswer1 可能 undefined（word_problem/calculation 等走 finalAnswerOnly read、
    //   或某題沒讀到 → 不設 readAnswer1）。原本直接 .studentAnswer 會丟 TypeError、
    //   讓 onStudentConfirmed 整個 throw → handleConfirmAndNext 的 await 被 reject(fire-and-forget)
    //   → 後面的「下一位 / onAllDone」都不執行 →「確認送出沒反應」。改用可選鏈 + 預設空字串。
    finalStudentAnswer: src === 'unrecognizable' ? '無法辨識' : src === 'blank' ? '' : (decision?.finalAnswer ?? qr.readAnswer1?.studentAnswer ?? ''),
    finalAnswerSource: src === 'blank' ? 'manual' : src,
  }
}

// 2026-05-31: 重批(Phase B fromCache)時、用刷新後的 phaseAState 重建「AI 自動題」的最終答案。
// 為什麼：sync 對 finalAnswers 是 local-first（useSync.ts:1105、保護老師 detail edit）、對 phaseAState 是
//   server-first（line 1096）→ Phase A 重跑刷新了 phaseAState 的新 read、finalAnswers 卻凍在舊值、
//   重批又直接拿舊 finalAnswers（executeGradeOnlyCache:3708）去批 → Phase A 等於白跑、批的是舊（可能 AI 誤讀）的答案。
// 修：重建非手改題的最終答案 = phaseAState.arbiterDecisions 解出的最新 read；**只保留 source='manual'**
//   （老師在 detail 明確手改、含 VJ 逐柱 / map_fill 逐格 / 無法辨識改字、其 source 皆為 'manual'）。
function rebuildFinalAnswersFromPhaseAState(
  phaseAState: Submission['phaseAState'] | undefined,
  existing: FinalAnswer[] | undefined
): FinalAnswer[] | undefined {
  const ps = phaseAState as {
    arbiterDecisions?: Array<{ questionId?: string; finalAnswer?: string; arbiterStatus?: string }>
  } | undefined
  const decisions = Array.isArray(ps?.arbiterDecisions) ? ps!.arbiterDecisions! : []
  if (decisions.length === 0) return existing  // 沒新 read（arbiterDecisions 空）可重建 → 原樣返回
  const arbByQid = new Map(
    decisions.filter((d) => d?.questionId).map((d) => [d.questionId as string, d])
  )
  const existingArr = Array.isArray(existing) ? existing : []
  const existingQids = new Set(existingArr.map((fa) => fa.questionId))
  // 1. 既有題：手改(manual)保留、AI 自動題用最新 read 刷新
  const refreshed = existingArr.map((fa) => {
    if (fa.finalAnswerSource === 'manual') return fa
    const arb = arbByQid.get(fa.questionId)
    if (!arb || typeof arb.finalAnswer !== 'string') return fa
    return { ...fa, finalStudentAnswer: arb.finalAnswer }
  })
  // 2. 2026-05-31 一鍵 1c 重做需要:arbiterDecisions 有、但 existing 沒有的題 → 補進來。
  //    新擷取卷(空 finalAnswers)走這條、從 Phase A 讀取建出完整答案、統一 Phase B 才有答案可批。
  //    needs_review 題(arbiter 無 finalAnswer)略過——由審查面板補;blank(finalAnswer='')視為未作答補上。
  const added: FinalAnswer[] = []
  for (const d of decisions) {
    if (!d?.questionId || existingQids.has(d.questionId)) continue
    if (typeof d.finalAnswer !== 'string') continue
    added.push({ questionId: d.questionId, finalStudentAnswer: d.finalAnswer, finalAnswerSource: 'ai_read1' })
  }
  return [...refreshed, ...added]
}

interface BatchPhaseAEntry {
  submissionId: string
  studentId: string
  phaseAResult: PhaseAResult
  decisions: Map<string, ConsistencyDecision>
  imageBlob: Blob
  pageBreaks?: number[]  // 2026-06-01 Phase4: 多頁合併比例、「看原圖」切單頁用
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

// 2026-06-20: 失敗原因安全轉字串。pipelineFailure.userMessage 或 throw 的 err 可能是物件，
//   直接 `${}` 字串化會變 "[object Object]"（等於沒寫）。依序遞迴找可讀字串欄位、再退 JSON、最後 String()。
function safeFailMsg(x: unknown, depth = 0): string {
  if (x == null) return '未知錯誤'
  if (typeof x === 'string') return x.trim() || '未知錯誤'
  if (x instanceof Error) return x.message || '未知錯誤'
  if (typeof x === 'object' && depth < 3) {
    const o = x as Record<string, unknown>
    for (const k of ['userMessage', 'message', 'error', 'reason']) {
      if (o[k] != null) {
        const r = safeFailMsg(o[k], depth + 1)
        if (r && r !== '未知錯誤') return r
      }
    }
    try { const s = JSON.stringify(x); if (s && s !== '{}' && s !== '[]') return s } catch { /* noop */ }
  }
  return String(x)
}

type Bbox = { x: number; y: number; w: number; h: number }

// baseline 值帶 n＝有幾份 peer 框到這題（缺框偵測用：多數 peer 都框到、這份卻沒框＝漏定位）。
function computePeerBaseline(entries: BatchPhaseAEntry[], excludeSubId: string): Map<string, Bbox & { n: number }> {
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
  const baseline = new Map<string, Bbox & { n: number }>()
  for (const [qid, list] of bboxesByQid) {
    baseline.set(qid, {
      x: _median(list.map((b) => b.x)),
      y: _median(list.map((b) => b.y)),
      w: _median(list.map((b) => b.w)),
      h: _median(list.map((b) => b.h)),
      n: list.length,
    })
  }
  return baseline
}

// dx 只在「框＝印刷版面固定區域」型可靠；填空/作答框的 x 因人/因選項/因 passage 寬度天生變動，dx 不可用。
// circle_select_one(with_questions 圈選題)：框是印刷選項整列、位置固定→實測 401 卷核心 std≈0.01、
//   28-29/30 落在中位數±0.03，X 漂移(離群最大 0.105)可靠可偵測，故納入。
//   注意：answer_only 模式 dxThreshold 預設 Infinity、dx 一律不檢查，本集合只影響 PDF/with_questions。
const DX_RELIABLE_TYPES = new Set(['single_choice', 'multi_choice', 'true_false', 'table_cell', 'table_check', 'multi_fill', 'circle_select_one'])

function checkPeerOutliers(
  entry: BatchPhaseAEntry,
  peerBaseline: Map<string, Bbox & { n?: number }>,
  opts: { dyThreshold?: number; dxThreshold?: number; minOutlierCount?: number; detectMissing?: boolean; peerTotal?: number; missingConsensus?: number } = {}
): { trip: boolean; outlierCount: number; outlierQids: string[]; metrics: { dy_med: number; dx_med: number } } {
  // 預設＝answer_only 既有行為：dy-only、門檻 0.025、需 ≥10 格。
  // PDF 模式傳 { dyThreshold: 0.015, dxThreshold: 0.08, minOutlierCount: 1, detectMissing: true, peerTotal, missingConsensus: 0.7 }：
  //   逐格 |dy|>0.015(任型) 或 |dx|>0.08(僅位置固定型 DX_RELIABLE_TYPES)，任一格中即 trip。
  //   門檻依實測乾淨雜訊地板校準(401英語卷 30人)：乾淨 dy max 0.009、固定型 dx max 0.044；
  //   漂移實測 dy~0.024(18/20/27號) / dx~0.42(30號)。dx 不碰圈選/填空(乾淨即可達 0.04~0.16)。
  // detectMissing：peer 多數(n/peerTotal ≥ missingConsensus)都框到的題、這份卻完全沒框 → 算漏定位 outlier、
  //   重跑救回（classify 隨機、重擲常可框出）。with_questions 印刷題框恆在、缺框＝漏定位非空白；
  //   answer_only 框在學生作答處、空白本就無框 → 預設關閉。
  const { dyThreshold = 0.025, dxThreshold = Infinity, minOutlierCount = 10, detectMissing = false, peerTotal = 0, missingConsensus = 0.7 } = opts
  const outlierQids: string[] = []
  const presentQids = new Set<string>()
  const dys: number[] = []
  const dxs: number[] = []
  for (const qr of entry.phaseAResult.questionResults) {
    const bb = qr.answerBbox as Bbox | undefined
    if (bb && typeof bb.x === 'number') presentQids.add(qr.questionId)
    const peer = peerBaseline.get(qr.questionId)
    if (!bb || !peer) continue
    const dy = bb.y - peer.y
    const dx = bb.x - peer.x
    dys.push(dy)
    dxs.push(dx)
    const dyOut = Math.abs(dy) > dyThreshold
    const dxOut = Math.abs(dx) > dxThreshold && DX_RELIABLE_TYPES.has(qr.questionType ?? '')
    if (dyOut || dxOut) outlierQids.push(qr.questionId)
  }
  // 缺框偵測（與漂移分開、各自可觸發）
  if (detectMissing && peerTotal > 0) {
    for (const [qid, peer] of peerBaseline) {
      const n = peer.n ?? 0
      if (n / peerTotal >= missingConsensus && !presentQids.has(qid)) outlierQids.push(qid)
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
// 2026-05-18: 5 階段顯示（classify / read / arbiter / accessor / explain）

type PipelineStageStatus = 'pending' | 'active' | 'done' | 'inactive'

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
    inactive: { circle: '#f3f4f6', text: '#d1d5db', sub: '#e5e7eb' },
  }
  const c = colors[status]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.35rem', minWidth: '72px', flex: 1 }}>
      <div style={{
        width: '2.25rem', height: '2.25rem', borderRadius: '50%',
        background: c.circle,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        position: 'relative',
        boxShadow: status === 'active' ? '0 0 0 4px #ede9fe' : undefined,
      }}>
        {status === 'done' ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : status === 'active' ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 1.2s linear infinite' }}>
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
        ) : (
          <span style={{ fontSize: '0.7rem', fontWeight: 700, color: status === 'inactive' ? '#d1d5db' : '#9ca3af' }}>{index}</span>
        )}
      </div>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '0.72rem', fontWeight: 700, color: c.text, whiteSpace: 'nowrap' }}>{label}</div>
        <div style={{ fontSize: '0.65rem', color: c.sub, marginTop: '0.1rem', whiteSpace: 'nowrap' }}>{sublabel}</div>
      </div>
    </div>
  )
}

export type GradingPipelineMode = 'phase_a_only' | 'phase_b_only' | 'both'

export interface PipelineStageProgress {
  classify: { started: number; done: number; total: number }
  read: { started: number; done: number; total: number }
  arbiter: { started: number; done: number; total: number }
  // 2026-06-19: quality＝UI-only 階段（peer 框位品質檢查 + 自動重跑），不對應 gemini.ts 的 AI pipeline stage。
  //   total=0＝比對中；total>0＝重跑中(done/total)；started=0＝本次 run 沒做品質檢查(overlay 不顯示這格)。
  quality: { started: number; done: number; total: number }
  accessor: { started: number; done: number; total: number }
  explain: { started: number; done: number; total: number }
}

export const EMPTY_PIPELINE_STAGE_PROGRESS: PipelineStageProgress = {
  classify: { started: 0, done: 0, total: 0 },
  read: { started: 0, done: 0, total: 0 },
  arbiter: { started: 0, done: 0, total: 0 },
  quality: { started: 0, done: 0, total: 0 },
  accessor: { started: 0, done: 0, total: 0 },
  explain: { started: 0, done: 0, total: 0 },
}

interface GradingPipelineOverlayProps {
  mode: GradingPipelineMode
  stageProgress: PipelineStageProgress
  phaseANeedsReviewCount: number
  phaseATotalQuestionCount: number
  gradingMessage: string
  stopRequested: boolean
  onStop: () => void
}

// OverlayStageName＝AI pipeline stages（gemini.ts 的 GradingStageName）+ UI-only 的 'quality'。
// quality 插在 Phase A(arbiter) 之後、Phase B(accessor) 之前＝框位品質檢查的時間點。
type OverlayStageName = GradingStageName | 'quality'
const STAGE_ORDER: OverlayStageName[] = ['classify', 'read', 'arbiter', 'quality', 'accessor', 'explain']
const STAGE_LABELS: Record<OverlayStageName, string> = {
  classify: '版面掃描',
  read: '讀取答案',
  arbiter: '仔細校對',
  quality: '品質檢查',
  accessor: '批改評分',
  explain: '生成引導',
}

function isStageInMode(stage: OverlayStageName, mode: GradingPipelineMode): boolean {
  if (mode === 'phase_a_only') return stage === 'classify' || stage === 'read' || stage === 'arbiter' || stage === 'quality'
  if (mode === 'phase_b_only') return stage === 'accessor' || stage === 'explain'
  return true
}

function GradingPipelineOverlay({
  mode,
  stageProgress,
  phaseANeedsReviewCount,
  phaseATotalQuestionCount,
  gradingMessage,
  stopRequested,
  onStop,
}: GradingPipelineOverlayProps) {
  // 推導每個 stage 狀態（pipeline 是並行的、每份 submission 獨立往下跑）：
  //   inactive — 不在本次 run（mode 不涵蓋）
  //   done     — done === total 且 total > 0（全部完成）
  //   active   — started > 0 但 done < total（至少一份在跑這個 stage）
  //   pending  — started === 0（還沒有 submission 跑到這個 stage）
  const stages = STAGE_ORDER
    // quality 是動態階段：只有本次 run 真的做了框位品質檢查(started>0)才顯示這格；
    // 照片卷/小批量不做 peer 檢查時就不冒出這格(維持原本步驟數)。
    .filter((stage) => stage !== 'quality' || stageProgress.quality.started > 0)
    .map((stage): { stage: OverlayStageName; status: PipelineStageStatus; sublabel: string } => {
      if (!isStageInMode(stage, mode)) {
        return { stage, status: 'inactive', sublabel: '—' }
      }
      if (stage === 'quality') {
        // total=0＝比對中(尚未知幾份要重跑)；total>0＝重跑中(done/total)；done>=total＝已複查完成。
        const { done, total } = stageProgress.quality
        if (total === 0) return { stage, status: 'active', sublabel: '比對中…' }
        if (done >= total) return { stage, status: 'done', sublabel: '已複查' }
        return { stage, status: 'active', sublabel: `重跑 ${done}/${total}…` }
      }
      const { started, done, total } = stageProgress[stage]
      if (total > 0 && done >= total) {
        return { stage, status: 'done', sublabel: `${done}/${total}` }
      }
      if (started > 0) {
        // 有人在跑、有人完成 → 顯示 done/total（active）
        return { stage, status: 'active', sublabel: total > 0 ? `${done}/${total}` : '進行中…' }
      }
      return { stage, status: 'pending', sublabel: total > 0 ? `${done}/${total}` : '等待中' }
    })

  // 是否在 Phase A 階段（用來決定要不要顯示需審查提示）— 任一 Phase A stage 還在跑
  const isPhaseA = stages.some(
    (s) => (s.stage === 'classify' || s.stage === 'read' || s.stage === 'arbiter') && s.status === 'active'
  )

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
        padding: '2rem 2.5rem', minWidth: '560px', maxWidth: '90vw',
        display: 'flex', flexDirection: 'column', gap: '1.5rem', alignItems: 'center',
      }}>
        {/* Title */}
        <div style={{ textAlign: 'center' }} role="status" aria-live="polite">
          <div style={{ fontSize: '1rem', fontWeight: 700, color: '#111827' }}>AI 批改進行中</div>
          <div style={{ fontSize: '0.8rem', color: '#6b7280', marginTop: '0.25rem' }}>{gradingMessage}</div>
        </div>

        {/* Pipeline stages — 5 階段 */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', width: '100%', padding: '0 0.25rem', gap: '0.25rem' }}>
          {stages.map((s, i) => (
            <PipelineStage
              key={s.stage}
              index={i + 1}
              label={STAGE_LABELS[s.stage]}
              sublabel={s.sublabel}
              status={s.status}
            />
          ))}
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

// ─── OriginalPageViewer（Phase4「看原圖」） ───────────────────────────────────
// 從合併圖切出 bbox 所在那一頁、整頁顯示 + 紅虛框標 AI 原本切的位置、可滾輪縮放 + 拖曳移動。
// 這是「圖片放大標準＝簡易 overlay」的正當例外（用途＝整頁找答案、非瞄 crop）。
export function OriginalPageViewer({
  imageBlob,
  pageBreaks,
  totalPages,
  bbox,
  questionId,
  onClose,
}: {
  imageBlob: Blob
  pageBreaks?: number[]
  totalPages?: number  // 2026-06-20: pageBreaks 缺時用總頁數平均切、避免退成整張合併圖
  bbox?: { x: number; y: number; w: number; h: number } | null
  questionId: string
  onClose: () => void
}) {
  const [pageUrl, setPageUrl] = useState<string | null>(null)
  const [localBbox, setLocalBbox] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [pageInfo, setPageInfo] = useState<{ index: number; total: number }>({ index: 0, total: 1 })
  const [located, setLocated] = useState(true)  // 2026-06-20: 是否有 bbox 定位（無→依題號跳頁、不畫框）
  const [scale, setScale] = useState(1)
  const [tx, setTx] = useState(0)
  const [ty, setTy] = useState(0)
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)

  // 從合併圖 canvas 切出該頁
  useEffect(() => {
    let cancelled = false
    let outUrl: string | null = null
    const srcUrl = URL.createObjectURL(imageBlob)
    const img = new Image()
    img.onload = () => {
      if (cancelled) { URL.revokeObjectURL(srcUrl); return }
      const W = img.naturalWidth, H = img.naturalHeight
      let breaks = (Array.isArray(pageBreaks) ? pageBreaks : []).filter((n) => typeof n === 'number' && n > 0 && n < 1)
      // 2026-06-20: pageBreaks 沒存到 DB（這批 page_breaks=null）時、退成整張合併圖。
      //   改用總頁數平均切（PDF 各頁高度通常一致、夠準）→ 仍能切出該題那一頁。
      if (breaks.length === 0 && typeof totalPages === 'number' && totalPages > 1) {
        breaks = Array.from({ length: totalPages - 1 }, (_, i) => (i + 1) / totalPages)
      }
      const starts = [0, ...breaks]
      const ends = [...breaks, 1]
      const total = starts.length
      // 2026-06-20: 決定頁碼。有 bbox→用框中心 y；無 bbox（classify 漏框/未裁切）→ 用題號前綴當頁碼
      //   （"3-G-2-2"→第 3 頁），仍切到對應頁、只是不畫框。避免沒 bbox 就退到第 1 頁、看不到答案所在頁。
      const hasBbox = !!bbox && Number(bbox.w) > 0 && Number(bbox.h) > 0
      let idx
      if (hasBbox) {
        const cy = bbox.y + bbox.h / 2
        idx = total - 1
        for (let i = 0; i < total; i++) {
          if (cy >= starts[i] && cy < ends[i]) { idx = i; break }
        }
      } else {
        const p = parseInt(String(questionId).split('-')[0], 10)
        idx = Number.isFinite(p) && p >= 1 ? Math.min(total - 1, p - 1) : 0
      }
      const ps = starts[idx], pe = ends[idx]
      const span = pe - ps || 1
      const sy = Math.round(ps * H)
      const sh = Math.max(1, Math.round(span * H))
      const canvas = document.createElement('canvas')
      canvas.width = W
      canvas.height = sh
      const ctx = canvas.getContext('2d')
      if (!ctx) { URL.revokeObjectURL(srcUrl); return }
      ctx.drawImage(img, 0, sy, W, sh, 0, 0, W, sh)
      URL.revokeObjectURL(srcUrl)
      canvas.toBlob((b) => {
        if (cancelled || !b) return
        outUrl = URL.createObjectURL(b)
        if (hasBbox) {
          setLocalBbox({
            x: Math.max(0, bbox.x),
            y: Math.max(0, (bbox.y - ps) / span),
            w: Math.min(1, bbox.w),
            h: Math.min(1, bbox.h / span),
          })
        } else {
          setLocalBbox(null)
        }
        setLocated(hasBbox)
        setPageInfo({ index: idx, total })
        setPageUrl(outUrl)
      }, 'image/jpeg', 0.92)
    }
    img.onerror = () => URL.revokeObjectURL(srcUrl)
    img.src = srcUrl
    return () => { cancelled = true; if (outUrl) URL.revokeObjectURL(outUrl) }
  }, [imageBlob, pageBreaks, totalPages, bbox, questionId])

  // Esc 關閉
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const onWheel = (e: ReactWheelEvent) => {
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
    setScale((s) => Math.min(8, Math.max(0.4, s * factor)))
  }
  const onPointerDown = (e: ReactPointerEvent) => {
    dragRef.current = { x: e.clientX, y: e.clientY, tx, ty }
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: ReactPointerEvent) => {
    if (!dragRef.current) return
    setTx(dragRef.current.tx + (e.clientX - dragRef.current.x))
    setTy(dragRef.current.ty + (e.clientY - dragRef.current.y))
  }
  const onPointerUp = () => { dragRef.current = null }
  const reset = () => { setScale(1); setTx(0); setTy(0) }

  return (
    <div className="fixed inset-0 z-[400] flex flex-col bg-black/90">
      <div className="flex items-center justify-between px-4 py-2 text-sm text-white">
        <span className="truncate">
          題目 {questionId} 原圖
          {pageInfo.total > 1 ? `（第 ${pageInfo.index + 1}/${pageInfo.total} 頁）` : ''}
          {located ? (localBbox ? ' · 紅框＝AI 原本切的位置' : '') : ' · 此題未定位（依題號跳該頁）'}
        </span>
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={reset} className="rounded px-2 py-1 text-xs hover:bg-white/10">重置</button>
          <button onClick={onClose} className="rounded p-1 hover:bg-white/10" aria-label="關閉">
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>
      <div
        className="relative flex-1 touch-none overflow-hidden cursor-grab active:cursor-grabbing"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        {pageUrl ? (
          <div
            className="absolute left-1/2 top-1/2"
            style={{ transform: `translate(-50%, -50%) translate(${tx}px, ${ty}px) scale(${scale})` }}
          >
            <div className="relative">
              <img
                src={pageUrl}
                alt={`題目 ${questionId} 原圖`}
                className="block max-h-[80vh] max-w-[92vw] select-none object-contain"
                draggable={false}
              />
              {localBbox && (
                <div
                  // 2026-06-19: 邊框改半透明(border-red-500/50)、移除填色(原 bg-red-500/5)，
                  //   避免框壓在筆跡上時不透明紅線蓋住字、老師看不清原作答。
                  className="pointer-events-none absolute border-2 border-dashed border-red-500/50"
                  style={{
                    left: `${localBbox.x * 100}%`,
                    top: `${localBbox.y * 100}%`,
                    width: `${localBbox.w * 100}%`,
                    height: `${localBbox.h * 100}%`,
                  }}
                />
              )}
            </div>
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-white/70">載入原圖中…</div>
        )}
      </div>
      <div className="px-4 py-2 text-center text-xs text-white/60">滾輪縮放 · 拖曳移動 · Esc 關閉</div>
    </div>
  )
}

// ─── ConsistencyQuestionCard ──────────────────────────────────────────────────

export function ConsistencyQuestionCard({
  studentId: _studentId,
  questionResult,
  decision,
  onDecision,
  disabled,
  onViewOriginal,
}: {
  studentId: string
  questionResult: PhaseAQuestionResult
  decision?: ConsistencyDecision
  onDecision: (questionId: string, update: Partial<ConsistencyDecision>) => void
  disabled: boolean
  onViewOriginal?: () => void  // 2026-06-01 Phase4:「看原圖」開整頁檢視器
}) {
  const [manualInput, setManualInput] = useState('')
  const [zoomedImg, setZoomedImg] = useState(false)
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

  // ── 2026-05-30: VJ 視覺判斷題特化（per-item「有沒有畫」確認） ──
  const visualJudgment = questionResult.visualJudgment
  const isVJ = !!questionResult.questionType
    && ['diagram_color', 'map_symbol', 'grid_geometry'].includes(questionResult.questionType)
    && Array.isArray(visualJudgment?.perItem)
  if (isVJ && visualJudgment) {
    const reviewItems = visualJudgment.perItem.filter((p) => p.status !== 'auto_not_blank')
    const decisionsByIdx = new Map((decision?.vjPerItem || []).map((d) => [d.idx, d]))
    const allDecided = reviewItems.every((p) => decisionsByIdx.has(p.idx))

    const setVjDecision = (idx: number, isBlank: boolean) => {
      const existing = decision?.vjPerItem || []
      const next = [...existing.filter((d) => d.idx !== idx), { idx, isBlank }]
      const stillAllDecided = reviewItems.every((p) => p.idx === idx || decisionsByIdx.has(p.idx))
      onDecision(questionId, {
        source: 'manual',
        finalAnswer: '',
        confirmed: stillAllDecided,
        vjPerItem: next
      })
    }

    return (
      <div className={`rounded-lg border p-3 space-y-2 text-xs ${borderClass}`}>
        <div className="flex items-center justify-between">
          <span className="font-semibold text-gray-800">題目 {questionId}（視覺判斷題）</span>
          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${badgeClass}`}>
            {isConfirmed ? '已確認' : `${reviewItems.length} 項待確認`}
          </span>
        </div>
        <div className="text-[11px] text-gray-600">
          共 {visualJudgment.perItem.length} 項、
          <span className="text-green-700 font-semibold">{visualJudgment.perItem.length - reviewItems.length}</span> 項 AI 確定有畫已自動批改、
          <span className="text-orange-700 font-semibold">{reviewItems.length}</span> 項請確認學生有沒有作答。
        </div>
        {answerCropImageUrl && (
          <div className="rounded border border-gray-200 bg-white p-1">
            <img
              src={answerCropImageUrl}
              alt={`題目 ${questionId} 學生作答圖`}
              className="w-full max-h-[180px] object-contain cursor-zoom-in"
              onClick={() => setZoomedImg(true)}
            />
          </div>
        )}
        <div className="space-y-1.5">
          {reviewItems.map((p) => {
            const dec = decisionsByIdx.get(p.idx)
            return (
              <div key={p.idx} className="rounded border border-gray-200 bg-white p-2 space-y-1">
                <div className="text-[11px] font-bold text-gray-700">{p.label}</div>
                <div className="text-[10px] text-gray-500">AI 沒看到筆跡，請確認學生這格有沒有作答：</div>
                <div className="grid grid-cols-2 gap-1">
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => setVjDecision(p.idx, false)}
                    className={`rounded border px-1.5 py-1 text-[11px] font-semibold ${
                      dec && !dec.isBlank ? 'border-green-500 bg-green-50' : 'border-gray-200 bg-gray-50 hover:bg-green-50'
                    }`}
                  >
                    有畫（送批改）
                  </button>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => setVjDecision(p.idx, true)}
                    className={`rounded border px-1.5 py-1 text-[11px] font-semibold ${
                      dec && dec.isBlank ? 'border-gray-500 bg-gray-100' : 'border-gray-200 bg-gray-50 hover:bg-gray-100'
                    }`}
                  >
                    沒畫（0 分）
                  </button>
                </div>
              </div>
            )
          })}
        </div>
        {allDecided && (
          <div className="text-[11px] text-green-700 bg-green-50 border border-green-200 rounded px-2 py-1">
            ✓ 全部已確認、可送出
          </div>
        )}
        {zoomedImg && answerCropImageUrl && (
          <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center cursor-zoom-out" onClick={() => setZoomedImg(false)}>
            <img src={answerCropImageUrl} alt="放大" className="max-w-[95vw] max-h-[95vh] object-contain" />
          </div>
        )}
      </div>
    )
  }

  // ── 2026-05-28: map_fill 特化（per-position 表格） ──
  const mapFillReadings = questionResult.mapFillReadings
  const isMapFill = questionResult.questionType === 'map_fill' && Array.isArray(mapFillReadings?.perPosition)
  if (isMapFill && mapFillReadings) {
    const perPos = mapFillReadings.perPosition
    const inconsistentRows = perPos.filter((p) => !p.consistent)
    const decisionsByIdx = new Map(
      (decision?.mapFillPerPosition || []).map((d) => [d.idx, d])
    )
    const allDecided = inconsistentRows.every((p) => decisionsByIdx.has(p.idx))

    const setPositionDecision = (idx: number, source: 'ai_read1' | 'ai_read2' | 'blank' | 'manual', finalText: string) => {
      // 更新 mapFillPerPosition[idx] 條目
      const existing = decision?.mapFillPerPosition || []
      const filtered = existing.filter((d) => d.idx !== idx)
      const next = [...filtered, { idx, source, finalText }]
      // 整題 confirmed = 所有 inconsistent 都有 decision
      const stillAllDecided = inconsistentRows.every((p) => p.idx === idx || decisionsByIdx.has(p.idx))
      onDecision(questionId, {
        source: 'manual',
        finalAnswer: '',  // map_fill 不用整題 finalAnswer、用 mapFillPerPosition
        confirmed: stillAllDecided,
        mapFillPerPosition: next
      })
    }

    return (
      <div className={`rounded-lg border p-3 space-y-2 text-xs ${borderClass}`}>
        <div className="flex items-center justify-between">
          <span className="font-semibold text-gray-800">題目 {questionId}（填圖題）</span>
          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${badgeClass}`}>
            {isConfirmed ? '已確認' : `${inconsistentRows.length} 個位置待確認`}
          </span>
        </div>
        <div className="text-[11px] text-gray-600">
          全部 {perPos.length} 個位置中、<span className="text-green-700 font-semibold">{perPos.length - inconsistentRows.length}</span> 個 AI 一致已自動算分、
          <span className="text-orange-700 font-semibold">{inconsistentRows.length}</span> 個請複核。
        </div>
        {answerCropImageUrl && (
          <div className="rounded border border-gray-200 bg-white p-1">
            <img
              src={answerCropImageUrl}
              alt={`題目 ${questionId} 學生作答圖`}
              className="w-full max-h-[180px] object-contain cursor-zoom-in"
              onClick={() => setZoomedImg(true)}
            />
          </div>
        )}
        <div className="space-y-1.5">
          {inconsistentRows.map((p) => {
            const dec = decisionsByIdx.get(p.idx)
            return (
              <div key={p.idx} className="rounded border border-gray-200 bg-white p-2 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold text-gray-700">📍 {p.name}</span>
                  <span className="text-[9px] text-gray-400">#{p.idx}</span>
                </div>
                <div className="text-[10px] text-gray-500">{p.desc}</div>
                <div className="grid grid-cols-2 gap-1">
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => setPositionDecision(p.idx, 'ai_read1', p.ai1_text)}
                    className={`rounded border px-1.5 py-1 text-[10px] text-left ${
                      dec?.source === 'ai_read1' ? 'border-purple-500 bg-purple-50 font-semibold' : 'border-gray-200 bg-gray-50 hover:bg-purple-50'
                    }`}
                  >
                    AI1: {p.ai1_text || '（空）'}
                  </button>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => setPositionDecision(p.idx, 'ai_read2', p.ai2_text)}
                    className={`rounded border px-1.5 py-1 text-[10px] text-left ${
                      dec?.source === 'ai_read2' ? 'border-purple-500 bg-purple-50 font-semibold' : 'border-gray-200 bg-gray-50 hover:bg-purple-50'
                    }`}
                  >
                    AI2: {p.ai2_text || '（空）'}
                  </button>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => setPositionDecision(p.idx, 'blank', '')}
                    className={`rounded border px-1.5 py-1 text-[10px] font-semibold ${
                      dec?.source === 'blank' ? 'border-gray-500 bg-gray-100' : 'border-gray-200 bg-gray-50 hover:bg-gray-100'
                    }`}
                  >
                    空白
                  </button>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      const cur = dec?.source === 'manual' ? dec.finalText : ''
                      const input = prompt(`「${p.name}」位置學生實際寫了什麼？`, cur || '')
                      if (input !== null) setPositionDecision(p.idx, 'manual', input.trim())
                    }}
                    className={`rounded border px-1.5 py-1 text-[10px] ${
                      dec?.source === 'manual' ? 'border-blue-500 bg-blue-50 font-semibold' : 'border-gray-200 bg-gray-50 hover:bg-blue-50'
                    }`}
                  >
                    手動: {dec?.source === 'manual' && dec.finalText ? dec.finalText : '輸入…'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
        {allDecided && (
          <div className="text-[11px] text-green-700 bg-green-50 border border-green-200 rounded px-2 py-1">
            ✓ 全部位置已確認、可送出
          </div>
        )}
        {zoomedImg && answerCropImageUrl && (
          <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center cursor-zoom-out" onClick={() => setZoomedImg(false)}>
            <img src={answerCropImageUrl} alt="zoom" className="max-w-[95vw] max-h-[95vh] object-contain" />
          </div>
        )}
      </div>
    )
  }

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
      {/* 2026-05-30: 統一放大標準 — 純放大、無控制、點任意處關閉（跟 VJ/map_fill 一致）。
          設計準則：放大只為看清楚，不提供縮放/拖曳控制；看不清就是看不清，控制列只是干擾。 */}
      {zoomedImg && answerCropImageUrl && (
        <div className="fixed inset-0 z-[300] bg-black/80 flex items-center justify-center cursor-zoom-out" onClick={() => setZoomedImg(false)}>
          <img src={answerCropImageUrl} alt={`題目 ${questionId} 答案區（放大）`} className="max-w-[95vw] max-h-[95vh] object-contain" />
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

        {/* 2026-06-01 Phase4: 「無法辨識」改成「看原圖」——看不清就打開整頁原圖找答案、再打字確認，
            不再產生 unrecognizable 這種資料。真鬼畫符就在人工輸入打「無法辨識」當文案。 */}
        <button
          type="button"
          disabled={disabled}
          onClick={() => onViewOriginal?.()}
          className="flex items-center justify-center gap-1 whitespace-nowrap rounded-lg border-2 border-gray-200 bg-white px-2 py-2.5 text-[11px] font-semibold text-slate-600 transition-colors hover:border-slate-400 hover:bg-slate-50 disabled:cursor-not-allowed"
          title="看不清楚？打開整頁原圖（紅框標 AI 原本切的位置），放大找答案再打字"
        >
          無法辨識
          <ZoomIn className="w-3.5 h-3.5" />
          看原圖
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
  streamingDone = true,
}: {
  entries: BatchPhaseAEntry[]
  allStudents: Student[]
  onDecision: (studentId: string, questionId: string, update: Partial<ConsistencyDecision>) => void
  onStudentConfirmed: (entry: BatchPhaseAEntry) => void | Promise<void>
  onAllDone: () => void
  phaseBScoredCount?: number
  phaseBTotalCount?: number
  // 2026-06-20 串流：false=還有卷在 read+arbiter、複核完目前的也先別收尾(防提早觸發最終 PhaseB)。
  //   預設 true=非串流(一般重新截取)、行為與舊版相同。
  streamingDone?: boolean
}) {
  // isPhaseBRunning 不再使用（Accessor 在背景跑）
  // Helper: determine if a question needs human review
  // New architecture: use arbiterResult.arbiterStatus; fall back to consistencyStatus for old data
  const isNeedsReview = (q: PhaseAQuestionResult) => {
    // 2026-05-30: needs_review 或 blank（空白要老師確認真空白）都進審查；map_fill/VJ 自己排除
    if (q.arbiterResult) return questionNeedsConfirm(q.arbiterResult.arbiterStatus, q.arbiterResult.finalAnswer, q.questionType)
    return q.consistencyStatus !== 'stable'  // legacy fallback
  }

  // 按學生分組：只收集需審查的學生
  // 2026-06-20: 依 submissionId 去重——串流 append 或重複進佇列時可能同一份卷出現多次，
  //   會造成「確認後換到下一個 index 還是同一個學生、永遠複核不完」。去重根治。
  const seenReviewIds = new Set<string>()
  const needsReviewEntries = entries.filter(e => {
    if (!e.phaseAResult.questionResults.some(q => isNeedsReview(q))) return false
    if (seenReviewIds.has(e.submissionId)) return false
    seenReviewIds.add(e.submissionId)
    return true
  })
  const stableCount = entries.length - needsReviewEntries.length

  // 一次一個學生：追蹤目前審查到第幾個
  const [currentReviewIdx, setCurrentReviewIdx] = useState(0)
  const [confirmedStudentIds, setConfirmedStudentIds] = useState<Set<string>>(new Set())
  // 2026-06-01 Phase4: 「看原圖」檢視器當前題（用 currentEntry 的圖 + pageBreaks）
  const [viewerQ, setViewerQ] = useState<PhaseAQuestionResult | null>(null)

  const currentEntry = needsReviewEntries[currentReviewIdx]
  const currentReviewQs = currentEntry
    ? currentEntry.phaseAResult.questionResults.filter(q => isNeedsReview(q))
    : []
  const currentAllConfirmed = currentEntry
    ? currentReviewQs.every(q => currentEntry.decisions.get(q.questionId)?.confirmed)
    : false

  const reviewSectionRef = useRef<HTMLDivElement>(null)

  const handleConfirmAndNext = async () => {
    if (!currentEntry) return
    setConfirmedStudentIds(prev => new Set([...prev, currentEntry.studentId]))
    // 2026-06-01: 必須 await——onStudentConfirmed 會把複核後的 finalAnswers 寫進 Dexie，
    //   onAllDone→runOneClickPhaseB 會從 Dexie 重讀；不 await 會 race（讀到舊值、複核答案遺失、
    //   needs_review 題被 Phase B 判「無法辨識」0 分）。
    // 2026-06-20: try/catch 防呆——onStudentConfirmed 萬一拋錯（存檔失敗等），仍要往下推進、
    //   不能讓「下一位 / onAllDone」整個不執行 →「確認送出沒反應」卡住老師。
    try {
      await onStudentConfirmed(currentEntry)
    } catch (err) {
      console.error('[review] onStudentConfirmed 失敗、仍繼續推進避免卡住:', err)
    }
    if (currentReviewIdx < needsReviewEntries.length - 1) {
      setCurrentReviewIdx(prev => prev + 1)
      // 切換學生後滾到審查區塊頂部，從第一題開始看
      setTimeout(() => reviewSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100)
    }
    // 收尾（onAllDone）不在這裡呼叫——交給下方 useEffect：串流時要等「read+arbiter 全跑完(streamingDone)
    // ＋全部已確認」才收尾，避免老師太快確認完目前這份就提早觸發最終 Phase B。
  }

  const allDone = confirmedStudentIds.size >= needsReviewEntries.length

  // 2026-06-20 串流複核：(1) 目前這份已確認、後面又串流進新的待複核卷 → 自動前進到下一份；
  //   (2) streamingDone(read+arbiter 全完) ＋ 全部確認 → 收尾一次。非串流時 streamingDone 恆 true、
  //   等同舊行為（確認完最後一份就收尾）。
  const allDoneFiredRef = useRef(false)
  useEffect(() => {
    if (currentEntry && confirmedStudentIds.has(currentEntry.studentId)
      && currentReviewIdx < needsReviewEntries.length - 1) {
      setCurrentReviewIdx(i => i + 1)
      setTimeout(() => reviewSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100)
    }
    if (!allDoneFiredRef.current && streamingDone
      && needsReviewEntries.length > 0 && confirmedStudentIds.size >= needsReviewEntries.length) {
      allDoneFiredRef.current = true
      onAllDone()
    }
  }, [needsReviewEntries.length, confirmedStudentIds, currentReviewIdx, currentEntry, streamingDone, onAllDone])

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

      {/* 2026-06-20 串流：目前需複核的都看完了、但還有卷在批改 → 蓋全螢幕 loading 遮罩等下一份。
          複核元件本身不卸載(維持在 DOM 底下、currentReviewIdx/confirmedStudentIds 不掉)、
          新複核卷串流進來→caught-up 變 false→遮罩消失→複核畫面浮現。 */}
      {!streamingDone && allDone && needsReviewEntries.length > 0 && (
        <>
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 9998, backdropFilter: 'blur(2px)' }} />
          <div style={{
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 9999,
            background: '#fff', borderRadius: '1.25rem', boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
            padding: '2rem 2.5rem', minWidth: '420px', maxWidth: '90vw',
            display: 'flex', flexDirection: 'column', gap: '1rem', alignItems: 'center',
          }} role="status" aria-live="polite">
            <span className="inline-block w-8 h-8 border-4 border-purple-400 border-t-transparent rounded-full animate-spin" />
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '1rem', fontWeight: 700, color: '#111827' }}>批改中…</div>
              <div style={{ fontSize: '0.8rem', color: '#6b7280', marginTop: '0.25rem' }}>
                目前需要複核的都看完了，還有卷正在批改。批好需要複核的會自動跳出來。
              </div>
            </div>
          </div>
        </>
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
                  onViewOriginal={() => setViewerQ(q)}
                />
              ))}
            </div>

            {/* 確認送出按鈕 */}
            <button
              onClick={() => { void handleConfirmAndNext() }}
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

      {/* 全部審查完（串流時要等 streamingDone 才算真的完成、否則只是目前這批看完、還有卷在串流） */}
      {allDone && streamingDone && (
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

      {/* 2026-06-01 Phase4: 看原圖檢視器（用當前審查學生的合併圖 + pageBreaks 切出該題那一頁） */}
      {viewerQ && currentEntry && (
        <OriginalPageViewer
          imageBlob={currentEntry.imageBlob}
          pageBreaks={currentEntry.pageBreaks}
          // pageBreaks 沒存時用總頁數平均切：總頁數＝題號前綴最大值（"4-K-1"→4 頁）
          totalPages={Math.max(1, ...currentEntry.phaseAResult.questionResults.map((q) => parseInt(String(q.questionId).split('-')[0], 10) || 1))}
          bbox={(viewerQ.answerBbox as { x: number; y: number; w: number; h: number } | undefined) ?? null}
          questionId={viewerQ.questionId}
          onClose={() => setViewerQ(null)}
        />
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
  onNavigateToCorrection,
  embedded = false
}: GradingPageProps) {
  const navigate = useNavigate()
  // 2026-06-19: 跨班「頁內新增班級」。base＝進頁時的作業集合(單班=[assignmentId] 或 prop 傳入的批次)，
  //   addedAssignmentIds＝老師在批改頁按「＋新增班級」加進來的同答案卷其他班；合併 >1 即進 batch(跨班分組)模式。
  const [addedAssignmentIds, setAddedAssignmentIds] = useState<string[]>([])
  const includedAssignmentIds = useMemo(() => {
    const base = batchAssignmentIds && batchAssignmentIds.length > 0 ? batchAssignmentIds : [assignmentId]
    return [...new Set([...base, ...addedAssignmentIds])]
  }, [batchAssignmentIds, assignmentId, addedAssignmentIds])
  const isBatchMode = includedAssignmentIds.length > 1
  // 同答案卷、尚未納入的其他班級（批改頁「＋新增班級」下拉用）
  const [siblingClasses, setSiblingClasses] = useState<{ assignmentId: string; classroomId: string; className: string; uploadedCount: number; hasAnswerKey: boolean }[]>([])
  const [addClassMenuOpen, setAddClassMenuOpen] = useState(false)
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
  // 2026-05-18: gradingProgress / downloadProgress 已被 pipelineStageProgress 取代、
  // 只保留 setter（內部某些 batch loop 還在呼叫、移除會擴散到太多地方）
  const [, setGradingProgress] = useState({ current: 0, total: 0 })
  const [, setDownloadProgress] = useState({ current: 0, total: 0 })
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
  // 2026-06-01 Phase3: 進階模式——預設無勾選框(畫面清爽)。按【進階】選 Phase A/B 後才進勾選模式
  //   (卡片出現 ☑、底部出現確認列「已選 N ▶ 開始」)、執行完自動退出。
  const [advancedMode, setAdvancedMode] = useState<'phase_a' | 'phase_b' | null>(null)
  const [advancedMenuOpen, setAdvancedMenuOpen] = useState(false)
  // 2026-06-01: 進階「無覆寫風險直接跑」時的墨水確認（有覆寫風險走 DangerConfirmModal 的 inkNote）
  const [advInkConfirm, setAdvInkConfirm] = useState<null | { kind: 'phase_a' | 'phase_b'; count: number; run: () => void }>(null)
  const [correctionGuardModal, setCorrectionGuardModal] = useState<CorrectionGuardModalState | null>(
    null
  )
  const [isRevokingCorrection, setIsRevokingCorrection] = useState(false)
  const [revokeError, setRevokeError] = useState<string | null>(null)
  // 守門 modal 被關掉之前、被擋下的批改流程從哪繼續。退回成功後呼叫此 ref 恢復流程。
  const pendingGradeResumeRef = useRef<(() => void) | null>(null)
  const [gradeResultNotice, setGradeResultNotice] = useState<GradeResultNotice | null>(null)
  const [phaseAResultNotice, setPhaseAResultNotice] = useState<PhaseAResultNotice | null>(null)
  // 跑 Phase A 過程的計數先 stash、等審查全部完成才一起包 notice 顯示
  const phaseAStashRef = useRef<{
    successCount: number
    failCount: number
    totalCount: number
    failReasons: string[]
    failedCandidates: Submission[]
  } | null>(null)
  const [manualGradingStudentId, setManualGradingStudentId] = useState<string | null>(null)
  const [revertingManualGradeStudentId, setRevertingManualGradeStudentId] = useState<string | null>(null)

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
  // 2026-05-18: PR3——審查頁的 mode flag。phaseAOnlyReviewMode=true 時、
  // BatchConsistencyReviewSection 的 callbacks 只存 final_answers、不接 Phase B
  // executeRecaptureOnly 跑完且有 needs_review 時設成 true
  const phaseAOnlyReviewModeRef = useRef(false)
  // 2026-05-31 一鍵接著批改 1c：本次一鍵的全 scope（submission id）。
  // 流程：先全 Phase A(review-only)→ 複核 →（onAllDone 或無複核時）對「全 scope」跑一次統一 Phase B。
  // 非空 = 目前在一鍵流程中（當 flag 用）；runOneClickPhaseB 跑完清空。
  const oneClickScopeRef = useRef<string[]>([])
  // 2026-06-20 省時：一鍵流程中「老師複核時就背景批掉」的乾淨卷 ID。runOneClickPhaseB 會跳過這些、不重複批。
  const oneClickBgGradedIdsRef = useRef<Set<string>>(new Set())
  // 2026-06-20 串流管線（只智慧批改）：read+arbiter/乾淨PhaseB/複核PhaseB 共用的併發限制器。
  const pipelineSemaphoreRef = useRef<ReturnType<typeof makeSemaphore> | null>(null)
  // STAGE 3 串流是否全部 read+arbiter 跑完（給複核元件當「可以收尾」閘門、防提早觸發最終 PhaseB）。
  const [reviewStreamingDone, setReviewStreamingDone] = useState(true)
  // 本次串流是否有任何需複核卷進過佇列（決定 executeRecaptureOnly 回傳 true=有複核 / false=直接收尾）。
  const reviewAppendedCountRef = useRef(0)
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
          const stage = deriveCardStage(s, correctionStatusByStudent[s.studentId])
          // 全部批改情境排除：未繳交 / 手動標記
          return stage !== 'not_submitted' && stage !== 'manual_marked'
        })

    const stageList: CardStage[] = []
    const stageMap: Record<CardStage, Submission[]> = {
      not_submitted: [], not_extracted: [], phase_a_failed: [],
      pending_review: [], pending_grading: [], graded: [], phase_b_failed: [], manual_marked: []
    }
    for (const sub of inScope) {
      const stage = deriveCardStage(sub, correctionStatusByStudent[sub.studentId])
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
  }, [submissions, selectedSubmissionIds, correctionStatusByStudent])

  // 2026-05-31 Phase1b: 一鍵接著批改——所有未完成卷分桶（不看勾選，一鍵 = 處理全部待辦）
  // needA=未擷取/Phase A 失敗(要跑 Phase A)、needReview=待複核、needB=待算分/Phase B 失敗(直接 Phase B)
  const [oneClickConfirmOpen, setOneClickConfirmOpen] = useState(false)
  const unfinishedBuckets = useMemo(() => {
    const needA: Submission[] = []; const needReview: Submission[] = []; const needB: Submission[] = []
    for (const s of submissions.values()) {
      const stage = deriveCardStage(s, correctionStatusByStudent[s.studentId])
      if (stage === 'not_extracted' || stage === 'phase_a_failed') needA.push(s)
      else if (stage === 'pending_review') needReview.push(s)
      else if (stage === 'pending_grading' || stage === 'phase_b_failed') needB.push(s)
    }
    return { needA, needReview, needB, total: needA.length + needReview.length + needB.length }
  }, [submissions, correctionStatusByStudent])

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
  
  // 2026-06-01: 移除待複核導航（needsReviewCount / needsReviewStudents / jumpToNext|PrevReview）——
  //   待複核不再是狀態、detail 不再有跨待複核卷的導航；複核一律走智慧批改流程。

  // ─── Batch Phase B: 正式批改（全班）────────────────────────────────────────
  // phaseBScoredCount: 背景 Accessor 已完成的學生數（用於進度追蹤）
  const [phaseBScoredCount, setPhaseBScoredCount] = useState(0)
  const [phaseBTotalCount, setPhaseBTotalCount] = useState(0)

  // 2026-05-18: 5-stage 進度（classify / read / arbiter / accessor / explain）
  // started = 已開始該 stage 的份數、done = 已完成的份數、total = 預期處理份數
  // 因為 pipeline 並行、每份 submission 獨立往下跑、所以多個 stage 可同時 active
  const [pipelineStageProgress, setPipelineStageProgress] = useState<PipelineStageProgress>(EMPTY_PIPELINE_STAGE_PROGRESS)
  const [pipelineMode, setPipelineMode] = useState<GradingPipelineMode>('both')
  const bumpStage = useCallback((stage: GradingStageName, event: 'started' | 'completed') => {
    setPipelineStageProgress((prev) => {
      const cur = prev[stage]
      if (event === 'started') return { ...prev, [stage]: { ...cur, started: cur.started + 1 } }
      return { ...prev, [stage]: { ...cur, done: cur.done + 1 } }
    })
  }, [])

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
          return `${label}：${safeFailMsg(f.failure.userMessage)}${typeof f.failure.userAction === 'string' && f.failure.userAction.trim() ? ' ' + f.failure.userAction.trim() : ''}`
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
      // 老路徑（manual review 後或 retry）：overlay 顯示 Phase B 階段（accessor/explain）
      // gradePhaseB 內部沒 onStage、人工塞 started=total 讓 accessor 顯示為 active（無法逐份追蹤、視覺上整批當作同時開始）
      setPipelineMode('phase_b_only')
      setPipelineStageProgress({
        classify: { started: 0, done: 0, total: 0 },
        read: { started: 0, done: 0, total: 0 },
        arbiter: { started: 0, done: 0, total: 0 },
        quality: { started: 0, done: 0, total: 0 },
        accessor: { started: entries.length, done: 0, total: entries.length },
        explain: { started: 0, done: 0, total: entries.length },
      })
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
          return buildFinalAnswerForQR(qr, entry.decisions.get(qr.questionId))
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
          const isNeedsReview = questionNeedsConfirm(arbiter?.arbiterStatus, arbiter?.finalAnswer, qr.questionType)
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
          // 2026-06-20: 本地一定要同步寫 gradedAt（+aiScore/scoreSource）。否則 isPhaseAStale 比
          //   phaseAState.savedAt > gradedAt(=0) → true → deriveCardStage 不顯示「已批改」、卡片卡在「待批改」
          //   直到 sync 才好。背景批(executeBatchPhaseB)走這條、特別明顯。
          if (sub) next.set(sub.studentId, { ...sub, status: 'graded', score: totalScore, aiScore: totalScore, scoreSource: 'ai', gradingResult, gradedAt: gradedAtMs, updatedAt: gradedAtMs })
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
        d.score === 0 && d.confidence <= 70 && (!d.reason || d.reason === '需人工複核' || d.reason?.includes('AI 未提供具體理由'))
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
            return buildFinalAnswerForQR(qr, entry.decisions.get(qr.questionId))
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
            if (sub) next.set(sub.studentId, { ...sub, status: 'graded', score: totalScore, aiScore: totalScore, scoreSource: 'ai', gradingResult, gradedAt: retryGradedAt, updatedAt: retryGradedAt })
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
          d.score === 0 && d.confidence <= 70 && (!d.reason || d.reason === '需人工複核' || d.reason?.includes('AI 未提供具體理由'))
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
      return `${label}：${safeFailMsg(f.failure.userMessage)}${typeof f.failure.userAction === 'string' && f.failure.userAction.trim() ? ' ' + f.failure.userAction.trim() : ''}`
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
      return `${label}：${safeFailMsg(f.failure.userMessage)}${typeof f.failure.userAction === 'string' && f.failure.userAction.trim() ? ' ' + f.failure.userAction.trim() : ''}`
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
      const allAssignmentIds = includedAssignmentIds

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
  }, [assignmentId, includedAssignmentIds, fetchCorrectionStatusByStudentId])

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

  // 2026-06-19: 偵測「同一張答案卷模板、尚未納入」的其他班級，供批改頁「＋新增班級」下拉使用。
  //   answerKeyTemplateId 無 Dexie 索引→toArray 後 filter(作業表小、AssignmentList 也這樣做)。
  useEffect(() => {
    let cancelled = false
    const tplId = assignment?.answerKeyTemplateId
    if (!tplId) { setSiblingClasses([]); return }
    ;(async () => {
      const all = await db.assignments.toArray()
      const sibs = all.filter((a) => a.answerKeyTemplateId === tplId && !includedAssignmentIds.includes(a.id))
      const out: typeof siblingClasses = []
      for (const a of sibs) {
        const cls = await db.classrooms.get(a.classroomId)
        const cnt = await db.submissions.where('assignmentId').equals(a.id).count()
        out.push({ assignmentId: a.id, classroomId: a.classroomId, className: cls?.name ?? '未知班級', uploadedCount: cnt, hasAnswerKey: !!a.answerKey })
      }
      out.sort((x, y) => x.className.localeCompare(y.className, 'zh-Hant'))
      if (!cancelled) setSiblingClasses(out)
    })()
    return () => { cancelled = true }
  }, [assignment?.answerKeyTemplateId, includedAssignmentIds])

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
        // VJ 逐柱重建用：finalAnswers 的 vjBlankConfirmed + 答案卷 vjRubric.itemLabels
        // （detail 自帶 vjItemResults 優先；舊資料沒帶就從這兩個重建、不用重跑 Phase A）
        const faByQid = new Map(
          ((selectedSubmission.submission.finalAnswers as any[]) || []).map((fa: any) => [fa.questionId, fa])
        )
        const akByQid = new Map(
          ((assignment?.answerKey?.questions as any[]) || []).map((q: any) => [q.id, q])
        )
        const VJ_TYPES = ['diagram_color', 'map_symbol', 'grid_geometry']
        setEditableDetails(
          details.map((d: any, index: number) => {
            // VJ 逐柱結果：優先用 detail 自帶；沒有就從 finalAnswers.vjBlankConfirmed + 答案卷 labels 重建
            let vjItemResults: any[] | undefined = Array.isArray(d.vjItemResults) ? d.vjItemResults : undefined
            const isVjType = VJ_TYPES.includes(d.questionType) || !!(akByQid.get(d.questionId) as any)?.vjRubric
            if (!vjItemResults && isVjType) {
              const labels = (akByQid.get(d.questionId) as any)?.vjRubric?.itemLabels
              const blankConfirmed = (faByQid.get(d.questionId) as any)?.vjBlankConfirmed
              if (Array.isArray(labels) && labels.length > 0) {
                const blankByIdx = new Map(
                  (Array.isArray(blankConfirmed) ? blankConfirmed : []).map((b: any) => [b.idx, b.isBlank])
                )
                vjItemResults = labels.map((label: string, i: number) => {
                  const idx = i + 1
                  const isBlank = blankByIdx.get(idx) ?? false
                  return { idx, label, verdict: isBlank ? 'blank' : 'pending', reason: isBlank ? '未作答' : '有畫（待批改）' }
                })
              }
            }
            // VJ 的「學生答案」統一顯示摘要文案（蓋掉 buildFinalAnswerForQR 寫進來的 "label:已作答"）
            const vjSummary = Array.isArray(vjItemResults)
              ? (vjItemResults.some((r: any) => r.verdict !== 'blank') ? '圖上作答' : '未作答')
              : null
            return {
              questionId: d.questionId ?? `#${index + 1}`,
              // questionType 保留下來、UI 對 map_fill 等視覺評分題型要鎖編輯欄
              questionType: d.questionType ?? undefined,
              studentAnswer: vjSummary ?? (d.studentAnswer ?? ''),
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
              cellResults: Array.isArray(d.cellResults) ? d.cellResults : undefined,
              // fill_blank 合題：保留每空對錯細節（人工複核 UI 用）
              partResults: Array.isArray(d.partResults) ? d.partResults : undefined,
              // VJ 逐柱（render 逐柱按鈕 + toggle 用）— 白名單原本漏了
              vjItemResults,
            }
          })
        )
      } else {
        setEditableDetails([])
      }
    } else {
      setEditableDetails([])
    }
  }, [selectedSubmission, assignment])

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
    if (!window.confirm(`確定將 ${student.seatNumber} 號 ${student.name} 標記為已批改？\n此操作不會執行 AI 批改，僅更新狀態。\n（按下後可再撤銷回「尚未繳交」）`)) return
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

  const handleRevertManualGradeStudent = async (student: Student) => {
    if (revertingManualGradeStudentId) return
    if (!window.confirm(`撤銷 ${student.seatNumber} 號 ${student.name} 的手動標記？\n將刪除 stub 紀錄、學生回到「尚未繳交」。`)) return
    setRevertingManualGradeStudentId(student.id)
    try {
      const response = await fetch('/api/data/manual-grade-revert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ assignmentId, studentId: student.id })
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data?.error || '撤銷手動標記失敗')
      await syncAndReload()
    } catch (err) {
      setError(err instanceof Error ? err.message : '撤銷手動標記失敗')
    } finally {
      setRevertingManualGradeStudentId(null)
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
  // 2026-05-28: Q1 — 已完成訂正的學生擋下 Phase A/B 重跑
  const [correctionPassedBlockModal, setCorrectionPassedBlockModal] = useState<{
    action: 'recapture' | 'regrade'
    blockedStudents: Array<{ studentId: string; name: string; seatNumber: number | null }>
  } | null>(null)

  // 2026-05-28: Q1 — 拆出 in-scope candidates 的訂正狀態 partition
  // - correctionPassedStudentIds: 已完成訂正、Phase A/B 重跑要擋
  // - correctionToClearStudentIds: 訂正進行中 / 待複核 / 失敗、Phase A/B 重跑前要清
  const partitionCandidatesByCorrection = useCallback((candidates: Submission[]) => {
    const passedIds = new Set<string>()
    const clearIds = new Set<string>()
    for (const sub of candidates) {
      const sid = sub.studentId
      if (!sid) continue
      const status = correctionStatusByStudent[sid]
      if (status === 'correction_passed') passedIds.add(sid)
      else if (
        status === 'correction_required' ||
        status === 'correction_in_progress' ||
        status === 'correction_pending_review' ||
        status === 'correction_failed'
      ) clearIds.add(sid)
    }
    return { passedIds, clearIds }
  }, [correctionStatusByStudent])

  // 2026-05-28: Q1 — 呼叫 server 清訂正狀態（重置 assignment_student_state + close correction_question_items）
  // 失敗就 throw、caller 該停止流程、避免在 stale correction 上跑批改
  const clearCorrectionForRerunOnServer = useCallback(async (studentIds: string[]) => {
    if (studentIds.length === 0) return
    const resp = await fetch('/api/data/clear-correction-for-rerun', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignmentId, studentIds })
    })
    const data = await resp.json().catch(() => ({}))
    if (!resp.ok) {
      if (resp.status === 409 && Array.isArray(data?.blockedStudents)) {
        throw new Error(`已完成訂正、無法重跑：${data.blockedStudents.map((s: { name: string; seatNumber: number | null }) => `${s.seatNumber ?? '?'}號 ${s.name}`).join('、')}`)
      }
      throw new Error(data?.error || '清訂正狀態失敗')
    }
    await fetchCorrectionStatusByStudentId().catch(() => {})
  }, [assignmentId, fetchCorrectionStatusByStudentId])

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
    // 2026-05-28: Q1 — 先擋 correction_passed（終點、不可重跑）
    const { passedIds } = partitionCandidatesByCorrection(inScope)
    if (passedIds.size > 0) {
      const blockedStudents = Array.from(passedIds).map((sid) => {
        const stu = students.find((s) => s.id === sid)
        return { studentId: sid, name: stu?.name || sid, seatNumber: Number.isFinite(stu?.seatNumber) ? Number(stu?.seatNumber) : null }
      })
      setCorrectionPassedBlockModal({ action: 'recapture', blockedStudents })
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
    // 無清空風險、直接跑 Phase A only（先過墨水確認）
    setAdvInkConfirm({ kind: 'phase_a', count: inScope.length, run: () => { void executeRecaptureOnly(inScope) } })
  }

  // 2026-05-17: Phase A only 執行器
  // 給 selected/all 候選 submissions 各自跑 Phase A（OCR + classify + read + arbiter）、
  // 跑完後 server 端寫 phase_a_state（PR1）、不自動接 Phase B。
  // 對應「重新截取答案」按鈕觸發、適用「想重讀但不想直接批改」的場景。
  // 2026-05-31: opts.chainPhaseB —「一鍵接著批改」用。預設 false = 現行行為(審查完只存 final_answers、不接 Phase B)。
  // 傳 true 時:有 needs_review 的進審查面板、審查完會自動接 Phase B(由 onAllDone 的 normal 分支處理)。
  // 進階的「單獨 Phase A」不傳此參數 → 行為完全不變。
  // 2026-05-31: 回傳 enteredReview（true=有 needs_review、已進審查頁；false=無、已收尾）。
  //   一鍵 1c 用此判斷要立刻跑統一 Phase B（false）還是等審查 onAllDone 再跑（true）。
  //   opts.suppressNotice：一鍵流程中不顯示 Phase A 自己的收尾 notice（讓統一 Phase B 的結果視窗當最終 modal）。
  const executeRecaptureOnly = useCallback(async (candidates: Submission[], opts?: { chainPhaseB?: boolean; suppressNotice?: boolean }): Promise<boolean> => {
    if (candidates.length === 0) return false
    if (!assignment?.answerKey) { alert('找不到答案卷'); return false }
    if (inkSessionError) { alert(inkSessionError); return false }
    if (!inkSessionReady) { alert('批改會話尚未準備完成、請稍候'); return false }
    if (!isGeminiAvailable) { alert('Gemini 服務未設定'); return false }
    // 2026-05-28: Q1 — 在跑 AI 前清訂正狀態（assignment_student_state + correction_question_items）
    const { clearIds } = partitionCandidatesByCorrection(candidates)
    if (clearIds.size > 0) {
      try {
        await clearCorrectionForRerunOnServer(Array.from(clearIds))
      } catch (err) {
        alert(err instanceof Error ? err.message : '清訂正狀態失敗')
        return false
      }
    }

    setIsGrading(true)
    setGradingPhase('phase_a_running')
    setGradingMessage('AI 讀取答案中…')
    setError(null)
    setStopRequested(false)
    stopRequestedRef.current = false
    setGradingProgress({ current: 0, total: candidates.length })
    setGradingStartTime(Date.now())
    // Phase A only mode：classify / read / arbiter 各 total = N、accessor / explain 不在本 run
    setPipelineMode('phase_a_only')
    setPipelineStageProgress({
      classify: { started: 0, done: 0, total: candidates.length },
      read: { started: 0, done: 0, total: candidates.length },
      arbiter: { started: 0, done: 0, total: candidates.length },
      quality: { started: 0, done: 0, total: 0 },
      accessor: { started: 0, done: 0, total: 0 },
      explain: { started: 0, done: 0, total: 0 },
    })

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
    const failedCandidates: Submission[] = []  // 失敗的 Submission、收尾 notice 提供「重新讀取」按鈕
    const ANSWER_KEY = assignment.answerKey  // narrowed for closure
    // 2026-05-18: 收集成功的 Phase A 結果、跑完判斷有沒有 needs_review、有就帶老師進審查頁
    const successfulEntries: BatchPhaseAEntry[] = []

    // 2026-06-20: 把 classify-only 結果(_phaseAClassifyContext)包成 peer 檢查用的最小 entry（只需 bbox）。
    //   給「重跑只跑 classify」用：偵測漂移時不必跑完整 Phase A、用 classify context 的 bbox 直接比鄰卷。
    const classifyCtxToEntry = (sub: Submission, ctx: unknown): BatchPhaseAEntry => {
      const aligned = ((ctx as { classifyResult?: { alignedQuestions?: Array<{ questionId: string; answerBbox?: Bbox; questionType?: string }> } } | undefined)
        ?.classifyResult?.alignedQuestions) ?? []
      return {
        submissionId: sub.id,
        studentId: sub.studentId,
        phaseAResult: {
          questionResults: aligned
            .filter((q) => q?.answerBbox && typeof q.answerBbox.x === 'number')
            .map((q) => ({ questionId: q.questionId, answerBbox: q.answerBbox, questionType: q.questionType })),
        },
      } as unknown as BatchPhaseAEntry
    }

    // 2026-06-20: 主流程＝classify → 系統檢查(retry 只重跑漂移頁) → read1/read2 → read3(arbiter)。
    //   三段：先全部只跑 classify、用 peer baseline 抓框歪→只重跑該頁 classify 到對得上鄰卷→確認對了才跑 read。
    //   好處：漂移卷的 read+arbiter 絕不在歪 bbox 上白跑（連第一輪都不浪費）。
    // 併發依頁數自動調小——classify 每份 per-page 並行(Promise.all)、併發×頁數=同時打 Gemini 的 call 數、
    //   4頁×5份=20 撞 Vercel 300s→504。控制 ≤~10：min(5, floor(10/頁數))、只對 ≥3 頁降載。
    const pageCount = Math.max(1, assignment?.totalPages ?? 1)
    const gradeConcurrency = Math.max(1, Math.min(5, Math.floor(10 / pageCount)))

    // 共用失敗標記（classify / 系統檢查階段）：寫 grading_failed、計入失敗、即時更新卡片。
    const markClassifyFail = async (sub: Submission, reason: string, failure?: import('@/lib/gemini').PipelineFailure) => {
      const stu = students.find((s) => s.id === sub.studentId)
      const label = stu ? `${stu.seatNumber}號 ${stu.name}` : sub.id.slice(-8)
      failReasons.push(`${label}: ${reason}`)
      failCount++
      failedCandidates.push(sub)
      const { failureGradingResult, updatedAt } = await persistGradingFailureFromException(sub.id, reason, failure)
      setSubmissions((prev) => {
        const next = new Map(prev)
        const cur = Array.from(prev.values()).find((s) => s.id === sub.id)
        if (cur) next.set(cur.studentId, { ...cur, status: 'grading_failed', gradingResult: failureGradingResult, updatedAt })
        return next
      })
    }

    // ── STAGE 1：classify-all（只跑 call1、回 _phaseAClassifyContext）──
    const classifyCtxBySub = new Map<string, unknown>()
    const okSubs: Submission[] = []  // 通過 classify(+系統檢查)的卷、進 STAGE 3 跑 read
    await runWithConcurrency(
      candidates, gradeConcurrency, 2000,
      async (sub) => {
        if (stopRequestedRef.current) return null
        if (!sub.imageBlob) { await markClassifyFail(sub, '無圖片'); return null }
        try {
          const r = await gradePhaseA(
            sub.imageBlob, ANSWER_KEY, sub.pageBreaks, assignment?.domain, sub.assignmentId ?? assignment?.id,
            undefined, assignment?.answerSheetMode, sub.id, sub.source,
            // 每張 classify 完成就即時 +1（往上跑）；STAGE 2 系統檢查抓到歪的卷會把它 -1 退回重跑、對了再 +1。
            (stage, event) => bumpStage(stage, event), { stopAfterClassify: true }
          )
          if (r.pipelineFailure) { await markClassifyFail(sub, safeFailMsg(r.pipelineFailure), r.pipelineFailure); return null }
          const ctx = (r as unknown as { _phaseAClassifyContext?: unknown })._phaseAClassifyContext
          if (!ctx) { await markClassifyFail(sub, 'classify 無回傳內容、請重試'); return null }
          classifyCtxBySub.set(sub.id, ctx)
          okSubs.push(sub)
          return r
        } catch (err) { await markClassifyFail(sub, safeFailMsg(err)); return null }
      },
      () => {},
      stopRequestedRef
    )

    // ── STAGE 2：系統檢查（peer baseline 抓框歪）+ 只重跑漂移頁 classify 到對得上鄰卷 ──
    {
      const isPdfBatch = okSubs.length > 0 && okSubs.every((s) => s.source === 'teacher_scan')
      const peerCheckEnabled = assignment?.answerSheetMode === 'answer_only' || isPdfBatch
      // peer 基準＝本批 classify 結果 + submissions state 裡已有 bbox 的其他卷（單獨/小批也有基準）
      const statePeers: BatchPhaseAEntry[] = []
      for (const s of submissions.values()) {
        const details = (s.gradingResult as { details?: Array<{ questionId: string; answerBbox?: Bbox; questionType?: string }> } | undefined)?.details
        if (!Array.isArray(details) || !details.some((d) => d?.answerBbox && typeof d.answerBbox.x === 'number')) continue
        statePeers.push({
          submissionId: s.id, studentId: s.studentId,
          phaseAResult: { questionResults: details.map((d) => ({ questionId: d.questionId, answerBbox: d.answerBbox, questionType: d.questionType })) },
        } as unknown as BatchPhaseAEntry)
      }
      const poolMap = new Map<string, BatchPhaseAEntry>()
      for (const p of statePeers) poolMap.set(p.submissionId, p)
      for (const s of okSubs) poolMap.set(s.id, classifyCtxToEntry(s, classifyCtxBySub.get(s.id)))  // 本批 classify 覆蓋同 id
      const peerPool = [...poolMap.values()]
      const peerOpts: { dyThreshold?: number; dxThreshold?: number; minOutlierCount?: number; detectMissing?: boolean; peerTotal?: number; missingConsensus?: number } =
        assignment?.answerSheetMode === 'answer_only'
          ? {}
          : { dyThreshold: 0.015, dxThreshold: 0.08, minOutlierCount: 1, detectMissing: true, peerTotal: Math.max(0, peerPool.length - 1), missingConsensus: 0.7 }

      if (peerCheckEnabled && peerPool.length >= 5 && okSubs.length > 0 && !stopRequestedRef.current) {
        setGradingMessage('框位比對中…')
        const trips = okSubs.filter((sub) => {
          const baseline = computePeerBaseline(peerPool, sub.id)
          if (baseline.size < 3) return false
          return checkPeerOutliers(classifyCtxToEntry(sub, classifyCtxBySub.get(sub.id)), baseline, peerOpts).trip
        })
        if (trips.length > 0) {
          // 歪的卷退回（classify done -trips）→ 重跑、對得上鄰卷再 +1 回來；沒漂移的卷 STAGE 1 已 +1、不動。
          setPipelineStageProgress((p) => ({ ...p, classify: { ...p.classify, done: Math.max(0, p.classify.done - trips.length) } }))
          setGradingMessage(`偵測到 ${trips.length} 份框位異常、重跑中…`)
          const failedIds = new Set<string>()
          const MAX_RERUN_ATTEMPTS = 3
          await runWithConcurrency(
            trips, 3, 2000,
            async (sub) => {
              if (stopRequestedRef.current || !sub.imageBlob) return null
              const baseline = computePeerBaseline(peerPool, sub.id)
              let ctx = classifyCtxBySub.get(sub.id)
              // attempt1 全頁 classify-only（無可信 prior）；attempt2-3 只重跑漂移頁(partial、②、用前次 ctx 當 prior）
              for (let attempt = 1; attempt <= MAX_RERUN_ATTEMPTS; attempt++) {
                if (stopRequestedRef.current) break
                const info = checkPeerOutliers(classifyCtxToEntry(sub, ctx), baseline, peerOpts)
                if (!(baseline.size >= 3 && info.trip)) break  // 已對上鄰卷
                const driftedPages = [...new Set(info.outlierQids
                  .map((q) => parseInt(String(q).split('-')[0], 10))
                  .filter((n) => Number.isFinite(n) && n > 0))]
                try {
                  const rr = await gradePhaseA(
                    sub.imageBlob, ANSWER_KEY, sub.pageBreaks, assignment?.domain, sub.assignmentId ?? assignment?.id,
                    undefined, assignment?.answerSheetMode, sub.id, sub.source, undefined,
                    attempt === 1
                      ? { stopAfterClassify: true }
                      : { stopAfterClassify: true, rerunPageNums: driftedPages.length > 0 ? driftedPages : undefined, priorClassifyContext: ctx }
                  )
                  if (rr.pipelineFailure) continue
                  const newCtx = (rr as unknown as { _phaseAClassifyContext?: unknown })._phaseAClassifyContext
                  if (newCtx) ctx = newCtx
                } catch (e) { console.error('[PeerCheck/recapture] rerun classify failed', e) }
              }
              const finalTrip = baseline.size >= 3 && checkPeerOutliers(classifyCtxToEntry(sub, ctx), baseline, peerOpts).trip
              if (finalTrip) {
                failedIds.add(sub.id)
                await markClassifyFail(sub, '答題位置抓不穩、請重新批改', {
                  stage: 'classify', reasonCode: 'CLASSIFY_BBOX_PEER_OUTLIER',
                  userMessage: 'AI 對這張的答題位置抓得不太穩。再批一次多半會好；如果同一張一直這樣，建議看看掃描是否完整、清晰。',
                  userAction: '', technical: { metrics: { peerOutlier: true } as Record<string, unknown> }
                })
                console.warn(`[PeerCheck/recapture] ${sub.id} 重跑仍框位異常、標記失敗`)
                return null
              }
              classifyCtxBySub.set(sub.id, ctx)  // 更新成對上鄰卷的乾淨 context
              bumpStage('classify', 'completed')  // 重跑到對得上鄰卷 → 此時才記 classify 完成 +1
              console.log(`[PeerCheck/recapture] ${sub.id} 重跑後框位正常`)
              return sub.id
            },
            () => {},
            stopRequestedRef
          )
          if (failedIds.size > 0) {
            for (let i = okSubs.length - 1; i >= 0; i--) if (failedIds.has(okSubs[i].id)) okSubs.splice(i, 1)
          }
        }
      }
      // 沒做系統檢查(照片卷/小批 pool<5)或沒漂移：classify 已在 STAGE 1 即時 +1、不需再動
    }

    // classify/read/arbiter 進度 total 改為通過系統檢查的卷數（part 卷可能 classify/系統檢查失敗）。
    //   classify 的 done 在 STAGE 2「通過系統檢查」時才 +1、故 done 會等於 okSubs.length=total → 顯示完成。
    setPipelineStageProgress((p) => ({
      ...p,
      classify: { ...p.classify, total: okSubs.length },
      read: { ...p.read, total: okSubs.length },
      arbiter: { ...p.arbiter, total: okSubs.length },
    }))

    // ── STAGE 3：read1 + read2 + read3(arbiter)（resume classify context、不重跑 classify）──
    // 2026-06-20 串流（只智慧批改 oneClickScope 非空）：read+arbiter 一份完就分流——
    //   乾淨→立刻排 Phase B；需複核→塞進複核佇列(讓老師立刻開始看)，不等全部 read 完。
    //   共用 semaphore：read+arbiter 與 乾淨/複核卷 Phase B 共吃、把同時打 Gemini 的重請求壓住、防 504。
    //   read+arbiter 額外仍受 runWithConcurrency 的 gradeConcurrency 上限（保險：semaphore 萬一失效也不暴衝）。
    const isStreaming = oneClickScopeRef.current.length > 0
    if (isStreaming) {
      reviewAppendedCountRef.current = 0
      setReviewStreamingDone(false)
      setBatchPhaseAEntries([])  // 清掉上一輪殘留、避免複核佇列出現重複/舊卷
      pipelineSemaphoreRef.current = makeSemaphore(gradeConcurrency + 1)
    }
    await runWithConcurrency(
      okSubs, gradeConcurrency, 2000,
      async (sub) => {
        if (stopRequestedRef.current) return null
        if (!sub.imageBlob) return null  // okSubs 已保證有圖
        const imageBlob = sub.imageBlob  // narrow Blob（給下方 closure 用、不然 closure 內會回 Blob|undefined）
        try {
          const runReadArbiter = () => gradePhaseA(
            imageBlob,
            ANSWER_KEY,
            sub.pageBreaks,
            assignment?.domain,
            sub.assignmentId ?? assignment?.id,  // 跨班：記到各份自己的作業（非批改時 === assignment.id）
            undefined,  // classifyCorrections — 重新截取不帶老師舊修正
            assignment?.answerSheetMode,
            sub.id,
            sub.source,
            // classify 已在 STAGE 1 跑完並通過系統檢查；這裡只跑 read1/read2/read3(arbiter)。
            // 過濾 classify 事件、避免 resume 模式重複計數 classify 進度。
            (stage, event) => { if (stage !== 'classify') bumpStage(stage, event) },
            { resumeClassifyContext: classifyCtxBySub.get(sub.id) }
          )
          const sem = isStreaming ? pipelineSemaphoreRef.current : null
          const phaseAResult = sem ? await sem.run(runReadArbiter) : await runReadArbiter()
          if (phaseAResult.pipelineFailure) {
            const stu = students.find((s) => s.id === sub.studentId)
            const label = stu ? `${stu.seatNumber}號 ${stu.name}` : sub.id.slice(-8)
            failReasons.push(`${label}: ${safeFailMsg(phaseAResult.pipelineFailure)}`)
            failCount++
            failedCandidates.push(sub)
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
          // 2026-05-18: Phase A only 不寫 score/maxScore/isCorrect、avoid modal 誤顯示「答錯 0/0」
          // status='synced' + score=undefined 讓 modal 知道「還沒批改」、用「未批改」badge 取代分數
          const detailsFromPhaseA = phaseAResult.questionResults.map((qr) => {
            const base = {
              questionId: qr.questionId,
              questionType: qr.questionType,
              // 故意不設 score / maxScore / isCorrect / reason — 等 Phase B 跑完才填
              readAnswer1: qr.readAnswer1,
              readAnswer2: qr.readAnswer2,
              arbiterResult: qr.arbiterResult,
              consistencyStatus: qr.consistencyStatus,
              answerBbox: qr.answerBbox,
              answerCropImageUrl: qr.answerCropImageUrl,
            }
            // VJ 視覺判斷題：Phase A 後就帶逐柱 vjItemResults（有畫=pending、沒畫=blank），
            // detail 直接顯示逐柱「有畫/沒畫」按鈕讓老師人工更正、不用等 Phase B。
            // studentAnswer 用摘要文案（圖上作答/未作答）取代內部 "label:有畫" 字串。
            const vjPerItem = qr.visualJudgment?.perItem
            if (['diagram_color', 'map_symbol', 'grid_geometry'].includes(qr.questionType || '')
              && Array.isArray(vjPerItem) && vjPerItem.length > 0) {
              const vjItemResults = vjPerItem.map((p) => ({
                idx: p.idx,
                label: p.label,
                verdict: (p.hasMark === 'yes' ? 'pending' : 'blank') as 'pending' | 'blank',
                reason: p.hasMark === 'yes' ? '有畫（待批改）' : '未作答',
              }))
              const anyDrawn = vjItemResults.some((r) => r.verdict !== 'blank')
              return { ...base, studentAnswer: anyDrawn ? '圖上作答' : '未作答', vjItemResults }
            }
            return {
              ...base,
              // map_fill 跳 Phase A Read、Phase B 才會視覺評分產生 studentAnswer；
              // 在那之前留空、avoid 顯示 "(填圖題...)" placeholder。
              studentAnswer: qr.questionType === 'map_fill'
                ? ''
                : (qr.arbiterResult?.finalAnswer || qr.readAnswer1?.studentAnswer || ''),
            }
          })
          // 不設 totalScore（修法後）— 等 Phase B 跑完才有
          const phaseAGradingResult = { details: detailsFromPhaseA } as unknown as Submission['gradingResult']
          const updatedAtMs = Date.now()
          // 2026-05-31: 重跑 Phase A → 只保留老師「親手輸入(source='manual')」的 finalAnswers、其餘清掉。
          // 為什麼：之前「自動採用一致讀取」或「面板選某個 AI 讀取」的題(ai_read1/ai_read2/ai_arbiter)，
          //   老師並沒有做真正的輸入決定。若不清、舊 finalAnswers 會遮蔽新 Phase A 的 needs_review
          //   (submissionPendingReview 走「已審查」分支)→ 該重審的題進不了審查。
          // 清掉的題用新 Phase A 重新決定(一致→Phase B 自動採用新讀取、不一致→重進審查)。
          // 手改的 seed 進 decisions、Phase B 重建時保住(VJ/map_fill 由各自 detection 重建、seed 對它們無效、無害)。
          const keptManualFA = (Array.isArray(sub.finalAnswers) ? sub.finalAnswers : [])
            .filter((fa) => fa?.finalAnswerSource === 'manual')
          const seededDecisions = new Map<string, ConsistencyDecision>()
          for (const fa of keptManualFA) {
            seededDecisions.set(fa.questionId, { questionId: fa.questionId, source: 'manual', finalAnswer: fa.finalStudentAnswer ?? '', confirmed: true })
          }
          // 2026-06-01: 本地立刻寫入新的 phaseAState（鏡像 server staged-grading.js:8861 的寫法）。
          // 否則本地 arbiterDecisions 仍是「重跑前」的舊版、submissionPendingReview / deriveCardStage
          //   會用舊 decisions 判出假性「需要複核」(已批改+stale 卷尤其明顯)、要等 sync(server-first) 拉回才消失
          //   (重整才好)→ 卡片誤分桶、一鍵又重抓去複核。下次 sync 用 server 完整版整份覆蓋、安全。
          const localPhaseAState: NonNullable<Submission['phaseAState']> = {
            ...(sub.phaseAState ?? {}),
            arbiterDecisions: phaseAResult.questionResults.map((qr) => ({
              questionId: qr.questionId,
              arbiterStatus: qr.arbiterResult?.arbiterStatus,
              finalAnswer: qr.arbiterResult?.finalAnswer,
              consistent: qr.arbiterResult?.consistent,
            })),
            savedAt: new Date().toISOString(),
          }
          await db.submissions.update(sub.id, {
            status: 'synced',  // 待批改 / 待複核（細狀態由 deriveCardStage 從 phase_a_state 算）
            gradingResult: phaseAGradingResult,
            phaseAState: localPhaseAState,  // 同步刷新本地 decisions、消假性待複核
            finalAnswers: keptManualFA,  // 清掉非 manual、留手改
            score: undefined,
            aiScore: undefined,
            gradedAt: undefined,
            updatedAt: updatedAtMs
          })
          // 把「只留 manual」的 finalAnswers 存回雲端、避免 sync 把舊的完整 finalAnswers 拉回來遮蔽
          fetch('/api/data/save-final-answers', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
            body: JSON.stringify({ submissions: [{ id: sub.id, finalAnswers: keptManualFA }] })
          }).catch(() => {/* non-fatal */})
          // 同步更新 React state、detail modal 立刻看到新資料、不用等 sync
          setSubmissions((prev) => {
            const next = new Map(prev)
            const cur = Array.from(prev.values()).find((s) => s.id === sub.id)
            if (cur) next.set(cur.studentId, {
              ...cur,
              status: 'synced',
              gradingResult: phaseAGradingResult,
              phaseAState: localPhaseAState,  // 同 Dexie：本地立刻刷新 decisions
              finalAnswers: keptManualFA,
              score: undefined,
              aiScore: undefined,
              gradedAt: undefined,
              updatedAt: updatedAtMs
            })
            return next
          })
          // 加入成功 entries、供後續判斷是否進審查頁（decisions 預先帶入手改、Phase B 重建保留）
          const newEntry: BatchPhaseAEntry = {
            submissionId: sub.id,
            studentId: sub.studentId,
            phaseAResult,
            decisions: seededDecisions,
            imageBlob: sub.imageBlob,
            pageBreaks: sub.pageBreaks
          }
          successfulEntries.push(newEntry)
          successCount++
          // 2026-06-20 串流分流（只智慧批改）：這份 read+arbiter 一完就立刻路由、不等其他卷。
          if (isStreaming) {
            const needsRev = newEntry.phaseAResult.questionResults.some((qr) =>
              questionNeedsConfirm(qr.arbiterResult?.arbiterStatus, qr.arbiterResult?.finalAnswer, qr.questionType))
            if (needsRev) {
              // 需複核 → 進複核佇列、立刻讓老師開始看（不等其他卷批完）。
              //   入口已 setBatchPhaseAEntries([]) 清空、每份 okSub 只處理一次、複核元件又依 submissionId 去重→不會重複。
              reviewAppendedCountRef.current++
              phaseAOnlyReviewModeRef.current = !opts?.chainPhaseB
              setBatchPhaseAEntries((prev) => (prev.some((e) => e.submissionId === newEntry.submissionId) ? prev : [...prev, newEntry]))
              setGradingPhase('awaiting_review')
            } else {
              // 乾淨 → 立刻排 Phase B（共用 semaphore；加進已背景批清單讓 runOneClickPhaseB 跳過、不重複批）
              oneClickBgGradedIdsRef.current.add(sub.id)
              const semB = pipelineSemaphoreRef.current
              const runB = () => executeBatchPhaseB([newEntry], true)
              backgroundPhaseBPromises.current.push(
                (semB ? semB.run(runB) : runB()).catch((err) => console.error('串流背景批乾淨卷失敗:', err))
              )
            }
          }
          return phaseAResult
        } catch (err) {
          const stu = students.find((s) => s.id === sub.studentId)
          const label = stu ? `${stu.seatNumber}號 ${stu.name}` : sub.id.slice(-8)
          const msg = safeFailMsg(err)
          failReasons.push(`${label}: ${msg}`)
          failCount++
          failedCandidates.push(sub)
          console.error(`[recaptureOnly] failed for ${sub.id}:`, err)
          // 2026-05-25: 同步寫 grading_failed 到 DB、避免卡片仍顯示「已上傳」徽章誤導老師
          const { failureGradingResult, updatedAt } = await persistGradingFailureFromException(sub.id, msg)
          setSubmissions((prev) => {
            const next = new Map(prev)
            const cur = Array.from(prev.values()).find((s) => s.id === sub.id)
            if (cur) next.set(cur.studentId, {
              ...cur,
              status: 'grading_failed',
              gradingResult: failureGradingResult,
              updatedAt,
            })
            return next
          })
          return null
        }
      },
      (_i, _result) => {
        completedCount++
        setGradingProgress({ current: completedCount, total: okSubs.length })
      },
      stopRequestedRef
    )

    // ── (舊) Peer baseline 偵測+重跑：已移到 STAGE 1/2（classify→系統檢查→read 之前）、此處整段移除 ──

    setIsGrading(false)
    setCurrentGradingStudent('')
    requestSync()  // 拉 server 寫的 phase_a_state 回來、卡片才會顯示 待複核/待批改

    // 把 Phase A 計數先 stash、若進審查頁、審查結束時再包成 notice 顯示
    phaseAStashRef.current = {
      successCount,
      failCount,
      totalCount: candidates.length,
      failReasons: failReasons.slice(0, 10),
      failedCandidates,
    }

    // 2026-06-20 串流：分流已在 loop 內逐份做完（需複核→佇列、乾淨→已排 Phase B）。
    //   標記 read+arbiter 全完→複核元件可收尾；有複核→交 onAllDone，無複核→回 false 讓 runOneClickPhaseB 批 needB。
    if (isStreaming) {
      setReviewStreamingDone(true)
      if (reviewAppendedCountRef.current > 0) {
        return true  // 複核已在串流中開始；streamingDone 後 onAllDone 觸發最終 Phase B
      }
      setGradingPhase('idle')
      return false
    }

    // 2026-05-18: 篩出有 needs_review 的 entries、若有 → 進審查頁（不接 Phase B）
    // 2026-05-30: 含 blank（空白要老師確認）
    const needsReviewEntries = successfulEntries.filter((entry) =>
      entry.phaseAResult.questionResults.some((qr) => questionNeedsConfirm(qr.arbiterResult?.arbiterStatus, qr.arbiterResult?.finalAnswer, qr.questionType))
    )
    if (needsReviewEntries.length > 0) {
      console.log(`[recaptureOnly] ${needsReviewEntries.length} 份有 needs_review、進審查頁`)
      // chainPhaseB=true → review-only 關閉、審查完接 Phase B；預設(undefined/false)→ review-only(現行)
      phaseAOnlyReviewModeRef.current = !opts?.chainPhaseB
      // 2026-06-20 省時：一鍵流程下、老師複核的同時把「不用複核的乾淨卷」在背景先批 Phase B
      //   （與複核時間重疊＝省掉這段 Phase B 的等待）。複核完 runOneClickPhaseB 會跳過這些已批的卷。
      //   executeBatchPhaseB(background=true) 不動 grading phase/loading UI（其副作用 state 皆未使用、
      //   phaseBTotalCount 維持 0 故 notice useEffect 不誤觸），安全在 awaiting_review 期間跑。
      if (oneClickScopeRef.current.length > 0) {
        const reviewIds = new Set(needsReviewEntries.map((e) => e.submissionId))
        const cleanEntries = successfulEntries.filter((e) => !reviewIds.has(e.submissionId))
        if (cleanEntries.length > 0) {
          cleanEntries.forEach((e) => oneClickBgGradedIdsRef.current.add(e.submissionId))
          console.log(`[oneClick] 複核時背景批 ${cleanEntries.length} 份乾淨卷 Phase B`)
          backgroundPhaseBPromises.current.push(
            executeBatchPhaseB(cleanEntries, true).catch((err) => console.error('背景批乾淨卷失敗:', err))
          )
        }
      }
      setBatchPhaseAEntries(needsReviewEntries)
      setGradingPhase('awaiting_review')
      // 不顯示 notice、讓老師直接進審查；審查全部完成時用 stash 包 Phase A notice
      return true
    } else {
      // 無 needs_review 直接收尾、顯示 Phase A 完成 notice
      setGradingPhase('idle')
      // 一鍵流程（suppressNotice）：略過 Phase A 自己的收尾 notice，留給統一 Phase B 的結果視窗
      if (!opts?.suppressNotice) {
        setPhaseAResultNotice({
          stopped: stopRequestedRef.current,
          successCount,
          failCount,
          needsReviewedCount: 0,
          totalCount: candidates.length,
          failReasons: failReasons.slice(0, 10),
          failedCandidates,
        })
      }
      phaseAStashRef.current = null
      return false
    }
  }, [
    inkSessionError, inkSessionReady, isGeminiAvailable, assignment, students,
    partitionCandidatesByCorrection, clearCorrectionForRerunOnServer, executeBatchPhaseB
  ])

  // 2026-05-17: Phase B only with fromCache 執行器
  // 給 selected/all 候選 submissions 各自跑 Phase B（用 server 端 cached phase_a_state）、
  // 不重跑 Phase A（省 4 min）。對應「批改作業」按鈕觸發。
  // 2026-05-31: opts.silent —「一鍵接著批改」的 needB 步驟用。跑完不跳結果 notice
  //（避免一鍵流程中途彈出 needB 的結果視窗、跟後面 Phase A 的視窗打架）。預設 false=現行。
  const executeGradeOnlyCache = useCallback(async (candidates: Submission[], opts?: { silent?: boolean; noticeOffset?: { success: number; total: number } }) => {
    if (candidates.length === 0) return
    if (inkSessionError) { alert(inkSessionError); return }
    if (!inkSessionReady) { alert('批改會話尚未準備完成、請稍候'); return }
    if (!isGeminiAvailable) { alert('Gemini 服務未設定'); return }
    // 2026-05-30: Phase B 重批不再整批清訂正/申訴；改逐題比對調和（reconcile-phase-b-regrade）。
    // 對「目前在訂正/申訴/已完成訂正」狀態的學生：算完 Phase B 後送 reconcile、只動對錯翻轉的題、
    // 保留未變動題的訂正/申訴成果、申訴中判對自動平反。其餘學生走原本 save-grading。
    // （政策見 redpenaisever/docs/批改重跑與清除政策.md §5）
    const reconcileStudentIds = new Set<string>()
    for (const sub of candidates) {
      const st = sub.studentId ? correctionStatusByStudent[sub.studentId] : undefined
      if (
        st === 'correction_required' || st === 'correction_in_progress' ||
        st === 'correction_pending_review' || st === 'correction_failed' ||
        st === 'correction_passed'
      ) reconcileStudentIds.add(sub.studentId)
    }

    setIsGrading(true)
    setGradingPhase('phase_b_running')
    setGradingMessage('AI 批改評分中（用快取的讀取結果）…')
    setError(null)
    setStopRequested(false)
    stopRequestedRef.current = false
    setPhaseBTotalCount(candidates.length)
    setPhaseBScoredCount(0)
    setGradingStartTime(Date.now())
    // Phase B only mode：accessor / explain 各 total = N
    setPipelineMode('phase_b_only')
    setPipelineStageProgress({
      classify: { started: 0, done: 0, total: 0 },
      read: { started: 0, done: 0, total: 0 },
      arbiter: { started: 0, done: 0, total: 0 },
      quality: { started: 0, done: 0, total: 0 },
      accessor: { started: 0, done: 0, total: candidates.length },
      explain: { started: 0, done: 0, total: candidates.length },
    })

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
          // 2026-05-31: Phase A 重跑後、finalAnswers 在 sync 是 local-first 凍結 → 用刷新後的 phaseAState
          //   重建 AI 自動題的最終答案（保留 source='manual'）、否則 Phase A 白跑、Phase B 批的是舊答案。
          const freshFinalAnswers = rebuildFinalAnswersFromPhaseAState(
            sub.phaseAState, sub.finalAnswers as FinalAnswer[] | undefined
          )
          const finalAnswersChanged =
            JSON.stringify(freshFinalAnswers ?? null) !== JSON.stringify((sub.finalAnswers as FinalAnswer[] | undefined) ?? null)
          const result = await gradePhaseBFromCache(
            sub.imageBlob,
            sub.id,
            assignment?.id,
            assignment?.domain,
            assignment?.answerSheetMode,
            gradeBand,
            freshFinalAnswers,
            (stage, event) => bumpStage(stage, event)
          )
          // 訂正/申訴中的學生：走 reconcile（server 端逐題調和 + 存回原卷、回傳調整後的 grade）。
          // 其餘學生：直接 save-grading。
          let finalResult = result
          if (reconcileStudentIds.has(sub.studentId)) {
            try {
              const rc = await fetch('/api/data/reconcile-phase-b-regrade', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                  assignmentId: assignment?.id,
                  studentId: sub.studentId,
                  submissionId: sub.id,
                  gradingResult: result,
                }),
              })
              const rcData = await rc.json().catch(() => ({}))
              if (rc.ok && rcData?.gradingResult) {
                finalResult = rcData.gradingResult
                console.log(`[reconcile] ${sub.studentId.slice(-6)} → ${rcData.newStatus}`, rcData.reconcile)
              } else {
                console.warn(`[reconcile] failed ${sub.id}:`, rcData?.error)
              }
            } catch (e) {
              console.warn(`[reconcile] error ${sub.id}:`, e)
            }
          }
          const totalScore = finalResult.totalScore ?? 0
          const gradedAtMs = Date.now()
          // Phase A 重跑刷新了最終答案 → 一併寫回 local（local-first sync 會保留）、讓 detail/品質頁「最終」也同步
          const finalAnswersPatch = (finalAnswersChanged && Array.isArray(freshFinalAnswers))
            ? { finalAnswers: freshFinalAnswers }
            : {}
          await db.submissions.update(sub.id, {
            status: 'graded',
            score: totalScore,
            aiScore: totalScore,
            scoreSource: 'ai',
            gradingResult: finalResult,
            gradedAt: gradedAtMs,
            updatedAt: gradedAtMs,
            ...finalAnswersPatch,
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
              gradingResult: finalResult,
              gradedAt: gradedAtMs,
              updatedAt: gradedAtMs,
              ...finalAnswersPatch,
            })
            return next
          })
          // 重建後的最終答案存回雲端（解決 final_answers 跟最新 read desync、品質頁「最終」顯示一致）
          if (finalAnswersChanged && Array.isArray(freshFinalAnswers)) {
            fetch('/api/data/save-final-answers', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ submissions: [{ id: sub.id, finalAnswers: freshFinalAnswers }] })
            }).catch(() => {/* non-fatal */})
          }
          // reconcile 已在 server 端存回原卷；非 reconcile 學生才需 save-grading（避免覆蓋 reconcile 結果）
          if (!reconcileStudentIds.has(sub.studentId)) {
            fetch('/api/data/save-grading', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({
                submissions: [{
                  id: sub.id, score: totalScore, aiScore: totalScore, scoreSource: 'ai',
                  gradingResult: finalResult, gradedAt: gradedAtMs
                }]
              })
            }).catch(() => {/* non-fatal */})
          }
          successCount++
          return finalResult
        } catch (err) {
          const stu = students.find((s) => s.id === sub.studentId)
          const label = stu ? `${stu.seatNumber}號 ${stu.name}` : sub.id.slice(-8)
          const msg = safeFailMsg(err)
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
    if (!opts?.silent) {
      // noticeOffset：把「複核期間已背景批的乾淨卷」數量加進總數、結果視窗才是正確總數。
      const off = opts?.noticeOffset
      setGradeResultNotice({
        stopped: stopRequestedRef.current,
        successCount: successCount + (off?.success ?? 0),
        failCount: failCount + ((off?.total ?? 0) - (off?.success ?? 0)),
        totalCount: candidates.length + (off?.total ?? 0),
        failReasons: failReasons.slice(0, 10),
        failedEntries: [],
      })
    }
  }, [
    inkSessionError, inkSessionReady, isGeminiAvailable, assignment, students,
    correctionStatusByStudent
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
    // 2026-05-30: Phase B 重批不再擋 correction_passed（政策 §4：重跑 Phase B = 逐題調和、不整批清）。
    // 已完成訂正的學生交給 executeGradeOnlyCache → reconcile-phase-b-regrade 逐題處理
    // （resolved/appeal_won 在矩陣裡保留、永不被覆蓋）。Phase A（handleRecaptureAll）仍擋 correction_passed。
    if (gradeButtonState.needsWarning) {
      setGradeOverwriteConfirm({
        submissions: inScope,
        overwriting: [...stageMap.graded, ...stageMap.phase_b_failed]
      })
      return
    }
    // 無風險、直接跑 Phase B only (fromCache)（先過墨水確認）
    setAdvInkConfirm({ kind: 'phase_b', count: inScope.length, run: () => { void executeGradeOnlyCache(inScope) } })
  }

  // 2026-05-31 一鍵 1c：對「本次一鍵的全 scope」跑一次統一 Phase B。
  //   從 Dexie 重讀 fresh submission（複核剛寫的 finalAnswers / sync 刷新的 phaseAState 都在 local），
  //   避免用 button-press 時凍結的 stale finalAnswers 蓋掉複核結果（payload 非空會覆蓋 server 快取）。
  //   過濾掉「Phase A 失敗且無 phase_a_state」的卷（批不了、避免製造 Phase B 失敗噪音）；
  //   phase_b_failed / 新擷取成功（local state 還沒 sync 回但 server 有）仍納入。
  const runOneClickPhaseB = async () => {
    const ids = oneClickScopeRef.current
    oneClickScopeRef.current = []
    if (ids.length === 0) return
    // 2026-06-20 省時：複核期間已背景批的乾淨卷 → 這裡跳過、不重複批；先等它們跑完（卡片/Dexie 都更新好）。
    const bgIds = oneClickBgGradedIdsRef.current
    oneClickBgGradedIdsRef.current = new Set()
    if (backgroundPhaseBPromises.current.length > 0) {
      await Promise.allSettled(backgroundPhaseBPromises.current)
      backgroundPhaseBPromises.current = []
    }
    let bgSuccess = 0
    for (const id of bgIds) {
      const s = await db.submissions.get(id)
      if (s?.status === 'graded') bgSuccess++
    }
    const restIds = ids.filter((id) => !bgIds.has(id))
    const fresh: Submission[] = []
    for (const id of restIds) {
      const s = await db.submissions.get(id)
      if (s) fresh.push(s)
    }
    const gradeable = fresh.filter((s) => {
      const ps = s.phaseAState as { arbiterDecisions?: unknown[] } | undefined
      const hasState = !!ps && Array.isArray(ps.arbiterDecisions) && ps.arbiterDecisions.length > 0
      const failed = !!(s.gradingResult as { pipelineFailure?: unknown } | undefined)?.pipelineFailure
      // 有 state 一定可批；沒 state 但也沒失敗（Path B 新擷取成功、sync 還沒回，server 端有 state）→ 仍批
      return hasState || !failed
    })
    if (gradeable.length > 0) {
      // noticeOffset：把背景批的乾淨卷數量加進結果視窗、總數才正確（不 silent → 當一鍵最終 modal）
      await executeGradeOnlyCache(gradeable, { noticeOffset: { success: bgSuccess, total: bgIds.size } })
    } else if (bgIds.size > 0) {
      // 全部都是背景批的乾淨卷（沒有要複核後再批的）→ 直接顯示結果視窗
      setGradeResultNotice({
        stopped: false,
        successCount: bgSuccess,
        failCount: bgIds.size - bgSuccess,
        totalCount: bgIds.size,
        failReasons: [],
        failedEntries: [],
      })
    }
  }

  // 2026-05-31 Phase1c（重做）：一鍵接著批改——把所有未完成的接著批改到完成。
  //   正確排序（消除 v1 兩限制）：① 先對「未擷取+待複核」跑 Phase A(review-only)
  //   ② 有待複核 → 複核（onAllDone）③ 複核完 / 無複核 → 對「全 scope(needA+needReview+needB)」跑一次統一 Phase B。
  //   一次 Phase B = 正確總數、乾淨的不會停在「待批改」。
  const handleOneClickContinue = async () => {
    setOneClickConfirmOpen(false)
    const { needA, needReview, needB } = unfinishedBuckets
    const scope = [...needA, ...needReview, ...needB]
    if (scope.length === 0) {
      alert('沒有未完成的作業')
      return
    }
    oneClickScopeRef.current = scope.map((s) => s.id)
    oneClickBgGradedIdsRef.current = new Set()
    try {
      const phaseATargets = [...needA, ...needReview]
      if (phaseATargets.length > 0) {
        // Phase A（review-only、keep-manual 保留手改）。enteredReview=true → 等審查 onAllDone 再跑統一 Phase B。
        const enteredReview = await executeRecaptureOnly(phaseATargets, { suppressNotice: true })
        if (enteredReview) return
      }
      // 無待複核（全乾淨）或純 needB → 立刻對全 scope 跑統一 Phase B
      await runOneClickPhaseB()
    } catch (e) {
      console.error('[oneClick] error', e)
      oneClickScopeRef.current = []
    }
  }

  // 2026-06-01 Phase3: 進階模式 helper。
  //   enterAdvanced：選定 Phase A/B、清掉殘留勾選、進勾選模式（卡片出現 ☑、底部出現確認列）。
  //   exitAdvanced：取消、退出勾選模式並清勾選。
  //   startAdvanced：執行選定動作（handleRecaptureAll/handleGradeOnly 各自會跳 block/warning modal、
  //     並同步讀取當下 selectedSubmissionIds 的 stageAggregates）→ 先退出勾選模式（藏 ☑/底部列、不影響 handler）。
  const enterAdvanced = (mode: 'phase_a' | 'phase_b') => {
    setAdvancedMenuOpen(false)
    setSelectedSubmissionIds(new Set())
    setAdvancedMode(mode)
  }
  const exitAdvanced = () => {
    setAdvancedMode(null)
    setSelectedSubmissionIds(new Set())
  }
  const startAdvanced = () => {
    const mode = advancedMode
    setAdvancedMode(null)  // 藏 ☑/底部列；handler 同步讀 stageAggregates memo（本 tick 未變）、不受影響
    if (mode === 'phase_a') void handleRecaptureAll()
    else if (mode === 'phase_b') void handleGradeOnly()
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
      // 5-stage overlay：全程 mode (Phase A → Phase B)、初始 started=0/done=0
      setPipelineMode('both')
      setPipelineStageProgress({
        classify: { started: 0, done: 0, total: toGrade.length },
        read: { started: 0, done: 0, total: toGrade.length },
        arbiter: { started: 0, done: 0, total: toGrade.length },
        quality: { started: 0, done: 0, total: 0 },
        accessor: { started: 0, done: 0, total: toGrade.length },
        explain: { started: 0, done: 0, total: toGrade.length },
      })

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
            sub.assignmentId ?? assignment.id,
            undefined,
            assignment.answerSheetMode,
            sub.id,
            sub.source,
            (stage, event) => bumpStage(stage, event)
          )
          return { sub, phaseAResult }
        },
        (i, result, err) => {
          completedA++
          setGradingProgress({ current: completedA, total: toGrade.length })
          if (stopRequestedRef.current || !result) {
            if (err) {
              const failedSub = toGrade[i]
              console.error(`Phase A failed for ${failedSub.id}:`, err)
              // 2026-05-25: gradePhaseA throw 時也要寫 grading_failed、避免卡片誤顯示「已上傳」
              // userMessage 來自 synthetic failure、最終 dialog 由 phaseAFailures 統一格式化
              const msg = err instanceof Error ? err.message : String(err)
              void persistGradingFailureFromException(failedSub.id, msg).then(({ failure }) => {
                phaseAFailures.push({ submissionId: failedSub.id, studentId: failedSub.studentId, failure })
              })
            }
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
            pageBreaks: sub.pageBreaks,
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
              const phaseAResult = await gradePhaseA(sub.imageBlob, assignment.answerKey!, sub.pageBreaks, assignment.domain, sub.assignmentId ?? assignment.id, corrections, assignment.answerSheetMode, sub.id, sub.source)
              return { idx, phaseAResult }
            },
            (i, result, err) => {
              if (!result) {
                if (err) {
                  console.error('[QualityCheck] retry failed:', err)
                  // 2026-05-25: throw 時也要寫 grading_failed
                  const failedEntry = entries[indicesToRetry[i]]
                  if (failedEntry) {
                    const msg = err instanceof Error ? err.message : String(err)
                    void persistGradingFailureFromException(failedEntry.submissionId, msg).then(({ failure }) => {
                      phaseAFailures.push({ submissionId: failedEntry.submissionId, studentId: failedEntry.studentId, failure })
                    })
                  }
                }
                return
              }
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

        // ── Post-batch peer baseline 比對（版面一致卷：answer_only 或 PDF）──
        // 用 batch 內其他 sub 的 bbox median 當基準、回頭檢查每份是否有 partial/全 shift。
        // 啟用條件：answer_only（既有）或 PDF 卷（source='teacher_scan'，版面像素級一致、
        //   classify 偶發整欄抽歪可被可靠偵測）；且 validEntries >= 5（peer 太少不可靠）。
        // PDF 用校準門檻（逐格 |dy|>0.015 任型 或 |dx|>0.08 位置固定型，任一格即 trip）：
        //   依 401英語卷 30人實測乾淨地板(dy max 0.009 / 固定型 dx max 0.044) vs 漂移(dy~0.024 / dx~0.42)。
        //   照片卷（teacher_camera / student_upload）版面不一致、不啟用以免誤判。
        // 失敗動作：retry 整個 Phase A 一次、仍 outlier → grading_failed。
        const isPdfBatch =
          validEntries.length > 0 &&
          validEntries.every((e) => toGrade.find((s) => s.id === e.submissionId)?.source === 'teacher_scan')
        const peerCheckEnabled = assignment?.answerSheetMode === 'answer_only' || isPdfBatch
        const peerOpts: { dyThreshold?: number; dxThreshold?: number; minOutlierCount?: number } =
          assignment?.answerSheetMode === 'answer_only'
            ? {}
            : { dyThreshold: 0.015, dxThreshold: 0.08, minOutlierCount: 1 }
        if (peerCheckEnabled && validEntries.length >= 5 && !stopRequestedRef.current) {
          setGradingMessage('Peer baseline 比對中…')
          const peerOutlierTrips: Array<{ entry: BatchPhaseAEntry; outlierCount: number; outlierQids: string[] }> = []
          for (const entry of validEntries) {
            const baseline = computePeerBaseline(validEntries, entry.submissionId)
            if (baseline.size < 3) continue
            const result = checkPeerOutliers(entry, baseline, peerOpts)
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
                // 2026-06-20: 重跑到對得上鄰卷為止(上限 3)。漂移＝模型隨機 off-by-one(約 50%/次)、鄰卷中位數即正解；
                //   挑「不再 outlier」的那次收下。只重跑 1 次時兩次都歪≈25% 冤枉失敗卡；3 次降到 ≈6%。
                const baseline = computePeerBaseline(
                  validEntries.filter((e) => e.submissionId !== item.entry.submissionId),
                  item.entry.submissionId
                )
                const MAX_RERUN_ATTEMPTS = 3
                let phaseAResult: PhaseAResult | null = null
                for (let attempt = 1; attempt <= MAX_RERUN_ATTEMPTS; attempt++) {
                  if (stopRequestedRef.current) break
                  console.log(`📄 [PeerCheck retry] student=${sub.studentId} attempt=${attempt}/${MAX_RERUN_ATTEMPTS}`)
                  phaseAResult = await gradePhaseA(
                    sub.imageBlob,
                    assignment.answerKey!,
                    sub.pageBreaks,
                    assignment.domain,
                    sub.assignmentId ?? assignment.id,
                    undefined,
                    assignment.answerSheetMode,
                    sub.id,
                    sub.source
                  )
                  if (phaseAResult.pipelineFailure) continue
                  const stillTrips = baseline.size >= 3 &&
                    checkPeerOutliers({ ...item.entry, phaseAResult }, baseline, peerOpts).trip
                  if (!stillTrips) break  // 對上鄰卷了、收下
                }
                if (!phaseAResult) return null
                return { item, phaseAResult }
              },
              (i, result, err) => {
                if (!result) {
                  if (err) {
                    console.error('[PeerCheck retry] failed:', err)
                    // 2026-05-25: throw 時也要寫 grading_failed
                    const failedItem = peerOutlierTrips[i]
                    if (failedItem) {
                      const msg = err instanceof Error ? err.message : String(err)
                      void persistGradingFailureFromException(failedItem.entry.submissionId, msg).then(({ failure }) => {
                        phaseAFailures.push({ submissionId: failedItem.entry.submissionId, studentId: failedItem.entry.studentId, failure })
                      })
                    }
                  }
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
              const recheck = checkPeerOutliers(tempEntry, baseline, peerOpts)

              if (recheck.trip) {
                // 仍 outlier → grading_failed
                const failure: import('@/lib/gemini').PipelineFailure = {
                  stage: 'classify',
                  reasonCode: 'CLASSIFY_BBOX_PEER_OUTLIER',
                  // 2026-06-20: 老師看友善句（② 答題位置沒抓穩）；技術細節留 technical
                  userMessage: 'AI 對這張的答題位置抓得不太穩。再批一次多半會好；如果同一張一直這樣，建議看看掃描是否完整、清晰。',
                  userAction: '',
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

        // ── 穩定學生立刻送 Accessor（背景） ── 2026-05-30: blank 也算需審查、不自動送
        const isNeedsReview = (e: BatchPhaseAEntry) =>
          e.phaseAResult.questionResults.some(qr =>
            questionNeedsConfirm(qr.arbiterResult?.arbiterStatus, qr.arbiterResult?.finalAnswer, qr.questionType)
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

  // 2026-05-18 PR3: 單題學生答案 inline edit、debounce 1s 後 auto save
  // 寫進 gradingResult.details[i].studentAnswer + final_answers[i] + 雲端 save-final-answers
  // 已批改的卷子改答案：score 不會自動重算（會在 UI 顯示「分數已過時、建議重新批改」）
  const studentAnswerSaveTimeoutsRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map())
  const handleDetailStudentAnswerChange = (index: number, newAnswer: string) => {
    if (!selectedSubmission) return
    // 即時更新 editableDetails（UI 立刻反映）
    setEditableDetails((prev) => prev.map((d, i) => (i === index ? { ...d, studentAnswer: newAnswer } : d)))

    // Debounce 1s 後 persist
    const prevTimeout = studentAnswerSaveTimeoutsRef.current.get(index)
    if (prevTimeout) clearTimeout(prevTimeout)
    const timeout = setTimeout(async () => {
      studentAnswerSaveTimeoutsRef.current.delete(index)
      const subId = selectedSubmission.submission.id
      const submission = await db.submissions.get(subId)
      if (!submission) return
      const latestDetails = (submission.gradingResult as { details?: Array<{ questionId: string; studentAnswer?: string }> } | undefined)?.details
      const updatedDetails = Array.isArray(latestDetails)
        ? latestDetails.map((d, i) => (i === index ? { ...d, studentAnswer: newAnswer } : d))
        : null
      if (!updatedDetails) return
      const newGradingResult = { ...(submission.gradingResult || {}), details: updatedDetails } as Submission['gradingResult']
      // 用所有 details 重建 finalAnswers（保留現有 source、改的那題標 manual）
      const existingFinalByQid = new Map(
        (Array.isArray(submission.finalAnswers) ? submission.finalAnswers : []).map((fa) => [fa.questionId, fa])
      )
      const newFinalAnswers: FinalAnswer[] = updatedDetails.map((d, i) => {
        const qid = d.questionId
        const existing = existingFinalByQid.get(qid)
        if (i === index) {
          return {
            questionId: qid,
            finalStudentAnswer: newAnswer,
            finalAnswerSource: 'manual',
          }
        }
        return existing
          ? {
              questionId: qid,
              finalStudentAnswer: existing.finalStudentAnswer,
              finalAnswerSource: (existing.finalAnswerSource as FinalAnswer['finalAnswerSource']) || 'ai_read1'
            }
          : {
              questionId: qid,
              finalStudentAnswer: String(d.studentAnswer || ''),
              finalAnswerSource: 'ai_read1'
            }
      })
      const now = Date.now()
      // 2026-05-18: 動到答案 = 卡片自動回退到「待批改」、score / aiScore / gradedAt 清掉
      // 老師看卡片狀態就知道要重評、不需要 banner 提示
      // 對應 user 的設計精神：「動答案就要重批改」、避免「graded 但分數過時」這中間態
      const isCurrentlyGraded = submission.status === 'graded'
      const updatedSubFields: Partial<Submission> = {
        gradingResult: newGradingResult,
        finalAnswers: newFinalAnswers,
        updatedAt: now,
        ...(isCurrentlyGraded ? {
          status: 'synced' as const,
          score: undefined,
          aiScore: undefined,
          scoreSource: undefined,
          gradedAt: undefined
        } : {})
      }
      await db.submissions.update(subId, updatedSubFields)
      setSubmissions((prev) => {
        const next = new Map(prev)
        const cur = Array.from(prev.values()).find((s) => s.id === subId)
        if (cur) next.set(cur.studentId, { ...cur, ...updatedSubFields })
        return next
      })
      // 同步 selectedSubmission、detail modal 立刻反映
      setSelectedSubmission((prev) => prev ? {
        ...prev,
        submission: { ...prev.submission, ...updatedSubFields }
      } : prev)
      // 寫雲端：final_answers 寫進去（save-grading 也順便清 score、若卡片從 graded 退回）
      void fetch('/api/data/save-final-answers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ submissions: [{ id: subId, finalAnswers: newFinalAnswers }] })
      }).catch((err) => console.warn('save-final-answers failed (non-fatal):', err))
      // 若卡片從 graded 退回 synced、也要通知 server 清 score / status
      if (isCurrentlyGraded) {
        void fetch('/api/data/save-grading', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            submissions: [{
              id: subId,
              status: 'synced',
              score: null,
              aiScore: null,
              scoreSource: null,
              gradedAt: null,
              gradingResult: newGradingResult
            }]
          })
        }).catch((err) => console.warn('save-grading (revert) failed (non-fatal):', err))
      }
    }, 1000)
    studentAnswerSaveTimeoutsRef.current.set(index, timeout)
  }

  // 2026-05-30: VJ 視覺判斷題 — 老師逐柱切「有畫/沒畫」（取代文字編輯）。
  // 寫回 finalAnswers[qid].vjBlankConfirmed（整題逐柱）+ studentAnswer 摘要、卷退回待批改、重批時 Phase B 照此判分。
  const handleDetailVjBlankToggle = async (index: number, itemIdx: number, newIsBlank: boolean) => {
    if (!selectedSubmission) return
    if (isBusy || isSavingScore) return
    const subId = selectedSubmission.submission.id
    const applyItems = (items: Array<{ idx: number; label: string; verdict: string; reason: string }>) =>
      items.map((it) => it.idx === itemIdx
        ? { ...it, verdict: newIsBlank ? 'blank' : 'pending', reason: newIsBlank ? '未作答' : '待重新批改' }
        : it)
    const summaryOf = (items: Array<{ verdict: string }>) =>
      items.some((it) => it.verdict !== 'blank') ? '圖上作答' : '未作答'

    // 即時更新 UI
    setEditableDetails((prev) => prev.map((d: any, i: number) => {
      if (i !== index) return d
      const items = Array.isArray(d.vjItemResults) ? d.vjItemResults : []
      const next = applyItems(items)
      return { ...d, vjItemResults: next, studentAnswer: summaryOf(next) }
    }))

    // 持久化
    const submission = await db.submissions.get(subId)
    if (!submission) return
    const grDetails = (submission.gradingResult as { details?: any[] } | undefined)?.details
    if (!Array.isArray(grDetails)) return
    const targetDetail = grDetails[index]
    const qid: string = targetDetail?.questionId
    if (!qid) return
    // db 的 detail 可能沒帶 vjItemResults（舊資料）→ fallback 用 editableDetails 重建出來的那份當基底，
    // 並把結果寫回 db.detail（補上 vjItemResults）。
    const items = (Array.isArray(targetDetail?.vjItemResults) && targetDetail.vjItemResults.length > 0)
      ? targetDetail.vjItemResults
      : (Array.isArray(editableDetails[index]?.vjItemResults) ? editableDetails[index].vjItemResults : [])
    const nextItems = applyItems(items)
    const summary = summaryOf(nextItems)
    const updatedDetails = grDetails.map((d, i) => (i === index ? { ...d, vjItemResults: nextItems, studentAnswer: summary } : d))
    const newGradingResult = { ...(submission.gradingResult || {}), details: updatedDetails } as Submission['gradingResult']

    // vjBlankConfirmed：整題逐柱（isBlank = verdict==='blank'）
    const vjBlankConfirmed = nextItems.map((it: { idx: number; verdict: string }) => ({ idx: it.idx, isBlank: it.verdict === 'blank' }))
    const existingByQid = new Map(
      (Array.isArray(submission.finalAnswers) ? submission.finalAnswers : []).map((fa) => [fa.questionId, fa])
    )
    existingByQid.set(qid, {
      questionId: qid,
      finalStudentAnswer: summary,
      finalAnswerSource: 'manual',
      vjBlankConfirmed,
    } as FinalAnswer)
    const newFinalAnswers = Array.from(existingByQid.values()) as FinalAnswer[]

    const now = Date.now()
    const isCurrentlyGraded = submission.status === 'graded'
    const updatedSubFields: Partial<Submission> = {
      gradingResult: newGradingResult,
      finalAnswers: newFinalAnswers,
      updatedAt: now,
      ...(isCurrentlyGraded ? {
        status: 'synced' as const, score: undefined, aiScore: undefined, scoreSource: undefined, gradedAt: undefined
      } : {})
    }
    await db.submissions.update(subId, updatedSubFields)
    setSubmissions((prev) => {
      const next = new Map(prev)
      const cur = Array.from(prev.values()).find((s) => s.id === subId)
      if (cur) next.set(cur.studentId, { ...cur, ...updatedSubFields })
      return next
    })
    setSelectedSubmission((prev) => prev ? { ...prev, submission: { ...prev.submission, ...updatedSubFields } } : prev)
    void fetch('/api/data/save-final-answers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ submissions: [{ id: subId, finalAnswers: newFinalAnswers }] })
    }).catch((err) => console.warn('save-final-answers (vj) failed:', err))
    if (isCurrentlyGraded) {
      void fetch('/api/data/save-grading', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ submissions: [{ id: subId, status: 'synced', score: null, aiScore: null, scoreSource: null, gradedAt: null, gradingResult: newGradingResult }] })
      }).catch((err) => console.warn('save-grading (vj revert) failed:', err))
    }
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

    // 2026-05-28: 手動改分數時、依新 details.isCorrect 重建 mistakes
    // 之前 mistakes 是 spread 舊的、會出現「改對→錯但 mistakes 沒新增」「改錯→對但 mistakes 沒移除」
    // 導致學生端訂正清單跟老師批改不一致（user 回報 bug）
    const oldMistakesByQid = new Map<string, any>()
    if (Array.isArray(submission.gradingResult?.mistakes)) {
      for (const m of submission.gradingResult.mistakes as any[]) {
        if (m?.questionId) oldMistakesByQid.set(m.questionId, m)
      }
    }
    newGradingResult.mistakes = cleanedDetails
      .filter((d: any) => d?.isCorrect === false && d?.questionId)
      .map((d: any) => {
        const existing = oldMistakesByQid.get(d.questionId)
        return existing
          ? { ...existing, reason: d.reason || existing.reason }
          : {
              questionId: d.questionId,
              questionText: d.questionText || '',
              studentAnswer: d.studentAnswer || '',
              correctAnswer: d.correctAnswer || '',
              reason: d.reason || '手動標記為錯誤'
            }
      })

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
        // 2026-05-28: 加 fromManualScoreEdit=true、讓 server applySubmissionStateTransitions
        // 知道這是手動改分數、不要 skip 已在訂正流程的學生
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ submissions: [{ id, score: newTotal, aiScore: newTotal, scoreSource: 'ai', gradingResult: newGradingResult, gradedAt: now }], fromManualScoreEdit: true })
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
  // 2026-06-01: getDisplayReviewReasons / selectedReviewReasons / selectedConfidenceLabel 隨「需要複核」橫幅移除

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

  // 2026-06-01 Phase3: 「智慧批改 ▼」分段按鈕的衍生狀態
  //   左半=智慧批改（一鍵接著批改）；右半 ▼=進階選單。total=0 時左半鎖住改字「已批改完成」、▼ 仍可點。
  const smartHasWork = unfinishedBuckets.total > 0
  const smartHasSubs = submissions.size > 0
  const smartBusy = isGrading || isDownloading || isRefreshing || isCheckingCorrectionState || !isGeminiAvailable || !inkSessionReady || answerKeyStatus === 'deleted'
  const smartLabel = smartHasWork ? `智慧批改 (${unfinishedBuckets.total})` : (smartHasSubs ? '已批改完成' : '智慧批改')
  const smartLeftDisabled = smartBusy || !smartHasWork
  const advTriggerDisabled = isBusy || isDownloading || isRefreshing || isCheckingCorrectionState || !inkSessionReady || !smartHasSubs

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

      {/* 2026-05-28: Q1 — 已完成訂正擋下 Phase A/B 重跑 */}
      {correctionPassedBlockModal && (
        <div className="fixed inset-0 bg-black/50 z-[120] flex items-center justify-center">
          <div className="bg-white rounded-xl border border-slate-200 p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-bold text-gray-900 mb-3">
              {correctionPassedBlockModal.action === 'recapture' ? '無法重新截取' : '無法重新批改'}
            </h3>
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-sm text-emerald-800 mb-4">
              以下 {correctionPassedBlockModal.blockedStudents.length} 位學生已完成訂正、不能重跑批改。
              <br />
              若真的要重批、請先到「作業訂正看板」退回訂正、清掉已通過狀態後再操作。
            </div>
            <div className="max-h-60 overflow-y-auto mb-4 border border-gray-100 rounded-lg">
              <ul className="text-sm divide-y divide-gray-100">
                {correctionPassedBlockModal.blockedStudents.map((s) => (
                  <li key={s.studentId} className="px-3 py-2 flex justify-between items-center">
                    <span className="text-gray-700">{s.seatNumber ?? '?'}號 {s.name}</span>
                    <span className="text-xs text-emerald-700 font-medium">訂正完成</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setCorrectionPassedBlockModal(null)}
                className="flex-1 px-4 py-3 bg-slate-900 text-white rounded-xl hover:bg-slate-700 transition-colors font-medium"
              >
                了解
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 2026-06-01: 智慧批改確認——套共用 InkConfirmModal（墨水花費提醒 + 同意/不同意） */}
      <InkConfirmModal
        open={oneClickConfirmOpen}
        warning="批改會消耗墨水（點數）"
        onCancel={() => setOneClickConfirmOpen(false)}
        onConfirm={() => { void handleOneClickContinue() }}
      >
        <div className="mb-2">
          即將處理 <strong>{unfinishedBuckets.total}</strong> 份還沒完成的作業。
        </div>
        <ul className="mb-3 list-none space-y-1">
          {unfinishedBuckets.needA.length > 0 && <li>🔵 <strong>{unfinishedBuckets.needA.length}</strong> 份未擷取</li>}
          {unfinishedBuckets.needB.length > 0 && <li>🟢 <strong>{unfinishedBuckets.needB.length}</strong> 份待批改</li>}
        </ul>
        <div className="text-slate-600">
          ℹ️ 過程中若 AI 對某些答案沒把握，會請你確認再繼續；可隨時暫停、之後接著做。
        </div>
      </InkConfirmModal>

      {/* 2026-06-01: 進階「無覆寫風險直接跑」的墨水確認 */}
      <InkConfirmModal
        open={!!advInkConfirm}
        warning={advInkConfirm?.kind === 'phase_a' ? '重新截取會消耗墨水（點數）' : '重新批改會消耗墨水（點數）'}
        onCancel={() => setAdvInkConfirm(null)}
        onConfirm={() => { const a = advInkConfirm; setAdvInkConfirm(null); a?.run() }}
      >
        即將{advInkConfirm?.kind === 'phase_a' ? '重新截取答案' : '重新批改'} <strong>{advInkConfirm?.count ?? 0}</strong> 份作業。
      </InkConfirmModal>

      {/* 2026-05-30: 重新截取危險確認（severity medium：清讀值/分數、擋已完成訂正） */}
      <DangerConfirmModal
        open={!!recaptureConfirm}
        severity="medium"
        title="重新截取答案"
        clears={['AI 讀取結果', '批改分數', '訂正狀態']}
        keeps={['學生作答照片']}
        affectedNoun="份作業"
        inkNote="重新截取會消耗墨水（點數）"
        affected={(recaptureConfirm?.cleared ?? []).map((sub) => {
          const stu = students.find((s) => s.id === sub.studentId)
          const stage = deriveCardStage(sub, correctionStatusByStudent[sub.studentId])
          return {
            id: sub.id,
            label: stu ? `${stu.seatNumber}號 ${stu.name}` : sub.id.slice(-8),
            meta: `${CARD_STAGE_LABEL[stage]}${sub.score != null ? `（${sub.score}分）` : ''}`,
          }
        })}
        confirmLabel="仍要重新截取"
        cancelLabel="取消"
        onCancel={() => setRecaptureConfirm(null)}
        onConfirm={() => {
          const candidates = recaptureConfirm?.submissions ?? []
          setRecaptureConfirm(null)
          void executeRecaptureOnly(candidates)
        }}
      />

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
                  const stage = deriveCardStage(sub, correctionStatusByStudent[sub.studentId])
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

      {/* 2026-05-30: 批改作業覆寫確認（severity low：Phase B 只重算分；訂正中學生走 reconcile 逐題調和、不粗暴覆寫） */}
      <DangerConfirmModal
        open={!!gradeOverwriteConfirm}
        severity="low"
        title="重新批改"
        clears={['舊分數']}
        keeps={['訂正/申訴紀錄（逐題調和保留）']}
        affectedNoun="份已批改"
        inkNote="重新批改會消耗墨水（點數）"
        affected={(gradeOverwriteConfirm?.overwriting ?? []).map((sub) => {
          const stu = students.find((s) => s.id === sub.studentId)
          return {
            id: sub.id,
            label: stu ? `${stu.seatNumber}號 ${stu.name}` : sub.id.slice(-8),
            meta: sub.score != null ? `${sub.score}分` : '失敗',
          }
        })}
        confirmLabel="仍要重新批改"
        cancelLabel="取消"
        onCancel={() => setGradeOverwriteConfirm(null)}
        onConfirm={() => {
          const candidates = gradeOverwriteConfirm?.submissions ?? []
          setGradeOverwriteConfirm(null)
          void executeGradeOnlyCache(candidates)
        }}
      />

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

      {phaseAResultNotice && (
        <div className="fixed inset-0 bg-black/50 z-[120] flex items-center justify-center">
          <div className="bg-white rounded-xl border border-slate-200 p-6 max-w-xl w-full mx-4">
            <h3 className="text-lg font-bold text-gray-900 mb-4">
              {phaseAResultNotice.stopped ? '已停止讀取' : '答案讀取完成'}
            </h3>
            <div className="space-y-3 mb-6">
              <div className="flex justify-between items-center py-2 border-b border-gray-100">
                <span className="text-gray-600">成功讀取</span>
                <span className="font-semibold text-emerald-600">{phaseAResultNotice.successCount} 份</span>
              </div>
              {phaseAResultNotice.needsReviewedCount > 0 && (
                <div className="flex justify-between items-center py-2 border-b border-gray-100">
                  <span className="text-gray-600">已完成審查</span>
                  <span className="font-semibold text-indigo-600">{phaseAResultNotice.needsReviewedCount} 份</span>
                </div>
              )}
              <div className="flex justify-between items-center py-2 border-b border-gray-100">
                <span className="text-gray-600">讀取失敗</span>
                <span className="font-semibold text-rose-600">{phaseAResultNotice.failCount} 份</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-gray-100">
                <span className="text-gray-600">總作業數</span>
                <span className="font-semibold text-gray-900">{phaseAResultNotice.totalCount} 份</span>
              </div>
              {phaseAResultNotice.failReasons.length > 0 && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2">
                  <p className="text-sm font-medium text-rose-700 mb-2">失敗原因</p>
                  <ul className="space-y-1 max-h-44 overflow-y-auto pr-1">
                    {phaseAResultNotice.failReasons.map((reason, index) => (
                      <li key={`${index}-${reason}`} className="text-sm text-rose-700 break-words leading-relaxed">
                        {index + 1}. {reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {phaseAResultNotice.stopped && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
                  你已手動停止讀取，系統僅保留已完成的部分。
                </div>
              )}
              {phaseAResultNotice.successCount > 0 && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                  讀取完成的作業可按「批改作業」開始正式評分。
                </div>
              )}
            </div>
            <div className="flex flex-col gap-2">
              {phaseAResultNotice.failedCandidates.length > 0 && (
                <button
                  onClick={() => {
                    const toRetry = phaseAResultNotice.failedCandidates
                    setPhaseAResultNotice(null)
                    void executeRecaptureOnly(toRetry)
                  }}
                  className="w-full rounded-xl bg-rose-600 px-4 py-3 text-sm font-medium text-white hover:bg-rose-700 transition-colors"
                >
                  重新讀取失敗的 {phaseAResultNotice.failedCandidates.length} 份
                </button>
              )}
              <button
                onClick={() => setPhaseAResultNotice(null)}
                className="w-full rounded-xl bg-slate-900 px-4 py-3 text-sm font-medium text-white hover:bg-slate-700 transition-colors"
              >
                關閉
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
      <div className={`${embedded ? 'max-w-none mx-0 pt-0' : 'max-w-7xl mx-auto pt-8'}${advancedMode !== null ? ' pb-24' : ''}`}>
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
            {/* 2026-06-19: 跨班「＋新增班級」——同答案卷的其他班可加進來、共用同一組批改按鈕一起批改。
                只在有可加入的班級且非進階勾選模式時出現。加錯了用「重設班級」回到原本進來那班。 */}
            {advancedMode === null && siblingClasses.length > 0 && (
              <div className="relative inline-flex">
                <button
                  type="button"
                  onClick={() => setAddClassMenuOpen((v) => !v)}
                  disabled={isGrading || isDownloading || isRefreshing}
                  title="把同一張答案卷的其他班級加進來、一起批改"
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Plus className="w-4 h-4" />
                  新增班級
                </button>
                {addClassMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-[105]" onClick={() => setAddClassMenuOpen(false)} />
                    <div className="absolute right-0 top-full z-[106] mt-1 w-64 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
                      <div className="px-3 py-1.5 text-xs font-medium text-slate-400">同答案卷的其他班級</div>
                      {siblingClasses.map((sc) => {
                        const disabled = sc.uploadedCount < 1 || !sc.hasAnswerKey
                        return (
                          <button
                            key={sc.assignmentId}
                            type="button"
                            disabled={disabled}
                            onClick={() => {
                              setAddedAssignmentIds((prev) => prev.includes(sc.assignmentId) ? prev : [...prev, sc.assignmentId])
                              setAddClassMenuOpen(false)
                            }}
                            className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-sm text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300"
                          >
                            <span className="truncate">{sc.className}</span>
                            <span className="shrink-0 text-xs text-slate-400">{sc.uploadedCount < 1 ? '未匯入' : `已上傳 ${sc.uploadedCount}`}</span>
                          </button>
                        )
                      })}
                    </div>
                  </>
                )}
              </div>
            )}
            {advancedMode === null && addedAssignmentIds.length > 0 && (
              <button
                type="button"
                onClick={() => setAddedAssignmentIds([])}
                disabled={isGrading || isDownloading || isRefreshing}
                title="移除所有新增的班級、回到原本進來的那一班"
                className="inline-flex items-center gap-1 rounded-lg px-2 py-2 text-sm font-medium text-slate-500 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                重設班級
              </button>
            )}
            {/* 2026-05-18: 待複核按鈕拿掉、user 在 PR2 設計討論時決定移除（卡片本身會用顏色標出待複核狀態） */}
            <Button
              variant="outline"
              onClick={handleRefresh}
              disabled={isRefreshing}
            >
              <RefreshCw className={`w-5 h-5 ${isRefreshing ? 'animate-spin' : ''}`} />
              重新整理
            </Button>
            {/*
              2026-06-01 Phase3: 分段式「智慧批改 ▼」主按鈕。左半=智慧批改(一鍵接著批改)、右半 ▼=進階選單。
              進階勾選模式中(advancedMode!==null)整顆收起、動作改由底部確認列驅動。
              total=0 時左半鎖住改字「已批改完成」、▼ 仍可點(讓老師仍能挑份重跑)。
              ▼ 選單：截取答案(Phase A)/批改作業(Phase B)→ 進勾選模式(卡片出 ☑ + 底部確認列)、
              動作仍走既有 handleRecaptureAll / handleGradeOnly(含 block/warning modal、用 selectedSubmissionIds)。
            */}
            {advancedMode === null && (
              <div className="relative inline-flex">
                <div className="inline-flex">
                  <button
                    type="button"
                    onClick={() => setOneClickConfirmOpen(true)}
                    disabled={smartLeftDisabled}
                    title={smartHasWork ? '把所有未完成的作業一次批改到完成（已完成的略過）' : '目前沒有未完成的作業'}
                    className={`inline-flex items-center gap-2 rounded-l-lg border px-4 py-2 text-sm font-semibold transition-colors active:scale-[0.98] ${
                      smartLeftDisabled
                        ? 'border-slate-300 bg-white text-slate-400 cursor-not-allowed active:scale-100'
                        : 'border-green-600 bg-green-600 text-white hover:border-green-700 hover:bg-green-700'
                    }`}
                  >
                    {smartHasWork ? <Sparkles className="w-5 h-5" /> : <CheckCircle2 className="w-5 h-5" />}
                    {smartLabel}
                  </button>
                  <button
                    type="button"
                    onClick={() => setAdvancedMenuOpen((v) => !v)}
                    disabled={advTriggerDisabled}
                    title="進階：單獨選份數跑擷取或批改"
                    aria-label="進階"
                    className={`inline-flex items-center rounded-r-lg border border-l-0 px-2 py-2 transition-colors active:scale-[0.98] ${
                      advTriggerDisabled
                        ? 'border-slate-300 bg-white text-slate-400 cursor-not-allowed active:scale-100'
                        : 'border-green-600 bg-green-600 text-white hover:border-green-700 hover:bg-green-700'
                    }`}
                  >
                    <ChevronDown className="w-4 h-4" />
                  </button>
                </div>
                {advancedMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-[105]" onClick={() => setAdvancedMenuOpen(false)} />
                    <div className="absolute right-0 top-full z-[106] mt-1 w-56 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
                      <div className="px-3 py-1.5 text-xs font-medium text-slate-400">進階（單獨選份數）</div>
                      <button
                        className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-50"
                        onClick={() => enterAdvanced('phase_a')}
                      >
                        <RefreshCw className="w-4 h-4 text-slate-400" />
                        重新截取答案
                      </button>
                      <button
                        className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-50"
                        onClick={() => enterAdvanced('phase_b')}
                      >
                        <Sparkles className="w-4 h-4 text-slate-400" />
                        重新批改作業
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* 2026-06-01 Phase3: 進階勾選模式底部確認列 */}
        {advancedMode !== null && (
          <div className="fixed inset-x-0 bottom-0 z-[110] border-t border-slate-200 bg-white/95 px-4 py-3 shadow-[0_-2px_12px_rgba(0,0,0,0.08)] backdrop-blur">
            <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={handleToggleSelectAll}
                disabled={isBusy || !inkSessionReady || submissions.size === 0}
              >
                <CheckSquare className="w-4 h-4" />
                {selectedSubmissionIds.size > 0 ? '取消全選' : '全選'}
              </Button>
              <span className="text-sm text-slate-600">
                {advancedMode === 'phase_a' ? '重新截取答案' : '重新批改作業'}
                {' · 已選 '}
                <strong className="text-slate-900">{selectedSubmissionCount}</strong>
                {' 份'}
              </span>
              <div className="ml-auto flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={exitAdvanced}>取消</Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={startAdvanced}
                  disabled={
                    selectedSubmissionCount === 0 ||
                    isGrading || isDownloading || isRefreshing || isCheckingCorrectionState ||
                    !isGeminiAvailable || !inkSessionReady || answerKeyStatus === 'deleted'
                  }
                >
                  {advancedMode === 'phase_a' ? <RefreshCw className="w-4 h-4" /> : <Sparkles className="w-4 h-4" />}
                  開始{advancedMode === 'phase_a' ? '重新截取答案' : '重新批改作業'}（{selectedSubmissionCount}）
                </Button>
              </div>
            </div>
          </div>
        )}

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
            mode={pipelineMode}
            stageProgress={pipelineStageProgress}
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
            onStudentConfirmed={async (entry) => {
              if (phaseAOnlyReviewModeRef.current) {
                // 2026-05-18 PR3: review-only mode、只存 final_answers、不接 Phase B
                console.log(`✅ 學生 ${entry.studentId} 確認完成（review only mode）、存 final_answers`)
                const finalAnswers: FinalAnswer[] = entry.phaseAResult.questionResults.map((qr) => {
                  return buildFinalAnswerForQR(qr, entry.decisions.get(qr.questionId))
                })
                // 2026-05-18: 同步把老師選的最終答案寫進 gradingResult.details[].studentAnswer、
                // detail modal 立刻能看到「學生答案：無法辨識 / 老師選的答案」、不要還顯示舊的 AI 讀取結果
                const finalAnswersByQid = new Map(finalAnswers.map((fa) => [fa.questionId, fa]))
                setSubmissions((prev) => {
                  const next = new Map(prev)
                  const cur = Array.from(prev.values()).find((s) => s.id === entry.submissionId)
                  if (cur) {
                    const existingDetails = (cur.gradingResult as { details?: Array<{ questionId: string; studentAnswer?: string }> } | undefined)?.details
                    const updatedDetails = Array.isArray(existingDetails)
                      ? existingDetails.map((d) => {
                          const fa = finalAnswersByQid.get(d.questionId)
                          return fa ? { ...d, studentAnswer: fa.finalStudentAnswer } : d
                        })
                      : existingDetails
                    const updatedGradingResult = updatedDetails
                      ? { ...(cur.gradingResult || {}), details: updatedDetails } as Submission['gradingResult']
                      : cur.gradingResult
                    next.set(cur.studentId, {
                      ...cur,
                      finalAnswers,
                      gradingResult: updatedGradingResult,
                      updatedAt: Date.now()
                    })
                  }
                  return next
                })
                // 寫 local Dexie（含更新後的 details）——2026-06-01 必須 await，
                // 否則 onAllDone→runOneClickPhaseB 從 Dexie 重讀時會 race、讀到舊值丟失複核答案。
                try {
                  const subFromDb = await db.submissions.get(entry.submissionId)
                  const existingDetails = (subFromDb?.gradingResult as { details?: Array<{ questionId: string; studentAnswer?: string }> } | undefined)?.details
                  const updatedDetails = Array.isArray(existingDetails)
                    ? existingDetails.map((d) => {
                        const fa = finalAnswersByQid.get(d.questionId)
                        return fa ? { ...d, studentAnswer: fa.finalStudentAnswer } : d
                      })
                    : existingDetails
                  const updatedGradingResult = updatedDetails && subFromDb?.gradingResult
                    ? { ...subFromDb.gradingResult, details: updatedDetails }
                    : subFromDb?.gradingResult
                  await db.submissions.update(entry.submissionId, {
                    finalAnswers,
                    gradingResult: updatedGradingResult as Submission['gradingResult'],
                    updatedAt: Date.now()
                  })
                } catch (err) { console.warn('Dexie update failed:', err) }
                // 寫 server（不接 Phase B）——也 await，確保複核答案落地、不被後續統一 Phase B 的重建覆蓋
                await fetch('/api/data/save-final-answers', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  credentials: 'include',
                  body: JSON.stringify({ submissions: [{ id: entry.submissionId, finalAnswers }] })
                }).catch((err) => console.warn('save-final-answers failed (non-fatal):', err))
                // 2026-06-20 省時（只限智慧批改一條龍、oneClickScopeRef 非空）：確認一份就立刻背景批那份
                //   （用剛存好的複核答案、entry.decisions），與後續複核時間重疊。加進已背景批清單→
                //   onAllDone 的 runOneClickPhaseB 會跳過、不重複批、結果視窗用 offset 補回總數。
                //   一般「重新截取」(非一鍵、oneClickScopeRef 空) 不觸發、維持 review-only 不自動批。
                if (oneClickScopeRef.current.length > 0) {
                  console.log(`✅ 學生 ${entry.studentId} 複核確認（一鍵）→ 立刻背景批 Phase B`)
                  oneClickBgGradedIdsRef.current.add(entry.submissionId)
                  // 共用 semaphore（與串流中的 read+arbiter / 乾淨卷 Phase B 同一個併發預算、防 504）
                  const semR = pipelineSemaphoreRef.current
                  const runR = () => executeBatchPhaseB([entry], true)
                  backgroundPhaseBPromises.current.push(
                    (semR ? semR.run(runR) : runR()).catch((err) => console.error('背景批複核卷失敗:', err))
                  )
                }
              } else {
                // 一條龍 legacy mode：背景接 Phase B
                console.log(`✅ 學生 ${entry.studentId} 確認完成，送 Accessor`)
                backgroundPhaseBPromises.current.push(
                  executeBatchPhaseB([entry], true).catch(err =>
                    console.error('Student Accessor failed:', err)
                  )
                )
              }
            }}
            onAllDone={() => {
              if (phaseAOnlyReviewModeRef.current) {
                const reviewedCount = batchPhaseAEntries.length
                phaseAOnlyReviewModeRef.current = false
                setBatchPhaseAEntries([])
                setGradingPhase('idle')
                setIsGrading(false)
                requestSync()  // 拉最新 final_answers
                if (oneClickScopeRef.current.length > 0) {
                  // 一鍵 1c：複核完 → 對全 scope 跑一次統一 Phase B（不顯示 Phase A notice、留給 Phase B 結果視窗）
                  console.log('✅ 全部審查完成（一鍵）→ 對全 scope 跑統一 Phase B')
                  phaseAStashRef.current = null
                  void runOneClickPhaseB()
                } else {
                  console.log('✅ 全部審查完成（review only mode）、回卡片列表、不接 Phase B')
                  // 用 stash 包 Phase A 完成 notice
                  const stash = phaseAStashRef.current
                  if (stash) {
                    setPhaseAResultNotice({
                      stopped: false,
                      successCount: stash.successCount,
                      failCount: stash.failCount,
                      needsReviewedCount: reviewedCount,
                      totalCount: stash.totalCount,
                      failReasons: stash.failReasons,
                      failedCandidates: stash.failedCandidates,
                    })
                    phaseAStashRef.current = null
                  }
                }
              } else {
                console.log('✅ 全部審查完成，等待背景 Accessor')
                setPhaseBTotalCount(batchPhaseAEntries.length)
                setGradingPhase('phase_b_running')
                setGradingMessage('AI 批改評分中…')
                setIsGrading(true)
              }
            }}
            phaseBScoredCount={phaseBScoredCount}
            phaseBTotalCount={phaseBTotalCount}
            streamingDone={reviewStreamingDone}
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
                  {groupClassroom.name} ({groupStudents.filter((s) => {
                    const sub = submissions.get(s.id)
                    return sub?.status === 'graded' && !isPhaseAStale(sub, correctionStatusByStudent[s.id])
                  }).length}/{groupStudents.length} 批改)
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                  {groupStudents.map((student) => {
                    const submission = submissions.get(student.id)
                    const rawStatus = submission?.status ?? 'missing'
                    // 2026-05-28: Phase A 重跑後、視為 pending（不顯示舊 score 跟 graded 綠邊）
                    const isStale = isPhaseAStale(submission, correctionStatusByStudent[student.id])
                    const status = (rawStatus === 'graded' && isStale) ? 'pending_grading' : rawStatus
                    const sourceVisual = getSubmissionSourceVisual(submission)
                    const gradingResult = submission?.gradingResult
                    const isUnscoredAssignment = assignment?.scoringMode === 'unscored'
                    const maxScore = gradingResult ? getSubmissionMaxScore(gradingResult) : null
                    // 2026-05-25: gradingResult 是 local-first 欄位、Phase A 完成但 Phase B 結果
                    // 還沒 sync 回來時 totalScore 會是 undefined。此時 fallback 用 server-owned
                    // submission.score（sync 直接覆寫、永遠 reliable）。修「Phase B 跑完但卡片仍顯 0 分」。
                    const totalScoreFromGr = Number(gradingResult?.totalScore)
                    const scoreFromSub = Number(submission?.score)
                    const scoreValue = Number.isFinite(totalScoreFromGr)
                      ? totalScoreFromGr
                      : (Number.isFinite(scoreFromSub) ? scoreFromSub : 0)
                    const correctSummary = gradingResult ? getSubmissionCorrectSummary(gradingResult) : null
                    const isLowScore = isUnscoredAssignment
                      ? (correctSummary ? correctSummary.ratio < 0.8 : true)
                      : (typeof maxScore === 'number' && maxScore > 0 ? scoreValue < maxScore * 0.8 : scoreValue < 60)
                    // 2026-06-19: 跨班卡片狀態徽章改用與單班相同的 deriveCardStage（補回待批改/已上傳/已掃描等）
                    const cardStage = deriveCardStage(submission, correctionStatusByStudent[student.id])
                    const needsReview = cardStage === 'pending_review'
                    const pendingGrading = cardStage === 'pending_grading'
                    const showResultBadge = cardStage === 'graded'
                    const isSelected = selectedSubmissionIds.has(submission?.id ?? '')
                    const isStub = isManualGradeStub(submission)
                    return (
                      <div
                        key={student.id}
                        className="relative"
                        // 2026-05-28: scroll perf — 同 flat 模式、批改模式跨班顯示時 100+ 卡片更需要
                        style={{ contentVisibility: 'auto', containIntrinsicSize: '160px 240px' }}
                      >
                        {/* 勾選框：與單班一致、只在進階模式出現 */}
                        {advancedMode !== null && submission && hasSubmissionImage(submission) && (
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
                          <div className="relative aspect-[4/3] bg-gray-100">
                            <SubmissionThumbnail submission={submission} />
                            {/* 狀態徽章：與單班卡片完全一致（deriveCardStage 分支） */}
                            {isStub && (
                              <div className="absolute top-2 right-2 px-2 py-1 bg-emerald-500 text-white rounded-full text-xs font-semibold">已批改</div>
                            )}
                            {showResultBadge && !isStub && (
                              <div className={`absolute top-2 right-2 px-2 py-1 rounded-full text-xs font-bold ${!isLowScore ? 'bg-green-500 text-white' : 'bg-red-500 text-white'}`}>
                                {isUnscoredAssignment && correctSummary ? `${correctSummary.correct}/${correctSummary.total}` : `${scoreValue} 分`}
                              </div>
                            )}
                            {needsReview && (
                              <div className="absolute top-2 right-2 px-2 py-1 rounded-full text-xs font-bold bg-amber-100 text-amber-700 border border-amber-200">待複核</div>
                            )}
                            {pendingGrading && (
                              <div className="absolute top-2 right-2 px-2 py-1 rounded-full text-xs font-bold bg-blue-100 text-blue-700 border border-blue-200">待批改</div>
                            )}
                            {cardStage === 'phase_a_failed' && (
                              <div className="absolute top-2 right-2 px-2 py-1 bg-red-500 text-white rounded-full text-xs font-semibold">擷取失敗</div>
                            )}
                            {cardStage === 'phase_b_failed' && (
                              <div className="absolute top-2 right-2 px-2 py-1 bg-red-500 text-white rounded-full text-xs font-semibold">批改失敗</div>
                            )}
                            {status === 'scanned' && (
                              <div className="absolute top-2 right-2 px-2 py-1 bg-blue-500 text-white rounded-full text-xs font-semibold">已掃描</div>
                            )}
                            {cardStage === 'not_extracted' && status === 'synced' && (
                              <div className="absolute top-2 right-2 px-2 py-1 bg-purple-500 text-white rounded-full text-xs font-semibold">已上傳</div>
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
            // 2026-05-25: 同上方邏輯。local gradingResult 是 local-first、可能 Phase A 完成
            // 但 totalScore 未更新；fallback 用 server-owned submission.score 避免假裝 0 分。
            const totalScoreFromGr = Number(gradingResult?.totalScore)
            const scoreFromSub = Number(submission?.score)
            const scoreValue = Number.isFinite(totalScoreFromGr)
              ? totalScoreFromGr
              : (Number.isFinite(scoreFromSub) ? scoreFromSub : 0)
            const correctSummary = gradingResult ? getSubmissionCorrectSummary(gradingResult) : null
            const isLowScore = isUnscoredAssignment
              ? (correctSummary ? correctSummary.ratio < 0.8 : true)
              : (
                  typeof maxScore === 'number' && maxScore > 0
                    ? scoreValue < maxScore * 0.8
                    : scoreValue < 60
                )
            const isStub = isManualGradeStub(submission)
            // 2026-05-18: 卡片 badge 改用 deriveCardStage 統一決定、不再用零散 hasGradingResult / showResultBadge 邏輯
            // 避免舊資料 totalScore=0 還顯示「0 分」、Phase A 完成卻看不到「待批改」狀態
            const cardStage = deriveCardStage(submission, submission ? correctionStatusByStudent[submission.studentId] : undefined)
            const showResultBadge = cardStage === 'graded'
            const needsReview = cardStage === 'pending_review'
            const pendingGrading = cardStage === 'pending_grading'
            const resultBadgeText = isUnscoredAssignment
              ? (correctSummary ? `${correctSummary.correct}/${correctSummary.total}` : '')
              : `${scoreValue} 分`

            return (
              <div
                key={student.id}
                className="bg-white rounded-xl hover:border-slate-300 border border-slate-200 cursor-pointer group flex flex-col"
                // 2026-05-28: scroll perf — content-visibility: auto 拔掉、
                // Performance trace 顯示 60% time 在 compositor pipeline (提交/分層/預先繪製)
                // CV: auto 每張卡進出 viewport 都 layerize、scroll churn 嚴重
                // 改回普通 render、靠下面拔掉的 shadow/opacity 屬性減少 layer 數
                onClick={() => {
                  if (!submission || isStub) return
                  setSelectedSubmission({ submission, student })
                }}
              >
                <div className="relative">
                  <div className="aspect-[4/3] bg-gray-100 rounded-t-xl overflow-hidden flex items-center justify-center relative">
                    <SubmissionThumbnail submission={submission} />
                    {/* 2026-05-28 perf: 拔掉 badge 的 shadow、box-shadow 是 compositor layer 大戶
                        28 卡 × 每張 1 個 badge × shadow = 至少 28 個 layer */}
                    {isStub && (
                      <div className="absolute top-2 right-2 px-2 py-1 bg-emerald-500 text-white rounded-full text-xs font-semibold">
                        已批改
                      </div>
                    )}
                    {/* 2026-05-18: badge 統一用 deriveCardStage 結果分支 */}
                    {showResultBadge && (
                      <div className="absolute top-2 right-2 flex flex-col items-end gap-1">
                        <div
                          className={`px-2 py-1 rounded-full text-xs font-bold ${
                            !isLowScore ? 'bg-green-500 text-white' : 'bg-red-500 text-white'
                          }`}
                        >
                          {resultBadgeText}
                        </div>
                      </div>
                    )}
                    {needsReview && (
                      <div className="absolute top-2 right-2 px-2 py-1 rounded-full text-xs font-bold bg-amber-100 text-amber-700 border border-amber-200">
                        待複核
                      </div>
                    )}
                    {pendingGrading && (
                      <div className="absolute top-2 right-2 px-2 py-1 rounded-full text-xs font-bold bg-blue-100 text-blue-700 border border-blue-200">
                        待批改
                      </div>
                    )}
                    {cardStage === 'phase_a_failed' && (
                      <div
                        className="absolute top-2 right-2 px-2 py-1 bg-red-500 text-white rounded-full text-xs font-semibold"
                        title="擷取失敗、可重新截取答案"
                      >
                        擷取失敗
                      </div>
                    )}
                    {cardStage === 'phase_b_failed' && (
                      <div
                        className="absolute top-2 right-2 px-2 py-1 bg-red-500 text-white rounded-full text-xs font-semibold"
                        title="批改失敗、可重新批改"
                      >
                        批改失敗
                      </div>
                    )}
                    {status === 'scanned' && (
                      <div className="absolute top-2 right-2 px-2 py-1 bg-blue-500 text-white rounded-full text-xs font-semibold">
                        已掃描
                      </div>
                    )}
                    {cardStage === 'not_extracted' && status === 'synced' && (
                      <div className="absolute top-2 right-2 px-2 py-1 bg-purple-500 text-white rounded-full text-xs font-semibold">
                        已上傳
                      </div>
                    )}

                    {(status === 'graded' || status === 'synced' || status === 'scanned' || status === 'grading_failed') &&
                      submission && (
                        <>
                          {/* 2026-06-01 Phase3: 勾選框只在進階模式出現 */}
                          {advancedMode !== null && (
                            <div
                              className="absolute top-2 left-2 z-10 flex items-center justify-center rounded-md border border-slate-200 bg-white p-1.5"
                              onClick={(e) => e.stopPropagation()}
                              title="勾選加入這批"
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
                          )}
                          {/* 2026-05-28 perf: hidden→flex 不會 promote layer、opacity 會、
                              28 張卡 × 每張 opacity transition = 28 個 compositor layer */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              void handleDeleteSubmission(submission, student)
                            }}
                            className="absolute bottom-2 left-2 p-1.5 bg-white text-gray-700 rounded-full hidden group-hover:flex hover:bg-red-50 hover:text-red-600 z-10 disabled:opacity-50 disabled:cursor-not-allowed"
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
                    <div className="flex items-center justify-between mt-1">
                      <p className="text-xs font-medium text-emerald-600">已完成批改</p>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); void handleRevertManualGradeStudent(student) }}
                        disabled={Boolean(revertingManualGradeStudentId)}
                        className="text-[10px] font-medium text-rose-600 hover:text-rose-700 hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {revertingManualGradeStudentId === student.id ? '處理中…' : '撤銷標記'}
                      </button>
                    </div>
                  )}
                  {(() => {
                    const cs = correctionStatusByStudent[student.id]
                    if (cs === 'correction_required') return <p className="text-xs font-medium text-amber-600 mt-1">待訂正</p>
                    if (cs === 'correction_in_progress') return <p className="text-xs font-medium text-blue-600 mt-1">訂正中</p>
                    // 2026-05-28: 改回「申訴待審」跟 CorrectionManagement / CorrectionHistory 一致
                    // 之前誤翻成「待複查」跟「待複核」(AI 批改 review) 名稱混淆
                    if (cs === 'correction_pending_review') return <p className="text-xs font-medium text-violet-600 mt-1">申訴待審</p>
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

        {/* 底部前往訂正：模仿匯入頁右下「前往批改」按鈕 */}
        {onNavigateToCorrection && (
          <div className="mt-6 bg-white border-t border-slate-200 px-4 py-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4 text-sm">
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-full bg-green-500 inline-block" />
                  <span className="text-slate-600">
                    已批改{' '}
                    <span className="font-semibold text-green-600">
                      {stageAggregates.counts.graded}
                    </span>
                  </span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-full bg-slate-300 inline-block" />
                  <span className="text-slate-600">
                    未批改{' '}
                    <span className="font-semibold text-slate-700">
                      {Math.max(students.length - stageAggregates.counts.graded, 0)}
                    </span>
                  </span>
                </span>
              </div>
              {stageAggregates.counts.graded > 0 && (
                <button
                  type="button"
                  onClick={() => onNavigateToCorrection?.()}
                  className="px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-xl hover:bg-green-700 transition-colors"
                >
                  前往訂正
                </button>
              )}
            </div>
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
                  {/* 2026-06-01: 移除「待複核」導航——待複核不再是狀態，複核一律走智慧批改流程 */}
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
                {/* 2026-06-01: 移除「需要複核」橫幅——待複核不再是一種概念/狀態。
                    要複核的卷顯示為未擷取、走智慧批改流程處理。 */}

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
                        // 2026-05-18: Phase A only 完成（status !== 'graded'）→ 顯示「未批改」
                        // 不管 score/maxScore 是不是 0、只要狀態還沒到 graded、就算未批改
                        // 涵蓋舊資料 score=0/maxScore=0 跟新資料 score=undefined 兩種情況
                        // 2026-05-28: Phase A 重跑後（stale）也視為未批改、舊 score/reason 對不到新讀答案
                        const isNotGradedYet = selectedSubmission.submission.status !== 'graded'
                          || isPhaseAStale(selectedSubmission.submission, correctionStatusByStudent[selectedSubmission.submission.studentId])
                        // 2026-05-18: 學生答案是「無法辨識」→ 卡片底色標紅、老師一眼看到要再複核哪一題
                        const isUnrecognizable = String(d.studentAnswer || '').trim() === '無法辨識'
                        // 2026-05-28: map_fill 已 pivot 到 Phase A 3-AI、studentAnswer 是老師確認後的逗號分隔地名、
                        // 不再需要鎖編輯欄（老師可微調個別字、之後 deterministic match 再算分）
                        const isVisualEval = false
                        // 2026-05-30: VJ 視覺判斷題 — 學生答案改逐柱「有畫/沒畫」、不給文字框
                        const vjItems: Array<{ idx: number; label: string; verdict: string; reason: string }> =
                          Array.isArray(d.vjItemResults) ? d.vjItemResults : []
                        const isVJ = vjItems.length > 0

                        return (
                          <div
                            key={questionId}
                            className={`border rounded-lg p-3 text-xs space-y-2 ${
                              isUnrecognizable
                                ? 'border-rose-300 bg-rose-50'  // 紅底紅框、強烈視覺提示
                                : 'border-gray-200 bg-gray-50'
                            }`}
                          >
                            <div className="flex justify-between items-center gap-2">
                              <div className="flex items-center gap-2">
                                <span className="font-semibold text-gray-800">
                                  題目 {questionId}
                                </span>
                              </div>
                              <div
                                className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                                  isNotGradedYet
                                    ? 'bg-slate-100 text-slate-600'
                                    : isCorrect
                                      ? 'bg-green-100 text-green-700'
                                      : isPartial
                                        ? 'bg-amber-100 text-amber-700'
                                        : 'bg-red-100 text-red-700'
                                }`}
                              >
                                {isNotGradedYet ? (
                                  <span>未批改</span>
                                ) : (
                                  <span>{isCorrect ? '✓' : isPartial ? '△' : '✗'}</span>
                                )}
                                {!isUnscored && !isNotGradedYet && (
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
                            {/* 2026-05-18 PR3: 學生答案 inline edit、debounce 1s auto save、textarea 自動撐高 */}
                            {/* 2026-05-30: VJ 視覺判斷題 → 逐柱「有畫/沒畫」開關（不給文字框）；其他題型維持文字編輯 */}
                            {isVJ ? (
                              <div className="space-y-1.5">
                                <div className="flex items-center gap-2 text-gray-700">
                                  <span className="shrink-0">學生答案：</span>
                                  <span className="font-semibold text-gray-900">{String(d.studentAnswer || '圖上作答')}</span>
                                  <span className="text-[10px] text-gray-400">（視覺判斷題 — 逐項確認有沒有畫）</span>
                                </div>
                                {/* 2026-05-30: 不放 crop 小圖 — detail 已有整張全圖、且只有進審查的題才有 crop（不一致）。看圖用左側全圖。 */}
                                <div className="space-y-1">
                                  {vjItems.map((it) => {
                                    const isBlank = it.verdict === 'blank'
                                    return (
                                      <div key={it.idx} className="flex items-center justify-between gap-2 bg-white border border-gray-200 rounded px-2 py-1">
                                        <span className="text-gray-700 truncate">{it.label || `項目 ${it.idx}`}</span>
                                        <div className="flex shrink-0 rounded-md overflow-hidden border border-gray-300">
                                          <button
                                            type="button"
                                            disabled={isBusy || isSavingScore}
                                            onClick={() => { if (isBlank) void handleDetailVjBlankToggle(i, it.idx, false) }}
                                            className={`px-2 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-50 ${!isBlank ? 'bg-emerald-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}
                                          >
                                            有畫
                                          </button>
                                          <button
                                            type="button"
                                            disabled={isBusy || isSavingScore}
                                            onClick={() => { if (!isBlank) void handleDetailVjBlankToggle(i, it.idx, true) }}
                                            className={`px-2 py-0.5 text-[11px] font-medium border-l border-gray-300 transition-colors disabled:opacity-50 ${isBlank ? 'bg-rose-500 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}
                                          >
                                            沒畫
                                          </button>
                                        </div>
                                      </div>
                                    )
                                  })}
                                </div>
                                <p className="text-[10px] text-gray-400">改了會退回待批改、按【批改作業】重新判分。</p>
                              </div>
                            ) : (
                            <div className="flex items-start gap-2 text-gray-700">
                              <span className="shrink-0 mt-0.5">學生答案：</span>
                              <textarea
                                className={`flex-1 px-2 py-1 rounded border bg-white text-gray-900 text-xs focus:outline-none focus:ring-2 focus:ring-blue-300 disabled:bg-gray-50 disabled:cursor-not-allowed resize-none whitespace-pre-wrap break-words ${
                                  isVisualEval
                                    ? 'border-gray-200 italic text-gray-500'
                                    : isUnrecognizable ? 'border-rose-300' : 'border-gray-200 hover:border-gray-300'
                                }`}
                                value={isVisualEval ? '採視覺評分' : String(d.studentAnswer ?? '')}
                                placeholder={isVisualEval ? undefined : '（點此編輯）'}
                                disabled={isVisualEval || isBusy || isSavingScore}
                                onChange={(e) => {
                                  if (isVisualEval) return
                                  handleDetailStudentAnswerChange(i, e.target.value)
                                  // 即時撐高、不等下次 re-render
                                  e.target.style.height = 'auto'
                                  e.target.style.height = e.target.scrollHeight + 'px'
                                }}
                                onFocus={(e) => { if (!isVisualEval) e.target.select() }}
                                // mount/re-render 時依內容撐高、避免 1 行 textarea 蓋掉多行內容
                                ref={(el) => {
                                  if (el) {
                                    el.style.height = 'auto'
                                    el.style.height = el.scrollHeight + 'px'
                                  }
                                }}
                                rows={1}
                                title={isVisualEval
                                  ? '填圖題由 AI 直接看 crop 圖視覺評分、學生筆跡跟標準答案的比對請看下方「理由」欄'
                                  : '編輯後 1 秒自動儲存。已批改卷子改答案會自動退回待批改、按【批改作業】重評。'}
                              />
                            </div>
                            )}

                            <div className="text-xs text-gray-700 flex items-start gap-2">
                              <span className="mt-0.5 shrink-0">理由：</span>
                              <span className="text-gray-600 whitespace-pre-line flex-1">
                                {/* 2026-05-28: 未批改（含 Phase A stale）→ 不顯示舊 reason */}
                                {isNotGradedYet ? '—' : (d.reason || '—')}
                              </span>
                            </div>

                            {/* table_cell 群組批改：顯示每 cell 對錯細節 */}
                            {/* 2026-05-28: 未批改（含 Phase A stale）→ 隱藏舊 cell 對錯 */}
                            {!isNotGradedYet && Array.isArray(d.cellResults) && d.cellResults.length > 0 && (
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

                            {/* fill_blank 合題：顯示每空對錯細節 */}
                            {/* 2026-05-28: 未批改（含 Phase A stale）→ 隱藏舊 part 對錯 */}
                            {!isNotGradedYet && Array.isArray(d.partResults) && d.partResults.length > 0 && (
                              <div className="mt-2 border-t border-gray-200 pt-2">
                                <div className="text-[11px] font-semibold text-gray-600 mb-1.5">每空對錯：</div>
                                <div className="space-y-1">
                                  {d.partResults.map((pr: any, pi: number) => (
                                    <div
                                      key={`${pr.subId}-${pi}`}
                                      className={`flex items-center gap-2 px-2 py-1 rounded text-[11px] ${
                                        pr.correct
                                          ? 'bg-green-50 border border-green-100'
                                          : 'bg-red-50 border border-red-100'
                                      }`}
                                    >
                                      <span className="shrink-0 font-semibold w-4 text-center">
                                        {pr.correct ? '✓' : '✗'}
                                      </span>
                                      <span className="shrink-0 text-gray-500 min-w-[2rem]">
                                        ({pr.subId})
                                      </span>
                                      <span className="shrink-0 text-gray-700">
                                        學生：<span className="font-medium">{pr.student || '（空）'}</span>
                                      </span>
                                      {!pr.correct && (
                                        <>
                                          <span className="shrink-0 text-gray-400">→</span>
                                          <span className="shrink-0 text-gray-700">
                                            正解：<span className="font-medium text-green-700">{pr.expected}</span>
                                          </span>
                                          {pr.reason && (
                                            <span className="shrink-0 text-red-600 ml-auto truncate">
                                              {pr.reason}
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
