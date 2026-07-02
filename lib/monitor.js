// ── 경쟁사 모니터링 핵심 로직 (크롤링 + Gemini 분석 + 저장) ──
// server.js(로컬 테스트)와 crawl.js(GitHub Actions) 양쪽에서 공용으로 사용.
// express/cron 같은 서버 코드는 여기 두지 않음.
require('dotenv').config();
const axios = require('axios');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const config = require('../config');

// 데이터는 public/data 에 저장 → Cloudflare Pages가 그대로 서빙하고 Actions가 커밋함
const DATA_DIR = path.join(__dirname, '..', 'public', 'data');

// ── 유틸 ──
function getTodayKey() { return new Date().toISOString().slice(0, 10); }

function loadData(filename) {
  const fp = path.join(DATA_DIR, filename);
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function saveData(filename, data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2), 'utf8');
}

function loadHistory() { return loadData('history.json') || []; }

// 저장 시 무거운 크롤 원문(content/index)은 제거 — 대시보드·통계는 analysis만 사용
function trimRecord(record) {
  return {
    ...record,
    competitors: (record.competitors || []).map(c => ({
      ...c,
      crawl: c.crawl ? { success: c.crawl.success, crawledAt: c.crawl.crawledAt, error: c.crawl.error } : c.crawl,
    })),
  };
}
function saveToHistory(record) {
  const slim = trimRecord(record);
  const history = loadHistory().map(trimRecord);
  // 같은 날짜 재수집이면 교체
  const filtered = history.filter(r => r.date !== slim.date);
  filtered.unshift(slim);
  saveData('history.json', filtered.slice(0, 300)); // 통계 누적: 최근 300주(약 6년)까지 보관
  saveData('latest.json', slim);
}

// ── Puppeteer 헬퍼 ──
// 대상 사이트(itall.com)가 SPA(React/Next)라 JS 실행 후 렌더된 DOM을 읽어야 함.
// 주의: puppeteer 25에서는 headless 값으로 'new' 문자열이 아닌 true 를 써야 함.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// 이벤트 상세 링크 패턴: /events/{숫자 또는 해시}. 목록 자체(/events)는 제외.
const EVENT_DETAIL_RE = /\/events\/[A-Za-z0-9]+(?:[/?#]|$)/i;

async function withBrowser(fn) {
  const browser = await puppeteer.launch({
    headless: true,
    timeout: 90000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });
  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
}

// 한 페이지를 렌더링하고 본문 텍스트 + 링크 목록을 추출
async function renderPage(browser, url, waitSelector) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent(UA);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    // 동적 콘텐츠 대기 (셀렉터가 안 떠도 진행)
    if (waitSelector) await page.waitForSelector(waitSelector, { timeout: 8000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));
    return await page.evaluate(() => {
      // 메뉴/푸터 노이즈 제거 후 본문만
      document.querySelectorAll('nav, footer, header, script, style, noscript').forEach(el => el.remove());
      const text = (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').trim();
      const links = Array.from(document.querySelectorAll('a[href]')).map(a => a.href);
      const heading = (document.querySelector('h1, h2, .title, .subject')?.innerText || '').trim();
      return { text, links, title: (document.title || '') + ' ' + heading };
    });
  } finally {
    await page.close();
  }
}

// ── 이벤트 API에서 구조화된 이벤트 목록 수집 (정확한 상세 URL 포함) ──
const HTML_TAG = /<[^>]+>/g;
async function fetchEventApi(competitor) {
  try {
    const res = await axios.get(competitor.eventApi.url, { timeout: 20000, headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
    const items = res.data?.data?.content || res.data?.data || res.data?.content || [];
    const tmpl = competitor.eventApi.detailUrlTemplate;
    const statusMap = { ONGOING: '진행중', ENDED: '종료', SCHEDULED: '예정', CLOSED: '마감' };
    return (Array.isArray(items) ? items : []).map(it => {
      const period = [it.startedAt, it.dueAt || it.endedAt].filter(Boolean).map(s => String(s).slice(0, 10)).join(' ~ ');
      const body = String(it.contents || '').replace(HTML_TAG, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
      return {
        url: tmpl.replace('{id}', it.id),
        title: it.title || '',
        period,
        status: statusMap[it.eventProgressStatus] || it.eventProgressStatus || '',
        body,
      };
    }).filter(e => e.title);
  } catch (e) {
    return [];
  }
}

// ── 공지사항 검색형 크롤러 (자사 이투스247: 별도 프로모션 페이지 없음) ──
// 공지 목록에서 '제목+내용'으로 키워드 검색 → 지정 연도 글만 fn_view로 본문 수집.
// 상세글 직접 URL은 세션이 필요해 외부에서 안 열리므로, 링크는 공지 목록 페이지로 통일.
async function crawlNoticeSearch(browser, competitor) {
  const ns = competitor.noticeSearch;
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  const sections = [];
  const index = [];
  const seen = new Set();
  const targets = [];
  try {
    for (const kw of ns.keywords) {
      await page.goto(ns.listUrl, { waitUntil: 'networkidle2', timeout: 45000 });
      await new Promise(r => setTimeout(r, 800));
      await page.evaluate((key, val) => {
        const f = document.forms['form_post_list'];
        f.sch_search_key.value = key; f.sch_search_val.value = val; f.curr_page.value = '1'; f.submit();
      }, ns.searchKey || '3', kw);
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 800));
      const rows = await page.evaluate(() => {
        const out = [];
        document.querySelectorAll('table tbody tr').forEach(tr => {
          const a = tr.querySelector('a[href^="javascript:fn_view"]');
          if (!a) return;
          const m = a.getAttribute('href').match(/fn_view\(\s*'(\d+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'/);
          if (!m) return;
          const txt = tr.innerText.replace(/\s+/g, ' ').trim();
          const dm = txt.match(/(20\d{2})\.(\d{2})\.(\d{2})/);
          out.push({ seq: m[1], branch: m[2], bbs: m[3], date: dm ? dm[0] : '', title: txt.replace(/^(공지|\d+)\s*/, '').replace(/\s*20\d{2}\.\d{2}\.\d{2}\s*$/, '').trim() });
        });
        return out;
      });
      rows.filter(r => !ns.yearFilter || r.date.startsWith(ns.yearFilter))
        .forEach(r => { if (!seen.has(r.seq)) { seen.add(r.seq); targets.push({ ...r, kw }); } });
    }
    sections.push(`[검색 조건] 키워드 "${ns.keywords.join('", "')}" (제목+내용) · 대상 연도 ${ns.yearFilter || '전체'} · 수집 ${targets.length}건`);

    for (const t of targets.slice(0, ns.maxDetails || 20)) {
      await new Promise(r => setTimeout(r, 400));
      try {
        await page.goto(ns.listUrl, { waitUntil: 'networkidle2', timeout: 45000 });
        await page.evaluate((seq, branch, bbs) => window.fn_view(seq, branch, bbs), t.seq, t.branch, t.bbs);
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 600));
        const detail = await page.evaluate(() => {
          document.querySelectorAll('nav, footer, header, script, style, noscript').forEach(el => el.remove());
          return (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').trim();
        });
        const body = detail.slice(0, 1500);
        sections.push(`[공지 ${t.date}] ${t.title}\n${body}`);
        index.push({ url: competitor.url, title: t.title, text: body });
      } catch (e) {
        sections.push(`[공지 수집 오류] ${t.title}: ${e.message}`);
      }
    }
    return { success: true, index, content: sections.join('\n\n---\n\n'), crawledAt: new Date().toISOString() };
  } catch (err) {
    return { success: false, error: err.message, crawledAt: new Date().toISOString() };
  } finally {
    await page.close();
  }
}

// ── 공지목록형 크롤러 (수능선배: 검색·카테고리 없음. 목록의 2026년 글을 모아 마케팅성만 분석) ──
// 상세 URL(/notificationRead?id=N)이 세션 없이 직접 열려 대시보드 링크로 그대로 사용.
async function crawlNoticeList(browser, competitor) {
  const nl = competitor.noticeList;
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  const sections = [];
  const index = [];
  try {
    await page.goto(nl.listUrl, { waitUntil: 'networkidle2', timeout: 45000 });
    if (nl.waitSelector) await page.waitForSelector(nl.waitSelector, { timeout: 8000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));
    const posts = await page.evaluate((pat) => {
      const rx = new RegExp(pat, 'i');
      const map = new Map();
      document.querySelectorAll('a[href]').forEach(a => {
        const href = a.href; // 절대 URL
        if (!rx.test(href)) return;
        const txt = (a.innerText || '').replace(/\s+/g, ' ').trim();
        const dm = txt.match(/(20\d{2})\.(\d{2})\.(\d{2})/);
        const prev = map.get(href);
        if (!prev || txt.length > prev.txt.length) map.set(href, { url: href, txt, date: dm ? dm[0] : '' });
      });
      return [...map.values()];
    }, nl.linkPattern);
    const targets = posts.filter(x => !nl.yearFilter || x.date.startsWith(nl.yearFilter)).slice(0, nl.maxDetails || 25);
    sections.push(`[공지 목록] ${nl.listUrl} · 대상 연도 ${nl.yearFilter || '전체'} · ${targets.length}건 (마케팅·프로모션 성격만 분석 대상)`);
    for (const t of targets) {
      await new Promise(r => setTimeout(r, 350));
      try {
        const d = await renderPage(browser, t.url);
        const title = (t.txt.replace(/^\[?\s*공지\s*\]?\s*/, '').replace(/수능선배\s*\|.*$/, '').replace(/\s*20\d{2}\.\d{2}\.\d{2}.*$/, '').trim()) || d.title;
        const body = (d.text || '').slice(0, nl.bodySlice || 450);
        sections.push(`[공지 ${t.date}] ${title}\n${body}`);
        index.push({ url: t.url, title, text: title + ' ' + body });
      } catch (e) {
        sections.push(`[공지 수집 오류] ${t.url}: ${e.message}`);
      }
    }
    return { success: true, index, content: sections.join('\n\n---\n\n'), crawledAt: new Date().toISOString() };
  } catch (err) {
    return { success: false, error: err.message, crawledAt: new Date().toISOString() };
  } finally {
    await page.close();
  }
}

// ── 통합 크롤링 (브라우저 1개 재사용) ──
async function crawlCompetitor(competitor) {
  return withBrowser(async (browser) => {
    if (competitor.noticeSearch) return crawlNoticeSearch(browser, competitor);
    if (competitor.noticeList) return crawlNoticeList(browser, competitor);
    try {
      const sections = [];
      const index = []; // {url, title, text} — 프로모션↔상세URL 정확 매칭용

      // 1) 메인 페이지
      const main = await renderPage(browser, competitor.url);
      if (main.text) sections.push(`[메인 페이지]\n${main.text.slice(0, 4000)}`);

      // 2) 이벤트 수집 — API가 있으면 API 우선(정확한 상세 URL/기간/내용 확보)
      if (competitor.eventApi) {
        const events = await fetchEventApi(competitor);
        if (events.length) {
          sections.push('[이벤트 목록(API)]\n' + events.map(e =>
            `• ${e.title} | 기간 ${e.period || '미상'} | 상태 ${e.status} | 상세: ${e.url}${e.body ? '\n  내용: ' + e.body : ''}`
          ).join('\n'));
          events.forEach(e => index.push({ url: e.url, title: e.title, text: e.title + ' ' + (e.body || '') }));
        }
      } else {
        // API가 없으면 이벤트 목록 페이지를 렌더링하고 상세 링크를 따라감
        // 사이트마다 상세 링크 패턴/대기 셀렉터가 달라 경쟁사별로 설정 가능 (없으면 잇올 기본값)
        const detailRe = competitor.detailLinkPattern ? new RegExp(competitor.detailLinkPattern, 'i') : EVENT_DETAIL_RE;
        const waitSel = competitor.listWaitSelector || 'a[href*="/events/"]';
        // 상세 링크 후보: 메인 페이지 + 이벤트 목록 페이지에서 모두 수집
        const candidates = new Set(main.links.filter(h => detailRe.test(h)));
        for (const evUrl of (competitor.eventUrls || [])) {
          try {
            const list = await renderPage(browser, evUrl, waitSel);
            if (list.text) sections.push(`[이벤트 목록: ${evUrl}]\n${list.text.slice(0, 2000)}`);
            list.links.filter(h => detailRe.test(h)).forEach(h => candidates.add(h));
          } catch (e) {
            sections.push(`[이벤트 페이지 오류: ${evUrl}] ${e.message}`);
          }
        }
        // 상세 진입 (최대 8개, 서버 부하 방지 위해 간격 두기)
        for (const link of [...candidates].slice(0, 8)) {
          await new Promise(r => setTimeout(r, 600));
          try {
            const detail = await renderPage(browser, link);
            if (detail.text) {
              sections.push(`[이벤트 상세: ${link}]\n${detail.text.slice(0, 2500)}`);
              index.push({ url: link, title: detail.title || '', text: detail.text.slice(0, 2500) });
            }
          } catch (e) {
            sections.push(`[이벤트 상세 오류: ${link}] ${e.message}`);
          }
        }
      }

      return {
        success: true,
        index,
        content: sections.join('\n\n---\n\n'),
        crawledAt: new Date().toISOString(),
      };
    } catch (err) {
      return { success: false, error: err.message, crawledAt: new Date().toISOString() };
    }
  });
}

// Gemini 호출 + JSON 파싱 (1회)
async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent?key=${apiKey}`;
  const res = await axios.post(url, {
    contents: [{ parts: [{ text: prompt }] }],
    // 출력이 잘려 JSON이 깨지는 것을 막기 위해 한도를 넉넉히
    generationConfig: { temperature: 0.1, maxOutputTokens: 16384, responseMimeType: 'application/json' },
  }, { timeout: 90000 });
  const raw = (res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('JSON 없음: ' + cleaned.slice(0, 80));
  return JSON.parse(cleaned.slice(start, end + 1));
}

// ── Gemini 분석 (실패 시 1회 재시도) ──
async function analyzeWithGemini(competitor, crawlResult, prevAnalysis) {
  // 지난번 감지된 프로모션 목록을 비교 기준으로 제공 (진짜 변경 감지용)
  const prevPromos = (prevAnalysis?.promotions || []);
  const hasPrev = prevPromos.length > 0;
  const changeCtx = hasPrev
    ? `\n\n[지난번 감지된 프로모션 목록 — 변경 비교 기준]\n${prevPromos.map(p => `- ${p.title} (${p.period || '기간미상'})`).join('\n')}`
    : '\n\n[지난번 데이터 없음 — 이번이 첫 수집이거나 비교 대상 없음]';

  const changeRule = hasPrev
    ? `위 [지난번 감지된 프로모션 목록]과 이번 [수집 데이터]를 비교해, 실제로 달라진 것만 적으세요.
     - 지난번 목록에 없던 새 프로모션 → type "신규"
     - 지난번엔 있었으나 이번 데이터에서 사라진 것 → type "종료"
     - 같은 프로모션인데 기간·혜택·조건이 바뀐 것 → type "변경"
     실제 변경이 없으면 빈 배열 []. 추측이나 일반적 코멘트는 넣지 마세요.`
    : `비교할 지난 데이터가 없으므로 "changes"는 반드시 빈 배열 [] 로 두세요.`;

  const isSelf = !!competitor.isSelf;
  const intro = isSelf
    ? `학원 프랜차이즈 마케팅 분석가로서, 자사(${competitor.name})가 진행 중인 프로모션/이벤트 데이터를 정리하세요. 이 데이터는 경쟁사와 비교하는 '자사 기준'으로 쓰입니다.`
    : `학원 프랜차이즈 마케팅 전략 분석가로서, 경쟁사(${competitor.name}) 홈페이지 수집 데이터를 분석하세요.`;
  const selfRule = isSelf
    ? `\n[자사 분석 규칙]\n- 자사 데이터이므로 "recommendations", "responseKeywords", "proactiveKeywords"는 모두 빈 배열 [] 로 두세요. (대응방안·대응 키워드는 경쟁사 대상에만 작성)\n- "promotions"에 자사가 진행 중/예정인 프로모션·이벤트를 빠짐없이 정리하세요.\n- "summary"에는 "데이터 정리" 같은 형식적 문구 대신, 자사가 현재 전개 중인 마케팅/이벤트의 핵심(주력 채널·대표 캠페인·성격)을 한 문장으로 요약하세요. 예) "MY247 앱 챌린지·농심 제휴 등 재원생 참여형 이벤트 중심으로 전개 중".`
    : '';

  const prompt = `${intro}

[수집 데이터]
${crawlResult.content.slice(0, 12000)}${changeCtx}

[변경사항(changes) 작성 규칙]
${changeRule}

[프로모션 선별 규칙]
- "promotions"에는 모집·이벤트·할인·혜택·신규 오픈·설명회 등 마케팅/홍보 성격의 글만 넣으세요.
- 단순 운영 공지(학사일정, 시험 접수·좌석 안내, 콘텐츠 구매 신청, 성적 확인 안내 등)는 promotions에서 제외하세요.

[프로모션 url 작성 규칙]
각 프로모션의 "url"에는, 그 프로모션의 정확한 출처(상세 페이지) 주소를 넣으세요.
- 수집 데이터에 "상세: https://..." 형태로 각 이벤트 제목 옆에 상세 주소가 적혀 있으면, 제목이 일치하는 그 주소를 **그대로 복사**해 넣으세요.
- "[이벤트 상세: https://...]" 형태의 주소도 사용할 수 있습니다.
- 제목이 일치하는 상세 주소를 찾을 수 없을 때만 "${competitor.url}" 을 넣으세요.

[점주 대응방안(recommendations) 작성 규칙]
- "points"는 개조식(음슴체, 명사형/'~함·~필요·~권장' 종결)으로 짧게 끊어 작성. 각 항목 1줄, 2~4개.
  예) "타깃 할인 프로모션 즉시 기획 필요", "무료체험 도입 검토 권장"

[마케팅 키워드 작성 규칙]
- "responseKeywords"(추천 대응 마케팅 키워드): 경쟁사의 현재 프로모션에 맞대응할 키워드 4~6개.
- "proactiveKeywords"(선제적 마케팅 키워드): 경쟁사보다 앞서 선제적으로 펼칠 만한 키워드 4~6개.
- 각 키워드는 {"keyword": "짧은 단어/구", "examples": [...]} 객체로 작성.
- "examples"에는 그 키워드로 학원 점주가 실제 어떤 마케팅을 펼치면 좋을지 구체적 실행 예시를 개조식(음슴체, 명사형/'~함·~필요·~권장' 종결)으로 **정확히 5개** 작성. 각 1줄, 서로 다른 채널·방식으로 다양하게.
  예) 키워드 "조기등록 할인" → ["7월 등록 시 수강료 15% 할인 배너 상단 게시 권장", "재원생 추천 시 추가 할인 쿠폰 지급 필요", "마감 임박 카운트다운으로 긴급성 강조함", "지역 맘카페에 한정 할인 홍보글 게재 권장", "문자·카톡으로 기존 상담고객에 할인 안내 발송 필요"]
${selfRule}

반드시 아래 JSON 형식으로만 응답하세요. 마크다운이나 코드블록 없이 순수 JSON만:
{
  "summary": "50자 이내 한줄 요약",
  "promotions": [{"title": "프로모션명", "detail": "상세설명", "period": "기간", "url": "출처 주소"}],
  "changes": [{"type": "신규|종료|변경", "description": "무엇이 어떻게 달라졌는지 구체적으로"}],
  "recommendations": [{"action": "대응방안 제목", "points": ["개조식 음슴체 실행항목"]}],
  "responseKeywords": [{"keyword": "대응 키워드", "examples": ["개조식 실행 예시 5개"]}],
  "proactiveKeywords": [{"keyword": "선제 키워드", "examples": ["개조식 실행 예시 5개"]}],
  "urgency": "high",
  "urgencyReason": "긴급도 판단 근거"
}`;

  // Gemini가 503(과부하)/타임아웃 등을 낼 수 있어 간격을 두고 최대 4회 재시도
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await callGemini(prompt);
    } catch (e) {
      lastErr = e;
      const status = e.response?.status;
      console.error(`  분석 시도 ${attempt}/4 실패 (status ${status || '-'}): ${e.message}`);
      if (attempt < 4) await new Promise(r => setTimeout(r, attempt * 5000)); // 5s, 10s, 15s 백오프
    }
  }
  throw lastErr;
}

function errorAnalysis(msg) {
  return { summary: msg.slice(0, 60), promotions: [], changes: [], recommendations: [], responseKeywords: [], proactiveKeywords: [], urgency: 'low', urgencyReason: '' };
}

// 프로모션 제목을 크롤한 상세 페이지와 직접 매칭해 정확한 URL을 찾음 (AI 의존 X)
function normK(s) { return (s || '').toLowerCase().replace(/[^가-힣a-z0-9]/g, ''); }
function matchDetailUrl(title, index) {
  const nt = normK(title);
  if (nt.length < 2 || !index || !index.length) return null;
  let best = null, score = 0;
  for (const e of index) {
    const ntitle = normK(e.title), ntext = normK(e.text);
    let s = 0;
    if (ntitle && (ntitle.includes(nt) || nt.includes(ntitle))) {
      s = 500 + Math.min(ntitle.length, nt.length); // 제목 일치(강함)
    } else {
      const toks = (title.match(/[가-힣A-Za-z0-9]{2,}/g) || []);
      if (toks.length) {
        const hit = toks.filter(t => ntext.includes(normK(t))).length;
        if (hit / toks.length >= 0.6) s = 100 + hit; // 본문에 제목 단어 60%+ 포함
      }
    }
    if (s > score) { score = s; best = e; }
  }
  return score > 0 ? best.url : null;
}
// 분석 결과 프로모션의 url을 '정확한 상세 페이지'로 보정 (없으면 학원 메인)
function fixPromoUrls(analysis, crawl, comp) {
  if (!analysis || !Array.isArray(analysis.promotions)) return analysis;
  for (const p of analysis.promotions) {
    const exact = matchDetailUrl(p.title, crawl.index);
    if (exact) p.url = exact;
    else if (!p.url) p.url = comp.url;
  }
  return analysis;
}

// 분석 실행 — 실패하면 직전 성공 결과를 그대로 유지(carry-forward)
async function analyzeOrCarry(comp, crawl, prevAnalysis) {
  // 직전 결과가 '내용 있는 정상 분석'일 때만 유지 대상으로 인정 (빈 오류는 제외)
  const prevUsable = prevAnalysis && Array.isArray(prevAnalysis.promotions) && prevAnalysis.promotions.length > 0
    ? prevAnalysis : null;

  if (!crawl.success) {
    if (prevUsable) { console.log(`  → 크롤링 실패, 직전 결과 유지: ${comp.name}`); return { ...prevUsable, stale: true, staleReason: '이번 수집 실패 — 직전 결과 표시' }; }
    console.error(`  크롤링 실패: ${crawl.error}`);
    return errorAnalysis('일시적으로 수집하지 못했습니다 — 다음 수집에서 다시 시도됩니다');
  }
  try {
    const analysis = await analyzeWithGemini(comp, crawl, prevAnalysis);
    return fixPromoUrls(analysis, crawl, comp); // 정확한 상세 URL로 보정
  } catch (e) {
    console.error(`  분석 오류: ${e.message}`);
    if (prevUsable) { console.log(`  → 분석 실패, 직전 결과 유지: ${comp.name}`); return { ...prevUsable, stale: true, staleReason: '이번 수집 분석 실패 — 직전 결과 표시' }; }
    return errorAnalysis('일시적인 분석 오류 — 다음 수집에서 다시 분석됩니다');
  }
}

// 본사(이투스ECI)가 가맹점에 제공 중인 지원 항목 (가맹점 지원 사례 정리 기반) — 선제적 키워드 '본사' 분류 기준
const HQ_SUPPORT = `- ECI입시센터: 입시 콘텐츠 공유(모평 실채점 지원참고표·상위누적표), 모의평가 분석 설명회 영상·자료 제공
- SNS·블로그 주간 게시 주제 가이드 배포
- 가맹점 대상 정책 지원(예: 학원 전면 리모델링 지원 사업)
- 마켓ECI: 교재·상품 공급(대성 D.LINK/D.FINE 등)
- 대입 수시 설명회 개최 지원
- LMS·MY247 APP 시스템 운영·업데이트
- 온라인사업본부: 인강강사 학원 비치 교재 배포·학습 로드맵, 인강강사 지점 방문 설명회 지원
- 운영 우수사례(우수지점 인사이트) 공유, 직원 교육(신규직원·SNS 활용)
- 본사 주관 통합 이벤트: 네이버 영수증 리뷰, 순공(MY247 앱 챌린지), 블로그 체험단 모집, 재원후기 공모전, 247프렌즈
- 신입생 OT팩 등 학원 운영 자료 제공`;

// ── 종합 리포트 생성 (전 경쟁사 분석을 종합해 자사 대응 전략 1장 도출) ──
async function generateReport(results) {
  const self = results.find(c => c.isSelf);
  const comps = results.filter(c => !c.isSelf && c.analysis?.promotions?.length);
  if (!comps.length) return null;

  const compBlock = comps.map(c => {
    const a = c.analysis || {};
    const promos = (a.promotions || []).map(p => `· ${p.title}${p.detail ? ' — ' + String(p.detail).slice(0, 80) : ''}`).join('\n');
    const rk = (a.responseKeywords || []).map(k => k.keyword || k).join(', ');
    const pk = (a.proactiveKeywords || []).map(k => k.keyword || k).join(', ');
    return `■ ${c.name}\n프로모션:\n${promos || '· 없음'}\n기존 추천 키워드: ${rk || '-'}\n기존 선제 키워드: ${pk || '-'}`;
  }).join('\n\n');

  const selfBlock = self
    ? `■ 자사(${self.name}) 진행 중 프로모션/이벤트:\n${(self.analysis?.promotions || []).map(p => `· ${p.title}`).join('\n') || '· 없음'}`
    : '■ 자사 데이터 없음';

  const prompt = `너는 학원 프랜차이즈(이투스 ECI) 본사의 마케팅 전략 책임자다. 아래 경쟁사 4사와 자사 데이터를 종합 분석해, 자사가 어떻게 프로모션을 기획하고 대응할지 '종합 전략 리포트' 1장을 작성하라.

[경쟁사 데이터]
${compBlock}

[자사 데이터]
${selfBlock}

[본사(이투스ECI)가 이미 가맹점에 제공 중인 지원 — 선제적 키워드 '본사' 분류의 참고]
${HQ_SUPPORT}

작성 지침:
- 모든 서술은 개조식(음슴체, 명사형/'~함·~필요·~권장' 종결)으로 간결하게.
- responseKeywords(추천 대응): 경쟁사 움직임에 맞대응할 종합 마케팅 키워드 5~6개. 각 키워드마다 실행 예시 5개(문자열).
- proactiveKeywords(선제적): 경쟁사보다 앞서 펼칠 종합 키워드 5~6개. 각 키워드마다 실행 예시 5개.
  · 선제적 키워드의 각 예시는 반드시 {"text": "개조식 예시", "by": "본사" 또는 "가맹점"} 형태로 분류.
  · "본사" = 큰 비용/많은 인력 소요, 전사 시스템·정책·콘텐츠 제작, 통합 이벤트 등 본사 차원이 필요한 것 (위 본사 지원 목록 성격 참고).
  · "가맹점" = 비용·인력 부담이 작고 개별 지점이 자체적으로 즉시 실행 가능한 것.
  · 두 유형이 한쪽에 치우치지 않게 골고루 분류.
- examples는 채널·방식이 서로 다르게 구체적으로.
- storeActions(점주 대응방안): 현장 점주가 즉시 실행할 항목을 **중요도 높은 순**으로 6개 이상 (앞 3개가 가장 핵심이 되도록).
- conclusion: 자사 프로모션 기획·대응의 핵심 방향 4~6개.

반드시 아래 JSON 형식으로만 응답(마크다운/코드블록 없이 순수 JSON):
{
  "comparisonSummary": "자사 대비 경쟁사 전반 비교 2~3문장",
  "competitorBriefs": [{"name": "경쟁사명", "point": "핵심 마케팅 특징·위협 한 줄(개조식)"}],
  "responseKeywords": [{"keyword": "키워드", "examples": ["개조식 예시 5개"]}],
  "proactiveKeywords": [{"keyword": "키워드", "examples": [{"text": "개조식 예시", "by": "본사"}, {"text": "개조식 예시", "by": "가맹점"}]}],
  "storeActions": ["개조식 점주 대응방안 6개 이상"],
  "conclusion": ["자사 프로모션 기획·대응 방향 4~6개"]
}`;

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await callGemini(prompt);
      r.generatedAt = new Date().toISOString();
      return r;
    } catch (e) {
      console.error(`  리포트 생성 시도 ${attempt}/4 실패: ${e.message}`);
      if (attempt < 4) await new Promise(r => setTimeout(r, attempt * 5000));
    }
  }
  return null;
}

// ── 리포트 아카이브 (history.json은 30일 보관·본문 무거움 → 리포트는 경량 파일에 장기 보관) ──
function lightCompetitors(results) {
  return (results || []).map(c => ({
    id: c.id, name: c.name, isSelf: !!c.isSelf, url: c.url,
    promotions: (c.analysis?.promotions || []).map(p => ({ title: p.title, detail: p.detail, period: p.period, url: p.url })),
  }));
}
function archiveReport(record) {
  if (!record || !record.report) return;
  const arr = loadData('reports.json') || [];
  const entry = { date: record.date, createdAt: record.createdAt, report: record.report, competitors: lightCompetitors(record.competitors) };
  const filtered = arr.filter(e => e.date !== record.date); // 같은 날짜는 최신으로 교체
  filtered.unshift(entry);
  saveData('reports.json', filtered.slice(0, 200)); // 최근 200건 보관(주1회면 ~4년)
}

// ── 메인 실행 ──
async function runMonitoring() {
  console.log(`[${new Date().toISOString()}] 모니터링 시작`);
  const prev = loadData('latest.json');
  const history = loadHistory();
  const results = [];

  // 이력에서 해당 경쟁사의 '마지막 정상 분석'을 찾음 (오류/빈 결과는 건너뜀)
  function lastGoodAnalysis(id) {
    for (const rec of history) {
      const a = rec.competitors?.find(c => c.id === id)?.analysis;
      if (a && Array.isArray(a.promotions) && a.promotions.length > 0 && !/오류|실패/.test(a.summary || '')) return a;
    }
    return prev?.competitors?.find(c => c.id === id)?.analysis || null;
  }

  for (const comp of config.competitors) {
    console.log(`  크롤링: ${comp.name}`);
    const crawl = await crawlCompetitor(comp);
    const prevAnalysis = lastGoodAnalysis(comp.id);

    console.log(`  분석: ${comp.name} (콘텐츠 ${crawl.content?.length || 0}자)`);
    const analysis = await analyzeOrCarry(comp, crawl, prevAnalysis);

    results.push({ id: comp.id, name: comp.name, url: comp.url, isSelf: !!comp.isSelf, crawl, analysis });
    await new Promise(r => setTimeout(r, 1500));
  }

  console.log('  종합 리포트 생성...');
  let report = null;
  try { report = await generateReport(results); }
  catch (e) { console.error('  리포트 생성 오류:', e.message); }
  if (!report) report = prev?.report || null; // 실패 시 직전 리포트 유지

  const record = { date: getTodayKey(), createdAt: new Date().toISOString(), competitors: results, report };
  saveToHistory(record);
  archiveReport(record);
  console.log(`[${new Date().toISOString()}] 완료`);
  return record;
}

module.exports = { runMonitoring, loadData, loadHistory, generateReport, archiveReport, DATA_DIR };
