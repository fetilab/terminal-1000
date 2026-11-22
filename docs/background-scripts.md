# 动态背景脚本开发指南

terminal-1000 支持在**任意界面**播放动态背景：纯色、图片、视频，以及本文档的主角 ——
**TypeScript 脚本**。脚本拿到一块 2D 画布和每帧回调，想画什么（代码雨、下雪、旋转甜甜圈、
时钟、粒子……）完全由你决定。

内置示例可以直接在 **设置 → 外观与通用 → 动态背景 → TS 脚本** 里选用：

| 内置脚本 | 效果 |
| --- | --- |
| `matrix` | 代码雨（Matrix rain） |
| `donut` | 旋转甜甜圈（经典 donut.c 的 2D 移植） |
| `snow` | 下雪（带微风与近大远小） |

---

## 1. 快速开始

写一个最简单的呼吸色背景，保存为 `~/my-bg.ts`：

```ts
export default function frame(api: { ctx: CanvasRenderingContext2D; width: number; height: number; time: number }): void {
  const { ctx, width, height, time } = api
  const pulse = 0.5 + 0.5 * Math.sin(time * 2)
  ctx.fillStyle = `rgb(${10 + pulse * 30}, 20, ${40 + pulse * 30})`
  ctx.fillRect(0, 0, width, height)
}
```

然后在 **设置 → 外观与通用** 里：

1. 「动态背景」选 **TS 脚本**
2. 「背景脚本」填入 `/home/你/my-bg.ts`（或点右侧文件夹按钮选择）
3. 「背景可见度」调到你喜欢的透明度

保存即生效，无需重启。

## 2. 脚本契约

脚本是一个 **默认导出**，可以是「每帧函数」或「带生命周期钩子的对象」：

```ts
export interface BackgroundFrameInfo {
  ctx: CanvasRenderingContext2D   // 2D 上下文，随便画
  canvas: HTMLCanvasElement       // 画布元素（想自己读 width/height 也行）
  width: number                   // 画布物理像素宽（已乘 devicePixelRatio）
  height: number                  // 画布物理像素高
  dt: number                      // 距上一帧的秒数（帧率无关，动画请用它）
  time: number                    // 距脚本启动的秒数
}

// 形态 A：每帧函数
export default function frame(api: BackgroundFrameInfo): void

// 形态 B：对象 + 可选钩子
export default {
  frame(api: BackgroundFrameInfo): void,
  dispose?(): void,   // 脚本被换掉/关掉时调用（清理定时器、Worker 等）
}
```

内置示例（`apps/desktop/resources/background-scripts/`）是三种典型写法的参考：

- **matrix.ts** —— 无状态每帧函数，用半透明黑罩做拖尾衰减
- **donut.ts** —— z-buffer 逐字符光栅化，`time` 驱动旋转
- **snow.ts** —— 跨帧状态（雪片数组），按画布面积播种

## 3. 运行环境与限制

- **执行位置**：渲染进程主线程。脚本共享界面的 CPU 预算 —— 重到掉帧的脚本会拖慢
  整个应用，请控制每帧工作量（示例都在 1ms 以内）。
- **帧率**：由「背景帧率上限」设置（默认 30fps）。你的 `frame` 只会在节流后的节奏里被调；
  动画速度一律用 `dt` 缩放，不要假设固定 60fps。
- **画布尺寸**：物理像素（乘过 DPR），窗口拉伸/缩放变化时画布会自动重置尺寸，
  绘制状态（字体等）会丢，请在每帧或 `resize` 后重新设置。
- **可用 API**：就是标准 Web 平台 —— `CanvasRenderingContext2D`、`Math`、`Date` 等。
  `new Function` 沙箱里没有 `require`/`import`，不能加载 npm 包或做网络请求。
- **错误围栏**：单帧抛错会打一次日志然后跳过该帧；连续失败 30 次自动停机，
  绝不会影响终端与界面。

## 4. TS 是怎么跑起来的

脚本源码不做打包：主进程读文件后用 **TypeScript 编译器**（`transpileModule`）做类型剥离，
产物是 CommonJS，在渲染层 `new Function` 执行。这意味着：

- 类型标注随便写（`transpileModule` 不做类型检查，写错类型不影响运行）
- 不能用 `import`/`export` 以外的模块语法，也不要用需要类型检查的装饰器等
- 文件保存后重新选择一次即可热更新（按 mtime 缓存转译产物）

## 5. 发布你的脚本

- **自用**：把 `.ts` 文件放在任意本地目录，设置里填路径即可。
- **分享**：直接发 `.ts` 文件；对方保存后同样填路径。
- **内置**：向本仓库提交 PR，把脚本放进
  `apps/desktop/resources/background-scripts/<名字>.ts`
  （默认导出 + 文件头 GPL 许可证头），并更新本文档的内置脚本表。

## 6. 主题与配色建议

背景衬在界面之下，**对比度是生命线**：整体亮度压低（示例脚本的正文字色 alpha 都 ≤ 0.9、
背景色接近黑），避免高密度高亮度图案。如果你的脚本依赖应用的强调色，
读 CSS 变量即可（组件挂在 document 下）：

```ts
const accent = getComputedStyle(document.documentElement).getPropertyValue('--t1000-accent').trim() || '#3ec9d6'
```
