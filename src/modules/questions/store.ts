// 질문함 모듈(questions · 2026-11-19 마스터 설계 합의) — 에이전트가 물을 결정을 답 본문이 아니라 구조화된 «질문»으로 올린다.
// 마스터는 질문함 화면에서 고르고, 답은 그 방에 «지시» 글로 돌아가 물은 에이전트를 다시 부른다(배달 = 수신 대상 asker).
// 꼴은 Claude Code 의 질문지와 같다: 한 번 1~4문항 · 문항당 2~4안 · 추천안은 첫 자리. 꺼지면 경로 404 · 표·행은 그대로.
import { newId } from '../../crypto.js';
import { t as tr } from '../../i18n.js';
import {
  QUESTION_OPEN,
  type ClaimQuestion,
  type MessageQuestion,
  type Question,
  type QuestionItem,
  type QuestionItemAnswer,
  type QuestionItemStatus,
  type QuestionOption,
  type QuestionStatus,
} from '../../protocol.js';
import { ApiError, now, type Principal, type Row, type Store } from '../../store.js';

export const QUESTIONS_SQL = `
CREATE TABLE IF NOT EXISTS questions (
  id            TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL REFERENCES threads(id),
  asker_id      TEXT NOT NULL REFERENCES participants(id),
  message_seq   INTEGER,
  status        TEXT NOT NULL CHECK (status IN ('open','snoozed','answered','answered_in_chat','superseded','obsolete','dismissed')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  closed_at     INTEGER,
  closed_by     TEXT,
  note          TEXT,
  answer_seq    INTEGER,
  by_msg_seq    INTEGER,
  superseded_by TEXT
);
CREATE INDEX IF NOT EXISTS questions_open ON questions(status, thread_id, asker_id);
CREATE INDEX IF NOT EXISTS questions_msg ON questions(message_seq);
CREATE TABLE IF NOT EXISTS question_items (
  question_id  TEXT NOT NULL REFERENCES questions(id),
  idx          INTEGER NOT NULL,
  header       TEXT,
  question     TEXT NOT NULL,
  multi        INTEGER NOT NULL DEFAULT 0,
  allow_text   INTEGER NOT NULL DEFAULT 1,
  options      TEXT NOT NULL,
  recommended  INTEGER,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','answered_in_chat','superseded','obsolete','dismissed')),
  answer       TEXT,
  answered_at  INTEGER,
  PRIMARY KEY (question_id, idx)
);
`;

const LIM = { items: [1, 4], options: [2, 4], header: 40, question: 1000, label: 200, desc: 500, text: 2000, note: 2000, inferred: 1000 } as const;
const CLOSE_REASONS = ['answered_in_chat', 'superseded', 'obsolete'] as const;
type CloseReason = (typeof CLOSE_REASONS)[number];

export interface QuestionItemInput {
  header?: unknown;
  question?: unknown;
  options?: unknown;
  recommended?: unknown;
  multi?: unknown;
  allow_text?: unknown;
}

const bad = (msg: string) => new ApiError(400, 'bad_question', msg);
function str(v: unknown, max: number, name: string, required = true): string | null {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${name} 가 비었다`);
    return null;
  }
  if (typeof v !== 'string') throw bad(`${name} 는 글자`);
  const s = v.trim();
  if (!s) {
    if (required) throw bad(`${name} 가 비었다`);
    return null;
  }
  if (s.length > max) throw bad(`${name} 는 ${max}자까지`);
  return s;
}

/** 문항 입력 검사 → 저장 꼴. 추천안이 있으면 첫 자리로 옮긴다(질문지 규약 «추천안은 첫 선택지») */
export function normalizeItems(input: unknown): Omit<QuestionItem, 'status' | 'answer' | 'answered_at'>[] {
  if (!Array.isArray(input) || input.length < LIM.items[0] || input.length > LIM.items[1]) throw bad(`문항은 ${LIM.items[0]}~${LIM.items[1]}개`);
  return input.map((raw: QuestionItemInput, idx) => {
    if (!raw || typeof raw !== 'object') throw bad(`문항 ${idx + 1} 꼴이 아니다`);
    const header = str(raw.header, LIM.header, `문항 ${idx + 1} header`, false);
    const question = str(raw.question, LIM.question, `문항 ${idx + 1} question`)!;
    const opts = raw.options;
    if (!Array.isArray(opts) || opts.length < LIM.options[0] || opts.length > LIM.options[1]) throw bad(`문항 ${idx + 1}: 선택지는 ${LIM.options[0]}~${LIM.options[1]}개`);
    let options: QuestionOption[] = opts.map((o: unknown, j) => {
      if (typeof o === 'string') return { label: str(o, LIM.label, `문항 ${idx + 1} 선택지 ${j + 1}`)!, description: null };
      if (!o || typeof o !== 'object') throw bad(`문항 ${idx + 1} 선택지 ${j + 1} 꼴이 아니다`);
      const x = o as { label?: unknown; description?: unknown };
      return { label: str(x.label, LIM.label, `문항 ${idx + 1} 선택지 ${j + 1} label`)!, description: str(x.description, LIM.desc, `문항 ${idx + 1} 선택지 ${j + 1} description`, false) };
    });
    // 라벨 끝에 이미 «(추천)»·«(recommended)»를 적어 보냈으면 떼고 추천 표시로 읽는다 — 화면이 붙인다
    let recommended: number | null = null;
    const recMark = /\s*[(（]\s*(추천|recommended)\s*[)）]\s*$/i;
    options.forEach((o, j) => {
      if (recMark.test(o.label)) {
        o.label = o.label.replace(recMark, '').trim() || o.label;
        if (recommended === null) recommended = j;
      }
    });
    if (raw.recommended !== undefined && raw.recommended !== null) {
      const r = Number(raw.recommended);
      if (!Number.isInteger(r) || r < 0 || r >= options.length) throw bad(`문항 ${idx + 1}: recommended 는 0~${options.length - 1}`);
      recommended = r;
    }
    if (recommended !== null && recommended > 0) {
      const [rec] = options.splice(recommended, 1);
      options = [rec, ...options];
      recommended = 0;
    }
    return { idx, header, question, multi: raw.multi === true, allow_text: raw.allow_text !== false, options, recommended };
  });
}

function itemOf(r: Row): QuestionItem {
  return {
    idx: r.idx,
    header: r.header ?? null,
    question: r.question,
    multi: !!r.multi,
    allow_text: !!r.allow_text,
    options: JSON.parse(r.options),
    recommended: r.recommended ?? null,
    status: r.status,
    answer: r.answer ? (JSON.parse(r.answer) as QuestionItemAnswer) : null,
    answered_at: r.answered_at ?? null,
  };
}

export class QuestionStore {
  constructor(readonly s: Store) {}

  private row(id: string): Row {
    const r = this.s.db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new ApiError(404, 'no_question');
    return r;
  }

  private items(id: string): QuestionItem[] {
    return (this.s.db.prepare('SELECT * FROM question_items WHERE question_id = ? ORDER BY idx').all(id) as Row[]).map(itemOf);
  }

  private out(r: Row): Question {
    const th = this.s.db.prepare('SELECT title FROM threads WHERE id = ?').get(r.thread_id) as Row | undefined;
    const after =
      r.message_seq != null
        ? ((this.s.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE thread_id = ? AND seq > ?').get(r.thread_id, r.message_seq) as Row).n as number)
        : 0;
    return {
      id: r.id,
      thread_id: r.thread_id,
      thread_title: (th?.title as string) ?? null,
      asker_id: r.asker_id,
      message_seq: r.message_seq ?? null,
      status: r.status,
      created_at: r.created_at,
      updated_at: r.updated_at,
      closed_at: r.closed_at ?? null,
      closed_by: r.closed_by ?? null,
      note: r.note ?? null,
      answer_seq: r.answer_seq ?? null,
      by_msg_seq: r.by_msg_seq ?? null,
      superseded_by: r.superseded_by ?? null,
      items: this.items(r.id),
      after_count: after,
    };
  }

  private notify(r: Row) {
    this.s.emit({ notice: { t: 'question', id: r.id, thread_id: r.thread_id, status: r.status }, threadId: r.thread_id });
  }

  /** 이 사람이 이 질문을 볼 수 있나 — 마스터는 모두, 에이전트는 자기 것만 */
  private requireView(pr: Principal, r: Row) {
    if (pr.participant.is_master) return;
    if (r.asker_id !== pr.participant.id) throw new ApiError(404, 'no_question');
  }

  /** 질문 글 본문 — 모듈이 꺼져도 읽히고 에이전트 맥락에도 실리는 글 꼴 */
  private renderPost(items: ReturnType<typeof normalizeItems>): string {
    const L = this.s.lang();
    const lines = [tr(L, 'srv.q.post_head', { n: items.length })];
    for (const it of items) {
      lines.push('', `${it.idx + 1}. ${it.header ? `[${it.header}] ` : ''}${it.question}`);
      it.options.forEach((o, j) =>
        lines.push(`   ${j + 1}) ${o.label}${j === it.recommended ? ` ${tr(L, 'srv.q.rec')}` : ''}${o.description ? ` — ${o.description}` : ''}`),
      );
      if (it.multi) lines.push(`   ${tr(L, 'srv.q.multi')}`);
      if (it.allow_text) lines.push(`   ${tr(L, 'srv.q.text_ok')}`);
    }
    return lines.join('\n');
  }

  /**
   * 에이전트가 질문을 올린다 — 그 방에 «질문» 글(출처 proposal · 받는 이 없음) + 대장 행.
   * 같은 에이전트가 같은 방에 열어 둔 앞 질문은 superseded 로 닫는다(새 질문이 대신한다).
   */
  createQuestion(pr: Principal, input: { thread_id?: unknown; items?: unknown; client_key?: unknown; tags?: unknown }): { question: Question; superseded: string[]; duplicate: boolean } {
    const me = pr.participant;
    if (me.kind !== 'agent') this.s.deny(pr, new ApiError(403, 'agents_only', 'questions are posted by agents'), { action: 'question.create' });
    const threadId = typeof input.thread_id === 'string' ? input.thread_id : '';
    if (!threadId) throw bad('thread_id 가 비었다');
    const items = normalizeItems(input.items);
    const clientKey = typeof input.client_key === 'string' && input.client_key ? input.client_key.slice(0, 120) : `q:${newId('k')}`;
    // 같은 client_key 로 다시 오면(재시도) 앞의 것을 돌려준다
    const prev = this.s.db.prepare('SELECT q.* FROM questions q JOIN messages m ON m.seq = q.message_seq WHERE m.author_id = ? AND m.client_key = ?').get(me.id, clientKey) as Row | undefined;
    if (prev) return { question: this.out(prev), superseded: [], duplicate: true };
    const t = now();
    const id = newId('q');
    const superseded: string[] = [];
    this.s.db.transaction(() => {
      // 글과 대장 행은 함께 서거나 함께 안 선다(better-sqlite3 의 안쪽 트랜잭션은 savepoint)
      const posted = this.s.postMessage(pr, threadId, { client_key: clientKey, body: this.renderPost(items), source_kind: 'proposal', recipients: [], tags: input.tags });
      this.s.db
        .prepare('INSERT INTO questions(id, thread_id, asker_id, message_seq, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(id, threadId, me.id, posted.message.seq, 'open', t, t);
      const ins = this.s.db.prepare('INSERT INTO question_items(question_id, idx, header, question, multi, allow_text, options, recommended) VALUES (?,?,?,?,?,?,?,?)');
      for (const it of items) ins.run(id, it.idx, it.header, it.question, it.multi ? 1 : 0, it.allow_text ? 1 : 0, JSON.stringify(it.options), it.recommended);
      const olds = this.s.db
        .prepare(`SELECT id FROM questions WHERE thread_id = ? AND asker_id = ? AND id != ? AND status IN ('open','snoozed')`)
        .all(threadId, me.id, id) as Row[];
      for (const o of olds) {
        this.closeRow(o.id, 'superseded', 'server', t, { superseded_by: id });
        superseded.push(o.id);
      }
      this.s.audit({
        actor: this.s.actorOf(pr),
        action: 'question.create',
        target_type: 'question',
        target_id: id,
        thread_id: threadId,
        result: 'ok',
        after: { message_seq: posted.message.seq, items: items.length, superseded },
      });
    })();
    for (const o of superseded) this.notify(this.row(o));
    const r = this.row(id);
    this.notify(r);
    return { question: this.out(r), superseded, duplicate: false };
  }

  /** 질문과 열린 문항을 함께 닫는다(트랜잭션 안에서) */
  private closeRow(id: string, status: Exclude<QuestionStatus, 'open' | 'snoozed'>, by: string, t: number, extra: { note?: string | null; answer_seq?: number | null; by_msg_seq?: number | null; superseded_by?: string | null } = {}) {
    const itemStatus: QuestionItemStatus = status;
    this.s.db.prepare("UPDATE question_items SET status = ?, answered_at = COALESCE(answered_at, ?) WHERE question_id = ? AND status = 'open'").run(itemStatus, t, id);
    this.s.db
      .prepare(
        'UPDATE questions SET status = ?, closed_at = ?, closed_by = ?, updated_at = ?, note = COALESCE(?, note), answer_seq = COALESCE(?, answer_seq), by_msg_seq = COALESCE(?, by_msg_seq), superseded_by = COALESCE(?, superseded_by) WHERE id = ?',
      )
      .run(status, t, by, t, extra.note ?? null, extra.answer_seq ?? null, extra.by_msg_seq ?? null, extra.superseded_by ?? null, id);
  }

  /** 목록 — 마스터는 모두, 에이전트는 자기 것. status: open(열림+나중에 · 기본) · closed · all */
  listQuestions(pr: Principal, q: { status?: string; thread_id?: string; limit?: string }): { questions: Question[]; open: number } {
    const where: string[] = [];
    const args: unknown[] = [];
    if (!pr.participant.is_master) {
      where.push('asker_id = ?');
      args.push(pr.participant.id);
    }
    const st = q.status ?? 'open';
    if (st === 'open') where.push("status IN ('open','snoozed')");
    else if (st === 'closed') where.push("status NOT IN ('open','snoozed')");
    else if (st !== 'all') throw new ApiError(400, 'bad_request', 'status: open|closed|all');
    if (q.thread_id) {
      where.push('thread_id = ?');
      args.push(q.thread_id);
    }
    const lim = Math.min(Math.max(Number(q.limit) || 100, 1), 300);
    // 열린 것: 열림 먼저(새것 먼저) · 나중에는 아래로. 닫힌 것: 최근에 닫힌 것 먼저
    const order = st === 'open' ? "status = 'snoozed', created_at DESC" : 'COALESCE(closed_at, updated_at) DESC';
    const rows = this.s.db.prepare(`SELECT * FROM questions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ?`).all(...args, lim) as Row[];
    const visible = rows.filter((r) => pr.participant.is_master || this.s.canRead(pr.participant.id, r.thread_id));
    const open = (
      this.s.db.prepare(`SELECT COUNT(*) AS n FROM questions WHERE status = 'open'${pr.participant.is_master ? '' : ' AND asker_id = ?'}`).get(...(pr.participant.is_master ? [] : [pr.participant.id])) as Row
    ).n as number;
    return { questions: visible.map((r) => this.out(r)), open };
  }

  getQuestion(pr: Principal, id: string): { question: Question } {
    const r = this.row(id);
    this.requireView(pr, r);
    return { question: this.out(r) };
  }

  private requireOpen(r: Row) {
    if (!QUESTION_OPEN.includes(r.status)) throw new ApiError(409, 'question_closed', `질문이 이미 닫혔다(${r.status})`);
  }

  /** 마스터가 지시 글을 그 방에 올려 물은 에이전트를 깨운다 */
  private postInstruction(pr: Principal, r: Row, body: string, key: string): number {
    const res = this.s.postMessage(pr, r.thread_id, {
      client_key: `${key}:${r.id}:${now()}`,
      body,
      source_kind: 'instruction',
      recipients: this.s.canRead(r.asker_id, r.thread_id) ? [r.asker_id] : [],
      reply_to_seq: r.message_seq ?? undefined,
    });
    return res.message.seq;
  }

  /**
   * 마스터의 답. items: [{idx, choices?:number[], text?:string}] · note(덧붙임). 열린 문항은 모두 답해야 한다(고르거나 직접 입력).
   * recommend = true 면 열린 문항을 모두 추천안으로(추천안이 없는 문항이 있으면 409 no_recommendation).
   */
  answerQuestion(pr: Principal, id: string, input: { items?: unknown; note?: unknown }, recommend = false): { question: Question; message_seq: number } {
    this.s.requireMaster(pr, recommend ? 'question.recommend' : 'question.answer', { target_type: 'question', target_id: id });
    const r = this.row(id);
    this.requireOpen(r);
    const items = this.items(id);
    const open = items.filter((x) => x.status === 'open');
    const note = str(input.note, LIM.note, 'note', false);
    const given = new Map<number, { choices: number[]; text: string | null }>();
    if (recommend) {
      for (const it of open) {
        if (it.recommended === null) throw new ApiError(409, 'no_recommendation', `문항 ${it.idx + 1} 에 추천안이 없다`);
        given.set(it.idx, { choices: [it.recommended], text: null });
      }
    } else {
      if (!Array.isArray(input.items)) throw bad('items 가 비었다');
      for (const a of input.items as { idx?: unknown; choices?: unknown; text?: unknown }[]) {
        const it = open.find((x) => x.idx === Number(a?.idx));
        if (!it) throw bad(`열린 문항이 아니다: ${String(a?.idx)}`);
        const choices = Array.isArray(a.choices) ? [...new Set(a.choices.map(Number))] : [];
        if (choices.some((c) => !Number.isInteger(c) || c < 0 || c >= it.options.length)) throw bad(`문항 ${it.idx + 1}: 없는 선택지`);
        if (!it.multi && choices.length > 1) throw bad(`문항 ${it.idx + 1}: 하나만 고른다`);
        const text = str(a.text, LIM.text, `문항 ${it.idx + 1} text`, false);
        if (text && !it.allow_text) throw bad(`문항 ${it.idx + 1}: 직접 입력을 받지 않는다`);
        if (!choices.length && !text) throw bad(`문항 ${it.idx + 1}: 고르거나 적는다`);
        given.set(it.idx, { choices, text });
      }
      for (const it of open) if (!given.has(it.idx)) throw bad(`문항 ${it.idx + 1} 에 답이 없다`);
    }
    const L = this.s.lang();
    const seqLabel = r.message_seq ?? '?';
    const lines = [tr(L, recommend ? 'srv.q.answer_rec_head' : 'srv.q.answer_head', { seq: seqLabel })];
    for (const it of open) {
      const g = given.get(it.idx)!;
      const picked = g.choices.map((c) => tr(L, 'srv.q.answer_pick', { n: c + 1, label: it.options[c].label }));
      if (g.text) picked.push(tr(L, 'srv.q.answer_text', { text: g.text }));
      lines.push(`${it.idx + 1}. ${it.header ?? it.question.slice(0, 80)} → ${picked.join(' · ')}`);
    }
    if (note) lines.push(tr(L, 'srv.q.note', { note }));
    const t = now();
    let seq = 0;
    this.s.db.transaction(() => {
      seq = this.postInstruction(pr, r, lines.join('\n'), recommend ? 'q-rec' : 'q-ans');
      const upd = this.s.db.prepare("UPDATE question_items SET status = 'answered', answer = ?, answered_at = ? WHERE question_id = ? AND idx = ?");
      for (const it of open) {
        const g = given.get(it.idx)!;
        upd.run(JSON.stringify({ choices: g.choices, text: g.text, inferred: null, by_msg_seq: null } satisfies QuestionItemAnswer), t, id, it.idx);
      }
      this.closeRow(id, 'answered', pr.participant.id, t, { note, answer_seq: seq });
      this.s.audit({
        actor: this.s.actorOf(pr),
        action: recommend ? 'question.recommend' : 'question.answer',
        target_type: 'question',
        target_id: id,
        thread_id: r.thread_id,
        result: 'ok',
        after: { message_seq: seq, items: open.length },
      });
    })();
    const nr = this.row(id);
    this.notify(nr);
    return { question: this.out(nr), message_seq: seq };
  }

  /** «나중에» — 질문함에서 아래로 내린다. 에이전트에게는 아무것도 안 보낸다. on=false 면 다시 «열림» */
  snoozeQuestion(pr: Principal, id: string, on = true): { question: Question; changed: boolean } {
    this.s.requireMaster(pr, 'question.snooze', { target_type: 'question', target_id: id });
    const r = this.row(id);
    this.requireOpen(r);
    const to = on ? 'snoozed' : 'open';
    const changed = r.status !== to;
    if (changed) {
      this.s.db.prepare('UPDATE questions SET status = ?, updated_at = ? WHERE id = ?').run(to, now(), id);
      this.s.audit({ actor: this.s.actorOf(pr), action: 'question.snooze', target_type: 'question', target_id: id, thread_id: r.thread_id, result: 'ok', after: { status: to } });
      this.notify(this.row(id));
    }
    return { question: this.out(this.row(id)), changed };
  }

  /** «필요 없음» — 닫고 «이 결정은 하지 말 것»을 지시로 보낸다 */
  dismissQuestion(pr: Principal, id: string, input: { note?: unknown } = {}): { question: Question; message_seq: number } {
    this.s.requireMaster(pr, 'question.dismiss', { target_type: 'question', target_id: id });
    const r = this.row(id);
    this.requireOpen(r);
    const note = str(input.note, LIM.note, 'note', false);
    const L = this.s.lang();
    const body = [tr(L, 'srv.q.dismiss', { seq: r.message_seq ?? '?' }), ...(note ? [tr(L, 'srv.q.note', { note })] : [])].join('\n');
    const t = now();
    let seq = 0;
    this.s.db.transaction(() => {
      seq = this.postInstruction(pr, r, body, 'q-dis');
      this.closeRow(id, 'dismissed', pr.participant.id, t, { note, answer_seq: seq });
      this.s.audit({ actor: this.s.actorOf(pr), action: 'question.dismiss', target_type: 'question', target_id: id, thread_id: r.thread_id, result: 'ok', after: { message_seq: seq } });
    })();
    const nr = this.row(id);
    this.notify(nr);
    return { question: this.out(nr), message_seq: seq };
  }

  /**
   * 에이전트가 자기 질문을 내린다(물은 본인만 · 아니면 403). reason: answered_in_chat(마스터가 글로 답함) · superseded · obsolete(상황이 바뀜).
   * item 을 주면 그 문항만 닫는다(일부만 답했을 때) — 열린 문항이 남으면 질문은 열린 채. answer = 읽어 낸 답 · by_msg_seq = 근거 글.
   */
  closeQuestion(pr: Principal, id: string, input: { reason?: unknown; answer?: unknown; by_msg_seq?: unknown; item?: unknown; items?: unknown }): { question: Question; closed_items: number[] } {
    const r = this.row(id);
    if (r.asker_id !== pr.participant.id)
      this.s.deny(pr, new ApiError(403, 'not_asker', 'only the agent that asked can close it'), { action: 'question.close', target_type: 'question', target_id: id, thread_id: r.thread_id });
    this.requireOpen(r);
    const reason = (input.reason ?? 'answered_in_chat') as CloseReason;
    if (!CLOSE_REASONS.includes(reason)) throw bad(`reason: ${CLOSE_REASONS.join('|')}`);
    let bySeq: number | null = null;
    if (input.by_msg_seq !== undefined && input.by_msg_seq !== null && input.by_msg_seq !== '') {
      bySeq = Number(input.by_msg_seq);
      if (!Number.isInteger(bySeq) || bySeq < 1) throw bad('by_msg_seq 는 글 번호');
      const m = this.s.db.prepare('SELECT thread_id FROM messages WHERE seq = ?').get(bySeq) as Row | undefined;
      if (!m || m.thread_id !== r.thread_id) throw bad('by_msg_seq 가 이 방의 글이 아니다');
    }
    if (reason === 'answered_in_chat' && bySeq === null) throw bad('answered_in_chat 은 by_msg_seq(근거 글)가 있어야 한다');
    const items = this.items(id);
    const open = items.filter((x) => x.status === 'open');
    // 문항별 답: items:[{idx, answer}] 또는 item + answer · 둘 다 없으면 열린 문항 전부에 같은 answer
    const per = new Map<number, string | null>();
    if (Array.isArray(input.items)) {
      for (const a of input.items as { idx?: unknown; answer?: unknown }[]) per.set(Number(a?.idx), str(a?.answer, LIM.inferred, 'answer', false));
    } else if (input.item !== undefined && input.item !== null && input.item !== '') {
      per.set(Number(input.item), str(input.answer, LIM.inferred, 'answer', false));
    } else {
      const ans = str(input.answer, LIM.inferred, 'answer', false);
      for (const it of open) per.set(it.idx, ans);
    }
    for (const k of per.keys()) if (!open.some((x) => x.idx === k)) throw bad(`열린 문항이 아니다: ${k}`);
    if (reason === 'answered_in_chat' && [...per.values()].some((v) => !v)) throw bad('answered_in_chat 은 answer(읽어 낸 답)가 있어야 한다');
    const t = now();
    const closedItems = [...per.keys()].sort((a, b) => a - b);
    this.s.db.transaction(() => {
      const upd = this.s.db.prepare("UPDATE question_items SET status = ?, answer = ?, answered_at = ? WHERE question_id = ? AND idx = ? AND status = 'open'");
      for (const [idx, ans] of per)
        upd.run(reason, ans ? JSON.stringify({ choices: [], text: null, inferred: ans, by_msg_seq: bySeq } satisfies QuestionItemAnswer) : null, t, id, idx);
      const left = (this.s.db.prepare("SELECT COUNT(*) AS n FROM question_items WHERE question_id = ? AND status = 'open'").get(id) as Row).n as number;
      if (left === 0) this.closeRow(id, reason, pr.participant.id, t, { by_msg_seq: bySeq });
      else this.s.db.prepare('UPDATE questions SET updated_at = ?, by_msg_seq = COALESCE(?, by_msg_seq) WHERE id = ?').run(t, bySeq, id);
      this.s.audit({
        actor: this.s.actorOf(pr),
        action: 'question.close',
        target_type: 'question',
        target_id: id,
        thread_id: r.thread_id,
        result: 'ok',
        after: { reason, items: closedItems, by_msg_seq: bySeq, left },
      });
    })();
    const nr = this.row(id);
    this.notify(nr);
    return { question: this.out(nr), closed_items: closedItems };
  }

  /**
   * 마스터의 «다시 열기». 문항을 모두 다시 연다(앞 답은 감사에 남는다).
   * 에이전트가 닫은 것(글로 답함·대체됨·상황 바뀜)이면 «잘못 읽었음, 다시 열림» 지시로 물은 에이전트를 깨운다. 마스터가 닫은 것은 글 없이 연다.
   */
  reopenQuestion(pr: Principal, id: string): { question: Question; message_seq: number | null } {
    this.s.requireMaster(pr, 'question.reopen', { target_type: 'question', target_id: id });
    const r = this.row(id);
    if (QUESTION_OPEN.includes(r.status)) throw new ApiError(409, 'question_open', '이미 열려 있다');
    const byAgent = r.closed_by === r.asker_id || r.closed_by === 'server';
    let seq: number | null = null;
    const before = { status: r.status, closed_by: r.closed_by, by_msg_seq: r.by_msg_seq ?? null, items: this.items(id).map((x) => ({ idx: x.idx, status: x.status, answer: x.answer })) };
    const t = now();
    this.s.db.transaction(() => {
      if (byAgent) {
        const L = this.s.lang();
        seq = this.postInstruction(pr, r, tr(L, 'srv.q.reopen', { seq: r.message_seq ?? '?', reason: tr(L, `srv.q.reason.${r.status}`) }), 'q-reo');
      }
      this.s.db.prepare("UPDATE question_items SET status = 'open', answer = NULL, answered_at = NULL WHERE question_id = ?").run(id);
      this.s.db
        .prepare("UPDATE questions SET status = 'open', closed_at = NULL, closed_by = NULL, note = NULL, answer_seq = NULL, by_msg_seq = NULL, superseded_by = NULL, updated_at = ? WHERE id = ?")
        .run(t, id);
      this.s.audit({ actor: this.s.actorOf(pr), action: 'question.reopen', target_type: 'question', target_id: id, thread_id: r.thread_id, result: 'ok', before, after: { message_seq: seq } });
    })();
    const nr = this.row(id);
    this.notify(nr);
    return { question: this.out(nr), message_seq: seq };
  }

  /** claim 에 싣는 이 방의 내 열린 질문 */
  openForClaim(threadId: string, agentId: string): ClaimQuestion[] {
    const rows = this.s.db
      .prepare("SELECT * FROM questions WHERE thread_id = ? AND asker_id = ? AND status IN ('open','snoozed') ORDER BY created_at")
      .all(threadId, agentId) as Row[];
    return rows.map((r) => ({
      id: r.id,
      seq: r.message_seq ?? null,
      status: r.status,
      items: this.items(r.id).map((it) => ({
        idx: it.idx,
        header: it.header,
        question: it.question,
        options: it.options.map((o) => o.label),
        recommended: it.recommended,
        multi: it.multi,
        status: it.status,
      })),
    }));
  }

  /** 글 → 질문 머리(축소 카드) */
  questionsFor(seqs: number[]): Map<number, MessageQuestion> {
    const map = new Map<number, MessageQuestion>();
    if (!seqs.length) return map;
    const rows = this.s.db
      .prepare(
        `SELECT q.id, q.status, q.message_seq, (SELECT COUNT(*) FROM question_items i WHERE i.question_id = q.id) AS n FROM questions q WHERE q.message_seq IN (${seqs.map(() => '?').join(',')})`,
      )
      .all(...seqs) as Row[];
    for (const r of rows) map.set(r.message_seq, { id: r.id, status: r.status, items: r.n });
    return map;
  }
}
