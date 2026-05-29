const fs = require('fs')
const path = require('path')

function safeRm(targetPath, recursive = false) {
  try {
    fs.rmSync(targetPath, { force: true, recursive })
  } catch {}
}

function main() {
  const root = path.resolve(__dirname, '..')
  const releaseRoot = path.join(root, 'release')
  const releaseDir = path.join(releaseRoot, 'build')
  const unpackedDir = path.join(releaseDir, 'win-unpacked')

  safeRm(unpackedDir, true)

  try {
    const names = fs.readdirSync(releaseDir)
    for (const name of names) {
      if (name.endsWith('.exe') || name.endsWith('.blockmap')) {
        safeRm(path.join(releaseDir, name), false)
      }
    }
  } catch {
    // release/build directory may not exist yet
  }
}

main()
