// 模式選擇器使用的 SVG 示意圖。
// 跟 prompt/AI 流程無關，純視覺輔助元件。

export function WithQuestionsIllustration({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 200 170"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="一般模式：題目和答案在同一張紙"
      className={className}
    >
      <rect x="20" y="10" width="160" height="150" fill="#ffffff" stroke="#64748b" strokeWidth="1.5" rx="3" />
      <rect x="30" y="20" width="140" height="6" fill="#e2e8f0" rx="1" />

      {/* Q1: ( C ) 1. */}
      <text x="32" y="44" fontFamily="sans-serif" fontSize="9" fill="#334155">(    ) 1.</text>
      <text x="40" y="44" fontFamily="serif" fontSize="11" fill="#dc2626" fontWeight="bold">C</text>
      <line x1="58" y1="44" x2="172" y2="44" stroke="#cbd5e1" strokeWidth="0.6" />
      <line x1="32" y1="54" x2="172" y2="54" stroke="#cbd5e1" strokeWidth="0.6" />
      <text x="40" y="66" fontFamily="sans-serif" fontSize="6.5" fill="#94a3b8">(A)──  (B)──  (C)──  (D)──</text>

      {/* Q2: ( A ) 2. */}
      <text x="32" y="86" fontFamily="sans-serif" fontSize="9" fill="#334155">(    ) 2.</text>
      <text x="40" y="86" fontFamily="serif" fontSize="11" fill="#dc2626" fontWeight="bold">A</text>
      <line x1="58" y1="86" x2="172" y2="86" stroke="#cbd5e1" strokeWidth="0.6" />
      <line x1="32" y1="96" x2="172" y2="96" stroke="#cbd5e1" strokeWidth="0.6" />
      <text x="40" y="108" fontFamily="sans-serif" fontSize="6.5" fill="#94a3b8">(A)──  (B)──  (C)──  (D)──</text>

      {/* Q3: ( B ) 3. */}
      <text x="32" y="128" fontFamily="sans-serif" fontSize="9" fill="#334155">(    ) 3.</text>
      <text x="40" y="128" fontFamily="serif" fontSize="11" fill="#dc2626" fontWeight="bold">B</text>
      <line x1="58" y1="128" x2="172" y2="128" stroke="#cbd5e1" strokeWidth="0.6" />
      <line x1="32" y1="138" x2="172" y2="138" stroke="#cbd5e1" strokeWidth="0.6" />

      <text x="100" y="155" fontFamily="sans-serif" fontSize="6.5" fill="#16a34a" textAnchor="middle">📄 一張紙：題目＋作答區一起</text>
    </svg>
  )
}

export function AnswerOnlyIllustration({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 280 170"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="答案卷模式：題目本和答題卡是兩張紙"
      className={className}
    >
      {/* LEFT: 題目本 */}
      <rect x="10" y="10" width="120" height="150" fill="#ffffff" stroke="#64748b" strokeWidth="1.5" rx="3" />
      <rect x="20" y="20" width="100" height="6" fill="#e2e8f0" rx="1" />

      <text x="22" y="40" fontFamily="sans-serif" fontSize="7" fill="#475569">1. ───────────────</text>
      <text x="22" y="50" fontFamily="sans-serif" fontSize="7" fill="#94a3b8">─────────────────</text>
      <text x="32" y="62" fontFamily="sans-serif" fontSize="6" fill="#94a3b8">(A) (B) (C) (D)</text>

      <text x="22" y="82" fontFamily="sans-serif" fontSize="7" fill="#475569">2. ──────────────</text>
      <text x="22" y="92" fontFamily="sans-serif" fontSize="7" fill="#94a3b8">─────────────</text>
      <text x="32" y="104" fontFamily="sans-serif" fontSize="6" fill="#94a3b8">(A) (B) (C) (D)</text>

      <text x="22" y="124" fontFamily="sans-serif" fontSize="7" fill="#475569">3. ──────────────</text>
      <text x="22" y="134" fontFamily="sans-serif" fontSize="7" fill="#94a3b8">────────────</text>

      <text x="70" y="155" fontFamily="sans-serif" fontSize="6.5" fill="#64748b" textAnchor="middle">題本（學生看）</text>

      {/* + */}
      <text x="140" y="92" fontFamily="sans-serif" fontSize="14" fill="#94a3b8" textAnchor="middle" fontWeight="bold">+</text>

      {/* RIGHT: 答題卡 */}
      <rect x="150" y="10" width="120" height="150" fill="#ffffff" stroke="#64748b" strokeWidth="1.5" rx="3" />
      <rect x="160" y="20" width="100" height="6" fill="#e2e8f0" rx="1" />

      {/* 單選 */}
      <text x="160" y="40" fontFamily="sans-serif" fontSize="6.5" fill="#475569">一、單選</text>
      <rect x="160" y="44" width="100" height="22" fill="none" stroke="#64748b" strokeWidth="0.6" />
      <line x1="160" y1="55" x2="260" y2="55" stroke="#64748b" strokeWidth="0.6" />
      <line x1="180" y1="44" x2="180" y2="66" stroke="#64748b" strokeWidth="0.6" />
      <line x1="200" y1="44" x2="200" y2="66" stroke="#64748b" strokeWidth="0.6" />
      <line x1="220" y1="44" x2="220" y2="66" stroke="#64748b" strokeWidth="0.6" />
      <line x1="240" y1="44" x2="240" y2="66" stroke="#64748b" strokeWidth="0.6" />

      <text x="170" y="53" fontFamily="sans-serif" fontSize="6" fill="#64748b" textAnchor="middle">1</text>
      <text x="190" y="53" fontFamily="sans-serif" fontSize="6" fill="#64748b" textAnchor="middle">2</text>
      <text x="210" y="53" fontFamily="sans-serif" fontSize="6" fill="#64748b" textAnchor="middle">3</text>
      <text x="230" y="53" fontFamily="sans-serif" fontSize="6" fill="#64748b" textAnchor="middle">4</text>
      <text x="250" y="53" fontFamily="sans-serif" fontSize="6" fill="#64748b" textAnchor="middle">5</text>

      <text x="170" y="63" fontFamily="serif" fontSize="9" fill="#dc2626" fontWeight="bold" textAnchor="middle">C</text>
      <text x="190" y="63" fontFamily="serif" fontSize="9" fill="#dc2626" fontWeight="bold" textAnchor="middle">A</text>
      <text x="210" y="63" fontFamily="serif" fontSize="9" fill="#dc2626" fontWeight="bold" textAnchor="middle">B</text>
      <text x="230" y="63" fontFamily="serif" fontSize="9" fill="#dc2626" fontWeight="bold" textAnchor="middle">D</text>
      <text x="250" y="63" fontFamily="serif" fontSize="9" fill="#dc2626" fontWeight="bold" textAnchor="middle">A</text>

      {/* 多選 */}
      <text x="160" y="80" fontFamily="sans-serif" fontSize="6.5" fill="#475569">二、多選</text>
      <rect x="160" y="84" width="100" height="20" fill="none" stroke="#64748b" strokeWidth="0.6" />
      <line x1="185" y1="84" x2="185" y2="104" stroke="#64748b" strokeWidth="0.6" />
      <line x1="210" y1="84" x2="210" y2="104" stroke="#64748b" strokeWidth="0.6" />
      <line x1="235" y1="84" x2="235" y2="104" stroke="#64748b" strokeWidth="0.6" />

      <text x="172" y="98" fontFamily="serif" fontSize="8" fill="#dc2626" fontWeight="bold" textAnchor="middle">BC</text>
      <text x="197" y="98" fontFamily="serif" fontSize="8" fill="#dc2626" fontWeight="bold" textAnchor="middle">AD</text>
      <text x="222" y="98" fontFamily="serif" fontSize="8" fill="#dc2626" fontWeight="bold" textAnchor="middle">BE</text>
      <text x="247" y="98" fontFamily="serif" fontSize="8" fill="#dc2626" fontWeight="bold" textAnchor="middle">CE</text>

      {/* 非選 */}
      <text x="160" y="118" fontFamily="sans-serif" fontSize="6.5" fill="#475569">三、非選</text>
      <rect x="160" y="122" width="100" height="18" fill="none" stroke="#64748b" strokeWidth="0.6" />
      <line x1="195" y1="122" x2="195" y2="140" stroke="#64748b" strokeWidth="0.6" />
      <line x1="225" y1="122" x2="225" y2="140" stroke="#64748b" strokeWidth="0.6" />

      <text x="177" y="135" fontFamily="serif" fontSize="7" fill="#dc2626" fontWeight="bold" textAnchor="middle">240A</text>
      <text x="210" y="135" fontFamily="serif" fontSize="7" fill="#dc2626" fontWeight="bold" textAnchor="middle">7.5</text>
      <text x="242" y="135" fontFamily="serif" fontSize="7" fill="#dc2626" fontWeight="bold" textAnchor="middle">1.5</text>

      <text x="210" y="155" fontFamily="sans-serif" fontSize="6.5" fill="#64748b" textAnchor="middle">答題卡（學生填）</text>
    </svg>
  )
}

export function GeneratedSheetIllustration({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 280 170"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="系統製作作答卷：上傳題本，系統排版作答卷"
      className={className}
    >
      {/* LEFT: 題本 */}
      <rect x="10" y="10" width="100" height="150" fill="#ffffff" stroke="#64748b" strokeWidth="1.5" rx="3" />
      <rect x="20" y="20" width="80" height="6" fill="#e2e8f0" rx="1" />
      <text x="22" y="40" fontFamily="sans-serif" fontSize="7" fill="#475569">1. ────────────</text>
      <text x="22" y="50" fontFamily="sans-serif" fontSize="7" fill="#94a3b8">──────────────</text>
      <text x="22" y="72" fontFamily="sans-serif" fontSize="7" fill="#475569">2. ────────────</text>
      <text x="22" y="82" fontFamily="sans-serif" fontSize="7" fill="#94a3b8">──────────</text>
      <text x="22" y="104" fontFamily="sans-serif" fontSize="7" fill="#475569">3. ────────────</text>
      <text x="22" y="114" fontFamily="sans-serif" fontSize="7" fill="#94a3b8">────────────</text>
      <text x="60" y="155" fontFamily="sans-serif" fontSize="6.5" fill="#64748b" textAnchor="middle">題本（老師上傳）</text>

      {/* → */}
      <text x="128" y="92" fontFamily="sans-serif" fontSize="14" fill="#10b981" textAnchor="middle" fontWeight="bold">→</text>

      {/* RIGHT: 系統排版的作答卷（四角錨點＋座號劃卡＋作答格） */}
      <rect x="150" y="10" width="120" height="150" fill="#ffffff" stroke="#64748b" strokeWidth="1.5" rx="3" />
      <rect x="155" y="15" width="7" height="7" fill="#0f172a" />
      <rect x="258" y="15" width="7" height="7" fill="#0f172a" />
      <rect x="155" y="148" width="7" height="7" fill="#0f172a" />
      <rect x="258" y="148" width="7" height="7" fill="#0f172a" />
      <rect x="168" y="16" width="60" height="5" fill="#e2e8f0" rx="1" />
      {/* 座號劃卡 */}
      <text x="168" y="33" fontFamily="sans-serif" fontSize="5.5" fill="#64748b">座號</text>
      <rect x="184" y="27" width="70" height="8" fill="none" stroke="#94a3b8" strokeWidth="0.5" />
      <circle cx="190" cy="31" r="2.2" fill="none" stroke="#94a3b8" strokeWidth="0.5" />
      <circle cx="198" cy="31" r="2.2" fill="#0f172a" />
      <circle cx="206" cy="31" r="2.2" fill="none" stroke="#94a3b8" strokeWidth="0.5" />
      <circle cx="214" cy="31" r="2.2" fill="none" stroke="#94a3b8" strokeWidth="0.5" />
      <circle cx="222" cy="31" r="2.2" fill="none" stroke="#94a3b8" strokeWidth="0.5" />
      <circle cx="230" cy="31" r="2.2" fill="none" stroke="#94a3b8" strokeWidth="0.5" />
      <circle cx="238" cy="31" r="2.2" fill="#0f172a" />
      <circle cx="246" cy="31" r="2.2" fill="none" stroke="#94a3b8" strokeWidth="0.5" />
      {/* 作答格 */}
      <text x="160" y="48" fontFamily="sans-serif" fontSize="6" fill="#475569">一、選擇</text>
      <rect x="160" y="51" width="100" height="20" fill="none" stroke="#64748b" strokeWidth="0.6" />
      <line x1="160" y1="61" x2="260" y2="61" stroke="#64748b" strokeWidth="0.6" />
      <line x1="180" y1="51" x2="180" y2="71" stroke="#64748b" strokeWidth="0.6" />
      <line x1="200" y1="51" x2="200" y2="71" stroke="#64748b" strokeWidth="0.6" />
      <line x1="220" y1="51" x2="220" y2="71" stroke="#64748b" strokeWidth="0.6" />
      <line x1="240" y1="51" x2="240" y2="71" stroke="#64748b" strokeWidth="0.6" />
      <text x="170" y="59" fontFamily="sans-serif" fontSize="5.5" fill="#64748b" textAnchor="middle">1</text>
      <text x="190" y="59" fontFamily="sans-serif" fontSize="5.5" fill="#64748b" textAnchor="middle">2</text>
      <text x="210" y="59" fontFamily="sans-serif" fontSize="5.5" fill="#64748b" textAnchor="middle">3</text>
      <text x="230" y="59" fontFamily="sans-serif" fontSize="5.5" fill="#64748b" textAnchor="middle">4</text>
      <text x="250" y="59" fontFamily="sans-serif" fontSize="5.5" fill="#64748b" textAnchor="middle">5</text>
      <text x="160" y="84" fontFamily="sans-serif" fontSize="6" fill="#475569">二、填充</text>
      <rect x="160" y="87" width="100" height="18" fill="none" stroke="#64748b" strokeWidth="0.6" />
      <line x1="193" y1="87" x2="193" y2="105" stroke="#64748b" strokeWidth="0.6" />
      <line x1="226" y1="87" x2="226" y2="105" stroke="#64748b" strokeWidth="0.6" />
      <text x="160" y="118" fontFamily="sans-serif" fontSize="6" fill="#475569">三、計算</text>
      <rect x="160" y="121" width="100" height="22" fill="none" stroke="#64748b" strokeWidth="0.6" />
      <text x="210" y="155" fontFamily="sans-serif" fontSize="6.5" fill="#10b981" textAnchor="middle">系統排版・列印給學生</text>
    </svg>
  )
}

// 2026-09-19 作文模式：題本（作文題目）→ 系統製作的紅格稿紙（橫放直書）
export function EssayModeIllustration({ className = '' }: { className?: string }) {
  const cols = Array.from({ length: 9 }, (_, i) => 160 + i * 12)
  const rows = Array.from({ length: 8 }, (_, i) => 40 + i * 12)
  return (
    <svg viewBox="0 0 280 170" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="作文模式：上傳作文題目，系統製作稿紙" className={className}>
      {/* LEFT: 作文題目 */}
      <rect x="10" y="10" width="100" height="150" fill="#ffffff" stroke="#64748b" strokeWidth="1.5" rx="3" />
      <rect x="20" y="20" width="80" height="6" fill="#e2e8f0" rx="1" />
      <rect x="22" y="36" width="76" height="40" fill="#f1f5f9" stroke="#cbd5e1" strokeWidth="0.6" rx="2" />
      <text x="60" y="60" fontFamily="sans-serif" fontSize="7" fill="#94a3b8" textAnchor="middle">引導材料／圖</text>
      <text x="22" y="92" fontFamily="sans-serif" fontSize="7" fill="#475569">請依題意完成一篇</text>
      <text x="22" y="103" fontFamily="sans-serif" fontSize="7" fill="#475569">文章……</text>
      <text x="60" y="155" fontFamily="sans-serif" fontSize="6.5" fill="#64748b" textAnchor="middle">作文題目（老師上傳）</text>
      <text x="128" y="92" fontFamily="sans-serif" fontSize="14" fill="#d97706" textAnchor="middle" fontWeight="bold">→</text>
      {/* RIGHT: 稿紙（橫放） */}
      <rect x="146" y="26" width="128" height="118" fill="#ffffff" stroke="#64748b" strokeWidth="1.5" rx="3" />
      <rect x="150" y="30" width="5" height="5" fill="#0f172a" />
      <rect x="265" y="30" width="5" height="5" fill="#0f172a" />
      <rect x="150" y="135" width="5" height="5" fill="#0f172a" />
      <rect x="265" y="135" width="5" height="5" fill="#0f172a" />
      {cols.map((x) => rows.map((y) => <rect key={`${x}-${y}`} x={x} y={y} width="9" height="12" fill="none" stroke="#e57373" strokeWidth="0.6" />))}
      <text x="260.5" y="50" fontFamily="serif" fontSize="8" fill="#334155" textAnchor="middle">我</text>
      <text x="260.5" y="62" fontFamily="serif" fontSize="8" fill="#334155" textAnchor="middle">認</text>
      <text x="260.5" y="74" fontFamily="serif" fontSize="8" fill="#334155" textAnchor="middle">為</text>
      <text x="210" y="155" fontFamily="sans-serif" fontSize="6.5" fill="#64748b" textAnchor="middle">系統稿紙（每面 506 格 × 兩頁）</text>
    </svg>
  )
}


// 2026-09-19 自備作文卷：老師上傳自己的空白稿紙 → 系統自動抓出每一行
export function EssayByoIllustration({ className = '' }: { className?: string }) {
  const cols = Array.from({ length: 9 }, (_, i) => 26 + i * 9)
  const rows = Array.from({ length: 9 }, (_, i) => 40 + i * 11)
  const cols2 = Array.from({ length: 9 }, (_, i) => 166 + i * 11)
  return (
    <svg viewBox="0 0 280 170" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="自備作文卷：上傳自己的空白稿紙，系統自動抓出每一行" className={className}>
      {/* LEFT: 老師自己的空白稿紙 */}
      <rect x="10" y="26" width="104" height="118" fill="#ffffff" stroke="#64748b" strokeWidth="1.5" rx="3" />
      {cols.map((x) => rows.map((y) => <rect key={`a${x}-${y}`} x={x} y={y} width="8" height="11" fill="none" stroke="#e57373" strokeWidth="0.5" />))}
      <text x="62" y="155" fontFamily="sans-serif" fontSize="6.5" fill="#64748b" textAnchor="middle">你的空白稿紙（上傳）</text>
      <text x="132" y="92" fontFamily="sans-serif" fontSize="14" fill="#d97706" textAnchor="middle" fontWeight="bold">→</text>
      {/* RIGHT: 系統抓出每一行 */}
      <rect x="150" y="26" width="120" height="118" fill="#ffffff" stroke="#64748b" strokeWidth="1.5" rx="3" />
      {cols2.map((x) => rows.map((y) => <rect key={`b${x}-${y}`} x={x} y={y} width="9" height="11" fill="none" stroke="#e57373" strokeWidth="0.5" />))}
      {cols2.filter((_, i) => i % 2 === 0).map((x) => (
        <rect key={`h${x}`} x={x - 1} y={38} width="11" height="101" fill="none" stroke="#16a34a" strokeWidth="1.6" />
      ))}
      <text x="210" y="155" fontFamily="sans-serif" fontSize="6.5" fill="#64748b" textAnchor="middle">系統自動抓出每一行</text>
    </svg>
  )
}
