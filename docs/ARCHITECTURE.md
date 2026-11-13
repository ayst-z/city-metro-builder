# 架构说明

> 代码基线：`scripts/funcs/`（拆分架构，唯一权威）。几何单一权威是 MT，OD / K / PlanMap / mt-amap 全部委托它，不本地复制。

## 分层

| 层 | 模块 | 全局对象 | 职责 |
|---|---|---|---|
| 基础设施 | `query/mt-core.js` | `__metroToolkit` | 坐标转换、城市/规格/配色、超时降级、POI 校验 |
| 几何 | `query/mt-node.js` | 同上 | Catmull-Rom 采样、`curvatureThin` 抽稀、`fitSegmentNodes` 拟合、`padSegmentNodes` 避让 |
| 数据源 | `query/mt-amap.js` | 同上 | 高德 srhdata / POI / SUBWAY path、OSM、有轨、瓦片、缓存 |
| 绘制 | `draw/od.js` | `__officialDraw` | 官方逐站绘制、支线、环线、换乘、四检 |
| 管理 | `manage/k.js` | `CityMetroKit` | 批量、快照回滚、风险拦截、命名、地区、校准 |
| 运营 | `ops/ops.js` | `MetroOps` | 客流、排班、票价、收益 |
| 托管 | `ops/autopilot.js` | `MetroAutopilot` | 有界循环、自递归优化、营收劣化回滚 |
| 经营编辑 | `manage/official-edit.js` | `OfficialEdit` | 配色/编组确认、官方延长/支线、额度报价 |
| 票价实验 | `manage/fare-lab.js` | `FareLab` | 调价记录、候选方案、前后对比 |
| 规划图 | `draw/plan-map.js` | `PlanMap` | 图纸 → 几何 → 官方绘制（离线管线 `scripts/plan-map.py`） |
| 多模式 | `modes/*` | `CityTransportModes` 等 | 高铁/航空适配器契约与只读探测 |

## 注入与版本守卫

```
mt-core → mt-node → mt-amap → od → k
        → (可选) ops → autopilot → official-edit → fare-lab → modes → plan-map
```

- 每个模块自带 `__version`，同版本重复注入直接跳过（版本守卫）。
- 改脚本必须同时：① bump 模块版本；② 同步 `_dev/smoke.js` 的 `EXPECT_VERSION`；③ 更新 `SKILL.md` §2.4 版本表。

## 数据流

```
高德/OSM 数据  ──queryLine──▶  站表 + SUBWAY path
                                   │
                         fitSegmentNodes（站投影 + 样条拟合 + 站台避让）
                                   │
                         curvatureThin（DP 保形 → 弯道加密 → 直线均匀 → minGap 过滤）
                                   │
                         OD.drawLine / applyLineData（官方接口逐站写入）
                                   │
                         checkLine3x（结构/坐标/视觉/走向）+ 节点顺序复扫
                                   │
                         汇报 / 快照回滚
```

## 关键不变量（改代码必须满足）

1. **几何单一权威 = MT**：距离、样条、抽稀、避让只允许一处实现。
2. **节点贴 path**：每段节点到本线 path 最大偏差 ≤ 30 m，超了必须重建该段。
3. **站台避让**：首末节点距两端车站 ≥ 100 m（`endPadM`）；剔空取两站中点，不回退站点。
4. **站序/节点顺序**：允许整线镜像，不允许相对乱序；乱序修完复扫到 0 才能补点。
5. **空段 = 用户设计**：无节点段视为有意直连，不自动补点。
6. **改数据先快照**：任何写线路数据的操作先 `K.snapshot`，可 `K.rollback`。
7. **官方接口优先**：绘制/增删改走 `top.*` 官方接口，脚本只做只读查询与计算。
8. **不抢前台**：禁止 `Page.bringToFront` / `SetForegroundWindow` 等，后台节流就如实报告倍率。

## 目录

```
SKILL.md              主指南（§0 全局硬规则 → §1-8 板块 → §9 特例 → §10 函数速查）
references/           专题文档（api-reference / official-draw / operations / plan-map-draw …）
scripts/funcs/        注入工具箱
scripts/plan-map.py   离线配准 + 追线
_dev/                 回归测试（lint / smoke / 几何 / POI / 支线环线 / Autopilot）
docs/                 本文档集（quickstart / architecture / FAQ / privacy / THIRD_PARTY）
```

## 扩展点

- 新交通模式：实现 `modes/mode-registry.js` 的适配器契约（`id` / 名称 / 探测 / 绘制能力），`hsr-probe.js`、`air-probe.js` 是只读样板。
- 新数据源：在 mt-amap 里加 `queryXxx` 并接入 `queryLine` 降级链，返回值保持 `{ ok, stations, nodes, pathQuality, dataSource }` 形状。
- 新检查项：加在 `OD.checkLine3x` 的对应维度，返回 `{ pass, detail }`，并补 `_dev/test-plan-draw.js` 用例。

## 回归

改几何/数据源/绘制必跑：`node _dev/smoke.js`、`node _dev/test-plan-draw.js`、`node _dev/test-plan-poi.js`、`node _dev/lint-static.js`；规划图改动加跑 `python _dev/test-plan-map.py`（需要 OpenCV）。
