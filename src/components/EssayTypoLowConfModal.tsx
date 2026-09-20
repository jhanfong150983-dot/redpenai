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
  rows: number
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
        rows: info?.essay.rows ?? 22,
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

/** 該格前後各 2 格——單獨一個字看不出上下文，很難判斷 */
const PAD_CELLS = 2

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
      const cellH = c.bbox.h / Math.max(1, r.rows)
      const sx = Math.max(0, Math.round(c.bbox.x * bmp.width))
      const sy = Math.max(0, Math.round((c.bbox.y + (r.row - 1 - PAD_CELLS) * cellH) * bmp.height))
      const sw = Math.min(bmp.width - sx, Math.round(c.bbox.w * bmp.width))
      const sh = Math.min(bmp.height - sy, Math.round(cellH * (1 + PAD_CELLS * 2) * bmp.height))
      if (sw <= 0 || sh <= 0) return
      const canvas = document.createElement('canvas')
      // ⛔ 不要轉向（user 指正）：作文是直書，轉 90° 會讓字躺著、反而難認
      canvas.width = sw
      canvas.height = sh
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh)
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
    <div className="shrink-0 w-[74px] min-h-[180px] rounded-lg border border-gray-200 bg-gray-50 flex items-center justify-center overflow-hidden">
      {url ? <img src={url} alt={`${r.wrong} 的稿紙原圖`} className="max-h-[230px] object-contain" />
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
  const editOf = (r: Row): Edit => edits[r.key] ?? { verdict: 'typo', wrong: r.wrong, correct: r.correct }
  const setEdit = (r: Row, patch: Partial<Edit>) =>
    setEdits((p) => ({ ...p, [r.key]: { ...(p[r.key] ?? { verdict: 'typo', wrong: r.wrong, correct: r.correct }), ...patch } }))

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
        const drop = new Set(rs.filter((r) => editOf(r).verdict === 'ok').map((r) => r.idx))
        const patch = new Map(rs.filter((r) => editOf(r).verdict === 'typo').map((r) => [r.idx, editOf(r)]))
        const typos = info.essay.feedback.typos
          // 老師確認過＝以老師為準 → 升成高信心，之後不再出現在待確認清單
          .map((t, i) => {
            const e = patch.get(i)
            return e ? { ...t, wrong: e.wrong, correct: e.correct, confidence: 'high' as const, dictReason: 'teacher-confirmed' } : t
          })
          .filter((_, i) => !drop.has(i))
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
                        {changed && <span className="ml-2 px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 text-[10px]">已修改</span>}
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
