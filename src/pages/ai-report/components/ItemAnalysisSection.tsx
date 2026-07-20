// 試題分析區（2026-07-16 第一波、user 拍板）：純程式即時渲染、零 AI 零點數。
// 摘要磚（樣本/平均難易/平均鑑別/信度α）＋逐題表（P/D/高低分組/對錯空/答案分布橫條/品質標記）。
// 視覺規範：正解＝語意綠＋文字標籤、其他樣態中性灰、未答淺灰；徽章一律帶文字、不靠顏色單獨傳達。
import { useMemo, useState } from 'react'
import { computeItemAnalysis } from '../item-analysis'
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

// 圖上作答佔位字（計算作圖/繪圖題：答案畫在卷上、無文字答案）——用來判定「無樣態可統計、改看對/錯」。
const IMAGE_ANSWER_LABELS = new Set(['圖上作答', '見圖', '作圖', '如圖', '畫圖', '圖示作答', '紙上作答', '手寫作答'])

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
  // 圖上作答題（計算作圖/繪圖）：答案畫在卷上、讀取吐「圖上作答」佔位、無文字樣態可統計
  //   → 改對/錯/未答視角、不提供 AI 樣態歸納（看不到手繪、無意義）。
  const isImageAnswer = nonBlankVariants.length > 0
    && nonBlankVariants.every((o) => IMAGE_ANSWER_LABELS.has(String(o.label).trim()))

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
          <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>圖上作答，僅統計對／錯（無文字答案樣態）</div>
        )}
        {/* 2026-07-16 user 二次拍板：取消系統性樣態列舉（訊息量太大）→ 改 AI 歸納 modal（on-demand、結果持久化） */}
        {!isImageAnswer && onAiFeatures && (item.n - item.correctCount - blankTotal) >= 3 && (
          <button
            type="button"
            onClick={onAiFeatures}
            style={{ marginTop: 2, fontSize: 11, color: '#2563eb', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
          >
            🔎 AI 歸納錯誤樣態
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
  const result = useMemo(() => computeItemAnalysis(questions, submissions), [questions, submissions])
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
