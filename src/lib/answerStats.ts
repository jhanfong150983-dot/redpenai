// ═══ 評分統計(答案聚合)資料層 — 2026-08-11 user 設計 ═══════════════════════════
// 每題聚合全班答案 → 依分數分桶;老師拖曳整群改分 → 批次套用既有 manual 改分機制
// (AI 原判 _aiOriginal 快照、「已修改」badge、回復鈕、aiScore/scoreSource 規則全部沿用,
//  邏輯鏡像 SubmissionDetailModal.handleDetailScoreChange —— 動那邊記得同步這邊)。
import { db, type Submission } from '@/lib/db'

export type StudentLike = { seatNumber?: number | string | null; name?: string | null }
import { requestSync } from '@/lib/sync-events'

// 正規化(鏡像 server semantic-score-table.normSemanticValue:全半形/空白/頭尾標點折疊、一字不折)
// 2026-08-12 加 CJK 內部分隔標點折疊(兩側皆中文字的 , . ; : =AI read 漂移;數字鄰接保留)——與 server 同步改
export function normAnswerValue(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/，/g, ',').replace(/。/g, '.').replace(/；/g, ';').replace(/：/g, ':').replace(/、/g, ',')
    .replace(/([一-鿿])[,.;:]+(?=[一-鿿])/g, '$1')
    .replace(/^[,.;:!?，。；：、！？\s]+|[,.;:!?，。；：、！？\s]+$/g, '')
}

const SPECIAL_VALUES = new Set(['', '未作答', '無法辨識', '圖像辨識'])

export type GroupMember = {
  submissionId: string
  studentId: string
  seat: number | string | null
  name: string
  score: number
  edited: boolean          // _aiOriginal 存在 = 老師已編輯過
  reason: string
}

export type AnswerGroup = {
  key: string              // normalized value
  raw: string              // 首見原文(顯示)
  members: GroupMember[]
  score: number            // 群代表分(眾數)
  mixed: boolean           // 群內分數不一致(=同寫法不同分)
  locked: boolean          // 特殊狀態(未作答/無法辨識/圖像辨識/空白)不可拖
  reason: string           // 代表理由(多數分數成員的 AI 理由;查表題=同答同理由)
}

export type QuestionStats = {
  qid: string
  maxScore: number
  groups: AnswerGroup[]
  hasMixed: boolean
  lockedOnly: boolean      // 全部都是鎖定群(例:整題圖像判分)→ 唯讀 tab
}

// 題號自然排序("1-A-2"→逐段、數字當數字)
export function cmpQid(a: string, b: string): number {
  const pa = String(a).split('-'), pb = String(b).split('-')
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '', y = pb[i] ?? ''
    const nx = parseInt(x, 10), ny = parseInt(y, 10)
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) { if (nx !== ny) return nx - ny }
    else if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

export function buildQuestionStats(entries: Array<{ submission: Submission; student: StudentLike }>): QuestionStats[] {
  const byQid = new Map<string, Map<string, AnswerGroup>>()
  const maxByQid = new Map<string, number>()
  for (const { submission, student } of entries) {
    const details = (submission.gradingResult as { details?: any[] } | undefined)?.details
    if (!Array.isArray(details)) continue
    for (const d of details) {
      const qid = String(d?.questionId ?? '').trim()
      if (!qid) continue
      // 2026-08-14 級分制（應用題）：studentAnswer 一律是「卷面作答」，
      //   用它分群會讓全班塌成一群、群內出現多種分數（實測 32 人一群、4 種分數）。
      //   改用「判官認定呈現了哪些要素」當鍵——同一組要素必定同級分，這才是真正的同質群。
      const lvFound = (d as { levelResult?: { found?: string[] } })?.levelResult?.found
      const isLevel = Array.isArray(lvFound)
      const rawText = isLevel
        ? (lvFound.length > 0 ? `做到：${lvFound.join('、')}` : '未做到任何要素')
        : String(d?.studentAnswer ?? d?.studentFinalAnswer ?? '').trim()
      const key = isLevel ? `__level__${[...lvFound].sort().join('|')}` : normAnswerValue(rawText)
      // 級分制群組不可拖曳改分（分數由要素組合決定，改了會與規準脫節）→ 一律 locked
      const locked = isLevel
        || SPECIAL_VALUES.has(rawText) || SPECIAL_VALUES.has(key) || key === ''
      const mx = Number(d?.maxScore)
      if (Number.isFinite(mx) && mx > 0) maxByQid.set(qid, Math.max(maxByQid.get(qid) ?? 0, mx))
      const gm = byQid.get(qid) ?? new Map<string, AnswerGroup>()
      const gKey = isLevel ? key : (locked ? `__special__${rawText || '(空白)'}` : key)
      const g = gm.get(gKey) ?? { key: gKey, raw: isLevel ? rawText : (locked ? (rawText || '(空白)') : rawText), members: [], score: 0, mixed: false, locked, reason: '' }
      g.members.push({
        submissionId: submission.id,
        studentId: submission.studentId,
        seat: student.seatNumber ?? null,
        name: student.name ?? '',
        score: Number.isFinite(Number(d?.score)) ? Number(d.score) : 0,
        edited: !!d?._aiOriginal,
        reason: String(d?.reason ?? d?.comment ?? '').trim()
      })
      gm.set(gKey, g)
      byQid.set(qid, gm)
    }
  }
  const out: QuestionStats[] = []
  for (const [qid, gm] of byQid) {
    const groups = [...gm.values()]
    for (const g of groups) {
      const tally = new Map<number, number>()
      for (const m of g.members) tally.set(m.score, (tally.get(m.score) ?? 0) + 1)
      const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])
      g.score = sorted[0]?.[0] ?? 0
      g.mixed = tally.size > 1
      g.reason = g.members.find((m) => m.score === g.score && m.reason)?.reason
        ?? g.members.find((m) => m.reason)?.reason ?? ''
    }
    groups.sort((a, b) => b.members.length - a.members.length)
    out.push({
      qid,
      maxScore: maxByQid.get(qid) ?? 0,
      groups,
      hasMixed: groups.some((g) => g.mixed && !g.locked),
      lockedOnly: groups.every((g) => g.locked)
    })
  }
  out.sort((a, b) => cmpQid(a.qid, b.qid))
  return out
}

// ── 批次套用(一份卷可含多題編輯;鏡像 handleDetailScoreChange 全部規則)──────────
export type BatchEditResult = { submissionId: string; ok: boolean; updated?: Submission; error?: string }

export async function applyScoreEditsToSubmission(
  submissionId: string,
  editsByQid: Map<string, number>
): Promise<BatchEditResult> {
  try {
    const submission = await db.submissions.get(submissionId)
    if (!submission) return { submissionId, ok: false, error: 'submission not found' }
    const gr: any = submission.gradingResult
    const details: any[] = Array.isArray(gr?.details) ? gr.details : []
    if (!details.length) return { submissionId, ok: false, error: 'no details' }

    let changed = 0
    const now = Date.now()
    const updatedDetails = details.map((d: any) => {
      const qid = String(d?.questionId ?? '').trim()
      if (!editsByQid.has(qid)) return d
      const rowMax = Number(d?.maxScore ?? 0)
      const target = Number(editsByQid.get(qid))
      const safeScore = Number.isFinite(rowMax) && rowMax > 0
        ? Math.max(0, Math.min(target, rowMax))
        : Math.max(0, target)
      const prevScore = Number(d?.score ?? 0)
      if (safeScore === prevScore) return d   // 無實質改變不留痕(鏡像單格規則)
      changed++
      const snapshotAiOriginal = d._aiOriginal ?? {
        score: d.score, maxScore: d.maxScore, isCorrect: d.isCorrect,
        reason: d.reason, comment: d.comment, studentAnswer: d.studentAnswer,
        errorType: d.errorType, rubricScores: d.rubricScores
      }
      return {
        ...d, score: safeScore,
        reason: '已經由老師編輯', comment: '已經由老師編輯',
        _aiOriginal: snapshotAiOriginal, _editedAt: now, _editedBy: undefined
      }
    })
    if (changed === 0) return { submissionId, ok: true, updated: submission }

    const cleanedDetails = updatedDetails.map((d: any) => {
      const score = Number.isFinite(Number(d.score)) ? Number(d.score) : 0
      const maxScore = Number.isFinite(Number(d.maxScore)) ? Number(d.maxScore) : 0
      return { ...d, score, maxScore, isCorrect: maxScore > 0 ? score >= maxScore : false, reason: d.reason ?? d.comment ?? '', comment: d.comment ?? d.reason ?? '' }
    })
    const newTotal = parseFloat(cleanedDetails.reduce((s: number, d: any) => s + (Number.isFinite(d.score) ? Number(d.score) : 0), 0).toFixed(1))
    const newGradingResult: any = { ...(gr ?? { weaknesses: [], suggestions: [] }) }
    newGradingResult.details = cleanedDetails
    newGradingResult.totalScore = newTotal
    newGradingResult.needsReview = false
    newGradingResult.reviewReasons = []
    // mistakes 依新 isCorrect 重建(鏡像單格規則:學生端訂正清單才會一致)
    const oldMistakesByQid = new Map<string, any>()
    if (Array.isArray(gr?.mistakes)) for (const m of gr.mistakes) if (m?.questionId) oldMistakesByQid.set(m.questionId, m)
    newGradingResult.mistakes = cleanedDetails
      .filter((d: any) => d?.isCorrect === false && d?.questionId)
      .map((d: any) => {
        const existing = oldMistakesByQid.get(d.questionId)
        return existing
          ? { ...existing, reason: d.reason || existing.reason }
          : { questionId: d.questionId, questionText: d.questionText || '', studentAnswer: d.studentAnswer || '', correctAnswer: d.correctAnswer || '', reason: d.reason || '手動標記為錯誤' }
      })

    const aiSnapshot = submission.scoreSource === 'manual'
      ? submission.aiScore
      : (submission.aiScore ?? submission.score)
    await db.submissions.update(submissionId, {
      score: newTotal, aiScore: aiSnapshot, scoreSource: 'manual',
      gradingResult: newGradingResult, gradedAt: now, updatedAt: now
    })
    await fetch('/api/data/save-grading', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ submissions: [{ id: submissionId, score: newTotal, aiScore: aiSnapshot, scoreSource: 'manual', gradingResult: newGradingResult, gradedAt: now }], fromManualScoreEdit: true })
    }).catch(() => {})
    const updated = await db.submissions.get(submissionId)
    return { submissionId, ok: true, updated: updated ?? undefined }
  } catch (e) {
    return { submissionId, ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ── 單格回復 AI 原判(鏡像 SubmissionDetailModal.handleDetailRestore、改依 qid 定位)──
//   _aiOriginal 快照還原+清快照、總分/錯題清單重算、finalAnswers 退回 ai_read1、
//   scoreSource:全卷無殘餘編輯→'ai'、否則維持 'manual'。動那邊記得同步這邊。
export async function restoreDetailToAi(submissionId: string, qid: string): Promise<BatchEditResult> {
  try {
    const submission = await db.submissions.get(submissionId)
    if (!submission) return { submissionId, ok: false, error: 'submission not found' }
    const gr: any = submission.gradingResult
    const details: any[] = Array.isArray(gr?.details) ? gr.details : []
    const index = details.findIndex((d: any) => String(d?.questionId ?? '').trim() === qid)
    const target: any = details[index]
    const snap = target?._aiOriginal
    if (!snap) return { submissionId, ok: true, updated: submission }
    const restoredRow: any = { ...target, ...snap }
    delete restoredRow._aiOriginal
    const updatedDetails = details.map((d, i) => (i === index ? restoredRow : d))
    const newTotal = parseFloat(updatedDetails.reduce((s: number, d: any) => s + (Number.isFinite(Number(d.score)) ? Number(d.score) : 0), 0).toFixed(1))
    const newGradingResult: any = { ...(gr || {}), details: updatedDetails, totalScore: newTotal }
    const oldMistakesByQid = new Map<string, any>()
    for (const m of (Array.isArray(gr?.mistakes) ? gr.mistakes : []) as any[]) {
      if (m?.questionId) oldMistakesByQid.set(m.questionId, m)
    }
    newGradingResult.mistakes = updatedDetails
      .filter((d: any) => d?.isCorrect === false && d?.questionId)
      .map((d: any) => oldMistakesByQid.get(d.questionId) ?? ({ questionId: d.questionId, questionText: '', studentAnswer: d.studentAnswer || '', correctAnswer: '', reason: d.reason || '' }))
    const newFinalAnswers = (Array.isArray(submission.finalAnswers) ? submission.finalAnswers : []).map((fa: any) =>
      fa.questionId === restoredRow.questionId
        ? { ...fa, finalStudentAnswer: String(snap.studentAnswer ?? ''), finalAnswerSource: 'ai_read1' as const }
        : fa
    )
    const now = Date.now()
    const stillEdited = updatedDetails.some((d: any) => d?._aiOriginal)
    const nextSource: 'ai' | 'manual' = stillEdited ? 'manual' : 'ai'
    await db.submissions.update(submissionId, {
      gradingResult: newGradingResult, finalAnswers: newFinalAnswers,
      score: newTotal, aiScore: submission.aiScore, scoreSource: nextSource, updatedAt: now,
    })
    void fetch('/api/data/save-final-answers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ submissions: [{ id: submissionId, finalAnswers: newFinalAnswers }] })
    }).catch(() => {})
    void fetch('/api/data/save-grading', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ submissions: [{ id: submissionId, score: newTotal, aiScore: submission.aiScore, scoreSource: nextSource, gradingResult: newGradingResult, gradedAt: submission.gradedAt ?? now }], fromManualScoreEdit: true })
    }).catch(() => {})
    requestSync()
    const updated = await db.submissions.get(submissionId)
    return { submissionId, ok: true, updated: updated ?? undefined }
  } catch (e) {
    return { submissionId, ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 全部套用:staged(qid → (groupKey → newScore)) × 統計資料 → 逐卷合併編輯、並行 4 路
export async function applyStagedGroupEdits(
  stats: QuestionStats[],
  staged: Map<string, number>,        // key = `${qid}|${groupKey}`
  onProgress?: (done: number, total: number) => void
): Promise<BatchEditResult[]> {
  const editsBySubmission = new Map<string, Map<string, number>>()
  for (const q of stats) {
    for (const g of q.groups) {
      const newScore = staged.get(`${q.qid}|${g.key}`)
      if (newScore == null) continue
      for (const m of g.members) {
        const em = editsBySubmission.get(m.submissionId) ?? new Map<string, number>()
        em.set(q.qid, newScore)
        editsBySubmission.set(m.submissionId, em)
      }
    }
  }
  const tasks = [...editsBySubmission.entries()]
  const results: BatchEditResult[] = []
  let idx = 0, done = 0
  await Promise.all(Array.from({ length: Math.min(4, tasks.length) }, async () => {
    while (idx < tasks.length) {
      const [sid, edits] = tasks[idx++]
      const r = await applyScoreEditsToSubmission(sid, edits)
      results.push(r)
      done++
      onProgress?.(done, tasks.length)
    }
  }))
  requestSync()
  return results
}
