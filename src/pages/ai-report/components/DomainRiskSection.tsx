type RiskTag = {
  label: string
  count: number
  ratio: number
  example?: string
}

type DomainRiskSectionProps = {
  topTags: RiskTag[]
  trendSummary: string
  mustAddCaveat: boolean
}

const formatPercent = (value: number) =>
  `${Math.max(0, Math.min(100, value * 100)).toFixed(1)}%`

export default function DomainRiskSection({
  topTags,
  trendSummary,
  mustAddCaveat
}: DomainRiskSectionProps) {
  return (
    <section className="card domain-section">
      <div className="section-title">
        <h4>主要概念風險與趨勢</h4>
        <span>Top 3 概念風險</span>
      </div>
      <div className="risk-tags">
        {topTags.length === 0 && <div>目前尚無可彙整的概念標籤。</div>}
        {topTags.map((tag) => (
          <div key={tag.label} className="risk-tag">
            <div className="risk-tag__name">{tag.label}</div>
            <div className="risk-tag__meta">
              {tag.count} 次 · {formatPercent(tag.ratio)}
            </div>
          </div>
        ))}
      </div>
      <p className="domain-text">{trendSummary}</p>
      {mustAddCaveat && (
        <p className="domain-note">目前樣本較少，趨勢判讀先以參考為主。</p>
      )}
    </section>
  )
}
