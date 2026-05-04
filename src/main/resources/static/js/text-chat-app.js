/**
 * text.html 专用：高级感对话 UI，保留与 app.js 一致的后端调用约定
 */
// ES 模块里 import 的相对路径以「当前脚本 URL」为基准，./vendor 会错误解析成 /js/vendor/…
// 使用 import.meta.url 指向与脚本同级的 ../vendor，才能命中 Spring 静态目录下的 /vendor/vue.esm-browser.js
const VUE_LOCAL = new URL('../vendor/vue.esm-browser.js', import.meta.url).href

const VUE_CDN_CANDIDATES = [
  VUE_LOCAL,
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

const MODE_CONFIG = {
  chat: { label: '智能对话', icon: 'fa-comments', placeholder: '输入消息，Enter 发送，Shift+Enter 换行…' },
  summary: { label: '文本总结', icon: 'fa-file-lines', placeholder: '粘贴需要总结的文本…' },
  translate: { label: '文本翻译', icon: 'fa-language', placeholder: '输入要翻译的内容…' },
  polish: { label: '文本润色', icon: 'fa-sparkles', placeholder: '输入需要润色的段落…' },
  code: { label: '代码生成', icon: 'fa-code', placeholder: '描述你的编程需求…' },
  study: { label: '学习助手', icon: 'fa-book', placeholder: '输入学习主题或问题…' },
  write: { label: '文案创作', icon: 'fa-pen', placeholder: '输入创作主题与要求…' },
  analyze: { label: '错题分析', icon: 'fa-magnifying-glass', placeholder: '粘贴题目或描述疑问…' },
  plan: { label: '计划生成', icon: 'fa-calendar', placeholder: '描述目标与时间范围…' },
}

const MODE_ORDER = ['chat', 'summary', 'translate', 'polish', 'code', 'study', 'write', 'analyze', 'plan']

function uid() {
  return `tc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

function importWithTimeout(url, timeoutMs = 8000) {
  return Promise.race([
    import(url),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Load timeout: ${url}`)), timeoutMs)),
  ])
}

async function loadVueModule() {
  let lastError = null
  for (const url of VUE_CDN_CANDIDATES) {
    try {
      return await importWithTimeout(url)
    } catch (err) {
      lastError = err
      console.warn('[text-chat] Vue load failed, next:', url, err)
    }
  }
  throw lastError ?? new Error('无法加载 Vue')
}

function buildUrl(mode, content) {
  switch (mode) {
    case 'chat':
      return `${API_BASE}/chat?msg=${encodeURIComponent(content)}&userId=${userId}`
    case 'summary':
    case 'translate':
    case 'polish':
      return `${API_BASE}/processText?type=${mode}&content=${encodeURIComponent(content)}&userId=${userId}`
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

async function sendToBackend(mode, content) {
  const res = await fetch(buildUrl(mode, content))
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

function setupMarkedAndHljs() {
  const { marked, hljs, DOMPurify } = window
  if (!marked || !hljs) return { parseMd: (t) => String(t).replace(/</g, '&lt;') }

  if (typeof marked.setOptions === 'function') {
    marked.setOptions({
      breaks: true,
      gfm: true,
      highlight(code, lang) {
        try {
          if (lang && hljs.getLanguage(lang)) {
            return hljs.highlight(code, { language: lang }).value
          }
          return hljs.highlightAuto(code).value
        } catch {
          return hljs.highlightAuto(code).value
        }
      },
    })
  }

  const parseMd = (raw) => {
    const text = raw ?? ''
    try {
      const html =
        typeof marked.parse === 'function' ? marked.parse(text) : typeof marked === 'function' ? marked(text) : String(text)
      return DOMPurify ? DOMPurify.sanitize(html) : html
    } catch (e) {
      console.warn('[text-chat] markdown parse failed', e)
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br/>')
    }
  }

  return { parseMd }
}

const TEXT_SESSION_KEY = 'mm_text_session_v1'

function mountApp(vue) {
  const { createApp, ref, computed, nextTick, onMounted, watch } = vue
  const { parseMd } = setupMarkedAndHljs()

  createApp({
    setup() {
      const currentMode = ref('chat')
      const messages = ref([])
      const loading = ref(false)
      const inputText = ref('')
      const scrollEl = ref(null)
      const taRef = ref(null)

      const modeMeta = computed(() => MODE_CONFIG[currentMode.value] || MODE_CONFIG.chat)

      const placeholder = computed(() => modeMeta.value.placeholder)

      function scrollToBottom() {
        nextTick(() => {
          const el = scrollEl.value
          if (!el) return
          el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
        })
      }

      function adjustTa() {
        const el = taRef.value
        if (!el) return
        el.style.height = '52px'
        el.style.height = `${Math.min(el.scrollHeight, 180)}px`
      }

      function pushAiSystem(text) {
        messages.value.push({ id: uid(), role: 'ai', content: text, loading: false })
        scrollToBottom()
        nextTick(() => {
          if (window.hljs) window.hljs.highlightAll()
        })
      }

      async function handleSend() {
        const text = inputText.value.trim()
        if (!text || loading.value) return

        messages.value.push({ id: uid(), role: 'user', content: text })
        inputText.value = ''
        if (taRef.value) taRef.value.style.height = '52px'

        const loadId = uid()
        messages.value.push({ id: loadId, role: 'ai', content: '正在思考…', loading: true })
        loading.value = true
        scrollToBottom()

        try {
          const reply = await sendToBackend(currentMode.value, text)
          const i = messages.value.findIndex((m) => m.id === loadId)
          if (i >= 0) {
            messages.value[i] = { ...messages.value[i], content: reply, loading: false }
          }
          if (typeof window !== 'undefined' && window.mmHistory) {
            try {
              const mode = currentMode.value
              const label = MODE_CONFIG[mode]?.label || mode
              window.mmHistory.appendEntry({
                module: 'text',
                title: `${label} · ${text.slice(0, 48)}${text.length > 48 ? '…' : ''}`,
                snippet: String(reply || '').slice(0, 2500),
                data: { mode, user: text, reply: String(reply || '') },
              })
            } catch (err) {
              console.warn('[text-chat] history', err)
            }
          }
        } catch (e) {
          const i = messages.value.findIndex((m) => m.id === loadId)
          if (i >= 0) {
            messages.value[i] = {
              ...messages.value[i],
              content: `请求失败：${e.message || e}`,
              loading: false,
            }
          }
        } finally {
          loading.value = false
          scrollToBottom()
          nextTick(() => {
            if (window.hljs) window.hljs.highlightAll()
          })
        }
      }

      async function clearChat() {
        if (!messages.value.length) return
        if (!confirm('确定清空当前对话并同步清空服务端该用户的会话历史吗？')) return
        try {
          const msg = await clearHistoryBackend()
          messages.value = []
          try {
            sessionStorage.removeItem(TEXT_SESSION_KEY)
          } catch (_) {}
          pushAiSystem(msg)
        } catch (e) {
          pushAiSystem(`清空失败：${e.message || e}`)
        }
      }

      function newChat() {
        try {
          sessionStorage.removeItem(TEXT_SESSION_KEY)
        } catch (_) {}
        messages.value = []
        pushAiSystem('已开始新对话。输入内容即可继续。')
      }

      function selectMode(id) {
        currentMode.value = id
        pushAiSystem(`已切换为「${MODE_CONFIG[id].label}」，后续消息将按该模式调用后端接口。`)
      }

      function renderAiHtml(content) {
        if (!content) return ''
        return parseMd(content)
      }

      function onKeydown(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          handleSend()
        }
      }

      function stripResumeParam() {
        try {
          const u = new URL(window.location.href)
          if (!u.searchParams.has('mmResume')) return
          u.searchParams.delete('mmResume')
          window.history.replaceState({}, '', u.pathname + u.search + u.hash)
        } catch (_) {}
      }

      let persistTextTimer = null
      function snapshotTextSessionJson() {
        return JSON.stringify({
          v: 1,
          mode: currentMode.value,
          messages: messages.value.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            loading: !!m.loading,
          })),
        })
      }
      function schedulePersistTextSession() {
        clearTimeout(persistTextTimer)
        persistTextTimer = setTimeout(() => {
          try {
            sessionStorage.setItem(TEXT_SESSION_KEY, snapshotTextSessionJson())
          } catch (_) {}
        }, 400)
      }
      function flushTextSessionNow() {
        clearTimeout(persistTextTimer)
        try {
          sessionStorage.setItem(TEXT_SESSION_KEY, snapshotTextSessionJson())
        } catch (_) {}
      }

      watch(
        [messages, currentMode],
        () => schedulePersistTextSession(),
        { deep: true },
      )

      onMounted(() => {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'hidden') {
            flushTextSessionNow()
          }
        })
        try {
          const params = new URLSearchParams(window.location.search)
          const rid = params.get('mmResume')
          if (rid && window.mmHistory) {
            const entry = window.mmHistory.getEntry(rid)
            if (entry && entry.module === 'text' && entry.data) {
              const d = entry.data
              if (d.mode && MODE_CONFIG[d.mode]) currentMode.value = d.mode
              const restored = []
              if (d.user) restored.push({ id: uid(), role: 'user', content: String(d.user), loading: false })
              if (d.reply != null && String(d.reply).length)
                restored.push({ id: uid(), role: 'ai', content: String(d.reply), loading: false })
              if (restored.length) {
                messages.value = restored
                stripResumeParam()
                scrollToBottom()
                nextTick(() => {
                  if (window.hljs) window.hljs.highlightAll()
                })
                schedulePersistTextSession()
                return
              }
            }
          }
        } catch (e) {
          console.warn('[text-chat] resume from history', e)
        }
        try {
          const raw = sessionStorage.getItem(TEXT_SESSION_KEY)
          if (raw) {
            const p = JSON.parse(raw)
            if (p && p.v === 1 && Array.isArray(p.messages) && p.messages.length) {
              messages.value = p.messages.map((m) => ({
                id: m.id || uid(),
                role: m.role === 'user' ? 'user' : 'ai',
                content: String(m.content || ''),
                loading: !!m.loading,
              }))
              if (p.mode && MODE_CONFIG[p.mode]) currentMode.value = p.mode
              scrollToBottom()
              nextTick(() => {
                if (window.hljs) window.hljs.highlightAll()
              })
              return
            }
          }
        } catch (_) {}
        pushAiSystem('你好，我是本平台的 AI 助手。左侧可切换功能模式，支持 Markdown 与代码高亮。')
      })

      return {
        MODE_ORDER,
        MODE_CONFIG,
        currentMode,
        messages,
        loading,
        inputText,
        scrollEl,
        taRef,
        placeholder,
        modeMeta,
        adjustTa,
        handleSend,
        clearChat,
        newChat,
        selectMode,
        renderAiHtml,
        onKeydown,
      }
    },
    template: `
      <div class="tc-layout">
        <aside class="tc-sidebar">
          <div class="tc-brand">
            <div class="tc-brand-icon"><i class="fa-solid fa-layer-group"></i></div>
            <div>
              <h2>多模态工作台</h2>
              <p>模式 · 历史 · 快捷入口</p>
            </div>
          </div>
          <nav class="mm-cross-nav" aria-label="功能模块">
            <span class="mm-cross-nav__title">模块切换</span>
            <div class="mm-cross-nav__links">
              <a href="./index.html" class="mm-cross-nav__link">首页</a>
              <a href="./text.html" class="mm-cross-nav__link" aria-current="page">文本</a>
              <a href="./image.html" class="mm-cross-nav__link">图片</a>
              <a href="./audio.html" class="mm-cross-nav__link">音频</a>
              <a href="./video.html" class="mm-cross-nav__link">视频</a>
              <a href="./history.html" class="mm-cross-nav__link">历史</a>
            </div>
          </nav>
          <div class="tc-section-title">功能模式</div>
          <nav class="tc-mode-list" aria-label="功能模式">
            <button
              v-for="id in MODE_ORDER"
              :key="id"
              type="button"
              class="tc-mode-btn"
              :class="{ active: currentMode === id }"
              @click="selectMode(id)"
            >
              <i class="fa-solid" :class="MODE_CONFIG[id].icon"></i>
              <span>{{ MODE_CONFIG[id].label }}</span>
            </button>
          </nav>
          <p class="tc-history-hint">对话记录已写入「历史记录」页（本机浏览器），可按关键字与时间检索。</p>
        </aside>

        <div class="tc-main">
          <header class="tc-header">
            <h1>AI 多模态助手</h1>
            <span class="tc-header-badge">当前：{{ modeMeta.label }}</span>
          </header>

          <div class="tc-chat-wrap">
            <div ref="scrollEl" class="tc-chat-scroll">
              <div v-if="messages.length === 0" class="tc-empty">
                <h3>开始对话</h3>
                <p>支持 Markdown 渲染、代码高亮与列表。底部可清空对话或开始新对话。</p>
              </div>
              <div
                v-for="m in messages"
                :key="m.id"
                class="tc-msg-row"
                :class="m.role"
              >
                <div class="tc-msg-avatar" aria-hidden="true">
                  <i v-if="m.role === 'ai'" class="fa-solid fa-robot"></i>
                  <i v-else class="fa-solid fa-user"></i>
                </div>
                <div
                  v-if="m.role === 'user'"
                  class="tc-msg-bubble user-plain"
                >{{ m.content }}</div>
                <div v-else class="tc-msg-bubble">
                  <div v-if="m.loading" class="tc-loading">正在思考…</div>
                  <div v-else class="tc-md" v-html="renderAiHtml(m.content)"></div>
                </div>
              </div>
            </div>
          </div>

          <div class="tc-input-dock">
            <div class="tc-input-inner">
              <div class="tc-toolbar">
                <button type="button" class="tc-btn-ghost" @click="newChat">
                  <i class="fa-solid fa-plus"></i> 新对话
                </button>
                <button type="button" class="tc-btn-ghost" @click="clearChat">
                  <i class="fa-solid fa-trash-can"></i> 清空对话
                </button>
              </div>
              <div class="tc-input-row">
                <textarea
                  ref="taRef"
                  v-model="inputText"
                  rows="1"
                  :disabled="loading"
                  :placeholder="placeholder"
                  @input="adjustTa"
                  @keydown="onKeydown"
                ></textarea>
                <button
                  type="button"
                  class="tc-send"
                  :disabled="loading || !inputText.trim()"
                  aria-label="发送"
                  @click="handleSend"
                >
                  <i class="fa-solid fa-paper-plane"></i>
                </button>
              </div>
              <p class="tc-hint">Enter 发送 · Shift+Enter 换行 · 与后端 <code>/chat</code> 等接口一致</p>
            </div>
          </div>
        </div>
      </div>
    `,
  }).mount('#app')
}

function renderFatal(err) {
  const el = document.getElementById('app')
  if (!el) return
  el.innerHTML = `<div style="padding:40px;color:#fecaca;font-family:sans-serif;">加载失败：${String(err?.message ?? err)}</div>`
}

async function bootstrap() {
  try {
    const vue = await loadVueModule()
    mountApp(vue)
  } catch (e) {
    console.error(e)
    renderFatal(e)
  }
}

bootstrap()
