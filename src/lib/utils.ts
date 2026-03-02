import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import { db } from './db'
import { debugLog } from './logger'
import { buildApiUrl } from './api-base'

/**
 * 合併 Tailwind CSS class names
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * 检测是否为 Safari 浏览器
 */
function isSafari(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent.toLowerCase()
  return ua.includes('safari') && !ua.includes('chrome') && !ua.includes('android')
}

/**
 * 修復損壞的 Base64 字符串
 * 處理格式：data:image/jpeg;base64,dataimage/jpegbase64/9j/...
 * 修復為：data:image/jpeg;base64,/9j/...
 */
export function fixCorruptedBase64(base64: string): string {
  if (!base64) return base64

  const correctPrefix = /^data:image\/[^;]+;base64,/i

  if (correctPrefix.test(base64)) {
    const prefixMatch = base64.match(correctPrefix)
    if (prefixMatch) {
      const prefix = prefixMatch[0]
      const afterPrefix = base64.substring(prefix.length)

      // 檢測損壞模式：查找 "jpegbase64" 或 "dataimage" 等異常文字
      if (afterPrefix.includes('jpegbase64') || afterPrefix.includes('dataimage')) {
        // 找到 /9j/ 的位置（JPEG Base64 的標準開頭）
        const jpegStart = base64.indexOf('/9j/')
        if (jpegStart > prefix.length) {
          return prefix + base64.substring(jpegStart)
        }
      }
    }
  }

  // 確保有正確的 data URL 格式
  if (!base64.startsWith('data:image/')) {
    return `data:image/jpeg;base64,${base64}`
  }

  return base64
}

/**
 * 获取 Submission 图片的显示 URL
 * 優先順序：Base64 > Blob > 雲端 URL
 * 理由：Base64 在所有瀏覽器都穩定，Blob 在某些情況下可能有問題
 */
export function getSubmissionImageUrl(submission?: {
  id?: string
  imageBlob?: Blob
  imageBase64?: string
  imageUrl?: string
  thumbUrl?: string
  thumbnailBlob?: Blob
  thumbnailBase64?: string
  thumbnailUrl?: string
} | null, useThumbnail = false): string | null {
  if (!submission) {
    // 正常情況：某些學生可能沒有提交作業
    return null
  }

  const safari = isSafari()
  const browser = safari ? 'Safari' : 'Chrome/Other'

  // 如果使用縮圖模式，優先使用縮圖欄位
  if (useThumbnail) {
    // 策略 1: 使用本地縮圖 Base64（如果已經下載過）
    if (submission.thumbnailBase64) {
      const base64 = fixCorruptedBase64(submission.thumbnailBase64)
      debugLog(`✅ 使用本地縮圖 Base64 (${browser})`, { submissionId: submission.id, length: base64.length })
      return base64
    }

    // 策略 2: 使用本地縮圖 Blob（如果已經下載過）
    if (submission.thumbnailBlob && submission.thumbnailBlob.size > 0) {
      try {
        const url = URL.createObjectURL(submission.thumbnailBlob)
        debugLog(`✅ 使用本地縮圖 Blob URL (${browser})`, { submissionId: submission.id, url })
        return url
      } catch (error) {
        console.error(`❌ 創建縮圖 Blob URL 失敗 (${browser}):`, error, { submissionId: submission.id })
      }
    }

    // 策略 3: 使用本地原圖（已存在則直接用，避免額外下載）
    if (submission.imageBase64) {
      const base64 = fixCorruptedBase64(submission.imageBase64)
      debugLog(`✅ 使用本地原圖 Base64 (${browser})`, { submissionId: submission.id, length: base64.length })
      return base64
    }

    if (submission.imageBlob) {
      try {
        if (submission.imageBlob.size > 0) {
          const url = URL.createObjectURL(submission.imageBlob)
          debugLog(`✅ 使用本地原圖 Blob URL (${browser})`, { submissionId: submission.id, url })
          return url
        }
      } catch (error) {
        console.error(`❌ 創建原圖 Blob URL 失敗 (${browser}):`, error, { submissionId: submission.id })
      }
    }

    // 策略 4: 使用雲端下載端點（thumb=true，後端會自動 fallback 到原圖）
    if (submission.id) {
      const params = new URLSearchParams({ submissionId: submission.id, thumb: 'true' })
      const url = buildApiUrl(`/api/storage/download?${params.toString()}`)
      debugLog(`✅ 使用雲端下載縮圖/原圖 URL (${browser})`, { submissionId: submission.id, url })
      return url
    }
  }

  debugLog(`📷 取得圖片 URL (${browser}):`, {
    submissionId: submission.id,
    hasBlob: !!submission.imageBlob,
    blobSize: submission.imageBlob?.size,
    blobType: submission.imageBlob?.type,
    hasBase64: !!submission.imageBase64,
    base64Length: submission.imageBase64?.length,
    hasImageUrl: !!submission.imageUrl
  })

  // 策略 1: 優先使用 Base64（最穩定，所有瀏覽器都支持）
  if (submission.imageBase64) {
    const base64 = fixCorruptedBase64(submission.imageBase64)
    debugLog(`✅ 使用 Base64 (${browser})`, { submissionId: submission.id, length: base64.length })
    return base64
  }

  // 策略 2: 使用本地 Blob
  if (submission.imageBlob) {
    try {
      // 檢查 Blob 是否有效
      if (submission.imageBlob.size === 0) {
        console.warn('⚠️ Blob 大小為 0，無法使用', { submissionId: submission.id })
      } else {
        // 如果 Blob 沒有類型，嘗試補上
        if (!submission.imageBlob.type || submission.imageBlob.type === '') {
          console.warn(`⚠️ Blob 缺少 type，設定為 image/jpeg (${browser})`, { submissionId: submission.id })
          const fixedBlob = new Blob([submission.imageBlob], { type: 'image/jpeg' })
          const url = URL.createObjectURL(fixedBlob)
          debugLog(`✅ 使用 Blob URL (修復後, ${browser})`, { submissionId: submission.id, url })
          return url
        }

        const url = URL.createObjectURL(submission.imageBlob)
        debugLog(`✅ 使用 Blob URL (${browser})`, { submissionId: submission.id, url })
        return url
      }
    } catch (error) {
      console.error(`❌ 創建 Blob URL 失敗 (${browser}):`, error, { submissionId: submission.id })
    }
  }

  // 策略 3: 使用云端 URL（從 Supabase 下載）
  if (submission.id) {
    const params = new URLSearchParams({ submissionId: submission.id })
    const url = buildApiUrl(`/api/storage/download?${params.toString()}`)
    debugLog(`✅ 使用雲端 URL (${browser})`, { submissionId: submission.id, url })
    return url
  }

  console.error(`❌ 無法取得圖片 URL (${browser})：沒有任何可用的圖片來源`, {
    submissionId: submission.id,
    hasBlob: !!submission.imageBlob,
    hasBase64: !!submission.imageBase64,
    hasImageUrl: !!submission.imageUrl
  })
  return null
}
/**
 * 檢查資料夾名稱是否已被使用（跨類型唯一性）
 * 規則：
 * - 同類型（班級 vs 班級，或作業 vs 作業）可以共用資料夾名稱
 * - 跨類型（班級 vs 作業）不能使用相同的資料夾名稱
 * @param folderName - 要檢查的資料夾名稱
 * @param type - 'classroom' 或 'assignment'
 * @returns Promise<{ isUnique: boolean; usedBy?: string }>
 */
export async function checkFolderNameUnique(
  folderName: string,
  type?: 'classroom' | 'assignment',
  classroomId?: string
): Promise<{ isUnique: boolean; usedBy?: string }> {
  const trimmedName = folderName.trim()
  if (!trimmedName) {
    return { isUnique: true } // 空資料夾名稱不檢查
  }

  if (type === 'classroom') {
    const classrooms = await db.classrooms.toArray()
    const conflictClassroom = classrooms.find((c) => c.folder === trimmedName)
    if (conflictClassroom) {
      return {
        isUnique: false,
        usedBy: `班級「${conflictClassroom.name}」`
      }
    }
    const emptyFolders = await db.folders
      .where('type')
      .equals('classroom')
      .toArray()
    if (emptyFolders.some((f) => f.name === trimmedName)) {
      return { isUnique: false, usedBy: `班級資料夾「${trimmedName}」` }
    }
  }

  if (type === 'assignment') {
    if (!classroomId) {
      return { isUnique: true }
    }
    const assignments = await db.assignments
      .where('classroomId')
      .equals(classroomId)
      .toArray()
    const conflictAssignment = assignments.find((a) => a.folder === trimmedName)
    if (conflictAssignment) {
      return {
        isUnique: false,
        usedBy: `作業「${conflictAssignment.title}」`
      }
    }
    const conflictEmpty = await db.folders
      .where('[type+classroomId+name]')
      .equals(['assignment', classroomId, trimmedName])
      .first()
    if (conflictEmpty) {
      return {
        isUnique: false,
        usedBy: `作業資料夾「${trimmedName}」`
      }
    }
  }

  return { isUnique: true }
}


