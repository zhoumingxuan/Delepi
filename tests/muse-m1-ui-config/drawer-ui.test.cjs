'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const esbuild = require('esbuild');
const WORK = path.resolve(__dirname, '../..');
const antdFixture = `import React from 'react';
export const App={useApp:()=>window.__museUiServices};
export const Button=({children,onClick,disabled,loading})=><button onClick={onClick} disabled={disabled||loading}>{children}</button>;
export const Flex=({children,...props})=><div data-testid={props['data-testid']}>{children}</div>;
export const Typography={Text:({children,strong})=><span data-strong={strong}>{children}</span>,Title:({children})=><h4>{children}</h4>};
export const Drawer=({children,title,open,onClose})=>open?<section data-drawer={title}><h3>{title}</h3><button onClick={onClose}>{title}.close</button>{children}</section>:null;
export const Alert=({title,description})=><aside>{title}{description}</aside>;
export const Empty=({description})=><p>{description}</p>;
export const Spin=()=>null;
export const Tag=({children})=><span>{children}</span>;
export const Switch=({checked,onChange})=><input type='checkbox' checked={checked} onChange={e=>onChange(e.target.checked)}/>;
export const Select=({value,onChange,options})=><select value={value||''} onChange={e=>onChange(e.target.value||undefined)}><option value=''></option>{options.map(item=><option key={item.value} value={item.value}>{item.label}</option>)}</select>;
export const Tabs=({items,activeKey,onChange})=><div className='test-tabs'>{items.map(item=><button key={item.key} onClick={()=>onChange(item.key)}>{item.label}</button>)}{items.find(item=>item.key===activeKey)?.children}</div>;
export const List=({dataSource,renderItem})=><ul>{dataSource.map(renderItem)}</ul>;List.Item=({children,actions})=><li>{children}{actions}</li>;
export const Descriptions=({items})=><dl>{items.map(item=><div key={item.key}>{item.label}{item.children}</div>)}</dl>;`;

test('real React Muse drawer rejects late scope responses and retains fixed activity pagination facts', async t => {
  const allowed = path.join(WORK, 'isolated-runs'); fs.mkdirSync(allowed, { recursive: true });
  const root = fs.mkdtempSync(path.join(allowed, 'm1-drawer-ui-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await esbuild.build({ entryPoints: [path.join(__dirname, 'drawer-browser-entry.tsx')], bundle: true, platform: 'browser', format: 'iife', outfile: path.join(root, 'fixture.js'), define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'ui-fixture-controls', setup(build) {
    build.onResolve({ filter: /^antd$/ }, () => ({ path: 'antd-fixture', namespace: 'fixture' }));
    build.onResolve({ filter: /^@ant-design\/icons$/ }, () => ({ path: 'icons-fixture', namespace: 'fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'antd-fixture' ? antdFixture : 'export const CheckOutlined=()=>null,CloseOutlined=()=>null,FolderOpenOutlined=()=>null,ReloadOutlined=()=>null;', loader: 'tsx', resolveDir: WORK }));
  } }] });
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><html><body><script src="fixture.js"></script></body></html>');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_DISABLE_SANDBOX;
  const result = spawnSync(process.execPath, [path.join(__dirname, 'settings-browser-main.cjs'), root, '__runMuseDrawerScenarios'], { cwd: WORK, env, encoding: 'utf8', timeout: 30000 });
  const reportFile = path.join(root, 'results.json'), report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : { error: result.stderr || String(result.error) };
  assert.equal(result.status, 0, report.error); assert.equal(report.ok, true, report.error); assert.equal(report.results.length, 7);
});
