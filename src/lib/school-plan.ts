// 2026-09-13 學校方案等級 Basic／PRO／PROMAX（server/school-plan.js 的鏡像；server 是權威，這裡只做顯示與導引）。
//   原則：批改相關功能不分級；只有不影響批改的延伸功能分級。方案只「加」權限：個人帳號原有 Pro 權限不受影響。

export type SchoolPlan = 'basic' | 'pro' | 'promax'
export const PLANS: SchoolPlan[] = ['basic', 'pro', 'promax']
export const PLAN_RANK: Record<SchoolPlan, number> = { basic: 0, pro: 1, promax: 2 }
export const PLAN_LABEL: Record<SchoolPlan, string> = { basic: 'Basic', pro: 'PRO', promax: 'PROMAX' }

export type PlanFeature = 'parentReport' | 'reviewMode' | 'schoolGrading' | 'schoolReports' | 'studentCorrection' | 'parentPush'
export const FEATURE_MIN_PLAN: Record<PlanFeature, SchoolPlan> = {
  parentReport: 'pro',
  reviewMode: 'pro',
  schoolGrading: 'pro',
  schoolReports: 'pro',
  studentCorrection: 'promax',
  parentPush: 'promax',
}

export function normalizePlan(v: unknown): SchoolPlan {
  const p = String(v ?? '').trim().toLowerCase()
  return (PLANS as string[]).includes(p) ? (p as SchoolPlan) : 'basic'
}

/** 2026-09-18 user 拍板：砍會員／等級、功能全開。閘門與徽章保留但關掉（server 鏡像 PLAN_GATING_ENABLED env）。 */
export const PLAN_GATING_ENABLED = false

export function planAllows(plan: unknown, feature: PlanFeature): boolean {
  if (!PLAN_GATING_ENABLED) return true
  return PLAN_RANK[normalizePlan(plan)] >= PLAN_RANK[FEATURE_MIN_PLAN[feature]]
}

export function planDeniedMessage(feature: PlanFeature, plan: unknown): string {
  return `此功能屬於 ${PLAN_LABEL[FEATURE_MIN_PLAN[feature]]} 方案，貴校目前為 ${PLAN_LABEL[normalizePlan(plan)]}。請聯絡 RedPen AI 升級。`
}
