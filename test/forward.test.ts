// 수동 전달(2026-10-12 마스터 #62·#70 · vault Notes/brainStorm-수동-전달.md v2)
//   끝줄 «→ 이름» 떼기 · 마스터만 전달 · 새 메시지 없음 · 같은 대상 한 번 · 새 호출 금지면 거절 ·
//   지난 글 전달의 맥락(원인 뒤 ~ 누른 시점 머리) · seen 이 조용히 뛰지 않음 · 취소/중단 · 작성자 표식 · 자동 왕복 없음
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { buildPrompt, selectNewContext } from '../adapter/openclaw-channel/src/mapping.js';
import { loadAdapterConfig } from '../adapter/openai/config.js';
import { buildChatMessages, selectGenerationContext } from '../adapter/openai/mapping.js';
import { migrate, SCHEMA_VERSION } from '../src/db.js';
import type { Message } from '../src/protocol.js';
import { parseHandoff } from '../src/store.js';
import { newThread, post, setup, type Ctx } from './helpers.js';

const C = [
  { id: 'beta', name: 'BETA' },
  { id: 'gamma', name: '감마' },
];

describe('넘김 신호 떼기(parseHandoff)', () => {
  test('끝줄 → 이름 / -> id / 여럿 / 뒤 빈 줄', () => {
    assert.deepEqual(parseHandoff('답\n→ BETA', C), { body: '답', handoff_to: ['beta'], raw: '→ BETA' });
    assert.deepEqual(parseHandoff('답\n\n-> beta\n\n', C).handoff_to, ['beta']);
    assert.deepEqual(parseHandoff('답\n→ BETA, 감마', C).handoff_to, ['beta', 'gamma']);
    assert.equal(parseHandoff('답\n**→ 감마**', C).body, '답');
  });
  test('못 찾은 이름 · 본문 중간 · 신호만 있는 답은 그대로 둔다', () => {
    assert.deepEqual(parseHandoff('답\n→ 없는이름', C), { body: '답\n→ 없는이름', handoff_to: [], raw: '→ 없는이름' });
    assert.deepEqual(parseHandoff('→ BETA\n그리고 끝', C), { body: '→ BETA\n그리고 끝', handoff_to: [], raw: null });
    assert.deepEqual(parseHandoff('→ BETA', C).handoff_to, []);
    assert.equal(parseHandoff('→ BETA', C).body, '→ BETA');
  });
});

describe('어댑터 맥락(전달)', () => {
  const m = (seq: number, author = 'master', extra: Partial<Message> = {}) =>
    ({ seq, id: `m${seq}`, thread_id: 't', author_id: author, body: `b${seq}`, source_kind: 'instruction', recipients: [], handoff_to: [], ...extra }) as Message;
  test('openclaw-channel: seen 뒤 ~ upto 까지 · upto 없으면 옛 판 그대로', () => {
    const ctx = [m(1), m(2, 'alpha'), m(3), m(4)];
    assert.deepEqual(selectNewContext(ctx, { seen_seq: 3 }, 2, 4).map((x) => x.seq), [4]);
    assert.deepEqual(selectNewContext(ctx, { seen_seq: 1 }, 2, 4).map((x) => x.seq), [2, 3, 4]);
    assert.deepEqual(selectNewContext(ctx, { seen_seq: 1 }, 2).map((x) => x.seq), [2]);
  });
  test('openclaw-channel 프롬프트: 전달 머리말 · 제 글에만 넘김 표식', () => {
    const parts = new Map([
      ['master', { id: 'master', name: '마스터', kind: 'human' as const, is_master: true }],
      ['beta', { id: 'beta', name: 'BETA', kind: 'agent' as const }],
    ]);
    const msgs = [m(2, 'alpha', { source_kind: 'proposal', handoff_to: ['beta'], handoff_state: { beta: 'forwarded' } }), m(3, 'beta', { source_kind: 'proposal', handoff_to: ['alpha'] })];
    const p = buildPrompt({ threadTitle: 'T', generation: 1, newMessages: msgs, triggerSeq: 3, participants: parts, selfId: 'alpha', forwarded: true });
    assert.match(p, /«전달»한/);
    assert.match(p, /\[→ BETA · 전달됨\]/);
    assert.doesNotMatch(p, /→ alpha/); // 남의 신호는 안 보인다(서버가 뗐고 표식은 제 글에만)
    assert.match(p, /마지막 줄에만 `→ 이름`/);
    const q = buildPrompt({ threadTitle: 'T', generation: 1, newMessages: msgs, triggerSeq: 3, participants: parts, selfId: 'beta' });
    assert.doesNotMatch(q, /전달됨|· 대기\]/);
    assert.match(q, /마지막\(▶\) 메시지에 답하라/);
  });
  test('openai: 넘김 규약은 참여자별로 켠다(메티 켬 · Strata 끔) · 전달 표시 · 제 글 표식', () => {
    const tf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bs-ho-')), 'tok');
    fs.writeFileSync(tf, 'bst_x', { mode: 0o600 });
    const base = { BRAINSTORM_TOKEN_FILE: tf, OPENAI_BASE_URL: 'http://x/v1', OPENAI_MODEL: 'm' };
    assert.doesNotMatch(loadAdapterConfig([], base).systemPrompt, /→ 이름/);
    assert.match(loadAdapterConfig([], { ...base, BRAINSTORM_HANDOFF_RULE: '1' }).systemPrompt, /마지막 줄에만 `→ 이름`/);
    assert.match(loadAdapterConfig(['--handoff-rule'], base).systemPrompt, /→ 이름/);
    const parts = new Map([
      ['master', { id: 'master', name: '마스터', kind: 'human' as const, is_master: true }],
      ['beta', { id: 'beta', name: 'BETA', kind: 'agent' as const }],
    ]);
    const msgs = [m(0), m(1, 'meti', { source_kind: 'proposal', handoff_to: ['beta'], handoff_state: { beta: 'pending' } }), m(2), m(3, 'beta', { source_kind: 'proposal' })]; // 맨 앞 assistant 는 걷히므로 마스터 글부터
    const r = buildChatMessages({ system: 's', messages: msgs, triggerSeq: 3, selfId: 'meti', participants: parts as any, contextTokens: 8000, maxTokens: 500, forwarded: true });
    const text = r.messages.map((x) => x.content).join('\n---\n');
    assert.match(text, /\[→ BETA · 대기\]/);
    assert.match(text, /마스터가 이 글을 너에게 전달했다/);
    const r2 = buildChatMessages({ system: 's', messages: msgs, triggerSeq: 3, selfId: 'meti', participants: parts as any, contextTokens: 8000, maxTokens: 500 });
    assert.doesNotMatch(r2.messages.map((x) => x.content).join('\n'), /전달했다/);
  });
  test('openai: 전달이면 원인을 맨 뒤로(chat 은 마지막에 답한다)', () => {
    const ctx = [m(1), m(2, 'alpha'), m(3), m(4)];
    assert.deepEqual(selectGenerationContext(ctx, { base_seq: null }, ctx[1], 4).map((x) => x.seq), [1, 3, 4, 2]);
    assert.deepEqual(selectGenerationContext(ctx, { base_seq: null }, ctx[1]).map((x) => x.seq), [1, 2]);
  });
});

describe('수동 전달 API', () => {
  let ctx: Ctx;
  before(async () => {
    ctx = await setup();
  });
  after(async () => ctx.close());

  const A = (who: string, p: string, b: unknown = {}) => ctx.agent(who, 'POST', p, b);
  const msgs = async (th: string) => (await ctx.master('GET', `/api/threads/${th}/messages`)).json.messages as any[];
  const dels = async (th: string) => (await ctx.master('GET', `/api/threads/${th}/deliveries`)).json.deliveries as any[];
  const fwd = (th: string, seq: number, recipient: string, note?: string) => ctx.master('POST', `/api/threads/${th}/messages/${seq}/forward`, note === undefined ? { recipient } : { recipient, note });
  /** 전달 하나를 받아 시작까지 */
  async function claimStart(who: string) {
    const c = (await A(who, '/api/adapter/claim', { worker: 'manual' })).json.claim;
    assert.ok(c, `${who}: 받을 전달 없음`);
    await A(who, `/api/adapter/deliveries/${c.delivery.id}/ack`, { lease_token: c.delivery.lease_token });
    assert.equal((await A(who, `/api/adapter/runs/${c.run.id}/start`, { run_token: c.run.run_token })).status, 200);
    return c;
  }
  async function turn(who: string, body: string, extra: Record<string, unknown> = {}) {
    const c = await claimStart(who);
    const r = await A(who, `/api/adapter/runs/${c.run.id}/complete`, { run_token: c.run.run_token, body, ...extra });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return { claim: c, message: r.json.message };
  }
  async function room(title: string) {
    return newThread(ctx, title, null, ['alpha', 'beta']);
  }

  test('끝줄을 떼어 handoff_to 로 · 전달은 안 생긴다(자동 왕복 없음)', async () => {
    const th = await room('신호');
    await post(ctx, th, '질문', { recipients: ['alpha'] });
    const a = await turn('alpha', '알파 답\n→ BETA');
    assert.equal(a.message.body, '알파 답');
    assert.deepEqual(a.message.handoff_to, ['beta']);
    assert.equal((await dels(th)).filter((d) => d.message_seq === a.message.seq).length, 0);
    // 못 찾은 이름은 줄이 남는다
    await post(ctx, th, '다시', { recipients: ['alpha'] });
    const b = await turn('alpha', '두 번째\n→ 없는이름');
    assert.equal(b.message.body, '두 번째\n→ 없는이름');
    assert.deepEqual(b.message.handoff_to, []);
  });

  test('마스터 전달 → 배달 하나 · 새 메시지 없음 · 답은 원글에 · hop+1 · 받는 쪽 신호도 자동으로 안 간다', async () => {
    const th = await room('전달');
    await post(ctx, th, '질문', { recipients: ['alpha'] });
    const a = await turn('alpha', '알파 답\n→ BETA');
    const before = (await msgs(th)).length;
    const f = await fwd(th, a.message.seq, 'beta');
    assert.equal(f.status, 200, JSON.stringify(f.json));
    assert.equal(f.json.duplicate, false);
    assert.equal((await msgs(th)).length, before);
    const b = await turn('beta', '베타 답\n→ ALPHA', {}); // 옛 어댑터처럼 context_upto_seq 안 보냄
    assert.equal(b.claim.trigger.seq, a.message.seq);
    assert.deepEqual(b.claim.forward, { by: 'master', context_upto_seq: a.message.seq, note: null });
    assert.equal(b.message.reply_to_seq, a.message.seq);
    assert.equal(b.message.hop, a.message.hop + 1);
    assert.equal(b.claim.trigger.source_kind, 'proposal'); // 지시로 승격되지 않는다
    assert.deepEqual(b.message.handoff_to, ['alpha']);
    assert.equal((await dels(th)).filter((d) => d.message_seq === b.message.seq).length, 0);
    const d = (await dels(th)).find((x) => x.message_seq === a.message.seq);
    assert.equal(d.forwarded_by, 'master');
    assert.equal(d.run_state, 'succeeded');
    assert.ok(d.run_id);
    // 같은 대상 두 번 → 하나
    const again = await fwd(th, a.message.seq, 'beta');
    assert.equal(again.json.duplicate, true);
    assert.equal((await dels(th)).filter((x) => x.message_seq === a.message.seq).length, 1);
    // 감사 — 전달 하나 · 다시 누름(noop) 하나
    const rows = ctx.app.store['db'].prepare("SELECT result FROM audit_log WHERE action = 'message.forward' AND target_id = ?").all(String(a.message.seq)) as any[];
    assert.deepEqual(rows.map((r) => r.result).sort(), ['noop', 'ok']);
  });

  test('거절: 에이전트 토큰 · 마스터 글 · 작성자 자신 · 멤버 아님 · 새 호출 금지', async () => {
    const th = await room('거절');
    const q = await post(ctx, th, '질문', { recipients: ['alpha'] });
    const a = await turn('alpha', '알파 답');
    assert.equal((await ctx.agent('beta', 'POST', `/api/threads/${th}/messages/${a.message.seq}/forward`, { recipient: 'beta' })).status, 403);
    assert.equal((await fwd(th, q.message.seq, 'beta')).status, 400);
    assert.equal((await fwd(th, a.message.seq, 'alpha')).status, 400);
    assert.equal((await fwd(th, a.message.seq, 'master')).status, 400);
    const solo = await newThread(ctx, '알파만', null, ['alpha']);
    await post(ctx, solo, '질문', { recipients: ['alpha'] });
    const s = await turn('alpha', '혼자 답');
    assert.equal((await fwd(solo, s.message.seq, 'beta')).status, 400);
    assert.equal((await ctx.master('POST', `/api/threads/${th}/stop`, { mode: 'stop_new' })).status, 200);
    const p = await fwd(th, a.message.seq, 'beta');
    assert.equal(p.status, 409);
    assert.equal(p.json.error, 'invoke_paused');
    assert.equal((await dels(th)).filter((x) => x.message_seq === a.message.seq).length, 0);
    await ctx.master('POST', `/api/threads/${th}/resume`);
    assert.equal((await fwd(th, a.message.seq, 'beta')).status, 200);
    await turn('beta', '풀고 나서 답');
  });

  test('지난 글 전달: 맥락은 원인 뒤 ~ 누른 시점 머리 · 다음 턴에 빠지는 글 없음', async () => {
    const th = await room('지난 글');
    await post(ctx, th, 'q1', { recipients: ['alpha'] });
    const a1 = await turn('alpha', 'A1');
    await post(ctx, th, 'q2', { recipients: ['beta'] });
    const b1 = await turn('beta', 'B1'); // 베타는 A1 을 지나 B1 까지 봤다
    const m3 = await post(ctx, th, 'm3 그 뒤 대화'); // 수신 대상 없음 — 베타는 아직 못 봄
    await fwd(th, a1.message.seq, 'beta');
    const c = await claimStart('beta');
    assert.equal(c.trigger.seq, a1.message.seq);
    assert.equal(c.forward.context_upto_seq, m3.message.seq);
    assert.ok(c.session.seen_seq >= b1.message.seq);
    const sent = selectNewContext(c.context, c.session, c.trigger.seq, c.forward.context_upto_seq);
    assert.deepEqual(sent.map((m) => m.seq), [m3.message.seq]); // + 원인은 어댑터가 따로 붙인다
    const done = await A('beta', `/api/adapter/runs/${c.run.id}/complete`, { run_token: c.run.run_token, body: 'B2', context_upto_seq: c.forward.context_upto_seq });
    assert.equal(done.status, 200);
    const m4 = await post(ctx, th, 'm4', { recipients: ['beta'] });
    const c2 = await claimStart('beta');
    assert.equal(c2.session.seen_seq, m3.message.seq); // 보낸 데까지만 본 것 — 답 seq 로 뛰지 않는다
    const next = selectNewContext(c2.context, c2.session, c2.trigger.seq).map((m) => m.seq);
    assert.ok(next.includes(m4.message.seq));
    assert.ok(!next.includes(m3.message.seq));
    await A('beta', `/api/adapter/runs/${c2.run.id}/complete`, { run_token: c2.run.run_token, body: 'B3' });
  });

  test('누른 뒤 ~ claim 전에 들어온 글: 이번 맥락엔 없고(머리는 누른 때로 얼림) 다음 턴에 빠짐없이 온다(메티 #75)', async () => {
    const th = await room('대기 중 새 글');
    await post(ctx, th, 'q1', { recipients: ['alpha'] });
    const a1 = await turn('alpha', 'A1');
    await post(ctx, th, 'q2', { recipients: ['beta'] });
    await turn('beta', 'B1');
    const f = await fwd(th, a1.message.seq, 'beta');
    const head = f.json.delivery.context_upto_seq;
    const late = await post(ctx, th, '누른 뒤에 들어온 글'); // 베타가 아직 안 집었다
    const c = await claimStart('beta');
    assert.equal(c.forward.context_upto_seq, head);
    assert.ok(late.message.seq > head);
    assert.ok(!selectNewContext(c.context, c.session, c.trigger.seq, c.forward.context_upto_seq).some((m) => m.seq === late.message.seq));
    await A('beta', `/api/adapter/runs/${c.run.id}/complete`, { run_token: c.run.run_token, body: 'B2', context_upto_seq: head });
    await post(ctx, th, 'q3', { recipients: ['beta'] });
    const c2 = await claimStart('beta');
    assert.equal(c2.session.seen_seq, head);
    assert.ok(selectNewContext(c2.context, c2.session, c2.trigger.seq).some((m) => m.seq === late.message.seq), '다음 턴에 온다');
    await A('beta', `/api/adapter/runs/${c2.run.id}/complete`, { run_token: c2.run.run_token, body: 'B3' });
  });

  test('옛 어댑터(되돌림 없음)면 원인까지만 본 것으로 — 그 뒤 글이 다음 턴에 다시 온다', async () => {
    const th = await room('옛 어댑터');
    await post(ctx, th, 'q1', { recipients: ['alpha'] });
    const a1 = await turn('alpha', 'A1');
    await post(ctx, th, 'q2', { recipients: ['beta'] });
    const b1 = await turn('beta', 'B1');
    const m3 = await post(ctx, th, 'm3');
    await fwd(th, a1.message.seq, 'beta');
    await turn('beta', 'B2'); // context_upto_seq 없음
    await post(ctx, th, 'm4', { recipients: ['beta'] });
    const c2 = await claimStart('beta');
    assert.equal(c2.session.seen_seq, b1.message.seq);
    assert.ok(selectNewContext(c2.context, c2.session, c2.trigger.seq).some((m) => m.seq === m3.message.seq));
    await A('beta', `/api/adapter/runs/${c2.run.id}/complete`, { run_token: c2.run.run_token, body: 'B3' });
  });

  test('되돌리기: 대기면 전달 취소 · 실행이 생겼으면 has_run → 실행 중단', async () => {
    const th = await room('되돌리기');
    await post(ctx, th, 'q', { recipients: ['alpha'] });
    const a = await turn('alpha', 'A');
    const f = await fwd(th, a.message.seq, 'beta');
    const x = await ctx.master('POST', `/api/deliveries/${f.json.delivery.id}/cancel`);
    assert.equal(x.json.outcome, 'cancelled');
    assert.equal((await A('beta', '/api/adapter/claim', { worker: 'w' })).json.claim, null);
    // 거둔 전달은 다시 보낼 수 있다(실행이 안 생겼으므로)
    const re = await fwd(th, a.message.seq, 'beta');
    assert.equal(re.json.duplicate, false);
    assert.equal(re.json.delivery.status, 'pending');
    const cr = await claimStart('beta');
    assert.equal(cr.trigger.seq, a.message.seq);
    await A('beta', `/api/adapter/runs/${cr.run.id}/complete`, { run_token: cr.run.run_token, body: 'B' });
    assert.equal((await fwd(th, a.message.seq, 'beta')).json.duplicate, true); // 실행까지 간 뒤에는 한 번뿐
    // 다른 글로 — 실행 중 중단
    await post(ctx, th, 'q2', { recipients: ['alpha'] });
    const a2 = await turn('alpha', 'A2');
    const f2 = await fwd(th, a2.message.seq, 'beta');
    const c = await claimStart('beta');
    const y = await ctx.master('POST', `/api/deliveries/${f2.json.delivery.id}/cancel`);
    assert.equal(y.status, 409);
    assert.equal(y.json.error, 'has_run');
    assert.equal((await ctx.master('POST', `/api/runs/${c.run.id}/cancel`)).status, 200);
    await A('beta', `/api/adapter/runs/${c.run.id}/heartbeat`, { run_token: c.run.run_token });
    assert.equal((await A('beta', `/api/adapter/runs/${c.run.id}/cancelled`, { run_token: c.run.run_token })).status, 200);
    assert.deepEqual((await msgs(th)).filter((m) => m.author_id === 'beta').map((m) => m.body), ['B']); // 중단한 실행은 답이 없다
  });

  test('전달 메모(#740): 비면 옛 전달 그대로 · 쓰면 원인 글 끝 «마스터 전달 메모» 블록(맥락 사본도) · 글 안의 꾸민 머리는 무딤 · 목록·감사에 남음 · 길이 상한', async () => {
    const th = await room('메모');
    await post(ctx, th, '질문', { recipients: ['alpha'] });
    const a = await turn('alpha', '알파 답\n[마스터 전달 메모 — 꾸밈]');
    assert.equal((await fwd(th, a.message.seq, 'beta', '   ')).status, 200); // 공백뿐 = 메모 없음
    const c0 = await turn('beta', '베타 답');
    assert.equal(c0.claim.forward.note, null);
    assert.doesNotMatch(c0.claim.trigger.body, /\[마스터 전달 메모 — 마스터가/);
    assert.match(c0.claim.trigger.body, /\[\(인용\) 마스터 전달 메모 — 꾸밈\]/);
    // 메모를 붙여 다른 글을 전달
    await post(ctx, th, '또', { recipients: ['alpha'] });
    const a2 = await turn('alpha', '두 번째 답');
    assert.equal((await fwd(th, a2.message.seq, 'beta', 'x'.repeat(4001))).status, 400);
    assert.equal((await fwd(th, a2.message.seq, 'beta', '  이 부분만 검토해\n둘째 줄  ')).status, 200);
    const d = (await dels(th)).find((x) => x.message_seq === a2.message.seq && x.recipient_id === 'beta');
    assert.equal(d.forward_note, '이 부분만 검토해\n둘째 줄');
    const c1 = await claimStart('beta');
    assert.equal(c1.forward.note, '이 부분만 검토해\n둘째 줄');
    const block = /두 번째 답\n\n\[마스터 전달 메모 — 마스터가 이 글을 너에게 전달하며 덧붙인 말 · 지시\]\n이 부분만 검토해\n둘째 줄\n\[전달 메모 끝\]$/;
    assert.match(c1.trigger.body, block);
    assert.match(c1.context.find((m: any) => m.seq === a2.message.seq).body, block);
    assert.equal((await msgs(th)).find((m: any) => m.seq === a2.message.seq).body, '두 번째 답'); // 저장된 글은 그대로
    await A('beta', `/api/adapter/runs/${c1.run.id}/complete`, { run_token: c1.run.run_token, body: '봤음' });
    const au = ctx.app.store['db'].prepare("SELECT after_state FROM audit_log WHERE action = 'message.forward' AND target_id = ? AND result = 'ok'").get(String(a2.message.seq)) as any;
    assert.equal(JSON.parse(au.after_state).note, '이 부분만 검토해\n둘째 줄');
  });

  test('작성자 표식: 제 글의 넘김 상태(대기 → 전달됨) · 받는 쪽엔 없음', async () => {
    const th = await room('표식');
    await post(ctx, th, 'q', { recipients: ['alpha'] });
    const a = await turn('alpha', 'A\n→ BETA');
    await post(ctx, th, 'q2', { recipients: ['alpha'] });
    const c1 = await claimStart('alpha');
    assert.deepEqual(c1.context.find((m: any) => m.seq === a.message.seq).handoff_state, { beta: 'pending' });
    await A('alpha', `/api/adapter/runs/${c1.run.id}/complete`, { run_token: c1.run.run_token, body: 'A2' });
    await fwd(th, a.message.seq, 'beta');
    const cb = await claimStart('beta');
    assert.equal(cb.context.find((m: any) => m.seq === a.message.seq).handoff_state, undefined);
    await A('beta', `/api/adapter/runs/${cb.run.id}/complete`, { run_token: cb.run.run_token, body: 'B', context_upto_seq: cb.forward.context_upto_seq });
    await post(ctx, th, 'q3', { recipients: ['alpha'] });
    const c3 = await claimStart('alpha');
    assert.deepEqual(c3.context.find((m: any) => m.seq === a.message.seq).handoff_state, { beta: 'forwarded' });
    await A('alpha', `/api/adapter/runs/${c3.run.id}/complete`, { run_token: c3.run.run_token, body: 'A3' });
  });
});

test('마이그레이션 7: 옛 메시지는 handoff_to=[] · 옛 전달은 forwarded_by=NULL · 옛 실행은 seen_upto=NULL', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-mig7-'));
  const db = new Database(path.join(dir, 'x.db'));
  db.pragma('foreign_keys = ON');
  migrate(db, 6);
  db.prepare("INSERT INTO participants(id, kind, name, is_master, created_at) VALUES ('master','human','m',1,0)").run();
  db.prepare("INSERT INTO participants(id, kind, name, is_master, created_at) VALUES ('a','agent','A',0,0)").run();
  db.prepare("INSERT INTO threads(id, title, created_by, created_at, updated_at) VALUES ('th_old','옛','master',0,0)").run();
  db.prepare(
    "INSERT INTO messages(id, thread_id, author_id, client_key, body, source_kind, input_mode, recipients, created_at) VALUES ('m1','th_old','master','k','옛 글','instruction','text','[\"a\"]',0)",
  ).run();
  const seq = (db.prepare('SELECT seq FROM messages').get() as any).seq;
  db.prepare("INSERT INTO deliveries(id, message_seq, thread_id, recipient_id, status, attempts, created_at, updated_at) VALUES ('d1',?,'th_old','a','pending',0,0,0)").run(seq);
  migrate(db);
  assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  assert.ok(SCHEMA_VERSION >= 7);
  assert.equal((db.prepare('SELECT handoff_to FROM messages').get() as any).handoff_to, '[]');
  assert.deepEqual({ ...(db.prepare('SELECT forwarded_by, context_upto_seq FROM deliveries').get() as any) }, { forwarded_by: null, context_upto_seq: null });
  assert.ok((db.prepare('PRAGMA table_info(runs)').all() as any[]).some((c) => c.name === 'seen_upto'));
  assert.equal((db.prepare('SELECT forward_note FROM deliveries').get() as any).forward_note, null); // 18 — 옛 전달은 메모 없음
  db.close();
});
