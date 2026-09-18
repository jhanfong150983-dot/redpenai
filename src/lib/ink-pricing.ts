// 個人版份數定價（鏡像 redpenaisever/server/ink-pricing.js；server 是權威，這裡只做顯示與試算）。
//   2026-09-18 user 拍板：砍會員／等級、每份固定 NT$5、優惠只用禮包送份數、份數永不過期。
export const INK_UNIT_PRICE_TWD = 5
export const CUSTOM_UNITS_MIN = 1
export const CUSTOM_UNITS_MAX = 5000
/** 自訂份數達此數時提示改買禮包（禮包最小 300 份） */
export const CUSTOM_SUGGEST_PACK_AT = 300
export const CUSTOM_QUICK_PICKS = [50, 100, 200]

export const inkAmountTwd = (units: number): number => (Number.isFinite(units) && units > 0 ? Math.round(units) * INK_UNIT_PRICE_TWD : 0)
/** 相當於每份（含贈送）；小數兩位 */
export const effectivePerUnit = (units: number, bonus: number): string => {
  const total = units + Math.max(0, bonus)
  if (!units || !total) return INK_UNIT_PRICE_TWD.toFixed(2)
  return (inkAmountTwd(units) / total).toFixed(2)
}
export const formatTwd = (n: number): string => `NT$${Math.round(n).toLocaleString('zh-TW')}`
