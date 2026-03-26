// scripts/setup.ts — 开发环境初始化脚本（跨平台）
// 功能：下载 CEF 最小发行版，编译 C++ 辅助进程
// 用法：
//   pnpm run setup                            # 当前平台
//   pnpm run setup:cpp                        # 仅重新编译 C++（CEF 已缓存）
//   node --experimental-strip-types setup.ts --target=aarch64-pc-windows-msvc  # 交叉编译

import { execSync } from 'node:child_process'
import {
  existsSync, mkdirSync, readdirSync, statSync, readFileSync,
  createWriteStream, unlinkSync, copyFileSync, rmSync, renameSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { get as httpsGet } from 'node:https'
import { IncomingMessage } from 'node:http'
import { arch as osArch, platform as osPlatform } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))

const CEF_VERSION = '146.0.7+ga6b143f+chromium-146.0.7680.165'
const ROOT_DIR    = join(__dirname, '..')
const HELPER_DIR  = join(ROOT_DIR, 'cef-helper')

// ──────────────────────────────────────────────────────────────────────────
// 参数解析
// ──────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const CPP_ONLY   = args.includes('--cpp-only')
const TARGET_ARG = args.find(a => a.startsWith('--target='))?.slice('--target='.length)

// ──────────────────────────────────────────────────────────────────────────
// 平台/架构 → CEF URL 后缀映射
// ──────────────────────────────────────────────────────────────────────────

/** Rust target triple → CEF 平台名称 */
const TRIPLE_TO_CEF: Record<string, string> = {
  'x86_64-pc-windows-msvc':     'windows64',
  'aarch64-pc-windows-msvc':    'windowsarm64',
  'x86_64-unknown-linux-gnu':   'linux64',
  'aarch64-unknown-linux-gnu':  'linuxarm64',
  'armv7-unknown-linux-gnueabihf': 'linuxarm',
  'x86_64-apple-darwin':        'macosx64',
  'aarch64-apple-darwin':       'macosarm64',
}

/** 当前 Node.js 运行平台 → CEF 平台名称（无 --target 时自动推断） */
function detectCefPlatform(): string {
  const p = osPlatform()
  const a = osArch()
  if (p === 'win32')  return a === 'arm64' ? 'windowsarm64' : 'windows64'
  if (p === 'linux')  return a === 'arm64' ? 'linuxarm64' : a === 'arm' ? 'linuxarm' : 'linux64'
  if (p === 'darwin') return a === 'arm64' ? 'macosarm64' : 'macosx64'
  throw new Error(`不支持的平台: ${p} ${a}`)
}

function getCefPlatform(): string {
  if (TARGET_ARG) {
    const p = TRIPLE_TO_CEF[TARGET_ARG]
    if (!p) throw new Error(`未知 target triple: ${TARGET_ARG}\n支持: ${Object.keys(TRIPLE_TO_CEF).join(', ')}`)
    return p
  }
  return detectCefPlatform()
}

// ──────────────────────────────────────────────────────────────────────────
// 路径计算
// ──────────────────────────────────────────────────────────────────────────
const CEF_PLATFORM     = getCefPlatform()
const CEF_FILENAME     = `cef_binary_${CEF_VERSION}_${CEF_PLATFORM}_minimal.tar.bz2`
const CEF_URL          = `https://cef-builds.spotifycdn.com/${CEF_FILENAME.replace(/\+/g, '%2B')}`
const THIRD_PARTY_DIR  = join(ROOT_DIR, 'third_party', CEF_PLATFORM)   // 按平台隔离
const CEF_DIR          = join(THIRD_PARTY_DIR, 'cef')
const HELPER_BUILD_DIR = join(HELPER_DIR, 'build', CEF_PLATFORM)

// ──────────────────────────────────────────────────────────────────────────
// cmake 检测
// ──────────────────────────────────────────────────────────────────────────
function findCmake(): string {
  try { execSync('cmake --version', { stdio: 'ignore' }); return 'cmake' } catch {}
  const winPaths = [
    'C:\\Program Files\\CMake\\bin\\cmake.exe',
    'C:\\Program Files (x86)\\CMake\\bin\\cmake.exe',
  ]
  for (const p of winPaths) {
    if (existsSync(p)) return `"${p}"`
  }
  throw new Error(
    'cmake 未找到！\n' +
    '请安装 CMake（https://cmake.org）并确保以下任一条件满足：\n' +
    '  1. 安装时勾选 "Add CMake to the system PATH for all users"\n' +
    '  2. 重新打开终端使 PATH 生效'
  )
}

// ──────────────────────────────────────────────────────────────────────────
// cmake 配置参数推断
// ──────────────────────────────────────────────────────────────────────────
interface CmakeConfig {
  generator: string
  arch?: string       // Windows -A 参数
  toolchain?: string  // 交叉编译工具链文件
  extraDefines?: string[]  // 额外 CMake 定义
}

function getCmakeConfig(): CmakeConfig {
  // ── Windows ──────────────────────────────────────────────────────────
  if (TARGET_ARG === 'x86_64-pc-windows-msvc' || TARGET_ARG === 'aarch64-pc-windows-msvc') {
    const arch = TARGET_ARG.includes('aarch64') ? 'ARM64' : 'x64'
    return { generator: 'Visual Studio 17 2022', arch }
  }
  if (!TARGET_ARG && osPlatform() === 'win32') {
    const a = osArch() === 'arm64' ? 'ARM64' : 'x64'
    return { generator: 'Visual Studio 17 2022', arch: a }
  }

  // ── macOS ────────────────────────────────────────────────────────────
  if (TARGET_ARG?.includes('apple-darwin') || (!TARGET_ARG && osPlatform() === 'darwin')) {
    const defines: string[] = []
    // Homebrew prefix (ARM64: /opt/homebrew, Intel: /usr/local)
    const brewPrefix = osArch() === 'arm64' ? '/opt/homebrew' : '/usr/local'
    const prefixPaths = [brewPrefix]
    // macOS x86_64 cross-compile on ARM64 host
    if (TARGET_ARG === 'x86_64-apple-darwin' && osArch() === 'arm64') {
      defines.push('CMAKE_OSX_ARCHITECTURES=x86_64')
      // CI builds libpng for x86_64 at /tmp/libpng-x86_64
      if (existsSync('/tmp/libpng-x86_64')) {
        prefixPaths.unshift('/tmp/libpng-x86_64')
      }
    }
    // macOS ARM64 cross-compile on Intel host
    if (TARGET_ARG === 'aarch64-apple-darwin' && osArch() === 'x64') {
      defines.push('CMAKE_OSX_ARCHITECTURES=arm64')
    }
    defines.push(`CMAKE_PREFIX_PATH="${prefixPaths.join(';')}"`)  // 引号防止 shell 拆分分号
    return { generator: 'Ninja', extraDefines: defines }
  }

  // ── Linux 交叉编译 ──────────────────────────────────────────────────
  if (TARGET_ARG === 'aarch64-unknown-linux-gnu' && osPlatform() === 'linux' && osArch() !== 'arm64') {
    const extraDefines: string[] = []
    if (existsSync('/tmp/libpng-cross')) {
      extraDefines.push('CMAKE_PREFIX_PATH=/tmp/libpng-cross')
    }
    return {
      generator: 'Ninja',
      toolchain: join(ROOT_DIR, 'ci', 'toolchains', 'aarch64-linux-gnu.cmake'),
      extraDefines,
    }
  }
  if (TARGET_ARG === 'armv7-unknown-linux-gnueabihf' && osPlatform() === 'linux' && osArch() !== 'arm') {
    const extraDefines: string[] = []
    if (existsSync('/tmp/libpng-cross')) {
      extraDefines.push('CMAKE_PREFIX_PATH=/tmp/libpng-cross')
    }
    return {
      generator: 'Ninja',
      toolchain: join(ROOT_DIR, 'ci', 'toolchains', 'armv7-linux-gnueabihf.cmake'),
      extraDefines,
    }
  }

  // ── Linux 本机构建 ──────────────────────────────────────────────────
  return { generator: 'Ninja' }
}

// ──────────────────────────────────────────────────────────────────────────
// 文件下载（支持重定向 + 进度显示）
// ──────────────────────────────────────────────────────────────────────────
function download(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`  正在下载: ${url}`)
    const file = createWriteStream(dest)
    function doGet(currentUrl: string) {
      httpsGet(currentUrl, (response: IncomingMessage) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          file.close(); return doGet(response.headers.location!)
        }
        if (response.statusCode !== 200) {
          file.close(); if (existsSync(dest)) unlinkSync(dest)
          return reject(new Error(`HTTP ${response.statusCode}`))
        }
        const total = parseInt(response.headers['content-length'] as string, 10)
        let downloaded = 0, lastPercent = 0
        response.on('data', (chunk: Buffer) => {
          downloaded += chunk.length
          if (total) {
            const pct = Math.floor((downloaded / total) * 100)
            if (pct >= lastPercent + 5) {
              process.stdout.write(`\r  进度: ${pct}%（${(downloaded / 1024 / 1024).toFixed(1)} MB / ${(total / 1024 / 1024).toFixed(1)} MB）`)
              lastPercent = pct
            }
          }
        })
        response.pipe(file)
        file.on('finish', () => { file.close(); console.log('\n  下载完成。'); resolve() })
      }).on('error', (err: Error) => {
        file.close(); if (existsSync(dest)) unlinkSync(dest); reject(err)
      })
    }
    doGet(url)
  })
}

// ──────────────────────────────────────────────────────────────────────────
// 下载并解压 CEF
// ──────────────────────────────────────────────────────────────────────────
async function downloadCEF() {
  if (existsSync(CEF_DIR) && existsSync(join(CEF_DIR, 'include'))) {
    console.log(`[CEF] 已存在（${CEF_PLATFORM}），跳过下载。`)
    return
  }
  mkdirSync(THIRD_PARTY_DIR, { recursive: true })
  const archivePath = join(THIRD_PARTY_DIR, CEF_FILENAME)
  if (!existsSync(archivePath)) {
    await download(CEF_URL, archivePath)
  }
  console.log('[CEF] 正在解压...')
  // Windows CI 下 PATH 可能优先 Git Bash 的 GNU tar（缺少 bzip2），
  // 使用系统 tar.exe（基于 libarchive，内置 bzip2 支持）
  const tarCmd = osPlatform() === 'win32'
    ? `"${process.env.SystemRoot || 'C:\\Windows'}\\System32\\tar.exe"`
    : 'tar'
  execSync(`${tarCmd} -xf "${archivePath}" -C "${THIRD_PARTY_DIR}"`, { stdio: 'inherit' })
  const cefExtDir = readdirSync(THIRD_PARTY_DIR).find(
    e => e.startsWith('cef_binary_') && statSync(join(THIRD_PARTY_DIR, e)).isDirectory()
  )
  if (!cefExtDir) throw new Error('解压后未找到 CEF 目录')
  const extractedPath = join(THIRD_PARTY_DIR, cefExtDir)
  if (extractedPath !== CEF_DIR) {
    if (existsSync(CEF_DIR)) rmSync(CEF_DIR, { recursive: true })
    renameSync(extractedPath, CEF_DIR)
  }
  unlinkSync(archivePath)
  console.log('[CEF] 解压完成。')
}

// ──────────────────────────────────────────────────────────────────────────
// CMake 配置 + 编译
// ──────────────────────────────────────────────────────────────────────────
function buildHelper() {
  const cmake = findCmake()
  const cfg = getCmakeConfig()
  console.log(`[C++] cmake: ${cmake}，生成器: ${cfg.generator}${cfg.arch ? ` -A ${cfg.arch}` : ''}`)

  mkdirSync(HELPER_BUILD_DIR, { recursive: true })

  const configArgs = [
    cmake,
    `-S "${HELPER_DIR}"`,
    `-B "${HELPER_BUILD_DIR}"`,
    `-DCEF_ROOT="${CEF_DIR}"`,
    `-G "${cfg.generator}"`,
    cfg.arch      ? `-A ${cfg.arch}` : '',
    cfg.toolchain ? `-DCMAKE_TOOLCHAIN_FILE="${cfg.toolchain}"` : '',
    ...(cfg.extraDefines || []).map(d => `-D${d}`),
  ].filter(Boolean).join(' ')

  console.log('[C++] CMake 配置...')
  console.log(`[C++] Command: ${configArgs}`)
  try {
    execSync(configArgs, { stdio: 'inherit', cwd: HELPER_DIR })
  } catch (e) {
    // 打印 CMake 日志以便诊断
    const logPath = join(HELPER_BUILD_DIR, 'CMakeFiles', 'CMakeConfigureLog.yaml')
    if (existsSync(logPath)) {
      const log = readFileSync(logPath, 'utf-8')
      console.error('\n[C++] CMake configure log (last 5000 chars):')
      console.error(log.slice(-5000))
    }
    throw e
  }

  console.log('[C++] 编译 Release...')
  const buildCmd = `${cmake} --build "${HELPER_BUILD_DIR}" --config Release`
  console.log(`[C++] Build command: ${buildCmd}`)
  try {
    execSync(buildCmd, { stdio: 'inherit' })
  } catch (e) {
    // 构建失败时尝试用 verbose 模式重新运行以获取详细错误
    console.error('\n[C++] Build failed! Retrying last 3 targets with verbose output...')
    try {
      const verboseOutput = execSync(
        `${cmake} --build "${HELPER_BUILD_DIR}" --config Release --verbose -- -j1 2>&1`,
        { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 60000 }
      ).toString()
      const lines = verboseOutput.split('\n')
      console.error(lines.slice(-80).join('\n'))
    } catch (verboseErr: any) {
      // verbose 重建也会失败，输出最后几行
      const output = verboseErr?.stdout || verboseErr?.stderr || ''
      const lines = output.toString().split('\n')
      console.error(lines.slice(-80).join('\n'))
    }
    throw e
  }

  // 复制 CEF 运行时文件到输出目录
  const outputDir = join(HELPER_BUILD_DIR, 'Release')
  console.log('[C++] 复制 CEF 运行时文件...')

  const copyDir = (src: string, dst: string) => {
    mkdirSync(dst, { recursive: true })
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      const srcPath = join(src, entry.name)
      const dstPath = join(dst, entry.name)
      if (entry.isDirectory()) copyDir(srcPath, dstPath)
      else copyFileSync(srcPath, dstPath)
    }
  }

  // DLL/so（Release/）
  const cefRelease = join(CEF_DIR, 'Release')
  for (const f of readdirSync(cefRelease)) {
    const src = join(cefRelease, f)
    const stat = statSync(src)
    if (stat.isFile()) copyFileSync(src, join(outputDir, f))
    else if (stat.isDirectory()) copyDir(src, join(outputDir, f)) // macOS .framework
  }

  // 资源（pak、locales/）
  const resDir = join(CEF_DIR, 'Resources')
  if (existsSync(resDir)) {
    for (const f of readdirSync(resDir)) {
      const src = join(resDir, f)
      const dst = join(outputDir, f)
      if (statSync(src).isDirectory()) copyDir(src, dst)
      else copyFileSync(src, dst)
    }
  }

  console.log('[C++] 构建完成。')
}

// ──────────────────────────────────────────────────────────────────────────
// 主函数
// ──────────────────────────────────────────────────────────────────────────
async function main() {
  const targetDesc = TARGET_ARG ? ` [目标: ${TARGET_ARG}]` : ''
  console.log(`=== CEF Screenshot 初始化${targetDesc} ===\n`)
  console.log(`平台标识: ${CEF_PLATFORM}`)
  console.log(`CEF 目录: ${CEF_DIR}`)
  console.log(`构建目录: ${HELPER_BUILD_DIR}\n`)

  if (!CPP_ONLY) {
    await downloadCEF()
    console.log('')
  } else {
    console.log('[跳过 CEF 下载，--cpp-only 模式]\n')
  }

  buildHelper()

  console.log('\n=== 初始化完成 ===')
  console.log('下一步：')
  console.log('  pnpm run build           # 编译 Rust Napi 绑定')
  console.log('  pnpm run pack:runtime    # 打包 CEF 运行时 tar.gz')
}

main().catch(err => {
  console.error('\n初始化失败:', err.message)
  process.exit(1)
})
