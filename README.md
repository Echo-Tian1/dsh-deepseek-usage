# DeepSeek 余额与用量（DSH 插件）

给 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）桌面端/Web 端加一张常驻状态小卡，实时显示你的 DeepSeek 余额和用量。

在窗口右下角常驻一张可拖动的状态小卡，实时显示：

- **余额**：DeepSeek 账户当前可用余额（¥）
- **今日花费**：按余额差值计算，充值/赠金到账不会被误算消费
- **今日 Token**：本机 Harness 发出的 DeepSeek 调用的 token 累计

点一下卡片展开明细：总余额 / 赠金 / 充值余额 / 今日花费 / 输入（未命中缓存）/ 缓存命中 / 输出 / 上次刷新时间 / 手动刷新按钮。再点一下收起。卡片可以拖到任意位置，位置会记住。

> 设计说明与实现取舍见 [DESIGN.md](./DESIGN.md)。

## 安装

```bash
# 1. 克隆到本地任意目录
git clone https://github.com/Echo-Tian1/dsh-deepseek-usage.git
```

```bash
# 2. 在 DSH 会话里让 Agent 执行（target 换成你克隆下来的绝对路径）：
plugin_manager install_bundle target=/你的路径/dsh-deepseek-usage
```

也可以直接对 Agent 说：「安装 `/你的路径/dsh-deepseek-usage` 这个插件」。

安装后立即生效，重启 DSH 仍然保留。插件以软链方式装进当前 profile 的 `node_modules`，后续 `git pull` 更新文件后，下一次 profile 重算会自动重新加载。

## 数据来源

| 数据 | 来源 | 刷新 |
|---|---|---|
| 余额 | Credential 服务里的 `DEEPSEEK_API_KEY` → `GET https://api.deepseek.com/user/balance` | 每 60 秒 |
| 今日花费 | 余额差值累加（余额上升视为充值/赠金，不计消费） | 随余额刷新 |
| 今日 Token | Host 半监听 `llm/stream` 瀑布流，读每次调用的 `usage` 块 | 实时 |

前端每 5 秒从 `GET /dsh-deepseek-usage/state` 拉一次本地 JSON；`GET /dsh-deepseek-usage/refresh` 立即重读余额。这两个路由只读、不含密钥。

状态文件：`$DSH_HOME/plugin-data/deepseek-usage/state.json`（默认 `~/.dsh/plugin-data/deepseek-usage/state.json`）。删除它即可清零今日计数器。

## 可配置项

在 profile 的 `cordis.patch.yml` 里按行 id 覆盖（插件不强制 schema，缺省值在 `index.js` 的 `DEFAULTS`）：

```yaml
- id: deepseek-usage
  config:
    apiKeyRef: DEEPSEEK_API_KEY        # 凭据名
    baseUrl: https://api.deepseek.com  # API 基址
    balanceIntervalMs: 60000           # 余额轮询间隔（最小 15000）
    providers: [deepseek-official]     # 计入 token 的 LLM 路由，["*"] 为全部
```

## 能力边界（务必知道）

- **Token 只统计本机 Harness 的调用**。你用 curl / 其他客户端跑的请求不计入 token 数，但会体现在「今日花费」的余额差值里。
- **「今日花费」包含赠金到期**。DeepSeek 赠金过期时余额会下降，插件无法区分「赠金被用完」和「赠金到期」，两种情况都会计入今日花费。
- **余额有账单延迟**，所以是每分钟刷新，不是逐秒；刚发生的大额调用可能几十秒后才反映。
- **今日数据从插件首次启动开始累计**。安装当天早先的消耗没有基线，不会回溯。
- **只支持 API Key 登录**（读取 `DEEPSEEK_API_KEY`）。走 DeepSeek 账号 OAuth 登录的 profile 需要改成读取账号服务（当前 desktop profile 是 API Key）。
- **可拖动**：按住卡片拖到任意位置，松手后记住（存在浏览器 localStorage，刷新和重启后仍在原位）；位置会自动限制在窗口内，展开明细时若会超出屏幕会自动上移。默认停在右下角发送键上方（`right:16px; bottom:104px`）。
- **点击与拖动分开**：移动超过 4px 才算拖动，否则算点击（展开/收起明细）；刷新按钮不受拖动影响。
- **没有隐藏开关**（如需彻底隐藏，在插件管理器里禁用插件）。

## 卸载

```bash
plugin_manager remove_bundle target=@local/deepseek-usage
```

状态文件不会自动删除，可手动删 `~/.dsh/plugin-data/deepseek-usage/`。

## 结构

```
dsh-deepseek-usage/
├── index.js            # Host 半：凭据、余额轮询、token 归集、本地路由、落盘
├── client.js           # Client 半：shell.overlay 常驻卡片 + 轮询
├── cordis.patch.yml    # 插入 deepseek-usage 行
├── package.json        # dsh.bundle.patch + dsh.client
├── locale/{zh,en}.json # 插件管理器里显示的名称与描述
└── icon.svg            # 插件图标
```
