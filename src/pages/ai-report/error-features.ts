// 開放題錯誤特徵 AI 歸納（2026-07-16、user 拍板）：on-demand modal、跑過一次存 Dexie 快取隨開隨看。
// 設計：錯誤「特徵」統計（一個作答可計入多個特徵）而非硬分群；亂答獨立列；附檢討課重點兩句。
// 快取失效：以 n/對/錯 簽名比對，資料變了顯示「可重新分析」但仍給看舊結果。
import { db } from '@/lib/db'
import { getInkSessionId, startInkSession } from '@/lib/ink-session'
import type { ItemStat } from './item-analysis'

const GEMINI_PROXY_URL = import.meta.env.VITE_GEMINI_PROXY_URL || '/api/proxy'
const MODEL = 'gemini-3.5-flash'

export type ErrorFeature = {
  feature: string
  count: number
  examples: string[]
  note: string
  /** 深層歸因粗分類（按領域給選項、供跨題統計聚合；「其他」時看 causeDetail） */
  cause?: string
  /** 開放式歸因自述（cause=其他時必有；其餘情況為補充） */
  causeDetail?: string
}

/** 題幹裁圖來源（答案卷模板上該題的區域） */
export type StemSource = {
  templateId: string
  pageIndex: number
  bbox: { x: number; y: number; w: number; h: number }
}

export type ErrorFeaturesPayload = {
  features: ErrorFeature[]
  nonsense: string[]
  teachingFocus: string
}

export type ErrorFeaturesCacheEntry = {
  cacheKey: string
  assignmentId: string
  questionId: string
  signature: string
  payload: ErrorFeaturesPayload
  updatedAt: number
}

export function errorFeaturesCacheKey(assignmentId: string, questionId: string) {
  return `${assignmentId}::${questionId}`
}

export function errorFeaturesSignature(item: ItemStat) {
  return `${item.n}:${item.correctCount}:${item.wrongCount}`
}

export async function readErrorFeaturesCache(assignmentId: string, questionId: string): Promise<ErrorFeaturesCacheEntry | null> {
  try {
    const entry = await db.questionErrorFeaturesCache.get(errorFeaturesCacheKey(assignmentId, questionId))
    return entry ?? null
  } catch { return null }
}

let inkSessionPromise: Promise<string | null> | null = null
async function ensureInkSessionId() {
  const existing = getInkSessionId()
  if (existing) return existing
  if (!inkSessionPromise) {
    inkSessionPromise = startInkSession()
      .then((result) => result.sessionId)
      .catch((error) => { console.warn('建立墨水會話失敗', error); return null })
      .finally(() => { inkSessionPromise = null })
  }
  return inkSessionPromise
}

function buildPrompt(item: ItemStat, domain: string, gradeHint: string) {
  const wrongVariants = item.distribution
    .filter((o) => !o.isBlank && o.correctVotes < o.count)
    .map((o) => {
      const wrongTimes = o.count - o.correctVotes
      return wrongTimes > 1 ? `${o.label}（×${wrongTimes}）` : o.label
    })
  const blankTotal = item.blankCount + item.unrecognizableCount
  const causeTaxonomy = causeTaxonomyFor(domain || '')
  return `你是${gradeHint}${domain || ''}老師的教學助理。附上的是完整題本（多頁印刷題目）。
本題題號【${item.questionId}】、正解：「${item.keyAnswer}」——請先在題本中找到本題、讀懂它實際在考什麼，再依學生作答歸因。
⚠ 只依題本上實際印的題目判斷；切勿臆測題目情境（例如看到算式像某公式就自行假設題目主題）。若題本中找不到本題，就僅依作答與正解做保守歸因、不要腦補題目背景。
以下是全班 ${wrongVariants.length} 種「被判錯」的學生作答（×N 表示 N 份相同）：
${wrongVariants.map((w, i) => `${i + 1}. ${w}`).join('\n')}
${blankTotal > 0 ? `另有 ${blankTotal} 人未作答。` : ''}

請做「錯誤特徵統計」：找出出現頻率高的錯誤特徵（同一個作答可以同時計入多個特徵），每個特徵回報：
- feature: 特徵名稱（中文、老師秒懂的說法）
- count: 有此特徵的作答數
- examples: 最多 2 個代表例（原文節錄）
- note: 一句話教學提示
- cause: 深層歸因分類——優先從下列分類選最貼近的一個（供跨題統計聚合用）：
${causeTaxonomy}
  真的都不貼近才用「其他」、並在 causeDetail 用一句話自述你的歸因；證據不足填「無法判斷」。
- causeDetail: 選填。cause=其他時必填自述；其他情況可補充更精確的歸因描述（如「受中文語序影響的詞序錯誤」）。
⚠ 歸因鐵則：只根據作答內容與題目要求歸因；「不專心、態度差、能力低」這類跨題行為從單一題看不出來、一律不得使用。
只列 count≥2 的特徵、按 count 由多到少排序；「內容明顯不成句/亂答」的作答不計入特徵、單獨列在 nonsense。
最後給 teachingFocus：給老師的 2 句檢討課重點。
只輸出 JSON：{"features":[{"feature":"...","count":0,"examples":["..."],"note":"...","cause":"...","causeDetail":"..."}],"nonsense":["..."],"teachingFocus":"..."}`
}

// 歸因分類按領域給（粗分類供統計聚合；AI 的細緻歸因在 feature/note/causeDetail 自由發揮）
function causeTaxonomyFor(domain: string): string {
  if (domain.includes('數學')) {
    return '「概念未學會／公式或規則誤用／計算失誤／題意理解錯誤／單位或量感不熟／抄寫粗心／其他／無法判斷」'
  }
  if (domain.includes('英語')) {
    return '「單字不熟／文法規則未掌握／拼字錯誤／題意理解錯誤／中文直譯影響／抄寫粗心／其他／無法判斷」'
  }
  if (domain.includes('社會') || domain.includes('自然')) {
    return '「概念混淆／知識未記熟／題意理解錯誤（含負向題型陷阱）／表達不完整／抄寫粗心／其他／無法判斷」'
  }
  return '「概念未學會／規則未掌握／題意理解錯誤／記憶不熟／抄寫粗心／其他／無法判斷」'
}

export async function generateErrorFeatures(
  assignmentId: string,
  item: ItemStat,
  domain: string,
  _stemSource: StemSource | null = null, // 保留位置（呼叫端仍傳）；改餵題本後不再用答案卷裁圖
  gradeHint = '國小'
): Promise<ErrorFeaturesPayload> {
  const inkSessionId = await ensureInkSessionId()
  // 2026-07-20 改餵「題本」而非答案卷裁圖：answer_only 卷的答案卷沒印題目，
  //   原本裁的「題幹帶」其實只有答案框 → AI 腦補題意（看到 2(x+x) 猜成周長）。
  //   改成 server 端依 assignmentId 注入題本圖（全部頁、AI 自己找本題），client 不再送誤導的答案卷裁圖。
  const parts = [{ text: buildPrompt(item, domain, gradeHint) }]
  const response = await fetch(GEMINI_PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      model: MODEL,
      contents: [{ role: 'user', parts }],
      routeKey: 'report.question_error_features',
      assignmentId,
      ...(inkSessionId ? { inkSessionId } : {})
    })
  })
  let data: unknown = null
  try { data = await response.json() } catch { data = {} }
  if (!response.ok) {
    const msg = (data as { error?: string } | null)?.error || `AI 服務回應 ${response.status}`
    throw new Error(msg)
  }
  const text = ((data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })?.candidates ?? [])
    .flatMap((c) => c?.content?.parts ?? [])
    .map((p) => (typeof p?.text === 'string' ? p.text : ''))
    .join('')
    .trim()
  if (!text) throw new Error('AI 回應為空、請再試一次')
  const parsed = JSON.parse(text.replace(/```json|```/g, '').trim()) as ErrorFeaturesPayload
  if (!Array.isArray(parsed?.features)) throw new Error('AI 回應格式不符、請再試一次')
  const payload: ErrorFeaturesPayload = {
    features: parsed.features
      .filter((f) => f && typeof f.feature === 'string')
      .map((f) => ({
        feature: String(f.feature),
        count: Number(f.count) || 0,
        examples: Array.isArray(f.examples) ? f.examples.map(String).slice(0, 2) : [],
        note: String(f.note ?? ''),
        cause: f.cause ? String(f.cause) : undefined,
        causeDetail: f.causeDetail ? String(f.causeDetail) : undefined
      })),
    nonsense: Array.isArray(parsed.nonsense) ? parsed.nonsense.map(String) : [],
    teachingFocus: String(parsed.teachingFocus ?? '')
  }
  const entry: ErrorFeaturesCacheEntry = {
    cacheKey: errorFeaturesCacheKey(assignmentId, item.questionId),
    assignmentId,
    questionId: item.questionId,
    signature: errorFeaturesSignature(item),
    payload,
    updatedAt: Date.now()
  }
  try { await db.questionErrorFeaturesCache.put(entry) } catch (e) { console.warn('錯誤特徵快取寫入失敗', e) }
  return payload
}
