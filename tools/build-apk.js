/* ============================================================
   build-apk.js - 打包安卓 APK（不需要 Gradle、不需要联网）

   流程：aapt2 编译资源 -> aapt2 链接出基础 APK -> javac 编译 Java
        -> d8 转成 classes.dex -> 合入 APK -> zipalign 对齐
        -> apksigner 签名 -> 校验 -> 复制到 dist/

   注意：aapt2 在 Windows 上无法处理含中文的路径参数，
        因此所有中间产物都放在纯英文的临时目录里构建，
        最后再把成品 APK 复制回项目的 dist/ 目录。

   用法： node tools/build-apk.js
   ============================================================ */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readZip, writeZip } = require('./ziplib.js');

const ROOT = path.join(__dirname, '..');
const TOOLS = path.join(ROOT, '.buildtools');
const JDK = path.join(TOOLS, 'jdk');
const SDK = path.join(TOOLS, 'android-sdk');
const BT = path.join(SDK, 'build-tools', '34.0.0');

const JAVA = path.join(JDK, 'bin', 'java.exe');
const JAVAC = path.join(JDK, 'bin', 'javac.exe');
const KEYTOOL = path.join(JDK, 'bin', 'keytool.exe');
const AAPT2 = path.join(BT, 'aapt2.exe');
const ZIPALIGN = path.join(BT, 'zipalign.exe');
const D8_JAR = path.join(BT, 'lib', 'd8.jar');
const APKSIGNER_JAR = path.join(BT, 'lib', 'apksigner.jar');
const ANDROID_JAR = path.join(SDK, 'platforms', 'android-34', 'android.jar');

const SRC = path.join(ROOT, 'android-src');
const WEB = path.join(ROOT, 'web');
const DIST = path.join(ROOT, 'dist');
const KEYSTORE_STORE = path.join(SRC, 'jizhangben.keystore');

const APP_VERSION = '2.0.2';
const APK_NAME = '记账本-v' + APP_VERSION + '.apk';
const KS_PASS = 'jizhangben';
const KS_ALIAS = 'jizhangben';
const MIN_SDK = '26';
const TARGET_SDK = '34';

/* 选一个纯英文的构建目录 */
function pickWorkDir() {
  const candidates = [path.join(os.tmpdir(), 'jizhangben-build'),
    path.join(process.env.SystemDrive || 'C:', 'jizhangben-build')];
  for (const c of candidates) {
    if (/^[\x20-\x7e\\/:]+$/.test(c)) return c;   // 只接受纯 ASCII 路径
  }
  throw new Error('找不到可用的纯英文构建目录');
}
const WORK = pickWorkDir();

let step = 0;
function title(t) { console.log('\n[' + (++step) + '] ' + t); }

function run(exe, args, opts) {
  const r = spawnSync(exe, args, Object.assign({ stdio: 'inherit' }, opts || {}));
  if (r.error) throw new Error(path.basename(exe) + ' 启动失败：' + r.error.message);
  if (r.status !== 0) throw new Error(path.basename(exe) + ' 执行失败（退出码 ' + r.status + '）');
  return r;
}

function walk(dir, ext, out) {
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir).forEach((n) => {
    const p = path.join(dir, n);
    if (fs.statSync(p).isDirectory()) walk(p, ext, out);
    else if (!ext || p.toLowerCase().endsWith(ext)) out.push(p);
  });
  return out;
}

function need(p, what) {
  if (!fs.existsSync(p)) {
    throw new Error('缺少' + what + '：' + p + '\n请先运行： node tools/get-buildtools.js');
  }
}

const copier = (from, to) => fs.cpSync(from, to, { recursive: true, force: true });

function build() {
  console.log('大学生活记账本 - APK 打包');
  console.log('项目目录：' + ROOT);
  console.log('构建目录：' + WORK + '（纯英文路径）');

  title('检查工具链');
  need(JAVA, 'JDK'); need(AAPT2, 'aapt2'); need(ANDROID_JAR, 'android.jar');
  need(D8_JAR, 'd8.jar'); need(APKSIGNER_JAR, 'apksigner.jar');
  console.log('  JDK、aapt2、android.jar、d8、apksigner 均已就绪');

  title('准备构建目录');
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(path.join(WORK, 'src'), { recursive: true });
  fs.mkdirSync(path.join(WORK, 'classes'), { recursive: true });
  fs.mkdirSync(DIST, { recursive: true });

  copier(path.join(SRC, 'res'), path.join(WORK, 'src', 'res'));
  fs.copyFileSync(path.join(SRC, 'AndroidManifest.xml'), path.join(WORK, 'src', 'AndroidManifest.xml'));
  copier(path.join(SRC, 'java'), path.join(WORK, 'src', 'java'));
  copier(WEB, path.join(WORK, 'assets', 'www'));
  if (!fs.existsSync(path.join(WORK, 'android.jar'))) fs.copyFileSync(ANDROID_JAR, path.join(WORK, 'android.jar'));

  console.log('  网页应用：' + walk(path.join(WORK, 'assets', 'www')).length + ' 个文件');
  console.log('  图标资源：' + walk(path.join(WORK, 'src', 'res')).length + ' 个文件');

  title('生成应用图标（如缺失）');
  if (!fs.existsSync(path.join(SRC, 'res', 'mipmap-xxxhdpi', 'ic_launcher.png'))) {
    run(process.execPath, [path.join(ROOT, 'tools', 'make-android-icons.js')]);
    copier(path.join(SRC, 'res'), path.join(WORK, 'src', 'res'));
  } else {
    console.log('  图标已存在，跳过');
  }

  title('aapt2 编译资源');
  const resZip = path.join(WORK, 'res.zip');
  run(AAPT2, ['compile', '--dir', path.join(WORK, 'src', 'res'), '-o', resZip]);

  title('aapt2 链接生成基础 APK');
  const unsignedApk = path.join(WORK, 'app-unsigned.apk');
  // 注意：编译好的资源要以「位置参数」传入，用 -R 会被当成覆盖层而报错
  run(AAPT2, [
    'link',
    '-o', unsignedApk,
    '-I', path.join(WORK, 'android.jar'),
    '--manifest', path.join(WORK, 'src', 'AndroidManifest.xml'),
    '--java', path.join(WORK, 'gen'),
    '--min-sdk-version', MIN_SDK,
    '--target-sdk-version', TARGET_SDK,
    resZip
  ]);

  title('javac 编译 Java 源码');
  const javaFiles = walk(path.join(WORK, 'src', 'java'), '.java')
    .concat(walk(path.join(WORK, 'gen'), '.java'));
  console.log('  待编译源文件：' + javaFiles.length + ' 个');
  const argFile = path.join(WORK, 'javac-args.txt');
  fs.writeFileSync(argFile, javaFiles.map((f) => '"' + f.replace(/\\/g, '/') + '"').join('\n'), 'utf8');
  run(JAVAC, ['-source', '8', '-target', '8', '-encoding', 'UTF-8',
    '-bootclasspath', path.join(WORK, 'android.jar'),
    '-cp', path.join(WORK, 'android.jar'),
    '-d', path.join(WORK, 'classes'), '-nowarn', '@' + argFile]);

  title('d8 转换出 classes.dex');
  const classFiles = walk(path.join(WORK, 'classes'), '.class');
  console.log('  待转换 class：' + classFiles.length + ' 个');
  const dexDir = path.join(WORK, 'dex');
  fs.mkdirSync(dexDir, { recursive: true });
  run(JAVA, ['-cp', D8_JAR, 'com.android.tools.r8.D8',
    '--lib', path.join(WORK, 'android.jar'), '--min-api', MIN_SDK,
    '--output', dexDir].concat(classFiles));
  const dexFile = path.join(dexDir, 'classes.dex');
  need(dexFile, 'classes.dex');
  console.log('  classes.dex：' + fs.statSync(dexFile).size + ' 字节');

  title('写入网页资源与 classes.dex');
  // aapt2 在 Windows 上给出的资源路径可能带反斜杠，统一成 APK 规范要求的正斜杠
  const entries = readZip(fs.readFileSync(unsignedApk))
    .filter((e) => e.name !== 'classes.dex')
    .map((e) => ({ name: e.name.replace(/\\/g, '/'), data: e.data, store: e.store }));

  // 网页应用：自己遍历目录写入，保证路径分隔符一定是 /
  const assetRoot = path.join(WORK, 'assets');
  let assetCount = 0;
  (function walkAssets(dir, rel) {
    fs.readdirSync(dir).forEach((n) => {
      const full = path.join(dir, n);
      const r = rel ? rel + '/' + n : n;
      if (fs.statSync(full).isDirectory()) walkAssets(full, r);
      else {
        entries.push({ name: 'assets/' + r, data: fs.readFileSync(full), store: false });
        assetCount++;
      }
    });
  })(assetRoot, '');

  entries.push({ name: 'classes.dex', data: fs.readFileSync(dexFile), store: false });

  const withDex = path.join(WORK, 'app-with-dex.apk');
  fs.writeFileSync(withDex, writeZip(entries));
  console.log('  网页资源 ' + assetCount + ' 个文件 + classes.dex，APK 条目共 ' + entries.length + ' 个');

  title('zipalign 对齐');
  const alignedApk = path.join(WORK, 'app-aligned.apk');
  run(ZIPALIGN, ['-f', '-p', '4', withDex, alignedApk]);

  title('准备签名密钥');
  const ks = path.join(WORK, 'jizhangben.keystore');
  if (fs.existsSync(KEYSTORE_STORE)) {
    fs.copyFileSync(KEYSTORE_STORE, ks);
    console.log('  复用已有密钥：' + path.relative(ROOT, KEYSTORE_STORE));
  } else {
    console.log('  首次打包，生成自签名密钥…');
    run(KEYTOOL, ['-genkeypair', '-v', '-keystore', ks, '-storetype', 'PKCS12',
      '-storepass', KS_PASS, '-keypass', KS_PASS, '-alias', KS_ALIAS,
      '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
      '-dname', 'CN=Jizhangben, OU=Personal, O=Personal, C=CN']);
    fs.copyFileSync(ks, KEYSTORE_STORE);
  }

  title('apksigner 签名');
  const signedApk = path.join(WORK, 'app-signed.apk');
  run(JAVA, ['-jar', APKSIGNER_JAR, 'sign',
    '--ks', ks, '--ks-key-alias', KS_ALIAS,
    '--ks-pass', 'pass:' + KS_PASS, '--key-pass', 'pass:' + KS_PASS,
    '--v1-signing-enabled', 'true', '--v2-signing-enabled', 'true',
    '--out', signedApk, alignedApk]);

  title('校验签名');
  run(JAVA, ['-jar', APKSIGNER_JAR, 'verify', '--verbose', signedApk]);

  title('检查 APK 信息');
  run(AAPT2, ['dump', 'badging', signedApk]);

  title('复制到项目 dist 目录');
  const finalApk = path.join(DIST, APK_NAME);
  fs.copyFileSync(signedApk, finalApk);
  const size = fs.statSync(finalApk).size;

  console.log('\n' + '='.repeat(58));
  console.log('  打包成功！');
  console.log('  APK 文件：' + finalApk);
  console.log('  文件大小：' + (size / 1048576).toFixed(2) + ' MB（' + size + ' 字节）');
  console.log('  支持系统：Android 8.0 及以上（含小米 HyperOS 4）');
  console.log('='.repeat(58));
}

try {
  build();
} catch (e) {
  console.error('\n打包失败：' + e.message);
  process.exit(1);
}