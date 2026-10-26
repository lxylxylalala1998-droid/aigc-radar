import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TZ, AI_RE } from './config.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = path.join(ROOT, 'data');

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
export const HOUR = 3600e3;
export const DAY = 24 * HOUR;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 读本地 .env（GitHub 上用 Secrets 注入环境变量，不需要这个文件）
export function loadEnv() {
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export async function http(url, { headers = {}, timeout = 20000, retries = 2, type = 'json', method = 'GET', body } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        method, body,
        headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', ...headers },
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        // 4xx（除了 429）重试没用，还会加重风控，直接放弃
        if (res.status >= 400 && res.status < 500 && res.status !== 429) { err.fatal = true; throw err; }
        throw err;
      }
      return type === 'json' ? await res.json() : await res.text();
    } catch (e) {
      lastErr = e;
      if (e.fatal) break;
      if (i < retries) await sleep(1000 * (i + 1));
    }
  }
  const err = new Error(`${lastErr.message} @ ${url.slice(0, 90)}`);
  err.status = lastErr.status;
  throw err;
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’' };
export function clean(s = '') {
  return String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

export const isAI = (s) => AI_RE.test(s || '');

// 北京时间的日期 / 时分
export function bjDate(ts = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ts);
}
export function bjTime(ts = Date.now()) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(ts);
}

export function readJSON(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
export function writeJSON(file, obj, pretty = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, pretty ? 1 : 0));
}

// "1.2万" / "3,456" / "12.3M views" → 数字
export function parseCount(s) {
  if (typeof s === 'number') return s;
  if (!s) return 0;
  const m = String(s).replace(/,/g, '').match(/([\d.]+)\s*([万亿KMB]?)/i);
  if (!m) return 0;
  const mul = { '万': 1e4, '亿': 1e8, k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()] || 1;
  return Math.round(parseFloat(m[1]) * mul);
}

export function fmtNum(n) {
  if (!n) return '0';
  if (n >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, '') + '亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + '万';
  return String(Math.round(n));
}

// 当前文件是否被直接 node 运行（而不是被 import）
export const isMain = (metaUrl) => path.resolve(fileURLToPath(metaUrl)) === path.resolve(process.argv[1] || '');
