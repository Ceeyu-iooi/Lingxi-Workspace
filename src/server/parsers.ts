import { Decimal } from "decimal.js";
import { decodeHTML, parseCSV, unzip } from "./files.ts";
import { categoryFor } from "./business.ts";
import type { JsonObject } from "./profile.ts";

const DATE =
  "(大后天|后天|明天|今天|今晚|明晚|[本这]?下+周[一二三四五六日天]|[本这]?周[一二三四五六日天]|[本这]?星期[一二三四五六日天]|(?:(\\d{4})年)?(\\d{1,2})月(\\d{1,2})[日号]?|\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}\\.\\d{1,2}[日号]?)";
const TIME =
  "(早上|上午|中午|下午|傍晚|晚上|夜里)?\\s*(\\d{1,2}|[零一二两三四五六七八九十]{1,3})[:：点时]\\s*(半|三刻|(\\d{1,2}|[零一二三四五六七八九十]{1,3})分?)?";
const CN: JsonObject = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};
function cnNumber(value: string | undefined): number | null {
  if (!value) return null;
  if (/^\d{1,2}$/.test(value)) return Number(value);
  if (value in CN) return CN[value];
  if (value === "十") return 10;
  const match = value.match(
    /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/,
  );
  return match
    ? (match[1] ? CN[match[1]] : 1) * 10 + (match[2] ? CN[match[2]] : 0)
    : null;
}
const localISO = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
function dateOf(year: number, month: number, day: number) {
  const value = new Date(year, month - 1, day);
  if (
    value.getFullYear() !== year ||
    value.getMonth() !== month - 1 ||
    value.getDate() !== day
  )
    throw new Error();
  return value;
}
function findLocation(
  value: string,
): [string | null, number | null, number | null] {
  const patterns = [
    /(?:地点|位置|场所|地址)[:：为]?\s*([^\n，。；,;]{2,30})/,
    /[在于]([^\n，。；,;\s]{0,10}?(?:楼|教室|会议室|实验室|报告厅|礼堂|场馆|馆|厅|广场|操场|中心)[A-Za-z0-9\-]*)/,
    /([\u4e00-\u9fa5A-Za-z]{1,6}楼[A-Za-z0-9\-]*|第?\d+-?\d*教室|[\u4e00-\u9fa5]{1,4}教\d+|会议室[A-Za-z0-9]*|实验室[A-Za-z0-9]*|报告厅|图书馆[^，。\n\s]{0,8})/,
  ];
  for (let i = 0; i < patterns.length; i++) {
    const m = patterns[i].exec(value);
    if (!m) continue;
    const location = (i === 1 ? m[1].replace(/^[在于]/, "") : m[1]).trim();
    let start = m.index;
    if (i === 2 && start > 0 && /[在于]/.test(value[start - 1])) start--;
    if (
      i === 0 ||
      (location.length >= 1 &&
        location.length <= 30 &&
        !/[星期周早晚下午点分半]|\d{1,2}[:：]/.test(location))
    )
      return [location, start, m.index + m[0].length];
  }
  return [null, null, null];
}
export function parseNotification(raw: string, now = new Date()) {
  const value = decodeHTML(raw || "")
    .replaceAll("\r", "")
    .trim();
  let date: Date | null = null,
    dateToken = "",
    timeToken = "",
    hour: number | null = null,
    minute = 0;
  for (const m of value.matchAll(new RegExp(DATE, "g"))) {
    const token = m[0];
    try {
      const offsets: JsonObject = {
        大后天: 3,
        后天: 2,
        明天: 1,
        今天: 0,
        今晚: 0,
        明晚: 1,
      };
      if (token in offsets) {
        date = new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate() + offsets[token],
        );
      } else if (/[周星期]/.test(token)) {
        const weekday: JsonObject = {
            一: 0,
            二: 1,
            三: 2,
            四: 3,
            五: 4,
            六: 5,
            日: 6,
            天: 6,
          },
          target = weekday[token.at(-1)!],
          current = (now.getDay() + 6) % 7;
        let delta = (target - current + 7) % 7 || 7;
        delta += 7 * (token.match(/下/g) || []).length;
        date = new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate() + delta,
        );
      } else if (token.includes("月")) {
        date = dateOf(
          m[2] ? Number(m[2]) : now.getFullYear(),
          Number(m[3]),
          Number(m[4]),
        );
        if (
          !m[2] &&
          date < new Date(now.getFullYear(), now.getMonth(), now.getDate())
        )
          date = dateOf(
            now.getFullYear() + 1,
            date.getMonth() + 1,
            date.getDate(),
          );
      } else if (token.includes("-")) {
        const [y, mo, d] = token.split("-").map(Number);
        date = dateOf(y, mo, d);
      } else {
        const [mo, d] = token
          .replace(/[日号]$/, "")
          .split(".")
          .map(Number);
        date = dateOf(now.getFullYear(), mo, d);
        if (date < new Date(now.getFullYear(), now.getMonth(), now.getDate()))
          date = dateOf(now.getFullYear() + 1, mo, d);
      }
      dateToken = token;
      break;
    } catch {
      date = null;
    }
  }
  for (const m of value.matchAll(new RegExp(TIME, "g"))) {
    const h = cnNumber(m[2]);
    if (h === null) continue;
    let candidate = h;
    const mins =
      m[3] === "半"
        ? 30
        : m[3] === "三刻"
          ? 45
          : cnNumber((m[3] || "").replace(/分$/, "")) || 0;
    if (
      (["下午", "傍晚", "晚上", "夜里"].includes(m[1]) ||
        (!m[1] && m.index! > 0 && /[晚夜]/.test(value[m.index! - 1]))) &&
      candidate < 12
    )
      candidate += 12;
    if (candidate >= 0 && candidate <= 23 && mins >= 0 && mins <= 59) {
      hour = candidate;
      minute = mins;
      timeToken = m[0].trim();
      break;
    }
  }
  let dueAt: string | null = null,
    dueText: string | null = null;
  if (date) {
    if (hour !== null) date.setHours(hour, minute, 0, 0);
    dueAt = localISO(date);
    dueText = dateToken + timeToken;
  } else if (hour !== null) {
    const day = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      hour,
      minute,
    );
    if (day < now) day.setDate(day.getDate() + 1);
    dueAt = localISO(day);
    dueText = timeToken;
  }
  const lines = value
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  let title = "";
  if (lines.length) {
    const action =
        /(召开|举办|开展|举行|进行|提交|截止|答辩|考试|上课|会议|讲座|报告|培训|开会|交|报名|打卡|领取|体检|面试|答疑|作业|模考)/,
      candidates = lines.filter((s) => action.test(s));
    let line = (candidates.length ? candidates : lines)
      .reduce((a, b) => (b.length > a.length ? b : a))
      .slice(0, 160);
    for (let i = 0; i < 2; i++) {
      line = line
        .replace(
          /^(?:【[^】]{0,14}】|\([^()]{0,14}\)|(通知|关于|温馨提示|请注意|重要|各位同学|同学们|全体同学|亲爱的?[^，。\n:：]{1,10})[:：，,]?)+/,
          "",
        )
        .trim();
      line = line
        .replace(/(的?通知|的?公告|[,，。]?请.{2,40}$|[，。]$)/g, "")
        .trim();
    }
    const spans: [number, number][] = [];
    for (const pattern of [DATE, TIME]) {
      const m = new RegExp(pattern).exec(line);
      if (m) spans.push([m.index, m.index + m[0].length]);
    }
    const [, start, end] = findLocation(line);
    if (start !== null) spans.push([start, end!]);
    for (const [s, e] of spans.sort((a, b) => b[0] - a[0] || b[1] - a[1]))
      line = (line.slice(0, s) + line.slice(e)).trim();
    line = line
      .replace(/^[，。、；：,.;\s]+|[，。、；：,.;\s]+$/g, "")
      .replace(/^(?:关于|召开|举办|举行|开展|进行)+/, "")
      .trim()
      .replace(/^[，。、；：,.-]+\s*/, "")
      .trim();
    title = line.slice(0, 60) || lines[0].slice(0, 40);
  }
  const keywords: string[] = [];
  for (const word of title.split(/[\s，。、：:；;（）()【】]+/)) {
    if (word.length >= 2 && word.length <= 12 && !keywords.includes(word))
      keywords.push(word);
  }
  for (const word of value.match(
    /提交|报名|答疑|考试|会议|讲座|作业|面试|实验|报告|复习|项目/g,
  ) || [])
    if (!keywords.includes(word)) keywords.push(word);
  return {
    title,
    dueAt,
    dueText,
    location: findLocation(value)[0],
    keywords: keywords.slice(0, 5),
  };
}

const HEADERS: Record<string, string[]> = {
  date: ["交易时间", "交易创建时间", "交易日期", "时间", "日期", "入账时间"],
  amount: [
    "金额(元)",
    "交易金额",
    "金额",
    "收/支金额",
    "交易金额(元)",
    "订单金额(元)",
  ],
  direction: ["收/支", "收支类型", "交易类型", "收支", "资金方向"],
  name: [
    "商品说明",
    "交易对方",
    "商品名称",
    "交易名称",
    "交易摘要",
    "备注",
    "说明",
  ],
  status: ["当前状态", "交易状态", "状态"],
  id: ["交易单号", "交易订单号", "交易流水号", "流水号", "商户订单号"],
};
function xmlTexts(value: string) {
  return [...value.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)]
    .map((m) => decodeHTML(m[1]))
    .join("");
}
export async function parseBill(filename: string, raw: Buffer) {
  if (!raw.length || raw.length > 5 * 1024 * 1024)
    throw new Error("请选择不超过 5 MB 的账单文件");
  let rows: string[][];
  if (/\.(csv|tsv)$/i.test(filename)) {
    let decoded = "";
    const names =
      raw[0] === 255 && raw[1] === 254
        ? ["utf-16le", "utf-8", "gb18030"]
        : raw[0] === 254 && raw[1] === 255
          ? ["utf-16be", "utf-8", "gb18030"]
          : ["utf-8", "gb18030", "utf-16le"];
    for (const name of names)
      try {
        decoded = new TextDecoder(name, { fatal: true })
          .decode(raw)
          .replace(/^\uFEFF/, "");
        break;
      } catch {}
    if (!decoded) throw new Error("账单编码无法识别，请导出 UTF-8 CSV");
    const sample = decoded.slice(0, 4096);
    rows = parseCSV(
      decoded,
      (sample.match(/\t/g) || []).length > (sample.match(/,/g) || []).length
        ? "\t"
        : ",",
    );
  } else if (/\.xlsx$/i.test(filename)) {
    const files = await unzip(raw, 50 * 1024 * 1024),
      strings = files.has("xl/sharedStrings.xml")
        ? [
            ...files
              .get("xl/sharedStrings.xml")!
              .toString("utf8")
              .matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g),
          ].map((m) => xmlTexts(m[1]))
        : [],
      sheet = [...files.keys()].find((n) =>
        /^xl\/worksheets\/sheet\d+\.xml$/.test(n),
      );
    if (!sheet) throw new Error("工作簿没有可读取的工作表");
    rows = [];
    for (const row of files
      .get(sheet)!
      .toString("utf8")
      .matchAll(/<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
      const cells: Record<number, string> = {};
      for (const cell of row[1].matchAll(
        /<(?:\w+:)?c\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?c>/g,
      )) {
        const reference = cell[1].match(/\br="([A-Z]+)\d+"/)?.[1] || "A";
        let index = 0;
        for (const c of reference) index = index * 26 + c.charCodeAt(0) - 64;
        if (index > 16384) throw new Error("工作簿列数过多");
        let value = decodeHTML(
          cell[2].match(/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/)?.[1] ||
            xmlTexts(cell[2]),
        );
        if (/\bt="s"/.test(cell[1]) && value)
          value = strings[Number(value)] || "";
        cells[index - 1] = value;
      }
      const indexes = Object.keys(cells).map(Number);
      if (indexes.length)
        rows.push(
          Array.from(
            { length: Math.max(...indexes) + 1 },
            (_, i) => cells[i] || "",
          ),
        );
    }
  } else throw new Error("请使用 CSV、TSV 或 XLSX 账单");
  let headerAt = -1,
    columns: Record<string, number> = {};
  for (let i = 0; i < Math.min(100, rows.length); i++) {
    const normalized = rows[i].map((s) =>
        s.replace(/\s+/g, "").replaceAll("（", "(").replaceAll("）", ")"),
      ),
      found = Object.fromEntries(
        Object.entries(HEADERS).map(([key, choices]) => [
          key,
          choices.map((n) => normalized.indexOf(n)).find((n) => n >= 0) ?? -1,
        ]),
      );
    if (found.date >= 0 && found.amount >= 0) {
      headerAt = i;
      columns = found;
      break;
    }
  }
  if (headerAt < 0)
    throw new Error("未找到日期和金额列，请使用银行、支付宝或微信的明细账单");
  const result: JsonObject[] = [];
  let skipped = 0;
  for (const row of rows.slice(headerAt + 1)) {
    if (!row.some((s) => s.trim())) continue;
    const get = (key: string) => String(row[columns[key]] || "").trim();
    try {
      const dateRaw = get("date");
      let day: string;
      if (/^\d+(?:\.\d+)?$/.test(dateRaw)) {
        const d = new Date(Date.UTC(1899, 11, 30) + Number(dateRaw) * 86400000);
        day = d.toISOString().slice(0, 10);
      } else {
        const m = dateRaw.match(/(20\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})/);
        if (!m) throw new Error();
        day = localISO(dateOf(Number(m[1]), Number(m[2]), Number(m[3]))).slice(
          0,
          10,
        );
      }
      const amountRaw = get("amount")
          .replaceAll(",", "")
          .replace(/[¥￥]/g, "")
          .trim(),
        value = new Decimal(amountRaw).abs();
      if (!value.isFinite() || value.gt(1000000000)) throw new Error();
      const amount = value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
      if (!amount) throw new Error();
      if (
        /失败|关闭|退款中|撤销/.test(get("status")) ||
        get("direction").includes("不计收支")
      ) {
        skipped++;
        continue;
      }
      const kind =
          /收入|入账|退款/.test(get("direction")) ||
          amountRaw.startsWith("+") ||
          get("name").includes("退款")
            ? "income"
            : "expense",
        title = get("name") || "未命名交易";
      result.push({
        date: day,
        occurredAt: dateRaw.slice(0, 40),
        amount,
        kind,
        sourceId: get("id").slice(0, 100),
        title: title.slice(0, 120),
        category: kind === "income" ? "收入" : categoryFor(title),
      });
    } catch {
      skipped++;
    }
  }
  if (!result.length) throw new Error("没有识别到有效交易，请检查账单格式");
  return {
    rows: result.slice(0, 5000),
    skipped: skipped + Math.max(0, result.length - 5000),
  };
}
