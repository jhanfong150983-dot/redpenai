// 家長學習報告（2026-07-18、B2B MVP、user 拍板）：老師選一份作業 → 批量產生全班家長報告 PDF、打包 zip。
//   一份作業＝一份報告（不跨科合併）。資料全來自既有批改結果＋試題分析，唯一 AI 呼叫＝老師評語（純文字、便宜）。
//   PDF 產出沿用 correctionNoticePdf.ts 骨架（html2canvas→jsPDF、系統中文字型、每生一頁）。
import { ensureInkSessionFresh } from '@/lib/ink-session'

const GEMINI_PROXY_URL = import.meta.env?.VITE_GEMINI_PROXY_URL || '/api/proxy'
const COMMENT_MODEL = 'gemini-2.5-flash' // 純文字評語、便宜足夠

// ── 輸入型別（寬鬆、對齊 AiReport 現有資料） ──
export type PRQuestion = {
  id?: string
  questionId?: string
  questionType?: string
  questionCategory?: string
  maxScore?: number
  answer?: string
  referenceAnswer?: string
  /** 多小題（合題）：正確答案在 parts[].answer、頂層 answer 為空 */
  parts?: Array<{ subId?: string; answer?: string }>
  /** 2026-07-19 試題分析（backfill 到 answer_key）：大主題 topic + 知識點 knowledgePoints */
  analysis?: { topic?: string; knowledgePoints?: string[]; ability?: string; cnaArea?: string; note?: string }
}

// 標準答案取值：頂層 answer 為空時（多小題型）由 parts 組出（subId a/b/c → ①②③）。
const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩']
export function resolveStdAnswer(q: { answer?: string; referenceAnswer?: string; parts?: Array<{ answer?: string }> }): string {
  const direct = String(q.answer ?? q.referenceAnswer ?? '').trim()
  if (direct) return direct
  const parts = Array.isArray(q.parts) ? q.parts : []
  return parts.map((p, i) => `${CIRCLED[i] ?? (i + 1) + '.'} ${String(p.answer ?? '').trim()}`)
    .filter((s) => s.replace(/[①-⑩\d.\s]/g, '').length > 0).join('　')
}
export type PRDetail = {
  questionId?: string
  score?: number
  maxScore?: number
  isCorrect?: boolean
  studentAnswer?: string
  reason?: string
  questionType?: string
  referenceAnswer?: string
  finalAnswerSource?: string  // 'manual' = 老師人工輸入（顯示不改「圖像辨識」）；字形終審不帶此值
}
export type PRSubmission = {
  studentId?: string
  gradingResult?: unknown
}
export type PRStudent = {
  id: string
  name?: string
  seatNumber?: number | null
}

export type ReportHeader = {
  schoolName: string
  crestDataUrl?: string // 校徽（data URI，可空）
  className: string
  subject: string // 科目（domain）
  assignmentTitle: string
  teacherName?: string
  dateStr: string
}

export type TypeRate = { label: string; studentRate: number; classRate: number }
// 國字/注音「字形終審（視覺覆核）」判錯的格：讀到值被投射成＝標準答案（不可信）、真正對錯由圖像辨識決定。
//   → 顯示時把「AI 讀到」欄改成「圖像辨識」，避免家長看到「讀到==標準卻扣分」而誤會批錯。
//   偵測：判錯 && 非人工輸入(manual) && 批改理由含視覺覆核/字形錯誤訊號（實證這批 33 格全中、0 誤中 manual）。
export function isImageJudgedAnswer(reason?: string, finalAnswerSource?: string): boolean {
  if (finalAnswerSource === 'manual') return false
  return /視覺覆核|字形錯誤|字形視覺/.test(String(reason || ''))
}
export type WrongItem = {
  questionId: string
  typeLabel: string
  studentAnswer: string
  referenceAnswer: string
  reason: string
  imageJudged?: boolean   // true → 顯示「圖像辨識」取代讀到值
}
// 第四段「逐題錯題分析」：每一題錯題一張卡（不限量、依題號排序）。
//   骨架（題號/題型/知識點/作答/標準答案）純程式算；why/suggest（AI 診斷）與 cropDataUrl（server 截圖）
//   由 generate 流程另外填（applyDiagnosisAndCrops）。
export type QErrorRow = {
  questionId: string
  label: string          // 家長看得懂的題號（formatQuestionLabel）
  typeLabel: string
  kp: string             // 知識點（・分隔）、無試題分析時為空
  studentAnswer: string  // AI 讀到學生寫的
  referenceAnswer: string // 標準答案
  reason: string         // 批改理由（診斷未生成時的退回說明）
  imageJudged?: boolean  // true → 字形終審判錯、顯示「圖像辨識」取代讀到值
  why: string            // AI 專家診斷「為什麼會這樣寫錯」（後填）
  suggest: string        // 在家建議（後填）
  cropDataUrl: string    // 學生作答截圖 data URI（後填）
}
export type WeakKp = { kp: string; tip: string }
export type WeakTopic = { topic: string; band: 'red' | 'amber'; ratePct: number; total: number; wrong: number; weakKps: WeakKp[] }
// 精熟程度總覽（第三段）：每個知識點的三級 + 精熟百分比（長條圖用）
export type KpLevel = 'expert' | 'basic' | 'weak' // 精熟／基礎／待加強
export type KpMastery = { kp: string; level: KpLevel; ratePct: number }
export type TopicMastery = { topic: string; band: 'red' | 'amber' | 'green'; ratePct: number; kps: KpMastery[] }
export type StudentReport = {
  studentId: string
  name: string
  seat: string
  score: number
  examMax: number
  ratioPct: number
  gradeLabel: string
  isLow: boolean
  classAvg: number
  classMedian: number
  classMin: number
  classMax: number
  classP25: number
  classP75: number
  typeRates: TypeRate[]
  wrongs: WrongItem[]
  moreWrongCount: number
  // 2026-07-19 第四段「逐題錯題分析」：全部錯題、依題號排序、不限量（電子交付）
  errorRows: QErrorRow[]
  // 2026-07-19 加強地圖（依大主題分組、建議掛在知識點）；hasAnalysis=false 時退回 wrongs 清單
  hasAnalysis: boolean
  topicMastery: TopicMastery[] // 第三段：全部主題+知識點的精熟程度總覽
  weakTopics: WeakTopic[]      // 第四段：需要加強（帶建議）
  strongTopics: string[]
  comment: string
}

// ── 題型 → 家長看得懂的分類標籤 ──
const TYPE_LABEL: Record<string, string> = {
  single_choice: '選擇題', circle_select_one: '選擇題',
  true_false: '是非題',
  single_check: '勾選題', multi_check: '勾選題', circle_select_many: '勾選題', table_check: '勾選題',
  fill_blank: '填空題', fill_variants: '填空題',
  short_answer: '簡答題',
  ordering: '排序題',
  word_problem: '應用題',
  calculation: '計算題',
  compound_chain_table: '綜合題', compound_circle_with_explain: '綜合題', compound_check_with_explain: '綜合題',
  map_fill: '圖表題', map_symbol: '圖表題', diagram_draw: '圖表題', diagram_color: '圖表題',
  grid_geometry: '圖形題', table_cell: '表格題',
  visual_judgment: '圖形判斷',
}
function typeLabelOf(t?: string): string {
  const k = String(t ?? '').trim()
  return TYPE_LABEL[k] || '其他'
}

// questionId 格式＝「{頁碼}-{小題...}」（第一段=1-based 頁碼，實測三卷皆符）→ 家長看得懂的「第N頁 X-Y題」。
// 非此格式（第一段非數字/只有一段）退回原樣「第 {id} 題」。
function formatQuestionLabel(qid: string): string {
  const parts = String(qid).split('-')
  if (parts.length >= 2 && /^\d+$/.test(parts[0])) {
    return `第${parts[0]}頁 ${parts.slice(1).join('-')}題`
  }
  return `第 ${qid} 題`
}

function parseDetails(gradingResult: unknown): PRDetail[] {
  let gr = gradingResult
  if (typeof gr === 'string') { try { gr = JSON.parse(gr) } catch { return [] } }
  const details = (gr as { details?: unknown } | null | undefined)?.details
  return Array.isArray(details) ? (details as PRDetail[]) : []
}

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
function median(sorted: number[]): number {
  if (!sorted.length) return 0
  const m = sorted.length >> 1
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2
}
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx), hi = Math.ceil(idx)
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

/**
 * 組裝全班家長報告資料（純程式、零 AI）。評語留空、由 generateComment 另外填。
 */
export function assembleParentReports(
  questions: PRQuestion[],
  submissions: PRSubmission[],
  students: PRStudent[],
  opts: { maxWrongs?: number; kpTips?: Record<string, string> } = {}
): StudentReport[] {
  const maxWrongs = opts.maxWrongs ?? 5
  const kpTips = opts.kpTips ?? {}
  const qMaxById = new Map<string, number>()
  const qTypeById = new Map<string, string>()
  const qAnswerById = new Map<string, string>()
  const qTopicById = new Map<string, string>()
  const qKpsById = new Map<string, string[]>()
  let anyAnalysis = false
  for (const q of questions) {
    const id = String(q.id ?? q.questionId ?? '').trim()
    if (!id) continue
    qMaxById.set(id, num(q.maxScore))
    qTypeById.set(id, String(q.questionCategory ?? q.questionType ?? '').trim())
    qAnswerById.set(id, resolveStdAnswer(q))
    const topic = String(q.analysis?.topic ?? '').trim()
    const kps = (q.analysis?.knowledgePoints ?? []).map((k) => String(k).trim()).filter((k) => k && k !== '無法對應')
    if (topic && topic !== '無法對應') { qTopicById.set(id, topic); anyAnalysis = true }
    if (kps.length) qKpsById.set(id, kps)
  }
  const examMax = questions.reduce((a, q) => a + num(q.maxScore), 0)

  const studentById = new Map(students.map((s) => [s.id, s]))

  // 每卷 details（只取有批改結果、且對得上學生的）
  type Paper = { studentId: string; details: PRDetail[]; total: number }
  const papers: Paper[] = []
  for (const sub of submissions) {
    const sid = String(sub.studentId ?? '').trim()
    if (!sid || !studentById.has(sid)) continue
    const details = parseDetails(sub.gradingResult)
    if (!details.length) continue
    const total = details.reduce((a, d) => a + num(d.score), 0)
    papers.push({ studentId: sid, details, total })
  }
  if (papers.length < 1) return []

  // 班級分佈統計
  const totalsSorted = papers.map((p) => p.total).sort((a, b) => a - b)
  const classAvg = totalsSorted.reduce((a, b) => a + b, 0) / totalsSorted.length
  const classStats = {
    avg: Math.round(classAvg * 10) / 10,
    median: Math.round(median(totalsSorted) * 10) / 10,
    min: Math.round(totalsSorted[0]),
    max: Math.round(totalsSorted[totalsSorted.length - 1]),
    p25: percentile(totalsSorted, 0.25),
    p75: percentile(totalsSorted, 0.75),
  }

  // 班級各題型得分率（分母＝該型 maxScore 總和，跨全班）
  const classTypeAgg = new Map<string, { got: number; max: number }>()
  for (const p of papers) {
    for (const d of p.details) {
      const qid = String(d.questionId ?? '').trim()
      const label = typeLabelOf(qTypeById.get(qid) || d.questionType)
      const mx = num(d.maxScore) > 0 ? num(d.maxScore) : (qMaxById.get(qid) || 0)
      if (!(mx > 0)) continue
      const e = classTypeAgg.get(label) ?? { got: 0, max: 0 }
      e.got += Math.max(0, Math.min(mx, num(d.score)))
      e.max += mx
      classTypeAgg.set(label, e)
    }
  }
  const classTypeRate = new Map<string, number>()
  for (const [label, e] of classTypeAgg) classTypeRate.set(label, e.max > 0 ? (e.got / e.max) * 100 : 0)

  const gradeLabelOf = (ratio: number): string =>
    ratio >= 85 ? '優異' : ratio >= 70 ? '良好' : ratio >= 60 ? '尚可' : '待加強'

  const reports: StudentReport[] = []
  for (const p of papers) {
    const stu = studentById.get(p.studentId)!
    // 學生各題型得分率
    const stuTypeAgg = new Map<string, { got: number; max: number }>()
    for (const d of p.details) {
      const qid = String(d.questionId ?? '').trim()
      const label = typeLabelOf(qTypeById.get(qid) || d.questionType)
      const mx = num(d.maxScore) > 0 ? num(d.maxScore) : (qMaxById.get(qid) || 0)
      if (!(mx > 0)) continue
      const e = stuTypeAgg.get(label) ?? { got: 0, max: 0 }
      e.got += Math.max(0, Math.min(mx, num(d.score)))
      e.max += mx
      stuTypeAgg.set(label, e)
    }
    const typeRates: TypeRate[] = [...stuTypeAgg.entries()]
      .map(([label, e]) => ({
        label,
        studentRate: e.max > 0 ? Math.round((e.got / e.max) * 100) : 0,
        classRate: Math.round(classTypeRate.get(label) ?? 0),
      }))
      .sort((a, b) => a.studentRate - b.studentRate) // 弱的排前面，家長先看到

    // 錯題（失分題）：score < maxScore，依失分多寡排序、取前 N
    const wrongAll = p.details
      .map((d) => {
        const qid = String(d.questionId ?? '').trim()
        const mx = num(d.maxScore) > 0 ? num(d.maxScore) : (qMaxById.get(qid) || 0)
        return { d, qid, mx, lost: mx - num(d.score) }
      })
      .filter((x) => x.qid && x.mx > 0 && x.lost > 0.01 && x.d.isCorrect !== true)
      .sort((a, b) => b.lost - a.lost)
    const wrongs: WrongItem[] = wrongAll.slice(0, maxWrongs).map((x) => ({
      questionId: x.qid,
      typeLabel: typeLabelOf(qTypeById.get(x.qid) || x.d.questionType),
      studentAnswer: String(x.d.studentAnswer ?? '').trim(),
      referenceAnswer: String(x.d.referenceAnswer ?? '').trim() || (qAnswerById.get(x.qid) ?? ''),
      reason: String(x.d.reason ?? '').trim(),
      imageJudged: isImageJudgedAnswer(x.d.reason, x.d.finalAnswerSource) && String(x.d.studentAnswer ?? '').trim() !== '未作答' && String(x.d.studentAnswer ?? '').trim() !== '',
    }))
    // 第四段逐題錯題分析：全部錯題、依題號排序（不限量）；why/suggest/crop 後填
    const errorRows: QErrorRow[] = wrongAll
      .slice()
      .sort((a, b) => a.qid.localeCompare(b.qid, undefined, { numeric: true }))
      .map((x) => ({
        questionId: x.qid,
        label: formatQuestionLabel(x.qid),
        typeLabel: typeLabelOf(qTypeById.get(x.qid) || x.d.questionType),
        kp: (qKpsById.get(x.qid) ?? []).join('・'),
        studentAnswer: String(x.d.studentAnswer ?? '').trim(),
        referenceAnswer: String(x.d.referenceAnswer ?? '').trim() || (qAnswerById.get(x.qid) ?? ''),
        reason: String(x.d.reason ?? '').trim(),
        imageJudged: isImageJudgedAnswer(x.d.reason, x.d.finalAnswerSource) && String(x.d.studentAnswer ?? '').trim() !== '未作答' && String(x.d.studentAnswer ?? '').trim() !== '',
        why: '', suggest: '', cropDataUrl: '',
      }))

    // 依大主題彙整 + 逐知識點精熟度
    const topicAgg = new Map<string, { got: number; max: number; total: number; wrong: number; wrongKp: Map<string, number>; order: number }>()
    const kpAgg = new Map<string, { got: number; max: number; topic: string; order: number }>()
    let ord = 0
    for (const d of p.details) {
      const qid = String(d.questionId ?? '').trim()
      const topic = qTopicById.get(qid)
      if (!topic) continue
      const mx = num(d.maxScore) > 0 ? num(d.maxScore) : (qMaxById.get(qid) || 0)
      if (!(mx > 0)) continue
      const got = Math.max(0, Math.min(mx, num(d.score)))
      if (!topicAgg.has(topic)) topicAgg.set(topic, { got: 0, max: 0, total: 0, wrong: 0, wrongKp: new Map(), order: ord++ })
      const e = topicAgg.get(topic)!
      e.max += mx; e.got += got; e.total++
      if (d.isCorrect !== true) e.wrong++
      for (const kp of (qKpsById.get(qid) ?? [])) {
        if (!kpAgg.has(kp)) kpAgg.set(kp, { got: 0, max: 0, topic, order: kpAgg.size })
        const k = kpAgg.get(kp)!; k.got += got; k.max += mx
        if (d.isCorrect !== true) e.wrongKp.set(kp, (e.wrongKp.get(kp) ?? 0) + 1)
      }
    }
    const bandOf = (rate: number): 'red' | 'amber' | 'green' => rate >= 0.8 ? 'green' : rate >= 0.6 ? 'amber' : 'red'
    const levelOf = (rate: number): KpLevel => rate >= 0.8 ? 'expert' : rate >= 0.5 ? 'basic' : 'weak'
    // 第三段：每主題底下所有知識點（依考卷題目出現順序，全班一致；不依各生精熟率排，避免每人順序不同）
    const kpsByTopic = new Map<string, KpMastery[]>()
    for (const [kp, k] of kpAgg) {
      const rate = k.max > 0 ? k.got / k.max : 1
      if (!kpsByTopic.has(k.topic)) kpsByTopic.set(k.topic, [])
      kpsByTopic.get(k.topic)!.push({ kp, level: levelOf(rate), ratePct: Math.round(rate * 100) })
    }
    const allTopics = [...topicAgg.entries()].map(([topic, e]) => {
      const rate = e.max > 0 ? e.got / e.max : 1
      const band = bandOf(rate)
      const kps = kpsByTopic.get(topic) ?? [] // 保持題目出現順序（kpAgg 插入序＝題序、跨生一致）
      const weakKps: WeakKp[] = [...e.wrongKp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([kp]) => ({ kp, tip: kpTips[kp] ?? '' }))
      return { topic, band, ratePct: Math.round(rate * 100), total: e.total, wrong: e.wrong, weakKps, kps, order: e.order }
    })
    const topicMastery: TopicMastery[] = allTopics
      .slice().sort((a, b) => a.order - b.order) // 固定主題順序（題目出現序）、全班一致，不依各生精熟率
      .map((t) => ({ topic: t.topic, band: t.band, ratePct: t.ratePct, kps: t.kps }))
    const weakTopics: WeakTopic[] = allTopics.filter((t) => t.band !== 'green')
      .map((t) => ({ topic: t.topic, band: t.band as 'red' | 'amber', ratePct: t.ratePct, total: t.total, wrong: t.wrong, weakKps: t.weakKps }))
      .sort((a, b) => a.ratePct - b.ratePct)
    const strongTopics = allTopics.filter((t) => t.band === 'green').map((t) => t.topic)

    const ratioPct = examMax > 0 ? (p.total / examMax) * 100 : 0
    reports.push({
      studentId: p.studentId,
      name: String(stu.name ?? '').trim() || '（未命名）',
      seat: Number.isFinite(stu.seatNumber as number) ? String(stu.seatNumber) : '—',
      score: Math.round(p.total * 10) / 10,
      examMax: Math.round(examMax),
      ratioPct,
      gradeLabel: gradeLabelOf(ratioPct),
      isLow: p.total < classAvg,
      classAvg: classStats.avg,
      classMedian: classStats.median,
      classMin: classStats.min,
      classMax: classStats.max,
      classP25: classStats.p25,
      classP75: classStats.p75,
      typeRates,
      wrongs,
      moreWrongCount: Math.max(0, wrongAll.length - wrongs.length),
      errorRows,
      hasAnalysis: anyAnalysis,
      topicMastery,
      weakTopics,
      strongTopics,
      comment: '',
    })
  }
  // 依座號排序
  reports.sort((a, b) => (parseInt(a.seat) || 999) - (parseInt(b.seat) || 999))
  return reports
}

// ── AI 老師評語（鼓勵型、純文字、餵真實成績＋錯題） ──
async function ensureInkSessionId(): Promise<string | null> {
  // 用 fresh 版：會話過期/剩<60s 自動續期，避免長時間停留後送舊 id 被判「會話已過期」。
  try { const { sessionId } = await ensureInkSessionFresh(); return sessionId }
  catch { return null }
}
function buildCommentPrompt(r: StudentReport, subject: string): string {
  // 有試題分析 → 用「單元＋知識點」給評語更精準；否則退回題型/錯題
  const strong = r.hasAnalysis
    ? r.strongTopics.slice(0, 3)
    : r.typeRates.filter((t) => t.studentRate >= 80).map((t) => t.label).slice(0, 3)
  const weak = r.hasAnalysis
    ? r.weakTopics.slice(0, 3).map((t) => t.topic)
    : r.typeRates.filter((t) => t.studentRate < 65).map((t) => t.label).slice(0, 3)
  const wrongLines = r.hasAnalysis
    ? (r.weakTopics.slice(0, 3).map((t) => `・${t.topic}：${t.weakKps.map((k) => k.kp).join('、') || '整體不穩'}`).join('\n') || '（各單元表現都不錯）')
    : (r.wrongs.slice(0, 4).map((w) => `・${formatQuestionLabel(w.questionId)}（${w.typeLabel}）：${w.reason || '答錯'}`).join('\n') || '（無明顯錯題）')
  return `你是一位溫暖但務實的${subject}老師，正在為家長寫一段簡短的學習回饋（給家長看，稱呼學生用姓名）。
根據以下這位學生本次評量的表現，寫一段 80～120 字的繁體中文回饋：先肯定表現好的地方，再具體點出「一個」最該加強的重點與一句可行的建議。語氣鼓勵、正向、像老師親口對家長說的話。不要條列、不要 markdown、不要提到分數數字，只輸出這段回饋文字本身。

學生：${r.name}
科目：${subject}
得分表現：${r.ratioPct >= 85 ? '優異' : r.ratioPct >= 70 ? '良好' : r.ratioPct >= 60 ? '尚可' : '待加強'}（班級平均之${r.isLow ? '下' : '上'}）
表現較好的題型：${strong.length ? strong.join('、') : '（無特別突出）'}
較弱的題型：${weak.length ? weak.join('、') : '（無明顯弱項）'}
主要錯題：
${wrongLines}`
}

/** 產生單一學生的老師評語；失敗回空字串（報告仍可出、老師可自行補寫）。 */
export async function generateParentComment(r: StudentReport, subject: string): Promise<string> {
  try {
    const inkSessionId = await ensureInkSessionId()
    const res = await fetch(GEMINI_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        model: COMMENT_MODEL,
        contents: [{ role: 'user', parts: [{ text: buildCommentPrompt(r, subject) }] }],
        routeKey: 'report.parent_comment',
        ...(inkSessionId ? { inkSessionId } : {}),
      }),
    })
    if (!res.ok) return ''
    const data = await res.json().catch(() => null)
    const text = ((data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })?.candidates ?? [])
      .flatMap((c) => c?.content?.parts ?? [])
      .map((p) => (typeof p?.text === 'string' ? p.text : ''))
      .join('')
      .replace(/```/g, '')
      .trim()
    return text
  } catch { return '' }
}

// ── AI 逐題錯因診斷（2.5-flash、餵題本圖由 server 注入、一生一 call 批全部錯題） ──
export type DiagnosisWrong = { questionId: string; studentAnswer: string; referenceAnswer: string }
export type DiagnosisItem = { why: string; suggest: string }

function buildDiagnosisPrompt(subject: string, wrongs: DiagnosisWrong[]): string {
  const lines = wrongs
    .map((w) => `${w.questionId}：學生寫「${w.studentAnswer || '（空白）'}」正解「${w.referenceAnswer || '—'}」`)
    .join('\n')
  return `你是資深台灣${subject}老師與學習診斷專家。附上完整題本（多頁圖）。以下是某位學生本次評量所有寫錯的題。
請逐題像專家一樣分析「他為什麼會這樣寫錯」——推論他的思路或迷思、務必結合題幹內容說明，用白話寫給家長看、每題 2～3 句、語氣不責備。不要只做表層貼標（例如別只寫「計算錯誤」，要推論他卡在哪個觀念或哪一步）。再給家長一句「在家可以怎麼幫」的具體建議。
錯題（題號：學生寫「」正解「」）：
${lines}
只輸出 JSON、不要 markdown：{"items":[{"questionId":"題號","why":"為什麼會這樣寫錯","suggest":"在家建議"}]}`
}

/** 產生一位學生全部錯題的 AI 錯因診斷；回 Map<questionId,{why,suggest}>；失敗回空 Map（報告仍可出、卡片留白）。 */
export async function generateParentDiagnosis(
  assignmentId: string,
  subject: string,
  wrongs: DiagnosisWrong[],
): Promise<Map<string, DiagnosisItem>> {
  const out = new Map<string, DiagnosisItem>()
  if (!assignmentId || wrongs.length === 0) return out
  try {
    const inkSessionId = await ensureInkSessionId()
    const res = await fetch(GEMINI_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        model: COMMENT_MODEL,
        contents: [{ role: 'user', parts: [{ text: buildDiagnosisPrompt(subject, wrongs) }] }],
        routeKey: 'report.parent_diagnosis',
        assignmentId, // server 據此撈題本圖注入 contents（client 不必自抓、避開 bucket RLS）
        ...(inkSessionId ? { inkSessionId } : {}),
      }),
    })
    if (!res.ok) return out
    const data = await res.json().catch(() => null)
    const text = ((data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })?.candidates ?? [])
      .flatMap((c) => c?.content?.parts ?? [])
      .map((p) => (typeof p?.text === 'string' ? p.text : ''))
      .join('')
    const m = text.match(/\{[\s\S]*\}/)
    if (!m) return out
    const parsed = JSON.parse(m[0]) as { items?: Array<{ questionId?: string; why?: string; suggest?: string }> }
    for (const it of parsed.items ?? []) {
      const qid = String(it.questionId ?? '').trim()
      if (!qid) continue
      out.set(qid, { why: String(it.why ?? '').trim(), suggest: String(it.suggest ?? '').trim() })
    }
    return out
  } catch { return out }
}

// ── 錯題截圖（server 端切、方案 A）：回 Map<題號, dataURI>；失敗回空 Map（卡片不顯示圖） ──
const CROPS_ENDPOINT = '/api/report/crops'
export async function fetchQuestionCrops(
  assignmentId: string,
  studentId: string,
  questionIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const qids = [...new Set(questionIds.map((q) => String(q ?? '').trim()).filter(Boolean))]
  if (!assignmentId || !studentId || qids.length === 0) return out
  try {
    const res = await fetch(CROPS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ assignmentId, studentId, questionIds: qids }),
    })
    if (!res.ok) return out
    const data = (await res.json().catch(() => null)) as { crops?: Record<string, string> } | null
    for (const [qid, uri] of Object.entries(data?.crops ?? {})) {
      if (typeof uri === 'string' && uri) out.set(qid, uri)
    }
    return out
  } catch { return out }
}

// ── 家長報告快取（parent_reports：只存 AI 產物＝診斷 + 評語；截圖免費不進表） ──
const PARENT_CACHE_ENDPOINT = '/api/report/parent-cache'
export type CachedReport = { diagnosis: Record<string, DiagnosisItem>; comment: string; stale: boolean }

/** 載入某作業全部已快取的診斷/評語（含 stale 指紋比對）；回 Map<studentId, CachedReport>。 */
export async function loadParentReportCache(assignmentId: string): Promise<Map<string, CachedReport>> {
  const out = new Map<string, CachedReport>()
  if (!assignmentId) return out
  // 逾時保護：這是報告 tab 載入用（撈全班診斷 + answer_key、較重）。前置閘已改用輕量 parentReportCount，
  //   故這裡放寬到 20s、避免冷啟動/大回應被 6s 砍掉→報告全變「待生成」（診斷其實在 DB）。
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 20000)
  try {
    const res = await fetch(`${PARENT_CACHE_ENDPOINT}?assignmentId=${encodeURIComponent(assignmentId)}`, {
      credentials: 'include',
      signal: ctrl.signal,
    })
    if (!res.ok) return out
    const data = (await res.json().catch(() => null)) as {
      items?: Array<{ studentId: string; diagnosis: Record<string, DiagnosisItem>; comment: string; stale: boolean }>
    } | null
    for (const it of data?.items ?? []) {
      out.set(String(it.studentId), {
        diagnosis: it.diagnosis || {},
        comment: it.comment || '',
        stale: Boolean(it.stale),
      })
    }
    return out
  } catch { return out } finally { clearTimeout(timer) }
}

/** 輕量：查有幾筆家長報告（給重批改/改答案卷前置閘用；不撈診斷、快）。
 *  傳 studentIds 只算那幾位（重批改只影響被重批的學生）；不傳＝整份作業（改答案卷用）。逾時/失敗回 0（fail-open）。 */
export async function parentReportCount(assignmentId: string, studentIds?: string[]): Promise<number> {
  if (!assignmentId) return 0
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 4000)
  try {
    let url = `${PARENT_CACHE_ENDPOINT}?assignmentId=${encodeURIComponent(assignmentId)}&countOnly=1`
    if (studentIds && studentIds.length) url += `&studentIds=${encodeURIComponent(studentIds.join(','))}`
    const res = await fetch(url, {
      credentials: 'include',
      signal: ctrl.signal,
    })
    if (!res.ok) return 0
    const data = (await res.json().catch(() => null)) as { count?: number } | null
    return Number(data?.count) || 0
  } catch { return 0 } finally { clearTimeout(timer) }
}

/** 批次寫回快取（server 端當下蓋指紋）；回是否成功。 */
export async function saveParentReportCache(
  assignmentId: string,
  items: Array<{ studentId: string; diagnosis: Record<string, DiagnosisItem>; comment: string }>,
): Promise<boolean> {
  if (!assignmentId || items.length === 0) return false
  try {
    const res = await fetch(PARENT_CACHE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ assignmentId, items }),
    })
    return res.ok
  } catch { return false }
}

/** 從報告取出要送診斷的錯題清單（給 generateParentDiagnosis 用）。 */
export function diagnosisWrongsOf(r: StudentReport): DiagnosisWrong[] {
  return r.errorRows.map((e) => ({
    questionId: e.questionId,
    studentAnswer: e.studentAnswer,
    referenceAnswer: e.referenceAnswer,
  }))
}

/** 把 AI 診斷（why/suggest）與截圖（cropDataUrl）併回報告的 errorRows，回新報告（不改原物件）。 */
export function applyDiagnosisAndCrops(
  r: StudentReport,
  diag: Map<string, DiagnosisItem>,
  crops: Map<string, string>,
): StudentReport {
  return {
    ...r,
    errorRows: r.errorRows.map((e) => {
      const d = diag.get(e.questionId)
      const c = crops.get(e.questionId)
      return {
        ...e,
        why: d?.why || e.why,
        suggest: d?.suggest || e.suggest,
        cropDataUrl: c || e.cropDataUrl,
      }
    }),
  }
}

/** 把快取的 CachedReport（診斷 Record + 評語）併回報告；截圖不在此、另由 ensureCrops 補。 */
export function applyCachedReport(r: StudentReport, cached: CachedReport): StudentReport {
  const diagMap = new Map<string, DiagnosisItem>(Object.entries(cached.diagnosis || {}))
  const merged = applyDiagnosisAndCrops(r, diagMap, new Map())
  return { ...merged, comment: cached.comment || merged.comment }
}

/** report.errorRows 是否已全部帶到 AI 診斷（判斷「已生成 / 待生成」）。 */
export function hasDiagnosis(r: StudentReport): boolean {
  return r.errorRows.length > 0 && r.errorRows.every((e) => Boolean(e.why))
}

// ── 版面 CSS ──
// ⚠ html2canvas 相容性鐵則：一律 table 佈局＋垂直 middle、絕不用 flexbox 對齊或 CSS transform
//   （2026-07-18 實測跑版根因＝transform:translateX 與 flex align 在 html2canvas 渲染不準）。
//   置中：table-cell vertical-align:middle + text-align；橫向定位：left/right 絕對定位＋固定寬 margin，不用 transform。
export const REPORT_CSS = `
.pr-root { width:794px; box-sizing:border-box; padding:40px 48px 32px; background:#fff; color:#1F2933;
  font-family:'Noto Sans TC','PingFang TC','Microsoft JhengHei','Heiti TC',sans-serif; }
.pr-root * { box-sizing:border-box; }

.pr-mast { width:100%; border-collapse:collapse; border-bottom:3px solid #1E4D8C; }
.pr-mast td { vertical-align:middle; padding-bottom:14px; }
.pr-mast .crestcell { width:72px; }
.pr-crest { width:56px; height:56px; object-fit:contain; display:block; }
.pr-crest-ph { width:56px; height:56px; border:2px solid #1E4D8C; border-radius:6px; }
.pr-school .nm { font-size:20px; font-weight:700; letter-spacing:.08em; }
.pr-titlecell { text-align:right; white-space:nowrap; }
.pr-title .zh { font-size:16px; font-weight:700; letter-spacing:.18em; color:#1E4D8C; white-space:nowrap; }
.pr-title .mt { font-size:11px; color:#7B8794; margin-top:4px; line-height:1.5; white-space:nowrap; }
.pr-title .asgn2 { font-size:10.5px; color:#7B8794; margin-top:2px; white-space:nowrap; }

.pr-stu { width:100%; border-collapse:collapse; margin:14px 0 20px; border:1px solid #D9DEE4; }
.pr-stu td { vertical-align:middle; text-align:center; padding:9px 10px; font-size:13px; border-left:1px solid #E8ECF0; }
.pr-stu td:first-child { border-left:none; }
.pr-stu .k { font-size:11px; color:#7B8794; margin-right:6px; }
.pr-stu .v { font-weight:700; }

.pr-sec { font-size:13px; letter-spacing:.12em; color:#1E4D8C; font-weight:700; margin:16px 0 9px;
  border-bottom:1px solid #D9DEE4; padding-bottom:6px; }

.pr-hero { width:100%; border-collapse:collapse; border:1px solid #D9DEE4; }
.pr-hero td { vertical-align:middle; padding:16px 20px; }
.pr-scorecell { width:188px; text-align:center; border-right:1px solid #E8ECF0; }
.pr-score { text-align:center; }
.pr-score .n { font-size:52px; font-weight:800; line-height:1.05; color:#1E4D8C; text-align:center; }
.pr-score .n.low { color:#C2402A; }
.pr-score .o { font-size:12px; color:#7B8794; margin-top:6px; text-align:center; }
.pr-score .g { display:inline-block; margin-top:10px; font-size:12px; font-weight:700; letter-spacing:.08em; padding:3px 14px; border-radius:3px; background:#E3EBF5; color:#1E4D8C; }
.pr-score .g.low { background:#FBEAE6; color:#C2402A; }
.pr-dist .cap { font-size:11px; color:#7B8794; margin-bottom:12px; }
.pr-bar { position:relative; height:22px; margin:0 4px; }
.pr-bar .axis { position:absolute; left:0; right:0; top:10px; height:2px; background:#E8ECF0; }
.pr-bar .band { position:absolute; top:6px; height:10px; background:#C4CEDA; border-radius:3px; }
.pr-bar .me { position:absolute; top:1px; width:3px; height:20px; margin-left:-1px; background:#1E4D8C; border-radius:2px; }
.pr-bar .me.low { background:#C2402A; }
.pr-ticks { position:relative; height:14px; margin-top:2px; }
.pr-ticks .lo { position:absolute; left:0; font-size:10px; color:#7B8794; }
.pr-ticks .hi { position:absolute; right:0; font-size:10px; color:#7B8794; }
.pr-keys { margin-top:6px; font-size:11px; color:#52606D; }
.pr-keys span { margin-right:16px; }
.pr-keys b { color:#1F2933; }

.pr-types { width:100%; border-collapse:collapse; }
.pr-types td { vertical-align:middle; padding:4px 0; }
.pr-types .lbl { width:76px; font-size:12.5px; color:#52606D; }
.pr-types .barcell { padding:0 12px; }
.pr-track { position:relative; height:12px; background:#E8ECF0; border-radius:2px; }
.pr-track .fill { position:absolute; left:0; top:0; bottom:0; border-radius:2px 4px 4px 2px; background:#1E4D8C; }
.pr-track .fill.mid { background:#6E86A8; }
.pr-track .fill.low { background:#C2402A; }
.pr-track .cls { position:absolute; top:-3px; width:2px; height:18px; margin-left:-1px; background:#7B8794; }
.pr-types .pct { width:46px; text-align:right; font-size:12.5px; font-weight:700; }
.pr-tlgd { border-collapse:collapse; margin-top:8px; font-size:11px; color:#7B8794; }
.pr-tlgd td { vertical-align:middle; padding:0; }
.pr-tlgd .chipcell { width:16px; }
.pr-tlgd .txt { padding-right:18px; padding-left:5px; white-space:nowrap; }
.pr-tlgd .sw { width:10px; height:10px; border-radius:2px; }
.pr-tlgd .cl { width:2px; height:12px; background:#7B8794; margin:0 auto; }

.pr-wtab { width:100%; border-collapse:collapse; font-size:12.5px; }
.pr-wtab th { text-align:left; font-size:11px; font-weight:500; color:#7B8794; letter-spacing:.06em; padding:4px 8px 6px; border-bottom:1px solid #D9DEE4; }
.pr-wtab td { padding:8px; border-bottom:1px solid #E8ECF0; vertical-align:top; }
.pr-wtab .qcell { width:120px; }
.pr-wtab .qno { font-weight:700; color:#1E4D8C; white-space:nowrap; }
.pr-wtab .qt { font-size:11px; color:#7B8794; display:block; margin-top:2px; }
.pr-ans { margin-bottom:3px; }
.pr-ans .y { color:#C2402A; font-weight:600; }
.pr-ans .r { color:#1E4D8C; font-weight:600; }
.pr-fix { color:#52606D; display:block; }
.pr-more { font-size:11px; color:#7B8794; padding:6px 8px; }
/* 加強地圖（依大主題分組、建議掛知識點） */
.pr-topic { border:1px solid #E8ECF0; border-left-width:4px; border-radius:5px; padding:11px 14px; margin-bottom:9px; }
.pr-topic.red { border-left-color:#C2402A; background:#FCF3F1; }
.pr-topic.amber { border-left-color:#C77D0A; background:#FCF7EC; }
.pr-topic-name { font-size:14px; font-weight:700; color:#1F2933; }
.pr-topic-badge { display:inline-block; font-size:11px; font-weight:700; padding:1px 8px; border-radius:3px; margin-left:8px; }
.pr-topic-badge.red { background:#F6D5CE; color:#A5331F; }
.pr-topic-badge.amber { background:#F4E4C1; color:#8A5A08; }
.pr-topic-stat { font-size:11.5px; color:#7B8794; margin-left:8px; }
.pr-topic-lead { font-size:11.5px; color:#7B8794; margin:6px 0 5px; }
.pr-kp { margin-bottom:6px; }
.pr-kp-name { font-size:13px; font-weight:700; color:#3E4A56; }
.pr-kp-tip { display:block; font-size:12.5px; color:#1E4D8C; line-height:1.7; background:#EEF3FA; border-radius:4px; padding:5px 10px; margin-top:3px; }
.pr-strong { margin-top:6px; font-size:12.5px; color:#2E6B4F; line-height:1.7; background:#EAF5EF; border:1px solid #CDE8D9; border-radius:5px; padding:9px 13px; }
.pr-strong b { color:#1F5C42; }
.pr-allgood { font-size:12.5px; color:#2E6B4F; padding:10px 4px; }
/* 第三段 精熟程度總覽：知識點熱力圖（每知識點一格、顏色=狀態） */
.pr-mlegend { font-size:11px; color:#7B8794; margin-bottom:12px; }
.pr-mlgd-dot { display:inline-block; width:11px; height:10px; border-radius:2px; margin:0 4px 0 14px; vertical-align:middle; }
.pr-mtopic { font-size:12.5px; font-weight:700; color:#1F2933; margin:12px 0 7px; }
.pr-mtopic-badge { display:inline-block; font-size:10.5px; font-weight:700; padding:1px 8px; border-radius:3px; margin-left:8px; }
.pr-cgrid { display:flex; flex-wrap:wrap; gap:6px; }
.pr-cell { font-size:12.5px; font-weight:600; padding:6px 11px; border-radius:4px; color:#fff; letter-spacing:.01em; }
.pr-cell.expert { background:#256B4C; }
.pr-cell.basic { background:#9A5B00; }
.pr-cell.weak { background:#B0301C; }
.badge-green { background:#E6F4EC; color:#2E6B4F; }
.badge-amber { background:#F4E4C1; color:#8A5A08; }
.badge-red { background:#F6D5CE; color:#A5331F; }
.pr-page2 { break-before: page; page-break-before: always; }
.pr-note { border:1px solid #D9DEE4; border-left:3px solid #C2402A; padding:12px 16px; font-size:13px; line-height:1.85; color:#52606D; }
.pr-note .sig { text-align:right; color:#7B8794; font-size:12px; margin-top:6px; }
.pr-note .ph { color:#A6AEB8; }
.pr-foot { width:100%; border-collapse:collapse; margin-top:18px; border-top:1px solid #D9DEE4; }
.pr-foot td { padding-top:12px; font-size:10.5px; color:#7B8794; vertical-align:top; }
.pr-foot .r { text-align:right; white-space:nowrap; }
.pr-foot2 { margin-top:18px; border-top:1px solid #D9DEE4; padding-top:12px; }
.pr-foot2 .dis { font-size:10.5px; color:#7B8794; line-height:1.7; }
.pr-foot2 .org { font-size:10.5px; color:#7B8794; text-align:right; margin-top:5px; white-space:nowrap; }
/* 第四段 逐題錯題分析卡片（PDF 走 headless Chrome、可用 flex） */
.pr-aicheck { font-size:11.5px; color:#7A4E00; background:#FFF7E8; border:1px solid #F0D8A0; border-radius:6px; padding:9px 12px; margin:-2px 0 11px; line-height:1.75; break-inside:avoid; page-break-inside:avoid; }
.pr-aicheck b { color:#B0301C; font-weight:700; }
.pr-qsub { font-size:11px; color:#8A94A0; margin:-2px 0 12px; }
.pr-qc { border:1px solid #E4E8EC; border-radius:7px; padding:12px 14px; margin-bottom:12px; break-inside:avoid; page-break-inside:avoid; }
.pr-qh { margin-bottom:9px; }
.pr-qno { font-size:13.5px; font-weight:700; color:#1E4D8C; }
.pr-qkp { font-size:10.5px; color:#7B8794; background:#F2F4F6; border-radius:3px; padding:1px 8px; margin-left:8px; }
.pr-qbody { display:flex; gap:14px; margin-bottom:9px; }
.pr-qcrop { width:210px; flex:none; }
.pr-qcrop img { width:100%; border:1px solid #E4E8EC; border-radius:4px; }
.pr-qinfo { flex:1; }
.pr-qr { font-size:12.5px; margin-bottom:5px; }
.pr-qr .l { display:inline-block; width:74px; color:#7B8794; }
.pr-qr .you { color:#C2402A; font-weight:700; }
.pr-qr .you.imgjudge { color:#6B7684; font-weight:600; }
.pr-qr .ans { color:#1E4D8C; font-weight:700; }
.pr-qwhy { font-size:12.5px; color:#3E4A56; line-height:1.75; margin-top:4px; }
.pr-qwhy b { color:#8A5A08; }
.pr-qtip { font-size:12.5px; color:#1E4D8C; line-height:1.75; background:#EEF3FA; border-radius:4px; padding:6px 11px; margin-top:6px; }
.pr-qpend { font-size:11.5px; color:#A6AEB8; margin-top:4px; }
`

function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
// 分數 → 0~100% 位置（min~max 線性、夾制）
function posPct(v: number, min: number, max: number): number {
  if (max <= min) return 50
  return Math.max(2, Math.min(98, ((v - min) / (max - min)) * 100))
}

export function renderReportHtml(r: StudentReport, h: ReportHeader): string {
  const crest = h.crestDataUrl
    ? `<img class="pr-crest" src="${esc(h.crestDataUrl)}" alt="校徽">`
    : `<div class="pr-crest-ph"></div>`
  const mePos = posPct(r.score, r.classMin, r.classMax)
  const bandL = posPct(r.classP25, r.classMin, r.classMax)
  const bandR = posPct(r.classP75, r.classMin, r.classMax)
  const typesHtml = r.typeRates.map((t) => {
    const cls = t.studentRate < 60 ? 'low' : t.studentRate < 75 ? 'mid' : ''
    return `<tr><td class="lbl">${esc(t.label)}</td>
      <td class="barcell"><div class="pr-track"><div class="fill ${cls}" style="width:${t.studentRate}%"></div><div class="cls" style="left:${t.classRate}%"></div></div></td>
      <td class="pct">${t.studentRate}%</td></tr>`
  }).join('')
  const wrongsHtml = r.wrongs.length ? r.wrongs.map((w) => {
    const shownStu = w.imageJudged ? '圖像辨識' : (w.studentAnswer || '（未作答）')
    const ansLine = (w.studentAnswer || w.referenceAnswer || w.imageJudged)
      ? `<div class="pr-ans">孩子的答案：<span class="y"${w.imageJudged ? ' style="color:#6B7684"' : ''}>${esc(shownStu)}</span>${w.referenceAnswer ? `　正確答案：<span class="r">${esc(w.referenceAnswer)}</span>` : ''}</div>`
      : ''
    return `<tr><td class="qcell"><span class="qno">${esc(formatQuestionLabel(w.questionId))}</span><span class="qt">${esc(w.typeLabel)}</span></td>
      <td>${ansLine}<span class="pr-fix">✎ ${esc(w.reason || '請對照正確答案重新檢視這一題。')}</span></td></tr>`
  }).join('') : `<tr><td colspan="2" style="text-align:center;color:#7B8794;padding:14px">本次沒有明顯失分的題目，表現很好！</td></tr>`
  const moreRow = r.moreWrongCount > 0
    ? `<div class="pr-more">另有 ${r.moreWrongCount} 題失分，完整內容請見孩子的考卷。</div>` : ''
  // 第三段：精熟程度總覽（全部主題+知識點、三色點）
  const masteryLegend = `<div class="pr-mlegend">每一格是一個知識點，顏色代表掌握狀態：<span class="pr-mlgd-dot" style="background:#256B4C"></span>精熟　<span class="pr-mlgd-dot" style="background:#9A5B00"></span>基礎　<span class="pr-mlgd-dot" style="background:#B0301C"></span>待加強</div>`
  const masteryHtml = r.topicMastery.map((t) => {
    const badge = t.band === 'green' ? 'badge-green' : t.band === 'amber' ? 'badge-amber' : 'badge-red'
    const badgeText = t.band === 'green' ? '精熟' : t.band === 'amber' ? '基礎' : '待加強'
    const cells = t.kps.map((k) => `<span class="pr-cell ${k.level}">${esc(k.kp)}</span>`).join('')
    return `<div class="pr-mtopic">${esc(t.topic)}<span class="pr-mtopic-badge ${badge}">${badgeText}</span></div><div class="pr-cgrid">${cells}</div>`
  }).join('')
  // 第四段：逐題錯題分析（全部錯題、依題號排序；crop/why/suggest 由 generate 流程填）
  const errorCards = r.errorRows.map((e) => {
    const crop = e.cropDataUrl ? `<div class="pr-qcrop"><img src="${esc(e.cropDataUrl)}"></div>` : ''
    const shownStudent = e.imageJudged
      ? `<span class="you imgjudge">圖像辨識</span>`
      : `<span class="you">${esc(e.studentAnswer || '（空白）')}</span>`
    const info = `<div class="pr-qinfo">
        <div class="pr-qr"><span class="l">AI 讀到</span>${shownStudent}</div>
        <div class="pr-qr"><span class="l">標準答案</span><span class="ans">${esc(e.referenceAnswer || '—')}</span></div>
      </div>`
    const why = e.why
      ? `<div class="pr-qwhy"><b>🧠 為什麼會這樣：</b>${esc(e.why)}</div>`
      : `<div class="pr-qpend">✎ ${esc(e.reason || '請對照標準答案重新檢視這一題。')}</div>`
    const tip = e.suggest ? `<div class="pr-qtip"><b>💡 在家可以：</b>${esc(e.suggest)}</div>` : ''
    return `<div class="pr-qc">
      <div class="pr-qh"><span class="pr-qno">${esc(e.label)}</span>${e.kp ? `<span class="pr-qkp">${esc(e.kp)}</span>` : ''}</div>
      <div class="pr-qbody">${crop}${info}</div>${why}${tip}</div>`
  }).join('')
  const aiCheckNote = `<div class="pr-aicheck">📌 <b>請先對照影像確認：</b>下方每一題都附上系統從考卷<b>擷取的作答影像</b>與 AI 判讀結果（「AI 讀到」）。系統偶爾會<b>截錯框</b>或<b>把字認錯</b>，請和孩子一起仔細核對「AI 讀到」是否就是他實際寫的答案；<b>若發現是系統擷取或判讀錯誤而被扣分，請主動向老師提出</b>，老師會再確認並調整分數。</div>`
  const errorSection = r.errorRows.length
    ? `${aiCheckNote}${errorCards}`
    : `<div class="pr-allgood">本次沒有明顯失分的題目，表現很好！</div>`
  const commentHtml = r.comment ? esc(r.comment) : `<span class="ph">（老師評語）</span>`
  const noteHtml = `<div class="pr-note">${commentHtml}<div class="sig">${esc(h.subject)}科任課老師${h.teacherName ? `　${esc(h.teacherName)}` : ''}　${esc(h.dateStr)}</div></div>`
  const footHtml = `<div class="pr-foot2"><div class="dis">本報告由 AI 批改系統自動彙整生成，內容（含作答判讀、分數與分析）可能有誤，僅供學習參考、非最終成績；如有疑問請以老師確認為準．答對率以本次評量實際作答計算</div><div class="org">${esc(h.schoolName)}・${esc(h.subject)}科</div></div>`

  return `<div class="pr-root">
    <table class="pr-mast"><tbody><tr>
      <td class="crestcell">${crest}</td>
      <td class="pr-school"><div class="nm">${esc(h.schoolName || ' ')}</div></td>
      <td class="pr-titlecell"><div class="pr-title"><div class="zh">${esc(h.subject || '')}　學習報告</div>
        <div class="mt">${esc(h.dateStr)}</div>
        ${h.assignmentTitle ? `<div class="asgn2">${esc(h.assignmentTitle)}</div>` : ''}</div></td>
    </tr></tbody></table>

    <table class="pr-stu"><tbody><tr>
      <td><span class="k">班級</span><span class="v">${esc(h.className || '—')}</span></td>
      <td><span class="k">座號</span><span class="v">${esc(r.seat)}</span></td>
      <td><span class="k">姓名</span><span class="v">${esc(r.name)}</span></td>
      ${h.teacherName ? `<td><span class="k">任課老師</span><span class="v">${esc(h.teacherName)}</span></td>` : ''}
    </tr></tbody></table>

    <div class="pr-sec">一、本次成績與班級位置</div>
    <table class="pr-hero"><tbody><tr>
      <td class="pr-scorecell"><div class="pr-score"><div class="n${r.isLow ? ' low' : ''}">${r.score}</div>
        <div class="o">滿分 ${r.examMax} 分</div>
        <div class="g${r.isLow ? ' low' : ''}">${esc(r.gradeLabel)}</div></div></td>
      <td><div class="pr-dist"><div class="cap">孩子在班上的落點（標記為本人、灰帶為多數同學）</div>
        <div class="pr-bar">
          <div class="axis"></div>
          <div class="band" style="left:${bandL}%;width:${Math.max(2, bandR - bandL)}%"></div>
          <div class="me${r.isLow ? ' low' : ''}" style="left:${mePos}%"></div>
        </div>
        <div class="pr-ticks"><span class="lo">最低 ${r.classMin}</span><span class="hi">最高 ${r.classMax}</span></div>
        <div class="pr-keys"><span>本次得分 <b>${r.score}</b></span><span>班級平均 <b>${r.classAvg}</b></span><span>中位數 <b>${r.classMedian}</b></span></div>
      </div></td>
    </tr></tbody></table>

    <div class="pr-sec">二、各題型答對率（與班級平均對照）</div>
    <table class="pr-types"><tbody>${typesHtml}</tbody></table>
    <table class="pr-tlgd"><tbody><tr>
      <td class="chipcell"><div class="sw" style="background:#1E4D8C"></div></td><td class="txt">孩子的答對率</td>
      <td class="chipcell"><div class="cl"></div></td><td class="txt">班級平均</td>
      <td class="txt">紅色＝明顯偏低、值得優先加強</td>
    </tr></tbody></table>

    ${r.hasAnalysis ? `
    <div class="pr-sec">三、各主題知識點的精熟程度</div>
    ${masteryLegend}
    ${masteryHtml}

    <div class="pr-page2">
      <div class="pr-sec">四、逐題錯題分析</div>
      ${errorSection}

      <div class="pr-sec">五、老師的話</div>
      ${noteHtml}

      ${footHtml}
    </div>` : `
    <div class="pr-sec">三、重點錯題與訂正方向</div>
    <table class="pr-wtab"><thead><tr><th class="qcell">題號</th><th>作答狀況與訂正方向</th></tr></thead><tbody>${wrongsHtml}</tbody></table>${moreRow}

    <div class="pr-sec">四、老師的話</div>
    ${noteHtml}

    ${footHtml}`}
  </div>`
}

// ── 本地儲存：報告抬頭設定（老師個人、偏好設定頁維護）＋ 老師編輯過的評語（依作業快取） ──
const HEADER_STORE_KEY = 'parentReport.header.v1'
export type ReportHeaderSettings = { schoolName: string; crestDataUrl?: string; teacherName?: string }
export function loadReportHeaderSettings(): ReportHeaderSettings {
  try { const v = JSON.parse(localStorage.getItem(HEADER_STORE_KEY) || '{}'); return { schoolName: v.schoolName || '', crestDataUrl: v.crestDataUrl, teacherName: v.teacherName } } catch { return { schoolName: '' } }
}
export function saveReportHeaderSettings(v: ReportHeaderSettings): void {
  try { localStorage.setItem(HEADER_STORE_KEY, JSON.stringify(v)) } catch { /* quota */ }
}

const commentsKey = (assignmentId: string) => `parentReport.comments.${assignmentId}`
export function loadCachedComments(assignmentId: string): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(commentsKey(assignmentId)) || '{}') } catch { return {} }
}
export function saveCachedComment(assignmentId: string, studentId: string, comment: string): void {
  try {
    const all = loadCachedComments(assignmentId)
    if (comment) all[studentId] = comment; else delete all[studentId]
    localStorage.setItem(commentsKey(assignmentId), JSON.stringify(all))
  } catch { /* quota */ }
}

// ── PDF 產出：伺服器端 headless Chrome 渲染（2026-07-18、user 拍板） ──
// 為什麼不用 html2canvas / 瀏覽器列印：html2canvas 排版引擎與瀏覽器不同會跑版；瀏覽器列印要開網頁+列印對話框，
//   user 要「按下去直接得到 PDF 檔」。改由後端 /api/report/parent-pdf 用真 Chrome 渲染回傳 PDF 位元組，
//   渲染 100% 準、直接下載檔案、個別檔+zip 都保留。中文字型靠 HTML 內的 Google Fonts Noto Sans TC（後端開網路抓）。
const PDF_ENDPOINT = '/api/report/parent-pdf'
const FONT_LINK = '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700;800&display=swap" rel="stylesheet">'

// 組一份可渲染的完整 HTML（含字型連結、REPORT_CSS、A4 分頁規則）。多份時每份一頁（page-break）。
function buildPrintDocument(reports: StudentReport[], header: ReportHeader): string {
  const pages = reports.map((r) => renderReportHtml(r, header)).join('\n')
  return `<!doctype html><html><head><meta charset="utf-8"><title>家長學習報告</title>${FONT_LINK}
<style>
@page { size: A4; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }
${REPORT_CSS}
/* 分頁用 break-before（每份報告之「前」分頁、第一份除外）→ 結尾不會多出空白頁 */
.pr-root { break-before: page; page-break-before: always; }
.pr-root:first-child { break-before: auto; page-break-before: auto; }
</style></head><body>${pages}</body></html>`
}

async function fetchReportPdf(reports: StudentReport[], header: ReportHeader): Promise<Blob> {
  const res = await fetch(PDF_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ html: buildPrintDocument(reports, header) }),
  })
  if (!res.ok) {
    let msg = `PDF 產生失敗（${res.status}）`
    try { const j = await res.json(); if (j?.error) msg = j.error } catch { /* 非 JSON */ }
    throw new Error(msg)
  }
  return await res.blob()
}

function safeFileName(s: string): string {
  return String(s).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '').slice(0, 60)
}
export function reportFileName(r: StudentReport): string {
  return `${String(r.seat).padStart(2, '0')}_${safeFileName(r.name)}.pdf`
}
function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

/** 單份 PDF Blob（供下載、預覽）。 */
export async function createReportPdfBlob(report: StudentReport, header: ReportHeader): Promise<Blob> {
  return fetchReportPdf([report], header)
}
/** 單份：直接下載這位學生的 PDF 檔。 */
export async function downloadSingleReport(report: StudentReport, header: ReportHeader): Promise<void> {
  const blob = await createReportPdfBlob(report, header)
  triggerDownload(blob, reportFileName(report))
}
/** 批次：每位一份 PDF、打包 zip 下載（並發 3、逐份回報進度；失敗自動重試一次、回報是哪幾位）。 */
export type GenerateOptions = { onProgress?: (done: number, total: number) => void }
export type ReportFailure = { studentId: string; seat: string; name: string; error: string }
export async function downloadReportsAsZip(
  reports: StudentReport[], header: ReportHeader, options: GenerateOptions = {}
): Promise<{ generated: number; failed: number; failures: ReportFailure[] }> {
  if (!reports.length) return { generated: 0, failed: 0, failures: [] }
  const { default: JSZip } = await import('jszip')
  const zip = new JSZip()
  let done = 0
  const limit = 3
  let idx = 0
  const failedFirst: StudentReport[] = []
  // 第一輪：並發 3
  await Promise.all(Array.from({ length: Math.min(limit, reports.length) }, async () => {
    while (idx < reports.length) {
      const r = reports[idx++]
      try { zip.file(reportFileName(r), await createReportPdfBlob(r, header)) }
      catch (e) { console.warn(`[parentReport] PDF 產生失敗 座號${r.seat} ${r.name}:`, e); failedFirst.push(r) }
      done++; options.onProgress?.(done, reports.length)
    }
  }))
  // 第二輪：失敗的循序重試一次（多數失敗是並發下 headless Chrome 逾時／冷啟動，單獨重試常會過）
  const failures: ReportFailure[] = []
  for (const r of failedFirst) {
    try { zip.file(reportFileName(r), await createReportPdfBlob(r, header)) }
    catch (e) {
      console.warn(`[parentReport] PDF 重試仍失敗 座號${r.seat} ${r.name}:`, e)
      failures.push({ studentId: r.studentId, seat: r.seat, name: r.name, error: e instanceof Error ? e.message : String(e) })
    }
  }
  const zipBlob = await zip.generateAsync({ type: 'blob' })
  const today = new Date()
  const dateKey = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`
  triggerDownload(zipBlob, `家長報告_${safeFileName(header.className)}_${safeFileName(header.assignmentTitle)}_${dateKey}.zip`)
  return { generated: reports.length - failures.length, failed: failures.length, failures }
}
