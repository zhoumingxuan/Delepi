import { getDb } from '../sqlite-adapter';
import { TEAM_MEMBER_ROLE_TYPE_LABELS, type TeamMemberRoleType } from '../../constants';

/** role_type（int 枚举）→ 中文角色文字；NULL 或枚举外取值输出空串 */
function toRoleLabel(roleType: number | null): string {
  if (roleType === null) return '';
  return TEAM_MEMBER_ROLE_TYPE_LABELS[roleType as TeamMemberRoleType] ?? '';
}

const PROFESSION_FALLBACK_TEXT = '（未知，默认根据识别的【专业领域】，自适应切换）';

/** 可委派成员清单（仅启用成员，status 为 NULL 视同启用） */
export function listEnabledTeamMembers(): Array<{
  '人员昵称': string | null;
  '角色类型': string;
  '职业': string;
  '职责': string | null;
  '是否支持多任务并行': boolean;
}> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT nickname, role_type, profession, duty, is_multi_task_parallel
    FROM team_members
    WHERE status = 1 OR status IS NULL
    ORDER BY created_at ASC, nickname ASC
  `).all() as Array<{
    nickname: string | null;
    role_type: number | null;
    profession: string | null;
    duty: string | null;
    is_multi_task_parallel: number | null;
  }>;
  return rows.map((row) => ({
    '人员昵称': row.nickname,
    '角色类型': toRoleLabel(row.role_type),
    '职业': row.profession && row.profession.trim().length > 0 ? row.profession : PROFESSION_FALLBACK_TEXT,
    '职责': row.duty,
    '是否支持多任务并行': row.is_multi_task_parallel === 1,
  }));
}

// ============================================================
// 人员管理（team_members + team_member_skills 读写）
// 本段为新增：上方既有 listEnabledTeamMembers()/toRoleLabel()/PROFESSION_FALLBACK_TEXT 零改动。
// - 昵称唯一：应用层事务内 SELECT 查重（表本身无主键/无索引/无 UNIQUE，禁止新增任何约束）
// - 多语句写入：全部包在 db.transaction 内，保证人员行与技能标签行的原子性
// - updated_at：SQLite 不自动更新，修改时显式写 datetime('now','localtime')
// ============================================================

/** 人员昵称最大长度（字符） */
const MAX_TEAM_MEMBER_NICKNAME_LENGTH = 32;
/** 职业最大长度（字符） */
const MAX_TEAM_MEMBER_PROFESSION_LENGTH = 64;
/** 职责最大长度（字符） */
const MAX_TEAM_MEMBER_DUTY_LENGTH = 500;
/** 单个基础技能标签最大长度（字符） */
const MAX_TEAM_MEMBER_SKILL_TAG_LENGTH = 64;
/** 单个人员可绑定的基础技能标签数量上限 */
const MAX_TEAM_MEMBER_SKILL_TAG_COUNT = 20;

/** 合法角色类型集合（键集与 TEAM_MEMBER_ROLE_TYPE_LABELS 同源，不复制字面量） */
const TEAM_MEMBER_ROLE_TYPE_SET: ReadonlySet<number> = new Set<number>(
  Object.keys(TEAM_MEMBER_ROLE_TYPE_LABELS).map((key) => Number(key)),
);

/** 数据库句柄类型（取自 getDb 返回值，避免额外 import better-sqlite3） */
type SqliteDatabase = ReturnType<typeof getDb>;

/** team_members 原始行（SELECT rowid AS row_id 别名） */
interface TeamMemberRow {
  row_id: number;
  nickname: string | null;
  role_type: number | null;
  profession: string | null;
  duty: string | null;
  is_multi_task_parallel: number | null;
  status: number | null;
  created_at: string | null;
  updated_at: string | null;
}

/** 人员管理：列表项（成员画像 + 基础技能标签聚合） */
export interface TeamMemberListItem {
  /** SQLite 隐式 rowid（仅作列表渲染 key，不新增列、不落业务语义） */
  rowId: number;
  nickname: string;
  roleType: number | null;
  /** 角色中文：1=执行者、2=审核者、3=研究者、4=实验员、5=设计师；NULL 或枚举外为空串 */
  roleLabel: string;
  profession: string;
  duty: string;
  isMultiTaskParallel: boolean;
  /** 原始 status（1=启用、0=禁用、NULL=启用） */
  status: number | null;
  /** status 语义：1 或 NULL 视为启用 */
  enabled: boolean;
  skillTags: string[];
  createdAt: string | null;
  updatedAt: string | null;
}

/** 人员管理：新增入参（skillTags 省略等价空集合） */
export interface TeamMemberInput {
  nickname: string;
  roleType: number;
  profession?: string | null;
  duty?: string | null;
  isMultiTaskParallel?: boolean;
  enabled?: boolean;
  skillTags?: string[];
}

/** 人员管理：修改入参（originalNickname 定位待改行，nickname 为新昵称；skillTags 省略=不改动既有绑定） */
export interface TeamMemberUpdateInput extends TeamMemberInput {
  originalNickname: string;
}

/** 必填昵称归一 + 校验 */
function normalizeNickname(value: unknown): string {
  const nickname = typeof value === 'string' ? value.trim() : '';
  if (!nickname) {
    throw new Error('人员昵称不能为空');
  }
  if (nickname.length > MAX_TEAM_MEMBER_NICKNAME_LENGTH) {
    throw new Error(`人员昵称长度不能超过 ${MAX_TEAM_MEMBER_NICKNAME_LENGTH} 个字符`);
  }
  return nickname;
}

/** 角色类型校验（仅允许 TEAM_MEMBER_ROLE_TYPE_LABELS 的键） */
function normalizeRoleType(value: unknown): number {
  const roleType = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(roleType) || !TEAM_MEMBER_ROLE_TYPE_SET.has(roleType)) {
    throw new Error('角色类型取值非法：仅支持 1=执行者、2=审核者、3=研究者、4=实验员、5=设计师');
  }
  return roleType;
}

/** 可选文本归一：trim 后为空写 NULL，超长抛错 */
function normalizeOptionalText(value: unknown, maxLength: number, label: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`${label}必须是文本`);
  }
  const text = value.trim();
  if (!text) {
    return null;
  }
  if (text.length > maxLength) {
    throw new Error(`${label}长度不能超过 ${maxLength} 个字符`);
  }
  return text;
}

/** 技能标签归一：trim、去空、去重，并校验单项长度与数量上限 */
function normalizeSkillTags(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error('基础技能标签必须是字符串数组');
  }
  const tags: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new Error('基础技能标签必须是字符串数组');
    }
    const tag = item.trim();
    if (!tag) {
      continue;
    }
    if (tag.length > MAX_TEAM_MEMBER_SKILL_TAG_LENGTH) {
      throw new Error(`基础技能标签「${tag}」长度不能超过 ${MAX_TEAM_MEMBER_SKILL_TAG_LENGTH} 个字符`);
    }
    if (!tags.includes(tag)) {
      tags.push(tag);
    }
  }
  if (tags.length > MAX_TEAM_MEMBER_SKILL_TAG_COUNT) {
    throw new Error(`基础技能标签最多绑定 ${MAX_TEAM_MEMBER_SKILL_TAG_COUNT} 个`);
  }
  return tags;
}

/** LIKE 通配符转义（% _ \ 按字面匹配；配套 SQL 使用 ESCAPE '\'） */
function escapeLikePattern(keyword: string): string {
  return keyword.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** 读取指定昵称当前绑定的技能标签（按写入顺序稳定排序） */
function readSkillTagsByNickname(db: SqliteDatabase, nickname: string): string[] {
  const rows = db.prepare(`
    SELECT skill_tag
    FROM team_member_skills
    WHERE nickname = ?
    ORDER BY created_at ASC, rowid ASC
  `).all(nickname) as Array<{ skill_tag: string | null }>;
  const tags: string[] = [];
  for (const row of rows) {
    const tag = typeof row.skill_tag === 'string' ? row.skill_tag : '';
    if (tag) {
      tags.push(tag);
    }
  }
  return tags;
}

/** 原始行 → 列表项 */
function toTeamMemberListItem(row: TeamMemberRow, skillTags: string[]): TeamMemberListItem {
  const status = typeof row.status === 'number' ? row.status : null;
  return {
    rowId: row.row_id,
    nickname: typeof row.nickname === 'string' ? row.nickname : '',
    roleType: row.role_type,
    roleLabel: toRoleLabel(row.role_type),
    profession: typeof row.profession === 'string' ? row.profession : '',
    duty: typeof row.duty === 'string' ? row.duty : '',
    isMultiTaskParallel: row.is_multi_task_parallel === 1,
    status,
    enabled: status === null || status === 1,
    skillTags,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 人员列表（含禁用成员）：keyword 命中「人员昵称」或「职业」即保留，空关键字返回全部。
 * 技能标签一次全表读取后在内存聚合（团队表规模小且禁止建索引），避免按行 N+1 查询。
 */
export function listTeamMembers(keyword?: string): TeamMemberListItem[] {
  const db = getDb();
  const rawKeyword = typeof keyword === 'string' ? keyword.trim() : '';
  const hasKeyword = rawKeyword.length > 0;
  // WHERE 片段为固定字符串，用户输入仅经 ? 占位符绑定（禁字符串拼接用户输入）
  const whereSql = hasKeyword
    ? `WHERE (nickname LIKE ? ESCAPE '\\' OR profession LIKE ? ESCAPE '\\')`
    : '';
  const params: string[] = hasKeyword
    ? [`%${escapeLikePattern(rawKeyword)}%`, `%${escapeLikePattern(rawKeyword)}%`]
    : [];

  const rows = db.prepare(`
    SELECT rowid AS row_id, nickname, role_type, profession, duty, is_multi_task_parallel, status, created_at, updated_at
    FROM team_members
    ${whereSql}
    ORDER BY created_at ASC, rowid ASC
  `).all(...params) as TeamMemberRow[];

  const skillRows = db.prepare(`
    SELECT nickname, skill_tag
    FROM team_member_skills
    ORDER BY created_at ASC, rowid ASC
  `).all() as Array<{ nickname: string | null; skill_tag: string | null }>;
  const skillMap = new Map<string, string[]>();
  for (const skillRow of skillRows) {
    const owner = typeof skillRow.nickname === 'string' ? skillRow.nickname : '';
    const tag = typeof skillRow.skill_tag === 'string' ? skillRow.skill_tag : '';
    if (!owner || !tag) {
      continue;
    }
    const bucket = skillMap.get(owner);
    if (bucket) {
      bucket.push(tag);
    } else {
      skillMap.set(owner, [tag]);
    }
  }

  return rows.map((row) => {
    const nickname = typeof row.nickname === 'string' ? row.nickname : '';
    return toTeamMemberListItem(row, skillMap.get(nickname) ?? []);
  });
}

/** 按昵称读取单个成员（含技能标签）；不存在返回 null */
export function getTeamMemberByNickname(nickname: string): TeamMemberListItem | null {
  const db = getDb();
  const target = typeof nickname === 'string' ? nickname.trim() : '';
  if (!target) {
    return null;
  }
  const row = db.prepare(`
    SELECT rowid AS row_id, nickname, role_type, profession, duty, is_multi_task_parallel, status, created_at, updated_at
    FROM team_members
    WHERE nickname = ?
    ORDER BY rowid ASC
    LIMIT 1
  `).get(target) as TeamMemberRow | undefined;
  if (!row) {
    return null;
  }
  return toTeamMemberListItem(row, readSkillTagsByNickname(db, target));
}

/**
 * 新增人员（含基础技能标签绑定）：整段在 db.transaction 内执行。
 * 昵称唯一在应用层保证：事务内 SELECT 查重，命中即抛中文错误（不依赖数据库唯一约束）。
 * 默认值：is_multi_task_parallel=1（是）、status=1（启用）。
 */
export function createTeamMember(input: TeamMemberInput): TeamMemberListItem {
  const db = getDb();
  const nickname = normalizeNickname(input?.nickname);
  const roleType = normalizeRoleType(input?.roleType);
  const profession = normalizeOptionalText(input?.profession, MAX_TEAM_MEMBER_PROFESSION_LENGTH, '职业');
  const duty = normalizeOptionalText(input?.duty, MAX_TEAM_MEMBER_DUTY_LENGTH, '职责');
  const isMultiTaskParallel = input?.isMultiTaskParallel !== false;
  const enabled = input?.enabled !== false;
  const skillTags = normalizeSkillTags(input?.skillTags);

  const create = db.transaction(() => {
    const existing = db.prepare(
      'SELECT nickname FROM team_members WHERE nickname = ? LIMIT 1'
    ).get(nickname) as { nickname: string | null } | undefined;
    if (existing) {
      throw new Error(`人员昵称「${nickname}」已存在，请更换`);
    }

    db.prepare(`
      INSERT INTO team_members (nickname, role_type, profession, duty, is_multi_task_parallel, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))
    `).run(nickname, roleType, profession, duty, isMultiTaskParallel ? 1 : 0, enabled ? 1 : 0);

    const insertSkill = db.prepare(`
      INSERT INTO team_member_skills (nickname, skill_tag, created_at)
      VALUES (?, ?, datetime('now','localtime'))
    `);
    for (const tag of skillTags) {
      insertSkill.run(nickname, tag);
    }
  });
  create();

  const created = getTeamMemberByNickname(nickname);
  if (!created) {
    throw new Error(`人员「${nickname}」新增后回读失败`);
  }
  return created;
}

/**
 * 修改人员（含改名与技能标签覆盖）：整段在 db.transaction 内执行。
 * - 改名：事务内查重（新昵称已存在即抛中文错误）
 * - updated_at：显式写 datetime('now','localtime')
 * - 技能标签：按「最终集合」重写；改名时旧昵称行必然清空、新昵称行先清后写 → 全表无旧昵称孤儿行
 */
export function updateTeamMember(input: TeamMemberUpdateInput): TeamMemberListItem {
  const db = getDb();
  const originalNickname = typeof input?.originalNickname === 'string' ? input.originalNickname.trim() : '';
  if (!originalNickname) {
    throw new Error('待修改人员的原昵称不能为空');
  }
  const nickname = normalizeNickname(input?.nickname);
  const roleType = normalizeRoleType(input?.roleType);
  const profession = normalizeOptionalText(input?.profession, MAX_TEAM_MEMBER_PROFESSION_LENGTH, '职业');
  const duty = normalizeOptionalText(input?.duty, MAX_TEAM_MEMBER_DUTY_LENGTH, '职责');
  const isMultiTaskParallel = input?.isMultiTaskParallel !== false;
  const enabled = input?.enabled !== false;
  const skillTagsProvided = Array.isArray(input?.skillTags);

  const update = db.transaction(() => {
    const current = db.prepare(
      'SELECT nickname FROM team_members WHERE nickname = ? LIMIT 1'
    ).get(originalNickname) as { nickname: string | null } | undefined;
    if (!current) {
      throw new Error(`人员「${originalNickname}」不存在或已被删除`);
    }
    const renaming = nickname !== originalNickname;
    if (renaming) {
      const conflict = db.prepare(
        'SELECT nickname FROM team_members WHERE nickname = ? LIMIT 1'
      ).get(nickname) as { nickname: string | null } | undefined;
      if (conflict) {
        throw new Error(`人员昵称「${nickname}」已存在，请更换`);
      }
    }

    db.prepare(`
      UPDATE team_members
      SET nickname = ?, role_type = ?, profession = ?, duty = ?, is_multi_task_parallel = ?, status = ?, updated_at = datetime('now','localtime')
      WHERE nickname = ?
    `).run(nickname, roleType, profession, duty, isMultiTaskParallel ? 1 : 0, enabled ? 1 : 0, originalNickname);

    // 技能标签重写：未传 skillTags 时沿用旧集合（读取必须在旧昵称行删除之前）
    const effectiveTags = skillTagsProvided ? normalizeSkillTags(input?.skillTags) : readSkillTagsByNickname(db, originalNickname);
    db.prepare('DELETE FROM team_member_skills WHERE nickname = ?').run(originalNickname);
    if (renaming) {
      db.prepare('DELETE FROM team_member_skills WHERE nickname = ?').run(nickname);
    }
    const insertSkill = db.prepare(`
      INSERT INTO team_member_skills (nickname, skill_tag, created_at)
      VALUES (?, ?, datetime('now','localtime'))
    `);
    for (const tag of effectiveTags) {
      insertSkill.run(nickname, tag);
    }
  });
  update();

  const updated = getTeamMemberByNickname(nickname);
  if (!updated) {
    throw new Error(`人员「${nickname}」修改后回读失败`);
  }
  return updated;
}

/**
 * 删除人员：整段在 db.transaction 内执行，team_members 与 team_member_skills 同昵称行一并删除。
 * 人员不存在时抛中文错误（避免静默无效删除）。
 */
export function deleteTeamMember(nickname: string): string {
  const db = getDb();
  const target = typeof nickname === 'string' ? nickname.trim() : '';
  if (!target) {
    throw new Error('待删除人员的昵称不能为空');
  }
  const remove = db.transaction(() => {
    const existing = db.prepare(
      'SELECT nickname FROM team_members WHERE nickname = ? LIMIT 1'
    ).get(target) as { nickname: string | null } | undefined;
    if (!existing) {
      throw new Error(`人员「${target}」不存在或已被删除`);
    }
    db.prepare('DELETE FROM team_members WHERE nickname = ?').run(target);
    db.prepare('DELETE FROM team_member_skills WHERE nickname = ?').run(target);
  });
  remove();
  return target;
}
