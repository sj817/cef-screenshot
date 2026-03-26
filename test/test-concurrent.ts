// test/test-concurrent.ts — 并发截图测试
import { writeFileSync, mkdirSync } from 'node:fs'
import { init, screenshot, shutdown } from '../index.ts'

const CONCURRENCY = 3
const URLS = [
  'https://example.com',
  'https://www.baidu.com',
  'https://httpbin.org/html',
  'https://www.bing.com',
  'https://en.wikipedia.org/wiki/Main_Page',
]

async function main() {
  mkdirSync('test', { recursive: true })

  console.log(`[并发测试] 初始化，并发数 = ${CONCURRENCY}`)
  await init({ concurrency: CONCURRENCY })
  console.log(`[并发测试] 就绪，同时发起 ${URLS.length} 个截图请求...\n`)

  const t0 = Date.now()

  const results = await Promise.allSettled(
    URLS.map(async (url) => {
      const start = Date.now()
      const buf = await screenshot(url, { width: 1280, height: 800, delay: 600 })
      return { url, buf, elapsed: Date.now() - start }
    })
  )

  const totalMs = Date.now() - t0

  for (const r of results) {
    if (r.status === 'fulfilled') {
      const { url, buf, elapsed } = r.value
      const host = new URL(url).hostname
      const filename = `test/output_concurrent_${host}.png`
      writeFileSync(filename, buf)
      console.log(`  ✓  ${url}`)
      console.log(`     => ${filename}（${buf.length} 字节，${elapsed} ms）`)
    } else {
      console.log(`  ✗  ${r.reason}`)
    }
  }

  const ok = results.filter(r => r.status === 'fulfilled').length
  console.log(`\n[并发测试] ${ok}/${URLS.length} 成功，总耗时 ${totalMs} ms`)

  // 串行基准对比（仅前 3 个 URL）
  console.log('\n[串行对比] 依次执行前 3 个 URL...')
  const t1 = Date.now()
  for (const url of URLS.slice(0, 3)) {
    await screenshot(url, { width: 1280, height: 800, delay: 600 })
  }
  const seqMs = Date.now() - t1
  console.log(`[串行对比] 3 个 URL 耗时 ${seqMs} ms`)
  console.log(`[并发加速] ${(seqMs / totalMs).toFixed(2)}x`)

  // await shutdown()
  console.log('\n[并发测试] 完成。')
}

main().catch(err => {
  console.error('测试失败:', err)
  process.exit(1)
})
