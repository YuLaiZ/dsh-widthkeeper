# dsh-widthkeeper

会话内容列的**守宽人**。给 DeepSeek Harness 的 Web / 桌面客户端一个可以精确控制的会话内容列宽度：输入框下方一根滑杆，钉住宽度后可收起控件，正文两侧那条容易误触的拖拽手柄也随之隐藏。

## 状态

`0.2.0` 提供四项能力：

- 点击数值按钮直接输入精确宽度（不吸附滑杆步进）
- 「自动」悬浮显示实际生效宽度与来源
- 设置页「内容宽度」分区：显示 / 隐藏控件、输入宽度、恢复默认
- 固定宽度后收起输入框下方的控件，宽度仍然生效

范围只限主会话：右侧栏子会话（ui-subagent 的 sidebar chat）有宿主自己的响应式宽度，插件不接管、也不在其中显示控件。

## 变更记录

各版本的变更与升级影响见 [CHANGELOG](https://github.com/YuLaiZ/dsh-widthkeeper/blob/main/CHANGELOG.md)。

## 为什么需要它

Harness 内置的宽度手柄是一条悬停在正文列外侧才显形的 2px 竖线，热区 10px、和内容列一样高，很容易误触；宽度默认由 `clamp(680px, 列宽 × 64%, 920px)` 这类公式给出，拖动后宿主会记住偏好，但拖动过程以列宽比例和边距为基准，想在常见窗口里稳定落到某个精确像素值只能反复试探。

本插件把宽度变成一条可见、可输入、可固定的偏好：写入 `--dsh-chat-content-width`，并在固定模式下隐藏原生手柄，避免“拖了没反应”的困惑。

## 安装

DSH 插件页「添加插件」：

- 从 GitHub：`github:YuLaiZ/dsh-widthkeeper`
- 从 npm：`@yulaiz/dsh-widthkeeper`

Web 版与桌面版各自独立安装，profile 互不相通：

| 客户端 | profile | 安装方式 |
|---|---|---|
| Web（`dsh web`） | `~/.dsh/profiles/web` | 插件页「添加插件」，装完点「Enable now」即生效，无需重启 |
| 桌面版（App） | `~/.dsh/profiles/desktop` | 插件页「添加插件」，装完完全退出并重开一次 DSH；命令行 `dsh plugin --profile desktop ...` 会被拒绝 |

> **从上游插件迁移**：本插件沿用上游 `@jinngoo/dsh-conversation-width` 的槽位登记 id（`conversation-width`）、语言命名空间（`dsh-conversation-width`）和偏好键（`dsh.conversationWidth.*`）。如果已经安装上游插件，请先禁用它或从 profile 卸载，再安装本插件——两者同时启用会争抢同一注册项、样式和偏好。已有宽度偏好会被本插件继续沿用。

## 使用

- **滑杆**：拖动即固定为该宽度（640–2000px，步进 10）
- **值按钮**：固定态点击展开内联编辑层，输入精确宽度（`Enter` / 失焦提交，`Esc` 取消；超出 640–2000 夹取到边界，空值或非数字回退原值），层内可「使用自动宽度」；自动态点击则固定为上次宽度
- **自动读数**：自动模式悬停值按钮显示 `自动 · 836px（已手动调整 / 默认公式）`，随窗口、会话切换与元素替换刷新
- **只作用于主会话**：右侧栏子会话（ui-subagent 的 sidebar chat）保持宿主自己的响应式宽度，固定规则、自动读数和输入框下方的控件都不介入
- **设置页**：「内容宽度」分区（插件页之后）可显示 / 隐藏输入框下方的控件、输入宽度、一键恢复默认；输入宽度在自动模式下禁用，需先点「切回固定宽度」；「当前自动宽度」行在自动模式下显示实际读数（无可用会话时显示占位），固定模式显示「—（固定宽度生效中）」；恢复默认只清本插件的三个偏好键，不动宿主的拖拽偏好
- 偏好存在浏览器 localStorage：`dsh.conversationWidth.enabled` / `dsh.conversationWidth.value` / `dsh.conversationWidth.dockVisible`

## 工作原理

宽度轴 `--dsh-chat-content-width` 由会话主体元素（`[data-conversation-content]`）自己声明，从 `:root` 设值无效。插件用更高优先级的样式表规则覆盖：

```css
html [data-conversation-content]:not([data-sidebar-chat] *) { --dsh-chat-content-width: min(<px>, 100%) }
html [data-width-handle] { display: none }
```

两条规则只在固定模式注入；自动模式移除它们，完全回到 Harness 默认行为。规则由插件激活时写入 `document.head` 并常驻，不随输入框下方控件的显隐或宿主对 dock 的挂载/卸载而消失，所以无会话、切换会话或收起控件时固定宽度仍然有效。

规则通过 `:not([data-sidebar-chat] *)` 排除右侧栏的嵌入式子会话：这类会话的宽度由侧栏面板决定（宿主自己的 `min(calc(100% - 32px), 920px)` 轴），比主会话多一圈更窄的边距，也不渲染原生手柄；插件只服务主会话。同理，自动读数只从主会话候选里取值，输入框下方的控件也不会出现在嵌入式会话的 composer 里。

插件内的悬浮说明（滑杆、值按钮、设置页「恢复默认」）都使用宿主 `Tooltip` 组件（与上下文徽标同一组件、同一套深色气泡样式），不再设置原生 `title`；宿主未提供该组件时不显示提示，但控件仍可用。

## 兼容性

- 要求 DSH `>=0.2.0-rc.1`（`engines.dsh`），Web 与桌面客户端均支持
- 更新的 DSH（0.3 及以上）允许安装；实际兼容性以运行结果为准，插件不绑定宿主版本号，宿主改版可能使宽度控制失效
- 插件依赖宿主 DOM：`[data-conversation-content]` / `--dsh-chat-content-width` / `[data-width-handle]` / `[data-sidebar-chat]`。宿主 UI 改版若重命名这些选择器，插件会静默失效（宽度控制没有效果）或把嵌入式子会话误当主会话（固定宽度压到侧栏、自动读数落到侧栏），此时在插件页关闭本插件、等待更新即可；自动模式下使用输入框下方的控件时，控制台会告警一次提示结构变化（设置页不告警，因为它可能本就不挂载会话）
- 悬浮说明依赖宿主 `@deepseek-ai/dsh-client-ui-primitives` 的 `Tooltip`（与上下文徽标同组件），不再使用原生 `title`；宿主未提供该组件时不显示悬浮提示，控件仍可用

## 开发

克隆后用插件页「添加插件」填 `link:/你的克隆目录`（软链安装，改源码立即生效），即可直接在仓库里改：

- 只改 `src/client.js`：Web 版刷新页面生效；桌面版（Electron）没有可用的应用内刷新入口，需完全退出并重开 DSH。
- 改 `package.json` / `cordis.patch.yml` 或重新安装 bundle：Web 版重新执行 `dsh web`；桌面版退出并重开。
- 桌面版与 Web 版可以同时 `link:` 同一个克隆目录，改一份代码；两端按上面的方式各自重新加载（Web 刷新、桌面重开）。

不要用 `file:` 前缀：pnpm 会把目录收进 `.pnpm` 虚拟 store 作为副本，改源码不会传到 `node_modules`，热改失效。

## 来源与致谢

本仓库的代码基线来自 [Jinngoo/dsh-conversation-width](https://github.com/Jinngoo/dsh-conversation-width) 0.1.3（MIT，作者 jinngoo）。在此基础上重命名、重新设计并独立维护；原作者版权声明保留在 [LICENSE](./LICENSE)。

## 许可证

MIT，见 [LICENSE](./LICENSE)。
