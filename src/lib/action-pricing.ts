// 2026-08-04 固定扣除計費(client 側鏡像)。
// ⚠ 級距表必須與 server/action-billing.js 一致——server 是扣款權威,這裡只做「事前確定價顯示」。
// 開關:VITE_FLAT_BILLING='1'(編譯期;切換時 server 的 FLAT_BILLING 與此旗標要同時設,
//   否則顯示與實扣不一致)。未開=confirm 維持舊文案、完成通知不顯示扣點。

export const FLAT_BILLING = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_FLAT_BILLING === '1'

/** 題數級距(定價報表 2026-08 定案):≤20→5、21~40→10、41~60→15、61+→20;未知題數保守當 10 */
export function gradingActionPoints(totalQuestions: number | undefined | null): number {
  const n = Number(totalQuestions) || 0
  if (n <= 0) return 10
  if (n <= 20) return 5
  if (n <= 40) return 10
  if (n <= 60) return 15
  return 20
}

export const PARENT_REPORT_POINTS_PER_STUDENT = 2

/** 「30 份 × 15 點 = 450 點」——批改確認框的確定價文案 */
export function gradingPriceText(papers: number, totalQuestions: number | undefined | null): string {
  const per = gradingActionPoints(totalQuestions)
  return `${papers} 份 × ${per} 點 = ${papers * per} 點`
}
