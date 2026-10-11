/* ============================================================
   xlsx.js - 生成真正的 Excel 文件（.xlsx），零依赖

   .xlsx 本质是一个 ZIP 包，里面放着若干 XML。
   这里自己拼出最小可用的 xlsx：
     [Content_Types].xml / _rels/.rels / xl/workbook.xml
     xl/_rels/workbook.xml.rels / xl/styles.xml / xl/worksheets/sheetN.xml
   ZIP 条目采用「不压缩」方式存储，Excel / WPS / 手机版 Office 都能正常打开。

   对外接口： Xlsx.build(sheets) -> Uint8Array
     sheets = [{ name: '明细', columns: [{title, width}], rows: [[...], ...] }]
     单元格：字符串直接写；数字写为数值；{v, style:'bold'|'money'} 可指定样式
   ============================================================ */
(function (global) {
  'use strict';

  const X = {};

  /* ---------------- 最小 ZIP 写入（仅存储，不压缩） ---------------- */
  const CRC_TABLE = (function () {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function utf8(str) {
    if (global.TextEncoder) return new TextEncoder().encode(str);
    const esc = unescape(encodeURIComponent(str));
    const out = new Uint8Array(esc.length);
    for (let i = 0; i < esc.length; i++) out[i] = esc.charCodeAt(i);
    return out;
  }

  function writeZip(entries) {
    const DOS_TIME = 0;
    const DOS_DATE = 0x2821;   // 2000-01-01
    const parts = [];
    const central = [];
    let offset = 0;

    entries.forEach(function (e) {
      const nameBytes = utf8(e.name);
      const data = e.data;
      const crc = crc32(data);

      const lh = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);   // 文件名 UTF-8
      lv.setUint16(8, 0, true);        // 0 = 不压缩
      lv.setUint16(10, DOS_TIME, true);
      lv.setUint16(12, DOS_DATE, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      lh.set(nameBytes, 30);
      parts.push(lh, data);

      const ch = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, DOS_TIME, true);
      cv.setUint16(14, DOS_DATE, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, offset, true);
      ch.set(nameBytes, 46);
      central.push(ch);

      offset += lh.length + data.length;
    });

    const cdSize = central.reduce(function (s, c) { return s + c.length; }, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);

    const all = parts.concat(central, [eocd]);
    const total = all.reduce(function (s, p) { return s + p.length; }, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    all.forEach(function (p) { out.set(p, pos); pos += p.length; });
    return out;
  }

  /* ---------------- XML 工具 ---------------- */
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');   // XML 不接受的不可见字符
  }

  function colName(n) {   // 1 -> A, 27 -> AA
    let s = '';
    while (n > 0) {
      const m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  const STYLE = { normal: 0, bold: 1, money: 2, moneyBold: 3 };

  function cellXml(ref, value) {
    if (value === null || value === undefined || value === '') {
      return '<c r="' + ref + '"/>';
    }
    let v = value, style = 0;
    if (typeof value === 'object' && value !== null) {
      v = value.v;
      if (value.style === 'bold') style = STYLE.bold;
      else if (value.style === 'money') style = STYLE.money;
      else if (value.style === 'moneyBold') style = STYLE.moneyBold;
    }
    const sAttr = style ? ' s="' + style + '"' : '';
    if (typeof v === 'number' && isFinite(v)) {
      return '<c r="' + ref + '"' + sAttr + '><v>' + v + '</v></c>';
    }
    return '<c r="' + ref + '"' + sAttr + ' t="inlineStr"><is><t xml:space="preserve">' + esc(v) + '</t></is></c>';
  }

  function sheetXml(sheet) {
    const cols = (sheet.columns || []).map(function (c, i) {
      const w = c.width || 14;
      return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>';
    }).join('');

    const rows = [];
    if (sheet.columns && sheet.columns.length) {
      rows.push('<row r="1" ht="22" customHeight="1">' + sheet.columns.map(function (c, i) {
        return cellXml(colName(i + 1) + '1', { v: c.title, style: 'bold' });
      }).join('') + '</row>');
    }
    (sheet.rows || []).forEach(function (row, ri) {
      const r = ri + 2;
      rows.push('<row r="' + r + '">' + row.map(function (v, ci) {
        return cellXml(colName(ci + 1) + r, v);
      }).join('') + '</row>');
    });

    const lastCol = colName(Math.max(1, (sheet.columns || []).length));
    const lastRow = Math.max(1, (sheet.rows || []).length + 1);

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<dimension ref="A1:' + lastCol + lastRow + '"/>' +
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="16"/>' +
      (cols ? '<cols>' + cols + '</cols>' : '') +
      '<sheetData>' + rows.join('') + '</sheetData>' +
      '</worksheet>';
  }

  const STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2">' +
    '<font><sz val="11"/><color theme="1"/><name val="等线"/></font>' +
    '<font><b/><sz val="11"/><color theme="1"/><name val="等线"/></font>' +
    '</fonts>' +
    '<fills count="3">' +
    '<fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFEEF0FA"/><bgColor indexed="64"/></patternFill></fill>' +
    '</fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="4">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
    '<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="4" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>' +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="常规" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';

  /* ---------------- 组装 xlsx ---------------- */
  X.build = function (sheets) {
    const names = sheets.map(function (s, i) { return (s.name || ('工作表' + (i + 1))).slice(0, 28); });

    const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheets.map(function (s, i) {
        return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
      }).join('') +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>';

    const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>';

    const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets>' + names.map(function (n, i) {
        return '<sheet name="' + esc(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
      }).join('') + '</sheets></workbook>';

    const workbookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map(function (s, i) {
        return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>';
      }).join('') +
      '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>';

    const entries = [
      { name: '[Content_Types].xml', data: utf8(contentTypes) },
      { name: '_rels/.rels', data: utf8(rootRels) },
      { name: 'xl/workbook.xml', data: utf8(workbook) },
      { name: 'xl/_rels/workbook.xml.rels', data: utf8(workbookRels) },
      { name: 'xl/styles.xml', data: utf8(STYLES_XML) }
    ];
    sheets.forEach(function (s, i) {
      entries.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: utf8(sheetXml(s)) });
    });

    return writeZip(entries);
  };

  global.Xlsx = X;
  if (typeof module !== 'undefined' && module.exports) module.exports = X;
})(typeof window !== 'undefined' ? window : globalThis);