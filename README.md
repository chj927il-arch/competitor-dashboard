# 경쟁사 모니터링 대시보드

경쟁 학원 홈페이지를 매일 자동 크롤링하고, Claude AI로 마케팅 현황을 분석해
점주 대응방안까지 자동 생성하는 대시보드입니다.

## 파일 구조

```
competitor-dashboard/
├── server.js        # Express 서버 + 크롤러 + Claude 분석
├── config.js        # 경쟁사 URL 설정 (여기만 수정)
├── dashboard.html   # 대시보드 UI
├── package.json
├── .env             # API 키 (직접 생성)
└── data/
    ├── latest.json  # 최근 분석 결과
    └── history.json # 전체 이력
```

## 설치 및 실행

### 1. 의존성 설치
```bash
npm install
```

### 2. 환경변수 설정
```bash
cp .env.example .env
# .env 파일을 열어 ANTHROPIC_API_KEY 입력
```

### 3. 경쟁사 URL 설정
`config.js` 파일에서 경쟁사 정보를 수정하세요:
```js
competitors: [
  {
    id: 'competitor_a',
    name: '대성학원',
    url: 'https://실제-학원-URL.com',
    focusSelectors: ['#promotion', '.event-banner', 'h1', 'h2'],
  },
  // ...
]
```

**focusSelectors 팁**: 브라우저 개발자 도구(F12)로 경쟁사 홈페이지의
프로모션, 이벤트 배너 영역의 CSS 셀렉터를 확인해서 넣으면 정확도가 올라갑니다.

### 4. 서버 실행
```bash
# 일반 실행
npm start

# 개발용 (파일 변경 시 자동 재시작)
npm run dev
```

### 5. 대시보드 접속
```
http://localhost:3000
```

## 기능

- **자동 크롤링**: 매일 오전 8시 자동 실행 (config.js에서 변경 가능)
- **수동 실행**: 대시보드 상단 "지금 실행" 버튼
- **AI 분석**: 프로모션 감지 / 변경사항 비교 / 점주 대응방안 생성
- **긴급도 표시**: high / medium / low 3단계
- **히스토리**: 30일치 이력 보관 및 날짜별 조회

## 크롤링 스케줄 변경

`config.js`의 `crawlSchedule` 값을 cron 형식으로 수정:
```
'0 8 * * *'     → 매일 오전 8시
'0 8,18 * * *'  → 매일 오전 8시, 오후 6시
'0 9 * * 1-5'   → 평일 오전 9시
```

## 주의사항

- 과도한 크롤링은 IP 차단 위험이 있습니다. 하루 1~2회를 권장합니다.
- 일부 사이트는 JavaScript로 렌더링되어 cheerio로 크롤링이 안 될 수 있습니다.
  그 경우 Puppeteer를 추가로 사용해야 합니다.
- Anthropic API 사용 비용이 발생합니다 (경쟁사 5개 기준 하루 약 $0.05~0.15).
