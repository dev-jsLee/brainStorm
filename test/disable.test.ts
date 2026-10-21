// 참여자 끄기(2026-10-19 마스터 #441 «메티를 비활성화하고 숨겨둬»)
//   토큰 폐기 · 멤버 해제 · 기본 수신자 비움 · 목록에서 빠짐 · 옛 글 이름은 남음 · 마스터 불가 · 두 번이면 noop
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { newThread, post, setup, type Ctx } from './helpers.js';

describe('참여자 끄기', () => {
  let ctx: Ctx;
  before(async () => {
    ctx = await setup();
  });
  after(async () => {
    await ctx.close();
  });

  test('끄면 들어오는 길과 보이는 자리가 걷히고 글은 남는다', async () => {
    const th = await newThread(ctx, '끄기 시험', 'beta', ['alpha', 'beta']);
    const said = await ctx.agent('beta', 'POST', `/api/threads/${th}/messages`, { body: '베타의 옛 글', client_key: 'k-disable-1' });
    assert.ok(said.status < 300, JSON.stringify(said.json));
    await post(ctx, th, '마스터 글');

    const r = ctx.app.store.disableParticipant('beta');
    assert.equal(r.outcome, 'disabled');
    assert.ok(r.threads >= 1);
    assert.ok(r.credentials >= 1);

    // 토큰은 더 안 통한다
    assert.equal((await ctx.agent('beta', 'GET', '/api/me')).status, 401);
    // 목록·에이전트 화면에서 빠지고, 이름 사전에는 disabled 로 남는다
    assert.ok(!ctx.app.store.listParticipants().some((p) => p.id === 'beta'));
    const all = (await ctx.master('GET', '/api/participants')).json.participants;
    assert.deepEqual(all.find((p: any) => p.id === 'beta'), { id: 'beta', kind: 'agent', name: 'BETA', is_master: false, disabled: true });
    assert.ok(!(await ctx.master('GET', '/api/agents')).json.agents.some((a: any) => a.id === 'beta'));
    // 스레드 멤버·기본 수신자에서 빠지고 옛 글은 그대로
    const t = (await ctx.master('GET', `/api/threads/${th}`)).json;
    assert.ok(!t.members.some((m: any) => m.participant_id === 'beta'));
    assert.equal(t.thread.default_recipient, null);
    const ms = (await ctx.master('GET', `/api/threads/${th}/messages`)).json;
    assert.ok((ms.messages ?? ms).some((m: any) => m.author_id === 'beta' && m.body === '베타의 옛 글'));
    // 끈 에이전트에게는 보낼 수 없다
    await assert.rejects(post(ctx, th, '베타에게', { recipients: ['beta'] }), /post 400 .*bad_recipient/);
    // 분기해도 끈 참여자는 안 딸려 간다 — 새 스레드 멤버로도 못 넣는다
    assert.equal((await ctx.master('POST', '/api/threads', { title: 'x', members: ['beta'], client_key: 'k-disable-2' })).status, 400);
  });

  test('두 번 끄면 noop · 마스터는 못 끈다 · 없는 id 는 404', () => {
    assert.equal(ctx.app.store.disableParticipant('beta').outcome, 'already_disabled');
    assert.throws(() => ctx.app.store.disableParticipant('master'), /마스터는 끌 수 없다/);
    assert.throws(() => ctx.app.store.disableParticipant('nobody'), /no_participant/);
  });
});

// 참여자 완전 삭제(2026-10-19 마스터 #447 «oc-main은 완전 정리해»)
//   꺼진 참여자만 · 남은 글이 있으면 거절(그 스레드를 먼저 영구 삭제) · 지우면 행과 딸린 행이 사라지고 감사는 남는다
describe('참여자 완전 삭제', () => {
  let ctx: Ctx;
  before(async () => {
    ctx = await setup();
  });
  after(async () => {
    await ctx.close();
  });

  test('끄기 전·글이 남았을 때는 거절 · 스레드를 지운 뒤에는 흔적 없이 지운다', async () => {
    const th = await newThread(ctx, '지울 시험', 'beta', ['alpha', 'beta']);
    const said = await ctx.agent('beta', 'POST', `/api/threads/${th}/messages`, { body: '베타 글', client_key: 'k-purge-1' });
    assert.ok(said.status < 300, JSON.stringify(said.json));
    await post(ctx, th, '베타에게', { recipients: ['beta'] });

    assert.throws(() => ctx.app.store.purgeParticipant('beta'), /not_disabled|먼저 participant disable/);
    ctx.app.store.disableParticipant('beta');
    assert.throws(() => ctx.app.store.purgeParticipant('beta'), /남은 글이 있는 스레드/);

    assert.equal((await ctx.master('POST', `/api/threads/${th}/state`, { action: 'trash' })).status, 200);
    assert.equal((await ctx.master('POST', `/api/threads/${th}/purge`, { confirm: '지울 시험' })).status, 200);

    const r = ctx.app.store.purgeParticipant('beta');
    assert.equal(r.outcome, 'purged');
    assert.ok(r.removed.credentials >= 1);
    const db = ctx.app.db;
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM participants WHERE id = 'beta'").get() as any).n, 0);
    for (const [t, c] of [['credentials', 'participant_id'], ['thread_members', 'participant_id'], ['deliveries', 'recipient_id'], ['runs', 'agent_id'], ['agent_sessions', 'agent_id']])
      assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${c} = 'beta'`).get() as any).n, 0, t);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.ok(!(await ctx.master('GET', '/api/participants')).json.participants.some((p: any) => p.id === 'beta'));
    assert.ok((db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'participant.purge' AND target_id = 'beta'").get() as any).n === 1);
    // 다른 참여자는 멀쩡하다
    assert.ok(ctx.app.store.listParticipants().some((p) => p.id === 'alpha'));
    assert.throws(() => ctx.app.store.purgeParticipant('master'), /마스터는 지울 수 없다/);
    assert.throws(() => ctx.app.store.purgeParticipant('beta'), /no_participant/);
  });
});
