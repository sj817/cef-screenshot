# cef-screenshot

基于 [CEF（Chromium Embedded Framework）](https://bitbucket.org/chromiumembedded/cef) 离屏渲染技术实现的 Node.js 网页截图工具。相比 Puppeteer，内存占用减少约 **57%**，分发体积减少约 **59%**。

## 特性

- **超低内存**：CEF 离屏渲染（OSR），无需 Chromium 进程管理层
- **多浏览器多标签**：支持多进程 + 多标签页并发，灵活控制资源与吞吐
- **原生性能**：Rust + napi-rs 实现，C++ CEF 辅助进程
- **全平台支持**：Windows / Linux / macOS，x64 / ARM64

## 平台支持

| 平台 | 架构 |
|------|------|
| Windows | x64, ARM64 |
| Linux | x64, ARM64, ARMv7 |
| macOS | x64, ARM64 |

## 系统要求

| 项目 | 要求 |
|------|------|
| Node.js | >= 22.6.0 |
| 包管理器 | pnpm >= 9 |

> **注意**：包的主入口为 TypeScript 源文件（`index.ts`），依赖 Node.js 22.6+ 内置的 `--experimental-strip-types` 直接运行。如果你的项目使用 bundler（esbuild / Vite 等），可直接导入无需额外配置。

## 安装

```bash
pnpm add cef-screenshot
```

安装时会自动运行 `postinstall`，尝试从配置的 CDN 下载 CEF 运行时。

### 配置运行时下载地址

CEF 运行时体积约 ~167MB（压缩后），需要从 GitHub Release 或自建 CDN 下载：

```bash
# 方式一：环境变量（推荐 CI 场景）
export CEF_SCREENSHOT_CDN=https://github.com/sj817/cef-screenshot/releases/download/v0.1.8/
```

```jsonc
// 方式二：package.json（推荐生产场景）
{
  "cef-screenshot": {
    "mirrorUrl": "https://your-cdn.com/cef-screenshot/"
  }
}
```

## 快速开始

```ts
// demo.ts — 运行: node demo.ts
import { init, screenshot, shutdown } from 'cef-screenshot'
import { writeFileSync } from 'node:fs'

await init()

const buf = await screenshot('https://example.com', {
  width: 1280,
  height: 800,
  delay: 500,
})
writeFileSync('example.png', buf)
console.log(`截图完成，大小: ${buf.length} 字节`)

await shutdown()
```

### 多浏览器多标签并发

```ts
import { init, screenshot, shutdown } from 'cef-screenshot'

// 2 个浏览器进程 × 5 个标签页 = 最多 10 页并发
await init({ browsers: 2, tabs: 5 })

const urls = [
  'https://example.com',
  'https://www.baidu.com',
  'https://httpbin.org/html',
]

const buffers = await Promise.all(
  urls.map(url => screenshot(url))
)
console.log(`完成 ${buffers.length} 张截图`)

await shutdown()
```

## API

### `init(options?)`

启动 CEF 辅助进程，初始化浏览器池。**必须在调用 `screenshot()` 之前调用。**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `helperDir` | `string` | 自动检测 | CEF helper 二进制文件所在目录 |
| `browsers` | `number` | `1` | 浏览器进程数量（最大 5） |
| `tabs` | `number` | `3` | 每个浏览器进程的标签页数量（最大 10） |

> 总并发数 = `browsers` × `tabs`。低配机器建议 1 浏览器 + 多标签（节省内存），高配机器可多浏览器 + 多标签（最大化吞吐）。

### `screenshot(url, options?)`

对指定 URL 进行截图，返回 PNG 格式的 `Buffer`。

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `url` | `string` | — | 目标 URL（须以 `http://` 或 `https://` 开头） |
| `width` | `number` | `1920` | 视窗宽度（像素） |
| `height` | `number` | `1080` | 视窗高度（像素） |
| `delay` | `number` | `500` | 页面 `load` 事件后额外等待时间（毫秒） |
| `selector` | `string` | — | CSS 选择器，截图指定元素 |
| `fullPage` | `boolean` | `true` | 是否截取完整页面（含滚动区域） |
| `sliceHeight` | `number` | — | 分片高度（像素），设置后返回 `Buffer[]` |

#### 全页截图（默认行为）

默认自动检测页面完整高度，截取包含滚动区域在内的完整页面。设置 `fullPage: false` 可回退到仅截取视窗可见区域。

```ts
// 截取完整页面（包含滚动区域）
const buf = await screenshot('https://example.com')

// 仅截取视窗可见区域
const buf2 = await screenshot('https://example.com', { fullPage: false })
```

#### 元素选择器截图

使用 CSS 选择器截取页面上的指定元素：

```ts
const buf = await screenshot('https://example.com', {
  selector: '#main-content',
  width: 1280,
  height: 800,
})
```

#### 分片截图

将长截图按指定高度切分为多张图片，相邻分片重叠 100px 以保证视觉连续性：

```ts
const slices = await screenshot('https://example.com', {
  sliceHeight: 1200,  // 每片 1200px 高
})
// slices: Buffer[] — 每个元素为一张 PNG
for (let i = 0; i < slices.length; i++) {
  writeFileSync(`page_${i}.png`, slices[i])
}
```

### `shutdown()`

关闭所有 CEF 辅助进程，释放资源。建议在程序退出前调用。

## 性能对比

测试环境：Windows 11 x64，5 个真实网页，视窗 1280×800，加载后等待 800ms

| 指标 | cef-screenshot | Puppeteer | 优势 |
|------|---------------|-----------|------|
| 串行截图均值 | ~1850ms | ~1700ms | 相近 |
| 并发截图总耗时 | ~2850ms | ~3000ms | CEF 快 ~1.1x |
| 内存峰值（Node+子进程） | ~250MB | ~580MB | **CEF 省 57%** |
| 分发体积 | ~170MB | ~415MB | **CEF 小 59%** |

## 开发指南

### 环境依赖

- C++ 编译器（Windows: MSVC, Linux: GCC, macOS: Clang）
- [CMake 4.0+](https://cmake.org/download/)
- [Rust 1.70+](https://rustup.rs/)
- Node.js 22.6+, pnpm 9+

### 本地构建

```bash
git clone https://github.com/sj817/cef-screenshot.git
cd cef-screenshot
pnpm install

# 下载 CEF 并编译 C++ 辅助进程
pnpm run setup

# 编译 Rust Napi 绑定
pnpm run build

# 运行测试
pnpm run test
```

### 架构

```
Node.js (index.ts)
    │  napi-rs (.node)
    ▼
Rust (src/lib.rs)       ← HelperPool: 多进程管理, tokio + oneshot
    │  stdin/stdout IPC
    ▼
cef_screenshot_helper   ← C++ CEF 浏览器池, --pool=N 多标签
    │  CEF OSR
    ▼
libcef                  ← Chromium Embedded Framework
```

## 许可证

MIT
