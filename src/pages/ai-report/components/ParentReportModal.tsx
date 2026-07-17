// 家長報告產出 Modal（2026-07-18、B2B MVP）：設定校名/校徽/老師 → 產生全班報告 → AI 評語 → 打包 zip 下載。
import { useEffect, useMemo, useRef, useState } from 'react'
import { X, FileDown, Loader2, Image as ImageIcon, Info } from 'lucide-react'
import {
  assembleParentReports, generateParentComment, generateParentReportZip,
  type PRQuestion, type PRSubmission, type PRStudent, type ReportHeader, type StudentReport,
} from '@/lib/parentReport'

const HEADER_STORE_KEY = 'parentReport.header.v1'

type SavedHeader = { schoolName: string; crestDataUrl?: string; teacherName?: string }
function loadHeader(): SavedHeader {
  try { return JSON.parse(localStorage.getItem(HEADER_STORE_KEY) || '{}') } catch { return { schoolName: '' } }
}
function saveHeader(h: SavedHeader) {
  try { localStorage.setItem(HEADER_STORE_KEY, JSON.stringify(h)) } catch { /* ignore quota */ }
}

function formatDateZh(d: Date): string {
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

// 有限併發跑 AI 評語
async function runWithConcurrency<T>(items: T[], limit: number, fn: (item: T, idx: number) => Promise<void>) {
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx) }
  })
  await Promise.all(workers)
}

type Props = {
  open: boolean
  onClose: () => void
  questions: PRQuestion[]
  submissions: PRSubmission[]
  students: PRStudent[]
  className: string
  subject: string
  assignmentTitle: string
}

export function ParentReportModal({
  open, onClose, questions, submissions, students, className, subject, assignmentTitle,
}: Props) {
  const [schoolName, setSchoolName] = useState('')
  const [crestDataUrl, setCrestDataUrl] = useState<string | undefined>(undefined)
  const [teacherName, setTeacherName] = useState('')
  const [withComment, setWithComment] = useState(true)
  const [phase, setPhase] = useState<'idle' | 'comment' | 'pdf' | 'done' | 'error'>('idle')
  const [progress, setProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 })
  const [errMsg, setErrMsg] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    const h = loadHeader()
    setSchoolName(h.schoolName || '')
    setCrestDataUrl(h.crestDataUrl)
    setTeacherName(h.teacherName || '')
    setPhase('idle'); setProgress({ done: 0, total: 0 }); setErrMsg('')
  }, [open])

  const reports = useMemo<StudentReport[]>(() => {
    if (!open) return []
    try { return assembleParentReports(questions, submissions, students) } catch { return [] }
  }, [open, questions, submissions, students])

  if (!open) return null

  const onPickCrest = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 2 * 1024 * 1024) { setErrMsg('校徽圖片請小於 2MB'); return }
    const reader = new FileReader()
    reader.onload = () => setCrestDataUrl(typeof reader.result === 'string' ? reader.result : undefined)
    reader.readAsDataURL(file)
  }

  const busy = phase === 'comment' || phase === 'pdf'

  const handleGenerate = async () => {
    if (!reports.length) { setErrMsg('這份作業還沒有可用的批改結果'); return }
    setErrMsg('')
    saveHeader({ schoolName, crestDataUrl, teacherName })
    const header: ReportHeader = {
      schoolName: schoolName.trim(), crestDataUrl,
      className, subject, assignmentTitle,
      teacherName: teacherName.trim() || undefined,
      dateStr: formatDateZh(new Date()),
    }
    try {
      if (withComment) {
        setPhase('comment'); setProgress({ done: 0, total: reports.length })
        let done = 0
        await runWithConcurrency(reports, 4, async (r) => {
          r.comment = await generateParentComment(r, subject)
          done += 1; setProgress({ done, total: reports.length })
        })
      }
      setPhase('pdf'); setProgress({ done: 0, total: reports.length })
      await generateParentReportZip(reports, header, {
        onProgress: (done, total) => setProgress({ done, total }),
      })
      setPhase('done')
    } catch (e) {
      setPhase('error')
      setErrMsg(e instanceof Error ? e.message : '產生報告時發生問題，請再試一次')
    }
  }

  return (
    <div className="fixed inset-0 z-[500] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg rounded-xl bg-white shadow-2xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3">
          <h3 className="text-base font-semibold text-gray-900">產生家長報告</h3>
          <button onClick={onClose} disabled={busy} className="rounded p-1 text-gray-400 hover:bg-gray-100 disabled:opacity-40" aria-label="關閉">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {/* 作業資訊 */}
          <div className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-600">
            <div><span className="text-gray-400">作業：</span>{assignmentTitle || '未命名作業'}</div>
            <div className="mt-0.5">
              <span className="text-gray-400">科目：</span>{subject || '—'}
              <span className="mx-2 text-gray-300">·</span>
              <span className="text-gray-400">班級：</span>{className || '—'}
              <span className="mx-2 text-gray-300">·</span>
              可產生 <span className="font-semibold text-gray-900">{reports.length}</span> 份報告
            </div>
          </div>

          {/* 抬頭設定 */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">學校名稱（顯示在報告抬頭）</label>
            <input
              value={schoolName} onChange={(e) => setSchoolName(e.target.value)}
              placeholder="例：○○私立高級中學附設國中部"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
            />
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-gray-500">任課老師（選填）</label>
              <input
                value={teacherName} onChange={(e) => setTeacherName(e.target.value)}
                placeholder="例：林○○"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">校徽（選填）</label>
              <div className="flex items-center gap-2">
                {crestDataUrl
                  ? <img src={crestDataUrl} alt="校徽" className="h-9 w-9 rounded border border-gray-200 object-contain" />
                  : <div className="flex h-9 w-9 items-center justify-center rounded border border-dashed border-gray-300 text-gray-300"><ImageIcon className="h-4 w-4" /></div>}
                <button onClick={() => fileRef.current?.click()} className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs text-gray-600 hover:bg-gray-50">
                  {crestDataUrl ? '更換' : '上傳'}
                </button>
                {crestDataUrl && <button onClick={() => setCrestDataUrl(undefined)} className="text-xs text-gray-400 hover:text-gray-600">移除</button>}
                <input ref={fileRef} type="file" accept="image/*" onChange={onPickCrest} className="hidden" />
              </div>
            </div>
          </div>

          <p className="flex items-start gap-1.5 text-xs text-gray-400">
            <Info className="mt-0.5 h-3.5 w-3.5 flex-none" />
            學校名稱與校徽會記在這台裝置，下次自動帶入。
          </p>

          {/* AI 評語 toggle */}
          <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-gray-200 px-3 py-2.5">
            <input type="checkbox" checked={withComment} onChange={(e) => setWithComment(e.target.checked)} className="h-4 w-4 accent-blue-600" />
            <span className="flex-1 text-sm text-gray-700">
              自動生成「老師的話」
              <span className="ml-1 text-xs text-gray-400">依批改結果生成鼓勵型評語，你之後可再修改</span>
            </span>
          </label>

          {errMsg && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{errMsg}</div>}

          {/* 進度 */}
          {busy && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-gray-500">
                <span>{phase === 'comment' ? '生成老師評語中…' : '產生 PDF 中…'}</span>
                <span className="font-medium tabular-nums">{progress.done} / {progress.total}</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
                <div className="h-full rounded-full bg-blue-500 transition-all"
                  style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
              </div>
            </div>
          )}

          {phase === 'done' && (
            <div className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
              已產生 {reports.length} 份報告並下載壓縮檔。每位學生一份 PDF，可分別傳給家長。
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-5 py-3">
          <button onClick={onClose} disabled={busy} className="rounded-lg px-4 py-2 text-sm text-gray-500 hover:bg-gray-100 disabled:opacity-40">
            {phase === 'done' ? '關閉' : '取消'}
          </button>
          <button
            onClick={handleGenerate} disabled={busy || !reports.length}
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
            {busy ? '產生中…' : phase === 'done' ? '再次產生' : '產生並下載'}
          </button>
        </div>
      </div>
    </div>
  )
}
