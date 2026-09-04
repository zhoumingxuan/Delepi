/**
 * ExecutorRecordDrawer —— 任务执行记录固定 dock 右栏（新版设计方案 M8 / §6.2 / §6.4 视觉规格）
 *
 * 择型：固定 dock 布局列（非 antd Drawer / 非 Modal）——常驻观察面需与消息流同时可读；
 * 宽度 clamp(280px, 26vw, 400px)、高度 100dvh、borderLeft 1px colorBorderSecondary，
 * 展开动效 width 200ms ease-out + overflow:hidden（挂载后 0→目标宽过渡）。
 *
 * 结构：
 * - 标题区（48px）：任务名（14px/600 省略号）+ 状态 Tag + CloseOutlined 关闭钮（28×28）；
 * - 时间线滚动区：左侧 2px colorSplit 轨道 + 8px 状态圆点；思考条目（头部"思考 #seq · HH:mm:ss"
 *   12px colorTextTertiary，running 补"思考中"徽标与圆点高亮；正文 13px/22px/colorText：running
 *   纯文本 pre-wrap+闪烁光标，completed 经 RichMarkdown 渲染、折叠按渲染后高度（132px 裁切）判定）；工具条目（ToolOutlined + displayName + 三态徽标：
 *   执行中 LoadingOutlined colorPrimary / 已完成 CheckCircleFilled colorSuccess /
 *   失败 CloseCircleFilled colorError；行点击展开 argsPreview/resultPreview 全文——JSON
 *   感知 markdown 渲染（JSON → ```json 代码块，对齐 ChatMessageContent.renderToolResultContent
 *   先例与 RichMarkdown）、colorFillQuaternary 背景块 max-height 200px 滚动上限）；
 * - 滚动跟随：贴底/恢复阈值 24px（对齐 ThinkingBlock FOLLOW_TAIL_RESUME_PX 先例），
 *   跟随期自动到底（behavior:auto）、暂停期悬浮"回到最新"胶囊；滚动事件 rAF 合帧；
 * - 条目追加动效：key={seq} 160ms cubic-bezier(0.4,0,0.2,1) 淡入 + translateY(4px→0)；
 * - 归档空态（hasRecords=false）：居中"任务记录已随本轮结束归档"（13px secondary），
 *   标题区保留任务名+终态 Tag，关闭按钮可用。
 *
 * 全部色值经 theme.useToken() 引用（禁硬编码）；纯只读面板——无任何输入控件（§1.2-A）。
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import { Button, Tag, Typography, theme } from 'antd';
import {
  CheckCircleFilled,
  CloseCircleFilled,
  CloseOutlined,
  LoadingOutlined,
  ProfileOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import type {
  ExecutorRecordEntry,
  ExecutorTaskRecordStatus,
  ExecutorThinkingRecord,
  ExecutorToolRecord,
} from '@shared/types/executor-record';
import type { ExecutorTaskView } from '../lib/executor-record-messages';
import { RichMarkdown } from './RichMarkdown';

/** 贴底/恢复阈值（px）——对齐 ThinkingBlock FOLLOW_TAIL_RESUME_PX=24 先例 */
const FOLLOW_TAIL_THRESHOLD_PX = 24;
/** 思考正文折叠态可视高度上限（px）：completed 折叠判定阈值与折叠态 maxHeight 同源（132px hidden） */
const THINKING_COLLAPSED_MAX_HEIGHT_PX = 132;
/** 思考正文折叠判定行数（仅 running 纯文本态使用，与 22px 行高线性对应；completed 态按渲染后实际高度判定，见 ThinkingRecordItem） */
const THINKING_COLLAPSE_LINES = 6;
/** 思考正文展开后滚动上限（px）：展开态/不可折叠态 maxHeight 上限（240px auto），高度按内容自适应 */
const THINKING_EXPANDED_MAX_HEIGHT_PX = 240;
/** 工具预览展开区滚动上限（px） */
const TOOL_PREVIEW_MAX_HEIGHT_PX = 200;
/** dock 展开/条目动效 keyframes（scoped 类名，嵌入组件内） */
const PANEL_KEYFRAMES = `@keyframes executor-record-entry-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes executor-record-cursor-blink {
  0% { opacity: 1; }
  50% { opacity: 0; }
  100% { opacity: 1; }
}`;

/**
 * completed 思考正文 markdown 局部样式作用域（仅 .thinking-md-scope 后代生效，不影响同文件工具预览等其它 RichMarkdown 使用点）：
 * - .x-markdown-light 主题会把 --font-size/--text-color 覆写为 14px/固定暗色（@ant-design/x-markdown themes/light.css），
 *   故需以更高特异性作用域选择器在 .x-markdown 顶层覆写回 13px / colorText / line-height 22px；
 * - colorText 为 antd 运行时 token，静态 CSS 无法引用，经包裹层内联注入 CSS 变量 --thinking-md-text-color 后由本规则透传；
 * - --margin-block 收敛为 6px 段距，贴近原 pre-wrap 连续行观感；
 * - 本规则不含任何 keyframes/animation/transition（防闪与动画红线：不新增动画类声明）。
 */
const THINKING_MARKDOWN_SCOPE_CSS = `
.thinking-md-scope .x-markdown {
  --font-size: 13px;
  --text-color: var(--thinking-md-text-color, inherit);
  --margin-block: 0 0 6px 0;
  line-height: 22px;
  width: 100%;
}
`;

function formatEntryClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '--:--:--';
  }
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** JSON 字符串判定（实现与 ChatMessageContent / ToolCallCard 同名先例一致） */
function isJsonString(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

/** JSON 美化（解析失败原样返回） */
function prettyJsonString(value: string): string {
  if (!value) return value;
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

/** 工具预览 markdown 感知内容（对齐 ChatMessageContent.renderToolResultContent 先例）：JSON → ```json 代码块，否则原文本 */
function renderToolPreviewMarkdown(value: string): string {
  if (isJsonString(value)) {
    return ['```json', prettyJsonString(value), '```'].join('\n');
  }
  return value;
}

function statusTagOf(status: ExecutorTaskRecordStatus): ReactElement {
  if (status === 'completed') {
    return <Tag color="success">已完成</Tag>;
  }
  if (status === 'failed') {
    return <Tag color="error">失败</Tag>;
  }
  if (status === 'aborted') {
    return <Tag>已取消</Tag>;
  }
  return <Tag color="processing">执行中</Tag>;
}

/** 思考条目（内聚子组件，不外泄）
 *
 * - running：正文保持现状纯文本 pre-wrap + 尾部闪烁光标（方案甲锁定：流式草稿约每 200ms 更新一次，
 *   不做 markdown 渲染以规避每 delta 全量 parse）；折叠判定沿用"非空行数 > THINKING_COLLAPSE_LINES"（纯文本行高 22px 线性对应）。
 * - completed：seal 后文本冻结，正文一次性经 RichMarkdown 渲染（content=record.text，复用同文件工具预览先例 262/270）；
 *   折叠判定改按"渲染后实际高度 > THINKING_COLLAPSED_MAX_HEIGHT_PX(132px)"（markdown DOM 高度与文本行数不再线性对应），
 *   实测内容确被 maxHeight(132px) 裁切时才展示"展开全文"入口，杜绝"被裁切却无入口 / 短内容出现无入口滚动条"两种历史缺陷形态。
 * - 折叠视觉语义两态共用常量：可折叠且未展开 → 132px hidden；展开态/不可折叠 → 240px auto 上限且高度按内容自适应。
 * - 状态切换（seal running→completed）为一次性 DOM 结构替换，无新增动画/闪烁；结束态"思考中"徽标/高亮圆点零残留由 running 条件渲染保证。
 */
function ThinkingRecordItem(options: { record: ExecutorThinkingRecord }): ReactElement {
  const { record } = options;
  const { token } = theme.useToken();
  const running = record.status === 'running';
  const [expanded, setExpanded] = useState(false);

  /** running 折叠判定（现状语义保留）：按换行符切分后的非空行数 */
  const lineCount = useMemo(
    () => record.text.split('\n').filter((line) => line.trim().length > 0).length,
    [record.text],
  );
  const textCollapsible = lineCount > THINKING_COLLAPSE_LINES;

  /** completed 折叠判定（markdown 渲染后实际高度测量）：
   *  - mdClamped === null：测量未完成。首帧保守按"可折叠 + 折叠态(132px)"渲染——内容高 ≤132px 时
   *    132px hidden 与 240px auto 视觉一致（均不裁切且无滚动条）；useLayoutEffect 在浏览器 paint 前
   *    完成测量并同步收敛，无可见跳变/闪烁；
   *  - mdClamped === true：实测内容高 > 132px，折叠态确实裁切内容 → 显示"展开全文"入口；
   *  - mdClamped === false：内容高 ≤ 132px，无裁切 → 无展开入口，容器取 240px auto 上限（内容不足不出现滚动条）。 */
  const mdMeasureRef = useRef<HTMLDivElement | null>(null);
  const [mdClamped, setMdClamped] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    if (running) return;
    const el = mdMeasureRef.current;
    if (!el) return;
    const measure = () => {
      // 测量层不设高度约束（不受外层 132/240 maxHeight 裁切影响），clientHeight 即 markdown 实际渲染高度；
      // ResizeObserver 持续跟踪重测：右栏宽度随视口变化导致换行、mermaid/echarts 懒加载异步增高均会触发。
      setMdClamped(el.clientHeight > THINKING_COLLAPSED_MAX_HEIGHT_PX);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [running, record.text]);

  const collapsible = running ? textCollapsible : mdClamped === null ? true : mdClamped;
  const collapsed = collapsible && !expanded;
  /** "展开全文/收起全文"入口显示条件：running 沿用行数判定（现状）；completed 仅当实测确被 132px 裁切（测量完成前不显示，防首帧闪现） */
  const showCollapseToggle = running ? textCollapsible : mdClamped === true;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      {/* 头部行：思考 #seq · HH:mm:ss；running 时行尾"思考中"徽标（对齐工具条目"执行中"徽标体系），completed 分支零残留 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          minWidth: 0,
          fontSize: 12,
          lineHeight: '18px',
          color: token.colorTextTertiary,
        }}
      >
        <span style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', minWidth: 0 }}>
          思考 #{record.seq} · {formatEntryClock(record.startedAt)}
        </span>
        {running ? (
          <span
            style={{
              marginLeft: 'auto',
              flexShrink: 0,
              fontSize: 12,
              color: token.colorPrimary,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <LoadingOutlined spin style={{ fontSize: 12, color: token.colorPrimary }} />
            思考中
          </span>
        ) : null}
      </div>
      {running ? (
        /* running：正文保持现状纯文本 pre-wrap + 闪烁光标（方案甲锁定，禁止对 running 草稿引入 RichMarkdown） */
        <div
          style={{
            fontSize: 13,
            lineHeight: '22px',
            color: token.colorText,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: collapsed ? THINKING_COLLAPSED_MAX_HEIGHT_PX : THINKING_EXPANDED_MAX_HEIGHT_PX,
            overflowY: collapsed ? 'hidden' : 'auto',
          }}
        >
          {record.text}
          <span
            aria-hidden
            style={{
              display: 'inline-block',
              width: 2,
              height: 14,
              marginLeft: 2,
              verticalAlign: 'text-bottom',
              background: token.colorPrimary,
              animation: 'executor-record-cursor-blink 800ms steps(2, start) infinite',
            }}
          />
        </div>
      ) : (
        /* completed：正文经 RichMarkdown 一次性渲染（文本冻结，parse 仅一次）；外层裁切/滚动容器，
           内层测量层无高度约束（供折叠判定与 ResizeObserver 持续测量） */
        <div
          className="thinking-md-scope"
          style={
            {
              fontSize: 13,
              lineHeight: '22px',
              color: token.colorText,
              wordBreak: 'break-word',
              maxHeight: collapsed ? THINKING_COLLAPSED_MAX_HEIGHT_PX : THINKING_EXPANDED_MAX_HEIGHT_PX,
              overflowY: collapsed ? 'hidden' : 'auto',
              '--thinking-md-text-color': token.colorText,
            } as CSSProperties
          }
        >
          <div ref={mdMeasureRef} style={{ minWidth: 0 }}>
            <RichMarkdown content={record.text} />
          </div>
        </div>
      )}
      {showCollapseToggle ? (
        <Button
          type="link"
          size="small"
          onClick={() => setExpanded((current) => !current)}
          style={{ alignSelf: 'flex-start', height: 'auto', padding: 0, fontSize: 12, color: token.colorLink }}
        >
          {expanded ? '收起全文' : '展开全文'}
        </Button>
      ) : null}
    </div>
  );
}
/** 工具条目（内聚子组件，不外泄） */
function ToolRecordItem(options: { record: ExecutorToolRecord }): ReactElement {
  const { record } = options;
  const { token } = theme.useToken();
  const [expanded, setExpanded] = useState(false);

  const badge = record.status === 'running' ? (
    <span style={{ fontSize: 12, color: token.colorPrimary, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <LoadingOutlined spin style={{ fontSize: 12, color: token.colorPrimary }} />
      执行中
    </span>
  ) : record.status === 'completed' ? (
    <span style={{ fontSize: 12, color: token.colorSuccess, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <CheckCircleFilled style={{ fontSize: 12, color: token.colorSuccess }} />
      已完成
    </span>
  ) : (
    <span style={{ fontSize: 12, color: token.colorError, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <CloseCircleFilled style={{ fontSize: 12, color: token.colorError }} />
      失败
    </span>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setExpanded((current) => !current);
          }
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          minWidth: 0,
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <ToolOutlined style={{ fontSize: 12, color: token.colorTextTertiary, flexShrink: 0 }} />
        <span
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: token.colorText,
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
            minWidth: 0,
          }}
        >
          {record.displayName || record.name}
        </span>
        <span style={{ fontSize: 12, color: token.colorTextTertiary, flexShrink: 0 }}>
          #{record.seq} · {formatEntryClock(record.startedAt)}
        </span>
        <span style={{ marginLeft: 'auto', flexShrink: 0 }}>{badge}</span>
      </div>
      {expanded ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            fontFamily: "'Segoe UI', monospace",
            fontSize: 12,
            lineHeight: '18px',
            background: token.colorFillQuaternary,
            borderRadius: token.borderRadiusSM,
            padding: 8,
            maxHeight: TOOL_PREVIEW_MAX_HEIGHT_PX,
            overflowY: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {record.argsPreview ? (
            <div>
              <div style={{ color: token.colorTextTertiary }}>参数</div>
              <div style={{ color: token.colorText, minWidth: 0 }}>
                <RichMarkdown content={renderToolPreviewMarkdown(record.argsPreview)} />
              </div>
            </div>
          ) : null}
          {record.resultPreview ? (
            <div>
              <div style={{ color: token.colorTextTertiary }}>结果</div>
              <div style={{ color: token.colorText, minWidth: 0 }}>
                <RichMarkdown content={renderToolPreviewMarkdown(record.resultPreview)} />
              </div>
            </div>
          ) : null}
          {!record.argsPreview && !record.resultPreview ? (
            <div style={{ color: token.colorTextTertiary }}>（无参数/结果预览）</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ExecutorRecordDrawer(options: {
  taskView: ExecutorTaskView;
  onClose: () => void;
}): ReactElement {
  const { taskView, onClose } = options;
  const { token } = theme.useToken();

  /** dock 展开动效：挂载后 0 → 目标宽（width 200ms ease-out + overflow hidden） */
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setExpanded(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followingRef = useRef(true);
  const [showBackToLatest, setShowBackToLatest] = useState(false);
  const scrollRafRef = useRef<number | null>(null);

  /** 滚动判定 rAF 合帧（对齐 ChatArea P05 模式） */
  const evaluateFollowState = useCallback(() => {
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const el = scrollRef.current;
      if (!el) return;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_TAIL_THRESHOLD_PX;
      followingRef.current = atBottom;
      setShowBackToLatest(!atBottom);
    });
  }, []);

  useEffect(
    () => () => {
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    },
    [],
  );

  /** 内容变化：贴底跟随（behavior:auto，运行中不做平滑滚动防抖动） */
  useEffect(() => {
    if (followingRef.current) {
      const el = scrollRef.current;
      if (el) {
        el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
      }
    }
    evaluateFollowState();
  }, [taskView.entries, evaluateFollowState]);

  const scrollToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
    }
    followingRef.current = true;
    setShowBackToLatest(false);
  }, []);

  const entries: ExecutorRecordEntry[] = taskView.entries ?? [];

  return (
    <div
      style={{
        width: expanded ? 'clamp(280px, 26vw, 400px)' : 0,
        height: '100dvh',
        minHeight: 0,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        borderLeft: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgContainer,
        transition: 'width 200ms ease-out',
      }}
    >
      <style>{PANEL_KEYFRAMES}{THINKING_MARKDOWN_SCOPE_CSS}</style>
      {/* 标题区（48px）：任务名 + 状态 Tag + 关闭钮 */}
      <div
        style={{
          height: 48,
          minHeight: 48,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 12px',
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          flexShrink: 0,
        }}
      >
        <ProfileOutlined style={{ fontSize: 14, color: token.colorTextTertiary, flexShrink: 0 }} />
        <span
          title={taskView.taskName || '子智能体任务'}
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: token.colorText,
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
            minWidth: 0,
            flex: 1,
          }}
        >
          {taskView.taskName || '子智能体任务'}
        </span>
        {statusTagOf(taskView.status)}
        <Button
          type="text"
          size="small"
          icon={<CloseOutlined style={{ fontSize: 14 }} />}
          aria-label="关闭任务执行记录"
          title="关闭任务执行记录"
          onClick={onClose}
          style={{
            width: 28,
            height: 28,
            minWidth: 28,
            flexShrink: 0,
            padding: 0,
            color: token.colorTextTertiary,
          }}
        />
      </div>

      {/* 时间线滚动区 */}
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <div
          ref={scrollRef}
          onScroll={evaluateFollowState}
          style={{
            position: 'absolute',
            inset: 0,
            overflowY: 'auto',
            overscrollBehavior: 'contain',
            padding: '12px 16px',
          }}
        >
          {!taskView.hasRecords ? (
            <div
              style={{
                height: '100%',
                minHeight: 160,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                任务记录已随本轮结束归档
              </Typography.Text>
            </div>
          ) : entries.length === 0 ? (
            <div
              style={{
                height: '100%',
                minHeight: 160,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                {taskView.status === 'aborted' ? '任务已取消，暂无执行记录' : '暂无执行记录'}
              </Typography.Text>
            </div>
          ) : (
            <div style={{ position: 'relative', paddingLeft: 16 }}>
              {/* 时间线轨道：2px 竖线 */}
              <div
                aria-hidden
                style={{
                  position: 'absolute',
                  left: 3,
                  top: 4,
                  bottom: 4,
                  width: 2,
                  background: token.colorSplit,
                }}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {entries.map((entry) => {
                  const dotColor =
                    entry.kind === 'thinking'
                      ? entry.status === 'running'
                        ? token.colorPrimary
                        : token.colorTextQuaternary
                      : entry.status === 'running'
                        ? token.colorPrimary
                        : entry.status === 'completed'
                          ? token.colorSuccess
                          : token.colorError;
                  return (
                    <div
                      key={entry.seq}
                      style={{
                        position: 'relative',
                        animation: 'executor-record-entry-in 160ms cubic-bezier(0.4, 0, 0.2, 1)',
                      }}
                    >
                      {/* 8px 状态圆点 */}
                      <span
                        aria-hidden
                        style={{
                          position: 'absolute',
                          left: -16,
                          top: 5,
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          background: dotColor,
                        }}
                      />
                      {entry.kind === 'thinking' ? (
                        <ThinkingRecordItem record={entry} />
                      ) : (
                        <ToolRecordItem record={entry} />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* 暂停跟随期"回到最新"胶囊 */}
        {showBackToLatest && taskView.hasRecords ? (
          <Button
            size="small"
            onClick={scrollToLatest}
            style={{
              position: 'absolute',
              left: '50%',
              transform: 'translateX(-50%)',
              bottom: 12,
              height: 24,
              fontSize: 12,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '0 10px',
              borderRadius: 12,
              background: token.colorBgContainer,
              border: `1px solid ${token.colorBorderSecondary}`,
              boxShadow: token.boxShadowTertiary,
            }}
          >
            ↓ 回到最新
          </Button>
        ) : null}
      </div>
    </div>
  );
}
