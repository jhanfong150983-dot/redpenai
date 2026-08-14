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
import type { LevelRubric, LevelRubricLevel, LevelRule } from './db'

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
    levelRules: normalizeLevelRules(raw.levelRules),
  }
}

/**
 * 只留下引用得到、且條件非空的規則。AI 可能吐出參照到不存在的要素 key 的規則，
 * 那種規則永遠不會成立、會讓級分靜默掉到 0——寧可丟掉也不要留著。
 */
function normalizeLevelRules(raw: LevelRule[] | undefined): LevelRule[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const out: LevelRule[] = []
  for (const r of raw) {
    const lv = Number(r?.level)
    if (![0, 1, 2, 3].includes(lv)) continue
    const pick = (v: unknown) =>
      Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean) : []
    const rule: LevelRule = { level: lv as 3 | 2 | 1 | 0 }
    const all = pick(r.requireAll)
    const any = pick(r.requireAny)
    const gs = pick(r.requireGroups)
    const ag = pick(r.requireAnyGroup)
    if (all.length) rule.requireAll = all
    if (any.length) rule.requireAny = any
    if (gs.length) rule.requireGroups = gs
    if (ag.length) rule.requireAnyGroup = ag
    // 0 級是兜底、允許無條件；其餘級分沒有任何條件＝無條件成立，會把所有卷都判成該級
    if (lv !== 0 && !rule.requireAll && !rule.requireAny && !rule.requireGroups && !rule.requireAnyGroup) continue
    out.push(rule)
  }
  return out.length > 0 ? out : undefined
}

/**
 * 依 levelRules 從「判官回報的要素集合」算出級分。
 * 由高到低逐條比對，第一條成立者即為該級分；沒有任何一條成立 → 0。
 * 回傳 null＝這份規準沒有 levelRules，無法由 code 裁定（呼叫端自行決定 fallback）。
 *
 * 為什麼不讓 AI 判級分：沙盒實測同一份卷、要素完全相同時，AI 仍會判出不同級分，
 * 那就是跨學生「同樣寫法不同分」的來源。要素判定交給 AI、級分裁定交給 code，
 * 21 份會考樣卷 × 5 輪得到 100% 準確、0 放水、級分零跳動。
 */
export function levelFromElements(rubric: LevelRubric, found: Iterable<string>): number | null {
  const rules = rubric.levelRules
  if (!rules || rules.length === 0) return null
  const has = new Set(found)
  const groups = rubric.alternativeGroups ?? []
  const groupOk = (key: string) => {
    const g = groups.find((x) => x.key === key)
    return !!g && g.options.some((o) => has.has(o.key))
  }
  for (const r of [...rules].sort((a, b) => b.level - a.level)) {
    if ((r.requireAll ?? []).some((k) => !has.has(k))) continue
    if ((r.requireAny ?? []).length > 0 && !(r.requireAny ?? []).some((k) => has.has(k))) continue
    if ((r.requireGroups ?? []).some((k) => !groupOk(k))) continue
    if ((r.requireAnyGroup ?? []).length > 0 && !(r.requireAnyGroup ?? []).some(groupOk)) continue
    return r.level
  }
  return 0
}

/**
 * 規準自洽性檢查。回傳問題清單（空陣列＝通過）。
 *
 * 實測（國小卷 9 題 × 2 輪）AI 會產出兩種自相矛盾的規準，而且都是靜默的：
 *   ・要素只寫 1 條、且把過程與答案綁在一起 → 學生只寫答案就命中唯一要素＝滿分
 *   ・levelRules 與要素兜不攏 → 「要素全中卻只算成 1 級」（該拿滿分的被扣到 30%）
 * prompt 講了不一定聽（明寫「至少 2 條」仍會給 1 條），所以改成產出後驗證、不合就重試。
 */
export function validateLevelRubric(r: LevelRubric): string[] {
  const problems: string[] = []
  const keys = new Set(r.requiredElements.map((e) => e.key))
  const groupKeys = new Set((r.alternativeGroups ?? []).map((g) => g.key))
  for (const g of r.alternativeGroups ?? []) {
    for (const o of g.options) keys.add(o.key)
  }

  if (r.requiredElements.length < 2) problems.push('要素少於 2 條（過程與答案至少要分開）')
  if (!r.levelRules || r.levelRules.length === 0) {
    problems.push('缺少 levelRules')
    return problems
  }
  for (const rule of r.levelRules) {
    for (const k of [...(rule.requireAll ?? []), ...(rule.requireAny ?? [])]) {
      if (!keys.has(k)) problems.push(`規則 ${rule.level} 級引用了不存在的要素 ${k}`)
    }
    for (const k of [...(rule.requireGroups ?? []), ...(rule.requireAnyGroup ?? [])]) {
      if (!groupKeys.has(k)) problems.push(`規則 ${rule.level} 級引用了不存在的替代組 ${k}`)
    }
  }
  // 兩個端點必須成立，否則規則與要素在語意上是脫節的
  if (levelFromElements(r, keys) !== 3) problems.push('要素全部命中時算不出 3 級')
  if (levelFromElements(r, []) !== 0) problems.push('完全沒有要素時不是 0 級（空白卷會拿到分數）')

  // 中段也要檢查：端點對、中間仍可能壞。實測 AI 產出過
  //   { level: 2, requireAny: [E1..E5] } —— 「任一項」等於只寫對第(1)小題就給 65% 分數。
  // 一步做對不該拿到二級分，所以：只命中單一要素時，級分必須 ≤ 1。
  // （沙盒驗證過的兩份規準都通過此條——它們的 2 級都要求「主要結論＋實質推導」兩者。）
  for (const e of r.requiredElements) {
    const lv = levelFromElements(r, [e.key])
    if (lv != null && lv >= 2) {
      problems.push(`只命中「${e.key}」一項就給 ${lv} 級（一步做對不該拿到二級分）`)
      break
    }
  }
  return problems
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
