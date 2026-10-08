import { Decimal } from "decimal.js";
import { ProfileStore, hash, uid, stamp, type JsonObject } from "./profile.ts";
import { DEFAULT_SETTINGS } from "../shared/defaults.ts";
import type {
  Project,
  Task,
  Transaction,
  Activity,
  Summary,
} from "../shared/contracts.ts";

const entities = [
  "projects",
  "tasks",
  "summaries",
  "activities",
  "transactions",
  "settings",
  "preferences",
];
export class Business {
  constructor(readonly profile: ProfileStore) {}
  settings() {
    return {
      ...structuredClone(DEFAULT_SETTINGS),
      ...this.profile.read<JsonObject>("settings", {}),
    };
  }
  state() {
    return Object.fromEntries([
      ...entities.map((name) => [
        name,
        name === "settings"
          ? this.settings()
          : this.profile.read(name, name === "preferences" ? {} : []),
      ]),
      ["serverTime", stamp()],
    ]);
  }
  activity(text: string) {
    const rows = this.profile.read<Activity[]>("activities", []);
    rows.unshift({ id: uid(), text, at: stamp() });
    this.profile.write("activities", rows.slice(0, 500));
  }
  project(id: string | null, body: JsonObject) {
    const rows = this.profile.read<Project[]>("projects", []);
    if (id) {
      if (body._method === "DELETE") {
        this.profile.transaction(() => {
          this.profile.write(
            "projects",
            rows.filter((p) => p.id !== id),
          );
          this.profile.write(
            "tasks",
            this.profile
              .read<Task[]>("tasks", [])
              .filter((t) => t.projectId !== id),
          );
        });
        return { ok: true };
      }
      const row = rows.find((p) => p.id === id);
      if (!row) throw new Error("项目不存在");
      for (const key of ["name", "status", "note"] as const)
        if (body[key] !== undefined && body[key] !== null && body[key] !== "")
          row[key] = body[key];
      this.profile.write("projects", rows);
      return { project: row };
    }
    if (typeof body.name !== "string" || !body.name.trim())
      throw new Error("项目名称不能为空");
    const row: Project = {
      id: uid(),
      name: body.name.trim(),
      status: "active",
      createdAt: stamp(),
      note: String(body.note || "").trim(),
    };
    rows.unshift(row);
    this.profile.transaction(() => {
      this.profile.write("projects", rows);
      this.activity(`新建项目「${row.name}」`);
    });
    return { project: row };
  }
  task(id: string | null, body: JsonObject) {
    const rows = this.profile.read<Task[]>("tasks", []);
    if (id) {
      if (body._method === "DELETE") {
        this.profile.write(
          "tasks",
          rows.filter((t) => t.id !== id),
        );
        return { ok: true };
      }
      const row = rows.find((t) => t.id === id);
      if (!row) throw new Error("待办不存在");
      this.profile.transaction(() => {
        if (body.done !== undefined && Boolean(body.done) !== row.done) {
          row.done = Boolean(body.done);
          row.completedAt = row.done ? stamp() : null;
          this.activity(
            `${row.done ? "完成了" : "重新打开了"}「${row.title}」`,
          );
        }
        if (typeof body.title === "string" && body.title.trim())
          row.title = body.title.trim();
        if (body.projectId !== undefined)
          row.projectId = body.projectId || null;
        if (body.dueAt !== undefined) row.dueAt = body.dueAt || null;
        if (body.location !== undefined)
          row.location = String(body.location || "").trim() || null;
        this.profile.write("tasks", rows);
      });
      return { task: row };
    }
    if (typeof body.title !== "string" || !body.title.trim())
      throw new Error("待办内容不能为空");
    const row: Task = {
      id: uid(),
      title: body.title.trim(),
      projectId: body.projectId || null,
      done: false,
      createdAt: stamp(),
      completedAt: null,
      dueAt: body.dueAt || null,
      location: String(body.location || "").trim() || null,
      keywords: (body.keywords || [])
        .slice(0, 5)
        .map((k: unknown) => String(k).slice(0, 20)),
    };
    rows.unshift(row);
    this.profile.transaction(() => {
      this.profile.write("tasks", rows);
      if (row.projectId) {
        const name =
          this.profile
            .read<Project[]>("projects", [])
            .find((p) => p.id === row.projectId)?.name || "项目";
        this.activity(`在「${name}」新增待办「${row.title}」`);
      }
    });
    return { task: row };
  }
  transactions(body: JsonObject) {
    if (!Array.isArray(body.rows) || body.rows.length > 5000)
      throw new Error("单次最多导入 5000 条");
    const clean = body.rows.map((raw: JsonObject) => {
      const day = String(raw.date || "");
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
        Number.isNaN(Date.parse(day)) ||
        new Date(day).toISOString().slice(0, 10) !== day
      )
        throw new Error("日期格式不正确");
      let value: Decimal;
      try {
        value = new Decimal(String(raw.amount || 0));
      } catch {
        throw new Error("金额需为 0.01 到 1,000,000,000 的有效数字");
      }
      if (!value.isFinite() || value.lte(0) || value.gt(1000000000))
        throw new Error("金额需为 0.01 到 1,000,000,000 的有效数字");
      const amount = value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      if (amount.lte(0))
        throw new Error("金额需为 0.01 到 1,000,000,000 的有效数字");
      if (!["income", "expense"].includes(raw.kind))
        throw new Error("收支类型无效");
      const title =
        String(raw.title || "")
          .trim()
          .slice(0, 120) || "未命名交易";
      return {
        id: uid(),
        date: day,
        amount: amount.toNumber(),
        kind: raw.kind,
        title,
        category:
          String(raw.category || "")
            .trim()
            .slice(0, 20) ||
          (raw.kind === "income" ? "收入" : categoryFor(title)),
        fingerprint: hash(
          `${String(raw.sourceId || "").slice(0, 100) || String(raw.occurredAt || "").slice(0, 40) || day}|${amount.toFixed(2)}|${raw.kind}|${title}`,
        ),
        createdAt: stamp(),
      } as Transaction;
    });
    const rows = this.profile.read<Transaction[]>("transactions", []),
      known = new Set(rows.map((r) => r.fingerprint)),
      inserted = clean.filter((r: Transaction) => {
        if (body.allowDuplicate === true) return true;
        if (known.has(r.fingerprint)) return false;
        known.add(r.fingerprint);
        return true;
      });
    if (inserted.length)
      this.profile.transaction(() => {
        this.profile.write("transactions", [...inserted, ...rows]);
        this.activity(`导入账单 ${inserted.length} 条`);
      });
    return {
      added: inserted.length,
      duplicates: clean.length - inserted.length,
    };
  }
  summary(month?: string) {
    month =
      month ||
      new Date()
        .toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" })
        .slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("月份格式不正确");
    const prefix = month + "-",
      tasks = this.profile.read<Task[]>("tasks", []),
      projects = this.profile.read<Project[]>("projects", []),
      done = tasks.filter(
        (t) => t.done && (t.completedAt || "").startsWith(prefix),
      ),
      created = tasks.filter((t) => t.createdAt.startsWith(prefix)),
      newProjects = projects.filter((p) => p.createdAt.startsWith(prefix)),
      byProject: Record<string, string[]> = {};
    for (const task of done) {
      const key =
        projects.find((p) => p.id === task.projectId)?.name || "未归组";
      (byProject[key] ??= []).push(task.title);
    }
    const lines = [
      `${month} 月度复盘`,
      "",
      "一、本月完成",
      `完成待办 ${done.length} 项；新增待办 ${created.length} 项；新建项目 ${newProjects.length} 个。`,
      ...Object.entries(byProject).map(
        ([name, items]) => `• ${name}：${items.join("；")}`,
      ),
    ];
    if (!done.length) lines.push("• 本月没有已完成待办记录，请补充实际成果。");
    lines.push(
      "",
      "二、关键成果与证据",
      "• [写下结果、文件或可核验的数据]",
      "",
      "三、遇到的问题与原因",
      "• [写下问题、影响及原因]",
      "",
      "四、下月计划",
      "• [写下具体行动和截止日期]",
    );
    return {
      month,
      stats: {
        done: done.length,
        created: created.length,
        newProjects: newProjects.length,
      },
      draft: lines.join("\n"),
      byProject,
    };
  }
  saveSummary(body: JsonObject) {
    if (!body.month) throw new Error("缺少月份");
    this.summary(body.month);
    const row: Summary = {
        id: uid(),
        month: body.month,
        content: String(body.content || ""),
        stats: body.stats || {},
        savedAt: stamp(),
      },
      rows = this.profile
        .read<Summary[]>("summaries", [])
        .filter((s) => s.month !== row.month);
    rows.push(row);
    rows.sort((a, b) => b.month.localeCompare(a.month));
    this.profile.transaction(() => {
      this.profile.write("summaries", rows);
      this.activity(`保存了 ${row.month} 月度总结`);
    });
    return { summary: row };
  }
  preferences(body: JsonObject) {
    if (
      !body.changes ||
      typeof body.changes !== "object" ||
      Array.isArray(body.changes) ||
      Object.keys(body.changes).length > 100
    )
      throw new Error("布局偏好格式不正确");
    const values = this.profile.read<JsonObject>("preferences", {});
    for (const [key, value] of Object.entries(body.changes)) {
      if (
        !/^wb-[a-z0-9:-]{1,90}$/.test(key) ||
        (value !== null && (typeof value !== "string" || value.length > 32000))
      )
        throw new Error("布局偏好包含无效值");
      if (value === null) delete values[key];
      else values[key] = value;
    }
    this.profile.write("preferences", values);
    return { ok: true, values };
  }
}
export function categoryFor(title: string) {
  return (
    [
      ["餐饮", /餐|饭|食|外卖|奶茶|咖啡|超市|便利店/],
      ["交通", /地铁|公交|打车|滴滴|高铁|火车|机票|加油|停车/],
      ["购物", /购物|淘宝|京东|拼多多|商场|服饰|数码/],
      ["学习", /书|学费|课程|培训|考试|文具/],
      ["居住", /房租|物业|水费|电费|燃气|宽带/],
      ["娱乐", /电影|游戏|音乐|会员|旅游/],
      ["医疗", /医院|药|挂号|诊所/],
    ].find(([, pattern]) => (pattern as RegExp).test(title))?.[0] || "其他"
  );
}
