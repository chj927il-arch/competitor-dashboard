// ── 로컬 테스트용 서버 ──
// 운영 환경(Cloudflare Pages + GitHub Actions)에서는 이 파일이 필요 없습니다.
// 내 PC에서 대시보드를 미리 보거나, "지금 실행"으로 수동 크롤링을 테스트할 때만 사용합니다.
require('dotenv').config();
const express = require('express');
const path = require('path');
const cron = require('node-cron');
const config = require('./config');
const { runMonitoring, loadData } = require('./lib/monitor');

const app = express();
const PUBLIC_DIR = path.join(__dirname, 'public');

app.use(express.json());
// public 폴더를 그대로 서빙 → 대시보드(index.html)와 data/*.json 을 정적 파일로 제공
app.use(express.static(PUBLIC_DIR));

// 로컬에서 수동 크롤링 트리거 (대시보드 "지금 실행" 버튼)
app.post('/api/run', (req, res) => {
  res.json({ message: '시작됨' });
  runMonitoring().catch(e => console.error(e.message));
});

// 대시보드가 로컬 서버인지(=수동 실행 가능) 감지하는 데 사용
app.get('/api/status', (req, res) => {
  const l = loadData('latest.json');
  res.json({ ok: true, local: true, lastRun: l?.createdAt || null, competitorCount: config.competitors.length });
});

app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// 로컬에서도 매일 자동 실행하고 싶을 때 (PC가 켜져 있어야 함)
cron.schedule(config.crawlSchedule, () => runMonitoring().catch(console.error));

app.listen(config.port, () => {
  console.log(`로컬 서버: http://localhost:${config.port} | 경쟁사 ${config.competitors.length}개`);
  console.log('운영 배포는 GitHub Actions + Cloudflare Pages 가 담당합니다. (DEPLOY.md 참고)');
});
