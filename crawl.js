// GitHub Actions(또는 수동)에서 1회 실행되는 진입점.
// 크롤링 + Gemini 분석 후 public/data/*.json 을 갱신하고 종료한다.
const { runMonitoring } = require('./lib/monitor');

runMonitoring()
  .then(() => {
    console.log('크롤링 완료. public/data/latest.json, history.json 갱신됨.');
    process.exit(0);
  })
  .catch((e) => {
    console.error('크롤링 실패:', e.message);
    process.exit(1);
  });
