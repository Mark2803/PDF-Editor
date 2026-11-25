/*
 * Декодер DataMatrix ECC200 по готовой матрице модулей (без камеры).
 * Используется, чтобы достать из PDF «Честного знака» ПОЛНЫЙ код маркировки
 * (с разделителем GS и криптохвостом 93xxxx), которого нет в тексте под квадратом.
 *
 * decodeMatrix(bits) — bits[row][col] = true для чёрного модуля, строка 0 сверху.
 * Возвращает { text, gs1, ok, rsOk } или бросает ошибку.
 * GS (FNC1 внутри кода) возвращается как символ \u001d.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DataMatrix = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // [rows, cols, regionRows, regionCols, regionsV, regionsH, dataCW, eccCW, blocks]
  const SYMBOLS = [
    [10, 10, 8, 8, 1, 1, 3, 5, 1], [12, 12, 10, 10, 1, 1, 5, 7, 1], [14, 14, 12, 12, 1, 1, 8, 10, 1],
    [16, 16, 14, 14, 1, 1, 12, 12, 1], [18, 18, 16, 16, 1, 1, 18, 14, 1], [20, 20, 18, 18, 1, 1, 22, 18, 1],
    [22, 22, 20, 20, 1, 1, 30, 20, 1], [24, 24, 22, 22, 1, 1, 36, 24, 1], [26, 26, 24, 24, 1, 1, 44, 28, 1],
    [32, 32, 14, 14, 2, 2, 62, 36, 1], [36, 36, 16, 16, 2, 2, 86, 42, 1], [40, 40, 18, 18, 2, 2, 114, 48, 1],
    [44, 44, 20, 20, 2, 2, 144, 56, 1], [48, 48, 22, 22, 2, 2, 174, 68, 1], [52, 52, 24, 24, 2, 2, 204, 84, 2],
    [64, 64, 14, 14, 4, 4, 280, 112, 2], [72, 72, 16, 16, 4, 4, 368, 144, 4], [80, 80, 18, 18, 4, 4, 456, 192, 4],
    [88, 88, 20, 20, 4, 4, 576, 224, 4], [96, 96, 22, 22, 4, 4, 696, 272, 4], [104, 104, 24, 24, 4, 4, 816, 336, 6],
    [120, 120, 18, 18, 6, 6, 1050, 408, 6], [132, 132, 20, 20, 6, 6, 1304, 496, 8], [144, 144, 22, 22, 6, 6, 1558, 620, 10],
    [8, 18, 6, 16, 1, 1, 5, 7, 1], [8, 32, 6, 14, 1, 2, 10, 11, 1], [12, 26, 10, 24, 1, 1, 16, 14, 1],
    [12, 36, 10, 16, 1, 2, 22, 18, 1], [16, 36, 14, 16, 1, 2, 32, 24, 1], [16, 48, 14, 22, 1, 2, 49, 28, 1],
  ];

  // ---- GF(256), полином 0x12D ----
  const EXP = new Array(512); const LOG = new Array(256);
  (function () { let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x12d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; })();
  const gmul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

  function syndromesZero(block, nEcc) {
    for (let j = 1; j <= nEcc; j++) {
      let s = 0; const a = EXP[j % 255];
      for (let i = 0; i < block.length; i++) s = gmul(s, a) ^ block[i];
      if (s !== 0) return false;
    }
    return true;
  }

  function extractMapping(bits, spec) {
    const [, , rr, rc, rv, rh] = spec;
    const nR = rv * rr; const nC = rh * rc;
    const m = [];
    for (let r = 0; r < nR; r++) {
      const row = new Array(nC);
      const sr = Math.floor(r / rr) * (rr + 2) + 1 + (r % rr);
      for (let c = 0; c < nC; c++) {
        const sc = Math.floor(c / rc) * (rc + 2) + 1 + (c % rc);
        row[c] = bits[sr][sc] ? 1 : 0;
      }
      m.push(row);
    }
    return m;
  }

  function readCodewords(m) {
    const numRows = m.length; const numCols = m[0].length;
    const read = m.map((r) => r.map(() => false));
    const mod = (row, col) => {
      if (row < 0) { row += numRows; col += 4 - ((numRows + 4) & 7); }
      if (col < 0) { col += numCols; row += 4 - ((numCols + 4) & 7); }
      if (row >= numRows) row -= numRows;
      read[row][col] = true;
      return m[row][col];
    };
    const cw = (cells) => cells.reduce((v, [r, c]) => (v << 1) | mod(r, c), 0);
    const utah = (r, c) => cw([[r - 2, c - 2], [r - 2, c - 1], [r - 1, c - 2], [r - 1, c - 1], [r - 1, c], [r, c - 2], [r, c - 1], [r, c]]);
    const R = numRows; const C = numCols;
    const corner1 = () => cw([[R - 1, 0], [R - 1, 1], [R - 1, 2], [0, C - 2], [0, C - 1], [1, C - 1], [2, C - 1], [3, C - 1]]);
    const corner2 = () => cw([[R - 3, 0], [R - 2, 0], [R - 1, 0], [0, C - 4], [0, C - 3], [0, C - 2], [0, C - 1], [1, C - 1]]);
    const corner3 = () => cw([[R - 1, 0], [R - 1, C - 1], [0, C - 3], [0, C - 2], [0, C - 1], [1, C - 3], [1, C - 2], [1, C - 1]]);
    const corner4 = () => cw([[R - 3, 0], [R - 2, 0], [R - 1, 0], [0, C - 2], [0, C - 1], [1, C - 1], [2, C - 1], [3, C - 1]]);
    const out = [];
    let row = 4; let col = 0; let c1 = false; let c2 = false; let c3 = false; let c4 = false;
    do {
      if (row === R && col === 0 && !c1) { out.push(corner1()); row -= 2; col += 2; c1 = true; }
      else if (row === R - 2 && col === 0 && (C & 3) !== 0 && !c2) { out.push(corner2()); row -= 2; col += 2; c2 = true; }
      else if (row === R + 4 && col === 2 && (C & 7) === 0 && !c3) { out.push(corner3()); row -= 2; col += 2; c3 = true; }
      else if (row === R - 2 && col === 0 && (C & 7) === 4 && !c4) { out.push(corner4()); row -= 2; col += 2; c4 = true; }
      else {
        do { if (row < R && col >= 0 && !read[row][col]) out.push(utah(row, col)); row -= 2; col += 2; } while (row >= 0 && col < C);
        row += 1; col += 3;
        do { if (row >= 0 && col < C && !read[row][col]) out.push(utah(row, col)); row += 2; col -= 2; } while (row < R && col >= 0);
        row += 3; col += 1;
      }
    } while (row < R || col < C);
    return out;
  }

  function decodeData(cw) {
    let out = ''; let i = 0; let upper = false; let gs1 = false;
    const C40_BASIC = ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'; // значения 3..39
    const TEXT_BASIC = ' 0123456789abcdefghijklmnopqrstuvwxyz';
    const SHIFT2 = '!"#$%&\'()*+,-./:;<=>?@[\\]^_';
    const C40_SHIFT3 = '`abcdefghijklmnopqrstuvwxyz{|}~\u007f';
    const TEXT_SHIFT3 = '`ABCDEFGHIJKLMNOPQRSTUVWXYZ{|}~\u007f';
    const emit = (ch) => { out += upper ? String.fromCharCode(ch.charCodeAt(0) + 128) : ch; upper = false; };

    const c40text = (isText) => {
      let shift = 0;
      while (i + 1 < cw.length) {
        if (cw[i] === 254) { i++; return; }
        const v = (cw[i] << 8) + cw[i + 1] - 1; i += 2;
        const vals = [Math.floor(v / 1600), Math.floor(v / 40) % 40, v % 40];
        for (const c of vals) {
          if (shift === 0) {
            if (c < 3) shift = c + 1;
            else emit((isText ? TEXT_BASIC : C40_BASIC)[c - 3]);
          } else if (shift === 1) { emit(String.fromCharCode(c)); shift = 0; }
          else if (shift === 2) {
            if (c < 27) emit(SHIFT2[c]);
            else if (c === 27) { out += '\u001d'; }
            else if (c === 30) upper = true;
            shift = 0;
          } else { emit((isText ? TEXT_SHIFT3 : C40_SHIFT3)[c] || ''); shift = 0; }
        }
        if (i >= cw.length || cw[i] === 254) { if (i < cw.length) i++; return; }
      }
    };
    const x12 = () => {
      const T = '\r*> ';
      while (i + 1 < cw.length) {
        if (cw[i] === 254) { i++; return; }
        const v = (cw[i] << 8) + cw[i + 1] - 1; i += 2;
        for (const c of [Math.floor(v / 1600), Math.floor(v / 40) % 40, v % 40]) {
          if (c < 4) out += T[c]; else if (c < 14) out += String.fromCharCode(48 + c - 4); else out += String.fromCharCode(65 + c - 14);
        }
        if (cw[i] === 254) { i++; return; }
      }
    };
    const edifact = () => {
      while (i + 2 < cw.length) {
        const bitsv = (cw[i] << 16) | (cw[i + 1] << 8) | cw[i + 2]; i += 3;
        for (let k = 0; k < 4; k++) {
          let v = (bitsv >> (18 - 6 * k)) & 0x3f;
          if (v === 0x1f) return;
          if (!(v & 0x20)) v |= 0x40;
          out += String.fromCharCode(v);
        }
      }
    };
    const base256 = () => {
      const unr = (val, pos) => { const r = ((149 * pos) % 255) + 1; const t = val - r; return t >= 0 ? t : t + 256; };
      let d1 = unr(cw[i], i + 1); i++;
      let len = d1;
      if (d1 === 0) len = cw.length - i;
      else if (d1 >= 250) { len = 250 * (d1 - 249) + unr(cw[i], i + 1); i++; }
      for (let k = 0; k < len && i < cw.length; k++) { out += String.fromCharCode(unr(cw[i], i + 1)); i++; }
    };

    while (i < cw.length) {
      const v = cw[i++];
      if (v === 0) throw new Error('неверное кодовое слово 0');
      if (v <= 128) emit(String.fromCharCode(v - 1));
      else if (v === 129) break; // заполнитель — конец данных
      else if (v <= 229) { const d = v - 130; const s = (d < 10 ? '0' : '') + d; out += s; }
      else if (v === 230) c40text(false);
      else if (v === 231) base256();
      else if (v === 232) { if (out.length === 0) gs1 = true; else out += '\u001d'; }
      else if (v === 235) upper = true;
      else if (v === 238) x12();
      else if (v === 239) c40text(true);
      else if (v === 240) edifact();
      else if (v === 236) out += '[)>\u001e05\u001d';
      else if (v === 237) out += '[)>\u001e06\u001d';
      // 233 (structured append), 234 (reader prog), 241 (ECI) — игнорируем
    }
    return { text: out, gs1 };
  }

  function decodeMatrix(bits) {
    const rows = bits.length; const cols = bits[0].length;
    const spec = SYMBOLS.find((s) => s[0] === rows && s[1] === cols);
    if (!spec) throw new Error(`неизвестный размер DataMatrix ${rows}×${cols}`);
    const [, , , , , , nData, nEcc, nBlocks] = spec;
    const stream = readCodewords(extractMapping(bits, spec));
    const total = nData + nEcc;
    if (stream.length < total) throw new Error('не хватает кодовых слов');
    // разбор блоков (чередование)
    const data = new Array(nData);
    let rsOk = true;
    for (let b = 0; b < nBlocks; b++) {
      const blk = []; const blkEcc = [];
      for (let k = b; k < nData; k += nBlocks) blk.push(k);
      for (let k = b; k < nEcc; k += nBlocks) blkEcc.push(nData + k);
      const words = blk.map((k) => stream[k]).concat(blkEcc.map((k) => stream[k]));
      if (!syndromesZero(words, blkEcc.length)) rsOk = false;
    }
    // Чередование блоков идёт по позиции (слово k -> блок k % nBlocks),
    // поэтому сами данные уже лежат в исходном порядке.
    for (let k = 0; k < nData; k++) data[k] = stream[k];
    const dec = decodeData(data);
    return { text: dec.text, gs1: dec.gs1, rsOk, ok: rsOk, size: `${rows}x${cols}` };
  }

  /**
   * Построить матрицу модулей из списка закрашенных прямоугольников (в любых единицах).
   * rects: [{x0,y0,x1,y1}] — система координат PDF (y вверх).
   */
  function matrixFromRects(rects) {
    if (!rects.length) throw new Error('нет модулей');
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity; let mod = Infinity;
    for (const r of rects) {
      minX = Math.min(minX, r.x0); minY = Math.min(minY, r.y0); maxX = Math.max(maxX, r.x1); maxY = Math.max(maxY, r.y1);
      const w = r.x1 - r.x0; const h = r.y1 - r.y0;
      if (w > 1e-6) mod = Math.min(mod, w);
      if (h > 1e-6) mod = Math.min(mod, h);
    }
    const cols = Math.round((maxX - minX) / mod);
    const rows = Math.round((maxY - minY) / mod);
    const bits = Array.from({ length: rows }, () => new Array(cols).fill(false));
    for (const r of rects) {
      const c0 = Math.round((r.x0 - minX) / mod); const c1 = Math.round((r.x1 - minX) / mod);
      const r0 = Math.round((maxY - r.y1) / mod); const r1 = Math.round((maxY - r.y0) / mod);
      for (let y = r0; y < r1; y++) for (let x = c0; x < c1; x++) if (bits[y] && x < cols) bits[y][x] = true;
    }
    return bits;
  }

  /** Код в читаемом виде: GS показываем как ‹GS› */
  function display(code) { return String(code).replace(/\u001d/g, '‹GS›'); }

  return { decodeMatrix, matrixFromRects, display, SYMBOLS };
});
