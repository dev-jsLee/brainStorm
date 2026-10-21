#!/usr/bin/env node
// 가짜 어댑터 — 실제 모델 없이 프로토콜만 시험한다.
//
//   fake-adapter run    --url URL (--token-file F | env BRAINSTORM_TOKEN) [--worker W] [--once]
//                       [--crash-after-claim] [--slow-ms N] [--poll-ms N] [--max-idle-ms N] [--no-cancel-ack]
//   fake-adapter rotate --url URL (--token-file F | env BRAINSTORM_TOKEN) --thread TH [--reason R]
//
// 답은 결정적인 에코: "echo[thread=<id> gen=<n> agent=<id> trigger=<seq>] <원문>"
// --crash-after-claim : claim 직후 ack·start 없이 프로세스를 죽인다(lease 만료 → run unknown 시험)
// --slow-ms N         : 실행을 N ms 끈다(그동안 heartbeat, 취소를 받으면 멈추고 중단 확인을 보낸다)
// --no-cancel-ack     : 취소를 받으면 멈추되 중단 확인을 보내지 않는다(무응답 → 서버가 unknown 으로 두는 시험)
import fs from 'node:fs';

interface Opts {
  url: string;
  token: string;
  worker: string;
  once: boolean;
  crashAfterClaim: boolean;
  slowMs: number;
  pollMs: number;
  maxIdleMs: number;
  model: string;
  noCancelAck: boolean;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function log(...a: unknown[]) {
  // 토큰·본문은 로그에 안 남긴다 — 식별자만
  console.log(new Date().toISOString(), ...a);
}

async function api(o: Opts, method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(o.url + p, {
    method,
    headers: { Authorization: `Bearer ${o.token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function handleOne(o: Opts): Promise<boolean> {
  const c = await api(o, 'POST', '/api/adapter/claim', { worker: o.worker });
  if (c.status === 401 || c.status === 403) {
    log('auth rejected', c.status, c.json?.error);
    process.exit(4);
  }
  if (c.status !== 200) throw new Error(`claim ${c.status} ${JSON.stringify(c.json)}`);
  const claim = c.json.claim;
  if (!claim) return false;
  log('claimed', claim.delivery.id, 'run', claim.run.id, 'state', claim.run.state, 'dup', claim.duplicate);

  if (o.crashAfterClaim) {
    log('simulating crash after claim');
    process.exit(9);
  }

  const ack = await api(o, 'POST', `/api/adapter/deliveries/${claim.delivery.id}/ack`, { lease_token: claim.delivery.lease_token });
  if (ack.status !== 200) log('ack failed', ack.status, ack.json?.error);

  // 중복 전달이거나 이미 끝난(또는 unknown) 실행이면 다시 돌리지 않는다
  if (!claim.run.run_token || claim.run.state !== 'queued') {
    log('skip run', claim.run.id, 'state', claim.run.state);
    return true;
  }
  const token = claim.run.run_token;
  const st = await api(o, 'POST', `/api/adapter/runs/${claim.run.id}/start`, {
    run_token: token,
    runtime: 'fake',
    model: o.model,
    config_version: 'fake-1',
  });
  if (st.status !== 200) {
    log('start rejected', st.status, st.json?.error);
    return true;
  }

  let remaining = o.slowMs;
  while (remaining > 0) {
    const step = Math.min(remaining, 200);
    await sleep(step);
    remaining -= step;
    const hb = await api(o, 'POST', `/api/adapter/runs/${claim.run.id}/heartbeat`, { run_token: token });
    if (hb.status !== 200 || hb.json?.cancel) {
      log('run stopped by server', claim.run.id, hb.status, hb.json?.state ?? hb.json?.error);
      if (hb.status === 200 && hb.json?.cancel && !o.noCancelAck) {
        const ack = await api(o, 'POST', `/api/adapter/runs/${claim.run.id}/cancelled`, { run_token: token });
        log('cancel ack', claim.run.id, ack.status, ack.json?.state ?? ack.json?.error);
      } else if (hb.json?.cancel) log('cancel ack skipped (--no-cancel-ack)', claim.run.id);
      return true;
    }
  }

  const body = `echo[thread=${claim.thread.id} gen=${claim.session.generation} agent=${claim.run.agent_id} trigger=${claim.trigger.seq}] ${claim.trigger.body}`;
  const done = await api(o, 'POST', `/api/adapter/runs/${claim.run.id}/complete`, {
    run_token: token,
    body,
    usage: { fake: true, context_messages: claim.context.length, model: o.model },
  });
  log('complete', claim.run.id, done.status, done.json?.error ?? done.json?.message?.seq);
  return true;
}

async function runLoop(o: Opts) {
  let idleSince = Date.now();
  for (;;) {
    let did = false;
    try {
      did = await handleOne(o);
    } catch (e) {
      log('error', (e as Error).message);
      await sleep(o.pollMs);
    }
    if (did) {
      idleSince = Date.now();
      if (o.once) return;
      continue;
    }
    if (o.maxIdleMs > 0 && Date.now() - idleSince > o.maxIdleMs) return;
    await sleep(o.pollMs);
  }
}

async function main() {
  const cmd = process.argv[2];
  const tokenFile = arg('--token-file');
  const token = tokenFile ? fs.readFileSync(tokenFile, 'utf8').trim() : process.env.BRAINSTORM_TOKEN;
  const url = (arg('--url') ?? process.env.BRAINSTORM_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
  if (!token) {
    console.error('토큰이 없다: --token-file 또는 BRAINSTORM_TOKEN');
    process.exit(2);
  }
  const o: Opts = {
    url,
    token,
    worker: arg('--worker') ?? `fake-${process.pid}`,
    once: process.argv.includes('--once'),
    crashAfterClaim: process.argv.includes('--crash-after-claim'),
    slowMs: Number(arg('--slow-ms') ?? 0),
    pollMs: Number(arg('--poll-ms') ?? 500),
    maxIdleMs: Number(arg('--max-idle-ms') ?? 0),
    model: arg('--model') ?? 'fake-echo-1',
    noCancelAck: process.argv.includes('--no-cancel-ack'),
  };
  if (cmd === 'run' || cmd === undefined) return runLoop(o);
  if (cmd === 'rotate') {
    const th = arg('--thread');
    if (!th) {
      console.error('--thread 가 필요하다');
      process.exit(2);
    }
    const r = await api(o, 'POST', `/api/threads/${th}/sessions/rotate`, { reason: arg('--reason') ?? 'fake-adapter rotate' });
    console.log(JSON.stringify(r.json));
    process.exit(r.status === 200 ? 0 : 1);
  }
  console.error('명령: run | rotate');
  process.exit(2);
}

await main();
