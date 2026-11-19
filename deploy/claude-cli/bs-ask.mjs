#!/usr/bin/env node
// bs-ask — brainStorm 질문함(모듈 questions)에 질문지를 올리고 내린다. 에이전트가 claude -p 턴 안에서 부른다.
// claude -p 턴에서는 질문지(AskUserQuestion) 창이 안 뜬다 — 마스터에게 물을 결정은 이것으로 올리고 턴을 끝낸다.
// 마스터가 질문함에서 답하면 그 방에 «지시» 글이 와서 다시 불린다. 마스터가 대화 글로 답했으면 close 로 내린다.
//
// 설치: install -m 755 deploy/claude-cli/bs-ask.mjs ~/.local/bin/bs-ask   (어댑터 유닛의 PATH 에 ~/.local/bin 이 있다)
// 환경: BRAINSTORM_URL · BRAINSTORM_TOKEN_FILE(어댑터 env 파일의 값이 claude 자식에게 그대로 넘어간다)
//       BRAINSTORM_THREAD_ID · BRAINSTORM_RUN_ID(어댑터가 턴마다 넣는다). 토큰 값은 출력하지 않는다.
import fs from 'node:fs';

const HELP = `쓰는 법:
  bs-ask post <JSON | 파일 | ->      질문 올리기. JSON = {"items":[…]} 또는 문항 배열
      문항 = {"header":"짧은 머리(≤40자)", "question":"물음", "options":[{"label":"…","description":"…"}, …],
              "recommended":0, "multi":false, "allow_text":true}
      1~4문항 · 문항당 2~4안 · recommended(0부터)는 첫 자리로 옮겨지고 화면이 «(추천)»을 붙인다
  bs-ask close <질문 id> --answer "읽어 낸 답" --by-msg <근거 글 번호> [--item <문항 번호 1부터>] [--reason answered_in_chat|superseded|obsolete]
      물은 본인만 내릴 수 있다. answered_in_chat(기본)은 --answer·--by-msg 가 꼭 있어야 한다
  bs-ask list [--closed|--all] [--thread th_…]      내가 올린 질문
  bs-ask show <질문 id>
스레드는 --thread 또는 환경 BRAINSTORM_THREAD_ID. 서버는 BRAINSTORM_URL(기본 http://127.0.0.1:8080) · 토큰은 BRAINSTORM_TOKEN_FILE.`;

const URL_ = (process.env.BRAINSTORM_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');

function die(msg, code = 1) {
  process.stderr.write(`bs-ask: ${msg}\n`);
  process.exit(code);
}

function token() {
  const f = process.env.BRAINSTORM_TOKEN_FILE;
  if (!f) die('BRAINSTORM_TOKEN_FILE 이 없음 — 어댑터 env 파일의 값을 쓴다', 2);
  try {
    return fs.readFileSync(f, 'utf8').trim();
  } catch (e) {
    die(`토큰 파일을 못 읽음: ${f} (${e.code})`, 2);
  }
}

async function call(method, path, body) {
  let r;
  try {
    r = await fetch(`${URL_}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    die(`서버에 닿지 않음: ${URL_} (${e.cause?.code ?? e.message})`, 2);
  }
  const raw = await r.text();
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    j = { error: raw.slice(0, 200) };
  }
  if (!r.ok) {
    if (r.status === 404 && path.startsWith('/api/questions') && [undefined, 'not_found', 'module_off', 'Not Found'].includes(j.error) && !raw.includes('no_question'))
      die('질문함 모듈이 꺼져 있음(404) — 답에 선택지와 추천을 적어 물을 것', 3);
    die(`HTTP ${r.status} ${j.error ?? ''}: ${j.message ?? ''}`.trim(), 2);
  }
  return j;
}

function opt(args, name, def) {
  const i = args.indexOf(name);
  if (i < 0) return def;
  if (i + 1 >= args.length) die(`${name} 뒤에 값이 없음`);
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

/** 이 턴을 부른 글의 주 태그 — 질문 글도 같은 태그 방에 들어가게 */
async function triggerTags() {
  const runId = process.env.BRAINSTORM_RUN_ID;
  if (!runId) return [];
  try {
    const run = (await callQuiet('GET', `/api/runs/${runId}`))?.run;
    if (!run) return [];
    const seq = run.trigger_seq;
    const ms = (await callQuiet('GET', `/api/threads/${run.thread_id}/messages?after=${seq - 1}&limit=1`))?.messages ?? [];
    if (ms[0]?.seq === seq) return (ms[0].tags?.primary ?? []).map((t) => t.id);
  } catch {
    /* 태그는 덤 — 못 읽어도 질문은 올린다 */
  }
  return [];
}

async function callQuiet(method, path) {
  const r = await fetch(`${URL_}${path}`, { method, headers: { Authorization: `Bearer ${token()}` }, signal: AbortSignal.timeout(10_000) });
  return r.ok ? r.json() : null;
}

function show(q) {
  console.log(`${q.id} · #${q.message_seq ?? ''} · ${q.status} · ${q.thread_title || q.thread_id}`);
  for (const it of q.items) {
    const opts = it.options.map((o, j) => `${j + 1}) ${o.label}${j === it.recommended ? ' (추천)' : ''}`).join(' / ');
    let ans = '';
    const a = it.answer;
    if (a) {
      if (a.inferred) ans = ` → «${a.inferred}»(글에서 읽음 #${a.by_msg_seq})`;
      else {
        const picks = (a.choices ?? []).filter((c) => c < it.options.length).map((c) => it.options[c].label);
        if (a.text) picks.push(`직접: ${a.text}`);
        ans = ` → ${picks.join(' · ')}`;
      }
    }
    console.log(`  ${it.idx + 1}. ${it.header ? `[${it.header}] ` : ''}${it.question} — ${opts} [${it.status}]${ans}`);
  }
}

async function main(argv) {
  if (!argv.length || ['-h', '--help', 'help'].includes(argv[0])) {
    console.log(HELP);
    return;
  }
  const [cmd, ...args] = argv;
  if (cmd === 'post') {
    const thread = opt(args, '--thread') || process.env.BRAINSTORM_THREAD_ID;
    if (!thread) die('스레드가 없음 — --thread 또는 BRAINSTORM_THREAD_ID');
    if (!args.length) die('JSON 또는 파일 경로가 필요함');
    const src = args[0];
    const raw = src === '-' ? fs.readFileSync(0, 'utf8') : fs.existsSync(src) && fs.statSync(src).isFile() ? fs.readFileSync(src, 'utf8') : src;
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      die(`JSON 이 아님: ${e.message}`);
    }
    const body = { thread_id: thread, items: Array.isArray(data) ? data : data.items, client_key: `bs-ask-${process.hrtime.bigint()}-${process.pid}` };
    const tags = await triggerTags();
    if (tags.length) body.tags = tags;
    const r = await call('POST', '/api/questions', body);
    const q = r.question;
    console.log(`올림: ${q.id} (#${q.message_seq}) — 마스터가 질문함에서 답하면 이 방에 지시 글이 와서 다시 불림. 이 턴은 여기서 끝낼 것.`);
    if (r.superseded?.length) console.log(`대체함(앞 질문 닫힘): ${r.superseded.join(', ')}`);
    return;
  }
  if (cmd === 'close') {
    if (!args.length) die('질문 id 가 필요함');
    const qid = args.shift();
    const body = { reason: opt(args, '--reason', 'answered_in_chat') };
    const ans = opt(args, '--answer');
    const by = opt(args, '--by-msg');
    const item = opt(args, '--item');
    if (ans !== undefined) body.answer = ans;
    if (by !== undefined) body.by_msg_seq = Number(String(by).replace(/^#/, ''));
    if (item !== undefined) body.item = Number(item) - 1;
    if (args.length) die(`모르는 인자: ${args.join(' ')}`);
    const r = await call('POST', `/api/questions/${encodeURIComponent(qid)}/close`, body);
    console.log(`내림: ${qid} 문항 ${r.closed_items.map((i) => i + 1).join(', ')} · 질문 상태 ${r.question.status}`);
    return;
  }
  if (cmd === 'list') {
    const st = flag(args, '--closed') ? 'closed' : flag(args, '--all') ? 'all' : 'open';
    const thread = opt(args, '--thread');
    const qs = (await call('GET', `/api/questions?status=${st}${thread ? `&thread_id=${encodeURIComponent(thread)}` : ''}`)).questions;
    if (!qs.length) console.log('(없음)');
    for (const q of qs) show(q);
    return;
  }
  if (cmd === 'show') {
    if (!args.length) die('질문 id 가 필요함');
    show((await call('GET', `/api/questions/${encodeURIComponent(args[0])}`)).question);
    return;
  }
  die(`모르는 명령: ${cmd} — bs-ask --help`);
}

await main(process.argv.slice(2));
