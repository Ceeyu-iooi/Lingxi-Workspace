from datetime import date, datetime, timedelta, timezone


def date_range(days=30, period='', start_date='', end_date='', today=None,earliest=None):
    today=today or datetime.now(timezone(timedelta(hours=8))).date()
    end=today
    if period=='all':start=min(today,earliest or today)
    elif period=='today':start=today
    elif period=='yesterday':start=end=today-timedelta(days=1)
    elif period=='month':start=today.replace(day=1)
    elif period=='last-month':
        end=today.replace(day=1)-timedelta(days=1);start=end.replace(day=1)
    elif period=='year':start=today.replace(month=1,day=1)
    elif period=='recent-year':
        try:start=today.replace(year=today.year-1)+timedelta(days=1)
        except ValueError:start=today.replace(year=today.year-1,day=28)+timedelta(days=1)
    elif period=='custom' or start_date or end_date:
        try:start=date.fromisoformat(start_date);end=date.fromisoformat(end_date)
        except (TypeError,ValueError):raise ValueError('请选择起始和终止日期') from None
    elif period in ('','7','30','90','366'):
        span=int(period) if period else max(1,min(366,int(days)));start=end-timedelta(days=span-1)
    else:raise ValueError('时间范围不正确')
    if start>end:raise ValueError('起始日期不能晚于终止日期')
    if end>today:raise ValueError('终止日期不能晚于今天')
    if period!='all' and (end-start).days>=366:raise ValueError('时间范围最多 366 天')
    return start,end
