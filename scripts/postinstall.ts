// scripts/postinstall.ts — npm 安装后检查 CEF 运行时是否就绪
// CEF 运行时通过 @cef-screenshot 平台子包自动分发，无需手动下载

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

const PLATFORM_PKG_MAP: Record<string, Record<string, string>> = {
  win32:  { x64: 'win32-x64-msvc', arm64: 'win32-arm64-msvc' },
  linux:  { x64: 'linux-x64-gnu', arm64: 'linux-arm64-gnu', arm: 'linux-arm-gnueabihf' },
  darwin: { x64: 'darwin-x64', arm64: 'darwin-arm64' },
}

function main() {
  // 1. 从 npm 平台子包检查
  const suffix = PLATFORM_PKG_MAP[process.platform]?.[process.arch]
  if (suffix) {
    try {
      const pkgDir = dirname(_require.resolve(`@cef-screenshot/${suffix}/package.json`))
      if (existsSync(join(pkgDir, HELPER_NAME))) {
        return // CEF 运行时已就绪
      }
    } catch {}
  }

  // 2. 开发环境本地构建
  const devDir = join(ROOT_DIR, 'cef-helper', 'build', 'Release')
  if (existsSync(join(devDir, HELPER_NAME))) {
    return // 本地构建已存在
  }

  // 3. 未找到 CEF 运行时
  if (!suffix) {
    console.log(`[cef-screenshot] 当前平台不受支持: ${process.platform}-${process.arch}`)
    return
  }

  console.log('[cef-screenshot] CEF 运行时未就绪。')
  console.log('  开发者请运行: pnpm run setup')
}

main()
