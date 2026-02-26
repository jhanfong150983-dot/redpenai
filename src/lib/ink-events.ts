export const INK_BALANCE_EVENT = 'rp-ink-balance'

export type InkBalanceDetail = {
  inkBalance: number
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
