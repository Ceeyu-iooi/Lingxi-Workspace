// Public product defaults retained from the verified Python baseline.
export const DEFAULT_SETTINGS = {
  demo_seeded: false,
  news_sources_version: 2,
  news_sources: [
    {
      id: "baidu",
      name: "百度热搜",
      ranking: true,
      feeds: ["https://top.baidu.com/board?tab=realtime"],
      links: [
        {
          name: "百度热搜",
          url: "https://top.baidu.com/board?tab=realtime",
        },
        {
          name: "微博热搜",
          url: "https://s.weibo.com/top/summary?cate=realtime",
        },
        {
          name: "知乎热榜",
          url: "https://www.zhihu.com/hot",
        },
      ],
    },
    {
      id: "bili",
      name: "B站热门",
      ranking: true,
      feeds: ["https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1"],
      links: [
        {
          name: "哔哩哔哩热门",
          url: "https://www.bilibili.com/v/popular/all",
        },
      ],
    },
    {
      id: "tech",
      name: "科技资讯",
      feeds: ["https://www.ifanr.com/feed", "https://www.ithome.com/rss/"],
      links: [
        {
          name: "36氪",
          url: "https://36kr.com/",
        },
        {
          name: "爱范儿",
          url: "https://www.ifanr.com/",
        },
        {
          name: "少数派",
          url: "https://sspai.com/",
        },
        {
          name: "IT之家",
          url: "https://www.ithome.com/",
        },
      ],
    },
    {
      id: "world",
      name: "新闻时事",
      feeds: [
        "https://www.chinanews.com.cn/rss/scroll-news.xml",
        "https://www.chinanews.com.cn/rss/china.xml",
      ],
      links: [
        {
          name: "人民网",
          url: "https://www.people.com.cn/",
        },
        {
          name: "澎湃新闻",
          url: "https://www.thepaper.cn/",
        },
        {
          name: "央视新闻",
          url: "https://news.cctv.com/",
        },
      ],
    },
    {
      id: "study",
      name: "教育升学",
      feeds: ["https://www.chinanews.com.cn/rss/edu.xml"],
      links: [
        {
          name: "研招网",
          url: "https://yz.chsi.com.cn/",
        },
        {
          name: "中国教育在线考研",
          url: "https://kaoyan.eol.cn/",
        },
      ],
    },
  ],
};
