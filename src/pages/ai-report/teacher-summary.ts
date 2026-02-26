import { db } from '@/lib/db'
import { getInkSessionId, startInkSession } from '@/lib/ink-session'
import type { AssignmentTagReport } from './types'

const GEMINI_PROXY_URL = import.meta.env.VITE_GEMINI_PROXY_URL || '/api/proxy'
const SUMMARY_MODEL = 'gemini-3-flash-preview'
const SUMMARY_FORMAT_VERSION = 'teacher-action-v3'
const ACTION_VERBS = ['圈出', '重寫', '停下來問', '示範', '請學生說明', '寫出']
const ACTION_STARTERS = [
  '請先',
  '先',
  '在黑板上',
  '帶學生',
  '示範',
  '圈出',
  '重寫',
  '停下來問',
  '請學生'
]
const BANNED_PHRASES = ['根據', '標示', '對照', '導致', '推論失效']
let inkSessionPromise: Promise<string | null> | null = null

type InstructionPlanTag = {
  label: string
  count: number
  ratio: number
  examples: string[]
}

export type InstructionPlan = {
  assignmentId: string
  sampleCount: number
  targets: InstructionPlanTag[]
  strategyHint: string
  actionVerbs: string[]
  minBullets: number
  maxBullets: number
}

export type TeacherSummaryResult = {
  bullets: string[]
  source: 'llm' | 'cache' | 'fallback'
  remedy?: string
  error?: string
}

export function hashTagsForCache(report: AssignmentTagReport | null): string {
  if (!report) return 'empty'
  const sampleCount = report.sampleCount ?? 0
  const tags = (report.tags ?? [])
    .map((tag) => ({
      label: tag.label.trim(),
      count: Number.isFinite(tag.count) ? tag.count : 0,
      examples: Array.from(
        new Set(
          (tag.examples ?? [])
            .map((example) => example.trim())
            .filter(Boolean)
        )
      ).sort()
    }))
    .sort((a, b) => a.label.localeCompare(b.label))

  const payload = JSON.stringify({
    version: SUMMARY_FORMAT_VERSION,
    sampleCount,
    tags
  })
  return hashString(payload)
}

export function buildInstructionPlan(
  report: AssignmentTagReport | null
): InstructionPlan | null {
  if (!report) return null
  const sampleCount = report.sampleCount ?? 0
  const tags = (report.tags ?? [])
    .map((tag) => ({
      label: tag.label.trim(),
      count: Number.isFinite(tag.count) ? tag.count : 0,
      examples: (tag.examples ?? [])
        .map((example) => example.trim())
        .filter(Boolean)
        .slice(0, 3)
    }))
    .filter((tag) => tag.label.length > 0)
    .sort((a, b) => b.count - a.count)

  const targets = tags
    .filter((tag) => tag.examples.length > 0)
    .slice(0, 3)
    .map((tag) => ({
      ...tag,
      ratio: sampleCount > 0 ? tag.count / sampleCount : 0
    }))

  const topRatio = targets[0]?.ratio ?? 0
  const strategyHint =
    sampleCount < 5
      ? '批改份數不足 5 份，請先累積資料再輸出摘要。'
      : topRatio >= 0.3
        ? '錯誤集中，優先全班示範與概念釐清。'
        : '錯誤分散，優先分組對照與小測追蹤。'

  return {
    assignmentId: report.assignmentId,
    sampleCount,
    targets,
    strategyHint,
    actionVerbs: ACTION_VERBS,
    minBullets: 2,
    maxBullets: 3
  }
}

export async function readTeacherSummaryCache(cacheKey: string) {
  try {
    return await db.teacherSummaryCache.get(cacheKey)
  } catch (error) {
    console.warn('讀取老師行動摘要快取失敗', error)
    return null
  }
}

export async function writeTeacherSummaryCache(
  cacheKey: string,
  assignmentId: string,
  bullets: string[],
  remedy?: string
) {
  try {
    await db.teacherSummaryCache.put({
      cacheKey,
      assignmentId,
      bullets,
      remedy,
      updatedAt: Date.now()
    })
  } catch (error) {
    console.warn('寫入老師行動摘要快取失敗', error)
  }
}

export async function generateTeacherSummaryWithLLM(
  plan: InstructionPlan,
  fallbackBullets?: string[]
): Promise<TeacherSummaryResult> {
  const fallback = fallbackBullets?.length
    ? fallbackBullets
    : buildFallbackBullets(plan)
  const fallbackRemedy = buildFallbackRemedy(plan)

  if (plan.targets.length === 0) {
    return {
      bullets: fallback,
      source: 'fallback',
      remedy: fallbackRemedy,
      error: 'no_targets'
    }
  }

  if (!plan.targets.some((tag) => tag.examples.length > 0)) {
    return {
      bullets: fallback,
      source: 'fallback',
      remedy: fallbackRemedy,
      error: 'no_examples'
    }
  }

  try {
    const prompt = buildPrompt(plan)
    const text = await requestGemini(prompt)
    const parsed = parseSummaryJson(text)
    const validationError = validateSummary(parsed.bullets, parsed.remedy, plan)

    if (validationError) {
      return {
        bullets: fallback,
        source: 'fallback',
        remedy: fallbackRemedy,
        error: validationError
      }
    }

    return {
      bullets: parsed.bullets,
      source: 'llm',
      remedy: parsed.remedy
    }
  } catch (error) {
    return {
      bullets: fallback,
      source: 'fallback',
      remedy: fallbackRemedy,
      error: error instanceof Error ? error.message : 'llm_failed'
    }
  }
}

function buildPrompt(plan: InstructionPlan) {
  const payload = {
    assignmentId: plan.assignmentId,
    sampleCount: plan.sampleCount,
    strategyHint: plan.strategyHint,
    targets: plan.targets.map((target) => ({
      label: target.label,
      count: target.count,
      ratio: Number(target.ratio.toFixed(4)),
      examples: target.examples
    }))
  }

  return `
你是教學助理，請依照 InstructionPlan 生成「老師行動摘要」。

規則：
1. 只能輸出 JSON：{"bullets": string[], "remedy": string}
2. bullets 長度需為 ${plan.minBullets}~${plan.maxBullets} 行。
3. 每個 bullet 必須同時包含：
   - 至少 1 個 target label（從 InstructionPlan.targets.label 擇一）
   - 至少 1 個 evidence example（只能使用 InstructionPlan.targets.examples 的原句）
   - 至少 1 個動作動詞（必須包含以下其一：${plan.actionVerbs.join('、')}）
4. 每個 bullet 必須以「老師會做的動作」開頭，建議開頭用：${ACTION_STARTERS.join('、')} 其中之一。
5. 每個 bullet 必須包含老師對學生的指令或提問（請用引號包起來，例如：「這一步你會先算哪個數字？為什麼？」）。
6. 禁止空話（例如：加強理解、多練習、注意）。
7. 禁止新增題號或題目內容（因為目前無題號資料）。
8. 只能引用提供的 label 與 examples，不可自行捏造。
9. 禁止出現系統分析用語（例如：根據、標示、對照、導致、推論失效）。
10. remedy 必須是「補救方式一句話」，且必須以老師動作開頭並包含引號內的提問或指令。
11. remedy 只能使用 InstructionPlan 中的 labels 與 examples，不可新增題號。

InstructionPlan:
${JSON.stringify(payload, null, 2)}

請直接輸出 JSON，不要 Markdown、不加任何多餘文字。
`.trim()
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
      model: SUMMARY_MODEL,
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

function parseSummaryJson(text: string) {
  const cleaned = text.replace(/```json|```/g, '').trim()
  const jsonText = extractJson(cleaned)
  const parsed = JSON.parse(jsonText) as { bullets?: unknown; remedy?: unknown }
  if (!parsed || !Array.isArray(parsed.bullets)) {
    throw new Error('invalid_schema')
  }

  const bullets = parsed.bullets
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)

  if (bullets.length < 2 || bullets.length > 3) {
    throw new Error('invalid_bullet_count')
  }

  const remedy = typeof parsed.remedy === 'string' ? parsed.remedy.trim() : ''
  if (!remedy) {
    throw new Error('missing_remedy')
  }

  return { bullets, remedy }
}

function validateSummary(
  bullets: string[],
  remedy: string,
  plan: InstructionPlan
) {
  if (bullets.length < plan.minBullets || bullets.length > plan.maxBullets) {
    return 'invalid_bullet_count'
  }

  const labels = plan.targets.map((tag) => tag.label).filter(Boolean)
  const examples = plan.targets.flatMap((tag) => tag.examples).filter(Boolean)

  const checkSentence = (text: string) => {
    const hasLabel = labels.some((label) => text.includes(label))
    const hasExample = examples.some((example) => text.includes(example))
    const hasVerb = plan.actionVerbs.some((verb) => text.includes(verb))
    const hasStarter = ACTION_STARTERS.some((starter) => text.startsWith(starter))
    const hasQuotedInstruction = /「[^」]+」/.test(text)
    const hasBanned = BANNED_PHRASES.some((phrase) => text.includes(phrase))

    if (!hasLabel) return 'missing_label'
    if (!hasExample) return 'missing_example'
    if (!hasVerb) return 'missing_action'
    if (!hasStarter) return 'missing_starter'
    if (!hasQuotedInstruction) return 'missing_instruction'
    if (hasBanned) return 'banned_phrase'
    return null
  }

  for (const bullet of bullets) {
    const error = checkSentence(bullet)
    if (error) return error
  }

  const remedyError = checkSentence(remedy)
  if (remedyError) return `remedy_${remedyError}`

  return null
}

function buildFallbackBullets(plan: InstructionPlan) {
  const bullets: string[] = []
  const pairs = plan.targets.flatMap((tag) => {
    if (tag.examples.length === 0) {
      return [{ label: tag.label, example: '' }]
    }
    return tag.examples.map((example) => ({ label: tag.label, example }))
  })

  if (pairs.length === 0) {
    return ['常見錯誤：尚無可判讀標籤。', '建議：先累積批改份數（至少 5 份）。']
  }

  const desired = Math.min(plan.maxBullets, Math.max(plan.minBullets, pairs.length))

  for (let i = 0; i < desired; i += 1) {
    const pair = pairs[i % pairs.length]
    const verb = plan.actionVerbs[i % plan.actionVerbs.length]
    const exampleText = pair.example ? `「${pair.example}」` : '班內錯誤示例'
    bullets.push(
      `請先用${exampleText}示範「${pair.label}」的${verb}步驟，並問：「這一步你會先處理哪個條件？為什麼？」`
    )
  }

  return bullets
}

function buildFallbackRemedy(plan: InstructionPlan) {
  const target = plan.targets[0]
  if (!target) {
    return '請先帶學生口頭重述解題流程，並問：「這一題計算前要先處理哪個條件？」'
  }
  const example = target.examples[0]
  const exampleText = example ? `「${example}」` : '班內錯誤示例'
  return `請先用${exampleText}示範「${target.label}」的步驟，並問：「這一步你會先處理哪個條件？為什麼？」`
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
