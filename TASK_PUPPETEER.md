# TASK: Puppeteer 크롤러 전환 명세

## 배경
대상 사이트 `https://www.itall.com`이 SPA(추정 React/Vue)라서 `axios + cheerio`로는
JavaScript 실행 전 빈 HTML만 읽힘. raw HTML은 94,998자지만 실제 추출 콘텐츠는 477자에 불과.
→ Puppeteer로 실제 브라우저 렌더링 후 DOM을 읽어야 함.

## 사전 작업
사용자가 `npm install puppeteer` 실행 중. (Chromium 동봉 다운로드, 3~5분 소요)
- 만약 설치 용량/속도 문제 시 대안: `puppeteer-core` + 시스템 크롬 경로 지정, 또는 `playwright`.
- Windows 환경이므로 첫 실행 시 Chromium 경로/권한 문제 확인.

## 구현 요구사항

### 1. 크롤링 대상
- 메인 페이지: `https://www.itall.com`
- 이벤트 목록: `https://www.itall.com/events?tab=published&page=1`
- **각 이벤트 게시글 상세 페이지까지 진입** (목록에서 링크 수집 → 순회)
- 페이지네이션 가능성 고려 (`page=1,2,...`) — 우선 1페이지부터, 필요 시 확장

### 2. Puppeteer 기본 패턴
```js
const puppeteer = require('puppeteer');

async function withBrowser(fn) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
}

async function renderPage(browser, url) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/124');
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  // 동적 콘텐츠 대기 — 실제 셀렉터로 교체
  // await page.waitForSelector('.event-list', { timeout: 10000 }).catch(() => {});
  const html = await page.content();
  await page.close();
  return html;
}
```

### 3. 이벤트 링크 수집 (page.evaluate 권장)
```js
const links = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('a[href]'))
    .map(a => a.href)
    .filter(h => /\/event/i.test(h));  // 실제 URL 패턴에 맞게 조정
});
```
**주의: 실제 셀렉터/URL 패턴은 F12로 확인 후 확정해야 함.** itall.com 구조를 직접 열어 검증할 것.

### 4. 성능/안전
- 브라우저 인스턴스는 1개 재사용 (매 페이지마다 launch 금지).
- 페이지 간 요청 간격 유지 (기존 detail 500ms, 경쟁사 1500ms 유지/조정).
- 상세 페이지는 최대 5~10개로 제한 (과도 크롤링 방지).
- try/catch로 개별 페이지 실패가 전체를 막지 않게.

### 5. 기존 함수 교체 대상 (server.js)
- `fetchPage(url)` → Puppeteer `renderPage` 기반으로
- `crawlMainPage` / `crawlEventList` / `crawlEventDetail` → Puppeteer 사용
- `crawlCompetitor` → 브라우저 1개 열어서 위 함수들에 전달, 끝나면 close
- cheerio는 렌더링된 HTML 파싱용으로 계속 써도 됨 (page.content() → cheerio.load)

## 검증 방법
1. `node server.js` → "지금 실행" 클릭
2. 콘솔에서 `분석: 잇올스파르타 (콘텐츠 XXXX자)` 의 숫자가 **수천 자 이상**으로 증가하는지 확인
3. 대시보드에 실제 이벤트/프로모션이 카드로 표시되는지 확인
4. JSON 파싱 오류(`분석 오류: JSON 없음`)가 사라지는지 확인

## 동반 수정: Gemini JSON 잘림 (문제 B)
콘텐츠 양이 늘면 더 자주 발생할 수 있음.
- `maxOutputTokens`를 2048 → 4096~8192로 상향
- 입력 콘텐츠 `.slice(0, 3000)` → 정제 후 더 크게 (단 입력 토큰 한도 주의)
- 노이즈(메뉴/푸터/반복문구) 제거해서 신호 대 잡음비 개선
- 파싱은 이미 `{`~`}` 추출 방식 적용됨. 그래도 실패 시 1회 재요청(retry) 로직 추가 검토.

## 완료 정의 (Definition of Done)
- [ ] 이벤트 목록 + 상세 콘텐츠가 수천 자 단위로 수집됨
- [ ] Gemini가 유효한 JSON 반환 (파싱 오류 없음)
- [ ] 대시보드에 실제 프로모션/대응방안이 표시됨
- [ ] 서버 재시작/데이터 초기화 절차 사용자에게 안내됨
