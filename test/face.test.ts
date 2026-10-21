// 대면 모드(2026-10-19 마스터 #579·#581 · 마이그레이션 16) — 가운데 합의문을 초안 쪽·검토 쪽이 번갈아 고친다(진행자 없음)
//   교대 순서 · 4턴 무변경 = 합의 · 4턴 변경 → 6턴 확장 → 상한 · 쟁점(초안 수정은 아님 · 상대가 고친 줄 재수정 = 쟁점 · 되돌림 표시) ·
//   질문 멈춤 → 마스터 답 → 물은 쪽 재개 · 합의문 블록 없음 = 멈춤 · 안건 결정이 합의문 줄 교체 · 권한 · 마이그레이션(옛 스레드 mode=chat)
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { buildPrompt } from '../adapter/openclaw-channel/src/mapping.js';
import { migrate, SCHEMA_VERSION } from '../src/db.js';
import { applyTurn, diffLines, parseFaceAnswer, replaceIssueLines, type LineOrigin } from '../src/face.js';
import { FACE_RULE, type ClaimFace, type Message } from '../src/protocol.js';
import { newThread, post, setup, type Ctx } from './helpers.js';

const doc = (note: string, lines: string[]) => `${note}\n\n\`\`\`합의문\n${lines.join('\n')}\n\`\`\`\n\n답변시각:`;

describe('대면 — 순수 계산', () => {
  test('parseFaceAnswer: 블록 = 합의문 전체 · 밖 = 해설 · 끝줄 질문이 먼저 · 블록 없음 = none', () => {
    const a = parseFaceAnswer(doc('B 를 고침 — 까닭', ['A', 'B  ', '']));
    assert.deepEqual(a, { kind: 'doc', doc: 'A\nB', note: 'B 를 고침 — 까닭' });
    assert.deepEqual(parseFaceAnswer('```합의문\nX\n```\n질문: 범위는?\n\n답변시각:'), { kind: 'question', question: '범위는?' });
    assert.deepEqual(parseFaceAnswer('동의합니다'), { kind: 'none' });
  });

  test('diffLines: 바뀐 덩어리', () => {
    assert.deepEqual(diffLines(['a', 'b', 'c'], ['a', 'B', 'c', 'd']), [
      { aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 },
      { aStart: 3, aEnd: 3, bStart: 3, bEnd: 4 },
    ]);
    assert.deepEqual(diffLines(['a'], ['a']), []);
  });

  test('applyTurn: 초안 줄 수정은 검토 · 상대가 고친 줄 재수정은 쟁점 · 자기 옛 문장이면 되돌림', () => {
    let id = 0;
    const base = { other: 'v', openIssues: new Set<string>(), myPastLines: new Set<string>(), limitTurn: false, newIssueId: () => `i${++id}`, otherSeq: 10, mySeq: 11 };
    const draft: LineOrigin[] = [{ by: 'b', rev: 1, draft: true }, { by: 'b', rev: 1, draft: true }];
    const t2 = applyTurn({ ...base, me: 'v', other: 'b', prevDoc: 'X\nY', prevOrigins: draft, newDoc: 'X2\nY', rev: 2, turn: 2, otherPrevRev: 1 });
    assert.equal(t2.issueOps.length, 0, '초안 줄을 고친 것은 쟁점 아님');
    assert.equal(t2.changed, 2);
    assert.deepEqual(t2.origins[0], { by: 'v', rev: 2 });
    // 백구가 비전이 고친 줄을 다른 문장으로 → 쟁점(되돌림 아님)
    const t3 = applyTurn({ ...base, me: 'b', prevDoc: 'X2\nY', prevOrigins: t2.origins, newDoc: 'X3\nY', rev: 3, turn: 3, otherPrevRev: 2 });
    assert.equal(t3.issueOps.length, 1);
    const op = t3.issueOps[0] as Extract<(typeof t3.issueOps)[number], { op: 'new' }>;
    assert.equal(op.kind, 'contested');
    assert.deepEqual(op.versions.map((v) => [v.by, v.text, !!v.revert]), [['v', 'X2', false], ['b', 'X3', false]]);
    // 자기 옛 문장으로 → 되돌림 표시
    const t3b = applyTurn({ ...base, me: 'b', myPastLines: new Set(['X', 'Y']), prevDoc: 'X2\nY', prevOrigins: t2.origins, newDoc: 'X\nY', rev: 3, turn: 3, otherPrevRev: 2 });
    assert.equal((t3b.issueOps[0] as any).versions[1].revert, true);
    assert.equal(t3b.origins[0].issue, (t3b.issueOps[0] as any).id);
    // 열린 안건 줄을 또 고치면 그 안건에 판 하나 더
    const iid = (t3b.issueOps[0] as any).id;
    const t4 = applyTurn({ ...base, me: 'v', other: 'b', openIssues: new Set([iid]), prevDoc: 'X\nY', prevOrigins: t3b.origins, newDoc: 'X4\nY', rev: 4, turn: 4, otherPrevRev: 3 });
    assert.deepEqual(t4.issueOps.map((o) => [o.op, o.id]), [['append', iid]]);
    assert.equal(t4.origins[0].issue, iid);
    // 상한 턴: 바뀐 덩어리는 전부 안건(limit)
    const t6 = applyTurn({ ...base, me: 'v', other: 'b', prevDoc: 'X\nY', prevOrigins: draft, newDoc: 'X\nY6', rev: 6, turn: 6, otherPrevRev: 5, limitTurn: true });
    assert.equal((t6.issueOps[0] as any).kind, 'limit');
    // 안건 결정: 묶인 줄을 갈아 끼움
    const r = replaceIssueLines('X\nY', t3b.origins, iid, '마스터 X', 'master', 5);
    assert.equal(r.doc, '마스터 X\nY');
    assert.deepEqual(r.origins[0], { by: 'master', rev: 5, decided: iid });
  });

  test('buildPrompt: 대면 턴이면 규약 · 턴 k/4(→6) · 지금 합의문 · 상대가 고친 줄 · 열린 안건', () => {
    const parts = new Map([['master', { id: 'master', name: '마스터', kind: 'human' as const, is_master: true }]]);
    const m = { seq: 5, id: 'm5', thread_id: 't', author_id: 'master', body: '지시', source_kind: 'instruction', recipients: [], handoff_to: [] } as unknown as Message;
    const face: ClaimFace = {
      round_id: 'face_x', turn: 2, role: 'reviewer', other: { id: 'baekgu', name: '백구' }, base_turns: 4, max_turns: 6,
      doc: 'A\nB', rev: 1, changed_by_other: ['B'], open_issues: [{ n: 1, lines: ['A'] }], resumed_question: null,
    };
    const p = buildPrompt({ threadTitle: 'T', generation: 1, newMessages: [m], triggerSeq: 5, participants: parts, selfId: 'vision', face });
    assert.ok(p.includes(FACE_RULE));
    assert.ok(p.includes('턴 2/4(→6)') && p.includes('너는 검토자') && p.includes('상대: 백구'));
    assert.ok(p.includes('```합의문\nA\nB\n```'));
    assert.ok(p.includes('> B') && p.includes('⚑ 안건 1'));
    assert.ok(!buildPrompt({ threadTitle: 'T', generation: 1, newMessages: [m], triggerSeq: 5, participants: parts, selfId: 'vision' }).includes('대면 모드'));
  });
});

describe('대면 — 서버 흐름', () => {
  let ctx: Ctx;
  before(async () => {
    ctx = await setup({ faceDrafter: 'alpha', faceReviewer: 'beta' });
  });
  after(async () => ctx.close());

  const claim = async (who: string) => (await ctx.agent(who, 'POST', '/api/adapter/claim', { worker: `${who}-t` })).json.claim;
  /** 한 턴: claim → ack → start → complete */
  async function turn(who: string, body: string) {
    const c = await claim(who);
    assert.ok(c, `${who} 차례여야 함`);
    await ctx.agent(who, 'POST', `/api/adapter/deliveries/${c.delivery.id}/ack`, { lease_token: c.delivery.lease_token });
    await ctx.agent(who, 'POST', `/api/adapter/runs/${c.run.id}/start`, { run_token: c.run.run_token });
    const r = await ctx.agent(who, 'POST', `/api/adapter/runs/${c.run.id}/complete`, { run_token: c.run.run_token, body });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return c;
  }
  const face = async (th: string) => (await ctx.master('GET', `/api/threads/${th}/face`)).json;
  const made: string[] = [];
  async function faceThread(title: string) {
    // 앞 시험의 라운드가 남긴 배달이 claim 에 섞이지 않게 — 모드를 꺼서 멈추고 배달을 거둔다
    for (const old of made.splice(0)) await ctx.master('POST', `/api/threads/${old}/mode`, { mode: 'chat' });
    const th = await newThread(ctx, title, null, ['alpha', 'beta']);
    made.push(th);
    const r = await ctx.master('POST', `/api/threads/${th}/mode`, { mode: 'face' });
    assert.equal(r.status, 200);
    assert.equal(r.json.thread.mode, 'face');
    return th;
  }

  test('교대 순서 · 4턴 무변경 = 합의 · 승인(정산 줄)', async () => {
    const th = await faceThread('대면 합의');
    // 마스터가 받는 이를 골라도 서버가 정한다 — 늘 초안 쪽부터
    await post(ctx, th, '개선안을 정리해', { recipients: ['beta'] });
    assert.equal(await claim('beta'), null, '검토 쪽은 아직 차례가 아님');
    const c1 = await turn('alpha', doc('초안', ['A', 'B', 'C']));
    assert.deepEqual([c1.face.turn, c1.face.role, c1.face.doc], [1, 'drafter', null]);
    let f = await face(th);
    assert.deepEqual([f.round.state, f.round.turn, f.round.rev, f.round.next_agent, f.round.doc], ['running', 1, 1, 'beta', 'A\nB\nC']);
    assert.equal(await claim('alpha'), null, '초안 쪽은 다음 차례가 아님');
    const c2 = await turn('beta', doc('B 를 고침', ['A', 'B2', 'C']));
    assert.deepEqual([c2.face.turn, c2.face.role, c2.face.doc, c2.face.other.id], [2, 'reviewer', 'A\nB\nC', 'alpha']);
    const c3 = await turn('alpha', doc('C 를 고침', ['A', 'B2', 'C3']));
    assert.deepEqual(c3.face.changed_by_other, ['B2'], '상대가 직전 턴에 고친 줄을 알린다');
    f = await face(th);
    assert.equal(f.issues.length, 0, '초안 줄 수정 · 서로 다른 줄 → 쟁점 없음');
    const c4 = await turn('beta', doc('고칠 것 없음', ['A', 'B2', 'C3']));
    assert.equal(c4.face.turn, 4);
    f = await face(th);
    assert.deepEqual([f.round.state, f.round.turn, f.round.next_agent], ['agreed', 4, null]);
    assert.ok(f.round.ended_at);
    assert.equal(f.revs.length, 4);
    assert.equal(f.revs[3].changed, 0);
    const msgs = (await ctx.master('GET', `/api/threads/${th}/messages`)).json.messages;
    assert.deepEqual(msgs.slice(1).map((m: any) => [m.author_id, m.body]), [['alpha', '초안'], ['beta', 'B 를 고침'], ['alpha', 'C 를 고침'], ['beta', '고칠 것 없음']], '블록 밖 해설만 글로');
    assert.equal(await claim('alpha'), null, '합의 뒤엔 배달 없음');
    const v = await ctx.master('POST', `/api/face/${f.round.id}/verdict`, { verdict: 'approve', note: '정산: 2026-11-01 · 실패율' });
    assert.equal(v.status, 200);
    assert.deepEqual([v.json.round.state, v.json.round.verdict_note], ['approved', '정산: 2026-11-01 · 실패율']);
    assert.equal((await ctx.master('POST', `/api/face/${f.round.id}/verdict`, { verdict: 'reject' })).status, 409);
  });

  test('2턴 무변경도 합의', async () => {
    const th = await faceThread('대면 2턴 합의');
    await post(ctx, th, '짧게');
    await turn('alpha', doc('초안', ['한 줄']));
    await turn('beta', doc('좋음', ['한 줄  ']));
    const f = await face(th);
    assert.deepEqual([f.round.state, f.round.turn], ['agreed', 2], '줄 끝 공백만 다르면 안 바꾼 것');
  });

  test('4턴 변경 → 6턴 확장 → 상한 · 마지막 턴에 바뀐 줄 = 안건 · 다 정해야 승인', async () => {
    const th = await faceThread('대면 상한');
    await post(ctx, th, '길게');
    const lines = ['L1'];
    await turn('alpha', doc('초안', lines));
    for (let k = 2; k <= 6; k++) {
      lines.push(`L${k}`); // 매 턴 새 줄 하나(남의 줄은 안 건드림)
      const who = k % 2 === 0 ? 'beta' : 'alpha';
      const c = await turn(who, doc(`턴 ${k}`, lines));
      assert.equal(c.face.turn, k);
      const f = await face(th);
      if (k === 4) assert.deepEqual([f.round.state, f.round.next_agent], ['running', 'alpha'], '4턴에 바뀌었으면 5턴으로 확장');
      if (k < 6) assert.equal(f.issues.length, 0);
    }
    const f = await face(th);
    assert.deepEqual([f.round.state, f.round.turn], ['limit', 6]);
    assert.equal(f.issues.length, 1);
    assert.equal(f.issues[0].kind, 'limit');
    assert.deepEqual(f.issues[0].versions.map((v: any) => [v.by, v.text]), [['alpha', ''], ['beta', 'L6']]);
    assert.equal(await claim('alpha'), null, '상한 뒤엔 배달 없음');
    const ap = await ctx.master('POST', `/api/face/${f.round.id}/verdict`, { verdict: 'approve' });
    assert.deepEqual([ap.status, ap.json.error], [409, 'issues_open']);
    const d = await ctx.master('POST', `/api/face/${f.round.id}/issues/${f.issues[0].id}/decide`, { pick: 1 });
    assert.equal(d.status, 200);
    assert.equal((await ctx.master('POST', `/api/face/${f.round.id}/verdict`, { verdict: 'approve' })).json.round.state, 'approved');
  });

  test('쟁점: 상대가 고친 줄 재수정(되돌림 표시) → 안건 · 진행은 계속 · 또 고치면 판 추가 · 마스터 결정이 줄 교체', async () => {
    const th = await faceThread('대면 쟁점');
    await post(ctx, th, '쟁점 시험');
    await turn('alpha', doc('초안', ['X', 'Y']));
    await turn('beta', doc('X 수정', ['X2', 'Y']));
    let f = await face(th);
    assert.equal(f.issues.length, 0, '초안 줄을 고친 것은 검토');
    await turn('alpha', doc('X 는 원래대로', ['X', 'Y']));
    f = await face(th);
    assert.equal(f.issues.length, 1);
    const iss = f.issues[0];
    assert.deepEqual([iss.n, iss.kind, iss.state], [1, 'contested', 'open']);
    assert.deepEqual(iss.versions.map((v: any) => [v.by, v.text, !!v.revert]), [['beta', 'X2', false], ['alpha', 'X', true]]);
    assert.ok(iss.versions[0].seq && iss.versions[1].seq, '각 판의 해설 글');
    assert.deepEqual([f.round.state, f.round.next_agent], ['running', 'beta'], '쟁점이 나와도 진행은 안 멈춘다');
    const c4 = await claim('beta');
    assert.deepEqual(c4.face.open_issues, [{ n: 1, lines: ['X'] }]);
    await ctx.agent('beta', 'POST', `/api/adapter/runs/${c4.run.id}/start`, { run_token: c4.run.run_token });
    await ctx.agent('beta', 'POST', `/api/adapter/runs/${c4.run.id}/complete`, { run_token: c4.run.run_token, body: doc('X 다시', ['X4', 'Y']) });
    f = await face(th);
    assert.equal(f.issues.length, 1);
    assert.equal(f.issues[0].versions.length, 3, '열린 안건 줄을 또 고치면 판 하나 더');
    const d = await ctx.master('POST', `/api/face/${f.round.id}/issues/${iss.id}/decide`, { text: '마스터의 X' });
    assert.equal(d.status, 200);
    assert.equal(d.json.round.doc, '마스터의 X\nY');
    assert.equal(d.json.issue.state, 'decided');
    f = await face(th);
    assert.equal(f.revs.at(-1).author_id, 'master');
    assert.equal((await ctx.master('POST', `/api/face/${f.round.id}/issues/${iss.id}/decide`, { pick: 0 })).json.error, 'already_decided');
  });

  test('질문 → 멈춤 → 마스터 답 → 물은 쪽이 같은 턴을 이어 받는다', async () => {
    const th = await faceThread('대면 질문');
    await post(ctx, th, '질문 시험');
    await turn('alpha', doc('초안', ['P']));
    await turn('beta', '검토 전에 확인할 것\n질문: 범위가 host-a 만인가?\n\n답변시각:');
    let f = await face(th);
    assert.deepEqual([f.round.state, f.round.question, f.round.question_by, f.round.turn], ['question', '범위가 host-a 만인가?', 'beta', 1], '질문 턴은 안 셈');
    assert.equal(await claim('alpha'), null);
    assert.equal(await claim('beta'), null, '마스터 답 전엔 아무도 안 깨운다');
    await post(ctx, th, 'host-a 만');
    const c = await turn('beta', doc('범위 반영', ['P (host-a)']));
    assert.deepEqual([c.face.turn, c.face.resumed_question, c.trigger.body], [2, '범위가 host-a 만인가?', 'host-a 만']);
    f = await face(th);
    assert.deepEqual([f.round.state, f.round.turn, f.round.question, f.round.next_agent], ['running', 2, null, 'alpha']);
  });

  test('합의문 블록 없음 = 멈춤 → 다시 돌리기(같은 쪽 같은 턴) · 실행 실패 = 멈춤', async () => {
    const th = await faceThread('대면 멈춤');
    await post(ctx, th, '멈춤 시험');
    await turn('alpha', '동의합니다');
    let f = await face(th);
    assert.deepEqual([f.round.state, f.round.stop_reason, f.round.turn], ['stopped', 'no_doc', 0]);
    assert.equal(await claim('beta'), null);
    const rt = await ctx.master('POST', `/api/face/${f.round.id}/retry`);
    assert.equal(rt.status, 200);
    const c = await turn('alpha', doc('초안', ['Q']));
    assert.equal(c.face.turn, 1);
    f = await face(th);
    assert.deepEqual([f.round.state, f.round.next_agent], ['running', 'beta']);
    const c2 = await claim('beta');
    await ctx.agent('beta', 'POST', `/api/adapter/runs/${c2.run.id}/start`, { run_token: c2.run.run_token });
    await ctx.agent('beta', 'POST', `/api/adapter/runs/${c2.run.id}/fail`, { run_token: c2.run.run_token, error: 'boom' });
    f = await face(th);
    assert.deepEqual([f.round.state, f.round.stop_reason], ['stopped', 'run_failed']);
    assert.equal((await ctx.master('POST', `/api/face/${f.round.id}/retry`)).status, 200);
    assert.equal((await claim('beta')).face.turn, 2);
  });

  test('모드 끄기 → 도는 라운드 멈춤·배달 거둠 · 다시 켜고 글 → 새 라운드', async () => {
    const th = await faceThread('대면 끄기');
    await post(ctx, th, '끄기 시험');
    let f = await face(th);
    assert.equal(f.round.state, 'running');
    const off = await ctx.master('POST', `/api/threads/${th}/mode`, { mode: 'chat' });
    assert.deepEqual([off.status, off.json.thread.mode], [200, 'chat']);
    f = await face(th);
    assert.deepEqual([f.mode, f.round.state, f.round.stop_reason], ['chat', 'stopped', 'mode_off']);
    assert.equal(await claim('alpha'), null, '배달 거둠');
    await ctx.master('POST', `/api/threads/${th}/mode`, { mode: 'face' });
    await post(ctx, th, '다시');
    f = await face(th);
    assert.equal(f.rounds.length, 2);
    assert.equal(f.round.state, 'running');
    assert.equal((await claim('alpha')).face.turn, 1);
  });

  test('권한: 모드·결정·판정·멈추기·다시 돌리기는 마스터만 · 멤버 아니면 409 · 방은 409', async () => {
    const th = await faceThread('대면 권한');
    await post(ctx, th, '권한');
    const f = await face(th);
    for (const [m, p, b] of [
      ['POST', `/api/threads/${th}/mode`, { mode: 'chat' }],
      ['POST', `/api/face/${f.round.id}/issues/x/decide`, { text: 'x' }],
      ['POST', `/api/face/${f.round.id}/verdict`, { verdict: 'approve' }],
      ['POST', `/api/face/${f.round.id}/stop`, {}],
      ['POST', `/api/face/${f.round.id}/retry`, {}],
    ] as const) {
      const r = await ctx.agent('alpha', m, p, b);
      assert.equal(r.status, 403, `${p} → 403`);
    }
    assert.equal((await ctx.agent('alpha', 'GET', `/api/threads/${th}/face`)).status, 200, '멤버는 볼 수 있다');
    const solo = await newThread(ctx, '알파만', null, ['alpha']);
    const r = await ctx.master('POST', `/api/threads/${solo}/mode`, { mode: 'face' });
    assert.deepEqual([r.status, r.json.error], [409, 'face_members']);
    const room = (await ctx.master('GET', '/api/threads')).json.threads.find((t: any) => t.kind === 'room');
    assert.equal((await ctx.master('POST', `/api/threads/${room.id}/mode`, { mode: 'face' })).json.error, 'room_locked');
    assert.equal((await ctx.master('POST', `/api/threads/${th}/mode`, { mode: 'x' })).status, 400);
    const st = await ctx.master('POST', `/api/face/${f.round.id}/stop`);
    assert.deepEqual([st.status, st.json.round.state, st.json.round.stop_reason], [200, 'stopped', 'master_stop']);
  });
});

test('마이그레이션 16 — 스키마 15 의 옛 스레드는 mode=chat · 대면 표 셋', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-mig16-'));
  const db = new Database(path.join(dir, 'x.db'));
  db.pragma('foreign_keys = ON');
  migrate(db, 15);
  db.prepare("INSERT INTO participants(id, kind, name, is_master, created_at) VALUES ('master','human','m',1,0)").run();
  db.prepare("INSERT INTO threads(id, title, created_by, created_at, updated_at) VALUES ('th_old','옛','master',0,0)").run();
  migrate(db);
  assert.ok(SCHEMA_VERSION >= 16);
  assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  assert.deepEqual({ ...(db.prepare("SELECT id, title, mode FROM threads WHERE id = 'th_old'").get() as any) }, { id: 'th_old', title: '옛', mode: 'chat' });
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'face_%' ORDER BY name").all() as any[]).map((r) => r.name);
  assert.deepEqual(tables, ['face_issues', 'face_revs', 'face_rounds']);
  assert.throws(() => db.prepare("UPDATE threads SET mode = 'x' WHERE id = 'th_old'").run(), /CHECK/);
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  db.close();
});
