/**
 * 主进程入口
 * 创建 BrowserWindow，初始化数据库、注册 IPC 处理器
 */

import { app, BrowserWindow, Menu } from 'electron';
import path from 'path';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { mkdirSync, appendFileSync } from 'node:fs';
import { getDb } from './db/sqlite-adapter';
import { resetInterruptedRuntimeState } from './db';
import { registerIpcHandlers } from './ipc/ipc-handlers';
import { configManager } from './modules/config/config-manager';
import { pythonManager } from './modules/python';
import {
  PRELOAD_PATH_SEGMENT,
  PRELOAD_FILE_NAME,
  RENDERER_PATH_SEGMENT,
  RENDERER_INDEX_FILE,
} from './constants';
import { resolveConversationsRootDir } from './utils/storage-paths';

/**
 * 启动链/运行期日志：写入 userData/logs/main.log（含时间戳与环节名）。
 * - 同步落盘，保证崩溃/异常场景下日志已写入；
 * - 日志写入失败（目录不可写等）绝不影响应用主流程。
 */
function writeMainLog(level: 'INFO' | 'WARN' | 'ERROR', stage: string, message: string, err?: unknown): void {
  try {
    const logDir = path.join(app.getPath('userData'), 'logs');
    mkdirSync(logDir, { recursive: true });
    const ts = new Date().toISOString();
    const detail =
      err instanceof Error
        ? `${err.message}${err.stack ? `\n${err.stack}` : ''}`
        : err !== undefined
          ? String(err)
          : '';
    appendFileSync(
      path.join(logDir, 'main.log'),
      `[${ts}] [${level}] [${stage}] ${message}${detail ? ` :: ${detail}` : ''}\n`,
      'utf8',
    );
  } catch {
    // 忽略：日志写入失败不影响应用主流程
  }
}

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
    },
  });

  // ★ 竞态修复：绑定渲染进程加载门控——pythonManager 启动期自动推送（python:status-changed）
  //   在窗口首次 did-finish-load（preload 隔离世界 ipcNative 注入完成）前一律缓存，
  //   加载完成后补推，消除启动期 "ipcNative missing" 竞态（详见 python-manager attachMainWindow）
  pythonManager.attachMainWindow(mainWindow);

  // 启动健壮性：渲染进程运行期异常/事件日志监听
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    writeMainLog(
      'ERROR',
      'webContents.did-fail-load',
      `errorCode=${errorCode} errorDescription=${errorDescription} url=${validatedURL} isMainFrame=${isMainFrame}`,
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
