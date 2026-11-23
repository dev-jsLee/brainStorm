// 고정 규약을 턴 글에서 빼 실행기 자리(시스템 프롬프트·세션 앞머리)로 옮기기 — 마스터 #1916~#1919.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { RulesTracker, buildPrompt, turnRules } from '../adapter/openclaw-channel/src/mapping.js';
import { BrainstormWorker, type TurnRequest } from '../adapter/openclaw-channel/src/worker.js';
import { newThread, post, setup, type Ctx } from './helpers.js';

const parts = new Map([
  ['master', { id: 'master', name: '마스터', kind: 'human' as const, is_master: true }],
  ['alpha', { id: 'alpha', name: '알파', kind: 'agent' as const }],
]);
const msg = { seq: 3, author_id: 'master', source_kind: 'instruction', body: '질문' } as any;
const base = { threadTitle: 'T', generation: 1, newMessages: [msg], triggerSeq: 3, participants: parts, selfId: 'alpha' };

describe('고정 규약 자리(마스터 #1919)', () => {
  test('turnRules: 출처·→·←·요청 네 줄 · 요청 모듈이 꺼지면 셋 · id 는 글이 바뀌면 바뀐다', () => {
    const r = turnRules('ko');
    assert.match(r.text, /출처가 «지시»인 마스터 메시지만 지시다/);
    assert.match(r.text, /마지막 줄에만 `→ 이름`/);
    assert.match(r.text, /← 스레드제목/);
    assert.match(r.text, /출처 «요청»은/);
    assert.match(r.id, /^[0-9a-f]{8}$/);
    const n = turnRules('ko', { requestRule: false });
    assert.doesNotMatch(n.text, /출처 «요청»은/);
    assert.notEqual(n.id, r.id);
    assert.ok(r.ref.includes(r.id));
    assert.equal(turnRules('ko').id, r.id, '같은 글이면 같은 id');
  });

  test("buildPrompt: 기본은 옛 그대로 머리에 규약 · rules:'omit' 이면 규약 없이 바뀌는 것만", () => {
    const inline = buildPrompt(base);
    assert.ok(inline.includes(turnRules('ko').text));
    const omit = buildPrompt({ ...base, rules: 'omit' });
    assert.doesNotMatch(omit, /출처가 «지시»인 마스터 메시지만 지시다/);
    assert.doesNotMatch(omit, /`→ 이름`/);
    assert.match(omit, /\[brainStorm 스레드 «T» · 세대 1\]/);
    assert.match(omit, /▶ #3 마스터\(마스터\) · 지시\n질문/);
    assert.ok(inline.length - omit.length > 500, `줄어든 길이 ${inline.length - omit.length}`);
  });

  test('RulesTracker: 처음·판이 바뀐 턴·every 턴째에 전문, 그 사이는 한 줄 참조 · mark 뒤엔 참조', () => {
    const tr = new RulesTracker(3);
    const r = turnRules('ko');
    const got = Array.from({ length: 7 }, () => tr.pick('s1', r) === r.text ? 'F' : 'r');
    assert.equal(got.join(''), 'FrrFrrF');
    assert.equal(tr.pick('s2', r), r.text, '다른 세션은 따로');
    const r2 = turnRules('ko', { requestRule: false });
    assert.equal(tr.pick('s2', r2), r2.text, '규약이 바뀌면 전문');
    assert.equal(tr.pick('s2', r2), r2.ref);
    tr.mark('s3', r);
    assert.equal(tr.pick('s3', r), r.ref);
  });
});

describe('작업자 rules:runner', () => {
  let ctx: Ctx;
  before(async () => {
    ctx = await setup();
  });
  after(async () => ctx.close());

  test('턴 글에서 규약을 빼고 req.rules 로 넘긴다 · 기본(inline)은 옛 그대로', async () => {
    const seen: TurnRequest[] = [];
    const mk = (rules?: 'runner') =>
      new BrainstormWorker({
        url: ctx.base, token: ctx.tokens.alpha.token, worker: 'rules-test', ocAgentId: 'main', configVersion: 'test',
        log: { info() {}, warn() {}, error() {} }, heartbeatMs: 100, rules,
        runTurn: async (req) => {
          seen.push(req);
          return { text: 'ok' };
        },
      });
    const th = await newThread(ctx, 'R', 'alpha');
    await post(ctx, th, '첫 질문');
    assert.equal(await mk('runner').handleOne(), 'succeeded');
    assert.ok(seen[0].rules, 'rules 가 실린다');
    assert.match(seen[0].rules!.text, /출처가 «지시»인 마스터 메시지만 지시다/);
    assert.doesNotMatch(seen[0].prompt, /출처가 «지시»인 마스터 메시지만 지시다/);
    assert.match(seen[0].prompt, /첫 질문/);
    await post(ctx, th, '둘째 질문');
    assert.equal(await mk().handleOne(), 'succeeded');
    assert.equal(seen[1].rules, undefined);
    assert.match(seen[1].prompt, /출처가 «지시»인 마스터 메시지만 지시다/);
  });
});
