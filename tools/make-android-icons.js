/* ============================================================
   make-android-icons.js - 生成安卓 App 图标（复用 make-icons.js 的绘制逻辑）
   输出到 android-src/res/：
     mipmap-<密度>/ic_launcher.png            传统图标（圆角方形）
     mipmap-<密度>/ic_launcher_round.png      圆形图标
     mipmap-<密度>/ic_launcher_foreground.png 自适应图标前景层（透明背景 + 白色 ¥）
   用法： node tools/make-android-icons.js
   ============================================================ */
const fs = require('node:fs');
const path = require('node:path');
const { renderIcon } = require('./make-icons.js');

const ROOT = path.join(__dirname, '..');
const RES = path.join(ROOT, 'android-src', 'res');

/* 密度 -> 图标边长（48dp 基准） */
const DENSITIES = [
  ['mdpi', 1],
  ['hdpi', 1.5],
  ['xhdpi', 2],
  ['xxhdpi', 3],
  ['xxxhdpi', 4]
];

let count = 0;
function write(dir, name, png) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), png);
  count++;
}

DENSITIES.forEach(([density, factor]) => {
  const dir = path.join(RES, 'mipmap-' + density);
  const legacySize = Math.round(48 * factor);
  const fgSize = Math.round(108 * factor); // 自适应图标前景 108dp

  write(dir, 'ic_launcher.png', renderIcon(legacySize, { scale: 1, radius: 112 }));
  write(dir, 'ic_launcher_round.png', renderIcon(legacySize, { scale: 0.92, radius: legacySize / 2 }));
  write(dir, 'ic_launcher_foreground.png', renderIcon(fgSize, { transparent: true, scale: 1, bleed: true }));
});

/* 自适应图标描述文件（Android 8.0+） */
const anydpi = path.join(RES, 'mipmap-anydpi-v26');
const adaptive = '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n' +
  '    <background android:drawable="@color/ic_launcher_background"/>\n' +
  '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n' +
  '</adaptive-icon>\n';
write(anydpi, 'ic_launcher.xml', adaptive);
write(anydpi, 'ic_launcher_round.xml', adaptive);

console.log('已生成 ' + count + ' 个安卓图标文件到 ' + RES);