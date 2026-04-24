# WebView 白屏事件 — 事後分析報告

- **日期**：2026-04-24
- **影響範圍**：所有透過 1Campus APP (WebView) 進入的教師與學生
- **症狀**：WebView 顯示黑色原生 loading 圈圈後變成白屏，React 完全不渲染
- **瀏覽器正常**：手機/平板/電腦用一般瀏覽器進入完全正常

---

## 根因

### `main.tsx` 第 36 行未檢查 `navigator.serviceWorker` 是否存在

```typescript
// commit d032f62 (2026-04-23 18:15) 新增的程式碼
navigator.serviceWorker.addEventListener('controllerchange', () => {
  if (!refreshing) {
    refreshing = true
    window.location.reload()
  }
})
```

**WebView 不支援 Service Worker**，所以 `navigator.serviceWorker` 是 `undefined`。
對 `undefined` 呼叫 `.addEventListener()` 會拋出 `TypeError`。

這段程式碼在 **module 初始化階段**執行（不是在 callback 或 event handler 裡），
所以整個 JS module 在載入時就直接 crash，React 根本來不及掛載 → 白屏。

### 事發原因

commit `d032f62` 是由 Claude (AI 助手) 在 2026-04-23 的對話中撰寫的，
目的是解決「部署新版後 Service Worker 快取舊版程式碼，使用者看到過期 UI」的問題。
解法是監聽 `controllerchange` 事件，當新 SW 接管時自動重載頁面。

**疏失**：撰寫時只考慮了一般瀏覽器環境，沒有考慮 WebView 不支援 Service Worker 的情況，
也沒有像 else 分支那樣先用 `'serviceWorker' in navigator` 做存在性檢查。
加上這段程式碼位於 module 頂層（非 callback），一旦 crash 就導致整個應用白屏。

### 修復

```typescript
// 加上 'serviceWorker' in navigator 檢查
if ('serviceWorker' in navigator) {
  let refreshing = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!refreshing) {
      refreshing = true
      window.location.reload()
    }
  })
}
```

**Commit**: `408a3d2`

---

## 偵錯過程中的關鍵線索

| 線索 | 解讀 |
|------|------|
| 黑色旋轉圈圈（不是藍色+文字） | WebView 原生 loading indicator，不是 React 渲染的 |
| Vercel 完全沒有登入 log | JS crash → SSO redirect 從未執行 |
| 一般瀏覽器正常 | 瀏覽器支援 `navigator.serviceWorker`，不會 crash |
| 4/23 改完就壞了 | `d032f62` 的時間點完全吻合 |

**「黑色圈圈」是最關鍵的線索** — 它代表我們的 CSS 和 React 都沒有載入，問題在 JS module 初始化階段。

---

## 防範規則

### 1. 永遠檢查 Web API 是否存在再使用

```typescript
// BAD — WebView 會 crash
navigator.serviceWorker.addEventListener(...)
navigator.clipboard.writeText(...)
navigator.share(...)

// GOOD — 先檢查
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener(...)
}
if (navigator.clipboard?.writeText) {
  await navigator.clipboard.writeText(...)
}
```

### 2. 特別小心 module 頂層 / 初始化階段的程式碼

在 `useEffect` 或 event handler 裡 crash 只會影響該功能。
但在 **module 頂層**或**元件外部**的程式碼 crash，會導致**整個應用白屏**。

```typescript
// 危險區域：module 頂層
if (import.meta.env.PROD) {
  // 這裡 crash = 整個 app 白屏
  navigator.serviceWorker.addEventListener(...)  // <-- 就是這個炸了
}

// 相對安全：useEffect 內
useEffect(() => {
  // 這裡 crash = 只影響這個 component
}, [])
```

### 3. WebView 的已知限制

以下功能在 WebView 中可能不支援或行為不同：

| 功能 | 狀態 |
|------|------|
| `navigator.serviceWorker` | 不支援（undefined） |
| `structuredClone()` | Chrome 98+ 才有 |
| `navigator.clipboard` | 可能受限 |
| CSS `gap` in flexbox | Chrome 84+ |
| `?.` / `??` 語法 | 需要 build target 降級（已設 es2015） |

---

## 今天的所有改動

### 前端 (redpenai)

| Commit | 改動 | 是根因修復？ | 建議 |
|--------|------|------------|------|
| `408a3d2` | guard `navigator.serviceWorker` 存取 | **是 — 根因** | 保留 |
| `a54961e` | build target 降為 es2015 | 否（額外保護） | 保留 |
| `739a9ad` | structuredClone → JSON.parse(JSON.stringify()) | 否（額外保護） | 保留 |
| `07a9e7e` | SW navigation handler 排除 /api/ | 否（排查中的嘗試） | 保留（合理改動） |
| `e24e0ea` | SSO redirect 前移除 SW | 否（排查中的嘗試） | **可還原** |
| `b93c723` | Vercel edge redirect + SW no-cache headers | 否（排查中的嘗試） | **部分還原** |
| `c5a5e49` | sw-fix.js 白屏診斷畫面 | 否（診斷工具） | 保留（安全網） |
| `4dcae04` | vercel.json no-cache headers | 否（排查中的嘗試） | 保留（合理改動） |
| `9fbd289` | sw-fix.js + index.html 引入 | 否（排查中的嘗試） | 保留（安全網） |

### 後端 (redpenaisever)

| Commit | 改動 | 是根因修復？ | 建議 |
|--------|------|------------|------|
| `a855ce5` | sync handler state transitions 修復 | **是 — 另一個真實 bug** | 保留 |

---

## 教訓總結

1. **WebView ≠ 瀏覽器**：不要假設所有 Web API 都存在
2. **module 頂層的 crash 最致命**：整個 app 會白屏，而且沒有任何錯誤畫面
3. **「黑色圈圈 vs 藍色圈圈」這種細節是偵錯的金鑰匙**
4. **先排除最簡單的可能性**：一行未檢查的 `navigator.serviceWorker` 比 SW cache 機制問題簡單得多
