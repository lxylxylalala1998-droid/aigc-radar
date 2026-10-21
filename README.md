# AIGC 热点雷达

每天早上 9 点把过去 24 小时的 AIGC 热点发到邮箱，并提供一个可按 **24 小时 / 3 天 / 7 天 / 30 天** 查询的网页。

| 板块 | 数据来源 | AI 做了什么 |
|---|---|---|
| AI 圈大事件 | 量子位、36氪、IT之家、OpenAI、Google AI、DeepMind、Hugging Face、TechCrunch、The Verge、Hacker News、HF 热门模型 | 同一事件的多篇报道合并，翻译英文标题，标出「重磅 / 值得关注」 |
| AIGC 爆款稿件 | B站（17 个关键词搜索 + 分区排行 + 综合热门）、YouTube（10 个关键词，本周按播放排序） | 判断是不是真的 AI 生成，分成 AI音乐 / MV / 动画 / 剧情 / 短片 / 整活；挑 10 个爆款点评 |
| 热梗热搜 | 微博热搜、抖音热榜、B站热搜 | 标出「热梗 / AI相关 / 可借势」，并给出可以怎么用 AI 来做 |
| 热歌 | QQ音乐（热歌/飙升/新歌）、网易云（热歌/飙升/新歌）、抖音热歌榜、B站音乐榜 | 推荐 5 首适合做 AI 翻唱 / MV 的歌 |
| 今日选题 | 以上全部 | 5 个可以直接开做的选题：标题、为什么现在做、怎么做、参考素材 |

**没有接入：** 小红书（必须登录 + 签名才能取数据，没有稳定的公开接口）；抖音的 AI 视频（抖音视频搜索同样需要登录签名，目前只能从抖音热榜里识别 AI 相关话题）。

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
   | `YT_API_KEY` | 可选，YouTube Data API Key，配了之后 YouTube 数据更稳定 |

4. **试跑**：仓库 → Actions → 左侧「AIGC 热点雷达」→ Run workflow → 模式选 `daily-now` → 运行。大约 3–5 分钟后会收到第一封邮件，网页地址是 `https://你的用户名.github.io/仓库名/`。

### QQ 邮箱授权码怎么拿

QQ 邮箱网页版 → 设置 → 账号与安全 → 安全设置 → 开启「POP3/IMAP/SMTP 服务」→ 按提示用手机验证 → 得到一串 16 位授权码。

### 让推送出现在微信里

收件人用 QQ 邮箱，然后在微信里搜索并开启「QQ邮箱提醒」，邮件到达时微信会弹通知。

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
- `BILI_KEYWORDS` / `YT_QUERIES`：搜 AI 稿件的关键词
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
  build.js       生成网页数据（24h / 3天 / 7天 / 30天 四份）
  mail.js        生成并发送邮件
  sources/       各平台采集器
web/             网页（原生 HTML / CSS / JS）
.github/workflows/radar.yml   定时任务
```
