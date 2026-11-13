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
  - **官方五段 `1/2/3/4/5`** 与成本带一一对应：短途有 margin，长途有 1.8× 差额补贴。实测同一 10 线网高峰小时净额 **+7.4 万 / +18.2 万 / +20.7 万 / +18.0 万 / +13.0 万**（07–11 点），余额 2 个模拟小时从 22 万涨到 47.6 万。
- **结论：经营档长期票价用官方默认五段 1/2/3/4/5**；`OPS.recommendFares` 的 1.05 结论只适用于“忽略成本/补贴、只看票款”的创意小网络。
- **禁止低于成本的补贴套利**（如 0.5 元全程）：虽然 `1.8×成本差` 会让补贴变大，但属于刷补贴，违反合理票价铁律。
- 写入：`MetroEconomy.setFareRules('metro', rules)` + `metroApplyFareRulesChanged()`；`MetroOps.applyFares(rules)` 封装。
- **票价是全网 metro 规则**，不是单线；应用前记录原规则以便还原。

### 3.2 实际生效条件（关键）

- 票价→需求 overlay 需要 `G.hourlyODBase` 非空 / `_metroFareDemandOverlayActive=true`。
- 经营大网络实测 `od=false/overlay=false`（`flowStatus().hourlyOD=false`）时，票价改动仍会按新规则结算，但需求曲线不立即重算；改价后至少等 **1–2 个整点结算**再用 ledger 净额判断，不要用上一小时的票款/人次反推。
- 判断票价是否真的生效：`ledger` 最近一条 `fareRevenue/fareTrips`。官方五段生效后均值应约 **1.8–1.9 元/人次**（短途 1、长途 2–5，按距离分布）；若仍是 1.09 说明还是旧的 1.05 阶梯。
- 需要真实反馈时：经营模式 + OD 数据就绪（更大网络/真实城市档）后重测。

### 3.3 实测票价方案对比（上海 10 线/91 站，2026-11-10）

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
- 局内 HUD：`$ 6,800,000`、里程 20/20、车站 16/16、车厢 54/54。
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

- 创意档画出上海 18 线 + 苏州 9 线 + 非标准线，共 **31 线 / 824 站 / 5948 节点 / 183 对换乘（130 组）/ 1270.8 km**。
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
- 实测（上海经营档）：买 km×2（20km）+ stations×2（10 站）+ expressLines×1（6 节），余额 **7,076,385 → 5,774,156**（-1,302,229；实际扣款比标价高约 4–6%，以账本为准）。
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
- 当前上海经营档：10 线/106 站；官方五段票价；余额约 19 万（扩张后）；配额 130km（用 126.99）/106 站（用 106）/120 车/快线 6；暂停或运行中。

## 14. 管理扩张进度与经济门槛（2026-11-10）

- 当前上海经营档：**23 线/632 站/634.64km（2026-11-10：苏州 7/8/11 号线各 28 站，苏州 2 号线 39 站；余额 76 万（day86 14:32）；车站 632/636（空闲 4）、里程 634.64/640（空闲 5.36）、车厢 606/606；快车 6/6、小交路 2/3/10/12）**（全部经营模式，线路来自经营收益/初始资本购买的配额）：
- **苏州 7 号线（2026-11-10 建成）**：常楼—木里 28 站，官方色 `#9D85BD` / B6，163 节点，交路 0–27，四检 pass；换乘 中央公园↔1、惹云桥↔6、黄天荡↔5、郭巷↔2。初始 1 列时 flow 8,479；峰值提到 6 列后 flow **52,610**（day79 17:00）。
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
- 实测小时净额（day18 12–14 点）：**+17.3 万 ~ +18.3 万/模拟小时**；余额 8.3 万（每次扩线后接近清零再跑高峰期回血）。
- **配额经济门槛**：完整上海+苏州约 31 线/824 站/1270km；按基础价 10km/$300k + 5站/$150k，且报价随已购量上涨（实测站额度 75→80→85→90 包时：$486,134→$512,457→$539,207；km 包 $501,331→$522,330）。全量约需 **$100M+**。
- **收益节奏（官方五段票价、10 线/106 站）**：高峰小时净额 **+18–20 万**，平峰 +12–15 万，夜间 -0.1 万/小时；200×（`G.simSpeed≈197`，约 3.3 模拟小时/现实分钟）下约 **50–60 万/现实分钟**（高峰）。一个 5 站包≈1 个现实分钟，一个 10km 包≈1 个现实分钟。
- **配额快照是嵌套结构（2026-11-10 实测）**：`MetroEconomy.getFinanceSnapshot().quotas` = `{ metro, hsr, aviation }`；`OE.economyPlan` 必须读 `quotas.metro`，否则会把 `free` 全部算成 0。高铁/航空额度已存在但未使用：HSR `routeKm 1000`、三/二/一等站 6/3/1、G 型车 24；航空 `flights 12`、`routeKm 3000`、`aircraft 5`、`bases 1`。多模式预留读数见 `HsrProbe.state().quotas` / `AirProbe.state().quotas`。
- **预算算法（OE 1.1.6）**：按“下一线额度缺口”给最小购买包，不再按全网车辆缺口一次推荐 62 包。示例：下一线苏州 7 号线需 25 站/35km/6 车；当前空闲 13 站/82.37km/0 车 → `need={stations:12,km:0,cars:6}`、`packs={stations:3,km:0,cars:1}`，推荐先买车站包（每包 5 站），不足则给出 `save` 差额。
- **日结费用必须预留（2026-11-10 实测）**：每天 23:59 结算 `metro_daily_energy` + `metro_daily_staff` + `metro_daily_coordination`；day76 合计 **-1,134,861**（电费 898,527 / 人员 65,880 / 协调 170,454），可直接把余额打到负。`OE.economyPlan` 现计算 `dailyReserve`（最近一天日结合计）与 `usable = balance - dailyReserve`，所有购买判定用 `usable`；买额度前不要把余额压到日结线以下，否则次日凌晨会透支。
- **逐步扩张循环（唯一合法路径）**：
  1. 票价固定官方五段；高峰排班至少覆盖需求，避免 `maxWaiting=4000`。
  2. 200× 跑量，`MetroEconomy.getFinanceSnapshot().balance` 与 ledger 最近小时净额监控。
  3. 余额 ≥ 报价才买 km/stations/cars：`MetroEconomy.dispatch('quota.purchase',{system:'metro',quotaKey:'stations'|'km'|'cars',quantity:1,simDay,simMin})`（`metroQuotaHandlePurchase` 对 item id 解析失败，直接用 dispatch）。
  4. 暂停 → 快照 `CityMetroKit.snapshot('before-xxx')` → 高德实时查询延长段 → 布站/改名 → 节点 → 交路同步 → `checkLine3x` → 保存。
  5. 建换乘（共站或 `_applyAutoPassageTransferBetweenStations`）→ 跑满一小时复核 flow → 重复。
- 创意档：31 线/824 站/5948 节点/183 换乘/1270.8km 已建完并保存（仅作完整主网参考，不作为经营档成果）。

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
9. **当前单线状态**：20 线/548 站/527.63km；1/2/3/10/12/13/14 号线已重绘为单线；5 号线仍为父线+南段线且含支线，待官方支线接口重绘；16 号线已贯通滴水湖；苏州 1–6 号线已建成（2 号线 39 站含北延 4 站，6 号线 31 站含华云）。
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
6. 当前进度：**23 线/632 站/634.64km**；车站 632/636（空闲 4）、车厢 606/606（空闲 0）、里程 634.64/640（空闲 5.36）；余额 76 万（day86 14:32）。苏 7/8/11 已建成并提到峰值 6 列；快车 6/6、小交路 2/3/10/12 已生效。下一步攒包建上海 17 号线（约 13 站，最便宜的剩余线），再建上海 4/6/7/11。

## 16. 浏览器冻结/崩溃恢复（2026-11-10 实测）

- **症状**：`G.simSpeed=200` 但 `simMin` 不走；`document.hidden=true`；`_metroFrameDtEmaSec≈1s`（1 FPS）；或 CDP 9344 消失、9343 控制服务器超时。
- **后台保活（2026-11-11）**：仅使用生命周期与焦点模拟，不激活真实窗口；`browser/cdp-keepalive.mjs` 已移除 `Page.bringToFront`/`Target.activateTarget`。以 simMin 的真实增量判断有效速度，不保证后台仍达到设定倍率。
- **不抢前台**：禁止 Win32 恢复/前台切换、禁止自动解除最小化；窗口恢复看门狗已停止。最小化导致节流时保持后台并报告，不以抢焦点补救。
- **Edge 崩溃**：同 profile 重启 `node browser/cdp.mjs`（CTRL_PORT=9343 / DEBUG_PORT=9344）→ 城市入口点“经营模式”（`data-metro-economy-mode="management"`；其 `data-metro-game-mode="creative"` 是基础地图模式，不代表创意经济）→ “选择存档”点云端 `button[data-entry-cloud-slot="1"]` → 等 15.8MB 加载完成 → 重新注入 MT/OD/K/Ops/OE/FL/modes。
- **恢复核对**：G.lines 数量/名称、余额、三配额、票价、官方前缀、mt/oe/fl/modes 版本。本次恢复保留 **20 线/548 站/414 万**，未丢购包；云端存档时间 21:19。

## 17. 额度自动购买循环（OE 1.1.5，2026-11-10）

```js
OE.startQuotaBuyLoop({ quotaKey:'stations', targetFree:30, maxPacks:6, intervalMs:60000, beforeSettleBuffer:700000 });
OE.quotaBuyLoopStatus();   // { running, packs, log:[{event:'buy'|'fail'|'stop',...}] }
OE.stopQuotaBuyLoop();
```

- 规则：每 60s 检查一次，逐包重新报价；仅在 `balance - buffer >= 单包报价` 时调用官方购买。`buffer=max(beforeSettleBuffer,dailyReserve)` 全天保留日结，不再假设白天一定赚回。购包 tick 用 `economyPlan({includeOperations:false})`，跳过全网排班聚合；主动运营调整另做完整审计。
- 达到 `targetFree` 或 `maxPacks` 自动停；页面 hidden/暂停时跳过；日志保留最近 30 条。
- 实测：day79 19:49 启动即买入 1 包（4,433,430），余额 154 万、空闲车站 5；随后等待下一轮安全余额。
- 仅用于经营模式；不得改价/改档/绕配额；买前先查报价，报价随已购量上涨。

### 18. 苏州 8 号线实测（2026-11-10）

- 用 `OE.buildLine({useSegments:true, stations})` 一次建成：西津桥—车坊 28 站，官方色 `#A09200` / B6，交路 0–27，四检 pass，`estimated=0`。
- 换乘：白洋湾公园↔6、白荡北↔7、时代广场↔1。
- 初始 1 列时 flow 0；峰值提到 6 列后 flow **59,274**，零客流站 0（day82 18:31）。
- 苏 11 额度缺口（day82 19:04）：车站 26（6 包）、里程 19.85km（2 包）、车厢 5（1 包）。
- 多阶段示例：`OE.startQuotaBuyLoop({steps:[{quotaKey:'stations',targetFree:30,maxPacks:6},{quotaKey:'km',targetFree:35,maxPacks:2},{quotaKey:'cars',targetFree:7,maxPacks:1}]})`；当前阶段达标自动切下一步（日志 `event:'step'`），全部完成自动停。苏州 11 号线即用此计划：4 包车站 + 2 包里程 + 1 包车厢。

## 19. 主动运营调整（2026-11-10 用户硬规则）

- 每轮经营必须主动检查：①票价 ②车次/排班 ③小交路 ④快车 ⑤车厢购买；不得只扩张不调运营。
- 快车：`OPS.applyExpress` 已给上海 1/2/9中段/10/12/18 六条线加（`expressLines.used=6`，列车 +6），快车停站取首末 + 权重最高 3 站；额度按 `total-used` 计，最多 6 条。
- 小交路：`OPS.applyShortTurn` 给上海 2/3/10/12 加（peak 2 / off 0 / low 0），叠加既有 8/1/15/9；交路覆盖必须连续。
- 实测（day84 18:00–19:00）：净额 729,521 / 778,817，列车 285，零客流 0；快车/小交路保留。
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
- 使用经营余额按实时递增报价购入 2 包车站、4 包里程、2 包车厢；每包检查日结预留加 100 万缓冲。全网额度占用：车站 646/646、里程 673.94/680km、车厢 940/942；UI 展示里程与计费里程不同，不混用。
- 初始排班 peak/off/low=2/2/1；新线 boardedWindow=0 时不按推荐值 0 停运。恢复模拟至 day97 11:26 后，实测 2 列 B6 运行，累计 boardedWindow=1748，一列载客 1716；余额 16,525,535。换乘关系仍需独立核验，不以排班配置成功代替运营验收。
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
- day98 夜间调整上海15号线既有小交路：紫竹高新区—娄山关路（0–17）改为景西路—上海西站（5–22），保留1/1/1频次及主交路。用官方 `buildCommittedRouteLegsFromDraft`→`persistRouteLegsOnLine(line,draft)`→指定leg排班，coverage=null。历史上客覆盖266250→370620（约+39%），这不是已实现收益增幅，净收益及拥堵改善待白天验证。会话回退记录 `window.__short15Before`，id保持不变。

## 21. 全自动经营托管 MetroAutopilot 0.3.1（自递归优化 + AI 分析升级，2026-11-12）

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
- **营收劣化自动回滚（0.3.1）**：tick 前 captureConfig(票价+逐交路排班)，区间净额劣化超 regressionThreshold 自动恢复改动前配置并清零劣化计数，防托管把线网改坏。
- 回归 `_dev/test-autopilot.js`（12 项）+ `_dev/test-branch-ring.js`（3 项：支线站台避让/避让剔空中点/环线闭合段数=N）。


## 22. 经营/多模式全局 API 速查（原 update-2026-09-27，合并简化）


> **结论先行**：9-24 / 9-27 两次更新（新增高铁·航空·经营模式·Voyager；调低经营模式难度+bug 修复）**不改变本技能 §1-§8 绘线主流程**——地铁绘线仍按原流程执行。本文件只增补六件事：①版本变化速览 ②模式判定与影响 ③经济全局 API 速查 ④新模块与绘线边界 ⑤控制链路差异 ⑥验证清单。
> 素材：`browser/research/*.js`（15 个更新模块源码）+ 真实 Edge CDP 接管实测 UI。数值以源码为准；研究报告 01/02 生成后（`research/report/`）可互查。

---

## §A 版本变化速览

### A.1 更新公告（原文口径）

- **2026-09-24**：新增**高铁（HSR）**、**航空（Aviation）**和**经营模式**；新增 **Voyager**（菜单页可打开）。
- **2026-09-27**：修复绝大部分反馈 bug；**调低地铁经营模式难度**（经济参数由 metro-economy-20260919-v1 升到 v2）。
- 旧公告关联：2026-08-10 服务器升级数千兆带宽（曾引起客流文件加载超时）；测试版存档 coordSystem gcj02→wgs84 偏移问题需手改存档。

### A.2 游戏 UI 关键 DOM（CDP 实测）

| 选择器 | 用途 | 与绘线关系 |
| --- | --- | --- |
| `#nav-btn-add-line` | 新增线路 | 绘线主入口（不变） |
| `#nav-btn-control-center` | 控制中心 | 验证用（内含三 tab） |
| `#nav-btn-flow-dashboard` | 运营日报 / 客流看板 | 读经营与客流数据，先判模式（§B） |
| `#nav-btn-metro-diagram` | 线网示意图 | 既有流程入口 |
| `#nav-transport-metro` / `#nav-transport-hsr` / `#nav-transport-flight` | 交通方式切换 | 仅 metro 是绘线目标（§D） |
| `.ridership-tab-*` | 客流面板分 tab | 读数用，勿当按钮点写操作 |
| `#screen-guide` 内搜索框 | 指引页搜索 | 站内速查入口 |
| ≡ 菜单（汉堡） | 存档1-3、云存档、退出登录 | 存档/模式选择由用户完成，AI 不代点（§0.6） |

### A.3 研究素材模块清单（browser/research/*.js，15 个）

| 模块 | 用途 |
| --- | --- |
| metro_economy_rules.js | 地铁经济规则（v1/v2 配额·收支·罚金） |
| metro_fare_policy.js | 地铁票价（距离分段计价） |
| hsr_economy_rules.js | 高铁经济规则 + 事件波（影响 metro 客流） |
| hsr_track_timing.js | 高铁轨道时刻 |
| aviation_economy_rules.js | 航空经济规则 |
| aviation_timetable.js | 航空时刻表 |
| metro_event_station_catalog.js | 重点站事件目录（crowdSurge/concert/…） |
| save_mode_policy.js | 存档模式策略（canLoad/prepare） |
| flight_planner_panel.js | 航线规划面板 + 存档扫描（meta 键出处） |
| railway.js | 铁路底图 |
| voyager.js / voyager-passport.js / voyager-collection.js / voyager-membership.js | Voyager 护照·收藏·会员（与绘线无关） |
| economy.js | 旧城市经济（2026-07-economy-v1，勿与经营模式参数混用） |

---

## §B 模式判定与影响

- 9-24 起存档分两种**经营模式**：**创意（creative）** 与 **经营（management）**；资金口径上另有 **free**（免费）。
- **当前会话存档 = 创意 + free**：localStorage 存档元数据键 `metro_local_draft_no_flow_v1:meta:<存档>` 含 `_mode_creative` / `_mode_free` 标记（出处：flight_planner_panel.js 存档扫描逻辑）。
- 创意模式下运营日报显示「**创意模式不显示经营数据**」——读经营数字前先判模式，**空值不是 bug**。
- 跨模式加载限制（save_mode_policy.js → 全局 `MetroSaveModePolicy`）：
  - `canLoad(save, targetMode)` 为 false 时，`prepare(save, targetMode)` 抛 `code === "save_mode_incompatible"`；
  - `prepare` 把存档改写为 `gameMode:"creative"` + 对应 economyMode（free 时 `economy.suspended = true`）。
- **对绘线任务的结论**：画线本身**不受经营模式限制**（任何模式都可绘线）；但读经营数据 / 客流口径**要分模式判断**。模式与存档的界面选择仍由用户完成，AI 不代点。

---

## §C 经济全局 API 速查（页面全局对象，注入后 console 直接可用）

版本串一览：

| 版本串 | 归属 | 说明 |
| --- | --- | --- |
| `metro-economy-20260919-v1` | MetroEconomyRules / MetroFarePolicy | 默认（旧） |
| `metro-economy-20260919-v2` | MetroEconomyRules / MetroFarePolicy | latest，9-27 调低难度 |
| `hsr-20260919-v3` | HsrEconomyRules | 高铁（非绘线目标） |
| `aviation-20260918-v1` | AviationEconomyRules | 航空（非绘线目标） |

### C.1 MetroEconomyRules（metro_economy_rules.js）

导出面：`version`(=v1) / `latest`(=v2) / `versions` / `supports(v)` / `forVersion(v)` / `start` / `quota` / `quote(key, value, tiers)` / `hourly(inputs)` / `daily(inputs)` / `penalty(baseline, actual, percent)` / `costScale` / `operatingSubsidy` / `expressCars`。

- `inputs = { carKm, departures, stationCount, routeKm, cars }`；`hourly` → `{operating, maintenance}`；`daily` → `{energy, staff, coordination}`；v2 下 hourly/daily 各分量 × costScale（v2=2，v1=1）。
- `penalty`：actual > baseline 时按 baseline × 费率（v1 4.25% / v2 4.5%），否则 0。
- `start`（两版同）：`{cash: 6800000, km: 20, stations: 16, cars: 54, expressLines: 0}`。
- v1 → v2 配额差异（quota 各项 base 大幅上调 = 配额更宽松）：

| 键 | v1（unit/base/K/p） | v2（unit/base/K/p） |
| --- | --- | --- |
| km | 10 / 4500 / 10 / 0.8 | 10 / 300000 / 10 / 0.8 |
| stations | 5 / 2100 / 12 / 1.45 | 5 / 150000 / 12 / 1.45 |
| cars | 6 / 1000 / 50 / 2.8 | 6 / 60000 / 50 / 2.4 |
| expressLines | 1 / 15000 / 4 / 1.6 | 6 / 360000 / 10 / 1.6（v2 才有快线列车，expressCars=true） |

可复制调用示例：

```js
MetroEconomyRules.version                        // "metro-economy-20260919-v1"
MetroEconomyRules.latest                         // "metro-economy-20260919-v2"
MetroEconomyRules.supports("metro-economy-20260919-v2")   // true
const v2 = MetroEconomyRules.forVersion(MetroEconomyRules.latest);
v2.quote("km", 120)          // 120km 的里程配额（tiers 缺省按 1）
v2.quote("stations", 30)     // 30 站配额
MetroEconomyRules.hourly({ carKm: 5000, departures: 120, stationCount: 24, routeKm: 90, cars: 180 })
MetroEconomyRules.daily({ carKm: 5000, stationCount: 24 })
```

- `forVersion` 传不支持的版本抛 `Unsupported metro economy rules version`；`quote` 未知键抛 `Unknown metro quota`。

### C.2 MetroFarePolicy（metro_fare_policy.js，距离分段计价）

导出面：`version` / `latest` / `versions` / `supports(v)` / `defaults(policyVersion)`（内置分段表）/ `defaultRules(policyVersion)`（可直接进 compile 的规则对象）/ `serviceCosts(policyVersion)` / `validate` / `compile(rules)` / `demand` / `demandFor` / `fare(compiled, distanceKm)`（元）/ `serviceCost(compiled, distanceKm)` / `factor` / `createContext({rules, stationCount, coordinates})`。

内置分段（票价元 / serviceCost 元）：

| 里程段 | v1 fare | v2 fare | v2 serviceCost |
| --- | --- | --- | --- |
| 0-6km | 0.55 | 1 | 0.45 |
| 6-12km | 0.7 | 2 | 1.3 |
| 12-22km | 0.85 | 3 | 2.15 |
| 22-32km | 1 | 4 | 3 |
| 32km+（开区间） | 1.2 | 5 | 3.8 |
| flat（一口价） | 0.7 | 2（serviceCost 1.3） | — |

可复制调用示例：

```js
const compiled = MetroFarePolicy.compile(MetroFarePolicy.defaultRules(MetroFarePolicy.latest));
MetroFarePolicy.fare(compiled, 8.5)         // v2 6-12km 档 → 2
MetroFarePolicy.fare(compiled, 40)          // v2 32km+ 档 → 5
MetroFarePolicy.serviceCost(compiled, 8.5)  // v2 → 1.3
MetroFarePolicy.defaults("metro-economy-20260919-v1")   // 旧分段表（对照用）
```

- compile 结果 `kind` ∈ neutral / scalar / bands；validate 失败抛 `Metro fare: ...` 前缀错误；band 表必须无空隙、末段开区间。

### C.3 其他新经济对象（非绘线目标，了解即可）

- `HsrEconomyRules`（hsr_economy_rules.js，version `hsr-20260919-v3`）：`quote(key, value, tiers)`（quota keys：`trains.G` / `platforms` / `waitingHallAreaWanM2`）、`suggestFare`、`serviceCost`、`ensureEvents` / `drawEvents`、`eventBoost`、`metroStationEventProfile(station)`。
- `AviationEconomyRules`（aviation_economy_rules.js，version `aviation-20260918-v1`）：`start` / `quota` / `weeklyOverhead`；`fare(km) = max(6.5, 1.75 + 0.05 · km^0.755)`。
- 旧 economy.js 仍为 `2026-07-economy-v1`（城市经济，与经营模式参数并存，勿混用）。

---

## §D 新模块与绘线的边界

- **高铁线 / 航班不是 metro 绘线目标**：`#nav-transport-hsr` / `#nav-transport-flight` 及其面板属于新玩法；地铁绘线仍走本技能 §1-§8 原流程（nav-metro-only 边界）。
- **Voyager**：菜单页的个人回忆 / 护照网站（voyager.js / voyager-passport.js），收集旅程印章与收藏；与绘线无关，无需操作。
- **事件站点（新增，影响客流解读）**：
  - `MetroEventStationCatalog`（metro_event_station_catalog.js）为真实城市重点站标注 `eventTypes`：`crowdSurge`（商圈潮汐）/ `concert` / `musicFestival` / `sportsEvent` / `exhibition`。
  - `HsrEconomyRules.ensureEvents` 按时刻表生成事件波（wave，含 holiday），期间对 metro 客流施加 boost：网络 +30%~50%、相关站 ×1~1.5；sportsEvent 单次持续 7-14 天。
  - **含义**：客流校验时相关站客流偏高属**事件叠加，不是绘线错误**；不得为"压客流"改官方走向 / 站位。
  - 判定事件站：`HsrEconomyRules.metroStationEventProfile(station)` → `{selected, types, venues}`。

---

## §E 控制链路提示

- **真实 Edge CDP 接管口 = 9334**（junction 方案，本项目既有约定）；页面注入仍按技能原流程执行，入口与注入步骤不变。
- `window.__metroToolkit` **默认不存在**：页面加载后需按原流程注入工具箱脚本才有；**页面重载 / 导航后一律重新注入**再调用（刷新用 `redrawAllMetroOverlays`，勿 `location.reload()`，§0.4）。
- 性能：9-27 后事件客流计算更重，仍强制 `setMetroPerformanceMode(true)`；批量操作保持分批 + 超时（§0.4）。

---

## §F 验证清单（更新后跑一次，全过即适配完成）

- [ ] 注入后读 `MetroEconomyRules.version` 与 `.latest`，应分别返回 v1 / v2，无 "Unsupported" 抛错。
- [ ] `#nav-btn-control-center` 打开控制中心，遍历三个 tab，控制台无报错。
- [ ] `#nav-btn-flow-dashboard` 打开运营日报：创意模式显示「创意模式不显示经营数据」= 正常；经营模式显示数字。
- [ ] `MetroFarePolicy.compile(MetroFarePolicy.defaultRules(MetroFarePolicy.latest))` + `fare(compiled, 8.5)` 返回 2，无 `Metro fare:` 报错。
- [ ] 按 §1-§8 原流程绘一条测试线，确认绘线链路不受经营模式 / 新模块影响。

---

## §G 列车 / 运行时间 / 发车间隔设置（2026-10-17 实玩实证，含 delta 验证）

> 详版：`research/report/04-settings.md`。三项链路均实测跑通（改动→落库→重启保持）。

### G.1 运行时间（首末班）

```
openLineInfoPanel(lineId)
// 侧栏只有关闭函数，打开需强开（无公开 open API）：
//   #line-info-side-stack   add is-open + display:flex !important
//   #line-info-side-service display:block !important；调 _syncLineInfoSideStackLayout()
填 #line-info-svc-open-h / -open-m / -close-h / -close-m（时/分）
commitLineInfoServiceTimes()
//  lineInfoValidateServiceInputs 校验 → 写 serviceOpenMin/serviceCloseMin/
//  service24h/_serviceTimesCustomized → spawnTrains → 通知 → 自关侧栏
```
- 实测 L1 末班 23:30→23:00：`serviceCloseMin 1410→1380` ✅（重启后保持）。
- 24h 模式走 `lineInfoService24hEnabled()` → {openMin:0, closeMin:1440, service24h:true}。
- **全线路批量**：`commitLineInfoServiceTimesForAllLines()`。
- 同族侧栏：`#line-info-side-routing / -express / -fare`（票价矩阵 metroFareMatrix*）。

### G.2 发车间隔（上线列车数）

```
applyRouteLegSlotCount(line, legIdx, slot, kind, count)
// slot='peak'|'off'|'low'；kind='local'（快线='express'）；写腿级 freq* 并持久化
```
- **线顶层 `l.freqPeak=x` 无效**——面板读 `readRouteLegsFromLine` 腿级字段（第 8 坑）。
- 面板输入 `#line-info-cap-peak/off/low`（标签「上线列车数」），间隔=自动换算。
- ⚠️ 恢复后线顶层镜像 `[12,8,3]` 与 UI 输入（low=5）不一致——**以腿级/面板为准**，勿用线顶层镜像做校验。

### G.3 列车（车型 / 编组 / 速度）

```
G.selectedLineId = lineId; openEditLine()        // 编辑 modal #modal-line（无参）
点 #line-type-extra-toggle / #line-cars-extra-toggle / #line-speed-extra-toggle 展开
点 #line-speed-extra-panel 内胶囊（text==='140'）选档
#modal-line-confirm-btn（确认）→ 整表单落库 → modal 关闭
```
- **表单模型 `_lineFormState`**：{color, type, cars, speed, freqPeak, freqOff, trainPpc, trainStockCode, carsUserPicked, officialPaletteCityKey}。
- 实测 L2 速度 80→140：`maxSpeedKmh` 落库 ✅、里程不变、modal 正常关闭。
- 城市门控：`getLineModalTrainCityKey()`（anycity→'beijing'）；标准速度档 [80,100,120,160]、B 型扩展 [60,90,140,150,180,200]；车型可选 标准/L型/D型/磁浮/APM/云轨/单轨；编组 3/5/7 节（+主行）；`#line-stock-ref-btn` 仅 stock 城市显示。
- 显隐门控：`syncLineStockRefButtonVisibility`、`setLineSpeedExtraPanelOpen`（`metroDesignSpeedExtraOptsForCityKey(city,type)` 空数组=不可展开）。
- ⚠️ 选胶囊务必限定 `#line-speed-extra-panel` 内——页面里还有个同名类的 **HUD 倍速滑条**（.speed-slider，200×），抓错对象会改游戏速度。

### G.4 页面劫持与恢复（实测）

- 现象：游戏页被顶层导航离开（本轮去了 deepseek.com/harness，根因未定位，疑为编辑面板捆绑处理器——操作中发现 `location.href` 突变立即 CDP Page.navigate 回游戏 URL）。
- **恢复**：回 /cities/anycity-global → 选「创意模式」→ **自动加载本地草稿**（全数据直达，无需走存档页）。
- 恢复后核对：站数/官方色/换乘组/服务时间/发车配置逐项比对（本轮 svc1380 改动保持 ✅）。
- 恢复后按 §0.6 一律重注工具箱再操作。

---


---

## §H 票价规则与票价表（fare 侧栏，2026-10-17 实测）

> 详版 `research/report/04-settings.md` §F；截图 `browser/shots/fare-panel.png`。

```
openLineInfoPanel(lineId)
toggleLineInfoSidePanel('fare') + 强开 #line-info-side-stack/is-open + #line-info-side-fare/display:block（同 §G.1）
  + ensureLineInfoFarePanel() → _syncLineInfoSideStackLayout()
读：lineInfoFareRulesGetMetro(line) → {policyVersion, mode, distanceBands[]}
改：面板 input.line-info-fare-watch（每行3个：起始km/结束km/票价，结束空=∞）
    模式钮 .line-info-fare-mode-option（固定 flat / 阶梯 distanceStep）
    #line-info-fare-apply-all（应用到所有线路）→ #line-info-fare-confirm
    确认 → 写规则 + 通知「已保存票价规则」+ 侧栏自关
看板：#line-info-fare-matrix 票价表 = 规则×站距自动复算 OD 网格（只读），.metro-fare-matrix-close 关闭
```

- 默认（v2）五段：0-6→1 / 6-12→2 / 12-22→3 / 22-32→4 / 32+→5；delta 实测 5→6 落库 ✅。
- **校验一律以 `lineInfoFareRulesGetMetro` 为准**（`lineInfoFareModeValue()` 有不同步已知问题）。
- dump 截断 class 会误导选择器（fare-watch 被截成 fare-wa），选择器用完整 class 或按 input 位置索引。
- 同族侧栏已摸排（详见 04-settings.md §G）：**express** `#line-info-side-express`（添加经停站→`G.lineInfoExpressDraft`→完成；`line.expressCaps={peak,off,low}`；快车列数走 `applyRouteLegSlotCount(...,'express',...)`；门控 `routingExpressFeatureDisabled()`）、**routing** `#line-info-side-routing`（交路设置：出发/到达站对 = `readRouteLegsFromLine` 腿的编辑入口，决定 legIdx）。两者未做 delta（交路改排影响发车计算，需专项测）。

---


---

## §I 绘线实战增补：跨城复刻 + 原创线（2026-10-17 实测，全 pass）

> 详版 `research/report/05-shanghai-creative.md`。

### I.1 跨城复刻（上海1号线 28站 一次全绿）

- 管线与常州一致，**city 贯穿三件套**：`applyLineData(id, stations, null, {city:'上海', order})` → `rebuildNodesFromAmap('上海', id)` → `checkLine3x(id, {city:'上海'})`。
- **`setLineProps(lineId, city, no)` 正面用法**：一次拿官方配色+官方车型+时速（上海1号线→A型车8编组自动查到）。线名带城市前缀「上海1号线」不影响线号提取（regex `/(\d+)号线/` 兼容）。

### I.2 原创线（无高德）——标准路径

```
1. 建线（UI 建设）→ 留空线
2. 退出 place 模式（top.enterStationAddModeOnLine(lineId) 切换）
3. OD.applyLineData(lineId, [{name,lng,lat} × N], null, {})   // 坐标+自定义站名一次到位
4. l.color = 设计色; redrawLine(l); updateStats()
5. checkLine3x(lineId, {})   // 不传 city = 不比对官方，结构/绕序照检
```
- **勿用地图点击放站做批量**：place 模式相机锁死（强制 zoom≈13.5、setCenter 被自动取景压制、每站后自动取景使预投影漂移）。点击流仅适合 1-2 站补点，且必须逐站即时投影。
- 点击放站安全区（元素级）：顶层=canvas(amap-layer) 且避开 右侧按钮列(x≥1478&y≥600)/底栏(y≥755)/顶栏(y≤62)；勿用紧矩形阈值。
- 点击放站会按最近真实地名**自动命名**；自定义名用 applyLineData 的 name 字段或 `K.applyStationNames`。
- 空段直线=设计意图，checkLine3x 不会因此 fail（7站6段 anchors pass 实证）。

### I.3 杂项实操坑

- RED 删除拦截：`window.__DANGEROUS_CONFIRM['deleteLine']=true` 后重试（先 `K.snapshot`，§0.6）。
- **CDP 选标签按 URL**：调试 Edge 可能共存其他工作流标签（如小红书），必须 `url.startsWith('https://www.citiesdesigners.com')` 过滤——取首个 page 曾误读他页并误判「游戏重载」。
- 相机对中不收敛先做两帧诊断（zoom/center 是否稳定）再改策略；place 模式 zoom 锁 13.5 会让 setZoomAndCenter(11/13) 全部失效。

---


---

## §J 经营模式实测（2026-10-17 进入管理档）

> 截图 `browser/shots/management-mode.png`；详版见 01-economy.md 互证。

### J.1 进入流程（实测安全路径）

1. 入口页点**经营模式卡**：选择器用 `[class*=mode-option]/.flight-base-mode-option` + 文本以「经营模式」开头且含「资金」+ 长度<40 —— ⚠️ FAQ 里有「经营模式下哪些地铁操作会使用额度？」同前缀文案，纯文本过滤会点错。
2. 进档前 **`top.downloadLocalSave()` 文件级备份**创意档（download 一次 json，§0.6）。
3. 存档屏：**缓存槽显示「读取失败」+ toast「存档读写失败…版本是否兼容」= save_mode_incompatible 的 UI 表现，不是文件损坏**（free→management 被 save_mode_policy.canLoad 拦截）。点 **直接进入** = 全新管理档。
4. **存档隔离实证**：meta 键按模式后缀（`meta:anycity-global_mode_creative` 保留不动），管理进入不覆盖创意 4 线数据。
5. 进入成功标志：HUD 出现 **`$ 6,800,000`**（创意模式 HUD 无钱字段）。

### J.2 经营引擎实测值（MetroEconomy 全局）

```
MetroEconomy.getState() → { version:1, rulesVersion:'2026-07-economy-v1',
  gameMode:'creative',            // ⚠️ 9-27 架构：经营= economyMode 字段，gameMode 恒 creative
  economyMode:'management', mode:'management', suspended:false,
  balance:6800000, cityCostProfileId:'anycity_unified', ledger:[] }
MetroEconomy.getFinanceSnapshot() → balance + quotas.metro{ km:20/stations:16/cars:54/expressLines:0 (total=granted, used=0) }
  // 与 MetroEconomyRules.start 完全一致 ✓
MetroEconomy.metroPurchaseQuote({system:'metro', quotaKey}, amount) → {amount}
  // 实测：km×10 → $4,025,579 ｜ stations×5 → $940,977 ｜ cars×6 → $405,441 ｜ expressLines×1 → $360,000
```

- **两套规则并存的实证口径**（01 报告「勿混用」的正面版）：**购买报价走 economy.js 总引擎（2026-07-economy-v1，cityCostProfile）**；**画线配额校验走 MetroEconomyRules（metro-economy-20260919 v1/v2）**。报价数字量级差异巨大（总引擎 10km≈402万 vs 20260919-v2 quote 公式 10km=30万档）——引用时必须注明引擎来源。
- 其他可用：`MetroEconomy.getLedgerRows()` 账本、`initializeFreshMetro/initForCity`、`serialize/applySaveState`（存档读写）、`metroPurchaseQuote` 签名 `pr(e,a)` 要求 `e={system:'metro', quotaKey}` 对象（传 'km' 字符串返回 null）。

### J.3 运营日报（管理模式不再隐藏）

- 经营数据区：**现金储备大卡**（$6,800,000 + 日/周/月/年 切换 + 现金折线）+ **利润表/现金流量表**双 tab（地铁/日，本期·环比两列：票款/收入/成本=运营·维护·能源·人员/分部利润（亏损））+ 客流数据区（懒加载，滚动触发）。
- 0 线新档全部 $0 属正常；创意模式下该区显示「创意模式不显示经营数据」（§B）——读数前先看模式。

---

> 出处：`browser/research/`（15 模块源码）+ CDP 实测 DOM + 实玩常州/上海存档 + 经营模式实测（2026-10-17）；研究报告 `01-economy` / `02-features` / `03-playthrough` / `04-settings` / `05-shanghai-creative` 见 `research/report/`。


## 23. 高效执行（原 efficient-mode，合并简化）


> v4 起 v3 高效版并入本技能，不再单独维护。本文件承载 v3 独有流程；架构与硬规则以主 `SKILL.md` §0 为准。
> 最高原则：**省 token 绝不牺牲准确性**——聚合可省往返，但每步必须用返回值验证（站名/颜色/换乘/节点）。

## 1. 注入（无数据库，默认不注入 mt-data.js）

按序注入 5 个文件（路径相对技能根）：

```js
const B = '<skill-root>/scripts/funcs';
await inject(B + '/query/mt-core.js');
await inject(B + '/query/mt-node.js');
await inject(B + '/query/mt-amap.js');
await inject(B + '/draw/od.js');
await inject(B + '/manage/k.js');
// 校验：{ MT: window.__metroToolkit.__version, OD: window.__officialDraw.__version, K: window.CityMetroKit.__version }
// 期望：MT 6.0.0 / OD 2.60.0 / K 2.9
```

- 可选：`query/metro-unopened-paths.js`（`window.__metroUnopenedPaths`，从已加载瓦片提取地铁瓦片模板，供未开通线查询）。
- 可选：`query/mt-data.js`（`window.__MT_SUBMETRO_DATA`，24 城静态 srhdata；默认不注入，实时查询优先）。
- 宿主差异：VS Code Copilot 用 `page.addScriptTag({path})`；Qoder 用 Playwright MCP `browser_evaluate`/`browser_run_code_unsafe` 或 `browser/cdp.mjs` 的 `/script`；纯 CDP 用 `Runtime.evaluate`。
- 改了 `mt-core` 的端点表后必须**重新注入 mt-amap**（闭包缓存旧 `endpointsOf`）。

## 2. 查询（实时取数）

```js
const q = await MT.queryLine(city, no, { stationFrom, stationTo });
// → { ok, stations:[{name,lng,lat}], nodes:[[[lng,lat],...]每段], color, trainType, isRing, ... }
```

| 场景 | 调用 |
|---|---|
| 已开通线（默认） | `MT.queryLine(city,no)`（游戏内高德 → 免费 Web 兜底） |
| 环线完整闭环 | 自动：`queryLine` 命中 `MT.RING_LINES` → `queryRingLine`；或直调 `MT.queryRingLine` |
| 端点表缺该线 | 先 `MT.queryLineStopsByPOI(city,no)` 拿站，再用 `MT.queryTransferStops(city,a,b,线名)` 取段走向 |
| 在建/规划 | `MT.queryUnopenedLine(city,no)`（终点/状态/站）；走向再用 POI |
| 国外 / OSM 引擎 | `MT.queryOsmOverpass(city,no)`（优先游戏内 OSM API，失败回退 Overpass；WGS-84） |
| 有轨电车 | `MT.queryTramLine` / `resolveTramCoord`，或 `queryLine(...,{isTram:true})` |

数据源优先级：**默认高德**（游戏内高德 → 高德免费 Web → POI → 未开通接口）；OSM 引擎下也先用高德，取数后 `MT.toGameCoords` 转 WGS-84；仅高德无数据才用 OSM（游戏内 OSM API → Overpass）。查询不到才降级规划图/估算，且必须询问用户。两引擎特调见 `references/map-engines.md`。

## 3. 一条线一次对话（脚本一次性）

标准顺序（每步用返回值确认，失败即停）：

1. `MT.queryLine` 拿站 + 走向（有支线先 `OD.checkMainLine` 选最长主线）
2. `OD.createLine(短名)`（或官方 UI 建线）→ `lineId`
3. `OD.setLineProps(lineId, city, no)` 官方配色/车型/编组
4. `OD.renameStations(lineId, q.stations.map(s=>s.name))`（**必须先于换乘**）
5. `OD.applyLineData(lineId, q.stations, q.nodes, {city, order, isRing})` 统一写站+节点+收尾
6. 支线：`OD.startBranch(主线id, 分叉站)` → `OD.applyBranchData(支线id, stations, {city, order, name})`
7. 换乘：只读扫描跨线同名站 → `K.applyTransfer` 逐个建（**禁用 `OD.autoTransfersBulk` 全量扫描**，大存档易闪退）
8. 检查：`OD.checkLine3x(lineId)` + `OD.verifyLine(lineId,{city})`，全过才汇报

提速：
- `OD.fastDraw(lineId, stations, nodes, {city,no,names})` 直接写数据、一次 redraw（批量 <1s/线），但站名/换乘核对不得跳过。
- 绘制前 `setMetroPerformanceMode(true)`；`stationDelay=0`；完成后恢复（见 §7）。
- 聚合：查询+绘制+配色+站名+换乘+检查放进一次 evaluate，但**返回完整验证数据**（颜色/站名 diff/换乘清单/check details），只返回 `{pass:true}` 不够。

## 4. 修复线路（不重新查询数据，先只读定位）

只读四扫：空节点段 / 占位符站名（`^(站|Station)\d+$`）/ 出入口噪音（`号口`）/ 绕路（折线/直线 ratio>2.2）。
换乘扫描：跨线同名站但本线 `isTransfer=false` 或无 `transferGroupId` → 缺失；`isTransfer=true` 但无 tg → 孤儿。

| 本线站↔伙伴站距离 | 判定 | 动作 |
|---|---|---|
| ≤250m | 可直接建 | `K.applyTransfer(本线,站,伙伴线,伙伴站)` |
| 250–1000m | 超通道上限 | 先 `K.calibrateCoordinates` 校准到伙伴线坐标，再建 |
| >1000m | 伙伴线未画/错位 | 先确认伙伴线是否存在、坐标是否正确 |

修复硬边界（详见主 `SKILL.md` §0.2）：
- 小偏差（同站 ≤150m、命名装饰）归官方；大差异（延伸/规划/用户改走向/拆并站）视为用户自绘，**保留不改**。
- 未知线路（数据源不认识）一切保留；仅当官方数据与用户自绘大体一致才校准。
- 删旧线/重建前先备份换乘（`window.__lineTransferBackup`），恢复数=备份数才继续。
- 顺序检查先于一切节点生成算法；乱序修完复扫到 `remaining=0`；禁止用置空/截断当处理手段。
- 大存档换乘：`K.applyTransfer` 轻量重绘；检查用只读扫描，不调全量 `checkLine3x`；完成后立即 Ctrl+S。

## 5. 必检（四检 + 高德比对）

| 检查 | 通过标准 | 不通过 → 修复 |
|---|---|---|
| check1 站数/节点 | 站数=官方、无重复/缺站 | 补删站 + `renameStations` |
| check2 坐标偏差 | devToLine=0 / 无 mismatch | `rebuildNodesFromAmap` 重拟合 |
| check3 空段 | 无 emptySegs | 补中点或重拟合 |
| check4 绕路/顺序 | 无 detour / nodeOrderIssues | `fixNodeOrder` / 重拟合 |

`OD.verifyLine`：颜色 vs 官方配色、站名 diff=0、站坐标偏差 ≤100m、无空段、节点密度合理、无绕路。

## 6. 支线判断与非常规线路

- 支线：候选里站点数最多者为主线；数量相同取走向总长 `totalM` 更长者（`OD.pickLongest`/`checkMainLine`）。支线必须走 `OD.startBranch` 保持 `branchRootId`，命名区别于主线。
- 非常规线（磁悬浮/机场联络线/浦江线/有轨电车）：**只有查询这一步特殊**；查询后绘制/节点/换乘/检查全按普通线处理（`fastDraw`/`applyLineData` + `rebuildNodesFromAmap` + `K.applyTransfer` + `checkLine3x`）。
- 机场联络线高德名为“市域机场线”，`queryLine` 内置 `_nonStdFilter` 映射；磁悬浮无 SUBWAY 段时走端点兜底。

## 7. 收尾清理（每轮必做，失败也做）

| 项 | 动作 |
|---|---|
| 退出编辑 | `OD.finishEdit(lineId)` → `editMode='select'` |
| 关闭面板/弹窗 | 无残留模态框 |
| 性能模式 | `setMetroPerformanceMode(false)` |
| 吸附 | `OD._restoreSnap()` |
| 客流 | 需要时 `redrawAllMetroOverlays()` / flowFull 刷新 |
| 保存 | Ctrl+S（`top.downloadLocalSave()`） |

## 8. 省 token 清单

1. 查询按需取数，不预载全量数据库。
2. 多步聚合成一次 evaluate，但返回站名 diff/颜色/换乘/检查 details。
3. 批量多线 = 逐条重复单条流程，每条一行紧凑结果 `{no,stops,pass}`；每条仍独立核对站名+换乘。
4. 同线二次查询有 5 分钟缓存（`MT.clearQueryCache()` 可清）。
5. 先 `checkLine3x` 定位问题再修，不整线盲目重绘。
