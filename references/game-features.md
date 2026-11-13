# 全游戏功能覆盖矩阵（2026-11-09，v4.1）

> 目标：每个游戏功能要么**可自动执行**，要么明确给出**半自动步骤**或**建议**，不留“不知道能不能做”的灰区。
> 状态：🟢自动（脚本可完成）· 🟡半自动（脚本 + UI 操作/确认）· 🔵建议（只读/人工，不自动执行）。
> 页面侧自检：注入 `scripts/audit-game-features.js` 后调 `window.__gameFeatureAudit()`，返回入口/全局/API 的可用性报告。

## A. 进入 / 存档 / 账号

| # | 功能 | 入口 | 自动化 API / 做法 | 状态 | 建议 |
|---|---|---|---|---|---|
| A1 | 登录 / 刷卡进入 | 登录页、City Card | 用户操作；授权后可脚本点击，但**不代输凭据** | 🟡 | 默认让用户完成 |
| A2 | 经营 / 创意模式 | AnyCity 模式卡 | 用户操作；授权后 `button.flight-base-mode-option.is-creative` 可点 | 🟡 | 测试用创意，正式存档先备份 |
| A3 | 存档：云端/本地/分享码/缓存/现实1:1/直接进入 | 选择存档 | 用户选择；直接进入可脚本 `button.metro-entry-save-direct` | 🟡 | 云端/分享码不走脚本 |
| A4 | 保存存档 | HUD / Ctrl+S | `top.downloadLocalSave()`；面板内置自动快照 | 🟢 | 改线前必存 |
| A5 | 云存档 / 分享码 | 存档页 | 账号/网络 UI，无公开写入 API | 🔵 | 建议用户手动；不做自动上传 |
| A6 | 页面恢复（本地草稿/正规入口） | 城市选择页 | `metroEnterAnyCityPointFromPixelMap(lng,lat,country,geofabrikId)`；恢复后重注工具箱 | 🟡 | 直开 anycity 可能缺 normalizer |

## B. 地铁绘线 / 线路管理

| # | 功能 | 入口 | 自动化 API / 做法 | 状态 | 建议 |
|---|---|---|---|---|---|
| B1 | 新建普通线 | `#nav-btn-add-line` | `OD.createLine`（兼容新版 `#line-name-input`+`#modal-line-confirm-btn`“建设”/旧版“如：1号线”+“开始铺设轨道”）→ `OD.applyLineData` | 🟢 | 实测新版弹窗结构已变，旧选择器会失败 |
| B2 | 支线 | 官方 B 键 | `OD.startBranch` → `OD.applyBranchData` → `OD.finishBranch` | 🟢 | 主线取最长（`OD.pickLongest`） |
| B3 | 环线 | 官方闭合 | `OD.applyLineData(...,{isRing:true})` / `top.completeRingLine` | 🟢 | `MT.queryRingLine` 取完整闭环 |
| B4 | 车站/节点/拟合 | 绘线流程 | `OD.drawLine` / `fastDraw` / `rebuildNodesFromAmap` / `MT.fitSegmentNodes` | 🟢 | 先属性后站，再节点；srhdata 命中无 path 时 `queryLine` 在 AMap 可用下**自动精化**（实测 129ms），失败才保留 `straight` 并需 `rebuildNodesFromAmap` |
| B5 | 官方站名/配色/车型/编组 | 线路设置 | `OD.renameStations` / `K.applyOfficialColors` / `OD.setLineProps` | 🟢 | 站名先于换乘 |
| B6 | 速度 / 编组 / 车型（表单） | `#modal-line` | 展开 extra panels 后点胶囊 → `#modal-line-confirm-btn` | 🟡 | 速度档见 operations.md §22 |
| B7 | 换乘 | 线路/车站面板 | `K.applyTransfer`（逐站）/ `OD.autoTransfers` | 🟢 | 大存档禁用 `autoTransfersBulk` |
| B8 | 坐标校准 / 节点顺序修复 | 修复流程 | `K.calibrateCoordinates` / `K.resolveLineCoord` / `OD.fixNodeOrder` | 🟢 | 顺序检查先于一切补点 |
| B9 | 删除 / 重建 | 线路面板 | `K.deleteLine` / `deleteCityLine` / `OD.rebuildNodesFromAmap` | 🟢 | RED：先 `K.snapshot` + 用户确认 |
| B10 | 运行时间（首末班/24h） | 线路信息侧栏 | `commitLineInfoServiceTimes()` / `commitLineInfoServiceTimesForAllLines()` | 🟡 | 侧栏需强开（update §G.1） |
| B11 | 发车间隔 / 上线列车数 | 线路信息侧栏 | `applyRouteLegSlotCount(line,legIdx,'peak'\|'off'\|'low','local',count)` | 🟡 | 读腿级字段，勿用线顶层镜像 |
| B12 | 交路（routing） | routing 侧栏 | `readRouteLegsFromLine` 读取；编辑入口在侧栏 | 🔵 | 改排影响发车，未做 delta，建议人工 |
| B13 | 快车 / 经停站 | express 侧栏 | `line.expressCaps` + `applyRouteLegSlotCount(...,'express',...)` | 🟡 | 门控 `routingExpressFeatureDisabled()` |
| B14 | 票价规则 / 票价表 / 阶梯 | fare 侧栏 | `MetroFarePolicy` + `MetroOps.recommendFares({tiered:true|false,ladder})/applyFares`；`lineInfoFareRulesGetMetro` | 🟡 | **平票 1.05 是单程收入上限**；默认温和阶梯 1.05/1.10/1.15/1.20/1.25（均匀权重约 -1.4%，短途网几乎相同）；写入需 OD/经营模式才影响客流 |
| B19 | 客流排班（高峰/平峰/低峰列车数） | 线路信息侧栏 | `MetroOps.hourlyDemand/recommendSchedule/applySchedule`；`applyRouteLegSlotCount` | 🟡 | 自动模式会覆盖手动值；确定性优化先关闭 `#line-info-btn-auto`；应用后复核间隔 |
| B20 | 快车 / 短交路 | express/routing 侧栏 | `line.expressStops/expressCaps` + `migrateLineExpressConfig/rebuildLineExpressPreference`；`routeLegs` + `applyRouteLegSlotCount` | 🟡 | 快车消耗 cars/快线额度；交路允许重叠但必须连续覆盖；实测 2 号线快车 5 站 + 短交路 3–8 |
| B15 | 未开通 / 规划线 | 查询 | `MT.queryUnopenedLine` / `queryLineStopsByPOI` | 🟢 | 走向缺失时询问用户；无 AMap/key 时 POI 自动回退注入的 srhdata 站表（`dataSource:'srhdata'`） |
| B16 | 有轨电车 / 非标准线 | 查询 | `MT.queryTramLine` / `resolveTramCoord` / `_nonStdFilter` | 🟢 | 查询后按普通线绘制 |
| B17 | 枚举未绘制 / 批量绘制 | 询问 | `MT.officialColors` 差集 + 逐条核心五步 | 🟢 | 每条独立核对站名/换乘 |
| B18 | 绘制后检查 | 流程 | `OD.checkLine3x` + `OD.verifyLine` + `OD.verifyLineOrder` | 🟢 | 全过才交付 |

## C. 线网示意图 / 规划图

| # | 功能 | 入口 | 自动化 API / 做法 | 状态 | 建议 |
|---|---|---|---|---|---|
| C1 | 示意图 v2/v3/v4/v5 | 导航 v2–v5 | `top.openMetroDiagramView()` + 面板按钮；布局存 `METRO_SCHEMATIC_SAVE_STORAGE_PREFIX*` | 🟡 | 面板块多，按版本说明操作 |
| C2 | transit-map（MIP 八向） | `#nav-btn-transit-map` | 面板打开 + 参数；布局持久化 | 🟡 | 只读/生成，不自动改存档 |
| C3 | 重新绘制 / 绘图样式 | `#nav-btn-diagram-redraw` / `-style` | 面板按钮 | 🟡 | 先备份布局 |
| C4 | 规划图 / 图片复刻 | 图片 | `references/plan-map-draw.md` + 拟合算法 | 🟢 | 多次比对门禁 |
| C5 | 文件层面复刻 | 存档文件 | `references/metro-replication-workflow.md` | 🟢 | 离线验证后输出新存档 |

## D. 控制中心 / 客流 / 搜索 / 地图

| # | 功能 | 入口 | 自动化 API / 做法 | 状态 | 建议 |
|---|---|---|---|---|---|
| D1 | 控制中心（车站/线路/导航） | `#nav-btn-control-center` | `openRidershipPanel('lines'\|'stations'\|'navigation')` | 🟡 | 只读面板，不代改 |
| D2 | 运营日报 / 24h 客流 | `#nav-btn-flow-dashboard` | `initFlowChordPanel` / `flowDashboard*` 系列 | 🔵 | 创意模式显示“不显示经营数据”属正常 |
| D3 | 重新加载客流 | `#nav-btn-flow-reload` | 面板按钮 / `redrawAllMetroOverlays()` | 🟡 | 大存档分批 |
| D4 | 站点环视 | `#nav-btn-station-tour` | `stationTourRunning` / 面板按钮 | 🟡 | 只读体验功能 |
| D5 | 搜索地铁站/线路 | `#nav-btn-metro-search` | 面板搜索 | 🟡 | 结果只读 |
| D6 | 地图样式 / 绘图样式 / 底图引擎 | `#nav-btn-mapstyle` / `-diagram-style` | 面板选择；引擎切换 `applyMapEngine('amap'\|'osm')`，先查 `getMapEnginePolicyForCurrentCity()` | 🟡 | 实测可能仅开放 OSM（IP+城市策略）；被拒时按 `MT.dataSourceStatus().recommended` 走高德数据+OSM 渲染 |
| D7 | 单位/半径/站距/声音/事件/周需求/竞争/性能开关 | ≡ 菜单 | `.game-menu-toggle-*` 按钮 | 🟡 | 设置类只做必要项 |

## E. 经营模式 / 经济

| # | 功能 | 入口 | 自动化 API / 做法 | 状态 | 建议 |
|---|---|---|---|---|---|
| E1 | 资金/配额/账本/购买报价 | 经营 HUD | `MetroEconomy.getState/getFinanceSnapshot/getLedgerRows/metroPurchaseQuote` | 🔵 | 只读；**不自动花钱/购买** |
| E2 | 地铁经济规则/票价策略 | 控制中心/票价 | `MetroEconomyRules.*` / `MetroFarePolicy.*` | 🔵 | 报价与配额是两套引擎，引用需注明 |
| E3 | 事件波/重点站客流 | 运营日报 | `HsrEconomyRules.ensureEvents/eventBoost/metroStationEventProfile` | 🔵 | 事件叠加导致客流偏高，勿改走向“压客流” |
| E4 | 存档模式兼容 | 存档页 | `MetroSaveModePolicy.canLoad/prepare` | 🟡 | `save_mode_incompatible` 不是存档损坏 |
| E5 | 经营档配额/购买/结算 | HUD/经济面板 | `metroQuotaHandlePurchase(key,units)` / `openMetroQuotaPurchaseCenter`；`MetroEconomy.getFinanceSnapshot/getState` | 🟡 | 配额可用余额买：10km/$300k、5站/$150k、6车厢/$60k、6快线/$360k（实际扣款含约4–6%费用）；pending 按小时桶重置 |
| E6 | 综合收益优化 | `MetroOps` | `optimizeRevenue/recommendNetwork/applyRevenuePlan/revenueSnapshot/revenueDelta`；票价+列车数+快车+短交路 | 🟡 | 平票 1.05 收入上限；温和阶梯做长途收益；快车/短交路加运力；同一小时测 net=票款+补贴-成本 |

## F. 高铁 HSR

| # | 功能 | 入口 | 自动化 API / 做法 | 状态 | 建议 |
|---|---|---|---|---|---|
| F1 | 高铁搜索/订票 | `#nav-btn-hsr-search` / `-booking` | 控制中心 HSR 面板；**建议人工** | 🔵 | 非地铁绘线目标；订票涉及资金，不自动 |
| F2 | 高铁线路/车站/时刻/运营 | 控制中心 HSR | `HsrEconomyRules` / `HsrAmbience` / `HsrAnnouncements`（只读） | 🔵 | 可读取做客流解读，不写入 |
| F3 | 高铁经济/事件波 | 运营日报 | `HsrEconomyRules.quote/serviceCost/ensureEvents` | 🔵 | 只读参考 |

## G. 航空 Aviation

| # | 功能 | 入口 | 自动化 API / 做法 | 状态 | 建议 |
|---|---|---|---|---|---|
| G1 | 航班订票 | `#nav-btn-flight-booking` | 面板；**建议人工** | 🔵 | 涉及资金，不自动 |
| G2 | 航线规划/时刻/经济/竞争 | 航班面板 | `openFlightPlannerPanel` / `openFlightRouteSearchPanel` / `AviationEconomyRules.fare` | 🟡 | 可打开面板/读规则，不自动下单 |

## H. Voyager

| # | 功能 | 入口 | 自动化 API / 做法 | 状态 | 建议 |
|---|---|---|---|---|---|
| H1 | 护照/收藏/会员/活动 | 菜单/Voyager 页 | `metroPassport*` / `metroVoyagerActivityStatus`（只读） | 🔵 | 与绘线无关，建议用户自行体验 |

## I. 设置 / 性能 / 诊断

| # | 功能 | 入口 | 自动化 API / 做法 | 状态 | 建议 |
|---|---|---|---|---|---|
| I1 | 性能模式（禁客流重算） | 菜单/脚本 | `setMetroPerformanceMode(true/false)` | 🟢 | 绘制前开、结束关 |
| I2 | Jank/低缩放平滑/客流分层 | 菜单/localStorage | `METRO_JANK_OPTIMIZATION_*` / 菜单开关 | 🟡 | 大存档按需 |
| I3 | 缓存/加载诊断 | 控制台 | `getMetroCacheAudit()` / `getMetroLoadingAudit()` | 🔵 | 排障只读 |

## J. 其它

| # | 功能 | 入口 | 自动化 API / 做法 | 状态 | 建议 |
|---|---|---|---|---|---|
| J1 | 操作指南/公告/更新日志 | `#nav-btn-guide` / 弹窗 | 只读 | 🔵 | 遇到新版本先读公告 |
| J2 | Real-world 1:1 / AnyCity / 虚拟岛 | 入口页 | `metroEnterAnyCity*` / `METRO_VIRTUAL_ISLAND_*` | 🟡 | 进档/选存档由用户 |
| J3 | 导入/导出存档 | 存档页 | `top.downloadLocalSave()`；导入走 UI | 🟡 | 导入前备份 |

## 自动化红线（所有状态适用）

1. **不代输凭据**：邮箱/密码/验证码/支付信息只能用户输入；不上传 Cookie/Token。
2. **不自动花钱**：购买配额、订高铁/机票、Voyager 付费一律只读或建议。
3. **不自动破坏**：删除/重建/批量改线前 `K.snapshot` + RED 确认；用户自绘内容保留（SKILL §0.2）。
4. **不代选模式/存档**：除非用户明确授权（如“全程自主测试”）。
5. **不改经济/客流数据**：只读解读；事件造成的客流偏高不是绘线错误。
