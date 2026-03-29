type ConceptEntry = {
  code: string
  label: string
}

type StudentMastery = {
  studentId: string
  studentName: string
  seatNumber?: number | null
  concepts: Record<string, { correct: number; total: number }>
}

type ConceptMasteryTableProps = {
  students: StudentMastery[]
  concepts: ConceptEntry[]
}

function getMasteryColor(correct: number, total: number): string {
  if (total === 0) return 'transparent'
  const ratio = correct / total
  if (ratio >= 0.8) return '#dcfce7'   // green-100
  if (ratio >= 0.6) return '#fef9c3'   // yellow-100
  return '#fee2e2'                      // red-100
}

function getMasteryTextColor(correct: number, total: number): string {
  if (total === 0) return '#9ca3af'
  const ratio = correct / total
  if (ratio >= 0.8) return '#166534'
  if (ratio >= 0.6) return '#854d0e'
  return '#991b1b'
}

export type { StudentMastery, ConceptEntry }

export default function ConceptMasteryTable({ students, concepts }: ConceptMasteryTableProps) {
  if (concepts.length === 0 || students.length === 0) {
    return (
      <div className="card" style={{ padding: '1.25rem 1.5rem', color: 'var(--muted)', fontSize: '0.875rem' }}>
        此期間沒有標記 108 課綱概念的題目。請先在答案鍵中設定 concept_code。
      </div>
    )
  }

  return (
    <div className="card" style={{ padding: '1.25rem 1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
        <span style={{
          fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.05em',
          background: '#e0f2fe', color: '#0369a1', borderRadius: '0.25rem', padding: '0.15rem 0.5rem'
        }}>
          雙向細目表
        </span>
        <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
          {students.length} 位學生 · {concepts.length} 個概念
        </span>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{
          borderCollapse: 'collapse',
          fontSize: '0.75rem',
          minWidth: '100%',
          tableLayout: 'auto'
        }}>
          <thead>
            <tr>
              <th style={{
                position: 'sticky', left: 0, zIndex: 1,
                background: '#f9fafb', borderBottom: '2px solid #e5e7eb',
                borderRight: '1px solid #e5e7eb',
                padding: '0.5rem 0.75rem',
                textAlign: 'left', fontWeight: 600, color: '#374151',
                whiteSpace: 'nowrap', minWidth: '5rem'
              }}>
                學生
              </th>
              {concepts.map((concept) => (
                <th key={concept.code} style={{
                  borderBottom: '2px solid #e5e7eb',
                  borderRight: '1px solid #e5e7eb',
                  padding: '0.35rem 0.5rem',
                  textAlign: 'center', fontWeight: 600, color: '#374151',
                  whiteSpace: 'nowrap', minWidth: '5rem'
                }}>
                  <div style={{ fontWeight: 700, color: '#1f2937' }}>{concept.code}</div>
                  {concept.label !== concept.code && (
                    <div style={{ fontWeight: 400, color: '#6b7280', fontSize: '0.65rem', maxWidth: '6rem', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {concept.label}
                    </div>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {students.map((student, rowIdx) => (
              <tr key={student.studentId} style={{ background: rowIdx % 2 === 0 ? '#ffffff' : '#f9fafb' }}>
                <td style={{
                  position: 'sticky', left: 0, zIndex: 1,
                  background: rowIdx % 2 === 0 ? '#ffffff' : '#f9fafb',
                  borderBottom: '1px solid #e5e7eb',
                  borderRight: '1px solid #e5e7eb',
                  padding: '0.4rem 0.75rem',
                  fontWeight: 500, color: '#374151',
                  whiteSpace: 'nowrap'
                }}>
                  {student.seatNumber != null && (
                    <span style={{ color: '#9ca3af', marginRight: '0.35rem', fontSize: '0.65rem' }}>
                      {student.seatNumber}
                    </span>
                  )}
                  {student.studentName}
                </td>
                {concepts.map((concept) => {
                  const entry = student.concepts[concept.code]
                  const correct = entry?.correct ?? 0
                  const total = entry?.total ?? 0
                  const bgColor = getMasteryColor(correct, total)
                  const textColor = getMasteryTextColor(correct, total)
                  const lowSample = total > 0 && total < 5
                  return (
                    <td key={concept.code} style={{
                      borderBottom: '1px solid #e5e7eb',
                      borderRight: '1px solid #e5e7eb',
                      padding: '0.3rem 0.5rem',
                      textAlign: 'center',
                      background: bgColor,
                      color: textColor,
                      fontWeight: 500,
                      whiteSpace: 'nowrap'
                    }}>
                      {total > 0 ? (
                        <>
                          {correct}/{total}
                          {lowSample && (
                            <span
                              title="題目數少於 5，結果僅供參考"
                              style={{ marginLeft: '0.2rem', fontSize: '0.65rem' }}
                            >
                              ⚠️
                            </span>
                          )}
                        </>
                      ) : (
                        <span style={{ color: '#d1d5db' }}>—</span>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: '1rem', marginTop: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: '0.65rem', color: '#6b7280', fontWeight: 600 }}>精熟度：</span>
        {[
          { color: '#dcfce7', textColor: '#166534', label: '≥ 80%' },
          { color: '#fef9c3', textColor: '#854d0e', label: '60–79%' },
          { color: '#fee2e2', textColor: '#991b1b', label: '< 60%' },
        ].map((item) => (
          <span key={item.label} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.65rem', color: '#6b7280' }}>
            <span style={{
              display: 'inline-block', width: '0.75rem', height: '0.75rem',
              background: item.color, borderRadius: '0.15rem', border: '1px solid #e5e7eb'
            }} />
            {item.label}
          </span>
        ))}
        <span style={{ fontSize: '0.65rem', color: '#6b7280' }}>⚠️ 題目數 &lt; 5，結果僅供參考</span>
      </div>
    </div>
  )
}
