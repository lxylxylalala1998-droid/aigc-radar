# AIGC 热点雷达

每天早上 9 点把过去 24 小时的 AIGC 热点发到邮箱，并提供一个可按 **24 小时 / 3 天 / 7 天 / 30 天** 查询的网页。**每一条都附 AI 写的「为什么能火」的分析。**

**往期**：网页页头「往期日报」或时间范围里的「往期」，可以选最近 30 天的任意一天，整个网页（选题、抖音 / B站热点、热梗热搜、热歌、AI 大事件）切换成那天最后一次扫描时的数据；选题区的「早报原文」是当天邮件的原样。

邮件和网页按这个顺序：

| # | 板块 | 内容 |
|---|---|---|
| 1 | 今日选题 | 抖音 10 个、B站 10 个。每个选题：时间段、作品 / 教程测评、单条 / 系列、难度和耗时、**时效**（刚起势 / 高峰期 / 已饱和，附依据）、为什么能火、怎么做、**工具链**、**可复用公式 + 换皮方向**、**风险提示**、参考作品。下面是**跨平台信息差**（抖音爆了 B站还没人做，反之亦然）和**选题复盘**（前几天的选题后来又涨了多少，哪类信号更靠谱） |
| 2 | 抖音热点 | 高赞榜 TOP10（近 30 天严格按累计点赞，附**评论区洞察**：观众在说什么、求教程 / 求更新次数）、**低粉爆款**（粉丝不到 10 万也爆了）、24 小时飙升 |
| 3 | B站热点 | 同上，按播放 |
| 4 | 热梗热搜 | 抖音 / B站 / 微博热搜、抖音挑战、热梗精选，每条写为什么上热搜和 AI 做法 |
| 5 | 热歌飙升 | **AIGC 爆款常用 BGM**、四个平台的热歌榜 / 飙升榜，每首写为什么火、适合做什么 AI 二创 |
| 6 | AI 大事件 | **爆款工具榜**（近 7 天 AIGC 爆款里提到各工具的作品数，和上 7 天比）、AI 圈大事件 |

每条视频还会标**数据画像**：低粉爆款、分享率高（社交货币）、收藏率高（干货）、评论多 / 弹幕多（互动强）、点赞率高，以及时长和 BGM。

**限制：**
- 小红书没有接入：必须登录 + 签名才能取数据，没有稳定的公开接口。
- 工具榜只统计标题 / 话题 / 简介里写了工具名的作品，大多数作品不写，看相对热度。
- 信息差是「我们抓到的数据里没找到同题材」，不代表另一个平台完全没有。
- AI 分析里标「推测」的，是 AI 根据有限信息做的判断。

## 运行方式

全部跑在 GitHub 上，不需要自己的电脑开机：

- **每天北京时间 08:20**：采集 → AI 标注 → AI 日报 → 更新网页 → 等到 **09:00** 发邮件
- **其余每 3 小时**：采集 → AI 标注 → 更新网页
- 数据存在仓库的 `data` 分支，保留 40 天
- 每天的 DeepSeek 费用大约几分钱

## 第一次部署

1. **建仓库**：在 GitHub 新建一个 **Public（公开）** 仓库（免费账号的 GitHub Pages 只支持公开仓库），把代码推上去。
2. **开网页**：仓库 → Settings → Pages → Build and deployment → Source 选 **GitHub Actions**。
3. **填密钥**：仓库 → Settings → Secrets and variables → Actions → New repository secret，逐个添加：

   | 名称 | 填什么 |
   |---|---|
   | `DEEPSEEK_API_KEY` | DeepSeek 的 API Key |
   | `SMTP_USER` | 发信用的 QQ 邮箱，如 `123456@qq.com` |
   | `SMTP_PASS` | QQ 邮箱的 **SMTP 授权码**（不是 QQ 密码，见下方） |
   | `MAIL_TO` | 收件人，多个用英文逗号隔开 |
   | `SMTP_HOST` / `SMTP_PORT` | 可选，不用 QQ 邮箱时才填（163 邮箱：`smtp.163.com` / `465`） |

4. **试跑**：仓库 → Actions → 左侧「AIGC 热点雷达」→ Run workflow → 模式选 `daily-now` → 运行。大约 3–5 分钟后会收到第一封邮件，网页地址是 `https://你的用户名.github.io/仓库名/`。

### QQ 邮箱授权码怎么拿

QQ 邮箱网页版 → 设置 → 账号与安全 → 安全设置 → 开启「POP3/IMAP/SMTP 服务」→ 按提示用手机验证 → 得到一串 16 位授权码。

### 让推送出现在微信里

收件人用 QQ 邮箱，然后在微信里搜索并开启「QQ邮箱提醒」，邮件到达时微信会弹通知。

## 抖音高赞 AIGC（TikHub，付费）

抖音的搜索、话题、热门榜都要登录签名，免费接口拿不到。配了 `TIKHUB_API_KEY`（GitHub Secret）后，每天早报那次运行会经 [TikHub](https://tikhub.io) 拉：

- **抖音热点宝·视频热榜**（`src/config.js` 的 `DY_HOT_QUERIES`）：抖音官方的热门视频榜，按标题关键词（AI / 即梦 / 可灵 / 豆包）过滤，时间窗口近 1 / 3 / 7 天，外加「高点赞率」「低粉爆款」两个子榜。每天约 400 条候选。注意榜单上的点赞 / 播放是「这个时间窗口内新增的」，不是累计：累计点赞以详情接口为准，近 24 小时新增点赞用来算飙升，播放标成「近 N 天播放」
- **确认官方 AI 标**：榜单本身不带 AI 标，按点赞从高到低查详情，只留抖音官方标了 AI 的（作者声明 / 平台识别 / AI 特效角标）；标题里明确说「不是 AI」的直接排除。查过的记在 `data/dy-verified.json`，14 天内不再查，所以只有新上榜的才花钱

重点类型：AI音乐、AI MV、AI歌手/艺人、AI鬼畜、AI影视、AI换人。早报里的「抖音高赞榜 / B站高播放榜」是近 30 天所有 AIGC 作品（不限类型）**严格按累计点赞（抖音）/ 播放（B站）取前 10**，同一作者只留最火的一条；AI 只负责写「爆点」「参考」，不参与挑选。

费用：热榜每页 0.001 美元（每天约 15 页），查详情每条 0.001 美元（每天最多 `DY_VERIFY_PER_DAY` = 150 条，AI 标查过就记 14 天；数据会涨，所以先拿 `DY_REFRESH_PER_DAY` = 50 次刷新点赞最高的 AI 视频，剩下约 100 次查新上榜的）。第一天约 0.17 美元，之后每天约 0.05~0.1 美元（每月约 2~3 美元）。余额低于 1 美元时邮件底部提醒，低于 0.1 美元自动暂停。手动推送（`daily-now`）也会拉一次。

## 花费和省钱机制

- **TikHub**（抖音数据）：热点宝每天约 21 页 + 查详情最多 150 条 + 高赞榜评论 10 条，每天约 0.1~0.18 美元。余额低于 1 美元邮件提醒，低于 0.1 美元自动暂停。
- **DeepSeek**（AI 分析）：每天的 token 用量记在 `data/deepseek-usage.json`。余额低于 3 元（`DEEPSEEK_WARN_BALANCE`）邮件提醒，并按最近的用量估还能用几天。
- **只给会被看到的内容写分析**：视频只给每个平台 24 小时飙升前 80 + 30 天热度前 80 写爆点 / 参考（`ANALYZE_TOP_VIDEOS`），其余只分类；热歌只分析每个榜前 20 首（`ANALYZE_TOP_SONGS`）。哪条之后冲进前 80，下一轮补上分析。
- B站评论、粉丝数走免费接口（粉丝数缓存 7 天）。

## 手动推送（随时发一次）

三种方式，任选：

1. **双击项目文件夹里的 `立即推送.cmd`**（不需要梯子）：重新采集 + AI 分析，跑完立刻发邮件，大约 5~6 分钟。窗口可以直接关，不影响推送。
2. **GitHub 网页**（需要能打开 github.com）：仓库 → Actions → 左侧「AIGC 热点雷达」→ Run workflow → 模式选 `daily-now` → 绿色 Run workflow。
3. **让 Claude 做**。

`立即推送.cmd` 用的是 `.env` 里的授权码。部署时的 `GITHUB_TOKEN` 30 天过期，想长期用可以单独生成一个只能触发运行的授权码，填到 `TRIGGER_TOKEN`：
打开 https://github.com/settings/personal-access-tokens/new → Token name 填 `aigc-radar-trigger` → Expiration 选最长 → Repository access 选 Only select repositories，选 `aigc-radar` → Permissions 里 **Actions** 选 **Read and write** → Generate token → 复制 `github_pat_` 开头那串。

## 手动运行的四种模式

| 模式 | 作用 |
|---|---|
| `collect` | 只采集 + 更新网页，不发邮件 |
| `daily` | 完整早报，等到 09:00 再发 |
| `daily-now` | 完整早报，跑完立刻发（测试用） |
| `mail-test` | 不采集，用最近一份日报立刻发一封（测试邮箱配置） |

## 常改的配置

都在 `src/config.js`：

- `SEND_AT`：发信时间（同时要改 `.github/workflows/radar.yml` 里的早报 cron，提前约 40 分钟启动）
- `BILI_KEYWORDS`：B站搜 AI 稿件的关键词；`DY_HOT_QUERIES`：抖音热点宝视频热榜的关键词和时间窗口
- `RSS_FEEDS`：AI 资讯源
- `QQ_TOPS` / `NETEASE_TOPS`：音乐榜单

收件人直接改 GitHub 上的 `MAIL_TO` Secret，不用改代码。

## 本地运行

```bash
npm install
cp .env.example .env      # 填上 DEEPSEEK_API_KEY 等
npm run collect           # 采集
node src/curate.js        # AI 标注 + 日报
npm run build && npm run serve   # 网页预览 http://localhost:8080
node src/mail.js --dry    # 邮件预览 out/mail.html
```

## 目录

```
src/
  collect.js     采集调度：并行跑所有源，合并到 data/days/日期.json
  curate.js      AI：annotate（每次采集后）+ digest（每天早上）
  build.js       生成网页数据（24h / 3天 / 7天 / 30天 四份，外加最近 30 天每天一份往期数据和早报原文页）
  mail.js        生成并发送邮件
  sources/       各平台采集器
web/             网页（原生 HTML / CSS / JS）
.github/workflows/radar.yml   定时任务
```
