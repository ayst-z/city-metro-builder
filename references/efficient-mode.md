# 高效模式（v3 并入）— 实时查询 · 一次对话一条线 · 省 token 不降准确

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
