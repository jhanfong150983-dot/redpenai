export type AssignmentTagStat = {
  label: string
  count: number
  examples?: string[]
}

export type AssignmentTagReport = {
  assignmentId: string
  sampleCount?: number
  tags: AssignmentTagStat[]
  source?: string
  status?: string
  lastGeneratedAt?: number
}

export type ParsedGradingResult = {
  details?: unknown[]
  mistakes?: unknown[]
  weaknesses?: string[]
  suggestions?: string[]
  feedback?: string[]
  totalScore?: number
}

export type Submission = {
  id: string
  assignmentId?: string
  studentId?: string
  score?: number | string | null
  gradingResult?: unknown
  parsedGradingResult?: ParsedGradingResult | null
  tagCounts?: Record<string, number>
  blankCount?: number
  totalQuestionCount?: number
}

export type StudentBase = {
  id: string
  name: string
  seatNumber?: number | null
  avgScore?: number | null
}

export type StudentRiskFlags = {
  conceptRisk?: boolean
  completionRisk?: boolean
  multiErrorRisk?: boolean
}

export type StudentRiskStudent = StudentBase & {
  riskFlags?: StudentRiskFlags
  hasRisk?: boolean
  tagCounts?: Record<string, number>
  uniqueTagCount?: number | null
  blankRate?: number | null
}

export type StudentRiskSummary = {
  hasRiskData: boolean
  riskCount: number | null
  riskStudentNames: string[]
  students: StudentRiskStudent[]
}

export type ActionSummary = {
  lines: string[]
  topTags: AssignmentTagStat[]
}

export type TagLevelItem = {
  label: string
  count: number
  ratio: number
  severity: 'high' | 'med' | 'low'
  severityScore: number
}

export type TagLevels = {
  level1: TagLevelItem[]
  level2: TagLevelItem[]
  level3: TagLevelItem[]
}

export type CompletionSummary = {
  hasData: boolean
  blankRate?: number
  blankCount?: number
  totalQuestionCount?: number
  message: string
}

export type TimeRangePreset = '7d' | '30d' | '90d' | 'custom'

export type TimeRange = {
  start: number
  end: number
  preset?: TimeRangePreset
  startLabel: string
  endLabel: string
}

export type DomainTagAggregate = {
  label: string
  count: number
  ratio: number
  examples?: string[]
}

export type DomainAggregate = {
  domain: string
  assignmentCount: number
  sampleCountTotal: number
  tags: DomainTagAggregate[]
}

export type DomainPlan = {
  domainName: string
  windowInfo: {
    assignmentCount: number
    sampleCountTotal: number
    startDate: string
    endDate: string
  }
  riskLevel: 'HIGH' | 'MED' | 'LOW'
  concentration: number
  topTags: Array<{
    label: string
    count: number
    ratio: number
    example?: string
  }>
  abilities?: Array<{
    label: string
    confidenceAvg?: number
  }>
  mustAddCaveat: boolean
}

export type DomainDiagnosis = {
  overview: string
  trendSummary: string
  teachingActions: string[]
  abilityInsight?: string
}
