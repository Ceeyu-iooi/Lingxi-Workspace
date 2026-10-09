import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeAvatar } from "./avatar.ts";
import {
  ProfileStore,
  uid,
  stamp,
  parseExact,
  type JsonObject,
} from "./profile.ts";

export const FEATURES = {
  codexValuationEnabled: false,
  zcodeValuationEnabled: false,
  dshValuationEnabled: false,
  promptAutosave: true,
  promptAIEnabled: true,
};
const BOOL = [
  "memoryEnabled",
  "codexEnabled",
  "zcodeEnabled",
  "dshEnabled",
  ...Object.keys(FEATURES),
  "reduceMotion",
  "closeToTray",
];
const PATHS = [
  "codexPath",
  "zcodePath",
  "dshPath",
  "defaultProvider",
  "defaultAgent",
  "browserDefault",
];
const ALLOWED = new Set([
  ...BOOL,
  ...PATHS,
  "workspaceIgnore",
  "interfaceMode",
  "locale",
  "shortcuts",
  "dailyTokenBudget",
  "monthlyTokenBudget",
  "theme",
  "uiFontSize",
  "accent",
  "brightness",
  "onboardingStep",
]);
export function endpoint(value: unknown) {
  if (typeof value !== "string") throw new Error("地址必须是文本");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("地址须为不含账号密码的 HTTP/HTTPS URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error("地址须为不含账号密码的 HTTP/HTTPS URL");
  return value.replace(/\/+$/, "");
}
export async function fetchJSON(
  url: string,
  options: RequestInit = {},
  limit = 8 * 1024 * 1024,
  timeout = 40000,
) {
  const response = await fetch(url, {
    ...options,
    redirect: "error",
    signal: options.signal || AbortSignal.timeout(timeout),
  });
  if (!response.ok)
    throw new Error(
      (
        {
          401: "查询凭据无效或过期",
          403: "此凭据没有查询权限",
          429: "供应商限流，请稍后重试",
        } as Record<number, string>
      )[response.status] || `服务请求失败（${response.status}）`,
    );
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new Error("服务未返回数据");
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error("服务响应过大");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  }
  try {
    return parseExact(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("服务返回的数据格式不正确");
  }
}
export class Control {
  onResponse?: (
    cfg: JsonObject,
    response: JsonObject,
    payload: JsonObject,
    elapsed: number,
    status: string,
  ) => void;
  constructor(readonly profile: ProfileStore) {}
  state() {
    const value = this.profile.read<JsonObject>("control", {});
    return {
      config: { theme: "light", ...FEATURES, ...value.config },
      providers: value.providers || [],
      resources: {},
      sessions: [],
      runs: [],
      notifications: [],
    };
  }
  public() {
    const value = this.state(),
      keys = this.profile.credentials(),
      avatar = this.profile.read<JsonObject>("avatar", {}),
      home = process.env.USERPROFILE || homedir();
    return {
      ...value,
      providers: value.providers.map((p: JsonObject) => ({
        ...p,
        configured: !!keys[p.id],
      })),
      sections: [
        "general",
        "appearance",
        "modelProvider",
        "usage",
        "data",
        "shortcuts",
      ],
      defaultCodexPath: join(home, ".codex", "sessions"),
      defaultZcodePath: join(
        process.env.ZCODE_DATA_BASE_DIR || join(home, ".zcode"),
        "cli",
      ),
      defaultDshPath: join(
        process.env.DSH_HOME || join(home, ".dsh"),
        "sessions",
      ),
      capabilities: {
        browserControl: false,
        computerUse: false,
        sshRuntime: false,
        mcpHttp: false,
        localAutomations: false,
        agentChat: false,
        promptLibrary: true,
        skillsReadonly: true,
        codexValuation: true,
      },
      avatar: {
        configured: !!avatar.png,
        revision: avatar.revision,
        url: avatar.png
          ? "/api/profile/avatar?v=" +
            avatar.revision +
            "&profile=" +
            this.profile.owner
          : null,
      },
    };
  }
  saveConfig(body: JsonObject) {
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((k) => !ALLOWED.has(k))
    )
      throw new Error("设置项不正确");
    if (JSON.stringify(body).length > 64000) throw new Error("设置内容过长");
    for (const key of BOOL)
      if (key in body && typeof body[key] !== "boolean")
        throw new Error("开关需为布尔值");
    for (const key of ["dailyTokenBudget", "monthlyTokenBudget"])
      if (key in body && (!Number.isSafeInteger(body[key]) || body[key] < 0))
        throw new Error("预算需为非负整数");
    for (const [key, values] of Object.entries({
      interfaceMode: ["coding", "office"],
      locale: ["system", "zh-CN", "en-US"],
      theme: ["system", "light", "dark", "zai-light", "zai-dark"],
      onboardingStep: ["identity", "agents", "codex", "suppliers", "complete"],
      uiFontSize: [12, 14, 16, 18],
      accent: ["blue", "violet", "teal", "orange"],
    }))
      if (key in body && !(values as unknown[]).includes(body[key]))
        throw new Error("设置值不正确");
    if (
      "brightness" in body &&
      (!Number.isInteger(body.brightness) ||
        body.brightness < 85 ||
        body.brightness > 110)
    )
      throw new Error("亮度范围为 85–110");
    if (
      "workspaceIgnore" in body &&
      (!Array.isArray(body.workspaceIgnore) ||
        body.workspaceIgnore.some(
          (v: unknown) => typeof v !== "string" || v.length > 150,
        ))
    )
      throw new Error("忽略规则需为文本列表");
    for (const key of PATHS)
      if (
        key in body &&
        (typeof body[key] !== "string" || body[key].length > 1000)
      )
        throw new Error("路径和标识须为文本");
    if (body.shortcuts) {
      const entries = Object.entries(body.shortcuts);
      if (
        entries.some(
          ([k, v]) =>
            !["search", "sidebar", "settings"].includes(k) ||
            typeof v !== "string" ||
            !/^(Ctrl|Meta)\+(Shift\+)?[A-Za-z,]$/.test(v),
        ) ||
        new Set(entries.map(([, v]) => v)).size !== entries.length
      )
        throw new Error("快捷键格式不正确或重复");
    }
    const state = this.state();
    state.config = { ...state.config, ...body };
    this.profile.write("control", state);
    return { ok: true };
  }
  provider(body: JsonObject) {
    const state = this.state(),
      id = String(body.id || uid());
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id))
      throw new Error("资源标识格式不正确");
    const keys = this.profile.credentials();
    if (body.delete) {
      state.providers = state.providers.filter((p: JsonObject) => p.id !== id);
      delete keys[id];
      if (state.config.defaultProvider === id)
        state.config.defaultProvider =
          state.providers.find((p: JsonObject) => p.enabled)?.id || "";
      this.profile.saveCredentials(keys);
      this.profile.write("control", state);
      return { ok: true };
    }
    const name = String(body.name || "").trim(),
      model = String(body.model || "").trim();
    if (!name || !model || name.length > 80 || model.length > 180)
      throw new Error("请填写服务商名称和模型");
    const rates = body.rates || {};
    if (Object.keys(rates).length) {
      if (
        ["input", "output", "cached"].some(
          (k) =>
            typeof rates[k] !== "number" ||
            !Number.isFinite(rates[k]) ||
            rates[k] < 0,
        )
      )
        throw new Error("单价需为非负数，每百万 Token");
      if (!["USD", "CNY"].includes(rates.currency))
        throw new Error("请选择 CNY 或 USD");
    }
    const provider = {
      id,
      name,
      model,
      baseUrl: endpoint(body.baseUrl),
      rates,
      enabled: body.enabled !== false,
    };
    const key = String(body.apiKey || "").trim();
    if (key) keys[id] = key;
    if (body.clearKey) delete keys[id];
    this.profile.saveCredentials(keys);
    state.providers = [
      ...state.providers.filter((p: JsonObject) => p.id !== id),
      provider,
    ];
    if (!state.config.defaultProvider) state.config.defaultProvider = id;
    this.profile.write("control", state);
    return { provider: { ...provider, configured: !!keys[id] } };
  }
  configFor(id?: string) {
    const state = this.state(),
      pid = id || state.config.defaultProvider,
      provider = state.providers.find(
        (p: JsonObject) => p.id === pid && p.enabled,
      ),
      key = this.profile.credentials()[pid];
    if (!provider || !key)
      throw new Error("请在模型服务中添加 API 服务并保存密钥");
    return { ...provider, apiKey: key };
  }
  async request(cfg: JsonObject, payload: JsonObject) {
    const started = Date.now(),
      owner = this.profile.owner;
    let response: JsonObject | undefined;
    try {
      response = await fetchJSON(endpoint(cfg.baseUrl) + "/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + cfg.apiKey,
        },
        body: JSON.stringify(payload),
      });
      if (owner !== this.profile.owner) throw new Error("Profile 已切换");
      this.onResponse?.(cfg, response!, payload, Date.now() - started, "ok");
      return response!;
    } catch (error) {
      if (!response && owner === this.profile.owner)
        this.onResponse?.(cfg, {}, payload, Date.now() - started, "error");
      throw error;
    }
  }
  async testProvider(id: string) {
    const cfg = this.configFor(id),
      response = await fetchJSON(
        endpoint(cfg.baseUrl) + "/models",
        { headers: { Authorization: "Bearer " + cfg.apiKey } },
        2 * 1024 * 1024,
        10000,
      );
    return {
      ok: true,
      models: (response.data || []).map((r: JsonObject) => r.id).slice(0, 100),
    };
  }
  async avatar(body: JsonObject) {
    if (body.remove) {
      this.profile.write("avatar", {});
      return { ok: true, configured: false };
    }
    if (typeof body.data !== "string" || !/^[-+/=A-Za-z0-9]*$/.test(body.data))
      throw new Error("头像图片无法读取");
    const raw = Buffer.from(body.data, "base64");
    if (raw.length > 3 * 1024 * 1024) throw new Error("头像图片最多 3 MB");
    let png: Buffer;
    try {
      png=await normalizeAvatar(raw);
    } catch {
      throw new Error("请选择静态 PNG、JPEG 或 WebP 图片");
    }
    const revision = String(Date.now());
    this.profile.write("avatar", { png: png.toString("base64"), revision });
    return {
      ok: true,
      configured: true,
      revision,
      url: "/api/profile/avatar?v=" + revision,
    };
  }
}
export class Jobs {
  private items = new Map<string, JsonObject>();
  private pending = new Set<Promise<unknown>>();
  async idle() {
    await Promise.allSettled(this.pending);
  }
  start(
    kind: string,
    work: (update: (values: JsonObject) => void) => Promise<unknown>,
  ) {
    for (const [id, item] of this.items)
      if (Date.now() / 1000 - item.created > 3600) this.items.delete(id);
    const running = [...this.items.values()].filter(
        (j) => j.status === "running",
      ),
      same = running.find((j) => j.kind === kind);
    if (same) return this.get(same.id);
    if (running.length >= 4) throw new Error("已有任务正在运行，请稍后重试");
    const item = {
      id: uid(),
      kind,
      status: "running",
      created: Date.now() / 1000,
      progress: null,
    } as JsonObject;
    this.items.set(item.id, item);
    const update = (values: JsonObject) => Object.assign(item, values);
    const task = Promise.resolve()
      .then(() => work(update))
      .then(
        (result) =>
          update({ status: "complete", result, finished: Date.now() / 1000 }),
        (error) =>
          update({
            status: "failed",
            error:
              error.message?.slice(0, 400) ||
              "任务未完成；已保存的数据保留，可重试",
            finished: Date.now() / 1000,
          }),
      );
    this.pending.add(task);
    task.finally(() => this.pending.delete(task)).catch(() => {});
    return this.get(item.id);
  }
  get(id: string) {
    const value = this.items.get(id);
    if (!value) throw new Error("任务不存在");
    return structuredClone(value);
  }
  get running() {
    return [...this.items.values()].some((j) => j.status === "running");
  }
}
