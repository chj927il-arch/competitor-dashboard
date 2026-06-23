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
      eventUrls: [
        'https://dlab.dsdo.co.kr/about/events',
      ],
      focusSelectors: ['h1', 'h2', 'h3', '.event', '.notice', 'p', '.title', '.content'],
    },
  ],
  geminiModel: 'gemini-2.5-flash',
  crawlSchedule: '0 15 * * 5',
  port: 3000,
  retentionDays: 30,
};
