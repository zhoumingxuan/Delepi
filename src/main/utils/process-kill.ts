/**
 * 共享进程树杀辅助（run_shell / run_with_python 非挂起模式超时与 abort 路径专用）。
 *
 * 背景：child.kill() 仅终止 spawn 出的单个直接子进程（Windows=TerminateProcess 单进程强杀 /
 * POSIX=SIGTERM 单进程），PowerShell 命令体或 Python 脚本派生的孙进程在超时后全部存活为孤儿
 * （2026-10-03 BUG：非挂起模式超过 timeout 后进程未被直接 kill）。
 *
 * 行为约定（修复蓝图）：
 * - Windows：异步 spawn('taskkill', ['/PID', <pid>, '/T', '/F'], { windowsHide: true })，
 *   fire-and-forget（绝不阻塞 Electron 主进程事件循环，禁用 spawnSync 同步等待）；
 *   'error' 事件挂空监听防止未处理异常；非零退出码（含目标已自然退出的"没有找到进程"竞态）
 *   仅记 WARN 日志，绝不抛错——满足"kill 之后无需报错"。
 * - 非 Windows：保留 child.kill() 的 SIGTERM 单进程语义，不做树杀。
 * - PID 复用防护：先 process.kill(pid, 0) 存活探测（信号 0 不实际投递，仅探测存在性；
 *   异常静默捕获，参照 index.ts killStaleSamePathInstances 存活探测范式）；进程已退出即
 *   静默返回，不对可能已被系统复用的 PID 发起树杀，规避误杀无关进程树。
 * - 顺序设计：先发起树杀、后在树杀结果回调中 child.kill() 兜底——保证 taskkill 枚举进程树
 *   时直接子进程仍存活（树完整、孙进程全部被覆盖），并覆盖 taskkill 失败场景（此时兜底
 *   child.kill() 至少保底终止直接子进程，语义与修复前一致）。
 * - 全程静默化：kill 返回值不作失败依据、不因 kill 失败抛错、不改变调用方 Promise 的
 *   resolve/reject 路径与 'close'/'error' 事件竞态；本函数无返回值、永不抛出。
 */
import { spawn, type ChildProcess } from 'node:child_process';

/**
 * 终止 child 及其派生进程树（Windows）；非 Windows 保留 child.kill() 单进程语义。
 *
 * @param child  spawn 返回的子进程对象（承载目标 PID 与既有 kill 语义）
 * @param logTag WARN 日志标签（调用方传入工具名，如 'run-shell' / 'run-with-python'，便于日志定位）
 */
export function killProcessTree(child: ChildProcess, logTag: string = 'killProcessTree'): void {
  const pid = child.pid;
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) {
    // 子进程未成功创建或已销毁（无有效 PID）：无进程可杀，静默返回
    return;
  }

  // PID 复用防护：存活探测；探测失败（进程已退出/不可达）不做任何杀动作，静默返回
  try {
    process.kill(pid, 0);
  } catch {
    return;
  }

  if (process.platform !== 'win32') {
    // 非 Windows：保留 child.kill() 的 SIGTERM 单进程语义（与修复前行为一致，不做树杀）
    try {
      child.kill();
    } catch {
      // 静默：kill 返回值不作失败依据，不影响调用方主流程
    }
    return;
  }

  // Windows：进程树强杀（/T 含全部后代、/F 强制），异步 fire-and-forget；stdio 丢弃 taskkill 输出
  const treeKill = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
    stdio: 'ignore',
  });

  // 兜底单杀（幂等，仅执行一次）：taskkill 成功时进程通常已死、kill 静默无效；
  // taskkill 失败时保底终止直接子进程（与修复前语义一致）
  let fallbackKillDone = false;
  const fallbackKill = (): void => {
    if (fallbackKillDone) {
      return;
    }
    fallbackKillDone = true;
    try {
      child.kill();
    } catch {
      // 静默：kill 失败不抛错
    }
  };

  // 'error' 挂空监听：taskkill 启动失败（极端场景）不产生未处理 'error' 异常导致主进程崩溃
  treeKill.on('error', () => {
    fallbackKill();
  });

  // 非零退出码（含目标已自然退出的"没有找到进程"）仅 WARN 日志，绝不抛错
  treeKill.on('close', (code) => {
    if (code !== 0) {
      console.warn(`[${logTag}] taskkill 树杀退出码非零（忽略，进程可能已自然退出）: pid=${pid}, exit=${code ?? 'null'}`);
    }
    fallbackKill();
  });
}
