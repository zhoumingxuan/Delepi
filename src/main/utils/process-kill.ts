/**
 * 共享进程终止辅助（run_shell / run_with_python 非挂起模式超时与 abort 路径专用）。
 *
 * 设计：
 * - POSIX：两处非挂起 spawn 以 detached 建立独立进程组（子进程即组长，pid == pgid），
 *   超时/abort 向整组投递 SIGKILL（负 PID），组内后代一并终止；
 * - Windows：唯一清理手段是 child.kill()（TerminateProcess 直接子进程）。Windows 无内核级
 *   进程树所有权，直接子进程终止后其自行派生的后代成为孤儿并继续运行——这是已知能力边界；
 *   后代若继承了 stdout/stderr 管道，子进程的 'close' 事件会被推迟到该管道关闭（后代退出）为止；
 * - 不做进程树枚举、不做 PID 存活探测、不做事后补偿：禁止引入 taskkill / wmic / CIM /
 *   handle.exe 等手段推断后代；
 * - Job Object 属创建期内核所有权（assign 先于后代派生、Terminate 作用于内核进程集），
 *   不属事后枚举/补偿，不在禁令范围（第三轮诊断核实）；
 * - 全程静默：kill 返回值不作失败依据、不因 kill 失败抛错、不改变调用方 Promise 的
 *   resolve/reject 路径与 'close'/'error' 事件竞态；本函数无返回值、永不抛出。
 */
import type { ChildProcess } from 'node:child_process';
import { terminateJobTree, type WinJobHandle } from '../tools/win-job-object';

/**
 * 终止 child 及其在 POSIX 进程组内的全部后代（Windows：job 存在时经 Job Object 内核级终止进程集，否则仅终止直接子进程）。
 *
 * @param child  spawn 返回的子进程对象（非挂起 spawn 创建：POSIX=进程组组长）
 * @param logTag WARN 日志标签（调用方传入工具名，如 'run-shell' / 'run-with-python'，便于日志定位）
 * @param job   可选。Windows 平台 Job Object 句柄（createJobForChild 绑定成功时传入；存在则内核级终止整个进程集）
 */
export function killProcessTree(child: ChildProcess, logTag: string = 'killProcessTree', job?: WinJobHandle | null): void {
  const pid = child.pid;
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) {
    // 子进程未成功创建或已销毁（无有效 PID）：无进程可杀，静默返回
    return;
  }

  if (process.platform !== 'win32') {
    try {
      // 负 PID = 向整个进程组投递信号（非挂起 spawn 以 detached 建立独立进程组）
      process.kill(-pid, 'SIGKILL');
      return;
    } catch {
      // 进程组已不存在（ESRCH）等竞态：仅记 WARN，回退单进程 kill，绝不抛错
      console.warn(`[${logTag}] 进程组终止失败（组可能已退出），回退单进程 kill: pid=${pid}`);
    }
  }

  // Windows：job 存在时经 Job Object 内核级终止整个进程集（创建期所有权，Terminate 作用于内核进程集，
  // 覆盖全部后代）；job 缺失（assign 失败）→ 维持现状 child.kill()（此时进程树尚无后代，现状行为最小保持）
  if (job) {
    terminateJobTree(job);
    return;
  }
  try {
    child.kill();
  } catch {
    // 静默：kill 返回值不作失败依据，不影响调用方主流程
  }
}
