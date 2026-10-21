import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdtemp, mkdir, writeFile, readFile, appendFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const windowsOnly = { skip: process.platform !== 'win32', timeout: 90000 };

function script(directory, name, viaLauncher = false) {
  const launchers = { start: '启动平台.cmd', stop: '停止平台.cmd', backup: '备份数据.cmd' };
  const entry = (viaLauncher ? join(directory, launchers[name]) : join(directory, 'scripts', `${name}.ps1`)).replaceAll("'", "''");
  const argumentsText = name === 'start' ? (viaLauncher ? '-NoBrowser' : '-Mode Local -NoBrowser') : (viaLauncher ? '-NoPause' : '');
  const inheritedModules = viaLauncher ? "$env:PSModulePath = 'Z:\\missing-windows-modules';" : '';
  const source = `$ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false); ${inheritedModules} & '${entry}' ${argumentsText}; exit $LASTEXITCODE`;
  return new Promise((resolveRun, reject) => {
    const environment = { ...process.env, SERVERCHAN_SENDKEY: '' };
    // PowerShell 7's inherited module path can hide Windows PowerShell 5 modules.
    delete environment.PSModulePath;
    const child = spawn('powershell.exe', ['-NoProfile', '-OutputFormat', 'Text', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], {
      cwd: directory, windowsHide: true, shell: false, env: environment, stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${name} 脚本测试超时：${output}`)); }, 30000);
    child.stdout.on('data', chunk => { output += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { output += chunk.toString('utf8'); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); child.stdout.destroy(); child.stderr.destroy(); resolveRun({ code, output }); });
  });
}

async function fixture(t, port) {
  const directory = await mkdtemp(join(tmpdir(), '办公启动 中文空格-'));
  t.after(async () => {
    await script(directory, 'stop');
    const checked = resolve(directory);
    assert.ok(checked.startsWith(resolve(tmpdir()) + sep) && checked.slice(resolve(tmpdir()).length + 1).startsWith('办公启动 中文空格-'));
    await rm(checked, { recursive: true, force: true });
  });
  for (const item of ['server.mjs', 'lib', 'scripts', '启动平台.cmd', '停止平台.cmd', '备份数据.cmd']) await cp(join(project, item), join(directory, item), { recursive: true });
  await mkdir(join(directory, 'public'));
  await writeFile(join(directory, 'public', 'index.html'), '<html lang="zh-CN">测试平台</html>');
  await writeFile(join(directory, '.env'), `AUTOMATION_KEY=${'a'.repeat(64)}\nN8N_ENCRYPTION_KEY=${'b'.repeat(64)}\nSEED_DEMO=0\n`);
  await writeFile(join(directory, 'platform.local.json'), JSON.stringify({ port, dataDirectory: '当前数据', mode: 'Local' }));
  return directory;
}

async function listen(server, port = 0) {
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveListen); });
  return server.address().port;
}
const close = server => new Promise(resolveClose => server.close(resolveClose));

test('Windows 启动、停止和备份共用本机数据，重复启动复用，代码更新重启并保留任务', windowsOnly, async t => {
  const probe = createServer(); const port = await listen(probe); await close(probe);
  const directory = await fixture(t, port), base = `http://127.0.0.1:${port}`;
  let result = await script(directory, 'start', true); assert.equal(result.code, 0, result.output);
  const processRecord = () => readFile(join(directory, '当前数据', 'local-process.json'), 'utf8').then(value => JSON.parse(value.replace(/^\uFEFF/, '')));
  const first = await processRecord(); assert.equal(first.port, port); assert.equal(first.dataDirectory, join(directory, '当前数据'));
  assert.equal((await (await fetch(base + '/api/state')).json()).tasks.length, 0);
  const created = await fetch(base + '/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ title: '重启后保留', owner: '测试负责人', startDate: '2026-10-21', dueDate: '2026-10-24', deliverable: '提交会议纪要' }) });
  assert.equal(created.status, 201); const { task } = await created.json();
  result = await script(directory, 'start', true); assert.equal(result.code, 0, result.output); assert.equal((await processRecord()).pid, first.pid);
  await appendFile(join(directory, 'lib', 'dates.mjs'), '\n// 仅修改隔离副本，模拟更新后台代码。\n');
  result = await script(directory, 'start'); assert.equal(result.code, 0, result.output);
  const updated = await processRecord(); assert.notEqual(updated.pid, first.pid); assert.notEqual(updated.codeSignature, first.codeSignature);
  const state = await (await fetch(base + '/api/state')).json(); assert.deepEqual(state.tasks.map(value => value.id), [task.id]);
  result = await script(directory, 'backup', true); assert.equal(result.code, 0, result.output);
  const backups = await readdir(join(directory, 'backups')); assert.equal(backups.length, 1);
  assert.equal((await readFile(join(directory, 'backups', backups[0]))).subarray(0, 15).toString(), 'SQLite format 3');
  result = await script(directory, 'stop', true); assert.equal(result.code, 0, result.output);
  await assert.rejects(fetch(base + '/api/health'));
  assert.ok((await readFile(join(directory, '当前数据', 'office.sqlite'))).length > 0);
});

test('Windows 启动拒绝未登记的占用端口，不复用或停止其他程序', windowsOnly, async t => {
  const foreign = createServer((request, response) => { response.setHeader('Content-Type', 'application/json'); response.end('{"ok":true}'); });
  const port = await listen(foreign); t.after(() => close(foreign));
  const directory = await fixture(t, port);
  const result = await script(directory, 'start'); assert.equal(result.code, 1, result.output); assert.match(result.output, /未登记/);
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/api/health`)).json(), { ok: true });
});
