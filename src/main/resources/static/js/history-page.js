/**
 * history.html：列表、筛选、详情、导出、设置
 */
;(function () {
  const listEl = document.getElementById('hh-list')
  const qEl = document.getElementById('hh-q')
  const moduleEl = document.getElementById('hh-module')
  const fromEl = document.getElementById('hh-from')
  const toEl = document.getElementById('hh-to')
  const btnSearch = document.getElementById('hh-btn-search')
  const btnReset = document.getElementById('hh-btn-reset')
  const retentionEl = document.getElementById('hh-retention')
  const maxEl = document.getElementById('hh-max')
  const btnSaveSettings = document.getElementById('hh-btn-save-settings')
  const btnPurge = document.getElementById('hh-btn-purge')
  const btnExport = document.getElementById('hh-btn-export')
  const btnClearAll = document.getElementById('hh-btn-clear-all')
  const overlay = document.getElementById('hh-overlay')
  const detailPre = document.getElementById('hh-detail-pre')
  const btnCloseModal = document.getElementById('hh-btn-close-modal')
  const btnCopy = document.getElementById('hh-btn-copy')
  const btnResume = document.getElementById('hh-btn-resume')

  if (!window.mmHistory) {
    listEl.innerHTML =
      '<div class="hh-empty">未加载 mm-history.js，请检查静态资源路径。</div>'
    return
  }

  const LABELS = window.mmHistory.MODULE_LABELS || {}

  function fmtDate(ms) {
    const d = new Date(ms)
    if (Number.isNaN(d.getTime())) return '—'
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    const h = String(d.getHours()).padStart(2, '0')
    const min = String(d.getMinutes()).padStart(2, '0')
    return `${y}-${m}-${day} ${h}:${min}`
  }

  function dateInputToStartMs(val) {
    if (!val) return null
    const t = new Date(val + 'T00:00:00').getTime()
    return Number.isNaN(t) ? null : t
  }

  function dateInputToEndMs(val) {
    if (!val) return null
    const t = new Date(val + 'T23:59:59.999').getTime()
    return Number.isNaN(t) ? null : t
  }

  function getFilters() {
    return {
      q: (qEl.value || '').trim(),
      module: moduleEl.value,
      fromMs: dateInputToStartMs(fromEl.value),
      toMs: dateInputToEndMs(toEl.value),
    }
  }

  function loadSettings() {
    const s = window.mmHistory.getSettings()
    retentionEl.value = String(s.retentionDays)
    maxEl.value = String(s.maxEntries)
  }

  function render() {
    const list = window.mmHistory.listEntries(getFilters())
    if (!list.length) {
      listEl.innerHTML =
        '<div class="hh-empty">暂无记录。在「文本 / 图片 / 音频 / 视频」各模块完成操作后会自动保存。</div>'
      return
    }
    listEl.innerHTML = ''
    list.forEach((e) => {
      const mod = LABELS[e.module] || e.module
      const card = document.createElement('article')
      card.className = 'hh-card'
      card.innerHTML =
        '<div>' +
        '<div class="hh-card-meta"><span class="hh-badge">' +
        escapeHtml(mod) +
        '</span>' +
        escapeHtml(fmtDate(e.createdAt)) +
        '</div>' +
        '<h2 class="hh-card-title">' +
        escapeHtml(e.title) +
        '</h2>' +
        '<p class="hh-card-snippet">' +
        escapeHtml(e.snippet || '') +
        '</p>' +
        '</div>' +
        '<div class="hh-card-actions">' +
        '<button type="button" class="hh-btn hh-btn-primary hh-btn-detail" data-id="' +
        escapeHtml(e.id) +
        '"><i class="fa-solid fa-eye"></i> 详情</button>' +
        '<button type="button" class="hh-btn hh-btn-primary hh-btn-resume" data-id="' +
        escapeHtml(e.id) +
        '"><i class="fa-solid fa-up-right-from-square"></i> 打开页面</button>' +
        '<button type="button" class="hh-btn hh-btn-ghost hh-btn-del" data-id="' +
        escapeHtml(e.id) +
        '"><i class="fa-solid fa-trash"></i> 删除</button>' +
        '</div>'
      listEl.appendChild(card)
    })

    listEl.querySelectorAll('.hh-btn-detail').forEach((btn) => {
      btn.addEventListener('click', () => openDetail(btn.getAttribute('data-id')))
    })
    listEl.querySelectorAll('.hh-btn-resume').forEach((btn) => {
      btn.addEventListener('click', () => goResume(btn.getAttribute('data-id')))
    })
    listEl.querySelectorAll('.hh-btn-del').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id')
        if (!id || !confirm('确定删除这条记录？')) return
        window.mmHistory.deleteEntry(id)
        render()
      })
    })
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  let detailJson = ''
  let detailEntryId = null

  function goResume(id) {
    if (!id || !window.mmHistory.buildResumeUrl) return
    const url = window.mmHistory.buildResumeUrl(id)
    if (!url) {
      alert('无法跳转：记录不存在或不支持从该模块打开页面。')
      return
    }
    window.location.href = url
  }

  function openDetail(id) {
    const e = window.mmHistory.getEntry(id)
    if (!e) return
    detailEntryId = id
    detailJson = JSON.stringify(e, null, 2)
    detailPre.textContent = detailJson
    overlay.classList.add('hh-open')
    overlay.setAttribute('aria-hidden', 'false')
  }

  function closeDetail() {
    overlay.classList.remove('hh-open')
    overlay.setAttribute('aria-hidden', 'true')
    detailJson = ''
    detailEntryId = null
  }

  btnSearch.addEventListener('click', render)
  btnReset.addEventListener('click', () => {
    qEl.value = ''
    moduleEl.value = 'all'
    fromEl.value = ''
    toEl.value = ''
    render()
  })

  btnSaveSettings.addEventListener('click', () => {
    window.mmHistory.setSettings({
      retentionDays: Number(retentionEl.value),
      maxEntries: Number(maxEl.value),
    })
    loadSettings()
    render()
    alert('设置已保存，并已按新规则裁剪历史记录。')
  })

  btnPurge.addEventListener('click', () => {
    window.mmHistory.purgeExpired()
    render()
    alert('已按当前规则完成清理。')
  })

  btnExport.addEventListener('click', () => {
    const list = window.mmHistory.listEntries({})
    const blob = new Blob([JSON.stringify({ exportedAt: Date.now(), entries: list }, null, 2)], {
      type: 'application/json;charset=utf-8',
    })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `multimodal-history-${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(a.href)
  })

  btnClearAll.addEventListener('click', () => {
    if (!confirm('确定清空全部历史记录？此操作不可恢复。')) return
    window.mmHistory.clearAll()
    render()
  })

  btnCloseModal.addEventListener('click', closeDetail)
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) closeDetail()
  })

  btnCopy.addEventListener('click', async () => {
    if (!detailJson) return
    try {
      await navigator.clipboard.writeText(detailJson)
      alert('已复制到剪贴板')
    } catch {
      alert('复制失败，请手动选择文本复制')
    }
  })

  if (btnResume) {
    btnResume.addEventListener('click', () => {
      if (detailEntryId) goResume(detailEntryId)
    })
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('hh-open')) closeDetail()
  })

  loadSettings()
  render()
})()
