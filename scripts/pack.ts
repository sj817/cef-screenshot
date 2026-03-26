// scripts/pack.ts — 打包 CEF 运行时归档（跨平台）
// 将 cef-helper/build/{platform}/Release/ 压缩为可分发的 tar.gz
// 用法：
//   pnpm run pack:runtime                              # 当前平台
//   pnpm run pack:runtime -- --target=x86_64-pc-windows-msvc

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { platform as osPlatform, arch as osArch } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const _require = createRequire(import.meta.url)

const ROOT_DIR = join(__dirname, '..')
const DIST_DIR = join(ROOT_DIR, 'dist')
const pkg = _require(join(ROOT_DIR, 'package.json'))

// 打包时排除的文件扩展名（调试/链接产物）
const EXCLUDE_EXTS = new Set(['.lib', '.pdb', '.exp', '.ilk', '.iobj', '.ipdb'])

// Rust target triple → CEF 平台名称
const TRIPLE_TO_CEF: Record<string, string> = {
  'x86_64-pc-windows-msvc':        'windows64',
  'aarch64-pc-windows-msvc':       'windowsarm64',
  'x86_64-unknown-linux-gnu':      'linux64',
  'aarch64-unknown-linux-gnu':     'linuxarm64',
  'armv7-unknown-linux-gnueabihf': 'linuxarm',
  'x86_64-apple-darwin':           'macosx64',
  'aarch64-apple-darwin':          'macosarm64',
}

// Rust target triple → npm 平台后缀
const TRIPLE_TO_NPM: Record<string, string> = {
  'x86_64-pc-windows-msvc':        'win32-x64-msvc',
  'aarch64-pc-windows-msvc':       'win32-arm64-msvc',
  'x86_64-unknown-linux-gnu':      'linux-x64-gnu',
  'aarch64-unknown-linux-gnu':     'linux-arm64-gnu',
  'armv7-unknown-linux-gnueabihf': 'linux-arm-gnueabihf',
  'x86_64-apple-darwin':           'darwin-x64',
  'aarch64-apple-darwin':          'darwin-arm64',
}

// 解析 --target 参数
const args = process.argv.slice(2)
const TARGET_ARG = args.find(a => a.startsWith('--target='))?.slice('--target='.length)

function detectTarget(): string {
  const p = osPlatform()
  const a = osArch()
  if (p === 'win32')  return a === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
  if (p === 'linux')  return a === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu'
  if (p === 'darwin') return a === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
  throw new Error(`不支持的平台: ${p} ${a}`)
}

const target = TARGET_ARG || detectTarget()
const cefPlatform = TRIPLE_TO_CEF[target]
const npmSuffix = TRIPLE_TO_NPM[target]
if (!cefPlatform || !npmSuffix) {
  console.error(`未知 target: ${target}`)
  process.exit(1)
}

const RELEASE_DIR = join(ROOT_DIR, 'cef-helper', 'build', cefPlatform, 'Release')

// helper 可执行文件名（Windows 带 .exe）
const helperExeName = target.includes('windows') ? 'cef_screenshot_helper.exe' : 'cef_screenshot_helper'
// CEF 主库名
const cefLibName = target.includes('windows') ? 'libcef.dll'
  : target.includes('darwin') ? 'Chromium Embedded Framework.framework'
  : 'libcef.so'

function calcDirSize(dir: string): number {
  let bytes = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fp = join(dir, entry.name)
    if (entry.isDirectory()) {
      bytes += calcDirSize(fp)
    } else if (!EXCLUDE_EXTS.has(extname(entry.name).toLowerCase())) {
      bytes += statSync(fp).size
    }
  }
  return bytes
}

function main() {
  if (!existsSync(join(RELEASE_DIR, helperExeName))) {
    console.error(`错误：在以下目录未找到 ${helperExeName}：`, RELEASE_DIR)
    console.error('请先运行 pnpm run setup 编译 C++ 辅助进程。')
    process.exit(1)
  }

  // macOS 用 framework 目录，Linux/Windows 用文件
  const cefLibPath = join(RELEASE_DIR, cefLibName)
  if (!existsSync(cefLibPath)) {
    console.error(`错误：未找到 ${cefLibName}，CEF 运行时文件尚未复制到 Release/ 目录。`)
    process.exit(1)
  }

  mkdirSync(DIST_DIR, { recursive: true })

  const archiveName = `cef-screenshot-runtime-${npmSuffix}-v${pkg.version}.tar.gz`
  const archivePath = join(DIST_DIR, archiveName)

  // 删除旧版本归档
  if (existsSync(archivePath)) unlinkSync(archivePath)

  // 统计文件数量
  const allFiles = readdirSync(RELEASE_DIR)
  const included = allFiles.filter(f => !EXCLUDE_EXTS.has(extname(f).toLowerCase()))
  console.log(`来源目录: ${RELEASE_DIR}`)
  console.log(`输出归档: ${archivePath}`)
  console.log(`文件数量: ${included.length}（已排除 ${allFiles.length - included.length} 个调试文件）`)

  // 统计未压缩体积
  const totalBytes = calcDirSize(RELEASE_DIR)
  console.log(`未压缩大小: ${(totalBytes / 1024 / 1024).toFixed(1)} MB`)

  // 构建排除参数
  const excludeFlags = [...EXCLUDE_EXTS].map(ext => `--exclude="*${ext}"`).join(' ')
  const cmd = `tar -czf "${archivePath}" ${excludeFlags} -C "${RELEASE_DIR}" .`

  console.log('\n正在压缩...')
  execSync(cmd, { stdio: 'inherit' })

  const archiveSize = statSync(archivePath).size
  const ratio = ((1 - archiveSize / totalBytes) * 100).toFixed(1)
  console.log(`\n归档大小: ${(archiveSize / 1024 / 1024).toFixed(1)} MB（压缩率 ${ratio}%）`)
  console.log(`\n完成！请将此文件上传到 GitHub Release 或 CDN。`)
  console.log(`用户通过以下方式配置下载地址：`)
  console.log(`  方式一：设置环境变量  CEF_SCREENSHOT_CDN=https://your-cdn.com/path/`)
  console.log(`  方式二：package.json  "cef-screenshot" > "mirrorUrl"`)
}

main()
