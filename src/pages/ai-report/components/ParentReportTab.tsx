// 家長報告分頁（2026-07-20 逐題診斷版、user 拍板 UI/UX）：
//   骨架（成績/班級位置/題型/知識點熱力圖/錯題截圖＋標準答案）純程式秒開零墨水；
//   AI 產物（逐題錯因診斷＋老師的話）＝花錢，「生成全班報告」一鍵才跑（走 InkConfirm）＋全螢幕 loading。
//   結果快取到 parent_reports（診斷＋評語）；截圖免費、preview/download 時現切。
//   重批改/改答案卷 → server 指紋比對回傳 stale → 紅橫幅提示重新生成（重生一律手動）。
import { useEffect, useMemo, useRef, useState } from 'react'
import { FileDown, Eye, RefreshCw, Loader2, Sparkles, Settings, CheckSquare, X, AlertTriangle } from 'lucide-react'
import {
  assembleParentReports, fetchQuestionCrops,
  applyDiagnosisAndCrops, loadParentReportCache,
  createReportPdfBlob, downloadSingleReport, downloadReportsAsZip,
  loadReportHeaderSettings, loadCachedComments, saveCachedComment, runKpUpgrade,
  type PRQuestion, type PRSubmission, type PRStudent, type ReportHeader, type StudentReport, type DiagnosisItem, type KpUpgradeResult,
} from '@/lib/parentReport'
import { db } from '@/lib/db'
import { generateParentReports } from '@/lib/parentReportBatch'
import { FLAT_BILLING, PARENT_REPORT_POINTS_PER_STUDENT } from '@/lib/action-pricing'

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
  /** 花墨水前先跳同意框（AiReport 提供、可帶自訂內容）；沒提供則直接執行。 */
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

  // ── 2026-07-22 報告分級（user 拍板）：初階＝純程式數據（零墨水、永遠可預覽/下載、評語手寫）；
  //    進階＝知識點歸類(加強地圖) + AI 逐題診斷 + AI 評語。歸類懶跑：升級時才做、一次性、費用算報告。
  const [kpRunning, setKpRunning] = useState(false)
  const pendingAfterKpRef = useRef(false)
  const hasKp = useMemo(
    () => questions.some((q) => Boolean((q as { analysis?: { topic?: string } }).analysis?.topic)),
    [questions],
  )
  // 閘②：低信心（<70）未確認格數——生成前提醒（發出後老師改分會讓報告失效、要重生）
  const lowConfCount = useMemo(() => {
    let n = 0
    for (const s of submissions) {
      const det = (s.gradingResult as { details?: Array<{ systemConfidence?: number }> } | undefined)?.details ?? []
      for (const d of det) if (typeof d?.systemConfidence === 'number' && d.systemConfidence < 70) n++
    }
    return n
  }, [submissions])

  const busy = genState !== null || batchPdf !== null || kpRunning
  const needsGen = (r: StudentReport) => !generatedSet.has(r.studentId) || staleSet.has(r.studentId)
  const pending = reports.filter(needsGen)

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

  // 生成（診斷＋截圖＋評語）→ 更新 state ＋ 快取；forceComment=true 時連已編輯的評語也重寫（單列重新生成用）
  // 2026-08-03：生成核心抽到 lib/parentReportBatch（行政端全校批次共用同一條路，
  //   不能有兩套邏輯——老師按的和行政批次按的必須產出一樣的東西）。這裡只負責畫面狀態。
  const doGenerate = async (targets: StudentReport[], forceComment: boolean) => {
    if (!targets.length) return
    setMsg(''); setGenState({ done: 0, total: targets.length })
    const { failed, unsaved } = await generateParentReports({
      assignmentId, subject, targets, forceComment,
      onDone: (updated) => {
        setReports((prev) => prev.map((x) => (x.studentId === updated.studentId ? updated : x)))
        setStaleSet((prev) => { const n = new Set(prev); n.delete(updated.studentId); return n })
        setGeneratedSet((prev) => new Set(prev).add(updated.studentId))
      },
      onProgress: (d, total) => setGenState({ done: d, total }),
    })
    setGenState(null)
    const warns: string[] = []
    if (failed) warns.push(`有 ${failed} 位生成失敗，可用各列「重新生成」單獨重試`)
    if (unsaved.length) warns.push(`⚠ 有 ${unsaved.length} 位的診斷已生成但「雲端儲存失敗」——重新整理頁面會遺失、需重新生成。請先不要重新整理，並把此訊息回報開發者（瀏覽器 Console 有詳細錯誤）。`)
    if (warns.length) setMsg(warns.join('\n'))
  }

  const requestGen = (targets: StudentReport[], forceComment: boolean) => {
    if (!targets.length) { setMsg('目前沒有需要生成的學生'); return }
    // 統一走 InkConfirmModal（2026-07-22 user 拍板：不混用瀏覽器 confirm）——
    //   升級說明＋低信心警告（閘②）都放進同一個 modal 內容。
    const inkMessage = (
      <div className="space-y-2">
        <div>
          {hasKp
            ? <>即將為 <b>{targets.length}</b> 位學生產生 AI 逐題診斷與老師的話。</>
            : <>首次升級：會先建立本卷「<b>知識點歸類</b>」（一次性、之後不再收費），接著為 <b>{targets.length}</b> 位學生產生 AI 逐題診斷與老師的話。</>}
        </div>
        {FLAT_BILLING && (
          <div className="rounded-lg bg-sky-50 border border-sky-200 px-3 py-2 text-sky-800">
            費用:{targets.length} 位 × {PARENT_REPORT_POINTS_PER_STUDENT} 點 = <b>{targets.length * PARENT_REPORT_POINTS_PER_STUDENT} 點</b>
            <span className="ml-1 text-xs text-sky-600">(固定價;生成失敗的學生不扣)</span>
          </div>
        )}
        {lowConfCount > 0 && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700">
            ⚠ 本作業還有 <b>{lowConfCount}</b> 格「低信心」判定尚未人工確認。報告發出後若再改分數，該生報告會失效需重新生成。建議先到批改頁確認。
          </div>
        )}
      </div>
    )
    const run = () => {
      void (async () => {
        // 閘①：無知識點歸類 → 先就地跑（一次性、寫入 answer_key 後全班/未來重生共用）
        if (!hasKp) {
          setKpRunning(true); setMsg('')
          try {
            const r = await runKpUpgrade(assignmentId, subject, questions, grade)
            await mergeKpIntoDexie(r)
            pendingAfterKpRef.current = true // questions 重載、reports 重組後自動接續生成
            setKpRunning(false)
            onKpSaved?.()
            if (!onKpSaved) setMsg('知識點歸類完成，請重新整理頁面後再按一次生成')
            return
          } catch (e) {
            setKpRunning(false)
            setMsg(`知識點歸類失敗：${e instanceof Error ? e.message : String(e)}`)
            return
          }
        }
        await doGenerate(targets, forceComment)
      })()
    }
    if (requestInk) requestInk(run, inkMessage); else run()
  }
  const genAll = () => requestGen(pending, false)
  const genSelectedOnly = () => requestGen(reports.filter((r) => selected.has(r.studentId) && needsGen(r)), false)
  const genOne = (r: StudentReport) => requestGen([r], true)

  // 歸類完成 → AiReport 重載 questions → reports 依新 questions 重組（帶加強地圖）→ 自動接續生成
  useEffect(() => {
    if (!pendingAfterKpRef.current || !hasKp || !reports.length) return
    pendingAfterKpRef.current = false
    void doGenerate(reports.filter(needsGen), false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasKp, reports])

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
      const { failed, failures } = await downloadReportsAsZip(withCrops, header, { onProgress: (done, total) => setBatchPdf({ done, total }) })
      const who = failures.map((f) => `${f.seat}號 ${f.name}`).join('、')
      const notes = [
        failed > 0 ? `${failed} 份產生失敗（${who}），可用各列下載鈕個別重試` : '',
        skipped > 0 ? `${skipped} 位尚未生成、已略過` : '',
      ].filter(Boolean)
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

      {/* 報告等級（2026-07-22）：初階＝零墨水基本數據；進階＝知識點加強地圖＋AI 診斷/評語 */}
      <div className={`flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm ${hasKp ? 'border-sky-200 bg-sky-50 text-sky-800' : 'border-slate-200 bg-slate-50 text-slate-600'}`}>
        <span className={`rounded px-2 py-0.5 text-xs font-bold ${hasKp ? 'bg-sky-600 text-white' : 'bg-slate-400 text-white'}`}>
          {hasKp ? '進階版' : '初階版'}
        </span>
        {hasKp
          ? <span>本作業已建立知識點歸類——報告含「加強地圖」與逐題 AI 診斷。</span>
          : <span>目前為基本數據報告（成績／落點／題型答對率／錯題表，隨時可預覽下載、評語可手寫）。按「升級為進階版」建立知識點歸類＋AI 逐題診斷與評語。</span>}
      </div>

      {kpRunning && (
        <div className="flex items-center gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-700">
          <Loader2 className="h-4 w-4 animate-spin" />正在建立知識點歸類（每卷一次性、之後重生報告不再收費）…
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
              {cacheLoading ? '載入中…' : !hasKp ? `升級為進階版（${pending.length} 位）` : pending.length ? `生成全班報告（${pending.length}）` : '全班已生成'}
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
              // 2026-08-03 修（user 回報「進去沒有初階報告可以看」）：
              //   預覽/下載原本卡 generated，與「初階＝零墨水、永遠可預覽下載」的定案相牴觸。
              //   沒生成過就是少了 AI 診斷與評語，骨架（成績/落點/題型/加強地圖/錯題裁圖+正解）都算得出來。
              const generated = generatedSet.has(r.studentId) // 生成過（含已失效）＝有 AI 產物
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
                      <button onClick={() => previewOne(r)} disabled={busy || cacheLoading || !!rb}
                        title={generated ? '預覽' : '預覽基本數據版（尚未生成 AI 診斷與評語）'}
                        className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-sky-600 disabled:opacity-40 disabled:cursor-not-allowed">
                        {rb === 'preview' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
                      </button>
                      <button onClick={() => downloadOne(r)} disabled={busy || cacheLoading || !!rb}
                        title={generated ? '下載 PDF' : '下載基本數據版（尚未生成 AI 診斷與評語）'}
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
