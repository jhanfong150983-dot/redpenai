import { useState } from 'react'

type StudentSummary = {
  student_id: string
  student_name: string
  summary: string
}

type AssignmentSummaryData = {
  status: 'pending' | 'running' | 'ready' | 'failed'
  class_summary: string | null
  class_suggestion: string | null
  minority_summary: string | null
  minority_suggestion: string | null
  student_summaries: StudentSummary[]
  sample_count: number
}

type AssignmentSummaryPanelProps = {
  data: AssignmentSummaryData | null
  loading: boolean
}

function SuggestionBox({ suggestion }: { suggestion: string }) {
  return (
    <div style={{
      marginTop: '0.75rem',
      padding: '0.75rem 1rem',
      background: '#f0fdf4',
      border: '1px solid #bbf7d0',
      borderRadius: '0.5rem',
    }}>
      <div style={{ fontSize: '0.7rem', fontWeight: 600, color: '#15803d', marginBottom: '0.35rem', letterSpacing: '0.04em' }}>
        接下來教師可以怎麼做？
      </div>
      <p style={{ fontSize: '0.825rem', color: '#166534', lineHeight: 1.7, margin: 0 }}>
        {suggestion}
      </p>
    </div>
  )
}

export default function AssignmentSummaryPanel({ data, loading }: AssignmentSummaryPanelProps) {
  const [expanded, setExpanded] = useState(false)

  if (loading) {
    return (
      <div className="card" style={{ padding: '1.5rem', color: 'var(--muted)', fontSize: '0.875rem' }}>
        摘要生成中，請稍候...
      </div>
    )
  }

  if (!data) {
    return (
      <div className="card" style={{ padding: '1.5rem', color: 'var(--muted)', fontSize: '0.875rem' }}>
        尚無作業錯誤摘要。完成批改後系統將自動生成。
      </div>
    )
  }

  if (data.status === 'running') {
    return (
      <div className="card" style={{ padding: '1.5rem', color: 'var(--muted)', fontSize: '0.875rem' }}>
        AI 摘要生成中...
      </div>
    )
  }

  if (data.status === 'failed') {
    return (
      <div className="card" style={{ padding: '1.5rem', color: 'var(--muted)', fontSize: '0.875rem' }}>
        摘要生成失敗，請重新批改後再試。
      </div>
    )
  }

  if (data.status !== 'ready') {
    return (
      <div className="card" style={{ padding: '1.5rem', color: 'var(--muted)', fontSize: '0.875rem' }}>
        尚無摘要資料。
      </div>
    )
  }

  const students = data.student_summaries ?? []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>

      {/* 1. 主要：班級錯誤摘要 */}
      <div className="card" style={{ padding: '1.25rem 1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
          <span style={{
            fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.05em',
            background: '#fee2e2', color: '#991b1b', borderRadius: '0.25rem', padding: '0.15rem 0.5rem'
          }}>
            全班錯誤摘要
          </span>
          <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
            {data.sample_count} 份作業
          </span>
        </div>
        <p style={{ fontSize: '0.875rem', lineHeight: 1.7, margin: 0, color: '#1f2937' }}>
          {data.class_summary || '無全班共同錯誤。'}
        </p>
        {data.class_suggestion && <SuggestionBox suggestion={data.class_suggestion} />}
      </div>

      {/* 2. 次要：需要關注的學生 */}
      {(data.minority_summary || students.length > 0) && (
        <div className="card" style={{ padding: '1.25rem 1.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
            <span style={{
              fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.05em',
              background: '#fef3c7', color: '#92400e', borderRadius: '0.25rem', padding: '0.15rem 0.5rem'
            }}>
              需要關注的學生
            </span>
            {students.length > 0 && (
              <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
                {students.length} 人
              </span>
            )}
          </div>
          {data.minority_summary && (
            <p style={{ fontSize: '0.875rem', lineHeight: 1.7, margin: 0, color: '#1f2937' }}>
              {data.minority_summary}
            </p>
          )}
          {data.minority_suggestion && <SuggestionBox suggestion={data.minority_suggestion} />}
        </div>
      )}

      {/* 3. 補充：個人錯誤摘要（預設摺疊） */}
      {students.length > 0 && (
        <div className="card" style={{ padding: '1.25rem 1.5rem' }}>
          <button
            type="button"
            onClick={() => setExpanded(v => !v)}
            style={{
              display: 'flex', alignItems: 'center', gap: '0.5rem',
              background: 'none', border: 'none', padding: 0, cursor: 'pointer', width: '100%'
            }}
          >
            <span style={{
              fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.05em',
              background: '#ede9fe', color: '#5b21b6', borderRadius: '0.25rem', padding: '0.15rem 0.5rem'
            }}>
              個人錯誤摘要
            </span>
            <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
              {students.length} 人
            </span>
            <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--muted)' }}>
              {expanded ? '▲ 收合' : '▼ 展開'}
            </span>
          </button>

          {expanded && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.75rem' }}>
              {students.map((s) => (
                <div key={s.student_id} style={{
                  display: 'flex', gap: '0.75rem', alignItems: 'flex-start',
                  paddingBottom: '0.5rem', borderBottom: '1px solid var(--border)'
                }}>
                  <span style={{
                    fontSize: '0.8rem', fontWeight: 600, color: '#374151',
                    minWidth: '4rem', flexShrink: 0, paddingTop: '0.1rem'
                  }}>
                    {s.student_name}
                  </span>
                  <span style={{ fontSize: '0.825rem', color: '#4b5563', lineHeight: 1.6 }}>
                    {s.summary}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
