import { currentModelConsent } from '../test-support/consent.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server.mjs';
import { createDocx, extractTextFile } from '../lib/ai-files.mjs';

const key = 'synthetic-task-workflow-key';
const draft = '# 项目例会纪要\n一、会议情况\n根据本次记录整理。\n二、议定事项\n甲负责在10月23日前补齐台账来源。\n三、数据来源对照\n会议记录。\n四、待核实事项\n【待核实：参会人员名单】';
const file = (name, content) => ({ name, contentBase64: Buffer.from(content).toString('base64') });
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'office-task-workflow-http-')), calls = [];
  const app = createApplication({ host: '127.0.0.1', port: 0, dataDir, seedDemo: false, scheduler: 'external', serverChanSendKey: '', now: () => new Date('2026-10-20T03:00:00Z'), aiFetch: async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(String(url).endsWith('/audio/transcriptions') ? { text: '录音转写：甲负责补齐来源。' } : { choices: [{ message: { content: draft }, finish_reason: 'stop' }] }));
  } });
  const address = await app.start(), base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const send = (path, body = {}, method = 'POST', headers = {}) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(currentModelConsent(app.ai, body)) });
  const get = async path => { const response = await fetch(base + path); assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
  const { task } = await (await send('/api/tasks', { title: '三天内提交项目例会纪要', owner: '甲', startDate: '2026-10-20', dueDate: '2026-10-23', submissionType: '文本', deliverable: '整理会议决定、责任人与截止日期，提交Word纪要。' })).json();
  const path = `/api/tasks/${task.id}`;
  const configure = () => send('/api/ai/settings', { enabled: true, baseUrl: 'https://model.example/v1', model: 'synthetic-chat', transcriptionModel: 'synthetic-audio', visionModel: 'synthetic-vision', apiKey: key }, 'PATCH');
  return { app, base, send, get, task, path, configure, calls };
}

test('单任务从会议原件、模板初稿、版本审核到正式Word提交闭环，不提前完成或发送未选资料', async t => {
  const { base, send, get, task, path, configure, calls } = await fixture(t);
  const original = createDocx('本次会议记录', '甲负责在10月23日前补齐台账来源。');
  const uploaded = await send(path + '/sources', { file: file('会议记录.docx', original) });
  assert.equal(uploaded.ok, true, await uploaded.clone().text());
  const { source, material } = await uploaded.json();
  assert.equal(source.kind, '文档'); assert.equal(material.taskId, task.id);
  let workspace = await get(path + '/workspace');
  assert.notEqual(workspace.task.status, '已完成'); assert.equal(workspace.task.attachments.length, 0);
  assert.equal(workspace.sourceFiles.length, 1); assert.equal(workspace.materials.length, 1);
  assert.equal(JSON.stringify(workspace).includes('contentBase64'), false);
  const downloaded = await fetch(base + path + `/sources/${source.id}/download`);
  assert.equal(downloaded.status, 200); assert.match(downloaded.headers.get('content-disposition'), /^attachment;/);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), original);
  assert.equal(calls.length, 0);
  await configure();
  await send('/api/ai/materials', { title: '其他任务私密资料', content: '其他任务未选择的机密信息不得外发。', kind: '素材' });
  const request = { title: '项目例会纪要', templateId: 'builtin-minutes', materialIds: [material.id], referenceIds: [], consent: true };
  assert.equal((await send(path + '/draft', { ...request, consent: false })).status, 400);
  assert.equal(calls.length, 0);
  const generated = await send(path + '/draft', request);
  assert.equal(generated.ok, true, await generated.clone().text());
  let document = (await generated.json()).document;
  assert.equal(document.taskId, task.id); assert.equal(document.status, '待审核');
  assert.match(calls[0].init.body, /三天内提交项目例会纪要/);
  assert.doesNotMatch(calls[0].init.body, /其他任务未选择的机密信息/);
  assert.equal((await send(path + '/submit', { documentId: document.id, revision: document.revision, confirmed: true })).status, 409);
  const reviewed = await send(`/api/ai/documents/${document.id}/review`, { revision: document.revision, quality: '可用', reviewNote: '已核对责任分工和期限。', confirmed: true });
  assert.equal(reviewed.status, 200);
  const oldRevision = document.revision;
  const changed = await send(`/api/ai/documents/${document.id}`, { revision: oldRevision, content: draft + '\n人工补充：名单已核实。' }, 'PATCH');
  assert.equal(changed.status, 200); document = (await changed.json()).document;
  assert.equal((await send(path + '/submit', { documentId: document.id, revision: oldRevision, confirmed: true })).status, 409);
  assert.equal((await send(path + '/submit', { documentId: document.id, revision: document.revision, confirmed: true })).status, 409);
  assert.equal((await send(`/api/ai/documents/${document.id}/review`, { revision: document.revision, quality: '需修改', reviewNote: '已核实并补充名单。', confirmed: true })).status, 200);
  assert.equal((await send(path + '/submit', { documentId: document.id, revision: document.revision, confirmed: false })).status, 400);
  const submitted = await send(path + '/submit', { documentId: document.id, revision: document.revision, confirmed: true, note: '已完成人工核对。' });
  assert.equal(submitted.status, 200, await submitted.clone().text());
  const result = await submitted.json();
  assert.equal(result.task.status, '已完成'); assert.ok(result.task.completedAt); assert.equal(result.task.attachments.length, 1);
  assert.ok(result.submission); assert.equal(result.submission.documentId, document.id);
  const attachment = result.task.attachments[0];
  assert.match(attachment.name, /\.docx$/);
  const final = Buffer.from(await (await fetch(base + `/api/attachments/${attachment.id}`)).arrayBuffer());
  assert.match(extractTextFile(file(attachment.name, final)).content, /人工补充/);
  assert.equal((await send(path + '/submit', { documentId: document.id, revision: document.revision, confirmed: true })).status, 409);
  workspace = await get(path + '/workspace');
  assert.equal(workspace.sourceFiles.length, 1); assert.equal(workspace.submissions.length, 1);
  assert.equal(calls.length, 1); assert.equal(JSON.stringify(workspace).includes(key), false);
});

test('任务工作区写接口验证来源与JSON，原件、素材、文档不能跨任务误用', async t => {
  const { base, send, path, configure, calls } = await fixture(t);
  const uploaded = await (await send(path + '/sources', { file: file('记录.txt', '甲负责整理会议纪要。') })).json();
  const { task: other } = await (await send('/api/tasks', { title: '另一个会议', owner: '乙', startDate: '2026-10-20', dueDate: '2026-10-23', deliverable: '提交纪要。' })).json();
  const otherPath = `/api/tasks/${other.id}`;
  for (const [suffix, method] of [['/sources', 'POST'], [`/sources/${uploaded.source.id}/extract`, 'POST'], [`/sources/${uploaded.source.id}`, 'DELETE'], ['/draft', 'POST'], ['/submit', 'POST']]) {
    assert.equal((await send(path + suffix, {}, method, { Origin: 'https://unrelated.invalid' })).status, 403);
    assert.equal((await send(path + suffix, {}, method, { 'Content-Type': 'text/plain' })).status, 415);
  }
  assert.equal((await fetch(base + otherPath + `/sources/${uploaded.source.id}/download`)).status, 404);
  assert.equal((await send(otherPath + `/sources/${uploaded.source.id}`, {}, 'DELETE')).status, 404);
  await configure();
  const cross = await send(otherPath + '/draft', { title: '错误关联', templateId: 'builtin-minutes', materialIds: [uploaded.material.id], referenceIds: [], consent: true });
  assert.equal(cross.ok, false); assert.equal(calls.length, 0);
  await send(path, {}, 'DELETE');
  assert.equal((await fetch(base + path + '/workspace')).status, 404);
  assert.equal((await send(path + '/sources', { file: file('新增.txt', '不得保存到回收站任务。') })).status, 404);
});

test('较大的录音原件可本机保存，明确同意转写后才调用上游并生成关联素材', async t => {
  const { send, get, path, configure, calls } = await fixture(t);
  const wav = Buffer.alloc(3 * 1024 * 1024); wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8);
  const uploaded = await send(path + '/sources', { file: file('会议录音.wav', wav) });
  assert.equal(uploaded.ok, true, await uploaded.clone().text());
  const { source } = await uploaded.json(); assert.equal(source.kind, '录音');
  assert.equal(calls.length, 0); assert.equal((await get(path + '/workspace')).materials.length, 0);
  await configure();
  assert.equal((await send(path + `/sources/${source.id}/extract`, { consent: false })).status, 400);
  assert.equal(calls.length, 0);
  const extracted = await send(path + `/sources/${source.id}/extract`, { consent: true });
  assert.equal(extracted.ok, true, await extracted.clone().text());
  const result = await extracted.json(); assert.match(result.material.content, /甲负责/);
  assert.equal(calls.length, 1); assert.match(String(calls[0].url), /audio\/transcriptions$/);
  assert.equal((await get(path + '/workspace')).task.attachments.length, 0);
});

test('完成页本次上传模板并直接提交编辑内容，不要求另行评价或保存审核步骤', async t => {
  const { base, send, get, path, configure, calls } = await fixture(t);
  await configure();
  const { material } = await (await send(path + '/sources', { file: file('会议记录.txt', '甲负责在10月23日前补齐台账来源。') })).json();
  const imported = await send('/api/ai/import', { file: file('历史纪要模板.docx', createDocx('历史纪要模板', '一、会议情况\n二、议定事项\n三、责任分工与期限\n历史日期和人员仅作格式示例。')) });
  assert.equal(imported.status, 200); const extracted = await imported.json();
  const before = await get(path + '/workspace');
  const generated = await send(path + '/draft', { title: '项目纪要', template: { name: extracted.title, content: extracted.content }, materialIds: [material.id], referenceIds: [], consent: true });
  assert.equal(generated.ok, true, await generated.clone().text());
  const document = (await generated.json()).document;
  assert.equal(document.templateSnapshot.name, extracted.title);
  assert.equal((await get(path + '/workspace')).templates.length, before.templates.length);
  assert.equal((await send(path + '/finish', { documentId: document.id, revision: document.revision, title: '人工核对后的会议纪要', content: draft + '\n人工修改：参会名单已核实。', confirmed: false })).status, 400);
  const finalContent = draft + '\n人工修改：参会名单已核实。';
  const submitted = await send(path + '/finish', { documentId: document.id, revision: document.revision, title: '人工核对后的会议纪要', content: finalContent, confirmed: true });
  assert.equal(submitted.status, 200, await submitted.clone().text());
  const result = await submitted.json();
  assert.equal(result.task.status, '已完成'); assert.equal(result.task.attachments.length, 1);
  const saved = (await get(`/api/ai/documents/${document.id}`)).document;
  assert.equal(saved.revision, document.revision + 1); assert.equal(saved.content, finalContent);
  assert.equal(saved.originalContent, draft); assert.equal(saved.status, '已确认'); assert.equal(saved.quality, null);
  assert.equal(saved.reviews.at(-1).quality, '未评价');
  assert.equal((await get('/api/ai')).metrics.reviewedCount, 0);
  const attachment = result.task.attachments[0];
  const output = Buffer.from(await (await fetch(base + `/api/attachments/${attachment.id}`)).arrayBuffer());
  assert.match(extractTextFile(file(attachment.name, output)).content, /参会名单已核实/);
  assert.equal((await send(path + '/finish', { documentId: document.id, revision: saved.revision, title: saved.title, content: saved.content, confirmed: true })).status, 409);
  assert.equal(calls.length, 1);
});

test('完成页提交失败保留草稿和任务，拒绝跨源与旧版本，不留下半成的审核记录', async t => {
  const { send, get, path, configure } = await fixture(t); await configure();
  const { material } = await (await send(path + '/sources', { file: file('记录.txt', '甲整理台账。') })).json();
  const generated = await send(path + '/draft', { title: '待核对纪要', templateId: 'builtin-minutes', materialIds: [material.id], referenceIds: [], consent: true });
  const document = (await generated.json()).document;
  const body = { documentId: document.id, revision: document.revision, title: '拟提交标题', content: draft + '\n拟提交的编辑。', confirmed: true };
  assert.equal((await send(path + '/finish', body, 'POST', { Origin: 'https://other.invalid' })).status, 403);
  assert.equal((await send(path + '/finish', body, 'POST', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await send(path + '/finish', { ...body, revision: 999 })).status, 409);
  assert.equal((await send(path, { submissionType: 'PDF' }, 'PATCH')).status, 200);
  assert.equal((await send(path + '/finish', body)).ok, false);
  const untouched = (await get(`/api/ai/documents/${document.id}`)).document;
  assert.deepEqual(untouched, document);
  const workspace = await get(path + '/workspace');
  assert.notEqual(workspace.task.status, '已完成'); assert.equal(workspace.task.attachments.length, 0);
  assert.equal(workspace.submissions.length, 0);
});
