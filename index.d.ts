/** 初始化选项 */
export interface InitOptions {
    /** 包含 cef_screenshot_helper.exe 和 CEF 运行时文件的目录 */
    helperDir?: string;
    /**
     * 并发浏览器槽位数量，默认 3，最大 10
     * @deprecated 使用 `browsers` + `tabs` 代替，提供更细粒度的控制
     */
    concurrency?: number;
    /**
     * 浏览器进程数量（默认 1，最大 5）
     * 每个进程是独立的 CEF 实例，拥有自己的标签页
     * 总并发数 = browsers × tabs
     */
    browsers?: number;
    /**
     * 每个浏览器进程的标签页数量（默认 3，最大 10）
     * 低配置机器建议使用 1 个浏览器 + 多标签（节省内存）
     * 高配置机器可使用多浏览器 + 多标签（最大化吞吐量）
     */
    tabs?: number;
}
/** 截图选项 */
export interface ScreenshotOptions {
    /** 视窗宽度（像素），默认 1920 */
    width?: number;
    /** 视窗高度（像素），默认 1080 */
    height?: number;
    /** 页面加载完成后的额外等待时间（毫秒），默认 500 */
    delay?: number;
}
/**
 * 启动 CEF 辅助进程，初始化浏览器池
 * 必须在调用 screenshot() 之前调用
 */
export declare function init(options?: InitOptions): Promise<void>;
/**
 * 对指定 URL 进行截图
 * @param url 要截图的页面 URL（必须以 http:// 或 https:// 开头）
 * @param options 截图参数（宽度、高度、等待时间）
 * @returns PNG 格式的 Buffer
 */
export declare function screenshot(url: string, options?: ScreenshotOptions): Promise<Buffer>;
/**
 * 关闭 CEF 辅助进程，释放所有资源
 * 建议在程序退出前调用
 */
export declare function shutdown(): Promise<void>;
