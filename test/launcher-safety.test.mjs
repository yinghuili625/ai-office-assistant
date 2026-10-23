import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, copyFile, writeFile, readdir, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const execute = promisify(execFile);
const powershellLiteral = value => `'${value.replaceAll("'", "''")}'`;

test('Windows 启动、备份及停止拒绝端口上的其他副本，匹配当前目录时才认可健康检查', { skip: process.platform !== 'win32' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'office-launcher-risk-')), scripts = join(dir, 'scripts'), paths = [];
  await mkdir(scripts);
  for (const name of ['common.ps1', 'start.ps1', 'backup.ps1', 'stop.ps1']) await copyFile(new URL(`../scripts/${name}`, import.meta.url), join(scripts, name));
  let identity = 'a-different-directory';
  const server = http.createServer((request, response) => { paths.push(request.url); response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ ok: true, instanceId: identity, runtime: process.version })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  await writeFile(join(dir, '.env'), `PORT=${server.address().port}\nSEED_DEMO=0\nAUTOMATION_KEY=synthetic-test-key\nN8N_ENCRYPTION_KEY=synthetic-test-encryption\n`);
  const environment = { ...process.env }; delete environment.PORT; delete environment.port;
  async function run(name, args = '') {
    try {
      const result = await execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); & ${powershellLiteral(join(scripts, name))} ${args}`], { env: environment, timeout: 20_000, windowsHide: true, encoding: 'utf8' });
      return { code: 0, ...result };
    } catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  }
  for (const [script, args] of [['start.ps1', '-Mode Local -NoBrowser'], ['backup.ps1', ''], ['stop.ps1', '']]) {
    const result = await run(script, args);
    assert.equal(result.code, 1, `${script}: ${result.stdout} ${result.stderr}`);
    assert.match(result.stdout, /其他目录或旧版平台占用/);
  }
  assert.ok(paths.length >= 3); assert.ok(paths.every(path => path === '/api/health'));
  await assert.rejects(access(join(dir, 'data', 'office.sqlite')));
  assert.deepEqual(await readdir(join(dir, 'backups')), []);
  identity = createHash('sha256').update(`office-platform-v1:${dir.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase()}`).digest('hex');
  const checker = join(scripts, 'check.ps1');
  await writeFile(checker, ". (Join-Path $PSScriptRoot 'common.ps1')\nif (Test-Platform) { Write-Output 'INSTANCE_MATCH_OK' } else { exit 1 }\n");
  const matched = await run('check.ps1'); assert.equal(matched.code, 0, matched.stderr); assert.match(matched.stdout, /INSTANCE_MATCH_OK/);
});
