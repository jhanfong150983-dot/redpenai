import { useCallback, useEffect, useMemo, useState } from 'react'
import { db } from '@/lib/db'
import { ensureAssignmentDetails } from '@/lib/submission-details'
import type { Submission } from '@/lib/db'
import AssignmentSummaryPanel from './ai-report/components/AssignmentSummaryPanel'
import ItemAnalysisSection from './ai-report/components/ItemAnalysisSection'
import AnswerPatternsTab from './ai-report/components/AnswerPatternsTab'
import { withoutSchoolExamClassrooms, withoutSchoolExamAssignments, schoolExamClassroomIds } from '@/lib/school-exam'
import { withoutArchivedClassrooms, onlyArchivedClassrooms } from '@/lib/classroom-archive'
import { ClassroomSelectOptions } from '@/components/ClassroomSelectOptions'
import { ParentReportTab } from './ai-report/components/ParentReportTab'
import AssignmentOverviewSection from './ai-report/components/AssignmentOverviewSection'
import type { ItemAnalysisQuestion } from './ai-report/item-analysis'
import ConceptMasteryTable from './ai-report/components/ConceptMasteryTable'
import type { StudentMastery, ConceptEntry } from './ai-report/components/ConceptMasteryTable'
import ConceptRadarChart from './ai-report/components/ConceptRadarChart'
import ConceptDrillDown from './ai-report/components/ConceptDrillDown'
import KpBackfillCard from './ai-report/components/KpBackfillCard'
import { downloadClassReviewSheetPdf } from '@/lib/reviewSheetPdf'

// 跨班比較（exam-compare 端點的匿名彙總；classCount 之外無任何來源資訊）
export type CrossCompare = {
  classCount: number
  byCode: Record<string, { full: number; partial: number; wrong: number; total: number; label?: string }>
  byQuestion: Record<string, { full: number; partial: number; wrong: number; blank: number; total: number }>
  answers: Record<string, Array<{ value: string; score: number; count: number }>>
  /** 匿名作答向量（無 id、已打亂）：試題分析全體重算用——多班當一個母體算 P/D/高低分組/α */
  responses?: Array<{ details: Array<{ q: string; s: number; m: number | null; c: boolean; v: string }> }>
}

// 跨班比較切換鈕（三個視圖共用同一個開關狀態）
function CrossToggle({ on, onToggle, classCount }: { on: boolean; onToggle: () => void; classCount: number }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '4px 12px', borderRadius: 999, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
        border: on ? '1px solid #7c3aed' : '1px solid #cbd5e1',
        background: on ? '#7c3aed' : '#fff',
        color: on ? '#fff' : '#475569',
      }}
      title="與使用同一份答案卷的其他班級比較（匿名彙總、不顯示班級來源）"
    >
      {on ? '✓' : ''} 跨班比較（同卷 {classCount} 班）
    </button>
  )
}
import DomainDiagnosisView from './ai-report/components/DomainDiagnosisView'
import InkConfirmModal from '@/components/InkConfirmModal'
import {
  runSanityCheck
} from './ai-report/compute'
import {
  buildDomainAggregate,
  buildDomainPlan,
  generateDomainDiagnosisWithLLM,
  hashDomainPlanForCache
} from './ai-report/domain-diagnosis'
import type {
  DomainDiagnosis
} from './ai-report/types'
import './AiReport.css'

type SyncAssignment = {
  id: string
  classroomId?: string
  title?: string
  domain?: string
  createdAt?: string | number
  updatedAt?: number
  answerKey?: unknown
  conceptTags?: Record<string, { code: string; label: string }>
}

type SyncStudent = {
  id: string
  classroomId?: string
  seatNumber?: number | null
  name?: string
}

type SyncClassroom = {
  id: string
  name?: string
  folder?: string | null
  archived?: boolean
}

type SyncSubmission = {
  id: string
  assignmentId?: string
  studentId?: string
  status?: string
  createdAt?: number
  updatedAt?: number
  gradedAt?: number
  score?: number | string | null
  gradingResult?: unknown
}

type SyncPayload = {
  classrooms: SyncClassroom[]
  students: SyncStudent[]
  assignments: SyncAssignment[]
  submissions: SyncSubmission[]
  assignmentTags?: AssignmentTagSummary[]
}

type GradingDetail = {
  questionId?: string
  score?: number
  maxScore?: number
  isCorrect?: boolean
  reason?: string
  studentAnswer?: string
}

type GradingMistake = {
  id?: string
  reason?: string
  question?: string
}

type GradingResult = {
  details?: GradingDetail[]
  mistakes?: GradingMistake[]
  weaknesses?: string[]
  suggestions?: string[]
  feedback?: string[]
  totalScore?: number
}

type PreparedSubmission = SyncSubmission & {
  grading?: GradingResult | null
  details: GradingDetail[]
  mistakes: GradingMistake[]
  weaknesses: string[]
  scoreValue: number | null
  totalScoreValue: number | null
  createdAtMs: number | null
  blankCount?: number
  totalQuestionCount?: number
}


type TagStat = {
  label: string
  count: number
  examples?: string[]
}

type DomainAggregate = {
  label: string
  count: number
  assignmentCount?: number
  sampleCount?: number | null
  generatedAt?: string | null
}

type DomainReport = {
  domain: string
  tags: DomainAggregate[]
}

type AbilityAggregate = {
  id: string
  label: string
  totalCount: number
  assignmentCount: number
  domainCount: number
  generatedAt?: string | null
}

type TagAbilityMap = {
  tag: string
  ability: string
  confidence?: number | null
}

type TagDictionaryItem = {
  id: string
  label: string
  normalized_label: string
  status?: string | null
  merged_to_tag_id?: string | null
  merged_to_label?: string | null
}


type ReportPayload = {
  domains: DomainReport[]
  abilities: AbilityAggregate[]
  tagAbilityMap: TagAbilityMap[]
  dictionary?: TagDictionaryItem[]
}

type AssignmentTagSummary = {
  assignmentId: string
  source?: 'ai' | 'rule'
  status?: 'ready' | 'pending' | 'insufficient_samples'
  sampleCount?: number
  lastEventAt?: number
  nextRunAt?: number
  lastGeneratedAt?: number
  tags?: TagStat[]
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function formatDate(value?: number | null) {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--'
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}/${month}/${day}`
}

function normalizeDomain(domain?: string) {
  const value = domain?.trim()
  if (!value || value === 'uncategorized') return '全部'
  return value
}

function getAssignmentTitle(assignment: SyncAssignment) {
  const title = assignment.title?.trim()
  if (title) return title
  const domain = assignment.domain?.trim()
  if (domain) return `${domain}作業`
  return '未命名作業'
}

function parseGradingResult(raw: unknown): GradingResult | null {
  if (!raw) return null
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as GradingResult
    } catch {
      return null
    }
  }
  if (typeof raw === 'object') return raw as GradingResult
  return null
}

function isBlankText(value?: string) {
  if (!value) return false
  return /未作答|未在該題|空白|未填|未答|無作答/.test(value)
}

function computeBlankStats(details: GradingDetail[]) {
  if (!details.length) {
    return { blankCount: null, totalQuestionCount: null }
  }
  let blankCount = 0
  details.forEach((detail) => {
    if (isBlankText(detail.studentAnswer) || isBlankText(detail.reason)) {
      blankCount += 1
    }
  })
  return { blankCount, totalQuestionCount: details.length }
}

function isAiFailure(grading?: GradingResult | null) {
  if (!grading?.feedback) return false
  return grading.feedback.some((item) =>
    /系統錯誤|Unable to process|檔案總大小過大/i.test(item)
  )
}

function isGraded(submission: PreparedSubmission) {
  return Boolean(submission.grading) || submission.status === 'graded'
}



type AiReportProps = {
  onBack: () => void
  embedded?: boolean
  /**
   * 2026-08-12 user 二修（教學影片情境對齊：考試→檢討→分析三階段）：
   *   exam（預設）＝「檢討考卷」：考試總覽（含檢討單下載）→樣態分析——考完隔天的檢討課用
   *   track＝「後續追蹤」：試題分析→概念雷達→家長報告——檢討完的深入分析與對外交付
   */
  variant?: 'exam' | 'track'
  /** 2026-08-29 歷史資料頁：'archived'=只看已封存班級 */
  classroomScope?: 'active' | 'archived'
}

export default function AiReport({ onBack, embedded, variant = 'exam', classroomScope = 'active' }: AiReportProps) {
  const isTrack = variant === 'track'
  const pageEyebrow = isTrack ? '後續追蹤' : '檢討考卷'
  const [syncData, setSyncData] = useState<SyncPayload | null>(null)
  const [reportData, setReportData] = useState<ReportPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [localSubmissions, setLocalSubmissions] = useState<Submission[]>([])
  const [error, setError] = useState<string | null>(null)
const [selectedClassroomId, setSelectedClassroomId] = useState('')
  const [selectedAssignmentId, setSelectedAssignmentId] = useState('')
  const [selectedDomain, setSelectedDomain] = useState('')
const [domainDiagnoses, setDomainDiagnoses] = useState<
    Record<string, DomainDiagnosis | null>
  >({})
  const [domainDiagnosisLoading, setDomainDiagnosisLoading] = useState<
    Record<string, boolean>
  >({})
  // 手動觸發領域診斷重生（後補題本後可用，繞過 cache）
  const [domainDiagnosisRegenCounter, setDomainDiagnosisRegenCounter] = useState(0)
  const [activeTab, setActiveTab] = useState<'overview' | 'class' | 'items' | 'patterns' | 'parent' | 'domain' | 'student'>(isTrack ? 'items' : 'overview')
  // 2026-06-01: 生成/重生報告會花墨水 → 先跳同意框，同意才跑（存待執行動作）
  // 2026-07-22：requestInk 支援自訂 modal 內容（統一走 InkConfirmModal、不再混用 window.confirm）
  const [inkAction, setInkAction] = useState<{ fn: () => void; message?: React.ReactNode } | null>(null)
  const requestInk = useCallback((fn: () => void, message?: React.ReactNode) => setInkAction({ fn, message }), [])
  // 2026-08-03 家長報告抬頭:學校若設了校名/校徽就取代老師的個人設定(user 拍板);
  //   順便帶回登入者姓名,當老師沒在偏好設定填「任課老師」時的預設值。
  const [reportBrand, setReportBrand] = useState<{
    schoolName: string; crestDataUrl: string; configured: boolean; viewerName: string
  } | null>(null)
  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch('/api/data/school-report-settings', { credentials: 'include' })
        if (!r.ok) return
        const d = await r.json()
        setReportBrand({
          schoolName: d?.schoolName || '',
          crestDataUrl: d?.crestDataUrl || '',
          configured: !!d?.configured,
          viewerName: d?.viewerName || ''
        })
      } catch { /* 非致命:退回個人設定 */ }
    })()
  }, [])
  const [assignmentSummary, setAssignmentSummary] = useState<{
    status: string
    class_summary: string | null
    class_suggestion: string | null
    minority_summary: string | null
    minority_suggestion: string | null
    student_summaries: { student_id: string; student_name: string; summary: string }[]
    sample_count: number
    updated_at?: string | null
    error_message?: string | null
  } | null>(null)
  const [assignmentSummaryLoading, setAssignmentSummaryLoading] = useState(false)
  const [latestGradedAt, setLatestGradedAt] = useState<string | null>(null)

  // Fetch assignment error summary when assignment changes
  const fetchAssignmentSummary = useCallback((assignmentId: string) => {
    setAssignmentSummaryLoading(true)
    fetch(`/api/data/assignment-summary?assignmentId=${encodeURIComponent(assignmentId)}`, {
      credentials: 'include'
    })
      .then(r => r.json())
      .then(data => {
        setAssignmentSummary(data?.summary ?? null)
        setLatestGradedAt(data?.latestGradedAt ?? null)
      })
      .catch(() => { setAssignmentSummary(null); setLatestGradedAt(null) })
      .finally(() => { setAssignmentSummaryLoading(false) })
  }, [])

  useEffect(() => {
    if (!selectedAssignmentId) {
      setAssignmentSummary(null)
      return
    }
    fetchAssignmentSummary(selectedAssignmentId)
  }, [selectedAssignmentId, fetchAssignmentSummary])

  const handleRetryAssignmentSummary = useCallback(() => {
    if (!selectedAssignmentId) return
    setAssignmentSummaryLoading(true)
    fetch('/api/data/refresh-assignment-summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ assignmentId: selectedAssignmentId }),
    })
      .then(() => {
        // 等 1 秒後重新拉狀態（server 已設為 running）
        setTimeout(() => fetchAssignmentSummary(selectedAssignmentId), 1000)
      })
      .catch(() => setAssignmentSummaryLoading(false))
  }, [selectedAssignmentId, fetchAssignmentSummary])

  useEffect(() => {
    let isActive = true
    const fetchData = async () => {
      setLoading(true)
      setError(null)
      try {
        const [syncResponse, reportResponse] = await Promise.all([
          fetch('/api/data/sync?includeTags=1', { credentials: 'include' }),
          fetch('/api/data/report', { credentials: 'include' })
        ])
        if (!syncResponse.ok) {
          throw new Error('無法取得作業資料，請重新整理')
        }
        if (!reportResponse.ok) {
          throw new Error('無法取得報告資料，請重新整理')
        }
        const [data, report] = (await Promise.all([
          syncResponse.json(),
          reportResponse.json()
        ])) as [SyncPayload, ReportPayload]
        if (isActive) {
          // 2026-08-11(user 抓到):行政端「學校考卷」班級鏡像(folder='學校考卷'、雙身分帳號 66 班)
          //   漏進學情報告的班級下拉——sync payload 在此源頭過濾,班級/作業/學生一次擋掉
          //   (同一判定模組 school-exam.ts;首頁/作業列表/匯入 2026-08-01 已堵、本頁漏網)。
          const schoolCrIds = schoolExamClassroomIds(data.classrooms ?? [])
          // 2026-08-29 班級歸檔：主介面只看 active、歷史資料頁只看 archived（作業/學生跟著班級走）
          const scopedClassrooms =
            classroomScope === 'archived'
              ? onlyArchivedClassrooms(withoutSchoolExamClassrooms(data.classrooms ?? []))
              : withoutArchivedClassrooms(withoutSchoolExamClassrooms(data.classrooms ?? []))
          const scopedClassIds = new Set(scopedClassrooms.map((c) => c.id))
          const filtered: SyncPayload = {
            ...data,
            classrooms: scopedClassrooms,
            assignments: (withoutSchoolExamAssignments((data.assignments ?? []) as any, schoolCrIds) as any[]).filter(
              (a) => !a.classroomId || scopedClassIds.has(a.classroomId)
            ) as any,
            students: (data.students ?? []).filter((st) => !st.classroomId || scopedClassIds.has(st.classroomId))
          }
          setSyncData(filtered)
          setReportData(report)
        }
      } catch (err) {
        if (isActive) {
          setError(err instanceof Error ? err.message : '讀取資料失敗')
        }
      } finally {
        if (isActive) setLoading(false)
      }
    }

    void fetchData()
    return () => {
      isActive = false
    }
  }, [])

  useEffect(() => {
    if (!import.meta.env.DEV) return
    const win = window as typeof window & {
      __aiReportSanityCheck?: () => unknown
    }
    win.__aiReportSanityCheck = runSanityCheck
  }, [])

  const preparedSubmissions = useMemo<PreparedSubmission[]>(() => {
    if (!syncData) return []
    return syncData.submissions.map((submission) => {
      const grading = parseGradingResult(submission.gradingResult)
      const details = Array.isArray(grading?.details) ? grading?.details ?? [] : []
      const mistakes = Array.isArray(grading?.mistakes) ? grading?.mistakes ?? [] : []
      const weaknesses = Array.isArray(grading?.weaknesses)
        ? grading?.weaknesses ?? []
        : []
      const scoreValue = toNumber(submission.score)
      const totalScoreValue = toNumber(grading?.totalScore) ?? scoreValue
      const createdAtMs =
        toNumber(submission.createdAt) ??
        toNumber(submission.gradedAt) ??
        toNumber(submission.updatedAt)
      const blankStats = computeBlankStats(details)

      return {
        ...submission,
        grading,
        details,
        mistakes,
        weaknesses,
        scoreValue,
        totalScoreValue,
        createdAtMs,
        blankCount: blankStats.blankCount ?? undefined,
        totalQuestionCount: blankStats.totalQuestionCount ?? undefined
      }
    })
  }, [syncData])

  const classroomOptions = useMemo(
    () => syncData?.classrooms ?? [],
    [syncData]
  )

  // 2026-07-16 試題分析（純程式、user 拍板第一波）：選定作業的 answerKey 題目清單（Dexie）
  const [itemAnalysisQuestions, setItemAnalysisQuestions] = useState<ItemAnalysisQuestion[]>([])
  const [itemAnalysisTemplateId, setItemAnalysisTemplateId] = useState('')
  const [itemAnalysisKpTips, setItemAnalysisKpTips] = useState<Record<string, string>>({})  // 2026-07-19 知識點在家建議（answer_key.kpTips）
  const [kpReloadTick, setKpReloadTick] = useState(0)  // 2026-07-22 知識點歸類寫入後重載 questions（Dexie 已更新）
  useEffect(() => {
    if (!selectedAssignmentId) { setItemAnalysisQuestions([]); setItemAnalysisTemplateId(''); setItemAnalysisKpTips({}); return }
    db.assignments.get(selectedAssignmentId)
      .then((a) => {
        const ak = a?.answerKey as { questions?: ItemAnalysisQuestion[]; kpTips?: Record<string, string> } | undefined
        setItemAnalysisQuestions(Array.isArray(ak?.questions) ? ak!.questions! : [])
        setItemAnalysisTemplateId(a?.answerKeyTemplateId ?? '')
        setItemAnalysisKpTips(ak?.kpTips && typeof ak.kpTips === 'object' ? ak.kpTips : {})
      })
      .catch(() => { setItemAnalysisQuestions([]); setItemAnalysisTemplateId(''); setItemAnalysisKpTips({}) })
  }, [selectedAssignmentId, kpReloadTick])

  const itemAnalysisSubmissions = useMemo(
    () => localSubmissions.filter(
      (s) => s.assignmentId === selectedAssignmentId
        && s.gradingResult
        && s.source !== 'student_correction'
    ),
    [localSubmissions, selectedAssignmentId]
  )

  useEffect(() => {
    if (!classroomOptions.length) return
    if (
      selectedClassroomId &&
      classroomOptions.some((item) => item.id === selectedClassroomId)
    ) {
      return
    }
    setSelectedClassroomId(classroomOptions[0].id)
  }, [classroomOptions, selectedClassroomId])

  const classAssignments = useMemo(() => {
    if (!syncData) return []
    if (!selectedClassroomId) return syncData.assignments
    return syncData.assignments.filter(
      (assignment) => assignment.classroomId === selectedClassroomId
    )
  }, [syncData, selectedClassroomId])

  const classAssignmentIds = useMemo(
    () => new Set(classAssignments.map((assignment) => assignment.id)),
    [classAssignments]
  )

  // 從 IndexedDB 讀取批改詳情（sync API 不含 grading_result）
  // 2026-08-11 user 回報:補齊期間各 TAB 顯示「不足 3 份」誤導老師以為沒資料——
  //   加 detailsLoading 旗標,載入中各 TAB 改顯示載入卡、不顯示不足訊息。
  const [detailsLoading, setDetailsLoading] = useState(false)
  useEffect(() => {
    if (!classAssignmentIds.size) {
      setLocalSubmissions([])
      return
    }
    const ids = Array.from(classAssignmentIds)
    setDetailsLoading(true)
    // 2026-08-03 sync 瘦身:逐題 details 已不隨 sync 下來,學情報告/試題分析要先補齊
    void ensureAssignmentDetails(ids)
      .catch((err) => console.warn('[AiReport] 補齊批改詳情失敗:', err))
      .then(() => db.submissions.where('assignmentId').anyOf(ids).toArray())
      .then(setLocalSubmissions)
      .catch(() => setLocalSubmissions([]))
      .finally(() => setDetailsLoading(false))
  }, [classAssignmentIds])

  const classFilteredSubmissions = useMemo(() => {
    if (!selectedClassroomId) return preparedSubmissions
    if (!classAssignmentIds.size) return []
    return preparedSubmissions.filter(
      (submission) =>
        submission.assignmentId && classAssignmentIds.has(submission.assignmentId)
    )
  }, [classAssignmentIds, preparedSubmissions, selectedClassroomId])

  const classFilteredStudents = useMemo(() => {
    if (!syncData) return []
    if (!selectedClassroomId) return syncData.students
    return syncData.students.filter(
      (student) => student.classroomId === selectedClassroomId
    )
  }, [syncData, selectedClassroomId])

  const assignmentById = useMemo(() => {
    const map = new Map<string, SyncAssignment>()
    classAssignments.forEach((assignment) => {
      map.set(assignment.id, assignment)
    })
    return map
  }, [classAssignments])

  const domainAssignmentsInRange = classAssignments

  const domainAggregates = useMemo(() => {
    if (!syncData) return []
    return buildDomainAggregate(
      domainAssignmentsInRange,
      syncData.assignmentTags ?? []
    )
  }, [domainAssignmentsInRange, syncData])

  const domainPlans = useMemo(() => {
    return domainAggregates.map((aggregate) => {
      const plan = buildDomainPlan(aggregate, reportData?.tagAbilityMap)
      return plan
    })
  }, [domainAggregates, reportData?.tagAbilityMap])

  const domainRangeStats = useMemo(() => {
    let assignmentCount = 0
    let sampleCountTotal = 0
    domainPlans.forEach((plan) => {
      assignmentCount += plan.windowInfo.assignmentCount
      sampleCountTotal += plan.windowInfo.sampleCountTotal
    })
    return { assignmentCount, sampleCountTotal }
  }, [domainPlans])

  const domainPlansKey = useMemo(
    () =>
      domainPlans
        .map((plan) => `${plan.domainName}:${hashDomainPlanForCache(plan)}`)
        .join('|'),
    [domainPlans]
  )

  const domainDiagnosisCards = useMemo(
    () =>
      domainPlans.map((plan) => ({
        plan,
        diagnosis: domainDiagnoses[plan.domainName],
        loading: domainDiagnosisLoading[plan.domainName]
      })),
    [domainDiagnosisLoading, domainDiagnoses, domainPlans]
  )

  // 2026-08-11 概念雷達下鑽（user 拍板：摘要→細節）：點雷達上的課綱代碼 → 知識點×三階段分布頁
  const [conceptDrill, setConceptDrill] = useState<{ code: string; label: string } | null>(null)
  useEffect(() => { setConceptDrill(null) }, [selectedClassroomId, selectedDomain])

  // ── 2026-08-11 跨班比較（user 拍板：切換模式、匿名）──────────────────────────
  //   同卷全體＝答案卷血緣家族（分享碼複製品）＋同校閘的「匿名彙總」：只有總班數，
  //   無任何班級/作業名稱（無法推論資料來源）。三個視圖共用同一份資料：
  //   概念雷達疊圖、試題分析全體答對率欄、樣態分析全體分布。
  const [crossOn, setCrossOn] = useState(false)
  const [crossData, setCrossData] = useState<CrossCompare | null>(null)
  useEffect(() => {
    setCrossOn(false); setCrossData(null)
    if (!selectedAssignmentId) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/data/exam-compare', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ assignmentId: selectedAssignmentId }),
        })
        if (!res.ok) return
        const data = (await res.json().catch(() => null)) as CrossCompare | null
        // 只有 1 班（只有自己）＝沒東西好比 → 不顯示切換
        if (!cancelled && data && Number(data.classCount) >= 2) setCrossData(data)
      } catch { /* 離線/未部署 → 沒有跨班比較而已 */ }
    })()
    return () => { cancelled = true }
  }, [selectedAssignmentId])
  const crossRatioByCode = useMemo(() => {
    const out: Record<string, number> = {}
    for (const [code, s] of Object.entries(crossData?.byCode ?? {})) {
      if (s.total > 0) out[code] = (s.full + s.partial * 0.5) / s.total
    }
    return out
  }, [crossData])
  // 全體試題分析用:匿名作答向量→ItemAnalysisSubmissionLike 形狀(多班合併成一個母體、原元件整套重算)
  const crossSubmissions = useMemo(() =>
    (crossData?.responses ?? []).map((r) => ({
      gradingResult: {
        details: r.details.map((d) => ({
          questionId: d.q, score: d.s, maxScore: d.m ?? undefined, isCorrect: d.c, studentAnswer: d.v,
        })),
      },
    })),
    [crossData])
  // 下鑽頁的資料範圍必須與雷達一致：2026-09-06 雷達改「選了單一作業就只算那份」(conceptMasteryData)，
  //   但這裡漏跟改→下鑽頁把同領域其他作業也混進來(如選了 1 人 100% 的卷、卻冒出別份 n=32 待加強)。補上選定作業過濾。
  const conceptDrillAssignments = useMemo(() =>
    (selectedAssignmentId
      ? classAssignments.filter((a) => a.id === selectedAssignmentId)
      : classAssignments.filter((a) => !selectedDomain || selectedDomain === '全部' || normalizeDomain(a.domain) === selectedDomain)
    ).map((a) => assignmentById.get(a.id) ?? a),
    [classAssignments, selectedDomain, selectedAssignmentId, assignmentById])

  const conceptMasteryData = useMemo(() => {
    // 2026-09-06 修：選了特定作業就只算那份（不管跨班開沒開）——否則同領域多份作業(含不同題目、
    //   不同學生數)會被混算，一份 100 分的卷也會因混進別份而出現各概念高低不一的假雷達。
    //   沒選特定作業(整體檢視)才按領域收全部。跨班比較同樣只比選定的那份考卷。
    const filteredAssignments = selectedAssignmentId
      ? classAssignments.filter((a) => a.id === selectedAssignmentId)
      : classAssignments.filter((a) =>
          !selectedDomain || selectedDomain === '全部' || normalizeDomain(a.domain) === selectedDomain
        )
    const filteredIds = new Set(filteredAssignments.map((a) => a.id))

    // Build per-assignment map: questionId → {code, label}
    // 舊制=conceptTags（作業設定直傳路徑產生、帶完整課綱條文 label）；
    // 2026-08-11 新制 fallback=answerKey analysis.code（KP 建卷/建模板預跑產生）——
    //   模板流程（考卷）沒有 conceptTags，沒這條 fallback 雷達整片空。label 用 topic 白話短名。
    type QConceptMap = Map<string, { code: string; label: string }>
    const assignmentConceptMaps = new Map<string, QConceptMap>()
    for (const a of filteredAssignments) {
      const full = assignmentById.get(a.id)
      const conceptTags = full?.conceptTags
      const qMap: QConceptMap = new Map()
      if (conceptTags && typeof conceptTags === 'object') {
        for (const [qId, tag] of Object.entries(conceptTags)) {
          if (!tag?.code) continue
          qMap.set(qId, { code: tag.code, label: tag.label ?? tag.code })
        }
      }
      const rawAk = full?.answerKey
      const parsedAk = typeof rawAk === 'string' ? (() => { try { return JSON.parse(rawAk) } catch { return null } })() : rawAk
      for (const q of ((parsedAk as { questions?: Array<{ id?: unknown; analysis?: { code?: string; topic?: string } }> } | null)?.questions ?? [])) {
        const qid = String(q?.id ?? '')
        const code = q?.analysis?.code
        if (!qid || !code || qMap.has(qid)) continue
        qMap.set(qid, { code, label: q.analysis?.topic || code })
      }
      assignmentConceptMaps.set(a.id, qMap)
    }

    // Accumulate per-student per-concept stats
    const studentConceptMap = new Map<
      string,
      Map<string, { full: number; partial: number; wrong: number; total: number }>
    >()
    const allConcepts = new Map<string, string>() // code → label

    // Diagnostic counters per assignment
    const assignmentGradedCounts = new Map<string, number>()
    const assignmentMatchedIds = new Map<string, Set<string>>()

    for (const sub of localSubmissions) {
      if (!filteredIds.has(sub.assignmentId)) continue
      const details = sub.gradingResult?.details ?? []
      if (details.length > 0) {
        assignmentGradedCounts.set(sub.assignmentId, (assignmentGradedCounts.get(sub.assignmentId) ?? 0) + 1)
      }
      if (!sub.studentId) continue
      const qMap = assignmentConceptMaps.get(sub.assignmentId)
      if (!qMap || qMap.size === 0) continue

      for (const detail of details) {
        if (!detail.questionId) continue
        // 優先用批改時凍結的 conceptCode，找不到才 fallback 到 conceptTags join
        const concept = (detail.conceptCode && detail.conceptLabel)
          ? { code: detail.conceptCode, label: detail.conceptLabel }
          : qMap.get(detail.questionId)
        if (!concept) continue
        allConcepts.set(concept.code, concept.label)
        if (!assignmentMatchedIds.has(sub.assignmentId)) {
          assignmentMatchedIds.set(sub.assignmentId, new Set())
        }
        assignmentMatchedIds.get(sub.assignmentId)!.add(detail.questionId)

        if (!studentConceptMap.has(sub.studentId)) {
          studentConceptMap.set(sub.studentId, new Map())
        }
        const cMap = studentConceptMap.get(sub.studentId)!
        if (!cMap.has(concept.code)) {
          cMap.set(concept.code, { full: 0, partial: 0, wrong: 0, total: 0 })
        }
        const entry = cMap.get(concept.code)!
        entry.total++
        const score = toNumber(detail.score) ?? 0
        const maxScoreRaw = toNumber(detail.maxScore)
        const maxScore = maxScoreRaw !== null && maxScoreRaw > 0 ? maxScoreRaw : null

        const isFull = detail.isCorrect === true || (maxScore !== null && score >= maxScore)
        const isPartial =
          !isFull && maxScore !== null && score > 0 && score < maxScore

        if (isFull) {
          entry.full++
        } else if (isPartial) {
          entry.partial++
        } else {
          entry.wrong++
        }
      }
    }

    const concepts: ConceptEntry[] = Array.from(allConcepts.entries())
      .map(([code, label]) => ({ code, label }))
      .sort((a, b) => a.code.localeCompare(b.code))

    const students: StudentMastery[] = classFilteredStudents
      .filter((s) => studentConceptMap.has(s.id))
      .map((s) => ({
        studentId: s.id,
        studentName: s.name ?? '學生',
        seatNumber: s.seatNumber,
        concepts: Object.fromEntries(Array.from(studentConceptMap.get(s.id)!.entries()))
      }))
      .sort((a, b) => (a.seatNumber ?? 999) - (b.seatNumber ?? 999))

    // Diagnostic info for empty state（withCode＝conceptTags∪analysis.code 聯集，與聚合實際用的一致）
    const debugInfo = filteredAssignments.map((a) => {
      const full = assignmentById.get(a.id)
      const raw = full?.answerKey
      const parsed = typeof raw === 'string' ? (() => { try { return JSON.parse(raw) } catch { return null } })() : raw
      const questions = (parsed as { questions?: unknown[] } | null)?.questions ?? []
      const withCode = assignmentConceptMaps.get(a.id)?.size ?? 0
      const gradedCount = assignmentGradedCounts.get(a.id) ?? 0
      const matchedCount = assignmentMatchedIds.get(a.id)?.size ?? 0
      return { title: a.title ?? a.id, total: questions.length, withCode, gradedCount, matchedCount }
    })

    return { students, concepts, debugInfo }
  }, [classAssignments, selectedDomain, localSubmissions, classFilteredStudents, assignmentById, crossOn, crossData, selectedAssignmentId])


  const assignmentMeta = useMemo(() => {
    if (!syncData) return []
    const items = classAssignments.map((assignment) => {
      const subs = classFilteredSubmissions.filter(
        (submission) => submission.assignmentId === assignment.id
      )
      const latestFromSubs = subs.reduce((latest, item) => {
        const value = item.createdAtMs ?? 0
        return value > latest ? value : latest
      }, 0)
      const lastActivity = Math.max(assignment.updatedAt ?? 0, latestFromSubs)
      return {
        assignment,
        submissions: subs,
        lastActivity,
        totalCount: subs.length,
        gradedCount: subs.filter((item) => isGraded(item)).length
      }
    })

    items.sort((a, b) => b.lastActivity - a.lastActivity)
    return items.map((item, index) => ({
      ...item,
      shortLabel: `作業 ${String.fromCharCode(65 + index)}`
    }))
  }, [classAssignments, classFilteredSubmissions, syncData])

  const domainOptions = useMemo(() => {
    const seen = new Map<string, string>()
    assignmentMeta.forEach((item) => {
      const domain = normalizeDomain(item.assignment.domain)
      if (!seen.has(domain)) seen.set(domain, domain)
    })
    return Array.from(seen.keys())
  }, [assignmentMeta])

  useEffect(() => {
    if (!domainOptions.length) return
    if (selectedDomain && domainOptions.includes(selectedDomain)) return
    setSelectedDomain(domainOptions[0])
  }, [domainOptions, selectedDomain])

  const filteredAssignmentMeta = useMemo(() => {
    if (!selectedDomain) return assignmentMeta
    return assignmentMeta.filter(
      (item) => normalizeDomain(item.assignment.domain) === selectedDomain
    )
  }, [assignmentMeta, selectedDomain])

  useEffect(() => {
    if (!filteredAssignmentMeta.length) return
    if (selectedAssignmentId) {
      const exists = filteredAssignmentMeta.some(
        (item) => item.assignment.id === selectedAssignmentId
      )
      if (exists) return
    }
    setSelectedAssignmentId(filteredAssignmentMeta[0].assignment.id)
  }, [filteredAssignmentMeta, selectedAssignmentId])

  useEffect(() => {
    let isActive = true

    // 2026-07-20 領域診斷性快報退役：停用「每次開學情報告就自動跑 LLM 領域診斷」（純浪費點數，多數老師不看）。
    //   保留下方結構、之後要恢復把 DOMAIN_DIAGNOSIS_DISABLED 設 false 即可。
    const DOMAIN_DIAGNOSIS_DISABLED: boolean = true
    if (DOMAIN_DIAGNOSIS_DISABLED || !domainPlans.length) {
      if (isActive) {
        setDomainDiagnoses({})
        setDomainDiagnosisLoading({})
      }
      return () => {
        isActive = false
      }
    }

    const loadingMap: Record<string, boolean> = {}
    domainPlans.forEach((plan) => {
      loadingMap[plan.domainName] = true
    })
    setDomainDiagnoses({})
    setDomainDiagnosisLoading(loadingMap)

    const run = async () => {
      for (const plan of domainPlans) {
        const result = await generateDomainDiagnosisWithLLM(plan)
        if (!isActive) return
        setDomainDiagnoses((prev) => ({
          ...prev,
          [plan.domainName]: result.diagnosis
        }))
        setDomainDiagnosisLoading((prev) => ({
          ...prev,
          [plan.domainName]: false
        }))
      }
    }

    void run()
    return () => {
      isActive = false
    }
  // domainDiagnosisRegenCounter 在 dependency list：點重生按鈕後遞增 → 觸發 useEffect 重跑
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domainPlansKey, domainDiagnosisRegenCounter])

  const classHeader = useMemo(() => {
    if (!syncData) return { classroomName: '班級', domainLabel: '學情摘要' }
    const classroomName = selectedClassroomId
      ? syncData.classrooms.find((item) => item.id === selectedClassroomId)?.name ??
        '班級'
      : '班級'
    const domainLabel = selectedDomain ? `${selectedDomain}學情摘要` : '學情摘要'
    return { classroomName, domainLabel }
  }, [syncData, selectedClassroomId, selectedDomain])

  const pageTitleText = useMemo(
    () => `${classHeader.classroomName} · ${classHeader.domainLabel}`,
    [classHeader.classroomName, classHeader.domainLabel]
  )

  const pageTitleFontSize = useMemo(() => {
    const titleLength = pageTitleText.length
    if (titleLength <= 16) return '1.75rem'
    if (titleLength <= 24) return '1.55rem'
    if (titleLength <= 32) return '1.4rem'
    if (titleLength <= 40) return '1.26rem'
    return '1.16rem'
  }, [pageTitleText])

  const selectedClassroomName = useMemo(() => {
    if (!selectedClassroomId) return ''
    return (
      syncData?.classrooms.find((item) => item.id === selectedClassroomId)?.name ??
      ''
    )
  }, [selectedClassroomId, syncData?.classrooms])

  const selectedAssignmentLabel = useMemo(() => {
    const item = filteredAssignmentMeta.find(
      (meta) => meta.assignment.id === selectedAssignmentId
    )
    if (!item) return ''
    return `${getAssignmentTitle(item.assignment)} · ${formatDate(item.lastActivity)}`
  }, [filteredAssignmentMeta, selectedAssignmentId])

  const summaryRange = useMemo(() => {
    const dates = classFilteredSubmissions
      .map((submission) => submission.createdAtMs)
      .filter((value): value is number => typeof value === 'number')
      .sort((a, b) => a - b)
    if (!dates.length) return '--'
    return `${formatDate(dates[0])}–${formatDate(dates[dates.length - 1])}`
  }, [classFilteredSubmissions])

  const totalAiFailures = useMemo(
    () =>
      classFilteredSubmissions.filter((submission) => isAiFailure(submission.grading))
        .length,
    [classFilteredSubmissions]
  )

  // ── 檢討單下載（2026-08-12 從訂正頁移植到考試總覽;與行政端同一條 reviewSheetPdf 管線）──
  const [reviewSheetBusy, setReviewSheetBusy] = useState(false)
  const [reviewSheetProgress, setReviewSheetProgress] = useState<{ done: number; total: number } | null>(null)
  const [reviewSheetMsg, setReviewSheetMsg] = useState('')
  const handleDownloadReviewSheet = async () => {
    if (reviewSheetBusy || !selectedAssignmentId) return
    setReviewSheetBusy(true); setReviewSheetMsg(''); setReviewSheetProgress(null)
    try {
      const r = await downloadClassReviewSheetPdf(selectedAssignmentId, {
        onProgress: (_phase, done, total) => setReviewSheetProgress({ done, total }),
      })
      setReviewSheetMsg(`✅ 已下載全班檢討單（${r.students} 位）${r.failed > 0 ? `、${r.failed} 位失敗略過` : ''}`)
    } catch (e) {
      setReviewSheetMsg(e instanceof Error ? e.message : '產生檢討單失敗，請再試一次')
    } finally {
      setReviewSheetBusy(false); setReviewSheetProgress(null)
    }
  }
  useEffect(() => { setReviewSheetMsg('') }, [selectedAssignmentId])

  // 補齊逐題資料期間的載入卡（各 TAB 共用；取代誤導的「不足 3 份」訊息）
  const detailsLoadingCard = (
    <section className="card" style={{ color: '#64748b', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
      <span className="inline-block w-4 h-4 rounded-full border-2 border-slate-300 border-t-sky-500 animate-spin" />
      正在載入批改資料…（首次進入需要幾秒鐘）
    </section>
  )

  if (loading) {
    return (
      <div className={`ai-report${embedded ? ' embedded' : ''}`}>
        <main className="report">
          <header className="page-header">
            <div>
              <div className="eyebrow">{pageEyebrow}</div>
              <h1>資料載入中</h1>
              <p className="subtitle">正在取得最新作業資料。</p>
            </div>
          </header>
          <section className="card">請稍候…</section>
        </main>
      </div>
    )
  }

  if (error) {
    return (
      <div className={`ai-report${embedded ? ' embedded' : ''}`}>
        <main className="report">
          <header className="page-header">
            <div>
              <div className="eyebrow">{pageEyebrow}</div>
              <h1>資料讀取失敗</h1>
              <p className="subtitle">{error}</p>
            </div>
            {!embedded && (
              <div className="header-actions">
                <button className="btn" type="button" onClick={onBack}>
                  返回首頁
                </button>
              </div>
            )}
          </header>
        </main>
      </div>
    )
  }

  return (
    <div className={`ai-report${embedded ? ' embedded' : ''}`}>
      <main className="report">
        <header className="page-header">
          <div className="page-header-main">
            <div className="eyebrow">{pageEyebrow}</div>
            <h1
              className="page-title"
              style={{ fontSize: pageTitleFontSize }}
              title={pageTitleText}
            >
              {pageTitleText}
            </h1>
            <p className="subtitle">
              資料區間：{summaryRange} · 作業 {assignmentMeta.length} 份 · 批改{' '}
              {classFilteredSubmissions.length} 份（含 {totalAiFailures} 筆系統錯誤）
            </p>
          </div>
          <div className="header-actions">
            {classroomOptions.length > 0 && (
              <label className="header-filter">
                班級
                <select
                  value={selectedClassroomId}
                  title={selectedClassroomName || undefined}
                  onChange={(event) => setSelectedClassroomId(event.target.value)}
                >
                  <ClassroomSelectOptions classrooms={classroomOptions} />
                </select>
              </label>
            )}
            {!embedded && (
              <button className="btn" type="button" onClick={onBack}>
                返回首頁
              </button>
            )}
          </div>
        </header>

        {/* Tab bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 mb-6">
          <div className="flex">
            {/* 2026-08-12 資訊架構二修(user 拍板、對齊教學影片三階段情境):
                檢討考卷=考試總覽(含檢討單下載)+樣態分析;後續追蹤=試題分析+概念雷達+家長報告。
                2026-07-20 三個「診斷性快報」退役;面板碼保留但無入口。 */}
            {(isTrack
              ? ([
                  { id: 'items', label: '試題分析' },
                  { id: 'student', label: '概念雷達' },
                  { id: 'parent', label: '家長報告' },
                ] as const)
              : ([
                  { id: 'overview', label: '考卷總覽' },
                  { id: 'patterns', label: '樣態分析' },
                ] as const)
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap ${
                  activeTab === tab.id
                    ? 'border-gray-900 text-gray-900'
                    : 'border-transparent text-slate-500 hover:text-slate-700'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="summary-controls tab-filters pb-3">
            <label>
              領域
              <select
                value={selectedDomain}
                title={selectedDomain || undefined}
                onChange={(event) => setSelectedDomain(event.target.value)}
                disabled={!domainOptions.length}
              >
                {domainOptions.map((domain) => (
                  <option key={domain} value={domain}>
                    {domain}
                  </option>
                ))}
              </select>
            </label>
            {(activeTab === 'class' || activeTab === 'overview' || activeTab === 'items' || activeTab === 'patterns' || activeTab === 'parent' || activeTab === 'student') && (
              <label>
                作業
                <select
                  value={selectedAssignmentId}
                  title={selectedAssignmentLabel || undefined}
                  onChange={(event) => setSelectedAssignmentId(event.target.value)}
                  disabled={!filteredAssignmentMeta.length}
                >
                  {filteredAssignmentMeta.map((item) => (
                    <option key={item.assignment.id} value={item.assignment.id}>
                      {getAssignmentTitle(item.assignment)} ·{' '}
                      {formatDate(item.lastActivity)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </div>

        {/* Tab panels */}
        <div className="grid gap-6">
          {activeTab === 'class' && (
            <section>
              <AssignmentSummaryPanel
                data={assignmentSummary as Parameters<typeof AssignmentSummaryPanel>[0]['data']}
                loading={assignmentSummaryLoading}
                onRetry={() => requestInk(handleRetryAssignmentSummary)}
                isStale={Boolean(
                  latestGradedAt &&
                  assignmentSummary?.updated_at &&
                  new Date(latestGradedAt) > new Date(assignmentSummary.updated_at)
                )}
              />
            </section>
          )}

          {/* 2026-07-16 考試總覽（原作業總覽）：純程式即時、零墨水。
              2026-08-12 user 拍板:檢討單下載從訂正頁移植到這裡（檢討課情境的第一步） */}
          {activeTab === 'overview' && (
            <section>
              {itemAnalysisQuestions.length > 0 && itemAnalysisSubmissions.length >= 3 ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      onClick={() => void handleDownloadReviewSheet()}
                      disabled={reviewSheetBusy}
                      title="全班已批改者人人一份(全題+裁圖+正解、低信心黃框、簽名欄),整班合併一份 PDF 直接列印"
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6,
                        padding: '6px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: reviewSheetBusy ? 'not-allowed' : 'pointer',
                        border: '1px solid #cbd5e1', background: '#fff', color: '#334155', opacity: reviewSheetBusy ? 0.6 : 1,
                      }}
                    >
                      🖨 {reviewSheetBusy
                        ? `檢討單產生中${reviewSheetProgress ? ` ${reviewSheetProgress.done}/${reviewSheetProgress.total}` : '…'}`
                        : '下載檢討單'}
                    </button>
                    {reviewSheetMsg && <span style={{ fontSize: 12, color: reviewSheetMsg.startsWith('✅') ? '#15803d' : '#b91c1c' }}>{reviewSheetMsg}</span>}
                  </div>
                  <AssignmentOverviewSection
                    questions={itemAnalysisQuestions}
                    submissions={itemAnalysisSubmissions}
                    assignmentId={selectedAssignmentId}
                    domain={assignmentById.get(selectedAssignmentId)?.domain ?? ''}
                    templateId={itemAnalysisTemplateId}
                    requestInk={requestInk}
                  />
                </>
              ) : detailsLoading ? detailsLoadingCard : (
                <section className="card" style={{ color: '#64748b', fontSize: 13 }}>
                  {itemAnalysisSubmissions.length < 3
                    ? '此作業已批改的卷數不足 3 份，暫無法統計。'
                    : '請先選擇一份有答案卷的作業。'}
                </section>
              )}
            </section>
          )}

          {/* 2026-07-16 試題分析獨立 tab（user 拍板）：純程式即時、零墨水 */}
          {activeTab === 'items' && (
            <section>
              {itemAnalysisQuestions.length > 0 && itemAnalysisSubmissions.length >= 3 ? (
                <>
                  {crossData && (
                    <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <CrossToggle on={crossOn} onToggle={() => setCrossOn((v) => !v)} classCount={crossData.classCount} />
                      {crossOn && (
                        <span style={{ fontSize: 11.5, color: '#94a3b8' }}>
                          全體試題分析：同卷 {crossData.classCount} 班合併成一個母體重算（P／鑑別度／高低分組／α；匿名、不顯示班級來源）
                        </span>
                      )}
                    </div>
                  )}
                  {/* 2026-08-11 user 拍板:跨班=「多班統整的試卷分析」不是逐題比較欄——
                      同一個分析元件、換成全體匿名作答向量整套重算 */}
                  <ItemAnalysisSection
                    questions={itemAnalysisQuestions}
                    submissions={crossOn && crossData && crossSubmissions.length >= 3 ? crossSubmissions : itemAnalysisSubmissions}
                    domain={assignmentById.get(selectedAssignmentId)?.domain ?? ''}
                  />
                </>
              ) : detailsLoading ? detailsLoadingCard : (
                <section className="card" style={{ color: '#64748b', fontSize: 13 }}>
                  {itemAnalysisSubmissions.length < 3
                    ? '此作業已批改的卷數不足 3 份，暫無法進行試題分析。'
                    : '請先選擇一份有答案卷的作業。'}
                </section>
              )}
            </section>
          )}

          {/* 2026-08-11 樣態分析(user 拍板):課堂逐題檢討用、零 AI、答案聚合+批改理由直出;
              取代原「AI 歸納錯誤樣態」按鈕(已拔) */}
          {activeTab === 'patterns' && (
            <section>
              {itemAnalysisSubmissions.length > 0 ? (
                <>
                  {crossData && (
                    <div style={{ marginBottom: 8 }}>
                      <CrossToggle on={crossOn} onToggle={() => setCrossOn((v) => !v)} classCount={crossData.classCount} />
                    </div>
                  )}
                  <AnswerPatternsTab
                    questions={itemAnalysisQuestions}
                    submissions={itemAnalysisSubmissions as any}
                    students={syncData?.students ?? []}
                    cross={crossOn && crossData ? { classCount: crossData.classCount, answers: crossData.answers } : undefined}
                  />
                </>
              ) : detailsLoading ? detailsLoadingCard : (
                <section className="card" style={{ color: '#64748b', fontSize: 13 }}>
                  請先選擇一份已批改的作業。
                </section>
              )}
            </section>
          )}

          {activeTab === 'parent' && (
            <section>
              {itemAnalysisQuestions.length > 0 && itemAnalysisSubmissions.length >= 3 ? (
                <ParentReportTab
                  questions={itemAnalysisQuestions}
                  submissions={itemAnalysisSubmissions}
                  students={classFilteredStudents}
                  kpTips={itemAnalysisKpTips}
                  assignmentId={selectedAssignmentId}
                  className={selectedClassroomName}
                  subject={assignmentById.get(selectedAssignmentId)?.domain ?? ''}
                  assignmentTitle={(() => {
                    const a = assignmentById.get(selectedAssignmentId)
                    return a ? getAssignmentTitle(a) : ''
                  })()}
                  onOpenPreferences={() => { window.location.href = '/preferences' }}
                  headerOverride={
                    reportBrand?.configured
                      ? { schoolName: reportBrand.schoolName, crestDataUrl: reportBrand.crestDataUrl || undefined }
                      : undefined
                  }
                  fallbackTeacherName={reportBrand?.viewerName}
                  requestInk={requestInk}
                  onKpSaved={() => setKpReloadTick((t) => t + 1)}
                  grade={(syncData?.classrooms.find((c) => c.id === selectedClassroomId) as { grade?: number } | undefined)?.grade}
                />
              ) : detailsLoading ? detailsLoadingCard : (
                <section className="card" style={{ color: '#64748b', fontSize: 13 }}>
                  {itemAnalysisSubmissions.length < 3
                    ? '此作業已批改的卷數不足 3 份，暫無法產生家長報告。'
                    : '請先選擇一份有答案卷的作業。'}
                </section>
              )}
            </section>
          )}

          {activeTab === 'domain' && (
            <section style={{ minWidth: 0 }}>
              {domainRangeStats.assignmentCount < 2 && domainRangeStats.assignmentCount > 0 && (
                <section className="card domain-note">
                  樣本較少，趨勢判讀先以參考為主。
                </section>
              )}
              {domainRangeStats.assignmentCount > 0 && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '8px' }}>
                    <button
                      type="button"
                      onClick={() => requestInk(() => {
                        setDomainDiagnoses({})
                        setDomainDiagnosisRegenCounter((c) => c + 1)
                      })}
                      disabled={Object.values(domainDiagnosisLoading).some(Boolean)}
                      style={{
                        padding: '6px 12px',
                        fontSize: '12px',
                        background: '#f1f5f9',
                        border: '1px solid #cbd5e1',
                        borderRadius: '6px',
                        cursor: Object.values(domainDiagnosisLoading).some(Boolean) ? 'not-allowed' : 'pointer',
                        opacity: Object.values(domainDiagnosisLoading).some(Boolean) ? 0.5 : 1,
                      }}
                      title="補題本後或想刷新分析時用"
                    >
                      🔄 重生領域診斷
                    </button>
                  </div>
                  <DomainDiagnosisView
                    cards={domainDiagnosisCards}
                    emptyState="此班級尚無作業可分析。"
                  />
                </>
              )}
              <ConceptMasteryTable
                students={conceptMasteryData.students}
                concepts={conceptMasteryData.concepts}
                debugInfo={conceptMasteryData.debugInfo}
              />
            </section>
          )}

          {activeTab === 'student' && (
            <section>
              {conceptDrill ? (
                // 下鑽頁（細節）：知識點×三階段班級分布長條圖
                // （2026-08-11 user 三修：學生知識點狀況面板整個取消——長條圖 hover 名單已涵蓋）
                <ConceptDrillDown
                  code={conceptDrill.code}
                  label={conceptDrill.label}
                  assignments={conceptDrillAssignments as never}
                  submissions={localSubmissions as never}
                  students={classFilteredStudents as never}
                  onBack={() => setConceptDrill(null)}
                />
              ) : (
                // 摘要：班級雷達（點課綱代碼進細節）；跨班比較=切換疊圖（匿名、只在雷達上顯示）
                <>
                  {/* 2026-09-06 舊卷/未升級節點的作業 → 雷達旁直接補跑知識點歸類（原本只在家長報告頁）。
                      條件：選了單一作業、有題目、還沒有第二層 nodeId；且該領域有節點層或整卷根本沒 KP。 */}
                  {(() => {
                    const kpQs = itemAnalysisQuestions
                    if (!selectedAssignmentId || kpQs.length === 0) return null
                    const domain = assignmentById.get(selectedAssignmentId)?.domain ?? ''
                    const hasAnyKp = kpQs.some((q) => (q as { analysis?: { topic?: string } }).analysis?.topic)
                    const hasAnyNode = kpQs.some((q) => (q as { analysis?: { nodeId?: string } }).analysis?.nodeId)
                    const nodeApplicable = /數學|數|國語|國文|社會|地理|歷史|公民|自然|生物|理化|物理|化學|地球科學|地科/.test(domain)
                    if (hasAnyNode || !(!hasAnyKp || nodeApplicable)) return null
                    const kpGrade = (syncData?.classrooms.find((c) => c.id === selectedClassroomId) as { grade?: number } | undefined)?.grade
                    return (
                      <KpBackfillCard
                        assignmentId={selectedAssignmentId}
                        subject={domain}
                        questions={kpQs as never}
                        grade={kpGrade}
                        requestInk={requestInk}
                        onSaved={() => setKpReloadTick((t) => t + 1)}
                        hint={hasAnyKp
                          ? '這份作業可升級為「知識節點」分類，讓雷達與加強地圖更精準（一次性、全班共用）。'
                          : '這份作業還沒有知識點歸類（舊卷）——概念雷達會是空的。'}
                        ctaLabel={hasAnyKp ? '升級為知識節點' : '補跑知識點歸類'}
                      />
                    )
                  })()}
                  {crossData && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
                      <CrossToggle on={crossOn} onToggle={() => setCrossOn((v) => !v)} classCount={crossData.classCount} />
                      {crossOn && (
                        <span style={{ fontSize: 11.5, color: '#94a3b8' }}>
                          比較範圍＝選定作業・同卷 {crossData.classCount} 班匿名彙總（不顯示班級來源）
                        </span>
                      )}
                    </div>
                  )}
                  <ConceptRadarChart
                    students={conceptMasteryData.students}
                    concepts={conceptMasteryData.concepts}
                    debugInfo={conceptMasteryData.debugInfo}
                    onSelectCode={(code, label) => setConceptDrill({ code, label })}
                    overlay={crossOn && crossData ? { label: `同卷全體(${crossData.classCount}班)`, byCode: crossRatioByCode } : undefined}
                  />
                </>
              )}
            </section>
          )}
        </div>

        <div className="footnote">
          以上分析僅依 AI 批改輸出進行聚合，未含題目內容。建議搭配教師觀察補充判斷。
        </div>
      </main>

      {/* 2026-06-01: 產生/重生報告墨水同意框 */}
      <InkConfirmModal
        open={!!inkAction}
        warning="產生 AI 報告會消耗墨水（點數）"
        onCancel={() => setInkAction(null)}
        onConfirm={() => { const fn = inkAction?.fn; setInkAction(null); fn?.() }}
      >
        {inkAction?.message ?? '即將用 AI 產生這份學情報告。'}
      </InkConfirmModal>
    </div>
  )
}
