/**
 * audio.html：上传音频 / 麦克风录音上传 + faster-whisper 转写 + DeepSeek 翻译与总结
 * POST /api/audio/transcribe  ·  GET /chat
 */
;(function () {
  const API_BASE =
    typeof window.mmResolveApiBase === 'function' ? window.mmResolveApiBase() : window.location.protocol === 'file:' ? 'http://127.0.0.1:8081' : ''
  const API_AUDIO_TRANSCRIBE = `${API_BASE}/api/audio/transcribe`
  const userId = 'default'
  const REQUEST_TIMEOUT_MS = 620000
  const MAX_RECORD_MS = 120000
  /** 人声更适合用时域电平；过低时波形条会「看起来没动」 */
  const MIC_MIN_BLOB_BYTES = 2500

  const dropzone = document.getElementById('ap-dropzone')
  const fileInput = document.getElementById('ap-file-input')
  const audioPlayer = document.getElementById('ap-audio-player')
  const audioWrap = document.getElementById('ap-audio-player-wrap')

  const btnMic = document.getElementById('ap-btn-mic')
  const langSelect = document.getElementById('ap-lang-select')
  const micStatus = document.getElementById('ap-mic-status')

  const btnTranscribe = document.getElementById('ap-btn-transcribe')
  const btnTranslate = document.getElementById('ap-btn-translate')
  const btnSummary = document.getElementById('ap-btn-summary')
  const btnClear = document.getElementById('ap-btn-clear')
  const badge = document.getElementById('ap-header-badge')

  const originalTextEl = document.getElementById('ap-original-text')
  const translateTextEl = document.getElementById('ap-translate-text')
  const summaryTextEl = document.getElementById('ap-summary-text')
  const summaryModeEl = document.getElementById('ap-summary-mode')
  const summaryHintEl = document.getElementById('ap-summary-hint')

  const loadingOriginal = document.getElementById('ap-original-loading')
  const loadingTranslate = document.getElementById('ap-translate-loading')
  const loadingSummary = document.getElementById('ap-summary-loading')

  const micMeterWrap = document.getElementById('ap-mic-meter-wrap')
  const micCanvas = document.getElementById('ap-mic-canvas')

  let currentFile = null
  let previewUrl = null

  let mediaRecorder = null
  let recordChunks = []
  let recordStream = null
  let recording = false
  let recordTimer = null
  let recordStartedAt = 0

  let micAudioContext = null
  let micAnalyser = null
  let micRafId = null
  let micSourceNode = null
  /** 与 recording 解耦：须先于 draw() 置 true，否则首帧会因 recording 仍为 false 而永远不启动动画 */
  let micVizRunning = false

  const AP_SESSION_KEY = 'mm_audio_session_v1'
  const AP_SESSION_MAX_CHARS = 2400000
  /** 长音频/长转写会撑爆 sessionStorage，文件与整段文字进 IndexedDB */
  const MM_IDB_NAME = 'mm_multimodal_v1'
  const MM_IDB_STORE = 'files'
  const AP_IDB_KEY_FILE = 'audio_session_blob'
  const AP_IDB_KEY_TEXTS = 'audio_session_texts_json'

  function apIdbOpen() {
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

  async function apIdbPutFile(file) {
    const db = await apIdbOpen()
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
        tx.objectStore(MM_IDB_STORE).put(file, AP_IDB_KEY_FILE)
      } catch (e) {
        try {
          db.close()
        } catch (_) {}
        reject(e)
      }
    })
  }

  async function apIdbGetFile() {
    const db = await apIdbOpen()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(MM_IDB_STORE, 'readonly')
      const q = tx.objectStore(MM_IDB_STORE).get(AP_IDB_KEY_FILE)
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

  async function apIdbPutTextsJson(s) {
    const db = await apIdbOpen()
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
        tx.objectStore(MM_IDB_STORE).put(String(s), AP_IDB_KEY_TEXTS)
      } catch (e) {
        try {
          db.close()
        } catch (_) {}
        reject(e)
      }
    })
  }

  async function apIdbGetTextsJson() {
    const db = await apIdbOpen()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(MM_IDB_STORE, 'readonly')
      const q = tx.objectStore(MM_IDB_STORE).get(AP_IDB_KEY_TEXTS)
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

  async function apIdbDeleteAudioSession() {
    if (!window.indexedDB) return
    let db
    try {
      db = await apIdbOpen()
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
        st.delete(AP_IDB_KEY_FILE)
        st.delete(AP_IDB_KEY_TEXTS)
      } catch (_) {
        try {
          db.close()
        } catch (_) {}
        resolve()
      }
    })
  }

  /** 自动增益/降噪在多数设备上有利于收音与电平可见性 */
  const MIC_AUDIO_CONSTRAINTS = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  }

  function formatTranscribeOutput(data) {
    const core = String(data.text || data.transcript || '').trim()
    const warn = data.warning
    const note = data.note
    const chunks = []
    if (core) chunks.push(core)
    if (!core && note) chunks.push(note)
    if (!core && !note && !warn) {
      chunks.push(
        '未识别到语音内容。请大声说话、靠近麦克风，或延长录音 3～5 秒；若电平条几乎不动，请在 Windows「声音设置」里调高输入音量或换用耳麦。',
      )
    }
    if (warn) chunks.push('【提示】' + warn)
    return chunks.join('\n\n')
  }

  function setBadge(text) {
    badge.textContent = text
  }

  function setLoading(target, val) {
    target.classList.toggle('ap-hidden', !val)
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  }

  function setOutput(el, text) {
    el.innerHTML = escapeHtml(text || '')
  }

  function stripResumeQuery() {
    try {
      const u = new URL(window.location.href)
      if (!u.searchParams.has('mmResume')) return
      u.searchParams.delete('mmResume')
      window.history.replaceState({}, '', u.pathname + u.search + u.hash)
    } catch (_) {}
  }

  async function persistAudioSessionImpl() {
    try {
      const o = (originalTextEl.textContent || '').trim()
      const t = (translateTextEl.textContent || '').trim()
      const s = summaryTextEl ? (summaryTextEl.textContent || '').trim() : ''
      let fileFromIdb = false
      if (currentFile) {
        try {
          await apIdbPutFile(currentFile)
          fileFromIdb = true
        } catch (e) {
          console.warn('[audio] idb file', e)
        }
      }
      let p = {
        v: 2,
        lang: langSelect ? langSelect.value : 'zh-CN',
        summaryMode: summaryModeEl ? summaryModeEl.value : 'auto',
        fileName: currentFile ? currentFile.name : '',
        fileMime: currentFile && currentFile.type ? currentFile.type : 'audio/mpeg',
        fileFromIdb: !!fileFromIdb,
        textsInIdb: false,
        original: o,
        translated: t,
        summary: s,
      }
      let json = JSON.stringify(p)
      if (json.length > AP_SESSION_MAX_CHARS) {
        try {
          await apIdbPutTextsJson(JSON.stringify({ original: o, translated: t, summary: s }))
          p.textsInIdb = true
          p.original = ''
          p.translated = ''
          p.summary = ''
          json = JSON.stringify(p)
        } catch (e) {
          console.warn('[audio] idb texts', e)
        }
      }
      sessionStorage.setItem(AP_SESSION_KEY, json)
    } catch (e) {
      console.warn('[audio] session persist', e)
    }
  }

  function persistAudioSession() {
    void persistAudioSessionImpl()
  }

  function clearAudioSession() {
    try {
      sessionStorage.removeItem(AP_SESSION_KEY)
    } catch (_) {}
    void apIdbDeleteAudioSession()
  }

  async function restoreAudioSessionPayload(p) {
    if (!p) return
    if (p.v === 1) {
      if (langSelect && p.lang) langSelect.value = p.lang
      if (summaryModeEl && p.summaryMode) summaryModeEl.value = p.summaryMode
      if (p.original && !/^识别原文将在此显示/.test(p.original)) setOutput(originalTextEl, p.original)
      if (p.translated && !/^翻译结果将在此显示/.test(p.translated)) setOutput(translateTextEl, p.translated)
      if (summaryTextEl && p.summary && !/^选择「总结对象」/.test(p.summary)) setOutput(summaryTextEl, p.summary)
      applySummaryModeHint()
      return
    }
    if (p.v !== 2) return
    if (langSelect && p.lang) langSelect.value = p.lang
    if (summaryModeEl && p.summaryMode) summaryModeEl.value = p.summaryMode
    if (p.fileFromIdb) {
      let blob = null
      try {
        blob = await apIdbGetFile()
      } catch (e) {
        console.warn('[audio] idb get file', e)
      }
      if (blob) {
        const name = p.fileName || (blob instanceof File && blob.name) || 'audio.mp3'
        const mime = p.fileMime || blob.type || 'audio/mpeg'
        currentFile = blob instanceof File ? blob : new File([blob], name, { type: mime })
        renderAudioPreview()
      }
    }
    let o = p.original
    let t = p.translated
    let s = p.summary
    if (p.textsInIdb) {
      let raw = null
      try {
        raw = await apIdbGetTextsJson()
      } catch (e) {
        console.warn('[audio] idb get texts', e)
      }
      if (raw) {
        try {
          const x = JSON.parse(raw)
          if (x.original != null) o = x.original
          if (x.translated != null) t = x.translated
          if (x.summary != null) s = x.summary
        } catch (_) {}
      }
    }
    if (o && !/^识别原文将在此显示/.test(String(o))) setOutput(originalTextEl, o)
    if (t && !/^翻译结果将在此显示/.test(String(t))) setOutput(translateTextEl, t)
    if (summaryTextEl && s && !/^选择「总结对象」/.test(String(s))) setOutput(summaryTextEl, s)
    applySummaryModeHint()
  }

  function restoreAudioFromHistoryEntry(entry) {
    const d = entry.data || {}
    if (langSelect && d.lang) langSelect.value = d.lang
    if (d.original) setOutput(originalTextEl, d.original)
    if (d.translated) setOutput(translateTextEl, d.translated)
    if (d.summary && summaryTextEl) setOutput(summaryTextEl, d.summary)
    applySummaryModeHint()
    setBadge('已从历史记录恢复（无音频文件，可重新上传）')
    persistAudioSession()
  }

  async function initApPage() {
    try {
      const rid = new URLSearchParams(window.location.search).get('mmResume')
      if (rid && window.mmHistory) {
        const e = window.mmHistory.getEntry(rid)
        if (e && e.module === 'audio') {
          restoreAudioFromHistoryEntry(e)
          stripResumeQuery()
          return
        }
      }
    } catch (e) {
      console.warn('[audio] resume', e)
    }
    try {
      const raw = sessionStorage.getItem(AP_SESSION_KEY)
      if (raw) {
        const p = JSON.parse(raw)
        if (p && (p.v === 1 || p.v === 2)) {
          await restoreAudioSessionPayload(p)
        }
      }
    } catch (_) {}
  }

  function getOriginalText() {
    return (originalTextEl.textContent || '').trim()
  }

  /** 去掉占位/失败提示块，避免把「【提示】pip install…」等送进翻译与总结 */
  function getTranscriptForAi() {
    let t = getOriginalText()
    const mark = '\n\n【提示】'
    const i = t.indexOf(mark)
    if (i >= 0) t = t.slice(0, i)
    return t.trim()
  }

  function getTranslatedText() {
    return (translateTextEl.textContent || '').trim()
  }

  function sliceSnippet(s, n) {
    return String(s || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, n || 400)
  }

  /** 成功完成转写/翻译/总结后写入本地历史（需先引入 mm-history.js） */
  function saveAudioHistory(action, extra) {
    if (!window.mmHistory) return
    try {
      const orig = getTranscriptForAi()
      const trans = (translateTextEl.textContent || '').trim()
      const summ = summaryTextEl ? (summaryTextEl.textContent || '').trim() : ''
      let snippet = ''
      if (action === 'transcribe') snippet = sliceSnippet(orig, 1800)
      else if (action === 'translate') snippet = sliceSnippet(trans, 1800)
      else snippet = sliceSnippet(summ, 1800)
      const titleHint = sliceSnippet(orig, 40) || sliceSnippet(trans, 40) || '无摘要'
      window.mmHistory.appendEntry({
        module: 'audio',
        title: '音频 · ' + action + ' · ' + titleHint,
        snippet: snippet,
        data: Object.assign(
          { action: action, lang: langSelect ? langSelect.value : '' },
          extra || {},
          { original: orig, translated: trans, summary: summ },
        ),
      })
    } catch (e) {
      console.warn('[audio] history', e)
    }
  }

  function clearPreviewUrl() {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl)
      previewUrl = null
    }
  }

  function renderAudioPreview() {
    if (!currentFile) {
      clearPreviewUrl()
      audioPlayer.removeAttribute('src')
      audioPlayer.load()
      audioWrap.style.opacity = '0.5'
      return
    }
    clearPreviewUrl()
    previewUrl = URL.createObjectURL(currentFile)
    audioPlayer.src = previewUrl
    audioWrap.style.opacity = '1'
  }

  function onFileSelected(file) {
    if (!file) return
    if (!file.type.startsWith('audio/') && !/\.(mp3|wav|m4a|webm|ogg)$/i.test(file.name)) {
      alert('请选择音频文件（mp3/wav/m4a/webm 等）')
      return
    }
    currentFile = file
    renderAudioPreview()
    setBadge('已加载音频文件')
  }

  function pickRecorderMime() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
    ]
    for (let i = 0; i < candidates.length; i++) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(candidates[i])) {
        return candidates[i]
      }
    }
    return ''
  }

  async function postAudio(file, lang) {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('lang', lang || 'zh-CN')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let res
    try {
      res = await fetch(API_AUDIO_TRANSCRIBE, { method: 'POST', body: fd, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) {
      const t = await res.text()
      throw new Error('HTTP ' + res.status + (t ? ': ' + t.slice(0, 200) : ''))
    }
    return res.json()
  }

  /**
   * ChatController 返回 Result：{ code, msg, data }
   * 使用 POST，避免长转写文本在 GET 查询串中超长被截断。
   */
  async function callChat(prompt) {
    const body = new URLSearchParams()
    body.set('msg', prompt)
    body.set('userId', userId)
    const res = await fetch(`${API_BASE}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body,
    })
    const data = await res.json()
    if (typeof data.code === 'number' && data.code !== 200) {
      throw new Error(data.msg || '请求失败')
    }
    if (data.data != null && data.data !== '') {
      return String(data.data)
    }
    return data.msg ? String(data.msg) : ''
  }

  function stopRecordingStream() {
    if (recordStream) {
      recordStream.getTracks().forEach((t) => t.stop())
      recordStream = null
    }
  }

  function stopMicVisualizer() {
    micVizRunning = false
    if (micRafId != null) {
      cancelAnimationFrame(micRafId)
      micRafId = null
    }
    try {
      if (micSourceNode) {
        micSourceNode.disconnect()
        micSourceNode = null
      }
    } catch (_) {}
    micAnalyser = null
    if (micAudioContext) {
      micAudioContext.close().catch(() => {})
      micAudioContext = null
    }
    if (micMeterWrap) micMeterWrap.classList.remove('ap-mic-meter--active')
    if (micCanvas) {
      const ctx = micCanvas.getContext('2d')
      if (ctx) ctx.clearRect(0, 0, micCanvas.width, micCanvas.height)
    }
  }

  /** 录音时用 AnalyserNode 绘制频谱条，便于确认麦克风有输入 */
  async function startMicVisualizer(stream) {
    stopMicVisualizer()
    if (!micCanvas || !stream) return
    const AudioCtx = window.AudioContext || window.webkitAudioContext
    if (!AudioCtx) return
    try {
      micAudioContext = new AudioCtx()
      if (micAudioContext.state === 'suspended') {
        await micAudioContext.resume()
      }
      micAnalyser = micAudioContext.createAnalyser()
      micAnalyser.fftSize = 1024
      micAnalyser.smoothingTimeConstant = 0.45
      micSourceNode = micAudioContext.createMediaStreamSource(stream)
      micSourceNode.connect(micAnalyser)

      const ctx = micCanvas.getContext('2d')
      const dpr = window.devicePixelRatio || 1
      const rect = micCanvas.getBoundingClientRect()
      const layoutW = rect.width > 2 ? rect.width : (micCanvas.clientWidth || micCanvas.offsetWidth || 280)
      micCanvas.width = Math.floor(layoutW * dpr)
      micCanvas.height = Math.floor(56 * dpr)
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.scale(dpr, dpr)

      const w = layoutW
      const h = 56
      const barCount = 36
      const timeData = new Uint8Array(micAnalyser.fftSize)

      function draw() {
        if (!micVizRunning || !micAnalyser) return
        micRafId = requestAnimationFrame(draw)
        micAnalyser.getByteTimeDomainData(timeData)
        ctx.clearRect(0, 0, w, h)
        const seg = Math.max(1, Math.floor(timeData.length / barCount))
        for (let i = 0; i < barCount; i++) {
          let sum = 0
          const base = i * seg
          const end = Math.min(timeData.length, base + seg)
          for (let j = base; j < end; j++) {
            const z = (timeData[j] - 128) / 128
            sum += z * z
          }
          const rms = Math.sqrt(sum / Math.max(1, end - base))
          const v = Math.min(1, rms * 5.2)
          const bh = Math.max(3, v * h * 0.94)
          const bw = (w / barCount) * 0.62
          const x = (i / barCount) * w + (w / barCount - bw) / 2
          const y = h - bh
          const g = ctx.createLinearGradient(0, y, 0, h)
          g.addColorStop(0, '#7dd3fc')
          g.addColorStop(0.5, '#38bdf8')
          g.addColorStop(1, '#1d4ed8')
          ctx.fillStyle = g
          ctx.fillRect(x, y, bw, bh)
        }
      }
      if (micMeterWrap) micMeterWrap.classList.add('ap-mic-meter--active')
      micVizRunning = true
      draw()
    } catch (e) {
      console.warn('[audio] mic visualizer:', e)
    }
  }

  async function finishRecordingAndTranscribe() {
    if (!mediaRecorder || mediaRecorder.state !== 'recording') return
    if (recordTimer) {
      clearTimeout(recordTimer)
      recordTimer = null
    }
    micStatus.textContent = '正在上传并识别…'
    setBadge('正在转写录音…')
    setLoading(loadingOriginal, true)

    return new Promise((resolve, reject) => {
      mediaRecorder.onstop = async () => {
        recording = false
        stopMicVisualizer()
        updateMicButton()
        micStatus.classList.remove('recording')
        const mime = mediaRecorder.mimeType || 'audio/webm'
        stopRecordingStream()
        const blob = new Blob(recordChunks, { type: mime })
        recordChunks = []
        mediaRecorder = null
        if (blob.size < MIC_MIN_BLOB_BYTES) {
          setLoading(loadingOriginal, false)
          micStatus.textContent = '录音过短或几乎无声，请多录几秒并提高说话音量'
          setBadge('录音无效')
          setOutput(
            originalTextEl,
            '录音数据过小（' + blob.size + ' 字节），无法转写。请延长录音至几秒并确认麦克风有输入、系统输入音量不为 0。',
          )
          resolve()
          return
        }
        const ext = mime.indexOf('webm') >= 0 ? '.webm' : mime.indexOf('ogg') >= 0 ? '.ogg' : '.webm'
        const file = new File([blob], `mic-recording${ext}`, { type: mime })
        try {
          const data = await postAudio(file, langSelect.value)
          setOutput(originalTextEl, formatTranscribeOutput(data))
          setBadge('录音转写完成')
          saveAudioHistory('transcribe', { input: 'mic' })
          persistAudioSession()
          resolve()
        } catch (e) {
          setOutput(originalTextEl, '转写失败：' + (e.message || e))
          setBadge('转写失败')
          reject(e)
        } finally {
          setLoading(loadingOriginal, false)
          micStatus.textContent = '麦克风待命'
        }
      }
      try {
        mediaRecorder.stop()
      } catch (e) {
        recording = false
        stopMicVisualizer()
        updateMicButton()
        micStatus.classList.remove('recording')
        stopRecordingStream()
        recordChunks = []
        mediaRecorder = null
        setLoading(loadingOriginal, false)
        micStatus.textContent = '麦克风待命'
        reject(e)
      }
    })
  }

  function updateMicButton() {
    btnMic.classList.toggle('recording', recording)
    btnMic.innerHTML = recording
      ? '<i class="fa-solid fa-stop"></i><span>停止并识别</span>'
      : '<i class="fa-solid fa-microphone"></i><span>开始录音</span>'
  }

  async function toggleMicRecording() {
    if (recording) {
      await finishRecordingAndTranscribe()
      return
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      micStatus.textContent = '当前浏览器不支持麦克风（请用 Chrome / Edge，且使用 http://localhost 或 HTTPS）'
      return
    }
    try {
      recordStream = await navigator.mediaDevices.getUserMedia({ audio: MIC_AUDIO_CONSTRAINTS })
    } catch (e) {
      micStatus.textContent =
        '无法访问麦克风：' +
        (e.message || e) +
        '。请在浏览器设置中允许本站使用麦克风。'
      return
    }

    startMicVisualizer(recordStream).catch(() => {})

    const mime = pickRecorderMime()
    try {
      mediaRecorder = mime ? new MediaRecorder(recordStream, { mimeType: mime }) : new MediaRecorder(recordStream)
    } catch (e) {
      stopMicVisualizer()
      stopRecordingStream()
      micStatus.textContent = '无法启动录音：' + (e.message || e)
      return
    }

    recordChunks = []
    mediaRecorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) recordChunks.push(ev.data)
    }
    mediaRecorder.onerror = () => {
      micStatus.textContent = '录音过程出错'
    }

    recording = true
    recordStartedAt = Date.now()
    updateMicButton()
    micStatus.textContent = '录音中… 再次点击「停止并识别」结束'
    micStatus.classList.add('recording')
    setBadge('录音中')
    mediaRecorder.start(200)

    recordTimer = setTimeout(() => {
      if (recording && mediaRecorder && mediaRecorder.state === 'recording') {
        micStatus.textContent = '已达上限，正在识别…'
        finishRecordingAndTranscribe().catch(() => {})
      }
    }, MAX_RECORD_MS)
  }

  async function transcribeFile() {
    if (!currentFile) {
      alert('请先上传音频文件')
      return
    }
    setLoading(loadingOriginal, true)
    setBadge('正在转写音频...')
    try {
      const lang = langSelect.value
      const data = await postAudio(currentFile, lang)
      setOutput(originalTextEl, formatTranscribeOutput(data))
      setBadge('音频转写完成')
      saveAudioHistory('transcribe', { input: 'file', fileName: currentFile ? currentFile.name : '' })
      persistAudioSession()
    } catch (e) {
      setOutput(originalTextEl, '转写失败：' + (e.message || e))
      setBadge('转写失败')
    } finally {
      setLoading(loadingOriginal, false)
    }
  }

  async function translateToChinese() {
    const src = getTranscriptForAi()
    if (!src) {
      alert('请先完成识别原文（上传转写或麦克风录音）')
      return
    }
    setLoading(loadingTranslate, true)
    setBadge('正在翻译为中文...')
    try {
      const prompt =
        '请将下面文本翻译为简体中文，保持原意；若已是中文则略作润色。仅输出译文：\n' + src
      const cn = await callChat(prompt)
      setOutput(translateTextEl, cn || '翻译结果为空')
      setBadge('翻译完成')
      saveAudioHistory('translate')
      persistAudioSession()
    } catch (e) {
      setOutput(translateTextEl, '翻译失败：' + (e.message || e))
      setBadge('翻译失败')
    } finally {
      setLoading(loadingTranslate, false)
    }
  }

  /**
   * 按「总结对象」下拉框选择来源：自动 / 仅译文 / 仅原文
   */
  function isPlaceholderTranslation(t) {
    const s = (t || '').trim()
    return !s || /^翻译结果将在此显示/.test(s) || /^翻译失败/.test(s)
  }

  function isPlaceholderOriginal(t) {
    const s = (t || '').trim()
    return !s || /^识别原文将在此显示/.test(s) || /^转写失败/.test(s)
  }

  function resolveSummarySource() {
    const mode = summaryModeEl ? summaryModeEl.value : 'auto'
    const trans = getTranslatedText()
    const hasTranslation = !isPlaceholderTranslation(trans)

    let src = ''
    let sourceLabel = ''
    if (mode === 'translation') {
      src = getTranslatedText()
      sourceLabel = '翻译结果（中文）'
      if (isPlaceholderTranslation(src)) {
        return { src: '', sourceLabel, error: '请先在左侧点击「翻译为中文」生成译文，或改用「自动」/「仅识别原文」。' }
      }
    } else if (mode === 'original') {
      src = getTranscriptForAi()
      sourceLabel = '识别原文'
      if (isPlaceholderOriginal(src)) {
        return { src: '', sourceLabel, error: '请先在左侧完成「音频转写」或麦克风识别，生成识别原文。' }
      }
    } else {
      if (hasTranslation) {
        src = getTranslatedText()
        sourceLabel = '翻译结果（中文）〔自动选用〕'
      } else {
        src = getTranscriptForAi()
        sourceLabel = '识别原文〔自动选用〕'
      }
      if (!src) {
        return { src: '', sourceLabel, error: '请先完成「识别原文」；若需总结译文请先点击「翻译为中文」。' }
      }
    }
    return { src, sourceLabel, error: '' }
  }

  async function summarizeTranslated() {
    const resolved = resolveSummarySource()
    if (resolved.error) {
      alert(resolved.error)
      return
    }
    const { src, sourceLabel } = resolved
    setLoading(loadingSummary, true)
    setBadge('正在生成总结...')
    if (summaryHintEl) {
      summaryHintEl.textContent = '正在基于「' + sourceLabel + '」生成总结…'
    }
    try {
      const prompt =
        '以下段落是用户选定的「' +
        sourceLabel +
        '」全文。请只根据这段文字写总结，不要臆测未提供的信息。\n' +
        '请输出结构化智能总结：\n1）核心要点（3-5条）\n2）一句话结论\n\n—— 正文开始 ——\n' +
        src
      const summary = await callChat(prompt)
      const header = '【总结依据：' + sourceLabel + '】\n\n'
      setOutput(summaryTextEl, header + (summary || '总结结果为空'))
      setBadge('总结完成')
      saveAudioHistory('summary', { summarySource: sourceLabel })
      persistAudioSession()
    } catch (e) {
      setOutput(summaryTextEl, '总结失败：' + (e.message || e))
      setBadge('总结失败')
    } finally {
      setLoading(loadingSummary, false)
      applySummaryModeHint()
    }
  }

  function clearAll() {
    clearAudioSession()
    currentFile = null
    fileInput.value = ''
    clearPreviewUrl()
    audioPlayer.removeAttribute('src')
    audioPlayer.load()
    audioWrap.style.opacity = '0.5'
    if (recording && mediaRecorder && mediaRecorder.state === 'recording') {
      recordChunks = []
      try {
        mediaRecorder.stop()
      } catch (_) {}
    }
    stopMicVisualizer()
    stopRecordingStream()
    recording = false
    mediaRecorder = null
    if (recordTimer) clearTimeout(recordTimer)
    recordTimer = null
    updateMicButton()
    micStatus.textContent = '麦克风待命'
    micStatus.classList.remove('recording')
    setOutput(originalTextEl, '识别原文将在此显示（上传音频或麦克风录音后自动/手动转写）。')
    setOutput(translateTextEl, '翻译结果将在此显示。')
    setOutput(summaryTextEl, '选择「总结对象」后点击「生成智能总结」，结果将在此展示。')
    setBadge('已清空')
  }

  ;['dragenter', 'dragover', 'dragleave', 'drop'].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
  })

  dropzone.addEventListener('dragenter', () => dropzone.classList.add('ap-dropzone--active'))
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('ap-dropzone--active'))
  dropzone.addEventListener('drop', (e) => {
    dropzone.classList.remove('ap-dropzone--active')
    const file = e.dataTransfer.files && e.dataTransfer.files[0]
    if (file) onFileSelected(file)
  })

  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0]
    if (file) onFileSelected(file)
  })

  btnMic.addEventListener('click', () => {
    toggleMicRecording().catch(() => {})
  })
  btnTranscribe.addEventListener('click', transcribeFile)
  btnTranslate.addEventListener('click', translateToChinese)
  btnSummary.addEventListener('click', summarizeTranslated)
  btnClear.addEventListener('click', clearAll)

  const SUMMARY_HINT_BY_MODE = {
    auto: '「自动」：若已有有效译文则总结译文，否则总结识别原文。',
    translation: '「仅译文」：只根据中间栏「翻译结果」生成总结，与识别原文无关。',
    original: '「仅原文」：只根据左侧「识别原文」生成总结，与译文无关。',
  }

  function applySummaryModeHint() {
    if (summaryModeEl && summaryHintEl) {
      const v = summaryModeEl.value
      summaryHintEl.textContent = SUMMARY_HINT_BY_MODE[v] || summaryHintEl.textContent
    }
  }

  if (summaryModeEl && summaryHintEl) {
    summaryModeEl.addEventListener('change', () => {
      applySummaryModeHint()
      persistAudioSession()
    })
    applySummaryModeHint()
  }

  if (langSelect) {
    langSelect.addEventListener('change', () => persistAudioSession())
  }

  audioWrap.style.opacity = '0.5'

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      persistAudioSession()
    }
  })

  initApPage()

  ;(function micHint() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR && (!window.MediaRecorder || !navigator.mediaDevices)) {
      micStatus.textContent = '当前环境不支持麦克风录音，请改用上传音频文件'
    }
  })()
})()
