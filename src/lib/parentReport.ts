// 家長學習報告（2026-07-18 B2B MVP → 2026-08-11 退回無 AI 版、皆 user 拍板）：
//   老師選一份作業 → 全班家長報告 PDF、打包 zip。一份作業＝一份報告（不跨科合併）。
//   報告＝純程式確定性產物（成績/落點/題型/知識點加強地圖/錯題裁圖＋正解＋班級狀況），
//   永遠對應最新批改、重批不需重生；「為什麼錯」的解讀歸老師專業——AI 逐題診斷與評語草擬已移除。
//   唯一留在此檔的 AI 呼叫＝知識點歸類（runKpUpgrade 系列；新卷建卷預跑、舊卷報告頁補跑）。
//   PDF 產出沿用原 correctionNoticePdf 骨架（html2canvas→jsPDF、系統中文字型、每生一頁；該檔已於 2026-08-12 退役刪除）。
import { ALL_MATH_NODES } from '@/data/curriculumNodes'

import { ensureInkSessionFresh } from '@/lib/ink-session'
import { MASTERY_THRESHOLDS, capLevelDesc, CAP_LEVEL_DISCLAIMER } from '@/lib/cap-levels'

const GEMINI_PROXY_URL = import.meta.env?.VITE_GEMINI_PROXY_URL || '/api/proxy'
const COMMENT_MODEL = 'gemini-2.5-flash' // KP 歸類等純文字呼叫、便宜足夠

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
  analysis?: { topic?: string; knowledgePoints?: string[]; code?: string; nodeId?: string; ability?: string; cnaArea?: string; note?: string }
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
  classFull: number      // 全班此題拿滿分人數(2026-08-11 user:讓家長讀出相對位置——大家都會/都不會)
  classTotal: number     // 全班已批改人數
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
    const code = String(q.analysis?.code ?? '').trim()
    const kps = (q.analysis?.knowledgePoints ?? []).map((k) => String(k).trim()).filter((k) => k && k !== '無法對應')
    // 2026-07-22 user 拍板：主題顯示完整「代碼＋短名」（如 Ab-IV-1 字形字音字義）；無 code 的舊資料維持純短名
    if (topic && topic !== '無法對應') { qTopicById.set(id, code ? `${code} ${topic}` : topic); anyAnalysis = true }
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

  // 全班逐題滿分統計(2026-08-11 user):錯題卡顯示「全班 N/M 人拿滿分」——數字自己說話,
  //   家長讀出三種訊息:大家都會=應該也要會/大家都不會我會=優秀/大家都不會=正常
  const qFullMark = new Map<string, { full: number; total: number }>()
  for (const p of papers) {
    for (const d of p.details) {
      const qid = String(d.questionId ?? '').trim()
      const mx = num(d.maxScore) > 0 ? num(d.maxScore) : (qMaxById.get(qid) || 0)
      if (!qid || !(mx > 0)) continue
      const e = qFullMark.get(qid) ?? { full: 0, total: 0 }
      e.total++
      if (num(d.score) >= mx) e.full++
      qFullMark.set(qid, e)
    }
  }

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
        classFull: qFullMark.get(x.qid)?.full ?? 0,
        classTotal: qFullMark.get(x.qid)?.total ?? 0,
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
    // 2026-08-07 門檻抽到 lib/cap-levels.ts 集中管理(該檔註記了會考的實際門檻與「不照搬」的理由)
    const bandOf = (rate: number): 'red' | 'amber' | 'green' =>
      rate >= MASTERY_THRESHOLDS.topic.green ? 'green' : rate >= MASTERY_THRESHOLDS.topic.amber ? 'amber' : 'red'
    const levelOf = (rate: number): KpLevel =>
      rate >= MASTERY_THRESHOLDS.kp.expert ? 'expert' : rate >= MASTERY_THRESHOLDS.kp.basic ? 'basic' : 'weak'
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

// ── 墨水會話（KP 歸類等付費呼叫用） ──
async function ensureInkSessionId(): Promise<string | null> {
  // 用 fresh 版：會話過期/剩<60s 自動續期，避免長時間停留後送舊 id 被判「會話已過期」。
  try { const { sessionId } = await ensureInkSessionFresh(); return sessionId }
  catch { return null }
}
/* 2026-08-11 退回無 AI 版（user 拍板：「為什麼錯」歸老師的專業與責任）：
   AI 老師評語（generateParentComment）與逐題錯因診斷（generateParentDiagnosis）整個移除——
   報告改為純程式確定性產物；老師的話一律手動輸入。DiagnosisItem 型別保留給舊快取回讀（只取評語）。 */
export type DiagnosisItem = { why: string; suggest: string }

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

// ── 家長報告舊快取（parent_reports）：無 AI 版後只回讀「評語」讓老師先前寫過的話不消失；
//    診斷欄位與 stale 指紋不再使用（報告即時計算、無失效概念）。不再寫入。 ──
const PARENT_CACHE_ENDPOINT = '/api/report/parent-cache'
export type CachedReport = { diagnosis: Record<string, DiagnosisItem>; comment: string; stale: boolean }

/** 載入某作業已快取的舊評語；回 Map<studentId, CachedReport>（diagnosis/stale 僅為相容保留）。 */
export async function loadParentReportCache(assignmentId: string): Promise<Map<string, CachedReport>> {
  const out = new Map<string, CachedReport>()
  if (!assignmentId) return out
  // 逾時保護：放寬到 20s、避免冷啟動/大回應被砍掉害老師以為評語不見。
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

/** 把 why/suggest 與截圖（cropDataUrl）併回報告的 errorRows，回新報告（不改原物件）。
 *  2026-08-11 無 AI 版後只剩截圖用途（diag 一律傳空 Map）；簽名保留、少動呼叫端。 */
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

// ── 版面 CSS ──
// ⚠ html2canvas 相容性鐵則：一律 table 佈局＋垂直 middle、絕不用 flexbox 對齊或 CSS transform
//   （2026-07-18 實測跑版根因＝transform:translateX 與 flex align 在 html2canvas 渲染不準）。
//   置中：table-cell vertical-align:middle + text-align；橫向定位：left/right 絕對定位＋固定寬 margin，不用 transform。
export const REPORT_CSS = `
/* 2026-08-03 修「報告貼到紙張邊邊」(user 實測):留白原本做在 .pr-root 的 padding 上,
   那是「整個流動區塊」的內距、只在頭尾各出現一次——一位學生的報告超過一頁時,
   第 2 頁以後就從紙緣開始。留白必須交給 @page margin,才會每一頁都有。 */
.pr-root { width:auto; box-sizing:border-box; background:#fff; color:#1F2933;
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
  border-bottom:1px solid #D9DEE4; padding-bottom:6px; break-after:avoid; page-break-after:avoid; }

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
.pr-topic { border:1px solid #E8ECF0; border-left-width:4px; border-radius:5px; padding:11px 14px; margin-bottom:9px; break-inside:avoid; page-break-inside:avoid; }
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
.pr-mgroup { break-inside:avoid; page-break-inside:avoid; }
.pr-mtopic { font-size:12.5px; font-weight:700; color:#1F2933; margin:12px 0 7px; }
.pr-mtopic-badge { display:inline-block; font-size:10.5px; font-weight:700; padding:1px 8px; border-radius:3px; margin-left:8px; }
.pr-cgrid { display:flex; flex-wrap:wrap; gap:6px; }
/* 2026-08-07 圖例＝三等第說明（會考能力等級描述、整份只出現一次）＋主題答對率 */
.pr-mlgd-row { display:flex; align-items:baseline; gap:6px; margin-top:4px; font-size:11px; line-height:1.65; }
.pr-mlgd-row b { flex:0 0 44px; color:#52606D; font-weight:700; }
.pr-mlgd-row .d { color:#7B8794; }
.pr-mtopic-rate { font-size:10.5px; font-weight:600; color:#7B8794; margin-left:8px; }
.pr-capdis { margin-top:8px; padding-top:6px; border-top:1px dashed #E2E7EB; font-size:9.5px; color:#98A2AB; line-height:1.6; }
.pr-cell { font-size:12.5px; font-weight:600; padding:6px 11px; border-radius:4px; color:#fff; letter-spacing:.01em; }
.pr-cell.expert { background:#256B4C; }
.pr-cell.basic { background:#9A5B00; }
.pr-cell.weak { background:#B0301C; }
.badge-green { background:#E6F4EC; color:#2E6B4F; }
.badge-amber { background:#F4E4C1; color:#8A5A08; }
.badge-red { background:#F6D5CE; color:#A5331F; }
/* 2026-07-22 user 要求四接著三：拔掉強制換頁、自然流動（卡片各自 break-inside:avoid 保不切） */
.pr-page2 { margin-top:4px; }
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
/* 2026-08-03 修「選擇題超大張、填空題反而小」(user 實測 PDF 回報):
   原本裁圖一律拉成 210px 寬,但各題型的答案框寬度差 10 倍——
   單選題框只有頁寬 4%(放大 3 倍變巨無霸)、填空題框有 39%(縮成 1/3 看不清)。
   改成用「高度」對齊:所有裁圖同一個高度上限,寬度隨長寬比自然延伸、再受寬度上限保護。
   手寫字的大小由框高決定,對齊高度=每張的字看起來一樣大。 */
.pr-qbody { display:flex; gap:14px; margin-bottom:9px; align-items:flex-start; }
.pr-qr .cls { color:#5B6B7C; }
.pr-wcrop img { display:block; max-height:52px; max-width:300px; border:1px solid #E4E8EC; border-radius:4px; margin-bottom:4px; }
.pr-wcls { font-size:11px; color:#5B6B7C; margin:2px 0; }
.pr-qcrop { flex:0 0 auto; }
.pr-qcrop img { display:block; width:auto; height:auto; max-height:60px; max-width:320px; border:1px solid #E4E8EC; border-radius:4px; }
.pr-qinfo { flex:1 1 0; min-width:0; }
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
  // 2026-08-11(user):基礎版錯題也帶作答裁圖+班級狀況——裁圖=server 現切、零 AI 零墨水,
  //   本來就在 preview/download 時抓進 errorRows,初階只是沒渲染;由 errorRows 依 questionId 補上。
  const errRowByQid = new Map(r.errorRows.map((e) => [e.questionId, e]))
  const wrongsHtml = r.wrongs.length ? r.wrongs.map((w) => {
    const er = errRowByQid.get(w.questionId)
    const shownStu = w.imageJudged ? '圖像辨識' : (w.studentAnswer || '（未作答）')
    const cropImg = er?.cropDataUrl ? `<div class="pr-wcrop"><img src="${esc(er.cropDataUrl)}"></div>` : ''
    const ansLine = (w.studentAnswer || w.referenceAnswer || w.imageJudged)
      ? `<div class="pr-ans">孩子的答案：<span class="y"${w.imageJudged ? ' style="color:#6B7684"' : ''}>${esc(shownStu)}</span>${w.referenceAnswer ? `　正確答案：<span class="r">${esc(w.referenceAnswer)}</span>` : ''}</div>`
      : ''
    const clsLine = er && er.classTotal > 0
      ? `<div class="pr-wcls">班級狀況：全班 ${er.classTotal} 人中 ${er.classFull} 人此題拿滿分</div>`
      : ''
    return `<tr><td class="qcell"><span class="qno">${esc(formatQuestionLabel(w.questionId))}</span><span class="qt">${esc(w.typeLabel)}</span></td>
      <td>${cropImg}${ansLine}${clsLine}<span class="pr-fix">✎ ${esc(w.reason || '請對照正確答案重新檢視這一題。')}</span></td></tr>`
  }).join('') : `<tr><td colspan="2" style="text-align:center;color:#7B8794;padding:14px">本次沒有明顯失分的題目，表現很好！</td></tr>`
  const moreRow = r.moreWrongCount > 0
    ? `<div class="pr-more">另有 ${r.moreWrongCount} 題失分，完整內容請見孩子的考卷。</div>` : ''
  // 第三段：精熟程度總覽（全部主題+知識點、三色點）
  // 2026-08-07 圖例升級為「等第說明」：三個等第各配一句會考官方能力等級描述（整份報告只出現一次＝
  //   等第是什麼意思講清楚就好；逐主題重複同一句沒有資訊量、user 退回）。科目對不上會考五科→ 退回原本純色塊圖例。
  const capGloss = (['green', 'amber', 'red'] as const)
    .map((b) => ({ b, d: capLevelDesc(h.subject, b) }))
    .filter((x) => x.d)
  const legendRow = (color: string, label: string, desc?: string) =>
    `<div class="pr-mlgd-row"><span class="pr-mlgd-dot" style="background:${color}"></span><b>${label}</b>${desc ? `<span class="d">${esc(desc)}</span>` : ''}</div>`
  const masteryLegend = capGloss.length === 3
    ? `<div class="pr-mlegend">每一格是一個知識點，顏色代表掌握狀態：
        ${legendRow('#256B4C', '精熟', capGloss[0].d!.current)}
        ${legendRow('#9A5B00', '基礎', capGloss[1].d!.current)}
        ${legendRow('#B0301C', '待加強', capGloss[2].d!.current)}
        <div class="pr-capdis">${esc(CAP_LEVEL_DISCLAIMER)}</div>
      </div>`
    : `<div class="pr-mlegend">每一格是一個知識點，顏色代表掌握狀態：<span class="pr-mlgd-dot" style="background:#256B4C"></span>精熟　<span class="pr-mlgd-dot" style="background:#9A5B00"></span>基礎　<span class="pr-mlgd-dot" style="background:#B0301C"></span>待加強</div>`
  // 2026-08-07 主題列補「該主題的答對率」——ratePct 本來就算好了但沒顯示；
  //   這是真正逐主題不同的資訊（等第語言只是三個等第的通用解釋、放在圖例即可，見 masteryLegend）。
  const masteryHtml = r.topicMastery.map((t) => {
    const badge = t.band === 'green' ? 'badge-green' : t.band === 'amber' ? 'badge-amber' : 'badge-red'
    const badgeText = t.band === 'green' ? '精熟' : t.band === 'amber' ? '基礎' : '待加強'
    const cells = t.kps.map((k) => `<span class="pr-cell ${k.level}">${esc(k.kp)}</span>`).join('')
    // pr-mgroup 包裹＝主題標題與其知識點格永遠同頁（分頁不可切開、user 回饋）
    return `<div class="pr-mgroup"><div class="pr-mtopic">${esc(t.topic)}<span class="pr-mtopic-badge ${badge}">${badgeText}</span><span class="pr-mtopic-rate">答對率 ${t.ratePct}%</span></div><div class="pr-cgrid">${cells}</div></div>`
  }).join('')
  // 第四段：逐題錯題分析（全部錯題、依題號排序；crop/why/suggest 由 generate 流程填）
  const errorCards = r.errorRows.map((e) => {
    const crop = e.cropDataUrl ? `<div class="pr-qcrop"><img src="${esc(e.cropDataUrl)}"></div>` : ''
    const shownStudent = e.imageJudged
      ? `<span class="you imgjudge">圖像辨識</span>`
      : `<span class="you">${esc(e.studentAnswer || '（空白）')}</span>`
    const classStat = e.classTotal > 0
      ? `<div class="pr-qr"><span class="l">班級狀況</span><span class="cls">全班 ${e.classTotal} 人中 ${e.classFull} 人此題拿滿分</span></div>`
      : ''
    const info = `<div class="pr-qinfo">
        <div class="pr-qr"><span class="l">AI 讀到</span>${shownStudent}</div>
        <div class="pr-qr"><span class="l">標準答案</span><span class="ans">${esc(e.referenceAnswer || '—')}</span></div>
        ${classStat}
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
  // 2026-08-11 無 AI 版：評語一律老師手動輸入；留空＝印空白欄位（含署名），紙本可手寫。
  const commentHtml = r.comment ? esc(r.comment) : '&nbsp;'
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

// ── 知識點歸類（2026-07-22、進階報告升級流程；每卷一次性、懶跑）─────────────────
//   tagging：餵整本題本圖（proxy 注入）＋答案清單 → 每題 {topic, knowledgePoints}；
//   kpTips：純文字、每知識點一句在家建議；save：POST kp-save 外科手術合併進 answer_key。
//   2026-07-22 三層版（沙盒 5 輪實證）：課綱指標(固定候選)→白話主題(per-指標候選)→知識點(收斂規則)。
//   有指標清單的科目走三層；其他科目 fallback 自由命名版。code 跨卷穩定、供未來趨勢聚合；
//   知識點名稱輪間會變（實測跨輪 0 重合）→ 只服務單卷加強地圖、跨卷聚合一律用 code/topic 層。
export type KpTagItem = { questionId: string; code?: string; nodeId?: string; topic: string; knowledgePoints: string[]; ability?: string; note?: string }

// 108 課綱國語文（第四學習階段）學習內容條文——2026-07-22 已對照 concept_map 表官方版逐字核對。
// 格式：代碼｜主題短名（報告顯示「代碼＋短名」、user 拍板）｜官方條文（＋括號內為使用註記）
const KP_CODE_SPEC_GUOYU = `Ab-IV-1｜字形字音字義｜4,000個常用字的字形、字音和字義（含國字書寫與注音辨識）
Ab-IV-3｜造字原則｜基本的造字原則：象形、指事、會意、形聲
Ab-IV-4｜語詞認念｜6,500個常用語詞的認念（詞義理解、課文注釋）
Ab-IV-5｜語詞使用｜5,000個常用語詞的使用（含成語運用）
Ab-IV-6｜文言詞彙與語法｜常用文言文的詞彙及語法結構
Ab-IV-7｜文言虛字與古今義變｜常用文言文的字詞、虛字、古今義變（含虛字／詞性辨析）
Ab-IV-8｜書法與碑帖欣賞｜各體書法與名家碑帖的認識與欣賞（含字體演變順序與判別）
Ac-IV-1｜標點符號｜標點符號在文本中的不同效果
Ac-IV-2｜句型｜敘事、有無、判斷、表態等句型
Ac-IV-3｜文句邏輯｜文句表達的邏輯與意義
Ad-IV-1｜篇章分析｜篇章的主旨、結構、寓意與分析（白話課外文本、跨文本比較）
Ad-IV-2｜現代文學｜新詩、現代散文、現代小說、劇本
Ad-IV-3｜韻文｜古體詩、樂府詩、近體詩、詞、曲等
Ad-IV-4｜非韻文｜古文、古典小說、語錄體、寓言等
Bc-IV-3｜圖表資訊判讀｜數據、圖表、圖片、工具列等輔助說明`

const KP_RULES_GUOYU = `- 課文或詩文的「詞語解釋／注釋」題，不論詞語是白話或文言，一律選 Ab-IV-4。
- 考「同一字在不同句子的字義是否相同」（一字多義）→ Ab-IV-1。
- 專考虛字、字詞詞性辨析的題目 → Ab-IV-7。
- 「書法字體、字體演變」題（即使附字體圖片）→ Ab-IV-8，不歸 Bc-IV-3；其他需判讀圖表、數據或圖片資訊的題目（即使同時有文字閱讀）→ Bc-IV-3。
- 文言小說、古文、寓言等課外文言素材的閱讀題 → Ad-IV-4；白話課外文本與跨文本「比較」題 → Ad-IV-1；但以「課內近體詩」為主要素材的題目（含格律、文意綜合分析）→ Ad-IV-3。
- 詩句／文句「重組」題依素材文體歸 Ad-IV-2 或 Ad-IV-3，不歸 Ac-IV-3。
- 同一大題內性質相同的題目（例如整組注釋題、整組成語題）code 必須一致。`

// 108 課綱數學（國一／七年級）學習內容條文——concept_map 表官方版（2026-07-22）。⚠限國一：國二/三條文 DB 尚未收錄。
const KP_CODE_SPEC_MATH7 = `N-7-1｜100以內的質數｜質數判別、質數表
N-7-2｜質因數分解的標準分解式｜質因數分解、最大公因數、最小公倍數
N-7-3｜負數與整數的四則混合運算｜含絕對值
N-7-4｜數的運算規律｜交換律、結合律、分配律
N-7-5｜數線（含負數）｜數線上的點與距離
N-7-6｜指數的意義｜指數記號
N-7-7｜指數律｜同底數乘除、次方
N-7-8｜科學記號｜大數與小數的科學記號表示
N-7-9｜比與比例式｜比值、正反比
A-7-1｜代數符號｜以符號代表數、式子的化簡
A-7-2｜一元一次方程式的意義｜列式、驗算解
A-7-3｜一元一次方程式的解法與應用｜解方程式、應用問題
A-7-4｜二元一次聯立方程式的意義｜列式、驗算解
A-7-5｜二元一次聯立方程式的解法與應用｜代入／加減消去、應用問題
A-7-6｜二元一次聯立方程式的幾何意義｜直線圖形
A-7-7｜一元一次不等式的意義｜列不等式、判斷解
A-7-8｜一元一次不等式的解與應用｜解不等式、應用問題
G-7-1｜平面直角坐標系｜坐標、象限
D-7-1｜統計圖表｜長條圖、折線圖、圓形圖等判讀與繪製
D-7-2｜統計數據｜平均數、中位數、眾數
S-7-1｜簡單圖形與幾何特徵｜點線面、角、平面與立體圖形特徵
S-7-2｜三視圖｜立體圖形的視圖
S-7-3｜垂直｜垂直的意義與性質
S-7-4｜線對稱的性質｜對稱軸、對稱點
S-7-5｜線對稱的基本圖形｜等腰三角形、正多邊形等`

const KP_RULES_MATH = `- 要求「解出」方程式／不等式的計算題與應用問題 → 解法與應用條（A-7-3、A-7-5、A-7-8）；只考「列式、意義、判斷某數是否為解」的概念題 → 意義條（A-7-2、A-7-4、A-7-7）。
- 依情境規則推導數值範圍的題目（例如由四捨五入規則回推原始區間）→ A-7-8。
- 幾何圖形（三角形內角、周長面積等）僅為情境、解題核心是列出並求解不等式／方程式 → 歸 A-7-x 代數條，不歸 S。
- 統計題：判讀或繪製圖表 → D-7-1；計算平均數、中位數、眾數等數據量 → D-7-2；同時有圖表與計算時，以最後要回答的量為準。
- 幾何題以主要考點歸類：三視圖／立體視圖 → S-7-2；正多邊形等基本對稱圖形的「辨識與對稱軸數量」→ S-7-5；利用對稱軸／對稱點「性質做推理」（如對摺結果、對稱點座標）→ S-7-4；一般圖形特徵 → S-7-1。
- 同一大題內性質相同的題目 code 必須一致。`

// 沒有科目專屬判準時的通用規則（動態清單科目用）
const KP_RULES_GENERIC = `- 每題選「最能代表解題核心考點」的一條；題目素材／情境（如新聞、生活場景）不影響歸類。
- 同一大題內性質相同的題目 code 必須一致。`

// 已沙盒驗證的固定清單（國語=第四學習階段全國中共用；數學清單限國一）
function curatedSubjectSpec(subj: string, grade?: number): { spec: string; rules: string } | undefined {
  if (subj === '國語' || subj === '國文' || subj === '國語文') return { spec: KP_CODE_SPEC_GUOYU, rules: KP_RULES_GUOYU }
  if (subj === '數學' && (grade === undefined || grade === 7)) return { spec: KP_CODE_SPEC_MATH7, rules: KP_RULES_MATH }
  return undefined
}

// 2026-07-22：concept_map 表有全科 7~9 年級課綱條文（3,376 筆）——沒有固定清單的科目/年級
// 從 /api/data/concept-map 動態組清單（code｜label 當短名）；抓不到才 fallback 自由命名版。
async function fetchDynamicSpec(grade: number, domain: string, track?: 'A' | 'B'): Promise<string | null> {
  try {
    const params = new URLSearchParams({ grade: String(grade), domain })
    if (track && grade >= 11) params.set('track', track)
    const res = await fetch(`/api/data/concept-map?${params.toString()}`, { credentials: 'include' })
    if (!res.ok) return null
    const json = (await res.json().catch(() => null)) as { items?: Array<{ code?: string; label?: string; description?: string }> } | null
    const items = (json?.items ?? []).filter((i) => i?.code && i?.label)
    if (!items.length) return null
    return items.map((i) => `${i.code}｜${i.label}${i.description ? `｜${i.description}` : ''}`).join('\n')
  } catch { return null }
}
export type KpUpgradeResult = { items: KpTagItem[]; kpTips: Record<string, string> }

async function callKpRoute(promptText: string, assignmentId: string, withBooklet: boolean): Promise<string> {
  const inkSessionId = await ensureInkSessionId()
  const res = await fetch(GEMINI_PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      model: COMMENT_MODEL,
      contents: [{ role: 'user', parts: [{ text: promptText }] }],
      routeKey: 'report.kp_tagging',
      assignmentId,
      ...(withBooklet ? { withBooklet: true } : {}),
      ...(inkSessionId ? { inkSessionId } : {}),
    }),
  })
  if (!res.ok) throw new Error(`AI 呼叫失敗（${res.status}）`)
  const data = await res.json().catch(() => null)
  return ((data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })?.candidates ?? [])
    .flatMap((c) => c?.content?.parts ?? [])
    .map((p) => (typeof p?.text === 'string' ? p.text : ''))
    .join('')
}

// 共用核心(2026-08-11 抽出):①tagging ②kpTips;transport 由呼叫端注入——
//   報告端=callKpRoute(assignmentId+withBooklet server 注入題本圖)、建卷端=inline 圖片直送。
async function runKpUpgradeCore(
  subject: string,
  questions: PRQuestion[],
  grade: number | undefined,
  callTag: (prompt: string) => Promise<string>,
  callTips: (prompt: string) => Promise<string>,
  track?: 'A' | 'B',
): Promise<KpUpgradeResult> {
  const qs = questions.filter((q) => String(q.id ?? '').trim())
  if (!qs.length) throw new Error('此作業沒有題目')
  const ansList = qs.map((q) => `${q.id}：${resolveStdAnswer(q) || '(無)'}`).join('\n')
  const subj = subject || '學科'
  let subjectSpec = curatedSubjectSpec(subj.trim(), grade)
  if (!subjectSpec && grade) {
    const dyn = await fetchDynamicSpec(grade, subj.trim(), track)
    if (dyn) subjectSpec = { spec: dyn, rules: KP_RULES_GENERIC }
  }
  const codeSpec = subjectSpec?.spec
  // ① tagging（餵題本圖）：有指標清單 → 三層版；否則 fallback 自由命名版
  const tagPrompt = codeSpec ? `你是一位資深的台灣國中${subj}老師，同時是段考命題與課綱對齊專家。
附上一份${subj}科段考「題本」（含所有題目），與答案清單（題號＋標準答案）供對應。

請分三層為每一題歸類：

【第一層：課綱指標 code】只能從下列清單選（每行格式：代碼｜主題短名｜官方條文）：
${codeSpec}

邊界判準（必守、優先於你的自由判斷）：
${subjectSpec!.rules}

【第二層：主題 topic】一律照抄該題所選代碼那一行的「主題短名」（完全同字、不可自創）。

【第三層：知識點 kps】每題 1~2 個，規則（非常重要）：
- 先在輸出最前面承諾全卷知識點清單 kpList：總數不可超過 18 個
- 每個知識點必須至少被 2 題共用（真正獨特的考點可例外、全卷例外最多 3 個）
- 知識點＝可跨題遷移的能力或概念（例：「多音字辨析」「近體詩格律」「借代與代稱」）
- 禁止用題目素材當名稱（例：「棒球規則」「問卷設計」這類都不行）
- 每題的 kps 只能從 kpList 中挑選

另外每題給：
- ability：定義理解／基本應用／情境應用／多步驟推理（擇一）
- note：一句話說明這題在考什麼

只依題本實際內容判斷；找不到或看不清的題號 → code 填 "NA"、topic 填「無法對應」。
答案清單：
${ansList}

只輸出 JSON：
{"kpList":["..."],"items":[{"questionId":"...","code":"...","topic":"...","kps":["..."],"ability":"...","note":"..."}]}` : `你是一位資深的台灣國中${subj}老師，同時是段考命題與試題分析專家。
附上一份${subj}科段考「題本」（含所有題目）。另附答案清單（題號＋標準答案）供你對應題目。
請像分析自己出的卷一樣，針對答案清單中每一個題號指出：
1. topic：大主題／單元（課本「章／單元」等級）。全卷只會有少數幾個大主題；考同一單元的題目 topic 必須完全一致（同字）。
2. knowledgePoints：這題主要考的細部知識點（課本小標／概念等級），1~2 個。
3. ability：能力層次（擇一：定義理解／基本應用／情境應用／多步驟推理）。
4. note：一句話說明這題在考什麼。
只依題本實際內容判斷；某題號在題本找不到或看不清 → topic 填「無法對應」、knowledgePoints 填 ["無法對應"]。
答案清單：
${ansList}
只輸出 JSON：{"items":[{"questionId":"...","topic":"...","knowledgePoints":[...],"ability":"...","note":"..."}]}`
  const tagText = await callTag(tagPrompt)
  const tagMatch = tagText.match(/\{[\s\S]*\}/)
  if (!tagMatch) throw new Error('歸類結果解析失敗')
  const parsed = JSON.parse(tagMatch[0]) as { items?: Array<{ questionId?: string; code?: string; topic?: string; kps?: string[]; knowledgePoints?: string[]; ability?: string; note?: string }> }
  const items: KpTagItem[] = (parsed.items ?? [])
    .filter((it) => it?.questionId && it?.topic && it.topic !== '無法對應' && it.code !== 'NA')
    .map((it) => ({
      questionId: String(it.questionId), topic: String(it.topic),
      ...(it.code ? { code: String(it.code) } : {}),
      knowledgePoints: (it.kps ?? it.knowledgePoints ?? []).map((k) => String(k)).filter((k) => k && k !== '無法對應'),
      ...(it.ability ? { ability: String(it.ability) } : {}), ...(it.note ? { note: String(it.note) } : {}),
    }))
  if (!items.length) throw new Error('歸類沒有產出任何題目')
  // 確定性覆寫（code 兜底優於 prompt、沙盒實測 AI 自選主題會塌）：
  //   ①主題一律＝所選代碼的短名（AI 只負責選 code）；②Ab-IV-1 的細分下放到知識點層：
  //   選擇題→字形字音辨析／注音答案→注音辨識／國字→國字書寫。
  if (codeSpec) {
    const shortByCode = new Map<string, string>(
      codeSpec.split('\n').map((line) => {
        const parts = line.split('｜')
        return [String(parts[0] ?? '').trim(), String(parts[1] ?? '').trim()]
      }),
    )
    const ZHUYIN_RE = /[ㄅ-ㄯˊˇˋ˙]/
    const qById = new Map(qs.map((q) => [String(q.id ?? ''), q]))
    for (const it of items) {
      const short = it.code ? shortByCode.get(it.code) : undefined
      if (short) it.topic = short
      if (it.code !== 'Ab-IV-1') continue
      const q = qById.get(it.questionId)
      if (!q) continue
      const cat = String((q as { questionCategory?: string; questionType?: string }).questionCategory
        ?? (q as { questionType?: string }).questionType ?? '')
      if (/choice/.test(cat)) it.knowledgePoints = ['字形字音辨析']
      else {
        const ans = resolveStdAnswer(q)
        if (ZHUYIN_RE.test(ans)) it.knowledgePoints = ['注音辨識']
        else if (ans) it.knowledgePoints = ['國字書寫']
      }
    }
  }
  // ── 第二層（2026-09-06）：數學科 → 依第一層 code 選「知識節點」──────────────
  //   收斂搜尋空間：每題只在「所選課綱代碼」底下的節點裡選一個（3~9 選 1）。
  //   節點 name 當 knowledgePoints、node.id 存 nodeId；選不到保守留空（不污染標準節點）。
  //   節點表＝自研 curriculumNodes（課綱代碼/ID 為事實識別碼、描述改寫）。目前僅七年級數學有表。
  const isMath = /數學|數/.test(subj)
  if (isMath) {
    // 按第一層 code 分組（只處理表內有節點的 code）
    const nodesByCode = new Map<string, typeof ALL_MATH_NODES>()
    for (const n of ALL_MATH_NODES) {
      if (!nodesByCode.has(n.code)) nodesByCode.set(n.code, [])
      nodesByCode.get(n.code)!.push(n)
    }
    const qById2 = new Map(qs.map((q) => [String(q.id ?? ''), q]))
    // 蒐集「有 code 且該 code 在表內」的題，按 code 分批送第二層
    const groups = new Map<string, KpTagItem[]>()
    for (const it of items) {
      if (!it.code || !nodesByCode.has(it.code)) continue
      if (!groups.has(it.code)) groups.set(it.code, [])
      groups.get(it.code)!.push(it)
    }
    for (const [code, groupItems] of groups) {
      const nodes = nodesByCode.get(code)!
      // 單一節點的 code → 直接指派，不花 AI
      if (nodes.length === 1) {
        for (const it of groupItems) { it.nodeId = nodes[0].id; it.knowledgePoints = [nodes[0].name] }
        continue
      }
      const nodeMenu = nodes.map((n) => `${n.id}｜${n.name}｜${n.desc}`).join('\n')
      const qLines = groupItems.map((it) => {
        const q = qById2.get(it.questionId)
        return `${it.questionId}｜答案：${(q ? resolveStdAnswer(q) : '') || '(無)'}${it.note ? '｜' + it.note : ''}`
      }).join('\n')
      const nodePrompt = `你是台灣國中數學老師。以下這些題目都屬於課綱代碼「${code}」。
請為每一題，從這個代碼底下的「知識節點」清單中選出「最貼切的一個」節點代碼：
${nodeMenu}

規則：
- 每題只選一個節點代碼（上方清單第一欄的代碼，如 ${nodes[0].id}）。
- 選最能代表「這題主要考點」的節點；不確定時選描述最接近的。
- ⚠ 若真的沒有任何節點貼近這題，nodeId 填 "NA"（寧缺勿濫）。
題目清單：
${qLines}
只輸出 JSON：{"picks":[{"questionId":"...","nodeId":"${nodes[0].id} 或 NA"}]}`
      try {
        const nodeText = await callTag(nodePrompt)
        const nm = nodeText.match(/\{[\s\S]*\}/)
        if (!nm) continue
        const picks = (JSON.parse(nm[0]) as { picks?: Array<{ questionId?: string; nodeId?: string }> }).picks ?? []
        const nodeById = new Map(nodes.map((n) => [n.id, n]))
        const pickByQ = new Map(picks.map((p) => [String(p.questionId), String(p.nodeId ?? '')]))
        for (const it of groupItems) {
          const nid = pickByQ.get(it.questionId)
          const node = nid ? nodeById.get(nid) : undefined
          if (node) { it.nodeId = node.id; it.knowledgePoints = [node.name] }
          // 選不到（NA/找不到）→ 保守：留第一層的 knowledgePoints 或空，不硬塞
        }
      } catch (err) {
        console.warn('[KP第二層] 節點歸類失敗（保留第一層結果）:', code, err)
      }
    }
  }

  // ② kpTips（純文字、每知識點一句在家建議）
  const allKps = [...new Set(items.flatMap((it) => it.knowledgePoints))]
  let kpTips: Record<string, string> = {}
  if (allKps.length) {
    const tipPrompt = `你是一位資深、溫暖的台灣國中${subj}老師。以下是一份段考測到的知識點清單。
請為每個知識點寫「一句」給家長、在家可以怎麼幫孩子的**具體**建議：要具體到能做的動作或提醒。不可空泛（「多練習」「多複習」不行）。用家長聽得懂、鼓勵的口吻，每則 30~50 字。
知識點清單：
${allKps.map((k) => `- ${k}`).join('\n')}
只輸出 JSON：{"tips":{"知識點":"一句建議", ...}}`
    try {
      const tipText = await callTips(tipPrompt)
      const m = tipText.match(/\{[\s\S]*\}/)
      if (m) kpTips = (JSON.parse(m[0]) as { tips?: Record<string, string> }).tips ?? {}
    } catch { /* kpTips 失敗不擋主流程（加強地圖仍可用、只是缺建議句） */ }
  }
  return { items, kpTips }
}

// ── 2026-08-11 KP 掛 template 層(跨班公平性前置):補跑前先查模板 ──
//   同一份考卷(模板)的 KP 歸類只該跑一次 AI:第一個班跑完 kp-save 已鏡寫模板,
//   其他班(含分享碼匯入的複製品,answer_key 整包帶著 analysis 過來)從模板免費取用——
//   零 AI 零墨水,且跨班 KP 名稱同一套,班際比較才有意義。
//   覆蓋率 <80% 視為「模板沒有完整歸類」→ 照常跑 AI(半套寧可重跑)。
async function tryKpFromTemplate(assignmentId: string, questions: PRQuestion[]): Promise<KpUpgradeResult | null> {
  try {
    const { db } = await import('@/lib/db')
    const a = await db.assignments.get(assignmentId)
    const tplId = (a as { answerKeyTemplateId?: string } | undefined)?.answerKeyTemplateId
    if (!tplId) return null
    const tpl = await db.answerKeyTemplates.get(tplId)
    const ak = tpl?.answerKey as {
      questions?: Array<{ id?: string; analysis?: { code?: string; topic?: string; knowledgePoints?: string[]; ability?: string; note?: string } }>
      kpTips?: Record<string, string>
    } | undefined
    if (!ak?.questions?.length) return null
    const items: KpTagItem[] = []
    for (const q of ak.questions) {
      const an = q.analysis
      if (!q.id || !an?.topic) continue
      items.push({
        questionId: String(q.id),
        ...(an.code ? { code: an.code } : {}),
        topic: an.topic,
        knowledgePoints: Array.isArray(an.knowledgePoints) ? an.knowledgePoints : [],
        ...(an.ability ? { ability: an.ability } : {}),
        ...(an.note ? { note: an.note } : {}),
      })
    }
    const qids = new Set(questions.map((q) => String((q as { id?: unknown }).id ?? '')).filter(Boolean))
    if (!qids.size) return null
    const covered = items.filter((it) => qids.has(it.questionId)).length
    if (covered / qids.size < 0.8) return null
    console.log(`[kp] 模板已有歸類(${covered}/${qids.size} 題)、免跑 AI 直接取用`)
    return { items, kpTips: ak.kpTips ?? {} }
  } catch { return null }
}

// 報告端入口:先查模板(免費)、沒有才跑 AI;之後 ③ kp-save 寫入 server(外科手術合併、owner 驗證)
export async function runKpUpgrade(assignmentId: string, subject: string, questions: PRQuestion[], grade?: number, track?: 'A' | 'B'): Promise<KpUpgradeResult> {
  const result = (await tryKpFromTemplate(assignmentId, questions)) ?? await runKpUpgradeCore(
    subject, questions, grade,
    (prompt) => callKpRoute(prompt, assignmentId, true),
    (prompt) => callKpRoute(prompt, assignmentId, false),
    track,
  )
  const saveRes = await fetch('/api/report/kp-save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ assignmentId, items: result.items, kpTips: result.kpTips }),
  })
  if (!saveRes.ok) {
    const err = await saveRes.json().catch(() => null)
    throw new Error(`歸類寫入失敗：${(err as { error?: string })?.error ?? saveRes.status}`)
  }
  return result
}

// ── 2026-08-11 建卷預跑(user 拍板):擷取答案 → 108課綱分類 → 逐題知識點,三階段的第三階 ──
//   inline 圖片直送(建卷當下 storage 未必上傳完、不能靠 withBooklet server 注入);
//   不含寫入——呼叫端(AssignmentSetup)自行把 items/kpTips 合併進 answerKey 後存 Dexie+sync。
//   失敗=非致命:報告端「升級為進階版」懶跑路徑原樣保留當兜底。
function kpBlobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}
export async function runKpUpgradeInline(subject: string, questions: PRQuestion[], grade: number | undefined, images: Blob[], track?: 'A' | 'B'): Promise<KpUpgradeResult> {
  const imageParts = await Promise.all(images.map(async (img) => ({
    inlineData: { mimeType: img.type || 'image/jpeg', data: await kpBlobToBase64(img) },
  })))
  const call = (withImages: boolean) => async (promptText: string): Promise<string> => {
    const inkSessionId = await ensureInkSessionId()
    const res = await fetch(GEMINI_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        model: COMMENT_MODEL,
        contents: [{ role: 'user', parts: [{ text: promptText }, ...(withImages ? imageParts : [])] }],
        routeKey: 'report.kp_tagging',
        ...(inkSessionId ? { inkSessionId } : {}),
      }),
    })
    if (!res.ok) throw new Error(`AI 呼叫失敗（${res.status}）`)
    const data = await res.json().catch(() => null)
    return ((data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })?.candidates ?? [])
      .flatMap((c) => c?.content?.parts ?? [])
      .map((pt) => (typeof pt?.text === 'string' ? pt.text : ''))
      .join('')
  }
  return runKpUpgradeCore(subject, questions, grade, call(true), call(false), track)
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
@page { size: A4; margin: 11mm 13mm 9mm; }  /* 每一頁都要留白,不能只靠 .pr-root 的 padding */
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
