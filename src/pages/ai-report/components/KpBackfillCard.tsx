// 2026-09-06 知識點歸類「補跑」卡片（可重用）。
//   原本只有家長報告頁有補跑按鈕；概念雷達才是老師實際看 KP 的地方，舊卷雷達會空/缺節點層，
//   故把同一顆按鈕也做成這個自足元件放到雷達。走 runKpUpgrade（兩層都跑、寫回 server＋模板、全班共用）。
//   ⚠ Dexie merge 寫全 analysis（含 code / nodeId）——雷達靠 analysis.code 分軸、下鑽靠 nodeId，
//     不可像家長報告頁那版只寫 topic/knowledgePoints（會讓雷達暫時掉軸）。
//   ⚠ 雷達資料來源是 syncData（非 Dexie）→ 補跑後需「重新整理頁面」重新 sync 才會反映（server 已寫入）。

import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { runKpUpgrade, type KpUpgradeResult } from '@/lib/parentReport'
import { db } from '@/lib/db'

type QLike = { id?: string; analysis?: unknown }

export default function KpBackfillCard({
  assignmentId, subject, questions, grade, requestInk, onSaved, hint, ctaLabel = '補跑知識點歸類',
}: {
  assignmentId: string
  subject: string
  questions: QLike[]
  grade?: number
  /** 花墨水前的同意框（AiReport 提供）；沒提供則直接執行 */
  requestInk?: (fn: () => void, message?: ReactNode) => void
  /** 寫入完成後通知父層重載（bump kpReloadTick 等） */
  onSaved?: () => void
  /** 卡片說明文字（依情境不同：舊卷無 KP／有代碼待升級節點） */
  hint: string
  /** 按鈕文字：舊卷「補跑知識點歸類」／已有 KP「升級為知識節點分類」 */
  ctaLabel?: string
}) {
  const [running, setRunning] = useState(false)
  const [msg, setMsg] = useState('')
  const runningRef = useRef(false)

  // 寫回本地 Dexie（server 已寫入；不更新 Dexie 的話報告分頁的 questions 還是舊的）。
  // 寫「全」analysis：保留 code＋nodeId，雷達/下鑽才不會掉資料。
  const mergeIntoDexie = async (r: KpUpgradeResult) => {
    try {
      const a = await db.assignments.get(assignmentId)
      const ak = a?.answerKey as { questions?: Array<{ id?: string; analysis?: Record<string, unknown> }>; kpTips?: Record<string, string> } | undefined
      if (!a || !ak?.questions) return
      const byId = new Map(r.items.map((it) => [String(it.questionId), it]))
      for (const q of ak.questions) {
        const it = byId.get(String(q.id ?? ''))
        if (!it) continue
        q.analysis = {
          ...(q.analysis ?? {}), // 保留既有欄位（如 code 若這次沒回）
          topic: it.topic,
          knowledgePoints: it.knowledgePoints,
          ...(it.code ? { code: it.code } : {}),
          ...(it.nodeId ? { nodeId: it.nodeId } : {}),
          ...(it.ability ? { ability: it.ability } : {}),
          ...(it.note ? { note: it.note } : {}),
        }
      }
      ak.kpTips = { ...(ak.kpTips ?? {}), ...r.kpTips }
      await db.assignments.put(a)
    } catch { /* Dexie 更新失敗 → 下次 sync 會拉回 server 版 */ }
  }

  const doRun = () => {
    if (runningRef.current) return
    runningRef.current = true
    void (async () => {
      setRunning(true); setMsg('')
      try {
        const r = await runKpUpgrade(assignmentId, subject, questions as never, grade)
        await mergeIntoDexie(r)
        onSaved?.()
        setMsg('知識點歸類完成——請重新整理頁面即可看到雷達更新。')
      } catch (e) {
        setMsg(`知識點歸類失敗：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setRunning(false); runningRef.current = false
      }
    })()
  }

  const onClick = () => {
    const inkMessage = (
      <div>
        即將為本卷建立「<b>知識點歸類</b>」（一次性、寫入後全班與未來重看共用；新建的答案卷會自動歸類，這裡給舊卷補跑）。
      </div>
    )
    if (requestInk) requestInk(doRun, inkMessage); else doRun()
  }

  return (
    <div style={{ marginBottom: 10 }}>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800">
        <span>{hint}</span>
        <button
          onClick={onClick}
          disabled={running}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-sky-300 bg-white px-2.5 py-1 text-xs font-medium text-sky-700 hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          {ctaLabel}
        </button>
      </div>
      {running && (
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-700">
          <Loader2 className="h-4 w-4 animate-spin" />正在建立知識點歸類（每卷一次性、之後不再收費）…
        </div>
      )}
      {msg && !running && (
        <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">{msg}</div>
      )}
    </div>
  )
}
