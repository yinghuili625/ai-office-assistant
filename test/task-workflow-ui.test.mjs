import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskWorkflow } from '../public/task-workflow.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function workspace(id, title, owner, content) {
  const documentId = `${id}-document`;
  return {
    task: { id, title, owner, dueDate: '2026-10-23', deliverable: `${title}的交付要求`, status: '进行中', submissionType: '文本', attachments: [] },
    settings: { enabled: true, baseUrl: 'https://first-model.example/v1', model: 'first-chat', configRevision: 'model-revision-a' },
    templates: [{ id: 'builtin-minutes', name: '会议纪要模板', content: '一、会议情况\n二、议定事项' }],
    materials: [], sourceFiles: [], submissions: [],
    documents: [{ id: documentId, title: `${title}草稿`, revision: 1, updatedAt: '2026-10-20T03:00:00Z' }],
    document: { id: documentId, title: `${title}草稿`, content, revision: 1, originalContent: content, createdAt: '2026-10-20T03:00:00Z', sources: [] }
  };
}

function fixture(t, api) {
  // These tests exercise the real workflow state without a browser or DOM library.
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector: () => null } });
  t.after(() => {
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor);
    else delete globalThis.document;
  });
  return createTaskWorkflow({
    api, esc, icon: () => '',
    action: (name, label, cls = '', extra = '') => `<button class="${cls}" data-action="${name}" ${extra}>${label}</button>`,
    option: (value, selected, label = value) => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`,
    timeText: value => value || '', badge: task => esc(task.status),
    toast: () => {}, rerender: () => {}, onTaskChange: async () => {},
    openTaskForm: () => {}, openRecords: () => {}, openCompletion: () => {}, navigate: () => {}
  });
}

test('返回同一任务时更新交付要求和模型目的地，同时保留未保存正文', async t => {
  const state = workspace('task-a', '项目例会', '原负责人', '已保存的会议正文。');
  let workspaceReads = 0, documentReads = 0;
  const workflow = fixture(t, async path => {
    if (path === '/api/tasks/task-a/workspace') { workspaceReads++; return structuredClone(state); }
    if (path === '/api/ai/documents/task-a-document') { documentReads++; return { document: structuredClone(state.document) }; }
    assert.fail(`不应调用接口：${path}`);
  });
  await workflow.open('task-a');
  workflow.input({ name: 'documentContent', value: '未保存的人工修改：甲负责三日内核对台账。' });
  assert.equal(workflow.hasUnsaved, true);

  // Simulate editing the task and model settings after returning to the task list.
  state.task.owner = '新负责人';
  state.task.deliverable = '新的交付要求：需补充责任人与截止日期。';
  state.settings.baseUrl = 'https://updated-model.example/v1';
  state.settings.model = 'updated-chat';
  await workflow.open('task-a');

  const html = workflow.render();
  assert.equal(workspaceReads, 2);
  assert.equal(documentReads, 1, '刷新要求不应重新读取文档并覆盖人工修改');
  assert.match(html, /负责人：新负责人/);
  assert.match(html, /新的交付要求：需补充责任人与截止日期/);
  assert.match(html, /updated-model\.example/);
  assert.match(html, /updated-chat/);
  assert.doesNotMatch(html, /原负责人|first-model\.example|first-chat/);
  assert.match(html, /<textarea[^>]*name="documentContent"[^>]*>未保存的人工修改：甲负责三日内核对台账。<\/textarea>/);
  assert.equal(workflow.hasUnsaved, true);
});

test('较早任务的文档迟到时不覆盖当前任务的草稿', async t => {
  const first = workspace('task-a', '甲任务', '甲负责人', '甲任务私有正文，不应显示在乙任务。');
  const second = workspace('task-b', '乙任务', '乙负责人', '乙任务的正确正文。');
  const firstDocumentRequested = deferred(), firstDocumentResponse = deferred();
  const workflow = fixture(t, async path => {
    if (path === '/api/tasks/task-a/workspace') return structuredClone(first);
    if (path === '/api/tasks/task-b/workspace') return structuredClone(second);
    if (path === '/api/ai/documents/task-a-document') {
      firstDocumentRequested.resolve();
      return firstDocumentResponse.promise;
    }
    if (path === '/api/ai/documents/task-b-document') return { document: structuredClone(second.document) };
    assert.fail(`不应调用接口：${path}`);
  });

  const firstOpening = workflow.open('task-a');
  await firstDocumentRequested.promise;
  await workflow.open('task-b');
  assert.match(workflow.render(), /乙任务的正确正文/);

  firstDocumentResponse.resolve({ document: structuredClone(first.document) });
  await firstOpening;

  const html = workflow.render();
  assert.equal(workflow.taskId, 'task-b');
  assert.match(html, /<h1>乙任务<\/h1>/);
  assert.match(html, /负责人：乙负责人/);
  assert.match(html, /value="乙任务草稿"/);
  assert.match(html, /<textarea[^>]*name="documentContent"[^>]*>乙任务的正确正文。<\/textarea>/);
  assert.doesNotMatch(html, /甲任务|甲负责人|甲任务私有正文/);
  assert.equal(workflow.hasUnsaved, false);
});

test('甲乙任务来回切换保留各自的未保存正文、文字素材和本次模板', async t => {
  const states = { a: workspace('task-a', '甲任务', '甲负责人', '甲已保存正文'), b: workspace('task-b', '乙任务', '乙负责人', '乙已保存正文') };
  const workflow = fixture(t, async path => {
    for (const state of Object.values(states)) {
      if (path === `/api/tasks/${state.task.id}/workspace`) return structuredClone(state);
      if (path === `/api/ai/documents/${state.document.id}`) return { document: structuredClone(state.document) };
    }
    assert.fail(`不应调用接口：${path}`);
  });
  await workflow.open('task-a');
  workflow.input({ name: 'documentContent', value: '甲任务未保存的人工修改' });
  await workflow.onAction('material-new', { dataset: {} });
  workflow.input({ name: 'materialContent', value: '甲任务未保存的文字资料' });
  workflow.input({ name: 'templateContent', value: '甲任务专用本次模板' });
  await workflow.open('task-b');
  assert.equal(workflow.hasUnsaved, true, '离开甲任务仍应触发刷新或关闭前的未保存提示');
  assert.doesNotMatch(workflow.render(), /甲任务未保存/);
  workflow.input({ name: 'documentContent', value: '乙任务未保存的人工修改' });
  await workflow.open('task-a');
  let html = workflow.render();
  assert.match(html, /甲任务未保存的人工修改/); assert.match(html, /甲任务未保存的文字资料/); assert.match(html, /甲任务专用本次模板/);
  assert.doesNotMatch(html, /乙任务未保存/);
  await workflow.open('task-b'); html = workflow.render();
  assert.match(html, /乙任务未保存的人工修改/); assert.doesNotMatch(html, /甲任务未保存/);
});

test('甲任务的工作区刷新迟到，不会混入已经打开的乙任务', async t => {
  const first = workspace('task-a', '甲任务', '甲负责人', '甲正文');
  const second = workspace('task-b', '乙任务', '乙负责人', '乙正确正文');
  const requested = deferred(), response = deferred(); let reads = 0;
  const workflow = fixture(t, async path => {
    if (path === '/api/tasks/task-a/workspace') { if (++reads === 1) return structuredClone(first); requested.resolve(); return response.promise; }
    if (path === '/api/tasks/task-b/workspace') return structuredClone(second);
    if (path === '/api/ai/documents/task-a-document') return { document: structuredClone(first.document) };
    if (path === '/api/ai/documents/task-b-document') return { document: structuredClone(second.document) };
    assert.fail(`不应调用接口：${path}`);
  });
  await workflow.open('task-a');
  const reload = workflow.reload(); await requested.promise;
  await workflow.open('task-b'); response.resolve(structuredClone(first)); await reload;
  const html = workflow.render();
  assert.equal(workflow.taskId, 'task-b'); assert.match(html, /<h1>乙任务<\/h1>/); assert.match(html, /乙正确正文/);
  assert.doesNotMatch(html, /甲任务|甲负责人|甲正文/);
});

test('同意服务甲后自动保存素材发现配置变成乙，保留素材并阻止识别和生成', async t => {
  const state = workspace('task-a', '甲任务', '甲负责人', '原正文'), writes = [];
  const workflow = fixture(t, async (path, options) => {
    if (path === '/api/tasks/task-a/workspace') return structuredClone(state);
    if (path === '/api/ai/documents/task-a-document') return { document: structuredClone(state.document) };
    if (path === '/api/ai/materials') {
      const body = JSON.parse(options.body); writes.push({ path, body });
      state.materials = [{ id: 'new-material', title: body.title, kind: '素材' }];
      state.settings = { ...state.settings, baseUrl: 'https://second-model.example/v1', model: 'second-chat', configRevision: 'model-revision-b' };
      return { material: { id: 'new-material', ...body } };
    }
    assert.fail(`未经重新确认不应调用：${path}`);
  });
  await workflow.open('task-a'); await workflow.onAction('material-new', { dataset: {} });
  workflow.input({ name: 'materialContent', value: '会议真实文字，不能发往服务乙。' });
  await workflow.change({ name: 'generateConsent', checked: true });
  await workflow.onAction('generate', { dataset: {} });
  assert.equal(writes.length, 1); assert.equal(writes[0].path, '/api/ai/materials');
  const html = workflow.render();
  assert.match(html, /模型配置已变化/); assert.match(html, /second-model\.example/); assert.match(html, /会议真实文字，不能发往服务乙。/);
  assert.doesNotMatch(html, /name="generateConsent" checked/);
});

test('配置未变化时自动保存后仍携带用户确认的版本正常起草', async t => {
  const state = workspace('task-a', '甲任务', '甲负责人', '原正文'), drafts = [];
  const generated = { ...state.document, id: 'new-draft', title: '新初稿', content: '新生成正文' };
  const workflow = fixture(t, async (path, options) => {
    if (path === '/api/tasks/task-a/workspace') return structuredClone(state);
    if (path === '/api/ai/documents/task-a-document') return { document: structuredClone(state.document) };
    if (path === '/api/ai/materials') { const body = JSON.parse(options.body); state.materials = [{ id: 'new-material', title: body.title, kind: '素材' }]; return { material: { id: 'new-material', ...body } }; }
    if (path === '/api/tasks/task-a/draft') { drafts.push(JSON.parse(options.body)); state.documents.unshift(generated); return { document: generated }; }
    if (path === '/api/ai/documents/new-draft') return { document: generated };
    assert.fail(`不应调用：${path}`);
  });
  await workflow.open('task-a'); await workflow.onAction('material-new', { dataset: {} });
  workflow.input({ name: 'materialContent', value: '本次会议记录' });
  await workflow.change({ name: 'generateConsent', checked: true }); await workflow.onAction('generate', { dataset: {} });
  assert.equal(drafts.length, 1); assert.equal(drafts[0].configRevision, 'model-revision-a');
  assert.deepEqual(drafts[0].materialIds, ['new-material']); assert.match(workflow.render(), /新生成正文/);
});

test('起草后的刷新等待期间切到乙任务，不再向乙任务装入甲初稿', async t => {
  const first = workspace('task-a', '甲任务', '甲负责人', '甲正文'), second = workspace('task-b', '乙任务', '乙负责人', '乙正确正文');
  first.materials = [{ id: 'material-a', title: '甲素材', kind: '素材' }];
  const requested = deferred(), response = deferred(); let reads = 0;
  const workflow = fixture(t, async path => {
    if (path === '/api/tasks/task-a/workspace') { if (++reads === 1) return structuredClone(first); requested.resolve(); return response.promise; }
    if (path === '/api/tasks/task-b/workspace') return structuredClone(second);
    if (path === '/api/ai/documents/task-a-document') return { document: structuredClone(first.document) };
    if (path === '/api/ai/documents/task-b-document') return { document: structuredClone(second.document) };
    if (path === '/api/tasks/task-a/draft') return { document: { id: 'new-a-draft' } };
    assert.fail(`任务切换后不应继续读取甲文档：${path}`);
  });
  await workflow.open('task-a'); await workflow.change({ name: 'generateConsent', checked: true });
  const generation = workflow.onAction('generate', { dataset: {} }); await requested.promise;
  await workflow.open('task-b'); response.resolve(structuredClone(first)); await generation;
  assert.equal(workflow.taskId, 'task-b'); assert.equal(workflow.busy, false);
  assert.match(workflow.render(), /<h1>乙任务<\/h1>/); assert.match(workflow.render(), /乙正确正文/);
  assert.doesNotMatch(workflow.render(), /甲任务|甲素材|甲正文/);
});
