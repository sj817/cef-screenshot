// test/test.ts — 基础截图测试
import { writeFileSync, mkdirSync } from 'node:fs'
import { init, screenshot, shutdown } from '../index.ts'

const URLS = [
  'https://example.com',
  'https://www.baidu.com',
  'https://httpbin.org/html',
]

async function main() {
  mkdirSync('test', { recursive: true })

  console.log('[测试] 初始化 CEF...')
  const t0 = Date.now()
  await init({ concurrency: 2 })
  console.log(`[测试] 初始化完成，耗时 ${Date.now() - t0} ms\n`)

  // ── 基础截图测试 ──────────────────────────────────────────
  console.log('═══ 1. 基础截图（全页） ═══')
  for (const url of URLS) {
    console.log(`截图: ${url}`)
    const t = Date.now()
    try {
      const buf = await screenshot(url, { width: 1280, height: 800, delay: 500 })
      const host = new URL(url).hostname
      const outFile = `test/output_${host}.png`
      writeFileSync(outFile, buf)
      console.log(`  ✓ 完成，${buf.length} 字节，耗时 ${Date.now() - t} ms => ${outFile}`)
    } catch (err: any) {
      console.log(`  ✗ 失败: ${err.message}`)
    }
  }

  // ── 视窗模式测试（fullPage: false）──────────────────────────
  console.log('\n═══ 2. 视窗模式截图 ═══')
  try {
    const buf = await screenshot('https://example.com', {
      width: 1280, height: 800, delay: 500,
      fullPage: false,
    })
    writeFileSync('test/output_viewport.png', buf)
    console.log(`  ✓ 视窗模式完成，${buf.length} 字节`)
  } catch (err: any) {
    console.log(`  ✗ 视窗模式失败: ${err.message}`)
  }

  // ── 元素选择器测试 ─────────────────────────────────────────
  console.log('\n═══ 3. 元素选择器截图 ═══')
  try {
    const buf = await screenshot('https://example.com', {
      width: 1280, height: 800, delay: 500,
      selector: 'div',
    })
    writeFileSync('test/output_element.png', buf)
    console.log(`  ✓ 元素截图完成，${buf.length} 字节`)
  } catch (err: any) {
    console.log(`  ✗ 元素截图失败: ${err.message}`)
  }

  // ── 分片截图测试 ───────────────────────────────────────────
  console.log('\n═══ 4. 分片截图 ═══')
  try {
    const slices = await screenshot('https://example.com', {
      width: 1280, height: 800, delay: 500,
      sliceHeight: 400,
    })
    console.log(`  ✓ 分片截图完成，共 ${slices.length} 片`)
    for (let i = 0; i < slices.length; i++) {
      const outFile = `test/output_slice_${i}.png`
      writeFileSync(outFile, slices[i])
      console.log(`    片 ${i}: ${slices[i].length} 字节 => ${outFile}`)
    }
  } catch (err: any) {
    console.log(`  ✗ 分片截图失败: ${err.message}`)
  }

  const totalMs = Date.now() - t0
  const mem = process.memoryUsage()
  console.log(`\n[测试] 全部完成，总耗时 ${totalMs} ms`)
  console.log(`[内存] RSS ${(mem.rss / 1024 / 1024).toFixed(1)} MB，堆 ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`)

  await shutdown()
}

main().catch(err => {
  console.error('测试失败:', err)
  process.exit(1)
})
