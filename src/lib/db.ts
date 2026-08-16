import Dexie, { type EntityTable } from 'dexie'
import { debugLog } from './logger'

export interface RubricLevel {
  label: '優秀' | '良好' | '尚可' | '待努力'
  min: number
  max: number
  criteria: string
}

export interface Rubric {
  levels: RubricLevel[]
}

/**
 * 2026-08-13 級分制評分規準（數學應用題）。
 * 沙盒實測：要素寫成「可檢核的具體值」時一致率 95%、零放水；寫成「推導完整」這類模糊敘述會掉到 80%。
 *
 * 與 rubricsDimensions（逐維度加分）互斥、且哲學相反：
 *   級分制是**整題一個等第**——先判級分，再由 code 查 levels[].score 換成分數。
 *   不可改成逐要素加分，否則「答案湊對就拿分」的問題會原地復活。
 */
export interface LevelRubricItem {
  key: string   // E1 / E2…（AI 產生；只作內部對照，UI 一律顯示 desc）
  desc: string  // 必須是看得到就能勾的具體敘述（例：「出現 15000 ÷ 400 = 37.5」）
}

/** 等價的解題路徑：滿足其中一條即可，不必全中（例：用公式解 vs 一格一格列舉） */
export interface LevelRubricGroup {
  key: string
  desc: string
  options: LevelRubricItem[]
}

export interface LevelRubricLevel {
  level: 3 | 2 | 1 | 0
  criteria: string  // 該級分的判定條件（自然語言、給老師看；code 不讀這欄）
  score: number     // 該級分實得幾分——老師直接改數字，不是改百分比
}

/**
 * 級分判定規則（**給 code 執行**，與 criteria 的自然語言互為對照）。
 *
 * 沙盒實測（21 份會考樣卷 × 5 輪 × 三判官）：判官只回報「哪些要素有」、級分由 code 依本規則算，
 * 得到 21/21 準確、0 放水、級分 100% 不跳動。若改由 AI 自己判級分，同樣的要素會判出不同級分
 * （實測 q1_L1_s3「要素完全相同、級分在 2/1 之間跳」）——那正是跨學生不一致的來源。
 *
 * 由上而下（3→0）逐條比對，**第一條成立者即為該級分**；都不成立→0。
 */
export interface LevelRule {
  level: 3 | 2 | 1 | 0
  requireAll?: string[]       // 這些要素 key 必須全部呈現
  requireAny?: string[]       // 這些要素 key 至少呈現一個
  requireGroups?: string[]    // 這些替代組 key，每一組都要滿足其中一個選項
  requireAnyGroup?: string[]  // 這些替代組 key，至少有一組被滿足
}

export interface LevelRubric {
  requiredElements: LevelRubricItem[]
  alternativeGroups?: LevelRubricGroup[]
  /** 不因此降級的小毛病。AI 推不出來（它沒看過學生的卷），以老師補充為主 */
  toleratedFlaws?: string[]
  levels: LevelRubricLevel[]
  /** 給 code 執行的級分判定規則；缺這欄時無法由 code 算級分（見 LevelRule） */
  levelRules?: LevelRule[]
}

/**
 * @deprecated 已被 QuestionBucket 取代。
 * 此 type alias 僅保留供讀取極舊資料中的 question.type 欄位（read-only fallback）。
 * 1=唯一答案(精確), 2=多答案可接受(模糊), 3=依表現給分(評價)
 */
export type QuestionCategoryType = 1 | 2 | 3

/**
 * 題型分類大類（Bucket）— 用學生作答行為分類
 * - 'A' = 標準答案 + 精確比對（pick / fill / match 系列）
 * - 'B' = 標準答案 + 容多元（fill_variants / map_fill）
 * - 'C' = Rubric 給分（自由文字、計算、繪圖、塗色）
 * - 'D' = 複合題（標準答案 + Rubric 並存：圈選+說明、勾選+其他、判斷+改正）
 */
export type QuestionBucket = 'A' | 'B' | 'C' | 'D'

/**
 * 題型分類（老師視角，行為導向）
 * 每一個 type 對應一種「學生作答方式」：寫代號、圈選、打勾、填值、連線、繪圖...
 * type 是傳給 Read 的核心資訊；Read 看 type 就知道該找什麼視覺特徵。
 *
 * Bucket 分類見 QUESTION_CATEGORY_TO_BUCKET。
 */
export type QuestionCategory =
  // ── Bucket A：標準答案 + 精確比對 ──
  | 'single_choice'        // 選擇題：空括號 + 寫代號 1 個（A/甲/①）
  | 'multi_choice'         // 多選選擇題：空括號 + 寫多個代號（A,C）
  | 'circle_select_one'    // 圈選題：括號內預印選項（同意／不同意），圈 1 個
  | 'circle_select_many'   // 多選圈選題：括號內預印選項，圈多個
  | 'single_check'         // 勾選題：□ 打勾 1 個
  | 'multi_check'          // 多選勾選題：□ 打勾多個
  | 'table_check'          // 表格勾選題：矩陣表格每列在多欄（Yes/No、每天/有時/從不…）中勾一格，整表群組評分
  | 'true_false'           // 是非題：括號內手寫 ○ 或 ✗
  | 'fill_blank'           // 填空題：____ ／ □ 填 1 個值（單行底線/方框/括號，不含表格儲存格）
  | 'multi_fill'           // 多項填空題：多空格填多值（順序無關）
  | 'table_cell'           // 表格題（群組評分）：規則表格多 cell 共用 1 個整表 bbox，AI 一次讀整表回傳每 cell 值；分數依答對 cell 比例給分
  | 'matching'             // 連連看：1對1/1對多/多對多 連線
  | 'ordering'             // 排序題：在格內填序號 1-N
  | 'mark_in_text'         // 圈詞題：在文章中圈出特定詞語
  // ── Bucket B：標準答案 + 容多元 ──
  | 'fill_variants'        // 多元填空題：單一空格容多種說法
  | 'map_fill'             // 填圖題：地圖多位置-名稱配對
  // ── Bucket C：Rubric 給分 ──
  | 'short_answer'         // 簡答題：自由文字說明
  | 'calculation'          // 計算題：純算式（無答句）
  | 'word_problem'         // 應用題：算式 + 答句含單位
  | 'map_symbol'           // 地圖符號標記題：在地圖某位置畫符號（▲/★/●）
  | 'grid_geometry'        // 格線幾何繪製題：在格線紙上畫幾何圖形（三角形/平行四邊形）
  | 'connect_dots'         // 連點繪圖題：把指定點連起來形成圖形
  | 'diagram_draw'         // 圖表繪製題：繪製長條/圓餅圖
  | 'diagram_color'        // 塗色題：在預印圖形上塗色
  // ── Bucket D：複合題（多部分有依存關係，必須一起評分）──
  | 'compound_circle_with_explain'  // 圈選說明題：圈印刷選項 + 寫理由（理由要 match 圈選）
  | 'compound_check_with_explain'   // 勾選說明題：打勾 + 寫理由
  | 'compound_writein_with_explain' // 寫入說明題：寫代號 + 寫理由
  | 'multi_check_other'             // 複選含其他題：勾多個 + 開放「其他」欄位
  | 'compound_judge_with_correction' // 判斷改正題：對的打 ○ / 錯的打 ✗ + 改正錯的部分
  | 'compound_judge_with_explain'   // 判斷說明題：對/不對 + 解釋為什麼（理由 must match 判斷）
  | 'compound_chain_table'          // 表格連動題：多 cell 表格，cell 之間有 chain 依存（人物→事件→影響）

/**
 * 25 個 type 對應 Bucket。Single source of truth — 前端與後端皆從此 import。
 */
export const QUESTION_CATEGORY_TO_BUCKET: Record<QuestionCategory, QuestionBucket> = {
  // Bucket A — 標準答案 + 精確比對
  single_choice: 'A',
  multi_choice: 'A',
  circle_select_one: 'A',
  circle_select_many: 'A',
  single_check: 'A',
  multi_check: 'A',
  table_check: 'A',
  true_false: 'A',
  fill_blank: 'A',
  multi_fill: 'A',
  table_cell: 'A',

  matching: 'A',
  ordering: 'A',
  mark_in_text: 'A',
  calculation: 'A',     // 數學計算題：只看最終答案，過程交給 Accessor 自行判斷
  word_problem: 'A',    // 數學應用題：只看最終答案（含單位），過程交給 Accessor 自行判斷
  // Bucket B
  fill_variants: 'B',
  map_fill: 'B',
  // Bucket C — Rubric（純文字評鑑或繪圖評鑑）
  short_answer: 'C',
  map_symbol: 'C',
  grid_geometry: 'C',
  connect_dots: 'C',
  diagram_draw: 'C',
  diagram_color: 'C',
  // Bucket D
  compound_circle_with_explain: 'D',
  compound_check_with_explain: 'D',
  compound_writein_with_explain: 'D',
  multi_check_other: 'D',
  compound_judge_with_correction: 'D',
  compound_judge_with_explain: 'D',
  compound_chain_table: 'D',
}

/**
 * 26 個 type 中文顯示名（給前端 UI 用）。
 * Single source of truth — 前端 modal/page 從此 import，避免重複定義。
 */
export const QUESTION_CATEGORY_LABELS: Record<QuestionCategory, string> = {
  // Bucket A
  single_choice: '選擇題',
  multi_choice: '多選選擇題',
  circle_select_one: '圈選題',
  circle_select_many: '多選圈選題',
  single_check: '勾選題',
  multi_check: '多選勾選題',
  table_check: '表格勾選題',
  true_false: '是非題',
  fill_blank: '填空題',
  multi_fill: '多項填空題',
  table_cell: '表格題',
  matching: '連連看',
  ordering: '排序題',
  mark_in_text: '圈詞題',
  // Bucket B
  fill_variants: '多元填空題',
  map_fill: '填圖題',
  // Bucket C
  short_answer: '簡答題',
  calculation: '計算題',
  word_problem: '應用題',
  map_symbol: '地圖符號標記題',
  grid_geometry: '格線幾何繪製題',
  connect_dots: '連點繪圖題',
  diagram_draw: '圖表繪製題',
  diagram_color: '塗色題',
  // Bucket D
  compound_circle_with_explain: '圈選說明題',
  compound_check_with_explain: '勾選說明題',
  compound_writein_with_explain: '寫入說明題',
  multi_check_other: '複選含其他題',
  compound_judge_with_correction: '判斷改正題',
  compound_judge_with_explain: '判斷說明題',
  compound_chain_table: '表格連動題',
}

/**
 * 從題目取得 bucket：優先用 question.bucket，否則從 questionCategory 推導。
 * 整個系統應使用此 helper 取代直接讀 question.type。
 */
export function getBucket(question: Pick<AnswerKeyQuestion, 'questionCategory' | 'bucket'>): QuestionBucket {
  if (question.bucket) return question.bucket
  if (question.questionCategory) return QUESTION_CATEGORY_TO_BUCKET[question.questionCategory]
  return 'A' // 預設 fallback
}

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
  // AI 把題目歸為 unordered 時設為 true，提醒老師複核群組設定
  // 老師確認後可手動清除（前端 UI 用黃色提醒）
  orderModeUncertain?: boolean

  // 題型分類（老師視角，行為導向）：直接描述題型，批改規則從此推導
  // 25 種 type 對應「學生作答方式」（寫代號、圈選、打勾、填值、連線...）
  // 寫入新資料時必填；舊資料可能無此欄位，會 fallback 到 type
  questionCategory?: QuestionCategory

  // 題型分類大類（A/B/C/D）— 從 questionCategory 自動推導
  // A=精確比對, B=容多元, C=Rubric, D=複合題
  // 整個系統應透過 getBucket() helper 讀取，而非直接讀 type
  bucket?: QuestionBucket

  /**
   * @deprecated 改用 bucket 欄位（'A'|'B'|'C'|'D'）
   * 舊內部分類 1=精確、2=多元、3=評價。
   * 此欄位**僅供讀取舊資料**——新寫入請只設定 questionCategory（bucket 自動推導）。
   */
  type?: QuestionCategoryType

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

  // 2026-08-13 數學應用題級分制。由系統依領域＋題型自動決定，**不開放老師切換判分方式**。
  // 有 levelRubric 時，該題走級分制判官，忽略 rubricsDimensions。
  levelRubric?: LevelRubric

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

  // fill_blank 作答位置（由 answer_key.extract 標記，版面固定屬性）
  // 'front'=答案寫在題號左側獨立答案欄（如文意字彙）／'inline'=寫在句中空格
  // classify 階段據此決定：front 只框左欄、inline 框句中
  answerPos?: 'front' | 'inline'

  // 表格座標定位（由 answer_key.extract 產生）
  // 用於 classify 階段精準定位表格中的答案格，比 anchorHint 更可靠
  // ⚠️ legacy: 新 table_cell 群組批改 type 已不使用此欄位；保留供舊 fill_blank+tablePosition 既有資料
  tablePosition?: {
    col: number      // 欄位序號（1-based，含標題欄，從最左邊開始）
    row: number      // 列序號（1-based，含標題列，從最上面開始）
    totalCols: number // 表格總欄數
    totalRows: number // 表格總列數
    colspan?: number  // 合併欄數（預設 1）
    rowspan?: number  // 合併列數（預設 1）
  }

  // table_cell 群組批改題型專用欄位（questionCategory='table_cell'）
  // 整張規則表格作為一題，answerBbox 框整表（不框單格），AI 一次讀整表回傳每 cell 值
  tableMeta?: {
    rowHeaders?: string[]  // 列標題（如 ["水果種類","人數(人)","百分率"]）
    colHeaders?: string[]  // 欄標題（如 ["", "蘋果","櫻桃","草莓","西瓜"]）
    totalRows: number      // 含 header 總列數
    totalCols: number      // 含 header 總欄數
  }
  cells?: Array<{
    row: number       // 1-based（含 header 列）
    col: number       // 1-based（含 header 欄）
    label?: string    // 此 cell 對應的 header label（給 AI/UI 顯示用，如「百分率·蘋果」）
    answer: string    // 此 cell 的標準答案
  }>

  // 2026-05-25: fill_blank 多空模式專用欄位（questionCategory='fill_blank' + 有 parts）
  // 同句多空 / 同表達式內多空（不跨等號）合成 1 題、parts 陣列依序記每空答案。
  // answerBbox 框整句、不是只框 tiny ( )。每 part 順序綁定、不可互換。
  // 結構參考 table_cell.cells、但少了 row/col、只有 subId 順序。
  parts?: Array<{
    subId: string     // "a" | "b" | "c" | ... 依空格由左到右、由上到下順序
    answer: string    // 此空的標準答案
    maxScore?: number // 此空配分（不填則平均 = maxScore / parts.length）
  }>

  // 2026-06-18: table_check（表格勾選題）專用欄位（questionCategory='table_check'）
  // 矩陣勾選表：每列在 checkColumns（如 ["Yes","No"]）中勾一欄。grading 入口正規化成 table_cell
  // （每列→1 cell、answer=正確欄名）後重用 table_cell 機制。詳見 staged-grading normalizeTableCheckQuestion。
  checkColumns?: string[]   // 可勾選的欄標題（如 ["Yes","No"]；不含不計分欄如 Note）
  rows?: Array<{
    label: string           // 該列的列標題（如 "bedroom"）
    answer: string          // 該列正確被勾的欄標題（如 "Yes"）
  }>

  // 2026-05-28: map_fill 位置 spec（Direction Y）
  // AnswerKey extract 階段 Stage A 偵測印刷紅字標籤、每個輸出 (name, desc)。
  // Phase B 評分時用 desc 當位置 anchor、不揭露 name 給 AI、避免幻覺。
  // 詳見 server/ai/map-fill-grader.js 及 reference experiment 2026-05-28。
  positions?: Array<{
    name: string  // 該位置的標準地名（如「摩洛哥」）
    desc: string  // 該位置的方位描述（如「西北角、臨地中海」）
  }>

  // 2026-05-30: VJ 視覺判斷題（diagram_color / map_symbol / grid_geometry）的 rubric
  // A0 看答案卷 crop 產生：每個子元素一項 + 評判條件 + gradingDefinition（什麼算對，含等價合法位置）
  // 詳見 server/ai/visual-judgment-grader.js
  vjRubric?: {
    itemLabels: string[]       // 每個要作答的子元素（如「左上半圓柱體」）
    // 2026-08-16 逐項配分：分數＝Σ(判對項目的配分)。缺漏／長度不符 → 退回「滿分×通過項數÷項數」。
    //   規準寫「步驟1佔2分、步驟2佔1分」時，平均分配會讓兩種不同的錯誤拿到同一個分數。
    itemScores?: number[]
    condition?: string         // 學生每項該做什麼（一句話）
    gradingDefinition?: string // 什麼樣的作答算對（Phase B grade 判準）
  }
}

export interface AnswerKey {
  questions: AnswerKeyQuestion[]
  totalScore: number
  strictness?: 'strict' | 'standard' | 'lenient'
  // 2026-07-15 單位錯誤計分（作業層級、user 拍板）：zero=全有全無(預設)、half=給一半、deduct=扣固定分
  unitErrorRule?: 'zero' | 'half' | 'deduct'
  unitErrorDeduction?: number  // deduct 模式的扣分數（下限 0 分）
  // 2026-07-16 應用題過程分（user 拍板）：答案錯但過程正確到最後一步 → none=不給分(預設)/half/deduct
  processCreditRule?: 'none' | 'half' | 'deduct'
  processCreditDeduction?: number
  // 配分設定（老師選擇的配分方式，用於還原/重新套用）
  scoreMode?: 'ai_auto' | 'fixed_per_question' | 'fixed_total' | 'fixed_both'
  fixedPerScore?: number  // 每題固定分（scoreMode=fixed_per_question 或 fixed_both 時）
  fixedTotal?: number     // 固定總分（scoreMode=fixed_total 或 fixed_both 時）
  // 2026-08-15 多選題計分（作業層級、user 拍板）：把「部分給分」從 AI 自行加碼改成正式設定。
  //   deduct=每錯一個扣「一個選項的配分」(滿分÷正解數；預設；漏選與誤選同權、下限 0；
  //          指定 multiCheckDeduction 則改扣該固定分數)、
  //   all_or_nothing=全對才給分、partial=滿分×選對數/正解數(誤選不倒扣)、
  //   partial_strict=選到非正解即 0
  multiCheckRule?: 'deduct' | 'all_or_nothing' | 'partial' | 'partial_strict'
  multiCheckDeduction?: number
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
  school_id?: string // 1Campus 同步班級所屬學校（dsns）；用於多校分資料夾與同步班級保護
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
  boundAnswerKeyVersion?: number // 綁定時的答案卷版本號（用於偵測答案卷是否已更新）
  conceptTags?: Record<string, { code: string; label: string }> // 108課綱概念標記（questionId → concept）
  // Supabase Storage 路徑，answer-sheets/{id}/page-{i}.webp（各頁壓縮圖，用於 wizard 預覽）
  answerSheetImagePaths?: string[]
  // 題本圖 Supabase Storage 路徑，question-booklets/{id}/page-{i}.webp（純答案卷模式下，老師上傳的題本）
  questionBookletImagePaths?: string[]
  // 是否開放學生上傳作業
  studentUploadEnabled?: boolean
  // 是否開放學生自助 AI 批改（預設關閉，老師主動打開才生效）
  allowStudentAiGrading?: boolean
  // 每位學生可自助批改次數上限（1~10，預設 1）
  studentAiGradingLimit?: number
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
  // 2026-07-31 學校歸屬:行政端建立/匯入的答案卷標記所屬學校——行政端只顯示有標記的、
  // 教師端只顯示沒標記的(兩邊不混)
  schoolId?: string
  answerKey: AnswerKey
  questionCount?: number
  totalScore?: number
  shareCode?: string
  pageOrientations?: ('portrait' | 'landscape')[] // 每頁答案卷圖片的方向（建立時自動偵測）
  // 原始答案卷整頁圖 Supabase Storage 路徑：homework-images/template-answer-sheets/{id}/page-{i}.webp
  // 用於再次開啟編輯器時還原預覽（bbox 標記、題目對應）
  answerSheetImagePaths?: string[]
  questionBookletImagePaths?: string[] // 題本圖 Supabase Storage 路徑（純答案卷模式）
  version?: number // 答案卷版本號（每次編輯內容時 +1）
  updatedAt?: number
}

export type SubmissionStatus = 'missing' | 'scanned' | 'synced' | 'graded' | 'grading_failed'

/**
 * 2026-05-17: Phase A 完成後的可序列化狀態（client 側 IndexedDB / sync from Supabase）
 * 對應 server-side `submissions.phase_a_state` jsonb
 */
export interface PhaseAStateCached {
  version?: number
  pipelineRunId?: string
  stagedLogLevel?: string
  model?: string
  answerKey?: unknown
  questionIds?: string[]
  classifyResult?: unknown
  readAnswer1?: Array<{ questionId: string; status: string; answer: string }>
  readAnswer2?: Array<{ questionId: string; status: string; answer: string }>
  arbiterDecisions?: Array<{
    questionId: string
    arbiterStatus?: string
    finalAnswer?: string
    consistent?: boolean
  }>
  savedAt?: string
}

/**
 * 2026-05-17: 老師確認 / 補答後的最終答案（每題一筆）
 * 跟 lib/gemini.ts 的 FinalAnswer 介面相容（後者多 'ai_arbiter' / 'unrecognizable'）
 */
export interface FinalAnswerCached {
  questionId: string
  finalStudentAnswer: string
  finalAnswerSource?: 'ai_read1' | 'ai_read2' | 'manual' | 'arbiter' | 'ai_arbiter' | 'unrecognizable' | 'blank'
}

/**
 * 每題批改細節
 */
export interface GradingDetail {
  questionId: string
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
  // 2026-07-13 系統信心指數（server 查表、內部用不對外顯示數字）：<70 的題在詳情紅底＋卡片掛「低信心」
  systemConfidence?: number
  confidenceJourney?: string
  // 2026-07-13 老師接管編輯（user 拍板）：老師改答案/分數不再觸發重批、理由換「已經由老師編輯」；
  //   首次編輯時快照 AI 原判於此、題號旁回復鈕可一鍵還原（回到 AI 原判、非上一步）
  _aiOriginal?: {
    studentAnswer?: string
    score?: number
    maxScore?: number
    isCorrect?: boolean
    reason?: string
    comment?: string
    systemConfidence?: number
  }
  answerCropImageUrl?: string
  mistakeTypeCodes?: string[]
  studentGuidance?: string

  // table_cell 群組批改題型專用：每 cell 對錯細節
  // 整題 score = (correctCount / cells.length) * maxScore
  cellResults?: Array<{
    row: number
    col: number
    label?: string         // 對應 header label（顯示用）
    student: string        // AI 從整表 crop 讀到的學生答案
    expected: string       // 標準答案
    correct: boolean       // 是否正確
    reason?: string        // 答錯原因（單位錯、數值錯等）
  }>
  // fill_blank 合題題型專用：每空對錯細節（題目含 parts 陣列）
  // 整題 score = sum(對的 parts 的 maxScore)
  partResults?: Array<{
    subId: string          // 對應 answerKey.parts[i].subId（a, b, c, ...）
    student: string        // AI 從整段 crop 讀到的學生答案
    expected: string       // 標準答案
    correct: boolean       // 是否正確
    reason?: string        // 答錯原因（單位錯、數值錯等）
  }>
  // 2026-05-28: map_fill Direction Y 每位置對錯細節
  // 整題 score = correctCount (1 分/位置)，maxScore = positions.length
  mapFillResults?: Array<{
    idx: number          // 1-based position 編號
    position: string     // 該位置的標準地名（如「摩洛哥」）
    student: string      // AI 從學生圖讀到的內容（如「中國」或 ""）
    status: 'correct' | 'wrong' | 'blank' | 'unclear'
    desc?: string        // 該位置的方位描述
  }>
  // 2026-05-30: VJ 視覺判斷題逐項對錯細節（diagram_color / map_symbol / grid_geometry）
  vjItemResults?: Array<{
    idx: number          // 1-based 子元素編號
    label: string        // 子元素名（如「左上半圓柱體」）
    verdict: 'correct' | 'wrong' | 'blank' | 'pending'  // pending=老師切「有畫」、待重新批改
    reason: string       // 簡短理由（如「位置正確」「未作答」）
  }>
  // 2026-08-14 級分制（數學應用題）逐要素結果。
  // found 是判官投票後認定「有呈現」的要素 key；split 是三位判官意見不一致的要素。
  // ⭐ 這也是日後「同要素組合聚合」的鍵——應用題的 studentAnswer 只是「卷面作答」，
  //    拿它聚合會讓全班塌成同一桶；要分群必須用 found。
  levelResult?: {
    level: 0 | 1 | 2 | 3
    found: string[]
    split: string[]
    votes?: Array<{ judge: string; found: string[]; uncertain?: string }>
    // label＝批改時凍結的人類短標籤（評分統計拿不到答案卷，不能靠 key 反查）
    // waived＝替代組已由另一條滿足，這條不算「缺」
    evidence?: Array<{ key: string; label?: string; present?: boolean; waived?: boolean; evidence?: string; uncertain?: string }>
    unsure?: string[]
    missingAnswer?: string[]
  }
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
  // 老師手動點過「標記已複核」後設 true，讓 isSubmissionNeedsReview 直接 short-circuit 回 false，
  // 避免 details 中仍有 studentAnswer='未作答' 導致警告框繼續顯示
  manuallyReviewed?: boolean
  // 2026-07-13 系統信心指數（server 純查表計算=每題旅程歷史正確率的整卷平均、零 AI）：
  //   卡片左上角顯示、老師據此決定要不要點進去抽查。詳見 server buildFinalGradingResult。
  paperConfidence?: number
}

// Phase A pipeline 失敗：classify / read / arbiter 階段 retry 後仍 FAIL、整份未批改。
// 寫進 submissions.grading_result（不走 GradingResult shape — 沒有 score / mistakes / details）。
export interface PipelineFailureResult {
  pipelineFailure: {
    stage: 'classify' | 'read' | 'arbiter'
    reasonCode: string
    userMessage: string
    userAction: string
    technical?: { warnings?: string[]; metrics?: Record<string, unknown> }
  }
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

  // 2026-05-17: Phase A / Phase B 分離設計（PR1 後端、PR2 前端）
  // phaseAState: Phase A 完成的可序列化狀態（answerKey / questionIds / classifyResult / read1 / read2 / arbiterDecisions）
  // finalAnswers: 老師確認/補答後的最終答案（Phase B 用這個算分）
  // 兩者都從 submissions table 同步進來、用於卡片狀態計算（待複核 / 待批改）跟「重新批改」(fromCache) 觸發
  phaseAState?: PhaseAStateCached
  finalAnswers?: FinalAnswerCached[]

  // 2026-08-03 sync 瘦身:上面三個大 JSONB 已改成 on-demand(見 lib/submission-details.ts),
  //   sync 只帶下面這幾個輕量替代值,卡片狀態/計數不必為此下載 40KB。
  /** server generated column:grading_result is not null(取代「有沒有批改結果」的存在檢查) */
  hasGradingResult?: boolean
  /** server generated column:phase_a_state->>'savedAt'(isPhaseAStale 只需要這個) */
  phaseASavedAt?: string
  /** 本機補齊大 JSONB 的時間戳;小於 updatedAt 代表快取過期要重抓 */
  detailsFetchedAt?: number
  /**
   * 2026-08-03 清除墓碑:server 每次清批改會蓋一個時間戳。
   *   sync 合併是 local-first,server 送 null 會被本機舊值接住 → 清除傳不過裝置。
   *   比對「server 的清除時間 > 本機已知的」就把本機批改一起清掉。
   */
  gradingClearedAt?: number

  // 訂正管理：教師手動紀錄訂正次數
  correctionCount?: number
  source?: string
  round?: number
  parentSubmissionId?: string
  actorUserId?: string
  // 2026-06-02 學生自助批改：'student'=學生自批、'teacher'=老師批（null 視為 teacher）；供老師端「學生自批」徽章
  gradedBy?: 'student' | 'teacher'
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

// 2026-07-16 開放題錯誤特徵 AI 歸納快取（跑過一次、之後隨開隨看；資料變更以 signature 判斷可重新分析）
export interface QuestionErrorFeaturesCache {
  cacheKey: string        // `${assignmentId}::${questionId}`
  assignmentId: string
  questionId: string
  signature: string       // `${n}:${correct}:${wrong}`
  payload: {
    features: Array<{ feature: string; count: number; examples: string[]; note: string }>
    nonsense: string[]
    teachingFocus: string
  }
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
  questionErrorFeaturesCache!: EntityTable<QuestionErrorFeaturesCache, 'cacheKey'>
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

    // version 12: add version tracking for answer key templates
    this.version(12).stores({
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
    }).upgrade(async tx => {
      // 所有既有模板設定 version = 1
      await tx.table('answerKeyTemplates').toCollection().modify(t => {
        if (!t.version) t.version = 1
      })
      // 所有既有作業設定 boundAnswerKeyVersion = 1（有 templateId 的）
      await tx.table('assignments').toCollection().modify(a => {
        if (a.answerKeyTemplateId && !a.boundAnswerKeyVersion) {
          a.boundAnswerKeyVersion = 1
        }
      })
    })

    // version 13: 開放題錯誤特徵 AI 歸納快取（2026-07-16）
    this.version(13).stores({
      questionErrorFeaturesCache: '&cacheKey, assignmentId, updatedAt'
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
 * 檢查作業的答案卷版本狀態：
 * - 'normal': 答案卷正常（或無 templateId 的舊資料）
 * - 'updated': 答案卷已更新（版本不同）
 * - 'deleted': 答案卷已被刪除
 */
export type AnswerKeyVersionStatus = 'normal' | 'updated' | 'deleted'

export async function getAnswerKeyVersionStatus(assignment: Assignment): Promise<AnswerKeyVersionStatus> {
  if (!assignment.answerKeyTemplateId) return 'normal'
  const template = await db.answerKeyTemplates.get(assignment.answerKeyTemplateId)
  if (!template) return 'deleted'
  if (
    typeof assignment.boundAnswerKeyVersion === 'number' &&
    typeof template.version === 'number' &&
    template.version > assignment.boundAnswerKeyVersion
  ) {
    return 'updated'
  }
  return 'normal'
}

