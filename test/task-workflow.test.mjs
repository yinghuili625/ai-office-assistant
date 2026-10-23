import { approveCurrentModel } from '../test-support/consent.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OfficeStore } from '../lib/office.mjs';
import { AiService } from '../lib/ai.mjs';
import { TaskWorkflow } from '../lib/task-workflow.mjs';
import { extractTextFile } from '../lib/ai-files.mjs';

const encoded = (name, text) => ({ name, contentBase64: Buffer.from(text).toString('base64') });
function recording() { const bytes = Buffer.alloc(44); bytes.write('RIFF'); bytes.write('WAVE', 8); return { name: '会议录音.wav', contentBase64: bytes.toString('base64') }; }
const draftText = '一、会议基本情况\n虚构会议记录。\n二、议定事项\n甲负责核对台账。\n数据来源对照：会议记录。\n待核实事项：会议时间。';
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'office-task-workflow-')); const calls = [];
  const store = new OfficeStore({ databasePath: join(dir, 'office.sqlite'), seedDemo: false, scheduler: 'external' });
  const ai = approveCurrentModel(new AiService({ store, dataDir: dir, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (options.fetchImpl) return options.fetchImpl(url, init);
    return new Response(JSON.stringify(url.endsWith('/audio/transcriptions') ? { text: '甲负责核对台账，会议日期待核实。' } : { choices: [{ message: { content: draftText } }] }));
  } }));
  const workflow = new TaskWorkflow({ store, ai });
  const task = store.createTask({ title: '例会纪要', owner: '虚构负责人', startDate: '2026-10-20', dueDate: '2026-10-23', deliverable: '包括会议情况、议定事项及责任分工', submissionType: '文本' });
  const configure = () => ai.updateSettings({ enabled: true, baseUrl: 'https://synthetic.invalid/v1', model: '虚构模型', transcriptionModel: '虚构转写', apiKey: 'synthetic-key-only' });
  const generate = async () => {
    configure(); const uploaded = workflow.addSource(task.id, { file: encoded('会议记录.txt', '本次会议：甲负责核对台账。') });
    return (await workflow.draft(task.id, { title: '例会会议纪要', templateId: 'builtin-minutes', materialIds: [uploaded.material.id], referenceIds: [], consent: true })).document;
  };
  t.after(async () => { await ai.close(); try { store.close(); } catch {} await rm(dir, { recursive: true, force: true }); });
  return { dir, store, ai, workflow, task, calls, configure, generate };
}

test('文档本机提取且原件持久保留，录音只上传不发送也不完成任务，备份和重启含原件映射', async t => {
  const { dir, store, ai, workflow, task, calls } = await fixture(t);
  const file = encoded('会议记录.txt', '甲负责核对台账。');
  const { source, material } = workflow.addSource(task.id, { file });
  assert.equal(source.kind, '文档'); assert.equal(material.taskId, task.id); assert.equal(source.materialId, material.id);
  assert.equal(store.getTask(task.id).status, '进行中'); assert.equal(store.getTask(task.id).attachments.length, 0);
  const audio = workflow.addSource(task.id, { file: recording() });
  assert.equal(audio.source.kind, '录音'); assert.equal(audio.material, null); assert.equal(calls.length, 0);
  const workspace = workflow.workspace(task.id); assert.equal(workspace.sourceFiles.length, 2); assert.equal(workspace.materials.length, 1);
  assert.ok(workspace.sourceFiles.every(row => !Object.hasOwn(row, 'content')));
  assert.ok(!JSON.stringify(store.state()).includes(file.contentBase64));
  const backup = join(dir, 'backup.sqlite'); store.createBackup(backup);
  const recovered = new OfficeStore({ databasePath: backup, seedDemo: false });
  const recoveredAi = new AiService({ store: recovered, dataDir: dir }); const recoveredWorkflow = new TaskWorkflow({ store: recovered, ai: recoveredAi });
  assert.equal(Buffer.from(recoveredWorkflow.source(task.id, source.id, true).content).toString(), '甲负责核对台账。');
  assert.equal(recoveredWorkflow.workspace(task.id).sourceFiles.length, 2); assert.equal(recoveredAi.getMaterial(material.id).taskId, task.id);
  await recoveredAi.close(); recovered.close();
  await ai.close(); store.close();
  const restarted = new OfficeStore({ databasePath: join(dir, 'office.sqlite'), seedDemo: false });
  const restartedAi = new AiService({ store: restarted, dataDir: dir }); const restartedWorkflow = new TaskWorkflow({ store: restarted, ai: restartedAi });
  assert.equal(restartedWorkflow.source(task.id, source.id).materialId, material.id);
  assert.equal(Buffer.from(restartedWorkflow.source(task.id, audio.source.id, true).content).length, 44);
  await restartedAi.close(); restarted.close();
});

test('无效原件不落库，任务资料不跨任务访问、提取、删除或用作事实素材', async t => {
  const { store, workflow, task, configure, calls } = await fixture(t); configure();
  assert.throws(() => workflow.addSource(task.id, { file: encoded('伪装.docx', '不是真实文档') }), /损坏|无效/);
  assert.throws(() => workflow.addSource(task.id, { file: encoded('过大.txt', 'a'.repeat(1024 * 1024 + 1)) }), /超过/);
  assert.equal(workflow.workspace(task.id).sourceFiles.length, 0); assert.equal(store.getTask(task.id).status, '待办');
  const { source, material } = workflow.addSource(task.id, { file: encoded('会议记录.txt', '甲核对台账。') });
  const other = store.createTask({ title: '另一项任务', owner: '乙', startDate: '2026-10-20', dueDate: '2026-10-23', deliverable: '提交纪要' });
  assert.throws(() => workflow.source(other.id, source.id), /未找到/);
  assert.throws(() => workflow.deleteSource(other.id, source.id), /未找到/);
  await assert.rejects(workflow.extractSource(other.id, source.id, { consent: true }), /未找到/);
  await assert.rejects(workflow.draft(other.id, { title: '错误关联', templateId: 'builtin-minutes', materialIds: [material.id], consent: true }), /属于当前任务/);
  assert.equal(calls.length, 0);
});

test('录音识别需同意，提取后保留原件并允许编辑正文，重复识别不覆盖', async t => {
  const { ai, workflow, task, configure, calls } = await fixture(t); configure();
  const { source } = workflow.addSource(task.id, { file: recording() });
  await assert.rejects(workflow.extractSource(task.id, source.id, {}), /确认同意/); assert.equal(calls.length, 0);
  const extracted = await workflow.extractSource(task.id, source.id, { consent: true });
  assert.equal(extracted.material.taskId, task.id); assert.match(extracted.material.content, /待核实/);
  ai.saveMaterial({ content: '人工修正：乙负责台账。' }, extracted.material.id);
  await assert.rejects(workflow.extractSource(task.id, source.id, { consent: true }), /已有识别正文/);
  assert.equal(calls.length, 1); assert.equal(ai.getMaterial(extracted.material.id).content, '人工修正：乙负责台账。');
  assert.equal(Buffer.from(workflow.source(task.id, source.id, true).content).length, 44);
});

test('正文被删除或移出任务时原件可重新提取，已编辑的有效正文不会被覆盖', async t => {
  const { store, ai, workflow, task, calls } = await fixture(t);
  const { source, material } = workflow.addSource(task.id, { file: encoded('会议记录.txt', '原始会议记录。') });
  ai.saveMaterial({ content: '人工核对过的正文。' }, material.id);
  await assert.rejects(workflow.extractSource(task.id, source.id, {}), /已有识别正文/);
  assert.equal(ai.getMaterial(material.id).content, '人工核对过的正文。');
  ai.deleteMaterial(material.id);
  assert.equal(workflow.workspace(task.id).sourceFiles[0].materialId, null);
  const recovered = await workflow.extractSource(task.id, source.id, {});
  assert.notEqual(recovered.material.id, material.id); assert.equal(recovered.material.content, '原始会议记录。');
  assert.equal(store.db.prepare('SELECT content FROM ai_materials WHERE id=?').get(material.id).content, '人工核对过的正文。');
  const other = store.createTask({ title: '另一任务', owner: '乙', startDate: '2026-10-20', dueDate: '2026-10-23', deliverable: '整理纪要' });
  ai.saveMaterial({ taskId: other.id }, recovered.material.id);
  assert.equal(workflow.source(task.id, source.id).materialId, null);
  const again = await workflow.extractSource(task.id, source.id, {});
  assert.equal(again.material.taskId, task.id); assert.notEqual(again.material.id, recovered.material.id);
  assert.equal(ai.getMaterial(recovered.material.id).taskId, other.id); assert.equal(calls.length, 0);
});

test('图片识别使用可配置视觉模型并保留原件，仅识别文字和待核实，不把图片直接视为成稿', async t => {
  const { ai, workflow, task, configure, calls, store } = await fixture(t); configure();
  ai.updateSettings({ visionModel: '虚构视觉模型' });
  const contentBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAQSURBVBhXY/gPBAwIwMAAAD3UA/2PTla8AAAAAElFTkSuQmCC';
  const { source } = workflow.addSource(task.id, { file: { name: '会议白板.png', contentBase64 } });
  assert.equal(source.kind, '图片'); assert.equal(source.materialId, null); assert.equal(calls.length, 0);
  await assert.rejects(workflow.extractSource(task.id, source.id, { consent: false }), /确认同意/);
  const extracted = await workflow.extractSource(task.id, source.id, { consent: true });
  assert.equal(extracted.material.taskId, task.id);
  const sent = JSON.parse(calls[0].init.body); assert.equal(sent.model, '虚构视觉模型');
  assert.match(sent.messages[0].content, /不总结、不推断/); assert.match(sent.messages[0].content, /待核实/);
  assert.equal(sent.messages[1].content[1].image_url.url, `data:image/png;base64,${contentBase64}`);
  assert.equal(Buffer.from(workflow.source(task.id, source.id, true).content).toString('base64'), contentBase64);
  assert.equal(store.getTask(task.id).attachments.length, 0); assert.equal(store.getTask(task.id).status, '进行中');
});

test('AI 待处理时任务被删除、完成或原件被删除，识别结果不落库', async t => {
  for (const action of ['delete', 'complete', 'source']) {
    let release, started;
    const upstreamStarted = new Promise(resolve => { started = resolve; });
    const { store, workflow, task, configure } = await fixture(t, { fetchImpl: () => { started(); return new Promise(resolve => { release = () => resolve(new Response(JSON.stringify({ text: '虚构转写结果' }))); }); } });
    configure(); const { source } = workflow.addSource(task.id, { file: recording() });
    const pending = workflow.extractSource(task.id, source.id, { consent: true }); await upstreamStarted;
    if (action === 'delete') store.deleteTask(task.id);
    else if (action === 'complete') store.completeTask(task.id, { confirmed: true, files: [encoded('交付.txt', '已人工核对的交付内容')] });
    else workflow.deleteSource(task.id, source.id);
    release(); await assert.rejects(pending, /未找到|已完成/);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM ai_materials WHERE taskId=?').get(task.id).n, 0);
  }
});

test('任务起草显式发送要求并保存快照，失败不改变任务状态或写入文档', async t => {
  const { workflow, task, calls, generate, ai } = await fixture(t);
  const document = await generate(); const sent = JSON.parse(calls[0].init.body); const context = JSON.parse(sent.messages[1].content);
  assert.equal(context.任务要求.owner, '虚构负责人'); assert.equal(context.任务要求.dueDate, '2026-10-23');
  assert.equal(document.taskRequirements.deliverable, task.deliverable); assert.equal(document.sources.length, 1);
  const source = workflow.workspace(task.id).sourceFiles[0]; workflow.deleteSource(task.id, source.id);
  assert.equal(workflow.workspace(task.id).materials.length, 0); assert.equal(ai.getDocument(document.id).sources.length, 1);
  const failed = await fixture(t, { fetchImpl: async () => { throw new Error('synthetic-key-only'); } });
  failed.configure(); const material = failed.ai.saveMaterial({ title: '本地记录', content: '甲负责台账', taskId: failed.task.id, kind: '素材' });
  await assert.rejects(failed.workflow.draft(failed.task.id, { title: '纪要', templateId: 'builtin-minutes', materialIds: [material.id], consent: true }), error => !error.message.includes('synthetic-key-only'));
  assert.equal(failed.store.getTask(failed.task.id).status, '待办'); assert.equal(failed.workflow.workspace(failed.task.id).documents.length, 0);
});

test('生成等待期间任务完成，初稿不落库；旧起草路径默认不附加任务要求', async t => {
  let release, started; const upstreamStarted = new Promise(resolve => { started = resolve; });
  const { store, ai, workflow, task, configure } = await fixture(t, { fetchImpl: () => { started(); return new Promise(resolve => { release = () => resolve(new Response(JSON.stringify({ choices: [{ message: { content: draftText } }] }))); }); } });
  configure(); const material = ai.saveMaterial({ title: '会议记录', taskId: task.id, kind: '素材', content: '甲负责台账。' });
  const pending = workflow.draft(task.id, { title: '会议纪要', templateId: 'builtin-minutes', materialIds: [material.id], consent: true });
  await upstreamStarted; store.completeTask(task.id, { confirmed: true, files: [encoded('人工交付.txt', '已核对交付')] });
  release(); await assert.rejects(pending, /已完成/); assert.equal(workflow.workspace(task.id).documents.length, 0);
  const legacy = await fixture(t); legacy.configure();
  const oldMaterial = legacy.ai.saveMaterial({ title: '会议记录', taskId: legacy.task.id, kind: '素材', content: '甲负责台账。' });
  const document = await legacy.ai.generate({ title: '原起草', taskId: legacy.task.id, templateId: 'builtin-minutes', materialIds: [oldMaterial.id], consent: true });
  assert.equal(document.taskRequirements, null); assert.ok(!Object.hasOwn(JSON.parse(JSON.parse(legacy.calls[0].init.body).messages[1].content), '任务要求'));
});

test('提交锁定人工确认版本并生成真实 Word，拒绝跨任务旧版本重复提交，重开允许新版本再提交', async t => {
  const { ai, workflow, store, task, generate, calls } = await fixture(t); let document = await generate();
  assert.throws(() => workflow.submit(task.id, { documentId: document.id, revision: 1, confirmed: true }), /人工确认/);
  ai.reviewDocument(document.id, { revision: 1, confirmed: true, quality: '可用' });
  const other = store.createTask({ title: '另一个任务', owner: '乙', startDate: '2026-10-20', dueDate: '2026-10-23', deliverable: '另一次提交' });
  assert.throws(() => workflow.submit(other.id, { documentId: document.id, revision: 1, confirmed: true }), /当前任务/);
  document = ai.updateDocument(document.id, { revision: 1, content: document.content + '\n人工核实：乙负责。' });
  assert.throws(() => workflow.submit(task.id, { documentId: document.id, revision: 1, confirmed: true }), /当前版本/);
  assert.throws(() => workflow.submit(task.id, { documentId: document.id, revision: 2, confirmed: true }), /人工确认/);
  ai.reviewDocument(document.id, { revision: 2, confirmed: true, quality: '需修改', reviewNote: '已修正责任人。' });
  const result = workflow.submit(task.id, { documentId: document.id, revision: 2, confirmed: true });
  assert.equal(result.task.status, '已完成'); assert.equal(result.task.attachments.length, 1); assert.equal(result.submission.revision, 2);
  const attachment = store.getAttachment(result.submission.attachmentId);
  assert.match(extractTextFile({ name: attachment.name, contentBase64: Buffer.from(attachment.content).toString('base64') }).content, /人工核实/);
  assert.equal(calls.length, 1); assert.throws(() => workflow.submit(task.id, { documentId: document.id, revision: 2, confirmed: true }), /已完成/);
  assert.throws(() => workflow.addSource(task.id, { file: encoded('新记录.txt', '补充') }), /重新打开/);
  store.updateTask(task.id, { status: '进行中' });
  document = ai.updateDocument(document.id, { revision: 2, content: document.content + '\n再次核对。' });
  ai.reviewDocument(document.id, { revision: 3, confirmed: true, quality: '可用' });
  const next = workflow.submit(task.id, { documentId: document.id, revision: 3, confirmed: true });
  assert.equal(next.task.status, '已完成'); assert.equal(workflow.workspace(task.id).submissions.length, 2);
  const historical = store.db.prepare('SELECT content FROM task_submissions WHERE id=?').get(result.submission.id);
  assert.doesNotMatch(historical.content, /再次核对/);
});

test('正式交付、完成状态与来源关联同事务，写入关联失败全部回滚且格式不符不完成', async t => {
  const { store, ai, workflow, task, generate } = await fixture(t); const document = await generate();
  ai.reviewDocument(document.id, { revision: 1, confirmed: true, quality: '可用' });
  store.updateTask(task.id, { submissionType: '表格' });
  assert.throws(() => workflow.submit(task.id, { documentId: document.id, revision: 1, confirmed: true }), /不符合提交形式/);
  assert.equal(store.getTask(task.id).status, '进行中'); assert.equal(store.getTask(task.id).attachments.length, 0);
  store.updateTask(task.id, { submissionType: '文本' });
  store.db.exec("CREATE TRIGGER reject_workflow_submission BEFORE INSERT ON task_submissions BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END;");
  assert.throws(() => workflow.submit(task.id, { documentId: document.id, revision: 1, confirmed: true }), /synthetic storage failure/);
  assert.equal(store.getTask(task.id).status, '进行中'); assert.equal(store.getTask(task.id).attachments.length, 0);
  assert.equal(workflow.workspace(task.id).submissions.length, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE taskId=? AND action='完成任务'").get(task.id).n, 0);
});

test('任务起草可直接使用本次模板，优先于模板编号且不保存到模板库，只发送所选本任务素材', async t => {
  const { store, ai, workflow, task, calls, configure } = await fixture(t); configure();
  const material = workflow.addSource(task.id, { file: encoded('本次会议记录.txt', '甲负责核对本次台账。') }).material;
  ai.saveMaterial({ title: '未选材料', kind: '素材', taskId: task.id, content: '不应发送的未选资料。' });
  const other = store.createTask({ title: '另一场会议', owner: '乙', startDate: '2026-10-20', dueDate: '2026-10-23', deliverable: '整理另一场会议' });
  ai.saveMaterial({ title: '其他任务记录', kind: '素材', taskId: other.id, content: '不应发送的其他任务资料。' });
  const templatesBefore = ai.state().templates;
  const template = { name: ' 历史例会文档 ', content: ' 一、会议概况\n二、议定事项\n历史人员王某及日期仅供格式参考。 ' };
  const { document } = await workflow.draft(task.id, { title: '新纪要', templateId: '不应读取这个模板编号', template, materialIds: [material.id], consent: true, taskId: other.id, taskRequirements: { owner: '不可覆盖' } });
  assert.deepEqual(ai.state().templates, templatesBefore);
  assert.deepEqual(document.templateSnapshot, { name: template.name.trim(), content: template.content.trim() });
  assert.equal(document.templateName, '历史例会文档'); assert.equal(document.taskId, task.id);
  assert.equal(document.taskRequirements.owner, task.owner); assert.equal(document.sources.length, 1);
  const sent = JSON.parse(calls[0].init.body); const context = JSON.parse(sent.messages[1].content);
  assert.deepEqual(context.模板, document.templateSnapshot);
  assert.deepEqual(context.本次事实素材.map(item => item.id), [material.id]);
  assert.doesNotMatch(sent.messages[1].content, /不应发送|不可覆盖/);
  assert.match(sent.messages[0].content, /模板仅用于结构与写作格式参考/);
  assert.match(sent.messages[0].content, /历史人员、日期、数据和结论不得作为本次事实沿用/);
});

test('内嵌模板校验名称正文长度、同意和所属任务，失败不调用模型不保存文档；旧起草仍使用模板库', async t => {
  const { store, ai, workflow, task, calls, configure } = await fixture(t); configure();
  const material = ai.saveMaterial({ title: '会议记录', kind: '素材', taskId: task.id, content: '甲负责核对。' });
  const body = { title: '纪要', materialIds: [material.id], consent: true };
  for (const template of [null, {}, { name: '', content: '结构' }, { name: 'a'.repeat(101), content: '结构' }, { name: '格式', content: '' }, { name: '格式', content: 'a'.repeat(20001) }]) {
    await assert.rejects(workflow.draft(task.id, { ...body, template }), /JSON|模板名称|模板内容/);
  }
  const template = { name: '本次格式', content: '一、会议概况\n二、落实分工' };
  await assert.rejects(workflow.draft(task.id, { ...body, template, consent: false }), /确认同意/);
  const other = store.createTask({ title: '另一场会议', owner: '乙', startDate: '2026-10-20', dueDate: '2026-10-23', deliverable: '整理纪要' });
  await assert.rejects(workflow.draft(other.id, { ...body, template }), /属于当前任务/);
  await assert.rejects(ai.generate({ ...body, taskId: task.id, inlineTemplate: template }), /模板编号/);
  assert.equal(calls.length, 0); assert.equal(ai.state().documents.length, 0); assert.equal(store.getTask(task.id).status, '待办');
  const legacy = await ai.generate({ ...body, taskId: task.id, templateId: 'builtin-minutes', inlineTemplate: template });
  assert.equal(legacy.templateSnapshot.id, 'builtin-minutes'); assert.equal(legacy.taskRequirements, null);
  assert.equal(ai.state().templates.length, 3);
});

test('一次完成可保存未保存的编辑、人工确认并生成真实 Word，确认日志不虚构质量评价', async t => {
  const { store, ai, workflow, task, generate, calls } = await fixture(t); const original = await generate();
  const title = '核对后的例会纪要'; const content = original.content + '\n人工确认：甲于三日内完成台账核对。';
  const result = workflow.finish(task.id, { documentId: original.id, revision: 1, title, content, confirmed: true, note: '已核对责任人与完成日期。' });
  assert.equal(result.task.status, '已完成'); assert.equal(result.task.attachments.length, 1);
  assert.equal(result.document.title, title); assert.equal(result.document.content, content);
  assert.equal(result.document.revision, 2); assert.equal(result.document.originalContent, original.content);
  assert.equal(result.document.status, '已确认'); assert.equal(result.document.quality, null);
  assert.equal(result.document.reviews.length, 1); assert.equal(result.document.reviews[0].revision, 2);
  assert.equal(result.document.reviews[0].quality, '未评价'); assert.equal(result.document.reviews[0].reviewNote, '已核对责任人与完成日期。');
  assert.equal(result.document.reviews[0].reviewer, store.settings().adminName);
  assert.deepEqual(ai.state().metrics, { reviewedCount: 0, usableCount: 0, usableRate: null });
  assert.equal(store.db.prepare('SELECT confirmedRevision FROM ai_documents WHERE id=?').get(original.id).confirmedRevision, 2);
  assert.equal(result.submission.revision, 2); assert.equal(result.submission.title, title);
  const saved = store.db.prepare('SELECT * FROM task_submissions WHERE id=?').get(result.submission.id);
  assert.equal(saved.content, content); assert.deepEqual(JSON.parse(saved.sources), original.sources);
  assert.deepEqual(JSON.parse(saved.templateSnapshot), original.templateSnapshot);
  assert.deepEqual(JSON.parse(saved.taskRequirements), original.taskRequirements);
  const attachment = store.getAttachment(result.submission.attachmentId);
  assert.equal(attachment.note, '已核对责任人与完成日期。'); assert.match(attachment.name, /\.docx$/);
  const word = extractTextFile({ name: attachment.name, contentBase64: Buffer.from(attachment.content).toString('base64') });
  assert.match(word.content, /核对后的例会纪要/); assert.match(word.content, /三日内完成台账核对/);
  assert.equal(calls.length, 1);
  assert.throws(() => workflow.finish(task.id, { documentId: original.id, revision: 2, confirmed: true }), /已完成/);
  assert.equal(workflow.workspace(task.id).submissions.length, 1); assert.equal(ai.getDocument(original.id).reviews.length, 1);
});

test('一次完成对未改动或已保存内容不增加无意义版本，默认说明记录人工核对', async t => {
  for (const savedFirst of [false, true]) {
    const { ai, workflow, task, generate } = await fixture(t); let document = await generate();
    if (savedFirst) document = ai.updateDocument(document.id, { revision: document.revision, content: document.content + '\n已保存的人工修改。' });
    const result = workflow.finish(task.id, { documentId: document.id, revision: document.revision, title: document.title, content: document.content, confirmed: true });
    assert.equal(result.document.revision, document.revision); assert.equal(result.submission.revision, document.revision);
    assert.equal(result.document.reviews[0].quality, '未评价'); assert.match(result.document.reviews[0].reviewNote, /提交人确认已核对.*任务交付要求/);
    assert.equal(result.document.quality, null); assert.equal(result.task.status, '已完成');
  }
});

test('一次完成拒绝缺少人工确认、无效正文、过期版本与跨任务；任何失败不改变文档和任务', async t => {
  const { store, ai, workflow, task, generate } = await fixture(t); let document = await generate();
  document = ai.updateDocument(document.id, { revision: 1, content: document.content + '\n保存为新版本。' });
  const other = store.createTask({ title: '另一任务', owner: '乙', startDate: '2026-10-20', dueDate: '2026-10-23', deliverable: '另交文档' });
  const before = { document: ai.getDocument(document.id), task: store.getTask(task.id), other: store.getTask(other.id) };
  const body = { documentId: document.id, revision: 2, confirmed: true, title: '待提交标题', content: '待提交正文' };
  for (const [id, input, expected] of [
    [task.id, { ...body, confirmed: false }, /确认/],
    [task.id, { ...body, confirmed: 'true' }, /确认/],
    [task.id, { ...body, revision: 0 }, /版本号/],
    [task.id, { ...body, revision: 1 }, /版本已变化/],
    [task.id, { ...body, title: '' }, /文档标题/],
    [task.id, { ...body, content: '' }, /文档正文/],
    [task.id, { ...body, content: 'a'.repeat(60001) }, /文档正文/],
    [task.id, { ...body, note: {} }, /提交说明/],
    [task.id, { ...body, note: 'a'.repeat(2001) }, /提交说明/],
    [task.id, { ...body, documentId: '不存在' }, /当前任务/],
    [other.id, body, /当前任务/]
  ]) {
    assert.throws(() => workflow.finish(id, input), expected);
    assert.deepEqual(ai.getDocument(document.id), before.document);
    assert.deepEqual(store.getTask(task.id), before.task); assert.deepEqual(store.getTask(other.id), before.other);
    assert.equal(workflow.workspace(task.id).submissions.length, 0);
  }
  store.deleteTask(task.id);
  assert.throws(() => workflow.finish(task.id, body), /未找到|不存在/);
  assert.deepEqual(ai.getDocument(document.id), before.document);
});

test('一次完成的编辑、人工确认、附件、任务及提交快照原子回滚，格式不符或落库失败均无副作用', async t => {
  const { store, ai, workflow, task, generate } = await fixture(t); const document = await generate();
  const body = { documentId: document.id, revision: 1, title: '不应部分保存的标题', content: '不应部分保存的修改内容。', confirmed: true };
  const snapshot = () => ({
    document: ai.getDocument(document.id), task: store.getTask(task.id),
    submissions: store.db.prepare('SELECT * FROM task_submissions WHERE taskId=?').all(task.id),
    events: store.db.prepare('SELECT * FROM events WHERE taskId=?').all(task.id),
    reminders: store.db.prepare('SELECT * FROM reminders WHERE taskId=?').all(task.id)
  });
  store.updateTask(task.id, { submissionType: '表格' }); const beforeFormat = snapshot();
  assert.throws(() => workflow.finish(task.id, body), /不符合提交形式/);
  assert.deepEqual(snapshot(), beforeFormat);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE taskId=?').get(task.id).n, 0);
  store.updateTask(task.id, { submissionType: '文本' }); const beforeStorage = snapshot();
  store.db.exec("CREATE TRIGGER reject_finish_submission BEFORE INSERT ON task_submissions BEGIN SELECT RAISE(ABORT,'synthetic finish failure'); END;");
  assert.throws(() => workflow.finish(task.id, body), /synthetic finish failure/);
  assert.deepEqual(snapshot(), beforeStorage);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE taskId=?').get(task.id).n, 0);
  assert.deepEqual(ai.state().metrics, { reviewedCount: 0, usableCount: 0, usableRate: null });
  store.db.exec('DROP TRIGGER reject_finish_submission');
  const result = workflow.finish(task.id, body);
  assert.equal(result.document.revision, 2); assert.equal(result.document.reviews.length, 1); assert.equal(result.task.status, '已完成');
});

test('简化提交保留历史真实初稿评价和审核记录，本次人工确认不增加质量评价指标', async t => {
  const { ai, workflow, task, generate } = await fixture(t); const document = await generate();
  ai.reviewDocument(document.id, { revision: 1, confirmed: true, quality: '需修改', reviewNote: '原初稿需要修正责任人。' });
  const beforeMetrics = ai.state().metrics;
  const result = workflow.finish(task.id, { documentId: document.id, revision: 1, content: document.content + '\n人工修正责任人。', confirmed: true });
  assert.equal(result.document.revision, 2); assert.equal(result.document.quality, '需修改');
  assert.deepEqual(result.document.reviews.map(review => [review.revision, review.quality]), [[1, '需修改'], [2, '未评价']]);
  assert.deepEqual(ai.state().metrics, beforeMetrics); assert.equal(result.task.status, '已完成');
});
