// 요청 모듈(requests · 마이그레이션 14 · 마스터 #352) — docs/MODULES.md 4단계(마스터 #1213)에 store.ts 에서 옮겼다.
// 켜졌을 때만 Store.requests 에 붙는다. 꺼지면 «요청→»·«보류:»는 끝줄 신호가 아니라 그냥 글이고, 경로는 404 · 표·행은 그대로 남는다.
import { newId } from '../../crypto.js';
import { t as tr, protocolWords } from '../../i18n.js';
import type { RequestHold, RequestPair } from '../../protocol.js';
import { ApiError, now, signalTail, type AuditActor, type Principal, type Row, type Store } from '../../store.js';

/**
 * 요청 신호(2026-10-16 마스터 #352): 답의 마지막 비어 있지 않은 줄이 `요청→ 이름`(또는 `요청 -> 이름` · 굵게 등 꾸밈 허용)이면
 * 그 이름을 후보(이 스레드의 다른 에이전트)에서 찾는다. 받는 이는 한 명 — 둘 이상 적었으면 찾은 것들은 넘김 버튼으로만 떨어진다(to = null).
 * 줄을 떼는 규칙은 parseHandoff 와 같다 — 못 찾으면 줄을 두고, 신호만 있는 답도 줄을 둔다. 허용 짝인지는 부르는 쪽(completeRun)이 본다.
 */
export function parseRequest(
  body: string,
  candidates: { id: string; name: string }[],
): { body: string; to: string | null; matched: string[]; raw: string | null } {
  const { lines, i } = signalTail(body);
  if (i < 0) return { body, to: null, matched: [], raw: null };
  const m = new RegExp(`^\\s*[*_\`]*\\s*(?:${protocolWords('proto.request')})\\s*(?:→|->)\\s*(.+?)\\s*[*_\`]*\\s*$`, 'i').exec(lines[i]);
  if (!m) return { body, to: null, matched: [], raw: null };
  const want = m[1].split(/\s*[,，、]\s*/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const ids: string[] = [];
  for (const w of want) {
    const c = candidates.find((x) => x.id.toLowerCase() === w || x.name.trim().toLowerCase() === w);
    if (c && !ids.includes(c.id)) ids.push(c.id);
  }
  const raw = lines[i].trim();
  const rest = lines.slice(0, i).join('\n').trim();
  if (!ids.length || !rest) return { body, to: null, matched: [], raw };
  return { body: rest, to: want.length === 1 && ids.length === 1 ? ids[0] : null, matched: ids, raw };
}

/**
 * 보류 신호(마스터 #352 «예외 처리»): 요청을 받은 실행의 답 마지막 비어 있지 않은 줄이 `보류: 사유`(또는 `보류 — 사유`)면 보류다.
 * 사유가 비면 보류가 아니다(그냥 답). note = 그 줄 위의 설명(없으면 null). 요청이 아닌 실행에서는 부르지 않는다
 */
export function parseHold(body: string): { reason: string; note: string | null } | null {
  const { lines, i } = signalTail(body);
  if (i < 0) return null;
  const m = new RegExp(`^\\s*[*_\`]*\\s*(?:${protocolWords('proto.hold')})\\s*(?:[:：]|—)\\s*(.+?)\\s*[*_\`]*\\s*$`, 'i').exec(lines[i]);
  if (!m || !m[1].trim()) return null;
  const note = lines.slice(0, i).join('\n').trim();
  return { reason: m[1].trim().slice(0, 500), note: note ? note.slice(0, 4000) : null };
}

export function toHold(r: Row): RequestHold {
  return {
    id: r.id,
    thread_id: r.thread_id,
    request_seq: r.request_seq ?? null,
    requester_id: r.requester_id,
    recipient_id: r.recipient_id,
    kind: r.kind,
    reason: r.reason,
    note: r.note ?? null,
    run_id: r.run_id ?? null,
    created_at: r.created_at,
    acked_at: r.acked_at ?? null,
    acked_by: r.acked_by ?? null,
    notified_run_id: r.notified_run_id ?? null,
  };
}

export class RequestStore {
  constructor(readonly s: Store) {}

  /**
   * 보류로 끝내기: 실행은 succeeded(어댑터는 할 일을 다 했다) · 답 글 없음 · 요청 글까지 본 것으로(seen_upto) · request_holds 한 줄 · 감사 request.hold.
   * 요청한 쪽에게 배달을 만들지 않는다 — 깨우지 않는다. 마스터는 스레드 머리 «보류된 요청 N»과 보조 패널에서 본다
   */
  completeHeld(pr: Principal, r: Row, trig: Row, hold: { reason: string; note: string | null }, input: { usage?: unknown; runtime?: unknown; model?: unknown }) {
    const t = now();
    const usage = input.usage === undefined ? null : JSON.stringify(input.usage).slice(0, 4000);
    const duringCancel = r.cancel_requested_at != null;
    const h = this.s.db.transaction(() => {
      this.s.db
        .prepare("UPDATE runs SET state = 'succeeded', ended_at = ?, finalized_at = ?, usage = ?, result_seq = NULL, seen_upto = ?, lease_expires_at = NULL WHERE id = ?")
        .run(t, t, usage, r.trigger_seq, r.id);
      const h = this.recordHold({
        thread_id: r.thread_id, request_seq: r.trigger_seq, requester_id: trig.author_id, recipient_id: pr.participant.id,
        kind: 'held', reason: hold.reason, note: hold.note, run_id: r.id,
      });
      this.s.ev(r.id, 'completed', pr.participant.id, { result_seq: null, held: h.id, during_cancel: duringCancel }, t);
      this.s.ev(r.id, 'request_held', 'server', { hold_id: h.id, requester: trig.author_id }, t);
      this.s.ev(r.id, 'finalized', 'server', duringCancel ? { state: 'succeeded', completed_first: true } : { state: 'succeeded' }, t);
      if (duringCancel) this.s.auditCancelFinal(r, 'succeeded', 'completed_first', t, pr.participant.id);
      this.s.audit({
        actor: this.s.actorOf(pr),
        action: 'request.hold',
        target_type: 'message',
        target_id: String(r.trigger_seq),
        thread_id: r.thread_id,
        result: 'ok',
        after: { hold_id: h.id, requester: trig.author_id, recipient: pr.participant.id, run_id: r.id },
      });
      const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.slice(0, 200) : null);
      this.s.db
        .prepare('UPDATE agent_sessions SET runtime = COALESCE(?, runtime), actual_model = COALESCE(?, actual_model) WHERE id = ?')
        .run(str(input.runtime), str(input.model), r.session_id);
      return h;
    })();
    this.s.emit({ notice: { t: 'run', thread_id: r.thread_id, run_id: r.id, state: 'succeeded' }, threadId: r.thread_id });
    return { run: this.s.toRunOut(this.s.runRow(r.id)!), message: null, held: h, duplicate: false };
  }

  // ───────────────────────── 요청 창구 (마스터 #352 · 마이그레이션 14) ─────────────────────────

  /**
   * 요청 연쇄 깊이 = 이 스레드의 마지막 마스터 글 뒤에 쌓인 요청 글 수. 마스터가 그 스레드에 글을 쓰면 0 부터 다시 센다.
   * 트리거 사슬(hop)이 아니라 스레드 단위로 센다 — 마스터가 끼어들면 도는 왕복도 새로 시작하고, 갈래가 여럿이어도 상한은 하나다
   */
  requestChainDepth(threadId: string): number {
    return (
      this.s.db
        .prepare(
          `SELECT COUNT(*) AS n FROM messages WHERE thread_id = ? AND source_kind = 'request' AND seq > COALESCE(
             (SELECT MAX(m.seq) FROM messages m JOIN participants p ON p.id = m.author_id WHERE m.thread_id = ? AND p.is_master = 1), 0)`,
        )
        .get(threadId, threadId) as Row
    ).n as number;
  }

  /** 요청을 낼 수 없는 까닭(없으면 null). 순서: 허용 짝 → 받는 이가 읽을 수 있나 → 새 호출 금지 → 연쇄 상한 */
  requestBlock(thread: Row, from: string, to: string): 'request_pair_not_allowed' | 'bad_recipient' | 'invoke_paused' | 'request_chain_limit' | null {
    if (!this.s.db.prepare('SELECT 1 FROM request_pairs WHERE from_id = ? AND to_id = ?').get(from, to)) return 'request_pair_not_allowed';
    if (!this.s.membership(thread.id, to)?.can_read) return 'bad_recipient';
    if (thread.invoke_paused) return 'invoke_paused';
    if (this.requestChainDepth(thread.id) >= this.s.cfg.requestChainMax) return 'request_chain_limit';
    return null;
  }

  /** 마스터가 봐야 할 요청 한 건을 남기고 스레드 알림(머리의 «보류된 요청 N»). 트랜잭션 안에서 불러도 된다 */
  recordHold(h: Omit<RequestHold, 'id' | 'created_at' | 'acked_at' | 'acked_by' | 'notified_run_id'>): RequestHold {
    const id = newId('rqh');
    const t = now();
    this.s.db
      .prepare(
        'INSERT INTO request_holds(id, thread_id, request_seq, requester_id, recipient_id, kind, reason, note, run_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .run(id, h.thread_id, h.request_seq, h.requester_id, h.recipient_id, h.kind, h.reason, h.note, h.run_id, t);
    this.s.emit({ notice: { t: 'thread', thread_id: h.thread_id }, threadId: h.thread_id });
    return toHold(this.s.db.prepare('SELECT * FROM request_holds WHERE id = ?').get(id) as Row);
  }

  /** 요청 만들기의 감사 한 줄(request.create) — 본문은 싣지 않는다. 거부는 묶음 */
  auditRequest(pr: Principal, threadId: string, seq: number | null, to: string, result: 'ok' | 'denied', reason: string | null, deliveryId: string | null) {
    this.s.audit({
      actor: this.s.actorOf(pr),
      action: 'request.create',
      target_type: 'message',
      target_id: seq === null ? null : String(seq),
      thread_id: threadId,
      result,
      reason,
      after: { from: pr.participant.id, to, delivery_id: deliveryId, depth: this.requestChainDepth(threadId) },
      group: result !== 'ok',
    });
  }

  /** 스레드의 보류된 요청(마스터만 · 확인 안 한 것 먼저 · 최근 100건) */
  listRequestHolds(pr: Principal, threadId: string): RequestHold[] {
    this.s.requireMaster(pr, 'request.holds_view', { target_type: 'thread', target_id: threadId, thread_id: threadId });
    this.s.requireThread(threadId);
    return (
      this.s.db
        .prepare('SELECT * FROM request_holds WHERE thread_id = ? ORDER BY acked_at IS NOT NULL, created_at DESC LIMIT 100')
        .all(threadId) as Row[]
    ).map(toHold);
  }

  /** 마스터의 «확인함» — 머리 경고에서 빠진다. 두 번째는 noop */
  ackRequestHold(pr: Principal, holdId: string): { ok: true; outcome: 'acked' | 'already_acked'; hold: RequestHold } {
    this.s.requireMaster(pr, 'request.hold_ack', { target_type: 'request_hold', target_id: holdId });
    const r = this.s.db.prepare('SELECT * FROM request_holds WHERE id = ?').get(holdId) as Row | undefined;
    if (!r) throw new ApiError(404, 'no_hold');
    const t = now();
    const outcome = r.acked_at ? 'already_acked' : 'acked';
    this.s.db.transaction(() => {
      if (!r.acked_at) this.s.db.prepare('UPDATE request_holds SET acked_at = ?, acked_by = ? WHERE id = ? AND acked_at IS NULL').run(t, pr.participant.id, holdId);
      this.s.audit({
        actor: this.s.actorOf(pr),
        action: 'request.hold_ack',
        target_type: 'request_hold',
        target_id: holdId,
        thread_id: r.thread_id,
        result: r.acked_at ? 'noop' : 'ok',
        reason: r.acked_at ? 'already_acked' : null,
        before: { kind: r.kind, request_seq: r.request_seq, requester: r.requester_id, recipient: r.recipient_id, acked_at: r.acked_at ?? null },
      });
    })();
    if (!r.acked_at) this.s.emit({ notice: { t: 'thread', thread_id: r.thread_id }, threadId: r.thread_id });
    return { ok: true, outcome, hold: toHold(this.s.db.prepare('SELECT * FROM request_holds WHERE id = ?').get(holdId) as Row) };
  }

  /** 허용 짝 목록(방향 있음) */
  listRequestPairs(): RequestPair[] {
    return this.s.db.prepare('SELECT from_id, to_id, created_at, created_by FROM request_pairs ORDER BY from_id, to_id').all() as RequestPair[];
  }

  /** 허용 짝 더하기·빼기 — 마스터만(CLI 는 cli:root 로 남는다). 참여자가 아직 없어도 된다(id 는 안정 키) */
  setRequestPair(pr: Principal, from: unknown, to: unknown, on: boolean): { ok: true; changed: boolean; pairs: RequestPair[] } {
    const action = on ? 'request_pair.add' : 'request_pair.remove';
    this.s.requireMaster(pr, action, { target_type: 'request_pair', target_id: `${String(from)}>${String(to)}` });
    const idOk = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9_-]{1,64}$/.test(v);
    // from === to(자기 짝)도 받는다 — 세션 밖 긴 일(bs-job)이 끝나면 자기에게 «요청»을 내 다시 불리는 길(2026-10-22 #820 뒤 마스터 결정 · 연쇄 상한 그대로)
    if (!idOk(from) || !idOk(to)) throw new ApiError(400, 'bad_pair', 'from·to 는 참여자 id', undefined, { key: 'err.bad_pair' });
    const target = `${from}>${to}`;
    const changed = this.s.db.transaction(() => {
      const n = on
        ? this.s.db.prepare('INSERT OR IGNORE INTO request_pairs(from_id, to_id, created_at, created_by) VALUES (?,?,?,?)').run(from, to, now(), this.s.actorOf(pr).id).changes
        : this.s.db.prepare('DELETE FROM request_pairs WHERE from_id = ? AND to_id = ?').run(from, to).changes;
      this.s.audit({
        actor: this.s.actorOf(pr),
        action,
        target_type: 'request_pair',
        target_id: target,
        result: n ? 'ok' : 'noop',
        reason: n ? null : on ? 'already_allowed' : 'not_allowed',
        after: { from, to, allowed: on },
      });
      return n > 0;
    })();
    return { ok: true, changed, pairs: this.listRequestPairs() };
  }

}
