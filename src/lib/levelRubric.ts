/**
 * 級分制（數學應用題）的分數換算與正規化。
 *
 * 設計鐵則（沿用既有原則，勿改）：
 *  1. **AI 只判級分，分數一律由 code 算**。AI 不得回傳分數。
 *  2. 級分是整題一個等第，**不是逐要素加分**——改成加分制，「湊對答案就拿分」會原地復活。
 *  3. 老師調整的是「每級幾分」這四個數字，不是百分比（老師想的是「這題 5 分，寫得不錯給幾分」）。
 *
 * 沙盒依據：local-only/math-rubric-sandbox（21 份會考公告樣卷，附官方級分）。
 */
import type { LevelRubric, LevelRubricLevel } from './db'

/** user 拍板的預設比例；「只有答案」預設落在 1 級分（30%）而非 0 分，老師可自行調回 0。 */
export const LEVEL_RATIO: Record<number, number> = { 3: 1, 2: 0.65, 1: 0.3, 0: 0 }

export const LEVEL_LABELS: Record<number, string> = {
  3: '三級分',
  2: '二級分',
  1: '一級分',
  0: '零級分',
}

/** 四捨五入到 0.5：3.25 分在段考現實裡不好用，落到 3.5。 */
export const roundToHalf = (n: number): number => Math.round(n * 2) / 2

/**
 * 依題目配分產生四個級分的預設分數。
 * 例：maxScore=5 → 5 / 3.5 / 1.5 / 0；maxScore=12 → 12 / 8 / 3.5 / 0。
 */
export function buildLevelScores(maxScore: number): Record<number, number> {
  const full = Math.max(0, maxScore || 0)
  const out: Record<number, number> = {}
  for (const lv of [3, 2, 1, 0]) {
    out[lv] = lv === 3 ? full : roundToHalf(full * LEVEL_RATIO[lv])
  }
  return out
}

/**
 * 把 AI 擷取出的級分規準正規化：補齊四個級分、灌入 code 算的分數、保證單調遞減。
 * AI 若回傳了 score 一律忽略（鐵則 1）。
 */
export function normalizeLevelRubric(
  raw: Partial<LevelRubric> | null | undefined,
  maxScore: number,
): LevelRubric | undefined {
  if (!raw || !Array.isArray(raw.requiredElements) || raw.requiredElements.length === 0) return undefined

  const defaults = buildLevelScores(maxScore)
  const byLevel = new Map<number, string>()
  for (const lv of raw.levels ?? []) {
    const n = Number((lv as LevelRubricLevel)?.level)
    if ([0, 1, 2, 3].includes(n)) byLevel.set(n, String((lv as LevelRubricLevel)?.criteria ?? '').trim())
  }

  const levels: LevelRubricLevel[] = [3, 2, 1, 0].map((lv) => ({
    level: lv as 3 | 2 | 1 | 0,
    criteria: byLevel.get(lv) ?? '',
    score: defaults[lv],
  }))

  return {
    requiredElements: raw.requiredElements
      .map((e, i) => ({ key: String(e?.key || `E${i + 1}`), desc: String(e?.desc ?? '').trim() }))
      .filter((e) => e.desc),
    alternativeGroups: (raw.alternativeGroups ?? [])
      .map((g, i) => ({
        key: String(g?.key || `G${i + 1}`),
        desc: String(g?.desc ?? '').trim(),
        options: (g?.options ?? [])
          .map((o, j) => ({ key: String(o?.key || `${i + 1}-${j + 1}`), desc: String(o?.desc ?? '').trim() }))
          .filter((o) => o.desc),
      }))
      // 只有一個選項的「替代組」沒有意義（沒得替代），併回必要要素比較誠實
      .filter((g) => g.options.length >= 2),
    toleratedFlaws: (raw.toleratedFlaws ?? []).map((t) => String(t ?? '').trim()).filter(Boolean),
    levels,
  }
}

/** 級分 → 分數。找不到就退回 0，不猜。 */
export function levelToScore(rubric: LevelRubric | undefined, level: number | null | undefined): number {
  if (!rubric || level == null) return 0
  return rubric.levels.find((l) => l.level === level)?.score ?? 0
}

/**
 * 題目配分被老師改動時，重算各級分數——但**只動老師沒手改過的那幾格**。
 * 判斷方式：現值等於舊配分算出來的預設值 → 視為沒改過。
 */
export function rescaleLevelScores(rubric: LevelRubric, oldMax: number, newMax: number): LevelRubric {
  const oldDefaults = buildLevelScores(oldMax)
  const newDefaults = buildLevelScores(newMax)
  return {
    ...rubric,
    levels: rubric.levels.map((l) => ({
      ...l,
      score: l.score === oldDefaults[l.level] ? newDefaults[l.level] : l.score,
    })),
  }
}
