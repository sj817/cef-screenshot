// benchmark/compare.ts — CEF vs Puppeteer 完整性能对比
//
// 用法：pnpm run benchmark
//
// 公平对比：两者均在浏览器已启动并预热完毕后才开始计时截图耗时
//   CEF       — init() 启动进程池 + about:blank 预热，之后才计时截图
//   Puppeteer — launch() + newPage() + about:blank 预热，之后才计时截图

import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer'
import { runCefBenchmark } from './bench-cef.ts'
import { runPuppeteerBenchmark } from './bench-puppeteer.ts'
import { URLS, calcStats, padR, getDirSizeMB, getFileSizeMB } from './utils.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
// 项目根目录（benchmark/ 的上一级）
const ROOT = join(__dirname, '..')

function hr(char = '═', len = 76): string { return char.repeat(len) }
function fmtMs(ms: number | null): string { return ms == null ? 'N/A' : `${ms} ms` }
function fmtMB(mb: number | string | null): string { return mb == null ? 'N/A' : `${mb} MB` }

function printSection(title: string) {
  console.log(`\n${hr()}`)
  console.log(`  ${title}`)
  console.log(hr())
}

async function collectFileSizes() {
  const sizes: Record<string, number> = {}

  // CEF .node 原生模块
  sizes.cefNode = getFileSizeMB(join(ROOT, 'cef-screenshot.win32-x64-msvc.node'))

  // CEF 运行时（磁盘解压后）
  sizes.cefRuntimeExtracted = getDirSizeMB(join(ROOT, 'cef-helper', 'build', 'Release'))

  // CEF 运行时压缩包（用户实际下载体积）
  const tarPath = join(ROOT, 'dist', 'cef-screenshot-runtime-win32-x64-v1.0.0.tar.gz')
  sizes.cefRuntimeTar = existsSync(tarPath) ? getFileSizeMB(tarPath) : 0

  // Puppeteer npm 包
  sizes.puppeteerPackage = getDirSizeMB(join(ROOT, 'node_modules', 'puppeteer'))

  // Puppeteer 捆绑的 Chromium（~/.cache/puppeteer 或 node_modules/.cache）
  const chromePath = puppeteer.executablePath()
  let chromeDir = chromePath
  for (let i = 0; i < 3; i++) {
    const parent = join(chromeDir, '..')
    if (parent === chromeDir) break
    chromeDir = parent
  }
  sizes.puppeteerChromium = existsSync(chromeDir) ? getDirSizeMB(chromeDir) : 0

  return sizes
}

async function main() {
  console.log(hr('━', 76))
  console.log('   CEF-Screenshot  vs  Puppeteer  —  完整性能对比')
  console.log(`   URLs: ${URLS.length}  |  视窗: 1280×800  |  加载后等待: 800ms`)
  console.log('   ★ 两者均在浏览器已启动并预热完毕后才开始计时截图耗时')
  console.log(hr('━', 76))

  console.log('\n▶  运行 CEF 基准测试...')
  const cef = await runCefBenchmark()

  console.log('\n⏳  冷却 3s...\n')
  await new Promise(r => setTimeout(r, 3000))

  console.log('▶  运行 Puppeteer 基准测试...')
  const pptr = await runPuppeteerBenchmark()

  console.log('\n▶  收集文件体积数据...')
  const fs = await collectFileSizes()

  const W = 34

  // ══════════════════════════════════════════════════════════════
  printSection('1. 启动 + 预热耗时  (Init + Warmup)')
  const I = 16
  console.log(`  ${'内容'.padEnd(W)}${'CEF'.padEnd(I)}${'Puppeteer'.padEnd(I)}${'胜出'}`)
  console.log(`  ${'─'.padEnd(W)}${'─'.padEnd(I)}${'─'.padEnd(I)}${'─'.padEnd(12)}`)
  const initWinner = cef.initTime < pptr.initTime ? 'CEF ✓' : 'Puppeteer ✓'
  console.log(`  ${'launch + page 创建 + about:blank'.padEnd(W)}${fmtMs(cef.initTime).padEnd(I)}${fmtMs(pptr.initTime).padEnd(I)}${initWinner}`)

  // ══════════════════════════════════════════════════════════════
  printSection('2. 串行截图耗时  (Sequential — warm browser)')
  const C = 14
  console.log(`  ${'URL'.padEnd(36)}${'CEF'.padEnd(C)}${'Puppeteer'.padEnd(C)}${'差异'}`)
  console.log(`  ${'─'.padEnd(36)}${'─'.padEnd(C)}${'─'.padEnd(C)}${'─'.padEnd(C)}`)

  for (let i = 0; i < URLS.length; i++) {
    const cs = cef.sequential[i]
    const ps = pptr.sequential[i]
    const host = new URL(URLS[i]).hostname
    const diff = cs.time - ps.time
    const sign = diff > 0 ? '+' : ''
    console.log(`  ${host.padEnd(36)}${fmtMs(cs.time).padEnd(C)}${fmtMs(ps.time).padEnd(C)}${`${sign}${diff} ms`.padEnd(C)}`)
  }

  const cefSeq = calcStats(cef.sequential.map(s => s.time))
  const pptrSeq = calcStats(pptr.sequential.map(s => s.time))
  console.log(`  ${'─'.padEnd(36)}${'─'.padEnd(C)}${'─'.padEnd(C)}${'─'.padEnd(C)}`)
  console.log(`  ${'平均 avg'.padEnd(36)}${fmtMs(cefSeq.avg).padEnd(C)}${fmtMs(pptrSeq.avg).padEnd(C)}${(cefSeq.avg < pptrSeq.avg ? 'CEF ✓' : 'Pptr ✓').padEnd(C)}`)
  console.log(`  ${'中位数 median'.padEnd(36)}${fmtMs(cefSeq.median).padEnd(C)}${fmtMs(pptrSeq.median).padEnd(C)}`)
  console.log(`  ${'合计 total'.padEnd(36)}${fmtMs(cefSeq.total).padEnd(C)}${fmtMs(pptrSeq.total).padEnd(C)}${(cefSeq.total < pptrSeq.total ? 'CEF ✓' : 'Pptr ✓').padEnd(C)}`)

  // ══════════════════════════════════════════════════════════════
  printSection(`3. 并发截图耗时  (Concurrent pool=${URLS.length} — pool pre-warmed)`)
  console.log(`  ${'URL'.padEnd(36)}${'CEF'.padEnd(C)}${'Puppeteer'}`)
  console.log(`  ${'─'.padEnd(36)}${'─'.padEnd(C)}${'─'.padEnd(C)}`)
  for (const cr of cef.concurrent.perUrl) {
    const host = new URL(cr.url).hostname
    const pr = pptr.concurrent.perUrl.find(p => p.url === cr.url)
    console.log(`  ${host.padEnd(36)}${fmtMs(cr.time).padEnd(C)}${(pr ? fmtMs(pr.time) : 'N/A').padEnd(C)}`)
  }
  const concWinner = cef.concurrent.time < pptr.concurrent.time ? 'CEF ✓' : 'Puppeteer ✓'
  console.log(`  ${'─'.padEnd(36)}${'─'.padEnd(C)}${'─'.padEnd(C)}`)
  console.log(`  ${'并发总耗时 wall clock'.padEnd(36)}${fmtMs(cef.concurrent.time).padEnd(C)}${fmtMs(pptr.concurrent.time).padEnd(C)}  ${concWinner}`)

  // ══════════════════════════════════════════════════════════════
  printSection('4. 截图 PNG 文件大小  (Output file size)')
  console.log(`  ${'URL'.padEnd(36)}${'CEF'.padEnd(C)}${'Puppeteer'.padEnd(C)}${'差异'}`)
  console.log(`  ${'─'.padEnd(36)}${'─'.padEnd(C)}${'─'.padEnd(C)}${'─'.padEnd(C)}`)
  for (let i = 0; i < URLS.length; i++) {
    const cs = cef.sequential[i]
    const ps = pptr.sequential[i]
    const host = new URL(URLS[i]).hostname
    const cKB = (cs.size / 1024).toFixed(1) + ' KB'
    const pKB = (ps.size / 1024).toFixed(1) + ' KB'
    const diff = ((cs.size - ps.size) / 1024).toFixed(1)
    const sign = parseFloat(diff) > 0 ? '+' : ''
    console.log(`  ${host.padEnd(36)}${cKB.padEnd(C)}${pKB.padEnd(C)}${`${sign}${diff} KB`.padEnd(C)}`)
  }

  // ══════════════════════════════════════════════════════════════
  printSection('5. 引入文件大小  (Package / Runtime Distribution Size)')
  const N = 40, V = 14
  console.log(`  ${'项目'.padEnd(N)}${'CEF'.padEnd(V)}${'Puppeteer'}`)
  console.log(`  ${'─'.padEnd(N)}${'─'.padEnd(V)}${'─'.padEnd(V)}`)
  console.log(`  ${'① Native .node 模块'.padEnd(N)}${fmtMB(fs.cefNode).padEnd(V)}${'(含于 npm 包)'.padEnd(V)}`)
  console.log(`  ${'② 浏览器运行时 (磁盘占用)'.padEnd(N)}${fmtMB(fs.cefRuntimeExtracted).padEnd(V)}${fmtMB(fs.puppeteerChromium).padEnd(V)}`)
  console.log(`  ${'② 浏览器运行时 (下载/分发体积)'.padEnd(N)}${(fs.cefRuntimeTar ? fmtMB(fs.cefRuntimeTar.toFixed(1)) : `≈${fmtMB(fs.cefRuntimeExtracted)}`).padEnd(V)}${'(≈ 同磁盘)'.padEnd(V)}`)
  console.log(`  ${'③ npm 包本体 node_modules'.padEnd(N)}${'(只含 .node)'.padEnd(V)}${fmtMB(fs.puppeteerPackage).padEnd(V)}`)
  const cefDist = fs.cefNode + (fs.cefRuntimeTar || fs.cefRuntimeExtracted)
  const pptrDist = fs.puppeteerChromium + fs.puppeteerPackage
  const sizeWinner = cefDist < pptrDist ? 'CEF ✓' : 'Puppeteer ✓'
  console.log(`  ${'─'.padEnd(N)}${'─'.padEnd(V)}${'─'.padEnd(V)}`)
  console.log(`  ${'合计 (下载/分发体积 ①+②+③)'.padEnd(N)}${fmtMB(cefDist.toFixed(1)).padEnd(V)}${fmtMB(pptrDist.toFixed(1)).padEnd(V)}  ${sizeWinner}`)

  // ══════════════════════════════════════════════════════════════
  printSection('6. 内存占用  (Memory Usage)')
  console.log(`  ${'阶段'.padEnd(W)}${'CEF'.padEnd(I)}${'Puppeteer'}`)
  console.log(`  ${'─'.padEnd(W)}${'─'.padEnd(I)}${'─'.padEnd(I)}`)
  console.log(`  ${'Node.js RSS — init 后'.padEnd(W)}${fmtMB(cef.memory.afterInit?.rss).padEnd(I)}${fmtMB(pptr.memory.afterInit?.rss).padEnd(I)}`)
  console.log(`  ${'Node.js RSS — 峰值'.padEnd(W)}${fmtMB(cef.memory.peak?.rss).padEnd(I)}${fmtMB(pptr.memory.peak?.rss).padEnd(I)}`)
  console.log(`  ${'Node.js RSS — 关闭后'.padEnd(W)}${fmtMB(cef.memory.afterShutdown?.rss).padEnd(I)}${fmtMB(pptr.memory.afterShutdown?.rss).padEnd(I)}`)
  console.log()
  console.log(`  ${'子进程 cef_helper.exe — 峰值'.padEnd(W)}${fmtMB(cef.externalMem.peak?.cefHelper).padEnd(I)}${'—'.padEnd(I)}`)
  console.log(`  ${'子进程 chrome.exe — 峰值'.padEnd(W)}${'—'.padEnd(I)}${fmtMB(pptr.externalMem.peak?.chrome).padEnd(I)}`)
  const cefMemPeak = (cef.memory.peak?.rss ?? 0) + (cef.externalMem.peak?.cefHelper ?? 0)
  const pptrMemPeak = (pptr.memory.peak?.rss ?? 0) + (pptr.externalMem.peak?.chrome ?? 0)
  const memSaved = ((1 - cefMemPeak / pptrMemPeak) * 100).toFixed(1)
  const memWinner = cefMemPeak < pptrMemPeak ? 'CEF ✓' : 'Puppeteer ✓'
  console.log(`  ${'─'.padEnd(W)}${'─'.padEnd(I)}${'─'.padEnd(I)}`)
  console.log(`  ${'总峰值 (Node + 子进程)'.padEnd(W)}${fmtMB(cefMemPeak.toFixed(1)).padEnd(I)}${fmtMB(pptrMemPeak.toFixed(1)).padEnd(I)}  ${memWinner}`)

  // ══════════════════════════════════════════════════════════════
  printSection('总结  (Summary)')
  const seqFaster  = cefSeq.avg < pptrSeq.avg
  const seqSpeedup = seqFaster
    ? (pptrSeq.avg  / cefSeq.avg).toFixed(2)
    : (cefSeq.avg  / pptrSeq.avg).toFixed(2)
  const concFaster  = cef.concurrent.time < pptr.concurrent.time
  const concSpeedup = concFaster
    ? (pptr.concurrent.time / cef.concurrent.time).toFixed(2)
    : (cef.concurrent.time  / pptr.concurrent.time).toFixed(2)

  console.log(`  启动+预热:  CEF ${cef.initTime}ms  vs  Puppeteer ${pptr.initTime}ms`)
  console.log(`              → ${cef.initTime < pptr.initTime ? `CEF 快 ${(pptr.initTime / cef.initTime).toFixed(2)}x` : `Puppeteer 快 ${(cef.initTime / pptr.initTime).toFixed(2)}x`}`)
  console.log(`  串行速度:   avg CEF ${cefSeq.avg}ms  vs  Puppeteer ${pptrSeq.avg}ms`)
  console.log(`              → ${seqFaster ? `CEF 快 ${seqSpeedup}x` : `Puppeteer 快 ${seqSpeedup}x`}`)
  console.log(`  并发速度:   wall ${cef.concurrent.time}ms  vs  ${pptr.concurrent.time}ms`)
  console.log(`              → ${concFaster ? `CEF 快 ${concSpeedup}x` : `Puppeteer 快 ${concSpeedup}x`}`)
  console.log(`  内存峰值:   CEF ${cefMemPeak.toFixed(0)}MB  vs  Puppeteer ${pptrMemPeak.toFixed(0)}MB`)
  console.log(`              → ${parseFloat(memSaved) > 0 ? `CEF 节省 ${memSaved}%` : `Puppeteer 节省 ${Math.abs(parseFloat(memSaved))}%`}`)
  console.log(`  分发体积:   CEF ~${cefDist.toFixed(0)}MB  vs  Puppeteer ~${pptrDist.toFixed(0)}MB`)
  console.log(`              → ${cefDist < pptrDist ? `CEF 小 ${((1 - cefDist / pptrDist) * 100).toFixed(1)}%` : `Puppeteer 小 ${((1 - pptrDist / cefDist) * 100).toFixed(1)}%`}`)
  console.log()

  const { writeFileSync } = await import('node:fs')
  writeFileSync('benchmark/results.json',
    JSON.stringify({ timestamp: new Date().toISOString(), fileSizes: fs, cef, puppeteer: pptr }, null, 2))
  console.log('  详细数据已保存至 benchmark/results.json')
  console.log(`\n${hr('━', 76)}\n`)
}

main().catch(err => {
  console.error('基准测试失败:', err)
  process.exit(1)
})
