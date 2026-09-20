// ═══ 作文・疑似錯別字待確認（2026-09-20 user 設計）═════════════════════════════
// 不共用 LowConfidenceModal（那支 511 行、完全為「逐題批改格」而寫），但版面比照它：
// **一頁列出全部待確認項目**，老師由上往下掃，不是一次一筆。
//
// ⭐ user 拍板的心智模型：老師在乎的**不是 AI 有沒有抄錯，而是最終給學生的建議對不對**。
//   三種情況：
//     ①沒有錯別字（AI 誤報）   → 選「正確無誤」→ 檢討單不出現
//     ②有錯別字、但 AI 抄錯字  → 老師直接改字 → 檢討單才會是對的建議
//     ③有錯別字、AI 也抄對     → 不用理會
//   ⇒ 預設一律「維持 AI 判定」，老師只動需要改的那幾筆。
//
// 分桶規則（server/ai/essay-typo-dict.js）：AI＋教育部辭典都認定＝高信心，直接採用、不進這裡；
// 辭典無法確認＝低信心，才列在這頁。「辭典抓到但 AI 沒抓到」一律無視（實驗命中官方真值 0%）。
// ⛔ 抄寫落差不列入（改抄本不會重跑眉批／級分＝做了等於沒做；檢討單印的是原卷筆跡）。
import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Check, Loader2 } from 'lucide-react'
import type { EssayResult, GradingDetail, Student, Submission } from '@/lib/db'

type Props = {
  entries: Array<{ submission: Submission; student: Student }>
  onClose: () => void
  onUpdated: (updated: Submission) => void
}

type Row = {
  key: string
  submissionId: string
  seat: number | string | null
  name: string
  idx: number
  wrong: string
  correct: string
  context: string
  page: number
  col: number
  row: number
  /** 錯詞的結束格（AI 改以「詞」為單位後，一筆可能橫跨好幾格） */
  toRow: number
  /** 錯詞跨到下一直行（toCol ≠ col）——此時 toRow 屬於**另一行**，不可拿來算本行的裁切範圍 */
  crossCol: boolean
  rows: number
  /** 老師已經處理過的結果（沿用一般卷的原則：低信心永遠保留、只標示已處理） */
  savedVerdict?: 'typo' | 'ok'
  /** AI 原判（老師改過字之後仍要看得到原本 AI 說什麼） */
  aiWrong: string
  aiCorrect: string
}

const essayOf = (s: Submission): { detail: GradingDetail; essay: EssayResult } | null => {
  const details = (s.gradingResult as { details?: GradingDetail[] } | undefined)?.details ?? []
  for (const d of details) {
    const e = (d as { essayResult?: EssayResult }).essayResult
    if (e) return { detail: d, essay: e }
  }
  return null
}

/**
 * 哪些錯別字要進待確認清單——**單一真相**，頂欄計數與本 modal 共用。
 * ⛔ 兩邊各寫一份判斷 → 按鈕顯示 25、清單卻是空的（2026-09-20 實際發生）。
 */
export function buildEssayTypoRows(entries: Array<{ submission: Submission; student: Student }>): Row[] {
  const out: Row[] = []
  for (const { submission, student } of entries) {
    const info = essayOf(submission)
    const typos = info?.essay.feedback?.typos ?? []
    typos.forEach((t, idx) => {
      if (t.confidence === 'high') return          // 高信心直接採用、不進清單
      if (!t.loc?.row) return                      // 沒有格位＝這份是字典分桶上線前批的，重批才會有
      out.push({
        key: `${submission.id}#${idx}`,
        submissionId: submission.id,
        seat: student.seatNumber ?? null,
        name: student.name ?? '',
        idx,
        wrong: t.wrong,
        correct: t.correct,
        context: t.context ?? '',
        page: t.loc.page,
        col: t.loc.col,
        row: t.loc.row,
        toRow: t.loc.toRow ?? t.loc.row,
        crossCol: (t.loc.toCol ?? t.loc.col) !== t.loc.col,
        rows: info?.essay.rows ?? 22,
        savedVerdict: t.teacherVerdict,
        aiWrong: t.aiOriginal?.wrong ?? t.wrong,
        aiCorrect: t.aiOriginal?.correct ?? t.correct,
      })
    })
  }
  return out.sort((a, b) => Number(a.seat ?? 0) - Number(b.seat ?? 0))
}

/** 這份考卷有沒有「舊制」的作文批改（沒有 confidence 欄位＝分桶上線前批的） */
export function hasLegacyEssayTypos(entries: Array<{ submission: Submission }>): boolean {
  return entries.some(({ submission }) => (essayOf(submission)?.essay.feedback?.typos ?? [])
    .some((t) => t.confidence === undefined))
}

/** 錯詞前後各留 2 格當上下文——單獨看不出對錯 */
const PAD_CELLS = 2
/**
 * 左右各外擴多少個「行寬」。
 * ⭐ 批改時的裁圖**故意只含右側窄欄、不含左側**（插入字慣例寫在右側；含左側會把鄰行的
 *    插入字誤收，害 AI 抄錯——見 essay-sheet.js 實驗0 的 5-10 事故）。
 *    但複核畫面的取捨相反：老師用眼睛看，多看到鄰行只會幫助判斷、不會誤收，
 *    而學生把字插在格線外時，只看本行就會「看不到他寫的字」（user 09-20 回報）。
 *    所以這裡左右都外擴，並把目標行框出來避免混淆。
 */
const PAD_COLS = 0.9

/** 把上下文依錯字切成片段，命中的標紅（孤立單字看不出對錯，要放回詞句裡看） */
function splitContext(context: string, wrong: string): Array<{ s: string; hit: boolean }> {
  if (!context) return []
  if (!wrong || !context.includes(wrong)) return [{ s: context, hit: false }]
  const out: Array<{ s: string; hit: boolean }> = []
  for (const part of context.split(wrong)) {
    out.push({ s: part, hit: false })
    out.push({ s: wrong, hit: true })
  }
  out.pop()
  return out.filter((x) => x.s !== '')
}

/** 每份卷的 ImageBitmap 只解一次（清單十幾筆、每筆重解 1900×2899 會很鈍） */
function useBitmapCache() {
  const cache = useRef(new Map<string, Promise<ImageBitmap | null>>())
  useEffect(() => {
    const c = cache.current
    return () => { c.forEach((p) => void p.then((b) => b?.close())); c.clear() }
  }, [])
  return useRef((sub: Submission) => {
    const hit = cache.current.get(sub.id)
    if (hit) return hit
    const p = (async () => {
      try {
        const blob = sub.imageBlob ?? (sub.imageBase64 ? await (await fetch(sub.imageBase64)).blob() : null)
        return blob ? await createImageBitmap(blob) : null
      } catch { return null }
    })()
    cache.current.set(sub.id, p)
    return p
  }).current
}

function TypoCrop({ sub, r, getBmp }: { sub: Submission | undefined; r: Row; getBmp: (s: Submission) => Promise<ImageBitmap | null> }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let dead = false
    let made: string | null = null
    const run = async () => {
      if (!sub) return
      const bmp = await getBmp(sub)
      if (!bmp || dead) return
      const c = essayOf(sub)?.essay.columns.find((x) => x.page === r.page && x.col === r.col)
      if (!c?.bbox) return
      // ⛔ 要涵蓋**整個錯詞**（row~toRow），不能只裁起始格：AI 改以詞為單位後
      //   四字詞只裁「起始格±2」會把尾巴切掉（2026-09-20 實際發生：「寸手不離」只看得到「寸手不」）
      // ⛔ 錯詞跨行時 toRow 屬於**下一行**，拿來算本行範圍會得到負值 → 裁出空白
      //   （2026-09-20 實測 8號「演一出」：row=20、toRow=1 → 裁 18~3 格＝空的）
      //   跨行就一路裁到本行底部，剩下的由下方「學生原文／訂正後」那兩行字補足。
      const cellH = c.bbox.h / Math.max(1, r.rows)
      const from = Math.max(0, r.row - 1 - PAD_CELLS)
      const to = r.crossCol ? r.rows : Math.min(r.rows, r.toRow + PAD_CELLS)
      if (to <= from) return
      const colX = c.bbox.x * bmp.width
      const colW = c.bbox.w * bmp.width
      const padX = colW * PAD_COLS
      const sx = Math.max(0, Math.round(colX - padX))
      const sy = Math.max(0, Math.round((c.bbox.y + from * cellH) * bmp.height))
      const sw = Math.min(bmp.width - sx, Math.round(colW + padX * 2))
      const sh = Math.min(bmp.height - sy, Math.round(cellH * (to - from) * bmp.height))
      if (sw <= 0 || sh <= 0) return
      const canvas = document.createElement('canvas')
      // ⛔ 不要轉向（user 指正）：作文是直書，轉 90° 會讓字躺著、反而難認
      canvas.width = sw
      canvas.height = sh
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh)
      // 外擴後要標出「哪一行才是這筆錯字所在」，否則老師會分不清鄰行
      ctx.strokeStyle = 'rgba(37,99,235,0.85)'
      ctx.lineWidth = Math.max(2, Math.round(colW * 0.03))
      ctx.strokeRect(Math.round(colX - sx), 0, Math.round(colW), sh)
      canvas.toBlob((b) => {
        if (dead || !b) return
        made = URL.createObjectURL(b)
        setUrl(made)
      }, 'image/jpeg', 0.9)
    }
    void run()
    return () => { dead = true; if (made) URL.revokeObjectURL(made) }
  }, [sub, r, getBmp])
  return (
    <div className="shrink-0 w-[190px] min-h-[200px] rounded-lg border border-gray-200 bg-gray-50 flex items-center justify-center overflow-hidden">
      {url ? <img src={url} alt={`${r.wrong} 的稿紙原圖`} className="max-h-[320px] object-contain" />
        : <Loader2 className="w-4 h-4 animate-spin text-gray-400" />}
    </div>
  )
}

type Verdict = 'typo' | 'ok'
type Edit = { verdict: Verdict; wrong: string; correct: string }

export default function EssayTypoLowConfModal({ entries, onClose, onUpdated }: Props) {
  const rows = useMemo(() => buildEssayTypoRows(entries), [entries])
  const legacy = useMemo(() => hasLegacyEssayTypos(entries), [entries])
  const getBmp = useBitmapCache()
  const subOf = (id: string) => entries.find((e) => e.submission.id === id)?.submission

  // 預設＝維持 AI 判定（user：AI 抄對的情況「老師不用理會」）
  const [edits, setEdits] = useState<Record<string, Edit>>({})
  const baseOf = (r: Row): Edit => ({ verdict: r.savedVerdict ?? 'typo', wrong: r.wrong, correct: r.correct })
  const editOf = (r: Row): Edit => edits[r.key] ?? baseOf(r)
  const setEdit = (r: Row, patch: Partial<Edit>) =>
    setEdits((p) => ({ ...p, [r.key]: { ...(p[r.key] ?? baseOf(r)), ...patch } }))

  const [saving, setSaving] = useState(false)
  const dirtyCount = Object.keys(edits).length

  /** 套用：逐份卷重寫 typos（移除選「正確無誤」的、套用老師改過的字） */
  const apply = async () => {
    if (!dirtyCount || saving) return
    setSaving(true)
    try {
      const bySub = new Map<string, Row[]>()
      for (const r of rows) if (edits[r.key]) bySub.set(r.submissionId, [...(bySub.get(r.submissionId) ?? []), r])
      for (const [subId, rs] of bySub) {
        const sub = subOf(subId)
        const info = sub ? essayOf(sub) : null
        if (!sub || !info?.essay.feedback) continue
        // ⛔ 不覆寫 confidence、也不從陣列移除——沿用一般卷低信心 modal 的原則（user 拍板）：
        //   「低信心是 AI 判定當下的事實，永遠保留、不因老師處理而消失或排除」。
        //   老師的處理記在 teacherVerdict；要不要印到檢討單由下游依這個欄位決定。
        const patch = new Map(rs.map((r) => [r.idx, editOf(r)]))
        const typos = info.essay.feedback.typos.map((t, i) => {
          const e = patch.get(i)
          if (!e) return t
          return {
            ...t,
            aiOriginal: t.aiOriginal ?? { wrong: t.wrong, correct: t.correct },  // 留住 AI 原判，可回復
            wrong: e.wrong,
            correct: e.correct,
            teacherVerdict: e.verdict,
          }
        })
        const nextEssay: EssayResult = { ...info.essay, feedback: { ...info.essay.feedback, typos } }
        const details = ((sub.gradingResult as { details?: GradingDetail[] }).details ?? [])
          .map((d) => (d === info.detail ? { ...d, essayResult: nextEssay } : d))
        onUpdated({
          ...sub,
          gradingResult: { ...(sub.gradingResult as object), details } as Submission['gradingResult'],
          updatedAt: Date.now(),
        })
      }
      setEdits({})
      onClose()
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[120] bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="shrink-0 flex items-center gap-3 px-5 py-3 border-b">
          <h2 className="font-semibold text-gray-900">疑似錯別字・待確認</h2>
          <span className="text-sm text-gray-500">{rows.length} 筆{dirtyCount ? `・已修改 ${dirtyCount} 筆` : ''}</span>
          <button type="button" onClick={onClose} aria-label="關閉" className="ml-auto p-1.5 rounded-lg hover:bg-gray-100">
            <X className="w-5 h-5" />
          </button>
        </div>

        {rows.length === 0 ? (
          <div className="flex-1 flex items-center justify-center p-10 text-center text-gray-500 text-sm leading-relaxed">
            {legacy ? (
              <span>這份考卷是<b>字典分桶上線前</b>批改的，錯別字還沒有高／低信心之分。<br />
                <span className="text-xs text-gray-400">重新批改後，字典無法確認的錯別字就會出現在這裡（含稿紙裁圖）。</span></span>
            ) : (
              <span>這份考卷沒有需要確認的錯別字。<br />
                <span className="text-xs text-gray-400">AI 與教育部辭典都認定的錯別字已直接採用；抄寫落差不需要確認。</span></span>
            )}
          </div>
        ) : (
          <>
            <div className="shrink-0 px-5 py-2 bg-amber-50/60 border-b text-[12px] text-amber-900 leading-relaxed">
              對照稿紙筆跡，確認<b>最終要給學生的建議</b>對不對：
              學生其實沒寫錯 → 選「<b>正確無誤</b>」（檢討單不會出現）；
              確實寫錯但 AI 認錯字 → <b>直接改下面的字</b>；AI 判得對 → 不用動。
            </div>

            <div className="flex-1 overflow-y-auto divide-y">
              {rows.map((r) => {
                const e = editOf(r)
                const changed = !!edits[r.key]
                return (
                  <div key={r.key} className={`flex items-start gap-4 px-5 py-4 ${changed ? 'bg-blue-50/40' : ''}`}>
                    <TypoCrop sub={subOf(r.submissionId)} r={r} getBmp={getBmp} />

                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-gray-500 mb-1.5">
                        {r.seat ?? '?'}號 {r.name}・第 {r.page} 頁 第 {r.col} 行 第 {r.row} 格
                        {r.savedVerdict && !changed && (
                          <span className={`ml-2 px-1.5 py-0.5 rounded text-[10px] ${r.savedVerdict === 'ok' ? 'bg-gray-200 text-gray-700' : 'bg-emerald-100 text-emerald-700'}`}>
                            {r.savedVerdict === 'ok' ? '老師判：正確無誤' : '老師已確認'}
                          </span>
                        )}
                        {changed && <span className="ml-2 px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 text-[10px]">未儲存的修改</span>}
                        {r.crossCol && (
                          <span className="ml-2 text-[10px] text-amber-700" title="這個詞從這一行的結尾跨到下一行開頭，裁圖只顯示前半段">
                            （跨行，接續第 {r.col + 1} 行）
                          </span>
                        )}
                        {(r.wrong !== r.aiWrong || r.correct !== r.aiCorrect) && (
                          <span className="ml-2 text-[10px] text-gray-400">AI 原判：{r.aiWrong}→{r.aiCorrect}</span>
                        )}
                      </div>

                      <div className="flex items-center gap-2 mb-2">
                        <input
                          value={e.wrong}
                          onChange={(ev) => setEdit(r, { wrong: ev.target.value, verdict: 'typo' })}
                          aria-label="學生寫的字"
                          className={`w-20 text-center text-2xl font-bold text-red-600 rounded-lg border px-1 py-1 focus:outline-none ${e.verdict === 'ok' ? 'border-gray-200 opacity-40' : 'border-gray-300 focus:border-red-400'}`}
                        />
                        <span className="text-gray-400 text-xl">→</span>
                        <input
                          value={e.correct}
                          onChange={(ev) => setEdit(r, { correct: ev.target.value, verdict: 'typo' })}
                          aria-label="應該寫的字"
                          className={`w-20 text-center text-2xl font-bold text-emerald-700 rounded-lg border px-1 py-1 focus:outline-none ${e.verdict === 'ok' ? 'border-gray-200 opacity-40' : 'border-gray-300 focus:border-emerald-400'}`}
                        />
                        <span className="text-[11px] text-gray-400 ml-1 leading-tight">學生寫的<br />→ 應該寫</span>
                      </div>

                      {/* ⭐ user 指正：孤立一個字無法判斷對錯，**要有詞句才判斷得出來**。
                          所以把上下文擺到主位：上排＝學生原文（錯字標紅）、下排＝套用訂正後的樣子。
                          老師讀兩句話做比較，比盯著單一個字容易得多。 */}
                      <div className="mb-2 rounded-lg bg-gray-50 border border-gray-200 px-3 py-2 text-[15px] leading-relaxed">
                        <div className="text-gray-800 break-all">
                          {splitContext(r.context, r.wrong).map((seg, k) => (
                            <span key={k} className={seg.hit ? 'text-red-600 font-bold underline decoration-red-400 decoration-2 underline-offset-2' : ''}>{seg.s}</span>
                          ))}
                          <span className="ml-2 text-[11px] text-gray-400">學生原文</span>
                        </div>
                        {e.verdict === 'typo' && e.wrong && e.correct && (
                          <div className="text-emerald-800 break-all mt-1">
                            {r.context.split(r.wrong).length > 1
                              ? r.context.split(r.wrong).join(e.correct)   // 專案 TS target 沒有 replaceAll
                              : `（上下文找不到「${r.wrong}」，訂正為：${e.correct}）`}
                            <span className="ml-2 text-[11px] text-emerald-600/70">訂正後</span>
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-4 text-sm">
                        <label className="inline-flex items-center gap-1.5 cursor-pointer">
                          <input type="radio" name={`v-${r.key}`} checked={e.verdict === 'typo'}
                            onChange={() => setEdit(r, { verdict: 'typo' })} />
                          <span>學生確實寫錯</span>
                        </label>
                        <label className="inline-flex items-center gap-1.5 cursor-pointer">
                          <input type="radio" name={`v-${r.key}`} checked={e.verdict === 'ok'}
                            onChange={() => setEdit(r, { verdict: 'ok' })} />
                          <span className="text-gray-700">正確無誤（AI 誤報）</span>
                        </label>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="shrink-0 flex items-center gap-3 px-5 py-3 border-t">
              <span className="text-xs text-gray-500">沒有動過的項目＝維持 AI 判定，不必逐筆確認。</span>
              <div className="flex-1" />
              <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg border text-sm">關閉</button>
              <button type="button" onClick={() => void apply()} disabled={!dirtyCount || saving}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm hover:bg-emerald-700 disabled:opacity-40">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                套用變更{dirtyCount ? `（${dirtyCount}）` : ''}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
