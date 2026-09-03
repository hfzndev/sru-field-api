/**
 * CSV export for the admin Data Lapangan tab (doc 06 §6).
 *
 * Export is also the only bridge to SRU APP that the docs sanction (doc 04 §8),
 * so the output has to survive being opened in Excel.
 */

/**
 * Escapes one cell.
 *
 * Beyond normal quoting, a leading =, +, - or @ is neutralised with a single
 * quote. Excel treats such a cell as a formula, so a note typed by an operator
 * as "=cmd" would execute on open — CSV injection. Operators type free text
 * into these fields, so this is a live path, not a theoretical one.
 */
function cell(value) {
  if (value === null || value === undefined) return '';

  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;

  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * @param {Array<{key: string, header: string}>} columns
 * @param {Array<object>} rows
 */
export function toCsv(columns, rows) {
  const lines = [columns.map((c) => cell(c.header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => cell(row[c.key])).join(','));
  }
  // CRLF and a UTF-8 BOM: without the BOM Excel on Windows reads the file as
  // the local codepage and mangles Indonesian text.
  //
  // Written as an escape, not a literal BOM character — a raw U+FEFF in source
  // is stripped by the build transform, and the loss is invisible until someone
  // opens the export in Excel.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export function csvResponse(filename, body) {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
