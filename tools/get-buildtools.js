/* ============================================================
   get-buildtools.js - 下载打包 APK 所需的工具链（不含任何第三方依赖）
   下载到项目下的 .buildtools/ 目录：
     1. Temurin JDK 17（便携版，解压即用，不写注册表、不改环境变量）
     2. Android 命令行工具（sdkmanager）
   用法： node tools/get-buildtools.js
   ============================================================ */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TOOLS_DIR = path.join(ROOT, '.buildtools');
const CACHE_DIR = path.join(TOOLS_DIR, 'cache');
const JDK_DIR = path.join(TOOLS_DIR, 'jdk');
const SDK_DIR = path.join(TOOLS_DIR, 'android-sdk');

const JDK_URL = 'https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse';
const CMDLINE_URL = 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip';

fs.mkdirSync(CACHE_DIR, { recursive: true });

function human(n) { return (n / 1048576).toFixed(1) + ' MB'; }

async function download(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1024 * 1024) {
    console.log('  已存在，跳过下载：' + path.basename(dest) + '（' + human(fs.statSync(dest).size) + '）');
    return dest;
  }
  console.log('  正在下载：' + path.basename(dest));
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error('下载失败 HTTP ' + res.status + '：' + url);
  const total = Number(res.headers.get('content-length') || 0);
  const out = fs.createWriteStream(dest);
  let got = 0, lastLog = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.write(Buffer.from(value));
    got += value.length;
    const now = Date.now();
    if (now - lastLog > 1500) {
      lastLog = now;
      process.stdout.write('\r    ' + human(got) + (total ? ' / ' + human(total) + '  ' + Math.round((got / total) * 100) + '%' : '') + '    ');
    }
  }
  await new Promise((r) => out.end(r));
  process.stdout.write('\r    完成：' + human(got) + '                    \n');
  return dest;
}

function unzip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    'Expand-Archive -LiteralPath ' + JSON.stringify(zipPath) + ' -DestinationPath ' + JSON.stringify(destDir) + ' -Force'],
    { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('解压失败：' + zipPath);
}

(async () => {
  console.log('工具链目录：' + TOOLS_DIR);

  /* ---------- 1. JDK ---------- */
  console.log('\n[1/3] Temurin JDK 17（便携版）');
  if (fs.existsSync(path.join(JDK_DIR, 'bin', 'javac.exe'))) {
    console.log('  已安装，跳过');
  } else {
    const zip = path.join(CACHE_DIR, 'jdk17.zip');
    await download(JDK_URL, zip);
    const tmp = path.join(TOOLS_DIR, '_jdk_tmp');
    fs.rmSync(tmp, { recursive: true, force: true });
    unzip(zip, tmp);
    // 解压后通常是一层 jdk-17.x.x+x 目录，把它的内容提到 jdk/
    const inner = fs.readdirSync(tmp).map((n) => path.join(tmp, n)).find((p) => fs.statSync(p).isDirectory());
    fs.rmSync(JDK_DIR, { recursive: true, force: true });
    fs.renameSync(inner || tmp, JDK_DIR);
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('  JDK 就绪：' + JDK_DIR);
  }

  /* ---------- 2. Android 命令行工具 ---------- */
  console.log('\n[2/3] Android 命令行工具');
  const cmdlineRoot = path.join(SDK_DIR, 'cmdline-tools', 'latest');
  if (fs.existsSync(path.join(cmdlineRoot, 'bin', 'sdkmanager.bat'))) {
    console.log('  已安装，跳过');
  } else {
    const zip = path.join(CACHE_DIR, 'cmdline-tools.zip');
    await download(CMDLINE_URL, zip);
    const tmp = path.join(TOOLS_DIR, '_cmd_tmp');
    fs.rmSync(tmp, { recursive: true, force: true });
    unzip(zip, tmp);
    fs.mkdirSync(path.join(SDK_DIR, 'cmdline-tools'), { recursive: true });
    fs.rmSync(cmdlineRoot, { recursive: true, force: true });
    fs.renameSync(path.join(tmp, 'cmdline-tools'), cmdlineRoot);
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('  sdkmanager 就绪：' + cmdlineRoot);
  }

  /* ---------- 3. SDK 组件 ---------- */
  console.log('\n[3/3] 安卓 SDK 组件（platform 34 + build-tools 34）');
  const env = Object.assign({}, process.env, {
    JAVA_HOME: JDK_DIR,
    ANDROID_HOME: SDK_DIR,
    ANDROID_SDK_ROOT: SDK_DIR
  });
  // 直接调用 Java 主类，避开 .bat 在带中文路径时的命令行引号问题
  const javaExe = path.join(JDK_DIR, 'bin', 'java.exe');
  const baseArgs = [
    '-Dcom.android.sdklib.toolsdir=' + cmdlineRoot,
    '-classpath', path.join(cmdlineRoot, 'lib', '*'),
    'com.android.sdklib.tool.sdkmanager.SdkManagerCli',
    '--sdk_root=' + SDK_DIR
  ];

  console.log('  接受许可协议…');
  spawnSync(javaExe, baseArgs.concat(['--licenses']),
    { env: env, input: 'y\n'.repeat(80), stdio: ['pipe', 'ignore', 'ignore'] });

  console.log('  安装组件（这一步比较慢，请稍候）…');
  const r = spawnSync(javaExe, baseArgs.concat(['platforms;android-34', 'build-tools;34.0.0']),
    { env: env, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('SDK 组件安装失败');

  const aapt2 = path.join(SDK_DIR, 'build-tools', '34.0.0', 'aapt2.exe');
  const androidJar = path.join(SDK_DIR, 'platforms', 'android-34', 'android.jar');
  console.log('\n工具链准备完成：');
  console.log('  JDK      : ' + path.join(JDK_DIR, 'bin', 'javac.exe') + '  ' + (fs.existsSync(path.join(JDK_DIR, 'bin', 'javac.exe')) ? 'OK' : '缺失'));
  console.log('  aapt2    : ' + aapt2 + '  ' + (fs.existsSync(aapt2) ? 'OK' : '缺失'));
  console.log('  android.jar: ' + androidJar + '  ' + (fs.existsSync(androidJar) ? 'OK' : '缺失'));
})().catch((e) => {
  console.error('\n失败：' + e.message);
  process.exit(1);
});