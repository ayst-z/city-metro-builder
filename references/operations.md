# 运营手册：客流 → 排班 → 票价 → 经营（2026-11-09 实机）

> 数据来源：`MetroOps` + 游戏全局函数 + 真实 UI 操作。所有数值为 AnyCity 测试档实测，正式存档需重新测。
> 核心结论：**收入最大化票价约 1.0–1.1（官方弹性）**；排班必须按分时客流与往返时间反推；票价对客流的实际抑制需要 OD overlay 激活。

## 1. 客流数据

| 数据 | 位置 | 说明 |
|---|---|---|
| 线路 24h 客流 | `line.flow.byHour` / `flowDashboardComputeLineFlow24h` | 稀疏数组；早期小时为 null |
| 站点分钟客流 | `station.flowByLine[lineId].boardedWindow` | **1440 分钟数组**，最可靠；按小时求和 |
| 站点汇总 | `station.flow.{in,out,on,off}` / `entrySumToday` / `boardedSum` | 当日累计 |
| 线路 24h 总量 | `line.flow24h` | 数值 |
| 需求时段 | `station.demandByHour` | 24 项（可能为空，回退 boardedWindow） |

```js
MetroOps.hourlyDemand(line)  // {hours[24], total, peakHourDemand, minuteWindow}
```

## 2. 排班（分时列车数）

### 2.1 公式

```text
往返分钟 R = calcLineHeadwayMin(1, line)
单列容量 C = getTrainCap(line)            // B型6节=1560
负荷系数 L = METRO_TRAIN_OPERATIONAL_LOAD_FACTOR  // 1.1
所需列车 n = ceil(peakHourDemand × R / (60 × C × L))
间隔 h = R / n
```

`MetroOps.recommendSchedule(line)`：按 24h 客流的 25/75 分位分 `peak/off/low`，输出 `{peak,off,low}`、间隔、当前值。
`MetroOps.applySchedule(line, rec)` → 返回 `original`；`MetroOps.restoreSchedule(line, original)` 还原。
底层写入：`applyRouteLegSlotCount(line, legIdx, 'peak'|'off'|'low', 'local', n)`（腿级 `freqPeak/freqOff/freqLow`）。

### 2.2 实测

- 创意档无锡1号线：高峰 26k 人/时，推荐 **25/16/10**（当前 12/8/8），间隔 3.9/6.1/9.8 分钟；应用后复核一致。
- **自动模式会覆盖手动值**：关闭 `#line-info-btn-auto`（移除 `is-active`）后 11/10/8 精确还原；开启时平峰 10 被调成 9。
- 新线默认 0 列不会产生客流；先设基线排班（按目标间隔 4/8/12 分钟反推）列车才会运行。
- 经营 3 站测试线：仅 07 点有 353 人，推荐 1/0/0；说明**不足一天的数据不能做最终排班**，先保底 1/1/0，跑满一天再优化。

## 3. 票价（利润最大化；2026-11-10 实机修正）

### 3.1 官方弹性与成本带

```js
metroFareDemandPenaltyForFare(fare, baseline)  // baseline: 国内 0.75
// fare/baseline <=1: 1+(1-a)/(1+11.5*(1-a))，上限约 1.08
// fare/baseline >1 : exp(1-fare/baseline)

// 官方默认票价（5 段）与单程服务成本（元/人次）逐段对应：
//   0–6km   fare 1  cost 0.45
//   6–12km  fare 2  cost 1.30
//   12–22km fare 3  cost 2.15
//   22–32km fare 4  cost 3.00
//   32km+   fare 5  cost 3.80
```

结算公式（`app.js metroEconomyAccrueHourly`）：

```js
fareRevenue += trips * fare;                       // 按 OD 距离段票价
serviceCost += trips * serviceCost(distanceKm);    // 按同一距离段成本
operatingSubsidy += trips * max(0, fare - serviceCost) * 1.8;
net = fareRevenue + operatingSubsidy - serviceCost - 其他运营 - 维护;
```

- **只看“收入指数”（fare×需求系数）会得出 1.05 最优的错误结论**。计入成本与补贴后，票价与成本带对齐才赚钱：
  - 3 段 `1.05/1.10/1.15` 把 12km+ 长途压到 1.15，而成本 2.15 → 长途无补贴、利润被成本吃掉。实测 10 线网高峰小时净额仅 **-5k ~ +1k**。
  - 3 段 `3/4/5` 又把 0–6km 短途抬到 3（成本 0.45），需求系数仅 0.042 → 客流枯竭。实测小时净额 1–3 万，低于官方五段。
- **结论：经营档长期票价用官方默认五段 1/2/3/4/5**；`OPS.recommendFares` 的 1.05 结论只适用于“忽略成本/补贴、只看票款”的创意小网络。
- **禁止低于成本的补贴套利**（如 0.5 元全程）：虽然 `1.8×成本差` 会让补贴变大，但属于刷补贴，违反合理票价铁律。
- 写入：`MetroEconomy.setFareRules('metro', rules)` + `metroApplyFareRulesChanged()`；`MetroOps.applyFares(rules)` 封装。
- **票价是全网 metro 规则**，不是单线；应用前记录原规则以便还原。

### 3.2 实际生效条件（关键）

- 票价→需求 overlay 需要 `G.hourlyODBase` 非空 / `_metroFareDemandOverlayActive=true`。
- 经营大网络实测 `od=false/overlay=false`（`flowStatus().hourlyOD=false`）时，票价改动仍会按新规则结算，但需求曲线不立即重算；改价后至少等 **1–2 个整点结算**再用 ledger 净额判断，不要用上一小时的票款/人次反推。
- 判断票价是否真的生效：`ledger` 最近一条 `fareRevenue/fareTrips`。官方五段生效后均值应约 **1.8–1.9 元/人次**（短途 1、长途 2–5，按距离分布）；若仍是 1.09 说明还是旧的 1.05 阶梯。
- 需要真实反馈时：经营模式 + OD 数据就绪（更大网络/真实城市档）后重测。


| 方案 | 生效后高峰小时净额 | 说明 |
|---|---|---|
| 1.05/1.10/1.15（3 段） | -5k ~ +1k | 成本 ~1.2/人次，长途无补贴，几乎打平 |
| 3/4/5（3 段） | 1–3 万 | 短途票价过高，客流仅 3–5% |
| **1/2/3/4/5（官方 5 段）** | **+7.4 万 ~ +20.7 万** | 与成本带对齐，长短途都有正贡献 |
| 0.75 全程 | 高峰约 +0.1 万 | 补贴接近但客流不足以抵消成本，不推荐 |

**排班与票价是乘法关系**：官方五段下早晚高峰客流最大，必须同步加车/提频；否则 `maxWaiting` 触顶 4000、站点拥挤（crowdedStations>0）会抑制需求。

## 4. 经营模式

### 4.1 进入与状态

- 创意→经营不能原地切换（`setMetroEconomyModeDirect` 会提示 `save_mode_incompatible`）；正确路径：退出到选档 → 经营模式 → **直接进入**（新档）。
- 初始：余额 **$6,800,000**；配额 **20 km / 16 站 / 54 车厢 / 0 快线**。
- 关键 API：`MetroEconomy.getState()`、`getFinanceSnapshot()`、`getFareRules()/setFareRules()`、`metroRulesActive()`、`metroPurchaseQuote({system:'metro',quotaKey},amount)`。
- 新档默认 **暂停**（`G.paused=true`）：`togglePause()` 恢复；`setSpeed(60,document.body)` 加速（最大 200×）。

### 4.2 建线成本/配额

- 3 站测试线（堰桥-锡北运河-西漳）：配额消耗 **km 3.8 / 20、stations 3 / 16、cars 0 / 54**；余额不变（建线消耗配额，购买才扣钱）。
- 购买目录：里程 10km=$300,000；车站 5 站=$150,000；车厢 6 节=$60,000；快线 1 列=$360,000。
- `pending` 指标：`fareRevenue / fareTrips / departures / passengers / seats / trainKm / carKm / serviceCost / operatingSubsidy`。
- **pending 按小时桶重置**：跨整点比较会出现负增量；实验必须在同一小时内对比。
- 整点结算：实测 08:00 余额 +$556（票款+补贴-成本的一部分），`getState().ledger` 可查明细。

## 5. 运营实验协议（可复用）

1. 选一条有客流的线（或先设基线排班并跑满时段）。
2. 记录 `simMin` 与 `pending` 基线；等待固定真实时间（同小时内）。
3. 只改一个变量（排班或票价），记录 `original`。
4. 再等同样时长，比较 `fareRevenue/fareTrips/passengers/departures/serviceCost/carKm`。
5. 还原或保留（收入优先保留 1.05；排班需全天数据后再定）。
6. 保存 + 暂停：`top.downloadLocalSave()`、`setSpeed(1)`、`togglePause()`。

## 6. AnyCity 世界限制（实测）

- 但 AnyCity 人口仅集中在入口（无锡附近）：**上海/苏州线路 `flow24h=0`**，只有无锡1号线有客流。这不是绘线错误，是测试世界人口/OD 限制。
- 要测试上海/苏州真实客流，需要真实城市存档或更大人口/OD 的世界；不要用调试接口伪造客流。

## 7. API 速查

```js
MetroOps.hourlyDemand(lineId)
MetroOps.recommendSchedule(lineId,{maxTrains:30})
MetroOps.applySchedule(lineId, {peak,off,low})
MetroOps.restoreSchedule(lineId, original)
MetroOps.readFares()
MetroOps.recommendFares({goal:'revenue'})
MetroOps.fareModel(maxFare)
MetroOps.applyFares(rules)
MetroOps.audit()

applyRouteLegSlotCount(line, legIdx, slot, kind, count)
readRouteLegsFromLine(line)
calcLineHeadwayMin(trains, line)
getTrainCap(line)
MetroEconomy.getState/getFinanceSnapshot/getFareRules/setFareRules
metroQuotaHandlePurchase('km'|'stations'|'cars'|'expressLines', units)
openMetroQuotaPurchaseCenter()
line.expressStops / line.expressCaps
migrateLineExpressConfig(line); rebuildLineExpressPreference(line)
line.routeLegs + ensureRouteLegIds + validateRouteLegsCoverage
OPS.recommendNetwork / applyRevenuePlan / optimizeRevenue
OPS.revenueSnapshot / revenueDelta
togglePause(); setSpeed(60, document.body)
```

## 8. 配额购买（余额换配额，2026-11-09 实测）

- 入口：HUD `#metro-quota-dock`；`openMetroQuotaPurchaseCenter()`；写入 `metroQuotaHandlePurchase(key, units)`（key：`km` / `stations` / `cars` / `expressLines`）。
- 目录：里程 10km=$300,000；车站 5 站=$150,000；车厢 6 节=$60,000；快线 6 节=$360,000。
- 购买后 `total/purchased` 增加、`used` 不变；**建线消耗 km/stations，快车会消耗 cars（实测 used 8）**。
- 建议：保留 30–40% 余额做运营；按 10km/5 站批量购买；快线额度只在有长走廊/高需求线时买。

## 9. 快慢车（Express）

```js
line.expressStops = [0,3,5,7,8];          // 站索引（≥2），端点+中间停靠站
line.expressCaps = { peak:1, off:0, low:0 };
migrateLineExpressConfig(line);
rebuildLineExpressPreference(line);
lineHasExpress(line); getExpressRouteLeg(line); getExpressCaps(line);
```

- 实测上海2号线：停 龙阳路/世纪大道/陆家嘴/人民广场/南京西路，峰值 1 列；`lineHasExpress=true`，`reservedTrainCount=1`，快车消耗 cars 额度（used 8）。
- 快车与慢车独立计数；快车停站少、适合长走廊；短途线收益有限。
- 快线额度 `expressLines` 通过配额购买获得（1 单位=6 节）。

## 10. 交路 / 短交路

```js
legs = readRouteLegsFromLine(line);        // [{id,startIdx,endIdx,freqPeak,freqOff,freqLow}]
line.routeLegs = legs.concat([{ id:'rl_short_3_8', startIdx:3, endIdx:8, freqPeak:2, freqOff:0, freqLow:0 }]);
ensureRouteLegIds(line.routeLegs);
validateRouteLegsCoverage(line,line.routeLegs);   // null=连续覆盖；允许重叠
applyRouteLegSlotCount(line, lastLegIdx, 'peak', 'local', 2); // 持久化
```

- 规则：**允许重叠**（`validateRouteLegsOverlap` 恒 null），但 min→max 区间必须连续覆盖，不能有空洞。
- 实测上海2号线：主线 0–8 + 短交路 3–8（世纪大道→南京西路）峰值 2 列；游戏自动把短交路平峰/低峰调到 1；覆盖连续，成功。
- 短交路用于高需求区段加运力；拆成不连续交路会报 coverage_gap。

## 11. 阶梯票价（tiered）

- **经营档正确做法：直接用官方默认五段 1/2/3/4/5**（边界 0/6/12/22/32/∞），与官方成本带 0.45/1.30/2.15/3.00/3.80 一一对应；这就是补贴规则下的利润最优结构。
- 不能只看 `OPS.recommendFares` 的“收入指数”：它不含 `serviceCost` 和 `operatingSubsidy`，会把票价推荐到 1.05，实测净额接近 0（见 §3.3）。
- 若要自定义阶梯：**每一段票价必须 ≥ 同段服务成本**，否则该段没有 1.8× 差额补贴、纯亏；也不要刻意把票价压到成本以下去吃补贴（违规）。
- 应用：`OPS.applyFares({policyVersion:'metro-economy-20260919-v2',mode:'distanceStep',distanceBands:[{fromKm:0,toKm:6,fare:1},{fromKm:6,toKm:12,fare:2},{fromKm:12,toKm:22,fare:3},{fromKm:22,toKm:32,fare:4},{fromKm:32,toKm:null,fare:5}]})`；全网 metro 规则。
- 改价后等 1–2 个整点，用 `ledger` 的 `fareRevenue/fareTrips ≈ 1.8–1.9` 验证生效；仍为 1.09 说明还是旧阶梯。
- **小数票价会被截断（2026-11-10 实测，硬规则）**：写入 `1.2/1.4/1.6/1.8/2.0` 后，23:00 结算人均票价仅 **1.525**、补贴/人次 **0.10**、净额 **-178,336**；同网络整数 `2/3/4/5/6` 写入后 00:00 人均 **3.619**、补贴/人次 **3.229**。FareLab **1.0.1** 起拒绝小数票价（返回 `fare_must_be_integer`）。只允许整数票价；改价前 `FL.snapshot`，保留 `official5` 回滚。
- **整数上调同样不划算（2026-11-10 早高峰实测）**：`2/3/4/5/6` 在 07:00 净额 **91,755**（官方五段前一日 262,824）、08:00 **351,834**（前一日 690,364）；人均票价升到 3.8+，但客流大幅下降，净额反而腰斩。**官方五段 1/2/3/4/5 仍是当前版本最优**；FareLab 的 `int2/mid2/high3` 已标注“实测客流下降，不推荐”。需求不是完全无弹性，不能用涨价刷收入。恢复官方五段后 10:00 净额 **584,204**、人次 **340,785**，客流回归。
- 需求 overlay 未激活时，改价不会立刻改变需求，但结算按新票价走；不要用改价后第一小时的票款判断客流量。

## 12. 综合收益优化器（票价+列车数+快车+短交路）

```js
OPS.recommendNetwork({ lineIds? })   // 每线排班+快车+短交路建议 + 全网票价
OPS.applyRevenuePlan(plan)           // 应用（短交路覆盖不连续会回滚）
OPS.optimizeRevenue({ lineIds? })    // 一键推荐+应用
OPS.revenueSnapshot(); OPS.revenueDelta(a,b);
```

建议循环：
1. `snapshot` → `optimizeRevenue` → 等同一小时固定时长 → `revenueDelta`。
2. 看 `net = fareRevenue + operatingSubsidy - serviceCost`；变好保留，变差回滚（`restoreSchedule`/恢复 fares/删短交路）。
3. 每小时/每天重复；长途需求变化时切换 tiered/flat。
4. 实测上海经营 3 线网（1/2/9 中段）：2 号线加短交路+快车后 flow 35.3 万、1 号线 21.6 万、9 号线 7.8 万，换乘 1.55 万，余额 5.90M；配额 28.82/40km、25/26 站、快线 6。

## 13. 经营档保存/暂停

- 默认不主动存档、不触发下载或保存快捷键；修改前使用会话内快照。暂停/恢复走官方 `togglePause()`；不抢前台操作滑块。
- **调速硬规则（2026-11-10 用户要求）**：速度必须走官方函数 `top.setSpeed(v, el)`（写入真实字段 `G.simSpeed`）；`G.speed` 是过期字段，直接赋值不生效。调速后核对 `G.simSpeed` 与滑块气泡。
- 存档为浏览器默认下载目录下的 `城市设计师_*.mbenc`（官方加密本地存档）。

## 14. 管理扩张进度与经济门槛（2026-11-10）

  - 1 号线：莘庄—富锦路（28 站，单线重绘；含上海南站、徐家汇、人民广场、上海火车站）
  - 2 号线：虹桥火车站—龙阳路（18 站；静安寺↔14、南京东路↔10、人民广场↔1/8）
  - 3 号线：上海火车站—江杨北路（17 站；上海火车站↔1）
  - 5 号线：莘庄—闵行开发区（11 站）
  - 8 号线：市光路—沈杜公路（30 站）
  - 9 号线：九亭—世纪大道（17 站；佘山段已排队待建）
  - 10 号线：基隆路—龙阳路方向（23 站；南京东路↔2、四平路↔8、天潼路↔12）
  - 12 号线：龙华中路—金海路（22 站；汉中路↔1、曲阜路↔8、天潼路↔10）
  - 13 号线：世博会博物馆—华夏中路（15 站）
  - 14 号线：武定路—桂桥路（18 站；静安寺↔2、豫园↔10、陆家嘴↔2）
  - 新建缺失段线（端点接续，后续可继续延长）：13 号线北段线（南京西路—金运路 14 站，已贯通，汉中路↔1/12）、14 号线西段线（武定路—封浜 13 站，已贯通）、12 号线西段线（龙华中路—七莘路 11 站，已贯通）、10 号线西段线（陕西南路—虹桥火车站 12 站，已贯通并与 2 号线共站）、2 号线东段线（龙阳路—浦东1号2号航站楼 12 站，已贯通；东段高德无数据，用 OSM 引擎）、、3 号线南段线（上海火车站—上海南站 13 站，已贯通；5 号线南段线 东川路—奉贤新城 9 站（已贯通）、16 号线 龙阳路—航头东 6 站（龙阳路↔2、华夏中路↔13）、15 号线 紫竹高新区—永德路 2 站起步；苏州 1 号线 木渎—钟南街 24 站（已全线贯通）、苏州 2 号线 骑河—桑田岛 35 站（已全线贯通，广济南路↔1）；中山公园↔2、金沙江路↔13、曹杨路↔14、虹桥路↔10、宜山路↔9、龙漕路↔12、上海南站↔1）
- 换乘：人民广场/南京东路/世纪大道/南京西路/陕西南路/嘉善路/豫园/一大会址/静安寺/上海火车站/四平路/虹口足球场/汉中路/曲阜路/天潼路/陆家嘴等。
- **配额快照是嵌套结构（2026-11-10 实测）**：`MetroEconomy.getFinanceSnapshot().quotas` = `{ metro, hsr, aviation }`；`OE.economyPlan` 必须读 `quotas.metro`，否则会把 `free` 全部算成 0。高铁/航空额度已存在但未使用：HSR `routeKm 1000`、三/二/一等站 6/3/1、G 型车 24；航空 `flights 12`、`routeKm 3000`、`aircraft 5`、`bases 1`。多模式预留读数见 `HsrProbe.state().quotas` / `AirProbe.state().quotas`。
- **预算算法（OE 1.1.6）**：按“下一线额度缺口”给最小购买包，不再按全网车辆缺口一次推荐 62 包。示例：下一线苏州 7 号线需 25 站/35km/6 车；当前空闲 13 站/82.37km/0 车 → `need={stations:12,km:0,cars:6}`、`packs={stations:3,km:0,cars:1}`，推荐先买车站包（每包 5 站），不足则给出 `save` 差额。
- **逐步扩张循环（唯一合法路径）**：
  1. 票价固定官方五段；高峰排班至少覆盖需求，避免 `maxWaiting=4000`。
  2. 200× 跑量，`MetroEconomy.getFinanceSnapshot().balance` 与 ledger 最近小时净额监控。
  3. 余额 ≥ 报价才买 km/stations/cars：`MetroEconomy.dispatch('quota.purchase',{system:'metro',quotaKey:'stations'|'km'|'cars',quantity:1,simDay,simMin})`（`metroQuotaHandlePurchase` 对 item id 解析失败，直接用 dispatch）。
  4. 暂停 → 快照 `CityMetroKit.snapshot('before-xxx')` → 高德实时查询延长段 → 布站/改名 → 节点 → 交路同步 → `checkLine3x` → 保存。
  5. 建换乘（共站或 `_applyAutoPassageTransferBetweenStations`）→ 跑满一小时复核 flow → 重复。

### 14.1 官方延长线作业（实测可用）

```js
// 1) 高德实时取延长段（起=当前端站，终=目标站）
const q = await MT.queryLine('shanghai','2',{engine:'amap',stationFrom:'南京西路',stationTo:'北新泾'});
// q.stations 含起点；newStations = q.stations.slice(1)
// 2) 布站（追加到线路末端；进入 add-station 模式）
await OD.drawStations(lineId, newStations, {stationDelay:80});
// 3) 改名（关键）：游戏会把站吸附到线形上并按最近 POI 命名，可能错名（实测 静安寺→湖南路）
OD.renameStations(lineId, fullOfficialNames); // 用原站名 + q.stations 官方名拼全量
// 4) 节点：旧 anchors 前 oldN-1 段 + q.nodes
await OD.drawNodes(lineId, oldAnchors.slice(0,oldN-1).concat(q.nodes)); // 需 window.__DANGEROUS_CONFIRM.drawNodes=true
// 5) 交路：单交路/多交路都同步到新末端
top.syncSingleDefaultRouteLegForLineGeometryChange(line,{prevStationCount:oldN,extendFromStart:false});
top.persistRouteLegsOnLine(line);
// 6) 四检
await OD.checkLine3x(lineId,{city:'上海'});
// 7) 关键：清掉编辑遗留的客流权威缺口（否则列车空跑、整点票款=0）
top.metroFinishPassengerAuthorityGap();
top.metroShouldSuspendPassengerGeneration();   // 期望 false
MetroOps.refreshFlow();                        // 重算并重建客流
```

- **必查 `G._metroPassengerAuthorityGap` / `G._metroPassengerGenerationSuspended`**：drawStations/drawNodes/finishEdit 在暂停态下可能留下 edit gap，导致后续数小时 `fareRevenue=0 / fareTrips=0 / departures=0`，但运营成本照扣（实测一次损失约 6 个模拟小时）。症状：ledger 连续小时 rev=0、pending departures 不增长；修复：结束编辑 → `metroFinishPassengerAuthorityGap()` → `metroShouldSuspendPassengerGeneration()` → `OPS.refreshFlow()`，等 1–2 分钟确认 pending 有客流。页面整体重载后重新注入工具包也可恢复。
- **端点方向护栏（2026-11-10 实测事故）**：高德 `queryLine(stationFrom=当前端站, stationTo=目标)` 有时会反向解析（实测 14 号线 `黄杨路→金吉路` 只返回 `蓝天路`，插到线尾造成折返）。正确做法：**从线路首站查到目标站**，在结果中找到当前末站索引 idx，取 `stations.slice(idx+1)` 与 `nodes.slice(idx)`；找不到末站就中止。`__extendEnd` 已按此加固。
- **批量自动扩张**：页面侧 `__autoRun(queue)` 会按队列逐段：查客流/距离 → 等余额 ≥ 报价 → `top.togglePause()` 暂停 → 买 stations/km 包 → `__extendEnd` → 清 gap → `top.togglePause()` 恢复。日志在 `window.__autoState.log`；任一段 `pass=false` 立即停止。只在经营模式、只用余额购买时使用。
- **禁止 1 站临时线**：新建缺失段线时必须一次放 ≥2 站（端点共享站 + 至少 1 个新站）；只有 1 站的新线会让 `metroHasUsablePassengerAuthority()` 变 false、全网整点票款/客流归零。修复：`top.deleteLine(lineId)` 删除并返还额度，再 `metroFinishPassengerAuthorityGap()` + `OPS.refreshFlow()`；删除后 usable 恢复 true。
- **误插站回退**：用官方删除流程 `_applyRemoveStationFromLine(line, idx)` + `calcLinKm` 前后差算 `releasedKm` → `metroEconomyCommitQuotaRefund('metro.station.delete.commit',{...})` 退站/里程额度，再用完整区段 `queryLine` 重建 segmentAnchors；删除后 `syncSingleDefaultRouteLegForLineGeometryChange(line,{prevStationCount,removing:true,extendFromStart:false})`。不要直接 splice。

- **只从末端延长**：`drawStations`/`placeStationInAddModeAtLatLng` 只在末端追加；向起点方向延长会被拒绝（实测 3 号线上海火车站无法用 drawStations 前置）。
- **起点延长**：先在线路末端布好新站，再用 `top._insertStationObjectIntoLine(line, stationObj, 0)` 插入已有站对象（共站/换乘），并用**完整区段** `queryLine(from,to).nodes` 重写全部 segmentAnchors；否则旧 anchors 会错位（实测折返 300–800%、ratio>4）。插入后 `syncSingleDefaultRouteLegForLineGeometryChange(line,{prevStationCount,extendFromStart:true})`。
- **共站换乘**：新站坐标与另一线已有站相同（AMap 同一坐标）时，游戏会复用同一 station 对象 → 自动共站；若生成两个对象（吸附偏移/命名不同），用 `top._applyAutoPassageTransferBetweenStations(a,b,{})` 建组。
- **命名**：`drawStations` 后必须 `renameStations`，否则可能出现“湖南路”这类最近 POI 名。
- **配额**：每次延长前先买足 stations/km；km 用量在几何收尾后更新，可能延迟一小时，预留 ≥2km 余量。
- **保存**：延长+四检 pass 后 `top.downloadLocalSave()`。

## 14.2 官方延长/支线接口（2026-11-10 用户硬规则）

- **延长既有线必须用官方延长接口**：`top.startExtendLine(line, terminalStation)` → 由 `G.extendFromStart` 决定从首站/末站延长 → 在 `G.editMode` 下按官方放站流程逐站添加（`placeStationInAddModeAtLatLng` / 官方地图点击）→ `finishEdit(lineId)`。**不得再新建“东段线/南段线/西段线”代替延长**；历史遗留分段线待后续用官方延长合并。
- **支线必须用官方支线接口**：`top.startBranchLine(line, station)` 进入支线流程，配合 `OD.startBranch` / `setBranchAnchors` / `finishBranch` / `applyBranchData`；不得用独立线或直连主线代替支线。
- **批量放站要小步**：每次 3–4 站，逐批核对末站名；一次放 20+ 站会触发 CDP 超时/插入顺序错乱（2026-11-10 18 号线事故：段 11/13/15 折返，ratio 4.9–11.5）。
- **站序错乱修复**：`top.deleteLine(lineId)` 返还车站/里程额度 → 重新 createLine → 3–4 站/批重建 → 全量 rename + drawNodes + 默认交路 → `checkLine3x` → `metroFinishPassengerAuthorityGap()` + `OPS.refreshFlow()`。
- 18 号线重建后 26 站四检通过，换乘：莲溪路↔13、龙阳路↔2、江浦公园↔12、江浦路↔8、国权路↔10、长江南路↔3。

### 14.3 全量审计结果（2026-11-10）

- 22 条线全部 `checkLine3x` pass，交路均覆盖全线；410 站在客流窗口内就绪、零客流站 0。
- 8 组分段线与父线接续点均连通：2/1/5/10/12/13/14 为共站，3 号线上海火车站为同 transferGroup（341m 通道换乘）。
- 18 号线修复后 26 站、交路 0–25、6 处换乘，pending 票款 34.0 万 / 111.3 万人次。
- **已修复**：1 号线已重绘为单线（莘庄—富锦路 28 站），删除原 1 号线中段线/南段线；四检 pass，人民广场/陕西南路/上海火车站/上海南站/汉中路等换乘已重建。
- **遗留**：2/3/10/12/13/14 号线仍是父子分段线（功能连通），5 号线含支线，需继续用官方 `startExtendLine` 合并；其他支线用 `startBranchLine`/`OD.startBranch` 重绘。

### 14.3b 未开通/数据不全线路：查询与拟合（2026-11-10 实测）

- **结论：整线端点查询会漏段，逐站间查询能补齐。** 高德整线 transit 查询对苏州 8 号线只返回 6/28 站；改用相邻两站逐段查询后，27/27 段都拿到 SUBWAY path（179 节点，0 估算）。8 号线西段并非无数据，而是整线路由没走全。
- **数据分层（优先级从高到低）**：
  1. **逐段地铁 path**：`MT.queryLineBySegments(city,lineNo,{stations|stationNames, lineFilter})` 对每对相邻站调用 `queryTransferStops`，取 SUBWAY path → `fitSegmentNodes` + `curvatureThin` + 站台避让。实测：7 号线整线 28 站可用；8 号线 27/27 段；11 号线 13/27 段（昆山东段 14 段无 path）。
  2. **样条拟合（真正未开通段）**：`MT.smoothLineNodes(stations,{endPadM:100})`，向心 Catmull-Rom 过站、~60m 采样、站台避让；标记 `estimated`。实测 2 号线北延 4 段、11 号线东段 14 段走此回退。
  3. **直线兜底**：`fallback:'straight'`，仅在样条不适用时使用。
- **站表来源**：高德公开 srhdata（`https://map.amap.com/service/subway?srhdata=<adcode>_drw_<city>.json`）含全量官方站序与 `sl` 经纬度；苏州当前 9 线，其中 7/8/11 号线各 28 站、2 号线 35 站（不含北延 4 站）。**页面 fetch 受 CORS 限制**：用 `scripts/fetch_subway_data.py` 或本地注入 `__MT_SUBMETRO_DATA`；不要用过期本地站表当权威。
- **禁止**：srhdata 的 `f[].c` 是示意图像素路径（图式直角），不是地理走向。实测把它按站点锚定做相似变换后，相对真实 path 中位偏差 35m、p90 331m，反而比直线基线（中位 14m）更差 → 不作为拟合依据。
- **API**：
  ```js
  const r = await MT.queryLineBySegments('suzhou','8',{ lineFilter:'8号线', fallback:'spline' });
  // r: {stations,nodes,segStatus:[{i,a,b,kind:'subway'|'spline'|'straight',ratio}],fitted,estimated,warnings}
  // 也可传 stations 或 stationNames（含 alias）；真正未开通段会标记 spline/estimated
  ```
- **护栏**：① 并发默认 2、失败重试 2 次（并发 4 会触发限流，导致大量段误判回退）；② 逐段绕路比 >2.2 拒绝；③ 每段首末节点距站 ≥100m（`padSegmentNodes`）；④ 站序以 srhdata 官方顺序为准；⑤ 拟合段必须在汇报中标注“估算”，不得当真实走向。
- 实测链路：苏州 2 号线北延 爱格豪路—珍珠湖路—渭中路—朗力福大道—骑河 5 站坐标解析成功；39 站重绘后四检 pass（226 节点，站台 100m 内无节点）。

### 14.4 性能模式默认关闭（2026-11-10 用户硬规则）

- 默认**不开启** `setMetroPerformanceMode(true)`，让游戏保持正常实时渲染与客流计算；只有用户明确要求“加速/性能模式”时才可临时开启，并立即恢复。
- 建线放站用官方 `drawStations` 自身的默认行为；不要外包一层性能模式。
- 批量放站仍建议分批（每批 6–8 站）并最后统一改名/节点/交路，减少卡顿但不冻结游戏。

### 14.5 建线前配置确认与官方前缀（2026-11-10 用户硬规则）

1. **命名**：统一用官方前缀——`上海地铁X号线`、`苏州轨道交通X号线`；不得用“上海X号线”“苏州X号线”。
2. **每条线绘制前先确认官方配置**：
   - `MT.queryLine(city,no,...)` 取 `color / trainType / trainCars`；`MT.lineSpec(city,no)` 取 `maxSpeedKmh`。
   - `createLine` 后、放站前立即 `OD.setLineProps(lineId, '上海'|'苏州', no)`，确保颜色、车型、编组、限速生效。
   - 建成后复核 `l.color / l.trainType / l.trainCars / l.maxSpeedKmh`。
   - 苏州实测官方：1 号线 `#64B735 B/5`、2 号线 `#E8374A B/5`、3 号线 `#F18D00 B/6`、4 号线 `#006FBA B/6`；此前 1/2 配色被互换、编组错为 6，已修正。
3. **默认不开启性能模式**：不手动 `setMetroPerformanceMode(true)`；只有用户明确要求加速时才临时开启并立即恢复。
4. **延长/支线**：延长既有线用 `top.startExtendLine` + `top.executePlaceModeStationClick` + `finishEdit`；支线用 `top.startBranchLine` / `OD.startBranch` 系列。不得新建“东段线/南段线”代替。
5. **新建整线**：用 `OE.buildLine(cfg)`（不删线）——先 `dryRun:true` 校验站数/走向，再正式建：官方查询（整线失败自动逐段拼接）→ createLine → setLineProps → 分批放站 → 改名 → 站台避让节点 → 默认交路 → 自动换乘 → 四检 → 清客流缺口。苏 7 干跑 28 站/27 段全真实走向。
5b. **断线重绘单线流程**：官方全线 `queryLine` → 删除旧父/子线 → `createLine` → `setLineProps` → 每批 6–8 站放站（批间不改名）→ 全量 `renameStations` → `drawNodes` 全量节点 → 默认交路 → 同名<350m 自动换乘 + 关键换乘显式补 → `checkLine3x` → `metroFinishPassengerAuthorityGap` / usable 检查。
6. **车厢额度会被自动分配**：买包后 `cars.used` 常等于 `total`（既有线自动占满），新线建设前必须复核空闲车厢；不足时再买 1 包或从低客流线调车。
7. **列车与排班**：车厢额度按 6 车/包购买；`OPS.recommendSchedule` 取建议后用 `OPS.applySchedule`；再用 `OE.economyPlan()` 综合比较“车厢缺口 vs 车站+里程包”，资金优先投向能立刻提升运力或线网覆盖的一侧。加车后复核 `cars.used/free` 与拥挤通知。实测加车后小时净额转正（约 +13~50 万/小时）。
8. **不主动存档**：用户说“不要存档”时，禁止调用 `top.downloadLocalSave()`；游戏自动存档除外。
10. **已知延伸站**：高德整线漏站由 `MT.KNOWN_EXTENSIONS` 自动补齐——苏州 2 号线 head 爱格豪路、珍珠湖路、渭中路、朗力福大道；6 号线 tail 华云；版本 MT 6.5.2。

### 14.6 多模式预留（高铁/飞机，2026-11-10）

- 文件结构：`scripts/funcs/modes/{mode-registry,hsr-probe,air-probe}.js` + `modes/README.md`；当前地铁模块保持 `query/draw/manage/ops` 不动。
- 注册表：`CityTransportModes.list()` / `detect()`；`metro` 可用，`hsr`/`air` 标记 `reserved:true`，写操作一律返回 `{ok:false,reserved:true}`。
- 只读探测：`HsrProbe.state()` 读 `hsrRealworldMyRoutes/hsrRuntimeTrains/_hsrLiveStations/_hsrLiveSectionLoads/_hsrLiveEconomyInput` 与 HSR 配额；`AirProbe.state()` 读 `flightAirportColors/AirportPA` 与航空配额；入口索引见 `AirProbe.entrypoints()`。
- 实测（2026-11-10）：当前 `G.transportMode='metro'`；HSR 线路/列车均为 0，HSR 额度未用（1000km、G 车 24）；航空 `flightLayerVisible=true`、6 个机场、12 班次/周额度、5 架飞机、3000km 航线额度未用。

## 15. 合法经营铁律（2026-11-10 用户要求，禁止投机取巧）

1. **只用经营模式**：不得切自由/创意、不得用 `applyMetroGameModeState`/import 绕过配额；不得编辑存档。
2. **只用经营收益扩张**：买配额的钱必须来自余额（初始资本+运营净收益）；先查报价，余额不足就继续经营，不预支/不透支。
3. **票价合理**：使用官方默认五段 1/2/3/4/5（或 3/4/5 三段但会压低客流）；**禁止 20/100 等极端票价**、禁止把票价压到成本以下刷 1.8× 补贴。
4. **客流先体检**：每轮先 `OPS.flowStatus()`；加载提示/零窗口/异常时 `OPS.refreshFlow()`；页面重载后需重新注入六个工具包，flow 聚合有时在重载/重新进入存档后才恢复。
5. **逐步建完**：优先中央连接段形成换乘网，再用经营收益买额度延长为全线；每条线四检 pass 才计入进度。

## 16. 浏览器冻结/崩溃恢复（2026-11-10 实测）

- **症状**：`G.simSpeed=200` 但 `simMin` 不走；`document.hidden=true`；`_metroFrameDtEmaSec≈1s`（1 FPS）；或 CDP 9344 消失、9343 控制服务器超时。
- **后台保活（2026-11-11）**：仅使用生命周期与焦点模拟，不激活真实窗口；`browser/cdp-keepalive.mjs` 已移除 `Page.bringToFront`/`Target.activateTarget`。以 simMin 的真实增量判断有效速度，不保证后台仍达到设定倍率。
- **不抢前台**：禁止 Win32 恢复/前台切换、禁止自动解除最小化；窗口恢复看门狗已停止。最小化导致节流时保持后台并报告，不以抢焦点补救。
- **Edge 崩溃**：同 profile 重启 `node browser/cdp.mjs`（CTRL_PORT=9343 / DEBUG_PORT=9344）→ 城市入口点“经营模式”（`data-metro-economy-mode="management"`；其 `data-metro-game-mode="creative"` 是基础地图模式，不代表创意经济）→ “选择存档”点云端 `button[data-entry-cloud-slot="1"]` → 等 15.8MB 加载完成 → 重新注入 MT/OD/K/Ops/OE/FL/modes。

## 17. 额度自动购买循环（OE 1.1.5，2026-11-10）

```js
OE.startQuotaBuyLoop({ quotaKey:'stations', targetFree:30, maxPacks:6, intervalMs:60000, beforeSettleBuffer:700000 });
OE.quotaBuyLoopStatus();   // { running, packs, log:[{event:'buy'|'fail'|'stop',...}] }
OE.stopQuotaBuyLoop();
```

- 规则：每 60s 检查一次，逐包重新报价；仅在 `balance - buffer >= 单包报价` 时调用官方购买。`buffer=max(beforeSettleBuffer,dailyReserve)` 全天保留日结，不再假设白天一定赚回。购包 tick 用 `economyPlan({includeOperations:false})`，跳过全网排班聚合；主动运营调整另做完整审计。
- 达到 `targetFree` 或 `maxPacks` 自动停；页面 hidden/暂停时跳过；日志保留最近 30 条。
- 仅用于经营模式；不得改价/改档/绕配额；买前先查报价，报价随已购量上涨。

### 18. 苏州 8 号线实测（2026-11-10）

- 用 `OE.buildLine({useSegments:true, stations})` 一次建成：西津桥—车坊 28 站，官方色 `#A09200` / B6，交路 0–27，四检 pass，`estimated=0`。
- 换乘：白洋湾公园↔6、白荡北↔7、时代广场↔1。
- 多阶段示例：`OE.startQuotaBuyLoop({steps:[{quotaKey:'stations',targetFree:30,maxPacks:6},{quotaKey:'km',targetFree:35,maxPacks:2},{quotaKey:'cars',targetFree:7,maxPacks:1}]})`；当前阶段达标自动切下一步（日志 `event:'step'`），全部完成自动停。苏州 11 号线即用此计划：4 包车站 + 2 包里程 + 1 包车厢。

## 19. 主动运营调整（2026-11-10 用户硬规则）

- 每轮经营必须主动检查：①票价 ②车次/排班 ③小交路 ④快车 ⑤车厢购买；不得只扩张不调运营。
- 快车：`OPS.applyExpress` 已给上海 1/2/9中段/10/12/18 六条线加（`expressLines.used=6`，列车 +6），快车停站取首末 + 权重最高 3 站；额度按 `total-used` 计，最多 6 条。
- 小交路：`OPS.applyShortTurn` 给上海 2/3/10/12 加（peak 2 / off 0 / low 0），叠加既有 8/1/15/9；交路覆盖必须连续。
- 票价：官方五段 1/2/3/4/5 保留（小数被截断、整数上调压客流，均已实测）；每次改价 `FL.snapshot`，不达标回滚。
- 车厢：多阶段购包循环最后一步买 1 包；快车/小交路增加列车后复核 `cars.used/total`，不足再买。

### 18b. 苏州 11 号线实测（2026-11-10）

- `OE.buildLine` 首轮只落 24/28 站，尾部 4 站（花桥博览中心—集善—花溪公园—花桥）未落；改用官方 `startExtendLine` 在菉葭后延长补齐，最终 **28/28**。
- 尾部 4 段用 `queryLineBySegments` 补节点（部分样条估算）；27 段、交路 0–27、四检 pass；官方色 `#F1C6A6` / B6。
- 结论：**buildLine 落站数少于官方且缺尾部时，必须用官方延长补齐**；OE 1.1.7 已把该检测/补齐内置到 buildLine（`autoExtendMissing` 默认开）。
- 上海 17 号线已于 2026-11-11 建设至西岑，详见 §20；不得再把东方绿舟当作现行终点。

## 20. 上海 17 号线与编辑后恢复运营（2026-11-11）

- 默认 `queryLine('shanghai','17')` 仅回东方绿舟—虹桥火车站 13 站，但 warnings 已显示「西岑--虹桥火车站」。显式传 `stationFrom:'西岑',stationTo:'虹桥火车站'` 得完整 14 站；查询成功不等于全线完整，必须交叉检查返回线路名的终点。
- 已按官方建线绘制 13 站，再由 `OE.extendAtTerminal` 从东方绿舟延至西岑，保留同一线路 id；最终 14 站、205 节点、B6、`#BC796F`，四检及逐站顺序比对通过。
- 编辑完成后发现 `G.paused=true`、模拟分钟不变，造成零客流；确认编辑已退出后通过官方 `togglePause()` 恢复。禁止把此状态误判为经济结算器故障或直接改资金。
- 技能加载入口曾仍返回旧版，更新时必须同步实际 Skill 返回的目录并做哈希核对，不能只更新 `.copilot` 副本。
- 后续核实纠正：17号线此前 B6 是默认兜底值，真实规格为 A6/100kmh；已通过配置接口改正。6号线为 C4/80kmh。MT core 6.5.3 已补两条规格并将17号线默认起点改为西岑（node/amap 仍为6.5.2）。资料：[6号线车辆](https://www.china-emu.cn/UrbanRails/Line/310006/)、[17号线车辆](https://www.china-emu.cn/UrbanRails/Line/310017/)、[17号线速度与编组](https://zh.wikipedia.org/zh-cn/%E4%B8%8A%E6%B5%B7%E8%BD%A8%E9%81%93%E4%BA%A4%E9%80%9A17%E5%8F%B7%E7%BA%BF)。
- 6号线路径已实时查询28站，尚未建设；购包循环目标为空闲28站/35km/12车厢，最多6/3/2包，保留260万或最新日结费用中较高者，逐包报价，余额不足等待经营收益。
- 官方 `metroAutoArrangementEnabled` 已开启：按普通交路/快车分别观察载客，满载增班有10模拟分钟间隔，低于50%载客等条件下减班；它不自动重选小交路区间或快车停站，这两项仍需主动分析。夜间closed时无列车不能误判服务故障。

## 21. 递增报价与主动运营适配（2026-11-11）

- OE 1.1.8 用官方 `metroPurchaseQuote(item,packs)` 获取递增累计价；`affordableOne` 与整类包 `affordable` 分开，两者都预留日结与 nextLine.reserve。多种配额仍需合计预算，逐包重报价格。实测六包车站约 3188 万，旧单价乘六约 3106 万，不能按旧价预支。
- Ops 1.3.3 对无客流样本档保留当前服务，返回 `unobservedSlots`；1440 长度的数组不代表已采集完整一天。按样本推荐可能低估未满足需求，必须结合站台候车与满载情况。
- 每轮主动复核既有小交路起讫、各档频次、快车停站与频次、实际列车、车厢配额；局部拥堵优先局部增援，低载客配置应缩减或重新选区间。已有多交路不能用同一 schedule 覆盖所有 legs，逐交路调用官方 `applyRouteLegSlotCount`。
- 每次调整前记录快照、净额/候车/载客，调整后在可比时段验证；车厢包越买越贵，应比较优化已有车辆与购新车辆的边际收益，不以扩大总车数作为成功标准。未实测快车/短交路净收益时只报告待验证，不宣称最优。
- Ops 1.3.4：短交路/快车权重只读 `station.flowByLine[line.id].boardedWindow`，不再用混合 `station.flow`；窗口先计算各站权重后滚动求和，窗口搜索 O(n)，无样本不推荐新增短交路或快车。

## 21. 全自动经营托管 MetroAutopilot 0.3.0（自递归优化 + AI 分析升级，2026-11-12）

- 注入 `scripts/funcs/ops/autopilot.js`（Ops/OE/K 之后）→ `window.MetroAutopilot`。仅 `G.economyMode==='management'` + metro + 非编辑态可用；创意档/编辑态拒绝。
- `start({intervalMs=60000,maxTicks=240,buyPacks=1,dryRun=false})` 有界循环；`stop()`；`status()` 返回 running/ticks/last/log(近50)。每 tick：快照→票价→排班→快车/小交路→配额→恢复模拟→营收复核→日志；失败即停、超 maxTicks 自停。
- **票价模式感知（Ops 1.3.5）**：management 默认官方五段 `1/2/3/4/5`（边界 0/6/12/22/32/∞，与成本带/补贴对齐=利润最优）；创意小网络才用需求弹性 1.05/阶梯（`recommendFares({creative:true})` 显式）。托管每 tick 仅当当前≠官方五段才应用。
- **排班逐交路**：多交路线按 legIndex 逐腿 `recommendSchedule`/`applySchedule`，不把同一频次套全部腿；无样本档保留当前服务。单交路整线。
- **快车/小交路额度内**：`recommendNetwork` 给出候选，快车受 `expressLines total-used` 上限、小交路仅单交路线且覆盖连续才加；不重复加。
- **配额递增报价**：`OE.economyPlan({includeOperations:false})` 取下一缺口；每包购买前重报 `metroPurchaseQuote`，`usable=balance-dailyReserve` 且留 nextLine.reserve 才买；每 tick 限 buyPacks 包；不足即等经营收益，不预支。
- **安全**：不切模式/不改资金/不绕配额/不存档/不下载/不抢前台；每 tick `K.snapshot`；`dryRun:true` 只算不写。营收复核用 `revenueSnapshot/revenueDelta`，劣化应回滚（restoreSchedule/applyFares 旧值）并停托管复查。
- 建线不在托管默认范围（避免自动大改线网）；如需自动扩张另给 buildQueue 走官方接口单独验收。托管=运营+配额托管。
- **自递归优化（0.3.0）**：`optimizeCycle({maxDepth,intervalMs,eps})` 异步递归 tick→测量区间营收→`adaptStrategy`(爬山/坐标下降：改进则放宽增班上限、劣化则收缩)→再递归，直至收敛(连续3次 eps 内无改进)/达 maxDepth/挂起分析；策略受 LIMITS 安全边界(perLineCap4-16/perLineInc1-8/maxNewExpressShort0-2/buyPacks1-3)。
- **AI 分析升级（恰当时机）**：营收劣化(超 regressionThreshold)/客流未加载/连续劣化≥2/周期巡检(analysisEvery) → 置 `pendingAnalysis` 暂停自动改动 + `opts.onAnalysis(request)` 通知宿主；宿主 spawn AI 智能体分析后 `resolveAnalysis(result)` 应用建议(fare/schedule/strategy 受边界)并恢复递归。分析未决不改数据。
- 回归 `_dev/test-autopilot.js`（11 项）+ `_dev/test-branch-ring.js`（3 项：支线站台避让/避让剔空中点/环线闭合段数=N）。
