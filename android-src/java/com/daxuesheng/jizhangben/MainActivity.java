package com.daxuesheng.jizhangben;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
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
 * 设计要点：
 *  1. 页面资源全部打包在 APK 的 assets/www 里，通过一个假的 https 域名
 *     (https://app.local) 提供，使 WebView 认为它是安全来源，
 *     这样 IndexedDB、localStorage 等本地存储才能正常工作（file:// 不行）。
 *  2. 所有请求都在 shouldInterceptRequest 里拦截并从 assets 读取，
 *     任何外部网址都会被拒绝，因此应用不需要也不会使用网络。
 *  3. 不依赖任何第三方库（没有 androidx / Capacitor），只用系统自带 API。
 */
public class MainActivity extends Activity {

    private static final String HOST = "app.local";
    private static final int REQ_FILE = 1001;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        web = new WebView(this);
        setContentView(web);

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
            // 页面本身走 https://app.local，但要能和电脑上的 http 服务通信（同步数据），
            // 因此必须允许混合内容。外部公网地址在请求拦截里仍会被拒绝。
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
                if (u == null) return blocked();

                // 局域网地址：放行给系统正常请求，用于和电脑上的服务同步数据
                if (isPrivateHost(u.getHost())) return null;

                // 应用自身的域名：从安装包里读取页面资源
                if (!HOST.equals(u.getHost())) return blocked();
                String path = u.getPath();
                if (path == null || path.length() == 0 || "/".equals(path)) {
                    path = "/index.html";
                }
                // 防止路径穿越
                if (path.contains("..")) {
                    return new WebResourceResponse("text/plain", "utf-8", 400, "Bad Request",
                            new HashMap<String, String>(),
                            new ByteArrayInputStream("bad path".getBytes()));
                }
                String asset = "www" + path;
                try {
                    InputStream in = getAssets().open(asset);
                    Map<String, String> headers = new HashMap<String, String>();
                    headers.put("Cache-Control", "no-cache");
                    return new WebResourceResponse(mimeOf(asset), null, 200, "OK", headers, in);
                } catch (IOException e) {
                    if (path.indexOf('.') < 0) {
                        // 无扩展名的路径按单页应用处理
                        try {
                            InputStream in2 = getAssets().open("www/index.html");
                            return new WebResourceResponse("text/html", "utf-8", 200, "OK",
                                    new HashMap<String, String>(), in2);
                        } catch (IOException ignore) {
                            // 落到下面的 404
                        }
                    }
                    return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                            new HashMap<String, String>(),
                            new ByteArrayInputStream("not found".getBytes()));
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (u != null && HOST.equals(u.getHost())) return false;
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
            web.loadUrl("https://" + HOST + "/index.html");
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

    /** 返回键：先关弹层，再回退页面，最后才退出应用 */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        web.evaluateJavascript(
                "(function(){try{if(window.UI&&window.UI.closePickerLayer&&document.querySelector('#pickerRoot.is-open')){UI.closePickerLayer();return 'sheet';}if(window.UI&&document.querySelector('#sheetRoot.is-open')){UI.closeSheet();return 'sheet';}}catch(e){}return 'none';})()",
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
        @JavascriptInterface
        public void save(String filename, String base64) {
            String safe = (filename == null || filename.length() == 0) ? "jizhangben.txt" : filename;
            safe = safe.replaceAll("[\\\\/:*?\"<>|]", "_");
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.Downloads.DISPLAY_NAME, safe);
                    cv.put(MediaStore.Downloads.MIME_TYPE, mimeOf(safe));
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

    /* 拒绝访问的响应 */
    private static WebResourceResponse blocked() {
        return new WebResourceResponse("text/plain", "utf-8", 403, "Forbidden",
                new HashMap<String, String>(),
                new ByteArrayInputStream("blocked".getBytes()));
    }

    /* 判断是不是局域网 / 本机地址（只有这些地址才允许真正联网） */
    private static boolean isPrivateHost(String host) {
        if (host == null || host.length() == 0) return false;
        if ("localhost".equals(host) || "127.0.0.1".equals(host) || "::1".equals(host)) return true;
        if (host.endsWith(".local")) return true;
        String[] p = host.split("\\.");
        if (p.length == 4) {
            try {
                int a = Integer.parseInt(p[0]);
                int b = Integer.parseInt(p[1]);
                Integer.parseInt(p[2]);
                Integer.parseInt(p[3]);
                if (a == 10) return true;
                if (a == 192 && b == 168) return true;
                if (a == 172 && b >= 16 && b <= 31) return true;
            } catch (NumberFormatException ignore) {
                return false;
            }
        }
        return false;
    }

    private static String mimeOf(String name) {
        String n = name.toLowerCase();
        if (n.endsWith(".html")) return "text/html";
        if (n.endsWith(".js")) return "text/javascript";
        if (n.endsWith(".css")) return "text/css";
        if (n.endsWith(".json")) return "application/json";
        if (n.endsWith(".webmanifest")) return "application/manifest+json";
        if (n.endsWith(".svg")) return "image/svg+xml";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".csv")) return "text/csv";
        if (n.endsWith(".txt")) return "text/plain";
        if (n.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }
}