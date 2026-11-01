// 위임 대장 모듈(delegations · 마이그레이션 12) — docs/MODULES.md 3단계(마스터 #1213)에 store.ts 에서 옮겼다.
// 켜졌을 때만 Store.delegations 에 붙는다. 꺼지면 /api/delegations* 는 404 · 표·행은 그대로 남는다.
import { newId } from '../../crypto.js';
import {
  CLAIM_KINDS,
  DELEGATION_CLOSED,
  DELEGATION_STATUSES,
  VERSION_SLOTS,
  type ClaimConflict,
  type ClaimInput,
  type ClaimKind,
  type Delegation,
  type DelegationClaim,
  type DelegationStatus,
  type VersionSlot,
} from '../../protocol.js';
import { ApiError, now, optInt, reqString, type Principal, type Row, type Store } from '../../store.js';

export interface DelegationInput {
  thread_id?: unknown;
  source_seq?: unknown;
  assignee?: unknown;
  title?: unknown;
  spec?: unknown;
  version_slot?: unknown;
  claims?: unknown;
  /** true 면 겹칠 때 409 대신 대기(queued · 선점 전부 granted=0)로 만든다 — 마이그레이션 13 */
  queue?: unknown;
  /** 서버가 인증으로 정한다 — 다른 값을 내밀면 403 impersonation */
  created_by?: unknown;
}

const MAX_CLAIMS = 50;

/**
 * 선점 한 줄 다듬기(위임 대장). path: '//' 접기 · 앞 '/'·'./' 와 가운데 '.' 마디 걷기 · '..' 이나 빈 값은 400
 * (저장소 전체는 '' 가 아니라 '*') · 끝 '/'(폴더)는 지킨다. resource: 앞뒤 공백만 걷고 그대로 비교한다.
 */
export function normalizeClaim(v: unknown): ClaimInput {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ApiError(400, 'bad_claim', 'claim must be {kind, repo, scope}');
  const c = v as Record<string, unknown>;
  if (!CLAIM_KINDS.includes(c.kind as ClaimKind)) throw new ApiError(400, 'bad_claim', `kind: ${CLAIM_KINDS.join(' | ')}`);
  const kind = c.kind as ClaimKind;
  const repo = typeof c.repo === 'string' ? c.repo.trim() : '';
  if (!repo || repo.length > 64) throw new ApiError(400, 'bad_claim', 'repo required (≤64 chars)');
  let scope = typeof c.scope === 'string' ? c.scope.trim() : '';
  if (scope.length > 512) throw new ApiError(400, 'bad_scope', 'scope exceeds 512 chars');
  if (kind === 'path' && scope !== '*') {
    const segs = scope.split('/');
    if (segs.includes('..')) throw new ApiError(400, 'bad_scope', "'..' is not allowed");
    const kept = segs.filter((x) => x !== '' && x !== '.');
    scope = kept.length ? kept.join('/') + (scope.endsWith('/') ? '/' : '') : '';
  }
  if (!scope) throw new ApiError(400, 'bad_scope', kind === 'path' ? "empty scope — use '*' for the whole repo" : 'scope required');
  return { kind, repo, scope };
}

/** 두 선점이 겹치나. path = 같은 저장소 + 한쪽이 다른 쪽의 접두('*' 는 저장소 전체) · resource = (repo, scope) 정확히 같음 */
export function claimsOverlap(a: ClaimInput, b: ClaimInput): boolean {
  if (a.kind !== b.kind || a.repo !== b.repo) return false;
  if (a.kind === 'resource') return a.scope === b.scope;
  return a.scope === '*' || b.scope === '*' || a.scope.startsWith(b.scope) || b.scope.startsWith(a.scope);
}

function toClaim(r: Row): DelegationClaim {
  return {
    id: r.id,
    delegation_id: r.delegation_id,
    kind: r.kind,
    repo: r.repo,
    scope: r.scope,
    origin: r.origin,
    claimed_at: r.claimed_at,
    released_at: r.released_at ?? null,
    granted: r.granted !== 0,
  };
}

function toDelegation(r: Row, claims: DelegationClaim[]): Delegation {
  return {
    id: r.id,
    thread_id: r.thread_id ?? null,
    source_seq: r.source_seq ?? null,
    assignee: r.assignee,
    title: r.title,
    spec: r.spec,
    version_slot: r.version_slot ?? null,
    status: r.status,
    created_by: r.created_by,
    created_at: r.created_at,
    updated_at: r.updated_at,
    finished_at: r.finished_at ?? null,
    result: r.result ?? null,
    last_seen_at: r.last_seen_at ?? null,
    waiting: !DELEGATION_CLOSED.includes(r.status) && claims.some((c) => !c.granted && c.released_at === null),
    claims,
  };
}

/** 전달 메모(#740) — 길이 상한 · 받는 쪽에 싣는 머리(글 안의 같은 문자열은 무디게) */
export class DelegationStore {
  constructor(readonly s: Store) {}

  // ───────────────────────── 위임 대장 (마이그레이션 12 · 마스터 #339·#341) ─────────────────────────

  /**
   * 위임 대장 권한 — 여기 한곳뿐이다.
   *   view    : 인증된 참여자 누구나(마스터 쿠키 · 에이전트 토큰)
   *   create  : 마스터 또는 에이전트
   *   update  : 선점 추가 · 상태 · heartbeat — 만든 이 · 마스터 · 아무 에이전트(백수 세션 여럿이 한 에이전트 자격 증명 아래 돈다)
   *   release : 강제 놓기 — 마스터 또는 만든 이만
   *   admit   : 대기 위임 진입(마이그레이션 13) — 마스터 또는 만든 이만(=«먼저 해도 된다»는 승인)
   * 작업자는 늘 인증이 정한다(created_by 를 내밀어 사칭하면 403 impersonation — createDelegation).
   */
  delegationGate(pr: Principal, action: 'view' | 'create' | 'update' | 'release' | 'admit', d?: Row) {
    const p = pr.participant;
    const master = !!p.is_master && pr.via === 'cookie';
    const agent = p.kind === 'agent' && pr.via === 'token';
    const target = { action: `delegation.${action}`, target_type: 'delegation', target_id: d?.id ?? null, thread_id: d?.thread_id ?? null };
    if (!master && !agent) this.s.deny(pr, new ApiError(403, 'forbidden'), { ...target, reason: 'master_or_agent_only' });
    if ((action === 'release' || action === 'admit') && !master && d?.created_by !== p.id) this.s.deny(pr, new ApiError(403, 'not_owner', 'master or creator only'), target);
  }

  delegationRow(id: string): Row {
    const d = this.s.db.prepare('SELECT * FROM delegations WHERE id = ?').get(id) as Row | undefined;
    if (!d) throw new ApiError(404, 'no_delegation');
    return d;
  }

  delegationOut(id: string): Delegation {
    const claims = (this.s.db.prepare('SELECT * FROM claims WHERE delegation_id = ? ORDER BY id').all(id) as Row[]).map(toClaim);
    return toDelegation(this.delegationRow(id), claims);
  }

  claimList(v: unknown): ClaimInput[] {
    if (!Array.isArray(v) || v.length === 0) throw new ApiError(400, 'claims_required', 'claims: [{kind, repo, scope}, …]');
    if (v.length > MAX_CLAIMS) throw new ApiError(400, 'too_many_claims', `≤${MAX_CLAIMS}`);
    return v.map(normalizeClaim);
  }

  /** 다른 활성 위임(선점을 놓지 않았고 done·cancelled 가 아님)의 잡힌(granted=1) 선점 중 겹치는 것 — 대기 줄은 남을 막지 않는다. 트랜잭션 안에서 부른다 */
  claimConflicts(wanted: ClaimInput[], selfId: string | null): ClaimConflict[] {
    const q = this.s.db.prepare(
      `SELECT c.kind, c.repo, c.scope, d.id AS delegation_id, d.assignee, d.title FROM claims c JOIN delegations d ON d.id = c.delegation_id
       WHERE c.released_at IS NULL AND c.granted = 1 AND d.status NOT IN ('done','cancelled') AND d.id IS NOT ? AND c.repo = ? AND c.kind = ?`,
    );
    const out: ClaimConflict[] = [];
    const seen = new Set<string>();
    for (const w of wanted)
      for (const r of q.all(selfId, w.repo, w.kind) as Row[]) {
        if (!claimsOverlap(w, r as ClaimInput)) continue;
        const k = `${r.delegation_id}|${r.repo}|${r.scope}|${w.scope}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ delegation_id: r.delegation_id, assignee: r.assignee, title: r.title, kind: r.kind, repo: r.repo, scope: r.scope, wanted: w.scope });
      }
    return out;
  }

  insertClaims(id: string, claims: ClaimInput[], origin: 'initial' | 'added', t: number, granted = true) {
    const ins = this.s.db.prepare('INSERT INTO claims(delegation_id, kind, repo, scope, origin, claimed_at, granted) VALUES (?,?,?,?,?,?,?)');
    for (const c of claims) ins.run(id, c.kind, c.repo, c.scope, origin, t, granted ? 1 : 0);
  }

  /** 대기 위임인가(놓지 않은 granted=0 줄이 있다). 대기 위임은 admit 전에는 running·blocked 로도, 선점 추가로도 못 간다 */
  delegationWaiting(id: string): boolean {
    return !!this.s.db.prepare('SELECT 1 FROM claims WHERE delegation_id = ? AND granted = 0 AND released_at IS NULL LIMIT 1').get(id);
  }

  /** 선점 충돌 거절: 감사 한 줄(denied claim_conflict) + 409 {error:'claim_conflict', conflicts}. 트랜잭션 밖에서 부른다(안에서 던지면 감사 행도 되돌려진다) */
  claimDenied(pr: Principal, action: string, d: { id: string | null; thread_id: string | null }, wanted: ClaimInput[], conflicts: ClaimConflict[], after: Record<string, unknown> = {}): never {
    this.s.audit({
      actor: this.s.actorOf(pr),
      action,
      target_type: 'delegation',
      target_id: d.id,
      thread_id: d.thread_id,
      result: 'denied',
      reason: 'claim_conflict',
      after: { ...after, wanted, conflicts: conflicts.map((c) => ({ delegation_id: c.delegation_id, repo: c.repo, scope: c.scope })) },
    });
    throw new ApiError(409, 'claim_conflict', `${conflicts.length} claim(s) held by other delegations`, { conflicts });
  }

  /**
   * 위임 만들기: 선점 검사와 넣기가 IMMEDIATE 트랜잭션 하나 — 둘이 동시에 청해도 하나만 이긴다. 선점은 전부 아니면 전무.
   * 겹치면 아무것도 만들지 않고 409 claim_conflict(conflicts = 겹친 위임·담당·제목·저장소·범위).
   * queue:true 면 겹칠 때 거절 대신 대기로 만든다 — queued · 선점 줄 전부 granted=0(안 겹친 줄도 · 부분 진입 없음) · 응답에 conflicts.
   * 진입은 admitDelegation(마스터·만든 이) — 자동 진입은 없다(마스터 #345 «먼저 작업해도 되면 들어가겠지»).
   */
  createDelegation(pr: Principal, input: DelegationInput = {}): { delegation: Delegation; queued?: true; conflicts?: ClaimConflict[] } {
    this.delegationGate(pr, 'create');
    if (input.created_by !== undefined && input.created_by !== pr.participant.id)
      this.s.deny(pr, new ApiError(403, 'impersonation', 'created_by is set by the server'), { action: 'delegation.create', target_type: 'delegation' });
    const assignee = reqString(input.assignee, 'assignee', 64).trim();
    const title = reqString(input.title, 'title', 200).trim();
    if (!assignee || !title) throw new ApiError(400, 'bad_request', 'assignee, title required');
    const spec = reqString(input.spec, 'spec', 100_000);
    let slot: VersionSlot | null = null;
    if (input.version_slot !== undefined && input.version_slot !== null) {
      if (!VERSION_SLOTS.includes(input.version_slot as VersionSlot)) throw new ApiError(400, 'bad_request', `version_slot: ${VERSION_SLOTS.join(' | ')}`);
      slot = input.version_slot as VersionSlot;
    }
    const threadId = input.thread_id === undefined || input.thread_id === null ? null : reqString(input.thread_id, 'thread_id', 64);
    if (threadId) this.s.requireRead(pr, threadId, 'delegation.create', true);
    const sourceSeq = optInt(input.source_seq, 'source_seq');
    const claims = this.claimList(input.claims);
    if (input.queue !== undefined && typeof input.queue !== 'boolean') throw new ApiError(400, 'bad_request', 'queue: boolean');
    const queue = input.queue === true;
    const id = newId('dlg');
    const t = now();
    let waited: ClaimConflict[] = [];
    const conflicts = this.s.db
      .transaction(() => {
        const c = this.claimConflicts(claims, null);
        if (c.length && !queue) return c;
        waited = c;
        this.s.db
          .prepare(
            `INSERT INTO delegations(id, thread_id, source_seq, assignee, title, spec, version_slot, status, created_by, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,'queued',?,?,?)`,
          )
          .run(id, threadId, sourceSeq, assignee, title, spec, slot, pr.participant.id, t, t);
        this.insertClaims(id, claims, 'initial', t, c.length === 0);
        this.s.audit({
          actor: this.s.actorOf(pr),
          action: 'delegation.create',
          target_type: 'delegation',
          target_id: id,
          thread_id: threadId,
          result: 'ok',
          ...(c.length ? { reason: 'queued' } : {}),
          after: { assignee, title, version_slot: slot, claims, ...(c.length ? { conflicts: c.map((x) => ({ delegation_id: x.delegation_id, repo: x.repo, scope: x.scope })) } : {}) },
        });
        return [];
      })
      .immediate();
    if (conflicts.length) this.claimDenied(pr, 'delegation.create', { id: null, thread_id: threadId }, claims, conflicts, { assignee, title });
    this.s.emit({ notice: { t: 'delegation', id, status: 'queued' }, threadId: null });
    return waited.length ? { delegation: this.delegationOut(id), queued: true, conflicts: waited } : { delegation: this.delegationOut(id) };
  }

  /**
   * 대기 위임 진입(마이그레이션 13): IMMEDIATE 트랜잭션 안에서 대기 줄을 다시 검사 → 다 비었으면 전부 granted=1 · running.
   * 아직 겹치면 409 claim_conflict(아무것도 안 바뀐다 · 위임은 대기 그대로). 대기 줄이 없으면 409 not_waiting. 권한은 마스터·만든 이.
   */
  admitDelegation(pr: Principal, id: string): { ok: true; delegation: Delegation } {
    const d = this.delegationRow(id);
    this.delegationGate(pr, 'admit', d);
    const t = now();
    const res = this.s.db
      .transaction(() => {
        const cur = this.delegationRow(id);
        if (DELEGATION_CLOSED.includes(cur.status)) return { error: new ApiError(409, 'delegation_closed', `already ${cur.status}`) };
        const rows = this.s.db.prepare('SELECT kind, repo, scope FROM claims WHERE delegation_id = ? AND granted = 0 AND released_at IS NULL ORDER BY id').all(id) as Row[];
        if (!rows.length) return { error: new ApiError(409, 'not_waiting', 'no waiting claims') };
        const wanted = rows.map((r) => ({ kind: r.kind, repo: r.repo, scope: r.scope }) as ClaimInput);
        const conflicts = this.claimConflicts(wanted, id);
        if (conflicts.length) return { wanted, conflicts };
        this.s.db.prepare('UPDATE claims SET granted = 1, claimed_at = ? WHERE delegation_id = ? AND granted = 0 AND released_at IS NULL').run(t, id);
        this.s.db.prepare("UPDATE delegations SET status = 'running', updated_at = ? WHERE id = ?").run(t, id);
        this.s.audit({
          actor: this.s.actorOf(pr),
          action: 'delegation.admit',
          target_type: 'delegation',
          target_id: id,
          thread_id: cur.thread_id,
          result: 'ok',
          before: { status: cur.status },
          after: { status: 'running', granted: rows.length },
        });
        return { ok: true as const };
      })
      .immediate();
    if ('error' in res) throw res.error;
    if ('conflicts' in res) this.claimDenied(pr, 'delegation.admit', { id, thread_id: d.thread_id }, res.wanted!, res.conflicts!);
    this.s.emit({ notice: { t: 'delegation', id, status: 'running' }, threadId: null });
    return { ok: true, delegation: this.delegationOut(id) };
  }

  /**
   * 일하는 중 선점 더하기(origin 'added'). 겹치면 기다리지 않고 바로 실패한다(교착 없음) — 위임은 'blocked' 가 되고
   * 409 claim_conflict. 이미 쥔 선점은 놓지 않는다. 여러 줄이면 전부 아니면 전무.
   */
  addClaims(pr: Principal, id: string, input: unknown): { delegation: Delegation } {
    const d = this.delegationRow(id);
    this.delegationGate(pr, 'update', d);
    const claims = this.claimList(input);
    const t = now();
    const res = this.s.db
      .transaction(() => {
        const cur = this.delegationRow(id);
        if (DELEGATION_CLOSED.includes(cur.status)) return { closed: true as const };
        if (this.delegationWaiting(id)) return { waiting: true as const };
        const conflicts = this.claimConflicts(claims, id);
        if (conflicts.length) {
          if (cur.status !== 'blocked') this.s.db.prepare("UPDATE delegations SET status = 'blocked', updated_at = ? WHERE id = ?").run(t, id);
          return { conflicts, before: cur.status as DelegationStatus };
        }
        this.insertClaims(id, claims, 'added', t);
        this.s.db.prepare('UPDATE delegations SET updated_at = ?, last_seen_at = ? WHERE id = ?').run(t, t, id);
        this.s.audit({ actor: this.s.actorOf(pr), action: 'delegation.claim', target_type: 'delegation', target_id: id, thread_id: cur.thread_id, result: 'ok', after: { claims } });
        return { conflicts: [] as ClaimConflict[] };
      })
      .immediate();
    if ('closed' in res) throw new ApiError(409, 'delegation_closed', 'done or cancelled');
    if ('waiting' in res) throw new ApiError(409, 'not_admitted', 'waiting delegation — admit first');
    if (res.conflicts.length) {
      if (res.before !== 'blocked') this.s.emit({ notice: { t: 'delegation', id, status: 'blocked' }, threadId: null });
      this.claimDenied(pr, 'delegation.claim', { id, thread_id: d.thread_id }, claims, res.conflicts, { before: res.before, status: 'blocked' });
    }
    this.s.emit({ notice: { t: 'delegation', id, status: this.delegationRow(id).status }, threadId: null });
    return { delegation: this.delegationOut(id) };
  }

  /** 상태 바꾸기. done·cancelled = 끝(finished_at · 선점을 모두 놓는다 · 다시 못 연다) · queued·running·blocked = 선점을 쥔 채 */
  setDelegationStatus(pr: Principal, id: string, status: unknown, result?: unknown): { ok: true; changed: boolean; delegation: Delegation } {
    const d = this.delegationRow(id);
    this.delegationGate(pr, 'update', d);
    if (!DELEGATION_STATUSES.includes(status as DelegationStatus)) throw new ApiError(400, 'bad_status', DELEGATION_STATUSES.join(' | '));
    const next = status as DelegationStatus;
    const res = result === undefined || result === null ? null : reqString(result, 'result', 20_000);
    const t = now();
    const changed = this.s.db
      .transaction(() => {
        const cur = this.delegationRow(id);
        const closed = DELEGATION_CLOSED.includes(cur.status);
        if (closed && cur.status !== next) throw new ApiError(409, 'delegation_closed', `already ${cur.status}`);
        if (cur.status === next && (res === null || res === cur.result)) return false;
        const closing = DELEGATION_CLOSED.includes(next);
        // 대기 위임은 admit 으로만 들어간다(running·blocked 로 건너뛰면 겹침 검사를 지나친다) — queued·끝은 된다
        if (!closed && (next === 'running' || next === 'blocked') && this.delegationWaiting(id)) throw new ApiError(409, 'not_admitted', 'waiting delegation — admit first');
        this.s.db
          .prepare('UPDATE delegations SET status = ?, result = COALESCE(?, result), updated_at = ?, last_seen_at = ?, finished_at = ? WHERE id = ?')
          .run(next, res, t, t, closing ? (cur.finished_at ?? t) : null, id);
        const released = closing ? this.s.db.prepare('UPDATE claims SET released_at = ? WHERE delegation_id = ? AND released_at IS NULL').run(t, id).changes : 0;
        this.s.audit({
          actor: this.s.actorOf(pr),
          action: 'delegation.status',
          target_type: 'delegation',
          target_id: id,
          thread_id: cur.thread_id,
          result: 'ok',
          before: { status: cur.status },
          after: { status: next, released },
        });
        return true;
      })
      .immediate();
    if (changed) this.s.emit({ notice: { t: 'delegation', id, status: next }, threadId: null });
    return { ok: true, changed, delegation: this.delegationOut(id) };
  }

  /** 백수가 살아 있다는 신호 — last_seen_at 만 갈아 쓴다(감사·알림 없음). 끝난 위임은 409 */
  delegationHeartbeat(pr: Principal, id: string): { ok: true; id: string; status: DelegationStatus; last_seen_at: number } {
    const d = this.delegationRow(id);
    this.delegationGate(pr, 'update', d);
    if (DELEGATION_CLOSED.includes(d.status)) throw new ApiError(409, 'delegation_closed', `already ${d.status}`);
    const t = now();
    this.s.db.prepare('UPDATE delegations SET last_seen_at = ? WHERE id = ?').run(t, id);
    return { ok: true, id, status: d.status, last_seen_at: t };
  }

  /** 강제 놓기(마스터 또는 만든 이): 죽은 백수의 선점을 거둔다 — 'cancelled' + 선점 모두 놓음. 감사 reason 'forced' */
  releaseStale(pr: Principal, id: string): { ok: true; outcome: 'released' | 'already_closed'; released: number; delegation: Delegation } {
    const d = this.delegationRow(id);
    this.delegationGate(pr, 'release', d);
    const t = now();
    const out = this.s.db
      .transaction(() => {
        const cur = this.delegationRow(id);
        const base = { actor: this.s.actorOf(pr), action: 'delegation.release', target_type: 'delegation', target_id: id, thread_id: cur.thread_id as string | null };
        if (DELEGATION_CLOSED.includes(cur.status)) {
          this.s.audit({ ...base, result: 'noop', reason: 'already_closed', before: { status: cur.status } });
          return { outcome: 'already_closed' as const, released: 0 };
        }
        this.s.db.prepare("UPDATE delegations SET status = 'cancelled', updated_at = ?, finished_at = ? WHERE id = ?").run(t, t, id);
        const released = this.s.db.prepare('UPDATE claims SET released_at = ? WHERE delegation_id = ? AND released_at IS NULL').run(t, id).changes;
        this.s.audit({ ...base, result: 'ok', reason: 'forced', before: { status: cur.status, last_seen_at: cur.last_seen_at ?? null }, after: { status: 'cancelled', released } });
        return { outcome: 'released' as const, released };
      })
      .immediate();
    if (out.outcome === 'released') this.s.emit({ notice: { t: 'delegation', id, status: 'cancelled' }, threadId: null });
    return { ok: true, ...out, delegation: this.delegationOut(id) };
  }

  /**
   * 위임 목록(선점 포함 · 최근 순). active = done·cancelled 가 아닌 것만 ·
   * recent=초(active 와 함께 · ≤7일) = 그 안에 끝난 것도 더한다(선점 레인이 «방금 하얘진» 블록과 지난 범위를 그린다 — 마스터 #345)
   */
  listDelegations(pr: Principal, q: { active?: unknown; recent?: unknown } = {}): { delegations: Delegation[] } {
    this.delegationGate(pr, 'view');
    const active = q.active === true || q.active === '1' || q.active === 'true';
    let recent = 0;
    if (q.recent !== undefined && q.recent !== '') {
      recent = Number(q.recent);
      if (!Number.isInteger(recent) || recent < 0 || recent > 7 * 86400) throw new ApiError(400, 'bad_request', 'recent: seconds 0..604800');
    }
    const where = !active ? '' : recent ? "WHERE status NOT IN ('done','cancelled') OR finished_at >= ?" : "WHERE status NOT IN ('done','cancelled')";
    const rows = this.s.db
      .prepare(`SELECT * FROM delegations ${where} ORDER BY created_at DESC, id LIMIT 500`)
      .all(...(active && recent ? [now() - recent * 1000] : [])) as Row[];
    const byId = new Map<string, DelegationClaim[]>(rows.map((r) => [r.id as string, []]));
    if (rows.length) {
      const ids = rows.map((r) => r.id as string);
      const cl = this.s.db.prepare(`SELECT * FROM claims WHERE delegation_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids) as Row[];
      for (const c of cl) byId.get(c.delegation_id)!.push(toClaim(c));
    }
    return { delegations: rows.map((r) => toDelegation(r, byId.get(r.id)!)) };
  }

  getDelegation(pr: Principal, id: string): { delegation: Delegation } {
    this.delegationGate(pr, 'view');
    return { delegation: this.delegationOut(id) };
  }

}
