# DeepSeek 余额与用量悬浮卡 — 设计文档

日期：2026-10-20
状态：已实现并安装到 `desktop` profile

## 背景与现状调研

用户想要「桌面上实时显示 DeepSeek 余额和用量」。调研结论：

1. **余额显示已存在一半**：DSH 设置 → 账户页已能显示充值余额与赠金余额，但只在打开页面时读取一次，不常驻、不自动刷新。
2. **账户级用量没有公开接口**：官方只提供 `GET /user/balance`（`is_available` + `balance_infos[]`，含 `total_balance` / `granted_balance` / `topped_up_balance`）。平台「用量」页没有等价 API；Harness 里只有跳转链接和会话级 token 统计。
3. **本机 token 用量可得**：Host 的 `llm/stream` 瀑布流每个调用都会带 `{ type: 'usage', usage: TokenUsage }`，包含 `inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens`。实测 DeepSeek 的 `inputTokens` 是未命中缓存的部分，缓存命中单独在 `cacheReadTokens`。
4. **该 profile 走 API Key**：`~/.dsh/.credentials.yaml` 的 refs 里有 `DEEPSEEK_API_KEY`，`ui-settings-account` 的 `completion: api-key` 也印证没走账号登录。因此余额通过凭据 + `/user/balance` 获取，而不是 `ctx.deepseekAccount.getBalance()`。

结论：缺的是「常驻 + 实时」这一层，需要新插件补齐。

## 需求（已与用户确认）

- 位置：DSH 窗口右下角常驻悬浮卡（`shell.overlay` 插槽，官方说明该层就是给 badge / status pill 用的，图层点击穿透）。
- 收起态：`¥ 余额 · 今日 ¥花费 · N tok`。
- 展开态：总余额 / 赠金 / 充值余额 / 今日花费 / 输入 / 缓存命中 / 输出 / 更新时间 / 刷新按钮。
- 用量的口径：今日花费 ¥（余额差值）+ 今日 token（本机调用累计）。
- **可拖动**（第二轮补充）：因为默认位置挡住了输入框右下角的发送键，卡片改为可拖动，位置存 localStorage，窗口缩放和展开明细时自动收进可视区；默认位置移到发送键上方（`bottom:104px`）。
- 不做：隐藏开关、账户级平台用量抓取。

## 架构

```
┌──────────────────────── Host 进程 ────────────────────────┐
│ credentials.resolve('DEEPSEEK_API_KEY')                    │
│        │                                                   │
│        ├─ 每 60s → GET /user/balance → 余额 + 今日花费累加  │
│        │                                                   │
│        └─ llm/stream 监听 usage 块 → 今日 token 累加       │
│                          │                                 │
│   state.json 落盘 ←───────┤                                 │
│                          ▼                                 │
│  webServer 路由 /dsh-deepseek-usage/state（只读 JSON）      │
└────────────────────────────┬───────────────────────────────┘
                             │ 前端每 5s GET
┌────────────────────────────┴───────────────────────────────┐
│ Client 进程（页面）                                         │
│ shell.overlay 插槽 → 右下角卡片（React，无 JSX）           │
│ 主题色走 --dsw-alias-* token，文案走 locale 字典            │
└────────────────────────────────────────────────────────────┘
```

### 为什么用自定义 HTTP 路由做 Host→Client 通道

已安装 bundle 的 Client 半只能拿到 Client 服务（slots/locale/theme/sessions…）；Host 的 `@Remote` 命名空间是带编译期 typert schema 的生成代码，第三方纯 JS 包没有受支持的注册入口。`ctx.webServer.register()` 提供 exact 路由，页面同源 `fetch` 即可读到 JSON。路由本身无鉴权（只监听 loopback），但只返回余额与计数，不含密钥；跨站页面受 CORS 限制读不到响应体。

### 今日花费的记账规则

每次成功读到余额：

- 首次采样（当天）：记为基线，不计消费。
- 余额上升：视为充值/赠金，更新基线，不计消费。
- 余额下降：`今日花费 += 基线 - 当前`，基线跟到当前。

零点跨天：清零花费与 token，基线置空等下一次采样重新建立。

已知偏差：赠金到期也会让余额下降，与「赠金被消费」不可区分，会一并计入今日花费。

### Token 记账

`ctx.on('llm/stream', (options, next) => ...)` 包装返回的异步迭代器，逐块透传，遇到 `type: 'usage'` 就按 `options.provider` 过滤后累加，然后原样 yield。不改变流、不吞错误、不重排。计数包含 compaction、会话标题生成等所有走 DeepSeek 路由的调用（它们同样消耗余额）。

### 持久化

`$DSH_HOME/plugin-data/deepseek-usage/state.json`，字段：`day`、`currency`、`lastBalanceCents`、`spentCents`、`tokens`。写入用 tmp + rename；每 5 秒 flush 一次，卸载时强制 flush。恢复时若内存里已有实时计数则跳过覆盖，避免「读取文件期间到达的 usage」被旧快照抹掉。

## 拖拽与位置记忆

- 卡片用 Pointer Events 实现拖动：`pointerdown` 记录起点与元素矩形，`pointermove` 位移超过 4px 才判定为拖动（避免点击被误吞），`pointerup` 时若移动过就写 localStorage、否则切换明细展开。
- 坐标以视口左上角为基准，拖动时用 `offsetWidth/offsetHeight` 夹取到 `[8, innerWidth - w - 8]`，因此不会拖出屏幕。
- 位置存在 `localStorage['dsh.deepseek-usage.position']`，刷新页面和重启应用后仍回到原位；没存过位置时用 CSS 默认值（`right:16px; bottom:104px`，位于发送键上方）。
- 展开明细会让卡片变高，`useLayoutEffect` 在展开后重新夹取一次，避免向下超出屏幕；窗口 resize 时同样重新夹取。
- 刷新按钮在 `pointerdown` 上 `stopPropagation`，不会触发拖动。

## 错误处理

| 情况 | 表现 |
|---|---|
| 无 API Key | 卡片显示「未找到 DEEPSEEK_API_KEY」，不显示假 0 |
| Key 401/403 | 「API Key 无效或已失效」 |
| 网络失败 / 超时 | 「余额读取失败，稍后自动重试」，保留上一次成功的数值 |
| 前端拿不到本地路由 | 「插件服务未响应」 |
| 响应结构异常 | 按失败处理，不制造 0 余额 |

## 验证（已执行）

- `node --check index.js`、`node --check client.js`、三个 JSON 文件解析：通过。
- `plugin_manager install_bundle` → `application: applied`，无 warnings。
- `GET /dsh-deepseek-usage/state` 返回真实数据：`balanceCents: 3542`（¥35.42）、`spentCents: 14`（¥0.14，余额 3556→3542）、token 持续累加。
- 余额轮询生效：`balanceFetchedAt` 随 60 秒周期前进。
- 手动刷新路由：调用后 `balanceFetchedAt` 立即更新、花费重新计算。
- Client 插槽：`shell.overlay` occupants 出现 `deepseek-usage`（order 50，active）。
- **渲染与轮询实证**：在 Host 路由增加 `clientHits` 计数器，排除自身探测请求后，20 秒窗口内收到 3 次页面轮询（约 5 秒一次）。组件若在渲染阶段抛错，effect 不会运行，也就不会有轮询 → 说明卡片已成功挂载并渲染。
- **Client 版本实证**：Client 轮询带 `?c=<build>`，Host 把该值记在 `clientBuild` 并在状态里返回。重算后读到 `clientBuild: "3"`，证明页面跑的是含拖拽逻辑的新 bundle，而不是安装时的旧 bundle。
- 拖动的手感、边界吸附、深色模式观感**未做截图/自动化验证**：本会话无浏览器控制能力，需用户目视确认。

## 已知取舍

- 位置存在浏览器 localStorage，而不是 Host 设置：换一个浏览器访问同一个 Host 会回到默认位置。若以后要跨浏览器同步，改为 Host 设置命名空间。
- 折叠态与展开态共用同一个锚点，展开向下生长；当拖动后位置考下时依靠夹取上移，此时折叠回去不会恢复原位置（下次刷新仍回到拖动时记录的位置，因为记录只在拖动结束时写入）。

## 交付物

- `dsh-deepseek-usage/`：可安装插件包（Host + Client + locale + icon）。
- 已安装到 `desktop` profile，`application: applied`。
- 本设计文档 + 插件 README（含能力边界与卸载方式）。

## 后续可选

- 账号 OAuth 登录场景：优先走 `ctx.deepseekAccount.getBalance()`。
- 悬浮卡吸附位置、透明度、悬停才展开等偏好项。
- 按模型拆分 token、展示日趋势曲线。
- 把「今日花费」改为余额差 + 平台账单交叉校验（若未来开放用量 API）。
