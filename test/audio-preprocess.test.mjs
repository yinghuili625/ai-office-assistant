import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { prepareAudioSegments } from '../lib/audio-preprocess.mjs';
import { AiService } from '../lib/ai.mjs';
import { OfficeStore } from '../lib/office.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workRoot = join(project, 'data', 'audio-work');
const toolsRoot = resolve(project, '..', '工具', 'ffmpeg');
function tool(name) {
  const configured = process.env[name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH'];
  if (configured) return configured;
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  if (existsSync(join(toolsRoot, exe))) return join(toolsRoot, exe);
  if (existsSync(toolsRoot)) for (const entry of readdirSync(toolsRoot, { withFileTypes: true })) {
    const path = join(toolsRoot, entry.name, 'bin', exe);
    if (entry.isDirectory() && entry.name.startsWith('ffmpeg-') && existsSync(path)) return path;
  }
  return name;
}
const haveTools = ['ffmpeg', 'ffprobe'].every(name => spawnSync(tool(name), ['-version'], { windowsHide: true, stdio: 'ignore' }).status === 0);
const toolSkip = haveTools ? false : '本机尚未安装 FFmpeg/FFprobe；安装后此项运行真实音频工具';
function wav(seconds, { sampleRate = 16000, channels = 1, bits = 16 } = {}) {
  const byteRate = sampleRate * channels * bits / 8, dataSize = Math.round(seconds * byteRate), bytes = Buffer.alloc(44 + dataSize, bits === 8 ? 128 : 0);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(byteRate, 28); bytes.writeUInt16LE(channels * bits / 8, 32); bytes.writeUInt16LE(bits, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(dataSize, 40);
  return bytes;
}
function recording(content, name = '虚构会议静音.wav') { return { name, mimeType: 'audio/wav', content }; }
function directories() { return existsSync(workRoot) ? readdirSync(workRoot).filter(name => /^meeting-/.test(name)) : []; }
function readWav(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF'); assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  let offset = 12, format, data;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4), start = offset + 8;
    assert.ok(start + size <= bytes.length, 'WAV 数据块完整');
    if (type === 'fmt ') format = { codec: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2), sampleRate: bytes.readUInt32LE(start + 4), bytesPerSecond: bytes.readUInt32LE(start + 8), bits: bytes.readUInt16LE(start + 14) };
    if (type === 'data') data = bytes.subarray(start, start + size);
    offset = start + size + size % 2;
  }
  assert.ok(format && data, '包含音频格式与数据');
  return { ...format, data, seconds: data.length / format.bytesPerSecond };
}

test('短 PCM WAV 可直通且原件不变，损坏的短 WAV 不绕过工具校验', async () => {
  const content = wav(1.25), before = directories(), priorFfmpeg = process.env.FFMPEG_PATH, priorFfprobe = process.env.FFPROBE_PATH;
  process.env.FFMPEG_PATH = join(project, '不存在的ffmpeg.exe'); process.env.FFPROBE_PATH = join(project, '不存在的ffprobe.exe');
  try {
    const source = recording(content), prepared = await prepareAudioSegments(source);
    assert.equal(prepared.durationSeconds, 1.25); assert.equal(prepared.segments.length, 1);
    assert.equal(prepared.segments[0].content, content); assert.equal(prepared.segments[0].startSeconds, 0); assert.equal(prepared.segments[0].endSeconds, 1.25);
    await prepared.cleanup(); assert.deepEqual(directories(), before);
    const malformed = Buffer.from(content); malformed.writeUInt16LE(65535, 20);
    await assert.rejects(prepareAudioSegments(recording(malformed)), error => error.status === 503 && /FFmpeg/.test(error.message));
    assert.deepEqual(directories(), before);
  } finally {
    if (priorFfmpeg === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = priorFfmpeg;
    if (priorFfprobe === undefined) delete process.env.FFPROBE_PATH; else process.env.FFPROBE_PATH = priorFfprobe;
  }
});

test('超过五分钟的虚构静音录音通过真实 FFmpeg 转为有序短段，16k单声道且总采样完整', { skip: toolSkip }, async () => {
  const duration = 361.12, source = recording(wav(duration, { sampleRate: 44100, channels: 2, bits: 16 }));
  const prepared = await prepareAudioSegments(source);
  const paths = prepared.segments.map(segment => segment.path);
  try {
    assert.ok(prepared.segments.length >= 3); assert.ok(Math.abs(prepared.durationSeconds - duration) < .001);
    let totalSamples = 0, priorEnd = 0;
    for (const segment of prepared.segments) {
      assert.ok(existsSync(segment.path));
      const part = readWav(segment.content);
      assert.equal(part.codec, 1); assert.equal(part.sampleRate, 16000); assert.equal(part.channels, 1); assert.equal(part.bits, 16);
      assert.ok(part.seconds <= 180, `每段实际时长不超过180秒，当前${part.seconds}`);
      assert.ok(part.seconds > 0); assert.equal(segment.startSeconds, priorEnd); priorEnd = segment.endSeconds;
      assert.ok(Math.abs(part.seconds - (segment.endSeconds - segment.startSeconds)) <= 1 / 16000, '片段标注时间与实际音频相符');
      assert.ok(part.data.every(value => value === 0), '无声样本在转换后保持静音');
      totalSamples += part.data.length / 2;
    }
    assert.equal(totalSamples, Math.round(duration * 16000), '切分不丢失或重复采样');
    assert.equal(priorEnd, duration);
  } finally { await prepared.cleanup(); }
  for (const path of paths) assert.equal(existsSync(path), false, '完成后片段临时文件已清除');
});

test('超四小时录音与已取消处理在创建临时目录前拒绝', async () => {
  const before = directories(), long = recording(wav(4 * 60 * 60 + 1, { sampleRate: 1000, channels: 1, bits: 8 }));
  await assert.rejects(prepareAudioSegments(long), error => error.status === 400 && /4 小时/.test(error.message));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(prepareAudioSegments(recording(wav(1)), { signal: controller.signal }), error => error.status === 503 && /取消/.test(error.message));
  assert.deepEqual(directories(), before);
});

test('准备过程中取消会清除新建的临时目录，原始录音不被修改', async () => {
  const controller = new AbortController(), before = directories(), content = wav(181, { sampleRate: 1000, bits: 8 }), snapshot = Buffer.from(content);
  let started = false;
  await assert.rejects(prepareAudioSegments(recording(content), { signal: controller.signal, onProgress: () => { started = true; controller.abort(); } }), error => error.status === 503 && /取消/.test(error.message));
  assert.equal(started, true); assert.deepEqual(content, snapshot); assert.deepEqual(directories(), before);
});

test('损坏音频被真实 FFprobe 拒绝，临时原件和片段均清除', { skip: toolSkip }, async () => {
  const before = directories();
  const corruptCodec = wav(1); corruptCodec.writeUInt16LE(65535, 20);
  for (const content of [Buffer.from('这是一份虚构的损坏 WAV 文件，不能作为录音解析。'), corruptCodec]) {
    await assert.rejects(prepareAudioSegments(recording(content)), error => error.status === 400 && /录音|音轨/.test(error.message));
  }
  assert.deepEqual(directories(), before);
});

test('录音预处理失败或服务中断时不会调用模型供应商', { skip: toolSkip }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'office-audio-preprocess-')), calls = [], store = new OfficeStore({ databasePath: join(directory, 'office.sqlite'), seedDemo: false });
  const client = new AiService({ store, dataDir: directory, fetchImpl: async (...args) => { calls.push(args); throw new Error('不应发送模型请求'); } });
  t.after(async () => { await client.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  client.updateSettings({ enabled: true, baseUrl: 'https://document.example/v1', model: 'synthetic-document', transcriptionProvider: 'qwen', transcriptionBaseUrl: 'https://audio.example/compatible-mode/v1', transcriptionModel: 'qwen3-asr-flash', transcriptionApiKey: 'synthetic-audio-key' });
  const submit = content => ({ configRevision: client.settings().configRevision, file: { name: '虚构录音.wav', contentBase64: content.toString('base64') }, consent: true });
  const before = directories();
  await assert.rejects(client.transcribe(submit(wav(14401, { sampleRate: 1000, bits: 8 }))), error => error.status === 400 && /4 小时/.test(error.message));
  const corruptCodec = wav(1); corruptCodec.writeUInt16LE(65535, 20);
  await assert.rejects(client.transcribe(submit(corruptCodec)), error => error.status === 400);
  const pending = client.transcribe(submit(wav(181, { sampleRate: 1000, bits: 8 })), () => { void client.close(); });
  await assert.rejects(pending, error => error.status === 503);
  assert.equal(calls.length, 0); assert.deepEqual(directories(), before);
});
