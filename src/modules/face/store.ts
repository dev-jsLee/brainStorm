// 대면 모듈(face · 마이그레이션 16 · 마스터 #579·#581) — docs/MODULES.md 2단계(마스터 #1207)에 store.ts 에서 옮겼다.
// 켜졌을 때만 Store.face 에 붙는다(BRAINSTORM_MODULES 에 face). 꺼지면 대면 모드 스레드도 보통 채팅처럼 돈다 — 표·행은 그대로 남는다.
import { newId } from '../../crypto.js';
import { applyTurn, diffLines, docLines, parseFaceAnswer, replaceIssueLines, type LineOrigin } from '../../face.js';
import { t as tr } from '../../i18n.js';
import type { ClaimFace, FaceIssue, FaceRev, FaceRound, FaceState, SourceKind, Thread, ThreadMode } from '../../protocol.js';
import { ApiError, now, optInt, toMessage, type AuditActor, type Principal, type Row, type Store } from '../../store.js';

export class FaceStore {
  constructor(readonly s: Store) {}

  // ───────────────────────── 대면 모드 (마이그레이션 16 · 마스터 #579·#581) ─────────────────────────
  //   마스터 지시 하나 = 라운드. 턴은 서버가 기계적으로 넘긴다(완료 보고 → 다른 쪽에게 배달 — 요청→ 배달과 같은 길).
  //   합의 = 수정 턴이 합의문을 안 바꿈 · 쟁점 = 상대가 직전 턴에 고친 줄을 다시 고침(src/face.ts).

  faceRow(id: string): Row | undefined {
    return this.s.db.prepare('SELECT * FROM face_rounds WHERE id = ?').get(id) as Row | undefined;
  }

  faceLatest(threadId: string): Row | undefined {
    return this.s.db.prepare('SELECT * FROM face_rounds WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(threadId) as Row | undefined;
  }

  faceRevRows(roundId: string): Row[] {
    return this.s.db.prepare('SELECT * FROM face_revs WHERE round_id = ? ORDER BY rev').all(roundId) as Row[];
  }

  faceOrigins(round: Row): LineOrigin[] {
    if (!round.rev) return [];
    const r = this.s.db.prepare('SELECT origins FROM face_revs WHERE round_id = ? AND rev = ?').get(round.id, round.rev) as Row | undefined;
    return r ? (JSON.parse(r.origins) as LineOrigin[]) : [];
  }

  faceIssueRows(roundId: string, onlyOpen = false): Row[] {
    return this.s.db.prepare(`SELECT * FROM face_issues WHERE round_id = ?${onlyOpen ? " AND state = 'open'" : ''} ORDER BY n`).all(roundId) as Row[];
  }

  faceOther(round: Row, me: string): string {
    return me === round.drafter ? round.reviewer : round.drafter;
  }

  /** 대면 턴을 하려면 두 쪽 다 이 스레드를 읽을 수 있어야 한다 */
  faceCheckMembers(threadId: string) {
    if (!this.s.cfg.faceDrafter || !this.s.cfg.faceReviewer) throw new ApiError(409, 'face_not_configured', '대면 모드를 쓰려면 BRAINSTORM_FACE_DRAFTER·BRAINSTORM_FACE_REVIEWER 에 에이전트 id 를 적는다');
    const miss = [this.s.cfg.faceDrafter, this.s.cfg.faceReviewer].filter((a) => !this.s.getParticipant(a) || !this.s.membership(threadId, a)?.can_read);
    if (miss.length) throw new ApiError(409, 'face_members', `대면 모드는 ${this.s.cfg.faceDrafter}·${this.s.cfg.faceReviewer} 가 이 대화의 멤버여야 한다 — 없음: ${miss.join(', ')}`, undefined, { key: 'err.face_members.required', vars: { drafter: this.s.cfg.faceDrafter, reviewer: this.s.cfg.faceReviewer, missing: miss.join(', ') } });
  }

  faceEmit(round: Row) {
    this.s.emit({ notice: { t: 'face', thread_id: round.thread_id, round_id: round.id, state: round.state }, threadId: round.thread_id });
  }

  /**
   * 마스터 글(대면 스레드 · 트랜잭션 안): 질문으로 멈춘 라운드면 답 → 물은 쪽이 이어 받는다 · 도는 라운드면 글만(맥락) ·
   * 그 밖(라운드 없음·끝남·멈춤)이면 새 라운드 → 초안 쪽에게. 배달 받을 쪽을 돌려준다
   */
  faceMasterPost(threadId: string, seq: number, t: number): { to: string | null; round: Row } {
    const r = this.faceLatest(threadId);
    if (r && r.state === 'question') {
      this.s.db.prepare("UPDATE face_rounds SET state = 'running', next_agent = ?, turn_seq = ?, updated_at = ? WHERE id = ?").run(r.question_by, seq, t, r.id);
      return { to: r.question_by as string, round: this.faceRow(r.id)! };
    }
    if (r && r.state === 'running') return { to: null, round: r };
    const id = newId('face');
    this.s.db
      .prepare(
        `INSERT INTO face_rounds(id, thread_id, instruction_seq, drafter, reviewer, state, next_agent, turn_seq, turn, base_turns, max_turns, rev, created_at, updated_at)
         VALUES (?,?,?,?,?, 'running', ?, ?, 0, ?, ?, 0, ?, ?)`,
      )
      .run(id, threadId, seq, this.s.cfg.faceDrafter, this.s.cfg.faceReviewer, this.s.cfg.faceDrafter, seq, this.s.cfg.faceBaseTurns, this.s.cfg.faceMaxTurns, t, t);
    return { to: this.s.cfg.faceDrafter, round: this.faceRow(id)! };
  }

  /** 이 실행이 대면 턴이면 그 라운드(도는 중 · 원인이 지금 차례 글 · 다음 차례가 나) */
  faceTurnRound(threadId: string, triggerSeq: number, agentId: string): Row | undefined {
    const th = this.s.db.prepare('SELECT mode FROM threads WHERE id = ?').get(threadId) as Row | undefined;
    if (th?.mode !== 'face') return undefined;
    return this.s.db
      .prepare("SELECT * FROM face_rounds WHERE thread_id = ? AND state = 'running' AND turn_seq = ? AND next_agent = ? ORDER BY created_at DESC LIMIT 1")
      .get(threadId, triggerSeq, agentId) as Row | undefined;
  }

  /** 직전 에이전트 판(마스터 결정 판은 건너뜀) */
  faceLastAgentRev(roundId: string): Row | undefined {
    const master = this.s.getMaster()?.id ?? '';
    return this.s.db.prepare('SELECT * FROM face_revs WHERE round_id = ? AND author_id <> ? ORDER BY rev DESC LIMIT 1').get(roundId, master) as Row | undefined;
  }

  /** claim 에 싣는 대면 턴 정보 */
  faceForClaim(threadId: string, triggerSeq: number, me: string): ClaimFace | null {
    const r = this.faceTurnRound(threadId, triggerSeq, me);
    if (!r) return null;
    const other = this.faceOther(r, me);
    const origins = this.faceOrigins(r);
    const lines = r.doc === null ? [] : docLines(r.doc);
    const last = this.faceLastAgentRev(r.id);
    const otherRev = last && last.author_id === other ? (last.rev as number) : null;
    const open = this.faceIssueRows(r.id, true);
    return {
      round_id: r.id,
      turn: r.turn + 1,
      role: me === r.drafter ? 'drafter' : 'reviewer',
      other: { id: other, name: this.s.nameOf(other) },
      base_turns: r.base_turns,
      max_turns: r.max_turns,
      doc: r.doc ?? null,
      rev: r.rev,
      changed_by_other: otherRev === null ? [] : lines.filter((_, i) => origins[i]?.by === other && origins[i]?.rev === otherRev && !origins[i]?.draft),
      open_issues: open.map((x) => ({ n: x.n as number, lines: lines.filter((_, i) => origins[i]?.issue === x.id) })),
      resumed_question: r.question ?? null,
    };
  }

  /** 대면 턴의 완료 보고: 답 글(해설) + 실행 완료 + 판·안건 + 다음 차례 배달 — 한 트랜잭션 */
  completeFace(pr: Principal, r: Row, round: Row, rawBody: string, sk: SourceKind, input: { usage?: unknown; runtime?: unknown; model?: unknown }) {
    const me = pr.participant.id;
    const other = this.faceOther(round, me);
    const ans = parseFaceAnswer(rawBody);
    const usage = input.usage === undefined ? null : JSON.stringify(input.usage).slice(0, 4000);
    const t = now();
    const duringCancel = r.cancel_requested_at != null;
    const trig = this.s.db.prepare('SELECT hop FROM messages WHERE seq = ?').get(r.trigger_seq) as Row;
    let deliveryTo: string | null = null;
    const seq = this.s.db.transaction(() => {
      const body = ans.kind === 'doc' ? ans.note || tr(this.s.lang(), 'srv.face.no_note', { rev: round.rev + 1 }) : rawBody;
      const info = this.s.db
        .prepare(
          `INSERT INTO messages(id, thread_id, author_id, client_key, body, reply_to_seq, source_kind, input_mode, recipients, hop, trigger_run_id, handoff_to, pull_req, created_at)
           VALUES (?,?,?,?,?,?,?, 'text', '[]', ?, ?, '[]', NULL, ?)`,
        )
        .run(newId('msg'), r.thread_id, me, `run:${r.id}`, body, r.trigger_seq, sk, trig.hop + 1, r.id, t);
      const seq = Number(info.lastInsertRowid);
      this.s.tags.attach(seq, { primary: [], inline: [] }); // 스레드 고정 태그(마이그레이션 22 · #1937) — 글 저장 경로 한 곳
      this.s.db
        .prepare("UPDATE runs SET state = 'succeeded', ended_at = ?, finalized_at = ?, usage = ?, result_seq = ?, lease_expires_at = NULL WHERE id = ?")
        .run(t, t, usage, seq, r.id);
      this.s.ev(r.id, 'completed', me, { result_seq: seq, during_cancel: duringCancel }, t);
      this.s.ev(r.id, 'finalized', 'server', duringCancel ? { state: 'succeeded', completed_first: true } : { state: 'succeeded' }, t);
      if (duringCancel) this.s.auditCancelFinal(r, 'succeeded', 'completed_first', t, me);
      const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.slice(0, 200) : null);
      this.s.db.prepare('UPDATE agent_sessions SET runtime = COALESCE(?, runtime), actual_model = COALESCE(?, actual_model) WHERE id = ?').run(str(input.runtime), str(input.model), r.session_id);

      if (ans.kind === 'question') {
        this.s.db
          .prepare("UPDATE face_rounds SET state = 'question', question = ?, question_by = ?, question_seq = ?, next_agent = ?, updated_at = ? WHERE id = ?")
          .run(ans.question, me, seq, me, t, round.id);
        this.s.ev(r.id, 'face_question', 'server', { round_id: round.id, turn: round.turn + 1 }, t);
        return seq;
      }
      if (ans.kind === 'none') {
        this.s.db.prepare("UPDATE face_rounds SET state = 'stopped', stop_reason = 'no_doc', next_agent = ?, updated_at = ? WHERE id = ?").run(me, t, round.id);
        this.s.ev(r.id, 'face_no_doc', 'server', { round_id: round.id, turn: round.turn + 1 }, t);
        return seq;
      }
      const turn = (round.turn as number) + 1;
      const rev = (round.rev as number) + 1;
      const revs = this.faceRevRows(round.id);
      const last = this.faceLastAgentRev(round.id);
      const otherRev = last && last.author_id === other ? (last.rev as number) : null;
      const myPast = new Set<string>();
      for (const row of revs) {
        const o = JSON.parse(row.origins) as LineOrigin[];
        docLines(row.doc).forEach((l, i) => o[i]?.by === me && l.trim() && myPast.add(l));
      }
      const open = new Set(this.faceIssueRows(round.id, true).map((x) => x.id as string));
      const res = applyTurn({
        prevDoc: round.rev ? (round.doc as string) : null,
        prevOrigins: this.faceOrigins(round),
        newDoc: ans.doc,
        me,
        other,
        rev,
        turn,
        otherPrevRev: otherRev,
        otherSeq: otherRev !== null ? ((last!.message_seq as number) ?? null) : null,
        mySeq: seq,
        openIssues: open,
        myPastLines: myPast,
        limitTurn: turn >= round.max_turns,
        newIssueId: () => newId('fi'),
      });
      this.s.db
        .prepare('INSERT INTO face_revs(round_id, rev, turn, author_id, run_id, message_seq, doc, origins, changed, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(round.id, rev, turn, me, r.id, seq, ans.doc, JSON.stringify(res.origins), res.changed, t);
      let n = ((this.s.db.prepare('SELECT MAX(n) AS n FROM face_issues WHERE round_id = ?').get(round.id) as Row).n as number | null) ?? 0;
      for (const op of res.issueOps) {
        if (op.op === 'new')
          this.s.db
            .prepare("INSERT INTO face_issues(id, round_id, n, kind, versions, state, created_at) VALUES (?,?,?,?,?, 'open', ?)")
            .run(op.id, round.id, ++n, op.kind, JSON.stringify(op.versions), t);
        else {
          const row = this.s.db.prepare('SELECT versions FROM face_issues WHERE id = ?').get(op.id) as Row;
          this.s.db.prepare('UPDATE face_issues SET versions = ? WHERE id = ?').run(JSON.stringify([...JSON.parse(row.versions), op.version]), op.id);
        }
      }
      let state: FaceState = 'running';
      let stopReason: string | null = null;
      if (turn >= 2 && res.changed === 0) state = 'agreed';
      else if (turn >= round.max_turns) state = 'limit';
      else if (this.s.requireThread(r.thread_id).invoke_paused) {
        state = 'stopped';
        stopReason = 'invoke_paused';
      } else deliveryTo = other;
      const ended = state === 'agreed' || state === 'limit';
      this.s.db
        .prepare(
          `UPDATE face_rounds SET state = ?, stop_reason = ?, turn = ?, rev = ?, doc = ?, next_agent = ?, turn_seq = ?, question = NULL, question_by = NULL,
           ended_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(state, stopReason, turn, rev, ans.doc, ended ? null : other, ended ? null : seq, ended ? t : null, t, round.id);
      if (deliveryTo) {
        const did = newId('dlv');
        this.s.db
          .prepare(`INSERT INTO deliveries(id, message_seq, thread_id, recipient_id, status, attempts, created_at, updated_at) VALUES (?,?,?,?, 'pending', 0, ?, ?)`)
          .run(did, seq, r.thread_id, deliveryTo, t, t);
        this.s.ev(r.id, 'face_next', 'server', { round_id: round.id, to: deliveryTo, delivery_id: did }, t);
      }
      this.s.ev(r.id, 'face_turn', 'server', { round_id: round.id, turn, rev, changed: res.changed, issues: res.issueOps.length, state }, t);
      return seq;
    })();
    this.s.emit({ notice: { t: 'msg', thread_id: r.thread_id, seq }, threadId: r.thread_id });
    this.s.emit({ notice: { t: 'run', thread_id: r.thread_id, run_id: r.id, state: 'succeeded' }, threadId: r.thread_id });
    this.faceEmit(this.faceRow(round.id)!);
    if (deliveryTo) this.s.emit({ notice: { t: 'delivery', thread_id: r.thread_id }, threadId: r.thread_id, only: deliveryTo });
    return { run: this.s.toRunOut(this.s.runRow(r.id)!), message: toMessage(this.s.db.prepare('SELECT * FROM messages WHERE seq = ?').get(seq) as Row), duplicate: false };
  }

  /** 대면 턴 실행이 실패하면 라운드는 멈춘다(«다시 돌리기»로 같은 쪽이 같은 턴을) */
  faceOnFail(r: Row, t: number) {
    const round = this.faceTurnRound(r.thread_id, r.trigger_seq, r.agent_id);
    if (!round) return;
    this.s.db.prepare("UPDATE face_rounds SET state = 'stopped', stop_reason = 'run_failed', updated_at = ? WHERE id = ?").run(t, round.id);
    this.faceEmit(this.faceRow(round.id)!);
  }

  /** 도는 라운드인데 그 턴의 배달·실행이 없다(취소·미확인으로 끝남) — 화면에 «다시 돌리기» */
  faceStalled(round: Row): boolean {
    if (round.state !== 'running' || round.turn_seq == null || !round.next_agent) return false;
    const d = this.s.db
      .prepare("SELECT 1 FROM deliveries WHERE message_seq = ? AND recipient_id = ? AND status IN ('pending','leased')")
      .get(round.turn_seq, round.next_agent);
    const run = this.s.db
      .prepare("SELECT state FROM runs WHERE trigger_seq = ? AND agent_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(round.turn_seq, round.next_agent) as Row | undefined;
    return !d && (!run || (run.state !== 'queued' && run.state !== 'running' && run.state !== 'succeeded'));
  }

  /** 지금 차례의 배달을 거두고 도는 실행에 중단을 요청한다(멈추기·모드 끔) */
  faceWithdraw(round: Row, who: string, t: number, actor: AuditActor): string[] {
    if (!round.turn_seq || !round.next_agent) return [];
    this.s.db
      .prepare("UPDATE deliveries SET status = 'cancelled', last_error = 'face_stop', lease_token_hash = NULL, updated_at = ? WHERE message_seq = ? AND recipient_id = ? AND status IN ('pending','leased')")
      .run(t, round.turn_seq, round.next_agent);
    const out: string[] = [];
    for (const r of this.s.db.prepare("SELECT * FROM runs WHERE trigger_seq = ? AND agent_id = ? AND state IN ('queued','running')").all(round.turn_seq, round.next_agent) as Row[]) {
      this.s.requestCancel(r, who, t, actor);
      out.push(r.id);
    }
    return out;
  }

  faceHalt(pr: Principal, round: Row, reason: 'master_stop' | 'mode_off', t: number): string[] {
    if (round.state !== 'running' && round.state !== 'question') return [];
    const runs = this.faceWithdraw(round, pr.participant.id, t, this.s.actorOf(pr));
    this.s.db.prepare("UPDATE face_rounds SET state = 'stopped', stop_reason = ?, updated_at = ? WHERE id = ?").run(reason, t, round.id);
    return runs;
  }

  /** 대면 모드 켜기·끄기(마스터만). 끄면 보통 대화 — 도는 라운드는 멈춘다 */
  setThreadMode(pr: Principal, threadId: string, mode: unknown): { ok: true; changed: boolean; thread: Thread } {
    this.s.requireMaster(pr, 'thread.mode', { target_type: 'thread', target_id: threadId, thread_id: threadId });
    const th = this.s.requireThread(threadId);
    if (mode !== 'chat' && mode !== 'face') throw new ApiError(400, 'bad_mode', "mode: 'chat' | 'face'");
    if (th.kind === 'room') throw new ApiError(409, 'room_locked', '메인 채팅방은 대면 모드가 없다', undefined, { key: 'err.room_locked.face' });
    if (th.deleted_at) throw new ApiError(409, 'thread_deleted');
    if (mode === 'face') this.faceCheckMembers(threadId);
    const t = now();
    const before = th.mode === 'face' ? 'face' : 'chat';
    let halted: Row | undefined;
    let runs: string[] = [];
    this.s.db.transaction(() => {
      this.s.db.prepare('UPDATE threads SET mode = ?, updated_at = ? WHERE id = ?').run(mode, t, threadId);
      if (mode === 'chat') {
        const r = this.faceLatest(threadId);
        if (r && (r.state === 'running' || r.state === 'question')) {
          runs = this.faceHalt(pr, r, 'mode_off', t);
          halted = r;
        }
      }
      this.s.audit({
        actor: this.s.actorOf(pr), action: 'thread.mode', target_type: 'thread', target_id: threadId, thread_id: threadId,
        result: before === mode ? 'noop' : 'ok', reason: before === mode ? 'unchanged' : null,
        before: { mode: before }, after: { mode, ...(halted ? { stopped_round: halted.id } : {}) },
      });
    })();
    for (const id of runs) this.s.emit({ notice: { t: 'run', thread_id: threadId, run_id: id, state: 'running' }, threadId });
    if (halted) this.faceEmit(this.faceRow(halted.id)!);
    this.s.emit({ notice: { t: 'thread', thread_id: threadId }, threadId });
    return { ok: true, changed: before !== mode, thread: this.s.getThread(pr, threadId).thread };
  }

  faceOut(r: Row): FaceRound {
    return {
      id: r.id, thread_id: r.thread_id, instruction_seq: r.instruction_seq, drafter: r.drafter, reviewer: r.reviewer, state: r.state,
      next_agent: r.next_agent ?? null, turn_seq: r.turn_seq ?? null, turn: r.turn, base_turns: r.base_turns, max_turns: r.max_turns,
      doc: r.doc ?? null, rev: r.rev, stop_reason: r.stop_reason ?? null, question: r.question ?? null, question_by: r.question_by ?? null,
      question_seq: r.question_seq ?? null, verdict: r.verdict ?? null, verdict_note: r.verdict_note ?? null, verdict_by: r.verdict_by ?? null,
      verdict_at: r.verdict_at ?? null, created_at: r.created_at, updated_at: r.updated_at, ended_at: r.ended_at ?? null,
    };
  }

  faceIssueOut(x: Row): FaceIssue {
    return {
      id: x.id, round_id: x.round_id, n: x.n, kind: x.kind, versions: JSON.parse(x.versions), state: x.state,
      decision: x.decision ?? null, decided_by: x.decided_by ?? null, decided_at: x.decided_at ?? null, created_at: x.created_at,
    };
  }

  /** 대면 보기: 모드 · 설정 · 라운드(기본 최신 · ?round=) · 판들 · 안건 · 지난 라운드 목록 · 멈춰 선 턴인지 */
  getFace(pr: Principal, threadId: string, roundId?: string) {
    const th = this.s.requireRead(pr, threadId, 'thread.read', true);
    const r = roundId ? this.faceRow(roundId) : this.faceLatest(threadId);
    if (roundId && (!r || r.thread_id !== threadId)) throw new ApiError(404, 'no_round');
    return {
      mode: (th.mode === 'face' ? 'face' : 'chat') as ThreadMode,
      config: { drafter: this.s.cfg.faceDrafter, reviewer: this.s.cfg.faceReviewer, base_turns: this.s.cfg.faceBaseTurns, max_turns: this.s.cfg.faceMaxTurns },
      round: r ? this.faceOut(r) : null,
      stalled: r ? this.faceStalled(r) : false,
      revs: r
        ? this.faceRevRows(r.id).map(
            (x) => ({ rev: x.rev, turn: x.turn, author_id: x.author_id, run_id: x.run_id ?? null, message_seq: x.message_seq ?? null, doc: x.doc, origins: JSON.parse(x.origins), changed: x.changed, created_at: x.created_at }) satisfies FaceRev,
          )
        : [],
      issues: r ? this.faceIssueRows(r.id).map((x) => this.faceIssueOut(x)) : [],
      rounds: (this.s.db.prepare('SELECT id, state, instruction_seq, turn, created_at FROM face_rounds WHERE thread_id = ? ORDER BY created_at DESC LIMIT 50').all(threadId) as Row[]).map((x) => ({ ...x })),
    };
  }

  faceRoundFor(pr: Principal, roundId: string, action: string): Row {
    const r = this.faceRow(roundId);
    this.s.requireMaster(pr, action, { target_type: 'face_round', target_id: roundId, thread_id: r?.thread_id ?? null });
    if (!r) throw new ApiError(404, 'no_round');
    this.s.requireRead(pr, r.thread_id, action);
    return r;
  }

  /** 안건 결정(마스터만): 한 판을 고르거나(pick) 직접 쓴다(text) → 합의문의 그 줄을 갈아 끼운 새 판 */
  decideIssue(pr: Principal, roundId: string, issueId: string, input: { pick?: unknown; text?: unknown } = {}) {
    const r = this.faceRoundFor(pr, roundId, 'face.decide');
    if (r.state === 'approved' || r.state === 'rejected') throw new ApiError(409, 'round_closed');
    const x = this.s.db.prepare('SELECT * FROM face_issues WHERE id = ? AND round_id = ?').get(issueId, roundId) as Row | undefined;
    if (!x) throw new ApiError(404, 'no_issue');
    if (x.state !== 'open') throw new ApiError(409, 'already_decided');
    const versions = JSON.parse(x.versions) as FaceIssue['versions'];
    let text: string;
    if (input.pick !== undefined && input.pick !== null) {
      const k = optInt(input.pick, 'pick');
      if (k === null || k < 0 || k >= versions.length) throw new ApiError(400, 'bad_pick');
      text = versions[k].text;
    } else if (typeof input.text === 'string') text = input.text.slice(0, this.s.cfg.bodyMaxChars);
    else throw new ApiError(400, 'bad_request', 'pick 또는 text', undefined, { key: 'err.bad_request.pick_or_text' });
    const t = now();
    const me = pr.participant.id;
    this.s.db.transaction(() => {
      const rev = (r.rev as number) + 1;
      const prev = (r.doc as string | null) ?? '';
      const out = replaceIssueLines(prev, this.faceOrigins(r), issueId, text, me, rev);
      const changed = diffLines(docLines(prev), docLines(out.doc)).reduce((s, h) => s + (h.aEnd - h.aStart) + (h.bEnd - h.bStart), 0);
      this.s.db
        .prepare('INSERT INTO face_revs(round_id, rev, turn, author_id, run_id, message_seq, doc, origins, changed, created_at) VALUES (?,?,?,?,NULL,NULL,?,?,?,?)')
        .run(roundId, rev, r.turn, me, out.doc, JSON.stringify(out.origins), changed, t);
      this.s.db.prepare("UPDATE face_issues SET state = 'decided', decision = ?, decided_by = ?, decided_at = ? WHERE id = ?").run(text, me, t, issueId);
      this.s.db.prepare('UPDATE face_rounds SET doc = ?, rev = ?, updated_at = ? WHERE id = ?').run(out.doc, rev, t, roundId);
      this.s.audit({
        actor: this.s.actorOf(pr), action: 'face.decide', target_type: 'face_issue', target_id: issueId, thread_id: r.thread_id, result: 'ok',
        after: { round_id: roundId, n: x.n, pick: input.pick ?? null, rev },
      });
    })();
    const nr = this.faceRow(roundId)!;
    this.faceEmit(nr);
    return { ok: true as const, round: this.faceOut(nr), issue: this.faceIssueOut(this.s.db.prepare('SELECT * FROM face_issues WHERE id = ?').get(issueId) as Row) };
  }

  /** 결론 판정(마스터만): 합의·상한에서 승인(열린 안건 0 · «정산:» 줄) / 반려 */
  faceVerdict(pr: Principal, roundId: string, input: { verdict?: unknown; note?: unknown } = {}) {
    const r = this.faceRoundFor(pr, roundId, 'face.verdict');
    if (input.verdict !== 'approve' && input.verdict !== 'reject') throw new ApiError(400, 'bad_verdict', "verdict: 'approve' | 'reject'");
    if (r.state !== 'agreed' && r.state !== 'limit') throw new ApiError(409, 'bad_state', `round is ${r.state}`);
    const open = this.faceIssueRows(roundId, true).length;
    if (input.verdict === 'approve' && open) throw new ApiError(409, 'issues_open', `열린 안건 ${open}개 — 먼저 정한다`, undefined, { key: 'err.issues_open', vars: { n: open } });
    const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 2000) : null;
    const t = now();
    const state: FaceState = input.verdict === 'approve' ? 'approved' : 'rejected';
    this.s.db.transaction(() => {
      this.s.db
        .prepare('UPDATE face_rounds SET state = ?, verdict = ?, verdict_note = ?, verdict_by = ?, verdict_at = ?, updated_at = ? WHERE id = ?')
        .run(state, input.verdict, note, pr.participant.id, t, t, roundId);
      this.s.audit({
        actor: this.s.actorOf(pr), action: 'face.verdict', target_type: 'face_round', target_id: roundId, thread_id: r.thread_id, result: 'ok',
        reason: String(input.verdict), before: { state: r.state }, after: { state, rev: r.rev },
      });
    })();
    const nr = this.faceRow(roundId)!;
    this.faceEmit(nr);
    return { ok: true as const, round: this.faceOut(nr) };
  }

  /** 멈추기(마스터만): 지금 차례 배달을 거두고 도는 실행에 중단 요청 → stopped(master_stop) */
  faceStop(pr: Principal, roundId: string) {
    const r = this.faceRoundFor(pr, roundId, 'face.stop');
    if (r.state !== 'running' && r.state !== 'question') throw new ApiError(409, 'bad_state', `round is ${r.state}`);
    const t = now();
    let runs: string[] = [];
    this.s.db.transaction(() => {
      runs = this.faceHalt(pr, r, 'master_stop', t);
      this.s.audit({ actor: this.s.actorOf(pr), action: 'face.stop', target_type: 'face_round', target_id: roundId, thread_id: r.thread_id, result: 'ok', before: { state: r.state }, after: { state: 'stopped', cancel_requested_runs: runs.length } });
    })();
    for (const id of runs) this.s.emit({ notice: { t: 'run', thread_id: r.thread_id, run_id: id, state: 'running' }, threadId: r.thread_id });
    const nr = this.faceRow(roundId)!;
    this.faceEmit(nr);
    return { ok: true as const, round: this.faceOut(nr), cancel_requested_runs: runs };
  }

  /**
   * 다시 돌리기(마스터만): 멈춘 라운드(또는 배달·실행 없이 선 턴)를 같은 쪽의 같은 턴부터. 실행은 (원인, 수신자)마다 한 번이라
   * 마스터 글 하나(«대면 다시 돌리기») 를 새 원인으로 만들고 그 글을 배달한다
   */
  faceRetry(pr: Principal, roundId: string) {
    const r = this.faceRoundFor(pr, roundId, 'face.retry');
    const th = this.s.requireThread(r.thread_id);
    if (th.mode !== 'face') throw new ApiError(409, 'not_face', '대면 모드가 꺼져 있다', undefined, { key: 'err.not_face' });
    if (th.status !== 'open' || th.deleted_at) throw new ApiError(409, 'thread_closed');
    if (!(r.state === 'stopped' || this.faceStalled(r))) throw new ApiError(409, 'bad_state', `round is ${r.state}`);
    if (th.invoke_paused) throw new ApiError(409, 'invoke_paused', '새 호출 금지 중', undefined, { key: 'err.invoke_paused.paused' });
    const next = (r.next_agent as string | null) ?? (r.drafter as string);
    if (!this.s.membership(r.thread_id, next)?.can_read) throw new ApiError(409, 'face_members', `${next} 가 이 대화의 멤버가 아니다`, undefined, { key: 'err.face_members.next', vars: { agent: next } });
    const t = now();
    const me = pr.participant.id;
    const seq = this.s.db.transaction(() => {
      const info = this.s.db
        .prepare(
          `INSERT INTO messages(id, thread_id, author_id, client_key, body, source_kind, input_mode, recipients, hop, created_at)
           VALUES (?,?,?,?,?, 'instruction', 'text', ?, 0, ?)`,
        )
        .run(newId('msg'), r.thread_id, me, `face-retry:${roundId}:${t}`, tr(this.s.lang(), 'srv.face.retry', { turn: (r.turn as number) + 1, name: this.s.nameOf(next) }), JSON.stringify([next]), t);
      const seq = Number(info.lastInsertRowid);
      this.s.tags.attach(seq, { primary: [], inline: [] }); // 스레드 고정 태그(#1937)
      this.s.db
        .prepare(`INSERT INTO deliveries(id, message_seq, thread_id, recipient_id, status, attempts, created_at, updated_at) VALUES (?,?,?,?, 'pending', 0, ?, ?)`)
        .run(newId('dlv'), seq, r.thread_id, next, t, t);
      this.s.db.prepare("UPDATE face_rounds SET state = 'running', stop_reason = NULL, next_agent = ?, turn_seq = ?, updated_at = ? WHERE id = ?").run(next, seq, t, roundId);
      this.s.db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(t, r.thread_id);
      this.s.audit({ actor: this.s.actorOf(pr), action: 'face.retry', target_type: 'face_round', target_id: roundId, thread_id: r.thread_id, result: 'ok', before: { state: r.state, stop_reason: r.stop_reason ?? null }, after: { state: 'running', to: next, seq } });
      return seq;
    })();
    this.s.emit({ notice: { t: 'msg', thread_id: r.thread_id, seq }, threadId: r.thread_id });
    this.s.emit({ notice: { t: 'delivery', thread_id: r.thread_id }, threadId: r.thread_id, only: next });
    const nr = this.faceRow(roundId)!;
    this.faceEmit(nr);
    return { ok: true as const, round: this.faceOut(nr), seq };
  }
}
