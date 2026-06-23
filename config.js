module.exports = {
  competitors: [
    {
      id: 'itall_sparta',
      name: '잇올스파르타',
      url: 'https://www.itall.com',
      eventUrls: [
        'https://www.itall.com/events?tab=published&page=1',
      ],
      focusSelectors: ['h1', 'h2', 'h3', '.banner', '.promotion', '.event', '.notice', 'p', '.title', '.content'],
    },
    {
      id: 'daesung_dlab',
      name: '대성디랩',
      url: 'https://dlab.dsdo.co.kr',
      // 이벤트는 API로 직접 수집 → 정확한 상세 URL/기간/내용 확보
      eventApi: {
        url: 'https://dlab.dsdo.co.kr/api/notice-event/campus/0?page=1&size=20&sort=id,desc',
        detailUrlTemplate: 'https://dlab.dsdo.co.kr/about/events/{id}',
      },
      focusSelectors: ['h1', 'h2', 'h3', '.event', '.notice', 'p', '.title', '.content'],
    },
  ],
  geminiModel: 'gemini-2.5-flash',
  crawlSchedule: '0 15 * * 5',
  port: 3000,
  retentionDays: 30,
};
