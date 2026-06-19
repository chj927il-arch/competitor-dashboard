# 경쟁사 모니터링 대시보드 — 인수인계 문서

> 이 문서는 클로드 코드(Claude Code)가 이 프로젝트를 이어받아 작업하기 위한 전체 맥락 문서입니다.
> 작업자는 **개발 비전문가**입니다. 명령어는 복붙 가능한 형태로, 설명은 쉽게 제공하세요.

---

## 1. 프로젝트 목적

학원 프랜차이즈 본사(이투스ECI)에서 **경쟁 학원의 홈페이지를 매일 자동 모니터링**하고,
마케팅·프로모션 현황을 AI로 분석해서 **가맹 점주들에게 대응방안을 제공**하는 웹 대시보드.

### 핵심 흐름
```
매일 자동 크롤링 → Gemini AI 분석 → JSON 저장 → 웹 대시보드 표시
```

---

## 2. 기술 스택 (확정된 결정사항)

| 구분 | 선택 | 비고 |
|---|---|---|
| 백엔드 | Node.js + Express | 작업자 선호 |
| 프론트 | HTML 단일파일 (dashboard.html) | SPA 프레임워크 없이 vanilla JS |
| AI | **Google Gemini 2.5 Flash** | Anthropic 아님! 작업자가 구글 AI Studio 키 보유 |
| 크롤링 | cheerio → **Puppeteer로 전환 중** | 아래 4번 참조 |
| 저장 | JSON 파일 (data/latest.json, data/history.json) | DB 없음 |
| 스케줄 | node-cron (매일 08:00) | |
| 운영 환경 | **Windows 로컬 PC** | 사용자 폴더: `C:\competitor` |

### 환경변수 (.env)
```
GEMINI_API_KEY=AIza...   # 구글 AI Studio 키
```
- `dotenv` 패키지로 로드. server.js 최상단에 `require('dotenv').config();` 필수.

---

## 3. 현재 작동 상태 (✅ 완료된 것)

- [x] Node.js 설치, npm install 완료
- [x] 서버 실행 → `http://localhost:3000` 정상 구동
- [x] `.env`에서 Gemini API 키 로드 성공 (`injected env (1) from .env`)
- [x] 대시보드 UI 정상 (라이트/다크 모드 토글, 경쟁사 이름 크게, 프로모션/변경사항 2열 병렬)
- [x] 한글 인코딩 정상 (config.js를 UTF-8로 직접 작성, cmd `echo` 사용 금지)
- [x] Gemini 분석 호출 자체는 성공

### 현재 모니터링 대상 (config.js)
- **잇올스파르타** 1개만 등록 (종로학원, 이투스247은 작업자 요청으로 일단 제외)
- 메인: `https://www.itall.com`
- 이벤트: `https://www.itall.com/events?tab=published&page=1`

---

## 4. ⚠️ 현재 막힌 지점 (다음 작업) — 가장 중요

### 문제 A: SPA라서 cheerio 크롤링 실패
- `https://www.itall.com`은 **React/Vue 기반 SPA(Single Page Application)**로 추정됨.
- `axios.get()`으로 받은 raw HTML 길이는 **94,998자**로 크지만, JavaScript 실행 전이라
  실제 콘텐츠(이벤트 목록, 프로모션)가 DOM에 없음.
- cheerio로 추출 시 **477자**밖에 안 나옴 → 분석 품질 저하.

**→ 해결책: Puppeteer로 전환 (진행 중)**
- 작업자가 `npm install puppeteer` 실행하는 중에 이관됨.
- Puppeteer는 실제 Chromium을 띄워 JS 실행 후 렌더링된 DOM을 읽음.
- **다음 작업: server.js의 crawl 함수들을 Puppeteer 기반으로 재작성해야 함.**

#### 요구사항 (작업자가 명시함)
1. `https://www.itall.com/events?tab=published&page=1` 이벤트 목록 페이지를 읽어야 함
2. **각 이벤트 게시글 상세 페이지에도 진입**해서 내용 파악해야 함
3. 페이지네이션(`page=1, 2, ...`) 고려 필요할 수 있음

### 문제 B: Gemini JSON 응답이 중간에 잘림
- 콘솔 로그상 `"promotions": [ {` 까지 출력되다 끊김 → `maxOutputTokens` 부족 또는 파싱 실패.
- 현재 `responseMimeType: 'application/json'` + `maxOutputTokens: 2048` 설정됨.
- 입력 콘텐츠를 `.slice(0, 3000)`으로 자르고 있음 → Puppeteer로 콘텐츠 양이 늘면 재조정 필요.
- **권장: maxOutputTokens를 4096~8192로 상향, 입력은 핵심만 정제해서 전달.**

---

## 5. 파일 구조

```
C:\competitor\
├── server.js          # 핵심: Express + 크롤러 + Gemini 분석 + 스케줄러
├── config.js          # 경쟁사 URL/셀렉터 설정 (여기만 수정해서 경쟁사 추가)
├── dashboard.html     # 대시보드 UI (단일 파일, vanilla JS)
├── package.json
├── .env               # GEMINI_API_KEY (git에 올리면 안 됨)
├── .env.example
├── data/
│   ├── latest.json    # 최신 분석 결과
│   └── history.json   # 30일 이력
└── node_modules/
```

---

## 6. 하네스 엔지니어링 가이드라인 (클로드 코드 작업 규칙)

### 6.1 작업자 특성
- **비개발자.** 터미널/코드에 익숙하지 않음.
- Windows + cmd 환경. 명령어는 **복붙 가능한 단일 라인**으로 제공.
- 스크린샷으로 소통. 에러가 나면 화면을 캡처해서 보냄.
- 한국어로 소통.

### 6.2 절대 규칙
1. **config.js를 cmd `echo`로 쓰지 말 것.** → 한글이 깨짐(`◆υý◆◆κ◆Ÿ`).
   반드시 에디터로 UTF-8 저장하거나, 파일 생성 도구로 직접 작성.
2. **API 키를 코드/로그/문서에 절대 노출 금지.** `.env`로만 관리.
3. **Anthropic SDK 사용 금지.** 이 프로젝트는 Gemini를 씀. (작업자에게 Anthropic 키 없음)
4. 파일 수정 후엔 항상 **서버 재시작(`Ctrl+C` → `node server.js`)**이 필요함을 안내.
5. 데이터 스키마 변경 시 `data/*.json` 삭제 안내 (`del C:\competitor\data\latest.json`).

### 6.3 디버깅 체크리스트
크롤링이 빈약할 때 순서대로 의심:
1. SPA 여부 → raw HTML엔 있는데 cheerio 추출이 적으면 SPA. Puppeteer 필요.
2. 셀렉터 부정확 → 브라우저 F12로 실제 클래스명 확인.
3. 동적 로딩 → 스크롤/클릭/대기(`waitForSelector`) 필요.
4. robots.txt / 봉쇄 → User-Agent, 요청 간격(`setTimeout`) 조정.

### 6.4 크롤링 윤리/안전
- 요청 간격을 두어 서버 부하 방지 (현재 detail 간 500ms, 경쟁사 간 1500ms).
- 하루 1~2회만 (cron `0 8 * * *`).
- 과도한 동시 요청 금지.

---

## 7. 다음 작업 우선순위 (TODO)

1. **[최우선] Puppeteer 크롤러 작성**
   - `crawlMainPage`, `crawlEventList`, `crawlEventDetail`을 Puppeteer 기반으로 교체
   - `page.goto(url, { waitUntil: 'networkidle2' })` 후 `page.content()` 또는 `page.evaluate()`로 추출
   - 이벤트 목록 → 각 상세 링크 수집 → 상세 진입 순회
   - Windows에서 Puppeteer 첫 실행 시 Chromium 다운로드 확인

2. **Gemini JSON 안정화**
   - maxOutputTokens 상향, 응답 파싱 견고화 (코드블록 제거 + `{`~`}` 추출 이미 적용됨)
   - 입력 정제: 메뉴/푸터 노이즈 제거 후 핵심 텍스트만 전달

3. **전일 대비 변경 감지 고도화**
   - 현재는 prevContent 전체를 비교용으로 넘김. diff 로직 개선 여지.

4. **경쟁사 확장**
   - 잇올스파르타 완성 후 종로학원, 이투스247 등 재추가 (config.js에 객체 추가만)
   - 사이트마다 셀렉터/이벤트 URL 구조 다름 주의.

5. **(선택) 상시 운영**
   - 현재는 cmd 창 닫으면 서버 종료. PM2 또는 Windows 작업 스케줄러로 상시화 검토.

---

## 8. 참고: 핵심 코드 위치

- 크롤링 로직: `server.js`의 `crawlMainPage` / `crawlEventList` / `crawlEventDetail` / `crawlCompetitor`
- AI 분석: `server.js`의 `analyzeWithGemini` (프롬프트 + Gemini REST 호출)
- 스케줄: `server.js` 하단 `cron.schedule`
- API 엔드포인트: `/api/latest`, `/api/history`, `/api/history/:date`, `/api/run`, `/api/status`
- UI 렌더링: `dashboard.html`의 `renderToday` / `renderDetail` / `renderHistory`

### Gemini 호출 형식 (REST, SDK 아님)
```
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=API_KEY
body: {
  contents: [{ parts: [{ text: prompt }] }],
  generationConfig: { temperature: 0.1, maxOutputTokens: 2048, responseMimeType: 'application/json' }
}
응답: response.data.candidates[0].content.parts[0].text
```
