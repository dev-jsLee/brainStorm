// 합치기 모듈(merge · 마이그레이션 17 · 마스터 #706·#962) — docs/MODULES.md 5단계(마스터 #1213)에 store.ts 에서 옮겼다.
// 켜졌을 때만 Store.merge 에 붙는다. 꺼지면 합치기 경로는 404 · 단추 없음 · 지난 묶음 글은 한 줄 글로 보인다(표·행은 그대로).
import { newId } from '../../crypto.js';
import { t as tr } from '../../i18n.js';
import type { MergeInfo, Message, Thread } from '../../protocol.js';
import { ApiError, now, toMessage, type Principal, type Row, type Store } from '../../store.js';

const MERGE_KIND = new Set(['instruction', 'quote', 'observation', 'proposal', 'request']);
const MERGE_MAX_CHARS = 120_000;

export class MergeStore {
  constructor(readonly s: Store) {}

  /** 합침 묶음 글(마이그레이션 17)의 출처 — 묶음이 아닌 글은 안 든다 */
  mergesFor(seqs: number[]): Map<number, MergeInfo> {
    const map = new Map<number, MergeInfo>();
    if (seqs.length === 0) return map;
    const rows = this.s.db
      .prepare(
        `SELECT g.*, t.title AS child_title FROM thread_merges g LEFT JOIN threads t ON t.id = g.child_thread_id
         WHERE g.message_seq IN (${seqs.map(() => '?').join(',')})`,
      )
      .all(...seqs) as Row[];
    for (const r of rows)
      map.set(r.message_seq, { child_thread_id: r.child_thread_id, child_title: r.child_title ?? tr(this.s.lang(), 'srv.deleted_thread'), from_seq: r.from_seq, to_seq: r.to_seq, count: r.count });
    return map;
  }

  /** 합침 묶음 글 → 에이전트에게 실을 본문: 머리 + 옮긴 글 전문(그 스레드에서의 작성자·출처와 함께). 너무 길면 앞 글부터 덜어 낸다 */
  mergeTranscript(m: Message): string {
    const g = m.merge!;
    const rows = this.s.db
      .prepare(
        `SELECT m.seq, m.body, m.source_kind, p.name, p.is_master FROM messages m JOIN participants p ON p.id = m.author_id
         WHERE m.thread_id = ? AND m.seq BETWEEN ? AND ? ORDER BY m.seq`,
      )
      .all(g.child_thread_id, g.from_seq, g.to_seq) as Row[];
    const lang = this.s.lang();
    const parts = rows.map((r) => `#${r.seq} ${r.name}${r.is_master ? tr(lang, 'srv.merge.master_mark') : ''} · ${MERGE_KIND.has(r.source_kind as string) ? tr(lang, `srv.merge.kind.${r.source_kind}`) : r.source_kind}\n${r.body}`);
    let total = parts.reduce((n, x) => n + x.length + 2, 0);
    let dropped = 0;
    while (parts.length > 1 && total > MERGE_MAX_CHARS) {
      total -= parts.shift()!.length + 2;
      dropped++;
    }
    const t = g.child_title;
    return [
      m.body,
      '',
      tr(lang, 'srv.merge.intro', { title: t }),
      '',
      tr(lang, 'srv.merge.start', { title: t }),
      ...(dropped ? [tr(lang, 'srv.merge.dropped', { n: dropped }), ''] : []),
      parts.join('\n\n'),
      tr(lang, 'srv.merge.end', { title: t }),
    ].join('\n');
  }

  /** 하위 스레드의 아직 안 합친 제 글(마지막 합침 뒤) */
  unmergedOf(childId: string): { last: number; rows: Row[] } {
    const last = ((this.s.db.prepare('SELECT MAX(to_seq) AS s FROM thread_merges WHERE child_thread_id = ?').get(childId) as Row).s as number | null) ?? 0;
    const rows = this.s.db.prepare('SELECT seq FROM messages WHERE thread_id = ? AND seq > ? ORDER BY seq').all(childId, last) as Row[];
    return { last, rows };
  }

  /**
   * 하위 스레드 합치기(2026-10-21 마스터 #706 · 마스터만): 하위 스레드의 제 글(분기 때 가져온 맥락 빼고 · 지난 합침 뒤)을
   * 바로 위 대화(스레드 또는 메인 채팅방)에 묶음 글 하나로 옮긴다. 묶음 글은 마스터 이름의 보통 글(출처 «인용» · 받는 이 없음 — 아무도 안 부른다)이라
   * 이어서 쓰는 다음 글의 맥락에 실리고, 에이전트에게는 옮긴 글 전문으로 펼쳐진다(mergeTranscript).
   * 합친 뒤 상위만 남는다(2026-10-27 마스터 #962): 하위 스레드는 보관(읽기 전용)·숨김이 되고 대기 중 전달은 거둔다 — 묶음 상자의 [스레드 열기]·«숨김» 필터로는 그대로 열리고
   * 보관 해제·숨김 해제로 되돌린다. 그 아래 분기는 상위 대화로 올려 붙여(parent_thread_id) 목록에 남긴다. 실행 중이면 409 runs_active.
   */
  mergeThread(pr: Principal, childId: string): { message: Message; parent: { id: string; title: string; kind: Thread['kind'] }; duplicate: boolean } {
    this.s.requireMaster(pr, 'thread.merge', { target_type: 'thread', target_id: childId, thread_id: childId });
    const child = this.s.requireRead(pr, childId);
    if (child.kind === 'room' || !child.parent_thread_id) throw new ApiError(409, 'no_parent', '합칠 상위 대화가 없다(메인 채팅방·부모 없는 스레드)', undefined, { key: 'err.no_parent' });
    if (child.deleted_at) throw new ApiError(409, 'thread_deleted');
    const parent = this.s.requireThread(child.parent_thread_id as string);
    if (parent.deleted_at) throw new ApiError(409, 'parent_deleted', '상위 대화가 휴지통에 있다', undefined, { key: 'err.parent_deleted' });
    if (parent.status !== 'open') throw new ApiError(409, 'parent_closed', '상위 대화가 보관돼 있다', undefined, { key: 'err.parent_closed' });
    const active = this.s.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE thread_id = ? AND state IN ('queued','running')").get(childId) as Row;
    if ((active.n as number) > 0)
      throw new ApiError(409, 'runs_active', `실행 중인 run ${active.n}개 — 먼저 멈춘다`, undefined, { key: 'err.runs_active', vars: { n: active.n } });
    const me = pr.participant.id;
    const t = now();
    let kids: string[] = [];
    const res = this.s.db.transaction(() => {
      const { last, rows } = this.unmergedOf(childId);
      if (!rows.length) throw new ApiError(409, 'nothing_to_merge', last ? '지난 합침 뒤 새 글이 없다' : '하위 스레드에 글이 없다', undefined, { key: last ? 'err.nothing_to_merge.since_last' : 'err.nothing_to_merge.empty' });
      const from = rows[0].seq as number;
      const to = rows[rows.length - 1].seq as number;
      const lang = this.s.lang();
      const body = tr(lang, 'srv.merge.body', { title: child.title, n: rows.length, from, to, since: last ? tr(lang, 'srv.merge.since_last') : '' });
      const info = this.s.db
        .prepare(
          `INSERT INTO messages(id, thread_id, author_id, client_key, body, source_kind, input_mode, recipients, hop, created_at)
           VALUES (?,?,?,?,?, 'quote', 'text', '[]', 0, ?)`,
        )
        .run(newId('msg'), parent.id, me, `merge:${childId}:${to}`, body, t);
      const seq = Number(info.lastInsertRowid);
      this.s.db
        .prepare('INSERT INTO thread_merges(message_seq, child_thread_id, parent_thread_id, from_seq, to_seq, count, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(seq, childId, parent.id, from, to, rows.length, me, t);
      this.s.db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(t, parent.id);
      // 상위만 남긴다(#962): 아래 분기는 상위로 올려 붙이고, 하위 스레드는 보관 + 숨김 · 대기 중 전달은 거둔다
      kids = (this.s.db.prepare('SELECT id FROM threads WHERE parent_thread_id = ?').all(childId) as Row[]).map((r) => r.id as string);
      this.s.db.prepare('UPDATE threads SET parent_thread_id = ? WHERE parent_thread_id = ?').run(parent.id, childId);
      this.s.db.prepare("UPDATE threads SET status = 'archived', hidden = 1, updated_at = ? WHERE id = ?").run(t, childId);
      const withdrawn = this.s.db
        .prepare(`UPDATE deliveries SET status = 'cancelled', last_error = 'merged', lease_token_hash = NULL, updated_at = ? WHERE thread_id = ? AND status IN ('pending','leased')`)
        .run(t, childId).changes;
      this.s.audit({
        actor: this.s.actorOf(pr),
        action: 'thread.merge',
        target_type: 'thread',
        target_id: childId,
        thread_id: parent.id as string,
        result: 'ok',
        after: { parent_thread_id: parent.id, message_seq: seq, from_seq: from, to_seq: to, count: rows.length, again: !!last, child: 'archived+hidden', reparented: kids, withdrawn_deliveries: withdrawn },
      });
      return seq;
    })();
    this.s.emit({ notice: { t: 'msg', thread_id: parent.id as string, seq: res }, threadId: parent.id as string });
    this.s.emit({ notice: { t: 'thread', thread_id: childId }, threadId: childId });
    for (const id of kids) this.s.emit({ notice: { t: 'thread', thread_id: id }, threadId: id });
    const [message] = this.s.withAttachments([toMessage(this.s.db.prepare('SELECT * FROM messages WHERE seq = ?').get(res) as Row)]);
    return { message, parent: { id: parent.id as string, title: parent.title as string, kind: parent.kind === 'room' ? 'room' : 'thread' }, duplicate: false };
  }

}
