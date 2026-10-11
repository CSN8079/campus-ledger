package com.daxuesheng.jizhangben;

/**
 * 安卓端请求路由测试（纯逻辑，不需要手机或模拟器）
 *
 * 之所以专门写这个测试：曾经因为把应用自己的域名 app.local
 * 误判成「局域网地址」而放行，导致 WebView 去解析一个不存在的域名，
 * 结果打开应用只看到「网页无法打开」。
 */
public class HostCheckTest {

    static int pass = 0, fail = 0;

    static void check(boolean cond, String msg) {
        if (cond) { pass++; System.out.println("  \u2713 " + msg); }
        else { fail++; System.out.println("  \u2717 " + msg); }
    }

    public static void main(String[] args) {
        System.out.println("安卓请求路由测试");

        System.out.println("\n1. 应用自身的页面必须从安装包读取（这是会开屏失败的场景）");
        check(RequestRouting.HOST.equals("app.local"), "内部域名是 app.local");
        check(RequestRouting.routeFor("app.local") == RequestRouting.ROUTE_ASSETS,
                "app.local -> 从安装包读取");
        check(!RequestRouting.isPrivateHost("app.local"),
                "app.local 不能被当成局域网地址");

        System.out.println("\n2. 局域网地址放行（用于和电脑同步数据）");
        String[] lan = { "192.168.1.7", "192.168.31.100", "10.0.0.5", "172.16.0.1",
                "172.31.255.254", "127.0.0.1", "localhost" };
        for (String h : lan) {
            check(RequestRouting.routeFor(h) == RequestRouting.ROUTE_PASSTHROUGH, h + " -> 放行");
        }

        System.out.println("\n3. 公网地址一律拒绝");
        String[] pub = { "www.baidu.com", "8.8.8.8", "114.114.114.114", "github.com",
                "172.32.0.1", "172.15.0.1", "192.169.1.1", "11.0.0.1",
                "app.local.evil.com", "app.local.x" };
        for (String h : pub) {
            check(RequestRouting.routeFor(h) == RequestRouting.ROUTE_BLOCK, h + " -> 拒绝");
        }

        System.out.println("\n4. 异常输入不能误放行");
        check(RequestRouting.routeFor(null) == RequestRouting.ROUTE_BLOCK, "null -> 拒绝");
        check(RequestRouting.routeFor("") == RequestRouting.ROUTE_BLOCK, "空字符串 -> 拒绝");
        check(RequestRouting.routeFor("192.168.1") == RequestRouting.ROUTE_BLOCK, "不完整的 IP -> 拒绝");
        check(RequestRouting.routeFor("192.168.1.999") == RequestRouting.ROUTE_BLOCK, "越界的 IP 段 -> 拒绝");
        check(RequestRouting.routeFor("abc.def.ghi.jkl") == RequestRouting.ROUTE_BLOCK, "非数字 -> 拒绝");
        check(RequestRouting.routeFor("192.168.1.7.evil.com") == RequestRouting.ROUTE_BLOCK,
                "把内网 IP 写在域名里 -> 拒绝");

        System.out.println("\n5. 资源类型判断");
        check("text/html".equals(RequestRouting.mimeOf("index.html")), "html");
        check("text/javascript".equals(RequestRouting.mimeOf("app.js")), "js");
        check("application/json".equals(RequestRouting.mimeOf("backup.JSON")), "json（大小写不敏感）");
        check("image/png".equals(RequestRouting.mimeOf("icon-192.png")), "png");
        check("text/css".equals(RequestRouting.mimeOf("app.css")), "css");
        check(RequestRouting.mimeOf("报表.xlsx").indexOf("spreadsheetml") > 0, "xlsx");
        check(RequestRouting.mimeOf("icon.svg").equals("image/svg+xml"), "svg");
        check(RequestRouting.mimeOf("没有扩展名").equals("application/octet-stream"), "未知类型 -> 二进制");

        System.out.println("\n6. 物理像素换算成 CSS 像素（安全边距不能放大）");
        check(DisplayUtils.physicalToCss(66, 2.75f) == 24, "66px @2.75 -> 24（状态栏 24dp）");
        check(DisplayUtils.physicalToCss(105, 2.625f) == 40, "105px @2.625 -> 40");
        check(DisplayUtils.physicalToCss(0, 3f) == 0, "0px -> 0");
        check(DisplayUtils.physicalToCss(27, 2.75f) == 10, "27px @2.75 -> 10（四舍五入）");
        check(DisplayUtils.physicalToCss(30, 1f) == 30, "密度 1 时保持不变");
        check(DisplayUtils.physicalToCss(48, 0f) == 48, "拿不到密度时按原值返回（不会算成 0）");
        check(DisplayUtils.physicalToCss(48, -1f) == 48, "密度异常时按原值返回");
        // 关键回归：高密度手机上不能把物理像素直接当 CSS 像素用
        check(DisplayUtils.physicalToCss(66, 2.75f) != 66, "高密度手机不会把安全边距放大 2.75 倍");

        System.out.println("\n" + repeat("=", 46));
        System.out.println("安卓逻辑测试：通过 " + pass + " 项，失败 " + fail + " 项");
        System.out.println(repeat("=", 46));
        System.exit(fail == 0 ? 0 : 1);
    }

    static String repeat(String s, int n) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < n; i++) sb.append(s);
        return sb.toString();
    }
}