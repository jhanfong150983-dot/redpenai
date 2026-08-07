// 2026-08-07 大題彙總與評量向度（純規則、零 AI）。
//
// 訊號來源：答案卷每題的 `anchorHint` 存了大題標題原文（實測格式：「位於『一、國字注音』表格第 1 格」），
//   題號 `1-1-3` 是「頁-大題-小題」→ 大題分組本來就在資料裡，只是從來沒用過。
//
// 兩層產出：
//   ① sectionKey / sectionTitle —— 全科都能用（每份卷都有大題），試題分析的「大題彙總」靠這個
//   ② dimension（評量向度）—— 目前只有國語有可靠的關鍵字對應表（大題標題是慣用語）。
//      向度的價值在「跨卷穩定」：大題名稱每次段考都不同，向度不會 → 之後要做跨次趨勢聚合用這一層。
//
// ⛔ 設計原則：**判不出來就不標**（回 null，UI 顯示「未分類」）。寧可少標，不可亂標——
//    「四、選擇題」這種通用標題無法判定考什麼能力，硬歸類會汙染跨卷趨勢。

/** 從 anchorHint 取大題標題（『』內原文）；取不到回 null */
export function sectionTitleOf(anchorHint?: string | null): string | null {
  const m = String(anchorHint ?? '').match(/『(.+?)』/)
  const t = m?.[1]?.trim()
  return t || null
}

/** 題號 → 大題鍵（1-3-7 → "1-3"）；格式不符回題號本身 */
export function sectionKeyOf(questionId: string): string {
  const parts = String(questionId).split('-')
  return parts.length >= 2 ? parts.slice(0, 2).join('-') : String(questionId)
}

/**
 * 國語文評量向度（縣市學生學習能力檢測 115 年度公告的十向度）。
 * 對應規則＝大題標題關鍵字；順序有意義（先比對特徵強的）。
 */
const GUOYU_RULES: Array<{ re: RegExp; dim: string }> = [
  { re: /國字|注音|字音|字形|寫出.*字|改錯字|錯別字/, dim: '形音知識' },
  { re: /修辭/, dim: '修辭知識' },
  { re: /語法|文法|句型|標點|詞性|病句|語詞結構|複句/, dim: '語法知識' },
  { re: /文體|體裁/, dim: '文體知識' },
  { re: /章法|篇章結構|文章組織|段落安排/, dim: '章法知識' },
  { re: /注釋|解釋|詞語|語詞|字詞|成語|詞義|字義/, dim: '字詞知識' },
  { re: /閱讀|題組|短文|文章|篇章|語譯|翻譯/, dim: '篇章理解' },
]

/** 各科的向度值域（UI 排序用；未列的科目目前不做向度分類） */
export const DIMENSION_ORDER: Record<string, string[]> = {
  國語: ['形音知識', '字詞知識', '語法知識', '修辭知識', '章法知識', '文體知識', '字詞理解', '句子理解', '段落理解', '篇章理解'],
}

/** 這個科目目前是否支援向度分類 */
export function supportsDimension(domain?: string | null): boolean {
  return /國語|國文/.test(String(domain ?? ''))
}

/**
 * 由「科目＋大題標題」推向度。判不出來回 null（UI 歸「未分類」）。
 * ⚠ 只吃大題標題，不吃題幹——答案卷沒有存題幹文字。
 */
export function deriveDimension(domain: string | null | undefined, sectionTitle: string | null | undefined): string | null {
  if (!supportsDimension(domain)) return null
  const t = String(sectionTitle ?? '').trim()
  if (!t) return null
  for (const r of GUOYU_RULES) if (r.re.test(t)) return r.dim
  return null // 「四、選擇題」這類通用標題→ 不標
}
