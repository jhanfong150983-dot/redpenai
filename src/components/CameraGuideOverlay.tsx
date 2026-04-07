import { useState, useEffect, useCallback, useRef } from 'react'

/**
 * 相機拍照引導層：
 * - 方案 C：半透明引導框，A4 比例虛線框 + 四角標記
 * - 方案 A：DeviceOrientation 水平儀，偵測傾斜角度並提示
 */

interface Props {
  /** 是否為橫式佈局（影響水平儀顯示位置） */
  isLandscape?: boolean
}

// 傾斜角度閾值
const TILT_WARN = 12   // > 12° 顯示紅色警告
const TILT_OK = 5      // < 5° 顯示綠色

type TiltStatus = 'flat' | 'slight' | 'tilted' | 'unavailable'

export default function CameraGuideOverlay({ isLandscape = false }: Props) {
  const [tiltStatus, setTiltStatus] = useState<TiltStatus>('unavailable')
  const [tiltAngle, setTiltAngle] = useState(0)
  const [permissionNeeded, setPermissionNeeded] = useState(false)
  const requestedRef = useRef(false)

  // ── 方案 A：DeviceOrientation 水平儀 ──
  const handleOrientation = useCallback((e: DeviceOrientationEvent) => {
    // beta: 前後傾斜 (平放≈0, 直立≈90)
    // gamma: 左右傾斜 (平放≈0)
    const beta = e.beta ?? 0
    const gamma = e.gamma ?? 0

    // 計算與水平面的偏離角度
    // 平放時 beta≈0, gamma≈0; 我們只關心「是否平放」
    const absBeta = Math.abs(beta)
    const absGamma = Math.abs(gamma)
    const maxTilt = Math.max(absBeta, absGamma)

    setTiltAngle(Math.round(maxTilt))

    if (maxTilt <= TILT_OK) {
      setTiltStatus('flat')
    } else if (maxTilt <= TILT_WARN) {
      setTiltStatus('slight')
    } else {
      setTiltStatus('tilted')
      // 傾斜過大時震動提醒（如果支援）
      if (navigator.vibrate) {
        navigator.vibrate(50)
      }
    }
  }, [])

  const startListening = useCallback(() => {
    window.addEventListener('deviceorientation', handleOrientation)
    setTiltStatus('flat') // 假設初始平放
  }, [handleOrientation])

  useEffect(() => {
    // 檢查是否支援 DeviceOrientation
    if (!('DeviceOrientationEvent' in window)) {
      setTiltStatus('unavailable')
      return
    }

    // iOS 13+ 需要用戶手勢授權
    const DOE = DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<string>
    }
    if (typeof DOE.requestPermission === 'function') {
      // iOS：需要用戶點擊觸發，先標記 permissionNeeded
      setPermissionNeeded(true)
    } else {
      // Android / 其他：直接監聽
      startListening()
    }

    return () => {
      window.removeEventListener('deviceorientation', handleOrientation)
    }
  }, [handleOrientation, startListening])

  const requestPermission = useCallback(async () => {
    if (requestedRef.current) return
    requestedRef.current = true

    try {
      const DOE = DeviceOrientationEvent as unknown as {
        requestPermission: () => Promise<string>
      }
      const result = await DOE.requestPermission()
      if (result === 'granted') {
        startListening()
        setPermissionNeeded(false)
      } else {
        setTiltStatus('unavailable')
        setPermissionNeeded(false)
      }
    } catch {
      setTiltStatus('unavailable')
      setPermissionNeeded(false)
    }
  }, [startListening])

  // ── 水平儀顏色 ──
  const tiltColor =
    tiltStatus === 'flat'
      ? 'text-green-400'
      : tiltStatus === 'slight'
        ? 'text-yellow-400'
        : tiltStatus === 'tilted'
          ? 'text-red-400'
          : 'text-white/0' // unavailable: 隱藏

  const tiltBgColor =
    tiltStatus === 'flat'
      ? 'bg-green-500/20 border-green-400/60'
      : tiltStatus === 'slight'
        ? 'bg-yellow-500/20 border-yellow-400/60'
        : tiltStatus === 'tilted'
          ? 'bg-red-500/20 border-red-400/60'
          : ''

  const tiltLabel =
    tiltStatus === 'flat'
      ? '✓ 角度正確'
      : tiltStatus === 'slight'
        ? `稍微傾斜 ${tiltAngle}°`
        : tiltStatus === 'tilted'
          ? `傾斜過大 ${tiltAngle}°`
          : ''

  // 引導框的角落長度
  const cornerLen = 'min(8vw, 40px)'

  return (
    <>
      {/* ── 方案 C：引導框 ── */}
      <div className="absolute inset-0 z-[5] pointer-events-none">
        {/* 中央引導框（約佔畫面 80%，A4 比例） */}
        <div
          className="absolute left-[10%] right-[10%] top-[8%] bottom-[18%]"
          style={{ maxWidth: '85%', maxHeight: '80%' }}
        >
          {/* 虛線邊框 */}
          <div className="absolute inset-0 border-2 border-dashed border-white/40 rounded-lg" />

          {/* 四角 L 型標記 — 左上 */}
          <div
            className="absolute top-0 left-0 border-t-[3px] border-l-[3px] border-white/80 rounded-tl-md"
            style={{ width: cornerLen, height: cornerLen }}
          />
          {/* 右上 */}
          <div
            className="absolute top-0 right-0 border-t-[3px] border-r-[3px] border-white/80 rounded-tr-md"
            style={{ width: cornerLen, height: cornerLen }}
          />
          {/* 左下 */}
          <div
            className="absolute bottom-0 left-0 border-b-[3px] border-l-[3px] border-white/80 rounded-bl-md"
            style={{ width: cornerLen, height: cornerLen }}
          />
          {/* 右下 */}
          <div
            className="absolute bottom-0 right-0 border-b-[3px] border-r-[3px] border-white/80 rounded-br-md"
            style={{ width: cornerLen, height: cornerLen }}
          />

          {/* 中央提示文字 */}
          <div className="absolute inset-x-0 top-2 flex justify-center">
            <span className="text-[11px] text-white/60 bg-black/30 px-2 py-0.5 rounded">
              請將作業對齊框線
            </span>
          </div>
        </div>
      </div>

      {/* ── 方案 A：水平儀指示 ── */}
      {tiltStatus !== 'unavailable' && (
        <div
          className={`absolute z-[6] pointer-events-none ${
            isLandscape
              ? 'left-3 top-1/2 -translate-y-1/2'
              : 'left-1/2 -translate-x-1/2 top-12'
          }`}
        >
          <div
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium backdrop-blur-sm ${tiltBgColor} ${tiltColor}`}
          >
            {/* 簡易水平儀圖示 */}
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

      {/* iOS 授權按鈕 */}
      {permissionNeeded && (
        <div className="absolute z-[7] left-1/2 -translate-x-1/2 top-12">
          <button
            type="button"
            onClick={requestPermission}
            className="pointer-events-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-blue-600/80 border border-blue-400/60 text-white text-xs font-medium backdrop-blur-sm hover:bg-blue-500/80 active:scale-95 transition"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <rect x="1" y="6" width="14" height="4" rx="2" stroke="currentColor" strokeWidth="1.2" />
              <circle cx="8" cy="8" r="2" fill="currentColor" />
            </svg>
            啟用角度輔助
          </button>
        </div>
      )}
    </>
  )
}
