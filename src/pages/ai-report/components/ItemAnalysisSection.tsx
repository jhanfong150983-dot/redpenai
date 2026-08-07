// 試題分析區（2026-07-16 第一波、user 拍板）：純程式即時渲染、零 AI 零點數。
// 摘要磚（樣本/平均難易/平均鑑別/信度α）＋逐題表（P/D/高低分組/對錯空/答案分布橫條/品質標記）。
// 視覺規範：正解＝語意綠＋文字標籤、其他樣態中性灰、未答淺灰；徽章一律帶文字、不靠顏色單獨傳達。
import { useMemo, useState } from 'react'
import { computeItemAnalysis, isImageAnswerItem } from '../item-analysis'
import type { ItemAnalysisQuestion, ItemAnalysisSubmissionLike, ItemStat } from '../item-analysis'
import QuestionErrorFeaturesModal from './QuestionErrorFeaturesModal'

type Props = {
  questions: ItemAnalysisQuestion[]
  submissions: ItemAnalysisSubmissionLike[]
  /** 有帶齊這三個才會出現「AI 歸納錯誤樣態」按鈕（開放文字題） */
  assignmentId?: string
  domain?: string
  templateId?: string
  requestInk?: (fn: () => void) => void
}

export const BAND_STYLE: Record<string, { bg: string; fg: string }> = {
  優良: { bg: '#dcfce7', fg: '#15803d' },
  良好: { bg: '#e0f2fe', fg: '#0369a1' },
  尚可: { bg: '#fef9c3', fg: '#a16207' },
  需檢視: { bg: '#fee2e2', fg: '#b91c1c' },
  '—': { bg: '#f1f5f9', fg: '#64748b' },
}

export const P_STYLE: Record<string, { bg: string; fg: string }> = {
  適中: { bg: '#f1f5f9', fg: '#475569' },
  偏易: { bg: '#f1f5f9', fg: '#64748b' },
  偏難: { bg: '#ffedd5', fg: '#c2410c' },
}

export function Badge({ text, palette }: { text: string; palette: { bg: string; fg: string } }) {
  return (
    <span style={{
      display: 'inline-block', padding: '1px 6px', borderRadius: 6,
      background: palette.bg, color: palette.fg, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap'
    }}>{text}</span>
  )
}

// 答案分布橫條：單一量值比例條——正解綠、其他灰、未答/無法辨識淺灰；文字標籤永遠並列。
// 2026-07-16 修（user 抓到湊不滿人數）：開放文字題（樣態幾乎人人不同）逐字樣態沒有統計意義、
//   前 6 個以外被截掉還漏掉未答段 → 改「答對/答錯/未答」聚合視角；樣態條保證含未答段＋「其他」尾巴。
export function DistributionBar({ item, onAiFeatures }: { item: ItemStat; onAiFeatures?: () => void }) {
  const total = item.n || 1
  const nonBlankVariants = item.distribution.filter((o) => !o.isBlank)
  const blankTotal = item.blankCount + item.unrecognizableCount
  // 開放文字題判定：非選擇類且樣態太碎（>6 種、或最多的樣態也只有 1-2 人）
  const isOpenText = !item.isChoiceLike
    && (nonBlankVariants.length > 6 || (nonBlankVariants[0]?.count ?? 0) <= 2)
  // 圖上作答題（計算作圖/繪圖）：答案畫在卷上、無文字樣態可統計 → 改對/錯/未答視角；
  //   AI 歸納錯誤樣態改送「答錯學生的作答圖」給 AI 看圖歸納（error-features 內處理）。
  const isImageAnswer = isImageAnswerItem(item)

  if (isOpenText || isImageAnswer) {
    const wrongCount = item.n - item.correctCount - blankTotal
    const segs = [
      { label: '答對', count: item.correctCount, color: '#16a34a' },
      { label: '答錯', count: Math.max(0, wrongCount), color: '#94a3b8' },
      { label: '未作答', count: blankTotal, color: '#e2e8f0' },
    ].filter((s) => s.count > 0)
    return (
      <div style={{ minWidth: 150 }}>
        <div style={{ display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden', background: '#f8fafc' }}>
          {segs.map((s) => (
            <div key={s.label} title={`${s.label}：${s.count} 人`}
              style={{ width: `${(s.count / total) * 100}%`, background: s.color, borderRight: '2px solid #fff' }} />
          ))}
        </div>
        <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
          {segs.map((s) => (
            <span key={s.label} style={{ marginRight: 8, whiteSpace: 'nowrap' }}>
              <span style={{ color: s.label === '答對' ? '#15803d' : '#64748b', fontWeight: s.label === '答對' ? 700 : 400 }}>{s.label}</span>
              ×{s.count}
            </span>
          ))}
        </div>
        {isImageAnswer && (
          <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>圖上作答，無文字樣態——可用下方 AI 看作答圖歸納</div>
        )}
        {/* 2026-07-16 user 二次拍板：取消系統性樣態列舉→改 AI 歸納 modal；2026-07-20 圖上作答改送作答圖 */}
        {onAiFeatures && (item.n - item.correctCount - blankTotal) >= 3 && (
          <button
            type="button"
            onClick={onAiFeatures}
            style={{ marginTop: 2, fontSize: 11, color: '#2563eb', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
          >
            🔎 AI 歸納錯誤樣態{isImageAnswer ? '（看作答圖）' : ''}
          </button>
        )}
      </div>
    )
  }

  // 樣態條：前 5 個非空樣態＋未答段（保證顯示）＋其他
  const topVariants = nonBlankVariants.slice(0, 5)
  const otherCount = item.n - topVariants.reduce((a, o) => a + o.count, 0) - blankTotal
  return (
    <div style={{ minWidth: 150 }}>
      <div style={{ display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden', background: '#f8fafc' }}>
        {topVariants.map((o) => (
          <div
            key={o.label}
            title={`${o.label}：${o.count} 人（高分組 ${o.highCount}、低分組 ${o.lowCount}）${o.isKey ? '＝正解' : ''}`}
            style={{
              width: `${(o.count / total) * 100}%`,
              background: o.isKey ? '#16a34a' : '#94a3b8',
              borderRight: '2px solid #fff',
            }}
          />
        ))}
        {otherCount > 0 && <div title={`其他樣態：${otherCount} 人`} style={{ width: `${(otherCount / total) * 100}%`, background: '#cbd5e1', borderRight: '2px solid #fff' }} />}
        {blankTotal > 0 && <div title={`未作答／無法辨識：${blankTotal} 人`} style={{ width: `${(blankTotal / total) * 100}%`, background: '#e2e8f0' }} />}
      </div>
      <div style={{ fontSize: 11, color: '#64748b', marginTop: 2, lineHeight: 1.5, wordBreak: 'break-all' }}>
        {topVariants.map((o) => (
          <span key={o.label} style={{ marginRight: 8, whiteSpace: 'nowrap' }}>
            <span style={{ color: o.isKey ? '#15803d' : '#64748b', fontWeight: o.isKey ? 700 : 400 }}>
              {o.isKey ? '✓' : ''}{o.label.length > 12 ? `${o.label.slice(0, 12)}…` : o.label}
            </span>
            ×{o.count}
          </span>
        ))}
        {otherCount > 0 && <span style={{ marginRight: 8, whiteSpace: 'nowrap' }}>其他×{otherCount}</span>}
        {blankTotal > 0 && <span style={{ whiteSpace: 'nowrap' }}>未答×{blankTotal}</span>}
      </div>
    </div>
  )
}

export default function ItemAnalysisSection({ questions, submissions, assignmentId, domain, templateId, requestInk }: Props) {
  const result = useMemo(() => computeItemAnalysis(questions, submissions, domain), [questions, submissions, domain])
  const [showAll, setShowAll] = useState(false)
  const [aiItem, setAiItem] = useState<ItemStat | null>(null)
  if (!result) return null
  const aiEnabled = Boolean(assignmentId && requestInk)

  const tiles: Array<{ label: string; value: string; hint?: string }> = [
    { label: '樣本數', value: `${result.n} 卷`, hint: `高低分組各 ${result.groupSize} 人（27%）` },
    { label: '平均難易度 P', value: result.meanP.toFixed(2), hint: '0.4~0.8 為適中' },
    { label: '平均鑑別度 D', value: result.meanD.toFixed(2), hint: '≥0.4 優良、<0.2 需檢視' },
    { label: '信度 α', value: result.alpha === null ? '—' : result.alpha.toFixed(2), hint: result.alpha !== null && result.alpha < 0.7 ? '偏低（<0.7）' : 'Cronbach’s α' },
  ]
  const bandOrder = ['優良', '良好', '尚可', '需檢視', '—']
  const rows = showAll ? result.items : result.items.slice(0, 60)

  return (
    <section className="card" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>試題分析</h3>
        <span style={{ fontSize: 12, color: '#64748b' }}>純統計、即時計算、不耗墨水</span>
        {result.lowSample && (
          <span style={{ fontSize: 12, color: '#a16207' }}>⚠ 樣本 &lt;12 卷、高低分組指標僅供參考</span>
        )}
      </div>

      {/* 摘要磚 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8, margin: '12px 0' }}>
        {tiles.map((t) => (
          <div key={t.label} style={{ background: '#f8fafc', borderRadius: 8, padding: '8px 12px' }}>
            <div style={{ fontSize: 11, color: '#64748b' }}>{t.label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#0f172a' }}>{t.value}</div>
            {t.hint && <div style={{ fontSize: 10, color: '#94a3b8' }}>{t.hint}</div>}
          </div>
        ))}
        <div style={{ background: '#f8fafc', borderRadius: 8, padding: '8px 12px' }}>
          <div style={{ fontSize: 11, color: '#64748b' }}>鑑別度分布</div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
            {bandOrder.filter((b) => result.dBandCounts[b]).map((b) => (
              <Badge key={b} text={`${b} ${result.dBandCounts[b]}題`} palette={BAND_STYLE[b]} />
            ))}
          </div>
        </div>
      </div>

      {/* 2026-08-07 卷面結構（純程式、零 AI；user 拍板：國小/國中/高中統一一版、不與會考或學測比對）：
          題型配分＝這張卷把分數放在哪些作答形式上；難度分布＝補上摘要磚只有鑑別度、沒有難易度的缺口。 */}
      {(result.formGroups.length > 0 || result.difficulty.length > 0) && (
        <div style={{ margin: '4px 0 16px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 18 }}>
          {result.formGroups.length > 0 && (() => {
            const total = result.formGroups.reduce((a, g) => a + g.maxScore, 0) || 1
            return (
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#334155', marginBottom: 6 }}>
                  題型配分<span style={{ fontWeight: 400, color: '#94a3b8', marginLeft: 6 }}>依配分計算</span>
                </div>
                <div style={{ display: 'flex', height: 22, borderRadius: 4, overflow: 'hidden' }}>
                  {result.formGroups.map((g) => {
                    const pct = Math.round((g.maxScore / total) * 100)
                    return (
                      <div key={g.key} title={`${g.label} ${g.questionCount} 題・${g.maxScore} 分`}
                        style={{ flex: g.maxScore, background: g.color, color: '#fff', fontSize: 10.5, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap' }}>
                        {pct >= 12 ? `${pct}%` : ''}
                      </div>
                    )
                  })}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 7, fontSize: 11, color: '#475569' }}>
                  {result.formGroups.map((g) => (
                    <span key={g.key} style={{ whiteSpace: 'nowrap' }}>
                      <i style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, background: g.color, marginRight: 5, verticalAlign: 'middle' }} />
                      {g.label} {g.questionCount} 題・{g.maxScore} 分
                    </span>
                  ))}
                </div>
              </div>
            )
          })()}

          {result.difficulty.length > 0 && (() => {
            const maxCount = Math.max(...result.difficulty.map((d) => d.questionCount), 1)
            const color: Record<string, string> = { 偏易: '#94a3b8', 適中: '#16a34a', 偏難: '#dc2626' }
            return (
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#334155', marginBottom: 6 }}>
                  難度分布<span style={{ fontWeight: 400, color: '#94a3b8', marginLeft: 6 }}>依難易度 P（&gt;0.8 偏易、&lt;0.4 偏難）</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {result.difficulty.map((d) => (
                    <div key={d.band} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ flex: '0 0 40px', fontSize: 11.5, color: '#334155' }}>{d.band}</span>
                      <span style={{ flex: 1, height: 13, background: '#f1f5f9', borderRadius: 3, overflow: 'hidden', minWidth: 40 }}>
                        <span style={{ display: 'block', width: `${Math.round((d.questionCount / maxCount) * 100)}%`, height: '100%', background: color[d.band] ?? '#94a3b8', borderRadius: 3 }} />
                      </span>
                      <span style={{ flex: '0 0 86px', textAlign: 'right', fontSize: 11, color: '#64748b', fontVariantNumeric: 'tabular-nums' }}>
                        {d.questionCount} 題・{d.maxScore} 分
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )
          })()}
        </div>
      )}

      {/* 2026-08-07 大題彙總（純程式、零 AI）：逐題表看得到「哪一題」，這裡看得到「哪一個大題整體弱」。
          標題取自答案卷 anchorHint；國語另標評量向度（縣市學生學習能力檢測十向度，判不出來不標）。 */}
      {result.sections.length > 1 && (
        <div style={{ margin: '4px 0 14px' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#334155', marginBottom: 6 }}>
            大題彙總
            <span style={{ fontWeight: 400, color: '#94a3b8', marginLeft: 6 }}>各大題整體得分率（依配分加權）</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {result.sections.map((s) => {
              const pct = Math.round(s.scoreRate * 100)
              const color = pct >= 80 ? '#16a34a' : pct >= 60 ? '#d97706' : '#dc2626'
              return (
                <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ flex: '0 0 210px', fontSize: 12, color: '#334155', display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</span>
                    <span style={{ flex: '0 0 auto', fontSize: 10, color: '#94a3b8' }}>{s.questionCount} 題</span>
                  </div>
                  {s.dimension && (
                    <span style={{ flex: '0 0 auto', fontSize: 10, color: '#475569', background: '#f1f5f9', borderRadius: 4, padding: '1px 6px' }}>
                      {s.dimension}
                    </span>
                  )}
                  <div style={{ flex: 1, height: 14, background: '#f1f5f9', borderRadius: 3, overflow: 'hidden', minWidth: 60 }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 3 }} />
                  </div>
                  <div style={{ flex: '0 0 42px', textAlign: 'right', fontSize: 12, fontWeight: 600, color, fontVariantNumeric: 'tabular-nums' }}>{pct}%</div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* 2026-07-16 user 拍板：「建議檢視」清單拿掉——老師直接看表格的難易/鑑別徽章即可；
          flagged 仍由 computeItemAnalysis 計算（留給未來自動提示用）、只是不渲染 */}

      {/* 逐題表 */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ color: '#64748b', textAlign: 'left', borderBottom: '1px solid #e2e8f0' }}>
              <th style={{ padding: '6px 8px' }}>題號</th>
              <th style={{ padding: '6px 8px' }}>難易 P</th>
              <th style={{ padding: '6px 8px' }}>鑑別 D</th>
              <th style={{ padding: '6px 8px', whiteSpace: 'nowrap' }} title="高分組（前27%）得分率">高分組</th>
              <th style={{ padding: '6px 8px', whiteSpace: 'nowrap' }} title="低分組（後27%）得分率">低分組</th>
              <th style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>對／錯／未答</th>
              <th style={{ padding: '6px 8px' }}>答案分布（✓＝正解；滑鼠停留看高低分組人數）</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((it) => (
              <tr key={it.questionId} style={{ borderBottom: '1px solid #f1f5f9', verticalAlign: 'top' }}>
                <td style={{ padding: '6px 8px', fontWeight: 600, whiteSpace: 'nowrap' }}>
                  {it.questionId}
                  {it.keySuspect && <span title="多數學生齊答同一個非正解、建議確認解答"> 🚩</span>}
                  {it.partialCredit && <div style={{ fontSize: 10, color: '#94a3b8', fontWeight: 400 }}>得分率制</div>}
                </td>
                <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                  {it.p.toFixed(2)}　<Badge text={it.pBand} palette={P_STYLE[it.pBand]} />
                </td>
                <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                  {it.dBand === '—' ? '—' : it.d.toFixed(2)}　<Badge text={it.dBand} palette={BAND_STYLE[it.dBand]} />
                </td>
                <td style={{ padding: '6px 8px' }}>{Math.round(it.ph * 100)}%</td>
                <td style={{ padding: '6px 8px' }}>{Math.round(it.pl * 100)}%</td>
                <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                  {it.correctCount}／{it.wrongCount}／{it.blankCount + it.unrecognizableCount}
                </td>
                <td style={{ padding: '6px 8px' }}>
                  <DistributionBar item={it} onAiFeatures={aiEnabled ? () => setAiItem(it) : undefined} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {aiEnabled && (
        <QuestionErrorFeaturesModal
          open={!!aiItem}
          onClose={() => setAiItem(null)}
          assignmentId={assignmentId!}
          domain={domain ?? ''}
          item={aiItem}
          stemSource={(() => {
            if (!aiItem || !templateId) return null
            const q = questions.find((x) => String(x.id ?? x.questionId ?? '') === aiItem.questionId)
            return q?.answerBbox ? { templateId, pageIndex: q.pageIndex ?? 0, bbox: q.answerBbox } : null
          })()}
          requestInk={requestInk!}
        />
      )}
      {result.items.length > 60 && !showAll && (
        <button type="button" onClick={() => setShowAll(true)} style={{ marginTop: 8, fontSize: 12, color: '#0369a1', background: 'none', border: 'none', cursor: 'pointer' }}>
          顯示全部 {result.items.length} 題
        </button>
      )}
      <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 8 }}>
        P＝(高分組＋低分組得分率)/2、D＝高分組−低分組（Ebel 標準）；非全有全無題以得分率計。🚩＝多數齊答非正解、建議確認解答。
      </div>
    </section>
  )
}
