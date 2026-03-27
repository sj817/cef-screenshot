// scripts/postinstall.mjs — npm 安装后检查 CEF 运行时
// CEF 运行时通过 cef-screenshot-{platform} 子包直接分发（npm 内置）

import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const _require = createRequire(import.meta.url)
const ROOT_DIR = join(__dirname, '..')

const HELPER_NAME = process.platform === 'win32'
  ? 'cef_screenshot_helper.exe'
  : 'cef_screenshot_helper'

const PLATFORM_PKG_MAP = {
  win32:  { x64: 'win32-x64-msvc', arm64: 'win32-arm64-msvc' },
  linux:  { x64: 'linux-x64-gnu', arm64: 'linux-arm64-gnu', arm: 'linux-arm-gnueabihf' },
  darwin: { x64: 'darwin-x64', arm64: 'darwin-arm64' },
}

function main() {
  // 开发环境：本地构建已存在
  const devDir = join(ROOT_DIR, 'cef-helper', 'build', 'Release')
  if (existsSync(join(devDir, HELPER_NAME))) return

  const suffix = PLATFORM_PKG_MAP[process.platform]?.[process.arch]
  if (!suffix) {
    console.log(`[cef-screenshot] 当前平台不受支持: ${process.platform}-${process.arch}`)
    return
  }

  let pkgDir
  try {
    pkgDir = dirname(_require.resolve(`cef-screenshot-${suffix}/package.json`))
  } catch {
    console.log(`[cef-screenshot] 平台子包 cef-screenshot-${suffix} 未安装`)
    return
  }

  if (existsSync(join(pkgDir, HELPER_NAME))) {
    console.log('[cef-screenshot] CEF 运行时已就绪')
  } else {
    console.warn(
      `[cef-screenshot] 警告: 在 ${pkgDir} 中未找到 CEF 运行时文件\n` +
      `  请确认 cef-screenshot-${suffix} 子包已正确安装`
    )
  }
}

main()
