# dsh-widthkeeper

会话内容列的**守宽人**。给 DeepSeek Harness 的 Web / 桌面客户端一个可以精确控制的会话内容列宽度：输入框下方一根滑杆，钉住宽度后收起控件，正文两侧那条容易误触的拖拽手柄也随之隐藏。

> Fork 自 [Jinngoo/dsh-conversation-width](https://github.com/Jinngoo/dsh-conversation-width)（MIT，作者 jinngoo），基线版本 0.1.3。宽度轴覆盖、固定/自动双态、隐藏原生手柄等基础实现来自上游；本仓库在此基础上继续演进。原作者版权声明保留在 [LICENSE](./LICENSE)。

## 状态

当前 `0.1.0` 与上游 0.1.3 功能一致，只完成了重命名与归属整理。以下改进在后续版本实现：

- 点击数值直接输入精确宽度
- 「自动」悬浮显示实际生效宽度
- 设置页：显示 / 隐藏控件，并可直接输入宽度
- 固定宽度后收起输入框下方的控件

## 为什么需要它

Harness 内置的宽度手柄是一条悬停在正文列外侧才显形的 2px 竖线，热区 10px、和内容列一样高，很容易误触；而内置宽度轴又被 `clamp(680px, 列宽 × 64%, 920px)` 限制在一个区间里，既调不精确也留不住。

本插件把宽度变成一条可见、可输入、可固定的偏好：写入 `--dsh-chat-content-width`，并在固定模式下隐藏原生手柄，避免“拖了没反应”的困惑。

## 安装

DSH 插件页「添加插件」：

- 从 GitHub：`github:YuLaiZ/dsh-widthkeeper`
- 从 npm（发布后）：`dsh-widthkeeper`

安装后**完全退出并重开一次 DSH**。桌面版的 profile 由 Electron 应用独占管理，请通过插件页安装；命令行 `dsh plugin --profile desktop ...` 会被拒绝。

## 使用

- **滑杆**：拖动即固定为该宽度（720–2400px，步进 20）
- **模式按钮**：固定值 ↔ 自动（自动 = 回到 Harness 内置行为，原生手柄恢复可用）
- 偏好存在浏览器 localStorage：`dsh.conversationWidth.enabled` / `dsh.conversationWidth.value`

## 工作原理

宽度轴 `--dsh-chat-content-width` 由会话主体元素（`[data-conversation-content]`）自己声明，从 `:root` 设值无效。插件用更高优先级的样式表规则覆盖：

```css
html [data-conversation-content] { --dsh-chat-content-width: min(<px>, 100%) }
html [data-width-handle] { display: none }
```

两条规则只在固定模式注入；自动模式移除它们，完全回到 Harness 默认行为。

## 兼容性

- DSH `^0.2.0-rc.1`（`engines.dsh`），Web 与桌面客户端
- 宿主 UI 改版若重命名 `[data-conversation-content]` / `--dsh-chat-content-width` / `[data-width-handle]`，插件会静默失效（不报错、只是没有效果）

## 开发

克隆后用插件页「添加插件」填 `file:/你的克隆目录`（link 安装），即可直接在仓库里改：

- 只改 `client.js`：刷新页面生效
- 改 `package.json` / `cordis.patch.yml` 或安装 bundle：完全退出并重开 DSH

## 许可证

MIT，见 [LICENSE](./LICENSE)；其中保留原作者 jinngoo 的版权声明。
