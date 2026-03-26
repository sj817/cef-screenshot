// benchmark/bench-cef.ts — CEF 截图基准测试
import { writeFileSync, mkdirSync } from 'node:fs'
import { init, screenshot, shutdown } from '../index.ts'
import {
  URLS, VIEWPORT, CONCURRENCY, DELAY,
  getMemoryMB, snapshotExternalMemory,
  MemorySnapshot, ExternalMemSnapshot,
} from './utils.ts'

export interface CefBenchResult {
  name: string
  initTime: number
  sequential: Array<{ url: string; time: number; size: number }>
  concurrent: { time: number; perUrl: Array<{ url: string; time: number; size: number }> }
  memory: {
    before: MemorySnapshot | null
    afterInit: MemorySnapshot | null
    peak: MemorySnapshot | null
    afterShutdown: MemorySnapshot | null
  }
  externalMem: {
    afterInit: ExternalMemSnapshot | null
    peak: ExternalMemSnapshot | null
  }
}

export async function runCefBenchmark(): Promise<CefBenchResult> {
  const results: CefBenchResult = {
    name: 'cef-screenshot',
    initTime: 0,
    sequential: [],
    concurrent: { time: 0, perUrl: [] },
    memory: { before: null, afterInit: null, peak: null, afterShutdown: null },
    externalMem: { afterInit: null, peak: null },
  }

  mkdirSync('benchmark/output', { recursive: true })

  // ── 初始化前内存快照 ──
  results.memory.before = getMemoryMB()

  // ── 初始化（含预热）——与 Puppeteer 对齐 ──
  // 计时范围：启动进程池 + about:blank 预热（与 Puppeteer launch + warmup 对齐）
  const t0 = Date.now()
  await init({ concurrency: CONCURRENCY })
  await screenshot('about:blank', { width: VIEWPORT.width, height: VIEWPORT.height, delay: 100 })
  results.initTime = Date.now() - t0

  results.memory.afterInit = getMemoryMB()
  results.externalMem.afterInit = snapshotExternalMemory()

  // ── 串行截图 ──
  console.log('  [CEF] 串行截图...')
  for (const url of URLS) {
    const t = Date.now()
    const buf = await screenshot(url, {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      delay: DELAY,
    })
    results.sequential.push({ url, time: Date.now() - t, size: buf.length })
    writeFileSync(`benchmark/output/cef_${new URL(url).hostname}.png`, buf)
  }

  // ── 并发截图（计时从发出请求起，浏览器已预热）──
  console.log('  [CEF] 并发截图...')
  const tc = Date.now()
  const concurrentResults = await Promise.all(
    URLS.map(async (url) => {
      const t = Date.now()
      const buf = await screenshot(url, {
        width: VIEWPORT.width,
        height: VIEWPORT.height,
        delay: DELAY,
      })
      return { url, time: Date.now() - t, size: buf.length }
    })
  )
  results.concurrent.time = Date.now() - tc
  results.concurrent.perUrl = concurrentResults

  // ── 峰值内存快照 ──
  results.memory.peak = getMemoryMB()
  results.externalMem.peak = snapshotExternalMemory()

  // ── 关闭并等待 OS 回收 ──
  await shutdown()
  await new Promise(r => setTimeout(r, 1000))
  results.memory.afterShutdown = getMemoryMB()

  return results
}

// 允许独立运行
const scriptUrl = new URL(import.meta.url).pathname
if (process.argv[1] && process.argv[1].endsWith('bench-cef.ts')) {
  console.log('=== CEF Screenshot 基准测试 ===\n')
  const r = await runCefBenchmark()
  console.log('\n结果:', JSON.stringify(r, null, 2))
}
