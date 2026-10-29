/**
 * dsh-widthkeeper bundle 的 Host 半边（分叉自 @jinngoo/dsh-conversation-width 0.1.3）。
 *
 * 功能全在 Client 半边（`./client.js`，由 package.json 的 `dsh.client` 声明）：它持有
 * 一份宽度偏好，投影到 Harness 自己的 `--dsh-chat-content-width` 轴，并在输入框下方
 * 提供一个编辑该偏好的条目。
 *
 * 这一行只为让 bundle 有一个已挂载的 Loader 条目、从而让 Web 外壳加载它的 Client
 * 半边；它不注册任何 Service、Event 或 Tool。
 */
export function apply() {}
