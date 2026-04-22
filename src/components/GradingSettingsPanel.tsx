import { NumericInput } from '@/components/NumericInput'

export interface GradingSettingsValues {
  strictness: 'strict' | 'standard' | 'lenient'
  scoringMode: 'scored' | 'unscored'
  fractionRule: 'require_simplified' | 'allow_equivalent'
  enPunctuationCheck: boolean
  enPunctuationDeduction: number
  enWordOrderCheck: boolean
  enWordOrderDeduction: number
}

interface GradingSettingsPanelProps {
  domain: string
  values: GradingSettingsValues
  onChange: (values: GradingSettingsValues) => void
  showTitle?: boolean
}

export default function GradingSettingsPanel({ domain, values, onChange, showTitle = true }: GradingSettingsPanelProps) {
  const update = <K extends keyof GradingSettingsValues>(key: K, value: GradingSettingsValues[K]) => {
    onChange({ ...values, [key]: value })
  }

  return (
    <div className="space-y-4">
      {showTitle && <h3 className="text-sm font-semibold text-gray-700">批改設定</h3>}

      {/* 嚴格度 */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">嚴格度</label>
        <select value={values.strictness} onChange={(e) => update('strictness', e.target.value as GradingSettingsValues['strictness'])}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-green-400 focus:outline-none">
          <option value="strict">嚴格</option>
          <option value="standard">標準</option>
          <option value="lenient">寬鬆</option>
        </select>
      </div>

      {/* 計分模式 */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">計分</label>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" checked={values.scoringMode === 'scored'} onChange={() => update('scoringMode', 'scored')} className="w-4 h-4 accent-green-600" />
            <span className="text-sm text-gray-700">計分</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" checked={values.scoringMode === 'unscored'} onChange={() => update('scoringMode', 'unscored')} className="w-4 h-4 accent-green-600" />
            <span className="text-sm text-gray-700">不計分</span>
          </label>
        </div>
      </div>

      {/* 數學專用：分數規則 */}
      {domain === '數學' && (
        <div>
          <label className="block text-xs text-gray-500 mb-1">分數規則</label>
          <select value={values.fractionRule} onChange={(e) => update('fractionRule', e.target.value as GradingSettingsValues['fractionRule'])}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-green-400 focus:outline-none">
            <option value="require_simplified">必須最簡分數</option>
            <option value="allow_equivalent">接受等值分數</option>
          </select>
        </div>
      )}

      {/* 英語專用：標點和詞序 */}
      {domain === '英語' && (
        <div className="space-y-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={values.enPunctuationCheck} onChange={(e) => update('enPunctuationCheck', e.target.checked)} className="w-4 h-4 accent-green-600" />
            <span className="text-sm text-gray-700">標點符號檢查</span>
            {values.enPunctuationCheck && (
              <span className="text-xs text-gray-500">
                每錯扣 <NumericInput min={1} max={5} value={values.enPunctuationDeduction} onChange={(v) => update('enPunctuationDeduction', typeof v === 'number' ? v : 1)}
                  className="inline-block w-12 px-1 py-0.5 border border-gray-300 rounded text-center text-xs" /> 分
              </span>
            )}
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={values.enWordOrderCheck} onChange={(e) => update('enWordOrderCheck', e.target.checked)} className="w-4 h-4 accent-green-600" />
            <span className="text-sm text-gray-700">單字順序檢查</span>
            {values.enWordOrderCheck && (
              <span className="text-xs text-gray-500">
                每錯扣 <NumericInput min={1} max={5} value={values.enWordOrderDeduction} onChange={(v) => update('enWordOrderDeduction', typeof v === 'number' ? v : 1)}
                  className="inline-block w-12 px-1 py-0.5 border border-gray-300 rounded text-center text-xs" /> 分
              </span>
            )}
          </label>
        </div>
      )}
    </div>
  )
}
