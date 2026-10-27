/**
 * 客户端自动更新：按平台调起安装器 / 给出人工替换指引
 *
 * win10：安装包就是 exe，shell.openPath 启动 NSIS 安装器，800ms 后退出应用避免占用被替换文件；
 * mac：shell.openPath 挂载 dmg，不自动退出，提示用户拖入 Applications；
 * linux：chmod 0o755 后提示用户退出应用并手动替换（运行中的 AppImage 无法自我覆盖，ETXTBSY）。
 */

import { app, shell } from 'electron';
import { chmod, stat } from 'node:fs/promises';
import path from 'node:path';
import { UPDATE_ERROR_CODES } from '@shared/update-error-codes';
import type { UpdateInstallResult, UpdatePlatform } from '@shared/types/update';
import { writeUpdateLog } from './update-log';

const WINDOWS_QUIT_DELAY_MS = 800;

export async function launchUpdateInstaller(
  platform: UpdatePlatform,
  filePath: string,
  version: string,
): Promise<UpdateInstallResult> {
  const info = await stat(filePath).catch(() => null);
  if (!info || !info.isFile() || info.size <= 0) {
    return {
      launched: false,
      code: UPDATE_ERROR_CODES.INSTALL_FAILED,
      message: '安装包不存在或为空，请重新下载。',
    };
  }

  const extension = path.extname(filePath).toLowerCase();

  try {
    if (platform === 'win10') {
      if (extension !== '.exe') {
        return {
          launched: false,
          code: UPDATE_ERROR_CODES.INSTALL_FAILED,
          message: 'Windows 安装包扩展名不是 .exe。',
        };
      }
      const openError = await shell.openPath(filePath);
      if (openError) {
        writeUpdateLog('ERROR', 'update.install', { version, launched: false, code: 'OPEN_PATH_FAILED' }, openError);
        return {
          launched: false,
          code: UPDATE_ERROR_CODES.INSTALL_FAILED,
          message: '安装程序未能启动，请重试。',
        };
      }
      setTimeout(() => {
        app.quit();
      }, WINDOWS_QUIT_DELAY_MS);
      writeUpdateLog('INFO', 'update.install', { version, launched: true, platform });
      return { launched: true };
    }

    if (platform === 'mac') {
      if (extension !== '.dmg') {
        return {
          launched: false,
          code: UPDATE_ERROR_CODES.INSTALL_FAILED,
          message: 'macOS 安装包扩展名不是 .dmg。',
        };
      }
      const openError = await shell.openPath(filePath);
      if (openError) {
        writeUpdateLog('ERROR', 'update.install', { version, launched: false, code: 'OPEN_PATH_FAILED' }, openError);
        return {
          launched: false,
          code: UPDATE_ERROR_CODES.INSTALL_FAILED,
          message: '安装映像未能打开，请在文件夹中手动打开。',
        };
      }
      writeUpdateLog('INFO', 'update.install', { version, launched: true, platform });
      return {
        launched: true,
        message: '已打开 dmg，请把 Delepi 拖入 Applications 后重启。',
      };
    }

    if (platform === 'linux') {
      if (extension !== '.appimage') {
        return {
          launched: false,
          code: UPDATE_ERROR_CODES.INSTALL_FAILED,
          message: 'Linux 安装包扩展名不是 .AppImage。',
        };
      }
      await chmod(filePath, 0o755);
      shell.showItemInFolder(filePath);
      const currentAppImage = process.env.APPIMAGE ?? '当前 AppImage';
      writeUpdateLog('INFO', 'update.install', { version, launched: true, platform });
      return {
        launched: true,
        message: `已设为可执行并打开所在文件夹。请退出 Delepi 后用新文件手动替换 ${currentAppImage}。`,
      };
    }

    return {
      launched: false,
      code: UPDATE_ERROR_CODES.UNSUPPORTED_PLATFORM,
      message: '当前系统不支持自动更新。',
    };
  } catch (error) {
    writeUpdateLog('ERROR', 'update.install', { version, launched: false, code: 'EXCEPTION' }, error);
    return {
      launched: false,
      code: UPDATE_ERROR_CODES.INSTALL_FAILED,
      message: '安装程序未能启动，请重试。',
    };
  }
}
