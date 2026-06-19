# 배포 가이드 (GitHub Actions + Cloudflare Pages)

이 문서대로 따라 하면 **PC를 켜두지 않아도** 매일 자동으로 경쟁사를 크롤링하고,
누구나 접속 가능한 공개 주소(URL)로 대시보드를 볼 수 있습니다.

## 전체 그림

```
[GitHub Actions]  매일 오전 8시(한국시간) 자동 크롤링 + Gemini 분석
       │           → 결과(public/data/*.json)를 GitHub에 자동 저장(커밋)
       ▼
[GitHub 저장소]   코드 + 데이터 보관
       │           → 변경되면 Cloudflare가 자동으로 다시 배포
       ▼
[Cloudflare Pages]  대시보드를 공개 URL로 표시 (https://xxx.pages.dev)
```

- **크롤링**은 GitHub의 컴퓨터가 대신 돌립니다 → 내 PC 꺼져 있어도 됨
- **수정 배포**: 코드를 고쳐서 GitHub에 올리면(`git push`) Cloudflare가 자동 재배포

---

## 준비물 (각각 무료)

1. **GitHub 계정** — https://github.com
2. **Cloudflare 계정** — https://dash.cloudflare.com
3. **Google AI Studio API 키** — https://aistudio.google.com/apikey (이미 보유)
4. **Git 설치** — https://git-scm.com/download/win (설치 시 기본값으로 다음만 누르면 됨)

> ⚠️ 계정 만들기·로그인·결제수단 등록은 **직접** 해주세요. (보안상 제가 대신 못 합니다)

---

## STEP 1. 코드를 GitHub에 올리기

### 1-1) GitHub에서 빈 저장소 만들기
- https://github.com/new 접속
- Repository name: `competitor-dashboard` (아무 이름)
- **Private** 선택 (코드·데이터 비공개 권장. 대시보드 공개와는 별개)
- 아래 옵션들은 **체크하지 말고** 초록색 **Create repository** 클릭

### 1-2) 내 PC 코드를 올리기 (cmd에 한 줄씩 붙여넣기)
명령 프롬프트(cmd)를 열고:

```
cd /d C:\competitor
```
```
git init
```
```
git add .
```
```
git commit -m "최초 업로드"
```
```
git branch -M main
```

다음 줄의 `사용자명/저장소명`만 본인 것으로 바꿔서 붙여넣기 (1-1에서 만든 주소):

```
git remote add origin https://github.com/사용자명/저장소명.git
```
```
git push -u origin main
```

→ 로그인 창이 뜨면 GitHub 계정으로 로그인하면 업로드됩니다.

> ✅ API 키가 든 `.env` 파일은 자동으로 제외(업로드 안 됨)되도록 설정돼 있어 안전합니다.

---

## STEP 2. Gemini API 키를 GitHub에 비밀값으로 등록

크롤링을 GitHub 컴퓨터가 돌리려면 키가 필요합니다. **코드가 아니라 비밀 저장소**에 넣습니다.

1. GitHub 저장소 페이지 → 상단 **Settings**
2. 왼쪽 메뉴 **Secrets and variables** → **Actions**
3. 초록색 **New repository secret**
4. Name 에 정확히 `GEMINI_API_KEY` 입력
5. Secret 에 구글 AI Studio 키 붙여넣기 → **Add secret**

---

## STEP 3. 크롤링 자동화 테스트 (수동 1회 실행)

1. 저장소 페이지 → 상단 **Actions** 탭
2. (처음이면 "I understand my workflows, go ahead" 버튼 클릭)
3. 왼쪽 **경쟁사 크롤링 (매일 자동)** 클릭
4. 오른쪽 **Run workflow** → **Run workflow** 클릭
5. 2~3분 기다리면 초록색 체크(✓)가 뜹니다
   - 성공하면 `public/data/latest.json` 이 새로 커밋됩니다
   - 빨간 X가 뜨면 클릭해서 로그 확인 (보통 STEP 2의 키 문제)

이후로는 **매일 오전 8시(한국시간)에 자동 실행**됩니다.

---

## STEP 4. Cloudflare Pages로 대시보드 공개하기

1. https://dash.cloudflare.com 로그인
2. 왼쪽 메뉴 **Workers & Pages** → **Create** → **Pages** 탭 → **Connect to Git**
3. GitHub 연결 승인 후, STEP 1에서 만든 저장소 선택 → **Begin setup**
4. **빌드 설정**을 아래처럼 입력 (중요):
   - Framework preset: **None**
   - Build command: **(비워두기)**
   - Build output directory: **public**
5. **Save and Deploy** 클릭
6. 1~2분 후 `https://프로젝트명.pages.dev` 주소가 생성됩니다 → 점주들에게 이 주소 공유

---

## STEP 5. 끝! 앞으로는 자동

- **매일 오전 8시**: GitHub가 크롤링 → 데이터 갱신 → Cloudflare가 자동 재배포 → 대시보드 최신화
- **디자인/코드 수정**: 파일을 고친 뒤 cmd에서 아래 3줄이면 자동 재배포

```
cd /d C:\competitor
```
```
git add . && git commit -m "수정"
```
```
git push
```

---

## 참고

### 경쟁사 추가
`config.js`의 `competitors` 배열에 객체를 추가하고 `git push` 하면 됩니다.
(사이트마다 이벤트 URL 구조가 다를 수 있어 확인 필요)

### 크롤링 시간 변경
`.github/workflows/crawl.yml`의 `cron: '0 23 * * *'` 값을 수정.
GitHub는 UTC 기준이라 **한국시간 - 9시간**으로 적습니다. (예: 한국 08시 = UTC 23시)

### 내 PC에서 미리 보기 / 수동 테스트 (선택)
```
cd /d C:\competitor
```
```
node server.js
```
→ http://localhost:3000 접속. 이 화면에서는 "지금 실행" 버튼으로 즉시 크롤링 테스트 가능.
(공개 대시보드에는 자동 수집이므로 이 버튼이 표시되지 않습니다.)
