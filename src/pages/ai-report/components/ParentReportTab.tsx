// 家長報告分頁（2026-07-18 改版、user 拍板獨立 tab）：生成評語→逐生編輯→單獨/批次下載 PDF。
//   設定（校名/校徽/老師）在偏好設定頁維護；評語編輯後存 localStorage（依作業快取、跨次保留）。
import { useEffect, useMemo, useState } from 'react'
import { FileDown, Eye, RefreshCw, Loader2, Sparkles, Settings } from 'lucide-react'
import {
  assembleParentReports, generateParentComment, createReportPdfBlob,
  downloadSingleReport, downloadReportsAsZip,
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
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [commentPhase, setCommentPhase] = useState<'idle' | 'running'>('idle')
  const [commentProgress, setCommentProgress] = useState({ done: 0, total: 0 })
  const [rowBusy, setRowBusy] = useState<Record<string, 'download' | 'regen' | 'preview' | undefined>>({})
  const [batchBusy, setBatchBusy] = useState(false)
  const [batchProgress, setBatchProgress] = useState({ done: 0, total: 0 })
  const [settings, setSettings] = useState(loadReportHeaderSettings())
  const [msg, setMsg] = useState('')

  // 組裝報告 + 套用快取評語
  useEffect(() => {
    setSettings(loadReportHeaderSettings())
    let list: StudentReport[] = []
    try { list = assembleParentReports(questions, submissions, students) } catch { list = [] }
    const cached = loadCachedComments(assignmentId)
    for (const r of list) if (cached[r.studentId]) r.comment = cached[r.studentId]
    setReports(list)
    setSelected(new Set(list.map((r) => r.studentId)))
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

  const hasComments = reports.some((r) => r.comment)
  const emptyCount = reports.filter((r) => !r.comment).length

  const genComments = async () => {
    const targets = reports.filter((r) => !r.comment) // 只補空的、不蓋掉老師改過的
    if (!targets.length) return
    setCommentPhase('running'); setCommentProgress({ done: 0, total: targets.length }); setMsg('')
    let done = 0
    await runWithConcurrency(targets, 4, async (r) => {
      const text = await generateParentComment(r, subject)
      if (text) setComment(r.studentId, text)
      done += 1; setCommentProgress({ done, total: targets.length })
    })
    setCommentPhase('idle')
  }
  const regenOne = async (r: StudentReport) => {
    setRowBusy((p) => ({ ...p, [r.studentId]: 'regen' }))
    const text = await generateParentComment(r, subject)
    if (text) setComment(r.studentId, text)
    setRowBusy((p) => ({ ...p, [r.studentId]: undefined }))
  }
  const previewOne = async (r: StudentReport) => {
    setRowBusy((p) => ({ ...p, [r.studentId]: 'preview' }))
    try {
      const blob = await createReportPdfBlob(r, header)
      const url = URL.createObjectURL(blob)
      window.open(url, '_blank')
      setTimeout(() => URL.revokeObjectURL(url), 30000)
    } catch { setMsg('預覽失敗，請再試一次') }
    setRowBusy((p) => ({ ...p, [r.studentId]: undefined }))
  }
  const downloadOne = async (r: StudentReport) => {
    setRowBusy((p) => ({ ...p, [r.studentId]: 'download' }))
    try { await downloadSingleReport(r, header) } catch { setMsg('下載失敗，請再試一次') }
    setRowBusy((p) => ({ ...p, [r.studentId]: undefined }))
  }
  const downloadBatch = async () => {
    const picked = reports.filter((r) => selected.has(r.studentId))
    if (!picked.length) { setMsg('請先勾選要下載的學生'); return }
    setBatchBusy(true); setBatchProgress({ done: 0, total: picked.length }); setMsg('')
    try {
      await downloadReportsAsZip(picked, header, { onProgress: (done, total) => setBatchProgress({ done, total }) })
    } catch { setMsg('批次下載失敗，請再試一次') }
    setBatchBusy(false)
  }

  if (!reports.length) {
    return <section className="card" style={{ color: '#64748b', fontSize: 13 }}>此作業已批改的卷數不足，暫無法產生家長報告。</section>
  }

  const busy = commentPhase === 'running' || batchBusy

  return (
    <div className="space-y-3">
      {/* 設定狀態列 */}
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
        <button
          onClick={genComments} disabled={busy || emptyCount === 0}
          className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {commentPhase === 'running' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {commentPhase === 'running' ? `生成評語 ${commentProgress.done}/${commentProgress.total}` : hasComments ? `補生成評語（${emptyCount}）` : '生成老師評語'}
        </button>
        <div className="flex-1" />
        <label className="flex items-center gap-1.5 text-sm text-slate-500">
          <input type="checkbox" checked={allSelected} onChange={toggleAll} className="h-4 w-4 accent-sky-600" />全選
        </label>
        <button
          onClick={downloadBatch} disabled={busy || selected.size === 0}
          className="flex items-center gap-1.5 rounded-lg border border-sky-600 px-3 py-1.5 text-sm font-medium text-sky-700 hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {batchBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
          {batchBusy ? `打包中 ${batchProgress.done}/${batchProgress.total}` : `批次下載（${selected.size}）`}
        </button>
      </div>

      {msg && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{msg}</div>}

      {/* 學生清單 */}
      <div className="overflow-hidden rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50 text-left text-xs text-slate-500">
              <th className="w-10 px-3 py-2"></th>
              <th className="w-28 px-2 py-2">座號 · 姓名</th>
              <th className="w-16 px-2 py-2 text-right">分數</th>
              <th className="px-2 py-2">老師的話（可編輯）</th>
              <th className="w-32 px-2 py-2 text-center">操作</th>
            </tr>
          </thead>
          <tbody>
            {reports.map((r) => {
              const rb = rowBusy[r.studentId]
              return (
                <tr key={r.studentId} className="border-b border-slate-50 last:border-0 align-top">
                  <td className="px-3 py-2.5">
                    <input type="checkbox" checked={selected.has(r.studentId)} onChange={() => toggle(r.studentId)} className="h-4 w-4 accent-sky-600" />
                  </td>
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
                      placeholder={commentPhase === 'running' ? '生成中…' : '按上方「生成老師評語」，或直接手動輸入'}
                      rows={3}
                      className="w-full resize-y rounded-md border border-slate-200 px-2.5 py-1.5 text-[13px] leading-relaxed text-slate-700 focus:border-sky-400 focus:outline-none"
                    />
                  </td>
                  <td className="px-2 py-2.5">
                    <div className="flex items-center justify-center gap-1">
                      <button onClick={() => regenOne(r)} disabled={!!rb || busy} title="重新生成評語"
                        className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-sky-600 disabled:opacity-40">
                        {rb === 'regen' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
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
        評語由 AI 依批改結果生成，你可以直接修改；修改會自動保留。下載的 PDF 一位學生一份，可個別或勾選批次打包。
      </p>
    </div>
  )
}
