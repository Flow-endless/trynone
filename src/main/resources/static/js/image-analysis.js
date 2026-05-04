/**
 * 图片分析页：上传、预览、YOLO / OCR（真实后端优先，失败直接提示）
 */
;(function () {
  const API_BASE =
    typeof window.mmResolveApiBase === 'function' ? window.mmResolveApiBase() : window.location.protocol === 'file:' ? 'http://127.0.0.1:8081' : ''
  const API_YOLO = `${API_BASE}/api/vision/yolo`
  const API_OCR = `${API_BASE}/api/vision/ocr`
  const REQUEST_TIMEOUT_MS = 620000
  /** YOLO：略宽松。OCR：更严（大图上传易触发 ERR_CONNECTION_RESET） */
  const YOLO_MAX_EDGE = 2560
  const YOLO_MAX_BYTES = 2.5 * 1024 * 1024
  const OCR_MAX_EDGE = 1920
  const OCR_MAX_BYTES = 800 * 1024
  /** 压完仍超过此体积则再缩一档（仅 OCR） */
  const OCR_MAX_BLOB = 1.35 * 1024 * 1024

  const dropzone = document.getElementById('ia-dropzone')
  const fileInput = document.getElementById('ia-file-input')
  const btnAnalyze = document.getElementById('ia-btn-analyze')
  const btnClear = document.getElementById('ia-btn-clear')
  const previewWrap = document.getElementById('ia-preview-body')
  const resultBody = document.getElementById('ia-result-body')
  const modeRadios = document.querySelectorAll('input[name="ia-mode"]')
  const badgeMode = document.getElementById('ia-badge-mode')
  const fileMetaEl = document.getElementById('ia-file-meta')

  let currentFile = null
  let previewUrl = null
  /** 用于窗口缩放时重绘检测框 */
  let lastYoloDetections = null
  let bboxResizeObserver = null
  let toastTimer = null
  const clipboardPayload = { ocr: '', yolo: '' }
  const IA_SESSION_KEY = 'mm_ia_session_v1'
  const IA_SESSION_MAX_CHARS = 2400000
  /** 与 video 页共用：大图 base64+长 OCR 会撑爆 sessionStorage，文件与超大结果进 IDB */
  const MM_IDB_NAME = 'mm_multimodal_v1'
  const MM_IDB_STORE = 'files'
  const IA_IDB_KEY_FILE = 'image_session_blob'
  const IA_IDB_KEY_RESULT = 'image_session_result_json'
  const IA_DATAURL_FALLBACK_MAX = 1.1 * 1024 * 1024
  let lastApiSnapshot = null
  let persistSessionTimer = null

  function iaIdbOpen() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error('no idb'))
        return
      }
      const req = indexedDB.open(MM_IDB_NAME, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(MM_IDB_STORE)) {
          db.createObjectStore(MM_IDB_STORE)
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }

  async function iaIdbPutFile(file) {
    const db = await iaIdbOpen()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(MM_IDB_STORE, 'readwrite')
      tx.oncomplete = () => {
        try {
          db.close()
        } catch (_) {}
        resolve()
      }
      tx.onerror = () => {
        try {
          db.close()
        } catch (_) {}
        reject(tx.error)
      }
      try {
        tx.objectStore(MM_IDB_STORE).put(file, IA_IDB_KEY_FILE)
      } catch (e) {
        try {
          db.close()
        } catch (_) {}
        reject(e)
      }
    })
  }

  async function iaIdbGetFile() {
    const db = await iaIdbOpen()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(MM_IDB_STORE, 'readonly')
      const q = tx.objectStore(MM_IDB_STORE).get(IA_IDB_KEY_FILE)
      q.onsuccess = () => {
        try {
          db.close()
        } catch (_) {}
        const r = q.result
        resolve(r && r instanceof Blob ? r : null)
      }
      q.onerror = () => {
        try {
          db.close()
        } catch (_) {}
        reject(q.error)
      }
    })
  }

  async function iaIdbPutResultJson(text) {
    const db = await iaIdbOpen()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(MM_IDB_STORE, 'readwrite')
      tx.oncomplete = () => {
        try {
          db.close()
        } catch (_) {}
        resolve()
      }
      tx.onerror = () => {
        try {
          db.close()
        } catch (_) {}
        reject(tx.error)
      }
      try {
        tx.objectStore(MM_IDB_STORE).put(String(text), IA_IDB_KEY_RESULT)
      } catch (e) {
        try {
          db.close()
        } catch (_) {}
        reject(e)
      }
    })
  }

  async function iaIdbGetResultJson() {
    const db = await iaIdbOpen()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(MM_IDB_STORE, 'readonly')
      const q = tx.objectStore(MM_IDB_STORE).get(IA_IDB_KEY_RESULT)
      q.onsuccess = () => {
        try {
          db.close()
        } catch (_) {}
        const r = q.result
        resolve(r != null ? String(r) : null)
      }
      q.onerror = () => {
        try {
          db.close()
        } catch (_) {}
        reject(q.error)
      }
    })
  }

  async function iaIdbDeleteImageSession() {
    if (!window.indexedDB) return
    let db
    try {
      db = await iaIdbOpen()
    } catch (_) {
      return
    }
    return new Promise((resolve) => {
      const tx = db.transaction(MM_IDB_STORE, 'readwrite')
      tx.oncomplete = () => {
        try {
          db.close()
        } catch (_) {}
        resolve()
      }
      tx.onerror = () => {
        try {
          db.close()
        } catch (_) {}
        resolve()
      }
      try {
        const st = tx.objectStore(MM_IDB_STORE)
        st.delete(IA_IDB_KEY_FILE)
        st.delete(IA_IDB_KEY_RESULT)
      } catch (_) {
        try {
          db.close()
        } catch (_) {}
        resolve()
      }
    })
  }

  function getMode() {
    const r = document.querySelector('input[name="ia-mode"]:checked')
    return r ? r.value : 'yolo'
  }

  function setBadge() {
    const m = getMode()
    badgeMode.textContent = m === 'yolo' ? 'YOLO 目标检测' : 'OCR 文字提取'
  }

  function revokePreview() {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl)
      previewUrl = null
    }
  }

  function renderPreview() {
    teardownBboxObserver()
    revokePreview()
    if (!currentFile) {
      previewWrap.innerHTML =
        '<div class="ia-preview-placeholder"><i class="fa-solid fa-image"></i><p>上传图片后将在此预览</p></div>'
      btnAnalyze.disabled = true
      updateFileMeta(null)
      return
    }
    previewUrl = URL.createObjectURL(currentFile)
    const inner = document.createElement('span')
    inner.className = 'ia-preview-inner'
    const img = document.createElement('img')
    img.className = 'ia-preview-img'
    img.src = previewUrl
    img.alt = '预览'
    const layer = document.createElement('div')
    layer.id = 'ia-bbox-layer'
    layer.className = 'ia-bbox-layer'
    layer.setAttribute('aria-hidden', 'true')
    inner.appendChild(img)
    inner.appendChild(layer)
    previewWrap.innerHTML = ''
    previewWrap.appendChild(inner)
    btnAnalyze.disabled = false
    updateFileMeta(currentFile)
    setupBboxObserver()
  }

  function setLoading(loading) {
    btnAnalyze.disabled = loading || !currentFile
    if (loading) {
      const tip =
        getMode() === 'ocr'
          ? '正在识别文字（大图会先压缩；含外文时会补充中文释义，可能多等几秒）…'
          : 'YOLO 首次会加载模型，可能需要 10-40 秒，请稍候…'
      resultBody.innerHTML =
        '<div class="ia-loading"><div class="ia-spinner"></div><span>' + tip + '</span></div>'
    }
  }

  function renderError(msg) {
    resultBody.innerHTML = '<div class="ia-error">' + escapeHtml(msg) + '</div>'
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  }

  function formatBytes(n) {
    if (n == null || n < 0) return ''
    if (n < 1024) return n + ' B'
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
    return (n / 1024 / 1024).toFixed(2) + ' MB'
  }

  function showToast(msg) {
    document.querySelectorAll('.ia-toast').forEach((el) => el.remove())
    const el = document.createElement('div')
    el.className = 'ia-toast'
    el.textContent = msg
    document.body.appendChild(el)
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => el.remove(), 2200)
  }

  async function copyClipboard(text, okMsg) {
    const t = String(text || '').trim()
    if (!t) {
      showToast('没有可复制的内容')
      return
    }
    try {
      await navigator.clipboard.writeText(t)
      showToast(okMsg || '已复制')
    } catch (_) {
      showToast('复制失败，请手动选择文本')
    }
  }

  function updateFileMeta(file) {
    if (!fileMetaEl) return
    if (!file) {
      fileMetaEl.hidden = true
      fileMetaEl.textContent = ''
      return
    }
    fileMetaEl.hidden = false
    fileMetaEl.innerHTML =
      '<strong>当前文件</strong> ' +
      escapeHtml(file.name) +
      ' · ' +
      formatBytes(file.size) +
      (file.type ? ' · ' + escapeHtml(file.type) : '')
  }

  function teardownBboxObserver() {
    if (bboxResizeObserver) {
      bboxResizeObserver.disconnect()
      bboxResizeObserver = null
    }
  }

  function setupBboxObserver() {
    teardownBboxObserver()
    const img = document.querySelector('#ia-preview-body .ia-preview-img')
    if (!img) return
    const redraw = () => {
      if (lastYoloDetections && lastYoloDetections.length) drawBboxes(lastYoloDetections)
    }
    if (window.ResizeObserver) {
      bboxResizeObserver = new ResizeObserver(() => redraw())
      bboxResizeObserver.observe(img)
    }
    requestAnimationFrame(redraw)
  }

  function yoloSummaryPlain(list) {
    if (!list || !list.length) return '未检测到目标'
    return list
      .map((d) => {
        const conf = typeof d.confidence === 'number' ? (d.confidence * 100).toFixed(1) + '%' : ''
        return (d.label || 'unknown') + (conf ? '\t' + conf : '')
      })
      .join('\n')
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(r.result)
      r.onerror = () => reject(r.error)
      r.readAsDataURL(file)
    })
  }

  function stripResumeQuery() {
    try {
      const u = new URL(window.location.href)
      if (!u.searchParams.has('mmResume')) return
      u.searchParams.delete('mmResume')
      window.history.replaceState({}, '', u.pathname + u.search + u.hash)
    } catch (_) {}
  }

  function applyModeToUi(mode) {
    const m = mode === 'ocr' ? 'ocr' : 'yolo'
    modeRadios.forEach((radio) => {
      radio.checked = radio.value === m
    })
    document.querySelectorAll('.ia-mode').forEach((label) => {
      const inp = label.querySelector('input')
      label.classList.toggle('ia-mode--selected', inp && inp.checked)
    })
    setBadge()
  }

  async function persistIaSession() {
    try {
      let fileFromIdb = false
      if (currentFile) {
        try {
          await iaIdbPutFile(currentFile)
          fileFromIdb = true
        } catch (e) {
          console.warn('[image] idb file', e)
        }
      }
      let p = {
        v: 2,
        mode: getMode(),
        fileName: currentFile ? currentFile.name : '',
        fileMime: currentFile && currentFile.type ? currentFile.type : 'image/jpeg',
        fileFromIdb: !!fileFromIdb,
        fileDataUrl: null,
        resultInIdb: false,
        lastKind: lastApiSnapshot ? lastApiSnapshot.kind : null,
        lastResult: lastApiSnapshot ? lastApiSnapshot.data : null,
      }
      if (!fileFromIdb && currentFile && currentFile.size <= IA_DATAURL_FALLBACK_MAX) {
        try {
          p.fileDataUrl = await fileToDataUrl(currentFile)
        } catch (_) {}
      }
      let json = JSON.stringify(p)
      if (json.length > IA_SESSION_MAX_CHARS && p.lastResult != null) {
        try {
          await iaIdbPutResultJson(
            JSON.stringify({ lastKind: p.lastKind, lastResult: p.lastResult }),
          )
          p.resultInIdb = true
          p.lastResult = null
          p.lastKind = null
          json = JSON.stringify(p)
        } catch (e) {
          console.warn('[image] idb result', e)
        }
      }
      if (json.length > IA_SESSION_MAX_CHARS) {
        p = { ...p, fileDataUrl: null, lastResult: null, fileFromIdb, resultInIdb: p.resultInIdb }
        json = JSON.stringify(p)
        if (json.length > IA_SESSION_MAX_CHARS) {
          p = { v: 2, mode: p.mode, fileName: p.fileName, fileMime: p.fileMime, fileFromIdb: p.fileFromIdb, fileDataUrl: null, resultInIdb: p.resultInIdb, lastKind: null, lastResult: null }
          json = JSON.stringify(p)
        }
      }
      sessionStorage.setItem(IA_SESSION_KEY, json)
    } catch (e) {
      console.warn('[image] session persist', e)
    }
  }

  function schedulePersistIaSession() {
    clearTimeout(persistSessionTimer)
    persistSessionTimer = setTimeout(() => {
      void persistIaSession()
    }, 450)
  }

  function clearIaSessionStorage() {
    try {
      sessionStorage.removeItem(IA_SESSION_KEY)
    } catch (_) {}
    void iaIdbDeleteImageSession()
    lastApiSnapshot = null
  }

  async function restoreFromSessionPayload(p) {
    if (!p || (p.v !== 1 && p.v !== 2)) return
    applyModeToUi(p.mode != null ? p.mode : 'yolo')
    currentFile = null
    lastYoloDetections = null
    lastApiSnapshot = null
    teardownBboxObserver()
    if (p.v === 2 && p.fileFromIdb) {
      let blob = null
      try {
        blob = await iaIdbGetFile()
      } catch (e) {
        console.warn('[image] idb get file', e)
      }
      if (blob) {
        const name = p.fileName || (blob instanceof File && blob.name) || 'restored.jpg'
        const mime = p.fileMime || blob.type || 'image/jpeg'
        currentFile = blob instanceof File ? blob : new File([blob], name, { type: mime })
      }
    }
    if (!currentFile && p.fileDataUrl && String(p.fileDataUrl).startsWith('data:')) {
      try {
        const res = await fetch(p.fileDataUrl)
        const blob = await res.blob()
        const name = p.fileName || 'restored.jpg'
        const mime = p.fileMime || blob.type || 'image/jpeg'
        currentFile = new File([blob], name, { type: mime })
      } catch (_) {
        currentFile = null
      }
    }
    let lastKind = p.lastKind
    let lastResult = p.lastResult
    if (p.v === 2 && p.resultInIdb) {
      let rs = null
      try {
        rs = await iaIdbGetResultJson()
      } catch (e) {
        console.warn('[image] idb get result', e)
      }
      if (rs) {
        try {
          const o = JSON.parse(rs)
          if (o.lastKind) lastKind = o.lastKind
          if (o.lastResult) lastResult = o.lastResult
        } catch (_) {}
      }
    }
    renderPreview()
    if (lastKind === 'yolo' && lastResult && typeof lastResult === 'object') {
      lastApiSnapshot = { kind: 'yolo', data: lastResult }
      renderYoloResult(lastResult)
    } else if (lastKind === 'ocr' && lastResult && typeof lastResult === 'object') {
      lastApiSnapshot = { kind: 'ocr', data: lastResult }
      renderOcrResult(lastResult)
    } else {
      resultBody.innerHTML =
        '<div class="ia-preview-placeholder"><i class="fa-solid fa-chart-simple"></i><p style="color:#64748b;">分析结果将显示在此</p></div>'
    }
    schedulePersistIaSession()
  }

  function restoreFromHistoryEntry(entry) {
    const d = entry.data || {}
    const mode = d.mode === 'ocr' ? 'ocr' : 'yolo'
    applyModeToUi(mode)
    currentFile = null
    lastYoloDetections = null
    teardownBboxObserver()
    revokePreview()
    fileInput.value = ''
    previewWrap.innerHTML =
      '<div class="ia-preview-placeholder"><i class="fa-solid fa-clock-rotate-left"></i><p><strong>已从历史记录恢复</strong></p><p style="font-size:13px;color:#94a3b8;margin-top:8px;line-height:1.5;">无原始图片预览；可重新上传后再次分析。</p></div>'
    btnAnalyze.disabled = true
    updateFileMeta(null)
    if (mode === 'yolo') {
      const fake = {
        detections: d.detections || [],
        model: d.model,
        elapsedMs: d.elapsedMs,
        backend: d.backend || 'history',
        warning: d.warning,
        yoloMode: d.yoloMode,
        imgsz: d.imgsz,
      }
      lastApiSnapshot = { kind: 'yolo', data: fake }
      renderYoloResult(fake)
    } else {
      const fake = {
        text: d.text,
        textZh: d.textZh,
        textSimplified: d.textSimplified,
        hasTraditionalVariant: d.hasTraditionalVariant,
        textForeignZh: d.textForeignZh,
        textEnglishZh: d.textEnglishZh,
        ocrScript: d.ocrScript,
        engine: d.engine,
        backend: d.backend || 'history',
        elapsedMs: d.elapsedMs,
      }
      lastApiSnapshot = { kind: 'ocr', data: fake }
      renderOcrResult(fake)
    }
    schedulePersistIaSession()
  }

  async function initIaPage() {
    try {
      const params = new URLSearchParams(window.location.search)
      const rid = params.get('mmResume')
      if (rid && window.mmHistory) {
        const e = window.mmHistory.getEntry(rid)
        if (e && e.module === 'image') {
          restoreFromHistoryEntry(e)
          stripResumeQuery()
          return
        }
      }
    } catch (e) {
      console.warn('[image] resume from history', e)
    }
    const raw = sessionStorage.getItem(IA_SESSION_KEY)
    if (raw) {
      try {
        const p = JSON.parse(raw)
        if (p && (p.v === 1 || p.v === 2)) {
          await restoreFromSessionPayload(p)
          return
        }
      } catch (e) {
        console.warn('[image] session restore', e)
      }
    }
    setBadge()
    renderPreview()
    resultBody.innerHTML =
      '<div class="ia-preview-placeholder"><i class="fa-solid fa-chart-simple"></i><p style="color:#64748b;">分析结果将显示在此</p></div>'
  }

  function saveImageHistory(mode, data) {
    if (!window.mmHistory || !currentFile) return
    try {
      if (mode === 'yolo') {
        const list = data.detections || []
        const snippet =
          list.length > 0
            ? list
                .slice(0, 14)
                .map((d) =>
                  (d.label || '') +
                  (typeof d.confidence === 'number' ? ' ' + (d.confidence * 100).toFixed(0) + '%' : ''),
                )
                .join('；')
            : '未检测到目标'
        window.mmHistory.appendEntry({
          module: 'image',
          title: '图片 · YOLO · ' + currentFile.name,
          snippet: snippet,
          data: {
            mode: 'yolo',
            fileName: currentFile.name,
            detections: list,
            model: data.model,
            elapsedMs: data.elapsedMs,
          },
        })
      } else {
        const text = data.text || ''
        window.mmHistory.appendEntry({
          module: 'image',
          title: '图片 · OCR · ' + currentFile.name,
          snippet: text.slice(0, 2000),
          data: {
            mode: 'ocr',
            fileName: currentFile.name,
            text: data.text,
            textZh: data.textZh,
            textSimplified: data.textSimplified,
            textForeignZh: data.textForeignZh,
            textEnglishZh: data.textEnglishZh,
            engine: data.engine,
            elapsedMs: data.elapsedMs,
          },
        })
      }
    } catch (e) {
      console.warn('[image] history', e)
    }
  }

  /**
   * 大图/大文件在本地压成 JPEG 再传，降低偶发 net::ERR_CONNECTION_RESET（上传中断、内存尖峰）。
   * @param {'yolo'|'ocr'} mode OCR 使用更小边长与更低质量，优先保证能传上去。
   */
  function prepareImageForUpload(file, mode) {
    return new Promise((resolve) => {
      if (!file || !file.type.startsWith('image/') || file.type === 'image/svg+xml') {
        resolve(file)
        return
      }
      const isOcr = mode === 'ocr'
      const maxEdge = isOcr ? OCR_MAX_EDGE : YOLO_MAX_EDGE
      const maxBytes = isOcr ? OCR_MAX_BYTES : YOLO_MAX_BYTES
      const quality = isOcr ? 0.78 : 0.88

      const objectUrl = URL.createObjectURL(file)
      const img = new Image()
      img.onload = () => {
        URL.revokeObjectURL(objectUrl)
        const w = img.naturalWidth
        const h = img.naturalHeight
        const needResize = w > maxEdge || h > maxEdge || file.size > maxBytes
        if (!needResize) {
          resolve(file)
          return
        }

        const base = (file.name || 'image').replace(/\.[^.]+$/, '')
        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d')

        const drawAndBlob = (scaleFactor, q) => {
          const cw = Math.max(1, Math.round(w * scaleFactor))
          const ch = Math.max(1, Math.round(h * scaleFactor))
          canvas.width = cw
          canvas.height = ch
          ctx.drawImage(img, 0, 0, cw, ch)
          canvas.toBlob(
            (blob) => {
              if (!blob) {
                resolve(file)
                return
              }
              if (isOcr && blob.size > OCR_MAX_BLOB && scaleFactor > 0.38) {
                drawAndBlob(scaleFactor * 0.82, Math.max(0.55, q * 0.92))
                return
              }
              resolve(new File([blob], base + '-ia.jpg', { type: 'image/jpeg' }))
            },
            'image/jpeg',
            q,
          )
        }

        const initialScale = Math.min(maxEdge / w, maxEdge / h, 1)
        drawAndBlob(initialScale, quality)
      }
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl)
        resolve(file)
      }
      img.src = objectUrl
    })
  }

  function isTransientNetworkError(err) {
    const msg = String(err && err.message != null ? err.message : err)
    return (
      msg.includes('Failed to fetch') ||
      msg.includes('NetworkError') ||
      msg.includes('CONNECTION_RESET') ||
      msg.includes('Network request failed')
    )
  }

  async function postMultipart(url, buildForm, uploadFile) {
    const fileToSend = uploadFile || currentFile
    const runOnce = async () => {
      const fd = new FormData()
      fd.append('file', fileToSend)
      buildForm(fd)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      let res
      try {
        res = await fetch(url, { method: 'POST', body: fd, signal: controller.signal })
      } catch (e) {
        if (e && e.name === 'AbortError') {
          throw new Error('请求超时（约10分钟），首次可能含模型下载，请稍后重试或查看后端日志')
        }
        throw e
      } finally {
        clearTimeout(timer)
      }
      if (!res.ok) {
        let detail = 'HTTP ' + res.status
        try {
          const t = await res.text()
          if (t) {
            try {
              const j = JSON.parse(t)
              if (j.msg != null && String(j.msg).trim()) detail = String(j.msg)
              else if (j.message != null && String(j.message).trim()) detail = String(j.message)
              else if (typeof j.error === 'string' && j.error.trim()) detail = j.error
              else if (j.error && j.error.message) detail = String(j.error.message)
            } catch (_) {
              if (t.length < 480) detail = t.trim() || detail
            }
          }
        } catch (_) {}
        throw new Error(detail)
      }
      let data
      try {
        data = await res.json()
      } catch (e) {
        throw new Error('无法解析服务器响应：' + (e.message || e))
      }
      if (data && typeof data.code === 'number' && data.code !== 200) {
        throw new Error(data.msg || '后端返回失败')
      }
      if (data && data.error) {
        throw new Error(String(data.error))
      }
      return data
    }

    try {
      return await runOnce()
    } catch (first) {
      if (!isTransientNetworkError(first)) throw first
      await new Promise((r) => setTimeout(r, 500))
      return runOnce()
    }
  }

  function drawBboxes(detections) {
    const layer = document.getElementById('ia-bbox-layer')
    if (!layer) return
    layer.innerHTML = ''
    if (!detections || !detections.length) return
    detections.forEach((d) => {
      const box = Array.isArray(d.box) && d.box.length >= 4 ? d.box : null
      if (!box) return
      const el = document.createElement('div')
      el.className = 'ia-bbox-rect'
      el.style.left = box[0] + '%'
      el.style.top = box[1] + '%'
      el.style.width = box[2] + '%'
      el.style.height = box[3] + '%'
      const c = typeof d.confidence === 'number' ? (d.confidence * 100).toFixed(0) + '%' : ''
      el.title = (d.label || 'obj') + (c ? ' ' + c : '')
      const cap = document.createElement('span')
      cap.className = 'ia-bbox-label'
      cap.textContent = (d.label || 'obj') + (c ? ' ' + c : '')
      el.appendChild(cap)
      layer.appendChild(el)
    })
  }

  function renderYoloResult(data) {
    const list = data.detections || []
    lastYoloDetections = list
    drawBboxes(list)
    clipboardPayload.yolo = yoloSummaryPlain(list)
    const parts = []
    parts.push('<div class="ia-result-inner">')
    parts.push('<div class="ia-result-toolbar">')
    parts.push(
      '<button type="button" class="ia-btn ia-btn-ghost ia-btn-small" id="ia-btn-copy-yolo"><i class="fa-regular fa-copy"></i> 复制检测摘要</button>',
    )
    parts.push('</div>')
    parts.push('<div class="ia-det-list">')
    if (!list.length) {
      parts.push(
        '<p class="ia-yolo-empty">未检测到目标。</p>' +
          '<p class="ia-yolo-hint">说明：当前使用 COCO 数据集的常见类别（人、车、动物等）。若图片主要是标语、艺术字或徽标，可能没有对应类别；请切换到左侧「<strong>OCR 文字提取</strong>」识别文字内容。</p>',
      )
    } else {
      list.forEach((d) => {
        const conf =
          typeof d.confidence === 'number' ? (d.confidence * 100).toFixed(1) + '%' : '—'
        const box = Array.isArray(d.box) ? d.box.map((n) => Math.round(n)).join(', ') : '—'
        parts.push(
          '<div class="ia-det-item">' +
            '<span><span class="ia-tag">' +
            escapeHtml(d.label || 'unknown') +
            '</span></span>' +
            '<span class="ia-confidence">置信度 ' +
            conf +
            '</span></div>' +
            '<div style="font-size:11px;color:#64748b;margin:-6px 0 10px 4px;">bbox: [' +
            box +
            ']</div>',
        )
      })
    }
    parts.push('</div>')
    if (data.warning) {
      parts.push(
        '<p class="ia-yolo-hint" style="margin-top:12px;color:#fbbf24;">' +
          escapeHtml(String(data.warning)) +
          '</p>',
      )
    }
    const source = data.backend ? '来源：' + escapeHtml(String(data.backend)) : ''
    const model = data.model ? '模型：' + escapeHtml(String(data.model)) : ''
    const mode = data.yoloMode ? '模式：' + escapeHtml(String(data.yoloMode)) : ''
    const isz = typeof data.imgsz === 'number' ? '边长：' + data.imgsz : ''
    const elapsed = typeof data.elapsedMs === 'number' ? '耗时：' + Math.round(data.elapsedMs) + 'ms' : ''
    const meta = [model, mode, isz, source, elapsed].filter(Boolean).join(' · ')
    if (meta) parts.push('<p class="ia-note" style="margin-top:14px;">' + meta + '</p>')
    parts.push('</div>')
    resultBody.innerHTML = parts.join('')
    setupBboxObserver()
  }

  function renderOcrResult(data) {
    lastYoloDetections = null
    drawBboxes([])
    const text = data.text || ''
    const showText = text && text.trim() ? text : '未识别到文本。建议上传文字更清晰、占比更高的图片（如文档截图、表单、证书近景）。'
    const hasTrad = data.hasTraditionalVariant === true && data.textSimplified
    const hasZh = data.textZh && String(data.textZh).trim()
    const foreignZhRaw = data.textForeignZh || data.textEnglishZh
    const foreignZh = foreignZhRaw && String(foreignZhRaw).trim()
    const hasForeignZh = !!foreignZh

    const foreignZhHtml =
      hasForeignZh ?
        '<p class="ia-ocr-caption ia-ocr-caption--en"><i class="fa-solid fa-language" aria-hidden="true"></i> 外文内容 · 中文释义</p>' +
        '<pre class="ia-ocr-text ia-ocr-text--en">' +
        escapeHtml(String(foreignZh)) +
        '</pre>'
      : ''

    if (hasTrad) {
      clipboardPayload.ocr = text + '\n\n—— 简体 ——\n\n' + String(data.textSimplified)
    } else if (hasZh) {
      clipboardPayload.ocr = showText + '\n\n—— 中文 ——\n\n' + String(data.textZh)
    } else {
      clipboardPayload.ocr = showText
    }
    if (hasForeignZh) {
      clipboardPayload.ocr += '\n\n—— 外文内容 · 中文释义 ——\n\n' + String(foreignZh)
    }

    let html = '<div class="ia-result-inner">'
    html +=
      '<div class="ia-result-toolbar">' +
      '<button type="button" class="ia-btn ia-btn-ghost ia-btn-small" id="ia-btn-copy-ocr"><i class="fa-regular fa-copy"></i> 复制全部文字</button>' +
      '</div>'
    if (hasTrad) {
      html +=
        '<p class="ia-ocr-caption">原文</p><pre class="ia-ocr-text">' +
        escapeHtml(text) +
        '</pre>'
      html +=
        '<p class="ia-ocr-caption" style="margin-top:14px;">简体</p><pre class="ia-ocr-text">' +
        escapeHtml(String(data.textSimplified)) +
        '</pre>'
      html += foreignZhHtml
    } else if (hasZh) {
      html +=
        '<p class="ia-ocr-caption">原文</p><pre class="ia-ocr-text">' +
        escapeHtml(showText) +
        '</pre>'
      html +=
        '<p class="ia-ocr-caption" style="margin-top:14px;">中文翻译</p><pre class="ia-ocr-text">' +
        escapeHtml(String(data.textZh)) +
        '</pre>'
      html += foreignZhHtml
    } else {
      html += '<pre class="ia-ocr-text">' + escapeHtml(showText) + '</pre>'
      html += foreignZhHtml
    }
    const ocrScript = (data.ocrScript && String(data.ocrScript).trim()) || ''
    const shouldHaveTranslation =
      !!text.trim() &&
      !hasZh &&
      !hasForeignZh &&
      (ocrScript === 'translate' || ocrScript === 'cjk')
    if (shouldHaveTranslation) {
      html +=
        '<p class="ia-ocr-miss-translation"><i class="fa-solid fa-circle-info" aria-hidden="true"></i> ' +
        '未显示中文译文。请确认 <code>application.yml</code> 中已配置 <code>deepseek.api.key</code> 且 ' +
        '<code>multimodal.vision.ocr-translate-enabled</code> 为 true；用 <code>start-all.bat</code> 前请先执行 ' +
        '<code>mvn package -DskipTests</code> 再打 JAR。仍无时请查看运行 Spring Boot 的黑窗口日志中是否有翻译请求报错。</p>'
    }

    const source = data.backend ? '来源：' + escapeHtml(String(data.backend)) : ''
    const engine = data.engine ? '引擎：' + escapeHtml(String(data.engine)) : ''
    const elapsed = typeof data.elapsedMs === 'number' ? '耗时：' + Math.round(data.elapsedMs) + 'ms' : ''
    const meta = [engine, source, elapsed].filter(Boolean).join(' · ')
    if (meta) html += '<p class="ia-note" style="margin-top:12px;">' + meta + '</p>'
    html += '</div>'
    resultBody.innerHTML = html
  }

  async function analyze() {
    if (!currentFile) return
    setLoading(true)
    const mode = getMode()
    let uploadFile = currentFile
    try {
      uploadFile = await prepareImageForUpload(currentFile, mode)
    } catch (_) {
      uploadFile = currentFile
    }
    const longWaitTip = setTimeout(() => {
      if (!btnAnalyze.disabled) return
      const warn = document.createElement('p')
      warn.style.cssText = 'margin-top:10px;color:#94a3b8;font-size:12px;'
      warn.textContent = '仍在处理中，可切换小图再次测试，或查看后端控制台日志。'
      const loadingEl = resultBody.querySelector('.ia-loading')
      if (loadingEl && !loadingEl.querySelector('.ia-warn-tip')) {
        warn.className = 'ia-warn-tip'
        loadingEl.appendChild(warn)
      }
    }, 15000)
    try {
      if (getMode() === 'yolo') {
        const data = await postMultipart(API_YOLO, (fd) => fd.append('mode', 'yolo'), uploadFile)
        renderYoloResult(data)
        saveImageHistory('yolo', data)
        lastApiSnapshot = { kind: 'yolo', data: data }
        schedulePersistIaSession()
      } else {
        const data = await postMultipart(API_OCR, (fd) => fd.append('lang', 'ch'), uploadFile)
        renderOcrResult(data)
        saveImageHistory('ocr', data)
        lastApiSnapshot = { kind: 'ocr', data: data }
        schedulePersistIaSession()
      }
    } catch (e) {
      renderError('分析失败：' + (e.message || e) + '。请查看后端日志并重试。')
    } finally {
      clearTimeout(longWaitTip)
      setLoading(false)
    }
  }

  function onFile(f) {
    if (!f || !f.type.startsWith('image/')) {
      alert('请选择图片文件（如 PNG、JPG、WebP）')
      return
    }
    currentFile = f
    lastYoloDetections = null
    renderPreview()
    resultBody.innerHTML =
      '<div class="ia-preview-placeholder" style="padding:24px;"><p style="color:#64748b;font-size:14px;">点击「开始分析」进行识别</p></div>'
    schedulePersistIaSession()
  }

  function clearAll() {
    clearIaSessionStorage()
    currentFile = null
    lastYoloDetections = null
    teardownBboxObserver()
    fileInput.value = ''
    revokePreview()
    renderPreview()
    resultBody.innerHTML =
      '<div class="ia-preview-placeholder"><i class="fa-solid fa-chart-simple"></i><p style="color:#64748b;">分析结果将显示在此</p></div>'
  }

  // 拖拽
  ;['dragenter', 'dragover', 'dragleave', 'drop'].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
  })
  dropzone.addEventListener('dragenter', () => dropzone.classList.add('ia-dropzone--active'))
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('ia-dropzone--active'))
  dropzone.addEventListener('drop', (e) => {
    dropzone.classList.remove('ia-dropzone--active')
    const f = e.dataTransfer.files && e.dataTransfer.files[0]
    if (f) onFile(f)
  })

  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0]
    if (f) onFile(f)
  })

  btnAnalyze.addEventListener('click', analyze)
  btnClear.addEventListener('click', clearAll)

  modeRadios.forEach((r) => {
    r.addEventListener('change', () => {
      lastYoloDetections = null
      lastApiSnapshot = null
      document.querySelectorAll('.ia-mode').forEach((label) => {
        const inp = label.querySelector('input')
        label.classList.toggle('ia-mode--selected', inp && inp.checked)
      })
      setBadge()
      drawBboxes([])
      resultBody.innerHTML =
        '<div class="ia-preview-placeholder" style="padding:20px;"><p style="color:#64748b;font-size:13px;">已切换模式，请重新「开始分析」</p></div>'
      schedulePersistIaSession()
    })
  })

  resultBody.addEventListener('click', (e) => {
    if (e.target.closest('#ia-btn-copy-ocr')) {
      e.preventDefault()
      copyClipboard(clipboardPayload.ocr, '已复制 OCR 文字')
    }
    if (e.target.closest('#ia-btn-copy-yolo')) {
      e.preventDefault()
      copyClipboard(clipboardPayload.yolo, '已复制检测摘要')
    }
  })

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.ctrlKey) return
    const tag = e.target && e.target.tagName
    if (tag === 'TEXTAREA' || tag === 'INPUT') return
    if (!currentFile || btnAnalyze.disabled) return
    e.preventDefault()
    analyze()
  })

  if (btnAnalyze) btnAnalyze.title = '分析当前图片（快捷键 Ctrl+Enter）'

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      void persistIaSession()
    }
  })

  void initIaPage()
})()
