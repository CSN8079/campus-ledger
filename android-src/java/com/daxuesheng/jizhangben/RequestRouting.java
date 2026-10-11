package com.daxuesheng.jizhangben;

/**
 * 请求路由规则。
 *
 * 这个类**不依赖任何安卓 API**，全是纯字符串判断，
 * 所以可以直接在电脑的 JVM 上编译运行、写单元测试（见 tests/android/HostCheckTest.java）。
 *
 * 曾经踩过的坑：如果先判断「是不是局域网地址」，应用自己的域名 app.local
 * 会被当成局域网地址放行，WebView 就会去公网解析这个并不存在的域名，
 * 结果页面直接打不开。所以这里的判断顺序是：先自己的域名，再局域网，最后拒绝。
 */
final class RequestRouting {

    /** 应用页面使用的内部域名（同时也是 WebView 认为的安全来源） */
    static final String HOST = "app.local";

    static final int ROUTE_ASSETS = 0;        // 从安装包里读取页面资源
    static final int ROUTE_PASSTHROUGH = 1;   // 交给系统真正发起请求（局域网，用于同步）
    static final int ROUTE_BLOCK = 2;         // 一律拒绝

    private RequestRouting() { }

    /** 决定一个请求该怎么处理。host 为请求的主机名。 */
    static int routeFor(String host) {
        if (host == null || host.length() == 0) return ROUTE_BLOCK;
        if (HOST.equals(host)) return ROUTE_ASSETS;
        if (isPrivateHost(host)) return ROUTE_PASSTHROUGH;
        return ROUTE_BLOCK;
    }

    /** 是不是局域网 / 本机地址：只有这些地址才允许真正联网（用于与电脑同步数据） */
    static boolean isPrivateHost(String host) {
        if (host == null || host.length() == 0) return false;
        if ("localhost".equals(host) || "127.0.0.1".equals(host) || "::1".equals(host)) return true;
        String[] p = host.split("\\.");
        if (p.length != 4) return false;
        try {
            int a = Integer.parseInt(p[0]);
            int b = Integer.parseInt(p[1]);
            int c = Integer.parseInt(p[2]);
            int d = Integer.parseInt(p[3]);
            if (a < 0 || a > 255 || b < 0 || b > 255 || c < 0 || c > 255 || d < 0 || d > 255) return false;
            if (a == 10) return true;
            if (a == 192 && b == 168) return true;
            if (a == 172 && b >= 16 && b <= 31) return true;
        } catch (NumberFormatException e) {
            return false;
        }
        return false;
    }

    /** 根据文件扩展名给出 MIME 类型 */
    static String mimeOf(String name) {
        String n = name == null ? "" : name.toLowerCase();
        if (n.endsWith(".html") || n.endsWith(".htm")) return "text/html";
        if (n.endsWith(".js") || n.endsWith(".mjs")) return "text/javascript";
        if (n.endsWith(".css")) return "text/css";
        if (n.endsWith(".json")) return "application/json";
        if (n.endsWith(".webmanifest")) return "application/manifest+json";
        if (n.endsWith(".svg")) return "image/svg+xml";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".ico")) return "image/x-icon";
        if (n.endsWith(".csv")) return "text/csv";
        if (n.endsWith(".txt")) return "text/plain";
        if (n.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        if (n.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }
}