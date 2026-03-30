// test/test-options.ts — 新增选项测试
// 测试 omitBackground, clip, encoding, path, retry, pageGotoParams
import { createServer, type Server } from 'node:http'
import { writeFileSync, readFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { init, screenshot, shutdown } from '../index.ts'

const HTML = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Options Test</title></head>
<body style="margin:0;padding:0;">
  <div id="red-box" style="width:200px;height:100px;background:red;"></div>
  <div id="green-box" style="width:200px;height:100px;background:green;"></div>
  <div id="blue-box" style="width:200px;height:100px;background:blue;"></div>
  <div style="height:2000px;background:linear-gradient(to bottom,#eee,#333);"></div>
</body>
</html>`

const TRANSPARENT_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Transparent Test</title></head>
<body style="margin:0;padding:40px;background:transparent;">
  <div style="width:200px;height:100px;background:rgba(255,0,0,0.5);border-radius:10px;"></div>
</body>
</html>`

function startServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const html = req.url === '/transparent' ? TRANSPARENT_HTML : HTML
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ server, port })
    })
  })
}

async function main() {
  mkdirSync('test/output', { recursive: true })

  const { server, port } = await startServer()
  const baseUrl = `http://127.0.0.1:${port}`
  console.log(`[测试] HTTP 服务器启动于 ${baseUrl}`)

  console.log('[测试] 初始化 CEF...')
  await init({ concurrency: 1 })
  console.log('[测试] CEF 就绪\n')

  let passed = 0
  let failed = 0

  function ok(name: string) { passed++; console.log(`  ✓ ${name}`) }
  function fail(name: string, err: any) { failed++; console.log(`  ✗ ${name}: ${err?.message ?? err}`) }

  // ── 1. omitBackground ─────────────────────────────────────
  console.log('═══ 1. omitBackground ═══')
  try {
    const buf = await screenshot(`${baseUrl}/transparent`, {
      width: 400, height: 300, delay: 300,
      omitBackground: true,
      fullPage: false,
    })
    writeFileSync('test/output/opt_transparent.png', buf)
    if (buf.length > 100) ok('omitBackground 返回了有效 PNG')
    else fail('omitBackground', 'PNG 数据过小')
  } catch (err: any) {
    fail('omitBackground', err)
  }

  // ── 2. clip ────────────────────────────────────────────────
  console.log('\n═══ 2. clip ═══')
  try {
    const buf = await screenshot(baseUrl, {
      width: 800, height: 600, delay: 300,
      fullPage: false,
      clip: { x: 0, y: 100, width: 200, height: 100 },
    })
    writeFileSync('test/output/opt_clip.png', buf)
    if (buf.length > 100) ok('clip 裁剪返回了有效 PNG')
    else fail('clip', 'PNG 数据过小')
  } catch (err: any) {
    fail('clip', err)
  }

  // ── 3. encoding: base64 ───────────────────────────────────
  console.log('\n═══ 3. encoding: base64 ═══')
  try {
    const result = await screenshot(baseUrl, {
      width: 400, height: 300, delay: 300,
      fullPage: false,
      encoding: 'base64',
    })
    if (typeof result === 'string' && result.length > 100) {
      // 验证 base64 可以解码
      const decoded = Buffer.from(result, 'base64')
      if (decoded[0] === 0x89 && decoded[1] === 0x50) { // PNG magic
        ok('base64 编码有效且可解码为 PNG')
      } else {
        fail('encoding: base64', '解码后不是有效 PNG')
      }
    } else {
      fail('encoding: base64', `返回类型: ${typeof result}, 长度: ${String(result).length}`)
    }
  } catch (err: any) {
    fail('encoding: base64', err)
  }

  // ── 4. path（自动保存） ────────────────────────────────────
  console.log('\n═══ 4. path ═══')
  const savePath = join('test', 'output', 'opt_auto_save.png')
  try {
    if (existsSync(savePath)) unlinkSync(savePath)
    const buf = await screenshot(baseUrl, {
      width: 400, height: 300, delay: 300,
      fullPage: false,
      path: savePath,
    })
    if (existsSync(savePath)) {
      const saved = readFileSync(savePath)
      if (saved.length === buf.length) ok('path 自动保存成功')
      else fail('path', `保存大小 ${saved.length} ≠ 返回大小 ${buf.length}`)
    } else {
      fail('path', '文件未创建')
    }
  } catch (err: any) {
    fail('path', err)
  }

  // ── 5. retry ──────────────────────────────────────────────
  console.log('\n═══ 5. retry ═══')
  try {
    // 对正常 URL 使用 retry，应该一次成功
    const buf = await screenshot(baseUrl, {
      width: 400, height: 300, delay: 300,
      fullPage: false,
      retry: 3,
    })
    if (buf.length > 100) ok('retry 正常 URL 一次成功')
    else fail('retry', 'PNG 数据过小')
  } catch (err: any) {
    fail('retry', err)
  }

  // ── 6. pageGotoParams.timeout ─────────────────────────────
  console.log('\n═══ 6. pageGotoParams.timeout ═══')
  try {
    const buf = await screenshot(baseUrl, {
      width: 400, height: 300, delay: 300,
      fullPage: false,
      pageGotoParams: { timeout: 60000 },
    })
    if (buf.length > 100) ok('pageGotoParams.timeout 正常工作')
    else fail('pageGotoParams.timeout', 'PNG 数据过小')
  } catch (err: any) {
    fail('pageGotoParams.timeout', err)
  }

  // ── 7. omitBackground: false（默认白色背景） ──────────────
  console.log('\n═══ 7. omitBackground: false ═══')
  try {
    const buf = await screenshot(`${baseUrl}/transparent`, {
      width: 400, height: 300, delay: 300,
      omitBackground: false,
      fullPage: false,
    })
    writeFileSync('test/output/opt_opaque.png', buf)
    if (buf.length > 100) ok('默认白色背景截图成功')
    else fail('omitBackground: false', 'PNG 数据过小')
  } catch (err: any) {
    fail('omitBackground: false', err)
  }

  // ── 8. clip + fullPage ────────────────────────────────────
  console.log('\n═══ 8. clip + fullPage ═══')
  try {
    const buf = await screenshot(baseUrl, {
      width: 800, height: 600, delay: 300,
      fullPage: true,
      clip: { x: 0, y: 0, width: 200, height: 300 },
    })
    writeFileSync('test/output/opt_clip_fullpage.png', buf)
    if (buf.length > 100) ok('clip + fullPage 组合正常工作')
    else fail('clip + fullPage', 'PNG 数据过小')
  } catch (err: any) {
    fail('clip + fullPage', err)
  }

  // ── 汇总 ──────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(40)}`)
  console.log(`[结果] ${passed} 通过, ${failed} 失败`)

  await shutdown()
  server.close()

  if (failed > 0) process.exit(1)
}

main().catch(err => {
  console.error('测试失败:', err)
  process.exit(1)
})
