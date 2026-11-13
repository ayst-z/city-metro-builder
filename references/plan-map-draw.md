# 规划图绘制：PlanMap 1.0.0 操作规程

## 1. 真值、范围与入口
- 用户明确要求按指定规划图复刻时，以该图的站名、站数、站序、颜色及用户指定参数为真值；现状高德数据不得覆盖规划意图。仍查询高德作锚点、独立检查和差异说明。
- **图纸只是大致参考，默认自主设计（用户 2026-11-12）**：结合真实地理（道路走廊、既有网、站位、曲率规范）自己设计走向与控制点，不做简单像素拟合。像素拟合管线保留为能力较弱小模型的备选，仅显式选择时启用。
- 只读取用户指定图片；已有路径不重复询问。先人工核对全图图例、目标范围、普通线/支线/环线、换乘及未辨认文字；不猜站名或车型。
- 唯一实现：`scripts/plan-map.py`（离线配准/追线）与 `scripts/funcs/draw/plan-map.js`（页面 `window.PlanMap`）。不保留第二套拟合、插值或绘线配方；城市图片、站表、锚点和任务进度放任务目录，不内置技能。
- 当前 PlanMap 只用于**已授权、隔离创意环境中的普通独立线路**。支线/环线另走官方 `startBranchLine` / `completeRingLine` 及各自测试，不拆成普通独立线冒充支持。

## 1b. 自主设计模式（默认）
- 从图纸读大致走廊与站序；车站坐标用真实数据（`resolveCoordTwice`/`queryLine`），有真实 SUBWAY path 的区段直接用真实节点。
- 无真实 path 的区段：agent 设控制点——对图纸走廊做 DP 抽稀（约 25m）**保留转弯控制点**，再结合底图道路/网形微调；经 `PlanMap.prepare(compiled,i,{stations,paths:[控制点]})` 走 `fitSegmentNodes`+`curvatureThin` 平滑。
- 控制点过疏会切弯（实测 4 点切 113m 被拒；7 点偏差 22.9m 通过）；设计线到图纸走廊偏差 ≤40m 并汇报，不要求像素级贴合。
- 道路走廊综合校验：Walking/Driving 与走廊比对，中位 ≤40m 且 ≥70% 点 ≤40m 才吸附道路，否则保留设计并汇报偏差（实测南京 2·9 步行 109.6m/驾车 239.3m 均不沿规划走廊 → 不吸附）。导航路径不得单独作为线路位置来源。

## 2. 图片与人工标注
- **没有 OCR，也不自动提取车站**。人工标注每站圆点/站台符号的像素中心、准确名称及沿线顺序；`stations` 数组顺序就是站序，不按经纬度或标签文字位置排序。
- 先 `prepare` 缩图，再在实际工作图上标注；所有站点、锚点、检查点和 `via` 均用工作图像素 `[x,y]`（左上原点，x 向右、y 向下）。保存原图以核验细节。
- `source.workSize=[width,height]` 必须与编译图片完全一致；记录 `originalSize` 和 `pixelToOriginal:{offset:[ox,oy],scale:[sx,sy]}`，映射为 `originalPixel=offset+workPixel*scale`。
- `prepare` 返回上述尺寸/映射元数据，不自动生成 manifest，也不裁剪。外部裁剪须记录原图裁框 `[x,y,width,height]`，据裁框与缩放更新 offset/scale，并把全部标注换到该裁图坐标；编译器只校验 workSize，不替你应用裁剪变换。
- 不删/并近距离车站，不以经度/纬度单调或小站距否定规划站序；色带或放置限制不能用虚构中间站绕过。

## 3. 锚点与配准硬门禁
- 至少 **3 个不共线拟合锚点 + 2 个独立检查点**；名称不得重复，检查点不参与拟合。锚点应包围目标线路，覆盖首/中/尾；可用图中可靠换乘站或已核验参考站。
- 多关键词查询高德并核对城市、站名、类别和位置；关键词命中/多次返回相同结果不等于属于目标线。排除出入口、公交/铁路站及错线 POI；组合线号不能拆成数字子串匹配。已有游戏站也须核对其坐标来源。
- manifest 明确 `crs:'gcj02'|'wgs84'`，所有 coord 按 `[lng,lat]` 且同一 CRS；高德一般为 GCJ-02，不能与 WGS-84 混拟合。
- 实现将经纬度转局部米坐标，像素去中心/按标准差归一化，再以 `numpy.linalg.lstsq`（SVD）解仿射；秩不足或条件数 >1000 拒绝。不降级两点相似变换、线性插值或估算外推。
- 默认 `toleranceM=250`：拟合点与独立检查点的最大误差均不得超限；拟合误差为零不证明配准正确。超限回查标注/同名站/CRS，不能靠放宽阈值掩盖错误。
- 所有车站和追踪路径必须在拟合锚点凸包内（边界可用），**禁止凸包外推**；补充可靠锚点或将该线标记 blocked。

## 4. 拟合备选模式：沿色带追踪与节点（仅显式选择时启用）
- **图纸定意图，现实定几何**：站名/站序/线路存在性/颜色以图纸为准，但坐标与走向必须结合实际——已开通或在建且高德有数据的车站用真实坐标（`resolveCoordTwice`/`queryLine` 交叉校验），有真实 SUBWAY path 的区段用真实节点/走向；仅高德确无数据的规划段才用图纸追踪结果。站名以真实数据校正图纸误读（实测：图注"螺蛳路"实为"螺塘路"）。
- `PlanMap.prepare(compiled,index,real)` 的 `real={stations:{name:[lng,lat]},nodes:[seg|null],paths:[seg|null]}`（与 compiled 同 CRS）：真实节点 > 真实 path > 图纸角点。真实短段允许过滤后无节点（直线直连）。
- 每对相邻车站单独建立 ROI；经过人工观察的 `via` 约束交叉口、同色分岔、换乘遮挡后的正确支路，不能让最短路自行决定拓扑。
- 以 OpenCV Lab 欧氏色距取掩膜，距离变换惩罚离色带距离、偏好色带中心；执行有边界的 **8 邻域 A\***，不是整图 flood fill 或站间直连。
- 默认 trace 参数：`lab_tolerance=32, bridge_px=8, margin_px=30, max_states=600000`；ROI ≤4,000,000 像素。超预算收紧 ROI/补真实 via/换工作图，不无界搜索。
- 路径颜色覆盖率必须 ≥65%，最长连续缺色间隙 ≤`2*bridge_px+3`；只桥接小符号遮挡。无色、断路、长缺口、控制点离色带过远均 blocked，**无直线兜底**。
- **栅格阶梯不得直接当节点**：compile 输出密集 `paths`/`pixelPaths`（证据）与投影后的平滑链 `cornerPaths`（Chaikin 3 迭代切角平滑，端点不动）。prepare 对平滑链/真实 path 走原有权威算法 `MT.fitSegmentNodes(stations,path,{tolerance:6,endPadM:100})` → `MT.curvatureThin(seg,{tolerance:6,minGapM:30})`，不在 PlanMap 复制密度算法。稀疏拐点直接样条会切弯超差（实测 96.8m），必须先平滑再拟合；验收节点到图源密集 path 偏差 ≤30m。
- **道路走廊综合校验（用户 2026-11-12 要求）**：对无真实地铁 path 的图源段，取 `AMap.Walking`/`AMap.Driving` 路径与图源路径逐点比对；仅当偏差中位数 ≤40m 且 ≥70% 点落在 40m 内才把节点吸附到道路走廊，否则保留图源走向并汇报偏差（实测南京 2·9：步行中位 109.6m、驾车 239.3m，均不沿规划走廊 → 不吸附）。导航路径不得单独作为线路位置来源。
- 抽稀后剔除距任一端车站 <100m 的节点；若整段无安全的图源节点，`prepare` 拒绝。**不造几何中点、不用 padSegmentNodes 的中点兜底**，不照搬公交/导航 path。
- prepare 门禁：坐标范围（|lng|≤180/|lat|≤90，防像素/经纬度混用）、段端点与站序 ≤1m、节点数 ≤ 段长/30m+8（防密度失控）。
- 逐段检查走向、弯道、交叉分流及站序；经纬度递增/递减不是顺序判据，真实回弯不能被通用绕路检查自动拉直。

## 5. Manifest 契约与命令
以下为字段形状；数组中的每项都须填真实人工核验数据，不是内置城市模板。

| 字段 | 形状 / 约束 |
|---|---|
| `source` | `{workSize:[w,h],originalSize:[w0,h0],pixelToOriginal:{offset:[ox,oy],scale:[sx,sy]}}`；另记源文件路径、裁框等溯源信息 |
| `crs`, `toleranceM` | `"gcj02"` 或 `"wgs84"`；误差上限默认 250 米 |
| `anchors`, `checks` | 数组；每项 `{name,pixel:[x,y],coord:[lng,lat]}`，分别 ≥3 / ≥2，彼此独立 |
| `trace` | 可选对象，仅支持 `lab_tolerance,bridge_px,margin_px,max_states` |
| `lines` | 线路数组，线路名称不得重复 |
| `lines[]` | `{name,color,spec,specSource,stations,segments}`；颜色 `#RRGGBB`；spec/source 在页面绘制前必填 |
| `spec`, `specSource` | `{trainType,trainCars,maxSpeedKmh}`；来源说明（用户指定/可核验资料），不得凭线号猜车型 |
| `stations[]` | `{name,pixel:[x,y]}`；完整有序站表，至少 2 站 |
| `segments[]` | 第 i 项对应站 i→i+1；数量=站数−1；每项 `{}` 或 `{via:[[x,y]],color:"#RRGGBB"}`，via 可多点，color 覆盖追踪颜色而非游戏线色 |

依赖 Python 的 `numpy`、`opencv-python`、`Pillow`；所有输出父目录须已存在。以下路径按实际技能根、任务目录和用户图片替换：
```sh
python "<skill-root>/scripts/plan-map.py" prepare "<user-image>" "<job>/work.jpg" --max-side 6000
python "<skill-root>/scripts/plan-map.py" compile "<job>/work.jpg" "<job>/manifest.json" "<job>/compiled.json"
```
- 大图先 prepare；非 JPEG 超 40,000,000 像素需外部瓦片解码/裁剪，compile 也拒绝超此上限的图。裁剪不是绕过地理覆盖门禁。
- 编译输出 `{version,ok,crs,source,fit,lines,blocked}`；每线含 `stations,paths,pixelPaths,quality,spec,specSource`。配准失败输出 `stage:'registration'`；CLI 失败退出码 2。
- `compiled.ok` 与 `fit.ok` 均须为真；一条 blocked 会使整体 ok=false。检查原因并重新编译已明确范围，禁止直接翻改 ok 或把未通过线当已完成。

## 6. 页面隔离与官方绘制
1. 先核验用户授权的测试页、创意模式 `G.economyMode==='free'`、明确 cityKey 和独立本地测试范围。**新标签页不等于独立存档槽**；未确认隔离不得画，不改旧经营页，不抢前台/激活窗口。
2. 在测试页确认 `_metroCloudAutosaveInFlight` 无在途请求后，清除 `_metroCloudAutosaveTimer` 定时器并置空，再次核验。不得强改 inFlight 为 false；存在在途保存即停止绘制，等其结束。PlanMap 只检查这些状态，不自动停止云保存。
3. 不得向旧云槽保存/覆盖；`localOnly:true` 是调用门禁而非隔离实现。默认不保存、不下载、不重载；仅另获明确授权后用本地保存/导入重载验证，始终保持云自动保存关闭。
4. 按 `mt-core → mt-node → mt-amap → od → k → plan-map` 注入；MT core/amap 6.5.3、node 6.5.4，PlanMap `version==='1.1.1'`。JSON 用 UTF-8 读入，不用 Git Bash curl 内联中文。
5. 无旧 place/add-station 编辑且无同名线时，`PlanMap.prepare(compiled,index)` 验证源数据、端点顺序（≤1m）、转换 CRS 并抽稀；引擎变化后重新 prepare。
6. `PlanMap.draw` 先 `K.snapshot`，经 `OD.createLine` 唯一识别新空线；官方编辑面板设置名称、颜色、车型、编组、限速并确认，不直接拼接游戏线路数据。
7. 首站走 `top.placeStation(id,coord,name)`；以后每段先用 `top.onMapRightclick` 逐个放 pending 节点，再 `top.executePlaceModeStationClick` 放下一站。每步核对数量及已放站前缀对象未变。
8. 每站等待 `_autoNameQueuePromise` 后经 `syncTransferGroupStationName` 命名，检查吸附偏移；至少 2 站才 `confirmCreateLine()` 完成。不能用 `confirmLine` 收尾或用 add-station 色带限制虚构站点。

将已编译 JSON 作为 `compiled` 传入测试页，并预先人工核验 `verifiedTestCityKey`：
```js
const plan = PlanMap.prepare(compiled, 0);
const result = await PlanMap.draw(plan, {cityKey: verifiedTestCityKey, localOnly: true});
```
- 返回失败或抛错都立即检查新线 ID、站表前缀、`pendingAnchors`、编辑模式和队列；部分错误发生在返回 partial 结构之前。记录已落地站/节点及失败位置，**不自动删线重试、不盲目续画**；先查官方状态再制定恢复步骤。

## 7. 验收、整图覆盖与证据边界
- `PlanMap.check(lineId,plan)` 检查准确站数/站名顺序、分段及节点数/顺序、颜色、三项 spec、非支线非环线、100m 站台避让及 pending 清空；另外人工回读线路名和编辑已结束。
- 站/节点写回偏差各 ≤2m 是**游戏相对 plan** 的一致性，不是地理准确度；独立配准门槛默认 250m 是**图相对已核验地理检查点** 的误差，两者必须分开报告。
- 必须保留两类截图：①输入图叠加人工站序、锚点/检查点、pixelPaths；②真实游戏线路（全线及关键弯道/交叉细节）。输入 overlay 需另行制作，脚本不会自动截图；不以 mock/只看数组冒充游戏验收。
- 按完整图例建立外部任务队列：`unread → identified → registered → traced → prepared → drawn → verified`；失败标 `blocked`，部分写入标 `partial`，均附原因、剩余站段与证据。这是人工任务状态，不是脚本自动维护。
- 每个目标图例项均须有对应线路、站表、追踪结果和验收证据；明确列出未读/未画/阻塞/范围外项目。**普通短线成功不代表整张规划图完成**，所有目标项 verified 才可声称整图完成。
- 现有离线回归入口：`_dev/test-plan-map.py`（10 项）、`_dev/test-plan-poi.js`（17 项）、`_dev/test-plan-draw.js`（45 项）；测试数量不代表本轮已运行，也不替代浏览器官方流程、支线/环线或存档重载验证。
- 每轮验收状态留在任务记录，不把过期的站数或 pending 数当作当前现场。未完成实际导出/重载前，不声称存档往返验证通过。
- 节点加密按每条边合并两端弯道候选点并沿边排序，禁止逐弯道重复拼接重叠区；最终平滑插点须距段终点至少 minGapM，回归同时检查最小间距和沿原始路径的顺序。
