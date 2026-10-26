/**
 * Windows Job Object 根治模块（单一根治方案 B'）。
 *
 * 职责：非挂起 run_shell / run_with_python 在 spawn 后立即建立 Job Object 创建期内核所有权
 * （JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE），超时/abort 触发点经 TerminateJobObject 内核级终止
 * 整个进程集——后代继承管道的写端持有者全部消亡，child 'close' 必然立即返回，
 * 从根因上消除"孤儿持管 → close 悬挂 → executor await 悬挂 → 前端永久 running"。
 *
 * 设计边界：
 * - win32 门控：非 win32 平台 createJobForChild 直接返回 null（调用方维持现状行为）；
 * - koffi 惰性初始化：首次 win32 调用时加载 koffi 并 koffi.load('kernel32.dll') 缓存六个函数
 *   proto，模块级仅此只读缓存，无会话状态、无常驻可变状态；非 win32 平台不触发加载；
 * - koffi 经运行时 require 加载（类型经 import type 引用）：本仓库主进程为 lib 模式 CJS 打包、
 *   rollup external 仅显式清单（better-sqlite3/electron），静态 import 会被内联导致原生二进制
 *   解析失效；运行时 require 与 better-sqlite3 同轨（node_modules 运行时解析，打包后经
 *   asar.unpacked 生效），koffi 加载器自身支持 Electron resourcesPath 布局回退；
 * - Job Object 属创建期内核所有权（assign 先于后代派生、Terminate 作用于内核进程集），
 *   不属事后枚举/补偿，不在 process-kill.ts 禁令范围（第三轮诊断核实）；
 * - WinJobHandle 仅内存持有、永不序列化（对齐 task-job-list.ts child 句柄同款边界）；
 * - 挂起模式（runSuspendedSpawnCommand）物理不经过本模块：不创建 Job、不设 timer、不挂 abort。
 */
import type * as koffi from 'koffi';
import type { ChildProcess } from 'node:child_process';

/** WinNT.h JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE：Job 最后一个句柄关闭时内核终结 job 内全部进程 */
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
/** JOBOBJECTINFOCLASS.JobObjectExtendedLimitInformation */
const JOBOBJECT_INFO_CLASS_EXTENDED_LIMIT = 9;
/** OpenProcess 权限：AssignProcessToJobObject 所需（PROCESS_SET_QUOTA | PROCESS_TERMINATE） */
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;

/** Job Object 句柄载体：handle 为 koffi 外部指针，closed 为单向幂等标志；仅内存持有，永不序列化 */
export interface WinJobHandle {
  handle: unknown;
  closed: boolean;
}

type KoffiModule = typeof koffi;

/** kernel32 六函数最小接口（Win32 BOOL 以 int32 表达；句柄以 void * 外部指针表达） */
interface Kernel32Api {
  CreateJobObjectW(attrs: unknown, name: unknown): unknown;
  SetInformationJobObject(job: unknown, infoClass: number, info: unknown, infoLen: number): number;
  OpenProcess(desiredAccess: number, inheritHandle: number, pid: number): unknown;
  AssignProcessToJobObject(job: unknown, proc: unknown): number;
  TerminateJobObject(job: unknown, exitCode: number): number;
  CloseHandle(handle: unknown): number;
}

/** 模块级唯一缓存：koffi 六函数 proto 与结构体尺寸（首次 win32 调用成功初始化后只读，失败不缓存） */
let kernel32Cache: { api: Kernel32Api; extInfoSize: number } | null = null;

/** 运行时 require 加载 koffi（绕过打包器静态内联；失败返回 null，调用方维持现状行为） */
function loadKoffiModule(): KoffiModule | null {
  try {
    const runtimeRequire = eval('require') as NodeRequire;
    return runtimeRequire('koffi') as KoffiModule;
  } catch (error) {
    console.warn('[win-job-object] koffi 模块加载失败（Job 根治退化为现状 child.kill 行为）:', error);
    return null;
  }
}

/** koffi 惰性初始化：首次调用时按 WinNT.h 字段序声明结构体、加载 kernel32.dll 并缓存六个函数 proto */
function getKernel32(): { api: Kernel32Api; extInfoSize: number } | null {
  if (kernel32Cache) return kernel32Cache;
  const koffiModule = loadKoffiModule();
  if (!koffiModule) return null;
  try {
    // JOBOBJECT_BASIC_LIMIT_INFORMATION（LARGE_INTEGER ×2 / DWORD / SIZE_T ×2 / DWORD / ULONG_PTR / DWORD ×2）
    koffiModule.struct('WinJobBasicLimitInformation', {
      PerProcessUserTimeLimit: 'int64_t',
      PerJobUserTimeLimit: 'int64_t',
      LimitFlags: 'uint32_t',
      MinimumWorkingSetSize: 'size_t',
      MaximumWorkingSetSize: 'size_t',
      ActiveProcessLimit: 'uint32_t',
      Affinity: 'uintptr_t',
      PriorityClass: 'uint32_t',
      SchedulingClass: 'uint32_t',
    });
    // IO_COUNTERS（六个 ULONGLONG）
    koffiModule.struct('WinJobIoCounters', {
      ReadOperationCount: 'uint64_t',
      WriteOperationCount: 'uint64_t',
      OtherOperationCount: 'uint64_t',
      ReadTransferCount: 'uint64_t',
      WriteTransferCount: 'uint64_t',
      OtherTransferCount: 'uint64_t',
    });
    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION（BasicLimitInformation + IoInfo + SIZE_T ×4）
    const extInfoType = koffiModule.struct('WinJobExtendedLimitInformation', {
      BasicLimitInformation: 'WinJobBasicLimitInformation',
      IoInfo: 'WinJobIoCounters',
      ProcessMemoryLimit: 'size_t',
      JobMemoryLimit: 'size_t',
      PeakProcessMemoryUsed: 'size_t',
      PeakJobMemoryUsed: 'size_t',
    });
    const lib = koffiModule.load('kernel32.dll');
    kernel32Cache = {
      api: {
        CreateJobObjectW: lib.func('void * CreateJobObjectW(void *attrs, void *name)'),
        SetInformationJobObject: lib.func('int32_t SetInformationJobObject(void *job, int32_t infoClass, WinJobExtendedLimitInformation *info, uint32_t infoLen)'),
        OpenProcess: lib.func('void * OpenProcess(uint32_t desiredAccess, int32_t inheritHandle, uint32_t pid)'),
        AssignProcessToJobObject: lib.func('int32_t AssignProcessToJobObject(void *job, void *proc)'),
        TerminateJobObject: lib.func('int32_t TerminateJobObject(void *job, uint32_t exitCode)'),
        CloseHandle: lib.func('int32_t CloseHandle(void *handle)'),
      },
      extInfoSize: extInfoType.size,
    };
    return kernel32Cache;
  } catch (error) {
    console.warn('[win-job-object] kernel32 初始化失败（Job 根治退化为现状 child.kill 行为）:', error);
    return null;
  }
}

/**
 * spawn 后立即调用：为非挂起子进程建立 Job Object 创建期所有权（assign 先于任何后代派生）。
 * 任一步失败即关闭已得句柄并返回 null——调用方进入"job 缺失"边界，维持现状 child.kill() 行为。
 */
export function createJobForChild(child: ChildProcess): WinJobHandle | null {
  if (process.platform !== 'win32') return null;
  const pid = child.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  const kernel32 = getKernel32();
  if (!kernel32) return null;
  const { api, extInfoSize } = kernel32;
  let jobHandle: unknown = null;
  let processHandle: unknown = null;
  try {
    jobHandle = api.CreateJobObjectW(null, null);
    if (!jobHandle) return null;
    const info = {
      BasicLimitInformation: {
        PerProcessUserTimeLimit: 0,
        PerJobUserTimeLimit: 0,
        LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        MinimumWorkingSetSize: 0,
        MaximumWorkingSetSize: 0,
        ActiveProcessLimit: 0,
        Affinity: 0,
        PriorityClass: 0,
        SchedulingClass: 0,
      },
      IoInfo: {
        ReadOperationCount: 0,
        WriteOperationCount: 0,
        OtherOperationCount: 0,
        ReadTransferCount: 0,
        WriteTransferCount: 0,
        OtherTransferCount: 0,
      },
      ProcessMemoryLimit: 0,
      JobMemoryLimit: 0,
      PeakProcessMemoryUsed: 0,
      PeakJobMemoryUsed: 0,
    };
    const setOk = api.SetInformationJobObject(jobHandle, JOBOBJECT_INFO_CLASS_EXTENDED_LIMIT, info, extInfoSize);
    if (!setOk) {
      api.CloseHandle(jobHandle);
      return null;
    }
    processHandle = api.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
    if (!processHandle) {
      api.CloseHandle(jobHandle);
      return null;
    }
    const assigned = api.AssignProcessToJobObject(jobHandle, processHandle);
    if (!assigned) {
      api.CloseHandle(processHandle);
      api.CloseHandle(jobHandle);
      return null;
    }
    api.CloseHandle(processHandle); // assign 完成即释放进程句柄，仅保留 job 句柄
    return { handle: jobHandle, closed: false };
  } catch (error) {
    console.warn('[win-job-object] createJobForChild 失败（返回 null，维持现状 child.kill 行为）:', error);
    try {
      if (processHandle) api.CloseHandle(processHandle);
    } catch {
      // 静默：失败自清理路径不抛出
    }
    try {
      if (jobHandle) api.CloseHandle(jobHandle);
    } catch {
      // 静默：失败自清理路径不抛出
    }
    return null;
  }
}

/** 超时/abort 触发点树杀：TerminateJobObject 内核级终结 job 进程集（幂等，失败仅 WARN 不抛出） */
export function terminateJobTree(job: WinJobHandle | null): void {
  if (!job) return;
  const kernel32 = getKernel32();
  if (!kernel32) return;
  try {
    const terminated = kernel32.api.TerminateJobObject(job.handle, 1);
    if (!terminated) {
      console.warn('[win-job-object] TerminateJobObject 失败（job 可能已终止或句柄已释放）');
    }
  } catch (error) {
    console.warn('[win-job-object] TerminateJobObject 异常（不抛出）:', error);
  }
}

/** 句柄释放：首次 CloseHandle 后置 closed=true；重复调用无操作（幂等）；入参 null 无操作 */
export function closeJobHandle(job: WinJobHandle | null): void {
  if (!job || job.closed) return;
  const kernel32 = getKernel32();
  if (!kernel32) return;
  try {
    kernel32.api.CloseHandle(job.handle);
  } catch (error) {
    console.warn('[win-job-object] CloseHandle 异常（不抛出）:', error);
  }
  job.closed = true;
}
