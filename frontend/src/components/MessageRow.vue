<script setup>
import { computed } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

const props = defineProps({
  role: { type: String, required: true },
  content: { type: String, required: true },
  loading: Boolean,
})

marked.setOptions({
  gfm: true,
  breaks: true,
})

const htmlContent = computed(() => {
  if (props.loading || props.role !== 'ai') return ''
  const raw = marked.parse(props.content || '')
  return DOMPurify.sanitize(raw)
})
</script>

<template>
  <div class="row" :class="role">
    <div
      class="avatar"
      :class="role === 'ai' ? 'avatar-ai' : 'avatar-user'"
      aria-hidden="true"
    >
      <i :class="role === 'ai' ? 'fas fa-graduation-cap' : 'fas fa-user'" />
    </div>
    <div class="bubble-wrap">
      <div
        class="bubble"
        :class="{
          loading,
          'bubble-ai': role === 'ai' && !loading,
          'bubble-user': role === 'user',
        }"
      >
        <template v-if="loading">
          {{ content }}
        </template>
        <div v-else-if="role === 'ai'" class="md-body" v-html="htmlContent" />
        <div v-else class="plain">{{ content }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.row {
  display: flex;
  gap: 14px;
  width: 100%;
  align-items: flex-start;
}

.row.user {
  flex-direction: row-reverse;
}

.avatar {
  width: 38px;
  height: 38px;
  border-radius: 11px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  margin-top: 2px;
}

.avatar-ai {
  background: linear-gradient(135deg, var(--trcu-primary), var(--trcu-dark));
  color: #fff;
  box-shadow: 0 2px 12px rgba(0, 102, 204, 0.25);
}

.avatar-user {
  background: #343541;
  color: #f3f4f6;
}

.bubble-wrap {
  min-width: 0;
  flex: 1;
  display: flex;
}

.row.user .bubble-wrap {
  justify-content: flex-end;
}

.bubble {
  padding: 12px 16px;
  border-radius: 16px;
  font-size: 14px;
  line-height: 1.65;
  word-break: break-word;
  max-width: min(100%, 720px);
}

.bubble-ai {
  padding: 14px 18px;
  border-radius: 16px;
  border-top-left-radius: 5px;
  background: var(--bg-bubble-ai);
  border: 1px solid rgba(55, 65, 81, 0.65);
  color: var(--text-primary);
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.04) inset;
}

.bubble-user {
  background: linear-gradient(135deg, var(--trcu-primary), var(--trcu-dark));
  color: #fff;
  border-top-right-radius: 5px;
  border: 1px solid rgba(255, 255, 255, 0.12);
}

.plain {
  white-space: pre-wrap;
}

.bubble.loading {
  color: var(--text-secondary);
  font-style: italic;
  animation: pulse 1.2s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}
</style>
