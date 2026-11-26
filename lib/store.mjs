import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { normalizeSettings } from './settings.mjs';

const now = () => new Date().toISOString();

export class Store {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, brief TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, roomId TEXT NOT NULL REFERENCES rooms(id),
        role TEXT NOT NULL, content TEXT NOT NULL, createdAt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'completed', jobId TEXT,
        model TEXT, usage TEXT
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, roomId TEXT NOT NULL REFERENCES rooms(id),
        status TEXT NOT NULL, mode TEXT NOT NULL, target TEXT NOT NULL,
        step INTEGER NOT NULL DEFAULT 0, totalSteps INTEGER NOT NULL,
        error TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_room ON messages(roomId,createdAt);
      CREATE INDEX IF NOT EXISTS messages_job_user ON messages(jobId) WHERE role='user';
      CREATE INDEX IF NOT EXISTS jobs_state ON jobs(status,createdAt);
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, roomId TEXT NOT NULL REFERENCES rooms(id), jobId TEXT,
        role TEXT NOT NULL, activity TEXT NOT NULL, createdAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_room ON events(roomId,createdAt);
      CREATE TABLE IF NOT EXISTS sessions (
        roomId TEXT NOT NULL REFERENCES rooms(id), agent TEXT NOT NULL, lane TEXT NOT NULL,
        sessionId TEXT NOT NULL, workspace TEXT NOT NULL, updatedAt TEXT NOT NULL,
        PRIMARY KEY(roomId,agent,lane)
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY, roomId TEXT NOT NULL REFERENCES rooms(id), jobId TEXT,
        agent TEXT NOT NULL, content TEXT NOT NULL, createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, roomId TEXT NOT NULL REFERENCES rooms(id), jobId TEXT NOT NULL,
        agent TEXT NOT NULL, request TEXT NOT NULL, status TEXT NOT NULL,
        response TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS debate_messages (messageId TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, metadata TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_state (agent TEXT PRIMARY KEY, data TEXT NOT NULL);
    `);
    if (!this.db.prepare('PRAGMA table_info(rooms)').all().some(c=>c.name==='settings')) this.db.exec("ALTER TABLE rooms ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'");
    if (!this.db.prepare('PRAGMA table_info(jobs)').all().some(c=>c.name==='settings')) this.db.exec("ALTER TABLE jobs ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'");
    if (!this.db.prepare('PRAGMA table_info(jobs)').all().some(c=>c.name==='progress')) this.db.exec("ALTER TABLE jobs ADD COLUMN progress TEXT NOT NULL DEFAULT '{}'");
    if (!this.db.prepare('PRAGMA table_info(rooms)').all().some(c=>c.name==='archivedAt')) this.db.exec('ALTER TABLE rooms ADD COLUMN archivedAt TEXT');
    // Resposta a uma mensagem específica: {id, role, quote?} (quote é o trecho que o usuário selecionou).
    if (!this.db.prepare('PRAGMA table_info(messages)').all().some(c=>c.name==='reply')) this.db.exec('ALTER TABLE messages ADD COLUMN reply TEXT');
    if (!this.db.prepare('PRAGMA table_info(sessions)').all().some(c=>c.name==='watermark')) this.db.exec('ALTER TABLE sessions ADD COLUMN watermark TEXT; ALTER TABLE sessions ADD COLUMN replyId TEXT;');
  }
  recoverInterruptedJobs() {
    this.db.prepare("UPDATE jobs SET status='interrupted', error=?, updatedAt=? WHERE status IN ('queued','running')")
      .run('A central foi reiniciada. Use Continuar para retomar do último ponto registrado.', now());
    this.db.prepare("UPDATE approvals SET status='expired',updatedAt=? WHERE status='pending'").run(now());
  }
  hydrate(row) { return row ? {...row,settings:normalizeSettings(JSON.parse(row.settings || '{}')), ...(row.progress ? {progress:JSON.parse(row.progress)} : {})} : undefined; }
  listRooms() { return this.db.prepare('SELECT * FROM rooms ORDER BY updatedAt DESC, rowid DESC').all().map(r=>this.hydrate(r)); }
  getRoom(id) { return this.hydrate(this.db.prepare('SELECT * FROM rooms WHERE id=?').get(id)); }
  createRoom(title, brief = '', settings = {}) {
    const id = randomUUID(), date = now();
    this.db.prepare('INSERT INTO rooms (id,title,brief,createdAt,updatedAt,settings) VALUES (?,?,?,?,?,?)').run(id, title, brief, date, date,JSON.stringify(normalizeSettings(settings)));
    return this.getRoom(id);
  }
  updateRoom(id, {title, brief, settings}) {
    const room = this.getRoom(id);
    this.db.prepare('UPDATE rooms SET title=?, brief=?, settings=?, updatedAt=? WHERE id=?')
      .run(title ?? room.title, brief ?? room.brief, JSON.stringify(normalizeSettings(settings ?? {},room.settings)),now(), id);
    return this.getRoom(id);
  }
  // Arquivar só tira a sala da lista principal; nada é apagado.
  setArchived(id, archived) {
    this.db.prepare('UPDATE rooms SET archivedAt=? WHERE id=?').run(archived ? now() : null, id);
    return this.getRoom(id);
  }
  // Exclusão definitiva do histórico da sala (mensagens, tarefas, memória, sessões, aprovações e ações).
  deleteRoom(id) {
    return this.transaction(() => {
      for (const table of ['approvals','checkpoints','sessions','events']) this.db.prepare(`DELETE FROM ${table} WHERE roomId=?`).run(id);
      this.db.prepare('DELETE FROM debate_messages WHERE messageId IN (SELECT id FROM messages WHERE roomId=?)').run(id);
      this.db.prepare('DELETE FROM messages WHERE roomId=?').run(id);
      this.db.prepare('DELETE FROM jobs WHERE roomId=?').run(id);
      return this.db.prepare('DELETE FROM rooms WHERE id=?').run(id).changes > 0;
    });
  }
  messages(roomId) {
    return this.db.prepare('SELECT m.*,d.metadata FROM messages m LEFT JOIN debate_messages d ON d.messageId=m.id WHERE m.roomId=? ORDER BY m.rowid').all(roomId)
      .map(m => ({ ...m, debate:m.metadata?JSON.parse(m.metadata):null, usage: m.usage ? JSON.parse(m.usage) : null, reply: m.reply ? JSON.parse(m.reply) : null }));
  }
  getMessage(roomId, id) {
    return typeof id === 'string' ? this.db.prepare('SELECT id,role,content FROM messages WHERE roomId=? AND id=?').get(roomId, id) || null : null;
  }
  userMessagesAfter(jobId, count) {
    return this.db.prepare("SELECT content FROM messages WHERE jobId=? AND role='user' ORDER BY rowid LIMIT -1 OFFSET ?").all(jobId,count);
  }
  addMessage(roomId, role, content, extra = {}) {
    const id = randomUUID(), date = now();
    this.db.prepare('INSERT INTO messages (id,roomId,role,content,createdAt,status,jobId,model,usage,reply) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, roomId, role, content, date, extra.status ?? 'completed', extra.jobId ?? null,
        extra.model ?? null, extra.usage ? JSON.stringify(extra.usage) : null, extra.reply ? JSON.stringify(extra.reply) : null);
    if(extra.debate)this.db.prepare('INSERT INTO debate_messages VALUES (?,?)').run(id,JSON.stringify(extra.debate));
    this.db.prepare('UPDATE rooms SET updatedAt=? WHERE id=?').run(date, roomId);
    return this.messages(roomId).find(m => m.id === id);
  }
  createJob(roomId, target, mode, totalSteps) {
    const id = randomUUID(), date = now();
    this.db.prepare('INSERT INTO jobs (id,roomId,status,mode,target,step,totalSteps,error,createdAt,updatedAt,settings) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, roomId, 'queued', mode, target, 0, totalSteps, null, date, date,JSON.stringify(this.getRoom(roomId).settings));
    return this.getJob(id);
  }
  getJob(id) { return this.hydrate(this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id)); }
  jobs(roomId) { return this.db.prepare('SELECT * FROM jobs WHERE roomId=? ORDER BY rowid DESC LIMIT 80').all(roomId).map(r=>this.hydrate(r)); }
  activeJobs() { return this.db.prepare("SELECT * FROM jobs WHERE status IN ('queued','running') ORDER BY rowid").all().map(r=>this.hydrate(r)); }
  addEvent(roomId,jobId,role,activity) {
    const event={id:randomUUID(),roomId,jobId,role,activity,createdAt:now()};
    this.db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?)').run(event.id,roomId,jobId,role,JSON.stringify(activity),event.createdAt);
    this.db.prepare('DELETE FROM events WHERE roomId=? AND rowid NOT IN (SELECT rowid FROM events WHERE roomId=? ORDER BY rowid DESC LIMIT 500)').run(roomId,roomId);
    return event;
  }
  events(roomId) {return this.db.prepare('SELECT * FROM events WHERE roomId=? ORDER BY rowid DESC LIMIT 100').all(roomId).map(e=>({...e,activity:JSON.parse(e.activity)}));}
  updateJob(id, {status, step, error, progress, totalSteps, settings}) {
    const previous = this.getJob(id);
    this.db.prepare('UPDATE jobs SET status=?,step=?,error=?,updatedAt=?,progress=?,totalSteps=?,settings=? WHERE id=?')
      .run(status ?? previous.status, step ?? previous.step,
        error === undefined ? previous.error : error, now(), JSON.stringify(progress ?? previous.progress ?? {}),totalSteps ?? previous.totalSteps,
        JSON.stringify(settings ? normalizeSettings(settings) : previous.settings),id);
    return this.getJob(id);
  }
  sessions(roomId) { return this.db.prepare('SELECT * FROM sessions WHERE roomId=?').all(roomId); }
  session(roomId,agent,lane,workspace) {
    const row=this.db.prepare('SELECT * FROM sessions WHERE roomId=? AND agent=? AND lane=?').get(roomId,agent,lane);
    return row?.workspace===workspace ? row : undefined;
  }
  // A marca (`watermark`) é a última mensagem da sala que a sessão já recebeu; `replyId` é a resposta que a
  // própria sessão produziu. Com elas, uma sessão retomada recebe só o que mudou. Sessão nova zera a marca.
  saveSession(roomId,agent,lane,sessionId,workspace,{watermark,replyId}={}) {
    if(typeof sessionId!=='string' || !sessionId || sessionId.length>300) return;
    const previous=this.db.prepare('SELECT * FROM sessions WHERE roomId=? AND agent=? AND lane=?').get(roomId,agent,lane);
    const same=previous?.sessionId===sessionId && previous?.workspace===workspace;
    this.db.prepare('INSERT OR REPLACE INTO sessions (roomId,agent,lane,sessionId,workspace,updatedAt,watermark,replyId) VALUES (?,?,?,?,?,?,?,?)')
      .run(roomId,agent,lane,sessionId,workspace,now(),watermark ?? (same?previous.watermark:null),replyId ?? (same?previous.replyId:null));
  }
  checkpoints(roomId) {return this.db.prepare('SELECT * FROM checkpoints WHERE roomId=? ORDER BY rowid DESC LIMIT 40').all(roomId).map(r=>({...r,content:JSON.parse(r.content)}));}
  checkpoint(roomId,jobId,agent,content) {
    const row={id:randomUUID(),roomId,jobId,agent,content,createdAt:now()};
    this.db.prepare('INSERT INTO checkpoints VALUES (?,?,?,?,?,?)').run(row.id,roomId,jobId,agent,JSON.stringify(content),row.createdAt);
    return row;
  }
  providerState(agent) {const row=this.db.prepare('SELECT data FROM provider_state WHERE agent=?').get(agent);return row?JSON.parse(row.data):{};}
  saveProviderState(agent,data) {this.db.prepare('INSERT OR REPLACE INTO provider_state VALUES (?,?)').run(agent,JSON.stringify(data));}
  createApproval(roomId,jobId,agent,request) {
    const row={id:randomUUID(),roomId,jobId,agent,request,status:'pending',createdAt:now(),updatedAt:now()};
    this.db.prepare('INSERT INTO approvals VALUES (?,?,?,?,?,?,?,?,?)').run(row.id,roomId,jobId,agent,JSON.stringify(request),'pending',null,row.createdAt,row.updatedAt);
    return row;
  }
  approvals(roomId) {return this.db.prepare('SELECT * FROM approvals WHERE roomId=? ORDER BY rowid DESC LIMIT 40').all(roomId).map(r=>({...r,request:JSON.parse(r.request),response:r.response?JSON.parse(r.response):null}));}
  resolveApproval(id,status,response) {this.db.prepare('UPDATE approvals SET status=?,response=?,updatedAt=? WHERE id=? AND status=\'pending\'').run(status,JSON.stringify(response),now(),id);}
  resumableJobs() {return this.db.prepare("SELECT * FROM jobs WHERE status IN ('waiting_capacity','paused_budget','paused_input','interrupted','failed') ORDER BY rowid").all().map(r=>this.hydrate(r));}
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
