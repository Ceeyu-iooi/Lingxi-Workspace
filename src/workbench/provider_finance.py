from decimal import Decimal, InvalidOperation
import re

from workbench.provider_usage import integer, timestamp, normalize_history


def amount(value):
    if value is None or isinstance(value, bool):return None
    try:
        result = Decimal(str(value))
        if not result.is_finite() or result < 0:raise InvalidOperation()
        return result
    except (InvalidOperation, ValueError):raise ValueError('费用数值不正确') from None


def deepseek_costs(data, tracking):
    if not isinstance(data, dict) or str(data.get('biz_code')) != '0':raise ValueError('费用查询失败')
    raw = data.get('biz_data') or {}
    if not isinstance(raw.get('data'), list):raise ValueError('费用响应格式不正确')
    costs = {};matched = False
    for currency in raw['data']:
        if currency.get('currency') != 'CNY':continue
        for series in currency.get('series', []):
            if (series.get('api_key') or {}).get('tracking_id') != tracking:continue
            matched = True
            for bucket in series.get('buckets', []):
                key = (series.get('model'), bucket.get('time'))
                value = amount(bucket.get('cost'))
                if value is None or key in costs:raise ValueError('费用时间记录不正确')
                costs[key] = value
    if not matched:raise ValueError('未返回该 Key 的人民币费用')
    return costs


def glm_bills(bills, connection, key):
    groups = {}
    for bill in bills:
        if bill.get('apiKey') not in (key, key.split('.')[0]):continue
        if bill.get('usageUnit') != 'token':continue
        match = re.search(r'【([^】]+)】', str(bill.get('modelProductName', '')))
        if not match:raise ValueError('账单未返回模型名称')
        model = match.group(1);at = timestamp(bill.get('billingDate'))
        if not at:raise ValueError('账单日期不正确')
        total = integer(bill.get('usageCount'))
        kind = bill.get('tokenType')
        if total is None or kind not in ('输入', '输出', '缓存命中'):raise ValueError('账单 Token 类型或数值不正确')
        cost = amount(bill.get('settlementAmount')) if bill.get('currency') == 'CNY' else None
        group = groups.setdefault((at, model), {'input':0, 'output':0, 'cached':0, 'cost':Decimal(0), 'priced':True})
        group['output' if kind == '输出' else 'input'] += total
        if kind == '缓存命中':group['cached'] += total
        group['priced'] &= cost is not None
        if cost is not None:group['cost'] += cost
    records = [{'at':at, 'model':model, 'input':g['input'], 'output':g['output'], 'cached':g['cached'],
                'total':g['input']+g['output'], 'cost':float(g['cost']) if g['priced'] else None, 'currency':'CNY'}
               for (at,model),g in groups.items()]
    rows = normalize_history(records, connection)
    for row in rows:row['provider'] = 'GLM'
    return rows
