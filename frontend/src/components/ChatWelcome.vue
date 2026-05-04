<template>
  <section class="welcome">
    <div class="hero">
      <h2 class="hero-title">铜仁学院 · 校园 AI 助手</h2>
      <p class="hero-sub">
        立足黔东，面向师生 —— 课程答疑、论文润色、代码与计划一站完成。
      </p>
    </div>
    <div class="card">
      <p class="lead">
        接入 DeepSeek 能力，专为本校场景优化。试一试下方示例问题，或直接在底部输入框提问。
      </p>
      <ul class="features">
        <li><span class="emoji">📚</span>课程知识点解析</li>
        <li><span class="emoji">✍️</span>论文 / 作业润色</li>
        <li><span class="emoji">💻</span>编程与实验代码</li>
        <li><span class="emoji">📝</span>复习与周计划</li>
      </ul>
    </div>
    <p class="footnote">川硐教育园区 · 铜仁学院</p>
  </section>
</template>

<style scoped>
.welcome {
  max-width: min(var(--content-max), 720px);
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 22px;
  padding: 8px 4px 28px;
  width: 100%;
}

.hero {
  text-align: center;
}

.hero-title {
  font-size: 1.35rem;
  font-weight: 700;
  color: var(--trcu-primary);
  margin-bottom: 8px;
  letter-spacing: 0.03em;
}

.hero-sub {
  font-size: 0.9rem;
  color: var(--text-secondary);
  line-height: 1.55;
}

.card {
  background: linear-gradient(145deg, #1f2023 0%, #25262c 100%);
  border: 1px solid var(--border-subtle);
  border-radius: 16px;
  padding: 20px 22px;
}

.lead {
  font-size: 0.9rem;
  color: #d1d5db;
  line-height: 1.65;
  margin-bottom: 16px;
}

.features {
  list-style: none;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.features li {
  font-size: 0.8rem;
  color: #e5e7eb;
  background: rgba(45, 46, 48, 0.85);
  padding: 10px 12px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.emoji {
  font-size: 1rem;
}

.footnote {
  text-align: center;
  font-size: 11px;
  color: #6b7280;
}

@media (max-width: 520px) {
  .features {
    grid-template-columns: 1fr;
  }
}
</style>
