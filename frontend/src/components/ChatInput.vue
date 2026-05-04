<script setup>
import { ref, watch, nextTick } from 'vue'

const props = defineProps({
  disabled: Boolean,
  placeholder: { type: String, default: '' },
})

const emit = defineEmits(['send'])

const text = ref('')
const ta = ref(null)

function adjustHeight() {
  const el = ta.value
  if (!el) return
  el.style.height = '52px'
  const max = 160
  el.style.height = `${Math.min(el.scrollHeight, max)}px`
}

watch(text, () => nextTick(adjustHeight))

function onSend() {
  const v = text.value.trim()
  if (!v || props.disabled) return
  emit('send', v)
  text.value = ''
  nextTick(adjustHeight)
}

function onKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    onSend()
  }
}
</script>

<template>
  <div class="input-shell">
    <div class="inner">
      <textarea
        ref="ta"
        v-model="text"
        class="ta"
        rows="1"
        :disabled="disabled"
        :placeholder="placeholder"
        @keydown="onKeydown"
        @input="adjustHeight"
      />
      <button
        type="button"
        class="send"
        :disabled="disabled || !text.trim()"
        :aria-label="'发送'"
        @click="onSend"
      >
        <i class="fas fa-arrow-up" aria-hidden="true"></i>
      </button>
    </div>
    <p class="hint">Enter 发送 · Shift+Enter 换行 · 铜仁学院校内服务</p>
  </div>
</template>

<style scoped>
.input-shell {
  padding: 16px var(--chat-pad-x) 22px;
  background: linear-gradient(to top, rgba(23, 23, 23, 0.98) 55%, rgba(23, 23, 23, 0));
  border-top: 1px solid var(--border-subtle);
}

.inner {
  max-width: var(--content-max);
  margin: 0 auto;
  display: flex;
  align-items: flex-end;
  gap: 10px;
  padding: 10px 12px 10px 16px;
  border-radius: 20px;
  border: 1px solid #3f3f46;
  background: var(--bg-input);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}

.inner:focus-within {
  border-color: rgba(0, 102, 204, 0.65);
  box-shadow: 0 0 0 1px rgba(0, 102, 204, 0.2);
}

.ta {
  flex: 1;
  min-height: 52px;
  max-height: 160px;
  resize: none;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.55;
  padding: 8px 0;
  font-family: inherit;
}

.ta::placeholder {
  color: #6b7280;
}

.send {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  flex-shrink: 0;
  background: var(--trcu-primary);
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  transition:
    background 0.15s,
    transform 0.1s;
}

.send:hover:not(:disabled) {
  background: var(--trcu-primary-hover);
}

.send:active:not(:disabled) {
  transform: scale(0.96);
}

.send:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.hint {
  max-width: var(--content-max);
  margin: 10px auto 0;
  text-align: center;
  font-size: 11px;
  color: #6b7280;
}
</style>
