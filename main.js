/**
 * Model Catalog plugin entry.
 *
 * Two sources, one snapshot:
 *
 * 1. the host catalog — `pi.models.list()`, enabled and authenticated provider
 *    rows, never a secret; and
 * 2. local OpenAI-compatible gateways — the loopback endpoints tools such as
 *    WorkBuddy, Trae and Qoder expose. Their `/v1/models` is read with
 *    `pi.net.fetch`, confined to the manifest's `net.domains` allowlist
 *    (`127.0.0.1` / `localhost`), so no credential ever passes through here.
 *
 * A resident timer keeps both fresh, and the docked view reads the snapshot
 * through plugin-owned panel channels rather than calling either source itself.
 *
 * Host injects global `pi`.
 */

const UPDATED_TOPIC = "local.pi-model-accordion.updated";
const STATE_CHANNEL = "modelCatalog.state";
const REFRESH_CHANNEL = "modelCatalog.refresh";
const COPY_CHANNEL = "modelCatalog.copyProviderEntry";
const OPEN_VIEW_METHOD = "modelCatalog.openView";
const REFRESH_METHOD = "modelCatalog.refresh";
const PICKER_FOLD_METHOD = "modelCatalog.pickerFold";
const CREATE_KEY_CHANNEL = "modelCatalog.createKey";
const COPY_KEY_CHANNEL = "modelCatalog.copyKey";
const REFRESH_GATEWAY_CHANNEL = "modelCatalog.refreshGateway";
const REFRESH_HOST_CHANNEL = "modelCatalog.refreshHost";
const REFRESH_TARGET_CHANNEL = "modelCatalog.refreshTarget";
const REFRESH_TARGETS_CHANNEL = "modelCatalog.refreshTargets";
const DEFAULT_KEY_API_BASE = "http://127.0.0.1:9822";
const TICK_MS = 60_000;
const DEFAULT_AUTO_REFRESH_MINUTES = 10;
const DEFAULT_PORTS = [1234, 3000, 5000, 8000, 8080, 8081, 8787, 8790, 9000, 11434];
const DEFAULT_PROBE_TIMEOUT_MS = 400;
const MAX_PROBE = 64;

const COPY = {
  en: {
    openFailed: "Model Catalog: open a session to show the model list",
    refreshFailed: (message) => `Model Catalog: refresh failed — ${message}`,
    refreshed: (host, gateways) =>
      `Model Catalog: ${host} host model(s), ${gateways} local gateway(s)`,
    hostRefreshed: (models) => `Model Catalog: host catalog re-read — ${models} model(s)`,
    targetsRefreshed: (ready, total, models) =>
      `Model Catalog: ${ready}/${total} provider(s) answered, ${models} model(s)`,
  },
  "zh-CN": {
    openFailed: "模型列表：请先打开一个会话，再显示模型列表",
    refreshFailed: (message) => `模型列表：刷新失败 — ${message}`,
    refreshed: (host, gateways) => `模型列表：宿主 ${host} 个模型，本机网关 ${gateways} 个`,
    hostRefreshed: (models) => `模型列表：已重读宿主目录 — ${models} 个模型`,
    targetsRefreshed: (ready, total, models) =>
      `模型列表：${ready}/${total} 项配置已应答，共 ${models} 个模型`,
  },
  "zh-TW": {
    openFailed: "模型列表：請先開啟一個工作階段，再顯示模型清單",
    refreshFailed: (message) => `模型列表：重新整理失敗 — ${message}`,
    refreshed: (host, gateways) => `模型列表：宿主 ${host} 個模型，本機閘道 ${gateways} 個`,
    hostRefreshed: (models) => `模型列表：已重讀宿主目錄 — ${models} 個模型`,
    targetsRefreshed: (ready, total, models) =>
      `模型列表：${ready}/${total} 項設定已回應，共 ${models} 個模型`,
  },
};

function copyFor(locale) {
  const tag = String(locale ?? "").toLowerCase();
  if (tag.startsWith("zh-tw") || tag.startsWith("zh-hk") || tag.startsWith("zh-hant")) {
    return COPY["zh-TW"];
  }
  if (tag.startsWith("zh")) return COPY["zh-CN"];
  return COPY.en;
}

async function copy() {
  try {
    return copyFor(await pi.app.getLocale());
  } catch {
    return COPY.en;
  }
}

/** Last successful answer plus the last failure; the view renders both. */
const snapshot = {
  models: [],
  hostError: null,
  gateways: [],
  gatewayError: null,
  accounts: [],
  accountError: null,
  probed: 0,
  updatedAt: null,
};
/** In-flight pull, shared so a timer tick and a button press never double-fetch. */
let inFlight = null;
let ticker;

function normalizeBase(value) {
  const text = String(value ?? "")
    .trim()
    .replace(/\/+$/, "");
  return /^https?:\/\/[^\s]+$/i.test(text) ? text : "";
}

/** `Label=http://127.0.0.1:8787/v1` per line; a bare URL is its own label. */
function parseEndpoints(raw) {
  if (typeof raw !== "string") return [];
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf("=");
      const label = at > 0 ? line.slice(0, at).trim() : "";
      const baseUrl = normalizeBase(at > 0 ? line.slice(at + 1) : line);
      return { label, baseUrl };
    })
    .filter((entry) => entry.baseUrl);
}

/** `8787,8790` and `8787-8799` both work; the list is bounded by MAX_PROBE. */
function parsePorts(raw) {
  if (typeof raw !== "string" || !raw.trim()) return [...DEFAULT_PORTS];
  const ports = [];
  for (const token of raw.split(/[\s,;]+/).filter(Boolean)) {
    const range = token.match(/^(\d{2,5})-(\d{2,5})$/);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from > to) continue;
      for (let port = from; port <= to && ports.length < MAX_PROBE; port += 1) ports.push(port);
      continue;
    }
    const port = Number(token);
    if (Number.isInteger(port) && port > 0 && port < 65_536) ports.push(port);
  }
  return ports.slice(0, MAX_PROBE);
}

function clampTimeout(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_PROBE_TIMEOUT_MS;
  return Math.min(3_000, Math.max(100, Math.round(value)));
}

async function readSettings() {
  let raw = {};
  try {
    raw = (await pi.plugin.getSettings()) ?? {};
  } catch {
    raw = {};
  }
  const minutes = Number(raw.autoRefreshMinutes);
  return {
    refreshOnStartup: raw.refreshOnStartup !== false,
    autoRefreshMinutes:
      Number.isFinite(minutes) && minutes >= 0 ? minutes : DEFAULT_AUTO_REFRESH_MINUTES,
    groupByProvider: raw.groupByProvider !== false,
    gatewayEndpoints: parseEndpoints(raw.gatewayEndpoints),
    accountEndpoints: parseEndpoints(raw.accountEndpoints),
    gatewayPorts: parsePorts(raw.gatewayPorts),
    probeTimeoutMs: clampTimeout(raw.probeTimeoutMs),
    foldPickerProviders: raw.foldPickerProviders !== false,
    pickerFoldCollapsedByDefault: raw.pickerFoldCollapsedByDefault !== false,
    keyApiBase: normalizeBase(raw.keyApiBase || DEFAULT_KEY_API_BASE) || DEFAULT_KEY_API_BASE,
  };
}

/** Provider name first, then the model label, so the view groups in order. */
function byProviderThenLabel(left, right) {
  const provider = String(left?.providerName ?? "").localeCompare(String(right?.providerName ?? ""));
  if (provider !== 0) return provider;
  return String(left?.label ?? "").localeCompare(String(right?.label ?? ""));
}

async function readHostModels() {
  try {
    const models = await pi.models.list();
    return { models: [...(models ?? [])].sort(byProviderThenLabel), error: null };
  } catch (error) {
    return { models: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * One candidate per configured endpoint plus one per scanned port. A scanned
 * port that answers nothing is dropped; a configured endpoint is always kept so
 * its failure stays visible.
 */
function gatewayCandidates(settings) {
  const candidates = [];
  const seen = new Set();
  // `named` means the label came from the user, so it is never overwritten by
  // the gateway's own /healthz identity.
  const push = (label, baseUrl, explicit, named) => {
    if (!baseUrl || seen.has(baseUrl)) return;
    seen.add(baseUrl);
    candidates.push({ label: label || baseUrl, named, baseUrl, explicit });
  };

  for (const entry of settings.gatewayEndpoints) {
    push(entry.label, entry.baseUrl, true, Boolean(entry.label));
  }
  for (const port of settings.gatewayPorts) {
    push(`127.0.0.1:${port}`, `http://127.0.0.1:${port}/v1`, false, false);
  }
  return candidates.slice(0, MAX_PROBE);
}

/** OpenAI `/v1/models` shape; `id` is the only field this plugin relies on. */
function parseModelList(bodyText) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  const rows = Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed) ? parsed : null;
  if (!rows) return null;
  return rows
    .map((row) => ({
      id: String(row?.id ?? ""),
      owner: typeof row?.owned_by === "string" ? row.owned_by : null,
    }))
    .filter((model) => model.id);
}

/**
 * Best-effort identity for a gateway that answered without a model list. The
 * local gateways this plugin targets report a `service` name on `/healthz`;
 * anything else (a 404, a non-JSON body) just means no name is known.
 */
async function readGatewayName(candidate, timeoutMs) {
  try {
    const origin = candidate.baseUrl.replace(/\/v1\/?$/, "");
    const response = await pi.net.fetch({ url: `${origin}/healthz`, method: "GET", timeoutMs });
    if (response.status !== 200) return null;
    const parsed = JSON.parse(response.bodyText);
    const service = typeof parsed?.service === "string" ? parsed.service.trim() : "";
    return service || null;
  } catch {
    return null;
  }
}

async function probeGateway(candidate, timeoutMs) {
  let result;
  try {
    const response = await pi.net.fetch({
      url: `${candidate.baseUrl}/models`,
      method: "GET",
      timeoutMs,
    });
    if (response.status === 401 || response.status === 403) {
      // A gateway that demands a key is a discovery result, not a dead port —
      // unless the view already minted a key for it: then ask again with it.
      const minted = keyForBaseUrl(candidate.baseUrl);
      let answered = null;
      if (minted) {
        const authorized = await pi.net.fetch({
          url: `${candidate.baseUrl}/models`,
          method: "GET",
          timeoutMs,
          headers: { authorization: `Bearer ${minted}` },
        });
        if (authorized.status === 200) answered = parseModelList(authorized.bodyText);
      }
      result = answered
        ? { ...candidate, ok: true, needsKey: false, error: null, models: answered }
        : { ...candidate, ok: false, needsKey: true, error: null, models: [] };
    } else if (response.status !== 200) {
      result = {
        ...candidate,
        ok: false,
        needsKey: false,
        error: `HTTP ${response.status}`,
        models: [],
      };
    } else {
      const models = parseModelList(response.bodyText);
      result = models
        ? { ...candidate, ok: true, needsKey: false, error: null, models }
        : { ...candidate, ok: false, needsKey: false, error: "not an OpenAI model list", models: [] };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result = { ...candidate, ok: false, needsKey: false, error: message, models: [] };
  }
  if (!result.ok && !candidate.named) {
    const name = await readGatewayName(candidate, timeoutMs);
    if (name) result.label = name;
  }
  return result;
}

/**
 * Account sources (DaddySuite side): accounts, credits, sign-in and IP pool.
 *
 * One JSON object per source, read from the endpoints in the `accountEndpoints`
 * setting. Field names are matched through aliases, because the connector hosts
 * spell them differently. Anything else — 401/403, 404/405, a timeout, a body
 * that is not JSON — is reported as unknown rather than as a failure, the way
 * the settings card this was ported from does. The shape is documented in
 * README.md.
 */
function pick(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

/** Epoch milliseconds (Qoder, kukuDaddy) become ISO; anything else stays text. */
function isoOrText(value) {
  if (value === undefined || value === null || value === "") return "";
  const number = Number(value);
  if (Number.isFinite(number) && number > 1e11) return new Date(number).toISOString();
  return String(value);
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeAccounts(body) {
  // The connector daemons wrap their payload in `data`; the gateway contract
  // documented in README.md does not.
  const root = body?.data ?? body;
  const raw = Array.isArray(root) ? root : (root?.accounts ?? root?.items ?? []);
  const accounts = (Array.isArray(raw) ? raw : []).map((entry) => ({
    id: String(pick(entry, ["id", "accountId", "userId", "uid", "profile", "uk"]) ?? ""),
    name: String(
      pick(entry, ["name", "account", "username", "accountName", "email", "nickname", "userName"]) ?? "",
    ),
    plan: String(
      pick(entry, ["plan", "package", "planName", "packageName", "accountType"]) ??
        pick(entry?.usage, ["userType"]) ??
        "",
    ),
    credits: numberOrNull(
      pick(entry, ["credits", "points", "integral", "balance", "credit", "tokenRemain"]) ??
        entry?.snapshot?.tokenRemain ??
        entry?.usage?.remaining,
    ),
    expiresAt: isoOrText(
      pick(entry, ["expiresAt", "credentialExpiresAt", "expireAt", "expiredAt"]) ??
        entry?.usage?.expiresAt,
    ),
    // Qoder's realm is the edition: `qoder-cn` / `qoder-global`.
    // The edition lives on the wrapper (`data.realm`), not on each profile.
    region: String(pick(entry, ["region", "area", "zone", "realm"]) ?? root?.realm ?? ""),
    status: String(
      pick(entry, ["status", "state"]) ??
        (entry?.tokenExpired || entry?.expired || entry?.broken
          ? "expired"
          : entry?.active === false
            ? "inactive"
            : ""),
    ),
  }));
  // `totals` may be omitted; then the top level itself carries the totals.
  const totalsSource = root?.totals ?? root?.total ?? root ?? {};
  const totals = {
    credits: numberOrNull(
      typeof totalsSource === "number"
        ? totalsSource
        : pick(totalsSource, [
            "credits",
            "points",
            "integral",
            "balance",
            "totalCredits",
            "total_credits",
          ]),
    ),
    accounts:
      numberOrNull(pick(totalsSource, ["accounts", "count", "accountCount"])) ?? accounts.length,
  };
  const signInSource = root?.signIn ?? root?.signin ?? root?.checkIn ?? root?.checkin ?? {};
  const signIn = {
    done:
      typeof signInSource === "boolean"
        ? signInSource
        : Boolean(pick(signInSource, ["done", "checked", "signed", "ok"])),
    at: String(pick(signInSource, ["at", "time", "date", "checkedAt"]) ?? ""),
    streak: numberOrNull(pick(signInSource, ["streak", "days", "continuous"])),
  };
  const poolSource = root?.ipPool ?? root?.ip_pool ?? root?.pool ?? {};
  const ipPool = {
    available: numberOrNull(pick(poolSource, ["available", "free", "idle"])),
    total: numberOrNull(pick(poolSource, ["total", "size", "count"])),
  };
  return { accounts, totals, signIn, ipPool };
}

/** A source that cannot answer is `ok: false` with a reason, never a throw. */
async function readAccounts(source, timeoutMs) {
  const base = {
    label: source.label || source.baseUrl,
    url: source.baseUrl,
    accounts: [],
    totals: null,
    signIn: null,
    ipPool: null,
  };
  try {
    const response = await pi.net.fetch({ url: source.baseUrl, method: "GET", timeoutMs });
    if (response.status === 401 || response.status === 403) {
      return { ...base, ok: false, needsKey: true, error: null };
    }
    if (response.status !== 200) {
      return { ...base, ok: false, needsKey: false, error: `HTTP ${response.status}` };
    }
    let body;
    try {
      body = JSON.parse(response.bodyText);
    } catch {
      return { ...base, ok: false, needsKey: false, error: "not a JSON account payload" };
    }
    // The Trae / WorkBuddy daemons answer 200 with a gated body.
    if (body?.ok === false) {
      return {
        ...base,
        ok: false,
        needsKey: false,
        error: String(body.error ?? body.message ?? "not authorized"),
      };
    }
    return { ...base, ok: true, needsKey: false, error: null, ...normalizeAccounts(body) };
  } catch (error) {
    return {
      ...base,
      ok: false,
      needsKey: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function scanAccounts(settings) {
  if (settings.accountEndpoints.length === 0) return { sources: [], error: null };
  const sources = await Promise.all(
    settings.accountEndpoints.map((source) => readAccounts(source, settings.probeTimeoutMs)),
  );
  return { sources, error: null };
}

async function scanGateways(settings) {
  const candidates = gatewayCandidates(settings);
  const results = await Promise.all(
    candidates.map((candidate) => probeGateway(candidate, settings.probeTimeoutMs)),
  );
  return {
    probed: candidates.length,
    gateways: results.filter((gateway) => gateway.ok || gateway.needsKey || gateway.explicit),
  };
}

/** Publish after a targeted refresh, so a view open elsewhere still lands. */
async function announce(reason) {
  snapshot.updatedAt = new Date().toISOString();
  await pi.bus.publish(UPDATED_TOPIC, {
    reason,
    count: snapshot.models.length,
    gateways: snapshot.gateways.length,
    locked: snapshot.gateways.filter((gateway) => gateway.needsKey).length,
    gatewayModels: snapshot.gateways.reduce((total, item) => total + item.models.length, 0),
    updatedAt: snapshot.updatedAt,
  });
}

/**
 * Re-probe one endpoint and leave every other one alone. This is the refresh a
 * user asks for when one gateway came up late, went away, or a minted key just
 * landed: no port scan, no host call, one request.
 *
 * The endpoint may be one the snapshot already lists or one the settings
 * configure — a configured endpoint that was down at the last full scan is not
 * in the snapshot at all, and that is exactly the case worth refreshing.
 */
async function refreshGateway(baseUrl, reason) {
  const wanted = normalizeBase(baseUrl);
  if (!wanted) throw new Error("Model Catalog: a gateway baseUrl is required");
  const settings = await readSettings();
  const index = snapshot.gateways.findIndex((gateway) => normalizeBase(gateway.baseUrl) === wanted);
  const known = index >= 0 ? snapshot.gateways[index] : null;
  const configured = settings.gatewayEndpoints.find((entry) => entry.baseUrl === wanted) ?? null;
  if (!known && !configured) {
    throw new Error(`Model Catalog: not a known gateway: ${wanted}`);
  }
  const candidate = {
    label: known?.label ?? configured?.label ?? "",
    named: Boolean(known?.named ?? known?.explicit ?? configured?.label),
    baseUrl: wanted,
    explicit: Boolean(known?.explicit ?? configured),
  };
  const refreshed = await probeGateway(candidate, settings.probeTimeoutMs);
  // The same filter the full scan applies: a scanned port that answers nothing
  // drops out, a configured one stays with its error.
  const keep = refreshed.ok || refreshed.needsKey || refreshed.explicit;
  if (index >= 0) {
    if (keep) snapshot.gateways[index] = refreshed;
    else snapshot.gateways.splice(index, 1);
  } else if (keep) {
    snapshot.gateways.push(refreshed);
  }
  await announce(reason);
  return refreshed;
}

/**
 * Re-read the host catalog only, and say nothing.
 *
 * Used right after a rediscovery: the host has just changed what it publishes,
 * so the snapshot has to catch up before anything renders it. Publishing is the
 * caller's job, so one refresh produces one event.
 */
async function refreshHostQuietly() {
  const host = await readHostModels();
  if (host.models) snapshot.models = host.models;
  snapshot.hostError = host.error;
  return snapshot.models.length;
}

/** Re-read the host catalog and publish, for the explicit re-read command. */
async function refreshHost(reason) {
  const models = await refreshHostQuietly();
  await announce(reason);
  return {
    models,
    hostError: snapshot.hostError,
    rediscovery: "host-owned",
  };
}

/**
 * One configured provider row, refreshed on its own.
 *
 * The pinned rows are not 1:1 with endpoints: `qoder-cn` and `qoder-intl` share
 * port 57895 and are told apart by their key's region, so refreshing "by
 * endpoint" would merge rows a user needs kept apart. This is
 * per configuration entry instead, each with the key minted for its own id.
 */
function targetById(providerId) {
  const wanted = String(providerId ?? "");
  return targetSnapshot().find((entry) => entry.providerId === wanted) ?? null;
}

/** The provider rows this plugin pins, in manifest order, never from settings. */
function targetDefinitions() {
  const rank = (providerId) => {
    const at = PROVIDER_ORDER.indexOf(providerId);
    return at < 0 ? PROVIDER_ORDER.length : at;
  };
  return [...KEY_TARGETS]
    .sort((left, right) => rank(left.providerId) - rank(right.providerId))
    .map((target) => ({
      providerId: target.providerId,
      name: target.name,
      baseUrl: normalizeBase(target.baseUrl),
      region: target.region,
      namespace: target.namespace,
    }));
}

/**
 * Probe one pinned row's endpoint. With a key minted for that row the request
 * carries it, so the region a key belongs to is what decides the answer; with
 * no key the row still reports whether it is reachable and locked.
 */
async function probeTarget(definition, timeoutMs) {
  const minted = createdKeys.get(definition.providerId) ?? null;
  const base = {
    ...definition,
    hasKey: Boolean(minted),
    ok: false,
    needsKey: false,
    error: null,
    models: [],
    checkedAt: new Date().toISOString(),
  };
  try {
    const response = await pi.net.fetch({
      url: `${definition.baseUrl}/models`,
      method: "GET",
      timeoutMs,
      ...(minted ? { headers: { authorization: `Bearer ${minted}` } } : {}),
    });
    if (response.status === 401 || response.status === 403) {
      // Locked: the row is reachable but this key (or no key) will not do.
      return { ...base, needsKey: true };
    }
    if (response.status !== 200) {
      return { ...base, error: `HTTP ${response.status}` };
    }
    const models = parseModelList(response.bodyText);
    if (!models) return { ...base, error: "not an OpenAI model list" };
    return { ...base, ok: true, models };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Last answer per pinned row; the view renders one list per entry from here. */
const targetState = new Map();

/** The manifest id, for matching the host's `plugin:<id>:<row>` provider ids. */
function pluginId() {
  // `getManifest` is the documented getter; `getId` is the older one, and the
  // manifest this module is loaded from is the last resort.
  const candidates = [
    () => pi.plugin.getManifest()?.id,
    () => pi.plugin.getId?.(),
    () => pi.plugin.getManifest?.()?.id,
  ];
  for (const read of candidates) {
    try {
      const id = read();
      if (typeof id === "string" && id) return id;
    } catch {
      // try the next source
    }
  }
  return "";
}

/**
 * The models the host already discovered, grouped by pinned row.
 *
 * The plugin's own probe carries no credential: the host owns the key slot, and
 * `createdKeys` only ever holds a key minted during this session — so a fresh
 * process can only report "reachable, wants a key". The host, though, has
 * already discovered and cached every row's models once the user saved a key.
 * Reading them back out of `pi.models.list()` is what turns this view from a
 * list of locked endpoints into an actual model list.
 */
function hostModelsByTarget() {
  const id = pluginId();
  const prefix = `plugin:${id}:`;
  const byTarget = new Map();
  if (!id) return byTarget;
  for (const model of snapshot.models) {
    const providerId = String(model?.providerId ?? "");
    if (!providerId.startsWith(prefix)) continue;
    const targetId = providerId.slice(prefix.length);
    if (!byTarget.has(targetId)) byTarget.set(targetId, []);
    byTarget.get(targetId).push({
      id: String(model.modelId ?? model.key ?? ""),
      owner: null,
    });
  }
  return byTarget;
}

function targetSnapshot() {
  const hostModels = hostModelsByTarget();
  return targetDefinitions().map((definition) => ({
    ...definition,
    hasKey: createdKeys.has(definition.providerId),
    ok: false,
    needsKey: false,
    error: null,
    models: [],
    checkedAt: null,
    ...(targetState.get(definition.providerId) ?? {}),
    // The host's own discovery for this row, used when this process holds no
    // key of its own to list them with.
    hostModels: hostModels.get(definition.providerId) ?? [],
  }));
}

/**
 * Ask the host to rediscover one provider row's models.
 *
 * This is the only call that actually refreshes a row: `providers/listModels`
 * runs the provider's own `/v1/models` request with the credential the host
 * holds, then writes the result back through `providers.cacheModels`. The
 * plugin's own `probeTarget` cannot do that — it has no credential, so it can
 * only ever report "reachable, wants a key".
 *
 * `read` risk, so no confirmation prompt. The host addresses a plugin-declared
 * row as `plugin:<pluginId>:<rowId>`, which is what `providerRef` builds.
 */
async function rediscoverTarget(providerId) {
  if (typeof pi.desktop?.invoke !== "function") {
    throw Object.assign(new Error("Model Catalog: this host exposes no desktop.control API"), {
      code: "MODEL_CATALOG_NO_CONTROL_API",
    });
  }
  const providerRef = `plugin:${pluginId()}:${providerId}`;
  const answer = await pi.desktop.invoke({
    operation: "providers/listModels",
    args: [{ providerId: providerRef }],
  });
  const models = Array.isArray(answer?.models) ? answer.models : [];
  return models
    .map((model) => ({
      id: String(model?.modelId ?? model?.id ?? ""),
      owner: null,
    }))
    .filter((model) => model.id);
}

/**
 * Refresh one pinned row and return just that row. A row that answers keeps its
 * models; a row that fails keeps its previous models and reports the error, so a
 * momentary 502 does not blank a list the user was reading.
 *
 * The host rediscovery runs first: it is the only path that can change what the
 * host itself knows, so the row's list and the host picker move together.
 */
async function refreshTarget(providerId, reason) {
  const definition = targetDefinitions().find((entry) => entry.providerId === String(providerId ?? ""));
  if (!definition) {
    throw Object.assign(new Error(`Model Catalog: unknown provider configuration: ${String(providerId)}`), {
      code: "MODEL_CATALOG_UNKNOWN_TARGET",
    });
  }
  const settings = await readSettings();
  const previous = targetState.get(definition.providerId);

  // Ask the host to rediscover; a host that cannot answer still leaves the
  // plugin's own probe to report reachability.
  let rediscovered = null;
  let rediscoverError = null;
  try {
    rediscovered = await rediscoverTarget(definition.providerId);
  } catch (error) {
    rediscoverError = error instanceof Error ? error.message : String(error);
  }

  const fresh = await probeTarget(definition, settings.probeTimeoutMs);
  const hostList = rediscovered && rediscovered.length > 0 ? rediscovered : null;
  const kept =
    hostList !== null
      ? { ...fresh, ok: true, needsKey: false, models: hostList, rediscoverError }
      : fresh.ok || !previous
        ? { ...fresh, rediscoverError }
        : { ...fresh, models: previous.models, rediscoverError };
  targetState.set(definition.providerId, kept);
  // Re-read the host catalog so `hostModels` reflects the new list immediately.
  await refreshHostQuietly();
  await announce(reason);
  return kept;
}

/**
 * Refresh every pinned row. `announceNow` is false when the caller is already
 * publishing (startup, the timer, a full pull), so one refresh produces one
 * event instead of two racing ones.
 */
async function refreshAllTargets(reason, announceNow = true) {
  const settings = await readSettings();
  const definitions = targetDefinitions();
  const results = await Promise.all(
    definitions.map(async (definition) => {
      const previous = targetState.get(definition.providerId);
      // Same order as the single-row refresh: host rediscovery first, then this
      // process's own reachability probe.
      let rediscovered = null;
      let rediscoverError = null;
      try {
        rediscovered = await rediscoverTarget(definition.providerId);
      } catch (error) {
        rediscoverError = error instanceof Error ? error.message : String(error);
      }
      const fresh = await probeTarget(definition, settings.probeTimeoutMs);
      const hostList = rediscovered && rediscovered.length > 0 ? rediscovered : null;
      const kept =
        hostList !== null
          ? { ...fresh, ok: true, needsKey: false, models: hostList, rediscoverError }
          : fresh.ok || !previous
            ? { ...fresh, rediscoverError }
            : { ...fresh, models: previous.models, rediscoverError };
      targetState.set(definition.providerId, kept);
      return kept;
    }),
  );
  await refreshHostQuietly();
  if (announceNow) await announce(reason);
  return results;
}

function pull(reason) {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const settings = await readSettings();
      const [host, gateways, accounts] = await Promise.all([
        readHostModels(),
        scanGateways(settings).catch((error) => ({
          probed: 0,
          gateways: [],
          error: error instanceof Error ? error.message : String(error),
        })),
        scanAccounts(settings).catch((error) => ({
          sources: [],
          error: error instanceof Error ? error.message : String(error),
        })),
      ]);

      // A failed source keeps its previous answer: a stale list beats an empty one.
      if (host.models) snapshot.models = host.models;
      snapshot.hostError = host.error;
      snapshot.gateways = gateways.gateways;
      snapshot.gatewayError = gateways.error ?? null;
      snapshot.accounts = accounts.sources;
      snapshot.accountError = accounts.error ?? null;
      snapshot.probed = gateways.probed;
      await announce(reason);
    } finally {
      inFlight = null;
    }
    return snapshot;
  })();
  return inFlight;
}

/** The `contributes.providers` entry that would put a gateway in the host picker. */
function providerEntry(label, baseUrl) {
  const id = String(label || baseUrl || "gateway")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return JSON.stringify(
    {
      id: id || "gateway",
      name: label || baseUrl,
      baseUrl,
      apiStyle: "chat_completions",
      authKind: "api_key",
      models: [],
    },
    null,
    2,
  );
}

/**
 * Where each provider's key lives in the DaddySuite / buddy-switch ledger.
 * `POST <keyApiBase>/api/<namespace>/keys` with `{name, region}` returns the
 * plaintext key once; the ledger keeps only a hash afterwards.
 */
const KEY_TARGETS = [
  { providerId: "workbuddy-cn", namespace: "gateway", baseUrl: "http://127.0.0.1:57891/v1", region: "cn", name: "pi-workbuddy-\u56fd\u5185\u7248" },
  { providerId: "trae-cn", namespace: "trae/gateway", baseUrl: "http://127.0.0.1:7864/v1", region: "cn", name: "pi-trae-\u56fd\u5185\u7248" },
  { providerId: "qoder-cn", namespace: "qoder/gateway", baseUrl: "http://127.0.0.1:57895/v1", region: "cn", name: "pi-qoder-\u56fd\u5185\u7248" },
  { providerId: "qoder-intl", namespace: "qoder/gateway", baseUrl: "http://127.0.0.1:57895/v1", region: "global", name: "pi-qoder-\u56fd\u9645\u7248" },
];

/**
 * Manifest provider order, so the view lists the rows in the same order as
 * Settings → Models. `KEY_TARGETS` is a ledger mapping; its order is not the
 * presentation order, this is.
 */
const PROVIDER_ORDER = ["workbuddy-cn", "trae-cn", "qoder-cn", "qoder-intl"];

/** Plaintext keys minted in this session — memory only, never persisted. */
const createdKeys = new Map();

/** The key the view minted for a gateway address, if any (two providers can share one). */
function keyForBaseUrl(baseUrl) {
  const wanted = normalizeBase(baseUrl);
  for (const target of KEY_TARGETS) {
    if (wanted && normalizeBase(target.baseUrl) === wanted && createdKeys.has(target.providerId)) {
      return createdKeys.get(target.providerId);
    }
  }
  return null;
}

function keyTarget(providerId) {
  const wanted = String(providerId ?? "");
  return KEY_TARGETS.find((target) => target.providerId === wanted) ?? null;
}

/** Create one ledger key; the plaintext is returned to the caller once. */
async function createKey(settings, payload) {
  const target = keyTarget(payload?.providerId);
  if (!target) {
    throw Object.assign(new Error(`Model Catalog: unknown key target: ${String(payload?.providerId)}`), {
      code: "MODEL_CATALOG_UNKNOWN_KEY_TARGET",
    });
  }
  const name = String(payload?.name ?? "").trim() || target.name;
  const response = await pi.net.fetch({
    url: `${settings.keyApiBase}/api/${target.namespace}/keys`,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, region: target.region }),
    timeoutMs: settings.probeTimeoutMs,
  });
  let body;
  try {
    body = JSON.parse(response.bodyText);
  } catch {
    throw new Error(`HTTP ${response.status}: the ledger did not answer with JSON`);
  }
  if (body?.ok === false || typeof body?.key !== "string" || body.key === "") {
    throw new Error(String(body?.error ?? `HTTP ${response.status}: no key in the ledger reply`));
  }
  createdKeys.set(target.providerId, body.key);
  // DaddySuite hands the plaintext back exactly once — copy it right away.
  await pi.clipboard.writeText(body.key);
  return {
    ok: true,
    providerId: target.providerId,
    name,
    region: target.region,
    key: body.key,
    copied: true,
  };
}

async function report() {
  return {
    models: snapshot.models,
    hostError: snapshot.hostError,
    gateways: snapshot.gateways,
    gatewayError: snapshot.gatewayError,
    accounts: snapshot.accounts,
    accountError: snapshot.accountError,
    probed: snapshot.probed,
    updatedAt: snapshot.updatedAt,
    refreshing: inFlight !== null,
    settings: await readSettings(),
    // One entry per pinned provider row, each with its own key, status and list.
    targets: targetSnapshot(),
    keyTargets: KEY_TARGETS.map(({ providerId, region, name }) => ({ providerId, region, name })),
    created: [...createdKeys.keys()],
  };
}

/** Re-pull only once the configured interval has elapsed, so a settings edit lands. */
async function tick() {
  const { autoRefreshMinutes } = await readSettings();
  if (autoRefreshMinutes <= 0) return;
  const last = snapshot.updatedAt ? Date.parse(snapshot.updatedAt) : 0;
  if (Date.now() - last >= autoRefreshMinutes * 60_000) {
    await Promise.all([pull("auto"), refreshAllTargets("auto", false)]);
  }
}

async function onLoad() {
  await pi.commands.register({
    id: "modelCatalog.open",
    title: "Model Catalog: Open model list",
    keywords: ["model", "models", "catalog", "模型", "列表"],
    run: async () => {
      try {
        await pi.ui.revealView({ viewId: "models" });
      } catch {
        await pi.ui.showToast((await copy()).openFailed, "warn");
      }
    },
  });

  await pi.commands.register({
    id: "modelCatalog.refresh",
    title: "Model Catalog: Refresh models",
    keywords: ["model", "models", "refresh", "模型", "刷新"],
    run: async () => {
      const strings = await copy();
      const state = await pull("command");
      if (state.hostError && state.gateways.length === 0) {
        await pi.ui.showToast(strings.refreshFailed(state.hostError), "error");
        return;
      }
      await pi.ui.showToast(strings.refreshed(state.models.length, state.gateways.length), "info");
    },
  });

  // The host owns provider rediscovery, so this command is honest about what
  // it does: it re-reads the catalog the host already publishes.
  await pi.commands.register({
    id: "modelCatalog.refreshHost",
    title: "Model Catalog: Re-read the host catalog",
    keywords: ["model", "models", "host", "catalog", "模型", "宿主"],
    run: async () => {
      const strings = await copy();
      const answer = await refreshHost("command");
      if (answer.hostError) {
        await pi.ui.showToast(strings.refreshFailed(answer.hostError), "error");
        return;
      }
      await pi.ui.showToast(strings.hostRefreshed(answer.models), "info");
    },
  });

  // Every pinned row in one go. Still one request per row, each with its own
  // key, so "refresh all" never collapses the regional pairs into one answer.
  await pi.commands.register({
    id: "modelCatalog.refreshTargets",
    title: "Model Catalog: Refresh every configured provider",
    keywords: ["model", "models", "refresh", "provider", "配置", "刷新"],
    run: async () => {
      const strings = await copy();
      const results = await refreshAllTargets("command");
      const ready = results.filter((entry) => entry.ok);
      const models = ready.reduce((total, entry) => total + entry.models.length, 0);
      await pi.ui.showToast(strings.targetsRefreshed(ready.length, results.length, models), "info");
    },
  });

  const settings = await readSettings();
  if (settings.refreshOnStartup) {
    // The pinned rows are probed alongside the pull so the view's per-provider
    // lists are populated on the first render, not on the first click.
    await Promise.all([pull("startup"), refreshAllTargets("startup", false)]);
  }

  pi.services.register({
    id: "autoRefresh",
    start: ({ log }) => {
      log("model catalog auto refresh started");
      ticker = setInterval(() => {
        void tick();
      }, TICK_MS);
    },
    stop: () => {
      clearInterval(ticker);
      ticker = undefined;
    },
  });
}

async function onUnload() {
  clearInterval(ticker);
  ticker = undefined;
  await pi.commands.unregister("modelCatalog.open");
  await pi.commands.unregister("modelCatalog.refresh");
  await pi.commands.unregister("modelCatalog.refreshHost");
  await pi.commands.unregister("modelCatalog.refreshTargets");
}

module.exports = {
  onLoad,
  onUnload,
  /** The composer control's two calls (`manifest.rendererCallMethods`). */
  async onRendererCall(method) {
    if (method === PICKER_FOLD_METHOD) {
      const settings = await readSettings();
      return {
        enabled: settings.foldPickerProviders,
        collapsedByDefault: settings.pickerFoldCollapsedByDefault,
      };
    }
    if (method === OPEN_VIEW_METHOD) {
      await pi.ui.revealView({ viewId: "models" });
      return { opened: true };
    }
    if (method === REFRESH_METHOD) {
      const state = await pull("renderer");
      return {
        models: state.models.length,
        gateways: state.gateways.length,
        gatewayModels: state.gateways.reduce((total, item) => total + item.models.length, 0),
      };
    }
    throw Object.assign(new Error(`Unknown Model Catalog renderer method: ${String(method)}`), {
      code: "MODEL_CATALOG_UNKNOWN_METHOD",
    });
  },
  async onPanelInvoke(channel, payload) {
    if (channel === STATE_CHANNEL) return report();
    if (channel === REFRESH_CHANNEL) {
      // A full refresh covers the pinned rows too, with a single event.
      await Promise.all([pull("view"), refreshAllTargets("view", false)]);
      return report();
    }

    if (channel === REFRESH_GATEWAY_CHANNEL) {
      await refreshGateway(payload?.baseUrl, "gateway");
      return report();
    }

    // Per-configuration refresh and list read. `providerId` is the pinned row,
    // not an endpoint, so two rows sharing one port stay independent.
    if (channel === REFRESH_TARGET_CHANNEL) {
      const target = await refreshTarget(payload?.providerId, "target");
      return { target, state: await report() };
    }
    if (channel === REFRESH_TARGETS_CHANNEL) {
      await refreshAllTargets("targets");
      return report();
    }
    if (channel === REFRESH_HOST_CHANNEL) return refreshHost("host");
    if (channel === CREATE_KEY_CHANNEL) return createKey(await readSettings(), payload);
    if (channel === COPY_KEY_CHANNEL) {
      await pi.clipboard.writeText(String(payload?.key ?? ""));
      return { ok: true };
    }
    if (channel === COPY_CHANNEL) {
      const baseUrl = normalizeBase(payload?.baseUrl);
      if (!baseUrl) throw new Error("Model Catalog: a gateway baseUrl is required");
      await pi.clipboard.writeText(providerEntry(String(payload?.label ?? ""), baseUrl));
      return { ok: true };
    }
    throw new Error(`Unknown Model Catalog channel: ${String(channel)}`);
  },
};
