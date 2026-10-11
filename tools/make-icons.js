/* ============================================================
   make-icons.js - 生成 PWA 图标（零依赖，只用 Node 内置模块）
   用法： node tools/make-icons.js
   ============================================================ */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

/* ---------- PNG 编码 ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------- 图形绘制 ---------- */
const S = 512; // 设计基准尺寸

/* 点到线段的距离 */
function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/* ¥ 字形：五条笔画 */
const STROKES = [
  [140, 130, 256, 250],
  [372, 130, 256, 250],
  [256, 250, 256, 396],
  [170, 292, 342, 292],
  [170, 340, 342, 340]
];

function yuanDistance(x, y) {
  let d = Infinity;
  for (const s of STROKES) d = Math.min(d, distToSeg(x, y, s[0], s[1], s[2], s[3]));
  return d;
}

/* 圆角矩形内部判定 */
function inRoundedRect(x, y, w, h, r) {
  if (x < 0 || y < 0 || x > w || y > h) return false;
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  return Math.hypot(x - cx, y - cy) <= r;
}

function lerp(a, b, t) { return a + (b - a) * t; }

/* 生成图标：scale 控制字形大小，radius 控制圆角（maskable 用 0） */
function render(size, opts) {
  const scale = (opts.scale || 1) * (size / S);
  const off = (size - S * scale) / 2;
  const radius = (opts.radius === undefined ? 112 : opts.radius) * (size / S);
  const half = 23 * scale;           // 笔画半宽
  const SS = 3;                      // 3x3 超采样抗锯齿
  const buf = Buffer.alloc(size * size * 4);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgHits = 0, fgHits = 0, total = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS;
          const y = py + (sy + 0.5) / SS;
          total++;
          if (radius > 0 ? inRoundedRect(x, y, size, size, radius) : true) bgHits++;
          const dx = (x - off) / scale, dy = (y - off) / scale;
          if (dx > -60 && dx < 572 && dy > -60 && dy < 572 && yuanDistance(dx, dy) <= 23) fgHits++;
        }
      }
      const i = (py * size + px) * 4;
      const aBg = bgHits / total;
      const aFg = fgHits / total;

      // 渐变背景：#4f46e5 -> #9d7bff
      const t = Math.min(1, Math.max(0, (px + py) / (2 * size)));
      let r = lerp(79, 157, t), g = lerp(70, 123, t), b = lerp(229, 255, t);
      // 白色 ¥ 覆盖
      r = lerp(r, 255, aFg); g = lerp(g, 255, aFg); b = lerp(b, 255, aFg);

      buf[i] = Math.round(r);
      buf[i + 1] = Math.round(g);
      buf[i + 2] = Math.round(b);
      buf[i + 3] = Math.round(aBg * 255);
    }
  }
  return encodePNG(size, size, buf);
}

const outDir = path.join(__dirname, '..', 'web', 'assets');
fs.mkdirSync(outDir, { recursive: true });

const jobs = [
  ['icon-192.png', 192, { scale: 1, radius: 112 }],
  ['icon-512.png', 512, { scale: 1, radius: 112 }],
  ['icon-maskable-512.png', 512, { scale: 0.68, radius: 0 }],
  ['apple-touch-icon.png', 180, { scale: 1, radius: 0 }]
];

jobs.forEach(([name, size, opts]) => {
  const png = render(size, opts);
  fs.writeFileSync(path.join(outDir, name), png);
  console.log('生成 ' + name + '  ' + size + 'x' + size + '  ' + png.length + ' 字节');
});
console.log('图标输出目录：' + outDir);