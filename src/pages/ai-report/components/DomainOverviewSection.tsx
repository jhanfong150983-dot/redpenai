type DomainOverviewSectionProps = {
  overview: string
}

export default function DomainOverviewSection({
  overview
}: DomainOverviewSectionProps) {
  return (
    <section className="card domain-section">
      <div className="section-title">
        <h4>整體學習概況</h4>
        <span>跨作業彙總</span>
      </div>
      <p className="domain-text">{overview}</p>
    </section>
  )
}
