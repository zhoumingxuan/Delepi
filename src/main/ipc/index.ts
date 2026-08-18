/**
 * IPC 层模块导出
 */

export { registerIpcHandlers } from './ipc-handlers';
export {
  IPC_CHAT,
  IPC_CONFIG,
  IPC_CONV,
  IPC_EXECUTOR,
  IPC_FILE,
  type IpcChannel,
} from '@shared/ipc-channels';
