// Claude Code 어댑터(claude -p): 변환 함수 + 실제 brainStorm 서버 + 가짜 claude 실행 파일.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { attachmentPath, buildArgs, costDelta, makeClaudeRunner, parseResult, progressOf, sessionFile, sessionUuid } from '../adapter/claude-cli/runner.js';
import { BrainstormWorker } from '../adapter/openclaw-channel/src/worker.js';
import { newThread, post, setup, waitFor, type Ctx } from './helpers.js';

const ok = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '답\n\n답변시각:', session_id: 's1', duration_ms: 12, num_turns: 2, total_cost_usd: 0.123456, usage: { input_tokens: 3, output_tokens: 4 }, modelUsage: { 'claude-fake-1': {} }, ...o });

describe('Claude Code 어댑터: 변환', () => {
  test('세션 UUID: 같은 키는 같은 값, 다른 키는 다른 값, UUID 모양', () => {
    const a = sessionUuid('agent:claude:bs:baekgu:th_a:g1');
    assert.equal(a, sessionUuid('agent:claude:bs:baekgu:th_a:g1'));
    assert.notEqual(a, sessionUuid('agent:claude:bs:baekgu:th_a:g2'));
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('인자: 첫 턴은 --session-id, 다음은 --resume · 덧붙임·모델·그 밖의 인자', () => {
    const o = { appendSystemPrompt: '덧붙임', extraArgs: ['--permission-mode', 'bypassPermissions'], model: 'm' };
    assert.deepEqual(buildArgs(o, 'u', false), ['-p', '--output-format', 'stream-json', '--verbose', '--session-id', 'u', '--append-system-prompt', '덧붙임', '--model', 'm', '--permission-mode', 'bypassPermissions']);
    assert.deepEqual(buildArgs({ appendSystemPrompt: ' ', extraArgs: [] }, 'u', true), ['-p', '--output-format', 'stream-json', '--verbose', '--resume', 'u']);
  });

  test('결과: 성공 → 본문·모델·세션·비용 · 오류 → 던진다', () => {
    const r = parseResult(ok());
    assert.equal(r.text, '답\n\n답변시각:');
    assert.equal(r.meta?.model, 'claude-fake-1');
    assert.equal(r.meta?.sessionId, 's1');
    assert.equal((r.extra as any).cost_usd, 0.1235);
    assert.throws(() => parseResult(ok({ subtype: 'error_max_turns', is_error: true })), /error_max_turns/);
    assert.throws(() => parseResult('not json'), /JSON/);
  });

  test('첨부 자리: <dir>/<id>/<이름> · 경로 밖으로 못 나간다', () => {
    assert.equal(attachmentPath('/d', { id: 'att_x', name: '그림.png' }), '/d/att_x/그림.png');
    assert.equal(attachmentPath('/d', { id: 'att_x', name: '..' }), '/d/att_x/file');
    assert.equal(attachmentPath('/d', { id: '../x', name: '../../etc/passwd' }), '/d/___x/passwd');
  });

  test('경과: stream-json 사건 → 도구·답 첫 줄·생각 · 결과 줄은 앞 사건이 있어도 찾는다', () => {
    const a = (content: unknown[]) => ({ type: 'assistant', message: { content } });
    assert.equal(progressOf(a([{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la', description: '목록 보기' } }])), '도구 Bash — 목록 보기');
    assert.equal(progressOf(a([{ type: 'tool_use', name: 'Read', input: { file_path: '/x/y.md' } }])), '도구 Read — /x/y.md');
    assert.equal(progressOf(a([{ type: 'text', text: '백업 끝났음.\n다음은 설치' }])), '«백업 끝났음.»');
    assert.equal(progressOf(a([{ type: 'thinking', thinking: '' }])), '생각하는 중');
    assert.equal(progressOf({ type: 'user', message: { content: [] } }), null);
    const stream = [JSON.stringify({ type: 'system', subtype: 'init' }), JSON.stringify(a([{ type: 'text', text: 'x' }])), ok()].join('\n');
    assert.equal(parseResult(stream).text, '답\n\n답변시각:');
  });

  test('비용: 누계 → 실행분 · 새 세션은 0부터 · 직전을 모르면 null', () => {
    const book: Record<string, number> = {};
    assert.equal(costDelta(book, 'u', false, 0.5), 0.5);
    assert.equal(costDelta(book, 'u', true, 1.25), 0.75);
    assert.equal(costDelta(book, 'v', true, 2), null); // 재시작 뒤 첫 resume
    assert.equal(costDelta(book, 'v', true, 2.1), 0.1);
    assert.equal(costDelta(book, 'u', true, 0.2), null); // 누계가 줄면 믿지 않는다
    assert.equal(costDelta(book, 'u', false, null), null);
    assert.deepEqual(book, { v: 2.1, u: 0.2 });
  });

  test('세션 파일 자리: 작업 디렉터리의 영숫자 아닌 글자 → -', () => {
    assert.equal(sessionFile('/c', '/home/user/workspace', 'u'), '/c/projects/-home-user-workspace/u.jsonl');
  });
});

describe('Claude Code 어댑터: 작업자 (가짜 claude)', () => {
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
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-claude-'));
    fs.mkdirSync(path.join(dir, 'work'));
    bin = path.join(dir, 'claude');
    // 가짜 claude: 인자·프롬프트를 적고, --session-id 면 세션 파일을 만들고, 프롬프트에 SLEEP 이 있으면 오래 잔다
    fs.writeFileSync(
      bin,
      `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
let p = ''; process.stdin.on('data', (d) => (p += d)); process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(path.join(dir, 'calls.jsonl'))}, JSON.stringify({ args: a, prompt: p, cwd: process.cwd() }) + '\\n');
  const i = a.indexOf('--session-id');
  if (i >= 0) { const d = path.join(process.env.FAKE_CFG, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-')); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, a[i + 1] + '.jsonl'), ''); }
  if (p.includes('FAIL')) { console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' })); process.exit(1); }
  const go = () => console.log(${JSON.stringify(ok({ result: '__R__' }))}.replace('__R__', '받음 ' + (p.match(/▶ #\\d+/) || [''])[0] + '\\\\n\\\\n답변시각:'));
  if (p.includes('PROGRESS')) { console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls', description: '목록 보기' } }] } })); setTimeout(go, 600); }
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
  const worker = (timeoutMs = 10_000, refs?: { dir: string }) =>
    new BrainstormWorker({
      url: ctx.base,
      token: ctx.tokens.alpha.token,
      worker: 'cc-test',
      ocAgentId: 'claude',
      runtime: 'claude-cli',
      describeModel: (meta) => ({ runtime: 'claude-cli', model: meta?.model ?? null }),
      configVersion: 'test',
      runTurn: makeClaudeRunner({
        bin,
        cwd: path.join(dir, 'work'),
        configDir: path.join(dir, 'cfg'),
        appendSystemPrompt: '덧붙임',
        extraArgs: ['--permission-mode', 'bypassPermissions'],
        timeoutMs,
        env: { ...process.env, FAKE_CFG: path.join(dir, 'cfg') },
        attachDir: path.join(dir, 'att'),
        refs,
      }),
      log: quiet,
      heartbeatMs: 100,
    });

  test('첫 턴 --session-id → 다음 턴 같은 UUID 로 --resume · 새 메시지만 · 도장 없이 · 런타임 claude-cli', async () => {
    const w = worker();
    const th = await newThread(ctx, 'CC', 'alpha');
    await post(ctx, th, '비밀 단어는 사과');
    assert.equal(await w.handleOne(), 'succeeded');
    await post(ctx, th, '방금 단어?');
    assert.equal(await w.handleOne(), 'succeeded');
    const [c1, c2] = calls().slice(-2);
    const uuid = c1.args[c1.args.indexOf('--session-id') + 1];
    assert.ok(uuid && !c1.args.includes('--resume'));
    assert.equal(c2.args[c2.args.indexOf('--resume') + 1], uuid);
    assert.ok(c1.args.includes('bypassPermissions') && c1.args.includes('덧붙임'));
    assert.equal(c1.cwd, path.join(dir, 'work'));
    assert.match(c1.prompt, /사과/);
    assert.doesNotMatch(c2.prompt, /사과/);
    assert.match(c2.prompt, /방금 단어/);
    const reply = (await msgs(th)).at(-1);
    assert.equal(reply.author_id, 'alpha');
    assert.equal(reply.source_kind, 'proposal');
    assert.match(reply.body, /^받음 ▶ #\d+$/);
    const s = (await detail(th)).sessions.find((x: any) => x.agent_id === 'alpha');
    assert.equal(s.runtime, 'claude-cli');
    assert.equal(s.actual_model, 'claude-fake-1');
    const [u1, u2] = (await runs(th)).sort((a: any, b: any) => a.created_at - b.created_at).map((r: any) => r.usage['claude-cli']);
    assert.equal(u1.cost_usd, 0.1235); // 새 세션: 누계 그대로
    assert.equal(u2.cost_usd, 0); // 가짜 claude 누계가 그대로라 resume 실행분은 0
    assert.equal(u2.cost_total_usd, 0.1235);
  });

  test('명시적 참조: 글의 태그 → 원자 노트 본문이 프롬프트에 · 같은 세션 두 번째는 «이미 실었음» · usage 에 기록', async () => {
    const rd = path.join(dir, 'vault', '원자');
    fs.mkdirSync(rd, { recursive: true });
    fs.writeFileSync(path.join(rd, '서버.md'), '---\n별칭: [B서버]\n---\n# 서버\n노트본문-참나무\n');
    const w = worker(10_000, { dir: rd });
    const th = await newThread(ctx, 'CC 참조', 'alpha');
    await post(ctx, th, '#B서버 상태 어때 #없는것');
    assert.equal(await w.handleOne(), 'succeeded');
    await post(ctx, th, '#서버 다시');
    assert.equal(await w.handleOne(), 'succeeded');
    const [c1, c2] = calls().slice(-2);
    assert.match(c1.prompt, /명시적 참조[\s\S]*노트본문-참나무/);
    assert.match(c2.prompt, /이미 실었음/);
    assert.doesNotMatch(c2.prompt, /노트본문-참나무/);
    const u1 = (await runs(th)).sort((a: any, b: any) => a.created_at - b.created_at)[0].usage['claude-cli'];
    assert.deepEqual(u1.refs, [{ tag: 'B서버', note: path.join('원자', '서버.md'), truncated: false }]);
    assert.deepEqual(u1.refs_unmatched, ['없는것']);
  });

  test('첨부: 턴 전에 내려받고 프롬프트 끝에 로컬 경로 · 목록에는 이름·형식', async () => {
    const w = worker();
    const th = await newThread(ctx, 'CC 첨부', 'alpha');
    const u = await fetch(`${ctx.base}/api/uploads?name=${encodeURIComponent('메모.md')}`, {
      method: 'POST',
      headers: { Cookie: ctx.cookie, Origin: ctx.base, 'Content-Type': 'application/octet-stream' },
      body: new TextEncoder().encode('# 메모\n호두'),
    });
    const id = ((await u.json()) as any).upload.id;
    await post(ctx, th, '이 문서 읽어', { attachments: [id] });
    assert.equal(await w.handleOne(), 'succeeded');
    const c = calls().at(-1);
    const local = path.join(dir, 'att', id, '메모.md');
    assert.equal(fs.readFileSync(local, 'utf8'), '# 메모\n호두');
    assert.match(c.prompt, new RegExp(`📎 첨부 메모\\.md \\(텍스트 · 15 B · ${id}\\)`));
    assert.ok(c.prompt.includes(`[첨부 파일 — 이 기계의 로컬 사본.`));
    assert.ok(c.prompt.includes(`메모.md → ${local}`));
  });

  test('읽음·경과: 시작하자마자 «읽었음» · 도구 사건이 run.progress 로', async () => {
    const w = worker();
    const th = await newThread(ctx, 'CC 경과', 'alpha');
    await post(ctx, th, 'PROGRESS 보여 줘');
    const p = w.handleOne();
    const first = await waitFor(async () => (await runs(th)).find((x) => x.state === 'running' && x.progress));
    assert.equal(first.progress, '읽었음 — 작업 시작');
    assert.ok(first.heartbeat_at >= first.started_at);
    assert.equal(await p, 'succeeded');
    const r = (await runs(th))[0];
    assert.equal(r.progress, '도구 Bash — 목록 보기');
    assert.ok(r.progress_at >= first.progress_at);
  });

  test('claude 오류 → run failed (claude-cli: …)', async () => {
    const w = worker();
    const th = await newThread(ctx, 'CC 실패', 'alpha');
    await post(ctx, th, 'FAIL 해 봐');
    assert.equal(await w.handleOne(), 'failed');
    const r = (await runs(th))[0];
    assert.equal(r.state, 'failed');
    assert.match(String(r.error), /^claude-cli: claude rc=1 .*error_during_execution/);
  });

  test('취소 → 프로세스를 끊고 중단 확인 · 답 없음', async () => {
    const w = worker();
    const th = await newThread(ctx, 'CC 취소', 'alpha');
    await post(ctx, th, 'SLEEP 오래');
    const p = w.handleOne();
    const r = await waitFor(async () => (await runs(th)).find((x) => x.state === 'running'));
    assert.equal((await ctx.master('POST', `/api/runs/${r.id}/cancel`)).status, 200);
    assert.equal(await p, 'cancelled');
    assert.equal((await runs(th))[0].cancel_outcome, 'acked');
    assert.equal((await msgs(th)).length, 1);
  });

  test('시간 초과 → 끊고 failed', async () => {
    const w = worker(500);
    const th = await newThread(ctx, 'CC 시간', 'alpha');
    await post(ctx, th, 'SLEEP 시간 초과');
    assert.equal(await w.handleOne(), 'failed');
    assert.match(String((await runs(th))[0].error), /timeout 500ms/);
  });
});
