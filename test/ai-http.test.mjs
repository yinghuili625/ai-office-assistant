import { currentModelConsent } from '../test-support/consent.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../server.mjs';
import { createDocx, extractTextFile } from '../lib/ai-files.mjs';

const key = 'only-a-synthetic-ai-key';
const draft = '# 会议纪要\n\n## 会议情况\n2026年10月20日，甲主持会议。\n\n## 决议事项\n| 事项 | 负责人 |\n| --- | --- |\n| 核对台账 | 乙 |\n\n## 数据来源对照\n会议记录。\n\n## 待核实事项\n具体截止日期【待核实】。';
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'office-ai-http-')), calls = [];
  const app = createApplication({ host: '127.0.0.1', port: 0, dataDir: dir, seedDemo: false, scheduler: 'external', serverChanSendKey: '', aiFetch: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ choices: [{ message: { content: draft } }] })); }, ...options });
  const address = await app.start(), base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const send = (path, body = {}, method = 'POST', headers = {}) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(currentModelConsent(app.ai, body)) });
  const configure = () => send('/api/ai/settings', { enabled: true, baseUrl: 'https://model.example/v1', model: 'synthetic-model', transcriptionModel: '', apiKey: key }, 'PATCH');
  return { app, base, calls, send, configure };
}

test('AI 接口沿用同源写入保护，未配置不请求上游，素材导入只在本机解析', async t => {
  const { base, send, calls } = await fixture(t);
  const initial = await (await fetch(base + '/api/ai')).json();
  assert.equal(initial.settings.enabled, false); assert.equal(initial.templates.length, 3);
  for (const [path, method] of [['/api/ai/settings', 'PATCH'], ['/api/ai/test', 'POST'], ['/api/ai/materials', 'POST'], ['/api/ai/documents', 'POST'], ['/api/ai/transcribe', 'POST'], ['/api/ai/templates/analyze', 'POST']]) {
    assert.equal((await send(path, {}, method, { Origin: 'https://unrelated.invalid' })).status, 403);
    assert.equal((await send(path, {}, method, { 'Sec-Fetch-Site': 'same-site' })).status, 403);
    assert.equal((await send(path, {}, method, { 'Content-Type': 'text/plain' })).status, 415);
  }
  assert.equal((await send('/api/ai/test', { consent: true })).ok, false);
  const imported = await send('/api/ai/import', { file: { name: '会议记录.txt', contentBase64: Buffer.from('甲主持会议，乙核对台账。').toString('base64') } });
  assert.equal(imported.status, 200); assert.equal((await imported.json()).content, '甲主持会议，乙核对台账。');
  assert.equal(calls.length, 0);
});

test('文档模板接口不要求文档类型，新增和编辑自定义名称后列表不返回分类', async t => {
  const { base, send, calls } = await fixture(t);
  const created = await send('/api/ai/templates', { name: '培训总结', content: '按培训内容、成果、改进计划整理。' });
  assert.equal(created.status, 201);
  const { template } = await created.json();
  assert.equal(template.name, '培训总结'); assert.equal(Object.hasOwn(template, 'kind'), false);
  const updated = await send(`/api/ai/templates/${template.id}`, { name: '年度培训总结', content: '汇总全年培训成果与后续计划。' }, 'PATCH');
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).template.name, '年度培训总结');
  const compatible = await send('/api/ai/templates/builtin-minutes', { name: '工作简报', content: '整理本周工作。', kind: '自定义旧分类' }, 'PATCH');
  assert.equal(compatible.status, 200);
  assert.equal(Object.hasOwn((await compatible.json()).template, 'kind'), false);
  const state = await (await fetch(base + '/api/ai')).json();
  assert.equal(state.templates.find(value => value.id === template.id).name, '年度培训总结');
  assert.ok(state.templates.every(value => !Object.hasOwn(value, 'kind')));
  assert.equal(calls.length, 0);
});

test('历史 Word 本机提取后显式识别模板，建议应用保存前不改变资料库', async t => {
  const { base, send, calls, configure } = await fixture(t);
  const history = createDocx('历史培训总结', '# 一、培训概况\n虚构的往期培训记录。\n# 二、培训成效\n课程内容、参与情况与改进计划。');
  const imported = await send('/api/ai/import', { file: { name: '历史培训总结.docx', contentBase64: history.toString('base64') } });
  assert.equal(imported.status, 200);
  const source = await imported.json();
  assert.match(source.content, /一、培训概况/);
  assert.equal(calls.length, 0);
  assert.equal((await send('/api/ai/templates/analyze', { ...source, consent: true })).status, 409);
  assert.equal((await configure()).status, 200);
  const before = await (await fetch(base + '/api/ai')).json();
  assert.equal((await send('/api/ai/templates/analyze', { ...source, consent: false })).status, 400);
  assert.equal(calls.length, 0);
  const analyzed = await send('/api/ai/templates/analyze', { ...source, consent: true });
  assert.equal(analyzed.status, 200);
  const { suggestion } = await analyzed.json();
  assert.match(suggestion.name, /培训总结/);
  assert.equal(suggestion.content, draft);
  assert.doesNotMatch(JSON.stringify(suggestion), new RegExp(key));
  assert.equal(calls.length, 1);
  assert.match(calls[0].init.body, /培训概况/);
  const after = await (await fetch(base + '/api/ai')).json();
  assert.deepEqual(after, before);
  const saved = await send('/api/ai/templates', suggestion);
  assert.equal(saved.status, 201);
  assert.equal((await saved.json()).template.content, suggestion.content);
  assert.equal(calls.length, 1);
});

test('真实接口形态的隔离调用完成初稿、版本审核、Word 导出并提交任务，密钥不回显', async t => {
  const { app, base, send, calls, configure } = await fixture(t);
  assert.equal((await configure()).status, 200);
  const tested = await send('/api/ai/test', { consent: true }); assert.equal(tested.status, 200);
  assert.doesNotMatch(JSON.stringify(await tested.json()), new RegExp(key));
  const { task } = await (await send('/api/tasks', { title: '整理例会纪要', owner: '甲', startDate: '2026-10-20', dueDate: '2026-10-21', submissionType: '文本', deliverable: '提交审核后的纪要' })).json();
  const { material } = await (await send('/api/ai/materials', { title: '本次会议记录', kind: '素材', taskId: task.id, content: '2026年10月20日，甲主持会议，乙负责核对台账。' })).json();
  const state = await (await fetch(base + '/api/ai')).json();
  assert.doesNotMatch(JSON.stringify(state), new RegExp(key));
  const request = { title: '会议纪要', templateId: state.templates[0].id, taskId: task.id, materialIds: [material.id], referenceIds: [], consent: true };
  assert.equal((await send('/api/ai/documents', { ...request, consent: false })).status, 400);
  const generated = await send('/api/ai/documents', request); assert.equal(generated.status, 201);
  let document = (await generated.json()).document;
  assert.equal(document.status, '待审核'); assert.match(document.content, /核对台账/);
  assert.match(calls.at(-1).init.body, /甲主持会议/); assert.match(String(calls.at(-1).url), /chat\/completions$/);
  assert.equal((await fetch(base + `/api/ai/documents/${document.id}/export`)).ok, false);
  const updated = await send(`/api/ai/documents/${document.id}`, { title: '会议纪要', content: document.content + '\n审核补充：乙于10月22日前完成。', revision: document.revision }, 'PATCH');
  assert.equal(updated.status, 200); const before = document; document = (await updated.json()).document;
  assert.equal((await send(`/api/ai/documents/${document.id}/review`, { revision: before.revision, confirmed: true, quality: '可用', reviewNote: '' })).status, 409);
  const reviewed = await send(`/api/ai/documents/${document.id}/review`, { revision: document.revision, confirmed: true, quality: '需修改', reviewNote: '已向会议主持人核实截止日期。' });
  assert.equal(reviewed.status, 200); document = (await reviewed.json()).document; assert.equal(document.status, '已确认');
  const exported = await fetch(base + `/api/ai/documents/${document.id}/export?format=docx`); assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-disposition'), /^attachment;/); assert.match(exported.headers.get('content-type'), /wordprocessingml/);
  const bytes = Buffer.from(await exported.arrayBuffer());
  assert.match(extractTextFile({ name: '纪要.docx', contentBase64: bytes.toString('base64') }).content, /审核补充/);
  const complete = await send(`/api/tasks/${task.id}/complete`, { confirmed: true, files: [{ name: '会议纪要.docx', contentBase64: bytes.toString('base64') }] }); assert.equal(complete.status, 200);
  assert.equal(app.store.getTask(task.id).status, '已完成');
  assert.equal((await fetch(base + `/api/ai/documents/${document.id}/export?format=html`)).status, 400);
  const changed = await send(`/api/ai/documents/${document.id}`, { title: document.title, content: document.content + '\n再次调整。', revision: document.revision }, 'PATCH'); assert.equal(changed.status, 200);
  assert.equal((await fetch(base + `/api/ai/documents/${document.id}/export?format=md`)).ok, false);
  assert.equal(calls.length, 2);
});

test('上游失败不会泄露原始错误或密钥，已有资料可继续编辑', async t => {
  const { send, configure, base } = await fixture(t, { aiFetch: async () => new Response(JSON.stringify({ error: { message: key } }), { status: 401 }) });
  await configure();
  const failed = await send('/api/ai/test', { consent: true }); assert.equal(failed.ok, false);
  assert.doesNotMatch(await failed.text(), new RegExp(key));
  const material = await send('/api/ai/materials', { title: '离线记录', kind: '素材', content: '网络失败时仍保留本机材料。' }); assert.equal(material.status, 201);
  const { id } = (await material.json()).material;
  assert.match((await (await fetch(base + `/api/ai/materials/${id}`)).json()).material.content, /本机材料/);
});
