# 通过游戏自带线网示意图（规划图）绘制线路

## 功能概述

游戏自带"**线网示意图**"（Metro Diagram / Metro Schematic，点击地图页右下角"线网示意图"按钮进入）——把地图上的线路自动渲染成一张**网格化、45°/90°折线的示意规划图**（平行线路、走廊合并、换乘枢纽对齐）。

**关键机制（务必理解）**：
- **地图 → 示意图：单向**。示意图从地图线路自动生成；地图更新后点"重新绘制"（或脚本 `regenerateMetroDiagram()`）即可同步最新线路。
- **示意图 → 地图：不反向**。在示意图里调整（Shift+拖动车站/区间）只改变示意图显示，**不会**改地图。
- 示意图布局可**持久化**：存到 `localStorage['metro_diagram_layout_v1_<cityKey>']`（含 `stations`/`stationGeo`/`legs`）。
- 全局对象：`MetroDiagram`（生成）、`MetroDiagramEdit`（编辑会话）、`MetroSchematic`（标签偏移）。

**本功能的意义**：绘制完线路后，一键生成并展示一张美观的"规划图"；可脚本化在示意图上规划/调整线路排布（作为规划参考），并保存布局。全部用游戏自带接口，无需额外注入。

## 何时使用

- 用户要求"生成线网示意图 / 线路图 / 规划图 / 示意图"
- 用户要求"通过规划图绘制线路"（游戏自带的线网示意图）
- 用户要求"打开/关闭线网示意图视图"
- 用户要求"调整示意图排布 / 保存示意图布局"

## 全局接口速查（已实测验证）

| 函数 | 说明 |
|---|---|
| `MetroDiagram.generate(lines, opts)` | 从线路数组生成示意图布局（`{ok, lines, _stationPos, labelOffsets, bounds, phases, ...}`）。opts：`{cellSize, refLat, refLng}`（可省略，自动算） |
| `MetroDiagram.buildMapSnapshot(lines)` | 生成线路快照（用于 diff/存储），含 id/name/color/ring/stations(名称+坐标+换乘) |
| `openMetroDiagramView()` / `closeMetroDiagramView()` | 打开 / 关闭示意图视图 |
| `regenerateMetroDiagram()` | **重新绘制**（= 右下角"重新绘制"按钮）：从最新地图线路重新生成示意图 |
| `resetMetroDiagram()` | 重置示意图为自动生成效果 |
| `applyMetroDiagramGlobalLayout()` | 应用全局布局（平行/走廊对齐） |
| `fixMetroDiagramOnce()` | 修复一次示意布局 |
| `setMetroDiagramStage(e, t)` | 切换示意图阶段（geo/schematic/pathfit/relocated 等） |
| `toggleMetroDiagramGrid()` | 开关网格 |
| `toggleMetroDiagramStylePanel(e)` | 开关绘图样式面板 |
| `metroDiagramReloadSavedEditSession()` | 重载已保存的编辑会话 |
| `exportMetroSchematicLayoutForSave()` | 导出当前布局（含 stations/legs），用于持久化 |
| `restoreMetroSchematicLayoutFromSave(layout, city)` | 恢复布局到指定城市示意图 |
| `MetroDiagramEdit` | 编辑会话：`loadSession`/`saveSession`/`clearSession`/`applyLayoutToLines`/`applyLayoutToResult`/`applyStationMove`/`cycleLegRoute`/`createPointerController` |

## 操作流程

### A. 打开示意图视图
```js
const r = await page.evaluate(() => { openMetroDiagramView(); return true; });
```
（等效：`click_element` 点"线网示意图"按钮。关闭用 `closeMetroDiagramView()` 或点"返回地图"。）

### B. 生成 / 重新绘制规划图（核心）
```js
// 方式一：脚本直接调官方重新绘制（等效点"重新绘制"按钮，从最新地图线路同步）
const r = await page.evaluate(() => { regenerateMetroDiagram(); return true; });

// 方式二：先纯计算生成布局（不刷新视图），可先检查结果再决定是否落地
const r = await page.evaluate(() => {
  const lines = Object.values(window.G.lines);
  const res = MetroDiagram.generate(lines, {});
  return { ok: res.ok, lineCount: res.lines.length, stationPos: Object.keys(res._stationPos).length };
});
// 实测（113 条线路）：ok=true, lineCount=113, stationPos=2185, engine='qual-path-apply'
```

### C. 脚本化编辑示意布局（可选，作为规划调整）
```js
// 通过 MetroDiagramEdit 会话移动某个示意站 / 调整区间走向
const r = await page.evaluate(() => {
  const MDE = MetroDiagramEdit;
  // 1) 创建/加载编辑会话
  MDE.createPointerController({});       // 创建指针控制器（拖动用）
  // 2) 移动站点：applyStationMove(session, station, targetX, targetY, ...)
  // 3) 循环调整区间走向：cycleLegRoute(session, lineId, legIdx, ...)
  // 4) 应用布局到线路/结果
  MDE.applyLayoutToLines(session, lines, opts);
  return true;
});
```
> 大多数场景只需 B（自动生成），脚本化编辑用于用户想微调排布时。手动微调也可直接让用户在示意图里 Shift+拖动，然后保存。

### D. 布局持久化（保存 / 恢复）
布局存于 `localStorage['metro_diagram_layout_v1_<cityKey>']`，格式（已实测）：
```json
{ "version": 1, "cityKey": "anycity-global", "cell": ...,
  "stations": {},   // 被移动过的示意站位置（网格坐标；未移动则为空）
  "stationGeo": {}, // 站的真实地理坐标
  "legs": { "路径key": { "path": [{ "ix":108, "iy":412, "x":3456, "y":13184 }, ...] } } }
// legs = 用户手动编辑过的区间示意走向（网格点 ix/iy + 像素 x/y）；未编辑则为空
```
```js
// 读取当前城市已保存的布局（localStorage 直读）
const r = await page.evaluate(() => {
  const raw = localStorage.getItem('metro_diagram_layout_v1_anycity-global');
  return raw ? JSON.parse(raw) : null;
});
// 恢复布局到指定城市示意图（布局需含 cityKey/legs/stations）
const r = await page.evaluate(() => {
  const raw = localStorage.getItem('metro_diagram_layout_v1_anycity-global');
  if (raw) {
    restoreMetroSchematicLayoutFromSave(JSON.parse(raw), 'anycity-global');
    metroDiagramReloadSavedEditSession();
    return true;
  }
  return false;
});
```
> ⚠️ `exportMetroSchematicLayoutForSave()` 仅在存在**编辑会话**（`MetroDiagramEdit` 已 loadSession）时返回布局；纯自动生成、未手动编辑时返回 `null`。实际读写布局直接用 `localStorage` 的 `metro_diagram_layout_v1_<cityKey>` 更可靠。

## 与官方绘制流程衔接

绘制（SKILL.md 五步流程）完成后，若用户要看"规划图"效果：
1. `openMetroDiagramView()` 打开示意图视图；
2. `regenerateMetroDiagram()` 从最新地图线路生成规划图；
3. `screenshot_page` / `read_page` 展示结果；
4. 需要保存排布则执行 D 持久化。

## 易错点

- **示意图不改地图**：在示意图里的调整不会同步回地图（游戏官方行为）。"通过规划图绘制线路" = 用示意图作为**规划/展示视图**，真正的线路仍按 SKILL.md 官方绘制流程在地图上画。
- **地图改示意图**：地图线路变化后必须点"重新绘制"或调 `regenerateMetroDiagram()` 才同步。
- `MetroDiagram.generate` 第一参数是**线路数组**（含 `stations`），不是 `buildMapSnapshot` 的快照对象（快照用于 diff/存储）。
- 示意图布局持久化按城市 key 区分；恢复后调 `metroDiagramReloadSavedEditSession()` 刷新编辑会话。

