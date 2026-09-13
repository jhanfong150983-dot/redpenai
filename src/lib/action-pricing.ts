// 2026-08-04 固定扣除計費(client 側鏡像)。
// 2026-09-13 改「份」制(user 拍板、與 /pricing 同步):每批改成功一份扣 1，不分題數題型；
//   家長報告／訂正／自批 0。server/action-billing.js 是扣款權威，這裡只做事前文案。
// 開關:VITE_FLAT_BILLING='1'(編譯期;切換時 server 的 FLAT_BILLING 與此旗標要同時設)。

// 預設開(user 拍板);回退=VITE_FLAT_BILLING='0'(server 同步 FLAT_BILLING='0')
export const FLAT_BILLING = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_FLAT_BILLING !== '0'

/** 每份考卷扣幾份（=1）。保留簽名給舊呼叫點；題數不再影響價格。 */
export const SHEET_POINTS = 1
export function gradingActionPoints(_totalQuestions: number | undefined | null): number {
  return SHEET_POINTS
}

export const PARENT_REPORT_POINTS_PER_STUDENT = 0

/** 「30 份」——批改確認框的確定價文案 */
export function gradingPriceText(papers: number, _totalQuestions: number | undefined | null): string {
  return `${papers * SHEET_POINTS} 份`
}

/** 份制下與題型組成無關；保留簽名讓呼叫點不用改 */
export function gradingPriceTextSmart(papers: number, _answerKey: unknown, _classSize: number): string {
  return gradingPriceText(papers, null)
}

/** 老師的兩種墨水（/api/data/my-wallets） */
export type MyWallets = {
  personal: number
  campus: Array<{ schoolId: string; schoolName: string; balance: number }>
  applicable?: { scope: 'school' | 'campus' | 'personal'; schoolId: string | null; schoolName: string; campusBalance: number; personalBalance: number }
}
export async function fetchMyWallets(assignmentId?: string): Promise<MyWallets | null> {
  try {
    const q = assignmentId ? `?assignmentId=${encodeURIComponent(assignmentId)}` : ''
    const r = await fetch(`/api/data/my-wallets${q}`, { credentials: 'include' })
    if (!r.ok) return null
    return (await r.json()) as MyWallets
  } catch { return null }
}
