/**
 * 教学镂空高亮组件
 * 使用 box-shadow 实现镂空效果，高亮显示目标元素
 */

import { useEffect, useState } from 'react'

interface TutorialSpotlightProps {
  targetElement: HTMLElement | null
  highlightElement?: boolean
}

export function TutorialSpotlight({ targetElement, highlightElement = true }: TutorialSpotlightProps) {
  const [rect, setRect] = useState<DOMRect | null>(null)

  useEffect(() => {
    if (!targetElement || !highlightElement) {
      setRect(null)
      return
    }

    // 获取元素位置和尺寸
    const updatePosition = () => {
      const elementRect = targetElement.getBoundingClientRect()
      setRect(elementRect)
    }

    updatePosition()

    // 监听滚动和窗口调整，实时更新位置
    window.addEventListener('scroll', updatePosition, true)
    window.addEventListener('resize', updatePosition)

    return () => {
      window.removeEventListener('scroll', updatePosition, true)
      window.removeEventListener('resize', updatePosition)
    }
  }, [targetElement, highlightElement])

  // 如果没有目标元素或不需要高亮，显示全屏遮罩
  if (!rect || !highlightElement) {
    return (
      <div
        className="fixed inset-0 z-[9998] bg-black/60 pointer-events-none"
        style={{ transition: 'background-color 0.3s ease' }}
      />
    )
  }

  // 使用 box-shadow 实现镂空效果
  return (
    <div
      className="fixed z-[9999] pointer-events-none"
      style={{
        top: rect.top - 4,
        left: rect.left - 4,
        width: rect.width + 8,
        height: rect.height + 8,
        boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.6)',
        borderRadius: '12px',
        border: '2px solid rgb(59, 130, 246)',
        transition: 'all 0.3s ease'
      }}
    />
  )
}
