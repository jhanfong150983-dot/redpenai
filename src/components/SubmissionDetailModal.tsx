import { useState, useEffect, useCallback, useRef, type MouseEvent as ReactMouseEvent } from 'react'
import { FileQuestion, ImageIcon, RefreshCw, X } from 'lucide-react'
import { db, type Submission, type Student, type Assignment, type FinalAnswerCached as FinalAnswer } from '@/lib/db'
import { getSubmissionImageUrl } from '@/lib/utils'
import { buildApiUrl } from '@/lib/api-base'
import { requestSync } from '@/lib/sync-events'
import { isImageJudgedAnswer } from '@/lib/parentReport'

// 2026-08-01 改分入口收斂(user 拍板):批改頁的作業卡片 modal 抽成共用元件——
//   成績簿改唯讀、點分數開同一個 modal → 全系統只有一個地方能改分、一個地方顯示。
//   本檔是「純搬移」:JSX 與 handler 由 GradingPage 原樣移入、行為不變;
//   差別只在對 parent 的 state 更新統一改走 onUpdated(latestSubmission) callback。
const PREVIEW_LENS_SIZE = 140
const PREVIEW_ZOOM_SCALE = 2.3
const PREVIEW_ZOOM_PANEL_SIZE = 250

export type SubmissionDetailModalProps = {
  submission: Submission
  student: Student
  assignment?: Assignment
  classroomName?: string
  /** 批改進行中:鎖住改分/改答案(沿用 GradingPage 既有語意) */
  isBusy?: boolean
  /** Phase A 比 gradedAt 新=舊版批改紀錄。由 caller 用 isPhaseAStale 判好傳入(避免循環 import) */
  isStale?: boolean
  onClose: () => void
  /** 改分/改答案後回拋最新 submission,caller 自行更新列表狀態 */
  onUpdated: (sub: Submission) => void
}

export default function SubmissionDetailModal({
  submission: propSub,
  student,
  assignment,
  classroomName,
  isBusy = false,
  isStale = false,
  onClose,
  onUpdated,
}: SubmissionDetailModalProps) {
  const [editableDetails, setEditableDetails] = useState<any[]>([])
  const [isSavingScore, setIsSavingScore] = useState(false)
  const [previewLensActive, setPreviewLensActive] = useState(false)
  const [previewLensState, setPreviewLensState] = useState({
    x: 0, y: 0, lensLeft: 0, lensTop: 0, width: 0, height: 0, clientX: 0, clientY: 0
  })
  const handleCloseModal = onClose

  useEffect(() => {
    if (propSub?.gradingResult?.details) {
      const details = propSub.gradingResult.details
      if (Array.isArray(details)) {
        console.log('[grading] details with confidence:', details)
        // VJ 逐柱重建用：finalAnswers 的 vjBlankConfirmed + 答案卷 vjRubric.itemLabels
        // （detail 自帶 vjItemResults 優先；舊資料沒帶就從這兩個重建、不用重跑 Phase A）
        const faByQid = new Map(
          ((propSub.finalAnswers as any[]) || []).map((fa: any) => [fa.questionId, fa])
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
              // 2026-07-13 系統信心（內部值、<70 題目列紅底）
              systemConfidence:
                typeof d.systemConfidence === 'number' && Number.isFinite(d.systemConfidence)
                  ? d.systemConfidence
                  : undefined,
              // 2026-07-13 老師接管編輯：AI 原判快照（有=顯示回復鈕、紅底熄滅）
              _aiOriginal: d._aiOriginal ?? undefined,
            }
          })
        )
      } else {
        setEditableDetails([])
      }
    } else {
      setEditableDetails([])
    }
  }, [propSub, assignment])

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


  const studentAnswerSaveTimeoutsRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map())
  const snapshotAiOriginal = (d: any) => d._aiOriginal ?? {
    studentAnswer: d.studentAnswer ?? '',
    score: Number.isFinite(Number(d.score)) ? Number(d.score) : 0,
    maxScore: Number.isFinite(Number(d.maxScore)) ? Number(d.maxScore) : 0,
    isCorrect: d.isCorrect === true,
    reason: d.reason ?? '',
    comment: d.comment ?? '',
    systemConfidence: typeof d.systemConfidence === 'number' ? d.systemConfidence : undefined,
  }
  const handleDetailStudentAnswerChange = (index: number, newAnswer: string) => {
    // 即時更新 editableDetails（UI 立刻反映、含接管標記）
    setEditableDetails((prev) => prev.map((d, i) => (
      i === index ? { ...d, studentAnswer: newAnswer, reason: '已經由老師編輯', comment: '已經由老師編輯', _aiOriginal: snapshotAiOriginal(d) } : d
    )))

    // Debounce 1s 後 persist
    const prevTimeout = studentAnswerSaveTimeoutsRef.current.get(index)
    if (prevTimeout) clearTimeout(prevTimeout)
    const timeout = setTimeout(async () => {
      studentAnswerSaveTimeoutsRef.current.delete(index)
      const subId = propSub.id
      const submission = await db.submissions.get(subId)
      if (!submission) return
      const latestDetails = (submission.gradingResult as { details?: Array<Record<string, unknown>> } | undefined)?.details
      const updatedDetails = Array.isArray(latestDetails)
        ? latestDetails.map((d: any, i) => (
            i === index
              ? { ...d, studentAnswer: newAnswer, reason: '已經由老師編輯', comment: '已經由老師編輯', _aiOriginal: snapshotAiOriginal(d) }
              : d
          ))
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
      // 2026-07-13: 老師接管——改答案不再退回待批改、分數/狀態/gradedAt 全保留
      //   （舊行為「動答案就要重批」已由 user 拍板廢除：老師是最終權威、AI 不需重算）
      const updatedSubFields: Partial<Submission> = {
        gradingResult: newGradingResult,
        finalAnswers: newFinalAnswers,
        updatedAt: now
      }
      await db.submissions.update(subId, updatedSubFields)
      onUpdated({ ...propSub, ...updatedSubFields } as Submission)
      // 寫雲端：final_answers 寫進去（save-grading 也順便清 score、若卡片從 graded 退回）
      void fetch('/api/data/save-final-answers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ submissions: [{ id: subId, finalAnswers: newFinalAnswers }] })
      }).catch((err) => console.warn('save-final-answers failed (non-fatal):', err))
      // 2026-07-13: gradingResult（理由=已經由老師編輯＋_aiOriginal 快照）也要寫回雲端、分數欄位原樣帶回
      if (submission.status === 'graded') {
        void fetch('/api/data/save-grading', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            submissions: [{
              id: subId,
              score: submission.score ?? null,
              aiScore: submission.aiScore ?? null,
              scoreSource: submission.scoreSource ?? null,
              gradedAt: submission.gradedAt ?? null,
              gradingResult: newGradingResult
            }],
            fromManualScoreEdit: true
          })
        }).catch((err) => console.warn('save-grading (teacher-edit) failed (non-fatal):', err))
      }
    }, 1000)
    studentAnswerSaveTimeoutsRef.current.set(index, timeout)
  }

  // 2026-05-30: VJ 視覺判斷題 — 老師逐柱切「有畫/沒畫」（取代文字編輯）。
  // 寫回 finalAnswers[qid].vjBlankConfirmed（整題逐柱）+ studentAnswer 摘要、卷退回待批改、重批時 Phase B 照此判分。
  const handleDetailVjBlankToggle = async (index: number, itemIdx: number, newIsBlank: boolean) => {
    if (isBusy || isSavingScore) return
    const subId = propSub.id
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
    // 2026-08-01（user 拍板統一政策）：老師編輯＝老師接手、一律不重跑 AI，分數由老師自己填。
    //   VJ 逐柱切換因此對齊 handleDetailStudentAnswerChange 的既有政策（2026-07-13 老師接管）：
    //   只標記「已經由老師編輯」＋留 _aiOriginal 快照（回復鈕用），
    //   ⛔不退回待批改、不清分數、不自動改分——全題型行為一致。
    const updatedDetails = grDetails.map((d: any, i) => (i === index ? {
      ...d,
      vjItemResults: nextItems,
      studentAnswer: summary,
      reason: '已經由老師編輯',
      comment: '已經由老師編輯',
      // 快照額外帶 vjItemResults：回復時逐柱狀態要跟著回去（否則分數回了、柱還停在改後狀態）
      _aiOriginal: d._aiOriginal ?? { ...snapshotAiOriginal(d), vjItemResults: d.vjItemResults },
    } : d))
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
    // 老師接管：分數/狀態/gradedAt 全保留（與改答案同政策）
    const updatedSubFields: Partial<Submission> = {
      gradingResult: newGradingResult,
      finalAnswers: newFinalAnswers,
      updatedAt: now,
    }
    await db.submissions.update(subId, updatedSubFields)
    onUpdated({ ...propSub, ...updatedSubFields } as Submission)
    void fetch('/api/data/save-final-answers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ submissions: [{ id: subId, finalAnswers: newFinalAnswers }] })
    }).catch((err) => console.warn('save-final-answers (vj) failed:', err))
    // gradingResult（含編輯標記＋快照）寫回雲端、分數欄位原樣帶回（同改答案路徑）
    if (submission.status === 'graded') {
      void fetch('/api/data/save-grading', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({
          submissions: [{
            id: subId,
            score: submission.score ?? null,
            aiScore: submission.aiScore ?? null,
            scoreSource: submission.scoreSource ?? null,
            gradedAt: submission.gradedAt ?? null,
            gradingResult: newGradingResult,
          }],
          fromManualScoreEdit: true,
        })
      }).catch((err) => console.warn('save-grading (vj) failed:', err))
    }
  }

  // 單題得分即時更新（自動重算總分並儲存）
  const handleDetailScoreChange = async (index: number, scoreValue: number) => {
    if (isBusy || isSavingScore) return

    const id = propSub.id
    const submission = await db.submissions.get(id)
    if (!submission) return
    const dbDetails = (submission.gradingResult as { details?: any[] } | undefined)?.details
    const dbRow: any = Array.isArray(dbDetails) ? dbDetails[index] : undefined

    // 2026-08-01 修「回復鈕還原到前一次打的值、而非 AI 原判」（user 實測回報）：
    //   分數 input 是 controlled、onChange 已即時把 editableDetails[i].score 改成使用者輸入值，
    //   舊碼在 onBlur 用 snapshotAiOriginal(editableDetails[i]) 取快照 → 第一次改分就把「老師剛打的值」
    //   當成 AI 原判存進去。改為從 db 的 details 取（未被 UI 污染）；已有快照則沿用。
    const aiOriginalSnap = dbRow?._aiOriginal ?? (dbRow ? snapshotAiOriginal(dbRow) : undefined)

    // 2026-08-01 分數上下限（user 實測回報可打超過該題滿分）：0 ≤ 分數 ≤ maxScore。
    //   maxScore 為 0/未定義（不計分題）時只擋負數。
    const rowMax = Number(dbRow?.maxScore ?? editableDetails[index]?.maxScore ?? 0)
    const safeScore = Number.isFinite(rowMax) && rowMax > 0
      ? Math.max(0, Math.min(scoreValue, rowMax))
      : Math.max(0, scoreValue)

    // 2026-07-13 老師接管：改分數同樣換理由＋快照 AI 原判（回復鈕用）
    const updatedDetails = editableDetails.map((d: any, i: number) =>
      i === index ? { ...d, score: safeScore, reason: '已經由老師編輯', comment: '已經由老師編輯', _aiOriginal: aiOriginalSnap } : d
    )
    setEditableDetails(updatedDetails)

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
      // 2026-08-01 修 aiScore 被覆蓋 + scoreSource 標錯（user 回報鏈）：
      //   aiScore 契約是「AI 原判快照、唯讀」(db.ts:640)，舊碼寫 aiScore=newTotal 把 AI 原判抹掉
      //   → ①成績簿看不出人工介入(判 scoreSource==='manual') ②「AI 判幾分 vs 最終幾分」永久遺失
      //     (行政端統一批改後教師端要做最後確認、學情分析算 AI 批對率都靠它)
      //     ③成績簿還原鈕會還原到「老師改過的分」而非 AI 原判。
      //   改為：首次人工介入才捕捉改前總分當快照、已是 manual 則沿用(同 Gradebook 既有正確作法)。
      const aiSnapshot = submission.scoreSource === 'manual'
        ? submission.aiScore
        : (submission.aiScore ?? submission.score)
      await db.submissions.update(id, {
        score: newTotal,
        aiScore: aiSnapshot,
        scoreSource: 'manual',
        gradingResult: newGradingResult,
        gradedAt: now,
        updatedAt: now
      })
      fetch('/api/data/save-grading', {
        // 2026-05-28: 加 fromManualScoreEdit=true、讓 server applySubmissionStateTransitions
        // 知道這是手動改分數、不要 skip 已在訂正流程的學生
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ submissions: [{ id, score: newTotal, aiScore: aiSnapshot, scoreSource: 'manual', gradingResult: newGradingResult, gradedAt: now }], fromManualScoreEdit: true })
      }).catch(() => {})
      requestSync()

      const updated = await db.submissions.get(id)
      if (updated) {
        onUpdated(updated)
      }
    } finally {
      setIsSavingScore(false)
    }
  }

  // 2026-07-13 回復鈕（user 拍板）：老師誤植時一鍵還原該題到 AI 原判（_aiOriginal 快照、非上一步）、
  //   快照清除、總分/錯題清單重算、finalAnswers 該題退回 ai_read1。
  const handleDetailRestore = async (index: number) => {
    if (isBusy || isSavingScore) return
    const id = propSub.id
    const submission = await db.submissions.get(id)
    if (!submission) return
    const latestDetails = (submission.gradingResult as { details?: Array<Record<string, unknown>> } | undefined)?.details
    if (!Array.isArray(latestDetails)) return
    const target: any = latestDetails[index]
    const snap = target?._aiOriginal
    if (!snap) return
    const restoredRow: any = { ...target, ...snap }
    delete restoredRow._aiOriginal
    const updatedDetails = latestDetails.map((d, i) => (i === index ? restoredRow : d))
    const newTotal = parseFloat(updatedDetails.reduce((s: number, d: any) => s + (Number.isFinite(Number(d.score)) ? Number(d.score) : 0), 0).toFixed(1))
    const newGradingResult: any = { ...(submission.gradingResult || {}), details: updatedDetails, totalScore: newTotal }
    // 錯題清單重算（同改分數邏輯）
    const oldMistakesByQid = new Map<string, any>()
    for (const m of (Array.isArray(submission.gradingResult?.mistakes) ? submission.gradingResult.mistakes : []) as any[]) {
      if (m?.questionId) oldMistakesByQid.set(m.questionId, m)
    }
    newGradingResult.mistakes = updatedDetails
      .filter((d: any) => d?.isCorrect === false && d?.questionId)
      .map((d: any) => oldMistakesByQid.get(d.questionId) ?? ({ questionId: d.questionId, questionText: '', studentAnswer: d.studentAnswer || '', correctAnswer: '', reason: d.reason || '' }))
    // finalAnswers 該題退回 AI 讀值
    const newFinalAnswers = (Array.isArray(submission.finalAnswers) ? submission.finalAnswers : []).map((fa) =>
      fa.questionId === restoredRow.questionId
        ? { ...fa, finalStudentAnswer: String(snap.studentAnswer ?? ''), finalAnswerSource: 'ai_read1' as const }
        : fa
    )
    setIsSavingScore(true)
    try {
      const now = Date.now()
      // 2026-08-01 同 handleDetailScoreChange：aiScore 是 AI 原判快照、還原時不可覆蓋成當下總分。
      //   scoreSource：本卷若已無任何題帶 _aiOriginal（全部還原完）→ 回 'ai'；仍有他題被改 → 維持 'manual'。
      const stillEdited = updatedDetails.some((d) => (d as { _aiOriginal?: unknown })?._aiOriginal)
      const nextSource: 'ai' | 'manual' = stillEdited ? 'manual' : 'ai'
      await db.submissions.update(id, { gradingResult: newGradingResult, finalAnswers: newFinalAnswers, score: newTotal, aiScore: submission.aiScore, scoreSource: nextSource, updatedAt: now })
      setEditableDetails((prev) => prev.map((d: any, i: number) => (i === index ? { ...d, ...snap, _aiOriginal: undefined } : d)))
      void fetch('/api/data/save-final-answers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ submissions: [{ id, finalAnswers: newFinalAnswers }] })
      }).catch(() => {})
      void fetch('/api/data/save-grading', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ submissions: [{ id, score: newTotal, aiScore: submission.aiScore, scoreSource: nextSource, gradingResult: newGradingResult, gradedAt: submission.gradedAt ?? now }], fromManualScoreEdit: true })
      }).catch(() => {})
      const updated = await db.submissions.get(id)
      if (updated) {
        onUpdated(updated)
      }
    } finally {
      setIsSavingScore(false)
    }
  }


  return (
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
                const imageUrl = getSubmissionImageUrl(propSub)
                const hasLocalOriginalImage =
                  Boolean(propSub.imageBase64) ||
                  (propSub.imageBlob?.size ?? 0) > 0
                const zoomImageUrl =
                  !hasLocalOriginalImage &&
                  propSub.id
                    ? buildApiUrl(
                        `/api/storage/download?submissionId=${encodeURIComponent(
                          propSub.id
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
                      {student.seatNumber} 號 · {student.name}
                    </h2>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {classroomName} · {assignment?.title}
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
                          {propSub.gradingResult?.totalScore ??
                            propSub.score ??
                            '-'}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500">依各題得分自動加總</p>
                    </div>
                    {propSub.status === 'graded' && (
                      <span className="px-2 py-1 text-xs rounded-full bg-green-50 text-green-700 border border-green-200 font-semibold">
                        已批改
                      </span>
                    )}
                  </div>
                )}
                {assignment?.scoringMode === 'unscored' && propSub.status === 'graded' && (
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
                        const isNotGradedYet = propSub.status !== 'graded'
                          || isStale
                        // 2026-05-18: 學生答案是「無法辨識」→ 卡片底色標紅、老師一眼看到要再複核哪一題
                        const isUnrecognizable = String(d.studentAnswer || '').trim() === '無法辨識'
                        // 2026-07-13: 系統信心 <70（邊界攔/調號攔維持等旅程）→ 同樣紅底、掛「低信心」小標
                        //   老師編輯過（_aiOriginal 存在）＝已人工裁決 → 紅底熄滅
                        const isTeacherEdited = !!d._aiOriginal
                        const isLowConf = !isTeacherEdited && Number.isFinite(Number(d.systemConfidence)) && Number(d.systemConfidence) < 70
                        // 2026-05-28: map_fill 已 pivot 到 Phase A 3-AI、studentAnswer 是老師確認後的逗號分隔地名、
                        // 不再需要鎖編輯欄（老師可微調個別字、之後 deterministic match 再算分）
                        const isVisualEval = false
                        // 2026-07-21 v2（user 拍板顯示統一）: 國字注音 VJ 化後，判官經手的格「對或錯」一律顯示
                        //   「圖像辨識」唯讀（不露轉錄值、避免顯示太多招質疑）；「未作答」除外（顯示未作答、保留可編輯
                        //   讓老師能補真值）。哪裡錯看理由欄；誤殺走申訴、低信心老師直接改分。
                        const isImageJudged = isImageJudgedAnswer(d.reason, d.finalAnswerSource)
                          && String(d.studentAnswer ?? '').trim() !== '未作答' && String(d.studentAnswer ?? '').trim() !== ''
                        // 2026-05-30: VJ 視覺判斷題 — 學生答案改逐柱「有畫/沒畫」、不給文字框
                        const vjItems: Array<{ idx: number; label: string; verdict: string; reason: string }> =
                          Array.isArray(d.vjItemResults) ? d.vjItemResults : []
                        const isVJ = vjItems.length > 0

                        return (
                          <div
                            key={questionId}
                            className={`border rounded-lg p-3 text-xs space-y-2 ${
                              (isUnrecognizable || isLowConf)
                                ? 'border-rose-300 bg-rose-50'  // 紅底紅框、強烈視覺提示
                                : 'border-gray-200 bg-gray-50'
                            }`}
                          >
                            <div className="flex justify-between items-center gap-2">
                              <div className="flex items-center gap-2">
                                <span className="font-semibold text-gray-800">
                                  題目 {questionId}
                                </span>
                                {isLowConf && (
                                  <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-rose-100 text-rose-700 border border-rose-200" title="系統對這題的判定信心偏低，建議看一眼">
                                    低信心
                                  </span>
                                )}
                                {isTeacherEdited && (
                                  <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); void handleDetailRestore(i) }}
                                    disabled={isBusy || isSavingScore}
                                    className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-slate-100 text-slate-600 border border-slate-200 hover:bg-slate-200"
                                    title="還原成 AI 原本的批改內容（答案、分數、理由）"
                                  >
                                    <RefreshCw className="w-3 h-3" />
                                    回復 AI 批改
                                  </button>
                                )}
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
                                  (isVisualEval || isImageJudged)
                                    ? 'border-gray-200 italic text-gray-500'
                                    : isUnrecognizable ? 'border-rose-300' : 'border-gray-200 hover:border-gray-300'
                                }`}
                                value={isVisualEval ? '採視覺評分' : isImageJudged ? '圖像辨識' : String(d.studentAnswer ?? '')}
                                placeholder={(isVisualEval || isImageJudged) ? undefined : '（點此編輯）'}
                                disabled={isVisualEval || isImageJudged || isBusy || isSavingScore}
                                onChange={(e) => {
                                  if (isVisualEval || isImageJudged) return
                                  handleDetailStudentAnswerChange(i, e.target.value)
                                  // 即時撐高、不等下次 re-render
                                  e.target.style.height = 'auto'
                                  e.target.style.height = e.target.scrollHeight + 'px'
                                }}
                                onFocus={(e) => { if (!isVisualEval && !isImageJudged) e.target.select() }}
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
                                  : isImageJudged
                                    ? '這格由圖像辨識（字形/筆畫視覺覆核）判定：讀出的字剛好＝標準答案但實際筆畫有誤，故不顯示轉錄文字。錯在哪請看下方「理由」欄、對照左側作答圖。'
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

                            {/* 2026-07-15 老師接管編輯時顯示正確答案（user：改了答案不知道對不對、沒依據給分）*/}
                            {isTeacherEdited && (() => {
                              const akQ = ((assignment?.answerKey as { questions?: Array<{ id?: string; answer?: string; referenceAnswer?: string; parts?: Array<{ subId?: string; answer?: string }> }> } | undefined)?.questions ?? [])
                                .find((q) => String(q?.id ?? '') === String(d.questionId ?? ''))
                              if (!akQ) return null
                              const partsText = Array.isArray(akQ.parts) && akQ.parts.length > 0
                                ? akQ.parts.map((p) => `${p.subId ? `(${p.subId}) ` : ''}${p.answer ?? ''}`).join('、')
                                : ''
                              const keyText = partsText || String(akQ.answer ?? akQ.referenceAnswer ?? '').trim()
                              if (!keyText) return null
                              return (
                                <div className="text-xs flex items-start gap-2 mt-1 px-2 py-1.5 rounded bg-emerald-50 border border-emerald-100">
                                  <span className="mt-0.5 shrink-0 text-emerald-700 font-semibold">正確答案：</span>
                                  <span className="text-emerald-800 whitespace-pre-line flex-1 break-words">{keyText}</span>
                                </div>
                              )
                            })()}

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

                {!propSub.gradingResult?.details &&
                  propSub.feedback && (
                    <div className="text-gray-500 text-sm text-center italic py-4">
                      這是舊版批改紀錄，建議重新批改更新 AI 結果
                    </div>
                  )}
              </div>
            </div>
          </div>
        </div>
  )
}
