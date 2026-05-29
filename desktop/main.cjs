const path = require('path')
const fs = require('fs')
const http = require('http')
const { spawn } = require('child_process')
const express = require('express')
const { createProxyMiddleware } = require('http-proxy-middleware')
const { app, BrowserWindow } = require('electron')

if (process.platform === 'win32') {
  app.setAppUserModelId('com.voidcsv.desktop')
}

const ENGINE_PORT = Number(process.env.ENGINE_PORT || 8787)
const RENDERER_PORT = Number(process.env.RENDERER_PORT || 5188)
const RENDERER_HOST = '127.0.0.1'

let mainWindow = null
let engineProc = null
let rendererServer = null

function getAppAssetPath(...parts) {
  return path.join(app.getAppPath(), ...parts)
}

function getPackagedUnpackedPath(...parts) {
  return path.join(process.resourcesPath, 'app.asar.unpacked', ...parts)
}

function pickExistingPath(candidates) {
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p
  }
  return candidates[0]
}

function killEngineProcess() {
  if (!engineProc) return
  try {
    engineProc.kill()
  } catch {}
  engineProc = null
}

function closeRendererServer() {
  if (!rendererServer) return
  try {
    rendererServer.close()
  } catch {}
  rendererServer = null
}

function startEngineProcess() {
  const engineRunner = getAppAssetPath('desktop', 'engine-runner.cjs')
  const engineEntry = app.isPackaged
    ? pickExistingPath([
        getPackagedUnpackedPath('engine', 'src', 'index.js'),
        getAppAssetPath('engine', 'src', 'index.js'),
      ])
    : getAppAssetPath('engine', 'src', 'index.js')
  const uploadDir = path.join(app.getPath('userData'), 'uploads')
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true })

  engineProc = spawn(process.execPath, [engineRunner, engineEntry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: app.isPackaged ? 'production' : 'development',
      PORT: String(ENGINE_PORT),
      HOST: RENDERER_HOST,
      UPLOAD_DIR: uploadDir,
    },
    stdio: 'pipe',
    windowsHide: true,
  })

  engineProc.stdout?.on('data', (buf) => {
    process.stdout.write(`[engine] ${buf}`)
  })
  engineProc.stderr?.on('data', (buf) => {
    process.stderr.write(`[engine] ${buf}`)
  })
  engineProc.on('exit', (code, signal) => {
    process.stdout.write(`[engine] exited code=${code} signal=${signal}\n`)
    engineProc = null
  })
}

function waitForEngineReady(timeoutMs = 15000) {
  const startedAt = Date.now()

  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.get(`http://${RENDERER_HOST}:${ENGINE_PORT}/`, (res) => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
          res.resume()
          resolve()
          return
        }
        res.resume()
        retry()
      })

      req.on('error', retry)
      req.setTimeout(1500, () => {
        req.destroy(new Error('timeout'))
      })
    }

    const retry = () => {
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`engine not ready within ${timeoutMs}ms`))
        return
      }
      setTimeout(check, 250)
    }

    check()
  })
}

function startProdRendererServer() {
  const distDir = getAppAssetPath('web', 'dist')
  const indexHtml = path.join(distDir, 'index.html')
  if (!fs.existsSync(indexHtml)) {
    throw new Error(`Renderer build not found: ${indexHtml}`)
  }

  const webApp = express()
  webApp.use(
    '/api',
    createProxyMiddleware({
      target: `http://${RENDERER_HOST}:${ENGINE_PORT}`,
      changeOrigin: false,
    }),
  )
  webApp.use(express.static(distDir))
  webApp.get('*', (_req, res) => {
    res.sendFile(indexHtml)
  })

  return new Promise((resolve, reject) => {
    const server = webApp.listen(RENDERER_PORT, RENDERER_HOST, () => {
      rendererServer = server
      resolve()
    })
    server.on('error', reject)
  })
}

function createMainWindow() {
  const iconIcoPath = getAppAssetPath('web', 'public', 'voidcsv.ico')
  const iconPngPath = getAppAssetPath('web', 'public', 'voidcsv.png')
  const iconPath =
    process.platform === 'win32' && fs.existsSync(iconIcoPath)
      ? iconIcoPath
      : fs.existsSync(iconPngPath)
        ? iconPngPath
        : iconIcoPath
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 920,
    minWidth: 1100,
    minHeight: 760,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: '#d8e4ef',
      height: 30,
    },
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const devUrl = process.env.ELECTRON_START_URL || 'http://127.0.0.1:5173'
  const prodUrl = `http://${RENDERER_HOST}:${RENDERER_PORT}`
  mainWindow.loadURL(app.isPackaged ? prodUrl : devUrl)

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

async function bootstrap() {
  startEngineProcess()
  await waitForEngineReady()
  if (app.isPackaged) {
    await startProdRendererServer()
  }
  createMainWindow()
}

app.whenReady().then(bootstrap).catch((err) => {
  process.stderr.write(`[desktop] failed to start: ${err?.stack || err}\n`)
  app.quit()
})

app.on('window-all-closed', () => {
  killEngineProcess()
  closeRendererServer()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  killEngineProcess()
  closeRendererServer()
})

