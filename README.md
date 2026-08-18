# Delepi

> 智能协作、准确交付 —— 基于 Electron 的 AI 桌面客户端（当前版本 0.1.0）

## 1. 项目简介

### 1.1 项目定位

Delepi（`name` 为 `delepi`，`version` 为 `0.1.0`，`description` 为 “Delepi - 智能协作、准确交付”）是一款面向桌面端的智能协作客户端，围绕双智能体架构组织 AI 能力：

- **主智能体（main-agent）**：负责会话理解、任务规划与结果汇总；
- **执行子智能体（executor-agent）**：依据技能文档完成具体任务的落地执行。

模型接入采用 OpenAI 兼容 API，模型地址与 API Key 均在应用内配置；业务数据通过 SQLite 持久化，包含 `conversations`、`messages`、`context_compressions`、`settings` 四张表。

### 1.2 架构

| 层次 | 组成 |
| --- | --- |
| 桌面外壳 | Electron 主进程（入口 `src/main/index.ts`，构建产物 `dist/main/index.js`） |
| 渲染层 | React（`src/renderer`），预加载脚本 `src/preload` |
| 共享层 | 跨进程共享类型与常量（`src/shared`） |
| 模型层 | OpenAI 兼容客户端，主模型 / 执行子智能体模型 / 视觉模型可分别配置 |
| 持久化 | SQLite（better-sqlite3） |
| 脚本执行 | 内置 Python 3.14.6 预置环境（可选自定义解释器） |

### 1.3 技术栈

| 类别 | 技术（package.json 声明范围） |
| --- | --- |
| 桌面框架 | Electron `^42.0.0` |
| 前端框架 | React / React DOM `^19.2.7` |
| 开发语言 | TypeScript `^5.9.3` |
| 构建工具 | Vite `^7.0.0`、electron-builder `^26.0.0` |
| 数据库 | better-sqlite3 `^12.11.1` |
| 模型接入 | openai `^6.34.0`（OpenAI 兼容 API） |
| 图像处理 | sharp `^0.35.1` |

## 2. 功能特性（能做什么）

### 2.1 智能对话

- 多轮会话与消息管理；
- 会话标题自动生成；
- 上下文压缩：对较长的对话历史进行压缩，控制上下文规模。

### 2.2 三大执行工具

| 工具 | 能力与约束 |
| --- | --- |
| `run_exe`（命令行执行） | 执行命令行命令。内置安全过滤：按平台（Windows/Linux）维护拒绝模式列表，拒绝可能导致任务挂起或常驻的命令；包安装类命令（`pip install`、`python -m pip install`、`npm install`）必须单独成行执行 |
| `run_with_python`（Python 脚本执行） | 编写并执行 Python 脚本。执行前进行 py_compile 预校验，具备超时控制、输出截断与 UTF-8 运行环境 |
| `inspect_image`（图片识别） | 读取本地图片文件，识别并分析其中可见内容信息 |

### 2.3 文件上传

会话支持文件上传，单次最多 10 个（`MAX_UPLOAD_COUNT = 10`）；文件类型基于扩展名与 magic number（文件头字节签名）探测。

### 2.4 内置 Python 能力矩阵

内置 Python 3.14.6 预置环境随应用分发（内置 pip 26.2.1），预置 14 个第三方包，精确版本见 `requirements/requirements-lock.txt`：

| 功能 | 支撑包 |
| --- | --- |
| PDF 读写 | pdfplumber、PyPDF2 |
| Word 文档读写 | python-docx |
| Excel / CSV 读写 | openpyxl |
| PPT 读写 | python-pptx |
| 图表绘制（折线图等） | matplotlib |
| 组织架构图 / 网络图 | networkx（配合 matplotlib 渲染） |
| HTTP 客户端 | requests、httpx |
| SSH | paramiko |
| 图像轻量处理 | Pillow |
| 数值计算基础 | numpy |
| 报表读写 | pandas |
| 报表导出（Excel 写出） | xlsxwriter |
| TCP / UDP 通信 | Python 标准库 socket（无需第三方包） |

### 2.5 九类执行技能

`skills/` 目录内置九类执行技能文档，作为执行子智能体的工作方式定义：

| 技能 | 文档位置 |
| --- | --- |
| 执行变更 | skills/change-execution |
| 问题定位 | skills/issue-location |
| 调查研究 | skills/research-analysis |
| 模拟操作 | skills/simulation-operation |
| 方案设计 | skills/solution-design |
| 结构化写作 | skills/structured-writing |
| 用例执行 | skills/use-case-execution |
| 用例编写 | skills/use-case-writing |
| 视觉设计 | skills/visual-design |

## 3. 环境要求

- **Node.js 与 npm**：项目未在 package.json 中声明 engines 最低版本；实测 Node.js v24.16.0 环境下安装、构建、打包链路均可正常运行。
- **网络**：安装 Node 依赖、下载 Electron 二进制与 Python embed 包均需网络访问；Electron 二进制镜像已在 `.npmrc` 中配置（npmmirror）。
- **打包目标**：Windows x64（NSIS 安装包）。

## 4. 快速开始（如何使用）

在项目根目录执行：

```bash
# 安装依赖
npm install

# 启动开发模式（Vite）
npm run dev
```

注意事项：

- 若当前环境已设置 `NODE_ENV=production`，npm 默认跳过 devDependencies，安装命令需改用 `npm install --include=dev`；
- 安装过程会自动执行 postinstall 脚本（`scripts/postinstall.cjs`），用于校验并修复 Electron 二进制。

## 5. 配置说明（如何配置）

### 5.1 模型与 API Key

模型接入均通过 OpenAI 兼容 API，以下配置均在应用内完成，无需修改代码：

| 配置组 | 配置项 |
| --- | --- |
| 主智能体模型 | `mainModelBaseUrl` / `mainModelApiKey` / `mainModelName`，可选启用多模态协议（`mainModelMultimodal`，默认开启） |
| 执行子智能体模型 | `executorModelBaseUrl` / `executorModelApiKey` / `executorModelName` |
| 视觉模型 | `visionLlmBaseUrl` / `visionLlmApiKey` / `visionLlmModel` |

安全提示：API Key 以明文形式存储于本地 SQLite 数据库（`data/` 目录）。该目录已列入 `.gitignore`，严禁提交至版本库。

### 5.2 Python 环境相关配置

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `pipPackageLevel` | `recommended` | 依赖安装级别：core（6 包）/ recommended（累计 14 包）/ full（累计 24 包） |
| `pipMirrorUrl` | `https://pypi.org/simple/` | pip 镜像源地址 |
| `pipAutoBootstrap` | `true` | 启动时自动补装所选级别缺失的依赖包 |
| `useBuiltinPython` | `true` | 是否使用内置 Python 3.14.6 预置环境 |
| `customPythonPath` | （空） | 自定义 Python 解释器路径，仅在 `useBuiltinPython=false` 时生效 |

### 5.3 依赖清单导入与导出

应用内支持 Python 依赖清单的导入与导出：

- `.txt` 文件：按行 `name==version` 形式；
- `.zip` 文件：压缩包内含 `manifest.json` 清单。

已安装依赖记录于 `deps-installed.json`（已列入 `.gitignore`，不入库）。

## 6. 构建与打包

```bash
# TypeScript 类型检查（tsc --noEmit）
npm run typecheck

# 类型检查 + Vite 构建
npm run build

# 打包 Windows x64 NSIS 安装包（输出至 release/）
npm run pack
```

说明：

1. `npm run pack` 会触发 prepack 钩子，自动执行 `npm run build:preset-python` 构建预置 Python 环境（`scripts/build-preset-python.ts`，共 8 步：检查缓存 → 解压至临时构建目录 → 配置 `._pth` → 安装 pip → 安装 14 个预置包 → 清理 → 验证 → 移动至 `resources/python/python-3.14.6` 并生成 `.beez-preset` 标记）；若 `.beez-preset` 标记已存在，则跳过重建；
2. 构建脚本对下载与单条命令执行均设置 120 秒超时。全新环境网络较慢时，建议预先设置 pip 镜像环境变量（pip 子进程自动继承），例如：

```bash
# bash
export PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
```

```powershell
# PowerShell
$env:PIP_INDEX_URL = "https://pypi.tuna.tsinghua.edu.cn/simple"
```

3. 打包时 `resources/python` 将作为 extraResources 随安装包分发；
4. 已知非阻断警告：Vite 构建时出现 `node:path` externalized 提示、部分 chunk 体积超过 500 kB 提示，均属警告级别，不影响构建结果。

## 7. 依赖清单文件说明

| 文件 | 用途 |
| --- | --- |
| `requirements/requirements-preset.txt` | 预置环境依赖的版本下限清单（14 包），与构建脚本 `PRESET_PACKAGES` 常量保持一致 |
| `requirements/requirements-lock.txt` | 预置环境精确版本锁定清单（`name==version`，14 包），由预置环境 pip freeze 生成并经 importlib.metadata 交叉验证 |

在已有 Python 环境中复现预置依赖：

```bash
pip install -r requirements/requirements-lock.txt
```

传递依赖由 pip 自动解析，不在清单范围内；TCP/UDP 通信由 Python 标准库 socket 支持，无需第三方包。

## 8. 源码仓库上手指南

获取源码（git clone 或下载源码压缩包均可）后，在项目根目录执行：

```bash
npm install            # NODE_ENV=production 环境改用 npm install --include=dev
npm run pack           # 自动完成构建与预置 Python 环境准备，产出安装包
```

开发调试使用 `npm run dev`；代码检查使用 `npm run lint`（ESLint）与 `npm run typecheck`。

以下目录与文件不入库（见 `.gitignore`），克隆后由上述命令自动重建或再生：

| 路径 | 说明 |
| --- | --- |
| `node_modules/` | Node 依赖（npm install 重建） |
| `dist/` | 构建输出（npm run build 重建） |
| `release/` | 打包输出（npm run pack 生成） |
| `resources/*` | 预置 Python 等构建产物（prepack 自动重建） |
| `scripts/cache/`、`scripts/.build/` | 构建脚本缓存与中间产物 |
| `data/` | 本地数据库（含明文 API Key，严禁入库） |
| `deps-installed.json`、`pack_log.txt` 等 | 运行时产物 |

入库保留：源码（`src/`、`skills/`、`scripts/` 脚本）、`package.json`、`package-lock.json`、`requirements/`、构建配置（`vite.config.ts`、`tsconfig.json`、`electron-builder.yml`、`.npmrc` 等）。

## 9. 项目结构概览

| 路径 | 说明 |
| --- | --- |
| `src/main/index.ts` | Electron 主进程入口 |
| `src/main/` | 主进程源码（constants / db / ipc / modules / tools / types / utils / resources） |
| `src/renderer/` | 渲染层源码（React） |
| `src/preload/` | 预加载脚本 |
| `src/shared/` | 跨进程共享类型与常量 |
| `skills/` | 九类执行技能文档 |
| `scripts/` | 工程脚本（build-preset-python.ts、postinstall.cjs 等） |
| `requirements/` | Python 依赖清单（入库） |
| `resources/python/` | 预置 Python 环境（构建产物，不入库） |
| `data/` | 本地 SQLite 数据库（不入库） |
| `dist/` | 构建输出（不入库） |
| `release/` | 打包输出（不入库） |
| `package.json` / `package-lock.json` | 依赖与脚本定义（入库） |
| `electron-builder.yml` / `vite.config.ts` / `tsconfig.json` | 构建配置（入库） |

## 10. 许可证

截至本文档撰写时，本项目尚未指定开源许可证（License）。
