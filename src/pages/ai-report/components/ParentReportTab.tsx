// 家長報告分頁（2026-08-11 退回無 AI 版、user 拍板：「為什麼錯」歸老師的專業與責任）：
//   報告＝純程式確定性產物（成績/班級位置/題型答對率/知識點加強地圖/錯題截圖＋標準答案＋班級狀況），
//   秒開零墨水、永遠與最新批改一致——重批改不需重新生成、沒有「失效」概念。
//   老師的話＝手動輸入（不再 AI 草擬）；逐題錯因診斷已整個移除。
//   知識點歸類已改建卷時預跑（2026-08-11）；此頁保留「補跑歸類」給舊卷（一次性、花墨水）。
//   舊快取（parent_reports）只回讀「評語」讓老師先前寫過/改過的話不消失；診斷欄位不再讀取。
import { useEffect, useMemo, useRef, useState } from 'react'
import { FileDown, Eye, Loader2, Sparkles, Settings, CheckSquare, X } from 'lucide-react'
import {
  assembleParentReports, fetchQuestionCrops,
  applyDiagnosisAndCrops, loadParentReportCache,
  createReportPdfBlob, downloadSingleReport, downloadReportsAsZip,
  loadReportHeaderSettings, loadCachedComments, saveCachedComment, runKpUpgrade,
  type PRQuestion, type PRSubmission, type PRStudent, type ReportHeader, type StudentReport, type KpUpgradeResult,
} from '@/lib/parentReport'
import { db } from '@/lib/db'

function formatDateZh(d: Date): string {
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`
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
  /** 花墨水前先跳同意框（AiReport 提供、可帶自訂內容）；沒提供則直接執行。現在只有「補跑知識點歸類」會用到。 */
  requestInk?: (fn: () => void, message?: React.ReactNode) => void
  /** 2026-07-22：知識點歸類寫入完成後通知 AiReport 重新載入 questions（Dexie 已更新）。 */
  onKpSaved?: () => void
  /** 班級年級（7~9）：無固定清單的科目用它動態抓 concept_map 課綱條文。 */
  grade?: number
  /**
   * 2026-08-03（user 提：行政帳號可能共用，per-device 設定不適用）：
   *   由外部帶入的報告抬頭，優先於本機 localStorage。行政端傳學校級設定（雲端）＋
   *   該班該科的任課老師；教師端不傳＝維持原本的個人設定行為。
   */
  headerOverride?: { schoolName?: string; crestDataUrl?: string; teacherName?: string }
  /** 老師沒在偏好設定填名字時的預設（教師端＝登入者本人姓名）。 */
  fallbackTeacherName?: string
}

export function ParentReportTab({
  questions, submissions, students, kpTips, assignmentId, className, subject, assignmentTitle, onOpenPreferences, requestInk, onKpSaved, grade, headerOverride, fallbackTeacherName,
}: Props) {
  const [reports, setReports] = useState<StudentReport[]>([])
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
    setMsg('')
    // 雲端舊快取只回讀「評語」（老師先前寫/改過的話不消失）；本機編輯優先。診斷欄位不再讀。
    let cancelled = false
    loadParentReportCache(assignmentId)
      .then((cache) => {
        if (cancelled || cache.size === 0) return
        const localCmts = loadCachedComments(assignmentId)
        setReports((prev) => prev.map((r) => {
          const c = cache.get(r.studentId)
          if (!c?.comment || localCmts[r.studentId]) return r
          return { ...r, comment: c.comment }
        }))
      })
      .catch(() => { /* 讀不到雲端評語不影響報告本體 */ })
    return () => { cancelled = true }
  }, [questions, submissions, students, kpTips, assignmentId])

  // 抬頭優先序（2026-08-03 user 拍板）：
  //   校名/校徽＝學校設定「取代」個人設定（校徽是學校識別、家長會同時收到各科老師的報告）
  //   老師姓名＝行政端帶該班任課老師；教師端沒填就用登入者本人
  const header: ReportHeader = useMemo(() => ({
    schoolName: headerOverride?.schoolName || settings.schoolName || '',
    crestDataUrl: headerOverride?.crestDataUrl || settings.crestDataUrl,
    className, subject, assignmentTitle,
    teacherName: headerOverride?.teacherName || settings.teacherName || fallbackTeacherName || undefined,
    dateStr: formatDateZh(new Date()),
  }), [settings, headerOverride, fallbackTeacherName, className, subject, assignmentTitle])

  const setComment = (studentId: string, text: string) => {
    setReports((prev) => prev.map((r) => (r.studentId === studentId ? { ...r, comment: text } : r)))
    saveCachedComment(assignmentId, studentId, text)
  }
  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  const allSelected = reports.length > 0 && selected.size === reports.length
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(reports.map((r) => r.studentId)))

  // ── 知識點歸類（加強地圖的資料來源）：新卷建卷時已預跑；舊卷用這顆補（一次性、之後全班/未來共用）。
  const [kpRunning, setKpRunning] = useState(false)
  const hasKp = useMemo(
    () => questions.some((q) => Boolean((q as { analysis?: { topic?: string } }).analysis?.topic)),
    [questions],
  )

  const busy = batchPdf !== null || kpRunning

  // 歸類結果同步回本地 Dexie（server 已寫入；不更新 Dexie 的話下次 sync 前 questions 還是舊的）
  const mergeKpIntoDexie = async (r: KpUpgradeResult) => {
    try {
      const a = await db.assignments.get(assignmentId)
      const ak = a?.answerKey as { questions?: Array<{ id?: string; analysis?: unknown }>; kpTips?: Record<string, string> } | undefined
      if (!a || !ak?.questions) return
      const byId = new Map(r.items.map((it) => [String(it.questionId), it]))
      for (const q of ak.questions) {
        const it = byId.get(String(q.id ?? ''))
        if (it) q.analysis = { topic: it.topic, knowledgePoints: it.knowledgePoints, ...(it.ability ? { ability: it.ability } : {}), ...(it.note ? { note: it.note } : {}) }
      }
      ak.kpTips = { ...(ak.kpTips ?? {}), ...r.kpTips }
      await db.assignments.put(a)
    } catch { /* Dexie 更新失敗 → 下次 sync 會拉回 server 版 */ }
  }

  const kpBackfillRunningRef = useRef(false)
  const runKpBackfill = () => {
    const inkMessage = (
      <div>
        即將為本卷建立「<b>知識點歸類</b>」（一次性、寫入答案卷後全班與未來重看共用；新建的答案卷會自動歸類，這裡只給舊卷補跑）。
      </div>
    )
    const run = () => {
      if (kpBackfillRunningRef.current) return
      kpBackfillRunningRef.current = true
      void (async () => {
        setKpRunning(true); setMsg('')
        try {
          const r = await runKpUpgrade(assignmentId, subject, questions, grade)
          await mergeKpIntoDexie(r)
          onKpSaved?.()
          if (!onKpSaved) setMsg('知識點歸類完成，請重新整理頁面')
        } catch (e) {
          setMsg(`知識點歸類失敗：${e instanceof Error ? e.message : String(e)}`)
        } finally {
          setKpRunning(false)
          kpBackfillRunningRef.current = false
        }
      })()
    }
    if (requestInk) requestInk(run, inkMessage); else run()
  }

  // 截圖免費、preview/download 時現切；已有 crop 就跳過。
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
    const picked = reports.filter((r) => selected.has(r.studentId))
    if (!picked.length) { setMsg('請先勾選要下載的學生'); return }
    setMsg(''); setBatchPdf({ done: 0, total: picked.length })
    try {
      const withCrops: StudentReport[] = []
      for (const r of picked) withCrops.push(await ensureCrops(r))
      const { failed, failures } = await downloadReportsAsZip(withCrops, header, { onProgress: (done, total) => setBatchPdf({ done, total }) })
      if (failed > 0) {
        const who = failures.map((f) => `${f.seat}號 ${f.name}`).join('、')
        setMsg(`已下載，但 ${failed} 份產生失敗（${who}），可用各列下載鈕個別重試`)
      }
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
      {/* 學校統一設定生效時明說，免得老師改了個人設定卻沒反應、以為壞掉 */}
      {!!headerOverride?.schoolName && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
          校名與校徽採用學校統一設定（{headerOverride.schoolName}），個人偏好設定不會套用到這裡。
        </div>
      )}

      {/* 抬頭由外部帶入時（行政端＝學校級雲端設定），不再叫使用者去改本機偏好設定 */}
      {!header.schoolName && (
        <div className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
          <span>尚未設定學校名稱，報告抬頭會空白。</span>
          {!headerOverride && (
            <button onClick={onOpenPreferences} className="flex items-center gap-1 font-medium text-amber-800 hover:underline">
              <Settings className="h-3.5 w-3.5" />前往偏好設定
            </button>
          )}
        </div>
      )}

      {/* 舊卷沒有知識點歸類 → 報告缺「加強地圖」，提供一次性補跑（新卷建卷時已自動歸類） */}
      {!hasKp && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800">
          <span>這份作業還沒有知識點歸類（舊卷）——報告會缺「知識點加強地圖」。新建答案卷會自動歸類。</span>
          <button
            onClick={runKpBackfill} disabled={busy}
            className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {kpRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            補跑知識點歸類
          </button>
        </div>
      )}

      {kpRunning && (
        <div className="flex items-center gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-700">
          <Loader2 className="h-4 w-4 animate-spin" />正在建立知識點歸類（每卷一次性、之後不再收費）…
        </div>
      )}

      {/* 工具列 */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
        <span className="text-sm text-slate-500">
          {multiSelect ? `已勾選 ${selected.size} / ${reports.length} 位` : `共 ${reports.length} 位・隨時可預覽下載`}
        </span>
        <div className="flex-1" />
        {multiSelect ? (
          <>
            <label className="flex items-center gap-1.5 text-sm text-slate-500">
              <input type="checkbox" checked={allSelected} onChange={toggleAll} className="h-4 w-4 accent-sky-600" />全選
            </label>
            <button
              onClick={downloadSelected} disabled={busy || selected.size === 0}
              className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
              title="每位一份 PDF、打包成 zip 下載"
            >
              {batchPdf ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
              {batchPdf ? `產生中 ${batchPdf.done}/${batchPdf.total}` : `下載報告（${selected.size}）`}
            </button>
            <button onClick={exitMulti} disabled={busy} className="rounded-lg px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100 disabled:opacity-40">取消多選</button>
          </>
        ) : (
          <button onClick={enterMulti} className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50">
            <CheckSquare className="h-4 w-4" />多選下載
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
              <th className="px-2 py-2">老師的話（手動輸入、自動儲存）</th>
              <th className="w-24 px-2 py-2 text-center">操作</th>
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
                      placeholder="想對家長說的話（選填；留空＝報告保留空白欄位、紙本可手寫）"
                      rows={3}
                      className="w-full resize-y rounded-md border border-slate-200 px-2.5 py-1.5 text-[13px] leading-relaxed text-slate-700 focus:border-sky-400 focus:outline-none"
                    />
                  </td>
                  <td className="px-2 py-2.5">
                    <div className="flex items-center justify-center gap-1">
                      <button onClick={() => previewOne(r)} disabled={busy || !!rb} title="預覽"
                        className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-sky-600 disabled:opacity-40 disabled:cursor-not-allowed">
                        {rb === 'preview' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
                      </button>
                      <button onClick={() => downloadOne(r)} disabled={busy || !!rb} title="下載 PDF"
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
        報告內容（成績與班級落點、題型答對率、知識點加強地圖、錯題裁圖＋標準答案＋班級狀況）由系統即時計算，
        永遠對應最新批改結果——重新批改或改分後直接重新下載即可，不需要「重新生成」。
        「老師的話」直接在表格輸入、自動儲存；留空＝報告保留空白欄位、紙本可手寫。下載為每位一份 PDF。
      </p>

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
