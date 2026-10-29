// 收件人管理：添加 / 删除早报收件人，同时改本机 .env 和 GitHub Secret MAIL_TO（不用重新部署）
// 双击「改收件人.cmd」打开菜单；也可以直接用命令：
//   node scripts/mail-to.mjs list | add a@x.com b@y.com | remove 3 a@x.com | sync
//   加 --dry 只演示、什么都不改
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import sodium from 'libsodium-wrappers';
import { ROOT, sleep } from '../src/util.js';

const ENV = path.join(ROOT, '.env');
const API = 'https://api.github.com';
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const [cmd, ...rest] = args.filter((a) => a !== '--dry');

const readEnv = () => fs.readFileSync(ENV, 'utf8');
const envVal = (text, k) => (text.match(new RegExp(`^[ \\t]*${k}[ \\t]*=[ \\t]*(.*?)\\s*$`, 'm'))?.[1] || '').replace(/^["']|["']$/g, '');
// 全角字符（＠、，）先转半角；中文逗号、顿号、分号、空格都当分隔符
const split = (s) => s.normalize('NFKC').split(/[,;、\s]+/).filter(Boolean);
const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(s);
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const current = () => split(envVal(readEnv(), 'MAIL_TO'));
const hasAlertTo = () => !!envVal(readEnv(), 'ALERT_TO');
const bj = (iso) => new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

function show(list) {
  console.log(`\n当前收件人（${list.length} 个）：`);
  list.forEach((x, i) => console.log(`  ${String(i + 1).padStart(2)}. ${x}${i === 0 && !hasAlertTo() ? '　　← 报警邮件也发给这个' : ''}`));
}

async function gh(method, url, body) {
  const token = process.env.GITHUB_TOKEN || envVal(readEnv(), 'GITHUB_TOKEN');
  if (!token) throw new Error('.env 里没有 GITHUB_TOKEN（GitHub 授权码）');
  const { owner, repo } = JSON.parse(fs.readFileSync(path.join(ROOT, '.deploy.json'), 'utf8'));
  for (let i = 0; ; i++) {
    let res;
    try {
      res = await fetch(`${API}/repos/${owner}/${repo}/actions/secrets${url}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'aigc-radar-mail-to',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30e3),
      });
    } catch {
      if (i < 2) { await sleep(2000); continue; }
      throw new Error('连不上 api.github.com，检查一下网络');
    }
    if (res.status === 401) throw new Error('GitHub 授权码（.env 里的 GITHUB_TOKEN）失效了，需要重新生成');
    if (res.status === 403 || res.status === 404) throw new Error(`GitHub 拒绝了（${res.status}）：授权码没有改 Secrets 的权限，或者 .deploy.json 里的仓库不对`);
    if (!res.ok) throw new Error(`GitHub 返回 ${res.status}`);
    return res.status === 204 ? null : res.json();
  }
}

function writeEnv(list) {
  const text = readEnv();
  const line = `MAIL_TO=${list.join(',')}`;
  const re = /^[ \t]*MAIL_TO[ \t]*=.*$/m;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const out = re.test(text) ? text.replace(re, () => line) : `${text.replace(/\s*$/, '')}${eol}${line}${eol}`;
  fs.writeFileSync(`${ENV}.tmp`, out);
  fs.renameSync(`${ENV}.tmp`, ENV);
}

// 先改 GitHub，成功了再改本机 .env：失败时两边都还是旧名单，不会对不上
async function save(list) {
  if (DRY) {
    console.log(`\n（演示模式，什么都没改）新名单：${list.join(',')}`);
    return true;
  }
  let at;
  try {
    await sodium.ready;
    const pk = await gh('GET', '/public-key');
    const key = sodium.from_base64(pk.key, sodium.base64_variants.ORIGINAL);
    const enc = sodium.to_base64(sodium.crypto_box_seal(sodium.from_string(list.join(',')), key), sodium.base64_variants.ORIGINAL);
    await gh('PUT', '/MAIL_TO', { encrypted_value: enc, key_id: pk.key_id });
    at = (await gh('GET', '/MAIL_TO')).updated_at;
  } catch (e) {
    console.log(`\n✗ 没改成：${e.message}`);
    console.log('  本机和 GitHub 上都还是原来的名单，处理好之后再试一次。');
    return false;
  }
  try {
    writeEnv(list);
  } catch (e) {
    console.log(`\n⚠ GitHub 已经改好了，但本机 .env 没写进去（${e.message}）。`);
    console.log(`  请用记事本打开 .env，把 MAIL_TO 那一行改成：\nMAIL_TO=${list.join(',')}`);
    return false;
  }
  console.log(`\n✓ 保存好了：本机 .env 和 GitHub 都已更新（GitHub 更新时间 ${bj(at)}）`);
  console.log('  早上 6 点前改好的，当天 9 点的早报就按新名单发；6 点以后改的，可能要从第二天开始。');
  return true;
}

function planAdd(list, items) {
  const add = [], bad = [], dup = [];
  for (const s of items) {
    if (!isEmail(s)) bad.push(s);
    else if ([...list, ...add].some((x) => same(x, s))) dup.push(s);
    else add.push(s);
  }
  if (bad.length) console.log(`  格式不对，跳过：${bad.join('、')}`);
  if (dup.length) console.log(`  已在名单里或重复，跳过：${dup.join('、')}`);
  return add;
}

function planRemove(list, items) {
  const del = new Set(), miss = [];
  for (const s of items) {
    const i = /^\d+$/.test(s) ? Number(s) - 1 : list.findIndex((x) => same(x, s));
    if (i >= 0 && i < list.length) del.add(i);
    else miss.push(s);
  }
  if (miss.length) console.log(`  名单里没有，跳过：${miss.join('、')}`);
  const idx = [...del].sort((a, b) => a - b);
  if (idx.length && idx.length === list.length) {
    console.log('  不能全删，至少要留 1 个收件人。');
    return [];
  }
  return idx;
}

// 逐行读输入：键盘输入和管道输入（测试用）都能用
let rl;
const queue = [];
let waiter = null, closed = false;
function ask(q) {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('line', (l) => {
      if (waiter) { const w = waiter; waiter = null; w(l.trim()); } else queue.push(l.trim());
    });
    rl.on('close', () => { closed = true; if (waiter) waiter(null); });
  }
  const i = q.lastIndexOf('\n');
  if (i >= 0) process.stdout.write(q.slice(0, i + 1));
  if (closed) {
    process.stdout.write(q.slice(i + 1));
    return Promise.resolve(queue.length ? queue.shift() : null);
  }
  rl.setPrompt(q.slice(i + 1));
  rl.prompt();
  if (queue.length) return Promise.resolve(queue.shift());
  return new Promise((r) => { waiter = r; });
}
const confirm = async () => !/^n/i.test((await ask('回车确认，输入 n 取消\n> ')) ?? 'n');

async function menu() {
  console.log('AIGC 热点雷达 · 收件人管理');
  console.log('改完会同时更新本机 .env 和 GitHub，不用重新部署。');
  for (;;) {
    const list = current();
    show(list);
    const c = await ask('\n要做什么？ 1 添加　2 删除　3 重新同步到 GitHub　0 退出\n> ');
    if (c === null || c === '0') break;
    if (c === '1') {
      const add = planAdd(list, split((await ask('\n输入要添加的邮箱（多个用逗号或空格隔开）：\n> ')) || ''));
      if (!add.length) { console.log('  没有要添加的。'); continue; }
      console.log(`\n将添加 ${add.length} 个：${add.join('、')}`);
      if (await confirm()) await save([...list, ...add]); else console.log('  已取消。');
    } else if (c === '2') {
      const idx = planRemove(list, split((await ask('\n输入要删除的序号或邮箱（多个用逗号或空格隔开）：\n> ')) || ''));
      if (!idx.length) { console.log('  没有要删除的。'); continue; }
      const next = list.filter((_, i) => !idx.includes(i));
      console.log(`\n将删除 ${idx.length} 个：${idx.map((i) => list[i]).join('、')}`);
      if (idx[0] === 0 && !hasAlertTo()) console.log(`  注意：第 1 个地址也接收报警邮件，删掉后报警会改发给 ${next[0]}`);
      if (await confirm()) await save(next); else console.log('  已取消。');
    } else if (c === '3') {
      console.log('\n把本机 .env 里的名单重新传到 GitHub（手动改过 .env 时用）');
      if (await confirm()) await save(list); else console.log('  已取消。');
    } else console.log('  请输入 0~3');
  }
  rl?.close();
}

async function main() {
  if (!fs.existsSync(ENV)) throw new Error(`找不到 ${ENV}`);
  if (!cmd) return menu();
  const list = current();
  if (cmd === 'list') return show(list);
  if (cmd === 'sync') return save(list);
  if (cmd === 'add') {
    const add = planAdd(list, split(rest.join(' ')));
    return add.length ? save([...list, ...add]) : console.log('没有要添加的。');
  }
  if (cmd === 'remove') {
    const idx = planRemove(list, split(rest.join(' ')));
    return idx.length ? save(list.filter((_, i) => !idx.includes(i))) : console.log('没有要删除的。');
  }
  throw new Error(`不认识的命令 ${cmd}，可用：list / add / remove / sync`);
}

// 不用 process.exit()：Windows 上 fetch 刚结束就强退，Node 会打出一行「Assertion failed」
main().then((ok) => { if (ok === false) process.exitCode = 1; }, (e) => {
  console.error(`\n✗ ${e.message}`);
  process.exitCode = 1;
  rl?.close();
});
