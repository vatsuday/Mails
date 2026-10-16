// Reads contact files (CSV / Excel) uploaded as base64.
import ExcelJS from 'exceljs';
import { badRequest } from './util.js';

const MAX_ROWS = 20000;

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  for (const ch of firstLine) if (ch in counts) counts[ch] += 1;
  const delim = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0
    ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ',';

  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); cell = '';
      rows.push(row); row = [];
      if (rows.length > MAX_ROWS + 1) break;
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function cellText(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (v.text != null) return typeof v.text === 'object' ? cellText(v.text) : String(v.text); // hyperlink
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v.result != null) return cellText(v.result); // formula
    if (v.hyperlink) return String(v.hyperlink).replace(/^mailto:/i, '');
    return '';
  }
  return String(v);
}

async function parseXlsx(buf) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf);
  } catch {
    throw badRequest('This Excel file could not be read. Save it as .xlsx or .csv and try again.');
  }
  const ws = wb.worksheets.find((w) => w.actualRowCount > 0);
  if (!ws) return [];
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    if (rows.length > MAX_ROWS + 1) return;
    const vals = [];
    for (let c = 1; c <= ws.columnCount; c += 1) vals.push(cellText(row.getCell(c).value).trim());
    rows.push(vals);
  });
  return rows;
}

/** Returns { columns, rows } where rows are objects keyed by column name. */
export async function parseContactFile(filename, base64) {
  const buf = Buffer.from(String(base64 || ''), 'base64');
  if (!buf.length) throw badRequest('The file is empty.');
  const ext = String(filename || '').toLowerCase().split('.').pop();
  let grid;
  if (ext === 'xlsx' || ext === 'xlsm') grid = await parseXlsx(buf);
  else if (['csv', 'txt', 'tsv'].includes(ext)) grid = parseCsv(buf.toString('utf8'));
  else if (ext === 'xls') throw badRequest('Old .xls files are not supported. Open it in Excel and "Save As" .xlsx or .csv.');
  else throw badRequest('Please upload an Excel (.xlsx) or CSV file.');

  grid = grid.map((r) => r.map((c) => String(c ?? '').trim())).filter((r) => r.some(Boolean));
  if (!grid.length) throw badRequest('No rows were found in this file.');

  // If the first row already contains an email address there is no header row.
  const hasHeader = !grid[0].some((c) => /@/.test(c));
  const width = Math.max(...grid.map((r) => r.length));
  const columns = [];
  for (let i = 0; i < width; i += 1) {
    let name = (hasHeader ? grid[0][i] : '') || `Column ${i + 1}`;
    while (columns.includes(name)) name += ' (2)';
    columns.push(name.slice(0, 60));
  }
  const body = hasHeader ? grid.slice(1) : grid;
  if (body.length > MAX_ROWS) throw badRequest(`This file has more than ${MAX_ROWS.toLocaleString()} rows. Please split it into smaller files.`);
  const rows = body.map((r) => Object.fromEntries(columns.map((c, i) => [c, (r[i] ?? '').slice(0, 500)])));
  return { columns, rows };
}
