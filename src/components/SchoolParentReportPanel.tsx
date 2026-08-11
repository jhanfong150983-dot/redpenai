import { useCallback, useEffect, useState } from 'react'
import { FileText, Settings } from 'lucide-react'
import { db } from '@/lib/db'
import { ensureAssignmentDetails } from '@/lib/submission-details'
import { ParentReportTab } from '@/pages/ai-report/components/ParentReportTab'
import InkConfirmModal from '@/components/InkConfirmModal'
import type { ItemAnalysisQuestion } from '@/pages/ai-report/item-analysis'
import type { PRStudent, PRSubmission } from '@/lib/parentReport'
import { useSchoolReportSettings } from '@/components/SchoolReportSettings'

/**
 * 2026-08-03 Step 12:行政端家長報告。
 *
 * user 拍板「逐班沿用教師端分頁」——直接嵌入 ParentReportTab,不另做一套行政向 UI。
 *   好處:教師端修什麼行政端跟著好,兩邊報告內容保證一致(同一份給家長的東西不該有兩種版本)。
 *
 * 2026-08-11 退回無 AI 版(user 拍板:「為什麼錯」歸老師專業):報告=純程式確定性產物、
 *   零墨水隨時下載,「全校批次 AI 生成」整個移除;墨水只剩舊卷「補跑知識點歸類」會用到。
 * ⚠ sync 瘦身後 gradingResult 不隨 sync 下來,進來前必須 ensureAssignmentDetails。
 */

interface ClassEntry {
  assignmentId: string
  className: string
  campusClassId?: string
  /** 該班該科的任課老師(server 從 school_class_courses 對出來的),報告抬頭自動帶入 */
  teacherName?: string
}

export default function SchoolParentReportPanel({
  classes,
  examTitle,
  schoolId,
  onOpenSettings,
  openClass,
  onOpenClassChange
}: {
  classes: ClassEntry[]
  examTitle: string
  schoolId: string
  /** 導到行政端「偏好設定」分頁(抬頭是學校級設定、不該藏在報告頁裡改) */
  onOpenSettings: () => void
  /**
   * 2026-08-03(user:兩個返回的 UI 好奇怪):目前打開的班級改由外層持有,
   *   麵包屑才能一條到底(考卷列表 › 報告生成 › 班級),不會上下疊兩排返回鈕。
   */
  openClass: ClassEntry | null
  onOpenClassChange: (c: ClassEntry | null) => void
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [inkAction, setInkAction] = useState<{ fn: () => void; message?: React.ReactNode } | null>(null)
  const [data, setData] = useState<{
    questions: ItemAnalysisQuestion[]
    kpTips: Record<string, string>
    submissions: PRSubmission[]
    students: PRStudent[]
    subject: string
    title: string
    grade?: number
  } | null>(null)
  // 各班已批改份數(決定按鈕能不能按;家長報告門檻與教師端一致=至少 3 份)
  const [counts, setCounts] = useState<Record<string, { graded: number; total: number }>>({})
  // 2026-08-03(user 提:行政帳號可能共用)報告抬頭改學校級雲端設定,不再用 localStorage
  // 抬頭設定改由「偏好設定」分頁維護(學校級、雲端);這裡只讀來組報告抬頭。
  const { value: settings } = useSchoolReportSettings(schoolId)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const next: Record<string, { graded: number; total: number }> = {}
      for (const c of classes) {
        const subs = await db.submissions.where('assignmentId').equals(c.assignmentId).toArray()
        next[c.assignmentId] = {
          total: subs.length,
          // 輕量判定:sync 瘦身後列表拿得到的是 hasGradingResult,不必為了數數補齊大 JSONB
          graded: subs.filter((s) => s.hasGradingResult || s.gradingResult || typeof s.score === 'number').length
        }
      }
      if (!cancelled) setCounts(next)
    })()
    return () => { cancelled = true }
  }, [classes])

  const open = useCallback(async (c: ClassEntry) => {
    setLoading(true)
    setError(null)
    onOpenClassChange(c)
    try {
      // 逐題診斷/錯題卡片要吃 gradingResult,先補齊(sync 已不帶大 JSONB)
      await ensureAssignmentDetails([c.assignmentId])
      const assignment = await db.assignments.get(c.assignmentId)
      if (!assignment) throw new Error('找不到這個班級的作業資料,請先回考卷列表重新進入')
      const ak = assignment.answerKey as
        | { questions?: ItemAnalysisQuestion[]; kpTips?: Record<string, string> }
        | undefined
      const subs = await db.submissions.where('assignmentId').equals(c.assignmentId).toArray()
      const students = await db.students.where('classroomId').equals(assignment.classroomId).toArray()
      const classroom = await db.classrooms.get(assignment.classroomId)
      setData({
        questions: Array.isArray(ak?.questions) ? ak!.questions! : [],
        kpTips: ak?.kpTips && typeof ak.kpTips === 'object' ? ak.kpTips : {},
        // 與教師端同一組過濾:要有批改結果、且不是學生訂正卷
        submissions: subs.filter((s) => s.gradingResult && s.source !== 'student_correction'),
        students,
        subject: assignment.domain ?? '',
        title: assignment.title || examTitle,
        grade: (classroom as { grade?: number } | undefined)?.grade
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : '載入失敗')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [examTitle, onOpenClassChange])

  // 知識點歸類寫入 Dexie 後重載 questions(升級進階版時會用到)
  const reloadQuestions = useCallback(() => {
    if (!openClass) return
    void db.assignments.get(openClass.assignmentId).then((a) => {
      const ak = a?.answerKey as { questions?: ItemAnalysisQuestion[]; kpTips?: Record<string, string> } | undefined
      setData((prev) =>
        prev
          ? {
              ...prev,
              questions: Array.isArray(ak?.questions) ? ak!.questions! : [],
              kpTips: ak?.kpTips && typeof ak.kpTips === 'object' ? ak.kpTips : {}
            }
          : prev
      )
    })
  }, [openClass])

  if (openClass) {
    return (
      <div>
        {loading ? (
          <div className="flex min-h-[240px] items-center justify-center text-sm text-slate-400">
            正在準備批改資料…
          </div>
        ) : error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        ) : data && data.questions.length > 0 && data.submissions.length >= 3 ? (
          <ParentReportTab
            questions={data.questions}
            submissions={data.submissions}
            students={data.students}
            kpTips={data.kpTips}
            assignmentId={openClass.assignmentId}
            className={openClass.className}
            subject={data.subject}
            assignmentTitle={data.title}
            headerOverride={{
              schoolName: settings?.schoolName,
              crestDataUrl: settings?.crestDataUrl || undefined,
              teacherName: openClass.teacherName || undefined
            }}
            requestInk={(fn, message) => setInkAction({ fn, message })}
            onKpSaved={reloadQuestions}
            grade={data.grade}
          />
        ) : (
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-5 py-10 text-center text-sm text-slate-500">
            {data && data.submissions.length < 3
              ? `此班已批改的卷數不足 3 份(目前 ${data.submissions.length} 份),暫無法產生家長報告。`
              : '這份考卷沒有答案卷題目資料,無法產生家長報告。'}
          </div>
        )}

        <InkConfirmModal
          open={!!inkAction}
          warning="建立知識點歸類會消耗學校點數"
          onCancel={() => setInkAction(null)}
          onConfirm={() => { const fn = inkAction?.fn; setInkAction(null); fn?.() }}
        >
          {inkAction?.message ?? '即將為這份考卷建立知識點歸類。'}
        </InkConfirmModal>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-800">家長報告</h3>
          <p className="mt-1 max-w-2xl text-xs text-slate-500">
            一位學生一份:成績與班級落點、各題型答對率、知識點加強地圖、錯題整理(裁圖+讀到的答案+正解+班級狀況)。
            內容由系統即時計算、永遠對應最新批改結果;選一個班進去可逐位預覽、填寫老師的話,再單獨下載或整班打包。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5">
          {settings?.crestDataUrl ? (
            <img src={settings.crestDataUrl} alt="校徽" className="h-6 w-6 rounded bg-white object-contain" />
          ) : null}
          <div className="text-xs leading-tight">
            <div className="font-medium text-slate-600">{settings?.schoolName || '尚未設定校名'}</div>
            <button
              type="button"
              onClick={onOpenSettings}
              className="inline-flex items-center gap-1 text-slate-400 hover:text-sky-600 hover:underline"
            >
              <Settings className="h-3 w-3" />
              到偏好設定調整抬頭
            </button>
          </div>
        </div>
      </div>

      <div className="mt-3 divide-y divide-slate-100">
        {classes.map((c) => {
          const cnt = counts[c.assignmentId]
          const ready = !!cnt && cnt.graded >= 3
          return (
            <div key={c.assignmentId} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <span className="text-sm font-medium text-slate-800">{c.className}</span>
                <span className="ml-2 text-xs text-slate-400">
                  {cnt ? `已批改 ${cnt.graded}/${cnt.total} 份` : '載入中…'}
                </span>
                {c.teacherName && (
                  <span className="ml-2 text-xs text-slate-400">任課 {c.teacherName}</span>
                )}
                {cnt && !ready && (
                  <span className="ml-2 text-xs text-amber-600">不足 3 份、暫無法產生</span>
                )}
              </div>
              <button
                type="button"
                disabled={!ready}
                onClick={() => void open(c)}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sky-700 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                <FileText className="h-3.5 w-3.5" />
                開啟家長報告
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
