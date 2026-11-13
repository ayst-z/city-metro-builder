# -*- coding: utf-8 -*-
"""
CoordinateTransform — 中国坐标系转换独立模块（可单独调用）
=========================================================
覆盖：WGS-84 ↔ GCJ-02 ↔ BD-09（OSM 用 WGS-84，高德用 GCJ-02，百度用 BD-09）

用法（命令行，终端可直接调用）：
  python coordinate_transform.py gcj2wgs 31.844 117.305
  python coordinate_transform.py wgs2gcj 31.84 117.28
  python coordinate_transform.py gcj2bd  31.84 117.28
  python coordinate_transform.py bd2gcj  31.85 117.30
  python coordinate_transform.py wgs2bd  31.84 117.28
  python coordinate_transform.py bd2wgs  31.85 117.30

作为模块导入：
  from coordinate_transform import gcj2wgs, wgs2gcj, gcj2bd, bd2gcj, wgs2bd, bd2wgs
"""
import math
import sys

PI = math.pi
a = 6378245.0
ee = 0.00669342162296594323


def out_of_china(lat, lng):
    return (lng < 72.004 or lng > 137.8347) or (lat < 0.8293 or lat > 55.8271)


def _tLat(x, y):
    ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(abs(x))
    ret += (20.0 * math.sin(6.0 * x * PI) + 20.0 * math.sin(2.0 * x * PI)) * 2.0 / 3.0
    ret += (20.0 * math.sin(y * PI) + 40.0 * math.sin(y / 3.0 * PI)) * 2.0 / 3.0
    ret += (160.0 * math.sin(y / 12.0 * PI) + 320 * math.sin(y * PI / 30.0)) * 2.0 / 3.0
    return ret


def _tLng(x, y):
    ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(abs(x))
    ret += (20.0 * math.sin(6.0 * x * PI) + 20.0 * math.sin(2.0 * x * PI)) * 2.0 / 3.0
    ret += (20.0 * math.sin(x * PI) + 40.0 * math.sin(x / 3.0 * PI)) * 2.0 / 3.0
    ret += (150.0 * math.sin(x / 12.0 * PI) + 300.0 * math.sin(x / 30.0 * PI)) * 2.0 / 3.0
    return ret


def wgs2gcj(lat, lng):
    """WGS-84 → GCJ-02"""
    if out_of_china(lat, lng):
        return lat, lng
    dLat = _tLat(lng - 105.0, lat - 35.0)
    dLng = _tLng(lng - 105.0, lat - 35.0)
    radLat = lat / 180.0 * PI
    magic = math.sin(radLat)
    magic = 1 - ee * magic * magic
    sqrtMagic = math.sqrt(magic)
    dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * PI)
    dLng = (dLng * 180.0) / (a / sqrtMagic * math.cos(radLat) * PI)
    return lat + dLat, lng + dLng


def gcj2wgs(lat, lng):
    """GCJ-02 → WGS-84（迭代逼近）"""
    if out_of_china(lat, lng):
        return lat, lng
    lat2, lng2 = lat, lng
    for _ in range(7):
        mg = wgs2gcj(lat2, lng2)
        lng2 -= (mg[1] - lng)
        lat2 -= (mg[0] - lat)
    return lat2, lng2


def gcj2bd(lat, lng):
    """GCJ-02 → BD-09"""
    x, y = lng, lat
    z = math.sqrt(x * x + y * y) + 0.00002 * math.sin(y * PI * 3000.0 / 180.0)
    theta = math.atan2(y, x) + 0.000003 * math.cos(x * PI * 3000.0 / 180.0)
    return z * math.sin(theta) + 0.006, z * math.cos(theta) + 0.0065


def bd2gcj(lat, lng):
    """BD-09 → GCJ-02"""
    x, y = lng - 0.0065, lat - 0.006
    z = math.sqrt(x * x + y * y) - 0.00002 * math.sin(y * PI * 3000.0 / 180.0)
    theta = math.atan2(y, x) - 0.000003 * math.cos(x * PI * 3000.0 / 180.0)
    return z * math.sin(theta), z * math.cos(theta)


def wgs2bd(lat, lng):
    """WGS-84 → BD-09"""
    glat, glng = wgs2gcj(lat, lng)
    return gcj2bd(glat, glng)


def bd2wgs(lat, lng):
    """BD-09 → WGS-84"""
    glat, glng = bd2gcj(lat, lng)
    return gcj2wgs(glat, glng)


_FUNCS = {'wgs2gcj': wgs2gcj, 'gcj2wgs': gcj2wgs, 'gcj2bd': gcj2bd, 'bd2gcj': bd2gcj, 'wgs2bd': wgs2bd, 'bd2wgs': bd2wgs}


def main():
    if len(sys.argv) < 4:
        print('用法: python coordinate_transform.py <method> <lat> <lng>')
        print('method: ' + ' | '.join(_FUNCS.keys()))
        sys.exit(1)
    method, lat, lng = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
    if method not in _FUNCS:
        print('未知方法: ' + method)
        sys.exit(1)
    rlat, rlng = _FUNCS[method](lat, lng)
    print('%s(%f, %f) -> lat=%f, lng=%f' % (method, lat, lng, rlat, rlng))


if __name__ == '__main__':
    main()

