/**
 * 主进程入口
 * 创建 BrowserWindow，初始化数据库、注册 IPC 处理器
 */

import { app, BrowserWindow, Menu } from 'electron';
import path from 'path';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { getDb } from './db/sqlite-adapter';
import {
  resetInterruptedRuntimeState,
  listConversations,
  getLastStoredMessage,
  insertMessage,
  listStoredExecutionLogPaths,
} from './db';
import { registerIpcHandlers, writeMainLog } from './ipc/ipc-handlers';
import { configManager } from './modules/config/config-manager';
import { pythonManager } from './modules/python';
import {
  PRELOAD_PATH_SEGMENT,
  PRELOAD_FILE_NAME,
  RENDERER_PATH_SEGMENT,
  RENDERER_INDEX_FILE,
  SCRIPTS_TOOLS_DIR,
  SCRIPTS_TOOLS_DIR_NAME,
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
  // ★ D7 拍板豁免（方案⑧ D7 最终决策=启动清理对报错保留现场豁免）：库内 tool 消息
  //   execution_log_path 引用的任务现场目录（tasks/<delegateCallId>/，运行期 apiErrorHit
  //   豁免保留的磁盘现场）不参与启动清空重建——保证报错轮日志路径重启后持续有效；
  //   未被引用的残留照常清理（BUG1 修复语义保持）。
  let preservedTaskDirKeys = new Set<string>();
  try {
    preservedTaskDirKeys = collectPreservedTaskDirKeys();
  } catch (err) {
    // 引用清单构建失败（库读取异常）→ 退化为原无条件清理（不因豁免逻辑阻断既有修复）
    writeMainLog('WARN', 'cleanupStaleTasksDirsOnStartup', 'execution_log_path 引用清单构建失败，退化为无条件清理', err);
  }
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
      const tasksSubEntries = await readdir(tasksDir, { withFileTypes: true });
      const preservedCount = tasksSubEntries.filter(
        (entry) => entry.isDirectory()
          && preservedTaskDirKeys.has(path.resolve(path.join(tasksDir, entry.name)).toLowerCase()),
      ).length;
      if (preservedCount === 0) {
        await rm(tasksDir, { recursive: true, force: true });
        await mkdir(tasksDir, { recursive: true });
        continue;
      }
      // 存在被库内 execution_log_path 引用的任务现场：仅清空未被引用的残留条目，
      // 被引用的现场目录原样保留（D7 拍板豁免；下次成功轮末照常统一清理）
      writeMainLog('INFO', 'cleanupStaleTasksDirsOnStartup',
        `会话 tasks 含 API 报错保留现场（${preservedCount} 个目录），启动清理豁免: ${tasksDir}`);
      for (const subEntry of tasksSubEntries) {
        if (subEntry.isDirectory()
          && preservedTaskDirKeys.has(path.resolve(path.join(tasksDir, subEntry.name)).toLowerCase())) {
          continue;
        }
        await rm(path.join(tasksDir, subEntry.name), { recursive: true, force: true });
      }
    } catch (err) {
      // 单个会话 tasks 清理失败（如 Windows 文件占用）时仅记录告警，不阻断启动
      console.warn(`[StartupCleanup] 清理会话 tasks 目录失败，已跳过: ${conversationDir}`, err);
    }
  }
}

/**
 * ★ D7 拍板豁免支撑：库内 tool 消息引用的 execution_log_path → 其所在任务现场目录
 * （tasks/<delegateCallId>）归一化键集合（path.resolve + 小写，Windows 路径归一）。
 * cleanupStaleTasksDirsOnStartup 据此豁免被引用现场的清空重建，保证报错轮日志路径
 * 重启后持续有效（D7 拍板：启动清理对报错保留现场豁免）。
 */
function collectPreservedTaskDirKeys(): Set<string> {
  const keys = new Set<string>();
  for (const logPath of listStoredExecutionLogPaths()) {
    if (typeof logPath !== 'string' || !logPath) {
      continue;
    }
    keys.add(path.resolve(path.dirname(logPath)).toLowerCase());
  }
  return keys;
}

/**
 * ★ 启动自愈（方案④4.2-4.4/⑥#15）：孤儿 assistant(tool_calls) 检测与补写。
 * 客户端在任务执行中途被关闭（进程终止）时批次末 tool 消息未落库，库内末条为含
 * tool_calls 的 assistant 行（孤儿态）——下次回放（按 seq 直读）将出现 tool_calls 无配对
 * tool 结果。此处逐会话取末条 message：role=assistant 且 payload.tool_calls（双键名兼容
 * toolCalls）为非空数组时，逐 tool_call 补一条 role='tool' 的『任务取消』消息闭环配对
 * （补写 payload 逐键对齐 B15 结构，读侧零适配）。
 * 必须先于 createWindow / registerIpcHandlers（首轮 conv:get-messages 读取与 chat:send
 * 回放/取号均要求孤儿已补写）；insertMessage 单条写入不动 conversations.updated_at（会话
 * 列表排序不变）；异常仅记日志不阻断启动（对齐启动链既有容错惯例）。
 * @returns 本次补写的 tool 消息总条数
 */
async function healOrphanToolCallMessages(): Promise<number> {
  const conversations = listConversations();
  let healedCount = 0;
  for (const conversation of conversations) {
    try {
      const lastMessage = getLastStoredMessage(conversation.id);
      if (!lastMessage || lastMessage.role !== 'assistant') {
        continue;
      }
      const payload = lastMessage.payload;
      const rawToolCalls = Array.isArray(payload.tool_calls)
        ? payload.tool_calls
        : Array.isArray(payload.toolCalls)
          ? payload.toolCalls
          : undefined;
      if (!rawToolCalls || rawToolCalls.length === 0) {
        continue;
      }
      const healedAt = new Date().toISOString();
      for (const toolCallValue of rawToolCalls) {
        const toolCall = toolCallValue as {
          id?: string;
          function?: { name?: string; arguments?: string };
        };
        insertMessage({
          conversationId: conversation.id,
          role: 'tool',
          payload: {
            toolCallId: toolCall.id ?? '',
            name: toolCall.function?.name ?? '',
            arguments: toolCall.function?.arguments ?? '',
            result: JSON.stringify(
              {
                current_task_execution_result: {
                  success: false,
                  message: '客户端在任务执行期间关闭，该委派任务已取消（启动自愈补记），未产生执行结果。',
                  data: {},
                },
              },
              null,
              2,
            ),
            isError: true,
            startedAt: lastMessage.createdAt,
            finishedAt: healedAt,
          },
        });
        healedCount += 1;
      }
      writeMainLog('INFO', 'healOrphanToolCallMessages',
        `孤儿 tool_calls 已补记 conversationId=${conversation.id} assistantSeq=${lastMessage.seq} toolCallCount=${rawToolCalls.length}`);
    } catch (err) {
      // 单会话检测/补写失败仅记日志不阻断启动（含外键极值/脏数据场景，见方案④4.4 外键安全性论证）
      writeMainLog('WARN', 'healOrphanToolCallMessages',
        `会话孤儿检测/补写失败，已跳过 conversationId=${conversation.id}`, err);
    }
  }
  return healedCount;
}
/**
 * 启动一次性迁移：script-tools 沉淀经验库载体从“旧安装目录/项目根位置”迁至 userData（重装不覆盖治本）。
 * 背景：旧版 SCRIPTS_TOOLS_DIR = path.join(app.isPackaged ? process.resourcesPath : process.cwd(), SCRIPTS_TOOLS_DIR_NAME)，
 * 打包态位于安装目录 resources/script-tools；NSIS assisted 重装/覆盖安装会经旧卸载器将 $INSTDIR 整目录删除
 * （沉淀内容随之丢失），而 userData（app.getPath('userData')）不在卸载器删除范围，
 * 故新版常量统一指向 userData，本函数在启动时把既有旧载体一次性复制到新位置。
 * - 旧源解析：打包态 path.join(process.resourcesPath, SCRIPTS_TOOLS_DIR_NAME)；
 *   开发态 path.join(process.cwd(), SCRIPTS_TOOLS_DIR_NAME)（与旧版常量解析式一致）。
 * - 触发条件：旧源存在且含条目、且 userData 目标（SCRIPTS_TOOLS_DIR）不存在 → fs.cp recursive 全量复制；
 *   目标已存在（无论空否）一律跳过（防止覆盖已在新载体沉淀的内容）；只增不删：源内容绝不被删除。
 * - 异常处理：本函数不吞错，任何异常向上抛出，由调用方 writeMainLog('ERROR') 记录，绝不阻断启动。
 * - 执行顺序约束：必须位于 ensureScriptToolsDir（ensureDir(SCRIPTS_TOOLS_DIR)）之前——
 *   迁移触发条件依赖“目标不存在”，若先创建空目标目录将导致迁移永远被跳过。
 * @returns 动作标识：migrated | skipped_no_source | skipped_empty_source | skipped_target_exists | skipped_same_path
 */
async function migrateLegacyScriptToolsDirOnce(): Promise<string> {
  const legacySourceDir = path.join(
    app.isPackaged ? process.resourcesPath : process.cwd(),
    SCRIPTS_TOOLS_DIR_NAME,
  );
  // 防御：源与目标解析为同一路径（极端布局）时无可迁移，直接跳过。
  if (path.resolve(legacySourceDir) === path.resolve(SCRIPTS_TOOLS_DIR)) {
    return 'skipped_same_path';
  }
  // 触发条件①：旧源存在且含条目（readdir 抛错视为旧源不存在/不可读，无迁移对象）
  let sourceEntries: string[];
  try {
    sourceEntries = await readdir(legacySourceDir);
  } catch {
    return 'skipped_no_source';
  }
  if (sourceEntries.length === 0) {
    return 'skipped_empty_source';
  }
  // 触发条件②：userData 目标不存在才迁移；已存在（无论空否）则跳过，防止覆盖/干扰新载体沉淀。
  try {
    await readdir(SCRIPTS_TOOLS_DIR);
    return 'skipped_target_exists';
  } catch {
    // 目标不存在（readdir 失败）→ 允许执行迁移（若实为权限类异常，下方 cp 会真实失败并交由调用方记日志）
  }
  // 执行全量复制：fs.cp recursive 复制整个目录树（保目录结构与内容）；force:false + errorOnExist:true 防覆盖；
  // 迁移只增不删：仅向目标新增内容，旧源内容物理保留。
  await mkdir(path.dirname(SCRIPTS_TOOLS_DIR), { recursive: true });
  await cp(legacySourceDir, SCRIPTS_TOOLS_DIR, { recursive: true, force: false, errorOnExist: true });
  return 'migrated';
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

  // ★ 启动自愈（方案④4.4/⑥#15）：孤儿 assistant(tool_calls) 补写 role=tool 任务取消消息——
  //   紧随 resetInterruptedRuntimeState（同为启动期数据库状态修复，语义聚类）；必须先于
  //   createWindow/registerIpcHandlers（首轮 conv:get-messages 读取与 chat:send 回放/取号要求闭环）。
  try {
    const healedToolMessageCount = await healOrphanToolCallMessages();
    writeMainLog('INFO', 'healOrphanToolCallMessages', `OK 补记消息条数=${healedToolMessageCount}`);
  } catch (err) {
    writeMainLog('ERROR', 'healOrphanToolCallMessages', '失败', err);
  }

  // 【重装不覆盖治本】script-tools 旧载体一次性迁移：必须位于 ensureScriptToolsDir（下方）之前执行——
  // 迁移触发条件为“userData 目标不存在”，若先 ensureDir 创建空目标目录会导致迁移永远被跳过。
  // 旧源存在且含条目、目标不存在才执行全量复制；只增不删、源保留；失败仅记日志绝不阻断启动。
  try {
    const migrateAction = await migrateLegacyScriptToolsDirOnce();
    writeMainLog('INFO', 'migrateScriptToolsDirOnce', `OK action=${migrateAction} target=${SCRIPTS_TOOLS_DIR}`);
  } catch (err) {
    writeMainLog('ERROR', 'migrateScriptToolsDirOnce', '失败（不阻断启动；随后的 ensureScriptToolsDir 仍保证新载体目录创建）', err);
  }

  // 经验库根目录启动检查创建（script-tools 方案 R2）：不存在则创建；
  // try-catch 包裹，失败仅记日志不阻断启动（委派期 use_script_tool 执行内核另有兜底重建，双层防护）。
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
