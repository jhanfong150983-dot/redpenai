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

// 「四角是否在框內」驗證的容許溢出（10% 螢幕寬高）
// AI 偵測四角本來就有誤差、太嚴格會誤殺貼框拍的好照片。
//
// 2026-05-13 調整：原本 0.05 太緊、學生橫式拍把書填滿整個畫面（連底部 UI 區
// 都蓋住、底邊 y≈0.93、超過 maxY=0.91）就被誤判 out_of_frame。
// 放寬到 0.10 後接得住「填滿畫面」這種合理拍法。
// 真正紙張超出畫面的 case 仍由 cropped_by_camera（EDGE=0.001）守住。
export const FRAME_TOLERANCE = 0.10

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
// 2026-05-13 重新校準：原本的 1000/1500 是<b>以相機畫面整體當分母</b>算的、忽略了
// 學生實際對齊的是「引導框」而非整個畫面。引導框因 aspect ratio mismatch + object-cover
// 顯示、實際只佔相機畫面 55-67% 左右。所以一個完美對齊引導框的學生、裁切後寬度
// 也只有 ~1056 px、會被原本 1500 WARN 誤判為「模糊」。
//
// 重新校準的對應表（以「裁切後寬度」對應「對齊狀況」）：
// - >= 1000 → 對齊極好（罕見）
// - 700~999 → 對齊良好、正常水準
// - 500~699 → 拍遠了 / 沒貼框、值得提醒重拍
// - < 500   → 拍超遠 / 紙張很小、強烈建議重拍
//
// 為避免誤殺、不擋任何照片（BLOCK=0）。
// WARN=700 = 對齊不佳才警告、正常對齊不打擾。
export const MIN_EFFECTIVE_WIDTH_BLOCK = 0     // 不擋
export const MIN_EFFECTIVE_WIDTH_WARN = 700    // 對齊不佳才警告
