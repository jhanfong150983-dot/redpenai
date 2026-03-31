import { useRef, useState, useEffect, useCallback } from 'react'
import Webcam from 'react-webcam'
import { Camera, Mic, MicOff, CheckCircle, AlertCircle, Upload, X, ShoppingCart } from 'lucide-react'
import { useSeatController } from '@/hooks/useSeatController'
import { db, generateId, getCurrentTimestamp } from '@/lib/db'
import { requestSync } from '@/lib/sync-events'
import { queueDeleteMany } from '@/lib/sync-delete-queue'
import { compressImage, blobToBase64 } from '@/lib/imageCompression'
import { convertPdfToImage, getFileType } from '@/lib/pdfToImage'
import { safeToBlobWithFallback } from '@/lib/canvasToBlob'
import { isIndexedDbBlobError, shouldAvoidIndexedDbBlob } from '@/lib/blob-storage'
import type { Student, Submission } from '@/lib/db'

interface ScannerPageProps {
  classroomId: string
  assignmentId: string
  maxSeat: number
  pagesPerStudent: number
}

function loadImgElement(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('圖片載入失敗')) }
    img.src = url
  })
}

async function mergePageBlobs(pageBlobs: Blob[]): Promise<{ blob: Blob; pageBreaks: number[] }> {
  if (pageBlobs.length === 1) return { blob: pageBlobs[0], pageBreaks: [] }

  try {
    // 驗證所有 Blob 都有效
    for (let i = 0; i < pageBlobs.length; i++) {
      if (!pageBlobs[i] || pageBlobs[i].size === 0) {
        throw new Error(`第 ${i + 1} 頁的圖片無效或為空`)
      }
    }

    // 用 <img> 載入：瀏覽器會自動套用 EXIF 旋轉，取得正確的顯示尺寸
    const imgs = await Promise.all(pageBlobs.map(loadImgElement))
    const targetWidth = Math.max(...imgs.map((img) => img.naturalWidth))
    // 每張圖縮放到同一寬度，各自保持原始長寬比
    const scaledHeights = imgs.map((img) =>
      Math.round((targetWidth / img.naturalWidth) * img.naturalHeight)
    )
    const totalHeight = scaledHeights.reduce((sum, h) => sum + h, 0)

    // 計算頁面邊界（累積高度比例，不含最後一頁）
    // 例：3 頁高度 [400, 600, 500] → pageBreaks = [0.267, 0.667]
    const pageBreaks: number[] = []
    let cumulative = 0
    for (let i = 0; i < scaledHeights.length - 1; i++) {
      cumulative += scaledHeights[i]
      pageBreaks.push(parseFloat((cumulative / totalHeight).toFixed(4)))
    }

    console.log(`🖼️ 合併 ${pageBlobs.length} 頁圖片: ${targetWidth}x${totalHeight}px, pageBreaks=${JSON.stringify(pageBreaks)}`)

    const canvas = document.createElement('canvas')
    canvas.width = targetWidth
    canvas.height = totalHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('無法建立畫布')

    let offsetY = 0
    imgs.forEach((img, i) => {
      ctx.drawImage(img, 0, offsetY, targetWidth, scaledHeights[i])
      offsetY += scaledHeights[i]
    })

    // 使用安全的 toBlob 包裝器（帶自動 fallback 和 timeout 保護）
    const merged = await safeToBlobWithFallback(canvas, {
      format: 'image/webp', // 平板不支持時會自動 fallback 到 JPEG
      quality: 0.85
    })

    console.log(`✅ 合併完成: ${(merged.size / 1024).toFixed(2)} KB, type: ${merged.type}`)
    return { blob: merged, pageBreaks }
  } catch (error) {
    console.error('❌ 合併圖片失敗:', error)
    throw new Error(`合併圖片失敗: ${error instanceof Error ? error.message : '未知錯誤'}`)
  }
}

export default function ScannerPage({
  classroomId,
  assignmentId,
  maxSeat,
  pagesPerStudent
}: ScannerPageProps) {
  const webcamRef = useRef<Webcam>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [currentStudent, setCurrentStudent] = useState<Student | null>(null)
  const [students, setStudents] = useState<Student[]>([])
  const [isCapturing, setIsCapturing] = useState(false)
  const [captureSuccess, setCaptureSuccess] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 批量模式：暫存所有學生的圖片
  const [capturedImages, setCapturedImages] = useState<
    Map<string, { blobs: Blob[]; urls: string[] }>
  >(new Map())
  const [showConfirmation, setShowConfirmation] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isLandscape, setIsLandscape] = useState(false)
  const [previewStudentId, setPreviewStudentId] = useState<string | null>(null)
  const avoidBlobStorage = shouldAvoidIndexedDbBlob()

  // 調試：打印接收到的 props
  useEffect(() => {
    console.log('📋 ScannerPage 接收到的參數:')
    console.log(`   classroomId: ${classroomId}`)
    console.log(`   assignmentId: ${assignmentId}`)
    console.log(`   maxSeat: ${maxSeat}`)
    console.log(`   pagesPerStudent: ${pagesPerStudent}`)
  }, [classroomId, assignmentId, maxSeat, pagesPerStudent])

  const requiredPages = Math.max(1, Math.round(pagesPerStudent || 1))

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

  // 使用座號控制器
  const {
    currentSeat,
    nextSeat,
    isListening,
    startListening,
    stopListening,
    isSupported: isVoiceSupported
  } = useSeatController({
    maxSeat,
    onSeatChange: async (seat) => {
      console.log('切換到座號:', seat)
      await loadStudentInfo(seat)
    }
  })

  /**
   * 載入學生資訊
   */
  const loadStudentInfo = useCallback(async (seatNumber: number) => {
    try {
      const student = await db.students
        .where('classroomId')
        .equals(classroomId)
        .and((s) => s.seatNumber === seatNumber)
        .first()

      if (student) {
        setCurrentStudent(student)
        setError(null)
      } else {
        setCurrentStudent(null)
        setError(`找不到第 ${seatNumber} 號學生`)
      }
    } catch (err) {
      console.error('載入學生資訊失敗:', err)
      setError('載入學生資訊失敗')
      setCurrentStudent(null)
    }
  }, [classroomId])

  /**
   * 暫存圖片（不保存到資料庫）
   */
  const storeImage = useCallback(async (imageBlob: Blob) => {
    if (!currentStudent) {
      throw new Error('當前學生資訊未載入')
    }

    const existing = capturedImages.get(currentStudent.id)
    const existingCount = existing?.blobs.length ?? 0
    const shouldReset = existingCount >= requiredPages
    const nextCount = shouldReset ? 1 : existingCount + 1

    // 創建預覽 URL
    const previewUrl = URL.createObjectURL(imageBlob)

    // 暫存到 Map 中
    setCapturedImages(prev => {
      const newMap = new Map(prev)
      const current = prev.get(currentStudent.id)
      const existingBlobs = current?.blobs ?? []
      const existingUrls = current?.urls ?? []

      if (existingBlobs.length >= requiredPages) {
        existingUrls.forEach((url) => URL.revokeObjectURL(url))
        newMap.set(currentStudent.id, { blobs: [imageBlob], urls: [previewUrl] })
        return newMap
      }

      newMap.set(currentStudent.id, {
        blobs: [...existingBlobs, imageBlob],
        urls: [...existingUrls, previewUrl]
      })
      return newMap
    })

    console.log(`✅ 已暫存 ${currentStudent.name} 的作業`)

    // 顯示成功提示
    setCaptureSuccess(true)

    if (nextCount >= requiredPages) {
      // 自動切換到下一位
      setTimeout(() => {
        nextSeat()
        setCaptureSuccess(false)
      }, 500)
    } else {
      setTimeout(() => {
        setCaptureSuccess(false)
      }, 500)
    }
  }, [currentStudent, nextSeat, requiredPages])

  /**
   * 拍照並暫存
   */
  const capture = useCallback(async () => {
    if (!webcamRef.current || !currentStudent) {
      setError('無法拍照：攝像頭未準備好或學生資訊未載入')
      return
    }

    setIsCapturing(true)
    setError(null)

    try {
      // 1. 獲取截圖 (Base64)
      const imageSrc = webcamRef.current.getScreenshot()
      if (!imageSrc) {
        throw new Error('無法獲取截圖')
      }

      console.log('📸 截圖成功')

      // 2. 壓縮圖片
      console.log('🔄 開始壓縮圖片...')
      const compressedBlob = await compressImage(imageSrc, {
        maxWidth: 1024,
        quality: 0.8
        // format 會根據瀏覽器自動選擇（Safari 用 JPEG，其他用 WebP）
      })

      // 估算原始大小（Base64 約為原始的 4/3 倍）
      const estimatedOriginalSize = imageSrc.length * 3 / 4
      
      // 如果壓縮後反而變大，使用原始圖片
      let finalBlob = compressedBlob
      if (compressedBlob.size > estimatedOriginalSize) {
        console.log(`⚠️ 壓縮後反而變大 (${(compressedBlob.size / 1024).toFixed(2)} KB > ${(estimatedOriginalSize / 1024).toFixed(2)} KB)，使用原始圖片`)
        // 將原始 Base64 轉為 Blob
        const response = await fetch(imageSrc)
        finalBlob = await response.blob()
      }

      console.log(`✅ 最終大小: ${(finalBlob.size / 1024).toFixed(2)} KB`)

      // 3. 暫存圖片
      await storeImage(finalBlob)

    } catch (err) {
      console.error('拍照失敗:', err)
      setError(err instanceof Error ? err.message : '拍照失敗')
    } finally {
      setIsCapturing(false)
    }
  }, [currentStudent, storeImage])

  /**
   * 處理文件上傳並暫存
   */
  const handleFileUpload = useCallback(async (file: File) => {
    if (!currentStudent) {
      setError('請先選擇學生')
      return
    }

    setIsCapturing(true)
    setError(null)

    try {
      const fileType = getFileType(file)
      console.log(`📁 文件類型: ${fileType}, 文件名: ${file.name}`)

      let imageBlob: Blob

      if (fileType === 'image') {
        // 處理圖片文件
        console.log('🖼️ 處理圖片文件...', { fileName: file.name, fileSize: file.size, fileType: file.type })

        // 讀取圖片並壓縮
        const reader = new FileReader()
        const dataUrl = await new Promise<string>((resolve, reject) => {
          reader.onload = (e) => {
            if (e.target?.result && typeof e.target.result === 'string') {
              resolve(e.target.result)
            } else {
              reject(new Error('圖片讀取失敗'))
            }
          }
          reader.onerror = reject
          reader.readAsDataURL(file)
        })

        console.log('✅ 圖片讀取完成，開始壓縮...')

        // 壓縮圖片
        const compressedImageBlob = await compressImage(dataUrl, {
          maxWidth: 1024,
          quality: 0.8
          // format 會根據瀏覽器自動選擇（Safari 用 JPEG，其他用 WebP）
        })

        // 如果壓縮後反而變大，使用原始檔案
        if (compressedImageBlob.size > file.size) {
          console.log(`⚠️ 壓縮後反而變大 (${(compressedImageBlob.size / 1024).toFixed(2)} KB > ${(file.size / 1024).toFixed(2)} KB)，使用原始檔案`)
          imageBlob = file
        } else {
          imageBlob = compressedImageBlob
        }

        console.log(`✅ 最終圖片大小: ${(imageBlob.size / 1024).toFixed(2)} KB, type: ${imageBlob.type}`)

      } else if (fileType === 'pdf') {
        // 處理 PDF 文件
        console.log('📄 處理 PDF 文件...')

        // 將 PDF 第一頁轉換為圖片
        imageBlob = await convertPdfToImage(file, {
          scale: 2,
          quality: 0.8
          // format 會根據瀏覽器自動選擇（Safari 用 JPEG，其他用 WebP）
        })

        console.log(`✅ PDF 轉換完成: ${(imageBlob.size / 1024).toFixed(2)} KB, type: ${imageBlob.type}`)

      } else {
        throw new Error('不支援的文件格式，請上傳圖片或 PDF 文件')
      }

      // 暫存圖片
      await storeImage(imageBlob)

    } catch (err) {
      console.error('文件上傳失敗:', err)
      setError(err instanceof Error ? err.message : '文件上傳失敗')
    } finally {
      setIsCapturing(false)
    }
  }, [currentStudent, storeImage])

  /**
   * 批量確認送出所有作業
   */
  const handleBatchSubmit = useCallback(async () => {
    if (capturedImages.size === 0) {
      setError('沒有任何作業需要送出')
      return
    }

    // 檢查是否有已完成的學生
    const completedStudents = Array.from(capturedImages.entries())
      .filter(([, data]) => data.blobs.length >= requiredPages)

    if (completedStudents.length === 0) {
      setError('沒有已完成的作業可以送出。請先完成至少一位學生的拍攝，或刪除未完成的作業。')
      return
    }

    // 檢查未完成的學生
    const incompleteStudents = Array.from(capturedImages.entries())
      .filter(([, data]) => data.blobs.length < requiredPages)
      .map(([studentId, data]) => ({
        student: students.find((s) => s.id === studentId),
        photoCount: data.blobs.length
      }))
      .filter((item): item is { student: Student; photoCount: number } =>
        Boolean(item.student)
      )

    if (incompleteStudents.length > 0) {
      // 生成詳細的錯誤訊息，包含每個學生的進度
      const details = incompleteStudents
        .map(({ student, photoCount }) =>
          `${student.seatNumber}號(${photoCount}/${requiredPages})`
        )
        .join('、')

      setError(
        `以下座號尚未拍滿 ${requiredPages} 張：${details}。` +
        `請返回繼續掃描，或在預覽中刪除未完成的作業。`
      )
      return
    }

    setIsSubmitting(true)
    setError(null)

    try {
      let successCount = 0

      console.log('📤 開始批量保存作業到資料庫...')
      console.log(`   作業 ID: ${assignmentId}`)
      console.log(`   待保存數量: ${capturedImages.size}`)

      // 批量保存到資料庫
      for (const [studentId, imageData] of capturedImages.entries()) {
        // 先刪除該學生的舊提交（如果有的話）
        const existingSubmissions = await db.submissions
          .where('assignmentId')
          .equals(assignmentId)
          .and(sub => sub.studentId === studentId)
          .toArray()

        if (existingSubmissions.length > 0) {
          console.log(`🗑️ 刪除學生 ${studentId} 的 ${existingSubmissions.length} 份舊提交`)
          const existingIds = existingSubmissions.map((sub) => sub.id)
          await queueDeleteMany('submissions', existingIds)
          for (const oldSub of existingSubmissions) {
            await db.answerExtractionCorrections.where('submissionId').equals(oldSub.id).delete()
            await db.submissions.delete(oldSub.id)
          }
        }

        const mergeResult = imageData.blobs.length === 1
          ? { blob: imageData.blobs[0], pageBreaks: [] as number[] }
          : await mergePageBlobs(imageData.blobs)
        const mergedBlob = mergeResult.blob
        const pageBreaks = mergeResult.pageBreaks

        console.log(`📦 準備保存 Blob:`, {
          studentId,
          blobSize: mergedBlob.size,
          blobType: mergedBlob.type,
          blobCount: imageData.blobs.length
        })

        // 驗證 Blob 的有效性
        if (!mergedBlob || mergedBlob.size === 0) {
          throw new Error(`學生 ${studentId} 的圖片 Blob 無效或為空`)
        }

        // 確保 Blob 有正確的 MIME type
        if (!mergedBlob.type || mergedBlob.type === '') {
          console.warn(`⚠️ Blob 缺少 MIME type，設定為 image/webp`)
        }

        // 轉換為 Base64（Safari 備用）
        let imageBase64: string
        try {
          imageBase64 = await blobToBase64(mergedBlob)
          console.log(`📝 Base64 轉換完成: ${(imageBase64.length / 1024).toFixed(2)} KB`)
        } catch (error) {
          console.error('❌ Base64 轉換失敗:', error)
          throw new Error(`Base64 轉換失敗: ${error instanceof Error ? error.message : '未知錯誤'}`)
        }

        // 創建新提交
        const submission: Submission = {
          id: generateId(),
          assignmentId,
          studentId: studentId,
          status: 'scanned',
          imageBase64: imageBase64,  // Safari 備用
          ...(avoidBlobStorage ? {} : { imageBlob: mergedBlob }),
          ...(pageBreaks.length > 0 ? { pageBreaks } : {}),
          createdAt: getCurrentTimestamp()
        }

        console.log(`💾 保存作業: studentId=${studentId}, assignmentId=${assignmentId}, submissionId=${submission.id}`)
        console.log(`   Blob 詳情: size=${mergedBlob.size} bytes, type="${mergedBlob.type}"`)
        console.log(`   Base64 長度: ${imageBase64.length} chars`)

        // 嘗試保存到 IndexedDB，添加詳細錯誤處理
        try {
          await db.submissions.add(submission)
          console.log(`✅ 成功保存到 IndexedDB (含 Blob)`)
        } catch (dbError) {
          console.error('❌ IndexedDB 保存失敗 (含 Blob):', dbError)
          console.error('   錯誤詳情:', {
            name: dbError instanceof Error ? dbError.name : 'Unknown',
            message: dbError instanceof Error ? dbError.message : String(dbError),
            stack: dbError instanceof Error ? dbError.stack : undefined
          })

          // 檢查是否是 Blob 相關的錯誤
          const errorMsg = dbError instanceof Error ? dbError.message.toLowerCase() : String(dbError).toLowerCase()
          const isBlobError = isIndexedDbBlobError(dbError)

          if (!avoidBlobStorage && isBlobError) {
            console.warn('⚠️ Blob 儲存失敗，嘗試僅使用 Base64 儲存...')

            // 備用方案：僅儲存 Base64，不儲存 Blob
            const submissionWithoutBlob: Submission = {
              id: submission.id,
              assignmentId: submission.assignmentId,
              studentId: submission.studentId,
              status: submission.status,
              imageBase64: submission.imageBase64,  // 僅保留 Base64
              // imageBlob 不設定
              createdAt: submission.createdAt
            }

            try {
              await db.submissions.add(submissionWithoutBlob)
              console.log(`✅ 成功保存到 IndexedDB (僅 Base64，無 Blob)`)
              console.log(`   注意：此提交僅包含 Base64 格式，Blob 已省略`)
            } catch (base64Error) {
              console.error('❌ 即使僅用 Base64 也儲存失敗:', base64Error)
              throw new Error('儲存失敗，請檢查瀏覽器儲存空間或嘗試清理資料')
            }
          } else if (errorMsg.includes('quota')) {
            throw new Error('儲存空間不足，請清理瀏覽器資料或刪除舊的作業')
          } else {
            throw new Error(`資料庫儲存失敗: ${dbError instanceof Error ? dbError.message : '未知錯誤'}`)
          }
        }

        // 驗證保存的 Blob 和 Base64
        const saved = await db.submissions.get(submission.id)
        console.log(`✅ 驗證保存結果:`, {
          submissionId: submission.id,
          hasBlobAfterSave: !!saved?.imageBlob,
          blobSizeAfterSave: saved?.imageBlob?.size,
          blobTypeAfterSave: saved?.imageBlob?.type,
          hasBase64AfterSave: !!saved?.imageBase64,
          base64SizeAfterSave: saved?.imageBase64 ? `${(saved.imageBase64.length / 1024).toFixed(2)} KB` : 'N/A'
        })
        successCount++
      }

      console.log(`✅ 批量保存完成！成功保存 ${successCount} 份作業`)

      // 驗證保存結果
      const savedSubmissions = await db.submissions
        .where('assignmentId')
        .equals(assignmentId)
        .toArray()
      console.log(`🔍 驗證: 資料庫中該作業現有 ${savedSubmissions.length} 份提交`)

      // 清理所有 URL
      capturedImages.forEach(imageData => {
        imageData.urls.forEach((url) => URL.revokeObjectURL(url))
      })

      // 清空暫存
      setCapturedImages(new Map())
      setShowConfirmation(false)

      alert(`成功送出 ${successCount} 份作業！`)
      requestSync()

    } catch (err) {
      console.error('❌ 批量送出失敗:', err)
      setError(err instanceof Error ? err.message : '批量送出失敗')
    } finally {
      setIsSubmitting(false)
    }
  }, [capturedImages, assignmentId, requiredPages, students])

  /**
   * 刪除指定學生的作業
   */
  const handleDeleteStudentImages = useCallback((studentId: string) => {
    setCapturedImages(prev => {
      const newMap = new Map(prev)
      const imageData = newMap.get(studentId)

      // 清理 URL
      if (imageData) {
        imageData.urls.forEach(url => URL.revokeObjectURL(url))
      }

      newMap.delete(studentId)

      // ✅ 使用更新後的 newMap 而不是舊的 capturedImages，避免 stale closure bug
      if (previewStudentId === studentId) {
        const remaining = Array.from(newMap.keys())
        setPreviewStudentId(remaining[0] ?? null)
      }

      return newMap
    })
  }, [previewStudentId])

  /**
   * 觸發文件選擇
   */
  const triggerFileUpload = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  /**
   * 處理文件選擇
   */
  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      handleFileUpload(file)
      // 清空 input，允許重複選擇同一文件
      e.target.value = ''
    }
  }, [handleFileUpload])

  // 載入所有學生
  useEffect(() => {
    const loadAllStudents = async () => {
      try {
        const allStudents = await db.students
          .where('classroomId')
          .equals(classroomId)
          .toArray()
        setStudents(allStudents)
      } catch (err) {
        console.error('載入學生列表失敗:', err)
      }
    }
    loadAllStudents()
  }, [classroomId])

  // 初始載入學生資訊
  useEffect(() => {
    loadStudentInfo(currentSeat)
  }, [currentSeat, loadStudentInfo])

  // 键盘快捷键
  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      // 空格键拍照
      if (e.code === 'Space' && !isCapturing) {
        e.preventDefault()
        capture()
      }
    }

    window.addEventListener('keydown', handleKeyPress)
    return () => window.removeEventListener('keydown', handleKeyPress)
  }, [capture, isCapturing])

  const currentStudentCount = currentStudent
    ? capturedImages.get(currentStudent.id)?.blobs.length ?? 0
    : 0
  const completedEntries = Array.from(capturedImages.entries()).filter(
    ([, data]) => data.blobs.length >= requiredPages
  )
  const incompleteEntries = Array.from(capturedImages.entries()).filter(
    ([, data]) => data.blobs.length > 0 && data.blobs.length < requiredPages
  )
  const completedCount = completedEntries.length
  const incompleteCount = incompleteEntries.length
  const previewEntry =
    completedEntries.find(([studentId]) => studentId === previewStudentId) ??
    completedEntries[0]
  const previewStudent = previewEntry
    ? students.find((s) => s.id === previewEntry[0]) ?? null
    : null
  const previewUrls = previewEntry ? previewEntry[1].urls : []

  useEffect(() => {
    if (!showConfirmation) return
    const firstId = completedEntries[0]?.[0] ?? null
    if (!firstId) return
    if (
      !previewStudentId ||
      !completedEntries.some(([studentId]) => studentId === previewStudentId)
    ) {
      setPreviewStudentId(firstId)
    }
  }, [showConfirmation, completedEntries, previewStudentId])

  // 如果顯示確認視窗
  if (showConfirmation) {
    return (
      <div className="fixed inset-0 bg-black/90 flex items-center justify-center p-4 z-50">
        <div className="bg-white rounded-2xl w-full max-w-6xl max-h-[90vh] overflow-y-auto p-6">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">確認送出作業</h2>

          {/* 摘要統計 */}
          <div className="bg-gray-100 rounded-lg p-3 mb-4 flex items-center justify-between">
            <div className="flex gap-4">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-green-500"></div>
                <span className="text-sm text-gray-700">
                  已完成：<span className="font-semibold">{completedCount}</span> 份
                </span>
              </div>

              {incompleteCount > 0 && (
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-amber-500"></div>
                  <span className="text-sm text-gray-700">
                    未完成：<span className="font-semibold">{incompleteCount}</span> 份
                  </span>
                </div>
              )}

              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-500">
                  總計：<span className="font-semibold">{capturedImages.size}</span> 份
                </span>
              </div>
            </div>

            {incompleteCount > 0 && (
              <div className="text-xs text-amber-700 bg-amber-50 px-2 py-1 rounded">
                ⚠️ 有未完成的作業
              </div>
            )}
          </div>

          {/* 縮圖網格 */}
          <div className="grid lg:grid-cols-[1.4fr_1fr] gap-4 mb-6">
            <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 flex flex-col gap-3 min-h-[320px]">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-700">PDF轉向</h3>
                {previewStudent && (
                  <span className="text-xs text-gray-500">
                    {previewStudent.seatNumber}號 {previewStudent.name}
                  </span>
                )}
              </div>
              <div className="flex-1 border border-dashed border-gray-200 rounded-xl flex items-center justify-center bg-white/70">
                {previewUrls.length > 0 ? (
                  <div className="flex gap-3 overflow-auto px-2 py-2">
                    {previewUrls.map((url, idx) => (
                      <img
                        key={`${previewStudent?.id ?? 'preview'}-${idx}`}
                        src={url}
                        alt={`第 ${idx + 1} 張預覽`}
                        className="w-40 h-56 sm:w-48 sm:h-64 rounded-lg shadow-md object-contain bg-white border border-gray-200"
                      />
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-gray-400 flex flex-col items-center gap-1">
                    <AlertCircle className="w-4 h-4" />
                    <span>尚未選擇預覽作業</span>
                  </div>
                )}
              </div>
              {previewUrls.length > 1 && (
                <p className="text-xs text-gray-500">
                  共 {previewUrls.length} 張影像
                </p>
              )}
            </div>

            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-700">
                  已完成清單
                </h3>
                <span className="text-xs text-gray-500">
                  {completedCount} 份
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 max-h-[360px] overflow-auto pr-1">
                {completedEntries.map(([studentId, imageData]) => {
                  const student = students.find(s => s.id === studentId)
                  const coverUrl = imageData.urls[0]
                  const isActive = studentId === previewEntry?.[0]
                  return (
                    <div key={studentId} className="relative group">
                      <button
                        type="button"
                        onClick={() => setPreviewStudentId(studentId)}
                        className={`w-full rounded-lg border text-left transition ${
                          isActive
                            ? 'border-indigo-400 bg-indigo-50'
                            : 'border-gray-200 bg-white hover:bg-gray-50'
                        }`}
                      >
                        <div className="aspect-square relative overflow-hidden rounded-t-lg">
                          {coverUrl && (
                            <img
                              src={coverUrl}
                              alt={`${student?.name} 的作業`}
                              className="w-full h-full object-cover"
                            />
                          )}
                          {imageData.urls.length > 1 && (
                            <span className="absolute top-1 right-1 text-[10px] px-1.5 py-0.5 rounded-full bg-black/60 text-white">
                              {imageData.urls.length}
                            </span>
                          )}
                        </div>
                        <div className="px-2 py-1.5 text-[11px] text-gray-700">
                          {student?.seatNumber}號 {student?.name}
                        </div>
                      </button>
                      {/* 刪除按鈕 */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          if (window.confirm(`確定要刪除 ${student?.seatNumber}號 ${student?.name} 的作業嗎？`)) {
                            handleDeleteStudentImages(studentId)
                          }
                        }}
                        className="absolute -top-2 -right-2 w-6 h-6 bg-red-500 hover:bg-red-600 text-white rounded-full shadow-lg flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10"
                        title="刪除此作業"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

          {/* 未完成清單 */}
          {incompleteCount > 0 && (
            <div className="mb-6">
              <h3 className="text-sm font-semibold text-amber-700 mb-3">
                未完成清單（{incompleteCount} 份）
              </h3>
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-3">
                {incompleteEntries.map(([studentId, imageData]) => {
                  const student = students.find((s) => s.id === studentId)
                  if (!student) return null

                  return (
                    <div
                      key={studentId}
                      className="relative group border-2 border-amber-300 rounded-lg overflow-hidden bg-amber-50"
                    >
                      {/* 縮圖 */}
                      <div className="aspect-[3/4] bg-white relative">
                        <img
                          src={imageData.urls[0]}
                          alt={`${student.name} 的作業`}
                          className="w-full h-full object-contain"
                        />
                        {/* 進度標記 */}
                        <div className="absolute top-1 left-1 bg-amber-500 text-white text-xs px-1.5 py-0.5 rounded">
                          {imageData.blobs.length}/{requiredPages}
                        </div>
                      </div>

                      {/* 學生資訊 */}
                      <div className="p-1.5 text-center bg-amber-50">
                        <p className="text-xs font-medium text-amber-800">
                          {student.seatNumber}號 {student.name}
                        </p>
                      </div>

                      {/* 刪除按鈕 */}
                      <button
                        type="button"
                        onClick={() => {
                          if (window.confirm(`確定要刪除 ${student.seatNumber}號 ${student.name} 的未完成作業嗎？`)) {
                            handleDeleteStudentImages(studentId)
                          }
                        }}
                        className="absolute -top-2 -right-2 w-6 h-6 bg-red-500 hover:bg-red-600 text-white rounded-full shadow-lg flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10"
                        title="刪除此作業"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {error && (
            <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-800 text-sm">
              {error}
            </div>
          )}

          <div className="flex gap-4">
            <button
              onClick={() => setShowConfirmation(false)}
              disabled={isSubmitting}
              className="flex-1 py-4 bg-gray-600 text-white rounded-xl font-bold text-lg hover:bg-gray-700 disabled:opacity-50"
            >
              返回繼續掃描
            </button>
            <button
              onClick={handleBatchSubmit}
              disabled={isSubmitting || completedCount === 0}
              className="flex-1 py-4 bg-green-600 text-white rounded-xl font-bold text-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
              title={completedCount === 0 ? '沒有已完成的作業可以送出' : ''}
            >
              {isSubmitting ? '送出中...' : `確認送出 ${completedCount} 份作業`}
            </button>
          </div>
        </div>
      </div>
    )
  }

  const actionBase =
    'w-14 h-14 rounded-full border border-white/70 text-white flex items-center justify-center transition disabled:opacity-40 disabled:cursor-not-allowed hover:bg-white/10'

  return (
    <div className="fixed inset-0 bg-black">
      {/* 隱藏的文件輸入 */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,application/pdf"
        onChange={handleFileChange}
        className="hidden"
      />

      {/* 攝像頭畫面 - 滿版顯示 */}
      <Webcam
        ref={webcamRef}
        audio={false}
        screenshotFormat="image/jpeg"
        videoConstraints={{
          facingMode: 'environment', // 使用後置攝像頭
          width: 1920,
          height: 1080
        }}
        className="absolute inset-0 w-full h-full object-cover"
      />

      {/* 成功提示動畫 - 作業飛入收集籃 */}
      {captureSuccess && (
        <>
          {/* 背景閃爍 */}
          <div className="absolute inset-0 bg-green-500 bg-opacity-20 animate-pulse z-10" />

          {/* 飛行的作業圖示 */}
          <div className={`absolute ${
            isLandscape
              ? 'right-4 top-1/2 -translate-y-1/2'
              : 'bottom-5 left-1/2 -translate-x-1/2'
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

      {/* 頂部狀態欄 */}
      <div className="absolute top-0 left-0 right-0 p-3 sm:p-4 text-white drop-shadow-[0_2px_6px_rgba(0,0,0,0.6)]">
        <div className="flex items-center justify-between text-white">
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 bg-red-500 rounded-full animate-pulse"></div>
            <span className="text-sm font-medium">掃描中</span>
            {completedCount > 0 && (
              <span className="ml-2 text-xs text-blue-100">
                已完成 {completedCount} / {maxSeat}
              </span>
            )}
          </div>

          {/* 語音控制按鈕 */}
          {isVoiceSupported && (
            <button
              onClick={isListening ? stopListening : startListening}
              className={`p-2 rounded-full border transition-colors ${
                isListening
                  ? 'border-red-400 text-red-100 hover:border-red-300'
                  : 'border-white/60 text-white hover:border-white'
              }`}
            >
              {isListening ? (
                <MicOff className="w-5 h-5" />
              ) : (
                <Mic className="w-5 h-5" />
              )}
            </button>
          )}
        </div>
      </div>

      {/* 座號 / 名稱資訊 */}
      <div
        className={`absolute left-3 ${
          isLandscape ? 'bottom-4' : 'bottom-24 sm:bottom-28'
        } text-white drop-shadow-[0_2px_6px_rgba(0,0,0,0.6)]`}
      >
        <div className="text-[11px] text-white/80">座號 {currentSeat}</div>
        <div className="text-sm font-semibold">
          {currentStudent ? currentStudent.name : '載入中...'}
        </div>
        <div className="text-[11px] text-white/80">
          第 {Math.min(currentStudentCount, requiredPages)}/{requiredPages} 張
        </div>
      </div>

      {/* 錯誤提示 */}
      {error && (
        <div className="absolute left-1/2 top-16 -translate-x-1/2 text-xs text-red-200 drop-shadow-[0_2px_6px_rgba(0,0,0,0.8)]">
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
          disabled={isCapturing || !currentStudent}
          className={actionBase}
          aria-label="上傳作業"
          title="上傳"
        >
          <Upload className="w-5 h-5" />
        </button>
        <button
          onClick={capture}
          disabled={isCapturing || !currentStudent}
          className={`${actionBase} w-16 h-16 ${isCapturing ? 'scale-95' : 'hover:scale-105'}`}
          aria-label="拍照"
          title="拍照 (Space)"
        >
          <Camera className="w-6 h-6" />
        </button>
        {/* 收集籃按鈕 - 始終顯示，有動態計數 */}
        <button
          onClick={() => setShowConfirmation(true)}
          disabled={completedCount === 0}
          className={`${actionBase} relative ${completedCount > 0 ? 'bg-green-500/20 border-green-400' : ''}`}
          aria-label="查看收集籃"
          title="查看已拍攝作業"
        >
          <ShoppingCart className="w-5 h-5" />
          {/* 數量徽章 */}
          {completedCount > 0 && (
            <div className="absolute -top-1 -right-1 w-5 h-5 bg-green-500 rounded-full flex items-center justify-center text-[10px] font-bold text-white border-2 border-white animate-bounce">
              {completedCount}
            </div>
          )}
        </button>
      </div>

      {/* 語音監聽狀態 */}
      {isListening && (
        <div className="absolute right-3 bottom-3 text-xs text-red-200 drop-shadow-[0_2px_6px_rgba(0,0,0,0.8)]">
          <span className="inline-flex items-center gap-2">
            <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse"></span>
            語音識別中...
          </span>
        </div>
      )}
    </div>
  )
}
