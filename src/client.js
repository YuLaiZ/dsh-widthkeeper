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
 */
window.__ModuleLoader__.load({
  id: 'dsh-widthkeeper',
  factory(require) {
    const React = require('react')
    const h = React.createElement

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
    const NS = 'dsh-conversation-width'
    /** 槽位内的登记 id：新 id 与宿主条目并列，复用宿主 id 会顶掉它。 */
    const DOCK_ID = 'conversation-width'
    /** 槽位：输入框卡片下方的环境条目。 */
    const DOCK_SLOT = 'conversation.composer.dock'
    /** 槽位：设置页分区（宿主插件页 order 为 15，本分区排在其后）。 */
    const SECTION_SLOT = 'settings.section'
    const SECTION_ID = 'widthkeeper'
    const SECTION_ORDER = 16
    /** 持久化偏好（按浏览器 profile，与 Harness 自己的宽度键同级）。 */
    const ENABLED_KEY = 'dsh.conversationWidth.enabled'
    const VALUE_KEY = 'dsh.conversationWidth.value'
    const DOCK_VISIBLE_KEY = 'dsh.conversationWidth.dockVisible'
    /** 宿主内置拖拽偏好的键（只读，仅用于判定自动宽度的来源）。 */
    const HOST_WIDTH_KEY = 'dsh.conversation.contentWidth'
    /**
     * 滑杆域与步长：下限对齐宿主拖拽的 CONTENT_MIN(640)；上限 2000 覆盖 1080p 屏
     * 的可用内容列（约 1888）并留一点余量。再大的值在 1080p 上只会退化成铺满，
     * 滑杆后段全是拖了没反应的死区。超过可用宽度的值仍由 min(<px>, 100%) 兜底。
     */
    const MIN = 640
    const MAX = 2000
    const STEP = 10
    /**
     * 默认的固定宽度：略宽于 Harness 内置上限（920px），首次启用能看出变化，
     * 又不会在常见窗口宽度下退化成 min(<px>, 100%) 的铺满。
     */
    const DEFAULT_VALUE = 1000
    /** 宿主钩子：会话主体元素与其上声明的宽度轴（改名即静默失效，靠自动读数的告警自检）。 */
    const CONTENT_SELECTOR = '[data-conversation-content]'
    /**
     * 宿主钩子：右侧栏嵌入式子会话（ui-subagent 的 sidebar chat）的包装元素。
     * 这类会话的宽度由面板宽度决定，和主会话的固定/拖拽偏好无关；插件只管主会话。
     */
    const EMBEDDED_SELECTOR = '[data-sidebar-chat]'
    const AXIS_VAR = '--dsh-chat-content-width'

    const DICTS = {
      zh: {
        label: '内容宽度',
        auto: '自动',
        slider: '会话内容列宽度',
        sliderTitle: '拖动即固定为该宽度，不必再拖正文两侧的手柄',
        pinnedTooltip: '当前：固定宽度。点击输入精确宽度，或从编辑层回到自动',
        autoTooltip: '当前：Harness 内置宽度。点击固定为滑杆宽度',
        valueAria: '内容宽度 {v} 像素，点击编辑',
        widthInputLabel: '内容宽度（640–2000 像素）',
        useAuto: '使用自动宽度',
        autoReadout: '自动 · {v}px',
        sourceDragged: '（已手动调整）',
        sourceFormula: '（默认公式）',
        settingsNav: '内容宽度',
        settingsDockToggle: '显示输入框下方的宽度控件',
        settingsWidthLabel: '固定宽度',
        settingsWidthHint: '640–2000；回车或失焦后生效',
        settingsWidthLabelAuto: '固定宽度（未生效）',
        settingsWidthHintAuto: '当前使用自动宽度；点「切回固定宽度」采用此值',
        settingsPinnedSwitch: '切回固定宽度',
        settingsAutoRow: '当前自动宽度',
        settingsAutoUnavailable: '—（固定宽度生效中）',
        settingsAutoUnknown: '—（暂无可用会话）',
        settingsReset: '恢复默认',
        settingsResetHint: '清除本插件的宽度偏好，回到默认固定宽度并显示控件',
      },
      en: {
        label: 'Content width',
        auto: 'Auto',
        slider: 'Conversation content column width',
        sliderTitle: 'Dragging pins this width; the handles beside the transcript are then unnecessary',
        pinnedTooltip: 'Pinned width. Click to type an exact width or switch back to auto',
        autoTooltip: 'Harness default width. Click to pin the slider width',
        valueAria: 'Content width {v} pixels, click to edit',
        widthInputLabel: 'Content width (640–2000 pixels)',
        useAuto: 'Use automatic width',
        autoReadout: 'Auto · {v}px',
        sourceDragged: ' (manually adjusted)',
        sourceFormula: ' (default formula)',
        settingsNav: 'Content width',
        settingsDockToggle: 'Show the width controls under the message box',
        settingsWidthLabel: 'Pinned width',
        settingsWidthHint: '640–2000; applies on Enter or blur',
        settingsWidthLabelAuto: 'Pinned width (not in effect)',
        settingsWidthHintAuto: 'Automatic width is active; use the button to switch back to this width',
        settingsPinnedSwitch: 'Switch back to pinned width',
        settingsAutoRow: 'Current automatic width',
        settingsAutoUnavailable: '— (pinned width is active)',
        settingsAutoUnknown: '— (no conversation available)',
        settingsReset: 'Reset to defaults',
        settingsResetHint: 'Clear the width preferences stored by this plugin and restore the defaults',
      },
    }

    /**
     * dock 外观：对齐宿主的 dock 条目规范（ui-chat StatsPills / ui-conversation ContextMeter）——
     * 扁平透明底、label-tertiary、hover 才出 interactive-bg-hover、--dsw-radius-sm、
     * secondary 字号、tabular-nums。只引用主题 token，token 改名只会掉样式，不会崩渲染。
     */
    const CHROME_CSS = [
      '.cw-dock{display:inline-flex;align-items:center;gap:6px;flex:0 1 auto;min-width:0;',
      'padding:1px 8px;border-radius:var(--dsw-radius-sm);background:transparent;',
      // 字号与 ui-chat 的 StatsPills 一致：次级字号再减 1px
      'color:var(--dsw-alias-label-tertiary);',
      'font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);',
      'line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));',
      'font-variant-numeric:tabular-nums;white-space:nowrap}',
      // 自绘轨道与滑块：原生 accent-color 用的是品牌色，而品牌色在本设计系统里
      // 是黑白对比色（浅色主题近黑、深色主题近白），方块对撞过于生硬。这里改用
      // 中性灰调，滑杆是辅助控件，不需要抢过正文和数值的注意力。
      '.cw-range{flex:0 1 auto;width:112px;min-width:56px;height:16px;margin:0;',
      'background:transparent;cursor:pointer;-webkit-appearance:none;appearance:none}',
      '.cw-range::-webkit-slider-runnable-track{height:4px;border-radius:999px;',
      'background:var(--dsw-alias-border-l3)}',
      '.cw-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;',
      'width:12px;height:12px;margin-top:-4px;border-radius:50%;',
      'background:var(--dsw-alias-label-secondary);transition:background .15s}',
      '@media (hover: hover){.cw-range:hover::-webkit-slider-thumb{background:var(--dsw-alias-label-primary)}}',
      '.cw-range:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.cw-dock[data-dsh-conversation-width="auto"] .cw-range{opacity:.55}',
      // 静止态沿用宿主的 tertiary；只有 hover / 固定态才升到 secondary
      '.cw-mode{flex:none;padding:0 6px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;',
      'color:var(--dsw-alias-label-tertiary);font:inherit;line-height:inherit;',
      'font-variant-numeric:tabular-nums;cursor:pointer}',
      '.cw-mode[aria-pressed="true"]{color:var(--dsw-alias-label-secondary)}',
      '.cw-mode:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.cw-mode:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.cw-edit{display:inline-flex;align-items:center;gap:6px;flex:0 1 auto;min-width:0}',
      '.cw-edit-input{flex:0 1 96px;min-width:56px;height:20px;margin:0;padding:0 6px;border:0;',
      'border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover);',
      'color:var(--dsw-alias-label-primary);font:inherit;line-height:inherit;',
      'font-variant-numeric:tabular-nums;appearance:textfield}',
      '.cw-edit-input::-webkit-outer-spin-button,.cw-edit-input::-webkit-inner-spin-button{',
      '-webkit-appearance:none;margin:0}',
      '.cw-edit-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.cw-edit-unit{flex:none;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
    ].join('')

    /**
     * 设置页分区外观：对齐宿主设置卡规范（ui-settings-account AccountSection、
     * ui-primitives Checkbox）——settings-card 卡片、border-l2 分隔、40px 行、
     * 原生 checkbox 配 brand accent。同样只引用主题 token。
     */
    const SECTION_CSS = [
      '.cw-settings{display:flex;flex-direction:column;gap:16px;padding:8px 0;',
      'font-size:13px;line-height:22px;color:var(--dsw-alias-label-primary)}',
      '.cw-card{display:flex;flex-direction:column;padding:12px 16px;',
      'border:0.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);',
      'background:var(--dsw-alias-settings-card-fill)}',
      '.cw-row{display:flex;align-items:center;justify-content:space-between;gap:16px;',
      'min-height:40px;padding:6px 0;box-sizing:border-box}',
      '.cw-row-copy{display:flex;flex-direction:column;min-width:0}',
      '.cw-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.cw-divider{border-top:0.5px solid var(--dsw-alias-border-l2)}',
      '.cw-row input[type="checkbox"]{flex:0 0 auto;width:16px;height:16px;margin:0;',
      'accent-color:var(--dsw-alias-brand-primary);cursor:pointer}',
      '.cw-field{display:inline-flex;align-items:center;gap:8px;flex:none}',
      '.cw-num{box-sizing:border-box;width:96px;height:28px;padding:0 8px;',
      'border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);',
      'background:transparent;color:var(--dsw-alias-label-primary);font:inherit;',
      'font-variant-numeric:tabular-nums;appearance:textfield}',
      '.cw-num::-webkit-outer-spin-button,.cw-num::-webkit-inner-spin-button{',
      '-webkit-appearance:none;margin:0}',
      '.cw-num:disabled{opacity:.55;cursor:default}',
      '.cw-unit{color:var(--dsw-alias-label-tertiary)}',
      '.cw-ghost{display:inline-flex;align-items:center;box-sizing:border-box;height:28px;padding:0 10px;',
      'border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);',
      'background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;line-height:20px;',
      'white-space:nowrap;cursor:pointer}',
      '.cw-readonly{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;text-align:right}',
      '.cw-actions{display:flex;justify-content:flex-end;align-items:center;gap:10px}',
      '.cw-btn{display:inline-flex;justify-content:center;align-items:center;box-sizing:border-box;',
      'height:36px;min-width:58px;padding:0 14px;border:0.5px solid var(--dsw-alias-border-l3);',
      'border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);',
      'font-size:14px;line-height:22px;white-space:nowrap;cursor:pointer}',
      '@media (hover: hover){.cw-ghost:hover,.cw-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}}',
      '.cw-row input:focus-visible,.cw-num:focus-visible,.cw-ghost:focus-visible,.cw-btn:focus-visible{',
      'outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));',
      'outline-offset:2px}',
    ].join('')

    /** 把滑杆拖动的请求宽度吸附到步进域上。 */
    function clampWidth(value) {
      if (!Number.isFinite(value)) return DEFAULT_VALUE
      return Math.min(MAX, Math.max(MIN, Math.round(value / STEP) * STEP))
    }

    /**
     * 精确值的数值归一化：clamp 到 [MIN, MAX] 后取整，不吸附步进
     * （精确输入允许任意整数，如 821）；非有限数返回 null。
     */
    function normalizeWidthValue(value) {
      if (!Number.isFinite(value)) return null
      return Math.min(MAX, Math.max(MIN, Math.round(value)))
    }

    /** 文本输入归一化：空串与非数字视为非法返回 null（调用方回退原值），其余同数值版。 */
    function normalizeExactWidth(text) {
      const trimmed = String(text).trim()
      if (trimmed === '') return null
      return normalizeWidthValue(Number(trimmed))
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
     * 读宿主当前实际生效的内容宽度轴与来源。
     * 返回 `{ width, dragged }`：width 为像素数（读不出为 null），dragged 表示来源
     * 是否为宿主内置拖拽偏好；没有可用元素时返回 null。
     * `warnOnMissing=false` 供设置页使用：设置页打开时宿主动态卸载会话，页面里没有
     * 会话元素是正常状态，不应报「宿主结构变化」。
     */
    function readAutoWidth(element, warnOnMissing = true) {
      if (!element || !element.isConnected) {
        // 只有页面里确实没有该元素时才提示宿主结构变化；元素存在但暂时不可见
        // （折叠会话）不是结构问题，不应误报。
        if (warnOnMissing && !contentElementWarned && document.querySelector(CONTENT_SELECTOR) === null) {
          contentElementWarned = true
          console.warn('[dsh-widthkeeper] 未找到 ' + CONTENT_SELECTOR + ' 元素，宿主结构可能已变化；自动宽度读数不可用')
        }
        return null
      }
      const declared = window.getComputedStyle(element).getPropertyValue(AXIS_VAR).trim()
      const width = evalWidthExpr(declared)
      return {
        width: Number.isFinite(width) ? Math.round(width) : null,
        dragged: hostDragPreferencePresent(),
      }
    }

    /** 宿主内置拖拽偏好是否存在（有效正数才作数，判据与宿主 ConversationWidthControls 一致）。 */
    function hostDragPreferencePresent() {
      try {
        const raw = window.localStorage.getItem(HOST_WIDTH_KEY)
        if (raw === null) return false
        const value = Number(raw)
        return Number.isFinite(value) && value > 0
      } catch {
        return false
      }
    }

    /** 自动读数文案：`自动 · 836px（来源）`；读不出值时返回 null（调用方自行回退）。 */
    function autoReadoutText(t, info) {
      if (!info || info.width === null) return null
      return t('autoReadout').replace('{v}', String(info.width))
        + t(info.dragged ? 'sourceDragged' : 'sourceFormula')
    }

    /**
     * 设置页用的读数文案：该行的标签已经是「当前自动宽度」，值里不再重复
     * 「自动 ·」前缀，只留数值与来源。
     */
    function autoReadoutValue(t, info) {
      if (!info || info.width === null) return null
      return String(info.width) + 'px' + t(info.dragged ? 'sourceDragged' : 'sourceFormula')
    }

    /** 读取持久化偏好；缺省即固定为 DEFAULT_VALUE 并显示控件。 */
    function readPreference() {
      try {
        const enabled = window.localStorage.getItem(ENABLED_KEY) !== '0'
        const raw = window.localStorage.getItem(VALUE_KEY)
        const parsed = raw === null ? Number.NaN : Number(raw)
        const value = normalizeWidthValue(parsed)
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
      }, 'widthkeeper: width axis stylesheet')
    }

    /** 订阅共享 store 的本地镜像；dock 与设置页共用。 */
    function useStoreState(store) {
      const [state, setState] = React.useState(store.get)
      React.useEffect(() => store.subscribe(() => { setState(store.get()) }), [store])
      return state
    }

    /**
     * 自动模式下的宿主实际读数：读会话主体元素上宿主算出的宽度轴，并跟随以下变化刷新：
     *
     * 1. 窗口 / 布局变化改变容器尺寸 → ResizeObserver；
     * 2. 拖拽正文两侧的原生手柄 → 宿主把 `--dsh-chat-user-width` 写进**父元素**的行内
     *    style，容器自身尺寸并不随之改变（它一直是可用宽度的满宽），ResizeObserver
     *    收不到通知。这里只在 `pointerup` 补读一次，而不是持续监听父元素的 style：
     *    拖拽期间读数每帧变化会让值按钮的 Tooltip 文案反复重写，提示随之闪烁；
     * 3. 主会话主体元素延迟出现、被替换或切换 → MutationObserver 重新选目标并重绑；
     *    主会话可见性变化（例如从设置页返回）→ IntersectionObserver 触发重读；
     * 4. 焦点在会话之间移动 → focusin 触发重新选目标（锚点仍优先）。
     *
     * 侧栏嵌入式子会话不参与：它的宽度由侧栏面板决定，不是本插件管理的轴。
     * 固定模式不读：插件注入的 min(<px>,100%) 会盖住宿主轴，读出来没有意义。
     * anchorRef 可传 dock 根节点：有它时读数跟随 dock 所在的主会话，而不是页面第一个匹配项。
     * 设置页传 warnOnMissing=false：它打开时会话被宿主卸载，缺元素不是异常。
     */
    function useAutoWidth(active, anchorRef, warnOnMissing = true) {
      const [info, setInfo] = React.useState(null)
      React.useEffect(() => {
        if (!active) return
        let target = null
        let frame = 0
        let resizeObserver = null
        let intersectionObserver = null
        const observedContent = new Set()

        const commit = () => {
          const next = readAutoWidth(target, warnOnMissing)
          setInfo((prev) => {
            if (prev === next) return prev
            if (prev && next && prev.width === next.width && prev.dragged === next.dragged) return prev
            return next
          })
        }

        /**
         * 只观察主会话元素：当前目标可能一直可见，主会话从设置页 / 折叠状态恢复可见时，
         * 仅观察 target 收不到通知。侧栏嵌入式会话已从候选中排除，不必观察。
         * 候选数量很少（通常只有一个主会话），集合按需增删。
         */
        const syncVisibilityObservers = () => {
          if (typeof IntersectionObserver !== 'function') return
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
          resizeObserver?.disconnect()
          resizeObserver = null
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

        /** 新插入的子树里是否带会话主体元素（用于发现延迟出现/替换后的新元素）。 */
        const containsContent = (node) => (
          node === target
          || node.matches?.(CONTENT_SELECTOR)
          || node.querySelector?.(CONTENT_SELECTOR) !== null
        )

        const mutations = new MutationObserver((records) => {
          // 只做便宜的元素存在性判断；可见性交给 IntersectionObserver，
          // 避免流式输出时每个 DOM 批次都强制一次样式/布局计算。
          let needsPick = target === null || !target.isConnected
          for (const record of records) {
            if (needsPick) break
            if (record.type === 'attributes') {
              // 只观察会话切换 / 阶段变化的标记，避免流式输出时每帧重读
              if (record.target === target) needsPick = true
              continue
            }
            for (const node of record.addedNodes) {
              if (node.nodeType !== 1) continue
              if (containsContent(node)) { needsPick = true; break }
            }
            if (needsPick) break
            for (const node of record.removedNodes) {
              if (node.nodeType !== 1) continue
              if (node === target || node.contains(target)) { needsPick = true; break }
              if (node.matches(CONTENT_SELECTOR) || node.querySelector(CONTENT_SELECTOR) !== null) {
                needsPick = true
                break
              }
            }
          }
          if (needsPick) schedule()
        })
        mutations.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['data-conversation-session', 'data-content-phase'],
        })

        refresh()
        window.addEventListener('pointerup', schedule)
        document.addEventListener('focusin', schedule)
        return () => {
          mutations.disconnect()
          resizeObserver?.disconnect()
          intersectionObserver?.disconnect()
          window.removeEventListener('pointerup', schedule)
          document.removeEventListener('focusin', schedule)
          if (frame !== 0) window.cancelAnimationFrame(frame)
        }
      }, [active, anchorRef, warnOnMissing])
      return active ? info : null
    }

    /**
     * 固定态值按钮展开的内联编辑层：数字输入 + 「使用自动宽度」。
     * Enter 提交、Esc 取消、失焦提交；非法输入（空 / 非数字）回退原值。
     */
    function WidthValueEditor(props) {
      const { store, t, onClose } = props
      const [draft, setDraft] = React.useState(String(store.get().value))
      const rootRef = React.useRef(null)
      const inputRef = React.useRef(null)

      React.useEffect(() => {
        const node = inputRef.current
        if (node) { node.focus(); node.select() }
      }, [])

      function commit() {
        const normalized = normalizeExactWidth(draft)
        if (normalized !== null) store.update({ enabled: true, value: normalized })
        onClose()
      }

      return h('div', {
        className: 'cw-edit',
        ref: rootRef,
        onBlur: (event) => {
          // 焦点移出编辑层才提交；在层内移动焦点（如点到「使用自动宽度」）不触发
          const next = event.relatedTarget
          if (next instanceof Node && rootRef.current && rootRef.current.contains(next)) return
          commit()
        },
      },
        h('input', {
          ref: inputRef,
          className: 'cw-edit-input',
          type: 'number',
          name: 'dsh-conversation-width-exact',
          inputMode: 'numeric',
          min: MIN,
          max: MAX,
          step: 1,
          value: draft,
          'aria-label': t('widthInputLabel'),
          onChange: (event) => { setDraft(event.target.value) },
          onKeyDown: (event) => {
            if (event.key === 'Enter') { event.preventDefault(); commit() }
            else if (event.key === 'Escape') { event.preventDefault(); onClose() }
          },
        }),
        h('span', { className: 'cw-edit-unit' }, 'px'),
        h('button', {
          className: 'cw-mode',
          type: 'button',
          // 抢在输入框失焦前拦截，避免先触发「失焦提交」
          onMouseDown: (event) => { event.preventDefault() },
          onClick: () => { store.update({ enabled: false }); onClose() },
        }, t('useAuto')),
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
      const autoInfo = useAutoWidth(mode === 'auto' && !embedded, rootRef)
      // 模式被其它入口（设置页 / 编辑层自身）切到自动时收起编辑层，避免停在过期草稿上
      React.useEffect(() => { setEditing(false) }, [state.enabled])

      const modeTooltip = state.enabled
        ? t('pinnedTooltip')
        : (autoReadoutText(t, autoInfo) ?? t('autoTooltip'))
      const modeButton = h('button', {
        className: 'cw-mode',
        type: 'button',
        'aria-pressed': state.enabled,
        'aria-label': state.enabled
          ? t('valueAria').replace('{v}', String(state.value))
          : t('label') + '，' + t('auto'),
        onClick: () => {
          // 固定态展开精确输入；自动态固定为上次宽度（上游行为）
          if (state.enabled) setEditing(true)
          else store.update({ enabled: true })
        },
      }, state.enabled ? state.value + 'px' : t('auto'))
      const sliderTitle = t('sliderTitle')
      const slider = h('input', {
        className: 'cw-range',
        type: 'range',
        name: 'dsh-conversation-width-slider',
        min: MIN,
        max: MAX,
        step: STEP,
        value: state.value,
        'aria-label': t('slider'),
        onChange: (event) => {
          store.update({ enabled: true, value: clampWidth(Number(event.target.value)) })
        },
      })
      // 插件内控件共用同一种宿主 Tooltip；不再设置原生 title
      const modeControl = wrapWithTooltip(modeTooltip, modeButton, 'end')
      const sliderControl = wrapWithTooltip(sliderTitle, slider, 'center')

      return state.dockVisible && !embedded ? h(React.Fragment, null,
        h('style', null, CHROME_CSS),
        h('div', { ref: rootRef, className: 'cw-dock', 'data-dsh-conversation-width': mode },
          editing
            ? h(WidthValueEditor, { store, t, onClose: () => { setEditing(false) } })
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
      const autoInfo = useAutoWidth(!state.enabled, undefined, false)
      /** 自动模式下这一行不是"当前宽度"，而是"切回固定时采用的值"。 */
      const isAuto = !state.enabled

      // 宽度被其它入口（滑杆 / 编辑层）改写时同步草稿与已提交值，避免显示过期值
      React.useEffect(() => {
        committedRef.current = String(state.value)
        setDraft(String(state.value))
      }, [state.value])

      function commitDraft() {
        const normalized = normalizeExactWidth(draft)
        if (normalized === null) {
          setDraft(String(store.get().value))
          return
        }
        // 值没有实际变化时只还原草稿，不碰 store：自动模式下点一下输入框
        // 再失焦，不应该把模式切成固定、让宽度跳回上次的固定值
        if (String(normalized) === committedRef.current) {
          setDraft(committedRef.current)
          return
        }
        store.update({ enabled: true, value: normalized })
        committedRef.current = String(normalized)
        setDraft(String(normalized))
      }

      return h(React.Fragment, null,
        h('style', null, SECTION_CSS),
        h('section', { className: 'cw-settings', 'aria-label': t('settingsNav') },
          h('div', { className: 'cw-card' },
            h('label', { className: 'cw-row' },
              h('span', null, t('settingsDockToggle')),
              h('input', {
                type: 'checkbox',
                name: 'dsh-conversation-width-dock-visible',
                checked: state.dockVisible,
                onChange: (event) => { store.update({ dockVisible: event.target.checked }) },
              }),
            ),
            h('div', { className: 'cw-divider' }),
            h('div', { className: 'cw-row' },
              h('div', { className: 'cw-row-copy' },
                h('span', null, isAuto ? t('settingsWidthLabelAuto') : t('settingsWidthLabel')),
                h('span', { className: 'cw-hint' },
                  isAuto ? t('settingsWidthHintAuto') : t('settingsWidthHint')),
              ),
              h('div', { className: 'cw-field' },
                h('input', {
                  className: 'cw-num',
                  type: 'number',
                  name: 'dsh-conversation-width-value',
                  inputMode: 'numeric',
                  min: MIN,
                  max: MAX,
                  step: 1,
                  value: draft,
                  disabled: isAuto,
                  'aria-label': t('settingsWidthLabel'),
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
                h('span', { className: 'cw-unit' }, 'px'),
                h('button', {
                  className: 'cw-ghost',
                  type: 'button',
                  onClick: () => { store.update({ enabled: !store.get().enabled }) },
                }, isAuto ? t('settingsPinnedSwitch') : t('useAuto')),
              ),
            ),
            h('div', { className: 'cw-divider' }),
            h('div', { className: 'cw-row' },
              h('span', null, t('settingsAutoRow')),
              h('span', { className: 'cw-readonly' },
                autoReadoutValue(t, autoInfo) ?? t(isAuto ? 'settingsAutoUnknown' : 'settingsAutoUnavailable')),
            ),
          ),
          h('div', { className: 'cw-actions' },
            wrapWithTooltip(t('settingsResetHint'), h('button', {
              className: 'cw-btn',
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
        const store = createStore()
        const t = ctx.locale.bind(NS)

        // 主会话宽度规则：常驻到本次 activation 结束，不依赖任何槽位组件是否挂载
        installAxisStyle(ctx, store)

        ctx.effect(() => {
          const disposeZh = ctx.locale.register(NS, 'zh', DICTS.zh)
          const disposeEn = ctx.locale.register(NS, 'en', DICTS.en)
          return () => { disposeZh(); disposeEn() }
        }, 'conversation-width: dictionaries')

        /** 注册进槽位的组件：store 与翻译由本次 activation 持有。 */
        function Dock() {
          return h(WidthDock, { store, t })
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
