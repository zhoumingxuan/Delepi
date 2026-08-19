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
import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { get } from 'node:https';
import { IncomingMessage } from 'node:http';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const PYTHON_VERSION = '3.14.6';
const PYTHON_SHORT = '3.14';
const EMBED_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`;
const CACHE_DIR = path.join(__dirname, 'cache');
const BUILD_DIR = path.join(__dirname, '.build');
const OUTPUT_DIR = path.join(__dirname, '..', 'resources', 'python', `python-${PYTHON_VERSION}`);
const PRESET_MARKER_FILE = '.beez-preset';
const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';
const DOWNLOAD_TIMEOUT_MS = 120_000;
const EXEC_TIMEOUT_MS = 600_000;

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
};

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

/** 清理构建产物：删除 __pycache__、pip 缓存、get-pip.py */
async function cleanup(buildPythonDir: string): Promise<void> {
  // 删除所有 __pycache__ 目录
  await removePycacheDirs(buildPythonDir);

  // 删除 get-pip.py（若存在）
  const getPipPath = path.join(buildPythonDir, 'get-pip.py');
  try { unlinkSync(getPipPath); } catch { /* ignore */ }

  // 删除 pip 缓存目录（构建产物内可能残留）
  const pipCacheDir = path.join(buildPythonDir, 'Lib', 'site-packages', 'pip', '_vendor', 'cache');
  try { await rm(pipCacheDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** 验证预置环境：python 版本、pip 可用、各预装包可导入 */
async function verify(buildPythonDir: string, pythonExe: string): Promise<void> {
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
  for (const pkgName of Object.keys(PRESET_PACKAGES)) {
    const importName = IMPORT_NAMES[pkgName] || pkgName;
    await runCommand(pythonExe, ['-c', `import ${importName}`], buildPythonDir);
    log(`预装包导入验证通过: ${pkgName} (import ${importName})`);
  }
}

/** 生成 .beez-preset 标记文件（记录构建信息和包版本清单） */
async function writePresetMarker(outputDir: string, pythonExe: string): Promise<void> {
  // 通过 pip list --format=json 获取实际安装版本
  const installedMap: Record<string, string> = {};
  try {
    const pipListResult = await runCommand(pythonExe, ['-m', 'pip', 'list', '--format=json'], outputDir);
    const pipPkgs: Array<{ name: string; version: string }> = JSON.parse(pipListResult.stdout.trim());
    const wanted = new Set(Object.keys(PRESET_PACKAGES).map((n) => n.toLowerCase()));
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
    packages: installedMap,
  };

  const markerPath = path.join(outputDir, PRESET_MARKER_FILE);
  await writeFile(markerPath, JSON.stringify(marker, null, 2), 'utf-8');
  log(`.beez-preset 标记文件已生成: ${markerPath}`);
}

async function main() {
  log('Starting...');

  // ---- Step 1: 检查缓存，必要时下载 embeddable zip ----
  mkdirSync(CACHE_DIR, { recursive: true });
  const cacheZip = path.join(CACHE_DIR, `python-${PYTHON_VERSION}-embed-amd64.zip`);
  if (existsSync(cacheZip)) {
    log(`缓存命中，跳过下载: ${cacheZip}`);
  } else {
    log(`缓存未命中，开始下载: ${EMBED_URL}`);
    await downloadFile(EMBED_URL, cacheZip);
    log(`下载完成: ${cacheZip}`);
  }

  // ---- Step 2: 解压到临时构建目录 ----
  const buildPythonDir = path.join(BUILD_DIR, `python-${PYTHON_VERSION}`);
  await rm(buildPythonDir, { recursive: true, force: true });
  mkdirSync(buildPythonDir, { recursive: true });
  log(`解压到临时目录: ${buildPythonDir}`);
  await runCommand('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Expand-Archive -Path '${cacheZip}' -DestinationPath '${buildPythonDir}' -Force`,
  ]);

  const pythonExe = path.join(buildPythonDir, 'python.exe');
  if (!existsSync(pythonExe)) {
    throw new Error(`解压后未找到 python.exe: ${pythonExe}`);
  }

  // ---- Step 3: 配置 _pth 文件 ----
  const pthPath = path.join(buildPythonDir, `python${PYTHON_SHORT.replace('.', '')}._pth`);
  log(`配置 _pth 文件: ${pthPath}`);
  await configurePth(pthPath);

  // ---- Step 4: 安装 pip ----
  log('安装 pip...');
  await installPip(pythonExe, buildPythonDir);

  // ---- Step 5: 安装预装依赖 ----
  log('安装预装依赖...');
  const sitePackagesDir = path.join(buildPythonDir, 'Lib', 'site-packages');
  const pkgSpecs: string[] = [];
  for (const [name, ver] of Object.entries(PRESET_PACKAGES)) {
    pkgSpecs.push(`${name}${ver}`);
  }
  await runCommand(
    pythonExe,
    ['-m', 'pip', 'install', '--disable-pip-version-check', '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple', ...pkgSpecs, '--target', sitePackagesDir],
    buildPythonDir,
  );
  log(`预装依赖安装完成: ${pkgSpecs.length} 个包`);

  // ---- Step 6: 清理 ----
  log('清理构建产物...');
  await cleanup(buildPythonDir);

  // ---- Step 7: 验证 ----
  log('验证预置环境...');
  await verify(buildPythonDir, pythonExe);

  // ---- Step 8: 移动到最终位置 ----
  log(`移动到最终位置: ${OUTPUT_DIR}`);
  await rm(OUTPUT_DIR, { recursive: true, force: true });
  mkdirSync(path.dirname(OUTPUT_DIR), { recursive: true });
  await rename(buildPythonDir, OUTPUT_DIR);

  // 生成 .beez-preset 标记文件
  log('生成 .beez-preset 标记文件...');
  await writePresetMarker(OUTPUT_DIR, path.join(OUTPUT_DIR, 'python.exe'));

  log('构建完成 ✔');
  log(`输出目录: ${OUTPUT_DIR}`);
}

main().catch((err) => {
  logError(`Failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
