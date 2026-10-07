#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地通知解析引擎：从中文通知文本提取 主题/时间/地点。

纯标准库、离线可用。识别相对日期（今天/明天/后天/本周五/下周三）、
绝对日期（9月25日、2026-09-25、9.28日）、时间点（下午3点、15:30、晚上七点半、十点二十）、
地点（地点：… / 在东九楼A203 / 二教101 / 会议室 / 报告厅）。
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta
from html import unescape

WEEKDAYS = {"一": 0, "二": 1, "三": 2, "四": 3, "五": 4, "六": 5, "日": 6, "天": 6}
AMPM_ADD = {"下午": 12, "傍晚": 12, "晚上": 12, "夜里": 12}
CN_DIGIT = {"零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5,
            "六": 6, "七": 7, "八": 8, "九": 9}


def _strip_noise(text: str) -> str:
    return unescape(text or "").replace("\r", "").strip()


def _cn_to_num(s: str):
    """中文/阿拉伯数字转 int：支持 零一二两三...九、十、X十、X十Y（≤99）。"""
    if s is None or s == "":
        return None
    if re.fullmatch(r"\d{1,2}", s):
        return int(s)
    if len(s) == 1 and s in CN_DIGIT:
        return CN_DIGIT[s]
    if s == "十":
        return 10
    m = re.fullmatch(r"([一二两三四五六七八九])?十([一二三四五六七八九])?", s)
    if not m:
        return None
    tens = CN_DIGIT.get(m.group(1), 1) if m.group(1) else 1
    ones = CN_DIGIT.get(m.group(2), 0) if m.group(2) else 0
    return tens * 10 + ones


DATE_RE = re.compile(
    "(大后天|后天|明天|今天|今晚|明晚"
    "|[本这]?下+周[一二三四五六日天]|[本这]?周[一二三四五六日天]|[本这]?星期[一二三四五六日天]"
    "|(?:(\\d{4})年)?(\\d{1,2})月(\\d{1,2})[日号]?"
    "|\\d{4}-\\d{1,2}-\\d{1,2}"
    "|\\d{1,2}\\.\\d{1,2}[日号]?)")

TIME_RE = re.compile(
    "(早上|上午|中午|下午|傍晚|晚上|夜里)?\\s*"
    "(\\d{1,2}|[零一二两三四五六七八九十]{1,3})"
    "[:：点时]\\s*(半|三刻|(\\d{1,2}|[零一二三四五六七八九十]{1,3})分?)?")

LOC_PATTERNS = [
    re.compile("(?:地点|位置|场所|地址)[:：为]?\\s*([^\\n，。；,;]{2,30})"),
    re.compile("[在于]([^\\n，。；,;\\s]{0,10}?(?:楼|教室|会议室|实验室|报告厅|礼堂|场馆|馆|厅|广场|操场|中心)[A-Za-z0-9\\-]*)"),
    re.compile("([\\u4e00-\\u9fa5A-Za-z]{1,6}楼[A-Za-z0-9\\-]*|第?\\d+-?\\d*教室|[\\u4e00-\\u9fa5]{1,4}教\\d+|会议室[A-Za-z0-9]*|实验室[A-Za-z0-9]*|报告厅|图书馆[^，。\\n\\s]{0,8})"),
]
_LOC_TIME_NOISE = re.compile("[星期周早晚下午点分半]|\\d{1,2}[:：]")


def _relative_day(now: datetime, token: str):
    for prefix, days in (("大后天", 3), ("后天", 2), ("明天", 1), ("今天", 0), ("今晚", 0), ("明晚", 1)):
        if token.startswith(prefix):
            return (now + timedelta(days=days)).replace(hour=0, minute=0, second=0, microsecond=0)
    m = re.fullmatch("([本这]?((?:下)+)周|[本这]?周|星期)([一二三四五六日天])", token)
    if not m:
        return None
    target = WEEKDAYS[m.group(3)]
    delta = (target - now.weekday()) % 7 or 7
    if m.group(2):  # 下X周：再推整周
        delta += 7 * len(m.group(2))
    d = now + timedelta(days=delta)
    return d.replace(hour=0, minute=0, second=0, microsecond=0)


def _parse_date(now: datetime, text: str):
    """返回 (datetime, matched_text) 或 None。"""
    best = None
    for m in DATE_RE.finditer(text):
        token = m.group(0)
        try:
            if re.match("(大后天|后天|明天|今天|今晚|明晚|[本这]?下*周|[本这]?星期)", token):
                d = _relative_day(now, token)
            elif "月" in token:
                y = int(m.group(2)) if m.group(2) else now.year
                d = datetime(y, int(m.group(3)), int(m.group(4)))
                if not m.group(2) and d < now.replace(hour=0, minute=0):
                    d = d.replace(year=now.year + 1)  # 无年份且已过 → 明年
            elif "-" in token:
                y, mo, dd = (int(x) for x in token.split("-"))
                d = datetime(y, mo, dd)
            else:  # 9.25 / 9.25日
                mo, dd = (int(x) for x in token.rstrip("日号").split("."))
                d = datetime(now.year, mo, dd)
                if d < now.replace(hour=0, minute=0):
                    d = d.replace(year=now.year + 1)
        except ValueError:
            continue
        if d is not None:
            best = (d, token)
    return best


def _parse_time(text: str):
    """返回 (hour, minute, matched_text) 或 None。时间点必须带 点/时/冒号 标记。"""
    for m in TIME_RE.finditer(text):
        ampm_word, hour_s, tail, minute_s = m.groups()
        hour = _cn_to_num(hour_s)
        if hour is None or not (0 <= hour <= 23):
            continue
        minute = 0
        if tail == "半":
            minute = 30
        elif tail == "三刻":
            minute = 45
        elif minute_s is not None:
            minute = _cn_to_num(minute_s) or 0
        if ampm_word in AMPM_ADD and hour < 12:
            hour += AMPM_ADD[ampm_word]
        elif ampm_word is None and hour < 12 and m.start() > 0 and text[m.start() - 1] in "晚夜":
            hour += 12  # "明晚10点"：晚上语境被日期词吃掉时看前字符
        if 0 <= hour <= 23 and 0 <= minute <= 59:
            return hour, minute, m.group(0).strip()
    return None


def _find_location(text: str):
    """按优先级分步匹配：地点: > 在/于 > 独立场馆词。返回 (loc, start, end)。"""
    for idx, pat in enumerate(LOC_PATTERNS):
        m = pat.search(text)
        if not m:
            continue
        loc = m.group(1).strip()
        if idx == 1:
            loc = re.sub("^[在于]", "", loc)
        start = m.start()
        if idx == 2 and start > 0 and text[start - 1] in "在于":
            start -= 1
        if idx == 0:
            return loc, start, m.end()
        if 1 <= len(loc) <= 30 and not _LOC_TIME_NOISE.search(loc):
            return loc, start, m.end()
    return None, None, None


_LEAD_RE = re.compile("^(?:【[^】]{0,14}】|\\([^()]{0,14}\\)|(通知|关于|温馨提示|请注意|重要|各位同学|同学们|全体同学|亲爱的?[^，。\\n:：]{1,10})[:：，,]?)+")
_TAIL_RE = re.compile("(的?通知|的?公告|[,，。]?请.{2,40}$|[，。]$)")
_VERB_RE = re.compile("^(?:关于|召开|举办|举行|开展|进行)+")


def parse_title(text: str) -> str:
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if not lines:
        return ""
    action_re = re.compile("(召开|举办|开展|举行|进行|提交|截止|答辩|考试|上课|会议|讲座|报告|培训|开会|交|报名|打卡|领取|体检|面试|答疑|作业|模考)")
    candidates = [ln for ln in lines if action_re.search(ln)] or lines
    line = max(candidates, key=len)[:160]
    for _ in range(2):
        line = _LEAD_RE.sub("", line).strip()
        line = _TAIL_RE.sub("", line).strip()
    # 行内日期/时间/地点跨度一次性收集后从后往前删除，避免循环啃食
    spans = []
    m = DATE_RE.search(line)
    if m:
        spans.append((m.start(), m.end()))
    tm = TIME_RE.search(line)
    if tm:
        spans.append((tm.start(), tm.end()))
    _, ls, le = _find_location(line)
    if ls is not None:
        spans.append((ls, le))
    for s, e in sorted(set(spans), reverse=True):
        line = (line[:s] + line[e:]).strip()
    line = line.strip("，。、；：,.;： ")
    line = _VERB_RE.sub("", line).strip()
    line = re.sub("^[，。、；：,.-]+\\s*", "", line).strip()
    return line[:60] or lines[0][:40]


def parse_notification(text: str, now: datetime | None = None) -> dict:
    now = now or datetime.now()
    text = _strip_noise(text)
    date_info = _parse_date(now, text)
    time_info = _parse_time(text)
    due_at = due_text = None
    if date_info:
        d, date_token = date_info
        due_text = date_token
        if time_info:
            hour, minute, time_token = time_info
            due_at = d.replace(hour=hour, minute=minute).isoformat(timespec="minutes")
            due_text += time_token
        else:
            due_at = d.isoformat(timespec="minutes")
    elif time_info:
        hour, minute, time_token = time_info
        d = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if d < now:
            d += timedelta(days=1)
        due_at = d.isoformat(timespec="minutes")
        due_text = time_token
    location, _, _ = _find_location(text)
    title = parse_title(text)
    keywords = []
    for word in re.split(r"[\s，。、：:；;（）()【】]+", title):
        word = word.strip()
        if 2 <= len(word) <= 12 and word not in keywords:
            keywords.append(word)
    for word in re.findall(r"提交|报名|答疑|考试|会议|讲座|作业|面试|实验|报告|复习|项目", text):
        if word not in keywords:
            keywords.append(word)
    return {
        "title": title,
        "dueAt": due_at,
        "dueText": due_text,
        "location": location,
        "keywords": keywords[:5],
    }


if __name__ == "__main__":
    samples = [
        "通知：关于召开2026届毕业生就业推进会的通知\n时间：9月25日下午3点\n地点：主楼302会议室\n请全体毕业班同学准时参加。",
        "明天晚上七点半在东九楼A203 进行数电期中答疑，请大家带上习题册。",
        "高数作业9.28日晚23:59截止，交到学习委员处。",
        "【讲座】周三下午2点 于图书馆报告厅举办AI前沿讲座",
        "各位同学：请于本周五前将开题报告提交至教务系统。",
        "今天下午3点，二教101，考研英语模考。",
        "温馨提示：明晚10点在西校区体育馆领取参赛物资。",
    ]
    for s in samples:
        print(parse_notification(s), "\n")
