// MCP 문(마스터 #1865 «어댑터가 아니라 API·MCP 로 — 어떤 에이전트든»). POST /mcp = MCP Streamable HTTP(상태 없음 · JSON 응답만 · SSE 없음).
// 에이전트는 자기 토큰을 Bearer 로 붙여 MCP 클라이언트(Claude Code · Codex · 그 밖)에 등록하면 brainStorm 도구를 부른다 — 명령을 따로 깔 필요가 없다.
// 도구는 REST 와 같은 Store 메서드를 같은 Principal 로 부른다(권한·감사·모듈 꺼짐이 REST 와 같다). 도구 목록은 켜진 모듈을 따른다.
// 방 정하기: 어댑터가 넣어 주던 BRAINSTORM_THREAD_ID 대신 서버가 «이 에이전트가 지금 돌고 있는 실행»에서 찾는다 —
//   어댑터가 X-Brainstorm-Run 머리로 실행 id 를 주면 그 실행 · 안 주면 도는 실행이 하나일 때 그 방(+원인 글의 주 태그) · 없거나 여럿이면 thread_id 를 받아야 한다.
import fs from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { ApiError, type Principal, type Row, type Store } from './store.js';

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER = { name: 'brainstorm', title: 'brainStorm', version: pkgVersion() };

function pkgVersion(): string {
  try {
    return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version ?? '0';
  } catch {
    return '0';
  }
}

const INSTRUCTIONS = `brainStorm — 사람 한 명(마스터)과 AI 에이전트들의 대화 서버.
질문함 도구(ask_question)가 보이면: 마스터에게 물어야 할 결정은 답 본문에 선택지를 늘어놓지 말고 ask_question 으로 올린 뒤 그 턴을 끝낸다.
묻는 것은 되돌리기 어려운 것만(푸시·복구 안 되는 삭제·외부 발신·비용·자격 증명) — 나머지는 관례대로 정하고 답에 한 줄로 밝힌다.
마스터가 질문함에서 답하면 그 방에 지시 글이 와서 다시 불린다. 마스터가 대화 글로 답했으면 close_question 으로 내린다(근거 글 번호와 읽어 낸 답).`;

type Json = Record<string, unknown>;
interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Json;
  /** 이 도구가 붙는 선택 모듈(꺼지면 목록에서 빠지고 부르면 오류) · 없으면 core 도구 — 질문함은 core(마스터 #1873) */
  module?: string;
  run(pr: Principal, args: Json, runId: string | null): { text: string; data: Json };
}

const OPTION = {
  type: 'object',
  properties: { label: { type: 'string', maxLength: 200 }, description: { type: 'string', maxLength: 500 } },
  required: ['label'],
};
const ITEM = {
  type: 'object',
  properties: {
    header: { type: 'string', maxLength: 40, description: '짧은 머리(질문함 카드 제목)' },
    question: { type: 'string', maxLength: 1000, description: '물음' },
    options: { type: 'array', items: OPTION, minItems: 2, maxItems: 4 },
    recommended: { type: 'integer', minimum: 0, maximum: 3, description: '추천안 번호(0부터) — 첫 자리로 옮겨지고 화면이 «(추천)»을 붙인다' },
    multi: { type: 'boolean', description: '여럿 고르기(기본 false)' },
    allow_text: { type: 'boolean', description: '직접 입력 칸(기본 true)' },
  },
  required: ['question', 'options'],
};
const THREAD_ARG = { type: 'string', description: '방(th_…). 지금 도는 실행이 하나면 비워도 그 방으로 간다' };

/** 이 에이전트가 지금 돌고 있는 실행에서 방과 원인 글의 주 태그를 찾는다 — runId(어댑터가 X-Brainstorm-Run 머리로 넣음)가 있으면 그 실행 하나 */
function currentRun(store: Store, pr: Principal, runId: string | null): { thread_id: string; tags: string[] } | 'none' | 'many' {
  const rows = store.db
    .prepare(`SELECT thread_id, trigger_seq FROM runs WHERE agent_id = ? AND state = 'running'${runId ? ' AND id = ?' : ''} ORDER BY started_at DESC`)
    .all(pr.participant.id, ...(runId ? [runId] : [])) as Row[];
  const threads = [...new Set(rows.map((r) => r.thread_id as string))];
  if (!threads.length) return 'none';
  if (threads.length > 1) return 'many';
  const seq = rows[0].trigger_seq as number;
  const tags = (
    store.db
      .prepare(
        `SELECT mt.tag_id FROM message_tags mt JOIN tags t ON t.id = mt.tag_id
         WHERE mt.message_seq = ? AND mt.role = 'primary' AND t.archived_at IS NULL AND t.deleted_at IS NULL ORDER BY mt.rowid`,
      )
      .all(seq) as Row[]
  ).map((r) => r.tag_id as string);
  return { thread_id: threads[0], tags };
}

function threadFor(store: Store, pr: Principal, given: unknown, runId: string | null): { thread_id: string; tags?: string[] } {
  if (typeof given === 'string' && given) {
    // 같은 방이면 원인 글의 주 태그를 그대로 싣는다
    const c = currentRun(store, pr, runId);
    return typeof c === 'object' && c.thread_id === given && c.tags.length ? c : { thread_id: given };
  }
  const c = currentRun(store, pr, runId);
  if (c === 'none') throw new ApiError(400, 'thread_required', 'thread_id 가 필요함 — 지금 도는 실행이 없어 방을 정할 수 없다(환경 BRAINSTORM_THREAD_ID 가 있으면 그 값)');
  if (c === 'many') throw new ApiError(400, 'thread_required', 'thread_id 가 필요함 — 여러 방에서 실행이 돌고 있다(환경 BRAINSTORM_THREAD_ID 의 값)');
  return c.tags.length ? c : { thread_id: c.thread_id };
}

function showQuestion(q: Json): string {
  const items = (q.items as Json[]).map((it) => {
    const opts = (it.options as Json[]).map((o, j) => `${j + 1}) ${o.label}${j === it.recommended ? ' (추천)' : ''}`).join(' / ');
    const a = it.answer as Json | null;
    let ans = '';
    if (a?.inferred) ans = ` → «${a.inferred}»(글에서 읽음 #${a.by_msg_seq})`;
    else if (a) {
      const picks = ((a.choices as number[]) ?? []).filter((c) => c < (it.options as Json[]).length).map((c) => (it.options as Json[])[c].label);
      if (a.text) picks.push(`직접: ${a.text}`);
      ans = ` → ${picks.join(' · ')}`;
    }
    return `  ${(it.idx as number) + 1}. ${it.header ? `[${it.header}] ` : ''}${it.question} — ${opts} [${it.status}]${ans}`;
  });
  return [`${q.id} · #${q.message_seq ?? ''} · ${q.status} · ${q.thread_title || q.thread_id}`, ...items].join('\n');
}

function tools(store: Store): Tool[] {
  return [
    {
      name: 'ask_question',
      title: '질문함에 질문 올리기',
      description:
        '마스터에게 물어야 할 결정을 질문함에 올린다(1~4문항 · 문항당 2~4안 · 추천안 표시). 올린 뒤 이 턴은 끝낸다 — 마스터가 답하면 그 방에 지시 글이 와서 다시 불린다. ' +
        '같은 방에 내가 올린 열린 질문은 새 질문으로 대체된다. 묻는 것은 되돌리기 어려운 것(푸시·복구 안 되는 삭제·외부 발신·비용·자격 증명)만.',
      inputSchema: { type: 'object', properties: { items: { type: 'array', items: ITEM, minItems: 1, maxItems: 4 }, thread_id: THREAD_ARG }, required: ['items'] },
      run(pr, a, runId) {
        const where = threadFor(store, pr, a.thread_id, runId);
        const r = store.questions!.createQuestion(pr, { ...where, items: a.items, client_key: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` });
        const q = r.question as unknown as Json;
        let text = `올림: ${q.id} (#${q.message_seq}) — 마스터가 질문함에서 답하면 이 방에 지시 글이 와서 다시 불림. 이 턴은 여기서 끝낼 것.`;
        if (r.superseded.length) text += `\n대체함(앞 질문 닫힘): ${r.superseded.join(', ')}`;
        return { text, data: { question: q, superseded: r.superseded } };
      },
    },
    {
      name: 'close_question',
      title: '내 질문 내리기',
      description:
        '내가 올린 질문을 내린다 — 마스터가 대화 글로 답했을 때(answered_in_chat · answer 와 by_msg_seq 필수), 새 질문으로 바뀌었을 때(superseded), 더는 필요 없을 때(obsolete). ' +
        'item 을 주면 그 문항만. 잘못 읽었으면 마스터가 다시 연다.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '질문 id(q_…)' },
          answer: { type: 'string', maxLength: 1000, description: '글에서 읽어 낸 답' },
          by_msg_seq: { type: 'integer', minimum: 1, description: '근거 글 번호' },
          item: { type: 'integer', minimum: 1, maximum: 4, description: '문항 번호(1부터) — 비우면 열린 문항 전부' },
          reason: { type: 'string', enum: ['answered_in_chat', 'superseded', 'obsolete'] },
        },
        required: ['id'],
      },
      run(pr, a) {
        const body: Json = { reason: a.reason, answer: a.answer, by_msg_seq: a.by_msg_seq };
        if (a.item !== undefined && a.item !== null) body.item = Number(a.item) - 1;
        const r = store.questions!.closeQuestion(pr, String(a.id ?? ''), body);
        return { text: `내림: ${a.id} 문항 ${r.closed_items.map((i) => i + 1).join(', ')} · 질문 상태 ${r.question.status}`, data: r as unknown as Json };
      },
    },
    {
      name: 'list_questions',
      title: '내 질문 목록',
      description: '내가 올린 질문과 그 답 — status open(열림·나중에 · 기본) · closed · all. thread_id 로 한 방만.',
      inputSchema: {
        type: 'object',
        properties: { status: { type: 'string', enum: ['open', 'closed', 'all'] }, thread_id: { type: 'string' }, id: { type: 'string', description: '이 질문 하나만' } },
      },
      run(pr, a) {
        if (typeof a.id === 'string' && a.id) {
          const r = store.questions!.getQuestion(pr, a.id);
          return { text: showQuestion(r.question as unknown as Json), data: r as unknown as Json };
        }
        const r = store.questions!.listQuestions(pr, { status: a.status as string | undefined, thread_id: a.thread_id as string | undefined });
        const text = r.questions.length ? r.questions.map((q) => showQuestion(q as unknown as Json)).join('\n') : '(없음)';
        return { text, data: r as unknown as Json };
      },
    },
  ];
}

type RpcId = string | number | null;
const ok = (id: RpcId, result: unknown) => ({ jsonrpc: '2.0', id, result });
const err = (id: RpcId, code: number, message: string, data?: unknown) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });

export function mountMcp(fastify: FastifyInstance, store: Store, auth: preHandlerHookHandler, modules: readonly string[]) {
  const all = tools(store);
  const on = () => all.filter((t) => !t.module || modules.includes(t.module));

  function handle(pr: Principal, msg: Json, runId: string | null): object | null {
    const id = (msg.id ?? null) as RpcId;
    const isNote = msg.id === undefined;
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return isNote ? null : err(id, -32600, 'invalid request');
    const params = (msg.params ?? {}) as Json;
    switch (msg.method) {
      case 'initialize': {
        const want = String(params.protocolVersion ?? '');
        return ok(id, {
          protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER,
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return ok(id, {});
      case 'tools/list':
        return ok(id, { tools: on().map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema })) });
      case 'tools/call': {
        const tool = on().find((t) => t.name === params.name);
        if (!tool) return err(id, -32602, `unknown tool: ${String(params.name)}`);
        try {
          const { text, data } = tool.run(pr, (params.arguments ?? {}) as Json, runId);
          return ok(id, { content: [{ type: 'text', text }], structuredContent: data, isError: false });
        } catch (e) {
          if (!(e instanceof ApiError)) throw e;
          return ok(id, { content: [{ type: 'text', text: `${e.code}: ${e.message}` }], isError: true });
        }
      }
      default:
        if (isNote) return null; // notifications/initialized · cancelled 등 — 받기만
        return err(id, -32601, `method not found: ${msg.method}`);
    }
  }

  fastify.post('/mcp', { preHandler: auth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const pr = req.principal!;
    // 사람(쿠키) 세션은 MCP 를 쓰지 않는다 — 에이전트 토큰만
    if (pr.via !== 'token') throw new ApiError(403, 'token_required', 'MCP 는 에이전트 토큰(Bearer)으로만');
    const h = req.headers['x-brainstorm-run'];
    const runId = typeof h === 'string' && /^[\w-]{1,64}$/.test(h) ? h : null;
    const body = req.body as unknown;
    if (Array.isArray(body)) {
      const out = body.map((m) => handle(pr, (m ?? {}) as Json, runId)).filter((x) => x !== null);
      return out.length ? reply.send(out) : reply.code(202).send();
    }
    if (!body || typeof body !== 'object') return reply.code(400).send(err(null, -32700, 'parse error'));
    const out = handle(pr, body as Json, runId);
    return out ? reply.send(out) : reply.code(202).send();
  });
  // 서버가 먼저 보낼 것(SSE)은 없다 · 세션도 없다
  fastify.get('/mcp', async (_req, reply) => reply.code(405).header('Allow', 'POST').send());
  fastify.delete('/mcp', async (_req, reply) => reply.code(405).header('Allow', 'POST').send());
}
