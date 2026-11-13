/**
 * MT 查询工具箱 · core（3.0）
 * ─────────────────────────────────────────────────────────────
 * 注入: window.__metroToolkit（与 mt-amap / mt-node 共享同一对象）
 * 职责: 配置常量（WEB_KEY/CITY_ALIASES/LOCAL_PALETTE/CITY_BOUNDS/LINE_SPECS/LINE_ENDPOINTS）
 *       + 基础工具（log/withTimeout/withFallback/ensureAmap/extractLngLat/webKey/webApiReady）
 *       + 城市/配色/线号/车型解析（resolveCityKey/officialColors/extractLineNo/matchOfficial/lineSpec/endpointsOf/distM）
 *       + 坐标校验（inCityBounds/segInCity/verifyMetroPOI/verifyTramPOI）
 *       + 坐标系统换算（wgs84ToGcj02/gcj02ToWgs84/outOfChina/isWgsNativeCity/coordToGameNative，2026-08-22 新增）
 * 依赖: 无（本文件是拆分链最底层，被 mt-amap / mt-node 经 MT.* 引用）
 * 加载顺序: 必须先于 mt-amap / mt-node 注入
 * 公开 API（导出到 window.__metroToolkit）:
 *   log / resolveCityKey / inCityBounds / extractLngLat / segInCity / verifyMetroPOI / verifyTramPOI /
 *   withTimeout / ensureAmap / webApiReady / webKey / withFallback / officialColors / extractLineNo /
 *   matchOfficial / lineSpec / endpointsOf / _distM / CITY_ALIASES / CITY_BOUNDS /
 *   wgs84ToGcj02 / gcj02ToWgs84 / outOfChina / isWgsNativeCity / coordToGameNative
 */
(function () {
  'use strict';
  var MT = window.__metroToolkit = window.__metroToolkit || {};
  if (MT.__coreVersion === '6.5.3') return; // 版本守卫：拆分基座已注入

  // ===== 配置常量 =====
  // 高德免费 Web API key（注册自 lbs.amap.com，免费个人 key）。
  //   - 可经 window.__MT_AMAP_WEB_KEY 覆盖，或运行时 MT.webKey(k) 设置
  //   - 被 _freePlace / _freeTransfer 使用（经 MT.webKey() 读取）
  var WEB_KEY = window.__MT_AMAP_WEB_KEY || '';

  // 城市别名表（城市名→key 解析）。
  //   - 被 resolveCityKey 使用；供 mt-amap 的 queryLineStopsByPOI / queryLineByBusAPI 取城市名
  //   - key 为标准城市标识（shanghai/nanjing...），值为别名数组（含中文名/英文名/简称）
  var CITY_ALIASES = {
    shanghai: ['上海', '上海市', 'shanghai', '上海地铁'],
    beijing: ['北京', '北京市', 'beijing', '北京地铁'],
    suzhou: ['苏州', '苏州市', 'suzhou', '苏州轨道交通', '苏州地铁'],
    wuxi: ['无锡', '无锡市', 'wuxi', '无锡地铁'],
    changzhou: ['常州', '常州市', 'changzhou', '常州地铁', '常州轨道交通'],
    nanjing: ['南京', '南京市', 'nanjing', '南京地铁'],
    wuhan: ['武汉', '武汉市', 'wuhan', '武汉地铁'],
    chongqing: ['重庆', '重庆市', 'chongqing', '重庆轨道交通', '重庆地铁'],
    chengdu: ['成都', '成都市', 'chengdu', '成都地铁'],
    hangzhou: ['杭州', '杭州市', 'hangzhou', '杭州地铁'],
    shenzhen: ['深圳', '深圳市', 'shenzhen', '深圳地铁'],
    guangzhou: ['广州', '广州市', 'guangzhou', '广州地铁'],
    foshan: ['佛山', '佛山市', 'foshan', '佛山地铁'],
    dongguan: ['东莞', '东莞市', 'dongguan'],
    tianjin: ['天津', '天津市', 'tianjin', '天津地铁'],
    xiamen: ['厦门', '厦门市', 'xiamen', '厦门地铁'],
    dalian: ['大连', '大连市', 'dalian', '大连地铁'],
    shenyang: ['沈阳', '沈阳市', 'shenyang', '沈阳地铁'],
    qingdao: ['青岛', '青岛市', 'qingdao', '青岛地铁'],
    zhengzhou: ['郑州', '郑州市', 'zhengzhou', '郑州地铁'],
    nanning: ['南宁', '南宁市', 'nanning'],
    xian: ['西安', '西安市', 'xian', '西安地铁', "xi'an"],
    hongkong: ['香港', '香港特别行政区', 'hongkong', '港铁'],
    macau: ['澳门', '澳门特别行政区', 'macau', '澳门轻轨'],
    singapore: ['新加坡', 'singapore', '新加坡地铁']
  };

  // 本地兜底官方配色表（游戏内置库未收录的国内城市）。
  //   - 结构: { cityKey: [['X号线','HEX'], ...] }
  //   - 被 officialColors 在游戏内置库未收录时兜底使用
  var LOCAL_PALETTE = {
    changzhou: [
      ['1号线', 'E3002B'], ['2号线', '004098'], ['3号线', '00A9E0'], ['4号线', '00B2A9'],
      ['5号线', '00A651'], ['6号线', 'F08300'], ['7号线', '6F3198'], ['S1线', '8B5CF6'],
      ['K1线', 'F59E0B'], ['K2线', '8B5CF6']
    ]
  };

  // 城市坐标范围 [lngMin,lngMax,latMin,latMax] —— 过滤同名错配与跨城市同名线污染。
  //   - 被 inCityBounds / segInCity 使用
  //   - 无 bounds 的城市坐标校验会放行（不误杀）
  var CITY_BOUNDS = {
    shanghai: [120.7, 122.2, 30.5, 32.0], suzhou: [119.4, 121.0, 30.8, 31.9],
    wuxi: [119.6, 120.9, 31.1, 32.0], changzhou: [119.3, 120.5, 31.2, 32.2],
    nanjing: [118.3, 119.4, 31.1, 32.5], yangzhou: [119.0, 119.9, 32.0, 32.8],
    zhenjiang: [119.0, 119.9, 31.8, 32.4], maanshan: [118.0, 118.9, 31.2, 31.9],
    chuzhou: [117.8, 118.9, 32.0, 32.8], taizhou: [119.7, 120.6, 32.0, 33.2], wuhu: [118.0, 118.9, 30.8, 31.6],
    beijing: [115.4, 117.5, 39.4, 41.1], wuhan: [113.9, 115.0, 30.0, 31.3], chengdu: [103.7, 104.6, 30.3, 31.2],
    shenzhen: [113.6, 114.8, 22.3, 23.0], tianjin: [116.7, 118.1, 38.7, 40.4], hangzhou: [119.5, 120.8, 29.8, 30.8],
    chongqing: [106.2, 107.0, 29.2, 30.3], xian: [108.5, 109.3, 34.0, 34.6], guangzhou: [112.9, 113.9, 22.7, 23.6],
    foshan: [112.8, 113.4, 22.8, 23.4], dongguan: [113.4, 114.4, 22.7, 23.3], xiamen: [117.9, 118.4, 24.3, 24.7],
    dalian: [121.2, 122.1, 38.6, 39.3], shenyang: [123.0, 123.8, 41.5, 42.1], qingdao: [120.0, 120.8, 35.8, 36.5],
    zhengzhou: [113.3, 114.0, 34.5, 35.0], nanning: [108.0, 108.7, 22.6, 23.1], hongkong: [113.8, 114.5, 22.1, 22.6],
    macau: [113.5, 113.6, 22.1, 22.3], singapore: [103.6, 104.1, 1.15, 1.5]
  };

  // 车型配置（真实运营规格；未收录返回默认）。
  //   - 结构: { cityKey: { 线号: {trainType, trainCars, maxSpeedKmh} } }
  //   - 被 lineSpec 使用；仅收录上海/南京/苏州，其余城市返回默认 B/6/80
  var LINE_SPECS = {
    shanghai: {
      '6': { trainType: 'C', trainCars: 4, maxSpeedKmh: 80 },
      '17': { trainType: 'A', trainCars: 6, maxSpeedKmh: 100 },
      '14': { trainType: 'A', trainCars: 6, maxSpeedKmh: 80 },
      '1': { trainType: 'A', trainCars: 8, maxSpeedKmh: 80 },
      '2': { trainType: 'A', trainCars: 8, maxSpeedKmh: 80 },
      '10': { trainType: 'A', trainCars: 6, maxSpeedKmh: 80 },
      '11': { trainType: 'A', trainCars: 6, maxSpeedKmh: 100 },
      '15': { trainType: 'A', trainCars: 6, maxSpeedKmh: 80 },
      '18': { trainType: 'A', trainCars: 6, maxSpeedKmh: 80 },
      '4': { trainType: 'A', trainCars: 6, maxSpeedKmh: 80 },
      // 非传统地铁（2026-08-22）：磁悬浮/机场联络线/浦江线（无"X号线"命名，单独收录）
      '磁悬浮': { trainType: 'A', trainCars: 1, maxSpeedKmh: 430 },
      '机场联络线': { trainType: 'C', trainCars: 4, maxSpeedKmh: 160 },
      '浦江线': { trainType: 'C', trainCars: 4, maxSpeedKmh: 80 }
    },
    nanjing: { '1': { trainType: 'A', trainCars: 6, maxSpeedKmh: 80 }, 'S1': { trainType: 'B', trainCars: 6, maxSpeedKmh: 100 } },
    suzhou: { '1': { trainType: 'B', trainCars: 5, maxSpeedKmh: 80 }, '2': { trainType: 'B', trainCars: 5, maxSpeedKmh: 80 } }
  };

  // 已知线路端点表（自动查询用；可扩展）。
  //   - 结构: { cityKey: { 线号: {from, to} } }，仅收录需要自动查询首末站的线路
  //   - 被 endpointsOf 使用；queryLine 用其作为自动查询的起讫点
  //   - ⚠️ 2026-09-06 扩展：覆盖多城市主城线（原仅上海）。端点 = 各线当前官方首末站（北/西/上端在前）。
  //     非本表城市/线路由 queryLine 端点自动解析兜底（注入 srhdata 官方站表首末 / 自动 fetch srhdata）。
  var LINE_ENDPOINTS = {
    shanghai: {
      '14': { from: '封浜', to: '桂桥路' },
      '1': { from: '莘庄', to: '富锦路' },
      '2': { from: '浦东1号2号航站楼', to: '蟠祥路·国家会计学院' },
      '3': { from: '上海南站', to: '江杨北路' },
      '4': { from: '宜山路', to: '世纪大道' },
      '5': { from: '莘庄', to: '闵行开发区' },
      '6': { from: '港城路', to: '东方体育中心' },
      '7': { from: '美兰湖', to: '花木路' },
      '8': { from: '市光路', to: '沈杜公路' },
      '9': { from: '曹路', to: '上海松江站' },
      '10': { from: '虹桥火车站', to: '基隆路' },
      '11': { from: '嘉定北', to: '迪士尼' },
      '12': { from: '七莘路', to: '金海路' },
      '13': { from: '金运路', to: '张江路' },
      '15': { from: '紫竹高新区', to: '顾村公园' },
      '16': { from: '龙阳路', to: '滴水湖' },
      '17': { from: '西岑', to: '虹桥火车站' },
      '18': { from: '航头', to: '长江南路' },
      '磁悬浮': { from: '龙阳路', to: '浦东国际机场' },
      '机场联络线': { from: '虹桥2号航站楼', to: '浦东1号2号航站楼' },
      '浦江线': { from: '汇臻路', to: '沈杜公路' }
    },
    // 南京（已开通主城 1/2/3/4 + S 线）。官方端点：北/西端在前。
    nanjing: {
      '1': { from: '八卦洲大桥南', to: '中国药科大学' },
      '2': { from: '鱼嘴', to: '经天路' },
      '3': { from: '林场', to: '秣周东路' },
      '4': { from: '龙江', to: '仙林湖' },
      'S1': { from: '南京南站', to: '空港新城江宁' },
      'S3': { from: '南京南站', to: '高家冲' },
      'S6': { from: '马群', to: '句容' },
      'S7': { from: '空港新城江宁', to: '无想山' },
      'S8': { from: '泰山新村', to: '金牛湖' },
      'S9': { from: '翔宇路南', to: '高淳' }
    },
    // 苏州（1-8 主线官方端点）
    suzhou: {
      '1': { from: '木渎', to: '钟南街' },
      '2': { from: '骑河', to: '桑田岛' },
      '3': { from: '苏州新区火车站', to: '唯亭' },
      '4': { from: '龙道浜', to: '同里' },
      '5': { from: '太湖香山', to: '阳澄湖南' },
      '6': { from: '苏州新区火车站', to: '新庆路' },
      '7': { from: '常楼', to: '木里' },
      '8': { from: '西津桥', to: '车坊' }
    },
    // 无锡（1-4 主线）
    wuxi: {
      '1': { from: '堰桥', to: '南方泉' },
      '2': { from: '梅园开原寺', to: '无锡东站' },
      '3': { from: '苏庙', to: '硕放机场' },
      '4': { from: '刘潭', to: '博览中心' }
    },
    // 常州（1-2）
    changzhou: {
      '1': { from: '森林公园', to: '南夏墅' },
      '2': { from: '青枫公园', to: '五一路' }
    },
    // 北京（主城线；2/10 为环线走 queryRingLine，无需端点）
    beijing: {
      '1': { from: '苹果园', to: '环球度假区' },
      '4': { from: '安河桥北', to: '天宫院' },
      '5': { from: '天通苑北', to: '宋家庄' },
      '6': { from: '金安桥', to: '潞城' },
      '8': { from: '朱辛庄', to: '瀛海' },
      '9': { from: '国家图书馆', to: '郭公庄' },
      '13': { from: '西直门', to: '东直门' }
    },
    // 广州（1-8 主线）
    guangzhou: {
      '1': { from: '广州东站', to: '西朗' },
      '2': { from: '嘉禾望岗', to: '广州南站' },
      '3': { from: '机场北', to: '海傍' },
      '4': { from: '黄村', to: '南沙客运港' },
      '5': { from: '滘口', to: '黄埔新港' },
      '6': { from: '浔峰岗', to: '香雪' },
      '7': { from: '美的大道', to: '燕山' },
      '8': { from: '滘心', to: '万胜围' }
    },
    // 深圳（1-6 主线）
    shenzhen: {
      '1': { from: '罗湖', to: '机场东' },
      '2': { from: '赤湾', to: '莲塘' },
      '3': { from: '福保', to: '双龙' },
      '4': { from: '福田口岸', to: '牛湖' },
      '5': { from: '赤湾', to: '黄贝岭' },
      '6': { from: '科学馆', to: '松岗' }
    },
    // 成都（1-3 主线）
    chengdu: {
      '1': { from: '韦家碾', to: '科学城' },
      '2': { from: '犀浦', to: '龙泉驿' },
      '3': { from: '成都医学院', to: '双流西站' }
    },
    // 武汉（1-4）
    wuhan: {
      '1': { from: '径河', to: '汉口北' },
      '2': { from: '天河机场', to: '佛祖岭' },
      '3': { from: '宏图大道', to: '沌阳大道' },
      '4': { from: '柏林', to: '武汉火车站' }
    },
    // 杭州（1-3）
    hangzhou: {
      '1': { from: '湘湖', to: '萧山国际机场' },
      '2': { from: '良渚', to: '朝阳' },
      '3': { from: '吴山前村', to: '星桥' }
    },
    // 重庆（1-3）
    chongqing: {
      '1': { from: '尖顶坡', to: '朝天门' },
      '2': { from: '鱼洞', to: '较场口' },
      '3': { from: '鱼洞', to: '江北机场T2航站楼' }
    },
    // 西安（1-2）
    xian: {
      '1': { from: '纺织城', to: '咸阳西站' },
      '2': { from: '草滩', to: '韦曲南' }
    },
    // 郑州（1-2）
    zhengzhou: {
      '1': { from: '河南工业大学', to: '河南大学新区' },
      '2': { from: '贾河', to: '南四环' }
    },
    // 天津（1-3）
    tianjin: {
      '1': { from: '刘园', to: '东沽路' },
      '2': { from: '曹庄', to: '滨海国际机场' },
      '3': { from: '小淀', to: '天津南站' }
    }
  };

  // 已知环线表（2026-08-23 新增）：queryLine 对环线须组装完整闭环，而非只返回相邻局部段。
  //   - 结构: { cityKey: [线号数组] }；被 MT.isRingLine 使用（queryLine 环线分支判定）
  //   - 注: 环线任两点间 queryTransferStops 只返回最短局部段（如上海4号线只回相邻2站），
  //         必须按官方站序逐段查询拼成完整闭环（见 mt-amap.queryRingLine）
  var RING_LINES = {
    shanghai: ['4'],
    beijing: ['2', '10'],
    chengdu: ['7'],
    zhengzhou: ['5'],
    guangzhou: ['11'],
    xian: ['8']
  };

  // 环线官方站序表（2026-08-23 新增）：环线完整闭环的官方站名顺序（首站→…→末站，末站回环首站闭合）。
  //   - 结构: { 'cityKey:线号': [站名数组] }；被 mt-amap.queryRingLine 用作环线站序（高精度，避免 POI 排序歧义）
  //   - 来源: 高德地铁专题 srhdata 官方站序（仅收录已确认环线，可扩展）
  var RING_STATIONS = {
    'shanghai:4': ['宜山路','虹桥路','延安西路','中山公园','金沙江路','曹杨路','镇坪路','中潭路','上海火车站','宝山路','海伦路','临平路','大连路','杨树浦路','浦东大道','世纪大道','向城路','蓝村路','塘桥','南浦大桥','西藏南路','鲁班路','大木桥路','东安路','上海体育场','上海体育馆']
  };

  // 环线判定（2026-08-23 新增）：该线是否环线（已知环线表命中）。供 queryLine 环线分支使用。
  //   - 调用方: mt-amap queryLine（环线完整闭环组装前置判断）
  //   - 签名: isRingLine(city, lineNo) → boolean
  function isRingLine(city, lineNo) {
    var k = resolveCityKey(city);
    if (!k) return false;
    var no = _normLineNo(lineNo);
    var rings = RING_LINES[k];
    return !!(rings && rings.indexOf(no) >= 0);
  }

  // ===== 基础工具 =====
  // 日志（3.0 优化）：多参数透传 + 开关（window.__MT_DEBUG === false 静默）。
  //   - 调用方: 各工具箱内部调试输出
  //   - 注意: 默认输出，生产可设 window.__MT_DEBUG=false 关闭
  function log() {
    try {
      if (window.__MT_DEBUG === false) return;
      var args = Array.prototype.slice.call(arguments);
      args.unshift('[MT]');
      console.log.apply(console, args);
    } catch (e) {}
  }

  // 超时包装：防高德 API 不回调导致 Promise 永久挂起（卡死）。超时 resolve fallback，调用方继续/重试。
  //   - 调用方: mt-amap 的 _gamePlace/_gameTransfer（8s/10s 超时）
  //   - 签名: withTimeout(promise, ms, fallback) → Promise<fallback|promise结果>
  //   - 注意: 高德 API 回调永不触发时，超时后返回 fallback 而非 reject，保证不挂死
  // 超时包装：给定 promise 在 ms 内未 resolve 则返回 fallback（防挂起）。
  //   - 调用方: ensureAmap（包装可能慢/卡死的异步操作）
  //   - 签名: withTimeout(promise, ms, fallback) → Promise
  //   - 注意: 内部 catch 吞掉原 promise 的拒绝（超时已触发或拒绝时均 resolve fallback），
  //           避免 unhandled rejection；调用方如需感知拒绝应自行给原 promise 加 catch
  function withTimeout(promise, ms, fallback) {
    return new Promise(function (resolve) {
      var done = false;
      var t = setTimeout(function () {
        if (!done) { done = true; resolve(fallback); }
      }, ms);
      promise.then(function (r) {
        if (!done) { done = true; clearTimeout(t); resolve(r); }
      }).catch(function () {
        if (!done) { done = true; clearTimeout(t); resolve(fallback); }
      });
    });
  }

  // 确保高德插件加载（如 AMap.PlaceSearch / AMap.Transfer），8s 超时防挂起。
  //   - 调用方: mt-amap 的 _gamePlace/_gameTransfer（查询前确保插件就绪）
  //   - 签名: ensureAmap(plugins?) → Promise<boolean>（true=就绪）
  //   - 注意: 页面无 window.AMap 时返回 false；插件异步加载完成后 resolve(true)
  function ensureAmap(plugins) {
    return withTimeout(new Promise(function (resolve) {
      if (!window.AMap || typeof window.AMap.plugin !== 'function') return resolve(false);
      if (plugins) {
        window.AMap.plugin(plugins, function () { resolve(true); });
      } else {
        resolve(true);
      }
    }), 8000, false);
  }

  // 免费 Web key 是否就绪。
  //   - 调用方: mt-amap 的 _freePlace/_freeTransfer（判断是否可用免费 API 兜底）
  //   - 返回: boolean（WEB_KEY 非空）
  function webApiReady() { return !!WEB_KEY; }

  // 设/读免费 Web key（设时同步 window.__MT_AMAP_WEB_KEY）。
  //   - 调用方: 外部配置 / mt-amap 的 _freePlace/_freeTransfer 读取
  //   - 签名: webKey(k?) → 当前 key；传 k 则设置后返回
  function webKey(k) {
    if (k !== undefined) { WEB_KEY = k || ''; window.__MT_AMAP_WEB_KEY = WEB_KEY; }
    return WEB_KEY;
  }

  // 通用"多次尝试后切换"包装：先游戏内（重试 N 次，默认 1），失败切免费 Web API 兜底。
  //   - 调用方: mt-amap 的 placeSearch(via=auto)/transferSearch(via=auto)/resolveCoord/queryTransferStops
  //   - 签名: withFallback(gameFn, freeFn, retries=1) → Promise<结果>
  //   - 逻辑链: gameFn 失败且重试耗尽 → freeFn；freeFn 也失败则返回 gameFn 最后结果
  //   - 注意: 若 gameFn 返回 {ok:true} 立即返回，不切 freeFn
  function withFallback(gameFn, freeFn, retries) {
    var n = (retries === 0) ? 0 : (retries || 1);
    function attempt(i) {
      return gameFn().then(function (r) {
        if (r && r.ok) return r;
        if (i < n) return attempt(i + 1);
        if (freeFn) return freeFn().then(function (fr) { if (fr && fr.ok) return fr; return r; });
        return r;
      });
    }
    return attempt(0);
  }

  // 坐标归一化：任意 loc（数组/AMap.LngLat/对象）→ [lng, lat]；无法解析返回 null。
  //   - 调用方: mt-amap 各查询（提取高德返回值坐标）/ 本文件 segInCity
  //   - 签名: extractLngLat(loc) → [lng,lat] | null
  //   - 支持: 数组 [lng,lat] / AMap.LngLat（getLng/getLat）/ 对象 {lng,lat}
  function extractLngLat(loc) {
    if (!loc) return null;
    if (Array.isArray(loc) && typeof loc[0] === 'number') return [loc[0], loc[1]];
    if (typeof loc.getLng === 'function') {
      var lg = loc.getLng(), la = loc.getLat();
      if (typeof lg === 'number' && typeof la === 'number') return [lg, la];
    }
    if (typeof loc.lng === 'number' && typeof loc.lat === 'number') return [loc.lng, loc.lat];
    return null;
  }

  // ===== 城市解析 =====
  // 城市 key 缓存（3.0 优化）：避免频繁遍历别名表，命中即返回
  var _cityCache = {};
  // 城市名/别名 → 标准 key（供配色表 / CITY_BOUNDS / 专题 URL 解析）。
  //   - 调用方: mt-amap（queryLine/queryLineStopsByPOI/queryAMapSubwayWeb）及本文件多函数
  //   - 签名: resolveCityKey(city) → key | null
  //   - 逻辑链: 先查缓存 → 游戏内置配色 raw → CITY_ALIASES 别名 → LOCAL_PALETTE
  //   - 注意: 无法识别返回 null（并缓存）；城市名可为 上海/上海市/shanghai 等
  function resolveCityKey(city) {
    if (!city) return null;
    var c = String(city).trim();
    if (_cityCache[c] !== undefined) return _cityCache[c];
    var raw = window.OFFICIAL_METRO_LINE_PALETTE_RAW || {};
    var r = null;
    if (raw[c]) r = c;
    else for (var k in CITY_ALIASES) {
      var list = CITY_ALIASES[k];
      for (var i = 0; i < list.length; i++) if (c === list[i] || c.indexOf(list[i]) === 0) { r = k; break; }
    }
    if (!r) {
      if (raw[String(city).toLowerCase()]) r = String(city).toLowerCase();
      else if (LOCAL_PALETTE[String(city).toLowerCase()]) r = String(city).toLowerCase();
      else if (LOCAL_PALETTE[c]) r = c;
    }
    _cityCache[c] = r;
    return r;
  }

  // 官方配色表（城市→[{name,color,aliases}]）；优先游戏内置库，兜底 LOCAL_PALETTE。
  //   - 调用方: mt-amap 的 queryLine（配色→线路颜色）
  //   - 签名: officialColors(city) → [{name,color,aliases}] | null
  //   - 注意: 未收录返回 null，调用方需自行兜底默认色；城市级缓存避免每次重建（2026-08-22）
  var _paletteCache = {};
  function officialColors(city) {
    var key = resolveCityKey(city);
    if (_paletteCache[key]) return _paletteCache[key];
    var raw = window.OFFICIAL_METRO_LINE_PALETTE_RAW || {};
    var list = (key && raw[key]) || (key && LOCAL_PALETTE[key]);
    if (!list) return null;
    var out = list.map(function (row) { return { name: row[0], color: row[1], aliases: row[2] || [] }; });
    _paletteCache[key] = out;
    return out;
  }

  // 线号提取：'南京地铁S1号线/机场线'→'S1'；'18号线'→'18'；'浦江线'→'浦江'。
  //   - 调用方: matchOfficial；mt-amap 各线号处理
  //   - 签名: extractLineNo(name) → 线号 | null
  //   - 注意: 区分 S1≠1、18≠8（字母+数字整体作为线号）
  function extractLineNo(name) {    var n = String(name || '').trim();
    var m = n.match(/([A-Za-z]*\d+)号线/);
    if (m) return m[1].toUpperCase();
    m = n.match(/([A-Za-z]*\d+)\s*号\s*线/);
    if (m) return m[1].toUpperCase();
    // 非传统地铁（2026-08-22）：磁悬浮/磁浮（无"线"字）、机场联络线/机场线等 → 归一化线号（供配色/车型/端点查找）
    //   须在通用"...线"正则之前，避免'上海机场联络线'被截成'上海机场联络'
    if (/磁悬浮|磁浮/.test(n)) return '磁悬浮';
    if (/机场联络线|机场线/.test(n)) return '机场线';
    m = n.match(/([A-Za-z\u4e00-\u9fa5]+)线\s*$/);
    if (m) return m[1].toUpperCase();
    return null;
  }

  // 官方配色精确匹配（S1≠1、18≠8）：线号精确匹配优先，无线号时按别名/名称包含兜底。
  //   - 调用方: mt-amap 的 queryLine
  //   - 签名: matchOfficial(palette, lineName) → {name,color,aliases} | null
  //   - 逻辑链: extractLineNo 取线号 → 精确匹配；多匹配时优先无'/'的分线
  //   - 注意: 精确线号匹配失败返回 null（避免 1号线误匹配 11号线）
  function matchOfficial(palette, lineName) {
    if (!Array.isArray(palette) || !palette.length) return null; // 2026-09-06 修复：palette=null/空（无官方配色表城市如宁波）时 filter 崩溃
    var no = extractLineNo(lineName);
    var nm = String(lineName || '').toLowerCase();
    if (no) {
      var exact = palette.filter(function (p) { return extractLineNo(p.name) === no; });
      if (exact.length === 1) return exact[0];
      if (exact.length > 1) {
        var best = exact.find(function (p) { return String(p.name).indexOf('/') < 0; });
        if (best) return best;
      }
      return null;
    }
    for (var i = 0; i < palette.length; i++) {
      var p = palette[i];
      if ((p.aliases || []).some(function (a) { return nm.indexOf(String(a).toLowerCase()) >= 0; })) return p;
      if (nm.indexOf(p.name.toLowerCase()) >= 0) return p;
    }
    return null;
  }

  // ===== 公共 helper（3.0 查重优化：三文件复用）=====
  // 线号归一：'2号线'/'地铁2号线'/'S1线' → '2'/'S1'；'11号线支线'/'支线' → '11'（大写，去'号线'和'支线'）。
  //   - 2026-08-22 新增去'支线'：支线名（如'11号线支线'）解析为主线线号 '11'，
  //     否则端点为 '11支线' 在端点表查不到 → queryLine 报「未提供首末站」。（mt-amap 缓存此函数，改后须重注入）
  //   - 调用方: mt-amap 多函数 / lineSpec / endpointsOf
  //   - 签名: _normLineNo(lineNo) → 线号字符串（大写去后缀）
  function _normLineNo(no) {
    return String(no || '').toUpperCase().replace(/号线/g, '').replace(/支线/g, '');
  }
  // 坐标字符串解析：'lng,lat' → {lng,lat}（NaN 则 null）。
  //   - 调用方: mt-amap 的 _parseSrhStops/_freePlace/queryLineByBusAPI
  //   - 签名: _parseCoord(locStr) → {lng,lat} | null
  function _parseCoord(loc) {
    var c = String(loc || '').split(',');
    var lng = parseFloat(c[0]), lat = parseFloat(c[1]);
    return (isFinite(lng) && isFinite(lat)) ? { lng: lng, lat: lat } : null;
  }
  // 解析 srhdata 站数组 st[].{n,sl,t} → [{name,lng,lat,isTransfer}]（过滤非法坐标）。
  //   - 调用方: mt-amap 的 _queryLineLocal / parseAMapSubwayData
  //   - 签名: _parseSrhStops(st) → [{name,lng,lat,isTransfer}]
  function _parseSrhStops(st) {
    var out = [];
    (st || []).forEach(function (s) {
      var ll = _parseCoord(s && s.sl);
      if (!ll) return;
      out.push({ name: s.n, lng: ll.lng, lat: ll.lat, isTransfer: s.t === '1' });
    });
    return out;
  }
  // 站名清洗：统一去掉尾缀（地铁站/（地铁站）/号口N/站/括号后缀），用于站名比较与排序。
  //   - 调用方: mt-amap 的 queryLineStopsByPOI/compareSources/detectOsmShift/queryTramLine/checkLineCompleteness/queryLine
  //   - 签名: _normStopName(name) → 清洗后站名（去尾缀，trim）
  //   - 注意: 权威实现；比对/排序的站名用同一 helper 清洗，避免各函数清洗规则不一致
  function _normStopName(name) {
    return String(name || '')
      .replace(/[（(]地铁站[)）]$/, '')
      .replace(/[（(][^）)]*地铁站[）)]$/, '')
      .replace(/地铁站$/, '')
      .replace(/号口.*$/, '')
      .replace(/站$/, '')
      .replace(/[（(].*[)）]$/, '')
      .trim();
  }

  // 车型规格（真实运营规格；未收录返回默认 B/6/80）。
  //   - 调用方: mt-amap 的 queryLine（车型/编组/限速）
  //   - 签名: lineSpec(city, lineNo) → {trainType, trainCars, maxSpeedKmh}
  //   - 注意: 未收录城市/线路返回默认 {B,6,80}
  function lineSpec(city, lineNo) {
    var key = resolveCityKey(city);
    var no = _normLineNo(lineNo);
    var spec = key && LINE_SPECS[key] && LINE_SPECS[key][no];
    return spec || { trainType: 'B', trainCars: 6, maxSpeedKmh: 80 };
  }

  // 已知线路端点（自动查询用；无则 null）。
  //   - 调用方: mt-amap 的 queryLine（缺省起讫点时自动取端点）
  //   - 签名: endpointsOf(city, lineNo) → {from, to} | null
  //   - 注意: 端点表未收录返回 null，调用方需传 stationFrom/stationTo 或失败
  function endpointsOf(city, lineNo) {
    var key = resolveCityKey(city);
    var no = _normLineNo(lineNo);
    return (key && LINE_ENDPOINTS[key] && LINE_ENDPOINTS[key][no]) || null;
  }

  // Haversine 球面距离（米），点格式 [lng,lat]（统一权威实现；distM 为其兼容包装）。
  //   - 调用方: mt-node 的 curvatureThin/sampleCatmull/fitSegmentNodes；OD 共享
  //   - 签名: haversine(a, b) → 米（a,b=[lng,lat]）
  function haversine(a, b) {
    var R = 6371000, dLat = (b[1] - a[1]) * Math.PI / 180, dLng = (b[0] - a[0]) * Math.PI / 180;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a[1] * Math.PI / 180) * Math.cos(b[1] * Math.PI / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    // ⚠️ 2026-08-22 修复历史 bug：原最后一行用参数名 a 当正弦变量（Math.sqrt(a) 对数组→NaN）。
    //    改用中间变量 a2 计算距离（与参数 a/b 不冲突）。
    var a2 = Math.sqrt(s);
    return R * 2 * Math.atan2(a2, Math.sqrt(1 - s));
  }

  // distM 兼容包装（lat,lng 形式）→ 转调 haversine（[lng,lat]）。
  //   - 调用方: mt-node 的 sampleCatmull/fitSegmentNodes（保留旧签名 lat,lng）
  //   - 签名: distM(lat1,lng1,lat2,lng2) → 米
  function distM(lat1, lng1, lat2, lng2) {
    return haversine([lng1, lat1], [lng2, lat2]);
  }

  // ===== 校验 =====
  // 坐标有效性检查（3.0 提取）：数字/有限/非(0,0)。
  //   - 调用方: inCityBounds / verifyMetroPOI / verifyTramPOI 复用
  //   - 签名: _validCoord(lng, lat) → boolean
  function _validCoord(lng, lat) {
    return typeof lng === 'number' && typeof lat === 'number' && isFinite(lng) && isFinite(lat) && !(lng === 0 && lat === 0);
  }

  // ===== 坐标系统换算（WGS-84 ↔ GCJ-02，2026-08-22 新增）=====
  // 背景: 游戏内高德数据用 GCJ-02（火星坐标），OSM 数据用 WGS-84。
  //       切换地图（高德↔OSM）后坐标系不同会导致线路错位。需统一坐标系换算。
  // 实现: 标准 GCJ-02 偏移算法（中国国测局加密偏移，国内常见坐标转换算法）。
  //   - 被 MT.wgs84ToGcj02 / MT.gcj02ToWgs84 / MT.coordToGameNative / MT.isWgsNativeCity 使用
  //   - 注意: 标准算法仅对中国大陆有效（偏离国界外不偏移）；香港/澳门/台湾用 GCJ-02 亦适用
  var _PI = Math.PI;
  var _A = 6378245.0;          // 克拉索夫斯基椭球长半轴
  var _EE = 0.00669342162296594323; // 偏心率平方
  // WGS-84 → GCJ-02（返回 [lng,lat] 数组）。经度超出中国范围则原样返回。
  //   - 签名: wgs84ToGcj02(lng, lat) → [lng,lat]
  function wgs84ToGcj02(lng, lat) {
    if (outOfChina(lng, lat)) return [lng, lat];
    var dLat = transformLat(lng - 105.0, lat - 35.0);
    var dLng = transformLng(lng - 105.0, lat - 35.0);
    var radLat = lat / 180.0 * _PI;
    var magic = Math.sin(radLat); magic = 1 - _EE * magic * magic;
    var sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((_A * (1 - _EE)) / (magic * sqrtMagic) * _PI);
    dLng = (dLng * 180.0) / (_A / sqrtMagic * Math.cos(radLat) * _PI);
    return [lng + dLng, lat + dLat];
  }
  // GCJ-02 → WGS-84（返回 [lng,lat] 数组）。经度超出中国范围则原样返回。
  //   - 签名: gcj02ToWgs84(lng, lat) → [lng,lat]
  function gcj02ToWgs84(lng, lat) {
    if (outOfChina(lng, lat)) return [lng, lat];
    var c = wgs84ToGcj02(lng, lat);
    var dLng = c[0] - lng, dLat = c[1] - lat;
    return [lng - dLng, lat - dLat];
  }
  // 判断坐标是否在中国大陆之外（GCJ 偏移只适用于国内）。
  //   - 签名: outOfChina(lng, lat) → boolean
  function outOfChina(lng, lat) {
    return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
  }
  // 纬度偏移量（WGS→GCJ 内部）
  function transformLat(x, y) {
    var ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * _PI) + 20.0 * Math.sin(2.0 * x * _PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(y * _PI) + 40.0 * Math.sin(y / 3.0 * _PI)) * 2.0 / 3.0;
    ret += (160.0 * Math.sin(y / 12.0 * _PI) + 320 * Math.sin(y * _PI / 30.0)) * 2.0 / 3.0;
    return ret;
  }
  // 经度偏移量（WGS→GCJ 内部）
  function transformLng(x, y) {
    var ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * _PI) + 20.0 * Math.sin(2.0 * x * _PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(x * _PI) + 40.0 * Math.sin(x / 3.0 * _PI)) * 2.0 / 3.0;
    ret += (150.0 * Math.sin(x / 12.0 * _PI) + 300.0 * Math.sin(x / 30.0 * _PI)) * 2.0 / 3.0;
    return ret;
  }
  // 判断某城市是否原生 WGS-84（复用游戏 isWgsNativeCityKey，缺失时用城市 bounds 兜底）。
  //   - 调用方: coordToGameNative（坐标换算）；mt-amap 的 detectOsmShift/fixOsmShift
  //   - 签名: isWgsNativeCity(city) → boolean
  //   - 逻辑: 优先游戏 isWgsNativeCityKey(cityKey)；缺失时用 CITY_BOUNDS 中心判断是否在中国大陆之外
  //   - 注意: 海外城市（singapore/london/seoul 等）→ true(WGS-84)；国内城市 → false(GCJ-02)；
  //           未知城市默认 false（GCJ-02，避免误判国内城市）
  function isWgsNativeCity(city) {
    var W = window;
    var key = resolveCityKey(city) || String(city || '').toLowerCase();
    if (typeof W.isWgsNativeCityKey === 'function') {
      try { return !!W.isWgsNativeCityKey(key); } catch (e) {}
    }
    // 兜底：用城市 bounds 中心经纬度判断是否在中国大陆之外（GCJ 偏移只适用于国内）
    var b = CITY_BOUNDS[key] || CITY_BOUNDS[city];
    if (b) {
      return outOfChina((b[0] + b[1]) / 2, (b[2] + b[3]) / 2);
    }
    return false; // 未知城市默认 GCJ-02（中国城市）
  }
  // 坐标转换到游戏原生坐标系（高德城市→GCJ-02；OSM 城市→WGS-84）。
  //   - 签名: coordToGameNative(city, lng, lat, fromIsWgs) → [lng,lat]
  //   - fromIsWgs: 输入坐标是否 WGS-84（默认 false=GCJ-02）；返回游戏原生坐标系坐标
  //   - 逻辑: 若输入坐标系 ≠ 城市原生坐标系 → 转换；否则原样
  function coordToGameNative(city, lng, lat, fromIsWgs) {
    var nativeWgs = isWgsNativeCity(city);
    fromIsWgs = !!fromIsWgs;
    if (nativeWgs === fromIsWgs) return [lng, lat];      // 一致，无需转换
    if (nativeWgs) return gcj02ToWgs84(lng, lat);        // 目标 WGS，输入 GCJ → GCJ 转 WGS
    return wgs84ToGcj02(lng, lat);                       // 目标 GCJ，输入 WGS → WGS 转 GCJ
  }

  // 当前地图引擎：'amap' | 'osm'（G.mapEngine；未知按高德）
  function mapEngine() {
    return (window.G && window.G.mapEngine === 'osm') ? 'osm' : 'amap';
  }
  // 引擎特调档案：默认高德；OSM 引擎下高德数据需转 WGS-84，阈值放宽
  function engineProfile() {
    if (mapEngine() === 'osm') {
      return {
        engine: 'osm', crs: 'wgs84', dataSource: 'amap-first', convertAmapToGame: true,
        density: 'standard', nodeToleranceM: 15, stationTolM: 150, transferTolM: 200, cacheTtlMin: 5,
        notes: '默认高德取数后 gcj02ToWgs84；高德无数据才用游戏内 OSM API/Overpass；换乘/站距阈值放宽'
      };
    }
    return {
      engine: 'amap', crs: 'gcj02', dataSource: 'amap', convertAmapToGame: false,
      density: 'standard', nodeToleranceM: 12, stationTolM: 100, transferTolM: 150, cacheTtlMin: 5,
      notes: '高德地铁专题/SUBWAY path/POI 优先；GCJ-02 原生，坐标不转换'
    };
  }
  // 数据源体检：引擎策略/AMap JS/Web key/srhdata/推荐路径。
  //   - 签名: dataSourceStatus() → {engine,profile,policy,amapJs,webKey,webApiReady,srhdataInjected,recommended}
  //   - 注意: 引擎策略由 getMapEnginePolicyForCurrentCity() 决定（IP+城市组合可能只开放 OSM）
  function dataSourceStatus() {
    var policy = null;
    try {
      if (typeof window.getMapEnginePolicyForCurrentCity === 'function') policy = window.getMapEnginePolicyForCurrentCity();
    } catch (e) {}
    var key = webKey();
    var srh = !!(window.__MT_SUBMETRO_DATA && Object.keys(window.__MT_SUBMETRO_DATA).length);
    var amapJs = typeof window.AMap !== 'undefined';
    var recommended;
    if (policy && policy.canUseAmap === false) {
      recommended = key ? 'amap-web+osm-render' : (srh ? 'amap-srhdata+osm-path' : 'need-amap-web-key-or-srhdata');
    } else if (amapJs) recommended = 'amap-js';
    else if (key) recommended = 'amap-web';
    else if (srh) recommended = 'amap-srhdata';
    else recommended = 'osm';
    return {
      engine: mapEngine(), profile: engineProfile(), policy: policy,
      amapJs: amapJs, webKey: !!key, webApiReady: webApiReady(),
      srhdataInjected: srh, gameLines: (window.G && window.G.lines ? window.G.lines.length : 0),
      recommended: recommended
    };
  }
  // 高德取数 → 游戏原生坐标：OSM 引擎转 WGS-84，AMap 引擎原样返回。
  //   - 签名: toGameCoords(stations, nodes) → {stations,nodes,converted,engine}
  function toGameCoords(stations, nodes) {
    var prof = engineProfile();
    if (!prof.convertAmapToGame) return { stations: stations || [], nodes: nodes || [], converted: false, engine: prof.engine };
    var cv = function (lng, lat) { return gcj02ToWgs84(+lng, +lat); };
    var st = (stations || []).map(function (s) {
      var c = cv(s.lng, s.lat);
      var o = {}; for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) o[k] = s[k];
      o.lng = c[0]; o.lat = c[1]; return o;
    });
    var nd = (nodes || []).map(function (seg) {
      return (seg || []).map(function (p) { return cv(p[0], p[1]); });
    });
    return { stations: st, nodes: nd, converted: true, engine: prof.engine };
  }

  // 坐标是否在城市范围（过滤跨城市同名错配）。城市无 bounds 或坐标异常（非数字/NaN/Infinity）→ 放行 true，避免误杀。
  //   - 调用方: verifyMetroPOI/verifyTramPOI/segInCity；mt-amap 的 resolveCoord
  //   - 签名: inCityBounds(city, lng, lat) → boolean
  //   - 注意: 返回 true 表示"无法判定"或"在城市内"；仅在城市有 bounds 且坐标正常时做严格判断
  function inCityBounds(city, lng, lat) {
    var b = CITY_BOUNDS[resolveCityKey(city)];
    if (!b || !_validCoord(lng, lat)) return true;
    return lng >= b[0] && lng <= b[1] && lat >= b[2] && lat <= b[3];
  }

  // 段内站点是否多数（≥60%）在城市范围（跨城市同名线过滤）。
  //   - 调用方: mt-amap 的 queryTransferStops（收段前过滤跨城市同名线污染）
  //   - 签名: segInCity(city, sg) → boolean（sg 含 stops[]，取每站 _loc 坐标）
  //   - 注意: 无有效坐标或段空返回 true（放行）；要求 ≥60% 站点在城市内
  function segInCity(city, sg) {
    var inN = 0, total = 0;
    ((sg && sg.stops) || []).forEach(function (s) {
      var ll = extractLngLat(s && s._loc);
      if (!ll) return;
      total++;
      if (inCityBounds(city, ll[0], ll[1])) inN++;
    });
    if (!total) return true;
    return (inN / total) >= 0.6;
  }

  // 坐标校验（获得坐标后必查）：地铁数据 / 真实数据 / 城市范围 / 目标线 / 出入口噪音。
  //   - 调用方: mt-amap 的 resolveCoord/queryLineStopsByPOI；OD 绘制前校验
  //   - 签名: verifyMetroPOI(city, lineNo, p) → {ok, reason?, name?}
  //   - 校验项: ① type 含 地铁/轨道交通 ② 非出入口(X号口) ③ 坐标有效且在城 ④ 非占位符(站N) ⑤ 目标线号匹配
  //   - 注意: lineNo 可为 null（不做线号匹配）；返回 reason 供调试
  function verifyMetroPOI(city, lineNo, p) {
    if (!p) return { ok: false, reason: 'empty' };
    var nm = String(p.name || '');
    var ty = String(p.type || '');
    var no = lineNo == null ? '' : _normLineNo(lineNo);
    var bad = function (reason) { return { ok: false, reason: reason, name: nm }; };
    if (!/地铁|轨道交通/.test(ty)) return bad('not_metro');
    if (/号口|号(东|西|南|北)?口/.test(nm)) return bad('exit_noise');
    if (!_validCoord(p.lng, p.lat)) return bad('invalid_coord');
    if (!inCityBounds(city, p.lng, p.lat)) return bad('out_of_city');
    if (/^(站|Station\s*|L)\d+$/i.test(nm)) return bad('placeholder');
    if (no) {
      var mLine = nm.match(/(\d+)号线/);
      if (mLine && mLine[1] !== no) return bad('other_line:' + mLine[1]);
    }
    return { ok: true, name: nm };
  }

  // 有轨电车站校验（电车站 type 为"交通设施服务;公交车站;电车站"等，需单独放行电车/有轨电车站）。
  //   - 调用方: mt-amap 的 resolveTramCoord/queryTramLine
  //   - 签名: verifyTramPOI(city, p) → {ok, reason?, name?, type?}
  //   - 校验项: ① type 含 电车，或 公交车站+名称含有轨电车 ② 坐标有效且在城
  //   - 注意: verifyMetroPOI 只放行 地铁/轨道交通，有轨电车需用本函数
  function verifyTramPOI(city, p) {
    if (!p) return { ok: false, reason: 'empty' };
    var nm = String(p.name || '');
    var ty = String(p.type || '');
    var bad = function (reason) { return { ok: false, reason: reason, name: nm, type: ty }; };
    var isTram = ty.indexOf('电车') >= 0 || (ty.indexOf('公交车站') >= 0 && nm.indexOf('有轨电车') >= 0);
    if (!isTram) return bad('not_tram');
    if (!_validCoord(p.lng, p.lat)) return bad('invalid_coord');
    if (!inCityBounds(city, p.lng, p.lat)) return bad('out_of_city');
    return { ok: true, name: nm, type: ty };
  }

  // ===== 导出 =====
  // 日志：共享工具（统一：OD/K 引用 MT）
  MT.log = log;
  // 城市解析：公开 API
  MT.resolveCityKey = resolveCityKey;
  // 城市范围校验：公开（内部校验辅助，其他工具箱可能引用）
  MT.inCityBounds = inCityBounds;
  // 坐标归一化：公开 API
  MT.extractLngLat = extractLngLat;
  // 段内城市过滤：内部共享（供 mt-amap 的 queryTransferStops 使用）
  MT.segInCity = segInCity;
  // 坐标校验：公开 API
  MT.verifyMetroPOI = verifyMetroPOI;
  // 有轨电车站校验：公开 API
  MT.verifyTramPOI = verifyTramPOI;
  // 超时包装：内部共享（供 mt-amap 的 placeSearch/transferSearch 使用）
  MT.withTimeout = withTimeout;
  // 高德插件加载：公开 API
  MT.ensureAmap = ensureAmap;
  // 免费 Web key 就绪：公开 API
  MT.webApiReady = webApiReady;
  // 设/读免费 Web key：公开 API
  MT.webKey = webKey;
  // 尝试切换包装：内部共享（供 mt-amap 的 placeSearch/transferSearch/resolveCoord 使用）
  MT.withFallback = withFallback;
  // 官方配色表：公开 API
  MT.officialColors = officialColors;
  // 线号提取：公开 API
  MT.extractLineNo = extractLineNo;
  // 官方配色匹配：公开 API
  MT.matchOfficial = matchOfficial;
  // 车型规格：公开 API
  MT.lineSpec = lineSpec;
  // 线路端点：公开 API
  MT.endpointsOf = endpointsOf;
  // 距离计算（兼容包装）：公开 API（_distM 与 v2 导出名一致）
  MT._distM = distM;
  // 球面距离：公开 API（统一共享工具权威实现，OD/K 引用）
  MT.haversine = haversine;
  // 城市别名表：共享常量（供 mt-amap 使用）
  MT.CITY_ALIASES = CITY_ALIASES;
  // 城市坐标范围：共享常量（供 mt-amap 的 queryOsmOverpass 取 Overpass bbox）
  MT.CITY_BOUNDS = CITY_BOUNDS;
  // 公共 helper（3.0 查重优化）：线号归一 / 坐标解析 / srhdata 站解析（供 mt-amap 复用）
  MT._normLineNo = _normLineNo;
  MT._parseCoord = _parseCoord;
  MT._parseSrhStops = _parseSrhStops;
  MT._normStopName = _normStopName;
  // 坐标系统换算（2026-08-22 新增）：WGS-84 ↔ GCJ-02 标准算法 + 城市原生坐标系判断
  MT.wgs84ToGcj02 = wgs84ToGcj02;
  MT.gcj02ToWgs84 = gcj02ToWgs84;
  MT.outOfChina = outOfChina;
  MT.isWgsNativeCity = isWgsNativeCity;
  MT.coordToGameNative = coordToGameNative;
  // 环线（2026-08-23 新增）：已知环线表 / 官方站序表 / 环线判定（供 mt-amap.queryRingLine 使用）
  MT.RING_LINES = RING_LINES;
  MT.RING_STATIONS = RING_STATIONS;
  MT.isRingLine = isRingLine;
  // 已知线路端点表：公开（查询无起讫时用）
  // 已知延伸站：高德整线接口尚未收录的官方新站（按城市|线号）
  var KNOWN_EXTENSIONS = {
    'suzhou|2': { head: [
      { name: '朗力福大道' },
      { name: '渭中路', query: '渭中路站' },
      { name: '珍珠湖路' },
      { name: '爱格豪路' }
    ] },
    'suzhou|6': { tail: [{ name: '华云' }] }
  };
  MT.KNOWN_EXTENSIONS = KNOWN_EXTENSIONS;

  MT.LINE_ENDPOINTS = LINE_ENDPOINTS;
  // 注入 srhdata 原始 JSON（fetch_subway_data.py 的输出）：
  //   - 签名: injectSrhData(raw, city) → {ok, city, lines, lineNames}
  //   - raw 需含 l[]（高德地铁专题原始结构）；注入后 queryLine/POI 可直接命中
  function injectSrhData(raw, city) {
    if (!raw || !raw.l || !raw.l.length) return { ok: false, reason: 'invalid srhdata (missing l[])' };
    var key = resolveCityKey(city) || String(city || '').toLowerCase();
    window.__MT_SUBMETRO_DATA = window.__MT_SUBMETRO_DATA || {};
    window.__MT_SUBMETRO_DATA[key] = { s: raw.s || key, i: raw.i || '', l: raw.l, injected: true };
    return { ok: true, city: key, lines: raw.l.length, lineNames: raw.l.map(function (x) { return x.ln; }) };
  }
  // 地图引擎特调
  MT.mapEngine = mapEngine;
  MT.engineProfile = engineProfile;
  MT.toGameCoords = toGameCoords;
  MT.dataSourceStatus = dataSourceStatus;
  MT.injectSrhData = injectSrhData;
  // 拆分版本标记：core/node/amap 各自幂等守卫，__version 为整体版本
  MT.__coreVersion = '6.5.3';
  MT.__version = '6.5.3';
})();
