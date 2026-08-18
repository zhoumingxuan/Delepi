/**
 * 依赖导入解析类型定义
 * 用于 import 语句解析器（import-deps-parser.ts）的输出类型
 * 主进程和渲染进程均从此文件导入
 */

/** import 语句中单个包的解析状态 */
export type ImportParseStatus = 'already_installed' | 'pending_install' | 'parse_failed';

/** import 语句中解析出的单个依赖包信息 */
export interface ImportPackageItem {
  /** pip 包名称 */
  name: string;
  /** import 语句中要求的版本（如 import 语句注释中标注） */
  requiredVersion?: string;
  /** 当前环境中已安装的版本 */
  installedVersion?: string;
  /** 包大小估算（字节） */
  size?: number;
  /** 解析状态 */
  status: ImportParseStatus;
  /** 解析失败时的错误信息 */
  error?: string;
}

/** import 语句解析结果汇总 */
export interface ParsedImportResult {
  /** 解析是否成功 */
  success: boolean;
  /** 解析出的所有包列表 */
  packages: ImportPackageItem[];
  /** 汇总统计 */
  summary: {
    /** 总包数 */
    total: number;
    /** 已安装的包数 */
    alreadyInstalled: number;
    /** 待安装的包数 */
    pendingInstall: number;
    /** 解析失败的包数 */
    parseFailed: number;
  };
  /** 整体解析失败时的错误信息 */
  error?: string;
}
