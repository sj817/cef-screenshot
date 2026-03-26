# cef-screenshot

基于 [CEF（Chromium Embedded Framework）](https://bitbucket.org/chromiumembedded/cef) 离屏渲染技术实现的 Node.js 网页截图工具。相比 Puppeteer，内存占用减少约 **57%**，分发体积减少约 **59%**。

## 特性

- **超低内存**：CEF 离屏渲染（OSR），无需 Chromium 进程管理层
- **并发截图**：内置浏览器池，支持多个页面同时截图
- **原生性能**：Rust + napi-rs 实现，C++ CEF 辅助进程
- **TypeScript 原生**：完整类型声明，支持 Node.js 22+ 直接运行 `.ts`

## 系统要求

| 项目 | 要求 |
|------|------|
| 操作系统 | Windows x64（Linux/macOS 计划中） |
| Node.js | >= 22.6.0 |
| 包管理器 | pnpm >= 9 |

## 安装

```bash
pnpm add cef-screenshot
```

安装时会自动运行 `postinstall`，尝试从配置的 CDN 下载 CEF 运行时。

### 配置运行时下载地址

CEF 运行时体积约 ~167MB（压缩后），需要从 GitHub Release 或自建 CDN 下载：

```bash
# 方式一：环境变量（推荐 CI 场景）
export CEF_SCREENSHOT_CDN=https://github.com/your-org/cef-screenshot/releases/download/v1.0.0/

# 方式二：package.json（推荐生产场景）
```

```json
{
  "cef-screenshot": {
    "mirrorUrl": "https://your-cdn.com/cef-screenshot/"
  }
}
```

## 用法

```ts
import { init, screenshot, shutdown } from 'cef-screenshot'

// 初始化（启动 CEF 浏览器池）
await init({ concurrency: 3 })

// 截图（返回 PNG Buffer）
const buf = await screenshot('https://example.com', {
  width: 1920,
  height: 1080,
  delay: 500,   // 页面加载后额外等待毫秒数
})

// 保存文件
import { writeFileSync } from 'node:fs'
writeFileSync('output.png', buf)

// 退出前关闭
await shutdown()
```

### 并发截图

```ts
await init({ concurrency: 5 })

const urls = ['https://example.com', 'https://www.baidu.com', ...]

// 所有截图并发执行，由内部浏览器池调度
const buffers = await Promise.all(
  urls.map(url => screenshot(url))
)
```

## API

### `init(options?)`

启动 CEF 辅助进程并初始化浏览器池。**必须在调用 `screenshot()` 之前调用。**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `helperDir` | `string` | 自动检测 | `cef_screenshot_helper.exe` 所在目录 |
| `concurrency` | `number` | `3` | 并发浏览器槽位数量（最大 10） |

### `screenshot(url, options?)`

对指定 URL 进行截图，返回 PNG 格式的 `Buffer`。

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `url` | `string` | — | 目标 URL（须以 `http://` 或 `https://` 开头） |
| `width` | `number` | `1920` | 视窗宽度（像素） |
| `height` | `number` | `1080` | 视窗高度（像素） |
| `delay` | `number` | `500` | 页面 `load` 事件后额外等待时间（毫秒） |

### `shutdown()`

关闭 CEF 辅助进程，释放所有资源。建议在程序退出前调用。

## 交互式控制台

```bash
pnpm run interactive
```

启动后初始化 CEF，然后可以输入 URL 进行实时截图：

```
> https://example.com
→ 正在截图: https://example.com
✓ 截图完成
  文件: output/example.com_1234567890.png
  大小: 142.3 KB
  耗时: 1823 ms
  内存: RSS 89.2 MB，堆 42.1 MB/64.0 MB
```

输入 `exit` 退出。

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

- [Visual Studio 2022](https://visualstudio.microsoft.com/) — C++ 桌面开发工作负载
- [CMake 4.0+](https://cmake.org/download/) — 安装时勾选 **Add CMake to the system PATH**
- [Rust 1.70+](https://rustup.rs/) — `rustup target add x86_64-pc-windows-msvc`
- Node.js 22.6+，pnpm 9+

### 快速开始

```bash
# 克隆仓库
git clone https://github.com/your-org/cef-screenshot.git
cd cef-screenshot

# 安装 Node.js 依赖
pnpm install

# 下载 CEF 并编译 C++ 辅助进程（首次约需 5~10 分钟）
pnpm run setup

# 编译 Rust Napi 绑定
pnpm run build

# 运行测试
pnpm run test
pnpm run test:concurrent

# 运行基准测试
pnpm run benchmark
```

### CMake 无法找到的解决方法

如果 `pnpm run setup` 报 `cmake 未找到`，请：

1. 确认 CMake 已安装：[https://cmake.org/download/](https://cmake.org/download/)
2. 安装时勾选 **"Add CMake to the system PATH for all users"**
3. **重新打开终端**（PATH 变更需要重启终端生效）
4. 验证：`cmake --version`

VS Code 已配置了 `terminal.integrated.env.windows.PATH` 将 `C:\Program Files\CMake\bin` 注入终端 PATH，通常可自动修复此问题。

### 目录结构

```
cef-screenshot/
├── .github/workflows/      # CI/CD 工作流
├── cef-helper/             # C++ CEF 辅助进程源码
│   ├── main.cpp            # 浏览器池 + OSR 截图逻辑
│   └── CMakeLists.txt      # CMake 构建配置
├── src/                    # Rust Napi 绑定源码
│   └── lib.rs
├── packages/
│   └── win32-x64-msvc/     # Windows x64 npm 子包
├── benchmark/              # CEF vs Puppeteer 性能对比
├── scripts/                # 开发辅助脚本
│   ├── setup.ts            # 下载 CEF + 编译 C++
│   ├── pack.ts             # 打包 CEF 运行时归档
│   ├── postinstall.ts      # npm 安装后自动下载运行时
│   └── interactive.ts      # 交互式截图控制台
├── test/                   # 测试用例
├── index.ts                # 主入口（TypeScript）
├── Cargo.toml              # Rust 包配置
├── package.json
└── tsconfig.json
```

### 架构说明

```
Node.js (index.ts)
    │
    │  napi-rs (.node 绑定)
    ▼
Rust (src/lib.rs)          ← 并发请求管理，tokio + oneshot 通道
    │
    │  stdin/stdout IPC（制表符分隔协议）
    ▼
cef_screenshot_helper.exe  ← C++ CEF 浏览器池
    │
    │  CEF OSR (Off-Screen Rendering)
    ▼
libcef.dll                 ← Chromium Embedded Framework
```

**IPC 协议**：
- 请求：`ID\tWIDTH\tHEIGHT\tDELAY_MS\tURL\n`
- 响应：`ID\tok\tFILE_PATH\n` 或 `ID\terror\tMESSAGE\n`

### npm 发布

版本发布通过 Git 标签触发 CI 自动完成：

```bash
# 更新版本号
pnpm version patch  # 或 minor / major

# 同步子包版本（手动编辑 packages/win32-x64-msvc/package.json）

# 推送标签触发 CI
git push origin --tags
```

CI 流程：
1. 构建 C++ + Rust → 生成 `.node` 文件
2. 发布 `cef-screenshot-win32-x64-msvc`（子包，含 `.node`）
3. 上传 CEF 运行时归档到 GitHub Release
4. 发布 `cef-screenshot`（主包）

## 许可证

MIT
