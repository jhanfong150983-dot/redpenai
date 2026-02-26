import { useState, useEffect, useCallback, useRef } from 'react'
import { db } from '@/lib/db'
import { useOnlineStatus } from './useOnlineStatus'
import { SYNC_EVENT_NAME, notifySyncComplete } from '@/lib/sync-events'
import { clearDeleteQueue, readDeleteQueue } from '@/lib/sync-delete-queue'
import type { Assignment, Classroom, Student, Submission } from '@/lib/db'
import { blobToBase64 as blobToDataUrl, compressImage } from '@/lib/imageCompression'
import { downloadImageFromSupabase } from '@/lib/supabase-download'
import { fixCorruptedBase64 } from '@/lib/utils'
import { isIndexedDbBlobError, shouldAvoidIndexedDbBlob } from '@/lib/blob-storage'
import { debugLog, infoLog } from '@/lib/logger'

interface SyncStatus {
  isSyncing: boolean
  lastSyncTime: number | null
  pendingCount: number
  error: string | null
}

interface UseSyncOptions {
  autoSync?: boolean
  syncInterval?: number // 保留參數以相容舊呼叫
}

const normalizeBase64Payload = (
  rawBase64: string,
  fallbackMimeType?: string
): { data: string; mimeType?: string; dataUrl: string } => {
  const fixed = fixCorruptedBase64(rawBase64.trim())
  if (fixed.startsWith('data:')) {
    const commaIndex = fixed.indexOf(',')
    if (commaIndex > -1) {
      const meta = fixed.slice(5, commaIndex)
      const mimeType = meta.split(';')[0] || fallbackMimeType
      return {
        data: fixed.slice(commaIndex + 1),
        mimeType,
        dataUrl: fixed
      }
    }
  }

  const mimeType = fallbackMimeType || 'image/jpeg'
  return {
    data: fixed,
    mimeType,
    dataUrl: `data:${mimeType};base64,${fixed}`
  }
}

const MAX_SUBMISSION_BASE64_LENGTH = 2_700_000
const HARD_MAX_SUBMISSION_BASE64_LENGTH = 1_600_000

const shrinkBase64Payload = async (
  dataUrl: string,
  fallbackMimeType: string | undefined,
  targetLength: number
) => {
  let normalized = normalizeBase64Payload(dataUrl, fallbackMimeType)
  if (normalized.data.length <= targetLength) {
    return { ...normalized, updated: false }
  }

  const strategies = [
    { maxWidth: 1400, quality: 0.75 },
    { maxWidth: 1200, quality: 0.7 },
    { maxWidth: 1024, quality: 0.65 },
    { maxWidth: 900, quality: 0.6 },
    { maxWidth: 800, quality: 0.55 }
  ]

  let currentDataUrl = normalized.dataUrl

  for (const strategy of strategies) {
    try {
      const compressed = await compressImage(currentDataUrl, {
        maxWidth: strategy.maxWidth,
        quality: strategy.quality
      })
      const compressedDataUrl = await blobToDataUrl(compressed)
      normalized = normalizeBase64Payload(compressedDataUrl, compressed.type)

      if (normalized.data.length <= targetLength) {
        return { ...normalized, updated: true }
      }

      currentDataUrl = normalized.dataUrl
    } catch (error) {
      console.warn('⚠️ 同步圖片壓縮失敗，改用原圖', error)
      return { ...normalized, updated: false }
    }
  }

  return { ...normalized, updated: true }
}

const toMillis = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

export function useSync(options: UseSyncOptions = {}) {
  const { autoSync = true } = options

  const isOnline = useOnlineStatus()
  const [status, setStatus] = useState<SyncStatus>({
    isSyncing: false,
    lastSyncTime: null,
    pendingCount: 0,
    error: null
  })
  const isSyncingRef = useRef(false)
  const syncQueuedRef = useRef(false)
  const prevOnlineRef = useRef(isOnline)
  const lastFocusSyncRef = useRef(0)
  const avoidBlobStorage = shouldAvoidIndexedDbBlob()
  const syncBlockedReasonRef = useRef<string | null>(null)
  // hasInitializedRef 已廢棄：改用 localStorage 來判斷是否已初始化，避免頁面刷新時重置
  // const hasInitializedRef = useRef(false)

  const buildSyncUrl = useCallback(
    (extraParams?: URLSearchParams) => {
      const params = extraParams
        ? new URLSearchParams(extraParams)
        : new URLSearchParams()
      const query = params.toString()
      return query ? `/api/data/sync?${query}` : '/api/data/sync'
    },
    []
  )

  const updateSubmissionImageCache = async (
    submissionId: string,
    blob: Blob | null,
    dataUrl: string | null
  ) => {
    const payload: Partial<Submission> = {}
    if (dataUrl) payload.imageBase64 = dataUrl
    if (!avoidBlobStorage && blob) payload.imageBlob = blob
    if (avoidBlobStorage) payload.imageBlob = undefined

    try {
      await db.submissions.update(submissionId, payload)
    } catch (error) {
      if (!avoidBlobStorage && blob && isIndexedDbBlobError(error)) {
        delete payload.imageBlob
        await db.submissions.update(submissionId, payload)
      } else {
        throw error
      }
    }
  }

  const isRlsError = (value: unknown) => {
    const message = value instanceof Error ? value.message : String(value)
    const lower = message.toLowerCase()
    return (
      lower.includes('row-level security') ||
      lower.includes('rls') ||
      lower.includes('permission denied') ||
      lower.includes('not authorized') ||
      lower.includes('not allowed')
    )
  }

  const markSyncBlocked = (reason: string) => {
    if (!syncBlockedReasonRef.current) {
      syncBlockedReasonRef.current = reason
    }
  }

  /**
   * 更新待同步數量
   */
  const updatePendingCount = useCallback(async () => {
    const count = await db.submissions
      .where('status')
      .equals('scanned')
      .count()

    setStatus((prev) => ({ ...prev, pendingCount: count }))
    return count
  }, [])

  /**
   * 同步單個提交紀錄
   */
  const syncSubmission = async (submission: any) => {
    try {
      debugLog(`開始同步提交 ${submission.id}`)

      let imageBase64: string
      let contentType: string | undefined
      let base64DataUrl: string | null = null
      let thumbBase64: string | undefined
      let thumbContentType: string | undefined

      // 優先使用 imageBase64（如果已經有）
      if (submission.imageBase64) {
        debugLog('✅ 使用現有的 Base64 數據')
        const normalized = normalizeBase64Payload(
          submission.imageBase64,
          submission.imageBlob?.type
        )
        imageBase64 = normalized.data
        contentType = normalized.mimeType
        base64DataUrl = normalized.dataUrl
      } else if (submission.imageBlob) {
        // 從 Blob 轉換
        debugLog('🔄 從 Blob 轉換為 Base64')
        const dataUrl = await blobToDataUrl(submission.imageBlob)
        const normalized = normalizeBase64Payload(dataUrl, submission.imageBlob.type)
        imageBase64 = normalized.data
        contentType = normalized.mimeType || submission.imageBlob.type
        base64DataUrl = normalized.dataUrl
        if (avoidBlobStorage && base64DataUrl) {
          await updateSubmissionImageCache(submission.id, submission.imageBlob, base64DataUrl)
        }
      } else {
        console.warn('⚠️ 缺少圖片資料，嘗試從雲端下載補回')
        try {
          const downloaded = await downloadImageFromSupabase(submission.id)
          const dataUrl = await blobToDataUrl(downloaded)
          const normalized = normalizeBase64Payload(dataUrl, downloaded.type)
          imageBase64 = normalized.data
          contentType = normalized.mimeType || downloaded.type
          base64DataUrl = normalized.dataUrl
          await updateSubmissionImageCache(submission.id, downloaded, base64DataUrl)
        } catch (downloadError) {
          console.warn('⚠️ 雲端下載失敗，標記為未繳交以避免重試', downloadError)
          await db.submissions.update(submission.id, { status: 'missing' })
          return true
        }
      }

      // 確定 content type
      if (!contentType) {
        contentType = submission.imageBlob?.type || 'image/webp'
      }

      if (base64DataUrl) {
        const adjusted = await shrinkBase64Payload(
          base64DataUrl,
          contentType,
          MAX_SUBMISSION_BASE64_LENGTH
        )
        if (adjusted.updated) {
          imageBase64 = adjusted.data
          contentType = adjusted.mimeType || contentType
          base64DataUrl = adjusted.dataUrl
          await updateSubmissionImageCache(submission.id, null, base64DataUrl)
        }
      }

      if (base64DataUrl) {
        try {
          const thumbBlob = await compressImage(base64DataUrl, {
            maxWidth: 360,
            quality: 0.7
          })
          const thumbDataUrl = await blobToDataUrl(thumbBlob)
          const normalizedThumb = normalizeBase64Payload(thumbDataUrl, thumbBlob.type)
          thumbBase64 = normalizedThumb.data
          thumbContentType = normalizedThumb.mimeType || thumbBlob.type || 'image/webp'
        } catch (error) {
          console.warn('⚠️ 縮圖產生失敗，略過縮圖上傳', error)
        }
      }

      const response = await fetch('/api/data/submission', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          submissionId: submission.id,
          assignmentId: submission.assignmentId,
          studentId: submission.studentId,
          createdAt: submission.createdAt,
          imageBase64,
          contentType,
          thumbBase64,
          thumbContentType
        })
      })

      let data = await response.json().catch(() => ({}))
      if (!response.ok) {
        if (response.status === 413 && base64DataUrl) {
          console.warn('⚠️ 同步檔案過大，嘗試更高壓縮後重試')
          const adjusted = await shrinkBase64Payload(
            base64DataUrl,
            contentType,
            HARD_MAX_SUBMISSION_BASE64_LENGTH
          )
          if (adjusted.updated) {
            imageBase64 = adjusted.data
            contentType = adjusted.mimeType || contentType
            base64DataUrl = adjusted.dataUrl
            await updateSubmissionImageCache(submission.id, null, base64DataUrl)
          }

          const retryResponse = await fetch('/api/data/submission', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              submissionId: submission.id,
              assignmentId: submission.assignmentId,
              studentId: submission.studentId,
              createdAt: submission.createdAt,
              imageBase64,
              contentType,
              thumbBase64,
              thumbContentType
            })
          })

          data = await retryResponse.json().catch(() => ({}))
          if (!retryResponse.ok) {
            const message = data?.error || '同步失敗'
            if (isRlsError(message) || retryResponse.status === 401 || retryResponse.status === 403) {
              console.warn('⚠️ 同步遭到權限限制 (RLS)，暫停同步:', message)
              markSyncBlocked(message)
              return false
            }
            throw new Error(message)
          }
        } else {
          const message = data?.error || '同步失敗'
          if (isRlsError(message) || response.status === 401 || response.status === 403) {
            console.warn('⚠️ 同步遭到權限限制 (RLS)，暫停同步:', message)
            markSyncBlocked(message)
            return false
          }
          throw new Error(message)
        }
      }

      debugLog('圖片與資料同步成功')

      // 同步成功後，更新狀態但保留本地圖片數據
      debugLog('📝 更新本地狀態為 synced，保留圖片數據...')

      // 先檢查當前數據
      const beforeUpdate = await db.submissions.get(submission.id)
      debugLog('更新前:', {
        hasBlob: !!beforeUpdate?.imageBlob,
        blobSize: beforeUpdate?.imageBlob?.size,
        hasBase64: !!beforeUpdate?.imageBase64,
        base64Length: beforeUpdate?.imageBase64?.length
      })

      const newImageUrl = `submissions/${submission.id}.webp`
      console.log('🔄 [同步] 更新本地 submission 狀態:', {
        submissionId: submission.id,
        oldImageUrl: beforeUpdate?.imageUrl,
        newImageUrl,
        oldStatus: beforeUpdate?.status,
        newStatus: 'synced'
      })

      await db.submissions.update(submission.id, {
        status: 'synced',
        imageUrl: newImageUrl,
        thumbUrl: `submissions/thumbs/${submission.id}.webp`
        // 注意：不更新 imageBlob 和 imageBase64，保留原有數據
      })

      // 驗證更新後數據
      const afterUpdate = await db.submissions.get(submission.id)
      debugLog('更新後:', {
        status: afterUpdate?.status,
        hasBlob: !!afterUpdate?.imageBlob,
        blobSize: afterUpdate?.imageBlob?.size,
        hasBase64: !!afterUpdate?.imageBase64,
        base64Length: afterUpdate?.imageBase64?.length,
        imageUrl: afterUpdate?.imageUrl
      })

      console.log('✅ [同步] 本地 submission 更新完成:', {
        submissionId: submission.id,
        imageUrl: afterUpdate?.imageUrl,
        status: afterUpdate?.status
      })

      if (beforeUpdate?.imageBlob && !afterUpdate?.imageBlob) {
        console.error('⚠️ 警告：更新後 Blob 丟失！')
      }
      if (beforeUpdate?.imageBase64 && !afterUpdate?.imageBase64) {
        console.error('⚠️ 警告：更新後 Base64 丟失！')
      }

      debugLog('✅ 本地狀態更新成功')

      return true
    } catch (error) {
      if (isRlsError(error)) {
        console.warn('⚠️ 同步遭到權限限制 (RLS)，暫停同步:', error)
        markSyncBlocked(error instanceof Error ? error.message : String(error))
        return false
      }
      console.error(`同步失敗 ${submission.id}:`, error)
      throw error
    }
  }

  /**
   * 上傳本機資料到雲端
   */
  const pushMetadata = useCallback(async () => {
    debugLog('📤 pushMetadata 開始')
    const [classrooms, students, assignments, submissions, folders, deleteQueue] =
      await Promise.all([
        db.classrooms.toArray(),
        db.students.toArray(),
        db.assignments.toArray(),
        db.submissions.toArray(),
        db.folders.toArray(),
        readDeleteQueue()
      ])

    console.log('🔄 [同步] 讀取刪除佇列:', {
      count: deleteQueue.length,
      items: deleteQueue.map(q => ({ tableName: q.tableName, recordId: q.recordId }))
    })

    debugLog('📊 pushMetadata 讀取的 folders:', folders)

    const deleteQueueIds = deleteQueue
      .map((item) => item.id)
      .filter((id): id is number => typeof id === 'number')

    const deletedPayload: Record<string, Array<{ id: string; deletedAt: number }>> = {
      classrooms: [],
      students: [],
      assignments: [],
      submissions: [],
      folders: []
    }

    const deleteMap = new Map<
      string,
      { tableName: string; recordId: string; deletedAt: number }
    >()

    for (const entry of deleteQueue) {
      if (!entry.tableName || !entry.recordId) continue
      const key = `${entry.tableName}:${entry.recordId}`
      const existing = deleteMap.get(key)
      if (!existing || entry.deletedAt > existing.deletedAt) {
        deleteMap.set(key, {
          tableName: entry.tableName,
          recordId: entry.recordId,
          deletedAt: entry.deletedAt
        })
      }
    }

    for (const entry of deleteMap.values()) {
      const bucket = deletedPayload[entry.tableName]
      if (bucket) {
        bucket.push({ id: entry.recordId, deletedAt: entry.deletedAt })
      }
    }

    console.log('📦 [同步] 準備發送刪除資料:', {
      submissions: deletedPayload.submissions.length,
      total: Object.values(deletedPayload).reduce((sum, arr) => sum + arr.length, 0),
      deletedPayload
    })

    const classroomPayload = classrooms
      .filter((c) => c?.id)
      .map((c) => ({
        id: c.id,
        name: c.name,
        folder: c.folder === undefined ? null : c.folder,
        updatedAt: c.updatedAt
      }))

    debugLog('📤 pushMetadata - 準備發送的 classrooms:', classroomPayload)

    const studentPayload = students
      .filter((s) => s?.id && s?.classroomId)
      .map((s) => ({
        id: s.id,
        classroomId: s.classroomId,
        seatNumber: s.seatNumber,
        name: s.name,
        updatedAt: s.updatedAt
      }))

    const assignmentPayload = assignments
      .filter((a) => a?.id && a?.classroomId)
      .map((a) => ({
        id: a.id,
        classroomId: a.classroomId,
        title: a.title,
        totalPages: a.totalPages,
        domain: a.domain,
        folder: a.folder === undefined ? null : a.folder,
        priorWeightTypes: a.priorWeightTypes,
        answerKey: a.answerKey,
        updatedAt: a.updatedAt
      }))
    
    console.log(`📤 [Sync Push] 準備上傳 ${assignmentPayload.length} 個作業:`, assignmentPayload.map(a => ({ id: a.id, title: a.title, hasAnswerKey: !!a.answerKey })))

    const submissionPayload = submissions
      .filter((sub) => sub.status !== 'scanned')
      .map(({ imageBlob, ...rest }) => ({
        id: rest.id,
        assignmentId: rest.assignmentId,
        studentId: rest.studentId,
        status: rest.status,
        createdAt: rest.createdAt,
        imageUrl: rest.imageUrl || `submissions/${rest.id}.webp`,
        thumbUrl:
          rest.thumbUrl ||
          rest.thumbnailUrl ||
          `submissions/thumbs/${rest.id}.webp`,
        score: rest.score,
        feedback: rest.feedback,
        gradingResult: rest.gradingResult,
        gradedAt: rest.gradedAt,
        correctionCount: rest.correctionCount,
        updatedAt: rest.updatedAt
      }))

    const foldersPayload = folders
      .filter((f) => f?.id && f?.name)
      .map((f) => ({
        id: f.id,
        name: f.name,
        type: f.type,
        updatedAt: f.updatedAt
      }))

    const response = await fetch(buildSyncUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        classrooms: classroomPayload,
        students: studentPayload,
        assignments: assignmentPayload,
        submissions: submissionPayload,
        folders: foldersPayload,
        deleted: deletedPayload
      })
    })

    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      const message = data?.error || '同步失敗'
      if (isRlsError(message) || response.status === 401 || response.status === 403) {
        console.warn('⚠️ pushMetadata 遭到權限限制 (RLS)，暫停同步:', message)
        markSyncBlocked(message)
        return
      }
      throw new Error(message)
    }

    debugLog('✅ pushMetadata 完成')

    // pushMetadata 後再檢查一次 folders
    const afterPush = await db.folders.toArray()
    debugLog('📊 pushMetadata 後本地 folders:', afterPush)

    if (deleteQueueIds.length > 0) {
      await clearDeleteQueue(deleteQueueIds)
    }
  }, [buildSyncUrl])

  /**
   * 從雲端拉回資料
   */
  const pullMetadata = useCallback(async () => {
    debugLog('📥 pullMetadata 開始')
    const response = await fetch(buildSyncUrl(), {
      method: 'GET',
      credentials: 'include'
    })

    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      const message = data?.error || '載入雲端資料失敗'
      if (isRlsError(message) || response.status === 401 || response.status === 403) {
        console.warn('⚠️ pullMetadata 遭到權限限制 (RLS)，暫停同步:', message)
        markSyncBlocked(message)
        return
      }
      throw new Error(message)
    }

    const classrooms = Array.isArray(data.classrooms) ? data.classrooms : []
    const students = Array.isArray(data.students) ? data.students : []
    const assignments = Array.isArray(data.assignments) ? data.assignments : []
    const submissions = Array.isArray(data.submissions) ? data.submissions : []
    const folders = Array.isArray(data.folders) ? data.folders : []
    const deleted = data?.deleted && typeof data.deleted === 'object' ? data.deleted : {}
    
    console.log(`📥 [Sync Pull] 從雲端拉取 ${assignments.length} 個作業:`, assignments.map((a: any) => ({ id: a.id, title: a.title, hasAnswerKey: !!a.answerKey })))

    const collectDeletedIds = (items: unknown) =>
      Array.isArray(items)
        ? items
            .map((item) => {
              if (typeof item === 'string') return item
              if (item && typeof item === 'object' && 'id' in item) {
                return (item as { id?: unknown }).id
              }
              return null
            })
            .filter((id): id is string => typeof id === 'string' && id.length > 0)
        : []

    const deletedClassroomIds = collectDeletedIds(deleted.classrooms)
    const deletedStudentIds = collectDeletedIds(deleted.students)
    const deletedAssignmentIds = collectDeletedIds(deleted.assignments)
    const deletedSubmissionIds = collectDeletedIds(deleted.submissions)
    const deletedFolderIds = collectDeletedIds(deleted.folders)

    debugLog('🗑️ 要刪除的 folders:', deletedFolderIds)

    // 在 bulkDelete 之前檢查 folders
    const beforeDelete = await db.folders.toArray()
    debugLog('📊 bulkDelete 之前的 folders:', beforeDelete)

    const deletedClassroomSet = new Set(deletedClassroomIds)
    const deletedStudentSet = new Set(deletedStudentIds)
    const deletedAssignmentSet = new Set(deletedAssignmentIds)
    const deletedSubmissionSet = new Set(deletedSubmissionIds)
    const deletedFolderSet = new Set(deletedFolderIds)

    const existingSubmissions = await db.submissions.toArray()

    debugLog(`📦 pullMetadata: 從雲端拉取 ${submissions.length} 筆 submissions`)
    debugLog(`📦 pullMetadata: 本地現有 ${existingSubmissions.length} 筆 submissions`)

    // 保留本地圖片數據（Blob 和 Base64）
    const imageDataMap = new Map(
      existingSubmissions.map((sub) => [
        sub.id,
        {
          imageBlob: sub.imageBlob,
          imageBase64: sub.imageBase64,
          thumbUrl: sub.thumbUrl
        }
      ])
    )

    debugLog(`📦 imageDataMap 建立完成，包含 ${imageDataMap.size} 筆圖片數據`)

    // 統計有多少本地圖片數據
    let blobCount = 0
    let base64Count = 0
    imageDataMap.forEach((data) => {
      if (data.imageBlob) blobCount++
      if (data.imageBase64) base64Count++
    })
    debugLog(`📊 本地圖片統計: ${blobCount} 個 Blob, ${base64Count} 個 Base64`)

    const mergedSubmissions: Submission[] = submissions
      .filter(
        (sub: Submission) =>
          sub?.id &&
          sub?.assignmentId &&
          sub?.studentId &&
          !deletedSubmissionSet.has(sub.id)
      )
      .map((sub: Submission) => {
        const createdAt =
          typeof sub.createdAt === 'number' && Number.isFinite(sub.createdAt)
            ? sub.createdAt
            : Date.now()
        const gradedAt =
          typeof sub.gradedAt === 'number' && Number.isFinite(sub.gradedAt)
            ? sub.gradedAt
            : undefined

        // 從本地恢復圖片數據
        const localImageData = imageDataMap.get(sub.id)
        const thumbUrl =
          (sub as Submission & { thumbUrl?: string }).thumbUrl ??
          (sub as { thumb_url?: string }).thumb_url ??
          (sub as Submission & { thumbnailUrl?: string }).thumbnailUrl ??
          (sub as { thumbnail_url?: string }).thumbnail_url ??
          localImageData?.thumbUrl

        if (localImageData && (localImageData.imageBlob || localImageData.imageBase64)) {
          debugLog(`🔄 恢復圖片數據: ${sub.id}`, {
            hasBlob: !!localImageData.imageBlob,
            hasBase64: !!localImageData.imageBase64,
            base64Length: localImageData.imageBase64?.length
          })
        }

        return {
          id: sub.id,
          assignmentId: sub.assignmentId,
          studentId: sub.studentId,
          status: sub.status || 'synced',
          createdAt,
          score: sub.score,
          feedback: sub.feedback,
          gradingResult: sub.gradingResult,
          gradedAt,
          correctionCount: sub.correctionCount,
          imageUrl: sub.imageUrl,
          thumbUrl,
          imageBlob: localImageData?.imageBlob,       // 保留本地 Blob
          imageBase64: localImageData?.imageBase64,   // 保留本地 Base64
          updatedAt: toMillis(sub.updatedAt ?? (sub as { updated_at?: unknown }).updated_at)
        }
      })

    debugLog(`✅ 合併完成，準備寫入 ${mergedSubmissions.length} 筆 submissions`)

    // 統計合併後的圖片數據
    let mergedBlobCount = 0
    let mergedBase64Count = 0
    mergedSubmissions.forEach((sub) => {
      if (sub.imageBlob) mergedBlobCount++
      if (sub.imageBase64) mergedBase64Count++
    })
    debugLog(`📊 合併後圖片統計: ${mergedBlobCount} 個 Blob, ${mergedBase64Count} 個 Base64`)

    debugLog('📥 pullMetadata - 從雲端收到的原始 classrooms:', classrooms)

    // 保留本地的 folder 資料（因為後端可能還不支援 folder 欄位）
    const existingClassrooms = await db.classrooms.toArray()
    const localFolderMap = new Map(
      existingClassrooms.map((c) => [c.id, c.folder])
    )

    const normalizedClassrooms: Classroom[] = classrooms
      .filter((c: Classroom) => c?.id && !deletedClassroomSet.has(c.id))
      .map((c: Classroom) => {
        const cloudFolder = (c as Classroom & { folder?: string }).folder
        const localFolder = localFolderMap.get(c.id)

        // 如果雲端有 folder，使用雲端的；否則保留本地的
        const finalFolder = cloudFolder !== undefined ? cloudFolder : localFolder

        return {
          id: c.id,
          name: c.name,
          folder: finalFolder,
          updatedAt: toMillis(
            (c as Classroom & { updatedAt?: unknown }).updatedAt ??
              (c as { updated_at?: unknown }).updated_at
          )
        }
      })

    debugLog('📥 pullMetadata - 正規化後的 classrooms:', normalizedClassrooms)

    const normalizedStudents: Student[] = students
      .filter((s: Student) => s?.id && s?.classroomId && !deletedStudentSet.has(s.id))
      .map((s: Student) => ({
        id: s.id,
        classroomId: s.classroomId,
        seatNumber: s.seatNumber,
        name: s.name,
        updatedAt: toMillis(
          (s as Student & { updatedAt?: unknown }).updatedAt ??
            (s as { updated_at?: unknown }).updated_at
        )
      }))

    // 保留本地的 assignment folder 資料（因為後端可能還不支援 folder 欄位）
    const existingAssignments = await db.assignments.toArray()
    const localAssignmentFolderMap = new Map(
      existingAssignments.map((a) => [a.id, { folder: a.folder, priorWeightTypes: a.priorWeightTypes }])
    )

    const normalizedAssignments: Assignment[] = assignments
      .filter(
        (a: Assignment) => a?.id && a?.classroomId && !deletedAssignmentSet.has(a.id)
      )
      .map((a: Assignment) => {
        const cloudFolder = (a as Assignment & { folder?: string }).folder
        const cloudPriorWeightTypes = (a as Assignment & { priorWeightTypes?: any }).priorWeightTypes
        const localData = localAssignmentFolderMap.get(a.id)

        // 如果雲端有資料，使用雲端的；否則保留本地的
        const finalFolder = cloudFolder !== undefined ? cloudFolder : localData?.folder
        const finalPriorWeightTypes = cloudPriorWeightTypes !== undefined ? cloudPriorWeightTypes : localData?.priorWeightTypes

        return {
          id: a.id,
          classroomId: a.classroomId,
          title: a.title,
          totalPages: a.totalPages,
          domain: a.domain ?? undefined,
          folder: finalFolder,
          priorWeightTypes: finalPriorWeightTypes,
          answerKey: a.answerKey ?? undefined,
          updatedAt: toMillis(
            (a as Assignment & { updatedAt?: unknown }).updatedAt ??
              (a as { updated_at?: unknown }).updated_at
          )
        }
      })

    const normalizedFolders = folders
      .filter((f: any) => f?.id && f?.name && !deletedFolderSet.has(f.id))
      .map((f: any) => ({
        id: f.id,
        name: f.name,
        type: f.type,
        updatedAt: toMillis(
          (f as { updatedAt?: unknown }).updatedAt ??
            (f as { updated_at?: unknown }).updated_at
        )
      }))

    if (deletedClassroomIds.length > 0) {
      await db.classrooms.bulkDelete(deletedClassroomIds)
    }
    if (deletedStudentIds.length > 0) {
      await db.students.bulkDelete(deletedStudentIds)
    }
    if (deletedAssignmentIds.length > 0) {
      await db.assignments.bulkDelete(deletedAssignmentIds)
    }
    if (deletedSubmissionIds.length > 0) {
      await db.submissions.bulkDelete(deletedSubmissionIds)
    }
    if (deletedFolderIds.length > 0) {
      debugLog('⚠️ 執行刪除 folders:', deletedFolderIds)
      await db.folders.bulkDelete(deletedFolderIds)
    }

    // 在所有 bulkDelete 之後檢查 folders
    const afterDelete = await db.folders.toArray()
    debugLog('📊 bulkDelete 之後的 folders:', afterDelete)

    // 先檢查 folders 狀態
    const beforePut = await db.folders.toArray()
    debugLog('📊 bulkPut 之前的 folders:', beforePut)

    await db.classrooms.bulkPut(normalizedClassrooms)

    // 檢查寫入後的 classrooms
    const afterPutClassrooms = await db.classrooms.toArray()
    debugLog('📊 bulkPut classrooms 之後的資料:', afterPutClassrooms)

    await db.students.bulkPut(normalizedStudents)
    await db.assignments.bulkPut(normalizedAssignments)
    await db.submissions.bulkPut(mergedSubmissions)

    // 再檢查 folders 狀態
    const afterPut = await db.folders.toArray()
    debugLog('📊 bulkPut 之後的 folders:', afterPut)

    // 只有當雲端有 folders 資料時才更新（避免覆蓋本地資料）
    if (folders.length > 0) {
      await db.folders.bulkPut(normalizedFolders)
      debugLog(`✅ 同步了 ${normalizedFolders.length} 個資料夾`)
    } else {
      debugLog('⚠️ 雲端沒有 folders 資料，保留本地資料夾')

      // 驗證本地資料夾是否真的保留
      const localFolders = await db.folders.toArray()
      debugLog('🔍 pullMetadata 後本地 folders:', localFolders)
    }
  }, [buildSyncUrl])
  // 頁面初次載入時更新 pendingCount
  useEffect(() => {
    if (isOnline) {
      void updatePendingCount()
    }
  }, [isOnline, updatePendingCount])

  /**
   * 執行同步
   */
  const performSync = useCallback(async () => {
    if (!isOnline) {
      console.log('📡 [同步] 跳過同步：離線狀態')
      debugLog('離線狀態，跳過同步')
      void updatePendingCount()
      notifySyncComplete() // 通知等待者同步已結束（即使跳過）
      return
    }

    if (isSyncingRef.current) {
      console.log('🔄 [同步] 跳過同步：目前正在同步中，已加入佇列')
      debugLog('目前正在同步中，跳過本次')
      syncQueuedRef.current = true
      // 觸發 notifySyncComplete，讓等待者知道這次請求已被處理（會在進行中的同步完成後執行）
      // 注意：這不會影響進行中的同步，只是通知等待者不需要再等
      notifySyncComplete()
      return
    }

    if (syncBlockedReasonRef.current) {
      console.log('🚫 [同步] 跳過同步：RLS 權限限制 -', syncBlockedReasonRef.current)
      console.warn('⚠️ 已偵測到 RLS 權限限制，暫停同步:', syncBlockedReasonRef.current)
      setStatus((prev) => ({ ...prev, isSyncing: false, error: null }))
      notifySyncComplete() // 通知等待者同步已結束（即使被阻擋）
      return
    }

    try {
      isSyncingRef.current = true
      setStatus((prev) => ({ ...prev, isSyncing: true, error: null }))

      // 檢查 performSync 開始時的 folders
      const performSyncStart = await db.folders.toArray()
      debugLog('🔵 performSync 開始時的 folders:', performSyncStart)

      const pendingSubmissions = await db.submissions
        .where('status')
        .equals('scanned')
        .toArray()

      console.log('🔄 [同步] 準備上傳 submissions:', {
        count: pendingSubmissions.length,
        ids: pendingSubmissions.map(s => s.id)
      })

      debugLog(`找到 ${pendingSubmissions.length} 條待同步紀錄`)

      let successCount = 0
      let failCount = 0

      for (const submission of pendingSubmissions) {
        try {
          const result = await syncSubmission(submission)
          if (result) {
            successCount++
          }
        } catch (error) {
          failCount++
          console.error('同步失敗:', error)
        }
      }

      if (pendingSubmissions.length > 0) {
        infoLog(`同步完成：成功 ${successCount} 筆，失敗 ${failCount} 筆`)
      }

      // 檢查 push 前的 folders
      if (syncBlockedReasonRef.current) {
        setStatus((prev) => ({
          ...prev,
          isSyncing: false,
          error: null
        }))
        return
      }

      const beforePush = await db.folders.toArray()
      debugLog('🔵 pushMetadata 前的 folders:', beforePush)

      await pushMetadata()
      if (syncBlockedReasonRef.current) {
        setStatus((prev) => ({
          ...prev,
          isSyncing: false,
          error: null
        }))
        return
      }

      // 檢查 push 後、pull 前的 folders
      const afterPushBeforePull = await db.folders.toArray()
      debugLog('🔵 pushMetadata 後、pullMetadata 前的 folders:', afterPushBeforePull)

      await pullMetadata()
      if (syncBlockedReasonRef.current) {
        setStatus((prev) => ({
          ...prev,
          isSyncing: false,
          error: null
        }))
        return
      }

      const remainingCount = await updatePendingCount()

      setStatus((prev) => ({
        ...prev,
        isSyncing: false,
        lastSyncTime: Date.now(),
        pendingCount: remainingCount,
        error: syncBlockedReasonRef.current
          ? null
          : failCount > 0
            ? `${failCount} 條記錄同步失敗`
            : null
      }))

      // 通知同步完成
      notifySyncComplete()
    } catch (error) {
      if (isRlsError(error)) {
        markSyncBlocked(error instanceof Error ? error.message : String(error))
        setStatus((prev) => ({ ...prev, isSyncing: false, error: null }))
        return
      }
      console.error('同步過程發生錯誤:', error)
      setStatus((prev) => ({
        ...prev,
        isSyncing: false,
        error: error instanceof Error ? error.message : '同步失敗'
      }))
    } finally {
      isSyncingRef.current = false
      if (syncQueuedRef.current) {
        syncQueuedRef.current = false
        window.setTimeout(() => {
          void performSync()
        }, 0)
      }
    }
  }, [isOnline, updatePendingCount, pushMetadata, pullMetadata])

  /**
   * 提供給外部手動觸發同步
   */
  const triggerSync = useCallback(() => {
    debugLog('手動觸發同步')
    void performSync()
  }, [performSync])

  useEffect(() => {
    if (!autoSync) return

    void updatePendingCount()
    if (isOnline) {
      void performSync()
    }
  }, [autoSync, isOnline, performSync, updatePendingCount])

  useEffect(() => {
    if (!autoSync) return
    const wasOnline = prevOnlineRef.current
    prevOnlineRef.current = isOnline
    if (!wasOnline && isOnline) {
      debugLog('網路恢復，觸發同步')
      void performSync()
    }
  }, [isOnline, autoSync, performSync])

  useEffect(() => {
    if (!autoSync) return

    const triggerIfVisible = () => {
      if (document.visibilityState !== 'visible') return
      const now = Date.now()
      if (now - lastFocusSyncRef.current < 500) return
      lastFocusSyncRef.current = now
      void performSync()
    }

    const handleVisibility = () => {
      triggerIfVisible()
    }

    const handleFocus = () => {
      triggerIfVisible()
    }

    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('focus', handleFocus)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('focus', handleFocus)
    }
  }, [autoSync, performSync])

  useEffect(() => {
    if (!autoSync) return

    const handleSyncRequest = () => {
      void performSync()
    }

    window.addEventListener(SYNC_EVENT_NAME, handleSyncRequest)
    return () => {
      window.removeEventListener(SYNC_EVENT_NAME, handleSyncRequest)
    }
  }, [autoSync, performSync])

  return {
    ...status,
    triggerSync,
    updatePendingCount
  }
}






