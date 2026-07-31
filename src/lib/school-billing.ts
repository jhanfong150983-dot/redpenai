// 2026-07-31 學校計費 context(user 拍板:行政端的 AI 一律扣學校錢包、教師端扣個人)。
// SchoolAdminPanel 掛載時設定學校 id、卸載時清除;生效期間:
//  1. gemini.ts 的 proxy 請求自動掛 x-school-billing header(server 驗證行政身分後改扣學校錢包)
//  2. ink-session.ts 跳過個人批改會話(不檢查個人餘額、不建 session)
// 行政端是全螢幕頁面,不會與教師端流程同時執行,module-level context 安全。

let schoolBillingId: string | null = null

export function setSchoolBillingContext(schoolId: string | null): void {
  schoolBillingId = schoolId
}

export function getSchoolBillingContext(): string | null {
  return schoolBillingId
}

// 即時學校餘額廣播:proxy 每次學校計費回應帶 ink.balanceAfter → gemini.ts 廣播、
// SchoolAdminPanel 監聽更新 header 點數(批改當下逐卷跳動,不用重新整理)
export const SCHOOL_WALLET_EVENT = 'school-wallet-balance'

export function dispatchSchoolWalletBalance(balance: number): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(SCHOOL_WALLET_EVENT, { detail: { balance } }))
}
