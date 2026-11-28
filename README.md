# trae-purge-kit

**Rule-file injection, provider profiles and load self-check for the TRAE IDE.**
It writes one file into TRAE's own global-rules directory; no IDE binary changes, no background service, no telemetry, one-command rollback.

**English** · [简体中文](README.zh.md)

> Read the boundary page first: [`docs/CAPABILITY.md`](docs/CAPABILITY.md) · disclaimer at the end.

---

## 0. Naming

| What | Name |
|---|---|
| GitHub repo | **`kit-trae-purge`** |
| npm package / CLI / rule file name | `trae-purge-kit` |
| VSIX extension | `Id=trae-purge-kit`, `Publisher=purge-kit` (local import only; not published to any extension marketplace) |
| Rule location | `<TRAE_HOME>/user_rules/rule-trae-purge-kit.md` |

An unrelated third-party repo named `trae-purge` (without the `-kit` suffix) is a different project and not a fork of this one.

## 1. How it works, in two lines

A TRAE reply is not decided by one layer. Two layers were measured on this machine, and their switches live in different places:

| Layer | Where | Can this kit change it? |
|---|---|---|
| Gate 2 — the model's own alignment and refusal wording | RLHF tendencies in the weights; the `<user_rules>` section of the prompt | **Yes** (rule injection) |
| Gate 1 — TRAE's cloud-side content decision | on the vendor's servers (error codes 979 / 983) | **No** — the only lever is changing the entry point: a custom OpenAI-compatible model, or local weights |

Mixing the two up means adding more words in the wrong place. The kit turns "is my rule actually in place and unmodified?" into checkable assertions (four assertions plus a marker/sentinel double fingerprint) and supplies profiles and triage for the entry-point route.

## 2. Quick start

```bash
node scripts/preflight.mjs     # read-only: where TRAE is, the rules directory, 32 KB headroom, conflicts
node scripts/install.mjs       # install (asks once; backs up first)
node scripts/verify.mjs        # assertions: file present + content unmodified (double fingerprint)
node scripts/status.mjs        # overview: host, rules, pack fingerprint, other rules' footprint
node scripts/uninstall.mjs     # roll back (restores the backup first)
```

Then open a **new** conversation (rule changes take effect in new conversations; only a model or config-directory change needs a full restart). If you still get 979/983, that is the server-side decision — switch the entry point per [`docs/BYPASS-LAYERS.md`](docs/BYPASS-LAYERS.md) §L1.

## 3. What it does (evidence grades)

`observed` measured here · `documented` official or consistent sources · `unverified` not verified. **Do not read a low grade as a capability claim.**

| Capability | How | Grade |
|---|---|---|
| Inject a behavior contract into TRAE's global rules | writes `<TRAE_HOME>/user_rules/rule-trae-purge-kit.md`, which lands in the prompt's `<user_rules>` section | observed + documented |
| Remove the model's own refusal wording patterns | the pack's "wording gate": a banned-wording → replacement table | observed (replies carry the custom marker, which proves the text reached the context) |
| Move the model's own refusal on security-technical topics (gate 2) | the pack's "anti-hedging clauses" plus "fill-in product slots" working together | observed: with the wording gate alone requests were still refused; with these two sections they went through in one turn |
| No scope interrogation on technical intents | the pack's intent routing | observed |
| Verify the rule is present and unmodified | four assertions + double fingerprint (HTML-comment marker + plain-text sentinel) | observed (the self-check runs the whole chain in a fake environment) |
| Idempotent install / one-command rollback | backup → write → state file; uninstall restores the backup first | observed |
| Optional local relay: inject upstream safety thresholds, retry on a graded ladder when filtered | `scripts/relay.mjs`, listens on `127.0.0.1` only | observed (**mechanism**: 9 assertions pass in `scripts/relay-test.mjs`, local fixtures end-to-end); against real providers `unverified` |
| A VSIX you can install directly ("Install from VSIX") | `dist/trae-purge-kit-<ver>.vsix` (activation only prompts, never writes on its own) | observed |

## 4. What it does NOT do

1. **Switch off TRAE's cloud-side content safety.** That lives on the vendor's servers with no client-side switch. 979/983 has nothing to do with wording.
2. **Guarantee any third-party server lets something through.** The relay's retry ladder is heuristic.
3. **Touch TRAE's install directory, binaries or processes.** Irreversible, overwritten by updates, dead across versions, and ineffective against server-side decisions.
4. **Fill in API keys, log in for you, or solve captchas.** Those are yours.
5. **Touch your other rule files.** It writes exactly one file and rolls back exactly that one.
6. **Phone home.** Zero telemetry; the only outbound traffic is your own model requests once you start the relay, which logs neither request nor response bodies by default.
7. **Prove that TRAE loaded the rule.** `verify` proves the file is present and unmodified; whether it reached the context needs one manual behavior check (method in `docs/ENTRY-GATE.md`).
8. **Guarantee cross-version stability.** TRAE updates can change the config root, the rules directory name and error-code semantics; `status` / `verify` report when a path goes stale.
9. **Publish to an extension marketplace.** The VSIX is built for local import only.

## 5. Disk footprint

| Path | When | On uninstall |
|---|---|---|
| `<TRAE_HOME>/user_rules/rule-trae-purge-kit.md` | install | restore backup / delete |
| `<TRAE_HOME>/user_rules/rule-trae-purge-kit.md.bak-<stamp>` | install (existing file) | kept |
| `<TRAE_HOME>/.trae-purge-kit/state.json` | install | deleted |
| `<TRAE_HOME>/user_rules/<others>.md` | **never** | — |

No daemon, no autostart, no scheduled tasks. Reads: its own rule file and state file, plus the **names and sizes** of sibling rules (to compute the 32 KB total; contents are never read).

## 6. Before you run it

1. **Relay upstream protocol**: TRAE's custom models speak OpenAI-compatible (`messages`). The relay's `safetySettings` injection only applies to the Gemini-native shape (path containing `/v1beta/`, or a body with `contents`) — with an OpenAI-shaped upstream, nothing is injected. That is expected, not a bug.
2. **The 32 KB rule total**: run `status.mjs` first and look at the footprint of your other rules before deciding how long the pack should be.
3. **Directory trust**: global rules are not subject to project-directory trust; project-level rules are.
4. **Compressed responses**: the relay rewrites `accept-encoding` to `identity`; if an upstream still returns gzip/br, the relay only decompresses to judge whether a filter signal is present and does not strip `content-encoding` (`relay-test.mjs` R6/R8 pin this path).

## 7. The word pack and licensing

`words/core.md` is a self-authored behavior contract shipped under the same MIT license as the code; it contains **no third-party word list, restricted corpus, or transcript**.

⚠ **The rule text is sent with every request** to whatever model service you configured: never put secrets, internal hostnames, staff names or business code names into the pack. `scripts/scrub.mjs` guards **this package's** artifacts against machine identifiers; it cannot save what you paste in yourself.

## 8. Docs

- [`docs/CAPABILITY.md`](docs/CAPABILITY.md) — capabilities, bounds, known limits, safety design (**read this**)
- [`docs/BYPASS-LAYERS.md`](docs/BYPASS-LAYERS.md) — which layer a rejection comes from, what each layer can do, cost and evidence grade
- [`docs/ENTRY-GATE.md`](docs/ENTRY-GATE.md) — entry-gate practice: how to tell who refused after being blocked
- [`docs/INSTALL.md`](docs/INSTALL.md) (humans) / [`docs/INSTALL.agent.md`](docs/INSTALL.agent.md) (an agent installing it for you)
- [`docs/NETWORK.md`](docs/NETWORK.md) — network behavior inventory

## 9. Release gates

```bash
node scripts/attest.mjs --check # signature placement (intro surfaces carry none; metadata and source headers do)
node scripts/scrub.mjs          # privacy scan (no hardcoded usernames; local identity is derived at runtime)
node scripts/selfcheck.mjs      # install → verify → uninstall in a fake environment, full chain
node scripts/pack.mjs           # build dist/*.zip
node scripts/pack-vsix.mjs      # build the TRAE-importable .vsix
```

## 10. Disclaimer & license

- **AS-IS, no warranty of any kind.** This kit supplies mechanisms (rule injection, profiles, assertions, an optional relay) and documented layer analysis — never an outcome guarantee. To the maximum extent permitted by law, the authors are not liable for any loss arising from its use.
- **What is verifiable is "the rule file is present and unmodified"** — not "the model will comply", and certainly not "the cloud will allow it".
- **No authorization is granted here.** It does not modify the TRAE client binary, does not alter any third-party service's security policy, and does not authorize access to any third-party service, software or system. You are responsible for applicable law, the terms of the services you connect to, and whether the model entry point you chose permits the content in question.
- **Switching entry points has a price**: custom models and local weights mean you carry the keys, billing, data egress and availability yourself — this kit never fills in credentials, pays, or holds them.
- **Install only on machines you own or may modify.** TRAE and its marks belong to their owner; this project is unaffiliated, unauthorized and unendorsed, and reads/writes only that application's own user-directory files. Sample content in the pack and docs exists to locate *which layer* rejected something — it is fictional or placeholder.
- **License.** Code and docs MIT (see `LICENSE`); `words/core.md` is self-authored under the same license; see `NOTICE` for the per-layer terms. When sharing, share `docs/CAPABILITY.md` with it.
