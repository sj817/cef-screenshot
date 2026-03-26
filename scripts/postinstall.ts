// scripts/postinstall.ts — npm 安装后自动下载 CEF 运行时
// .node 绑定通过 cef-screenshot-{platform} 子包分发
// CEF 运行时（~300MB）从 GitHub Releases 下载并解压到子包目录

import { existsSync, mkdirSync, createWriteStream, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { get as httpsGet } from 'node:https'
import { get as httpGet, type IncomingMessage } from 'node:http'

const __dirname = dirname(fileURLToPath(import.meta.url))
const _require = createRequire(import.meta.url)
const ROOT_DIR = join(__dirname, '..')

const pkg = _require(join(ROOT_DIR, 'package.json'))
const VERSION = pkg.version as string

const HELPER_NAME = process.platform === 'win32'
  ? 'cef_screenshot_helper.exe'
  : 'cef_screenshot_helper'

const PLATFORM_PKG_MAP: Record<string, Record<string, string>> = {
  win32:  { x64: 'win32-x64-msvc', arm64: 'win32-arm64-msvc' },
  linux:  { x64: 'linux-x64-gnu', arm64: 'linux-arm64-gnu', arm: 'linux-arm-gnueabihf' },
  darwin: { x64: 'darwin-x64', arm64: 'darwin-arm64' },
}

const GITHUB_REPO = 'sj817/cef-screenshot'

function getDownloadUrl(suffix: string): string {
  const mirrorUrl = pkg['cef-screenshot']?.mirrorUrl
  const base = mirrorUrl || `https://github.com/${GITHUB_REPO}/releases/download/v${VERSION}`
  return `${base}/cef-screenshot-runtime-${suffix}-v${VERSION}.tar.gz`
}

function followRedirects(url: string, maxRedirects = 5): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'))
    const getter = url.startsWith('https') ? httpsGet : httpGet
    getter(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        followRedirects(res.headers.location, maxRedirects - 1).then(resolve, reject)
      } else if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
        resolve(res)
      } else {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`))
      }
    }).on('error', reject)
  })
}

function download(url: string, dest: string): Promise<void> {
  return new Promise(async (resolve, reject) => {
    try {
      const res = await followRedirects(url)
      const file = createWriteStream(dest)
      res.pipe(file)
      file.on('finish', () => { file.close(); resolve() })
      file.on('error', (err) => { file.close(); reject(err) })
      res.on('error', (err) => { file.close(); reject(err) })
    } catch (err) {
      reject(err)
    }
  })
}

async function main() {
  const suffix = PLATFORM_PKG_MAP[process.platform]?.[process.arch]

  // 1. 开发环境：本地构建已存在
  const devDir = join(ROOT_DIR, 'cef-helper', 'build', 'Release')
  if (existsSync(join(devDir, HELPER_NAME))) {
    return
  }

  if (!suffix) {
    console.log(`[cef-screenshot] 当前平台不受支持: ${process.platform}-${process.arch}`)
    return
  }

  // 2. 检查子包中是否已有 CEF 运行时
  let pkgDir: string
  try {
    pkgDir = dirname(_require.resolve(`cef-screenshot-${suffix}/package.json`))
  } catch {
    console.log(`[cef-screenshot] 平台子包 cef-screenshot-${suffix} 未安装`)
    return
  }

  if (existsSync(join(pkgDir, HELPER_NAME))) {
    return // 已就绪
  }

  // 3. 从 GitHub Releases 下载 CEF 运行时
  const url = getDownloadUrl(suffix)
  const tarball = join(pkgDir, `cef-runtime-${suffix}.tar.gz`)

  console.log(`[cef-screenshot] 下载 CEF 运行时...`)
  console.log(`  ${url}`)

  try {
    await download(url, tarball)
  } catch (err: any) {
    console.error(`[cef-screenshot] 下载失败: ${err.message}`)
    console.error(`  请手动下载: ${url}`)
    console.error(`  解压到: ${pkgDir}`)
    return
  }

  // 4. 解压
  console.log(`[cef-screenshot] 解压 CEF 运行时到 ${pkgDir} ...`)
  try {
    execSync(`tar -xzf "${tarball}" -C "${pkgDir}"`, { stdio: 'pipe' })
  } catch {
    // Windows 上可能需要 System32\tar.exe
    try {
      const winTar = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\tar.exe`
      execSync(`"${winTar}" -xzf "${tarball}" -C "${pkgDir}"`, { stdio: 'pipe' })
    } catch (err: any) {
      console.error(`[cef-screenshot] 解压失败: ${err.message}`)
      return
    }
  }

  // 5. 清理 tarball
  try { unlinkSync(tarball) } catch {}

  if (existsSync(join(pkgDir, HELPER_NAME))) {
    console.log('[cef-screenshot] CEF 运行时安装完成')
  } else {
    console.error('[cef-screenshot] CEF 运行时解压后未找到 helper，请检查归档内容')
  }
}

main().catch(console.error)
