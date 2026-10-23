// 所有可调参数集中在这里：关键词、数据源、榜单、发送时间
export const TZ = 'Asia/Shanghai';

// 每天几点发邮件（北京时间）。GitHub 定时会提前一点启动，跑完后等到这个时间再发
export const SEND_AT = process.env.SEND_AT || '09:00';

// 数据保留天数（网页最多查 30 天，多留几天做缓冲）
export const KEEP_DAYS = 40;

// 判断一条内容是否跟 AI 有关。英文 AI 要求前后不是字母，避免误伤 said / main 之类
export const AI_RE = new RegExp([
  '(?<![A-Za-z])AI(?![A-Za-z])', 'AIGC', '人工智能', '大模型', '生成式',
  'Suno', 'Udio', 'Sora', '(?<![A-Za-z])Veo', '可灵', 'Kling', '即梦', 'Seedance', '海螺', 'Hailuo',
  'Runway', 'Midjourney', 'Stable ?Diffusion', 'Pika', 'Vidu', '通义', '万相', '豆包', '元宝', 'Kimi',
  'DeepSeek', 'ChatGPT', 'GPT', 'OpenAI', 'Gemini', 'Claude', 'Anthropic', 'Grok', 'Qwen', '千问', '文心',
  '智谱', 'GLM', 'MiniMax', '数字人', '虚拟人', '智能体', 'Nano ?Banana', 'LLM', 'AGI',
].join('|'), 'i');

// B站 AI 稿件搜索关键词。core=true 的额外查一次近 7 天（兜住前几天发、今天还在涨的爆款）；
// 每天早报那次运行还会对 core 关键词查近 30 天，作为「长期热点」的依据
export const BILI_KEYWORDS = [
  { kw: 'AI音乐', core: true }, { kw: 'AI MV', core: true }, { kw: 'AI动画', core: true },
  { kw: 'AI歌手', core: true }, { kw: '虚拟歌手' }, { kw: 'AI鬼畜', core: true }, { kw: 'AI电影', core: true }, { kw: 'AI换脸' }, { kw: 'AI演唱会' },
  { kw: 'AI短剧', core: true }, { kw: 'AI漫剧' }, { kw: 'AI短片', core: true }, { kw: 'AI翻唱', core: true },
  { kw: 'AIGC' }, { kw: 'AI视频' }, { kw: 'AI生成' }, { kw: 'Suno' }, { kw: 'Sora' }, { kw: '可灵' },
  { kw: '即梦' }, { kw: 'Seedance' }, { kw: 'Veo' }, { kw: 'AI 特效' },
];

// 关注的 AIGC 玩法：你点名要盯的，每次都搜（近 7 天）。AI 自动发现的新玩法存在 data/trend-keywords.json，不用写在这里
export const WATCH_KEYWORDS = [];

// B站分区排行（rid）。只保留标题或分区跟 AI 有关的
export const BILI_RANK_RIDS = [3, 1, 119, 181, 188, 160];

// AI 资讯 RSS。filter=true 的是综合媒体，只留标题带 AI 关键词的
export const RSS_FEEDS = [
  { name: '量子位', url: 'https://www.qbitai.com/feed', filter: false },
  { name: '36氪', url: 'https://36kr.com/feed', filter: true },
  { name: 'IT之家', url: 'https://www.ithome.com/rss/', filter: true },
  { name: 'OpenAI', url: 'https://openai.com/news/rss.xml', filter: false },
  { name: 'Google AI', url: 'https://blog.google/technology/ai/rss/', filter: false },
  { name: 'DeepMind', url: 'https://deepmind.google/blog/rss.xml', filter: false },
  { name: 'Hugging Face', url: 'https://huggingface.co/blog/feed.xml', filter: false },
  { name: 'TechCrunch', url: 'https://techcrunch.com/category/artificial-intelligence/feed/', filter: false },
  { name: 'The Verge', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', filter: false },
];

// 音乐榜单
// 每个平台都取「热歌榜 + 飙升榜」
export const QQ_TOPS = [{ id: 26, name: '热歌榜' }, { id: 62, name: '飙升榜' }];
export const NETEASE_TOPS = [{ id: 3778678, name: '热歌榜' }, { id: 19723756, name: '飙升榜' }];
// 抖音音乐榜（周更）。ID 来自开源项目 hutaolv/hutao-music 等
export const DOUYIN_MUSIC_CHARTS = [{ id: '6853972723954146568', name: '热歌榜' }, { id: '6854399861215730952', name: '飙升榜' }];
export const MUSIC_TOP_N = 50;

// ---------- 抖音高赞 AIGC（TikHub，付费，每天早报那次运行拉一次）----------
// 抖音热点宝·视频热榜：抖音官方的热门视频榜，按标题关键词过滤，自带播放 / 点赞 / 发布时间。每页最多 50 条，0.001 美元
//   window：榜单时间窗口（小时）24 / 72 / 168；sub：1001 总榜（默认）/ 1002 低粉爆款 / 1005 高点赞率
export const DY_HOT_QUERIES = [
  { keyword: 'AI', window: 24, pages: 3 },
  { keyword: 'AI', window: 72, pages: 3 },
  { keyword: 'AI', window: 168, pages: 4 },
  { keyword: 'AI', window: 168, pages: 1, sub: 1005 },
  { keyword: 'AI', window: 168, pages: 1, sub: 1002 },
  { keyword: '即梦', window: 168, pages: 1 },
  { keyword: '可灵', window: 168, pages: 1 },
  { keyword: '豆包', window: 168, pages: 1 },
];
// 榜单不带 AI 标：按点赞从高到低查详情，确认抖音官方 AI 标（每条 0.001 美元，查过的 14 天内不再查）。每天最多查这么多条
export const DY_VERIFY_PER_DAY = 150;
// 其中先拿这么多次刷新点赞最高的 AI 视频（累计点赞、评论、分享、收藏会涨），剩下的查新上榜的
export const DY_REFRESH_PER_DAY = 50;
// 余额低于这个数就暂停，不会把钱扣成负数
export const TIKHUB_MIN_BALANCE = 0.1;

// DeepSeek
export const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE || 'https://api.deepseek.com';
export const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
