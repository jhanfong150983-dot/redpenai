import { useCallback, useEffect, useMemo, useState } from 'react'
import { db } from '@/lib/db'
import { ensureAssignmentDetails } from '@/lib/submission-details'
import type { Submission } from '@/lib/db'
import AssignmentSummaryPanel from './ai-report/components/AssignmentSummaryPanel'
import ItemAnalysisSection from './ai-report/components/ItemAnalysisSection'
import AnswerPatternsTab from './ai-report/components/AnswerPatternsTab'
import { withoutSchoolExamClassrooms, withoutSchoolExamAssignments, schoolExamClassroomIds } from '@/lib/school-exam'
import { ParentReportTab } from './ai-report/components/ParentReportTab'
import AssignmentOverviewSection from './ai-report/components/AssignmentOverviewSection'
import type { ItemAnalysisQuestion } from './ai-report/item-analysis'
import ConceptMasteryTable from './ai-report/components/ConceptMasteryTable'
import type { StudentMastery, ConceptEntry } from './ai-report/components/ConceptMasteryTable'
import ConceptRadarChart from './ai-report/components/ConceptRadarChart'
import ConceptDrillDown from './ai-report/components/ConceptDrillDown'
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
}

export default function AiReport({ onBack, embedded }: AiReportProps) {
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
  const [activeTab, setActiveTab] = useState<'overview' | 'class' | 'items' | 'patterns' | 'parent' | 'domain' | 'student'>('overview')
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
          const filtered: SyncPayload = {
            ...data,
            classrooms: withoutSchoolExamClassrooms(data.classrooms ?? []),
            assignments: withoutSchoolExamAssignments((data.assignments ?? []) as any, schoolCrIds) as any,
            students: (data.students ?? []).filter((st) => !st.classroomId || !schoolCrIds.has(st.classroomId))
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
  useEffect(() => {
    if (!classAssignmentIds.size) {
      setLocalSubmissions([])
      return
    }
    const ids = Array.from(classAssignmentIds)
    // 2026-08-03 sync 瘦身:逐題 details 已不隨 sync 下來,學情報告/試題分析要先補齊
    void ensureAssignmentDetails(ids)
      .catch((err) => console.warn('[AiReport] 補齊批改詳情失敗:', err))
      .then(() => db.submissions.where('assignmentId').anyOf(ids).toArray())
      .then(setLocalSubmissions)
      .catch(() => setLocalSubmissions([]))
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
  // 下鑽頁的資料範圍與雷達一致（同一組 domain 過濾、取完整 assignment 物件拿 conceptTags/answerKey）
  const conceptDrillAssignments = useMemo(() =>
    classAssignments
      .filter((a) => !selectedDomain || selectedDomain === '全部' || normalizeDomain(a.domain) === selectedDomain)
      .map((a) => assignmentById.get(a.id) ?? a),
    [classAssignments, selectedDomain, assignmentById])

  const conceptMasteryData = useMemo(() => {
    const filteredAssignments = classAssignments.filter((a) =>
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
  }, [classAssignments, selectedDomain, localSubmissions, classFilteredStudents, assignmentById])


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

  if (loading) {
    return (
      <div className={`ai-report${embedded ? ' embedded' : ''}`}>
        <main className="report">
          <header className="page-header">
            <div>
              <div className="eyebrow">AI學情報告</div>
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
              <div className="eyebrow">AI學情報告</div>
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
            <div className="eyebrow">AI學情報告</div>
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
                  {classroomOptions.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name ?? '未命名班級'}
                    </option>
                  ))}
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
            {([
              { id: 'overview', label: '作業總覽' },
              { id: 'items', label: '試題分析' },
              { id: 'patterns', label: '樣態分析' },
              // 2026-08-11 user 拍板:退役的 student 診斷性快報復活為「概念雷達」——
              //   課綱雷達(既有)+學生知識點面板(主題趨勢跨卷/單卷 KP 地圖,吃建卷預跑的 KP)
              { id: 'student', label: '概念雷達' },
              { id: 'parent', label: '家長報告' },
              // 2026-07-20 三個「診斷性快報」退役（user：沒特別作用、且會浪費 AI 點數）。
              //   面板碼保留但無入口＝不可達；領域診斷的自動 LLM 另在下方 useEffect 停用。要恢復把下面三行取消註解即可。
              // { id: 'class', label: '作業診斷性快報' },
              // { id: 'domain', label: '領域診斷性快報' },
              // { id: 'student', label: '班級診斷性快報' },
            ] as const).map((tab) => (
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

          {/* 2026-07-16 作業總覽（user 拍板資料層重構）：純程式即時、零墨水 */}
          {activeTab === 'overview' && (
            <section>
              {itemAnalysisQuestions.length > 0 && itemAnalysisSubmissions.length >= 3 ? (
                <AssignmentOverviewSection
                  questions={itemAnalysisQuestions}
                  submissions={itemAnalysisSubmissions}
                  assignmentId={selectedAssignmentId}
                  domain={assignmentById.get(selectedAssignmentId)?.domain ?? ''}
                  templateId={itemAnalysisTemplateId}
                  requestInk={requestInk}
                />
              ) : (
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
                <ItemAnalysisSection
                  questions={itemAnalysisQuestions}
                  submissions={itemAnalysisSubmissions}
                  domain={assignmentById.get(selectedAssignmentId)?.domain ?? ''}
                />
              ) : (
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
                <AnswerPatternsTab
                  questions={itemAnalysisQuestions}
                  submissions={itemAnalysisSubmissions as any}
                  students={syncData?.students ?? []}
                />
              ) : (
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
              ) : (
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
                // 摘要：只有班級雷達（點課綱代碼進細節）
                <ConceptRadarChart
                  students={conceptMasteryData.students}
                  concepts={conceptMasteryData.concepts}
                  debugInfo={conceptMasteryData.debugInfo}
                  onSelectCode={(code, label) => setConceptDrill({ code, label })}
                />
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
