/**
 * 主进程入口
 * 创建 BrowserWindow，初始化数据库、注册 IPC 处理器
 */

import { app, BrowserWindow, Menu } from 'electron';
import path from 'path';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { getDb } from './db/sqlite-adapter';
import { resetInterruptedRuntimeState } from './db';
import { registerIpcHandlers, writeMainLog } from './ipc/ipc-handlers';
import { configManager } from './modules/config/config-manager';
import { pythonManager } from './modules/python';
import {
  PRELOAD_PATH_SEGMENT,
  PRELOAD_FILE_NAME,
  RENDERER_PATH_SEGMENT,
  RENDERER_INDEX_FILE,
  SCRIPTS_TOOLS_DIR,
} from './constants';
import { ensureDir, resolveConversationsRootDir } from './utils/storage-paths';
console.log('[sandbox-diag] argv =', JSON.stringify(process.argv));
console.log('[sandbox-diag] ELECTRON_DISABLE_SANDBOX =', process.env.ELECTRON_DISABLE_SANDBOX ?? '(unset)');

// writeMainLog 已移至 ./ipc/ipc-handlers.ts 并导出（R3/R5 修复配套）：
// IPC handler 层错误（如 file:upload catch）与 log:renderer 渲染端转发
// 与本文件启动链/运行期日志共用同一持久日志出口 userData/logs/main.log。

// 启动健壮性：全局异常日志记录（防止启动/运行期异常静默丢失）
process.on('unhandledRejection', (reason) => {
  writeMainLog('ERROR', 'process.unhandledRejection', '未处理的 Promise rejection', reason);
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  writeMainLog('ERROR', 'process.uncaughtException', '未捕获异常', err);
  console.error('[uncaughtException]', err);
});

let mainWindow: BrowserWindow | null = null;

/**
 * 单窗口运行·旧实例清理（用户裁决的绝对正确逻辑）：
 * 找到【相同进程名称】&&【进程ID不同（非自身）】&&【对应启动路径相同】的进程 → kill 掉。
 * - 进程名称与启动路径均以当前进程 process.execPath 为基准比对，
 *   天然区分本项目 dev 态 electron（E:\work\Delepi\node_modules\electron\dist\electron.exe）
 *   与其他项目的同名 electron.exe 进程；
 * - 通过 PID 比对排除自身进程；本函数运行于主进程模块加载期（app ready 之前），
 *   自身渲染/GPU 子进程尚未创建，不会误杀自身子进程；
 * - kill 后等待旧实例退出（释放单实例锁）再继续，最终由 requestSingleInstanceLock 兜底；
 * - 任何失败均不阻断启动，绝不破坏单窗口运行设计。
 */
function killStaleSamePathInstances(): void {
  if (process.platform !== 'win32') return; // 非 Windows 平台由下方单实例锁兜底
  const selfExePath = process.execPath;
  const selfExeName = path.basename(selfExePath);
  const normalizeWinPath = (p: string): string => path.win32.normalize(p).toLowerCase();
  const selfPathKey = normalizeWinPath(selfExePath);
  const syncSleepMs = (ms: number): void => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  };
  try {
    const wqlName = selfExeName.replace(/'/g, "''");
    const query =
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' +
      `Get-CimInstance Win32_Process -Filter "Name='${wqlName}'" | ` +
      'ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)" }';
    const listed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
    if (listed.error || listed.status !== 0) {
      writeMainLog('WARN', 'killStaleSamePathInstances', '进程枚举失败，跳过清理（由单实例锁兜底）',
        listed.error ?? `exit=${listed.status} stderr=${listed.stderr}`);
      return;
    }
    for (const line of (listed.stdout ?? '').split(/\r?\n/)) {
      const record = line.trim();
      if (!record) continue;
      const separatorIndex = record.indexOf('|');
      if (separatorIndex <= 0) continue;
      const pid = Number.parseInt(record.slice(0, separatorIndex), 10);
      const exePath = record.slice(separatorIndex + 1);
      if (!Number.isSafeInteger(pid) || pid <= 0 || !exePath) continue;
      if (pid === process.pid) continue; // 条件②：进程ID与自身相同 → 排除自身进程
      if (path.basename(exePath).toLowerCase() !== selfExeName.toLowerCase()) continue; // 条件①：进程名称不同 → 排除
      if (normalizeWinPath(exePath) !== selfPathKey) continue; // 条件③：启动路径不同 → 排除
      const killed = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
      });
      if (killed.error || killed.status !== 0) {
        writeMainLog('WARN', 'killStaleSamePathInstances', `kill 失败 pid=${pid}`,
          killed.error ?? `exit=${killed.status} stderr=${killed.stderr}`);
        continue;
      }
      writeMainLog('INFO', 'killStaleSamePathInstances',
        `已 kill 同名同路径旧实例 pid=${pid} name=${selfExeName} path=${exePath}`);
      // 等待旧实例完全退出（确保释放单实例锁），避免新实例因锁未释放而误自退
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
        if (!alive) break;
        syncSleepMs(50);
      }
    }
  } catch (err) {
    writeMainLog('WARN', 'killStaleSamePathInstances', '进程清理异常，跳过（由单实例锁兜底）', err);
  }
}

killStaleSamePathInstances();

// 单实例锁：防止应用多开，确保同一时间只有一个实例运行
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 当用户尝试二次启动时，聚焦已有窗口
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}


function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Delepi',
    webPreferences: {
      preload: path.join(__dirname, '..', PRELOAD_PATH_SEGMENT, PRELOAD_FILE_NAME),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      sandbox: false,
    },
  });

  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault();
  });

  // 启动健壮性：渲染进程运行期异常/事件日志监听
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    writeMainLog(
      'ERROR',
      'webContents.did-fail-load',
      `errorCode=${errorCode} errorDescription=${errorDescription} url=${validatedURL} isMainFrame=${isMainFrame}`,
    );
  });
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    writeMainLog(
      'ERROR',
      'webContents.preload-error',
      `preloadPath=${preloadPath}`,
      error,
    );
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    writeMainLog(
      'ERROR',
      'webContents.render-process-gone',
      `reason=${details.reason} exitCode=${details.exitCode}`,
    );
  });
  mainWindow.webContents.on('unresponsive', () => {
    writeMainLog('WARN', 'webContents.unresponsive', '渲染进程无响应');
  });

  // 开发环境加载 Vite dev server，生产环境加载打包文件
  // VITE_DEV_SERVER_URL 是 Electron+Vite 框架运行时的必要依赖，不可去除
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow
      .loadFile(path.join(__dirname, '..', RENDERER_PATH_SEGMENT, RENDERER_INDEX_FILE))
      .catch((err) => {
        writeMainLog('ERROR', 'loadFile', '页面加载失败', err);
      });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * BUG1 修复：启动期清空各会话 tasks 目录内的残留快照。
 * 强杀客户端时轮末收尾（finished 收尾快照 + 批次消息落库 + 清空 tasks）全部缺失，
 * tasks/{toolCallId}/snapshot.json 会残留 init/running 状态；重启后 conv:get-messages
 * 读取残留快照，导致该会话永久显示"执行任务中"。
 * 此处在窗口创建前遍历 conversations 根目录下各会话子目录，仅对真实存在且名为 tasks
 * 的子目录执行"递归删除 + 重建空目录"的清空（与 main-agent.ts resetConversationTasksDir
 * 同构）；uploads/output 等其余目录不受影响。
 */
async function cleanupStaleTasksDirsOnStartup(): Promise<void> {
  const conversationsRootDir = resolveConversationsRootDir();
  const conversationEntries = await readdir(conversationsRootDir, {
    withFileTypes: true,
  }).catch(() => null);
  if (!conversationEntries) {
    // conversations 根目录不存在（如首次启动）时无需清理
    return;
  }

  for (const conversationEntry of conversationEntries) {
    if (!conversationEntry.isDirectory()) continue;
    const conversationDir = path.join(conversationsRootDir, conversationEntry.name);
    try {
      const tasksEntry = (await readdir(conversationDir, { withFileTypes: true }))
        .find((entry) => entry.name === 'tasks' && entry.isDirectory());
      if (!tasksEntry) continue;
      const tasksDir = path.join(conversationDir, tasksEntry.name);
      await rm(tasksDir, { recursive: true, force: true });
      await mkdir(tasksDir, { recursive: true });
    } catch (err) {
      // 单个会话 tasks 清理失败（如 Windows 文件占用）时仅记录告警，不阻断启动
      console.warn(`[StartupCleanup] 清理会话 tasks 目录失败，已跳过: ${conversationDir}`, err);
    }
  }
}

app.whenReady().then(async () => {
  writeMainLog('INFO', 'whenReady', '启动链开始');
  try {
    Menu.setApplicationMenu(null);
    writeMainLog('INFO', 'Menu.setApplicationMenu', 'OK');
  } catch (err) {
    writeMainLog('ERROR', 'Menu.setApplicationMenu', '失败', err);
  }
  // 初始化数据库
  try {
    getDb();
    writeMainLog('INFO', 'getDb', 'OK');
  } catch (err) {
    writeMainLog('ERROR', 'getDb', '失败', err);
  }
  try {
    resetInterruptedRuntimeState();
    writeMainLog('INFO', 'resetInterruptedRuntimeState', 'OK');
  } catch (err) {
    writeMainLog('ERROR', 'resetInterruptedRuntimeState', '失败', err);
  }

  // 经验库根目录启动检查创建（script-tools 方案 R2）：不存在则创建；
  // try-catch 包裹，失败仅记日志不阻断启动（委派期 script_tool 执行内核另有兜底重建，双层防护）。
  try {
    await ensureDir(SCRIPTS_TOOLS_DIR);
    writeMainLog('INFO', 'ensureScriptToolsDir', `OK path=${SCRIPTS_TOOLS_DIR}`);
  } catch (err) {
    writeMainLog('ERROR', 'ensureScriptToolsDir', '失败（不阻断启动；委派期兜底重建）', err);
  }

  // BUG1 修复：清空各会话 tasks 目录残留快照（必须在 createWindow 之前完成，
  // 防止首次 conv:get-messages 读到残留 snapshot.json 导致会话永久显示"执行任务中"）
  try {
    await cleanupStaleTasksDirsOnStartup();
    writeMainLog('INFO', 'cleanupStaleTasksDirsOnStartup', 'OK');
  } catch (err) {
    writeMainLog('ERROR', 'cleanupStaleTasksDirsOnStartup', '失败', err);
  }

  // 初始化配置
  try {
    configManager.reload();
    writeMainLog('INFO', 'configManager.reload', 'OK');
  } catch (err) {
    writeMainLog('ERROR', 'configManager.reload', '失败', err);
  }

  // 后台异步初始化 Python 内置环境（不阻塞窗口创建）
  let useBuiltinPython = true;
  try {
    useBuiltinPython = configManager.getSettings().useBuiltinPython;
    writeMainLog('INFO', 'getSettings', `OK useBuiltinPython=${useBuiltinPython}`);
  } catch (err) {
    // configManager 未就绪时默认使用内置 Python
    writeMainLog('ERROR', 'getSettings', '失败，默认使用内置 Python', err);
  }
  if (useBuiltinPython) {
    pythonManager.init().catch((err) => {
      writeMainLog('ERROR', 'pythonManager.init', '初始化失败', err);
      console.error('[PythonManager] 初始化失败:', err);
    });
    writeMainLog('INFO', 'pythonManager.init', '已发起异步初始化（不阻塞窗口创建）');
  } else {
    writeMainLog('INFO', 'pythonManager.init', '跳过（useBuiltinPython=false）');
  }
  // ★ v2恢复方案：先注册IPC处理器（含get-last-active-conversation handler），
  //   确保preload在页面加载期间通过ipcRenderer.invoke调用时handler已就绪。
  //   createWindow() 创建 BrowserWindow 并触发异步页面加载（loadURL/loadFile），
  //   registerIpcHandlers() 是同步函数紧随其后执行，
  //   页面HTML加载→解析→执行JS的过程远慢于同步函数调用，
  //   因此 ipcMain.handle(GET_LAST_ACTIVE_CONVERSATION, ...) 在页面JS首次调用
  //   ipcRenderer.invoke 前必然已注册。
  
  // 创建窗口
  try {
    createWindow();
    writeMainLog('INFO', 'createWindow', 'OK');
  } catch (err) {
    writeMainLog('ERROR', 'createWindow', '失败', err);
  }

  // 注册 IPC 处理器（必须在页面did-finish-load前完成）
  try {
    if (mainWindow) {
      registerIpcHandlers(mainWindow);
    }
    writeMainLog('INFO', 'registerIpcHandlers', 'OK');
  } catch (err) {
    writeMainLog('ERROR', 'registerIpcHandlers', '失败', err);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      if (mainWindow) {
        registerIpcHandlers(mainWindow);
      }
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
