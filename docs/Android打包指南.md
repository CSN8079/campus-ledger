# 安卓打包指南

安装包位置：**`dist/记账本-v1.1.1.apk`**

本项目的安卓版是一个**自带的浏览器外壳**：把 `web/` 目录下的网页应用装进一个
不依赖任何第三方库的原生 WebView 里。整包只有 119 KB，不需要网络，
不使用任何第三方 SDK，也不需要 Gradle。

---

## 一、重新打包（推荐方式）

```bash
npm run apk:tools     # 首次执行：下载 JDK 17 与安卓 SDK 到 .buildtools/（约 400MB）
npm run apk:build     # 打包，产物输出到 dist/
npm run apk:verify    # 校验 APK 结构、资源、dex 与签名
```

打包脚本 `tools/build-apk.js` 的全部动作，不使用 Gradle：

| 步骤 | 使用工具 | 作用 |
| --- | --- | --- |
| 1 | 复制 | 把 `web/` 整体放进 APK 的 `assets/www/` |
| 2 | `aapt2 compile` | 编译 `android-src/res` 里的图标与字符串 |
| 3 | `aapt2 link` | 生成含清单、资源表的基础 APK |
| 4 | `javac` | 编译 `MainActivity.java`（用 android.jar 作为引导类库） |
| 5 | `d8` | 把 class 文件转成 `classes.dex` |
| 6 | 自制 ZIP 工具 | 把网页资源与 dex 写入 APK，保持资源表不压缩 |
| 7 | `zipalign` | 让未压缩条目 4 字节对齐（Android 11+ 的硬性要求） |
| 8 | `apksigner` | 用本地自签名密钥签名（首次打包自动生成，不进仓库） |

### 三个已经踩过的坑

#### 1. 请求路由必须"先判断自己的域名"

应用页面挂在 `https://app.local` 这个内部域名上，由 `shouldInterceptRequest` 从安装包里读取。
如果判断顺序写反、先判断"是不是局域网地址"，`app.local` 会被当成局域网地址放行，
WebView 就会去公网解析这个并不存在的域名 —— 结果打开应用只看到**「网页无法打开」**。

现在路由规则抽到了 `android-src/java/com/daxuesheng/jizhangben/RequestRouting.java`，
它不依赖任何安卓 API，可以直接在电脑上测：

```bash
npm run test:android
```

#### 2. aapt2 不支持中文路径


- **aapt2 不支持中文路径**：`aapt2` 在 Windows 上遇到含中文的路径参数会报
  "failed to open directory"。所以脚本会把所有中间产物放到纯英文的临时目录
  （`%TEMP%\jizhangben-build`）里构建，最后再把成品复制回 `dist/`。
- **aapt2 的 `-A` 参数在 Windows 上会写出反斜杠路径**（如 `assets\www\index.html`），
  这不是合法的 APK 条目名。所以网页资源改由脚本自己写入，路径固定用 `/`。

### 修改应用信息

| 想改什么 | 改哪里 |
| --- | --- |
| 应用名 | `android-src/res/values/strings.xml` 的 `app_name` |
| 包名 | `android-src/AndroidManifest.xml` 的 `package` 与 `android-src/java/...` 目录名 |
| 版本号 | `AndroidManifest.xml` 的 `versionCode` / `versionName`，以及 `tools/build-apk.js` 里的 `APP_VERSION` |
| 图标 | 改 `tools/make-android-icons.js` 后运行 `npm run apk:icons` |
| 启动画面底色、权限 | `AndroidManifest.xml` |

### 签名密钥（重要）

首次执行 `npm run apk:build` 时，脚本会自动生成一个自签名密钥并保存在
`android-src/jizhangben.keystore`（别名和密码都是 `jizhangben`）。

**这个文件不会进入 Git 仓库**（已被 `.gitignore` 排除），请自己妥善保管：

- 安卓要求同一个应用的所有版本用同一个密钥签名，否则新版本**无法覆盖安装**，
  只能先卸载再装（会丢失本地数据）
- 换电脑时，把这个文件手动复制到新电脑的 `android-src/` 目录下
- 只适合自己用，**不要**用它上架应用商店

> 如果你是从 GitHub 克隆的仓库，本地并没有这个密钥文件，
> 首次打包会自动生成一个新的。注意：用新密钥签出来的 APK
> 无法覆盖安装别人签过的版本。

---

## 二、安卓外壳是怎么工作的

源码只有一个文件：`android-src/java/com/daxuesheng/jizhangben/MainActivity.java`

1. 页面通过 `https://app.local/` 这个内部域名加载。
   **必须用 https**：安卓 WebView 在 `file://` 下不允许使用 IndexedDB 和 localStorage，
   而记账数据正需要它们；普通 http 又会被判定为非安全来源。
2. `shouldInterceptRequest` 拦截这个域名下的所有请求，从 APK 的 `assets/www/` 读取文件返回，
   并且**拒绝一切其它域名的请求**，所以应用不会、也无法访问网络。
3. 网页里的文件导入（`<input type="file">`）通过 `onShowFileChooser` 打开系统的文件选择器。
4. 网页里的导出（导出 CSV / 备份 JSON）通过 `AndroidApp.save()` 这个 JS 接口
   交给原生代码，保存到系统的**「下载」**目录。
5. 返回键的行为：先关闭弹出面板 → 再回退页面 → 最后才退出应用。

---

## 三、Capacitor 方案（备选）

如果你想用更常规的方式（比如以后要上架应用商店），项目里也保留了
`capacitor.config.json`，可以改用 Capacitor：

```bash
npm install
npx cap add android
npx cap sync android
npx cap open android      # 用 Android Studio 打开
```

这条路需要联网下载依赖，并且要装 Android Studio（提供 Gradle 与 SDK）。
对本项目来说不是必需的。

---

## 四、常见问题

**Q：安装时提示"未知来源应用"？**
这是安卓对非应用商店安装包的标准提示，选择允许即可。

**Q：为什么安装包只有 119 KB？**
因为没有任何第三方框架，网页应用本身也是手写的原生 JavaScript，
所有代码加起来才 200 KB 左右，压缩后更小。

**Q：支持哪些安卓版本？**
Android 8.0 及以上（minSdk 26，targetSdk 34）。小米 HyperOS、MIUI、
原生安卓、以及各家的定制系统都可以。

**Q：会联网吗？**
不会。外壳拒绝一切非本地请求，网页代码里也没有任何网络调用。
清单里声明了网络权限，只是为了兼容部分机型上 WebView 的初始化行为。

**Q：怎么更新应用？**
改了 `web/` 里的代码后重新执行 `npm run apk:build`，
把新 APK 传到手机上覆盖安装即可（数据会保留）。