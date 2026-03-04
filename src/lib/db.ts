import Dexie, { type EntityTable } from 'dexie'
import { debugLog } from './logger'

/**
 * 標準答案資料結構
 * @deprecated 此類型已廢棄，請使用 QuestionCategoryType (1|2|3) 替代
 * 保留此類型僅用於向後兼容和數據遷移
 */
export type QuestionType =
  | 'truefalse'
  | 'choice'
  | 'fill'
  | 'calc'
  | 'qa'
  | 'short'
  | 'short_sentence'
  | 'long'
  | 'essay'

export interface RubricLevel {
  label: '優秀' | '良好' | '尚可' | '待努力'
  min: number
  max: number
  criteria: string
}

export interface Rubric {
  levels: RubricLevel[]
}

export type QuestionCategoryType = 1 | 2 | 3

export interface RubricDimension {
  name: string
  maxScore: number
  criteria: string
}

export interface AnswerKeyQuestion {
  id: string // 例如 "1", "1-1"
  idPath?: string[] // 題號層級路徑，例如 ["8","1"] -> "8-1"
  // 題號子格順序規則：strict=固定位置，unordered=同組可互換
  orderMode?: 'strict' | 'unordered'
  // 當 orderMode=unordered 時，同組題目的群組識別（例如 "1"）
  unorderedGroupId?: string

  // 題型分類：1=唯一答案(精確), 2=多答案可接受(模糊), 3=依表現給分(評價)
  type: QuestionCategoryType

  // Type 1 專用：標準答案（精確匹配）
  answer?: string
  // Type 1 專用：答案格式（連連看等結構化答案）
  answerFormat?: 'matching'
  // UI 專用：穩定的列表 key（避免編輯題號時失焦）
  uiKey?: string

  // Type 2/3 共用：參考答案
  referenceAnswer?: string

  // Type 2 專用：可接受的答案變體（同義詞清單）
  acceptableAnswers?: string[]

  // Type 3 專用：評分規準
  rubric?: Rubric // 4級評價（純評價題）
  rubricsDimensions?: RubricDimension[] // 多維度評分（有標準答案+思考過程）

  maxScore: number

  // AI 偏離 Prior Weight 提醒
  needsReanalysis?: boolean // 教師修改題型後標記為true，需要重新分析
  aiDivergedFromPrior?: boolean // AI判斷與教師prior weight不同時為true
  aiOriginalDetection?: QuestionCategoryType // AI最初判斷的類型（用於顯示ICON）

  // @deprecated 已廢棄的欄位（保留向後兼容）
  detectedType?: QuestionCategoryType // 已合併到 type
  detectionReason?: string // 已改用 aiOriginalDetection
}

export interface AnswerKey {
  questions: AnswerKeyQuestion[]
  totalScore: number
}

/**
 * 班級
 */
export interface Classroom {
  id: string
  name: string
  folder?: string // 資料夾分類（例如：112學年度、七年級）
  updatedAt?: number
}

/**
 * 學生
 */
export interface Student {
  id: string
  classroomId: string
  seatNumber: number
  name: string
  email?: string
  authUserId?: string
  updatedAt?: number
}

/**
 * 作業
 */
export interface Assignment {
  id: string
  classroomId: string
  title: string
  totalPages: number
  domain?: string // 國語、數學、社會、自然、英語、其他
  folder?: string // 資料夾分類（例如：段考、小考、作業）

  // Prior Weight：整份作業大部分題目屬性
  // 陣列順序表示優先級（index 0 = 最高優先級）
  // 例如：[2, 1, 3] 表示優先 Type 2，其次 Type 1，最後 Type 3
  priorWeightTypes?: QuestionCategoryType[]

  answerKey?: AnswerKey
  updatedAt?: number

  // @deprecated 已廢棄，請使用 priorWeightTypes 替代
  allowedQuestionTypes?: QuestionType[]
}

export type SubmissionStatus = 'missing' | 'scanned' | 'synced' | 'graded'

/**
 * 每題批改細節
 */
export interface GradingDetail {
  questionId: string
  detectedType?: QuestionCategoryType // 記錄此題的 Type 判定
  studentAnswer?: string
  studentFinalAnswer?: string
  score: number
  maxScore: number
  isCorrect?: boolean
  needExplain?: boolean
  errorType?: string
  reason?: string
  comment?: string
  confidence?: number
  sourceArea?: 'answer' | 'working' | string
  questionBbox?: { x: number; y: number; w: number; h: number } | null
  answerBbox?: { x: number; y: number; w: number; h: number } | null
  hasWorkingArea?: boolean
  workingBbox?: { x: number; y: number; w: number; h: number } | null
  visualKind?: string
  matchedLevel?: string
  // Type 2 專用：匹配詳情
  matchingDetails?: {
    matchedAnswer: string // 匹配到的參考答案
    matchType: 'exact' | 'synonym' | 'keyword' // 匹配方式
  }
  // Type 3 專用：各維度分數
  rubricScores?: Array<{
    dimension: string
    score: number
    maxScore: number
  }>

  // 一致性預處理（Phase A）新增欄位
  consistencyStatus?: 'stable' | 'diff' | 'unstable'
  readAnswer1?: { status: string; studentAnswer: string }
  readAnswer2?: { status: string; studentAnswer: string }
  finalAnswerSource?: 'ai_read1' | 'ai_read2' | 'manual'
  answerCropImageUrl?: string
  mistakeTypeCodes?: string[]
}

/**
 * 批改結果
 */
export interface GradingResult {
  totalScore: number
  mistakes: {
    id: string
    question: string
    reason: string
  }[]
  weaknesses: string[]
  suggestions: string[]
  feedback?: string[]
  details?: GradingDetail[]
  needsReview?: boolean
  reviewReasons?: string[]
}

export interface AnswerExtractionCorrection {
  id?: number
  assignmentId: string
  studentId: string
  submissionId: string
  questionId: string
  aiStudentAnswer: string
  correctedStudentAnswer: string
  createdAt: number
  domain?: string
}

/**
 * 學生作答/交卷
 */
export interface Submission {
  id: string
  assignmentId: string
  studentId: string
  status: SubmissionStatus
  imageBlob?: Blob
  imageBase64?: string  // Safari 備用：Base64 格式的圖片（包含 data URL prefix）
  imageUrl?: string
  thumbUrl?: string

  // 縮圖（用於 Grid 顯示，提升效能）
  thumbnailBlob?: Blob
  thumbnailBase64?: string  // Safari 備用：縮圖的 Base64 格式
  thumbnailUrl?: string     // Supabase 雲端縮圖 URL（可選）

  createdAt: number
  updatedAt?: number

  // AI 批改欄位
  score?: number
  feedback?: string
  gradingResult?: GradingResult
  gradedAt?: number

  // 訂正管理：教師手動紀錄訂正次數
  correctionCount?: number
  source?: string
  round?: number
  parentSubmissionId?: string
  actorUserId?: string
}

/**
 * 同步隊列（離線同步用）
 */
export interface SyncQueue {
  id?: number // auto-increment
  action: 'create' | 'update' | 'delete'
  tableName: string
  recordId: string
  data: unknown
  createdAt: number
  retryCount: number
}

/**
 * 資料夾（空資料夾管理）
 */
export interface Folder {
  id: string
  name: string
  type: 'classroom' | 'assignment'
  classroomId?: string // assignment 類型時綁定班級
  updatedAt?: number
}

export interface TeacherSummaryCache {
  cacheKey: string
  assignmentId: string
  bullets: string[]
  remedy?: string
  updatedAt: number
}

export interface DomainDiagnosisCache {
  cacheKey: string
  domain: string
  startDate: string
  endDate: string
  overview: string
  trendSummary: string
  teachingActions: string[]
  abilityInsight?: string
  updatedAt: number
}

/**
 * Dexie DB 定義
 */
class RedPenDatabase extends Dexie {
  classrooms!: EntityTable<Classroom, 'id'>
  students!: EntityTable<Student, 'id'>
  assignments!: EntityTable<Assignment, 'id'>
  submissions!: EntityTable<Submission, 'id'>
  syncQueue!: EntityTable<SyncQueue, 'id'>
  answerExtractionCorrections!: EntityTable<AnswerExtractionCorrection, 'id'>
  folders!: EntityTable<Folder, 'id'>
  teacherSummaryCache!: EntityTable<TeacherSummaryCache, 'cacheKey'>
  domainDiagnosisCache!: EntityTable<DomainDiagnosisCache, 'cacheKey'>

  constructor() {
    super('RedPenDB')

    debugLog('🏗️ 初始化 RedPenDatabase')

    this.version(1).stores({
      classrooms: '&id, name',
      students: '&id, classroomId, seatNumber, name',
      assignments: '&id, classroomId, title',
      submissions:
        '&id, assignmentId, studentId, status, createdAt, [assignmentId+studentId]',
      syncQueue: '++id, tableName, recordId, createdAt'
    })

    this.version(2).stores({
      classrooms: '&id, name',
      students: '&id, classroomId, seatNumber, name',
      assignments: '&id, classroomId, title',
      submissions:
        '&id, assignmentId, studentId, status, createdAt, [assignmentId+studentId]',
      syncQueue: '++id, tableName, recordId, createdAt',
      answerExtractionCorrections:
        '++id, assignmentId, studentId, submissionId, questionId, createdAt'
    })

    this.version(3).stores({
      classrooms: '&id, name, folder', // 新增 folder 索引
      students: '&id, classroomId, seatNumber, name',
      assignments: '&id, classroomId, title, folder', // 新增 folder 索引
      submissions:
        '&id, assignmentId, studentId, status, createdAt, [assignmentId+studentId]',
      syncQueue: '++id, tableName, recordId, createdAt',
      answerExtractionCorrections:
        '++id, assignmentId, studentId, submissionId, questionId, createdAt'
    })

    this.version(4).stores({
      classrooms: '&id, name, folder',
      students: '&id, classroomId, seatNumber, name',
      assignments: '&id, classroomId, title, folder',
      submissions:
        '&id, assignmentId, studentId, status, createdAt, [assignmentId+studentId]',
      syncQueue: '++id, tableName, recordId, createdAt',
      answerExtractionCorrections:
        '++id, assignmentId, studentId, submissionId, questionId, createdAt',
      folders: '&id, name, type' // 新增 folders table
    }).upgrade(async (trans) => {
      debugLog('🔧 執行資料庫 version 4 升級')
      // 遷移 localStorage 中的空資料夾到資料庫
      try {
        const classroomFoldersStr = localStorage.getItem('classroom-empty-folders')
        const assignmentFoldersStr = localStorage.getItem('assignment-empty-folders')

        debugLog('📦 準備遷移 localStorage folders:', {
          classroom: classroomFoldersStr,
          assignment: assignmentFoldersStr
        })

        if (classroomFoldersStr) {
          const classroomFolders = JSON.parse(classroomFoldersStr) as string[]
          for (const folderName of classroomFolders) {
            if (folderName && folderName.trim()) {
              await trans.table('folders').add({
                id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                name: folderName.trim(),
                type: 'classroom',
                updatedAt: Date.now()
              })
            }
          }
          // 清除舊的 localStorage 資料
          localStorage.removeItem('classroom-empty-folders')
          debugLog('✅ 已遷移班級資料夾:', classroomFolders.length)
        }

        if (assignmentFoldersStr) {
          const assignmentFolders = JSON.parse(assignmentFoldersStr) as string[]
          for (const folderName of assignmentFolders) {
            if (folderName && folderName.trim()) {
              await trans.table('folders').add({
                id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                name: folderName.trim(),
                type: 'assignment',
                updatedAt: Date.now()
              })
            }
          }
          // 清除舊的 localStorage 資料
          localStorage.removeItem('assignment-empty-folders')
          debugLog('✅ 已遷移作業資料夾:', assignmentFolders.length)
        }

        debugLog('✅ 資料庫升級完成')
      } catch (error) {
        console.error('❌ 遷移 localStorage 資料夾失敗:', error)
      }
    })

    this.version(5).stores({
      classrooms: '&id, name, folder',
      students: '&id, classroomId, seatNumber, name',
      assignments: '&id, classroomId, title, folder',
      submissions:
        '&id, assignmentId, studentId, status, createdAt, [assignmentId+studentId]',
      syncQueue: '++id, tableName, recordId, createdAt',
      answerExtractionCorrections:
        '++id, assignmentId, studentId, submissionId, questionId, createdAt',
      folders: '&id, name, type, classroomId, [type+classroomId], [type+classroomId+name]'
    }).upgrade(async (trans) => {
      debugLog('?? 執行資料庫 version 5 升級')
      try {
        const foldersTable = trans.table('folders')
        const assignmentsTable = trans.table('assignments')
        const classroomsTable = trans.table('classrooms')

        const [folders, assignments, classrooms] = await Promise.all([
          foldersTable.toArray(),
          assignmentsTable.toArray(),
          classroomsTable.toArray()
        ])

        const folderUsage = new Map<string, Set<string>>()
        assignments.forEach((assignment: Assignment) => {
          if (!assignment.folder || !assignment.classroomId) return
          const key = assignment.folder
          const usedBy = folderUsage.get(key) ?? new Set<string>()
          usedBy.add(assignment.classroomId)
          folderUsage.set(key, usedBy)
        })

        const existingAssignmentFolders = new Set<string>()
        folders.forEach((folder) => {
          if (folder.type === 'assignment' && folder.classroomId) {
            existingAssignmentFolders.add(`${folder.classroomId}::${folder.name}`)
          }
        })

        const singleClassroomId = classrooms.length === 1 ? classrooms[0].id : null

        for (const folder of folders) {
          if (folder.type !== 'assignment' || folder.classroomId) continue
          const usedBy = folderUsage.get(folder.name)

          if (usedBy && usedBy.size === 1) {
            const [classroomId] = Array.from(usedBy)
            await foldersTable.update(folder.id, { classroomId })
            existingAssignmentFolders.add(`${classroomId}::${folder.name}`)
          } else if (usedBy && usedBy.size > 1) {
            for (const classroomId of usedBy) {
              const key = `${classroomId}::${folder.name}`
              if (existingAssignmentFolders.has(key)) continue
              await foldersTable.add({
                id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                name: folder.name,
                type: 'assignment',
                classroomId,
                updatedAt: Date.now()
              })
              existingAssignmentFolders.add(key)
            }
            await foldersTable.delete(folder.id)
          } else if (singleClassroomId) {
            await foldersTable.update(folder.id, { classroomId: singleClassroomId })
            existingAssignmentFolders.add(`${singleClassroomId}::${folder.name}`)
          }
        }

        debugLog('? 資料庫 version 5 升級完成')
      } catch (error) {
        console.error('? 資料庫 version 5 升級失敗:', error)
      }
    })

    this.version(6).stores({
      classrooms: '&id, name, folder',
      students: '&id, classroomId, seatNumber, name',
      assignments: '&id, classroomId, title, folder',
      submissions:
        '&id, assignmentId, studentId, status, createdAt, [assignmentId+studentId]',
      syncQueue: '++id, tableName, recordId, createdAt',
      answerExtractionCorrections:
        '++id, assignmentId, studentId, submissionId, questionId, createdAt',
      folders: '&id, name, type, classroomId, [type+classroomId], [type+classroomId+name]',
      teacherSummaryCache: '&cacheKey, assignmentId, updatedAt'
    })

    this.version(7).stores({
      classrooms: '&id, name, folder',
      students: '&id, classroomId, seatNumber, name',
      assignments: '&id, classroomId, title, folder',
      submissions:
        '&id, assignmentId, studentId, status, createdAt, [assignmentId+studentId]',
      syncQueue: '++id, tableName, recordId, createdAt',
      answerExtractionCorrections:
        '++id, assignmentId, studentId, submissionId, questionId, createdAt',
      folders: '&id, name, type, classroomId, [type+classroomId], [type+classroomId+name]',
      teacherSummaryCache: '&cacheKey, assignmentId, updatedAt',
      domainDiagnosisCache: '&cacheKey, domain, startDate, endDate, updatedAt'
    })

    const setUpdatedAt = (value: unknown) => {
      if (typeof value === 'number' && Number.isFinite(value)) return value
      return Date.now()
    }

    const applyUpdatedAtOnCreate = (obj: { updatedAt?: number }) => {
      if (obj.updatedAt === undefined) {
        obj.updatedAt = setUpdatedAt(obj.updatedAt)
      }
    }

    const applyUpdatedAtOnUpdate = (mods: Record<string, unknown> | object) => {
      const mutableMods = mods as Record<string, unknown>
      if (!('updatedAt' in mutableMods)) {
        mutableMods.updatedAt = Date.now()
      }
      return mutableMods
    }

    const normalizeRound = (value: unknown): number => {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.max(0, Math.floor(value))
      }
      if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value)
        if (Number.isFinite(parsed)) {
          return Math.max(0, Math.floor(parsed))
        }
      }
      return 0
    }

    this.classrooms.hook('creating', (_, obj) => {
      applyUpdatedAtOnCreate(obj)
    })
    this.classrooms.hook('updating', (mods) => applyUpdatedAtOnUpdate(mods))

    this.students.hook('creating', (_, obj) => {
      applyUpdatedAtOnCreate(obj)
    })
    this.students.hook('updating', (mods) => applyUpdatedAtOnUpdate(mods))

    this.assignments.hook('creating', (_, obj) => {
      applyUpdatedAtOnCreate(obj)
    })
    this.assignments.hook('updating', (mods) => applyUpdatedAtOnUpdate(mods))

    this.submissions.hook('creating', (_, obj) => {
      if (obj.createdAt === undefined) {
        obj.createdAt = Date.now()
      }
      obj.round = normalizeRound(obj.round)
      applyUpdatedAtOnCreate(obj)
    })
    this.submissions.hook('updating', (mods) => {
      const mutableMods = mods as Record<string, unknown>
      if ('round' in mutableMods) {
        mutableMods.round = normalizeRound(mutableMods.round)
      }
      const keys = Object.keys(mods)
      if (keys.length === 1 && keys[0] === 'imageBlob') {
        return mods
      }
      return applyUpdatedAtOnUpdate(mutableMods)
    })

    this.folders.hook('creating', (_, obj) => {
      applyUpdatedAtOnCreate(obj)
    })
    this.folders.hook('updating', (mods) => applyUpdatedAtOnUpdate(mods))
  }
}

export const db = new RedPenDatabase()

// 檢查資料庫初始化後的狀態
db.open().then(async () => {
  const folders = await db.folders.toArray()
  debugLog('🗄️ 資料庫開啟後的 folders:', folders)
  debugLog('📊 資料庫版本:', db.verno)
}).catch(error => {
  console.error('❌ 資料庫開啟失敗:', error)
})

// 工具
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
}

export function getCurrentTimestamp(): number {
  return Date.now()
}

/**
 * 數據遷移：將舊的 QuestionType 轉換為 QuestionCategoryType
 */
export function migrateLegacyQuestionType(oldType: QuestionType): QuestionCategoryType {
  const mapping: Record<QuestionType, QuestionCategoryType> = {
    'truefalse': 1,
    'choice': 1,
    'fill': 2,
    'short': 2,
    'short_sentence': 2,
    'calc': 3,
    'qa': 3,
    'long': 3,
    'essay': 3
  }
  return mapping[oldType]
}

/**
 * 數據遷移：將舊作業的 allowedQuestionTypes 轉換為 priorWeightTypes
 */
export function migrateAssignmentPriorWeights(assignment: Assignment): Assignment {
  // 如果已經有 priorWeightTypes，不需要遷移
  if (assignment.priorWeightTypes && assignment.priorWeightTypes.length > 0) {
    return assignment
  }

  // 如果沒有 allowedQuestionTypes，返回原樣
  if (!assignment.allowedQuestionTypes || assignment.allowedQuestionTypes.length === 0) {
    return assignment
  }

  // 將 allowedQuestionTypes 映射為 priorWeightTypes 並去重排序
  const priorWeightTypes = Array.from(
    new Set(assignment.allowedQuestionTypes.map(migrateLegacyQuestionType))
  ).sort() as QuestionCategoryType[]

  return {
    ...assignment,
    priorWeightTypes
  }
}

/**
 * 數據遷移：將舊題目的 type 從 QuestionType 轉換為 QuestionCategoryType
 */
export function migrateAnswerKeyQuestion(question: any): AnswerKeyQuestion {
  // 如果 type 已經是數字（QuestionCategoryType），不需要遷移
  if (typeof question.type === 'number') {
    return question as AnswerKeyQuestion
  }

  // 如果沒有 type，嘗試從 detectedType 讀取
  if (!question.type && question.detectedType) {
    return {
      ...question,
      type: question.detectedType
    } as AnswerKeyQuestion
  }

  // 如果有舊的 QuestionType（字串），轉換為 QuestionCategoryType
  if (question.type && typeof question.type === 'string') {
    return {
      ...question,
      type: migrateLegacyQuestionType(question.type as QuestionType)
    } as AnswerKeyQuestion
  }

  // 如果都沒有，預設為 Type 2（最常見）
  return {
    ...question,
    type: 2
  } as AnswerKeyQuestion
}
