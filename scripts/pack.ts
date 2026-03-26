// scripts/pack.ts — 打包 CEF 运行时归档
// 将 cef-helper/build/Release/ 压缩为可分发的 tar.gz
// 输出：dist/cef-screenshot-runtime-win32-x64-v{version}.tar.gz

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const _require = createRequire(import.meta.url)

const ROOT_DIR = join(__dirname, '..')
const RELEASE_DIR = join(ROOT_DIR, 'cef-helper', 'build', 'Release')
const DIST_DIR = join(ROOT_DIR, 'dist')
const pkg = _require(join(ROOT_DIR, 'package.json'))

// 打包时排除的文件扩展名（调试/链接产物）
const EXCLUDE_EXTS = new Set(['.lib', '.pdb', '.exp', '.ilk', '.iobj', '.ipdb'])

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
  if (!existsSync(join(RELEASE_DIR, 'cef_screenshot_helper.exe'))) {
    console.error('错误：在以下目录未找到 cef_screenshot_helper.exe：', RELEASE_DIR)
    console.error('请先运行 pnpm run setup 编译 C++ 辅助进程。')
    process.exit(1)
  }
  if (!existsSync(join(RELEASE_DIR, 'libcef.dll'))) {
    console.error('错误：未找到 libcef.dll，CEF 运行时文件尚未复制到 Release/ 目录。')
    process.exit(1)
  }

  mkdirSync(DIST_DIR, { recursive: true })

  const archiveName = `cef-screenshot-runtime-win32-x64-v${pkg.version}.tar.gz`
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
