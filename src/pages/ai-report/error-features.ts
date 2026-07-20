// 開放題錯誤特徵 AI 歸納（2026-07-16、user 拍板）：on-demand modal、跑過一次存 Dexie 快取隨開隨看。
// 設計：錯誤「特徵」統計（一個作答可計入多個特徵）而非硬分群；亂答獨立列；附檢討課重點兩句。
// 快取失效：以 n/對/錯 簽名比對，資料變了顯示「可重新分析」但仍給看舊結果。
import { db } from '@/lib/db'
import { ensureInkSessionFresh } from '@/lib/ink-session'
import { isImageAnswerItem } from './item-analysis'
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

// 2026-07-20 改用 ensureInkSessionFresh：原本直接沿用 getInkSessionId()、不檢查過期，
//   會話過期後仍送舊 id → proxy 回「批改會話已過期」。fresh 版會在過期/剩<60s 時自動續期。
async function ensureInkSessionId(): Promise<string | null> {
  try { const { sessionId } = await ensureInkSessionFresh(); return sessionId }
  catch (error) { console.warn('建立墨水會話失敗', error); return null }
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

// 圖上作答題：抓「答錯學生」在本題的實際作答圖（server 端切、上限 24 位）。
async function fetchWrongCrops(assignmentId: string, questionId: string): Promise<string[]> {
  try {
    const res = await fetch('/api/report/question-crops', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ assignmentId, questionId }),
    })
    if (!res.ok) return []
    const data = (await res.json().catch(() => null)) as { crops?: Array<{ dataUrl?: string }> } | null
    return (data?.crops ?? []).map((c) => c?.dataUrl ?? '').filter(Boolean)
  } catch { return [] }
}

// 圖上作答題的 prompt：看「答錯學生作答圖」+ 題本歸納錯誤樣態（輸出結構同文字版）。
function buildImagePrompt(item: ItemStat, domain: string, gradeHint: string, cropCount: number): string {
  const blankTotal = item.blankCount + item.unrecognizableCount
  const wrongTotal = Math.max(0, item.n - item.correctCount - blankTotal)
  const causeTaxonomy = causeTaxonomyFor(domain || '')
  return `你是${gradeHint}${domain || ''}老師的教學助理。這是一題「圖上作答」的計算／作圖題。
附上：① 完整題本（多頁印刷題目）② 本題【${item.questionId}】共 ${cropCount} 位答錯學生的實際作答圖（手寫／作圖）。正解：「${item.keyAnswer}」。
請先在題本中找到本題、讀懂它要學生畫／算什麼；再逐一看這些學生的作答圖，歸納「錯誤樣態」——找出重複出現的畫錯／算錯型態（同一張圖可同時計入多個特徵）。
⚠ 只依題本實印題目與作答圖判斷、切勿臆測；看不清的圖不強行歸類。
⚠ 這些作答圖是「匿名」的，你無法得知是哪位學生——**所有描述與 examples 一律不得指名或編造「學生1/學生2」「座號N」這類身分**（會誤導老師），只描述錯誤型態本身。
每個特徵回報：feature（特徵名稱、老師秒懂）、count（有此特徵的作答數）、examples（最多 2 個，只描述圖上看到的錯法本身、不提是誰，如「三視圖只畫正視圖、漏側視圖」）、note（一句教學提示）、cause（從「${causeTaxonomy}」選最貼近的一個；都不貼近才用「其他」並填 causeDetail；證據不足填「無法判斷」）、causeDetail（選填）。
⚠ 歸因鐵則：只根據作答與題目要求；「不專心、態度差」這類跨題行為不得使用。
只列 count≥2 的特徵、按 count 由多到少排序；亂畫／空白不計入特徵、單獨列在 nonsense。最後給 teachingFocus（2 句檢討課重點）。共 ${wrongTotal} 位答錯（附圖 ${cropCount} 位）。
只輸出 JSON：{"features":[{"feature":"...","count":0,"examples":["..."],"note":"...","cause":"...","causeDetail":"..."}],"nonsense":["..."],"teachingFocus":"..."}`
}

export async function generateErrorFeatures(
  assignmentId: string,
  item: ItemStat,
  domain: string,
  _stemSource: StemSource | null = null, // 保留位置（呼叫端仍傳）；改餵題本後不再用答案卷裁圖
  gradeHint = '國小'
): Promise<ErrorFeaturesPayload> {
  const inkSessionId = await ensureInkSessionId()
  // 2026-07-20 題本圖由 server 端依 assignmentId 注入（proxy）；文字題送文字樣態、
  //   圖上作答題（answer_only 計算/作圖）改送「答錯學生的實際作答圖」讓 AI 看圖歸納。
  const imageMode = isImageAnswerItem(item)
  const cropParts: Array<{ inlineData: { data: string; mimeType: string } }> = []
  if (imageMode) {
    const urls = await fetchWrongCrops(assignmentId, item.questionId)
    for (const u of urls) { const b64 = u.split(',')[1]; if (b64) cropParts.push({ inlineData: { data: b64, mimeType: 'image/jpeg' } }) }
    if (cropParts.length === 0) throw new Error('無法取得學生作答圖，暫時無法歸納（稍後再試）')
  }
  const parts: Array<{ text?: string; inlineData?: { data: string; mimeType: string } }> = [
    { text: imageMode ? buildImagePrompt(item, domain, gradeHint, cropParts.length) : buildPrompt(item, domain, gradeHint) },
    ...cropParts,
  ]
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
