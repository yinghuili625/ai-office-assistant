import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OfficeStore } from '../lib/office.mjs';
import { nextOccurrence, todayInShanghai } from '../lib/dates.mjs';
import { parseCsv } from '../lib/csv.mjs';
import { createApplication } from '../server.mjs';

const taskInput = (overrides = {}) => ({ title: '测试任务', owner: '测试负责人', startDate: '2026-10-01', dueDate: '2026-10-20', deliverable: '提交成果', ...overrides });
const completionInput = () => ({ confirmed: true, files: [{ name: '交付成果.txt', contentBase64: Buffer.from('已按交付要求完成并核对。').toString('base64') }] });
const templateInput = (overrides = {}) => ({ title: '月末任务', owner: '测试负责人', nextDate: '2026-01-31', dueDays: 2, frequency: '每月', deliverable: '提交台账', ...overrides });
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'office-test-')); const store = new OfficeStore({ databasePath: join(dir, 'office.sqlite'), seedDemo: false, now: () => new Date('2026-10-19T02:00:00Z'), ...options });
  t.after(async () => { try { store.close(); } catch {} await rm(dir, { recursive: true, force: true }); });
  return { dir, store };
}

test('任务创建、状态流转、改派均记录历史，完成后停止提醒，重新打开继续提醒', async t => {
  let now = new Date('2026-10-19T02:00:00Z'); const { store } = await fixture(t, { now: () => now });
  const task = store.createTask(taskInput({ dueDate: '2026-10-18' }));
  assert.equal(task.isOverdue, true); assert.equal(task.number, 1);
  const updated = store.updateTask(task.id, { owner: '新负责人', status: '进行中' });
  assert.equal(updated.owner, '新负责人'); assert.equal(store.run().reminded, 1); assert.equal(store.run().reminded, 0);
  assert.deepEqual(store.state().reminders[0].recipients, ['新负责人', '管理员']);
  const completed = store.completeTask(task.id, completionInput());
  assert.equal(completed.isOverdue, false); assert.ok(completed.completedAt); assert.equal(store.state().reminders[0].read, true);
  now = new Date('2026-10-20T02:00:00Z'); assert.equal(store.run().reminded, 0);
  const reopened = store.updateTask(task.id, { status: '待办' }); assert.equal(reopened.completedAt, null); assert.equal(store.run().reminded, 1);
  const actions = store.state().events.map(event => event.action);
  for (const action of ['新增任务', '任务改派', '状态变更', '完成任务', '重新打开']) assert.ok(actions.includes(action));
  assert.throws(() => store.updateTask(task.id, { dueDate: '2026-09-01' }), /不能早于/);
  assert.equal(store.getTask(task.id).dueDate, '2026-10-18');
});

test('月底与闰日周期保留锚点，补齐错过日期，重复检查与重启均不重复', async t => {
  let now = new Date('2026-03-31T10:00:00Z'); const { store, dir } = await fixture(t, { now: () => now });
  const template = store.createTemplate(templateInput());
  assert.equal(store.run().generated, 3);
  assert.deepEqual(store.state().tasks.map(task => task.startDate).sort(), ['2026-01-31', '2026-02-28', '2026-03-31']);
  assert.equal(store.getTemplate(template.id).nextDate, '2026-04-30'); assert.equal(store.getTemplate(template.id).anchorDay, 31);
  assert.equal(store.run().generated, 0); store.close();
  const reopened = new OfficeStore({ databasePath: join(dir, 'office.sqlite'), seedDemo: true, now: () => now });
  try {
    assert.equal(reopened.state().tasks.length, 3); assert.equal(reopened.run().generated, 0);
    now = new Date('2026-05-31T10:00:00Z'); assert.equal(reopened.run().generated, 2);
    assert.ok(reopened.state().tasks.some(task => task.startDate === '2026-05-31'));
    reopened.updateTemplate(template.id, { active: false }); now = new Date('2026-08-31T10:00:00Z'); assert.equal(reopened.run().generated, 0);
    reopened.updateTemplate(template.id, { active: true }); assert.equal(reopened.run().generated, 3);
  } finally { reopened.close(); }
  assert.equal(nextOccurrence('2024-02-29', '每年', 29), '2025-02-28');
  assert.equal(nextOccurrence('2027-02-28', '每年', 29), '2028-02-29');
  assert.equal(nextOccurrence('2026-11-30', '每季度', 31), '2027-02-28');
  assert.equal(nextOccurrence('2027-02-28', '每季度', 31), '2027-05-31');
});

test('临期、到期、逾期按上海日期判定，每日去重且覆盖负责人和管理员', async t => {
  let now = new Date('2026-10-18T16:01:00Z'); const { store } = await fixture(t, { now: () => now });
  assert.equal(todayInShanghai(now), '2026-10-19');
  store.updateSettings({ adminName: '办公室主任', reminderDays: 1 });
  store.createTask(taskInput({ title: '临期', dueDate: '2026-10-20' }));
  store.createTask(taskInput({ title: '到期', dueDate: '2026-10-19', owner: '办公室主任' }));
  store.createTask(taskInput({ title: '逾期', dueDate: '2026-10-18' }));
  store.createTask(taskInput({ title: '未来', dueDate: '2026-10-21' }));
  assert.equal(store.run().reminded, 3); assert.equal(store.run().reminded, 0);
  assert.deepEqual(store.state().reminders.map(r => r.kind).sort(), ['临期', '到期', '逾期'].sort());
  assert.equal(store.state().reminders.find(r => r.kind === '到期').recipients.length, 1);
  assert.equal(store.readReminders({ all: true }).updated, 3); assert.equal(store.readReminders({ all: true }).updated, 0);
  now = new Date('2026-10-19T16:01:00Z'); assert.equal(store.run().reminded, 4);
  assert.throws(() => store.updateSettings({ reminderDays: 31 }), /0 至 30/);
});

test('改派与管理员变更刷新当日已有提醒，不重复创建且恢复未读', async t => {
  const { store } = await fixture(t);
  const task = store.createTask(taskInput({ dueDate: '2026-10-19' }));
  assert.equal(store.run().reminded, 1); store.readReminders({ all: true });
  const originalId = store.state().reminders[0].id;
  store.updateTask(task.id, { owner: '接任负责人', title: '修订任务名' });
  store.updateSettings({ adminName: '新管理员' });
  assert.equal(store.run().reminded, 0);
  const reminders = store.state().reminders;
  assert.equal(reminders.length, 1); assert.equal(reminders[0].id, originalId);
  assert.deepEqual(reminders[0].recipients, ['接任负责人', '新管理员']);
  assert.equal(reminders[0].read, false); assert.match(reminders[0].message, /修订任务名/);
  store.completeTask(task.id, completionInput()); assert.equal(store.state().reminders[0].read, true);
  store.updateTask(task.id, { status: '待办' }); assert.equal(store.run().reminded, 0);
  assert.equal(store.state().reminders[0].read, false); assert.equal(store.state().reminders.length, 1);
});

test('CSV 支持 BOM、换行和引号，导入全量验证并保持事务原子性', async t => {
  const { store } = await fixture(t);
  const header = '\uFEFF任务名称,负责人,首次开始日期,完成天数,周期,交付要求,优先级\r\n';
  const good = '"周报,汇总",王晨,2026-10-20,2,每周,"第一行\n第二行含""引号""",高';
  assert.equal(store.importTemplates({ csv: header + good }).created, 1);
  assert.equal(store.state().templates[0].deliverable, '第一行\n第二行含"引号"');
  const count = store.state().templates.length; const eventCount = store.state().events.length;
  assert.throws(() => store.importTemplates({ csv: header + good + '\r\n无效,王晨,2026-02-30,2,每月,成果,中' }), /第 4 行/);
  assert.equal(store.state().templates.length, count); assert.equal(store.state().events.length, eventCount);
  assert.throws(() => store.importTemplates({ csv: header + '任务,王晨,2026-10-20,,每周,成果,中' }), /第 2 行/);
  assert.throws(() => parseCsv('名称\n"未结束'), /第 2 行/);
});

test('导出台账防公式注入，一致性备份可独立打开且包含最近提交', async t => {
  const { store, dir } = await fixture(t);
  const task = store.createTask(taskInput({ title: '=HYPERLINK("危险")', owner: '+危险', deliverable: '@公式', description: '\t=1+1' }));
  const rows = parseCsv(store.exportTasks()).map(row => row.values);
  assert.equal(rows[1][1], "'=HYPERLINK(\"危险\")"); assert.equal(rows[1][2], "'+危险"); assert.equal(rows[1][5], "'@公式"); assert.equal(rows[1][6], "'=1+1");
  const path = join(dir, 'backup.sqlite'); store.createBackup(path); const snapshot = new DatabaseSync(path);
  try { assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); assert.equal(snapshot.prepare('SELECT id FROM tasks').get().id, task.id); } finally { snapshot.close(); }
});

test('旧数据库原位增加回收站字段，保留任务编号、提醒、历史和设置且可重复启动', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'office-migration-test-')); const databasePath = join(dir, 'office.sqlite');
  const legacy = new DatabaseSync(databasePath); const time = '2026-10-01T02:00:00.000Z'; let store;
  t.after(async () => { try { legacy.close(); } catch {} store?.close(); await rm(dir, { recursive: true, force: true }); });
  legacy.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE tasks (number INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,title TEXT NOT NULL,owner TEXT NOT NULL,startDate TEXT NOT NULL,dueDate TEXT NOT NULL,deliverable TEXT NOT NULL,description TEXT NOT NULL,priority TEXT NOT NULL,category TEXT NOT NULL,status TEXT NOT NULL,templateId TEXT,occurrenceDate TEXT,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,completedAt TEXT,UNIQUE(templateId,occurrenceDate));
    CREATE TABLE reminders (id TEXT PRIMARY KEY,taskId TEXT NOT NULL REFERENCES tasks(id),title TEXT NOT NULL,message TEXT NOT NULL,kind TEXT NOT NULL,recipients TEXT NOT NULL,read INTEGER NOT NULL DEFAULT 0,day TEXT NOT NULL,createdAt TEXT NOT NULL,UNIQUE(taskId,day,kind));
    CREATE TABLE events (id TEXT PRIMARY KEY,taskId TEXT,action TEXT NOT NULL,detail TEXT NOT NULL,actor TEXT NOT NULL,createdAt TEXT NOT NULL);`);
  legacy.prepare('INSERT INTO meta VALUES(?,?)').run('initialized', time);
  legacy.prepare('INSERT INTO meta VALUES(?,?)').run('settings', JSON.stringify({ adminName: '原管理员', reminderDays: 3 }));
  legacy.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(42, 'legacy-task', '原有任务', '原负责人', '2026-10-01', '2026-10-18', '原有成果', '原有说明', '高', '临时任务', '进行中', null, null, time, time, null);
  legacy.prepare('INSERT INTO reminders VALUES(?,?,?,?,?,?,?,?,?)').run('legacy-reminder', 'legacy-task', '原有提醒', '原有内容', '逾期', '["原负责人","原管理员"]', 0, '2026-10-19', time);
  legacy.prepare('INSERT INTO events VALUES(?,?,?,?,?,?)').run('legacy-event', 'legacy-task', '新增任务', '原有审计记录', '原管理员', time);
  const original = { ...legacy.prepare('SELECT * FROM tasks').get() }; legacy.close();
  store = new OfficeStore({ databasePath, seedDemo: true, now: () => new Date('2026-10-19T02:00:00Z') });
  const { deletedAt, submissionType, ...migrated } = store.db.prepare('SELECT * FROM tasks').get();
  assert.equal(deletedAt, null); assert.equal(submissionType, '文本'); assert.deepEqual(migrated, original);
  assert.equal(store.state().tasks.length, 1); assert.equal(store.state().reminders[0].id, 'legacy-reminder');
  assert.equal(store.state().events[0].detail, '原有审计记录'); assert.deepEqual(store.settings(), { adminName: '原管理员', reminderDays: 3 });
  assert.equal(store.createTask(taskInput()).number, 43);
  store.close(); store = new OfficeStore({ databasePath, seedDemo: true });
  assert.equal(store.state().tasks.length, 2); assert.equal(store.getTask('legacy-task').number, 42);
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

test('删除隐藏任务和提醒并停止调度与导出，保留审计和回收站，恢复后沿用状态并重新提醒', async t => {
  let now = new Date('2026-10-19T02:00:00Z'); const { store } = await fixture(t, { now: () => now });
  const task = store.createTask(taskInput({ title: '待删除的逾期任务', dueDate: '2026-10-18', status: '进行中' }));
  const remaining = store.createTask(taskInput({ title: '保留的任务', dueDate: '2026-10-25' }));
  assert.equal(store.run().reminded, 1); const reminderId = store.state().reminders[0].id;
  assert.deepEqual(store.deleteTask(task.id), { deleted: true, taskId: task.id });
  assert.deepEqual(store.state().tasks.map(item => item.id), [remaining.id]); assert.deepEqual(store.state().reminders, []);
  assert.equal(store.db.prepare('SELECT read FROM reminders WHERE id=?').get(reminderId).read, 1);
  assert.equal(store.trash().tasks[0].deletedAt, now.toISOString()); assert.equal(store.trash().tasks[0].status, '进行中');
  assert.equal(parseCsv(store.exportTasks()).length, 2); assert.doesNotMatch(store.exportTasks(), /待删除的逾期任务/);
  assert.throws(() => store.getTask(task.id), error => error.status === 404);
  assert.throws(() => store.updateTask(task.id, { title: '不允许修改' }), error => error.status === 404);
  assert.throws(() => store.deleteTask(task.id), error => error.status === 404);
  now = new Date('2026-10-20T02:00:00Z'); assert.equal(store.run().reminded, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS total FROM reminders').get().total, 1);
  const restored = store.restoreTask(task.id);
  assert.equal(restored.number, task.number); assert.equal(restored.status, '进行中'); assert.equal(restored.completedAt, null); assert.equal(restored.deletedAt, null);
  assert.equal(store.trash().tasks.length, 0); assert.equal(store.state().tasks.length, 2);
  const todayReminder = store.state().reminders.find(item => item.day === '2026-10-20');
  assert.equal(todayReminder.taskId, task.id); assert.equal(todayReminder.read, false); assert.equal(store.run().reminded, 0);
  assert.match(store.exportTasks(), /待删除的逾期任务/);
  for (const action of ['删除任务', '恢复任务']) assert.match(store.state().events.find(event => event.action === action).detail, /待删除的逾期任务/);
  assert.throws(() => store.restoreTask(task.id), error => error.status === 409);
  assert.throws(() => store.restoreTask('missing'), error => error.status === 404);
});

test('当日恢复复用已有提醒，已完成任务恢复后保留完成时间并保持提醒已读', async t => {
  const { store } = await fixture(t);
  const task = store.createTask(taskInput({ dueDate: '2026-10-19' })); store.run();
  const reminderId = store.state().reminders[0].id;
  store.deleteTask(task.id); store.restoreTask(task.id);
  assert.equal(store.state().reminders.length, 1); assert.equal(store.state().reminders[0].id, reminderId); assert.equal(store.state().reminders[0].read, false);
  const completed = store.completeTask(task.id, completionInput());
  store.deleteTask(task.id); const restored = store.restoreTask(task.id);
  assert.equal(restored.status, '已完成'); assert.equal(restored.completedAt, completed.completedAt); assert.equal(restored.isOverdue, false);
  assert.equal(store.state().reminders[0].read, true); assert.equal(store.run().reminded, 0);
});

test('删除周期任务保留模板与发生日，调度不会复生已删任务且未来周期照常生成', async t => {
  let now = new Date('2026-10-19T02:00:00Z'); const { store } = await fixture(t, { now: () => now });
  const template = store.createTemplate(templateInput({ nextDate: '2026-10-19', frequency: '每周', dueDays: 0 }));
  assert.equal(store.run().generated, 1); const task = store.state().tasks[0];
  store.updateTask(task.id, { status: '进行中' }); store.deleteTask(task.id);
  assert.equal(store.getTemplate(template.id).active, true);
  store.updateTemplate(template.id, { nextDate: '2026-10-19' });
  assert.deepEqual(store.run(), { generated: 0, reminded: 0, runAt: now.toISOString() });
  assert.equal(store.state().tasks.length, 0); assert.equal(store.trash().tasks.length, 1);
  now = new Date('2026-11-02T02:00:00Z'); assert.equal(store.run().generated, 2);
  assert.deepEqual(store.state().tasks.map(item => item.occurrenceDate).sort(), ['2026-10-26', '2026-11-02']);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS total FROM tasks').get().total, 3);
  const restored = store.restoreTask(task.id); assert.equal(restored.status, '进行中'); assert.equal(restored.templateId, template.id); assert.equal(restored.occurrenceDate, '2026-10-19');
  assert.equal(store.run().generated, 0); assert.equal(store.state().tasks.length, 3);
});

test('HTTP 删除与恢复要求同源 JSON，回收站读取与重复操作响应明确', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'office-delete-http-test-'));
  const app = createApplication({ host: '127.0.0.1', port: 0, dataDir: dir, seedDemo: false, scheduler: 'external', now: () => new Date('2026-10-19T02:00:00Z') });
  const address = await app.start(); const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const send = (path, method, headers = {}, body = '{}') => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body });
  const task = app.store.createTask(taskInput()); const path = `/api/tasks/${task.id}`;
  assert.equal((await send(path, 'DELETE', { Origin: 'https://other.example' })).status, 403);
  assert.equal((await send(path, 'DELETE', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await send(path, 'DELETE', { 'Sec-Fetch-Site': 'same-site' })).status, 403);
  assert.equal((await send(path, 'DELETE', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await send(path, 'DELETE', {}, '{broken')).status, 400); assert.equal(app.store.state().tasks.length, 1);
  const deleted = await send(path, 'DELETE', { Origin: base }); assert.equal(deleted.status, 200); assert.deepEqual(await deleted.json(), { deleted: true, taskId: task.id });
  assert.equal((await (await fetch(base + '/api/state')).json()).tasks.length, 0);
  const trash = await (await fetch(base + '/api/trash')).json(); assert.equal(trash.tasks.length, 1); assert.equal(trash.tasks[0].id, task.id); assert.ok(trash.tasks[0].deletedAt);
  assert.equal((await send(path, 'DELETE')).status, 404); assert.equal((await send(path, 'PATCH', {}, '{"status":"已完成"}')).status, 404);
  assert.equal((await send(path + '/restore', 'POST', { Origin: 'https://other.example' })).status, 403);
  const restored = await send(path + '/restore', 'POST', { Origin: base }); assert.equal(restored.status, 200); assert.equal((await restored.json()).task.id, task.id);
  assert.equal((await send(path + '/restore', 'POST')).status, 409);
  assert.equal((await send('/api/tasks/missing/restore', 'POST')).status, 404);
  assert.deepEqual(await (await fetch(base + '/api/trash')).json(), { tasks: [] });
});

test('HTTP 接口、同源防护、密钥校验、下载与静态文件边界', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'office-http-test-')); const publicDir = join(dir, 'public');
  const { mkdir } = await import('node:fs/promises'); await mkdir(publicDir); await writeFile(join(publicDir, 'index.html'), '<html lang="zh-CN"><body>中文平台</body></html>'); await writeFile(join(dir, 'secret.txt'), '禁止外泄');
  const app = createApplication({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'data'), publicDir, seedDemo: false, scheduler: 'external', automationKey: 'test-automation-key', now: () => new Date('2026-10-19T02:00:00Z') });
  const address = await app.start(); const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const send = (path, body, { method = 'POST', headers = {} } = {}) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const health = await (await fetch(base + '/api/health')).json();
  assert.equal(health.ok, true); assert.match(health.instanceId, /^[a-f0-9]{64}$/); assert.equal(health.runtime, process.version);
  assert.match(await (await fetch(base)).text(), /中文平台/);
  assert.equal((await fetch(base + '/%2e%2e%2fsecret.txt')).status, 404);
  assert.equal((await send('/api/tasks', taskInput(), { headers: { Origin: 'https://other.example' } })).status, 403);
  assert.equal((await fetch(base + '/api/tasks', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  const created = await send('/api/tasks', taskInput(), { headers: { Origin: base } }); assert.equal(created.status, 201); const { task } = await created.json();
  assert.equal((await send(`/api/tasks/${task.id}`, { status: '已完成' }, { method: 'PATCH' })).status, 400);
  assert.equal((await send(`/api/tasks/${task.id}/complete`, completionInput())).status, 200);
  assert.equal((await send('/api/automation/run', {})).status, 403);
  assert.equal((await send('/api/automation/run', {}, { headers: { 'x-automation-key': 'wrong' } })).status, 403);
  assert.equal((await send('/api/automation/run', {}, { headers: { 'x-automation-key': 'test-automation-key', Host: 'application:3080' } })).status, 200);
  assert.equal((await send('/api/run', {})).status, 200);
  const exported = await fetch(base + '/api/export/tasks'); assert.equal(exported.status, 200); assert.match(exported.headers.get('Content-Type'), /text\/csv/);
  const downloaded = await fetch(base + '/api/backup'); assert.equal(downloaded.status, 200); const backup = Buffer.from(await downloaded.arrayBuffer()); assert.equal(backup.subarray(0, 15).toString(), 'SQLite format 3');
  assert.equal((await send('/api/tasks/missing', {}, { method: 'PATCH' })).status, 404);
  assert.equal((await send('/api/tasks', taskInput({ title: '' }))).status, 400);
});

test('真实服务进程重启后保留任务和审计，启用模拟数据也不会重新填充', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'office-restart-test-')); const children = new Set();
  const serverPath = fileURLToPath(new URL('../server.mjs', import.meta.url));
  const stop = child => new Promise(resolveStop => { if (child.exitCode !== null || child.signalCode !== null) { children.delete(child); return resolveStop(); } child.once('exit', () => { children.delete(child); resolveStop(); }); child.kill(); });
  t.after(async () => { for (const child of children) await stop(child); await rm(dir, { recursive: true, force: true }); });
  const start = seed => new Promise((resolveStart, rejectStart) => {
    const child = spawn(process.execPath, [serverPath], { env: { ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir, SEED_DEMO: seed, SCHEDULER: 'external' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child); let output = ''; const timeout = setTimeout(() => { child.kill(); rejectStart(new Error('测试服务启动超时')); }, 10000);
    child.once('error', error => { clearTimeout(timeout); rejectStart(error); });
    child.once('exit', code => { clearTimeout(timeout); if (!/http:\/\/127\.0\.0\.1:\d+/.test(output)) rejectStart(new Error(`测试服务启动失败：${code} ${output}`)); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    child.stdout.on('data', chunk => { output += chunk.toString(); const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timeout); resolveStart({ child, base: match[0] }); } });
  });
  let instance = await start('0');
  const response = await fetch(instance.base + '/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(taskInput({ title: '重启保留任务' })) });
  assert.equal(response.status, 201); const { task } = await response.json(); await stop(instance.child);
  instance = await start('1');
  const state = await (await fetch(instance.base + '/api/state')).json();
  assert.equal(state.tasks.length, 1); assert.equal(state.tasks[0].id, task.id); assert.equal(state.templates.length, 0);
  assert.ok(state.events.some(event => event.taskId === task.id && event.action === '新增任务'));
  await stop(instance.child);
});
