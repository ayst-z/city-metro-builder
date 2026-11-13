# -*- coding: utf-8 -*-
"""
高德地铁数据获取脚本（本地运行，无 CORS 限制）
=================================================
用途：作为 skill 数据获取逻辑的一部分，抓取高德官方地铁数据供页面脚本解析。

数据源（按优先级）：
  1) srhdata 专题接口（默认，免费无需 key，一次返回全城已开通线路）
     https://map.amap.com/service/subway?srhdata=<adcode前4位>_drw_<城市拼音>.json
     → 解析后交给页面 `MT.parseAMapSubwayData(json, lineNo)` 得到站点+官方色
  2) v3/bus/line 接口（可选，需用户 API key，单线查询含完整站点顺序）
     https://restapi.amap.com/v3/bus/line?key=KEY&city=城市&name=地铁X号线
     → 解析后交给页面 `MT.queryLineByBusAPI` 的逻辑

用法：
  # 抓取某城市全部已开通线路（srhdata，推荐）
  python fetch_subway_data.py 常州
  python fetch_subway_data.py changzhou
  # 指定 adcode（前4位）与拼音（当城市名无法自动识别时）
  python fetch_subway_data.py --adcode 3204 --pinyin changzhou
  # 用 v3/bus/line 查单条线路（需 key）
  python fetch_subway_data.py 常州 --key YOUR_KEY --line 地铁6号线
  # 输出目录（默认脚本同目录 ../_subway_data/）
  python fetch_subway_data.py 常州 --out ../_subway_data/
"""

import sys
import os
import json
import argparse
import urllib.request

# 城市 → [adcode前4位, 拼音]（与工具箱 CITY_ADCODE 一致）
CITY_MAP = {
    '上海': ['3100', 'shanghai'], '苏州': ['3205', 'suzhou'], '无锡': ['3202', 'wuxi'],
    '常州': ['3204', 'changzhou'], '南京': ['3201', 'nanjing'], '扬州': ['3210', 'yangzhou'],
    '镇江': ['3211', 'zhenjiang'], '马鞍山': ['3405', 'maanshan'], '滁州': ['3411', 'chuzhou'],
    '泰州': ['3212', 'taizhou'], '芜湖': ['3402', 'wuhu'],
    '北京': ['1100', 'beijing'], '武汉': ['4201', 'wuhan'], '成都': ['5101', 'chengdu'],
    '深圳': ['4403', 'shenzhen'], '天津': ['1200', 'tianjin'], '杭州': ['3301', 'hangzhou'],
    '重庆': ['5000', 'chongqing'], '西安': ['6101', 'xian'], '广州': ['4401', 'guangzhou'],
    '佛山': ['4406', 'foshan'], '东莞': ['4419', 'dongguan'], '厦门': ['3502', 'xiamen'],
    '大连': ['2102', 'dalian'], '沈阳': ['2101', 'shenyang'], '青岛': ['3702', 'qingdao'],
    '郑州': ['4101', 'zhengzhou'], '南宁': ['4501', 'nanning'], '香港': ['8100', 'hongkong'],
    '澳门': ['8200', 'macau'],
}
# 拼音 → 中文（反向查找）
PINYIN_TO_CN = {v[1]: k for k, v in CITY_MAP.items()}


def resolve_city(name):
    """返回 (adcode前4位, 拼音, 中文名)。支持 中文/拼音/adcode。"""
    name = str(name).strip().lower()
    if name in CITY_MAP:
        ad, py = CITY_MAP[name]
        return ad, py, name
    if name in PINYIN_TO_CN:
        cn = PINYIN_TO_CN[name]
        return CITY_MAP[cn][0], name, cn
    # 尝试 adcode（前4位数字）
    if name.isdigit():
        for cn, (ad, py) in CITY_MAP.items():
            if ad == name[:4]:
                return ad, py, cn
    return None, None, name


def http_get_json(url, referer='https://map.amap.com/'):
    req = urllib.request.Request(url, headers={
        'Referer': referer,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    })
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode('utf-8'))


def fetch_subway_web(adcode, pinyin):
    """抓取高德地铁专题接口（已开通线路一次全量）。"""
    url = 'https://map.amap.com/service/subway?srhdata={}_drw_{}.json'.format(adcode, pinyin)
    return http_get_json(url)


def fetch_bus_line(city, line_name, key):
    """抓取 v3/bus/line 单线站点（需 API key）。"""
    url = ('https://restapi.amap.com/v3/bus/line?key={}&city={}&name={}&offset=50'
           .format(key, urllib.request.quote(city), urllib.request.quote(line_name)))
    return http_get_json(url, referer='https://www.amap.com/')


def main():
    ap = argparse.ArgumentParser(description='高德地铁数据获取')
    ap.add_argument('city', nargs='?', help='城市（中文/拼音/adcode）')
    ap.add_argument('--adcode', help='城市 adcode 前4位（如 3204）')
    ap.add_argument('--pinyin', help='城市拼音（如 changzhou）')
    ap.add_argument('--key', help='高德 Web API key（v3/bus/line 用）')
    ap.add_argument('--line', help='线路名（如 地铁6号线，配合 --key 查单线）')
    ap.add_argument('--out', default=None, help='输出目录')
    args = ap.parse_args()

    ad, py, cn = resolve_city(args.city or '')
    if args.adcode:
        ad = args.adcode
    if args.pinyin:
        py = args.pinyin
    if not ad or not py:
        print('ERR: 无法识别城市: {!r}（用 中文/拼音/adcode，或 --adcode --pinyin）'.format(args.city))
        sys.exit(1)

    out_dir = args.out or os.path.join(os.path.dirname(os.path.abspath(__file__)), '_subway_data')
    os.makedirs(out_dir, exist_ok=True)

    if args.key and args.line:
        # v3/bus/line 单线
        j = fetch_bus_line(cn, args.line, args.key)
        lines = j.get('buslines') or []
        path = os.path.join(out_dir, 'busline_{}_{}.json'.format(py, args.line))
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(j, f, ensure_ascii=False)
        print('OK v3/bus/line: {} 条线 → {}'.format(len(lines), path))
        for l in lines[:5]:
            stops = l.get('busstops') or []
            print('  {}{} 站数={} 起讫={}→{}'.format(l.get('name'), ' (地铁)' if '地铁' in (l.get('name') or '') else '', len(stops), l.get('start_stop'), l.get('end_stop')))
        return

    # srhdata 全量（默认）
    j = fetch_subway_web(ad, py)
    lines = j.get('l') or []
    path = os.path.join(out_dir, 'subway_{}.json'.format(py))
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(j, f, ensure_ascii=False)
    print('OK srhdata: {}（adcode={}）共 {} 条已开通线 → {}'.format(j.get('s'), j.get('i'), len(lines), path))
    for l in lines:
        stops = l.get('st') or []
        print('  {} {} color={} 站数={}'.format(l.get('ln'), l.get('kn'), l.get('cl'), len(stops)))
    print('TIP: 在页面里用 MT.parseAMapSubwayData(JSON字符串或对象, "线号") 解析站点')


if __name__ == '__main__':
    main()

