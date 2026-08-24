/**
 * ConfigDrawer 配置抽屉组件
 * 配置项：API/模型/视觉识别 + Python 环境（双 Tab 布局）
 * 客户端单主题：antd v6 ConfigProvider 默认值
 */

import {
  type ReactElement,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AutoComplete,
  Button,
  Divider,
  Drawer,
  Flex,
  Form,
  Input,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Switch,
  Tabs,
  Tag,
  Typography,
  App as AntApp,
  theme as antdTheme,
} from 'antd';
import {
  ApiOutlined,
  ProfileOutlined,
  RobotOutlined,
  ThunderboltOutlined,
  TagsOutlined,
  EyeOutlined,
} from '@ant-design/icons';
import type { AppSettings, ModelProfile, CustomSkillTag } from '@shared/types/config';
import { PythonEnvTab } from './PythonEnvTab';

/** 配置方案列表/切换结果（主进程 config:profiles-* 通道返回） */
interface ProfileListResult {
  profiles: ModelProfile[];
  activeProfileId: string;
}

/** 方案切换结果 */
interface ProfileSwitchResult {
  activeProfileId: string;
  profileName: string;
}

/**
 * 方案操作 API 局部类型：window.electronAPI 的全局类型声明（electron.d.ts）不在本次改动白名单内，
 * preload 已暴露下列四个方法，此处以局部类型断言安全对接（运行时经 contextBridge 正常可达）。
 */
type ProfilesConfigApi = {
  listProfiles: () => Promise<ProfileListResult>;
  saveProfile: (params: { name: string }) => Promise<ProfileListResult>;
  deleteProfile: (params: { id: string }) => Promise<ProfileListResult>;
  switchProfile: (params: { id: string }) => Promise<ProfileSwitchResult>;
};

/** 内置技能标签只读条目（skills:list 返回；内置8项不可编辑/删除） */
interface SkillBuiltinItem {
  name: string;
  title: string;
  description: string;
  fileName: string;
}

/** 技能列表结果（skills:list 返回） */
interface SkillsListResult {
  builtin: SkillBuiltinItem[];
  custom: CustomSkillTag[];
  limit: number;
  templateMaxLength: number;
}

/**
 * 技能管理 API 局部类型：同 ProfilesConfigApi 先例，electron.d.ts 不在改动白名单内，
 * preload 已暴露 skills 三方法，以局部类型断言安全对接（运行时经 contextBridge 正常可达）。
 */
type SkillsConfigApi = {
  list: () => Promise<SkillsListResult>;
  save: (params: {
    originalName?: string;
    name: string;
    title: string;
    description?: string;
    enabled?: boolean;
    templateContent?: string;
  }) => Promise<{ custom: CustomSkillTag[] }>;
  delete: (params: { name: string }) => Promise<{ custom: CustomSkillTag[] }>;
  readTemplate: (params: { source: 'builtin' | 'custom'; key: string }) => Promise<{ success: boolean; content?: string; error?: string }>;
  saveBuiltinOverride: (params: { fileName: string; content: string | null }) => Promise<{ success: boolean; error?: string }>;
};

/**
 * 本地模型预设常量（纯前端数据，禁止任何网络请求）。
 * 仅作为模型名称 AutoComplete 的建议项，输入框保留自由输入以兼容未来新模型；
 * baseUrl 为该服务商 OpenAI 兼容端点示例（预设条目内容待用户按实际使用情况补充校准）。
 */
const MODEL_PROVIDER_PRESETS: Array<{ provider: string; baseUrl: string; models: string[] }> = [
  { provider: 'OpenAI 官方', baseUrl: 'https://api.openai.com/v1', models: ['gpt-5.6-luna', 'gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini', 'o3'] },
  { provider: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-chat'] },
  { provider: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-5.3', 'glm-5.2', 'glm-4.6', 'glm-4.5', 'glm-4.5-air'] },
  { provider: '阿里通义千问（DashScope 兼容）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen3.8-max', 'qwen3.7-plus', 'qwen3-max', 'qwen-max', 'qwen-plus'] },
  { provider: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', models: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6'] },
  { provider: '字节豆包（方舟）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', models: ['doubao-seed-1-6', 'doubao-pro-32k'] },
  { provider: 'MiniMax', baseUrl: 'https://api.minimaxi.com/v1', models: ['MiniMax-M3', 'MiniMax-M2.7'] },
  { provider: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', models: ['z-ai/glm-5.3', 'moonshotai/kimi-k3', 'minimax/minimax-m3', 'openai/gpt-5.5', 'openai/gpt-4o', 'deepseek/deepseek-chat'] },
  { provider: '硅基流动 SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', models: ['deepseek-ai/DeepSeek-R1', 'Qwen/Qwen3-Omni-30B-A3B-Instruct', 'deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct'] },
  { provider: 'Ollama 本地', baseUrl: 'http://localhost:11434/v1', models: ['qwen3.5', 'gemma4', 'qwen3', 'llama3', 'gemma3'] },
];

interface ConfigDrawerProps {
  open: boolean;
  onClose: () => void;
  config: AppSettings;
  configLoading: boolean;
  onSave: (key: keyof AppSettings, value: unknown) => Promise<void> | void;
  onSaveAll: (updates: Partial<AppSettings>) => Promise<void> | void;
  onReload: () => Promise<void> | void;
  /** 外部控制当前激活的 Tab（不传时内部自管） */
  activeTab?: string;
  /** Tab 切换回调 */
  onTabChange?: (tab: string) => void;
}

export const ConfigDrawer = memo(function ConfigDrawer({
  open,
  onClose,
  config,
  configLoading,
  onSave,
  // onSaveAll 保留接口兼容性但不再使用（按钮已移除）
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onSaveAll: _onSaveAll,
  // onReload：方案切换/删除后调用，刷新 useSettings.config 使全局消费点与库一致
  onReload,
  activeTab: externalActiveTab,
  onTabChange,
}: ConfigDrawerProps): ReactElement {
  const { token } = antdTheme.useToken();
  const { message: antdMessage, modal: antdModal } = AntApp.useApp();
  const [form] = Form.useForm<AppSettings>();

  // 视觉模型三字段是否未配置（用于视觉识别开关旁轻量提示）
  const visionLlmUnconfigured = !config.visionLlmBaseUrl
    || !config.visionLlmApiKey
    || !config.visionLlmModel;

  const calcDrawerWidth = useCallback(() => {
    const w = window.innerWidth;
    if (w >= 1200) return Math.min(700, Math.round(w * 0.38));
    if (w >= 900) return Math.round(w * 0.45);
    return Math.max(320, Math.round(w * 0.8));
  }, []);

  const [drawerWidth, setDrawerWidth] = useState(calcDrawerWidth);

  useEffect(() => {
    let frameId: number;
    const handleResize = () => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => {
        setDrawerWidth(calcDrawerWidth());
      });
    };
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(frameId);
    };
  }, [calcDrawerWidth]);

  // ---- Tab 状态：外部控制优先，否则内部自管 ----
  const [internalActiveTab, setInternalActiveTab] = useState('model');
  const activeKey = externalActiveTab ?? internalActiveTab;

  const handleTabChange = useCallback(
    (key: string) => {
      if (onTabChange) {
        onTabChange(key);
      } else {
        setInternalActiveTab(key);
      }
    },
    [onTabChange],
  );

  const handleSave = useCallback(
    async (key: keyof AppSettings) => {
      try {
        const value = form.getFieldValue(key);
        await onSave(key, value);
      } catch (err) {
        antdMessage.error('保存失败');
      }
    },
    [form, onSave, antdMessage],
  );

  // ---- 配置方案（多槽位）状态与操作 ----
  const profilesApi = useMemo(
    () => window.electronAPI?.config as unknown as ProfilesConfigApi | undefined,
    [],
  );
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState('');
  const [profileNameModalOpen, setProfileNameModalOpen] = useState(false);
  const [profileNameInput, setProfileNameInput] = useState('');
  const [profileActionLoading, setProfileActionLoading] = useState(false);
  const profilesApiMissingRef = useRef(false);

  const loadProfiles = useCallback(async () => {
    if (!profilesApi) {
      if (!profilesApiMissingRef.current) {
        profilesApiMissingRef.current = true;
      }
      return;
    }
    try {
      const result = await profilesApi.listProfiles();
      setProfiles(result?.profiles ?? []);
      setActiveProfileId(result?.activeProfileId ?? '');
    } catch {
      antdMessage.error('加载配置方案失败');
    }
  }, [profilesApi, antdMessage]);

  // 抽屉打开时拉取一次方案列表（activeProfileId 以主进程为权威）
  useEffect(() => {
    if (open) {
      void loadProfiles();
    }
  }, [open, loadProfiles]);

  /** 切换方案：成功后回填表单（Form initialValues 不随 config 刷新）并刷新全局 config */
  const handleSwitchProfile = useCallback(
    async (id: string) => {
      if (!profilesApi || !id) return;
      const profile = profiles.find((item) => item.id === id);
      setProfileActionLoading(true);
      try {
        const result = await profilesApi.switchProfile({ id });
        setActiveProfileId(result?.activeProfileId ?? id);
        if (profile) {
          const { id: _profileId, name: _profileName, ...profileValues } = profile;
          form.setFieldsValue(profileValues);
        }
        antdMessage.success(`已切换到方案「${result?.profileName ?? profile?.name ?? ''}」`);
        await onReload();
      } catch (err) {
        antdMessage.error(err instanceof Error ? err.message : '切换方案失败，可重试；已填写的配置不会丢失');
        await loadProfiles();
      } finally {
        setProfileActionLoading(false);
      }
    },
    [profilesApi, profiles, form, antdMessage, onReload, loadProfiles],
  );

  /** 另存为方案：主进程以当前生效配置为权威快照源，同名覆盖 */
  const handleSaveProfileAs = useCallback(async () => {
    const name = profileNameInput.trim();
    if (!profilesApi) return;
    if (!name) {
      antdMessage.warning('请输入方案名称');
      return;
    }
    setProfileActionLoading(true);
    try {
      const result = await profilesApi.saveProfile({ name });
      setProfiles(result?.profiles ?? []);
      setProfileNameModalOpen(false);
      setProfileNameInput('');
      antdMessage.success(`已保存方案「${name}」`);
    } catch (err) {
      antdMessage.error(err instanceof Error ? err.message : '保存方案失败');
    } finally {
      setProfileActionLoading(false);
    }
  }, [profilesApi, profileNameInput, antdMessage]);

  /** 删除方案：删除当前激活方案时仅解除激活标记，当前生效配置保持不变 */
  const handleDeleteProfile = useCallback(
    (id: string) => {
      if (!profilesApi || !id) return;
      const target = profiles.find((item) => item.id === id);
      const isActive = id === activeProfileId;
      antdModal.confirm({
        title: '删除配置方案',
        content: isActive
          ? `确定删除当前使用的方案「${target?.name ?? ''}」？正在使用的配置不变，只是不能再一键切回。`
          : `确定删除方案「${target?.name ?? ''}」？`,
        okText: '删除',
        okButtonProps: { danger: true },
        cancelText: '取消',
        onOk: async () => {
          try {
            const result = await profilesApi.deleteProfile({ id });
            setProfiles(result?.profiles ?? []);
            setActiveProfileId(result?.activeProfileId ?? '');
            if (isActive) {
              await onReload();
            }
            antdMessage.success('方案已删除');
          } catch (err) {
            antdMessage.error(err instanceof Error ? err.message : '删除方案失败');
          }
        },
      });
    },
    [profilesApi, profiles, activeProfileId, antdModal, antdMessage, onReload],
  );

  // ---- 技能管理（方向2：内部自治；与聊天流零连接点，故 useChat.ts 零改动） ----
  const skillsApi = useMemo(
    () => (window as unknown as { electronAPI?: { skills?: SkillsConfigApi } }).electronAPI?.skills,
    [],
  );
  const [skillsData, setSkillsData] = useState<SkillsListResult | null>(null);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsSaving, setSkillsSaving] = useState(false);
  const [skillModalOpen, setSkillModalOpen] = useState(false);
  /** 编辑中的原标签名（''=新建；非空=编辑该标签，改名时以此定位） */
  const [skillEditingOriginalName, setSkillEditingOriginalName] = useState('');
  const [skillFormName, setSkillFormName] = useState('');
  const [skillFormTitle, setSkillFormTitle] = useState('');
  const [skillFormDescription, setSkillFormDescription] = useState('');
  const [skillFormTemplate, setSkillFormTemplate] = useState('');
  /** 内置技能编辑态（非空=弹框处于内置编辑模式；标签名/标题/描述常量锁定，仅允许编辑模板内容） */
  const [skillEditingBuiltin, setSkillEditingBuiltin] = useState<SkillBuiltinItem | null>(null);

  const loadSkills = useCallback(async () => {
    if (!skillsApi) {
      return;
    }
    setSkillsLoading(true);
    try {
      const result = await skillsApi.list();
      setSkillsData(result ?? null);
    } catch (error) {
      antdMessage.error(`加载技能列表失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSkillsLoading(false);
    }
  }, [skillsApi, antdMessage]);

  // 抽屉打开时刷新技能列表（含内置8项只读展示与自定义元数据）
  useEffect(() => {
    if (open) {
      void loadSkills();
    }
  }, [open, loadSkills]);

  const openSkillCreateModal = useCallback(() => {
    setSkillEditingBuiltin(null);
    setSkillEditingOriginalName('');
    setSkillFormName('');
    setSkillFormTitle('');
    setSkillFormDescription('');
    setSkillFormTemplate('');
    setSkillModalOpen(true);
  }, []);

  const openSkillEditModal = useCallback(async (item: CustomSkillTag) => {
    setSkillEditingBuiltin(null);
    setSkillEditingOriginalName(item.name);
    setSkillFormName(item.name);
    setSkillFormTitle(item.title);
    setSkillFormDescription(item.description);
    setSkillFormTemplate('');
    setSkillModalOpen(true);
    if (!skillsApi) {
      return;
    }
    // 编辑回显：读取既有模板内容（从未写过模板的自定义技能 content='' 即空；读取失败置空并提示）
    try {
      const result = await skillsApi.readTemplate({ source: 'custom', key: item.slug });
      if (result?.success) {
        setSkillFormTemplate(result.content ?? '');
      } else {
        antdMessage.error(`读取模板内容失败：${result?.error ?? '未知错误'}（保存时填写内容将整体覆盖）`);
      }
    } catch (error) {
      antdMessage.error(`读取模板内容失败：${error instanceof Error ? error.message : String(error)}（保存时填写内容将整体覆盖）`);
    }
  }, [skillsApi, antdMessage]);

  const openSkillEditBuiltinModal = useCallback(async (item: SkillBuiltinItem) => {
    if (!skillsApi) {
      return;
    }
    setSkillEditingBuiltin(item);
    setSkillEditingOriginalName('');
    setSkillFormName(item.name);
    setSkillFormTitle(item.title);
    setSkillFormDescription(item.description);
    setSkillFormTemplate('');
    // 内置编辑回显：覆写优先（无覆写回退内置默认内容）；读取失败不打开弹框
    try {
      const result = await skillsApi.readTemplate({ source: 'builtin', key: item.fileName });
      if (!result?.success) {
        antdMessage.error(`读取内置模板内容失败：${result?.error ?? '未知错误'}`);
        return;
      }
      setSkillFormTemplate(result.content ?? '');
      setSkillModalOpen(true);
    } catch (error) {
      antdMessage.error(`读取内置模板内容失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [skillsApi, antdMessage]);

  const handleSaveSkill = useCallback(async () => {
    if (!skillsApi) {
      return;
    }
    // 内置编辑模式：仅保存模板内容覆写（标签名/标题/描述常量锁定，不提交）
    if (skillEditingBuiltin) {
      setSkillsSaving(true);
      try {
        const result = await skillsApi.saveBuiltinOverride({
          fileName: skillEditingBuiltin.fileName,
          content: skillFormTemplate,
        });
        if (!result?.success) {
          antdMessage.error(`保存内置技能失败：${result?.error ?? '未知错误'}`);
          return;
        }
        setSkillModalOpen(false);
        antdMessage.success(`内置技能「${skillEditingBuiltin.name}」内容已更新`);
      } catch (error) {
        antdMessage.error(`保存内置技能失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setSkillsSaving(false);
      }
      return;
    }
    setSkillsSaving(true);
    try {
      const result = await skillsApi.save({
        originalName: skillEditingOriginalName || undefined,
        name: skillFormName,
        title: skillFormTitle,
        description: skillFormDescription,
        enabled: true,
        templateContent: skillFormTemplate || undefined,
      });
      setSkillModalOpen(false);
      if (result?.custom) {
        setSkillsData((prev) => (prev ? { ...prev, custom: result.custom } : prev));
      }
      antdMessage.success(skillEditingOriginalName ? '自定义技能已更新' : '自定义技能已创建');
    } catch (error) {
      antdMessage.error(`保存自定义技能失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSkillsSaving(false);
    }
  }, [skillsApi, skillEditingBuiltin, skillEditingOriginalName, skillFormName, skillFormTitle, skillFormDescription, skillFormTemplate, antdMessage]);

  const handleResetBuiltinSkill = useCallback(async () => {
    if (!skillsApi || !skillEditingBuiltin) {
      return;
    }
    setSkillsSaving(true);
    try {
      const result = await skillsApi.saveBuiltinOverride({
        fileName: skillEditingBuiltin.fileName,
        content: null,
      });
      if (!result?.success) {
        antdMessage.error(`恢复默认失败：${result?.error ?? '未知错误'}`);
        return;
      }
      setSkillModalOpen(false);
      antdMessage.success('已恢复默认内容');
      void loadSkills();
    } catch (error) {
      antdMessage.error(`恢复默认失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSkillsSaving(false);
    }
  }, [skillsApi, skillEditingBuiltin, antdMessage, loadSkills]);

  const handleToggleSkillEnabled = useCallback(async (item: CustomSkillTag, enabled: boolean) => {
    if (!skillsApi) {
      return;
    }
    // 乐观切换；失败回滚并提示
    setSkillsData((prev) => (prev
      ? { ...prev, custom: prev.custom.map((c) => (c.name === item.name ? { ...c, enabled } : c)) }
      : prev));
    try {
      const result = await skillsApi.save({
        originalName: item.name,
        name: item.name,
        title: item.title,
        description: item.description,
        enabled,
        templateContent: undefined,
      });
      if (result?.custom) {
        setSkillsData((prev) => (prev ? { ...prev, custom: result.custom } : prev));
      }
      antdMessage.success(enabled ? `技能「${item.name}」已启用` : `技能「${item.name}」已停用，不再生效`);
    } catch (error) {
      setSkillsData((prev) => (prev
        ? { ...prev, custom: prev.custom.map((c) => (c.name === item.name ? { ...c, enabled: item.enabled } : c)) }
        : prev));
      antdMessage.error(`操作失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [skillsApi, antdMessage]);

  const handleDeleteSkill = useCallback((item: CustomSkillTag) => {
    if (!skillsApi) {
      return;
    }
    antdModal.confirm({
      title: '删除自定义技能',
      content: `将删除自定义技能「${item.name}」及其模板文件（内置技能不受影响），确定删除？`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          const result = await skillsApi.delete({ name: item.name });
          if (result?.custom) {
            setSkillsData((prev) => (prev ? { ...prev, custom: result.custom } : prev));
          }
          antdMessage.success(`自定义技能「${item.name}」已删除`);
        } catch (error) {
          antdMessage.error(`删除失败：${error instanceof Error ? error.message : String(error)}`);
        }
      },
    });
  }, [skillsApi, antdModal, antdMessage]);

  /** 模型名称 AutoComplete 建议（按服务商分组；本地常量，无网络请求，自由输入不受限） */
  const modelNamePresetOptions = useMemo(
    () =>
      MODEL_PROVIDER_PRESETS.map((preset) => ({
        label: preset.provider,
        options: preset.models.map((modelName) => ({ value: modelName })),
      })),
    [],
  );



  return (
    <Drawer
      title="配置"
      placement="right"
      closable={false}
      width={drawerWidth}
      open={open}
      onClose={onClose}
      styles={{
        body: {
          padding: `${token.paddingMD}px ${token.paddingLG}px`,
          background: token.colorBgContainer,
        },
      }}
    >
      <Flex vertical gap={token.paddingMD} style={{ height: "100%" }}>
        <Tabs
          activeKey={activeKey}
          onChange={handleTabChange}
          destroyInactiveTabPane={false}
          items={[
            {
              key: "model",
              label: "模型配置",
              children: (
                <>
                  {/* 配置方案栏（多槽位）：下拉切换 + 另存为 + 删除 */}
                  <div
                    style={{
                      borderLeft: `3px solid ${token.colorInfo}`,
                      background: token.colorBgContainer,
                      border: `1px solid ${token.colorBorderSecondary}`,
                      borderRadius: token.borderRadius,
                      padding: 16,
                      marginBottom: 24,
                    }}
                  >
                    <Typography.Title
                      level={5}
                      style={{
                        fontSize: 14,
                        fontWeight: 500,
                        color: token.colorText,
                        marginTop: 0,
                        marginBottom: token.paddingXS,
                      }}
                    >
                      <Flex align="center" gap={token.paddingXS}>
                        <ProfileOutlined /> 配置方案
                      </Flex>
                    </Typography.Title>
                    <Typography.Paragraph
                      type="secondary"
                      style={{ fontSize: 12, marginBottom: token.paddingMD }}
                    >
                      保存多套模型配置方案，一键切换免重填；下方是当前正在使用的配置，改动即自动保存。
                    </Typography.Paragraph>
                    <Flex gap={token.paddingSM} wrap="wrap" align="middle">
                      <Select
                        style={{ minWidth: 220, flex: 1 }}
                        placeholder={
                          profiles.length === 0
                            ? "暂无保存的方案：配置好后点「另存为方案」保存"
                            : "选择方案一键切换"
                        }
                        value={activeProfileId || undefined}
                        onChange={handleSwitchProfile}
                        loading={profileActionLoading}
                        disabled={configLoading || profiles.length === 0}
                        options={profiles.map((item) => ({
                          value: item.id,
                          label: item.name,
                        }))}
                      />
                      <Button
                        disabled={configLoading || profileActionLoading}
                        onClick={() => {
                          setProfileNameInput("");
                          setProfileNameModalOpen(true);
                        }}
                      >
                        另存为方案
                      </Button>
                      <Button
                        danger
                        disabled={
                          configLoading ||
                          profileActionLoading ||
                          !activeProfileId
                        }
                        onClick={() => handleDeleteProfile(activeProfileId)}
                      >
                        删除方案
                      </Button>
                    </Flex>
                  </div>

                  <Form
                    form={form}
                    layout="vertical"
                    initialValues={config}
                    disabled={configLoading}
                  >
                    {/* 主智能体配置 */}
                    <div
                      style={{
                        borderLeft: `3px solid ${token.colorPrimary}`,
                        background: token.colorBgContainer,
                        border: `1px solid ${token.colorBorderSecondary}`,
                        borderRadius: token.borderRadius,
                        padding: 16,
                        marginBottom: 24,
                      }}
                    >
                      <Typography.Title
                        level={5}
                        style={{
                          fontSize: 14,
                          fontWeight: 500,
                          color: token.colorText,
                          marginTop: 0,
                          marginBottom: token.paddingMD,
                        }}
                      >
                        <Flex align="center" gap={token.paddingXS}>
                          <ApiOutlined /> 主智能体（对话与回答）
                        </Flex>
                      </Typography.Title>

                      <Form.Item
                        label={
                          <span
                            style={{
                              color: token.colorTextSecondary,
                              fontSize: 13,
                            }}
                          >
                            接口地址（Base URL）
                          </span>
                        }
                        name="mainModelBaseUrl"
                      >
                        <Input
                          placeholder="https://api.example.com/v1"
                          onBlur={() => handleSave("mainModelBaseUrl")}
                        />
                      </Form.Item>

                      <Form.Item
                        label={
                          <span
                            style={{
                              color: token.colorTextSecondary,
                              fontSize: 13,
                            }}
                          >
                            API 密钥
                          </span>
                        }
                        name="mainModelApiKey"
                      >
                        <Input.Password
                          placeholder="在模型服务商官网申请，如 sk-..."
                          onBlur={() => handleSave("mainModelApiKey")}
                        />
                      </Form.Item>

                      <Form.Item
                        label={
                          <span
                            style={{
                              color: token.colorTextSecondary,
                              fontSize: 13,
                            }}
                          >
                            模型名称
                          </span>
                        }
                        name="mainModelName"
                      >
                        <AutoComplete
                          options={modelNamePresetOptions}
                          filterOption={(input, option) =>
                            String(
                              (option as { value?: unknown } | undefined)
                                ?.value ?? "",
                            )
                              .toLowerCase()
                              .includes(input.toLowerCase())
                          }
                          placeholder="选择或输入模型名称（支持自由输入）"
                          onBlur={() => handleSave("mainModelName")}
                        />
                      </Form.Item>

                      <Form.Item
                        label={
                          <span
                            style={{
                              color: token.colorTextSecondary,
                              fontSize: 13,
                            }}
                          >
                            支持图片输入（多模态）
                          </span>
                        }
                        name="mainModelMultimodal"
                        valuePropName="checked"
                        extra={
                          !config.visionEnabled
                            ? "视觉识别已关闭，此开关暂不生效"
                            : undefined
                        }
                      >
                        <Switch
                          disabled={!config.visionEnabled}
                          onChange={(value) =>
                            onSave("mainModelMultimodal", value)
                          }
                        />
                      </Form.Item>

                      <Form.Item
                        label={
                          <span
                            style={{
                              color: token.colorTextSecondary,
                              fontSize: 13,
                            }}
                          >
                            思考程度
                          </span>
                        }
                        name="mainThinkingLevel"
                      >
                        <Radio.Group
                          onChange={(e) =>
                            onSave("mainThinkingLevel", e.target.value)
                          }
                          style={{ display: "flex", gap: 16 }}
                        >
                          <Radio value="low">
                            <span
                              style={{
                                fontSize: 13,
                                fontWeight: 500,
                                color: token.colorText,
                              }}
                            >
                              低
                            </span>
                            <span
                              style={{
                                fontSize: 12,
                                color: token.colorTextSecondary,
                                marginLeft: 8,
                              }}
                            >
                              更快响应
                            </span>
                          </Radio>
                          <Radio value="high">
                            <span
                              style={{
                                fontSize: 13,
                                fontWeight: 500,
                                color: token.colorText,
                              }}
                            >
                              高
                            </span>
                            <span
                              style={{
                                fontSize: 12,
                                color: token.colorTextSecondary,
                                marginLeft: 8,
                              }}
                            >
                              均衡推理（默认）
                            </span>
                          </Radio>
                          <Radio value="max">
                            <span
                              style={{
                                fontSize: 13,
                                fontWeight: 500,
                                color: token.colorText,
                              }}
                            >
                              最大
                            </span>
                            <span
                              style={{
                                fontSize: 12,
                                color: token.colorTextSecondary,
                                marginLeft: 8,
                              }}
                            >
                              深度推理
                            </span>
                          </Radio>
                        </Radio.Group>
                      </Form.Item>
                    </div>

                    {/* 子智能体配置 */}
                    <div
                      style={{
                        borderLeft: `3px solid ${token.colorWarning}`,
                        background: token.colorBgContainer,
                        border: `1px solid ${token.colorBorderSecondary}`,
                        borderRadius: token.borderRadius,
                        padding: 16,
                        marginBottom: 24,
                      }}
                    >
                      <Typography.Title
                        level={5}
                        style={{
                          fontSize: 14,
                          fontWeight: 500,
                          color: token.colorText,
                          marginTop: 0,
                          marginBottom: token.paddingMD,
                        }}
                      >
                        <Flex align="center" gap={token.paddingXS}>
                          <ThunderboltOutlined /> 子智能体（执行任务）
                        </Flex>
                      </Typography.Title>

                      <Form.Item
                        label={
                          <span
                            style={{
                              color: token.colorTextSecondary,
                              fontSize: 13,
                            }}
                          >
                            接口地址（Base URL）
                          </span>
                        }
                        name="executorModelBaseUrl"
                      >
                        <Input
                          placeholder="https://api.example.com/v1"
                          onBlur={() => handleSave("executorModelBaseUrl")}
                        />
                      </Form.Item>

                      <Form.Item
                        label={
                          <span
                            style={{
                              color: token.colorTextSecondary,
                              fontSize: 13,
                            }}
                          >
                            API 密钥
                          </span>
                        }
                        name="executorModelApiKey"
                      >
                        <Input.Password
                          placeholder="在模型服务商官网申请，如 sk-..."
                          onBlur={() => handleSave("executorModelApiKey")}
                        />
                      </Form.Item>

                      <Form.Item
                        label={
                          <span
                            style={{
                              color: token.colorTextSecondary,
                              fontSize: 13,
                            }}
                          >
                            模型名称
                          </span>
                        }
                        name="executorModelName"
                      >
                        <AutoComplete
                          options={modelNamePresetOptions}
                          filterOption={(input, option) =>
                            String(
                              (option as { value?: unknown } | undefined)
                                ?.value ?? "",
                            )
                              .toLowerCase()
                              .includes(input.toLowerCase())
                          }
                          placeholder="选择或输入模型名称（支持自由输入）"
                          onBlur={() => handleSave("executorModelName")}
                        />
                      </Form.Item>

                      <Form.Item
                        label={
                          <span
                            style={{
                              color: token.colorTextSecondary,
                              fontSize: 13,
                            }}
                          >
                            思考程度
                          </span>
                        }
                        name="executorThinkingLevel"
                      >
                        <Radio.Group
                          onChange={(e) =>
                            onSave("executorThinkingLevel", e.target.value)
                          }
                          style={{ display: "flex", gap: 16 }}
                        >
                          <Radio value="low">
                            <span
                              style={{
                                fontSize: 13,
                                fontWeight: 500,
                                color: token.colorText,
                              }}
                            >
                              低
                            </span>
                            <span
                              style={{
                                fontSize: 12,
                                color: token.colorTextSecondary,
                                marginLeft: 8,
                              }}
                            >
                              更快响应
                            </span>
                          </Radio>
                          <Radio value="high">
                            <span
                              style={{
                                fontSize: 13,
                                fontWeight: 500,
                                color: token.colorText,
                              }}
                            >
                              高
                            </span>
                            <span
                              style={{
                                fontSize: 12,
                                color: token.colorTextSecondary,
                                marginLeft: 8,
                              }}
                            >
                              均衡推理
                            </span>
                          </Radio>
                          <Radio value="max">
                            <span
                              style={{
                                fontSize: 13,
                                fontWeight: 500,
                                color: token.colorText,
                              }}
                            >
                              最大
                            </span>
                            <span
                              style={{
                                fontSize: 12,
                                color: token.colorTextSecondary,
                                marginLeft: 8,
                              }}
                            >
                              深度推理（默认）
                            </span>
                          </Radio>
                        </Radio.Group>
                      </Form.Item>
                    </div>

                    {/* 视觉识别配置 */}
                    <div
                      style={{
                        borderLeft: `3px solid ${token.colorSuccess}`,
                        background: token.colorBgContainer,
                        border: `1px solid ${token.colorBorderSecondary}`,
                        borderRadius: token.borderRadius,
                        padding: 16,
                        marginBottom: 24,
                      }}
                    >
                      <Typography.Title
                        level={5}
                        style={{
                          fontSize: 14,
                          fontWeight: 500,
                          color: token.colorText,
                          marginTop: 0,
                          marginBottom: token.paddingMD,
                        }}
                      >
                        <Flex align="center" gap={token.paddingXS}>
                          <EyeOutlined /> 视觉识别
                        </Flex>
                      </Typography.Title>

                      <Form.Item
                        label={
                          <span
                            style={{
                              color: token.colorTextSecondary,
                              fontSize: 13,
                            }}
                          >
                            启用视觉识别
                          </span>
                        }
                        name="visionEnabled"
                        valuePropName="checked"
                        extra={
                          visionLlmUnconfigured
                            ? "视觉模型 API 未配置，图片识别会报错"
                            : undefined
                        }
                      >
                        <Switch
                          onChange={(value) => {
                            if (value) {
                              antdMessage.info(
                                "开启视觉识别需配置模型 API，否则图片识别会报错",
                              );
                            }
                            onSave("visionEnabled", value);
                          }}
                        />
                      </Form.Item>

                      <Form.Item
                        label={
                          <span
                            style={{
                              color: token.colorTextSecondary,
                              fontSize: 13,
                            }}
                          >
                            接口地址（Base URL）
                          </span>
                        }
                        name="visionLlmBaseUrl"
                      >
                        <Input
                          disabled={configLoading || !config.visionEnabled}
                          placeholder="https://api.example.com/v1"
                          onBlur={() => handleSave("visionLlmBaseUrl")}
                        />
                      </Form.Item>

                      <Form.Item
                        label={
                          <span
                            style={{
                              color: token.colorTextSecondary,
                              fontSize: 13,
                            }}
                          >
                            API 密钥
                          </span>
                        }
                        name="visionLlmApiKey"
                      >
                        <Input.Password
                          disabled={configLoading || !config.visionEnabled}
                          placeholder="在模型服务商官网申请，如 sk-..."
                          onBlur={() => handleSave("visionLlmApiKey")}
                        />
                      </Form.Item>

                      <Form.Item
                        label={
                          <span
                            style={{
                              color: token.colorTextSecondary,
                              fontSize: 13,
                            }}
                          >
                            模型名称
                          </span>
                        }
                        name="visionLlmModel"
                      >
                        <AutoComplete
                          disabled={configLoading || !config.visionEnabled}
                          options={modelNamePresetOptions}
                          filterOption={(input, option) =>
                            String(
                              (option as { value?: unknown } | undefined)
                                ?.value ?? "",
                            )
                              .toLowerCase()
                              .includes(input.toLowerCase())
                          }
                          placeholder="选择或输入模型名称（支持自由输入）"
                          onBlur={() => handleSave("visionLlmModel")}
                        />
                      </Form.Item>
                    </div>
                  </Form>
                </>
              ),
            },
            {
              key: "python",
              label: "Python 环境",
              children: <PythonEnvTab />,
            },
            {
              key: "skills",
              label: "技能管理",
              children: (
                <>
                  {/* 内置8标签：Tag 标签化展示（标签名/标题/描述常量锁定；仅允许编辑模板内容） */}
                  <div
                    style={{
                      borderLeft: `3px solid ${token.colorBorderSecondary}`,
                      background: token.colorFillQuaternary,
                      border: `1px solid ${token.colorBorderSecondary}`,
                      borderRadius: token.borderRadius,
                      padding: 16,
                      marginBottom: 24,
                      opacity: 0.85,
                    }}
                  >
                    <Typography.Title
                      level={5}
                      style={{
                        fontSize: 14,
                        fontWeight: 500,
                        color: token.colorTextSecondary,
                        marginTop: 0,
                        marginBottom: token.paddingXS,
                      }}
                    >
                      <Flex align="center" gap={token.paddingXS}>
                        <TagsOutlined /> 内置技能（标签固定；可编辑内容）
                      </Flex>
                    </Typography.Title>
                    <Flex vertical gap={token.paddingSM}>
                      {(skillsData?.builtin ?? []).map((item) => (
                        <div
                          key={item.name}
                          style={{
                            display: "flex",
                            gap: token.paddingXS,
                            alignItems: "flex-start",
                          }}
                        >
                          <Tag
                            color="geekblue"
                            style={{
                              marginInlineEnd: 0,
                              fontSize: 13,
                              minWidth: 84,
                              flexBasis: 84,
                            }}
                          >
                            {item.name}
                          </Tag>
                          <Typography.Text
                            type="secondary"
                            style={{ fontSize: 11, flex: "0 0 auto" }}
                          >
                            内置
                          </Typography.Text>
                          <Typography.Text
                            type="secondary"
                            style={{
                              fontSize: 12,
                              flex: "1 1 0%",
                              minWidth: 0,
                            }}
                          >
                            {item.description}
                          </Typography.Text>
                          <Flex style={{ marginLeft: "auto" }}>
                            <Button
                              size="small"
                              type="link"
                              style={{
                                padding: 0,
                                height: "auto",
                                fontSize: 12,
                              }}
                              onClick={() => {
                                void openSkillEditBuiltinModal(item);
                              }}
                            >
                              编辑
                            </Button>
                          </Flex>
                        </div>
                      ))}
                    </Flex>
                  </div>

                  {/* 自定义技能标签：列表/新建/编辑/启停/删除 */}
                  <div
                    style={{
                      borderLeft: `3px solid ${token.colorInfo}`,
                      background: token.colorBgContainer,
                      border: `1px solid ${token.colorBorderSecondary}`,
                      borderRadius: token.borderRadius,
                      padding: 16,
                      marginBottom: 24,
                    }}
                  >
                    <Typography.Title
                      level={5}
                      style={{
                        fontSize: 14,
                        fontWeight: 500,
                        color: token.colorText,
                        marginTop: 0,
                        marginBottom: token.paddingXS,
                      }}
                    >
                      <Flex align="center" gap={token.paddingXS}>
                        <TagsOutlined /> 自定义技能
                        <Typography.Text
                          type="secondary"
                          style={{ fontSize: 12, fontWeight: 400 }}
                        >
                          {`${skillsData?.custom.length ?? 0}/${skillsData?.limit ?? 16}`}
                          （停用后不再生效；名称不可与内置技能重复）
                        </Typography.Text>
                      </Flex>
                    </Typography.Title>
                    <Typography.Paragraph
                      type="secondary"
                      style={{ fontSize: 12, marginBottom: token.paddingMD }}
                    >
                      创建你自己的技能：保存后主智能体执行任务时会按需启用；模板为纯
                      Markdown；单次任务最多同时启用 3 个技能。
                    </Typography.Paragraph>
                    <Flex
                      gap={token.paddingSM}
                      wrap="wrap"
                      style={{ marginBottom: token.paddingMD }}
                    >
                      <Button
                        type="primary"
                        loading={skillsLoading}
                        disabled={
                          skillsSaving ||
                          (skillsData?.custom.length ?? 0) >=
                            (skillsData?.limit ?? 16)
                        }
                        onClick={openSkillCreateModal}
                      >
                        新建自定义技能
                      </Button>
                    </Flex>
                    <Flex vertical gap={token.paddingSM}>
                      {(skillsData?.custom ?? []).map((item) => (
                        <div
                          key={item.name}
                          style={{
                            border: `1px solid ${token.colorBorderSecondary}`,
                            borderRadius: token.borderRadius,
                            padding: `${token.paddingXS}px ${token.paddingSM}px`,
                          }}
                        >
                          <Flex
                            align="center"
                            gap={token.paddingSM}
                            wrap="wrap"
                          >
                            <Typography.Text strong style={{ fontSize: 13 }}>
                              {item.name}
                            </Typography.Text>
                            <Typography.Text
                              type="secondary"
                              style={{ fontSize: 12 }}
                            >
                              {item.title}
                            </Typography.Text>
                            <Flex
                              gap={token.paddingXS}
                              style={{
                                marginLeft: "auto",
                                justifyContent: "space-between",
                              }}
                            >
                              <Button
                                size="small"
                                type="link"
                                disabled={skillsSaving}
                                onClick={() => openSkillEditModal(item)}
                              >
                                编辑
                              </Button>
                              <Button
                                size="small"
                                type="link"
                                danger
                                disabled={skillsSaving}
                                onClick={() => handleDeleteSkill(item)}
                              >
                                删除
                              </Button>
                              <br/>
                              <Switch
                                size="small"
                                style={{ marginTop: 6 }}
                                checked={item.enabled}
                                disabled={skillsSaving}
                                onChange={(checked) => {
                                  void handleToggleSkillEnabled(item, checked);
                                }}
                              />
                            </Flex>
                          </Flex>
                          {item.description ? (
                            <Typography.Paragraph
                              type="secondary"
                              style={{
                                fontSize: 12,
                                marginBottom: 0,
                                marginTop: token.paddingXXS,
                              }}
                            >
                              {item.description}
                            </Typography.Paragraph>
                          ) : null}
                        </div>
                      ))}
                      {(skillsData?.custom.length ?? 0) === 0 ? (
                        <Typography.Text
                          type="secondary"
                          style={{ fontSize: 12 }}
                        >
                          还没有自定义技能，点上方按钮创建
                        </Typography.Text>
                      ) : null}
                    </Flex>
                  </div>
                </>
              ),
            },
          ]}
        />

        {/* 另存为配置方案：名称输入（同名覆盖，主进程以当前生效配置为快照源） */}
        <Modal
          title="另存为配置方案"
          open={profileNameModalOpen}
          onOk={() => {
            void handleSaveProfileAs();
          }}
          onCancel={() => {
            setProfileNameModalOpen(false);
            setProfileNameInput("");
          }}
          okText="保存"
          cancelText="取消"
          confirmLoading={profileActionLoading}
        >
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            将保存当前三组模型配置（主智能体 / 子智能体 /
            视觉识别），随时可一键切回；同名方案会被覆盖。
          </Typography.Paragraph>
          <Input
            placeholder="方案名称，如：DeepSeek-生产 / GLM-测试"
            value={profileNameInput}
            onChange={(e) => setProfileNameInput(e.target.value)}
            onPressEnter={() => {
              void handleSaveProfileAs();
            }}
            maxLength={50}
            showCount
          />
        </Modal>

        {/* 技能编辑 Modal（自定义：新建必填/编辑回显；内置：仅编辑模板内容+恢复默认） */}
        <Modal
          title={
            skillEditingBuiltin
              ? `编辑内置技能：${skillEditingBuiltin.name}`
              : skillEditingOriginalName
                ? `编辑自定义技能：${skillEditingOriginalName}`
                : "新建自定义技能"
          }
          open={skillModalOpen}
          onOk={() => {
            void handleSaveSkill();
          }}
          onCancel={() => {
            setSkillModalOpen(false);
          }}
          okText="保存"
          cancelText="取消"
          confirmLoading={skillsSaving}
          width={640}
          styles={{ body: { paddingBottom: 28 } }}
          footer={
            skillEditingBuiltin
              ? [
                  <Popconfirm
                    key="reset"
                    title="确定恢复该技能默认内容？"
                    description="将删除你的修改"
                    okText="恢复默认"
                    cancelText="取消"
                    onConfirm={() => {
                      void handleResetBuiltinSkill();
                    }}
                  >
                    <Button danger disabled={skillsSaving}>
                      恢复默认
                    </Button>
                  </Popconfirm>,
                  <Button key="cancel" onClick={() => setSkillModalOpen(false)}>
                    取消
                  </Button>,
                  <Button
                    key="save"
                    type="primary"
                    loading={skillsSaving}
                    onClick={() => {
                      void handleSaveSkill();
                    }}
                  >
                    保存
                  </Button>,
                ]
              : undefined
          }
        >
          <Flex vertical gap={token.paddingSM}>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                技能名称（不可与内置技能重名，≤32 字符）
              </Typography.Text>
              <Input
                placeholder="如：需求梳理 / 竞品分析"
                value={skillFormName}
                onChange={(e) => setSkillFormName(e.target.value)}
                maxLength={32}
                showCount
                disabled={Boolean(skillEditingBuiltin)}
              />
            </div>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                模板标题（将显示为「##【标题】工作方式」，≤64 字符）
              </Typography.Text>
              <Input
                placeholder="如：需求梳理"
                value={skillFormTitle}
                onChange={(e) => setSkillFormTitle(e.target.value)}
                maxLength={64}
                showCount
                disabled={Boolean(skillEditingBuiltin)}
              />
            </div>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                模板描述（技能列表中显示，≤200 字符）
              </Typography.Text>
              <Input
                placeholder="该技能的适用范围与用途说明"
                value={skillFormDescription}
                onChange={(e) => setSkillFormDescription(e.target.value)}
                maxLength={200}
                showCount
                disabled={Boolean(skillEditingBuiltin)}
              />
            </div>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                模板内容（纯 Markdown）
              </Typography.Text>
              <Input.TextArea
                placeholder={
                  skillEditingOriginalName || skillEditingBuiltin
                    ? "修改后保存即覆盖生效"
                    : "## 适用\n（工作方式正文，Markdown）"
                }
                value={skillFormTemplate}
                onChange={(e) => setSkillFormTemplate(e.target.value)}
                showCount
                autoSize={{ minRows: 10, maxRows: 20 }}
              />
            </div>
          </Flex>
        </Modal>
      </Flex>
    </Drawer>
  );
});
