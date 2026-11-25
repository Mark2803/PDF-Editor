#!/usr/bin/env node
/*
 * Сервер инструмента «Этикетки и Честный знак».
 *
 * Два режима:
 *  1) На своём компьютере (start.bat): открывает приложение на http://localhost:8787 и пересылает
 *     запросы проверки кодов в «Честный знак». Вход не нужен — сервер слушает только этот компьютер.
 *  2) На сайте tea-master-team.ru в разделе «Менеджмент» (как другие инструменты):
 *     nginx отдаёт /management/labels/ → этот сервер на 127.0.0.1:3400 (префикс nginx убирает).
 *     Админка после ввода PIN открывает …/management/labels/#t=ТОКЕН; токен проверяется по таблице
 *     management_access_tokens базы сайта (через psql), после чего выдаётся своя сессия (cookie).
 *     Без сессии проверка кодов не работает, а страница показывает «Доступ закрыт».
 *
 * Режим 2 включается, когда задан DATABASE_URL (файл .env рядом с server.js).
 * Без сторонних библиотек: только Node.js 18+ (на сервере — 22).
 *
 * Настройки (.env или переменные окружения):
 *   PORT=8787 (на сервере 3400)   HOST=127.0.0.1
 *   DATABASE_URL=postgresql://…   как в backend/.env сайта — включает вход через «Менеджмент»
 *   SESSION_SECRET=…              случайная строка для подписи сессии (обязательна в режиме 2)
 *   COOKIE_SECURE=1               cookie только по https (на сайте — 1)
 *   COOKIE_PATH=/management/labels/  cookie только для адреса инструмента
 *   CRPT_BASE=https://mobile.api.crpt.ru   адрес сервиса ЧЗ (для тестов)
 *   BASE_PATH=                    если nginx НЕ убирает префикс адреса (обычно пусто)
 */
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { URL } = require('url');

const ROOT = __dirname;

// ---------- настройки ----------
function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[line.slice(0, eq).trim()] = v;
  }
  return out;
}
const envFile = path.join(ROOT, '.env');
const fileEnv = fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, 'utf8')) : {};
const env = (k, d = '') => (process.env[k] ?? fileEnv[k] ?? d);

const PORT = parseInt(env('PORT', '8787'), 10);
const HOST = env('HOST', '127.0.0.1');
const CRPT_BASE = env('CRPT_BASE', 'https://mobile.api.crpt.ru');
const BASE_PATH = env('BASE_PATH', '').replace(/\/+$/, '');
const DATABASE_URL = env('DATABASE_URL', '');
const SESSION_SECRET = env('SESSION_SECRET', '');
const COOKIE_SECURE = env('COOKIE_SECURE', '') === '1';
const COOKIE_PATH = env('COOKIE_PATH', '/'); // на сайте: /management/labels/
const MOCK_TOKEN = env('MANAGEMENT_MOCK_TOKEN', ''); // только для тестов
const AUTH = !!(DATABASE_URL || MOCK_TOKEN);

if (AUTH && SESSION_SECRET.length < 20) {
  console.error('Не задан SESSION_SECRET (не короче 20 символов) — без него вход через «Менеджмент» небезопасен. Сервер не запущен.');
  process.exit(1);
}
const isLoopback = (h) => ['127.0.0.1', 'localhost', '::1'].includes(h);
if (!AUTH && !isLoopback(HOST)) {
  console.error(`HOST=${HOST} открывает сервер в сеть, но вход не настроен (нет DATABASE_URL). Сервер не запущен.`);
  process.exit(1);
}

const ALLOWED = new Set(['/mobile/check', '/v2/mobile/check']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const PUBLIC_FILES = new Set(['/index.html', '/style.css', '/app.js', '/core.js', '/checker.js', '/datamatrix.js', '/lib/pdf-lib.min.js']);

// ---------- вход через «Менеджмент» ----------
const COOKIE = 'labels_session';
const SESSION_HOURS = 12;
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const sign = (p) => crypto.createHmac('sha256', SESSION_SECRET).update(p).digest('base64url');

function createSession(expMs) {
  const exp = Math.min(expMs, Date.now() + SESSION_HOURS * 3600000);
  const p = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return { value: `${p}.${sign(p)}`, exp };
}
function checkSession(v) {
  if (!v || typeof v !== 'string') return false;
  const [p, s] = v.split('.');
  if (!p || !s) return false;
  const a = Buffer.from(s); const b = Buffer.from(sign(p));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try { const d = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); return typeof d.exp === 'number' && d.exp > Date.now(); } catch (e) { return false; }
}
function cookies(h = '') {
  const out = {};
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { /* битая cookie */ } }
  }
  return out;
}
function pgEnv(url) {
  const u = new URL(url.split('?')[0].replace(/^postgres(ql)?:/, 'http:'));
  return { PGHOST: decodeURIComponent(u.hostname) || 'localhost', PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, '')), PGCONNECT_TIMEOUT: '5' };
}
/** Время окончания токена «Менеджмента» (мс) или null. Пароль базы передаётся через окружение psql, не в командной строке. */
async function verifyManagementToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,200}$/.test(token)) return null;
  if (MOCK_TOKEN) return token === MOCK_TOKEN ? Date.now() + 3600000 : null;
  const hash = sha256(token);
  if (!/^[0-9a-f]{64}$/.test(hash)) return null; // только hex — безопасно подставлять в SQL
  const sql = `SELECT (extract(epoch FROM expires_at) * 1000)::bigint FROM management_access_tokens WHERE token_hash = '${hash}' AND expires_at > now() LIMIT 1`;
  const out = await new Promise((resolve, reject) => {
    execFile('psql', ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', sql],
      { env: Object.assign({ PATH: process.env.PATH || '/usr/bin:/bin' }, pgEnv(DATABASE_URL)), timeout: 10000 },
      (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim().slice(0, 200))) : resolve(String(stdout).trim())));
  });
  const exp = Number(out);
  return Number.isFinite(exp) && exp > Date.now() ? exp : null;
}
// не больше 5 неудачных попыток входа за 10 минут с одного адреса
const attempts = new Map();
function recentFails(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 600000);
  attempts.set(ip, list);
  return list;
}

// ---------- ответы ----------
function send(res, code, body, type, extra) {
  res.writeHead(code, Object.assign({
    'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  }, extra || {}));
  res.end(body);
}
const json = (res, code, obj, extra) => send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8', extra);

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function proxy(req, res, subPath, query) {
  if (!ALLOWED.has(subPath)) return send(res, 404, 'not allowed');
  let body;
  try { body = await readBody(req, 64 * 1024); } catch (e) { return send(res, 413, 'too big'); }
  const target = new URL(subPath + (query || ''), CRPT_BASE);
  const lib = target.protocol === 'http:' ? http : https;
  const up = lib.request(target, {
    method: req.method === 'POST' ? 'POST' : 'GET',
    headers: Object.assign({ Accept: 'application/json', 'Accept-Language': 'ru-RU,ru', 'User-Agent': 'okhttp/4.12.0' },
      req.method === 'POST' ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length } : {}),
    timeout: 20000,
  }, (ur) => {
    const out = [];
    ur.on('data', (c) => out.push(c));
    ur.on('end', () => send(res, ur.statusCode || 502, Buffer.concat(out), ur.headers['content-type'] || 'application/json'));
  });
  up.on('timeout', () => up.destroy(new Error('timeout')));
  up.on('error', (e) => json(res, 502, { proxyError: e.message }));
  if (req.method === 'POST') up.write(body);
  up.end();
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    let p = decodeURIComponent(u.pathname);
    if (BASE_PATH && p === BASE_PATH) { res.writeHead(301, { Location: BASE_PATH + '/' }); return res.end(); }
    if (BASE_PATH && p.startsWith(BASE_PATH + '/')) p = p.slice(BASE_PATH.length);
    const ip = String(req.headers['x-real-ip'] || req.socket.remoteAddress || '');
    const authed = !AUTH || checkSession(cookies(req.headers.cookie)[COOKIE]);

    if (p === '/api/me') return json(res, 200, { authRequired: AUTH, authenticated: authed });
    if (p === '/api/login' && req.method === 'POST') {
      if (!AUTH) return json(res, 200, { ok: true });
      if (recentFails(ip).length >= 5) return json(res, 429, { error: { message: 'Слишком много попыток входа. Подождите 10 минут.' } });
      let token = '';
      try { token = JSON.parse((await readBody(req, 4096)).toString('utf8')).token; } catch (e) { /* пустой запрос */ }
      let exp = null;
      try { exp = await verifyManagementToken(token); } catch (e) {
        console.error('Проверка токена «Менеджмента»:', e.message);
        return json(res, 503, { error: { message: 'Не удалось проверить доступ по базе сайта. Попробуйте позже.' } });
      }
      if (!exp) {
        recentFails(ip).push(Date.now());
        return json(res, 401, { error: { message: 'Ссылка устарела. Откройте инструмент заново: админка → «Менеджмент» → PIN.' } });
      }
      attempts.delete(ip);
      const s = createSession(exp);
      const cookie = [`${COOKIE}=${s.value}`, `Path=${COOKIE_PATH}`, 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.max(1, Math.floor((s.exp - Date.now()) / 1000))}`]
        .concat(COOKIE_SECURE ? ['Secure'] : []).join('; ');
      return json(res, 200, { ok: true }, { 'Set-Cookie': cookie });
    }
    if (p === '/crpt/ping') return authed ? json(res, 200, { ok: true }) : json(res, 401, { error: { message: 'нет доступа' } });
    if (p.startsWith('/crpt/')) {
      if (!authed) return json(res, 401, { error: { message: 'нет доступа' } });
      return proxy(req, res, p.slice('/crpt'.length), u.search);
    }

    // статические файлы приложения — только из белого списка
    if (p === '/') p = '/index.html';
    if (!PUBLIC_FILES.has(p)) return send(res, 404, 'not found');
    fs.readFile(path.join(ROOT, p), (err, data) => {
      if (err) return send(res, 404, 'not found');
      send(res, 200, data, TYPES[path.extname(p)] || 'application/octet-stream');
    });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, 'error');
  }
});

server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}/`;
  console.log('');
  console.log('  Этикетки + проверка кодов «Честный знак»');
  if (AUTH) console.log(`  Режим сайта: вход через «Менеджмент», слушаю ${HOST}:${PORT}`);
  else {
    console.log(`  Откройте в браузере: ${url}`);
    console.log('  Не закрывайте это окно, пока работаете. Остановить: Ctrl+C');
  }
  console.log('');
  if (!AUTH && process.argv.includes('--open')) {
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    require('child_process').exec(cmd, () => {});
  }
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.log(`Порт ${PORT} уже занят — возможно, программа уже запущена. Откройте http://localhost:${PORT}/`);
  else console.error(e);
  process.exit(1);
});
