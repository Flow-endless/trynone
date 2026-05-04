const VUE_CDN_CANDIDATES = [
  '/vendor/vue.esm-browser.js',
  'https://cdn.jsdelivr.net/npm/vue@3.5.13/dist/vue.esm-browser.js',
  'https://npm.elemecdn.com/vue@3.5.13/dist/vue.esm-browser.js',
  'https://unpkg.com/vue@3.5.13/dist/vue.esm-browser.js',
]

const userId = 'default'
const API_BASE =
  typeof window !== 'undefined' && typeof window.mmResolveApiBase === 'function'
    ? window.mmResolveApiBase()
    : window.location.protocol === 'file:'
      ? 'http://localhost:8081'
      : ''
const MODE_IDS = ['chat', 'summary', 'translate', 'polish', 'code', 'study', 'write', 'analyze', 'plan']

const MODE_CONFIG = {
  chat: { label: '智能对话', emoji: '💬', placeholder: '例如：请解释数据库索引的原理。' },
  summary: { label: '文本总结', emoji: '🧾', placeholder: '例如：总结下面这段课程笔记。' },
  translate: { label: '文本翻译', emoji: '🌐', placeholder: '例如：把这段中文翻译成英文并保持学术风格。' },
  polish: { label: '文本润色', emoji: '✨', placeholder: '例如：帮我润色毕业论文摘要。' },
  code: { label: '代码生成', emoji: '💻', placeholder: '例如：用 Java 写一个快速排序并解释复杂度。' },
  study: { label: '学习助手', emoji: '📚', placeholder: '例如：高数极限章节给我出 5 道练习题。' },
  write: { label: '文案创作', emoji: '📝', placeholder: '例如：写一段社团招新文案。' },
  analyze: { label: '错题分析', emoji: '🧠', placeholder: '例如：这道题我错在什么地方？请分步骤讲解。' },
  plan: { label: '计划生成', emoji: '📅', placeholder: '例如：生成一份 14 天期末复习计划。' },
}

const NAV_ITEMS = [
  { id: 'chat', label: '智能对话', emoji: '💬' },
  { id: 'summary', label: '文本总结', emoji: '🧾' },
  { id: 'translate', label: '文本翻译', emoji: '🌐' },
  { id: 'polish', label: '文本润色', emoji: '✨' },
  { id: 'code', label: '代码生成', emoji: '💻' },
  { id: 'study', label: '学习助手', emoji: '📚' },
  { id: 'write', label: '文案创作', emoji: '📝' },
  { id: 'analyze', label: '错题分析', emoji: '🧠' },
  { id: 'plan', label: '计划生成', emoji: '📅' },
  { id: 'platformInfo', label: '平台资料', emoji: '📋' },
]

function uid() {
  return `m_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

function importWithTimeout(url, timeoutMs = 5000) {
  return Promise.race([
    import(url),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Load timeout: ${url}`)), timeoutMs)
    }),
  ])
}

async function loadVueModule() {
  let lastError = null
  for (const url of VUE_CDN_CANDIDATES) {
    try {
      return await importWithTimeout(url)
    } catch (err) {
      lastError = err
      console.warn(`[Multimodal] Vue CDN加载失败，尝试下一个: ${url}`, err)
    }
  }
  throw lastError ?? new Error('无法加载Vue模块')
}

function buildUrl(currentMode, content) {
  switch (currentMode) {
    case 'chat':
      return `${API_BASE}/chat?msg=${encodeURIComponent(content)}&userId=${userId}`
    case 'summary':
    case 'translate':
    case 'polish':
      return `${API_BASE}/processText?type=${currentMode}&content=${encodeURIComponent(content)}&userId=${userId}`
    case 'code':
      return `${API_BASE}/generateCode?language=Java&requirement=${encodeURIComponent(content)}&userId=${userId}`
    case 'study':
      return `${API_BASE}/study?subject=${encodeURIComponent(content)}&userId=${userId}`
    case 'write':
      return `${API_BASE}/write?topic=${encodeURIComponent(content)}&userId=${userId}`
    case 'analyze':
      return `${API_BASE}/analyze?question=${encodeURIComponent(content)}&userId=${userId}`
    case 'plan':
      return `${API_BASE}/plan?goal=${encodeURIComponent(content)}&userId=${userId}`
    default:
      return `${API_BASE}/chat?msg=${encodeURIComponent(content)}&userId=${userId}`
  }
}

async function sendToBackend(currentMode, content) {
  const res = await fetch(buildUrl(currentMode, content))
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  return data.data ?? data.msg ?? String(data)
}

async function clearHistoryBackend() {
  const res = await fetch(`${API_BASE}/clearHistory?userId=${userId}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  return data.data ?? '聊天历史已清空'
}

function emptyModeBuckets() {
  return MODE_IDS.reduce((acc, mode) => {
    acc[mode] = []
    return acc
  }, {})
}

function mountApp({ createApp, ref, computed, reactive, nextTick, onMounted }) {
  createApp({
    setup() {
      const currentPage = ref('chat')
      const modeMessages = reactive(emptyModeBuckets())
      const loading = ref(false)
      const inputText = ref('')
      const scrollEl = ref(null)
      const taRef = ref(null)
      const platformItems = ref([])
      const platformUpdatedAt = ref('')
      const infoLoading = ref(false)
      const infoError = ref('')

      const currentMode = computed(() => (MODE_IDS.includes(currentPage.value) ? currentPage.value : 'chat'))
      const currentModeConfig = computed(() => MODE_CONFIG[currentMode.value])
      const currentMessages = computed(() => modeMessages[currentMode.value])
      const showInput = computed(() => currentPage.value !== 'platformInfo')
      const pageTitle = computed(() =>
        currentPage.value === 'platformInfo' ? '平台资料库' : `模式页 · ${currentModeConfig.value.label}`,
      )

      const placeholder = computed(
        () => `在「${currentModeConfig.value.label}」页面输入：${currentModeConfig.value.placeholder}`,
      )

      function scrollBottom() {
        nextTick(() => {
          if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight
        })
      }

      function adjustTa() {
        const el = taRef.value
        if (!el) return
        el.style.height = '52px'
        el.style.height = `${Math.min(el.scrollHeight, 160)}px`
      }

      function pushModeMsg(mode, role, content, isLoading) {
        modeMessages[mode].push({ id: uid(), role, content, loading: !!isLoading })
      }

      function updateLoadRow(mode, id, content, loadingState) {
        const i = modeMessages[mode].findIndex((m) => m.id === id)
        if (i >= 0) modeMessages[mode][i] = { ...modeMessages[mode][i], content, loading: loadingState }
      }

      async function handleSend() {
        if (!showInput.value) return
        const text = inputText.value.trim()
        if (!text || loading.value) return

        const mode = currentMode.value
        pushModeMsg(mode, 'user', text, false)
        inputText.value = ''
        if (taRef.value) taRef.value.style.height = '52px'

        const loadId = uid()
        modeMessages[mode].push({ id: loadId, role: 'ai', content: '正在思考…', loading: true })
        loading.value = true
        scrollBottom()

        try {
          const reply = await sendToBackend(mode, text)
          updateLoadRow(mode, loadId, reply, false)
        } catch (err) {
          updateLoadRow(mode, loadId, `请求失败：${err.message || err}`, false)
        } finally {
          loading.value = false
          scrollBottom()
        }
      }

      function selectPage(id) {
        currentPage.value = id
        if (MODE_IDS.includes(id)) {
          pushModeMsg(id, 'ai', `已进入「${MODE_CONFIG[id].label}」独立页面，可在此模式继续对话。`, false)
          scrollBottom()
        } else if (id === 'platformInfo' && platformItems.value.length === 0 && !infoLoading.value) {
          loadPlatformKnowledge()
        }
      }

      function newChat() {
        if (MODE_IDS.includes(currentPage.value)) {
          modeMessages[currentPage.value] = []
        } else {
          MODE_IDS.forEach((m) => {
            modeMessages[m] = []
          })
        }
      }

      async function clearHistory() {
        if (!confirm('确定清空当前数据并同步清空服务端会话历史吗？')) return
        try {
          const msg = await clearHistoryBackend()
          if (MODE_IDS.includes(currentPage.value)) {
            modeMessages[currentPage.value] = []
            pushModeMsg(currentPage.value, 'ai', msg, false)
          } else {
            MODE_IDS.forEach((m) => {
              modeMessages[m] = []
            })
          }
          scrollBottom()
        } catch (err) {
          if (MODE_IDS.includes(currentPage.value)) {
            pushModeMsg(currentPage.value, 'ai', `清空失败：${err.message || err}`, false)
          }
        }
      }

      function onKeydown(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          handleSend()
        }
      }

      async function loadPlatformKnowledge() {
        infoLoading.value = true
        infoError.value = ''
        try {
          const res = await fetch(`${API_BASE}/data/platform-knowledge.json`)
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const data = await res.json()
          platformItems.value = data.items || []
          platformUpdatedAt.value = data.updatedAt || ''
        } catch (err) {
          infoError.value = `资料加载失败：${err.message || err}`
        } finally {
          infoLoading.value = false
        }
      }

      onMounted(() => {
        loadPlatformKnowledge()
      })

      return {
        NAV_ITEMS,
        currentPage,
        currentMode,
        currentModeConfig,
        currentMessages,
        showInput,
        pageTitle,
        placeholder,
        loading,
        inputText,
        scrollEl,
        taRef,
        platformItems,
        platformUpdatedAt,
        infoLoading,
        infoError,
        adjustTa,
        handleSend,
        selectPage,
        newChat,
        clearHistory,
        onKeydown,
      }
    },
    template: `
      <div class="app-root">
        <aside class="sidebar">
          <a class="mm-link-home" href="/">← 返回多模态首页</a>
          <div class="brand">
            <img class="logo" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'%3E%3Crect width='48' height='48' rx='10' fill='%230066cc'/%3E%3Ctext x='24' y='32' text-anchor='middle' fill='white' font-size='16' font-family='system-ui,sans-serif'%3EAI%3C/text%3E%3C/svg%3E" alt="多模态平台" />
            <div class="brand-text">
              <span class="brand-title">多模态平台</span>
              <span class="brand-sub">文本对话 · 智能分析</span>
            </div>
          </div>
          <button type="button" class="new-chat" @click="newChat">
            <span>➕</span><span>新对话</span>
          </button>
          <nav class="nav" aria-label="功能菜单">
            <button
              v-for="item in NAV_ITEMS"
              :key="item.id"
              type="button"
              class="nav-item"
              :class="{ active: currentPage === item.id }"
              @click="selectPage(item.id)"
            >
              <span class="nav-emoji">{{ item.emoji }}</span>
              <span>{{ item.label }}</span>
            </button>
          </nav>
          <div class="sidebar-foot">
            <p class="motto">文本 · 多模态统一入口</p>
            <button type="button" class="ghost-btn" @click="clearHistory">清空聊天历史</button>
          </div>
        </aside>

        <div class="main">
          <header class="header">
            <div class="header-left">
              <span class="model-pill">Vue 3</span>
              <span class="header-sep" aria-hidden="true"></span>
              <h1 class="header-title">{{ pageTitle }}</h1>
            </div>
            <div class="header-right">
              <span class="chip"><span class="dot" aria-hidden="true"></span> 页面：{{ currentPage }}</span>
              <span class="status-long">在线 · 多模态智能分析</span>
            </div>
          </header>

          <div ref="scrollEl" class="chat-scroll">
            <section v-if="currentPage === 'platformInfo'" class="info-page">
              <div class="info-page-head">
                <h2>平台资料（本地 JSON）</h2>
                <p>内置示例条目，可自行替换 <code>/data/platform-knowledge.json</code> 中的内容与链接。</p>
                <p v-if="platformUpdatedAt" class="info-updated">最近更新：{{ platformUpdatedAt }}</p>
              </div>
              <p v-if="infoLoading" class="info-tip">正在加载资料...</p>
              <p v-else-if="infoError" class="info-tip error">{{ infoError }}</p>
              <div v-else class="info-grid">
                <article v-for="item in platformItems" :key="item.id" class="info-card">
                  <div class="info-tag">{{ item.category }}</div>
                  <h3>{{ item.title }}</h3>
                  <p>{{ item.summary }}</p>
                  <div class="info-actions">
                    <a :href="item.url" target="_blank" rel="noreferrer">查看来源</a>
                  </div>
                </article>
              </div>
            </section>

            <template v-else>
              <div v-if="currentMessages.length === 0" class="empty-wrap">
                <section class="welcome mode-page">
                  <div class="welcome-hero">
                    <h2 class="welcome-title">{{ currentModeConfig.emoji }} {{ currentModeConfig.label }} 页面</h2>
                    <p class="welcome-sub">每个模式都是独立页面，历史消息按模式隔离保存。</p>
                  </div>
                  <div class="welcome-card">
                    <p class="welcome-lead">示例输入：{{ currentModeConfig.placeholder }}</p>
                    <ul class="welcome-grid">
                      <li><span>🧩</span>多模态统一主题</li>
                      <li><span>🧭</span>模式切换即页面切换</li>
                      <li><span>📦</span>公开信息本地化保存</li>
                      <li><span>⚡</span>CDN 与本地双重兜底</li>
                    </ul>
                  </div>
                </section>
              </div>
              <div v-else class="msg-list">
                <div v-for="m in currentMessages" :key="m.id" class="row" :class="m.role">
                  <div class="avatar" :class="m.role === 'ai' ? 'avatar-ai' : 'avatar-user'" aria-hidden="true">
                    <span>{{ m.role === 'ai' ? 'AI' : '我' }}</span>
                  </div>
                  <div class="bubble-wrap">
                    <div class="bubble" :class="{ loading: m.loading }">{{ m.content }}</div>
                  </div>
                </div>
              </div>
            </template>
          </div>

          <div v-if="showInput" class="input-shell">
            <div class="input-inner">
              <textarea
                ref="taRef"
                v-model="inputText"
                class="ta"
                rows="1"
                :disabled="loading"
                :placeholder="placeholder"
                @input="adjustTa"
                @keydown="onKeydown"
              />
              <button type="button" class="send-btn" :disabled="loading || !inputText.trim()" @click="handleSend">
                发送
              </button>
            </div>
            <p class="input-hint">Enter 发送 · Shift+Enter 换行 · 当前模式独立页面：{{ currentModeConfig.label }}</p>
          </div>
        </div>
      </div>
    `,
  }).mount('#app')
}

function renderStartupError(err) {
  const app = document.getElementById('app')
  if (!app) return
  app.innerHTML = `
    <div style="height:100%;display:flex;align-items:center;justify-content:center;padding:24px;color:#e5e7eb;background:#171717;font-family:'Microsoft YaHei',sans-serif;">
      <div style="max-width:720px;background:#202123;border:1px solid #374151;border-radius:12px;padding:20px 22px;line-height:1.6;">
        <h2 style="margin:0 0 10px;color:#60a5fa;font-size:18px;">多模态平台初始化失败</h2>
        <p style="margin:0 0 8px;">前端依赖加载超时，请检查网络或稍后重试。</p>
        <p style="margin:0;color:#9ca3af;font-size:12px;word-break:break-all;">${String(err?.message ?? err)}</p>
      </div>
    </div>
  `
}

async function bootstrap() {
  try {
    const vue = await loadVueModule()
    mountApp(vue)
  } catch (err) {
    console.error('[Multimodal] 启动失败:', err)
    renderStartupError(err)
  }
}

bootstrap()
