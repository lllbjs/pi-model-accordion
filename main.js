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
  },
  "zh-CN": {
    openFailed: "模型列表：请先打开一个会话，再显示模型列表",
    refreshFailed: (message) => `模型列表：刷新失败 — ${message}`,
    refreshed: (host, gateways) => `模型列表：宿主 ${host} 个模型，本机网关 ${gateways} 个`,
  },
  "zh-TW": {
    openFailed: "模型列表：請先開啟一個工作階段，再顯示模型清單",
    refreshFailed: (message) => `模型列表：重新整理失敗 — ${message}`,
    refreshed: (host, gateways) => `模型列表：宿主 ${host} 個模型，本機閘道 ${gateways} 個`,
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
      snapshot.updatedAt = new Date().toISOString();

      await pi.bus.publish(UPDATED_TOPIC, {
        reason,
        count: snapshot.models.length,
        gateways: snapshot.gateways.length,
        locked: snapshot.gateways.filter((gateway) => gateway.needsKey).length,
        gatewayModels: snapshot.gateways.reduce((total, item) => total + item.models.length, 0),
        updatedAt: snapshot.updatedAt,
      });
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
  { providerId: "workbuddy-ai", namespace: "gateway", baseUrl: "http://127.0.0.1:57891/v1", region: "global", name: "pi-workbuddy-\u56fd\u9645\u7248" },
  { providerId: "trae-cn", namespace: "trae/gateway", baseUrl: "http://127.0.0.1:7864/v1", region: "cn", name: "pi-trae-\u56fd\u5185\u7248" },
  { providerId: "trae-intl", namespace: "trae/gateway", baseUrl: "http://127.0.0.1:7864/v1", region: "global", name: "pi-trae-\u56fd\u9645\u7248" },
  { providerId: "qoder-cn", namespace: "qoder/gateway", baseUrl: "http://127.0.0.1:57895/v1", region: "cn", name: "pi-qoder-\u56fd\u5185\u7248" },
  { providerId: "qoder-intl", namespace: "qoder/gateway", baseUrl: "http://127.0.0.1:57895/v1", region: "global", name: "pi-qoder-\u56fd\u9645\u7248" },
  { providerId: "kuku-gateway", namespace: "unified-gateway", baseUrl: "http://127.0.0.1:57896/v1", region: "cn", name: "pi-\u5e93\u5e93" },
  { providerId: "raccoon-gateway", namespace: "unified-gateway", baseUrl: "http://127.0.0.1:57898/v1", region: "cn", name: "pi-\u6d63\u718a" },
];

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
    keyTargets: KEY_TARGETS.map(({ providerId, region, name }) => ({ providerId, region, name })),
    created: [...createdKeys.keys()],
  };
}

/** Re-pull only once the configured interval has elapsed, so a settings edit lands. */
async function tick() {
  const { autoRefreshMinutes } = await readSettings();
  if (autoRefreshMinutes <= 0) return;
  const last = snapshot.updatedAt ? Date.parse(snapshot.updatedAt) : 0;
  if (Date.now() - last >= autoRefreshMinutes * 60_000) await pull("auto");
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

  const settings = await readSettings();
  if (settings.refreshOnStartup) await pull("startup");

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
      await pull("view");
      return report();
    }
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
