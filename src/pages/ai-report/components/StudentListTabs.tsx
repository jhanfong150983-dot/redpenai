import { useMemo, useState } from 'react'
import type { StudentRiskStudent, StudentRiskSummary } from '../types'

type StudentListTabsProps = {
  summary: StudentRiskSummary
}

type ViewMode = 'risk' | 'all'

const formatAvgScore = (value: number | null | undefined) => {
  if (value === null || value === undefined) return '--'
  if (value <= 1) return `${(value * 100).toFixed(0)}%`
  return value.toFixed(0)
}

const getRiskLabel = (student: StudentRiskStudent, hasRiskData: boolean) => {
  if (!hasRiskData) return '資料不足'
  if (!student.hasRisk) return '穩定'
  return '需關注'
}

const getRiskClass = (student: StudentRiskStudent, hasRiskData: boolean) => {
  if (!hasRiskData) return 'student-card is-warn'
  return student.hasRisk ? 'student-card is-risk' : 'student-card'
}

const buildTagSummary = (student: StudentRiskStudent) => {
  if (!student.tagCounts) return []
  return Object.entries(student.tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
}

const buildTagDetail = (student: StudentRiskStudent) => {
  if (!student.tagCounts) return '尚無標籤資料'
  const entries = Object.entries(student.tagCounts).sort((a, b) => b[1] - a[1])
  if (!entries.length) return '尚無標籤資料'
  return entries.map(([label, count]) => `${label} · ${count}`).join('\n')
}

export default function StudentListTabs({ summary }: StudentListTabsProps) {
  const defaultView: ViewMode = summary.hasRiskData ? 'risk' : 'all'
  const [view, setView] = useState<ViewMode>(defaultView)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())

  const riskStudents = useMemo(
    () => summary.students.filter((student) => student.hasRisk),
    [summary.students]
  )

  const displayStudents = view === 'risk' ? riskStudents : summary.students

  const toggleExpanded = (studentId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(studentId)) {
        next.delete(studentId)
      } else {
        next.add(studentId)
      }
      return next
    })
  }

  return (
    <section className="card student-tabs">
      <div className="student-tab-header">
        <div className="student-tab-title">個人化資料分析</div>
        <div className="student-tab-controls">
          <button
            className={view === 'risk' ? 'btn btn-tab active' : 'btn btn-tab'}
            type="button"
            onClick={() => setView('risk')}
          >
            需關注
            <span>{summary.hasRiskData ? ` ${riskStudents.length}` : ' —'}</span>
          </button>
          <button
            className={view === 'all' ? 'btn btn-tab active' : 'btn btn-tab'}
            type="button"
            onClick={() => setView('all')}
          >
            全部 {summary.students.length}
          </button>
        </div>
      </div>

      {view === 'risk' && !summary.hasRiskData && (
        <div className="student-tab-empty">
          尚無學生層級風險資料，需提供 submission.tagCounts / blankCount。
        </div>
      )}

      {displayStudents.length === 0 && (
        <div className="student-tab-empty">目前沒有學生資料。</div>
      )}

      <div className="student-grid">
        {displayStudents.map((student) => {
          const expanded = expandedIds.has(student.id)
          const tagSummary = buildTagSummary(student)
          const tagDetail = buildTagDetail(student)
          const riskLabel = getRiskLabel(student, summary.hasRiskData)
          return (
            <div
              key={student.id}
              className={getRiskClass(student, summary.hasRiskData)}
            >
              <div className="student-top">
                <div>
                  <div className="student-name">{student.name}</div>
                  <div className="student-meta">
                    座號 {student.seatNumber ?? '--'}
                  </div>
                </div>
                <div className="student-score">
                  {formatAvgScore(student.avgScore)}
                  <span>平均</span>
                </div>
              </div>

              <div className="student-tags">
                {tagSummary.length === 0 && (
                  <span className="tag-chip neutral">需更多資料</span>
                )}
                {tagSummary.map(([label, count]) => (
                  <span key={`${student.id}-${label}`} className="tag-chip neutral">
                    {label} · {count}
                  </span>
                ))}
              </div>

              <div className="student-meta">
                {summary.hasRiskData
                  ? student.hasRisk
                    ? '錯誤類型集中，建議優先關注。'
                    : '作答穩定，未見明顯異常。'
                  : '尚無學生層級風險資料。'}
              </div>

              <div className="student-bottom">
                <button
                  className="student-toggle"
                  type="button"
                  onClick={() => toggleExpanded(student.id)}
                >
                  {expanded ? '收合細節' : '查看細節'}
                </button>
                <span
                  className={`pill ${
                    summary.hasRiskData
                      ? student.hasRisk
                        ? 'risk'
                        : 'good'
                      : 'warn'
                  }`}
                >
                  {riskLabel}
                </span>
              </div>

              {expanded && (
                <div className="student-details">
                  <div className="student-details-row">
                    <span>標籤明細</span>
                    <span className="student-details-value" title={tagDetail}>
                      {tagDetail}
                    </span>
                  </div>
                  <div className="student-details-row">
                    <span>錯誤類型數</span>
                    <span className="student-details-value">
                      {student.uniqueTagCount ?? '—'}
                    </span>
                  </div>
                  <div className="student-details-row">
                    <span>空白率</span>
                    <span className="student-details-value">
                      {student.blankRate !== null && student.blankRate !== undefined
                        ? `${(student.blankRate * 100).toFixed(0)}%`
                        : '—'}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
