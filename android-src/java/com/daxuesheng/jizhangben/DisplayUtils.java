package com.daxuesheng.jizhangben;

/**
 * 屏幕相关的纯计算工具，不依赖任何安卓 API，可以直接在电脑上跑单元测试。
 *
 * 为什么需要它：
 *   WindowInsets 给出的是**物理像素**，而网页里 CSS 的 px 是**逻辑像素**。
 *   如果把物理像素直接当成 CSS 像素用，在密度 2.75 的手机上就会被放大 2.75 倍，
 *   结果顶部状态栏和底部手势区各多出一大块空白。
 */
final class DisplayUtils {

    private DisplayUtils() { }

    /**
     * 物理像素换算成 CSS 像素。
     * density 就是安卓的 DisplayMetrics.density（1dp 等于几个物理像素）。
     */
    static int physicalToCss(int physicalPx, float density) {
        if (density <= 0f) return physicalPx;   // 拿不到密度时按原值处理，避免算出 0
        return Math.round(physicalPx / density);
    }
}