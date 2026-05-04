/**
 * 多模态前端路由配置（静态资源路径，与 Spring Boot 默认 static 映射一致）
 * 修改入口或新增页面时，请同步更新此文件。
 */
export const MULTIMODAL_ROUTES = {
  home: { path: '/', file: '/index.html', label: '多模态首页' },
  text: { path: '/text.html', file: '/text.html', label: '文本对话' },
  image: { path: '/image.html', file: '/image.html', label: '图片分析' },
  audio: { path: '/audio.html', file: '/audio.html', label: '音频处理' },
  video: { path: '/video.html', file: '/video.html', label: '视频分析' },
  history: { path: '/history.html', file: '/history.html', label: '历史记录' },
}

export const MULTIMODAL_ROUTE_LIST = Object.values(MULTIMODAL_ROUTES)

console.info('[multimodal] routes:', MULTIMODAL_ROUTE_LIST)
