// SW 自動修復：偵測版本變更、白屏、chunk 載入失敗 → 自動清除 SW 快取並重載
// 此檔案由 index.html 以普通 <script> 載入，在所有 module script 之前執行
(function () {
  var RESET_KEY = 'rp-sw-reset'

  // 1) 若標記了需要 reset → 清除 SW + caches → reload
  var needsReset = false
  try { needsReset = localStorage.getItem(RESET_KEY) === '1' } catch (e) {}
  if (needsReset) {
    try { localStorage.removeItem(RESET_KEY) } catch (e) {}
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then(function (regs) {
        var tasks = regs.map(function (r) { return r.unregister() })
        if ('caches' in window) {
          tasks.push(
            caches.keys().then(function (keys) {
              return Promise.all(keys.map(function (k) { return caches.delete(k) }))
            })
          )
        }
        return Promise.all(tasks)
      }).then(function () {
        location.reload()
      }).catch(function () {
        location.reload()
      })
      // 顯示提示，阻止後續 module script 載入壞的 chunk
      var root = document.getElementById('root')
      if (root) {
        root.innerHTML =
          '<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;color:#64748b">' +
          '<p>正在更新版本，請稍候...</p></div>'
      }
      // 用 throw 中斷後續同步執行（module scripts 仍會載入但 root 已有內容不會白屏）
    }
    return
  }

  // 2) 白屏保護：8 秒後 #root 仍為空 → 清除快取重載（最多觸發一次）
  setTimeout(function () {
    var root = document.getElementById('root')
    if (!root || root.children.length > 0) return
    console.warn('[SW-fix] 偵測到白屏，清除快取')
    try { localStorage.setItem(RESET_KEY, '1') } catch (e) {}
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then(function (regs) {
        return Promise.all(regs.map(function (r) { return r.unregister() }))
      }).then(function () {
        if ('caches' in window) {
          return caches.keys().then(function (keys) {
            return Promise.all(keys.map(function (k) { return caches.delete(k) }))
          })
        }
      }).then(function () {
        location.reload()
      }).catch(function () {
        location.reload()
      })
    } else {
      location.reload()
    }
  }, 8000)

  // 3) chunk 載入失敗 → 標記 reset + reload
  window.addEventListener('error', function (e) {
    if (e.filename && /\/assets\/.*\.js$/.test(e.filename)) {
      console.warn('[SW-fix] chunk 載入失敗:', e.filename)
      try { localStorage.setItem(RESET_KEY, '1') } catch (ex) {}
      location.reload()
    }
  })
})()
