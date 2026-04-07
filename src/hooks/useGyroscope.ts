import { useState, useEffect, useCallback, useRef } from 'react'

export type TiltStatus = 'flat' | 'slight' | 'tilted' | 'unavailable'

// 傾斜角度閾值
const TILT_WARN = 12
const TILT_OK = 5

interface UseGyroscopeReturn {
  tiltStatus: TiltStatus
  tiltAngle: number
  /** iOS 需要用戶手勢授權（尚未請求） */
  needsPermission: boolean
  /** 用戶已拒絕授權 */
  permissionDenied: boolean
  /** 觸發 iOS 授權請求（必須在 click handler 內呼叫） */
  requestPermission: () => Promise<'granted' | 'denied' | 'not-needed'>
}

export function useGyroscope(): UseGyroscopeReturn {
  const [tiltStatus, setTiltStatus] = useState<TiltStatus>('unavailable')
  const [tiltAngle, setTiltAngle] = useState(0)
  const [needsPermission, setNeedsPermission] = useState(false)
  const [permissionDenied, setPermissionDenied] = useState(false)
  const listeningRef = useRef(false)

  const handleOrientation = useCallback((e: DeviceOrientationEvent) => {
    const beta = e.beta ?? 0
    const gamma = e.gamma ?? 0
    const maxTilt = Math.max(Math.abs(beta), Math.abs(gamma))

    setTiltAngle(Math.round(maxTilt))

    if (maxTilt <= TILT_OK) {
      setTiltStatus('flat')
    } else if (maxTilt <= TILT_WARN) {
      setTiltStatus('slight')
    } else {
      setTiltStatus('tilted')
      if (navigator.vibrate) navigator.vibrate(50)
    }
  }, [])

  const startListening = useCallback(() => {
    if (listeningRef.current) return
    listeningRef.current = true
    window.addEventListener('deviceorientation', handleOrientation)
    setTiltStatus('flat')
  }, [handleOrientation])

  useEffect(() => {
    if (!('DeviceOrientationEvent' in window)) {
      setTiltStatus('unavailable')
      return
    }

    const DOE = DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<string>
    }
    if (typeof DOE.requestPermission === 'function') {
      setNeedsPermission(true)
    } else {
      startListening()
    }

    return () => {
      window.removeEventListener('deviceorientation', handleOrientation)
      listeningRef.current = false
    }
  }, [handleOrientation, startListening])

  const requestPermission = useCallback(async (): Promise<'granted' | 'denied' | 'not-needed'> => {
    const DOE = DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<string>
    }
    if (typeof DOE.requestPermission !== 'function') {
      return 'not-needed'
    }

    try {
      const result = await DOE.requestPermission()
      if (result === 'granted') {
        startListening()
        setNeedsPermission(false)
        setPermissionDenied(false)
        return 'granted'
      } else {
        setTiltStatus('unavailable')
        setNeedsPermission(false)
        setPermissionDenied(true)
        return 'denied'
      }
    } catch {
      setTiltStatus('unavailable')
      setNeedsPermission(false)
      setPermissionDenied(true)
      return 'denied'
    }
  }, [startListening])

  return { tiltStatus, tiltAngle, needsPermission, permissionDenied, requestPermission }
}
