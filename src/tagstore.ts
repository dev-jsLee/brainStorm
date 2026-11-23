// 태그 보기 1단계 — 등록부(마스터 #1475 «새 태그는 에이전트가 만들지 못하게» · #1481 대표 에이전트·태그별 담당자·보관 읽기 전용).
// 마이그레이션 19 의 tags 표. 만들기·이름 바꾸기·담당자·보관·되살리기는 마스터만, 목록은 인증된 누구나.
// 대표 에이전트는 meta 'default_agent' — 루트와 담당자 없는 태그의 기본 수신자. 담당자 NULL = 대표를 따른다(덮어쓰기 모형).
import { newId } from './crypto.js';
import type { Message, MessageTags, TagKind } from './protocol.js';
import { ApiError, now, reqString, toMessage, type Principal, type Row, type Store } from './store.js';
import { parseTags } from './tags.js';

/** 태그 t 의 마지막 부름 — 주 태그(role primary)로 붙은 글 중 가장 늦은 시각 · 인라인 언급은 부름이 아니다(사양 6절) */
const LAST_CALLED = `(SELECT MAX(m.created_at) FROM message_tags mt JOIN messages m ON m.seq = mt.message_seq JOIN threads th ON th.id = m.thread_id
  WHERE mt.tag_id = t.id AND mt.role = 'primary' AND th.deleted_at IS NULL)`;

export interface Tag {
  id: string;
  name: string;
  /** 종류(마이그레이션 22 · 마스터 #1933) — 'topic' 주제 · 'meta' 메타(주 태그 첫 자리·차선·답장 상속이 안 됨) */
  kind: TagKind;
  /** 담당자(NULL 이면 대표 에이전트) */
  owner_id: string | null;
  /** 지금 이 태그의 수신자 — owner_id ?? 대표 에이전트(없으면 null) */
  recipient_id: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  /** 숨김(마이그레이션 21) — 목록·고르개·자동완성·답장 상속에서 빠진다 · 인식·태그 방·글쓰기는 그대로 */
  hidden_at: number | null;
  /** 휴지통(마이그레이션 21) — 인식이 멈춘다 · 글 연결은 지킨다 · 되살리기 / 영구 삭제 */
  deleted_at: number | null;
  /** 마지막 부름 — 이 태그가 주 태그로 붙은 글의 가장 늦은 created_at(휴지통 스레드 제외 · 없으면 null) · 사양 6절 D10 */
  last_called_at: number | null;
}

/** 태그 이름: 글자·숫자·_·- · 1~40자 · 숫자만은 안 된다(글 번호와 헷갈림) — src/tags.ts 의 NAME 과 같은 규칙 */
const NAME_RE = /^[\p{L}\p{N}_-]{1,40}$/u;

export class TagStore {
  constructor(readonly s: Store) {}

  defaultAgent(): string | null {
    const r = this.s.db.prepare("SELECT value FROM meta WHERE key = 'default_agent'").get() as Row | undefined;
    return (r?.value as string) ?? null;
  }

  /** 대표 에이전트(마스터만) — 에이전트 참여자여야 한다 · null 이면 지운다 */
  setDefaultAgent(pr: Principal, value: unknown): { default_agent: string | null } {
    this.s.requireMaster(pr, 'settings.default_agent');
    let id: string | null = null;
    if (value !== null && value !== undefined && value !== '') {
      if (typeof value !== 'string') throw new ApiError(400, 'bad_request', 'default_agent must be a participant id or null');
      const p = this.s.getParticipant(value);
      if (!p || p.kind !== 'agent') throw new ApiError(400, 'bad_agent');
      id = p.id;
    }
    const before = this.defaultAgent();
    if (id) this.s.db.prepare("INSERT INTO meta(key, value) VALUES ('default_agent', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(id);
    else this.s.db.prepare("DELETE FROM meta WHERE key = 'default_agent'").run();
    if (before !== id) this.s.audit({ actor: this.s.actorOf(pr), action: 'settings.default_agent', result: 'ok', before: { default_agent: before }, after: { default_agent: id } });
    return { default_agent: id };
  }

  private toTag(r: Row, def: string | null): Tag {
    return {
      id: r.id as string,
      name: r.name as string,
      kind: r.kind === 'meta' ? 'meta' : 'topic',
      owner_id: (r.owner_id as string) ?? null,
      recipient_id: ((r.owner_id as string) ?? def) ?? null,
      created_by: r.created_by as string,
      created_at: r.created_at as number,
      updated_at: r.updated_at as number,
      archived_at: (r.archived_at as number) ?? null,
      hidden_at: (r.hidden_at as number) ?? null,
      deleted_at: (r.deleted_at as number) ?? null,
      last_called_at: (r.last_called_at as number) ?? null,
    };
  }

  /** 목록 — 인증된 누구나. 기본은 살아 있는 것만(보관·숨김·휴지통 뺌) · `archived`·`hidden`·`trash` 를 켜면 그것도 */
  list(include: boolean | { archived?: boolean; hidden?: boolean; trash?: boolean } = false): Tag[] {
    const inc = typeof include === 'boolean' ? { archived: include } : include;
    const def = this.defaultAgent();
    const where: string[] = [];
    if (!inc.archived) where.push('t.archived_at IS NULL');
    if (!inc.hidden) where.push('t.hidden_at IS NULL');
    if (!inc.trash) where.push('t.deleted_at IS NULL');
    // 거리 순(사양 6절 D10 · 마스터 #1510): 최근에 부른 태그가 먼저 · 한 번도 안 부른 태그는 끝에 이름 순
    const rows = this.s.db
      .prepare(`SELECT t.*, ${LAST_CALLED} AS last_called_at FROM tags t ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                ORDER BY last_called_at IS NULL, last_called_at DESC, t.name`)
      .all() as Row[];
    return rows.map((r) => this.toTag(r, def));
  }

  get(id: string): Tag | null {
    const r = this.s.db.prepare(`SELECT t.*, ${LAST_CALLED} AS last_called_at FROM tags t WHERE t.id = ?`).get(id) as Row | undefined;
    return r ? this.toTag(r, this.defaultAgent()) : null;
  }

  /** 파서에 주는 등록 이름 집합 — 살아 있는 태그만(보관·휴지통 태그는 글자로 남는다 · 사양 5절 · 숨긴 태그는 인식된다) */
  knownNames(): Set<string> {
    return new Set((this.s.db.prepare('SELECT name FROM tags WHERE archived_at IS NULL AND deleted_at IS NULL').all() as Row[]).map((r) => r.name as string));
  }

  private normName(v: unknown): string {
    const name = reqString(v, 'name', 40).trim().replace(/^#/, '');
    if (!NAME_RE.test(name) || /^\p{N}+$/u.test(name)) throw new ApiError(400, 'bad_tag_name', 'name: letters/digits/_/- · 1~40 · not digits only');
    return name;
  }

  private ownerOf(v: unknown): string | null {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string') throw new ApiError(400, 'bad_request', 'owner_id must be a participant id or null');
    const p = this.s.getParticipant(v);
    if (!p || p.kind !== 'agent') throw new ApiError(400, 'bad_agent');
    return p.id;
  }

  /** 만들기 — 마스터만(에이전트는 403 master_only). 같은 이름이면 409 */
  create(pr: Principal, input: { name?: unknown; owner_id?: unknown }): Tag {
    this.s.requireMaster(pr, 'tag.create');
    const name = this.normName(input.name);
    const owner = this.ownerOf(input.owner_id);
    const dup = this.s.db.prepare('SELECT id, deleted_at FROM tags WHERE name = ?').get(name) as Row | undefined;
    if (dup) {
      const code = dup.deleted_at ? 'tag_in_trash' : 'tag_exists';
      this.s.audit({ actor: this.s.actorOf(pr), action: 'tag.create', target_type: 'tag', target_id: dup.id as string, result: 'denied', reason: code });
      // 휴지통에 같은 이름이 있으면 되살리거나 영구 삭제한 뒤 만든다
      if (dup.deleted_at) throw new ApiError(409, 'tag_in_trash', undefined, { tag_id: dup.id });
      throw new ApiError(409, 'tag_exists', `tag #${name} exists`, { tag_id: dup.id });
    }
    const id = newId('tg');
    const t = now();
    this.s.db.prepare('INSERT INTO tags(id, name, owner_id, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(id, name, owner, pr.participant.id, t, t);
    const tag = this.get(id)!;
    this.s.audit({ actor: this.s.actorOf(pr), action: 'tag.create', target_type: 'tag', target_id: id, result: 'ok', after: { name, owner_id: owner } });
    this.s.emit({ notice: { t: 'tag', tag_id: id }, threadId: null });
    return tag;
  }

  /**
   * 고치기 — 이름·담당자(`owner_id: null` 이면 대표를 따름)·보관(`archived: true|false`)·숨김(`hidden: true|false`)·
   * 종류(`kind: 'topic'|'meta'` · 마이그레이션 22 · 마스터 #1933). 마스터만 · 휴지통 것은 409 ·
   * 어느 스레드가 고정한 태그를 메타로 바꾸면 409 tag_pinned(고정을 먼저 푼다).
   */
  update(pr: Principal, id: string, input: { name?: unknown; owner_id?: unknown; archived?: unknown; hidden?: unknown; kind?: unknown }): Tag {
    this.s.requireMaster(pr, 'tag.update', { target_type: 'tag', target_id: id });
    const cur = this.get(id);
    if (!cur) throw new ApiError(404, 'not_found');
    if (cur.deleted_at) throw new ApiError(409, 'tag_in_trash');
    const sets: string[] = [];
    const vals: unknown[] = [];
    const after: Record<string, unknown> = {};
    if (input.name !== undefined) {
      const name = this.normName(input.name);
      const dup = this.s.db.prepare('SELECT id FROM tags WHERE name = ? AND id <> ?').get(name, id) as Row | undefined;
      if (dup) throw new ApiError(409, 'tag_exists', `tag #${name} exists`, { tag_id: dup.id });
      sets.push('name = ?');
      vals.push(name);
      after.name = name;
    }
    if ('owner_id' in input) {
      const owner = this.ownerOf(input.owner_id);
      sets.push('owner_id = ?');
      vals.push(owner);
      after.owner_id = owner;
    }
    if (input.archived !== undefined) {
      if (typeof input.archived !== 'boolean') throw new ApiError(400, 'bad_request', 'archived must be boolean');
      const at = input.archived ? (cur.archived_at ?? now()) : null;
      sets.push('archived_at = ?');
      vals.push(at);
      after.archived_at = at;
    }
    if (input.hidden !== undefined) {
      if (typeof input.hidden !== 'boolean') throw new ApiError(400, 'bad_request', 'hidden must be boolean');
      const at = input.hidden ? (cur.hidden_at ?? now()) : null;
      sets.push('hidden_at = ?');
      vals.push(at);
      after.hidden_at = at;
    }
    if (input.kind !== undefined) {
      if (input.kind !== 'topic' && input.kind !== 'meta') throw new ApiError(400, 'bad_tag_kind', "kind must be 'topic' or 'meta'");
      if (input.kind === 'meta' && cur.kind !== 'meta') {
        const pin = this.s.db.prepare('SELECT id FROM threads WHERE pinned_tag_id = ? LIMIT 1').get(id) as Row | undefined;
        if (pin) throw new ApiError(409, 'tag_pinned', 'a thread pins this tag — unpin it first', { thread_id: pin.id });
      }
      sets.push('kind = ?');
      vals.push(input.kind);
      after.kind = input.kind;
    }
    if (sets.length === 0) throw new ApiError(400, 'bad_request', 'nothing to update');
    const t = now();
    this.s.db.prepare(`UPDATE tags SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, t, id);
    const tag = this.get(id)!;
    const changed = Object.keys(after).some((k) => (cur as unknown as Record<string, unknown>)[k] !== after[k]);
    this.s.audit({
      actor: this.s.actorOf(pr),
      action: 'tag.update',
      target_type: 'tag',
      target_id: id,
      result: changed ? 'ok' : 'noop',
      reason: changed ? null : 'unchanged',
      before: { name: cur.name, owner_id: cur.owner_id, archived_at: cur.archived_at, hidden_at: cur.hidden_at, kind: cur.kind },
      after,
    });
    if (changed) this.s.emit({ notice: { t: 'tag', tag_id: id }, threadId: null });
    return tag;
  }

  private links(id: string): number {
    return (this.s.db.prepare('SELECT COUNT(*) AS n FROM message_tags WHERE tag_id = ?').get(id) as Row).n as number;
  }

  /** 휴지통으로(마스터만) — 인식이 멈추고(새 글의 #이름 은 글자) 글 연결은 지킨다. 이미 휴지통이면 noop */
  trash(pr: Principal, id: string): Tag {
    this.s.requireMaster(pr, 'tag.trash', { target_type: 'tag', target_id: id });
    const cur = this.get(id);
    if (!cur) throw new ApiError(404, 'not_found');
    if (!cur.deleted_at) this.s.db.prepare('UPDATE tags SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id);
    this.s.audit({ actor: this.s.actorOf(pr), action: 'tag.trash', target_type: 'tag', target_id: id, result: cur.deleted_at ? 'noop' : 'ok', reason: cur.deleted_at ? 'unchanged' : null, before: { name: cur.name, deleted_at: cur.deleted_at }, after: { links: this.links(id) } });
    if (!cur.deleted_at) this.s.emit({ notice: { t: 'tag', tag_id: id }, threadId: null });
    return this.get(id)!;
  }

  /** 휴지통에서 되살리기(마스터만) — 보관·숨김 상태는 버리기 전 그대로 */
  restore(pr: Principal, id: string): Tag {
    this.s.requireMaster(pr, 'tag.restore', { target_type: 'tag', target_id: id });
    const cur = this.get(id);
    if (!cur) throw new ApiError(404, 'not_found');
    if (cur.deleted_at) this.s.db.prepare('UPDATE tags SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now(), id);
    this.s.audit({ actor: this.s.actorOf(pr), action: 'tag.restore', target_type: 'tag', target_id: id, result: cur.deleted_at ? 'ok' : 'noop', reason: cur.deleted_at ? null : 'unchanged', before: { name: cur.name, deleted_at: cur.deleted_at } });
    if (cur.deleted_at) this.s.emit({ notice: { t: 'tag', tag_id: id }, threadId: null });
    return this.get(id)!;
  }

  /**
   * 영구 삭제(마스터만 · 휴지통 것만 — 아니면 409 not_in_trash) — 되돌릴 수 없다. 글 연결(message_tags)과 태그 행을 지우고,
   * 그 태그 차선의 쉬는 세션(도는 실행 없음)은 은퇴시킨다. 글 본문은 그대로 · 같은 이름을 새로 만들 수 있다.
   */
  purge(pr: Principal, id: string): { ok: true; name: string; links: number; sessions_retired: number } {
    this.s.requireMaster(pr, 'tag.purge', { target_type: 'tag', target_id: id });
    const cur = this.get(id);
    if (!cur) throw new ApiError(404, 'not_found');
    if (!cur.deleted_at) throw new ApiError(409, 'not_in_trash');
    const out = this.s.db.transaction(() => {
      const links = this.s.db.prepare('DELETE FROM message_tags WHERE tag_id = ?').run(id).changes;
      this.s.db.prepare('UPDATE threads SET pinned_tag_id = NULL WHERE pinned_tag_id = ?').run(id); // 고정(마이그레이션 22)도 푼다
      const t = now();
      const retired = this.s.db
        .prepare(
          `UPDATE agent_sessions SET status = 'retired', ended_at = ?, reason = 'tag_purged'
           WHERE lane = ? AND status = 'active' AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.session_id = agent_sessions.id AND r.state IN ('queued','running'))`,
        )
        .run(t, id).changes;
      this.s.db.prepare('DELETE FROM tags WHERE id = ?').run(id);
      return { links, retired };
    })();
    this.s.audit({ actor: this.s.actorOf(pr), action: 'tag.purge', target_type: 'tag', target_id: id, result: 'ok', before: { name: cur.name, created_at: cur.created_at, deleted_at: cur.deleted_at }, after: { links: out.links, sessions_retired: out.retired } });
    this.s.emit({ notice: { t: 'tag', tag_id: id }, threadId: null });
    return { ok: true, name: cur.name, links: out.links, sessions_retired: out.retired };
  }

  // ───────── 글에 붙은 태그 (message_tags) ─────────

  /** 이름 → id (살아 있는 태그만) */
  private aliveByName(): Map<string, string> {
    const m = new Map<string, string>();
    for (const r of this.s.db.prepare('SELECT id, name FROM tags WHERE archived_at IS NULL AND deleted_at IS NULL').all() as Row[]) m.set(r.name as string, r.id as string);
    return m;
  }

  /**
   * 글을 저장할 때 붙일 태그를 정한다(사양 2.1). `explicit` = 보기에서 자동으로 붙는 주 태그(id 또는 이름) ·
   * 본문의 태그 줄(사용자 head · 에이전트 tail)과 합쳐 주 태그(개수 제한 없음 · 순서 = 메인·서브·참조 · v0.34.0 마스터 #1674), 본문 속은 인라인.
   * `inherit` = 받은 글의 주 태그(에이전트 답 · 태그 줄이 없을 때). 보관 태그를 주 태그로 내밀면 400 tag_archived.
   * `_strict` 는 옛 «둘까지» 시절의 자리 — 호출자 호환으로만 남긴다.
   */
  resolve(body: string, where: 'head' | 'tail', explicit: unknown, inherit: string[] = [], _strict = true): { primary: string[]; inline: string[] } {
    const alive = this.aliveByName();
    const primary: string[] = [];
    if (explicit !== undefined && explicit !== null) {
      if (!Array.isArray(explicit) || explicit.some((x) => typeof x !== 'string')) throw new ApiError(400, 'bad_request', 'tags must be string[]');
      for (const x of explicit as string[]) {
        const id = alive.get(x.replace(/^#/, '')) ?? (alive.has(x) ? alive.get(x) : null) ?? ([...alive.values()].includes(x) ? x : null);
        if (!id) {
          const any = this.s.db.prepare('SELECT id, archived_at, deleted_at FROM tags WHERE id = ? OR name = ?').get(x, x.replace(/^#/, '')) as Row | undefined;
          if (any?.deleted_at) throw new ApiError(400, 'tag_in_trash');
          if (any?.archived_at) throw new ApiError(400, 'tag_archived', `tag ${x} is archived`);
          throw new ApiError(400, 'unknown_tag', `tag ${x} is not registered`);
        }
        if (!primary.includes(id)) primary.push(id);
      }
    }
    const parsed = parseTags(body, new Set(alive.keys()), where);
    for (const n of parsed.primary) {
      const id = alive.get(n)!;
      if (!primary.includes(id)) primary.push(id);
    }
    // 상속(에이전트 답 · 태그 줄 없을 때)은 주제 태그만(마스터 #1935) — 메타 태그는 그 글이 직접 준 것만
    if (primary.length === 0 && parsed.line === null) {
      const topics = this.topicIds();
      for (const id of inherit) if (!primary.includes(id) && topics.has(id)) primary.push(id);
    }
    const inline = parsed.inline.map((n) => alive.get(n)!).filter((id) => !primary.includes(id));
    return { primary, inline };
  }

  /** 주제 태그 id 집합(휴지통 뺌 — 보관·숨김은 호출자가 거른다) */
  private topicIds(): Set<string> {
    return new Set((this.s.db.prepare("SELECT id FROM tags WHERE kind = 'topic' AND deleted_at IS NULL").all() as Row[]).map((r) => r.id as string));
  }

  /**
   * 스레드 고정 태그(마이그레이션 22 · 마스터 #1937) — 살아 있는 주제 태그일 때만 id(보관·휴지통이 되거나 메타로 바뀌면 강제가 멈춘다).
   * 메인 채팅방은 고정이 없다.
   */
  pinnedOf(threadId: string): string | null {
    const r = this.s.db
      .prepare(
        `SELECT t.id FROM threads th JOIN tags t ON t.id = th.pinned_tag_id
         WHERE th.id = ? AND th.kind <> 'room' AND t.kind = 'topic' AND t.archived_at IS NULL AND t.deleted_at IS NULL`,
      )
      .get(threadId) as Row | undefined;
    return (r?.id as string) ?? null;
  }

  /** 고정할 수 있는 태그인가 — 없으면 400 unknown_tag · 메타 400 tag_meta · 보관 400 tag_archived · 휴지통 400 tag_in_trash */
  pinnable(v: unknown): string {
    if (typeof v !== 'string' || !v) throw new ApiError(400, 'bad_request', 'tag_id must be a tag id or null');
    const r = this.s.db.prepare('SELECT id, kind, archived_at, deleted_at FROM tags WHERE id = ? OR name = ?').get(v, v.replace(/^#/, '')) as Row | undefined;
    if (!r) throw new ApiError(400, 'unknown_tag', `tag ${v} is not registered`);
    if (r.deleted_at) throw new ApiError(400, 'tag_in_trash');
    if (r.archived_at) throw new ApiError(400, 'tag_archived', `tag ${v} is archived`);
    if (r.kind !== 'topic') throw new ApiError(400, 'tag_meta', 'only a topic tag can be pinned');
    return r.id as string;
  }

  /**
   * 트랜잭션 안에서 — 글에 태그 줄을 쓴다. 글 저장 경로가 모두 여기를 지난다(사람·에이전트·MCP·요청 · 대면·합침 포함).
   * 주 태그 순서(마스터 #1933·#1937): [스레드 고정 태그] → 주제 태그(준 순서) → 메타 태그(준 순서) — 메타는 첫 자리가 될 수 없다.
   * 고정 태그는 글이 안 줬어도 첫 자리에 넣고, 인라인에 있었으면 거기서 뺀다.
   */
  attach(seq: number, t: { primary: string[]; inline: string[] }): void {
    const th = this.s.db.prepare('SELECT thread_id FROM messages WHERE seq = ?').get(seq) as Row | undefined;
    const pin = th ? this.pinnedOf(th.thread_id as string) : null;
    const topics = this.topicIds();
    const given = pin ? [pin, ...t.primary.filter((id) => id !== pin)] : t.primary;
    const primary = [...given.filter((id) => topics.has(id)), ...given.filter((id) => !topics.has(id))];
    const ins = this.s.db.prepare('INSERT OR IGNORE INTO message_tags(message_seq, tag_id, role) VALUES (?,?,?)');
    for (const id of primary) ins.run(seq, id, 'primary');
    for (const id of t.inline) if (!primary.includes(id)) ins.run(seq, id, 'inline');
  }

  /**
   * 답장 상속(마스터 #1935 — #1795 «원문 태그를 전부 따라간다»를 바꿈):
   * 원문에서 이어받는 것은 **주제 태그만**(보관·휴지통·숨김 뺌 · 원문 순서). 이 글이 주제 태그를 직접 줬으면(보기 태그·첫 줄 태그 줄)
   * 그것이 원문 주제 태그를 **대신한다**(쌓지 않음). 메타 태그는 이 글이 직접 준 것만. 주 태그가 된 것은 인라인에서 뺀다.
   */
  inheritReply(t: { primary: string[]; inline: string[] }, replyTo: number): { primary: string[]; inline: string[] } {
    const topics = this.topicIds();
    const givenTopics = t.primary.filter((id) => topics.has(id));
    const metas = t.primary.filter((id) => !topics.has(id));
    let lead = givenTopics;
    if (!givenTopics.length) {
      const hidden = new Set((this.s.db.prepare('SELECT id FROM tags WHERE hidden_at IS NOT NULL').all() as Row[]).map((r) => r.id as string));
      const alive = new Set([...this.aliveByName().values()].filter((id) => !hidden.has(id) && topics.has(id)));
      lead = this.primaryOf(replyTo).filter((id) => alive.has(id));
    }
    const primary = [...lead, ...metas.filter((id) => !lead.includes(id))];
    return { primary, inline: t.inline.filter((id) => !primary.includes(id)) };
  }

  /** 글의 주 태그 id(상속용) */
  primaryOf(seq: number): string[] {
    return (this.s.db.prepare("SELECT tag_id FROM message_tags WHERE message_seq = ? AND role = 'primary' ORDER BY rowid").all(seq) as Row[]).map((r) => r.tag_id as string);
  }

  tagsFor(seqs: number[]): Map<number, MessageTags> {
    const map = new Map<number, MessageTags>();
    if (seqs.length === 0) return map;
    const rows = this.s.db
      // 휴지통 태그는 글 칩에서 뺀다(연결은 지킴 · 되살리면 다시 보임)
      .prepare(`SELECT mt.message_seq, mt.role, t.id, t.name, t.kind FROM message_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.message_seq IN (${seqs.map(() => '?').join(',')}) AND t.deleted_at IS NULL ORDER BY mt.rowid`)
      .all(...seqs) as Row[];
    for (const r of rows) {
      const cur = map.get(r.message_seq as number) ?? { primary: [], inline: [] };
      (r.role === 'primary' ? cur.primary : cur.inline).push({ id: r.id as string, name: r.name as string, kind: r.kind === 'meta' ? 'meta' : 'topic' });
      map.set(r.message_seq as number, cur);
    }
    // 주제 태그가 언제나 메타 태그보다 앞(마스터 #1933) — 이 판 전에 저장된 글도 보이는 순서는 맞춘다(안정 정렬)
    for (const v of map.values()) v.primary.sort((a, b) => (a.kind === 'meta' ? 1 : 0) - (b.kind === 'meta' ? 1 : 0));
    return map;
  }

  /**
   * 태그 보기(사양 2.2): 이 태그가 주 태그이거나 인라인으로 든 글 — 읽을 수 있는 스레드의 것만 · seq 순 · 커서.
   * 보관한 태그도 읽기는 된다(D9). 없는 태그는 404.
   */
  view(pr: Principal, tagId: string, after = 0, limit = 200): { tag: Tag; messages: Message[]; next_cursor: number; has_more: boolean } {
    const tag = this.get(tagId);
    if (!tag) throw new ApiError(404, 'not_found');
    if (tag.deleted_at) throw new ApiError(404, 'tag_in_trash');
    const lim = Math.min(Math.max(1, limit), 500);
    const me = pr.participant;
    const rows = (
      me.is_master
        ? this.s.db.prepare(
            `SELECT m.* FROM message_tags mt JOIN messages m ON m.seq = mt.message_seq JOIN threads th ON th.id = m.thread_id
             WHERE mt.tag_id = ? AND m.seq > ? AND th.deleted_at IS NULL ORDER BY m.seq LIMIT ?`,
          ).all(tagId, after, lim + 1)
        : this.s.db.prepare(
            `SELECT m.* FROM message_tags mt JOIN messages m ON m.seq = mt.message_seq JOIN threads th ON th.id = m.thread_id
             JOIN thread_members tm ON tm.thread_id = m.thread_id AND tm.participant_id = ? AND tm.can_read = 1
             WHERE mt.tag_id = ? AND m.seq > ? AND th.deleted_at IS NULL ORDER BY m.seq LIMIT ?`,
          ).all(me.id, tagId, after, lim + 1)
    ) as Row[];
    const has_more = rows.length > lim;
    const messages = this.s.withAttachments(rows.slice(0, lim).map(toMessage));
    return { tag, messages, next_cursor: messages.length ? messages[messages.length - 1].seq : after, has_more };
  }
}
