/**
 * 多模态历史记录（localStorage，按用户浏览器持久化）
 * - 自动按「保留天数」「最大条数」裁剪
 * - 支持按模块、关键字、时间范围筛选（见 history.html）
 */
;(function (global) {
  'use strict'

  const STORAGE_KEY = 'mm_multimodal_history_v1'
  const SETTINGS_KEY = 'mm_history_settings_v1'
  /** 与各功能页约定：?mmResume=历史记录 id，进入后由页面自行解析并还原 */
  const RESUME_QUERY_KEY = 'mmResume'
  const VERSION = 1

  const MODULE_LABELS = {
    text: '文本对话',
    image: '图片分析',
    audio: '音频处理',
    video: '视频分析',
  }

  function loadRaw() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return { version: VERSION, entries: [] }
      const p = JSON.parse(raw)
      return { version: p.version || VERSION, entries: Array.isArray(p.entries) ? p.entries : [] }
    } catch {
      return { version: VERSION, entries: [] }
    }
  }

  function saveRaw(entries) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: VERSION, entries }))
  }

  function defaultSettings() {
    return { retentionDays: 90, maxEntries: 500 }
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY)
      if (!raw) return defaultSettings()
      const p = JSON.parse(raw)
      return {
        retentionDays: Math.max(1, Math.min(3650, Number(p.retentionDays) || 90)),
        maxEntries: Math.max(10, Math.min(10000, Number(p.maxEntries) || 500)),
      }
    } catch {
      return defaultSettings()
    }
  }

  function saveSettingsObj(settings) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  }

  function pruneEntries(entries, settings) {
    const cutoff = Date.now() - settings.retentionDays * 24 * 60 * 60 * 1000
    let list = entries.filter((e) => e && typeof e.createdAt === 'number' && e.createdAt >= cutoff)
    list.sort((a, b) => b.createdAt - a.createdAt)
    if (list.length > settings.maxEntries) {
      list = list.slice(0, settings.maxEntries)
    }
    return list
  }

  function persist(entries) {
    const settings = loadSettings()
    let list = pruneEntries(entries, settings)
    try {
      saveRaw(list)
    } catch (e) {
      if (e && e.name === 'QuotaExceededError' && list.length > 5) {
        list = list.slice(0, Math.max(5, Math.floor(list.length * 0.65)))
        try {
          saveRaw(list)
        } catch (e2) {
          console.warn('[mmHistory] persist failed', e2)
        }
      } else {
        console.warn('[mmHistory] persist failed', e)
      }
    }
    return list
  }

  function normalizeEntry(entry) {
    return {
      id: entry.id,
      module: entry.module || 'text',
      title: String(entry.title || '').slice(0, 500),
      snippet: String(entry.snippet || '').slice(0, 8000),
      data: entry.data && typeof entry.data === 'object' ? entry.data : {},
      createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : Date.now(),
    }
  }

  function appendEntry({ module, title, snippet, data }) {
    const id = 'h_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11)
    const raw = loadRaw()
    const entry = normalizeEntry({
      id,
      module: module || 'text',
      title: title || MODULE_LABELS[module] || '记录',
      snippet: snippet || '',
      data: data || {},
      createdAt: Date.now(),
    })
    raw.entries.unshift(entry)
    persist(raw.entries)
    return id
  }

  function listEntries(filters) {
    const f = filters || {}
    const { module, q, fromMs, toMs } = f
    const settings = loadSettings()
    let list = pruneEntries(loadRaw().entries, settings)
    if (module && module !== 'all') {
      list = list.filter((e) => e.module === module)
    }
    if (fromMs != null) list = list.filter((e) => e.createdAt >= fromMs)
    if (toMs != null) list = list.filter((e) => e.createdAt <= toMs)
    if (q && String(q).trim()) {
      const needle = String(q).trim().toLowerCase()
      list = list.filter((e) => {
        const blob = (e.title + '\n' + e.snippet + '\n' + JSON.stringify(e.data)).toLowerCase()
        return blob.indexOf(needle) >= 0
      })
    }
    return list
  }

  function getEntry(id) {
    return loadRaw().entries.find((e) => e.id === id) || null
  }

  function deleteEntry(id) {
    const raw = loadRaw()
    raw.entries = raw.entries.filter((e) => e.id !== id)
    persist(raw.entries)
  }

  function deleteEntries(ids) {
    if (!ids || !ids.length) return
    const set = new Set(ids)
    const raw = loadRaw()
    raw.entries = raw.entries.filter((e) => !set.has(e.id))
    persist(raw.entries)
  }

  function clearModule(module) {
    const raw = loadRaw()
    raw.entries = raw.entries.filter((e) => e.module !== module)
    persist(raw.entries)
  }

  function clearAll() {
    persist([])
  }

  function getSettings() {
    return loadSettings()
  }

  function setSettings(p) {
    const cur = loadSettings()
    const next = {
      retentionDays: Math.max(1, Math.min(3650, Number(p.retentionDays) || cur.retentionDays)),
      maxEntries: Math.max(10, Math.min(10000, Number(p.maxEntries) || cur.maxEntries)),
    }
    saveSettingsObj(next)
    const raw = loadRaw()
    persist(raw.entries)
  }

  function purgeExpired() {
    const raw = loadRaw()
    persist(raw.entries)
  }

  function init() {
    purgeExpired()
  }

  function pagePathForModule(module) {
    const m = String(module || '').trim()
    if (m === 'text') return 'text.html'
    if (m === 'image') return 'image.html'
    if (m === 'audio') return 'audio.html'
    if (m === 'video') return 'video.html'
    return null
  }

  /**
   * @returns {string|null} 相对当前站点的路径，如 text.html?mmResume=h_xxx
   */
  function buildResumeUrl(entryId) {
    if (!entryId) return null
    const entry = getEntry(entryId)
    if (!entry) return null
    const path = pagePathForModule(entry.module)
    if (!path) return null
    return path + '?' + RESUME_QUERY_KEY + '=' + encodeURIComponent(entryId)
  }

  init()

  global.mmHistory = {
    MODULE_LABELS,
    RESUME_QUERY_KEY,
    pagePathForModule,
    buildResumeUrl,
    appendEntry,
    listEntries,
    getEntry,
    deleteEntry,
    deleteEntries,
    clearModule,
    clearAll,
    getSettings,
    setSettings,
    purgeExpired,
  }
})(typeof window !== 'undefined' ? window : this)
