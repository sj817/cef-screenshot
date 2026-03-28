// test/verify-install.mjs — CI 安装验证脚本（在临时目录中运行）
// 完整验证：ESM 导入 → 导出函数 → CEF helper 存在 → 真实截图
import { existsSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const _require = createRequire(import.meta.url)

// 1. 导入包（通过 ESM exports 解析到 index.js）
const { init, screenshot, shutdown } = await import('cef-screenshot')
console.log('✅ 原生绑定加载成功')

// 2. 验证导出函数存在且为函数类型
for (const [name, fn] of Object.entries({ init, screenshot, shutdown })) {
  if (typeof fn !== 'function')
    throw new Error(`缺少导出函数: ${name}`)
}
console.log('✅ 所有导出函数存在')

// 3. 检查 CEF helper 二进制文件（通过环境变量传入平台信息）
const suffix = process.env.NPM_SUFFIX
if (suffix) {
  const pkgDir = dirname(_require.resolve(`cef-screenshot-${suffix}/package.json`))
  const helperName = process.env.HELPER_NAME ||
    (process.platform === 'win32' ? 'cef_screenshot_helper.exe' : 'cef_screenshot_helper')
  const helperPath = join(pkgDir, helperName)
  if (!existsSync(helperPath)) {
    throw new Error(`CEF helper 不存在: ${helperPath}`)
  }
  console.log('✅ CEF helper 二进制文件存在')
}

// 4. 真实截图测试（仅在 SKIP_SCREENSHOT 未设置时执行）
if (!process.env.SKIP_SCREENSHOT) {
  console.log('初始化 CEF...')
  await init({ browsers: 1, tabs: 1 })

  // 4a. 基础全页截图
  console.log('截图 https://example.com（全页）...')
  const buf = await screenshot('https://example.com', {
    width: 1280,
    height: 800,
    delay: 2000,
  })
  writeFileSync('test-screenshot.png', buf)

  const { size } = statSync('test-screenshot.png')
  if (size === 0) throw new Error('截图文件为空!')
  console.log(`✅ 全页截图成功: ${size} bytes`)

  // 4b. 元素选择器截图
  console.log('截图 https://example.com（元素: h1）...')
  const elemBuf = await screenshot('https://example.com', {
    width: 1280, height: 800, delay: 2000,
    selector: 'h1',
  })
  writeFileSync('test-screenshot-element.png', elemBuf)
  if (elemBuf.length === 0) throw new Error('元素截图为空!')
  console.log(`✅ 元素截图成功: ${elemBuf.length} bytes`)

  // 4c. 分片截图
  console.log('截图 https://example.com（分片: 400px）...')
  const slices = await screenshot('https://example.com', {
    width: 1280, height: 800, delay: 2000,
    sliceHeight: 400,
  })
  if (!Array.isArray(slices) || slices.length === 0) throw new Error('分片截图返回异常!')
  console.log(`✅ 分片截图成功: ${slices.length} 片`)

  await shutdown()
}

console.log('\n✅ 包安装验证全部通过！')
