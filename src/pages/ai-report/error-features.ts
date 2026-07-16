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
  return `你是${gradeHint}${domain || ''}老師的教學助理。這一題的正解：「${item.keyAnswer}」。
以下是全班 ${wrongVariants.length} 種「被判錯」的學生作答（×N 表示 N 份相同）：
${wrongVariants.map((w, i) => `${i + 1}. ${w}`).join('\n')}
${blankTotal > 0 ? `另有 ${blankTotal} 人未作答。` : ''}

請做「錯誤特徵統計」：找出出現頻率高的錯誤特徵（同一個作答可以同時計入多個特徵），每個特徵回報：
- feature: 特徵名稱（中文、老師秒懂的說法）
- count: 有此特徵的作答數
- examples: 最多 2 個代表例（原文節錄）
- note: 一句話教學提示
只列 count≥2 的特徵、按 count 由多到少排序；「內容明顯不成句/亂答」的作答不計入特徵、單獨列在 nonsense。
最後給 teachingFocus：給老師的 2 句檢討課重點。
只輸出 JSON：{"features":[{"feature":"...","count":0,"examples":["..."],"note":"..."}],"nonsense":["..."],"teachingFocus":"..."}`
}

export async function generateErrorFeatures(
  assignmentId: string,
  item: ItemStat,
  domain: string,
  gradeHint = '國小'
): Promise<ErrorFeaturesPayload> {
  const inkSessionId = await ensureInkSessionId()
  const response = await fetch(GEMINI_PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: buildPrompt(item, domain, gradeHint) }] }],
      routeKey: 'report.question_error_features',
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
        note: String(f.note ?? '')
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
