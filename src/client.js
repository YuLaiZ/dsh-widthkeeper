/**
 * dsh-widthkeeper 的 Client 半边。
 *
 * 代码基线来自 @jinngoo/dsh-conversation-width 0.1.3（MIT，原作者 jinngoo）：
 * https://github.com/Jinngoo/dsh-conversation-width
 *
 * 宽度轴 `--dsh-chat-content-width` 由会话主体元素自己声明（ui-conversation 的 `.body`，
 * 即带 `[data-conversation-content]` 的那个元素），所以从 `:root`/`body` 设值无效。
 * 本插件改用更高优先级的样式表规则覆盖（0-2-1 > 0-1-0），不需要 `!important`。
 * 值取 `min(<px>, 100%)`：该变量被正文列、输入卡片、用户气泡、
 * ≥4 列表格破列多处消费，各自解析自己的 100%，超大值只会退化成「铺满」而不会撑破任何一处。
 *
 * 规则只在固定模式存在；自动模式移除规则，恢复 Harness 默认宽度与内置拖拽手柄。
 * 固定模式下隐藏手柄，因为它们写的行内 `--dsh-chat-user-width` 已被覆盖，拖了没有反应。
 *
 * 宽度规则挂载在 document.head（apply 期间常驻），不随 dock 组件挂载/卸载：
 * 宿主只在有会话且有输入时投影 `conversation.composer.dock`，把 <style> 放进去会让
 * 「无会话」「dock 被宿主卸载」时固定宽度一起失效。dock 组件只负责可见控件。
 *
 * 插件只服务主会话：右侧栏嵌入式子会话（ui-subagent 的 sidebar chat，带
 * `[data-sidebar-chat]` 包装）使用宿主自己的响应式宽度轴 `min(calc(100% - 32px), 920px)`
 * 和更窄的 composer 边距，也不渲染原生手柄。固定规则、自动读数与 dock 都排除这类会话，
 * 避免固定值吃掉侧栏边距，也避免把主会话的手动偏好误报成嵌入式会话的来源。
 *
 * 0.2.0 的四项能力（全部在本 factory 内实现，不拆文件）：
 * - 值按钮可点击展开内联编辑层，输入精确宽度（clamp 后取整、不吸附步进）；
 * - 自动模式不注入规则，直接读宿主算出的实际宽度与来源（已手动调整 / 默认公式）；
 * - 设置页新增「内容宽度」分区（settings.section 槽位）：控件显隐、精确宽度、
 *   自动读数与恢复默认；
 * - 收起输入框下方的控件时，宽度规则继续生效，固定宽度不受影响。
 *
 * 0.2.2 起滑杆与精确输入的上限改为动态：取当前页面正文列铺满的宽度
 * （usePageWidthLimit），随窗口、侧栏、右栏与滚动条变化刷新。超出当前上限的
 * 已保存值不会被改写，只在展示上夹到上限；滑杆因此不再有拖了没反应的死区。
 */
window.__ModuleLoader__.load({
  id: '@yulaiz/dsh-widthkeeper',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    let flushSync = null
    try {
      flushSync = require('react-dom').flushSync ?? null
    } catch { /* 旧宿主未暴露 react-dom 时仍由观察器补测。 */ }

    /**
     * 宿主的 Tooltip：桌面版 Electron 里原生 `title` 不弹提示（2026-11-02 实测，
     * 无障碍树里 AXHelp 有值但界面不显示），所以提示只用宿主自己的 Tooltip，
     * 不再设置原生 `title`。primitives 是 ui-conversation 的依赖，正常随宿主加载；
     * 宿主异常缺这个包时不显示提示，但控件本身仍可用。
     */
    let HostTooltip = null
    try {
      HostTooltip = require('@deepseek-ai/dsh-client-ui-primitives').Tooltip ?? null
    } catch { /* 宿主未提供 primitives：不显示悬浮提示，控件仍可用 */ }

    /** 本插件占用的语言命名空间。 */
    const NS = 'dsh-widthkeeper'
    /** 槽位内的登记 id：新 id 与宿主条目并列，复用宿主 id 会顶掉它。 */
    const DOCK_ID = 'dsh-widthkeeper'
    /** 槽位：输入框卡片下方的环境条目。 */
    const DOCK_SLOT = 'conversation.composer.dock'
    const DOCK_WAITING_CSS = '[data-composer-dock]:not([data-sidebar-chat] *):has('
      + '> [data-slot="' + DOCK_SLOT + '"] > [data-widthkeeper-waiting]){visibility:hidden}'
    /** 槽位：设置页分区（宿主插件页 order 为 15，本分区排在其后）。 */
    const SECTION_SLOT = 'settings.section'
    const SECTION_ID = 'widthkeeper'
    const SECTION_ORDER = 16
    /** 持久化偏好（按浏览器 profile，与 Harness 自己的宽度键同级）。 */
    const ENABLED_KEY = 'dsh.widthkeeper.enabled'
    const VALUE_KEY = 'dsh.widthkeeper.value'
    const DOCK_VISIBLE_KEY = 'dsh.widthkeeper.dockVisible'
    /** 宿主内置拖拽偏好的键（只读，仅用于判定自动宽度的来源）。 */
    const HOST_WIDTH_KEY = 'dsh.conversation.contentWidth'
    /**
     * 滑杆域与步长：与宿主原生拖拽手柄同域，窄窗口退化成只读指示器。
     *
     * 宿主对正文列的拖拽域是 CONTENT_MIN(640) – max(640, 列宽 − CONTENT_EDGE_BUDGET(176))，
     * 176px 是两侧手柄与呼吸边距的预算。插件固定模式隐藏了手柄，域仍按宿主口径取，
     * 「滑杆最右 = 自动模式最右、滑杆最左 = 自动模式最左」，不会有任何错位。
     *
     * 窄窗口：列宽 ≤ 816 时宿主手柄域退化成 max(640, …) ≤ 640 并收掉两侧手柄，
     * 自动模式已经调不动了，只剩窗口挤压。插件此时把下限贴到上限（见 pageFloor），
     * 滑杆变成只读的当前位置，不再允许设出自动模式到不了的值。
     *
     * MIN 只作为「读取历史存储值」的下界（窄窗口时代存过的 200–640 不该被改写），
     * 不再参与宽窗口的滑杆域。
     *
     * FALLBACK_MAX 只在测不到列宽时兜底（设置页无会话、宿主结构变化），
     * 此时按宽窗口口径取 640 起。
     */
    const MIN = 200
    /** 宿主 CONTENT_MIN：宽窗口的滑杆下限与此对齐。 */
    const HOST_MIN = 640
    /** 宿主 CONTENT_EDGE_BUDGET：正文列两侧留给手柄与呼吸边距的宽度。 */
    const HOST_EDGE_BUDGET = 176
    const FALLBACK_MAX = 2000
    const STEP = 10
    /**
     * 默认的固定宽度：略宽于 Harness 内置上限（920px），首次启用能看出变化，
     * 又不会在常见窗口宽度下退化成 min(<px>, 100%) 的铺满。
     */
    const DEFAULT_VALUE = 1000
    /** 宿主钩子：会话主体元素与其上声明的宽度轴（改名即静默失效，靠自动读数的告警自检）。 */
    const CONTENT_SELECTOR = '[data-conversation-content]'
    /**
     * 宿主钩子：会话滚动区。正文列就渲染在它里面，测量当前页面可用宽度时以它
     * 为范围；和 CONTENT_SELECTOR 一样属于宿主结构，改名即回退到 FALLBACK_MAX。
     */
    const SCROLL_SELECTOR = '[data-conversation-scroll]'
    /**
     * 宿主钩子：输入框所在区域。composer 卡片也消费宽度轴（max-width 是正文列
     * 加 32px，通常比正文列还宽），找正文列时必须把它排除。
     */
    const COMPOSER_SELECTOR = '[data-composer-seat]'
    /**
     * 宿主钩子：右侧栏嵌入式子会话（ui-subagent 的 sidebar chat）的包装元素。
     * 这类会话的宽度由面板宽度决定，和主会话的固定/拖拽偏好无关；插件只管主会话。
     */
    const EMBEDDED_SELECTOR = '[data-sidebar-chat]'
    const AXIS_VAR = '--dsh-chat-content-width'
    /**
     * 宿主发布的主会话列宽（主区宽度）。宿主用它算正文列拖拽域，
     * 插件读同一个变量来复算上限，保证与自动模式的手柄完全一致。
     */
    const COLUMN_VAR = '--dsh-conversation-column-width'

    /**
     * 术语约定（本文件内）：
     * - 「固定模式 / 自动模式」一律指宿主 Harness 的原生行为（它自己的宽度轴与
     *   拖拽手柄），不是本插件的状态。
     * - 本插件自身的状态称「固定宽度 / 自动宽度」，面向用户的文案同样如此。
     * - 控件：滑杆是整根控件，滑块是拖动的那一颗；正文列是承载消息的列容器。
     */
    const DICTS = {
      zh: {
        auto: '自动',
        autoAria: '自动宽度，按下可切换为固定宽度',
        slider: '正文列宽度（像素）',
        sliderValue: '{v} 像素',
        // 固定态下手柄被 CSS 隐藏（axisCss 里的 display:none），文案据实说「会隐藏」
        sliderTitle: '拖动滑杆即固定为该宽度（本窗口可设上限 {max}px）。固定后正文两侧手柄会隐藏',
        sliderTitleAuto: '当前是自动宽度，滑杆跟随正文两侧手柄。拖动滑杆即固定为该宽度（上限 {max}px）',
        sliderTitleReadonly: '当前可设上限为 {v}px。拉宽窗口后即可调整',
        pinnedTooltip: '当前：固定宽度。点击输入精确宽度，或切回自动宽度',
        pinnedTooltipReadonly: '窗口太窄，暂时无法调整宽度。点击可打开宽度选项',
        pinnedOverflowTooltip: '已保存 {v}px。当前可设上限为 {max}px。点击可修改',
        pinnedUnderflowTooltip: '已保存 {v}px，低于当前可设下限 {min}px。点击可修改',
        autoTooltip: '当前：自动宽度（暂时读不到实际值）。点击切换为固定宽度，沿用上次的宽度',
        autoTooltipAction: '。点击切换为固定宽度',
        valueAria: '宽度 {v}px，按下可编辑',
        valueAriaReadonly: '宽度 {v}px，窗口太窄，按下可打开宽度选项',
        widthInputLabel: '内容宽度（{min}–{max} 像素）',
        useAuto: '切回自动宽度',
        cancelEdit: '取消',
        autoReadout: '自动 · {v}px',
        sourceDragging: '（拖动中）',
        sourceDragged: '（拖手柄调整过）',
        sourceFormula: '（按窗口计算）',
        sourceCapped: '（本窗口上限）',
        autoReadoutSqueezed: ' · 拖手柄设过的 {v}px，拉宽窗口后恢复',
        autoReadoutCramped: ' · 窗口太窄，正文被挤压',
        settingsNav: '内容宽度',
        settingsDockToggle: '在输入框下方显示宽度控件',
        settingsWidthLabel: '固定宽度',
        settingsWidthInputLabel: '固定宽度（像素）',
        settingsWidthHint: '{min}–{max}px。按回车或离开输入框即可应用',
        settingsWidthHintReadonly: '窗口太窄，拉宽后即可调整',
        settingsWidthLabelAuto: '固定宽度（未生效）',
        settingsWidthHintAuto: '点击「切回固定宽度」以应用已保存的值',
        settingsPinnedSwitch: '切回固定宽度',
        settingsAutoRow: '自动宽度',
        settingsAutoUnavailable: '—（固定宽度生效中）',
        settingsAutoUnknown: '—（暂时无法读取）',
        settingsReset: '恢复默认',
        settingsResetHint: '清除本插件的宽度偏好，回到默认固定宽度并显示控件',
        missingContentWarning: '未找到会话正文元素 {selector}，无法读取自动宽度',
      },
      en: {
        auto: 'Auto',
        autoAria: 'Automatic width. Press to switch to fixed width',
        slider: 'Conversation content width (pixels)',
        sliderValue: '{v} pixels',
        sliderTitle: 'Drag the slider to set a fixed width up to {max}px',
        sliderTitleAuto: 'The slider follows the resize handles in automatic mode. Drag the slider to set a fixed width up to {max}px',
        sliderTitleReadonly: 'The maximum setting is {v}px. Widen the window to adjust the width',
        pinnedTooltip: 'Fixed width. Click to enter an exact value or switch back to automatic width',
        pinnedTooltipReadonly: 'The window is too narrow to adjust the width. Click to open width options',
        pinnedOverflowTooltip: 'Saved width: {v}px. The maximum setting is {max}px. Click to edit',
        pinnedUnderflowTooltip: 'Saved width: {v}px. The minimum setting is {min}px. Click to edit',
        autoTooltip: 'Automatic width (current value unavailable). Click to apply the saved fixed width',
        autoTooltipAction: '. Click to switch to fixed width',
        valueAria: 'Width: {v} pixels. Press to edit',
        valueAriaReadonly: 'Width: {v} pixels. The window is too narrow. Press to open width options',
        widthInputLabel: 'Content width ({min}–{max} pixels)',
        useAuto: 'Switch back to automatic width',
        cancelEdit: 'Cancel',
        autoReadout: 'Auto · {v}px',
        sourceDragging: ' (dragging)',
        sourceDragged: ' (adjusted by dragging a handle)',
        sourceFormula: ' (computed from the window)',
        sourceCapped: ' (this window’s limit)',
        autoReadoutSqueezed: ' · the {v}px you set will be restored when the window is wide enough',
        autoReadoutCramped: ' · the window limits the content width',
        settingsNav: 'Content width',
        settingsDockToggle: 'Show width controls below the message box',
        settingsWidthLabel: 'Fixed width',
        settingsWidthInputLabel: 'Fixed width (pixels)',
        settingsWidthHint: 'Range: {min}–{max}px. Press Enter or leave the field to apply',
        settingsWidthHintReadonly: 'Widen the window to adjust the width',
        settingsWidthLabelAuto: 'Fixed width (inactive)',
        settingsWidthHintAuto: 'Select “Switch back to fixed width” to apply the saved value',
        settingsPinnedSwitch: 'Switch back to fixed width',
        settingsAutoRow: 'Automatic width',
        settingsAutoUnavailable: '— (fixed width is active)',
        settingsAutoUnknown: '— (unavailable right now)',
        settingsReset: 'Reset to defaults',
        settingsResetHint: 'Clear the width preferences stored by this plugin and restore the defaults',
        missingContentWarning: 'Conversation content element {selector} was not found. Automatic width is unavailable',
      },
    }

    /**
     * dock 外观：对齐宿主的 dock 条目规范（ui-chat StatsPills / ui-conversation ContextMeter）——
     * 扁平透明底、label-tertiary、hover 才出 interactive-bg-hover、--dsw-radius-sm、
     * secondary 字号、tabular-nums。只引用主题 token，token 改名只会掉样式，不会崩渲染。
     */
    const CHROME_CSS = [
      '.wk-dock{display:inline-flex;align-items:center;gap:6px;flex:0 1 auto;min-width:0;',
      'padding:1px 8px;border-radius:var(--dsw-radius-sm);background:transparent;',
      // 字号与 ui-chat 的 StatsPills 一致：次级字号再减 1px
      'color:var(--dsw-alias-label-tertiary);',
      'font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);',
      'line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));',
      'font-variant-numeric:tabular-nums;white-space:nowrap}',
      // 自绘轨道与滑块：原生 accent-color 用的是品牌色，而品牌色在本设计系统里
      // 是黑白对比色（浅色主题近黑、深色主题近白），方块对撞过于生硬。这里改用
      // 中性灰调，滑杆是辅助控件，不需要抢过正文和数值的注意力。
      '.wk-range[disabled]{cursor:default;opacity:.55}',
      '.wk-range[disabled]::-webkit-slider-thumb{cursor:default}',
      '.wk-range{flex:0 1 auto;width:112px;min-width:56px;height:16px;margin:0;',
      'background:transparent;cursor:pointer;-webkit-appearance:none;appearance:none}',
      '.wk-range::-webkit-slider-runnable-track{height:4px;border-radius:999px;',
      'background:var(--dsw-alias-border-l3)}',
      '.wk-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;',
      'width:12px;height:12px;margin-top:-4px;border-radius:50%;',
      'background:var(--dsw-alias-label-secondary);transition:background .15s}',
      '@media (hover: hover){.wk-range:hover::-webkit-slider-thumb{background:var(--dsw-alias-label-primary)}}',
      '.wk-range:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.wk-dock[data-dsh-widthkeeper="auto"] .wk-range{opacity:.55}',
      // 静止态沿用宿主的 tertiary；只有 hover / 固定态才升到 secondary
      '.wk-mode{flex:none;padding:0 6px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;',
      'color:var(--dsw-alias-label-tertiary);font:inherit;line-height:inherit;',
      'font-variant-numeric:tabular-nums;cursor:pointer}',
      '.wk-mode[aria-pressed="true"]{color:var(--dsw-alias-label-secondary)}',
      '.wk-mode:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.wk-mode:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.wk-edit{display:inline-flex;align-items:center;gap:6px;flex:0 1 auto;min-width:0}',
      '.wk-edit-input{flex:0 1 96px;min-width:56px;height:20px;margin:0;padding:0 6px;border:0;',
      'border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover);',
      'color:var(--dsw-alias-label-primary);font:inherit;line-height:inherit;',
      'font-variant-numeric:tabular-nums;appearance:textfield}',
      '.wk-edit-input::-webkit-outer-spin-button,.wk-edit-input::-webkit-inner-spin-button{',
      '-webkit-appearance:none;margin:0}',
      '.wk-edit-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.wk-edit-unit{flex:none;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
    ].join('')

    /**
     * 设置页分区外观：对齐宿主设置卡规范（ui-settings-account AccountSection、
     * ui-primitives Checkbox）——settings-card 卡片、border-l2 分隔、40px 行、
     * 原生 checkbox 配 brand accent。同样只引用主题 token。
     */
    const SECTION_CSS = [
      '.wk-settings{display:flex;flex-direction:column;gap:16px;padding:8px 0;',
      'font-size:13px;line-height:22px;color:var(--dsw-alias-label-primary)}',
      '.wk-card{display:flex;flex-direction:column;padding:12px 16px;',
      'border:0.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);',
      'background:var(--dsw-alias-settings-card-fill)}',
      '.wk-row{display:flex;align-items:center;justify-content:space-between;gap:16px;',
      'min-height:40px;padding:6px 0;box-sizing:border-box}',
      '.wk-row-copy{display:flex;flex-direction:column;min-width:0}',
      '.wk-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.wk-divider{border-top:0.5px solid var(--dsw-alias-border-l2)}',
      '.wk-row input[type="checkbox"]{flex:0 0 auto;width:16px;height:16px;margin:0;',
      'accent-color:var(--dsw-alias-brand-primary);cursor:pointer}',
      '.wk-field{display:inline-flex;align-items:center;gap:8px;flex:none}',
      '.wk-num{box-sizing:border-box;width:96px;height:28px;padding:0 8px;',
      'border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);',
      'background:transparent;color:var(--dsw-alias-label-primary);font:inherit;',
      'font-variant-numeric:tabular-nums;appearance:textfield}',
      '.wk-num::-webkit-outer-spin-button,.wk-num::-webkit-inner-spin-button{',
      '-webkit-appearance:none;margin:0}',
      '.wk-num:disabled{opacity:.55;cursor:default}',
      '.wk-unit{color:var(--dsw-alias-label-tertiary)}',
      '.wk-ghost{display:inline-flex;align-items:center;box-sizing:border-box;height:28px;padding:0 10px;',
      'border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);',
      'background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;line-height:20px;',
      'white-space:nowrap;cursor:pointer}',
      '.wk-row>span:first-child{flex:0 0 auto;white-space:nowrap}',
      '.wk-readonly{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-tertiary);',
      'font-variant-numeric:tabular-nums;text-align:right}',
      '.wk-actions{display:flex;justify-content:flex-end;align-items:center;gap:10px}',
      '.wk-btn{display:inline-flex;justify-content:center;align-items:center;box-sizing:border-box;',
      'height:36px;min-width:58px;padding:0 14px;border:0.5px solid var(--dsw-alias-border-l3);',
      'border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);',
      'font-size:14px;line-height:22px;white-space:nowrap;cursor:pointer}',
      '@media (hover: hover){.wk-ghost:hover,.wk-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}}',
      '.wk-row input:focus-visible,.wk-num:focus-visible,.wk-ghost:focus-visible,.wk-btn:focus-visible{',
      'outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));',
      'outline-offset:2px}',
    ].join('')

    /**
     * 当前滑块域的下限：恒为 `min(CONTENT_MIN, 上限)`，与自动模式**同一条判据**。
     *
     * 宿主的拖拽下限是 CONTENT_MIN(640)；窗口被挤压到「正文列可用宽度 < 640」
     * （列宽 ≤ 816，手柄域退化成 max(640, 列宽 − 176) ≤ 640，两侧手柄随之消失）
     * 时，自动模式自己也调不动了，只剩窗口挤压的结果。插件这时把下限贴到上限，
     * 滑杆退化成一个只读的当前位置——能看见当前宽度，但不能设出自动模式到不了的
     * 值。拉宽窗口后上限重新大于 640，滑杆自动恢复行程。
     */
    function pageFloor(limit = FALLBACK_MAX) {
      return Math.min(HOST_MIN, limit)
    }

    /** 鼠标拖动按 10px 吸附，最右端独立表示可设上限。原生范围始终用真实像素。 */
    function sliderValueToWidth(position, limit) {
      if (position >= limit) return limit
      const lastStep = (Math.ceil(limit / STEP) - 1) * STEP
      const nearest = Math.round(position / STEP) * STEP
      return Math.max(pageFloor(limit), Math.min(lastStep, nearest))
    }

    /**
     * 精确值的数值归一化：clamp 到 [min, limit] 后取整，不吸附步进
     * （精确输入允许任意整数，如 821）；非有限数返回 null。
     * min 默认跟随当前上限（宽窗口即宿主下限 640）；读取已保存偏好时传
     * 安全整数上限与旧版存储下限：窗口变化不能截断已保存的宽度。
     */
    function normalizeWidthValue(value, limit = FALLBACK_MAX, min = pageFloor(limit)) {
      if (!Number.isFinite(value)) return null
      return Math.min(limit, Math.max(min, Math.round(value)))
    }

    /** 文本输入归一化：空串与非数字视为非法返回 null（调用方回退原值），其余同数值版。 */
    function normalizeExactWidth(text, limit = FALLBACK_MAX) {
      const trimmed = String(text).trim()
      if (trimmed === '') return null
      return normalizeWidthValue(Number(trimmed), limit)
    }

    /**
     * 把宿主宽度轴声明折算成像素数。宿主无拖拽偏好时声明形如
     * `clamp(680px, calc(<列宽px> * 0.64), 920px)`（自定义属性的 computed 值只做
     * var() 替换、不求值函数），有偏好时是纯 `836px`；这里用一个只支持
     * `+ - * /`、括号与 `calc/min/max/clamp` 的小型求值器统一处理两种形态。
     * 主会话的轴不会出现依赖消费上下文的单位；出现 `%` 等无法换算的单位时返回 NaN
     * （侧栏嵌入式会话的 `min(calc(100% - 32px), 920px)` 属于另一种布局，已单独排除）。
     */
    function evalWidthExpr(source) {
      let pos = 0
      const skipSpaces = () => { while (source[pos] === ' ') pos++ }
      function parseExpr() {
        let value = parseTerm()
        skipSpaces()
        while (source[pos] === '+' || source[pos] === '-') {
          const op = source[pos]
          pos++
          const rhs = parseTerm()
          value = op === '+' ? value + rhs : value - rhs
          skipSpaces()
        }
        return value
      }
      function parseTerm() {
        let value = parseFactor()
        skipSpaces()
        while (source[pos] === '*' || source[pos] === '/') {
          const op = source[pos]
          pos++
          const rhs = parseFactor()
          value = op === '*' ? value * rhs : value / rhs
          skipSpaces()
        }
        return value
      }
      function parseFactor() {
        skipSpaces()
        const ch = source[pos]
        if (ch === undefined) return Number.NaN
        if (ch === '-') { pos++; return -parseFactor() }
        if (ch === '(') {
          pos++
          const value = parseExpr()
          skipSpaces()
          if (source[pos] !== ')') return Number.NaN
          pos++
          return value
        }
        if (/[a-zA-Z]/.test(ch)) {
          let start = pos
          while (source[pos] !== undefined && /[a-zA-Z]/.test(source[pos])) pos++
          const name = source.slice(start, pos)
          skipSpaces()
          if (source[pos] !== '(') return Number.NaN
          pos++
          const args = [parseExpr()]
          skipSpaces()
          while (source[pos] === ',') {
            pos++
            args.push(parseExpr())
            skipSpaces()
          }
          if (source[pos] !== ')') return Number.NaN
          pos++
          if (name === 'calc') return args.length === 1 ? args[0] : Number.NaN
          if (name === 'min') return Math.min(...args)
          if (name === 'max') return Math.max(...args)
          if (name === 'clamp') {
            return args.length === 3 ? Math.min(Math.max(args[0], args[1]), args[2]) : Number.NaN
          }
          return Number.NaN
        }
        if (/[0-9.]/.test(ch)) {
          let start = pos
          while (source[pos] !== undefined && /[0-9.]/.test(source[pos])) pos++
          const value = Number(source.slice(start, pos))
          skipSpaces()
          if (source.startsWith('px', pos)) { pos += 2; return value }
          // 无单位数合法（乘法因子，如 0.64）；其它单位（% / em / vw…）无法换算
          if (source[pos] === undefined || !/[a-zA-Z%]/.test(source[pos])) return value
          return Number.NaN
        }
        return Number.NaN
      }
      const result = parseExpr()
      skipSpaces()
      return pos === source.length && Number.isFinite(result) ? result : Number.NaN
    }

    /** 「找不到会话内容元素」只告警一次：这是宿主钩子改名的自检信号。 */
    let contentElementWarned = false

    /**
     * 会话主体元素当前是否可见。用 rect 尺寸判断，不用 offsetParent：
     * 会话主体在 flex / sticky 布局里 offsetParent 可能为 null，但仍在屏幕上。
     */
    function isContentVisible(element) {
      if (!element.isConnected) return false
      const style = window.getComputedStyle(element)
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
        return false
      }
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }

    /** 是否是宿主侧栏里的嵌入式子会话：它有自己的宽度轴，插件不参与。 */
    function isEmbeddedContent(element) {
      return element != null && typeof element.closest === 'function'
        && element.closest(EMBEDDED_SELECTOR) !== null
    }

    /** 可见面积：设置页没有锚点也没有焦点时，用它挑最大的主会话。 */
    function contentArea(element) {
      const rect = element.getBoundingClientRect()
      return rect.width * rect.height
    }

    /**
     * 选出自动读数要跟随的主会话主体元素。
     *
     * 宿主的主会话与侧栏嵌入式子会话（ui-subagent 的 sidebar chat）都会带
     * `[data-conversation-content]`，且元素会随会话生命周期延迟出现、整体替换，
     * 所以每次刷新都重新选，不再用 `querySelector` 固定第一个匹配项。
     * 嵌入式会话的宽度轴由侧栏面板宽度算出，也不消费主会话的拖拽偏好；
     * 插件只服务主会话，这类元素一律排除，避免读数落到别的布局上：
     *
     * 1. anchor：dock 渲染在会话内部时，锚点所属的会话就是读数对象；
     * 2. 焦点：用户正在输入哪个会话就跟随哪个（多会话并列时最可靠）；
     * 3. 可见面积最大：设置页没有锚点，按面积挑主会话（宿主通常只有一个）；
     * 4. 全都不可见时返回 null，避免拿隐藏元素的陈旧读数。
     */
    function pickContentElement(anchor) {
      const anchored = anchor && anchor.closest ? anchor.closest(CONTENT_SELECTOR) : null
      if (anchored && !isEmbeddedContent(anchored) && isContentVisible(anchored)) return anchored
      const candidates = Array.from(document.querySelectorAll(CONTENT_SELECTOR))
        .filter((element) => !isEmbeddedContent(element) && isContentVisible(element))
      if (candidates.length === 0) return null
      const focused = document.activeElement && document.activeElement.closest
        ? document.activeElement.closest(CONTENT_SELECTOR)
        : null
      if (focused && candidates.includes(focused)) return focused
      return candidates.reduce((best, element) => (
        contentArea(element) > contentArea(best) ? element : best
      ))
    }

    /**
     * 在 `[data-conversation-scroll]` 里找出正文列。
     *
     * 不依赖宿主的散列 class。正文列的 `max-width` 始终引用宽度轴，但计算后的
     * 形态随模式变化：
     * - 插件固定模式：`min(<px>, 100%)`；
     * - 宿主自动模式或拖拽偏好：宿主把轴解析成纯像素（如 `680px` / `836px`）；
     * - 轴还没落定时：`clamp(...)`。
     * 三种形态都收作候选，然后排除 composer 区域（输入卡片比正文列宽 32px），
     * 只保留「不被其它候选包含」的最外层候选，再取宽度最大的那个——正文列是
     * 所有消息内容的祖先。找不到时返回 null，由调用方回退 FALLBACK_MAX。
     */
    function isWidthColumnCandidate(maxWidth) {
      return maxWidth.startsWith('min(')
        || maxWidth.startsWith('clamp(')
        || /^\d+(?:\.\d+)?px$/.test(maxWidth)
    }

    function findWidthColumn(scroll) {
      const candidates = []
      for (const element of scroll.querySelectorAll('*')) {
        if (element.closest(COMPOSER_SELECTOR) !== null) continue
        if (!isWidthColumnCandidate(window.getComputedStyle(element).maxWidth)) continue
        const rect = element.getBoundingClientRect()
        if (rect.width <= 0) continue
        candidates.push({ element, width: rect.width })
      }
      if (candidates.length === 0) return null
      const outermost = candidates.filter((candidate) => (
        !candidates.some((other) => (
          other !== candidate && other.element.contains(candidate.element)
        ))
      ))
      return outermost.reduce((best, candidate) => (
        candidate.width > best.width ? candidate : best
      ))
    }

    /**
     * 正文列父元素的内容盒宽度：正文列是 `width: 100%`，它的 100% 就是这个值。
     * 父元素可能带左右 padding（实测聊天滚动区 32px），必须扣掉。
     */
    function parentContentWidth(parent) {
      if (parent === null) return null
      const style = window.getComputedStyle(parent)
      const left = Number.parseFloat(style.paddingLeft)
      const right = Number.parseFloat(style.paddingRight)
      const available = parent.clientWidth
        - (Number.isFinite(left) ? left : 0)
        - (Number.isFinite(right) ? right : 0)
      return Number.isFinite(available) && available > 0 ? Math.round(available) : null
    }

    /**
     * 宿主发布的主会话列宽：滑杆上限按它 − CONTENT_EDGE_BUDGET 复算，
     * 与自动模式的手柄域完全一致。读不到（变量未发布 / 宿主改版）返回 null。
     */
    function hostColumnWidth(element) {
      if (element === null) return null
      const raw = window.getComputedStyle(element).getPropertyValue(COLUMN_VAR).trim()
      const width = Number.parseFloat(raw)
      return Number.isFinite(width) && width > 0 ? width : null
    }

    /** 即使聊天视图还在回放历史，宿主滚动区也已经为正文保留了宽度。 */
    function transcriptSpace(content, scroll) {
      const clearance = window.getComputedStyle(content)
        .getPropertyValue('--dsh-composer-side-clearance').trim()
      if (!/^\d+(?:\.\d+)?px$/.test(clearance)) return null
      const width = parentContentWidth(scroll)
      // 宿主正文的两侧各比输入卡片多留 16px。
      return width === null ? null : Math.max(1, width - 2 * (Number.parseFloat(clearance) + 16))
    }

    /**
     * 滑杆上限，按宿主自己的拖拽口径取：`max(CONTENT_MIN, 列宽 − CONTENT_EDGE_BUDGET)`。
     *
     * 宿主把 176px 留给两侧手柄与呼吸边距；固定模式虽然隐藏了手柄，上限仍按同一
     * 口径算，滑杆最右就是自动模式手柄最右，不会出现固定比自动更宽的错位。
     * 窗口被挤压到正文列铺不满时（可用宽度更小），上限跟着收紧，滑杆最右仍是
     * 正文列真正铺满的位置。读不到列宽时退回父元素内容盒宽度，再测不到才用
     * FALLBACK_MAX 兜底（设置页无会话、宿主结构变化）。
     */
    function toPageLimit(available, column = null) {
      if (column === null) {
        if (available === null) return FALLBACK_MAX
        // 没有列宽时退回父元素内容盒宽度：不吸附步进，余数同样保留
        return Math.max(1, Math.round(available))
      }
      // 宿主手柄的上限：max(CONTENT_MIN, 列宽 − 176)
      const handleMax = Math.max(HOST_MIN, column - HOST_EDGE_BUDGET)
      if (available === null) return Math.round(handleMax)
      // 取「手柄能力」与「正文列实际能铺多宽」的较小者，两者都是自动模式的上界
      return Math.max(1, Math.round(Math.min(available, handleMax)))
    }

    /**
     * 读宿主当前实际生效的内容宽度轴与来源。
     * 设置页可以在没有会话的情况下打开，因此只在会话控件中传入告警文案。
     */
    function readAutoWidth(element, missingContentWarning, cache = null) {
      if (!element || !element.isConnected) {
        // 只有页面里确实没有该元素时才提示宿主结构变化；元素存在但暂时不可见
        // （折叠会话）不是结构问题，不应误报。
        if (missingContentWarning && !contentElementWarned && document.querySelector(CONTENT_SELECTOR) === null) {
          contentElementWarned = true
          console.warn('[dsh-widthkeeper] ' + missingContentWarning)
        }
        return null
      }
      const declared = window.getComputedStyle(element).getPropertyValue(AXIS_VAR).trim()
      const axisWidth = evalWidthExpr(declared)
      /**
       * 两个层次的值：
       * - prescribed：用户/公式**设定**的宽度。有拖拽偏好时取偏好本身（宿主会把
       *   它夹到当前上限，夹过的轴值不是用户设的值）；没有偏好时取公式算出的轴值。
       * - width：正文列**此刻实际渲染**的宽度，受 100% 与可用宽度约束。
       * 窗口挤压时 width < prescribed，提示要把两者都说出来：缩窗看到的是临时值，
       * 拉宽后回到 prescribed。
       */
      const dragging = element.querySelector('[data-width-handle][data-dragging]') !== null
      const preference = hostWidthPreference()
      const axisPixels = Number.isFinite(axisWidth) ? Math.round(axisWidth) : null
      const prescribed = preference !== null
        ? Math.round(preference)
        : axisPixels
      const scroll = element.querySelector(SCROLL_SELECTOR)
      const measured = measuredContentWidth(scroll, cache)
      const available = measured === null && scroll !== null ? transcriptSpace(element, scroll) : null
      const width = measured ?? (axisPixels !== null && available !== null
        ? Math.min(axisPixels, available)
        : axisPixels)
      return {
        width,
        prescribed,
        // 实际渲染比设定窄：窗口挤压中（留 1px 余量给舍入）
        squeezed: width !== null && prescribed !== null && width < prescribed - 1,
        dragged: preference !== null,
        dragging,
      }
    }

    /**
     * 正文列当前实际渲染宽度：正文列是 width:100% + max-width:轴值，
     * 所以真实宽度 = min(轴值, 可用宽度)。量它自己的矩形即可；
     * 测不到（不可见、0 宽）时返回 null，由调用方回退声明值。
     */
    function measuredContentWidth(scroll, cache = null) {
      if (scroll === null) return null
      /**
       * 拖手柄时每帧都会读一次：缓存正文列引用，命中时只量一次矩形，
       * 不再对整棵消息树做 querySelectorAll + getComputedStyle（实测 76 个候选）。
       * 元素失效（会话切换、正文列被替换）时重扫一次。
       */
      if (cache !== null
        && cache.scroll === scroll
        && cache.element !== null
        && cache.element.isConnected
        && scroll.contains(cache.element)) {
        const cachedWidth = Math.round(cache.element.getBoundingClientRect().width)
        if (cachedWidth > 0) return cachedWidth
      }
      const found = findWidthColumn(scroll)
      if (found === null) return null
      if (cache !== null) {
        cache.scroll = scroll
        cache.element = found.element
      }
      const width = Math.round(found.width)
      return width > 0 ? width : null
    }

    /**
     * 宿主内置拖拽偏好：用户通过正文手柄设定的宽度（未经上限夹取的原值）。
     * 判据与宿主 ConversationWidthControls 一致：有效正数才作数。没有时返回 null。
     */
    function hostWidthPreference() {
      try {
        const raw = window.localStorage.getItem(HOST_WIDTH_KEY)
        if (raw === null) return null
        const value = Number(raw)
        return Number.isFinite(value) && value > 0 ? value : null
      } catch {
        return null
      }
    }

    /**
     * 读数的「来源 + 挤压」尾巴。非挤压时只是来源标签。
     *
     * 挤压时当前宽度不是用户设的值，而是窗口上限，所以不能把来源标签挂在它后面
     * ——那会读成「我拖出 1014」。此时当前值标「本窗口上限」，来源随目标值一起说：
     * - 拖过手柄：`1014px（本窗口上限） · 拖手柄设过的 1200px，拉宽窗口后恢复`
     * - 公式计算：`629px（按窗口计算） · 窗口太窄，正文被挤压`
     *
     * 只有「拖过手柄」才敢报目标数字——那时 prescribed 是稳定的手柄偏好，窗口
     * 拉宽确实会回到它。公式态的 prescribed 本身随窗口变化，报具体值会说错。
     */
    function readoutTail(t, info) {
      if (info.dragging) return t('sourceDragging')
      if (!info.squeezed) return t(info.dragged ? 'sourceDragged' : 'sourceFormula')
      if (info.dragged && info.prescribed !== null) {
        return t('sourceCapped') + t('autoReadoutSqueezed').replace('{v}', String(info.prescribed))
      }
      return t(info.dragged ? 'sourceDragged' : 'sourceFormula') + t('autoReadoutCramped')
    }

    function autoReadoutText(t, info) {
      if (!info || info.width === null) return null
      return t('autoReadout').replace('{v}', String(info.width)) + readoutTail(t, info)
    }

    /**
     * 设置页用的读数文案：该行的标签已经是「当前自动宽度」，值里不再重复
     * 「自动 ·」前缀，只留数值与来源。
     */
    function autoReadoutValue(t, info) {
      if (!info || info.width === null) return null
      return String(info.width) + 'px' + readoutTail(t, info)
    }

    /** 读取持久化偏好；缺省即固定为 DEFAULT_VALUE 并显示控件。 */
    function readPreference() {
      try {
        const enabled = window.localStorage.getItem(ENABLED_KEY) !== '0'
        const raw = window.localStorage.getItem(VALUE_KEY)
        const parsed = raw === null ? Number.NaN : Number(raw)
        const value = normalizeWidthValue(parsed, Number.MAX_SAFE_INTEGER, MIN)
        return {
          enabled,
          value: value === null ? DEFAULT_VALUE : value,
          dockVisible: window.localStorage.getItem(DOCK_VISIBLE_KEY) !== '0',
        }
      } catch {
        return { enabled: true, value: DEFAULT_VALUE, dockVisible: true }
      }
    }

    /** 尽力持久化；存储被禁用也不能影响实时控件。 */
    function writePreference(state) {
      try {
        window.localStorage.setItem(ENABLED_KEY, state.enabled ? '1' : '0')
        window.localStorage.setItem(VALUE_KEY, String(state.value))
        window.localStorage.setItem(DOCK_VISIBLE_KEY, state.dockVisible ? '1' : '0')
      } catch { /* 存储不可用（隐私模式）：只保留内存状态 */ }
    }

    /** 一份偏好供所有挂载实例共享（槽位是常驻的，但不保证单例）。 */
    function createStore() {
      let state = readPreference()
      const listeners = new Set()
      const same = (a, b) => a.enabled === b.enabled
        && a.value === b.value
        && a.dockVisible === b.dockVisible
      return {
        get: () => state,
        update(patch) {
          const next = {
            enabled: patch.enabled ?? state.enabled,
            value: patch.value ?? state.value,
            dockVisible: patch.dockVisible ?? state.dockVisible,
          }
          if (same(next, state)) return
          state = next
          writePreference(state)
          for (const listener of [...listeners]) listener()
        },
        /** 恢复默认：清除本插件自有的三个键，回到初始固定宽度并显示控件。 */
        reset() {
          try {
            window.localStorage.removeItem(ENABLED_KEY)
            window.localStorage.removeItem(VALUE_KEY)
            window.localStorage.removeItem(DOCK_VISIBLE_KEY)
          } catch { /* 存储不可用：内存状态照常恢复 */ }
          state = { enabled: true, value: DEFAULT_VALUE, dockVisible: true }
          for (const listener of [...listeners]) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      }
    }

    /**
     * 生成主会话的宽度轴规则；自动模式返回空串。
     *
     * `:not([data-sidebar-chat] *)` 把侧栏嵌入式子会话排除在外：它有宿主自己的
     * `min(calc(100% - 32px), 920px)` 轴与更窄的 composer 边距，固定值会吃掉侧栏的
     * 16px 留白；嵌入式会话也不渲染原生手柄，不需要隐藏。
     */
    function axisCss(state) {
      if (!state.enabled) return ''
      return 'html [data-conversation-content]:not(' + EMBEDDED_SELECTOR + ' *)'
        + '{--dsh-chat-content-width:min(' + state.value + 'px,100%)}'
        + 'html [data-width-handle]{display:none}'
    }

    /**
     * 把宽度规则挂到 document.head，生命周期跟随插件 activation 而不是 dock 组件。
     *
     * 宿主只在 `variant === 'composer'` 且有会话、有输入时投影
     * `conversation.composer.dock`；无会话（hero）、dock 被宿主整体卸载时，
     * 组件内的 <style> 会一起消失，固定宽度与「隐藏原生手柄」也就失效了。
     * 规则是文档级的，渲染位置不应由某个控件决定；这里用 static <style> 常驻，
     * store 变化只改文本，卸载时整体移除。
     */
    function installAxisStyle(ctx, store) {
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-widthkeeper'
        tag.dataset.pluginCss = 'dsh-widthkeeper/axis'
        const sync = () => { tag.textContent = axisCss(store.get()) }
        sync()
        document.head.appendChild(tag)
        const unsubscribe = store.subscribe(sync)
        return () => {
          unsubscribe()
          tag.remove()
        }
      }, 'dsh-widthkeeper: width axis stylesheet')
    }

    /** 订阅共享 store 的本地镜像；dock 与设置页共用。 */
    function useStoreState(store) {
      const [state, setState] = React.useState(store.get)
      React.useEffect(() => store.subscribe(() => { setState(store.get()) }), [store])
      return state
    }

    /** 会话挂载、切换或替换时重新选取观察目标。 */
    function observeConversationStructure(schedule, needsMeasure) {
      const selector = CONTENT_SELECTOR + ', ' + SCROLL_SELECTOR
      const matches = (node) => node.nodeType === 1
        && (node.matches(selector) || node.querySelector(selector) !== null)
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          const changed = record.type === 'attributes'
            ? record.target.matches(CONTENT_SELECTOR)
            : needsMeasure(record)
              || Array.prototype.some.call(record.addedNodes, matches)
              || Array.prototype.some.call(record.removedNodes, matches)
          if (!changed) continue
          schedule()
          return
        }
      })
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-conversation-session', 'data-content-phase'],
      })
      return observer
    }

    /**
     * 自动宽度随主会话、布局和手柄拖动刷新。会话控件优先读锚点所在会话，
     * 设置页则从可见的主会话中选取目标。
     */
    function useAutoWidth(active, anchorRef, missingContentWarning) {
      const [info, setInfo] = React.useState(null)
      React.useLayoutEffect(() => {
        if (!active) return
        let target = null
        let frame = 0
        let disposed = false
        let resizeObserver = null
        let intersectionObserver = null
        const observedContent = new Set()
        /** 正文列引用缓存：拖手柄时每帧读数复用，避免反复全树扫描。 */
        const columnCache = { scroll: null, element: null }

        const commit = () => {
          const next = readAutoWidth(target, missingContentWarning, columnCache)
          setInfo((prev) => {
            if (prev && next
              && prev.width === next.width
              && prev.prescribed === next.prescribed
              && prev.squeezed === next.squeezed
              && prev.dragged === next.dragged
              && prev.dragging === next.dragging) return prev
            return next
          })
        }

        /**
         * 只观察主会话元素：当前目标可能一直可见，主会话从设置页 / 折叠状态恢复可见时，
         * 仅观察 target 收不到通知。侧栏嵌入式会话已从候选中排除，不必观察。
         * 候选数量很少（通常只有一个主会话），集合按需增删。
         */
        const syncVisibilityObservers = () => {
          const current = new Set(
            Array.from(document.querySelectorAll(CONTENT_SELECTOR))
              .filter((element) => !isEmbeddedContent(element)),
          )
          intersectionObserver ??= new IntersectionObserver(schedule)
          for (const element of current) {
            if (observedContent.has(element)) continue
            observedContent.add(element)
            intersectionObserver.observe(element)
          }
          for (const element of observedContent) {
            if (current.has(element)) continue
            observedContent.delete(element)
            intersectionObserver.unobserve(element)
          }
        }

        const schedule = () => {
          if (frame !== 0) return
          frame = window.requestAnimationFrame(() => {
            frame = 0
            const anchor = anchorRef ? anchorRef.current : null
            syncVisibilityObservers()
            bind(pickContentElement(anchor))
            commit()
          })
        }

        const bind = (element) => {
          if (element === target) return
          target = element
          // 会话换了：正文列缓存作废
          columnCache.scroll = null
          columnCache.element = null
          resizeObserver?.disconnect()
          resizeObserver = null
          observeStyle()
          if (target === null) return
          resizeObserver = new ResizeObserver(schedule)
          resizeObserver.observe(target)
        }

        const refresh = () => {
          const anchor = anchorRef ? anchorRef.current : null
          syncVisibilityObservers()
          bind(pickContentElement(anchor))
          commit()
        }

        const mutations = observeConversationStructure(schedule, (record) =>
          (columnCache.element === null || !columnCache.element.isConnected)
            && target?.contains(record.target)
            && record.target.closest(SCROLL_SELECTOR) !== null,
        )

        /**
         * 手柄拖拽实时同步：宿主把 --dsh-chat-user-width 写在正文列的父元素行内 style 上，
         * 正文列自身尺寸不变，ResizeObserver 收不到；这里盯住父元素的 style 属性。
         * 每帧最多读一次（schedule 已用 rAF 合并），拖拽结束由 pointerup 补测。
         */
        const styleObserver = new MutationObserver(schedule)
        const observeStyle = () => {
          const parent = target === null ? null : target.parentElement
          styleObserver.disconnect()
          if (parent !== null) styleObserver.observe(parent, { attributes: true, attributeFilter: ['style'] })
          if (target !== null) {
            styleObserver.observe(target, { subtree: true, attributes: true, attributeFilter: ['data-dragging'] })
          }
        }

        refresh()
        if (anchorRef && flushSync && target !== null && hostColumnWidth(target) === null) {
          // 子组件可能先于宿主发布宽度轴。宿主提交结束后再读一次，在绘制前更新滑块。
          queueMicrotask(() => {
            if (!disposed) flushSync(refresh)
          })
        }
        window.addEventListener('pointerup', schedule)
        document.addEventListener('focusin', schedule)
        return () => {
          disposed = true
          mutations.disconnect()
          styleObserver.disconnect()
          resizeObserver?.disconnect()
          intersectionObserver?.disconnect()
          window.removeEventListener('pointerup', schedule)
          document.removeEventListener('focusin', schedule)
          if (frame !== 0) window.cancelAnimationFrame(frame)
        }
      }, [active, anchorRef, missingContentWarning])
      return active ? info : null
    }

    /**
     * 当前页面的宽度上限（滑杆与输入的 max）。
     *
     * 测量结果只随「正文列可用宽度」变化，而它会随窗口缩放、侧栏 / 右栏开合、
     * 滚动条出现而变化，所以用 ResizeObserver 盯住会话滚动区，而不是只测一次。
     * 正文列元素与父元素按引用缓存：窗口拖动时每帧只读一次父元素尺寸，不重扫
     * 消息 DOM（流式输出时消息节点很多，全量 getComputedStyle 会明显掉帧）。
     * 缓存失效（正文列被替换、会话切换、切到不可见会话）时重扫一次。
     *
     * 测不到时返回 FALLBACK_MAX（设置页无会话、hero 阶段、宿主改版），
     * 行为与 0.2.1 的固定上限一致。anchorRef 传 dock 根节点让测量跟随当前会话；
     * 设置页没有锚点，交给 pickContentElement 按可见面积挑主会话。
     */
    function usePageWidthLimit(anchorRef, active = true) {
      const [limit, setLimit] = React.useState(FALLBACK_MAX)
      // layout effect：首帧同步测量一次，滑杆/输入不会先按兜底上限渲染一帧再跳
      React.useLayoutEffect(() => {
        if (!active) return
        let frame = 0
        let observed = null
        let cached = null
        let measuredScroll = null

        const measure = () => {
          const content = pickContentElement(anchorRef ? anchorRef.current : null)
          const scroll = content === null ? null : content.querySelector(SCROLL_SELECTOR)
          measuredScroll = null
          if (scroll === null) {
            cached = null
            return FALLBACK_MAX
          }
          const available = transcriptSpace(content, scroll)
          if (available !== null) {
            // 宿主在 layout effect 发布变量，首次测量直接用它所读取的主体宽度。
            measuredScroll = scroll
            cached = null
            return toPageLimit(available, content.offsetWidth)
          }
          // 缓存的正文列仍属于当前滚动区且可见：只读父元素尺寸
          if (cached !== null
            && cached.element.isConnected
            && cached.element.parentElement === cached.parent
            && scroll.contains(cached.element)
            && isContentVisible(cached.element)) {
            return toPageLimit(parentContentWidth(cached.parent), hostColumnWidth(cached.parent))
          }
          const found = findWidthColumn(scroll)
          cached = found === null ? null : {
            element: found.element,
            parent: found.element.parentElement,
          }
          return toPageLimit(
            found === null ? null : parentContentWidth(found.element.parentElement),
            found === null ? null : hostColumnWidth(found.element.parentElement),
          )
        }

        const commit = () => { setLimit(measure()) }

        const schedule = () => {
          if (frame !== 0) return
          frame = window.requestAnimationFrame(() => {
            frame = 0
            bind()
            commit()
          })
        }

        const observer = new ResizeObserver(schedule)

        const bind = () => {
          const content = pickContentElement(anchorRef ? anchorRef.current : null)
          const next = content === null ? null : content.querySelector(SCROLL_SELECTOR)
          if (next === observed) return
          observer.disconnect()
          observed = next
          if (observed !== null) observer.observe(observed)
        }

        // 首帧同步测量 + 绑定；之后窗口/侧栏变化由 ResizeObserver 触发
        commit()
        bind()
        const mutations = observeConversationStructure(
          schedule,
          // 滚动区已提供尺寸时，普通正文节点的增删不影响上限。
          (record) => observed !== null && observed !== measuredScroll && observed.contains(record.target)
            && (cached === null || !cached.element.isConnected),
        )
        // 会话切换 / dock 重挂后锚点变化；拖动正文手柄时滚动区尺寸不变，
        // 只在 pointerup 补测一次（与自动读数同样的理由，避免拖拽期间频繁重测）
        window.addEventListener('pointerup', schedule)
        document.addEventListener('focusin', schedule)
        return () => {
          observer.disconnect()
          mutations.disconnect()
          window.removeEventListener('pointerup', schedule)
          document.removeEventListener('focusin', schedule)
          if (frame !== 0) window.cancelAnimationFrame(frame)
        }
      }, [active, anchorRef])
      /** 返回当前页面上限：对手柄存在取宿主手柄域，手柄被收掉时取挤压后的可用宽度。 */
      return active ? limit : FALLBACK_MAX
    }

    /**
     * 固定态值按钮展开的内联编辑层：数字输入 + 「使用自动宽度」。
     * Enter 提交、Esc 取消、失焦提交；非法输入（空 / 非数字）回退原值。
     */
    function WidthValueEditor(props) {
      const { store, t, limit, onClose } = props
      const [draft, setDraft] = React.useState(String(store.get().value))
      /** 打开编辑层时的已存值：草稿未改动时不写回，避免把超上限的大值夹成上限。 */
      const initialRef = React.useRef(String(store.get().value))
      const rootRef = React.useRef(null)
      const inputRef = React.useRef(null)
      const cancelRef = React.useRef(null)
      /** 与 dock 同一判据：上下限贴合时自动模式也调不动，编辑层不接受新值。 */
      const readOnly = pageFloor(limit) >= limit

      React.useLayoutEffect(() => {
        if (readOnly) {
          cancelRef.current?.focus()
          return
        }
        inputRef.current?.focus()
        inputRef.current?.select()
      }, [readOnly])

      function commit(restoreFocus) {
        // 草稿未改动：不写回。已存值可能超出当前页面上限，按最大展示即可，
        // 不能因为打开一次编辑层就把它夹成上限。
        if (draft.trim() === initialRef.current || readOnly) {
          onClose(restoreFocus)
          return
        }
        const normalized = normalizeExactWidth(draft, limit)
        if (normalized !== null) store.update({ enabled: true, value: normalized })
        onClose(restoreFocus)
      }

      // 有些浏览器点击按钮时不给按钮焦点。让按钮动作先于输入框失焦提交。
      function keepEditorFocus(event) {
        if (event.button === 0) event.preventDefault()
      }

      return h('div', {
        className: 'wk-edit',
        ref: rootRef,
        onKeyDown: (event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          onClose(true)
        },
        onBlur: (event) => {
          // 焦点移出编辑层才提交；在层内移动焦点（如点到「使用自动宽度」）不触发
          const next = event.relatedTarget
          if (next instanceof Node && rootRef.current && rootRef.current.contains(next)) return
          commit(false)
        },
      },
        h('input', {
          ref: inputRef,
          className: 'wk-edit-input',
          type: 'number',
          name: 'dsh-widthkeeper-exact',
          inputMode: 'numeric',
          min: pageFloor(limit),
          max: limit,
          step: 1,
          value: draft,
          disabled: readOnly,
          'aria-label': t('widthInputLabel')
            .replace('{min}', String(pageFloor(limit)))
            .replace('{max}', String(limit)),
          onChange: (event) => { setDraft(event.target.value) },
          onKeyDown: (event) => {
            if (event.key === 'Enter') { event.preventDefault(); commit(true) }
          },
        }),
        h('span', { className: 'wk-edit-unit' }, 'px'),
        h('button', {
          className: 'wk-mode',
          type: 'button',
          onPointerDown: keepEditorFocus,
          onClick: () => { store.update({ enabled: false }); onClose(true) },
        }, t('useAuto')),
        h('button', {
          className: 'wk-mode',
          type: 'button',
          ref: cancelRef,
          onPointerDown: keepEditorFocus,
          onClick: () => { onClose(true) },
        }, t('cancelEdit')),
      )
    }

    /**
     * 把锚点包进宿主 Tooltip；插件内控件（滑杆、值按钮、设置页按钮）共用这一种提示样式。
     * 宿主未提供 primitives 时原样返回锚点，不显示提示（不再使用原生 title）。
     * portal 避免气泡被 composer 的裁剪容器或堆叠上下文切掉。
     */
    function wrapWithTooltip(label, anchor, align) {
      if (HostTooltip === null) return anchor
      return h(HostTooltip, {
        label,
        side: 'top',
        align,
        gap: 6,
        delayMs: 120,
        maxWidth: 320,
        portal: true,
      }, anchor)
    }

    /**
     * 输入框卡片下方的控件：一根宽度滑杆 + 一个值按钮（固定态可展开精确输入）。
     * props 由本插件 activation 提供：store（共享偏好）与 t（翻译）。
     * 宽度规则由 installAxisStyle 常驻注入，与这里的显隐、挂载无关。
     */
    function WidthDock(props) {
      const { store, t } = props
      const state = useStoreState(store)
      const [editing, setEditing] = React.useState(false)
      const rootRef = React.useRef(null)
      const modeRef = React.useRef(null)
      const restoreFocusRef = React.useRef(false)
      React.useLayoutEffect(() => {
        if (editing || !restoreFocusRef.current) return
        restoreFocusRef.current = false
        modeRef.current?.focus()
      }, [editing])
      /**
       * dock 也会挂在侧栏嵌入式子会话的 composer 里，但那里的宽度由侧栏面板决定，
       * 滑杆只会改主会话，显示出来是误导。每次 root 挂载后按宿主包装标记判定；
       * 判定为嵌入式后 dock 自身不再渲染（root 变 null），所以只在有 root 时更新，
       * 避免「卸载 root → 判回主会话」的循环。
       */
      const [embedded, setEmbedded] = React.useState(false)
      const embeddedRef = React.useRef(false)
      React.useLayoutEffect(() => {
        const node = rootRef.current
        if (node === null) return
        const next = node.closest(EMBEDDED_SELECTOR) !== null
        if (next === embeddedRef.current) return
        embeddedRef.current = next
        setEmbedded(next)
      })
      const mode = state.enabled ? 'pinned' : 'auto'
      // 锚点让自动读数跟随 dock 所在会话，而不是页面第一个会话主体元素
      const autoInfo = useAutoWidth(
        mode === 'auto' && !embedded,
        rootRef,
        t('missingContentWarning').replace('{selector}', CONTENT_SELECTOR),
      )
      // 当前页面正文列铺满的宽度：滑杆与精确输入的 max，页面尺寸变化时刷新
      const pageLimit = usePageWidthLimit(rootRef, !embedded)
      const pageMin = pageFloor(pageLimit)
      /**
       * 滑杆实际取值：自动模式下跟随宿主当前读数（拖正文手柄时实时走），
       * 固定模式下是已存宽度（超出当前页面范围时按边界展示，值本身不写回）。
       */
      const autoWidth = autoInfo === null ? null : autoInfo.width
      const sliderWidth = state.enabled
        ? state.value
        : (autoWidth === null ? state.value : autoWidth)
      const sliderPosition = Math.min(Math.max(sliderWidth, pageMin), pageLimit)
      // 模式被其它入口（设置页 / 编辑层自身）切到自动时收起编辑层，避免停在过期草稿上
      React.useEffect(() => { setEditing(false) }, [state.enabled])

      // 已存值超出当前可设上限时，控件显示上限，保存的值不变。
      const overflow = state.enabled && state.value > pageLimit
      // 低于当前下限（窄窗口里设过的窄值，换到宽窗口后）：滑块停在左端，值本身同样不写回
      const underflow = state.enabled && state.value < pageMin
      // 可设范围只剩一个值时，禁止拖动滑杆和输入新宽度，仍可以切换模式。
      const readOnly = pageLimit <= pageMin
      /**
       * 占位符替换：同一个键可能在一条文案里出现多次（如 {max}），
       * String.prototype.replace 只换第一处，所以统一用 split/join 全量替换。
       */
      const fill = (template, values) => Object.entries(values)
        .reduce((text, [key, value]) => text.split(key).join(value), template)
      const pinnedTooltip = overflow
        ? fill(t('pinnedOverflowTooltip'), {
          '{v}': String(state.value),
          '{max}': String(pageLimit),
        })
        : underflow
          ? fill(t('pinnedUnderflowTooltip'), {
            '{v}': String(state.value),
            '{min}': String(pageMin),
          })
          : t('pinnedTooltip')
      const autoReadout = autoReadoutText(t, autoInfo)
      const modeTooltip = state.enabled
        ? (readOnly ? t('pinnedTooltipReadonly') : pinnedTooltip)
        : (autoReadout === null ? t('autoTooltip') : autoReadout + t('autoTooltipAction'))
      // 固定宽度的按钮读数受可设上限限制，正文则由保存值和容器可用空间决定。
      const shownWidth = state.enabled
        ? Math.min(state.value, pageLimit)
        : (autoWidth === null ? state.value : autoWidth)
      const modeButton = h('button', {
        className: 'wk-mode',
        type: 'button',
        ref: modeRef,
        'aria-pressed': state.enabled,
        // 只读档点开编辑层也改不了（输入框 disabled），aria 不能再说「点击编辑」
        'aria-label': state.enabled
          ? t(readOnly ? 'valueAriaReadonly' : 'valueAria').replace('{v}', String(shownWidth))
          : t('autoAria'),
        onClick: () => {
          if (state.enabled) {
            setEditing(true)
            return
          }
          /**
           * 自动态点击值按钮 = 把「宿主当前实际宽度」固定下来。
           * 用户的心智是「先用手柄调到满意，再一键钉住」；固定成上次的旧值
           * 会让读数与随后生效的宽度对不上。
           */
          const current = autoWidth === null ? null : Math.round(autoWidth)
          store.update(current === null
            ? { enabled: true }
            : { enabled: true, value: Math.min(Math.max(current, pageMin), pageLimit) })
        },
      }, state.enabled ? shownWidth + 'px' : t('auto'))
      const sliderTitle = (readOnly
        ? t('sliderTitleReadonly').replace('{v}', String(pageLimit))
        : t(state.enabled ? 'sliderTitle' : 'sliderTitleAuto').replace('{max}', String(pageLimit)))
      function setSliderWidth(width) {
        if (width === sliderPosition) return
        store.update({ enabled: true, value: width })
      }

      // 原生范围以像素表示，确保浏览器的无障碍树也能读取实际上下限和数值。
      const slider = h('input', {
        className: 'wk-range',
        type: 'range',
        name: 'dsh-widthkeeper-slider',
        min: pageMin,
        max: pageLimit,
        step: 1,
        value: sliderPosition,
        disabled: readOnly,
        'aria-label': t('slider'),
        'aria-valuetext': t('sliderValue').replace('{v}', String(sliderPosition)),
        'aria-readonly': readOnly || undefined,
        onKeyDown: (event) => {
          const direction = {
            ArrowRight: 1, ArrowUp: 1, PageUp: 1,
            ArrowLeft: -1, ArrowDown: -1, PageDown: -1,
          }[event.key]
          if (!direction || readOnly) return
          event.preventDefault()
          const steps = event.key.startsWith('Page')
            ? Math.max(1, Math.round((pageLimit - pageMin) / (10 * STEP)))
            : 1
          const position = sliderPosition / STEP
          const index = direction > 0 ? Math.floor(position) : Math.ceil(position)
          const width = Math.min(pageLimit, Math.max(pageMin, (index + direction * steps) * STEP))
          setSliderWidth(width)
        },
        onChange: (event) => {
          // 只读档（自动模式也调不动）不接受新值，只展示当前位置
          if (readOnly) return
          setSliderWidth(sliderValueToWidth(Number(event.target.value), pageLimit))
        },
      })
      // 插件内控件共用同一种宿主 Tooltip；不再设置原生 title
      const modeControl = wrapWithTooltip(modeTooltip, modeButton, 'end')
      const sliderControl = wrapWithTooltip(sliderTitle, slider, 'center')

      return state.dockVisible && !embedded ? h(React.Fragment, null,
        h('style', null, CHROME_CSS),
        h('div', { ref: rootRef, className: 'wk-dock', 'data-dsh-widthkeeper': mode },
          editing
            ? h(WidthValueEditor, {
              store,
              t,
              limit: pageLimit,
              onClose: (restoreFocus) => {
                restoreFocusRef.current = restoreFocus
                setEditing(false)
              },
            })
            : h(React.Fragment, null,
              sliderControl,
              modeControl,
            ),
        ),
      ) : null
    }

    /**
     * 设置页「内容宽度」分区：控件显隐、精确宽度、当前自动读数与恢复默认。
     * 与 dock 共享同一 store，任何一侧改动两边实时同步；设置页不依赖 dock 存在，
     * 是收起控件后唯一的恢复入口。
     */
    function WidthSettingsSection(props) {
      const { store, t } = props
      const state = useStoreState(store)
      const [draft, setDraft] = React.useState(String(state.value))
      /** 最近一次提交（或外部同步）到 store 的值；值没有实际变化时不改模式。 */
      const committedRef = React.useRef(String(state.value))
      const autoInfo = useAutoWidth(!state.enabled)
      const widthHintId = React.useId()
      /**
       * 设置页没有 dock 锚点，交给 pickContentElement 按可见面积挑主会话；
       * 宿主在设置页会卸载会话，测不到时回退 FALLBACK_MAX。
       */
      const pageLimit = usePageWidthLimit(undefined)
      const pageMin = pageFloor(pageLimit)
      /** 自动模式下这一行不是"当前宽度"，而是"切回固定时采用的值"。 */
      const isAuto = !state.enabled

      // 宽度被其它入口（滑杆 / 编辑层）改写时同步草稿与已提交值，避免显示过期值
      React.useEffect(() => {
        committedRef.current = String(state.value)
        setDraft(String(state.value))
      }, [state.value])

      function commitDraft() {
        // 草稿未改动：不碰 store。自动模式下点一下输入框再失焦不能切成固定；
        // 已存值超出当前页面上限时，也不能因为打开一次设置页就被夹成上限。
        if (draft.trim() === committedRef.current) {
          setDraft(committedRef.current)
          return
        }
        // 与 dock 同一判据：上下限贴合（自动模式也调不动）时不接受新值
        if (pageMin >= pageLimit) {
          setDraft(committedRef.current)
          return
        }
        const normalized = normalizeExactWidth(draft, pageLimit)
        if (normalized === null) {
          setDraft(String(store.get().value))
          return
        }
        store.update({ enabled: true, value: normalized })
        committedRef.current = String(normalized)
        setDraft(String(normalized))
      }

      return h(React.Fragment, null,
        h('style', null, SECTION_CSS),
        h('section', { className: 'wk-settings', 'aria-label': t('settingsNav') },
          h('div', { className: 'wk-card' },
            h('label', { className: 'wk-row' },
              h('span', null, t('settingsDockToggle')),
              h('input', {
                type: 'checkbox',
                name: 'dsh-widthkeeper-dock-visible',
                checked: state.dockVisible,
                onChange: (event) => { store.update({ dockVisible: event.target.checked }) },
              }),
            ),
            h('div', { className: 'wk-divider' }),
            h('div', { className: 'wk-row' },
              h('div', { className: 'wk-row-copy' },
                h('span', null, isAuto ? t('settingsWidthLabelAuto') : t('settingsWidthLabel')),
                h('span', { className: 'wk-hint', id: widthHintId },
                  isAuto
                    ? t('settingsWidthHintAuto')
                    : pageMin >= pageLimit
                      // 上下限贴合时输入框被禁用，再提示「按回车即生效」会骗人
                      ? t('settingsWidthHintReadonly')
                      : t('settingsWidthHint')
                        .replace('{min}', String(pageMin))
                        .replace('{max}', String(pageLimit))),
              ),
              h('div', { className: 'wk-field' },
                h('input', {
                  className: 'wk-num',
                  type: 'number',
                  name: 'dsh-widthkeeper-value',
                  inputMode: 'numeric',
                  min: pageMin,
                  max: pageLimit,
                  step: 1,
                  value: draft,
                  // 自动模式不生效；与 dock 一致，上下限贴合（自动模式也调不动）时也不可编辑
                  disabled: isAuto || pageMin >= pageLimit,
                  'aria-label': t('settingsWidthInputLabel'),
                  'aria-describedby': widthHintId,
                  onChange: (event) => { setDraft(event.target.value) },
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') { event.preventDefault(); commitDraft() }
                    // 放弃本次编辑：草稿恢复为 store 当前值，不提交、不改模式；
                    // 之后失焦走 commitDraft，草稿已等于已提交值，等值短路兜底
                    else if (event.key === 'Escape') {
                      event.preventDefault()
                      setDraft(String(store.get().value))
                    }
                  },
                  onBlur: commitDraft,
                }),
                h('span', { className: 'wk-unit' }, 'px'),
                h('button', {
                  className: 'wk-ghost',
                  type: 'button',
                  onClick: () => { store.update({ enabled: !store.get().enabled }) },
                }, isAuto ? t('settingsPinnedSwitch') : t('useAuto')),
              ),
            ),
            h('div', { className: 'wk-divider' }),
            h('div', { className: 'wk-row' },
              h('span', null, t('settingsAutoRow')),
              h('span', { className: 'wk-readonly' },
                autoReadoutValue(t, autoInfo) ?? t(isAuto ? 'settingsAutoUnknown' : 'settingsAutoUnavailable')),
            ),
          ),
          h('div', { className: 'wk-actions' },
            wrapWithTooltip(t('settingsResetHint'), h('button', {
              className: 'wk-btn',
              type: 'button',
              onClick: () => { store.reset() },
            }, t('settingsReset')), 'end'),
          ),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // 每次 activation 恢复一次告警资格：每次激活至多告警一次。
        contentElementWarned = false
        const store = createStore()
        const t = ctx.locale.bind(NS)

        // 主会话宽度规则：常驻到本次 activation 结束，不依赖任何槽位组件是否挂载
        installAxisStyle(ctx, store)

        /**
         * 只注册中英两种：宿主支持 zh / en / ja / es / fr / de / ru / pt，
         * 并允许新增语言沿 fallback 链取值。这里刻意不补其余语种——
         * 界面语言是中文时用中文，其它语言一律回落到英文（en 是 fallback 链终点），
         * 避免用机器翻译撑出六份半吊子文案。
         */
        ctx.effect(() => {
          const disposeZh = ctx.locale.register(NS, 'zh', DICTS.zh)
          const disposeEn = ctx.locale.register(NS, 'en', DICTS.en)
          return () => { disposeZh(); disposeEn() }
        }, 'dsh-widthkeeper: dictionaries')

        const openedSessions = new Set()
        const releasedSessions = new Set()
        function SessionDock({ sessionId, useSession, useChat }) {
          const { dockVisible } = useStoreState(store)
          const historyState = useSession(session => session.blank ? undefined : session.openState)
          const waitingForHistory = !openedSessions.has(sessionId)
            && (historyState === 'cold' || historyState === 'loading')
          const awaitingStats = useSession(session => session.blank === false
            // 历史会话也会在回放前收到 running。等待必须由本地首发线索触发。
            && (session.promptAttempted === true || session.awaitingFirstTurn === true)
            && session.promptError == null && session.lastAgentError == null
            && session.openState !== 'error' && !session.removed)
          // turnEnds 来自持久化的 turn/end，涵盖完成、中止和失败。已有历史也可以直接显示。
          const needsFirstTurn = useChat(chat => chat.legacy?.turnEnds?.size === 0
            && (chat.timeline?.turnOrder?.length ?? 0) <= 1)
          const [released, setReleased] = React.useState(() => releasedSessions.has(sessionId))
          const waitingForStats = dockVisible && awaitingStats && needsFirstTurn && !released
          const anchorRef = React.useRef(null)

          React.useLayoutEffect(() => {
            // 首次回放时宿主的统计分批出现，已打开的会话切回时直接显示控件。
            if (historyState === 'open') openedSessions.add(sessionId)
          }, [historyState, sessionId])

          React.useLayoutEffect(() => {
            if (!waitingForStats) return
            const anchor = anchorRef.current
            const slot = anchor?.closest('[data-slot="' + DOCK_SLOT + '"]')
            const release = () => {
              releasedSessions.add(sessionId)
              setReleased(true)
            }
            if (!slot || slot.querySelector('[data-composer-stat]')) {
              release()
              return
            }
            // 任一统计实际进入当前槽位就放行。紧凑模式和零用量会省略部分统计。
            const observer = new MutationObserver(() => {
              if (!slot.querySelector('[data-composer-stat]')) return
              observer.disconnect()
              release()
            })
            observer.observe(slot, { childList: true, subtree: true })
            return () => observer.disconnect()
          }, [waitingForStats, sessionId])

          if (!dockVisible) return null
          if (waitingForHistory || waitingForStats) {
            // 保留宿主状态行的布局，避免用量或上下文圆环单独露出。
            return h(React.Fragment, null,
              h('style', null, DOCK_WAITING_CSS),
              h('span', { ref: anchorRef, hidden: true, 'data-widthkeeper-waiting': '' }),
            )
          }
          return h(WidthDock, { store, t })
        }

        function Dock({ sessionId, useSession, useChat }) {
          // 会话槽位较旧的宿主可能缺少聊天快照，直接提供宽度控件。
          if (sessionId == null || typeof useSession !== 'function' || typeof useChat !== 'function') {
            return h(WidthDock, { store, t })
          }
          return h(SessionDock, { key: sessionId, sessionId, useSession, useChat })
        }

        function Section() {
          return h(WidthSettingsSection, { store, t })
        }

        ctx.slots.inject(DOCK_SLOT, () => ctx.slots.register({
          name: DOCK_SLOT,
          id: DOCK_ID,
          order: 10,
        }, Dock))

        // label 用 thunk：每次投影重读，跟随语言切换（不依赖 register 的 locale 选项）
        ctx.slots.inject(SECTION_SLOT, () => ctx.slots.register({
          name: SECTION_SLOT,
          id: SECTION_ID,
          order: SECTION_ORDER,
          label: () => t('settingsNav'),
        }, Section))
      },
    }
  },
})
