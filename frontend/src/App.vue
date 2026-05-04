<script setup>
import { ref, computed, nextTick } from 'vue'
import AppSidebar from './components/AppSidebar.vue'
import ChatHeader from './components/ChatHeader.vue'
import ChatWelcome from './components/ChatWelcome.vue'
import MessageRow from './components/MessageRow.vue'
import ChatInput from './components/ChatInput.vue'
import { sendToBackend, clearHistoryBackend, getFuncName } from './composables/useChatApi.js'

const currentFunc = ref('chat')
const messages = ref([])
const loading = ref(false)

const funcLabel = computed(() => getFuncName(currentFunc.value))

const placeholder = computed(
  () =>
    `向铜院助手提问（${funcLabel.value}）— 例如：总结《计算机网络》要点、生成 Java 快排、制定期末复习周计划…`,
)

function scrollToBottom(el) {
  if (!el) return
  el.scrollTop = el.scrollHeight
}

const scrollEl = ref(null)

function pushMsg(role, content, isLoading = false) {
  messages.value.push({ id: crypto.randomUUID(), role, content, loading: isLoading })
  nextTick(() => scrollToBottom(scrollEl.value))
}

function setLoadingRow(id, content, loadingState) {
  const i = messages.value.findIndex((m) => m.id === id)
  if (i >= 0) {
    messages.value[i] = { ...messages.value[i], content, loading: loadingState }
  }
}

async function handleSend(text) {
  pushMsg('user', text)
  const loadId = crypto.randomUUID()
  messages.value.push({ id: loadId, role: 'ai', content: '正在思考…', loading: true })
  loading.value = true
  await nextTick(() => scrollToBottom(scrollEl.value))

  try {
    const reply = await sendToBackend(currentFunc.value, text)
    setLoadingRow(loadId, reply, false)
  } catch (e) {
    setLoadingRow(loadId, `请求失败：${e.message || e}`, false)
  } finally {
    loading.value = false
    await nextTick(() => scrollToBottom(scrollEl.value))
  }
}

function selectFunc(id) {
  currentFunc.value = id
  pushMsg('ai', `已切换到「${getFuncName(id)}」。可直接输入内容开始提问。`)
}

function newChat() {
  messages.value = []
}

async function clearHistory() {
  if (!confirm('确定清空本地展示记录并同步清空服务端该用户的会话历史吗？')) return
  try {
    const msg = await clearHistoryBackend()
    messages.value = []
    pushMsg('ai', msg)
  } catch (e) {
    pushMsg('ai', `清空失败：${e.message || e}`)
  }
}
</script>

<template>
  <div class="app-root">
    <AppSidebar
      :current-func="currentFunc"
      @select-func="selectFunc"
      @clear-history="clearHistory"
      @new-chat="newChat"
    />

    <div class="main">
      <ChatHeader :func-label="funcLabel" />

      <div ref="scrollEl" class="chat-scroll">
        <div v-if="messages.length === 0" class="empty">
          <ChatWelcome />
        </div>
        <div v-else class="msg-list">
          <MessageRow
            v-for="m in messages"
            :key="m.id"
            :role="m.role"
            :content="m.content"
            :loading="m.loading"
          />
        </div>
      </div>

      <ChatInput :disabled="loading" :placeholder="placeholder" @send="handleSend" />
    </div>
  </div>
</template>

<style scoped>
.app-root {
  display: flex;
  height: 100%;
  min-height: 0;
}

.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  height: 100%;
}

.chat-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 22px var(--chat-pad-x) 10px;
  scroll-behavior: smooth;
}

.empty {
  min-height: 100%;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 5vh;
}

.msg-list {
  display: flex;
  flex-direction: column;
  gap: 22px;
  align-items: stretch;
  max-width: var(--content-max);
  margin: 0 auto;
  width: 100%;
  padding-bottom: 20px;
}
</style>
