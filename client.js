/**
 * dsh-widthkeeper 的 Client 半边。
 *
 * 分叉自 @jinngoo/dsh-conversation-width 0.1.3（MIT，原作者 jinngoo）：
 * https://github.com/Jinngoo/dsh-conversation-width
 *
 * 宽度轴 `--dsh-chat-content-width` 由会话主体元素自己声明（ui-conversation 的 `.body`，
 * 即带 `[data-conversation-content]` 的那个元素），所以从 `:root`/`body` 设值无效。
 * 本插件改用更高优先级的样式表规则覆盖（0-1-1 > 0-1-0），不需要 `!important`，
 * 也不向组件外写 DOM。值取 `min(<px>, 100%)`：该变量被正文列、输入卡片、用户气泡、
 * ≥4 列表格破列多处消费，各自解析自己的 100%，超大值只会退化成「铺满」而不会撑破任何一处。
 *
 * 规则只在固定模式存在；自动模式移除规则，恢复 Harness 默认宽度与内置拖拽手柄。
 * 固定模式下隐藏手柄，因为它们写的行内 `--dsh-chat-user-width` 已被覆盖，拖了没有反应。
 */
window.__ModuleLoader__.load({
  id: 'dsh-widthkeeper',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 本插件占用的语言命名空间。 */
    const NS = 'dsh-conversation-width'
    /** 槽位内的登记 id：新 id 与宿主条目并列，复用宿主 id 会顶掉它。 */
    const DOCK_ID = 'conversation-width'
    /** 槽位：输入框卡片下方的环境条目。 */
    const DOCK_SLOT = 'conversation.composer.dock'
    /** 持久化偏好（按浏览器 profile，与 Harness 自己的宽度键同级）。 */
    const ENABLED_KEY = 'dsh.conversationWidth.enabled'
    const VALUE_KEY = 'dsh.conversationWidth.value'
    /** 滑杆域与步长；超过可用宽度的值等同于铺满。 */
    const MIN = 720
    const MAX = 2400
    const STEP = 20
    /** 默认的固定宽度。 */
    const DEFAULT_VALUE = 1600

    const DICTS = {
      zh: {
        label: '内容宽度',
        auto: '自动',
        slider: '会话内容列宽度',
        sliderTitle: '拖动即固定为该宽度，不必再拖正文两侧的手柄',
        pinnedTooltip: '当前：固定宽度。点击回到 Harness 内置宽度（正文两侧手柄恢复可用）',
        autoTooltip: '当前：Harness 内置宽度。点击固定为滑杆宽度',
      },
      en: {
        label: 'Content width',
        auto: 'Auto',
        slider: 'Conversation content column width',
        sliderTitle: 'Dragging pins this width; the handles beside the transcript are then unnecessary',
        pinnedTooltip: 'Pinned width. Click for the Harness default width (the handles beside the transcript come back)',
        autoTooltip: 'Harness default width. Click to pin the slider width',
      },
    }

    /**
     * 组件外观：对齐宿主的 dock 条目规范（ui-chat StatsPills / ui-conversation ContextMeter）——
     * 扁平透明底、label-tertiary、hover 才出 interactive-bg-hover、--dsw-radius-sm、
     * secondary 字号、tabular-nums。只引用主题 token，token 改名只会掉样式，不会崩渲染。
     */
    const CHROME_CSS = [
      '.cw-dock{display:inline-flex;align-items:center;gap:6px;flex:0 1 auto;min-width:0;',
      'padding:1px 8px;border-radius:var(--dsw-radius-sm);background:transparent;',
      'color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);',
      'line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));',
      'font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.cw-icon{flex:none}',
      '.cw-range{flex:0 1 auto;width:112px;min-width:56px;height:16px;margin:0;background:transparent;',
      'accent-color:var(--dsw-alias-brand-primary);cursor:pointer}',
      '.cw-dock[data-dsh-conversation-width="auto"] .cw-range{accent-color:var(--dsw-alias-state-idle-primary);opacity:.6}',
      '.cw-mode{flex:none;padding:0 6px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;',
      'color:var(--dsw-alias-label-secondary);font:inherit;line-height:inherit;',
      'font-variant-numeric:tabular-nums;cursor:pointer}',
      '.cw-mode[aria-pressed="true"]{color:var(--dsw-alias-label-primary)}',
      '.cw-mode:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.cw-mode:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
    ].join('')

    /** 把请求宽度吸附到滑杆域上。 */
    function clampWidth(value) {
      if (!Number.isFinite(value)) return DEFAULT_VALUE
      return Math.min(MAX, Math.max(MIN, Math.round(value / STEP) * STEP))
    }

    /** 读取持久化偏好；缺省即固定为 DEFAULT_VALUE。 */
    function readPreference() {
      try {
        const enabled = window.localStorage.getItem(ENABLED_KEY) !== '0'
        const raw = window.localStorage.getItem(VALUE_KEY)
        const parsed = raw === null ? Number.NaN : Number(raw)
        return { enabled, value: Number.isFinite(parsed) ? clampWidth(parsed) : DEFAULT_VALUE }
      } catch {
        return { enabled: true, value: DEFAULT_VALUE }
      }
    }

    /** 尽力持久化；存储被禁用也不能影响实时控件。 */
    function writePreference(state) {
      try {
        window.localStorage.setItem(ENABLED_KEY, state.enabled ? '1' : '0')
        window.localStorage.setItem(VALUE_KEY, String(state.value))
      } catch { /* 存储不可用（隐私模式）：只保留内存状态 */ }
    }

    /** 一份偏好供所有挂载实例共享（槽位是常驻的，但不保证单例）。 */
    function createStore() {
      let state = readPreference()
      const listeners = new Set()
      return {
        get: () => state,
        update(patch) {
          const next = { enabled: patch.enabled ?? state.enabled, value: patch.value ?? state.value }
          if (next.enabled === state.enabled && next.value === state.value) return
          state = next
          writePreference(state)
          for (const listener of [...listeners]) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      }
    }

    /** 生成全局宽度轴规则；自动模式返回空串。 */
    function axisCss(state) {
      if (!state.enabled) return ''
      return 'html [data-conversation-content]{--dsh-chat-content-width:min('
        + state.value + 'px,100%)}'
        + 'html [data-width-handle]{display:none}'
    }

    /** dock 按钮的前置图标：左右双向箭头（内容列加宽）。 */
    function widthIcon() {
      return h('svg', {
        className: 'cw-icon', viewBox: '0 0 18 18', width: 14, height: 14, 'aria-hidden': true,
      },
        h('path', {
          d: 'M2.5 9h13M5.5 5.5 2 9l3.5 3.5M12.5 5.5 16 9l-3.5 3.5', fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
        }))
    }

    /**
     * 输入框卡片下方的控件：一根宽度滑杆 + 一个模式开关。
     * props 由本插件 activation 提供：store（共享偏好）与 t（翻译）。
     * 两种模式都可操作（拖滑杆即固定，点开关即切换），保证任何状态都能走出去。
     */
    function WidthDock(props) {
      const { store, t } = props
      const [state, setState] = React.useState(store.get)
      React.useEffect(() => store.subscribe(() => { setState(store.get()) }), [store])
      const mode = state.enabled ? 'pinned' : 'auto'

      return h(React.Fragment, null,
        h('style', null, axisCss(state)),
        h('style', null, CHROME_CSS),
        h('div', { className: 'cw-dock', 'data-dsh-conversation-width': mode },
          widthIcon(),
          h('input', {
            className: 'cw-range',
            type: 'range',
            min: MIN,
            max: MAX,
            step: STEP,
            value: state.value,
            'aria-label': t('slider'),
            title: t('sliderTitle'),
            onChange: (event) => {
              store.update({ enabled: true, value: clampWidth(Number(event.target.value)) })
            },
          }),
          h('button', {
            className: 'cw-mode',
            type: 'button',
            'aria-pressed': state.enabled,
            'aria-label': t('label') + '，' + (state.enabled ? state.value + 'px' : t('auto')),
            title: state.enabled ? t('pinnedTooltip') : t('autoTooltip'),
            onClick: () => { store.update({ enabled: !state.enabled }) },
          }, state.enabled ? state.value + 'px' : t('auto')),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const store = createStore()
        const t = ctx.locale.bind(NS)

        ctx.effect(() => {
          const disposeZh = ctx.locale.register(NS, 'zh', DICTS.zh)
          const disposeEn = ctx.locale.register(NS, 'en', DICTS.en)
          return () => { disposeZh(); disposeEn() }
        }, 'conversation-width: dictionaries')

        /** 注册进槽位的组件：store 与翻译由本次 activation 持有。 */
        function Dock() {
          return h(WidthDock, { store, t })
        }

        ctx.slots.inject(DOCK_SLOT, () => ctx.slots.register({
          name: DOCK_SLOT,
          id: DOCK_ID,
          order: 10,
        }, Dock))
      },
    }
  },
})
