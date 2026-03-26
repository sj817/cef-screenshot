// scripts/postinstall.ts — npm 安装后自动下载 CEF 运行时
// 仅在目标目录不存在时触发下载；开发环境（本地构建已存在）自动跳过

import { existsSync, mkdirSync, createWriteStream, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { get as httpsGet } from 'node:https'
import { get as httpGet } from 'node:http'
import { execSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const _require = createRequire(import.meta.url)

const ROOT_DIR = join(__dirname, '..')
const RUNTIME_DIR = join(ROOT_DIR, 'cef-runtime')
const HELPER_EXE = join(RUNTIME_DIR, 'cef_screenshot_helper.exe')

// 开发环境下的可执行文件路径
const DEV_EXE = join(ROOT_DIR, 'cef-helper', 'build', 'Release', 'cef_screenshot_helper.exe')

function getDownloadUrl(): string | null {
  // 优先级：环境变量 > package.json 配置
  if (process.env.CEF_SCREENSHOT_CDN) {
    const base = process.env.CEF_SCREENSHOT_CDN.replace(/\/$/, '')
    const pkg = _require(join(ROOT_DIR, 'package.json'))
    return `${base}/cef-screenshot-runtime-win32-x64-v${pkg.version}.tar.gz`
  }

  const pkg = _require(join(ROOT_DIR, 'package.json'))
  const mirror: string = pkg['cef-screenshot']?.mirrorUrl
  if (mirror) {
    const base = mirror.replace(/\/$/, '')
    return `${base}/cef-screenshot-runtime-win32-x64-v${pkg.version}.tar.gz`
  }
  return null
}

function download(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? httpsGet : httpGet
    const file = createWriteStream(dest)

    function doGet(currentUrl: string) {
      ;(proto as typeof httpsGet)(currentUrl, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          file.close()
          return doGet(response.headers.location!)
        }
        if (response.statusCode !== 200) {
          file.close()
          if (existsSync(dest)) unlinkSync(dest)
          return reject(new Error(`HTTP ${response.statusCode}: ${currentUrl}`))
        }
        const total = parseInt(response.headers['content-length'] as string, 10)
        let downloaded = 0
        let lastPercent = 0
        response.on('data', (chunk: Buffer) => {
          downloaded += chunk.length
          if (total) {
            const pct = Math.floor((downloaded / total) * 100)
            if (pct >= lastPercent + 10) {
              process.stdout.write(`\r  [cef-screenshot] 正在下载运行时: ${pct}%`)
              lastPercent = pct
            }
          }
        })
        response.pipe(file)
        file.on('finish', () => { file.close(); console.log(''); resolve() })
      }).on('error', (err: Error) => {
        file.close()
        if (existsSync(dest)) unlinkSync(dest)
        reject(err)
      })
    }
    doGet(url)
  })
}

async function main() {
  // 运行时已存在，无需下载
  if (existsSync(HELPER_EXE)) return

  // 开发环境本地构建已存在，跳过
  if (existsSync(DEV_EXE)) return

  // 仅支持 Windows
  if (process.platform !== 'win32') {
    console.log('[cef-screenshot] 跳过：当前仅支持 win32-x64 平台。')
    return
  }

  const url = getDownloadUrl()
  if (!url) {
    console.log('[cef-screenshot] 未配置运行时下载地址。')
    console.log('  开发者请运行: pnpm run setup')
    console.log('  发布用户请设置: CEF_SCREENSHOT_CDN 环境变量  或  package.json "cef-screenshot.mirrorUrl"')
    return
  }

  console.log('[cef-screenshot] 正在下载 CEF 运行时...')
  mkdirSync(RUNTIME_DIR, { recursive: true })

  const tmpPath = join(RUNTIME_DIR, '_runtime.tar.gz')
  try {
    await download(url, tmpPath)
    console.log('[cef-screenshot] 正在解压运行时...')
    execSync(`tar -xzf "${tmpPath}" -C "${RUNTIME_DIR}"`, { stdio: 'inherit' })
    unlinkSync(tmpPath)
    console.log('[cef-screenshot] CEF 运行时安装完成。')
  } catch (err: any) {
    if (existsSync(tmpPath)) unlinkSync(tmpPath)
    console.error('[cef-screenshot] 下载失败:', err.message)
    console.error('  请手动下载并解压到 cef-runtime/ 目录')
  }
}

main().catch(() => {})
