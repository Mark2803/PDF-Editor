/* Интерфейс. Вся обработка идёт локально в браузере — файлы никуда не отправляются. */
(function () {
  'use strict';
  const Core = window.LabelCore;
  const $ = (id) => document.getElementById(id);

  // Раскладки для этикетки 75×120 мм. Свободное место справа от рисунка: x 39–73 мм, y 2–38 мм.
  const PRESETS = {
    max: { code: { x: 39.5, y: 2, w: 33.5, h: 36.3 }, info: { x: 2, y: 2, w: 15.5, h: 10.5 } },
    mockup: { code: { x: 39.5, y: 9.5, w: 34, h: 28.8 }, info: { x: 30.5, y: 1.5, w: 43, h: 7.5 } },
  };
  const DEFAULT_ZONES = {
    code: Object.assign({}, PRESETS.max.code),
    info: Object.assign({}, PRESETS.max.info),
    codeInfo: { x: 1.5, y: 1.5, w: 32, h: 12 },
  };
  const DEFAULT_STYLE = { prefixColor: '#000000', numberColor: '#000000', numberScale: 1.7, alignLabel: 'left', codeTextPct: 70, zonePreset: 'max', paperW: 20, paperH: 30, paperMargin: 1.5 };
  // старые значения по умолчанию (первая версия) — для автоматического обновления сохранённых товаров
  const OLD_ZONES = { code: { x: 49, y: 13.5, w: 23, h: 23.5 }, info: { x: 33, y: 1.5, w: 39, h: 9 } };

  const state = {
    profiles: new Map(),
    zones: JSON.parse(JSON.stringify(DEFAULT_ZONES)),
    template: null, // {kind, bytes, fileName, widthMm, heightMm}
    codes: null, // {bytes, fileName, analysis, reused:[]}
    checkResults: new Map(), // полный код -> вердикт проверки в ЧЗ
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
      paperW: Math.max(10, parseFloat($('paperW').value) || 20),
      paperH: Math.max(10, parseFloat($('paperH').value) || 30),
      paperMargin: Math.min(5, Math.max(0, parseFloat($('paperMargin').value) || 0)),
      codeTextPct: Math.min(100, Math.max(30, parseFloat($('codeTextPct').value) || 70)),
      zonePreset: $('zonePreset').value,
    };
  }
  function writeStyle(st) {
    const s = Object.assign({}, DEFAULT_STYLE, st || {});
    $('colPrefix').value = s.prefixColor; $('colNumber').value = s.numberColor;
    $('numScale').value = s.numberScale; $('alignLabel').value = s.alignLabel;
    $('paperW').value = s.paperW; $('paperH').value = s.paperH; $('paperMargin').value = s.paperMargin;
    $('codeTextPct').value = s.codeTextPct; $('zonePreset').value = s.zonePreset || 'custom';
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

  /** Обновить товары, сохранённые в первой версии: цветной текст -> чёрный, маленький код -> крупный */
  function migrateProfile(p) {
    const st = Object.assign({}, p.style || {});
    if (st.prefixColor === '#2b3fbf') st.prefixColor = '#000000';
    if (st.numberColor === '#1e9e3e') st.numberColor = '#000000';
    const z = JSON.parse(JSON.stringify(p.zones || {}));
    const same = (a, b) => a && b && ['x', 'y', 'w', 'h'].every((k) => Math.abs(a[k] - b[k]) < 0.01);
    if (same(z.code, OLD_ZONES.code) && same(z.info, OLD_ZONES.info)) { z.code = Object.assign({}, PRESETS.max.code); z.info = Object.assign({}, PRESETS.max.info); st.zonePreset = 'max'; }
    if (!st.zonePreset) st.zonePreset = 'custom';
    if (!st.codeTextPct) st.codeTextPct = 70;
    return Object.assign({}, p, { style: st, zones: z });
  }

  function loadProfile(p) {
    p = migrateProfile(p);
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
    $('tplSizeRow').style.display = isImg ? '' : 'none';
    $('dropTpl').classList.toggle('done', !!t);
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
    $('dropCodes').classList.remove('done');
    updateDerived();
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const analysis = await Core.analyzeCodes(bytes, (i, n) => { info.textContent = `Читаю файл… ${i} / ${n}`; });
      state.codes = { bytes, fileName: file.name, analysis, reused: [] };
      $('dropCodes').classList.add('done');
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
    if (a.mismatch && a.mismatch.length) {
      add('err', `<b>На стр. ${a.mismatch.slice(0, 15).join(', ')} код внутри DataMatrix не совпадает с текстом под ним!</b> Формирование запрещено — проверьте файл в «Честном знаке».`);
    }
    if (a.unreadable && a.unreadable.length && !a.notFound.length) {
      add('warn', `На стр. ${a.unreadable.slice(0, 15).join(', ')}${a.unreadable.length > 15 ? '…' : ''} не удалось прочитать DataMatrix — эти коды нельзя будет проверить в ЧЗ.`);
    }
    if (a.notFound.length) {
      add('warn', `На стр. ${a.notFound.slice(0, 15).join(', ')}${a.notFound.length > 15 ? '…' : ''} не удалось найти DataMatrix автоматически — будет вставлена страница целиком. Проверьте предпросмотр.`);
    }
    if (state.codes.reused.length) {
      const r = state.codes.reused;
      add('warn', `<b>${r.length} код(ов) уже печатались раньше</b> (например: № ${r[0].number}, ${esc(r[0].article)}, ${esc(r[0].date)}). Если это повторная печать той же партии — всё в порядке.`);
    }
    if (!a.duplicates.length && !a.notFound.length && !state.codes.reused.length && !(a.mismatch || []).length && !(a.unreadable || []).length) {
      add('ok', 'Все коды уникальны, каждый DataMatrix прочитан и совпадает с текстом под ним.');
    }
    const chk = checkSummaryFor(a);
    if (chk.checked) {
      add(chk.bad ? 'err' : 'ok', chk.bad
        ? `<b>Проверка в ЧЗ: ${chk.bad} из ${a.pageCount} кодов не годятся</b> (не введены в оборот, выбыли или не найдены). Подробности — на вкладке «Проверка кодов».`
        : `Проверка в ЧЗ: проверено ${chk.checked} из ${a.pageCount}, все в обороте.`);
    }
    $('btnCheckThese').hidden = false;
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // ---------------- производные поля ----------------
  function updateDerived() {
    const s = startNum();
    const n = state.codes ? state.codes.analysis.pageCount : 0;
    $('rangeText').textContent = n ? `${s} – ${s + n - 1}` : `${s} – …`;
    const date = Core.formatDate($('packDate').value);
    $('sampleText').textContent = `${Core.safeText(article()) || 'артикул'} ${date} ${s}`;
    const ok = !!(article() && state.template && state.codes && !state.codes.analysis.duplicates.length && !(state.codes.analysis.mismatch || []).length && $('packDate').value && !state.busy);
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
      labelStyle: { prefixColor: st.prefixColor, numberColor: st.numberColor, numberScale: st.numberScale, align: st.alignLabel, layout: 'auto', codeTextScale: st.codeTextPct / 100 },
      codeStyle: { prefixColor: st.prefixColor, numberColor: st.numberColor, numberScale: st.numberScale, align: 'center', codeTextScale: st.codeTextPct / 100 },
      paper: { w: st.paperW, h: st.paperH, margin: st.paperMargin },
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
          codesBytes: o.codesBytes, analysis: o.analysis, paper: o.paper,
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
    const chk = checkSummaryFor(a);
    if (chk.bad && !confirm(`По результатам проверки в «Честном знаке» ${chk.bad} код(ов) из этого файла НЕ годятся (не в обороте, выбыли или не найдены).\nВсё равно сформировать?`)) return;
    if (!chk.checked && !confirm('Коды этого файла ещё не проверены в «Честном знаке».\nСформировать без проверки?')) return;
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
        codesBytes: o.codesBytes, analysis: a, paper: o.paper,
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

  function checkSummaryFor(a) {
    let checked = 0; let bad = 0;
    a.pages.forEach((p) => {
      const r = p.fullCode ? state.checkResults.get(p.fullCode) : null;
      if (r && r.level !== 'error') { checked++; if (r.level !== 'ok') bad++; }
    });
    return { checked, bad };
  }

  function switchTab(name) {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $('tab-labels').hidden = name !== 'labels';
    $('tab-check').hidden = name !== 'check';
    if (name === 'labels' && state.codes) renderCodeProblems();
  }

  // ---------------- проверка кодов в ЧЗ ----------------
  const CC = window.CodeChecker;
  const LEVEL_RU = { ok: 'Годен', bad: 'НЕ годен', warn: 'Внимание', error: 'Не проверен', wait: 'ждёт' };
  const Check = {
    items: [], results: [], running: false, stop: false, base: null, mode: '', preferred: null,

    async init() {
      $('chkFiles').addEventListener('change', (e) => this.loadFiles([...e.target.files]));
      $('btnPaste').addEventListener('click', () => {
        const list = CC.codesFromText($('chkPaste').value);
        this.addItems(list, 'список'); $('chkPaste').value = '';
      });
      $('btnCheck').addEventListener('click', () => this.run(false));
      $('btnRetry').addEventListener('click', () => this.run(true));
      $('btnStop').addEventListener('click', () => { this.stop = true; });
      $('btnReport').addEventListener('click', () => this.report());
      $('btnClearChk').addEventListener('click', () => { this.items = []; this.results = []; this.render(); });
      $('chkBase').addEventListener('change', () => this.detect());
      await this.detect();
    },

    async detect() {
      const custom = $('chkBase').value.trim();
      const box = $('connBox');
      if (custom) { this.base = custom.replace(/\/+$/, ''); this.mode = 'custom'; box.className = 'muted small'; box.textContent = `Запросы идут через: ${this.base}`; return; }
      if (/^https?:/.test(location.protocol)) {
        try {
          const r = await fetch('crpt/ping', { cache: 'no-store', credentials: 'same-origin' });
          if (r.ok) { this.base = new URL('crpt', location.href).href; this.mode = 'helper'; box.className = 'ok'; box.textContent = 'Подключено к сервису проверки — можно проверять.'; return; }
        } catch (e) { /* нет посредника */ }
      }
      this.base = CC.PUBLIC_BASE; this.mode = 'direct';
      box.className = 'warn';
      box.innerHTML = 'Приложение открыто как файл, поэтому браузер, скорее всего, не пустит запросы к «Честному знаку» напрямую. '
        + 'Для проверки запустите <b>start.bat</b> из папки программы (нужен бесплатный Node.js) — откроется эта же страница, и проверка заработает. '
        + 'Можно попробовать и так — если не получится, появится ошибка связи.';
    },

    async loadFiles(files) {
      for (const f of files) {
        $('chkLoaded').textContent = `Читаю ${f.name}…`;
        try {
          const bytes = new Uint8Array(await f.arrayBuffer());
          const list = await CC.readFile(f.name, bytes, Core, (i, n) => { $('chkLoaded').textContent = `Читаю ${f.name}… ${i} / ${n}`; });
          this.addItems(list, f.name);
        } catch (e) { alert(`${f.name}: ${e.message}`); }
      }
      $('chkFiles').value = '';
    },

    loadItems(list, name) { this.items = []; this.results = []; this.addItems(list, name); },

    addItems(list, name) {
      const seen = new Set(this.items.map((i) => i.code).filter(Boolean));
      let dup = 0;
      list.forEach((it) => {
        if (it.code && seen.has(it.code)) { dup++; return; }
        if (it.code) seen.add(it.code);
        this.items.push(Object.assign({ file: name }, it));
        this.results.push(it.code && state.checkResults.has(it.code) ? state.checkResults.get(it.code) : null);
      });
      $('chkLoaded').textContent = `Загружено кодов: ${this.items.length}${dup ? ` (повторы пропущены: ${dup})` : ''}`;
      if (!list.length) $('chkLoaded').textContent = `В «${name}» не найдено кодов маркировки.`;
      this.render();
    },

    async run(onlyErrors) {
      if (this.running || !this.items.length) return;
      this.running = true;
      $('btnCheck').disabled = true; $('btnReport').hidden = true;
      await this.detect();
      const idx = this.items.map((_, i) => i).filter((i) => !onlyErrors ? true : (!this.results[i] || this.results[i].level === 'error'));
      if (!idx.length) { this.running = false; this.render(); return; }
      this.stop = false;
      idx.forEach((i) => { this.results[i] = { level: 'wait', title: 'в очереди' }; });
      this.render();
      $('chkProgress').hidden = false;
      let done = 0;
      let fatal = null;
      this.preferred = await CC.checkMany(idx.map((i) => this.items[i]), {
        base: this.base, preferred: this.preferred, concurrency: 2,
        pauseMs: Math.max(0, parseInt($('chkPause').value, 10) || 0),
        shouldStop: () => this.stop || !!fatal,
        onFatal: (r) => { fatal = r; },
        onResult: (k, res) => {
          const i = idx[k];
          this.results[i] = res;
          if (this.items[i].code && res.level !== 'error') state.checkResults.set(this.items[i].code, res);
          done++;
          $('chkProgress').firstElementChild.style.width = `${Math.round((done / idx.length) * 100)}%`;
          this.renderRow(i); this.renderSummary();
          if (res.net && done === 1 && this.mode === 'direct') {
            $('connBox').className = 'err';
            $('connBox').innerHTML = 'Браузер не пускает запросы к «Честному знаку» напрямую. Запустите <b>start.bat</b> из папки программы и проверяйте на открывшейся странице.';
            this.stop = true;
          }
        },
      });
      idx.forEach((i) => { if (this.results[i] && this.results[i].level === 'wait') this.results[i] = null; });
      if (fatal) alert(fatal.title + '\nПроверка возможна только с российского интернета (без VPN).');
      this.running = false;
      setTimeout(() => { $('chkProgress').hidden = true; }, 600);
      this.render();
    },

    renderRow(i) {
      const tr = document.getElementById('chk-row-' + i);
      if (!tr) return;
      const it = this.items[i]; const r = this.results[i];
      const lvl = r ? r.level : 'wait';
      const extra = [r && r.status && r.status !== r.title ? r.status : '', r && r.product, r && r.details, (it.notes || []).join(', ')].filter(Boolean).join(' · ');
      tr.innerHTML = `<td>${i + 1}</td><td>${esc(it.file || '')}<br><span class="muted">${esc(it.source || '')}</span></td>`
        + `<td class="code">${esc(CC.display(it.code || it.cis || ''))}</td>`
        + `<td><span class="lvl ${lvl}">${LEVEL_RU[lvl]}</span><br>${esc(r ? r.title : (it.code ? 'не проверен' : 'код не прочитан'))}</td>`
        + `<td class="small">${esc(extra)}</td>`;
    },

    renderSummary() {
      const c = { ok: 0, bad: 0, warn: 0, error: 0, none: 0 };
      this.results.forEach((r) => { if (!r || r.level === 'wait') c.none++; else c[r.level]++; });
      const parts = [];
      if (c.ok) parts.push(`<span class="lvl ok">В обороте: ${c.ok}</span>`);
      if (c.bad) parts.push(`<span class="lvl bad">НЕ годны: ${c.bad}</span>`);
      if (c.warn) parts.push(`<span class="lvl warn">Требуют внимания: ${c.warn}</span>`);
      if (c.error) parts.push(`<span class="lvl error">Ошибка связи: ${c.error}</span>`);
      if (c.none) parts.push(`<span class="lvl wait">Не проверено: ${c.none}</span>`);
      let verdict = '';
      if (this.items.length && !c.none && !c.error && !this.running) {
        verdict = c.bad || c.warn ? '<div class="err"><b>Есть коды, которые нельзя отправлять.</b> Отфильтруйте их по столбцу «Результат» или скачайте отчёт.</div>'
          : '<div class="ok"><b>Все коды введены в оборот — можно отправлять.</b></div>';
      }
      $('chkSummary').innerHTML = `<div class="sum">${parts.join('')}</div>${verdict}`;
    },

    render() {
      const tb = $('chkTable');
      // показываем сначала проблемные
      const order = this.items.map((_, i) => i);
      const rank = { bad: 0, warn: 1, error: 2, wait: 3, ok: 4 };
      if (!this.running) order.sort((a, b) => (rank[(this.results[a] || { level: 'wait' }).level] - rank[(this.results[b] || { level: 'wait' }).level]) || a - b);
      tb.innerHTML = order.map((i) => `<tr id="chk-row-${i}"></tr>`).join('');
      order.forEach((i) => this.renderRow(i));
      this.renderSummary();
      const has = this.items.length > 0;
      $('btnCheck').disabled = !has || this.running;
      $('btnStop').hidden = !this.running;
      $('btnReport').hidden = !has || this.running;
      $('btnClearChk').hidden = !has || this.running;
      $('btnRetry').hidden = this.running || !this.results.some((r) => r && r.level === 'error');
    },

    report() {
      const rows = [['№', 'Файл', 'Откуда', 'Код маркировки', 'Результат', 'Статус ЧЗ', 'Пояснение', 'Товар', 'Подробности', 'Ответ сервера']];
      this.items.forEach((it, i) => {
        const r = this.results[i] || {};
        rows.push([String(i + 1), it.file || '', it.source || '', CC.display(it.code || it.cis || ''), LEVEL_RU[r.level || 'wait'], r.status || '', r.title || '', r.product || '', r.details || '', (r.raw || '').replace(/\s+/g, ' ')]);
      });
      const escv = (v) => (/[;"\n]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : v);
      const csv = '\uFEFF' + rows.map((r) => r.map(escv).join(';')).join('\r\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      a.download = `проверка_кодов_${todayIso()}.csv`;
      a.click();
    },
  };

  // ---------------- события ----------------
  // ---------------- вход через «Менеджмент» (только когда страница открыта с сайта) ----------------
  async function checkAccess() {
    if (!/^https?:/.test(location.protocol)) return true; // открыто как файл — вход не нужен
    let me;
    try {
      const m = location.hash.match(/(?:^#|&)t=([^&]+)/);
      if (m) {
        history.replaceState(null, '', location.pathname + location.search);
        const r = await fetch('api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: decodeURIComponent(m[1]) }), credentials: 'same-origin' });
        if (!r.ok) {
          let msg = 'Не удалось войти.';
          try { msg = (await r.json()).error.message; } catch (e) { /* нет текста */ }
          showLock(msg); return false;
        }
      }
      const r = await fetch('api/me', { cache: 'no-store', credentials: 'same-origin' });
      if (!r.ok) return true; // старый посредник без входа
      me = await r.json();
    } catch (e) { return true; }
    if (me.authRequired && !me.authenticated) { showLock(); return false; }
    return true;
  }
  function showLock(message) {
    document.querySelectorAll('main, .tabs, .hdr-actions').forEach((el) => { el.hidden = true; });
    const box = document.createElement('div');
    box.className = 'card lock';
    box.innerHTML = `<h2>Доступ закрыт</h2><p>${esc(message || 'Откройте инструмент через админку сайта: «Менеджмент» → PIN → карточка «Этикетки и Честный знак».')}</p>`
      + '<p><a class="btn" href="/admin/management">Открыть «Менеджмент»</a></p>';
    document.body.appendChild(box);
  }

  async function init() {
    if (!(await checkAccess())) return;
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
    document.querySelectorAll('.drop').forEach((d) => {
      ['dragenter', 'dragover'].forEach((ev) => d.addEventListener(ev, () => d.classList.add('over')));
      ['dragleave', 'drop'].forEach((ev) => d.addEventListener(ev, () => d.classList.remove('over')));
    });
    // файлы, брошенные мимо полей, браузер не должен открывать вместо страницы
    ['dragover', 'drop'].forEach((ev) => window.addEventListener(ev, (e) => { if (!e.target.closest || !e.target.closest('.drop')) e.preventDefault(); }));
    $('codesFile').addEventListener('change', (e) => onCodesFile(e.target.files[0]));
    ['tplW', 'tplH'].forEach((id) => $(id).addEventListener('input', () => {
      if (state.template && state.template.kind !== 'pdf') { state.template.widthMm = parseFloat($('tplW').value) || 75; state.template.heightMm = parseFloat($('tplH').value) || 120; showTemplateInfo(); }
      schedulePreview();
    }));
    document.querySelectorAll('.zone input, #colPrefix, #colNumber, #numScale, #alignLabel, #showFrames, #codeTextPct, #paperW, #paperH, #paperMargin')
      .forEach((el) => el.addEventListener('input', schedulePreview));
    document.querySelectorAll('.zone input').forEach((el) => el.addEventListener('input', () => { $('zonePreset').value = 'custom'; }));
    $('zonePreset').addEventListener('change', () => {
      const pr = PRESETS[$('zonePreset').value];
      if (pr) { state.zones.code = Object.assign({}, pr.code); state.zones.info = Object.assign({}, pr.info); writeZonesToForm(); }
      schedulePreview();
    });
    $('btnCheckThese').addEventListener('click', () => {
      if (!state.codes) return;
      switchTab('check');
      Check.loadItems(state.codes.analysis.pages.map((p, i) => ({ code: p.fullCode, cis: p.code, source: `стр. ${i + 1}`, notes: p.fullCode ? [] : [p.dmError || 'не прочитан'] })), state.codes.fileName);
    });
    document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    Check.init();
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
