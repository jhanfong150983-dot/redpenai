// 家長報告分頁（2026-07-20 逐題診斷版、user 拍板 UI/UX）：
//   骨架（成績/班級位置/題型/知識點熱力圖/錯題截圖＋標準答案）純程式秒開零墨水；
//   AI 產物（逐題錯因診斷＋老師的話）＝花錢，「生成全班報告」一鍵才跑（走 InkConfirm）＋全螢幕 loading。
//   結果快取到 parent_reports（診斷＋評語）；截圖免費、preview/download 時現切。
//   重批改/改答案卷 → server 指紋比對回傳 stale → 紅橫幅提示重新生成（重生一律手動）。
import { useEffect, useMemo, useState } from 'react'
import { FileDown, Eye, RefreshCw, Loader2, Sparkles, Settings, CheckSquare, X, AlertTriangle } from 'lucide-react'
import {
  assembleParentReports, generateParentComment, generateParentDiagnosis, fetchQuestionCrops,
  diagnosisWrongsOf, applyDiagnosisAndCrops, loadParentReportCache, saveParentReportCache,
  createReportPdfBlob, downloadSingleReport, downloadReportsAsZip,
  loadReportHeaderSettings, loadCachedComments, saveCachedComment,
  type PRQuestion, type PRSubmission, type PRStudent, type ReportHeader, type StudentReport, type DiagnosisItem,
} from '@/lib/parentReport'

function formatDateZh(d: Date): string {
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`
}
async function runWithConcurrency<T>(items: T[], limit: number, fn: (item: T, idx: number) => Promise<void>) {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx) }
  }))
}

type Props = {
  questions: PRQuestion[]
  submissions: PRSubmission[]
  students: PRStudent[]
  kpTips?: Record<string, string>
  assignmentId: string
  className: string
  subject: string
  assignmentTitle: string
  onOpenPreferences?: () => void
  /** 花墨水前先跳同意框（AiReport 提供）；沒提供則直接執行。 */
  requestInk?: (fn: () => void) => void
}

export function ParentReportTab({
  questions, submissions, students, kpTips, assignmentId, className, subject, assignmentTitle, onOpenPreferences, requestInk,
}: Props) {
  const [reports, setReports] = useState<StudentReport[]>([])
  const [staleSet, setStaleSet] = useState<Set<string>>(new Set())
  // 「已生成」＝有成功產生並快取過（不是「每題都有診斷」——AI 偶爾漏一題不該害整位變未生成、重複扣費）。
  const [generatedSet, setGeneratedSet] = useState<Set<string>>(new Set())
  // 進頁面時快取（診斷/評語/失效）非同步載入中：狀態欄先顯示「載入中」而非誤導的「待生成」。
  const [cacheLoading, setCacheLoading] = useState(true)
  const [genState, setGenState] = useState<{ done: number; total: number } | null>(null)
  const [multiSelect, setMultiSelect] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [batchPdf, setBatchPdf] = useState<{ done: number; total: number } | null>(null)
  const [rowBusy, setRowBusy] = useState<Record<string, 'download' | 'preview' | undefined>>({})
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [settings, setSettings] = useState(loadReportHeaderSettings())
  const [msg, setMsg] = useState('')

  useEffect(() => {
    setSettings(loadReportHeaderSettings())
    let list: StudentReport[] = []
    try { list = assembleParentReports(questions, submissions, students, { kpTips }) } catch { list = [] }
    const cached = loadCachedComments(assignmentId)
    for (const r of list) if (cached[r.studentId]) r.comment = cached[r.studentId]
    setReports(list)
    setSelected(new Set())
    setStaleSet(new Set())
    setGeneratedSet(new Set())
    setMsg('')
    setCacheLoading(true)
    // 非同步載入 parent_reports 快取（診斷＋評語）＋ stale 指紋
    let cancelled = false
    loadParentReportCache(assignmentId)
      .then((cache) => {
        if (cancelled || cache.size === 0) return
        const localCmts = loadCachedComments(assignmentId)
        setReports((prev) => prev.map((r) => {
          const c = cache.get(r.studentId)
          if (!c) return r
          const diagMap = new Map<string, DiagnosisItem>(Object.entries(c.diagnosis || {}))
          const merged = applyDiagnosisAndCrops(r, diagMap, new Map())
          return { ...merged, comment: localCmts[r.studentId] || c.comment || merged.comment }
        }))
        setStaleSet(new Set([...cache.entries()].filter(([, c]) => c.stale).map(([sid]) => sid)))
        setGeneratedSet(new Set([...cache.keys()])) // 有快取＝生成過
      })
      .finally(() => { if (!cancelled) setCacheLoading(false) })
    return () => { cancelled = true }
  }, [questions, submissions, students, kpTips, assignmentId])

  const header: ReportHeader = useMemo(() => ({
    schoolName: settings.schoolName || '', crestDataUrl: settings.crestDataUrl,
    className, subject, assignmentTitle, teacherName: settings.teacherName || undefined,
    dateStr: formatDateZh(new Date()),
  }), [settings, className, subject, assignmentTitle])

  const setComment = (studentId: string, text: string) => {
    setReports((prev) => prev.map((r) => (r.studentId === studentId ? { ...r, comment: text } : r)))
    saveCachedComment(assignmentId, studentId, text)
  }
  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  const allSelected = reports.length > 0 && selected.size === reports.length
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(reports.map((r) => r.studentId)))

  const busy = genState !== null || batchPdf !== null
  const needsGen = (r: StudentReport) => !generatedSet.has(r.studentId) || staleSet.has(r.studentId)
  const pending = reports.filter(needsGen)

  // 生成（診斷＋截圖＋評語）→ 更新 state ＋ 快取；forceComment=true 時連已編輯的評語也重寫（單列重新生成用）
  const doGenerate = async (targets: StudentReport[], forceComment: boolean) => {
    if (!targets.length) return
    setMsg(''); setGenState({ done: 0, total: targets.length })
    const cacheItems: Array<{ studentId: string; diagnosis: Record<string, DiagnosisItem>; comment: string }> = []
    let done = 0, failed = 0
    await runWithConcurrency(targets, 3, async (r) => {
      try {
        const qids = r.errorRows.map((e) => e.questionId)
        const [diag, crops] = await Promise.all([
          r.errorRows.length ? generateParentDiagnosis(assignmentId, subject, diagnosisWrongsOf(r)) : Promise.resolve(new Map<string, DiagnosisItem>()),
          r.errorRows.length ? fetchQuestionCrops(assignmentId, r.studentId, qids) : Promise.resolve(new Map<string, string>()),
        ])
        let updated = applyDiagnosisAndCrops(r, diag, crops)
        let comment = forceComment ? '' : (r.comment || '')
        if (!comment) {
          const t = await generateParentComment(updated, subject)
          comment = t || r.comment || ''
          if (t) saveCachedComment(assignmentId, r.studentId, t)
        }
        updated = { ...updated, comment }
        cacheItems.push({ studentId: r.studentId, diagnosis: Object.fromEntries(diag), comment })
        setReports((prev) => prev.map((x) => (x.studentId === r.studentId ? updated : x)))
        setStaleSet((prev) => { const n = new Set(prev); n.delete(r.studentId); return n })
        setGeneratedSet((prev) => new Set(prev).add(r.studentId))
      } catch { failed += 1 }
      done += 1; setGenState({ done, total: targets.length })
    })
    if (cacheItems.length) await saveParentReportCache(assignmentId, cacheItems)
    setGenState(null)
    if (failed) setMsg(`有 ${failed} 位生成失敗，可用各列「重新生成」單獨重試`)
  }

  const requestGen = (targets: StudentReport[], forceComment: boolean) => {
    if (!targets.length) { setMsg('目前沒有需要生成的學生'); return }
    const run = () => { void doGenerate(targets, forceComment) }
    if (requestInk) requestInk(run); else run()
  }
  const genAll = () => requestGen(pending, false)
  const genSelectedOnly = () => requestGen(reports.filter((r) => selected.has(r.studentId) && needsGen(r)), false)
  const genOne = (r: StudentReport) => requestGen([r], true)

  // 截圖免費、preview/download 時現切（快取只存診斷/評語）；已有 crop 就跳過。
  const ensureCrops = async (r: StudentReport): Promise<StudentReport> => {
    if (!r.errorRows.length || r.errorRows.every((e) => e.cropDataUrl)) return r
    const crops = await fetchQuestionCrops(assignmentId, r.studentId, r.errorRows.map((e) => e.questionId))
    if (!crops.size) return r
    const updated = applyDiagnosisAndCrops(r, new Map(), crops)
    setReports((prev) => prev.map((x) => (x.studentId === r.studentId ? updated : x)))
    return updated
  }

  const previewOne = async (r: StudentReport) => {
    setMsg(''); setRowBusy((p) => ({ ...p, [r.studentId]: 'preview' }))
    try {
      const rr = await ensureCrops(r)
      const blob = await createReportPdfBlob(rr, header)
      setPreviewUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(blob) })
    } catch (e) { setMsg(e instanceof Error ? e.message : '預覽失敗，請再試一次') }
    setRowBusy((p) => ({ ...p, [r.studentId]: undefined }))
  }
  const closePreview = () => { setPreviewUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null }) }
  const downloadOne = async (r: StudentReport) => {
    setMsg(''); setRowBusy((p) => ({ ...p, [r.studentId]: 'download' }))
    try { const rr = await ensureCrops(r); await downloadSingleReport(rr, header) }
    catch (e) { setMsg(e instanceof Error ? e.message : '下載失敗，請再試一次') }
    setRowBusy((p) => ({ ...p, [r.studentId]: undefined }))
  }
  const downloadSelected = async () => {
    const pickedAll = reports.filter((r) => selected.has(r.studentId))
    if (!pickedAll.length) { setMsg('請先勾選要下載的學生'); return }
    // 只下載已生成的（未生成的先擋掉，避免下載半成品）
    const picked = pickedAll.filter((r) => generatedSet.has(r.studentId))
    const skipped = pickedAll.length - picked.length
    if (!picked.length) { setMsg('勾選的學生都尚未生成報告，請先按「生成」'); return }
    setMsg(''); setBatchPdf({ done: 0, total: picked.length })
    try {
      const withCrops: StudentReport[] = []
      for (const r of picked) withCrops.push(await ensureCrops(r))
      const { failed } = await downloadReportsAsZip(withCrops, header, { onProgress: (done, total) => setBatchPdf({ done, total }) })
      const notes = [failed > 0 ? `${failed} 份產生失敗（可個別重試）` : '', skipped > 0 ? `${skipped} 位尚未生成、已略過` : ''].filter(Boolean)
      if (notes.length) setMsg(`已下載，但${notes.join('；')}`)
    } catch (e) { setMsg(e instanceof Error ? e.message : '批次下載失敗，請再試一次') }
    setBatchPdf(null)
  }

  const enterMulti = () => { setMultiSelect(true); setSelected(new Set()) }
  const exitMulti = () => { setMultiSelect(false); setSelected(new Set()) }

  if (!reports.length) {
    return <section className="card" style={{ color: '#64748b', fontSize: 13 }}>此作業已批改的卷數不足，暫無法產生家長報告。</section>
  }

  const genDoneCount = reports.filter((r) => generatedSet.has(r.studentId) && !staleSet.has(r.studentId)).length

  return (
    <div className="space-y-3">
      {!settings.schoolName && (
        <div className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
          <span>尚未設定學校名稱，報告抬頭會空白。</span>
          <button onClick={onOpenPreferences} className="flex items-center gap-1 font-medium text-amber-800 hover:underline">
            <Settings className="h-3.5 w-3.5" />前往偏好設定
          </button>
        </div>
      )}

      {staleSet.size > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
          <span>有 {staleSet.size} 位學生的批改結果或答案卷已更新，其家長報告已失效。請重新生成，以確保內容與最新批改一致。</span>
        </div>
      )}

      {/* 工具列 */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
        <span className="text-sm text-slate-500">
          {multiSelect
            ? `已勾選 ${selected.size} / ${reports.length} 位`
            : cacheLoading
              ? <span className="flex items-center gap-1.5"><Loader2 className="h-3.5 w-3.5 animate-spin" />載入已生成的報告…</span>
              : `共 ${reports.length} 位・已生成 ${genDoneCount} 位`}
        </span>
        <div className="flex-1" />
        {multiSelect ? (
          <>
            <label className="flex items-center gap-1.5 text-sm text-slate-500">
              <input type="checkbox" checked={allSelected} onChange={toggleAll} className="h-4 w-4 accent-sky-600" />全選
            </label>
            <button
              onClick={genSelectedOnly} disabled={busy || selected.size === 0}
              className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
              title="只對勾選、且尚未生成/已失效的學生生成"
            >
              <Sparkles className="h-4 w-4" />只生成選取的
            </button>
            <button
              onClick={downloadSelected} disabled={busy || selected.size === 0}
              className="flex items-center gap-1.5 rounded-lg border border-sky-600 px-3 py-1.5 text-sm font-medium text-sky-700 hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-50"
              title="每位一份 PDF、打包成 zip 下載"
            >
              {batchPdf ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
              {batchPdf ? `產生中 ${batchPdf.done}/${batchPdf.total}` : `下載報告（${selected.size}）`}
            </button>
            <button onClick={exitMulti} disabled={busy} className="rounded-lg px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100 disabled:opacity-40">取消多選</button>
          </>
        ) : (
          <>
            <button
              onClick={genAll} disabled={busy || cacheLoading || pending.length === 0}
              className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
              title="AI 逐題錯因診斷＋老師的話＋截圖；會消耗墨水（點數）"
            >
              {cacheLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {cacheLoading ? '載入中…' : pending.length ? `生成全班報告（${pending.length}）` : '全班已生成'}
            </button>
            <button onClick={enterMulti} className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50">
              <CheckSquare className="h-4 w-4" />多選
            </button>
          </>
        )}
      </div>

      {msg && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{msg}</div>}

      {/* 學生清單 */}
      <div className="overflow-hidden rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50 text-left text-xs text-slate-500">
              {multiSelect && <th className="w-10 px-3 py-2"></th>}
              <th className="w-28 px-2 py-2">座號 · 姓名</th>
              <th className="w-16 px-2 py-2 text-right">分數</th>
              <th className="w-20 px-2 py-2 text-center">狀態</th>
              <th className="px-2 py-2">老師的話（可編輯）</th>
              <th className="w-44 px-2 py-2 text-center">操作</th>
            </tr>
          </thead>
          <tbody>
            {reports.map((r) => {
              const rb = rowBusy[r.studentId]
              const stale = staleSet.has(r.studentId)
              const generated = generatedSet.has(r.studentId) // 生成過（含已失效）才可預覽/下載
              const done = generated && !stale
              return (
                <tr key={r.studentId} className="border-b border-slate-50 last:border-0 align-top">
                  {multiSelect && (
                    <td className="px-3 py-2.5">
                      <input type="checkbox" checked={selected.has(r.studentId)} onChange={() => toggle(r.studentId)} className="h-4 w-4 accent-sky-600" />
                    </td>
                  )}
                  <td className="px-2 py-2.5">
                    <span className="font-medium text-slate-800">{r.seat}</span>
                    <span className="ml-1.5 text-slate-600">{r.name}</span>
                  </td>
                  <td className="px-2 py-2.5 text-right">
                    <span className={`font-semibold tabular-nums ${r.isLow ? 'text-rose-600' : 'text-slate-800'}`}>{r.score}</span>
                    <span className="text-xs text-slate-400">/{r.examMax}</span>
                  </td>
                  <td className="px-2 py-2.5 text-center">
                    {cacheLoading
                      ? <Loader2 className="mx-auto h-3.5 w-3.5 animate-spin text-slate-300" />
                      : stale
                        ? <span className="rounded bg-rose-50 px-1.5 py-0.5 text-[11px] font-medium text-rose-600">已失效</span>
                        : done
                          ? <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-600">已生成</span>
                          : <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-400">待生成</span>}
                  </td>
                  <td className="px-2 py-2">
                    <textarea
                      value={r.comment}
                      onChange={(e) => setComment(r.studentId, e.target.value)}
                      placeholder="按「生成全班報告」自動產生，或直接手動輸入"
                      rows={3}
                      className="w-full resize-y rounded-md border border-slate-200 px-2.5 py-1.5 text-[13px] leading-relaxed text-slate-700 focus:border-sky-400 focus:outline-none"
                    />
                  </td>
                  <td className="px-2 py-2.5">
                    <div className="flex items-center justify-center gap-1">
                      <button onClick={() => genOne(r)} disabled={busy || cacheLoading || !!rb}
                        title={done ? '重新生成這位的診斷與評語' : '生成這位的診斷與評語'}
                        className="flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-700 disabled:opacity-40">
                        {done ? <RefreshCw className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
                        {done ? '重新生成' : '生成'}
                      </button>
                      <button onClick={() => previewOne(r)} disabled={busy || cacheLoading || !!rb || !generated}
                        title={generated ? '預覽' : '請先生成報告'}
                        className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-sky-600 disabled:opacity-40 disabled:cursor-not-allowed">
                        {rb === 'preview' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
                      </button>
                      <button onClick={() => downloadOne(r)} disabled={busy || cacheLoading || !!rb || !generated}
                        title={generated ? '下載 PDF' : '請先生成報告'}
                        className="rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-sky-600 disabled:opacity-40 disabled:cursor-not-allowed">
                        {rb === 'download' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-400">
        「生成全班報告」會用 AI 逐題分析每位學生為什麼寫錯、產生老師的話（消耗墨水），並自動快取；已生成的不會重複計費。要更新某一位，用該列「重新生成」。下載為每位一份 PDF。
      </p>

      {/* 全螢幕生成中 */}
      {genState && (
        <div className="fixed inset-0 z-[600] flex flex-col items-center justify-center gap-4 bg-white/85 backdrop-blur-sm">
          <Loader2 className="h-10 w-10 animate-spin text-sky-600" />
          <div className="text-center">
            <div className="text-base font-medium text-slate-800">正在生成家長報告…</div>
            <div className="mt-1 text-sm text-slate-500">{genState.done} / {genState.total} 位　（AI 逐題診斷＋老師的話＋截圖）</div>
          </div>
          <div className="h-1.5 w-64 overflow-hidden rounded-full bg-slate-200">
            <div className="h-full bg-sky-600 transition-all" style={{ width: `${Math.round((genState.done / Math.max(1, genState.total)) * 100)}%` }} />
          </div>
          <div className="text-xs text-slate-400">請勿關閉此頁</div>
        </div>
      )}

      {/* 預覽彈窗（App 內嵌 PDF、不開新分頁） */}
      {previewUrl && (
        <div className="fixed inset-0 z-[500] flex items-center justify-center bg-black/50 p-4" onClick={closePreview}>
          <div className="flex h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
              <span className="text-sm font-medium text-slate-700">報告預覽</span>
              <button onClick={closePreview} className="rounded p-1 text-slate-400 hover:bg-slate-100" aria-label="關閉">
                <X className="h-5 w-5" />
              </button>
            </div>
            <iframe src={previewUrl} title="家長報告預覽" className="w-full flex-1 border-0" />
          </div>
        </div>
      )}
    </div>
  )
}
