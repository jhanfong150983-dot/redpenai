// 家長報告分頁（2026-07-18 互動改版、user 拍板）：預設一份一份處理（每列自帶生成/重新生成+預覽+下載）；
//   右上「多選」開關才顯示勾選框與批次（生成評語 / 下載報告）。設定在偏好設定頁；評語編輯存 localStorage 依作業快取。
import { useEffect, useMemo, useState } from 'react'
import { FileDown, Eye, RefreshCw, Loader2, Sparkles, Settings, CheckSquare } from 'lucide-react'
import {
  assembleParentReports, generateParentComment,
  createReportPdfBlob, downloadSingleReport, downloadReportsAsZip,
  loadReportHeaderSettings, loadCachedComments, saveCachedComment,
  type PRQuestion, type PRSubmission, type PRStudent, type ReportHeader, type StudentReport,
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
  assignmentId: string
  className: string
  subject: string
  assignmentTitle: string
  onOpenPreferences?: () => void
}

export function ParentReportTab({
  questions, submissions, students, assignmentId, className, subject, assignmentTitle, onOpenPreferences,
}: Props) {
  const [reports, setReports] = useState<StudentReport[]>([])
  const [multiSelect, setMultiSelect] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [batchGen, setBatchGen] = useState<{ done: number; total: number } | null>(null)
  const [batchPdf, setBatchPdf] = useState<{ done: number; total: number } | null>(null)
  const [rowBusy, setRowBusy] = useState<Record<string, 'gen' | 'download' | 'preview' | undefined>>({})
  const [settings, setSettings] = useState(loadReportHeaderSettings())
  const [msg, setMsg] = useState('')

  useEffect(() => {
    setSettings(loadReportHeaderSettings())
    let list: StudentReport[] = []
    try { list = assembleParentReports(questions, submissions, students) } catch { list = [] }
    const cached = loadCachedComments(assignmentId)
    for (const r of list) if (cached[r.studentId]) r.comment = cached[r.studentId]
    setReports(list)
    setSelected(new Set()) // 預設不勾選
    setMsg('')
  }, [questions, submissions, students, assignmentId])

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

  const busy = batchGen !== null || batchPdf !== null

  // 單列：生成 / 重新生成評語
  const genOne = async (r: StudentReport) => {
    setRowBusy((p) => ({ ...p, [r.studentId]: 'gen' }))
    const text = await generateParentComment(r, subject)
    if (text) setComment(r.studentId, text); else setMsg('評語生成失敗，請再試一次或手動輸入')
    setRowBusy((p) => ({ ...p, [r.studentId]: undefined }))
  }
  // 預覽：先同步開空白分頁（避免 await 後 window.open 被彈窗攔截），拿到 PDF 再導向。
  const previewOne = async (r: StudentReport) => {
    setMsg('')
    const win = window.open('', '_blank')
    setRowBusy((p) => ({ ...p, [r.studentId]: 'preview' }))
    try {
      const blob = await createReportPdfBlob(r, header)
      const url = URL.createObjectURL(blob)
      if (win) { win.location.href = url } else { window.open(url, '_blank') }
      setTimeout(() => URL.revokeObjectURL(url), 60000)
    } catch (e) { if (win) win.close(); setMsg(e instanceof Error ? e.message : '預覽失敗，請再試一次') }
    setRowBusy((p) => ({ ...p, [r.studentId]: undefined }))
  }
  const downloadOne = async (r: StudentReport) => {
    setMsg(''); setRowBusy((p) => ({ ...p, [r.studentId]: 'download' }))
    try { await downloadSingleReport(r, header) } catch (e) { setMsg(e instanceof Error ? e.message : '下載失敗，請再試一次') }
    setRowBusy((p) => ({ ...p, [r.studentId]: undefined }))
  }

  // 批次（多選模式）：只對「勾選、且尚無評語」的生成，保護已編輯內容
  const genSelected = async () => {
    const targets = reports.filter((r) => selected.has(r.studentId) && !r.comment)
    if (!targets.length) { setMsg('勾選的學生都已有評語（如要重寫，請用各列的「重新生成」）'); return }
    setMsg(''); setBatchGen({ done: 0, total: targets.length })
    let done = 0
    await runWithConcurrency(targets, 4, async (r) => {
      const text = await generateParentComment(r, subject)
      if (text) setComment(r.studentId, text)
      done += 1; setBatchGen({ done, total: targets.length })
    })
    setBatchGen(null)
  }
  const downloadSelected = async () => {
    const picked = reports.filter((r) => selected.has(r.studentId))
    if (!picked.length) { setMsg('請先勾選要下載的學生'); return }
    setMsg(''); setBatchPdf({ done: 0, total: picked.length })
    try {
      const { failed } = await downloadReportsAsZip(picked, header, { onProgress: (done, total) => setBatchPdf({ done, total }) })
      if (failed > 0) setMsg(`已下載，但有 ${failed} 份產生失敗（可個別重試）`)
    } catch (e) { setMsg(e instanceof Error ? e.message : '批次下載失敗，請再試一次') }
    setBatchPdf(null)
  }

  const enterMulti = () => { setMultiSelect(true); setSelected(new Set()) }
  const exitMulti = () => { setMultiSelect(false); setSelected(new Set()) }

  if (!reports.length) {
    return <section className="card" style={{ color: '#64748b', fontSize: 13 }}>此作業已批改的卷數不足，暫無法產生家長報告。</section>
  }

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

      {/* 工具列 */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
        <span className="text-sm text-slate-500">{multiSelect ? `已勾選 ${selected.size} / ${reports.length} 位` : `共 ${reports.length} 位學生`}</span>
        <div className="flex-1" />
        {multiSelect ? (
          <>
            <label className="flex items-center gap-1.5 text-sm text-slate-500">
              <input type="checkbox" checked={allSelected} onChange={toggleAll} className="h-4 w-4 accent-sky-600" />全選
            </label>
            <button
              onClick={genSelected} disabled={busy || selected.size === 0}
              className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {batchGen ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {batchGen ? `生成評語 ${batchGen.done}/${batchGen.total}` : `生成教師評語（${selected.size}）`}
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
          <button onClick={enterMulti} className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50">
            <CheckSquare className="h-4 w-4" />多選
          </button>
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
              <th className="px-2 py-2">老師的話（可編輯）</th>
              <th className="w-52 px-2 py-2 text-center">操作</th>
            </tr>
          </thead>
          <tbody>
            {reports.map((r) => {
              const rb = rowBusy[r.studentId]
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
                  <td className="px-2 py-2">
                    <textarea
                      value={r.comment}
                      onChange={(e) => setComment(r.studentId, e.target.value)}
                      placeholder="按右側「生成評語」，或直接手動輸入"
                      rows={3}
                      className="w-full resize-y rounded-md border border-slate-200 px-2.5 py-1.5 text-[13px] leading-relaxed text-slate-700 focus:border-sky-400 focus:outline-none"
                    />
                  </td>
                  <td className="px-2 py-2.5">
                    <div className="flex items-center justify-center gap-1">
                      <button onClick={() => genOne(r)} disabled={!!rb || busy}
                        className="flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-700 disabled:opacity-40">
                        {rb === 'gen' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : (r.comment ? <RefreshCw className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />)}
                        {r.comment ? '重新生成' : '生成評語'}
                      </button>
                      <button onClick={() => previewOne(r)} disabled={!!rb || busy} title="預覽"
                        className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-sky-600 disabled:opacity-40">
                        {rb === 'preview' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
                      </button>
                      <button onClick={() => downloadOne(r)} disabled={!!rb || busy} title="下載 PDF"
                        className="rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-sky-600 disabled:opacity-40">
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
        預設一位一位處理：按「生成評語」→ 可直接修改（自動保留）→「下載」得到那位學生的 PDF。要一次處理多位，按右上「多選」勾選後批次下載（打包 zip）。
      </p>
    </div>
  )
}
