import { useState, useEffect, useCallback, useRef } from 'react'
import { db } from '@/lib/db'
import { useOnlineStatus } from './useOnlineStatus'
import { SYNC_EVENT_NAME, notifySyncComplete } from '@/lib/sync-events'
import { clearDeleteQueue, readDeleteQueue, queueDeleteMany } from '@/lib/sync-delete-queue'
import type {
  Assignment,
  Classroom,
  GradebookCustomColumn,
  GradebookCustomScore,
  Student,
  Submission
} from '@/lib/db'
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

const toNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

const FOCUS_SYNC_COOLDOWN_MS = 60_000 // 任何 sync 完成後的冷卻期（60 秒）
const LAST_SYNC_TIME_STORAGE_KEY = 'redpen-last-sync-at'

function readPersistedLastSyncTime(): number | null {
  if (typeof window === 'undefined') return null
  const raw = window.localStorage.getItem(LAST_SYNC_TIME_STORAGE_KEY)
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return parsed
}

function persistLastSyncTime(value: number) {
  if (typeof window === 'undefined') return
  if (!Number.isFinite(value) || value <= 0) return
  window.localStorage.setItem(LAST_SYNC_TIME_STORAGE_KEY, String(Math.floor(value)))
}

export function useSync(options: UseSyncOptions = {}) {
  const { autoSync = true } = options

  const isOnline = useOnlineStatus()
  const [status, setStatus] = useState<SyncStatus>({
    isSyncing: false,
    lastSyncTime: readPersistedLastSyncTime(),
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
      if (isQuotaError(error)) {
        console.warn('⚠️ IndexedDB 儲存空間不足，略過圖片快取')
        return
      }
      if (!avoidBlobStorage && blob && isIndexedDbBlobError(error)) {
        delete payload.imageBlob
        try {
          await db.submissions.update(submissionId, payload)
        } catch (err2) {
          if (isQuotaError(err2)) {
            console.warn('⚠️ IndexedDB 儲存空間不足，略過 Base64 快取')
            return
          }
          throw err2
        }
      } else {
        throw error
      }
    }
  }

  const isQuotaError = (error: unknown): boolean => {
    if (error instanceof Error) {
      return error.name === 'QuotaExceededError' || error.message.toLowerCase().includes('quota')
    }
    return false
  }

  const isAbortError = (error: unknown): boolean => {
    if (error instanceof Error) {
      return (
        error.name === 'AbortError' ||
        error.message.toLowerCase().includes('interrupted') ||
        error.message.toLowerCase().includes('abort')
      )
    }
    return false
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

      const submissionController = new AbortController()
      const submissionAbortTimer = setTimeout(() => submissionController.abort(), 30_000)
      const response = await fetch('/api/data/submission', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        signal: submissionController.signal,
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
      }).finally(() => clearTimeout(submissionAbortTimer))

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

          const retryController = new AbortController()
          const retryAbortTimer = setTimeout(() => retryController.abort(), 30_000)
          const retryResponse = await fetch('/api/data/submission', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            signal: retryController.signal,
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
          }).finally(() => clearTimeout(retryAbortTimer))

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

  const pushStartedAtRef = useRef<number>(0)

  /**
   * 上傳本機資料到雲端
   */
  const pushMetadata = useCallback(async () => {
    debugLog('📤 pushMetadata 開始')
    const [
      classrooms,
      students,
      assignments,
      submissions,
      folders,
      gradebookCustomColumns,
      gradebookCustomScores,
      answerKeyTemplates,
      deleteQueue
    ] =
      await Promise.all([
        db.classrooms.toArray(),
        db.students.toArray(),
        db.assignments.toArray(),
        db.submissions.toArray(),
        db.folders.toArray(),
        db.gradebookCustomColumns.toArray(),
        db.gradebookCustomScores.toArray(),
        db.answerKeyTemplates.toArray(),
        readDeleteQueue()
      ])

    const lastSuccessfulSyncAt = readPersistedLastSyncTime()
    // 記錄 push 開始時間 — persistLastSyncTime 使用此值而非 completedAt
    // 確保 push 執行期間新建的資料不會被下次過濾掉
    pushStartedAtRef.current = Date.now()

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
      folders: [],
      gradebook_custom_columns: [],
      gradebook_custom_scores: [],
      answer_key_templates: []
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

    // 各資料表的刪除 ID 集合，push 時排除，避免「建了又刪」的項目被 server 重新建立
    const deletedClassroomIds = new Set(
      [...deleteMap.values()].filter((e) => e.tableName === 'classrooms').map((e) => e.recordId)
    )
    const deletedStudentIds = new Set(
      [...deleteMap.values()].filter((e) => e.tableName === 'students').map((e) => e.recordId)
    )
    const deletedAssignmentIds = new Set(
      [...deleteMap.values()].filter((e) => e.tableName === 'assignments').map((e) => e.recordId)
    )
    const deletedGradebookCustomColumnIds = new Set(
      [...deleteMap.values()]
        .filter((e) => e.tableName === 'gradebook_custom_columns')
        .map((e) => e.recordId)
    )
    const deletedGradebookCustomScoreIds = new Set(
      [...deleteMap.values()]
        .filter((e) => e.tableName === 'gradebook_custom_scores')
        .map((e) => e.recordId)
    )
    const deletedAnswerKeyTemplateIds = new Set(
      [...deleteMap.values()]
        .filter((e) => e.tableName === 'answer_key_templates')
        .map((e) => e.recordId)
    )

    const classroomPayload = classrooms
      .filter((c) => c?.id && !deletedClassroomIds.has(c.id))
      .map((c) => ({
        id: c.id,
        name: c.name,
        folder: c.folder === undefined ? null : c.folder,
        grade: c.grade ?? null,
        updatedAt: c.updatedAt
      }))

    debugLog('📤 pushMetadata - 準備發送的 classrooms:', classroomPayload)

    // students 全送（每筆很小），避免因 lastSync 時間差導致新學生被跳過
    const studentPayload = students
      .filter((s) => s?.id && s?.classroomId && !deletedStudentIds.has(s.id))
      .map((s) => ({
        id: s.id,
        classroomId: s.classroomId,
        seatNumber: s.seatNumber,
        name: s.name,
        email: s.email,
        updatedAt: s.updatedAt
      }))

    // assignments 全送（數量少、payload 小），避免因 lastSync 時間差導致新建作業被跳過
    const assignmentPayload = assignments
      .filter((a) => a?.id && a?.classroomId && !deletedAssignmentIds.has(a.id))
      .map((a) => ({
        id: a.id,
        classroomId: a.classroomId,
        title: a.title,
        totalPages: a.totalPages,
        domain: a.domain,
        docType: a.docType ?? null,
        folder: a.folder === undefined ? null : a.folder,
        scoringMode: a.scoringMode === 'unscored' ? 'unscored' : 'scored',
        gradeWeightPercent:
          typeof a.gradeWeightPercent === 'number' && Number.isFinite(a.gradeWeightPercent)
            ? a.gradeWeightPercent
            : null,
        answerKey: a.answerKey ? {
          ...a.answerKey,
          questions: a.answerKey.questions?.map(q => {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { cropImageUrl, ...rest } = q
            return rest
          })
        } : undefined,
        answerKeyTemplateId: a.answerKeyTemplateId ?? null,
        conceptTags: a.conceptTags,
        studentUploadEnabled: a.studentUploadEnabled,
        updatedAt: a.updatedAt
      }))
    
    console.log(`📤 [Sync Push] 準備上傳 ${assignmentPayload.length} 個作業:`, assignmentPayload.map(a => ({ id: a.id, title: a.title, hasAnswerKey: !!a.answerKey })))

    // submissions push: 只送結構性 metadata（不送批改資料）
    // 批改分數/結果由 save-grading API 直接寫入 Supabase，不經過 sync
    const submissionPayload = submissions
      .filter((sub) => {
        if (sub.status === 'scanned') return false
        if (!lastSuccessfulSyncAt) return true
        const localUpdatedAt = toNumber(sub.updatedAt) ?? 0
        if (localUpdatedAt >= lastSuccessfulSyncAt) return true
        return false
      })
      .map(({ imageBlob, imageBase64, thumbnailBlob, thumbnailBase64, gradingResult, ...rest }) => ({
        // 結構性欄位（sync 負責）
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
        correctionCount: rest.correctionCount,
        source: rest.source,
        round: toNumber(rest.round) ?? 0,
        parentSubmissionId: rest.parentSubmissionId,
        actorUserId: rest.actorUserId,
        updatedAt: rest.updatedAt
        // 不送: score, aiScore, scoreSource, feedback, gradingResult, gradedAt
        // 這些由 save-grading API 負責
      }))


    const foldersPayload = folders
      .filter((f) => f?.id && f?.name)
      .map((f) => ({
        id: f.id,
        name: f.name,
        type: f.type,
        classroomId: f.classroomId ?? undefined,
        updatedAt: f.updatedAt
      }))

    const gradebookCustomColumnsPayload = gradebookCustomColumns
      .filter((c) => c?.id && c?.classroomId && !deletedGradebookCustomColumnIds.has(c.id))
      .map((c) => ({
        id: c.id,
        classroomId: c.classroomId,
        name: c.name,
        weightPercent:
          typeof c.weightPercent === 'number' && Number.isFinite(c.weightPercent)
            ? c.weightPercent
            : 0,
        sortOrder:
          typeof c.sortOrder === 'number' && Number.isFinite(c.sortOrder)
            ? Math.floor(c.sortOrder)
            : 0,
        updatedAt: c.updatedAt
      }))

    const gradebookCustomScoresPayload = gradebookCustomScores
      .filter((s) =>
        s?.id && s?.classroomId && s?.columnId && s?.studentId &&
        !deletedGradebookCustomScoreIds.has(s.id) && !deletedGradebookCustomColumnIds.has(s.columnId)
      )
      .map((s) => ({
        id: s.id,
        classroomId: s.classroomId,
        columnId: s.columnId,
        studentId: s.studentId,
        score:
          s.score === null
            ? null
            : typeof s.score === 'number' && Number.isFinite(s.score)
              ? s.score
              : null,
        updatedAt: s.updatedAt
      }))

    const answerKeyTemplatesPayload = answerKeyTemplates
      .filter((t) => {
        if (!t?.id || !t?.answerKey) return false
        if (deletedAnswerKeyTemplateIds.has(t.id)) return false
        // 只推送有變更的 templates（避免每次 sync 都送全部的大 payload）
        if (lastSuccessfulSyncAt && t.updatedAt && t.updatedAt < lastSuccessfulSyncAt) return false
        return true
      })
      .map((t) => ({
        id: t.id,
        name: t.name,
        domain: t.domain ?? null,
        docType: t.docType ?? null,
        folder: t.folder ?? null,
        answerKey: t.answerKey ? {
          ...t.answerKey,
          questions: t.answerKey.questions?.map(q => {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { cropImageUrl, ...rest } = q
            return rest
          })
        } : undefined,
        questionCount: t.questionCount ?? t.answerKey?.questions?.length ?? 0,
        totalScore: t.totalScore ?? t.answerKey?.totalScore ?? 0,
        version: t.version ?? 1,
        shareCode: t.shareCode ?? undefined,
        pageOrientations: t.pageOrientations ?? undefined,
        answerSheetMode: t.answerSheetMode ?? undefined,
        questionBookletImagePaths: t.questionBookletImagePaths ?? undefined,
        updatedAt: t.updatedAt
      }))

    const pushController = new AbortController()
    const pushAbortTimer = setTimeout(() => pushController.abort(), 50_000)
    const response = await fetch(buildSyncUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      cache: 'no-store',
      signal: pushController.signal,
      body: JSON.stringify({
        classrooms: classroomPayload,
        students: studentPayload,
        assignments: assignmentPayload,
        submissions: submissionPayload,
        folders: foldersPayload,
        gradebookCustomColumns: gradebookCustomColumnsPayload,
        gradebookCustomScores: gradebookCustomScoresPayload,
        answerKeyTemplates: answerKeyTemplatesPayload,
        deleted: deletedPayload
      })
    }).finally(() => clearTimeout(pushAbortTimer))

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
    const pullController = new AbortController()
    const pullAbortTimer = setTimeout(() => pullController.abort(), 50_000)
    const response = await fetch(buildSyncUrl(), {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      signal: pullController.signal
    }).finally(() => clearTimeout(pullAbortTimer))

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
    const gradebookCustomColumns = Array.isArray(data.gradebookCustomColumns)
      ? data.gradebookCustomColumns
      : []
    const answerKeyTemplatesData = Array.isArray(data.answerKeyTemplates) ? data.answerKeyTemplates : []
    const gradebookCustomScores = Array.isArray(data.gradebookCustomScores)
      ? data.gradebookCustomScores
      : []
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
    const deletedGradebookCustomColumnIds = collectDeletedIds(deleted.gradebook_custom_columns)
    const deletedGradebookCustomScoreIds = collectDeletedIds(deleted.gradebook_custom_scores)
    const deletedAnswerKeyTemplateIdsPull = collectDeletedIds(deleted.answer_key_templates)

    debugLog('🗑️ 要刪除的 folders:', deletedFolderIds)

    // 在 bulkDelete 之前檢查 folders
    const beforeDelete = await db.folders.toArray()
    debugLog('📊 bulkDelete 之前的 folders:', beforeDelete)

    const deletedClassroomSet = new Set(deletedClassroomIds)
    const deletedStudentSet = new Set(deletedStudentIds)
    const deletedAssignmentSet = new Set(deletedAssignmentIds)
    const deletedSubmissionSet = new Set(deletedSubmissionIds)
    const deletedFolderSet = new Set(deletedFolderIds)
    const deletedGradebookCustomColumnSet = new Set(deletedGradebookCustomColumnIds)
    const deletedGradebookCustomScoreSet = new Set(deletedGradebookCustomScoreIds)
    const deletedAnswerKeyTemplateSet = new Set(deletedAnswerKeyTemplateIdsPull)

    const existingSubmissions = await db.submissions.toArray()

    debugLog(`📦 pullMetadata: 從雲端拉取 ${submissions.length} 筆 submissions`)
    debugLog(`📦 pullMetadata: 本地現有 ${existingSubmissions.length} 筆 submissions`)

    // 保留本地資料，避免 pull 覆蓋
    // 圖片：imageBlob, imageBase64（server 不存）
    // 批改：score, aiScore, scoreSource, gradingResult, gradedAt, feedback, status（由 save-grading API 負責同步）
    const imageDataMap = new Map(
      existingSubmissions.map((sub) => [
        sub.id,
        {
          imageBlob: sub.imageBlob,
          imageBase64: sub.imageBase64,
          imageUrl: sub.imageUrl,
          thumbUrl: sub.thumbUrl,
          thumbnailBlob: sub.thumbnailBlob,
          thumbnailBase64: sub.thumbnailBase64,
          thumbnailUrl: sub.thumbnailUrl,
          // 批改欄位（本地優先，sync 不碰）
          gradingResult: sub.gradingResult,
          status: sub.status,
          gradedAt: sub.gradedAt,
          score: sub.score,
          aiScore: sub.aiScore,
          scoreSource: sub.scoreSource,
          feedback: sub.feedback
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
      .filter((sub: Submission) => {
        const assignmentId =
          (sub as Submission & { assignmentId?: string }).assignmentId ??
          (sub as { assignment_id?: string }).assignment_id
        const studentId =
          (sub as Submission & { studentId?: string }).studentId ??
          (sub as { student_id?: string }).student_id
        return Boolean(sub?.id && assignmentId && studentId && !deletedSubmissionSet.has(sub.id))
      })
      .map((sub: Submission) => {
        const assignmentId =
          (sub as Submission & { assignmentId?: string }).assignmentId ??
          (sub as { assignment_id?: string }).assignment_id
        const studentId =
          (sub as Submission & { studentId?: string }).studentId ??
          (sub as { student_id?: string }).student_id
        const createdAt =
          typeof sub.createdAt === 'number' && Number.isFinite(sub.createdAt)
            ? sub.createdAt
            : Date.now()

        // 從本地恢復圖片 + 批改數據
        const local = imageDataMap.get(sub.id)

        // ── 結構性欄位：以 server 為主 ──
        const serverStatus = (sub.status || 'synced') as string
        const imageUrl =
          (sub as Submission & { imageUrl?: string }).imageUrl ??
          (sub as { image_url?: string }).image_url ??
          local?.imageUrl
        const thumbUrl =
          (sub as Submission & { thumbUrl?: string }).thumbUrl ??
          (sub as { thumb_url?: string }).thumb_url ??
          (sub as Submission & { thumbnailUrl?: string }).thumbnailUrl ??
          (sub as { thumbnail_url?: string }).thumbnail_url ??
          local?.thumbUrl ??
          local?.thumbnailUrl

        // ── 批改欄位：本地優先，server 僅作新裝置 fallback ──
        // 規則：本地有值 → 用本地（sync 不碰批改）
        //       本地無值 → 用 server（新裝置首次 pull）
        const serverGradingResult =
          (sub as Submission & { gradingResult?: unknown }).gradingResult ??
          (sub as { grading_result?: unknown }).grading_result ??
          undefined
        const serverScore = sub.score
        const serverAiScore = (sub as Submission & { aiScore?: number }).aiScore ?? (sub as { ai_score?: number }).ai_score
        const serverScoreSource = (sub as Submission & { scoreSource?: string }).scoreSource ?? (sub as { score_source?: string }).score_source
        const serverGradedAt =
          typeof sub.gradedAt === 'number' && Number.isFinite(sub.gradedAt)
            ? sub.gradedAt
            : undefined

        const gradingResult = local?.gradingResult ?? serverGradingResult
        const score = local?.score ?? serverScore
        const aiScore = local?.aiScore ?? serverAiScore
        const scoreSource = local?.scoreSource ?? serverScoreSource
        const gradedAt = local?.gradedAt ?? serverGradedAt
        // status：本地是 graded 就保持 graded（不被 server 的 synced 覆蓋）
        const finalStatus = (local?.status === 'graded') ? 'graded' : serverStatus

        return {
          id: sub.id,
          assignmentId: assignmentId!,
          studentId: studentId!,
          status: finalStatus,
          createdAt,
          // 批改欄位（本地優先）
          score,
          aiScore,
          scoreSource: scoreSource as 'ai' | 'manual' | undefined,
          feedback: local?.feedback ?? sub.feedback,
          gradingResult,
          gradedAt,
          mistakesCount: (sub as Submission & { mistakesCount?: number }).mistakesCount,
          // 結構性欄位（server 為主）
          correctionCount: sub.correctionCount,
          source:
            (sub as Submission & { source?: string }).source ??
            (sub as { source?: string }).source ??
            undefined,
          round:
            toNumber(
              (sub as Submission & { round?: unknown }).round ??
              (sub as { round?: unknown }).round
            ) ?? 0,
          parentSubmissionId:
            (sub as Submission & { parentSubmissionId?: string }).parentSubmissionId ??
            (sub as { parent_submission_id?: string }).parent_submission_id ??
            undefined,
          actorUserId:
            (sub as Submission & { actorUserId?: string }).actorUserId ??
            (sub as { actor_user_id?: string }).actor_user_id ??
            undefined,
          imageUrl: imageUrl || undefined,
          thumbUrl,
          // 本地圖片資料（永遠保留）
          imageBlob: local?.imageBlob,
          imageBase64: local?.imageBase64,
          thumbnailBlob: local?.thumbnailBlob,
          thumbnailBase64: local?.thumbnailBase64,
          thumbnailUrl:
            (sub as Submission & { thumbnailUrl?: string }).thumbnailUrl ??
            (sub as { thumbnail_url?: string }).thumbnail_url ??
            local?.thumbnailUrl,
          updatedAt: toMillis(sub.updatedAt ?? (sub as { updated_at?: unknown }).updated_at) || undefined
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

    // 保留本地的 folder / grade 資料（雲端可能還沒同步到最新）
    const existingClassrooms = await db.classrooms.toArray()
    const localFolderMap = new Map(
      existingClassrooms.map((c) => [c.id, c.folder])
    )
    const localGradeMap = new Map(
      existingClassrooms.map((c) => [c.id, c.grade])
    )

    const normalizedClassrooms: Classroom[] = classrooms
      .filter((c: Classroom) => c?.id && !deletedClassroomSet.has(c.id))
      .map((c: Classroom) => {
        const cloudFolder = (c as Classroom & { folder?: string }).folder
        const localFolder = localFolderMap.get(c.id)

        // 如果雲端有 folder，使用雲端的；否則保留本地的
        const finalFolder = cloudFolder !== undefined ? cloudFolder : localFolder

        const rawGrade = (c as Classroom & { grade?: unknown }).grade
        const parsedGrade = rawGrade != null ? parseInt(String(rawGrade), 10) : undefined
        const cloudGrade = parsedGrade != null && !isNaN(parsedGrade) ? parsedGrade : undefined
        // 如果雲端有 grade，使用雲端的；否則保留本地的（避免 push 前 pull 蓋掉本地值）
        const finalGrade = cloudGrade !== undefined ? cloudGrade : localGradeMap.get(c.id)
        return {
          id: c.id,
          name: c.name,
          folder: finalFolder,
          grade: finalGrade,
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
        email: (s as Student & { email?: string }).email ?? undefined,
        authUserId:
          (s as Student & { authUserId?: string }).authUserId ??
          (s as { auth_user_id?: string }).auth_user_id ??
          undefined,
        updatedAt: toMillis(
          (s as Student & { updatedAt?: unknown }).updatedAt ??
            (s as { updated_at?: unknown }).updated_at
        )
      }))

    // 保留本地的 assignment folder 資料（因為後端可能還不支援 folder 欄位）
    const existingAssignments = await db.assignments.toArray()
    const localAssignmentMetaMap = new Map(
      existingAssignments.map((a) => [
        a.id,
        {
          folder: a.folder,
          scoringMode: a.scoringMode,
          gradeWeightPercent: a.gradeWeightPercent,
          updatedAt: a.updatedAt,
          answerKey: a.answerKey,
          answerKeyTemplateId: a.answerKeyTemplateId,
          conceptTags: a.conceptTags,
          answerSheetImagePaths: a.answerSheetImagePaths,
          answerSheetMode: a.answerSheetMode,
          questionBookletImagePaths: a.questionBookletImagePaths
        }
      ])
    )
    const existingFolders = await db.folders.toArray()
    const localFolderClassroomMap = new Map(
      existingFolders.map((folder) => [folder.id, folder.classroomId])
    )

    const normalizedAssignments: Assignment[] = assignments
      .filter(
        (a: Assignment) => a?.id && a?.classroomId && !deletedAssignmentSet.has(a.id)
      )
      .map((a: Assignment) => {
        const cloudFolder = (a as Assignment & { folder?: string }).folder
        const cloudScoringModeRaw =
          (a as Assignment & { scoringMode?: unknown }).scoringMode ??
          (a as { scoring_mode?: unknown }).scoring_mode
        const cloudScoringMode =
          cloudScoringModeRaw === 'unscored'
            ? 'unscored'
            : cloudScoringModeRaw === 'scored'
              ? 'scored'
              : undefined
        const localData = localAssignmentMetaMap.get(a.id)
        const cloudGradeWeightPercentRaw =
          (a as Assignment & { gradeWeightPercent?: unknown }).gradeWeightPercent ??
          (a as { grade_weight_percent?: unknown }).grade_weight_percent
        const cloudGradeWeightPercent = toNumber(cloudGradeWeightPercentRaw)

        // 如果雲端有資料，使用雲端的；否則保留本地的
        const finalFolder = cloudFolder !== undefined ? cloudFolder : localData?.folder
        const finalScoringMode = cloudScoringMode ?? localData?.scoringMode
        const finalGradeWeightPercent =
          cloudGradeWeightPercent !== undefined
            ? cloudGradeWeightPercent
            : localData?.gradeWeightPercent

        const cloudUpdatedAt = toMillis(
          (a as Assignment & { updatedAt?: unknown }).updatedAt ??
            (a as { updated_at?: unknown }).updated_at
        )
        const localUpdatedAt = localData?.updatedAt
        // 若本地資料比雲端新（push 尚未完成就被 pull 覆蓋的競態），保留本地 answerKey 和 updatedAt
        const localIsNewer = !!(localUpdatedAt && cloudUpdatedAt && localUpdatedAt > cloudUpdatedAt)

        const cloudConceptTags = (a as Assignment & { conceptTags?: unknown }).conceptTags ?? (a as { concept_tags?: unknown }).concept_tags
        return {
          id: a.id,
          classroomId: a.classroomId,
          title: a.title,
          totalPages: a.totalPages,
          domain: a.domain ?? undefined,
          docType: (a as any).docType ?? (a as any).doc_type ?? undefined,
          folder: finalFolder,
          scoringMode: finalScoringMode,
          gradeWeightPercent: finalGradeWeightPercent,
          answerKey: localIsNewer ? (localData?.answerKey ?? a.answerKey ?? undefined) : (a.answerKey ?? undefined),
          answerKeyTemplateId:
            (a as Assignment & { answerKeyTemplateId?: string }).answerKeyTemplateId ??
            (a as { answer_key_template_id?: string }).answer_key_template_id ??
            localData?.answerKeyTemplateId,
          // conceptTags: 優先用雲端（若有），否則保留本地（避免 bulkPut 洗掉）
          conceptTags: (cloudConceptTags ?? localData?.conceptTags) as Assignment['conceptTags'] | undefined,
          // answerSheetImagePaths / questionBookletImagePaths: 本地端特有欄位，永遠保留本地資料
          answerSheetImagePaths: localData?.answerSheetImagePaths,
          answerSheetMode: (a as any).answerSheetMode ?? (a as any).answer_sheet_mode ?? localData?.answerSheetMode,
          questionBookletImagePaths: localData?.questionBookletImagePaths,
          studentUploadEnabled: (a as any).studentUploadEnabled ?? (a as any).student_upload_enabled ?? (localData as any)?.studentUploadEnabled,
          updatedAt: localIsNewer ? localUpdatedAt : cloudUpdatedAt
        }
      })

    const existingCustomColumns = await db.gradebookCustomColumns.toArray()
    const existingCustomScores = await db.gradebookCustomScores.toArray()
    const localCustomColumnMap = new Map(existingCustomColumns.map((c) => [c.id, c]))
    const localCustomScoreMap = new Map(existingCustomScores.map((s) => [s.id, s]))

    const normalizedGradebookCustomColumns: GradebookCustomColumn[] = gradebookCustomColumns
      .filter(
        (c: GradebookCustomColumn & { classroom_id?: string }) =>
          c?.id &&
          (c.classroomId || c.classroom_id) &&
          !deletedGradebookCustomColumnSet.has(c.id)
      )
      .map((c: GradebookCustomColumn & {
        classroom_id?: string
        weight_percent?: unknown
        sort_order?: unknown
        updated_at?: unknown
      }) => {
        const localData = localCustomColumnMap.get(c.id)
        const cloudUpdatedAt = toMillis(c.updatedAt ?? c.updated_at)
        const localUpdatedAt = localData?.updatedAt
        const localIsNewer = !!(localUpdatedAt && cloudUpdatedAt && localUpdatedAt > cloudUpdatedAt)

        if (localIsNewer && localData) {
          return localData
        }

        return {
          id: c.id,
          classroomId: c.classroomId ?? c.classroom_id!,
          name: c.name,
          weightPercent: toNumber(c.weightPercent ?? c.weight_percent) ?? 0,
          sortOrder:
            toNumber(c.sortOrder ?? c.sort_order) != null
              ? Math.floor(toNumber(c.sortOrder ?? c.sort_order)!)
              : 0,
          updatedAt: cloudUpdatedAt
        }
      })

    const normalizedGradebookCustomScores: GradebookCustomScore[] = gradebookCustomScores
      .filter(
        (s: GradebookCustomScore & { classroom_id?: string; column_id?: string; student_id?: string }) =>
          s?.id &&
          (s.classroomId || s.classroom_id) &&
          (s.columnId || s.column_id) &&
          (s.studentId || s.student_id) &&
          !deletedGradebookCustomScoreSet.has(s.id)
      )
      .map((s: GradebookCustomScore & {
        classroom_id?: string
        column_id?: string
        student_id?: string
        updated_at?: unknown
      }) => {
        const localData = localCustomScoreMap.get(s.id)
        const cloudUpdatedAt = toMillis(s.updatedAt ?? s.updated_at)
        const localUpdatedAt = localData?.updatedAt
        const localIsNewer = !!(localUpdatedAt && cloudUpdatedAt && localUpdatedAt > cloudUpdatedAt)

        if (localIsNewer && localData) {
          return localData
        }

        const parsedScore =
          s.score === null || s.score === undefined ? null : toNumber(s.score) ?? null
        return {
          id: s.id,
          classroomId: s.classroomId ?? s.classroom_id!,
          columnId: s.columnId ?? s.column_id!,
          studentId: s.studentId ?? s.student_id!,
          score: parsedScore,
          updatedAt: cloudUpdatedAt
        }
      })

    const normalizedFolders = folders
      .filter((f: any) => f?.id && f?.name && !deletedFolderSet.has(f.id))
      .map((f: any) => ({
        id: f.id,
        name: f.name,
        type: f.type,
        classroomId:
          f.classroomId ??
          f.classroom_id ??
          localFolderClassroomMap.get(f.id) ??
          undefined,
        updatedAt: toMillis(
          (f as { updatedAt?: unknown }).updatedAt ??
            (f as { updated_at?: unknown }).updated_at
        )
      }))

    // Normalize answer key templates from pull
    const normalizedTemplates = answerKeyTemplatesData
      .filter((t: any) => t?.id && t?.answerKey)
      .map((t: any) => ({
        id: t.id,
        name: t.name ?? '',
        domain: t.domain ?? undefined,
        docType: t.docType ?? t.doc_type ?? undefined,
        folder: t.folder ?? undefined,
        answerKey: t.answerKey ?? t.answer_key,
        questionCount: t.questionCount ?? t.question_count ?? t.answerKey?.questions?.length ?? 0,
        totalScore: t.totalScore ?? t.total_score ?? t.answerKey?.totalScore ?? 0,
        shareCode: t.shareCode ?? t.share_code ?? undefined,
        pageOrientations: t.pageOrientations ?? t.page_orientations ?? undefined,
        answerSheetMode: t.answerSheetMode ?? t.answer_sheet_mode ?? undefined,
        questionBookletImagePaths: t.questionBookletImagePaths ?? t.question_booklet_image_paths ?? undefined,
        version: t.version ?? 1,
        updatedAt: toMillis(t.updatedAt ?? t.updated_at),
      }))

    if (deletedClassroomIds.length > 0) {
      // 防禦性級聯：清理被刪班級的所有子實體
      const orphanStudents = await db.students.where('classroomId').anyOf(deletedClassroomIds).toArray()
      if (orphanStudents.length > 0) {
        const sIds = orphanStudents.map(s => s.id)
        await db.answerExtractionCorrections.where('studentId').anyOf(sIds).delete()
        await db.students.bulkDelete(sIds)
      }
      const orphanAssignments = await db.assignments.where('classroomId').anyOf(deletedClassroomIds).toArray()
      if (orphanAssignments.length > 0) {
        const aIds = orphanAssignments.map(a => a.id)
        const orphanSubs = await db.submissions.where('assignmentId').anyOf(aIds).toArray()
        if (orphanSubs.length > 0) {
          await db.answerExtractionCorrections.where('submissionId').anyOf(orphanSubs.map(s => s.id)).delete()
          await db.submissions.bulkDelete(orphanSubs.map(s => s.id))
        }
        await db.answerExtractionCorrections.where('assignmentId').anyOf(aIds).delete()
        await db.teacherSummaryCache.where('assignmentId').anyOf(aIds).delete()
        await db.assignments.bulkDelete(aIds)
      }
      const orphanFolders = await db.folders.where('classroomId').anyOf(deletedClassroomIds).toArray()
      if (orphanFolders.length > 0) {
        await db.folders.bulkDelete(orphanFolders.map(f => f.id))
      }
      const orphanCustomColumns = await db.gradebookCustomColumns
        .where('classroomId')
        .anyOf(deletedClassroomIds)
        .toArray()
      if (orphanCustomColumns.length > 0) {
        const columnIds = orphanCustomColumns.map((c) => c.id)
        await db.gradebookCustomColumns.bulkDelete(columnIds)
        await db.gradebookCustomScores.where('columnId').anyOf(columnIds).delete()
      }
      await db.gradebookCustomScores.where('classroomId').anyOf(deletedClassroomIds).delete()
      await db.classrooms.bulkDelete(deletedClassroomIds)
    }
    if (deletedStudentIds.length > 0) {
      // 級聯清理學生的 submissions
      const studentOrphanSubs = await db.submissions.where('studentId').anyOf(deletedStudentIds).toArray()
      if (studentOrphanSubs.length > 0) {
        await db.answerExtractionCorrections.where('submissionId').anyOf(studentOrphanSubs.map(s => s.id)).delete()
        await db.submissions.bulkDelete(studentOrphanSubs.map(s => s.id))
      }
      await db.students.bulkDelete(deletedStudentIds)
      await db.answerExtractionCorrections.where('studentId').anyOf(deletedStudentIds).delete()
      await db.gradebookCustomScores.where('studentId').anyOf(deletedStudentIds).delete()
    }
    if (deletedAssignmentIds.length > 0) {
      // 級聯清理作業的 submissions
      const assignmentOrphanSubs = await db.submissions.where('assignmentId').anyOf(deletedAssignmentIds).toArray()
      if (assignmentOrphanSubs.length > 0) {
        await db.answerExtractionCorrections.where('submissionId').anyOf(assignmentOrphanSubs.map(s => s.id)).delete()
        await db.submissions.bulkDelete(assignmentOrphanSubs.map(s => s.id))
      }
      await db.assignments.bulkDelete(deletedAssignmentIds)
      await db.answerExtractionCorrections.where('assignmentId').anyOf(deletedAssignmentIds).delete()
      await db.teacherSummaryCache.where('assignmentId').anyOf(deletedAssignmentIds).delete()
    }
    if (deletedSubmissionIds.length > 0) {
      await db.submissions.bulkDelete(deletedSubmissionIds)
      await db.answerExtractionCorrections.where('submissionId').anyOf(deletedSubmissionIds).delete()
    }
    if (deletedFolderIds.length > 0) {
      debugLog('⚠️ 執行刪除 folders:', deletedFolderIds)
      await db.folders.bulkDelete(deletedFolderIds)
    }
    if (deletedGradebookCustomColumnIds.length > 0) {
      await db.gradebookCustomColumns.bulkDelete(deletedGradebookCustomColumnIds)
      await db.gradebookCustomScores.where('columnId').anyOf(deletedGradebookCustomColumnIds).delete()
    }
    if (deletedGradebookCustomScoreIds.length > 0) {
      await db.gradebookCustomScores.bulkDelete(deletedGradebookCustomScoreIds)
    }
    if (deletedAnswerKeyTemplateIdsPull.length > 0) {
      await db.answerKeyTemplates.bulkDelete(deletedAnswerKeyTemplateIdsPull)
      debugLog(`🗑️ 刪除了 ${deletedAnswerKeyTemplateIdsPull.length} 個答案卷模板`)
    }

    // 在所有 bulkDelete 之後檢查 folders
    const afterDelete = await db.folders.toArray()
    debugLog('📊 bulkDelete 之後的 folders:', afterDelete)

    // 讀取本地待刪除佇列，防止雲端舊資料覆蓋使用者已刪除的記錄
    const pendingDeletes = await readDeleteQueue()
    const pendingDeleteByTable = new Map<string, Set<string>>()
    for (const entry of pendingDeletes) {
      if (!pendingDeleteByTable.has(entry.tableName)) {
        pendingDeleteByTable.set(entry.tableName, new Set())
      }
      pendingDeleteByTable.get(entry.tableName)!.add(entry.recordId)
    }
    const pendingClassroomDeletes = pendingDeleteByTable.get('classrooms') ?? new Set()
    const pendingStudentDeletes = pendingDeleteByTable.get('students') ?? new Set()
    const pendingAssignmentDeletes = pendingDeleteByTable.get('assignments') ?? new Set()
    const pendingSubmissionDeletes = pendingDeleteByTable.get('submissions') ?? new Set()
    const pendingFolderDeletes = pendingDeleteByTable.get('folders') ?? new Set()
    const pendingGradebookCustomColumnDeletes =
      pendingDeleteByTable.get('gradebook_custom_columns') ?? new Set()
    const pendingGradebookCustomScoreDeletes =
      pendingDeleteByTable.get('gradebook_custom_scores') ?? new Set()
    const pendingAnswerKeyTemplateDeletes =
      pendingDeleteByTable.get('answer_key_templates') ?? new Set()

    if (pendingDeletes.length > 0) {
      debugLog(`🛡️ 本地有 ${pendingDeletes.length} 筆待刪除記錄，bulkPut 將跳過這些 ID`)
    }

    // 過濾掉本地待刪除的記錄，避免雲端舊資料復活
    const safeClassrooms = normalizedClassrooms.filter(c => !pendingClassroomDeletes.has(c.id))
    const safeStudents = normalizedStudents.filter(s => !pendingStudentDeletes.has(s.id))
    const safeAssignments = normalizedAssignments.filter(a => !pendingAssignmentDeletes.has(a.id))
    const safeSubmissions = mergedSubmissions.filter(s => !pendingSubmissionDeletes.has(s.id))
    const safeFolders = normalizedFolders.filter((f: { id: string }) => !pendingFolderDeletes.has(f.id))
    const safeGradebookCustomColumns = normalizedGradebookCustomColumns.filter(
      (c) => !pendingGradebookCustomColumnDeletes.has(c.id)
    )
    const safeGradebookCustomScores = normalizedGradebookCustomScores.filter(
      (s) =>
        !pendingGradebookCustomScoreDeletes.has(s.id) &&
        !pendingGradebookCustomColumnDeletes.has(s.columnId)
    )

    if (safeClassrooms.length < normalizedClassrooms.length) {
      debugLog(`🛡️ 跳過 ${normalizedClassrooms.length - safeClassrooms.length} 個待刪除的 classrooms`)
    }
    if (safeStudents.length < normalizedStudents.length) {
      debugLog(`🛡️ 跳過 ${normalizedStudents.length - safeStudents.length} 個待刪除的 students`)
    }
    if (safeAssignments.length < normalizedAssignments.length) {
      debugLog(`🛡️ 跳過 ${normalizedAssignments.length - safeAssignments.length} 個待刪除的 assignments`)
    }
    if (safeSubmissions.length < mergedSubmissions.length) {
      debugLog(`🛡️ 跳過 ${mergedSubmissions.length - safeSubmissions.length} 個待刪除的 submissions`)
    }
    if (safeFolders.length < normalizedFolders.length) {
      debugLog(`🛡️ 跳過 ${normalizedFolders.length - safeFolders.length} 個待刪除的 folders`)
    }
    if (safeGradebookCustomColumns.length < normalizedGradebookCustomColumns.length) {
      debugLog(
        `🛡️ 跳過 ${
          normalizedGradebookCustomColumns.length - safeGradebookCustomColumns.length
        } 個待刪除的 gradebook_custom_columns`
      )
    }
    if (safeGradebookCustomScores.length < normalizedGradebookCustomScores.length) {
      debugLog(
        `🛡️ 跳過 ${
          normalizedGradebookCustomScores.length - safeGradebookCustomScores.length
        } 個待刪除的 gradebook_custom_scores`
      )
    }

    // 先檢查 folders 狀態
    const beforePut = await db.folders.toArray()
    debugLog('📊 bulkPut 之前的 folders:', beforePut)

    await db.classrooms.bulkPut(safeClassrooms)

    // 檢查寫入後的 classrooms
    const afterPutClassrooms = await db.classrooms.toArray()
    debugLog('📊 bulkPut classrooms 之後的資料:', afterPutClassrooms)

    await db.students.bulkPut(safeStudents)
    await db.assignments.bulkPut(safeAssignments)
    await db.gradebookCustomColumns.bulkPut(safeGradebookCustomColumns)
    await db.gradebookCustomScores.bulkPut(safeGradebookCustomScores)
    try {
      await db.submissions.bulkPut(safeSubmissions)
    } catch (err) {
      if (isQuotaError(err)) {
        console.warn('⚠️ IndexedDB 儲存空間不足，略過圖片快取後重試寫入 submissions（保留 gradingResult）')
        const stripped = safeSubmissions.map(
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          ({ imageBlob, imageBase64, thumbnailBlob, thumbnailBase64, ...rest }) => rest as Submission
        )
        try {
          await db.submissions.bulkPut(stripped)
        } catch (err2) {
          if (isQuotaError(err2)) {
            console.warn('⚠️ IndexedDB 儲存空間持續不足，跳過 submissions 本地更新')
          } else {
            throw err2
          }
        }
      } else {
        throw err
      }
    }

    // 再檢查 folders 狀態
    const afterPut = await db.folders.toArray()
    debugLog('📊 bulkPut 之後的 folders:', afterPut)

    // 只有當雲端有 folders 資料時才更新（避免覆蓋本地資料）
    if (safeFolders.length > 0) {
      await db.folders.bulkPut(safeFolders)
      debugLog(`✅ 同步了 ${safeFolders.length} 個資料夾`)
    } else {
      debugLog('⚠️ 雲端沒有 folders 資料（或全部待刪除），保留本地資料夾')

      // 驗證本地資料夾是否真的保留
      const localFolders = await db.folders.toArray()
      debugLog('🔍 pullMetadata 後本地 folders:', localFolders)
    }

    // Answer key templates
    const safeTemplates = normalizedTemplates.filter(
      (t: { id: string }) => !deletedAnswerKeyTemplateSet.has(t.id) && !pendingAnswerKeyTemplateDeletes.has(t.id)
    )
    if (safeTemplates.length > 0) {
      await db.answerKeyTemplates.bulkPut(safeTemplates)
      debugLog(`✅ 同步了 ${safeTemplates.length} 個答案卷模板`)
    }

    // 清理孤兒 assignment folders（所屬班級已被刪除）
    const allLocalFolders = await db.folders.toArray()
    const allClassroomIds = new Set((await db.classrooms.toArray()).map(c => c.id))
    const orphanFolders = allLocalFolders.filter(
      f => f.type === 'assignment' && f.classroomId && !allClassroomIds.has(f.classroomId)
    )
    if (orphanFolders.length > 0) {
      const orphanIds = orphanFolders.map(f => f.id)
      await queueDeleteMany('folders', orphanIds)
      await db.folders.bulkDelete(orphanIds)
      debugLog(`🧹 清理了 ${orphanIds.length} 個孤兒 assignment 資料夾:`, orphanIds)
    }

    // 清理孤兒 gradebook columns/scores
    const allCustomColumns = await db.gradebookCustomColumns.toArray()
    const orphanCustomColumns = allCustomColumns.filter(
      (c) => !allClassroomIds.has(c.classroomId)
    )
    if (orphanCustomColumns.length > 0) {
      const orphanColumnIds = orphanCustomColumns.map((c) => c.id)
      await queueDeleteMany('gradebook_custom_columns', orphanColumnIds)
      await db.gradebookCustomColumns.bulkDelete(orphanColumnIds)
      await db.gradebookCustomScores.where('columnId').anyOf(orphanColumnIds).delete()
      debugLog(`🧹 清理了 ${orphanColumnIds.length} 個孤兒 gradebook custom columns`, orphanColumnIds)
    }

    const allStudents = await db.students.toArray()
    const allStudentIds = new Set(allStudents.map((s) => s.id))
    const validColumnIds = new Set((await db.gradebookCustomColumns.toArray()).map((c) => c.id))
    const allCustomScores = await db.gradebookCustomScores.toArray()
    const orphanCustomScores = allCustomScores.filter(
      (s) =>
        !allClassroomIds.has(s.classroomId) ||
        !allStudentIds.has(s.studentId) ||
        !validColumnIds.has(s.columnId)
    )
    if (orphanCustomScores.length > 0) {
      const orphanScoreIds = orphanCustomScores.map((s) => s.id)
      await queueDeleteMany('gradebook_custom_scores', orphanScoreIds)
      await db.gradebookCustomScores.bulkDelete(orphanScoreIds)
      debugLog(`🧹 清理了 ${orphanScoreIds.length} 個孤兒 gradebook custom scores`, orphanScoreIds)
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
      notifySyncComplete({
        success: false,
        skipped: true,
        error: 'offline'
      }) // 通知等待者同步已結束（即使跳過）
      return
    }

    if (isSyncingRef.current) {
      console.log('🔄 [同步] 跳過同步：目前正在同步中，已加入佇列')
      debugLog('目前正在同步中，跳過本次')
      syncQueuedRef.current = true
      // 不可在此提早宣告完成；需等實際同步流程完成後再通知
      return
    }

    if (syncBlockedReasonRef.current) {
      console.log('🚫 [同步] 跳過同步：RLS 權限限制 -', syncBlockedReasonRef.current)
      console.warn('⚠️ 已偵測到 RLS 權限限制，暫停同步:', syncBlockedReasonRef.current)
      setStatus((prev) => ({ ...prev, isSyncing: false, error: null }))
      notifySyncComplete({
        success: false,
        blocked: true,
        error: syncBlockedReasonRef.current
      }) // 通知等待者同步已結束（即使被阻擋）
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

      // Pull runs in parallel with push+scan-upload so the teacher sees new
      // student submissions immediately, without waiting for pending uploads.
      let failCount = 0
      const pushWork = (async () => {
        let successCount = 0

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

        if (syncBlockedReasonRef.current) return

        debugLog('🔵 pushMetadata 前的 folders:', await db.folders.toArray())
        await pushMetadata()
      })()

      await Promise.all([pullMetadata(), pushWork])
      if (syncBlockedReasonRef.current) {
        setStatus((prev) => ({
          ...prev,
          isSyncing: false,
          error: null
        }))
        if (!syncQueuedRef.current) {
          notifySyncComplete({
            success: false,
            blocked: true,
            error: syncBlockedReasonRef.current
          })
        }
        return
      }

      const remainingCount = await updatePendingCount()
      const completedAt = Date.now()
      // 用 push 開始時間（而非完成時間）記錄 lastSync
      // 確保 push 執行期間新建的資料（updatedAt 在 pushStartedAt 之後）下次不會被過濾掉
      persistLastSyncTime(pushStartedAtRef.current || completedAt)

      lastFocusSyncRef.current = Date.now() // 重設 focus 冷卻，避免 sync 剛完成就再觸發
      setStatus((prev) => ({
        ...prev,
        isSyncing: false,
        lastSyncTime: completedAt,
        pendingCount: remainingCount,
        error: syncBlockedReasonRef.current
          ? null
          : failCount > 0
            ? `${failCount} 條記錄同步失敗`
            : null
      }))

      // 只有在沒有排隊中的 sync 時才通知完成。
      // 若 syncQueuedRef 為 true，表示有另一個 requestSync(true) 在等待，
      // 需讓排隊的 sync 完成後再通知，確保 waitForSync() 拿到最新資料。
      if (!syncQueuedRef.current) {
        notifySyncComplete({ success: true, error: null })
      }
    } catch (error) {
      if (isRlsError(error)) {
        markSyncBlocked(error instanceof Error ? error.message : String(error))
        setStatus((prev) => ({ ...prev, isSyncing: false, error: null }))
        notifySyncComplete({
          success: false,
          blocked: true,
          error: error instanceof Error ? error.message : String(error)
        })
        return
      }
      if (isAbortError(error)) {
        console.log('🔄 [同步] 請求被中斷（用戶操作或離開頁面），靜默處理')
        setStatus((prev) => ({ ...prev, isSyncing: false, error: null }))
        notifySyncComplete({
          success: false,
          skipped: true,
          error: error instanceof Error ? error.message : String(error)
        })
        return
      }
      if (isQuotaError(error)) {
        console.warn('⚠️ [同步] IndexedDB 儲存空間不足，同步仍視為完成')
        setStatus((prev) => ({ ...prev, isSyncing: false, error: null }))
        notifySyncComplete({
          success: false,
          error: error instanceof Error ? error.message : String(error)
        })
        return
      }
      console.error('同步過程發生錯誤:', error)
      const message = error instanceof Error ? error.message : '同步失敗'
      setStatus((prev) => ({
        ...prev,
        isSyncing: false,
        error: message
      }))
      notifySyncComplete({
        success: false,
        error: message
      })
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
      if (now - lastFocusSyncRef.current < FOCUS_SYNC_COOLDOWN_MS) return
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
    const handleSyncRequest = () => {
      void performSync()
    }

    window.addEventListener(SYNC_EVENT_NAME, handleSyncRequest)
    return () => {
      window.removeEventListener(SYNC_EVENT_NAME, handleSyncRequest)
    }
  }, [performSync])

  return {
    ...status,
    triggerSync,
    updatePendingCount
  }
}






