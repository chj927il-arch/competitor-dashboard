// 현재 latest.json에 종합 리포트(report)를 생성해 주입 (전체 재크롤 없이 Gemini 1회 호출)
const fs = require('fs');
const path = require('path');
const { generateReport, DATA_DIR } = require('../lib/monitor');

(async () => {
  const latestPath = path.join(DATA_DIR, 'latest.json');
  const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
  console.log('리포트 생성 중... (대상 업체 ' + (latest.competitors || []).length + '개)');
  const report = await generateReport(latest.competitors || []);
  if (!report) { console.error('리포트 생성 실패'); process.exit(1); }
  latest.report = report;
  fs.writeFileSync(latestPath, JSON.stringify(latest, null, 2), 'utf8');

  // 같은 날짜 history 레코드에도 반영
  const historyPath = path.join(DATA_DIR, 'history.json');
  if (fs.existsSync(historyPath)) {
    const history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    if (history[0] && history[0].date === latest.date) {
      history[0].report = report;
      fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), 'utf8');
    }
  }
  console.log('완료. 키워드 추천', (report.responseKeywords || []).length, '선제', (report.proactiveKeywords || []).length, '점주대응', (report.storeActions || []).length, '결론', (report.conclusion || []).length);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
