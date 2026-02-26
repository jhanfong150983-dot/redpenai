type TeachingActionsSectionProps = {
  actions: string[]
}

export default function TeachingActionsSection({
  actions
}: TeachingActionsSectionProps) {
  return (
    <section className="card domain-section">
      <div className="section-title">
        <h4>教學調整建議</h4>
        <span>課程層級調整</span>
      </div>
      <ul className="domain-list">
        {actions.length === 0 && <li>尚無可用教學建議。</li>}
        {actions.map((action, index) => (
          <li key={`${action}-${index}`}>{action}</li>
        ))}
      </ul>
    </section>
  )
}
