<script setup>
const props = defineProps({
  currentFunc: { type: String, required: true },
})

const emit = defineEmits(['select-func', 'clear-history', 'new-chat'])

const items = [
  { id: 'chat', icon: 'fa-comments', label: '智能对话' },
  { id: 'summary', icon: 'fa-file-alt', label: '文本总结' },
  { id: 'translate', icon: 'fa-language', label: '文本翻译' },
  { id: 'polish', icon: 'fa-pen-fancy', label: '文本润色' },
  { id: 'code', icon: 'fa-code', label: '代码生成' },
  { id: 'study', icon: 'fa-book-open', label: '学习助手' },
  { id: 'write', icon: 'fa-pencil-alt', label: '文案创作' },
  { id: 'analyze', icon: 'fa-clipboard-check', label: '错题分析' },
  { id: 'plan', icon: 'fa-calendar-alt', label: '计划生成' },
]
</script>

<template>
  <aside class="sidebar">
    <div class="brand">
      <img
        src="https://www.gztrc.edu.cn/_upload/site/00/02/200/logo.png"
        alt="铜仁学院校徽"
        class="logo"
      />
      <div class="brand-text">
        <span class="title">铜仁学院</span>
        <span class="subtitle">校园 AI 助手 · 铜院专属</span>
      </div>
    </div>

    <button type="button" class="new-chat" @click="emit('new-chat')">
      <i class="fas fa-plus" aria-hidden="true"></i>
      <span>新对话</span>
    </button>

    <nav class="nav" aria-label="功能菜单">
      <button
        v-for="m in items"
        :key="m.id"
        type="button"
        class="nav-item"
        :class="{ active: props.currentFunc === m.id }"
        @click="emit('select-func', m.id)"
      >
        <i class="fas" :class="m.icon" aria-hidden="true"></i>
        <span>{{ m.label }}</span>
      </button>
    </nav>

    <div class="sidebar-foot">
      <p class="motto">校训：明德 · 致用</p>
      <button type="button" class="ghost" @click="emit('clear-history')">
        <i class="fas fa-trash-alt" aria-hidden="true"></i>
        清空聊天历史
      </button>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  width: var(--sidebar-width);
  min-width: var(--sidebar-width);
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
  padding: 14px 12px;
  gap: 12px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border-subtle);
}

.logo {
  width: 40px;
  height: 40px;
  border-radius: 8px;
  object-fit: contain;
  background: #fff;
  padding: 2px;
}

.brand-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.title {
  font-size: 15px;
  font-weight: 700;
  color: #fff;
  letter-spacing: 0.02em;
}

.subtitle {
  font-size: 11px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.new-chat {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--border-subtle);
  background: transparent;
  color: var(--text-primary);
  font-size: 14px;
  cursor: pointer;
  transition:
    background 0.15s,
    border-color 0.15s;
}

.new-chat:hover {
  background: var(--bg-elevated);
  border-color: #4b5563;
}

.nav {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-right: 2px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s;
}

.nav-item:hover {
  background: var(--bg-elevated);
}

.nav-item.active {
  background: #343541;
  color: var(--trcu-primary);
}

.nav-item i {
  width: 18px;
  text-align: center;
  opacity: 0.9;
}

.sidebar-foot {
  padding-top: 12px;
  border-top: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.motto {
  font-size: 11px;
  color: #6b7280;
  text-align: center;
  line-height: 1.4;
}

.ghost {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px;
  border-radius: 8px;
  border: none;
  background: #343541;
  color: var(--text-primary);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s;
}

.ghost:hover {
  background: #40414f;
}

@media (max-width: 768px) {
  .sidebar {
    width: 72px;
    min-width: 72px;
    padding: 10px 8px;
  }
  .brand-text,
  .subtitle,
  .motto,
  .nav-item span,
  .new-chat span {
    display: none;
  }
  .new-chat {
    padding: 10px;
  }
  .nav-item {
    justify-content: center;
    padding: 12px 8px;
  }
}
</style>
