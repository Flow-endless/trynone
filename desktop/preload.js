/**
 * 预加载脚本（保持最小，不暴露 Node 给页面）
 */
const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('desktopApp', {
  mode: 'electron',
})
