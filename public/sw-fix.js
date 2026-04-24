// SW 自動修復 + 白屏診斷
(function () {
  var RESET_KEY = 'rp-sw-reset'
  var DIAG_KEY = 'rp-diag-count'
  var diagInfo = []

  function addDiag(msg) {
    diagInfo.push('[' + new Date().toLocaleTimeString() + '] ' + msg)
  }

  addDiag('sw-fix.js loaded')
  addDiag('URL: ' + location.href)
  addDiag('UA: ' + navigator.userAgent)

  // 記錄 URL 參數
  try {
    var params = new URLSearchParams(location.search)
    var code = params.get('code') || ''
    var dsns = params.get('dsns') || ''
    addDiag('code=' + (code ? code.substring(0, 8) + '...' : '(none)'))
    addDiag('dsns=' + (dsns || '(none)'))
  } catch (e) {
    addDiag('URL parse error: ' + e.message)
  }

  // 防止無限 reload：最多連續重試 2 次
  var diagCount = 0
  try { diagCount = parseInt(sessionStorage.getItem(DIAG_KEY) || '0', 10) || 0 } catch (e) {}

  // 1) 若標記了需要 reset（且未超過重試上限）
  var needsReset = false
  try { needsReset = localStorage.getItem(RESET_KEY) === '1' } catch (e) {}
  if (needsReset && diagCount < 2) {
    try { localStorage.removeItem(RESET_KEY) } catch (e) {}
    try { sessionStorage.setItem(DIAG_KEY, String(diagCount + 1)) } catch (e) {}
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
      var root = document.getElementById('root')
      if (root) {
        root.innerHTML =
          '<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;color:#64748b">' +
          '<p>正在更新版本，請稍候...</p></div>'
      }
    }
    return
  }

  // 2) 白屏診斷：5 秒後若 #root 仍為空，顯示診斷資訊
  setTimeout(function () {
    var root = document.getElementById('root')
    if (!root || root.children.length > 0) {
      // 正常載入，清除重試計數
      try { sessionStorage.removeItem(DIAG_KEY) } catch (e) {}
      return
    }

    addDiag('5s 後 #root 仍為空')

    // 收集更多資訊
    try {
      addDiag('SW support: ' + ('serviceWorker' in navigator))
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(function (regs) {
          addDiag('SW registrations: ' + regs.length)
        })
      }
    } catch (e) {}

    // 收集所有載入錯誤
    addDiag('Errors: ' + (window.__swFixErrors || []).join('; '))

    // 直接在頁面上顯示診斷資訊（讓使用者截圖）
    root.innerHTML =
      '<div style="padding:24px;font-family:sans-serif;max-width:600px;margin:40px auto">' +
      '<h2 style="color:#dc2626;font-size:18px;margin-bottom:12px">頁面載入失敗 — 診斷資訊</h2>' +
      '<p style="color:#64748b;font-size:14px;margin-bottom:16px">請將此畫面截圖傳給老師或管理員</p>' +
      '<pre style="background:#f1f5f9;padding:16px;border-radius:8px;font-size:12px;white-space:pre-wrap;word-break:break-all;line-height:1.6;color:#334155">' +
      diagInfo.join('\n') +
      '</pre>' +
      '<button onclick="try{localStorage.setItem(\'rp-sw-reset\',\'1\')}catch(e){};location.reload()" ' +
      'style="margin-top:16px;padding:10px 20px;background:#2563eb;color:white;border:none;border-radius:8px;font-size:14px;cursor:pointer">' +
      '清除快取並重試</button>' +
      '</div>'
  }, 5000)

  // 3) 收集 JS 載入錯誤
  window.__swFixErrors = []
  window.addEventListener('error', function (e) {
    var msg = ''
    if (e.filename) {
      msg = e.filename.split('/').pop() + ':' + e.lineno + ' ' + (e.message || '')
    } else if (e.message) {
      msg = e.message
    }
    if (msg) {
      window.__swFixErrors.push(msg)
    }
    // chunk 載入失敗且未超過重試上限
    if (e.filename && /\/assets\/.*\.js$/.test(e.filename) && diagCount < 2) {
      try { localStorage.setItem(RESET_KEY, '1') } catch (ex) {}
      try { sessionStorage.setItem(DIAG_KEY, String(diagCount + 1)) } catch (ex) {}
      location.reload()
    }
  })
})()
