import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { addDays, nextOccurrence, advanceOccurrence, todayInShanghai, validDate } from './dates.mjs';
import { InputError, parseCsv, toCsv } from './csv.mjs';
import { acceptsFile, submissionTypes, validateFiles } from './attachments.mjs';

const priorities = ['高', '中', '低'];
const statuses = ['待办', '进行中', '已完成'];
const categories = ['临时任务', '固定任务', '党建工作'];
const frequencies = ['每周', '每月', '每季度', '每年'];
const taskFields = ['title', 'owner', 'startDate', 'dueDate', 'deliverable', 'description', 'priority', 'category', 'status', 'submissionType'];
const templateFields = ['title', 'owner', 'nextDate', 'dueDays', 'frequency', 'deliverable', 'priority', 'active', 'submissionType'];
const fieldLabels = { title: '任务名称', owner: '负责人', startDate: '开始日期', dueDate: '截止日期', deliverable: '交付要求', description: '任务说明', priority: '优先级', submissionType: '提交形式', category: '任务分类', status: '任务状态', nextDate: '下次开始日期', dueDays: '完成天数', frequency: '生成周期', active: '启用状态' };

function object(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('请求内容必须是 JSON 对象。'); return value; }
function string(value, field, limit = 200, required = true) {
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > limit) throw new InputError(`${fieldLabels[field] || field}${required ? '不能为空，且' : ''}最多 ${limit} 个字符。`);
  return value.trim();
}
function enumeration(value, options, field) { if (!options.includes(value)) throw new InputError(`${fieldLabels[field] || field}必须为${options.join('、')}之一。`); return value; }
function date(value, field) { if (!validDate(value)) throw new InputError(`${fieldLabels[field] || field}必须是 1900 至 2200 年之间的有效日期，格式为 年-月-日。`); return value; }
function integer(value, min, max, label) { if (!Number.isInteger(value) || value < min || value > max) throw new InputError(`${label}必须是 ${min} 至 ${max} 的整数。`); return value; }
function filterFields(input, fields) { object(input); const result = {}; for (const key of fields) if (Object.hasOwn(input, key)) result[key] = input[key]; return result; }

function validateTask(input, existing) {
  const task = { description: '', priority: '中', submissionType: '文本', category: '临时任务', status: '待办', ...existing, ...filterFields(input, taskFields) };
  task.title = string(task.title, 'title'); task.owner = string(task.owner, 'owner', 80); task.deliverable = string(task.deliverable, 'deliverable', 2000); task.description = string(task.description, 'description', 5000, false);
  task.startDate = date(task.startDate, 'startDate'); task.dueDate = date(task.dueDate, 'dueDate');
  if (task.dueDate < task.startDate) throw new InputError('截止日期不能早于开始日期。');
  enumeration(task.priority, priorities, 'priority'); enumeration(task.category, categories, 'category'); enumeration(task.status, statuses, 'status');
  enumeration(task.submissionType, submissionTypes, 'submissionType');
  return task;
}

function validateTemplate(input, existing) {
  const template = { dueDays: 0, priority: '中', submissionType: '文本', active: true, ...existing, ...filterFields(input, templateFields) };
  template.title = string(template.title, 'title'); template.owner = string(template.owner, 'owner', 80); template.deliverable = string(template.deliverable, 'deliverable', 2000);
  date(template.nextDate, 'nextDate'); integer(template.dueDays, 0, 90, '完成天数'); enumeration(template.frequency, frequencies, 'frequency'); enumeration(template.priority, priorities, 'priority');
  enumeration(template.submissionType, submissionTypes, 'submissionType');
  if (typeof template.active !== 'boolean') throw new InputError('启用状态必须是布尔值。');
  return template;
}

export class OfficeStore {
  constructor({ databasePath, seedDemo = true, scheduler = 'internal', now = () => new Date(), maxGeneratedPerRun = 100, maxStoredBytes = 4 * 1024 ** 3 }) {
    this.now = now; this.scheduler = scheduler; this.databasePath = resolve(databasePath); mkdirSync(dirname(this.databasePath), { recursive: true });
    this.maxGeneratedPerRun = integer(maxGeneratedPerRun, 1, 1000, '单次周期生成上限');
    this.maxStoredBytes = integer(maxStoredBytes, 1, Number.MAX_SAFE_INTEGER, '文件累计容量上限');
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (number INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, owner TEXT NOT NULL, startDate TEXT NOT NULL, dueDate TEXT NOT NULL, deliverable TEXT NOT NULL, description TEXT NOT NULL, priority TEXT NOT NULL, category TEXT NOT NULL, status TEXT NOT NULL, templateId TEXT, occurrenceDate TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, completedAt TEXT, deletedAt TEXT, UNIQUE(templateId, occurrenceDate));
      CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY, title TEXT NOT NULL, owner TEXT NOT NULL, nextDate TEXT NOT NULL, dueDays INTEGER NOT NULL, frequency TEXT NOT NULL, deliverable TEXT NOT NULL, priority TEXT NOT NULL, active INTEGER NOT NULL, anchorDay INTEGER NOT NULL, anchorMonth INTEGER NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reminders (id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id), title TEXT NOT NULL, message TEXT NOT NULL, kind TEXT NOT NULL, recipients TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0, day TEXT NOT NULL, createdAt TEXT NOT NULL, UNIQUE(taskId,day,kind));
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, taskId TEXT, action TEXT NOT NULL, detail TEXT NOT NULL, actor TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS tasks_due ON tasks(status,dueDate);
      CREATE INDEX IF NOT EXISTS reminders_task ON reminders(taskId);
      CREATE INDEX IF NOT EXISTS events_created ON events(createdAt);
      CREATE INDEX IF NOT EXISTS events_task_created ON events(taskId,createdAt);`);
    // Existing databases are upgraded in place; task numbers, history and references stay intact.
    this.transaction(() => {
      if (!this.db.prepare('PRAGMA table_info(tasks)').all().some(column => column.name === 'deletedAt')) this.db.exec('ALTER TABLE tasks ADD COLUMN deletedAt TEXT');
      if (!this.db.prepare('PRAGMA table_info(tasks)').all().some(column => column.name === 'submissionType')) this.db.exec("ALTER TABLE tasks ADD COLUMN submissionType TEXT NOT NULL DEFAULT '文本'");
      if (!this.db.prepare('PRAGMA table_info(templates)').all().some(column => column.name === 'submissionType')) this.db.exec("ALTER TABLE templates ADD COLUMN submissionType TEXT NOT NULL DEFAULT '文本'");
      this.db.exec(`CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id), name TEXT NOT NULL, size INTEGER NOT NULL, mimeType TEXT NOT NULL, uploadedAt TEXT NOT NULL, submissionType TEXT NOT NULL, note TEXT NOT NULL, batchId TEXT NOT NULL, content BLOB NOT NULL, deletedAt TEXT);
        CREATE INDEX IF NOT EXISTS attachments_task ON attachments(taskId,uploadedAt);`);
      if (!this.db.prepare('PRAGMA table_info(attachments)').all().some(column => column.name === 'deletedAt')) this.db.exec('ALTER TABLE attachments ADD COLUMN deletedAt TEXT');
      this.db.exec('CREATE INDEX IF NOT EXISTS tasks_deleted ON tasks(deletedAt)');
    });
    this.transaction(() => {
      if (this.getMeta('initialized')) return;
      this.setMeta('settings', JSON.stringify({ adminName: '管理员', reminderDays: 1 })); this.setMeta('initialized', this.timestamp());
      if (seedDemo) this.seed();
    });
  }
  timestamp() { return this.now().toISOString(); }
  today() { return todayInShanghai(this.now()); }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  getMeta(key) { return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value; }
  setMeta(key, value) { this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  settings() { return JSON.parse(this.getMeta('settings')); }
  event(action, detail, taskId = null, actor = this.settings().adminName) { this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?)').run(randomUUID(), taskId, action, detail, actor, this.timestamp()); }
  task(row) {
    if (!row) return null;
    const attachments = this.db.prepare('SELECT id,name,size,mimeType,uploadedAt,submissionType,note FROM attachments WHERE taskId=? AND deletedAt IS NULL ORDER BY rowid DESC').all(row.id);
    const deletedAttachments = this.db.prepare('SELECT id,name,size,mimeType,uploadedAt,submissionType,note,deletedAt FROM attachments WHERE taskId=? AND deletedAt IS NOT NULL ORDER BY deletedAt DESC,rowid DESC').all(row.id);
    return { ...row, attachments, deletedAttachments, completionLegacy: row.status === '已完成' && attachments.length === 0, isOverdue: row.status !== '已完成' && row.dueDate < this.today() };
  }
  template(row) { return row ? { ...row, active: Boolean(row.active) } : null; }
  getTask(id) { const result = this.task(this.db.prepare('SELECT * FROM tasks WHERE id=? AND deletedAt IS NULL').get(id)); if (!result) throw new InputError('未找到该任务，任务可能已删除。', 404); return result; }
  getTemplate(id) { const result = this.template(this.db.prepare('SELECT * FROM templates WHERE id=?').get(id)); if (!result) throw new InputError('未找到该固定任务。', 404); return result; }
  trash() { return { tasks: this.db.prepare('SELECT * FROM tasks WHERE deletedAt IS NOT NULL ORDER BY deletedAt DESC,number DESC').all().map(row => this.task(row)) }; }
  state() {
    return {
      tasks: this.db.prepare('SELECT * FROM tasks WHERE deletedAt IS NULL ORDER BY number DESC').all().map(row => this.task(row)),
      templates: this.db.prepare('SELECT * FROM templates ORDER BY createdAt DESC,id').all().map(row => this.template(row)),
      reminders: this.db.prepare('SELECT reminders.* FROM reminders JOIN tasks ON tasks.id=reminders.taskId WHERE tasks.deletedAt IS NULL ORDER BY reminders.createdAt DESC,reminders.rowid DESC').all().map(row => ({ ...row, read: Boolean(row.read), recipients: JSON.parse(row.recipients) })),
      events: this.db.prepare('SELECT * FROM events ORDER BY createdAt DESC,rowid DESC').all(),
      settings: this.settings(), system: { scheduler: this.scheduler === 'external' ? '工作流调度' : '本地定时器', lastRunAt: this.getMeta('lastRunAt') || null, timezone: 'Asia/Shanghai' }
    };
  }
  pageState(options = {}) {
    const positive = (value, fallback, max) => value == null || value === '' ? fallback : integer(Number(value), 1, max, '分页参数');
    const pageSize = positive(options.pageSize, 50, 100);
    const filter = options.filter || '全部';
    if (![...statuses, '全部', '已逾期'].includes(filter)) throw new InputError('任务筛选条件无效。');
    const query = string(options.q ?? '', '搜索内容', 200, false), owner = string(options.owner ?? '', 'owner', 80, false);
    const format = options.submissionType || '';
    if (format && !submissionTypes.includes(format)) throw new InputError('提交形式无效。');
    const conditions = ['deletedAt IS NULL'], parameters = [];
    if (filter === '已逾期') { conditions.push("status!='已完成' AND dueDate<?"); parameters.push(this.today()); }
    else if (filter !== '全部') { conditions.push('status=?'); parameters.push(filter); }
    if (query) { conditions.push('(instr(lower(title),lower(?)) OR instr(lower(owner),lower(?)) OR instr(lower(deliverable),lower(?)) OR instr(CAST(number AS TEXT),?))'); parameters.push(query, query, query, query); }
    if (owner) { conditions.push('owner=?'); parameters.push(owner); }
    if (format) { conditions.push('submissionType=?'); parameters.push(format); }
    const where = conditions.join(' AND ');
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE ${where}`).get(...parameters).n;
    const pageCount = Math.max(1, Math.ceil(total / pageSize)), page = Math.min(positive(options.page, 1, Number.MAX_SAFE_INTEGER), pageCount);
    const tasks = this.db.prepare(`SELECT * FROM tasks WHERE ${where} ORDER BY (status='已完成'),dueDate,createdAt DESC,number DESC LIMIT ? OFFSET ?`).all(...parameters, pageSize, (page - 1) * pageSize).map(row => this.task(row));
    const today = this.today(), day = new Date(`${today}T12:00:00Z`).getUTCDay() || 7, weekStart = addDays(today, 1 - day), weekEnd = addDays(weekStart, 6);
    const summary = this.db.prepare(`SELECT COUNT(*) AS total,COALESCE(SUM(status='待办'),0) AS pending,COALESCE(SUM(status='进行中'),0) AS doing,COALESCE(SUM(status='已完成'),0) AS done,COALESCE(SUM(status!='已完成' AND dueDate<?),0) AS overdue,COALESCE(SUM(status='已完成' AND date(completedAt,'+8 hours') BETWEEN ? AND ?),0) AS weekDone,COALESCE(SUM(dueDate BETWEEN ? AND ?),0) AS weekDueCount,COALESCE(SUM(status='已完成' AND dueDate BETWEEN ? AND ?),0) AS weekDueDone FROM tasks WHERE deletedAt IS NULL`).get(today, weekStart, weekEnd, weekStart, weekEnd, weekStart, weekEnd);
    const reminderBase = 'FROM reminders r JOIN tasks t ON t.id=r.taskId WHERE t.deletedAt IS NULL';
    const reminderCounts = this.db.prepare(`SELECT COUNT(*) AS total,COALESCE(SUM(r.read=0),0) AS unread ${reminderBase}`).get();
    const unreadOnly = options.reminderFilter === '未读', reminderWhere = reminderBase + (unreadOnly ? ' AND r.read=0' : '');
    const reminderTotal = unreadOnly ? reminderCounts.unread : reminderCounts.total;
    const reminderPageCount = Math.max(1, Math.ceil(reminderTotal / 50)), reminderPage = Math.min(positive(options.reminderPage, 1, Number.MAX_SAFE_INTEGER), reminderPageCount);
    const reminders = this.db.prepare(`SELECT r.* ${reminderWhere} ORDER BY r.createdAt DESC,r.rowid DESC LIMIT 50 OFFSET ?`).all((reminderPage - 1) * 50).map(row => ({ ...row, read: Boolean(row.read), recipients: JSON.parse(row.recipients) }));
    return {
      tasks, templates: this.db.prepare('SELECT * FROM templates ORDER BY createdAt DESC,id').all().map(row => this.template(row)), reminders,
      events: this.db.prepare('SELECT * FROM events ORDER BY createdAt DESC,rowid DESC LIMIT 50').all(),
      settings: this.settings(), summary: { ...summary, unread: reminderCounts.unread, reminderTotal: reminderCounts.total },
      owners: this.db.prepare('SELECT DISTINCT owner FROM tasks WHERE deletedAt IS NULL ORDER BY owner').all().map(row => row.owner),
      upcoming: this.db.prepare("SELECT * FROM tasks WHERE deletedAt IS NULL AND status!='已完成' ORDER BY dueDate,number LIMIT 3").all().map(row => this.task(row)),
      pagination: { page, pageSize, total, pageCount }, reminderPagination: { page: reminderPage, pageCount: reminderPageCount, total: reminderTotal },
      system: { scheduler: this.scheduler === 'external' ? '工作流调度' : '本地定时器', lastRunAt: this.getMeta('lastRunAt') || null, timezone: 'Asia/Shanghai', storage: this.storageUsage(), pendingSchedules: this.db.prepare('SELECT COUNT(*) AS n FROM templates WHERE active=1 AND nextDate<=?').get(today).n }
    };
  }
  taskOptions(query = '', selected = '') {
    string(query, '搜索内容', 200, false); string(selected, '任务编号', 100, false);
    const rows = this.db.prepare('SELECT id,number,title FROM tasks WHERE deletedAt IS NULL AND (instr(lower(title),lower(?)) OR instr(CAST(number AS TEXT),?)) ORDER BY number DESC LIMIT 100').all(query, query);
    if (selected && !rows.some(row => row.id === selected)) { const row = this.db.prepare('SELECT id,number,title FROM tasks WHERE id=? AND deletedAt IS NULL').get(selected); if (row) rows.unshift(row); }
    return rows;
  }
  taskDetails(id, pageValue = 1) {
    const task = this.getTask(id), total = this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE taskId=?').get(id).n;
    const pageCount = Math.max(1, Math.ceil(total / 50)), page = Math.min(integer(Number(pageValue), 1, Number.MAX_SAFE_INTEGER, '记录页码'), pageCount);
    return { task, events: this.db.prepare('SELECT * FROM events WHERE taskId=? ORDER BY createdAt DESC,rowid DESC LIMIT 50 OFFSET ?').all(id, (page - 1) * 50), pagination: { page, pageCount, total } };
  }
  storageUsage() {
    let used = this.db.prepare('SELECT COALESCE(SUM(size),0) AS n FROM attachments').get().n;
    if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_sources'").get()) used += this.db.prepare('SELECT COALESCE(SUM(size),0) AS n FROM task_sources').get().n;
    return { used, limit: this.maxStoredBytes };
  }
  ensureStorageCapacity(bytes) {
    const usage = this.storageUsage();
    if (usage.used + bytes > usage.limit) throw new InputError('原始资料和交付文件已达到本机累计容量上限，请先备份归档，或由维护人员调整 MAX_STORED_BYTES 后重启。', 413);
  }
  insertTask(input, { templateId = null, occurrenceDate = null, actor, action = '新增任务', legacySeed = false } = {}) {
    const task = validateTask(input); const id = randomUUID(); const time = this.timestamp(); const completedAt = task.status === '已完成' ? time : null;
    if (task.status === '已完成' && !legacySeed) throw new InputError('请先创建任务，再上传符合要求的交付文件完成任务。');
    this.db.prepare('INSERT INTO tasks(id,title,owner,startDate,dueDate,deliverable,description,priority,category,status,submissionType,templateId,occurrenceDate,createdAt,updatedAt,completedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, ...taskFields.map(key => task[key]), templateId, occurrenceDate, time, time, completedAt);
    this.event(action, `创建“${task.title}”，负责人：${task.owner}，截止日期：${task.dueDate}。`, id, actor);
    return this.getTask(id);
  }
  createTask(input) { return this.transaction(() => this.insertTask(input)); }
  deleteTask(id) {
    return this.transaction(() => {
      const task = this.getTask(id); const time = this.timestamp();
      this.db.prepare('UPDATE tasks SET deletedAt=?,updatedAt=? WHERE id=?').run(time, time, id);
      this.db.prepare('UPDATE reminders SET read=1 WHERE taskId=?').run(id);
      this.event('删除任务', `将“${task.title}”移入回收站，可随时恢复。`, id);
      return { deleted: true, taskId: id };
    });
  }
  restoreTask(id) {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
      if (!existing) throw new InputError('未找到该任务。', 404);
      if (!existing.deletedAt) throw new InputError('该任务未被删除，无需恢复。', 409);
      const time = this.timestamp();
      this.db.prepare('UPDATE tasks SET deletedAt=NULL,updatedAt=? WHERE id=?').run(time, id);
      this.event('恢复任务', `从回收站恢复“${existing.title}”，保留原任务状态：${existing.status}。`, id);
      const task = this.getTask(id);
      this.refreshTaskReminder(task, this.today(), time, this.settings(), true);
      return task;
    });
  }
  updateTask(id, input) {
    return this.transaction(() => {
      const existing = this.getTask(id); const task = validateTask(input, existing); const changed = taskFields.filter(key => task[key] !== existing[key]);
      if (task.status === '已完成' && existing.status !== '已完成') throw new InputError('完成任务前必须上传符合提交形式的交付文件，并确认已核对交付要求。');
      if (task.status === '已完成' && changed.includes('submissionType') && existing.attachments.some(file => !acceptsFile(file.name, task.submissionType))) throw new InputError('现有交付文件不符合新的提交形式，请先重新打开任务，再修改提交形式并重新提交。');
      if (!changed.length) return existing;
      const time = this.timestamp(); const completedAt = task.status === '已完成' ? (existing.completedAt || time) : null;
      this.db.prepare('UPDATE tasks SET title=?,owner=?,startDate=?,dueDate=?,deliverable=?,description=?,priority=?,category=?,status=?,submissionType=?,updatedAt=?,completedAt=? WHERE id=?').run(...taskFields.map(key => task[key]), time, completedAt, id);
      for (const key of changed) {
        const action = key === 'owner' ? '任务改派' : key === 'status' ? (task.status === '已完成' ? '完成任务' : existing.status === '已完成' ? '重新打开' : '状态变更') : '任务变更';
        this.event(action, `${fieldLabels[key]}：${existing[key] || '（空）'} → ${task[key] || '（空）'}`, id);
      }
      if (task.status === '已完成') this.db.prepare('UPDATE reminders SET read=1 WHERE taskId=?').run(id);
      else if (changed.some(key => ['title', 'owner', 'dueDate'].includes(key))) {
        this.db.prepare('UPDATE reminders SET read=1 WHERE taskId=?').run(id);
        // Reconcile an existing reminder now; first-time reminders are created by the scheduler.
        if (this.db.prepare('SELECT id FROM reminders WHERE taskId=? LIMIT 1').get(id)) this.refreshTaskReminder(task, this.today(), time, this.settings(), true);
      }
      else if (existing.status === '已完成' && task.dueDate <= addDays(this.today(), this.settings().reminderDays)) {
        const today = this.today(); const kind = task.dueDate < today ? '逾期' : task.dueDate === today ? '到期' : '临期';
        this.db.prepare('UPDATE reminders SET read=0 WHERE taskId=? AND day=? AND kind=?').run(id, today, kind);
      }
      return this.getTask(id);
    });
  }
  completeTask(id, input) {
    object(input);
    return this.transaction(() => this.completeTaskInTransaction(id, input).task);
  }
  // Internal helper lets workflow provenance and the completion share one transaction.
  completeTaskInTransaction(id, input) {
      object(input);
      const task = this.getTask(id);
      if (task.status === '已完成') throw new InputError('该任务已完成。如需重新提交，请先重新打开任务。', 409);
      if (input.confirmed !== true) throw new InputError('请先按交付要求核对上传内容并勾选确认。');
      const note = string(input.note ?? '', '提交说明', 2000, false);
      const files = validateFiles(input.files, task.submissionType); const time = this.timestamp(); const batchId = randomUUID();
      this.ensureStorageCapacity(files.reduce((total, file) => total + file.size, 0));
      const insert = this.db.prepare('INSERT INTO attachments(id,taskId,name,size,mimeType,uploadedAt,submissionType,note,batchId,content) VALUES(?,?,?,?,?,?,?,?,?,?)');
      const attachmentIds = files.map(file => {
        const attachmentId = randomUUID();
        insert.run(attachmentId, id, file.name, file.size, file.mimeType, time, file.submissionType, note, batchId, file.content);
        return attachmentId;
      });
      this.db.prepare("UPDATE tasks SET status='已完成',completedAt=?,updatedAt=? WHERE id=?").run(time, time, id);
      this.db.prepare('UPDATE reminders SET read=1 WHERE taskId=?').run(id);
      this.event('完成任务', `已提交 ${files.length} 个${task.submissionType}文件：${files.map(file => file.name).join('、')}。提交人确认已按交付要求核对内容。${note ? `提交说明：${note}` : ''}`, id);
      return { task: this.getTask(id), attachmentIds, batchId };
  }
  getAttachment(id) {
    const file = this.db.prepare('SELECT attachments.* FROM attachments JOIN tasks ON tasks.id=attachments.taskId WHERE attachments.id=? AND attachments.deletedAt IS NULL AND tasks.deletedAt IS NULL').get(id);
    if (!file) throw new InputError('未找到该材料，材料可能已删除或所属任务已移入回收站。', 404);
    return file;
  }
  deleteAttachment(id) {
    return this.transaction(() => {
      const file = this.db.prepare('SELECT id,taskId,name,batchId,deletedAt FROM attachments WHERE id=?').get(id);
      if (!file) throw new InputError('未找到该材料。', 404);
      const task = this.getTask(file.taskId);
      if (file.deletedAt) throw new InputError('该材料已删除，无需重复删除。', 409);
      const time = this.timestamp();
      this.db.prepare('UPDATE attachments SET deletedAt=? WHERE id=?').run(time, id);
      this.event('删除材料', `删除“${task.title}”的材料“${file.name}”，可在已删除材料中恢复。`, task.id);
      // Include deleted rows when identifying the latest completion batch: an older
      // submission must never stand in for the files from the latest completion.
      const latestBatch = this.db.prepare('SELECT batchId FROM attachments WHERE taskId=? ORDER BY rowid DESC LIMIT 1').get(task.id)?.batchId;
      const remaining = this.db.prepare('SELECT COUNT(*) AS count FROM attachments WHERE taskId=? AND batchId=? AND deletedAt IS NULL').get(task.id, latestBatch)?.count || 0;
      const reopened = task.status === '已完成' && file.batchId === latestBatch && remaining === 0;
      if (reopened) {
        this.db.prepare("UPDATE tasks SET status='进行中',completedAt=NULL,updatedAt=? WHERE id=?").run(time, task.id);
        this.event('重新打开', '本次完成提交的材料已全部删除，任务恢复为进行中；请重新上传符合要求的材料后完成。', task.id);
        this.refreshTaskReminder(this.getTask(task.id), this.today(), time, this.settings(), true);
      } else this.db.prepare('UPDATE tasks SET updatedAt=? WHERE id=?').run(time, task.id);
      return { deleted: true, attachmentId: id, task: this.getTask(task.id), reopened };
    });
  }
  restoreAttachment(id) {
    return this.transaction(() => {
      const file = this.db.prepare('SELECT id,taskId,name,deletedAt FROM attachments WHERE id=?').get(id);
      if (!file) throw new InputError('未找到该材料。', 404);
      const task = this.getTask(file.taskId);
      if (!file.deletedAt) throw new InputError('该材料未被删除，无需恢复。', 409);
      const time = this.timestamp();
      this.db.prepare('UPDATE attachments SET deletedAt=NULL WHERE id=?').run(id);
      this.db.prepare('UPDATE tasks SET updatedAt=? WHERE id=?').run(time, task.id);
      this.event('恢复材料', `恢复“${task.title}”的材料“${file.name}”，保留任务状态：${task.status}。`, task.id);
      return { restored: true, attachmentId: id, task: this.getTask(task.id) };
    });
  }
  insertTemplate(input, actor) {
    const template = validateTemplate(input); this.checkTemplateDate(template.nextDate); const id = randomUUID(); const time = this.timestamp(); const anchorDay = +template.nextDate.slice(8, 10); const anchorMonth = +template.nextDate.slice(5, 7);
    this.db.prepare('INSERT INTO templates(id,title,owner,nextDate,dueDays,frequency,deliverable,priority,active,submissionType,anchorDay,anchorMonth,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, ...templateFields.map(key => key === 'active' ? Number(template[key]) : template[key]), anchorDay, anchorMonth, time, time);
    this.event('新增固定任务', `创建“${template.title}”，${template.frequency}生成，首次日期：${template.nextDate}。`, null, actor);
    return this.getTemplate(id);
  }
  createTemplate(input) { return this.transaction(() => this.insertTemplate(input)); }
  checkTemplateDate(value) {
    if (value < addDays(this.today(), -365)) throw new InputError('周期开始日期不能早于一年前；请确认年份，较早历史资料请单独归档。');
  }
  updateTemplate(id, input) {
    return this.transaction(() => {
      const existing = this.getTemplate(id); const template = validateTemplate(input, existing); const changed = templateFields.filter(key => template[key] !== existing[key]);
      if (!changed.length) return existing;
      const resetAnchor = changed.includes('nextDate') || changed.includes('frequency');
      if (changed.includes('nextDate')) this.checkTemplateDate(template.nextDate);
      const anchorDay = resetAnchor ? +template.nextDate.slice(8, 10) : existing.anchorDay; const anchorMonth = resetAnchor ? +template.nextDate.slice(5, 7) : existing.anchorMonth;
      this.db.prepare('UPDATE templates SET title=?,owner=?,nextDate=?,dueDays=?,frequency=?,deliverable=?,priority=?,active=?,submissionType=?,anchorDay=?,anchorMonth=?,updatedAt=? WHERE id=?').run(...templateFields.map(key => key === 'active' ? Number(template[key]) : template[key]), anchorDay, anchorMonth, this.timestamp(), id);
      const display = (key, value) => key === 'active' ? (value ? '启用' : '暂停') : String(value);
      this.event('固定任务变更', `“${template.title}”：${changed.map(key => `${fieldLabels[key]}：${display(key, existing[key])} → ${display(key, template[key])}`).join('；')}。`);
      return this.getTemplate(id);
    });
  }
  importTemplates(input) {
    object(input); const rows = parseCsv(input.csv); const headers = ['任务名称', '负责人', '首次开始日期', '完成天数', '周期', '交付要求', '提交形式'];
    const actualHeader = rows[0]?.values.map(value => value.trim()).join(','); const legacy = actualHeader === [...headers.slice(0, 6), '优先级'].join(',');
    if (!rows.length || (actualHeader !== headers.join(',') && !legacy)) throw new InputError(`第 1 行表头必须为：${headers.join(',')}（也兼容旧版优先级表头）。`);
    if (rows.length < 2) throw new InputError('CSV 中没有可导入的数据行。');
    if (rows.length > 1001) throw new InputError('单次最多导入 1000 条固定任务。');
    const templates = rows.slice(1).map(row => {
      try {
        if (row.values.length !== 7) throw new InputError('应有 7 列数据。');
        const [title, owner, nextDate, dueDaysText, frequency, deliverable, lastColumn] = row.values;
        if (!/^\d+$/.test(dueDaysText.trim())) throw new InputError('完成天数必须为整数。');
        const template = validateTemplate({ title, owner, nextDate: nextDate.trim(), dueDays: +dueDaysText, frequency: frequency.trim(), deliverable, ...(legacy ? { priority: lastColumn.trim() || '中' } : { submissionType: lastColumn.trim() || '文本' }) });
        this.checkTemplateDate(template.nextDate);
        return template;
      } catch (error) { throw new InputError(`第 ${row.line} 行：${error.message}`); }
    });
    return this.transaction(() => { templates.forEach(template => this.insertTemplate(template)); this.event('批量导入固定任务', `已导入 ${templates.length} 条固定任务。`); return { created: templates.length }; });
  }
  readReminders(input) {
    object(input);
    if (input.all === true) return { updated: Number(this.db.prepare('UPDATE reminders SET read=1 WHERE read=0').run().changes) };
    if (!Array.isArray(input.ids) || input.ids.length > 5000 || input.ids.some(id => typeof id !== 'string')) throw new InputError('请提供提醒编号数组，或使用全部已读。');
    return this.transaction(() => { let updated = 0; const stmt = this.db.prepare('UPDATE reminders SET read=1 WHERE id=? AND read=0'); for (const id of new Set(input.ids)) updated += Number(stmt.run(id).changes); return { updated }; });
  }
  updateSettings(input) {
    object(input); const previous = this.settings(); const settings = { ...previous };
    if (Object.hasOwn(input, 'adminName')) settings.adminName = string(input.adminName, '管理员姓名', 80);
    if (Object.hasOwn(input, 'reminderDays')) settings.reminderDays = integer(input.reminderDays, 0, 30, '提前提醒天数');
    return this.transaction(() => {
      this.setMeta('settings', JSON.stringify(settings));
      this.db.prepare("UPDATE reminders SET read=1 WHERE taskId IN (SELECT id FROM tasks WHERE deletedAt IS NOT NULL OR status='已完成' OR dueDate>?)").run(addDays(this.today(), settings.reminderDays));
      if (JSON.stringify(previous) !== JSON.stringify(settings)) this.event('设置修改', `管理员：${previous.adminName} → ${settings.adminName}；提前提醒天数：${previous.reminderDays} → ${settings.reminderDays}。`, null, previous.adminName);
      return { settings };
    });
  }
  refreshTaskReminder(task, today, runAt, settings, restoreUnread = false) {
    if (task.deletedAt || task.status === '已完成' || task.dueDate > addDays(today, settings.reminderDays)) return 0;
    const kind = task.dueDate < today ? '逾期' : task.dueDate === today ? '到期' : '临期';
    const recipients = [...new Set([task.owner, settings.adminName])];
    const title = `${kind}提醒：${task.title}`;
    const message = `“${task.title}”${kind === '逾期' ? '已逾期' : kind === '到期' ? '今天到期' : '即将到期'}，截止日期 ${task.dueDate}，负责人 ${task.owner}。`;
    const recipientsJson = JSON.stringify(recipients);
    const result = this.db.prepare('INSERT OR IGNORE INTO reminders(id,taskId,title,message,kind,recipients,day,createdAt) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), task.id, title, message, kind, recipientsJson, today, runAt);
    if (!result.changes) this.db.prepare('UPDATE reminders SET title=?,message=?,recipients=?,read=0 WHERE taskId=? AND day=? AND kind=? AND (? OR title!=? OR message!=? OR recipients!=?)').run(title, message, recipientsJson, task.id, today, kind, Number(restoreUnread), title, message, recipientsJson);
    return Number(result.changes);
  }
  run(actor = '系统调度') {
    return this.transaction(() => {
      const today = this.today(); const runAt = this.timestamp(); let generated = 0; let reminded = 0;
      const templates = this.db.prepare('SELECT * FROM templates WHERE active=1 AND nextDate<=? ORDER BY nextDate,id').all(today);
      for (const template of templates) {
        if (generated >= this.maxGeneratedPerRun) break;
        let occurrence = advanceOccurrence(template.nextDate, template.frequency, template.anchorDay, addDays(today, -365));
        if (occurrence !== template.nextDate) this.event('周期历史归档提示', `“${template.title}”的补齐日期已从 ${template.nextDate} 调整到 ${occurrence}；一年前的周期不自动补建，已有历史任务不变。`, null, actor);
        while (occurrence <= today && generated < this.maxGeneratedPerRun) {
          if (!this.db.prepare('SELECT id FROM tasks WHERE templateId=? AND occurrenceDate=?').get(template.id, occurrence)) {
            this.insertTask({ title: template.title, owner: template.owner, startDate: occurrence, dueDate: addDays(occurrence, template.dueDays), deliverable: template.deliverable, priority: template.priority, submissionType: template.submissionType, category: '固定任务' }, { templateId: template.id, occurrenceDate: occurrence, actor, action: '固定任务生成' }); generated++;
          }
          occurrence = nextOccurrence(occurrence, template.frequency, template.anchorDay);
        }
        this.db.prepare('UPDATE templates SET nextDate=?,updatedAt=? WHERE id=?').run(occurrence, runAt, template.id);
      }
      const settings = this.settings();
      for (const task of this.db.prepare("SELECT * FROM tasks WHERE deletedAt IS NULL AND status!='已完成' AND dueDate<=?").all(addDays(today, settings.reminderDays))) reminded += this.refreshTaskReminder(task, today, runAt, settings);
      this.setMeta('lastRunAt', runAt);
      return { generated, reminded, runAt };
    });
  }
  exportTasks() {
    const rows = [['任务编号', '任务名称', '负责人', '开始日期', '截止日期', '交付要求', '任务说明', '提交形式', '任务分类', '任务状态', '是否逾期', '创建时间', '完成时间', '材料数量']];
    for (const row of this.db.prepare('SELECT * FROM tasks WHERE deletedAt IS NULL ORDER BY number DESC').all()) {
      const task = this.task(row);
      rows.push([task.number, task.title, task.owner, task.startDate, task.dueDate, task.deliverable, task.description, task.submissionType, task.category, task.status, task.isOverdue ? '是' : '否', task.createdAt, task.completedAt || '', task.attachments.length]);
    }
    return toCsv(rows);
  }
  createBackup(path) { this.db.prepare('VACUUM INTO ?').run(path); }
  seed() {
    const today = this.today();
    const samples = [
      { title: '完成季度办公用品采购清单', owner: '李敏', startDate: addDays(today, -7), dueDate: addDays(today, -2), deliverable: '汇总各部门需求，提交采购清单和预算。', priority: '高', status: '进行中' },
      { title: '提交本周工作汇报', owner: '王晨', startDate: addDays(today, -4), dueDate: today, deliverable: '提交一份工作汇报，包含进展、问题及下周计划。', priority: '高', status: '进行中' },
      { title: '整理会议纪要并归档', owner: '张悦', startDate: today, dueDate: addDays(today, 1), deliverable: '整理会议纪要，明确责任人和完成期限。' },
      { title: '筹备主题党日活动', owner: '刘洋', startDate: today, dueDate: addDays(today, 5), deliverable: '形成活动方案及参会人员名单。', category: '党建工作', priority: '高' },
      { title: '更新部门通讯录', owner: '李敏', startDate: addDays(today, -5), dueDate: addDays(today, 2), deliverable: '核对联系方式后保存最新通讯录。', status: '进行中', priority: '低' },
      { title: '完成上月文件归档', owner: '张悦', startDate: addDays(today, -10), dueDate: addDays(today, -3), deliverable: '按部门整理文件并形成归档目录。', status: '已完成' }
    ];
    samples.forEach(task => this.insertTask(task, { actor: '初始化示例', legacySeed: true }));
    this.insertTemplate({ title: '每周办公例会准备', owner: '王晨', nextDate: addDays(today, 1), dueDays: 2, frequency: '每周', deliverable: '整理议程、待办事项与会议材料。' }, '初始化示例');
    this.insertTemplate({ title: '月度工作台账汇总', owner: '李敏', nextDate: addDays(today, 3), dueDays: 3, frequency: '每月', deliverable: '汇总任务完成情况并提交月度台账。', priority: '高' }, '初始化示例');
    this.setMeta('demoSeeded', 'true');
  }
  close() { this.db.close(); }
}
