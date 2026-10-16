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

const TEMPLATE_COLUMNS = [
  ['Email', 32, 'Required. One address per row.'],
  ['Name', 24, 'Full name. {{first_name}} is taken from it automatically.'],
  ['Company', 24, 'Use in emails as {{company}}'],
  ['Designation', 20, '{{designation}}'],
  ['City', 16, '{{city}}'],
  ['Phone', 16, '{{phone}}'],
];

/**
 * Excel file to fill in for a bulk send / contact import. The first sheet is read on upload, so it only has
 * the column titles; examples and instructions are on a second sheet and can never be emailed by mistake.
 * `extra` adds columns (e.g. fields used in the current message such as invoice_no).
 */
export async function buildTemplateXlsx(extra = []) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Company Mail';
  const cols = [...TEMPLATE_COLUMNS];
  for (const e of extra) {
    const title = String(e).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 40);
    if (title && !cols.some(([c]) => c.toLowerCase() === title.toLowerCase())) cols.push([title, 18, `{{${e}}}`]);
  }

  const ws = wb.addWorksheet('Recipients', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = cols.map(([header, width]) => ({ header, width }));
  const head = ws.getRow(1);
  head.height = 22;
  head.eachCell((cell, i) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: i === 1 ? 'FF4F46E5' : 'FF6D74F7' } };
    cell.alignment = { vertical: 'middle' };
    cell.note = cols[i - 1][2];
  });
  ws.dataValidations.add('A2:A20001', {
    type: 'custom', allowBlank: true, formulae: ['ISNUMBER(SEARCH("@",A2))'],
    showErrorMessage: true, errorStyle: 'warning', errorTitle: 'Email address', error: 'This does not look like an email address.',
  });

  const help = wb.addWorksheet('How to fill');
  help.columns = [{ width: 4 }, { width: 110 }];
  const lines = [
    ['How to use this file'],
    [''],
    ['1', 'Fill in the "Recipients" sheet: one person per row. Only the Email column is required.'],
    ['2', 'Keep the first row (the column titles). You can delete columns you do not need or add your own, e.g. "Amount".'],
    ['3', 'In the email, every column can be used as a field: Company -> {{company}}, Due date -> {{due_date}}, Name -> {{name}} and {{first_name}}.'],
    ['4', 'Add a fallback for empty cells like this: {{first_name|there}} gives "Hi there" when the name is missing.'],
    ['5', 'Save the file (.xlsx) and upload it under Bulk send -> Upload Excel / CSV, or under Contacts -> Import.'],
    [''],
    ['', 'Example rows (do not fill this sheet; it is not read when uploading):'],
  ];
  for (const l of lines) help.addRow(l);
  help.getRow(1).font = { bold: true, size: 14, color: { argb: 'FF4F46E5' } };
  help.getRow(lines.length).font = { italic: true, color: { argb: 'FF6B7088' } };
  const ex = help.addRow(['', cols.map(([c]) => c).join('  |  ')]);
  ex.font = { bold: true };
  help.addRow(['', ['priya.sharma@example.com', 'Priya Sharma', 'Acme Pvt Ltd', 'Manager', 'Pune', '+91 98xxxxxx01'].join('  |  ')]);
  help.addRow(['', ['ravi@example.com', 'Ravi Kumar', 'Globex', 'Director', 'Mumbai', ''].join('  |  ')]);
  return Buffer.from(await wb.xlsx.writeBuffer());
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
