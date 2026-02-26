import type { TimeRangePreset } from '../types'

type TimeRangeFilterProps = {
  preset: TimeRangePreset
  startDate: string
  endDate: string
  onPresetChange: (preset: TimeRangePreset) => void
  onStartDateChange: (value: string) => void
  onEndDateChange: (value: string) => void
  assignmentCount: number
  sampleCountTotal: number
  startLabel: string
  endLabel: string
}

const PRESETS: Array<{ label: string; value: TimeRangePreset }> = [
  { label: '最近7天', value: '7d' },
  { label: '最近30天', value: '30d' },
  { label: '最近90天', value: '90d' },
  { label: '自訂日期', value: 'custom' }
]

export default function TimeRangeFilter({
  preset,
  startDate,
  endDate,
  onPresetChange,
  onStartDateChange,
  onEndDateChange,
  assignmentCount,
  sampleCountTotal,
  startLabel,
  endLabel
}: TimeRangeFilterProps) {
  return (
    <section className="card time-range-card">
      <div className="time-range-header">
        <div>
          <h3>時段篩選</h3>
          <p className="subtitle">
            {startLabel} – {endLabel} · 作業 {assignmentCount} 份｜樣本{' '}
            {sampleCountTotal}
          </p>
        </div>
      </div>
      <div className="time-range-controls">
        <div className="segmented">
          {PRESETS.map((item) => (
            <button
              key={item.value}
              type="button"
              className={preset === item.value ? 'is-active' : ''}
              onClick={() => onPresetChange(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
        {preset === 'custom' && (
          <div className="custom-range">
            <label>
              開始日期
              <input
                type="date"
                value={startDate}
                onChange={(event) => onStartDateChange(event.target.value)}
              />
            </label>
            <label>
              結束日期
              <input
                type="date"
                value={endDate}
                onChange={(event) => onEndDateChange(event.target.value)}
              />
            </label>
          </div>
        )}
      </div>
    </section>
  )
}
