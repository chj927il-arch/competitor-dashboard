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
    {
      id: 'sumanhui_sparta',
      name: '수만휘스파르타',
      url: 'https://www.sumanhuisparta.com',
      // 별도 이벤트 페이지 없음 → 공지사항의 '이벤트' 카테고리 목록을 수집
      eventUrls: [
        'https://www.sumanhuisparta.com/notice/?category=S0Poc2Dwc8',
      ],
      // 상세글 링크는 ?bmode=view&idx=... 형태 (아임웹 게시판)
      detailLinkPattern: 'bmode=view',
      listWaitSelector: 'a[href*="bmode=view"]',
      focusSelectors: ['h1', 'h2', 'h3', '.event', '.notice', 'p', '.title', '.content'],
    },
    {
      id: 'etoos247',
      name: '이투스247학원',
      isSelf: true, // 자사 — 통계 비교 기준
      url: 'https://247.etoos.com/npost/notice/list.do',
      // 별도 프로모션 페이지가 없어 공지사항을 '제목+내용'으로 키워드 검색해 수집
      noticeSearch: {
        listUrl: 'https://247.etoos.com/npost/notice/list.do',
        keywords: ['마케팅', '이벤트'],
        searchKey: '3',     // 1=제목, 2=내용, 3=제목+내용
        yearFilter: '2026', // 해당 연도 글만 수집
        maxDetails: 20,
      },
    },
  ],
  geminiModel: 'gemini-2.5-flash',
  crawlSchedule: '0 15 * * 5',
  port: 3000,
  retentionDays: 30,
};
