// 把云端 data 分支最近的数据拉到本地，用来在本机测试（只走 api.github.com，本机打不开 github.com 也能用）
// 用法：node scripts/pull-data.mjs [目标目录，默认项目里的 data] [天数，默认 33]
//   建议拉到一个测试目录（比如复制一份项目），别和正在改的代码混在一起；拉到项目自己的 data/ 也行，它不进 git
// 需要 .env 里的 GITHUB_TOKEN，和部署时生成的 .deploy.json（记着仓库名）
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadEnv } from '../src/util.js';

loadEnv();
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'data'));
const DAYS = +process.argv[3] || 33;
const dep = JSON.parse(fs.readFileSync(path.join(ROOT, '.deploy.json'), 'utf8'));
const H = { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` };
const repo = `https://api.github.com/repos/${dep.owner}/${dep.repo}`;
const gh = async (u) => {
  const r = await fetch(repo + u, { headers: { ...H, Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`${r.status} ${u}`);
  return r.json();
};

const ref = await gh('/git/ref/heads/data');
const c = await gh(`/git/commits/${ref.object.sha}`);
console.log(`data 分支最新：${c.message}`);
const t = await gh(`/git/trees/${c.tree.sha}?recursive=1`);
// 根目录的状态 / 缓存文件全要；按天的数据和日报只要最近 DAYS 天；周报全要
const cut = new Date(Date.now() - DAYS * 864e5).toISOString().slice(0, 10);
const want = t.tree.filter((e) => e.type === 'blob' && (
  !e.path.includes('/')
  || (/^days\//.test(e.path) && e.path.slice(5, 15) >= cut)
  || (/^digests\//.test(e.path) && e.path.slice(8, 18) >= cut)
  || /^weekly\//.test(e.path)));
console.log(`${want.length} 个文件，${(want.reduce((s, e) => s + e.size, 0) / 1048576).toFixed(1)}MB → ${OUT}`);

let i = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (i < want.length) {
    const e = want[i++];
    const f = path.join(OUT, e.path);
    if (fs.existsSync(f) && fs.statSync(f).size === e.size) continue; // 已经有了、大小一样的跳过
    // 大文件（每天的数据好几 MB）偶尔下到一半连接被重置，重试几次
    for (let k = 1; ; k++) {
      try {
        const r = await fetch(`${repo}/git/blobs/${e.sha}`, { headers: { ...H, Accept: 'application/vnd.github.raw' } });
        if (!r.ok) throw new Error(`${r.status} ${e.path}`);
        const buf = Buffer.from(await r.arrayBuffer());
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, buf);
        break;
      } catch (err) {
        if (k >= 4) throw err;
        console.log(`  ${e.path} 第 ${k} 次失败（${err.cause?.code || err.message}），重试`);
        await new Promise((ok) => setTimeout(ok, 2000 * k));
      }
    }
  }
}));
console.log('完成');
