/* ============================================================
   test-android.js - 安卓端纯逻辑测试
   RequestRouting 不依赖任何安卓 API，所以可以直接用电脑上的 JDK
   编译并运行，不需要手机、也不需要模拟器。

   用法： node tools/test-android.js
   ============================================================ */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const JDK = path.join(ROOT, '.buildtools', 'jdk');
const JAVAC = path.join(JDK, 'bin', 'javac.exe');
const JAVA = path.join(JDK, 'bin', 'java.exe');

const PKG_DIR = path.join(ROOT, 'android-src', 'java', 'com', 'daxuesheng', 'jizhangben');
const SOURCES = [
  path.join(PKG_DIR, 'RequestRouting.java'),
  path.join(PKG_DIR, 'DisplayUtils.java'),
  path.join(ROOT, 'tests', 'android', 'HostCheckTest.java')
];

/* 在纯英文目录里编译，避免各种路径问题 */
const WORK = path.join(os.tmpdir(), 'jizhangben-android-test');

function need(p, what) {
  if (!fs.existsSync(p)) {
    throw new Error('缺少' + what + '：' + p + '\n请先运行： node tools/get-buildtools.js');
  }
}

function run(exe, args, opts) {
  const r = spawnSync(exe, args, Object.assign({ stdio: 'inherit' }, opts || {}));
  if (r.error) throw new Error(path.basename(exe) + ' 启动失败：' + r.error.message);
  return r.status;
}

(function main() {
  try {
    need(JAVA, 'JDK');
    need(SOURCES[0], 'RequestRouting.java');
    need(SOURCES[1], 'HostCheckTest.java');

    fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(WORK, { recursive: true });

    // 复制源码到工作目录，保持包结构
    const srcDir = path.join(WORK, 'src', 'com', 'daxuesheng', 'jizhangben');
    fs.mkdirSync(srcDir, { recursive: true });
    SOURCES.forEach((s) => fs.copyFileSync(s, path.join(srcDir, path.basename(s))));

    const outDir = path.join(WORK, 'classes');
    fs.mkdirSync(outDir, { recursive: true });

    const files = SOURCES.map((s) => path.join(srcDir, path.basename(s)));
    let code = run(JAVAC, ['-encoding', 'UTF-8', '-d', outDir].concat(files));
    if (code !== 0) throw new Error('编译失败');

    code = run(JAVA, ['-Dfile.encoding=UTF-8', '-cp', outDir, 'com.daxuesheng.jizhangben.HostCheckTest']);
    fs.rmSync(WORK, { recursive: true, force: true });
    process.exit(code === 0 ? 0 : 1);
  } catch (e) {
    console.error('\n运行失败：' + e.message);
    process.exit(1);
  }
})();