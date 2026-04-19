import type { DomainDiagnosis, DomainPlan } from '../types'
import AbilitySection from './AbilitySection'

type DomainDiagnosisCard = {
  plan: DomainPlan
  diagnosis?: DomainDiagnosis | null
  loading?: boolean
}

type DomainDiagnosisViewProps = {
  cards: DomainDiagnosisCard[]
  emptyState?: string
}

export default function DomainDiagnosisView({
  cards,
  emptyState
}: DomainDiagnosisViewProps) {
  if (!cards.length) {
    return <section className="card empty-state">{emptyState}</section>
  }

  return (
    <section className="domain-diagnosis">
      {cards.map(({ plan, diagnosis }) => (
        <article key={plan.domainName} className="domain-card">
          <header className="domain-card__header">
            <div>
              <h3>{plan.domainName}</h3>
              <p className="subtitle">
                作業 {plan.windowInfo.assignmentCount} 份 · 樣本{' '}
                {plan.windowInfo.sampleCountTotal} · 風險 {plan.riskLevel}
              </p>
            </div>
            <span className={`pill ${plan.riskLevel === 'HIGH' ? 'warn' : 'info'}`}>
              {plan.riskLevel}
            </span>
          </header>

          <AbilitySection insight={diagnosis?.abilityInsight} />
        </article>
      ))}
    </section>
  )
}
