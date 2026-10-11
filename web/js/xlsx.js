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

  /* ============================================================
     读取 .xlsx（微信账单默认导出的是 Excel 文件）
     ============================================================ */

  /** 解压 deflate-raw（浏览器内置能力，安卓 WebView 也支持） */
  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('当前浏览器不支持解压 .xlsx，请升级浏览器，或改用 CSV 格式导入');
    }
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** 解析 zip 的中央目录，得到每个条目的位置 */
  function readZipDirectory(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    const min = Math.max(0, bytes.length - 22 - 65535);
    for (let i = bytes.length - 22; i >= min; i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 Excel 文件（.xlsx 应该是一个压缩包）');

    const count = view.getUint16(eocd + 10, true);
    let off = view.getUint32(eocd + 16, true);
    const decoder = new TextDecoder('utf-8');
    const entries = [];

    for (let n = 0; n < count; n++) {
      if (off + 46 > bytes.length) break;
      if (view.getUint32(off, true) !== 0x02014b50) break;
      const method = view.getUint16(off + 10, true);
      const compSize = view.getUint32(off + 20, true);
      const nameLen = view.getUint16(off + 28, true);
      const extraLen = view.getUint16(off + 30, true);
      const commentLen = view.getUint16(off + 32, true);
      const localOff = view.getUint32(off + 42, true);
      const name = decoder.decode(bytes.subarray(off + 46, off + 46 + nameLen));
      const lNameLen = view.getUint16(localOff + 26, true);
      const lExtraLen = view.getUint16(localOff + 28, true);
      entries.push({
        name: name,
        method: method,
        compSize: compSize,
        dataStart: localOff + 30 + lNameLen + lExtraLen
      });
      off += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  function parseXml(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const err = doc.getElementsByTagName('parsererror');
    if (err && err.length) throw new Error('Excel 文件内容损坏，无法解析');
    return doc;
  }

  /** "BC12" -> 54（列下标，从 0 开始） */
  function colIndex(ref) {
    let n = 0;
    for (let i = 0; i < ref.length; i++) {
      const c = ref.charCodeAt(i);
      if (c >= 65 && c <= 90) n = n * 26 + (c - 64);
      else if (c >= 97 && c <= 122) n = n * 26 + (c - 96);
      else break;
    }
    return n - 1;
  }

  function sheetToRows(doc, shared) {
    const rows = [];
    const rowEls = doc.getElementsByTagName('row');

    for (let i = 0; i < rowEls.length; i++) {
      const rowEl = rowEls[i];
      const rNum = parseInt(rowEl.getAttribute('r') || '', 10);
      const rIdx = isFinite(rNum) && rNum > 0 ? rNum - 1 : rows.length;
      const arr = [];
      const cells = rowEl.getElementsByTagName('c');

      for (let j = 0; j < cells.length; j++) {
        const c = cells[j];
        const ref = c.getAttribute('r') || '';
        let ci = ref ? colIndex(ref) : arr.length;
        if (!(ci >= 0)) ci = arr.length;

        const type = c.getAttribute('t') || '';
        let val = '';

        if (type === 'inlineStr') {
          const is = c.getElementsByTagName('is')[0];
          if (is) {
            const ts = is.getElementsByTagName('t');
            const parts = [];
            for (let k = 0; k < ts.length; k++) parts.push(ts[k].textContent || '');
            val = parts.join('');
          }
        } else {
          const v = c.getElementsByTagName('v')[0];
          const raw = v ? (v.textContent || '') : '';
          if (type === 's') val = shared[parseInt(raw, 10)] || '';
          else if (type === 'b') val = raw === '1' ? 'TRUE' : 'FALSE';
          else val = raw;
        }

        while (arr.length < ci) arr.push('');
        arr[ci] = val;
      }

      while (rows.length < rIdx) rows.push([]);
      rows[rIdx] = arr;
    }
    return rows;
  }

  /** 读取整个工作簿，返回 [{ name, rows }] */
  X.read = async function (arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4B) {
      throw new Error('这不是 .xlsx 文件。如果是老式的 .xls 格式，请先在 Excel 里另存为 .xlsx 或 .csv');
    }

    const entries = readZipDirectory(bytes);
    const byName = {};
    entries.forEach(function (e) { byName[e.name] = e; });
    const decoder = new TextDecoder('utf-8');

    async function readText(name) {
      const e = byName[name];
      if (!e) return null;
      const raw = bytes.subarray(e.dataStart, e.dataStart + e.compSize);
      const data = e.method === 0 ? raw : await inflateRaw(raw);
      return decoder.decode(data);
    }

    const workbookText = await readText('xl/workbook.xml');
    if (!workbookText) throw new Error('Excel 文件里找不到工作簿定义');

    const wb = parseXml(workbookText);
    const relText = await readText('xl/_rels/workbook.xml.rels');
    const relMap = {};
    if (relText) {
      const rels = parseXml(relText).getElementsByTagName('Relationship');
      for (let i = 0; i < rels.length; i++) {
        relMap[rels[i].getAttribute('Id')] = rels[i].getAttribute('Target');
      }
    }

    const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const sheetEls = wb.getElementsByTagName('sheet');
    const refs = [];
    for (let i = 0; i < sheetEls.length; i++) {
      const s = sheetEls[i];
      const rid = s.getAttribute('r:id') || s.getAttributeNS(REL_NS, 'id') || '';
      let target = relMap[rid] || '';
      if (target.charAt(0) === '/') target = target.slice(1);
      else if (target) target = 'xl/' + target.replace(/^\.\//, '');
      refs.push({ name: s.getAttribute('name') || ('工作表' + (i + 1)), path: target });
    }

    /* 共享字符串表 */
    const shared = [];
    const ssText = await readText('xl/sharedStrings.xml');
    if (ssText) {
      const sis = parseXml(ssText).getElementsByTagName('si');
      for (let i = 0; i < sis.length; i++) {
        const ts = sis[i].getElementsByTagName('t');
        const parts = [];
        for (let k = 0; k < ts.length; k++) parts.push(ts[k].textContent || '');
        shared.push(parts.join(''));
      }
    }

    const sheets = [];
    for (let i = 0; i < refs.length; i++) {
      if (!refs[i].path) continue;
      const xml = await readText(refs[i].path);
      if (!xml) continue;
      sheets.push({ name: refs[i].name, rows: sheetToRows(parseXml(xml), shared) });
    }
    if (!sheets.length) throw new Error('Excel 文件里没有可读取的工作表');
    return { sheets: sheets };
  };

  global.Xlsx = X;
  if (typeof module !== 'undefined' && module.exports) module.exports = X;
})(typeof window !== 'undefined' ? window : globalThis);