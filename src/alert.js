// 报警邮件：只发给管理员（ALERT_TO，没设就是 MAIL_TO 的第一个地址）
//   node src/alert.js fail "<各步骤结果>"   运行失败时（工作流里 if: failure() 调用）
//   node src/alert.js check                检查今天的早报发了没有，没发就报警（北京 09:40）
import path from 'node:path';
import { DATA, bjDate, readJSON, loadEnv, isMain } from './util.js';
import { alertRecipients, sendHtml } from './mail.js';

const OUTCOME = { success: '成功', failure: '失败', skipped: '没跑', cancelled: '被取消' };
const bjTime = () => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(Date.now());
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function page(title, lines) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:16px 8px;background:#f5f6f8;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#191c22">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e6e8ec;border-left:4px solid #f0820f;border-radius:10px;padding:18px 20px">
<div style="font-size:17px;font-weight:700;margin-bottom:10px">${esc(title)}</div>
${lines.map((l) => `<div style="font-size:14px;line-height:1.7;margin-top:6px">${l}</div>`).join('')}
</div></body></html>`;
}

async function fail(detail = '') {
  // 「模式 daily｜采集 success｜AI 标注 failure｜…」→ 把失败的那一步挑出来
  const parts = detail.split('｜').map((s) => s.trim()).filter(Boolean);
  const mode = (parts.find((p) => p.startsWith('模式')) || '').replace('模式', '').trim();
  const steps = parts.filter((p) => !p.startsWith('模式')).map((p) => { const [name, o] = p.split(/\s+(?=\S+$)/); return { name, o }; });
  const failed = steps.filter((s) => s.o === 'failure').map((s) => s.name);
  const modeName = { daily: '早报', 'daily-now': '立即推送', collect: '定时采集', weekly: '周报', 'mail-test': '测试邮件', check: '检查' }[mode] || mode || '运行';
  const lines = [
    `北京时间 ${bjTime()}，这次<b>${esc(modeName)}</b>没跑完${failed.length ? `，出问题的步骤：<b style="color:#e5484d">${esc(failed.join('、'))}</b>` : ''}。`,
    `各步骤：${steps.map((s) => `${esc(s.name)} ${esc(OUTCOME[s.o] || s.o || '-')}`).join('　')}`,
    mode.startsWith('daily') ? '早报可能没发出去。处理方法：双击项目文件夹里的「立即推送.cmd」重试一次；还不行就把这封邮件转给 Claude 看日志。' : '网页数据这次没更新，下一次定时运行会自动重试；连续好几封报警再处理。',
    process.env.RUN_URL ? `运行日志（需要能打开 GitHub）：<a href="${esc(process.env.RUN_URL)}">${esc(process.env.RUN_URL)}</a>` : '',
  ].filter(Boolean);
  await sendHtml(alertRecipients(), `⚠ AIGC 热点雷达：${modeName}运行失败`, page(`${modeName}运行失败`, lines));
}

async function check() {
  const today = bjDate();
  const sent = readJSON(path.join(DATA, 'sent.json'), {});
  if (sent.date === today) { console.log(`今天（${today}）的早报已经发了，不用报警`); return; }
  const lines = [
    `北京时间 ${bjTime()}，今天（${today}）的早报还没发出去。`,
    '最常见的原因是 GitHub 的定时任务延迟了（高峰期能晚好几个小时）。10:07 还有一次兜底，会自动补发。',
    '想马上收到：双击项目文件夹里的「立即推送.cmd」。',
    '想以后都准点：按 README 里「准点触发」配好 cron-job.org。',
  ];
  await sendHtml(alertRecipients(), '⚠ AIGC 热点雷达：今天的早报还没发出', page('早报还没发出', lines));
}

if (isMain(import.meta.url)) {
  loadEnv();
  const [what, detail] = process.argv.slice(2);
  (what === 'check' ? check() : fail(detail)).catch((e) => { console.error(e.message); process.exit(1); });
}
