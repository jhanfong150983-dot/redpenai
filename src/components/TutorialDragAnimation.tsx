/**
 * 教学拖曳动画组件
 * 显示幽灵游标从起始位置拖曳到目标位置的动画
 * 使用純 CSS 動畫替代 framer-motion
 */

import { useEffect, useState, useRef } from 'react'

interface TutorialDragAnimationProps {
  fromSelector: string
  toSelector: string
}

export function TutorialDragAnimation({ fromSelector, toSelector }: TutorialDragAnimationProps) {
  const [fromRect, setFromRect] = useState<DOMRect | null>(null)
  const [toRect, setToRect] = useState<DOMRect | null>(null)
  const pathRef = useRef<SVGPathElement>(null)

  useEffect(() => {
    const updatePositions = () => {
      const fromElement = document.querySelector(fromSelector)
      const toElement = document.querySelector(toSelector)

      if (fromElement && toElement) {
        setFromRect(fromElement.getBoundingClientRect())
        setToRect(toElement.getBoundingClientRect())
      } else {
        console.warn(
          '[Tutorial] 動畫元素未找到',
          { fromSelector, from: !!fromElement },
          { toSelector, to: !!toElement }
        )
      }
    }

    // 稍微延遲以確保 DOM 已完全渲染
    const timer = setTimeout(updatePositions, 100)

    // 监听窗口调整
    window.addEventListener('resize', updatePositions)
    window.addEventListener('scroll', updatePositions, true)

    return () => {
      clearTimeout(timer)
      window.removeEventListener('resize', updatePositions)
      window.removeEventListener('scroll', updatePositions, true)
    }
  }, [fromSelector, toSelector])

  // 設定 SVG path 動畫
  useEffect(() => {
    if (pathRef.current) {
      const length = pathRef.current.getTotalLength()
      pathRef.current.style.strokeDasharray = `${length}`
      pathRef.current.style.strokeDashoffset = `${length}`
    }
  }, [fromRect, toRect])

  if (!fromRect || !toRect) {
    return null
  }

  // 计算起点和终点位置（元素中心）
  const startX = fromRect.left + fromRect.width / 2
  const startY = fromRect.top + fromRect.height / 2
  const endX = toRect.left + toRect.width / 2
  const endY = toRect.top + toRect.height / 2

  // 計算移動距離
  const deltaX = endX - startX
  const deltaY = endY - startY

  return (
    <div className="fixed inset-0 z-[9999] pointer-events-none" style={{ zIndex: 9999 }}>
      {/* CSS 動畫樣式 */}
      <style>{`
        @keyframes dragCard {
          0% {
            transform: translate(0, 0);
            opacity: 0;
          }
          20% {
            opacity: 1;
          }
          80% {
            opacity: 1;
          }
          100% {
            transform: translate(${deltaX}px, ${deltaY}px);
            opacity: 0.3;
          }
        }
        
        @keyframes dragCursor {
          0% {
            transform: translate(0, 0) scale(1);
            opacity: 0;
          }
          20% {
            opacity: 1;
          }
          80% {
            opacity: 1;
          }
          100% {
            transform: translate(${deltaX}px, ${deltaY}px) scale(0.8);
            opacity: 0;
          }
        }
        
        @keyframes pulseCircle {
          0%, 100% {
            transform: scale(1);
            opacity: 0.5;
          }
          50% {
            transform: scale(1.2);
            opacity: 0.8;
          }
        }
        
        @keyframes drawPath {
          0% {
            stroke-dashoffset: var(--path-length);
            opacity: 0;
          }
          10% {
            opacity: 1;
          }
          100% {
            stroke-dashoffset: 0;
            opacity: 1;
          }
        }
        
        .drag-card {
          animation: dragCard 2.5s ease-in-out infinite;
          animation-delay: 0s;
        }
        
        .drag-cursor {
          animation: dragCursor 2.5s ease-in-out infinite;
          animation-delay: 0s;
        }
        
        .pulse-circle-start {
          animation: pulseCircle 2s ease-in-out infinite;
        }
        
        .pulse-circle-end {
          animation: pulseCircle 2s ease-in-out infinite;
          animation-delay: 0.5s;
        }
        
        .draw-path {
          animation: drawPath 2.5s ease-in-out infinite;
        }
      `}</style>

      {/* 幽灵卡片 - 从起始位置移动到目标位置 */}
      <div
        className="absolute w-32 h-20 bg-blue-500/30 border-2 border-blue-500 rounded-lg shadow-lg drag-card"
        style={{
          left: startX - 64,
          top: startY - 40,
          zIndex: 9999
        }}
      />

      {/* 手形游标 */}
      <div
        className="absolute text-4xl drag-cursor"
        style={{
          left: startX - 12,
          top: startY - 12,
          zIndex: 9998
        }}
      >
        <span className="filter drop-shadow-lg">👆</span>
      </div>

      {/* 起点提示圆圈 */}
      <div
        className="absolute w-12 h-12 border-2 border-blue-400 rounded-full pulse-circle-start"
        style={{
          left: startX - 24,
          top: startY - 24,
          zIndex: 9997
        }}
      />

      {/* 终点提示圆圈 */}
      <div
        className="absolute w-12 h-12 border-2 border-green-400 rounded-full pulse-circle-end"
        style={{
          left: endX - 24,
          top: endY - 24,
          zIndex: 9997
        }}
      />

      {/* 虚线路径 */}
      <svg
        className="absolute inset-0 w-full h-full"
        style={{ pointerEvents: 'none', zIndex: 9996 }}
        viewBox={`0 0 ${window.innerWidth} ${window.innerHeight}`}
      >
        <defs>
          <marker id="arrowhead" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto">
            <polygon points="0 0, 10 3, 0 6" fill="rgba(59, 130, 246, 0.6)" />
          </marker>
        </defs>

        <path
          ref={pathRef}
          d={`M ${startX} ${startY} Q ${(startX + endX) / 2} ${(startY + endY) / 2 - 50} ${endX} ${endY}`}
          stroke="rgba(59, 130, 246, 0.4)"
          strokeWidth="2"
          fill="none"
          strokeDasharray="5,5"
          markerEnd="url(#arrowhead)"
          className="draw-path"
          style={{ '--path-length': '1000' } as React.CSSProperties}
        />
      </svg>
    </div>
  )
}
