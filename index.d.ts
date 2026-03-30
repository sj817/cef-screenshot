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
/** 裁剪区域 */
export interface ClipRegion {
    /** 裁剪区域左上角 X 坐标（像素） */
    x: number;
    /** 裁剪区域左上角 Y 坐标（像素） */
    y: number;
    /** 裁剪区域宽度（像素） */
    width: number;
    /** 裁剪区域高度（像素） */
    height: number;
}
/** 页面导航参数 */
export interface PageGotoParams {
    /**
     * 导航超时时间（毫秒）
     * @defaultValue 30000
     */
    timeout?: number;
    /**
     * 页面加载完成的判定标准
     * - `'load'`: 页面及资源加载完成（默认）
     * - `'domcontentloaded'`: DOM 解析完成（暂未支持，回退到 load）
     * - `'networkidle0'`: 无网络请求（暂未支持，回退到 load）
     * - `'networkidle2'`: 网络请求 ≤ 2（暂未支持，回退到 load）
     * @defaultValue 'load'
     */
    waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';
}
/** 截图选项 */
export interface ScreenshotOptions {
    /** 视窗宽度（像素），默认 1920 */
    width?: number;
    /** 视窗高度（像素），默认 1080 */
    height?: number;
    /** 页面加载完成后的额外等待时间（毫秒），默认 500 */
    delay?: number;
    /** CSS 选择器，截图指定元素。未指定时截图整个页面 */
    selector?: string;
    /**
     * 是否截取完整页面（包括滚动区域），默认 true
     * 设为 false 则仅截取视窗可见区域（旧版行为）
     */
    fullPage?: boolean;
    /**
     * 隐藏默认白色背景，使截图支持透明背景
     * @defaultValue false
     */
    omitBackground?: boolean;
    /**
     * 裁剪区域（像素坐标），截取页面的指定矩形区域
     * 与 selector 互斥，设置 clip 时 selector 将被忽略
     */
    clip?: ClipRegion;
    /**
     * 图片编码方式
     * @defaultValue 'binary'
     */
    encoding?: 'binary' | 'base64';
    /**
     * 保存截图的文件路径。如果提供，截图将同时保存到该路径
     */
    path?: string;
    /**
     * 截图失败时的重试次数
     * @defaultValue 1
     */
    retry?: number;
    /**
     * 自定义 HTTP 请求头
     * @description 暂未支持，预留接口
     */
    headers?: Record<string, string>;
    /** 页面导航参数 */
    pageGotoParams?: PageGotoParams;
}
/** 分片截图选项 */
export interface SlicedScreenshotOptions extends ScreenshotOptions {
    /**
     * 分片高度（像素），将截图按此高度切分为多张图片
     * 相邻分片重叠 100px 以保证视觉连续性
     * 最后一片不足时向上扩展到完整高度
     */
    sliceHeight: number;
}
/**
 * 启动 CEF 辅助进程，初始化浏览器池
 * 必须在调用 screenshot() 之前调用
 */
export declare function init(options?: InitOptions): Promise<void>;
/**
 * 对指定 URL 进行截图（分片模式）
 * @param url 要截图的页面 URL
 * @param options 包含 sliceHeight 的截图参数
 * @returns PNG 格式的 Buffer 数组，每个元素为一个分片
 */
export declare function screenshot(url: string, options: SlicedScreenshotOptions): Promise<Buffer[]>;
/**
 * 对指定 URL 进行截图（base64 编码）
 * @param url 要截图的页面 URL
 * @param options 截图参数，encoding 设为 'base64'
 * @returns base64 编码的 PNG 字符串
 */
export declare function screenshot(url: string, options: ScreenshotOptions & {
    encoding: 'base64';
}): Promise<string>;
/**
 * 对指定 URL 进行截图
 * @param url 要截图的页面 URL（支持 http://, https://, file:// 协议）
 * @param options 截图参数（宽度、高度、等待时间、选择器等）
 * @returns PNG 格式的 Buffer
 */
export declare function screenshot(url: string, options?: ScreenshotOptions): Promise<Buffer>;
/**
 * 关闭 CEF 辅助进程，释放所有资源
 * 建议在程序退出前调用
 */
export declare function shutdown(): Promise<void>;
