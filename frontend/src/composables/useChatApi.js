const userId = 'default'

/** 开发时代理到后端；生产与 Spring 同域用相对路径 */
function apiBase() {
  return import.meta.env.DEV ? '' : ''
}

function getFuncName(func) {
  const map = {
    chat: '智能对话',
    summary: '文本总结',
    translate: '文本翻译',
    polish: '文本润色',
    code: '代码生成',
    study: '学习助手',
    write: '文案创作',
    analyze: '错题分析',
    plan: '计划生成',
  }
  return map[func] || '智能对话'
}

function buildUrl(currentFunc, content) {
  const base = apiBase()
  switch (currentFunc) {
    case 'chat':
      return `${base}/chat?msg=${encodeURIComponent(content)}&userId=${userId}`
    case 'summary':
    case 'translate':
    case 'polish':
      return `${base}/processText?type=${currentFunc}&content=${encodeURIComponent(content)}&userId=${userId}`
    case 'code':
      return `${base}/generateCode?language=Java&requirement=${encodeURIComponent(content)}&userId=${userId}`
    case 'study':
      return `${base}/study?subject=${encodeURIComponent(content)}&userId=${userId}`
    case 'write':
      return `${base}/write?topic=${encodeURIComponent(content)}&userId=${userId}`
    case 'analyze':
      return `${base}/analyze?question=${encodeURIComponent(content)}&userId=${userId}`
    case 'plan':
      return `${base}/plan?goal=${encodeURIComponent(content)}&userId=${userId}`
    default:
      return `${base}/chat?msg=${encodeURIComponent(content)}&userId=${userId}`
  }
}

export async function sendToBackend(currentFunc, content) {
  const url = buildUrl(currentFunc, content)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  return data.data ?? data.msg ?? String(data)
}

export async function clearHistoryBackend() {
  const base = apiBase()
  const res = await fetch(`${base}/clearHistory?userId=${userId}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()).data ?? '聊天历史已清空'
}

export { getFuncName, userId }
