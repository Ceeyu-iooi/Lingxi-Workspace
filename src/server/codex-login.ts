import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CodexRPC, readCodexAccount } from "./codex-account.ts";
import type { ProfileStore, JsonObject } from "./profile.ts";

/** This process owns only the account RPC lifecycle; no inference turns. */
export class CodexLogin {
  private rpc?: CodexRPC;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private value: JsonObject = { status: "idle" };
  constructor(private profile: ProfileStore) {}
  get home() { return join(this.profile.root, "data", "credentials", this.profile.owner, "codex"); }
  state() { return { ...this.value }; }
  async start(mode: string) {
    if (!["browser", "device"].includes(mode)) throw new Error("登录方式不正确");
    await this.cancel();
    const ticket = ++this.generation;
    mkdirSync(this.home, { recursive: true });
    const rpc = this.rpc = new CodexRPC(this.home);
    this.value = { status: "starting" };
    rpc.notify = (method, params) => {
      if (ticket !== this.generation) return;
      if (method === "account/login/completed") {
        this.value = { status: params.success ? "success" : "error", error: params.success ? "" : "授权未完成，请重试" };
        clearTimeout(this.timer);
        rpc.close(); this.rpc = undefined;
      }
    };
    try {
      await rpc.call("initialize", { clientInfo: { name: "lingxi_account", version: "0.0.34" } });
      rpc.initialized();
      const result = await rpc.call("account/login/start", { type: mode === "device" ? "chatgptDeviceCode" : "chatgpt" });
      if (ticket !== this.generation || this.value.status === "success") return this.state();
      const url = result.authUrl || result.verificationUrl;
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || !["auth.openai.com", "chatgpt.com"].includes(parsed.hostname)) throw new Error("授权地址不正确");
      this.value = { status: "waiting", loginId: result.loginId, authUrl: url, userCode: result.userCode || "" };
      this.timer = setTimeout(() => { if (ticket === this.generation) { this.value = { status: "expired", error: "登录已超时，请重新开始" }; rpc.close(); this.rpc = undefined; } }, 10 * 60 * 1000);
      this.timer.unref();
    } catch (error) {
      if (ticket === this.generation) this.value = { status: "error", error: error instanceof Error ? error.message : "登录启动失败" };
      rpc.close(); this.rpc = undefined;
    }
    return this.state();
  }
  async cancel(expected?: string) {
    if(expected && expected !== this.value.loginId) return this.state();
    this.generation++; clearTimeout(this.timer);
    const rpc = this.rpc; this.rpc = undefined;
    if (rpc && this.value.loginId) await rpc.call("account/login/cancel", { loginId: this.value.loginId }).catch(() => {});
    rpc?.close(); this.value = { status: "cancelled" }; return this.state();
  }
  close() { this.generation++; clearTimeout(this.timer); this.rpc?.close(); this.rpc = undefined; }
  async account() {
    const observedAt = new Date().toISOString();
    const result = await readCodexAccount(this.home,{includeActivity:false});
    return { ...result, authorization: "chatgpt", observedAt };
  }
}
