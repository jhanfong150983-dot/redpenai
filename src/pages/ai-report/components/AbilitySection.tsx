type AbilitySectionProps = {
  insight?: string
}

export default function AbilitySection({ insight }: AbilitySectionProps) {
  if (!insight) return null
  return (
    <section className="card domain-section domain-optional">
      <div className="section-title">
        <h4>能力關聯提示</h4>
        <span>可選</span>
      </div>
      <p className="domain-text">{insight}</p>
    </section>
  )
}
