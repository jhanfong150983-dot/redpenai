// ═══ 檢討模式（2026-09-12 user 設計）═══════════════════════════════════════════
// 上課投影用、全螢幕。左＝題本預覽（放大縮小、換頁；換題時不動，老師自己調）。
// 右＝這一題檢討需要的素材：錯幾人、誰錯了（座號）、正確寫法、典型錯法（樣態群＋代表卷面）、參考答案（預設收起）。
// 順序＝檢討順序（失分率高→低）；← → 換題；Esc 離開。零 AI、零墨水：全部來自已批改資料與樣態聚合。
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, X, ZoomIn, ZoomOut, Maximize2, Eye, EyeOff, Check } from 'lucide-react'
import { db, type Submission } from '@/lib/db'
import { buildQuestionStats, cmpQid, type AnswerGroup, type QuestionStats } from '@/lib/answerStats'

type StudentLike = { id: string; seatNumber?: number | string | null; name?: string | null }
type Props = {
  assignmentId: string
  templateId: string
  title: string
  questions: any[]
  submissions: Submission[]
  students: StudentLike[]
  onClose: () => void
}

const SPECIAL = new Set(['', '未作答', '無法辨識', '圖像辨識', '(空白)'])

export default function ReviewModeOverlay({ assignmentId, templateId, title, questions, submissions, students, onClose }: Props) {
  // ── 題本預覽 ──
  const [pageCount, setPageCount] = useState(0)
  const [page, setPage] = useState(0)
  const [zoom, setZoom] = useState(1)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const tpl = templateId ? await db.answerKeyTemplates.get(templateId) : undefined
      const n = (tpl as { questionBookletImagePaths?: string[] } | undefined)?.questionBookletImagePaths?.length ?? 0
      if (!cancelled) setPageCount(n)
    })()
    return () => { cancelled = true }
  }, [templateId])
  const pageUrl = (i: number) => `/api/storage/download?templateId=${encodeURIComponent(templateId)}&pageIndex=${i}&prefix=question-booklets`
  // 2026-09-12 user：滑鼠拖曳平移題本（按住拖＝捲動容器；Ctrl+滾輪＝縮放）
  const viewerRef = useRef<HTMLDivElement | null>(null)
  const drag = useRef<{ x: number; y: number; sl: number; st: number } | null>(null)
  const onViewerDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !viewerRef.current) return
    drag.current = { x: e.clientX, y: e.clientY, sl: viewerRef.current.scrollLeft, st: viewerRef.current.scrollTop }
    e.preventDefault()
  }
  const onViewerMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!drag.current || !viewerRef.current) return
    viewerRef.current.scrollLeft = drag.current.sl - (e.clientX - drag.current.x)
    viewerRef.current.scrollTop = drag.current.st - (e.clientY - drag.current.y)
  }
  const onViewerUp = () => { drag.current = null }
  const onViewerWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    setZoom((z) => Math.max(0.5, Math.min(4, +(z + (e.deltaY < 0 ? 0.1 : -0.1)).toFixed(2))))
  }

  // ── 樣態聚合（同樣態分析／評分統計那一套） ──
  const stuById = useMemo(() => new Map(students.map((s) => [s.id, s])), [students])
  const stats = useMemo(() => {
    const entries = submissions
      .filter((s) => Array.isArray((s.gradingResult as { details?: unknown[] } | undefined)?.details))
      .map((s) => ({ submission: s, student: (stuById.get(s.studentId) ?? { name: '', seatNumber: null }) as any }))
    return buildQuestionStats(entries)
  }, [submissions, stuById])
  const statByQid = useMemo(() => new Map(stats.map((q) => [q.qid, q])), [stats])
  const qByQid = useMemo(() => new Map(questions.map((q) => [String(q?.id ?? q?.questionId ?? ''), q])), [questions])

  // ── 檢討順序：失分率高→低（同 AssignmentOverviewSection：1 − 得分率），全對的題排最後 ──
  const order = useMemo(() => {
    const rows: Array<{ qid: string; missRate: number; wrong: number; total: number }> = []
    for (const q of stats) {
      const total = q.groups.reduce((a, g) => a + g.members.length, 0)
      const got = q.groups.reduce((a, g) => a + g.members.reduce((x, m) => x + m.score, 0), 0)
      const missRate = q.maxScore > 0 && total > 0 ? 1 - got / (q.maxScore * total) : 0
      const wrong = q.groups.reduce((a, g) => a + g.members.filter((m) => q.maxScore > 0 && m.score < q.maxScore).length, 0)
      rows.push({ qid: q.qid, missRate, wrong, total })
    }
    return rows.sort((a, b) => b.missRate - a.missRate || cmpQid(a.qid, b.qid))
  }, [stats])
  const [idx, setIdx] = useState(0)
  const cur = order[Math.min(idx, Math.max(0, order.length - 1))]
  const active: QuestionStats | undefined = cur ? statByQid.get(cur.qid) : undefined
  const q = cur ? qByQid.get(cur.qid) : undefined

  // ── 已檢討（本機記憶） ──
  const doneKey = `review_mode_done_${assignmentId}`
  const [done, setDone] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem(doneKey) || '[]')) } catch { return new Set() } })
  const toggleDone = (qid: string) => setDone((prev) => { const n = new Set(prev); if (n.has(qid)) n.delete(qid); else n.add(qid); try { localStorage.setItem(doneKey, JSON.stringify([...n])) } catch { /* ignore */ } return n })

  // ── 參考答案預設收起（投影時由老師決定何時揭曉） ──
  const [showAnswer, setShowAnswer] = useState(false)

  // ── 代表卷面（圖像判分題的群、或文字題的錯法群）：/api/report/crops、依需求抓、快取 ──
  const [crops, setCrops] = useState<Map<string, string>>(new Map())
  const fetching = useRef<Set<string>>(new Set())
  const fetchCrop = async (studentId: string, qid: string) => {
    const key = `${studentId}|${qid}`
    if (crops.has(key) || fetching.current.has(key)) return
    fetching.current.add(key)
    try {
      const res = await fetch('/api/report/crops', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ assignmentId, studentId, questionIds: [qid] }),
      })
      if (!res.ok) return
      const data = (await res.json().catch(() => null)) as { crops?: Record<string, string> } | null
      const uri = data?.crops?.[qid]
      if (typeof uri === 'string' && uri) setCrops((prev) => new Map(prev).set(key, uri))
    } catch { /* 單張失敗不擋 */ } finally { fetching.current.delete(key) }
  }

  const correctGroups = useMemo(() => (active ? active.groups.filter((g) => active.maxScore > 0 && g.score >= active.maxScore).sort((a, b) => b.members.length - a.members.length) : []), [active])
  const wrongGroups = useMemo(() => (active ? active.groups.filter((g) => !(active.maxScore > 0 && g.score >= active.maxScore)).sort((a, b) => b.members.length - a.members.length) : []), [active])
  // 2026-09-12 user：未作答／無法辨識不是「錯法」→ 典型錯法排除，人數另列一行
  // rubric 題「要素全無」（零級分 0/n、作圖全空白、rubric 維度全 0）＝等同未作答（user 拍板），一樣不算典型錯法
  const isSpecialGroup = (g: AnswerGroup) => g.locked || SPECIAL.has(String(g.raw ?? '').trim())
    || (Array.isArray(g.items) && g.items.length > 0 && g.items.every((it) => it.state === 'miss' || it.state === 'blank' || it.state === 'waived'))
  const typicalWrong = useMemo(() => wrongGroups.filter((g) => !isSpecialGroup(g)), [wrongGroups])
  // 2026-09-12 user：「典型」＝至少 2 人的群；全是 1 人時挑前 3 等於隨機 → 改列「各不相同」清單（只文字、不抓卷面）
  const typicalMulti = useMemo(() => typicalWrong.filter((g) => g.members.length >= 2), [typicalWrong])
  const singles = useMemo(() => typicalWrong.filter((g) => g.members.length < 2), [typicalWrong])
  const blankCount = useMemo(() => wrongGroups.filter(isSpecialGroup).reduce((a, g) => a + g.members.length, 0), [wrongGroups])
  const allMembers = useMemo(() => (active ? active.groups.flatMap((g) => g.members.map((m) => ({ ...m, groupRaw: g.raw }))) : []), [active])
  const wrongMembers = useMemo(() => allMembers.filter((m) => active && active.maxScore > 0 && m.score < active.maxScore).sort((a, b) => (Number(a.seat) || 999) - (Number(b.seat) || 999)), [allMembers, active])
  const correctMembers = useMemo(() => allMembers.filter((m) => active && active.maxScore > 0 && m.score >= active.maxScore).sort((a, b) => (Number(a.seat) || 999) - (Number(b.seat) || 999)), [allMembers, active])
  const wrongSeats = useMemo(() => wrongMembers.map((m) => String(m.seat ?? m.name ?? '?')), [wrongMembers])
  // 國字注音等「圖像辨識」格：讀值是佔位字、全班塌成一個鎖定群且群內分數混雜 → 改成逐人卷面（錯的寫法／對的寫法各抓縮圖）
  const glyphMode = useMemo(() => !!active && active.groups.some((g) => g.locked && g.raw === '圖像辨識' && g.members.length > 0), [active])
  // 代表卷面：圖像判分題所有群、文字題只抓錯法前 3 群（老師要看的是錯法長什麼樣）
  useEffect(() => {
    if (!active) return
    if (glyphMode) {
      for (const m of [...wrongMembers.slice(0, 8), ...correctMembers.slice(0, 4)]) void fetchCrop(m.studentId, active.qid)
      return
    }
    const targets = [...(active.groups.some((g) => g.imageAgg) ? active.groups.filter((g) => !isSpecialGroup(g)).slice(0, 6) : typicalMulti.slice(0, 3))]
    for (const g of targets) { const rep = g.members[0]; if (rep) void fetchCrop(rep.studentId, active.qid) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.qid])

  // ── 鍵盤 ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight') setIdx((i) => Math.min(order.length - 1, i + 1))
      else if (e.key === 'ArrowLeft') setIdx((i) => Math.max(0, i - 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [order.length, onClose])

  const refAnswer = String(q?.answer ?? q?.referenceAnswer ?? '').trim()
  const levelElements: Array<{ key: string; desc?: string }> = [
    ...((q?.levelRubric?.requiredElements ?? []) as Array<{ key: string; desc?: string }>),
    ...(((q?.levelRubric?.alternativeGroups ?? []) as Array<{ options?: Array<{ key: string; desc?: string }> }>).flatMap((g) => g.options ?? [])),
  ]
  const vjLabels: string[] = (q?.vjRubric?.itemLabels ?? []) as string[]

  const groupCard = (g: AnswerGroup, tone: 'ok' | 'ng') => {
    const rep = g.members[0]
    const uri = rep ? crops.get(`${rep.studentId}|${active!.qid}`) : undefined
    const isSpecial = g.locked || SPECIAL.has(g.raw)
    return (
      <div key={g.key} className={`rounded-xl border-2 p-3 ${tone === 'ok' ? 'border-emerald-500/70 bg-emerald-950/30' : 'border-rose-500/70 bg-rose-950/30'}`}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            {g.items && g.items.length > 0 ? (
              <div>
                <div className="text-lg font-bold">{g.headline ?? g.raw}</div>
                <div className="mt-1 space-y-0.5">
                  {g.items.map((it) => (
                    <div key={it.key} className={`text-sm ${it.state === 'miss' ? 'text-rose-300 font-semibold' : it.state === 'partial' ? 'text-amber-300' : 'text-slate-400'}`} title={it.text}>
                      {it.state === 'ok' ? '✓' : it.state === 'miss' ? '✗' : it.state === 'waived' ? '－' : it.state === 'blank' ? '○' : '◐'} {it.label}{it.note ? ` ${it.note}` : ''}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className={`font-bold break-all ${isSpecial ? 'text-slate-300 text-lg' : 'text-2xl'}`}>{isSpecial ? (g.raw || '未作答') : `「${g.raw}」`}</div>
            )}
          </div>
          <div className={`shrink-0 px-2 py-1 rounded-lg text-sm font-bold ${tone === 'ok' ? 'bg-emerald-500 text-white' : 'bg-rose-500 text-white'}`}>{g.score} 分・{g.members.length} 人</div>
        </div>
        {(g.imageAgg || tone === 'ng') && !isSpecial && (
          <div className="mt-2 rounded-lg overflow-hidden bg-white/95 min-h-[48px] flex items-center justify-center">
            {uri ? <img src={uri} alt="" className="w-full object-contain" style={{ maxHeight: 180 }} /> : <span className="text-xs text-slate-400 py-4">卷面載入中…</span>}
          </div>
        )}
        {g.reason && tone === 'ng' && !g.items && <div className="mt-1.5 text-sm text-rose-200/90 line-clamp-2" title={g.reason}>{g.reason}</div>}
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-[300] bg-slate-950 text-slate-100 flex flex-col select-none">
      {/* 頂列 */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-slate-800 shrink-0">
        <div className="font-bold text-lg truncate">{title}</div>
        <div className="text-slate-400 text-sm">檢討模式　← → 換題　Esc 離開</div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-sm text-slate-400">已檢討 {done.size}/{order.length}</span>
          <button type="button" onClick={onClose} className="p-2 rounded-lg hover:bg-slate-800" title="離開檢討模式"><X className="w-5 h-5" /></button>
        </div>
      </div>
      <div className="flex-1 min-h-0 grid" style={{ gridTemplateColumns: '55% 45%' }}>
        {/* 左：題本預覽（換題不動） */}
        <div className="min-h-0 flex flex-col border-r border-slate-800">
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-800 text-sm shrink-0">
            <span className="text-slate-400">題本</span>
            <button type="button" disabled={page <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))} className="p-1.5 rounded hover:bg-slate-800 disabled:opacity-30"><ChevronLeft className="w-4 h-4" /></button>
            <span className="tabular-nums">{pageCount ? `${page + 1} / ${pageCount}` : '—'}</span>
            <button type="button" disabled={page >= pageCount - 1} onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} className="p-1.5 rounded hover:bg-slate-800 disabled:opacity-30"><ChevronRight className="w-4 h-4" /></button>
            <span className="mx-2 text-slate-700">|</span>
            <button type="button" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))} className="p-1.5 rounded hover:bg-slate-800"><ZoomOut className="w-4 h-4" /></button>
            <span className="tabular-nums w-12 text-center">{Math.round(zoom * 100)}%</span>
            <button type="button" onClick={() => setZoom((z) => Math.min(4, +(z + 0.25).toFixed(2)))} className="p-1.5 rounded hover:bg-slate-800"><ZoomIn className="w-4 h-4" /></button>
            <button type="button" onClick={() => setZoom(1)} className="p-1.5 rounded hover:bg-slate-800" title="還原"><Maximize2 className="w-4 h-4" /></button>
          </div>
          <div ref={viewerRef} className="flex-1 min-h-0 overflow-auto bg-slate-900 cursor-grab active:cursor-grabbing"
            onMouseDown={onViewerDown} onMouseMove={onViewerMove} onMouseUp={onViewerUp} onMouseLeave={onViewerUp} onWheel={onViewerWheel}
            title="按住拖曳移動；Ctrl＋滾輪縮放">
            {pageCount > 0
              ? <img src={pageUrl(page)} alt={`題本第 ${page + 1} 頁`} draggable={false} style={{ width: `${zoom * 100}%`, maxWidth: 'none', display: 'block', pointerEvents: 'none' }} />
              : <div className="h-full flex items-center justify-center text-slate-500 text-sm">這份考卷沒有上傳題本，左側無法預覽</div>}
          </div>
        </div>
        {/* 右：本題素材 */}
        <div className="min-h-0 flex flex-col">
          {!active || !cur ? (
            <div className="flex-1 flex items-center justify-center text-slate-500">此考卷還沒有可統計的批改資料</div>
          ) : (
            <>
              <div className="flex items-center gap-3 px-4 py-2 border-b border-slate-800 shrink-0">
                <button type="button" disabled={idx <= 0} onClick={() => setIdx((i) => Math.max(0, i - 1))} className="p-2 rounded-lg border border-slate-700 hover:bg-slate-800 disabled:opacity-30"><ChevronLeft className="w-5 h-5" /></button>
                <div className="text-3xl font-black tabular-nums">{cur.qid}</div>
                <div className="text-sm text-slate-400">檢討順序 {idx + 1}/{order.length}　配分 {active.maxScore}</div>
                <div className={`ml-1 px-2.5 py-1 rounded-lg font-bold ${cur.wrong > 0 ? 'bg-rose-500/20 text-rose-300' : 'bg-emerald-500/20 text-emerald-300'}`}>錯 {cur.wrong} / {cur.total} 人</div>
                <button type="button" onClick={() => toggleDone(cur.qid)} className={`ml-auto inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border text-sm font-semibold ${done.has(cur.qid) ? 'border-emerald-500 bg-emerald-500/20 text-emerald-200' : 'border-slate-600 text-slate-300 hover:bg-slate-800'}`}>
                  <Check className="w-4 h-4" />{done.has(cur.qid) ? '已檢討' : '標為已檢討'}
                </button>
                <button type="button" disabled={idx >= order.length - 1} onClick={() => setIdx((i) => Math.min(order.length - 1, i + 1))} className="p-2 rounded-lg border border-slate-700 hover:bg-slate-800 disabled:opacity-30"><ChevronRight className="w-5 h-5" /></button>
              </div>
              <div className="flex-1 min-h-0 overflow-auto px-4 py-3 space-y-4">
                {/* 誰錯了 */}
                <div>
                  <div className="text-sm text-slate-400 mb-1">誰錯了（座號）</div>
                  <div className="flex flex-wrap gap-1.5">
                    {wrongSeats.length === 0 ? <span className="text-emerald-300 font-semibold">全班答對</span>
                      : wrongSeats.map((s, i) => <span key={i} className="px-2 py-0.5 rounded-md bg-slate-800 text-lg font-bold tabular-nums">{s}</span>)}
                  </div>
                </div>
                {/* 參考答案（收起） */}
                {(refAnswer || levelElements.length > 0 || vjLabels.length > 0) && (
                  <div>
                    <button type="button" onClick={() => setShowAnswer((v) => !v)} className="inline-flex items-center gap-1.5 text-sm text-slate-300 hover:text-white">
                      {showAnswer ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}{showAnswer ? '隱藏參考答案' : '顯示參考答案／評分要素'}
                    </button>
                    {showAnswer && (
                      <div className="mt-2 rounded-xl border border-amber-500/60 bg-amber-950/30 p-3 space-y-1.5">
                        {refAnswer && <div className="text-2xl font-bold text-amber-200">{refAnswer}</div>}
                        {levelElements.length > 0 && (
                          <ol className="list-decimal pl-5 text-base text-amber-100/90 space-y-1">
                            {levelElements.map((e) => <li key={e.key}>{String(e.desc ?? e.key).replace(/\s*⛔.*$/u, '')}</li>)}
                          </ol>
                        )}
                        {vjLabels.length > 0 && <div className="text-base text-amber-100/90">{vjLabels.join('　')}</div>}
                      </div>
                    )}
                  </div>
                )}
                {/* 圖像辨識題（國字注音）：逐人卷面 */}
                {glyphMode ? (
                  <>
                    <div>
                      <div className="text-sm text-slate-400 mb-1.5">錯的寫法（卷面，前 {Math.min(8, wrongMembers.length)} 位）</div>
                      {wrongMembers.length === 0 ? <div className="text-slate-500 text-sm">全班答對</div> : (
                        <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
                          {wrongMembers.slice(0, 8).map((m) => { const uri = crops.get(`${m.studentId}|${active.qid}`); return (
                            <div key={m.submissionId} className="rounded-lg border-2 border-rose-500/70 bg-white/95 overflow-hidden">
                              <div className="min-h-[56px] flex items-center justify-center">{uri ? <img src={uri} alt="" className="w-full object-contain" style={{ maxHeight: 110 }} /> : <span className="text-xs text-slate-400 py-4">載入中…</span>}</div>
                              <div className="px-2 py-0.5 text-xs text-rose-700 font-bold bg-rose-50">{m.seat != null ? `${m.seat}號` : m.name}　{m.score}/{active.maxScore}</div>
                            </div>) })}
                        </div>
                      )}
                    </div>
                    <div>
                      <div className="text-sm text-slate-400 mb-1.5">對的寫法（卷面）</div>
                      {correctMembers.length === 0 ? <div className="text-slate-500 text-sm">無人答對</div> : (
                        <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
                          {correctMembers.slice(0, 4).map((m) => { const uri = crops.get(`${m.studentId}|${active.qid}`); return (
                            <div key={m.submissionId} className="rounded-lg border-2 border-emerald-500/70 bg-white/95 overflow-hidden">
                              <div className="min-h-[56px] flex items-center justify-center">{uri ? <img src={uri} alt="" className="w-full object-contain" style={{ maxHeight: 110 }} /> : <span className="text-xs text-slate-400 py-4">載入中…</span>}</div>
                              <div className="px-2 py-0.5 text-xs text-emerald-700 font-bold bg-emerald-50">{m.seat != null ? `${m.seat}號` : m.name}</div>
                            </div>) })}
                        </div>
                      )}
                    </div>
                  </>
                ) : (<>
                {/* 典型錯法 */}
                <div>
                  <div className="text-sm text-slate-400 mb-1.5">典型錯法（人數最多的前 3 種）{blankCount > 0 && <span className="ml-2 text-slate-500">未作答／全無 {blankCount} 人不列入</span>}</div>
                  {typicalWrong.length === 0 ? <div className="text-slate-500 text-sm">沒有錯誤作答</div> : (
                    <>
                      {typicalMulti.length > 0 && (
                        <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>{typicalMulti.slice(0, 3).map((g) => groupCard(g, 'ng'))}</div>
                      )}
                      {typicalMulti.length > 3 && <div className="mt-1 text-xs text-slate-500">另有 {typicalMulti.length - 3} 種 2 人以上的寫法、共 {typicalMulti.slice(3).reduce((a, g) => a + g.members.length, 0)} 人</div>}
                      {singles.length > 0 && (
                        <div className={typicalMulti.length > 0 ? 'mt-2' : ''}>
                          <div className="text-xs text-slate-500 mb-1">{typicalMulti.length > 0 ? `其餘各 1 人的寫法（${singles.length} 種）` : `錯法各不相同（${singles.length} 種、各 1 人）`}</div>
                          <div className="flex flex-wrap gap-1.5">
                            {singles.slice(0, 12).map((g) => (
                              <span key={g.key} className="px-2 py-1 rounded-md bg-rose-950/40 border border-rose-800 text-rose-100 text-base" title={g.items ? (g.headline ?? g.raw) : g.raw}>
                                {g.items ? `${g.headline ?? g.raw}：${g.items.filter((it) => it.state === 'miss').map((it) => it.label).join('、') || '—'}` : g.raw}
                                <span className="ml-1 text-xs text-rose-300/80">{g.members[0]?.seat != null ? `${g.members[0].seat}號` : ''}</span>
                              </span>
                            ))}
                            {singles.length > 12 && <span className="text-xs text-slate-500 self-center">另 {singles.length - 12} 種</span>}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
                {/* 正確寫法 */}
                <div>
                  <div className="text-sm text-slate-400 mb-1.5">拿到滿分的寫法</div>
                  {correctGroups.length === 0 ? <div className="text-slate-500 text-sm">無人滿分</div>
                    : <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>{correctGroups.slice(0, 2).map((g) => groupCard(g, 'ok'))}</div>}
                </div>
                </>)}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
