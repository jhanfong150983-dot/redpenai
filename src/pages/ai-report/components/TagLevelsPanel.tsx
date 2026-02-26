import type { TagLevels } from '../types'

type TagLevelsPanelProps = {
  levels: TagLevels
  sampleCount: number
}

const severityMeta: Record<string, { label: string; className: string }> = {
  high: { label: 'High', className: 'pill risk' },
  med: { label: 'Med', className: 'pill warn' },
  low: { label: 'Low', className: 'pill good' }
}

const formatRatio = (value: number) => `${(value * 100).toFixed(1)}%`

const renderItems = (items: TagLevels['level1'], emptyText: string) => {
  if (!items.length) {
    return <div className="tag-level-empty">{emptyText}</div>
  }

  return (
    <ul className="tag-level-list">
      {items.map((item) => {
        const meta = severityMeta[item.severity] ?? severityMeta.low
        return (
          <li key={item.label} className="tag-level-row">
            <div>
              <div className="tag-level-title">{item.label}</div>
              <div className="tag-level-sub">
                {item.count} 人 · {formatRatio(item.ratio)}
              </div>
            </div>
            <span className={meta.className}>{meta.label}</span>
          </li>
        )
      })}
    </ul>
  )
}

export default function TagLevelsPanel({ levels, sampleCount }: TagLevelsPanelProps) {
  return (
    <section className="severity-grid">
      <div className="card">
        <h3>全班重教</h3>
        <div className="subtitle">出現比例 ≥ 30%</div>
        {renderItems(levels.level1, '目前沒有需要全班重教的標籤。')}
      </div>
      <div className="card">
        <h3>分組補強</h3>
        <div className="subtitle">10%–29.9%</div>
        {renderItems(levels.level2, '目前沒有分組補強的標籤。')}
      </div>
      <div className="card">
        <h3>個別追蹤</h3>
        <div className="subtitle">
          少於 10% · 以 {sampleCount} 份批改為基準
        </div>
        {renderItems(levels.level3, '目前沒有個別追蹤的標籤。')}
      </div>
    </section>
  )
}
