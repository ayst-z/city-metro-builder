# 多模式文件结构与预留（v0.1.0，2026-11-10）

## 当前结构（兼容，不破坏现有注入）

```
scripts/funcs/
├─ query/     mt-core.js / mt-node.js / mt-amap.js   数据源与节点拟合（共享）
├─ draw/      od.js                                   地铁官方绘制
├─ manage/    k.js / official-edit.js / fare-lab.js   管理、重绘、票价实验
├─ ops/       ops.js                                  排班/票价/收益运营
└─ modes/     mode-registry.js / hsr-probe.js / air-probe.js
```

## 目标结构（后续迁移，不动现有路径）

```
scripts/funcs/
├─ shared/              通用几何、单位、校验、缓存（从 MT 抽出）
├─ metro/               metro 适配层（query/draw/manage 的 facade）
├─ hsr/                 HSR 适配层（线路/车站/排班/经济）
├─ air/                 飞机适配层（航线/机场/票价）
└─ modes/               mode-registry + 各模式 probe
```

迁移原则：先加 facade，再把调用方切到 facade，最后移动文件；任何阶段都保持旧路径可注入。

## 模式适配器契约

`window.CityTransportModes.register(def)`，`def` 字段：

| 字段 | 说明 |
|---|---|
| `id` | `metro` / `hsr` / `air` |
| `label` | 界面显示名 |
| `reserved` | `true` 表示只读预留，不执行写操作 |
| `available()` | 当前城市/页面是否支持该模式 |
| `state()` | 只读状态（线路、列车、站点、经济输入） |
| `api()` | 该模式的官方接口入口（可选） |
| `opts()` | 官方车型/编组/限速等选项（可选） |

约束：
1. 预留模式只做只读探测，未实现的写操作返回 `{ok:false,reserved:true}`。
2. 所有写操作必须走游戏官方接口；不得直接改存档或注入状态。
3. 模式适配器不得共享全局可变状态；状态按 `G.transportMode` 区分。

## 已发现的官方入口

### 高铁（HSR）
- 模式：`G.transportMode`、`top.isHsrTransportMode()`、`top.citySupportsHsrTransportMode()`、`top.currentAnycityManifestSupportsHsr()`
- 运行时：`G.hsrRealworldMyRoutes`、`G.hsrRuntimeTrains`、`G._hsrLiveStations`、`G._hsrLiveSectionLoads`、`G._hsrLiveEconomyInput`
- 配置：`top.HSR_TRAIN_TYPE_OPTS`、`top.HSR_TRAIN_CARS_OPTS`、`top.HSR_TRAIN_CARS_CAPACITY`、`top.HSR_TRAIN_SPEED_OPTS`、`top.normalizeHsrTrainType/Cars/DesignSpeedKmh`
- 交互：`G.hsrAddStationMode`、`G.selectedHsrTrainRef`、`G.hsrFocusedLineRef`、`top.HsrAmbience`、`top.HsrAnnouncements`

### 飞机（Air）
- 模式：`G.transportMode`、`top.isFlightTransportMode()`
- 运行时：`G.flightLayerVisibility`、`G.flightAirportColors`、`G.airportPA`、`top.AirportPA`
- 入口：`top.openFlightPlannerPanel()`、`top.openFlightRouteSearchPanel()`、`top.applyFlightEntryMapNameDefault()`

## 下一步（预留实现顺序）

1. HSR 只读报表：线路数、运行时列车、站点客流、经济输入 → 接入 `HsrProbe`。
2. HSR 官方建线/放站/排班接口探测（先用只读 + UI 观察，确认后再写）。
3. Air 只读报表：机场、航线、票价、客流 → 接入 `AirProbe`。
4. 模式切换与注入隔离：按 `G.transportMode` 选择 facade，禁止跨模式写。
