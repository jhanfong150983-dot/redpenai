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
// 2026-05-13 調整：實際部署後發現大量學生（含正常拍）被擋下、推測平板/手機端
// 經透視校正 + JPEG/WebP 壓縮後寬度比預期低、原本 1000 太緊。
// 暫時 BLOCK=0 = 不擋任何照片、只用 WARN 提示學生「可能模糊」、讓老師端收件後檢視。
// 等收集到「真實 production 寬度分布」+「成功/失敗 OCR 案例」資料、再決定要不要重設 BLOCK。
//
// 歷史閾值規劃（先記著、未來調回時參考）：
// - 1500 = OCR 穩定門檻
// - 1000 = OCR 開始掉 row 臨界
// - 800  = 720p 視訊串流上限、再低 OCR 大致全廢
export const MIN_EFFECTIVE_WIDTH_BLOCK = 0     // 暫時關閉硬擋、避免誤殺
export const MIN_EFFECTIVE_WIDTH_WARN = 1200   // 警告閾值放寬到 1200、讓警告不要太常跳
