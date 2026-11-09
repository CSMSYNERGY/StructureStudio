// A small Excel (.xlsx) price list built in code, and the reader that stands in for ExcelJS in the browser,
// for jackTab.mjs BR.
//
// WHY A STAND-IN: the portal loads ExcelJS from cdnjs when a .xlsx is dropped in (03-catalog.jsx
// loadExcelJS). The harness lets nothing leave the machine, and there is no copy of ExcelJS here, so that
// script never loads and every .xlsx upload in a harness ends at "Could not load the spreadsheet library".
// The stand-in answers that one URL. It reads the real file the page was handed: the zip (deflated, as
// Excel writes it), the workbook's sheets and their state (visible or hidden), the shared strings, and
// each cell, a date-formatted number coming back as a Date. That is the part of ExcelJS the portal's
// reader uses (readXlsxWorkbook: worksheets, name, state, getSheetValues()'s 1-based rows and cells).
// Everything after it, the portal's own reading, what it posts, and jack-agent's handling, is the real code.
//
// The file is built here with node:zlib, so no spreadsheet library is needed on this side either.

import { crc32, deflateRawSync } from "node:zlib";

export const EXCELJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const colName = (n) => { let s = ""; for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s; return s; };
/** Excel's day number for a date: days since 1899-12-30. */
const serial = (iso) => (Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000;

/** A zip of `files` ({ path: text }), each entry deflated, the way Excel saves a workbook. */
function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, "utf8");
    const data = deflateRawSync(raw);
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(raw) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x5a21, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0x5a21, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  const count = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, end]);
}

/** A workbook. `sheets`: [{ name, hidden?, rows: [[cell]] }], a cell being a string, a number, { date:
 *  "YYYY-MM-DD" } (a number Excel shows as a date, as it does to a size typed like 10-16), or null. */
export function buildXlsx(sheets) {
  const strings = [], at = new Map();
  const str = (s) => { if (!at.has(s)) { at.set(s, strings.length); strings.push(s); } return at.get(s); };
  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>${sheets.map((_s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ""} r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId${sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    // Style 0 is General; style 1 is Excel's short date (number format 14).
    "xl/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`,
  };
  sheets.forEach((s, i) => {
    const rows = s.rows.map((row, r) => `<row r="${r + 1}">${row.map((cell, c) => {
      const ref = `${colName(c + 1)}${r + 1}`;
      if (cell === null || cell === undefined || cell === "") return "";
      if (typeof cell === "number") return `<c r="${ref}"><v>${cell}</v></c>`;
      if (typeof cell === "object" && cell.date) return `<c r="${ref}" s="1"><v>${serial(cell.date)}</v></c>`;
      return `<c r="${ref}" t="s"><v>${str(String(cell))}</v></c>`;
    }).join("")}</row>`).join("");
    files[`xl/worksheets/sheet${i + 1}.xml`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  });
  files["xl/sharedStrings.xml"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((t) => `<si><t xml:space="preserve">${esc(t)}</t></si>`).join("")}</sst>`;
  return zip(files);
}

/** Served at EXCELJS_URL: window.ExcelJS with the Workbook the portal uses. It unzips with the browser's
 *  own DecompressionStream and parses with DOMParser. `window.__xlsxStandIn` counts the files it read, so
 *  a check can see the portal really went through it. */
export const EXCELJS_STAND_IN = `(() => {
  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const text = (u8) => new TextDecoder().decode(u8);
  async function unzip(buf) {
    const b = new Uint8Array(buf);
    let e = b.length - 22;
    while (e >= 0 && u32(b, e) !== 0x06054b50) e--;
    if (e < 0) throw new Error("That isn't an Excel file.");
    const n = u16(b, e + 10);
    let p = u32(b, e + 16);
    const files = {};
    for (let i = 0; i < n; i++) {
      const method = u16(b, p + 10), size = u32(b, p + 20), nl = u16(b, p + 28), xl = u16(b, p + 30), cl = u16(b, p + 32), off = u32(b, p + 42);
      const name = text(b.subarray(p + 46, p + 46 + nl));
      const start = off + 30 + u16(b, off + 26) + u16(b, off + 28);
      const data = b.slice(start, start + size);
      const raw = method === 0 ? data
        : method === 8 ? new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer())
        : null;
      if (!raw) throw new Error("zip method " + method);
      files[name] = text(raw);
      p += 46 + nl + xl + cl;
    }
    return files;
  }
  const xml = (s) => new DOMParser().parseFromString(s, "application/xml");
  const all = (node, tag) => [...node.getElementsByTagName(tag)];
  const colOf = (ref) => { let n = 0; for (const ch of ref.replace(/[0-9]+$/, "")) n = n * 26 + (ch.charCodeAt(0) - 64); return n; };
  const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
  class Workbook {
    constructor() {
      this.worksheets = [];
      const book = this;
      this.xlsx = { async load(buf) { await book._read(buf); return book; } };
    }
    async _read(buf) {
      const f = await unzip(buf);
      const shared = f["xl/sharedStrings.xml"] ? all(xml(f["xl/sharedStrings.xml"]), "si").map((si) => all(si, "t").map((t) => t.textContent).join("")) : [];
      const xfs = f["xl/styles.xml"] ? all(all(xml(f["xl/styles.xml"]), "cellXfs")[0], "xf").map((x) => Number(x.getAttribute("numFmtId") || 0)) : [];
      const rels = {};
      for (const r of all(xml(f["xl/_rels/workbook.xml.rels"]), "Relationship")) rels[r.getAttribute("Id")] = r.getAttribute("Target");
      for (const s of all(xml(f["xl/workbook.xml"]), "sheet")) {
        const target = rels[s.getAttribute("r:id")];
        const values = [];
        for (const row of all(xml(f[target.startsWith("/") ? target.slice(1) : "xl/" + target]), "row")) {
          const cells = [];
          for (const c of all(row, "c")) {
            const t = c.getAttribute("t"), v = all(c, "v")[0]?.textContent;
            let val;
            if (t === "s") val = shared[Number(v)];
            else if (t === "inlineStr") val = all(c, "t").map((x) => x.textContent).join("");
            else if (t === "str") val = v ?? "";
            else if (t === "b") val = v === "1";
            else if (v === undefined) continue;
            else val = DATE_FORMATS.has(xfs[Number(c.getAttribute("s") || 0)]) ? new Date(Math.round((Number(v) - 25569) * 86400000)) : Number(v);
            cells[colOf(c.getAttribute("r"))] = val;
          }
          values[Number(row.getAttribute("r"))] = cells;
        }
        this.worksheets.push({ name: s.getAttribute("name"), state: s.getAttribute("state") || "visible", getSheetValues: () => values });
      }
      window.__xlsxStandIn = (window.__xlsxStandIn || 0) + 1;
    }
  }
  window.ExcelJS = { Workbook };
})();`;
