import type { TiltStatus } from '@/hooks/useGyroscope'
import { CAMERA_FRAME } from '@/lib/cameraGuide'

/**
 * 相機拍照引導層（純視覺元件）：
 * - 引導框 + 四角標記（顏色反映傾斜狀態）
 * - 引導框內半透明底色
 * - 小型水平儀 badge
 * 傾斜狀態由父元件透過 useGyroscope hook 提供。
 */

interface Props {
  isLandscape?: boolean
  tiltStatus?: TiltStatus
  tiltAngle?: number
}

export default function CameraGuideOverlay({
  isLandscape = false,
  tiltStatus = 'unavailable',
  tiltAngle = 0
}: Props) {
  // ── 顏色映射 ──
  const borderColor =
    tiltStatus === 'flat'
      ? 'border-green-400/70'
      : tiltStatus === 'slight'
        ? 'border-yellow-400/70'
        : tiltStatus === 'tilted'
          ? 'border-red-400/70'
          : 'border-white/40'

  const bgOverlay =
    tiltStatus === 'flat'
      ? 'bg-green-500/10'
      : tiltStatus === 'slight'
        ? 'bg-yellow-500/10'
        : tiltStatus === 'tilted'
          ? 'bg-red-500/10'
          : ''

  const cornerColor =
    tiltStatus === 'flat'
      ? 'border-green-400'
      : tiltStatus === 'slight'
        ? 'border-yellow-400'
        : tiltStatus === 'tilted'
          ? 'border-red-400'
          : 'border-white/80'

  const badgeColor =
    tiltStatus === 'flat'
      ? 'bg-green-500/20 border-green-400/60 text-green-400'
      : tiltStatus === 'slight'
        ? 'bg-yellow-500/20 border-yellow-400/60 text-yellow-400'
        : tiltStatus === 'tilted'
          ? 'bg-red-500/20 border-red-400/60 text-red-400'
          : ''

  const tiltLabel =
    tiltStatus === 'flat'
      ? '✓ 角度正確'
      : tiltStatus === 'slight'
        ? `稍微傾斜 ${tiltAngle}°`
        : tiltStatus === 'tilted'
          ? `傾斜過大 ${tiltAngle}°`
          : ''

  const cornerLen = 'min(8vw, 40px)'

  return (
    <>
      {/* ── 引導框 ── */}
      <div className="absolute inset-0 z-[5] pointer-events-none">
        <div
          className="absolute"
          style={{
            left: `${CAMERA_FRAME.LEFT * 100}%`,
            right: `${CAMERA_FRAME.RIGHT * 100}%`,
            top: `${CAMERA_FRAME.TOP * 100}%`,
            bottom: `${CAMERA_FRAME.BOTTOM * 100}%`,
          }}
        >
          {/* 半透明底色 */}
          <div className={`absolute inset-0 rounded-lg transition-colors duration-300 ${bgOverlay}`} />

          {/* 虛線邊框 */}
          <div className={`absolute inset-0 border-2 border-dashed rounded-lg transition-colors duration-300 ${borderColor}`} />

          {/* 四角 L 型標記 */}
          <div
            className={`absolute top-0 left-0 border-t-[3px] border-l-[3px] rounded-tl-md transition-colors duration-300 ${cornerColor}`}
            style={{ width: cornerLen, height: cornerLen }}
          />
          <div
            className={`absolute top-0 right-0 border-t-[3px] border-r-[3px] rounded-tr-md transition-colors duration-300 ${cornerColor}`}
            style={{ width: cornerLen, height: cornerLen }}
          />
          <div
            className={`absolute bottom-0 left-0 border-b-[3px] border-l-[3px] rounded-bl-md transition-colors duration-300 ${cornerColor}`}
            style={{ width: cornerLen, height: cornerLen }}
          />
          <div
            className={`absolute bottom-0 right-0 border-b-[3px] border-r-[3px] rounded-br-md transition-colors duration-300 ${cornerColor}`}
            style={{ width: cornerLen, height: cornerLen }}
          />

          {/* 中央浮水印提示文字 */}
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-3xl font-bold text-white/20 text-center leading-snug select-none"
              style={{ textShadow: '0 2px 8px rgba(0,0,0,0.4)' }}>
              請將作業<br />對齊框線
            </span>
          </div>
        </div>
      </div>

      {/* ── 水平儀 badge ── */}
      {tiltStatus !== 'unavailable' && (
        <div
          className={`absolute z-[6] pointer-events-none ${
            isLandscape
              ? 'left-3 top-1/2 -translate-y-1/2'
              : 'left-1/2 -translate-x-1/2 top-12'
          }`}
        >
          <div
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium backdrop-blur-sm transition-colors duration-300 ${badgeColor}`}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="shrink-0">
              <rect x="1" y="6" width="14" height="4" rx="2" stroke="currentColor" strokeWidth="1.2" />
              <circle
                cx={8 + Math.min(Math.max(tiltAngle * (tiltStatus === 'flat' ? 0 : 0.5), -5), 5)}
                cy="8"
                r="2.2"
                fill="currentColor"
                opacity="0.9"
              />
            </svg>
            {tiltLabel}
          </div>
        </div>
      )}
    </>
  )
}
