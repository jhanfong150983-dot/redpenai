
import { useState, useEffect, useCallback, useMemo, useRef, type MouseEvent as ReactMouseEvent } from 'react'
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
  Eye,
  ChevronRight,
  ChevronLeft,
  ZoomIn
} from 'lucide-react'
import { db, type Assignment, type Student, type Submission, type Classroom } from '@/lib/db'
import { requestSync, waitForSync } from '@/lib/sync-events'
import {
  gradePhaseA,
  gradePhaseB,
  isGeminiAvailable,
  type PhaseAResult,
  type PhaseAQuestionResult,
  type FinalAnswer
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
  '批改中... 你可以先滑個手機 📱',
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

const LOW_CONFIDENCE_THRESHOLD = 90

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
    console.log('🔄 開始 atob 解碼...')
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
  phase: 'phase_a_running' | 'phase_b_running' | 'report_running'
  phaseAProgress: { current: number; total: number }
  phaseBProgress: { current: number; total: number }
  phaseANeedsReviewCount: number
  gradingMessage: string
  stopRequested: boolean
  onStop: () => void
}

function GradingPipelineOverlay({
  phase,
  phaseAProgress,
  phaseBProgress,
  phaseANeedsReviewCount,
  gradingMessage,
  stopRequested,
  onStop,
}: GradingPipelineOverlayProps) {
  const isPhaseA = phase === 'phase_a_running'
  const isReport = phase === 'report_running'
  const isAfterPhaseA = !isPhaseA

  const stageA: PipelineStageStatus = isPhaseA ? 'active' : 'done'
  const stageReview: PipelineStageStatus = isAfterPhaseA ? 'done' : 'pending'
  const stageB: PipelineStageStatus = isAfterPhaseA ? (isReport ? 'done' : 'active') : 'pending'
  const stageReport: PipelineStageStatus = isReport ? 'active' : 'pending'

  const aLabel = isPhaseA
    ? `${phaseAProgress.current}/${phaseAProgress.total}`
    : `${phaseAProgress.total}/${phaseAProgress.total}`
  const bLabel = !isAfterPhaseA
    ? `0/${phaseBProgress.total}`
    : isReport
      ? `${phaseBProgress.total}/${phaseBProgress.total}`
      : `${phaseBProgress.current}/${phaseBProgress.total}`

  const reviewLabel = phaseANeedsReviewCount > 0
    ? `需審查 ${phaseANeedsReviewCount} 份`
    : isPhaseA ? '統計中...' : '已確認'

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
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '1rem', fontWeight: 700, color: '#111827' }}>AI 批改進行中</div>
          <div style={{ fontSize: '0.8rem', color: '#6b7280', marginTop: '0.25rem' }}>{gradingMessage}</div>
        </div>

        {/* Pipeline stages */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'center', width: '100%', padding: '0 0.25rem', gap: '0.75rem' }}>
          <PipelineStage index={1} label="擷取學生答案" sublabel={aLabel} status={stageA} />
          <PipelineStage index={2} label="教師人工審查" sublabel={reviewLabel} status={stageReview} />
          <PipelineStage index={3} label="AI批改評分" sublabel={bLabel} status={stageB} />
          <PipelineStage index={4} label="生成作業報告" sublabel={isReport ? '生成中...' : '等待中'} status={stageReport} />
        </div>

        {/* 人工審查提醒（Phase A 執行中且已有需審查題目） */}
        {isPhaseA && phaseANeedsReviewCount > 0 && (
          <div style={{
            background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: '0.75rem',
            padding: '0.6rem 1rem', textAlign: 'center', width: '100%',
          }}>
            <div style={{ fontSize: '0.8rem', fontWeight: 600, color: '#92400e' }}>
              ⚠️ 已發現 {phaseANeedsReviewCount} 份需要人工審查
            </div>
            <div style={{ fontSize: '0.72rem', color: '#b45309', marginTop: '0.2rem' }}>
              擷取完成後請回來確認答案，再開始 AI 批改
            </div>
          </div>
        )}

        {/* Stop button（報告生成中不提供停止，批改已完成） */}
        <button
          onClick={onStop}
          disabled={stopRequested || isReport}
          style={{
            padding: '0.5rem 1.75rem', borderRadius: '0.75rem', border: 'none',
            cursor: stopRequested ? 'not-allowed' : 'pointer',
            background: stopRequested ? '#e5e7eb' : '#fee2e2',
            color: stopRequested ? '#9ca3af' : '#dc2626',
            fontWeight: 600, fontSize: '0.875rem',
            transition: 'background 0.2s',
          }}
        >
          {stopRequested ? '正在停止...' : '停止批改'}
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

  const getAnswerText = (r: { status: string; studentAnswer: string }): string | null => {
    if (r.status !== 'read') return null
    if (isCalcType) {
      const final = extractFinalAnswer(r.studentAnswer)
      if (final) return final
    }
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
      parts.push(<span key="extra" className="text-gray-400 text-[9px] ml-1">（對方多 {otherText.length - text.length} 字）</span>)
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
          className={`flex flex-col gap-0.5 rounded-lg border-2 px-3 py-2.5 text-left text-xs transition-all disabled:cursor-not-allowed ${
            decision?.source === 'ai_read1'
              ? 'border-purple-500 bg-purple-50 shadow-sm'
              : 'border-gray-200 bg-white hover:border-purple-300 hover:bg-purple-50/40'
          }`}
        >
          <span className={`font-semibold text-[11px] ${decision?.source === 'ai_read1' ? 'text-purple-700' : 'text-gray-500'}`}>{isCalcType ? 'AI 讀取 1（最終答案）' : 'AI 細節讀取（裁切圖）'}</span>
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
          className={`flex flex-col gap-0.5 rounded-lg border-2 px-3 py-2.5 text-left text-xs transition-all disabled:cursor-not-allowed ${
            decision?.source === 'ai_read2'
              ? 'border-purple-500 bg-purple-50 shadow-sm'
              : 'border-gray-200 bg-white hover:border-purple-300 hover:bg-purple-50/40'
          }`}
        >
          <span className={`font-semibold text-[11px] ${decision?.source === 'ai_read2' ? 'text-purple-700' : 'text-gray-500'}`}>{isCalcType ? 'AI 讀取 2（最終答案）' : 'AI 全局讀取（全圖）'}</span>
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
          className={`flex items-center justify-center rounded-lg border-2 px-3 py-2.5 text-xs font-semibold transition-all disabled:cursor-not-allowed ${
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
          className={`flex items-center justify-center rounded-lg border-2 px-3 py-2.5 text-xs font-semibold transition-all disabled:cursor-not-allowed ${
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
            className={`w-full rounded-lg border-2 px-3 py-2.5 text-left text-xs font-semibold transition-all disabled:cursor-not-allowed ${
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
              placeholder={isCalcType ? '輸入最終答案（不需要寫算式）' : '輸入答案...'}
              className="mt-1.5 w-full rounded-lg border border-blue-300 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:opacity-50 resize-y"
              autoFocus
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
  onStartPhaseB,
  isPhaseBRunning = false,
}: {
  entries: BatchPhaseAEntry[]
  allStudents: Student[]
  onDecision: (studentId: string, questionId: string, update: Partial<ConsistencyDecision>) => void
  onStartPhaseB: () => void
  isPhaseBRunning?: boolean
}) {
  // Helper: determine if a question needs human review
  // New architecture: use arbiterResult.arbiterStatus; fall back to consistencyStatus for old data
  const isNeedsReview = (q: PhaseAQuestionResult) => {
    if (q.arbiterResult) return q.arbiterResult.arbiterStatus === 'needs_review'
    return q.consistencyStatus !== 'stable'  // legacy fallback
  }

  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set(
    // Auto-expand students who have review questions
    entries
      .filter(e => e.phaseAResult.questionResults.some(q => isNeedsReview(q)))
      .map(e => e.studentId)
  ))

  const toggleExpand = (studentId: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(studentId)) next.delete(studentId)
      else next.add(studentId)
      return next
    })
  }

  const allStableEntries = entries.filter(e =>
    e.phaseAResult.questionResults.every(q => !isNeedsReview(q))
  )
  const needsReviewEntries = entries.filter(e =>
    e.phaseAResult.questionResults.some(q => isNeedsReview(q))
  )
  // Sort: unstable first, then diff
  const sortedNeedsReview = [...needsReviewEntries].sort((a, b) => {
    const aHasUnstable = a.phaseAResult.questionResults.some(q => q.consistencyStatus === 'unstable')
    const bHasUnstable = b.phaseAResult.questionResults.some(q => q.consistencyStatus === 'unstable')
    if (aHasUnstable && !bHasUnstable) return -1
    if (!aHasUnstable && bHasUnstable) return 1
    return 0
  })

  // A student is confirmed when all their needs_review questions are decided
  const confirmedStudentCount = entries.filter(e => {
    const reviewQs = e.phaseAResult.questionResults.filter(q => isNeedsReview(q))
    return reviewQs.every(q => e.decisions.get(q.questionId)?.confirmed)
  }).length
  const allConfirmed = confirmedStudentCount >= entries.length

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-bold text-gray-900 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-orange-500" />
            一致性審查
          </h2>
          <p className="text-xs text-gray-500 mt-0.5">確認所有學生的答案後，才能開始正式批改</p>
        </div>
        <span className={`text-sm font-semibold px-3 py-1.5 rounded-full ${
          allConfirmed ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'
        }`}>
          已確認 {confirmedStudentCount}/{entries.length} 位學生
        </span>
      </div>

      {/* All-stable students */}
      {allStableEntries.length > 0 && (
        <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-2.5 text-sm text-green-700 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0 text-green-500" />
          <span>
            <strong>{allStableEntries.length} 位</strong>同學答案完全一致，已自動確認
          </span>
        </div>
      )}

      {/* Students needing review */}
      {sortedNeedsReview.length > 0 && (
        <div className="space-y-2">
          {sortedNeedsReview.map(entry => {
            const student = allStudents.find(s => s.id === entry.studentId)
            const reviewQs = entry.phaseAResult.questionResults.filter(q => isNeedsReview(q))
            const confirmedCount = reviewQs.filter(q => entry.decisions.get(q.questionId)?.confirmed).length
            const hasUnstable = reviewQs.some(q => q.consistencyStatus === 'unstable')
            const isExpanded = expandedIds.has(entry.studentId)
            const isFullyConfirmed = confirmedCount >= reviewQs.length

            return (
              <div
                key={entry.studentId}
                className={`rounded-lg border ${
                  isFullyConfirmed
                    ? 'border-green-200 bg-green-50'
                    : hasUnstable
                    ? 'border-red-200 bg-red-50'
                    : 'border-orange-200 bg-orange-50'
                }`}
              >
                {/* Student header row */}
                <button
                  onClick={() => toggleExpand(entry.studentId)}
                  disabled={isPhaseBRunning}
                  className="w-full flex items-center justify-between px-4 py-2.5 text-left disabled:cursor-not-allowed"
                >
                  <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                    <span className={`inline-flex min-w-[24px] items-center justify-center rounded-md border px-1.5 py-0.5 text-xs font-semibold ${
                      hasUnstable ? 'border-red-200 bg-red-100 text-red-700' : 'border-orange-200 bg-orange-100 text-orange-700'
                    }`}>
                      {student?.seatNumber ?? '?'}
                    </span>
                    {student?.name ?? entry.studentId}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                      isFullyConfirmed
                        ? 'bg-green-200 text-green-800'
                        : 'bg-white/60 text-gray-600'
                    }`}>
                      {isFullyConfirmed ? '已確認' : `${confirmedCount}/${reviewQs.length} 題`}
                    </span>
                    <ChevronRight className={`w-4 h-4 text-gray-400 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                  </div>
                </button>

                {/* Question cards */}
                {isExpanded && (
                  <div className="px-4 pb-3 space-y-2">
                    {reviewQs.map(q => (
                      <ConsistencyQuestionCard
                        key={q.questionId}
                        studentId={entry.studentId}
                        questionResult={q}
                        decision={entry.decisions.get(q.questionId)}
                        onDecision={(qId, update) => onDecision(entry.studentId, qId, update)}
                        disabled={isPhaseBRunning}
                      />
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Start Phase B button */}
      <button
        onClick={onStartPhaseB}
        disabled={!allConfirmed || isPhaseBRunning}
        className="w-full py-3 rounded-xl bg-purple-600 text-white font-bold text-sm hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
      >
        <Sparkles className="w-4 h-4" />
        {isPhaseBRunning
          ? `正式批改中...（${entries.length} 位學生）`
          : allConfirmed
          ? `開始正式批改（${entries.length} 位學生）`
          : `尚有 ${entries.length - confirmedStudentCount} 位學生未確認`}
      </button>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

export default function GradingPage({
  assignmentId,
  onBack,
  onRequireInkTopUp,
  onGradingPhaseChange,
  embedded = false
}: GradingPageProps) {
  const PREVIEW_LENS_SIZE = 140
  const PREVIEW_ZOOM_SCALE = 2.3
  const PREVIEW_ZOOM_PANEL_SIZE = 250

  const [assignment, setAssignment] = useState<Assignment | null>(null)
  const [classroom, setClassroom] = useState<Classroom | null>(null)
  const [students, setStudents] = useState<Student[]>([])
  const [submissions, setSubmissions] = useState<Map<string, Submission>>(new Map())
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isGrading, setIsGrading] = useState(false)
  const [isDownloading, setIsDownloading] = useState(false)
  const [isCheckingCorrectionState, setIsCheckingCorrectionState] = useState(false)
  const [gradingProgress, setGradingProgress] = useState({ current: 0, total: 0 })
  const [downloadProgress, setDownloadProgress] = useState({ current: 0, total: 0 })
  const [error, setError] = useState<string | null>(null)
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [inkSessionReady, setInkSessionReady] = useState(false)
  const [inkSessionError, setInkSessionError] = useState<string | null>(null)
  const [isClosingSession, setIsClosingSession] = useState(false)

  const inkSessionStartRef = useRef<string | null>(null)
  const hasClosedSessionRef = useRef(false)
  const skipInkSessionCleanupRef = useRef(import.meta.env.DEV)
  const correctionStatusByStudentIdRef = useRef<Map<string, string>>(new Map())
  const correctionStatusFetchedAtRef = useRef(0)

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
  const [gradeResultNotice, setGradeResultNotice] = useState<GradeResultNotice | null>(null)
  const manualGradedKey = `manual_graded_${assignmentId}`
  const [manuallyGradedStudentIds, setManuallyGradedStudentIds] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(manualGradedKey)
      return stored ? new Set<string>(JSON.parse(stored) as string[]) : new Set<string>()
    } catch { return new Set<string>() }
  })
  const [manualGradingStudentId, setManualGradingStudentId] = useState<string | null>(null)

  // 🆕 進度詳情
  const [_currentGradingStudent, setCurrentGradingStudent] = useState<string>('')
  const [_gradingStartTime, setGradingStartTime] = useState<number>(0)
  const [_completedReviewCount, setCompletedReviewCount] = useState(0)
  const [gradingMessage, setGradingMessage] = useState<string>('AI 批改中...')
  const [_nowTs, setNowTs] = useState(() => Date.now())

  // Phase A/B 批次一致性審查
  const [gradingPhase, setGradingPhase] = useState<GradingPhase>('idle')
  const [batchPhaseAEntries, setBatchPhaseAEntries] = useState<BatchPhaseAEntry[]>([])
  const [phaseANeedsReviewCount, setPhaseANeedsReviewCount] = useState(0)
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
  const gradeActionLabel =
    selectedSubmissionCount > 0 ? `批次批改 (${selectedSubmissionCount})` : '全部批改'
  
  // 🆕 計算待複核數量
  const needsReviewCount = useMemo(() => {
    return Array.from(submissions.values()).filter(s => s.gradingResult?.needsReview).length
  }, [submissions])

  // 🆕 獲取所有待複核的學生（按座號排序）
  const needsReviewStudents = useMemo(() => {
    return students
      .filter(student => {
        const sub = submissions.get(student.id)
        return sub?.gradingResult?.needsReview
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
  const executeBatchPhaseB = useCallback(async (entriesToProcess?: BatchPhaseAEntry[]) => {
    const entries = entriesToProcess ?? batchPhaseAEntries
    if (entries.length === 0) return

    setGradingPhase('phase_b_running')
    setGradingMessage('Step 2/2：正在批改...')
    setIsGrading(true)
    setGradingStartTime(Date.now())
    setGradingProgress({ current: 0, total: entries.length })
    setCompletedReviewCount(0)

    let successCount = 0
    let failCount = 0
    let completedB = 0
    const failReasons: string[] = []
    const failedEntries: BatchPhaseAEntry[] = []

    await runWithConcurrency(
      entries,
      7,
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
        const gradingResult = await gradePhaseB(entry.imageBlob, entry.phaseAResult, finalAnswers, assignment?.domain)
        return { entry, gradingResult }
      },
      async (_i, result, err) => {
        completedB++
        setGradingProgress({ current: completedB, total: entries.length })
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

        await db.submissions.update(entry.submissionId, {
          status: 'graded',
          score: totalScore,
          aiScore: totalScore,
          scoreSource: 'ai',
          gradingResult,
          gradedAt: Date.now(),
          updatedAt: Date.now(),
        })
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
      setGradingMessage('品質檢測中...')
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
          const gradingResult = await gradePhaseB(entry.imageBlob, entry.phaseAResult, finalAnswers, assignment?.domain)
          const totalScore = typeof gradingResult.totalScore === 'number' ? gradingResult.totalScore : 0
          await db.submissions.update(entry.submissionId, {
            status: 'graded', score: totalScore, aiScore: totalScore, scoreSource: 'ai',
            gradingResult, gradedAt: Date.now(), updatedAt: Date.now(),
          })
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

    // 同步等待作業報告生成
    if (successCount > 0 && !stopRequestedRef.current) {
      setGradingPhase('report_running')
      setGradingMessage('正在生成作業學情報告...')
      try {
        await fetch('/api/data/refresh-assignment-summary', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ assignmentId })
        })
      } catch {
        // 報告生成失敗不影響批改結果，靜默處理
      }
    }

    // 合併品質檢查失敗到結果摘要
    const qualityFails = postRetryWarnings
    const qualityFailReasons = qualityFails.map((f) => `${f.studentLabel}：${f.unreadCount} 題無法讀取，建議重新批改`)
    const qualityFailedEntries = qualityFails.map((f) => batchPhaseAEntries.find((e) => e.submissionId === f.submissionId)).filter(Boolean) as BatchPhaseAEntry[]
    const totalEntries = entries.length + qualityFails.length

    setBatchPhaseAEntries([])
    setGradingPhase('idle')
    setIsGrading(false)
    setCurrentGradingStudent('')
    setSelectedSubmissionIds(new Set())
    setPostRetryWarnings([])
    setGradeResultNotice({
      stopped: stopRequestedRef.current,
      successCount,
      failCount: failCount + qualityFails.length,
      totalCount: totalEntries,
      failReasons: [...failReasons, ...qualityFailReasons],
      failedEntries: [...failedEntries, ...qualityFailedEntries],
    })
    setStopRequested(false)
    stopRequestedRef.current = false
    setGradingProgress({ current: 0, total: 0 })
  }, [batchPhaseAEntries, students])

  // ─── 自動跳過審查：若所有學生的所有題目都 stable，直接進 Phase B ──────────
  useEffect(() => {
    if (gradingPhase !== 'awaiting_review') return
    if (batchPhaseAEntries.length === 0) return
    const allStable = batchPhaseAEntries.every(e =>
      e.phaseAResult.questionResults.every(q =>
        q.arbiterResult ? q.arbiterResult.arbiterStatus !== 'needs_review' : q.consistencyStatus === 'stable'
      )
    )
    if (allStable) {
      console.log('✅ 所有題目一致性穩定，自動跳過審查直接進入正式批改')
      void executeBatchPhaseB()
    }
  }, [gradingPhase, batchPhaseAEntries, executeBatchPhaseB])

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
    window.location.href = '/?page=ink-topup'
  }, [onRequireInkTopUp])

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
    return nextMap
  }, [assignmentId])

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
      setCorrectionGuardModal({
        title,
        description,
        blockedStudents
      })
    },
    []
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
      const assignmentData = await db.assignments.get(assignmentId)
      if (!assignmentData) throw new Error('找不到作業')
      setAssignment(assignmentData)

      const classroomData = await db.classrooms.get(assignmentData.classroomId)
      if (!classroomData) throw new Error('找不到班級')
      setClassroom(classroomData)

      const studentsData = await db.students
        .where('classroomId')
        .equals(assignmentData.classroomId)
        .sortBy('seatNumber')
      setStudents(studentsData)

      const submissionsData = await db.submissions.where('assignmentId').equals(assignmentId).toArray()
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

      // 背景預取縮圖（給雲端同步但本地無縮圖的作業，下次 render 就能立即顯示）
      const needsThumbnail = submissionsData.filter(
        (s) => s.source !== 'student_correction' && s.id && !s.thumbnailBlob && !s.thumbnailBase64
      )
      if (needsThumbnail.length > 0) {
        void (async () => {
          const CONCURRENCY = 3
          for (let i = 0; i < needsThumbnail.length; i += CONCURRENCY) {
            const batch = needsThumbnail.slice(i, i + CONCURRENCY)
            await Promise.all(batch.map(async (sub) => {
              try {
                const params = new URLSearchParams({ submissionId: sub.id, thumb: 'true' })
                const resp = await fetch(buildApiUrl(`/api/storage/download?${params.toString()}`), { credentials: 'include' })
                if (!resp.ok) return
                const blob = await resp.blob()
                if (blob.size === 0) return
                if (avoidBlobStorage) {
                  const base64 = await blobToBase64(blob)
                  await db.submissions.update(sub.id, { thumbnailBase64: base64 })
                  setSubmissions((prev) => {
                    const next = new Map(prev)
                    const existing = next.get(sub.studentId)
                    if (existing) next.set(sub.studentId, { ...existing, thumbnailBase64: base64 })
                    return next
                  })
                } else {
                  await db.submissions.update(sub.id, { thumbnailBlob: blob })
                  setSubmissions((prev) => {
                    const next = new Map(prev)
                    const existing = next.get(sub.studentId)
                    if (existing) next.set(sub.studentId, { ...existing, thumbnailBlob: blob })
                    return next
                  })
                }
              } catch {
                // 縮圖預取失敗，不影響主流程
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
  }, [assignmentId, fetchCorrectionStatusByStudentId])

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
                  : false
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
      setManuallyGradedStudentIds((prev) => {
        const next = new Set([...prev, student.id])
        try { localStorage.setItem(manualGradedKey, JSON.stringify([...next])) } catch { /* ignore */ }
        return next
      })
      void syncAndReload()
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

  const hasSubmissionImage = (submission: Submission) =>
    Boolean(submission.imageBase64) ||
    (submission.imageBlob?.size ?? 0) > 0 ||
    Boolean(submission.imageUrl)

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

  const handleGradeAll = async () => {
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

    const canProceed = await ensureNoCorrectionConflict(candidates)
    if (!canProceed) {
      return
    }

    const regrade = candidates.some((s) => s.status === 'graded')

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
        setCurrentGradingStudent('準備圖片中...')

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
      setGradingMessage('Step 1/2：正在讀取學生答案...')
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

      // ── Batch Phase A（並行 N=5，錯開 300ms）─────────────────────────────
      const entries: BatchPhaseAEntry[] = []
      let completedA = 0

      await runWithConcurrency(
        toGrade,
        5,
        300,
        async (sub) => {
          if (stopRequestedRef.current) return null
          console.log(`📄 [PhaseA] student=${sub.studentId} pageBreaks=${JSON.stringify(sub.pageBreaks ?? [])}`)
          const phaseAResult = await gradePhaseA(
            sub.imageBlob!,
            assignment.answerKey!,
            sub.pageBreaks,
            assignment.domain,
            assignment.id
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
          const student = students.find((s) => s.id === sub.studentId)
          if (student) setCurrentGradingStudent(`${student.seatNumber}號 ${student.name}`)
          // 即時統計需審查題數
          const submissionNeedsReview = phaseAResult.questionResults.some(
            (qr) => qr.arbiterResult ? qr.arbiterResult.arbiterStatus === 'needs_review' : qr.consistencyStatus !== 'stable'
          )
          if (submissionNeedsReview) setPhaseANeedsReviewCount((prev) => prev + 1)
          const decisions = new Map<string, ConsistencyDecision>()
          for (const qr of phaseAResult.questionResults) {
            const arbiter = qr.arbiterResult
            if (arbiter && arbiter.arbiterStatus !== 'needs_review') {
              // 3-AI arch: auto-confirm arbitrated questions
              const source =
                arbiter.arbiterStatus === 'arbitrated_pick_1' ? 'ai_read1'
                : arbiter.arbiterStatus === 'arbitrated_pick_2' ? 'ai_read2'
                : 'ai_arbiter'  // arbitrated_agree
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

        // 答案類型分類（三種，邊界明確）
        type AnswerType = 'numeric' | 'chinese_text' | 'blank'
        const classifyAnswerType = (status: string, answer: string): AnswerType => {
          if (status === 'blank' || status === 'unreadable' || !answer.trim()) return 'blank'
          if (/\d/.test(answer)) return 'numeric'
          return 'chinese_text'
        }

        const anomalousIndices = new Set<number>()
        // 收集每份被標記作業的詳細原因，結束後 POST 到後端
        const flagDetails = new Map<number, {
          conditions: string[]
          consecutiveBlankMax?: number
          typeMismatchCount?: number
          typeMismatchDetails?: Array<{ questionId: string; expected: string; got: string }>
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

        // 條件二：fill_blank 答案類型主流不符（含 blank 視為類型之一）
        // 三種類型：numeric（含數字）、chinese_text（純漢字）、blank
        // 每題需 ≥60% 同意才確立主流；任一題不符即觸發重跑
        if (entries.length >= MIN_SUBMISSIONS_FOR_TYPE) {
          // 第一輪：統計每題各類型的數量
          const typeCountsByQuestion = new Map<string, Record<AnswerType, number>>()
          for (const entry of entries) {
            for (const qr of entry.phaseAResult.questionResults) {
              if (qr.questionType !== 'fill_blank') continue
              const t = classifyAnswerType(qr.readAnswer1?.status ?? '', qr.readAnswer1?.studentAnswer ?? '')
              if (!typeCountsByQuestion.has(qr.questionId)) {
                typeCountsByQuestion.set(qr.questionId, { numeric: 0, chinese_text: 0, blank: 0 })
              }
              typeCountsByQuestion.get(qr.questionId)![t]++
            }
          }

          // 確立每題的主流類型（≥60% 才算）
          const dominantTypeByQuestion = new Map<string, AnswerType>()
          for (const [qId, counts] of typeCountsByQuestion) {
            const total = counts.numeric + counts.chinese_text + counts.blank
            if (total < MIN_SUBMISSIONS_FOR_TYPE) continue
            for (const t of ['numeric', 'chinese_text', 'blank'] as AnswerType[]) {
              if (counts[t] / total >= DOMINANT_TYPE_RATIO) {
                dominantTypeByQuestion.set(qId, t)
                break
              }
            }
          }

          // 第二輪：找出任一 fill_blank 題類型不符的作業
          for (let i = 0; i < entries.length; i++) {
            if (anomalousIndices.has(i)) continue
            const mismatchDetails: Array<{ questionId: string; expected: string; got: string }> = []
            for (const qr of entries[i].phaseAResult.questionResults) {
              if (qr.questionType !== 'fill_blank') continue
              const dominant = dominantTypeByQuestion.get(qr.questionId)
              if (!dominant) continue  // 該題未確立主流，跳過
              const got = classifyAnswerType(qr.readAnswer1?.status ?? '', qr.readAnswer1?.studentAnswer ?? '')
              if (got !== dominant) {
                mismatchDetails.push({ questionId: qr.questionId, expected: dominant, got })
              }
            }
            if (mismatchDetails.length >= 1) {
              anomalousIndices.add(i)
              const f = getFlag(i)
              f.conditions.push('answer_type_mismatch')
              f.typeMismatchCount = mismatchDetails.length
              f.typeMismatchDetails = mismatchDetails
            }
          }
        }

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

        // 條件四：fill_blank 鄰題答案交叉比對（bbox 偏移檢測）
        // 如果學生某題的答案 ≠ 該題標準答案，但 = 隔壁 fill_blank 的標準答案 → bbox 可能偏移
        if (assignment?.answerKey?.questions) {
          const akQuestions = assignment.answerKey.questions
          // 建立 fill_blank 題目的有序清單（按 questionId）和標準答案 map
          const fillBlankIds = akQuestions
            .filter((q) => q.questionCategory === 'fill_blank' && q.answer)
            .map((q) => q.id)
            .sort()
          const refAnswerById = new Map(
            akQuestions
              .filter((q) => q.questionCategory === 'fill_blank' && q.answer)
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
              if (qr.questionType !== 'fill_blank') continue
              const stuAns = qr.readAnswer1?.studentAnswer ?? ''
              if (!stuAns || qr.readAnswer1?.status !== 'read') continue
              const ref = refAnswerById.get(qr.questionId)
              if (!ref) continue
              // 如果答對了（含等值），不檢查
              if (numEq(stuAns, ref)) continue

              // 找相鄰的 fill_blank
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
              typeMismatchCount: detail.typeMismatchCount,
              typeMismatchDetails: detail.typeMismatchDetails,
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
          setGradingMessage('品質檢測中...')
          const indicesToRetry = Array.from(anomalousIndices)
          await runWithConcurrency(
            indicesToRetry,
            5,
            300,
            async (idx) => {
              if (stopRequestedRef.current) return null
              const entry = entries[idx]
              const sub = toGrade.find((s) => s.id === entry.submissionId)
              if (!sub?.imageBlob) return null
              // 組裝 classify 修正提示（各品質檢查條件 → 對應的提醒類型）
              const flag = flagDetails.get(idx)
              const corrections: Array<{ questionId: string; type: 'neighbor_match' | 'consecutive_blank' | 'type_mismatch'; neighborId?: string }> = []
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
                // answer_type_mismatch → type_mismatch
                if (flag.typeMismatchDetails) {
                  for (const m of flag.typeMismatchDetails) {
                    corrections.push({ questionId: m.questionId, type: 'type_mismatch' })
                  }
                }
              }
              const phaseAResult = await gradePhaseA(sub.imageBlob, assignment.answerKey!, sub.pageBreaks, assignment.domain, assignment.id, corrections)
              return { idx, phaseAResult }
            },
            (_i, result, err) => {
              if (!result) { if (err) console.error('[QualityCheck] retry failed:', err); return }
              const { idx, phaseAResult } = result
              const decisions = new Map<string, ConsistencyDecision>()
              for (const qr of phaseAResult.questionResults) {
                const arbiter = qr.arbiterResult
                if (arbiter && arbiter.arbiterStatus !== 'needs_review') {
                  const source = arbiter.arbiterStatus === 'arbitrated_pick_1' ? 'ai_read1' : arbiter.arbiterStatus === 'arbitrated_pick_2' ? 'ai_read2' : 'ai_arbiter'
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

        // 從批次中移除品質失敗的 submissions（它們會在 Phase B 結果中顯示為失敗）
        const qualityFailIds = new Set(phaseAQualityFails.map((f) => f.submissionId))
        const validEntries = qualityFailIds.size > 0
          ? entries.filter((e) => !qualityFailIds.has(e.submissionId))
          : entries
        setBatchPhaseAEntries(validEntries)
        setGradingPhase('awaiting_review')
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
              consistencyStatus: qr.consistencyStatus ?? null,
              forensicMode: arbiter?.forensicMode ?? null,
              agreementSupport: arbiter?.agreementSupport ?? null,
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

  const getSubmissionConfidenceAverage = (result?: Submission['gradingResult']) => {
    if (!result?.details || !Array.isArray(result.details)) return null

    const values = result.details
      .map((detail: any) => {
        const value = Number(detail?.confidence)
        return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null
      })
      .filter((value: number | null): value is number => value !== null)

    if (values.length === 0) return null
    return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
  }

  const getSubmissionMinConfidenceInfo = (result?: Submission['gradingResult']) => {
    if (!result?.details || !Array.isArray(result.details)) return null

    let minValue: number | null = null
    let minQuestionId: string | null = null

    result.details.forEach((detail: any, index: number) => {
      const rawValue = Number(detail?.confidence)
      if (!Number.isFinite(rawValue)) return
      const value = Math.min(100, Math.max(0, rawValue))

      if (minValue === null || value < minValue) {
        minValue = value
        minQuestionId = detail?.questionId ?? `#${index + 1}`
      }
    })

    if (minValue === null) return null
    return { value: Math.round(minValue), questionId: minQuestionId }
  }

  const getDisplayReviewReasons = useCallback(
    (submission: Submission) => {
      const reasons = submission.gradingResult?.reviewReasons ?? []
      if (reasons.length > 0) {
        const parsed = reasons
          .map((reason) => toUserFriendlyReviewReason(reason))
          .map((reason) => reason.trim())
          .filter((reason) => reason.length > 0)
        return Array.from(new Set(parsed))
      }

      const derived = new Set<string>()
      const details = submission.gradingResult?.details ?? []

      if (details.some((detail: any) => Number(detail?.confidence) < 80)) {
        derived.add('信心偏低')
      }
      if (details.some((detail: any) => detail?.studentAnswer === 'AI無法辨識')) {
        derived.add('有題目無法辨識')
      }
      return Array.from(derived)
    },
    []
  )

  const formatQuestionId = (questionId?: string | null) => {
    return formatDisplayQuestionId(questionId)
  }

  // 錯誤類型 -> 標籤
  const classifyMistakeToTag = (reason: string): string => {
  const text = (reason || '').toLowerCase().trim()
  const rules: Array<{ label: string; keywords: string[] }> = [
    { label: '未作答', keywords: ['未作答', '未填寫'] },
    { label: '未依題目指示', keywords: ['未依題目指示', '未依題目要求'] },
    { label: '題目看不懂', keywords: ['審題不清', '未依題意', '未根據題意', '未能根據'] },
    { label: '答案不完整', keywords: ['答案不完整', '不完整', '未寫出', '空白'] },
    { label: '用字錯誤', keywords: ['用字錯誤'] },
    { label: '計算失誤', keywords: ['計算', '算錯', '算式', '符號'] },
    { label: '圖表失誤', keywords: ['圖表', '圖形', '表格', '圖示'] },
    {
      label: '概念不清',
      keywords: ['概念', '概念不清', '不夠精確', '不清楚', '不夠清楚', '弄反', '未能辨識', '無法辨識', '未能正確辨識', '不理解', '錯誤理解', '不熟悉', '不夠熟悉', '未能精準', '不夠精準', '混淆', '搞混', '不準確', '不精確', '判斷錯誤', '誤認為', '未能正確識別', '認知錯誤', '無法正確']
    },
    { label: '答案錯誤', keywords: ['標準答案為', '正確答案為', '誤選', '誤答', '誤把', '誤將', '答錯', '判錯', '誤判', '誤認', '誤寫', '誤以'] }
  ]

  for (const rule of rules) {
    if (rule.keywords.some((k) => text.includes(k.toLowerCase()))) return rule.label
  }
  return '其他'
}


  const getFeedbackTags = (submission: Submission) => {
    const mistakes = submission.gradingResult?.mistakes
    if (mistakes && mistakes.length > 0) {
      const tags = new Set<string>()
      mistakes.forEach((m) => tags.add(classifyMistakeToTag(m.reason)))
      return Array.from(tags)
    }

    if (typeof submission.feedback === 'string') {
      return submission.feedback.split('; ').filter((s) => s.trim() !== '')
    }
    if (Array.isArray(submission.feedback)) return submission.feedback
    return []
  }

  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>()
    submissions.forEach((sub) => {
      if (sub.status !== 'graded') return
      const tags = getFeedbackTags(sub)
      tags.forEach((t) => {
        counts.set(t, (counts.get(t) ?? 0) + 1)
      })
    })
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])
  }, [submissions])

  const sortedStudents = useMemo(() => {
    return [...students].sort((a, b) => a.seatNumber - b.seatNumber)
  }, [students])

  const selectedReviewReasons = selectedSubmission
    ? getDisplayReviewReasons(selectedSubmission.submission)
    : []
  const selectedMinConfidence = selectedSubmission?.submission.gradingResult
    ? getSubmissionMinConfidenceInfo(selectedSubmission.submission.gradingResult)
    : null
  const selectedConfidenceAverage = selectedSubmission?.submission.gradingResult
    ? getSubmissionConfidenceAverage(selectedSubmission.submission.gradingResult)
    : null
  const selectedConfidenceLabel =
    selectedMinConfidence && selectedMinConfidence.value < LOW_CONFIDENCE_THRESHOLD
      ? `最低信心 ${selectedMinConfidence.value}%${
          selectedMinConfidence.questionId
            ? `（第${formatQuestionId(selectedMinConfidence.questionId)}題）`
            : ''
        }`
      : typeof selectedConfidenceAverage === 'number' &&
          selectedConfidenceAverage < LOW_CONFIDENCE_THRESHOLD
        ? `平均信心 ${selectedConfidenceAverage}%`
        : null

  if (isLoading) {
    return (
      <div className={`${embedded ? 'min-h-[280px]' : 'min-h-screen'} bg-white flex items-center justify-center`}>
        <div className="text-center">
          <Loader className="w-12 h-12 text-purple-600 mx-auto mb-4 animate-spin" />
          <p className="text-gray-600">載入中...</p>
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
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
          <div className="bg-white rounded-xl border border-slate-200 p-8 flex flex-col items-center gap-4">
            <Loader className="w-10 h-10 text-blue-500 animate-spin" />
            <div className="text-center">
              <p className="text-lg font-semibold text-gray-800">AI 使用計算中...</p>
              <p className="text-sm text-gray-500 mt-1">正在結算本次批改費用，請稍候</p>
            </div>
          </div>
        </div>
      )}

      {isCheckingCorrectionState && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center">
          <div className="bg-white rounded-xl border border-slate-200 p-6 w-full max-w-sm mx-4">
            <div className="flex items-center gap-3">
              <Loader className="w-6 h-6 text-sky-600 animate-spin" />
              <div>
                <p className="text-base font-semibold text-gray-900">檢查訂正狀態中...</p>
                <p className="text-sm text-gray-500">避免誤覆蓋學生端訂正內容</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {correctionGuardModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
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

            <div className="flex justify-end">
              <button
                onClick={() => setCorrectionGuardModal(null)}
                className="px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-700 transition-colors"
              >
                知道了
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 🆕 確認對話框 */}
      {showGradeConfirm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
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
                className="flex-1 px-4 py-3 bg-gradient-to-r from-purple-600 to-pink-600 text-white rounded-xl hover:from-purple-700 hover:to-pink-700 transition-all font-medium"
              >
                開始批改
              </button>
            </div>
          </div>
        </div>
      )}

      {gradeResultNotice && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
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
            <h1 className="text-2xl font-semibold text-gray-900">{assignment?.title}</h1>
            <p className="mt-1 text-sm text-gray-600">
              {classroom?.name} · {students.length} 位學生
            </p>
          </div>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {/* 🆕 待複核按鈕 */}
            {needsReviewCount > 0 && (
              <button
                onClick={jumpToNextReview}
                className="inline-flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-700 hover:bg-amber-100"
              >
                <Eye className="w-5 h-5" />
                待複核 {needsReviewCount}
              </button>
            )}
            <button
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <RefreshCw className={`w-5 h-5 ${isRefreshing ? 'animate-spin' : ''}`} />
              重新整理
            </button>
            <button
              onClick={handleToggleSelectAll}
              disabled={isBusy || !inkSessionReady || submissions.size === 0}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <CheckSquare className="w-5 h-5" />
              {selectedSubmissionIds.size > 0 ? '取消全選' : '全選'}
            </button>
            <button
              onClick={handleGradeAll}
              disabled={
                isGrading ||
                isDownloading ||
                isRefreshing ||
                isCheckingCorrectionState ||
                !isGeminiAvailable ||
                !inkSessionReady
              }
              className="inline-flex items-center gap-2 rounded-lg border border-green-600 bg-green-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isCheckingCorrectionState ? (
                <Loader className="w-5 h-5 animate-spin" />
              ) : (
                <Sparkles className="w-5 h-5" />
              )}
              {isCheckingCorrectionState ? '檢查訂正狀態...' : gradeActionLabel}
            </button>
          </div>
        </div>

        {isRefreshing && !isBusy && (
          <div className="sticky top-4 z-40 mb-4">
            <div className="bg-sky-50 border border-sky-200 rounded-xl px-4 py-2.5 flex items-center gap-3">
              <RefreshCw className="w-4 h-4 text-sky-500 animate-spin shrink-0" />
              <p className="text-sm text-sky-700 font-medium">正在同步最新資料，請稍候...</p>
            </div>
          </div>
        )}

        {/* Grading pipeline overlay (下載圖片、Phase A、Phase B、生成報告 統一顯示遮罩) */}
        {(isDownloading || gradingPhase === 'phase_a_running' || gradingPhase === 'phase_b_running' || gradingPhase === 'report_running') && (
          <GradingPipelineOverlay
            phase={
              gradingPhase === 'phase_b_running' ? 'phase_b_running'
              : gradingPhase === 'report_running' ? 'report_running'
              : 'phase_a_running'
            }
            phaseAProgress={
              isDownloading
                ? downloadProgress
                : gradingPhase === 'phase_a_running'
                  ? gradingProgress
                  : { current: gradingProgress.total, total: gradingProgress.total }
            }
            phaseBProgress={
              gradingPhase === 'phase_b_running'
                ? gradingProgress
                : gradingPhase === 'report_running'
                  ? { current: batchPhaseAEntries.length, total: batchPhaseAEntries.length }
                  : { current: 0, total: batchPhaseAEntries.length }
            }
            phaseANeedsReviewCount={phaseANeedsReviewCount}
            gradingMessage={isDownloading ? '正在下載學生作業圖片...' : gradingMessage}
            stopRequested={stopRequested}
            onStop={handleStopGrading}
          />
        )}

        {!inkSessionReady && (
          <div className="mb-4 bg-amber-50 border border-amber-200 text-amber-700 rounded-xl px-4 py-3 text-sm">
            正在建立批改會話，請稍候...
          </div>
        )}

        {gradingPhase === 'awaiting_review' && batchPhaseAEntries.length > 0 && (
          <BatchConsistencyReviewSection
            entries={batchPhaseAEntries}
            allStudents={students}
            onDecision={handleBatchDecision}
            onStartPhaseB={() => { void executeBatchPhaseB() }}
            isPhaseBRunning={false}
          />
        )}

        {/* 標籤篩選 */}
        {tagCounts.length > 0 && (
          <div className="mb-4 rounded-xl border border-slate-200 bg-white p-4 flex flex-wrap items-center gap-2">
            <span className="text-sm text-gray-600 mr-2">依標籤篩選：</span>
            {tagCounts.map(([tag, count]) => {
              const active = activeTag === tag
              return (
                <button
                  key={tag}
                  onClick={() => setActiveTag(active ? null : tag)}
                  className={`px-3 py-1 rounded-full text-sm border transition-colors ${
                    active
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-gray-50 text-gray-700 border-gray-200 hover:bg-gray-100'
                  }`}
                >
                  {tag} · {count}
                </button>
              )
            })}
            {activeTag && (
              <button
                onClick={() => setActiveTag(null)}
                className="ml-auto text-sm text-blue-600 hover:underline"
              >
                清除篩選
              </button>
            )}
          </div>
        )}

        {/* Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {sortedStudents.map((student) => {
            const submission = submissions.get(student.id)
            const status = submission?.status ?? 'missing'
            const sourceVisual = getSubmissionSourceVisual(submission)
            const tags = submission ? getFeedbackTags(submission) : []
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
            const showResultBadge =
              hasGradingResult && (status === 'graded' || status === 'synced')
            const needsReview = showResultBadge && !!gradingResult?.needsReview
            const resultBadgeText = isUnscoredAssignment
              ? (correctSummary ? `${correctSummary.correct}/${correctSummary.total}` : '')
              : `${scoreValue} 分`
            const minConfidence = needsReview && gradingResult
              ? getSubmissionMinConfidenceInfo(gradingResult)
              : null
            const confidenceAverage = needsReview && gradingResult
              ? getSubmissionConfidenceAverage(gradingResult)
              : null
            const confidenceHint = needsReview
              ? minConfidence
                ? minConfidence.value < LOW_CONFIDENCE_THRESHOLD
                  ? `最低信心 ${minConfidence.value}%`
                  : null
                : typeof confidenceAverage === 'number'
                  ? confidenceAverage < LOW_CONFIDENCE_THRESHOLD
                    ? `平均信心 ${confidenceAverage}%`
                    : null
                  : null
              : null

            if (activeTag && !tags.includes(activeTag)) {
              return null
            }

            return (
              <div
                key={student.id}
                className="bg-white rounded-xl hover:border-slate-300 border border-slate-200 transition-all cursor-pointer group flex flex-col"
                onClick={() => {
                  if (!submission) return
                  setSelectedSubmission({ submission, student })
                }}
              >
                <div className="relative">
                  <div className="aspect-[4/3] bg-gray-100 rounded-t-xl overflow-hidden flex items-center justify-center relative">
                    <SubmissionThumbnail submission={submission} />
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

                    {(status === 'graded' || status === 'synced' || status === 'scanned') &&
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
                      {sourceVisual.label}
                    </p>
                  )}
                  {status === 'graded' && tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {tags.slice(0, 2).map((tag, index) => (
                        <span
                          key={index}
                          className="px-2 py-0.5 bg-purple-100 text-purple-700 rounded text-xs"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                  {status === 'missing' && !manuallyGradedStudentIds.has(student.id) && (
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
                  {manuallyGradedStudentIds.has(student.id) && (
                    <p className="text-xs font-medium text-emerald-600 mt-1">已完成批改</p>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {/* Stats */}
        <div className="mt-6 bg-white rounded-xl border border-slate-200 p-6">
          <h3 className="font-semibold text-gray-900 mb-4">統計資訊</h3>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <div className="text-center">
              <p className="text-2xl font-bold text-gray-900">
                {Array.from(submissions.values()).filter((s) => s.status === 'graded').length}
              </p>
              <p className="text-sm text-gray-600">已批改</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-blue-600">
                {Array.from(submissions.values()).filter(
                  (s) => s.status === 'scanned' || s.status === 'synced'
                ).length}
              </p>
              <p className="text-sm text-gray-600">待批改</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-gray-400">{students.length - submissions.size}</p>
              <p className="text-sm text-gray-600">尚未繳交</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-green-600">
                {submissions.size > 0
                  ? Math.round(
                      (Array.from(submissions.values()).filter((s) => s.status === 'graded').length /
                        submissions.size) *
                        100
                    )
                  : 0}
                %
              </p>
              <p className="text-sm text-gray-600">批改完成率</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-rose-600">
                {Array.from(submissions.values()).filter((s) => s.gradingResult?.needsReview).length}
              </p>
              <p className="text-sm text-rose-600 font-semibold">需複核</p>
            </div>
          </div>
        </div>
      </div>
      {/* Modal */}
      {selectedSubmission && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
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
                      <div className="pointer-events-none fixed z-[60] rounded-xl border border-blue-200 bg-white/95 p-2 shadow-2xl" style={{ left: panelLeft, top: panelTop }}>
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
                {selectedSubmission.submission.gradingResult?.needsReview && (
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
                            reviewReasons: []
                          }
                          const totalScore = typeof newGradingResult.totalScore === 'number' ? newGradingResult.totalScore : undefined
                          await db.submissions.update(id, {
                            gradingResult: newGradingResult,
                            ...(totalScore !== undefined ? { score: totalScore, aiScore: totalScore, scoreSource: 'ai' as const } : {}),
                            updatedAt: Date.now()
                          })
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
                        const confidenceValue = Number.isFinite(Number(d.confidence))
                          ? Math.min(100, Math.max(0, Number(d.confidence)))
                          : null
                        const showConfidence =
                          typeof confidenceValue === 'number' && confidenceValue < 100
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
                                {showConfidence && (
                                  <span
                                    className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                                      confidenceValue < 80
                                        ? 'bg-red-100 text-red-700 border border-red-200'
                                        : 'bg-amber-100 text-amber-700 border border-amber-200'
                                    }`}
                                  >
                                    信心 {confidenceValue}%
                                  </span>
                                )}
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
                    <div className="text-gray-400 text-sm text-center italic py-4">
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
