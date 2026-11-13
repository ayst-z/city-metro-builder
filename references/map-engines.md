# 双地图引擎特调（AMap 默认 · OSM 独立）

> 2026-11-09 用户要求：**默认使用高德地图数据**；AMap 与 OSM 两套引擎分别特调。
> 引擎判定：`G.mapEngine`（`'amap'` | `'osm'`）→ `MT.mapEngine()` → `MT.engineProfile()`。

## 0. 总原则

| 规则 | 说明 |
|---|---|
| **默认高德** | 任何城市/线路，先用高德取数（游戏内高德 API → 免费 Web → srhdata → POI）；高德确实无数据才降级 OSM/规划图/估算 |
| **OSM 引擎不改变取数优先级** | OSM 引擎下仍先取高德，再用 `MT.toGameCoords(stations, nodes)` 把 GCJ-02 转成游戏原生 WGS-84 后绘制 |
| **坐标只转一次** | 高德数据在 AMap 引擎直接使用；OSM 引擎必须转换后再 `fitSegmentNodes`/`applyLineData`，禁止混用两套坐标 |
| **汇报数据源与引擎** | 每次查询/绘制注明 `engine`、`dataSource`、是否转换（`converted:true`） |

## 1. AMap 引擎（`G.mapEngine === 'amap'`）

| 项 | 特调 |
|---|---|
| 坐标系 | GCJ-02（高德原生），**不转换** |
| 数据源优先级 | ①游戏内高德 API（`window.AMap`，无 CORS）→ ②高德免费 Web（`window.__MT_AMAP_WEB_KEY`）→ ③地铁专题 srhdata → ④POI（在建/规划） |
| 核心函数 | `MT.queryLine` / `queryRingLine` / `queryTransferStops` / `resolveCoord` / `queryLineStopsByPOI` / `queryUnopenedLine` |
| 本地命中精化 | srhdata 命中无 path 时自动走高德 path 精化（`dataSource:'local+amap-path'`，实测 129ms）；失败保留直线节点；`opts.refine:false` 跳过；`opts.pathTimeoutMs` 默认 10000 |
| OSM 查询 | 公共 Overpass 快速失败：单请求 12s、整体 15s（`overallTimeoutMs`），游戏内 OSM 无数据时不再拖 25s+ |
| 节点拟合 | path 密（约 10–30m/点）：`fitSegmentNodes` + `curvatureThin`；`standard`：dev 12m / minGap 72m / curveGap 160m |
| 坐标基准 | **该线自己的 SUBWAY path 投影**：`OD.queryLinePaths` → `K.resolveLineCoord`（devToLine≈0）；勿用 srhdata 静态坐标/通用 POI 当 refCoords |
| 校验阈值 | 站坐标 ≤100m；换乘 ≤150m；节点 maxDev ≤30m；绕路 ratio>2.2 告警 |
| 命名 | 中文官方站名优先（`renameStations` 用 queryLine 返回站名） |
| 常见坑 | 同线多 plan 漂移 40–290m；跨城同名 POI；`S1` 与 `1` 线号混淆；免费 key 限流（5min 缓存） |
| 引擎切换 | 切到 OSM 后，旧 AMap 坐标会整体偏移；用 `MT.detectOsmShift` 检查（>150m 判错位）→ `fixOsmShift` 或重新取数 |

## 2. OSM 引擎（`G.mapEngine === 'osm'`）

| 项 | 特调 |
|---|---|
| 坐标系 | WGS-84（游戏原生），高德 GCJ-02 必须转换 |
| 取数优先级（用户设定） | **①高德（默认）→ 转换 `toGameCoords`** → ②游戏内 OSM API（`queryOsmOverpass` 的 maplibre `urban_rail_lines/urban_rail_stations`，0–7ms）→ ③公共 Overpass（串行/限流/多镜像） |
| 转换函数 | `MT.toGameCoords(stations, nodes)` → `{stations,nodes,converted,engine}`；单点用 `MT.gcj02ToWgs84(lng,lat)` |
| 节点拟合 | OSM path 可能稀疏/缺段：先 `fitSegmentNodes`（density standard）→ `curvatureThin`；`standard` 放宽到 dev 15m / minGap 90m / curveGap 180m；空段用 `straightLineNodes` 直线兜底，**不得虚构造路** |
| 校验阈值 | 站坐标 ≤150m；换乘 ≤200m；节点 maxDev ≤40m；国际城市站名用 OSM/游戏站名，勿套中文站名 |
| 坐标错位 | 切引擎/切主题后 `MT.detectOsmShift(city,lineId)`：与 srhdata GCJ 坐标比对，偏差>150m 判错位；`MT.fixOsmShift` 转换修复 |
| 常见坑 | 高德 GCJ 直接绘制会整体偏移；OSM relation 缺段/断链；国际城市无高德数据（此时才走 OSM）；OSM 站名语言（`METRO_OSM_LABEL_LANG_KEY`） |
| 无 AMap/key 兜底 | `queryLineStopsByPOI` 自动回退注入的 srhdata 站表（`dataSource:'srhdata'`，官方坐标、无走向）；`MT.injectSrhData(raw,'wuxi')` 可直接注入 `fetch_subway_data.py` 的原始 JSON |
| 地图/主题 | 新加坡等国际城市有专属 OSM 主题与默认 zoom；不要套国内城市参数 |

## 2.5 引擎策略门禁（2026-11-09 实测）

游戏可能按 **客户端 IP + 城市** 限制底图引擎，优先读策略而不是硬切：

```js
getMapEnginePolicyForCurrentCity()
// 实测（AnyCity/global client）：
// { allowedEngines:['osm'], canUseAmap:false, canUseOsm:true,
//   singleAllowed:true, defaultEngine:'osm', cityType:'mainland-target-global-client' }
```

- `canUseAmap:false` 时页面提示「当前 IP 与所选城市组合仅开放 OpenStreetMap」；实测 `applyMapEngine('amap')` 仍可能先提示策略、随后**重载并切到 AMap**（`G.mapEngine='amap'`、`window.AMap` 就绪）。因此：**不要只信第一次 policy 返回值**——调用后等 5–15s，验证 `G.mapEngine` 与 `typeof AMap`；重载会清空工具箱，必须重新注入；以实际引擎为准，再决定是否走混合模式。
- 该场景下“默认高德”改为 **高德数据 + OSM 渲染**：
  1) 有免费 Web key → `MT.webKey(key)` → 高德 Web 取站/走向 → `MT.toGameCoords` 转 WGS-84；
  2) 无 key → 本地 `fetch_subway_data.py` 抓 srhdata → 注入 `window.__MT_SUBMETRO_DATA[city]`（站名/坐标/官方色，无 path）→ 走向用 OSM（游戏内 OSM API 优先）或直线兜底；
  3) 汇报必须写 `policy.canUseAmap=false` 与所用混合数据源。
- 先调用 `MT.dataSourceStatus()`，按 `recommended` 选择：`amap-web+osm-render` / `amap-srhdata+osm-path` / `need-amap-web-key-or-srhdata`。

## 3. 引擎自检（绘制前）

```js
const st = MT.dataSourceStatus();
// { engine, profile, policy, amapJs, webKey, webApiReady, srhdataInjected, recommended }
const p = MT.engineProfile();
// { engine:'amap'|'osm', crs, dataSource, convertAmapToGame, density,
//   nodeToleranceM, stationTolM, transferTolM, cacheTtlMin }

// OSM 引擎：高德取数后转换
const q = await MT.queryLine(city, no, {});
const g = MT.toGameCoords(q.stations, q.nodes);   // OSM: converted=true；AMap: false 原样
// 用 g.stations / g.nodes 绘制；汇报 engine + converted + dataSource
```

## 4. 两套引擎的节点/校验参数对照

| 参数 | AMap | OSM |
|---|---|---|
| 节点容差 `devM` | 12m（standard） | 15m（standard） |
| 最小间距 `minGapM` | 72m | 90m |
| 弯道间距 `curveGapM` | 160m | 180m |
| 站坐标校验 | ≤100m | ≤150m |
| 换乘距离 | ≤150m | ≤200m |
| 节点 maxDev 告警 | >30m | >40m |
| 缓存 | 5min（`MT.clearQueryCache()`） | 5min（OSM/高德分别缓存） |
| 数据源 | 高德 | **高德（默认）→ 转换**；高德无数据才 OSM |

> 拟合硬门禁（两种引擎一致）：`missing.length===0 && interpolated.length===0` 才交付；OSM 缺段必须显式标注，不许默认插值。
