import { currentModelConsent } from '../test-support/consent.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server.mjs';

const mediaConfig = {
  enabled: true, baseUrl: 'https://document.example/v1', model: 'document-model', apiKey: 'synthetic-document-http-key',
  transcriptionProvider: 'qwen', transcriptionBaseUrl: 'https://audio.example/compatible-mode/v1', transcriptionModel: 'qwen3-asr-flash', transcriptionApiKey: 'synthetic-audio-http-key',
  visionProvider: 'qwen', visionBaseUrl: 'https://image.example/compatible-mode/v1', visionModel: 'qwen3.5-ocr', visionApiKey: 'synthetic-image-http-key'
};
const image = { name: '虚构白板.png', contentBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAQSURBVBhXY/gPBAwIwMAAAD3UA/2PTla8AAAAAElFTkSuQmCC' };
function recording() {
  const bytes = Buffer.alloc(364); bytes.write('RIFF'); bytes.writeUInt32LE(356, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(320, 40);
  return { name: '虚构会议.wav', contentBase64: bytes.toString('base64') };
}
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'office-ai-media-http-')), calls = [];
  const app = createApplication({ host: '127.0.0.1', port: 0, dataDir, seedDemo: false, scheduler: 'external', serverChanSendKey: '', aiFetch: async (url, init) => {
    calls.push({ url, init }); const { model } = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: model === 'qwen3-asr-flash' ? '虚构转写：甲负责核对台账。' : model === 'qwen3.5-ocr' ? '虚构白板：乙负责补齐来源。' : '虚构会议纪要：甲核对台账，乙补齐来源。' } }] }));
  } });
  const address = await app.start(), base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const send = (path, body, method = 'POST', headers = {}) => fetch(base + path, { method, headers: { Origin: base, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(currentModelConsent(app.ai, body)) });
  const get = async path => { const response = await fetch(base + path); assert.equal(response.status, 200); return response.json(); };
  return { app, base, send, get, calls };
}

test('HTTP 媒体配置和分项测试遵循同源 JSON 与明确同意，密钥从不回显且测试不改变业务数据', async t => {
  const { send, get, calls } = await fixture(t);
  const saved = await send('/api/ai/settings', mediaConfig, 'PATCH'); assert.equal(saved.status, 200);
  const { settings } = await saved.json();
  assert.equal(settings.transcriptionProvider, 'qwen'); assert.equal(settings.visionProvider, 'qwen');
  for (const field of ['apiKey', 'transcriptionApiKey', 'visionApiKey']) assert.equal(Object.hasOwn(settings, field), false);
  const before = await get('/api/ai');
  for (const target of ['transcription', 'vision']) {
    const path = '/api/ai/test', body = { target, consent: true };
    assert.equal((await send(path, body, 'POST', { Origin: 'https://other.invalid' })).status, 403);
    assert.equal((await send(path, body, 'POST', { 'Sec-Fetch-Site': 'same-site' })).status, 403);
    assert.equal((await send(path, body, 'POST', { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await send(path, { target, consent: false })).status, 400);
  }
  assert.equal(calls.length, 0);
  for (const target of ['transcription', 'vision']) {
    const response = await send('/api/ai/test', { target, consent: true }); assert.equal(response.status, 200);
    const result = await response.json(); assert.equal(result.target, target); assert.match(result.message, /接口|连接|识别/);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-.*-http-key/);
  }
  assert.equal((await send('/api/ai/test', { target: 'all', consent: true })).status, 400);
  assert.equal(calls.length, 2); assert.deepEqual(await get('/api/ai'), before);
  assert.equal(calls[0].url, 'https://audio.example/compatible-mode/v1/chat/completions');
  assert.equal(calls[1].url, 'https://image.example/compatible-mode/v1/chat/completions');
  const changed = await send('/api/ai/settings', { visionBaseUrl: 'https://different-image.example/v1' }, 'PATCH');
  assert.equal(changed.status, 409); assert.deepEqual(await get('/api/ai'), before);
});

test('任务上传录音图片经同意后分别提取，起草只向文档模型发送选中的提取文字', async t => {
  const { send, get, calls } = await fixture(t);
  assert.equal((await send('/api/ai/settings', mediaConfig, 'PATCH')).status, 200);
  const created = await send('/api/tasks', { title: '媒体识别接入验收', owner: '甲', startDate: '2026-10-20', dueDate: '2026-10-23', submissionType: '文本', deliverable: '用录音和白板整理会议纪要。' });
  assert.equal(created.status, 201); const { task } = await created.json(), taskPath = `/api/tasks/${task.id}`;
  const materialIds = [];
  for (const file of [recording(), image]) {
    const uploaded = await send(taskPath + '/sources', { file }); assert.equal(uploaded.status, 201);
    const { source } = await uploaded.json(); assert.equal(calls.length, materialIds.length);
    const path = taskPath + `/sources/${source.id}/extract`;
    assert.equal((await send(path, { consent: false })).status, 400);
    const extracted = await send(path, { consent: true }); assert.equal(extracted.status, 200);
    const { material } = await extracted.json(); assert.equal(material.taskId, task.id);
    materialIds.push(material.id);
  }
  const workspace = await get(taskPath + '/workspace');
  assert.notEqual(workspace.task.status, '已完成'); assert.equal(workspace.task.attachments.length, 0);
  assert.equal(workspace.materials.length, 2);
  const generated = await send(taskPath + '/draft', { title: '虚构纪要', templateId: 'builtin-minutes', materialIds, referenceIds: [], consent: true });
  assert.equal(generated.status, 201);
  assert.deepEqual(calls.map(value => value.url), ['https://audio.example/compatible-mode/v1/chat/completions', 'https://image.example/compatible-mode/v1/chat/completions', 'https://document.example/v1/chat/completions']);
  assert.deepEqual(calls.map(value => value.init.headers.Authorization), ['synthetic-audio-http-key', 'synthetic-image-http-key', 'synthetic-document-http-key'].map(key => `Bearer ${key}`));
  const documentRequest = calls[2].init.body;
  assert.match(documentRequest, /甲负责核对台账/); assert.match(documentRequest, /乙负责补齐来源/);
  assert.doesNotMatch(documentRequest, /input_audio|image_url|base64|synthetic-.*-http-key/);
  assert.doesNotMatch(JSON.stringify(await get('/api/ai')), /synthetic-.*-http-key/);
});
