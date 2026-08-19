/**
 * 主进程入口
 * 创建 BrowserWindow，初始化数据库、注册 IPC 处理器
 */

import { app, BrowserWindow, Menu } from 'electron';
import path from 'path';
import { mkdir, readdir, rm } from 'node:fs/promises';
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

  // 开发环境加载 Vite dev server，生产环境加载打包文件
  // VITE_DEV_SERVER_URL 是 Electron+Vite 框架运行时的必要依赖，不可去除
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', RENDERER_PATH_SEGMENT, RENDERER_INDEX_FILE));
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
  Menu.setApplicationMenu(null);
  // 初始化数据库
  getDb();
  resetInterruptedRuntimeState();

  // BUG1 修复：清空各会话 tasks 目录残留快照（必须在 createWindow 之前完成，
  // 防止首次 conv:get-messages 读到残留 snapshot.json 导致会话永久显示"执行任务中"）
  await cleanupStaleTasksDirsOnStartup();

  // 初始化配置
  configManager.reload();

  // 后台异步初始化 Python 内置环境（不阻塞窗口创建）
  let useBuiltinPython = true;
  try {
    useBuiltinPython = configManager.getSettings().useBuiltinPython;
  } catch {
    // configManager 未就绪时默认使用内置 Python
  }
  if (useBuiltinPython) {
    pythonManager.init().catch((err) => {
      console.error('[PythonManager] 初始化失败:', err);
    });
  }
  // ★ v2恢复方案：先注册IPC处理器（含get-last-active-conversation handler），
  //   确保preload在页面加载期间通过ipcRenderer.invoke调用时handler已就绪。
  //   createWindow() 创建 BrowserWindow 并触发异步页面加载（loadURL/loadFile），
  //   registerIpcHandlers() 是同步函数紧随其后执行，
  //   页面HTML加载→解析→执行JS的过程远慢于同步函数调用，
  //   因此 ipcMain.handle(GET_LAST_ACTIVE_CONVERSATION, ...) 在页面JS首次调用
  //   ipcRenderer.invoke 前必然已注册。
  
  // 创建窗口
  createWindow();
  
  // 注册 IPC 处理器（必须在页面did-finish-load前完成）
  if (mainWindow) {
    registerIpcHandlers(mainWindow);
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
