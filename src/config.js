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
  { kw: 'AI短剧', core: true }, { kw: 'AI漫剧' }, { kw: 'AI短片', core: true }, { kw: 'AI翻唱', core: true },
  { kw: 'AIGC' }, { kw: 'AI视频' }, { kw: 'AI生成' }, { kw: 'Suno' }, { kw: 'Sora' }, { kw: '可灵' },
  { kw: '即梦' }, { kw: 'Seedance' }, { kw: 'Veo' }, { kw: 'AI 特效' },
];

// B站分区排行（rid）。只保留标题或分区跟 AI 有关的
export const BILI_RANK_RIDS = [3, 1, 119, 181, 188, 160];

// YouTube 搜索词（按播放量排序、限本周上传、只要视频）
export const YT_QUERIES = [
  'AI music video', 'AI animation', 'AI short film', 'AI generated video', 'Suno AI song',
  'Sora 2', 'Veo 3', 'Kling AI', 'AI cover song', 'AI movie trailer',
];

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

// DeepSeek
export const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE || 'https://api.deepseek.com';
export const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
