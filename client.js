/**
 * Client half: a resident, draggable status pill in the frame-wide overlay.
 *
 * It is deliberately self-contained plain JavaScript — no JSX, no imports —
 * and talks to its own Host half over one read-only JSON route.
 *
 * Interaction:
 *  - click / Enter / Space toggles the detail rows;
 *  - drag moves the card; the position survives reloads (localStorage);
 *  - the card is clamped inside the viewport on resize and on expand.
 */
window.__ModuleLoader__.load({
  id: '@local/deepseek-usage',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'deepseek-usage'
    // The query marker lets the Host report which Client build the page runs.
    const CLIENT_BUILD = '3'
    const STATE_URL = '/dsh-deepseek-usage/state?c=' + CLIENT_BUILD
    const REFRESH_URL = '/dsh-deepseek-usage/refresh?c=' + CLIENT_BUILD
    const CLIENT_POLL_MS = 5000
    const STORAGE_KEY = 'dsh.deepseek-usage.position'
    const EDGE = 8

    const DICTS = {
      zh: {
        balance: '余额',
        total: '总余额',
        granted: '赠金余额',
        toppedUp: '充值余额',
        today: '今日',
        spendToday: '今日花费',
        tokens: '今日 Token',
        input: '输入（未命中缓存）',
        output: '输出',
        cacheRead: '缓存命中',
        updated: '更新于',
        refresh: '刷新',
        loading: '读取中…',
        noKey: '未找到 DEEPSEEK_API_KEY',
        authError: 'API Key 无效或已失效',
        netError: '余额读取失败，稍后自动重试',
        offline: '插件服务未响应',
        unavailable: '账户余额不可用',
        expand: '展开明细',
        collapse: '收起明细',
        dragHint: '拖动可移位，点击看明细',
      },
      en: {
        balance: 'Balance',
        total: 'Balance',
        granted: 'Granted',
        toppedUp: 'Topped up',
        today: 'Today',
        spendToday: 'Today spend',
        tokens: "Today's tokens",
        input: 'Input (cache miss)',
        output: 'Output',
        cacheRead: 'Cache hit',
        updated: 'Updated',
        refresh: 'Refresh',
        loading: 'Loading…',
        noKey: 'DEEPSEEK_API_KEY not found',
        authError: 'API key is invalid or expired',
        netError: 'Balance refresh failed, retrying',
        offline: 'Plugin service unreachable',
        unavailable: 'Balance unavailable',
        expand: 'Show details',
        collapse: 'Hide details',
        dragHint: 'Drag to move, click for details',
      },
    }

    const CSS = `
.dsu-root{position:fixed;right:16px;bottom:104px;z-index:2147483000;pointer-events:none}
.dsu-card{pointer-events:auto;display:flex;flex-direction:column;gap:4px;box-sizing:border-box;
  padding:8px 11px;min-width:196px;border-radius:12px;
  background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1,#fff));
  border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));
  box-shadow:0 8px 26px rgba(0,0,0,.14);
  color:var(--dsw-alias-label-primary,#1a1a1a);
  font-family:inherit;font-size:12px;line-height:1.35;
  -webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);
  cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;outline:none}
.dsu-card.dsu-dragging{cursor:grabbing;box-shadow:0 14px 34px rgba(0,0,0,.22)}
.dsu-card:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-brand-primary,#4d6bfe),0 8px 26px rgba(0,0,0,.14)}
.dsu-row{display:flex;align-items:baseline;gap:6px;white-space:nowrap}
.dsu-amount{font-size:14px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:.2px}
.dsu-sub{color:var(--dsw-alias-label-secondary,#6b6b6b);font-variant-numeric:tabular-nums}
.dsu-sep{color:var(--dsw-alias-border-l2,rgba(0,0,0,.16))}
.dsu-caret{margin-left:auto;color:var(--dsw-alias-label-secondary,#6b6b6b);font-size:10px}
.dsu-detail{display:flex;flex-direction:column;gap:3px;margin-top:5px;padding-top:6px;
  border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));min-width:220px}
.dsu-line{display:flex;justify-content:space-between;gap:18px;white-space:nowrap}
.dsu-line>span:last-child{font-variant-numeric:tabular-nums}
.dsu-label{color:var(--dsw-alias-label-secondary,#6b6b6b)}
.dsu-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:3px}
.dsu-btn{pointer-events:auto;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));
  background:transparent;color:var(--dsw-alias-label-primary,#1a1a1a);border-radius:6px;
  padding:2px 8px;font:inherit;font-size:11px;cursor:pointer}
.dsu-btn:hover{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04))}
.dsu-err{color:var(--dsw-alias-state-error-primary,#d33);max-width:260px;white-space:normal}
.dsu-muted{color:var(--dsw-alias-label-secondary,#6b6b6b);font-variant-numeric:tabular-nums}
`

    function fmtMoney(cents) {
      if (typeof cents !== 'number' || !Number.isFinite(cents)) return '—'
      return '¥' + (cents / 100).toFixed(2)
    }

    function fmtTokens(count) {
      const n = typeof count === 'number' && Number.isFinite(count) ? count : 0
      if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
      if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
      return String(n)
    }

    function fmtTime(iso) {
      if (!iso) return '—'
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return '—'
      const hh = String(date.getHours()).padStart(2, '0')
      const mm = String(date.getMinutes()).padStart(2, '0')
      return `${hh}:${mm}`
    }

    function errorText(code, t) {
      if (!code) return null
      if (code === 'no-key' || code === 'credential') return t('noKey')
      if (code === 'auth') return t('authError')
      if (code === 'offline') return t('offline')
      return t('netError')
    }

    function Line({ label, value }) {
      return h('div', { className: 'dsu-line' },
        h('span', { className: 'dsu-label' }, label),
        h('span', null, value))
    }

    function createCard(context) {
      return function UsageCard() {
        const locale = React.useSyncExternalStore(
          (listener) => context.locale.subscribe(listener),
          () => context.locale.getSnapshot(),
        )
        const t = React.useMemo(() => context.locale.bind(NS), [])
        const [data, setData] = React.useState(null)
        const [failed, setFailed] = React.useState(false)
        const [open, setOpen] = React.useState(false)
        const [refreshing, setRefreshing] = React.useState(false)
        const [pos, setPos] = React.useState(null)
        const [dragging, setDragging] = React.useState(false)

        const cardRef = React.useRef(null)
        const dragState = React.useRef(null)

        const clamp = React.useCallback((left, top) => {
          const el = cardRef.current
          const width = el ? el.offsetWidth : 210
          const height = el ? el.offsetHeight : 40
          const maxLeft = Math.max(EDGE, window.innerWidth - width - EDGE)
          const maxTop = Math.max(EDGE, window.innerHeight - height - EDGE)
          return {
            left: Math.min(Math.max(EDGE, left), maxLeft),
            top: Math.min(Math.max(EDGE, top), maxTop),
          }
        }, [])

        const clampInPlace = React.useCallback(() => {
          setPos((current) => {
            if (!current) return current
            const next = clamp(current.left, current.top)
            return next.left === current.left && next.top === current.top ? current : next
          })
        }, [clamp])

        React.useEffect(() => {
          try {
            const raw = window.localStorage.getItem(STORAGE_KEY)
            if (!raw) return
            const saved = JSON.parse(raw)
            if (Number.isFinite(saved?.left) && Number.isFinite(saved?.top)) {
              setPos(clamp(saved.left, saved.top))
            }
          } catch {
            // A blocked or malformed store simply falls back to the default corner.
          }
        }, [clamp])

        React.useEffect(() => {
          window.addEventListener('resize', clampInPlace)
          return () => window.removeEventListener('resize', clampInPlace)
        }, [clampInPlace])

        // Expanding grows downward from a dragged position; keep it on screen.
        React.useLayoutEffect(() => {
          clampInPlace()
        }, [open, clampInPlace])

        React.useEffect(() => {
          let alive = true
          let timer = null

          const load = async () => {
            try {
              const response = await fetch(STATE_URL, { cache: 'no-store', credentials: 'same-origin' })
              if (!response.ok) throw new Error('http ' + response.status)
              const payload = await response.json()
              if (!alive) return
              setData(payload)
              setFailed(false)
            } catch {
              if (alive) setFailed(true)
            }
          }

          void load()
          timer = setInterval(load, CLIENT_POLL_MS)
          return () => {
            alive = false
            if (timer) clearInterval(timer)
          }
        }, [])

        const refresh = React.useCallback(async () => {
          setRefreshing(true)
          try {
            const response = await fetch(REFRESH_URL, { cache: 'no-store', credentials: 'same-origin' })
            if (!response.ok) throw new Error('http ' + response.status)
            const payload = await response.json()
            setData(payload)
            setFailed(false)
          } catch {
            setFailed(true)
          } finally {
            setRefreshing(false)
          }
        }, [])

        const onPointerDown = (event) => {
          if (event.pointerType === 'mouse' && event.button !== 0) return
          const el = cardRef.current
          if (!el) return
          const rect = el.getBoundingClientRect()
          dragState.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originLeft: rect.left,
            originTop: rect.top,
            moved: false,
          }
          try {
            event.currentTarget.setPointerCapture(event.pointerId)
          } catch {
            // Pointer capture is best-effort; the handlers still receive moves.
          }
        }

        const onPointerMove = (event) => {
          const drag = dragState.current
          if (!drag || drag.pointerId !== event.pointerId) return
          const dx = event.clientX - drag.startX
          const dy = event.clientY - drag.startY
          if (!drag.moved) {
            if (Math.abs(dx) + Math.abs(dy) < 4) return
            drag.moved = true
            setDragging(true)
          }
          setPos(clamp(drag.originLeft + dx, drag.originTop + dy))
        }

        const finishPointer = (event) => {
          const drag = dragState.current
          if (!drag || drag.pointerId !== event.pointerId) return
          dragState.current = null
          setDragging(false)
          try {
            event.currentTarget.releasePointerCapture(event.pointerId)
          } catch {
            // Already released.
          }
          if (drag.moved) {
            setPos((current) => {
              if (current) {
                try {
                  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(current))
                } catch {
                  // Position simply is not remembered.
                }
              }
              return current
            })
          } else {
            setOpen((value) => !value)
          }
        }

        const cancelPointer = (event) => {
          const drag = dragState.current
          if (!drag || drag.pointerId !== event.pointerId) return
          dragState.current = null
          setDragging(false)
        }

        const code = failed ? 'offline' : data?.error
        const message = errorText(code, t)
        const balance = data ? fmtMoney(data.balanceCents) : '—'
        const spend = data ? fmtMoney(data.spentCents) : '—'
        const totalTokens = data
          ? (data.tokens?.input ?? 0) + (data.tokens?.cacheRead ?? 0) + (data.tokens?.output ?? 0)
          : 0
        const hasData = Boolean(data)

        const onKeyDown = (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setOpen((value) => !value)
          }
        }

        const rootStyle = pos
          ? { left: pos.left + 'px', top: pos.top + 'px', right: 'auto', bottom: 'auto' }
          : undefined

        return h('div', { className: 'dsu-root', style: rootStyle },
          h('style', null, CSS),
          h('div', {
            ref: cardRef,
            className: dragging ? 'dsu-card dsu-dragging' : 'dsu-card',
            role: 'button',
            tabIndex: 0,
            'aria-expanded': open,
            'aria-label': open ? t('collapse') : t('expand'),
            title: t('dragHint'),
            onPointerDown,
            onPointerMove,
            onPointerUp: finishPointer,
            onPointerCancel: cancelPointer,
            onKeyDown,
          },
            h('div', { className: 'dsu-row' },
              h('span', { className: 'dsu-amount' }, balance),
              h('span', { className: 'dsu-sep' }, '·'),
              h('span', { className: 'dsu-sub' }, `${t('today')} ${spend}`),
              h('span', { className: 'dsu-sep' }, '·'),
              h('span', { className: 'dsu-sub' }, `${fmtTokens(totalTokens)} tok`),
              h('span', { className: 'dsu-caret' }, open ? '▾' : '▴'),
            ),
            message ? h('div', { className: 'dsu-err' }, message) : null,
            open
              ? h('div', { className: 'dsu-detail' },
                  h(Line, { label: t('total'), value: balance }),
                  h(Line, { label: t('granted'), value: data ? fmtMoney(data.grantedCents) : '—' }),
                  h(Line, { label: t('toppedUp'), value: data ? fmtMoney(data.toppedUpCents) : '—' }),
                  h(Line, { label: t('spendToday'), value: spend }),
                  h(Line, { label: t('input'), value: data ? fmtTokens(data.tokens?.input ?? 0) : '0' }),
                  h(Line, { label: t('cacheRead'), value: data ? fmtTokens(data.tokens?.cacheRead ?? 0) : '0' }),
                  h(Line, { label: t('output'), value: data ? fmtTokens(data.tokens?.output ?? 0) : '0' }),
                  h('div', { className: 'dsu-foot' },
                    h('span', { className: 'dsu-muted' },
                      `${t('updated')} ${hasData ? fmtTime(data.balanceFetchedAt) : '—'}`),
                    h('button', {
                      type: 'button',
                      className: 'dsu-btn',
                      disabled: refreshing,
                      onPointerDown: (event) => event.stopPropagation(),
                      onClick: (event) => {
                        event.stopPropagation()
                        void refresh()
                      },
                    }, refreshing ? t('loading') : t('refresh'))))
              : null,
          ),
        )
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(context) {
        const Card = createCard(context)
        for (const [id, dict] of Object.entries(DICTS)) {
          context.effect(() => context.locale.register(NS, id, dict))
        }
        context.slots.inject('shell.overlay', () =>
          context.slots.register({
            name: 'shell.overlay',
            id: 'deepseek-usage',
            order: 50,
          }, Card),
        )
      },
    }
  },
})
