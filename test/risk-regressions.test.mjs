import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OfficeStore } from '../lib/office.mjs';
import { AiService } from '../lib/ai.mjs';
import { TaskWorkflow } from '../lib/task-workflow.mjs';
import { supportedNode } from '../lib/runtime.mjs';
import { advanceOccurrence, addDays } from '../lib/dates.mjs';
import { createApplication } from '../server.mjs';

const now = () => new Date('2026-10-23T02:00:00Z');
const taskInput = (extra = {}) => ({ title: '风险回归任务', owner: '甲', startDate: '2026-10-01', dueDate: '2026-10-23', deliverable: '提交已核对的纪要', ...extra });
const templateInput = (extra = {}) => ({ title: '周期风险回归', owner: '甲', nextDate: '2026-10-01', dueDays: 1, frequency: '每周', deliverable: '提交台账', ...extra });
const file = (name, content) => ({ name, contentBase64: Buffer.from(content).toString('base64') });
const config = { enabled: true, baseUrl: 'https://first.synthetic.invalid/v1', model: 'synthetic-chat', transcriptionModel: 'synthetic-audio', apiKey: 'synthetic-key-a' };
const chat = () => new Response(JSON.stringify({ choices: [{ message: { content: '虚构纪要，待核实具体日期。' } }] }));

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'office-risk-regression-'));
  const store = new OfficeStore({ databasePath: join(dir, 'office.sqlite'), seedDemo: false, now, ...options });
  const calls = [], ai = new AiService({ store, dataDir: dir, fetchImpl: async (...args) => { calls.push(args); return chat(); } });
  const workflow = new TaskWorkflow({ store, ai });
  t.after(async () => { await ai.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, store, ai, workflow, calls };
}

test('启动只接受已修补的 Node 运行时版本', () => {
  for (const version of ['20.19.0', '22.20.0', '24.15.0', '24.22.0', '25.99.99', '26.12.0', 'invalid']) assert.equal(supportedNode(version), false, version);
  for (const version of ['v24.22.1', '24.23.0', '26.12.1', '26.13.0']) assert.equal(supportedNode(version), true, version);
});

test('模型发送同意绑定配置版本，变更、密钥更新和服务重启均使旧确认失效', async t => {
  const { store, dir, ai, calls } = await fixture(t);
  const first = ai.updateSettings(config).configRevision;
  assert.match(first, /^[a-f0-9-]{36}$/);
  assert.equal(ai.updateSettings({ model: config.model }).configRevision, first, '无变化保存不使确认失效');
  assert.throws(() => ai.updateSettings({ baseUrl: 'http://untrusted.invalid/v1' }));
  assert.equal(ai.settings().configRevision, first, '失败保存不改变配置版本');
  for (const body of [{ consent: true }, { consent: true, configRevision: 'fabricated' }]) await assert.rejects(ai.testConnection(body), error => error.status === 409 && /重新|过期/.test(error.message));
  assert.equal(calls.length, 0);
  await ai.testConnection({ consent: true, configRevision: first });
  assert.equal(calls.length, 1); assert.match(calls[0][0], /^https:\/\/first\.synthetic\.invalid\//);
  const changed = ai.updateSettings({ baseUrl: 'https://second.synthetic.invalid/v1', apiKey: 'synthetic-key-b' }).configRevision;
  assert.notEqual(changed, first);
  const material = ai.saveMaterial({ title: '会议素材', kind: '素材', content: '本次仅确认乙负责核对。' });
  await assert.rejects(ai.generate({ title: '初稿', templateId: 'builtin-minutes', materialIds: [material.id], consent: true, configRevision: first }), error => error.status === 409);
  assert.equal(calls.length, 1); assert.equal(ai.state().documents.length, 0);
  const keyChanged = ai.updateSettings({ apiKey: 'synthetic-key-c' }).configRevision;
  assert.notEqual(keyChanged, changed);
  const reopened = new AiService({ store, dataDir: dir, fetchImpl: async () => assert.fail('旧确认不应发送') });
  t.after(() => reopened.close());
  assert.notEqual(reopened.settings().configRevision, keyChanged);
  await assert.rejects(reopened.testConnection({ consent: true, configRevision: keyChanged }), error => error.status === 409);
  await ai.generate({ title: '初稿', templateId: 'builtin-minutes', materialIds: [material.id], consent: true, configRevision: keyChanged });
  assert.equal(calls.length, 2); assert.match(calls[1][0], /^https:\/\/second\.synthetic\.invalid\//);
  assert.equal(calls[1][1].headers.Authorization, 'Bearer synthetic-key-c');
});

test('HTTP 起草、模板、录音和后台识别入口拒绝缺少或过期的发送确认', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'office-risk-http-')), calls = [];
  const app = createApplication({ host: '127.0.0.1', port: 0, dataDir: dir, seedDemo: false, scheduler: 'external', now, serverChanSendKey: '', aiFetch: async (...args) => { calls.push(args); return chat(); } });
  const address = await app.start(), base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const send = (path, body) => fetch(base + path, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const task = app.store.createTask(taskInput()), path = `/api/tasks/${task.id}`;
  const audioBytes = Buffer.alloc(44); audioBytes.write('RIFF'); audioBytes.write('WAVE', 8);
  const source = app.workflow.addSource(task.id, { file: file('会议录音.wav', audioBytes) }).source;
  const material = app.ai.saveMaterial({ title: '事实素材', kind: '素材', content: '甲负责核实。', taskId: task.id });
  const old = app.ai.updateSettings(config).configRevision;
  app.ai.updateSettings({ model: 'another-synthetic-model' });
  const requests = [
    ['/api/ai/test', {}], ['/api/ai/templates/analyze', { title: '历史', content: '一、会议情况' }],
    ['/api/ai/documents', { title: '初稿', templateId: 'builtin-minutes', materialIds: [material.id] }],
    ['/api/ai/transcribe', { file: file('会议录音.wav', audioBytes) }], ['/api/ai/transcribe-jobs', { file: file('会议录音.wav', audioBytes) }],
    [path + '/draft', { title: '初稿', templateId: 'builtin-minutes', materialIds: [material.id] }],
    [path + `/sources/${source.id}/extract`, {}], [path + `/sources/${source.id}/extract-jobs`, {}]
  ];
  for (const [route, body] of requests) for (const revision of [undefined, old]) {
    const response = await send(route, { ...body, consent: true, ...(revision ? { configRevision: revision } : {}) });
    assert.equal(response.status, 409, `${route}: ${await response.text()}`);
  }
  assert.equal(calls.length, 0); assert.equal(app.ai.state().documents.length, 0);
  assert.equal(app.workflow.workspace(task.id).sourceFiles[0].materialId, null);
  const response = await send('/api/ai/test', { consent: true, configRevision: app.ai.settings().configRevision });
  assert.equal(response.status, 200, await response.text()); assert.equal(calls.length, 1);
});

test('推迟截止日后即时清除旧未读提醒，改派和改名刷新当前内容，恢复到期后可再提醒', async t => {
  const { store } = await fixture(t);
  const task = store.createTask(taskInput()); store.run();
  assert.equal(store.pageState().summary.unread, 1);
  store.updateTask(task.id, { dueDate: '2026-12-01' });
  assert.equal(store.pageState().summary.unread, 0); store.run(); assert.equal(store.pageState().summary.unread, 0);
  store.updateTask(task.id, { dueDate: '2026-10-22', owner: '乙', title: '重新核对的任务' });
  const unread = store.state().reminders.filter(r => !r.read);
  assert.equal(unread.length, 1); assert.equal(unread[0].kind, '逾期');
  assert.match(unread[0].message, /2026-10-22/); assert.match(unread[0].title, /重新核对的任务/);
  assert.deepEqual(unread[0].recipients, ['乙', '管理员']);
  assert.equal(store.run().reminded, 0, '重复检查不新增重复提醒');
});

test('缩短提前提醒时间使超出范围的旧提醒已读，到期时继续生成有效提醒', async t => {
  let date = '2026-10-23'; const { store } = await fixture(t, { now: () => new Date(date + 'T02:00:00Z') });
  const task = store.createTask(taskInput({ dueDate: '2026-10-28' }));
  store.updateSettings({ reminderDays: 7 }); store.run(); assert.equal(store.pageState().summary.unread, 1);
  store.updateSettings({ reminderDays: 1 }); assert.equal(store.pageState().summary.unread, 0);
  store.run(); assert.equal(store.pageState().summary.unread, 0);
  date = '2026-10-28'; store.run();
  assert.equal(store.state().reminders.filter(r => !r.read && r.taskId === task.id)[0].kind, '到期');
});

test('新建及导入拒绝错误的百年前周期日期，批量失败全部回滚', async t => {
  const { store } = await fixture(t);
  assert.throws(() => store.createTemplate(templateInput({ nextDate: '1900-01-01' })), /一年前/);
  assert.equal(store.state().templates.length, 0);
  const csv = '任务名称,负责人,首次开始日期,完成天数,周期,交付要求,提交形式\n有效任务,甲,2026-10-01,1,每周,交付,文本\n错误年份,甲,1900-01-01,1,每周,交付,文本';
  assert.throws(() => store.importTemplates({ csv }), /第 3 行.*一年前/);
  assert.equal(store.state().templates.length, 0); assert.equal(store.state().events.length, 0);
  const template = store.createTemplate(templateInput());
  assert.throws(() => store.updateTemplate(template.id, { nextDate: '1900-01-01' }), /一年前/);
  assert.equal(store.getTemplate(template.id).nextDate, '2026-10-01');
});

test('已有古老规则跳过一年前周期，单次最多 100 项，分批继续且无重复', async t => {
  const { store } = await fixture(t);
  const templates = [1, 2, 3].map(n => store.createTemplate(templateInput({ title: `历史规则 ${n}` })));
  for (const template of templates) store.db.prepare('UPDATE templates SET nextDate=? WHERE id=?').run('1900-01-01', template.id);
  assert.equal(store.run().generated, 100);
  assert.equal(store.state().tasks.length, 100);
  assert.ok(store.state().tasks.every(task => task.occurrenceDate >= '2025-10-23'));
  assert.ok(store.pageState().system.pendingSchedules > 0);
  assert.equal(store.run().generated, 56);
  assert.equal(store.run().generated, 0);
  const rows = store.state().tasks;
  assert.equal(rows.length, 156); assert.equal(new Set(rows.map(row => `${row.templateId}:${row.occurrenceDate}`)).size, 156);
  assert.equal(store.pageState().system.pendingSchedules, 0);
  assert.ok(store.state().events.some(event => event.action === '周期历史归档提示'));
});

test('快速跨越旧周期保留月底、季度、闰日及周锚点', () => {
  for (const [date, frequency, anchor, earliest, expected] of [
    ['1900-01-31', '每月', 31, '2026-02-01', '2026-02-28'],
    ['1900-01-31', '每月', 31, '2026-03-01', '2026-03-31'],
    ['2020-02-29', '每年', 29, '2027-03-01', '2028-02-29'],
    ['2000-01-31', '每季度', 31, '2026-02-01', '2026-04-30'],
    ['1900-01-01', '每周', 1, '2026-10-23', '2026-10-26']
  ]) assert.equal(advanceOccurrence(date, frequency, anchor, earliest), expected);
});

test('文件累计容量包含原件、交付及软删除内容，超额上传或提交均无半成品', async t => {
  const { store, workflow, ai } = await fixture(t, { maxStoredBytes: 160 });
  const task = store.createTask(taskInput());
  const content = 'a'.repeat(80), source = workflow.addSource(task.id, { file: file('原件.txt', content) });
  assert.deepEqual(store.storageUsage(), { used: 80, limit: 160 });
  const count = ai.state().materials.length;
  assert.throws(() => workflow.addSource(task.id, { file: file('超额.txt', 'b'.repeat(81)) }), error => error.status === 413);
  assert.equal(ai.state().materials.length, count); assert.equal(workflow.workspace(task.id).sourceFiles.length, 1);
  workflow.deleteSource(task.id, source.source.id);
  assert.equal(store.storageUsage().used, 80, '软删除仍占用磁盘，不能绕过限额');
  assert.throws(() => store.completeTask(task.id, { confirmed: true, files: [file('超额成果.txt', 'b'.repeat(81))] }), error => error.status === 413);
  assert.equal(store.getTask(task.id).status, '进行中'); assert.equal(store.getTask(task.id).attachments.length, 0);
  store.completeTask(task.id, { confirmed: true, files: [file('成果.txt', 'b'.repeat(80))] });
  assert.equal(store.getTask(task.id).status, '已完成'); assert.equal(store.storageUsage().used, 160);
  const other = store.createTask(taskInput({ title: '新任务' }));
  assert.throws(() => workflow.addSource(other.id, { file: file('再加.txt', '1') }), error => error.status === 413);
  assert.equal(store.getTask(other.id).status, '待办');
});

test('任务和提醒由服务端分页，汇总不随当前页丢失，搜索可查更早任务及完整详情历史', async t => {
  const { store, ai } = await fixture(t);
  const tasks = Array.from({ length: 115 }, (_, i) => store.createTask(taskInput({ title: i === 0 ? '早期会议资料' : `批量任务 ${i}`, owner: i % 2 ? '甲' : '乙', dueDate: addDays('2026-10-01', i % 23) })));
  store.completeTask(tasks[1].id, { confirmed: true, files: [file('成果.txt', '已核对。')] }); store.run();
  const first = store.pageState({ pageSize: 10 }), second = store.pageState({ pageSize: 10, page: 2 });
  assert.equal(first.tasks.length, 10); assert.equal(first.pagination.total, 115); assert.equal(first.summary.total, 115);
  assert.equal(first.summary.done, 1); assert.equal(first.summary.weekDone, 1); assert.equal(first.summary.unread, 114);
  assert.equal(first.reminders.length, 50); assert.equal(first.events.length, 50);
  assert.ok(second.tasks.every(row => !first.tasks.some(old => old.id === row.id)));
  assert.equal(store.pageState({ pageSize: 10, page: 999 }).tasks.length, 5);
  assert.equal(store.pageState({ q: '早期会议' }).tasks[0].id, tasks[0].id);
  assert.ok(store.pageState({ owner: '乙', filter: '已逾期' }).tasks.every(row => row.owner === '乙' && row.isOverdue));
  assert.equal(store.pageState({ filter: '已完成' }).pagination.total, 1);
  const nextReminders = store.pageState({ reminderPage: 2, reminderFilter: '未读' });
  assert.equal(nextReminders.reminders.length, 50); assert.equal(nextReminders.reminderPagination.total, 114);
  assert.ok(nextReminders.reminders.every(row => !first.reminders.some(old => old.id === row.id)));
  for (const options of [{ pageSize: 1000 }, { page: -1 }, { filter: "' OR 1=1" }, { q: 'a'.repeat(201) }]) assert.throws(() => store.pageState(options));
  for (let i = 0; i < 63; i++) store.event('历史更新', `第 ${i} 次核对`, tasks[0].id);
  const history = store.taskDetails(tasks[0].id), earlier = store.taskDetails(tasks[0].id, 2);
  assert.equal(history.events.length, 50); assert.equal(earlier.events.length, 14); assert.equal(history.pagination.total, 64);
  assert.ok(earlier.events.every(row => !history.events.some(old => old.id === row.id)));
  assert.equal(store.taskOptions().length, 100); assert.equal(store.taskOptions('早期会议')[0].id, tasks[0].id);
  assert.ok(store.taskOptions('', tasks[0].id).some(row => row.id === tasks[0].id));
  ai.saveMaterial({ title: '关联素材', kind: '素材', content: '事实正文', taskId: tasks[0].id });
  assert.equal(ai.state().materials[0].taskTitle, '早期会议资料');
});

test('实例身份在健康检查中返回，分页接口与流式备份保留数据且清理临时文件', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'office-risk-backup-'));
  const identity = 'synthetic-instance-a';
  const app = createApplication({ host: '127.0.0.1', port: 0, dataDir: dir, seedDemo: false, scheduler: 'external', serverChanSendKey: '', now, instanceId: identity });
  const address = await app.start(), base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const task = app.store.createTask(taskInput());
  app.store.completeTask(task.id, { confirmed: true, files: [file('成果.txt', '已按要求核对。')] });
  assert.deepEqual(await (await fetch(base + '/api/health')).json(), { ok: true, instanceId: identity, runtime: process.version });
  const state = await (await fetch(base + '/api/state?pageSize=1')).json(); assert.equal(state.pagination.pageSize, 1); assert.equal(state.summary.total, 1);
  assert.equal((await (await fetch(base + '/api/tasks/options')).json()).tasks[0].id, task.id);
  assert.equal((await (await fetch(base + `/api/tasks/${task.id}`)).json()).task.status, '已完成');
  assert.equal((await fetch(base + '/api/state?pageSize=1000')).status, 400);
  const directories = async () => (await readdir(tmpdir())).filter(name => name.startsWith('office-backup-')).sort();
  const before = await directories(), response = await fetch(base + '/api/backup');
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/vnd.sqlite3');
  const content = Buffer.from(await response.arrayBuffer()); assert.equal(content.length, Number(response.headers.get('content-length')));
  assert.equal(content.subarray(0, 16).toString(), 'SQLite format 3\0');
  const backup = join(dir, 'restored.sqlite'); await writeFile(backup, content);
  const restored = new DatabaseSync(backup, { readOnly: true });
  try { assert.equal(restored.prepare('SELECT status FROM tasks WHERE id=?').get(task.id).status, '已完成'); assert.equal(Buffer.from(restored.prepare('SELECT content FROM attachments WHERE taskId=?').get(task.id).content).toString(), '已按要求核对。'); }
  finally { restored.close(); }
  // Stream completion and cleanup happen just after the client receives the last chunk.
  for (let i = 0; i < 50 && JSON.stringify(await directories()) !== JSON.stringify(before); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(await directories(), before);
  assert.equal((await readFile(backup)).length, content.length);
});
