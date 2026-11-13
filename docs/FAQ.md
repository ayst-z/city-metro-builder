# 常见问题与排障

## 数据

**Q1. `queryLine` 查不到 / 站表不全？**

- 按降级链排查：srhdata → 游戏内高德 → 免费 Web → POI → OSM；`dataSource` 字段会写明实际用的源。
- 核对 `warnings` 的起讫点：高德同线多 plan 会少站（17 号线默认 13 站，指定西岑—虹桥火车站才 14 站）。延长段要用官方 `startExtendLine`。
- 环线只回半圈：改 `queryRingLine` 或逐段 `queryLineBySegments`。
- 未开通/在建：`queryLineStopsByPOI` / `queryUnopenedLine`；POI 必须有正向线证据或带 `opts.stations` 白名单，出入口/铁路/公交一律拒绝。
- 实在没有数据：按图/走廊/估算降级，但必须汇报数据源与冲突，不能默默用直线。

**Q2. 节点乱序、折返、绕路怎么办？**

- 先判：`OD.hasNodeOrderIssue(segments)` — 折返 > 120° 或中点偏离首尾连线 > 500 m 即乱序。
- 再修：`OD.fixNodeOrder`；修复后**必须复扫到 remaining = 0** 才能补点/收尾。置空段 = 两站直线直连，是安全的中间态。
- 绕路比异常：`OD.checkLine3x` 走向检查会给出折线/直线比（普通线 > 2.2 报警），重新按 path 拟合而不是硬删点。

**Q3. 节点钻进站台？**

- 所有直写 `segmentAnchors` 的路径先调 `MT.padSegmentNodes(stations, nodes, { endPadM: 100 })`；`fitSegmentNodes` 与 `applyLineData` ④b 已内置。
- 验收：每段首末节点到对应车站 ≥ 100 m；剔空段取中点，不要回退到站点本身。

## 绘制

**Q4. 环线 / 支线怎么画？**

- 环线：`OD.drawLine(id, stations, nodes, { isRing: true })`，`completeRingLine` 负责闭合，环线闭合段数 = 站数 N。
- 支线：走官方 `startBranchLine`（`startBranch → applyBranchData → setBranchAnchors → finishBranch`），取最长支为主线；支线直写节点前同样要避让。
- 延长：官方 `startExtendLine`，不要拆成两条独立线路。

**Q5. 重绘后线位变差 / 想整体重来？**

- 调整位置先删全部节点再重绘（`segmentAnchors` 置空 + `rebuildGeometry`），不要在旧节点上叠加。
- 重绘单条线 = 删整条旧线 + 完整重绘；**删线前备份换乘**（`window.__lineTransferBackup`，完成后按备份 `K.applyTransfer` 恢复并比对数量）。

## 规划图

**Q6. 按图绘制为什么要「客观第一」？**

- 图纸只作大致参考（站名/站序/颜色/走廊）；几何要结合真实地理自主设计，**不做像素拟合**。
- 像素拟合管线（`plan-map.py` 的 trace/`PlanMap.prepare` 图纸平滑链）保留给能力较弱的小模型，只在显式选择时启用。
- 验收用真实证据：站落路口/真实站台、线位到道路中心线中位 ≤ 30 m、到图纸走廊 ≤ 40 m 且弯点拓扑同构、最小曲线半径 ≥ 车型困难值。

## 运行环境

**Q7. 注入后没反应 / 版本没更新？**

- 版本守卫：同版本重复注入会被跳过。改脚本后必须 bump 版本（`__version`）再注入，否则页面还是旧逻辑。
- 核对目标页面是否同一个（多标签页各自独立）。

**Q8. 页面卡死 / 重载后线路没了？**

- 存档在 IndexedDB，数据不会丢；**模式/存档界面由用户自己选**，AI 不代点。
- `G.lines` 为空时，清掉恢复守卫（`_localDraftNoFlowRestoreGuard = {}` 等）再调 `tryRestoreLocalDraftNoFlowForCity('anycity-global')`；`metroSafeStartSkipsLocalDraft` 是函数，不要覆盖成布尔。
- 刷新一律 `redrawAllMetroOverlays`，不要 `location.reload()`。

**Q9. 中文变成乱码？**

- Windows Git Bash 的 curl 内联中文会按 GBK 发送。改用 CDP `/eval {b64}`、`browser_evaluate` 或 Node/Playwright 直传 UTF-8。

**Q10. 回归测试跑不起来？**

- `test-plan-map.py` 需要 OpenCV（`pip install opencv-python`）；纯 JS 用例（smoke / lint / plan-draw / plan-poi / branch-ring / autopilot）不需要 Python。

## 经营

**Q11. 票价默认多少？**

- 经营模式默认官方五段 `1/2/3/4/5`（边界 0/6/12/22/32/∞，对齐成本带与补贴）；创意模式的小网络才用需求弹性。
- 购配额必须用官方递增报价 `metroPurchaseQuote(item, 数量)`，每次购买前重新报价，并留日结与建设缓冲。

**Q12. Autopilot 怎么用，会不会乱来？**

- 仅经营模式：`MetroAutopilot.start({ intervalMs, maxTicks, buyPacks, dryRun, analysisEvery })`。
- 有界循环 + LIMITS 安全边界 + 营收劣化自动回滚；不存档、不抢前台、不绕配额。建议先 `dryRun: true` 观察一轮日志。

## 安全

**Q13. 误删 / 改错能回滚吗？**

- 改前 `K.snapshot('标签')`，改后 `K.listAudit()` 可查，`K.rollback(索引或 id)` 即时回滚；`deleteLine` / `deleteCityLine` 内置自动快照。
- 未知线路（数据源不认识的线）坐标/走向/颜色/命名**全部保留**，只有可证同一的官方站才动。
