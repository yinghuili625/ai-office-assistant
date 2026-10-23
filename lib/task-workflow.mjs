import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { InputError } from './csv.mjs';
import { createDocx, decodeAudioFile, decodeImageFile, extractTextFile } from './ai-files.mjs';

const sourceFields = 'id,taskId,name,size,mimeType,kind,materialId,createdAt,extractedAt';
function object(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('请求内容必须是 JSON 对象。'); }
function identifier(value, label) { if (typeof value !== 'string' || !value || value.length > 100) throw new InputError(`${label}无效。`); return value; }

// Meeting inputs are distinct from final task attachments. Both bytes and their
// mappings live in SQLite so the existing backup is a complete local backup.
export class TaskWorkflow {
  constructor({ store, ai }) {
    this.store = store; this.ai = ai;
    store.db.exec(`CREATE TABLE IF NOT EXISTS task_sources (
      id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id), name TEXT NOT NULL,
      size INTEGER NOT NULL, mimeType TEXT NOT NULL, kind TEXT NOT NULL, content BLOB NOT NULL,
      materialId TEXT REFERENCES ai_materials(id), createdAt TEXT NOT NULL, extractedAt TEXT, deletedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS task_sources_task ON task_sources(taskId,deletedAt);
    CREATE TABLE IF NOT EXISTS task_submissions (
      id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id), documentId TEXT NOT NULL REFERENCES ai_documents(id),
      revision INTEGER NOT NULL, attachmentId TEXT NOT NULL REFERENCES attachments(id), title TEXT NOT NULL,
      content TEXT NOT NULL, templateSnapshot TEXT NOT NULL, sources TEXT NOT NULL, taskRequirements TEXT NOT NULL,
      submittedAt TEXT NOT NULL, submittedBy TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS task_submissions_task ON task_submissions(taskId,submittedAt);`);
  }
  activeTask(id) {
    const task = this.store.getTask(identifier(id, '任务编号'));
    if (task.status === '已完成') throw new InputError('该任务已完成，请先重新打开任务再修改或提交。', 409);
    return task;
  }
  startTask(id, detail) {
    const task = this.activeTask(id);
    if (task.status === '待办') {
      this.store.db.prepare("UPDATE tasks SET status='进行中',updatedAt=? WHERE id=?").run(this.store.timestamp(), id);
      this.store.event('开始整理', detail, id);
    }
  }
  workspace(id) {
    const task = this.store.getTask(identifier(id, '任务编号'));
    const state = this.ai.state();
    return {
      task, settings: state.settings, templates: state.templates,
      materials: state.materials.filter(material => material.kind === '素材' && material.taskId === id),
      references: state.materials.filter(material => material.kind === '历史样例'),
      documents: state.documents.filter(document => document.taskId === id),
      sourceFiles: this.store.db.prepare(`SELECT ${sourceFields} FROM task_sources WHERE taskId=? AND deletedAt IS NULL ORDER BY rowid DESC`).all(id).map(source => this.currentSource(source)),
      submissions: this.store.db.prepare('SELECT s.id,s.taskId,s.documentId,s.revision,s.attachmentId,s.title,s.submittedAt,s.submittedBy,a.deletedAt AS attachmentDeletedAt FROM task_submissions s JOIN attachments a ON a.id=s.attachmentId WHERE s.taskId=? ORDER BY s.rowid DESC').all(id)
    };
  }
  currentSource(source) {
    // A material can also be deleted or reassigned from the general AI library.
    // Treat a stale link as unextracted, without reviving or overwriting its text.
    if (source.materialId && !this.store.db.prepare("SELECT id FROM ai_materials WHERE id=? AND taskId=? AND kind='素材' AND deletedAt IS NULL").get(source.materialId, source.taskId)) return { ...source, materialId: null, extractedAt: null };
    return source;
  }
  source(id, sourceId, withContent = false) {
    this.store.getTask(identifier(id, '任务编号'));
    const row = this.store.db.prepare(`SELECT ${sourceFields}${withContent ? ',content' : ''} FROM task_sources WHERE id=? AND taskId=? AND deletedAt IS NULL`).get(identifier(sourceId, '资料编号'), id);
    if (!row) throw new InputError('未找到该任务的会议资料，资料可能已删除。', 404);
    return this.currentSource(row);
  }
  addSource(id, body) {
    object(body); this.activeTask(id);
    const file = body.file; const extension = typeof file?.name === 'string' ? extname(file.name).toLowerCase() : '';
    let decoded, extracted = null, kind;
    if (['.txt', '.md', '.csv', '.docx'].includes(extension)) {
      extracted = extractTextFile(file); kind = '文档';
      const mimeTypes = { '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
      decoded = { name: file.name, mimeType: mimeTypes[extension], content: Buffer.from(file.contentBase64, 'base64') };
    } else if (['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) { decoded = decodeImageFile(file); kind = '图片'; }
    else { decoded = decodeAudioFile(file, 100 * 1024 * 1024); kind = '录音'; }
    return this.store.transaction(() => {
      this.activeTask(id); const now = this.store.timestamp(); const sourceId = randomUUID();
      this.store.ensureStorageCapacity(decoded.content.length);
      const material = extracted ? this.ai.saveMaterial({ title: extracted.title, content: extracted.content, taskId: id, kind: '素材' }) : null;
      this.store.db.prepare('INSERT INTO task_sources(id,taskId,name,size,mimeType,kind,content,materialId,createdAt,extractedAt) VALUES(?,?,?,?,?,?,?,?,?,?)').run(sourceId, id, decoded.name, decoded.content.length, decoded.mimeType, kind, decoded.content, material?.id ?? null, now, material ? now : null);
      this.startTask(id, '已上传本次会议资料，开始整理任务。');
      this.store.event('上传会议资料', `上传${kind}“${decoded.name}”${material ? '，已在本机提取可编辑正文' : '，原件已保存在本机，尚未发送至模型'}。`, id);
      return { source: this.source(id, sourceId), material };
    });
  }
  async extractSource(id, sourceId, body, onProgress = () => {}) {
    object(body); this.activeTask(id);
    const source = this.source(id, sourceId, true);
    if (source.materialId) throw new InputError('该资料已有识别正文，请直接核对或编辑正文，不会覆盖已有内容。', 409);
    const file = { name: source.name, contentBase64: Buffer.from(source.content).toString('base64') };
    if (source.kind !== '文档' && body.consent !== true) throw new InputError('请先确认同意将该原件发送到当前配置的模型服务。');
    const consent = { file, consent: body.consent, configRevision: body.configRevision };
    const result = source.kind === '文档' ? { text: extractTextFile(file).content } : source.kind === '录音' ? await this.ai.transcribe(consent, onProgress) : await this.ai.recognizeImage(consent);
    this.ai.ensureOpen();
    return this.store.transaction(() => {
      this.activeTask(id); const current = this.source(id, sourceId);
      if (current.materialId) throw new InputError('资料已有识别正文，本次结果未覆盖已有内容。', 409);
      const material = this.ai.saveMaterial({ title: source.name.slice(0, -extname(source.name).length), content: result.text, taskId: id, kind: '素材' });
      this.store.db.prepare('UPDATE task_sources SET materialId=?,extractedAt=? WHERE id=? AND taskId=? AND deletedAt IS NULL').run(material.id, this.store.timestamp(), sourceId, id);
      this.startTask(id, '已识别会议资料，待核对正文。');
      this.store.event('识别会议资料', `已识别${source.kind}“${source.name}”，请核对人名、数字及不清晰内容。`, id);
      return { source: this.source(id, sourceId), material };
    });
  }
  deleteSource(id, sourceId) {
    return this.store.transaction(() => {
      this.activeTask(id); const source = this.source(id, sourceId); const now = this.store.timestamp();
      this.store.db.prepare('UPDATE task_sources SET deletedAt=? WHERE id=? AND taskId=?').run(now, sourceId, id);
      if (source.materialId) this.store.db.prepare('UPDATE ai_materials SET deletedAt=?,updatedAt=? WHERE id=? AND taskId=?').run(now, now, source.materialId, id);
      this.store.event('删除会议资料', `删除“${source.name}”及其关联正文，已有文档的资料快照继续保留。`, id);
      return { deleted: true, sourceId };
    });
  }
  async draft(id, body) {
    object(body); this.activeTask(id);
    // Never accept caller-provided taskId or requirements from another task.
    const document = await this.ai.generate({ title: body.title, templateId: body.templateId, ...(Object.hasOwn(body, 'template') ? { inlineTemplate: body.template } : {}), materialIds: body.materialIds, referenceIds: body.referenceIds ?? [], consent: body.consent, configRevision: body.configRevision, taskId: id, includeTaskRequirements: true });
    return { document };
  }
  submit(id, body) {
    return this.store.transaction(() => this.submitInTransaction(id, body));
  }
  // Keep the original confirmed-version gate for both existing and one-page submission.
  submitInTransaction(id, body) {
    object(body);
    if (body.confirmed !== true) throw new InputError('请先确认已核对成稿及任务交付要求。');
    if (!Number.isSafeInteger(body.revision) || body.revision < 1) throw new InputError('请提供有效的文档版本号。');
    const task = this.activeTask(id);
    const document = this.store.db.prepare('SELECT * FROM ai_documents WHERE id=? AND taskId=?').get(identifier(body.documentId, '文档编号'), id);
    if (!document) throw new InputError('只能提交当前任务关联的文档。', 404);
    if (document.revision !== body.revision || document.status !== '已确认' || document.confirmedRevision !== document.revision) throw new InputError('只能提交已经人工确认的当前版本，请重新核对并确认。', 409);
    const name = `${document.title.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100) || '会议纪要'}.docx`;
    const bytes = createDocx(document.title, document.content);
    const completed = this.store.completeTaskInTransaction(id, { confirmed: true, note: body.note ?? '', files: [{ name, contentBase64: bytes.toString('base64') }] });
    const submissionId = randomUUID(); const now = this.store.timestamp();
    const requirements = document.taskRequirements || JSON.stringify({ title: task.title, owner: task.owner, dueDate: task.dueDate, deliverable: task.deliverable, description: task.description, submissionType: task.submissionType });
    this.store.db.prepare('INSERT INTO task_submissions(id,taskId,documentId,revision,attachmentId,title,content,templateSnapshot,sources,taskRequirements,submittedAt,submittedBy) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(submissionId, id, document.id, document.revision, completed.attachmentIds[0], document.title, document.content, document.templateSnapshot, document.sources, requirements, now, this.store.settings().adminName);
    this.store.event('提交会议成稿', `提交已确认的“${document.title}”第 ${document.revision} 版，保存 Word 文件及资料来源快照。`, id);
    const submission = this.workspace(id).submissions.find(item => item.id === submissionId);
    return { task: completed.task, submission };
  }
  finish(id, body) {
    this.ai.ensureOpen(); object(body);
    if (body.confirmed !== true) throw new InputError('请先确认已核对成稿及任务交付要求。');
    if (!Number.isSafeInteger(body.revision) || body.revision < 1) throw new InputError('请提供有效的文档版本号。');
    const note = body.note ?? '';
    if (typeof note !== 'string' || note.length > 2000 || note.includes('\u0000')) throw new InputError('提交说明最多 2000 个字符，且不能包含无效字符。');
    return this.store.transaction(() => {
      this.activeTask(id);
      const previous = this.store.db.prepare('SELECT id,revision FROM ai_documents WHERE id=? AND taskId=?').get(identifier(body.documentId, '文档编号'), id);
      if (!previous) throw new InputError('只能提交当前任务关联的文档。', 404);
      if (previous.revision !== body.revision) throw new InputError('文档版本已变化，请重新打开最新版本后核对并提交。', 409);
      const document = this.ai.updateDocumentInTransaction(previous.id, body);
      const reviewer = this.store.settings().adminName; const now = this.store.timestamp();
      // Confirmation is a human content check, not an evaluation of AI draft quality.
      // Preserve any real earlier evaluation; never fabricate one for the simplified flow.
      this.store.db.prepare('INSERT INTO ai_reviews(id,documentId,revision,reviewer,reviewedAt,reviewNote,quality) VALUES(?,?,?,?,?,?,?)').run(randomUUID(), document.id, document.revision, reviewer, now, note.trim() || '提交人确认已核对成稿和任务交付要求。', '未评价');
      this.store.db.prepare("UPDATE ai_documents SET status='已确认',reviewedAt=?,reviewer=?,confirmedRevision=?,updatedAt=? WHERE id=? AND revision=?").run(now, reviewer, document.revision, now, document.id, document.revision);
      const result = this.submitInTransaction(id, { documentId: document.id, revision: document.revision, confirmed: true, note: note.trim() });
      return { ...result, document: this.ai.getDocument(document.id) };
    });
  }
}
