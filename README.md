# DeepSeek 余额与用量（DSH 插件）

在 DSH 窗口右下角常驻一张状态小卡，实时显示：

- **余额**：DeepSeek 账户当前可用余额（¥）
- **今日花费**：按余额差值计算，充值/赠金到账不会被误算消费
- **今日 Token**：本机 Harness 发出的 DeepSeek 调用的 token 累计

点一下卡片展开明细：总余额 / 赠金 / 充值余额 / 今日花费 / 输入（未命中缓存）/ 缓存命中 / 输出 / 上次刷新时间 / 手动刷新按钮。再点一下收起。

## 安装

```bash
# 在 DSH 会话里让 Agent 执行：
plugin_manager install_bundle target=/绝对路径/到/dsh-deepseek-usage
```

或直接交给 Agent：「安装 /Users/echo/Downloads/插件/dsh-deepseek-usage 这个插件」。

安装后立即生效，重启 DSH 仍然保留。插件写入当前 profile 的 `node_modules`（软链到本目录），修改本目录里的文件后，下一次 profile 重算会自动重新加载。

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
- 卡片常驻右下角，**不可拖拽、没有隐藏开关**；不遮挡布局（overlay 层本身点击穿透，只有卡片本体接收点击）。

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
