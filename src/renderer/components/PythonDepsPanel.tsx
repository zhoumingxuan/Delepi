/**
 * PythonDepsPanel — Python 依赖包管理面板
 *
 * 功能：
 * - 三级依赖包选择（核心 / 推荐 / 全部）
 * - 安装进度实时展示（Progress + Table）
 * - 安装 / 取消 / 导出 / 导入操作
 * - IPC 进度事件订阅（deps:progress）
 *
 * 依赖类型来自 @shared/types/deps，IPC 通道来自 @shared/ipc-channels
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  Empty,
  Input,
  Modal,
  Progress,
  Skeleton,
  Table,
  Tag,
  Typography,
  App as AntApp,
  theme,
} from 'antd';
import { DownloadOutlined, LoadingOutlined, ReloadOutlined, WarningOutlined } from '@ant-design/icons';
import {
  DepsStatus,
  type DepsInstallParams,
  type DepsInstallProgress,
  type DepsPackage,
} from '@shared/types/deps';
import { usePythonDepsPolling, type DepsPackageWithSize } from '../hooks/usePythonDepsPolling';
import ImportDepsModal from './ImportDepsModal';

const { Title, Text } = Typography;

// ---------------------------------------------------------------------------
// 本地 Props 类型
// ---------------------------------------------------------------------------

export interface PythonDepsPanelProps {
  /** 面板是否可见，默认 true */
  visible?: boolean;
  /** 关闭面板回调 */
  onClose?: () => void;
  /** Python 环境是否就绪（来自父组件 PythonEnvTab） */
  pythonReady?: boolean;
  /** Python 环境状态详情（来自父组件 PythonEnvTab） */
  pythonStatus?: {
    state: string;
    progress?: number;
    error?: string;
    pythonPath?: string;
  } | null;
}

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

export default function PythonDepsPanel(_props: PythonDepsPanelProps = {}) {
  const { pythonReady, pythonStatus } = _props;
  const { message } = AntApp.useApp();
  const { token } = theme.useToken();

  // ---- 状态变量 ----

  /** 依赖管理当前状态 */
  const [depsStatus, setDepsStatus] = useState<DepsStatus>(DepsStatus.IDLE);

  /** M9: Python 下载按钮 loading 状态 */
  const [pythonDownloading, setPythonDownloading] = useState(false);

  /** M9: 触发下载内置 Python */
  const handleDownloadPython = useCallback(async () => {
    const api = window.electronAPI?.python;
    if (!api) {
      message.error('IPC 不可用');
      return;
    }
    try {
      setPythonDownloading(true);
      await api.download();
    } catch (err) {
      message.error(`下载失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPythonDownloading(false);
    }
  }, [message]);

  /** 安装进度（null 表示未在安装） */
  const [installProgress, setInstallProgress] = useState<DepsInstallProgress | null>(null);


  /** pip 镜像源 URL（留空使用官方源） */
  const [mirrorUrl, setMirrorUrl] = useState<string>('https://pypi.org/simple/');

  /** ImportDepsModal 开关 */
  const [importModalOpen, setImportModalOpen] = useState(false);

  /** 已安装的依赖包清单 */
  const [installedPackages, setInstalledPackages] = useState<DepsPackage[]>([]);




  /** 最新进度引用，防止高频推送闭包陈旧导致更新丢失 */
  const latestProgressRef = useRef<DepsInstallProgress | null>(null);

  // ---- IPC 进度事件订阅（占位） ----

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = window.electronAPI.deps;
    if (!api) return;

    const unsubscribe = api.onProgress((progress: DepsInstallProgress) => {
      // 更新 ref 确保函数式 setState 始终读取最新值
      latestProgressRef.current = progress;
      setInstallProgress((prev) => {
        const latest = latestProgressRef.current;
        if (!latest) return prev;
        // 防闪烁：同一progress值不重复更新
        if (prev?.progress === latest.progress && prev?.status === latest.status) {
          return prev;
        }
        return latest;
      });
      setDepsStatus((prev) => {
        const latest = latestProgressRef.current;
        if (!latest) return prev;
        // 防闪烁：同一状态不重复setState
        if (prev === latest.status) return prev;
        return latest.status;
      });
      // INSTALLING 状态下不污染 installedPackages
      // installedPackages 仅在安装完成后由 handleInstall 设置
    });

    return unsubscribe;
  }, []);

  // Phase3: 使用轮询 Hook 获取已安装包列表（进入 Tab → 立即刷新 + 每30秒轮询）
  const { packages, loading, lastRefreshTime, manualRefresh } = usePythonDepsPolling({
    active: pythonReady !== false,
  });

  // ---- 操作函数（占位） ----

  /** 安装依赖（固定使用 recommended 级别） */
  const handleInstall = useCallback(async (customPackages?: { name: string; version?: string }[]) => {
    try {
      setDepsStatus(DepsStatus.INSTALLING);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = window.electronAPI;
      const result = await api?.deps?.install({
        level: 'recommended',
        mirrorUrl: mirrorUrl,
        customPackages,
      } as DepsInstallParams);
      if (result?.packages && result.packages.length > 0) {
        setInstalledPackages(result.packages);
        setDepsStatus(DepsStatus.COMPLETED);
      }
    } catch (err) {
      message.error(
        `安装失败: ${err instanceof Error ? err.message : String(err)}`,
      );
      setDepsStatus(DepsStatus.INSTALL_FAILED);
    }
  }, [message, mirrorUrl]);

  /** 取消安装 */
  const handleCancel = useCallback(async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = window.electronAPI;
      await api?.deps?.cancelInstall();
    } catch (err) {
      message.error(
        `取消安装失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [message]);

  /** 导出依赖包：弹出保存对话框 → 用户选择路径 → 导出 */
  const handleExport = useCallback(async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = window.electronAPI;
      // 1. 弹出保存对话框
      const pathResult = await api?.deps?.selectExportPath();
      if (!pathResult?.success) {
        message.error(pathResult?.error || '选择导出路径失败');
        return;
      }
      if (!pathResult.filePath) {
        // 用户取消选择
        return;
      }
      // 2. 导出到用户选择的路径
      const result = await api?.deps?.exportBundle(pathResult.filePath);
      if (result?.bundlePath) {
        message.success(`导出成功: ${result.bundlePath}`);
      } else {
        message.success(`导出成功`);
      }
    } catch (err) {
      message.error(
        `导出失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [message]);

  /** 引导安装 pip（固定使用 recommended 级别） */
  const handleBootstrapPip = useCallback(async () => {
    try {
      setDepsStatus(DepsStatus.BOOTSTRAPPING);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = window.electronAPI;
      await api?.deps?.install({
        level: 'recommended',
        autoBootstrap: true,
      });
    } catch (err) {
      message.error(
        `pip 安装失败: ${err instanceof Error ? err.message : String(err)}`,
      );
      setDepsStatus(DepsStatus.INSTALL_FAILED);
    }
  }, [message]);

  // ---- 渲染 ----

  const isBootstrapping = depsStatus === DepsStatus.BOOTSTRAPPING;

  /** 场景0: Python 未就绪提示（M9增强：按状态分支显示引导操作） */
  const renderPythonNotReady = () => {
    return null;
  };

  /** 场景A: pip 引导安装面板 */
  const renderPipBootstrap = () => (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        marginTop: 8,
        padding: '12px 16px',
        borderLeft: `3px solid ${token.colorWarning}`,
        backgroundColor: token.colorWarningBg,
        borderRadius: token.borderRadius,
      }}
    >
      <WarningOutlined
        style={{
          fontSize: 16,
          color: token.colorWarning,
          marginTop: 2,
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: 500,
            color: token.colorText,
            lineHeight: '22px',
          }}
        >
          pip 尚未安装
        </div>
        <div
          style={{
            fontSize: 12,
            fontWeight: 400,
            color: token.colorTextSecondary,
            marginTop: 4,
            lineHeight: '20px',
          }}
        >
          依赖管理功能需要 pip 支持，请先安装 pip
        </div>
        <Button
          type="default"
          size="small"
          loading={isBootstrapping}
          disabled={isBootstrapping}
          onClick={handleBootstrapPip}
          style={{ marginTop: 8 }}
        >
          [安装 pip]
        </Button>
      </div>
    </div>
  );

  /** 场景A 触发条件: pip 引导安装中 */
  const showPipBootstrap =
    depsStatus === DepsStatus.BOOTSTRAPPING;

  /** 场景B 触发条件: pip就绪 / 空闲 / 安装失败 */
  const showLevelSelector =
    depsStatus === DepsStatus.IDLE ||
    depsStatus === DepsStatus.PIP_READY ||
    depsStatus === DepsStatus.INSTALL_FAILED;

  /** 场景C 触发条件: 安装中 / 取消中 */
  const showProgress =
    depsStatus === DepsStatus.INSTALLING ||
    depsStatus === DepsStatus.CANCELLING;

  /** 场景D 触发条件: 安装完成 或 已有已安装包数据（Phase3：Hook 提供） */
  const showInstalledList =
    depsStatus === DepsStatus.COMPLETED || packages.length > 0;

  /** 场景B: 镜像URL + 开始安装（固定 recommended 级别） */
  const renderLevelSelector = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
      <Input
        value={mirrorUrl}
        onChange={(e) => setMirrorUrl(e.target.value)}
        placeholder="可选填国内镜像源加速下载（如 https://mirrors.aliyun.com/pypi/simple/）"
        allowClear
      />

      <Button type="primary" onClick={() => handleInstall()} style={{ alignSelf: 'flex-start' }}>
        开始安装
      </Button>
    </div>
  );

  /** 场景C: 安装进度面板 */
  const renderProgress = () => {
    const isCancelling = depsStatus === DepsStatus.CANCELLING;
    const completed = installProgress?.installedCount ?? 0;
    const total = installProgress?.totalCount ?? 0;
    const failedCount = installProgress?.failedCount ?? 0;
    const currentPackage = installProgress?.currentPackage ?? '';
    const singleProgress = installProgress?.progress ?? 0;
    const currentIdx = installProgress?.currentIndex ?? 0;
    const rawPercent = total > 0
      ? (currentIdx + singleProgress / 100) / total * 100
      : 0;
    const percent = Math.min(100, Math.max(0, Math.round(rawPercent)));

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
        {/* 百分比进度条 */}
        <Progress
          percent={percent}
          strokeColor={token.colorPrimary}
          status={isCancelling ? 'exception' : 'active'}
        />

        {/* 当前安装包名 */}
        {currentPackage ? (
          <Text
            style={{
              fontSize: 12,
              fontFamily: 'monospace',
              color: token.colorTextSecondary,
            }}
          >
            正在安装: {currentPackage}
          </Text>
        ) : null}

        {/* 副统计文字 */}
        <Text
          style={{
            fontSize: 12,
            fontWeight: 400,
            color: token.colorTextSecondary,
          }}
        >
          {completed}/{total} 个包完成，{failedCount} 失败
        </Text>

        {/* 取消按钮 */}
        <Button
          type="default"
          loading={isCancelling}
          disabled={isCancelling}
          onClick={handleCancel}
          style={{ alignSelf: 'flex-start' }}
        >
          取消安装
        </Button>
      </div>
    );
  };


  /** 场景D: 已安装清单面板（Phase3：虚拟滚动 + 骨架屏 + 空状态引导 + 刷新按钮） */
  const renderInstalledList = () => {
    /** 将字节数格式化为可读字符串（统一使用 .toFixed(2) 两位小数） */
    const formatSize = (bytes?: number): string => {
      if (bytes === undefined || bytes === null || bytes < 0) return "—";
      if (bytes === 0) return "0 B";
      const units = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(1024));
      return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + units[i];
    };

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
        {/* 标题行: 已安装清单 + 刷新按钮 + 上次刷新时间 + 绿色Tag徽标 */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Text
              style={{
                fontSize: 14,
                fontWeight: 500,
                color: token.colorText,
              }}
            >
              已安装清单
            </Text>
            <Tag color={token.colorSuccess}>
              {packages.length} 个包
            </Tag>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Text
              style={{
                fontSize: 12,
                color: token.colorTextTertiary,
              }}
            >
              {lastRefreshTime ? new Date(lastRefreshTime).toLocaleTimeString() : '--'}
            </Text>
            <Button
              icon={<ReloadOutlined />}
              loading={loading}
              onClick={manualRefresh}
              size="small"
              type="default"
            />
          </div>
        </div>

        {/* 骨架屏：加载中且无数据 */}
        {loading && packages.length === 0 ? (
          <Skeleton active paragraph={{ rows: 6 }} />
        ) : (
          <Table<DepsPackageWithSize>
            dataSource={packages}
            rowKey="name"
            size="small"
            pagination={false}
            virtual
            scroll={{ y: 400 }}
            locale={{
              emptyText: (
                <Empty
                  description="暂无已安装的依赖包"
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                />
              ),
            }}
            columns={[
              {
                title: "包名",
                dataIndex: "name",
                key: "name",
                align: "left",
                width: "50%",
                ellipsis: true,
              },
              {
                title: "版本",
                dataIndex: "version",
                key: "version",
                align: "left",
                width: "25%",
                render: (v: string | undefined) => {
                  if (!v) {
                    return <span style={{ color: token.colorTextDisabled, fontSize: 12 }}>—</span>;
                  }
                  return <span style={{ fontFamily: 'monospace', fontSize: 13, color: token.colorTextSecondary }}>{v}</span>;
                },
              },
              {
                title: "大小",
                dataIndex: "size",
                key: "size",
                align: "right",
                width: "25%",
                render: (v: number | undefined) => {
                  if (v === undefined || v === null) {
                    return <span style={{ color: token.colorTextDisabled, fontSize: 12 }}>—</span>;
                  }
                  return <span style={{ fontSize: 12, color: token.colorTextSecondary, fontFeatureSettings: '"tnum"' }}>{formatSize(v)}</span>;
                },
              },
            ]}
          />
        )}

        {/* 操作按钮: 导出(primary) + 从文件导入(default) */}
        <div style={{ display: "flex", gap: 8, marginTop: 8, marginBottom: 16 }}>
          <Button type="primary" onClick={handleExport}>
            导出
          </Button>
          <Button type="default" onClick={() => setImportModalOpen(true)}>
            从文件导入
          </Button>
        </div>

      </div>
    );
  };
  return (
    <>
    <div style={{ padding: 0 }}>
      <Title
        level={5}
        style={{
          marginTop: 0,
          marginBottom: 0,
          fontSize: 16,
          fontWeight: 500,
          color: token.colorText,
        }}
      >
        依赖包管理
      </Title>

      {(() => {
        // v2.0: cancelled_phase2 — Python可用但依赖被取消，先显示提示再允许操作
        const isCancelledPhase2 = pythonStatus?.state === 'cancelled_phase2';
        if (isCancelledPhase2) {
          return (
            <>
              {renderPythonNotReady()}
              {showLevelSelector && renderLevelSelector()}
            </>
          );
        }
        // Python 环境未就绪时显示提示（不阻塞面板渲染）
        if (pythonReady === false) return renderPythonNotReady();
        if (showPipBootstrap) return renderPipBootstrap();
        if (showProgress) return renderProgress();
        if (showInstalledList) return renderInstalledList();
        if (showLevelSelector) return renderLevelSelector();
        return (
          <Text
            style={{
              fontSize: 12,
              color: token.colorTextSecondary,
              display: 'block',
              marginTop: 8,
            }}
          >
            状态: {depsStatus}
            {installProgress ? ` | 进度: ${installProgress.progress}%` : ''}
          </Text>
        );
      })()}

    </div>

    {/* 从文件导入依赖 Modal */}
    <ImportDepsModal
      open={importModalOpen}
      onClose={() => setImportModalOpen(false)}
      onInstallComplete={() => {
        setImportModalOpen(false);
        manualRefresh();
      }}
      mirrorUrl={mirrorUrl}
    />
    </>
  );
}
