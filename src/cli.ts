#!/usr/bin/env node
// 관리 CLI — CT 안에서 brainstorm 계정으로 돈다 (배포에서는 /usr/local/bin/brainstorm-admin 래퍼).
// 토큰 원문은 발급할 때 한 번만 표준출력으로 나온다. DB에는 해시만.
// 이 CLI 로 한 민감 작업(토큰 발급·폐기, 참여자 등록, 멤버 변경, 세션 교체, 웹 세션 …)은 작업자 'cli:root' 로 감사 기록에 남는다.
import fs from 'node:fs';
import { backup, restore } from './backup.js';
import { loadConfig } from './config.js';
import { generatePassphrase } from './crypto.js';
import { openDb } from './db.js';
import { CLI_ACTOR, Store, type Principal } from './store.js';

const USAGE = `brainstorm-admin <명령>

  init [--master-id ID] [--master-name 이름]
        DB를 만들고 마스터를 등록한다. 패스프레이즈를 새로 만들어 «표준출력으로만» 낸다
        (배포 스크립트가 root 전용 파일로 돌린다). 이미 있으면 아무것도 안 한다.
  set-passphrase            표준입력 첫 줄을 마스터 패스프레이즈로 (12자 이상). 기존 웹 세션은 끊긴다
  logout-all                모든 웹 세션을 끊는다
  websession create [--minutes N]
        마스터 웹 세션(쿠키 값)을 하나 만들어 «표준출력으로 한 번만» 낸다. 시험 스크립트용, 기본 60분·최대 1일
  websession revoke         표준입력 첫 줄의 웹 세션 하나만 끊는다

  participant add --id ID --name 이름 [--kind agent|human]
  participant list
  participant rename --id ID --name 새이름      표시명만 바꾼다 (id·토큰·기록은 그대로)
  participant disable --id ID                  끄고 숨긴다: 토큰 폐기·세션 은퇴·멤버 해제 (글·감사는 그대로)
  participant purge --id ID                    완전 삭제: 꺼진 참여자만 · 남은 글·만든 스레드가 없을 때만 (감사는 그대로)

  token create --participant ID [--scope adapter] [--label 메모] [--expires-days N]
        토큰 원문을 한 번만 출력한다
  token list
  token revoke <credential-id>

  member set --thread TH --participant ID [--no-read] [--no-post] [--remove]
  thread list
  sessions rotate --thread TH --agent ID [--reason 이유]

  request-pair list                              에이전트 간 요청 허용 짝(방향 있음 · 마스터 #352)
  request-pair add --from ID --to ID             from 이 to 에게 «요청→»을 바로 낼 수 있게 한다
  request-pair remove --from ID --to ID          (더하기·빼기는 작업자 cli:root 로 감사에 남는다)

  audit list [--limit N] [--action 유형|접두.*] [--actor ID] [--result ok|requested|noop|denied|failed]
        감사 기록을 최근 것부터 (이 조회도 작업자 cli:root 로 감사에 남는다)

  backup [--out DIR]
  restore <tarball>         (서비스를 멈춘 뒤에. 옛 대기 작업은 다시 돌리지 않는다)
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function has(args: string[], name: string) {
  return args.includes(name);
}
function need(v: string | undefined, name: string): string {
  if (!v) {
    console.error(`${name} 가 필요하다\n\n${USAGE}`);
    process.exit(2);
  }
  return v;
}

async function main() {
  const [cmd, sub, ...rest] = process.argv.slice(2);
  const args = [sub, ...rest].filter((x) => x !== undefined) as string[];
  const cfg = loadConfig();

  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(USAGE);
    return;
  }
  if (cmd === 'backup') {
    console.log(await backup(cfg, flag(args, '--out') ?? cfg.backupsDir));
    return;
  }
  if (cmd === 'restore') {
    const r = restore(cfg, need(sub, 'tarball'));
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  const db = openDb(cfg.dbPath);
  const store = new Store(db, cfg);
  const masterPrincipal = (): Principal => {
    const m = store.getMaster();
    if (!m) throw new Error('마스터가 없다 — init 먼저');
    return { participant: m, via: 'cookie', scopes: ['admin'], actor: CLI_ACTOR };
  };
  const out = (x: unknown) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2));

  try {
    switch (cmd) {
      case 'init': {
        if (store.getMaster()) {
          console.error('이미 초기화됨 (마스터 있음). 패스프레이즈를 바꾸려면 set-passphrase');
          process.exit(3);
        }
        const id = flag(args, '--master-id') ?? 'master';
        const name = flag(args, '--master-name') ?? 'master';
        store.createParticipant(id, 'human', name, true);
        const pass = generatePassphrase();
        store.setPassphrase(id, pass);
        process.stdout.write(pass + '\n');
        break;
      }
      case 'set-passphrase': {
        const line = fs.readFileSync(0, 'utf8').split('\n')[0].trim();
        store.setPassphrase(masterPrincipal().participant.id, line);
        console.error('패스프레이즈를 바꿨다. 기존 웹 세션은 끊겼다.');
        break;
      }
      case 'websession':
        if (sub === 'create') {
          const w = store.createWebSessionForMaster(Number(flag(args, '--minutes') ?? 60));
          console.error(`마스터 웹 세션 — ${new Date(w.expiresAt).toISOString()} 까지. 값은 지금 한 번만 보인다:`);
          process.stdout.write(w.sessionToken + '\n');
        } else if (sub === 'revoke') {
          store.logout(fs.readFileSync(0, 'utf8').split('\n')[0].trim(), CLI_ACTOR);
          console.error('끊었다.');
        } else throw new Error(USAGE);
        break;
      case 'logout-all':
        out({ removed: store.logoutAll() });
        break;
      case 'participant':
        if (sub === 'add') {
          const kind = (flag(args, '--kind') ?? 'agent') as 'agent' | 'human';
          if (kind === 'human') throw new Error('1단계에서 사람 참여자는 마스터 하나뿐이다');
          out(store.createParticipant(need(flag(args, '--id'), '--id'), kind, need(flag(args, '--name'), '--name')));
        } else if (sub === 'list') out(store.listParticipants());
        else if (sub === 'rename') out(store.renameParticipant(need(flag(args, '--id'), '--id'), need(flag(args, '--name'), '--name')));
        else if (sub === 'disable') out(store.disableParticipant(need(flag(args, '--id'), '--id')));
        else if (sub === 'purge') out(store.purgeParticipant(need(flag(args, '--id'), '--id')));
        else throw new Error(USAGE);
        break;
      case 'token':
        if (sub === 'create') {
          const scope = (flag(args, '--scope') ?? 'adapter').split(',');
          const days = flag(args, '--expires-days');
          const t = store.createToken(need(flag(args, '--participant'), '--participant'), {
            scope,
            label: flag(args, '--label'),
            expiresInDays: days ? Number(days) : undefined,
          });
          console.error(`credential ${t.id} (participant=${t.participant_id}, scope=${t.scope.join(',')}) — 토큰은 지금 한 번만 보인다:`);
          process.stdout.write(t.token + '\n');
        } else if (sub === 'list') out(store.listTokens());
        else if (sub === 'revoke') out({ revoked: store.revokeToken(need(rest[0], 'credential-id')) });
        else throw new Error(USAGE);
        break;
      case 'member':
        if (sub !== 'set') throw new Error(USAGE);
        out(
          store.setMember(masterPrincipal(), need(flag(args, '--thread'), '--thread'), {
            participant_id: need(flag(args, '--participant'), '--participant'),
            can_read: !has(args, '--no-read'),
            can_post: !has(args, '--no-post'),
            remove: has(args, '--remove'),
          }).members,
        );
        break;
      case 'audit': {
        if (sub !== 'list') throw new Error(USAGE);
        const r = store.listAudit(masterPrincipal(), {
          limit: flag(args, '--limit') ?? '50',
          action: flag(args, '--action'),
          actor: flag(args, '--actor'),
          result: flag(args, '--result'),
        });
        out({
          total: r.total,
          entries: r.entries.map((e) => ({
            id: e.id,
            at: new Date(e.requested_at).toISOString(),
            actor: e.actor_id,
            action: e.action,
            target: e.target_id ? `${e.target_type}:${e.target_id}` : null,
            thread: e.thread_id,
            result: e.result,
            reason: e.reason,
            repeat: e.repeat_count > 1 ? e.repeat_count : undefined,
            corr: e.corr_id,
          })),
        });
        break;
      }
      case 'request-pair':
        if (sub === 'list') out(store.listRequestPairs());
        else if (sub === 'add' || sub === 'remove')
          out(store.setRequestPair(masterPrincipal(), need(flag(args, '--from'), '--from'), need(flag(args, '--to'), '--to'), sub === 'add'));
        else throw new Error(USAGE);
        break;
      case 'thread':
        if (sub !== 'list') throw new Error(USAGE);
        out(store.listThreads(masterPrincipal()).map((t) => ({ id: t.id, title: t.title, parent: t.parent_thread_id, paused: t.invoke_paused })));
        break;
      case 'sessions':
        if (sub !== 'rotate') throw new Error(USAGE);
        out(
          store.rotateSession(masterPrincipal(), need(flag(args, '--thread'), '--thread'), {
            agent_id: need(flag(args, '--agent'), '--agent'),
            reason: flag(args, '--reason') ?? 'admin-cli',
          }),
        );
        break;
      default:
        console.error(USAGE);
        process.exit(2);
    }
  } catch (e) {
    console.error(`오류: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

await main();
