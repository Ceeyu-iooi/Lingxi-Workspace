import {
  existsSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { readJson, uid } from "./profile.ts";
import {
  validateTarget,
  preflight,
  moveProfile,
  removeOld,
} from "./maintenance.ts";
export function maintain(args: string[]) {
  const action = args[0],
    get = (name: string) => {
      const i = args.indexOf(name);
      return i >= 0 ? args[i + 1] : "";
    },
    source = resolve(get("--source")),
    target = get("--target") ? resolve(get("--target")) : source;
  if (action === "select") {
    validateTarget(target);
    mkdirSync(target, { recursive: true });
    const metadata = readJson<any>(join(target, ".profile.json"), null);
    if (
      metadata &&
      (metadata.format !== "lingxi-profile" || metadata.schemaVersion !== 1)
    )
      throw new Error("Profile 格式不支持");
    if (
      !metadata &&
      readdirSync(target).some(
        (name) =>
          ![
            "browser",
            "logs",
            "runtime",
            "updates",
            "workspace",
            "config",
          ].includes(name),
      )
    )
      throw new Error("请选择空文件夹或现有新版 Profile，旧账户资料不自动迁入");
    const probe = join(target, ".writable-" + uid());
    try {
      writeFileSync(probe, "", { flag: "wx" });
    } finally {
      if (existsSync(probe)) unlinkSync(probe);
    }
    return { root: target, existing: !!metadata };
  }
  if (action === "compact") return { ok: true, root: source };
  if (action === "preflight") return preflight(source, target);
  if (action === "migrate") {
    const locator =
      get("--locator") || join(source, "config", "desktop-location.json");
    return moveProfile(source, target, locator);
  }
  if (action === "remove-old") return removeOld(source);
  throw new Error("资料操作不支持");
}
