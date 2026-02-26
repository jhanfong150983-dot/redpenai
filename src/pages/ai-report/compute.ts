import type {
  ActionSummary,
  AssignmentTagReport,
  AssignmentTagStat,
  CompletionSummary,
  StudentBase,
  StudentRiskSummary,
  Submission,
  TagLevels
} from './types'

const EXCLUDED_TOP_TAGS = ['未作答或漏答', '未作答', '漏答']

const sortTags = (tags: AssignmentTagStat[]) =>
  [...tags].sort((a, b) => b.count - a.count)

const pickTopTags = (tags: AssignmentTagStat[]) =>
  sortTags(
    tags.filter((tag) => !EXCLUDED_TOP_TAGS.includes(tag.label.trim()))
  ).slice(0, 2)

const formatTagLine = (tag: AssignmentTagStat) =>
  `${tag.label}（${tag.count}人）`

export function buildActionSummary(
  report: AssignmentTagReport | null,
  riskSummary?: StudentRiskSummary | null
): ActionSummary {
  const tags = report?.tags ?? []
  const sampleCount = report?.sampleCount ?? 0
  const topTags = pickTopTags(tags)
  const topLine =
    topTags.length > 0
      ? `常見錯誤：${topTags.map(formatTagLine).join('、')}`
      : '常見錯誤：尚無可判讀標籤'

  const ratio =
    sampleCount > 0 && topTags.length > 0 ? topTags[0].count / sampleCount : 0
  const strategy =
    sampleCount < 5
      ? '建議：批改份數不足，先累積到 5 份以上再判讀。'
      : ratio >= 0.3
        ? '建議：全班示範解題流程／重畫圖／講解概念。'
        : '建議：分組補強／針對錯誤點練習。'

  const riskNames = riskSummary?.riskStudentNames ?? []
  const tracking = riskSummary?.hasRiskData
    ? riskNames.length
      ? `個別追蹤：${riskNames.slice(0, 5).join('、')}`
      : '個別追蹤：目前無需特別關注學生。'
    : '個別追蹤：尚無學生層級風險資料（建議加入 submission.tagCounts / blankCount）。'

  return {
    lines: [topLine, strategy, tracking],
    topTags
  }
}

export function buildTagLevels(report: AssignmentTagReport | null): TagLevels {
  const tags = report?.tags ?? []
  const sampleCount = report?.sampleCount ?? 0

  const items = sortTags(tags).map((tag) => {
    const ratio = sampleCount > 0 ? tag.count / sampleCount : 0
    const severity: 'high' | 'med' | 'low' =
      ratio >= 0.3 ? 'high' : ratio >= 0.1 ? 'med' : 'low'

    return {
      label: tag.label,
      count: tag.count,
      ratio,
      severity,
      severityScore: ratio
    }
  })

  return {
    level1: items.filter((item) => item.ratio >= 0.3),
    level2: items.filter((item) => item.ratio >= 0.1 && item.ratio < 0.3),
    level3: items.filter((item) => item.ratio < 0.1)
  }
}

export function buildCompletionSummary(
  submissions: Submission[]
): CompletionSummary {
  let totalQuestionCount = 0
  let blankCount = 0
  let hasData = false

  submissions.forEach((submission) => {
    if (
      typeof submission.blankCount === 'number' &&
      typeof submission.totalQuestionCount === 'number'
    ) {
      hasData = true
      blankCount += submission.blankCount
      totalQuestionCount += submission.totalQuestionCount
    }
  })

  if (!hasData || totalQuestionCount === 0) {
    return {
      hasData: false,
      message:
        '未提供空白題資料（建議在批改流程加入 blankCount / totalQuestionCount）。'
    }
  }

  const blankRate = blankCount / totalQuestionCount
  const message =
    blankRate >= 0.2
      ? '空白率偏高，可能題目過難或作答不完整。'
      : '空白率正常。'

  return {
    hasData: true,
    blankRate,
    blankCount,
    totalQuestionCount,
    message
  }
}

export function buildStudentRiskSummary(
  students: StudentBase[],
  submissions: Submission[]
): StudentRiskSummary {
  const studentSubmissions = new Map<string, Submission[]>()
  let hasTagCounts = false
  let hasBlankCounts = false

  submissions.forEach((submission) => {
    if (!submission.studentId) return
    if (!studentSubmissions.has(submission.studentId)) {
      studentSubmissions.set(submission.studentId, [])
    }
    studentSubmissions.get(submission.studentId)?.push(submission)
    if (submission.tagCounts && Object.keys(submission.tagCounts).length) {
      hasTagCounts = true
    }
    if (
      typeof submission.blankCount === 'number' &&
      typeof submission.totalQuestionCount === 'number'
    ) {
      hasBlankCounts = true
    }
  })

  const hasRiskData = hasTagCounts || hasBlankCounts

  const studentsWithRisk = students.map((student) => {
    const list = studentSubmissions.get(student.id) ?? []
    const tagCounts: Record<string, number> = {}
    let blankCount = 0
    let totalQuestionCount = 0

    list.forEach((submission) => {
      if (submission.tagCounts) {
        Object.entries(submission.tagCounts).forEach(([label, count]) => {
          tagCounts[label] = (tagCounts[label] ?? 0) + count
        })
      }
      if (
        typeof submission.blankCount === 'number' &&
        typeof submission.totalQuestionCount === 'number'
      ) {
        blankCount += submission.blankCount
        totalQuestionCount += submission.totalQuestionCount
      }
    })

    const tagValues = Object.values(tagCounts)
    const uniqueTagCount = tagValues.length
    const blankRate =
      totalQuestionCount > 0 ? blankCount / totalQuestionCount : null

    const conceptRisk = hasTagCounts
      ? tagValues.some((count) => count >= 2)
      : undefined
    const completionRisk =
      hasBlankCounts && blankRate !== null ? blankRate >= 0.2 : undefined
    const multiErrorRisk = hasTagCounts ? uniqueTagCount >= 3 : undefined

    const hasRisk =
      Boolean(conceptRisk) || Boolean(completionRisk) || Boolean(multiErrorRisk)

    return {
      ...student,
      riskFlags:
        conceptRisk || completionRisk || multiErrorRisk
          ? {
              conceptRisk,
              completionRisk,
              multiErrorRisk
            }
          : undefined,
      hasRisk,
      tagCounts: hasTagCounts ? tagCounts : undefined,
      uniqueTagCount: hasTagCounts ? uniqueTagCount : null,
      blankRate
    }
  })

  const riskStudentNames = studentsWithRisk
    .filter((student) => student.hasRisk)
    .map((student) => student.name)

  return {
    hasRiskData,
    riskCount: hasRiskData ? riskStudentNames.length : null,
    riskStudentNames,
    students: studentsWithRisk
  }
}

export function runSanityCheck() {
  const report: AssignmentTagReport = {
    assignmentId: 'demo',
    sampleCount: 20,
    tags: [
      { label: '概念錯誤', count: 8 },
      { label: '未作答或漏答', count: 5 },
      { label: '審題不清', count: 3 }
    ]
  }
  const students: StudentBase[] = [
    { id: 's1', name: '學生甲' },
    { id: 's2', name: '學生乙' }
  ]
  const submissions: Submission[] = [
    {
      id: 'sub1',
      studentId: 's1',
      tagCounts: { 概念錯誤: 2, 審題不清: 1 },
      blankCount: 1,
      totalQuestionCount: 5
    },
    { id: 'sub2', studentId: 's2' }
  ]

  const riskSummary = buildStudentRiskSummary(students, submissions)
  const summary = buildActionSummary(report, riskSummary)
  const levels = buildTagLevels(report)
  const completion = buildCompletionSummary(submissions)

  return { summary, levels, completion, riskSummary }
}
