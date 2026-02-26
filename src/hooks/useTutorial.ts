/**
 * 引导式教学状态管理 Hook
 */

import { useState, useEffect, useCallback } from 'react'
import { getTutorialFlow } from '@/lib/tutorial-steps'
import {
  isFirstTimeUser,
  markTutorialComplete,
  saveTutorialProgress,
  getTutorialProgress,
  resetTutorial
} from '@/lib/tutorial-storage'
import type { TutorialFlow } from '@/lib/tutorial-steps'

export interface UseTutorialReturn {
  isActive: boolean
  currentStep: number
  totalSteps: number
  flow: TutorialFlow | undefined
  targetElement: HTMLElement | null
  nextStep: () => void
  prevStep: () => void
  skip: () => void
  complete: () => void
  restart: () => void
}

/**
 * 教学状态管理 Hook
 * @param flowId 教学流程 ID（classroom, assignment 等）
 */
export function useTutorial(flowId: string): UseTutorialReturn {
  const [isActive, setIsActive] = useState(false)
  const [currentStep, setCurrentStep] = useState(0)
  const [targetElement, setTargetElement] = useState<HTMLElement | null>(null)

  const flow = getTutorialFlow(flowId)
  const totalSteps = flow?.steps.length ?? 0

  // 首次使用自动启动教学
  useEffect(() => {
    if (isFirstTimeUser(flowId)) {
      // 延迟一点启动，确保页面已渲染
      const timer = setTimeout(() => {
        setIsActive(true)
        setCurrentStep(getTutorialProgress(flowId))
      }, 500)
      return () => clearTimeout(timer)
    }
  }, [flowId])

  // 定位目标元素
  useEffect(() => {
    if (!isActive || !flow) {
      setTargetElement(null)
      return
    }

    const step = flow.steps[currentStep]
    if (!step) {
      setTargetElement(null)
      return
    }

    // 尝试查找目标元素
    const findElement = () => {
      const element = document.querySelector(step.targetSelector)
      setTargetElement(element as HTMLElement | null)
    }

    findElement()

    // 如果元素还没渲染，等待一下再试
    const timer = setTimeout(findElement, 100)

    return () => clearTimeout(timer)
  }, [isActive, currentStep, flow])

  // 下一步
  const nextStep = useCallback(() => {
    if (!flow) return

    if (currentStep < totalSteps - 1) {
      const nextStepIndex = currentStep + 1
      setCurrentStep(nextStepIndex)
      saveTutorialProgress(flowId, nextStepIndex)
    } else {
      // 已经是最后一步，完成教学
      complete()
    }
  }, [currentStep, totalSteps, flowId, flow])

  // 上一步
  const prevStep = useCallback(() => {
    if (currentStep > 0) {
      const prevStepIndex = currentStep - 1
      setCurrentStep(prevStepIndex)
      saveTutorialProgress(flowId, prevStepIndex)
    }
  }, [currentStep, flowId])

  // 跳过教学
  const skip = useCallback(() => {
    setIsActive(false)
    markTutorialComplete(flowId)
  }, [flowId])

  // 完成教学
  const complete = useCallback(() => {
    setIsActive(false)
    markTutorialComplete(flowId)
  }, [flowId])

  // 重新开始教学（通过 ? 图标触发）
  const restart = useCallback(() => {
    resetTutorial(flowId)
    setCurrentStep(0)
    setIsActive(true)
  }, [flowId])

  return {
    isActive,
    currentStep,
    totalSteps,
    flow,
    targetElement,
    nextStep,
    prevStep,
    skip,
    complete,
    restart
  }
}
