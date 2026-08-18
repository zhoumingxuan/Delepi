#!/usr/bin/env node
/**
 * schema 双份一致性断言（Delepi 重构 S1 / 规划验证项 A-02）
 *
 * 比对 src/main/resources/schema/schema.sql 与
 *      src/main/db/sqlite-adapter.ts 内联 SCHEMA_SQL 模板串，
 *      去注释/去空白归一化后逐行比对；不一致时以退出码 1 结束。
 * 说明：工具脚本，不进入运行时。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_SQL_FILE = path.join(repoRoot, 'src', 'main', 'resources', 'schema', 'schema.sql');
const ADAPTER_FILE = path.join(repoRoot, 'src', 'main', 'db', 'sqlite-adapter.ts');

function normalizeSqlText(text) {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const commentStart = line.indexOf('--');
      return commentStart >= 0 ? line.slice(0, commentStart) : line;
    })
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function readSchemaSqlFile() {
  if (!fs.existsSync(SCHEMA_SQL_FILE)) {
    console.error(`[verify-schema-sync] 缺少文件: ${SCHEMA_SQL_FILE}`);
    process.exit(1);
  }
  return fs.readFileSync(SCHEMA_SQL_FILE, 'utf8');
}

function readInlineSchemaSql() {
  if (!fs.existsSync(ADAPTER_FILE)) {
    console.error(`[verify-schema-sync] 缺少文件: ${ADAPTER_FILE}`);
    process.exit(1);
  }
  const source = fs.readFileSync(ADAPTER_FILE, 'utf8');
  const match = source.match(/const SCHEMA_SQL = `([\s\S]*?)`;/);
  if (!match) {
    console.error(`[verify-schema-sync] 未能在 ${ADAPTER_FILE} 中定位内联 SCHEMA_SQL 模板串`);
    process.exit(1);
  }
  return match[1];
}

const fileLines = normalizeSqlText(readSchemaSqlFile());
const inlineLines = normalizeSqlText(readInlineSchemaSql());

let mismatch = false;
const maxLines = Math.max(fileLines.length, inlineLines.length);
for (let i = 0; i < maxLines; i += 1) {
  const a = fileLines[i];
  const b = inlineLines[i];
  if (a !== b) {
    mismatch = true;
    console.error(`[verify-schema-sync] 第 ${i + 1} 行不一致:`);
    console.error(`  schema.sql     : ${a === undefined ? '<缺失>' : a}`);
    console.error(`  内联 SCHEMA_SQL: ${b === undefined ? '<缺失>' : b}`);
  }
}

if (mismatch) {
  console.error(
    `[verify-schema-sync] FAIL：schema.sql（${fileLines.length} 行）与内联 SCHEMA_SQL（${inlineLines.length} 行）归一化后不一致`,
  );
  process.exit(1);
}

console.log(
  `[verify-schema-sync] OK：schema.sql 与内联 SCHEMA_SQL 归一化一致（${fileLines.length} 行）`,
);
