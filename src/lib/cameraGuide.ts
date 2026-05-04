/**
 * cameraGuide.ts
 *
 * 學生端相機引導框的共用常數。
 * 同時被 CameraGuideOverlay（畫框）和 photoValidation（驗證紙張是否在框內）使用。
 *
 * 座標為 normalized（0-1），相對螢幕寬高。
 */

// 引導框邊距（normalized 0-1，相對螢幕）
export const CAMERA_FRAME = {
  LEFT: 0.03,
  RIGHT: 0.03,
  TOP: 0.05,
  BOTTOM: 0.14,
} as const

// 「四角是否在框內」驗證的容許溢出（5% 螢幕寬高）
// AI 偵測四角本來就有誤差，太嚴格會誤殺貼框拍的好照片。
export const FRAME_TOLERANCE = 0.05

// 紙張面積佔整張圖比例的最低門檻
// 低於此值代表學生拍太遠，校正後解析度不足。
export const MIN_PAPER_AREA_RATIO = 0.25

// pHash 重複判斷的 Hamming distance 閾值
// 64-bit hash，距離 < 此值視為重複照片。
export const DUPLICATE_HASH_THRESHOLD = 8
