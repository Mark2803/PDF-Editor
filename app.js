/* Интерфейс. Вся обработка идёт локально в браузере — файлы никуда не отправляются. */
(function () {
  'use strict';
  const Core = window.LabelCore;
  const $ = (id) => document.getElementById(id);

  const DEFAULT_ZONES = {
    code: { x: 49, y: 13.5, w: 23, h: 23.5 },
    info: { x: 33, y: 1.5, w: 39, h: 9 },
    codeInfo: { x: 1.5, y: 1.5, w: 32, h: 12 },
  };
  const DEFAULT_STYLE = { prefixColor: '#2b3fbf', numberColor: '#1e9e3e', numberScale: 1.7, alignLabel: 'left', layoutCode: 'auto' };

  const state = {
    profiles: new Map(),
    zones: JSON.parse(JSON.stringify(DEFAULT_ZONES)),
    template: null, // {kind, bytes, fileName, widthMm, heightMm}
    codes: null, // {bytes, fileName, analysis, reused:[]}
    previewUrls: [],
    busy: false,
  };

  // ---------------- IndexedDB ----------------
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('pdf-editor-labels', 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('profiles')) d.createObjectStore('profiles', { keyPath: 'article' });
        if (!d.objectStoreNames.contains('used')) d.createObjectStore('used', { keyPath: 'code' });
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const s = t.objectStore(store);
      const out = fn(s);
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      t.onerror = () => reject(t.error);
    });
  }
  const idbGetAll = (store) => tx(store, 'readonly', (s) => s.getAll());
  const idbPut = (store, v) => tx(store, 'readwrite', (s) => s.put(v));
  const idbDel = (store, k) => tx(store, 'readwrite', (s) => s.delete(k));
  async function idbGetMany(store, keys) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, 'readonly');
      const s = t.objectStore(store);
      const found = [];
      keys.forEach((k) => { const r = s.get(k); r.onsuccess = () => { if (r.result) found.push(r.result); }; });
      t.oncomplete = () => resolve(found);
      t.onerror = () => reject(t.error);
    });
  }
  async function idbPutMany(store, values) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, 'readwrite');
      const s = t.objectStore(store);
      values.forEach((v) => s.put(v));
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }

  // ---------------- форма <-> состояние ----------------
  function readZonesFromForm() {
    document.querySelectorAll('.zone').forEach((row) => {
      const z = row.dataset.zone;
      row.querySelectorAll('input').forEach((inp) => {
        const v = parseFloat(inp.value);
        if (!Number.isNaN(v)) state.zones[z][inp.dataset.k] = v;
      });
    });
  }
  function writeZonesToForm() {
    document.querySelectorAll('.zone').forEach((row) => {
      const z = row.dataset.zone;
      row.querySelectorAll('input').forEach((inp) => { inp.value = state.zones[z][inp.dataset.k]; });
    });
  }
  function readStyle() {
    return {
      prefixColor: $('colPrefix').value,
      numberColor: $('colNumber').value,
      numberScale: Math.max(1, parseFloat($('numScale').value) || 1.7),
      alignLabel: $('alignLabel').value,
      layoutCode: $('layoutCode').value,
    };
  }
  function writeStyle(st) {
    const s = Object.assign({}, DEFAULT_STYLE, st || {});
    $('colPrefix').value = s.prefixColor; $('colNumber').value = s.numberColor;
    $('numScale').value = s.numberScale; $('alignLabel').value = s.alignLabel; $('layoutCode').value = s.layoutCode;
  }
  const article = () => $('article').value.trim();
  const startNum = () => Math.max(1, parseInt($('startNum').value, 10) || 1);

  function todayIso() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // ---------------- профили ----------------
  function refreshArticleList() {
    const dl = $('articleList');
    dl.innerHTML = '';
    [...state.profiles.values()].sort((a, b) => a.article.localeCompare(b.article)).forEach((p) => {
      const o = document.createElement('option');
      o.value = p.article; o.label = p.name || '';
      dl.appendChild(o);
    });
  }

  function currentProfileData() {
    readZonesFromForm();
    const prev = state.profiles.get(article()) || {};
    return {
      article: article(),
      name: $('productName').value.trim(),
      zones: JSON.parse(JSON.stringify(state.zones)),
      style: readStyle(),
      template: state.template ? {
        kind: state.template.kind, fileName: state.template.fileName,
        widthMm: state.template.widthMm, heightMm: state.template.heightMm,
        bytes: state.template.bytes.slice().buffer,
      } : (prev.template || null),
      lastNumber: prev.lastNumber || 0,
      updated: Date.now(),
    };
  }

  async function saveProfile(extra) {
    const a = article();
    if (!a) { alert('Введите артикул'); return null; }
    const p = Object.assign(currentProfileData(), extra || {});
    await idbPut('profiles', p);
    state.profiles.set(a, p);
    refreshArticleList();
    updateProfileStatus();
    return p;
  }

  function loadProfile(p) {
    $('productName').value = p.name || '';
    state.zones = Object.assign(JSON.parse(JSON.stringify(DEFAULT_ZONES)), JSON.parse(JSON.stringify(p.zones || {})));
    writeZonesToForm();
    writeStyle(p.style);
    if (p.template && p.template.bytes) {
      state.template = {
        kind: p.template.kind, fileName: p.template.fileName,
        widthMm: p.template.widthMm, heightMm: p.template.heightMm,
        bytes: new Uint8Array(p.template.bytes),
      };
    } else {
      state.template = null;
    }
    $('startNum').value = (p.lastNumber || 0) + 1;
    showTemplateInfo();
  }

  function updateProfileStatus() {
    const a = article();
    const p = state.profiles.get(a);
    $('profileStatus').textContent = !a ? '' : p
      ? `сохранён${p.lastNumber ? `, последний номер: ${p.lastNumber}` : ''}`
      : 'новый товар — не сохранён';
  }

  function onArticleChanged() {
    const a = article();
    const p = state.profiles.get(a);
    if (p) loadProfile(p);
    updateProfileStatus();
    checkArticleChars();
    updateDerived();
    schedulePreview();
  }

  function checkArticleChars() {
    const a = article();
    const safe = Core.safeText(a);
    const w = $('articleWarn');
    if (a && safe !== a) {
      w.hidden = false;
      w.textContent = `На этикетке артикул напечатается латиницей: «${safe}». Лучше сразу вводить латиницей.`;
    } else w.hidden = true;
  }

  // ---------------- шаблон ----------------
  async function onTemplateFile(file) {
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const name = file.name.toLowerCase();
    let kind = 'pdf';
    if (/\.png$/.test(name) || file.type === 'image/png') kind = 'png';
    else if (/\.jpe?g$/.test(name) || file.type === 'image/jpeg') kind = 'jpg';
    const t = { kind, bytes, fileName: file.name, widthMm: parseFloat($('tplW').value) || 75, heightMm: parseFloat($('tplH').value) || 120 };
    try {
      if (kind === 'pdf') {
        const d = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
        const { width, height } = d.getPage(0).getSize();
        t.widthMm = +(width / Core.MM).toFixed(1); t.heightMm = +(height / Core.MM).toFixed(1);
        t.pages = d.getPageCount();
      } else {
        const bmp = await createImageBitmap(new Blob([bytes], { type: kind === 'png' ? 'image/png' : 'image/jpeg' }));
        t.px = [bmp.width, bmp.height];
      }
    } catch (e) {
      alert('Не удалось открыть шаблон: ' + e.message);
      return;
    }
    state.template = t;
    showTemplateInfo();
    schedulePreview();
  }

  function showTemplateInfo() {
    const t = state.template;
    const info = $('tplInfo');
    const isImg = t && t.kind !== 'pdf';
    $('tplSizeRow').style.display = isImg || !t ? '' : 'none';
    if (!t) { info.textContent = 'Шаблон не загружен'; info.className = 'muted'; return; }
    $('tplW').value = t.widthMm; $('tplH').value = t.heightMm;
    if (t.kind === 'pdf') {
      info.className = 'muted';
      info.textContent = `${t.fileName}: PDF ${t.widthMm} × ${t.heightMm} мм${t.pages > 1 ? ` (используется 1-я страница из ${t.pages})` : ''}`;
    } else {
      let dpiTxt = '';
      if (t.px) {
        const dpi = Math.round(t.px[0] / (t.widthMm / 25.4));
        dpiTxt = `, ${t.px[0]}×${t.px[1]} px ≈ ${dpi} dpi`;
        info.className = dpi < 250 ? 'warn' : 'muted';
        if (dpi < 250) dpiTxt += ' — мало для печати, текст будет размытым. Нужно от 300 dpi или PDF.';
      }
      info.textContent = `${t.fileName}: ${t.kind.toUpperCase()}${dpiTxt}`;
    }
  }

  // ---------------- коды ----------------
  async function onCodesFile(file) {
    if (!file) return;
    const info = $('codesInfo');
    $('codesProblems').innerHTML = '';
    info.className = 'muted';
    info.textContent = 'Читаю файл…';
    state.codes = null;
    updateDerived();
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const analysis = await Core.analyzeCodes(bytes, (i, n) => { info.textContent = `Читаю файл… ${i} / ${n}`; });
      state.codes = { bytes, fileName: file.name, analysis, reused: [] };
      const codes = analysis.pages.map((p) => p.code).filter(Boolean);
      state.codes.reused = await idbGetMany('used', codes);
      info.className = '';
      info.innerHTML = `<b>${file.name}</b>: <b>${analysis.pageCount}</b> стр. = ${analysis.pageCount} кодов`;
      renderCodeProblems();
    } catch (e) {
      info.className = 'err';
      info.textContent = 'Не удалось прочитать файл кодов: ' + e.message;
    }
    updateDerived();
    schedulePreview();
  }

  function renderCodeProblems() {
    const box = $('codesProblems');
    box.innerHTML = '';
    if (!state.codes) return;
    const a = state.codes.analysis;
    const add = (cls, html) => { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; box.appendChild(d); };
    if (a.duplicates.length) {
      add('err', `<b>Одинаковые коды внутри файла (${a.duplicates.length})!</b> Формирование запрещено.<ul>${a.duplicates.slice(0, 10).map((d) => `<li>стр. ${d.pages.join(' и ')}: ${esc(d.code)}</li>`).join('')}</ul>`);
    }
    if (a.notFound.length) {
      add('warn', `На стр. ${a.notFound.slice(0, 15).join(', ')}${a.notFound.length > 15 ? '…' : ''} не удалось найти DataMatrix автоматически — будет вставлена страница целиком. Проверьте предпросмотр.`);
    }
    if (state.codes.reused.length) {
      const r = state.codes.reused;
      add('warn', `<b>${r.length} код(ов) уже печатались раньше</b> (например: № ${r[0].number}, ${esc(r[0].article)}, ${esc(r[0].date)}). Если это повторная печать той же партии — всё в порядке.`);
    }
    if (!a.duplicates.length && !a.notFound.length && !state.codes.reused.length) {
      add('ok', 'Все коды уникальны, DataMatrix найден на каждой странице.');
    }
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // ---------------- производные поля ----------------
  function updateDerived() {
    const s = startNum();
    const n = state.codes ? state.codes.analysis.pageCount : 0;
    $('rangeText').textContent = n ? `${s} – ${s + n - 1}` : `${s} – …`;
    const date = Core.formatDate($('packDate').value);
    $('sampleText').textContent = `${Core.safeText(article()) || 'артикул'} ${date} ${s}`;
    const ok = !!(article() && state.template && state.codes && !state.codes.analysis.duplicates.length && $('packDate').value && !state.busy);
    $('btnGenerate').disabled = !ok;
    $('btnGenerate').title = ok ? '' : 'Нужно: артикул, шаблон, дата и файл кодов без дублей';
  }

  function buildOpts(extra) {
    readZonesFromForm();
    const st = readStyle();
    const tpl = state.template ? Object.assign({}, state.template, {
      widthMm: parseFloat($('tplW').value) || state.template.widthMm,
      heightMm: parseFloat($('tplH').value) || state.template.heightMm,
    }) : { kind: 'none', widthMm: parseFloat($('tplW').value) || 75, heightMm: parseFloat($('tplH').value) || 120 };
    return Object.assign({
      template: tpl,
      codesBytes: state.codes ? state.codes.bytes : null,
      analysis: state.codes ? state.codes.analysis : null,
      article: article() || 'artikul',
      dateIso: $('packDate').value,
      start: startNum(),
      labelStyle: { prefixColor: st.prefixColor, numberColor: st.numberColor, numberScale: st.numberScale, align: st.alignLabel, layout: 'one' },
      codeStyle: { prefixColor: st.prefixColor, numberColor: st.numberColor, numberScale: st.numberScale, align: 'center', layout: st.layoutCode },
    }, extra || {});
  }

  // ---------------- предпросмотр ----------------
  let pvTimer = null; let pvSeq = 0;
  function schedulePreview() { clearTimeout(pvTimer); pvTimer = setTimeout(renderPreview, 350); }

  async function renderPreview() {
    const seq = ++pvSeq;
    const o = buildOpts();
    const frames = $('showFrames').checked;
    try {
      const lab = await Core.buildLabels({
        template: o.template, codesBytes: o.codesBytes, analysis: o.analysis,
        zones: { code: state.zones.code, info: state.zones.info },
        article: o.article, dateIso: o.dateIso, start: o.start, style: o.labelStyle, limit: 1, showFrames: frames,
      });
      let code = null;
      if (o.codesBytes) {
        code = await Core.buildCodes({
          codesBytes: o.codesBytes, analysis: o.analysis, zone: state.zones.codeInfo,
          article: o.article, dateIso: o.dateIso, start: o.start, style: o.codeStyle, limit: 1, showFrames: frames,
        });
      }
      if (seq !== pvSeq) return;
      state.previewUrls.forEach((u) => URL.revokeObjectURL(u));
      state.previewUrls = [];
      const show = (iframe, bytes) => {
        if (!bytes) { iframe.removeAttribute('src'); iframe.srcdoc = '<p style="font:14px sans-serif;color:#888;padding:12px">Загрузите файл кодов</p>'; return; }
        const u = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        state.previewUrls.push(u);
        iframe.removeAttribute('srcdoc');
        iframe.src = u + '#toolbar=0&navpanes=0&view=Fit';
      };
      show($('pvLabel'), lab);
      show($('pvCode'), code);
    } catch (e) {
      console.error(e);
    }
  }

  // ---------------- формирование ----------------
  function setProgress(frac) {
    const p = $('progress');
    p.hidden = frac == null;
    p.firstElementChild.style.width = `${Math.round((frac || 0) * 100)}%`;
  }

  function safeFileName(s) { return String(s).replace(/[\\/:*?"<>|]+/g, '_'); }

  async function generate() {
    if (!state.codes || !state.template) return;
    const a = state.codes.analysis;
    if (a.duplicates.length) { alert('В файле есть одинаковые коды — формирование запрещено.'); return; }
    if (state.codes.reused.length && !confirm(`${state.codes.reused.length} код(ов) из этого файла уже печатались раньше.\nЭто повторная печать? Продолжить?`)) return;

    state.busy = true; updateDerived();
    $('results').innerHTML = '';
    setProgress(0);
    const o = buildOpts();
    const n = a.pageCount;
    const end = o.start + n - 1;
    try {
      const labels = await Core.buildLabels({
        template: o.template, codesBytes: o.codesBytes, analysis: a,
        zones: { code: state.zones.code, info: state.zones.info },
        article: o.article, dateIso: o.dateIso, start: o.start, style: o.labelStyle,
        onProgress: (i) => setProgress((i / n) * 0.6),
      });
      const codes = await Core.buildCodes({
        codesBytes: o.codesBytes, analysis: a, zone: state.zones.codeInfo,
        article: o.article, dateIso: o.dateIso, start: o.start, style: o.codeStyle,
        onProgress: (i) => setProgress(0.6 + (i / n) * 0.35),
      });
      const csv = Core.buildJournalCsv(a, { article: o.article, dateIso: o.dateIso, start: o.start });
      setProgress(1);

      const base = safeFileName(`${Core.safeText(o.article)}_${Core.formatDate(o.dateIso)}_${o.start}-${end}`);
      const link = (bytes, type, name, text) => {
        const u = URL.createObjectURL(new Blob([bytes], { type }));
        return `<a href="${u}" download="${esc(name)}">⬇ ${text}</a>`;
      };
      $('results').innerHTML = `<div class="ok">Готово: ${n} этикеток и ${n} кодов, номера ${o.start} – ${end}.</div>`
        + link(labels, 'application/pdf', `${base}_этикетки.pdf`, `Этикетки (${n} стр.)`)
        + link(codes, 'application/pdf', `${base}_коды.pdf`, `Коды для внешней упаковки (${n} стр.)`)
        + link(csv, 'text/csv;charset=utf-8', `${base}_журнал.csv`, 'Журнал: номер ↔ код (CSV)');

      // запоминаем использованные коды и последний номер
      const ts = Date.now();
      await idbPutMany('used', a.pages.map((p, i) => ({ code: p.code, article: o.article, date: Core.formatDate(o.dateIso), number: o.start + i, ts })).filter((r) => r.code));
      const prev = state.profiles.get(o.article);
      await saveProfile({ lastNumber: Math.max(end, prev ? prev.lastNumber || 0 : 0) });
      $('profileStatus').textContent = `сохранён, последний номер: ${end}. Следующая партия начнётся с ${end + 1}`;
    } catch (e) {
      console.error(e);
      $('results').innerHTML = `<div class="err">Ошибка: ${esc(e.message)}</div>`;
    } finally {
      state.busy = false; updateDerived();
      setTimeout(() => setProgress(null), 800);
    }
  }

  // ---------------- резервная копия ----------------
  function bufToB64(buf) {
    const bytes = new Uint8Array(buf); let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function b64ToBuf(b64) {
    const s = atob(b64); const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out.buffer;
  }
  async function exportBackup() {
    const profiles = (await idbGetAll('profiles')).map((p) => Object.assign({}, p, {
      template: p.template ? Object.assign({}, p.template, { bytes: p.template.bytes ? bufToB64(p.template.bytes) : null }) : null,
    }));
    const used = await idbGetAll('used');
    const blob = new Blob([JSON.stringify({ app: 'pdf-editor-labels', version: 1, exported: new Date().toISOString(), profiles, used })], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `этикетки_резервная_копия_${todayIso()}.json`;
    a.click();
  }
  async function importBackup(file) {
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'pdf-editor-labels') throw new Error('это не файл резервной копии');
      const profiles = (data.profiles || []).map((p) => Object.assign({}, p, {
        template: p.template ? Object.assign({}, p.template, { bytes: p.template.bytes ? b64ToBuf(p.template.bytes) : null }) : null,
      }));
      await idbPutMany('profiles', profiles);
      if (data.used && data.used.length) await idbPutMany('used', data.used);
      profiles.forEach((p) => state.profiles.set(p.article, p));
      refreshArticleList();
      alert(`Восстановлено товаров: ${profiles.length}, использованных кодов: ${(data.used || []).length}`);
      onArticleChanged();
    } catch (e) { alert('Не удалось восстановить: ' + e.message); }
  }

  // ---------------- события ----------------
  async function init() {
    writeZonesToForm();
    writeStyle(DEFAULT_STYLE);
    $('packDate').value = todayIso();
    try {
      (await idbGetAll('profiles')).forEach((p) => state.profiles.set(p.article, p));
    } catch (e) { console.warn('IndexedDB недоступна', e); }
    refreshArticleList();

    $('article').addEventListener('change', onArticleChanged);
    $('article').addEventListener('input', () => { if (state.profiles.has(article())) onArticleChanged(); else { updateProfileStatus(); checkArticleChars(); updateDerived(); schedulePreview(); } });
    $('btnSaveProfile').addEventListener('click', async () => { const p = await saveProfile(); if (p) $('profileStatus').textContent = 'сохранён'; });
    $('btnDeleteProfile').addEventListener('click', async () => {
      const a = article();
      if (!state.profiles.has(a)) return;
      if (!confirm(`Удалить товар «${a}» с его шаблоном и настройками?`)) return;
      await idbDel('profiles', a); state.profiles.delete(a); refreshArticleList(); updateProfileStatus();
    });
    $('tplFile').addEventListener('change', (e) => onTemplateFile(e.target.files[0]));
    $('codesFile').addEventListener('change', (e) => onCodesFile(e.target.files[0]));
    ['tplW', 'tplH'].forEach((id) => $(id).addEventListener('input', () => {
      if (state.template && state.template.kind !== 'pdf') { state.template.widthMm = parseFloat($('tplW').value) || 75; state.template.heightMm = parseFloat($('tplH').value) || 120; showTemplateInfo(); }
      schedulePreview();
    }));
    document.querySelectorAll('.zone input, #colPrefix, #colNumber, #numScale, #alignLabel, #layoutCode, #showFrames')
      .forEach((el) => el.addEventListener('input', schedulePreview));
    ['packDate', 'startNum'].forEach((id) => $(id).addEventListener('input', () => { updateDerived(); schedulePreview(); }));
    $('btnResetZones').addEventListener('click', () => { state.zones = JSON.parse(JSON.stringify(DEFAULT_ZONES)); writeZonesToForm(); writeStyle(DEFAULT_STYLE); schedulePreview(); });
    $('btnGenerate').addEventListener('click', generate);
    $('btnExport').addEventListener('click', exportBackup);
    $('fileImport').addEventListener('change', (e) => e.target.files[0] && importBackup(e.target.files[0]));

    showTemplateInfo();
    updateDerived();
    schedulePreview();
  }
  init();
})();
