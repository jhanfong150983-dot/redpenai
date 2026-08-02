import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  RefreshCw,
  Users,
  ChevronRight,
  BookOpen,
  Layers,
  LayoutDashboard,
  TrendingUp,
  School,
  Droplet,
  Upload,
  Sparkles,
  FileText,
  BarChart3,
  Search,
  X
} from 'lucide-react'
import { useAlertModal, useConfirm } from '@/components/ConfirmModal'
import AssignmentFormModal, { type AssignmentFormData } from '@/components/AssignmentFormModal'
import DangerConfirmModal from '@/components/DangerConfirmModal'
import AnswerBank from '@/pages/AnswerBank'
import Gradebook from '@/pages/Gradebook'
import UnifiedImportPage from '@/pages/UnifiedImportPage'
// GradingPage 是最大的頁面 chunk——lazy 載入,只在行政按「AI 批改」時才抓
const LazyGradingPage = lazy(() => import('@/pages/GradingPage'))
import SyncIndicator from '@/components/SyncIndicator'
import { requestSync, waitForSync } from '@/lib/sync-events'
import { db } from '@/lib/db'
import { setSchoolBillingContext, SCHOOL_WALLET_EVENT } from '@/lib/school-billing'
import { gradeFromLabel, classNumFromLabel } from '@/lib/classroom-order'
import { downloadClassReviewSheetPdf } from '@/lib/reviewSheetPdf'

// 學校管理層（教務主任）檢視頁。
// 版面對齊教師端/學生端：頂部 logo bar + 左側功能選單(aside) + 右側內容(section)。
// 第一版功能：學生總覽 + 跨科檔案（弱點分析為後續）。
// 資料來自歸戶後的 school_person，經 /api/data/school-admin-overview 取得。

interface SchoolRow {
  school_id: string
  name: string
  student_count: number
  class_count: number
}
interface ClassRow {
  class_label: string
  grade: number | null
  student_count: number
  // 全校名冊(school_classes)來的班級才有;有它=點班級走 SSoT 名冊(全班在籍)
  campus_class_id?: string | null
  homeroom_teacher_name?: string | null
  homeroom_teacher_acc?: string | null
}
// 2026-08-03 任課關係(school_class_courses):一列=某班某科由某位老師任教。
//   source='1campus' 由全校名冊同步寫入、'admin' 是行政手動指派。
interface CourseRow {
  campus_class_id: string
  class_name: string | null
  subject: string | null
  course_name?: string | null
  teacher_acc: string | null
  teacher_name: string | null
  source: string
}
interface StudentRow {
  person_id: string
  name: string
  student_number: string | null
  seat_number: number | null
  // SSoT 名冊路徑為 null(個別學生的跨科檔案照常看得到)
  subject_count: number | null
}
interface RecordRow {
  subject: string | null
  class_name: string
  title: string | null
  domain: string | null
  score: number | null
  status: string | null
  graded_at: number | null
  submission_id: string
}
interface PersonInfo {
  id: string
  name: string
  student_number: string | null
  provider_student_id: string | null
  email: string | null
}

type SchoolTab = 'overview' | 'answerkeys' | 'exams' | 'grades' | 'teachers' | 'weakness'

const navItems: Array<{ key: SchoolTab; label: string; icon: typeof LayoutDashboard; enabled: boolean }> = [
  { key: 'overview', label: '學生總覽', icon: LayoutDashboard, enabled: true },
  // 建立答案=嵌入老師端答案卷整頁(只顯示學校答案卷;建立/擷取/分享碼匯入全套功能)
  { key: 'answerkeys', label: '建立答案', icon: BookOpen, enabled: true },
  { key: 'exams', label: '考卷批改', icon: BookOpen, enabled: true },
  // 2026-08-01 行政端成績統計(user 提議對齊教師端):共用 Gradebook、scope='school' 只看學校考卷班
  { key: 'grades', label: '成績統計', icon: BarChart3, enabled: true },
  { key: 'teachers', label: '教師總覽', icon: Users, enabled: true },
  { key: 'weakness', label: '弱點分析', icon: TrendingUp, enabled: false }
]

// Step 6(獨立模型):考卷母實體——行政端建考卷→逐班 fan-out,所有操作只在此頁
interface ExamClassRow {
  campusClassId: string
  classroomId: string
  assignmentId: string
  className: string
}
interface SchoolExamRow {
  id: string
  title: string
  status: string
  /** 2026-08-02 Step 11:科目=教師端唯讀判定依據;空字串=不開放檢視 */
  subject?: string
  /** 目前綁定的答案卷模板(編輯時顯示「目前答案卷」摘要用) */
  answerKeyTemplateId?: string
  createdAt: string
  classes: ExamClassRow[]
}
interface ExamTemplateOption {
  id: string
  name: string
  domain?: string
  folder?: string
  docType?: string
  answerSheetMode?: string
  questionCount: number
  totalScore: number
  pageOrientations?: ('portrait' | 'landscape')[]
}

const EXAM_STATUS_LABEL: Record<string, string> = {
  draft: '待匯入',
  importing: '匯入中',
  grading: '批改中',
  review: '檢討中',
  reports: '報告階段'
}

// 教師總覽(2026-07-30):全校教師名冊(getTeacher 全校抓)為主體;
// 帳號統一顯示 1Campus 帳號(tmail 只是新竹市的 google 帳號),綁定與否掛標籤。
interface TeacherOverviewRow {
  name: string
  account: string
  bound: boolean
  profileId: string | null
  loginEmail: string
  inkBalance: number | null
  classroomCount: number | null
  assignmentCount: number | null
}
interface WalletLedgerRow {
  delta: number
  balanceAfter: number | null
  reason: string
  actorName: string
  note: string
  createdAt: string
}

const LEDGER_REASON_LABEL: Record<string, string> = {
  admin_topup: '儲值',
  admin_adjustment: '調整',
  grading_job: '統一批改',
  school_grant: '配發老師',
  school_ai: 'AI 功能'
}

// Step 4b:學校統一批改 job(server-side 代批、扣學校點數)
interface GradingJobRow {
  id: string
  assignment_id: string
  assignment_title: string
  status: string
  total_count: number
  done_count: number
  failed_count: number
  ink_points: number
  last_error: string | null
  created_at: string
  updated_at: string
}

const JOB_STATUS_LABEL: Record<string, string> = {
  queued: '排隊中',
  running: '批改中',
  paused_insufficient: '點數不足暫停',
  completed: '已完成',
  completed_with_errors: '完成(部分失敗)',
  cancelled: '已取消'
}

async function fetchOverview(params: Record<string, string>): Promise<any> {
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`/api/data/school-admin-overview${qs ? `?${qs}` : ''}`, {
    credentials: 'include'
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data?.error || `讀取失敗（${res.status}）`)
  }
  return res.json()
}

function formatDate(ms: number | null): string {
  if (!ms) return '—'
  try {
    return new Date(ms).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' })
  } catch {
    return '—'
  }
}

function scoreColor(score: number | null): string {
  if (score == null) return 'text-gray-400'
  if (score >= 80) return 'text-emerald-600'
  if (score >= 60) return 'text-amber-600'
  return 'text-rose-600'
}

// 2026-08-01: 班級年級/班序解析已抽到 @/lib/classroom-order（成績簿等頁面共用、避免重複實作）
function effectiveGrade(c: ClassRow): number | null {
  return c.grade != null ? c.grade : gradeFromLabel(c.class_label)
}

// 2026-07-30 Step 4(user 拍板):學校層級共用錢包(schools.ink_balance)——
// 同校所有行政看到同一個餘額、統一批改扣學校池。學校端只讀:儲值一律由系統 admin
// 在管理者面板「學校錢包」操作(簽約/付款後入點);行政可做的是「配發」給該校老師。
export default function SchoolAdminPanel({
  onBack,
  preferredSchoolId
}: {
  onBack: () => void
  preferredSchoolId?: string
}) {
  const alertModal = useAlertModal()
  const confirmModal = useConfirm()
  const [walletBalance, setWalletBalance] = useState<number | null>(null)
  const [teachers, setTeachers] = useState<TeacherOverviewRow[]>([])
  const [teacherSource, setTeacherSource] = useState<'roster' | 'fallback' | null>(null)
  const [walletLedger, setWalletLedger] = useState<WalletLedgerRow[]>([])
  const [teachersLoading, setTeachersLoading] = useState(false)
  // 全校任課(班級總覽顯示「導師/任課 N 科」、教師清單顯示「任教 N 班 M 科」都吃這份)
  const [courses, setCourses] = useState<CourseRow[]>([])
  // 教師搜尋:全校上百位老師,靠捲動找人不切實際。比對範圍含任教班級/科目,
  //   讓「五年3班的英語老師是誰」這種問法也搜得到。
  const [teacherQuery, setTeacherQuery] = useState('')
  // 2026-08-02(user:讓非 1Campus / 自建班級也能用)行政手動指派任課。
  //   任課關係存在 school_class_courses,1Campus 只是其中一種填表來源;手動列 source='admin'。
  const [assignTeacher, setAssignTeacher] = useState<TeacherOverviewRow | null>(null)
  const [assignSubject, setAssignSubject] = useState('')
  const [assignClassIds, setAssignClassIds] = useState<Set<string>>(new Set())
  const [assignExisting, setAssignExisting] = useState<Array<{ campus_class_id: string; class_name: string | null; subject: string | null; source: string }>>([])
  const [assignSaving, setAssignSaving] = useState(false)
  const [grantTarget, setGrantTarget] = useState<TeacherOverviewRow | null>(null)
  const [grantValue, setGrantValue] = useState('')
  const [grantBusy, setGrantBusy] = useState(false)
  const [jobs, setJobs] = useState<GradingJobRow[]>([])
  const [drivingJobId, setDrivingJobId] = useState<string | null>(null)
  const [exams, setExams] = useState<SchoolExamRow[]>([])
  const [examsLoading, setExamsLoading] = useState(false)
  const [examTemplates, setExamTemplates] = useState<ExamTemplateOption[]>([])
  const [createExamOpen, setCreateExamOpen] = useState(false)
  const [pickedClassIds, setPickedClassIds] = useState<Set<string>>(new Set())
  // 2026-08-02 Step 11 階段2:考卷科目(決定哪些老師能唯讀)。清單來自 1Campus 同步的任課資料。
  const [subjects, setSubjects] = useState<Array<{ subject: string; classCount: number; teacherCount: number; campusClassIds: string[] }>>([])
  const [pickedSubject, setPickedSubject] = useState('')
  // 2026-08-02(user 指出建完就改不了):考卷編輯——只動名稱/科目這類 metadata,
  //   不碰答案卷、批改設定、班級(那些牽涉重批語意,另案處理)。
  const [editExam, setEditExam] = useState<SchoolExamRow | null>(null)
  const [editSubject, setEditSubject] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  // 編輯時的班級勾選(預設=考卷現有班級)、已批改份數(換答案卷警告用)
  const [editClassIds, setEditClassIds] = useState<Set<string>>(new Set())
  const [editGradedCount, setEditGradedCount] = useState(0)
  // 換答案卷的核彈級確認(比照教師端 DangerConfirmModal severity=high)
  const [changeAkConfirm, setChangeAkConfirm] = useState<{ data: AssignmentFormData } | null>(null)
  const [creatingExam, setCreatingExam] = useState(false)
  const [expandedExamId, setExpandedExamId] = useState<string | null>(null)
  // Step 7:匯入考卷(班級 tabs+教師端 PDF 匯入整套重用;開啟前先 sync pull 確保 Dexie 有考卷資料)
  const [importExam, setImportExam] = useState<SchoolExamRow | null>(null)
  const [importClassIdx, setImportClassIdx] = useState(0)
  const [importSyncing, setImportSyncing] = useState(false)
  // Step 8:AI 批改=嵌入教師端 GradingPage 跨班批次模式(batchAssignmentIds=全部班級,
  // 一顆智慧批改按鈕批全部;黃燈/改分原生可用;計費走學校錢包 header)
  const [gradeExam, setGradeExam] = useState<SchoolExamRow | null>(null)
  const [gradeSyncing, setGradeSyncing] = useState(false)
  // Step 9:報告生成(第一層=學生檢討單 PDF;家長報告之後)
  const [reportExam, setReportExam] = useState<SchoolExamRow | null>(null)
  const [reportSyncing, setReportSyncing] = useState(false)
  const [reportCounts, setReportCounts] = useState<Record<string, { graded: number; total: number }>>({})
  const [reportBusy, setReportBusy] = useState<string | null>(null)
  const [reportProg, setReportProg] = useState<{ phase: string; done: number; total: number } | null>(null)
  const [reportMsg, setReportMsg] = useState<Record<string, string>>({})
  const [tab, setTab] = useState<SchoolTab>('overview')
  const [rosterSyncing, setRosterSyncing] = useState(false)
  // 首次使用自動準備:空校(從未同步)且有歸屬校 → 自動跑一次全校名冊同步,行政零操作
  const [autoSyncPending, setAutoSyncPending] = useState(false)
  const autoSyncTriedRef = useRef(false)
  const [school, setSchool] = useState<SchoolRow | null>(null)
  // 2026-07-30:系統 admin 看得到所有學校——保留清單供切換;預設選「自己行政歸屬」的學校
  const [schoolList, setSchoolList] = useState<SchoolRow[]>([])
  const [classes, setClasses] = useState<ClassRow[]>([])
  const [selectedClass, setSelectedClass] = useState<string | null>(null)
  const [students, setStudents] = useState<StudentRow[]>([])
  const [person, setPerson] = useState<PersonInfo | null>(null)
  const [records, setRecords] = useState<RecordRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [gradeFilter, setGradeFilter] = useState<number | 'all'>('all')

  const loadWallet = useCallback(async (sid: string) => {
    try {
      const res = await fetch(`/api/data/school-wallet?schoolId=${encodeURIComponent(sid)}`, {
        credentials: 'include'
      })
      const data = await res.json()
      if (res.ok && typeof data.balance === 'number') setWalletBalance(data.balance)
      else setWalletBalance(null)
    } catch {
      setWalletBalance(null)
    }
  }, [])

  const loadCourses = useCallback(async (sid: string) => {
    try {
      const res = await fetch(`/api/data/school-teacher-courses?schoolId=${encodeURIComponent(sid)}`, {
        credentials: 'include'
      })
      if (!res.ok) return
      const data = await res.json()
      setCourses(Array.isArray(data?.courses) ? data.courses : [])
    } catch { /* 非致命:只是看不到任課摘要 */ }
  }, [])

  const loadSchool = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { schools } = await fetchOverview({})
      const list: SchoolRow[] = Array.isArray(schools) ? schools : []
      setSchoolList(list)
      // 2026-07-30 user 回報:admin 帳號預設選到清單第一所(展示學校)看見莫名班級——
      //   改為優先選自己 school_admins 歸屬的學校,找不到才退回第一所
      const first: SchoolRow | undefined =
        (preferredSchoolId ? list.find((s) => s.school_id === preferredSchoolId) : undefined) ?? list[0]
      if (!first) {
        // 首次使用(2026-07-30 user 拍板):有歸屬校但還沒有資料 → 自動開始準備,不用按任何按鈕
        if (preferredSchoolId && !autoSyncTriedRef.current) {
          autoSyncTriedRef.current = true
          setAutoSyncPending(true)
          setLoading(false)
          return
        }
        // 自動準備也拿不到資料時的退路文案
        setError(
          '尚未取得貴校的 1Campus 資料。請按右上方「全校名冊同步」再試一次;若仍無資料,請確認貴校已完成 1Campus 平台授權,或聯繫 RedPen AI 協助開通。'
        )
        setLoading(false)
        return
      }
      setSchool(first)
      void loadWallet(first.school_id)
      void loadCourses(first.school_id)
      const { classes: cls } = await fetchOverview({ schoolId: first.school_id })
      setClasses(Array.isArray(cls) ? cls : [])
    } catch (err) {
      setError(err instanceof Error ? err.message : '讀取失敗')
    } finally {
      setLoading(false)
    }
  }, [preferredSchoolId, loadWallet, loadCourses])

  useEffect(() => {
    void loadSchool()
  }, [loadSchool])

  // 學校計費 context:在學校檢視期間,所有 AI 呼叫(含嵌入的答案卷擷取)改扣學校錢包
  useEffect(() => {
    setSchoolBillingContext(school?.school_id ?? preferredSchoolId ?? null)
    return () => setSchoolBillingContext(null)
  }, [school, preferredSchoolId])

  // 即時餘額:每筆學校計費回應廣播 balanceAfter → header 點數批改當下逐卷跳動
  useEffect(() => {
    const onBalance = (e: Event) => {
      const balance = (e as CustomEvent<{ balance: number }>).detail?.balance
      if (typeof balance === 'number' && Number.isFinite(balance)) setWalletBalance(balance)
    }
    window.addEventListener(SCHOOL_WALLET_EVENT, onBalance)
    return () => window.removeEventListener(SCHOOL_WALLET_EVENT, onBalance)
  }, [])

  // 切換學校(多校時的下拉;單校不顯示)
  const switchSchool = useCallback(async (sid: string) => {
    const target = schoolList.find((s) => s.school_id === sid)
    if (!target || target.school_id === school?.school_id) return
    setLoading(true)
    setError(null)
    setSchool(target)
    setSelectedClass(null)
    setStudents([])
    setPerson(null)
    setRecords([])
    setGradeFilter('all')
    void loadWallet(target.school_id)
    try {
      const { classes: cls } = await fetchOverview({ schoolId: target.school_id })
      setClasses(Array.isArray(cls) ? cls : [])
    } catch (err) {
      setError(err instanceof Error ? err.message : '讀取失敗')
    } finally {
      setLoading(false)
    }
  }, [schoolList, school, loadWallet])

  // 2026-07-30 Step 3.5:全校名冊同步(getClassStudent 全校→歸戶 SSoT+班級參考表+轉出標記)。
  // 空校時 school 尚為 null → 退回行政自己的歸屬校 preferredSchoolId,讓第一次拉取也能按。
  const runRosterSync = useCallback(async () => {
    const targetSchoolId = school?.school_id ?? preferredSchoolId
    if (!targetSchoolId || rosterSyncing) return
    setRosterSyncing(true)
    try {
      const res = await fetch('/api/data/school-roster-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ schoolId: targetSchoolId })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || '同步失敗')
      const unresolved = (data.missingChecked ?? 0) - (data.departedMarked ?? 0)
      await alertModal(
        `班級:${data.classes} 個\n在籍學生:${data.studentsSeen} 人(新增歸戶 ${data.newPersons} 人、復學 ${data.reactivated} 人)\n教師名冊:${data.teacherCount ?? 0} 位\n轉出/離校標記:${data.departedMarked} 人${
          unresolved > 0 ? `(另 ${unresolved} 人不在名冊但查無離校紀錄,維持原狀)` : ''
        }\n家長綁定:${
          data.parentFieldPresent ? `${data.parentBound} / ${data.studentsSeen} 人` : '此授權未回傳家長綁定資料'
        }\n任課對應:${data.courseCount ?? 0} 筆(班級×課程×老師)、導師 ${data.homeroomCount ?? 0} 班${
          (data.courseCount ?? 0) === 0 ? '(未取得課程資料,教師端唯讀將無法判定任課)' : ''
        }${
          data.mirror
            ? `\n考卷班級:${data.mirror.classes} 個已就緒(供建立考卷/匯入/批改使用)`
            : ''
        }`,
        { title: `全校名冊同步完成${data.schoolName ? ` · ${data.schoolName}` : ''}` }
      )
      await loadSchool()
    } catch (err) {
      await alertModal(err instanceof Error ? err.message : '同步失敗', { title: '全校名冊同步失敗' })
    } finally {
      setRosterSyncing(false)
    }
  }, [school, preferredSchoolId, rosterSyncing, alertModal, loadSchool])

  // 教師總覽:老師清單+學校點數紀錄(進 tab 或換校時載入)
  const loadTeachers = useCallback(async (sid: string) => {
    setTeachersLoading(true)
    try {
      const [tRes, wRes] = await Promise.all([
        fetch(`/api/data/school-teacher-overview?schoolId=${encodeURIComponent(sid)}`, { credentials: 'include' }),
        fetch(`/api/data/school-wallet?schoolId=${encodeURIComponent(sid)}&ledger=1`, { credentials: 'include' })
      ])
      const tData = await tRes.json()
      if (tRes.ok) {
        setTeachers(Array.isArray(tData.teachers) ? tData.teachers : [])
        setTeacherSource(tData.source === 'roster' ? 'roster' : 'fallback')
      }
      const wData = await wRes.json()
      if (wRes.ok) {
        if (typeof wData.balance === 'number') setWalletBalance(wData.balance)
        setWalletLedger(Array.isArray(wData.ledger) ? wData.ledger : [])
      }
    } catch {
      // 進不了就顯示空表,錯誤已在主要流程呈現
    } finally {
      setTeachersLoading(false)
    }
  }, [])

  const refreshJobs = useCallback(async (sid: string) => {
    try {
      const res = await fetch(`/api/data/school-grading-job?schoolId=${encodeURIComponent(sid)}`, {
        credentials: 'include'
      })
      const data = await res.json()
      if (res.ok) setJobs(Array.isArray(data.jobs) ? data.jobs : [])
    } catch {
      // 靜默:工作清單載入失敗不擋教師總覽
    }
  }, [])

  useEffect(() => {
    if (tab === 'teachers' && school) {
      void loadTeachers(school.school_id)
      void refreshJobs(school.school_id)
    }
  }, [tab, school, loadTeachers, refreshJobs])

  // 首次使用自動準備(loadSchool 偵測空校時觸發;拆成 effect 避免 callback 循環依賴)
  useEffect(() => {
    if (autoSyncPending && !rosterSyncing) {
      setAutoSyncPending(false)
      void runRosterSync()
    }
  }, [autoSyncPending, rosterSyncing, runRosterSync])

  // 考卷批改 tab:載入考卷列表+答案卷選單
  const loadExams = useCallback(async (sid: string) => {
    setExamsLoading(true)
    try {
      const [eRes, tRes] = await Promise.all([
        fetch(`/api/data/school-exams?schoolId=${encodeURIComponent(sid)}`, { credentials: 'include' }),
        fetch(`/api/data/school-exams?schoolId=${encodeURIComponent(sid)}&templates=1`, { credentials: 'include' })
      ])
      const eData = await eRes.json()
      if (eRes.ok) setExams(Array.isArray(eData.exams) ? eData.exams : [])
      const tData = await tRes.json()
      if (tRes.ok) setExamTemplates(Array.isArray(tData.templates) ? tData.templates : [])
    } catch {
      // 靜默,操作時再報錯
    } finally {
      setExamsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (tab === 'exams' && school) {
      void loadExams(school.school_id)
      // 進考卷 tab 順便刷新學校點數(批改後回列表要看到最新餘額)
      void loadWallet(school.school_id)
      // 科目清單(建考卷選科目用;失敗不擋流程、只是選不到科目)
      void (async () => {
        try {
          const r = await fetch(`/api/data/school-subjects?schoolId=${encodeURIComponent(school.school_id)}`, { credentials: 'include' })
          if (!r.ok) return
          const d = await r.json()
          if (Array.isArray(d?.subjects)) setSubjects(d.subjects)
        } catch { /* 非致命 */ }
      })()
    }
  }, [tab, school, loadExams, loadWallet])

  // 切換主選單時退出匯入/批改頁(避免回到考卷批改時還停在舊畫面)
  useEffect(() => {
    if (tab !== 'exams') {
      setImportExam(null)
      setGradeExam(null)
      setReportExam(null)
    }
  }, [tab])

  // 開啟前確保本機資料庫已有考卷資料——已在本機就直接進(背景照樣同步)、
  // 沒有才顯示「正在準備考卷資料…」等首次 pull(行政端在主 shell 外、同步不常駐的補償)
  const ensureExamLocal = useCallback(async (ex: SchoolExamRow, setSyncing: (b: boolean) => void) => {
    requestSync(true)
    try {
      const ids = ex.classes.map((c) => c.assignmentId)
      const found = await db.assignments.where('id').anyOf(ids).count()
      if (found >= ids.length) {
        setSyncing(false)
        return
      }
    } catch { /* 查不到就照常等同步 */ }
    waitForSync(45000)
      .catch(() => {})
      .finally(() => setSyncing(false))
  }, [])

  const openGradeExam = useCallback((ex: SchoolExamRow) => {
    setGradeExam(ex)
    setGradeSyncing(true)
    void ensureExamLocal(ex, setGradeSyncing)
  }, [ensureExamLocal])

  // 2026-08-01 修「批改中偶爾整頁閃 2 秒」:傳給 GradingPage 的 batchAssignmentIds 之前是
  // render 內 .map() 現做陣列 → 錢包餘額事件(批改扣點就觸發)re-render 本面板 → prop identity
  // 變 → GradingPage 的 loadData/syncAndReload effect 連鎖重跑 → setIsLoading(true) 整頁重載。
  // memo 綁 gradeExam:批改期間 identity 恆定。
  const gradeBatchIds = useMemo(
    () => (gradeExam ? gradeExam.classes.map((c) => c.assignmentId) : []),
    [gradeExam]
  )

  // 建立考卷:modal 第四步送出(成功=卡片直接出現,不另彈成功視窗——user 拍板)
  // 真正送出(doChangeAk=true 代表已通過換答案卷的危險確認)
  const commitExamEdit = useCallback(async (data: AssignmentFormData, doChangeAk: boolean) => {
    if (!editExam || !school) return
    setEditSaving(true)
    try {
      // (a) 名稱/科目/答案卷/批改設定
      const res = await fetch('/api/data/school-exams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          mode: 'update',
          schoolId: school.school_id,
          examId: editExam.id,
          title: data.title.trim(),
          subject: editSubject,
          templateId: doChangeAk ? data.selectedAnswerKeyId : undefined,
          settings: data.settings
        })
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d?.error || '更新失敗')

      // (b) 班級增減(與現有班級比對出差集才送)
      const cur = new Set(editExam.classes.map((c) => String(c.campusClassId)))
      const addIds = [...editClassIds].filter((id) => !cur.has(id))
      const removeIds = [...cur].filter((id) => !editClassIds.has(id))
      if (addIds.length > 0 || removeIds.length > 0) {
        const doClasses = async (force: boolean) => {
          const r = await fetch('/api/data/school-exams', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              mode: 'classes',
              schoolId: school.school_id,
              examId: editExam.id,
              addCampusClassIds: addIds,
              removeCampusClassIds: removeIds,
              force
            })
          })
          return { r, j: await r.json() }
        }
        let { r, j } = await doClasses(false)
        if (r.status === 409 && j?.error === 'graded_exists') {
          const ok = await confirmModal({
            tone: 'danger',
            title: '移除的班級已有批改成績',
            message: `${(j.classNames || []).join('、')} 共 ${j.gradedCount} 份卷已完成批改,移除後成績一併消失且無法復原。確定仍要移除?`,
            confirmLabel: '仍要移除'
          })
          if (!ok) { setEditExam(null); await loadExams(school.school_id); return }
          ;({ r, j } = await doClasses(true))
        }
        if (!r.ok) throw new Error(j?.error || '調整班級失敗')
      }

      setEditExam(null)
      await loadExams(school.school_id)
      if (d?.clearedStudents > 0) {
        await alertModal(`答案卷已更換,${d.clearedStudents} 位學生的批改結果已清除,請重新批改。`, { title: '已更換答案卷' })
      } else if (!doChangeAk && data.settings?.strictness && editGradedCount > 0) {
        // 比照教師端:只改設定不清批改,但要提示需重批才套用
        await alertModal('批改設定已變更:已批改的卷子需重新批改後才會套用新設定。')
      }
    } catch (err) {
      await alertModal(err instanceof Error ? err.message : '更新失敗', { title: '更新考卷失敗' })
    } finally {
      setEditSaving(false)
    }
  }, [editExam, editSubject, editClassIds, editGradedCount, school, confirmModal, alertModal, loadExams])

  const submitExamEdit = useCallback(async (data: AssignmentFormData) => {
    // 有選新答案卷 → 先跳核彈級確認(比照教師端:換卷=全部重來)
    if (data.selectedAnswerKeyId) {
      setChangeAkConfirm({ data })
      return
    }
    await commitExamEdit(data, false)
  }, [commitExamEdit])

  const deleteExam = useCallback(async (ex: SchoolExamRow, force = false) => {
    if (!school) return
    if (!force) {
      const ok = await confirmModal({
        tone: 'danger',
        title: `刪除考卷「${ex.title}」?`,
        message: `將一併移除 ${ex.classes.length} 個班級的作業與已匯入的卷。此動作無法復原。`,
        confirmLabel: '刪除考卷'
      })
      if (!ok) return
    }
    setEditSaving(true)
    try {
      const res = await fetch('/api/data/school-exams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ mode: 'delete', schoolId: school.school_id, examId: ex.id, force })
      })
      const d = await res.json()
      // 有已批改成績 → server 擋下來、再問一次
      if (res.status === 409 && d?.error === 'graded_exists') {
        const ok2 = await confirmModal({
          tone: 'danger',
          title: '這份考卷已有批改成績',
          message: `已有 ${d.gradedCount} 份卷完成批改,刪除後成績一併消失且無法復原。確定仍要刪除?`,
          confirmLabel: '仍要刪除'
        })
        if (ok2) await deleteExamForce(ex)
        return
      }
      if (!res.ok) throw new Error(d?.error || '刪除失敗')
      setEditExam(null)
      await loadExams(school.school_id)
    } catch (err) {
      await alertModal(err instanceof Error ? err.message : '刪除失敗', { title: '刪除考卷失敗' })
    } finally {
      setEditSaving(false)
    }
  }, [school, confirmModal, alertModal, loadExams])

  const deleteExamForce = useCallback(async (ex: SchoolExamRow) => {
    if (!school) return
    const res = await fetch('/api/data/school-exams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ mode: 'delete', schoolId: school.school_id, examId: ex.id, force: true })
    })
    const d = await res.json()
    if (!res.ok) { await alertModal(d?.error || '刪除失敗', { title: '刪除考卷失敗' }); return }
    setEditExam(null)
    await loadExams(school.school_id)
  }, [school, alertModal, loadExams])

  const openAssign = useCallback(async (t: TeacherOverviewRow) => {
    if (!school) return
    setAssignTeacher(t)
    // 科目清單原本只在考卷分頁載入;教師總覽開指派時若還沒有就補抓
    if (subjects.length === 0) {
      try {
        const r0 = await fetch(`/api/data/school-subjects?schoolId=${encodeURIComponent(school.school_id)}`, { credentials: 'include' })
        if (r0.ok) {
          const d0 = await r0.json()
          if (Array.isArray(d0?.subjects)) setSubjects(d0.subjects)
        }
      } catch { /* 非致命 */ }
    }
    setAssignSubject('')
    setAssignClassIds(new Set())
    setAssignExisting([])
    try {
      const r = await fetch(
        `/api/data/school-teacher-courses?schoolId=${encodeURIComponent(school.school_id)}&teacherAcc=${encodeURIComponent(t.account)}`,
        { credentials: 'include' }
      )
      if (r.ok) {
        const d = await r.json()
        setAssignExisting(Array.isArray(d?.courses) ? d.courses : [])
      }
    } catch { /* 非致命:只是看不到既有任課 */ }
  }, [school, subjects.length])

  const saveAssign = useCallback(async () => {
    if (!school || !assignTeacher || assignSaving) return
    if (!assignSubject) { await alertModal('請先選科目', { title: '無法指派' }); return }
    if (assignClassIds.size === 0) { await alertModal('請至少勾選一個班級', { title: '無法指派' }); return }
    setAssignSaving(true)
    try {
      const res = await fetch('/api/data/school-teacher-courses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          mode: 'assign',
          schoolId: school.school_id,
          teacherAcc: assignTeacher.account,
          teacherName: assignTeacher.name,
          subject: assignSubject,
          campusClassIds: [...assignClassIds]
        })
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d?.error || '指派失敗')
      void loadCourses(school.school_id)
      await alertModal(`已指派 ${assignTeacher.name || assignTeacher.account} 任教 ${assignClassIds.size} 個班級的「${assignSubject}」。`, { title: '指派完成' })
      setAssignTeacher(null)
    } catch (err) {
      await alertModal(err instanceof Error ? err.message : '指派失敗', { title: '指派失敗' })
    } finally {
      setAssignSaving(false)
    }
  }, [school, assignTeacher, assignSubject, assignClassIds, assignSaving, alertModal, loadCourses])

  const removeAssign = useCallback(async (cid: string, subject: string) => {
    if (!school || !assignTeacher) return
    const ok = await confirmModal({
      tone: 'danger',
      title: '取消這筆任課指派?',
      message: '取消後,這位老師將看不到該班此科目的考卷成績。',
      confirmLabel: '取消指派'
    })
    if (!ok) return
    try {
      const res = await fetch('/api/data/school-teacher-courses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          mode: 'unassign',
          schoolId: school.school_id,
          teacherAcc: assignTeacher.account,
          subject,
          campusClassIds: [cid]
        })
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d?.error || '取消失敗')
      setAssignExisting((prev) => prev.filter((x) => !(String(x.campus_class_id) === cid && x.subject === subject && x.source === 'admin')))
      void loadCourses(school.school_id)
    } catch (err) {
      await alertModal(err instanceof Error ? err.message : '取消失敗', { title: '取消指派失敗' })
    }
  }, [school, assignTeacher, confirmModal, alertModal, loadCourses])

  const submitCreateExam = useCallback(
    async (data: AssignmentFormData) => {
      if (!school || pickedClassIds.size === 0) return
      setCreatingExam(true)
      try {
        const res = await fetch('/api/data/school-exams', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            mode: 'create',
            schoolId: school.school_id,
            title: data.title.trim(),
            templateId: data.selectedAnswerKeyId,
            campusClassIds: [...pickedClassIds],
            settings: data.settings,
            subject: pickedSubject || undefined
          })
        })
        const resData = await res.json()
        if (!res.ok) throw new Error(resData?.error || '建立考卷失敗')
        setCreateExamOpen(false)
        setPickedClassIds(new Set())
        setPickedSubject('')
        await loadExams(school.school_id)
      } catch (err) {
        await alertModal(err instanceof Error ? err.message : '建立考卷失敗', { title: '建立考卷失敗' })
      } finally {
        setCreatingExam(false)
      }
    },
    [school, pickedClassIds, alertModal, loadExams]
  )

  // 代批:tick 驅動迴圈——每輪最多 ~3 分鐘(server 逐卷批),回 hasMore 就續打;
  // 關掉頁面 job 會停在 running、lease 過期後可按「繼續」接手(cron 兜底後續補)
  const driveJob = useCallback(
    async (jobId: string) => {
      if (!school) return
      setDrivingJobId(jobId)
      try {
        for (let round = 0; round < 200; round++) {
          const res = await fetch('/api/data/school-grading-job', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ mode: 'tick', jobId })
          })
          const data = await res.json().catch(() => ({}))
          await refreshJobs(school.school_id)
          void loadWallet(school.school_id)
          if (!res.ok || !data?.hasMore) break
        }
      } finally {
        setDrivingJobId(null)
      }
    },
    [school, refreshJobs, loadWallet]
  )

  const cancelJob = useCallback(
    async (job: GradingJobRow) => {
      if (!school) return
      if (
        !(await confirmModal({
          title: '取消代批工作',
          message: `確定取消「${job.assignment_title || job.assignment_id}」的代批?\n已批完的 ${job.done_count} 卷保留,尚未批的不再處理。`,
          tone: 'danger',
          confirmLabel: '取消工作'
        }))
      )
        return
      await fetch('/api/data/school-grading-job', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ mode: 'cancel', jobId: job.id })
      }).catch(() => {})
      await refreshJobs(school.school_id)
    },
    [school, refreshJobs]
  )

  // 配發:學校池 → 老師個人帳戶(行政與系統 admin 都可操作)
  const submitGrant = useCallback(async () => {
    const sid = school?.school_id
    const amount = parseInt(grantValue, 10)
    if (!sid || !grantTarget?.profileId || !Number.isFinite(amount) || amount <= 0) return
    setGrantBusy(true)
    try {
      const res = await fetch('/api/data/school-grant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ schoolId: sid, teacherProfileId: grantTarget.profileId, amount })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || '配發失敗')
      setGrantTarget(null)
      await alertModal(`已配發 ${amount} 點給 ${data.teacherName || grantTarget.name},學校點數剩 ${data.balance} 點。`)
      await loadTeachers(sid)
    } catch (err) {
      await alertModal(err instanceof Error ? err.message : '配發失敗', { title: '配發失敗' })
    } finally {
      setGrantBusy(false)
    }
  }, [school, grantTarget, grantValue, alertModal, loadTeachers])

  const openClass = useCallback(
    async (label: string, classId?: string | null) => {
      if (!school) return
      setLoading(true)
      setError(null)
      setSelectedClass(label)
      setPerson(null)
      setRecords([])
      try {
        const params: Record<string, string> = classId
          ? { schoolId: school.school_id, classId }
          : { schoolId: school.school_id, classLabel: label }
        const { students: stu } = await fetchOverview(params)
        setStudents(Array.isArray(stu) ? stu : [])
      } catch (err) {
        setError(err instanceof Error ? err.message : '讀取失敗')
      } finally {
        setLoading(false)
      }
    },
    [school]
  )

  const openPerson = useCallback(async (personId: string) => {
    setLoading(true)
    setError(null)
    try {
      const { person: p, records: recs } = await fetchOverview({ personId })
      setPerson(p)
      setRecords(Array.isArray(recs) ? recs : [])
    } catch (err) {
      setError(err instanceof Error ? err.message : '讀取失敗')
    } finally {
      setLoading(false)
    }
  }, [])

  const recordsBySubject = useMemo(() => {
    const map = new Map<string, RecordRow[]>()
    for (const r of records) {
      const key = r.subject || r.domain || '其他'
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(r)
    }
    return Array.from(map.entries()).map(([subject, rows]) => {
      const scored = rows.filter((r) => typeof r.score === 'number')
      const avg = scored.length
        ? Math.round((scored.reduce((s, r) => s + (r.score || 0), 0) / scored.length) * 10) / 10
        : null
      return { subject, rows, avg, count: rows.length }
    })
  }, [records])

  // 依年級分組、組內依班序自然排序；grade 缺時用班名推算（消除「其他」）
  const gradeGroups = useMemo(() => {
    const map = new Map<number | null, ClassRow[]>()
    for (const c of classes) {
      const g = effectiveGrade(c)
      if (!map.has(g)) map.set(g, [])
      map.get(g)!.push(c)
    }
    const entries = Array.from(map.entries()).map(([grade, list]) => ({
      grade,
      label: grade != null ? `${grade} 年級` : '其他',
      classes: [...list].sort((a, b) => classNumFromLabel(a.class_label) - classNumFromLabel(b.class_label))
    }))
    entries.sort((a, b) => {
      if (a.grade == null) return 1
      if (b.grade == null) return -1
      return a.grade - b.grade
    })
    return entries
  }, [classes])

  // 任課索引:班級 → 該班所有科目、老師 → 任教幾班幾科。
  //   同一班同一科可能有多筆(協同教學),以 subject 為單位去重才算得出「幾科」。
  const coursesByClass = useMemo(() => {
    const map = new Map<string, CourseRow[]>()
    for (const c of courses) {
      const cid = String(c.campus_class_id || '')
      if (!cid) continue
      if (!map.has(cid)) map.set(cid, [])
      map.get(cid)!.push(c)
    }
    for (const list of map.values()) {
      list.sort((a, b) => String(a.subject || '').localeCompare(String(b.subject || ''), 'zh-Hant'))
    }
    return map
  }, [courses])

  const teachingByTeacher = useMemo(() => {
    const map = new Map<string, { classes: Set<string>; subjects: Set<string> }>()
    for (const c of courses) {
      const acc = String(c.teacher_acc || '')
      if (!acc) continue
      if (!map.has(acc)) map.set(acc, { classes: new Set(), subjects: new Set() })
      const e = map.get(acc)!
      if (c.campus_class_id) e.classes.add(String(c.campus_class_id))
      if (c.subject) e.subjects.add(String(c.subject))
    }
    return map
  }, [courses])

  // 每位老師一段可搜尋文字:姓名/帳號/登入信箱 + 任教班級與科目 + 帶哪一班的導師。
  //   關鍵字用空白拆開後全部都要命中(「五年3 英語」找得到五年3班的英語老師)。
  const teacherSearchIndex = useMemo(() => {
    const map = new Map<string, string>()
    const push = (acc: string, text: string) => {
      if (!acc || !text) return
      map.set(acc, `${map.get(acc) ?? ''} ${text}`)
    }
    for (const c of courses) {
      push(String(c.teacher_acc || ''), `${c.class_name || ''} ${c.subject || ''} ${c.course_name || ''}`)
    }
    for (const c of classes) {
      if (c.homeroom_teacher_acc) push(String(c.homeroom_teacher_acc), `${c.class_label} 導師`)
    }
    return map
  }, [courses, classes])

  const filteredTeachers = useMemo(() => {
    const terms = teacherQuery.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length === 0) return teachers
    return teachers.filter((t) => {
      const acc = String(t.account || '')
      const blob = `${t.name || ''} ${acc} ${t.loginEmail || ''} ${teacherSearchIndex.get(acc) ?? ''}`.toLowerCase()
      return terms.every((term) => blob.includes(term))
    })
  }, [teachers, teacherQuery, teacherSearchIndex])

  const presentGrades = useMemo(
    () => gradeGroups.filter((g) => g.grade != null).map((g) => g.grade as number),
    [gradeGroups]
  )

  const backToClasses = () => {
    setSelectedClass(null)
    setPerson(null)
    setStudents([])
  }
  const backToStudents = () => {
    setPerson(null)
    setRecords([])
  }

  const openImportExam = useCallback((ex: SchoolExamRow) => {
    setImportExam(ex)
    setImportClassIdx(0)
    setImportSyncing(true)
    void ensureExamLocal(ex, setImportSyncing)
  }, [ensureExamLocal])

  // Step 9:報告生成入口(同 import/grade:先確保本機有資料)
  const openReportExam = useCallback((ex: SchoolExamRow) => {
    setReportExam(ex)
    setReportMsg({})
    setReportCounts({})
    setReportSyncing(true)
    void ensureExamLocal(ex, setReportSyncing)
  }, [ensureExamLocal])

  // 檢討單頁:同步完載每班已批改數(產生按鈕的 enable 依據)
  useEffect(() => {
    if (!reportExam || reportSyncing) return
    let cancelled = false
    ;(async () => {
      const out: Record<string, { graded: number; total: number }> = {}
      for (const c of reportExam.classes) {
        const subs = await db.submissions.where('assignmentId').equals(c.assignmentId).toArray()
        out[c.assignmentId] = { graded: subs.filter((s) => s.status === 'graded' && s.gradingResult).length, total: subs.length }
      }
      if (!cancelled) setReportCounts(out)
    })()
    return () => { cancelled = true }
  }, [reportExam, reportSyncing])

  const generateReviewSheet = useCallback(async (assignmentId: string) => {
    setReportBusy(assignmentId)
    setReportProg(null)
    try {
      const r = await downloadClassReviewSheetPdf(assignmentId, {
        onProgress: (phase, done, total) => setReportProg({ phase, done, total }),
      })
      setReportMsg((m) => ({
        ...m,
        [assignmentId]: r.failed > 0 ? `完成 ${r.students} 份(${r.failed} 份失敗,可再按一次重產)` : `已下載(${r.students} 份)`,
      }))
    } catch (e) {
      setReportMsg((m) => ({ ...m, [assignmentId]: e instanceof Error ? e.message : '產生失敗,請重試' }))
    } finally {
      setReportBusy(null)
      setReportProg(null)
    }
  }, [])

  // 建卷 modal 第四步的班級選擇內容(年級分組 chips;狀態在本元件)
  // 編輯考卷的初始值:設定從既有 answerKey 讀回(教師端 openSettingsModal 同款作法)
  const editExamSettings = useMemo(() => ({}), [])
  const editAnswerKeyInfo = useMemo(() => {
    if (!editExam) return null
    const t = examTemplates.find((x) => x.id === editExam.answerKeyTemplateId)
    return t
      ? { name: t.name, domain: t.domain || '', questionCount: t.questionCount ?? 0, totalScore: t.totalScore ?? 0 }
      : null
  }, [editExam, examTemplates])

  // 編輯時的第四步:科目 + 班級增減(勾/取消勾即代表加班/移除班)
  const examEditClassPicker = (
    <>
      <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-slate-700">科目</span>
          <select
            value={editSubject}
            onChange={(e) => setEditSubject(e.target.value)}
            className="min-w-[220px] rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-sky-400"
          >
            <option value="">不指定(教師端不開放檢視)</option>
            {subjects.map((sj) => (
              <option key={sj.subject} value={sj.subject}>
                {sj.subject}（{sj.classCount} 班・{sj.teacherCount} 位老師）
              </option>
            ))}
          </select>
        </div>
        <p className="mt-1.5 text-xs text-slate-500">
          {editSubject
            ? (() => {
                const covered = new Set(subjects.find((sj) => sj.subject === editSubject)?.campusClassIds ?? [])
                const miss = [...editClassIds].filter((id) => !covered.has(id))
                const names = miss.map((id) => classes.find((c) => String(c.campus_class_id) === id)?.class_label || id).slice(0, 5)
                return miss.length === 0
                  ? `已選 ${editClassIds.size} 班,全部都有「${editSubject}」任課老師。`
                  : `已選 ${editClassIds.size} 班,其中 ${miss.length} 班查無此科老師(${names.join('、')}${miss.length > names.length ? ' 等' : ''})。`
              })()
            : '不指定科目時,老師在教師端看不到這份考卷的成績。'}
        </p>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-600">勾選=施測班級;取消勾選會移除該班作業。</p>
        <span className="text-sm font-medium text-slate-500">已選 {editClassIds.size} 個班級</span>
      </div>
      {gradeGroups
        .map((g) => ({ ...g, classes: g.classes.filter((c) => c.campus_class_id) }))
        .filter((g) => g.classes.length > 0)
        .map((g) => (
          <div key={g.label}>
            <div className="mb-1.5 text-sm font-semibold text-slate-600">{g.label}</div>
            <div className="flex flex-wrap gap-1.5">
              {g.classes.map((c) => {
                const id = String(c.campus_class_id)
                const on = editClassIds.has(id)
                const existed = !!editExam?.classes.some((x) => String(x.campusClassId) === id)
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      setEditClassIds((prev) => {
                        const next = new Set(prev)
                        if (next.has(id)) next.delete(id)
                        else next.add(id)
                        return next
                      })
                    }}
                    title={existed && !on ? '取消勾選=移除此班作業(含已匯入的卷)' : undefined}
                    className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                      on
                        ? 'border-sky-300 bg-sky-50 text-sky-700'
                        : existed
                          ? 'border-rose-200 bg-rose-50 text-rose-600 line-through'
                          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {c.class_label}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
    </>
  )

  const examClassPicker = (
    <>
      {/* 2026-08-02 Step 11:科目——決定哪些任課老師能在教師端唯讀這份考卷的成績 */}
      <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-slate-700">科目</span>
          <select
            value={pickedSubject}
            onChange={(e) => setPickedSubject(e.target.value)}
            className="min-w-[220px] rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-sky-400"
          >
            <option value="">不指定(教師端不開放檢視)</option>
            {subjects.map((s) => (
              <option key={s.subject} value={s.subject}>
                {s.subject}（{s.classCount} 班・{s.teacherCount} 位老師）
              </option>
            ))}
          </select>
        </div>
        <p className="mt-1.5 text-xs text-slate-500">
          {pickedSubject
            ? (() => {
                const picked = [...pickedClassIds]
                const covered = new Set(subjects.find((s) => s.subject === pickedSubject)?.campusClassIds ?? [])
                const miss = picked.filter((id) => !covered.has(id))
                const missNames = miss
                  .map((id) => classes.find((c) => String(c.campus_class_id) === id)?.class_label || id)
                  .slice(0, 6)
                if (picked.length === 0) return '選好班級後,這裡會顯示有多少班找得到任課老師。'
                return miss.length === 0
                  ? `已選 ${picked.length} 班,全部都有「${pickedSubject}」任課老師,可在教師端唯讀檢視。`
                  : `已選 ${picked.length} 班,其中 ${picked.length - miss.length} 班有任課老師;${missNames.join('、')}${miss.length > missNames.length ? ' 等' : ''} 查無此科老師(該班老師將看不到成績)。`
              })()
            : '不指定科目時,老師在教師端看不到這份考卷的成績;之後仍可重建考卷補上。'}
        </p>
      </div>
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-600">勾選這份考卷要施測的班級(可跨年級)。</p>
        <span className="text-sm font-medium text-slate-500">已選 {pickedClassIds.size} 個班級</span>
      </div>
      {gradeGroups
        .map((g) => ({ ...g, classes: g.classes.filter((c) => c.campus_class_id) }))
        .filter((g) => g.classes.length > 0)
        .map((g) => {
          const ids = g.classes.map((c) => String(c.campus_class_id))
          const allPicked = ids.every((id) => pickedClassIds.has(id))
          return (
            <div key={g.label}>
              <div className="mb-1.5 flex items-center gap-3">
                <span className="text-sm font-semibold text-slate-600">{g.label}</span>
                <button
                  type="button"
                  onClick={() => {
                    setPickedClassIds((prev) => {
                      const next = new Set(prev)
                      if (allPicked) ids.forEach((id) => next.delete(id))
                      else ids.forEach((id) => next.add(id))
                      return next
                    })
                  }}
                  className="text-xs font-medium text-sky-600 hover:underline"
                >
                  {allPicked ? '取消全選' : '全選'}
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {g.classes.map((c) => {
                  const id = String(c.campus_class_id)
                  const on = pickedClassIds.has(id)
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => {
                        setPickedClassIds((prev) => {
                          const next = new Set(prev)
                          if (on) next.delete(id)
                          else next.add(id)
                          return next
                        })
                      }}
                      className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                        on
                          ? 'border-sky-400 bg-sky-50 font-semibold text-sky-700'
                          : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                      }`}
                    >
                      {c.class_label}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
    </>
  )

  return (
    <div className="min-h-screen bg-[#f7f7f5]">
      <div className="mx-auto flex min-h-screen w-full max-w-[1280px] flex-col">
      {/* 頂部 bar：對齊教師端 */}
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-[#f7f7f5]/95 px-4 py-2 backdrop-blur md:px-6">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <img
              src="/logo.png"
              alt="RedPen AI logo"
              className="h-10 w-10 object-contain mix-blend-multiply md:h-12 md:w-12"
            />
            <div>
              <h1 className="text-lg font-semibold text-slate-900 md:text-xl">RedPen AI</h1>
              <p className="text-xs text-slate-500">學校檢視{school ? ` · ${school.name}` : ''}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {walletBalance != null && (
              <div
                className="flex h-10 items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 text-sm text-amber-800"
                title="學校共用點數:統一批改與報告產生由學校點數扣除,全校行政看到同一個餘額。儲值由 RedPen AI 於簽約/付款後入點。"
              >
                <Droplet className="h-4 w-4" />
                <span className="font-semibold tabular-nums">{walletBalance}</span>
                <span className="text-xs">學校點數</span>
              </div>
            )}
            {schoolList.length > 1 && (
              <select
                value={school?.school_id ?? ''}
                onChange={(e) => void switchSchool(e.target.value)}
                className="h-10 rounded-lg border border-slate-200 bg-white px-2 text-sm text-slate-700 shadow-sm"
                aria-label="切換學校"
              >
                {schoolList.map((s) => (
                  <option key={s.school_id} value={s.school_id}>{s.name}</option>
                ))}
              </select>
            )}
            {/* sync 引擎宿主:行政端在主 shell 之外,匯入的卷靠這顆上雲(Step 7 必要) */}
            <SyncIndicator autoSync />
            <button
              type="button"
              onClick={onBack}
              className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 shadow-sm hover:border-slate-300"
            >
              <ArrowLeft className="h-4 w-4" />
              返回教師端
            </button>
          </div>
        </div>
      </header>

      {/* 左選單 + 右內容：對齊學生端 */}
      <div className="grid min-h-0 flex-1 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="border-b border-slate-200 bg-[#F7F8FA] lg:border-b-0 lg:border-r">
          <div className="h-full overflow-y-auto p-4 md:p-5">
            <section>
              <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                學校功能
              </h2>
              <nav className="space-y-0.5">
                {navItems.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => item.enabled && setTab(item.key)}
                    disabled={!item.enabled}
                    className={`group flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition ${
                      tab === item.key
                        ? 'bg-sky-100 text-sky-700'
                        : item.enabled
                          ? 'text-slate-700 hover:bg-slate-200/55'
                          : 'cursor-not-allowed text-slate-400'
                    }`}
                  >
                    <span
                      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded ${
                        tab === item.key ? 'bg-white text-sky-700' : 'bg-slate-100 text-slate-500'
                      }`}
                    >
                      <item.icon className="h-5 w-5" />
                    </span>
                    <span className="truncate text-base font-semibold">{item.label}</span>
                    {!item.enabled && (
                      <span className="ml-auto rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
                        即將推出
                      </span>
                    )}
                  </button>
                ))}
              </nav>
            </section>
          </div>
        </aside>

        <section className="overflow-y-auto bg-white px-4 py-4 md:px-6 md:py-5">
          {/* 標題列 + 重新整理 */}
          <div className="mb-4 flex items-center justify-between border-b border-slate-200 pb-3">
            <h2 className="text-xl font-semibold text-slate-900">
              {tab === 'overview'
                ? '學生總覽'
                : tab === 'answerkeys'
                  ? '建立答案'
                  : tab === 'exams'
                    ? '考卷批改'
                    : tab === 'grades'
                      ? '成績統計'
                      : tab === 'teachers'
                        ? '教師總覽'
                        : '弱點分析'}
            </h2>
            <div className="flex items-center gap-2">
              {(school || preferredSchoolId) && (
                <button
                  type="button"
                  onClick={() => void runRosterSync()}
                  disabled={rosterSyncing || loading}
                  className="inline-flex items-center gap-1.5 rounded-md bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <School className={`h-3 w-3 ${rosterSyncing ? 'animate-pulse' : ''}`} />
                  {rosterSyncing ? '同步中…' : '全校名冊同步'}
                </button>
              )}
              <button
                type="button"
                onClick={() => void loadSchool()}
                disabled={loading}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
                重新整理
              </button>
            </div>
          </div>

          {/* 學校摘要(學生/班級數;只在學生總覽顯示) */}
          {school && tab === 'overview' && (
            <div className="mb-5 flex flex-wrap items-center gap-6 rounded-xl border border-slate-200 bg-slate-50/60 px-5 py-3">
              <div className="flex items-center gap-2 text-slate-700">
                <Users className="h-4 w-4 text-sky-600" />
                <span className="text-lg font-semibold tabular-nums">
                  {/* 有全校名冊(班級卡帶 campus_class_id)時,摘要以名冊加總為準,跟下方班級卡一致 */}
                  {classes.some((c) => c.campus_class_id)
                    ? classes.reduce((sum, c) => sum + (c.student_count || 0), 0)
                    : school.student_count}
                </span>
                <span className="text-sm text-slate-500">名學生</span>
              </div>
              <div className="flex items-center gap-2 text-slate-700">
                <Layers className="h-4 w-4 text-sky-600" />
                <span className="text-lg font-semibold tabular-nums">
                  {classes.some((c) => c.campus_class_id) ? classes.length : school.class_count}
                </span>
                <span className="text-sm text-slate-500">個班級</span>
              </div>
            </div>
          )}

          {error && (
            <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {error}
            </div>
          )}

          {tab === 'weakness' ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-6 py-16 text-center text-slate-400">
              弱點分析即將推出
            </div>
          ) : tab === 'answerkeys' ? (
            <AnswerBank embedded />
          ) : tab === 'exams' && gradeExam ? (
            /* Step 8:AI 批改=嵌入教師端 GradingPage 跨班批次模式,自然流動排版(內容區捲動看全部班級)。
               返回鍵用批改頁自己的(onBack→考卷列表),不另加麵包屑避免雙層頁首 */
            <div>
              <p className="mb-2 text-xs text-slate-400">
                批改期間請保持此頁開啟;AI 費用由學校點數扣除。
              </p>
              {gradeSyncing ? (
                <div className="flex min-h-[320px] items-center justify-center text-sm text-slate-400">
                  正在準備考卷資料…
                </div>
              ) : (
                <Suspense
                  fallback={
                    <div className="flex min-h-[320px] items-center justify-center text-sm text-slate-400">
                      載入批改頁…
                    </div>
                  }
                >
                  <LazyGradingPage
                    embedded
                    assignmentId={gradeBatchIds[0] ?? ''}
                    batchAssignmentIds={gradeBatchIds}
                    onBack={() => {
                      setGradeExam(null)
                      // 批改結束回列表:刷新學校點數餘額
                      if (school) void loadWallet(school.school_id)
                    }}
                  />
                </Suspense>
              )}
            </div>
          ) : tab === 'grades' ? (
            <Gradebook embedded scope="school" />
          ) : tab === 'exams' && reportExam ? (
            /* Step 9:報告生成——第一層=學生檢討單 PDF(紙本檢討主形態、user 拍板);家長報告之後 */
            <div>
              <div className="mb-3 flex items-center gap-2 text-sm text-slate-500">
                <button
                  type="button"
                  onClick={() => setReportExam(null)}
                  className="inline-flex items-center gap-1 font-medium text-sky-600 hover:underline"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  返回考卷列表
                </button>
                <span className="text-slate-300">|</span>
                <span className="font-medium text-slate-700">{reportExam.title}・報告生成</span>
              </div>
              {reportSyncing ? (
                <div className="flex min-h-[240px] items-center justify-center text-sm text-slate-400">
                  正在準備考卷資料…
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="rounded-xl border border-slate-200 bg-white p-5">
                    <h3 className="text-sm font-semibold text-slate-800">學生檢討單(紙本)</h3>
                    <p className="mt-1 text-xs text-slate-500">
                      每位學生逐題列出:作答裁圖+AI 擷取內容+得分(扣分題附正解、低信心題標示核對),自動排版成兩頁、末頁附總分與核對簽名欄。一個班合併成一個 PDF,直接列印發下。
                    </p>
                    <div className="mt-3 divide-y divide-slate-100">
                      {reportExam.classes.map((c) => {
                        const cnt = reportCounts[c.assignmentId]
                        const busy = reportBusy === c.assignmentId
                        const msg = reportMsg[c.assignmentId]
                        return (
                          <div key={c.assignmentId} className="flex items-center justify-between gap-3 py-2.5">
                            <div className="min-w-0">
                              <span className="text-sm font-medium text-slate-800">{c.className}</span>
                              <span className="ml-2 text-xs text-slate-400">
                                {cnt ? `已批改 ${cnt.graded}/${cnt.total} 份` : '載入中…'}
                              </span>
                              {msg && <span className="ml-2 text-xs text-emerald-600">{msg}</span>}
                            </div>
                            <button
                              type="button"
                              disabled={busy || reportBusy !== null || !cnt || cnt.graded === 0}
                              onClick={() => void generateReviewSheet(c.assignmentId)}
                              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sky-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                            >
                              <FileText className="h-3.5 w-3.5" />
                              {busy
                                ? reportProg
                                  ? `${reportProg.phase === 'build' ? '裁圖中' : 'PDF 渲染'} ${reportProg.done}/${reportProg.total}`
                                  : '準備中…'
                                : '產生檢討單 PDF'}
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                  <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-5 py-6 text-center text-xs text-slate-400">
                    家長報告(之後推出)
                  </div>
                </div>
              )}
            </div>
          ) : tab === 'exams' && importExam ? (
            /* Step 7:匯入考卷=頁面切換(比照教師端整頁匯入,非彈窗——user 拍板視覺統一) */
            <div className="flex h-[calc(100vh-230px)] min-h-[480px] flex-col">
              <div className="mb-3 flex items-center gap-2 text-sm text-slate-500">
                <button
                  type="button"
                  onClick={() => setImportExam(null)}
                  className="inline-flex items-center gap-1 font-medium text-sky-600 hover:underline"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  返回考卷列表
                </button>
                <ChevronRight className="h-3.5 w-3.5" />
                <span className="font-medium text-slate-900">匯入考卷 · {importExam.title}</span>
              </div>
              {/* 班級 tabs */}
              <div className="flex gap-1 overflow-x-auto border-b border-slate-200 px-1">
                {importExam.classes.map((c, i) => (
                  <button
                    key={c.campusClassId}
                    type="button"
                    onClick={() => setImportClassIdx(i)}
                    className={`shrink-0 rounded-t-lg border border-b-0 px-4 py-2 text-sm font-medium transition ${
                      i === importClassIdx
                        ? 'border-slate-200 bg-white text-sky-700'
                        : 'border-transparent text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    {c.className}
                  </button>
                ))}
              </div>
              <div className="min-h-0 flex-1 overflow-hidden rounded-b-xl border border-t-0 border-slate-200">
                {importSyncing ? (
                  <div className="flex h-full items-center justify-center text-sm text-slate-400">
                    正在準備考卷資料…
                  </div>
                ) : (
                  importExam.classes[importClassIdx] && (
                    <UnifiedImportPage
                      key={importExam.classes[importClassIdx].assignmentId}
                      assignmentId={importExam.classes[importClassIdx].assignmentId}
                      embedded
                      pdfOnly
                    />
                  )
                )}
              </div>
            </div>
          ) : tab === 'exams' ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-slate-500">建立學校統一考卷 → 逐班匯入 PDF → 一鍵 AI 批改(扣學校點數)。</p>
                <button
                  type="button"
                  onClick={() => {
                    setPickedClassIds(new Set())
                    setPickedSubject('')
                    setCreateExamOpen(true)
                  }}
                  className="rounded-md bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700"
                >
                  ＋ 建立考卷
                </button>
              </div>
              {examsLoading && exams.length === 0 && (
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-6 py-10 text-center text-sm text-slate-400">
                  載入中…
                </div>
              )}
              {!examsLoading && exams.length === 0 && (
                <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-6 py-14 text-center text-sm text-slate-400">
                  尚無考卷。按「建立考卷」開始:命名 → 選答案卷 → 設定批改規則 → 勾選施測班級。
                  {examTemplates.length === 0 && (
                    <div className="mt-2 text-xs text-slate-400">
                      提示:您還沒有答案卷——請先到左側「答案卷」建立,或請出題老師給您分享碼匯入。
                    </div>
                  )}
                </div>
              )}
              {/* 考卷卡片:比照教師端作業卡(大卡+右側三顆方形動作鈕) */}
              <div className="space-y-3">
                {exams.map((ex) => (
                  <div key={ex.id} className="w-full rounded-xl border border-slate-200 bg-white px-4 py-4 hover:border-slate-300">
                    <div className="flex items-center justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="mb-1 flex items-center gap-2">
                          <h3 className="text-base font-semibold text-gray-900">{ex.title}</h3>
                          <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                            {EXAM_STATUS_LABEL[ex.status] || ex.status}
                          </span>
                          {ex.subject ? (
                            <span className="rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700" title="任課老師可在教師端唯讀檢視這份考卷">
                              {ex.subject}
                            </span>
                          ) : (
                            <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700" title="未指定科目:老師在教師端看不到這份考卷,可按「編輯」補上">
                              未指定科目
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              setEditExam(ex)
                              setEditSubject(ex.subject || '')
                              setEditClassIds(new Set(ex.classes.map((c) => String(c.campusClassId))))
                              void (async () => {
                                // 已批改份數:換答案卷的危險確認要顯示
                                const ids = ex.classes.map((c) => c.assignmentId).filter(Boolean)
                                let n = 0
                                for (const aid of ids) {
                                  n += await db.submissions.where('assignmentId').equals(aid)
                                    .filter((x) => x.status === 'graded').count()
                                }
                                setEditGradedCount(n)
                              })()
                            }}
                            className="text-[11px] font-medium text-sky-600 hover:underline"
                          >
                            編輯
                          </button>
                        </div>
                        <p className="text-sm text-gray-600">
                          {ex.classes.length} 個班級 · 建立於{' '}
                          {new Date(ex.createdAt).toLocaleDateString('zh-TW', { month: '2-digit', day: '2-digit' })}
                        </p>
                        <button
                          type="button"
                          onClick={() => setExpandedExamId(expandedExamId === ex.id ? null : ex.id)}
                          className="mt-1 text-xs font-medium text-sky-600 hover:underline"
                        >
                          {expandedExamId === ex.id ? '收合班級' : '檢視班級'}
                        </button>
                      </div>

                      <div className="max-w-[58vw] self-center overflow-x-auto">
                        <div className="flex items-center justify-end gap-2 whitespace-nowrap pb-1">
                          <button
                            type="button"
                            onClick={() => openImportExam(ex)}
                            className="inline-flex h-24 w-24 flex-col items-center justify-center gap-1 rounded-xl border border-slate-300 bg-white text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
                          >
                            <Upload className="h-4 w-4" />
                            <span className="text-center leading-tight">匯入考卷</span>
                          </button>
                          <span className="px-1 text-slate-300">›</span>
                          <button
                            type="button"
                            onClick={() => openGradeExam(ex)}
                            className="inline-flex h-24 w-24 flex-col items-center justify-center gap-1 rounded-xl border border-slate-300 bg-white text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
                          >
                            <Sparkles className="h-4 w-4" />
                            <span className="text-center leading-tight">AI批改</span>
                          </button>
                          <span className="px-1 text-slate-300">›</span>
                          <button
                            type="button"
                            onClick={() => openReportExam(ex)}
                            className="inline-flex h-24 w-24 flex-col items-center justify-center gap-1 rounded-xl border border-slate-300 bg-white text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
                          >
                            <FileText className="h-4 w-4" />
                            <span className="text-center leading-tight">報告生成</span>
                          </button>
                        </div>
                      </div>
                    </div>
                    {expandedExamId === ex.id && (
                      <div className="mt-3 flex flex-wrap gap-1.5 border-t border-slate-100 pt-3">
                        {ex.classes.map((c) => (
                          <span
                            key={c.campusClassId}
                            className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-600"
                          >
                            {c.className}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : tab === 'teachers' ? (
            <div className="space-y-6">
              {/* 教師摘要 */}
              <div className="flex flex-wrap items-center gap-6 rounded-xl border border-slate-200 bg-slate-50/60 px-5 py-3">
                <div className="flex items-center gap-2 text-slate-700">
                  <Users className="h-4 w-4 text-sky-600" />
                  <span className="text-lg font-semibold tabular-nums">{teachers.length}</span>
                  <span className="text-sm text-slate-500">位教師</span>
                </div>
                <div className="flex items-center gap-2 text-slate-700">
                  <span className="text-lg font-semibold tabular-nums text-emerald-600">
                    {teachers.filter((t) => t.bound).length}
                  </span>
                  <span className="text-sm text-slate-500">位已綁定登入</span>
                </div>
                <div className="relative ml-auto min-w-[260px] flex-1 sm:max-w-sm">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    type="search"
                    value={teacherQuery}
                    onChange={(e) => setTeacherQuery(e.target.value)}
                    placeholder="搜尋姓名、帳號、任教班級或科目…"
                    className="w-full rounded-lg border border-slate-300 bg-white py-1.5 pl-9 pr-8 text-sm outline-none placeholder:text-slate-400 focus:border-sky-400"
                  />
                  {teacherQuery && (
                    <button
                      type="button"
                      onClick={() => setTeacherQuery('')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                      title="清除搜尋"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {teacherQuery.trim() && (
                <div className="-mb-2 text-xs text-slate-500">
                  符合「{teacherQuery.trim()}」的老師 {filteredTeachers.length} 位(共 {teachers.length} 位)
                </div>
              )}

              {teacherSource === 'fallback' && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                  尚未取得全校教師名冊,目前僅顯示登入過的老師(帳號欄為其登入帳號)。請按右上「全校名冊同步」抓取全校教師。
                </div>
              )}

              {/* 教師清單:全校名冊為主體,帳號=1Campus 帳號、綁定與否掛標籤 */}
              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50/60 text-left text-xs text-slate-500">
                      <th className="px-4 py-2.5 font-medium">老師(1Campus 帳號)</th>
                      <th className="px-3 py-2.5 font-medium">任教</th>
                      <th className="px-3 py-2.5 font-medium text-right">班級數</th>
                      <th className="px-3 py-2.5 font-medium text-right">作業數</th>
                      <th className="px-3 py-2.5 font-medium text-right">個人點數</th>
                      <th className="px-3 py-2.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTeachers.length === 0 && teachers.length > 0 && (
                      <tr>
                        <td colSpan={6} className="px-4 py-10 text-center text-sm text-slate-400">
                          找不到符合「{teacherQuery.trim()}」的老師。可改用姓名、1Campus 帳號、班級(如「五年3」)或科目關鍵字。
                        </td>
                      </tr>
                    )}
                    {filteredTeachers.map((t, i) => (
                      <tr key={t.profileId ?? t.account ?? i} className="border-b border-slate-50 hover:bg-slate-50/50">
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-slate-900">{t.name || '—'}</span>
                            {t.bound ? (
                              <span
                                className="rounded-full bg-emerald-50 border border-emerald-200 px-2 py-0.5 text-[11px] font-medium text-emerald-700"
                                title={t.loginEmail ? `登入帳號:${t.loginEmail}` : undefined}
                              >
                                已綁定
                              </span>
                            ) : (
                              <span className="rounded-full bg-slate-100 border border-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-500">
                                未綁定
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-slate-500">{t.account || '—'}</div>
                        </td>
                        <td className="px-3 py-2.5 text-slate-600">
                          {(() => {
                            const e = t.account ? teachingByTeacher.get(String(t.account)) : undefined
                            if (!e || e.classes.size === 0) return <span className="text-xs text-slate-300">—</span>
                            const subjects = [...e.subjects]
                            return (
                              <div className="whitespace-nowrap text-xs">
                                <span className="tabular-nums">{e.classes.size} 班</span>
                                <span className="text-slate-300"> · </span>
                                <span title={subjects.join('、')}>
                                  {subjects.length <= 2 ? subjects.join('、') : `${subjects.length} 科`}
                                </span>
                              </div>
                            )
                          })()}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">{t.classroomCount ?? '—'}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">{t.assignmentCount ?? '—'}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">{t.inkBalance ?? '—'}</td>
                        <td className="px-3 py-2.5 text-right whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => {
                              setGrantValue('')
                              setGrantTarget(t)
                            }}
                            disabled={!t.bound}
                            title={t.bound ? undefined : '老師尚未登入綁定,無法配發點數'}
                            className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-700 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            配發點數
                          </button>
                          <button
                            type="button"
                            onClick={() => void openAssign(t)}
                            className="ml-2 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                            title="指派這位老師任教哪些班級的哪一科(決定他在教師端能唯讀哪些考卷成績)"
                          >
                            任課指派
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!teachersLoading && teachers.length === 0 && (
                  <div className="px-4 py-10 text-center text-sm text-slate-400">
                    尚無教師名冊——請先按右上「全校名冊同步」;老師登入綁定後即可配發點數。
                  </div>
                )}
                {teachersLoading && (
                  <div className="px-4 py-10 text-center text-sm text-slate-400">載入中…</div>
                )}
              </div>

              {/* 2026-08-03(user:不可能有這個情境)「代為批改」入口已移除——學校考卷改走行政自己的帳號。
                  這張表只在 DB 還有殘留 job 時才出現(jobs.length > 0),留著讓在途工作能收尾/取消;
                  確認線上沒有殘留後可連同 refreshJobs/driveJob/cancelJob 一併刪。 */}
              {jobs.length > 0 && (
                <div>
                  <h3 className="mb-2 text-sm font-semibold text-slate-700">批改工作</h3>
                  <div className="overflow-x-auto rounded-xl border border-slate-200">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-slate-100 bg-slate-50/60 text-left text-xs text-slate-500">
                          <th className="px-4 py-2.5 font-medium">作業</th>
                          <th className="px-3 py-2.5 font-medium text-right">進度</th>
                          <th className="px-3 py-2.5 font-medium text-right">已用點數</th>
                          <th className="px-3 py-2.5 font-medium">狀態</th>
                          <th className="px-3 py-2.5" />
                        </tr>
                      </thead>
                      <tbody>
                        {jobs.map((j) => {
                          const isTerminal = ['completed', 'completed_with_errors', 'cancelled'].includes(j.status)
                          const isDriving = drivingJobId === j.id
                          return (
                            <tr key={j.id} className="border-b border-slate-50">
                              <td className="px-4 py-2.5 text-slate-900">{j.assignment_title || j.assignment_id}</td>
                              <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">
                                {j.done_count} / {j.total_count}
                                {j.failed_count > 0 && (
                                  <span className="ml-1 text-xs text-rose-600">(失敗 {j.failed_count})</span>
                                )}
                              </td>
                              <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">{j.ink_points}</td>
                              <td className="px-3 py-2.5">
                                <span
                                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                                    j.status === 'running'
                                      ? 'bg-sky-50 border border-sky-200 text-sky-700'
                                      : j.status === 'paused_insufficient'
                                        ? 'bg-rose-50 border border-rose-200 text-rose-700'
                                        : j.status === 'completed'
                                          ? 'bg-emerald-50 border border-emerald-200 text-emerald-700'
                                          : 'bg-slate-100 border border-slate-200 text-slate-600'
                                  }`}
                                >
                                  {isDriving ? '批改中…' : JOB_STATUS_LABEL[j.status] || j.status}
                                </span>
                                {j.last_error && !isTerminal && (
                                  <div className="mt-0.5 text-[11px] text-rose-600">{j.last_error}</div>
                                )}
                              </td>
                              <td className="px-3 py-2.5 text-right whitespace-nowrap">
                                {!isTerminal && !isDriving && (
                                  <button
                                    type="button"
                                    onClick={() => void driveJob(j.id)}
                                    className="mr-2 rounded-md bg-sky-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-sky-700"
                                  >
                                    {j.status === 'queued' ? '開始' : '繼續'}
                                  </button>
                                )}
                                {!isTerminal && (
                                  <button
                                    type="button"
                                    onClick={() => void cancelJob(j)}
                                    className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-600 hover:border-slate-400"
                                  >
                                    取消
                                  </button>
                                )}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* 學校點數紀錄 */}
              <div>
                <h3 className="mb-2 text-sm font-semibold text-slate-700">學校點數紀錄</h3>
                <div className="overflow-x-auto rounded-xl border border-slate-200">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-100 bg-slate-50/60 text-left text-xs text-slate-500">
                        <th className="px-4 py-2.5 font-medium">時間</th>
                        <th className="px-3 py-2.5 font-medium text-right">變動</th>
                        <th className="px-3 py-2.5 font-medium text-right">餘額</th>
                        <th className="px-3 py-2.5 font-medium">項目</th>
                        <th className="px-3 py-2.5 font-medium">操作者</th>
                        <th className="px-3 py-2.5 font-medium">備註</th>
                      </tr>
                    </thead>
                    <tbody>
                      {walletLedger.map((l, i) => (
                        <tr key={`${l.createdAt}:${i}`} className="border-b border-slate-50">
                          <td className="px-4 py-2 text-slate-600">
                            {new Date(l.createdAt).toLocaleString('zh-TW', {
                              month: '2-digit',
                              day: '2-digit',
                              hour: '2-digit',
                              minute: '2-digit'
                            })}
                          </td>
                          <td
                            className={`px-3 py-2 text-right font-semibold tabular-nums ${
                              l.delta > 0 ? 'text-emerald-600' : 'text-rose-600'
                            }`}
                          >
                            {l.delta > 0 ? '+' : ''}
                            {l.delta}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-700">{l.balanceAfter ?? '—'}</td>
                          <td className="px-3 py-2 text-slate-700">{LEDGER_REASON_LABEL[l.reason] || l.reason}</td>
                          <td className="px-3 py-2 text-slate-600">{l.actorName || '—'}</td>
                          <td className="px-3 py-2 text-slate-500">{l.note || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {walletLedger.length === 0 && (
                    <div className="px-4 py-8 text-center text-sm text-slate-400">尚無點數紀錄。</div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <>
              {/* 麵包屑 */}
              {school && (selectedClass || person) && (
                <div className="mb-4 flex flex-wrap items-center gap-1.5 text-sm text-slate-500">
                  <button onClick={backToClasses} className="hover:text-slate-900">
                    全部班級
                  </button>
                  {selectedClass && (
                    <>
                      <ChevronRight className="h-3.5 w-3.5" />
                      <button onClick={backToStudents} className="hover:text-slate-900">
                        {selectedClass}
                      </button>
                    </>
                  )}
                  {person && (
                    <>
                      <ChevronRight className="h-3.5 w-3.5" />
                      <span className="font-medium text-slate-900">{person.name}</span>
                    </>
                  )}
                </div>
              )}

              {/* Person 跨科檔案 */}
              {person ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-3 rounded-xl border border-slate-200 px-5 py-4">
                    <div className="flex h-11 w-11 items-center justify-center rounded-full bg-sky-100 font-bold text-sky-700">
                      {person.name?.slice(-2)}
                    </div>
                    <div>
                      <div className="text-lg font-semibold text-slate-900">{person.name}</div>
                      <div className="text-xs text-slate-500">
                        學號 {person.provider_student_id || person.student_number || '—'} ·{' '}
                        {recordsBySubject.length} 科 · {records.length} 份批改
                      </div>
                    </div>
                  </div>

                  {recordsBySubject.length === 0 && (
                    <div className="rounded-xl border border-slate-200 px-6 py-10 text-center text-slate-400">
                      此學生尚無批改紀錄
                    </div>
                  )}

                  {recordsBySubject.map(({ subject, rows, avg, count }) => (
                    <div key={subject} className="overflow-hidden rounded-xl border border-slate-200">
                      <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50 px-5 py-3">
                        <div className="flex items-center gap-2">
                          <BookOpen className="h-4 w-4 text-sky-600" />
                          <span className="font-semibold text-slate-900">{subject}</span>
                          <span className="text-xs text-slate-400">{count} 份</span>
                        </div>
                        {avg != null && (
                          <span className="text-sm">
                            平均 <span className={`font-bold ${scoreColor(avg)}`}>{avg}</span>
                          </span>
                        )}
                      </div>
                      <div className="divide-y divide-slate-50">
                        {rows.map((r) => (
                          <div key={r.submission_id} className="flex items-center justify-between px-5 py-2.5">
                            <div className="min-w-0">
                              <div className="truncate text-sm text-slate-900">{r.title || '（未命名）'}</div>
                              <div className="text-xs text-slate-400">{formatDate(r.graded_at)}</div>
                            </div>
                            <div className={`text-base font-bold ${scoreColor(r.score)}`}>
                              {r.score == null ? '—' : r.score}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : selectedClass ? (
                <div className="space-y-4">
                {/* 任課老師:決定這些老師在教師端能唯讀看到本班哪一科的學校考卷成績 */}
                {(() => {
                  const cid = String(
                    classes.find((c) => c.class_label === selectedClass)?.campus_class_id || ''
                  )
                  if (!cid) return null
                  const list = coursesByClass.get(cid) ?? []
                  const homeroom = classes.find((c) => c.class_label === selectedClass)?.homeroom_teacher_name
                  return (
                    <div className="rounded-xl border border-slate-200 bg-white p-4">
                      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="text-sm font-semibold text-slate-700">任課老師</span>
                        {homeroom && <span className="text-xs text-slate-500">導師 {homeroom}</span>}
                      </div>
                      {list.length === 0 ? (
                        <p className="text-xs text-slate-400">
                          尚無任課資料。可按右上「全校名冊同步」抓 1Campus 課程,或到「教師」分頁用「任課指派」手動指定。
                        </p>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {list.map((c, i) => (
                            <span
                              key={`${c.subject}-${c.teacher_acc}-${i}`}
                              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${
                                c.source === 'admin'
                                  ? 'border-sky-200 bg-sky-50 text-sky-700'
                                  : 'border-slate-200 bg-slate-50 text-slate-600'
                              }`}
                              title={c.source === 'admin' ? '行政手動指派' : '1Campus 課程資料'}
                            >
                              <span className="font-medium">{c.subject || '—'}</span>
                              <span className="text-slate-400">·</span>
                              <span>{c.teacher_name || c.teacher_acc || '未指定'}</span>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })()}
                {/* 班級學生清單 */}
                <div className="overflow-hidden rounded-xl border border-slate-200">
                  <div className="border-b border-slate-100 bg-slate-50 px-5 py-3 text-sm font-semibold text-slate-700">
                    {selectedClass} · {students.length} 名學生
                  </div>
                  {students.length === 0 && !loading && (
                    <div className="px-6 py-10 text-center text-slate-400">此班尚無學生</div>
                  )}
                  <div className="divide-y divide-slate-50">
                    {students.map((s) => (
                      <button
                        key={s.person_id}
                        onClick={() => void openPerson(s.person_id)}
                        className="flex w-full items-center justify-between px-5 py-3 text-left hover:bg-sky-50/60"
                      >
                        <div className="flex items-center gap-3">
                          <span className="w-8 text-sm tabular-nums text-slate-400">{s.seat_number ?? '—'}</span>
                          <span className="font-medium text-slate-900">{s.name}</span>
                        </div>
                        <div className="flex items-center gap-3">
                          {typeof s.subject_count === 'number' && (
                            <span className="text-xs text-slate-500">{s.subject_count} 科</span>
                          )}
                          <ChevronRight className="h-4 w-4 text-slate-300" />
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
                </div>
              ) : (
                /* 班級清單（年級篩選 + 依年級分組、班序自然排序） */
                <div className="space-y-5">
                  {classes.length === 0 && !loading && (
                    <div className="rounded-xl border border-slate-200 px-6 py-10 text-center text-slate-400">
                      尚無班級資料
                    </div>
                  )}
                  {classes.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setGradeFilter('all')}
                        className={`rounded-full px-3 py-1 text-sm font-medium transition ${
                          gradeFilter === 'all'
                            ? 'bg-sky-600 text-white'
                            : 'border border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                        }`}
                      >
                        全部
                      </button>
                      {presentGrades.map((g) => (
                        <button
                          key={g}
                          type="button"
                          onClick={() => setGradeFilter(g)}
                          className={`rounded-full px-3 py-1 text-sm font-medium transition ${
                            gradeFilter === g
                              ? 'bg-sky-600 text-white'
                              : 'border border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                          }`}
                        >
                          {g} 年級
                        </button>
                      ))}
                    </div>
                  )}
                  {gradeGroups
                    .filter((group) => gradeFilter === 'all' || group.grade === gradeFilter)
                    .map((group) => (
                      <div key={group.label}>
                        <div className="mb-2 text-sm font-semibold text-slate-500">{group.label}</div>
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                          {group.classes.map((c) => {
                            const cid = c.campus_class_id ? String(c.campus_class_id) : ''
                            const classCourses = cid ? coursesByClass.get(cid) ?? [] : []
                            const subjectCount = new Set(
                              classCourses.map((x) => x.subject).filter(Boolean) as string[]
                            ).size
                            return (
                              <button
                                key={c.campus_class_id ?? c.class_label}
                                onClick={() => void openClass(c.class_label, c.campus_class_id)}
                                className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-left transition hover:border-sky-300 hover:shadow-sm"
                              >
                                <div className="font-semibold text-slate-900">{c.class_label}</div>
                                <div className="mt-1 text-xs text-slate-500">
                                  {c.student_count} 名學生
                                  {c.homeroom_teacher_name && (
                                    <span className="text-slate-400"> · 導師 {c.homeroom_teacher_name}</span>
                                  )}
                                </div>
                                {cid && (
                                  <div className="mt-1 text-xs">
                                    {subjectCount > 0 ? (
                                      <span className="text-slate-400">任課 {subjectCount} 科</span>
                                    ) : (
                                      <span className="text-amber-600">尚無任課資料</span>
                                    )}
                                  </div>
                                )}
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </>
          )}
        </section>
      </div>
      </div>

      {/* 2026-08-02 任課指派:讓非 1Campus / 自建班級的學校也能決定「誰看得到哪份考卷」 */}
      {assignTeacher && (
        <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/40 p-4" onClick={() => !assignSaving && setAssignTeacher(null)}>
          <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-slate-900">
              任課指派 · {assignTeacher.name || assignTeacher.account}
            </h3>
            <p className="mt-1 text-xs text-slate-500">
              指派後,這位老師就能在教師端「成績統計」唯讀檢視這些班級該科目的考卷成績(不能改分)。
            </p>

            <div className="mt-4 flex-1 overflow-y-auto">
              {/* 既有任課 */}
              <div className="mb-4">
                <div className="mb-1.5 text-sm font-medium text-slate-700">目前任課</div>
                {assignExisting.length === 0 ? (
                  <p className="text-xs text-slate-400">尚無任課資料。</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {assignExisting.map((c, i) => (
                      <span
                        key={`${c.campus_class_id}-${c.subject}-${i}`}
                        className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${
                          c.source === 'admin'
                            ? 'border-sky-200 bg-sky-50 text-sky-700'
                            : 'border-slate-200 bg-slate-50 text-slate-600'
                        }`}
                        title={c.source === 'admin' ? '行政手動指派' : '1Campus 課程資料(同步而來、不可從這裡移除)'}
                      >
                        {c.class_name || c.campus_class_id} · {c.subject || '—'}
                        {c.source === 'admin' && (
                          <button
                            type="button"
                            onClick={() => void removeAssign(String(c.campus_class_id), String(c.subject || ''))}
                            className="ml-0.5 text-sky-500 hover:text-rose-600"
                            title="取消這筆指派"
                          >
                            ×
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* 新增指派 */}
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-slate-700">新增指派 · 科目</span>
                  <select
                    value={assignSubject}
                    onChange={(e) => setAssignSubject(e.target.value)}
                    className="min-w-[200px] rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-sky-400"
                  >
                    <option value="">請選擇科目</option>
                    {subjects.map((sj) => (
                      <option key={sj.subject} value={sj.subject}>{sj.subject}</option>
                    ))}
                  </select>
                </div>
                <p className="mb-2 text-xs text-slate-500">
                  勾選這位老師任教的班級({assignClassIds.size} 個已選)
                </p>
                {gradeGroups
                  .map((g) => ({ ...g, classes: g.classes.filter((c) => c.campus_class_id) }))
                  .filter((g) => g.classes.length > 0)
                  .map((g) => (
                    <div key={g.label} className="mb-2">
                      <div className="mb-1 text-xs font-semibold text-slate-500">{g.label}</div>
                      <div className="flex flex-wrap gap-1">
                        {g.classes.map((c) => {
                          const id = String(c.campus_class_id)
                          const on = assignClassIds.has(id)
                          return (
                            <button
                              key={id}
                              type="button"
                              onClick={() => {
                                setAssignClassIds((prev) => {
                                  const next = new Set(prev)
                                  if (next.has(id)) next.delete(id)
                                  else next.add(id)
                                  return next
                                })
                              }}
                              className={`rounded-full border px-2 py-0.5 text-xs transition-colors ${
                                on ? 'border-sky-300 bg-sky-100 text-sky-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                              }`}
                            >
                              {c.class_label}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ))}
              </div>
            </div>

            <div className="mt-4 flex justify-end gap-2 border-t border-slate-100 pt-3">
              <button
                type="button"
                onClick={() => setAssignTeacher(null)}
                disabled={assignSaving}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                關閉
              </button>
              <button
                type="button"
                onClick={() => void saveAssign()}
                disabled={assignSaving || !assignSubject || assignClassIds.size === 0}
                className="rounded-md bg-sky-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-sky-700 disabled:bg-slate-300"
              >
                {assignSaving ? '指派中…' : '確認指派'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 2026-08-02(user:比照教師端)編輯考卷——直接重用教師端同一個表單元件,
          連「更換答案卷(選填)」「批改規則」「刪除」都是同一套 UI 與語意;
          第四步 classStep 換成「科目 + 班級增減」。 */}
      <AssignmentFormModal
        mode="edit"
        open={!!editExam}
        onClose={() => setEditExam(null)}
        onSubmit={submitExamEdit}
        onDelete={editExam ? () => void deleteExam(editExam) : undefined}
        isSubmitting={editSaving}
        initialTitle={editExam?.title || ''}
        initialSettings={editExamSettings}
        initialAnswerKeyInfo={editAnswerKeyInfo}
        editAssignmentTitle={editExam?.title || ''}
        gradedCount={editGradedCount}
        folders={[]}
        answerKeys={examTemplates.map((t) => ({
          id: t.id,
          name: t.name,
          domain: t.domain || '',
          folder: t.folder || '',
          questionCount: t.questionCount ?? 0,
          totalScore: t.totalScore ?? 0
        }))}
        hideStudentOptions
        titleLabel="考卷名稱"
        titlePlaceholder="例如:114學年上學期期末考"
        classStep={{
          label: '科目與班級',
          content: examEditClassPicker,
          ready: editClassIds.size > 0,
          submitLabel: '儲存變更'
        }}
      />

      {/* 更換答案卷:核彈級確認(與教師端同一套文案/勾選要求) */}
      <DangerConfirmModal
        open={!!changeAkConfirm}
        severity="high"
        title="更換答案卷"
        clears={['分數', '批改結果', '訂正紀錄', '申訴紀錄']}
        keeps={['學生作答照片']}
        affectedNoun="份批改"
        affected={changeAkConfirm ? [{ id: 'count', label: `此考卷已有 ${editGradedCount} 份批改結果`, meta: '全部失效' }] : []}
        acknowledgeText="我了解更換答案卷會一併清除所有訂正/申訴紀錄（含「已完成訂正」），且無法復原。"
        confirmLabel="仍要更換"
        cancelLabel="取消"
        busy={editSaving}
        onCancel={() => setChangeAkConfirm(null)}
        onConfirm={async () => {
          const pending = changeAkConfirm
          if (!pending) return
          setChangeAkConfirm(null)
          await commitExamEdit(pending.data, true)
        }}
      />

      {/* 建立考卷:重用老師端 AssignmentFormModal(隱藏學生選項、文案改考卷) */}
      <AssignmentFormModal
        mode="create"
        open={createExamOpen}
        onClose={() => setCreateExamOpen(false)}
        onSubmit={submitCreateExam}
        isSubmitting={creatingExam}
        folders={[]}
        answerKeys={examTemplates.map((t) => ({
          id: t.id,
          name: t.name,
          domain: t.domain,
          folder: t.folder,
          answerKey: { questions: new Array(t.questionCount).fill({}), totalScore: t.totalScore },
          pageOrientations: t.pageOrientations
        }))}
        hideStudentOptions
        titleLabel="考卷名稱"
        titlePlaceholder="例如：114學年度下學期五年級國語期中考"
        classStep={{
          label: '選擇施測班級',
          ready: pickedClassIds.size > 0,
          submitLabel: `建立考卷(${pickedClassIds.size} 班)`,
          content: examClassPicker
        }}
      />

      {/* 配發點數 modal:學校池 → 老師個人帳戶 */}
      {grantTarget && (
        <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/50 px-4">
          <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl">
            <div className="flex items-center justify-center gap-2 border-b border-amber-200 bg-amber-50 px-6 py-4 text-amber-800">
              <Droplet className="h-4 w-4" />
              <span className="text-base font-bold">配發點數給 {grantTarget.name || grantTarget.account}</span>
            </div>
            <div className="space-y-3 px-6 py-5">
              <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600">
                從學校點數(目前 {walletBalance ?? '—'} 點)轉入老師個人帳戶,供其日常批改使用。此操作會寫入雙方點數紀錄。
              </p>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">配發點數(正整數)</label>
                <input
                  type="number"
                  value={grantValue}
                  onChange={(e) => setGrantValue(e.target.value)}
                  min={1}
                  step={1}
                  autoFocus
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  placeholder="例如 100"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 px-6 pb-5">
              <button
                type="button"
                onClick={() => setGrantTarget(null)}
                disabled={grantBusy}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:border-slate-400"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void submitGrant()}
                disabled={grantBusy || !grantValue.trim() || !(parseInt(grantValue, 10) > 0)}
                className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
              >
                {grantBusy ? '處理中…' : '確認配發'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

