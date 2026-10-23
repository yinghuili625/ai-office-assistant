import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createAiOffice } from '../public/ai.js';

const task = (id, title) => ({ id, number: 1, title, owner: '甲', startDate: '2026-10-01', dueDate: '2026-10-23', deliverable: '提交纪要', category: '临时任务', status: '待办', submissionType: '文本', attachments: [], createdAt: '2026-10-23T01:00:00Z' });
const flush = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, api) {
  // Exercise the actual page controller, markup and event handlers. This small
  // DOM surface does not claim browser layout or accessibility verification.
  const nodes = new Map(['#app', '#overlay-root', '#toast-root', '#completion-file-list'].map(key => [key, { innerHTML: '', append() {} }]));
  const listeners = new Map(), windowListeners = new Map();
  const document = { title: '', body: { style: {} }, activeElement: null, hidden: false,
    querySelector: selector => nodes.get(selector) || null,
    querySelectorAll: () => [], addEventListener: (name, handler) => listeners.set(name, handler),
    createElement: () => ({ remove() {} })
  };
  const calls = [], errors = [];
  const context = vm.createContext({
    document, location: { hash: '#tasks' }, window: { scrollTo() {}, addEventListener: (name, handler) => windowListeners.set(name, handler) },
    createAiOffice, createTaskWorkflow: () => ({ busy: false, hasUnsaved: false, reload: async () => {} }),
    URLSearchParams, URL, Blob, Intl, Date, console: { error: error => errors.push(error) },
    setInterval: () => 0, clearTimeout,
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; },
    requestAnimationFrame: fn => fn(),
    fetch: async (path, options) => { calls.push(path); return Response.json(await api(path, options)); }
  });
  const source = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
  new vm.Script(source, { filename: 'public/app.js' }).runInContext(context);
  await flush();
  t.after(() => assert.deepEqual(errors, []));
  const click = async (action, data = {}) => { const button = { dataset: { action, ...data } }; await listeners.get('click')({ target: { closest: () => button } }); await flush(); };
  return { nodes, context, document, listeners, calls, click };
}

function state(page = 1) {
  return { tasks: [task(`page-${page}`, `第${page}页任务`)], templates: [], reminders: [], events: [], owners: ['甲', '其他页负责人'], settings: { adminName: '管理员', reminderDays: 1 },
    summary: { total: 23, pending: 20, doing: 2, done: 1, overdue: 8, unread: 74, weekDone: 1, weekDueCount: 4, weekDueDone: 1 },
    pagination: { page, pageSize: 10, total: 23, pageCount: 3 }, reminderPagination: { page: 1, pageCount: 2, total: 74 }, upcoming: [],
    system: { scheduler: '本地定时器', storage: { used: 1024, limit: 4 * 1024 ** 3 }, pendingSchedules: 2 } };
}

test('实际页面从服务器换页，显示全量汇总和全部负责人，搜索刷新后保持输入焦点', async t => {
  const ui = await fixture(t, async path => state(Number(new URL(path, 'http://localhost').searchParams.get('page')) || 1));
  assert.match(ui.nodes.get('#app').innerHTML, /共 23 项工作记录/); assert.match(ui.nodes.get('#app').innerHTML, /其他页负责人/);
  assert.match(ui.nodes.get('#app').innerHTML, /74条未读/);
  await ui.click('task-page', { pageNumber: '2' });
  assert.ok(ui.calls.some(path => new URL(path, 'http://localhost').searchParams.get('page') === '2'));
  assert.match(ui.nodes.get('#app').innerHTML, /第2页任务/); assert.doesNotMatch(ui.nodes.get('#app').innerHTML, /第1页任务/);
  const search = { id: 'task-search', selectionStart: 2, selectionEnd: 2, focus() { this.focused = true; }, setSelectionRange(start, end) { this.selection = [start, end]; } };
  ui.nodes.set('#task-search', search); ui.document.activeElement = search;
  await ui.click('filter', { filter: '待办' });
  assert.equal(search.focused, true); assert.deepEqual(search.selection, [2, 2]);
  const query = new URL(ui.calls.at(-1), 'http://localhost').searchParams; assert.equal(query.get('filter'), '待办'); assert.equal(query.get('page'), '1');
});

test('当前页外任务读取最新详情后可编辑、直接上传，历史记录支持继续读取', async t => {
  const outside = task('outside', '其他页的真实任务');
  const ui = await fixture(t, async path => {
    if (path.startsWith('/api/state')) return state();
    if (path.startsWith('/api/tasks/outside')) { const page = Number(new URL(path, 'http://localhost').searchParams.get('eventPage')) || 1; return { task: outside, events: [{ action: '历史操作', detail: page === 1 ? '最新记录' : '更早记录', actor: '甲', createdAt: outside.createdAt }], pagination: { page, pageCount: 2, total: 51 } }; }
    assert.fail(`意外调用：${path}`);
  });
  await ui.click('detail', { id: 'outside' }); assert.match(ui.nodes.get('#overlay-root').innerHTML, /其他页的真实任务/);
  await ui.click('detail-events-more', { id: 'outside' });
  assert.match(ui.nodes.get('#overlay-root').innerHTML, /最新记录/); assert.match(ui.nodes.get('#overlay-root').innerHTML, /更早记录/);
  outside.title = '其他页修改后的最新任务';
  await ui.click('edit-task', { id: 'outside' }); await flush();
  assert.match(ui.nodes.get('#overlay-root').innerHTML, /value="其他页修改后的最新任务"/);
  await vm.runInContext("completionForm('outside')", ui.context);
  assert.match(ui.nodes.get('#overlay-root').innerHTML, /其他页修改后的最新任务/); assert.match(ui.nodes.get('#overlay-root').innerHTML, /completion-form/);
});

test('提醒分页和设置容量展示使用服务端结果', async t => {
  const ui = await fixture(t, async path => { const result = state(); const page = Number(new URL(path, 'http://localhost').searchParams.get('reminderPage')) || 1; result.reminderPagination.page = page; result.reminders = [{ id: `r-${page}`, taskId: 'outside', title: `提醒第${page}页`, message: '到期', recipients: ['甲'], createdAt: '2026-10-23T01:00:00Z', read: false, kind: '到期' }]; return result; });
  await ui.click('navigate', { page: 'reminders' }); await flush();
  assert.match(ui.nodes.get('#app').innerHTML, /提醒第1页/); assert.match(ui.nodes.get('#app').innerHTML, /共 74 条/);
  await ui.click('reminder-page', { pageNumber: '2' }); assert.match(ui.nodes.get('#app').innerHTML, /提醒第2页/);
  await ui.click('navigate', { page: 'settings' }); await flush();
  assert.match(ui.nodes.get('#app').innerHTML, /1 千字节 \/ 4.0 GiB/); assert.match(ui.nodes.get('#app').innerHTML, /2 项（每次最多补建 100 项任务）/);
});
