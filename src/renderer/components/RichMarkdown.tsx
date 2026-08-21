/**
 * RichMarkdown 组件
 * Markdown渲染 + 代码高亮(Prism.js One Dark) + Mermaid流程图
 * + ECharts图表 + LaTeX公式 + 思考链
 */

import { message } from 'antd';
import {
  Actions,
  CodeHighlighter,
  Mermaid,
} from '@ant-design/x';
import { XMarkdown } from '@ant-design/x-markdown';
import oneDark from 'react-syntax-highlighter/dist/esm/styles/prism/one-dark';
import {
  CheckOutlined,
  CopyOutlined,
} from '@ant-design/icons';
import Latex from '@ant-design/x-markdown/plugins/Latex';
import type { ComponentProps } from '@ant-design/x-markdown';
import type {
  CSSProperties,
  MouseEvent,
  ReactNode,
} from 'react';
import { lazy, memo, Suspense } from 'react';

/** 动态导入 ECharts 块，避免阻塞首屏 */
const EChartsBlock = lazy(
  () => import('./EChartsBlock').then((mod) => ({ default: mod.EChartsBlock })),
);

const markdownConfig = {
  gfm: true,
  breaks: true,
  extensions: Latex(),
};

/**
 * DOMPurify 允许的 URI 协议正则
 *
 * 在 DOMPurify 默认正则基础上扩展 `file` 协议，以允许 Electron 客户端
 * 渲染本地文件（file:///E:/...）的图片与链接。
 *
 * 默认正则（dompurify 3.4.10）仅放行 http/https/ftp/ftps/mailto/tel/callto/sms/cid/xmpp/matrix，
 * file: 不在其中，会导致 XMarkdown 渲染的图片 src 被剥离。
 *
 * 注意：放宽该正则会引入 file:// XSS 风险，仅在受信桌面应用中使用。
 *
 * 新增分支 [a-z]:(?=[\\/])：放行 Windows 盘符绝对路径形态（E:\... / E:/...），
 * 由 LinkRenderer 的 normalizeWindowsPathToFileUrl 规范化为 file:/// URL 后再走本地文件打开链路。
 */
const ALLOWED_URI_REGEXP =
  /^(?:(?:(?:f|ht)tps?|file|mailto|tel|callto|sms|cid|xmpp|matrix):|[a-z]:(?=[\\/])|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

const blockquoteStyle: CSSProperties = {
  margin: '0.25rem 0',
  paddingLeft: '1rem',
  borderLeft: '2px solid #e5e7eb',
  color: '#4b5563',
};

const codeBlockSurface = 'hsl(220, 13%, 18%)';
const codeBlockHeaderSurface = 'hsl(220, 13%, 22%)';
const codeBlockForeground = 'hsl(220, 14%, 71%)';
const codeBlockBorder = 'rgba(255, 255, 255, 0.08)';

const inlineCodeStyle: CSSProperties = {
  padding: '0.1rem 0.35rem',
  border: '1px solid #e5e7eb',
  borderRadius: 4,
  background: '#f8fafc',
  fontSize: '0.92em',
};

function nodeToText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map(nodeToText).join('');
  }

  return '';
}

function extractFenceLanguage(lang?: string, className?: string): string {
  const direct = (lang ?? '').trim();

  if (direct) {
    return direct.split(/\s+/)[0] ?? '';
  }

  const match = className?.match(/language-([^\s]+)/i);
  return match?.[1] ?? '';
}

function parseJsonObject(code: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(code) as unknown;

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }

    return null;
  } catch {
    return null;
  }
}

function resolveChartPayload(
  language: string,
  code: string,
): {
  optionJson: string;
  height?: number;
} | null {
  if (language === 'echarts') {
    const option = parseJsonObject(code);

    if (!option) {
      return null;
    }

    return {
      optionJson: JSON.stringify(option),
    };
  }

  if (language !== 'chart') {
    return null;
  }

  const payload = parseJsonObject(code);

  if (!payload) {
    return null;
  }

  const library =
    typeof payload.library === 'string'
      ? payload.library.toLowerCase()
      : typeof payload.renderer === 'string'
        ? payload.renderer.toLowerCase()
        : '';
  const option = payload.option;
  const height = typeof payload.height === 'number' ? payload.height : undefined;

  if (
    (library === '' || library === 'echarts') &&
    option &&
    typeof option === 'object' &&
    !Array.isArray(option)
  ) {
    return {
      optionJson: JSON.stringify(option),
      height,
    };
  }

  return null;
}

function PreWrapper({ children }: ComponentProps) {
  return <>{children}</>;
}

function CodeRenderer({
  children,
  block,
  lang,
  className,
}: ComponentProps) {
  const code = nodeToText(children).replace(/\n$/, '');
  const rawLang = extractFenceLanguage(lang, className);
  const specialLang = rawLang.toLowerCase();
  const forceHorizontalScrollbar = specialLang === 'json';

  if (!block) {
    return <code style={inlineCodeStyle}>{children}</code>;
  }

  if (specialLang === 'mermaid') {
    return (
      <Mermaid
        style={{ margin: '0.5rem 0' }}
        actions={{
          enableCopy: true,
          enableDownload: true,
          enableZoom: true,
        }}
      >
        {code}
      </Mermaid>
    );
  }

  const chartPayload = resolveChartPayload(specialLang, code);

  if (chartPayload) {
    return (
      <Suspense fallback={<div style={{ height: chartPayload.height ?? 320, background: '#f5f5f5', borderRadius: 8 }} />}>
        <EChartsBlock
          optionJson={chartPayload.optionJson}
          height={chartPayload.height}
        />
      </Suspense>
    );
  }

  return (
    <CodeHighlighter
      className="chat-code-highlighter"
      lang={rawLang || undefined}
      prismLightMode={false}
      header={() => (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '12px 16px',
            background: codeBlockHeaderSurface,
            color: codeBlockForeground,
          }}
        >
          <span style={{ color: codeBlockForeground, fontWeight: 500 }}>
            {rawLang || 'code'}
          </span>
          <Actions.Copy
            text={code}
            styles={{
              root: {
                color: '#ffffff',
              },
            }}
            icon={[
              <CopyOutlined key="copy" style={{ color: '#ffffff' }} />,
              <CheckOutlined key="copied" style={{ color: '#ffffff' }} />,
            ]}
          />
        </div>
      )}
      styles={{
        code: {
          background: codeBlockSurface,
          borderColor: codeBlockBorder,
          maxWidth: '100%',
          overflowX: forceHorizontalScrollbar ? 'scroll' : 'auto',
          overflowY: 'hidden',
          scrollbarColor: 'rgba(148, 163, 184, 0.65) transparent',
          scrollbarGutter: 'stable',
          scrollbarWidth: 'thin',
        },
      }}
      classNames={{
        code: 'chat-code-scroll',
      }}
      highlightProps={{
        style: oneDark,
        customStyle: {
          display: 'block',
          width: 'max-content',
          minWidth: '100%',
          maxWidth: 'none',
          minHeight: 0,
          margin: 0,
          padding: 0,
          background: 'transparent',
          borderRadius: 0,
          overflow: 'visible',
        },
        codeTagProps: {
          style: {
            display: 'block',
            width: 'max-content',
            minWidth: '100%',
            minHeight: 0,
            overflow: 'visible',
            boxSizing: 'border-box',
            padding: '1rem',
            background: 'transparent',
            verticalAlign: 'top',
          },
        },
        lineProps: {
          style: {
            display: 'block',
            width: 'max-content',
            minWidth: '100%',
          },
        },
      }}
    >
      {code}
    </CodeHighlighter>
  );
}

function ImageRenderer({
  children: _children,
  domNode: _domNode,
  streamStatus: _streamStatus,
  style,
  ...rest
}: ComponentProps) {
  const props = rest as ComponentProps & { src?: string };

  return (
    <img
      {...rest}
      src={props.src}
      loading="lazy"
      style={{
        maxWidth: '100%',
        height: 'auto',
        ...style,
      }}
    />
  );
}

function isImageLinkUrl(urlText: string): boolean {
  try {
    const url = new URL(urlText);
    return /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function isLocalFileUrl(urlText: string): boolean {
  try {
    return new URL(urlText).protocol === 'file:';
  } catch {
    return false;
  }
}

/**
 * Windows 绝对路径规范化：盘符形态（E:\... / E:/...）或 UNC（\\server\share\...）
 * 转换为 file:/// URL，使 isLocalFileUrl 能识别并经 IPC 打开。
 * 非 Windows 绝对路径形态返回 undefined，保持原 href 不变。
 */
function normalizeWindowsPathToFileUrl(href: string): string | undefined {
  if (/^\\\\/.test(href)) {
    // UNC 路径：\\\\server\\share\\... → file://server/share/...
    const normalized = href.replace(/\\/g, '/');
    const rest = normalized.slice(2);
    const hostEnd = rest.indexOf('/');
    if (hostEnd <= 0) {
      return undefined;
    }
    const host = rest.slice(0, hostEnd);
    const encoded = rest.slice(hostEnd + 1).split('/').filter(Boolean).map(encodeURIComponent).join('/');
    return `file://${host}/${encoded}`;
  }

  if (!/^[A-Za-z]:[\\/]/.test(href)) {
    return undefined;
  }

  // 盘符路径：E:\\foo bar\\baz.txt → file:///E:/foo%20bar/baz.txt
  const drive = href.slice(0, 2);
  const encoded = href.slice(3).replace(/\\/g, '/').split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return `file:///${drive}/${encoded}`;
}

function getUrlFileName(urlText: string): string | undefined {
  try {
    const url = new URL(urlText);
    const name = url.pathname.split('/').filter(Boolean).pop();
    return name ? decodeURIComponent(name) : undefined;
  } catch {
    return undefined;
  }
}

function LinkRenderer({
  children,
  domNode: _domNode,
  streamStatus,
  ...rest
}: ComponentProps) {
  const props = rest as ComponentProps & {
    href?: string;
  };
  const rawHref = props.href;
  const href = typeof rawHref === 'string'
    ? normalizeWindowsPathToFileUrl(rawHref) ?? rawHref
    : rawHref;
  const isLocalFile = typeof href === 'string' && isLocalFileUrl(href);
  const title = isLocalFile && typeof href === 'string'
    ? `打开 ${getUrlFileName(href) ?? '本地文件'}`
    : undefined;

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!isLocalFile || typeof href !== 'string') {
      return;
    }

    event.preventDefault();
    const fileApi = window.electronAPI?.file;
    if (!fileApi) {
      message.error('无法打开文件：本地文件接口不可用');
      return;
    }

    void fileApi.open(href).catch((error) => {
      console.error('[RichMarkdown] failed to open local file:', error);
      const reason = error instanceof Error ? error.message : String(error);
      message.error(`打开文件失败：${reason}`);
    });
  };

  if (streamStatus === 'done' && typeof href === 'string' && isImageLinkUrl(href)) {
    const altText = nodeToText(children).trim() || '';

    return (
      <img
        src={href}
        alt={altText}
        loading="lazy"
        style={{
          maxWidth: '100%',
          height: 'auto',
        }}
      />
    );
  }

  return (
    <a
      {...rest}
      href={href}
      target={isLocalFile ? undefined : '_blank'}
      rel={isLocalFile ? undefined : 'noopener noreferrer'}
      title={title}
      onClick={handleClick}
    >
      {children}
    </a>
  );
}

function BlockquoteRenderer({
  children,
  domNode: _domNode,
  streamStatus: _streamStatus,
  style,
  ...rest
}: ComponentProps) {
  return (
    <blockquote
      {...rest}
      style={{
        ...blockquoteStyle,
        ...style,
      }}
    >
      {children}
    </blockquote>
  );
}

export const RichMarkdown = memo(function RichMarkdown({
  content,
}: {
  content: string;
}) {
  return (
    <XMarkdown
      className="chat-rich-markdown x-markdown-light"
      content={content}
      config={markdownConfig}
      openLinksInNewTab
      dompurifyConfig={{ ALLOWED_URI_REGEXP }}
      components={{
        pre: PreWrapper,
        code: CodeRenderer,
        a: LinkRenderer,
        img: ImageRenderer,
        blockquote: BlockquoteRenderer,
      }}
    />
  );
});
