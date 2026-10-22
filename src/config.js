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
export const WATCH_KEYWORDS = ['古人开麦'];

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
// 盯的话题：按「最多点赞」取，大话题前面多是几个月前的老视频，所以多翻几页再筛近 30 天。每页 0.001 美元
// type 只是给 AI 的提示，最终类型由 AI 看内容判断
export const DY_HASHTAGS = [
  { name: 'ai音乐', id: '1635656412024840', pages: 3, type: 'AI音乐' },
  { name: 'ai歌曲', id: '1669112351656971', pages: 2, type: 'AI音乐' },
  { name: 'ai说唱', id: '1644566986083336', pages: 1, type: 'AI音乐' },
  { name: 'ai歌曲翻唱', id: '1777278671261763', pages: 1, type: 'AI音乐' },
  { name: '古人开麦', id: '7484454964819920907', pages: 1, type: 'AI音乐' },
  { name: 'aimv', id: '1640674458408979', pages: 2, type: 'AI MV' },
  { name: 'aimv大赏', id: '7628534042920486950', pages: 2, type: 'AI MV' },
  { name: 'ai音乐mv', id: '1768584169786368', pages: 1, type: 'AI MV' },
  { name: 'ai歌手', id: '1706595537765452', pages: 2, type: 'AI歌手/艺人' },
  { name: '虚拟歌手', id: '1601701915410440', pages: 2, type: 'AI歌手/艺人' },
  { name: 'ai艺人', id: '1765838402399244', pages: 1, type: 'AI歌手/艺人' },
  { name: 'ai鬼畜', id: '1772208953550863', pages: 1, type: 'AI鬼畜' },
  { name: 'ai鬼畜视频', id: '7387977063535216652', pages: 1, type: 'AI鬼畜' },
  { name: 'ai影视', id: '1683774040475661', pages: 2, type: 'AI影视' },
  { name: 'ai电影', id: '1653210771473412', pages: 3, type: 'AI影视' },
  { name: 'ai短剧', id: '1682091371105293', pages: 3, type: 'AI影视' },
  { name: 'ai漫剧', id: '7384348366978697228', pages: 3, type: 'AI影视' },
  { name: 'ai真人短剧', id: '7532695948107974675', pages: 2, type: 'AI影视' },
  { name: 'ai演唱会', id: '1716481052643339', pages: 1, type: 'AI换人' },
  { name: '抖音ai创作', id: '1776715988162624', pages: 2, type: null },
  { name: 'ai翻唱', id: '1716868688759811', pages: 2, type: 'AI音乐' },
  { name: '虚拟偶像', id: '1596727512379396', pages: 2, type: 'AI歌手/艺人' },
  { name: 'ai换人', id: '1734969483413507', pages: 1, type: 'AI换人' },
  { name: 'ai漫剧推荐', id: '7579212100241721378', pages: 1, type: 'AI影视' },
  { name: 'ai短剧推荐', id: '7422129998527465499', pages: 1, type: 'AI影视' },
  { name: 'ai动画', id: '1663471029690371', pages: 1, type: null },
  { name: 'aigc', id: '1722895911293971', pages: 1, type: null },
  { name: 'ai视频', id: '1617402745256973', pages: 1, type: null },
  { name: 'ai创作', id: '1641397594586119', pages: 1, type: null },
  { name: 'ai创作浪潮', id: '7552088959354931251', pages: 1, type: null },
  { name: '即梦ai', id: '7366978146019346483', pages: 1, type: null },
  { name: '可灵ai', id: '7377253049573574668', pages: 1, type: null },
];
// 每个话题另外按「综合」拉一页：主要是最近几天新发的视频（点赞还不高），抖音每天新出的 AIGC 靠这一路
export const DY_RECENT_PAGE = true;
// 创作者中心热门视频榜（近 30 天按播放）要拉的分类：只有这里能拿到抖音的真实播放量
export const DY_BILLBOARD_TAGS = [
  { tag: 337, name: '娱乐' }, { tag: 308, name: '剧情' }, { tag: 296, name: '二次元' },
  { tag: 306, name: '才艺' }, { tag: 310, name: '创意' }, { tag: 336, name: '科技' },
];
// AI 发现新玩法后，每天最多花几次「话题搜索」（每次 0.01 美元）去拿它的话题 ID
export const TIKHUB_NEW_TAGS_PER_DAY = 2;
// 余额低于这个数就暂停，不会把钱扣成负数
export const TIKHUB_MIN_BALANCE = 0.1;

// DeepSeek
export const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE || 'https://api.deepseek.com';
export const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
