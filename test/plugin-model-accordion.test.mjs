import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = "/Users/xinna/Documents/code-me/Agent-Daddy/pi-desktop";
const pluginDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(pluginDir, "manifest.json"), "utf8"));
const entrySource = readFileSync(join(pluginDir, "main.js"), "utf8");
const viewSource = readFileSync(join(pluginDir, "views/models.html"), "utf8");
const rendererSource = readFileSync(join(pluginDir, "renderer/index.mjs"), "utf8");

const MODELS = [
  {
    key: "openai/gpt-5",
    providerId: "openai",
    providerName: "OpenAI",
    modelId: "gpt-5",
    label: "GPT-5",
    supportsReasoning: true,
    thinkingLevels: ["low", "high"],
    isDefault: true,
    availableForSubagents: true,
  },
  {
    key: "anthropic/claude",
    providerId: "anthropic",
    providerName: "Anthropic",
    modelId: "claude",
    label: "Claude",
    alias: "cc",
    supportsReasoning: false,
    thinkingLevels: [],
  },
  {
    key: "openai/gpt-4.1-mini",
    providerId: "openai",
    providerName: "OpenAI",
    modelId: "gpt-4.1-mini",
    label: "GPT-4.1 mini",
    supportsReasoning: false,
    thinkingLevels: [],
  },
];

const GATEWAY_BODY = JSON.stringify({
  object: "list",
  data: [
    { id: "workbuddy-sonnet", object: "model", owned_by: "workbuddy" },
    { id: "workbuddy-gpt", object: "model" },
  ],
});

/** The host injects `pi` into the entry module; the test injects a stub the same way. */
function loadPlugin(pi) {
  const module = { exports: {} };
  new Function("module", "exports", "pi", entrySource)(module, module.exports, pi);
  return module.exports;
}

function makePi(options = {}) {
  const calls = {
    list: 0,
    toasts: [],
    published: [],
    registered: [],
    unregistered: [],
    services: [],
    revealed: [],
    fetched: [],
    clipboard: [],
  };
  const pi = {
    app: { getLocale: async () => options.locale ?? "en" },
    plugin: { getSettings: async () => options.settings ?? {} },
    commands: {
      register: async (definition) => {
        calls.registered.push(definition);
      },
      unregister: async (id) => {
        calls.unregistered.push(id);
      },
    },
    ui: {
      showToast: async (message, level) => {
        calls.toasts.push({ message, level });
      },
      revealView: async (input) => {
        if (options.revealFails) throw new Error("no active session");
        calls.revealed.push(input);
      },
    },
    models: {
      list: async () => {
        calls.list += 1;
        if (options.listError) throw new Error(options.listError);
        return options.models ?? MODELS;
      },
    },
    net: {
      fetch: async (input) => {
        calls.fetched.push(input.url);
        const answer = options.fetch?.(input.url, input);
        if (answer instanceof Error) throw answer;
        if (!answer) throw new Error("ECONNREFUSED");
        return answer;
      },
    },
    clipboard: {
      writeText: async (text) => {
        calls.clipboard.push(text);
      },
    },
    bus: {
      publish: async (topic, payload) => {
        calls.published.push({ topic, payload });
      },
    },
    services: {
      register: (definition) => {
        calls.services.push(definition);
      },
    },
  };
  return { pi, calls };
}

/** Answers the OpenAI model list on one port only; every other probe is refused. */
function openAiOn(port) {
  return (url) =>
    url.startsWith(`http://127.0.0.1:${port}/`)
      ? { status: 200, headers: {}, bodyText: GATEWAY_BODY }
      : new Error("ECONNREFUSED");
}

test("manifest pairs every contribution with the permission it needs", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, "local.pi-model-accordion");
  assert.equal(manifest.main, "main.js");
  assert.ok(existsSync(join(pluginDir, manifest.main)));

  for (const permission of [
    "ui.view",
    "models.list",
    "net.fetch",
    "clipboard.write",
    "background.service",
    "bus.publish",
    "renderer.extension",
    "provider.register",
  ]) {
    assert.ok(manifest.permissions.includes(permission), `missing permission ${permission}`);
  }

  const [view] = manifest.contributes.views;
  assert.equal(view.id, "models");
  assert.equal(view.entry, "views/models.html");
  assert.ok(existsSync(join(pluginDir, view.entry)));
  assert.equal(typeof view.title["zh-CN"], "string");
  assert.equal(view.icon, "list-checks");

  assert.deepEqual(manifest.contributes.bus.publish, ["local.pi-model-accordion.updated"]);
  assert.equal(manifest.contributes.services[0].id, "autoRefresh");
  assert.deepEqual(
    manifest.contributes.settings.map((entry) => entry.key),
    [
      "refreshOnStartup",
      "autoRefreshMinutes",
      "groupByProvider",
      "gatewayEndpoints",
      "gatewayPorts",
      "probeTimeoutMs",
      "foldPickerProviders",
      "pickerFoldCollapsedByDefault",
      "accountEndpoints",
    ],
  );
  assert.deepEqual(
    manifest.contributes.commands.map((entry) => entry.id),
    ["modelCatalog.open", "modelCatalog.refresh"],
  );

  // Pinned provider rows: the only way a gateway's models reach the host picker.
  assert.ok(manifest.permissions.includes("provider.register"));
  const providers = manifest.contributes.providers;
  assert.deepEqual(
    providers.map((provider) => provider.id),
    [
      "workbuddy-cn",
      "workbuddy-ai",
      "trae-cn",
      "trae-intl",
      "raccoon-gateway",
      "qoder-cn",
      "qoder-intl",
      "kuku-gateway",
    ],
  );
  for (const provider of providers) {
    assert.equal(provider.authKind, "api_key");
    assert.equal(provider.apiStyle, "chat_completions");
    assert.deepEqual(provider.models, []);
    assert.match(provider.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    assert.ok(provider.category.en && provider.category["zh-CN"]);
  }

  // Loopback-only egress, and the renderer surface the composer control needs.
  assert.deepEqual(manifest.net.domains, ["127.0.0.1", "localhost"]);
  assert.ok(existsSync(join(pluginDir, manifest.renderer)));
  assert.deepEqual(manifest.rendererActions, ["plugin.call"]);
  assert.deepEqual(manifest.rendererCallMethods, [
    "modelCatalog.openView",
    "modelCatalog.refresh",
    "modelCatalog.pickerFold",
  ]);
});

test("onLoad registers both commands, pulls once, and starts the timer service", async () => {
  const { pi, calls } = makePi({ fetch: openAiOn(8787), settings: { gatewayPorts: "8787" } });
  const plugin = loadPlugin(pi);

  await plugin.onLoad();

  assert.deepEqual(
    calls.registered.map((definition) => definition.id),
    ["modelCatalog.open", "modelCatalog.refresh"],
  );
  assert.equal(calls.list, 1);
  assert.equal(calls.fetched.length, 1);
  assert.equal(calls.published.length, 1);
  assert.equal(calls.published[0].topic, "local.pi-model-accordion.updated");
  assert.equal(calls.published[0].payload.reason, "startup");
  assert.equal(calls.published[0].payload.count, MODELS.length);
  assert.equal(calls.published[0].payload.gateways, 1);
  assert.equal(calls.published[0].payload.gatewayModels, 2);
  assert.ok(!Number.isNaN(Date.parse(calls.published[0].payload.updatedAt)));
  assert.equal(calls.services.length, 1);
  assert.equal(calls.services[0].id, "autoRefresh");
  assert.equal(typeof calls.services[0].start, "function");
  assert.equal(typeof calls.services[0].stop, "function");
});

test("the panel channel serves host models ordered by provider then label", async () => {
  const { pi } = makePi({ settings: { gatewayPorts: "8787" } });
  const plugin = loadPlugin(pi);
  await plugin.onLoad();

  const state = await plugin.onPanelInvoke("modelCatalog.state", {});

  assert.deepEqual(
    state.models.map((model) => model.key),
    ["anthropic/claude", "openai/gpt-4.1-mini", "openai/gpt-5"],
  );
  assert.equal(state.hostError, null);
  assert.equal(state.refreshing, false);
  assert.ok(!Number.isNaN(Date.parse(state.updatedAt)));
  assert.deepEqual(state.gateways, []);
  assert.equal(state.settings.autoRefreshMinutes, 10);
  assert.equal(state.settings.groupByProvider, true);
});

test("only gateways that answer are listed, and a configured endpoint keeps its error", async () => {
  const { pi, calls } = makePi({
    fetch: openAiOn(8787),
    settings: { gatewayPorts: "8787,8790", gatewayEndpoints: "Trae=http://127.0.0.1:9998/v1" },
  });
  const plugin = loadPlugin(pi);
  await plugin.onLoad();

  const state = await plugin.onPanelInvoke("modelCatalog.state", {});

  assert.equal(state.probed, 3);
  assert.deepEqual(
    state.gateways.map((gateway) => gateway.label),
    ["Trae", "127.0.0.1:8787"],
  );
  assert.deepEqual(
    calls.fetched.filter((url) => url.endsWith("/models")).sort(),
    [
      "http://127.0.0.1:8787/v1/models",
      "http://127.0.0.1:8790/v1/models",
      "http://127.0.0.1:9998/v1/models",
    ],
  );

  const [configured, scanned] = state.gateways;
  assert.equal(configured.ok, false);
  assert.equal(configured.explicit, true);
  assert.match(configured.error, /ECONNREFUSED/);
  assert.equal(scanned.ok, true);
  assert.equal(scanned.explicit, false);
  assert.deepEqual(
    scanned.models.map((model) => model.id),
    ["workbuddy-sonnet", "workbuddy-gpt"],
  );
});

test("an endpoint that is not an OpenAI model list is reported, not parsed", async () => {
  const { pi } = makePi({
    fetch: () => ({ status: 200, headers: {}, bodyText: "<html>hi</html>" }),
    settings: { gatewayPorts: "8787" },
  });
  const plugin = loadPlugin(pi);

  await plugin.onLoad();
  const state = await plugin.onPanelInvoke("modelCatalog.state", {});

  assert.deepEqual(state.gateways, []);
  assert.equal(state.gatewayError, null);
  assert.equal(state.hostError, null);
});

test("the refresh channel re-pulls and an unknown channel rejects", async () => {
  const { pi, calls } = makePi({ settings: { gatewayPorts: "8787" } });
  const plugin = loadPlugin(pi);
  await plugin.onLoad();

  const state = await plugin.onPanelInvoke("modelCatalog.refresh", {});

  assert.equal(calls.list, 2);
  assert.equal(calls.published.at(-1).payload.reason, "view");
  assert.equal(state.models.length, MODELS.length);
  await assert.rejects(
    () => plugin.onPanelInvoke("modelCatalog.drop", {}),
    /Unknown Model Catalog channel/,
  );
});

test("a failed host pull keeps the previous list and records the error", async () => {
  const options = {};
  const { pi, calls } = makePi(options);
  const plugin = loadPlugin(pi);
  await plugin.onLoad();

  options.listError = "host transport unavailable";
  const state = await plugin.onPanelInvoke("modelCatalog.refresh", {});

  assert.equal(state.hostError, "host transport unavailable");
  assert.equal(state.models.length, MODELS.length);
  // The snapshot is re-read either way, and the event carries the kept count.
  assert.equal(calls.published.length, 2);
  assert.equal(calls.published.at(-1).payload.count, MODELS.length);
});

test("the composer control's calls open the view and refresh", async () => {
  const { pi, calls } = makePi({ settings: { gatewayPorts: "8787" } });
  const plugin = loadPlugin(pi);
  await plugin.onLoad();

  assert.deepEqual(await plugin.onRendererCall("modelCatalog.openView"), { opened: true });
  assert.deepEqual(calls.revealed, [{ viewId: "models" }]);

  const refreshed = await plugin.onRendererCall("modelCatalog.refresh");
  assert.equal(refreshed.models, MODELS.length);
  assert.equal(refreshed.gateways, 0);

  await assert.rejects(
    () => plugin.onRendererCall("modelCatalog.nope"),
    (error) => error.code === "MODEL_CATALOG_UNKNOWN_METHOD",
  );
});

test("a gateway that demands a key is discovered, named from /healthz, and kept", async () => {
  const { pi, calls } = makePi({
    fetch: (url) => {
      if (url === "http://127.0.0.1:7864/healthz") {
        return {
          status: 200,
          headers: {},
          bodyText: JSON.stringify({ service: "trae-gateway", status: "ok" }),
        };
      }
      if (url.startsWith("http://127.0.0.1:7864/")) {
        return { status: 401, headers: {}, bodyText: '{"error":{"code":"unauthorized"}}' };
      }
      return new Error("ECONNREFUSED");
    },
    settings: { gatewayPorts: "7864,8790" },
  });
  const plugin = loadPlugin(pi);
  await plugin.onLoad();

  const state = await plugin.onPanelInvoke("modelCatalog.state", {});

  assert.equal(state.probed, 2);
  assert.equal(state.gateways.length, 1);
  const [gateway] = state.gateways;
  assert.equal(gateway.label, "trae-gateway");
  assert.equal(gateway.baseUrl, "http://127.0.0.1:7864/v1");
  assert.equal(gateway.needsKey, true);
  assert.equal(gateway.ok, false);
  assert.deepEqual(gateway.models, []);
  assert.equal(calls.published.at(-1).payload.locked, 1);
});

test("a named endpoint keeps its label and skips the identity probe", async () => {
  const { pi, calls } = makePi({
    fetch: (url) =>
      url.startsWith("http://127.0.0.1:57707/")
        ? { status: 401, headers: {}, bodyText: "{}" }
        : new Error("ECONNREFUSED"),
    settings: { gatewayEndpoints: "WorkBuddy=http://127.0.0.1:57707/v1", gatewayPorts: "9999" },
  });
  const plugin = loadPlugin(pi);
  await plugin.onLoad();

  const state = await plugin.onPanelInvoke("modelCatalog.state", {});

  assert.equal(state.gateways.length, 1);
  assert.equal(state.gateways[0].label, "WorkBuddy");
  assert.equal(state.gateways[0].needsKey, true);
  assert.equal(
    calls.fetched.filter((url) => url.includes("57707") && url.endsWith("/healthz")).length,
    0,
  );
});

test("the copy channel writes a host-valid provider entry", async () => {
  const { pi, calls } = makePi({ settings: { gatewayPorts: "8787" } });
  const plugin = loadPlugin(pi);
  await plugin.onLoad();

  const answer = await plugin.onPanelInvoke("modelCatalog.copyProviderEntry", {
    label: "WorkBuddy",
    baseUrl: "http://127.0.0.1:8787/v1/",
  });

  assert.deepEqual(answer, { ok: true });
  assert.equal(calls.clipboard.length, 1);
  assert.deepEqual(JSON.parse(calls.clipboard[0]), {
    id: "workbuddy",
    name: "WorkBuddy",
    baseUrl: "http://127.0.0.1:8787/v1",
    apiStyle: "chat_completions",
    authKind: "api_key",
    models: [],
  });
  await assert.rejects(
    () =>
      plugin.onPanelInvoke("modelCatalog.copyProviderEntry", {
        label: "broken",
        baseUrl: "not a url",
      }),
    /baseUrl is required/,
  );
});

test("the composer control registers into composerControl and calls a declared method", () => {
  assert.match(rendererSource, /pi\.slots\.register\(\{\s*slot: "composerControl"/);
  assert.match(rendererSource, /host\.dispatch\("plugin\.call", \{ method: "modelCatalog\.openView"/);
  // Every method the renderer calls is declared in the manifest.
  assert.ok(manifest.rendererCallMethods.includes("modelCatalog.openView"));
  assert.match(rendererSource, /export function onLoad\(pi\)/);
});

test("commands reveal the view and toast the counts", async () => {
  const { pi, calls } = makePi({ settings: { gatewayPorts: "8787" } });
  const plugin = loadPlugin(pi);
  await plugin.onLoad();

  await calls.registered[0].run();
  assert.deepEqual(calls.revealed, [{ viewId: "models" }]);

  await calls.registered[1].run();
  assert.deepEqual(calls.toasts.at(-1), {
    message: `Model Catalog: ${MODELS.length} host model(s), 0 local gateway(s)`,
    level: "info",
  });
});

test("a rejected revealView falls back to a localized toast", async () => {
  const { pi, calls } = makePi({ revealFails: true, locale: "zh-CN" });
  const plugin = loadPlugin(pi);
  await plugin.onLoad();

  await calls.registered[0].run();

  assert.deepEqual(calls.toasts.at(-1), {
    message: "模型列表：请先打开一个会话，再显示模型列表",
    level: "warn",
  });
});

test("settings gate the startup pull and reach the view", async () => {
  const { pi, calls } = makePi({
    settings: {
      refreshOnStartup: false,
      autoRefreshMinutes: 0,
      groupByProvider: false,
      gatewayPorts: "8787-8789",
      probeTimeoutMs: 900,
    },
  });
  const plugin = loadPlugin(pi);

  await plugin.onLoad();
  assert.equal(calls.list, 0);
  assert.equal(calls.fetched.length, 0);

  const state = await plugin.onPanelInvoke("modelCatalog.state", {});
  assert.equal(state.settings.refreshOnStartup, false);
  assert.equal(state.settings.autoRefreshMinutes, 0);
  assert.equal(state.settings.groupByProvider, false);
  assert.deepEqual(state.settings.gatewayPorts, [8787, 8788, 8789]);
  assert.equal(state.settings.probeTimeoutMs, 900);
});

test("onUnload releases both commands", async () => {
  const { pi, calls } = makePi({ settings: { gatewayPorts: "8787" } });
  const plugin = loadPlugin(pi);
  await plugin.onLoad();

  await plugin.onUnload();

  assert.deepEqual(calls.unregistered, ["modelCatalog.open", "modelCatalog.refresh"]);
});

test("the view reaches the host only through the channels the entry handles", () => {
  const channels = [
    ...new Set(
      [...viewSource.matchAll(/"([A-Za-z][\w.]*)"/g)]
        .map((match) => match[1])
        .filter((value) => value.startsWith("modelCatalog.")),
    ),
  ].sort();

  assert.deepEqual(channels, [
    "modelCatalog.copyProviderEntry",
    "modelCatalog.refresh",
    "modelCatalog.state",
  ]);
  for (const channel of channels) {
    assert.match(entrySource, new RegExp(`"${channel}"`));
  }
  assert.match(viewSource, /window\.pluginBridge/);
  assert.match(viewSource, /bridge\.invoke\("app\.getAppearance"\)/);
  assert.match(viewSource, /bridge\.on\("appearance:changed"/);
  assert.match(viewSource, /bridge\.invoke\("modelCatalog\.copyProviderEntry", \{/);
  // A gateway that needs a key is surfaced, not hidden.
  assert.match(viewSource, /needsKey/);
  assert.match(viewSource, /lockedHint/);
  assert.doesNotMatch(viewSource, /clipboard\.writeText/);
  // A docked view has no `pi` API, and model data is rendered as text, not markup.
  assert.doesNotMatch(viewSource, /\bpi\.models\b/);
  assert.doesNotMatch(viewSource, /\.innerHTML\s*=/);
  assert.match(viewSource, /document\.documentElement\.dataset\.mode/);
  // Same chrome contract as the bundled views: the page owns its top spacing.
  assert.match(viewSource, /<meta name="pi-plugin-chrome" content="v2"/);
  assert.match(viewSource, /padding-top: var\(--pi-plugin-titlebar-height, 0px\)/);
  // The copied provider entry is the one shape the host accepts for discovery.
  assert.match(entrySource, /authKind: "api_key"/);
  assert.match(entrySource, /apiStyle: "chat_completions"/);
  assert.match(entrySource, /pi\.clipboard\.writeText\(providerEntry\(/);
});

const pickerFold = await import(
  new URL("../renderer/picker-fold.mjs", import.meta.url).href
);

test("picker folding: the fold state machine matches the ported behaviour", () => {
  const groups = () => [
    { id: "Recently used", label: "Recently used", recent: true },
    { id: "OpenAI", label: "OpenAI", active: true },
    { id: "WorkBuddy \u672c\u673a\u7f51\u5173", label: "WorkBuddy \u672c\u673a\u7f51\u5173" },
  ];

  // Folded by default, except the provider that holds the current model.
  const fresh = pickerFold.planFold({ groups: groups(), query: "", overrides: new Map() });
  assert.deepEqual([...fresh.values()], [true, true, false]);

  // A search expands everything, including a provider the user folded.
  const searching = pickerFold.planFold({
    groups: groups(),
    query: "glm",
    overrides: new Map([["WorkBuddy \u672c\u673a\u7f51\u5173", false]]),
  });
  assert.deepEqual([...searching.values()], [true, true, true]);

  // The user's own choice outranks the default.
  const manual = pickerFold.planFold({
    groups: groups(),
    query: "",
    overrides: new Map([
      ["OpenAI", false],
      ["WorkBuddy \u672c\u673a\u7f51\u5173", true],
    ]),
  });
  assert.deepEqual([...manual.values()], [true, false, true]);

  // With the default switched off nothing folds until the user asks.
  const open = pickerFold.planFold({
    groups: groups(),
    query: "",
    overrides: new Map(),
    collapsedByDefault: false,
  });
  assert.deepEqual([...open.values()], [true, true, true]);

  // No model selected yet: every provider starts folded.
  const none = pickerFold.planFold({
    groups: groups().map((group) => ({ ...group, active: false })),
    query: "",
    overrides: new Map(),
  });
  assert.deepEqual([...none.values()], [true, false, false]);
});

test("picker folding: the host's recently-used section is never folded", () => {
  const labelled = pickerFold.markRecentGroups([
    { label: "Recently used", modelNames: ["GPT-5"] },
    { label: "OpenAI", modelNames: ["GPT-5", "GPT-4.1 mini"] },
  ]);
  assert.equal(labelled[0].recent, true);
  assert.equal(Boolean(labelled[1].recent), false);

  // A localized heading the module does not list: the duplicated rows give it away.
  const localized = pickerFold.markRecentGroups([
    { label: "Zuletzt verwendet", modelNames: ["GPT-5"] },
    { label: "OpenAI", modelNames: ["GPT-5"] },
  ]);
  assert.equal(localized[0].recent, true);

  // A real provider whose models are its own is not the recent section.
  const providers = pickerFold.markRecentGroups([
    { label: "OpenAI", modelNames: ["GPT-5"] },
    { label: "WorkBuddy", modelNames: ["glm-4.6"] },
  ]);
  assert.equal(Boolean(providers[0].recent), false);

  const chevron = { textContent: "\u25be" };
  assert.equal(pickerFold.labelText({ textContent: "OpenAI\u25be", querySelector: () => chevron }), "OpenAI");
  assert.equal(pickerFold.labelText({ textContent: "  OpenAI  ", querySelector: () => null }), "OpenAI");
});

test("picker folding: the renderer asks for the switch the entry declares", () => {
  assert.ok(manifest.rendererCallMethods.includes("modelCatalog.pickerFold"));
  const keys = manifest.contributes.settings.map((setting) => setting.key);
  assert.ok(keys.includes("foldPickerProviders"));
  assert.ok(keys.includes("pickerFoldCollapsedByDefault"));
  assert.match(entrySource, /const PICKER_FOLD_METHOD = "modelCatalog\.pickerFold"/);
  assert.match(entrySource, /enabled: settings\.foldPickerProviders/);
  assert.match(rendererSource, /import \{ installPickerFold \} from "\.\/picker-fold\.mjs"/);
  assert.match(rendererSource, /method: PICKER_FOLD_METHOD/);
  assert.match(rendererSource, /export function onUnload\(\)/);
  assert.match(rendererSource, /if \(unloaded \|\| !fold\?\.enabled\) return;/);
});

test("picker folding: a click folds the accordion the ported way", () => {
  const groups = () => [
    { id: "Recently used", label: "Recently used", recent: true },
    { id: "OpenAI", label: "OpenAI", active: true },
    { id: "WorkBuddy", label: "WorkBuddy" },
  ];

  // Opening one provider closes the others, the way an accordion does.
  const single = pickerFold.planClick({
    groups: groups(),
    name: "WorkBuddy",
    isOpen: false,
    multi: false,
    overrides: new Map([["OpenAI", true]]),
  });
  assert.equal(single.get("WorkBuddy"), true);
  assert.equal(single.get("OpenAI"), false);

  // Ctrl/Cmd-click toggles one without touching the others.
  const multi = pickerFold.planClick({
    groups: groups(),
    name: "WorkBuddy",
    isOpen: true,
    multi: true,
    overrides: new Map([["OpenAI", true]]),
  });
  assert.equal(multi.get("WorkBuddy"), false);
  assert.equal(multi.get("OpenAI"), true);

  // Clicking the provider that is already open closes it.
  const closed = pickerFold.planClick({
    groups: groups(),
    name: "OpenAI",
    isOpen: true,
    multi: false,
    overrides: new Map(),
  });
  assert.equal(closed.get("OpenAI"), false);

  // The recently-used section is not part of the accordion.
  assert.equal(closed.has("Recently used"), false);
});

test("account sources are normalized through their aliases", async () => {
  const { pi } = makePi({
    settings: { accountEndpoints: "DaddySuite=http://127.0.0.1:57895/__accounts", gatewayPorts: "8787" },
    fetch: (url) => {
      if (url.includes("__accounts")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            accounts: [
              {
                accountId: "a1",
                username: "xinna",
                packageName: "Pro",
                points: 12.5,
                credentialExpiresAt: "2026-12-01T00:00:00Z",
                area: "cn",
                state: "active",
              },
            ],
            totalCredits: 30,
            checkIn: { checked: true, time: "2026-11-06T00:00:00Z", days: 5 },
            ip_pool: { free: 2, size: 8 },
          }),
        };
      }
      return new Error("ECONNREFUSED");
    },
  });
  const plugin = loadPlugin(pi);

  const state = await plugin.onPanelInvoke("modelCatalog.refresh", {});
  assert.equal(state.accounts.length, 1);
  const [source] = state.accounts;
  assert.equal(source.ok, true);
  assert.equal(source.label, "DaddySuite");
  assert.equal(source.url, "http://127.0.0.1:57895/__accounts");
  assert.deepEqual(source.accounts, [
    {
      id: "a1",
      name: "xinna",
      plan: "Pro",
      credits: 12.5,
      expiresAt: "2026-12-01T00:00:00Z",
      region: "cn",
      status: "active",
    },
  ]);
  assert.equal(source.totals.credits, 30);
  assert.equal(source.totals.accounts, 1);
  assert.equal(source.signIn.done, true);
  assert.equal(source.signIn.streak, 5);
  assert.equal(source.ipPool.available, 2);
  assert.equal(source.ipPool.total, 8);
});

test("an account endpoint that is down is unknown, not a failure", async () => {
  const { pi } = makePi({
    settings: { accountEndpoints: "DaddySuite=http://127.0.0.1:57895/__accounts", gatewayPorts: "8787" },
    fetch: (url) =>
      url.includes("__accounts") ? { status: 404, bodyText: "" } : new Error("ECONNREFUSED"),
  });
  const plugin = loadPlugin(pi);

  const state = await plugin.onPanelInvoke("modelCatalog.refresh", {});
  assert.equal(state.accounts.length, 1);
  assert.equal(state.accounts[0].ok, false);
  assert.equal(state.accounts[0].needsKey, false);
  assert.equal(state.accounts[0].error, "HTTP 404");
  assert.equal(state.accounts[0].accounts.length, 0);
  // A dead account source does not fail the rest of the pull.
  assert.equal(state.gatewayError, null);
  assert.equal(state.accountError, null);
});

test("the connector daemons are understood: data envelope, realm, credits", async () => {
  const { pi } = makePi({
    settings: {
      accountEndpoints:
        "Qoder \u56fd\u5185=http://127.0.0.1:47900/api/accounts\n\u5e93\u5e93=http://127.0.0.1:47862/api/accounts",
      gatewayPorts: "8787",
    },
    fetch: (url) => {
      if (url.includes("47900")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            ok: true,
            data: {
              realm: "qoder-cn",
              displayName: "Qoder CN",
              accounts: [
                {
                  profile: "p1",
                  userName: "nick",
                  credit: 1769,
                  active: true,
                  tokenExpired: false,
                  usage: { userType: "personal_standard", remaining: 1769, expiresAt: 253402214400000 },
                },
              ],
            },
          }),
        };
      }
      if (url.includes("47862")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            accounts: [
              {
                id: "1100043045574",
                nickname: "16\u53f7",
                accountType: "personal",
                expiresAt: 1827494917000,
                snapshot: { tokenRemain: 1577.52 },
              },
            ],
          }),
        };
      }
      return new Error("ECONNREFUSED");
    },
  });
  const plugin = loadPlugin(pi);

  const state = await plugin.onPanelInvoke("modelCatalog.refresh", {});
  const qoder = state.accounts.find((source) => source.url.includes("47900"));
  assert.equal(qoder.ok, true);
  assert.equal(qoder.accounts[0].id, "p1");
  assert.equal(qoder.accounts[0].name, "nick");
  assert.equal(qoder.accounts[0].plan, "personal_standard");
  assert.equal(qoder.accounts[0].credits, 1769);
  assert.equal(qoder.accounts[0].region, "qoder-cn");
  assert.match(qoder.accounts[0].expiresAt, /^9999-/);

  const kuku = state.accounts.find((source) => source.url.includes("47862"));
  assert.equal(kuku.accounts[0].name, "16\u53f7");
  assert.equal(kuku.accounts[0].plan, "personal");
  assert.equal(kuku.accounts[0].credits, 1577.52);
  assert.match(kuku.accounts[0].expiresAt, /^\d{4}-\d{2}-/);
});
