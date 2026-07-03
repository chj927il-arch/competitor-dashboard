// 이미 저장된 학원별 점주 대응방안(recommendations.points)의 정중체를 개조식으로 재작성 (재크롤 없이)
const fs = require('fs');
const path = require('path');
const { callGemini, DATA_DIR } = require('../lib/monitor');

(async () => {
  const fp = path.join(DATA_DIR, 'latest.json');
  const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const items = [], refs = [];
  for (const c of (d.competitors || [])) {
    for (const r of (c.analysis?.recommendations || [])) {
      (r.points || []).forEach((p, i) => { items.push(p); refs.push([r, i]); });
    }
  }
  if (!items.length) { console.log('대상 없음'); return; }
  console.log('재작성 대상 문장:', items.length);
  const prompt = `다음 문장들을 뜻은 그대로 유지하되 원장님께 말하듯 친근한 어조로 바꿔라. 문장 끝은 "~해요", "~해보세요", "~하는 게 좋아요" 형태. 딱딱한 개조식('~함/~필요/~권장')이나 격식체('~했습니다/~합니다/~중요합니다')는 전부 제거. 반드시 입력과 같은 개수·같은 순서의 배열로, 아래 JSON 형식으로만 응답:
{"items": ["친근한 문장", ...]}

입력(${items.length}개):
${JSON.stringify(items, null, 0)}`;
  let res;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try { res = await callGemini(prompt); break; }
    catch (e) { console.error(`시도 ${attempt}/6 실패: ${e.message}`); if (attempt === 6) throw e; await new Promise(r => setTimeout(r, attempt * 8000)); }
  }
  const out = Array.isArray(res.items) ? res.items : [];
  if (out.length !== items.length) { console.error('개수 불일치:', out.length, 'vs', items.length); process.exit(1); }
  refs.forEach(([r, i], k) => { if (out[k]) r.points[i] = String(out[k]).trim(); });
  fs.writeFileSync(fp, JSON.stringify(d, null, 2), 'utf8');

  // history.json 최신 레코드도 동기화
  const hp = path.join(DATA_DIR, 'history.json');
  if (fs.existsSync(hp)) {
    const h = JSON.parse(fs.readFileSync(hp, 'utf8'));
    if (h[0] && h[0].date === d.date) { h[0] = d; fs.writeFileSync(hp, JSON.stringify(h, null, 2), 'utf8'); }
  }
  console.log('완료. 예시:', refs.length ? d.competitors.find(c => c.analysis?.recommendations?.length)?.analysis.recommendations[0].points : '');
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
