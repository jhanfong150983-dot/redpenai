import type { DomainDiagnosis, DomainPlan } from '../types'
import DomainOverviewSection from './DomainOverviewSection'
import DomainRiskSection from './DomainRiskSection'
import TeachingActionsSection from './TeachingActionsSection'
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
      {cards.map(({ plan, diagnosis, loading }) => (
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

          {loading && (
            <div className="summary-loading">正在生成領域診斷摘要...</div>
          )}

          <DomainOverviewSection overview={diagnosis?.overview ?? '摘要生成中'} />
          <DomainRiskSection
            topTags={plan.topTags}
            trendSummary={diagnosis?.trendSummary ?? '摘要生成中'}
            mustAddCaveat={plan.mustAddCaveat}
          />
          <TeachingActionsSection actions={diagnosis?.teachingActions ?? []} />
          <AbilitySection insight={diagnosis?.abilityInsight} />
        </article>
      ))}
    </section>
  )
}
