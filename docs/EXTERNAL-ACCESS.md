# 외부 접속 배선 — brainStorm 을 깐 에이전트가 읽는 문서

brainStorm 은 **기본으로 이 기계 안에서만 열린다**(`127.0.0.1:8080`). 다른 기기(폰·다른 PC·인터넷)에서 쓰려면 배선을 하나 붙여야 하고,
어떤 배선을 붙일지는 **사용자가 정한다.** 이 문서는 그 결정을 사용자에게 묻고, 고른 배선을 붙이고, 확인하는 순서다.

> 서버가 지키는 선: `BRAINSTORM_LISTEN` 에 루프백(`127.x`·`::1`·`localhost`) 밖 주소가 있으면 **`BRAINSTORM_ALLOW_EXTERNAL=1` 없이는 시작하지 않는다.**
> 앞단(Tailscale serve·리버스 프록시)이 같은 기계에서 `127.0.0.1:8080` 으로 넘겨 주는 배선은 이 값이 필요 없다.

## 1. 사용자에게 물을 것

에이전트는 아래를 정하지 말고 **물어서 받는다**. 선택지마다 추천을 붙여 한 번에 묻는다.

1. **어디서 쓰나** — 이 기계에서만 / 집·사무실 같은 내부망 / 밖(폰 데이터·다른 장소)
2. **누가 쓰나** — 사용자 혼자(brainStorm 의 로그인은 마스터 한 명 · 패스프레이즈) / 여럿(지금 판은 사람 계정이 하나라 앞단에서 사람을 걸러야 한다)
3. **이미 쓰는 것** — Tailscale·WireGuard 같은 VPN, Cloudflare·nginx·Caddy 같은 앞단, 도메인이 있나
4. **HTTPS** — 폰 PWA 설치·`Secure` 쿠키에는 HTTPS 가 필요하다. 인증서를 어디서 받나(앞단이 주는가)

추천 기본값: **밖에서 쓰면 VPN(B) · VPN 을 못 쓰면 인증 앞단(C) · 인터넷에 맨몸으로 여는 것(D 를 공인 주소로)은 권하지 않는다.**

## 2. 배선

### A. 이 기계에서만 (기본 · 아무것도 안 함)

`BRAINSTORM_LISTEN=127.0.0.1:8080` 그대로. 브라우저로 `http://127.0.0.1:8080/`.

### B. VPN 안에서 (추천 — 예: Tailscale)

brainStorm 은 루프백에 둔 채로 VPN 이 HTTPS 로 넘겨 준다. 서버 설정은 Origin 하나만 더한다.

```bash
tailscale serve --bg --https=443 http://127.0.0.1:8080      # root · 끄기: tailscale serve --https=443 off
```

```ini
# /etc/brainstorm/brainstorm.env
BRAINSTORM_ORIGINS=https://<기계이름>.<테일넷>.ts.net,http://127.0.0.1:8080
BRAINSTORM_SECURE_COOKIE=auto
```

VPN 에 든 기기만 닿는다. 패스프레이즈 로그인은 그대로 걸린다. `tailscale funnel`(인터넷 공개)은 쓰지 않는다 — 그건 D 다.

### C. 인증 앞단 뒤에서 (밖에 열어야 할 때)

리버스 프록시가 **먼저 사람을 걸러** 허용한 사람만 brainStorm 으로 넘긴다. 예: Cloudflare Access(메일 일회용 코드는 따로 설정 없이 · 구글 로그인은 GCP 에 OAuth 클라이언트가 필요하다) ·
oauth2-proxy · Authelia · Caddy/nginx + 기본 인증. brainStorm 은 루프백에 두고 앞단이 같은 기계(또는 터널)에서 `127.0.0.1:8080` 으로 넘긴다.

```ini
BRAINSTORM_ORIGINS=https://<도메인>,http://127.0.0.1:8080
BRAINSTORM_TRUSTED_PROXIES=127.0.0.1
BRAINSTORM_SECURE_COOKIE=auto
```

- WebSocket(`/ws`)을 넘겨야 한다(nginx 면 `Upgrade`/`Connection` 헤더).
- 앞단이 걸러도 brainStorm 의 패스프레이즈 로그인은 그대로다 — 두 겹이다. 앞단의 신원을 brainStorm 이 믿는 기능은 이 판에 없다.
- 업로드 크기: 앞단 본문 한도를 `BRAINSTORM_ATTACHMENT_MAX_BYTES`(기본 20MB)보다 크게.
- `BRAINSTORM_TRUSTED_PROXIES` 에는 앞단의 주소(같은 기계면 `127.0.0.1`)를 둔다. 안 두면 모든 요청이 앞단 IP 로 보여 로그인 실패 잠금이 모두에게 함께 걸리고 감사 IP 가 앞단 것이 된다. TLS 를 앞단이 끝내면 `auto` 는 `X-Forwarded-Proto` 를 믿어야 `Secure` 를 붙인다 — 앞단이 그 머리를 넘기는지 확인한다. 앞단이 **다른 기계**면 brainStorm 이 루프백만 들어서는 닿지 않는다 — `BRAINSTORM_ALLOW_EXTERNAL=1` · `BRAINSTORM_LISTEN=127.0.0.1:8080,<서버 IP>:8080` 을 두고, 서버 방화벽으로 8080 을 앞단 기계에만 연다.

### D. 내부망에서 직접 (앞단 없이)

같은 내부망 기기에서 IP 로 바로 연다. **공인 주소로는 하지 않는다.**

```ini
BRAINSTORM_ALLOW_EXTERNAL=1
BRAINSTORM_LISTEN=127.0.0.1:8080,<내부망 IP>:8080
BRAINSTORM_ORIGINS=http://<내부망 IP>:8080,http://127.0.0.1:8080
```

평문 HTTP 라 쿠키에 `Secure` 가 안 붙고 폰 PWA 설치가 안 될 수 있다. 방화벽으로 내부망만 받게 둔다.

## 3. 붙인 뒤 확인

1. `systemctl restart brainstorm` 뒤 `journalctl -u brainstorm -n 20` — 시작 오류(`루프백 밖 주소` 등)가 없나
2. `curl -s http://127.0.0.1:8080/healthz` → `{"ok":true,…}`
3. 사용자가 고른 기기에서 그 주소로 열어 로그인 → 글 하나 보내기 → 새로고침 뒤 실시간 갱신(WebSocket)이 되나. Origin 이 빠지면 로그인은 되는데 글쓰기가 403 이다
4. 막혀야 할 곳에서 막히나 — B 면 VPN 을 끈 기기, C 면 앞단 로그인 전, D 면 내부망 밖
5. 사용자에게 결과(주소 · 고른 배선 · 끄는 법)를 알린다

## 4. 되돌리기

설정 파일에서 더한 줄을 지우고(`BRAINSTORM_LISTEN=127.0.0.1:8080` 으로) 재시작한다. B 는 `tailscale serve --https=443 off`, C 는 앞단의 그 경로를 내린다.
