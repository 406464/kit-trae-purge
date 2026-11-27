# words/ — 行为契约词库

署名：406464 — 大肥鱼 @ DeepSeek Harness

## 里面有什么

| 文件 | 说明 |
| --- | --- |
| `core.md` | 默认词库。作者自撰的行为契约，会被写进 TRAE 的全局规则目录，作为 `<user_rules>` 段进入每一次模型请求的 system prompt。 |
| `README.md` | 本文件。 |

## 装载规则（`lib/words.js`）

1. 若配置项 `wordPack` 指向一个包外的绝对/相对路径，**该路径下的 `.md` 取代整个 `words/` 目录**（不叠加）。
2. 否则读取 `words/*.md`（排除 `README*`），按文件名排序拼接。
3. 都没有时使用内置骨架（`lib/words.js` 的 `SKELETON`），此时注入的是空槽位。

## 指纹

拼接后的正文算一次 SHA-256，取前 12 位作为指纹。写入规则文件时，正文前面会带两行标记：

```
<!--trae-purge-kit:{hash12}-->
[trae-purge-kit:words {hash12}]
```

**双标记是防假阴性**：即使 TRAE 或中间层过滤掉 HTML 注释，明文哨兵那一行仍在，`scripts/verify.mjs` 仍然认得出。改一个字 → 指纹变 → `verify` 会判定为「已被改动/不是本包装的」。

> 指纹算的是**标记之后的正文**，不含标记本身，所以不会出现自引用。

## 体积上限

TRAE 规定所有规则（`AGENTS.md` / `CLAUDE.md` / `CLAUDE.local.md` / 规则目录）**总大小不超过 32 KB**。`core.md` 当前约 10 KB，留给使用者自己的规则和 AGENTS.md 仍有富余。

自定义词库时请自行核对体积：

```bash
node -e "const fs=require('fs');console.log(fs.statSync('words/core.md').size+' bytes')"
```

## 私事提醒

词库正文会**随每一次请求发给模型服务**。放进 `words/` 的任何东西（内部代号、内网地址、人名、密钥片段）都会离开你的机器。

- 分发本包时，不要把自己的定制词库一起发出去。
- 想临时用自己的词库，用 `wordPack` 指向包外路径，不要覆盖包内 `core.md`（覆盖会破坏指纹基线）。

## 改词库的规矩

`core.md` 是**被注入到模型上下文里的正文**。按本项目规范，署名只盖在不影响运行的地方（注释与元数据），**不要**往 `core.md` 里写署名——那会改变进入上下文的文本、改变指纹，也会让模型看到无意义的元信息。

署名：406464 — 大肥鱼 @ DeepSeek Harness
