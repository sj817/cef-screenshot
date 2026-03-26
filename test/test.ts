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

  const totalMs = Date.now() - t0
  const mem = process.memoryUsage()
  console.log(`\n[测试] 全部完成，总耗时 ${totalMs} ms`)
  console.log(`[内存] RSS ${(mem.rss / 1024 / 1024).toFixed(1)} MB，堆 ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`)

  // await shutdown()
}

main().catch(err => {
  console.error('测试失败:', err)
  process.exit(1)
})
