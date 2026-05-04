<script setup>
defineProps({
  funcLabel: { type: String, default: '智能对话' },
})
</script>

<template>
  <header class="header">
    <div class="left">
      <span class="model-pill">
        <i class="fas fa-graduation-cap" aria-hidden="true"></i>
        铜院助手
      </span>
      <span class="sep" aria-hidden="true"></span>
      <h1 class="title">铜仁学院校园 AI 助手</h1>
    </div>
    <div class="right">
      <span class="chip">
        <span class="dot" aria-hidden="true"></span>
        当前：{{ funcLabel }}
      </span>
      <span class="status">在线 · 校园专属服务</span>
    </div>
  </header>
</template>

<style scoped>
.header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px var(--chat-pad-x);
  border-bottom: 1px solid var(--border-subtle);
  background: rgba(23, 23, 23, 0.92);
  backdrop-filter: blur(10px);
}

.left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.model-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--trcu-primary);
  background: rgba(0, 102, 204, 0.12);
  border: 1px solid rgba(0, 102, 204, 0.35);
  padding: 6px 10px;
  border-radius: 999px;
  white-space: nowrap;
}

.sep {
  width: 1px;
  height: 18px;
  background: var(--border-subtle);
}

.title {
  font-size: 16px;
  font-weight: 600;
  color: #f9fafb;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.right {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text-secondary);
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 8px;
  background: #2d2e30;
  color: #d1d5db;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #22c55e;
  box-shadow: 0 0 8px rgba(34, 197, 94, 0.6);
}

.status {
  display: none;
}

@media (min-width: 900px) {
  .status {
    display: inline;
  }
}
</style>
