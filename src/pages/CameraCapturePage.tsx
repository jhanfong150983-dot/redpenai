import { useRef, useState, useCallback, useEffect } from 'react'
import Webcam from 'react-webcam'
import { Camera, Upload, ArrowLeft, Loader, AlertCircle, CheckCircle, CameraOff, RefreshCw } from 'lucide-react'
import { compressImage } from '@/lib/imageCompression'
import CameraGuideOverlay from '@/components/CameraGuideOverlay'
import { useGyroscope } from '@/hooks/useGyroscope'

interface CameraCapturePageProps {
  studentId: string
  seatNumber: number
  name: string
  pagesPerStudent: number
  currentPageCount: number
  onCaptureComplete: (imageBlob: Blob) => void
  onBack: () => void
}

type CameraErrorType = 'denied' | 'notfound' | 'other' | null

export default function CameraCapturePage({
  seatNumber,
  name,
  pagesPerStudent,
  currentPageCount,
  onCaptureComplete,
  onBack
}: CameraCapturePageProps) {
  const webcamRef = useRef<Webcam>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const [captureSuccess, setCaptureSuccess] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isLandscape, setIsLandscape] = useState(false)
  const [cameraError, setCameraError] = useState<CameraErrorType>(null)
  const [webcamKey, setWebcamKey] = useState(0)
  const [retryCount, setRetryCount] = useState(0)
  const [showGate, setShowGate] = useState(true)

  const gyro = useGyroscope()

  // 綠色連續 0.5 秒才允許拍照（防止手持抖動造成按鈕閃爍）
  const [captureReady, setCaptureReady] = useState(false)
  useEffect(() => {
    if (gyro.tiltStatus !== 'flat') {
      setCaptureReady(false)
      return
    }
    const timer = setTimeout(() => setCaptureReady(true), 500)
    return () => clearTimeout(timer)
  }, [gyro.tiltStatus])

  // unavailable = 陀螺儀不支援，不套用限制
  const gyroBlocking = gyro.tiltStatus !== 'unavailable' && !captureReady

  // 調試：檢查 props
  useEffect(() => {
    console.log('📸 CameraCapturePage props:', {
      seatNumber,
      name,
      pagesPerStudent,
      currentPageCount
    })
  }, [seatNumber, name, pagesPerStudent, currentPageCount])

  // 監聽螢幕方向變化
  useEffect(() => {
    const updateLayout = () => {
      setIsLandscape(window.innerWidth > window.innerHeight)
    }
    updateLayout()
    window.addEventListener('resize', updateLayout)
    window.addEventListener('orientationchange', updateLayout)
    return () => {
      window.removeEventListener('resize', updateLayout)
      window.removeEventListener('orientationchange', updateLayout)
    }
  }, [])

  const handleCameraError = useCallback((err: string | DOMException) => {
    const name = err instanceof DOMException ? err.name : String(err)
    console.warn('📸 Camera error:', name)
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      setCameraError('denied')
    } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      setCameraError('notfound')
    } else {
      setCameraError('other')
    }
  }, [])

  const handleRetry = useCallback(() => {
    setCameraError(null)
    setRetryCount((c) => c + 1)
    setWebcamKey((k) => k + 1)
  }, [])

  const handleCapture = useCallback(async () => {
    if (!webcamRef.current) return

    setIsProcessing(true)
    setError(null)
    try {
      const imageSrc = webcamRef.current.getScreenshot()
      if (!imageSrc) {
        throw new Error('無法擷取影像')
      }

      // 壓縮圖片（格式自動檢測：桌面用WebP，平板用JPEG）
      const compressed = await compressImage(imageSrc, {
        maxWidth: 2000,
        quality: 0.85
      })

      // 成功動畫
      setCaptureSuccess(true)
      setTimeout(() => {
        setCaptureSuccess(false)
        onCaptureComplete(compressed)
      }, 500)
    } catch (error) {
      console.error('拍照失敗:', error)
      setError(error instanceof Error ? error.message : '拍照失敗')
    } finally {
      setIsProcessing(false)
    }
  }, [onCaptureComplete])

  const handleFileUpload = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      if (!file) return

      setIsProcessing(true)
      setError(null)
      try {
        const reader = new FileReader()
        const base64 = await new Promise<string>((resolve, reject) => {
          let timeoutId: number | null = null

          reader.onload = () => {
            if (timeoutId) clearTimeout(timeoutId)
            resolve(reader.result as string)
          }
          reader.onerror = () => {
            if (timeoutId) clearTimeout(timeoutId)
            reject(new Error('檔案讀取失敗'))
          }

          timeoutId = window.setTimeout(() => {
            reject(new Error('檔案讀取超時 - 檔案可能過大'))
          }, 10000)

          reader.readAsDataURL(file)
        })

        const compressed = await compressImage(base64, {
          maxWidth: 2000,
          quality: 0.85
        })

        setCaptureSuccess(true)
        setTimeout(() => {
          setCaptureSuccess(false)
          onCaptureComplete(compressed)
        }, 500)
      } catch (error) {
        console.error('上傳失敗:', error)
        setError(error instanceof Error ? error.message : '上傳失敗')
      } finally {
        setIsProcessing(false)
        event.target.value = ''
      }
    },
    [onCaptureComplete]
  )

  const triggerFileUpload = () => {
    fileInputRef.current?.click()
  }

  const actionBase =
    'w-14 h-14 rounded-full border border-white/70 text-white flex items-center justify-center transition disabled:opacity-40 disabled:cursor-not-allowed hover:bg-white/10'

  return (
    <div className="fixed inset-0 bg-black">
      {/* 隱藏的文件輸入 */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileUpload}
        className="hidden"
      />

      {/* 攝像頭畫面 */}
      <Webcam
        key={webcamKey}
        ref={webcamRef}
        audio={false}
        screenshotFormat="image/jpeg"
        videoConstraints={{
          facingMode: 'environment',
          width: 1920,
          height: 1080
        }}
        onUserMediaError={handleCameraError}
        className="absolute inset-0 w-full h-full object-cover"
      />

      {/* 拍照引導層：引導框 + 水平儀 */}
      {!cameraError && !showGate && (
        <CameraGuideOverlay
          isLandscape={isLandscape}
          tiltStatus={gyro.tiltStatus}
          tiltAngle={gyro.tiltAngle}
        />
      )}

      {/* 準備拍照閘門畫面 */}
      {showGate && !cameraError && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-black/80 backdrop-blur-sm px-6 text-center">
          {gyro.permissionDenied ? (
            <>
              <div className="w-16 h-16 rounded-full bg-amber-500/20 flex items-center justify-center mb-4">
                <AlertCircle className="w-8 h-8 text-amber-400" />
              </div>
              <h2 className="text-lg font-bold text-white mb-2">需要角度感測權限</h2>
              <p className="text-sm text-slate-300 mb-1">
                你剛才拒絕了動態感測權限。
              </p>
              <p className="text-sm text-slate-300 mb-6">
                請按下方按鈕重新整理頁面，並在彈出視窗時按<strong className="text-white">「允許」</strong>。
              </p>
              <button
                type="button"
                onClick={() => location.reload()}
                className="inline-flex items-center gap-2 rounded-xl bg-amber-600 px-8 py-3 text-sm font-semibold text-white hover:bg-amber-500 active:scale-95 transition"
              >
                <RefreshCw className="h-4 w-4" />
                重新整理頁面
              </button>
              <button
                type="button"
                onClick={onBack}
                className="mt-3 text-sm text-slate-400 hover:text-slate-200"
              >
                返回
              </button>
            </>
          ) : (
            <>
              <div className="w-16 h-16 rounded-full bg-sky-500/20 flex items-center justify-center mb-4">
                <Camera className="w-8 h-8 text-sky-400" />
              </div>
              <h2 className="text-lg font-bold text-white mb-2">準備拍照</h2>
              <p className="text-sm text-slate-300 mb-1">
                座號 {seatNumber}　{name}
              </p>
              <p className="text-sm text-slate-400 mb-6">
                系統會開啟角度輔助，幫助你拍出清晰的作業照片。
              </p>
              <button
                type="button"
                onClick={async () => {
                  if (gyro.needsPermission) {
                    await gyro.requestPermission()
                  }
                  // 不論結果（granted / denied / not-needed），
                  // 如果沒有 permissionDenied 就進入相機
                  if (!gyro.permissionDenied) {
                    setShowGate(false)
                  }
                }}
                className="inline-flex items-center gap-2 rounded-xl bg-sky-600 px-8 py-3 text-sm font-semibold text-white hover:bg-sky-500 active:scale-95 transition"
              >
                <Camera className="h-4 w-4" />
                開始拍照
              </button>
              <button
                type="button"
                onClick={onBack}
                className="mt-3 text-sm text-slate-400 hover:text-slate-200"
              >
                返回
              </button>
            </>
          )}
        </div>
      )}

      {/* 相機授權失敗畫面 */}
      {cameraError && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-slate-900 px-6 text-center">
          <CameraOff className="mb-4 h-16 w-16 text-slate-400" />

          <h2 className="text-xl font-bold text-white">
            {cameraError === 'notfound' ? '找不到相機' : '相機未授權'}
          </h2>

          <p className="mt-2 text-sm text-slate-300">
            {cameraError === 'notfound'
              ? '這台裝置可能沒有相機，或相機正被其他程式使用中。'
              : '請允許瀏覽器使用相機，才能拍照上傳作業。'}
          </p>

          {/* 重試後仍失敗的額外提示 */}
          {cameraError === 'denied' && retryCount > 0 && (
            <p className="mt-2 flex items-center gap-1 text-sm text-red-400">
              <AlertCircle className="h-4 w-4 shrink-0" />
              仍然無法啟動相機，請確認已在設定中允許。
            </p>
          )}

          {/* 操作說明（僅授權被拒時顯示） */}
          {cameraError === 'denied' && (
            <div className="mt-5 w-full max-w-sm rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-left">
              <p className="mb-1.5 text-xs font-semibold text-amber-300">
                如果一直沒有出現授權請求：
              </p>
              <p className="text-xs leading-relaxed text-amber-200">
                請點網址列旁的 🔒 圖示，找到相機設定，改為「允許」後再按重新嘗試。
              </p>
            </div>
          )}

          {/* 按鈕 */}
          <div className="mt-8 flex flex-col items-center gap-3">
            {cameraError !== 'notfound' && (
              <button
                type="button"
                onClick={handleRetry}
                className="inline-flex items-center gap-2 rounded-xl bg-sky-600 px-8 py-3 text-sm font-semibold text-white hover:bg-sky-500 active:scale-95"
              >
                <RefreshCw className="h-4 w-4" />
                重新嘗試
              </button>
            )}
            <button
              type="button"
              onClick={onBack}
              className="text-sm text-slate-400 hover:text-slate-200"
            >
              返回
            </button>
          </div>
        </div>
      )}

      {/* 成功提示動畫 */}
      {captureSuccess && (
        <>
          <div className="absolute inset-0 bg-green-500 bg-opacity-20 animate-pulse z-10" />
          <div className={`absolute ${
            isLandscape
              ? 'right-4 top-1/2 -translate-y-1/2'
              : 'bottom-24 left-1/2 -translate-x-1/2'
          } z-20`}>
            <div className="relative">
              <div className="absolute w-12 h-12 bg-white rounded-lg shadow-lg flex items-center justify-center animate-ping">
                <Camera className="w-6 h-6 text-green-600" />
              </div>
              <div className="w-12 h-12 bg-white rounded-lg shadow-lg flex items-center justify-center">
                <CheckCircle className="w-6 h-6 text-green-600" />
              </div>
            </div>
          </div>
        </>
      )}

      {/* 處理中遮罩 */}
      {isProcessing && (
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-30">
          <div className="text-center text-white">
            <Loader className="w-12 h-12 mx-auto mb-3 animate-spin" />
            <p className="text-lg font-semibold">處理中...</p>
          </div>
        </div>
      )}

      {/* 頂部資訊欄（授權失敗時隱藏） */}
      {!cameraError && (
        <div className="absolute top-0 left-0 right-0 p-4 text-white drop-shadow-[0_2px_6px_rgba(0,0,0,0.6)]">
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={onBack}
              className="flex items-center gap-2 text-white hover:text-white/80 transition-colors"
            >
              <ArrowLeft className="w-5 h-5" />
              <span className="font-medium">返回選擇</span>
            </button>
            <div className="flex items-center gap-2">
              <div className="w-2.5 h-2.5 bg-red-500 rounded-full animate-pulse"></div>
              <span className="text-sm font-medium">拍攝中</span>
            </div>
          </div>
        </div>
      )}

      {/* 座號 / 名稱資訊（授權失敗時隱藏） */}
      {!cameraError && (
        <div
          className={`absolute left-4 ${
            isLandscape ? 'bottom-4' : 'bottom-24'
          } text-white drop-shadow-[0_2px_6px_rgba(0,0,0,0.6)]`}
        >
          <div className="text-[11px] text-white/80">座號 {seatNumber}</div>
          <div className="text-sm font-semibold">{name}</div>
          <div className="text-[11px] text-white/80">
            已完成 {currentPageCount} / {pagesPerStudent} 張
          </div>
        </div>
      )}

      {/* 拍照錯誤提示（授權失敗時隱藏） */}
      {!cameraError && error && (
        <div className="absolute left-1/2 top-16 -translate-x-1/2 text-xs text-red-200 drop-shadow-[0_2px_6px_rgba(0,0,0,0.8)] z-20">
          <span className="inline-flex items-center gap-1">
            <AlertCircle className="w-3.5 h-3.5" />
            {error}
          </span>
        </div>
      )}

      {/* 操作按鈕（授權失敗時隱藏） */}
      {!cameraError && (
        <div
          className={`absolute ${
            isLandscape
              ? 'right-4 top-1/2 -translate-y-1/2 flex-col'
              : 'left-0 right-0 bottom-5 flex-col items-center'
          } flex gap-2`}
        >
          {/* 陀螺儀提示文字 */}
          {gyroBlocking && !isProcessing && (
            <p className="text-xs text-yellow-300 text-center drop-shadow-[0_1px_4px_rgba(0,0,0,0.8)]">
              請拿平手機，角度正確後即可拍照
            </p>
          )}
          <div className={`flex items-center gap-3 ${isLandscape ? 'flex-col' : 'flex-row justify-center'}`}>
            <button
              onClick={triggerFileUpload}
              disabled={isProcessing}
              className={actionBase}
              aria-label="上傳作業"
              title="上傳"
            >
              <Upload className="w-5 h-5" />
            </button>
            <button
              onClick={handleCapture}
              disabled={isProcessing || gyroBlocking}
              className={`${actionBase} w-16 h-16 ${isProcessing || gyroBlocking ? 'scale-95 opacity-40' : 'hover:scale-105'}`}
              aria-label="拍照"
              title="拍照"
            >
              <Camera className="w-6 h-6" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
