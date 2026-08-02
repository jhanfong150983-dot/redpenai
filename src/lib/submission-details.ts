import { db } from '@/lib/db'
import type { Submission } from '@/lib/db'

/**
 * 2026-08-03 sync 瘦身的 client 這一半。
 *
 * 背景:submissions 的 grading_result / phase_a_state / final_answers 三個大 JSONB
 *   佔單份 42KB 中的 41KB。行政端全校一次考卷 2200 份 → 首次 sync 90MB,手機/學校網路直接卡死。
 *   → sync 只帶輕量欄位,需要逐題資料的畫面在開啟時呼叫這裡補齊,補完寫回 Dexie。
 *
 * 快取失效規則:`detailsFetchedAt < updatedAt` 就重抓。
 *   server 端任何一次重批/改分都會動 updated_at,所以不會拿到過期的逐題資料。
 *
 * ⚠ 不要在「列表類」畫面呼叫這個(作業列表、成績簿、首頁總覽)——那些只需要分數與狀態,
 *   輕量欄位就夠了。呼叫它等於把瘦身的效果吐回去。
 */

interface DetailRow {
  id: string
  assignmentId: string
  updatedAt?: number
  gradingResult: Submission['gradingResult'] | null
  phaseAState: Submission['phaseAState'] | null
  finalAnswers: Submission['finalAnswers'] | null
}

/** 這份卷的大 JSONB 是不是已經補齊且沒過期 */
function isHydrated(sub: Submission): boolean {
  const at = sub.detailsFetchedAt
  if (typeof at !== 'number') return false
  const updated = typeof sub.updatedAt === 'number' ? sub.updatedAt : 0
  return at >= updated
}

async function applyDetails(rows: DetailRow[]): Promise<void> {
  if (rows.length === 0) return
  const now = Date.now()
  const ids = rows.map((r) => r.id)
  const existing = await db.submissions.bulkGet(ids)
  const byId = new Map<string, Submission>()
  for (const e of existing) if (e) byId.set(e.id, e)

  const merged: Submission[] = []
  for (const r of rows) {
    const local = byId.get(r.id)
    if (!local) continue // sync 還沒帶到這筆,略過;下次同步後再補
    merged.push({
      ...local,
      gradingResult: r.gradingResult ?? undefined,
      phaseAState: r.phaseAState ?? undefined,
      finalAnswers: r.finalAnswers ?? undefined,
      detailsFetchedAt: now
    })
  }
  if (merged.length > 0) await db.submissions.bulkPut(merged)
}

async function fetchDetails(payload: Record<string, string[]>): Promise<DetailRow[]> {
  const res = await fetch('/api/data/submission-details', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(payload)
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error || `補齊批改詳情失敗（${res.status}）`)
  return Array.isArray(data?.details) ? data.details : []
}

/**
 * 補齊這些作業底下所有卷的逐題資料。已補齊且未過期的不會重抓。
 * @returns 實際補了幾筆(0 = 全部都已是最新,沒發出請求)
 */
export async function ensureAssignmentDetails(assignmentIds: string[]): Promise<number> {
  const ids = [...new Set(assignmentIds.filter(Boolean))]
  if (ids.length === 0) return 0

  const local = await db.submissions.where('assignmentId').anyOf(ids).toArray()
  // 整份作業都沒有任何卷 → 可能是本機還沒同步到,仍要打一次(server 有就會帶回來)
  const staleAssignmentIds = new Set<string>(
    ids.filter((aid) => {
      const subs = local.filter((s) => s.assignmentId === aid)
      if (subs.length === 0) return true
      return subs.some((s) => !isHydrated(s))
    })
  )
  if (staleAssignmentIds.size === 0) return 0

  const rows = await fetchDetails({ assignmentIds: [...staleAssignmentIds] })
  await applyDetails(rows)
  return rows.length
}

/** 補齊指定的幾份卷(點開單卷 modal 用) */
export async function ensureSubmissionDetails(submissionIds: string[]): Promise<number> {
  const ids = [...new Set(submissionIds.filter(Boolean))]
  if (ids.length === 0) return 0

  const local = await db.submissions.bulkGet(ids)
  const stale = ids.filter((_id, i) => {
    const s = local[i]
    return !s || !isHydrated(s)
  })
  if (stale.length === 0) return 0

  const rows = await fetchDetails({ submissionIds: stale })
  await applyDetails(rows)
  return rows.length
}
