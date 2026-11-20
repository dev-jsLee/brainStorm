// MCP 문(POST /mcp · 마스터 #1865) — 에이전트 토큰으로 질문함 도구를 부른다.
//   인증(토큰만) · initialize/notification/tools/list · ask → list → close(남의 것 거절) · 방 추정(지금 도는 실행 + 주 태그) · 모듈 꺼짐 = 도구 없음
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { buildArgs, writeMcpConfig } from '../adapter/claude-cli/runner.js';
import { newThread, post, setup, type Ctx } from './helpers.js';

async function rpc(ctx: Ctx, who: string | null, msg: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${ctx.base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(who ? { Authorization: `Bearer ${ctx.tokens[who].token}` } : {}), ...headers },
    body: JSON.stringify(msg),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
let n = 0;
const call = async (ctx: Ctx, who: string, name: string, args: unknown, headers: Record<string, string> = {}) =>
  (await rpc(ctx, who, { jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }, headers)).json.result;

const ITEMS = [{ header: '갈림', question: '어느 쪽?', options: [{ label: 'A안' }, { label: 'B안' }], recommended: 1 }];

describe('MCP 문 — 질문함 켜짐', () => {
  let ctx: Ctx;
  before(async () => {
    ctx = await setup({ modules: ['questions'] });
  });
  after(async () => ctx.close());

  test('토큰 없음 401 · 마스터 쿠키 403 · GET 405', async () => {
    assert.equal((await rpc(ctx, null, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
    const m = await rpc(ctx, null, { jsonrpc: '2.0', id: 1, method: 'ping' }, { Cookie: ctx.cookie, Origin: ctx.base });
    assert.equal(m.status, 403);
    assert.equal((await fetch(`${ctx.base}/mcp`, { headers: { Authorization: `Bearer ${ctx.tokens.alpha.token}` } })).status, 405);
  });

  test('initialize · 알림은 202 · tools/list 에 셋 · 모르는 메서드 -32601', async () => {
    const i = await rpc(ctx, 'alpha', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    assert.equal(i.status, 200);
    assert.equal(i.json.result.protocolVersion, '2025-06-18');
    assert.equal(i.json.result.serverInfo.name, 'brainstorm');
    assert.match(i.json.result.instructions, /ask_question/);
    const old = await rpc(ctx, 'alpha', { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    assert.equal(old.json.result.protocolVersion, '2025-06-18');
    assert.equal((await rpc(ctx, 'alpha', { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    const l = await rpc(ctx, 'alpha', { jsonrpc: '2.0', id: 3, method: 'tools/list' });
    assert.deepEqual(l.json.result.tools.map((t: { name: string }) => t.name), ['ask_question', 'close_question', 'list_questions']);
    assert.equal((await rpc(ctx, 'alpha', { jsonrpc: '2.0', id: 4, method: 'nope' })).json.error.code, -32601);
  });

  test('ask(thread_id) → list → 남의 close 거절 → close(글로 답함) → list closed', async () => {
    const th = await newThread(ctx, 'mcp', null, ['alpha', 'beta']);
    const a = await call(ctx, 'alpha', 'ask_question', { items: ITEMS, thread_id: th });
    assert.equal(a.isError, false, a.content[0].text);
    const id = a.structuredContent.question.id as string;
    assert.match(a.content[0].text, /올림: q_/);

    const l = await call(ctx, 'alpha', 'list_questions', {});
    assert.match(l.content[0].text, new RegExp(`${id} · #\\d+ · open`));
    assert.match(l.content[0].text, /1\) B안 \(추천\) \/ 2\) A안/);

    const other = await call(ctx, 'beta', 'close_question', { id, answer: 'B안', by_msg_seq: 1 });
    assert.equal(other.isError, true);
    assert.match(other.content[0].text, /not_asker/);

    const m = await post(ctx, th, '그냥 B 로 가');
    const seq = (m as { message: { seq: number } }).message.seq;
    const c = await call(ctx, 'alpha', 'close_question', { id, answer: 'B안', by_msg_seq: seq });
    assert.equal(c.isError, false, c.content[0].text);
    assert.match(c.content[0].text, /문항 1 · 질문 상태 answered_in_chat/);
    const one = await call(ctx, 'alpha', 'list_questions', { id });
    assert.match(one.content[0].text, /«B안»\(글에서 읽음 #\d+\)/);
  });

  test('방 추정: 도는 실행이 없으면 thread_required · 하나면 그 방 + 원인 글의 주 태그', async () => {
    const c2 = await setup({ modules: ['questions'] });
    try {
      const none = await call(c2, 'alpha', 'ask_question', { items: ITEMS });
      assert.equal(none.isError, true);
      assert.match(none.content[0].text, /thread_required/);

      const tag = (await c2.master('POST', '/api/tags', { name: '개발' })).json.tag.id as string;
      const th = await newThread(c2, '추정', null, ['alpha']);
      await post(c2, th, '이거 해줘', { recipients: ['alpha'], tags: [tag] });
      const cl = (await c2.agent('alpha', 'POST', '/api/adapter/claim', { worker: 'manual' })).json.claim;
      const st = await c2.agent('alpha', 'POST', `/api/adapter/runs/${cl.run.id}/start`, { run_token: cl.run_token ?? cl.run.run_token });
      assert.equal(st.status, 200, JSON.stringify(st.json));

      const a = await call(c2, 'alpha', 'ask_question', { items: ITEMS });
      assert.equal(a.isError, false, a.content[0].text);
      assert.equal(a.structuredContent.question.thread_id, th);
      const msgs = (await c2.master('GET', `/api/threads/${th}/messages`)).json.messages as { seq: number; tags: { primary: { id: string }[] } }[];
      const qm = msgs.find((x) => x.seq === a.structuredContent.question.message_seq)!;
      assert.deepEqual(qm.tags.primary.map((t) => t.id), [tag]);

      // 어댑터가 실행 id 를 머리로 주면 그 실행 — 남의(없는) 실행 id 면 방을 못 정한다
      const h = await call(c2, 'alpha', 'ask_question', { items: ITEMS }, { 'X-Brainstorm-Run': cl.run.id });
      assert.equal(h.structuredContent.question.thread_id, th);
      const wrong = await call(c2, 'alpha', 'ask_question', { items: ITEMS }, { 'X-Brainstorm-Run': 'run_nope' });
      assert.equal(wrong.isError, true);
      assert.match(wrong.content[0].text, /thread_required/);
    } finally {
      await c2.close();
    }
  });
});

describe('MCP 문 — 질문함은 core(마스터 #1873)', () => {
  let ctx: Ctx;
  before(async () => {
    ctx = await setup({ modules: [] });
  });
  after(async () => ctx.close());

  test('선택 모듈을 하나도 안 켜도 질문함 도구 셋이 보인다 · 모르는 도구는 -32602', async () => {
    const l = await rpc(ctx, 'alpha', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.deepEqual(l.json.result.tools.map((t: any) => t.name).sort(), ['ask_question', 'close_question', 'list_questions']);
    const c = await rpc(ctx, 'alpha', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } });
    assert.equal(c.json.error.code, -32602);
  });
  test('질문 경로도 열려 있다(404 module_off 아님)', async () => {
    const r = await ctx.master('GET', '/api/questions');
    assert.equal(r.status, 200);
  });
});

describe('Claude 어댑터 — MCP 붙이기', () => {
  test('실행마다 0600 설정 파일(토큰 · X-Brainstorm-Run) · 인자에 --mcp-config 와 허용 목록', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-mcp-'));
    const f = writeMcpConfig({ url: 'http://127.0.0.1:8080/', token: 'tok', dir }, 'run_abc');
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.deepEqual(j.mcpServers.brainstorm, { type: 'http', url: 'http://127.0.0.1:8080/mcp', headers: { Authorization: 'Bearer tok', 'X-Brainstorm-Run': 'run_abc' } });
    const a = buildArgs({ extraArgs: ['--permission-mode', 'bypassPermissions'], appendSystemPrompt: 'x', mcpConfig: f }, 'u', false);
    assert.deepEqual(a.slice(a.indexOf('--mcp-config')), ['--mcp-config', f, '--allowedTools', 'mcp__brainstorm', '--permission-mode', 'bypassPermissions']);
    assert.ok(!buildArgs({ extraArgs: [], appendSystemPrompt: 'x' }, 'u', false).includes('--mcp-config'));
    fs.rmSync(dir, { recursive: true });
  });
});

describe('Codex 어댑터 — MCP 붙이기', () => {
  test('exec 앞에 -c mcp_servers.brainstorm.* (토큰은 환경 변수 이름만 · 실행 id 는 머리)', async () => {
    const { buildArgs: codexArgs, mcpArgs } = await import('../adapter/codex-cli/runner.js');
    const m = mcpArgs({ url: 'http://h:8080/' }, 'run_x');
    assert.deepEqual(m, [
      '-c', 'mcp_servers.brainstorm.url="http://h:8080/mcp"',
      '-c', 'mcp_servers.brainstorm.bearer_token_env_var="BRAINSTORM_MCP_TOKEN"',
      '-c', 'mcp_servers.brainstorm.http_headers={ "X-Brainstorm-Run" = "run_x" }',
      '-c', 'mcp_servers.brainstorm.default_tools_approval_mode="approve"',
    ]);
    const a = codexArgs({ cwd: '/w', globalArgs: ['--sandbox', 'read-only'], mcp: m }, null);
    assert.ok(a.indexOf('exec') > a.lastIndexOf('-c'));
    assert.ok(!a.join(' ').includes('Bearer'));
  });
});
