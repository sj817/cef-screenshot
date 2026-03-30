// test/test-selector.ts — 元素选择器测试
// 启动本地 HTTP 服务器，测试各种 CSS 选择器能否正确选中元素
import { createServer, type Server } from 'node:http'
import { writeFileSync, mkdirSync } from 'node:fs'
import { init, screenshot, shutdown } from '../index.ts'

const HTML = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Selector Test</title></head>
<body style="margin:0;padding:20px;font-family:sans-serif;">
  <h1>Selector Test Page</h1>
  <div id="myid" style="background:#e0f0ff;padding:20px;margin:10px 0;">
    ID selector: #myid
  </div>
  <div class="myclass" style="background:#f0ffe0;padding:20px;margin:10px 0;">
    Class selector: .myclass
  </div>
  <div id="container" class="container" style="background:#fff0e0;padding:20px;margin:10px 0;">
    Bare word "container" — has both id="container" and class="container"
  </div>
  <section style="background:#f0e0ff;padding:20px;margin:10px 0;">
    Tag selector: section
  </section>
  <div class="nested-parent" style="background:#ffe0e0;padding:20px;margin:10px 0;">
    <span class="nested-child" style="background:#ffcccc;padding:10px;display:inline-block;">
      Nested child: .nested-parent .nested-child
    </span>
  </div>
</body>
</html>`

function startServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(HTML)
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ server, port })
    })
  })
}

interface TestCase {
  name: string
  selector: string
  shouldPass: boolean
}

const TESTS: TestCase[] = [
  // 标准 CSS 选择器
  { name: 'ID selector (#myid)',           selector: '#myid',    shouldPass: true },
  { name: 'Class selector (.myclass)',     selector: '.myclass', shouldPass: true },
  { name: 'Tag selector (section)',        selector: 'section',  shouldPass: true },
  { name: 'CSS combo (.nested-parent .nested-child)',
    selector: '.nested-parent .nested-child', shouldPass: true },

  // 裸标识符自动匹配（核心修复）
  { name: 'Bare word "container" → auto fallback to #container / .container',
    selector: 'container', shouldPass: true },
  { name: 'Bare word "myid" → auto fallback to #myid',
    selector: 'myid',      shouldPass: true },
  { name: 'Bare word "myclass" → auto fallback to .myclass',
    selector: 'myclass',   shouldPass: true },

  // 不存在的元素
  { name: 'Non-existent selector',  selector: '#does-not-exist', shouldPass: false },
  { name: 'Non-existent bare word', selector: 'nonexistent',     shouldPass: false },
]

async function main() {
  mkdirSync('test', { recursive: true })

  // 启动本地 HTTP 服务器
  const { server, port } = await startServer()
  const baseUrl = `http://127.0.0.1:${port}`
  console.log(`[测试] HTTP 服务器启动于 ${baseUrl}`)

  // 初始化 CEF
  console.log('[测试] 初始化 CEF...')
  await init({ concurrency: 1 })
  console.log('[测试] CEF 就绪\n')

  let passed = 0
  let failed = 0

  for (const tc of TESTS) {
    process.stdout.write(`  ${tc.name} ... `)
    try {
      const buf = await screenshot(baseUrl, {
        width: 800,
        height: 600,
        delay: 300,
        selector: tc.selector,
      })
      if (tc.shouldPass) {
        // 保存截图以便人工检查
        const safeName = tc.selector.replace(/[^a-zA-Z0-9_-]/g, '_')
        writeFileSync(`test/output_selector_${safeName}.png`, buf)
        console.log(`✓ OK (${buf.length} bytes)`)
        passed++
      } else {
        console.log(`✗ FAIL — expected error but got ${buf.length} bytes`)
        failed++
      }
    } catch (err: any) {
      if (!tc.shouldPass) {
        console.log(`✓ OK (expected error: ${err.message.slice(0, 60)})`)
        passed++
      } else {
        console.log(`✗ FAIL — ${err.message}`)
        failed++
      }
    }
  }

  console.log(`\n[结果] ${passed}/${TESTS.length} 通过，${failed} 失败`)

  await shutdown()
  server.close()

  if (failed > 0) process.exit(1)
}

main().catch(err => {
  console.error('测试异常:', err)
  process.exit(1)
})
