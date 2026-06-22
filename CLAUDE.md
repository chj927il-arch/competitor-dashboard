# CLAUDE.md

이 파일은 Claude Code가 이 저장소에서 작업할 때 자동으로 읽는 프로젝트 지침입니다.

## 프로젝트 한 줄 요약
학원 프랜차이즈 본사용 경쟁사 홈페이지 모니터링 대시보드. 매일 크롤링 → Gemini 분석 → 웹 표시.

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
- **배포 구조 구축 완료.** GitHub Actions(매일 크롤) + Cloudflare Pages(대시보드 공개). 상세: `DEPLOY.md`.

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
        "promotions": [{ "title": "", "detail": "", "period": "" }],
        "changes": [{ "type": "", "description": "" }],
        "recommendations": [{ "action": "", "detail": "", "priority": "high|medium|low" }],
        "urgency": "high|medium|low",
        "urgencyReason": ""
      }
    }
  ]
}
```
대시보드 UI가 이 스키마에 의존하므로 필드명 변경 시 dashboard.html도 함께 수정.
