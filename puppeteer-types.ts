/**
 * 截图参数。
 * @description 对于没有特别说明的参数, puppeteer和playwright均支持。
 */
export interface ScreenshotOptions {
  /**
   * 选择一个元素进行截图。
   *
   * 如果设置了该选项，截图将只包含该元素的内容。
   * @description 在设置fullPage为true时此参数无效。
   * @default '#container'
   */
  selector?: string
  /**
   * 图片质量，范围 0-100。对 `png` 类型无效。
   */
  quality?: number

  /**
   * 是否截图完整页面。
   *
   * @defaultValue `false`
   */
  fullPage?: boolean

  /**
   * 隐藏默认的白色背景，使截图支持透明背景。
   *
   * @defaultValue `false`
   */
  omitBackground?: boolean

  /**
   * 保存截图的文件路径。
   * 截图类型将根据文件扩展名推断。
   * 如果提供相对路径，将基于当前工作目录解析。
   * 如果未提供路径，图片不会保存到磁盘。
   */
  path?: string

  /**
   * 指定需要裁剪的区域。
   */
  clip?: {
    /**
     * 元素的左上角横坐标（像素）。
     */
    x: number
    /**
     * 元素的左上角纵坐标（像素）。
     */
    y: number

    /**
     * 元素的宽度（像素）。
     */
    width: number

    /**
     * 元素的高度（像素）。
     */
    height: number
    /**
     * 缩放比例。
     * @defaultValue `1`
     * @description puppeteer 独有参数。
     */
    scale?: number
  }

  /**
   * 是否允许截图超出可视区域（viewport）。
   *
   * @defaultValue `false`（无 clip 时），否则 `true`
   * @description 仅 puppeteer 支持该参数。
   */
  captureBeyondViewport?: boolean
  /**
   * 是否从表面而不是视图上截取屏幕截图。
   *
   * @defaultValue `true`
   * @description 仅 puppeteer 支持该参数。
   */
  fromSurface?: boolean
  /**
   * 是否优化速度。
   * @defaultValue `false`
   * @description 仅 puppeteer 支持该参数。
   */
  optimizeForSpeed?: boolean
  /**
   * 重试次数
   * @description snapka 独有参数
   * @defaultValue `1`
   */
  retry?: number
}

/**
 * 截图参数
 */
export interface SnapkaScreenshotOptions<T extends 'base64' | 'binary'> extends ScreenshotOptions {
  /**
   * goto的页面地址
   * - file://
   * - http(s)?://
   */
  file: string
  /**
   * 重试次数
   * @defaultValue `1`
   */
  retry?: number
  /**
   * 保存截图的文件路径
   */
  path?: string
  /** 自定义HTTP 标头 */
  headers?: Record<string, string>
  /**
   * 图片的编码方式。
   *
   * @defaultValue `'binary'`
   * @description playwright 拓展支持 `'base64'` 编码。
   */
  encoding?: T
  /** 页面goto时的参数 */
  pageGotoParams?: {
    /**
     * 导航的URL地址超时时间，单位毫秒
     * @defaultValue 30000
     */
    timeout?: number
    /**
     * 指定页面“完成加载”的标准，也就是 Puppeteer、 Playwright 认为操作成功的条件。
     * @defaultValue 'load'
     *
     * - 'load': 页面及资源加载完成
     * - 'domcontentloaded': DOM 已经解析完成，但图片等资源可能还没加载
     * - 'networkidle0': 网络请求为 0 且维持至少 500ms（页面完全静止）
     * - 'networkidle2': 网络请求不超过 2 个且维持至少 500ms（页面基本静止）
     */
    waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2'
  }
}
