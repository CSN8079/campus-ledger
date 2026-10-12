const fs = require('fs');
const path = require('path');
const ROOT = __dirname + '/..';
function load(p) {
  const raw = fs.readFileSync(path.join(ROOT, p), 'utf8');
  const eol = raw.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  return { eol: eol, text: raw.split('\r\n').join('\n') };
}
function save(p, h, text) {
  fs.writeFileSync(path.join(ROOT, p), h.eol === '\n' ? text : text.split('\n').join('\r\n'), 'utf8');
}
function once(p, from, to) {
  const h = load(p);
  const n = h.text.split(from).length - 1;
  if (n !== 1) throw new Error('expect exactly 1 in ' + p + ' (got ' + n + '): ' + from.slice(0, 90));
  save(p, h, h.text.replace(from, () => to));
}

once('web/js/defaults.js', "D.APP_VERSION = '2.1.0';", "D.APP_VERSION = '2.0.2';");
once("web/sw.js", "const CACHE = 'jzb-cache-v2.1.0';", "const CACHE = 'jzb-cache-v2.0.2';");
once('tools/build-apk.js', "const APP_VERSION = '2.1.0';", "const APP_VERSION = '2.0.2';");
once('android-src/AndroidManifest.xml', 'android:versionName="2.1.0"', 'android:versionName="2.0.2"');
once('package.json', '"version": "2.1.0",', '"version": "2.0.2",');
once('README.md', '**安装包位置：`dist/记账本-v2.1.0.apk`**', '**安装包位置：`dist/记账本-v2.0.2.apk`**');
once('docs/使用说明.md', '`dist/记账本-v2.1.0.apk`', '`dist/记账本-v2.0.2.apk`');
once('docs/Android打包指南.md', '`dist/记账本-v2.1.0.apk`', '`dist/记账本-v2.0.2.apk`');
once('README.md', '### v2.1.0 —— 假期不计入统计、报销一次抵多笔、支出走势折线图', '### v2.0.2 —— 假期不计入统计、报销一次抵多笔、支出走势折线图');
console.log('r34 ok');
