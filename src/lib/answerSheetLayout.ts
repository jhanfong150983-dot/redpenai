// 2026-08-29 公版答案卷標頭幾何常數（version RPOMR1）。
//   來源：公版範本標頭圖的設計座標（scratchpad header.mjs 同步產出），
//   ⛔ 改標頭圖版面時必須同步改這裡並升 version——這是座號辨識（塗卡判讀）的基準。
//   座標系：以「四個角標的外接矩形」為框，u=x/寬、v=y/高（0~1）。
//   辨識流程（第 3 期）：找四角標 → 透視校正到此座標系 → 取各圓格填墨比例 → 十位/個位各取最深者。

export const ANSWER_SHEET_LAYOUT_VERSION = 'RPOMR1'

export interface BubbleSpot {
  digit: number
  u: number
  v: number
}

/** 標頭實體尺寸（mm），供 DPI 推算與 sanity check */
export const HEADER_SIZE_MM = { width: 174, height: 34 }
/** 角標邊長（mm） */
export const ANCHOR_SIZE_MM = 5

/** 塗卡圓半徑（正規化；u/v 方向不同因為框非正方形） */
export const BUBBLE_RADIUS = { u: 2.3 / 174, v: 2.3 / 34 }

const row = (v: number): BubbleSpot[] =>
  Array.from({ length: 10 }, (_, digit) => ({
    digit,
    u: (106.5 + digit * 6) / 174,
    v
  }))

/** 十位排（0~9）圓心 */
export const TENS_BUBBLES: BubbleSpot[] = row(12 / 34)
/** 個位排（0~9）圓心 */
export const ONES_BUBBLES: BubbleSpot[] = row(21 / 34)

/** 手寫座號兩格（老師確認畫面裁圖用） */
export const HANDWRITTEN_BOXES = [
  { u: 76 / 174, v: 9 / 34, w: 9 / 174, h: 12 / 34 },
  { u: 86.5 / 174, v: 9 / 34, w: 9 / 174, h: 12 / 34 }
]
