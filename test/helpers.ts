import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { buildApp, type App } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ADAPTER = path.resolve(here, '..', 'adapter', 'fake-adapter.js');
export const MASTER_PASS = 'test-passphrase-0123456789';

export interface Ctx {
  app: App;
  cfg: Config;
  base: string;
  dataDir: string;
  cookie: string;
  tokens: Record<string, { id: string; token: string }>;
  master(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }>;
  agent(who: string, method: string, p: string, body?: unknown): Promise<{ status: number; json: any }>;
  close(): Promise<void>;
  restart(): Promise<void>;
}

export async function setup(over: Partial<Config> = {}, dataDirIn?: string): Promise<Ctx> {
  const dataDir = dataDirIn ?? fs.mkdtempSync(path.join(os.tmpdir(), 'bs-test-'));
  const mk = () =>
    loadConfig({
      dataDir,
      listen: [{ host: '127.0.0.1', port: 0 }],
      deliveryLeaseMs: 300,
      runLeaseMs: 1500,
      retryBaseMs: 50,
      sweepIntervalMs: 100,
      wsRevalidateMs: 200,
      logLevel: 'silent',
      ...over,
    });
  const ctx = {} as Ctx;
  ctx.dataDir = dataDir;
  ctx.tokens = {};

  async function start(fresh: boolean) {
    ctx.cfg = mk();
    ctx.app = await buildApp(ctx.cfg, { logger: false });
    const [addr] = await ctx.app.listen();
    ctx.base = addr;
    ctx.cfg.origins = [addr];
    const s = ctx.app.store;
    if (fresh) {
      s.createParticipant('master', 'human', '마스터', true);
      s.setPassphrase('master', MASTER_PASS);
      for (const a of ['alpha', 'beta']) {
        s.createParticipant(a, 'agent', a.toUpperCase());
        ctx.tokens[a] = s.createToken(a, { label: 'test' });
      }
    }
    const r = await fetch(`${ctx.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ctx.base },
      body: JSON.stringify({ passphrase: MASTER_PASS }),
    });
    if (r.status !== 200) throw new Error(`login failed ${r.status}`);
    ctx.cookie = r.headers.get('set-cookie')!.split(';')[0];
  }

  async function call(headers: Record<string, string>, method: string, p: string, body?: unknown) {
    const res = await fetch(ctx.base + p, {
      method,
      headers: { ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  ctx.master = (m, p, b) => call({ Cookie: ctx.cookie, Origin: ctx.base }, m, p, b);
  ctx.agent = (who, m, p, b) => call({ Authorization: `Bearer ${ctx.tokens[who].token}` }, m, p, b);
  let closed = false;
  ctx.close = async () => {
    if (!closed) await ctx.app.close();
    closed = true;
  };
  ctx.restart = async () => {
    await ctx.close();
    await start(false);
    closed = false;
  };
  await start(!dataDirIn);
  return ctx;
}

export async function newThread(ctx: Ctx, title: string, defaultRecipient: string | null, members: string[] = []) {
  const r = await ctx.master('POST', '/api/threads', { title, default_recipient: defaultRecipient, members });
  if (r.status !== 201) throw new Error(`thread create ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.thread.id as string;
}

let keyN = 0;
export function key() {
  return `k-${process.pid}-${Date.now()}-${keyN++}`;
}

export async function post(ctx: Ctx, th: string, body: string, extra: Record<string, unknown> = {}) {
  const r = await ctx.master('POST', `/api/threads/${th}/messages`, { client_key: key(), body, ...extra });
  if (r.status !== 201) throw new Error(`post ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

export async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, timeoutMs = 8000, stepMs = 50): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function spawnAdapter(ctx: Ctx, who: string, args: string[]): ChildProcess & { output: () => string; exited: Promise<number | null> } {
  const cp = spawn(process.execPath, [ADAPTER, 'run', '--url', ctx.base, '--poll-ms', '50', '--worker', `${who}-w`, ...args], {
    env: { ...process.env, BRAINSTORM_TOKEN: ctx.tokens[who].token },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as any;
  let out = '';
  cp.stdout.on('data', (d: Buffer) => (out += d));
  cp.stderr.on('data', (d: Buffer) => (out += d));
  cp.output = () => out;
  cp.exited = new Promise((r) => cp.on('exit', (code: number | null) => r(code)));
  return cp;
}

export function openWs(ctx: Ctx, headers: Record<string, string>): Promise<{ ws: WebSocket; notices: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(ctx.base.replace('http', 'ws') + '/ws', { headers });
    const notices: any[] = [];
    ws.on('message', (d) => notices.push(JSON.parse(d.toString())));
    ws.once('open', () => resolve({ ws, notices }));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`ws rejected ${res.statusCode}`)));
    ws.once('error', reject);
  });
}
