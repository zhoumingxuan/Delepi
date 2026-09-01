/**
 * Delepi 预置 Python 环境构建脚本
 *
 * 依据《Delepi 预置 Python 环境包技术方案》第2.2节构建流程图、第2.3节核心实现、
 * 第5章预装依赖清单、第8.3节 .beez-preset 标记文件、第11.1节构建验收标准实现。
 *
 * 构建流程（8步）：
 *   1. 检查缓存（scripts/cache/python-3.14.6-embed-amd64.zip）
 *   2. 解压到临时构建目录 scripts/.build/python-3.14.6/
 *   3. 配置 _pth 文件（取消注释 import site、添加 Lib/site-packages）
 *   4. 安装 pip（ensurepip → get-pip.py fallback）
 *   5. 安装预装依赖（python -m pip install --target Lib/site-packages）
 *   6. 清理（__pycache__/、pip 缓存、get-pip.py）
 *   7. 验证（python --version / pip --version / import 各预装包）
 *   8. 移动到最终位置 resources/python/python-3.14.6/ 并生成 .beez-preset
 */

import { createWriteStream, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { copyFile, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { get } from 'node:https';
import { IncomingMessage } from 'node:http';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const PYTHON_VERSION = '3.14.6';
const PYTHON_SHORT = '3.14';
const EMBED_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`;
// mac/linux 变体运行时来源：python-build-standalone（PBS）便携发行版（python.org 无 macOS/Linux 免安装发行版）。
// tag 固定 20260804：更新的 release tag 已无 cpython-3.14.6 资产（2026-08-22 盘点实测）。
const PBS_TAG = '20260804';
// triple 运行时解析：mac 按宿主 process.arch（arm64→aarch64-apple-darwin，否则 x86_64-apple-darwin）；linux 固定 x86_64-unknown-linux-gnu
const PBS_MAC_TRIPLE = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
const PBS_LINUX_TRIPLE = 'x86_64-unknown-linux-gnu';
/** PBS 缓存完整文件名（cpython-<版本>+<tag>-<triple>-install_only.tar.gz；同名 -freethreaded 资产因 triple 精确名天然排除） */
const pbsTarballName = (triple: string) => `cpython-${PYTHON_VERSION}+${PBS_TAG}-${triple}-install_only.tar.gz`;
/** PBS 下载 URL 模板（GitHub release 下载经多级 302 重定向，downloadFile 已支持） */
const pbsUrl = (triple: string) => `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/cpython-${PYTHON_VERSION}+${PBS_TAG}-${triple}-install_only.tar.gz`;
const CACHE_DIR = path.join(__dirname, 'cache');
const BUILD_DIR = path.join(__dirname, '.build');
const OUTPUT_DIR = path.join(__dirname, '..', 'resources', 'python', `python-${PYTHON_VERSION}`);
const PRESET_MARKER_FILE = '.beez-preset';
const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';
const DOWNLOAD_TIMEOUT_MS = 120_000;
const EXEC_TIMEOUT_MS = 600_000;

// ================================================================
// 构建变体（Win10 差异化打包，2026-08-22 新增；mac/Linux 差异化打包，2026-08-22 新增）
// 无参数 = default 变体：路径与命令与历史版本完全一致；
// 传入 --win10 / win10 / --preset=win10 = win10 变体：
//   独立输出目录 resources/python-win10、独立缓存 scripts/cache/win10、
//   独立包清单 requirements/requirements-preset-win10.txt、独立 .beez-preset 标记。
// 传入 --mac / mac / --preset=mac = mac 变体（须在 macOS 宿主执行，PBS 运行时）：
//   独立输出目录 resources/python-mac、独立缓存 scripts/cache/mac、
//   独立包清单 requirements/requirements-preset-mac.txt、独立 .beez-preset 标记。
// 传入 --linux / linux / --preset=linux = linux 变体（须在 Linux 宿主执行，PBS 运行时）：
//   独立输出目录 resources/python-linux、独立缓存 scripts/cache/linux、
//   独立包清单 requirements/requirements-preset-linux.txt、独立 .beez-preset 标记。
// ================================================================

/** 构建变体配置 */
interface BuildVariant {
  /** 最终输出目录 */
  outputDir: string;
  /** 发行包缓存路径（embed=嵌入式 zip；pbs=PBS tarball；win10 独立，避免复用主线缓存） */
  cacheZipPath: string;
  /** 临时构建目录名（scripts/.build/<name>） */
  buildDirName: string;
  /** requirements 包清单文件；null = 使用 PRESET_PACKAGES 常量（主线行为） */
  requirementsFile: string | null;
  /** pip 是否禁用本地缓存（win10：规避用户级 wheels 缓存权限问题，2026-08-22 实测 Errno13） */
  pipNoCacheDir: boolean;
  /** 运行时来源：embed = python.org Windows embeddable zip；pbs = python-build-standalone 便携 tarball（mac/linux） */
  runtime: 'embed' | 'pbs';
  /** 构建宿主平台（mac/linux 变体在 main 入口做宿主防呆校验；default/win10 恒为 win32，不新增校验） */
  hostPlatform: 'win32' | 'darwin' | 'linux';
}

const VARIANTS: Record<'default' | 'win10' | 'mac' | 'linux', BuildVariant> = {
  default: {
    outputDir: OUTPUT_DIR,
    cacheZipPath: path.join(CACHE_DIR, `python-${PYTHON_VERSION}-embed-amd64.zip`),
    buildDirName: `python-${PYTHON_VERSION}`,
    requirementsFile: null,
    pipNoCacheDir: false,
    runtime: 'embed',
    hostPlatform: 'win32',
  },
  win10: {
    outputDir: path.join(__dirname, '..', 'resources', 'python-win10', `python-${PYTHON_VERSION}`),
    cacheZipPath: path.join(CACHE_DIR, 'win10', `python-${PYTHON_VERSION}-embed-amd64.zip`),
    buildDirName: `python-${PYTHON_VERSION}-win10`,
    requirementsFile: path.join(__dirname, '..', 'requirements', 'requirements-preset-win10.txt'),
    pipNoCacheDir: true,
    runtime: 'embed',
    hostPlatform: 'win32',
  },
  mac: {
    outputDir: path.join(__dirname, '..', 'resources', 'python-mac', `python-${PYTHON_VERSION}`),
    cacheZipPath: path.join(CACHE_DIR, 'mac', pbsTarballName(PBS_MAC_TRIPLE)),
    buildDirName: `python-${PYTHON_VERSION}-mac`,
    requirementsFile: path.join(__dirname, '..', 'requirements', 'requirements-preset-mac.txt'),
    pipNoCacheDir: false,
    runtime: 'pbs',
    hostPlatform: 'darwin',
  },
  linux: {
    outputDir: path.join(__dirname, '..', 'resources', 'python-linux', `python-${PYTHON_VERSION}`),
    cacheZipPath: path.join(CACHE_DIR, 'linux', pbsTarballName(PBS_LINUX_TRIPLE)),
    buildDirName: `python-${PYTHON_VERSION}-linux`,
    requirementsFile: path.join(__dirname, '..', 'requirements', 'requirements-preset-linux.txt'),
    pipNoCacheDir: false,
    runtime: 'pbs',
    hostPlatform: 'linux',
  },
};

// 命令行参数识别：--win10 / win10 / --preset=win10、--mac / mac / --preset=mac、--linux / linux / --preset=linux
// 分别识别为对应变体；其余（含无参数）为 default（历史行为不变）
const VARIANT_ARG = process.argv.slice(2).find(
  (a) =>
    a === '--win10' || a === 'win10' || a === '--preset=win10' ||
    a === '--mac' || a === 'mac' || a === '--preset=mac' ||
    a === '--linux' || a === 'linux' || a === '--preset=linux',
);
const VARIANT_KEY: 'default' | 'win10' | 'mac' | 'linux' = VARIANT_ARG
  ? (VARIANT_ARG.includes('win10') ? 'win10' : VARIANT_ARG.includes('mac') ? 'mac' : 'linux')
  : 'default';
const VARIANT = VARIANTS[VARIANT_KEY];

// 预装依赖清单（对应6类功能需求，方案文档第5章）
const PRESET_PACKAGES: Record<string, string> = {
  // PDF处理
  'pdfplumber': '>=0.11.0',
  'PyPDF2': '>=3.0.0',
  // Word处理
  'python-docx': '>=1.1.0',
  // Excel/CSV处理（openpyxl同时覆盖Excel和CSV读写）
  'openpyxl': '>=3.1.0',
  // 画图/曲线图
  'matplotlib': '>=3.9.0',
  // HTTP客户端
  'requests': '>=2.32.0',
  'httpx': '>=0.27.0',
  // TCP（Python内置socket，无需安装）
  // 图像处理（matplotlib依赖，且PDF处理需要）
  'Pillow': '>=10.4.0',
  // 数据处理基础库（被多个上层包依赖）
  'numpy': '>=2.1.0',
  // PPT读写
  'python-pptx': '>=0.6.23',
  // SSH
  'paramiko': '>=2.11',
  // 组织架构图（配合已有matplotlib渲染，不使用需系统二进制的graphviz）
  'networkx': '>=3.0',
  // 报表读写
  'pandas': '>=1.5',
  // 报表导出（Excel写出）
  'xlsxwriter': '>=3.0',
  // ---- HTML/XML/浏览器（2026-08-20 新增）----
  'beautifulsoup4': '>=4.12.0',
  'html5lib':       '>=1.1',
  'xmltodict':      '>=0.13.0',
  'defusedxml':     '>=0.7.1',
  'playwright':     '>=1.40.0',
  'pygetwindow':    '>=0.0.9',
  // ---- 数据库驱动与常用工具（2026-08-20 新增）----
  'pymysql':                '>=1.2.0',
  'mysql-connector-python': '>=26.7.0',
  'pyodbc':                 '>=5.3.0',
  'pymssql':                '>=2.3.13',
  'psycopg2-binary':        '>=2.9.12',
  'oracledb':               '>=4.0.2',
  'redis':                  '>=8.1.0',
  'pymongo':                '>=4.17.0',
  'SQLAlchemy':             '>=2.0.52',
  'pydantic':               '>=2.13.4',
  'orjson':                 '>=3.12.0',
};

// pip 包名 → import 模块名映射（部分 pip 包名与 Python 导入模块名不一致）
const IMPORT_NAMES: Record<string, string> = {
  'Pillow': 'PIL',
  'python-docx': 'docx',
  'python-pptx': 'pptx',
  'pandas': 'pandas',
  'networkx': 'networkx',
  'paramiko': 'paramiko',
  'xlsxwriter': 'xlsxwriter',
  'beautifulsoup4': 'bs4',
  'mysql-connector-python': 'mysql.connector',
  'psycopg2-binary': 'psycopg2',
  'SQLAlchemy': 'sqlalchemy',
};

/** win10 增量包的 pip 包名 → import 模块名映射（追加生效；2026-08-22 预演实测 wheel 自带 pywin32.pth，import win32api 可用） */
const WIN10_IMPORT_NAMES: Record<string, string> = {
  pywin32: 'win32api',
};

/** 解析 requirements 包清单文件为 包名 → 版本约束 映射（忽略空行与 # 注释行） */
async function parseRequirements(filePath: string): Promise<Record<string, string>> {
  const content = await readFile(filePath, 'utf-8');
  const pkgs: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(.*)$/);
    if (!m) {
      throw new Error(`requirements 行无法解析: "${line}" (${filePath})`);
    }
    pkgs[m[1]] = m[2].trim();
  }
  return pkgs;
}

function log(msg: string): void {
  console.log(`[build-preset-python] ${msg}`);
}

function logError(msg: string): void {
  console.error(`[build-preset-python] ${msg}`);
}

/** 下载文件到指定路径（支持重定向、超时保护） */
function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const doRequest = (requestUrl: string, redirectCount: number): void => {
      if (redirectCount > 10) {
        reject(new Error('重定向次数过多'));
        return;
      }

      const req = get(requestUrl, { timeout: DOWNLOAD_TIMEOUT_MS }, (res: IncomingMessage) => {
        // 处理重定向
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); // 消耗响应体
          doRequest(res.headers.location, redirectCount + 1);
          return;
        }

        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        const fileStream = createWriteStream(destPath);
        pipeline(res, fileStream)
          .then(() => resolve())
          .catch(reject);
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('下载超时'));
      });
      req.end();
    };

    doRequest(url, 0);
  });
}

/** 执行命令并返回输出（超时保护） */
function runCommand(
  cmd: string,
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: EXEC_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`${cmd} ${args.join(' ')} 失败: ${stderr || err.message}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/** 配置 _pth 文件：取消注释 import site、添加 Lib/site-packages */
async function configurePth(pthPath: string): Promise<void> {
  if (!existsSync(pthPath)) {
    throw new Error(`_pth 文件未找到: ${pthPath}`);
  }

  let content = await readFile(pthPath, 'utf-8');
  const lines = content.split(/\r?\n/);

  const modified: string[] = [];
  let siteImported = false;
  let sitePackagesAdded = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // 取消注释 import site
    if (trimmed === '#import site' || trimmed === '# import site') {
      modified.push('import site');
      siteImported = true;
      continue;
    }

    // 已是 import site
    if (trimmed === 'import site') {
      siteImported = true;
    }

    // 检查是否已有 Lib/site-packages
    if (trimmed === 'Lib/site-packages' || trimmed === 'Lib\\site-packages') {
      sitePackagesAdded = true;
    }

    modified.push(line);
  }

  // 确保 import site 存在
  if (!siteImported) {
    // 在 pythonXXX.zip 之后插入
    const zipIndex = modified.findIndex((l) => l.trim().startsWith('python') && l.trim().endsWith('.zip'));
    if (zipIndex >= 0) {
      modified.splice(zipIndex + 1, 0, 'import site');
    } else {
      modified.push('import site');
    }
  }

  // 确保 Lib/site-packages 存在
  if (!sitePackagesAdded) {
    modified.push('Lib/site-packages');
  }

  await writeFile(pthPath, modified.join('\r\n'), 'utf-8');
}

/** 检查 pip 是否可用 */
function checkPip(pythonExe: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(pythonExe, ['-m', 'pip', '--version'], { timeout: 15_000 }, (err, stdout) => {
      if (err) {
        resolve(false);
        return;
      }
      resolve(stdout.trim().startsWith('pip '));
    });
  });
}

/** 安装 pip：优先 ensurepip，失败则下载 get-pip.py 执行（fallback） */
async function installPip(pythonExe: string, cwd: string): Promise<void> {
  // 方式1: python -m ensurepip --upgrade
  try {
    await runCommand(pythonExe, ['-m', 'ensurepip', '--upgrade'], cwd);
    const pipOk = await checkPip(pythonExe);
    if (pipOk) {
      log('pip 安装成功（ensurepip）');
      return;
    }
  } catch {
    // ensurepip 失败，继续尝试 get-pip.py
    log('ensurepip 失败或未生效，尝试 get-pip.py');
  }

  // 方式2: 下载 get-pip.py 并执行
  const getPipPath = path.join(cwd, 'get-pip.py');
  try {
    await downloadFile(GET_PIP_URL, getPipPath);
    await runCommand(pythonExe, [getPipPath], cwd);
  } finally {
    // 清理 get-pip.py
    try { unlinkSync(getPipPath); } catch { /* ignore */ }
  }

  const pipOk = await checkPip(pythonExe);
  if (!pipOk) {
    throw new Error('pip 安装后验证失败：pip 仍不可用');
  }
  log('pip 安装成功（get-pip.py）');
}

/** 递归删除 __pycache__ 目录 */
async function removePycacheDirs(rootDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(rootDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry);
    let st;
    try {
      st = await stat(fullPath);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (entry === '__pycache__') {
        await rm(fullPath, { recursive: true, force: true });
      } else {
        await removePycacheDirs(fullPath);
      }
    }
  }
}

/** 清理构建产物：删除 __pycache__、pip 缓存、get-pip.py（对不存在路径容错：pbs 变体无 get-pip.py、无 Lib 布局） */
async function cleanup(buildPythonDir: string, runtime: 'embed' | 'pbs'): Promise<void> {
  // 删除所有 __pycache__ 目录
  await removePycacheDirs(buildPythonDir);

  // 删除 get-pip.py（若存在）
  const getPipPath = path.join(buildPythonDir, 'get-pip.py');
  try { unlinkSync(getPipPath); } catch { /* ignore */ }

  // 删除 pip 缓存目录（构建产物内可能残留；pbs 变体为 lib/pythonX.Y 布局；rm force 对不存在路径容错）
  const pipCacheDir = runtime === 'embed'
    ? path.join(buildPythonDir, 'Lib', 'site-packages', 'pip', '_vendor', 'cache')
    : path.join(buildPythonDir, 'lib', `python${PYTHON_SHORT}`, 'site-packages', 'pip', '_vendor', 'cache');
  try { await rm(pipCacheDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** 验证预置环境：python 版本、pip 可用、各预装包可导入 */
async function verify(buildPythonDir: string, pythonExe: string, presetPackages: Record<string, string>): Promise<void> {
  // 1. python --version → 3.14.6
  const versionResult = await runCommand(pythonExe, ['--version'], buildPythonDir);
  const versionOutput = (versionResult.stdout || versionResult.stderr || '').trim();
  const versionMatch = versionOutput.match(/Python\s+([\d.]+)/i);
  if (!versionMatch || versionMatch[1] !== PYTHON_VERSION) {
    throw new Error(`Python 版本验证失败: 期望 ${PYTHON_VERSION}, 实际 ${versionOutput}`);
  }
  log(`Python 版本验证通过: ${versionOutput}`);

  // 2. pip --version
  const pipResult = await runCommand(pythonExe, ['-m', 'pip', '--version'], buildPythonDir);
  const pipOutput = (pipResult.stdout || '').trim();
  if (!pipOutput.startsWith('pip ')) {
    throw new Error(`pip 验证失败: ${pipOutput}`);
  }
  log(`pip 验证通过: ${pipOutput}`);

  // 3. 逐个验证预装包可导入（Pillow/python-docx 使用导入名映射）
  for (const pkgName of Object.keys(presetPackages)) {
    const importName = IMPORT_NAMES[pkgName] ?? WIN10_IMPORT_NAMES[pkgName] ?? pkgName;
    await runCommand(pythonExe, ['-c', `import ${importName}`], buildPythonDir);
    log(`预装包导入验证通过: ${pkgName} (import ${importName})`);
  }
}

/** 生成 .beez-preset 标记文件（记录构建信息和包版本清单） */
async function writePresetMarker(outputDir: string, pythonExe: string, presetPackages: Record<string, string>): Promise<void> {
  // 通过 pip list --format=json 获取实际安装版本
  const installedMap: Record<string, string> = {};
  try {
    const pipListResult = await runCommand(pythonExe, ['-m', 'pip', 'list', '--format=json'], outputDir);
    const pipPkgs: Array<{ name: string; version: string }> = JSON.parse(pipListResult.stdout.trim());
    const wanted = new Set(Object.keys(presetPackages).map((n) => n.toLowerCase()));
    for (const pkg of pipPkgs) {
      if (wanted.has(pkg.name.toLowerCase())) {
        installedMap[pkg.name] = pkg.version;
      }
    }
  } catch (err) {
    logError(`pip list 解析失败，使用空包清单: ${err instanceof Error ? err.message : String(err)}`);
  }

  const marker: Record<string, unknown> = {
    version: '1.0.0',
    pythonVersion: PYTHON_VERSION,
    buildDate: new Date().toISOString(),
    // 变体附加标识：win10/mac/linux 写入 variant 字段（default 变体保持历史字段结构不变）
    ...(VARIANT_KEY === 'default' ? {} : { variant: VARIANT_KEY }),
    packages: installedMap,
  };

  const markerPath = path.join(outputDir, PRESET_MARKER_FILE);
  await writeFile(markerPath, JSON.stringify(marker, null, 2), 'utf-8');
  log(`.beez-preset 标记文件已生成: ${markerPath}`);
}

async function main() {
  log('Starting...');
  // 宿主防呆校验：pbs 变体（PBS tarball + 宿主 tar 解压 + 平台专属包）必须在对应平台执行；default/win10 不新增校验（保持原行为）
  if (VARIANT_KEY === 'mac' && process.platform !== VARIANT.hostPlatform) {
    logError(`mac 变体必须在 macOS 宿主执行（当前平台: ${process.platform}）；请在 macOS 上运行 npm run build:preset-python-mac`);
    process.exit(1);
  }
  if (VARIANT_KEY === 'linux' && process.platform !== VARIANT.hostPlatform) {
    logError(`linux 变体必须在 Linux 宿主执行（当前平台: ${process.platform}）；请在 Linux 上运行 npm run build:preset-python-linux`);
    process.exit(1);
  }
  if (VARIANT_KEY === 'win10') {
    log('Win10 差异化变体: requirements-preset-win10.txt / resources/python-win10 / 独立缓存 / pip --no-cache-dir');
  }
  if (VARIANT_KEY === 'mac' || VARIANT_KEY === 'linux') {
    log(`${VARIANT_KEY === 'mac' ? 'Mac' : 'Linux'} 差异化变体（PBS 运行时）: requirements-preset-${VARIANT_KEY}.txt / resources/python-${VARIANT_KEY} / 独立缓存`);
  }

  // ---- Step 1: 检查缓存，必要时下载发行包（embed=python.org embeddable zip；pbs=python-build-standalone tarball）----
  mkdirSync(path.dirname(VARIANT.cacheZipPath), { recursive: true });
  const cacheZip = VARIANT.cacheZipPath;
  // win10 独立缓存：优先复制主线缓存中的同一份官方 zip（上游原样发行物，不含包集，复制零污染）；缺失才联网下载
  const mainlineCacheZip = path.join(CACHE_DIR, `python-${PYTHON_VERSION}-embed-amd64.zip`);
  if (VARIANT_KEY === 'win10' && !existsSync(cacheZip) && existsSync(mainlineCacheZip)) {
    await copyFile(mainlineCacheZip, cacheZip);
    log(`Win10 缓存初始化: 复制主线缓存 -> ${cacheZip}`);
  }
  if (existsSync(cacheZip)) {
    log(`缓存命中，跳过下载: ${cacheZip}`);
  } else {
    // embed 变体走 python.org embeddable zip；pbs 变体（mac/linux）走 python-build-standalone tarball（tag 固定 20260804）
    const downloadUrl = VARIANT.runtime === 'embed'
      ? EMBED_URL
      : pbsUrl(VARIANT_KEY === 'mac' ? PBS_MAC_TRIPLE : PBS_LINUX_TRIPLE);
    log(`缓存未命中，开始下载: ${downloadUrl}`);
    await downloadFile(downloadUrl, cacheZip);
    log(`下载完成: ${cacheZip}`);
  }

  // ---- Step 2: 解压到临时构建目录 ----
  const buildPythonDir = path.join(BUILD_DIR, VARIANT.buildDirName);
  await rm(buildPythonDir, { recursive: true, force: true });
  if (VARIANT.runtime === 'embed') {
    // embed 变体：Windows embeddable zip，PowerShell Expand-Archive（原逻辑）
    mkdirSync(buildPythonDir, { recursive: true });
    log(`解压到临时目录: ${buildPythonDir}`);
    await runCommand('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -Path '${cacheZip}' -DestinationPath '${buildPythonDir}' -Force`,
    ]);
  } else {
    // pbs 变体：PBS install_only tar.gz，宿主 tar 解压到临时目录，再上提顶层唯一目录 python/
    const extractDir = `${buildPythonDir}.extract`;
    await rm(extractDir, { recursive: true, force: true });
    mkdirSync(extractDir, { recursive: true });
    log(`解压到临时目录: ${extractDir}`);
    await runCommand('tar', ['-xzf', cacheZip, '-C', extractDir]);
    // tarball 顶层唯一目录为 python/，上提一层，保证 buildPythonDir 直接含 bin/lib/include/share
    await rename(path.join(extractDir, 'python'), buildPythonDir);
    await rm(extractDir, { recursive: true, force: true });
    log(`PBS tarball 解压完成: ${buildPythonDir}`);
  }

  // python 可执行文件：embed=python.exe；pbs=bin/python3.14 实体文件（bin/python、bin/python3 为符号链接）
  const pythonExeRel = VARIANT.runtime === 'embed' ? 'python.exe' : path.join('bin', `python${PYTHON_SHORT}`);
  const pythonExe = path.join(buildPythonDir, pythonExeRel);
  if (!existsSync(pythonExe)) {
    throw new Error(`解压后未找到 python.exe: ${pythonExe}`);
  }

  // ---- Step 3: 配置 _pth 文件（仅 embed；PBS 发行版无 ._pth、site-packages 原生生效，整段跳过） ----
  if (VARIANT.runtime === 'embed') {
    const pthPath = path.join(buildPythonDir, `python${PYTHON_SHORT.replace('.', '')}._pth`);
    log(`配置 _pth 文件: ${pthPath}`);
    await configurePth(pthPath);
  } else {
    log('PBS 运行时无 ._pth 文件，跳过 _pth 配置');
  }

  // ---- Step 4: 安装 pip（仅 embed；PBS install_only 发行版已预装 pip，跳过引导） ----
  if (VARIANT.runtime === 'embed') {
    log('安装 pip...');
    await installPip(pythonExe, buildPythonDir);
  } else {
    log('PBS 运行时已预装 pip，跳过 pip 安装');
  }

  // ---- Step 5: 安装预装依赖 ----
  log('安装预装依赖...');
  // site-packages 路径：embed=Lib/site-packages（Windows 布局）；pbs=lib/pythonX.Y/site-packages
  const sitePackagesDir = VARIANT.runtime === 'embed'
    ? path.join(buildPythonDir, 'Lib', 'site-packages')
    : path.join(buildPythonDir, 'lib', `python${PYTHON_SHORT}`, 'site-packages');

  // 变体包清单：default = PRESET_PACKAGES 常量（历史行为不变）；win10/mac/linux = requirements 清单文件
  const presetPackages: Record<string, string> = VARIANT.requirementsFile
    ? await parseRequirements(VARIANT.requirementsFile)
    : PRESET_PACKAGES;
  if (VARIANT.requirementsFile) {
    log(`包清单来源: ${VARIANT.requirementsFile}（${Object.keys(presetPackages).length} 个包）`);
  }

  // 预装构建后端（setuptools/wheel）：embeddable Python 的 _pth 忽略 PYTHONPATH，
  // pip 默认构建隔离注入 sitecustomize 失效，需关闭隔离并由宿主 site-packages 提供 setuptools.build_meta
  await runCommand(
    pythonExe,
    ['-m', 'pip', 'install', '--disable-pip-version-check', ...(VARIANT.pipNoCacheDir ? ['--no-cache-dir'] : []), '-i', 'https://mirrors.aliyun.com/pypi/simple/', 'setuptools==84.0.0', 'wheel==0.48.0', '--target', sitePackagesDir],
    buildPythonDir,
  );
  const pkgSpecs: string[] = [];
  for (const [name, ver] of Object.entries(presetPackages)) {
    pkgSpecs.push(`${name}${ver}`);
  }
  await runCommand(
    pythonExe,
    ['-m', 'pip', 'install', '--disable-pip-version-check', ...(VARIANT.pipNoCacheDir ? ['--no-cache-dir'] : []), '--no-build-isolation', '-i', 'https://mirrors.aliyun.com/pypi/simple/', ...pkgSpecs, '--target', sitePackagesDir],
    buildPythonDir,
  );
  log(`预装依赖安装完成: ${pkgSpecs.length} 个包`);

  // ---- Step 6: 清理 ----
  log('清理构建产物...');
  await cleanup(buildPythonDir, VARIANT.runtime);

  // ---- Step 7: 验证 ----
  log('验证预置环境...');
  await verify(buildPythonDir, pythonExe, presetPackages);

  // ---- Step 8: 移动到最终位置 ----
  log(`移动到最终位置: ${VARIANT.outputDir}`);
  await rm(VARIANT.outputDir, { recursive: true, force: true });
  mkdirSync(path.dirname(VARIANT.outputDir), { recursive: true });
  await rename(buildPythonDir, VARIANT.outputDir);

  // 生成 .beez-preset 标记文件
  log('生成 .beez-preset 标记文件...');
  await writePresetMarker(VARIANT.outputDir, path.join(VARIANT.outputDir, pythonExeRel), presetPackages);

  log('构建完成 ✔');
  log(`输出目录: ${VARIANT.outputDir}`);
}

main().catch((err) => {
  logError(`Failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
