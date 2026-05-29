const path = require('path')

/**
 * electron-builder skips rcedit when signAndEditExecutable is false,
 * so the unpacked exe keeps the default Electron icon. Embed ours here.
 */
module.exports = async function embedWinIcon(context) {
  if (context.electronPlatformName !== 'win32') return

  const productName = context.packager.appInfo.productFilename
  const exePath = path.join(context.appOutDir, `${productName}.exe`)
  const iconPath = path.join(context.packager.projectDir, 'build', 'icon.ico')

  const rcedit = require('rcedit')
  await rcedit(exePath, { icon: iconPath })
  console.log(`[embed-win-icon] ${exePath} <- ${iconPath}`)
}
