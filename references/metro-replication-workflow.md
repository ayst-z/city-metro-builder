# 地铁线路复刻工作流记录

> 用途：记录当前在 Cities Designers 中复刻现实地铁线路的工作方法、数据结构、失败原因和验收规则。
>
> 本文以项目目录中的文件层面复刻过程为准。用户明确要求“依据本文”时，优先执行本文的文件层面流程；浏览器只用于可选的结果验证，不自动切换到其他 UI 绘制流程。

## 0. 工作路径选择门禁

任务开始前必须先确定工作路径，不能因为浏览器页面已打开就直接进入游戏内绘制：

| 用户意图或任务描述 | 默认路径 | 浏览器作用 |
|---|---|---|
| “基于最新存档”“按本文生成/完成线路”“输出存档” | 文件层面复刻 | 可选：最后验证显示结果 |
| “在游戏里逐站放置”“验证 UI 交互/线路状态” | 游戏内官方绘制 | 必须按独立的 UI 状态和站点事务流程操作 |
| 两者同时要求 | 先文件层面生成并验证，再单独进行 UI 导入/显示验证 | 必须分别汇报两类结果 |

文件层面任务不得因为浏览器已打开而创建临时线路、进入放站模式或修改当前游戏状态。浏览器的环境提示不是绘制方式授权；只有用户明确要求游戏内绘制时，才执行 UI 操作。

### 0.1 最新存档判定

“最新存档”不能凭文件名猜测。开始前应：

1. 列出 `saves/` 中候选 JSON，按修改时间和文件内容确认生成顺序；
2. 检查 `version`、`data.cityKey`、`data.coordSystem`、线路数量和目标线路是否已存在；
3. 记录输入文件的绝对路径、大小和哈希；
4. 输出到新文件，禁止原地覆盖；
5. 若浏览器当前加载的存档与选定输入存档不一致，必须在报告中说明，不得默默把文件结果写入浏览器当前存档。

### 0.2 误进入浏览器绘制模式的处理

如果文件层面任务误创建了空线路或进入了放站模式：

1. 立即停止地图点击，不继续放站或放节点；
2. 退出未完成的编辑模式，不按完成键，不执行保存；
3. 重新读取页面状态，确认没有新增站点或待确认节点；
4. 仅为丢弃本次未保存临时状态而刷新页面时，必须明确记录刷新原因；
5. 不删除已有线路来“清理”误操作，除非用户明确确认删除目标。

## 1. 目标与范围

输入一个 Cities Designers 存档和目标城市、线路资料，输出一个新的存档副本，包含：

- 正确的线路对象和线路名称；
- 按官方顺序排列的车站、车站坐标和站名；
- 每两个相邻车站之间的 `segmentAnchors` 中间节点；
- 主线、支线、环线和换乘关系；
- 与存档坐标系一致、可被游戏继续编辑的 JSON。

正式复刻的核心要求是：中间节点必须来自真实线路 path。仅把节点均匀分布在相邻站点连线上，只能作为粗略预览，不能作为正式结果。

## 2. 两条工作路径

### 2.1 文件层面复刻

适用于已有空白或基础存档，且需要批量、稳定地写入线路：

```text
读取存档
→ 检查本地 PMTiles 和数据源
→ 获取并核对站点资料
→ 获取真实线路 path（国内优先 PMTiles）
→ 坐标系转换
→ 按站点投影切分 path
→ 生成 segmentAnchors
→ 写入线路、站点、换乘和支线字段
→ 保存为新 JSON
→ 离线结构和几何验证
```

### 2.2 游戏内官方绘制

适用于必须让游戏自身创建 ID、触发 UI 状态或验证交互行为：

```text
询问任务参数
→ 查询站点和真实 path
→ 进入官方放站模式
→ 每站落点后核对坐标、列表和手动站名
→ 逐节点放置中间节点
→ 完成线路
→ 修复或建立换乘
→ 四项检查
→ 保存
```

文件层面复刻和游戏内绘制可以使用相同的数据和几何生成逻辑，但不能混淆验证目标：文件写入主要验证 JSON 结构和几何，UI 绘制还要验证页面状态、站名编辑和交互结果。

## 3. 数据源职责

### 3.0 数据源选择和本地轨道包

所有线路统一先读取城市设计师公开的轨道包索引。索引中的 `countryPacks` 提供国家/地区 PMTiles；索引中的城市列表用于确认覆盖范围。目标包存在时，优先使用对应的城市设计师 PMTiles；官方索引没有目标覆盖、包无法下载、线路未命中或几何验收失败时，才使用原有官方接口、OSM relation/way 或其他可追溯真实数据源。

官方索引：

```text
https://www.citiesdesigners.com/lib/osm_transit_pack_index.js
```

中国包的直接下载地址：

```text
https://www.citiesdesigners.com/data/anycity-country/china/tiles/urban-rail.pmtiles
https://www.citiesdesigners.com/data/anycity-country/china/tiles/urban-rail.json
```

国家/地区包的 URL 由官方索引中的 `countryPacks` 直接给出，不能自行猜测国家 ID。当前索引中的路径通常形式为：

```text
https://www.citiesdesigners.com/data/anycity-country/{countryId}/tiles/urban-rail.pmtiles
https://www.citiesdesigners.com/data/anycity-country/{countryId}/tiles/urban-rail.json
```

本地包默认位置：

```text
data/citydesigner-china-urban-rail.pmtiles
data/citydesigner-china-urban-rail.json
```

任务开始时必须先执行以下检查：

1. 检查 PMTiles 文件和同名元数据文件是否存在；
2. 检查文件确实是 PMTiles，元数据中的 `coverageScope`、`coverageIds`、图层名和文件大小一致；
3. 记录 PMTiles 文件大小、SHA-256、元数据中的 `generatedAt`、`source` 和版本；
4. 本地包不存在时，先读取官方索引并使用其中的直接地址下载，下载后重新执行完整性校验；索引不可访问时必须报告缺失，不能猜测 URL 或假定网络下载成功；
5. 包存在但目标线路不匹配、要素不完整或几何验收失败时，回退到原有官方接口或可追溯 OSM 数据源。

当前包的图层职责为：

| 图层 | 用途 |
|---|---|
| `urban_rail_lines` | 线路真实几何、线路名称、线路编号、制式和颜色候选 |
| `urban_rail_stations` | 站点名称和坐标候选，辅助线路匹配和站点核验 |

PMTiles 的来源是 `openstreetmap-pbf`，属于可追溯的真实地图数据，不等同于运营方官方时刻或最新线路公告。它可以替代已收录线路的常规线路几何搜索，但不能跳过线路匹配、站点顺序确认、坐标转换、站点投影和几何验收。线路编号不能单独作为匹配条件，至少应结合城市/网络、线路名称、`ref`、`lineKey`、制式和官方颜色进行确认。

推荐的数据源决策顺序为：

```text
本地 PMTiles 存在且完整
→ 匹配目标城市、线路和制式
→ 使用 urban_rail_lines 的真实几何
→ 使用 urban_rail_stations 作为站点候选并核验顺序
→ 匹配或验收失败
→ 回退原有官方接口/OSM 真实数据流程
```

PMTiles 的线路要素可能按上下行、平行轨道、重复瓦片或不同关系拆分，也可能缺少网络字段。因此正式写入前必须去重、确认拓扑连续性、确认站点端点和方向；不能把一次属性匹配结果直接视为完整线路。

### 3.1 站点数据

官方索引命中对应国家/地区包的线路，优先从 `urban_rail_stations` 获取站点候选，再使用 `MT.queryLine(city, lineNo, opts)`、官方地铁专题数据或存档已有站点进行核对。索引未收录或包不可用的线路，才使用官方地铁专题数据或其他可追溯站点数据。

站点数据必须确认：

- 站点官方名称和顺序；
- 站点经纬度；
- 线路颜色、车型等基本属性；
- 可用时返回的节点或线路附加信息。

PMTiles 站点图层未必提供可靠的线路顺序、换乘关系或运营状态，因此不能仅凭图层中的站点集合生成正式线路。站点数量、首末站、分叉站和环线闭合关系必须在生成前锁定。

`MT` 是页面注入的 `window.__metroToolkit`，不是独立的公开地图服务。

### 3.2 真实线路几何

官方索引命中对应国家/地区包的线路，优先从 PMTiles 的 `urban_rail_lines` 图层提取并拼接目标线路的真实几何；索引未收录、包不可用或 PMTiles 匹配失败时，使用 `OD.queryLinePaths(city, line, lineNo)` 获取 `SUBWAY path`，或按相邻站点调用 `MT.queryTransferStops` / `transferSearch` 获取每一段 path。

PMTiles 路径提取必须记录：

- 包文件和元数据版本；
- 匹配使用的城市/网络、线路名称、`ref`、`lineKey` 和制式；
- 匹配到的要素数量、way/relation 或要素 ID；
- 拼接方向、去重规则和未覆盖区段；
- 是否存在上下行或平行轨道，以及最终采用哪一条几何。

`OD` 是页面注入的 `window.__officialDraw`。它负责把路线查询结果整理成线路折线，但底层仍依赖游戏内地图查询能力。它不是保证永远成功的官方完整线路数据库。

返回的有效 path 应满足：

```js
[
  [lng, lat],
  [lng, lat],
  [lng, lat]
]
```

至少要有两个有效坐标点，并且起点、终点和目标站点足够接近。

### 3.3 非地铁制式线路（APM、轻轨、有轨电车）

APM 等线路可能在数据源中标记为 `light_rail`，不能因为目标游戏模式是“地铁”就套用普通地铁线路的查询假设。处理顺序为：

1. 官方索引命中包的线路先检查 PMTiles 的 `mode`、`network`、`name`、`ref` 和 `lineKey`，确认 `light_rail`、`tram` 或 `monorail` 要素确实对应目标线路；
2. PMTiles 未命中或不完整时，使用官方地铁/轨道接口返回的线路几何；
3. 官方接口没有可用 path 时，可使用可追溯的 OSM 线路 relation/way 作为备用真实几何，但必须确认 `name`、`ref`、`route` 或 `railway` 标签确实对应目标线路；
4. PMTiles 和 OSM 的 WGS-84 坐标转换为存档使用的 GCJ-02 后，再做站点吸附、路径切分和端点对齐；
5. 双线轨道、上下行或平行 way 必须通过近站候选、拓扑连通性和 `routeRatio` 检查，不能把无关轨道片段拼接起来；
6. 报告记录 path 来源、PMTiles 要素或 relation/way ID、坐标转换、way 数量和每段拟合指标。

APM 数据中的 `c`、`p`、`rs` 等像素/示意图字段仍然不能直接当作经纬度。只有站点坐标而没有真实 path 时，正式模式必须停止；直线插值只能输出明确标记为 `preview-only` 的预览。

### 3.4 不可混用的数据

- 高德地铁专题中的 `c` 字段是示意图布局坐标，不能直接当作经纬度；
- OSM 道路几何不能无条件替代地铁线路几何；只有确认是地铁 relation/path 并完成坐标转换时才可使用；
- 站点坐标可以确定车站位置，但不能推导出站间真实弯曲走向。
- OSM 的 `light_rail`、`subway` 或 `rail` 标签本身不是充分证据，必须结合线路名称、关系方向、站点端点和路径连续性验证。

## 4. 标准文件层面流程

### 第 0 步：保护输入

1. 读取输入存档，不原地覆盖。
2. 记录输入文件大小、线路数量、坐标系和目标线路是否已存在。
3. 输出到新文件；线路重建失败时保留原始存档和中间诊断结果。

### 第 1 步：检查存档结构

确认以下字段和关系：

- `data.lines` 是线路数组；
- 线路含 `stations`、`segmentAnchors` 等字段；
- `segmentAnchors.length` 与普通线路的 `stations.length - 1` 对应；
- 支线的段数、`branchRootId` 和主线引用符合现有存档模式；
- 换乘站通过 `transferGroupId` 或现有换乘字段关联，而不是简单复制同一个站点对象；
- 新 ID 不与存档现有 ID 冲突；
- 经纬度顺序和坐标系统与输入存档一致。

同时执行第 3.0 节的本地轨道包检查，并记录数据源选择结果：`pmtiles`、`official-api`、`osm` 或 `fallback`。

### 第 2 步：获取并核对站点

1. 官方索引命中包的线路先从 PMTiles 站点图层取得候选站点，再用官方线路资料、存档已有站点或其他可追溯数据确认站名和顺序；索引未收录线路按原有官方流程查询。
2. 对每个站点确认名称、经纬度和城市范围。
3. 对主线、支线分别查询，不把支线站点拼进普通主线。
4. 对换乘站保留各条线路自己的站点坐标；换乘关系单独建立。
5. 站点数量、首末站和支线分叉站必须在生成前锁定。

### 第 3 步：获取真实 path

先读取官方索引并判断是否有目标国家/地区包；索引命中时先尝试 PMTiles，未命中时进入原有官方/OSM 流程。无论使用哪一种来源，都不能假定一次提取一定覆盖完整线路：

1. PMTiles 模式：匹配 `urban_rail_lines`，去重并拼接目标线路几何。
2. 非 PMTiles 模式：先调用 `OD.queryLinePaths`。
3. 检查 path 数量、点数、线路类型、拓扑连续性和站点覆盖范围。
4. 对未覆盖或异常的相邻站点区段，PMTiles 模式回退到已确认的 OSM/官方几何；非 PMTiles 模式逐段调用 `transferSearch`，只接受目标线路的 `SUBWAY` 段。
5. 标准化线路名称，兼容“2号线”“广州地铁2号线”等表示。
6. 对长线、主支线和环线记录每个区段的来源、方向和查询结果。环线必须额外确认首尾区段是否闭合，不能把环线当成普通首末站线路截断。
7. 对接口失败进行有限重试、退避和缓存，但不能无限等待。

区段级结果建议记录为：

```js
{
  from: "站点A",
  to: "站点B",
  source: "AMap SUBWAY",
  path: [[lng, lat], ...],
  status: "fitted"
}
```

### 第 4 步：坐标转换

1. 读取存档的坐标系定义。
2. 确认数据源坐标系；PMTiles 和 OSM 通常为 WGS-84，高德数据通常为 GCJ-02，不能直接混写。
3. 仅在源坐标系与存档不一致时转换。
4. 转换后用已知站点做距离检查，避免整条线路出现系统性偏移。

广州 1 号线的历史脚本使用了 OSM path，并进行了 WGS-84 到 GCJ-02 的转换；这一步是它能够正常使用真实线路几何的必要条件之一。

### 第 5 步：按站点切分 path

对每一条连续 path：

1. 将每个站点投影到线路 path；
2. 获得站点在 path 上的有序索引；
3. 截取相邻站点之间的 path 区间；
4. 去除站台避让范围内的点，但保留足够的区段形状；
5. 检查投影顺序不能倒退或跨越其他区段。

不能直接把整条 path 均匀切成固定数量的节点，也不能按站点直线替换真实区段。

### 第 6 步：生成中间节点

标准密度的生成顺序：

```text
真实区段 path
→ fitSegmentNodes
→ curvatureThin
→ 弯道保留更多点、直线抽稀
→ 控制最小间距和最大间距
→ 写入 segmentAnchors
```

节点密度档位应有可解释的参数：

- `sparse`：抽稀最强，适合长距离线路；
- `standard`：默认标准密度；
- `dense`：弯道保留更多节点；
- `line_curve`：直线段少点，弯道按曲率保留。

每个普通线路段最终至少应有可渲染的节点结构。节点数量不是质量证明，必须同时检查节点是否偏离真实 path。

### 第 7 步：写入线路

写入时遵循输入存档已有字段和对象形状：

- 复制并递增线路 ID；
- 写入线路中文名、英文名、颜色和车型；
- 写入官方顺序的站点对象；
- 写入与站点段数匹配的 `segmentAnchors`；
- 支线写入主线引用和分叉信息；
- 换乘站创建或复用正确的换乘组，但不强行共享不同线路的坐标对象；
- 不让自动命名覆盖已经确认的官方站名。

### 第 8 步：离线验证

写出新文件前必须通过以下检查：

#### 结构检查

- 线路数量符合预期；
- 每条线路站点数符合预期；
- 站点名称无自动命名残留、重复或顺序错位；
- `segmentAnchors` 段数正确；
- 所有节点坐标有效；
- 主线、支线字段关系有效。

#### 几何检查

- 首末站和中间站坐标在合理误差内；
- 节点顺序沿线路前进；
- 节点不发生明显折返；
- 节点最大间距和最小间距在配置范围内；
- 节点到真实 path 的最大偏差在阈值内；
- 弯曲区段存在非零横向偏移，不能全部落在站点连线上。

#### 数据来源检查

每个区段必须标记为：

- `fitted`：来自真实 path，允许正式交付；
- `interpolated`：站点直线插值，只允许预览；
- `missing`：没有可用几何，必须阻止正式写入。

报告还必须记录：

- PMTiles 是否存在、是否通过完整性校验；
- PMTiles 文件 SHA-256、生成时间和数据源版本；
- 目标线路是否由 PMTiles 命中；
- PMTiles 要素数量、站点候选数量和未匹配要素；
- 是否发生了官方接口、OSM 或其他备用数据源回退。

## 5. 失败处理和硬门禁

获取 path 失败的常见原因：

- PMTiles 文件缺失、损坏或元数据不一致；
- PMTiles 没有目标城市/线路，或线路属性无法唯一匹配；
- PMTiles 要素重复、上下行分离或拓扑不连续；
- 地图 SDK 或页面工具尚未加载；
- 查询超时、网络失败或触发限流；
- 首末站路线规划没有返回完整地铁段；
- 线路名称过滤不匹配；
- 长线、支线或环线只返回部分 path；
- 返回公交、步行或其他地铁线路路径；
- 源数据和存档坐标系不一致。

失败时必须按以下顺序处理：

```text
检查本地 PMTiles 和元数据
→ 目标包存在时尝试 PMTiles 匹配和拓扑拼接
→ 校验目标线路和站点端点
→ PMTiles 未命中或不完整时使用官方接口/OSM 备用真实 path
→ 官方索引不可用或无目标包时检查页面和 SDK 状态
→ 有限重试并等待退避
→ 整线查询
→ 未覆盖段逐段查询
→ 仍失败则中止正式写入
```

正式模式禁止以下行为：

```text
真实 path 获取失败
→ 默认用站点坐标线性插值
→ 仍报告“线路复刻完成”
```

如果允许生成预览，输出必须明确标记：

```text
pathSource: station-interpolation
status: preview-only
interpolated: [区段列表]
```

## 6. 本次广州线路复刻的经验

### 一号线为什么正常

历史脚本 [build-guangzhou-line1.mjs](../scripts/build-guangzhou-line1.mjs) 使用了 OSM 真实线路 path，完成坐标转换、站点投影和区段切分，因此中间节点具有实际线路曲率。

### 二、三号线为什么不正常

历史脚本：

- [build-guangzhou-line2-on-line1.mjs](../scripts/build-guangzhou-line2-on-line1.mjs)
- [build-guangzhou-line3-on-line1-line2.mjs](../scripts/build-guangzhou-line3-on-line1-line2.mjs)

使用了相邻站点坐标线性插值。两个脚本都明确记录了：

```text
AMap station coordinates + 500m station-to-station interpolation
```

因此二号线、三号线的节点全部位于站点集合连线上。问题不在 `segmentAnchors` 字段格式，而在数据源退化后没有阻止交付。

### 这次问题必须转化为 skill 规则

1. 不把“节点数量大于零”当作路径质量证明。
2. 不把站点坐标当作线路几何。
3. 不把高德示意图坐标 `c` 当作经纬度。
4. 不允许无提示地从真实 path 降级为直线插值。
5. 报告必须列出 `fitted`、`interpolated`、`missing` 区段。
6. 正式任务只允许 `missing.length === 0 && interpolated.length === 0` 通过。

### 本次二、三号线修正记录

本次使用 OSM `railway=subway` 几何作为真实线路曲率来源。OSM 与高德底图存在整体偏移是可以接受的，但不能因此修改存档中的站点坐标。最终采用以下规则：

```text
存档 station.lat/lng（GCJ-02）作为唯一站点坐标
→ OSM WGS-84 几何转换为 GCJ-02
→ OSM 路径起点、终点按累计路径比例对齐到相邻高德站点
→ 保留中间路径的弯曲形状
→ 抽稀并写入 segmentAnchors
```

修正过程中发现，单纯把每个站点附近的全部 OSM 节点交给多源图搜索，会把不同的断开轨道片段错误拼接起来。典型表现是：站点本身距离轨道只有几米，但搜索选出的路径起点落在下一站附近，导致绕行比异常升高。改进为：

- 每个站点优先使用距离最近的少量候选轨道点（当前为前 4 个）；
- 保留 way 端点的拓扑拼接，但不让远处候选点主导路径；
- 用 `routeRatio = routeLength / stationStraightDistance` 检查错误绕行；
- 站点吸附距离作为告警指标，不再误判为站点坐标错误；
- 无连续路径、路径过度绕行或路径点不足时，仍然阻止正式写入。

本次修正结果：

| 线路 | 车站 | 区段 | 中间节点 | 插值区段 | 最大路径比 | 最大吸附距离 |
|---|---:|---:|---:|---:|---:|---:|
| 广州地铁 2 号线 | 24 | 23 | 173 | 0 | 1.110 | 174.2 m |
| 广州地铁 3 号线主线 | 20 | 19 | 241 | 0 | 1.309 | 107.8 m |
| 广州地铁 3 号线支线 | 15 | 14 | 206 | 0 | 1.138 | 173.5 m |

验证还确认：三条线路的站名、站点坐标、换乘组和支线关系均保持不变；一号线几何未被意外修改。对应实现脚本为 [fix-guangzhou-line23-realpath.mjs](../scripts/fix-guangzhou-line23-realpath.mjs)，输出为 [guangzhou-line1-line2-line3-realpath-fixed.json](../saves/guangzhou-line1-line2-line3-realpath-fixed.json)，报告为 [guangzhou-line23-realpath-report.json](../reports/guangzhou-line23-realpath-report.json)。

这次经验对应的硬门禁是：

1. 站点坐标验证和 OSM 几何吸附验证必须分开；OSM 偏移不能反向修改站点坐标。
2. 真实 path 的端点必须对齐到存档站点；不能直接把未对齐的 OSM 点写入线路。
3. 图搜索必须限制近站候选点，并检查路径起终点是否真的位于对应站点附近。
4. `maxRouteRatio`、`maxStationSnapM` 和节点到站点弦线的最大偏差必须写入报告。
5. `stationCoordinatesFinite === true`、所有区段 `fitted`、`interpolated === 0` 才能标记为正式通过。

### 本次 APM 线路纠偏记录

本次任务暴露出一个流程错误：用户要求“依据本文、基于最新存档”时，浏览器已打开被误解为需要立即使用游戏内官方逐站 UI。正确做法应是先完成文件层面复刻，再把浏览器作为可选验证面。APM 最终采用 OSM 真实轻轨几何，未使用高德示意图 `c` 字段，也未用站点直线插值冒充正式 path。

本次 APM 的实际流程为：

```text
最新 1/2/3/18 号线存档
→ AMap APM 站点顺序和 GCJ-02 坐标
→ OSM APM light_rail ways
→ WGS-84 转 GCJ-02
→ 近站候选 + 拓扑图搜索
→ 端点对齐、按 8 个站间区段切分
→ 曲率抽稀生成 segmentAnchors
→ 建立广州塔/林和西的独立换乘组
→ 输出新存档和报告
```

结果为：9 个站、8 个区段、16 个中间节点，8/8 区段 `fitted`，插值区段为 0；最大路径比 `1.085`，最大站点吸附距离 `119.6m`，最大节点到站间弦线偏移 `19.2m`。对应材料：

- 数据：[osm-apm-relation.json](../data/osm-apm-relation.json)
- 脚本：[build-guangzhou-apm-realpath.mjs](../scripts/build-guangzhou-apm-realpath.mjs)
- 存档：[guangzhou-line1-line2-line3-line18-apm-realpath.json](../saves/guangzhou-line1-line2-line3-line18-apm-realpath.json)
- 报告：[guangzhou-apm-realpath-report.json](../reports/guangzhou-apm-realpath-report.json)

由此新增硬门禁：

1. “浏览器已打开”不等于“采用游戏内 UI 绘制”。
2. “基于最新存档”必须先完成输入存档识别和哈希记录。
3. APM/轻轨等非地铁制式必须按真实轨道几何处理，并记录 `railway`、relation/way ID 和来源。
4. 文件输出通过后，未经用户明确要求，不在浏览器中创建临时线路或保存 UI 状态。
5. 文件层面验证和浏览器显示验证必须分开汇报，不能用一类结果替代另一类结果。

## 7. 后续 skill 的最小验收标准

一个可交付的线路复刻工具或脚本至少应能：

1. 从存档读取坐标系和现有线路结构；
2. 检查本地 PMTiles，缺失时按官方索引下载并校验；
3. 按官方索引选择对应国家/地区 PMTiles，未收录时使用原有数据源；
4. 获取并核对官方站点顺序；
5. 获取真实线路 path，并按区段确认覆盖；
6. 对真实 path 做站点投影、切分、拟合和抽稀；
7. 正确处理普通线、支线、环线和换乘站；
8. 文件写入前执行结构和几何验证；
9. path 缺失时停止正式输出，而不是静默插值；
10. 输出新存档、数据来源、检查结果和未完成区段；
11. 对文件层面结果和游戏内显示结果分别验证；
12. 保留输入文件，不原地破坏用户存档。

## 8. 建议的实现状态机

```text
INIT
  → SAVE_INSPECTED
  → STATIONS_VALIDATED
  → PATH_REQUESTED
  → PATH_VALIDATED
  → SEGMENTS_FITTED
  → GEOMETRY_VALIDATED
  → SAVE_WRITTEN
  → OUTPUT_VERIFIED

任何阶段失败
  → DIAGNOSTIC_FAILED
  → 不写入正式存档
```

状态必须可追踪，尤其要区分：

- 查询失败；
- 查询成功但 path 不完整；
- path 完整但投影失败；
- 几何生成成功但存档结构验证失败。

## 9. 相关现有材料

- [中国轨道 PMTiles](../data/citydesigner-china-urban-rail.pmtiles)
- [中国轨道 PMTiles 元数据](../data/citydesigner-china-urban-rail.json)
- [城市设计师官方轨道包索引](https://www.citiesdesigners.com/lib/osm_transit_pack_index.js)
- [PMTiles 城市/线路扫描脚本](../scripts/list-citydesigner-urban-rail-cities.mjs)

- [广州一号线真实 path](../data/osm-line1.json)
- [广州二号线真实 path](../data/osm-line2-ways.json)
- [广州三号线支线真实 path](../data/osm-line3-branch-ways.json)
- [广州十八号线真实 path](../data/osm-line18-relation.json)
- [广州 APM 真实 path](../data/osm-apm-relation.json)
- [广州站点数据](../data/amap-guangzhou.json)
- [广州一号线输出](../saves/guangzhou-line1-file-test.json)
- [广州一、二号线输出](../saves/guangzhou-line1-line2-file-test.json)
- [广州一、二、三号线输出](../saves/guangzhou-line1-line2-line3-file-test.json)
- [广州一、二、三、十八号线真实 path 输出](../saves/guangzhou-line1-line2-line3-line18-realpath-test.json)
- [广州 APM 真实 path 输出](../saves/guangzhou-line1-line2-line3-line18-apm-realpath.json)
- [广州 APM 验证报告](../reports/guangzhou-apm-realpath-report.json)
- [APM 复刻脚本](../scripts/build-guangzhou-apm-realpath.mjs)

