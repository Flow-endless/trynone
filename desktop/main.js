/**
 * Electron 主进程：无独立控制台窗口启动本机 Spring Boot，再打开窗口。
 *
 * 端口与 application.yml 中 server.port 一致；可用环境变量 APP_PORT 覆盖。
 * 开发：JAR 位于项目 ../target/deepseek-0.0.1-SNAPSHOT.jar
 * 打包：JAR 位于 resources/backend/（由 electron-builder extraResources 复制）
 */
const { app, BrowserWindow, shell, dialog, session, Menu } = require('electron')
const path = require('path')
const fs = require('fs')
const http = require('http')
const { spawn, execFileSync } = require('child_process')

const PORT = process.env.APP_PORT || '8081'
const JAR_NAME = 'deepseek-0.0.1-SNAPSHOT.jar'
const START_URL = process.env.APP_URL || `http://127.0.0.1:${PORT}/index.html`
const WAIT_ROOT_MS = parseInt(process.env.BACKEND_WAIT_MS || '120000', 10)

let mainWindow = null
/** @type {import('child_process').ChildProcess | null} */
let backendChild = null
let backendStartedByUs = false
/** start-all.bat 拉起 Java 时写入的 PID，退出桌面时结束该进程以释放端口 */
let externalBackendPidToStop = null

function getJarPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'backend', JAR_NAME)
  }
  return path.join(__dirname, '..', 'target', JAR_NAME)
}

function getBackendPidFilePath() {
  if (app.isPackaged) {
    return path.join(app.getPath('userData'), 'deepseek-backend.pid')
  }
  return path.join(__dirname, '..', 'deepseek-backend.pid')
}

function readBackendPidFile() {
  const pidPath = getBackendPidFilePath()
  try {
    const raw = fs.readFileSync(pidPath, 'utf8').trim()
    const pid = parseInt(raw, 10)
    if (Number.isFinite(pid) && pid > 0) return pid
  } catch {
    /* no file */
  }
  return null
}

function stopExternalBackendIfFromBat() {
  if (process.env.SKIP_EMBEDDED_JAVA !== '1') return
  const pidPath = getBackendPidFilePath()
  const pid = externalBackendPidToStop ?? readBackendPidFile()
  externalBackendPidToStop = null
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
    } else {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* 进程已结束等 */
  }
  try {
    fs.unlinkSync(pidPath)
  } catch {
    /* ignore */
  }
}

function getJavaExecutable() {
  const home = process.env.JAVA_HOME
  if (home) {
    const javaExe =
      process.platform === 'win32'
        ? path.join(home, 'bin', 'java.exe')
        : path.join(home, 'bin', 'java')
    if (fs.existsSync(javaExe)) return javaExe
  }
  return process.platform === 'win32' ? 'java.exe' : 'java'
}

/**
 * 等待本机 Tomcat 已对 HTTP 作出响应（任意状态码均可，含 404）。
 * 之前用 fetch + res.ok 探测根路径 /，若 Spring 对 / 非 2xx，会永远等不到，Electron 窗口不会创建。
 */
function waitForBackendHttp(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  const port = Number(PORT) || 8081
  return new Promise((resolve) => {
    function tryOnce() {
      if (Date.now() >= deadline) {
        resolve(false)
        return
      }
      const req = http.get(
        {
          hostname: '127.0.0.1',
          port,
          path: '/index.html',
          timeout: 4000,
        },
        (res) => {
          res.resume()
          resolve(true)
        }
      )
      req.on('error', () => {
        setTimeout(tryOnce, 1000)
      })
      req.on('timeout', () => {
        req.destroy()
        setTimeout(tryOnce, 1000)
      })
    }
    tryOnce()
  })
}

/**
 * @returns {Promise<boolean>}
 */
async function ensureBackend() {
  const skipEmbedded = process.env.SKIP_EMBEDDED_JAVA === '1'
  const firstWaitMs = skipEmbedded ? WAIT_ROOT_MS : 3000

  if (await waitForBackendHttp(firstWaitMs)) {
    if (skipEmbedded) {
      externalBackendPidToStop = readBackendPidFile()
    }
    return true
  }

  if (skipEmbedded) {
    await dialog.showErrorBox(
      '后端未就绪',
      `未检测到 http://127.0.0.1:${PORT} 可用。\n请用项目根目录 start-all 启动（会先起 Java），或先在本机启动 Spring Boot 后再开桌面端。`
    )
    app.quit()
    return false
  }

  const jarPath = getJarPath()
  if (!fs.existsSync(jarPath)) {
    const hint = app.isPackaged
      ? `未找到内置 JAR：\n${jarPath}`
      : `未找到 ${JAR_NAME}。请先在项目根目录执行：\nmvn package -DskipTests\n\n期望路径：\n${jarPath}`
    await dialog.showErrorBox('无法启动后端', hint)
    app.quit()
    return false
  }

  const java = getJavaExecutable()
  const logPath = path.join(app.getPath('userData'), 'deepseek-backend.log')
  try {
    fs.writeFileSync(
      logPath,
      `[${new Date().toISOString()}] 启动: ${java} -jar ${jarPath}\r\n`,
      { encoding: 'utf8' }
    )
  } catch {
    /* ignore */
  }
  const logStream = fs.createWriteStream(logPath, { flags: 'a' })
  const spawnOpts = {
    windowsHide: true,
    stdio: ['ignore', logStream, logStream],
    env: { ...process.env },
  }

  backendChild = spawn(java, ['-jar', jarPath], spawnOpts)

  const spawnOk = await new Promise((resolve) => {
    backendChild.once('error', async (err) => {
      await dialog.showErrorBox(
        '无法启动 Java',
        `请安装 JDK 并配置 PATH 或 JAVA_HOME。\n\n${String(err?.message ?? err)}`
      )
      app.quit()
      resolve(false)
    })
    backendChild.once('spawn', () => resolve(true))
  })

  if (!spawnOk) {
    backendChild = null
    return false
  }

  backendStartedByUs = true
  backendChild.on('error', async (err) => {
    await dialog.showErrorBox('后端进程错误', String(err?.message ?? err))
  })
  backendChild.on('exit', (code, signal) => {
    if (!backendStartedByUs) return
    if (code !== 0 && code !== null && signal == null) {
      try {
        logStream.end()
      } catch {
        /* ignore */
      }
      dialog.showErrorBox(
        '后端已退出',
        `Java 进程退出，代码 ${code}。常见原因：端口 ${PORT} 已被占用、JDK 版本不兼容、或配置/依赖错误。\n\n请打开日志查看详细原因：\n${logPath}`
      )
    }
  })

  if (!(await waitForBackendHttp(WAIT_ROOT_MS))) {
    await dialog.showErrorBox(
      '后端启动超时',
      `在 ${WAIT_ROOT_MS / 1000}s 内未检测到 http://127.0.0.1:${PORT}/index.html 有响应。\n请确认本机已安装 Java 8+，且端口 ${PORT} 未被占用。`
    )
    stopBackendIfNeeded()
    app.quit()
    return false
  }
  return true
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'AI 多模态智能分析平台',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    show: false,
  })

  mainWindow.once('ready-to-show', () => mainWindow.show())

  const openUrl = START_URL + (String(START_URL).includes('?') ? '&' : '?') + 'mmv=' + Date.now()
  mainWindow.loadURL(openUrl, { extraHeaders: 'Pragma: no-cache\r\n' }).catch(() => {
    mainWindow.loadFile(path.join(__dirname, 'offline.html'))
  })

  const isMac = process.platform === 'darwin'
  const menuTemplate = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : [
          {
            label: '文件',
            submenu: [{ role: 'quit', label: '退出' }],
          },
        ]),
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload' },
        {
          label: '强制重新加载(忽略缓存)',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => {
            if (mainWindow) mainWindow.webContents.reloadIgnoringCache()
          },
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate))

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function stopBackendIfNeeded() {
  if (!backendStartedByUs || !backendChild) return
  try {
    backendChild.kill()
  } catch {
    /* ignore */
  }
  backendChild = null
  backendStartedByUs = false
}

app.whenReady().then(async () => {
  // 本机后端 HTML/JS：避免 Chromium 磁盘缓存导致一直看到旧版多模态界面
  const filter = { urls: ['http://127.0.0.1/*', 'http://localhost/*'] }
  session.defaultSession.webRequest.onHeadersReceived(filter, (details, callback) => {
    const h = { ...details.responseHeaders }
    h['Cache-Control'] = ['no-store, no-cache, must-revalidate, max-age=0']
    h['Pragma'] = ['no-cache']
    callback({ responseHeaders: h })
  })
  try {
    await session.defaultSession.clearCache()
  } catch {
    /* ignore */
  }
  const ok = await ensureBackend()
  if (!ok) return
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  stopBackendIfNeeded()
  stopExternalBackendIfFromBat()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
