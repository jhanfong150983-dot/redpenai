import type { StudentMastery, ConceptEntry } from './ConceptMasteryTable'

type AssignmentDebugInfo = {
  title: string
  total: number
  withCode: number
  gradedCount?: number
  matchedCount?: number
}

type ConceptRadarChartProps = {
  students: StudentMastery[]
  concepts: ConceptEntry[]
  debugInfo?: AssignmentDebugInfo[]
}

const CX = 250
const CY = 250
const R = 160
const LABEL_R = 205
const GRID_STEPS = [0.2, 0.4, 0.6, 0.8, 1.0]

function toXY(angle: number, radius: number) {
  return { x: CX + radius * Math.cos(angle), y: CY + radius * Math.sin(angle) }
}

function vertexAngle(i: number, n: number) {
  return (2 * Math.PI * i) / n - Math.PI / 2
}

function polygonPoints(ratios: number[]): string {
  return ratios
    .map((r, i) => { const { x, y } = toXY(vertexAngle(i, ratios.length), r * R); return `${x},${y}` })
    .join(' ')
}

function gridPoints(level: number, n: number): string {
  return Array.from({ length: n }, (_, i) => {
    const { x, y } = toXY(vertexAngle(i, n), level * R); return `${x},${y}`
  }).join(' ')
}

function masteryColor(ratio: number) {
  if (ratio >= 0.8) return '#16a34a'
  if (ratio >= 0.6) return '#d97706'
  return '#dc2626'
}


export default function ConceptRadarChart({ students, concepts, debugInfo }: ConceptRadarChartProps) {
  // Empty state
  if (concepts.length === 0 || students.length === 0) {
    return (
      <div className="card" style={{ padding: '1.25rem 1.5rem', fontSize: '0.875rem' }}>
        <div style={{ color: 'var(--muted)', marginBottom: debugInfo?.length ? '0.75rem' : 0 }}>
          此班級的作業尚無 108 課綱概念標記，精熟雷達圖無法顯示。
        </div>
        {debugInfo && debugInfo.length > 0 && (
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
            <div style={{ fontSize: '0.7rem', fontWeight: 600, color: '#6b7280', marginBottom: '0.4rem' }}>診斷：各作業的概念標記狀態</div>
            {debugInfo.map((d, i) => {
              const hasCode = d.withCode > 0
              const noGraded = (d.gradedCount ?? 0) === 0
              const noMatch = hasCode && (d.gradedCount ?? 0) > 0 && (d.matchedCount ?? 0) === 0
              const hint = d.total === 0
                ? '（答案鍵未設定）'
                : d.withCode === 0
                ? `（${d.total} 題，全部未標記）`
                : noGraded
                ? `（${d.total} 題，${d.withCode} 題已標記，尚無批改紀錄）`
                : noMatch
                ? `（${d.total} 題，${d.withCode} 題已標記，批改題號不吻合）`
                : `（${d.total} 題，${d.withCode} 題已標記，${d.matchedCount} 題匹配）`
              const icon = hasCode && !noGraded && !noMatch ? '✓' : d.withCode > 0 ? '⚠' : '✗'
              const iconColor = hasCode && !noGraded && !noMatch ? '#166534' : d.withCode > 0 ? '#92400e' : '#991b1b'
              return (
                <div key={i} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', fontSize: '0.75rem', marginBottom: '0.2rem' }}>
                  <span style={{ color: iconColor, fontWeight: 600 }}>{icon}</span>
                  <span style={{ color: '#374151' }}>{d.title}</span>
                  <span style={{ color: '#9ca3af' }}>{hint}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  // Compute class-wide mastery per concept
  const classMastery: Record<string, { full: number; partial: number; wrong: number; total: number }> = {}
  for (const concept of concepts) {
    classMastery[concept.code] = { full: 0, partial: 0, wrong: 0, total: 0 }
  }
  for (const student of students) {
    for (const [code, stat] of Object.entries(student.concepts)) {
      if (classMastery[code]) {
        classMastery[code].full += stat.full
        classMastery[code].partial += stat.partial
        classMastery[code].wrong += stat.wrong
        classMastery[code].total += stat.total
      }
    }
  }

  const ratios = concepts.map((c) => {
    const s = classMastery[c.code]
    if (!s || s.total <= 0) return 0
    return (s.full + s.partial * 0.5) / s.total
  })

  const n = concepts.length
  const sorted = [...concepts.map((c, i) => ({ ...c, ratio: ratios[i] }))].sort((a, b) => a.ratio - b.ratio)

  const header = (title: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
      <span style={{
        fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.05em',
        background: '#ede9fe', color: '#6d28d9', borderRadius: '0.25rem', padding: '0.15rem 0.5rem'
      }}>
        {title}
      </span>
      <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
        {n} 個概念 · {students.length} 位學生
      </span>
    </div>
  )

  // ── Bar chart (< 3 concepts) ──────────────────────────────────────────────
  if (n < 3) {
    return (
      <div className="card" style={{ padding: '1.25rem 1.5rem', marginBottom: '1rem' }}>
        {header('班級概念精熟度')}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', maxWidth: '500px' }}>
          {sorted.map((item) => {
            const pct = Math.round(item.ratio * 100)
            return (
              <div key={item.code}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.2rem' }}>
                  <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#374151' }}>
                    {item.code}
                    {item.label && item.label !== item.code && (
                      <span style={{ fontWeight: 400, color: '#6b7280', marginLeft: '0.4rem' }}>{item.label.split(/\s*[—–-]\s*/)[0].trim()}</span>
                    )}
                  </span>
                  <span style={{ fontSize: '0.75rem', fontWeight: 600, color: masteryColor(item.ratio) }}>{pct}%</span>
                </div>
                <div style={{ background: '#f3f4f6', borderRadius: '3px', height: '10px', overflow: 'hidden' }}>
                  <div style={{ width: `${pct}%`, height: '100%', background: masteryColor(item.ratio), borderRadius: '3px' }} />
                </div>
              </div>
            )
          })}
        </div>
        {colorLegend()}
      </div>
    )
  }

  // ── Radar chart (≥ 3 concepts) ────────────────────────────────────────────
  return (
    <div className="card" style={{ padding: '1.25rem 1.5rem', marginBottom: '1rem', position: 'relative' }}>
      {header('班級概念精熟雷達圖')}
      <div style={{ position: 'absolute', top: '1.25rem', right: '1.5rem' }}>{colorLegend()}</div>

      <div style={{ display: 'grid', justifyItems: 'center', gap: '0.75rem' }}>
        {/* Radar SVG */}
        <div>
          <svg viewBox="0 0 500 500" style={{ width: '460px', height: '460px', display: 'block' }} aria-label="班級概念精熟雷達圖">
            {/* Grid */}
            {GRID_STEPS.map((level) => (
              <polygon key={level} points={gridPoints(level, n)} fill="none" stroke="#e5e7eb" strokeWidth={level === 1.0 ? 1.5 : 1} />
            ))}
            {/* Axes */}
            {concepts.map((_, i) => {
              const { x, y } = toXY(vertexAngle(i, n), R)
              return <line key={i} x1={CX} y1={CY} x2={x} y2={y} stroke="#e5e7eb" strokeWidth={1} />
            })}
            {/* Grid % labels on top axis */}
            {GRID_STEPS.map((level) => {
              const { x, y } = toXY(vertexAngle(0, n), level * R)
              return <text key={level} x={x + 4} y={y - 3} fontSize={9} fill="#9ca3af">{Math.round(level * 100)}%</text>
            })}
            {/* Data polygon */}
            <polygon points={polygonPoints(ratios)} fill="rgba(109,40,217,0.15)" stroke="#7c3aed" strokeWidth={2} />
            {/* Data points + % labels */}
            {ratios.map((r, i) => {
              const { x, y } = toXY(vertexAngle(i, n), r * R)
              return (
                <g key={i}>
                  <circle cx={x} cy={y} r={5} fill={masteryColor(r)} stroke="#fff" strokeWidth={1.5} />
                  <text x={x} y={y - 9} textAnchor="middle" fontSize={9.5} fontWeight={600} fill={masteryColor(r)}>
                    {Math.round(r * 100)}%
                  </text>
                </g>
              )
            })}
            {/* Vertex labels */}
            {concepts.map((c, i) => {
              const angle = vertexAngle(i, n)
              const { x, y } = toXY(angle, LABEL_R)
              const anchor = Math.abs(Math.cos(angle)) < 0.1 ? 'middle' : Math.cos(angle) > 0 ? 'start' : 'end'
              const dy = Math.sin(angle) < -0.5 ? -6 : Math.sin(angle) > 0.5 ? 14 : 4
              return (
                <g key={c.code} cursor="help">
                  <title>{c.label}</title>
                  <text x={x} y={y + dy} textAnchor={anchor} fontSize={13} fontWeight={700} fill="#374151">{c.code}</text>
                </g>
              )
            })}
          </svg>
        </div>
      </div>
    </div>
  )
}

function colorLegend() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', marginTop: '0.75rem' }}>
      {[
        { color: '#16a34a', label: '≥ 80%  精熟' },
        { color: '#d97706', label: '60–79%  待加強' },
        { color: '#dc2626', label: '< 60%  需補救' },
      ].map((item) => (
        <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.65rem', color: '#6b7280' }}>
          <span style={{ width: '0.6rem', height: '0.6rem', borderRadius: '50%', background: item.color, flexShrink: 0 }} />
          {item.label}
        </div>
      ))}
    </div>
  )
}
