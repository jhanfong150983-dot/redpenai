import { WithQuestionsIllustration, AnswerOnlyIllustration, GeneratedSheetIllustration, EssayModeIllustration, EssayByoIllustration } from './illustrations/ModeIllustrations'
import type { SheetSource } from '@/lib/sheetSource'

/** 舊 2 值（DB 欄位 answer_sheet_mode）；選擇器本身改用三值 SheetSource，見 lib/sheetSource.ts */
export type AnswerSheetMode = 'with_questions' | 'answer_only'

interface AnswerSheetModeSelectorProps {
  value: SheetSource
  onChange: (mode: SheetSource) => void
  disabled?: boolean
  /** 'cards' (default, 並排大卡) or 'compact' (單行 segmented). compact 留給空間吃緊的場合 */
  variant?: 'cards' | 'compact'
  /** 只顯示這些模式（預設三個全顯示）；舊建卷路徑只給前兩個 */
  options?: SheetSource[]
}

interface ModeOption {
  value: SheetSource
  name: string
  tagline: string
  description: string
  suit: string
  Illustration: typeof WithQuestionsIllustration
  accent: 'red' | 'blue' | 'green' | 'amber' | 'violet' | 'sky' | 'teal'
  /** 建卷流程尚未實作 → 卡片顯示但不可選 */
  comingSoon?: boolean
}

// 2026-09-13 三模式（user 拍板、先不鎖 PRO）：
//   一般模式＝題目答案同一張紙；自備作答卷＝老師自己的題本＋作答卷、一起上傳一次解析；
//   系統製作作答卷＝上傳題本→系統排版作答卷（錨點＋座號劃卡）→列印→批改免定位。
const MODES: ModeOption[] = [
  {
    value: 'with_questions',
    name: '一般模式',
    tagline: '題目和答案在同一張紙',
    description: '學生在每題的題號旁直接寫上答案，題目和作答區是一張紙。',
    suit: '適合：學習單、隨堂測驗、附答案區的考卷',
    Illustration: WithQuestionsIllustration,
    accent: 'red',
  },
  {
    value: 'teacher_scan',
    name: '自備作答卷',
    tagline: '題本和作答卷是兩張紙，都自己準備',
    description: '同時上傳題本與寫好標準答案的作答卷，AI 一次解析後由你人工檢核。',
    suit: '適合：已有現成答題卡的段考、模考',
    Illustration: AnswerOnlyIllustration,
    accent: 'blue',
  },
  {
    value: 'generated',
    name: '系統製作作答卷',
    tagline: '只要題本，作答卷系統幫你排',
    description: '上傳題本，系統排好作答卷讓你列印；標準答案可直接打字，批改不必再定位作答區。',
    suit: '適合：想省定位費、要座號自動辨識的考試',
    Illustration: GeneratedSheetIllustration,
    accent: 'green',
  },
  // 2026-09-19 作文兩張卡（user 拍板：模式全部攤在第一層，不要藏在子選項裡）。
  //   呼叫端用 options 控制顯示；領域對照表在 lib/sheetSource.ts 的 SHEET_SOURCE_DOMAINS（目前只在國語出現）。
  // ⛔ 2026-09-21 名稱一定要標「會考格式」：之後要加高中端的學測版稿紙（38 行×22 格、無窄欄），
  //   不標的話兩代稿紙在選單上分不出來。排序比照上面的作答卷——自備在前、系統製作在後。
  {
    value: 'essay_byo',
    name: '自備作文稿紙（限會考格式）',
    tagline: '一篇作文，用現成「會考」的稿紙',
    description: '上傳作文題目、填一下稿紙規格即可；批改時系統直接在學生卷上找出格線，不必上傳空白卷。',
    suit: '適合：學校已經印好稿紙、或想用會考答案卷',
    Illustration: EssayByoIllustration,
    accent: 'violet',
  },
  // 2026-09-21 學測格式（自備在前、系統製作在後；只在高中 1~3 ＋國語出現，見 sheetSource.ts 的 SHEET_SOURCE_MIN_GRADE）
  {
    value: 'essay_gsat_byo',
    name: '自備作文稿紙（限學測格式）',
    tagline: '國寫情意題，用現成「學測」的答題卷',
    description: '上傳國寫題目即可；學生寫在學測國寫公版答題卷上，批改時系統直接找出格線。第一期支援情意題（一篇作文、25 分），給逐句修改建議與建議分數。',
    suit: '適合：高中國寫練習、模擬考',
    Illustration: EssayByoIllustration,
    accent: 'sky',
  },
  {
    value: 'essay',
    name: '系統製作作文稿紙（會考格式）',
    tagline: '一篇作文，系統產生「會考」的稿紙',
    description: '上傳作文題目，系統製作比照會考的稿紙（含定位方塊與座號劃卡）；AI 逐句給修改建議與建議級分。',
    suit: '適合：作文練習、段考寫作測驗',
    Illustration: EssayModeIllustration,
    accent: 'amber',
  },
  {
    value: 'essay_gsat',
    name: '系統製作作文稿紙（學測格式）',
    tagline: '國寫情意題，系統產生「學測」的稿紙',
    description: '上傳國寫題目，系統製作比照學測的 A3 稿紙（每面 38 行 × 22 格，含定位方塊與座號劃卡）；正反兩面版面相同、不印題型；第一期支援情意題（一篇作文、25 分），給逐句修改建議與建議分數。',
    suit: '適合：高中國寫練習、要座號自動辨識的模擬考（需 A3 雙面列印）',
    Illustration: EssayModeIllustration,
    accent: 'teal',
  },
]

const SUIT_CLASS: Record<ModeOption['accent'], string> = {
  red: 'bg-rose-50 text-rose-700',
  blue: 'bg-blue-50 text-blue-700',
  green: 'bg-emerald-50 text-emerald-700',
  amber: 'bg-amber-50 text-amber-700',
  violet: 'bg-violet-50 text-violet-700',
  sky: 'bg-sky-50 text-sky-700',
  teal: 'bg-teal-50 text-teal-700',
}

export default function AnswerSheetModeSelector({
  value,
  onChange,
  disabled = false,
  variant = 'cards',
  options,
}: AnswerSheetModeSelectorProps) {
  // 作文模式只在呼叫端明確列進 options 時才顯示（預設三模式不變）
  const modes = options ? MODES.filter((m) => options.includes(m.value)) : MODES.filter((m) => !m.value.startsWith('essay'))
  if (variant === 'compact') {
    return (
      <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden">
        {modes.map((mode, i) => {
          const isActive = value === mode.value
          return (
            <button
              key={mode.value}
              type="button"
              disabled={disabled || mode.comingSoon}
              onClick={() => onChange(mode.value)}
              className={`px-5 py-2 text-sm font-medium transition-colors ${
                i > 0 ? 'border-l border-gray-300' : ''
              } ${
                isActive ? 'bg-green-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
              } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {mode.name}
            </button>
          )
        })}
      </div>
    )
  }

  return (
    <div>
      <div className={`grid grid-cols-1 gap-4 ${modes.length >= 4 ? 'sm:grid-cols-2 xl:grid-cols-3' : modes.length === 3 ? 'md:grid-cols-3' : 'md:grid-cols-2'}`}>
        {modes.map((mode) => {
          const isActive = value === mode.value
          return (
            <button
              key={mode.value}
              type="button"
              disabled={disabled || mode.comingSoon}
              onClick={() => onChange(mode.value)}
              aria-pressed={isActive}
              className={`text-left rounded-xl p-4 transition-all flex flex-col ${
                isActive
                  ? 'border-2 border-green-500 bg-green-50/50 shadow-md'
                  : 'border-2 border-gray-200 bg-white hover:border-green-300 hover:-translate-y-0.5 hover:shadow-md'
              } ${disabled || mode.comingSoon ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
            >
              <div className="flex items-start justify-between mb-1">
                <div>
                  <div className="text-base font-semibold text-gray-900">{mode.name}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{mode.tagline}</div>
                </div>
                {mode.comingSoon ? (
                  <span className="shrink-0 text-[10px] font-semibold text-slate-600 bg-slate-100 border border-slate-200 rounded-full px-2 py-0.5">準備中</span>
                ) : isActive && (
                  <span className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-full bg-green-500 text-white text-xs font-bold">
                    ✓
                  </span>
                )}
              </div>

              <div className="bg-slate-50 rounded-lg p-2 my-2 flex items-center justify-center">
                <mode.Illustration className="w-full h-auto max-h-32" />
              </div>

              <p className="text-xs text-gray-600 leading-relaxed mb-2">{mode.description}</p>
              <div className={`text-[11px] px-2.5 py-1.5 rounded-md mt-auto ${SUIT_CLASS[mode.accent]}`}>
                {mode.suit}
              </div>
            </button>
          )
        })}
      </div>
      <div className="mt-3 px-3 py-2 bg-blue-50 border-l-3 border-blue-400 rounded text-xs text-blue-800">
        💡 拿不定主意？看你發給學生的紙：<strong>1 張</strong>選一般模式；<strong>2 張</strong>且答題卡已有 → 自備作答卷；<strong>2 張</strong>但還沒做答題卡 → 系統製作作答卷。
      </div>
    </div>
  )
}
