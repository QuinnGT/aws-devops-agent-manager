/**
 * CSV writing for exports. Every cell is quoted (RFC 4180), and a cell that a
 * spreadsheet would read as a formula (it starts with = + - @, or a tab or
 * carriage return) gets a leading single quote so it is shown as text.
 */

const FORMULA_START = /^[=+\-@\t\r]/;

export function escapeCsvCell(value: unknown): string {
  let s: string;
  if (value === null || value === undefined) s = "";
  else if (value instanceof Date) s = value.toISOString();
  else if (typeof value === "object") s = JSON.stringify(value);
  else s = String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** One CSV line, terminated with CRLF. */
export function csvLine(cells: readonly unknown[]): string {
  return `${cells.map(escapeCsvCell).join(",")}\r\n`;
}
