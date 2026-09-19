// 2026-09-19 自備作文卷的「稿紙設定」步驟。
//   ⭐ 不需要老師框每一行、也不需要上傳空白卷：批改時直接在學生卷上偵測印刷格線（純 code）。
//      依據：同一套偵測在 114／115 共 102 張真實會考樣卷上 100% 抓對 23 行。
//   老師只要告訴我們「幾行、每行幾格、每生幾頁」，用來核對偵測結果、決定每生要收幾頁。
import { NumericInput } from '@/components/NumericInput'
import type { EssayByoGeom } from '@/lib/db'

interface Props {
  value: EssayByoGeom
  onChange: (next: EssayByoGeom) => void
  readOnly?: boolean
}

const PRESETS: Array<{ label: string; cols: number; rows: number; pages: number; hint: string }> = [
  { label: '會考寫作測驗答案卷', cols: 23, rows: 22, pages: 2, hint: 'B4 橫式、每面 23 行 × 22 格、正反兩頁' },
  { label: '一般 300 字稿紙', cols: 15, rows: 20, pages: 1, hint: '每面 15 行 × 20 格' },
  { label: '一般 400 字稿紙', cols: 20, rows: 20, pages: 1, hint: '每面 20 行 × 20 格' },
]

export default function EssayByoSheetStep({ value, onChange, readOnly = false }: Props) {
  const set = <K extends keyof EssayByoGeom>(k: K, v: EssayByoGeom[K]) => onChange({ ...value, [k]: v })
  const matched = PRESETS.find((p) => p.cols === value.cols && p.rows === value.rows && p.pages === value.pages)

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="max-w-3xl space-y-5">
        <div className="px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 leading-relaxed">
          批改時系統會<b>直接在學生的卷面上找出印刷格線</b>，所以你不必上傳空白稿紙、也不必框選每一行。
          這裡只要告訴我們稿紙的規格，用來核對抓到的行數對不對、以及每位學生要收幾頁。
        </div>

        <section>
          <div className="text-sm font-semibold text-gray-800 mb-2">常見稿紙</div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {PRESETS.map((p) => {
              const active = matched?.label === p.label
              return (
                <button
                  key={p.label}
                  type="button"
                  disabled={readOnly}
                  onClick={() => onChange({ ...value, cols: p.cols, rows: p.rows, pages: p.pages })}
                  className={`text-left rounded-lg border-2 p-3 transition-colors ${
                    active ? 'border-green-500 bg-green-50/50' : 'border-gray-200 bg-white hover:border-green-300'
                  } ${readOnly ? 'opacity-60 cursor-not-allowed' : ''}`}
                >
                  <div className="text-sm font-semibold text-gray-900">{p.label}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{p.hint}</div>
                </button>
              )
            })}
          </div>
        </section>

        <section className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-semibold text-gray-800 mb-1">每面幾行</label>
            <NumericInput value={value.cols} min={5} max={40} disabled={readOnly} onChange={(n) => set('cols', Number(n) || value.cols)} />
            <p className="mt-1 text-xs text-gray-500">直書的「行」，由右至左數</p>
          </div>
          <div>
            <label className="block text-sm font-semibold text-gray-800 mb-1">每行幾格</label>
            <NumericInput value={value.rows} min={5} max={40} disabled={readOnly} onChange={(n) => set('rows', Number(n) || value.rows)} />
            <p className="mt-1 text-xs text-gray-500">一格一字，用來核對抄本字數</p>
          </div>
          <div>
            <label className="block text-sm font-semibold text-gray-800 mb-1">每位學生幾頁</label>
            <NumericInput value={value.pages} min={1} max={4} disabled={readOnly} onChange={(n) => set('pages', Number(n) || value.pages)} />
            <p className="mt-1 text-xs text-gray-500">一張紙雙面＝2 頁；匯入時每位學生要收滿這個頁數</p>
          </div>
        </section>

        <section className="rounded-lg border border-gray-200 bg-gray-50 p-3">
          <div className="text-sm font-semibold text-gray-800 mb-1">評分規準：會考寫作測驗六級分（內建）</div>
          <p className="text-xs text-gray-600">滿分 6 分＝六級分。AI 會給逐句修改建議與建議級分，最後成績由你確認。</p>
        </section>

        <section className="rounded-lg border border-blue-200 bg-blue-50/50 p-3 text-xs text-blue-900 leading-relaxed">
          <b>自備稿紙要注意</b>
          <ul className="list-disc pl-5 mt-1 space-y-1">
            <li>稿紙的<b>格線要印得清楚</b>（紅色或粉紅色最穩）。掃描太淡或影印太多次，系統可能找不到格線。</li>
            <li>沒有座號劃卡欄 → 匯入時走<b>照順序</b>，請先把卷子按座號排好。</li>
            <li>掃描請<b>整張掃進去、不要裁切到格線</b>。</li>
          </ul>
        </section>
      </div>
    </div>
  )
}
