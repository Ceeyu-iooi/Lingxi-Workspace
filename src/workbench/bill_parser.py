"""Parse common Chinese bank, Alipay and WeChat CSV/XLSX exports without dependencies."""
from __future__ import annotations

import csv
import io
import re
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

MAX_BYTES = 5 * 1024 * 1024
HEADERS = {
    "date": ("交易时间", "交易创建时间", "交易日期", "时间", "日期", "入账时间"),
    "amount": ("金额(元)", "交易金额", "金额", "收/支金额", "交易金额(元)", "订单金额(元)"),
    "direction": ("收/支", "收支类型", "交易类型", "收支", "资金方向"),
    "name": ("商品说明", "交易对方", "商品名称", "交易名称", "交易摘要", "备注", "说明"),
    "status": ("当前状态", "交易状态", "状态"),
    "id": ("交易单号", "交易订单号", "交易流水号", "流水号", "商户订单号"),
}


def _csv_rows(data: bytes):
    encodings = ("utf-16", "utf-8-sig", "gb18030") if data.startswith((b"\xff\xfe", b"\xfe\xff")) else ("utf-8-sig", "gb18030", "utf-16")
    for enc in encodings:
        try:
            text = data.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        raise ValueError("账单编码无法识别，请导出 UTF-8 CSV")
    sample = text[:4096]
    delimiter = "\t" if sample.count("\t") > sample.count(",") else ","
    return list(csv.reader(io.StringIO(text), delimiter=delimiter))


def _xlsx_rows(data: bytes):
    ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        if len(z.namelist()) > 2000 or sum(i.file_size for i in z.infolist()) > 40 * 1024 * 1024:
            raise ValueError("账单文件过大")
        strings = []
        if "xl/sharedStrings.xml" in z.namelist():
            root = ET.fromstring(z.read("xl/sharedStrings.xml"))
            strings = ["".join(t.text or "" for t in si.iter(ns + "t")) for si in root.iter(ns + "si")]
        sheet = next((n for n in z.namelist() if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n)), None)
        if not sheet:
            raise ValueError("工作簿没有可读取的工作表")
        root = ET.fromstring(z.read(sheet))
        rows = []
        for row in root.iter(ns + "row"):
            cells = {}
            for cell in row.iter(ns + "c"):
                ref = cell.get("r", "A1")
                letters = re.match(r"[A-Z]+", ref).group(0)
                col = 0
                for ch in letters:
                    col = col * 26 + ord(ch) - 64
                raw = cell.find(ns + "v")
                inline = cell.find(ns + "is")
                value = raw.text if raw is not None else "".join(t.text or "" for t in inline.iter(ns + "t")) if inline is not None else ""
                if cell.get("t") == "s" and value:
                    value = strings[int(value)]
                cells[col - 1] = value or ""
            if cells:
                rows.append([cells.get(i, "") for i in range(max(cells) + 1)])
        return rows


def _col(header, names):
    normalized = [re.sub(r"\s+", "", str(x)).replace("（", "(").replace("）", ")") for x in header]
    for name in names:
        if name in normalized:
            return normalized.index(name)
    return None


def _date(raw):
    text = str(raw).strip()
    if re.fullmatch(r"\d+(?:\.\d+)?", text):
        return (datetime(1899, 12, 30) + timedelta(days=float(text))).strftime("%Y-%m-%d")
    match = re.search(r"(20\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})", text)
    if not match:
        raise ValueError("日期无法识别")
    return datetime(*map(int, match.groups())).strftime("%Y-%m-%d")


def category_for(name):
    rules = (
        ("餐饮", "餐|饭|食|外卖|奶茶|咖啡|超市|便利店"),
        ("交通", "地铁|公交|打车|滴滴|高铁|火车|机票|加油|停车"),
        ("购物", "购物|淘宝|京东|拼多多|商场|服饰|数码"),
        ("学习", "书|学费|课程|培训|考试|文具"),
        ("居住", "房租|物业|水费|电费|燃气|宽带"),
        ("娱乐", "电影|游戏|音乐|会员|旅游"),
        ("医疗", "医院|药|挂号|诊所"),
    )
    return next((cat for cat, pat in rules if re.search(pat, name, re.I)), "其他")


def parse_bill(filename: str, data: bytes):
    if not data or len(data) > MAX_BYTES:
        raise ValueError("请选择不超过 5 MB 的账单文件")
    lower = filename.lower()
    if lower.endswith((".csv", ".tsv")):
        rows = _csv_rows(data)
    elif lower.endswith(".xlsx"):
        try:rows = _xlsx_rows(data)
        except (zipfile.BadZipFile,ET.ParseError,IndexError,KeyError):
            raise ValueError('账单文件损坏或格式不正确，请重新导出 CSV / XLSX') from None
    else:
        raise ValueError("仅支持 CSV、TSV 或 XLSX 账单")
    header_at = columns = None
    for i, row in enumerate(rows[:40]):
        found = {key: _col(row, names) for key, names in HEADERS.items()}
        if found["date"] is not None and found["amount"] is not None:
            header_at, columns = i, found
            break
    if columns is None:
        raise ValueError("未找到日期和金额列，请使用银行、支付宝或微信的明细账单")
    result = []
    skipped = 0
    for row in rows[header_at + 1:]:
        if not any(str(v).strip() for v in row):
            continue
        get = lambda key: str(row[columns[key]]).strip() if columns[key] is not None and columns[key] < len(row) else ""
        try:
            date = _date(get("date"))
            raw_amount = get("amount").replace(",", "").replace("¥", "").replace("￥", "").strip()
            value=abs(Decimal(raw_amount))
            if not value.is_finite() or value>1_000_000_000:raise ValueError('金额无效')
            amount = float(value.quantize(Decimal('0.01'),rounding=ROUND_HALF_UP))
            if not amount:
                raise ValueError("零金额")
            status = get("status")
            if any(x in status for x in ("失败", "关闭", "退款中", "撤销")):
                skipped += 1
                continue
            direction = get("direction")
            if "不计收支" in direction:
                skipped += 1
                continue
            kind = "income" if ("收入" in direction or "入账" in direction or raw_amount.startswith("+")) else "expense"
            if "退款" in direction or "退款" in get("name"):
                kind = "income"
            title = get("name") or "未命名交易"
            result.append({"date": date, "occurredAt": get("date")[:40],
                           "amount": amount, "kind": kind, "sourceId": get("id")[:100],
                           "title": title[:120], "category": "收入" if kind == "income" else category_for(title)})
        except (ValueError, OverflowError, InvalidOperation):
            skipped += 1
    if not result:
        raise ValueError("没有识别到有效交易，请检查账单格式")
    return {"rows": result[:5000], "skipped": skipped + max(0, len(result) - 5000)}
