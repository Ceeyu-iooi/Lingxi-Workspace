import { Business } from "./business.ts";
import { decodeHTML } from "./files.ts";
import { stamp, type JsonObject } from "./profile.ts";

const TTL = 1800,
  RETRY = 300;
const clean = (s: string) =>
  decodeHTML((s || "").replace(/<[^>]+>/g, "")).trim();
export class News {
  private pending: Promise<JsonObject> | null = null;
  constructor(readonly business: Business) {}
  private async fetchSource(url: string): Promise<JsonObject[]> {
    const host = new URL(url).hostname,
      response = await fetch(url, {
        signal: AbortSignal.timeout(6000),
        headers: {
          "User-Agent": "Mozilla/5.0 (personal-workbench; RSS reader)",
          "Accept-Language": "zh-CN,zh;q=0.9",
          ...(host === "api.bilibili.com"
            ? { Referer: "https://www.bilibili.com/" }
            : {}),
        },
      });
    if (!response.ok) throw new Error("资讯源暂时不可用");
    const reader = response.body!.getReader(),
      parts: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1024 * 1024) {
        await reader.cancel();
        throw new Error("资讯源响应过大");
      }
      parts.push(value);
    }
    const raw = Buffer.concat(parts).toString("utf8");
    if (host === "top.baidu.com") {
      const m = raw.match(/<!--s-data:([\s\S]*?)-->/);
      if (!m) throw new Error("热搜榜单暂时不可用");
      const payload = JSON.parse(m[1]),
        rows = payload.data?.cards?.[0]?.content || [],
        capturedAt = stamp(),
        items: JsonObject[] = [];
      for (const row of rows) {
        const title = String(row.word || row.query || "").trim();
        if (!title || row.isTop) continue;
        let link = String(row.url || "");
        try {
          const h = new URL(link).hostname;
          if (h !== "baidu.com" && !h.endsWith(".baidu.com")) throw new Error();
        } catch {
          link = "https://www.baidu.com/s?wd=" + encodeURIComponent(title);
        }
        items.push({
          title,
          link,
          source: "百度热搜",
          capturedAt,
          rank: items.length + 1,
        });
        if (items.length === 20) break;
      }
      return items;
    }
    if (host === "api.bilibili.com") {
      const data = JSON.parse(raw);
      if (data.code !== 0 || !Array.isArray(data.data?.list))
        throw new Error("B站热门榜单暂时不可用");
      return data.data.list
        .filter(
          (r: JsonObject) =>
            /^BV[A-Za-z0-9]+$/.test(r.bvid) &&
            r.title &&
            Number.isInteger(r.pubdate),
        )
        .map((r: JsonObject) => ({
          title: clean(r.title),
          link: "https://www.bilibili.com/video/" + r.bvid + "/",
          source: "B站热门",
          date: new Date(r.pubdate * 1000).toISOString(),
        }));
    }
    const names: JsonObject = {
        "www.ithome.com": "IT之家",
        "www.ifanr.com": "爱范儿",
        "www.chinanews.com.cn": "中国新闻网",
      },
      items: JsonObject[] = [];
    for (const item of raw.matchAll(
      /<(?:\w+:)?(item|entry)\b[^>]*>([\s\S]*?)<\/(?:\w+:)?\1>/g,
    )) {
      const body = item[2],
        element = (name: string) =>
          body.match(
            new RegExp(
              "<(?:\\w+:)?" +
                name +
                "\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?" +
                name +
                ">",
            ),
          )?.[1] || "",
        title = clean(
          element("title").replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1"),
        ),
        link = decodeHTML(
          body.match(/<(?:\w+:)?link\b[^>]*\bhref=["']([^"']+)["']/)?.[1] ||
            element("link"),
        ).trim(),
        date =
          ["pubDate", "published", "updated", "date"]
            .map(element)
            .find(Boolean) || "";
      if (title && /^https?:\/\//.test(link))
        items.push({
          title,
          link,
          date: date.trim(),
          source: names[host] || host,
        });
      if (items.length >= 12) break;
    }
    return items;
  }
  private recent(rows: JsonObject[], now: number) {
    const latest = new Map<string, JsonObject>();
    for (const row of rows) {
      const timestamp = Date.parse(row.capturedAt || row.date || "") / 1000,
        age = row.capturedAt ? TTL * 2 : 7 * 86400;
      if (
        !Number.isFinite(timestamp) ||
        timestamp < now - age ||
        timestamp > now + 3600 ||
        !/^https?:\/\//.test(row.link || "")
      )
        continue;
      const value = {
        ...row,
        ...(!row.capturedAt
          ? { publishedAt: new Date(timestamp * 1000).toISOString() }
          : {}),
      };
      if (
        !latest.has(row.link) ||
        timestamp >
          Date.parse(
            latest.get(row.link)!.capturedAt || latest.get(row.link)!.date,
          ) /
            1000
      )
        latest.set(row.link, value);
    }
    const values = [...latest.values()];
    return values
      .sort(
        values.every((r) => "rank" in r)
          ? (a, b) => a.rank - b.rank
          : (a, b) =>
              Date.parse(b.capturedAt || b.date) -
              Date.parse(a.capturedAt || a.date),
      )
      .slice(0, 20);
  }
  get(force = false) {
    if (this.pending) return this.pending;
    this.pending = this.load(force).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  private async load(force: boolean) {
    const profile = this.business.profile,
      owner = profile.owner,
      sources = this.business.settings().news_sources,
      cache = profile.read<JsonObject>("news_cache", {}),
      now = Date.now() / 1000,
      stale = sources.filter((source: JsonObject) => {
        const entry = cache[source.id] || {},
          same = JSON.stringify(entry.feeds) === JSON.stringify(source.feeds);
        return (
          source.feeds?.length &&
          (force ||
            !(
              same &&
              ((entry.fetchedAt && now - entry.fetchedAt < TTL) ||
                (entry.lastAttemptAt && now - entry.lastAttemptAt < RETRY))
            ))
        );
      });
    if (stale.length) {
      const results = new Map<string, JsonObject[]>();
      await Promise.all(
        stale.flatMap((source: JsonObject) =>
          source.feeds.map(async (url: string) => {
            let rows: JsonObject[] = [];
            try {
              rows = await this.fetchSource(url);
            } catch {}
            results.set(source.id, [
              ...(results.get(source.id) || []),
              ...rows,
            ]);
          }),
        ),
      );
      if (owner !== profile.owner) throw new Error("Profile 已切换");
      for (const source of stale) {
        const previous = cache[source.id] || {},
          rows = results.get(source.id) || [];
        cache[source.id] = rows.length
          ? {
              fetchedAt: now,
              lastAttemptAt: now,
              feeds: source.feeds,
              items: this.recent(rows, now),
            }
          : {
              ...(JSON.stringify(previous.feeds) ===
              JSON.stringify(source.feeds)
                ? previous
                : { items: [] }),
              lastAttemptAt: now,
              feeds: source.feeds,
            };
      }
      profile.write("news_cache", cache);
    }
    return Object.fromEntries(
      sources.map((source: JsonObject) => {
        const entry = cache[source.id] || {},
          items = this.recent(entry.items || [], now);
        return [
          source.id,
          {
            name: source.name,
            ok: !!items.length,
            fetchedAt: entry.fetchedAt || null,
            items,
            links: source.links || [],
            hasFeeds: !!source.feeds?.length,
            ranking: !!source.ranking,
          },
        ];
      }),
    );
  }
}
