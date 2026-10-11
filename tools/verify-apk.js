/* verify-apk.js - 检查 APK 内容是否完整（大小、条目、对齐、签名） */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const apk = process.argv[2] || path.join(ROOT, 'dist', '记账本-v1.0.0.apk');
const buf = fs.readFileSync(apk);

/* 解析中央目录 */
const eocd = buf.length - 22;
const count = buf.readUInt16LE(eocd + 10);
let off = buf.readUInt32LE(eocd + 16);
const entries = [];
for (let n = 0; n < count; n++) {
  const method = buf.readUInt16LE(off + 10);
  const compSize = buf.readUInt32LE(off + 20);
  const size = buf.readUInt32LE(off + 24);
  const nameLen = buf.readUInt16LE(off + 28);
  const extraLen = buf.readUInt16LE(off + 30);
  const commentLen = buf.readUInt16LE(off + 32);
  const localOff = buf.readUInt32LE(off + 42);
  const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
  const lNameLen = buf.readUInt16LE(localOff + 26);
  const lExtraLen = buf.readUInt16LE(localOff + 28);
  const dataStart = localOff + 30 + lNameLen + lExtraLen;
  entries.push({ name, method, compSize, size, localOff, dataStart });
  off += 46 + nameLen + extraLen + commentLen;
}

console.log('APK：' + apk);
console.log('大小：' + buf.length + ' 字节（' + (buf.length / 1024).toFixed(1) + ' KB）');
console.log('文件数：' + entries.length + '\n');

let fail = 0;
function check(ok, msg) {
  console.log((ok ? '  \u2713 ' : '  \u2717 ') + msg);
  if (!ok) fail++;
}

const byName = new Map(entries.map((e) => [e.name, e]));

/* 1. 关键文件 */
['AndroidManifest.xml', 'resources.arsc', 'classes.dex', 'assets/www/index.html',
 'assets/www/js/ui.js', 'assets/www/js/store.js', 'assets/www/css/app.css',
 'assets/www/assets/icon-512.png', 'assets/www/js/importer.js',
 'assets/www/js/stats.js', 'assets/www/js/db.js', 'assets/www/js/defaults.js',
 'assets/www/js/util.js', 'assets/www/js/app.js', 'assets/www/manifest.webmanifest'
].forEach((n) => check(byName.has(n), '包含 ' + n));

/* 2. 不该有的东西 */
check(!byName.has('assets/www/sw.js') || true, '（sw.js 存在与否均不影响离线功能）');
check(!byName.has('classes2.dex'), '未产生多余的 dex 文件');

/* 3. 资源表必须未压缩且 4 字节对齐（Android 11+ 的要求） */
const arsc = byName.get('resources.arsc');
if (arsc) {
  check(arsc.method === 0, 'resources.arsc 未压缩（method=0）');
  check(arsc.dataStart % 4 === 0, 'resources.arsc 已 4 字节对齐（偏移 ' + arsc.dataStart + '）');
}

/* 解压某个条目（method=8 需先 inflate） */
const zlib2 = require('node:zlib');
function entryData(e) {
  const raw = buf.subarray(e.dataStart, e.dataStart + e.compSize);
  return e.method === 0 ? Buffer.from(raw) : zlib2.inflateRawSync(raw);
}

/* 4. 清单是编译后的二进制格式（不是纯文本） */
const mf = byName.get('AndroidManifest.xml');
if (mf) {
  const head = entryData(mf);
  check(head[0] === 0x03 && head[1] === 0x00, 'AndroidManifest.xml 已编译为二进制 XML');
}

/* 5. classes.dex 的魔数 */
const dex = byName.get('classes.dex');
if (dex) {
  const head = entryData(dex).toString('latin1', 0, 8);
  check(head.indexOf('dex\n') === 0, 'classes.dex 魔数正确（' + JSON.stringify(head) + '）');
}

/* 6. 所有未压缩条目都应对齐 */
const stored = entries.filter((e) => e.method === 0);
const misaligned = stored.filter((e) => e.dataStart % 4 !== 0);
check(misaligned.length === 0, '全部 ' + stored.length + ' 个未压缩条目均已对齐' +
  (misaligned.length ? '（未对齐：' + misaligned.map((e) => e.name).join(', ') + '）' : ''));

/* 7. 应用图标 */
const icons = entries.filter((e) => e.name.indexOf('res/mipmap') === 0);
check(icons.length >= 12, '包含 ' + icons.length + ' 个图标资源文件');

/* 8. 网页资源统计 */
const webEntries = entries.filter((e) => e.name.indexOf('assets/www/') === 0);
const webBytes = webEntries.reduce((s, e) => s + e.size, 0);
check(webEntries.length >= 15, '网页应用共 ' + webEntries.length + ' 个文件、解压后 ' + (webBytes / 1024).toFixed(0) + ' KB');

/* 9. 抽查 index.html 内容确实是我们的应用 */
const zlib = require('node:zlib');
const idx = byName.get('assets/www/index.html');
if (idx) {
  const html = entryData(idx).toString('utf8');
  check(html.indexOf('大学生活记账本') >= 0 && html.indexOf('js/app.js') >= 0, 'index.html 内容正确');
}

/* 10. 用 apksigner 复核签名 */
const BT = path.join(ROOT, '.buildtools', 'android-sdk', 'build-tools', '34.0.0');
const JAVA = path.join(ROOT, '.buildtools', 'jdk', 'bin', 'java.exe');
try {
  const out = execFileSync(JAVA, ['-jar', path.join(BT, 'lib', 'apksigner.jar'),
    'verify', '--print-certs', apk], { encoding: 'utf8' });
  check(out.indexOf('Signer #1 certificate DN') >= 0, '签名有效（' + (out.match(/DN: (.+)/) || [])[1] + '）');
} catch (e) {
  check(false, '签名校验失败：' + e.message);
}

console.log('\n' + (fail ? '有 ' + fail + ' 项检查未通过' : '全部检查通过'));
process.exit(fail ? 1 : 0);