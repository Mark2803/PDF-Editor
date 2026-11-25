/*
 * Ядро «Этикетки + Честный знак».
 * Работает и в браузере (window.LabelCore), и в Node (module.exports) — для тестов.
 * Зависимость: pdf-lib (глобальный PDFLib в браузере или require в Node).
 *
 * Главный принцип: страница i файла кодов -> этикетка i -> номер (start + i).
 * Порядок никогда не меняется, страницы не пропускаются и не дублируются.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = (PDFLib, DMlib) => factory(PDFLib, DMlib || require('./datamatrix.js'));
  } else root.LabelCore = factory(root.PDFLib, root.DataMatrix);
})(typeof self !== 'undefined' ? self : this, function (PDFLib, DM) {
  'use strict';

  const MM = 72 / 25.4; // 1 мм в пунктах PDF
  const {
    PDFDocument, StandardFonts, rgb, PDFName, PDFDict, PDFArray,
    PDFRawStream, PDFNumber, decodePDFRawStream,
  } = PDFLib;

  // ---------- низкоуровневый разбор content stream ----------

  function streamBytes(obj) {
    if (obj instanceof PDFRawStream) return decodePDFRawStream(obj).decode();
    if (obj && typeof obj.getContents === 'function') return obj.getContents();
    return new Uint8Array(0);
  }

  function bytesToLatin1(bytes) {
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return s;
  }

  function pageContentString(doc, page) {
    const contents = page.node.Contents();
    if (!contents) return '';
    const parts = [];
    if (contents instanceof PDFArray) {
      for (let i = 0; i < contents.size(); i++) parts.push(bytesToLatin1(streamBytes(contents.lookup(i))));
    } else {
      parts.push(bytesToLatin1(streamBytes(contents)));
    }
    return parts.join('\n');
  }

  const WS = ' \t\r\n\f\0';
  const DELIM = '()<>[]{}/%';

  // Токенизатор: возвращает массив {t:'num'|'name'|'str'|'hex'|'op'|'[' |']'|'<<'|'>>', v}
  function tokenize(s) {
    const out = [];
    let i = 0;
    const n = s.length;
    while (i < n) {
      const c = s[i];
      if (WS.includes(c)) { i++; continue; }
      if (c === '%') { while (i < n && s[i] !== '\n' && s[i] !== '\r') i++; continue; }
      if (c === '(') {
        let depth = 1; i++;
        const bytes = [];
        while (i < n && depth > 0) {
          const ch = s[i];
          if (ch === '\\') {
            const nx = s[i + 1];
            if (nx === undefined) { i++; break; }
            const map = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
            if (nx in map) { bytes.push(map[nx]); i += 2; }
            else if (nx >= '0' && nx <= '7') {
              let o = ''; let k = i + 1;
              while (k < n && o.length < 3 && s[k] >= '0' && s[k] <= '7') o += s[k++];
              bytes.push(parseInt(o, 8) & 0xff); i = k;
            } else if (nx === '\r') { i += (s[i + 2] === '\n') ? 3 : 2; }
            else if (nx === '\n') { i += 2; }
            else { bytes.push(nx.charCodeAt(0)); i += 2; }
            continue;
          }
          if (ch === '(') depth++;
          if (ch === ')') { depth--; if (depth === 0) { i++; break; } }
          bytes.push(ch.charCodeAt(0) & 0xff); i++;
        }
        out.push({ t: 'str', v: bytes });
        continue;
      }
      if (c === '<') {
        if (s[i + 1] === '<') { out.push({ t: '<<' }); i += 2; continue; }
        let j = s.indexOf('>', i);
        if (j < 0) j = n;
        let hex = s.slice(i + 1, j).replace(/[^0-9a-fA-F]/g, '');
        if (hex.length % 2) hex += '0';
        const bytes = [];
        for (let k = 0; k < hex.length; k += 2) bytes.push(parseInt(hex.substr(k, 2), 16));
        out.push({ t: 'str', v: bytes });
        i = j + 1;
        continue;
      }
      if (c === '>') { if (s[i + 1] === '>') { out.push({ t: '>>' }); i += 2; } else i++; continue; }
      if (c === '[' || c === ']') { out.push({ t: c }); i++; continue; }
      if (c === '{' || c === '}') { i++; continue; }
      if (c === '/') {
        let j = i + 1;
        while (j < n && !WS.includes(s[j]) && !DELIM.includes(s[j])) j++;
        out.push({ t: 'name', v: s.slice(i + 1, j) });
        i = j; continue;
      }
      let j = i;
      while (j < n && !WS.includes(s[j]) && !DELIM.includes(s[j])) j++;
      if (j === i) { i++; continue; }
      const word = s.slice(i, j);
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) out.push({ t: 'num', v: parseFloat(word) });
      else out.push({ t: 'op', v: word });
      i = j;
    }
    return out;
  }

  function mul(m1, m2) {
    return [
      m1[0] * m2[0] + m1[1] * m2[2], m1[0] * m2[1] + m1[1] * m2[3],
      m1[2] * m2[0] + m1[3] * m2[2], m1[2] * m2[1] + m1[3] * m2[3],
      m1[4] * m2[0] + m1[5] * m2[2] + m2[4], m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
    ];
  }
  function applyM(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }

  function parseToUnicode(cmapStr) {
    const map = new Map();
    const hexToStr = (h) => {
      let r = '';
      for (let k = 0; k + 4 <= h.length; k += 4) r += String.fromCharCode(parseInt(h.substr(k, 4), 16));
      if (h.length === 2) r = String.fromCharCode(parseInt(h, 16));
      return r;
    };
    const charRe = /beginbfchar([\s\S]*?)endbfchar/g;
    let m;
    while ((m = charRe.exec(cmapStr))) {
      const pr = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
      let p;
      while ((p = pr.exec(m[1]))) map.set(parseInt(p[1], 16), hexToStr(p[2]));
    }
    const rangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
    while ((m = rangeRe.exec(cmapStr))) {
      const pr = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]+)>|\[([^\]]*)\])/g;
      let p;
      while ((p = pr.exec(m[1]))) {
        const a = parseInt(p[1], 16); const b = parseInt(p[2], 16);
        if (p[4] !== undefined) {
          const base = p[4];
          const lastCode = parseInt(base.slice(-4), 16);
          const prefix = hexToStr(base.slice(0, -4));
          for (let k = a; k <= b && k - a < 65536; k++) map.set(k, prefix + String.fromCharCode(lastCode + (k - a)));
        } else {
          const arr = (p[5].match(/<([0-9a-fA-F]+)>/g) || []).map((x) => x.slice(1, -1));
          arr.forEach((h, idx) => map.set(a + idx, hexToStr(h)));
        }
      }
    }
    return map;
  }

  function fontInfo(doc, fontDict) {
    const sub = fontDict.lookup(PDFName.of('Subtype'));
    const twoByte = sub && sub.toString() === '/Type0';
    let cmap = null;
    const tu = fontDict.lookup(PDFName.of('ToUnicode'));
    if (tu) { try { cmap = parseToUnicode(bytesToLatin1(streamBytes(tu))); } catch (e) { cmap = null; } }
    return { twoByte, cmap };
  }

  function decodeTextBytes(font, bytes) {
    let s = '';
    if (!font) { return String.fromCharCode.apply(null, bytes); }
    const step = font.twoByte ? 2 : 1;
    for (let k = 0; k + step <= bytes.length; k += step) {
      const code = step === 2 ? (bytes[k] << 8) | bytes[k + 1] : bytes[k];
      if (font.cmap && font.cmap.has(code)) s += font.cmap.get(code);
      else if (step === 1) s += String.fromCharCode(code);
      else s += '�';
    }
    return s;
  }

  /**
   * Мини-интерпретатор страницы: находит XObject-ы (DataMatrix) и текстовые строки.
   */
  function scanPage(doc, page) {
    const res = page.node.Resources();
    const fontsDict = res ? res.lookup(PDFName.of('Font')) : null;
    const xobjDict = res ? res.lookup(PDFName.of('XObject')) : null;
    const fontCache = {};
    const getFont = (name) => {
      if (name in fontCache) return fontCache[name];
      let f = null;
      if (fontsDict instanceof PDFDict) {
        const fd = fontsDict.lookup(PDFName.of(name));
        if (fd instanceof PDFDict) f = fontInfo(doc, fd);
      }
      fontCache[name] = f;
      return f;
    };

    const toks = tokenize(pageContentString(doc, page));
    const stack = [];
    const gs = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    let tm = [1, 0, 0, 1, 0, 0];
    let tlm = [1, 0, 0, 1, 0, 0];
    let font = null; let fontSize = 0; let leading = 0;
    const texts = []; const objects = [];

    const nums = (k) => stack.slice(-k).map((t) => t.v);
    const showText = (bytes) => {
      const str = decodeTextBytes(font, bytes);
      const m = mul(tm, ctm);
      const scale = Math.sqrt(m[2] * m[2] + m[3] * m[3]) || 1;
      texts.push({ x: m[4], y: m[5], size: fontSize * scale, text: str });
    };

    for (let ti = 0; ti < toks.length; ti++) {
      const t = toks[ti];
      if (t.t !== 'op') { stack.push(t); continue; }
      const op = t.v;
      try {
        switch (op) {
          case 'q': gs.push(ctm.slice()); break;
          case 'Q': ctm = gs.pop() || [1, 0, 0, 1, 0, 0]; break;
          case 'cm': ctm = mul(nums(6), ctm); break;
          case 'BT': tm = [1, 0, 0, 1, 0, 0]; tlm = tm.slice(); break;
          case 'Tm': tm = nums(6); tlm = tm.slice(); break;
          case 'Td': { const [tx, ty] = nums(2); tlm = mul([1, 0, 0, 1, tx, ty], tlm); tm = tlm.slice(); break; }
          case 'TD': { const [tx, ty] = nums(2); leading = -ty; tlm = mul([1, 0, 0, 1, tx, ty], tlm); tm = tlm.slice(); break; }
          case 'TL': leading = nums(1)[0]; break;
          case 'T*': tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm.slice(); break;
          case 'Tf': {
            const nm = stack[stack.length - 2];
            font = nm && nm.t === 'name' ? getFont(nm.v) : null;
            fontSize = stack[stack.length - 1].v;
            break;
          }
          case 'Tj': { const s = stack[stack.length - 1]; if (s && s.t === 'str') showText(s.v); break; }
          case "'": { tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm.slice(); const s = stack[stack.length - 1]; if (s && s.t === 'str') showText(s.v); break; }
          case '"': { tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm.slice(); const s = stack[stack.length - 1]; if (s && s.t === 'str') showText(s.v); break; }
          case 'TJ': {
            let k = stack.length - 1;
            while (k >= 0 && stack[k].t !== '[') k--;
            const bytes = [];
            for (let j = k + 1; j < stack.length; j++) if (stack[j].t === 'str') bytes.push(...stack[j].v);
            showText(bytes);
            break;
          }
          case 'Do': {
            const nm = stack[stack.length - 1];
            if (nm && nm.t === 'name' && xobjDict instanceof PDFDict) {
              const xo = xobjDict.lookup(PDFName.of(nm.v));
              if (xo && xo.dict) {
                const subtype = String(xo.dict.lookup(PDFName.of('Subtype')));
                let bbox = [0, 0, 1, 1]; let fm = [1, 0, 0, 1, 0, 0];
                if (subtype === '/Form') {
                  const bb = xo.dict.lookup(PDFName.of('BBox'));
                  if (bb instanceof PDFArray) bbox = bb.asArray().map((x) => x.asNumber());
                  const mt = xo.dict.lookup(PDFName.of('Matrix'));
                  if (mt instanceof PDFArray) fm = mt.asArray().map((x) => x.asNumber());
                }
                const m = mul(fm, ctm);
                const pts = [applyM(m, bbox[0], bbox[1]), applyM(m, bbox[2], bbox[1]), applyM(m, bbox[0], bbox[3]), applyM(m, bbox[2], bbox[3])];
                const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
                objects.push({ name: nm.v, subtype, x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), raw: xo });
              }
            }
            break;
          }
          default: break;
        }
      } catch (e) { /* пропускаем сбойный оператор */ }
      stack.length = 0;
    }
    return { texts, objects };
  }

  /** Закрашенные прямоугольники внутри Form XObject (модули DataMatrix), в системе координат формы. */
  function formFilledRects(xo) {
    const toks = tokenize(bytesToLatin1(streamBytes(xo)));
    const rects = []; const stack = [];
    let path = []; let cur = null; let pts = [];
    const flushSub = () => { if (pts.length) path.push(pts); pts = []; };
    for (const t of toks) {
      if (t.t !== 'op') { stack.push(t); continue; }
      const n = stack.map((s) => s.v);
      switch (t.v) {
        case 'm': flushSub(); cur = [n[n.length - 2], n[n.length - 1]]; pts = [cur]; break;
        case 'l': cur = [n[n.length - 2], n[n.length - 1]]; pts.push(cur); break;
        case 'h': break;
        case 're': {
          flushSub();
          const [x, y, w, h] = n.slice(-4);
          path.push([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);
          break;
        }
        case 'f': case 'F': case 'f*': case 'B': case 'B*': case 'b': case 'b*':
          flushSub();
          for (const p of path) {
            const xs = p.map((q) => q[0]); const ys = p.map((q) => q[1]);
            rects.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) });
          }
          path = []; break;
        case 'n': case 'S': case 's': flushSub(); path = []; break;
        default: break;
      }
      stack.length = 0;
    }
    return rects;
  }

  /** Прочитать полный код из векторного DataMatrix. Возвращает строку с GS или '' */
  function readDataMatrix(dmObj) {
    if (!DM || !dmObj || !dmObj.raw || dmObj.subtype !== '/Form') return { code: '', error: 'не векторный DataMatrix' };
    try {
      const rects = formFilledRects(dmObj.raw).filter((r) => r.x1 - r.x0 > 1e-3 && r.y1 - r.y0 > 1e-3);
      const bits = DM.matrixFromRects(rects);
      const res = DM.decodeMatrix(bits);
      if (!res.rsOk) return { code: '', error: 'контрольная сумма DataMatrix не сошлась' };
      return { code: res.text, error: '' };
    } catch (e) {
      return { code: '', error: e.message };
    }
  }

  /**
   * Разбор одной страницы файла кодов: где DataMatrix, где текст, какой код.
   * Возвращает crop (в пунктах, система координат PDF) и текст кода.
   */
  function analyzeCodePage(doc, page) {
    const { width: W, height: H } = page.getSize();
    let scan;
    try { scan = scanPage(doc, page); } catch (e) { scan = { texts: [], objects: [] }; }
    const texts = scan.texts.filter((t) => t.text.replace(/[\s�]/g, '').length > 0);

    // DataMatrix — самый крупный примерно квадратный объект
    let dm = null;
    for (const o of scan.objects) {
      const w = o.x1 - o.x0; const h = o.y1 - o.y0;
      if (w < 20 || h < 20) continue;
      const ratio = w / h;
      if (ratio < 0.8 || ratio > 1.25) continue;
      if (!dm || w * h > (dm.x1 - dm.x0) * (dm.y1 - dm.y0)) dm = o;
    }

    // Текст под кодом
    let below = [];
    if (dm) below = texts.filter((t) => t.y < dm.y0 && t.y > dm.y0 - 40);
    below.sort((a, b) => (b.y - a.y) || (a.x - b.x));
    const code = (below.length ? below : texts.slice().sort((a, b) => (b.y - a.y) || (a.x - b.x)))
      .map((t) => t.text.trim()).join('');

    const inset = 1.5; // не захватываем рамку страницы
    const clamp = (b) => ({
      left: Math.max(inset, b.left), right: Math.min(W - inset, b.right),
      bottom: Math.max(inset, b.bottom), top: Math.min(H - inset, b.top),
    });
    let crop; let dmCrop = null; let textCrop = null;
    if (dm) {
      const pad = 3;
      let bottom = dm.y0 - pad;
      let left = dm.x0 - pad; let right = dm.x1 + pad;
      if (below.length) {
        const minY = Math.min(...below.map((t) => t.y - t.size * 0.3));
        bottom = minY - 1.5;
        const minX = Math.min(...below.map((t) => t.x));
        left = Math.min(left, minX - 1.5);
        const maxH = Math.max(...below.map((t) => t.size));
        textCrop = clamp({ left: Math.min(dm.x0, minX) - 4, right: dm.x1 + 4, bottom: minY - 0.8, top: Math.max(...below.map((t) => t.y)) + maxH * 0.85 });
      }
      crop = clamp({ left, right, bottom, top: dm.y1 + pad });
      dmCrop = clamp({ left: dm.x0 - 0.3, right: dm.x1 + 0.3, bottom: dm.y0 - 0.3, top: dm.y1 + 0.3 });
    } else {
      crop = { left: inset, bottom: inset, right: W - inset, top: H - inset };
    }
    const dmRead = dm ? readDataMatrix(dm) : { code: '', error: 'DataMatrix не найден' };
    // Сверка: полный код из DataMatrix должен начинаться с текста под ним (без GS)
    let match = null;
    if (dmRead.code && code) match = dmRead.code.replace(/\u001d/g, '').startsWith(code);
    return { width: W, height: H, crop, dmCrop, textCrop, code, fullCode: dmRead.code, dmError: dmRead.error, match, found: !!dm };
  }

  /**
   * Анализ всего файла кодов.
   */
  async function analyzeCodes(bytes, onProgress) {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const pages = doc.getPages();
    const result = [];
    for (let i = 0; i < pages.length; i++) {
      result.push(analyzeCodePage(doc, pages[i]));
      if (onProgress && i % 25 === 0) { onProgress(i, pages.length); await new Promise((r) => setTimeout(r, 0)); }
    }
    // Дубликаты внутри файла
    const seen = new Map(); const duplicates = [];
    result.forEach((p, i) => {
      if (!p.code) return;
      if (seen.has(p.code)) duplicates.push({ code: p.code, pages: [seen.get(p.code) + 1, i + 1] });
      else seen.set(p.code, i);
    });
    const notFound = result.map((p, i) => (p.found ? null : i + 1)).filter(Boolean);
    const noText = result.map((p, i) => (p.code ? null : i + 1)).filter(Boolean);
    const unreadable = result.map((p, i) => (p.fullCode ? null : i + 1)).filter(Boolean);
    const mismatch = result.map((p, i) => (p.match === false ? i + 1 : null)).filter(Boolean);
    return { pageCount: pages.length, pages: result, duplicates, notFound, noText, unreadable, mismatch };
  }

  // ---------- оформление номера ----------

  function hexToRgb(hex) {
    const h = String(hex || '#000000').replace('#', '');
    const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0');
    return rgb(parseInt(v.slice(0, 2), 16) / 255, parseInt(v.slice(2, 4), 16) / 255, parseInt(v.slice(4, 6), 16) / 255);
  }

  /** Только символы, которые есть в стандартном шрифте (латиница, цифры, знаки). */
  const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
  function safeText(s) {
    return String(s || '').split('').map((ch) => {
      const lo = ch.toLowerCase();
      if (lo in TRANSLIT) { const r = TRANSLIT[lo]; return ch === lo ? r : r.toUpperCase(); }
      const c = ch.charCodeAt(0);
      return c >= 32 && c < 127 ? ch : '';
    }).join('');
  }

  /**
   * Рассчитать раскладку «артикул дата НОМЕР» для зоны (в пунктах).
   * Размер шрифта считается по самому широкому номеру партии, чтобы все этикетки были одинаковыми.
   */
  function planInfoLayout(fonts, prefix, maxNumberStr, zone, style) {
    const k = style.numberScale || 1.7;
    const pad = Math.min(zone.w, zone.h) * 0.08;
    const zw = zone.w - 2 * pad; const zh = zone.h - 2 * pad;
    const capR = 0.72; // высота прописных Helvetica
    const wP = fonts.prefix.widthOfTextAtSize(prefix + ' ', 1);
    const wN = fonts.number.widthOfTextAtSize(maxNumberStr, 1);
    const maxS = style.maxFontSize || 40;

    // один ряд
    const s1 = Math.min(zw / (wP + wN * k), zh / (k * capR * 1.05), maxS);
    // два ряда: сверху артикул+дата, снизу крупный номер
    const wP2 = fonts.prefix.widthOfTextAtSize(prefix, 1);
    const s2 = Math.min(zw / wP2, (zh * 0.36) / capR, maxS);
    const n2 = Math.min(zw / wN, (zh * 0.5) / capR, maxS * k);

    let layout = style.layout || 'auto';
    if (layout === 'auto') layout = (n2 > s1 * k * 1.15) ? 'two' : 'one';
    if (layout === 'one') return { layout, pad, prefixSize: s1, numberSize: s1 * k };
    return { layout, pad, prefixSize: s2, numberSize: n2 };
  }

  function drawInfo(page, fonts, plan, zone, prefix, numberStr, style) {
    const cPrefix = hexToRgb(style.prefixColor || '#000000');
    const cNum = hexToRgb(style.numberColor || '#000000');
    const capR = 0.72;
    const align = style.align || 'left';
    if (plan.layout === 'one') {
      const p = prefix + ' ';
      const wP = fonts.prefix.widthOfTextAtSize(p, plan.prefixSize);
      const wN = fonts.number.widthOfTextAtSize(numberStr, plan.numberSize);
      const total = wP + wN;
      let x = zone.x + plan.pad;
      if (align === 'center') x = zone.x + (zone.w - total) / 2;
      if (align === 'right') x = zone.x + zone.w - plan.pad - total;
      const base = zone.y + (zone.h - plan.numberSize * capR) / 2;
      page.drawText(p, { x, y: base, size: plan.prefixSize, font: fonts.prefix, color: cPrefix });
      page.drawText(numberStr, { x: x + wP, y: base, size: plan.numberSize, font: fonts.number, color: cNum });
    } else {
      const wP = fonts.prefix.widthOfTextAtSize(prefix, plan.prefixSize);
      const wN = fonts.number.widthOfTextAtSize(numberStr, plan.numberSize);
      const capP = plan.prefixSize * capR; const capN = plan.numberSize * capR;
      const gap = Math.max(1, (zone.h - 2 * plan.pad - capP - capN) / 2);
      const top = zone.y + zone.h - plan.pad;
      const pos = (w) => (align === 'left' ? zone.x + plan.pad : align === 'right' ? zone.x + zone.w - plan.pad - w : zone.x + (zone.w - w) / 2);
      page.drawText(prefix, { x: pos(wP), y: top - capP, size: plan.prefixSize, font: fonts.prefix, color: cPrefix });
      page.drawText(numberStr, { x: pos(wN), y: top - capP - gap - capN, size: plan.numberSize, font: fonts.number, color: cNum });
    }
  }


  /**
   * Нарисовать код в зоне: квадрат как можно крупнее, под ним текст кода.
   * style.codeTextScale — размер текста относительно «родного» (1 = как в файле ЧЗ), по умолчанию 0.7.
   */
  function drawCodeBlock(page, e, zone, style) {
    if (e.whole) {
      const s = Math.min(zone.w / e.whole.width, zone.h / e.whole.height);
      const w = e.whole.width * s; const h = e.whole.height * s;
      page.drawPage(e.whole, { x: zone.x + (zone.w - w) / 2, y: zone.y + zone.h - h, xScale: s, yScale: s });
      return;
    }
    const r = style.codeTextScale || 0.7;
    const gap = 0.6;
    const dw = e.dm.width; const dh = e.dm.height;
    const tw = e.text ? e.text.width : 0; const th = e.text ? e.text.height : 0;
    let s = Math.min(zone.w / dw, (zone.h - (e.text ? gap : 0)) / (dh + th * r));
    if (e.text) s = Math.min(s, zone.w / (tw * r));
    const ts = s * r;
    const w = dw * s; const h = dh * s;
    const blockH = h + (e.text ? gap + th * ts : 0);
    const top = zone.y + zone.h;
    const align = style.codeAlign || 'center';
    const xFor = (width) => (align === 'right' ? zone.x + zone.w - width : align === 'left' ? zone.x : zone.x + (zone.w - width) / 2);
    const dmX = xFor(w);
    page.drawPage(e.dm, { x: dmX, y: top - h, xScale: s, yScale: s });
    if (e.text) {
      // текст центрируем под квадратом
      const tx = dmX + (w - tw * ts) / 2;
      page.drawPage(e.text, { x: tx, y: top - blockH, xScale: ts, yScale: ts });
    }
  }

  /** зона в мм от левого верхнего угла -> прямоугольник PDF (пункты, от левого нижнего) */
  function zoneToPt(z, pageH) {
    return { x: z.x * MM, y: pageH - (z.y + z.h) * MM, w: z.w * MM, h: z.h * MM };
  }

  function formatDate(iso) { // 2026-11-25 -> 251126
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    return m ? m[3] + m[2] + m[1].slice(2) : String(iso || '');
  }

  async function loadFonts(doc) {
    return {
      prefix: await doc.embedFont(StandardFonts.Helvetica),
      number: await doc.embedFont(StandardFonts.HelveticaBold),
    };
  }

  function drawZoneFrames(page, zones, H) {
    for (const [z, color] of [[zones.code, rgb(0.9, 0.1, 0.1)], [zones.info, rgb(0.2, 0.25, 0.8)]]) {
      if (!z) continue;
      const r = zoneToPt(z, H);
      page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, borderColor: color, borderWidth: 0.6, opacity: 0, borderOpacity: 0.9 });
    }
  }

  /**
   * Собрать этикетки.
   * opts: {
   *   template: { kind:'pdf'|'png'|'jpg', bytes, widthMm?, heightMm? },
   *   codesBytes, analysis (из analyzeCodes) | null (тогда — заглушка для предпросмотра),
   *   zones: { code:{x,y,w,h}, info:{x,y,w,h} } в мм,
   *   article, dateIso, start, style, limit?, showFrames?, onProgress?
   * }
   */
  async function buildLabels(opts) {
    const out = await PDFDocument.create();
    let tplPage = null; let tplImg = null; let W; let H;
    const t = opts.template;
    if (t && t.kind === 'pdf') {
      [tplPage] = await out.embedPdf(t.bytes, [0]);
      W = tplPage.width; H = tplPage.height;
    } else {
      W = (t && t.widthMm ? t.widthMm : 75) * MM;
      H = (t && t.heightMm ? t.heightMm : 120) * MM;
      if (t && t.kind === 'png') tplImg = await out.embedPng(t.bytes);
      if (t && t.kind === 'jpg') tplImg = await out.embedJpg(t.bytes);
    }
    const fonts = await loadFonts(out);
    const prefix = safeText(`${opts.article} ${formatDate(opts.dateIso)}`.trim());
    const start = Number(opts.start) || 1;

    let total; let embedded = [];
    if (opts.analysis && opts.codesBytes) {
      const src = await PDFDocument.load(opts.codesBytes, { ignoreEncryption: true, updateMetadata: false });
      const srcPages = src.getPages();
      total = Math.min(srcPages.length, opts.limit || Infinity);
      if (srcPages.length !== opts.analysis.pageCount) throw new Error('Файл кодов изменился после проверки — загрузите его заново.');
      // Квадрат DataMatrix и текст под ним встраиваем раздельно, чтобы квадрат был максимально крупным
      const pgs = []; const boxes = []; const map = [];
      for (let i = 0; i < total; i++) {
        const pa = opts.analysis.pages[i];
        if (pa.dmCrop) {
          map.push({ dm: pgs.length, text: pa.textCrop ? pgs.length + 1 : -1 });
          pgs.push(srcPages[i]); boxes.push(pa.dmCrop);
          if (pa.textCrop) { pgs.push(srcPages[i]); boxes.push(pa.textCrop); }
        } else {
          map.push({ whole: pgs.length });
          pgs.push(srcPages[i]); boxes.push(pa.crop);
        }
      }
      const emb = await out.embedPages(pgs, boxes);
      embedded = map.map((m) => (m.whole !== undefined ? { whole: emb[m.whole] } : { dm: emb[m.dm], text: m.text >= 0 ? emb[m.text] : null }));
    } else {
      total = opts.limit || 1;
    }
    const maxNumberStr = String(start + Math.max(total, opts.analysis ? opts.analysis.pageCount : total) - 1).replace(/\d/g, '8');
    const infoZone = zoneToPt(opts.zones.info, H);
    const plan = planInfoLayout(fonts, prefix, maxNumberStr, infoZone, Object.assign({ layout: 'one' }, opts.style || {}));
    const codeZone = zoneToPt(opts.zones.code, H);

    for (let i = 0; i < total; i++) {
      const page = out.addPage([W, H]);
      if (tplPage) page.drawPage(tplPage, { x: 0, y: 0 });
      if (tplImg) page.drawImage(tplImg, { x: 0, y: 0, width: W, height: H });

      if (embedded[i]) {
        drawCodeBlock(page, embedded[i], codeZone, opts.style || {});
      } else {
        // заглушка для предпросмотра без файла кодов
        const side = Math.min(codeZone.w, codeZone.h / 1.16);
        const x = codeZone.x + (codeZone.w - side) / 2; const y = codeZone.y + codeZone.h - side;
        page.drawRectangle({ x, y, width: side, height: side, color: rgb(0.75, 0.75, 0.75) });
        page.drawText('DataMatrix', { x: x + 2, y: y + side / 2, size: Math.max(4, side / 9), font: fonts.prefix, color: rgb(0.3, 0.3, 0.3) });
      }
      drawInfo(page, fonts, plan, infoZone, prefix, String(start + i), opts.style || {});
      if (opts.showFrames) drawZoneFrames(page, opts.zones, H);
      if (opts.onProgress && i % 20 === 0) { opts.onProgress(i, total); await new Promise((r) => setTimeout(r, 0)); }
    }
    out.setTitle(`Этикетки ${prefix} ${start}-${start + total - 1}`);
    out.setProducer('PDF-Editor / этикетки Честный знак');
    return out.save();
  }

  /**
   * Дополнить исходный файл кодов полем «артикул дата НОМЕР» (для внешней упаковки).
   * zone — в мм от левого верхнего угла страницы кода.
   */
  async function buildCodes(opts) {
    const doc = await PDFDocument.load(opts.codesBytes, { ignoreEncryption: true, updateMetadata: false });
    const pages = doc.getPages();
    if (opts.analysis && pages.length !== opts.analysis.pageCount) throw new Error('Файл кодов изменился после проверки — загрузите его заново.');
    const fonts = await loadFonts(doc);
    const prefix = safeText(`${opts.article} ${formatDate(opts.dateIso)}`.trim());
    const start = Number(opts.start) || 1;
    const total = Math.min(pages.length, opts.limit || Infinity);
    const maxNumberStr = String(start + pages.length - 1).replace(/\d/g, '8');
    const keep = [];
    for (let i = 0; i < total; i++) {
      const page = pages[i];
      const { height: H } = page.getSize();
      const zone = zoneToPt(opts.zone, H);
      const plan = planInfoLayout(fonts, prefix, maxNumberStr, zone, Object.assign({ layout: 'auto', align: 'center' }, opts.style || {}));
      drawInfo(page, fonts, plan, zone, prefix, String(start + i), Object.assign({ align: 'center' }, opts.style || {}));
      if (opts.showFrames) drawZoneFrames(page, { info: opts.zone }, H);
      keep.push(i);
      if (opts.onProgress && i % 25 === 0) { opts.onProgress(i, total); await new Promise((r) => setTimeout(r, 0)); }
    }
    for (let i = pages.length - 1; i >= total; i--) doc.removePage(i);
    return doc.save();
  }

  function buildJournalCsv(analysis, { article, dateIso, start }) {
    const rows = [['Номер', 'Артикул', 'Дата фасовки', 'Страница в файле кодов', 'Код маркировки (текст под DataMatrix)']];
    analysis.pages.forEach((p, i) => rows.push([String(Number(start) + i), article, formatDate(dateIso), String(i + 1), p.code]));
    const esc = (v) => (/[;"\n]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : v);
    return '﻿' + rows.map((r) => r.map(esc).join(';')).join('\r\n');
  }

  return { MM, analyzeCodes, readCodesFromPdf: analyzeCodes, buildLabels, buildCodes, buildJournalCsv, formatDate, safeText, _internal: { tokenize, parseToUnicode, scanPage } };
});
