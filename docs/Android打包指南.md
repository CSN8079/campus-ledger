# 打包成安卓 APK

应用在本体上是一个**纯静态的离线网页应用**，所以有两种在安卓上使用的方式。

---

## 方式一：添加到主屏幕（推荐，不用打包）

这是最简单的方式，不需要安装任何开发工具。

1. 在电脑上运行 `启动记账本.bat` 或 `node tools/serve.js`
2. 记下命令行打印的局域网地址，例如 `http://192.168.1.7:8788/`
3. 手机连同一个 WiFi，用浏览器打开这个地址
4. 浏览器菜单 → **添加到主屏幕 / 添加到桌面**
5. 桌面出现「记账本」图标

添加到主屏幕后：

- 有自己的图标，从桌面直接启动
- 全屏打开，没有浏览器地址栏
- **断网可用**（Service Worker 缓存了全部资源）
- 数据存在手机本地数据库里

**局限**：首次安装和后续更新需要电脑开着服务。装好之后日常使用不需要。

> 如果想让手机完全独立（不依赖电脑），用方式二打包成 APK，或者把 `web/` 目录
> 传到任意 HTTPS 静态托管上再用方式一安装（有 HTTPS 就能直接安装，无需电脑开着）。

---

## 方式二：打包成原生 APK

用 [Capacitor](https://capacitorjs.com/) 把 `web/` 目录包进一个安卓工程。
项目里已经准备好了 `capacitor.config.json`，只需要下载依赖并打包。

### 前置条件

| 工具 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | 18+ | 已有 |
| JDK | 17 或 21 | Android Gradle 插件要求 |
| Android Studio | 最新版 | 安装时会自带 Android SDK 和 JDK |

其中 **Android Studio 必须装**，它提供 Android SDK；JDK 也可以直接用 Android Studio 自带的。

### 打包步骤

```bash
# 1. 安装依赖（会下载 Capacitor，约 100 MB）
npm install

# 2. 生成安卓工程（只需执行一次）
npx cap add android

# 3. 把 web/ 里的应用同步进安卓工程（每次改完代码都执行）
npx cap sync android

# 4. 打包出 APK
cd android
gradlew.bat assembleDebug
```

打包产物在：

```
android/app/build/outputs/apk/debug/app-debug.apk
```

把这个文件传到手机上安装即可（需要允许"安装未知来源应用"）。

### 用 Android Studio 打开（更省事）

```bash
npx cap open android
```

在 Android Studio 里点绿色三角 Run，插上手机就能直接装到手机上调试；
菜单 `Build → Build Bundle(s) / APK(s) → Build APK(s)` 也能出包。

### 发布版（正式签名、体积更小）

```bash
cd android
gradlew.bat assembleRelease
```

正式发布需要配置签名密钥和 `signingConfigs`，参考
[安卓官方文档](https://developer.android.com/studio/publish/app-signing)。

### 打包后需要改的地方

- **应用名**：`capacitor.config.json` 里的 `appName`
- **包名**：`appId`（必须是合法的 Java 包名，例如 `com.你的名字.jizhangben`）
- **图标**：替换 `android/app/src/main/res/mipmap-*/` 下的图标，
  或运行 `npm run icons` 重新生成 `web/assets/` 里的图标再 `npx cap sync`
- **版本号**：`android/app/build.gradle` 里的 `versionCode` / `versionName`

### 注意事项

- Capacitor 打包后用的是 `https://localhost` 方案，Service Worker 和 IndexedDB 都能正常工作
- 应用本身没有任何网络请求，不需要申请网络权限（Capacitor 默认会加，
  可以在 `AndroidManifest.xml` 里删掉 `android.permission.INTERNET`）
- 数据存在 App 的 WebView 本地存储里，**卸载 App 会一起删除**，请定期导出 JSON 备份

---

## 方式三：其它打包途径

- **TWA（Trusted Web Activity）**：把 HTTPS 托管的 PWA 直接包成 APK，
  体积最小、无需维护安卓工程，适合你已经把应用部署到 HTTPS 上的情况
- **WebView 壳**：写一个十几行的安卓 Activity 加载 `file:///android_asset/index.html`，
  没有 Node 环境也能做，但需要自己用 Android Studio 建工程

---

## 关于运行环境

打包出来的 APK 是一个标准的安卓应用，在 **Android 7.0 及以上** 都能运行，
包括小米 HyperOS 4、MIUI、原生 Android、各家定制系统。
不需要联网、不需要账号、不使用任何第三方 SDK。