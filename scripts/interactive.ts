// scripts/interactive.ts — 交互式截图控制台
// 启动后初始化 CEF，监听控制台输入 URL，截图保存到 output/ 目录
// 用法：pnpm run interactive

import { createInterface } from 'node:readline'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { init, screenshot, shutdown } from '../index.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = join(__dirname, '..', 'output')
const CONCURRENCY = 3

// 格式化字节数为可读字符串
function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// 获取当前进程内存占用摘要
function getMemoryInfo(): string {
  const { rss, heapUsed, heapTotal } = process.memoryUsage()
  return `RSS ${formatBytes(rss)}，堆 ${formatBytes(heapUsed)}/${formatBytes(heapTotal)}`
}

async function main() {
  // 创建输出目录
  mkdirSync(OUTPUT_DIR, { recursive: true })

  console.log('╔══════════════════════════════════════════╗')
  console.log('║     CEF Screenshot 交互式截图控制台      ║')
  console.log('╚══════════════════════════════════════════╝')
  console.log(`输出目录: ${OUTPUT_DIR}`)
  console.log(`浏览器并发槽位: ${CONCURRENCY}`)
  console.log('')
  console.log('正在初始化 CEF...')

  const initStart = Date.now()
  await init({ concurrency: CONCURRENCY })
  const initMs = Date.now() - initStart

  console.log(`✓ CEF 初始化完成（耗时 ${initMs} ms）`)
  console.log(`  当前内存: ${getMemoryInfo()}`)
  console.log('')
  console.log('━'.repeat(46))
  console.log('输入 URL 进行截图，输入 exit 退出')
  console.log('━'.repeat(46))

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\n> ',
  })

  rl.prompt()

  rl.on('line', async (line: string) => {
    const url = line.trim()
    if (!url) {
      rl.prompt()
      return
    }

    // 退出命令
    if (url === 'exit' || url === 'quit' || url === 'q') {
      console.log('\n正在关闭 CEF...')
      await shutdown()
      console.log('已退出。')
      process.exit(0)
    }

    // 校验 URL 格式
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      console.log('× 无效 URL，请以 http:// 或 https:// 开头')
      rl.prompt()
      return
    }

    console.log(`→ 正在截图: ${url}`)
    const start = Date.now()

    try {
      const buf = await screenshot(url, { width: 1920, height: 1080, delay: 500 })
      const elapsed = Date.now() - start

      // 文件名：hostname + 毫秒时间戳
      const hostname = new URL(url).hostname.replace(/[^a-z0-9.-]/gi, '_')
      const filename = `${hostname}_${Date.now()}.png`
      const filepath = join(OUTPUT_DIR, filename)

      writeFileSync(filepath, buf)

      console.log(`✓ 截图完成`)
      console.log(`  文件: output/${filename}`)
      console.log(`  大小: ${formatBytes(buf.length)}`)
      console.log(`  耗时: ${elapsed} ms`)
      console.log(`  内存: ${getMemoryInfo()}`)
    } catch (err: any) {
      console.log(`× 截图失败: ${err.message}`)
    }

    rl.prompt()
  })

  rl.on('close', async () => {
    console.log('\n正在关闭 CEF...')
    await shutdown()
    process.exit(0)
  })
}

main().catch(err => {
  console.error('启动失败:', err.message)
  process.exit(1)
})
