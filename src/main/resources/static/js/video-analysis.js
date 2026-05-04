/**
 * video.html — 视频分析：时间轴/字幕/检测框以服务端 YOLO+Whisper 为准；
 * 不再使用本地虚构事件或伪动画框。
 */
;(function () {
  const API_BASE =
    typeof window.mmResolveApiBase === 'function'
      ? window.mmResolveApiBase()
      : window.location.protocol === 'file:'
        ? 'http://127.0.0.1:8081'
        : ''

  /** 避免个别环境下相对路径 /api 解析异常，统一为可请求的绝对地址 */
  function absoluteApiUrl(pathOrUrl) {
    const u = String(pathOrUrl || '')
    if (!u) return u
    if (/^https?:\/\//i.test(u)) return u
    const origin =
      typeof window !== 'undefined' && window.location && window.location.origin ? window.location.origin : ''
    return origin + (u.startsWith('/') ? u : '/' + u)
  }

  function xhrPostFormData(finalUrl, formData) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', finalUrl)
      xhr.responseType = 'text'
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText || '{}'))
          } catch (err) {
            reject(new Error('响应非 JSON：' + err.message))
          }
        } else {
          reject(new Error('HTTP ' + xhr.status + ': ' + String(xhr.responseText || '').slice(0, 500)))
        }
      }
      xhr.onerror = function () {
        reject(new Error('XHR failed'))
      }
      xhr.send(formData)
    })
  }

  /**
   * multipart POST 后解析 JSON。部分浏览器 / WebView 下 fetch 会 Failed to fetch，改用 XHR 可恢复。
   */
  async function postFormDataJson(pathOrUrl, formData) {
    const finalUrl = absoluteApiUrl(pathOrUrl)
    try {
      const res = await fetch(finalUrl, {
        method: 'POST',
        body: formData,
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
      })
      if (!res.ok) {
        const t = await res.text()
        throw new Error(`HTTP ${res.status}${t ? ': ' + t.slice(0, 500) : ''}`)
      }
      return await res.json()
    } catch (e) {
      const m = e && e.message ? String(e.message) : ''
      if (m.indexOf('HTTP ') === 0) {
        throw e
      }
      try {
        return await xhrPostFormData(finalUrl, formData)
      } catch (e2) {
        throw new Error(
          '请求未发出或网络中断：' +
            (e && e.message ? e.message : e) +
            '（请求地址：' +
            finalUrl +
            '）',
        )
      }
    }
  }

  const API_VIDEO_REPORT = API_BASE ? `${String(API_BASE).replace(/\/$/, '')}/api/video/report` : '/api/video/report'
  const API_VIDEO_INSIGHTS_SUMMARY = API_BASE
    ? `${String(API_BASE).replace(/\/$/, '')}/api/video/insights/summary`
    : '/api/video/insights/summary'
  const API_VIDEO_INSIGHTS_SEARCH = API_BASE
    ? `${String(API_BASE).replace(/\/$/, '')}/api/video/insights/search`
    : '/api/video/insights/search'
  const API_VIDEO_INSIGHTS_ASK = API_BASE
    ? `${String(API_BASE).replace(/\/$/, '')}/api/video/insights/ask`
    : '/api/video/insights/ask'
  const API_VIDEO_HEALTH = API_BASE ? `${String(API_BASE).replace(/\/$/, '')}/api/video/health` : '/api/video/health'
  const API_VIDEO_UNDERSTAND = API_BASE
    ? `${String(API_BASE).replace(/\/$/, '')}/api/video/understand`
    : '/api/video/understand'
  /** 一次上传完成 detect + keyframes + asr，避免三连 multipart 触发连接重置 */
  const API_VIDEO_BUNDLE = API_BASE
    ? `${String(API_BASE).replace(/\/$/, '')}/api/video/bundle`
    : '/api/video/bundle'
  /** 旧版 JAR 无 /bundle 时的兜底（会再次三连上传，仅 404/405 时启用） */
  const API_VIDEO_DETECT = API_BASE
    ? `${String(API_BASE).replace(/\/$/, '')}/api/video/detect`
    : '/api/video/detect'
  const API_VIDEO_KEYFRAMES = API_BASE
    ? `${String(API_BASE).replace(/\/$/, '')}/api/video/keyframes`
    : '/api/video/keyframes'
  const API_VIDEO_ASR = API_BASE ? `${String(API_BASE).replace(/\/$/, '')}/api/video/asr` : '/api/video/asr'

  const dropzone = document.getElementById('vp-dropzone')
  const fileInput = document.getElementById('vp-file-input')
  const rawVideo = document.getElementById('vp-video-raw')
  const aiVideo = document.getElementById('vp-video-ai')
  const overlay = document.getElementById('vp-overlay')
  const overlayCtx = overlay.getContext('2d')
  const analysisWrap = document.getElementById('vp-analysis-wrap')
  const selectionEl = document.getElementById('vp-selection')
  const selectionResultEl = document.getElementById('vp-selection-result')

  const progressTrack = document.getElementById('vp-progress-track')
  const progressFill = document.getElementById('vp-progress-fill')
  const markersWrap = document.getElementById('vp-markers')
  const timeLabel = document.getElementById('vp-time-label')
  const badge = document.getElementById('vp-header-badge')

  const reportBody = document.getElementById('vp-report-body')
  const keyframesWrap = document.getElementById('vp-keyframes')
  const eventsListEl = document.getElementById('vp-events-list')
  const subtitlesEl = document.getElementById('vp-subtitles')
  const subSearchEl = document.getElementById('vp-sub-search')
  const subMetaEl = document.getElementById('vp-subtitles-meta')
  const subScrollBtn = document.getElementById('vp-sub-scroll-active')
  let subSearchTimer = null

  const btnStartAnalyze = document.getElementById('vp-btn-start-analyze')
  const btnStartAnalyzeTop = document.getElementById('vp-btn-start-analyze-top')

  const btnReport = document.getElementById('vp-btn-report')
  const btnTts = document.getElementById('vp-btn-tts')
  const btnExportReport = document.getElementById('vp-btn-export-report')
  const btnExportFrames = document.getElementById('vp-btn-export-frames')
  const btnClear = document.getElementById('vp-btn-clear')

  const btnUnderstand = document.getElementById('vp-btn-understand')
  const understandInstruction = document.getElementById('vp-understand-instruction')
  const btnInsightsSummary = document.getElementById('vp-btn-insights-summary')
  const btnInsightsSearch = document.getElementById('vp-btn-insights-search')
  const btnInsightsAsk = document.getElementById('vp-btn-insights-ask')
  const insightsQ = document.getElementById('vp-insights-q')
  const insightsVisual = document.getElementById('vp-insights-visual')
  const insightsQuestion = document.getElementById('vp-insights-question')
  const insightsBody = document.getElementById('vp-insights-body')
  const envBanner = document.getElementById('vp-env-banner')
  const liveCaptionEl = document.getElementById('vp-live-caption')

  const EVENT_COLORS = {
    person: 'person',
    disappear: 'disappear',
    cut: 'cut',
  }

  /** 与 video_analyze.py COCO 中文映射一致，用于时间轴/画框展示 */
  const YOLO_LABEL_ZH = {
    person: '人物',
    bicycle: '自行车',
    car: '汽车',
    motorcycle: '摩托车',
    airplane: '飞机',
    bus: '公交车',
    train: '火车',
    truck: '卡车',
    boat: '船',
    'traffic light': '交通信号灯',
    'fire hydrant': '消防栓',
    'stop sign': '停车标志',
    'parking meter': '停车计时器',
    bench: '长椅',
    bird: '鸟',
    cat: '猫',
    dog: '狗',
    horse: '马',
    sheep: '羊',
    cow: '牛',
    elephant: '大象',
    bear: '熊',
    zebra: '斑马',
    giraffe: '长颈鹿',
    backpack: '背包',
    umbrella: '伞',
    handbag: '手提包',
    tie: '领带',
    suitcase: '手提箱',
    frisbee: '飞盘',
    skis: '滑雪板',
    snowboard: '滑雪单板',
    'sports ball': '运动球',
    kite: '风筝',
    'baseball bat': '棒球棒',
    'baseball glove': '棒球手套',
    skateboard: '滑板',
    surfboard: '冲浪板',
    'tennis racket': '网球拍',
    bottle: '瓶子',
    'wine glass': '酒杯',
    cup: '杯子',
    fork: '叉子',
    knife: '刀',
    spoon: '勺子',
    bowl: '碗',
    banana: '香蕉',
    apple: '苹果',
    sandwich: '三明治',
    orange: '橙子',
    broccoli: '西兰花',
    carrot: '胡萝卜',
    'hot dog': '热狗',
    pizza: '披萨',
    donut: '甜甜圈',
    cake: '蛋糕',
    chair: '椅子',
    couch: '沙发',
    'potted plant': '盆栽',
    bed: '床',
    'dining table': '餐桌',
    toilet: '马桶',
    tv: '电视',
    laptop: '笔记本电脑',
    mouse: '鼠标',
    remote: '遥控器',
    keyboard: '键盘',
    'cell phone': '手机',
    microwave: '微波炉',
    oven: '烤箱',
    toaster: '烤面包机',
    sink: '水槽',
    refrigerator: '冰箱',
    book: '书',
    clock: '时钟',
    vase: '花瓶',
    scissors: '剪刀',
    'teddy bear': '泰迪熊',
    'hair drier': '吹风机',
    toothbrush: '牙刷',
  }

  function zhForYoloLabel(en) {
    const k = String(en || '').toLowerCase().trim()
    if (!k) return en
    return YOLO_LABEL_ZH[k] || YOLO_LABEL_ZH[k.replace(/_/g, ' ')] || en
  }

  function localizeYoloInText(s) {
    if (s == null || s === '') return s
    let out = String(s)
    const keys = Object.keys(YOLO_LABEL_ZH).sort((a, b) => b.length - a.length)
    for (const en of keys) {
      const zh = YOLO_LABEL_ZH[en]
      const escaped = en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      out = out.replace(new RegExp(escaped, 'gi'), zh)
    }
    return out
  }

  let currentFile = null
  let objectUrl = null
  let duration = 0
  let events = []
  let subtitles = []
  let reportText = ''
  let keyframes = []
  let rafId = null
  let seekingByMarker = false
  let backendDetections = []
  let backendFrameHints = []
  /** 后端分析是否已成功返回（区别于演示占位） */
  let videoAnalysisReady = false
  let videoAnalysisLoadError = ''
  /** 防止重复触发时并发多组上传请求；换文件时递增以丢弃旧结果 */
  let loadBackendGeneration = 0
  /** 用户点击「开始分析」后的上传+推理进行中 */
  let analysisInFlight = false
  /** 智能摘要/搜索/提问/综合理解 任一请求进行中 */
  let insightsOperationInFlight = false

  const VP_SESSION_KEY = 'mm_video_session_v2'
  const VP_SESSION_MAX_CHARS = 2400000
  /**
   * 长视频：文件本身写入 IndexedDB（一般可达数百 MB，受磁盘/配额影响），
   * sessionStorage 只存 v3 元数据与 JSON，不塞入整段 base64。
   * 仅当 IDB 不可用时，才尝试小体积的 DataURL 写入 session（旧版/兜底）。
   */
  const MM_IDB_NAME = 'mm_multimodal_v1'
  const MM_IDB_STORE = 'files'
  const MM_VIDEO_IDB_KEY = 'video_session_blob'
  const VP_DATAURL_FALLBACK_MAX_BYTES = 1.2 * 1024 * 1024
  let persistVideoTimer = null
  let videoSessionRestoring = false

  function idbOpen() {
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

  async function idbPutVideoFile(file) {
    const db = await idbOpen()
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
        tx.objectStore(MM_IDB_STORE).put(file, MM_VIDEO_IDB_KEY)
      } catch (e) {
        try {
          db.close()
        } catch (_) {}
        reject(e)
      }
    })
  }

  async function idbGetVideoFile() {
    const db = await idbOpen()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(MM_IDB_STORE, 'readonly')
      const q = tx.objectStore(MM_IDB_STORE).get(MM_VIDEO_IDB_KEY)
      q.onsuccess = () => {
        try {
          db.close()
        } catch (_) {}
        resolve(q.result && q.result instanceof Blob ? q.result : null)
      }
      q.onerror = () => {
        try {
          db.close()
        } catch (_) {}
        reject(q.error)
      }
    })
  }

  async function idbDeleteVideoFile() {
    if (!window.indexedDB) return
    let db
    try {
      db = await idbOpen()
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
        tx.objectStore(MM_IDB_STORE).delete(MM_VIDEO_IDB_KEY)
      } catch (_) {
        try {
          db.close()
        } catch (_) {}
        resolve()
      }
    })
  }

  const smoothBoxes = new Map()
  let selecting = false
  let selectStart = null
  let selectedRect = null

  function fmtTime(sec) {
    if (!Number.isFinite(sec)) return '00:00'
    const s = Math.max(0, Math.floor(sec))
    const mm = String(Math.floor(s / 60)).padStart(2, '0')
    const ss = String(s % 60).padStart(2, '0')
    return `${mm}:${ss}`
  }

  function setBadge(text) {
    badge.textContent = text
  }

  function revokeObjectUrl() {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl)
      objectUrl = null
    }
  }

  function resetOutputs() {
    reportText = ''
    keyframes = []
    backendDetections = []
    backendFrameHints = []
    reportBody.innerHTML =
      '<p class="vp-placeholder">上传并分析后在此查看摘要；点「生成分析报告」可更新。</p>'
    keyframesWrap.innerHTML = ''
    eventsListEl.innerHTML = ''
    subtitlesEl.innerHTML = ''
    if (subSearchEl) subSearchEl.value = ''
    if (subMetaEl) subMetaEl.textContent = ''
    markersWrap.innerHTML = ''
    progressFill.style.width = '0%'
    timeLabel.textContent = '00:00 / 00:00'
    selectionResultEl.textContent =
      '检测框需先「开始分析」；来自后端抽样关键帧，与当前播放时刻可能不完全同步。'
    if (insightsBody) {
      insightsBody.innerHTML =
        '<p class="vp-placeholder">上传视频后，先点「生成总结与回答」做综合理解；也可用下方摘要/搜索/提问（偏语音）。</p>'
    }
    if (envBanner) {
      envBanner.classList.add('vp-hidden')
      envBanner.innerHTML = ''
    }
    videoAnalysisReady = false
    videoAnalysisLoadError = ''
    if (liveCaptionEl) {
      liveCaptionEl.textContent = ''
      liveCaptionEl.classList.remove('vp-live-caption--empty')
    }
    syncStartAnalyzeButton()
    syncPlaybackBadge()
  }


  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  /** 与后端 ASR 一致：压紧 end、避免句尾默认过长盖住下一句（导致提前出字幕 / 搜到错误时间点）。 */
  function normalizeSubtitleIntervals(arr) {
    if (!arr || !arr.length) return
    for (let i = 0; i < arr.length; i++) {
      const s = arr[i]
      let st = Number(s.time) || 0
      let en = s.end
      if (en == null || en === '') en = st + 1.2
      else en = Number(en)
      if (!(en > st)) en = st + 0.35
      s.time = Math.round(st * 100) / 100
      s.end = Math.round(en * 100) / 100
    }
    for (let i = 0; i < arr.length - 1; i++) {
      const stNext = Number(arr[i + 1].time) || 0
      let en = Number(arr[i].end)
      const stCur = Number(arr[i].time) || 0
      if (en > stNext - 0.05) {
        arr[i].end = Math.round(Math.max(stCur + 0.12, stNext - 0.05) * 100) / 100
      }
    }
  }

  function insightNetErrorMessage(err) {
    const m = err && err.message ? String(err.message) : String(err || '')
    if (m === 'Failed to fetch' || m.indexOf('NetworkError') >= 0) {
      const origin = typeof window !== 'undefined' && window.location ? window.location.origin : ''
      return (
        '无法连接后端。请用浏览器地址栏打开 http://localhost:8081/video.html（端口以 application.yml 里 server.port 为准，默认 8081），' +
        '与后端同源最稳妥。若用 Live Server 等其它端口，需后端已允许跨域（项目已配置）且 Spring Boot 已启动。' +
        (origin ? ' 当前页来源：' + origin + '。' : '')
      )
    }
    return m || '请求失败'
  }

  function updateLiveCaption(current) {
    if (!liveCaptionEl) return
    if (videoAnalysisLoadError) {
      liveCaptionEl.textContent = '分析未就绪，无法显示字幕'
      liveCaptionEl.classList.add('vp-live-caption--empty')
      return
    }
    if (!videoAnalysisReady) {
      liveCaptionEl.textContent = analysisInFlight
        ? '正在上传并由服务器分析…'
        : '未分析：请点击「开始分析」。仅本地播放不会出现字幕与检测框。'
      liveCaptionEl.classList.add('vp-live-caption--empty')
      return
    }
    const c = Number(current) || 0
    let text = ''
    for (let i = 0; i < subtitles.length; i++) {
      const s = subtitles[i]
      const st = Number(s.time) || 0
      const rawEnd = s.end
      const en = rawEnd != null && rawEnd !== '' ? Number(rawEnd) : st + 1.2
      if (c >= st && c < en) {
        text = s.text || ''
      }
    }
    liveCaptionEl.textContent = text || ''
    liveCaptionEl.classList.toggle('vp-live-caption--empty', !text)
  }

  function labelColorForDetection(label) {
    const l = String(label || '').toLowerCase()
    if (l === 'person') return '#22c55e'
    if (l === 'bicycle' || l === 'motorcycle') return '#38bdf8'
    if (l === 'car' || l === 'truck' || l === 'bus') return '#f59e0b'
    if (l === 'cat' || l === 'dog') return '#a78bfa'
    return '#94a3b8'
  }

  function syncEnvBanner() {
    if (!envBanner) return
    const text = subtitles.map((s) => s.text).join('\n')
    const broken = /未找到 ffmpeg|ffmpeg|未能从视频提取音轨|未安装 faster-whisper|提取音频失败/i.test(text)
    if (broken) {
      envBanner.classList.remove('vp-hidden')
      envBanner.innerHTML =
        '<span class="vp-env-banner-icon" aria-hidden="true"><i class="fa-solid fa-triangle-exclamation"></i></span><div><strong>语音转写未就绪</strong> · 摘要、按台词搜索与依赖字幕的问答将不可用。请安装 <code>ffmpeg</code> 并加入系统 PATH，并在 Python 环境中安装 <code>faster-whisper</code>。</div>'
      return
    }
    envBanner.classList.add('vp-hidden')
    envBanner.innerHTML = ''
  }

  function buildReportTextFromServer(sr) {
    let t = String(sr.summary || '') + '\n\n'
    if (Array.isArray(sr.bullets) && sr.bullets.length) {
      t += sr.bullets.join('\n') + '\n'
    }
    if (sr.metrics) {
      const m = sr.metrics
      t += `\n[指标] 时长 ${m.durationSec}s · 采样 ${m.sampleFrames} · 镜头变化 ${m.sceneCuts} · 事件 ${m.eventTotal}\n`
    }
    return t.trim()
  }

  function renderServerReport(serverReport) {
    reportBody.innerHTML = ''
    const m = serverReport.metrics
    if (m && typeof m.durationSec === 'number') {
      const grid = document.createElement('div')
      grid.className = 'vp-metrics-grid'
      const cells = [
        ['时长', `${m.durationSec}s`],
        ['采样帧', String(m.sampleFrames ?? '—')],
        ['镜头变化', String(m.sceneCuts ?? '—')],
        ['事件数', String(m.eventTotal ?? '—')],
      ]
      cells.forEach(([k, v]) => {
        const cell = document.createElement('div')
        cell.className = 'vp-metric-cell'
        cell.innerHTML = `<span class="vp-metric-k">${escapeHtml(k)}</span><span class="vp-metric-v">${escapeHtml(v)}</span>`
        grid.appendChild(cell)
      })
      reportBody.appendChild(grid)
    }

    const blockSum = document.createElement('div')
    blockSum.className = 'vp-report-block'
    let inner = `<h4>分析摘要</h4><div>${escapeHtml(serverReport.summary || '')}</div>`
    if (Array.isArray(serverReport.bullets) && serverReport.bullets.length) {
      inner += `<div class="vp-report-bullets">${serverReport.bullets.map((b) => `<div>• ${escapeHtml(b)}</div>`).join('')}</div>`
    }
    blockSum.innerHTML = inner
    reportBody.appendChild(blockSum)
  }

  function syncInsightButtonAvailability() {
    const hasVideo = !!currentFile
    const instrOk = !!(understandInstruction && understandInstruction.value && understandInstruction.value.trim())
    const qOk = !!(insightsQ && insightsQ.value && insightsQ.value.trim())
    const askOk = !!(insightsQuestion && insightsQuestion.value && insightsQuestion.value.trim())
    const busy = insightsOperationInFlight

    if (btnUnderstand) {
      btnUnderstand.disabled = busy || !hasVideo || !instrOk
    }
    if (btnInsightsSummary) {
      btnInsightsSummary.disabled = busy || !hasVideo
    }
    if (btnInsightsSearch) {
      btnInsightsSearch.disabled = busy || !hasVideo || !qOk
    }
    if (btnInsightsAsk) {
      btnInsightsAsk.disabled = busy || !hasVideo || !askOk
    }
  }

  function setInsightsBusy(busy) {
    insightsOperationInFlight = !!busy
    syncInsightButtonAvailability()
  }

  async function postVideoInsights(url, formData) {
    return postFormDataJson(url, formData)
  }

  function renderUnderstandResult(data) {
    if (!insightsBody) return
    if (data && data.code != null && data.msg && (data.code === 500 || data.code === 405 || data.code === 413)) {
      insightsBody.innerHTML = '<p class="vp-placeholder">' + escapeHtml(String(data.msg)) + '</p>'
      return
    }
    if (data.error) {
      insightsBody.innerHTML = '<p class="vp-placeholder">' + escapeHtml(String(data.error)) + '</p>'
      return
    }
    const meta =
      '<p class="vp-insights-note">时长 ' +
      escapeHtml(String(data.durationSec != null ? data.durationSec : '—')) +
      's · 画面描述引擎 ' +
      escapeHtml(String(data.visualCaptionEngine || '—')) +
      (data.visualCaptionNote ? ' · ' + escapeHtml(String(data.visualCaptionNote)) : '') +
      '</p>'
    let html = '<div class="vp-insights-block">' + meta
    html += '<h4>整体总结</h4><p>' + escapeHtml(data.summary || '') + '</p>'
    html += '<h4>画面侧重</h4><p>' + escapeHtml(data.visualSummary || '') + '</p>'
    html += '<h4>语音侧重</h4><p>' + escapeHtml(data.audioSummary || '') + '</p>'
    html += '<h4>针对你的需求</h4><p>' + escapeHtml(data.directAnswer || '') + '</p>'
    const hl = Array.isArray(data.highlights) ? data.highlights : []
    if (hl.length) {
      html += '<h4>时间轴要点</h4><ul class="vp-insights-list">'
      hl.forEach((h) => {
        const ts = Number(h.timeSec != null ? h.timeSec : 0)
        const tx = h.text || ''
        html +=
          '<li><button type="button" class="vp-insights-jump" data-jump="' +
          ts +
          '">' +
          escapeHtml(fmtTime(ts)) +
          '</button> ' +
          escapeHtml(tx) +
          '</li>'
      })
      html += '</ul>'
    }
    html += '</div>'
    insightsBody.innerHTML = html
    insightsBody.querySelectorAll('.vp-insights-jump').forEach((btn) => {
      btn.addEventListener('click', () => jumpTo(Number(btn.getAttribute('data-jump'))))
    })
  }

  async function runUnifiedUnderstand() {
    if (!currentFile) {
      alert('请先上传视频')
      return
    }
    if (!understandInstruction || !understandInstruction.value.trim()) {
      return
    }
    if (!insightsBody) return
    setInsightsBusy(true)
    setBadge('正在综合理解视频（抽帧、转写、总结，可能较慢）…')
    insightsBody.innerHTML = '<p class="vp-placeholder">分析中，请稍候…</p>'
    const fd = new FormData()
    fd.append('file', currentFile)
    fd.append(
      'instruction',
      understandInstruction && understandInstruction.value ? understandInstruction.value.trim() : '',
    )
    fd.append('lang', 'zh-CN')
    try {
      const data = await postFormDataJson(API_VIDEO_UNDERSTAND, fd)
      renderUnderstandResult(data)
      setBadge('智能总结已完成')
      schedulePersistVideoSession()
      if (window.mmHistory) {
        try {
          window.mmHistory.appendEntry({
            module: 'video',
            title: '视频 · 智能总结 · ' + (currentFile.name || 'video'),
            snippet: (data.summary || data.directAnswer || '').slice(0, 800),
            data: {
              kind: 'understand',
              fileName: currentFile.name,
              summary: data.summary,
              directAnswer: data.directAnswer,
            },
          })
        } catch (e) {}
      }
    } catch (e) {
      insightsBody.innerHTML =
        '<p class="vp-placeholder">失败：' + escapeHtml(insightNetErrorMessage(e)) + '</p>'
      setBadge('总结失败')
      schedulePersistVideoSession()
    } finally {
      setInsightsBusy(false)
    }
  }

  function renderInsightsSummary(data) {
    if (data.error) {
      insightsBody.innerHTML = '<p class="vp-placeholder">' + escapeHtml(String(data.error)) + '</p>'
      return
    }
    const summary = data.summary || ''
    const bookmarks = Array.isArray(data.bookmarks) ? data.bookmarks : []
    let html =
      '<div class="vp-insights-block"><h4>要点摘要</h4><p>' + escapeHtml(summary) + '</p><h4>时间轴书签</h4>'
    if (!bookmarks.length) {
      html += '<p class="vp-placeholder">（无书签条目）</p>'
    } else {
      html += '<ul class="vp-insights-list">'
      bookmarks.forEach((b, i) => {
        const ts = Number(b.timeSec != null ? b.timeSec : b.time_sec || 0)
        const title = b.title || b.label || '书签 ' + (i + 1)
        const detail = b.detail || ''
        html +=
          '<li><button type="button" class="vp-insights-jump" data-jump="' +
          ts +
          '">' +
          escapeHtml(fmtTime(ts)) +
          '</button> <strong>' +
          escapeHtml(title) +
          '</strong> — ' +
          escapeHtml(detail) +
          '</li>'
      })
      html += '</ul>'
    }
    html += '</div>'
    insightsBody.innerHTML = html
    insightsBody.querySelectorAll('.vp-insights-jump').forEach((btn) => {
      btn.addEventListener('click', () => jumpTo(Number(btn.getAttribute('data-jump'))))
    })
  }

  function renderInsightsSearch(data) {
    const matches = Array.isArray(data.matches) ? data.matches : []
    let html = '<div class="vp-insights-block"><h4>搜索结果</h4><p>查询：' + escapeHtml(data.query || '') + '</p>'
    if (data.note) {
      html += '<p class="vp-insights-note">' + escapeHtml(data.note) + '</p>'
    }
    if (!matches.length) {
      html += '<p class="vp-placeholder">无匹配片段，可换关键词或勾选「画面事件」。</p></div>'
      insightsBody.innerHTML = html
      return
    }
    html += '<ul class="vp-insights-list">'
    matches.forEach((m, i) => {
      const ts = Number(m.timeSec != null ? m.timeSec : 0)
      const sn = m.snippet || ''
      const sc = m.score != null ? ' · 分 ' + m.score : ''
      html +=
        '<li><button type="button" class="vp-insights-jump" data-jump="' +
        ts +
        '">' +
        escapeHtml(fmtTime(ts)) +
        '</button> ' +
        escapeHtml(sn) +
        escapeHtml(sc) +
        '</li>'
    })
    html += '</ul></div>'
    insightsBody.innerHTML = html
    insightsBody.querySelectorAll('.vp-insights-jump').forEach((btn) => {
      btn.addEventListener('click', () => jumpTo(Number(btn.getAttribute('data-jump'))))
    })
  }

  function renderInsightsAsk(data) {
    if (data.error) {
      insightsBody.innerHTML = '<p class="vp-placeholder">' + escapeHtml(String(data.error)) + '</p>'
      return
    }
    const ans = data.answer || ''
    const cites = Array.isArray(data.citations) ? data.citations : []
    let html = '<div class="vp-insights-block"><h4>回答</h4><p>' + escapeHtml(ans) + '</p>'
    if (cites.length) {
      html += '<h4>引用片段</h4>'
      cites.forEach((c) => {
        const ts = Number(c.timeSec != null ? c.timeSec : 0)
        const sn = c.snippet || ''
        html +=
          '<div class="vp-insights-cite"><button type="button" class="vp-insights-jump" data-jump="' +
          ts +
          '">' +
          escapeHtml(fmtTime(ts)) +
          '</button> ' +
          escapeHtml(sn) +
          '</div>'
      })
    }
    html += '</div>'
    insightsBody.innerHTML = html
    insightsBody.querySelectorAll('.vp-insights-jump').forEach((btn) => {
      btn.addEventListener('click', () => jumpTo(Number(btn.getAttribute('data-jump'))))
    })
  }

  async function runInsightsSummary() {
    if (!currentFile) {
      alert('请先上传视频')
      return
    }
    setInsightsBusy(true)
    setBadge('正在生成摘要（含语音转写）…')
    const fd = new FormData()
    fd.append('file', currentFile)
    fd.append('lang', 'zh-CN')
    try {
      const data = await postVideoInsights(API_VIDEO_INSIGHTS_SUMMARY, fd)
      renderInsightsSummary(data)
      setBadge('摘要已生成')
      schedulePersistVideoSession()
      if (window.mmHistory) {
        try {
          window.mmHistory.appendEntry({
            module: 'video',
            title: '视频 · 智能摘要 · ' + (currentFile.name || 'video'),
            snippet: (data.summary || '').slice(0, 800),
            data: { kind: 'insights-summary', fileName: currentFile.name, summary: data.summary, bookmarks: data.bookmarks },
          })
        } catch (e) {}
      }
    } catch (e) {
      insightsBody.innerHTML =
        '<p class="vp-placeholder">失败：' + escapeHtml(insightNetErrorMessage(e)) + '</p>'
      setBadge('摘要失败')
      schedulePersistVideoSession()
    } finally {
      setInsightsBusy(false)
    }
  }

  async function runInsightsSearch() {
    if (!currentFile) {
      alert('请先上传视频')
      return
    }
    const q = (insightsQ && insightsQ.value ? insightsQ.value : '').trim()
    if (!q) {
      alert('请输入搜索关键词')
      return
    }
    setInsightsBusy(true)
    setBadge('正在搜索转写…')
    const fd = new FormData()
    fd.append('file', currentFile)
    fd.append('q', q)
    fd.append('lang', 'zh-CN')
    fd.append('includeVisual', insightsVisual && insightsVisual.checked ? 'true' : 'false')
    try {
      const data = await postVideoInsights(API_VIDEO_INSIGHTS_SEARCH, fd)
      renderInsightsSearch(data)
      setBadge('搜索完成')
      schedulePersistVideoSession()
    } catch (e) {
      insightsBody.innerHTML =
        '<p class="vp-placeholder">失败：' + escapeHtml(insightNetErrorMessage(e)) + '</p>'
      setBadge('搜索失败')
      schedulePersistVideoSession()
    } finally {
      setInsightsBusy(false)
    }
  }

  async function runInsightsAsk() {
    if (!currentFile) {
      alert('请先上传视频')
      return
    }
    const q = (insightsQuestion && insightsQuestion.value ? insightsQuestion.value : '').trim()
    if (!q) {
      alert('请输入问题')
      return
    }
    setInsightsBusy(true)
    setBadge('正在根据转写作答…')
    const fd = new FormData()
    fd.append('file', currentFile)
    fd.append('question', q)
    fd.append('lang', 'zh-CN')
    try {
      const data = await postVideoInsights(API_VIDEO_INSIGHTS_ASK, fd)
      renderInsightsAsk(data)
      setBadge('已回答')
      schedulePersistVideoSession()
      if (window.mmHistory) {
        try {
          window.mmHistory.appendEntry({
            module: 'video',
            title: '视频 · 问答 · ' + q.slice(0, 40),
            snippet: (data.answer || '').slice(0, 600),
            data: { kind: 'insights-ask', fileName: currentFile.name, question: q, answer: data.answer },
          })
        } catch (e) {}
      }
    } catch (e) {
      insightsBody.innerHTML =
        '<p class="vp-placeholder">失败：' + escapeHtml(insightNetErrorMessage(e)) + '</p>'
      setBadge('问答失败')
      schedulePersistVideoSession()
    } finally {
      setInsightsBusy(false)
    }
  }

  function setVideoSource(file) {
    revokeObjectUrl()
    objectUrl = URL.createObjectURL(file)
    rawVideo.src = objectUrl
    aiVideo.src = objectUrl
    rawVideo.load()
    aiVideo.load()
    setBadge('视频已选择，点击「开始分析」')
  }

  function syncStartAnalyzeButton() {
    const dis = !currentFile || analysisInFlight
    const tip = !currentFile
      ? '请先选择视频文件'
      : analysisInFlight
        ? '分析进行中，请稍候'
        : '上传至服务器进行抽帧与语音转写（无需播放整段）'
    ;[btnStartAnalyze, btnStartAnalyzeTop].forEach((btn) => {
      if (!btn) return
      btn.disabled = dis
      btn.title = tip
    })
  }

  /** 角标：禁止再写「实时分析中」——本地播放不会生成结果 */
  function syncPlaybackBadge() {
    if (!currentFile) {
      setBadge('等待上传')
      return
    }
    if (analysisInFlight) {
      setBadge('正在分析（服务器处理中）…')
      return
    }
    const playing = rawVideo && !rawVideo.paused
    if (videoAnalysisLoadError && !videoAnalysisReady) {
      if (playing) setBadge('播放中 · 上次失败，请重试「开始分析」')
      else setBadge('已暂停 · 请重试「开始分析」')
      return
    }
    if (!videoAnalysisReady) {
      const d = duration > 0 ? fmtTime(duration) : '—'
      if (playing) setBadge(`播放中 · 未分析（${d}），请点「开始分析」`)
      else setBadge(`已读取时长 ${d}，点击「开始分析」`)
      return
    }
    if (playing) setBadge('播放中')
    else setBadge('已暂停')
  }

  function onFile(file) {
    if (!file) return
    if (!file.type.startsWith('video/') && !/\.(mp4|mov|avi)$/i.test(file.name)) {
      alert('请选择视频文件（mp4/mov/avi）')
      return
    }
    clearVideoSessionStorage()
    loadBackendGeneration++
    analysisInFlight = false
    currentFile = file
    duration = 0
    resetOutputs()
    setVideoSource(file)
    syncStartAnalyzeButton()
    syncPlaybackBadge()
    syncInsightButtonAvailability()
  }

  async function startVideoAnalysis() {
    if (!currentFile) {
      alert('请先选择视频文件')
      return
    }
    if (analysisInFlight) return
    analysisInFlight = true
    syncStartAnalyzeButton()
    syncPlaybackBadge()
    if (liveCaptionEl) {
      liveCaptionEl.textContent = '正在上传并分析，无需播放视频…'
      liveCaptionEl.classList.add('vp-live-caption--empty')
    }
    setBadge('正在分析（服务器处理中）…')
    try {
      await loadBackendVideoData()
    } finally {
      analysisInFlight = false
      syncStartAnalyzeButton()
      syncPlaybackBadge()
      updateLiveCaption(rawVideo.currentTime || 0)
    }
  }

  async function postVideoApi(url) {
    if (!currentFile) throw new Error('no file')
    const fd = new FormData()
    fd.append('file', currentFile)
    return postFormDataJson(url, fd)
  }

  function shouldTryLegacyPipeline(bundleError) {
    const m = String(bundleError && bundleError.message ? bundleError.message : bundleError || '')
    return m.indexOf('HTTP 404') >= 0 || m.indexOf('HTTP 405') >= 0
  }

  async function tryLoadLegacyBundle(gen) {
    let detect = null
    try {
      detect = await postVideoApi(API_VIDEO_DETECT)
    } catch (x) {
      console.warn('[video-analysis] legacy detect', x)
    }
    if (gen !== loadBackendGeneration) return null
    let asr = null
    try {
      asr = await postVideoApi(API_VIDEO_ASR)
    } catch (x) {
      console.warn('[video-analysis] legacy asr', x)
    }
    if (gen !== loadBackendGeneration) return null
    let kf = null
    try {
      kf = await postVideoApi(API_VIDEO_KEYFRAMES)
    } catch (x) {
      console.warn('[video-analysis] legacy keyframes', x)
    }
    if (!detect && !asr && !kf) return null
    return { detect: detect, asr: asr, keyframes: kf }
  }

  async function loadBackendVideoData() {
    const gen = ++loadBackendGeneration
    videoAnalysisLoadError = ''
    videoAnalysisReady = false
    events = []
    subtitles = []
    backendDetections = []
    backendFrameHints = []
    const errs = []

    const healthUrl = absoluteApiUrl(API_VIDEO_HEALTH)
    try {
      const h = await fetch(healthUrl, { method: 'GET', cache: 'no-store' })
      if (gen !== loadBackendGeneration) return
      if (!h.ok) {
        const t = await h.text()
        throw new Error('HTTP ' + h.status + (t ? ': ' + t.slice(0, 240) : ''))
      }
    } catch (e) {
      if (gen !== loadBackendGeneration) return
      const msg =
        (e && e.message ? e.message : e) +
        '（探活地址：' +
        healthUrl +
        '）。若本页不是从 http://127.0.0.1:8081 或 http://localhost:8081 打开的，请改用该地址访问；不要用 file:// 直接打开 html。'
      console.warn('[video-analysis] health', e)
      videoAnalysisReady = false
      videoAnalysisLoadError = '无法连接视频分析服务：' + msg
      eventsListEl.innerHTML =
        '<div class="vp-analysis-error">视频分析未完成。<br/>' +
        escapeHtml(videoAnalysisLoadError) +
        '<br/><span style="color:#94a3b8;font-size:12px">在浏览器新标签访问「' +
        escapeHtml(healthUrl) +
        '」应看到 JSON（含 ok:true）；若打不开，说明 Spring 未监听或端口/防火墙不对。</span></div>'
      subtitlesEl.innerHTML =
        '<div class="vp-sub-item"><span class="vp-sub-time">--:--</span>语音字幕未加载：请先解决上方报错。</div>'
      if (subMetaEl) subMetaEl.textContent = ''
      syncEnvBanner()
      updateLiveCaption(0)
      setBadge('后端不可达')
      syncPlaybackBadge()
      return
    }

    let bundle = null
    try {
      bundle = await postVideoApi(API_VIDEO_BUNDLE)
    } catch (e) {
      if (gen !== loadBackendGeneration) return
      console.warn('[video-analysis] bundle', e)
      let recovered = null
      if (shouldTryLegacyPipeline(e)) {
        try {
          recovered = await tryLoadLegacyBundle(gen)
        } catch (x) {
          console.warn('[video-analysis] legacy bundle', x)
        }
      }
      if (recovered && (recovered.detect || recovered.asr || recovered.keyframes)) {
        bundle = recovered
      } else {
        errs.push('综合分析：' + (e.message || e))
      }
    }
    if (gen !== loadBackendGeneration) return

    let detect = bundle && bundle.detect ? bundle.detect : null
    let asr = bundle && bundle.asr ? bundle.asr : null
    let kf = bundle && bundle.keyframes ? bundle.keyframes : null

    if (detect) {
      if (Array.isArray(detect.events) && detect.events.length) {
        events = detect.events.map((e, idx) => ({
          id: e.id || `be-${idx}`,
          type: e.type || 'cut',
          time: Number(e.time || 0),
          title: e.title || '事件',
          desc: e.desc || '',
        }))
      }
      if (Array.isArray(detect.detections)) {
        backendDetections = detect.detections
      }
    }

    if (asr && Array.isArray(asr.subtitles) && asr.subtitles.length) {
      subtitles = asr.subtitles.map((s, idx) => ({
        id: s.id || `sub-${idx}`,
        time: Number(s.time || 0),
        end: s.end != null && s.end !== undefined ? Number(s.end) : undefined,
        text: s.text || '',
      }))
      normalizeSubtitleIntervals(subtitles)
    }

    if (kf && Array.isArray(kf.frames)) {
      backendFrameHints = kf.frames.map((f) => ({
        time: Number(f.time || 0),
        title: f.caption || '关键帧',
      }))
    }

    if (errs.length >= 1 || (!detect && !asr && !kf)) {
      if (gen !== loadBackendGeneration) return
      videoAnalysisReady = false
      videoAnalysisLoadError = errs.join('；') || '未知错误'
      markersWrap.innerHTML = ''
      eventsListEl.innerHTML =
        '<div class="vp-analysis-error">视频分析未完成。<br/>' +
        escapeHtml(videoAnalysisLoadError) +
        '<br/><span style="color:#94a3b8;font-size:12px">请确认 Spring Boot 已运行、Python 与 ffmpeg 已按文档配置；查看浏览器 F12「网络」里 /api/video/* 的状态码与响应。</span></div>'
      subtitlesEl.innerHTML =
        '<div class="vp-sub-item"><span class="vp-sub-time">--:--</span>语音字幕未加载：请先解决上方报错。</div>'
      if (subMetaEl) subMetaEl.textContent = ''
      syncEnvBanner()
      updateLiveCaption(0)
      setBadge('分析请求失败')
      syncPlaybackBadge()
      return
    }

    if (errs.length) {
      videoAnalysisLoadError = '部分步骤失败（已尽力展示其余结果）：' + errs.join('；')
    }

    if (gen !== loadBackendGeneration) return
    videoAnalysisReady = true
    renderEventsAndMarkers()
    if (!events.length) {
      eventsListEl.innerHTML =
        '<p class="vp-placeholder" style="padding:8px;margin:0">未产生可展示的时间轴事件（画面变化较少或视频较短时可能为空）。</p>'
    }
    if (errs.length) {
      const warn = document.createElement('div')
      warn.className = 'vp-analysis-error'
      warn.style.marginTop = '8px'
      warn.innerHTML = escapeHtml(videoAnalysisLoadError)
      eventsListEl.appendChild(warn)
    }
    renderSubtitles()
    syncEnvBanner()
    updateLiveCaption(rawVideo.currentTime || 0)
    setBadge(errs.length ? '分析已完成（部分环节失败，见列表提示）' : '分析完成：时间轴与字幕已就绪')
    syncPlaybackBadge()
    schedulePersistVideoSession()
  }

  function renderEventsAndMarkers() {
    markersWrap.innerHTML = ''
    eventsListEl.innerHTML = ''

    events.forEach((ev) => {
      const pct = duration ? (ev.time / duration) * 100 : 0
      const marker = document.createElement('button')
      marker.type = 'button'
      marker.className = `vp-marker ${EVENT_COLORS[ev.type] || 'cut'}`
      marker.style.left = `${pct}%`
      marker.title = `${fmtTime(ev.time)} ${localizeYoloInText(ev.title)}`
      marker.addEventListener('click', (e) => {
        e.stopPropagation()
        jumpTo(ev.time)
      })
      markersWrap.appendChild(marker)

      const item = document.createElement('div')
      item.className = 'vp-event-item'
      item.innerHTML = `<span class="vp-event-time">${fmtTime(ev.time)}</span>${escapeHtml(
        localizeYoloInText(ev.title),
      )} - ${escapeHtml(localizeYoloInText(ev.desc))}`
      item.addEventListener('click', () => jumpTo(ev.time))
      eventsListEl.appendChild(item)
    })
  }

  function renderSubtitles() {
    const q = (subSearchEl && subSearchEl.value ? subSearchEl.value : '').trim().toLowerCase()
    subtitlesEl.innerHTML = ''
    let shown = 0
    subtitles.forEach((s) => {
      const text = s.text || ''
      const tStart = fmtTime(s.time)
      const endNum = s.end != null && s.end !== '' ? Number(s.end) : NaN
      const stNum = Number(s.time) || 0
      const tEnd =
        Number.isFinite(endNum) && endNum > stNum ? fmtTime(endNum) : ''
      if (q) {
        const hay = (text + ' ' + tStart + ' ' + tEnd).toLowerCase()
        if (hay.indexOf(q) < 0) return
      }
      shown++
      const item = document.createElement('div')
      item.className = 'vp-sub-item'
      item.dataset.time = String(s.time)
      if (s.end != null && s.end !== '') {
        item.dataset.end = String(s.end)
      }
      const endHint = tEnd ? `–${tEnd} ` : ''
      item.innerHTML = `<span class="vp-sub-time">${tStart} ${endHint}</span>${escapeHtml(text)}`
      item.addEventListener('click', () => jumpTo(s.time))
      subtitlesEl.appendChild(item)
    })
    if (subMetaEl) {
      if (!subtitles.length) {
        subMetaEl.textContent = ''
      } else if (q) {
        subMetaEl.textContent = `共 ${subtitles.length} 条 · 显示 ${shown} 条`
      } else {
        subMetaEl.textContent = `共 ${subtitles.length} 条`
      }
    }
    if (!shown && subtitles.length) {
      subtitlesEl.innerHTML =
        '<p class="vp-placeholder vp-sub-filter-empty">无匹配字幕，请调整关键词。</p>'
    }
  }

  function jumpTo(time) {
    if (!Number.isFinite(time)) return
    rawVideo.currentTime = Math.min(Math.max(0, time), duration || time)
    syncAiCurrentTime()
  }

  function rebindInsightJumpsIn(root) {
    if (!root) return
    root.querySelectorAll('.vp-insights-jump').forEach((btn) => {
      btn.addEventListener('click', () => jumpTo(Number(btn.getAttribute('data-jump') || 0)))
    })
  }

  function syncAiCurrentTime() {
    if (Math.abs(aiVideo.currentTime - rawVideo.currentTime) > 0.08) {
      aiVideo.currentTime = rawVideo.currentTime
    }
  }

  function syncVideoStates() {
    rawVideo.addEventListener('play', () => {
      aiVideo.play().catch(() => {})
      syncPlaybackBadge()
    })
    rawVideo.addEventListener('pause', () => {
      aiVideo.pause()
      syncPlaybackBadge()
    })
    rawVideo.addEventListener('seeking', () => {
      syncAiCurrentTime()
      seekingByMarker = true
    })
    rawVideo.addEventListener('seeked', () => {
      syncAiCurrentTime()
      seekingByMarker = false
    })
    rawVideo.addEventListener('volumechange', () => {
      aiVideo.volume = rawVideo.volume
      aiVideo.muted = rawVideo.muted
    })
    rawVideo.addEventListener('ratechange', () => {
      aiVideo.playbackRate = rawVideo.playbackRate
    })
  }

  function resizeOverlay() {
    const rect = analysisWrap.getBoundingClientRect()
    overlay.width = Math.max(1, Math.round(rect.width))
    overlay.height = Math.max(1, Math.round(rect.height))
  }

  function getDetectionsAt(_t) {
    if (!duration || !backendDetections.length) return []
    const boxes = []
    backendDetections.forEach((d, i) => {
      const raw = d.box
      if (!Array.isArray(raw) || raw.length < 4) return
      const bx = Number(raw[0]) / 100
      const by = Number(raw[1]) / 100
      const bw = Number(raw[2]) / 100
      const bh = Number(raw[3]) / 100
      const lab = d.label || 'object'
      boxes.push({
        id: `det-${i}-${lab}`,
        label: lab,
        conf: Number(d.confidence || 0),
        color: labelColorForDetection(lab),
        x: bx,
        y: by,
        w: Math.max(0.02, bw),
        h: Math.max(0.02, bh),
      })
    })
    return boxes
  }

  function lerp(a, b, f) {
    return a + (b - a) * f
  }

  function drawOverlay() {
    if (!overlay.width || !overlay.height) return
    overlayCtx.clearRect(0, 0, overlay.width, overlay.height)

    if (!duration || !currentFile) return

    const t = rawVideo.currentTime || 0
    const targets = getDetectionsAt(t)
    const targetIds = new Set(targets.map((b) => b.id))

    for (const box of targets) {
      const prev = smoothBoxes.get(box.id) || box
      const next = {
        ...box,
        x: lerp(prev.x, box.x, 0.22),
        y: lerp(prev.y, box.y, 0.22),
        w: lerp(prev.w, box.w, 0.22),
        h: lerp(prev.h, box.h, 0.22),
      }
      smoothBoxes.set(box.id, next)
    }
    for (const id of Array.from(smoothBoxes.keys())) {
      if (!targetIds.has(id)) smoothBoxes.delete(id)
    }

    const pulse = 1 + 0.12 * Math.sin(t * 6)
    smoothBoxes.forEach((b) => {
      const x = b.x * overlay.width
      const y = b.y * overlay.height
      const w = b.w * overlay.width
      const h = b.h * overlay.height

      overlayCtx.save()
      overlayCtx.strokeStyle = b.color
      overlayCtx.lineWidth = 2.1 * pulse
      overlayCtx.shadowColor = b.color
      overlayCtx.shadowBlur = 10
      overlayCtx.strokeRect(x, y, w, h)

      const label = `${zhForYoloLabel(b.label)} ${(b.conf * 100).toFixed(0)}%`
      overlayCtx.font = '12px Inter, sans-serif'
      const tw = overlayCtx.measureText(label).width + 12
      overlayCtx.fillStyle = b.color
      overlayCtx.fillRect(x, Math.max(0, y - 22), tw, 20)
      overlayCtx.fillStyle = '#0b1220'
      overlayCtx.fillText(label, x + 6, Math.max(13, y - 8))
      overlayCtx.restore()
    })
  }

  function updateProgressUI() {
    const current = rawVideo.currentTime || 0
    const pct = duration ? (current / duration) * 100 : 0
    progressFill.style.width = `${pct}%`
    timeLabel.textContent = `${fmtTime(current)} / ${fmtTime(duration)}`

    const subItems = subtitlesEl.querySelectorAll('.vp-sub-item')
    subItems.forEach((el) => {
      const t0 = Number(el.dataset.time || 0)
      const endStr = el.dataset.end
      const t1 = endStr != null && endStr !== '' ? Number(endStr) : t0 + 2.85
      const active = current >= t0 && current < t1
      el.classList.toggle('active', active)
    })
    updateLiveCaption(current)
  }

  function renderLoop() {
    resizeOverlay()
    syncAiCurrentTime()
    if (!seekingByMarker) updateProgressUI()
    drawOverlay()
    rafId = requestAnimationFrame(renderLoop)
  }

  function setupSelection() {
    const pointerPos = (e) => {
      const rect = analysisWrap.getBoundingClientRect()
      return {
        x: Math.min(Math.max(0, e.clientX - rect.left), rect.width),
        y: Math.min(Math.max(0, e.clientY - rect.top), rect.height),
        width: rect.width,
        height: rect.height,
      }
    }

    analysisWrap.addEventListener('mousedown', (e) => {
      if (!currentFile) return
      selecting = true
      selectStart = pointerPos(e)
      selectedRect = null
      selectionEl.classList.remove('vp-hidden')
    })

    window.addEventListener('mousemove', (e) => {
      if (!selecting || !selectStart) return
      const p = pointerPos(e)
      const x = Math.min(selectStart.x, p.x)
      const y = Math.min(selectStart.y, p.y)
      const w = Math.abs(p.x - selectStart.x)
      const h = Math.abs(p.y - selectStart.y)
      selectedRect = { x, y, w, h }
      selectionEl.style.left = `${x}px`
      selectionEl.style.top = `${y}px`
      selectionEl.style.width = `${w}px`
      selectionEl.style.height = `${h}px`
    })

    window.addEventListener('mouseup', () => {
      if (!selecting) return
      selecting = false
      if (!selectedRect || selectedRect.w < 8 || selectedRect.h < 8) {
        selectionEl.classList.add('vp-hidden')
        selectionResultEl.textContent =
          '检测框需先「开始分析」；来自后端抽样关键帧，与当前播放时刻可能不完全同步。'
        return
      }
      const t = rawVideo.currentTime || 0
      const boxes = getDetectionsAt(t)
      const hits = boxes.filter((b) => {
        const bx = b.x * overlay.width
        const by = b.y * overlay.height
        const bw = b.w * overlay.width
        const bh = b.h * overlay.height
        return !(
          bx + bw < selectedRect.x ||
          bx > selectedRect.x + selectedRect.w ||
          by + bh < selectedRect.y ||
          by > selectedRect.y + selectedRect.h
        )
      })
      if (!hits.length) {
        selectionResultEl.textContent = `选区结果（${fmtTime(t)}）：未识别到目标`
      } else {
        const txt = hits.map((h) => `${zhForYoloLabel(h.label)} ${(h.conf * 100).toFixed(0)}%`).join('，')
        selectionResultEl.textContent = `选区结果（${fmtTime(t)}）：${txt}`
      }
      setTimeout(() => selectionEl.classList.add('vp-hidden'), 900)
    })
  }

  function buildReport() {
    const lines = [
      `视频时长：${fmtTime(duration)}`,
      '（服务端报告暂不可用时的占位页。请确认 Spring Boot 与 Python 分析环境正常后重试「生成分析报告」。）',
      '',
      '已加载的时间轴事件（完全来自后端 YOLO/直方图，非虚构场景）：',
      ...(events.length
        ? events.map((e) => `- [${fmtTime(e.time)}] ${e.title}：${e.desc}`)
        : ['（尚无事件或未成功拉取后端数据）']),
    ]
    reportText = lines.join('\n')

    reportBody.innerHTML = ''
    const block1 = document.createElement('div')
    block1.className = 'vp-report-block'
    block1.innerHTML =
      `<h4>本地占位摘要</h4>` +
      lines
        .slice(0, 6)
        .map((l) => `<div>${escapeHtml(l)}</div>`)
        .join('')
    reportBody.appendChild(block1)
  }

  function onceEvent(target, event) {
    return new Promise((resolve) => {
      const handler = () => {
        target.removeEventListener(event, handler)
        resolve()
      }
      target.addEventListener(event, handler)
    })
  }

  async function captureKeyframes() {
    if (!currentFile || !duration) return
    keyframesWrap.innerHTML = '<div class="vp-loading"><div class="vp-spinner"></div>正在提取关键帧...</div>'

    const capture = document.createElement('video')
    capture.src = objectUrl
    capture.muted = true
    capture.preload = 'auto'
    await onceEvent(capture, 'loadedmetadata')

    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    canvas.width = capture.videoWidth || 960
    canvas.height = capture.videoHeight || 540

    const frameSource = backendFrameHints.length
      ? backendFrameHints.map((f, idx) => ({
          time: Number.isFinite(f.time) ? f.time : events[Math.min(idx, events.length - 1)].time,
          title: f.title || `关键帧${idx + 1}`,
          desc: f.title || `关键帧${idx + 1}`,
        }))
      : events

    const frames = []
    for (const ev of frameSource) {
      capture.currentTime = Math.min(Math.max(0.05, ev.time), Math.max(0.05, duration - 0.05))
      await onceEvent(capture, 'seeked')
      ctx.drawImage(capture, 0, 0, canvas.width, canvas.height)
      const dataUrl = canvas.toDataURL('image/jpeg', 0.86)
      frames.push({
        time: ev.time,
        title: ev.title || '关键帧',
        desc: `${fmtTime(ev.time)}：${ev.desc}`,
        dataUrl,
      })
    }
    keyframes = frames

    keyframesWrap.innerHTML = ''
    frames.forEach((f) => {
      const card = document.createElement('div')
      card.className = 'vp-frame-card'
      card.innerHTML = `
        <img src="${f.dataUrl}" alt="${f.title}">
        <div class="vp-frame-meta">
          <div><strong>${fmtTime(f.time)}</strong> ${f.title}</div>
          <div>${f.desc}</div>
        </div>
      `
      keyframesWrap.appendChild(card)
    })
  }

  async function generateReport() {
    if (!currentFile || !duration) {
      alert('请先上传视频')
      return
    }
    reportBody.innerHTML = '<div class="vp-loading"><div class="vp-spinner"></div>正在生成报告...</div>'
    setBadge('正在生成报告')
    try {
      const serverReport = await postVideoApi(API_VIDEO_REPORT)
      if (
        serverReport &&
        (serverReport.summary ||
          serverReport.bullets ||
          serverReport.metrics ||
          serverReport.sections)
      ) {
        renderServerReport(serverReport)
        reportText = buildReportTextFromServer(serverReport)
      } else {
        buildReport()
      }
    } catch (e) {
      console.warn('[video-analysis] report api fallback', e)
      buildReport()
    }
    await captureKeyframes()
    setBadge('报告已生成')
    schedulePersistVideoSession()
    if (window.mmHistory && reportText && currentFile) {
      try {
        window.mmHistory.appendEntry({
          module: 'video',
          title: '视频报告 · ' + currentFile.name,
          snippet: reportText.slice(0, 2500),
          data: { fileName: currentFile.name, report: reportText },
        })
      } catch (e) {
        console.warn('[video] history', e)
      }
    }
  }

  function speakReport() {
    if (!reportText) {
      alert('请先生成报告')
      return
    }
    if (!('speechSynthesis' in window)) {
      alert('当前浏览器不支持语音朗读')
      return
    }
    window.speechSynthesis.cancel()
    const utter = new SpeechSynthesisUtterance(reportText)
    utter.lang = 'zh-CN'
    utter.rate = 1
    utter.pitch = 1
    utter.onstart = () => setBadge('AI 正在解说')
    utter.onend = () => setBadge('解说完成')
    window.speechSynthesis.speak(utter)
  }

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  function exportReport() {
    if (!reportText) {
      alert('请先生成报告')
      return
    }
    downloadText(`video-report-${Date.now()}.txt`, reportText)
  }

  function exportFrames() {
    if (!keyframes.length) {
      alert('请先生成关键帧')
      return
    }
    keyframes.forEach((f, i) => {
      const a = document.createElement('a')
      a.href = f.dataUrl
      a.download = `keyframe-${i + 1}-${Math.round(f.time)}s.jpg`
      setTimeout(() => a.click(), i * 120)
    })
  }

  function fileToDataUrlVideo(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(r.result)
      r.onerror = () => reject(r.error)
      r.readAsDataURL(file)
    })
  }

  async function dataUrlToVideoFile(dataUrl, name, mime) {
    if (!dataUrl || String(dataUrl).indexOf('data:') !== 0) return null
    try {
      const res = await fetch(String(dataUrl))
      const blob = await res.blob()
      return new File([blob], name || 'video.mp4', { type: mime || blob.type || 'video/mp4' })
    } catch (_) {
      return null
    }
  }

  function clearVideoSessionStorage() {
    try {
      sessionStorage.removeItem(VP_SESSION_KEY)
    } catch (_) {}
    void idbDeleteVideoFile()
  }

  function schedulePersistVideoSession() {
    if (videoSessionRestoring) return
    clearTimeout(persistVideoTimer)
    persistVideoTimer = setTimeout(() => {
      void persistVideoSession()
    }, 500)
  }

  async function persistVideoSession() {
    if (videoSessionRestoring) return
    if (!currentFile && !videoAnalysisReady) {
      return
    }
    try {
      const form = {
        understand: understandInstruction ? understandInstruction.value : '',
        insightsQ: insightsQ ? insightsQ.value : '',
        insightsVisual: insightsVisual ? insightsVisual.checked : false,
        insightsQuestion: insightsQuestion ? insightsQuestion.value : '',
        subSearch: subSearchEl ? subSearchEl.value : '',
      }
      let fileDataUrl = null
      let fileFromIdb = false
      if (currentFile) {
        try {
          await idbPutVideoFile(currentFile)
          fileFromIdb = true
        } catch (e) {
          console.warn('[video] idb put video', e)
          if (currentFile.size <= VP_DATAURL_FALLBACK_MAX_BYTES) {
            try {
              fileDataUrl = await fileToDataUrlVideo(currentFile)
            } catch (_) {}
          }
        }
      }
      const fileSkipped = !!(currentFile && !fileFromIdb && !fileDataUrl)
      let p = {
        v: 3,
        fileName: currentFile ? currentFile.name : '',
        fileMime: currentFile && currentFile.type ? currentFile.type : 'video/mp4',
        fileFromIdb: !!fileFromIdb,
        fileDataUrl,
        fileSkipped,
        duration,
        events,
        subtitles,
        backendDetections,
        backendFrameHints,
        videoAnalysisReady,
        videoAnalysisLoadError: videoAnalysisLoadError || '',
        reportText: reportText || '',
        reportBodyHtml: reportBody ? reportBody.innerHTML : '',
        insightsBodyHtml: insightsBody ? insightsBody.innerHTML : '',
        form,
      }
      let json = JSON.stringify(p)
      if (json.length > VP_SESSION_MAX_CHARS) {
        p = { ...p, fileDataUrl: null, fileSkipped: p.fileFromIdb ? false : true, insightsBodyHtml: (insightsBody && insightsBody.innerHTML) || '' }
        json = JSON.stringify(p)
        if (json.length > VP_SESSION_MAX_CHARS) {
          p = { ...p, insightsBodyHtml: '' }
          json = JSON.stringify(p)
          if (json.length > VP_SESSION_MAX_CHARS) {
            p = { ...p, reportBodyHtml: '' }
            json = JSON.stringify(p)
          }
        }
      }
      sessionStorage.setItem(VP_SESSION_KEY, json)
    } catch (e) {
      console.warn('[video] persist session', e)
    }
  }

  function waitVideoMetadata() {
    return new Promise((resolve) => {
      if (rawVideo && rawVideo.readyState >= 1 && Number.isFinite(rawVideo.duration) && rawVideo.duration > 0) {
        resolve()
        return
      }
      const done = () => {
        rawVideo.removeEventListener('loadedmetadata', done)
        resolve()
      }
      if (rawVideo) rawVideo.addEventListener('loadedmetadata', done, { once: true })
      else resolve()
    })
  }

  async function tryRestoreVideoSession() {
    if (videoSessionRestoring) return
    try {
      const params = new URLSearchParams(window.location.search)
      if (params.get('mmResume')) return
    } catch (_) {}
    const raw = sessionStorage.getItem(VP_SESSION_KEY)
    if (!raw) return
    let p
    try {
      p = JSON.parse(raw)
    } catch (_) {
      return
    }
    if (!p || (p.v !== 2 && p.v !== 3)) return
    videoSessionRestoring = true
    try {
      if (p.form) {
        if (understandInstruction && p.form.understand != null) understandInstruction.value = p.form.understand
        if (insightsQ && p.form.insightsQ != null) insightsQ.value = p.form.insightsQ
        if (insightsVisual) insightsVisual.checked = !!p.form.insightsVisual
        if (insightsQuestion && p.form.insightsQuestion != null) insightsQuestion.value = p.form.insightsQuestion
        if (subSearchEl && p.form.subSearch != null) subSearchEl.value = p.form.subSearch
      }
      events = Array.isArray(p.events) ? p.events : []
      subtitles = Array.isArray(p.subtitles) ? p.subtitles : []
      backendDetections = Array.isArray(p.backendDetections) ? p.backendDetections : []
      backendFrameHints = Array.isArray(p.backendFrameHints) ? p.backendFrameHints : []
      videoAnalysisReady = !!p.videoAnalysisReady
      videoAnalysisLoadError = p.videoAnalysisLoadError || ''
      reportText = p.reportText || ''
      if (p.reportBodyHtml && reportBody) reportBody.innerHTML = p.reportBodyHtml
      if (p.insightsBodyHtml && insightsBody) {
        insightsBody.innerHTML = p.insightsBodyHtml
        rebindInsightJumpsIn(insightsBody)
      }

      const useIdb = p.v === 3 && p.fileFromIdb
      if (useIdb) {
        let blob = null
        try {
          blob = await idbGetVideoFile()
        } catch (e) {
          console.warn('[video] idb get video', e)
        }
        if (blob) {
          const name = p.fileName || (blob instanceof File && blob.name) || 'video.mp4'
          const mime = p.fileMime || blob.type || 'video/mp4'
          const f = blob instanceof File ? blob : new File([blob], name, { type: mime })
          currentFile = f
          setVideoSource(f)
          await waitVideoMetadata()
        }
      }
      if (!currentFile && p.fileDataUrl) {
        const f = await dataUrlToVideoFile(p.fileDataUrl, p.fileName, p.fileMime)
        if (f) {
          currentFile = f
          setVideoSource(f)
          await waitVideoMetadata()
        }
      }
      if (p.duration && Number(p.duration) > 0) {
        duration = Number(p.duration)
      } else if (rawVideo && rawVideo.duration) {
        duration = rawVideo.duration || 0
      }
      if (videoAnalysisReady) {
        renderEventsAndMarkers()
        renderSubtitles()
      }
      syncEnvBanner()
      if (!currentFile && p.fileName) {
        if (envBanner) {
          envBanner.classList.remove('vp-hidden')
          envBanner.innerHTML =
            '<span class="vp-env-banner-icon" aria-hidden="true"><i class="fa-solid fa-info-circle"></i></span><div><strong>已恢复上次的报告与设置</strong> · 视频文件未能从本机缓存取回，请重新选择同一文件后再点「开始分析」。</div>'
        }
      }
      updateProgressUI()
      if (currentFile) {
        setBadge('已恢复上次的分析会话（长视频会缓存在本机数据库；关闭应用后需重新分析）')
      } else if (p.fileName) {
        setBadge('已恢复部分界面，请重新选择视频')
      } else {
        setBadge('已恢复上次的部分结果')
      }
      syncStartAnalyzeButton()
      syncPlaybackBadge()
      syncInsightButtonAvailability()
    } catch (e) {
      console.warn('[video] restore', e)
    } finally {
      videoSessionRestoring = false
    }
  }

  function clearAll() {
    currentFile = null
    duration = 0
    events = []
    subtitles = []
    smoothBoxes.clear()
    fileInput.value = ''
    revokeObjectUrl()
    rawVideo.removeAttribute('src')
    aiVideo.removeAttribute('src')
    rawVideo.load()
    aiVideo.load()
    overlayCtx.clearRect(0, 0, overlay.width, overlay.height)
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
    if (envBanner) {
      envBanner.classList.add('vp-hidden')
      envBanner.innerHTML = ''
    }
    analysisInFlight = false
    resetOutputs()
    clearVideoSessionStorage()
    setBadge('已清空')
    syncPlaybackBadge()
    syncInsightButtonAvailability()
  }

  function handleLoadedMetadata() {
    duration = rawVideo.duration || 0
    updateProgressUI()
    if (liveCaptionEl) {
      if (analysisInFlight) {
        liveCaptionEl.textContent = '正在上传并分析，无需播放视频…'
        liveCaptionEl.classList.add('vp-live-caption--empty')
      } else if (!videoAnalysisReady) {
        liveCaptionEl.textContent = '点击左侧「开始分析」上传至服务器，无需播放整段视频。'
        liveCaptionEl.classList.add('vp-live-caption--empty')
      }
    }
    syncStartAnalyzeButton()
    syncPlaybackBadge()
  }

  function bindUpload() {
    ;['dragenter', 'dragover', 'dragleave', 'drop'].forEach((ev) => {
      dropzone.addEventListener(ev, (e) => {
        e.preventDefault()
        e.stopPropagation()
      })
    })
    dropzone.addEventListener('dragenter', () => dropzone.classList.add('vp-dropzone--active'))
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('vp-dropzone--active'))
    dropzone.addEventListener('drop', (e) => {
      dropzone.classList.remove('vp-dropzone--active')
      const f = e.dataTransfer.files && e.dataTransfer.files[0]
      if (f) onFile(f)
    })
    fileInput.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0]
      if (f) onFile(f)
    })
  }

  function bindTimeline() {
    progressTrack.addEventListener('click', (e) => {
      const rect = progressTrack.getBoundingClientRect()
      const pct = Math.min(Math.max(0, (e.clientX - rect.left) / rect.width), 1)
      jumpTo((duration || 0) * pct)
    })
  }

  function init() {
    bindUpload()
    bindTimeline()
    syncVideoStates()
    setupSelection()
    window.addEventListener('resize', resizeOverlay)

    rawVideo.addEventListener('loadedmetadata', handleLoadedMetadata)
    rawVideo.addEventListener('timeupdate', updateProgressUI)

    btnReport.addEventListener('click', generateReport)
    btnTts.addEventListener('click', speakReport)
    btnExportReport.addEventListener('click', exportReport)
    btnExportFrames.addEventListener('click', exportFrames)
    btnClear.addEventListener('click', clearAll)
    const bindStart = (btn) => {
      if (btn) btn.addEventListener('click', () => startVideoAnalysis())
    }
    bindStart(btnStartAnalyze)
    bindStart(btnStartAnalyzeTop)

    if (btnUnderstand) btnUnderstand.addEventListener('click', runUnifiedUnderstand)
    if (btnInsightsSummary) btnInsightsSummary.addEventListener('click', runInsightsSummary)
    if (btnInsightsSearch) btnInsightsSearch.addEventListener('click', runInsightsSearch)
    if (btnInsightsAsk) btnInsightsAsk.addEventListener('click', runInsightsAsk)

    if (understandInstruction) {
      understandInstruction.addEventListener('input', () => {
        syncInsightButtonAvailability()
        schedulePersistVideoSession()
      })
    }
    if (insightsQ) {
      insightsQ.addEventListener('input', () => {
        syncInsightButtonAvailability()
        schedulePersistVideoSession()
      })
    }
    if (insightsQuestion) {
      insightsQuestion.addEventListener('input', () => {
        syncInsightButtonAvailability()
        schedulePersistVideoSession()
      })
    }
    if (insightsVisual) {
      insightsVisual.addEventListener('change', () => {
        syncInsightButtonAvailability()
        schedulePersistVideoSession()
      })
    }

    if (subSearchEl) {
      subSearchEl.addEventListener('input', () => {
        clearTimeout(subSearchTimer)
        subSearchTimer = setTimeout(() => {
          renderSubtitles()
          schedulePersistVideoSession()
        }, 160)
      })
    }
    if (subScrollBtn) {
      subScrollBtn.addEventListener('click', () => {
        const el = subtitlesEl.querySelector('.vp-sub-item.active')
        if (el) {
          el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        }
      })
    }

    resetOutputs()
    setBadge('等待上传')
    syncPlaybackBadge()
    resizeOverlay()
    rafId = requestAnimationFrame(renderLoop)
    syncInsightButtonAvailability()

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        void persistVideoSession()
      }
    })

    void tryRestoreVideoSession()
  }

  init()

  ;(function resumeFromHistoryBanner() {
    try {
      const rid = new URLSearchParams(window.location.search).get('mmResume')
      if (!rid || !window.mmHistory) return
      const e = window.mmHistory.getEntry(rid)
      if (!e || e.module !== 'video') return
      const u = new URL(window.location.href)
      u.searchParams.delete('mmResume')
      window.history.replaceState({}, '', u.pathname + u.search + u.hash)
      const tip = document.createElement('div')
      tip.setAttribute('role', 'status')
      tip.style.cssText =
        'margin:12px 16px;padding:12px 14px;font-size:13px;line-height:1.5;color:#fde68a;background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.4);border-radius:10px;'
      const title = String(e.title || '视频记录').replace(/</g, '')
      tip.textContent =
        '已从历史打开：「' +
        title +
        '」。自「历史」进入时无法与本次浏览器的会话恢复混用；若从文本/图片等模块用侧栏切回本页，通常会保留上次的同会话状态（超大视频可能需重新选文件）。'
      const layout = document.querySelector('.vp-layout')
      if (layout && layout.parentNode) layout.parentNode.insertBefore(tip, layout)
      else document.body.insertBefore(tip, document.body.firstChild)
    } catch (_) {}
  })()

  window.addEventListener('beforeunload', () => {
    if (rafId) cancelAnimationFrame(rafId)
    revokeObjectUrl()
  })
})()
