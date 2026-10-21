// Codex 어댑터(codex exec): 변환 함수 + 실제 brainStorm 서버 + 가짜 codex 실행 파일.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { bookKey, buildArgs, makeCodexRunner, parseEvents, progressOf } from '../adapter/codex-cli/runner.js';
import { BrainstormWorker } from '../adapter/openclaw-channel/src/worker.js';
import { newThread, post, setup, waitFor, type Ctx } from './helpers.js';

const J = (o: unknown) => JSON.stringify(o);
const turn = (text: string, id = 't-1') =>
  [
    'WARN 잡음 줄',
    J({ type: 'thread.started', thread_id: id }),
    J({ type: 'turn.started' }),
    J({ type: 'item.completed', item: { id: 'i0', type: 'reasoning', text: '...' } }),
    J({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text } }),
    J({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 8, output_tokens: 3, reasoning_output_tokens: 1 } }),
  ].join('\n');

describe('Codex 어댑터: 변환', () => {
  test('인자: 첫 턴은 exec -, 다음은 exec resume <id> - · cd·앞 인자·모델', () => {
    const o = { cwd: '/w', globalArgs: ['--sandbox', 'read-only'], model: 'm' };
    assert.deepEqual(buildArgs(o, null), ['--cd', '/w', '--sandbox', 'read-only', 'exec', '--skip-git-repo-check', '--json', '-m', 'm', '-']);
    assert.deepEqual(buildArgs({ cwd: '/w', globalArgs: [] }, 'abc'), ['--cd', '/w', 'exec', '--skip-git-repo-check', '--json', 'resume', 'abc', '-']);
  });

  test('사건: 세션 id·마지막 답·사용량 · 잡음 줄은 건너뜀', () => {
    const r = parseEvents(turn('첫 답') + '\n' + J({ type: 'item.completed', item: { type: 'agent_message', text: '마지막 답' } }) + '\n' + J({ type: 'turn.completed', usage: {} }));
    assert.equal(r.threadId, 't-1');
    assert.equal(r.text, '마지막 답');
    assert.equal(parseEvents(turn('x')).usage && (parseEvents(turn('x')).usage as any).cache_read, 8);
  });

  test('실패: turn.failed → 던짐 · 답 없이 끝남 → 마지막 오류를 싣고 던짐', () => {
    assert.throws(() => parseEvents(J({ type: 'turn.failed', error: { message: 'quota' } })), /turn\.failed: quota/);
    assert.throws(() => parseEvents(J({ type: 'error', message: 'Reconnecting... 5/5' })), /답 없음: Reconnecting/);
  });

  test('경과: 명령·MCP·검색·답 첫 줄·생각', () => {
    assert.equal(progressOf({ type: 'item.started', item: { type: 'command_execution', command: "bash -lc 'ls  -la'" } }), "도구 shell — bash -lc 'ls -la'");
    assert.equal(progressOf({ type: 'item.started', item: { type: 'mcp_tool_call', server: 'baalda', tool: 'read_note' } }), '도구 baalda.read_note');
    assert.equal(progressOf({ type: 'item.completed', item: { type: 'agent_message', text: '끝났음.\n다음' } }), '«끝났음.»');
    assert.equal(progressOf({ type: 'item.completed', item: { type: 'reasoning', text: '' } }), '생각하는 중');
    assert.equal(progressOf({ type: 'turn.started' }), null);
  });

  test('장부 열쇠: 결정적 · 스레드 id 를 그대로 적지 않음', () => {
    assert.equal(bookKey('agent:codex:bs:vision:th_a:g1'), bookKey('agent:codex:bs:vision:th_a:g1'));
    assert.notEqual(bookKey('agent:codex:bs:vision:th_a:g1'), bookKey('agent:codex:bs:vision:th_a:g2'));
    assert.doesNotMatch(bookKey('agent:codex:bs:vision:th_a:g1'), /th_a/);
  });
});

describe('Codex 어댑터: 작업자 (가짜 codex)', () => {
  let ctx: Ctx;
  let dir: string;
  let bin: string;
  const quiet = { info() {}, warn() {}, error() {} };
  const calls = () =>
    fs.existsSync(path.join(dir, 'calls.jsonl'))
      ? fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      : [];
  before(async () => {
    ctx = await setup();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-codex-'));
    fs.mkdirSync(path.join(dir, 'work'));
    bin = path.join(dir, 'codex');
    // 가짜 codex: 인자·프롬프트를 적고, resume 이면 그 id 를, 아니면 새 id 를 사건으로 낸다
    fs.writeFileSync(
      bin,
      `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
let p = ''; process.stdin.on('data', (d) => (p += d)); process.stdin.on('end', () => {
  fs.appendFileSync(${J(path.join(dir, 'calls.jsonl'))}, JSON.stringify({ args: a, prompt: p, cwd: process.cwd() }) + '\\n');
  const r = a.indexOf('resume'); const id = r >= 0 ? a[r + 1] : 'th-' + Date.now();
  const out = (o) => console.log(JSON.stringify(o));
  out({ type: 'thread.started', thread_id: id });
  if (p.includes('FAIL')) { out({ type: 'turn.failed', error: { message: 'boom' } }); process.exit(1); }
  const go = () => { out({ type: 'item.completed', item: { type: 'agent_message', text: '받음 ' + ((p.match(/▶ #\\d+/) || [''])[0]) } }); out({ type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 2, output_tokens: 1 } }); };
  if (p.includes('PROGRESS')) { out({ type: 'item.started', item: { type: 'command_execution', command: 'ls' } }); setTimeout(go, 600); }
  else if (p.includes('SLEEP')) setTimeout(go, 20000); else go();
});
`,
      { mode: 0o755 },
    );
  });
  after(async () => {
    await ctx.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const runs = async (th: string) => (await ctx.master('GET', `/api/threads/${th}/runs`)).json.runs as any[];
  const msgs = async (th: string) => (await ctx.master('GET', `/api/threads/${th}/messages`)).json.messages as any[];
  const detail = async (th: string) => (await ctx.master('GET', `/api/threads/${th}`)).json;
  const worker = (timeoutMs = 10_000) =>
    new BrainstormWorker({
      url: ctx.base,
      token: ctx.tokens.alpha.token,
      worker: 'cx-test',
      ocAgentId: 'codex',
      runtime: 'codex-cli',
      describeModel: (meta) => ({ runtime: 'codex-cli', model: meta?.model ?? 'gpt-fake' }),
      configVersion: 'test',
      runTurn: makeCodexRunner({
        bin,
        cwd: path.join(dir, 'work'),
        preamble: '머리말',
        globalArgs: ['--sandbox', 'read-only'],
        timeoutMs,
        attachDir: path.join(dir, 'att'),
        sessionFile: path.join(dir, 'sessions.json'),
      }),
      log: quiet,
      heartbeatMs: 100,
    });

  test('첫 턴 새 세션(머리말) → 다음 턴 그 id 로 resume · 새 메시지만 · 장부에 남음 · 런타임 codex-cli', async () => {
    const th = await newThread(ctx, 'CX', 'alpha');
    await post(ctx, th, '비밀 단어는 사과');
    assert.equal(await worker().handleOne(), 'succeeded');
    await post(ctx, th, '방금 단어?');
    assert.equal(await worker().handleOne(), 'succeeded'); // 새 작업자 = 재시작 — 장부 파일로 잇는다
    const [c1, c2] = calls().slice(-2);
    assert.ok(!c1.args.includes('resume'));
    assert.ok(c1.args.includes('read-only'));
    assert.equal(c1.cwd, path.join(dir, 'work'));
    assert.match(c1.prompt, /^머리말\n\n/);
    assert.match(c1.prompt, /사과/);
    const id = c2.args[c2.args.indexOf('resume') + 1];
    assert.match(id, /^th-\d+$/);
    assert.doesNotMatch(c2.prompt, /머리말|사과/);
    assert.match(c2.prompt, /방금 단어/);
    assert.ok(Object.values(JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8'))).includes(id));
    const reply = (await msgs(th)).at(-1);
    assert.equal(reply.author_id, 'alpha');
    assert.equal(reply.source_kind, 'proposal');
    assert.match(reply.body, /^받음 ▶ #\d+$/);
    const s = (await detail(th)).sessions.find((x: any) => x.agent_id === 'alpha');
    assert.equal(s.runtime, 'codex-cli');
    assert.equal(s.actual_model, 'gpt-fake');
  });

  test('경과: 명령 사건이 run.progress 로', async () => {
    const w = worker();
    const th = await newThread(ctx, 'CX 경과', 'alpha');
    await post(ctx, th, 'PROGRESS 보여 줘');
    const p = w.handleOne();
    await waitFor(async () => (await runs(th)).find((x) => x.state === 'running' && x.progress));
    assert.equal(await p, 'succeeded');
    assert.equal((await runs(th))[0].progress, '도구 shell — ls');
  });

  test('codex 실패 → run failed (codex-cli: …)', async () => {
    const th = await newThread(ctx, 'CX 실패', 'alpha');
    await post(ctx, th, 'FAIL 해 봐');
    assert.equal(await worker().handleOne(), 'failed');
    assert.match(String((await runs(th))[0].error), /^codex-cli: codex rc=1 codex turn\.failed: boom/);
  });

  test('취소 → 프로세스를 끊고 중단 확인 · 답 없음', async () => {
    const w = worker();
    const th = await newThread(ctx, 'CX 취소', 'alpha');
    await post(ctx, th, 'SLEEP 오래');
    const p = w.handleOne();
    const r = await waitFor(async () => (await runs(th)).find((x) => x.state === 'running'));
    assert.equal((await ctx.master('POST', `/api/runs/${r.id}/cancel`)).status, 200);
    assert.equal(await p, 'cancelled');
    assert.equal((await msgs(th)).length, 1);
  });

  test('시간 초과 → 끊고 failed', async () => {
    const th = await newThread(ctx, 'CX 시간', 'alpha');
    await post(ctx, th, 'SLEEP 시간 초과');
    assert.equal(await worker(500).handleOne(), 'failed');
    assert.match(String((await runs(th))[0].error), /timeout 500ms/);
  });
});
