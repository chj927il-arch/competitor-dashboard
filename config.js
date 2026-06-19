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
  ],
  geminiModel: 'gemini-2.5-flash',
  crawlSchedule: '0 8 * * *',
  port: 3000,
  retentionDays: 30,
};
