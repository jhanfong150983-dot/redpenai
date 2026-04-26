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

/**
 * 題型分類（老師視角）
 * 取代抽象的 type: 1|2|3，直接以題型名稱描述批改規則。
 * Internal type 1/2/3 從此欄位自動 derive（向後兼容）。
 */
export type QuestionCategory =
  | 'single_choice'  // 單選選擇：在括號()內填一個代號（A/甲/①），二元給分
  | 'multi_choice'   // 多選選擇：在括號()內填多個代號（逗號分隔，如"A,C"），部分給分
  | 'single_check'   // 單選勾選：在方框□內標記一個選項（✓/○/×），二元給分
  | 'multi_check'       // 多選勾選：在方框□內標記多個選項，部分給分
  | 'multi_check_other' // 多選勾選（含其他）：同 multi_check，但最後一個選項是開放填寫的「其他：___」，不計入勾選分數
  | 'true_false'     // 是非題：二元判斷（○/✗）
  | 'fill_blank'     // 填充題：唯一正解，單位嚴格比對
  | 'fill_variants'  // 填充題（多元）：多種說法皆可（造詞、近義詞）
  | 'calculation'    // 計算題：純算式，列式過程+數值答案，不查單位
  | 'word_problem'   // 應用題：數學情境題，需列式+答句含單位/文字
  | 'short_answer'   // 簡答題：非數學文字說明，按關鍵概念給分
  | 'map_fill'       // 填圖題：地圖多位置填文字，位置-名稱配對
  | 'map_draw'       // 繪圖題：地圖符號/格紙幾何/連線圖，符號類型+位置精準度
  | 'diagram_draw'   // 圖表繪製題：繪製長條圖/圓餅圖等，標籤+數值
  | 'diagram_color'  // 塗色題：在預印圖形上塗色/填色，判斷比例/位置/範圍正確
  | 'matching'       // 連連看：左欄項目畫線連到右欄項目，每個子題對應一個配對
  | 'multi_fill'     // 多項填入題：空白框手寫多個代號（如ㄅ、ㄇ），無勾選動作，順序無關，集合比對
  // 預留未來擴充：
  // | 'ordering'       // 排序題
  // | 'diagram_label'  // 標示圖題

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

  // 題型分類（老師視角）：直接描述題型，批改規則從此推導
  // 若存在則優先使用；不存在時 fallback 到 type (1|2|3)
  questionCategory?: QuestionCategory

  // 題型分類（內部）：1=唯一答案(精確), 2=多答案可接受(模糊), 3=依表現給分(評價)
  // 當 questionCategory 存在時，此欄位為 derived field（自動計算）
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
  aiMaxScore?: number // AI 原始配分（永遠不動，供老師還原用）

  // 答案卷上此題的參考位置（歸一化 [0,1] bbox）
  // 用於 Reference-guided Classify：提示 AI 學生答案大約在哪個位置
  // 對地圖填圖等無題號的空間配置型作業特別重要
  referenceBbox?: { x: number; y: number; w: number; h: number }

  // AI 擷取答案時自動偵測的答案區塊位置（歸一化 [0,1] bbox）
  // 從 answer_key.extract 回傳，用於在批改時提示答案大約在哪個位置
  answerBbox?: { x: number; y: number; w: number; h: number } | null

  // 此題的 answerBbox 是相對於第幾頁的圖片（0-based）
  // 多頁答案卷時用於 wizard 顯示正確的頁面預覽
  pageIndex?: number

  // 後端 Sharp 裁切的答案區截圖（base64 data URL），由 answer_key.extract 後處理產生
  cropImageUrl?: string
  // Supabase Storage 路徑（answer-crops/{assignmentId}/{questionId}.jpg），持久化版本
  cropImagePath?: string

  needsReanalysis?: boolean // 教師修改題型後標記為true，需要重新分析

  // 108課綱對應概念（由 AnswerKey 抽取時 AI 標記）
  concept_code?: string   // 例如 "N-4-12"
  concept_label?: string  // 例如 "積樣與立方公分"

  // 語義錨點：描述此答案格附近可識別的文字/數字/圖形特徵（1-2句）
  // 由 answer_key.extract 萃取，用於輔助 classify 定位正確的答案格（不依賴座標）
  // 例如："表格中欄標題為「22」的格子"、"題幹「擲出來的點數和可能大於1嗎？」旁的括號"
  anchorHint?: string

  // 表格座標定位（由 answer_key.extract 產生）
  // 用於 classify 階段精準定位表格中的答案格，比 anchorHint 更可靠
  tablePosition?: {
    col: number      // 欄位序號（1-based，含標題欄，從最左邊開始）
    row: number      // 列序號（1-based，含標題列，從最上面開始）
    totalCols: number // 表格總欄數
    totalRows: number // 表格總列數
    colspan?: number  // 合併欄數（預設 1）
    rowspan?: number  // 合併列數（預設 1）
  }

  // @deprecated 已廢棄的欄位（保留向後兼容）
  detectedType?: QuestionCategoryType // 已合併到 type
}

export interface AnswerKey {
  questions: AnswerKeyQuestion[]
  totalScore: number
  strictness?: 'strict' | 'standard' | 'lenient'
  // 配分設定（老師選擇的配分方式，用於還原/重新套用）
  scoreMode?: 'ai_auto' | 'fixed_per_question' | 'fixed_total' | 'fixed_both'
  fixedPerScore?: number  // 每題固定分（scoreMode=fixed_per_question 或 fixed_both 時）
  fixedTotal?: number     // 固定總分（scoreMode=fixed_total 或 fixed_both 時）
  // 分數約分規則（數學領域專用）
  // require_simplified: 必須最簡分數（2/4 算錯，2/2=1 除外）
  // allow_equivalent: 接受等值分數（2/4 = 1/2 算對）
  fractionRule?: 'require_simplified' | 'allow_equivalent'
  // 英語領域專用批改規則
  englishRules?: {
    // 標點符號檢查：句尾需 ? . / 縮寫需 '
    punctuationCheck?: { enabled: boolean; deductionPerError: number }
    // 單字順序/缺漏檢查：單字位置錯誤或缺少單字
    wordOrderCheck?: { enabled: boolean; deductionPerError: number }
  }
}

/**
 * 班級
 */
export interface Classroom {
  id: string
  name: string
  folder?: string // 資料夾分類（例如：112學年度、七年級）
  grade?: number  // 年級（1–12），用於課綱概念篩選
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
  gradeWeightPercent?: number // 成績統計權重（百分比格式，作業+自訂欄位總和需為 100）

  scoringMode?: 'scored' | 'unscored' // 不計分：批改只顯示✓✗△，不納入成績統計
  docType?: 'worksheet' | 'exam' // 作業形式：習作 / 考卷（影響答案卷排序策略）
  answerSheetMode?: 'with_questions' | 'answer_only' // 答案卷模式：帶題目 / 純答案卷（題目在另一本題本）
  answerKey?: AnswerKey // 向後兼容：舊資料直接存答案卷
  answerKeyTemplateId?: string // 新架構：引用獨立的答案卷模板
  conceptTags?: Record<string, { code: string; label: string }> // 108課綱概念標記（questionId → concept）
  // Supabase Storage 路徑，answer-sheets/{id}/page-{i}.webp（各頁壓縮圖，用於 wizard 預覽）
  answerSheetImagePaths?: string[]
  // 題本圖 Supabase Storage 路徑，question-booklets/{id}/page-{i}.webp（純答案卷模式下，老師上傳的題本）
  questionBookletImagePaths?: string[]
  // 作業繳交規則（是否開放學生上傳 + 頁數方向從答案卷自動帶入）
  photoRules?: { studentUploadEnabled: boolean; pageCount: number; orientations: ('portrait' | 'landscape')[] } | null
  updatedAt?: number
}

/**
 * 答案卷模板（獨立於班級作業，可跨班共用）
 */
export interface AnswerKeyTemplate {
  id: string
  name: string
  domain?: string
  docType?: 'worksheet' | 'exam'
  answerSheetMode?: 'with_questions' | 'answer_only'
  folder?: string
  answerKey: AnswerKey
  questionCount?: number
  totalScore?: number
  shareCode?: string
  pageOrientations?: ('portrait' | 'landscape')[] // 每頁答案卷圖片的方向（建立時自動偵測）
  updatedAt?: number
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
  studentGuidance?: string
  // 批改時嵌入的 108 課綱概念標記（來自 assignment.conceptTags，批改當下凍結）
  conceptCode?: string
  conceptLabel?: string
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

  // 多頁合併：各頁面邊界的累積高度比例（不含最後一頁，空陣列=單頁）
  // 例：2 頁合併，頁1占 40% → pageBreaks = [0.4]
  pageBreaks?: number[]

  createdAt: number
  updatedAt?: number

  // AI 批改欄位
  score?: number
  aiScore?: number        // AI 批改的原始分數（唯讀，僅 AI 批改時寫入）
  scoreSource?: 'ai' | 'manual'  // 'manual' 表示老師手動覆蓋
  feedback?: string
  gradingResult?: GradingResult
  mistakesCount?: number  // 雲端同步的錯題數量（避免傳輸完整 gradingResult）
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

export interface GradebookCustomColumn {
  id: string
  classroomId: string
  name: string
  weightPercent: number
  sortOrder: number
  updatedAt?: number
}

export interface GradebookCustomScore {
  id: string // `${columnId}::${studentId}`
  classroomId: string
  columnId: string
  studentId: string
  score: number | null
  updatedAt?: number
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
  gradebookCustomColumns!: EntityTable<GradebookCustomColumn, 'id'>
  gradebookCustomScores!: EntityTable<GradebookCustomScore, 'id'>
  answerKeyTemplates!: EntityTable<AnswerKeyTemplate, 'id'>

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

    this.version(8).stores({
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

    this.version(9).stores({
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
      domainDiagnosisCache: '&cacheKey, domain, startDate, endDate, updatedAt',
      gradebookCustomColumns:
        '&id, classroomId, [classroomId+sortOrder], updatedAt',
      gradebookCustomScores:
        '&id, classroomId, columnId, studentId, [columnId+studentId], [classroomId+studentId], updatedAt'
    }).upgrade(async (trans) => {
      // Migration: localStorage 的舊版自訂欄位資料轉入 Dexie，避免跨裝置資料遺失
      try {
        const columnTable = trans.table('gradebookCustomColumns')
        const scoreTable = trans.table('gradebookCustomScores')

        const oldKeys: string[] = []
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i)
          if (key && key.startsWith('gradebook_custom_cols_')) {
            oldKeys.push(key)
          }
        }

        for (const key of oldKeys) {
          const classroomId = key.replace('gradebook_custom_cols_', '').trim()
          if (!classroomId) continue

          const raw = localStorage.getItem(key)
          if (!raw) continue

          let parsed: Array<{
            id?: unknown
            name?: unknown
            weight?: unknown
            scores?: Record<string, unknown>
          }> = []
          try {
            const json = JSON.parse(raw)
            if (Array.isArray(json)) {
              parsed = json as Array<{
                id?: unknown
                name?: unknown
                weight?: unknown
                scores?: Record<string, unknown>
              }>
            }
          } catch {
            parsed = []
          }

          if (parsed.length === 0) {
            localStorage.removeItem(key)
            continue
          }

          const now = Date.now()
          const columnRows: GradebookCustomColumn[] = []
          const scoreRows: GradebookCustomScore[] = []

          parsed.forEach((col, index) => {
            const baseId =
              typeof col.id === 'string' && col.id.trim()
                ? col.id.trim()
                : `${classroomId}-custom-${index}-${Math.random().toString(36).slice(2, 8)}`
            const name =
              typeof col.name === 'string' && col.name.trim()
                ? col.name.trim()
                : `自訂欄位${index + 1}`
            const parsedWeight =
              typeof col.weight === 'number' && Number.isFinite(col.weight)
                ? col.weight
                : typeof col.weight === 'string' && col.weight.trim()
                  ? Number(col.weight)
                  : 0
            const weightPercent = Number.isFinite(parsedWeight)
              ? Math.max(0, parsedWeight)
              : 0

            columnRows.push({
              id: baseId,
              classroomId,
              name,
              weightPercent,
              sortOrder: index,
              updatedAt: now
            })

            const scores = col.scores && typeof col.scores === 'object'
              ? col.scores
              : {}
            Object.entries(scores).forEach(([studentId, rawScore]) => {
              if (!studentId) return
              const score =
                rawScore === null || rawScore === undefined || rawScore === ''
                  ? null
                  : Number(rawScore)
              if (score !== null && !Number.isFinite(score)) return

              scoreRows.push({
                id: `${baseId}::${studentId}`,
                classroomId,
                columnId: baseId,
                studentId,
                score,
                updatedAt: now
              })
            })
          })

          if (columnRows.length > 0) {
            await columnTable.bulkPut(columnRows)
          }
          if (scoreRows.length > 0) {
            await scoreTable.bulkPut(scoreRows)
          }

          localStorage.removeItem(key)
        }
      } catch (error) {
        console.error('❌ 遷移成績統計自訂欄位失敗:', error)
      }
    })

    // version 10: add aiScore / scoreSource to submissions (index-free, plain fields)
    this.version(10).stores({
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
      domainDiagnosisCache: '&cacheKey, domain, startDate, endDate, updatedAt',
      gradebookCustomColumns:
        '&id, classroomId, [classroomId+sortOrder], updatedAt',
      gradebookCustomScores:
        '&id, classroomId, columnId, studentId, [columnId+studentId], [classroomId+studentId], updatedAt'
    })

    // version 11: add answerKeyTemplates table (independent answer key storage)
    this.version(11).stores({
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
      domainDiagnosisCache: '&cacheKey, domain, startDate, endDate, updatedAt',
      gradebookCustomColumns:
        '&id, classroomId, [classroomId+sortOrder], updatedAt',
      gradebookCustomScores:
        '&id, classroomId, columnId, studentId, [columnId+studentId], [classroomId+studentId], updatedAt',
      answerKeyTemplates: '&id, name, domain, folder, updatedAt'
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

    this.gradebookCustomColumns.hook('creating', (_, obj) => {
      applyUpdatedAtOnCreate(obj)
    })
    this.gradebookCustomColumns.hook('updating', (mods) => applyUpdatedAtOnUpdate(mods))

    this.gradebookCustomScores.hook('creating', (_, obj) => {
      applyUpdatedAtOnCreate(obj)
    })
    this.gradebookCustomScores.hook('updating', (mods) => applyUpdatedAtOnUpdate(mods))
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
 * 解析 assignment 的 answerKey：優先從 answerKeyTemplateId 讀取，fallback 到 inline answerKey
 */
export async function resolveAnswerKey(assignment: Assignment): Promise<AnswerKey | undefined> {
  // 優先用 templateId
  if (assignment.answerKeyTemplateId) {
    const template = await db.answerKeyTemplates.get(assignment.answerKeyTemplateId)
    if (template?.answerKey) return template.answerKey
  }
  // Fallback: inline answerKey（舊資料向後兼容）
  return assignment.answerKey
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

  // 如果都沒有，預設為 Type 2（最常見）
  return {
    ...question,
    type: 2
  } as AnswerKeyQuestion
}
