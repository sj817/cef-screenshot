// index.ts — CEF Screenshot 主入口
// 纯 TypeScript 实现，通过 createRequire 直接加载 .node 原生绑定

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 初始化选项 */
export interface InitOptions {
  /** 包含 cef_screenshot_helper.exe 和 CEF 运行时文件的目录 */
  helperDir?: string
  /**
   * 并发浏览器槽位数量，默认 3，最大 10
   * @deprecated 使用 `browsers` + `tabs` 代替，提供更细粒度的控制
   */
  concurrency?: number
  /**
   * 浏览器进程数量（默认 1，最大 5）
   * 每个进程是独立的 CEF 实例，拥有自己的标签页
   * 总并发数 = browsers × tabs
   */
  browsers?: number
  /**
   * 每个浏览器进程的标签页数量（默认 3，最大 10）
   * 低配置机器建议使用 1 个浏览器 + 多标签（节省内存）
   * 高配置机器可使用多浏览器 + 多标签（最大化吞吐量）
   */
  tabs?: number
}

/** 截图选项 */
export interface ScreenshotOptions {
  /** 视窗宽度（像素），默认 1920 */
  width?: number
  /** 视窗高度（像素），默认 1080 */
  height?: number
  /** 页面加载完成后的额外等待时间（毫秒），默认 500 */
  delay?: number
  /** CSS 选择器，截图指定元素。未指定时截图整个页面 */
  selector?: string
  /**
   * 是否截取完整页面（包括滚动区域），默认 true
   * 设为 false 则仅截取视窗可见区域（旧版行为）
   */
  fullPage?: boolean
}

/** 分片截图选项 */
export interface SlicedScreenshotOptions extends ScreenshotOptions {
  /**
   * 分片高度（像素），将截图按此高度切分为多张图片
   * 相邻分片重叠 100px 以保证视觉连续性
   * 最后一片不足时向上扩展到完整高度
   */
  sliceHeight: number
}

interface NativeBinding {
  init(options?: InitOptions): Promise<void>
  screenshot(url: string, options?: ScreenshotOptions): Promise<Buffer>
  screenshotSliced(url: string, options?: ScreenshotOptions): Promise<Buffer[]>
  shutdown(): Promise<void>
}

const _require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))

// ── 平台 → .node 文件后缀映射（仅支持的目标） ────────────────────────────
const PLATFORM_SUFFIX: Record<string, Record<string, string>> = {
  win32:  { x64: 'win32-x64-msvc', arm64: 'win32-arm64-msvc' },
  linux:  { x64: 'linux-x64-gnu', arm64: 'linux-arm64-gnu', arm: 'linux-arm-gnueabihf' },
  darwin: { x64: 'darwin-x64', arm64: 'darwin-arm64' },
}

let _native: NativeBinding | null = null

function loadNativeBinding(): NativeBinding {
  const suffix = PLATFORM_SUFFIX[process.platform]?.[process.arch]
  if (!suffix) {
    throw new Error(
      `不支持的平台: ${process.platform}-${process.arch}\n` +
      `支持的平台: win32-x64, win32-arm64, linux-x64, linux-arm64, linux-arm, darwin-x64, darwin-arm64`
    )
  }

  // 1. 尝试加载本地 .node 文件（开发环境）
  const localFile = join(__dirname, `cef-screenshot.${suffix}.node`)
  if (existsSync(localFile)) {
    return _require(localFile)
  }

  // 2. 尝试加载 npm 平台子包
  try {
    return _require(`cef-screenshot-${suffix}`)
  } catch (e: any) {
    throw new Error(
      `无法加载原生绑定 cef-screenshot-${suffix}\n` +
      `请确认已安装对应平台的子包，或先运行 pnpm run build 编译项目\n` +
      `原始错误: ${e.message}`
    )
  }
}

function getNative(): NativeBinding {
  if (_native) return _native
  _native = loadNativeBinding()
  return _native
}

// ── 自动解析 CEF 运行时所在目录 ──────────────────────────────────────────
const HELPER_NAME = process.platform === 'win32'
  ? 'cef_screenshot_helper.exe'
  : 'cef_screenshot_helper'

function resolveHelperDir(): string | undefined {
  const suffix = PLATFORM_SUFFIX[process.platform]?.[process.arch]
  if (suffix) {
    // 1. npm 安装：从 cef-screenshot-{platform} 平台子包中寻找 CEF 运行时
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
 * 对指定 URL 进行截图（分片模式）
 * @param url 要截图的页面 URL
 * @param options 包含 sliceHeight 的截图参数
 * @returns PNG 格式的 Buffer 数组，每个元素为一个分片
 */
export function screenshot(url: string, options: SlicedScreenshotOptions): Promise<Buffer[]>
/**
 * 对指定 URL 进行截图
 * @param url 要截图的页面 URL（必须以 http:// 或 https:// 开头）
 * @param options 截图参数（宽度、高度、等待时间、选择器等）
 * @returns PNG 格式的 Buffer
 */
export function screenshot(url: string, options?: ScreenshotOptions): Promise<Buffer>
export function screenshot(url: string, options?: ScreenshotOptions | SlicedScreenshotOptions): Promise<Buffer | Buffer[]> {
  if (options && 'sliceHeight' in options && options.sliceHeight && options.sliceHeight > 0) {
    return getNative().screenshotSliced(url, options)
  }
  return getNative().screenshot(url, options)
}

/**
 * 关闭 CEF 辅助进程，释放所有资源
 * 建议在程序退出前调用
 */
export function shutdown(): Promise<void> {
  return getNative().shutdown()
}
