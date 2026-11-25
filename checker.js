/*
 * Проверка кодов маркировки через открытый сервис «Честного знака» —
 * тот же сервер, к которому обращается потребительское приложение (mobile.api.crpt.ru), без авторизации.
 *
 * ВАЖНО: это недокументированный сервис мобильного приложения. Он отвечает только с российских
 * IP-адресов (из-за рубежа — ошибка 451) и может измениться без предупреждения. Поэтому разбор
 * ответа сделан терпимым, а «сырой» ответ сохраняется в отчёте.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CodeChecker = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const GS = '\u001d';
  const PUBLIC_BASE = 'https://mobile.api.crpt.ru';

  // ---------------- нормализация кода ----------------

  /** Восстановить GS в коде без разделителей: 01 GTIN 21 serial [GS 91 xxxx GS 92 44симв | GS 93 xxxx] */
  function restoreGs(s) {
    if (s.length < 19 || !s.startsWith('01') || s.substr(16, 2) !== '21') return null;
    const head = s.slice(0, 18); const n = s.length;
    if (n >= 18 + 1 + 6 + 46 && s.slice(n - 46, n - 44) === '92' && s.slice(n - 52, n - 50) === '91') {
      const serial = s.slice(18, n - 52);
      if (serial.length >= 1 && serial.length <= 20) return head + serial + GS + s.slice(n - 52, n - 46) + GS + s.slice(n - 46);
    }
    if (n >= 18 + 1 + 6 && s.slice(n - 6, n - 4) === '93') {
      const serial = s.slice(18, n - 6);
      if (serial.length >= 1 && serial.length <= 20) return head + serial + GS + s.slice(n - 6);
    }
    return null;
  }

  /**
   * Привести строку из файла к виду «как в DataMatrix»: с символами GS, без префиксов.
   * Возвращает { code, cis, notes } или null, если это не похоже на код маркировки.
   */
  function normalizeCode(input) {
    let s = String(input == null ? '' : input);
    const notes = [];
    for (const sub of ['_x001D_', '_x001d_', '<GS>', '{GS}', '[GS]', '\\u001d', '\\u001D', '\\x1d', '\\x1D', '␝', '‹GS›']) {
      if (s.includes(sub)) s = s.split(sub).join(GS);
    }
    s = s.replace(/è/g, GS);
    s = s.split('').filter((c) => c === GS || (c.charCodeAt(0) > 0x20 && c.charCodeAt(0) !== 0x7f)).join('');
    let changed = true;
    while (changed) {
      changed = false;
      for (const p of ['{FNC1}', ']d2', ']d1', ']C1', ']Q3']) if (s.startsWith(p)) { s = s.slice(p.length); changed = true; }
      while (s[0] === GS) { s = s.slice(1); changed = true; }
    }
    while (s.endsWith(GS)) s = s.slice(0, -1);
    if (!/^01\d{14}21./.test(s) && !(s.length === 29 && /^\d{14}/.test(s))) return null;
    if (/^01\d{14}21/.test(s) && !s.includes(GS)) {
      const r = restoreGs(s);
      if (r) { s = r; notes.push('восстановлены разделители GS'); } else notes.push('в коде нет разделителей GS');
    }
    const ki = s.split(GS)[0];
    return { code: s, cis: ki, notes };
  }

  // ---------------- чтение файлов ----------------

  function codesFromText(text) {
    const out = [];
    const lines = String(text).split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      // 1) вся строка — это код (коды сами могут содержать ; и ,)
      let n = normalizeCode(line.trim());
      // 2) CSV: код в одном из столбцов (с учётом кавычек)
      if (!n) {
        for (const d of [';', '\t', ',']) {
          for (const cell of splitCsv(line, d)) { n = normalizeCode(cell.trim()); if (n) break; }
          if (n) break;
        }
      }
      if (n) out.push(Object.assign(n, { source: `строка ${i + 1}` }));
    });
    return out;
  }

  function splitCsv(line, d) {
    const cells = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === d) { cells.push(cur); cur = ''; }
      else cur += c;
    }
    cells.push(cur);
    return cells;
  }

  async function inflateRaw(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** Минимальное чтение ZIP (xlsx): возвращает Map имя -> Uint8Array для нужных файлов */
  async function unzip(bytes, want) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 70000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('файл повреждён или это не .xlsx');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const files = new Map();
    const dec = new TextDecoder();
    for (let k = 0; k < count; k++) {
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true); const xlen = dv.getUint16(p + 30, true); const clen = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + xlen + clen;
      if (!want(name)) continue;
      const lnlen = dv.getUint16(lho + 26, true); const lxlen = dv.getUint16(lho + 28, true);
      const data = bytes.subarray(lho + 30 + lnlen + lxlen, lho + 30 + lnlen + lxlen + csize);
      files.set(name, method === 0 ? data : await inflateRaw(data));
    }
    return files;
  }

  function xmlUnescape(s) {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d)).replace(/&amp;/g, '&');
  }

  async function codesFromXlsx(bytes) {
    const files = await unzip(bytes, (n) => n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
    const dec = new TextDecoder();
    const shared = [];
    if (files.has('xl/sharedStrings.xml')) {
      const xml = dec.decode(files.get('xl/sharedStrings.xml'));
      const siRe = /<si>([\s\S]*?)<\/si>/g; let m;
      while ((m = siRe.exec(xml))) {
        const parts = []; const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g; let t;
        while ((t = tRe.exec(m[1]))) parts.push(xmlUnescape(t[1]));
        shared.push(parts.join(''));
      }
    }
    const out = [];
    const sheets = [...files.keys()].filter((n) => n.startsWith('xl/worksheets/')).sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
    for (const sh of sheets) {
      const xml = dec.decode(files.get(sh));
      const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g; let m;
      while ((m = cRe.exec(xml))) {
        const attrs = m[1]; const inner = m[2] || '';
        const ref = (attrs.match(/\br="([A-Z]+\d+)"/) || [])[1] || '';
        const type = (attrs.match(/\bt="(\w+)"/) || [])[1];
        let val = null;
        if (type === 's') { const v = inner.match(/<v>(\d+)<\/v>/); if (v) val = shared[+v[1]]; }
        else if (type === 'inlineStr') { const t = inner.match(/<t[^>]*>([\s\S]*?)<\/t>/); if (t) val = xmlUnescape(t[1]); }
        else { const v = inner.match(/<v>([\s\S]*?)<\/v>/); if (v) val = xmlUnescape(v[1]); }
        if (val == null) continue;
        const n = normalizeCode(val);
        if (n) out.push(Object.assign(n, { source: `${sheets.length > 1 ? sh.match(/sheet\d+/)[0] + ' ' : ''}ячейка ${ref}` }));
      }
    }
    return out;
  }

  /** PDF «Честного знака»: читаем DataMatrix на каждой странице (нужен LabelCore) */
  async function codesFromPdf(bytes, LabelCore, onProgress) {
    const a = await LabelCore.analyzeCodes(bytes, onProgress);
    return a.pages.map((p, i) => {
      if (!p.fullCode) return { code: '', cis: p.code, source: `стр. ${i + 1}`, notes: [p.dmError || 'DataMatrix не прочитан'], unreadable: true };
      const n = normalizeCode(p.fullCode) || { code: p.fullCode, cis: p.code, notes: [] };
      return Object.assign(n, { source: `стр. ${i + 1}` });
    });
  }

  async function readFile(name, bytes, LabelCore, onProgress) {
    const lower = name.toLowerCase();
    if (lower.endsWith('.pdf')) return codesFromPdf(bytes, LabelCore, onProgress);
    if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) return codesFromXlsx(bytes);
    if (lower.endsWith('.xls')) throw new Error('старый формат .xls не поддерживается — сохраните файл как .xlsx или .csv');
    return codesFromText(new TextDecoder('utf-8').decode(bytes));
  }

  // ---------------- разбор ответа сервера ----------------

  const GREEN = new Set(['INTRODUCED', 'IN_CIRCULATION', 'INTRODUCED_RETURNED', 'RETURNED']);
  const NOT_INTRODUCED = new Set(['EMITTED', 'APPLIED', 'APPLIED_PAID', 'APPLIED_NOT_PAID', 'NOT_INTRODUCED']);
  const RETIRED = new Set(['RETIRED', 'WITHDRAWN', 'WRITTEN_OFF', 'DESTROYED', 'SOLD', 'IN_CIRCULATION_SOLD', 'OUT_OF_CIRCULATION', 'EXPIRED', 'UTILISED', 'UTILIZED', 'DISAGGREGATED', 'DISAGGREGATION']);
  const BLOCKED = new Set(['WITHHELD', 'BLOCKED', 'SUSPENDED', 'FROZEN']);
  const STATUS_RU = {
    EMITTED: 'Эмитирован, не нанесён', APPLIED: 'Нанесён, НЕ введён в оборот', APPLIED_PAID: 'Нанесён, НЕ введён в оборот',
    APPLIED_NOT_PAID: 'Нанесён, не оплачен', NOT_INTRODUCED: 'НЕ введён в оборот', INTRODUCED: 'В обороте', IN_CIRCULATION: 'В обороте',
    INTRODUCED_RETURNED: 'В обороте (возвращён)', RETURNED: 'В обороте (возвращён)', WRITTEN_OFF: 'Списан', RETIRED: 'Выбыл из оборота',
    WITHDRAWN: 'Выведен из оборота', OUT_OF_CIRCULATION: 'Выведен из оборота', DESTROYED: 'Уничтожен', UTILISED: 'Утилизирован',
    UTILIZED: 'Утилизирован', SOLD: 'Продан', IN_CIRCULATION_SOLD: 'Продан', WITHHELD: 'Приостановлен', BLOCKED: 'Заблокирован',
    SUSPENDED: 'Приостановлен', FROZEN: 'Заморожен', EXPIRED: 'Истёк срок годности', DISAGGREGATED: 'Расформирован', DISAGGREGATION: 'Расформирован',
  };

  function findGroup(json) {
    for (const k of Object.keys(json)) {
      if (['codeResolveData', 'catalogData', 'cisInfo', 'errors'].includes(k)) continue;
      if (k.endsWith('Data') && json[k] && typeof json[k] === 'object' && !Array.isArray(json[k])) return json[k];
    }
    return null;
  }
  const str = (o, k) => (o && o[k] != null && typeof o[k] !== 'object' && String(o[k]).trim() ? String(o[k]).trim() : null);
  const first = (srcs, ...keys) => { for (const o of srcs) for (const k of keys) { const v = str(o, k); if (v) return v; } return null; };
  function parseJson(body) {
    if (!body) return null;
    const t = String(body).trim();
    try { const j = JSON.parse(t); return Array.isArray(j) ? j[0] || null : (typeof j === 'object' ? j : null); } catch (e) { return null; }
  }

  /** Вердикт: level = ok | bad | warn | error */
  function evaluate(httpCode, body) {
    const json = parseJson(body);
    if (!json) {
      if (httpCode === 451) return { level: 'error', title: 'Сервис ЧЗ доступен только из России (ошибка 451)' };
      if (httpCode === 429) return { level: 'error', title: 'Слишком много запросов — пауза' };
      if (httpCode === 404 || httpCode === 400) return { level: 'bad', title: 'Код не найден в Честном знаке' };
      if (httpCode >= 500) return { level: 'error', title: `Сервер ЧЗ не отвечает (ошибка ${httpCode})` };
      return { level: 'error', title: `Непонятный ответ сервера (HTTP ${httpCode})` };
    }
    const group = findGroup(json);
    const cisInfo = json.cisInfo && typeof json.cisInfo === 'object' ? json.cisInfo : null;
    const srcs = [json, group, cisInfo].filter(Boolean);
    const product = first(srcs, 'productName', 'name', 'goodName', 'good_name')
      || (Array.isArray(json.catalogData) ? first(json.catalogData, 'good_name', 'name', 'productName') : null);
    if (httpCode >= 400 && !('codeFounded' in json) && !group && !cisInfo) {
      if (httpCode === 451) return { level: 'error', title: 'Сервис ЧЗ доступен только из России (ошибка 451)' };
      if (httpCode === 429) return { level: 'error', title: 'Слишком много запросов — пауза' };
      if (httpCode === 404 || httpCode === 400) return { level: 'bad', title: 'Код не найден в Честном знаке', product };
      return { level: 'error', title: `Ошибка сервера ЧЗ (HTTP ${httpCode})` };
    }
    const top = String(json.status || '').trim();
    if (/^(wrong|invalid)$/i.test(top)) return { level: 'bad', title: 'Неверный код маркировки', product, status: top };
    if (json.codeFounded === false) return { level: 'bad', title: 'Код не найден в Честном знаке', product };

    const raw = str(json, 'outerStatus') || first([group, cisInfo].filter(Boolean), 'outerStatus', 'status', 'cisStatus', 'statusEx')
      || str(json, 'cisStatus') || (STATUS_RU[top.toUpperCase()] ? top : null);
    const status = raw ? raw.toUpperCase() : null;
    let level; let title;
    if (!status) { level = 'warn'; title = json.codeFounded === true ? 'Код найден, но статус не указан' : 'В ответе нет статуса'; }
    else if (GREEN.has(status)) { level = 'ok'; title = 'В обороте'; }
    else if (NOT_INTRODUCED.has(status)) { level = 'bad'; title = STATUS_RU[status] || 'Не введён в оборот'; }
    else if (RETIRED.has(status)) { level = 'bad'; title = STATUS_RU[status] || 'Выведен из оборота'; }
    else if (BLOCKED.has(status)) { level = 'bad'; title = 'Оборот приостановлен / заблокирован'; }
    else { level = 'warn'; title = STATUS_RU[status] || `Статус: ${raw}`; }
    if (srcs.some((o) => o.isBlocked === true || o.blocked === true) && level !== 'bad') { level = 'bad'; title = 'Код заблокирован'; }
    if (json.checkResult === false && level === 'ok') { level = 'warn'; title = 'В обороте, но проверка подписи кода не пройдена'; }
    const details = [];
    const owner = first(srcs, 'ownerName', 'owner_name'); if (owner) details.push(`владелец: ${owner}`);
    const inn = first(srcs, 'ownerInn', 'owner_inn'); if (inn) details.push(`ИНН ${inn}`);
    return { level, title, status: raw, product, details: details.join(', ') };
  }

  // ---------------- запросы ----------------

  const VARIANTS = ['v2post', 'v1post', 'v1get'];

  async function callVariant(base, variant, code, timeoutMs) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs || 15000) : null;
    const b = base.replace(/\/+$/, '');
    let url; let init;
    const headers = { Accept: 'application/json' };
    if (variant === 'v2post') {
      url = `${b}/v2/mobile/check`;
      init = { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers), body: JSON.stringify({ code: '{FNC1}' + code, codeType: 'datamatrix' }) };
    } else if (variant === 'v1post') {
      url = `${b}/mobile/check`;
      init = { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers), body: JSON.stringify({ code, codeType: 'datamatrix' }) };
    } else {
      url = `${b}/mobile/check?code=${encodeURIComponent(code)}&codeType=datamatrix`;
      init = { method: 'GET', headers };
    }
    if (ctrl) init.signal = ctrl.signal;
    try {
      const r = await fetch(url, init);
      const text = await r.text();
      return { http: r.status, body: text };
    } catch (e) {
      return { http: 0, body: null, netError: e && e.name === 'AbortError' ? 'сервер не ответил вовремя' : 'нет связи с сервисом' };
    } finally { if (timer) clearTimeout(timer); }
  }

  /**
   * Проверить один код. cfg: { base, preferred } — preferred запоминается между вызовами.
   * Возвращает вердикт + http, raw.
   */
  async function checkCode(code, cfg) {
    const order = cfg.preferred ? [cfg.preferred].concat(VARIANTS.filter((v) => v !== cfg.preferred)) : VARIANTS.slice();
    let last = null;
    for (const v of order) {
      const r = await callVariant(cfg.base, v, code, cfg.timeoutMs);
      if (r.netError) return { level: 'error', title: r.netError, http: 0, raw: '', net: true };
      const verdict = evaluate(r.http, r.body);
      last = Object.assign(verdict, { http: r.http, raw: (r.body || '').slice(0, 2000), variant: v });
      if (r.http === 451 || r.http === 429) return last;
      // адрес «не тот» (нет метода/формата) — пробуем следующий вариант
      if ([404, 405, 415].includes(r.http) && !parseJson(r.body)) continue;
      if (r.http >= 200 && r.http < 300) { cfg.preferred = v; return last; }
      if (verdict.level === 'bad') { cfg.preferred = cfg.preferred || v; return last; }
    }
    return last || { level: 'error', title: 'нет ответа' };
  }

  /**
   * Проверка списка кодов с ограничением скорости (чтобы сервис не принял это за атаку).
   * items: [{code,...}], opts: { base, concurrency=2, pauseMs=300, onResult(i, res), shouldStop() }
   */
  async function checkMany(items, opts) {
    const cfg = { base: opts.base, preferred: opts.preferred || null, timeoutMs: opts.timeoutMs };
    const conc = Math.max(1, opts.concurrency || 2);
    let next = 0; let pauseUntil = 0;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    async function worker() {
      while (next < items.length) {
        if (opts.shouldStop && opts.shouldStop()) return;
        const i = next++;
        const it = items[i];
        if (!it.code) { opts.onResult(i, { level: 'error', title: 'код не прочитан из файла' }); continue; }
        const wait = pauseUntil - Date.now(); if (wait > 0) await sleep(wait);
        let res = await checkCode(it.code, cfg);
        if (res.http === 429) { pauseUntil = Date.now() + 20000; await sleep(20000); res = await checkCode(it.code, cfg); }
        opts.onResult(i, res);
        if (res.http === 451) { opts.onFatal && opts.onFatal(res); return; }
        await sleep(opts.pauseMs == null ? 300 : opts.pauseMs);
      }
    }
    await Promise.all(Array.from({ length: conc }, worker));
    return cfg.preferred;
  }

  function display(code) { return String(code || '').replace(/\u001d/g, '‹GS›'); }

  return { PUBLIC_BASE, normalizeCode, restoreGs, codesFromText, codesFromXlsx, codesFromPdf, readFile, evaluate, checkCode, checkMany, display, STATUS_RU };
});
