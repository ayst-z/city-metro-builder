/* ============================================================================
 * CoordinateTransform — 中国坐标系转换独立模块（2026-08-18）
 * ----------------------------------------------------------------------------
 * 用途：独立、可单独调用的坐标转换工具。覆盖中国常用坐标系：
 *   - WGS-84（GPS/OSM 标准）
 *   - GCJ-02（高德/腾讯/国内地图加密）
 *   - BD-09（百度）
 * OSM 模式游戏用 WGS-84；高德数据为 GCJ-02；百度数据为 BD-09。
 * 注入方式（页面）：page.addScriptTag({ path: '.../coordinate-transform.js' })
 * 注入后：window.__CoordTransform
 * 终端/Python 版：见同目录 coordinate_transform.py（命令行可单独调用）
 * ========================================================================== */
(function () {
  'use strict';
  if (window.__CoordTransform) return;

  var PI = Math.PI;
  var a = 6378245.0;                     // 长半轴
  var ee = 0.00669342162296594323;       // 偏心率平方

  function outOfChina(lat, lng) {
    return (lng < 72.004 || lng > 137.8347) || (lat < 0.8293 || lat > 55.8271);
  }
  function tLat(x, y) {
    var ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0;
    ret += (160.0 * Math.sin(y / 12.0 * PI) + 320 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0;
    return ret;
  }
  function tLng(x, y) {
    var ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0;
    ret += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0;
    return ret;
  }
  // WGS-84 → GCJ-02
  function wgs2gcj(lat, lng) {
    if (outOfChina(lat, lng)) return { lat: lat, lng: lng };
    var dLat = tLat(lng - 105.0, lat - 35.0);
    var dLng = tLng(lng - 105.0, lat - 35.0);
    var radLat = lat / 180.0 * PI;
    var magic = Math.sin(radLat);
    magic = 1 - ee * magic * magic;
    var sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * PI);
    dLng = (dLng * 180.0) / (a / sqrtMagic * Math.cos(radLat) * PI);
    return { lat: lat + dLat, lng: lng + dLng };
  }
  // GCJ-02 → WGS-84（迭代逼近）
  function gcj2wgs(lat, lng) {
    if (outOfChina(lat, lng)) return { lat: lat, lng: lng };
    var lat2 = lat, lng2 = lng;
    for (var i = 0; i < 7; i++) {
      var mg = wgs2gcj(lat2, lng2);
      lng2 -= (mg.lng - lng);
      lat2 -= (mg.lat - lat);
    }
    return { lat: lat2, lng: lng2 };
  }
  // GCJ-02 → BD-09
  function gcj2bd(lat, lng) {
    var x = lng, y = lat;
    var z = Math.sqrt(x * x + y * y) + 0.00002 * Math.sin(y * PI * 3000.0 / 180.0);
    var theta = Math.atan2(y, x) + 0.000003 * Math.cos(x * PI * 3000.0 / 180.0);
    var bdLng = z * Math.cos(theta) + 0.0065;
    var bdLat = z * Math.sin(theta) + 0.006;
    return { lat: bdLat, lng: bdLng };
  }
  // BD-09 → GCJ-02
  function bd2gcj(lat, lng) {
    var x = lng - 0.0065, y = lat - 0.006;
    var z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * PI * 3000.0 / 180.0);
    var theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * PI * 3000.0 / 180.0);
    var gcjLng = z * Math.cos(theta);
    var gcjLat = z * Math.sin(theta);
    return { lat: gcjLat, lng: gcjLng };
  }
  // WGS-84 → BD-09
  function wgs2bd(lat, lng) { var g = wgs2gcj(lat, lng); return gcj2bd(g.lat, g.lng); }
  // BD-09 → WGS-84
  function bd2wgs(lat, lng) { var g = bd2gcj(lat, lng); return gcj2wgs(g.lat, g.lng); }

  window.__CoordTransform = {
    version: '1.0.0',
    wgs2gcj: wgs2gcj,
    gcj2wgs: gcj2wgs,
    gcj2bd: gcj2bd,
    bd2gcj: bd2gcj,
    wgs2bd: wgs2bd,
    bd2wgs: bd2wgs
  };
})();

