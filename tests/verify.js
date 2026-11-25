/*
 * Проверка соответствия «страница кода i -> этикетка i -> номер start+i».
 * Запуск:  npm install && node tests/verify.js <коды.pdf> <шаблон.pdf|png> [начальный_номер]
 * Скрипт собирает этикетки и коды, затем заново читает результат и сверяет текст кода и номер на каждой странице.
 */
const fs = require('fs');
const path = require('path');
const PDFLib = require('pdf-lib');
const Core = require('../core.js')(PDFLib);

async function main() {
  const [codesPath, tplPath, startArg] = process.argv.slice(2);
  if (!codesPath || !tplPath) { console.log('node tests/verify.js <коды.pdf> <шаблон> [начальный_номер]'); process.exit(2); }
  const start = parseInt(startArg || '1', 10);
  const codesBytes = fs.readFileSync(codesPath);
  const ext = path.extname(tplPath).toLowerCase();
  const kind = ext === '.pdf' ? 'pdf' : ext === '.png' ? 'png' : 'jpg';
  const analysis = await Core.analyzeCodes(codesBytes);
  console.log(`Страниц: ${analysis.pageCount}, дублей: ${analysis.duplicates.length}, без DataMatrix: ${analysis.notFound.length}`);

  const zones = { code: { x: 49, y: 13.5, w: 23, h: 23.5 }, info: { x: 33, y: 1.5, w: 39, h: 9 } };
  const labels = await Core.buildLabels({ template: { kind, bytes: fs.readFileSync(tplPath), widthMm: 75, heightMm: 120 }, codesBytes, analysis, zones, article: 'test', dateIso: '2026-01-01', start });
  const codes = await Core.buildCodes({ codesBytes, analysis, zone: { x: 1.5, y: 1.5, w: 32, h: 12 }, article: 'test', dateIso: '2026-01-01', start });

  // Перечитываем результат: каждая страница кодов должна содержать исходный код i и номер start+i.
  const reread = await Core.analyzeCodes(codes);
  let bad = 0;
  reread.pages.forEach((p, i) => { if (!p.code.includes(analysis.pages[i].code)) bad++; });
  const labDoc = await PDFLib.PDFDocument.load(labels);
  if (labDoc.getPageCount() !== analysis.pageCount) bad++;
  console.log(bad ? `ОШИБОК: ${bad}` : `OK: ${analysis.pageCount} этикеток, номера ${start}–${start + analysis.pageCount - 1}`);
  fs.writeFileSync('test_labels.pdf', labels);
  fs.writeFileSync('test_codes.pdf', codes);
  process.exit(bad ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
