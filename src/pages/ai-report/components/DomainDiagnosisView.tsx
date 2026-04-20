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

const RISK_LABELS: Record<string, string> = {
  HIGH: '需優先關注',
  MED: '留意觀察',
  LOW: '表現穩定'
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
      {cards.map(({ plan, diagnosis }) => {
        const riskLabel = RISK_LABELS[plan.riskLevel] ?? plan.riskLevel
        return (
          <article key={plan.domainName} className="domain-card">
            <header className="domain-card__header">
              <div>
                <h3>{plan.domainName}</h3>
                <p className="subtitle">
                  作業 {plan.windowInfo.assignmentCount} 份 · 樣本{' '}
                  {plan.windowInfo.sampleCountTotal} · {riskLabel}
                </p>
              </div>
              <span className={`pill ${plan.riskLevel === 'HIGH' ? 'warn' : 'info'}`}>
                {riskLabel}
              </span>
            </header>

            <AbilitySection insight={diagnosis?.abilityInsight} />
          </article>
        )
      })}
    </section>
  )
}
