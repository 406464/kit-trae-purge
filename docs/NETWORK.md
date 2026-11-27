# 网络行为清单

> 这份文件回答一个问题：**这套件会不会把你的东西发出去？**
> 答案：**默认不会。** 唯一的出网路径需要你显式启动 relay，而 relay 只监听本机回环地址。

---

## 1. 默认状态：零出网

| 组件 | 是否联网 | 说明 |
| --- | --- | --- |
| `scripts/install.mjs` | ❌ | 只读写本机文件 |
| `scripts/uninstall.mjs` | ❌ | 同上 |
| `scripts/status.mjs` | ❌ | 同上 |
| `scripts/verify.mjs` | ❌ | 同上 |
| `scripts/preflight.mjs` | ❌ | 只读探测（含一个本地端口探测） |
| `scripts/selfcheck.mjs` | ❌ | 在系统临时目录里造假环境跑 |
| `scripts/attest.mjs` / `scrub.mjs` / `pack.mjs` | ❌ | 纯本地 |
| VSIX 扩展 | ❌ | 只读写 `~/.trae-cn` 下的三个文件 |
| `scripts/relay.mjs` | ⚠️ 见下 | 只有你启动它才有出网 |

## 2. relay 的网络行为

### 2.1 监听面

- 只监听 **`127.0.0.1`**（回环），**不监听 `0.0.0.0`**，局域网与公网都访问不到。
- 端口默认 `8788`，可用 `--port` 改。
- 健康检查：`GET /__health`，返回累计计数，不含任何请求内容。

### 2.2 出网方向

- 只向 **你用 `--upstream` 指定的那一个地址**转发。
- 其它路径没有第二个出口，没有任何遥测、统计、更新检查。

### 2.3 凭据

| 来源 | 规则 |
| --- | --- |
| API Key | **只从环境变量读**（默认 `OPENAI_API_KEY`，可用 `--key-env` 换名）。不写文件、不打日志、不回显、不进错误信息。 |
| 调用方的 `Authorization` 头 | 若环境变量里没有 Key，relay 原样透传调用方的头。 |
| 上游返回 | 原样转发给 TRAE，不落盘。 |

### 2.4 日志

**默认只记这些**：

```json
{"t":"2026-01-01T00:00:00.000Z","attempt":0,"status":200,"blocked":false,"level":0,"fp":"a1b2c3d4e5f6"}
```

- `attempt`：第几次尝试
- `status`：上游 HTTP 状态码
- `blocked`：是否命中过滤信号
- `level`：形式阶梯档位
- `fp`：请求体的 SHA-256 前 12 位（**指纹，不是内容**）

**默认不记录**：请求体、响应体、消息内容、头里的凭据。

`--log-bodies` 会打开正文记录——**只在排查时临时用，用完关掉**。打开时控制台会提示日志里会出现明文。

### 2.5 不做的事

- 不写磁盘缓存、不做请求录制、不上传崩溃报告。
- 不给第三方统计/遥测端点发任何东西。
- 不改请求体的语义之外的头：转发时会覆写 `accept-encoding` 为 `identity`（要求上游别压缩，否则错误体判不出是不是过滤类，重投会静默失效），必要时用环境变量里的 Key 覆写 `Authorization`，并去掉 `host` / `content-length` / `connection` 这三个协议必需项。其余头原样透传。
- 响应侧不剥 `content-encoding`：body 字节我们没动过，剥了头就等于把压缩数据当明文交给 TRAE（会显示乱码）。只有 `content-length` / `transfer-encoding` 由 Node 重算。

## 3. 「规则正文会出网」这件事

这一条必须讲清楚，因为它容易被忽略：

> `~/.trae-cn/user_rules/rule-trae-purge-kit.md` 的内容，会随**每一次对话请求**发给模型服务。
>
> - 你用 TRAE 内置模型 → 发给 TRAE 的云服务。
> - 你用自定义模型 → 发给你自己指定的服务商。
> - 你用本地模型 → 不出网。

所以：

- **不要**把内部代号、内网地址、员工姓名、客户数据、业务机密写进 `words/` 里的自定义词库。
- 分发本套件给别人时，用 `node scripts/scrub.mjs` 确认没有这类残留。
- 规则正文里**不应该有**你的 API Key（relay 需要的 Key 从环境变量读，不进规则）。

## 4. 分发前自查

```bash
node scripts/scrub.mjs                 # 查本机路径、用户名、IP、密钥残留
node scripts/scrub.mjs --deny-file b.txt   # 追加自定义黑名单（b.txt 每行一条）
node scripts/selfcheck.mjs             # 全链路自检
node scripts/pack.mjs                  # 三关全过才出包
```

`scrub` 的规则**不硬编码任何具体用户名或目录名**：它靠运行时探测（`HOME` / `USERPROFILE`）与通用正则来判定。上一版把某个具体用户名写进规则的做法，换个人分发就完全失效了——这版修掉了。
