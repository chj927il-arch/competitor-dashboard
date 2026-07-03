// Cloudflare Worker — 정적 자산(public/) 서빙 + /api/notify 로 본사 요청 메일 발송
// 필요한 시크릿: RESEND_API_KEY  (선택: NOTIFY_TO, NOTIFY_FROM)
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/notify' && request.method === 'POST') {
      let payload = {};
      try { payload = await request.json(); } catch (e) {}
      const to = env.NOTIFY_TO || 'chj927il@etoos.com';
      const from = env.NOTIFY_FROM || 'onboarding@resend.dev';
      const kw = (payload.kw || '').toString().slice(0, 100);
      const tx = (payload.tx || '').toString().slice(0, 500);
      // 테스트: 본문은 '테스트' 고정 (요청 시 키워드/내용도 함께 첨부)
      const text = `테스트\n\n[요청 키워드] ${kw || '-'}\n[실행 예시] ${tx || '-'}`;

      if (!env.RESEND_API_KEY) {
        return json({ ok: false, error: 'RESEND_API_KEY 미설정' }, 500);
      }
      try {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, to, subject: '[본사 요청] 테스트', text }),
        });
        const body = await r.text();
        return json({ ok: r.ok, status: r.status, body: body.slice(0, 300) }, r.ok ? 200 : 502);
      } catch (e) {
        return json({ ok: false, error: String(e).slice(0, 200) }, 502);
      }
    }

    // 그 외 요청은 정적 자산으로
    return env.ASSETS.fetch(request);
  },
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
