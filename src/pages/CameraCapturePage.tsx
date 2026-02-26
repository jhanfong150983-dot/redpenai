import { useRef, useState, useCallback, useEffect } from 'react'
import Webcam from 'react-webcam'
import { Camera, Upload, ArrowLeft, Loader, AlertCircle, CheckCircle } from 'lucide-react'
import { compressImage } from '@/lib/imageCompression'

interface CameraCapturePageProps {
  studentId: string
  seatNumber: number
  name: string
  pagesPerStudent: number
  currentPageCount: number
  onCaptureComplete: (imageBlob: Blob) => void
  onBack: () => void
}

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
        maxWidth: 1024,
        quality: 0.8
        // format 參數移除，使用 compressImage 內部的自動檢測
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
        // 讀取檔案為 base64（添加 timeout 保護）
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

          // 添加 timeout（10秒）
          timeoutId = window.setTimeout(() => {
            reject(new Error('檔案讀取超時 - 檔案可能過大'))
          }, 10000)

          reader.readAsDataURL(file)
        })

        // 壓縮圖片（格式自動檢測：桌面用WebP，平板用JPEG）
        const compressed = await compressImage(base64, {
          maxWidth: 1024,
          quality: 0.8
          // format 參數移除，使用 compressImage 內部的自動檢測
        })

        // 成功動畫
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

      {/* 攝像頭畫面 - 滿版顯示 */}
      <Webcam
        ref={webcamRef}
        audio={false}
        screenshotFormat="image/jpeg"
        videoConstraints={{
          facingMode: 'environment',
          width: 1920,
          height: 1080
        }}
        className="absolute inset-0 w-full h-full object-cover"
      />

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

      {/* 頂部資訊欄 */}
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

      {/* 座號 / 名稱資訊 */}
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

      {/* 錯誤提示 */}
      {error && (
        <div className="absolute left-1/2 top-16 -translate-x-1/2 text-xs text-red-200 drop-shadow-[0_2px_6px_rgba(0,0,0,0.8)] z-20">
          <span className="inline-flex items-center gap-1">
            <AlertCircle className="w-3.5 h-3.5" />
            {error}
          </span>
        </div>
      )}

      {/* 操作按鈕：直式在下方、橫式在右側 */}
      <div
        className={`absolute ${
          isLandscape
            ? 'right-4 top-1/2 -translate-y-1/2 flex-col'
            : 'left-0 right-0 bottom-5 flex-row justify-center'
        } flex items-center gap-3`}
      >
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
          disabled={isProcessing}
          className={`${actionBase} w-16 h-16 ${isProcessing ? 'scale-95' : 'hover:scale-105'}`}
          aria-label="拍照"
          title="拍照"
        >
          <Camera className="w-6 h-6" />
        </button>
      </div>
    </div>
  )
}
