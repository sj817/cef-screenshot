// benchmark/bench-puppeteer.ts — Puppeteer 截图基准测试
//
// 公平对比策略（与 CEF 对齐）：
//   初始化阶段：启动浏览器 + 预创建页面 + about:blank 预热
//   截图阶段：仅计时导航 + 等待 + 截图（浏览器已预热）
//   并发阶段：页面池在计时开始前就已创建完毕

import { writeFileSync, mkdirSync } from 'node:fs'
import puppeteer, { type Browser, type Page } from 'puppeteer'
import {
  URLS, VIEWPORT, CONCURRENCY, DELAY,
  getMemoryMB, snapshotExternalMemory,
  MemorySnapshot, ExternalMemSnapshot,
} from './utils.ts'

export interface PuppeteerBenchResult {
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

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-sync',
  '--disable-translate',
  '--mute-audio',
  '--no-first-run',
  '--disable-default-apps',
]

export async function runPuppeteerBenchmark(): Promise<PuppeteerBenchResult> {
  const results: PuppeteerBenchResult = {
    name: 'puppeteer',
    initTime: 0,
    sequential: [],
    concurrent: { time: 0, perUrl: [] },
    memory: { before: null, afterInit: null, peak: null, afterShutdown: null },
    externalMem: { afterInit: null, peak: null },
  }

  mkdirSync('benchmark/output', { recursive: true })

  // ── 初始化前内存快照 ──
  results.memory.before = getMemoryMB()

  // ── 初始化（含预热）——与 CEF 完全对齐 ──
  // 计时范围：launch + newPage + setViewport + about:blank 导航
  const t0 = Date.now()

  const browser: Browser = await puppeteer.launch({
    headless: true,
    args: LAUNCH_ARGS,
  })

  // 预创建串行页面并预热（与 CEF 的浏览器槽位预热对齐）
  const seqPage: Page = await browser.newPage()
  await seqPage.setViewport({ width: VIEWPORT.width, height: VIEWPORT.height })
  await seqPage.goto('about:blank')  // 预热导航

  results.initTime = Date.now() - t0
  results.memory.afterInit = getMemoryMB()
  results.externalMem.afterInit = snapshotExternalMemory()

  // ── 串行截图（页面已预热）──
  console.log('  [Puppeteer] 串行截图...')
  for (const url of URLS) {
    const t = Date.now()
    await seqPage.goto(url, { waitUntil: 'load', timeout: 30000 })
    await new Promise(r => setTimeout(r, DELAY))
    const buf = await seqPage.screenshot({ type: 'png', fullPage: false }) as Buffer
    results.sequential.push({ url, time: Date.now() - t, size: buf.length })
    writeFileSync(`benchmark/output/pptr_${new URL(url).hostname}.png`, buf)
  }
  await seqPage.close()

  // ── 并发截图（页面池在计时前完整创建）──
  console.log('  [Puppeteer] 并发截图...')

  // 预先创建并预热所有并发页面（与 CEF 浏览器槽位对齐）
  const pool: Page[] = []
  for (let i = 0; i < CONCURRENCY; i++) {
    const p = await browser.newPage()
    await p.setViewport({ width: VIEWPORT.width, height: VIEWPORT.height })
    await p.goto('about:blank')  // 预热每个槽位
    pool.push(p)
  }

  // 计时从页面池就绪后才开始（与 CEF 对齐）
  const tc = Date.now()
  let urlIdx = 0
  const concurrentResults: Array<{ url: string; time: number; size: number }> = []

  async function processWithPage(page: Page) {
    while (urlIdx < URLS.length) {
      const idx = urlIdx++
      const url = URLS[idx]
      const t = Date.now()
      await page.goto(url, { waitUntil: 'load', timeout: 30000 })
      await new Promise(r => setTimeout(r, DELAY))
      const buf = await page.screenshot({ type: 'png', fullPage: false }) as Buffer
      concurrentResults.push({ url, time: Date.now() - t, size: buf.length })
    }
  }

  await Promise.all(pool.map(p => processWithPage(p)))
  results.concurrent.time = Date.now() - tc
  results.concurrent.perUrl = concurrentResults

  for (const p of pool) await p.close()

  // ── 峰值内存快照 ──
  results.memory.peak = getMemoryMB()
  results.externalMem.peak = snapshotExternalMemory()

  // ── 关闭并等待 OS 回收 ──
  await browser.close()
  await new Promise(r => setTimeout(r, 1000))
  results.memory.afterShutdown = getMemoryMB()

  return results
}

// 允许独立运行
if (process.argv[1] && process.argv[1].endsWith('bench-puppeteer.ts')) {
  console.log('=== Puppeteer 基准测试 ===\n')
  const r = await runPuppeteerBenchmark()
  console.log('\n结果:', JSON.stringify(r, null, 2))
}
