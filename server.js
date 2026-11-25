#!/usr/bin/env node
/*
 * Программа-посредник для проверки кодов в «Честном знаке».
 *
 * Зачем: браузер не даёт странице напрямую обращаться к чужому серверу (mobile.api.crpt.ru),
 * поэтому запросы идут через эту маленькую программу на вашем компьютере.
 * Она же открывает само приложение по адресу http://localhost:8787
 *
 * Запуск: двойной щелчок по start.bat (Windows) или `node server.js`.
 * Нужен только Node.js (https://nodejs.org, версия LTS). Никаких других установок.
 *
 * Пересылаются ТОЛЬКО запросы проверки кода (/mobile/check и /v2/mobile/check) — это не открытый прокси.
 * Настройки через переменные окружения:
 *   PORT=8787           порт
 *   HOST=127.0.0.1      адрес (0.0.0.0 — если ставите на свой сервер)
 *   CRPT_BASE=https://mobile.api.crpt.ru   адрес сервиса ЧЗ (для тестов)
 *   BASE_PATH=/tools/labels  если приложение открывается не с корня сайта
 */
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '127.0.0.1';
const CRPT_BASE = process.env.CRPT_BASE || 'https://mobile.api.crpt.ru';
const ROOT = __dirname;
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/+$/, '');
const ALLOWED = new Set(['/mobile/check', '/v2/mobile/check']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8' };

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function proxy(req, res, subPath, query) {
  if (!ALLOWED.has(subPath)) return send(res, 404, 'not allowed');
  const chunks = [];
  let size = 0;
  req.on('data', (c) => { size += c.length; if (size > 64 * 1024) req.destroy(); else chunks.push(c); });
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const target = new URL(subPath + (query || ''), CRPT_BASE);
    const lib = target.protocol === 'http:' ? http : https;
    const up = lib.request(target, {
      method: req.method === 'POST' ? 'POST' : 'GET',
      headers: Object.assign({
        Accept: 'application/json',
        'Accept-Language': 'ru-RU,ru',
        'User-Agent': 'okhttp/4.12.0',
      }, req.method === 'POST' ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length } : {}),
      timeout: 20000,
    }, (ur) => {
      const out = [];
      ur.on('data', (c) => out.push(c));
      ur.on('end', () => send(res, ur.statusCode || 502, Buffer.concat(out), ur.headers['content-type'] || 'application/json'));
    });
    up.on('timeout', () => up.destroy(new Error('timeout')));
    up.on('error', (e) => send(res, 502, JSON.stringify({ proxyError: e.message }), 'application/json'));
    if (req.method === 'POST') up.write(body);
    up.end();
  });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  let p = decodeURIComponent(u.pathname);
  // работа под префиксом, например /tools/labels/ (BASE_PATH=/tools/labels)
  if (BASE_PATH && p === BASE_PATH) { res.writeHead(301, { Location: BASE_PATH + '/' }); return res.end(); }
  if (BASE_PATH && p.startsWith(BASE_PATH + '/')) p = p.slice(BASE_PATH.length);
  if (p === '/crpt/ping') return send(res, 200, JSON.stringify({ ok: true, base: CRPT_BASE }), 'application/json');
  if (p.startsWith('/crpt/')) return proxy(req, res, p.slice('/crpt'.length), u.search);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT + path.sep) || p.includes('..') || /\/\.|node_modules/.test(p)) return send(res, 403, 'forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'not found');
    send(res, 200, data, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
  });
});

server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}/`;
  console.log('');
  console.log('  Этикетки + проверка кодов «Честный знак»');
  console.log(`  Откройте в браузере: ${url}`);
  console.log('  Не закрывайте это окно, пока работаете. Остановить: Ctrl+C');
  console.log('');
  if (process.argv.includes('--open')) {
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    require('child_process').exec(cmd, () => {});
  }
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.log(`Порт ${PORT} уже занят — возможно, программа уже запущена. Откройте http://localhost:${PORT}/`);
  else console.error(e);
});
