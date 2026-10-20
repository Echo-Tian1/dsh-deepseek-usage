/**
 * Host half of the DeepSeek balance & usage card.
 *
 * Responsibilities:
 *  - resolve the DeepSeek API key through the Host credential service;
 *  - poll GET /user/balance and keep "today's spend" from balance deltas;
 *  - accumulate per-call token usage from the llm/stream waterfall;
 *  - persist the daily counters so a restart does not reset them;
 *  - expose one read-only JSON route the Client half polls.
 *
 * Nothing here writes secrets to disk or to the served payload.
 */
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROUTE_BASE = '/dsh-deepseek-usage'
const STATE_VERSION = 1

const DEFAULTS = {
  apiKeyRef: 'DEEPSEEK_API_KEY',
  baseUrl: 'https://api.deepseek.com',
  balanceIntervalMs: 60_000,
  requestTimeoutMs: 15_000,
  providers: ['deepseek-official'],
}

export const inject = ['webServer', 'credentials']

function dayKey(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function toCents(raw) {
  const value = Number.parseFloat(raw)
  if (!Number.isFinite(value)) return null
  return Math.round(value * 100)
}

function statePath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'plugin-data', 'deepseek-usage', 'state.json')
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  const providers = Array.isArray(cfg.providers) && cfg.providers.length > 0 ? cfg.providers : DEFAULTS.providers

  const state = {
    day: dayKey(),
    currency: null,
    available: null,
    totalCents: null,
    grantedCents: null,
    toppedUpCents: null,
    lastBalanceCents: null,
    spentCents: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    balanceFetchedAt: null,
    balanceError: null,
    trackError: null,
  }

  const file = statePath()
  let dirty = false
  let flushing = null
  let disposed = false
  let clientHits = 0
  let clientBuild = null

  function markDirty() {
    dirty = true
  }

  function rollover(now = new Date()) {
    const key = dayKey(now)
    if (key === state.day) return
    state.day = key
    state.spentCents = 0
    state.tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    // The first sample of the new day establishes a fresh baseline.
    state.lastBalanceCents = null
    markDirty()
  }

  function snapshot() {
    return {
      version: STATE_VERSION,
      day: state.day,
      currency: state.currency,
      available: state.available,
      balanceCents: state.totalCents,
      grantedCents: state.grantedCents,
      toppedUpCents: state.toppedUpCents,
      spentCents: state.spentCents,
      tokens: {
        input: state.tokens.input,
        output: state.tokens.output,
        cacheRead: state.tokens.cacheRead,
        cacheWrite: state.tokens.cacheWrite,
      },
      balanceFetchedAt: state.balanceFetchedAt,
      error: state.balanceError ?? state.trackError,
      updatedAt: new Date().toISOString(),
      clientHits,
      clientBuild,
    }
  }

  function respond(res, body, status = 200) {
    try {
      const text = JSON.stringify(body)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(text),
      })
      res.end(text)
    } catch {
      // The client may have gone away mid-flight; nothing useful to do.
    }
  }

  async function persist(force = false) {
    if (disposed) return
    if (!dirty && !force) return
    if (flushing) return flushing
    flushing = (async () => {
      dirty = false
      const payload = {
        version: STATE_VERSION,
        day: state.day,
        currency: state.currency,
        lastBalanceCents: state.lastBalanceCents,
        spentCents: state.spentCents,
        tokens: state.tokens,
      }
      try {
        await fsp.mkdir(path.dirname(file), { recursive: true })
        const tmp = `${file}.tmp`
        await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
        await fsp.rename(tmp, file)
      } catch (error) {
        state.trackError = 'persist'
        console.error('[deepseek-usage] failed to persist state:', error instanceof Error ? error.message : error)
      } finally {
        flushing = null
      }
    })()
    return flushing
  }

  async function restore() {
    try {
      const text = await fsp.readFile(file, 'utf8')
      const saved = JSON.parse(text)
      if (saved?.version !== STATE_VERSION) return
      if (saved.day !== state.day) return
      // A live usage event may already have landed while the file was read;
      // never let the restored snapshot erase it.
      const liveTokens =
        state.tokens.input + state.tokens.output + state.tokens.cacheRead + state.tokens.cacheWrite
      if (liveTokens > 0 || state.spentCents > 0) return
      if (Number.isFinite(saved.spentCents)) state.spentCents = Math.max(0, Math.round(saved.spentCents))
      if (Number.isFinite(saved.lastBalanceCents)) state.lastBalanceCents = Math.round(saved.lastBalanceCents)
      const tokens = saved.tokens ?? {}
      state.tokens = {
        input: Number(tokens.input) || 0,
        output: Number(tokens.output) || 0,
        cacheRead: Number(tokens.cacheRead) || 0,
        cacheWrite: Number(tokens.cacheWrite) || 0,
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.error('[deepseek-usage] failed to restore state:', error instanceof Error ? error.message : error)
      }
    }
  }

  let inflight = null
  async function refreshBalance() {
    if (inflight) return inflight
    inflight = (async () => {
      rollover()
      let credential
      try {
        credential = await ctx.credentials.resolve(cfg.apiKeyRef)
      } catch {
        state.balanceError = 'credential'
        return
      }
      if (!credential?.value) {
        state.balanceError = 'no-key'
        return
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs)
      try {
        const url = `${String(cfg.baseUrl).replace(/\/+$/, '')}/user/balance`
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            authorization: `Bearer ${credential.value}`,
            accept: 'application/json',
          },
          signal: controller.signal,
        })
        if (!response.ok) {
          state.balanceError = response.status === 401 || response.status === 403 ? 'auth' : `http-${response.status}`
          return
        }
        const body = await response.json()
        const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : []
        const wallet = infos.find((info) => info?.currency === 'CNY') ?? infos[0]
        if (!wallet) {
          state.balanceError = 'shape'
          return
        }

        const totalCents = toCents(wallet.total_balance)
        if (totalCents === null) {
          state.balanceError = 'shape'
          return
        }

        rollover()
        state.currency = wallet.currency ?? null
        state.available = typeof body?.is_available === 'boolean' ? body.is_available : null
        state.totalCents = totalCents
        state.grantedCents = toCents(wallet.granted_balance)
        state.toppedUpCents = toCents(wallet.topped_up_balance)

        const previous = state.lastBalanceCents
        if (previous === null || totalCents >= previous) {
          // First sample of the day, or a top-up: no spend to add.
          state.lastBalanceCents = totalCents
        } else {
          state.spentCents += previous - totalCents
          state.lastBalanceCents = totalCents
          markDirty()
        }

        state.balanceFetchedAt = new Date().toISOString()
        state.balanceError = null
        state.trackError = null
        markDirty()
      } catch (error) {
        state.balanceError = error?.name === 'AbortError' ? 'timeout' : 'network'
      } finally {
        clearTimeout(timer)
        inflight = null
        void persist()
      }
    })()
    return inflight
  }

  function recordUsage(options, usage) {
    if (!usage) return
    if (providers.length > 0 && !providers.includes('*') && !providers.includes(options?.provider)) return
    rollover()
    const input = Number(usage.inputTokens)
    const output = Number(usage.outputTokens)
    const cacheRead = Number(usage.cacheReadTokens)
    const cacheWrite = Number(usage.cacheWriteTokens)
    if (Number.isFinite(input)) state.tokens.input += Math.max(0, input)
    if (Number.isFinite(output)) state.tokens.output += Math.max(0, output)
    if (Number.isFinite(cacheRead)) state.tokens.cacheRead += Math.max(0, cacheRead)
    if (Number.isFinite(cacheWrite)) state.tokens.cacheWrite += Math.max(0, cacheWrite)
    markDirty()
  }

  // Token accounting: observe every usage chunk without changing the stream.
  ctx.on('llm/stream', (options, next) => {
    const inner = next()
    return (async function* observe() {
      for await (const chunk of inner) {
        if (chunk && chunk.type === 'usage' && chunk.usage) recordUsage(options, chunk.usage)
        yield chunk
      }
    })()
  })

  // Read-only state route for the Client half.
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_BASE}/state`,
      handler: (req, res) => {
        clientHits += 1
        try {
          const build = new URL(req.url ?? '/', 'http://localhost').searchParams.get('c')
          if (build) clientBuild = build
        } catch {
          // A malformed request URL only loses the build marker.
        }
        respond(res, { ok: true, ...snapshot() })
      },
    }),
  )

  // Manual refresh: re-read the balance, then answer with the same payload.
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_BASE}/refresh`,
      handler: async (_req, res) => {
        await refreshBalance()
        respond(res, { ok: true, ...snapshot() })
      },
    }),
  )

  // Poll loop plus a periodic flush of the token counters.
  ctx.effect(() => {
    disposed = false
    void restore().then(() => refreshBalance())
    const poll = setInterval(() => {
      void refreshBalance()
    }, Math.max(15_000, Number(cfg.balanceIntervalMs) || DEFAULTS.balanceIntervalMs))
    const flush = setInterval(() => {
      void persist()
    }, 5_000)
    return () => {
      disposed = true
      clearInterval(poll)
      clearInterval(flush)
      void persist(true)
    }
  })
}
