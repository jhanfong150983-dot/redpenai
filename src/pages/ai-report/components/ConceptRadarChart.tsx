import type { StudentMastery, ConceptEntry } from './ConceptMasteryTable'

type ConceptRadarChartProps = {
  students: StudentMastery[]
  concepts: ConceptEntry[]
}

const CX = 250
const CY = 250
const R = 160       // polygon radius
const LABEL_R = 200 // label placement radius
const GRID_STEPS = [0.2, 0.4, 0.6, 0.8, 1.0]

function toXY(angle: number, radius: number) {
  return {
    x: CX + radius * Math.cos(angle),
    y: CY + radius * Math.sin(angle),
  }
}

function vertexAngle(i: number, n: number) {
  // Start from top (-90°)
  return (2 * Math.PI * i) / n - Math.PI / 2
}

function polygonPoints(ratios: number[]): string {
  return ratios
    .map((r, i) => {
      const { x, y } = toXY(vertexAngle(i, ratios.length), r * R)
      return `${x},${y}`
    })
    .join(' ')
}

function gridPoints(level: number, n: number): string {
  return Array.from({ length: n }, (_, i) => {
    const { x, y } = toXY(vertexAngle(i, n), level * R)
    return `${x},${y}`
  }).join(' ')
}

// Mastery color based on ratio
function masteryColor(ratio: number) {
  if (ratio >= 0.8) return '#16a34a'  // green
  if (ratio >= 0.6) return '#d97706'  // amber
  return '#dc2626'                    // red
}

// Truncate long labels for display
function shortLabel(label: string): string {
  // Remove leading domain code pattern like "解題：" and truncate
  const stripped = label.replace(/^解題：/, '').replace(/^[A-Z]-\d+-\d+：/, '')
  return stripped.length > 8 ? stripped.slice(0, 8) + '…' : stripped
}

export default function ConceptRadarChart({ students, concepts }: ConceptRadarChartProps) {
  if (concepts.length === 0 || students.length === 0) return null

  // Compute class-wide mastery per concept
  const classMastery: Record<string, { correct: number; total: number }> = {}
  for (const concept of concepts) {
    classMastery[concept.code] = { correct: 0, total: 0 }
  }
  for (const student of students) {
    for (const [code, stat] of Object.entries(student.concepts)) {
      if (classMastery[code]) {
        classMastery[code].correct += stat.correct
        classMastery[code].total += stat.total
      }
    }
  }

  const ratios = concepts.map((c) => {
    const s = classMastery[c.code]
    return s.total > 0 ? s.correct / s.total : 0
  })

  const n = concepts.length

  // Sorted list for bar chart (used when n < 3, and always for side panel)
  const sorted = [...concepts.map((c, i) => ({ ...c, ratio: ratios[i] }))]
    .sort((a, b) => a.ratio - b.ratio)

  // If fewer than 3 concepts, render bar chart only
  if (n < 3) {
    return (
      <div className="card" style={{ padding: '1.25rem 1.5rem', marginBottom: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
          <span style={{
            fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.05em',
            background: '#ede9fe', color: '#6d28d9', borderRadius: '0.25rem', padding: '0.15rem 0.5rem'
          }}>
            班級概念精熟度
          </span>
          <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
            {n} 個概念 · {students.length} 位學生
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxWidth: '400px' }}>
          {sorted.map((item) => {
            const pct = Math.round(item.ratio * 100)
            return (
              <div key={item.code} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#374151', width: '4.5rem', flexShrink: 0 }}>{item.code}</span>
                <div style={{ flex: 1, background: '#f3f4f6', borderRadius: '3px', height: '10px', overflow: 'hidden' }}>
                  <div style={{ width: `${pct}%`, height: '100%', background: masteryColor(item.ratio), borderRadius: '3px' }} />
                </div>
                <span style={{ fontSize: '0.75rem', fontWeight: 600, color: masteryColor(item.ratio), width: '2.5rem', textAlign: 'right' }}>{pct}%</span>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="card" style={{ padding: '1.25rem 1.5rem', marginBottom: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
        <span style={{
          fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.05em',
          background: '#ede9fe', color: '#6d28d9', borderRadius: '0.25rem', padding: '0.15rem 0.5rem'
        }}>
          班級概念精熟雷達圖
        </span>
        <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
          {n} 個概念 · {students.length} 位學生 · 數值為全班精熟度
        </span>
      </div>

      <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {/* Radar SVG */}
        <div style={{ flex: '0 0 auto' }}>
          <svg
            viewBox="0 0 500 500"
            style={{ width: '320px', height: '320px', display: 'block' }}
            aria-label="班級概念精熟雷達圖"
          >
            {/* Grid polygons */}
            {GRID_STEPS.map((level) => (
              <polygon
                key={level}
                points={gridPoints(level, n)}
                fill="none"
                stroke="#e5e7eb"
                strokeWidth={level === 1.0 ? 1.5 : 1}
              />
            ))}

            {/* Axis lines */}
            {concepts.map((_, i) => {
              const { x, y } = toXY(vertexAngle(i, n), R)
              return (
                <line
                  key={i}
                  x1={CX} y1={CY}
                  x2={x} y2={y}
                  stroke="#e5e7eb"
                  strokeWidth={1}
                />
              )
            })}

            {/* Grid percentage labels (only on top axis) */}
            {GRID_STEPS.map((level) => {
              const { x, y } = toXY(vertexAngle(0, n), level * R)
              return (
                <text
                  key={level}
                  x={x + 4} y={y - 3}
                  fontSize={9}
                  fill="#9ca3af"
                >
                  {Math.round(level * 100)}%
                </text>
              )
            })}

            {/* Data polygon */}
            <polygon
              points={polygonPoints(ratios)}
              fill="rgba(109,40,217,0.15)"
              stroke="#7c3aed"
              strokeWidth={2}
            />

            {/* Data points */}
            {ratios.map((r, i) => {
              const { x, y } = toXY(vertexAngle(i, n), r * R)
              const pct = Math.round(r * 100)
              return (
                <g key={i}>
                  <circle cx={x} cy={y} r={5} fill={masteryColor(r)} stroke="#fff" strokeWidth={1.5} />
                  <text
                    x={x}
                    y={y - 9}
                    textAnchor="middle"
                    fontSize={9.5}
                    fontWeight={600}
                    fill={masteryColor(r)}
                  >
                    {pct}%
                  </text>
                </g>
              )
            })}

            {/* Vertex labels (concept codes + short label) */}
            {concepts.map((c, i) => {
              const angle = vertexAngle(i, n)
              const { x, y } = toXY(angle, LABEL_R)
              const anchor =
                Math.abs(Math.cos(angle)) < 0.1 ? 'middle'
                  : Math.cos(angle) > 0 ? 'start'
                  : 'end'
              const dy = Math.sin(angle) < -0.5 ? -6 : Math.sin(angle) > 0.5 ? 14 : 4
              return (
                <g key={c.code}>
                  <text
                    x={x} y={y + dy - 8}
                    textAnchor={anchor}
                    fontSize={10}
                    fontWeight={700}
                    fill="#374151"
                  >
                    {c.code}
                  </text>
                  <text
                    x={x} y={y + dy + 3}
                    textAnchor={anchor}
                    fontSize={9}
                    fill="#6b7280"
                  >
                    {shortLabel(c.label)}
                  </text>
                </g>
              )
            })}
          </svg>
        </div>

        {/* Legend / ranking table */}
        <div style={{ flex: '1 1 180px', minWidth: '160px' }}>
          <div style={{ fontSize: '0.7rem', fontWeight: 600, color: '#6b7280', marginBottom: '0.5rem' }}>
            需加強的概念（由低至高）
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
            {sorted.map((item) => {
                const pct = Math.round(item.ratio * 100)
                const bar = Math.round(item.ratio * 80) // max bar width px
                return (
                  <div key={item.code} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#374151', width: '4.5rem', flexShrink: 0 }}>
                      {item.code}
                    </span>
                    <div style={{ flex: 1, background: '#f3f4f6', borderRadius: '2px', height: '8px', overflow: 'hidden' }}>
                      <div style={{
                        width: `${bar}px`, height: '100%',
                        background: masteryColor(item.ratio),
                        borderRadius: '2px'
                      }} />
                    </div>
                    <span style={{ fontSize: '0.7rem', fontWeight: 600, color: masteryColor(item.ratio), width: '2.5rem', textAlign: 'right' }}>
                      {pct}%
                    </span>
                  </div>
                )
              })}
          </div>

          {/* Color legend */}
          <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
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
        </div>
      </div>
    </div>
  )
}
