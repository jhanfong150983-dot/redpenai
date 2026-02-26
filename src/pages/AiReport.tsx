import { useEffect, useMemo, useState } from 'react'
import SummaryPanel from './ai-report/components/SummaryPanel'
import TagLevelsPanel from './ai-report/components/TagLevelsPanel'
import CompletionPanel from './ai-report/components/CompletionPanel'
import StudentListTabs from './ai-report/components/StudentListTabs'
import TimeRangeFilter from './ai-report/components/TimeRangeFilter'
import DomainDiagnosisView from './ai-report/components/DomainDiagnosisView'
import {
  buildActionSummary,
  buildCompletionSummary,
  buildStudentRiskSummary,
  buildTagLevels,
  runSanityCheck
} from './ai-report/compute'
import {
  buildDomainAggregate,
  buildDomainPlan,
  buildTimeRange,
  filterAssignmentsByRange,
  generateDomainDiagnosisWithLLM,
  hashDomainPlanForCache
} from './ai-report/domain-diagnosis'
import {
  buildInstructionPlan,
  generateTeacherSummaryWithLLM,
  hashTagsForCache,
  readTeacherSummaryCache,
  writeTeacherSummaryCache,
  type TeacherSummaryResult
} from './ai-report/teacher-summary'
import type {
  AssignmentTagReport,
  DomainDiagnosis,
  StudentBase,
  Submission as ReportSubmission,
  TimeRangePreset
} from './ai-report/types'
import './AiReport.css'

type SyncAssignment = {
  id: string
  classroomId?: string
  title?: string
  domain?: string
  createdAt?: string | number
  updatedAt?: number
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

type SummarySuggestion = {
  label: string
  text: string
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

type StudentPeriod = {
  assignmentId: string
  label: string
  lastAt: number | null
  tags: TagStat[]
}

type StudentProfile = {
  id: string
  name: string
  seatNumber?: number | null
  submissions: PreparedSubmission[]
  avgRatio: number | null
  totalScore: number
  totalPossible: number
  tagStats: TagStat[]
  topTags: TagStat[]
  attentionCount: number
  status: 'good' | 'warn' | 'risk'
  statusLabel: string
  statusHint: string
  periods: StudentPeriod[]
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

function formatPercent(value: number, digits = 1) {
  const percent = Math.max(0, Math.min(100, value * 100))
  return `${percent.toFixed(digits)}%`
}

function formatRangeLabel(start: string, end: string) {
  if (!start && !end) return '全期'
  const startLabel = start ? start.replace(/-/g, '/') : '不限'
  const endLabel = end ? end.replace(/-/g, '/') : '不限'
  return `${startLabel}–${endLabel}`
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

function extractIssues(submission: PreparedSubmission) {
  if (submission.mistakes.length > 0) {
    return submission.mistakes
      .map((item) => [item.reason, item.question].filter(Boolean).join(' '))
      .filter((text) => text.trim().length > 0)
  }
  if (submission.weaknesses.length > 0) {
    return submission.weaknesses
  }
  return []
}

function tagFromIssue(issue: string) {
  const text = issue.trim()
  if (!text) return null
  if (/未作答|空白/.test(text)) return '未作答'
  if (/單位/.test(text)) return '單位漏寫'
  if (/小數點|位值/.test(text)) return '小數點位值'
  if (/半徑|直徑/.test(text)) return '半徑辨識'
  if (/弧長/.test(text)) return '弧長公式'
  if (/周長/.test(text)) return '周長加總'
  if (/比例尺/.test(text)) return '比例尺換算'
  if (/票價|敬老票|兒童票|成人票/.test(text)) return '票價條件'
  if (/審題|題意|條件/.test(text)) return '審題不清'
  if (/表達|答句|格式|敘述/.test(text)) return '作答表達'
  if (/計算|運算/.test(text)) return '計算錯誤'
  if (/公式/.test(text)) return '公式使用'
  if (/圖形|幾何/.test(text)) return '圖形概念'
  return text
}

function mapIssueToTag(
  issue: string,
  mapTag?: (tag: string) => string | null
) {
  const text = issue.trim()
  if (!text) return null
  if (mapTag) {
    const mapped = mapTag(text)
    if (mapped) return mapped
  }
  const fallback = tagFromIssue(text)
  if (!fallback) return null
  if (!mapTag) return fallback
  return mapTag(fallback) ?? fallback
}

function normalizeLabel(value: string) {
  return value.trim().replace(/\s+/g, '').toLowerCase()
}

function buildLabelTokens(label: string) {
  const cleaned = label.replace(/[\\s,，。.;；:：!?！？、]/g, '')
  if (!cleaned) return []
  if (cleaned.length <= 2) return [cleaned]
  const tokens = new Set<string>()
  for (let i = 0; i < cleaned.length - 1; i += 1) {
    tokens.add(cleaned.slice(i, i + 2))
  }
  return Array.from(tokens)
}

function collectSubmissionTags(
  submission: PreparedSubmission,
  mapTag?: (tag: string) => string | null
) {
  const issues = extractIssues(submission)
  const tags = new Set<string>()
  issues.forEach((issue) => {
    const mapped = mapIssueToTag(issue, mapTag)
    if (mapped) tags.add(mapped)
  })
  return Array.from(tags)
}

function buildTriRadarPoints(values: number[]) {
  const center = { x: 160, y: 160 }
  const axes = [
    { x: 160, y: 50 },
    { x: 260, y: 230 },
    { x: 60, y: 230 }
  ]
  const points = axes.map((axis, index) => {
    const ratio = Math.max(0, Math.min(1, values[index] ?? 0))
    const x = center.x + (axis.x - center.x) * ratio
    const y = center.y + (axis.y - center.y) * ratio
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  return points.join(' ')
}

function buildStudentProfiles(
  submissions: PreparedSubmission[],
  students: SyncStudent[],
  assignmentById: Map<string, SyncAssignment>,
  mapTag?: (tag: string) => string | null
) {
  const studentMap = new Map<string, StudentProfile>()
  students.forEach((student) => {
    studentMap.set(student.id, {
      id: student.id,
      name: student.name ?? '未命名學生',
      seatNumber: student.seatNumber ?? null,
      submissions: [],
      avgRatio: null,
      totalScore: 0,
      totalPossible: 0,
      tagStats: [],
      topTags: [],
      attentionCount: 0,
      status: 'good',
      statusLabel: '穩定',
      statusHint: '作答穩定，未見明顯弱點。',
      periods: []
    })
  })

  submissions.forEach((submission) => {
    if (!submission.studentId) return
    if (!studentMap.has(submission.studentId)) {
      studentMap.set(submission.studentId, {
        id: submission.studentId,
        name: '未命名學生',
        seatNumber: null,
        submissions: [],
        avgRatio: null,
        totalScore: 0,
        totalPossible: 0,
        tagStats: [],
        topTags: [],
        attentionCount: 0,
        status: 'good',
        statusLabel: '穩定',
        statusHint: '作答穩定，未見明顯弱點。',
        periods: []
      })
    }
    studentMap.get(submission.studentId)?.submissions.push(submission)
  })

  studentMap.forEach((profile) => {
    const tagMap = new Map<string, number>()
    const periodMap = new Map<
      string,
      { label: string; lastAt: number | null; tags: Map<string, number> }
    >()

    profile.submissions.forEach((submission) => {
      const scoreValue = submission.scoreValue
      const totalScoreValue = submission.totalScoreValue
      if (scoreValue !== null && totalScoreValue !== null) {
        profile.totalScore += scoreValue
        profile.totalPossible += totalScoreValue
      }

      if (isNeedsAttention(submission)) profile.attentionCount += 1

      const rawTags = collectSubmissionTags(submission, mapTag)
      rawTags.forEach((tag) => {
        tagMap.set(tag, (tagMap.get(tag) ?? 0) + 1)
      })

      const assignmentId = submission.assignmentId || 'unknown'
      if (!periodMap.has(assignmentId)) {
        const assignment = assignmentById.get(assignmentId)
        const label = assignment ? getAssignmentTitle(assignment) : '未命名作業'
        periodMap.set(assignmentId, {
          label,
          lastAt: submission.createdAtMs ?? null,
          tags: new Map()
        })
      }
      const period = periodMap.get(assignmentId)
      if (period) {
        if ((submission.createdAtMs ?? 0) > (period.lastAt ?? 0)) {
          period.lastAt = submission.createdAtMs ?? null
        }
        rawTags.forEach((tag) => {
          period.tags.set(tag, (period.tags.get(tag) ?? 0) + 1)
        })
      }
    })

    profile.avgRatio =
      profile.totalPossible > 0 ? profile.totalScore / profile.totalPossible : null

    if (profile.submissions.length === 0) {
      profile.status = 'risk'
      profile.statusLabel = '資料不足'
      profile.statusHint = '尚未取得作業資料。'
    } else if (profile.avgRatio !== null && profile.avgRatio < 0.6) {
      profile.status = 'risk'
      profile.statusLabel = '需關注'
      profile.statusHint = '近期分數偏低，錯誤集中。'
    } else if (
      profile.avgRatio !== null &&
      (profile.avgRatio < 0.75 || profile.attentionCount >= 2)
    ) {
      profile.status = 'warn'
      profile.statusLabel = '留意'
      profile.statusHint = '錯誤類型偏多，需追蹤。'
    } else {
      profile.status = 'good'
      profile.statusLabel = '穩定'
      profile.statusHint = '作答穩定，未見明顯弱點。'
    }

    profile.tagStats = Array.from(tagMap.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count)

    profile.topTags = profile.tagStats.slice(0, 3)

    profile.periods = Array.from(periodMap.entries())
      .map(([assignmentId, period]) => ({
        assignmentId,
        label: period.label,
        lastAt: period.lastAt,
        tags: Array.from(period.tags.entries())
          .map(([label, count]) => ({ label, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 3)
      }))
      .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))
  })

  return Array.from(studentMap.values()).sort((a, b) => {
    if (a.seatNumber === null && b.seatNumber === null) return 0
    if (a.seatNumber === null) return 1
    if (b.seatNumber === null) return -1
    return (a.seatNumber ?? 0) - (b.seatNumber ?? 0)
  })
}

function collectIssueTagCounts(
  submission: PreparedSubmission,
  mapTag: (tag: string) => string | null
) {
  const issues = extractIssues(submission)
  const counts = new Map<string, number>()
  issues.forEach((issue) => {
    const mapped = mapIssueToTag(issue, mapTag)
    if (!mapped) return
    counts.set(mapped, (counts.get(mapped) ?? 0) + 1)
  })
  return counts
}

function getTopThreshold(values: number[], ratio: number) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => b - a)
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1)
  return sorted[index] ?? null
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

function isNeedsAttention(submission: PreparedSubmission) {
  if (isAiFailure(submission.grading)) return true
  const ratio =
    submission.totalScoreValue && submission.scoreValue
      ? submission.scoreValue / submission.totalScoreValue
      : null
  if (ratio !== null) return ratio < 0.7
  if (submission.scoreValue !== null) return submission.scoreValue < 60
  return submission.mistakes.length >= 2
}


type AiReportProps = {
  onBack: () => void
}

export default function AiReport({ onBack }: AiReportProps) {
  const [syncData, setSyncData] = useState<SyncPayload | null>(null)
  const [reportData, setReportData] = useState<ReportPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [teacherSummary, setTeacherSummary] = useState<TeacherSummaryResult | null>(null)
  const [teacherSummaryLoading, setTeacherSummaryLoading] = useState(false)
  const [selectedClassroomId, setSelectedClassroomId] = useState('')
  const [selectedAssignmentId, setSelectedAssignmentId] = useState('')
  const [selectedDomain, setSelectedDomain] = useState('')
  const [rangeStart, setRangeStart] = useState('')
  const [rangeEnd, setRangeEnd] = useState('')
  const [domainRangePreset, setDomainRangePreset] =
    useState<TimeRangePreset>('30d')
  const [domainRangeStart, setDomainRangeStart] = useState('')
  const [domainRangeEnd, setDomainRangeEnd] = useState('')
  const [domainDiagnoses, setDomainDiagnoses] = useState<
    Record<string, DomainDiagnosis | null>
  >({})
  const [domainDiagnosisLoading, setDomainDiagnosisLoading] = useState<
    Record<string, boolean>
  >({})

  const resetRange = () => {
    setRangeStart('')
    setRangeEnd('')
  }

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
          setSyncData(data)
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

  const rangeBounds = useMemo(() => {
    const from = rangeStart ? Date.parse(`${rangeStart}T00:00:00`) : null
    const to = rangeEnd ? Date.parse(`${rangeEnd}T23:59:59`) : null
    return {
      from: Number.isFinite(from) ? from : null,
      to: Number.isFinite(to) ? to : null
    }
  }, [rangeStart, rangeEnd])

  const rangeLabel = useMemo(
    () => formatRangeLabel(rangeStart, rangeEnd),
    [rangeStart, rangeEnd]
  )

  const domainRange = useMemo(
    () => buildTimeRange(domainRangePreset, domainRangeStart, domainRangeEnd),
    [domainRangeEnd, domainRangePreset, domainRangeStart]
  )

  const domainAssignmentsInRange = useMemo(() => {
    return filterAssignmentsByRange(classAssignments, domainRange)
  }, [classAssignments, domainRange])

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
      plan.windowInfo.startDate = domainRange.startLabel
      plan.windowInfo.endDate = domainRange.endLabel
      return plan
    })
  }, [
    domainAggregates,
    reportData?.tagAbilityMap,
    domainRange.endLabel,
    domainRange.startLabel
  ])

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

  const rangeFilteredSubmissions = useMemo(() => {
    if (!rangeBounds.from && !rangeBounds.to) return classFilteredSubmissions
    return classFilteredSubmissions.filter((submission) => {
      const value = submission.createdAtMs ?? 0
      if (rangeBounds.from && value < rangeBounds.from) return false
      if (rangeBounds.to && value > rangeBounds.to) return false
      return true
    })
  }, [classFilteredSubmissions, rangeBounds])

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

  const selectedAssignment = filteredAssignmentMeta.find(
    (item) => item.assignment.id === selectedAssignmentId
  )

  const activeSubmissions = selectedAssignment?.submissions ?? []

  const tagDictionaryLookup = useMemo(() => {
    const map = new Map<string, string>()
    reportData?.dictionary?.forEach((item) => {
      if (item.status && item.status !== 'active') return
      const canonical =
        item.merged_to_label || item.label || item.normalized_label
      if (!canonical) return
      if (item.normalized_label) {
        map.set(normalizeLabel(item.normalized_label), canonical)
      }
      if (item.label) {
        map.set(normalizeLabel(item.label), canonical)
      }
    })
    return map
  }, [reportData])

  const tagDictionaryMatchers = useMemo(() => {
    const rows = reportData?.dictionary ?? []
    return rows
      .filter((item) => !item.status || item.status === 'active')
      .map((item) => {
        const label =
          item.merged_to_label || item.label || item.normalized_label || ''
        return {
          label,
          tokens: buildLabelTokens(label)
        }
      })
      .filter((item) => item.label && item.tokens.length > 0)
  }, [reportData])

  const mapTagToDictionary = (tag: string) => {
    const mapped = tagDictionaryLookup.get(normalizeLabel(tag))
    if (mapped) return mapped
    if (!tagDictionaryMatchers.length) return tag
    const haystack = tag.replace(/\s+/g, '')
    let bestLabel: string | null = null
    let bestScore = 0
    let bestTokenCount = 0
    tagDictionaryMatchers.forEach((matcher) => {
      let score = matcher.tokens.reduce((count, token) => {
        return haystack.includes(token) ? count + 1 : count
      }, 0)
      if (matcher.label && haystack.includes(matcher.label)) {
        score += matcher.tokens.length
      }
      if (score >= 1) {
        if (
          score > bestScore ||
          (score === bestScore && matcher.tokens.length > bestTokenCount)
        ) {
          bestScore = score
          bestTokenCount = matcher.tokens.length
          bestLabel = matcher.label
        }
      }
    })
    return bestLabel
  }

  const assignmentStudents = useMemo<StudentBase[]>(() => {
    const scoreMap = new Map<string, { total: number; count: number }>()

    activeSubmissions.forEach((submission) => {
      if (!submission.studentId) return
      const scoreValue = submission.scoreValue
      if (scoreValue === null || scoreValue === undefined) return
      if (!scoreMap.has(submission.studentId)) {
        scoreMap.set(submission.studentId, { total: 0, count: 0 })
      }
      const entry = scoreMap.get(submission.studentId)
      if (!entry) return
      entry.total += scoreValue
      entry.count += 1
    })

    return classFilteredStudents.map((student) => {
      const entry = scoreMap.get(student.id)
      const avgScore = entry && entry.count > 0 ? entry.total / entry.count : null
      return {
        id: student.id,
        name: student.name ?? '未命名學生',
        seatNumber: student.seatNumber ?? null,
        avgScore
      }
    })
  }, [activeSubmissions, classFilteredStudents])

  const assignmentRiskSubmissions = useMemo<ReportSubmission[]>(() => {
    return activeSubmissions.map((submission) => {
      const extras = submission as PreparedSubmission & {
        tagCounts?: Record<string, number>
        blankCount?: number
        totalQuestionCount?: number
      }
      const counts = collectIssueTagCounts(submission, mapTagToDictionary)
      const tagCounts =
        counts.size > 0 ? Object.fromEntries(counts.entries()) : undefined
      return {
        id: submission.id,
        assignmentId: submission.assignmentId,
        studentId: submission.studentId,
        score: submission.scoreValue ?? submission.score,
        gradingResult: submission.gradingResult,
        parsedGradingResult: submission.grading,
        tagCounts: tagCounts ?? extras.tagCounts,
        blankCount: extras.blankCount,
        totalQuestionCount: extras.totalQuestionCount
      }
    })
  }, [activeSubmissions, mapTagToDictionary])

  const assignmentRiskSummary = useMemo(
    () => buildStudentRiskSummary(assignmentStudents, assignmentRiskSubmissions),
    [assignmentStudents, assignmentRiskSubmissions]
  )

const assignmentTagInfo = useMemo(() => {
    if (!syncData || !selectedAssignmentId) return null
    return (
      syncData.assignmentTags?.find(
        (item) => item.assignmentId === selectedAssignmentId
      ) ?? null
    )
  }, [syncData, selectedAssignmentId])

  const assignmentReport = useMemo<AssignmentTagReport | null>(() => {
    if (!selectedAssignmentId) return null
    return {
      assignmentId: selectedAssignmentId,
      sampleCount: assignmentTagInfo?.sampleCount ?? activeSubmissions.length ?? 0,
      tags: assignmentTagInfo?.tags ?? [],
      source: assignmentTagInfo?.source,
      status: assignmentTagInfo?.status,
      lastGeneratedAt: assignmentTagInfo?.lastGeneratedAt
    }
  }, [activeSubmissions.length, assignmentTagInfo, selectedAssignmentId])

  const assignmentActionSummary = useMemo(
    () => buildActionSummary(assignmentReport, assignmentRiskSummary),
    [assignmentReport, assignmentRiskSummary]
  )

  const teacherSummaryPlan = useMemo(
    () => buildInstructionPlan(assignmentReport),
    [assignmentReport]
  )

  const teacherSummaryCacheKey = useMemo(() => {
    if (!assignmentReport?.assignmentId) return null
    return `${assignmentReport.assignmentId}:${hashTagsForCache(assignmentReport)}`
  }, [assignmentReport])

  const assignmentTagLevels = useMemo(
    () => buildTagLevels(assignmentReport),
    [assignmentReport]
  )

  const assignmentCompletionSummary = useMemo(
    () => buildCompletionSummary(assignmentRiskSubmissions),
    [assignmentRiskSubmissions]
  )

  const tagAbilityLookup = useMemo(() => {
    const map = new Map<string, string>()
    reportData?.tagAbilityMap?.forEach((item) => {
      if (!item.tag || !item.ability) return
      map.set(normalizeLabel(item.tag), item.ability)
    })
    return map
  }, [reportData])

  const assignmentTagMap = useMemo(() => {
    const map = new Map<string, AssignmentTagSummary>()
    syncData?.assignmentTags?.forEach((item) => {
      if (!item.assignmentId) return
      map.set(item.assignmentId, item)
    })
    return map
  }, [syncData])

  const abilityStats = useMemo(() => {
    const abilityMap = new Map<
      string,
      { label: string; totalCount: number; assignments: Set<string>; domains: Set<string> }
    >()

    assignmentMeta.forEach((item) => {
      const info = assignmentTagMap.get(item.assignment.id)
      const sampleCount = info?.sampleCount ?? item.gradedCount
      if (sampleCount < 5) return
      const tags = info?.tags ?? []
      tags.forEach((tag) => {
        const ability = tagAbilityLookup.get(normalizeLabel(tag.label))
        if (!ability) return
        const key = normalizeLabel(ability)
        if (!abilityMap.has(key)) {
          abilityMap.set(key, {
            label: ability,
            totalCount: 0,
            assignments: new Set(),
            domains: new Set()
          })
        }
        const entry = abilityMap.get(key)
        if (!entry) return
        entry.totalCount += tag.count
        entry.assignments.add(item.assignment.id)
        entry.domains.add(normalizeDomain(item.assignment.domain))
      })
    })

    return Array.from(abilityMap.entries())
      .map(([id, entry]) => ({
        id,
        label: entry.label,
        totalCount: entry.totalCount,
        assignmentCount: entry.assignments.size,
        domainCount: entry.domains.size
      }))
      .sort((a, b) => b.totalCount - a.totalCount)
  }, [assignmentMeta, assignmentTagMap, tagAbilityLookup])
  const abilityTop = abilityStats.slice(0, 3)
  const abilityMax = Math.max(abilityTop[0]?.totalCount ?? 0, 1)
  const abilityRatios = abilityTop.map((item) =>
    abilityMax > 0 ? item.totalCount / abilityMax : 0
  )
  const abilityRadarPoints = buildTriRadarPoints(abilityRatios)

  const abilityStudentProfiles = useMemo(() => {
    if (!syncData) return []
    const mapTag = (tag: string) => {
      const canonical = mapTagToDictionary(tag)
      if (!canonical) return null
      return tagAbilityLookup.get(normalizeLabel(canonical)) || '其他能力'
    }
    return buildStudentProfiles(
      rangeFilteredSubmissions,
      classFilteredStudents,
      assignmentById,
      mapTag
    )
  }, [
    assignmentById,
    classFilteredStudents,
    rangeFilteredSubmissions,
    syncData,
    tagAbilityLookup,
    mapTagToDictionary
  ])

  const abilityDisplayProfiles = useMemo(() => {
    if (!abilityStudentProfiles.length) return abilityStudentProfiles
    const metrics = abilityStudentProfiles.map((profile) => {
      const abilityMap = new Map<
        string,
        { count: number; domains: Set<string> }
      >()

      profile.submissions.forEach((submission) => {
        const assignmentId = submission.assignmentId
        const assignment = assignmentId ? assignmentById.get(assignmentId) : null
        const domain = normalizeDomain(assignment?.domain)
        const issues = extractIssues(submission)
        issues.forEach((issue) => {
          const canonical = mapIssueToTag(issue, mapTagToDictionary)
          if (!canonical) return
          const ability =
            tagAbilityLookup.get(normalizeLabel(canonical)) || null
          if (!ability) return
          const key = normalizeLabel(ability)
          if (!abilityMap.has(key)) {
            abilityMap.set(key, { count: 0, domains: new Set() })
          }
          const entry = abilityMap.get(key)
          if (!entry) return
          entry.count += 1
          if (domain) entry.domains.add(domain)
        })
      })

      const abilityTotal = Array.from(abilityMap.values()).reduce(
        (sum, item) => sum + item.count,
        0
      )
      const crossDomain = Array.from(abilityMap.values()).some(
        (item) => item.domains.size >= 2
      )

      return {
        id: profile.id,
        abilityTotal,
        crossDomain
      }
    })

    const metricById = new Map(metrics.map((item) => [item.id, item]))
    const threshold = getTopThreshold(
      metrics.map((item) => item.abilityTotal),
      0.2
    )
    const hasThreshold = typeof threshold === 'number' && threshold > 0

    return abilityStudentProfiles.map((profile): StudentProfile => {
      const metric = metricById.get(profile.id)
      if (!metric || profile.submissions.length === 0) {
        return {
          ...profile,
          status: 'risk' as const,
          statusLabel: '資料不足',
          statusHint: '尚未取得跨領域作業資料。'
        }
      }

      const { abilityTotal, crossDomain } = metric
      const isTop = hasThreshold && abilityTotal >= (threshold ?? 0)

      if (crossDomain) {
        return {
          ...profile,
          status: 'risk' as const,
          statusLabel: '需關注',
          statusHint: '同一能力在多領域反覆出現，需追蹤。'
        }
      }

      if (isTop) {
        return {
          ...profile,
          status: 'warn' as const,
          statusLabel: '留意',
          statusHint: '能力標籤數落在班級前段，建議觀察。'
        }
      }

      return {
        ...profile,
        status: 'good' as const,
        statusLabel: '穩定',
        statusHint: '跨領域表現穩定。'
      }
    })
  }, [
    abilityStudentProfiles,
    assignmentById,
    mapTagToDictionary,
    tagAbilityLookup
  ])

  const assignmentSampleCount = assignmentReport?.sampleCount ?? 0
  const hasInsufficientSamples =
    assignmentTagInfo?.status === 'insufficient_samples' || assignmentSampleCount < 5

  useEffect(() => {
    let isActive = true

    const run = async () => {
      if (!teacherSummaryPlan || !teacherSummaryCacheKey) {
        if (isActive) setTeacherSummary(null)
        if (isActive) setTeacherSummaryLoading(false)
        return
      }

      if (hasInsufficientSamples || !assignmentReport?.tags?.length) {
        if (isActive) setTeacherSummary(null)
        if (isActive) setTeacherSummaryLoading(false)
        return
      }

      const cached = await readTeacherSummaryCache(teacherSummaryCacheKey)
      if (!isActive) return
      if (cached?.bullets?.length) {
        setTeacherSummary({
          bullets: cached.bullets,
          remedy: cached.remedy,
          source: 'cache'
        })
        setTeacherSummaryLoading(false)
        return
      }

      setTeacherSummaryLoading(true)
      const result = await generateTeacherSummaryWithLLM(
        teacherSummaryPlan,
        assignmentActionSummary.lines
      )
      if (!isActive) return
      setTeacherSummary(result)
      setTeacherSummaryLoading(false)
      if (result.source === 'llm') {
        await writeTeacherSummaryCache(
          teacherSummaryCacheKey,
          teacherSummaryPlan.assignmentId,
          result.bullets,
          result.remedy
        )
      }
    }

    void run()
    return () => {
      isActive = false
    }
  }, [
    assignmentActionSummary.lines,
    assignmentReport?.tags?.length,
    hasInsufficientSamples,
    teacherSummaryCacheKey,
    teacherSummaryPlan
  ])

  useEffect(() => {
    let isActive = true

    if (!domainPlans.length) {
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
  }, [domainPlansKey])

  const summaryTagLabels = useMemo(() => {
    return assignmentActionSummary.topTags
      .map((tag) => tag.label)
      .filter(Boolean)
  }, [assignmentActionSummary.topTags])

  const summarySuggestions = useMemo<SummarySuggestion[]>(() => {
    if (teacherSummaryLoading) return []
    if (!summaryTagLabels.length) return []
    const bullets =
      teacherSummary?.source && teacherSummary.source !== 'fallback'
        ? teacherSummary.bullets
        : []
    const used = new Set<number>()
    return summaryTagLabels.map((label, index) => {
      let bullet = ''
      if (bullets.length) {
        const matchIndex = bullets.findIndex(
          (line, lineIndex) =>
            !used.has(lineIndex) && line.includes(label)
        )
        if (matchIndex >= 0) {
          bullet = bullets[matchIndex]
          used.add(matchIndex)
        } else {
          const fallbackIndex = bullets.findIndex(
            (_line, lineIndex) => !used.has(lineIndex)
          )
          if (fallbackIndex >= 0) {
            bullet = bullets[fallbackIndex]
            used.add(fallbackIndex)
          }
        }
      }

      if (!bullet) {
        const tag = assignmentReport?.tags?.find((item) => item.label === label)
        const example = tag?.examples?.[0]?.trim()
        const verb = ['重畫', '標示', '對照', '口頭提問', '小測'][index % 5]
        bullet = example
          ? `請先以「${example}」示範「${label}」相關的${verb}步驟，並請學生口頭說明關鍵條件。`
          : `請先針對「${label}」示範${verb}流程，並以口頭提問確認概念。`
      } else {
        const cleaned = bullet.trim().replace(/^[，,、:：\s]+/, '')
        bullet = cleaned.includes(label) ? cleaned : `針對「${label}」，${cleaned}`
      }

      return { label, text: bullet }
    })
  }, [assignmentReport?.tags, summaryTagLabels, teacherSummary, teacherSummaryLoading])

  const summaryRemedy = useMemo(() => {
    if (teacherSummaryLoading) return ''
    if (teacherSummary?.remedy) return teacherSummary.remedy
    return ''
  }, [teacherSummary, teacherSummaryLoading])

  const summaryStudents = useMemo(() => {
    return assignmentRiskSummary.hasRiskData
      ? assignmentRiskSummary.riskStudentNames
      : []
  }, [assignmentRiskSummary])

  const summaryStudentNote = useMemo(() => {
    if (!assignmentRiskSummary.hasRiskData) {
      return '尚無學生層級風險資料。'
    }
    if (!assignmentRiskSummary.riskStudentNames.length) {
      return '目前無需特別關注學生。'
    }
    return ''
  }, [assignmentRiskSummary])

  const abilityRiskStudents = abilityDisplayProfiles.filter(
    (profile) => profile.status !== 'good'
  )

  const classHeader = useMemo(() => {
    if (!syncData) return { classroomName: '班級', domainLabel: '學情摘要' }
    const classroomName = selectedClassroomId
      ? syncData.classrooms.find((item) => item.id === selectedClassroomId)?.name ??
        '班級'
      : '班級'
    const domainLabel = selectedDomain ? `${selectedDomain}學情摘要` : '學情摘要'
    return { classroomName, domainLabel }
  }, [syncData, selectedClassroomId, selectedDomain])

  const summaryRange = useMemo(() => {
    const dates = classFilteredSubmissions
      .map((submission) => submission.createdAtMs)
      .filter((value): value is number => typeof value === 'number')
      .sort((a, b) => a - b)
    if (!dates.length) return '--'
    return `${formatDate(dates[0])}–${formatDate(dates[dates.length - 1])}`
  }, [classFilteredSubmissions])

  const abilityRadarLabels = [
    abilityTop[0]?.label ?? '能力A',
    abilityTop[1]?.label ?? '能力B',
    abilityTop[2]?.label ?? '能力C'
  ]
  const abilityMaxCount = Math.max(
    ...abilityStats.map((item) => item.totalCount),
    1
  )
  const abilityTopCards = abilityStats.slice(0, 6)

  const totalAiFailures = useMemo(
    () =>
      classFilteredSubmissions.filter((submission) => isAiFailure(submission.grading))
        .length,
    [classFilteredSubmissions]
  )

  const renderStudentCard = (profile: StudentProfile, scope: string) => {
    const cardId = `${scope}-${profile.id}`
    const cardClass =
      profile.status === 'risk'
        ? 'student-card is-risk'
        : profile.status === 'warn'
          ? 'student-card is-warn'
          : 'student-card'
    const avgLabel = profile.avgRatio !== null ? formatPercent(profile.avgRatio, 0) : '--'
    const metaParts = [`座號 ${profile.seatNumber ?? '--'}`]
    const metaText = metaParts.join(' · ')

    return (
      <div key={cardId} className={cardClass}>
        <div className="student-top">
          <div>
            <div className="student-name">{profile.name}</div>
            <div className="student-meta">{metaText}</div>
          </div>
          <div className="student-score">
            {avgLabel}
            <span>平均</span>
          </div>
        </div>
        <div className="student-tags">
          {profile.topTags.length === 0 && (
            <span className="tag-chip good">表現穩定</span>
          )}
          {profile.topTags.map((tag) => (
            <span key={`${cardId}-${tag.label}`} className="tag-chip neutral">
              {tag.label} · {tag.count}
            </span>
          ))}
        </div>
        <div className="student-meta">{profile.statusHint}</div>
        <div className="student-bottom">
          <span
            className={`pill ${
              profile.status === 'risk'
                ? 'risk'
                : profile.status === 'warn'
                  ? 'warn'
                  : 'good'
            }`}
          >
            {profile.statusLabel}
          </span>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="ai-report">
        <main className="report">
          <header className="page-header">
            <div>
              <div className="eyebrow">AI學情報告</div>
              <h1>資料載入中</h1>
              <p className="subtitle">正在取得最新作業資料。</p>
            </div>
          </header>
          <section className="card">請稍候...</section>
        </main>
      </div>
    )
  }

  if (error) {
    return (
      <div className="ai-report">
        <main className="report">
          <header className="page-header">
            <div>
              <div className="eyebrow">AI學情報告</div>
              <h1>資料讀取失敗</h1>
              <p className="subtitle">{error}</p>
            </div>
            <div className="header-actions">
              <button className="btn" type="button" onClick={onBack}>
                返回首頁
              </button>
            </div>
          </header>
        </main>
      </div>
    )
  }

  return (
    <div className="ai-report">
      <main className="report">
        <header className="page-header">
          <div>
            <div className="eyebrow">AI學情報告</div>
            <h1>
              {classHeader.classroomName} · {classHeader.domainLabel}
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
            <button className="btn" type="button" onClick={onBack}>
              返回首頁
            </button>
            <button className="btn" type="button">
              匯出 PDF
            </button>
          </div>
        </header>

        <div className="tab-shell">
          <input type="radio" name="report-tab" id="tab-class" defaultChecked />
          <input type="radio" name="report-tab" id="tab-domain" />
          <input type="radio" name="report-tab" id="tab-student" />
          <div className="tab-header">
            <div className="tab-controls">
              <label htmlFor="tab-class">作業診斷性快報</label>
              <label htmlFor="tab-domain">領域診斷性快報</label>
              <label htmlFor="tab-student">班級診斷性快報</label>
            </div>
            <div className="summary-controls tab-filters">
              <label>
                領域
                <select
                  value={selectedDomain}
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
              <label className="tab-filter-assignment">
                作業
                <select
                  value={selectedAssignmentId}
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
            </div>
          </div>
          <div className="tab-panels">
            <section className="tab-panel panel-class">
              <SummaryPanel
                tags={summaryTagLabels}
                suggestions={summarySuggestions}
                students={summaryStudents}
                studentNote={summaryStudentNote}
                loading={teacherSummaryLoading}
                remedy={summaryRemedy}
              />

              {hasInsufficientSamples ? (
                <section className="card">
                  作業批改份數不足 5 份，暫無法產出標籤。
                </section>
              ) : (
                <>
                  <div className="section-title">
                    <h2>錯誤標籤分層級</h2>
                    <span>依批改份數計算標籤比例</span>
                  </div>

                  <TagLevelsPanel
                    levels={assignmentTagLevels}
                    sampleCount={assignmentSampleCount}
                  />

                  <div className="section-title">
                    <h2>作業完成度</h2>
                    <span>獨立觀察空白題情況</span>
                  </div>

                  <CompletionPanel summary={assignmentCompletionSummary} />

                  <StudentListTabs summary={assignmentRiskSummary} />
                </>
              )}
            </section>

            <section className="tab-panel panel-domain">
              <TimeRangeFilter
                preset={domainRangePreset}
                startDate={domainRangeStart}
                endDate={domainRangeEnd}
                onPresetChange={setDomainRangePreset}
                onStartDateChange={setDomainRangeStart}
                onEndDateChange={setDomainRangeEnd}
                assignmentCount={domainRangeStats.assignmentCount}
                sampleCountTotal={domainRangeStats.sampleCountTotal}
                startLabel={domainRange.startLabel}
                endLabel={domainRange.endLabel}
              />

              {domainRangeStats.assignmentCount === 0 ? (
                <section className="card empty-state">
                  此期間沒有作業可分析，請調整時段。
                </section>
              ) : (
                <>
                  {domainRangeStats.assignmentCount < 2 && (
                    <section className="card domain-note">
                      樣本較少，趨勢判讀先以參考為主。
                    </section>
                  )}
                  <DomainDiagnosisView
                    cards={domainDiagnosisCards}
                    emptyState="此期間沒有作業可分析，請調整時段。"
                  />
                </>
              )}
            </section>

            <section className="tab-panel panel-student">
              <section className="hero">
                <div className="card hero-card">
                  <h3>班級診斷性快報</h3>
                  <div className="hero-list">
                    <div>跨領域能力標籤：{abilityStats.length} 類</div>
                    <div>需關注學生：{abilityRiskStudents.length} 人</div>
                    <div>個人化範圍：{rangeLabel}</div>
                  </div>
                </div>
                <div className="card hero-card">
                  <h3>統整觀察重點</h3>
                  <div className="hero-list">
                    <div>
                      {abilityTop.length
                        ? `主要弱點集中在「${abilityTop[0].label}」`
                        : '目前尚無能力標籤'}
                    </div>
                    <div>
                      常見能力：
                      {abilityTop.length
                        ? abilityTop.map((item) => item.label).join('、')
                        : '尚無資料'}
                    </div>
                    <div>作業覆蓋：{assignmentMeta.length} 份</div>
                  </div>
                </div>
              </section>

              <div className="section-title">
                <h2>統整性資料分析</h2>
                <span>跨領域能力弱點</span>
              </div>

              <section className="card trend-card">
                <h3>能力類型分布</h3>
                <div className="radar-wrap">
                  <div className="radar-stage">
                    <svg className="radar" viewBox="0 0 320 320" aria-label="能力類型雷達圖">
                      <g className="radar-grid">
                        <polygon points="160,50 260,230 60,230" />
                        <polygon points="160,94 220,202 100,202" />
                      </g>
                      <g>
                        <line className="radar-axis" x1="160" y1="160" x2="160" y2="50" />
                        <line className="radar-axis" x1="160" y1="160" x2="260" y2="230" />
                        <line className="radar-axis" x1="160" y1="160" x2="60" y2="230" />
                      </g>
                      <polygon className="radar-area class" points={abilityRadarPoints} />
                    </svg>
                    <div className="radar-label top">
                      {abilityRadarLabels[0]}
                      <br />
                      {abilityTop[0]?.totalCount ?? 0} 次
                    </div>
                    <div className="radar-label br">
                      {abilityRadarLabels[1]}
                      <br />
                      {abilityTop[1]?.totalCount ?? 0} 次
                    </div>
                    <div className="radar-label bl">
                      {abilityRadarLabels[2]}
                      <br />
                      {abilityTop[2]?.totalCount ?? 0} 次
                    </div>
                  </div>
                  <div className="legend">
                    <span>
                      <i style={{ background: '#2563eb' }} />
                      能力分布（相對比例）
                    </span>
                  </div>
                </div>
                <div className="trend-note">最高類型以 100% 參照呈現。</div>
              </section>

              <section className="abilities">
                {abilityTopCards.length === 0 && (
                  <div className="card">尚無跨領域能力標籤。</div>
                )}
                {abilityTopCards.map((item) => {
                  const ratio =
                    abilityMaxCount > 0 ? (item.totalCount / abilityMaxCount) * 100 : 0
                  return (
                    <div key={item.id} className="card">
                      <div className="ability__header">
                        <div>
                          <h3>{item.label}</h3>
                          <p>
                            覆蓋作業 {item.assignmentCount} · 覆蓋領域 {item.domainCount}
                          </p>
                        </div>
                        <span className="pill warn">{item.totalCount} 次</span>
                      </div>
                      <div className="progress">
                        <div className="progress__bar" style={{ width: `${ratio}%` }} />
                      </div>
                      <div className="ability__meta">以最高 {abilityMaxCount} 次為 100%</div>
                    </div>
                  )
                })}
              </section>

              <div className="section-title">
                <h2>個人化資料分析</h2>
                <span>
                  範圍：{rangeLabel} · 共 {abilityDisplayProfiles.length} 人 · 需關注{' '}
                  {abilityRiskStudents.length} 人
                </span>
              </div>

              <section className="card">
                <div className="range-controls">
                  <label>
                    開始日期
                    <input
                      type="date"
                      value={rangeStart}
                      onChange={(event) => setRangeStart(event.target.value)}
                    />
                  </label>
                  <label>
                    結束日期
                    <input
                      type="date"
                      value={rangeEnd}
                      onChange={(event) => setRangeEnd(event.target.value)}
                    />
                  </label>
                  <button className="btn" type="button" onClick={resetRange}>
                    重設範圍
                  </button>
                </div>
                <p className="subtitle">時間範圍只影響下方個人化追蹤。</p>
              </section>

              <section className="student-grid">
                {abilityDisplayProfiles.length === 0 && (
                  <div className="card">此範圍尚無學生資料。</div>
                )}
                {abilityDisplayProfiles.map((profile) =>
                  renderStudentCard(profile, 'ability')
                )}
              </section>
            </section>
          </div>
        </div>

        <div className="footnote">
          以上分析僅依 AI 批改輸出進行聚合，未含題目內容。建議搭配教師觀察補充判斷。
        </div>
      </main>
    </div>
  )
}
