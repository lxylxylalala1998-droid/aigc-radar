// 一键设置：长期授权码 + cron-job.org 准点触发
// 双击项目文件夹里的「一键设置.cmd」运行。会自动打开网页，你只需要登录、点生成、复制、粘贴回来，其余全自动：
//   1. 触发授权码（只能触发 / 查看运行）：给「立即推送.cmd」和 cron-job.org 用 → .env 的 TRIGGER_TOKEN
//   2. 部署授权码（能更新代码）：给 Claude 部署更新用，替换 11 月 20 日过期的那个 → .env 的 GITHUB_TOKEN
//   3. cron-job.org：用它的 API 建好每天 08:20 早报、09:40 检查、周一 09:10 周报三个定时任务，并做一次真实连通测试
// 已经设置好的步骤会自动跳过，重复运行没关系
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ROOT, loadEnv, sleep } from '../src/util.js';

loadEnv();
const ENV = path.join(ROOT, '.env');
const { owner, repo, branch = 'main' } = JSON.parse(fs.readFileSync(path.join(ROOT, '.deploy.json'), 'utf8'));
const rl = readline.createInterface({ input: stdin, output: stdout });
const ask = async (q) => (await rl.question(q)).trim();
const line = () => console.log('─'.repeat(60));
const open = (url) => { try { execSync(`start "" "${url}"`, { shell: 'cmd.exe', stdio: 'ignore' }); } catch { /* 打不开就让用户手动复制 */ } };

// 把 KEY=VALUE 写进 .env：有就替换，没有就加在最后
function setEnv(key, value) {
  let s = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '';
  const re = new RegExp(`^${key}=.*$`, 'm');
  s = re.test(s) ? s.replace(re, `${key}=${value}`) : `${s.replace(/\s*$/, '')}\n${key}=${value}\n`;
  fs.writeFileSync(ENV, s);
  process.env[key] = value;
}

const GH = 'https://api.github.com';
async function gh(token, method, p, body) {
  const res = await fetch(p.startsWith('http') ? p : `${GH}/repos/${owner}/${repo}${p}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'aigc-radar-setup', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30e3),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

// GitHub 授权码页面的预填链接：名字、说明、永不过期、权限都填好，只剩「选仓库」和「点生成」
const tokenUrl = (name, desc, perms) => `https://github.com/settings/personal-access-tokens/new?${new URLSearchParams({ name, description: desc, target_name: owner, expires_in: 'none', ...perms })}`;

async function getToken({ title, name, desc, perms, check }) {
  for (;;) {
    const url = tokenUrl(name, desc, perms);
    console.log(`\n马上在浏览器里打开 GitHub 的「新建授权码」页面（名字、权限、有效期都已经填好了）。`);
    console.log('打不开的话先开梯子，或者把下面这个链接复制到浏览器：');
    console.log(url);
    open(url);
    console.log(`\n页面打开后只要做 3 件事：`);
    console.log('  ① 往下找到「Repository access」，选「Only select repositories」，');
    console.log(`     在出来的下拉框里选「${repo}」`);
    console.log('  ② 拉到页面最下面，点绿色的「Generate token」（弹出确认框就再点一次 Generate token）');
    console.log('  ③ 新页面里有一串 github_pat_ 开头的字，点它右边的复制按钮');
    const t = await ask(`\n复制好后，回到这个黑窗口，右键（或 Ctrl+V）粘贴，按回车（直接回车 = 跳过这一步）：\n> `);
    if (!t) return null;
    if (!/^github_pat_\w+$/.test(t)) { console.log('✗ 这不像授权码（应该是 github_pat_ 开头的一长串），再试一次'); continue; }
    process.stdout.write('检查授权码…');
    const err = await check(t);
    if (!err) { console.log(' ✓ 可以用'); return t; }
    console.log(`\n✗ ${err}`);
    console.log('最常见的原因是 ① 那一步没选对仓库。可以在 GitHub 上删掉这个授权码重新生成一个。');
    if ((await ask('重试按回车，跳过输入 n：')).toLowerCase() === 'n') return null;
  }
}

// ---------- 1. 触发授权码 ----------
async function stepTrigger() {
  line();
  console.log('第 1 步 / 共 3 步：触发授权码（给「立即推送」和准点触发用，只能触发运行，改不了任何东西）');
  const checkTrigger = async (t) => {
    const r = await gh(t, 'GET', '/actions/workflows/radar.yml');
    if (r.status !== 200) return `看不到这个仓库的运行（${r.status}）`;
    // 「启用工作流」本来就是启用的，再启用一次没有任何影响，正好用来验证有没有触发权限
    const w = await gh(t, 'PUT', '/actions/workflows/radar.yml/enable');
    return w.status === 204 ? '' : `没有触发运行的权限（${w.status}）`;
  };
  if (process.env.TRIGGER_TOKEN && !(await checkTrigger(process.env.TRIGGER_TOKEN))) { console.log('✓ 已经设置过，而且能用，跳过'); return process.env.TRIGGER_TOKEN; }
  const t = await getToken({ title: '触发', name: 'aigc-radar-trigger', desc: 'AIGC 热点雷达：立即推送和准点触发用', perms: { actions: 'write' }, check: checkTrigger });
  if (t) { setEnv('TRIGGER_TOKEN', t); console.log('✓ 已保存到 .env（TRIGGER_TOKEN）。「立即推送.cmd」以后一直能用'); }
  return t;
}

// ---------- 2. 部署授权码 ----------
async function stepDeploy() {
  line();
  console.log('第 2 步 / 共 3 步：部署授权码（只在你这台电脑上用，让 Claude 以后能帮你更新代码；现在那个 11 月 20 日过期）');
  const checkDeploy = async (t) => {
    const me = await gh(t, 'GET', `${GH}/user`);
    if (me.status !== 200) return `授权码无效（${me.status}）`;
    if (me.headers.get('x-oauth-scopes') !== null) return '这是旧式（classic）授权码，请用打开的页面新建';
    const pk = await gh(t, 'GET', '/actions/secrets/public-key');
    if (pk.status !== 200) return `没有 Secrets 权限（${pk.status}）`;
    const pg = await gh(t, 'GET', '/pages');
    if (pg.status !== 200) return `没有 Pages 权限（${pg.status}）`;
    // 往仓库里存一个没人引用的空数据块：不影响任何东西，正好验证有没有写代码的权限
    const blob = await gh(t, 'POST', '/git/blobs', { content: 'aigc-radar setup check', encoding: 'utf-8' });
    if (blob.status !== 201) return `没有写代码的权限（${blob.status}）`;
    const wf = await gh(t, 'GET', '/actions/workflows/radar.yml');
    return wf.status === 200 ? '' : `看不到运行（${wf.status}）`;
  };
  const cur = process.env.GITHUB_TOKEN;
  if (cur && cur.startsWith('github_pat_') && !(await checkDeploy(cur))) { console.log('✓ 已经设置过，而且能用，跳过'); return; }
  const t = await getToken({
    title: '部署', name: 'aigc-radar-deploy', desc: 'AIGC 热点雷达：在本机部署更新用',
    perms: { contents: 'write', workflows: 'write', secrets: 'write', pages: 'write', actions: 'write' }, check: checkDeploy,
  });
  if (!t) return;
  if (cur && !cur.startsWith('github_pat_')) setEnv('GITHUB_TOKEN_OLD', cur); // 旧的先留着，过期前还能用
  setEnv('GITHUB_TOKEN', t);
  console.log('✓ 已保存到 .env（GITHUB_TOKEN），以后不会过期');
}

// ---------- 3. cron-job.org 准点触发 ----------
const CJ = 'https://api.cron-job.org';
async function cj(key, method, p, body) {
  const res = await fetch(CJ + p, {
    method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30e3),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const DISPATCH = `${GH}/repos/${owner}/${repo}/actions/workflows/radar.yml/dispatches`;
const jobBody = (title, mode, token, sched) => ({
  job: {
    url: DISPATCH, title, enabled: true, saveResponses: true, requestTimeout: 30,
    schedule: { timezone: 'Asia/Shanghai', expiresAt: 0, mdays: [-1], months: [-1], wdays: [-1], ...sched },
    requestMethod: 1, // POST
    extendedData: {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      body: JSON.stringify({ ref: branch, inputs: { mode } }),
    },
    notification: { onFailure: true, onSuccess: false, onDisable: true },
  },
});
const JOBS = [
  { title: 'AIGC 雷达 · 早报（每天 08:20）', mode: 'daily', sched: { hours: [8], minutes: [20] } },
  { title: 'AIGC 雷达 · 检查（每天 09:40）', mode: 'check', sched: { hours: [9], minutes: [40] } },
  { title: 'AIGC 雷达 · 周报（周一 09:10）', mode: 'weekly', sched: { hours: [9], minutes: [10], wdays: [1] } },
];

async function stepCron(token) {
  line();
  console.log('第 3 步 / 共 3 步：cron-job.org 准点触发（让早报每天准点 9:00 到，不受 GitHub 定时延迟影响）');
  if (!token) { console.log('✗ 第 1 步的触发授权码没设置好，这一步做不了，跳过'); return; }
  let key = process.env.CRONJOB_API_KEY;
  if (key && (await cj(key, 'GET', '/jobs')).status !== 200) key = '';
  if (!key) {
    console.log('\n马上打开 cron-job.org（免费的定时服务）的注册页：https://console.cron-job.org/signup');
    open('https://console.cron-job.org/signup');
    console.log('  ① 用邮箱注册（随便设个密码），去邮箱点确认链接，再回来登录');
    console.log('     （已经有账号就直接登录：https://console.cron-job.org/login ）');
    console.log('  ② 登录后点左边的「Settings」，找到「API」那一块，点「Create API key」');
    console.log('     （有让填 IP 限制的地方，留空不填）');
    console.log('  ③ 复制生成的那串密钥');
    for (;;) {
      key = await ask('\n复制好后粘贴到这里，按回车（直接回车 = 跳过）：\n> ');
      if (!key) return;
      const r = await cj(key, 'GET', '/jobs');
      if (r.status === 200) break;
      console.log(`✗ 这个密钥用不了（${r.status}），检查一下是不是复制全了`);
    }
    setEnv('CRONJOB_API_KEY', key);
  }
  console.log('✓ cron-job.org 连上了');

  // 已经有同名任务就更新，没有就新建
  const { data } = await cj(key, 'GET', '/jobs');
  const existing = new Map((data.jobs || []).map((j) => [j.title, j.jobId]));
  for (const j of JOBS) {
    const body = jobBody(j.title, j.mode, token, j.sched);
    const id = existing.get(j.title);
    const r = id ? await cj(key, 'PATCH', `/jobs/${id}`, body) : await cj(key, 'PUT', '/jobs', body);
    console.log(r.status === 200 ? `✓ ${id ? '已更新' : '已建好'}：${j.title}` : `✗ ${j.title} 失败（${r.status} ${JSON.stringify(r.data).slice(0, 120)}）`);
    await sleep(1500); // 新建任务限速：每秒 1 个
  }

  // 真实连通测试：建一个两分钟后触发「只采集」的临时任务，看 GitHub 那边有没有被叫起来，然后删掉它
  console.log('\n做一次真实测试：两分钟后 cron-job.org 会触发一次「只采集」（不发邮件、不花钱），大约要等 3 分钟…');
  const at = new Date(Date.now() + 2 * 60e3 + 30e3);
  const bj = new Date(at.getTime() + 8 * 3600e3); // 北京时间
  const t0 = Date.now();
  const test = await cj(key, 'PUT', '/jobs', jobBody('AIGC 雷达 · 连通测试（会自动删除）', 'collect', token, { hours: [bj.getUTCHours()], minutes: [bj.getUTCMinutes()] }));
  if (test.status !== 200) { console.log(`✗ 测试任务建不了（${test.status}），三个正式任务已经建好，明天 8:20 看效果`); return; }
  const testId = test.data.jobId;
  let ok = false;
  for (let i = 0; i < 40 && !ok; i++) {
    await sleep(10e3);
    process.stdout.write('.');
    const runs = await gh(token, 'GET', '/actions/runs?per_page=5&event=workflow_dispatch');
    ok = (runs.data.workflow_runs || []).some((r) => Date.parse(r.created_at) > t0);
  }
  await cj(key, 'DELETE', `/jobs/${testId}`);
  console.log(ok ? '\n✓ 测试通过：cron-job.org 成功叫起了 GitHub。以后每天 08:20 准点开跑，09:00 发早报' : '\n✗ 等了几分钟 GitHub 没被叫起来。把这个窗口截图发给 Claude 看看');
}

async function main() {
  console.log('AIGC 热点雷达 · 一键设置\n这个窗口会一步步告诉你做什么。中途想停就直接关掉窗口，下次再双击会接着做没完成的步骤。');
  const t = await stepTrigger();
  await stepDeploy();
  await stepCron(t || process.env.TRIGGER_TOKEN);
  line();
  console.log('全部完成。可以关掉这个窗口了，回去告诉 Claude 一声「弄好了」。');
}

main().catch((e) => console.error(`\n出错了：${e.message}\n把这个窗口截图发给 Claude 看看`)).finally(() => rl.close());
