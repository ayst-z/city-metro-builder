# API 全量参考 · 逐函数详解（功能分类 / 签名 / 返回 / 调用链 / 坑）

> 约定：坐标 `[lng,lat]`；站 `{name,lng,lat}`（数据）或 `{name,latlng:{lng,lat}}`（游戏）；段节点 `[[lng,lat],...]`；多段 `[seg,...]`。返回普遍 `{ok, ...}`，失败 `{ok:false, reason}`。
> 注入顺序：mt-core → mt-node → mt-amap → od → k →（可选）ops → autopilot → official-edit → fare-lab → modes → plan-map。
> **几何单一权威 = MT**；OD/K/PlanMap/mt-amap 委托 MT，禁止本地复制。版本守卫：同版跳过注入。

---

## 1. MT · mt-core.js — 基础/坐标/城市/规格/校验

### 距离与坐标
- `haversine(a,b) -> number(米)`：球面大圆距离，**全技能距离权威**。a/b 为 `[lng,lat]`。用于站距/节点间距/避让/绕路比。坑：不要用它做大量逐点循环的热路径（平面 `_distM` 更快）。
- `_distM(lat1,lng1,lat2,lng2) -> number(米)`：平面近似（110540/111320·cos）。注意参数序是 **lat,lng**（与 haversine 的 [lng,lat] 相反）。OD 内部 `_distM` 另支持对象签名。
- `gcj02ToWgs84(lng,lat) / wgs84ToGcj02(lng,lat) -> [lng,lat]`：国测局↔WGS 互转（迭代逆解）。OSM 引擎绘高德数据必转。
- `coordToGameNative(lng,lat,engine) -> [lng,lat]`：按引擎转游戏原生（amap 原样 / osm 转 WGS）。
- `toGameCoords(stations,nodes) -> {stations,nodes,converted}`：批量转换；`converted:true` 表示发生了 GCJ→WGS。坑：转换后**不可**再与 GCJ 混用。
- `outOfChina(lng,lat) / isWgsNativeCity(city) -> bool`：境外/原生 WGS 城市判定（决定是否需要转换）。

### 引擎与特调
- `mapEngine() -> 'amap'|'osm'`：读 `G.mapEngine`。
- `engineProfile() -> {engine,crs,convertAmapToGame,nodeToleranceM,stationTolM,transferTolM,...}`：双引擎特调参数。OSM 时 `convertAmapToGame:true`。

### 城市与范围
- `resolveCityKey(name) -> key`：别名归一（'上海'→shanghai）。`CITY_ALIASES/CITY_ADCODE/CITY_BOUNDS` 为表。
- `inCityBounds(city,lng,lat) / segInCity(city,a,b) -> bool`：站/段是否在城市边界内（防错配跨城 POI）。

### 规格与配色
- `officialColors(city) -> {lineNo:hex}`；`matchOfficial(city,lineNo) -> hex`：官方配色。用户指定色优先。
- `lineSpec(city,lineNo) -> {trainType,trainCars,maxSpeedKmh}`：车型/编组/限速（如上海17=A6/100）。
- `endpointsOf(city,lineNo) -> {from,to}`：现行起讫（含延伸）。`KNOWN_EXTENSIONS/LINE_ENDPOINTS` 补高德漏站。
- `extractLineNo(name)/_normLineNo(no)/_normStopName(name)`：线号/站名归一（去装饰·合作名/地铁站后缀）。坑：线号匹配用**全等**，禁子串正则（/2号线/ 误中 S2）。
- `isRingLine(city,lineNo)/RING_LINES/RING_STATIONS`：环线判定与站表。

### POI 校验与解析
- `verifyMetroPOI(city,lineNo,poi) -> {ok,reason}`：类别含地铁/轨道、城市范围、占位符、线号归属。坑：**仅类别+线号不足**，规划查询需正向线证据（见 mt-amap queryLineStopsByPOI）。
- `verifyTramPOI(...)`：有轨电车版。
- `extractLngLat(loc)/_parseCoord(str)/_parseSrhStops(st)`：坐标/站表解析。

### 基础设施
- `ensureAmap(plugins) -> Promise<bool>`：加载高德插件（游戏内）。`webKey(k?)/webApiReady()`：免费 Web key。
- `withTimeout(promise,ms,fallback)` / `withFallback(primary,fallback,retries)`：超时/降级（防高德挂起）。
- `injectSrhData(raw,city)/dataSourceStatus()`：注入/查询 srhdata 状态。`log()`。

---

## 2. MT · mt-node.js — 几何权威（节点/样条/抽稀/避让）

- `catmullRom(p0,p1,p2,p3,t) -> [lng,lat]`：Catmull-Rom 样条单点。游戏渲染即用此样条，故节点=控制点。
- `sampleCatmull(pts,stepM) -> [pts]`：沿控制点按 ~stepM 米密集采样（拟合用）。
- `localTurn(p0,p1,p2) -> deg(0-180)`：三点转角；>turnDeg 判弯道。
- `adaptiveDensity(tol,overrides) -> {devM,maxSpacing,minGapM,turnDeg,curvePadM,curveGapM,endPadM}`：容错→密度参数（tol 越大越疏）。`NODE_DENSITY`：sparse15/standard12/dense8 三档。
- **`curvatureThin(pts,{density|tolerance,minGapM,maxRatio,devM,maxSpacing,...}) -> [pts]`**：唯一抽稀权威。流程 DP(devM)→弯道渐变加密→直线均匀化→minGap 过滤→全局间距平滑(maxRatio)。坑：渐变插点必须距段终点 ≥minGapM（否则近重复点被游戏拒）；每边只遍历一次合并两端弯道候选（防重叠折返）。
- **`fitSegmentNodes(stations,path,{tolerance,endPadM,stepM}) -> [seg]`**：站投影到 path(projIdx)→段内切片→sampleCatmull→首末贴站→padFilter 站台避让。返回**密集**段，需再交 curvatureThin 抽稀。坑：单独调用不抽稀。
- **`padSegmentNodes(stations,segs,{endPadM=100}) -> [seg]`**：剔除距两端站 <endPadM 的节点；剔空取中点（不回退站点）。环线/支线直写前必调。
- `straightLineNodes(stations) -> [seg]`：无 path 直线兜底（标估算，已开通禁用）。`smoothLineNodes`：未开通段平滑插值。

---

## 3. MT · mt-amap.js — 数据源（高德/OSM/有轨/瓦片）

- `placeSearch(city,kw,{pageSize,via}) / transferSearch(city,from,to)`：POI/换乘。via=game/free/auto。坑：连续调用触发频控，加延迟。
- `resolveCoord(city,name) / resolveTramCoord`：单站坐标。坑：**单次会错配**，需多关键词交叉（resolveCoordTwice）。
- **`queryLine(city,lineNo,{stationFrom,stationTo}) -> {ok,stations,nodes,color,trainType,trainCars,maxSpeedKmh,pathQuality,dataSource,completeness}`**：整线主入口。降级链 srhdata→game-amap→free→POI→OSM。`pathQuality:'amap'|'straight'`、`needsPath` 标记直线需精化。坑：5min 缓存 key 含起讫（分段/支线勿命中错缓存）；环线只回半圈→queryRingLine/逐段。
- `queryRingLine / queryLineBySegments / queryLineStopsByPOI`：环线/逐段/未开通 POI 站表。queryLineStopsByPOI 需**正向线证据或 opts.stations 白名单**，拒出入口/铁路/公交。
- `queryUnopenedLine / queryConstructionLine`：在建/未开通（poiTipsSearchlite）。
- `queryAMapSubwayWeb / queryLineByBusAPI / parseAMapSubwayData / subwayDataUrl`：专题/公交 API/解析。
- `queryOsmOverpass / queryLineOsm / parseOsmMetroData`：OSM（优先游戏内 OSM API，回退公共 Overpass）。
- `queryTramLine(city,lineName,{stations})`：有轨整线（必传官方站名表防混入）。
- `queryTransferStops(city,from,to,lineName)`：逐段 SUBWAY path+stops（环线跨2站查询用）。
- `compareSources / checkLineCompleteness / formatLineTable`：多源对比/完整性/表格。
- `detectOsmShift / fixOsmShift`：切引擎坐标错位（>150m 判错位）检测/修复。
- `getLines / findLine / clearQueryCache`；`decodeTileGeom / parsePoiTileForLines`：瓦片几何/POI 瓦片。

---

## 4. OD · od.js — 官方绘制/检查/支线/环线/换乘

- `createLine(name) / finishEdit() / _finalizeLine(id)`：建空线/退出编辑/统一收尾（防卡顿）。
- **`drawLine(id,stations,fitNodes,{isRing,zoom,...})`**：逐站官方 place 绘制；fitNodes 提供则用之（跳过高德慢查询）；isRing 末尾 completeRingLine 闭合。
- `fastDraw / applyLineData(id,stations,nodes,{city,order,verifyCoords,selfCheck})`：快速/数据统一写入。applyLineData 环线 segCount=N（含闭合段），逐段拟合+绕路检测(_chainRatio)+统一站台避让(④b)。
- `drawStations / drawNodes`：放站/放节点（官方）。
- `setLineProps(id,city,no)`：色/车型/编组/限速（官方 UI）。
- `rebuildNodesFromAmap(city,id,{density}) / densifyAnchors`：高德重建/加密节点。`curvatureThin/adaptiveDensity/densityOpts` 委托 MT。
- `queryLinePaths(city,line,no)`：该线 SUBWAY path 合并=**坐标基准**（站骑本线 dev≈0）。
- `resolveCoordTwice(city,names)`：两次查询防错配（偏差≤120m 正常）。
- **`checkLine3x(id,{strict})`**：四检（结构/坐标/视觉/走向）。`verifyLine/verifyLineOrder/inspect`。
- `hasNodeOrderIssue(line,i)/fixNodeOrder/_projectSort`：折返>120°或中点偏>500m=乱序→修复/投影重排。
- **支线**：`startBranch(mainId,startStation)`(官方 startBranchLine)→`applyBranchData(branchId,stations,{city,order,rebuildNodes})`→`setBranchAnchors(branchId,fitNodes)`(写入前 pad)→`finishBranch`。`checkMainLine/pickLongest`(选最长支为主)。
- 换乘：`autoTransfers(id,{city})/autoTransfersBulk/transferViaAmap`；`renameStations`。
- `_disableSnap/_restoreSnap`：吸附开关（内部）。

---

## 5. K · k.js — 批量/快照/风险/命名/地区

- 快照/回滚/审计：`snapshot(label)/listSnapshots()/rollback(idx)/clearSnapshots()/listAudit()/clearAudit()`。改前必 snapshot；deleteLine 内置快照。
- 风险：`riskLevel/riskDesc/confirmDangerous/allowDangerous/resetDangerous/showRiskDialog`。RED 未确认不执行。
- 选项：`setOpts({density,namingRule,...})/opt(k)/resetOpts()`。
- 线管理：`getLines/getLine/findCityLine/deleteLine/deleteCityLine/configureLine/fixLine/setLineStatus/rebuildGeometry/repaint`。
- 坐标/命名/配色：`calibrateCoordinates/calibrateFromAmap/resolveLineCoord/calibrateStationToLine/applyStationNames/applyNaming(rule)/applyOfficialColors`。
- 节点/换乘：`addNodes(id,null,{density})/fixTransfers/applyTransfer/separateTransferStations`(换乘站坐标独立)。
- 地区/分类：`regionOf/regionKeyOf/regions/linesByRegion/REGIONS/SPECIAL_LINES/status`。批量 `placeStations/geocode`。

---

## 6. Ops · ops.js — 客流/排班/票价/收益
- `hourlyDemand(id)`：1440 分钟客流窗口聚合。`flowStatus()/refreshFlow()`：客流健康/刷新（零客流站/加载提示）。
- `recommendSchedule(line,{maxTrains,legIndex})/applySchedule/restoreSchedule`：三档排班；**无样本档保留当前服务**(unobservedSlots)；多交路逐 leg。
- `readFares()/recommendFares({creative})/applyFares(rules)/fareModel(max)`：**management 默认官方五段 1/2/3/4/5**（边界0/6/12/22/32/∞，对齐成本带/补贴）；creative:true 才用需求弹性1.05/阶梯。
- `audit()`：每线一次聚合（客流/拥挤/净额）。`recommendNetwork/applyRevenuePlan/optimizeRevenue`：综合票价+排班+快车+小交路（多交路需 legIndex）。
- `revenueSnapshot()/revenueDelta(a,b)`：区间营收（pending 桶差）。`applyExpress/applyShortTurn`：额度内（expressLines total-used 上限；小交路仅单交路+覆盖连续）。

## 7. OE · official-edit.js — 经营编辑/额度/监测
- `observe()/startMonitor/stopMonitor`：全量监测（余额/配额/报价/客流/ledger/通知/模态）。`notifications/readToasts/installNotifyLog`：读游戏通知。
- `officialSpec/applyProps/auditConfigs`：配色编组确认。
- **`economyPlan({includeOperations})`**：额度缺口+递增报价+`dailyReserve`+`usable=balance-dailyReserve`+nextLine.reserve；`includeOperations:false` 跳过客流全扫。`quotes`。
- `startQuotaBuyLoop/stopQuotaBuyLoop/quotaBuyLoopStatus`：自动购包（只用余额、留日结、达标停）。
- `buildLine/extendAtTerminal/branchStart`：官方建/末端延长/支线。`redrawAsSingle`：断线单线重绘。`autoTransfers`。

## 8. FareLab · fare-lab.js — 票价实验
`snapshot(label)/history(n)/latestNet`：记录规则+整点净额+余额。`current/setBands`：读/改阶梯。`candidates/applyCandidate/compare`：候选对照试验。`clear/exportJson`。

## 9. Modes / HsrProbe / AirProbe — 多模式预留
mode-registry：register/get/list/current/state/supported/reserved（metro/hsr/air 适配器契约）。hsr-probe/air-probe：`state()/entrypoints()` 只读探测配额与官方入口（不写入）。

## 10. PlanMap · plan-map.js + plan-map.py — 规划图复刻
- JS `prepare(compiled,index,real)`：real={stations,nodes,paths} 几何现实优先（真实节点>真实 path>图纸 Chaikin 平滑链）；门禁坐标范围/端点≤1m/节点数≤段长/30+8；委托 fitSegmentNodes+curvatureThin+pad。
- JS `draw(plan,{cityKey,localOnly})`：仅隔离创意普通线；官方建线/属性/首站 placeStation/后续 onMapRightclick+executePlaceModeStationClick/命名队列/≥2站确认；partial 不自动删线。
- JS `check(lineId,plan)`：站序/节点/色/spec/避让100m/写回≤2m/pending 空。
- Py CLI `prepare`(缩图)/`compile`；`fit_transform`(≥3不共线锚点+≥2独立验点 SVD 仿射≤250m+凸包禁外推)、`trace_segment`(Lab 色带+距离变换+A*+via，覆盖≥65%、gap≤2*bridge+3、无直线兜底)、`chaikin`(去栅格阶梯)、`project/compile_plan`。

## 11. MetroAutopilot · autopilot.js — 全自动经营托管
- `start({intervalMs,maxTicks,buyPacks,dryRun,optimizeOperations,analysisEvery,onAnalysis})/stop()/status()`：有界循环；仅 management+metro+非编辑。
- `tick(opts)`：快照→官方五段票价→逐交路排班(保守上限)→额度内快车/小交路→递增购配额(留日结)→官方恢复→区间营收复核→日志。
- **`optimizeCycle({maxDepth,intervalMs,eps})`**：自递归 tick→adaptStrategy(改进放宽/劣化收缩,爬山+收敛3次)→递归；LIMITS 边界(perLineCap4-16/perLineInc1-8/maxNewExpressShort0-2/buyPacks1-3)。
- **AI 升级**：营收劣化/客流未加载/连续劣化≥2/周期 → pendingAnalysis+onAnalysis；宿主 spawn 智能体→`resolveAnalysis({fare,schedule,strategy})` 回写(受边界)恢复。`strategy()`。

## 12. 其它脚本
coordinate-transform.js/.py：gcj2wgs/wgs2gcj/gcj2bd/bd2gcj/wgs2bd/bd2wgs。fetch_subway_data.py：抓高德 srhdata（--out 相对路径）。audit-game-features.js：功能矩阵审计。

## 13. 回归（_dev/）
test-plan-map.py(10) / test-plan-poi.js(17) / test-plan-draw.js(45) / test-autopilot.js(11) / test-branch-ring.js(3) / smoke.js / lint-static.js。改几何必跑全量。
