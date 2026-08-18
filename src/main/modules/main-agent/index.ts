/**
 * MainAgent 模块导出
 */

export { runMainAgent } from './main-agent';
export type { MainAgentOptions, MainAgentResult } from './main-agent';

export { compressMessagesToContext, countStringChars } from './context-compression';
export { buildMainAgentTextContent, buildMainAgentUserContent } from './main-agent-message-content';
export { SYSTEM_PROMPT } from './prompt';
