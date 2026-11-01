#!/bin/bash
# 서버(Debian/Ubuntu · systemd · Node 22)에서 root 로 실행. 인자: 빌드된 저장소를 풀어 둔 디렉터리(dist/ 포함).
# 여러 번 돌려도 된다(업데이트). 데이터·설정·패스프레이즈는 건드리지 않는다.
set -euo pipefail
SRC=${1:?usage: install.sh <src-dir>}
cd "$SRC"
[ -f dist/src/server.js ] || { echo "dist/ 가 없다 — 먼저 npm run build" >&2; exit 1; }

# node 실제 자리 — 유닛·brainstorm-admin 의 `/usr/bin/env node` 를 이 경로로 바꿔 깐다
NODE=$(command -v node) || { echo "node 가 PATH 에 없다 — Node 22 를 깔고 다시" >&2; exit 1; }
case "$NODE" in
  /*) ;;
  *) echo "node 경로가 절대 경로가 아니다: $NODE" >&2; exit 1 ;;
esac
case "$NODE" in
  *[[:space:]#\&]*) echo "node 경로에 쓸 수 없는 글자가 있다: $NODE" >&2; exit 1 ;;
esac
# 서비스는 ProtectHome=yes 로 돈다 — 홈 아래 node(nvm 등)는 서비스 계정에 안 보인다
case "$(readlink -f "$NODE")" in
  /root/*|/home/*) echo "node 가 홈 아래에 있다($NODE) — 서비스가 못 읽는다. /usr/local 등에 깔고 다시" >&2; exit 1 ;;
esac
# put <모드> <원본> <대상> — node 경로를 넣어 깐다
put() { sed "s#/usr/bin/env node#$NODE#" "$2" >"$3"; chmod "$1" "$3"; }

id brainstorm >/dev/null 2>&1 || useradd --system --home-dir /var/lib/brainstorm --no-create-home --shell /usr/sbin/nologin brainstorm

install -d -o root -g root -m 755 /opt/brainstorm
rm -rf /opt/brainstorm/dist /opt/brainstorm/public /opt/brainstorm/deploy
cp -a dist public deploy package.json package-lock.json README.md /opt/brainstorm/
chown -R root:root /opt/brainstorm
(cd /opt/brainstorm && npm ci --omit=dev --no-audit --no-fund --loglevel=error)

install -d -o brainstorm -g brainstorm -m 750 /var/lib/brainstorm /var/lib/brainstorm/attachments /var/lib/brainstorm/backups
install -d -o root -g root -m 755 /etc/brainstorm
# 새 설치의 설정 본: 이 배치 전용 deploy/brainstorm.local.env 가 있으면 그것, 없으면 일반 본
ENVSRC=deploy/brainstorm.env; [ -f deploy/brainstorm.local.env ] && ENVSRC=deploy/brainstorm.local.env
[ -f /etc/brainstorm/brainstorm.env ] || install -o root -g brainstorm -m 640 "$ENVSRC" /etc/brainstorm/brainstorm.env

put 755 deploy/bin/brainstorm-admin /usr/local/bin/brainstorm-admin
install -m 755 deploy/bin/brainstorm-backup deploy/bin/brainstorm-restore /usr/local/bin/
put 644 deploy/systemd/brainstorm.service /etc/systemd/system/brainstorm.service
put 644 deploy/systemd/brainstorm-backup.service /etc/systemd/system/brainstorm-backup.service
install -m 644 deploy/systemd/brainstorm-backup.timer /etc/systemd/system/
# 에이전트 어댑터 템플릿 — 유닛만 깐다. 인스턴스는 켜지 않는다(README «에이전트 붙이기»)
put 644 deploy/systemd/brainstorm-agent@.service /etc/systemd/system/brainstorm-agent@.service
install -d -o root -g root -m 700 /etc/brainstorm/agents
systemctl daemon-reload

# 첫 설치: 마스터 등록 + 초기 패스프레이즈를 root 전용 파일로 (화면에 안 찍는다)
PASS=/root/brainstorm-initial-passphrase.txt
TMP=$(mktemp /root/.bs-pass.XXXXXX)
ERR=$(mktemp /root/.bs-init-err.XXXXXX)
chmod 600 "$TMP" "$ERR"
set +e
/usr/local/bin/brainstorm-admin init >"$TMP" 2>"$ERR"
rc=$?
set -e
if [ $rc -eq 0 ]; then
  mv "$TMP" "$PASS"; chmod 600 "$PASS"; chown root:root "$PASS"
  echo "마스터 등록됨. 초기 패스프레이즈: $PASS (root 전용, 600)"
elif [ $rc -eq 3 ]; then
  rm -f "$TMP"; echo "이미 초기화됨 — 패스프레이즈 그대로"
else
  rm -f "$TMP"; cat "$ERR" >&2; rm -f "$ERR"; echo "init 실패 rc=$rc" >&2; exit 1
fi
rm -f "$ERR"

chmod 640 /var/lib/brainstorm/brainstorm.db* 2>/dev/null || true

systemctl enable brainstorm.service brainstorm-backup.timer
systemctl restart brainstorm.service
# 켜져 있는 에이전트 어댑터는 새 코드로 다시 띄운다(없으면 아무것도 안 한다)
for u in $(systemctl list-units --plain --no-legend --state=active 'brainstorm-agent@*.service' | awk '{print $1}'); do
  systemctl restart "$u"
done
systemctl start brainstorm-backup.timer
sleep 2
systemctl --no-pager --lines=0 status brainstorm.service | head -5
