# trae-purge-kit

**TRAE IDE 的规则文件注入套件 + 一份「请求发往哪个入口」由你自己配置的档案与自检。**
往 TRAE 自己的全局规则目录写一个文件；不改 IDE 二进制、不装后台服务、不联网上报，卸载一键回滚。

**A behavior-contract injector for TRAE IDE, plus a way to take back control of *where requests go*.**
It writes one file into TRAE's own global-rules directory. No IDE binary changes, no background services, no telemetry; uninstall restores.

> **先读边界再装 / Read the boundary page first:** [`docs/CAPABILITY.md`](docs/CAPABILITY.md) · 免责声明见文末 [Disclaimer](#免责声明--disclaimer)

---

## 0. 名字，别和别人的撞 / Naming (deliberately disambiguated)

| 用途 | 名字 |
|---|---|
| GitHub 仓库 | **`kit-trae-purge`** |
| npm 包名 / CLI / 规则文件名 | `trae-purge-kit` |
| VSIX 扩展 | `Id=trae-purge-kit`，`Publisher=purge-kit`（本地导入用；未发布到任何扩展市场） |
| 规则落点 | `<TRAE_HOME>/user_rules/rule-trae-purge-kit.md` |

⚠ GitHub 上另有第三方仓库 `trae-purge`（少一个 `-kit` 后缀），与本项目无关，也不是它的 fork。要拿本包：`github.com/406464/kit-trae-purge`。

There is an unrelated third-party repo named `trae-purge` (without the `-kit` suffix) — different project, not a fork.

## 1. 两句话原理 / How it works

TRAE 的回复不是一层决定的。本机实测到两层，各自的开关在不同地方：

| 层 | 在哪 | 本包能不能改 |
|---|---|---|
| 闸 2：模型自身的对齐与拒答措辞 | 权重里的 RLHF 倾向，进 prompt 的 `<user_rules>` 段 | **能**（规则注入） |
| 闸 1：TRAE 云端的内容安全判定 | 供应商服务器上（错误码 979 / 983） | **不能**——只能换入口：自定义 OpenAI 兼容模型 / 本地权重 |

搞混这两层，就会在错误的地方加长词表。本包把「规则到底在不在位、内容有没有被改」变成可核对断言（四项断言 + 双指纹 marker/sentinel），并给换入口那条路提供档案与分诊流程。

Refusals come from two different places. The rule layer can move the **model's own** alignment/wording (闸 2). It cannot move **TRAE's cloud-side content safety** (闸 1, error 979/983) — for that the only lever is changing the entry point (a custom OpenAI-compatible model, or local weights). The kit turns "is my rule actually in place and unmodified?" into checkable assertions (four assertions + marker/sentinel double fingerprint).

## 2. 三分钟上手 / Quick start

```bash
node scripts/preflight.mjs     # 只读体检：TRAE 在哪、规则目录、32 KB 余量、同类件冲突
node scripts/install.mjs       # 安装（会问一次确认；写前必备份）
node scripts/verify.mjs        # 断言：文件在位 + 内容未被改（双指纹）
node scripts/status.mjs        # 全貌：宿主、规则、词库指纹、其它规则占用
node scripts/uninstall.mjs     # 回滚（优先还原备份）
```

然后：**开新对话**（实测规则改动在新对话即时生效；换模型/改配置目录才需要完全重启）。

若仍报 979 / 983：那是服务端判定，规则层管不了。按 [`docs/BYPASS-LAYERS.md`](docs/BYPASS-LAYERS.md) 的 L1 换入口——「设置 → 模型管理」加一个 **OpenAI 兼容的自定义模型**，把聊天切过去。

Then open a **new** conversation. If you still get 979/983, that is the server-side decision; switch the entry point instead (see `docs/BYPASS-LAYERS.md` §L1).

## 3. 能做到什么（带证据等级）/ What it does, with evidence grades

`observed` 本机实测 · `documented` 官方/一致来源 · `unverified` 未验证。**别把低等级读成能力承诺。**

| 能力 | 怎么做 | 证据 |
|---|---|---|
| 把行为契约注入 TRAE 全局规则 | 写 `<TRAE_HOME>/user_rules/rule-trae-purge-kit.md`，进 prompt 的 `<user_rules>` 段 | observed + documented |
| 去掉模型自身的拒绝式措辞 | 词库「措辞闸」= 禁用措辞 → 替代表述对照表 | observed（回答末尾会带自定义标记，证明确实进了上下文） |
| 改变模型自身在安全技术话题上的拒答倾向（闸 2） | 词库「反推脱条款」+「可直接填充的产物槽」两段配合 | observed：只给措辞对照表时仍被拒；配上这两段后一次通过 |
| 技术类意图不追问范围 | 词库「意图路由」 | observed（渗透类直接给命令，不反问范围） |
| 自检规则在位与未被改 | 四项断言 + 双指纹（HTML 注释 marker + 明文 sentinel） | observed（自检脚本在假环境里跑全链路） |
| 幂等安装 / 一键回滚 | 备份 → 写入 → 状态记录；卸载优先还原备份 | observed |
| 可选本地 relay：注入上游安全阈值 + 被过滤后按阶梯重投 | `scripts/relay.mjs`，只监听 `127.0.0.1` | observed（**机制**：9 条断言由 `scripts/relay-test.mjs` 全过，本地夹具端到端）；对真实服务商 `unverified` |
| 一份可直接「从 VSIX 安装」的扩展 | `dist/trae-purge-kit-<ver>.vsix`（激活只提示，不自动写盘） | observed（导入后可见命令面板五项） |

## 4. 做不到什么 / What it does NOT do

1. **关闭 TRAE 云端的内容安全。** 那一层在别人服务器上，没有客户端开关。979 / 983 与「换措辞」无关。
2. **保证任何第三方服务端不拦。** 同上。relay 的重投阶梯是启发式的，不保证过任何特定上游的过滤。
3. **改 TRAE 的安装目录、二进制、进程。** 不可逆、会被更新覆盖、跨版本失效，而且对服务端判定无效。
4. **代填 API Key、代登录、代过验证码。** 必须由使用者本人完成。
5. **动用户其它规则文件。** 只写自己那一个文件；回滚也只针对它。
6. **联网上报。** 零遥测；唯一出网是你自己启动 relay 后的模型请求。relay 默认不记录请求体与响应体。
7. **证明 TRAE 一定加载了规则。** `verify` 只能证明文件在位且内容未被改；是否进上下文要人工做一次行为验证（本包给的方法见 `docs/ENTRY-GATE.md`）。
8. **不保证跨版本可用。** TRAE 升级后配置根、规则目录名、错误码语义都可能变；`status` / `verify` 会在路径失效时报出来。

1. It cannot switch off TRAE's cloud-side content safety (979/983) — there is no client-side switch. 2. It guarantees nothing about third-party servers; the relay's retry ladder is heuristic. 3. No IDE binary/process changes. 4. It will not fill in API keys, log in for you, or solve captchas. 5. It touches exactly one rule file and rolls back only that. 6. No telemetry. 7. `verify` proves the file is in place and unmodified — not that TRAE loaded it into context; that needs one manual behavior check. 8. No cross-version guarantee.

## 5. 写盘清单（全部可回滚）/ Disk footprint

| 路径 | 何时写 | 卸载时 |
|---|---|---|
| `<TRAE_HOME>/user_rules/rule-trae-purge-kit.md` | 安装 | 还原备份 / 删除 |
| `<TRAE_HOME>/user_rules/rule-trae-purge-kit.md.bak-<stamp>` | 安装（有旧文件时） | 保留 |
| `<TRAE_HOME>/.trae-purge-kit/state.json` | 安装 | 删除 |
| `<TRAE_HOME>/user_rules/<其它>.md` | **从不** | — |

无守护进程、无自启动、无计划任务。读取范围：自己那一个规则文件与状态文件，以及同目录其它规则的**文件名与大小**（用于算 32 KB 总量，不读内容）。

## 6. 上机前必查 / Before you run it

1. **relay 的上游协议**：TRAE 自定义模型走 OpenAI 兼容（`messages`）。relay 的 `safetySettings` 注入只对 Gemini 原生形状生效（路径含 `/v1beta/` 或体里有 `contents`）——OpenAI 形状下不注入，这是预期，不是 bug。
2. **32 KB 规则总量上限**：先跑 `status.mjs` 看「其它规则」合计字节数，再决定词库长度。
3. **目录信任**：全局规则不受项目目录信任限制；项目级规则受。
4. **压缩响应**：relay 把 `accept-encoding` 覆写成 `identity`；个别上游仍回 gzip/br，relay 只为判定过滤信号而解开，不剥 `content-encoding`（`relay-test.mjs` R6/R8 已钉住）。

## 7. 词库与授权 / Word pack and licensing

`words/core.md` 是作者自撰的行为契约文本，随包 MIT 分发；**不含任何第三方词表、受限语料或转录内容**。
你把自己机器上的定制词库放进 `words/` 再分发时，那份正文的授权、署名与再分发条件由它的作者决定，与本包代码无关（见 `NOTICE`）。

⚠ **规则正文会随请求发给模型服务**：别把机密、内部主机名、员工姓名、业务代号写进词库。`scripts/scrub.mjs` 拦的是**本包发布件**里的本机标识，救不了你自己往里塞的东西。

The rule text ships with every request to whatever model service you configured — never put secrets, internal hostnames or staff names into the word pack.

## 8. 文档 / Docs

- [`docs/CAPABILITY.md`](docs/CAPABILITY.md) — 能力与边界、已知限制、安全设计（**必读**）
- [`docs/BYPASS-LAYERS.md`](docs/BYPASS-LAYERS.md) — 内容闸在哪一层、每层能做什么、代价与证据等级
- [`docs/ENTRY-GATE.md`](docs/ENTRY-GATE.md) — 入口闸实战：被拦之后怎么定位是谁拒的
- [`docs/INSTALL.md`](docs/INSTALL.md)（人） / [`docs/INSTALL.agent.md`](docs/INSTALL.agent.md)（代你安装的 agent，每步带判据与回滚）
- [`docs/NETWORK.md`](docs/NETWORK.md) — 网络行为清单

## 9. 发布前自检（三关，不过不出包）/ Release gates

```bash
node scripts/attest.mjs --check # 署名位置检查（介绍不留署名，署名只进元数据与源码头）
node scripts/scrub.mjs          # 隐私扫描（不硬编码任何具体用户名，本机身份运行时取）
node scripts/selfcheck.mjs      # 假环境里装 → 验 → 卸，全链路
node scripts/pack.mjs           # 出 dist/*.zip
node scripts/pack-vsix.mjs      # 出 TRAE 可导入的 .vsix
```

## 10. 免责声明 / Disclaimer & License

- **AS-IS，无任何担保。** 本包提供的是机制（规则注入、档案、断言、可选 relay）与文档化的分层说明，不提供任何效果承诺。在法律允许的最大范围内，作者不对使用本包造成的任何损失负责。
- **能签的是「规则在位且未被改」，不是「模型一定照做」，更不是「云端一定不拦」。**
- **不代为授权。** 本包不修改 TRAE 客户端二进制，不修改任何第三方服务端的安全策略，也不代为授权对任何第三方服务、软件或系统的访问。使用者需自行确认：分析/使用场景所在地的法律、所接入服务商的服务条款与配额规则、以及你自己选择的模型入口是否允许该类内容。
- **换入口是有代价的。** 走自定义模型或本地权重意味着你自己承担 key、计费、数据出境与可用性——本包不代填、不代付、不代持凭据。
- **只在你自己的机器上装。** 未经机器所有者同意安装任何规则/扩展都是越界；对别人机器的防护本包不做默认改动。
- **第三方商标。** TRAE 及其相关名称、商标与版权归其厂商（ByteDance 相关主体）所有。本包与其**没有隶属、授权或背书关系**，只读写该应用在自己用户目录下生成的规则与状态文件。
- **成年向/敏感内容**：词库与文档里的样例只为定位「哪一层拦的」这一技术判据，全部为虚构或占位内容；是否可在你的渠道分发由你自行判断与负责。
- **许可。** 代码与文档 MIT（见 `LICENSE`）；`words/core.md` 为作者自撰、随包同许可；分层授权见 `NOTICE`。发给别人时请连同 `docs/CAPABILITY.md` 一起发，不要只发压缩包。

**Provided as-is, with no warranty of any kind.** This kit supplies mechanisms (rule injection, provider profiles, assertions, optional local relay) and documented layer analysis — never an outcome guarantee. What is verifiable is "the rule file is present and unmodified", not "the model will comply" and certainly not "the cloud will allow it".
**No authorization is granted here.** It does not modify the TRAE client binary, does not alter any third-party service's security policy, and does not authorize access to any third-party service, software, or system. You are responsible for applicable law, the terms of the services you connect to, and whether the model entry point you chose permits the content in question.
**Switching entry points has a price:** custom models and local weights mean you carry the keys, billing, data egress and availability yourself — this kit never fills in credentials, pays, or holds them.
**Install only on machines you own or may modify.** TRAE and its marks belong to their owner; this project is unaffiliated, unauthorized, and unendorsed, and reads/writes only that application's own user-directory files. Sample content in the pack and docs exists to locate *which layer* rejected it — it is fictional or placeholder. License: MIT (code and docs); see `NOTICE` for the per-layer terms. When sharing, share `docs/CAPABILITY.md` with it.
