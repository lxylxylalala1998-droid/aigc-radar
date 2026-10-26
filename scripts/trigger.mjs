// 手动触发 GitHub 上的运行（走 api.github.com，国内不用梯子）
// 用法：node scripts/trigger.mjs [daily-now|collect|mail-test] [--no-wait]
//   daily-now  重新采集 + AI 分析，跑完立刻发邮件（默认）
//   collect    只采集、更新网页，不发邮件
//   mail-test  不采集，把最近一份早报再发一遍
// token 优先用 .env 里的 TRIGGER_TOKEN（建议单独生成一个只有 Actions 权限、长期有效的），没有就用 GITHUB_TOKEN
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadEnv, sleep } from '../src/util.js';

loadEnv();
const args = process.argv.slice(2);
const mode = args.find((a) => !a.startsWith('--')) || 'daily-now';
const token = process.env.TRIGGER_TOKEN || process.env.GITHUB_TOKEN;
const { owner, repo } = JSON.parse(fs.readFileSync(path.join(ROOT, '.deploy.json'), 'utf8'));
const H = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'aigc-radar-trigger' };
const api = (u, o = {}) => fetch(`https://api.github.com/repos/${owner}/${repo}${u}`, { headers: H, signal: AbortSignal.timeout(30e3), ...o });

async function main() {
  if (!token) throw new Error('.env 里没有 TRIGGER_TOKEN 或 GITHUB_TOKEN');
  const before = (await (await api('/actions/runs?per_page=1')).json()).workflow_runs?.[0]?.id;
  const r = await api('/actions/workflows/radar.yml/dispatches', { method: 'POST', body: JSON.stringify({ ref: 'main', inputs: { mode } }) });
  if (r.status === 401) throw new Error('授权码无效或已过期，需要重新生成（见 README「手动推送」）');
  if (r.status !== 204) throw new Error(`触发失败：${r.status} ${await r.text()}`);
  const what = { 'daily-now': '完整早报（跑完立刻发邮件）', collect: '只采集、更新网页', 'mail-test': '重发最近一份早报' }[mode] || mode;
  console.log(`✓ 已触发：${what}`);
  if (args.includes('--no-wait')) return;

  console.log('  等 GitHub 跑完（完整早报大约 5~6 分钟，可以直接关掉这个窗口，不影响推送）…');
  let run;
  for (let i = 0; i < 80; i++) {
    await sleep(15000);
    run = (await (await api('/actions/runs?per_page=1')).json()).workflow_runs?.[0];
    if (run && run.id !== before && run.status === 'completed') break;
    process.stdout.write('.');
  }
  console.log('');
  if (!run || run.status !== 'completed') return console.log('  还没跑完，稍后去邮箱看看就行');
  console.log(run.conclusion === 'success'
    ? `✓ 运行成功${mode === 'collect' ? '，网页已更新' : '，邮件已发出，去收件箱看看'}`
    : `✗ 运行失败（${run.conclusion}），把这个链接发给 Claude 看：${run.html_url}`);
}

main().catch((e) => { console.error(`✗ ${e.message}`); process.exitCode = 1; });
