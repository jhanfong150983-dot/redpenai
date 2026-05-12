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
// 8 太嚴擋不住「同一頁拍兩次但角度/光線略差」的 case；
// 12 容忍 ~19% bit 差異，仍能避開「同習作不同題目」的誤殺。
export const DUPLICATE_HASH_THRESHOLD = 12

// 裁切後（cropToCornersBounds 之後）worksheet 區域的最低像素寬度。
// 低於 BLOCK_PX 拒絕上傳、BLOCK_PX~WARN_PX 之間給黃色警告但允許繼續。
//
// 為什麼這數字：
// - A4 短邊 21cm；1500px wide ≈ 180 dpi，PaddleOCR 中文小字穩定區
// - 實證社會 1 號 1344 wide 9/9 命中；數練 643 wide 7/9（OCR 漏抓 row）
// - 1000 是「OCR 開始掉 row」的臨界、設為 block 下限
// - 1500 是「OCR 穩定」的下限、設為 warn → ok 邊界
// 任何學生機（≥ 4MP）裁完背景剩下的 worksheet 區域都該 ≥ 1500、實務上幾乎不會擋到。
export const MIN_EFFECTIVE_WIDTH_BLOCK = 1000
export const MIN_EFFECTIVE_WIDTH_WARN = 1500
