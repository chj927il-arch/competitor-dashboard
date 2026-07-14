# CLAUDE.md

이 파일은 Claude Code가 이 저장소에서 작업할 때 자동으로 읽는 프로젝트 지침입니다.

## 프로젝트 한 줄 요약
이투스 ECI(학원 프랜차이즈 본사)용 경쟁사 홈페이지 분석 자동화 대시보드. 매주 금요일 크롤링 → Gemini 분석 → 웹 표시.
- **공개 URL**: https://competitor-dashboard.chj927il.workers.dev (Cloudflare Workers, 정적 호스팅)
- **저장소**: github.com/chj927il-arch/competitor-dashboard (Git 연동 → push 시 Cloudflare 자동 재배포)

## 현재 모니터링 대상 (config.js, 5개사)
- **잇올스파르타** (itall_sparta) — SPA, 이벤트 상세 `/events/{id}` 링크 크롤
- **대성디랩** (daesung_dlab) — `eventApi`로 이벤트 JSON 직접 수집(`/api/notice-event/...`), 상세 `/about/events/{id}`
- **수만휘스파르타** (sumanhui_sparta) — 아임웹, 공지 '이벤트' 카테고리. `detailLinkPattern: 'bmode=view'`, `listWaitSelector`
- **수능선배** (suneungsunbae) — 검색·카테고리 없는 공지 게시판. `noticeList`로 `/notification` 목록의 `yearFilter`(2026) 글만 `/notificationRead?id=N` 상세 수집(상세 URL 세션 불필요 → 대시보드 링크 그대로 사용). Gemini가 운영공지 제외하고 마케팅성만 promotions로 추림. 통계 키컬러 검정(#000, 다크모드 가시성 위해 막대 테두리·텍스트 테마색 처리).
- **이투스247학원** (etoos247, `isSelf:true` 자사) — 별도 프로모션 페이지 없음. `noticeSearch`로 공지사항을 '제목+내용'(`sch_search_key=3`)으로 키워드(마케팅·이벤트) 검색 → `yearFilter` 연도 글만 `fn_view`로 본문 수집. 개별 글 URL은 세션 필요해 외부 접근 불가 → 링크는 공지 목록으로 통일.
- 사이드바 분류는 `public/index.html`의 `MENU` 상수에서 관리: 자사>(이투스247), 학원>독학재수학원>(3사), 스터디카페>작심스터디카페(준비중, 데이터 없음)
- **자사 처리**: `isSelf`면 Gemini가 promotions만 채우고 recommendations/키워드는 빈 배열. 상세 화면은 프로모션만 전체폭 표시. 통계 '학원별 마케팅 유형'에서 각 경쟁사 카드가 자사 대비 비교 막대로 표시되고 자사 기준 카드가 맨 앞에 배치됨(시기별/전체 키워드 분포는 경쟁사 기준).

## 운영 흐름 (중요)
- 코드/UI 수정 후: `git pull origin main --no-edit && git add -A && git commit -m "..." && git push` → Cloudflare 자동 재배포
- **데이터 변경이 필요한 수정**(monitor.js/config.js)은 재크롤링해야 반영됨: 로컬 `node crawl.js` 후 push, 또는 GitHub Actions에서 Run workflow
- push 거부(rejected) 시: Actions가 데이터를 먼저 커밋한 것 → `git pull origin main --no-edit` 후 다시 push
- 브라우저 캐시로 옛 화면 보이면: 시크릿 창 또는 URL 뒤 `?v=숫자`

## 절대 지켜야 할 규칙

1. **AI 모델은 Google Gemini 2.5 Flash만 사용.** Anthropic SDK 절대 쓰지 말 것. 사용자에게 Anthropic API 키 없음.
2. **API 키는 `.env`의 `GEMINI_API_KEY`로만.** 코드/로그/커밋/문서에 절대 노출 금지.
3. **한글 파일 작성 시 반드시 UTF-8.** cmd `echo`로 한글 파일 쓰면 깨짐. 에디터/파일도구로 직접 작성.
4. **사용자는 비개발자 + Windows + 한국어.** 모든 명령어는 복붙 가능한 단일 라인. 설명은 쉽게.
5. **파일 수정 후 서버 재시작 안내 필수.** `Ctrl+C` → `node server.js`.
6. **데이터 스키마 변경 시 `data/*.json` 삭제 안내.**

## 완료된 작업
- **cheerio → Puppeteer 전환 완료.** itall.com이 SPA라 Puppeteer로 렌더 후 추출 (콘텐츠 477자 → 13,000자+).
  - ⚠️ puppeteer 25는 `headless: 'new'` 안 됨 → `headless: true` 사용.
  - 이벤트 상세 링크 패턴: `/events/{숫자 또는 해시}` 둘 다 수집.
- **배포 구조 구축 완료.** GitHub Actions(주1회 크롤) + Cloudflare(대시보드 공개). 상세: `DEPLOY.md`.
- **대시보드 기능**: 사이드바(분류 메뉴, 업체 클릭=해당 업체 상세, 접기 토글 `toggleSidebar`) / 종합 리포트 / 통계(학원별 키워드 분류·시기별 월 분포·전체 키워드). ('오늘 현황'·'히스토리' 메뉴 제거 — 업체 상세가 곧 현황이고, 상세 상단 '크롤 기록' 셀렉터(`detailDate`)로 과거 크롤 열람. 내부 view 이름은 여전히 'today', 렌더는 `renderToday`).
- **히스토리 보관/누적**: `saveToHistory`가 크롤 원문(`crawl.content`/`index`) 제거(`trimRecord`) 후 최근 300주 보관 → 통계가 매주 누적됨(파일 경량). 리포트는 별도 `reports.json`(200건). `config.retentionDays`는 미사용.
- **종합 리포트**(`renderReport`, view 'report'): 경쟁사 4사를 종합 분석해 자사 대응 전략 1장 생성. 구성 ①자사 vs 경쟁사 비교(통계 데이터 기반 카테고리×업체 표 + AI 비교요약/경쟁사 브리프) ②종합 마케팅 키워드(추천대응·선제)+예시 5개 개조식 ③점주 대응방안 6+ ④결론. PDF는 `window.print()`(@media print), 워드는 `application/msword` Blob 다운로드. 리포트 데이터는 `latest.json`의 `report` 필드(`monitor.js`의 `generateReport`가 크롤 때 생성, carry-forward). 재크롤 없이 갱신하려면 `node scripts/genreport.js`.
  - 다크모드 기본 + Pretendard, 글래스모피즘, SVG 라인 아이콘, 스파크라인.
  - 긴급도(urgency) 알럿 표시는 **UI에서 제거**(데이터엔 남아있음).
- **프로모션 → 정확한 상세 URL 매칭**: AI에 의존하지 않고 `monitor.js`의 `matchDetailUrl`/`fixPromoUrls`가 크롤한 상세페이지(index) 제목과 매칭해 url 보정. ⚠️ `normK`는 한글 보존 정규식 사용(`[^가-힣a-z0-9]`).
- **분석 실패 시 carry-forward**: 직전 정상 분석 유지(`analyzeOrCarry`), Gemini 503 등은 최대 4회 재시도. maxOutputTokens 16384.
- **점주 대응방안**: 원장님께 권하는 친근체("~해요/~어때요"). 상세 제목은 "원장님, 이렇게 하는 것을 추천합니다". **마케팅 키워드** `responseKeywords`(대응)·`proactiveKeywords`(선제) — 각 예시는 `{text, by:"본사"|"가맹점"}` 분류(본사=지원형 "~지원 중입니다", 가맹점=권유형 "~해보세요"), 리포트에서 본사 먼저 정렬. 재크롤 없이 문체만 바꾸려면 `scripts/genreport.js`(리포트)·`scripts/recos-to-gaejosik.js`(학원별 대응방안 재작성).
- **역할 로그인(간이)**: `public/index.html`의 `ACCESS_CODES`에 본사(`etoossuper`→hq)·가맹점(`etoos247`→fc). localStorage `role` 저장(새로고침 유지, 사이드바 '전환'으로 해제). 가맹점(fc)은 종합리포트에서 **선제적 키워드·인사이트 총정리 숨김**.
- **본사 요청 메일**: 가맹점 리포트의 추천대응 키워드 각 예시에 「본사 요청」 버튼 → `worker.js`의 `/api/notify`(POST)가 **Resend API**로 발송(수신 `chj927il@etoos.com`, 본문 "테스트"). Cloudflare Secret **`RESEND_API_KEY`** 필요(`npx wrangler secret put`로 등록됨). `wrangler.toml`에 `main=worker.js`+`[assets] binding=ASSETS`. Gemini와 무관(별개 서비스).
- **통계 차트 색(키컬러)**: `chartColorOf` — 이투스247 `#FF8329`(주황,자사 강조+네온), 잇올 `#C40F06`, 수만휘 `#12B886`, 대성디랩 `#FFD43B`, 수능선배 `#4C6EF5`. 막대그래프(빈도 비교)·카드·시기별 목록 좌측 라인 동일 적용. 자사 텍스트/숫자도 주황.
- **커뮤니티 모니터링**(`renderCommunity`, view 'community'): 사업팀이 수기 작성하는 엑셀(오르비·수만휘·포만한 등 5개 학원 언급 글) → `scripts/import-community.ps1`(PowerShell, xlsx=zip 직접 파싱, [바로가기] 하이퍼링크에서 실제 URL 추출, `없음`/작성글없음 행 제외)이 `public/data/community.json` 생성. **AI 비용 0**(수기 데이터 표시만). 네트워크 폴더 `Y:\VOL1\Cloud_가맹사업성장실_사업팀\커뮤니티 모니터링\2026`에서 **가장 최신 xlsx 자동 선택**. UI: 브랜드/커뮤니티/반응/기간/검색 필터(상단 sticky 고정), 브랜드 배지=통계 키컬러. 새로고침 버튼은 로컬(`server.js /api/community/refresh`)에서만 폴더 반영, 배포 사이트에선 재fetch만. 원클릭 갱신+배포는 `커뮤니티_업데이트.bat`(Cloudflare는 Y: 접근 불가하므로 반드시 로컬 PC에서 변환·푸시). ⚠️ ps1은 UTF-8 BOM 필요(PS5.1 한글), 셀 참조 속성은 `r`(ref 아님).

## 명령어
```bash
node server.js     # 로컬 테스트 서버 (http://localhost:3000)
node crawl.js      # 크롤링 1회 실행 (Actions가 쓰는 진입점)
git add . && git commit -m "수정" && git push   # 수정 배포 (Cloudflare 자동 재배포)
```

## 아키텍처
- `lib/monitor.js` — **핵심 로직**: Puppeteer 크롤러 + Gemini 분석 + 저장. server/crawl 공용.
- `crawl.js` — GitHub Actions가 실행하는 1회 진입점.
- `server.js` — 로컬 테스트용 얇은 Express 서버 (public/ 정적 서빙 + 수동 실행 API).
- `config.js` — 경쟁사 설정 (UTF-8, 여기만 수정해서 경쟁사 추가).
- `public/index.html` — vanilla JS 단일파일 UI. 정적 JSON(`./data/*.json`)을 직접 읽음.
- `public/data/latest.json`, `history.json` — 결과 저장 (DB 없음). **Actions가 커밋하므로 git에 포함됨.**
- `.github/workflows/crawl.yml` — 매주 금요일 15:00 KST 자동 크롤 워크플로우.

## 데이터 위치 주의
데이터는 `public/data/`에만 있음 (옛 루트 `data/`는 삭제됨). 초기화: `del C:\competitor\public\data\*.json`

## 데이터 스키마 (data/latest.json)
```json
{
  "date": "2026-06-19",
  "createdAt": "ISO timestamp",
  "competitors": [
    {
      "id": "itall_sparta",
      "name": "잇올스파르타",
      "url": "https://www.itall.com",
      "crawl": { "success": true, "content": "...", "crawledAt": "..." },
      "analysis": {
        "summary": "한줄요약",
        "promotions": [{ "title": "", "detail": "", "period": "", "url": "정확한 상세페이지" }],
        "changes": [{ "type": "신규|종료|변경", "description": "" }],
        "recommendations": [{ "action": "", "points": ["개조식 음슴체 항목"] }],
        "responseKeywords": ["추천 대응 마케팅 키워드"],
        "proactiveKeywords": ["선제적 마케팅 키워드"],
        "urgency": "high|medium|low",
        "urgencyReason": ""
      }
    }
  ]
}
```
대시보드 UI(`public/index.html`)가 이 스키마에 의존하므로 필드명 변경 시 함께 수정.
- 옛 데이터 호환: `recommendations[].detail`(문자열) 있으면 대시보드가 줄 단위로 글머리 분해. `points` 우선.
