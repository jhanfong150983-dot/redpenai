// 2026-09-19 作文複核面板（批改詳情 modal 內、questionCategory='essay' 時取代學生答案文字框）。
//   老師在這裡做兩件事：①確認／排除疑似錯別字 ②刪掉不同意的眉批。
//   級分用既有的分數欄改（級分即分數、滿分 6）。
//   ⛔ 2026-09-20 移除「逐行確認抄本」：改抄本不會重跑眉批／級分（做了等於沒做），
//      學生檢討單印的也是原卷筆跡。抄本改為唯讀，只在落差比例 >40% 時提示可能掃描有問題。
//      真正要老師確認的錯別字走頂欄「低信心」modal（EssayTypoLowConfModal）。
//   ⛔ 錯別字一律是「疑似」：抄寫員抄錯會變成對學生的假指控（實驗2b），所以預設不當定論、由老師拍板。
import { useState } from 'react'
import { Check, ChevronDown, ChevronRight, Trash2, X } from 'lucide-react'
import type { EssayResult, EssayLoc } from '@/lib/db'
import { dismissedTypoForms, isSentenceTainted } from '@/lib/essayFeedbackFilter'
import { essayScaleOf, essayGradeHint } from '@/lib/essayScale'

interface Props {
  value: EssayResult
  onChange?: (next: EssayResult) => void
  readOnly?: boolean
}

const locText = (loc?: EssayLoc | null) =>
  loc ? `第 ${loc.page} 頁・第 ${loc.col}${loc.toCol && loc.toCol !== loc.col ? `–${loc.toCol}` : ''} 行` : '（對不到原文）'

const SEVERITY_CLASS: Record<string, string> = {
  偶有: 'bg-slate-100 text-slate-600',
  明顯: 'bg-amber-100 text-amber-700',
  嚴重: 'bg-rose-100 text-rose-700',
}

export default function EssayReviewPanel({ value, onChange, readOnly = false }: Props) {
  const [showTranscript, setShowTranscript] = useState(false)
  const fb = value.feedback
  // 老師判定「AI 抄錯」的字 → 引用到它的眉批整則不可信（原句學生沒寫過），不印給學生
  const dismissed = dismissedTypoForms(value)
  const lowCols = value.columns.filter((c) => c.lowConfidence)
  const writtenCols = value.columns.filter((c) => c.text).length
  const badRatio = writtenCols > 0 ? lowCols.length / writtenCols : 0
  const editable = !readOnly && !!onChange

  const dropSentence = (i: number) => {
    if (!onChange || !fb) return
    onChange({ ...value, feedback: { ...fb, sentenceFeedback: fb.sentenceFeedback.filter((_, k) => k !== i) } })
  }
  const dropTypo = (i: number) => {
    if (!onChange || !fb) return
    // ⛔ 不要真的刪掉：低信心是 AI 判定當下的事實、永遠保留（同一般卷的原則）。
    //   標 teacherVerdict='ok' → 檢討單不印、低信心清單仍看得到「老師判：正確無誤」。
    onChange({ ...value, feedback: { ...fb, typos: fb.typos.map((t, k) => (k === i ? { ...t, teacherVerdict: 'ok' as const } : t)) } })
  }

  return (
    <div className="space-y-3">
      {/* ── 概況 ── */}
      <div className="flex flex-wrap items-center gap-2 text-gray-700">
        <span className="shrink-0">學生作答：</span>
        <span className="font-medium text-gray-900">作文卷面</span>
        <span className="text-[10px] text-gray-400">{value.chars} 字・{value.paragraphs.length} 段</span>
        {value.level.suggested != null && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200">
            {essayScaleOf(value) === 'gsat'
              ? <>AI 建議 {value.level.suggested} 分／{value.level.maxScore ?? 25}（等第參考 {essayGradeHint(value) ?? '—'}；分數欄可改）</>
              : <>AI 建議 {value.level.suggested} 級分（分數欄可改）</>}
          </span>
        )}
        {/* 2026-09-20 user 拍板：抄寫落差**不再要老師確認**（改抄本不會重跑眉批／級分＝做了等於沒做；
            學生檢討單印的是原卷筆跡、抄錯不影響）。只有落差比例過高才提示「整份可能掃描有問題」。 */}
        {badRatio > 0.4 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 border border-rose-200"
            title="抄寫落差偏大，通常是掃描歪掉、拍糊或寫出格線；這種情況下眉批與級分都要打折看">
            抄寫落差偏大（{lowCols.length}/{writtenCols} 行）
          </span>
        )}
      </div>

      {value.gate && (
        <div className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">{value.gate}</div>
      )}

      {/* ⛔ 舊的「請確認這幾行的抄本」已移除（2026-09-20 user 拍板）。
          理由：①改抄本不會重跑眉批／級分 ②學生檢討單印原卷筆跡 ③實測 10 份卷每份都有低信心行、
          提示 100% 亮起等於雜訊。真正要老師確認的是「疑似錯別字」，走頂欄的低信心 modal。
          只有落差比例過高（>40%＝掃描歪掉／拍糊）才值得吵老師，提示改放在上方徽章。 */}
      {badRatio > 0.4 && (
        <div className="rounded border border-rose-200 bg-rose-50/60 px-2 py-1.5 text-[11px] text-rose-800 leading-relaxed">
          這份有 {lowCols.length}/{writtenCols} 行的字數與稿紙格數對不上，落差偏大。
          通常是掃描歪掉、拍糊或學生寫出格線——<b>建議先看一下原卷再採信級分與眉批</b>。
        </div>
      )}

      {/* ── 四向度診斷 ── */}
      {fb && fb.dimensionDiagnosis.length > 0 && (
        <section className="rounded border border-gray-200 bg-white p-2">
          <div className="font-semibold text-gray-800 mb-1">四向度診斷</div>
          <div className="space-y-1">
            {fb.dimensionDiagnosis.map((dg) => (
              <div key={dg.name} className="flex items-start gap-2">
                <span className="shrink-0 w-28 text-gray-600">{dg.name}</span>
                <div className="flex-1">
                  <div className="flex flex-wrap gap-1 mb-0.5">
                    {dg.terms.length === 0
                      ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700">無明顯問題</span>
                      : dg.terms.map((t, i) => (
                        <span key={i} className={`text-[10px] px-1.5 py-0.5 rounded ${SEVERITY_CLASS[t.severity] ?? 'bg-slate-100 text-slate-600'}`}>
                          {t.term}{t.severity ? `・${t.severity}` : ''}
                        </span>
                      ))}
                  </div>
                  <div className="text-gray-700 leading-snug">{dg.comment}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── 逐句眉批 ── */}
      {fb && fb.sentenceFeedback.length > 0 && (
        <section>
          <div className="font-semibold text-gray-800 mb-1">
            逐句修改建議（{fb.sentenceFeedback.filter((s) => !isSentenceTainted(s, dismissed)).length} 則）
            {dismissed.length > 0 && fb.sentenceFeedback.some((s) => isSentenceTainted(s, dismissed)) && (
              <span className="ml-2 text-[11px] font-normal text-gray-500">
                另有 {fb.sentenceFeedback.filter((s) => isSentenceTainted(s, dismissed)).length} 則引用了你判定為抄錯的字，已排除
              </span>
            )}
          </div>
          <div className="space-y-1.5">
            {fb.sentenceFeedback.map((s, i) => {
              const tainted = isSentenceTainted(s, dismissed)
              return (
              <div key={i} className={`rounded border-l-4 px-2 py-1.5 ${tainted ? 'border-gray-300 bg-gray-50 opacity-60' : 'border-amber-300 bg-amber-50/50'}`}>
                <div className="flex items-start justify-between gap-2">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500 text-white shrink-0">
                    {s.dimension}{s.rubricTerm ? `・${s.rubricTerm}` : ''}
                  </span>
                  <span className="text-[10px] text-gray-500 flex-1">{locText(s.loc)}</span>
                  {tainted && (
                    <span className="text-[10px] text-gray-600 shrink-0" title="這則引用了被你判定為「AI 抄錯」的字，原句學生沒寫過 → 不印到檢討單">
                      已排除（引用抄錯的字）
                    </span>
                  )}
                  {!tainted && !s.quoteVerified && (
                    <span className="text-[10px] text-rose-600 shrink-0" title="這句話在抄本裡找不到，可能是 AI 記錯">引用對不上</span>
                  )}
                  {editable && (
                    <button type="button" onClick={() => dropSentence(i)} className="shrink-0 p-0.5 rounded hover:bg-red-100" title="刪掉這一則">
                      <Trash2 className="w-3.5 h-3.5 text-red-500" />
                    </button>
                  )}
                </div>
                <div className="text-gray-600 mt-1">原句：{s.quote}</div>
                <div className="text-gray-800">問題：{s.problem}</div>
                <div className="text-emerald-800 font-medium">建議：{s.suggestion}</div>
                {s.why && <div className="text-[11px] text-gray-500">為什麼：{s.why}</div>}
              </div>
              )
            })}
          </div>
        </section>
      )}

      {/* ── 疑似錯別字 ── */}
      {fb && fb.typos.length > 0 && (
        <section className="rounded border border-gray-200 bg-white p-2">
          <div className="font-semibold text-gray-800 mb-0.5">疑似錯別字（{fb.typos.filter((t) => t.teacherVerdict !== 'ok').length}）</div>
          <p className="text-[11px] text-gray-500 mb-1.5">AI 抄寫時可能看錯，所以一律只當「疑似」。不是錯字請按 ✗，它會被劃掉、不出現在學生的檢討單（紀錄仍保留）。</p>
          <div className="flex flex-wrap gap-1.5">
            {fb.typos.map((t, i) => {
              const dropped = t.teacherVerdict === 'ok'
              return (
                <span key={i} className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 ${dropped ? 'border-gray-200 bg-gray-50 opacity-60' : 'border-rose-200 bg-rose-50'}`}>
                  <span className={`font-medium ${dropped ? 'text-gray-500 line-through' : 'text-rose-700'}`}>{t.wrong}</span>
                  <span className="text-gray-400">→</span>
                  <span className={dropped ? 'text-gray-500 line-through' : 'text-emerald-700'}>{t.correct}</span>
                  <span className="text-[10px] text-gray-500">{locText(t.loc)}</span>
                  {dropped
                    ? <span className="text-[10px] text-gray-500">老師判：正確無誤</span>
                    : editable && (
                      <button type="button" onClick={() => dropTypo(i)} className="p-0.5 rounded hover:bg-red-100" title="不是錯字">
                        <X className="w-3 h-3 text-red-500" />
                      </button>
                    )}
                </span>
              )
            })}
          </div>
        </section>
      )}

      {/* ── 段落建議 ── */}
      {fb && fb.paragraphFeedback.length > 0 && (
        <section>
          <div className="font-semibold text-gray-800 mb-1">段落與結構</div>
          <div className="space-y-1">
            {fb.paragraphFeedback.map((p, i) => (
              <div key={i} className="rounded border-l-4 border-blue-300 bg-blue-50/50 px-2 py-1.5 text-gray-700">
                第 {p.paragraph} 段：{p.comment}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── 寫得好的地方 ── */}
      {fb && fb.strengths.length > 0 && (
        <section>
          <div className="font-semibold text-gray-800 mb-1">寫得好的地方</div>
          <div className="space-y-1">
            {fb.strengths.map((s, i) => (
              <div key={i} className="rounded border-l-4 border-emerald-300 bg-emerald-50/50 px-2 py-1.5">
                <div className="text-gray-700">{s.quote}</div>
                <div className="text-[11px] text-emerald-800">{s.why}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {fb?.summary && (
        <div className="rounded border border-gray-200 bg-gray-50 px-2 py-1.5 text-gray-700">
          <b className="text-gray-800">總評：</b>{fb.summary}
        </div>
      )}

      {/* ── 全文抄本（收合） ── */}
      <section className="rounded border border-gray-200 bg-white">
        <button type="button" onClick={() => setShowTranscript((v) => !v)} className="w-full flex items-center gap-1 px-2 py-1.5 text-left font-semibold text-gray-700 hover:bg-gray-50">
          {showTranscript ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          全文抄本（{value.chars} 字）
        </button>
        {showTranscript && (
          <div className="px-2 pb-2 space-y-1.5">
            {value.paragraphs.map((p, i) => (
              <p key={i} className="text-gray-800 leading-relaxed" style={{ textIndent: '2em' }}>{p}</p>
            ))}
            <div className="pt-1 text-[11px] text-gray-400 flex items-center gap-1">
              <Check className="w-3 h-3" />
              抄本逐行對應原卷；上面的每一則建議都標了在第幾頁第幾行
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
