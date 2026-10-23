import { currentModelConsent } from '../test-support/consent.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server.mjs';
import { InputError } from '../lib/csv.mjs';

const response = text => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }));
const configuration = {
  enabled: true, model: 'synthetic-document',
  transcriptionProvider: 'qwen', transcriptionBaseUrl: 'https://audio.example/compatible-mode/v1',
  transcriptionModel: 'qwen3-asr-flash', transcriptionApiKey: 'synthetic-http-job-key'
};
function audio(value = 0) {
  const content = Buffer.alloc(32044); content.write('RIFF'); content.writeUInt32LE(content.length - 8, 4); content.write('WAVE', 8);
  content.write('fmt ', 12); content.writeUInt32LE(16, 16); content.writeUInt16LE(1, 20); content.writeUInt16LE(1, 22);
  content.writeUInt32LE(16000, 24); content.writeUInt32LE(32000, 28); content.writeUInt16LE(2, 32); content.writeUInt16LE(16, 34);
  content.write('data', 36); content.writeUInt32LE(32000, 40); content[44] = value;
  return { name: '虚构会议.wav', contentBase64: content.toString('base64') };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'office-ai-jobs-http-')), calls = [];
  const app = createApplication({ host: '127.0.0.1', port: 0, dataDir, seedDemo: false, scheduler: 'external', serverChanSendKey: '', aiFetch: async (url, init) => {
    calls.push({ url, init }); return options.aiFetch ? options.aiFetch(url, init) : response('虚构会议转写：甲核对台账。');
  } });
  const address = await app.start(), base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { options.release?.(); await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const send = async (path, body, method = 'POST', headers = {}) => {
    const result = await fetch(base + path, { method, headers: { Origin: base, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(currentModelConsent(app.ai, body)) });
    return { status: result.status, ...await result.json() };
  };
  const get = async path => { const result = await fetch(base + path); return { status: result.status, ...await result.json() }; };
  const poll = async id => {
    for (let i = 0; i < 100; i++) {
      const result = await get(`/api/ai/jobs/${id}`);
      if (result.job?.state !== 'running') return result;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('隔离识别任务未在预期时间内结束');
  };
  assert.equal((await send('/api/ai/settings', configuration, 'PATCH')).status, 200);
  return { app, base, send, get, poll, calls };
}

test('异步创建沿用同源 JSON 和明确同意，未知任务404，失败前不调用模型', async t => {
  const { send, get, calls } = await fixture(t);
  const body = { file: audio(), consent: true }, path = '/api/ai/transcribe-jobs';
  assert.equal((await send(path, body, 'POST', { Origin: 'https://other.invalid' })).status, 403);
  assert.equal((await send(path, body, 'POST', { 'Sec-Fetch-Site': 'same-site' })).status, 403);
  assert.equal((await send(path, body, 'POST', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await send(path, { ...body, consent: false })).status, 400);
  assert.equal((await send(path, { file: body.file })).status, 400);
  assert.equal((await send(path, { consent: true })).status, 400);
  assert.equal((await get('/api/ai/jobs/not-found')).status, 404);
  assert.equal(calls.length, 0);
});

test('通用转写返回202并轮询成功，相同内容复用运行任务，不同任务409且不会重复计费', async t => {
  const gate = deferred();
  const { send, get, poll, calls, app } = await fixture(t, { aiFetch: () => gate.promise, release: () => gate.resolve(response('清理用回复。')) });
  const body = { file: audio(), consent: true };
  const started = await send('/api/ai/transcribe-jobs', body);
  assert.equal(started.status, 202); assert.equal(started.job.state, 'running');
  const duplicate = await send('/api/ai/transcribe-jobs', body);
  assert.equal(duplicate.status, 202); assert.equal(duplicate.job.id, started.job.id);
  assert.equal((await send('/api/ai/transcribe-jobs', { file: audio(1), consent: true })).status, 409);
  const running = await get(`/api/ai/jobs/${started.job.id}`);
  assert.equal(running.status, 200); assert.equal(running.job.progress.phase, 'transcribing');
  assert.equal(Object.hasOwn(running.job, 'partialText'), false);
  assert.doesNotMatch(JSON.stringify(running), /synthetic-http-job-key|contentBase64|Bearer|transcribe:/);
  assert.equal(calls.length, 1);
  gate.resolve(response('整场会议虚构转写。'));
  const finished = await poll(started.job.id);
  assert.equal(finished.status, 200); assert.equal(finished.job.state, 'succeeded');
  assert.deepEqual(finished.job.result, { name: body.file.name, text: '整场会议虚构转写。' });
  assert.equal(app.ai.state().materials.length, 0);
});

test('任务资料异步识别只完成后保存正文，重复提取拒绝，删除任务后轮询不泄露结果', async t => {
  const gate = deferred();
  const { app, send, get, poll, calls } = await fixture(t, { aiFetch: () => gate.promise, release: () => gate.resolve(response('清理用回复。')) });
  const task = app.store.createTask({ title: '异步资料验收', owner: '甲', startDate: '2026-10-20', dueDate: '2026-10-23', deliverable: '用录音整理会议纪要。' });
  const path = `/api/tasks/${task.id}`;
  const uploaded = await send(path + '/sources', { file: audio() }); assert.equal(uploaded.status, 201);
  const extractPath = path + `/sources/${uploaded.source.id}/extract-jobs`;
  assert.equal((await send(extractPath, { consent: false })).status, 400);
  assert.equal((await send(extractPath, { consent: true }, 'POST', { Origin: 'https://other.invalid' })).status, 403);
  const started = await send(extractPath, { consent: true });
  assert.equal(started.status, 202); assert.equal(started.job.taskId, task.id);
  assert.equal((await send(extractPath, { consent: true })).job.id, started.job.id);
  const secondSource = app.workflow.addSource(task.id, { file: audio(2) }).source;
  assert.equal((await send(path + `/sources/${secondSource.id}/extract-jobs`, { consent: true })).status, 409);
  assert.equal(app.workflow.workspace(task.id).materials.length, 0);
  assert.equal(calls.length, 1);
  gate.resolve(response('甲负责补齐来源，乙负责复核。'));
  const done = await poll(started.job.id);
  assert.equal(done.job.state, 'succeeded'); assert.equal(done.job.result.material.taskId, task.id);
  const workspace = app.workflow.workspace(task.id);
  assert.equal(workspace.materials.length, 1); assert.equal(workspace.task.attachments.length, 0); assert.notEqual(workspace.task.status, '已完成');
  assert.equal((await send(extractPath, { consent: true })).status, 409);
  app.store.deleteTask(task.id);
  const hidden = await get(`/api/ai/jobs/${started.job.id}`);
  assert.equal(hidden.status, 404); assert.equal(Object.hasOwn(hidden, 'job'), false);
});

test('多段失败仅终态回传已完成文字，来源不保存伪完整正文，上游异常细节不回显', async t => {
  const gate = deferred();
  const { app, send, get, poll } = await fixture(t, { release: () => gate.resolve() });
  app.ai.transcribe = async (body, notify) => {
    notify({ phase: 'transcribing', completed: 1, total: 3, text: '第一段已识别文字，可复制恢复。' });
    await gate.promise;
    throw new InputError('语音服务请求未成功（HTTP 429），请检查额度后手动重试。', 502);
  };
  const task = app.store.createTask({ title: '失败恢复验收', owner: '甲', startDate: '2026-10-20', dueDate: '2026-10-23', deliverable: '整理纪要。' });
  const source = app.workflow.addSource(task.id, { file: audio() }).source;
  const created = await send(`/api/tasks/${task.id}/sources/${source.id}/extract-jobs`, { consent: true });
  assert.equal(created.status, 202);
  const running = await get(`/api/ai/jobs/${created.job.id}`);
  assert.equal(running.job.progress.completed, 1); assert.equal(Object.hasOwn(running.job, 'partialText'), false);
  gate.resolve();
  const failed = await poll(created.job.id);
  assert.equal(failed.job.state, 'failed'); assert.match(failed.job.error, /429/);
  assert.equal(failed.job.partialText, '第一段已识别文字，可复制恢复。');
  assert.equal(app.workflow.workspace(task.id).materials.length, 0);
  assert.equal(app.workflow.source(task.id, source.id).materialId, null);
  app.ai.transcribe = async () => { throw new Error('Bearer sk-private request body details'); };
  const unknown = await send('/api/ai/transcribe-jobs', { file: audio(), consent: true });
  const hidden = await poll(unknown.job.id);
  assert.equal(hidden.job.state, 'failed'); assert.doesNotMatch(JSON.stringify(hidden), /Bearer|sk-private|request body|stack/);
});

test('服务关闭中止运行转写并等待任务结束，绝不发布成功结果', async t => {
  const gate = deferred();
  const { app, send } = await fixture(t, { aiFetch: () => gate.promise, release: () => gate.resolve(response('延迟回复。')) });
  const started = await send('/api/ai/transcribe-jobs', { file: audio(), consent: true });
  assert.equal(started.status, 202);
  await app.close();
  const terminal = app.jobs.get(started.job.id);
  assert.equal(terminal.state, 'failed'); assert.match(terminal.error, /关闭|中断/); assert.equal(Object.hasOwn(terminal, 'result'), false);
  gate.resolve(response('迟到的回复不能写为成功。'));
});
