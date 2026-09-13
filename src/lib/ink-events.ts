export const INK_BALANCE_EVENT = 'rp-ink-balance'

export type InkBalanceDetail = {
  inkBalance: number
}

// 2026-09-13 份制：校園墨水（學校配發、只能用在該校班級）餘額事件；App 頂欄與批改頁監聽
export const CAMPUS_BALANCE_EVENT = 'rp-campus-balance'
export type CampusBalanceDetail = { schoolId: string | null; balance: number }
export function dispatchCampusBalance(detail: CampusBalanceDetail) {
  if (typeof window === 'undefined' || !Number.isFinite(detail.balance)) return
  window.dispatchEvent(new CustomEvent<CampusBalanceDetail>(CAMPUS_BALANCE_EVENT, { detail }))
}

export function dispatchInkBalance(inkBalance: number) {
  if (typeof window === 'undefined') return
  if (!Number.isFinite(inkBalance)) return
  console.log('[ink-events] 派發墨水餘額事件:', inkBalance)
  window.dispatchEvent(
    new CustomEvent<InkBalanceDetail>(INK_BALANCE_EVENT, {
      detail: { inkBalance }
    })
  )
}
