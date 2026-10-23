import { approveCurrentModel } from '../test-support/consent.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OfficeStore } from '../lib/office.mjs';
import { AiService } from '../lib/ai.mjs';

const textKey = 'synthetic-document-key';
const audioKey = 'synthetic-transcription-key';
const imageKey = 'synthetic-vision-key';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAQSURBVBhXY/gPBAwIwMAAAD3UA/2PTla8AAAAAElFTkSuQmCC', 'base64');
const chat = (content = '虚构识别文字。') => new Response(JSON.stringify({ choices: [{ message: { content } }] }));
function wav(seconds = 0.1) {
  const size = Math.round(seconds * 16000) * 2, bytes = Buffer.alloc(44 + size);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(size, 40);
  return bytes;
}
const audio = bytes => ({ name: '虚构静音.wav', contentBase64: (bytes || wav()).toString('base64') });
const image = { name: '虚构白板.png', contentBase64: png.toString('base64') };
const routedSettings = {
  enabled: true, baseUrl: 'https://document.example/v1', model: 'synthetic-document', apiKey: textKey,
  transcriptionProvider: 'qwen', transcriptionBaseUrl: 'https://audio.example/compatible-mode/v1', transcriptionModel: 'qwen3-asr-flash', transcriptionApiKey: audioKey,
  visionProvider: 'qwen', visionBaseUrl: 'https://vision.example/compatible-mode/v1', visionModel: 'qwen3.5-ocr', visionApiKey: imageKey
};

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'office-ai-media-'));
  const store = new OfficeStore({ databasePath: join(dir, 'office.sqlite'), seedDemo: false });
  const calls = [], clients = [];
  const create = () => {
    const client = approveCurrentModel(new AiService({ ...options, store, dataDir: dir, fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return options.fetchImpl ? options.fetchImpl(url, init) : url.endsWith('/audio/transcriptions') ? new Response(JSON.stringify({ text: '虚构录音转写。' })) : chat();
    } }));
    clients.push(client); return client;
  };
  const client = create();
  t.after(async () => { for (const value of clients) await value.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, store, client, calls, create };
}

test('旧配置迁移后媒体默认共用文档地址和密钥，旧 multipart 与图片模型回退保持可用', async t => {
  const { client, dir, create, calls } = await fixture(t);
  const legacy = { enabled: true, baseUrl: 'https://legacy.example/v1', model: 'legacy-chat', transcriptionModel: 'legacy-audio', visionModel: '', apiKey: textKey };
  await writeFile(join(dir, 'ai-settings.json'), JSON.stringify(legacy));
  const migrated = create(); const publicSettings = migrated.settings();
  assert.equal(publicSettings.transcriptionProvider, 'shared'); assert.equal(publicSettings.visionProvider, 'shared');
  assert.equal(publicSettings.model, legacy.model); assert.doesNotMatch(JSON.stringify(publicSettings), /synthetic-document-key/);
  await migrated.transcribe({ file: audio(), consent: true });
  await migrated.recognizeImage({ file: image, consent: true });
  assert.equal(calls[0].url, 'https://legacy.example/v1/audio/transcriptions');
  assert.ok(calls[0].init.body instanceof FormData); assert.equal(calls[0].init.body.get('model'), 'legacy-audio');
  assert.equal(Object.hasOwn(calls[0].init.headers, 'Content-Type'), false);
  assert.equal(calls[1].url, 'https://legacy.example/v1/chat/completions');
  assert.equal(JSON.parse(calls[1].init.body).model, 'legacy-chat');
  for (const { init } of calls) assert.equal(init.headers.Authorization, `Bearer ${textKey}`);
  assert.equal(client.state().materials.length, 0);
});

test('文档、千问转写、千问图片的地址密钥和模型分别路由，修改文档配置不改变媒体服务', async t => {
  const { client, calls, create, store } = await fixture(t);
  const settings = client.updateSettings(routedSettings);
  for (const flag of ['keyConfigured', 'transcriptionKeyConfigured', 'visionKeyConfigured']) assert.equal(settings[flag], true);
  for (const secret of [textKey, audioKey, imageKey]) assert.equal(JSON.stringify(client.state()).includes(secret), false);
  store.createTask({ title: '不可外发的业务任务', owner: '测试人', startDate: '2026-10-20', dueDate: '2026-10-21', deliverable: '不可外发的交付说明' });
  client.saveMaterial({ title: '不可外发的其他素材', kind: '素材', content: '未经选择的业务正文。' });
  await client.testConnection({ consent: true });
  await client.transcribe({ file: audio(), consent: true });
  await client.recognizeImage({ file: image, consent: true });
  assert.deepEqual(calls.map(value => value.url), [
    'https://document.example/v1/chat/completions',
    'https://audio.example/compatible-mode/v1/chat/completions',
    'https://vision.example/compatible-mode/v1/chat/completions'
  ]);
  assert.deepEqual(calls.map(value => value.init.headers.Authorization), [textKey, audioKey, imageKey].map(key => `Bearer ${key}`));
  const [document, transcription, vision] = calls.map(value => JSON.parse(value.init.body));
  assert.deepEqual([document.model, transcription.model, vision.model], ['synthetic-document', 'qwen3-asr-flash', 'qwen3.5-ocr']);
  assert.equal(transcription.stream, false); assert.equal(transcription.asr_options.enable_itn, false);
  const segment = transcription.messages.flatMap(value => Array.isArray(value.content) ? value.content : []).find(value => value.type === 'input_audio');
  assert.equal(segment.input_audio.data, `data:audio/wav;base64,${audio().contentBase64}`);
  assert.equal(vision.messages.flatMap(value => Array.isArray(value.content) ? value.content : []).find(value => value.type === 'image_url').image_url.url, `data:image/png;base64,${image.contentBase64}`);
  assert.equal(vision.messages.some(value => value.role === 'system'), false);
  for (const { init } of calls) assert.doesNotMatch(init.body, /不可外发|未经选择|synthetic-document-key|synthetic-transcription-key|synthetic-vision-key/);
  assert.doesNotMatch(calls[0].init.body, /input_audio|image_url|contentBase64/);
  client.updateSettings({ baseUrl: 'https://new-document.example/v1', apiKey: 'new-synthetic-document-key', model: 'new-document' });
  await create().transcribe({ file: audio(), consent: true });
  assert.equal(calls.at(-1).url, 'https://audio.example/compatible-mode/v1/chat/completions');
  assert.equal(calls.at(-1).init.headers.Authorization, `Bearer ${audioKey}`);
});

test('独立媒体换 origin 必须新密钥或显式清除，非法配置与写盘失败不改变已生效配置', async t => {
  const { client, dir } = await fixture(t); client.updateSettings(routedSettings);
  const path = join(dir, 'ai-settings.json'), original = await readFile(path, 'utf8'), settings = client.settings();
  for (const field of ['transcription', 'vision']) {
    for (const key of [undefined, '', ' ']) {
      const update = { [`${field}BaseUrl`]: `https://new-${field}.example/v1`, ...(key === undefined ? {} : { [`${field}ApiKey`]: key }) };
      assert.throws(() => client.updateSettings(update), error => error.status === 409);
      assert.deepEqual(client.settings(), settings); assert.equal(await readFile(path, 'utf8'), original);
    }
    for (const baseUrl of ['http://remote.example/v1', 'https://user:pass@example.test/v1', 'https://example.test/v1?key=secret', 'https://example.test/v1#secret', 'file:///tmp']) {
      assert.throws(() => client.updateSettings({ [`${field}BaseUrl`]: baseUrl, [`${field}ApiKey`]: 'replacement-synthetic-key' }));
      assert.deepEqual(client.settings(), settings); assert.equal(await readFile(path, 'utf8'), original);
    }
    assert.throws(() => client.updateSettings({ [`clear${field[0].toUpperCase()}${field.slice(1)}ApiKey`]: 'true' }), /布尔/);
  }
  await rename(path, path + '.original'); await mkdir(path);
  assert.throws(() => client.updateSettings({ transcriptionModel: 'qwen3-asr-flash-2025-09-08' }), error => error.status === 500);
  assert.deepEqual(client.settings(), settings); assert.equal(await readFile(path + '.original', 'utf8'), original);
  await rm(path, { recursive: true }); await rename(path + '.original', path);
  assert.equal(client.updateSettings({ transcriptionBaseUrl: 'https://new-audio.example/v1', clearTranscriptionApiKey: true }).transcriptionKeyConfigured, false);
  assert.equal(client.updateSettings({ visionBaseUrl: 'https://new-vision.example/v1', visionApiKey: 'new-synthetic-image-key' }).visionKeyConfigured, true);
});

test('千问转写是 JSON 音频请求且直接读取文字，OpenAI 独立转写继续 multipart', async t => {
  const { client, calls } = await fixture(t, { fetchImpl: async url => url.endsWith('/audio/transcriptions') ? new Response(JSON.stringify({ text: '  OpenAI 兼容转写。  ' })) : chat('  千问转写的会议文字。  ') });
  client.updateSettings(routedSettings);
  assert.deepEqual(await client.transcribe({ file: audio(), consent: true }), { name: '虚构静音.wav', text: '千问转写的会议文字。' });
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json'); assert.equal(typeof calls[0].init.body, 'string');
  client.updateSettings({ transcriptionProvider: 'openai', transcriptionModel: 'whisper-compatible' });
  assert.deepEqual(await client.transcribe({ file: audio(), consent: true }), { name: '虚构静音.wav', text: 'OpenAI 兼容转写。' });
  assert.ok(calls[1].init.body instanceof FormData); assert.equal(calls[1].url, 'https://audio.example/compatible-mode/v1/audio/transcriptions');
  assert.equal(calls[1].init.body.get('file').name, '虚构静音.wav'); assert.equal(calls[1].init.body.get('model'), 'whisper-compatible');
  assert.equal(Object.hasOwn(calls[1].init.headers, 'Content-Type'), false);
});

test('只配置媒体也可启用，独立图片未保存密钥时绝不回退使用文档服务密钥', async t => {
  const { client, calls } = await fixture(t);
  client.updateSettings({ ...routedSettings, model: '' });
  await client.transcribe({ file: audio(), consent: true });
  await client.recognizeImage({ file: image, consent: true });
  await assert.rejects(client.testConnection({ consent: true }), /模型名称/);
  client.updateSettings({ clearVisionApiKey: true });
  await client.recognizeImage({ file: image, consent: true });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${audioKey}`);
  assert.equal(calls[1].init.headers.Authorization, `Bearer ${imageKey}`);
  assert.equal(Object.hasOwn(calls[2].init.headers, 'Authorization'), false);
  assert.equal(JSON.parse(calls[2].init.body).model, 'qwen3.5-ocr');
  client.updateSettings({ visionModel: '' });
  await assert.rejects(client.recognizeImage({ file: image, consent: true }), /图片识别模型/);
  assert.equal(calls.length, 3);
});

test('不误将千问实时或异步文件转写模型当兼容接口，调用前给出中文模型建议', async t => {
  const { client, calls } = await fixture(t); client.updateSettings(routedSettings);
  for (const model of ['qwen3-asr-flash-realtime', 'qwen3-asr-flash-filetrans', 'paraformer-v2']) {
    client.updateSettings({ transcriptionModel: model });
    await assert.rejects(client.transcribe({ file: audio(), consent: true }), error => error.status === 400 && /qwen3-asr-flash|模型/.test(error.message));
  }
  assert.equal(calls.length, 0);
});

test('媒体接口测试只有内置虚构样本，停用时可测试且静音空转写不误报连接失败', async t => {
  const { client, calls, store } = await fixture(t, { fetchImpl: async (url, init) => JSON.parse(init.body).model === 'qwen3-asr-flash' ? chat('') : chat() });
  client.updateSettings({ ...routedSettings, enabled: false });
  store.createTask({ title: '业务任务不可进入样本', owner: '甲', startDate: '2026-10-20', dueDate: '2026-10-21', deliverable: '业务交付要求不可进入样本。' });
  client.saveMaterial({ title: '业务素材不可进入样本', kind: '素材', content: '真实材料不可进入样本。' });
  const before = client.state();
  for (const target of ['transcription', 'vision']) {
    await assert.rejects(client.testConnection({ target, consent: false }), /同意/);
    const result = await client.testConnection({ target, consent: true });
    assert.equal(result.target, target); assert.match(result.message, /连接|接口|识别/);
    if (target === 'transcription') assert.match(result.message, /准确率/);
  }
  assert.equal(calls.length, 2); assert.deepEqual(client.state(), before);
  for (const { init } of calls) assert.doesNotMatch(init.body, /业务任务|业务素材|真实材料/);
  await assert.rejects(client.testConnection({ target: 'invalid', consent: true }), /测试|目标|类型/);
  assert.equal(calls.length, 2);
});

test('媒体上游错误不回显密钥正文，单并发限制仍覆盖不同服务', async t => {
  let release;
  const { client, calls } = await fixture(t, { fetchImpl: () => new Promise(resolve => { release = resolve; }) });
  client.updateSettings(routedSettings);
  const pending = client.transcribe({ file: audio(), consent: true });
  await assert.rejects(client.recognizeImage({ file: image, consent: true }), error => error.status === 409);
  release(new Response(JSON.stringify({ error: { message: `${audioKey} private audio details` } }), { status: 401 }));
  await assert.rejects(pending, error => error.status === 502 && /401/.test(error.message) && !error.message.includes(audioKey) && !error.message.includes('private audio details'));
  assert.equal(calls.length, 1); assert.equal(client.state().materials.length, 0);
});
