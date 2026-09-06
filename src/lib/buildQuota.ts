// 建卷週次數上限（前端查詢）。後端權威在 redpenaisever/server/build-quota.js。
//   建卷/解析免費，但每個 AI run 都燒成本 → 每週一台灣時區歸零的次數上限，擋 bug/濫用。
//   用途：在「重新解析／擷取答案」等會消耗一次的確認框裡，顯示本週剩餘次數。

export type BuildQuota = {
  used: number
  cap: number | null // unlimited 時為 null
  remaining: number | null
  isSchoolAdmin: boolean
  unlimited: boolean
}

/** 查本週建卷額度；查不到（未登入/離線/後端錯）回 null，呼叫端自行決定不擋。 */
export async function fetchBuildQuota(): Promise<BuildQuota | null> {
  try {
    const res = await fetch('/api/data/build-quota', { credentials: 'include' })
    if (!res.ok) return null
    const json = (await res.json().catch(() => null)) as BuildQuota | null
    if (!json || typeof json.unlimited !== 'boolean') return null
    return json
  } catch {
    return null
  }
}

/** 組一行給確認框用的剩餘次數提示；unlimited / 查不到 → 空字串（不顯示）。 */
export function buildQuotaLine(q: BuildQuota | null): string {
  if (!q || q.unlimited || q.remaining == null || q.cap == null) return ''
  return `本週建卷額度：剩餘 ${q.remaining} / ${q.cap} 次（每週一自動重置）`
}
