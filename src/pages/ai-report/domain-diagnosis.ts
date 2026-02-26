import { db } from '@/lib/db'
import { getInkSessionId, startInkSession } from '@/lib/ink-session'
import type {
  DomainAggregate,
  DomainDiagnosis,
  DomainPlan,
  TimeRange,
  TimeRangePreset
} from './types'

const GEMINI_PROXY_URL = import.meta.env.VITE_GEMINI_PROXY_URL || '/api/proxy'
const DOMAIN_MODEL = 'gemini-3-flash-preview'
const DIAGNOSIS_FORMAT_VERSION = 'domain-diagnosis-v1'
const TAIPEI_TZ = 'Asia/Taipei'
const MS_PER_DAY = 24 * 60 * 60 * 1000
const ACTION_KEYWORDS = [
  '安排',
  '固定',
  '調整',
  '設計',
  '規畫',
  '建立',
  '加入',
  '設定',
  '回饋',
  '評量',
  '流程',
  '順序',
  '每週',
  '單元'
]
const TIME_KEYWORDS = ['每週', '本週', '下週', '接下來', '兩週', '三週', '四週']
const EMPTY_TALK = ['加強理解', '多練習', '注意', '提升能力']
const QUESTION_LEVEL = ['題號', '題目', '第', '算式', '步驟']
let inkSessionPromise: Promise<string | null> | null = null

type AssignmentLite = {
  id: string
  domain?: string
  createdAt?: string | number | null
  updatedAt?: number | null
}

type AssignmentTagSummary = {
  assignmentId: string
  status?: string
  sampleCount?: number
  tags?: Array<{ label: string; count: number; examples?: string[] }>
}

type TagAbilityMap = {
  tag: string
  ability: string
  confidence?: number | null
}

export function buildTimeRange(
  preset: TimeRangePreset,
  customStart?: string,
  customEnd?: string,
  timezone = TAIPEI_TZ
): TimeRange {
  const todayLabel = formatTaipeiDate(new Date(), timezone)
  const todayStartMs = Date.parse(`${todayLabel}T00:00:00+08:00`)
  const todayEndMs = Date.parse(`${todayLabel}T23:59:59+08:00`)

  if (preset === 'custom') {
    const startLabel = customStart || todayLabel
    const endLabel = customEnd || todayLabel
    return {
      preset,
      start: Date.parse(`${startLabel}T00:00:00+08:00`),
      end: Date.parse(`${endLabel}T23:59:59+08:00`),
      startLabel,
      endLabel
    }
  }

  const days = preset === '7d' ? 7 : preset === '90d' ? 90 : 30
  const startMs = todayStartMs - days * MS_PER_DAY
  const startLabel = formatTaipeiDate(new Date(startMs), timezone)

  return {
    preset,
    start: startMs,
    end: todayEndMs,
    startLabel,
    endLabel: todayLabel
  }
}

export function filterAssignmentsByRange(
  assignments: AssignmentLite[],
  range: TimeRange
) {
  return assignments.filter((assignment) => {
    const ts = toTimestamp(assignment.createdAt, assignment.updatedAt)
    if (ts === null) return false
    return ts >= range.start && ts <= range.end
  })
}

export function buildDomainAggregate(
  assignmentsInRange: AssignmentLite[],
  assignmentTags: AssignmentTagSummary[]
): DomainAggregate[] {
  const tagByAssignment = new Map<string, AssignmentTagSummary>()
  assignmentTags.forEach((item) => {
    if (!item.assignmentId) return
    tagByAssignment.set(item.assignmentId, item)
  })

  const domainMap = new Map<
    string,
    {
      domain: string
      assignmentCount: number
      sampleCountTotal: number
      maxSampleCount: number
      tags: Map<string, { count: number; examples: Set<string> }>
    }
  >()

  assignmentsInRange.forEach((assignment) => {
    const tagInfo = tagByAssignment.get(assignment.id)
    if (!tagInfo || tagInfo.status !== 'ready') return
    const domain = normalizeDomain(assignment.domain)
    if (!domainMap.has(domain)) {
      domainMap.set(domain, {
        domain,
        assignmentCount: 0,
        sampleCountTotal: 0,
        maxSampleCount: 0,
        tags: new Map()
      })
    }
    const entry = domainMap.get(domain)
    if (!entry) return

    entry.assignmentCount += 1
    const sampleCount = Number.isFinite(tagInfo.sampleCount)
      ? Number(tagInfo.sampleCount)
      : 0
    if (sampleCount > 0) {
      entry.sampleCountTotal += sampleCount
      entry.maxSampleCount = Math.max(entry.maxSampleCount, sampleCount)
    }

    ;(tagInfo.tags ?? []).forEach((tag) => {
      const label = tag.label?.trim()
      if (!label) return
      if (!entry.tags.has(label)) {
        entry.tags.set(label, { count: 0, examples: new Set() })
      }
      const tagEntry = entry.tags.get(label)
      if (!tagEntry) return
      tagEntry.count += Number.isFinite(tag.count) ? tag.count : 0
      ;(tag.examples ?? []).forEach((example) => {
        if (tagEntry.examples.size >= 2) return
        const cleaned = example.trim()
        if (cleaned) tagEntry.examples.add(cleaned)
      })
    })
  })

  return Array.from(domainMap.values()).map((entry) => {
    let sampleCountTotal = entry.sampleCountTotal
    if (sampleCountTotal === 0 && entry.assignmentCount > 0) {
      const estimate = entry.maxSampleCount || 5
      sampleCountTotal = entry.assignmentCount * estimate
    }

    const tags = Array.from(entry.tags.entries())
      .map(([label, tag]) => ({
        label,
        count: tag.count,
        ratio: sampleCountTotal > 0 ? tag.count / sampleCountTotal : 0,
        examples: Array.from(tag.examples)
      }))
      .sort((a, b) => b.count - a.count)

    return {
      domain: entry.domain,
      assignmentCount: entry.assignmentCount,
      sampleCountTotal,
      tags
    }
  })
}

export function buildDomainPlan(
  aggregate: DomainAggregate,
  tagAbilityMap?: TagAbilityMap[]
): DomainPlan {
  const sorted = [...aggregate.tags].sort((a, b) => {
    if (aggregate.sampleCountTotal > 0) {
      return b.ratio - a.ratio
    }
    return b.count - a.count
  })

  const topTags = sorted.slice(0, 3).map((tag) => ({
    label: tag.label,
    count: tag.count,
    ratio: tag.ratio,
    example: tag.examples?.[0]
  }))

  const concentration =
    (topTags[0]?.ratio ?? 0) + (topTags[1]?.ratio ?? 0)
  const riskLevel =
    topTags[0]?.ratio >= 0.3 || concentration >= 0.55
      ? 'HIGH'
      : topTags[0]?.ratio >= 0.15
        ? 'MED'
        : 'LOW'

  const abilities = buildAbilityInsight(topTags, tagAbilityMap)

  return {
    domainName: aggregate.domain,
    windowInfo: {
      assignmentCount: aggregate.assignmentCount,
      sampleCountTotal: aggregate.sampleCountTotal,
      startDate: '',
      endDate: ''
    },
    riskLevel,
    concentration,
    topTags,
    abilities: abilities.length ? abilities : undefined,
    mustAddCaveat: aggregate.assignmentCount < 2
  }
}

export function hashDomainPlanForCache(plan: DomainPlan) {
  const payload = JSON.stringify({
    version: DIAGNOSIS_FORMAT_VERSION,
    domain: plan.domainName,
    window: plan.windowInfo,
    riskLevel: plan.riskLevel,
    concentration: Number(plan.concentration.toFixed(4)),
    topTags: plan.topTags.map((tag) => ({
      label: tag.label,
      count: tag.count,
      ratio: Number(tag.ratio.toFixed(4)),
      example: tag.example ?? ''
    })),
    abilities: plan.abilities ?? []
  })
  return hashString(payload)
}

export function buildDomainDiagnosisPrompt(plan: DomainPlan) {
  const payload = {
    domainName: plan.domainName,
    windowInfo: plan.windowInfo,
    riskLevel: plan.riskLevel,
    concentration: Number(plan.concentration.toFixed(4)),
    topTags: plan.topTags,
    abilities: plan.abilities ?? [],
    mustAddCaveat: plan.mustAddCaveat
  }

  return `
你是教學顧問，請依照 DomainPlan 生成領域診斷文字。

規則：
1. 只能輸出 JSON：{"overview": "...", "trendSummary": "...", "teachingActions": ["..."], "abilityInsight": "...?"}
2. overview 與 trendSummary 需 50~120 字，teachingActions 2~3 行。
3. 必須是「跨作業」統整文字，不可提單一題目/題號/單一步驟/單一算式。
4. 禁止空話：加強理解、多練習、注意、提升能力。
5. teachingActions 必須是課程層級調整（教學順序/固定流程/評量設計/回饋方式/每週安排），且回答「接下來幾週怎麼教」。
6. abilityInsight 若有，需 <= 80 字。
7. 若 mustAddCaveat=true，trendSummary 必須包含「樣本較少」或「參考」等保留語句。
8. 不得列學生姓名；不得捏造不存在的資料（題號、分數分布、趨勢上升下降等）。
9. 自我檢查：若移除任何單一作業名稱或題目內容，文字仍然成立才算通過。

DomainPlan:
${JSON.stringify(payload, null, 2)}

請直接輸出 JSON，不要 Markdown、不加任何多餘文字。
`.trim()
}

export async function generateDomainDiagnosisWithLLM(plan: DomainPlan) {
  const cacheKey = buildCacheKey(plan)
  const cached = await readDomainDiagnosisCache(cacheKey)
  if (cached) {
    return { diagnosis: cached, source: 'cache' as const, cacheKey }
  }

  if (plan.windowInfo.assignmentCount === 0) {
    return { diagnosis: null, source: 'empty' as const, cacheKey }
  }

  const fallback = buildFallbackDiagnosis(plan)

  try {
    const prompt = buildDomainDiagnosisPrompt(plan)
    const text = await requestGemini(prompt)
    const parsed = parseDiagnosisJson(text)
    const error = validateDiagnosis(parsed, plan)

    if (error) {
      return { diagnosis: fallback, source: 'fallback' as const, cacheKey, error }
    }

    await writeDomainDiagnosisCache(cacheKey, plan, parsed)
    return { diagnosis: parsed, source: 'llm' as const, cacheKey }
  } catch (error) {
    return {
      diagnosis: fallback,
      source: 'fallback' as const,
      cacheKey,
      error: error instanceof Error ? error.message : 'llm_failed'
    }
  }
}

export function runDomainDiagnosisSanityCheck() {
  const range = buildTimeRange('7d')
  const assignments: AssignmentLite[] = [
    { id: 'a1', domain: '數學', createdAt: `${range.startLabel}T08:00:00+08:00` },
    { id: 'a2', domain: '數學', createdAt: `${range.startLabel}T10:00:00+08:00` }
  ]
  const tags: AssignmentTagSummary[] = [
    {
      assignmentId: 'a1',
      status: 'ready',
      sampleCount: 10,
      tags: [
        { label: '概念錯誤', count: 4, examples: ['概念誤解'] },
        { label: '審題不清', count: 2, examples: ['條件忽略'] }
      ]
    }
  ]

  const aggregate = buildDomainAggregate(assignments, tags)
  const plan = buildDomainPlan(aggregate[0], [
    { tag: '概念錯誤', ability: '概念理解' }
  ])
  plan.windowInfo.startDate = range.startLabel
  plan.windowInfo.endDate = range.endLabel
  const hash = hashDomainPlanForCache(plan)
  return { aggregate, plan, hash }
}

function buildCacheKey(plan: DomainPlan) {
  return `domainDiag:${plan.domainName}:${plan.windowInfo.startDate}:${plan.windowInfo.endDate}:${hashDomainPlanForCache(plan)}`
}

async function readDomainDiagnosisCache(cacheKey: string) {
  try {
    const cached = await db.domainDiagnosisCache.get(cacheKey)
    if (!cached) return null
    return {
      overview: cached.overview,
      trendSummary: cached.trendSummary,
      teachingActions: cached.teachingActions,
      abilityInsight: cached.abilityInsight
    } satisfies DomainDiagnosis
  } catch (error) {
    console.warn('讀取領域診斷快取失敗', error)
    return null
  }
}

async function writeDomainDiagnosisCache(
  cacheKey: string,
  plan: DomainPlan,
  diagnosis: DomainDiagnosis
) {
  try {
    await db.domainDiagnosisCache.put({
      cacheKey,
      domain: plan.domainName,
      startDate: plan.windowInfo.startDate,
      endDate: plan.windowInfo.endDate,
      overview: diagnosis.overview,
      trendSummary: diagnosis.trendSummary,
      teachingActions: diagnosis.teachingActions,
      abilityInsight: diagnosis.abilityInsight,
      updatedAt: Date.now()
    })
  } catch (error) {
    console.warn('寫入領域診斷快取失敗', error)
  }
}

async function ensureInkSessionId() {
  const existing = getInkSessionId()
  if (existing) return existing
  if (!inkSessionPromise) {
    inkSessionPromise = startInkSession()
      .then((result) => result.sessionId)
      .catch((error) => {
        console.warn('建立墨水會話失敗', error)
        return null
      })
      .finally(() => {
        inkSessionPromise = null
      })
  }
  return inkSessionPromise
}

async function requestGemini(prompt: string) {
  const inkSessionId = await ensureInkSessionId()
  if (!inkSessionId) {
    throw new Error('no_ink_session')
  }
  const response = await fetch(GEMINI_PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      model: DOMAIN_MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      ...(inkSessionId ? { inkSessionId } : {})
    })
  })

  let data: any = null
  try {
    data = await response.json()
  } catch {
    data = {}
  }

  if (!response.ok) {
    const message =
      data?.error?.message || data?.error || `Gemini request failed (${response.status})`
    throw new Error(message)
  }

  const text = (data?.candidates ?? [])
    .flatMap((candidate: any) => candidate?.content?.parts ?? [])
    .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
    .join('')
    .trim()

  if (!text) {
    throw new Error('Gemini response empty')
  }

  return text
}

function parseDiagnosisJson(text: string): DomainDiagnosis {
  const cleaned = text.replace(/```json|```/g, '').trim()
  const jsonText = extractJson(cleaned)
  const parsed = JSON.parse(jsonText) as {
    overview?: unknown
    trendSummary?: unknown
    teachingActions?: unknown
    abilityInsight?: unknown
  }

  const overview = typeof parsed.overview === 'string' ? parsed.overview.trim() : ''
  const trendSummary =
    typeof parsed.trendSummary === 'string' ? parsed.trendSummary.trim() : ''
  const teachingActions = Array.isArray(parsed.teachingActions)
    ? parsed.teachingActions
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean)
    : []
  const abilityInsight =
    typeof parsed.abilityInsight === 'string' ? parsed.abilityInsight.trim() : undefined

  if (!overview || !trendSummary || teachingActions.length < 2) {
    throw new Error('invalid_schema')
  }

  return {
    overview,
    trendSummary,
    teachingActions,
    abilityInsight
  }
}

function validateDiagnosis(diagnosis: DomainDiagnosis, plan: DomainPlan) {
  if (!withinLength(diagnosis.overview, 50, 120)) return 'overview_length'
  if (!withinLength(diagnosis.trendSummary, 50, 120)) return 'trend_length'

  if (plan.mustAddCaveat && !/樣本|參考/.test(diagnosis.trendSummary)) {
    return 'missing_caveat'
  }

  if (hasQuestionLevelText(diagnosis.overview)) return 'overview_question_level'
  if (hasQuestionLevelText(diagnosis.trendSummary)) return 'trend_question_level'
  if (diagnosis.teachingActions.length < 2 || diagnosis.teachingActions.length > 3) {
    return 'actions_count'
  }

  for (const action of diagnosis.teachingActions) {
    if (EMPTY_TALK.some((text) => action.includes(text))) return 'actions_empty'
    if (hasQuestionLevelText(action)) return 'actions_question_level'
    if (!ACTION_KEYWORDS.some((keyword) => action.includes(keyword))) {
      return 'actions_not_course_level'
    }
    if (!TIME_KEYWORDS.some((keyword) => action.includes(keyword))) {
      return 'actions_missing_timeframe'
    }
  }

  return null
}

function buildFallbackDiagnosis(plan: DomainPlan): DomainDiagnosis {
  const topLabels = plan.topTags.map((tag) => tag.label).filter(Boolean)
  const overviewTags = topLabels.slice(0, 2).join('、') || '常見錯誤標籤'
  const overview = `本領域近期作業顯示${overviewTags}較為集中，反映出跨作業的概念理解需要穩定化，建議以整體教學節奏做調整。`
  const trendSummary = plan.mustAddCaveat
    ? `目前樣本較少，趨勢判讀先以參考為主；仍可先從${overviewTags}切入規畫教學安排。`
    : `整體錯誤分布呈現集中於${overviewTags}的趨勢，適合在課堂流程中安排固定回饋與檢核節點。`
  const teachingActions = [
    `接下來每週固定一節「概念整理」流程，安排學生口頭說明${topLabels[0] || '主要概念'}的關鍵條件與判斷方式。`,
    `下週起調整教學順序，先建立${topLabels[1] || '常見概念'}的基礎定義，再安排短測檢核與即時回饋。`
  ]

  return {
    overview,
    trendSummary,
    teachingActions
  }
}

function buildAbilityInsight(
  topTags: Array<{ label: string }>,
  tagAbilityMap?: TagAbilityMap[]
) {
  if (!tagAbilityMap || tagAbilityMap.length === 0) return []
  const abilities = new Map<string, { total: number; count: number }>()
  topTags.forEach((tag) => {
    const mapping = tagAbilityMap.filter(
      (item) => normalizeLabel(item.tag) === normalizeLabel(tag.label)
    )
    mapping.forEach((item) => {
      const entry = abilities.get(item.ability) ?? { total: 0, count: 0 }
      entry.total += typeof item.confidence === 'number' ? item.confidence : 0
      entry.count += 1
      abilities.set(item.ability, entry)
    })
  })

  return Array.from(abilities.entries()).map(([label, entry]) => ({
    label,
    confidenceAvg: entry.count > 0 ? entry.total / entry.count : undefined
  }))
}

function normalizeDomain(domain?: string) {
  const value = domain?.trim()
  if (!value || value === 'uncategorized') return '全部'
  return value
}

function formatTaipeiDate(date: Date, timezone: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date)
}

function toTimestamp(createdAt?: string | number | null, updatedAt?: number | null) {
  if (typeof createdAt === 'number' && Number.isFinite(createdAt)) return createdAt
  if (typeof createdAt === 'string' && createdAt) {
    const parsed = Date.parse(createdAt)
    if (Number.isFinite(parsed)) return parsed
  }
  if (typeof updatedAt === 'number' && Number.isFinite(updatedAt)) return updatedAt
  return null
}

function normalizeLabel(value: string) {
  return value.trim().replace(/\s+/g, '').toLowerCase()
}

function withinLength(text: string, min: number, max: number) {
  const length = text.trim().length
  return length >= min && length <= max
}

function hasQuestionLevelText(text: string) {
  if (QUESTION_LEVEL.some((term) => text.includes(term))) return true
  return /第\\d+題/.test(text)
}

function extractJson(text: string) {
  if (text.startsWith('{') && text.endsWith('}')) return text
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end !== -1 && end > start) {
    return text.slice(start, end + 1)
  }
  return text
}

function hashString(input: string) {
  let hash = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
