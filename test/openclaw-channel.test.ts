// OpenClaw 채널 플러그인의 변환·작업자 로직. OpenClaw 없이: 실제 brainStorm 서버 + 가짜 runTurn.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  buildPrompt,
  decodeKeyPart,
  describeActualModel,
  encodeKeyPart,
  parseSessionKey,
  redact,
  selectNewContext,
  sessionKeyFor,
  stripAnswerStamp,
} from '../adapter/openclaw-channel/src/mapping.js';
import { BrainstormWorker, type RunTurn, type TurnRequest } from '../adapter/openclaw-channel/src/worker.js';
import { newThread, post, setup, sleep, waitFor, type Ctx } from './helpers.js';

describe('OpenClaw 채널: 변환', () => {
  test('세션 키: (스레드, 에이전트, 세대) → 소문자로 접혀도 겹치지 않고 되돌릴 수 있다', () => {
    const a = sessionKeyFor('main', 'oc-main', 'th_aB-x_Q', 1);
    const b = sessionKeyFor('main', 'oc-main', 'th_Ab-x_q', 1);
    assert.equal(a, 'agent:main:bs:oc-main:th_a.b-x_.q:g1');
    assert.notEqual(a.toLowerCase(), b.toLowerCase(), 'OpenClaw 가 소문자로 접어도 두 스레드는 다른 세션');
    assert.equal(a, a.toLowerCase(), '키 자체가 이미 소문자');
    assert.deepEqual(parseSessionKey(a), { ocAgentId: 'main', bsAgentId: 'oc-main', threadId: 'th_aB-x_Q', generation: 1 });
    assert.notEqual(sessionKeyFor('main', 'oc-main', 'th_x', 1), sessionKeyFor('main', 'oc-main', 'th_x', 2), '세대가 바뀌면 새 세션');
    for (const id of ['th_j42t-Q-jUemM', 'th_luhKXltdDi60', 'oc-main', 'A_B-c']) assert.equal(decodeKeyPart(encodeKeyPart(id)), id);
    assert.throws(() => encodeKeyPart('th:evil'));
    assert.throws(() => sessionKeyFor('main', 'oc-main', 'th_x', 0));
  });

  test('답 위생: 끝의 «답변시각:» 줄만 걷는다', () => {
    assert.equal(stripAnswerStamp('답이다.\n\n답변시각: workspace · 260929 14:33'), '답이다.');
    assert.equal(stripAnswerStamp('답이다.\n---\n답변시각: x\n\n'), '답이다.');
    assert.equal(stripAnswerStamp('답이다.\n*답변시각: x*'), '답이다.');
    assert.equal(stripAnswerStamp('본문에 답변시각: 이라는 글자가 있다.\n끝.'), '본문에 답변시각: 이라는 글자가 있다.\n끝.');
    assert.equal(stripAnswerStamp('답변시각: 만 있다'), '');
    assert.equal(stripAnswerStamp('a\r\nb\r\n답변시각: y'), 'a\nb');
  });

  test('맥락 고르기: seen_seq 뒤, 원인까지', () => {
    const m = (seq: number) => ({ seq, body: `m${seq}` }) as any;
    const ctx = [m(1), m(2), m(3), m(4), m(5)];
    assert.deepEqual(selectNewContext(ctx, { seen_seq: null }, 4).map((x) => x.seq), [1, 2, 3, 4]);
    assert.deepEqual(selectNewContext(ctx, { seen_seq: 2 }, 4).map((x) => x.seq), [3, 4]);
  });

  test('프롬프트: 원인 표시, 출처 표시, 에이전트 이름 없음', () => {
    const parts = new Map([
      ['master', { id: 'master', name: '마스터', kind: 'human' as const, is_master: true }],
      ['oc-main', { id: 'oc-main', name: '새 에이전트(이름 미정)', kind: 'agent' as const }],
    ]);
    const p = buildPrompt({
      threadTitle: '시험',
      generation: 2,
      triggerSeq: 9,
      selfId: 'oc-main',
      participants: parts,
      newMessages: [
        { seq: 8, author_id: 'oc-main', source_kind: 'proposal', body: '이전 답' } as any,
        { seq: 9, author_id: 'master', source_kind: 'instruction', body: '질문' } as any,
      ],
    });
    assert.match(p, /세대 2/);
    assert.match(p, /▶ #9 마스터\(마스터\) · 지시\n질문/);
    assert.match(p, /#8 너\(이전 답\) · 제안/);
    assert.doesNotMatch(p, /새 에이전트/);
  });

  test('실제 모델 표기 · 가림', () => {
    assert.deepEqual(describeActualModel({ provider: 'anthropic', model: 'claude-opus-5-5', agentHarnessId: 'claude-cli' }), {
      runtime: 'openclaw/claude-cli',
      model: 'anthropic/claude-opus-5-5',
    });
    assert.deepEqual(describeActualModel(undefined), { runtime: null, model: null });
    const tok = 'bst_' + 'x'.repeat(43);
    assert.equal(redact(`token ${tok} run_abcDEF123456 Bearer abc.def`), 'token bst_*** run_abcDEF123456 Bearer ***');
  });
});

describe('OpenClaw 채널: 작업자 (가짜 턴)', () => {
  let ctx: Ctx;
  const quiet = { info() {}, warn() {}, error() {} };
  before(async () => {
    ctx = await setup();
  });
  after(async () => ctx.close());

  const runs = async (th: string) => (await ctx.master('GET', `/api/threads/${th}/runs`)).json.runs as any[];
  const msgs = async (th: string) => (await ctx.master('GET', `/api/threads/${th}/messages`)).json.messages as any[];
  const detail = async (th: string) => (await ctx.master('GET', `/api/threads/${th}`)).json;

  function worker(runTurn: RunTurn, extra: Partial<ConstructorParameters<typeof BrainstormWorker>[0]> = {}) {
    return new BrainstormWorker({
      url: ctx.base,
      token: ctx.tokens.alpha.token,
      worker: 'oc-test',
      ocAgentId: 'main',
      configVersion: 'test',
      runTurn,
      log: quiet,
      heartbeatMs: 100,
      ...extra,
    });
  }

  test('두 스레드 → 두 세션 키, 답은 도장 없이 proposal 로, 실제 모델이 세션에 남는다', async () => {
    const seen: TurnRequest[] = [];
    const w = worker(async (req) => {
      seen.push(req);
      return {
        text: `받음 ${req.sessionKey}\n\n답변시각: x`,
        meta: { provider: 'anthropic', model: 'claude-test-9', agentHarnessId: 'claude-cli', sessionId: 's' },
      };
    });
    const a = await newThread(ctx, 'A', 'alpha');
    const b = await newThread(ctx, 'B', 'alpha');
    await post(ctx, a, '비밀 단어는 사과');
    await post(ctx, b, '비밀 단어는 배');
    assert.equal(await w.handleOne(), 'succeeded');
    assert.equal(await w.handleOne(), 'succeeded');
    assert.equal(await w.handleOne(), 'idle');
    assert.equal(seen.length, 2);
    assert.notEqual(seen[0].sessionKey, seen[1].sessionKey);
    assert.match(seen[0].prompt, /사과/);
    assert.doesNotMatch(seen[0].prompt, /배/);
    assert.match(seen[1].prompt, /배/);
    assert.doesNotMatch(seen[1].prompt, /사과/);
    const reply = (await msgs(a)).at(-1);
    assert.equal(reply.author_id, 'alpha');
    assert.equal(reply.source_kind, 'proposal');
    assert.doesNotMatch(reply.body, /답변시각/);
    const s = (await detail(a)).sessions.find((x: any) => x.agent_id === 'alpha');
    assert.equal(s.generation, 1);
    assert.equal(s.runtime, 'openclaw/claude-cli');
    assert.equal(s.actual_model, 'anthropic/claude-test-9');
    const r = (await runs(a))[0];
    assert.equal(r.state, 'succeeded');
    assert.equal(r.usage.openclaw.session_key, seen[0].sessionKey);

    // 같은 세대의 다음 턴은 새 메시지만 받는다
    await post(ctx, a, '방금 단어가 뭐였지?');
    assert.equal(await w.handleOne(), 'succeeded');
    assert.equal(seen[2].sessionKey, seen[0].sessionKey);
    assert.doesNotMatch(seen[2].prompt, /사과/);
    assert.match(seen[2].prompt, /방금 단어/);
  });

  test('세대 교체 → 새 세션 키, 옛 세대의 원문은 넘기지 않는다', async () => {
    const seen: TurnRequest[] = [];
    const w = worker(async (req) => {
      seen.push(req);
      return { text: 'ok', meta: { provider: 'anthropic', model: 'claude-test-9', agentHarnessId: 'claude-cli' } };
    });
    const th = await newThread(ctx, '교체', 'alpha');
    await post(ctx, th, '비밀 단어는 포도');
    assert.equal(await w.handleOne(), 'succeeded');
    const rot = await ctx.master('POST', `/api/threads/${th}/sessions/rotate`, { agent_id: 'alpha', reason: '시험' });
    assert.equal(rot.status, 200);
    assert.equal(rot.json.session.generation, 2);
    assert.ok(rot.json.session.base_seq >= 2);
    await post(ctx, th, '단어가 뭐였지?');
    assert.equal(await w.handleOne(), 'succeeded');
    assert.match(seen[1].sessionKey, /:g2$/);
    assert.notEqual(seen[1].sessionKey, seen[0].sessionKey);
    assert.doesNotMatch(seen[1].prompt, /포도/);
    const ss = (await detail(th)).sessions.filter((x: any) => x.agent_id === 'alpha');
    assert.deepEqual(
      ss.map((x: any) => [x.generation, x.status, x.actual_model]),
      [
        [1, 'retired', 'anthropic/claude-test-9'],
        [2, 'active', 'anthropic/claude-test-9'],
      ],
    );
  });

  test('취소: 도는 턴을 abort 하고 중단 확인을 보내고 답을 올리지 않는다', async () => {
    let aborted = false;
    const w = worker(
      (req) =>
        new Promise((resolve) => {
          req.signal.addEventListener('abort', () => {
            aborted = true;
            resolve({ text: '늦은 답', aborted: true });
          });
        }),
    );
    const th = await newThread(ctx, '취소', 'alpha');
    await post(ctx, th, '오래 걸리는 질문');
    const p = w.handleOne();
    const r = await waitFor(async () => (await runs(th)).find((x) => x.state === 'running'));
    assert.equal((await ctx.master('POST', `/api/runs/${r.id}/cancel`)).status, 200);
    assert.equal(await p, 'cancelled');
    assert.ok(aborted);
    assert.equal((await runs(th))[0].state, 'cancelled');
    assert.equal((await runs(th))[0].cancel_outcome, 'acked', '중단 확인을 보냈다');
    assert.equal((await msgs(th)).length, 1, '답 메시지 없음');
  });

  test('LLM 호출 뒤·답 저장 전 충돌 → unknown, 다시 띄운 작업자는 재실행하지 않는다', async () => {
    let calls = 0;
    let dead = false;
    const deadFetch: typeof fetch = (input, init) => (dead ? Promise.reject(new Error('process gone')) : fetch(input, init));
    const w1 = worker(
      async () => {
        calls++;
        return { text: '답' };
      },
      {
        fetchImpl: deadFetch,
        beforeComplete: () => {
          dead = true; // 여기서 프로세스가 죽었다고 친다: heartbeat·complete 가 더는 안 나간다
        },
      },
    );
    const th = await newThread(ctx, '충돌', 'alpha');
    await post(ctx, th, '질문');
    assert.equal(await w1.handleOne(), 'lost');
    assert.equal(calls, 1);
    const r = await waitFor(async () => (await runs(th)).find((x) => x.state === 'unknown'), 5000);
    assert.equal(r.error, 'lease_expired');
    // 게이트웨이 재시작 = 새 작업자
    const w2 = worker(async () => {
      calls++;
      return { text: '다시 돈 답' };
    });
    await sleep(200);
    assert.equal(await w2.handleOne(), 'idle');
    assert.equal(calls, 1, '재실행 없음');
    assert.equal((await msgs(th)).length, 1);
  });

  test('턴 오류 → failed, 오류 문자열의 토큰 모양은 가린다', async () => {
    const tok = 'bst_' + 'y'.repeat(43);
    const w = worker(async () => {
      throw new Error(`boom ${tok}`);
    });
    const th = await newThread(ctx, '실패', 'alpha');
    await post(ctx, th, '질문');
    assert.equal(await w.handleOne(), 'failed');
    const r = (await runs(th))[0];
    assert.equal(r.state, 'failed');
    assert.doesNotMatch(r.error, /y{20}/);
  });
});

describe('작업자 동시 실행 (마스터 #460)', () => {
  let ctx: Ctx;
  const quiet = { info() {}, warn() {}, error() {} };
  before(async () => {
    ctx = await setup();
  });
  after(async () => ctx.close());

  test('칸 3: 다른 스레드는 겹쳐 돌고, 같은 스레드는 순서대로 하나씩', async () => {
    const spans: { key: string; trigger: string; start: number; end: number }[] = [];
    const w = new BrainstormWorker({
      url: ctx.base,
      token: ctx.tokens.alpha.token,
      worker: 'oc-test',
      ocAgentId: 'main',
      configVersion: 'test',
      log: quiet,
      heartbeatMs: 100,
      pollMs: 50,
      concurrency: 3,
      runTurn: async (req) => {
        const start = Date.now();
        await sleep(400);
        spans.push({ key: req.sessionKey, trigger: req.prompt.match(/▶ #\d+[^\n]*\n([^\n]*)/)?.[1] ?? '', start, end: Date.now() });
        return { text: 'ok' };
      },
    });
    const a = await newThread(ctx, 'A', 'alpha');
    const b = await newThread(ctx, 'B', 'alpha');
    const c = await newThread(ctx, 'C', 'alpha');
    await post(ctx, a, 'a1');
    await post(ctx, a, 'a2');
    await post(ctx, b, 'b1');
    await post(ctx, c, 'c1');
    const ac = new AbortController();
    const loop = w.loop(ac.signal);
    await waitFor(async () => spans.length === 4, 10_000);
    ac.abort();
    await loop;
    const by = (t: string) => spans.find((s) => s.trigger === t)!;
    const overlap = (x: typeof spans[0], y: typeof spans[0]) => x.start < y.end && y.start < x.end;
    assert.ok(overlap(by('a1'), by('b1')) && overlap(by('b1'), by('c1')), '다른 스레드는 겹친다');
    assert.ok(by('a2').start >= by('a1').end, '같은 스레드는 a1 이 끝난 뒤 a2');
  });
});
