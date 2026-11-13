# funcs 模块清单（2026-11-10）

## 注入顺序

```
query/mt-core.js → query/mt-node.js → query/mt-amap.js
→ draw/od.js → manage/k.js → ops/ops.js
→ manage/official-edit.js → manage/fare-lab.js
→ modes/mode-registry.js → modes/hsr-probe.js → modes/air-probe.js
```

同版守卫会跳过重复注入；改动模块必须 bump 版本并同步 `_dev/smoke.js` 期望值。

## 模块职责

| 路径 | 全局 | 职责 |
|---|---|---|
| `query/mt-core.js` | `__metroToolkit` | 配置、城市/配色/车型解析、坐标工具、srhdata |
| `query/mt-node.js` | 同上 | 节点拟合：Catmull-Rom、曲率抽稀、站台避让、样条回退 |
| `query/mt-amap.js` | 同上 | 高德/OSM 查询、逐段拼接、在建线、srhdata |
| `draw/od.js` | `__officialDraw` | 地铁官方绘制/延长/支线/检查 |
| `manage/k.js` | `CityMetroKit` | 批量管理、校准、换乘、快照回滚 |
| `ops/ops.js` | `MetroOps` | 客流、排班、票价、收益计划 |
| `manage/official-edit.js` | `OfficialEdit` | 官方编辑、断线重绘、通知、监测、预算 |
| `manage/fare-lab.js` | `FareLab` | 票价实验记录与对比 |
| `modes/mode-registry.js` | `CityTransportModes` | metro/hsr/air 模式注册与检测 |
| `modes/hsr-probe.js` | `HsrProbe` | 高铁只读状态/官方配置/额度（预留） |
| `modes/air-probe.js` | `AirProbe` | 飞机只读状态/入口/额度（预留） |

## 共享约束

1. 写操作只走游戏官方接口；查询/计算可脚本化。
2. 节点写入前必须站台避让（≥100m）；直写 `q.nodes` 先过 `MT.padSegmentNodes`。
3. 未开通/漏段线路优先 `MT.queryLineBySegments`（逐段 SUBWAY path），无 path 段才用 `MT.smoothLineNodes` 并标记估算。
4. 配额快照为 `{metro,hsr,aviation}` 嵌套结构；`OE.economyPlan` 按下一线缺口给最小购买包。
5. HSR/飞机当前只读；未实现写操作返回 `{ok:false,reserved:true}`。

## 目标结构（迁移中）

```
funcs/
├─ shared/    通用几何/缓存/校验
├─ metro/     地铁 facade（现 query/draw/manage/ops 的聚合层）
├─ hsr/       高铁适配层
├─ air/       飞机适配层
└─ modes/     注册表与探测
```

迁移原则：先加 facade，再切调用方，最后移动文件；任何阶段旧路径保持可注入。详见 `modes/README.md`。
