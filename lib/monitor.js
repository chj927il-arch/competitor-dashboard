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

function saveToHistory(record) {
  const history = loadHistory();
  history.unshift(record);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - config.retentionDays);
  saveData('history.json', history.filter(r => new Date(r.date) >= cutoff));
  saveData('latest.json', record);
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

// ── 통합 크롤링 (브라우저 1개 재사용) ──
async function crawlCompetitor(competitor) {
  return withBrowser(async (browser) => {
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

  const prompt = `학원 프랜차이즈 마케팅 전략 분석가로서, 경쟁사(${competitor.name}) 홈페이지 수집 데이터를 분석하세요.

[수집 데이터]
${crawlResult.content.slice(0, 12000)}${changeCtx}

[변경사항(changes) 작성 규칙]
${changeRule}

[프로모션 url 작성 규칙]
각 프로모션의 "url"에는, 그 프로모션의 정확한 출처(상세 페이지) 주소를 넣으세요.
- 수집 데이터에 "상세: https://..." 형태로 각 이벤트 제목 옆에 상세 주소가 적혀 있으면, 제목이 일치하는 그 주소를 **그대로 복사**해 넣으세요.
- "[이벤트 상세: https://...]" 형태의 주소도 사용할 수 있습니다.
- 제목이 일치하는 상세 주소를 찾을 수 없을 때만 "${competitor.url}" 을 넣으세요.

반드시 아래 JSON 형식으로만 응답하세요. 마크다운이나 코드블록 없이 순수 JSON만:
{
  "summary": "50자 이내 한줄 요약",
  "promotions": [{"title": "프로모션명", "detail": "상세설명", "period": "기간", "url": "출처 주소"}],
  "changes": [{"type": "신규|종료|변경", "description": "무엇이 어떻게 달라졌는지 구체적으로"}],
  "recommendations": [{"action": "대응방안 제목", "detail": "구체적 실행방법", "priority": "high"}],
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
  return { summary: msg.slice(0, 60), promotions: [], changes: [], recommendations: [], urgency: 'low', urgencyReason: '' };
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

    results.push({ id: comp.id, name: comp.name, url: comp.url, crawl, analysis });
    await new Promise(r => setTimeout(r, 1500));
  }

  const record = { date: getTodayKey(), createdAt: new Date().toISOString(), competitors: results };
  saveToHistory(record);
  console.log(`[${new Date().toISOString()}] 완료`);
  return record;
}

module.exports = { runMonitoring, loadData, loadHistory, DATA_DIR };
