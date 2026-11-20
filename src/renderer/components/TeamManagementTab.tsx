/**
 * TeamManagementTab — 人员管理 Tab 组件（成员增删改查 + 基础技能标签绑定）
 *
 * 功能：
 * - 成员表格：人员昵称 / 角色类型 / 职业 / 职责 / 多任务并行 / 启用状态 / 基础技能标签 / 操作
 * - 关键字过滤：按「人员昵称」或「职业」模糊匹配（主进程参数化 LIKE，服务端过滤）
 * - 新增/编辑弹框：antd Modal 承载表单，昵称、角色类型（中文单选）、职业、职责、
 *   多任务并行开关、启用状态开关、基础技能标签多选（选项=主进程固定返回的内置基础技能集合）
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
  Modal,
  Select,
  Switch,
  Table,
  Tag,
  Typography,
  theme,
} from 'antd';
import type { TableProps } from 'antd';
import { PlusOutlined } from '@ant-design/icons';

/** 人员列表项（字段与主进程 TeamMemberListItem 一一对应） */
interface TeamMemberListItem {
  /** SQLite 隐式 rowid，仅作列表渲染 key */
  rowId: number;
  nickname: string;
  roleType: number | null;
  /** 角色中文：1=执行者、2=审核者、3=研究者、4=实验员、5=设计师 */
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
  list: () => Promise<{ members: TeamMemberListItem[] }>;
  create: (params: TeamMemberPayload) => Promise<{ member: TeamMemberListItem }>;
  update: (params: TeamMemberPayload & { originalNickname: string }) => Promise<{ member: TeamMemberListItem }>;
  delete: (params: { nickname: string }) => Promise<{ nickname: string }>;
  listSkillTags: () => Promise<{ tags: string[] }>;
}

/** 角色类型选项（文案与主进程 TEAM_MEMBER_ROLE_TYPE_LABELS 同源：1=执行者/2=审核者/3=研究者/4=实验员/5=设计师） */
const ROLE_TYPE_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 1, label: '执行者' },
  { value: 2, label: '审核者' },
  { value: 3, label: '研究者' },
  { value: 4, label: '实验员' },
  { value: 5, label: '设计师' },
];

/** 单个人员可绑定的基础技能标签数量上限（与主进程 MAX_TEAM_MEMBER_SKILL_TAG_COUNT 一致） */
const MAX_SKILL_TAG_COUNT = 20;

/** 表格本体最小高度（px）：表头 + 数据区的保底高度，0/1 行数据时表格本体仍是一块完整区域，而不是一条「表头 + 一行」 */
const TABLE_MIN_HEIGHT = 320;

/** 数据区最大高度（px）：数据行超过该高度时在数据区内部纵向滚动、表头常驻（antd 6.6.1 scroll.y 走固定表头形态） */
const TABLE_BODY_MAX_HEIGHT = 400;

/** 表格专属根类名：高度自适应样式只挂在该前缀之下，不触碰任何全局 .ant-* 规则（样式在本文件内注入，不新增 css 文件） */
const TABLE_ROOT_CLASS_NAME = 'team-management-table';

/**
 * 表格高度自适应样式（作用域化，前缀 = 表格专属 rootClassName）：
 * - 固定表头分支下 rc-table 只把 styles.content 用在非固定表头的 .ant-table-content 上，
 *   styles.body.wrapper 又落在 tbody（min-height 对 table-row-group 不生效），因此只能以作用域 CSS 下发；
 * - 容器 flex 纵向：表头定高、数据区 flex:1 撑满 → 表格本体总高 = max(最小高度, 表头高 + 数据行高)；
 * - 数据区仍保留 scroll.y 的 max-height → 内容超过最大高度才在数据区内部滚动，表头不随滚；
 * - 最小高度按内容盒计算（content-box），收边的 1px 线不占用最小高度，表头 + 数据区净高恒不低于最小高度；
 * - 白色表面 + 底部闭合线：最小高度区间内呈现为一块有底色的完整表格区域，不与抽屉底色融为一体。
 */
function buildTeamTableCss(colorBgElevated: string, colorBorderSecondary: string): string {
  return `
.${TABLE_ROOT_CLASS_NAME} .ant-table {
  background: ${colorBgElevated};
}
.${TABLE_ROOT_CLASS_NAME} .ant-table-container {
  display: flex;
  flex-direction: column;
  box-sizing: content-box;
  min-height: ${TABLE_MIN_HEIGHT}px;
  border-bottom: 1px solid ${colorBorderSecondary};
}
.${TABLE_ROOT_CLASS_NAME} .ant-table-body {
  flex: 1 1 auto;
}
.${TABLE_ROOT_CLASS_NAME} .ant-table-tbody .ant-table-placeholder .ant-table-cell {
  border-bottom: 0;
}
.${TABLE_ROOT_CLASS_NAME} .ant-table-thead > tr > th {
  white-space: nowrap;
}
`;
}

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
  const teamTableCss = useMemo(
    () => buildTeamTableCss(token.colorBgElevated, token.colorBorderSecondary),
    [token.colorBgElevated, token.colorBorderSecondary],
  );
  const teamApi = useMemo(
    () => (window as unknown as { electronAPI?: { team?: TeamApi } }).electronAPI?.team,
    [],
  );

  const [members, setMembers] = useState<TeamMemberListItem[]>([]);
  const [loading, setLoading] = useState(false);
  /** 可绑定的基础技能标签（主进程固定返回的内置基础技能集合 BUILTIN_EXECUTOR_TASK_TAGS） */
  const [skillTags, setSkillTags] = useState<string[]>([]);

  /** 新增/编辑弹框是否展开（新增与编辑共用同一弹框） */
  const [formOpen, setFormOpen] = useState(false);

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
    async () => {
      if (!teamApi) {
        antdMessage.error('人员管理接口不可用，请重启应用后重试');
        return;
      }
      setLoading(true);
      try {
        const result = await teamApi.list();
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

  // 挂载即拉取技能标签
  useEffect(() => {
    void loadSkillTags();
  }, [loadSkillTags]);

  // 挂载即拉取人员列表（无关键字过滤，一次性取全量）
  useEffect(() => {
    void loadMembers();
  }, [loadMembers]);

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

  /** 关闭弹框并重置表单（弹框「取消」与保存成功后统一走这里） */
  const closeForm = useCallback(() => {
    setFormOpen(false);
    resetForm();
  }, [resetForm]);

  const startCreate = useCallback(() => {
    resetForm();
    // 新建前刷新技能标签选项，保证选项为实时返回值
    void loadSkillTags();
    setFormOpen(true);
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
      setFormOpen(true);
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
        content: `「${record.nickname}」将被删除，其基础技能标签绑定也会一并移除。确定删除吗？`,
        okText: '删除',
        okButtonProps: { danger: true },
        cancelText: '取消',
        onOk: async () => {
          try {
            await teamApi.delete({ nickname: record.nickname });
            antdMessage.success(`人员「${record.nickname}」已删除`);
            if (editingNickname === record.nickname) {
              closeForm();
            }
            await loadMembers();
          } catch (error) {
            antdMessage.error(`删除失败：${toReadableError(error, '未知错误')}`);
          }
        },
      });
    },
    [teamApi, antdModal, antdMessage, editingNickname, closeForm, loadMembers],
  );

  /**
   * 启停切换（操作列「启用/禁用」超链接）：
   * 主进程 updateTeamMember 用「input?.enabled !== false」判定，缺字段会被重置为「启用」，
   * 因此必须把 nickname / roleType / profession / duty / isMultiTaskParallel / enabled / skillTags / originalNickname
   * 共 8 个字段显式传齐；nickname 与 originalNickname 相同 → 不进入改名查重分支。
   */
  const toggleMemberEnabled = useCallback(
    async (record: TeamMemberListItem) => {
      if (!teamApi) {
        antdMessage.error('人员管理接口不可用，请重启应用后重试');
        return;
      }
      try {
        await teamApi.update({
          nickname: record.nickname,
          roleType: typeof record.roleType === 'number' ? record.roleType : 1,
          profession: record.profession,
          duty: record.duty,
          isMultiTaskParallel: record.isMultiTaskParallel,
          enabled: !record.enabled,
          skillTags: record.skillTags,
          originalNickname: record.nickname,
        });
        antdMessage.success(`人员「${record.nickname}」已${record.enabled ? '禁用' : '启用'}`);
        await loadMembers();
      } catch (error) {
        antdMessage.error(`切换启用状态失败：${toReadableError(error, '未知错误')}`);
      }
    },
    [teamApi, antdMessage, loadMembers],
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
      closeForm();
      await loadMembers();
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
    closeForm,
    loadMembers,
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
        width: 120,
        ellipsis: true,
        render: (value: string) => value || '—',
      },
      {
        title: '角色类型',
        dataIndex: 'roleLabel',
        key: 'roleLabel',
        width: 110,
        align: 'center',
        render: (value: string) => value || '—',
      },
      {
        title: '职业',
        dataIndex: 'profession',
        key: 'profession',
        width: 110,
        ellipsis: true,
        render: (value: string) => value || '—',
      },
      {
        // 唯一不定宽列：其余 7 列按百分比分配后，本列自动吸收容器剩余宽度（长文本列优先给宽度）
        title: '职责',
        dataIndex: 'duty',
        key: 'duty',
        width: 260,
        ellipsis: true,
        render: (value: string) => value || '—',
      },
      {
        title: '多任务并行',
        dataIndex: 'isMultiTaskParallel',
        key: 'isMultiTaskParallel',
        width: 130,
        align: 'center',
        render: (value: boolean) => (value ? '是' : '否'),
      },
      {
        // 状态展示与启停入口合并为同一处：列内 Switch 既表达启用状态，又就地完成切换
        title: '启用状态',
        dataIndex: 'enabled',
        key: 'enabled',
        width: 110,
        align: 'center',
        render: (value: boolean, record: TeamMemberListItem) => (
          <Switch size="small" checked={value} onChange={() => void toggleMemberEnabled(record)} />
        ),
      },
      {
        title: '基础技能标签',
        dataIndex: 'skillTags',
        key: 'skillTags',
        width: 170,
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
        fixed: 'right',
        width: 118,
        render: (_value: unknown, record: TeamMemberListItem) => (
          <Flex gap={4} wrap="nowrap">
            <Button type="link" size="small" onClick={() => startEdit(record)}>
              编辑
            </Button>
            <Button type="link" size="small" danger onClick={() => confirmDelete(record)}>
              删除
            </Button>
          </Flex>
        ),
      },
    ],
    [startEdit, confirmDelete, toggleMemberEnabled],
  );

  return (
    <div style={{ padding: 0 }}>
      <Flex justify="space-between" align="center" gap={12}>
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
        <Flex gap={8} style={{ flexShrink: 0 }}>
          <Button type="primary" icon={<PlusOutlined />} onClick={startCreate}>
            新增人员
          </Button>
        </Flex>
      </Flex>

      <Divider style={{ margin: '12px 0 16px' }} />

      {/* 高度自适应样式：只以表格专属 rootClassName 为前缀，不写全局 .ant-* 规则 */}
      <style>{teamTableCss}</style>

      <Table<TeamMemberListItem>
        size="small"
        rowKey="rowId"
        loading={loading}
        columns={columns}
        dataSource={members}
        pagination={false}
        scroll={{ x: 1128, y: TABLE_BODY_MAX_HEIGHT }}
        rootClassName={TABLE_ROOT_CLASS_NAME}
        style={{ marginTop: 12 }}
        locale={{
          emptyText: (
            <div style={{ padding: '56px 0' }}>暂无人员，请点击右上角「新增人员」添加</div>
          ),
        }}
      />

      <Modal
        open={formOpen}
        title={editingNickname ? `编辑人员：${editingNickname}` : '新增人员'}
        onCancel={closeForm}
        footer={
          <Flex justify="flex-end" gap={8}>
            <Button onClick={closeForm}>取消</Button>
            <Button type="primary" loading={saving} onClick={() => void handleSave()}>
              {editingNickname ? '保存修改' : '新增'}
            </Button>
          </Flex>
        }
      >
        <Flex vertical gap={16}>
          <Flex vertical gap={4}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              <span style={{ color: token.colorError, marginRight: 4 }}>*</span>人员昵称
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
              <Typography.Paragraph type="danger" style={{ fontSize: 12, margin: 0 }}>
                人员昵称「{formNickname.trim()}」已存在，请更换。
              </Typography.Paragraph>
            ) : null}
          </Flex>

          <Flex vertical gap={4}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              角色类型
            </Typography.Text>
            <Select
              value={formRoleType}
              onChange={(value: number) => setFormRoleType(value)}
              options={ROLE_TYPE_OPTIONS}
              style={{ width: '100%' }}
            />
          </Flex>

          <Flex vertical gap={4}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              职业
            </Typography.Text>
            <Input
              placeholder="如：前端工程师 / 数据分析师"
              value={formProfession}
              onChange={(event) => setFormProfession(event.target.value)}
              maxLength={64}
              showCount
            />
          </Flex>

          <Flex vertical gap={4}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              职责
            </Typography.Text>
            <Input.TextArea
              placeholder="该成员的职责描述"
              value={formDuty}
              onChange={(event) => setFormDuty(event.target.value)}
              maxLength={500}
              showCount
              autoSize={{ minRows: 2, maxRows: 4 }}
            />
          </Flex>

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
          </Flex>

          <Flex vertical gap={4}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              基础技能标签
            </Typography.Text>
            <Select
              mode="multiple"
              allowClear
              style={{ width: '100%' }}
              placeholder="选择要绑定的基础技能标签"
              value={formSkillTags}
              onChange={(value: string[]) => setFormSkillTags(value)}
              options={skillTagOptions}
              maxTagCount="responsive"
              notFoundContent="暂无可选技能标签"
            />
          </Flex>
        </Flex>
      </Modal>
    </div>
  );
}
