/**
 * TeamManagementTab — 人员管理 Tab 组件（成员增删改查 + 基础技能标签绑定）
 *
 * 功能：
 * - 成员表格：人员昵称 / 角色类型 / 职业 / 职责 / 多任务并行 / 启用状态 / 基础技能标签 / 操作
 * - 关键字过滤：按「人员昵称」或「职业」模糊匹配（主进程参数化 LIKE，服务端过滤）
 * - 内联新增/编辑表单（与表格同屏）：昵称、角色类型（中文单选）、职业、职责、
 *   多任务并行开关、启用状态开关、基础技能标签多选（选项=主进程固定返回的内置基础技能集合，不含自定义技能）
 * - 删除：Modal 二次确认，主进程在事务内同时清理 team_members 与 team_member_skills
 * - 昵称唯一：前端做「已存在」提示，最终由主进程事务内 SELECT 查重兜底（表无 UNIQUE 约束）
 *
 * 类型说明：全局 window.electronAPI 声明（src/main/types/electron.d.ts）不含 team 分组，
 * 沿用 ConfigDrawer.tsx（ProfilesConfigApi/SkillsConfigApi）与 OtherSettingsTab.tsx（WatchApi）
 * 的「局部类型 + as unknown as 断言」范式，运行时经 contextBridge 正常可达。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import {
  App as AntApp,
  Button,
  Divider,
  Flex,
  Input,
  Radio,
  Select,
  Switch,
  Table,
  Tag,
  Typography,
  theme,
} from 'antd';
import type { TableProps } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';

/** 人员列表项（字段与主进程 TeamMemberListItem 一一对应） */
interface TeamMemberListItem {
  /** SQLite 隐式 rowid，仅作列表渲染 key */
  rowId: number;
  nickname: string;
  roleType: number | null;
  /** 角色中文：1=执行者、2=审核者、3=研究者、4=实验员 */
  roleLabel: string;
  profession: string;
  duty: string;
  isMultiTaskParallel: boolean;
  /** 原始 status：1=启用、0=禁用、NULL=启用 */
  status: number | null;
  enabled: boolean;
  skillTags: string[];
  createdAt: string | null;
  updatedAt: string | null;
}

/** 新增/修改表单载荷（对应主进程 TeamMemberInput） */
interface TeamMemberPayload {
  nickname: string;
  roleType: number;
  profession: string;
  duty: string;
  isMultiTaskParallel: boolean;
  enabled: boolean;
  skillTags: string[];
}

/** 人员管理 IPC 局部类型（preload 已暴露 team 五方法） */
interface TeamApi {
  list: (params?: { keyword?: string }) => Promise<{ members: TeamMemberListItem[] }>;
  create: (params: TeamMemberPayload) => Promise<{ member: TeamMemberListItem }>;
  update: (params: TeamMemberPayload & { originalNickname: string }) => Promise<{ member: TeamMemberListItem }>;
  delete: (params: { nickname: string }) => Promise<{ nickname: string }>;
  listSkillTags: () => Promise<{ tags: string[] }>;
}

/** 角色类型选项（文案与主进程 TEAM_MEMBER_ROLE_TYPE_LABELS 同源：1=执行者/2=审核者/3=研究者/4=实验员） */
const ROLE_TYPE_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 1, label: '执行者' },
  { value: 2, label: '审核者' },
  { value: 3, label: '研究者' },
  { value: 4, label: '实验员' },
];

/** 单个人员可绑定的基础技能标签数量上限（与主进程 MAX_TEAM_MEMBER_SKILL_TAG_COUNT 一致） */
const MAX_SKILL_TAG_COUNT = 20;

/**
 * 剥离 Electron 对主进程 handler 抛错的固定包装前缀：
 * 「Error invoking remote method 'team:create': Error: 人员昵称「x」已存在，请更换」→「人员昵称「x」已存在，请更换」
 */
const IPC_ERROR_PREFIX_RE = /^(?:Error invoking remote method '[^']*':\s*)?(?:Error:\s*)*/;

/** 把 IPC 异常转成可直接展示的中文文案 */
function toReadableError(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const stripped = raw.replace(IPC_ERROR_PREFIX_RE, '').trim();
  return stripped || fallback;
}

export function TeamManagementTab(): ReactElement {
  const { token } = theme.useToken();
  const { message: antdMessage, modal: antdModal } = AntApp.useApp();
  const teamApi = useMemo(
    () => (window as unknown as { electronAPI?: { team?: TeamApi } }).electronAPI?.team,
    [],
  );

  const [members, setMembers] = useState<TeamMemberListItem[]>([]);
  const [loading, setLoading] = useState(false);
  /** 输入框即时值 */
  const [keywordInput, setKeywordInput] = useState('');
  /** 已提交的过滤关键字（变化即重新查询） */
  const [keyword, setKeyword] = useState('');
  /** 可绑定的基础技能标签（主进程固定返回的内置基础技能集合 BUILTIN_EXECUTOR_TASK_TAGS） */
  const [skillTags, setSkillTags] = useState<string[]>([]);

  /** 编辑中的人员的原昵称（null=新增态） */
  const [editingNickname, setEditingNickname] = useState<string | null>(null);
  const [formNickname, setFormNickname] = useState('');
  const [formRoleType, setFormRoleType] = useState(1);
  const [formProfession, setFormProfession] = useState('');
  const [formDuty, setFormDuty] = useState('');
  const [formMultiTask, setFormMultiTask] = useState(true);
  const [formEnabled, setFormEnabled] = useState(true);
  const [formSkillTags, setFormSkillTags] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const loadMembers = useCallback(
    async (nextKeyword: string) => {
      if (!teamApi) {
        antdMessage.error('人员管理接口不可用，请重启应用后重试');
        return;
      }
      setLoading(true);
      try {
        const result = await teamApi.list({ keyword: nextKeyword });
        setMembers(Array.isArray(result?.members) ? result.members : []);
      } catch (error) {
        antdMessage.error(`加载人员列表失败：${toReadableError(error, '未知错误')}`);
      } finally {
        setLoading(false);
      }
    },
    [teamApi, antdMessage],
  );

  const loadSkillTags = useCallback(async () => {
    if (!teamApi) {
      return;
    }
    try {
      const result = await teamApi.listSkillTags();
      setSkillTags(Array.isArray(result?.tags) ? result.tags : []);
    } catch (error) {
      antdMessage.error(`加载基础技能标签失败：${toReadableError(error, '未知错误')}`);
    }
  }, [teamApi, antdMessage]);

  // 挂载即拉取技能标签；关键字变化即重新查询（服务端过滤）
  useEffect(() => {
    void loadSkillTags();
  }, [loadSkillTags]);

  useEffect(() => {
    void loadMembers(keyword);
  }, [keyword, loadMembers]);

  const resetForm = useCallback(() => {
    setEditingNickname(null);
    setFormNickname('');
    setFormRoleType(1);
    setFormProfession('');
    setFormDuty('');
    setFormMultiTask(true);
    setFormEnabled(true);
    setFormSkillTags([]);
  }, []);

  const startCreate = useCallback(() => {
    resetForm();
    // 新建前刷新技能标签选项，保证选项为实时返回值
    void loadSkillTags();
  }, [resetForm, loadSkillTags]);

  const startEdit = useCallback(
    (record: TeamMemberListItem) => {
      setEditingNickname(record.nickname);
      setFormNickname(record.nickname);
      setFormRoleType(typeof record.roleType === 'number' ? record.roleType : 1);
      setFormProfession(record.profession);
      setFormDuty(record.duty);
      setFormMultiTask(record.isMultiTaskParallel);
      setFormEnabled(record.enabled);
      setFormSkillTags(record.skillTags);
      void loadSkillTags();
    },
    [loadSkillTags],
  );

  const confirmDelete = useCallback(
    (record: TeamMemberListItem) => {
      if (!teamApi) {
        antdMessage.error('人员管理接口不可用，请重启应用后重试');
        return;
      }
      antdModal.confirm({
        title: '删除人员',
        content: `将删除人员「${record.nickname}」及其全部基础技能标签绑定（team_members 与 team_member_skills 同时删除），确定删除？`,
        okText: '删除',
        okButtonProps: { danger: true },
        cancelText: '取消',
        onOk: async () => {
          try {
            await teamApi.delete({ nickname: record.nickname });
            antdMessage.success(`人员「${record.nickname}」已删除`);
            if (editingNickname === record.nickname) {
              resetForm();
            }
            await loadMembers(keyword);
          } catch (error) {
            antdMessage.error(`删除失败：${toReadableError(error, '未知错误')}`);
          }
        },
      });
    },
    [teamApi, antdModal, antdMessage, editingNickname, resetForm, loadMembers, keyword],
  );

  const handleSave = useCallback(async () => {
    if (!teamApi) {
      antdMessage.error('人员管理接口不可用，请重启应用后重试');
      return;
    }
    const nickname = formNickname.trim();
    if (!nickname) {
      antdMessage.error('请输入人员昵称');
      return;
    }
    setSaving(true);
    try {
      const payload: TeamMemberPayload = {
        nickname,
        roleType: formRoleType,
        profession: formProfession.trim(),
        duty: formDuty.trim(),
        isMultiTaskParallel: formMultiTask,
        enabled: formEnabled,
        skillTags: formSkillTags,
      };
      if (editingNickname) {
        const result = await teamApi.update({ ...payload, originalNickname: editingNickname });
        antdMessage.success(`人员「${result.member.nickname}」已保存`);
      } else {
        const result = await teamApi.create(payload);
        antdMessage.success(`人员「${result.member.nickname}」已新增`);
      }
      resetForm();
      await loadMembers(keyword);
    } catch (error) {
      antdMessage.error(toReadableError(error, editingNickname ? '保存人员失败' : '新增人员失败'));
    } finally {
      setSaving(false);
    }
  }, [
    teamApi,
    antdMessage,
    formNickname,
    formRoleType,
    formProfession,
    formDuty,
    formMultiTask,
    formEnabled,
    formSkillTags,
    editingNickname,
    resetForm,
    loadMembers,
    keyword,
  ]);

  /** 前端「昵称已存在」预提示（列表受关键字过滤影响，仅提示；最终以主进程事务内查重为准） */
  const nicknameDuplicate = useMemo(() => {
    const nickname = formNickname.trim();
    if (!nickname) {
      return false;
    }
    return members.some(
      (member) => member.nickname === nickname && member.nickname !== editingNickname,
    );
  }, [formNickname, members, editingNickname]);

  /** 技能标签下拉项：主进程选项 + 已选但当前不在选项中的历史标签（保证可见、可移除） */
  const skillTagOptions = useMemo(() => {
    const merged: string[] = [...skillTags];
    for (const tag of formSkillTags) {
      if (!merged.includes(tag)) {
        merged.push(tag);
      }
    }
    return merged.map((tag) => ({ value: tag, label: tag }));
  }, [skillTags, formSkillTags]);

  const columns = useMemo<NonNullable<TableProps<TeamMemberListItem>['columns']>>(
    () => [
      {
        title: '人员昵称',
        dataIndex: 'nickname',
        key: 'nickname',
        width: 132,
        ellipsis: true,
        render: (value: string) => value || '—',
      },
      {
        title: '角色类型',
        dataIndex: 'roleLabel',
        key: 'roleLabel',
        width: 92,
        render: (value: string) => value || '—',
      },
      {
        title: '职业',
        dataIndex: 'profession',
        key: 'profession',
        width: 132,
        ellipsis: true,
        render: (value: string) => value || '—',
      },
      {
        title: '职责',
        dataIndex: 'duty',
        key: 'duty',
        ellipsis: true,
        render: (value: string) => value || '—',
      },
      {
        title: '多任务并行',
        dataIndex: 'isMultiTaskParallel',
        key: 'isMultiTaskParallel',
        width: 100,
        render: (value: boolean) => (value ? '是' : '否'),
      },
      {
        title: '启用状态',
        dataIndex: 'enabled',
        key: 'enabled',
        width: 92,
        render: (value: boolean) => (
          <Tag color={value ? 'success' : 'default'}>{value ? '启用' : '禁用'}</Tag>
        ),
      },
      {
        title: '基础技能标签',
        dataIndex: 'skillTags',
        key: 'skillTags',
        width: 220,
        render: (tags: string[]) =>
          Array.isArray(tags) && tags.length > 0 ? (
            <Flex wrap gap={4}>
              {tags.map((tag) => (
                <Tag key={tag}>{tag}</Tag>
              ))}
            </Flex>
          ) : (
            '—'
          ),
      },
      {
        title: '操作',
        key: 'actions',
        width: 128,
        render: (_value: unknown, record: TeamMemberListItem) => (
          <Flex gap={4}>
            <Button size="small" onClick={() => startEdit(record)}>
              编辑
            </Button>
            <Button size="small" danger onClick={() => confirmDelete(record)}>
              删除
            </Button>
          </Flex>
        ),
      },
    ],
    [startEdit, confirmDelete],
  );

  return (
    <div style={{ padding: 0 }}>
      <Flex justify="space-between" align="center">
        <Typography.Title
          level={5}
          style={{
            marginTop: 0,
            marginBottom: 0,
            fontSize: 16,
            fontWeight: 500,
            color: token.colorText,
          }}
        >
          人员管理
        </Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={startCreate}>
          新增人员
        </Button>
      </Flex>

      <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '4px 0 0' }}>
        维护成员画像与基础技能标签绑定：人员昵称全库唯一（应用层事务内查重），改名后技能标签随新昵称迁移，删除人员同时清空其技能标签。
      </Typography.Paragraph>

      <Divider style={{ margin: '8px 0 12px' }} />

      <Input.Search
        allowClear
        placeholder="按人员昵称或职业关键字过滤"
        value={keywordInput}
        onChange={(event) => {
          const value = event.target.value;
          setKeywordInput(value);
          if (!value) {
            setKeyword('');
          }
        }}
        onSearch={(value) => setKeyword(value.trim())}
      />

      <Table<TeamMemberListItem>
        size="small"
        rowKey="rowId"
        loading={loading}
        columns={columns}
        dataSource={members}
        pagination={false}
        scroll={{ x: 1000 }}
        style={{ marginTop: 12 }}
        locale={{
          emptyText: keyword
            ? `没有匹配「${keyword}」的人员`
            : '暂无人员，请在下方表单新增',
        }}
      />

      <Divider style={{ margin: '16px 0 12px' }} />

      <Flex justify="space-between" align="center">
        <Typography.Text strong>
          {editingNickname ? `编辑人员：${editingNickname}` : '新增人员'}
        </Typography.Text>
        {editingNickname ? (
          <Button size="small" onClick={resetForm}>
            取消编辑
          </Button>
        ) : null}
      </Flex>

      <Flex vertical gap={12} style={{ marginTop: 12 }}>
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            人员昵称（必填，≤32 字符，全库唯一）
          </Typography.Text>
          <Input
            placeholder="如：小周"
            value={formNickname}
            onChange={(event) => setFormNickname(event.target.value)}
            maxLength={32}
            showCount
            status={nicknameDuplicate ? 'error' : undefined}
          />
          {nicknameDuplicate ? (
            <Typography.Paragraph type="danger" style={{ fontSize: 12, margin: '4px 0 0' }}>
              人员昵称「{formNickname.trim()}」已存在，请更换。
            </Typography.Paragraph>
          ) : null}
        </div>

        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            角色类型
          </Typography.Text>
          <div style={{ marginTop: 4 }}>
            <Radio.Group
              value={formRoleType}
              onChange={(event) => setFormRoleType(Number(event.target.value))}
            >
              {ROLE_TYPE_OPTIONS.map((option) => (
                <Radio key={option.value} value={option.value}>
                  {option.label}
                </Radio>
              ))}
            </Radio.Group>
          </div>
        </div>

        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            职业（≤64 字符，可空）
          </Typography.Text>
          <Input
            placeholder="如：前端工程师 / 数据分析师"
            value={formProfession}
            onChange={(event) => setFormProfession(event.target.value)}
            maxLength={64}
            showCount
          />
        </div>

        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            职责（≤500 字符，可空）
          </Typography.Text>
          <Input.TextArea
            placeholder="该成员的职责描述"
            value={formDuty}
            onChange={(event) => setFormDuty(event.target.value)}
            maxLength={500}
            showCount
            autoSize={{ minRows: 2, maxRows: 4 }}
          />
        </div>

        <Flex gap={24} wrap="wrap">
          <Flex align="center" gap={8}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              是否支持多任务并行
            </Typography.Text>
            <Switch
              checked={formMultiTask}
              onChange={setFormMultiTask}
              checkedChildren="是"
              unCheckedChildren="否"
            />
          </Flex>
          <Flex align="center" gap={8}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              启用状态
            </Typography.Text>
            <Switch
              checked={formEnabled}
              onChange={setFormEnabled}
              checkedChildren="启用"
              unCheckedChildren="禁用"
            />
          </Flex>
        </Flex>

        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            基础技能标签（多选，最多 {MAX_SKILL_TAG_COUNT} 个；选项为主进程固定返回的内置基础技能（不含自定义技能））
          </Typography.Text>
          <Select
            mode="multiple"
            allowClear
            style={{ width: '100%', marginTop: 4 }}
            placeholder="选择要绑定的基础技能标签（可留空）"
            value={formSkillTags}
            onChange={(value: string[]) => setFormSkillTags(value)}
            options={skillTagOptions}
            maxTagCount="responsive"
            notFoundContent="暂无可选技能标签"
          />
        </div>

        <Flex justify="flex-end" gap={8}>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => {
              void loadMembers(keyword);
              void loadSkillTags();
            }}
          >
            刷新
          </Button>
          <Button type="primary" loading={saving} onClick={() => void handleSave()}>
            {editingNickname ? '保存修改' : '新增人员'}
          </Button>
        </Flex>
      </Flex>
    </div>
  );
}
