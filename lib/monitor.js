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
      return { text, links };
    });
  } finally {
    await page.close();
  }
}

// ── 통합 크롤링 (브라우저 1개 재사용) ──
async function crawlCompetitor(competitor) {
  return withBrowser(async (browser) => {
    try {
      const sections = [];

      // 1) 메인 페이지
      const main = await renderPage(browser, competitor.url);
      if (main.text) sections.push(`[메인 페이지]\n${main.text.slice(0, 4000)}`);

      // 2) 이벤트 목록 페이지들
      for (const evUrl of (competitor.eventUrls || [])) {
        try {
          const list = await renderPage(browser, evUrl, 'a[href*="/events/"]');
          if (list.text) sections.push(`[이벤트 목록: ${evUrl}]\n${list.text.slice(0, 2000)}`);

          // 상세 링크 수집 (중복 제거, 최대 6개)
          const detailLinks = [...new Set(list.links.filter(h => EVENT_DETAIL_RE.test(h)))].slice(0, 6);

          // 3) 이벤트 상세 진입 (서버 부하 방지 위해 간격 두기)
          for (const link of detailLinks) {
            await new Promise(r => setTimeout(r, 600));
            try {
              const detail = await renderPage(browser, link);
              if (detail.text) sections.push(`[이벤트 상세: ${link}]\n${detail.text.slice(0, 2500)}`);
            } catch (e) {
              sections.push(`[이벤트 상세 오류: ${link}] ${e.message}`);
            }
          }
        } catch (e) {
          sections.push(`[이벤트 페이지 오류: ${evUrl}] ${e.message}`);
        }
      }

      return {
        success: true,
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
각 프로모션의 "url"에는, 수집 데이터에서 그 프로모션이 나온 구간의 출처 주소를 넣으세요.
데이터에 "[이벤트 상세: https://...]" 또는 "[이벤트 목록: https://...]" 형태로 주소가 표시돼 있습니다. 가장 관련 있는 주소를 그대로 사용하고, 마땅한 주소가 없으면 "${competitor.url}" 을 넣으세요.

반드시 아래 JSON 형식으로만 응답하세요. 마크다운이나 코드블록 없이 순수 JSON만:
{
  "summary": "50자 이내 한줄 요약",
  "promotions": [{"title": "프로모션명", "detail": "상세설명", "period": "기간", "url": "출처 주소"}],
  "changes": [{"type": "신규|종료|변경", "description": "무엇이 어떻게 달라졌는지 구체적으로"}],
  "recommendations": [{"action": "대응방안 제목", "detail": "구체적 실행방법", "priority": "high"}],
  "urgency": "high",
  "urgencyReason": "긴급도 판단 근거"
}`;

  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await callGemini(prompt);
    } catch (e) {
      lastErr = e;
      console.error(`  분석 시도 ${attempt} 실패: ${e.message}`);
    }
  }
  throw lastErr;
}

function errorAnalysis(msg) {
  return { summary: msg.slice(0, 60), promotions: [], changes: [], recommendations: [], urgency: 'low', urgencyReason: '' };
}

// 분석 실행 — 실패하면 직전 성공 결과를 그대로 유지(carry-forward)
async function analyzeOrCarry(comp, crawl, prevAnalysis) {
  // 직전 결과가 '내용 있는 정상 분석'일 때만 유지 대상으로 인정 (빈 오류는 제외)
  const prevUsable = prevAnalysis && Array.isArray(prevAnalysis.promotions) && prevAnalysis.promotions.length > 0
    ? prevAnalysis : null;

  if (!crawl.success) {
    if (prevUsable) { console.log(`  → 크롤링 실패, 직전 결과 유지: ${comp.name}`); return { ...prevUsable, stale: true, staleReason: '이번 수집 실패 — 직전 결과 표시' }; }
    return errorAnalysis('크롤링 실패: ' + crawl.error);
  }
  try {
    return await analyzeWithGemini(comp, crawl, prevAnalysis);
  } catch (e) {
    console.error(`  분석 오류: ${e.message}`);
    if (prevUsable) { console.log(`  → 분석 실패, 직전 결과 유지: ${comp.name}`); return { ...prevUsable, stale: true, staleReason: '이번 수집 분석 실패 — 직전 결과 표시' }; }
    return errorAnalysis('분석 오류: ' + e.message);
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
