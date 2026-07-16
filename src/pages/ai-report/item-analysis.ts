// 試題分析（2026-07-16 第一波、user 拍板）：純程式、零 AI、進頁即算。
// 內容：每題答案樣態/對錯人數、PH/PL（高低分組 27%）、P 難易度、D 鑑別度（Ebel 分級）、
//       選項誘答力、疑似解答問題偵測（≥50% 齊答非正解）、整卷品質（平均 P/D、Cronbach's α）。
// 口徑：二元題（全有全無）＝答對率；部分給分題＝得分率（score/maxScore），UI 需註明。

export type ItemAnalysisQuestion = {
  id?: string
  questionId?: string
  questionType?: string
  questionCategory?: string
  maxScore?: number
  answer?: string
  referenceAnswer?: string
  parts?: Array<{ subId?: string; answer?: string }>
}

type DetailLike = {
  questionId?: string
  score?: number
  maxScore?: number
  isCorrect?: boolean
  studentAnswer?: string
}

export type ItemAnalysisSubmissionLike = {
  gradingResult?: unknown
}

export type OptionStat = {
  label: string
  count: number
  highCount: number
  lowCount: number
  isKey: boolean
  isBlank: boolean
}

export type ItemStat = {
  questionId: string
  questionType: string
  maxScore: number
  keyAnswer: string
  n: number
  correctCount: number
  wrongCount: number
  blankCount: number
  unrecognizableCount: number
  scoreRateAll: number
  ph: number
  pl: number
  p: number
  d: number
  dBand: '優良' | '良好' | '尚可' | '需檢視' | '—'
  pBand: '偏易' | '適中' | '偏難'
  keySuspect: boolean
  deadOptions: string[]
  distribution: OptionStat[]
  isChoiceLike: boolean
  partialCredit: boolean
}

export type ItemAnalysisResult = {
  n: number
  groupSize: number
  lowSample: boolean
  items: ItemStat[]
  meanP: number
  meanD: number
  alpha: number | null
  dBandCounts: Record<string, number>
  flagged: Array<{ questionId: string; why: string }>
}

const CHOICE_LIKE = new Set(['single_choice', 'true_false', 'single_check', 'circle_select_one'])
const BLANK_LABEL = '未作答'
const UNREC_LABEL = '無法辨識'

function parseDetails(gradingResult: unknown): DetailLike[] {
  let gr = gradingResult
  if (typeof gr === 'string') {
    try { gr = JSON.parse(gr) } catch { return [] }
  }
  const details = (gr as { details?: unknown } | null | undefined)?.details
  return Array.isArray(details) ? (details as DetailLike[]) : []
}

// 答案樣態正規化：選項代號去括號/標點、全形轉半形；空值→未作答
function normalizeAnswerLabel(raw: unknown): string {
  let s = String(raw ?? '').trim()
  if (!s || s === BLANK_LABEL) return BLANK_LABEL
  if (s === UNREC_LABEL) return UNREC_LABEL
  s = s.replace(/[（(]\s*(.+?)\s*[）)]/, '$1')
  s = s.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10))
  s = s.replace(/[.。．、,，:：;；\s]+$/g, '')
  // 字母清單型（A、D / A.D / A,D）→ 分隔符統一成逗號、併成同一樣態（不動數字、避免誤傷小數）
  if (/^[A-Za-z]([^A-Za-z0-9]+[A-Za-z])+$/.test(s)) {
    s = s.replace(/[^A-Za-z]+/g, ',').toUpperCase()
  }
  return s || BLANK_LABEL
}

function dBandOf(d: number, degenerate: boolean): ItemStat['dBand'] {
  if (degenerate) return '—'
  if (d >= 0.4) return '優良'
  if (d >= 0.3) return '良好'
  if (d >= 0.2) return '尚可'
  return '需檢視'
}

function pBandOf(p: number): ItemStat['pBand'] {
  if (p > 0.8) return '偏易'
  if (p < 0.4) return '偏難'
  return '適中'
}

export function computeItemAnalysis(
  questions: ItemAnalysisQuestion[],
  submissions: ItemAnalysisSubmissionLike[]
): ItemAnalysisResult | null {
  const qList = (questions || [])
    .map((q) => ({
      id: String(q.id ?? q.questionId ?? '').trim(),
      type: String(q.questionCategory ?? q.questionType ?? '').trim(),
      maxScore: Number(q.maxScore) > 0 ? Number(q.maxScore) : 0,
      key: String(q.answer ?? q.referenceAnswer ?? '').trim(),
      parts: Array.isArray(q.parts) ? q.parts : null
    }))
    .filter((q) => q.id)
  if (!qList.length) return null

  // 每卷：qid → detail
  const papers = submissions
    .map((s) => parseDetails(s.gradingResult))
    .filter((d) => d.length > 0)
    .map((details) => {
      const byQ = new Map<string, DetailLike>()
      for (const d of details) {
        const qid = String(d.questionId ?? '').trim()
        if (qid) byQ.set(qid, d)
      }
      return byQ
    })
  const n = papers.length
  if (n < 3) return null

  const qMax = new Map(qList.map((q) => [q.id, q.maxScore]))
  const scoreOf = (byQ: Map<string, DetailLike>, qid: string): number | null => {
    const d = byQ.get(qid)
    if (!d) return null
    const max = Number(d.maxScore) > 0 ? Number(d.maxScore) : (qMax.get(qid) || 0)
    if (!(max > 0)) return null
    const s = Number(d.score)
    return Math.max(0, Math.min(max, Number.isFinite(s) ? s : 0)) / max
  }

  // 總分排序 → 高/低分組（27%、台灣測驗慣例）
  const totals = papers.map((byQ) => {
    let t = 0
    for (const q of qList) {
      const d = byQ.get(q.id)
      if (d && Number.isFinite(Number(d.score))) t += Number(d.score)
    }
    return t
  })
  const order = totals.map((t, i) => ({ t, i })).sort((a, b) => b.t - a.t)
  const groupSize = Math.max(1, Math.round(n * 0.27))
  const highSet = new Set(order.slice(0, groupSize).map((x) => x.i))
  const lowSet = new Set(order.slice(-groupSize).map((x) => x.i))

  const items: ItemStat[] = []
  for (const q of qList) {
    const isChoiceLike = CHOICE_LIKE.has(q.type)
    let correct = 0, wrong = 0, blank = 0, unrec = 0, present = 0
    let partialCredit = false
    let sumAll = 0, sumHigh = 0, cntHigh = 0, sumLow = 0, cntLow = 0
    const dist = new Map<string, { count: number; high: number; low: number }>()

    papers.forEach((byQ, pi) => {
      const d = byQ.get(q.id)
      if (!d) return
      present++
      const rate = scoreOf(byQ, q.id) ?? 0
      sumAll += rate
      if (highSet.has(pi)) { sumHigh += rate; cntHigh++ }
      if (lowSet.has(pi)) { sumLow += rate; cntLow++ }
      if (rate > 0 && rate < 1) partialCredit = true
      const label = normalizeAnswerLabel(d.studentAnswer)
      if (label === BLANK_LABEL) blank++
      else if (label === UNREC_LABEL) unrec++
      if (d.isCorrect === true) correct++
      else wrong++
      const entry = dist.get(label) ?? { count: 0, high: 0, low: 0 }
      entry.count++
      if (highSet.has(pi)) entry.high++
      if (lowSet.has(pi)) entry.low++
      dist.set(label, entry)
    })
    if (!present) continue

    const keyNorm = normalizeAnswerLabel(q.key)
    const distribution: OptionStat[] = [...dist.entries()]
      .map(([label, v]) => ({
        label,
        count: v.count,
        highCount: v.high,
        lowCount: v.low,
        isKey: label === keyNorm && keyNorm !== BLANK_LABEL,
        isBlank: label === BLANK_LABEL || label === UNREC_LABEL
      }))
      .sort((a, b) => (a.isBlank !== b.isBlank ? (a.isBlank ? 1 : -1) : b.count - a.count))

    const ph = cntHigh ? sumHigh / cntHigh : 0
    const pl = cntLow ? sumLow / cntLow : 0
    const p = (ph + pl) / 2
    const dIdx = ph - pl
    const degenerate = correct === present || correct === 0 // 全對/全錯 → 鑑別度無意義

    // 疑似解答問題：選擇類、≥50% 且 ≥5 人齊答同一個非正解
    const answered = present - blank - unrec
    const keySuspect = isChoiceLike && distribution.some((o) =>
      !o.isKey && !o.isBlank && o.count >= 5 && answered > 0 && o.count >= answered * 0.5)
    // 無效選項：選擇類、正解以外沒人選的常見選項無從得知全部選項——只報「零誘答」的已知選項
    const deadOptions: string[] = []

    items.push({
      questionId: q.id,
      questionType: q.type,
      maxScore: q.maxScore,
      keyAnswer: q.key,
      n: present,
      correctCount: correct,
      wrongCount: wrong,
      blankCount: blank,
      unrecognizableCount: unrec,
      scoreRateAll: sumAll / present,
      ph, pl, p, d: dIdx,
      dBand: dBandOf(dIdx, degenerate),
      pBand: pBandOf(p),
      keySuspect,
      deadOptions,
      distribution,
      isChoiceLike,
      partialCredit
    })
  }
  if (!items.length) return null

  // Cronbach's α（以各題原始得分計；k≥2 且總分有變異才算）
  let alpha: number | null = null
  {
    const k = items.length
    const itemScores = items.map((it) =>
      papers.map((byQ) => {
        const d = byQ.get(it.questionId)
        const s = Number(d?.score)
        return Number.isFinite(s) ? s : 0
      })
    )
    const variance = (arr: number[]) => {
      const m = arr.reduce((a, b) => a + b, 0) / arr.length
      return arr.reduce((a, b) => a + (b - m) * (b - m), 0) / arr.length
    }
    const totalScores = papers.map((_, pi) => itemScores.reduce((a, arr) => a + arr[pi], 0))
    const varTotal = variance(totalScores)
    if (k >= 2 && varTotal > 0) {
      const sumVarItems = itemScores.reduce((a, arr) => a + variance(arr), 0)
      alpha = (k / (k - 1)) * (1 - sumVarItems / varTotal)
    }
  }

  const meanP = items.reduce((a, it) => a + it.p, 0) / items.length
  const meanD = items.reduce((a, it) => a + it.d, 0) / items.length
  const dBandCounts: Record<string, number> = {}
  for (const it of items) dBandCounts[it.dBand] = (dBandCounts[it.dBand] ?? 0) + 1

  const flagged: Array<{ questionId: string; why: string }> = []
  for (const it of items) {
    if (it.keySuspect) {
      const top = it.distribution.find((o) => !o.isKey && !o.isBlank)
      flagged.push({ questionId: it.questionId, why: `疑似解答問題：${top?.count ?? 0}/${it.n} 人齊答「${top?.label ?? ''}」但正解為「${it.keyAnswer}」` })
    } else if (it.dBand === '需檢視') {
      flagged.push({ questionId: it.questionId, why: `鑑別度偏低（D=${it.d.toFixed(2)}${it.d < 0 ? '、低分組反而較高' : ''}）` })
    } else if (it.dBand === '—') {
      flagged.push({ questionId: it.questionId, why: it.correctCount === it.n ? '全班答對（無鑑別力、可視為送分題）' : '全班答錯（無鑑別力、建議檢查題目或教學）' })
    }
  }

  return {
    n,
    groupSize,
    lowSample: n < 12,
    items,
    meanP,
    meanD,
    alpha,
    dBandCounts,
    flagged
  }
}
