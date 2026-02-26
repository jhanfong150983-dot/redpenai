/**
 * 教学提示框组件
 * 显示当前步骤的说明和操作按钮
 */

import { useEffect, useState } from 'react'
import type { TutorialStep } from '@/lib/tutorial-steps'

interface TutorialTooltipProps {
  step: TutorialStep
  targetElement: HTMLElement | null
  currentStepIndex: number
  totalSteps: number
  onNext: () => void
  onPrev: () => void
  onSkip: () => void
}

interface Position {
  top?: number
  left?: number
  right?: number
  bottom?: number
  transform?: string
}

export function TutorialTooltip({
  step,
  targetElement,
  currentStepIndex,
  totalSteps,
  onNext,
  onPrev,
  onSkip
}: TutorialTooltipProps) {
  const [position, setPosition] = useState<Position>({})

  useEffect(() => {
    if (!targetElement || step.position === 'center') {
      // 居中显示
      setPosition({
        top: window.innerHeight / 2,
        left: window.innerWidth / 2,
        transform: 'translate(-50%, -50%)'
      })
      return
    }

    // 计算 tooltip 位置
    const calculatePosition = () => {
      const rect = targetElement.getBoundingClientRect()
      const tooltipWidth = 384 // max-w-sm 约 384px
      const tooltipHeight = 200 // 估计高度
      const gap = 16 // 间距

      let newPosition: Position = {}

      switch (step.position) {
        case 'top':
          newPosition = {
            left: rect.left + rect.width / 2,
            bottom: window.innerHeight - rect.top + gap,
            transform: 'translateX(-50%)'
          }
          break

        case 'bottom':
          newPosition = {
            left: rect.left + rect.width / 2,
            top: rect.bottom + gap,
            transform: 'translateX(-50%)'
          }
          break

        case 'left':
          newPosition = {
            right: window.innerWidth - rect.left + gap,
            top: rect.top + rect.height / 2,
            transform: 'translateY(-50%)'
          }
          break

        case 'right':
          newPosition = {
            left: rect.right + gap,
            top: rect.top + rect.height / 2,
            transform: 'translateY(-50%)'
          }
          break

        default:
          newPosition = {
            top: window.innerHeight / 2,
            left: window.innerWidth / 2,
            transform: 'translate(-50%, -50%)'
          }
      }

      // 边界检查，确保不超出视口
      if (newPosition.left !== undefined && newPosition.left < 16) {
        newPosition.left = 16
        newPosition.transform = 'translateX(0)'
      }
      if (newPosition.left !== undefined && newPosition.left + tooltipWidth > window.innerWidth - 16) {
        newPosition.left = window.innerWidth - tooltipWidth - 16
        newPosition.transform = 'translateX(0)'
      }
      if (newPosition.top !== undefined && newPosition.top < 16) {
        newPosition.top = 16
      }
      if (newPosition.top !== undefined && newPosition.top + tooltipHeight > window.innerHeight - 16) {
        newPosition.top = window.innerHeight - tooltipHeight - 16
      }

      setPosition(newPosition)
    }

    calculatePosition()

    // 监听滚动和窗口调整
    window.addEventListener('scroll', calculatePosition, true)
    window.addEventListener('resize', calculatePosition)

    return () => {
      window.removeEventListener('scroll', calculatePosition, true)
      window.removeEventListener('resize', calculatePosition)
    }
  }, [targetElement, step.position])

  const isFirstStep = currentStepIndex === 0
  const isLastStep = currentStepIndex === totalSteps - 1

  return (
    <div
      className="fixed z-[10000] bg-white rounded-xl shadow-2xl p-5 max-w-sm animate-in fade-in duration-300"
      style={{
        ...position,
        minWidth: '320px'
      }}
    >
      {/* 标题和进度 */}
      <div className="mb-3">
        <h3 className="text-lg font-semibold text-gray-900">{step.title}</h3>
        <p className="text-sm text-gray-500 mt-1">
          步驟 {currentStepIndex + 1} / {totalSteps}
        </p>
      </div>

      {/* 内容 */}
      <p className="text-sm text-gray-700 mb-4 leading-relaxed">{step.content}</p>

      {/* 进度条 */}
      <div className="mb-4 bg-gray-200 rounded-full h-1.5 overflow-hidden">
        <div
          className="bg-blue-600 h-full transition-all duration-300"
          style={{ width: `${((currentStepIndex + 1) / totalSteps) * 100}%` }}
        />
      </div>

      {/* 操作按钮 */}
      <div className="flex items-center justify-between">
        <button
          onClick={onSkip}
          className="text-sm text-gray-500 hover:text-gray-700 transition-colors"
        >
          跳過教學
        </button>
        <div className="flex gap-2">
          {!isFirstStep && (
            <button
              onClick={onPrev}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              上一步
            </button>
          )}
          <button
            onClick={onNext}
            className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            {isLastStep ? '完成' : '下一步'}
          </button>
        </div>
      </div>
    </div>
  )
}
