#!/usr/bin/env node
// 2단계 실측 도구 — 마스터 웹 세션으로 brainStorm API 를 부른다(실제 OpenClaw 에이전트가 답한다).
// 세션 값은 파일에서 읽고 화면·로그에 찍지 않는다.
//
//   BS_URL=http://127.0.0.1:8080 BS_SESSION_FILE=~/.config/brainstorm/master-test.session \
//   node scripts/phase2-evidence.mjs <명령> ...
//
//   thread <제목> <에이전트id>               스레드를 만들고 에이전트를 기본 수신자·멤버로 둔다
//   say <스레드> <본문...>                   지시로 보내고 실행이 끝날 때까지 기다린다 → 답·실행·세션을 JSON 으로
//   say-nowait <스레드> <본문...>            보내기만
//   wait-running <스레드>                    running 실행이 나올 때까지 기다려 그 id 를 낸다
//   cancel <run_id>                          현재 실행 취소
//   rotate <스레드> <에이전트id> [이유]       세션 교체(새 세대)
//   runs <스레드> | sessions <스레드> | messages <스레드>
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';

const URL_ = (process.env.BS_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const SESSION_FILE = (process.env.BS_SESSION_FILE ?? '~/.config/brainstorm/master-test.session').replace(/^~/, os.homedir());
const session = fs.readFileSync(SESSION_FILE, 'utf8').trim();

async function api(method, p, body) {
  const res = await fetch(URL_ + p, {
    method,
    headers: {
      Cookie: `bs_session=${session}`,
      Origin: URL_,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  const json = t ? JSON.parse(t) : null;
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = ['succeeded', 'failed', 'cancelled', 'unknown'];
const out = (x) => console.log(JSON.stringify(x, null, 2));

async function waitRun(th, seq, timeoutMs = 600_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const { runs } = await api('GET', `/api/threads/${th}/runs`);
    const r = runs.find((x) => x.trigger_seq === seq);
    if (r && TERMINAL.includes(r.state)) return r;
    if (Date.now() > end) throw new Error(`timeout waiting run for seq ${seq} (state=${r?.state})`);
    await sleep(1000);
  }
}

async function say(th, body, wait = true) {
  const r = await api('POST', `/api/threads/${th}/messages`, {
    client_key: `p2-${crypto.randomUUID()}`,
    body,
    source_kind: 'instruction',
  });
  const seq = r.message.seq;
  if (!wait) return { seq };
  const run = await waitRun(th, seq);
  const { messages } = await api('GET', `/api/threads/${th}/messages?after=${seq}`);
  const reply = run.result_seq ? messages.find((m) => m.seq === run.result_seq) : null;
  const { sessions } = await api('GET', `/api/threads/${th}`);
  return {
    thread: th,
    asked_seq: seq,
    run: { id: run.id, state: run.state, generation: run.generation, error: run.error, openclaw: run.usage?.openclaw ?? null },
    reply: reply ? { seq: reply.seq, source_kind: reply.source_kind, body: reply.body } : null,
    session: sessions.filter((s) => s.agent_id === run.agent_id).map((s) => ({
      generation: s.generation,
      status: s.status,
      runtime: s.runtime,
      actual_model: s.actual_model,
      base_seq: s.base_seq,
    })),
  };
}

const [cmd, ...a] = process.argv.slice(2);
switch (cmd) {
  case 'thread': {
    const [title, agent] = a;
    const r = await api('POST', '/api/threads', { title, default_recipient: agent, members: [agent] });
    out({ id: r.thread.id, title: r.thread.title, default_recipient: r.thread.default_recipient });
    break;
  }
  case 'say':
    out(await say(a[0], a.slice(1).join(' ')));
    break;
  case 'say-nowait':
    out(await say(a[0], a.slice(1).join(' '), false));
    break;
  case 'wait-running': {
    for (;;) {
      const { runs } = await api('GET', `/api/threads/${a[0]}/runs`);
      const r = runs.find((x) => x.state === 'running');
      if (r) {
        out({ run: r.id, state: r.state, started_at: r.started_at });
        break;
      }
      await sleep(500);
    }
    break;
  }
  case 'cancel':
    out(await api('POST', `/api/runs/${a[0]}/cancel`));
    break;
  case 'rotate':
    out(await api('POST', `/api/threads/${a[0]}/sessions/rotate`, { agent_id: a[1], reason: a[2] ?? 'phase2-test' }));
    break;
  case 'runs':
    out(
      (await api('GET', `/api/threads/${a[0]}/runs`)).runs.map((r) => ({
        id: r.id,
        trigger_seq: r.trigger_seq,
        generation: r.generation,
        state: r.state,
        error: r.error,
        result_seq: r.result_seq,
        openclaw: r.usage?.openclaw ?? null,
      })),
    );
    break;
  case 'sessions':
    out((await api('GET', `/api/threads/${a[0]}`)).sessions);
    break;
  case 'messages':
    out((await api('GET', `/api/threads/${a[0]}/messages`)).messages.map((m) => ({ seq: m.seq, author: m.author_id, source_kind: m.source_kind, body: m.body })));
    break;
  default:
    console.error('명령: thread | say | say-nowait | wait-running | cancel | rotate | runs | sessions | messages');
    process.exit(2);
}
