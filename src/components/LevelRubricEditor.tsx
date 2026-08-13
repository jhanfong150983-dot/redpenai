/**
 * 級分制（數學應用題）評分規準編輯器。AnswerKeyUnifiedModal 與 AnswerKeyWizardModal 共用。
 *
 * UI 原則：
 *  - **不提供判分方式切換**——判分方式由題型決定，老師只確認內容（沿用既有「題型唯讀」做法）。
 *  - 不外露 E1/E2/E3 代號，老師看到的是白話敘述。
 *  - 老師改的是「每級幾分」四個數字，不是百分比。
 *  - 替代解法唯讀：改壞了會讓「另一種正確解法」被判不及格。
 *  - 容許瑕疵可自由增刪——沙盒證明這塊 AI 補不上（它沒看過學生實際作答）。
 */
import { X } from 'lucide-react'
import { NumericInput } from '@/components/NumericInput'
import type { LevelRubric } from '@/lib/db'
import { LEVEL_LABELS } from '@/lib/levelRubric'

interface Props {
  rubric: LevelRubric
  /** 未配分模式不顯示分數欄 */
  showScores: boolean
  onChange: (next: LevelRubric) => void
}

export default function LevelRubricEditor({ rubric, showScores, onChange }: Props) {
  const flaws = rubric.toleratedFlaws ?? []
  const groups = rubric.alternativeGroups ?? []

  return (
    <div className="space-y-3">
      <div className="text-[11px] text-gray-500 bg-blue-50 border border-blue-200 rounded px-2 py-1.5">
        這題會看<b>整份解題過程</b>給一個等第，不是逐項加分。只寫出答案、沒有過程，拿不到最高等第。
      </div>

      {showScores && (
        <div>
          <span className="text-gray-500 text-xs">各等第得分（可直接改）</span>
          <div className="mt-1 space-y-1">
            {rubric.levels.map((lv) => (
              <div key={lv.level} className="flex items-start gap-2">
                <span className="w-14 shrink-0 text-xs text-gray-600 mt-1.5">{LEVEL_LABELS[lv.level]}</span>
                <NumericInput
                  className="w-16 px-2 py-1 border border-gray-300 rounded text-right text-xs"
                  value={lv.score}
                  allowDecimal
                  onChange={(v) =>
                    onChange({
                      ...rubric,
                      levels: rubric.levels.map((l) =>
                        l.level === lv.level ? { ...l, score: Number(v) || 0 } : l,
                      ),
                    })
                  }
                />
                <span className="flex-1 text-[11px] text-gray-500 mt-1.5 leading-snug">
                  {lv.criteria || '（無說明）'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <span className="text-gray-500 text-xs">
          必須寫到的重點（{rubric.requiredElements.length} 項，全部做到才是最高等第）
        </span>
        <div className="mt-1 space-y-1">
          {rubric.requiredElements.map((el, eIdx) => (
            <div key={el.key} className="flex items-start gap-2">
              <span className="text-[11px] text-gray-400 mt-1.5 shrink-0">{eIdx + 1}.</span>
              <textarea
                rows={2}
                className="flex-1 px-2 py-1 border border-gray-300 rounded text-xs"
                value={el.desc}
                onChange={(e) =>
                  onChange({
                    ...rubric,
                    requiredElements: rubric.requiredElements.map((x, j) =>
                      j === eIdx ? { ...x, desc: e.target.value } : x,
                    ),
                  })
                }
              />
            </div>
          ))}
        </div>
      </div>

      {groups.length > 0 && (
        <div>
          <span className="text-gray-500 text-xs">可接受的不同解法（學生用其中一種即可）</span>
          {groups.map((g) => (
            <div key={g.key} className="mt-1 p-2 bg-gray-50 rounded border border-gray-200 space-y-1">
              {g.options.map((o, oi) => (
                <div key={o.key} className="text-[11px] text-gray-600 leading-snug">
                  <span className="text-gray-400">解法 {oi + 1}：</span>
                  {o.desc}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-gray-500 text-xs">不扣分的小毛病</span>
          <button
            type="button"
            onClick={() => onChange({ ...rubric, toleratedFlaws: [...flaws, ''] })}
            className="text-xs px-2 py-0.5 rounded bg-blue-100 text-blue-700 hover:bg-blue-200"
          >
            + 新增
          </button>
        </div>
        {flaws.length === 0 && (
          <div className="text-[11px] text-gray-400 mb-1">
            例如：沒寫單位、算式沒化簡。學生常犯但你認為不該扣分的，寫在這裡。
          </div>
        )}
        {flaws.map((flaw, fIdx) => (
          <div key={fIdx} className="flex items-center gap-2 mb-1">
            <input
              className="flex-1 px-2 py-1 border border-gray-300 rounded text-xs"
              value={flaw}
              placeholder="例：沒寫單位不扣分"
              onChange={(e) =>
                onChange({
                  ...rubric,
                  toleratedFlaws: flaws.map((t, j) => (j === fIdx ? e.target.value : t)),
                })
              }
            />
            <button
              type="button"
              onClick={() => onChange({ ...rubric, toleratedFlaws: flaws.filter((_, j) => j !== fIdx) })}
              aria-label="移除此項"
              className="p-1 text-gray-400 hover:text-red-500"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
