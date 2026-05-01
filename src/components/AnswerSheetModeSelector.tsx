import { WithQuestionsIllustration, AnswerOnlyIllustration } from './illustrations/ModeIllustrations'

export type AnswerSheetMode = 'with_questions' | 'answer_only'

interface AnswerSheetModeSelectorProps {
  value: AnswerSheetMode
  onChange: (mode: AnswerSheetMode) => void
  disabled?: boolean
  /** 'cards' (default, 上下/左右並排兩張大卡) or 'compact' (單行 segmented). compact 留給空間吃緊的場合 */
  variant?: 'cards' | 'compact'
}

interface ModeOption {
  value: AnswerSheetMode
  name: string
  tagline: string
  description: string
  suit: string
  Illustration: typeof WithQuestionsIllustration
  accent: 'red' | 'blue'
}

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
    value: 'answer_only',
    name: '答案卷模式',
    tagline: '題目本和答題卡是兩張紙',
    description: '學生看題目本、在獨立的答題卡上劃記。題本和答題卡分開兩張紙。',
    suit: '適合：學測模考、有獨立答題卡的大考',
    Illustration: AnswerOnlyIllustration,
    accent: 'blue',
  },
]

export default function AnswerSheetModeSelector({
  value,
  onChange,
  disabled = false,
  variant = 'cards',
}: AnswerSheetModeSelectorProps) {
  if (variant === 'compact') {
    return (
      <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden">
        {MODES.map((mode, i) => {
          const isActive = value === mode.value
          return (
            <button
              key={mode.value}
              type="button"
              disabled={disabled}
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
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {MODES.map((mode) => {
          const isActive = value === mode.value
          return (
            <button
              key={mode.value}
              type="button"
              disabled={disabled}
              onClick={() => onChange(mode.value)}
              aria-pressed={isActive}
              className={`text-left rounded-xl p-4 transition-all flex flex-col ${
                isActive
                  ? 'border-2 border-green-500 bg-green-50/50 shadow-md'
                  : 'border-2 border-gray-200 bg-white hover:border-green-300 hover:-translate-y-0.5 hover:shadow-md'
              } ${disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
            >
              <div className="flex items-start justify-between mb-1">
                <div>
                  <div className="text-base font-semibold text-gray-900">{mode.name}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{mode.tagline}</div>
                </div>
                {isActive && (
                  <span className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-full bg-green-500 text-white text-xs font-bold">
                    ✓
                  </span>
                )}
              </div>

              <div className="bg-slate-50 rounded-lg p-2 my-2 flex items-center justify-center">
                <mode.Illustration className="w-full h-auto max-h-32" />
              </div>

              <p className="text-xs text-gray-600 leading-relaxed mb-2">{mode.description}</p>
              <div className={`text-[11px] px-2.5 py-1.5 rounded-md mt-auto ${
                mode.accent === 'red'
                  ? 'bg-rose-50 text-rose-700'
                  : 'bg-blue-50 text-blue-700'
              }`}>
                {mode.suit}
              </div>
            </button>
          )
        })}
      </div>
      <div className="mt-3 px-3 py-2 bg-blue-50 border-l-3 border-blue-400 rounded text-xs text-blue-800">
        💡 拿不定主意？看你發給學生的紙：<strong>1 張</strong>選一般模式、<strong>2 張</strong>選答案卷模式。
      </div>
    </div>
  )
}
