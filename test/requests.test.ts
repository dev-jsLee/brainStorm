// 요청 창구(2026-10-16 마스터 #352 · 마이그레이션 14) — 에이전트 간 «요청»(출처 request)
//   끝줄 «요청→ 이름» 떼기 · 허용 짝이면 바로 배달 · 목록 밖 403/넘김 버튼 · 새 호출 금지 · 연쇄 상한(마스터 글이 초기화) ·
//   보류(«보류: 사유») → 답 글 없음·request_holds·요청자 안 깨움 · 마스터 확인 · 프롬프트 규약 · 스키마 13 → 14(옛 행 그대로)
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { buildPrompt } from '../adapter/openclaw-channel/src/mapping.js';
import { migrate, SCHEMA_VERSION } from '../src/db.js';
import type { Message } from '../src/protocol.js';
import { CLI_ACTOR, parseHandoff, parseHold, parsePull, parseRequest, type Principal } from '../src/store.js';
import { ANSWER_STAMP_RE, REQUEST_RULE, renderHoldNotices, stripAnswerStamp } from '../src/protocol.js';
import { newThread, post, setup, type Ctx } from './helpers.js';

const C = [
  { id: 'beta', name: 'BETA' },
  { id: 'gamma', name: '감마' },
];

describe('요청·보류 신호 떼기', () => {
  test('parseRequest: 끝줄 요청→ 이름 / 요청 -> id / 꾸밈 · 받는 이 둘이면 요청 아님(넘김으로)', () => {
    assert.deepEqual(parseRequest('조사 결과\n요청→ BETA', C), { body: '조사 결과', to: 'beta', matched: ['beta'], raw: '요청→ BETA' });
    assert.equal(parseRequest('답\n\n요청 -> beta\n', C).to, 'beta');
    assert.equal(parseRequest('답\n**요청→ 감마**', C).to, 'gamma');
    const two = parseRequest('답\n요청→ BETA, 감마', C);
    assert.equal(two.to, null);
    assert.deepEqual(two.matched, ['beta', 'gamma']);
    assert.equal(two.body, '답');
  });
  test('parseRequest: 못 찾은 이름 · 본문 중간 · 신호만 · «→ 이름»은 그대로', () => {
    assert.deepEqual(parseRequest('답\n요청→ 없음', C), { body: '답\n요청→ 없음', to: null, matched: [], raw: '요청→ 없음' });
    assert.equal(parseRequest('요청→ BETA\n끝', C).raw, null);
    assert.equal(parseRequest('요청→ BETA', C).to, null);
    assert.equal(parseRequest('답\n→ BETA', C).raw, null);
  });
  test('답변시각 도장 줄 뒤의 끝줄 신호도 읽는다(보류·요청·넘김·끌어오기) · 도장은 떼인 본문에 안 남음', () => {
    for (const stamp of ['답변시각:', '답변시각: workspace · 261019 10:00', '*답변시각: x*', '---\n답변시각:']) {
      const tail = `\n\n${stamp}\n`;
      assert.deepEqual(parseHold(`설명\n보류: 범위 밖${tail}`), { reason: '범위 밖', note: '설명' }, stamp);
      assert.deepEqual(parseRequest(`조사 결과\n요청→ BETA${tail}`, C), { body: '조사 결과', to: 'beta', matched: ['beta'], raw: '요청→ BETA' }, stamp);
      assert.deepEqual(parseHandoff(`답\n→ BETA${tail}`, C), { body: '답', handoff_to: ['beta'], raw: '→ BETA' }, stamp);
      const pl = parsePull(`답\n← 다른 방${tail}`, [{ id: 'th_x', title: '다른 방' }], () => null);
      assert.equal(pl.pull?.thread_id, 'th_x', stamp);
      assert.equal(pl.body, '답', stamp);
    }
    // 도장만 있는 답 · 본문 중간의 «답변시각:» 은 신호 자리를 바꾸지 않는다
    assert.equal(parseHold('답변시각:'), null);
    assert.equal(parseHold('보류: x\n본문에 답변시각: 이라는 글자가 있는 줄'), null);
    assert.equal(stripAnswerStamp('보류: 범위 밖\n\n답변시각:'), '보류: 범위 밖');
    assert.ok(ANSWER_STAMP_RE.test('답변시각：'));
  });
  test('parseHold: 끝줄 보류: 사유 · 설명은 note · 사유 없으면 보류 아님', () => {
    assert.deepEqual(parseHold('이건 마스터가 막은 일\n보류: 마스터 방향과 어긋남'), { reason: '마스터 방향과 어긋남', note: '이건 마스터가 막은 일' });
    assert.deepEqual(parseHold('보류： 부당'), { reason: '부당', note: null });
    assert.equal(parseHold('보류 — 범위 밖')?.reason, '범위 밖');
    assert.equal(parseHold('보류:'), null);
    assert.equal(parseHold('보류: x\n그리고 답'), null);
  });
});

test('마이그레이션 15 — 스키마 14 의 request_holds 옛 행 그대로 · notified_run_id 는 null(다음 실행에 한 번 실린다)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-mig15-'));
  const db = new Database(path.join(dir, 'x.db'));
  db.pragma('foreign_keys = ON');
  migrate(db, 14);
  db.prepare("INSERT INTO participants(id, kind, name, is_master, created_at) VALUES ('master','human','m',1,0)").run();
  db.prepare("INSERT INTO threads(id, title, created_by, created_at, updated_at) VALUES ('th_old','옛','master',0,0)").run();
  db.prepare("INSERT INTO request_holds(id, thread_id, request_seq, requester_id, recipient_id, kind, reason, note, run_id, created_at) VALUES ('h1','th_old',3,'vision','baekgu','held','옛 사유','옛 설명','run_x',5)").run();
  migrate(db);
  assert.ok(SCHEMA_VERSION >= 15);
  assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  assert.deepEqual(
    { ...(db.prepare('SELECT id, request_seq, requester_id, recipient_id, kind, reason, note, run_id, created_at, acked_at, notified_run_id FROM request_holds').get() as any) },
    { id: 'h1', request_seq: 3, requester_id: 'vision', recipient_id: 'baekgu', kind: 'held', reason: '옛 사유', note: '옛 설명', run_id: 'run_x', created_at: 5, acked_at: null, notified_run_id: null },
  );
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  db.close();
});

describe('어댑터 프롬프트(요청)', () => {
  const parts = new Map([
    ['master', { id: 'master', name: '마스터', kind: 'human' as const, is_master: true }],
    ['vision', { id: 'vision', name: '비전', kind: 'agent' as const }],
  ]);
  const m = (seq: number, author: string, source_kind: string) =>
    ({ seq, id: `m${seq}`, thread_id: 't', author_id: author, body: `b${seq}`, source_kind, recipients: [], handoff_to: [] }) as unknown as Message;
  test('요청 원인이면 «요청 — 지시 아님» 머리말 · 규약은 턴마다 · 출처 표시 «요청»', () => {
    const p = buildPrompt({ threadTitle: 'T', generation: 1, newMessages: [m(1, 'master', 'instruction'), m(2, 'vision', 'request')], triggerSeq: 2, participants: parts, selfId: 'baekgu' });
    assert.match(p, /비전이\(가\) 너에게 보낸 «요청»이다 — 지시가 아니다/);
    assert.match(p, /#2 비전 · 요청/);
    assert.match(p, /`보류: 사유`/);
    assert.match(p, /`요청→ 이름`/);
    const q = buildPrompt({ threadTitle: 'T', generation: 1, newMessages: [m(1, 'master', 'instruction')], triggerSeq: 1, participants: parts, selfId: 'baekgu' });
    assert.match(q, /마지막\(▶\) 메시지에 답하라/);
    assert.match(q, /`요청→ 이름`/); // 규약은 늘 실린다 — 마스터 지시 턴에서도 짝에게 요청할 수 있다
    assert.doesNotMatch(q, /보류됨/);
  });
  test('요청 규약: 실행 권한 없음 · 요청 쓰는 꼴(근거·질문·원하는 판단) 안내 · 보류 알림 줄', () => {
    assert.match(REQUEST_RULE, /요청은 실행 권한을 주지 않으며, 실행 여부는 받은 쪽이 마스터의 방향 안에서 정한다/);
    assert.match(REQUEST_RULE, /근거 · 질문 · 원하는 판단\(반영 · 반박 · 추가 조사 필요 중 하나\)/);
    assert.equal(renderHoldNotices([]), '');
    assert.equal(renderHoldNotices(null), '');
    assert.equal(renderHoldNotices([{ hold_id: 'h', request_seq: 7 }]), '[알림] 네 요청 #7은 보류됨(사유는 마스터가 봄).');
    const p = buildPrompt({ threadTitle: 'T', generation: 2, newMessages: [m(1, 'master', 'instruction')], triggerSeq: 1, participants: parts, selfId: 'baekgu', holdNotices: [{ hold_id: 'h', request_seq: 7 }] });
    assert.match(p, /네 요청 #7은 보류됨\(사유는 마스터가 봄\)/);
    assert.ok(p.indexOf('보류됨') < p.indexOf('▶ #1')); // 머리말 안
  });
});

describe('요청 창구 API', () => {
  let ctx: Ctx;
  const CHAIN = 3;
  before(async () => {
    ctx = await setup({ requestChainMax: CHAIN });
    const s = ctx.app.store;
    s.createParticipant('gamma', 'agent', 'GAMMA');
    ctx.tokens.gamma = s.createToken('gamma', { label: 'test' });
    const cli: Principal = { participant: s.getMaster()!, via: 'cookie', scopes: ['admin'], actor: CLI_ACTOR };
    s.setRequestPair(cli, 'alpha', 'beta', true);
    s.setRequestPair(cli, 'beta', 'alpha', true);
  });
  after(async () => ctx.close());

  const A = (who: string, p: string, b: unknown = {}) => ctx.agent(who, 'POST', p, b);
  const msgs = async (th: string) => (await ctx.master('GET', `/api/threads/${th}/messages`)).json.messages as any[];
  const dels = async (th: string) => (await ctx.master('GET', `/api/threads/${th}/deliveries`)).json.deliveries as any[];
  const db = () => ctx.app.store['db'];
  async function claimStart(who: string) {
    const c = (await A(who, '/api/adapter/claim', { worker: 'manual' })).json.claim;
    assert.ok(c, `${who}: 받을 전달 없음`);
    await A(who, `/api/adapter/deliveries/${c.delivery.id}/ack`, { lease_token: c.delivery.lease_token });
    assert.equal((await A(who, `/api/adapter/runs/${c.run.id}/start`, { run_token: c.run.run_token })).status, 200);
    return c;
  }
  async function finish(who: string, c: any, body: string) {
    const r = await A(who, `/api/adapter/runs/${c.run.id}/complete`, { run_token: c.run.run_token, body });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json;
  }
  async function turn(who: string, body: string) {
    const c = await claimStart(who);
    return { claim: c, ...(await finish(who, c, body)) };
  }
  const room = (title: string) => newThread(ctx, title, null, ['alpha', 'beta', 'gamma']);
  const nothingFor = async (who: string) => (await A(who, '/api/adapter/claim', { worker: 'manual' })).json.claim === null;

  test('허용 짝: 끝줄 요청→ 이 바로 배달 · 출처 request · 받는 쪽 claim 원인 · 감사 request.create', async () => {
    const th = await room('왕복');
    await post(ctx, th, '조사해', { recipients: ['alpha'] });
    const a = await turn('alpha', '조사 결과 셋\n요청→ BETA');
    assert.equal(a.message.body, '조사 결과 셋');
    assert.equal(a.message.source_kind, 'request');
    assert.deepEqual(a.message.recipients, ['beta']);
    assert.deepEqual(a.message.handoff_to, []);
    const d = (await dels(th)).filter((x) => x.message_seq === a.message.seq);
    assert.equal(d.length, 1);
    assert.equal(d[0].recipient_id, 'beta');
    assert.equal(d[0].forwarded_by, null);
    const b = await claimStart('beta');
    assert.equal(b.trigger.seq, a.message.seq);
    assert.equal(b.trigger.source_kind, 'request');
    await finish('beta', b, '검증함 — 둘은 맞고 하나는 틀림');
    assert.ok(await nothingFor('alpha')); // 요청 없는 답은 요청자에게 안 간다
    const au = db().prepare("SELECT result, actor_id FROM audit_log WHERE action = 'request.create' AND target_id = ?").get(String(a.message.seq)) as any;
    assert.deepEqual({ ...au }, { result: 'ok', actor_id: 'alpha' });
    const ev = db().prepare("SELECT event FROM run_events WHERE run_id = ? ORDER BY id").all(a.claim.run.id).map((x: any) => x.event);
    assert.ok(ev.includes('request_sent'));
  });

  test('목록 밖: 끝줄은 넘김 버튼으로 떨어짐(감사 denied) · 직접 게시 403 · 짝 아닌 recipients 403 · 마스터는 request 못 씀', async () => {
    const th = await room('목록 밖');
    await post(ctx, th, '조사해', { recipients: ['alpha'] });
    const a = await turn('alpha', '결과\n요청→ GAMMA');
    assert.equal(a.message.source_kind, 'proposal');
    assert.deepEqual(a.message.handoff_to, ['gamma']);
    assert.equal(a.message.body, '결과');
    assert.equal((await dels(th)).filter((x) => x.message_seq === a.message.seq).length, 0);
    const den = db().prepare("SELECT reason FROM audit_log WHERE action = 'request.create' AND result = 'denied' ORDER BY id DESC").get() as any;
    assert.equal(den.reason, 'request_pair_not_allowed');
    const r1 = await ctx.agent('alpha', 'POST', `/api/threads/${th}/messages`, { client_key: 'rq-x', body: '감마 봐줘', source_kind: 'request', recipients: ['gamma'] });
    assert.equal(r1.status, 403);
    assert.equal(r1.json.error, 'request_pair_not_allowed');
    const r2 = await ctx.agent('alpha', 'POST', `/api/threads/${th}/messages`, { client_key: 'rq-y', body: '베타', recipients: ['beta'] });
    assert.equal(r2.json.error, 'agent_invocation_disabled');
    const r3 = await ctx.agent('alpha', 'POST', `/api/threads/${th}/messages`, { client_key: 'rq-z', body: '둘', source_kind: 'request', recipients: ['beta', 'gamma'] });
    assert.equal(r3.status, 400);
    const r4 = await ctx.master('POST', `/api/threads/${th}/messages`, { client_key: 'rq-m', body: '마스터', source_kind: 'request', recipients: ['beta'] });
    assert.equal(r4.status, 403);
    // 어댑터가 출처 request 를 스스로 달 수는 없다
    await post(ctx, th, '또', { recipients: ['alpha'] });
    const c = await claimStart('alpha');
    const bad = await A('alpha', `/api/adapter/runs/${c.run.id}/complete`, { run_token: c.run.run_token, body: 'x', source_kind: 'request' });
    assert.equal(bad.status, 403);
    await finish('alpha', c, '정상 답');
    // 직접 게시 요청(허용 짝) → 배달 하나
    const ok = await ctx.agent('alpha', 'POST', `/api/threads/${th}/messages`, { client_key: 'rq-ok', body: '베타 이것 검증해 줘', source_kind: 'request', recipients: ['beta'] });
    assert.equal(ok.status, 201, JSON.stringify(ok.json));
    assert.equal(ok.json.deliveries.length, 1);
    const b = await claimStart('beta');
    assert.equal(b.trigger.seq, ok.json.message.seq);
    await finish('beta', b, '했음');
  });

  test('새 호출 금지: 끝줄 요청은 넘김 버튼으로(배달 없음) · 직접 게시 409', async () => {
    const th = await room('멈춤');
    await post(ctx, th, '조사해', { recipients: ['alpha'] });
    const c = await claimStart('alpha');
    assert.equal((await ctx.master('POST', `/api/threads/${th}/stop`, { mode: 'stop_new' })).status, 200);
    const a = await finish('alpha', c, '결과\n요청→ BETA');
    assert.equal(a.message.source_kind, 'proposal');
    assert.deepEqual(a.message.handoff_to, ['beta']);
    assert.equal((await dels(th)).filter((x) => x.message_seq === a.message.seq).length, 0);
    const ev = db().prepare("SELECT detail FROM run_events WHERE run_id = ? AND event = 'request_refused'").get(c.run.id) as any;
    assert.equal(JSON.parse(ev.detail).reason, 'invoke_paused');
    const r = await ctx.agent('alpha', 'POST', `/api/threads/${th}/messages`, { client_key: 'rq-p', body: 'x', source_kind: 'request', recipients: ['beta'] });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'invoke_paused');
    await ctx.master('POST', `/api/threads/${th}/resume`);
  });

  test(`연쇄 상한(${CHAIN}): 넘으면 요청을 만들지 않고 «마스터 확인 필요»(chain_limit) · 마스터 글이 연쇄를 새로 시작`, async () => {
    const th = await room('고리');
    await post(ctx, th, '둘이 끝까지 따져 봐', { recipients: ['alpha'] });
    let who = 'alpha';
    for (let i = 1; i <= CHAIN; i++) {
      const next = who === 'alpha' ? 'beta' : 'alpha';
      const r = await turn(who, `라운드 ${i}\n요청→ ${next}`);
      assert.equal(r.message.source_kind, 'request', `라운드 ${i}`);
      who = next;
    }
    assert.equal(ctx.app.store.requestChainDepth(th), CHAIN);
    const over = await turn(who, `라운드 ${CHAIN + 1}\n요청→ ${who === 'alpha' ? 'beta' : 'alpha'}`);
    assert.equal(over.message.source_kind, 'proposal');
    assert.equal(over.message.handoff_to.length, 1); // 마스터가 «전달»로 이어 갈 수 있다
    assert.equal((await dels(th)).filter((x) => x.message_seq === over.message.seq).length, 0);
    assert.ok(await nothingFor('alpha'));
    assert.ok(await nothingFor('beta'));
    const d = (await ctx.master('GET', `/api/threads/${th}`)).json;
    const h = d.request_holds.find((x: any) => x.kind === 'chain_limit');
    assert.ok(h);
    assert.equal(h.request_seq, over.message.seq);
    assert.equal(h.reason, 'request_chain_limit');
    assert.equal(h.acked_at, null);
    // 직접 게시도 상한 — 409 + 한 줄 더
    const direct = await ctx.agent('alpha', 'POST', `/api/threads/${th}/messages`, { client_key: 'rq-lim', body: '하나만 더', source_kind: 'request', recipients: ['beta'] });
    assert.equal(direct.status, 409);
    assert.equal(direct.json.error, 'request_chain_limit');
    assert.equal((await ctx.master('GET', `/api/threads/${th}/request-holds`)).json.holds.filter((x: any) => x.kind === 'chain_limit').length, 2);
    // 마스터가 글을 쓰면 새로 센다
    await post(ctx, th, '좋아, 한 번 더', { recipients: ['beta'] });
    assert.equal(ctx.app.store.requestChainDepth(th), 0);
    const again = await turn('beta', '다시\n요청→ ALPHA');
    assert.equal(again.message.source_kind, 'request');
    const a = await claimStart('alpha');
    assert.equal(a.trigger.seq, again.message.seq);
    await finish('alpha', a, '끝');
  });

  test('보류: 답 글 없음 · request_holds 한 줄 · 요청자 안 깨움 · 재전송 멱등 · 받은 요청까지 본 것으로 · 마스터 확인', async () => {
    const th = await room('보류');
    await post(ctx, th, '조사해', { recipients: ['alpha'] });
    const a = await turn('alpha', '이 서버 꺼도 됨\n요청→ BETA');
    const before = (await msgs(th)).length;
    const b = await claimStart('beta');
    const r = await A('beta', `/api/adapter/runs/${b.run.id}/complete`, { run_token: b.run.run_token, body: '끄는 건 마스터가 막은 일이다\n보류: 마스터 방향과 어긋남(서버 끄기는 마스터 몫)' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.message, null);
    assert.equal(r.json.held.kind, 'held');
    assert.equal(r.json.held.reason, '마스터 방향과 어긋남(서버 끄기는 마스터 몫)');
    assert.equal(r.json.held.note, '끄는 건 마스터가 막은 일이다');
    assert.equal(r.json.run.state, 'succeeded');
    assert.equal(r.json.run.result_seq, null);
    assert.equal((await msgs(th)).length, before); // 스레드에 안 올라감
    assert.ok(await nothingFor('alpha')); // 요청한 쪽을 안 깨움
    const dup = await A('beta', `/api/adapter/runs/${b.run.id}/complete`, { run_token: b.run.run_token, body: '보류: 다시' });
    assert.equal(dup.json.duplicate, true);
    assert.equal(dup.json.held.id, r.json.held.id);
    const d = (await ctx.master('GET', `/api/threads/${th}`)).json;
    assert.deepEqual(
      d.request_holds.map((h: any) => [h.kind, h.request_seq, h.requester_id, h.recipient_id]),
      [['held', a.message.seq, 'alpha', 'beta']],
    );
    const au = db().prepare("SELECT result, actor_id, after_state FROM audit_log WHERE action = 'request.hold'").all() as any[];
    assert.equal(au.length, 1);
    assert.doesNotMatch(au[0].after_state, /어긋남|막은/); // 감사에 본문·사유 글 없음
    // 다음 턴: 보류한 요청은 이미 본 것
    await post(ctx, th, '베타, 그럼 다른 방법은?', { recipients: ['beta'] });
    const b2 = await claimStart('beta');
    assert.ok(b2.session.seen_seq >= a.message.seq);
    await finish('beta', b2, '보류: 이건 요청이 아니라 마스터 글이라 그냥 답'); // 요청이 아닌 실행의 «보류:» 는 보통 답
    const last = (await msgs(th)).at(-1);
    assert.equal(last.author_id, 'beta');
    assert.match(last.body, /^보류: /);
    // 에이전트는 목록·확인 못 함
    assert.equal((await ctx.agent('beta', 'GET', `/api/threads/${th}/request-holds`)).status, 403);
    assert.equal((await ctx.agent('beta', 'POST', `/api/request-holds/${r.json.held.id}/ack`)).status, 403);
    assert.equal((await ctx.agent('beta', 'GET', `/api/threads/${th}`)).json.request_holds, undefined);
    // 마스터 확인 → 머리에서 빠짐 · 두 번째는 noop
    const k = await ctx.master('POST', `/api/request-holds/${r.json.held.id}/ack`);
    assert.equal(k.json.outcome, 'acked');
    assert.ok(k.json.hold.acked_at);
    assert.equal((await ctx.master('POST', `/api/request-holds/${r.json.held.id}/ack`)).json.outcome, 'already_acked');
    assert.equal((await ctx.master('POST', '/api/request-holds/rqh_none/ack')).status, 404);
    const acks = db().prepare("SELECT result FROM audit_log WHERE action = 'request.hold_ack' ORDER BY id").all().map((x: any) => x.result);
    assert.deepEqual(acks, ['denied', 'ok', 'noop']); // 에이전트 시도는 거부로 남는다
  });

  test('보류 알림: 요청자가 그 스레드에서 처음 불리는 실행 한 번에만 · 사유 없음 · 받은 쪽·다른 에이전트·다른 스레드엔 없음 · 세대가 바뀌어도 한 번', async () => {
    const th = await room('보류 알림');
    const other = await room('보류 알림 옆방');
    await post(ctx, th, '조사해', { recipients: ['alpha'] });
    const a = await turn('alpha', '이 서버 꺼도 됨\n요청→ BETA');
    const b = await claimStart('beta');
    assert.equal((await finish('beta', b, '보류: 비밀사유-끄기는 마스터 몫\n\n답변시각:')).held.kind, 'held'); // 도장 뒤의 보류도 보류
    assert.ok(await nothingFor('alpha')); // 보류는 요청자를 새로 깨우지 않는다
    // 받은 쪽(beta)·다른 에이전트(gamma)·다른 스레드의 alpha 실행에는 안 실린다
    await post(ctx, th, '베타 다른 일', { recipients: ['beta'] });
    const b2 = await claimStart('beta');
    assert.deepEqual(b2.hold_notices, []);
    await finish('beta', b2, '했음');
    await post(ctx, th, '감마 봐', { recipients: ['gamma'] });
    const g = await claimStart('gamma');
    assert.deepEqual(g.hold_notices, []);
    await finish('gamma', g, '봤음');
    await post(ctx, other, '옆방 알파', { recipients: ['alpha'] });
    const ao = await claimStart('alpha');
    assert.deepEqual(ao.hold_notices, []);
    await finish('alpha', ao, '옆방 답');
    // 요청자가 그 스레드에서 처음 불리는 실행: 알림 한 줄 · 사유는 안 실린다
    await post(ctx, th, '알파 다음 일', { recipients: ['alpha'] });
    const a2 = await claimStart('alpha');
    assert.equal(a2.hold_notices.length, 1);
    assert.equal(a2.hold_notices[0].request_seq, a.message.seq);
    assert.doesNotMatch(JSON.stringify(a2), /비밀사유/);
    const prompt = buildPrompt({
      threadTitle: a2.thread.title, generation: a2.session.generation, newMessages: a2.context, triggerSeq: a2.trigger.seq,
      participants: new Map(), selfId: 'alpha', holdNotices: a2.hold_notices,
    });
    assert.match(prompt, new RegExp(`네 요청 #${a.message.seq}은 보류됨\\(사유는 마스터가 봄\\)`));
    assert.doesNotMatch(prompt, /비밀사유/);
    // 같은 실행을 다시 claim(재전송)해도 같은 알림 — 이미 알린 실행이므로
    const hold = db().prepare("SELECT notified_run_id FROM request_holds WHERE thread_id = ? AND kind = 'held'").get(th) as any;
    assert.equal(hold.notified_run_id, a2.run.id);
    await finish('alpha', a2, '알겠음');
    // 다음 실행엔 다시 안 실린다
    await post(ctx, th, '알파 또', { recipients: ['alpha'] });
    const a3 = await claimStart('alpha');
    assert.deepEqual(a3.hold_notices, []);
    await finish('alpha', a3, '또 답');
    // 새 보류 뒤 세대가 바뀌어도 같은 규칙 — 새 세대의 첫 실행에 한 번
    await post(ctx, th, '알파 다시 물어 봐', { recipients: ['alpha'] });
    const q = await turn('alpha', '다시\n요청→ BETA\n\n답변시각: workspace · 261019 10:00');
    assert.deepEqual(q.claim.hold_notices, []);
    assert.equal(q.message.source_kind, 'request'); // 도장 뒤의 요청도 요청 · 게시 본문에서 도장은 걷힘
    assert.equal(q.message.body, '다시');
    const b3 = await claimStart('beta');
    await finish('beta', b3, '보류: 두 번째도 범위 밖');
    const rot = await ctx.master('POST', `/api/threads/${th}/sessions/rotate`, { agent_id: 'alpha', reason: '시험' });
    assert.equal(rot.status, 200, JSON.stringify(rot.json));
    await post(ctx, th, '알파 새 세대', { recipients: ['alpha'] });
    const a4 = await claimStart('alpha');
    assert.ok(a4.session.generation > a3.session.generation);
    assert.deepEqual(a4.hold_notices.map((h: any) => h.request_seq), [q.message.seq]);
    await finish('alpha', a4, '새 세대 답');
    await post(ctx, th, '알파 한 번 더', { recipients: ['alpha'] });
    const a5 = await claimStart('alpha');
    assert.deepEqual(a5.hold_notices, []);
    await finish('alpha', a5, '끝');
  });

  test('허용 짝 조회 · CLI 로 더하기/빼기(감사 cli:root) · 화면에서는 못 바꿈', async () => {
    const r = await ctx.agent('alpha', 'GET', '/api/request-pairs');
    assert.equal(r.status, 200);
    assert.equal(r.json.chain_max, CHAIN);
    const pairs = r.json.pairs.map((p: any) => `${p.from_id}>${p.to_id}`);
    for (const p of ['alpha>beta', 'beta>alpha']) assert.ok(pairs.includes(p), p);
    const s = ctx.app.store;
    const cli: Principal = { participant: s.getMaster()!, via: 'cookie', scopes: ['admin'], actor: CLI_ACTOR };
    assert.equal(s.setRequestPair(cli, 'alpha', 'gamma', true).changed, true);
    assert.equal(s.setRequestPair(cli, 'alpha', 'gamma', true).changed, false);
    assert.equal(s.setRequestPair(cli, 'alpha', 'gamma', false).changed, true);
    assert.throws(() => s.setRequestPair(cli, 'alpha', 'alpha', true));
    const rows = db().prepare("SELECT actor_id, result FROM audit_log WHERE action LIKE 'request_pair.%' AND target_id = 'alpha>gamma' ORDER BY id").all() as any[];
    assert.deepEqual(rows.map((x) => `${x.actor_id}:${x.result}`), ['cli:root:ok', 'cli:root:noop', 'cli:root:ok']);
    const agentPr: Principal = { participant: s.getParticipant('alpha')!, via: 'token', scopes: ['adapter'] };
    assert.throws(() => s.setRequestPair(agentPr, 'alpha', 'gamma', true), /master_only/);
  });
});

test('마이그레이션 14 — 스키마 13 의 옛 행 그대로 · source_kind CHECK 에 request 만 더함 · 허용 짝 두 줄', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-mig14-'));
  const db = new Database(path.join(dir, 'x.db'));
  db.pragma('foreign_keys = ON');
  migrate(db, 13);
  db.prepare("INSERT INTO participants(id, kind, name, is_master, created_at) VALUES ('master','human','m',1,0)").run();
  db.prepare("INSERT INTO participants(id, kind, name, created_at) VALUES ('vision','agent','비전',0)").run();
  db.prepare("INSERT INTO threads(id, title, created_by, created_at, updated_at) VALUES ('th_old','옛','master',0,0)").run();
  db.prepare("INSERT INTO messages(id, thread_id, author_id, client_key, body, source_kind, created_at) VALUES ('m1','th_old','master','k','옛 글','instruction',0)").run();
  db.prepare("INSERT INTO messages(id, thread_id, author_id, client_key, body, source_kind, reply_to_seq, created_at) VALUES ('m2','th_old','vision','k2','옛 답','proposal',1,0)").run();
  assert.throws(() => db.prepare("INSERT INTO messages(id, thread_id, author_id, client_key, body, source_kind, created_at) VALUES ('m3','th_old','vision','k3','x','request',0)").run());
  const seqBefore = (db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'messages'").get() as any).seq;
  migrate(db);
  assert.ok(SCHEMA_VERSION >= 14);
  assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  assert.deepEqual(
    db.prepare('SELECT id, body, source_kind, reply_to_seq FROM messages ORDER BY seq').all().map((r: any) => ({ ...r })),
    [
      { id: 'm1', body: '옛 글', source_kind: 'instruction', reply_to_seq: null },
      { id: 'm2', body: '옛 답', source_kind: 'proposal', reply_to_seq: 1 },
    ],
  );
  db.prepare("INSERT INTO messages(id, thread_id, author_id, client_key, body, source_kind, created_at) VALUES ('m3','th_old','vision','k3','요청','request',0)").run();
  assert.equal((db.prepare("SELECT seq FROM messages WHERE id = 'm3'").get() as any).seq, seqBefore + 1); // AUTOINCREMENT 이어짐
  assert.throws(() => db.prepare("INSERT INTO messages(id, thread_id, author_id, client_key, body, source_kind, created_at) VALUES ('m4','th_old','vision','k4','x','bogus',0)").run());
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.deepEqual(
    db.prepare('SELECT from_id, to_id, created_by FROM request_pairs ORDER BY from_id').all().map((r: any) => ({ ...r })),
    [],
  );
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM request_holds').get() as any).n, 0);
  assert.throws(() => db.prepare("INSERT INTO request_holds(id, thread_id, requester_id, recipient_id, kind, reason, created_at) VALUES ('h','th_old','a','b','weird','r',0)").run());
  db.close();
  // 다시 열어도(새 연결) 넓힌 CHECK 그대로
  const db2 = new Database(path.join(dir, 'x.db'));
  db2.prepare("INSERT INTO messages(id, thread_id, author_id, client_key, body, source_kind, created_at) VALUES ('m5','th_old','vision','k5','또','request',0)").run();
  db2.close();
});
