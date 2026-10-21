// 看 GitHub 上最近一次运行：每一步的结果，失败步骤的日志末尾，以及采集日志
// 用法：node scripts/watch-run.mjs [--wait]   --wait 会一直等到运行结束
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadEnv, sleep } from '../src/util.js';

loadEnv();
const { owner, repo } = JSON.parse(fs.readFileSync(path.join(ROOT, '.deploy.json'), 'utf8'));
const H = { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'aigc-radar-setup' };
const api = async (u, type = 'json') => {
  const r = await fetch(u.startsWith('http') ? u : `https://api.github.com/repos/${owner}/${repo}${u}`, { headers: H, signal: AbortSignal.timeout(60e3) });
  if (!r.ok) throw new Error(`${u} → ${r.status}`);
  return type === 'json' ? r.json() : r.text();
};
const ICON = { success: '✓', failure: '✗', skipped: '–', cancelled: '⊘', null: '…' };

async function main() {
  let run;
  for (;;) {
    run = (await api('/actions/runs?per_page=1')).workflow_runs[0];
    if (!run) throw new Error('还没有任何运行记录');
    if (run.status === 'completed' || !process.argv.includes('--wait')) break;
    process.stdout.write(`\r运行中（${run.status}）… ${new Date().toLocaleTimeString()}   `);
    await sleep(15000);
  }
  console.log(`\n运行 #${run.run_number}（${run.event}）：${run.status} / ${run.conclusion || '-'}　${run.html_url}`);
  const { jobs } = await api(`/actions/runs/${run.id}/jobs`);
  for (const job of jobs) {
    for (const s of job.steps || []) console.log(`  ${ICON[s.conclusion] || ICON.null} ${s.name}`);
    if (run.status !== 'completed') continue;
    let log = '';
    try { log = await api(`/actions/jobs/${job.id}/logs`, 'text'); } catch (e) { console.log(`（日志下载失败：${e.message}）`); continue; }
    const clean = log.split('\n').map((l) => l.replace(/^\S+Z /, '').replace(/\x1b\[[0-9;]*m/g, ''));
    // 采集 / AI / 邮件的关键输出
    const keep = clean.filter((l) => /^[✓✗] |本次|标注|日报|候选|已发送|发送失败|等待|w\d+:|##\[error\]|Error|错误/.test(l));
    console.log('\n--- 关键输出 ---\n' + keep.join('\n'));
    fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'out', `run-${run.run_number}.log`), clean.join('\n'));
    console.log(`\n完整日志：out/run-${run.run_number}.log`);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
