/**
 * 多模态页面统一解析后端根地址：
 * - file:// 打开 → 固定走 127.0.0.1:8081（与后端、Electron 一致）
 * - http://localhost:5500 等 Live Server / IDE 预览 → 页面与后端不同端口，需显式指向 :8081
 * - 已在 http://localhost:8081 下访问 → 同源，返回空字符串即可
 */
window.mmResolveApiBase = function mmResolveApiBase() {
  if (typeof window === 'undefined') return ''
  if (window.location.protocol === 'file:') {
    // 与 Spring / 桌面端默认地址一致；Windows 下 localhost 可能走 ::1，与 127.0.0.1 行为不一致易触发跨域或连接失败
    return 'http://127.0.0.1:8081'
  }
  const host = window.location.hostname
  const port = window.location.port
  const isLocal = host === 'localhost' || host === '127.0.0.1'
  if (isLocal && port && port !== '8081') {
    return 'http://' + host + ':8081'
  }
  return ''
}
