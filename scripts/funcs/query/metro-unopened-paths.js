/**
 * MT 未开通线走向固化工具（3.1）
 * =============================================================
 * 用途: 在高德地图已加载 transit 瓦片（poi_region_road_transit）的页面注入，
 *       自动抓取目标区域瓦片 → 解码未开通/在建线走向几何 → 返回可固化数据。
 * 注入: window.__metroUnopenedPaths
 * 依赖: mt-core / mt-node / mt-data / mt-index / mt-amap（需先注入，用 MT.parsePoiTileForLines）
 *
 * 用法（浏览器控制台 / playwright evaluate）:
 *   window.__metroUnopenedPaths.tileTemplate()   // 从已加载瓦片提取 URL 模板（含 auth_key）
 *   var res = await window.__metroUnopenedPaths.capture(bbox, {z}) // 抓区域瓦片 → 走向
 *   // res: [{name, isUnopened, path:[[lng,lat],...]}, ...]
 *
 * 固化: 把 res 中 isUnopened 的线路写入 mt-data.js 对应城市线路：
 *   { ln:'21号线', kn:'...', status:'unopened', ed:'端点A - 端点B',
 *     st:[{n:站名, sl:'lng,lat'}, ...],   // 可选：走向 path 投影的站坐标
 *     path:[[lng,lat],...] }               // 走向节点（最高精度，_queryLineLocal 优先使用）
 *
 * 前提: 页面必须先加载过 transit 瓦片（否则无 auth_key 模板）。若未加载，
 *       可先在地图上漫游到线路区域（地铁图层会请求对应瓦片）再运行。
 */
(function () {
  'use strict';
  if (window.__metroUnopenedPaths) return { installed: true, version: window.__metroUnopenedPaths.__version };
  var MT = window.__metroToolkit;
  if (!MT || !MT.parsePoiTileForLines) return { installed: false, error: 'need MT (mt-amap.js) first' };

  // 从已加载瓦片提取 URL 前缀模板（保留 /pbf/ 及 query，去掉具体 x_y_n）
  //   例: https://jsapi-data3.amap.com/tile/26_07_27_00/v2/poi_region_road_transit/pbf/4/1_2_3?auth_key=...
  //    →  base=https://.../pbf/ , n 由实际瓦片解析
  function tileTemplate() {
    var res = performance.getEntriesByType('resource');
    var u = null;
    for (var i = 0; i < res.length; i++) {
      if (/poi_region_road_transit\/pbf\//.test(res[i].name)) { u = res[i].name; break; }
    }
    if (!u) return null;
    var base = u.replace(/\/pbf\/\d+\/\d+_\d+_\d+/, '/pbf/');
    return { base: base, sample: u };
  }

  // 瓦片编号解析：从 sample URL 提取 z/x_y_n
  function parseSample(sample) {
    var m = sample && sample.match(/\/pbf\/(\d+)\/(\d+)_(\d+)_(\d+)/);
    if (!m) return null;
    return { z: +m[1], x: +m[2], y: +m[3], n: +m[4] };
  }

  // 经纬度 → 瓦片坐标（等距圆柱 Plate Carrée，与 decodeTileGeom 逆运算）
  //   lng=(x+xi/4096)*360/2^n-180 → x=(lng+180)/360*2^n
  //   lat=90-(y+yi/4096)*180/2^n  → y=(90-lat)/180*2^n
  function lngLatToTile(lng, lat, n) {
    var scale = 1 << n;
    var fx = (lng + 180) / 360 * scale;
    var fy = (90 - lat) / 180 * scale;
    return { x: Math.floor(fx), y: Math.floor(fy) };
  }

  // 核心抓取：给定 bbox [lngMin,lngMax,latMin,latMax] 与 n，抓覆盖瓦片 → 解码走向
  //   opts: { z?, n? }  z=瓦片层级（默认用已加载瓦片的 z），n 默认取已加载瓦片 n
  //   返回: { ok, z, n, tiles, lines:[{name, isUnopened, path}, ...] }（按线路名去重）
  async function capture(bbox, opts) {
    opts = opts || {};
    var tmpl = tileTemplate();
    if (!tmpl) return { ok: false, error: 'no transit tile loaded; 请先在地图上漫游到线路区域加载瓦片' };
    var smp = parseSample(tmpl.sample);
    var n = opts.n || (smp && smp.n) || 3;
    var z = opts.z || (smp && smp.z) || 4;
    // base 形如 https://.../pbf/?auth_key=...（去掉 sample 中具体 /z/x_y_n）
    var base = tmpl.base;
    var scale = 1 << n;
    var x0 = Math.floor((bbox[0] + 180) / 360 * scale);
    var x1 = Math.floor((bbox[1] + 180) / 360 * scale);
    var y0 = Math.floor((90 - bbox[3]) / 180 * scale);
    var y1 = Math.floor((90 - bbox[2]) / 180 * scale);
    var seen = {}, out = [];
    for (var x = x0; x <= x1; x++) {
      for (var y = y0; y <= y1; y++) {
        // 在 /pbf/ 后插入 /z/x_y_n（保留原有 query 如 auth_key）
        var realUrl = base.replace('/pbf/', '/pbf/' + z + '/' + x + '_' + y + '_' + n);
        try {
          var resp = await fetch(realUrl, { credentials: 'include' });
          if (!resp.ok) continue;
          var buf = await resp.arrayBuffer();
          var lines = await MT.parsePoiTileForLines(buf, x, y, n);
          if (Array.isArray(lines)) {
            lines.forEach(function (ln) {
              if (!ln || !ln.name || seen[ln.name]) return;
              seen[ln.name] = true;
              out.push(ln);
            });
          }
        } catch (e) { /* 单瓦片失败跳过 */ }
      }
    }
    return { ok: true, z: z, n: n, tiles: (x1 - x0 + 1) * (y1 - y0 + 1), lines: out };
  }

  // 清洗未开通线站点（用 MT._normStopName）——仅当需要从 path 反推站点时提示
  window.__metroUnopenedPaths = {
    __version: '1.0',
    tileTemplate: tileTemplate,
    parseSample: parseSample,
    lngLatToTile: lngLatToTile,
    capture: capture
  };
  return { installed: true, version: '1.0' };
})();
