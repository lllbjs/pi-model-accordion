# Model Catalog (`local.pi-model-accordion`)

A PI-Desktop plugin that puts every model this machine can reach in one place:

- the **host catalog** — `pi.models.list()`, which returns only enabled and
  authenticated provider rows and never a secret; and
- **local OpenAI-compatible gateways** — the loopback endpoints tools such as
  WorkBuddy, Trae and Qoder expose. Their `/v1/models` is read with
  `pi.net.fetch`, confined to the manifest's `net.domains` allowlist
  (`127.0.0.1` / `localhost`), so the plugin needs no credential of its own.

Both lists are kept fresh by a resident timer and rendered in a docked
work-panel view, grouped and collapsible.

## What it contributes

| Contribution | Detail |
|---|---|
| Work-panel view | `models` — host catalog grouped by provider plus one group per local gateway, each collapsible, searchable |
| Composer control | A button in the composer toolbar that opens the view (the closest surface to the host's model picker a plugin can reach) |
| Commands | `modelCatalog.open` (reveal the view), `modelCatalog.refresh` (pull now, then toast the counts) |
| Providers | Pinned rows for the loopback gateways verified on this machine, so their models can reach the host picker (see below) |
| Settings | `refreshOnStartup`, `autoRefreshMinutes` (default 10, `0` disables), `groupByProvider`, `gatewayEndpoints`, `gatewayPorts`, `probeTimeoutMs` |
| Service | `autoRefresh` — resident timer that re-pulls both sources on the interval |
| Bus | publishes `local.pi-model-accordion.updated` after every pull (`locked` counts gateways that need a key) |

## Permissions

`ui.view`, `models.list`, `net.fetch`, `clipboard.write`, `background.service`,
`bus.publish`, `renderer.extension`, `provider.register`. No filesystem access
and no credential handling — a gateway that wants a key gets one from the user
in Settings, never from this plugin.

## Local gateway discovery

Every pull probes each candidate endpoint for an OpenAI `/v1/models` response:

| Answer | Result |
|---|---|
| 200 with a model list | listed with its models |
| 401 / 403 | listed as **needs key** — the gateway is running and will not talk without a bearer token |
| other status, or no answer | listed with the error if the endpoint was configured, dropped if it was only scanned |

Candidates come from two places:

- **Configured endpoints** — `gatewayEndpoints`, one per line as
  `Label=http://127.0.0.1:PORT/v1` (a bare URL works too). The label you write
  is kept as-is.
- **Scanned ports** — `gatewayPorts` (default
  `1234,3000,5000,7864,8000,8080,8081,8787,8790,9000,11434,57891,57898`; the
  last three are the gateways verified on this machine, so they are found with
  no configuration at all; `8787-8799` ranges are accepted, up to 64 endpoints). An endpoint with no label gets one from its own
  `/healthz` `service` field when it reports one, so a scanned port can show up
  as `trae-gateway` instead of `127.0.0.1:7864`.

`probeTimeoutMs` (default 400) bounds each probe. A gateway that requires a key
cannot show its models in the view — the view has no credential — which is what
the provider rows below are for.

## Getting gateway models into the host picker

No plugin API registers chooser entries at runtime or changes the session's
active model, so the plugin cannot add models to the host's own picker by
itself. What works is a **plugin-declared provider row**: an API-key provider
with a `baseUrl` and an empty `models` list is discovered by the host as soon as
the user stores a key for it.

This manifest pins the gateways verified on this machine:

| Row | Endpoint | How it was identified |
|---|---|---|
| `workbuddy` | `http://127.0.0.1:57891/v1` | Confirmed by the machine's owner; its `/healthz` reports the same cn+global region pair as the WorkBuddy connector |
| `trae-gateway` | `http://127.0.0.1:7864/v1` | `/healthz` reports `service: "trae-gateway"` |
| `raccoon-gateway` | `http://127.0.0.1:57898/v1` | `/healthz` reports `service: "raccoon-gateway"` |

A pinned row is a static endpoint: if a gateway moves to another port, update
`baseUrl` here (or delete the row and copy a fresh entry from the view).

The view's **copy provider entry** button produces the same shape for any other
gateway it finds:

```json
{
  "id": "workbuddy",
  "name": "WorkBuddy",
  "baseUrl": "http://127.0.0.1:57707/v1",
  "apiStyle": "chat_completions",
  "authKind": "api_key",
  "models": []
}
```

Paste it into `contributes.providers` in this manifest, reload the plugin, then
add the provider in **Settings → Models → Add Service** and save the gateway's
key once. The host requests that endpoint's model list, caches it, and those
models become selectable in the composer picker. Every gateway found on this
machine requires such a key — that one-time paste is the price of admission, not
a plugin limitation.

## Behaviour worth knowing

- **One snapshot, one path.** The view reads `modelCatalog.state` /
  `modelCatalog.refresh` / `modelCatalog.copyProviderEntry`, plugin-owned panel
  channels, rather than calling a source itself, so the timestamp the view shows
  always matches the data it shows.
- **A failed source keeps its previous answer.** Host catalog errors and gateway
  errors are shown separately above the list; a stale list beats an empty one.
- **Search expands every group.** Typing a query ignores the collapsed state so
  matches are never hidden; clearing it restores the collapse you set.
- **Auto refresh is lazy.** The timer ticks once a minute and only pulls when the
  configured interval has actually elapsed, so changing the setting takes effect
  without a reload.
- **The identity probe is one extra request.** `/healthz` is only read for an
  endpoint that has no user-supplied label and did not answer with a model list.

## Localization

The view, the toasts and the composer control ship in English, Simplified
Chinese and Traditional Chinese, chosen from `pi.app.getLocale()` (entry) and
the `appearance:changed` payload (view). The `views[].title` uses the manifest's
localized object.


### Verified local sources

These answered on this machine and need no key, but nothing is filled in for you —
`accountEndpoints` starts empty and every line is entered by hand: (they are the connector daemons
DaddySuite already runs; the last one is the Trae gateway's own pool):

| Source | Endpoint | What it answers |
| --- | --- | --- |
| Qoder 国内 | `http://127.0.0.1:47900/api/accounts` | `data.realm` = `qoder-cn`, per-profile `credit`, `usage.remaining` / `total` / `expiresAt`, `active`, `tokenExpired` |
| Qoder 国际 | `http://127.0.0.1:47901/api/accounts` | same, `data.realm` = `qoder-global` |
| 库库 (kukuDaddy) | `http://127.0.0.1:47862/api/accounts` | `accounts[].nickname` / `id` / `phone`, `snapshot.tokenRemain`, `expiresAt` |
| Trae 账号池 | `http://127.0.0.1:7864/healthz` | `pool.available` / `total` / `total_credits` |

Both wrappers are understood: a bare `{accounts: [...]}` and a `{ok, data: {…}}`
envelope. `realm` is rendered as the region chip, which is what separates the
国内 and 国际 editions.

## Picker folding

The host's own model picker folds by provider. No renderer slot reaches inside
that picker, so the plugin decorates its DOM — the same approach the DSH plugin
this was ported from uses. See `renderer/picker-fold.mjs`.

- Provider groups start folded; the provider holding the current model opens
  with the menu.
- Clicking a provider's heading opens it and closes the others (an accordion);
  `Ctrl`/`Cmd`-click toggles one and leaves the others alone.
- Typing in the search box unfolds everything; clearing it folds back to the
  current model's provider.
- The host's "recently used" section is never folded.

Two settings gate it: `foldPickerProviders` (on by default) and
`pickerFoldCollapsedByDefault`.

**This is out of contract, deliberately.** The selectors it uses
(`.composer-model-list`, `.composer-model-group`, `.composer-model-group-label`,
`.composer-model-option`) are the host's own, and the host's arrow-key
navigation walks every model it knows about regardless of what is folded — so
the rows inside a folded group stay reachable with `\u2191`/`\u2193` and
`Enter` from the search box. If the host renames those classes the decoration
stops finding anything; switch the setting off rather than uninstalling.

What is not ported, and why: [PORTING-ASSESSMENT.md](PORTING-ASSESSMENT.md).

## Account sources (DaddySuite side)

The plugin reads accounts, credits, sign-in and IP-pool status from whatever
endpoints you list in the `accountEndpoints` setting — one per line, the same
`Label=url` shape as `gatewayEndpoints`. It is a plain `GET` from the plugin's
own `net.fetch`, so the endpoint only has to be reachable on loopback:

```
DaddySuite=http://127.0.0.1:57895/__accounts
```

Expected response (200, JSON). Every field is optional and matched through
aliases, so extra fields are ignored and a missing one renders as blank:

```json
{
  "ok": true,
  "accounts": [
    {
      "id": "acct-1",
      "name": "xinna",
      "plan": "Pro",
      "credits": 128.5,
      "expiresAt": "2026-12-01T00:00:00Z",
      "region": "cn",
      "status": "active"
    }
  ],
  "totals": { "credits": 456.78, "accounts": 3 },
  "signIn": { "done": true, "at": "2026-11-06T00:00:00Z", "streak": 5 },
  "ipPool": { "available": 12, "total": 20 }
}
```

Aliases the plugin accepts:

| Rendered as | Accepted keys |
| --- | --- |
| account id | `id`, `accountId`, `userId`, `uid` |
| account name | `name`, `account`, `username`, `accountName`, `email` |
| plan | `plan`, `package`, `planName`, `packageName` |
| credits | `credits`, `points`, `integral`, `balance`, `credit` |
| credential expiry | `expiresAt`, `credentialExpiresAt`, `expireAt`, `expiredAt` |
| region | `region`, `area`, `zone` |
| status | `status`, `state` |
| totals | `totals`, `total`, or omitted (the top level is read); credits `credits`/`points`/`integral`/`balance`/`totalCredits`; count `accounts`/`count`/`accountCount` |
| sign-in | `signIn`, `signin` or `checkIn`; `done`/`checked`/`signed`/`ok`, `at`/`time`/`date`/`checkedAt`, `streak`/`days`/`continuous` |
| IP pool | `ipPool`, `ip_pool` or `pool`; `available`/`free`/`idle`, `total`/`size`/`count` |

`accounts` may also be the whole array (`[{...}]` at the top level).

A source that answers `401`/`403` is shown as "wants a key"; any other status, a
timeout, or a body that is not JSON is shown as "Unknown" with the reason — a
source that is down never fails the whole view.
