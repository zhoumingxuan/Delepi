/**
 * ImportDepsModal — 从文件导入依赖 Modal
 *
 * 功能：
 * - 文件选择区（.txt / .zip）
 * - 解析结果 Table（包名/版本/大小/状态）
 * - 状态机：IDLE → PARSING → PARSED → INSTALLING → DONE
 * - 统计摘要：共X个包 · Y已安装 · Z待安装 · W失败
 */

import { useCallback, useState } from 'react';
import {
  Button,
  Input,
  Modal,
  Table,
  Tag,
  Typography,
  App as AntApp,
  theme,
} from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  FolderOpenOutlined,
  LoadingOutlined,
} from '@ant-design/icons';
import type { ParsedImportResult, ImportPackageItem, ImportParseStatus } from '@shared/types/deps-import';

const { Text } = Typography;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ImportDepsModalProps {
  open: boolean;
  onClose: () => void;
  onInstallComplete: () => void;
  mirrorUrl?: string;
}

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

type ModalState = 'idle' | 'parsing' | 'parsed' | 'installing' | 'done';

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

export default function ImportDepsModal({
  open,
  onClose,
  onInstallComplete,
  mirrorUrl,
}: ImportDepsModalProps) {
  const { message } = AntApp.useApp();
  const { token } = theme.useToken();

  // ---- 状态 ----

  const [state, setState] = useState<ModalState>('idle');
  const [filePath, setFilePath] = useState<string>('');
  const [parseResult, setParseResult] = useState<ParsedImportResult | null>(null);

  // ---- 重置 ----

  const reset = useCallback(() => {
    setState('idle');
    setFilePath('');
    setParseResult(null);
  }, []);

  // ---- 选择文件 ----

  const handleBrowse = useCallback(async () => {
    try {
      // 通过 Electron dialog 选择文件
      const result = await (window as any).electronAPI?.dialog?.showOpenDialog?.({
        title: '选择依赖导入文件',
        filters: [
          { name: '支持的格式', extensions: ['txt', 'zip'] },
          { name: '文本文件', extensions: ['txt'] },
          { name: 'ZIP 压缩包', extensions: ['zip'] },
        ],
        properties: ['openFile'],
      });

      if (!result?.filePaths || result.filePaths.length === 0) {
        return; // 用户取消
      }

      const selectedPath: string = result.filePaths[0];
      setFilePath(selectedPath);

      // 进入解析
      await doParse(selectedPath);
    } catch (err) {
      message.error(`选择文件失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [message]);

  // ---- 解析文件 ----

  const doParse = useCallback(async (path: string) => {
    setState('parsing');
    try {
      const api = (window as any).electronAPI?.deps;
      if (!api?.parseImportFile) {
        throw new Error('IPC 不可用');
      }
      const result: ParsedImportResult = await api.parseImportFile(path);
      if (!result.success) {
        throw new Error(result.error || '解析失败');
      }
      setParseResult(result);
      setState('parsed');
    } catch (err) {
      message.error(`解析失败: ${err instanceof Error ? err.message : String(err)}`);
      setState('idle');
      setFilePath('');
    }
  }, [message]);

  // ---- 安装 ----

  const handleInstall = useCallback(async () => {
    if (!parseResult) return;

    const pendingPackages = parseResult.packages
      .filter((pkg) => pkg.status === 'pending_install')
      .map((pkg) => ({ name: pkg.name, version: pkg.requiredVersion }));

    if (pendingPackages.length === 0) return;

    setState('installing');
    try {
      const api = (window as any).electronAPI?.deps;
      if (!api?.install) {
        throw new Error('IPC 不可用');
      }
      await api.install({
        level: 'recommended',
        mirrorUrl: mirrorUrl || undefined,
        customPackages: pendingPackages,
      });
      setState('done');
      message.success(`成功安装 ${pendingPackages.length} 个依赖包`);
    } catch (err) {
      message.error(`安装失败: ${err instanceof Error ? err.message : String(err)}`);
      // 安装失败后仍保持在 parsed 状态，允许重试
      setState('parsed');
    }
  }, [parseResult, mirrorUrl, message]);

  // ---- 关闭处理 ----

  const handleClose = useCallback(() => {
    if (state === 'done') {
      onInstallComplete();
    }
    reset();
    onClose();
  }, [state, onClose, onInstallComplete, reset]);

  // ---- 状态 Tag 渲染 ----

  const renderStatusTag = (status: ImportParseStatus) => {
    switch (status) {
      case 'already_installed':
        return (
          <Tag
            icon={<CheckCircleOutlined />}
            style={{ color: token.colorTextDisabled, borderColor: token.colorTextDisabled }}
          >
            已安装
          </Tag>
        );
      case 'pending_install':
        return (
          <Tag
            icon={<ExclamationCircleOutlined />}
            color="blue"
          >
            待安装
          </Tag>
        );
      case 'parse_failed':
        return (
          <Tag
            icon={<CloseCircleOutlined />}
            color="error"
          >
            解析失败
          </Tag>
        );
      default:
        return <Tag>{status}</Tag>;
    }
  };

  // ---- 统计摘要 ----

  const summary = parseResult?.summary;
  const pendingCount = summary?.pendingInstall ?? 0;

  // ---- 列定义 ----

  const columns = [
    {
      title: '包名',
      dataIndex: 'name',
      key: 'name',
      width: '35%',
      ellipsis: true,
      render: (name: string, record: ImportPackageItem) => (
        <div>
          <Text style={{ fontFamily: 'monospace', fontSize: 13 }}>{name}</Text>
          {record.requiredVersion && (
            <Text style={{ fontSize: 11, color: token.colorTextTertiary, marginLeft: 6 }}>
              {record.requiredVersion}
            </Text>
          )}
        </div>
      ),
    },
    {
      title: '版本',
      dataIndex: 'installedVersion',
      key: 'version',
      width: '20%',
      render: (v: string | undefined, record: ImportPackageItem) => {
        if (record.status === 'already_installed' && v) {
          return <Text style={{ fontFamily: 'monospace', fontSize: 12, color: token.colorTextSecondary }}>{v}</Text>;
        }
        if (record.status === 'pending_install') {
          return <Text style={{ fontSize: 12, color: token.colorTextTertiary }}>—</Text>;
        }
        return <Text style={{ fontSize: 12, color: token.colorTextDisabled }}>—</Text>;
      },
    },
    {
      title: '大小',
      dataIndex: 'size',
      key: 'size',
      width: '15%',
      align: 'right' as const,
      render: (size: number | undefined) => {
        if (size === undefined || size === null) {
          return <Text style={{ fontSize: 12, color: token.colorTextDisabled }}>—</Text>;
        }
        const units = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(size) / Math.log(1024));
        const val = (size / Math.pow(1024, i)).toFixed(2);
        return (
          <Text style={{ fontSize: 12, color: token.colorTextSecondary, fontFeatureSettings: '"tnum"' }}>
            {val} {units[i]}
          </Text>
        );
      },
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: '30%',
      render: (_: unknown, record: ImportPackageItem) => renderStatusTag(record.status),
    },
  ];

  // ---- 渲染 ----

  return (
    <Modal
      title="从文件导入依赖"
      open={open}
      onCancel={handleClose}
      width={680}
      footer={
        state === 'parsed' ? (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button onClick={handleClose}>取消</Button>
            <Button
              type="primary"
              disabled={pendingCount === 0}
              onClick={handleInstall}
              icon={undefined}
            >
              开始安装({pendingCount}个包)
            </Button>
          </div>
        ) : state === 'installing' ? (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button disabled>取消</Button>
            <Button type="primary" loading disabled>
              安装中...
            </Button>
          </div>
        ) : state === 'done' ? (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button type="primary" onClick={handleClose}>
              完成
            </Button>
          </div>
        ) : (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button onClick={handleClose}>取消</Button>
          </div>
        )
      }
      destroyOnClose
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* 文件选择区 */}
        <div
          style={{
            padding: '16px',
            backgroundColor: token.colorFillQuaternary,
            border: `2px dashed ${token.colorBorder}`,
            borderRadius: token.borderRadius,
          }}
        >
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Input
              readOnly
              value={filePath || ''}
              placeholder="请选择 .txt 或 .zip 文件"
              style={{ flex: 1 }}
            />
            <Button
              onClick={handleBrowse}
              icon={<FolderOpenOutlined />}
              loading={state === 'parsing'}
              disabled={state === 'installing'}
            >
              浏览
            </Button>
          </div>
          <Text
            style={{
              fontSize: 12,
              color: token.colorTextTertiary,
              display: 'block',
              marginTop: 8,
            }}
          >
            支持 .txt（每行一个包名）和 .zip（包含 requirements.txt 或已解析依赖清单）
          </Text>
        </div>

        {/* 解析中提示 */}
        {state === 'parsing' && (
          <div
            style={{
              padding: '24px',
              textAlign: 'center',
              color: token.colorTextSecondary,
            }}
          >
            <LoadingOutlined style={{ fontSize: 24, marginBottom: 8, display: 'block' }} />
            <Text style={{ fontSize: 13 }}>正在解析文件...</Text>
          </div>
        )}

        {/* 解析结果 Table */}
        {(state === 'parsed' || state === 'installing' || state === 'done') && parseResult && (
          <>
            {/* 统计摘要 */}
            {summary && (
              <div
                style={{
                  padding: '8px 16px',
                  backgroundColor: token.colorFillTertiary,
                  borderRadius: token.borderRadius,
                  fontSize: 13,
                  color: token.colorTextSecondary,
                  display: 'flex',
                  gap: 16,
                  flexWrap: 'wrap',
                }}
              >
                <span>
                  共 <Text strong style={{ color: token.colorText }}>{summary.total}</Text> 个包
                </span>
                <span style={{ color: token.colorTextDisabled }}>
                  · <CheckCircleOutlined style={{ marginRight: 4 }} />
                  <Text style={{ color: token.colorTextDisabled }}>{summary.alreadyInstalled}</Text> 已安装
                </span>
                <span style={{ color: token.colorPrimary }}>
                  · <ExclamationCircleOutlined style={{ marginRight: 4 }} />
                  <Text style={{ color: token.colorPrimary }}>{summary.pendingInstall}</Text> 待安装
                </span>
                {summary.parseFailed > 0 && (
                  <span style={{ color: token.colorError }}>
                    · <CloseCircleOutlined style={{ marginRight: 4 }} />
                    <Text style={{ color: token.colorError }}>{summary.parseFailed}</Text> 失败
                  </span>
                )}
              </div>
            )}

            {/* Table */}
            <Table<ImportPackageItem>
              dataSource={parseResult.packages}
              rowKey="name"
              size="small"
              pagination={false}
              scroll={{ y: 360 }}
              columns={columns}
            />
          </>
        )}

        {/* 安装中提示 */}
        {state === 'installing' && (
          <div
            style={{
              padding: '16px',
              textAlign: 'center',
              color: token.colorTextSecondary,
              backgroundColor: token.colorFillTertiary,
              borderRadius: token.borderRadius,
            }}
          >
            <LoadingOutlined style={{ fontSize: 20, marginRight: 8 }} />
            <Text style={{ fontSize: 13 }}>正在安装依赖包，请稍候...</Text>
          </div>
        )}

        {/* 安装完成提示 */}
        {state === 'done' && (
          <div
            style={{
              padding: '16px',
              textAlign: 'center',
              backgroundColor: token.colorSuccessBg,
              borderRadius: token.borderRadius,
              border: `1px solid ${token.colorSuccessBorder}`,
            }}
          >
            <CheckCircleOutlined style={{ fontSize: 20, color: token.colorSuccess, marginRight: 8 }} />
            <Text style={{ fontSize: 13, color: token.colorSuccess }}>
              依赖包安装完成！已刷新清单。
            </Text>
          </div>
        )}
      </div>
    </Modal>
  );
}
