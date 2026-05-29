const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const pngPath = path.join(root, 'web', 'public', 'voidcsv.png')
const icoPath = path.join(root, 'web', 'public', 'voidcsv.ico')
const buildDir = path.join(root, 'build')
const buildIcoPath = path.join(buildDir, 'icon.ico')

function runPython(args) {
  const candidates = [
    ['python', args],
    ['py', ['-3', ...args]],
    ['python3', args],
  ]
  for (const [cmd, argv] of candidates) {
    const result = spawnSync(cmd, argv, { stdio: 'inherit', env: process.env })
    if (result.error?.code === 'ENOENT') continue
    if (result.status === 0) return
    throw new Error(`${cmd} failed with status ${result.status ?? 'unknown'}`)
  }
  throw new Error('Python not found (tried python, py -3, python3)')
}

function main() {
  if (!fs.existsSync(pngPath)) {
    throw new Error(`icon source not found: ${pngPath}`)
  }

  fs.mkdirSync(buildDir, { recursive: true })

  const pyScript = path.join(__dirname, 'sync-icon.py')
  runPython([pyScript])

  if (!fs.existsSync(icoPath)) {
    throw new Error(`ICO was not created: ${icoPath}`)
  }

  fs.copyFileSync(icoPath, buildIcoPath)
  console.log(`[icon] synced: ${icoPath}`)
  console.log(`[icon] synced: ${buildIcoPath}`)
}

main()
