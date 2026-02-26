/**
 * 教学覆盖层主组件
 * 整合 Spotlight 和 Tooltip，管理教学流程显示
 */

import { createPortal } from 'react-dom'
import { TutorialSpotlight } from './TutorialSpotlight'
import { TutorialTooltip } from './TutorialTooltip'
import { TutorialDragAnimation } from './TutorialDragAnimation'
import type { UseTutorialReturn } from '@/hooks/useTutorial'

interface TutorialOverlayProps {
  tutorial: UseTutorialReturn
}

export function TutorialOverlay({ tutorial }: TutorialOverlayProps) {
  const { isActive, currentStep, totalSteps, flow, targetElement, nextStep, prevStep, skip } = tutorial

  if (!isActive || !flow) {
    return null
  }

  const step = flow.steps[currentStep]
  if (!step) {
    return null
  }

  return createPortal(
    <>
      {/* 镂空高亮层 */}
      <TutorialSpotlight
        targetElement={targetElement}
        highlightElement={step.highlightElement}
      />

      {/* 拖曳动画（如果配置了） */}
      {step.animation?.type === 'drag-drop' && (
        <TutorialDragAnimation
          fromSelector={step.animation.fromSelector}
          toSelector={step.animation.toSelector}
        />
      )}

      {/* 提示框 */}
      <TutorialTooltip
        step={step}
        targetElement={targetElement}
        currentStepIndex={currentStep}
        totalSteps={totalSteps}
        onNext={nextStep}
        onPrev={prevStep}
        onSkip={skip}
      />
    </>,
    document.body
  )
}
