// index.ts — CEF Screenshot 主入口
// 封装 napi-rs 原生绑定，提供 TypeScript 类型声明

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 初始化选项 */
export interface InitOptions {
  /** 包含 cef_screenshot_helper.exe 和 CEF 运行时文件的目录 */
  helperDir?: string
  /** 并发浏览器槽位数量，默认 3，最大 10 */
  concurrency?: number
}

/** 截图选项 */
export interface ScreenshotOptions {
  /** 视窗宽度（像素），默认 1920 */
  width?: number
  /** 视窗高度（像素），默认 1080 */
  height?: number
  /** 页面加载完成后的额外等待时间（毫秒），默认 500 */
  delay?: number
}

interface NativeBinding {
  init(options?: InitOptions): Promise<void>
  screenshot(url: string, options?: ScreenshotOptions): Promise<Buffer>
  shutdown(): Promise<void>
}

// 延迟加载原生绑定，确保报错信息友好
const _require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
let _native: NativeBinding | null = null

function getNative(): NativeBinding {
  if (_native) return _native
  try {
    // napi build --js cef-screenshot.cjs 生成的 CJS 平台检测文件
    _native = _require('./cef-screenshot.cjs') as NativeBinding
    return _native
  } catch (e: any) {
    throw new Error(
      `无法加载原生绑定，请先运行 pnpm run build 编译项目\n` +
      `原始错误: ${e.message}`
    )
  }
}

// ── 自动解析 CEF 运行时所在目录 ──────────────────────────────────────────
const PLATFORM_PKG_MAP: Record<string, Record<string, string>> = {
  win32:  { x64: 'win32-x64-msvc', arm64: 'win32-arm64-msvc' },
  linux:  { x64: 'linux-x64-gnu', arm64: 'linux-arm64-gnu', arm: 'linux-arm-gnueabihf' },
  darwin: { x64: 'darwin-x64', arm64: 'darwin-arm64' },
}

const HELPER_NAME = process.platform === 'win32'
  ? 'cef_screenshot_helper.exe'
  : 'cef_screenshot_helper'

function resolveHelperDir(): string | undefined {
  // 1. npm 安装：从 cef-screenshot-{platform} 平台子包中寻找 CEF 运行时
  const suffix = PLATFORM_PKG_MAP[process.platform]?.[process.arch]
  if (suffix) {
    try {
      const pkgDir = dirname(_require.resolve(`cef-screenshot-${suffix}/package.json`))
      if (existsSync(join(pkgDir, HELPER_NAME))) return pkgDir
    } catch {}
  }
  // 2. 开发环境：本地构建目录
  const devDir = join(__dirname, 'cef-helper', 'build', 'Release')
  if (existsSync(join(devDir, HELPER_NAME))) return devDir
  return undefined
}

/**
 * 启动 CEF 辅助进程，初始化浏览器池
 * 必须在调用 screenshot() 之前调用
 */
export function init(options?: InitOptions): Promise<void> {
  const opts = { ...options }
  if (!opts.helperDir) {
    opts.helperDir = resolveHelperDir()
  }
  return getNative().init(opts)
}

/**
 * 对指定 URL 进行截图
 * @param url 要截图的页面 URL（必须以 http:// 或 https:// 开头）
 * @param options 截图参数（宽度、高度、等待时间）
 * @returns PNG 格式的 Buffer
 */
export function screenshot(url: string, options?: ScreenshotOptions): Promise<Buffer> {
  return getNative().screenshot(url, options)
}

/**
 * 关闭 CEF 辅助进程，释放所有资源
 * 建议在程序退出前调用
 */
export function shutdown(): Promise<void> {
  return getNative().shutdown()
}
