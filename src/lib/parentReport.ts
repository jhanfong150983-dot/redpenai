// 家長學習報告（2026-07-18、B2B MVP、user 拍板）：老師選一份作業 → 批量產生全班家長報告 PDF、打包 zip。
//   一份作業＝一份報告（不跨科合併）。資料全來自既有批改結果＋試題分析，唯一 AI 呼叫＝老師評語（純文字、便宜）。
//   PDF 產出沿用 correctionNoticePdf.ts 骨架（html2canvas→jsPDF、系統中文字型、每生一頁）。
import { getInkSessionId, startInkSession } from '@/lib/ink-session'

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
export type WrongItem = {
  questionId: string
  typeLabel: string
  studentAnswer: string
  referenceAnswer: string
  reason: string
}
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
  opts: { maxWrongs?: number } = {}
): StudentReport[] {
  const maxWrongs = opts.maxWrongs ?? 5
  const qMaxById = new Map<string, number>()
  const qTypeById = new Map<string, string>()
  const qAnswerById = new Map<string, string>()
  for (const q of questions) {
    const id = String(q.id ?? q.questionId ?? '').trim()
    if (!id) continue
    qMaxById.set(id, num(q.maxScore))
    qTypeById.set(id, String(q.questionCategory ?? q.questionType ?? '').trim())
    qAnswerById.set(id, String(q.answer ?? q.referenceAnswer ?? '').trim())
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
    }))

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
      comment: '',
    })
  }
  // 依座號排序
  reports.sort((a, b) => (parseInt(a.seat) || 999) - (parseInt(b.seat) || 999))
  return reports
}

// ── AI 老師評語（鼓勵型、純文字、餵真實成績＋錯題） ──
async function ensureInkSessionId(): Promise<string | null> {
  try {
    const existing = getInkSessionId()
    if (existing) return existing
    const result = await startInkSession()
    return result?.sessionId ?? null
  } catch { return null }
}
function buildCommentPrompt(r: StudentReport, subject: string): string {
  const strong = r.typeRates.filter((t) => t.studentRate >= 80).map((t) => t.label).slice(0, 3)
  const weak = r.typeRates.filter((t) => t.studentRate < 65).map((t) => t.label).slice(0, 3)
  const wrongLines = r.wrongs.slice(0, 4)
    .map((w) => `・${formatQuestionLabel(w.questionId)}（${w.typeLabel}）：${w.reason || '答錯'}`)
    .join('\n') || '（無明顯錯題）'
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
.pr-titlecell { width:230px; text-align:right; }
.pr-title .zh { font-size:16px; font-weight:700; letter-spacing:.18em; color:#1E4D8C; }
.pr-title .mt { font-size:11px; color:#7B8794; margin-top:4px; line-height:1.6; }

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
.pr-note { border:1px solid #D9DEE4; border-left:3px solid #C2402A; padding:12px 16px; font-size:13px; line-height:1.85; color:#52606D; }
.pr-note .sig { text-align:right; color:#7B8794; font-size:12px; margin-top:6px; }
.pr-note .ph { color:#A6AEB8; }
.pr-foot { width:100%; border-collapse:collapse; margin-top:18px; border-top:1px solid #D9DEE4; }
.pr-foot td { padding-top:12px; font-size:10.5px; color:#7B8794; vertical-align:top; }
.pr-foot .r { text-align:right; white-space:nowrap; }
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
    const ansLine = (w.studentAnswer || w.referenceAnswer)
      ? `<div class="pr-ans">孩子的答案：<span class="y">${esc(w.studentAnswer || '（未作答）')}</span>${w.referenceAnswer ? `　正確答案：<span class="r">${esc(w.referenceAnswer)}</span>` : ''}</div>`
      : ''
    return `<tr><td class="qcell"><span class="qno">${esc(formatQuestionLabel(w.questionId))}</span><span class="qt">${esc(w.typeLabel)}</span></td>
      <td>${ansLine}<span class="pr-fix">✎ ${esc(w.reason || '請對照正確答案重新檢視這一題。')}</span></td></tr>`
  }).join('') : `<tr><td colspan="2" style="text-align:center;color:#7B8794;padding:14px">本次沒有明顯失分的題目，表現很好！</td></tr>`
  const moreRow = r.moreWrongCount > 0
    ? `<div class="pr-more">另有 ${r.moreWrongCount} 題失分，完整內容請見孩子的考卷。</div>` : ''
  const commentHtml = r.comment ? esc(r.comment) : `<span class="ph">（老師評語）</span>`

  return `<div class="pr-root">
    <table class="pr-mast"><tbody><tr>
      <td class="crestcell">${crest}</td>
      <td class="pr-school"><div class="nm">${esc(h.schoolName || ' ')}</div></td>
      <td class="pr-titlecell"><div class="pr-title"><div class="zh">${esc(h.subject || '')}　學習報告</div>
        <div class="mt">${esc(h.assignmentTitle || '')}<br>${esc(h.dateStr)}</div></div></td>
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

    <div class="pr-sec">三、重點錯題與訂正方向</div>
    <table class="pr-wtab"><thead><tr><th class="qcell">題號</th><th>作答狀況與訂正方向</th></tr></thead><tbody>${wrongsHtml}</tbody></table>
    ${moreRow}

    <div class="pr-sec">四、老師的話</div>
    <div class="pr-note">${commentHtml}<div class="sig">${esc(h.subject)}科任課老師${h.teacherName ? `　${esc(h.teacherName)}` : ''}　${esc(h.dateStr)}</div></div>

    <table class="pr-foot"><tbody><tr>
      <td>本報告由 AI 批改系統彙整、評語經任課老師審閱．答對率以本次評量實際作答計算</td>
      <td class="r">${esc(h.schoolName)}・${esc(h.subject)}科</td>
    </tr></tbody></table>
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

// ── PDF 產出：單份 blob（個別下載/預覽）＋ 批次 zip（勾選下載） ──
export type GenerateOptions = { onProgress?: (done: number, total: number) => void }

function safeFileName(s: string): string {
  return String(s).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '').slice(0, 60)
}
export function reportFileName(r: StudentReport): string {
  return `${String(r.seat).padStart(2, '0')}_${safeFileName(r.name)}.pdf`
}

// 掛載離屏 staging（注入樣式 + 隱藏容器），回傳「渲染單份→PDF blob」的函式與卸載函式。
async function mountStaging() {
  const [{ default: html2canvas }, jsPDFModule] = await Promise.all([import('html2canvas'), import('jspdf')])
  const JsPDF = jsPDFModule.jsPDF
  const styleEl = document.createElement('style')
  styleEl.textContent = REPORT_CSS
  document.head.appendChild(styleEl)
  const host = document.createElement('div')
  // 高度不固定：讓內容自然流動、html2canvas 依實際高度截圖（避免固定 A4 高度硬切、頁尾疊到長內容）。
  host.style.cssText = 'position:fixed;left:-100000px;top:0;width:794px;pointer-events:none;z-index:-1;background:#fff;'
  document.body.appendChild(host)
  const PAGE_W = 210, PAGE_H = 297
  const renderOne = async (r: StudentReport, header: ReportHeader): Promise<Blob> => {
    host.innerHTML = renderReportHtml(r, header)
    const target = host.firstElementChild as HTMLElement
    const canvas = await html2canvas(target, {
      scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false,
      width: 794, windowWidth: 794,
    })
    const imgData = canvas.toDataURL('image/jpeg', 0.92)
    const doc = new JsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
    // 依實際長寬比放進 A4：正常內容滿版寬、頂端對齊；內容過長時整體縮到一頁高、水平置中（永不切、永不疊）。
    let w = PAGE_W, h = (PAGE_W * canvas.height) / canvas.width, x = 0
    if (h > PAGE_H) { h = PAGE_H; w = (PAGE_H * canvas.width) / canvas.height; x = (PAGE_W - w) / 2 }
    doc.addImage(imgData, 'JPEG', x, 0, w, h, undefined, 'FAST')
    return doc.output('blob')
  }
  return { renderOne, unmount: () => { host.remove(); styleEl.remove() } }
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

/** 產生單一學生報告的 PDF Blob（供個別下載、預覽用）。 */
export async function createReportPdfBlob(report: StudentReport, header: ReportHeader): Promise<Blob> {
  const { renderOne, unmount } = await mountStaging()
  try { return await renderOne(report, header) } finally { unmount() }
}

/** 直接下載單一學生報告 PDF。 */
export async function downloadSingleReport(report: StudentReport, header: ReportHeader): Promise<void> {
  const blob = await createReportPdfBlob(report, header)
  triggerDownload(blob, reportFileName(report))
}

/** 批次：多位學生一起打包 zip 下載。 */
export async function downloadReportsAsZip(
  reports: StudentReport[], header: ReportHeader, options: GenerateOptions = {}
): Promise<{ generated: number }> {
  if (!reports.length) return { generated: 0 }
  const [{ default: JSZip }, staging] = await Promise.all([import('jszip').then((m) => ({ default: m.default })), mountStaging()])
  const zip = new JSZip()
  try {
    for (let i = 0; i < reports.length; i++) {
      const blob = await staging.renderOne(reports[i], header)
      zip.file(reportFileName(reports[i]), blob)
      options.onProgress?.(i + 1, reports.length)
    }
    const zipBlob = await zip.generateAsync({ type: 'blob' })
    const today = new Date()
    const dateKey = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`
    triggerDownload(zipBlob, `家長報告_${safeFileName(header.className)}_${safeFileName(header.assignmentTitle)}_${dateKey}.zip`)
  } finally {
    staging.unmount()
  }
  return { generated: reports.length }
}
