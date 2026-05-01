/**
 * 是否應該自動 focus 表單輸入。
 * 桌面（mouse 為主）回 true，行動裝置（觸控為主）回 false 避免虛擬鍵盤遮畫面。
 *
 * 偵測邏輯：透過 `pointer: coarse` media query 判斷觸控為主裝置（手機/平板）。
 *
 * 使用方式：
 *   <input autoFocus={shouldAutoFocusOnDesktop()} />
 *   <input autoFocus={mode === 'create' && shouldAutoFocusOnDesktop()} />
 */
export function shouldAutoFocusOnDesktop(): boolean {
  if (typeof window === 'undefined') return false
  // pointer: coarse → 觸控為主（手機 / 平板），跳過 auto focus
  return !window.matchMedia?.('(pointer: coarse)').matches
}
