// ═══ 作文・低信心錯別字檢視 Modal（2026-09-20 user 設計）═════════════════════
// 作文卷的低信心跟一般卷不同，所以不共用 LowConfidenceModal（那支是為「逐題批改格」寫的）。
//
// user 拍板的分桶規則（server/ai/essay-typo-dict.js 實作）：
//   AI 抓到 ＋ 教育部辭典確認 → 高信心，直接採用，不進這裡
//   AI 抓到 ＋ 辭典無法確認   → 低信心，進這裡讓老師確認
//   AI 沒抓到 ＋ 辭典抓到     → 無視（實驗：30 筆命中官方真值 0 筆，純雜訊）
//
// ⛔ 抄寫錯誤不列入（user 拍板）：改抄本不會重跑眉批／級分＝做了等於沒做，
//    而且學生檢討單印的是原卷筆跡、抄錯不影響。
//
// 每一筆都附「稿紙上那個字」的裁圖——不看筆跡無法判斷是學生寫錯還是 AI 抄錯
// （實測：低信心桶裡剛好一半是真錯別字、一半是抄寫造成的假錯別字）。
// 裁圖純前端 canvas（同檢討單做法）：用 essayResult.columns[].bbox ＋ loc.row 算格位，零 server 呼叫。
import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Loader2, Check, Trash2 } from 'lucide-react'
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
  idx: number                  // 在該卷 typos 陣列裡的索引
  wrong: string
  correct: string
  context: string
  page: number
  col: number
  row: number
  rows: number
  removed: boolean
}

const essayOf = (s: Submission): { detail: GradingDetail; essay: EssayResult } | null => {
  const details = (s.gradingResult as { details?: GradingDetail[] } | undefined)?.details ?? []
  for (const d of details) {
    const e = (d as { essayResult?: EssayResult }).essayResult
    if (e) return { detail: d, essay: e }
  }
  return null
}

/** 從學生合併圖裁出「該格前後各 2 格」——單獨一個字看不出上下文，很難判斷 */
const PAD_CELLS = 2

function useCrop(sub: Submission | undefined, r: Row | undefined) {
  const [url, setUrl] = useState<string | null>(null)
  const revoke = useRef<string | null>(null)
  useEffect(() => {
    let dead = false
    setUrl(null)
    if (!sub || !r) return
    const src = sub.imageBlob ?? (sub.imageBase64 ? undefined : undefined)
    const load = async () => {
      try {
        const blob = src ?? (sub.imageBase64 ? await (await fetch(sub.imageBase64)).blob() : null)
        if (!blob) return
        const bmp = await createImageBitmap(blob)
        const info = essayOf(sub)
        const c = info?.essay.columns.find((x) => x.page === r.page && x.col === r.col)
        if (!c?.bbox) { bmp.close(); return }
        const cellH = c.bbox.h / Math.max(1, r.rows)
        const top = c.bbox.y + (r.row - 1 - PAD_CELLS) * cellH
        const h = cellH * (1 + PAD_CELLS * 2)
        const sx = Math.max(0, Math.round(c.bbox.x * bmp.width))
        const sy = Math.max(0, Math.round(top * bmp.height))
        const sw = Math.min(bmp.width - sx, Math.round(c.bbox.w * bmp.width))
        const sh = Math.min(bmp.height - sy, Math.round(h * bmp.height))
        if (sw <= 0 || sh <= 0) { bmp.close(); return }
        const canvas = document.createElement('canvas')
        // ⛔ 不要轉向（user 09-20 指正）：作文是直書，轉 90° 會讓字躺著、反而難認。
        //   直接照原方向輸出＝細長直條，版面上擺左邊。
        canvas.width = sw
        canvas.height = sh
        const ctx = canvas.getContext('2d')
        if (!ctx) { bmp.close(); return }
        ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh)
        bmp.close()
        canvas.toBlob((b) => {
          if (dead || !b) return
          const u = URL.createObjectURL(b)
          revoke.current = u
          setUrl(u)
        }, 'image/jpeg', 0.9)
      } catch { /* 裁不出來就不顯示圖，不擋老師判斷 */ }
    }
    void load()
    return () => {
      dead = true
      if (revoke.current) { URL.revokeObjectURL(revoke.current); revoke.current = null }
    }
  }, [sub, r])
  return url
}

/**
 * 哪些錯別字要進待確認清單——**單一真相**，頂欄計數與本 modal 共用。
 * ⛔ 兩邊各寫一份判斷 → 按鈕顯示 25、清單卻是空的（2026-09-20 實際發生：
 *    舊資料沒有 confidence 欄位被算進計數，又因為沒有 loc.row 被清單濾掉）。
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
        removed: false,
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

export default function EssayTypoLowConfModal({ entries, onClose, onUpdated }: Props) {
  const rows = useMemo<Row[]>(() => buildEssayTypoRows(entries), [entries])
  const legacy = useMemo(() => hasLegacyEssayTypos(entries), [entries])

  const [i, setI] = useState(0)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<Record<string, 'kept' | 'removed'>>({})
  const cur = rows[i]
  const subOf = (id: string) => entries.find((e) => e.submission.id === id)?.submission
  const crop = useCrop(cur ? subOf(cur.submissionId) : undefined, cur)

  const next = () => setI((k) => Math.min(rows.length - 1, k + 1))

  /** 移除這一筆錯別字（老師判定 AI 誤報）→ 寫回該卷的 essayResult */
  const remove = async () => {
    if (!cur || busy) return
    const sub = subOf(cur.submissionId)
    const info = sub ? essayOf(sub) : null
    if (!sub || !info?.essay.feedback) return
    setBusy(true)
    try {
      const fb = info.essay.feedback
      const nextEssay: EssayResult = { ...info.essay, feedback: { ...fb, typos: fb.typos.filter((_, k) => k !== cur.idx) } }
      const details = ((sub.gradingResult as { details?: GradingDetail[] }).details ?? [])
        .map((d) => (d === info.detail ? { ...d, essayResult: nextEssay } : d))
      const updated: Submission = {
        ...sub,
        gradingResult: { ...(sub.gradingResult as object), details } as Submission['gradingResult'],
        updatedAt: Date.now(),
      }
      onUpdated(updated)
      setDone((p) => ({ ...p, [cur.key]: 'removed' }))
      next()
    } finally {
      setBusy(false)
    }
  }

  const keep = () => {
    if (!cur) return
    setDone((p) => ({ ...p, [cur.key]: 'kept' }))
    next()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowRight') next()
      if (e.key === 'ArrowLeft') setI((k) => Math.max(0, k - 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, rows.length])

  const handled = Object.keys(done).length

  return (
    <div className="fixed inset-0 z-[120] bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="shrink-0 flex items-center gap-3 px-5 py-3 border-b">
          <h2 className="font-semibold text-gray-900">疑似錯別字・待確認</h2>
          <span className="text-sm text-gray-500">
            {rows.length === 0 ? '沒有待確認的項目' : `第 ${i + 1} / ${rows.length} 筆・已處理 ${handled}`}
          </span>
          <button type="button" onClick={onClose} aria-label="關閉" className="ml-auto p-1.5 rounded-lg hover:bg-gray-100">
            <X className="w-5 h-5" />
          </button>
        </div>

        {rows.length === 0 ? (
          <div className="flex-1 flex items-center justify-center p-10 text-center text-gray-500 text-sm leading-relaxed">
            {legacy ? (
              <>
                這份考卷是<b>字典分桶上線前</b>批改的，錯別字還沒有高／低信心之分。<br />
                <span className="text-xs text-gray-400">重新批改後，字典無法確認的錯別字就會出現在這裡（含稿紙裁圖）。</span>
              </>
            ) : (
              <>
                這份考卷沒有需要確認的錯別字。<br />
                <span className="text-xs text-gray-400">AI 與教育部辭典都認定的錯別字已直接採用；抄寫落差不需要確認。</span>
              </>
            )}
          </div>
        ) : cur && (
          <>
            <div className="flex-1 overflow-y-auto p-5">
              <div className="text-xs text-gray-500 mb-2">
                {cur.seat ?? '?'}號 {cur.name}・第 {cur.page} 頁 第 {cur.col} 行 第 {cur.row} 格
                {done[cur.key] && (
                  <span className={`ml-2 px-1.5 py-0.5 rounded text-[10px] ${done[cur.key] === 'removed' ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'}`}>
                    {done[cur.key] === 'removed' ? '已移除' : '已確認'}
                  </span>
                )}
              </div>

              {/* 左＝稿紙裁圖（直書原方向、該格前後各 2 格）／右＝判斷需要的文字 */}
              <div className="flex items-start gap-5">
                <div className="shrink-0 rounded-xl border border-gray-200 bg-gray-50 p-2 flex items-center justify-center min-w-[92px] min-h-[240px]">
                  {crop
                    ? <img src={crop} alt={`${cur.wrong} 的稿紙原圖`} className="max-h-[300px] object-contain" />
                    : <Loader2 className="w-5 h-5 animate-spin text-gray-400" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-3 mb-2">
                    <span className="text-4xl font-bold text-red-600">{cur.wrong}</span>
                    <span className="text-gray-400">→</span>
                    <span className="text-4xl font-bold text-emerald-700">{cur.correct}</span>
                  </div>
                  <p className="text-sm text-gray-600 break-all">AI 抄到的上下文：{cur.context}</p>
                  <p className="mt-4 text-xs text-gray-500 leading-relaxed">
                    對照左邊的筆跡判斷：學生<b>真的</b>把「{cur.correct}」寫成「{cur.wrong}」→ 保留；
                    學生其實寫對了（是 AI 抄錯）→ 移除。移除後不會出現在學生的檢討單上。
                  </p>
                </div>
              </div>
            </div>

            <div className="shrink-0 flex items-center gap-2 px-5 py-3 border-t">
              <button type="button" onClick={() => setI((k) => Math.max(0, k - 1))} disabled={i === 0}
                className="px-3 py-2 rounded-lg border text-sm disabled:opacity-40">上一筆</button>
              <div className="flex-1" />
              <button type="button" onClick={() => void remove()} disabled={busy}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-red-200 text-red-700 text-sm hover:bg-red-50 disabled:opacity-50">
                <Trash2 className="w-4 h-4" /> 不是錯字，移除
              </button>
              <button type="button" onClick={keep} disabled={busy}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm hover:bg-emerald-700 disabled:opacity-50">
                <Check className="w-4 h-4" /> 確認是錯字
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
