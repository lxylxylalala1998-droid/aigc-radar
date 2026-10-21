// 一键部署到 GitHub：建仓库 → 上传代码 → 填 Secrets → 开 Pages → 触发首次运行
// 全程只走 api.github.com（国内一般能直连），不需要本机能打开 github.com
//
// 需要 .env 里有：GITHUB_TOKEN（classic，勾 repo + workflow）、DEEPSEEK_API_KEY、SMTP_USER、SMTP_PASS、MAIL_TO
// 用法：node scripts/setup-github.mjs [仓库名，默认 aigc-radar] [--no-run]
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import sodium from 'libsodium-wrappers';
import { ROOT, loadEnv, sleep } from '../src/util.js';

loadEnv();
const args = process.argv.slice(2);
const NAME = args.find((a) => !a.startsWith('--')) || 'aigc-radar';
const TOKEN = process.env.GITHUB_TOKEN;
const API = 'https://api.github.com';
const SECRET_KEYS = ['DEEPSEEK_API_KEY', 'SMTP_USER', 'SMTP_PASS', 'MAIL_TO', 'SMTP_HOST', 'SMTP_PORT', 'YT_API_KEY'];
const REQUIRED = ['GITHUB_TOKEN', 'DEEPSEEK_API_KEY', 'SMTP_USER', 'SMTP_PASS', 'MAIL_TO'];

async function gh(method, url, body) {
  const res = await fetch(url.startsWith('http') ? url : API + url, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'aigc-radar-setup',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60e3),
  });
  const text = await res.text();
  let j = null;
  try { j = text ? JSON.parse(text) : null; } catch { j = text; }
  if (!res.ok) {
    const e = new Error(`${method} ${url} → ${res.status} ${j?.message || ''}`);
    e.status = res.status;
    throw e;
  }
  return { data: j, headers: res.headers };
}

const step = (s) => console.log(`\n▶ ${s}`);

async function main() {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`.env 里还没填：${missing.join('、')}`);

  step('检查 GitHub 授权');
  const { data: me, headers } = await gh('GET', '/user');
  const scopes = (headers.get('x-oauth-scopes') || '').split(/,\s*/);
  console.log(`  账号：${me.login}　权限：${scopes.join(', ') || '（细粒度 token）'}`);
  if (headers.get('x-oauth-scopes') !== null && !(scopes.includes('repo') && scopes.includes('workflow'))) {
    throw new Error('token 缺少权限：生成 token 时要同时勾选 repo 和 workflow');
  }
  const owner = me.login;

  step(`准备仓库 ${owner}/${NAME}`);
  let repo;
  try {
    repo = (await gh('GET', `/repos/${owner}/${NAME}`)).data;
    console.log('  仓库已存在，直接更新');
  } catch (e) {
    if (e.status !== 404) throw e;
    repo = (await gh('POST', '/user/repos', {
      name: NAME, private: false, auto_init: true,
      description: 'AIGC 热点雷达：每天 9 点邮件推送 AI 圈大事件、AIGC 爆款、热梗热搜、热歌，附 AI 选题建议',
    })).data;
    console.log('  已新建（公开仓库）');
    await sleep(3000);
  }
  const branch = repo.default_branch || 'main';

  step('上传代码');
  const files = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const tree = [];
  for (const f of files) {
    const content = fs.readFileSync(path.join(ROOT, f)).toString('base64');
    const { data: blob } = await gh('POST', `/repos/${owner}/${NAME}/git/blobs`, { content, encoding: 'base64' });
    tree.push({ path: f, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const { data: ref } = await gh('GET', `/repos/${owner}/${NAME}/git/ref/heads/${branch}`);
  const { data: t } = await gh('POST', `/repos/${owner}/${NAME}/git/trees`, { tree });
  const { data: commit } = await gh('POST', `/repos/${owner}/${NAME}/git/commits`, {
    message: 'AIGC 热点雷达：部署\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
    tree: t.sha, parents: [ref.object.sha],
  });
  await gh('PATCH', `/repos/${owner}/${NAME}/git/refs/heads/${branch}`, { sha: commit.sha, force: true });
  console.log(`  ${files.length} 个文件已上传`);

  step('填写 Secrets（加密后上传，本地不显示内容）');
  await sodium.ready;
  const { data: pk } = await gh('GET', `/repos/${owner}/${NAME}/actions/secrets/public-key`);
  const key = sodium.from_base64(pk.key, sodium.base64_variants.ORIGINAL);
  for (const k of SECRET_KEYS) {
    const v = process.env[k];
    if (!v) continue;
    const enc = sodium.to_base64(sodium.crypto_box_seal(sodium.from_string(v), key), sodium.base64_variants.ORIGINAL);
    await gh('PUT', `/repos/${owner}/${NAME}/actions/secrets/${k}`, { encrypted_value: enc, key_id: pk.key_id });
    console.log(`  ✓ ${k}`);
  }

  step('开启网页（GitHub Pages）');
  try {
    await gh('POST', `/repos/${owner}/${NAME}/pages`, { build_type: 'workflow' });
    console.log('  已开启');
  } catch (e) {
    if (e.status !== 409) throw e;
    await gh('PUT', `/repos/${owner}/${NAME}/pages`, { build_type: 'workflow' });
    console.log('  已是开启状态');
  }
  const site = `https://${owner.toLowerCase()}.github.io/${NAME}/`;

  if (!args.includes('--no-run')) {
    step('触发首次运行（完整早报，跑完立刻发邮件）');
    for (let i = 0; i < 10; i++) {
      try {
        await gh('POST', `/repos/${owner}/${NAME}/actions/workflows/radar.yml/dispatches`, { ref: branch, inputs: { mode: 'daily-now' } });
        console.log('  已触发');
        break;
      } catch (e) {
        if (e.status !== 404 || i === 9) throw e;
        await sleep(3000); // 新推送的工作流要几秒才能被识别
      }
    }
  }

  console.log(`\n完成。
  仓库：https://github.com/${owner}/${NAME}
  运行记录：https://github.com/${owner}/${NAME}/actions
  网页：${site}（首次运行成功后约 1 分钟可访问）`);
  fs.writeFileSync(path.join(ROOT, '.deploy.json'), JSON.stringify({ owner, repo: NAME, branch, site }, null, 1));
}

main().catch((e) => { console.error(`\n✗ ${e.message}`); process.exit(1); });
