// benchmark/utils.ts — 基准测试共享工具函数
import { execSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 测试 URL 列表 — 包含简单和复杂页面 */
export const URLS = [
  'https://example.com',
  'https://www.baidu.com',
  'https://www.bing.com',
  'https://httpbin.org/html',
  'https://en.wikipedia.org/wiki/Main_Page',
]

/** 视窗尺寸 */
export const VIEWPORT = { width: 1280, height: 800 }
/** 并发数 */
export const CONCURRENCY = 3
/** 页面加载后额外等待时间（毫秒） */
export const DELAY = 800

export interface MemorySnapshot {
  rss: number
  heapUsed: number
  heapTotal: number
  external: number
}

export interface ExternalMemSnapshot {
  cefHelper: number
  chrome: number
}

export interface Stats {
  min: number
  max: number
  avg: number
  median: number
  total: number
}

/** 获取当前 Node.js 进程内存（MB） */
export function getMemoryMB(): MemorySnapshot {
  const mem = process.memoryUsage()
  return {
    rss:       +(mem.rss       / 1024 / 1024).toFixed(1),
    heapUsed:  +(mem.heapUsed  / 1024 / 1024).toFixed(1),
    heapTotal: +(mem.heapTotal / 1024 / 1024).toFixed(1),
    external:  +(mem.external  / 1024 / 1024).toFixed(1),
  }
}

/** 通过 tasklist 获取指定进程名的进程树总内存（MB，Windows） */
export function getProcessTreeMemoryMB(processName: string): number {
  try {
    const out = execSync(
      `tasklist /FI "IMAGENAME eq ${processName}" /FO CSV /NH`,
      { encoding: 'utf-8', timeout: 5000 }
    )
    let totalKB = 0
    for (const line of out.trim().split('\n')) {
      // 格式: "name.exe","PID","Session","#","Mem Usage"
      const match = line.match(/"([^"]*\d[\d,.]*).*K"/i)
      if (match) {
        const kb = parseInt(match[1].replace(/[,. ]/g, ''), 10)
        if (!isNaN(kb)) totalKB += kb
      }
    }
    return +(totalKB / 1024).toFixed(1)
  } catch {
    return 0
  }
}

/** 快照外部进程内存（CEF helper 和 Chrome） */
export function snapshotExternalMemory(): ExternalMemSnapshot {
  return {
    cefHelper: getProcessTreeMemoryMB('cef_screenshot_helper.exe'),
    chrome:    getProcessTreeMemoryMB('chrome.exe'),
  }
}

/** 计算数值数组的统计信息 */
export function calcStats(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b)
  const sum = sorted.reduce((a, b) => a + b, 0)
  return {
    min:    sorted[0],
    max:    sorted[sorted.length - 1],
    avg:    +(sum / sorted.length).toFixed(0),
    median: sorted[Math.floor(sorted.length / 2)],
    total:  sum,
  }
}

/** 表格对齐辅助——右侧填充 */
export function padR(s: unknown, n: number): string { return String(s).padEnd(n) }
/** 表格对齐辅助——左侧填充 */
export function padL(s: unknown, n: number): string { return String(s).padStart(n) }

/** 递归统计目录总大小（MB） */
export function getDirSizeMB(dirPath: string): number {
  let bytes = 0
  function walk(dir: string) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fp = join(dir, entry.name)
        if (entry.isDirectory()) walk(fp)
        else { try { bytes += statSync(fp).size } catch {} }
      }
    } catch {}
  }
  walk(dirPath)
  return +(bytes / 1024 / 1024).toFixed(1)
}

/** 获取单个文件大小（MB） */
export function getFileSizeMB(filePath: string): number {
  try { return +(statSync(filePath).size / 1024 / 1024).toFixed(2) } catch { return 0 }
}
