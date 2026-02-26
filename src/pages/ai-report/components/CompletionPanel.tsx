import type { CompletionSummary } from '../types'

type CompletionPanelProps = {
  summary: CompletionSummary
}

const formatPercent = (value: number) => `${(value * 100).toFixed(1)}%`

export default function CompletionPanel({ summary }: CompletionPanelProps) {
  if (!summary.hasData) {
    return (
      <section className="card completion-card">
        <h3>作業完成度</h3>
        <p className="subtitle">{summary.message}</p>
      </section>
    )
  }

  return (
    <section className="card completion-card">
      <h3>作業完成度</h3>
      <div className="completion-grid">
        <div>
          <div className="stat-label">空白率</div>
          <div className="stat-value">
            {summary.blankRate !== undefined
              ? formatPercent(summary.blankRate)
              : '--'}
          </div>
        </div>
        <div>
          <div className="stat-label">未作答題數</div>
          <div className="stat-value">{summary.blankCount ?? '--'}</div>
        </div>
        <div>
          <div className="stat-label">總題數</div>
          <div className="stat-value">{summary.totalQuestionCount ?? '--'}</div>
        </div>
      </div>
      <p className="subtitle">{summary.message}</p>
    </section>
  )
}
