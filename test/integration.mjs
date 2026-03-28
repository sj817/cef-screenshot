// test/integration.mjs — CI 集成测试：真实截图验证
import { init, screenshot, shutdown } from 'cef-screenshot'
import { writeFileSync, statSync } from 'node:fs'

console.log('初始化 CEF...')
await init({ browsers: 1, tabs: 1 })

console.log('截图 https://example.com ...')
const buf = await screenshot('https://example.com', {
  width: 1280,
  height: 800,
  delay: 2000,
})
writeFileSync('test-screenshot.png', buf)

const { size } = statSync('test-screenshot.png')
if (size === 0) throw new Error('Screenshot file is empty!')
console.log(`✅ 截图成功: ${size} bytes`)

await shutdown()
console.log('✅ 集成测试通过！')
