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

// ── Gemini 분석 ──
async function analyzeWithGemini(competitor, crawlResult, prevContent) {
  if (!crawlResult.success) {
    return { summary: '크롤링 실패: ' + crawlResult.error, promotions: [], changes: [], recommendations: [], urgency: 'low', urgencyReason: '' };
  }

  const changeCtx = prevContent ? `\n\n[지난번 수집]\n${prevContent.slice(0, 1000)}` : '';

  const prompt = `학원 프랜차이즈 마케팅 전략 분석가로서, 경쟁사(${competitor.name}) 홈페이지 수집 데이터를 분석하세요.

[수집 데이터]
${crawlResult.content.slice(0, 12000)}${changeCtx}

반드시 아래 JSON 형식으로만 응답하세요. 마크다운이나 코드블록 없이 순수 JSON만:
{
  "summary": "50자 이내 한줄 요약",
  "promotions": [{"title": "프로모션명", "detail": "상세설명", "period": "기간"}],
  "changes": [{"type": "변경유형", "description": "설명"}],
  "recommendations": [{"action": "대응방안 제목", "detail": "구체적 실행방법", "priority": "high"}],
  "urgency": "high",
  "urgencyReason": "긴급도 판단 근거"
}`;

  const apiKey = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent?key=${apiKey}`;

  const res = await axios.post(url, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 8192, responseMimeType: 'application/json' },
  }, { timeout: 60000 });

  const raw = res.data.candidates[0].content.parts[0].text.trim();

  // JSON 추출 — 코드블록 제거 후 파싱
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

  // JSON 시작/끝 위치로 추출
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('JSON 없음: ' + cleaned.slice(0, 100));
  const jsonStr = cleaned.slice(start, end + 1);

  return JSON.parse(jsonStr);
}

// ── 메인 실행 ──
async function runMonitoring() {
  console.log(`[${new Date().toISOString()}] 모니터링 시작`);
  const prev = loadData('latest.json');
  const results = [];

  for (const comp of config.competitors) {
    console.log(`  크롤링: ${comp.name}`);
    const crawl = await crawlCompetitor(comp);
    const prevContent = prev?.competitors?.find(c => c.id === comp.id)?.crawl?.content;

    console.log(`  분석: ${comp.name} (콘텐츠 ${crawl.content?.length || 0}자)`);
    let analysis;
    try {
      analysis = await analyzeWithGemini(comp, crawl, prevContent);
    } catch (e) {
      console.error(`  분석 오류: ${e.message}`);
      analysis = { summary: '분석 오류: ' + e.message.slice(0, 50), promotions: [], changes: [], recommendations: [], urgency: 'low', urgencyReason: '' };
    }

    results.push({ id: comp.id, name: comp.name, url: comp.url, crawl, analysis });
    await new Promise(r => setTimeout(r, 1500));
  }

  const record = { date: getTodayKey(), createdAt: new Date().toISOString(), competitors: results };
  saveToHistory(record);
  console.log(`[${new Date().toISOString()}] 완료`);
  return record;
}

module.exports = { runMonitoring, loadData, loadHistory, DATA_DIR };
