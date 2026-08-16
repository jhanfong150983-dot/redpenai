// ═══ 評分統計(答案聚合)資料層 — 2026-08-11 user 設計 ═══════════════════════════
// 每題聚合全班答案 → 依分數分桶;老師拖曳整群改分 → 批次套用既有 manual 改分機制
// (AI 原判 _aiOriginal 快照、「已修改」badge、回復鈕、aiScore/scoreSource 規則全部沿用,
//  邏輯鏡像 SubmissionDetailModal.handleDetailScoreChange —— 動那邊記得同步這邊)。
import { db, type Submission, type GradingDetail } from '@/lib/db'

export type StudentLike = { seatNumber?: number | string | null; name?: string | null }
import { requestSync } from '@/lib/sync-events'

// 正規化(鏡像 server semantic-score-table.normSemanticValue:全半形/空白/頭尾標點折疊、一字不折)
// 2026-08-12 加 CJK 內部分隔標點折疊(兩側皆中文字的 , . ; : =AI read 漂移;數字鄰接保留)——與 server 同步改
// 2026-08-16 數學式分支:大小寫與關係符號折疊(鏡像 server foldMathValue)。
//   事故(user 回報):「x>=50/7」「X>=50/7」「x≥50/7」「x≧50/7」在評分統計分成四群,實為同一答案。
//   ⚠ 只在數學式才折——核心規則是一字不折(錯字是 charerr 的事);英語「Dog」vs「dog」會扣分,
//     無條件小寫化會併成一群→群內兩種分數。守門:①整串無中文 ②必須含關係符號(英文單字走原路)。
const MATHY_VALUE = /^[A-Za-z0-9+\-*/^().,%<>=≤≥≦≧⩽⩾≠√πθ°:| \\{}]+$/u
function deLatexForCompare(raw: string): string {
  let t = raw
  if (!t.includes('\\')) return t
  t = t.replace(/\\frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/gu, '$1/$2')
  t = t.replace(/\\sqrt\s*\{([^{}]+)\}/gu, '√$1')
  t = t.replace(/\\(?:leqslant|leqq|leq|le)(?![a-z])/gu, '<=')
  t = t.replace(/\\(?:geqslant|geqq|geq|ge)(?![a-z])/gu, '>=')
  t = t.replace(/\\lt(?![a-z])/gu, '<').replace(/\\gt(?![a-z])/gu, '>')
  t = t.replace(/\\(?:times|cdot)(?![a-z])/gu, '×').replace(/\\div(?![a-z])/gu, '÷')
  t = t.replace(/\\%/gu, '%').replace(/\\(?:left|right)(?![a-z])/gu, '')
  return t
}
function foldMathValue(base: string): string {
  if (!base || !MATHY_VALUE.test(base)) return base
  // de-LaTeX 要在守門之前:「x\geqq 50/7」的關係是字母不是符號,先還原才認得出來
  let t = deLatexForCompare(base)
  if (!/[<>=≤≥≦≧⩽⩾]/u.test(t)) return base
  t = t.replace(/[≦≤⩽]/gu, '<=').replace(/[≧≥⩾]/gu, '>=').replace(/≠/gu, '!=')
  t = t.replace(/=>/gu, '>=').replace(/=</gu, '<=')
  t = t.replace(/\s*(<=|>=|!=|<|>|=)\s*/gu, '$1')
  return t.toLowerCase()
}

export function normAnswerValue(raw: unknown): string {
  return foldMathValue(String(raw ?? '')
    .trim()
    // 2026-08-14 帶分數:數字↔數字之間的空白保留成單一空白,其餘照舊全刪。
    //   事故:「x<=6 7/11」(6又7/11,正確) 與「x<= 67/11」(67/11,錯) 全刪空白後同鍵 →
    //   評分統計同群兩種分數;更危險的是查表制「全歧取最高」會讓錯的繼承對的分數(放水)。
    //   全庫回放:凍結表 78 列受影響 0(免遷移);卷面只 2 群變動,皆為真誤併;反向檢查無誤拆。
    .replace(/\s+/g, (m, off, s) => (/\d$/.test(s.slice(0, off)) && /^\d/.test(s.slice(off + m.length)) ? ' ' : ''))
    .replace(/，/g, ',').replace(/。/g, '.').replace(/；/g, ';').replace(/：/g, ':').replace(/、/g, ',')
    .replace(/([一-鿿])[,.;:]+(?=[一-鿿])/g, '$1')
    .replace(/^[,.;:!?，。；：、！？\s]+|[,.;:!?，。；：、！？\s]+$/g, ''))
}

const SPECIAL_VALUES = new Set(['', '未作答', '無法辨識', '圖像辨識'])

export type GroupMember = {
  submissionId: string
  assignmentId: string   // 取代表卷面 crop 用（/api/report/crops）
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
  imageAgg: boolean        // 圖像判分聚合群(級分制/作圖題)→ 群名不是學生答案,要配代表卷面 crop
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
      // ── 圖像判分題的聚合鍵 ──────────────────────────────────────────────
      // 這類題的 studentAnswer 是「卷面作答」「圖上作答」等佔位字串，拿它分群會讓
      // 全班塌成一群（實測 32 人一群、群內 4 種分數）。但它們都留下了**逐項判定向量**，
      // 那才是真正的「同樣的作答樣態」：同一組判定必定同分。
      //   ・應用題級分制 → levelResult（哪些要素有呈現）
      //   ・作圖題 VJ    → vjItemResults（逐項對／錯／空白）
      const lv = (d as { levelResult?: NonNullable<GradingDetail['levelResult']> })?.levelResult
      const vj = (d as { vjItemResults?: Array<{ idx: number; label?: string; verdict?: string }> })?.vjItemResults
      const isLevel = Array.isArray(lv?.found)
      const isVj = Array.isArray(vj) && vj.length > 0

      let rawText = ''
      let key = ''
      if (isLevel) {
        // 群名列「缺哪幾項」（user 選 B）：老師檢討時要找的是這群卡在哪一步。
        // 標籤在批改時就存進 evidence.label——統計面板拿不到答案卷，不能靠 key 反查。
        const ev = lv!.evidence ?? []
        const done = lv!.found?.length ?? 0
        const total = ev.length || done
        // waived＝替代組已由另一條滿足，不算缺
        const missing = ev.filter((e) => !e.present && !e.waived)
        // 舊批改資料沒存 label；寧可只顯示數量，也不把 E1/E2 代號露給老師
        const named = missing.every((e) => !!e.label) ? missing.map((e) => e.label!) : []
        rawText = missing.length === 0
          ? (total > 0 ? `全部做到（${done}/${total} 項）` : '全部做到')
          : named.length > 0
            ? `${done}/${total} 項｜缺：${named.join('、')}`
            : `${done}/${total} 項`
        key = `__level__${[...(lv!.found ?? [])].sort().join('|')}`
      } else if (isVj) {
        rawText = vj!.map((i) => `${i.label || `項目${i.idx}`}${i.verdict === 'correct' ? '✓' : i.verdict === 'blank' ? '（空白）' : '✗'}`).join('　')
        key = `__vj__${vj!.map((i) => `${i.idx}:${i.verdict}`).join('|')}`
      } else {
        rawText = String(d?.studentAnswer ?? d?.studentFinalAnswer ?? '').trim()
        key = normAnswerValue(rawText)
      }
      // user 拍板：老師拖曳＝老師的專業判斷，人工才是最標準的原則 → 圖像判分題一樣可整群改分
      const isImageAgg = isLevel || isVj
      const locked = !isImageAgg
        && (SPECIAL_VALUES.has(rawText) || SPECIAL_VALUES.has(key) || key === '')
      const mx = Number(d?.maxScore)
      if (Number.isFinite(mx) && mx > 0) maxByQid.set(qid, Math.max(maxByQid.get(qid) ?? 0, mx))
      const gm = byQid.get(qid) ?? new Map<string, AnswerGroup>()
      const gKey = isImageAgg ? key : (locked ? `__special__${rawText || '(空白)'}` : key)
      const g = gm.get(gKey) ?? { key: gKey, raw: isImageAgg ? rawText : (locked ? (rawText || '(空白)') : rawText), members: [], score: 0, mixed: false, locked, imageAgg: isImageAgg, reason: '' }
      g.members.push({
        submissionId: submission.id,
        assignmentId: submission.assignmentId,
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
  onProgress?: (done: number, total: number) => void,
  assignmentId?: string,              // 查表制回寫需要（解析 scope_key）
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
  // ── 老師裁決回寫 VJ 冷凍表（2026-08-16 user 拍板）────────────────────────
  //   圖像判分題的判定被凍結後，重批會沿用；若老師在這裡調整過分數卻不回寫，
  //   下次重批又會跑出 AI 的原判、把老師的修正蓋掉（＝白改）。
  //   只送圖像判分群（imageAgg）；成功與否都不擋改分（分數已寫進本機與 server）。
  try {
    // 圖像判分群 → 依 submission+question 回寫（圖各自不同）
    // 文字/數值群   → 另帶 value，讓 server 依「答案值」回寫查表制（跨學生、同答同分）
    const items: Array<{ submissionId: string; questionId: string; score: number; value?: string }> = []
    for (const q of stats) {
      for (const g of q.groups) {
        const newScore = staged.get(`${q.qid}|${g.key}`)
        if (newScore == null) continue
        for (const m of g.members) {
          items.push({
            submissionId: m.submissionId, questionId: q.qid, score: newScore,
            ...(g.imageAgg ? {} : { value: g.raw }),
          })
        }
      }
    }
    if (items.length > 0) {
      await fetch('/api/data/vj-freeze-override', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ assignmentId, items }),
      })
    }
  } catch { /* 非致命：回寫失敗不影響本次改分，只是下次重批可能被 AI 覆蓋 */ }
  requestSync()
  return results
}
