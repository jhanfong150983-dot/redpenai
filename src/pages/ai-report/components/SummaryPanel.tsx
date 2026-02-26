type SummaryPanelProps = {
  tags: string[]
  suggestions: Array<{ label: string; text: string }>
  students: string[]
  studentNote: string
  loading: boolean
  remedy: string
}

export default function SummaryPanel({
  tags,
  suggestions,
  students,
  studentNote,
  loading,
  remedy
}: SummaryPanelProps) {
  return (
    <div className="summary-note">
      <div className="summary-title">老師行動摘要：</div>
      {loading ? (
        <div className="summary-loading">摘要生成中，請稍候...</div>
      ) : null}
      <div className="summary-section">
        <div className="summary-section-title">一、本次作業主要卡關概念</div>
        {tags.length ? (
          <div className="summary-lines">
            {tags.map((label) => (
              <div key={label}>{label}</div>
            ))}
          </div>
        ) : (
          <div className="summary-muted">尚無可判讀標籤。</div>
        )}
      </div>
      <div className="summary-section">
        <div className="summary-section-title">
          二、建議課堂處理方式（約 10 分鐘）
        </div>
        {loading ? (
          <div className="summary-muted">建議生成中，請稍候...</div>
        ) : suggestions.length ? (
          <div className="summary-lines">
            {suggestions.map((item) => (
              <div key={`${item.label}-${item.text}`}>{item.text}</div>
            ))}
          </div>
        ) : (
          <div className="summary-muted">尚無可提供建議。</div>
        )}
      </div>
      <div className="summary-section">
        <div className="summary-section-title">三、個別追蹤建議</div>
        {loading ? (
          <div className="summary-muted">補救方式生成中，請稍候...</div>
        ) : students.length ? (
          <>
            <div className="summary-lines">
              以下學生在上述錯誤類型中反覆出現，建議課後請其口頭說明解題步驟，確認是否能正確處理題目條件與關鍵計算步驟：
            </div>
            {remedy ? (
              <div className="summary-lines">補救方式：{remedy}</div>
            ) : null}
            <div className="summary-students">{students.join('、')}</div>
          </>
        ) : (
          <div className="summary-muted">{studentNote}</div>
        )}
      </div>
    </div>
  )
}
