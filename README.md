# Poker Pilot

iPad를 테이블 중앙에 두고 사용하는 로컬 우선 노리밋 텍사스 홀덤 테이블 매니저입니다. 실물 카드는 사용하되 프로필 잔액, 바이인, 블라인드, 행동 순서, 메인/사이드팟과 최종 정산을 앱이 관리합니다.

## 실행

```bash
npm install
npm run dev
```

같은 네트워크의 iPad에서 개발 서버 주소로 접속합니다. 프로덕션 빌드는 `npm run build`, 규칙 엔진 테스트는 `npm test`로 실행합니다.

## 데이터와 설치

- 모든 프로필, 진행 중인 게임과 기록은 브라우저의 로컬 저장소에 보관됩니다.
- 서버 계정, 결제 및 송금 기능은 없습니다.
- 프로덕션 사이트를 Safari에서 연 뒤 **공유 → 홈 화면에 추가**를 선택하면 PWA처럼 실행할 수 있습니다.
- 처음 한 번 온라인에서 연 뒤에는 서비스 워커가 앱 파일을 캐시합니다.

브라우저 데이터 삭제나 기기 변경 시 기록도 사라지므로 중요한 정산은 별도로 보관해야 합니다.

## Docker Compose 배포

호스트에 설치된 Tailscale을 통해 접속할 수 있도록 실행합니다.

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

기본 접속 주소는 `http://<호스트의 Tailscale IP>:4173`입니다. 외부 인터페이스에
노출하지 않고 Tailscale 인터페이스에만 바인딩하려면 `.env`에 호스트의 Tailscale
IP를 지정합니다.

```dotenv
POKER_PILOT_BIND=100.x.x.x
POKER_PILOT_PORT=4173
```
