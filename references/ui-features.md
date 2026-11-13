# 真实 UI 功能地图（2026-11-09 实机操作）

> 目的：记录**实际点出来的**面板/控件/行为，作为脚本 API 的对照与兜底。
> ⚠️ 游戏大量使用**委托 pointer 事件**：`element.click()` 常常无效（排班 +/- 实测无反应）。真实 UI 操作用 CDP `Input.dispatchMouseEvent`（仓库 `browser/cdp-click.mjs`）或 Playwright 真实点击。

## 1. 线路信息侧栏（选中线路后）

入口：`openLineInfoPanel(lineId)` / 地图点线路。结构：

| 区块 | 关键控件 | 实测行为 |
|---|---|---|
| 头部 | `#line-info-header-main` / `#line-info-title` | 显示线名，如「无锡1号线」 |
| 车站列表 | `#line-info-list` | 每站名 + 数字（当前站客流/候车），可滚动 |
| **上线列车数** | `#line-info-capacity-row`；`#line-info-cap-peak/off/low`；`button[data-cap][data-delta]` | 三档（高峰/平峰/低峰）列车数；右侧 `#line-info-head-*` 显示换算间隔 |
| 自动 | `#line-info-btn-auto` | 模式开关（`is-active`）；**自动模式会覆盖手动列车数**（实测关自动后 11/10/8 精确还原，开自动时平峰 10 被调成 9）。做确定性优化：先关闭自动 → 应用 → 复核 → 按需再开 |
| 运营时间 | `#line-info-btn-service` → `#line-info-side-service` | 开始/结束时刻、24 小时运营、应用到所有线路；`#line-info-svc-open/close-h/m` |
| 交路 | `#line-info-btn-routing` → `#line-info-side-routing` | `#line-info-routing-legs` 出发/到达；可加/删交路 |
| 快车 | `#line-info-btn-express` → `#line-info-side-express` | 快速列车停靠站选择、启用/停用 |
| **票价** | `#line-info-btn-fare` → `#line-info-side-fare` | 固定/阶梯；15 个 `.line-info-fare-watch`（每段 起始/结束/票价）；应用到所有线路；票价矩阵；确认/取消 |
| 设置 | `#line-info-btn-settings` | 线路设置 modal（车型/编组/时速/颜色），需线路编辑态 |

### 排班真实操作（实测）
- 点击高峰 `+`：`6 → 7`，间隔 `16.3 → 14.0 分钟`，`readRouteLegsFromLine` 同步 `freqPeak=7`。
- 点击 `−` 还原 6 / 16.3。
- 间隔由 `calcLineHeadwayMin(列车数, line)` 计算：`往返分钟 / 列车数`。
- 低峰 0 = 不排车；UI 显示 `-- 分钟`。

### 票价真实操作（实测）
- 阶梯票价 5 段：`0-6→1 / 6-12→2 / 12-22→3 / 22-32→4 / 32+→5`（v2）。
- 把第一段票价 `1→2`，确认后 `lineInfoFareRulesGetMetro()` 立即变为 2；再改回 1 确认，恢复。
- **票价是全网 metro 规则**（不是单线）：`MetroEconomy.getFareRules().metro`。
- 直接 API：`MetroEconomy.setFareRules('metro', rules)` + `metroApplyFareRulesChanged()`；UI 路径：`.line-info-fare-watch` 改值 → `#line-info-fare-confirm`。
- **官方票价→需求模型**：`metroFareDemandPenaltyForFare(fare, baseline)`，国内 baseline=0.75；票价/基准 >1 时需求指数衰减（fare=2 时需求≈24%，fare=3≈4%，fare=4+≈1% 地板）。**单程收入最大票价 ≈1.05（1.0–1.1 区间）**；当前 1/2/3/4/5 阶梯中 2–5 元段严重压制需求。
- **实际生效条件**：票价 overlay 需要 OD/经营模式（`G.hourlyODBase` 非空、`_metroFareDemandOverlayActive=true`）。创意小网络实测 `od=false/overlayActive=false`：票价能写入但不会改变客流；经营模式再验证实际弹性。

## 2. 列车信息面板

点击列车/`openLineInfoPanel` 可打开 `train-panel`：

| 字段 | ID | 实测 |
|---|---|---|
| 线路/交路 | `#pt-line` / `#pt-route` | 无锡1号线 / 堰桥-南方泉 |
| 类型/编组 | `#pt-train-kind` / `#pt-type` | 普通列车 / B型 6节 |
| 额定/当前载客 | `#pt-cap` / `#pt-pax` | 1560 / 248（16%） |
| 区间 | `#pt-seg` | 太湖广场 |
| 最高速度/实时 | `#pt-speed-max` / `#pt-speed` | 80 km/h |
| 操作 | `#pt-follow-btn` / `#pt-delete-btn` | 跟踪列车 / 删除 |

## 3. 运营日报（`#nav-btn-flow-dashboard` → `#panel-flow-dashboard`）

实测内容：
- **经营数据**：创意模式显示「创意模式不显示经营数据」；经营模式显示现金/利润表/现金流量表。
- **客流数据**：
  - 线路客流（线名 + 客流，如 无锡1号线 2.6万）
  - 线路长度、客流强度、**高峰上线列车**（上日数据：高峰时段配置的上线列车数）
  - 车站客流：排序（车站顺序/客流 低→高）、不按线路分类
- 排序按钮：`.flow-dashboard-line-sort-btn`；关闭 `.flow-dashboard-close`。
- 数据源函数：`flowDashboardComputeLineFlow24h` / `flowDashboardGetStationSeries` / `line.flow.byHour` / 站点 `flowByLine[lineId].boardedWindow`（1440 分钟）。

## 4. 控制中心 / 客流面板（`#nav-btn-control-center`）

实测 `panel-ridership`：

| Tab | 内容 |
|---|---|
| 车站 | 车站客流排行（文化宫 451、南湖家园 353…，含线路数） |
| 线路 | 选中线路 24 小时客流量（如 214,090） |
| 导航 | 出发站/到达站 OD 搜索 |
| 排名（HSR/航班模式） | 高铁/航班排名、筛选（范围/日期/航司/机型等） |

- 入口：`openRidershipPanel('station'|'line'|'navigation')`；`#ridership-tab-*`。
- 拥挤告警：地图 toast「无锡1号线 三阳广场站台拥挤 +6」「部分列车满员 +3」——这是排班不足的直接信号。

## 5. 地图/设置/其它

- 地图样式 `#nav-btn-mapstyle` → 地图/语言/内容/地名/路网/交通；底图引擎行 `#mapstyle-engine-amap/osm`（可能被策略隐藏/禁用）。
- 菜单（≡）：米/英制、半径、站距、经营/创意、事件、每周需求、航空竞争、性能、声音。
- 站点环视、搜索、指南、示意图 v2–v5/transit-map 均走各自面板。

## 5.1 配额购买中心（HUD）

- 入口：HUD `#metro-quota-dock` 的额度环；`openMetroQuotaPurchaseCenter()`；面板 `#metro-quota-purchase-panel`。
- 项目：里程 $300,000/10km、车站 $150,000/5站、车厢 $60,000/6节、快速列车车厢 $360,000/6节；`metroQuotaHandlePurchase(key,units)` 写入。
- **配额可用余额购买**；建线只消耗 km/stations，快车消耗 cars/快线额度。

## 5.2 快车 / 交路面板

- 快车：线路信息 → `#line-info-btn-express`；`line.expressStops` 站索引 + `line.expressCaps` 三档；`migrateLineExpressConfig`/`rebuildLineExpressPreference`；快车消耗 cars（实测 used 8）。
- 交路：`#line-info-btn-routing`；`routeLegs` 允许重叠，但 min→max 必须连续覆盖；短交路通过 `line.routeLegs.concat` + `ensureRouteLegIds` + `validateRouteLegsCoverage` + `applyRouteLegSlotCount` 持久化。
- 实测：2 号线快车停 0/3/5/7/8，峰值 1 列；短交路 3–8 峰值 2 列，游戏自动补平峰/低峰 1。

## 5.3 阶梯票价 UI

- fare 侧栏默认 `distanceStep` 五段：0–6/6–12/12–22/22–32/32+；15 个 `.line-info-fare-watch` 输入。
- **官方弹性下平票 1.05 是单程收入上限**；温和阶梯 **1.05/1.10/1.15/1.20/1.25** 只低约1.4%（均匀权重），短途网络几乎相同。
- 应用：改输入 → `#line-info-fare-confirm`；或 `MetroEconomy.setFareRules`。全网 metro 规则，不是单线。

## 6. 真实 UI 操作工具

```bash
# 真实鼠标点击（CDP Input，CSS 像素坐标）
node browser/cdp-click.mjs '#line-info-cap-peak [data-delta="1"]'
```

- `.click()` 仅用于确实绑定了 click 的按钮；排班/票价确认等务必真实点击。
- 改输入：用原生 setter + `input`/`change` 事件，再真实点击确认。
- 中文输入：不要用 Git Bash curl 内联中文（GBK 乱码），走 base64/Node/Playwright。
