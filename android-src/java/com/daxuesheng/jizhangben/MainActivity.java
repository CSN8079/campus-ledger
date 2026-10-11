package com.daxuesheng.jizhangben;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * 大学生活记账本 —— 安卓外壳
 *
 * 这是一个**完全独立**的应用：
 *   - 所有页面资源都打包在 APK 里，通过内部域名 https://app.local 提供
 *     （必须用 https，否则安卓 WebView 下 IndexedDB / localStorage 不可用）
 *   - 所有数据都存在手机本地，不联网也能完整使用
 *   - 只有在用户主动去「设置 → 与电脑同步」里填了电脑地址之后，
 *     才会访问局域网里的电脑；公网地址一律被拦截
 *
 * 请求的路由规则见 RequestRouting（纯逻辑，有单元测试）。
 */
public class MainActivity extends Activity {

    private static final int REQ_FILE = 1001;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        web = new WebView(this);
        setContentView(web);

        /* 让内容铺满整块屏幕，系统栏（状态栏 / 全面屏手势条）设为透明，
           这样深色模式下底部就不会再出现一条突兀的白色手势条。
           系统栏占用的高度会通过 --safe-t-native / --safe-b-native 传给网页，
           由网页自己留出安全边距。 */
        setupSystemBars();

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            // 页面走 https://app.local，但要能和电脑上的 http 服务通信（同步数据），
            // 因此允许混合内容；公网地址在请求路由里仍会被拒绝。
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        boolean night = (getResources().getConfiguration().uiMode
                & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        web.setBackgroundColor(night ? 0xFF0E1016 : 0xFFF3F4FB);

        web.addJavascriptInterface(new Saver(), "AndroidApp");

        web.setWebViewClient(new WebViewClient() {

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                int route = RequestRouting.routeFor(u == null ? null : u.getHost());

                if (route == RequestRouting.ROUTE_BLOCK) return blocked();
                if (route == RequestRouting.ROUTE_PASSTHROUGH) return null;   // 局域网：交给系统

                // 走到这里说明是应用自己的页面资源，从安装包里读
                String path = u.getPath();
                if (path == null || path.length() == 0 || "/".equals(path)) path = "/index.html";
                if (path.contains("..")) return textResponse(404, "Not Found", "bad path");

                String asset = "www" + path;
                try {
                    InputStream in = getAssets().open(asset);
                    Map<String, String> headers = new HashMap<String, String>();
                    headers.put("Cache-Control", "no-cache");
                    return new WebResourceResponse(RequestRouting.mimeOf(asset), null, 200, "OK", headers, in);
                } catch (IOException e) {
                    if (path.indexOf('.') < 0) {
                        // 没有扩展名的路径按单页应用处理
                        try {
                            InputStream in2 = getAssets().open("www/index.html");
                            return new WebResourceResponse("text/html", "utf-8", 200, "OK",
                                    new HashMap<String, String>(), in2);
                        } catch (IOException ignore) {
                            // 落到下面的 404
                        }
                    }
                    return textResponse(404, "Not Found", "not found");
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // 页面重新加载后，之前写进去的变量会丢，这里再推一次
                pushInsets(insetTopPx, insetBottomPx);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (u != null && RequestRouting.HOST.equals(u.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignore) {
                    // 没有可处理的外部应用，忽略
                }
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb,
                                             FileChooserParams params) {
                if (fileCallback != null) {
                    fileCallback.onReceiveValue(null);
                }
                fileCallback = cb;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                try {
                    startActivityForResult(Intent.createChooser(intent, "选择账单文件"), REQ_FILE);
                    return true;
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
            }
        });

        if (state == null) {
            web.loadUrl("https://" + RequestRouting.HOST + "/index.html");
        } else {
            web.restoreState(state);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getData() != null) {
                    result = new Uri[]{ data.getData() };
                } else if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    result = new Uri[n];
                    for (int i = 0; i < n; i++) {
                        result[i] = data.getClipData().getItemAt(i).getUri();
                    }
                }
            }
            if (fileCallback != null) {
                fileCallback.onReceiveValue(result);
                fileCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    /** 返回键：先关弹层（含日期选择浮层），再回退页面，最后才退出应用 */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        web.evaluateJavascript(
                "(function(){try{"
                        + "if(window.UI&&window.UI.closePickerLayer&&document.querySelector('#pickerRoot.is-open')){UI.closePickerLayer();return 'sheet';}"
                        + "if(window.UI&&document.querySelector('#sheetRoot.is-open')){UI.closeSheet();return 'sheet';}"
                        + "}catch(e){}return 'none';})()",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        if (value != null && value.indexOf("sheet") >= 0) return;
                        if (web.canGoBack()) web.goBack();
                        else finish();
                    }
                });
    }

    /* ---------------- 导出文件保存到「下载」目录 ---------------- */

    public class Saver {

        /** 网页切换深色/浅色时告诉原生，好调整系统栏图标的颜色 */
        @JavascriptInterface
        public void setDark(final boolean dark) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    applyBarAppearance(dark);
                }
            });
        }

        @JavascriptInterface
        public void save(String filename, String base64) {
            String safe = (filename == null || filename.length() == 0) ? "jizhangben.txt" : filename;
            safe = safe.replaceAll("[\\\\/:*?\"<>|]", "_");
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.Downloads.DISPLAY_NAME, safe);
                    cv.put(MediaStore.Downloads.MIME_TYPE, RequestRouting.mimeOf(safe));
                    cv.put(MediaStore.Downloads.IS_PENDING, 1);
                    Uri uri = getContentResolver()
                            .insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                    if (uri == null) throw new IOException("无法创建文件");
                    OutputStream os = getContentResolver().openOutputStream(uri);
                    os.write(bytes);
                    os.flush();
                    os.close();
                    cv.clear();
                    cv.put(MediaStore.Downloads.IS_PENDING, 0);
                    getContentResolver().update(uri, cv, null, null);
                    toast("已保存到「下载」目录：" + safe);
                } else {
                    File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                    if (dir == null) dir = getFilesDir();
                    if (!dir.exists()) dir.mkdirs();
                    File out = new File(dir, safe);
                    FileOutputStream fos = new FileOutputStream(out);
                    fos.write(bytes);
                    fos.flush();
                    fos.close();
                    toast("已保存：" + out.getAbsolutePath());
                }
            } catch (Exception e) {
                toast("保存失败：" + e.getMessage());
            }
        }
    }

    private void toast(final String msg) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                Toast.makeText(MainActivity.this, msg, Toast.LENGTH_LONG).show();
            }
        });
    }

    /* ---------------- 系统栏 ---------------- */

    /* 保存的是物理像素，推送时再换算成 CSS 像素 */
    private int insetTopPx = 0;
    private int insetBottomPx = 0;

    private void setupSystemBars() {
        Window window = getWindow();
        if (window == null) return;

        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setStatusBarContrastEnforced(false);
            window.setNavigationBarContrastEnforced(false);
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false);
        } else {
            window.getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
        }

        // 系统栏的实测高度交给网页，网页据此留出安全边距
        window.getDecorView().setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override
            public WindowInsets onApplyWindowInsets(View v, WindowInsets insets) {
                pushInsets(insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetBottom());
                return insets.consumeSystemWindowInsets();
            }
        });

        boolean night = (getResources().getConfiguration().uiMode
                & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        applyBarAppearance(night);
    }

    /** 把系统栏的实测高度（物理像素）换算成 CSS 像素后交给网页 */
    private void pushInsets(final int topPx, final int bottomPx) {
        insetTopPx = topPx;
        insetBottomPx = bottomPx;

        float density = getResources().getDisplayMetrics().density;
        final int top = DisplayUtils.physicalToCss(topPx, density);
        final int bottom = DisplayUtils.physicalToCss(bottomPx, density);

        final String js = "(function(){var s=document.documentElement.style;"
                + "s.setProperty('--safe-t-native','" + top + "px');"
                + "s.setProperty('--safe-b-native','" + bottom + "px');})()";
        web.post(new Runnable() {
            @Override
            public void run() {
                web.evaluateJavascript(js, null);
            }
        });
    }

    /** 系统栏透明后，图标颜色要跟着页面主题走，否则会看不清 */
    private void applyBarAppearance(boolean dark) {
        Window window = getWindow();
        if (window == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController c = window.getInsetsController();
            if (c != null) {
                int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                        | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                c.setSystemBarsAppearance(dark ? 0 : mask, mask);
            }
            return;
        }

        View decor = window.getDecorView();
        int flags = decor.getSystemUiVisibility();
        int light = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            light |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        }
        if (dark) flags &= ~light;
        else flags |= light;
        decor.setSystemUiVisibility(flags
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
    }

    /* 拒绝访问的响应 */
    private static WebResourceResponse blocked() {
        return textResponse(403, "Forbidden", "blocked");
    }

    private static WebResourceResponse textResponse(int code, String reason, String body) {
        return new WebResourceResponse("text/plain", "utf-8", code, reason,
                new HashMap<String, String>(), new ByteArrayInputStream(body.getBytes()));
    }
}