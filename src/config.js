// 所有可调参数集中在这里：关键词、数据源、榜单、发送时间
export const TZ = 'Asia/Shanghai';

// 每天几点发邮件（北京时间）。GitHub 定时会提前一点启动，跑完后等到这个时间再发
export const SEND_AT = process.env.SEND_AT || '09:00';

// 数据保留天数（网页最多查 30 天，多留几天做缓冲）
export const KEEP_DAYS = 40;

// 判断一条内容是否跟 AI 有关。英文 AI 要求前后不是字母，避免误伤 said / main 之类
export const AI_RE = new RegExp([
  '(?<![A-Za-z])AI(?![A-Za-z])', 'AIGC', '(?<![A-Za-z])AIMV(?![A-Za-z])', '人工智能', '大模型', '生成式',
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
// 要用新分区体系的一级分区号：旧分区号（3 音乐、1 动画、119 鬼畜……）的排行 B站换分区后就不更新了，返回的一直是 2025 年初的老稿件
// 影视 1001、音乐 1003、鬼畜 1007、二次元 1005、科技数码 1012、动物 1024（AI 萌宠短片）：近 10 天 AI 稿件最多的几个；人工智能 1011 的排行是空的
export const BILI_RANK_RIDS = [1001, 1003, 1007, 1005, 1012, 1024];

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
  // 工具名：这类视频标题里常常不写「AI」，但带工具名的基本都是 AI 做的（补 AI换人 / AI歌手 这类覆盖不到的）
  { keyword: 'Seedance', window: 168, pages: 1 },
  { keyword: 'OiiOii', window: 168, pages: 1 },
  { keyword: 'LibTV', window: 168, pages: 1 },
  { keyword: 'Suno', window: 168, pages: 1 },
  { keyword: '海螺', window: 168, pages: 1 },
  { keyword: 'Vidu', window: 168, pages: 1 },
];
// 榜单不带 AI 标：按点赞从高到低查详情，确认抖音官方 AI 标（每条 0.001 美元，查过的 14 天内不再查）。每天最多查这么多条
export const DY_VERIFY_PER_DAY = 150;
// 其中先拿这么多次刷新点赞最高的 AI 视频（累计点赞、评论、分享、收藏会涨），剩下的查新上榜的
export const DY_REFRESH_PER_DAY = 50;
// 余额低于这个数就暂停，不会把钱扣成负数
export const TIKHUB_MIN_BALANCE = 0.1;

// ---------- 小红书（TikHub，付费，每天早报那次运行拉一次，同一天不重复拉）----------
// 蒲公英·内容广场「小红书热门」榜：按关键词搜，每个榜只给 Top 100，每页 34 条，0.02 美元一页
//   days：统计窗口 3 / 7 / 14 / 30 天（只是统计窗口，榜上也会有更早发布、最近还在涨的笔记）；只要视频笔记
export const XHS_SQUARE_QUERIES = [{ keyword: 'AI', days: 7, pages: 3 }];
// 榜单不带 AI 标：按排名查笔记详情，只留作者声明了「内容含 AI 生成」的（0.01 美元一条，查过的不再查）。每天最多查这么多条
export const XHS_VERIFY_PER_DAY = 15;
// 创作者中心·热点灵感（小红书热点榜），每页 20 条，0.01 美元一页
export const XHS_HOT_PAGES = 1;


// DeepSeek
export const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE || 'https://api.deepseek.com';
export const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
// 余额低于这个数（元）时邮件底部提醒充值
export const DEEPSEEK_WARN_BALANCE = 3;
// 只给「会被看到」的视频写爆点 / 参考，其余只分类：每个平台 24 小时飙升前 N + 30 天热度前 N；热歌只分析每个榜前 N 首
export const ANALYZE_TOP_VIDEOS = 80;
export const ANALYZE_TOP_SONGS = 20;

// 爆款里提到的 AI 工具（标题 / 话题 / 简介里出现就算），用来统计「爆款都在用什么工具」
// 不收太短、容易误伤的写法（比如 MJ 会撞上迈克尔·杰克逊）
export const AI_TOOLS = [
  ['即梦', /即梦|dreamina/i], ['可灵', /可灵|kling/i], ['Seedance', /seedance/i], ['海螺', /海螺|hailuo/i], ['Vidu', /vidu/i],
  ['豆包', /豆包|doubao/i], ['OiiOii', /oiioii/i], ['LibTV', /libtv/i], ['剪映', /剪映|capcut/i], ['Suno', /suno/i],
  ['Midjourney', /midjourney/i], ['Sora', /sora/i], ['Veo', /\bveo\s?\d?\b/i], ['Runway', /runway/i], ['PixVerse', /pixverse|拍我ai/i],
  ['通义万相', /万相|wanx|通义/i], ['腾讯混元', /混元|hunyuan/i], ['天工', /天工|skyreels/i], ['Nano Banana', /nano\s?banana/i],
  ['ComfyUI', /comfyui/i], ['Stable Diffusion', /stable\s?diffusion/i], ['Flux', /\bflux\b/i], ['GPT', /chatgpt|gpt-?\d/i],
  ['DeepSeek', /deepseek/i], ['即创', /即创/], ['ElevenLabs', /elevenlabs/i], ['Hedra', /hedra/i], ['Udio', /udio/i],
];
