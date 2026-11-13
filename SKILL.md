---
name: city-metro-builder
description: '在 Cities Designers（citiesdesigners.com 城市设计师·地铁模拟）用官方逻辑绘制地铁线路。架构：0 最高全局要求（凌驾一切）→ 1-8 功能板块（每个板块含 调用逻辑/使用规则/注意事项）→ 9 不便分类的条件特例。板块：数据源查询、节点拟合、官方绘制、批量管理、检查与校验、特殊场景（未开通/有轨电车/未知线路/规划图/文件复刻/OSM）。支持普通线/支线/环线；枚举未绘制、命名规则、分类筛选、地区识别、修复/校准、高风险拦截+快照回滚、高效模式（无数据库·实时查询·省 token）。Use when: 用户提到 绘制线路、重绘线路、铺设地铁、画线路、metro、地铁线路、官方绘制、逐站绘制、支线、环线、放车站、放节点、线路命名、命名规则、分类、在建、已建成、规划、地区、区域、城市线路、状态报告、官方配色、走向节点、站名、修复线路、修复换乘、线网示意图、线路图、规划图、图片转换、按图绘制、相对位置估算、多次比对、未绘制、还没画、枚举、脚本、一键、官方接口、批量绘制、逐条绘制、建设中、规划中、必检、重新调整、调整、高效、快速、省token、实时查询。'
---

# City Metro Builder v4 — 官方绘制地铁线路（完整版 + 高效模式）

> ⚡ **答复最高准则（2026-09-06，凌驾其它一切约定）**：**不要输出任何礼貌性用语**——不寒暄/不道歉/不写"好的·收到·没问题·请问·请·辛苦·祝·期待"等客套；**直接给出最有用的信息**：先结论（结果/判定/差异/数据）→ 最小必要解释 → 下一步动作。能用要点/表格一句话说完，不写三句。

> **版本（2026-11-12 v4.3 / 开源 beta1.0）**：MT **6.5.3/6.5.4/6.5.3**（core/node/amap）· OD **2.60.3** · K **2.9** · Ops **1.3.5** · OE **1.1.8** · FareLab **1.0.1** · Modes **0.1.0** · PlanMap **1.1.1**（可选）· MetroAutopilot **0.3.0**（可选，全自动经营托管）。代码基线 = `scripts/funcs/`；函数表按源码实际导出键校准（MT 84 / OD 38 / K 62，见 §10）。v3 高效版已并入本技能（`references/efficient-mode.md`）；**默认高德 + AMap/OSM 双引擎特调**（`references/map-engines.md`）；全游戏功能矩阵见 `references/game-features.md`；多模式预留见 `scripts/funcs/modes/README.md`；浏览器扩展为废案，不再维护或注入。
> **2026-09-27 更新适配**：9-24/9-27 新增经营模式/高铁/航空/Voyager，指引与经济全局 API 速查见 `references/update-2026-09-27.md`（不影响 §1-§8 绘线主流程）。
> **本版架构**：`§0 最高全局要求（先读）` → `§1-§8 功能板块`（每板块=功能定位/调用逻辑/使用规则/注意事项）→ `§9 不便分类的条件特例` → `§10 函数速查表`。
> **旧文档备份**：`SKILL.pre_rearch.md` / `SKILL.bak_*.md`（历史实测细节全文保留，供回溯）。

---

## §0 最高全局要求（凌驾所有板块，先读本节）

> 以下为**用户定义、每次操作必守**的顶层规则。任何板块若与本节冲突，以本节为准。

### 0.1 数据与坐标（硬规则）
- **指定规划图优先（强制）**：用户明确按指定图复刻时，图中站名/站数/站序/颜色及用户参数是最高真值，现状高德不得覆盖；仍查询高德作锚点、独立检查和差异说明。**图纸只是大致参考，默认自主设计（用户 2026-11-12）**：结合真实地理（道路走廊、既有网、站位、曲率规范）自己设计走向与控制点，不做简单像素拟合；像素拟合管线（trace/cornerPaths）保留为能力较弱小模型的备选，仅显式选择时启用。**客观第一（用户 2026-11-12）**：线位/站位/走向/换乘一律以可验证客观证据为依据（真实坐标/真实 path/道路中心线/图纸实测/工程规范），按 `references/metro-planning-principles.md` 的优先级裁决与数值门禁验收（站落路口/真实站台、线位贴道路中心线中位≤30m、到图纸走廊≤40m 且弯点拓扑同构、最小曲线半径≥车型困难值、站距/避让/顺序/换乘方向配对），无证据不决策、不达标不交付。**几何现实优先**：高德有数据的车站用真实坐标、有真实 SUBWAY path 的区段用真实节点/走向（`PlanMap.prepare(compiled,i,real)`，`real.paths` 传设计控制点）；设计线经 `fitSegmentNodes`+`curvatureThin` 平滑，控制点须保留转弯（过疏会切弯，实测 4 点切 113m、7 点偏差 22.9m）；栅格阶梯不得直接当节点，站名以真实数据校正图纸误读。**规划原理约束**：站距/曲线/速度/换乘按 `references/metro-planning-principles.md`；**同台换乘必须考虑站台方向**（平行同向=同向同台、平行反向=反向同台、交叉=节点/通道，方向不匹配不设同台）。该任务以 §8.3 与 `references/plan-map-draw.md` 为准，覆盖下文现状高德校准、中点/直线兜底、自动删线重绘及通用顺序修复规则；不得借按图修改未授权旧线。
- **现状线路默认高德（强制）**：未指定按图真值时，数据优先级「高德地铁专题 srhdata / 高德 API（地铁 POI·SUBWAY path）> 图片 > 估算」；有高德段必须用真实数据（站点 POI、节点 SUBWAY path 经 `fitSegmentNodes`+`curvatureThin`），不得用手动坐标/直线替代。仅确实无数据才询问降级 OSM/图片/估算。OSM 引擎也先取高德，再以 `MT.toGameCoords(stations,nodes)` 将 GCJ-02 转游戏 WGS-84；引擎判定 `MT.engineProfile()`，特调见 `references/map-engines.md`。
- **所有线路必须查询高德（强制）**：绘制/重绘先查 srhdata/`queryLine`/SUBWAY path；未开通查地铁 POI `queryLineStopsByPOI`，不跳过查询直接估算。按图任务不以高德“查不到”为准入条件；只用核验过的匹配作锚点/检查，不把关键词命中当归属证明。非按图任务查询失败才降级（规划图→网络+地图校验→直线估算，须询问）。汇报注明数据源及冲突。
- **现状坐标基准 = 该线 SUBWAY path 投影（强制）**：校准/调整站坐标以**该线自己几何**为基准——`OD.queryLinePaths(city,line,no)` 取该线 SUBWAY path 合并 → 每站 `projIdx` 投影到该线 path 最近点（`K.resolveLineCoord`，dev≈0）：站骑本线、与节点同源一致，防站-节点错位、防多线共用代表点互相污染。⚠️ 高德同线路多 plan 有几十~数百米漂移（南京站三源互差 40-290m）——**勿用 srhdata 静态坐标或通用 POI 当最终基准/refCoords**；坐标校验用 **devToLine（站到本线 path）≈0**。换乘站各线**各自** path 投影、独立对象；按图站点/路径则同源于通过独立检查的图像配准，不投到现状线。
- **现状节点/走向优先级（强制）**：①高德地铁数据（SUBWAY path / 地铁 POI）→ ②规划图走向 → ③线路连续（小曲率·样条平滑）→ ④贴道路（最低，仅前三者均无时参考）；按指定图则取图源走向。**禁止用导航数据（Driving/Walking/transferSearch 道路 path）确定线路位置**（绕行非地铁走向）。按图无地铁数据段须做道路走廊综合校验（用户 2026-11-12）：Walking/Driving 与图源逐点比对，中位≤40m 且≥70% 点≤40m 才吸附道路走廊，否则保留图源并汇报偏差。
- **多次搜索高德确认后再绘制（强制）**：绘制/重绘前多次搜索高德（srhdata+`queryLine` 多关键词 / POI 多关键词+`resolveCoordTwice` 交叉）；现状线路用 `checkLine3x` 检查4 逐段核对绕路（折线/直线>2.2）、大折线及混入数据，覆盖段节点不贴合立即重查修正至 pass。按图线路核验锚点/独立检查与图源路径，不因与现状冲突自动改图。

### 0.2 修复边界与防误删（强制）
- **修复边界规则（强制）**：修复=只把「按官方位置修建的部分」修复为官方；凡与官方**大差异**（延伸/规划/用户改走向/拆分合并站）一律视为**用户自绘改动，不修改**。判定：小偏差（同站坐标≤150m、命名装饰如 `·合作名`）→ 归官方（改名/校准）；大差异（坐标数百米+ / 官方无此站 / 用户新增站 / 拆分多站）→ 保留。修复前用 srhdata 官方站表+坐标邻近做同站判定，只对"官方站可证同一"的项动刀。
- **未知线路全保留（强制）**：对数据源不认识的未知线路（无官方收录/无法证同目标线），其**坐标/走向/颜色/命名等一切保留不改**；仅当存在官方/可靠数据**且与用户自绘较符合**时才用官方数据校准修复。
- **防误删铁律（强制）**：①白名单：批量只动「srhdata 已开通官方主对象+官方覆盖段」；未授权/自绘/规划/支线/同名歧义跳过；匹配用 **name 全等或 extNo**，**禁止含子串正则**（`/2号线/` 误中 S2）。②宁加勿删：修复只用「投影重排/重建有序节点/补点/直线走廊替换乱序段」，**禁止置空/清空/截断/等距 trim 作为处理手段**；仅移除算法自身刚引入的错误点（折返锯齿）可视为清理，记录数量。③不冲突：用户自绘段坐标+节点**只读不写**；官方 path 与用户数据冲突 → 保留用户数据并报告。④全程 `K.snapshot`；改前记录受影响线清单。
- **修复/维护保留用户自绘内容（强制）**：对无官方/高德数据的区段（玩家自绘延伸、规划/远期延伸、有轨电车、中运量等）一律保留站/坐标/节点/走向——不覆盖、不重建、不新增插点；**空段（无节点=直线直连）视为用户有意设计保留原状**，绝不自动补节点。修复仅限确定性内容：占位符站名可读化、官方配色（有官方数据的线）、换乘建组；**空段是否补点、延伸段是否加密/重建均须用户明确指示**。

### 0.3 节点与顺序（强制）
- **节点禁入站台区（强制）**：所有节点写入 `segmentAnchors` 前必须做站台避让：距两端车站 <100m（`endPadM`）的节点剔除；剔空段取两站中点（**不得回退到站点本身**）。`MT.fitSegmentNodes` 已内置；任何直写 `q.nodes`/`drawNodes` 的自定义流程（如 `OE.redrawAsSingle`）必须先调用 `MT.padSegmentNodes(stations, nodes, {endPadM:100})`。验收：每段首/末节点到对应车站 ≥100m。
- **拟合优先于稀疏（强制）**：节点首先必须贴合真实 path（走向）；宁疏勿密是在"每节点贴 path"前提下的优化。逐段算节点到该线 path 最大偏差（maxDev），**>30m 即"不拟合段"必须重建**（该段 path 切片重采样，`curvatureThin` 用小容错 tolerance6+minGap30 保弯道点，宁密于失 fit）。
- **站点/节点顺序必检（强制）**：修复/重建后必查 ①站序（游戏 vs 官方一致，允许整线镜像反向；官方相对顺序错乱先备份换乘再按官方序重排 `OD.verifyLineOrder`/`applyLineData opts.order`）②节点顺序（每段 `OD.hasNodeOrderIssue`——折返>120°或中点偏离首尾连线>500m=乱序，用 `OD.fixNodeOrder` 修复）③节点沿行进方向单调无折返。乱序段必须修到消除才汇报。
- **乱序修复后必复查·先查后生成（强制）**：节点乱序会让后续生成算法（curvatureThin/投影重排/addNodes/densifyAnchors/rebuildNodesFromAmap）沿错序点推算错误走向。因此：**顺序检查先于一切节点生成算法**；**修复乱序（投影重排/宁空置空）后必须复扫全段至 remaining=0** 才允许补点/重建/收尾。置空段=两站直线直连安全；保留错序点=污染源（比空段危险）。⚠️ 置空≠永久删除：凡能重建的段，修复乱序后应立即补有序稀疏节点，避免长段空直线（实测：18号线曾置空成超长空段被否决 → 直线走廊补 3/5 节点恢复）。
- **游戏平滑机制（认知，节点算法依据）**：游戏用 **Catmull-Rom 样条平滑渲染**（`catmullRom`/`buildSplinePath`/`getPositionOnCurve`），`segmentAnchors` 即样条控制点——节点宁疏合理（弯道/直线间由样条自动平滑），节点算法只需保证**控制点贴真实 path（maxDev≤30m）+ 弯道处有控制点 + 直线段疏**；勿为"看着平滑"加密集点。

### 0.4 操作纪律（强制）
- **经营硬约束**：只用经营收入和官方购买接口扩张，禁止改资金/配额/客流、切创意绕过限制。默认不开性能模式；不主动存档、不下载本地存档、不发送保存快捷键（下文保存能力仅在用户另行明确授权时适用）。
- **完整性先于成功标志**：核对查询 warnings 中线路起讫点和返回站表；终点不一致须显式查询现行起讫点。17 号线默认只回 13 站，指定西岑—虹桥才得到 14 站。延长走官方 `startExtendLine`，支线走官方 `startBranchLine`，不拆成独立线路。
- **编辑后运营验收**：退出编辑后检查 `G.paused`、时钟推进、实际列车和上客量；本轮编辑造成暂停时通过官方 `togglePause()` 恢复，不直接写暂停字段、不把停钟误判成结算故障。排班已写入不等于已发车。
- **预算与样本**：购包使用官方多包报价，逐次购买前重报价格并保留日结及建设缓冲。`affordableOne` 仅表示一包，`affordable` 表示该类全部所需包；不能据此推断多类额度合计可负担。排班推荐的 `unobservedSlots` 无样本档保留当前服务，不建议新线归零停运。
- **高效执行**：预算/购包用 `OE.economyPlan({includeOperations:false})` 跳过客流全扫（未计算字段为 null）；需要调运营才运行完整分析。`OPS.audit` 每线只聚合一次；多交路 `OPS.applySchedule(line,rec,{legIndex})` 明确目标，缺索引拒绝写入。列车需求按各线编组换算车厢，不混用单位。
- **入口一致性**：项目 `skills/city-metro-builder` 是源码；更新后同步实际 Skill 返回的安装目录，不只同步另一个未被加载的副本。核对正文、组件版本及文件哈希；旧版入口不能当作当前指南。
- **授权范围**：已明确全程自主经营时不逐线重复询问；登录凭据、破坏性删除和范围不明的操作仍需用户处理或确认。
- **默认官方接口**：绘制/增删改（建线/放站/放节点/改色/命名/换乘/闭合）默认走游戏官方接口（`top.*`/官方 UI），不直接改数据。数据查询（高德坐标/走向/色/枚举）可用脚本（只读）。
- **调速只走官方函数（强制）**：`top.setSpeed(v, el)` 写入真实字段 `G.simSpeed`；`G.speed` 是过期字段，直接赋值不会生效。调速后必须核对 `G.simSpeed` 与滑块气泡（`.speed-bar`/`#speed-bubble`）。
- **后台操作不抢前台（强制）**：禁止 `Page.bringToFront`、`Target.activateTarget`、`SetForegroundWindow`、`ShowWindow(9)` 和恢复最小化窗口的看门狗。仅使用不切换窗口的后台连接/生命周期保活；以 `simMin` 实测速度，后台节流就报告实际倍率，不用抢焦点补救。必须前台或登录时先交用户处理。
- **主动运营适配（强制）**：每轮检查票价、车次、小交路区间/频次、快车停站/频次、车厢和递增包价；无用户催促也须调整并记录原因、前后客流/拥堵/净收益。拥堵集中则优先局部增援而非全线加车；低载客快车/短交路应减班或调整区间，既有多交路用官方 `applyRouteLegSlotCount` 逐交路操作，禁把同一频次套给全部交路。推荐结果只作候选，先核对实际列车与车厢约束，再在可比时段复测，不达标恢复。快车额度读 `total-used`，耗尽时先优化现有六条，不盲目新建。整数票价按对照试验调整，基线五段 1/2/3/4/5。
- **递增包价（强制）**：每次计划用 `metroPurchaseQuote(item,数量)` 的官方累计报价，每包购买前重新报价；收入不足就等待或先优化运营，不用旧报价承诺整批可买。比较新增车厢/快车/小交路的边际收益与成本，保留日结及建设缓冲，禁止为扩张耗尽运营资金。
- **分离游戏与脚本**：脚本计算阶段不触碰 UI、不触发任何 repaint/redraw（只读 `G.lines`）；全部算好后才一次性绘制+统一 repaint，绝不逐站/逐节点/逐段频繁重绘；异步查询后台完成不阻塞渲染。
- **操作分离与顺序**：①查询(只读) → ②校准坐标(只改 latlng；⚠️后必须重新生成节点) → ③生成节点(只写 segmentAnchors/pendingAnchors/几何缓存) → ④设换乘(只改 isTransfer/transferGroupId) → ⑤检查(只读)。每步独立轻量重绘（`redrawLine`+`refreshStationDots`），不做全量 repaint。
- **中文输入编码（测试/注入必守）**：Windows Git Bash 的 curl 内联中文会按 GBK 发送，页面收到乱码（线名/站名变 `����`）。传中文用 CDP `/eval {b64}`、`browser_evaluate`、Node/Playwright 直传 UTF-8，或改用英文城市键；不要用 curl 内联中文。
- **所有工具不长期活动（防卡死）+ Playwright 提速**：任何脚本操作不长时间连续运行——分批执行、每 N 步暂停、设超时上限。已内置：`setMetroPerformanceMode(true)` 禁客流重算；高德查询 withTimeout(8-10s)+缓存(5min)；批量 `K.addNodes('all',...,{batch:10,gapMs:250})`。避免页面重载/导航（刷新一律 `redrawAllMetroOverlays`，勿 `location.reload()`）。
- **调整线路位置先删全部节点再重绘**：segmentAnchors 置空+`rebuildGeometry`，不得在旧节点上叠加/部分覆盖，再整体重新生成+重绘+`checkLine3x`。
- **重绘单条线=删旧线+整条完整重绘**：先删整条旧线（`K.deleteLine`/`top.deleteLine`）再完整重绘；不得在旧线上局部改站/段/节点。**删除/重绘旧线前必须备份换乘关系**（存 `window.__lineTransferBackup`；完成后按备份逐个 `K.applyTransfer` 恢复，比对恢复数=备份数）。

### 0.5 汇报与询问（强制）
- **所有请求必汇报**：任何请求（绘制/查询/批量/枚举/规划图/修复/换乘/导入等）处理完成后必须汇报——做了什么、结果（站数/节点/颜色/检查 pass/问题）、下一步建议。
- **每次调试必做总结**：每次调试/修复操作完成后做简洁总结——目标/发现的问题(根因)/修复动作/验证结果/遗留。用清单/表格呈现。
- **自动开启询问（双时机+恰当问题）**：①启动后自动调用询问工具（Qoder `AskUserQuestion` / VS Code `vscode_askQuestions`）开首个询问；②每条线路/任务完成汇报后自动开启下一轮询问。每轮结束必须给出『恰当的问题』（上一条是否有误？/继续下一条/换城市/微调/其他/完成？），不静默、不以纯陈述收尾。仅用户说「完成/结束」才终止。
- **线路完成必询问是否正确（强制）**：每条线完成后必须问"这条线是否有误？"，确认无误才进下一条；有问题按适配修复（站名→`K.applyStationNames`；坐标→`K.calibrateCoordinates`；节点/绕路→`OD.densifyAnchors` 或直线修正；数据混入→直线/重查高德），修复后重跑 `checkLine3x` 直到 pass 且确认。
- **可分批询问**：分支/选项过多时可拆多轮询问工具，但必须保证 8 项要点最终全覆盖；密度/命名等"绘制前必问项"绝不能因分批跳过。

### 0.6 风险与回滚（强制）
- **高风险操作拦截**：可能导致存档损坏/不可逆破坏的操作必须先询问确认，未确认绝不执行（即使脚本没拦截）。风险分级 RED/YELLOW/GREEN（见 §6.3）；会话开始 `K.resetDangerous()`。
- **修改前快照/审计/回滚（K 2.9）**：任何修改线路数据的操作执行前先 `K.snapshot('标签')` 深拷贝（含站/节点/换乘/属性），改后自动入审计日志（`K.listAudit()`）；`deleteLine`/`deleteCityLine` 已内置自动快照。每次修改可 `K.rollback(索引/id)` 即时回滚（白名单拷贝兜底+空数据拒绝回滚）。会话内快照上限 40；文件级备份随时 `top.downloadLocalSave()`(=Ctrl+S)。
- **页面卡死/重载后恢复存档**：页面高负载会卡死/重载（高德瓦片 ERR_ABORTED + 全网客流重算）。存档在 IndexedDB，数据不会丢。**界面选择（模式/存档）由用户自行完成，AI 不代点**；若 `G.lines` 仍为空，清恢复守卫（`_localDraftNoFlowRestoreGuard={}` 等）后调 `tryRestoreLocalDraftNoFlowForCity('anycity-global')`（注意 `metroSafeStartSkipsLocalDraft` 是**函数**勿覆盖为布尔）。恢复成功重新注入工具箱。

---

## §1 版本与文件清单

> **代码基线（2026-11-09 v4）：`scripts/funcs/` 拆分架构为唯一权威**（旧单文件已归档，非注入基线）。**改脚本逻辑须 bump 版本号 + 更新 §2.4 注入与 `_dev/smoke.js` 期望值**（版本守卫：同版跳过注入）。

| 组件 | 注入对象 | 版本 | 文件 |
|---|---|---|---|
| 查询核心 | `window.__metroToolkit`(MT，拆分共享) | 6.5.3/6.5.4/6.5.3（core/node/amap 各自守卫） | `scripts/funcs/query/{mt-core,mt-node,mt-amap}.js` |
| 官方绘制封装 | `window.__officialDraw`(OD) | 2.60.3 | `scripts/funcs/draw/od.js` |
| 批量管理库 | `window.CityMetroKit`(K) | 2.9 | `scripts/funcs/manage/k.js` |
| 规划图普通线 | `window.PlanMap` | 1.1.1（`version`） | `scripts/funcs/draw/plan-map.js`（可选，MT/OD/K 之后；离线配套 `scripts/plan-map.py`） |
| 客流运营 | `window.MetroOps`(Ops) | 1.3.5 | `scripts/funcs/ops/ops.js`（可选，K 之后注入；含快车/小交路写入；经营模式票价默认官方五段） |
| 全自动经营托管 | `window.MetroAutopilot` | 0.3.0 | `scripts/funcs/ops/autopilot.js`（可选，Ops/OE 之后；仅 management；有界循环+回滚+日志） |
| 官方编辑（经营） | `window.OfficialEdit`(OE) | 1.1.8 | `scripts/funcs/manage/official-edit.js`（配色/编组确认、官方延长/支线、断线单线重绘、额度预算） |
| 票价实验（经营） | `window.FareLab`(FL) | 1.0.1 | `scripts/funcs/manage/fare-lab.js`（调价/记录/候选方案/对比） |
| 多模式注册表 | `window.CityTransportModes` | 0.1.0 | `scripts/funcs/modes/mode-registry.js`（metro/hsr/air 适配器契约） |
| 高铁探测（预留） | `window.HsrProbe` | 0.1.0 | `scripts/funcs/modes/hsr-probe.js`（只读状态/官方入口索引） |
| 飞机探测（预留） | `window.AirProbe` | 0.1.0 | `scripts/funcs/modes/air-probe.js`（只读状态/官方入口索引） |
| 坐标转换 | `window.__CoordTransform` | — | `scripts/coordinate-transform.js` |
| 未开通线瓦片 | `window.__metroUnopenedPaths` | — | `scripts/funcs/query/metro-unopened-paths.js`（可选注入） |
| srhdata | `window.__SUBMETRO_DATA`/`__MT_SUBMETRO_DATA` | — | 运行时抓取/注入（可选） |

**文件清单**：`SKILL.md`（主文档）· `references/{official-draw,batch-ops,metro-diagram,plan-map-draw,metro-planning-principles,metro-replication-workflow,update-2026-09-27,efficient-mode,map-engines,game-features,ui-features,operations}.md` · `scripts/funcs/{query/mt-core,query/mt-node,query/mt-amap,draw/od,draw/plan-map,manage/k,manage/official-edit,manage/fare-lab,modes/mode-registry,modes/hsr-probe,modes/air-probe}.js`（**唯一权威源码**）· `scripts/funcs/modes/README.md`（多模式结构与预留契约）· `scripts/{plan-map.py,fetch_subway_data.py,coordinate-transform.js,coordinate_transform.py,audit-game-features.js}` · `scripts/funcs/ops/ops.js`（客流运营）· `scripts/funcs/ops/autopilot.js`（全自动经营托管）· `_dev/{smoke,lint-static}.js`（Node VM 冒烟 + 静态一致性）· `_dev/test-plan-map.py`（10项）/`_dev/test-plan-poi.js`（17项）/`_dev/test-plan-draw.js`（45项）/`_dev/test-autopilot.js`（11项）/`_dev/test-branch-ring.js`（3项，规划图/POI/绘制/托管回归）。参考：`references/{ui-features,game-features,map-engines,operations}.md`。旧单文件（MT 5.5 / OD 2.29 / K 2.11）与浏览器扩展已归档，非注入基线。

---

## §2 会话启动与界面进入

### 2.1 界面进入（默认用户自操作，强制）
`open_browser_page` 打开页面后，**登录（邮箱）· 模式选择（经营/创意）· 存档选择（云存档/缓存/直接进入）· 进入城市主界面**等一切界面选择**都由用户在页面上完成——AI 不点击/不选择/不代劳**。AI 只做：①只读 `read_page` 简报页面状态；②提示用户"请自行选择并进入"并等待。页面停留「欢迎来到AnyCity/选择存档」时 AI 只提示、绝不替点。**必须等用户明确表示已进入主界面/给出任务指令后**，AI 才注入工具箱开始执行。

### 2.2 启动只做一件事（自动开询问）
**启动时不注入、不操作、不提问**——只打开页面、简报状态，然后**自动用询问工具开启第一个询问**（本次要做什么/功能/城市/线路/参数）。收到回答后：①按任务分派判分支 ②补缺失关键项（一次/分批弹框）③**此时才注入工具箱**→执行对应流程。

### 2.3 进入城市/恢复存档·流程参考
（仅用户困惑/授权代操作时用，不改变"默认用户自操作"强制规则）
- 直开 `anycity-global` 点模式按钮弹"暂不开放"，或直调 `tryRestoreLocalDraftNoFlowForCity` 报 `METRO_SAVE_STATE_NORMALIZER_UNAVAILABLE` = 未走正规入口。**必须走正规入口**：城市选择页像素地图 AnyCity 国内/国外灰点 → 父窗口 **`metroEnterAnyCityPointFromPixelMap(lng,lat,countryName,geofabrikId)`**（国内点如 `(118.78,32.04,'China','china')`）。
- 正规进入后 → 创意模式（normalizer 就绪）→ 「当前缓存·日期」（IndexedDB 草稿）→ 恢复。
- **恢复成功标志**：toast"已恢复本地进度…" + 线网里程=真实公里数 + `G.lines` 恢复。恢复后重新注入工具箱（重载后 MT/OD/K 全丢）。
- **避免**：游戏未 ready 前点模式按钮；勿直调 tryRestore（缺 normalizer）；页面可能残留隐藏"删除线路"确认 dialog 勿误点确认。

### 2.4 工具箱注入（收到指令后执行一次）
> **v4 拆分架构**：MT 为多文件共享 `window.__metroToolkit`，须按 `mt-core → mt-node → mt-amap → od → k` 顺序注入（od/k 依赖 MT）；srhdata（`__SUBMETRO_DATA`/`__MT_SUBMETRO_DATA`）与 `metro-unopened-paths.js` 可选注入（无库时实时查询降级）。
```js
// 路径 = 技能安装根（.copilot/skills/city-metro-builder 或仓库 skills/city-metro-builder）
const B = '<skill-root>/scripts/funcs';
await inject(B + '/query/mt-core.js');
await inject(B + '/query/mt-node.js');
await inject(B + '/query/mt-amap.js');
await inject(B + '/draw/od.js');
await inject(B + '/manage/k.js');
await inject(B + '/draw/plan-map.js'); // 可选：规划图；核验 window.PlanMap.version === '1.1.1'
await inject(B + '/ops/ops.js');   // 可选：客流运营（排班/票价）
await inject(B + '/ops/autopilot.js'); // 可选：全自动经营托管（仅 management；核验 MetroAutopilot.version==='0.3.0'）
await inject(B + '/manage/official-edit.js'); // 可选：官方编辑（配色/编组、官方延长、支线、断线重绘）
await inject(B + '/manage/fare-lab.js');     // 可选：票价实验（调价/记录/候选方案）
await inject(B + '/modes/mode-registry.js'); // 可选：多模式注册表（metro/hsr/air）
await inject(B + '/modes/hsr-probe.js');     // 可选：高铁只读探测（预留）
await inject(B + '/modes/air-probe.js');     // 可选：飞机只读探测（预留）
const v = await evaluate(() => ({
  MT: window.__metroToolkit && window.__metroToolkit.__version,   // "6.5.3"
  OD: window.__officialDraw && window.__officialDraw.__version,   // "2.60.0"
  K: window.CityMetroKit && window.CityMetroKit.__version          // "2.9"
}));
```
- `inject` 按宿主替换：VS Code Copilot `page.addScriptTag({path})`；Playwright MCP `browser_evaluate`/`browser_run_code_unsafe`；CDP `Runtime.evaluate`（仓库 `browser/cdp.mjs` 的 `POST /script {file}`）。
- 幂等（版本守卫）：core/node/amap 各自 `__coreVersion/__nodeVersion/__amapVersion` 应为 6.5.3/6.5.4/6.5.3，OD/K 用 `__version`；可选 PlanMap 用 `version`（1.1.1），Ops 1.3.5，MetroAutopilot 0.3.0；重注入同版跳过。
- 校验导出：`Object.keys(window.__metroToolkit).sort()`（见 §10）。srhdata 专题优先本地脚本抓取（页面 fetch 可能被 CORS 拦截；勿设 CORS route）。

### 2.5 坐标转换 / 双地图引擎（默认高德）
- 页面注入 `coordinate-transform.js` → `window.__CoordTransform`：`gcj2wgs(31.844,117.305)` / `wgs2gcj` / `gcj2bd` / `bd2gcj` / `wgs2bd` / `bd2wgs`。命令行版 `python scripts/coordinate_transform.py gcj2wgs 31.844 117.305`。
- **引擎判定**：`MT.mapEngine()` → `'amap'|'osm'`；`MT.engineProfile()` → `{crs,dataSource,convertAmapToGame,nodeToleranceM,stationTolM,transferTolM,...}`。完整特调见 `references/map-engines.md`。
- **默认高德（强制）**：两种引擎都先用高德取数。AMap 引擎直接使用 GCJ-02；OSM 引擎用 `MT.toGameCoords(stations,nodes)` 转成 WGS-84 后再绘制（返回 `converted:true`），**禁止两套坐标混用**。
- **OSM 兜底**：仅高德确实无该线数据才 `MT.queryOsmOverpass`（优先游戏内 OSM API，失败回退公共 Overpass）；OSM path 稀疏时先 `fitSegmentNodes`，空段用直线兜底，禁止虚构走向。
- 拟合硬门禁（两引擎一致）：`missing.length===0 && interpolated.length===0` 才交付。切引擎/主题后先 `MT.detectOsmShift`（>150m 判错位）再修复。

---

## §3 交互协议（标准化询问 / 输出 / 任务分派）

### 3.1 标准化询问（Qoder `AskUserQuestion` / VS Code `vscode_askQuestions`；指令已明确/setOpts 已记忆跳过）
| # | 项 | 选项（默认加粗） |
|---|---|---|
| 1 | 任务 | 绘制单条/枚举/批量绘制/未知线路/规划图/支线环线/一键操作/检查调整 |
| 2 | 城市 | 上海/苏州/无锡/常州/南京… |
| 3 | 线路范围 | 全部/指定列表（多选） |
| 4 | 节点密度（必问） | **standard**/sparse/dense/line_curve |
| 5 | 命名方式（必问） | **cn_metro**/cn_rail/cn_rail2/plain/自定义/不重命名 |
| 6 | 绘制方式 | **官方逐步**/一次性(`OD.drawLine`) |
| 7 | 数据源 | **auto**/srhdata/game/poi/web |
| 8 | 收尾(多选) | 自动换乘✓/自动保存/删旧线/严格检查/换城市 |

### 3.2 询问 ↔ setOpts ↔ 函数 一一对应表（问了必有函数，函数必有询问）
| 询问项 | setOpts 键 | 落点 |
|---|---|---|
| ①任务 | — | 任务分派分支 |
| ②城市 | — | `MT.resolveCityKey`/`MT.queryLine`/`K.setLineStatus` |
| ③范围 | — | 枚举未绘制→逐条核心五步 |
| ④密度 | `density` | `OD.rebuildNodesFromAmap(city,id,{density})`(sparse15/standard12/dense8) + `K.addNodes(id,null,{density})` + `MT.curvatureThin(pts,{density})`；line_curve 见 §5 |
| ⑤命名 | `namingRule` | `K.applyNaming(city,no,rule)` + `line.name=新名` + `_lineNameCustomizedByUser=true` |
| ⑥绘制方式 | `drawMode` | 官方逐步=UI 逐站 / 一次性=`OD.drawLine` |
| ⑦数据源 | `dataSource` | `MT.queryLine` 数据源优先级 |
| ⑧换乘 | `autoTransfers` | `OD.autoTransfers(lineId,{city})` / `K.fixTransfers(filter)` |
| ⑧保存 | `autoSave` | `top.downloadLocalSave()`(=Ctrl+S) |
| ⑧删旧 | `deleteOld` | `K.deleteLine(id)` |
| ⑧严格 | `checkStrict` | `OD.checkLine3x(id,{strict:'strict'})`(100m) |
| ⑧换城 | — | 下一轮询问 |

### 3.3 命名规则
`K.applyNaming(city,lineNo,rule)`：`cn_metro`→上海地铁1号线(默认)/`cn_rail`→上海轨道交通1号线/`cn_rail2`→上海轨道1号线/`metro`→地铁1号线/`plain`→1号线/`line`→1 Line/`en`→Line 1/自定义模板/不重命名。命名影响地区识别（完整名才能被 `regionOf` 识别）。

### 3.4 标准化输出（每步汇报固定格式）
```
【结果】做了什么
· 线路名 · 站数 · 节点数 · 颜色 · 车型
· 检查：OD.checkLine3x → pass/fail + 问题（四检：结构/坐标/视觉/走向）
· 附加：换乘/命名/分类/地区（按需）
【问题】失败/偏差/估算项（无则省略）
【下一步】建议
```

### 3.5 任务分派
| 用户意图 | 分支 | 入口 |
|---|---|---|
| 绘制/重绘某线 | 核心五步 | §4.1 |
| 多条/还有什么没画 | 枚举→逐条核心五步 | §7.2 |
| 一键批量管理 | 批量操作 | §7 |
| 给规划图/线网示意图 | 见 §8.3 | §8.3 |
| 支线/环线 | 特例 | §4.3/§4.4 |
| 未知线路/高德无数据 | 先问规划图→网络+校验 | §8.2 |
| 换乘缺失/组错乱/坐标错位 | 同名跨线扫描→建组→校准 | §6.4 |
| 改名/改位/加节点卡顿 | 已内置轻量重绘 | 原则 0.4 |

### 3.6 全局选项记忆
`K.setOpts({density,dataSource,drawMode,autoTransfers,autoSave,checkStrict,namingRule,deleteOld,endPadM})` 批量设置、`K.opt(key)` 读取、`K.resetOpts()` 重置。用户多次指定同一组选项时存一次后续默认沿用。⚠️ `tolerance` 是**函数级参数**非全局选项（`setOpts` 不支持），全局用 `density` 档位控制抽稀强度。

---

## §4 官方绘制（核心五步 / 普通线 / 支线 / 环线）

> **走向质量（2026-11-09 实测新增）**：`MT.queryLine` 返回 `pathQuality:'amap'|'straight'` 与 `needsPath`。本地 srhdata 命中且无 path 时为 `straight/needsPath:true`；**AMap 可用时已自动用高德 path 精化**（`dataSource:'local+amap-path'`，129ms 实测），精化失败才保留直线节点。无 AMap/key 时 `opts.refine:false` 可跳过；直线节点仍须 `OD.rebuildNodesFromAmap` 精化。

### 4.1 核心五步流程
**五步**：①询问名称 → ②查询数据（数据源优先级 §4.2）→ ③官方绘制 → ④四检 checkLine3x → ⑤汇报确认保存。
- **调用逻辑**：见下方各步；**形态**普通线/支线（§4.3）/环线（§4.4）。
- **使用规则**：绘制中每一步后立即检查（查询后核对站序/站数/坐标；放站每步核对站序与站数递增；放节点每步核对节点位置）；完成后 `checkLine3x` 三次检查 pass 才汇报 + 询问确认；绘制完成自动修复换乘。
- **注意事项**：默认官方接口；脚本仅一次性完成整条线（操作前询问是否用脚本）；调整节点先删全部旧节点。

### 4.2 数据源查询（MT 板块）
**默认高德（2026-11-09 用户要求，强制）**：无论 `G.mapEngine` 是 amap 还是 osm，都先走高德；OSM 引擎取数后用 `MT.toGameCoords` 转换，高德无数据才降级 OSM/其他。
**数据源优先级（失败自动降级）**：①游戏内高德 API（无 CORS，`window.AMap`）→ ②高德免费 Web API（restapi v3）→ ③高德地铁专题 srhdata（免费一次全量，本地脚本抓）→ ④POI 线路名搜索（在建线）→ 🔵完整性检查 `checkLineCompleteness` → ⑤OSM/网络多平台（未知线，OSM 引擎下先高德后 OSM）。
**调用逻辑**：
```js
const r = await page.evaluate(() => window.__metroToolkit.queryLine('上海','5',{stationFrom,stationTo}));
// r.stations:[{name,lng,lat}]  r.nodes:每段节点  r.color/trainType/trainCars  r.completeness
```
**使用规则**：先判未开通（srhdata 无该线号→POI）；已开通优先 game transferSearch 或 free web；坐标获得后必过 `verifyMetroPOI`；编号配对校验（占位符替换/线号校验/站序配对/换乘站单独分线查询）；网络数据必须地图校验。
**注意事项**：⚠️ 查询后必须核对完整性（站数<官方→缺失区段须询问是否补画）；⚠️ 站点坐标两次查询防错 `OD.resolveCoordTwice`（偏差≤120m 正常/过大存疑不放置/单次标注 single_source/都失败 missing）；⚠️ srhdata 个别站坐标可能纬度整体偏移（须 resolveCoordTwice 交叉校验）；⚠️ queryLine 5min 缓存 key 含起讫点（分段/支线勿命中错缓存，用 transferSearch 直查）。

### 4.3 支线特例（官方 B 键逻辑）
- **选取最长支路设为主线**（完整路径几何总长最长者 `branchRootId=null`；实测上海5号线主线=莘庄→奉贤新城 15站、支线=东川路→闵行开发区 5站，曾主/支倒置）。
- **调用逻辑**：`OD.startBranch(mainLineId, 起点站名)` 自动建支线（同主线名色、branchRootId=主线、首站复用）→ 逐站放（`OD.drawBranchStations` / place 模式）→ 节点（`OD.setBranchAnchors` 直写 segmentAnchors）→ 完成（`OD.finishBranch`→confirmCreateLine，**勿用 confirmLine**）。
- **使用规则**：不要单独建线；脚本导入主/支线也须保持 branchRootId 结构；支线节点用高德 SUBWAY path 拟合（分段用 transferSearch 勿用 queryLine）。
- **注意事项**：主线+支线**分别** `checkLine3x`（含 branchRootId）；支线起点站自动换乘与主线共用。

### 4.4 环线特例（首尾闭合）
- **首站任意**（建议关键站如宜山路）。≥2 站才能放节点（放第2站后放第1段节点）；末站放完放闭合段节点（站N→站1）。
- **调用逻辑**：绘制完所有站+节点 → `top.completeRingLine(line)`（设 isRing=true）→ `OD.finishEdit` 退出。
- **使用规则**：环线数据需完整站名列表 + 逐站 `MT.resolveCoord` + 逐段查节点（高德对环线只回部分站）。
- **注意事项**：环线闭合后必 `checkLine3x`（含 isRing+闭合段节点）。数据走 srhdata 完整站名 + 逐段 transferSearch（queryLine 对环线只回半圈）。

---

## §5 节点拟合（密度档位 / 拟合算法）

### 5.1 节点密度档位（绘制前必问）
| 档位 | 容错 tolerance | 适用 |
|---|---|---|
| sparse | 15m（抽稀最强·节点最少） | 市域长线、直线段多 |
| standard | 12m（默认） | 常规城区线 |
| dense | 8m（抽稀最弱·节点最多） | 弯道多、要求贴合 |
| line_curve | 动态（直线疏/弯道密） | 城区直段多、弯道需贴合 |

### 5.2 调用逻辑
- `MT.curvatureThin(pts,{density|tolerance})`（**权威实现**，OD 委托 MT）/ `MT.fitSegmentNodes(stations,path,{density,tolerance,endPadM})` / `K.addNodes(id,null,{density})` / `OD.rebuildNodesFromAmap(city,id,{density})`。
- **⚠️ fitSegmentNodes 单独调用不抽稀**（返回密集点）：手动重绘/重建节点必须两步 ①fitSegmentNodes 密集拟合 → ②curvatureThin 容错抽稀。
- **合并同类逻辑·功能分类与调用图（强制，2026-11-12 去重）**：几何单一权威在 MT——`curvatureThin`/`adaptiveDensity`/`NODE_DENSITY`/`fitSegmentNodes`/`padSegmentNodes`/`haversine`/`localTurn`/`sampleCatmull`/`catmullRom`；OD/K/PlanMap/mt-amap 一律委托 MT，不得本地复制。OD 内部绕路检测统一 `_chainRatio`（合并 6 处重复）、站台避让统一 `MT.padSegmentNodes`/applyLineData ④b。功能分类：query=mt-core(基础/坐标)/mt-node(几何)/mt-amap(数据源)；draw=od(官方绘制)/plan-map(图纸)；manage=k(批量)/official-edit(经营编辑)/fare-lab(票价)；ops=ops(运营)/autopilot(托管)；modes=多模式预留。新增/修改几何一律改 MT。

### 5.3 使用规则
- **站台避让**：`fitSegmentNodes`/`K.addNodes` 过滤距两端站台<`endPadM`（默认100m）节点；防空段保留中点。
- **节点间距均匀性**：相邻节点间距比值≤2（大转弯后按2倍递增）由 curvatureThin 段内渐变（maxRatio≤1.8）实现；**不做全链全局平滑**（会破坏段内均匀+节点爆炸）。
- **line_curve 档**：弯道判定综合 ratio>1.1 / 累计转角≥50° / 最大转角≥15°；直线段节点必须从该段高德 path 上取点（勿几何中点直线插值）。

### 5.4 注意事项
- 有高德 SUBWAY path 必须用它拟合（非导航/公交/步行）；只有高德无 path 区段才直线插值。
- 调整节点前先删全部旧节点再重绘（防新旧混合错乱）。
- `OD.densifyAnchors` 为 **RED 高风险**（`_curvePts` 未按段填充时节点爆炸）；重建节点一律用 `rebuildNodesFromAmap`。

---

## §6 批量管理（K 板块）

### 6.1 全局选项 / 命名 / 分类 / 地区
```js
K.setOpts({density:'dense',autoTransfers:false,namingRule:'cn_rail',deleteOld:false}); // §3.6
K.applyNaming('上海','1','cn_metro');            // 命名规则
K.setLineStatus(id,'built');                     // 分类 built/under/planned（null=筛选）
K.regionOf('上海地铁4号线'); K.linesByRegion('上海'); K.status('上海'); K.regions();
```

### 6.2 一键批量操作（已有线路管理，非绘制）
触发文本→操作对照：配色 `K.applyOfficialColors(colorMap)` / 补节点 `K.addNodes(id)`·`K.addNodes('all',...,{batch:10,gapMs:250})` / 站名 `K.applyStationNames`·`K.calibrateCoordinates` / 修复 `K.fixLine(id)`·`K.fixLine('all')` / 换乘 `K.fixTransfers(filter)`。
**使用规则**：操作脚本绕过 UI、内部自动 `K.repaint()`；完成后对涉及线路 `OD.checkLine3x` 核对 + 询问是否有误，仅在用户另行明确授权后保存，默认不主动存档。

### 6.3 高风险操作拦截（RED/YELLOW）
| 等级 | 操作 | 处理 |
|---|---|---|
| 🔴RED | `fixTransfers()` 无 filter / `deleteLine`·`deleteCityLine` / `densifyAnchors` / `rebuildNodesFromAmap-all`·`fixLine-all`·`placeStations-bulk` | 必须先询问，未确认停止 |
| 🟡YELLOW | `applyOfficialColors-all`·`addNodes-all`·`applyStationNames-bulk`·`applyNaming-bulk`·`autoTransfers`·`calibrateFromAmap`·`setLineStatus-all` | 先询问确认范围 |
| 🟢GREEN | 单条 drawLine/applyStationNames/applyOfficialColors/addNodes/fixLine/rebuildNodesFromAmap | 遵循"每线必询问" |

**调用逻辑**：`K.riskLevel(op)` / `K.confirmDangerous(op,ctx)`（未确认返回 `{blocked:true}`）/ 确认后 `K.allowDangerous(op)` / 会话开始 `K.resetDangerous()`；页面确认框 `K.confirmRisk(op,ctx)` / `K.showRiskDialog(op,ctx)`。
**注意事项**：agent 遵守"即使脚本没拦截，RED/YELLOW 未询问确认绝不执行"。

### 6.4 换乘（坐标独立 / 建组 / 校验）
- **各线坐标来源（禁用通用坐标）**：换乘站在不同线路不同站台位置，各线必须分别查询持有独立坐标对象，**不得强行合并/对齐**。已开通线用该线全线 SUBWAY path 投影（`OD.queryLinePaths`→`projIdx`，`K.resolveLineCoord`）；未开通用该线 POI。**禁用通用 resolveCoord**（会让各线趋同）。
- **坐标独立对象（强制）**：任何换乘操作/坐标校准/导入后 `K.separateTransferStations(filter)` 把共享站克隆为各线独立对象（保留 name/sid/transferGroupId/transferType，latlng 独立深拷贝）。切勿在共享站对象上直接改 latlng。
- **建换乘**：只设 isTransfer=true+同 transferGroupId+transferType（+transferSpatiallyUnlinked=true 保持独立坐标），禁用 `_applyTransferDecision`（会拉偏名字/组）；官方 `_applyAutoPassageTransferBetweenStations(a,b)` 可用。建组后 `separateTransferStations`→轻量重绘。
- **严格校验（防误建）**：`fixTransfers` 同名站坐标差 ≤150m（游戏 SAME_POINT_M=150）才算真换乘；勿把不同位置换乘站并入同一组。手动建组 `K.applyTransfer(lineId,站名,伙伴线,伙伴站,kind)`（自动刷新 UI+分离对象）。
- **调用逻辑**：绘制后自动 `OD.autoTransfers(lineId,{city,lineNameMatch})`（高德查伙伴→游戏内精确匹配→官方建组，幂等）；换乘核对 `OD.inspect`。
- **防卡死**：收尾只对受影响线路 `redrawLine`+`refreshStationDots`，绝不全量 repaint。
- **绘制换乘站防吸附**：`OD.drawLine` 绘制时自动 `_disableSnap()`（精确放置 distM=0 + 禁用自动建换乘吸附），完成 `_restoreSnap()` 恢复。

---

## §7 枚举 / 批量绘制

### 7.1 枚举城市未绘制线路
`MT.officialColors(城市)` 应有线路 − 游戏已有 = 未绘制列表 → 表格展示 → 询问工具多选 → 逐条走核心五步（命名不遗忘，`window.__NAMING` 记录规则）。
**注意事项**：精确匹配线号（S1≠1、K1≠1、18≠8）；配色表未收录城市需在 core.js 扩展。

### 7.2 批量绘制 = 逐条走核心五步（唯一多线/批量绘制与导入路径）
任何多线绘制/批量导入统一逐条走核心五步（一条完整完成再下一条，绝不并行/穿插）。
**使用规则**：命名规则持续应用；未知线路中途问规划图；每条准确性检查（checkLine3x+询问）；每条导入必须补空段节点（`K.addNodes` 只补空段每段≥1，环线闭合段也要）；主/支线最长为主线；节点用高德 SUBWAY path 拟合。

---

## §8 特殊场景

### 8.1 未开通 / 在建线路（POI 搜索）
**识别**：srhdata 无该线号 / `queryLine` 返回 busFallback 或 0 站。**调用逻辑**：`MT.queryLineStopsByPOI(city,lineNo)`（placeSearch 线路名+城市范围过滤+去重）。**节点**：按数据优先级（高德→规划图→线路连续小曲率→直线插值标注估算）；禁止导航 path。**跨城规划线**：锚定两端确认站+公交线路名反查走向+占位站修正。

### 8.2 未知线路 / 网络多平台查询 + 地图校验
**触发**：POI 返回过少/为空。**流程**：①网络多平台(fetch_webpage 百科/公示/新闻/规划图交叉)→②逐站地图校验(强制 resolveCoordTwice+城市范围+POI地铁+多次一致)→③走向合理性→④可用性分级(✅可绘制/⚠️估算/❌剔除)→⑤绘制(checkLine3x+设 _category)。
**注意事项**：汇报注明数据源（网络多平台+地图校验）与估算站。高德完全无数据先问是否有规划图。

### 8.3 规划图绘制（图片 / 线网示意图）
- **先读操作规程**：`references/plan-map-draw.md`；仅读用户指定图片（已有路径不重复问）。按图真值优先，仍查高德作锚点/独立检查；无 OCR，人工标站名、像素中心及准确站序，不内置城市数据。规划原理（站距/曲线/速度/换乘同台方向）见 `references/metro-planning-principles.md`。
- **唯一实现**：`scripts/plan-map.py` prepare/compile → `PlanMap.prepare(compiled,i,real)/draw/check`；工作图/裁剪坐标明确，≥3 不共线锚点+≥2 独立检查，归一化 SVD 仿射、默认最大误差250m、禁凸包外推。**默认自主设计**：图纸取大致走廊，agent 结合道路/网形设控制点（DP 25m 保留转弯）经 `real.paths` 传入，`fitSegmentNodes`+`curvatureThin` tolerance6/minGap30、站台避让100m，设计线到图纸走廊偏差≤40m 并汇报；**像素拟合为弱模型备选**（Lab 色带有界 A*+via、Chaikin 平滑、断路不直线兜底），仅显式选择启用；道路走廊综合校验（Walking/Driving 比对，中位≤40m 且≥70% 点≤40m 才吸附，否则保留设计并汇报偏差）；prepare 门禁坐标范围/端点≤1m/节点数≤段长/30+8；禁造中点/删并近站/经纬度单调判序。
- **仅隔离创意普通独立线**：新标签页不等于独立存档槽；无在途请求后先停测试页云自动保存，不碰旧经营页、不抢前台。快照→官方建线/属性→首站 placeStation、后续 onMapRightclick/executePlaceModeStationClick→命名队列→≥2站确认；partial 查前缀不自动删线重试。支线/环线另走官方接口及独立测试，保存/重载仅另获授权后本地进行，禁写旧云槽。
- **验收/覆盖**：精确站数/站序/节点/颜色/spec；2m 写回与250m 独立配准分开，输入叠图+真实游戏截图；全图例队列 unread→identified→registered→traced→prepared→drawn→verified，blocked/partial 不算完成，短线成功≠整图完成。官方只读示意图仍用 `openMetroDiagramView()`/`regenerateMetroDiagram()`+截图。

### 8.4 有轨电车 / 非地铁制式（MT 6.0）
**调用逻辑**：`MT.verifyTramPOI` / `MT.resolveTramCoord(city,name)` / `MT.queryTramLine(city,lineName,{stations})`（必须传官方站名表，防混入其他有轨电车线站+出入口噪音）。**绘制**：节点直线插值（无 SUBWAY path）、C 型车、`K.fixTransfers` 建换乘。**注意事项**：连续调用触发高德限流（内置重试+5min 缓存；仍空用 resolveTramCoord 逐站查）。

### 8.5 文件层面复刻工作流（references/metro-replication-workflow.md）
用户明确要求"依据本文/基于最新存档/输出存档"时优先执行文件层面流程（读存档→PMTiles/真实 path→坐标转换→切分拟合→离线验证→输出新存档）；浏览器仅可选验证，不自动进 UI。核心硬门禁：中间节点必须来自真实 path，`missing.length===0 && interpolated.length===0` 才交付。

### 8.6 修复模式（脚本化只读扫描；鼠标追踪/悬浮窗已移除）
- **无鼠标追踪 UI**：OD **无 `enableFixTracker`/`getFixTrackerState`/`__metroMouseTracker` 导出**，浏览器扩展（悬浮窗/`__metroDetect`/`__metroUI`）为废案，v4 不再注入或依赖。修复一律走脚本只读扫描 → 定点修复。
- **只读扫描**：遍历 `G.lines` 查空节点段、占位站名、出入口噪音、绕路段、跨线同名站缺换乘/孤儿换乘；输出问题清单后再逐项修复（见 `references/efficient-mode.md` §4）。
- **节点顺序检测/修复（OD 保留）** `OD.hasNodeOrderIssue(lineId,segIndex)` / `OD.fixNodeOrder(lineId,[segIndex],{city,density})`：官方路径重建→投影重排→直线兜底。⚠️ 官方 path 本身可能折返，需配合投影重排。

### 8.7 多模式预留（高铁 / 飞机，2026-11-10）
- **注册表**：`window.CityTransportModes`（0.1.0）统一登记 `metro/hsr/air`，`list()` 返回 `{id,label,reserved,available}`，`detect()` 返回当前 `G.transportMode/gameMode/economyMode` 与已支持模式。
- **只读探测（预留，不做写操作）**：
  - `window.HsrProbe.state()`：`hsrRealworldMyRoutes`/`hsrRuntimeTrains`/`_hsrLiveStations`/`_hsrLiveSectionLoads`/`_hsrLiveEconomyInput` 计数与快照；`opts()` 读取 `HSR_TRAIN_TYPE_OPTS`/`CARS_OPTS`/`CARS_CAPACITY`/`SPEED_OPTS`。
  - `window.AirProbe.state()`：`flightLayerVisibility`/`flightAirportColors`/`AirportPA`；`entrypoints()` 索引 `openFlightPlannerPanel`/`openFlightRouteSearchPanel`/`applyFlightEntryMapNameDefault`。
- **硬约束**：HSR/飞机未实现写操作前，任何调用返回 `{ok:false,reserved:true}`；不得猜测或直接改 `G` 数据。官方入口见 `scripts/funcs/modes/README.md`。
- **文件结构**：当前保持 `query/draw/manage/ops/modes`；目标为 `shared/metro/hsr/air/modes`，迁移时先加 facade 再移动，旧路径保持可注入。

---

## §9 不便分类的条件特例（按需查阅，非主流程）

> 以下为**特定条件下才触发**、不便归入单一功能板块的规则与实测教训。无对应条件时无需通读。

### 9.1 数据特殊性
- **srhdata 个别站坐标纬度整体偏移**（实测上海5号线环城东路/望园路纬度多写 1 度≈110km）：查询后每站 resolveCoordTwice/placeSearch 交叉校验，纬度明显偏离城市范围立即用 POI 修正。
- **queryLine 缓存**（5min）key 含起讫点：环线/分段/支线用 `transferSearch` 直查，勿命中错误缓存。环线 queryLine 只回半圈，用 srhdata 完整站名表+逐段 transferSearch。
- **编号配对**（查询后必做）：占位编号 `站N`→官方站名表替换；POI 必须属目标线号（过滤"X号口"出入口、跨线同名站）；站序与官方不一致需重排；换乘站按目标线号单独查询。
- **网络数据必须地图校验**（强制）：无法定位/明显错位剔除或标注估算。

### 9.2 大存档性能 / 防卡死
- 页面长时间高负载卡死/重载（高德瓦片 ERR_ABORTED+全网客流重算）。存档在 IndexedDB 不丢；恢复见 §2.3 与原则 0.6。
- 全量 repaint/redrawAllMetroOverlays 大存档会重算全网客流卡死——批量/换乘/分离收尾只用受影响线轻量重绘。
- `K.addNodes('all',2500,{batch:10,gapMs:250})` 分批；放节点分批暂停；查询 withTimeout。

### 9.3 换乘与防误删实测
- **fixTransfers 无 filter 全库**曾致全城换乘组并入一组（RED 强制拦截）。必须带 filter 或显式确认。
- **densifyAnchors** 对 `_curvePts` 未按段填充线路会节点爆炸（48km）。重建节点一律用 rebuildNodesFromAmap。
- **换乘伙伴线缺失**：伙伴线未画导致无法建换乘（需先画伙伴线）；高德命名差异站按坐标邻近<250m 手动补建。
- **删除/重绘旧线前备份换乘**（存 `window.__lineTransferBackup`）——防用户自建换乘连带丢失。
- **跨城市同名站防误配**：用城市范围 + 坐标距离（≤150m 才算换乘）双重约束。
- **站坐标校验**：校准后 resolveCoordTwice 交叉校验（devToAmap 应为 0 或 ≤120m）；"错位"多为伙伴线未画致换乘缺失，非坐标错误。

### 9.4 节点/顺序实测
- **乱序修复后必复查**（先查后生成）：顺序检查先于一切节点生成算法；修复后复扫至 remaining=0 才补点/收尾。
- **拟合优先于稀疏**：maxDev>30m=不拟合段必须重建（宁密于失 fit）。
- **18号线曾置空超长空段被否决** → 直线走廊补 3/5 节点恢复连续；置空≠永久删除。

### 9.5 其它踩坑
- `enterStationAddModeOnLine` 必须传 id 字符串（勿传对象）；放置前先写 `_curvePts`；≥2 站才能放节点；放置被拒正常跳过；完成绘制用 `confirmCreateLine`（勿用 `confirmLine`）。
- 不要 `location.reload()`（刷新一律 `redrawAllMetroOverlays`）。
- 页面可能残留隐藏"删除线路"确认 dialog 勿误点确认。
- 隐藏玩家/客流弹窗（"客流加载困难"提示）忽略，不影响数据。
- 手机/交互：单击被地图拖动占用，修复模式改为双击后长按圈选。

---

## §10 函数速查表（按源码实际导出键校准，2026-11-09 v4）

> 优先级：🔴必检（绘制/导入后必用）· 🟢常用（流程主路径）· 🔵兜底（失败降级）· ⚪ / ⚪ / ⚪数据（配置/只读）。以下键 = `scripts/funcs/` 各源码对象的实际导出，与代码一一对应（验证：注入后 `Object.keys(...)`）。

### 10.0 OE — 官方编辑组件（`window.OfficialEdit`，1.1.8）

- `OE.officialSpec(city,no)`：官方车型/编组/限速。
- `OE.applyProps(lineId,city,no)`：应用官方配色/车型/编组并回读。
- `OE.auditConfigs(city,prefix)`：按线路名前缀批量校正配色/编组。
- `OE.extendAtTerminal(lineId,terminalName,stations)`：官方 `startExtendLine` + `executePlaceModeStationClick` + `finishEdit`。
- `OE.branchStart(mainLineId,stationName)`：官方支线入口（打开方向模态）。
- `OE.redrawAsSingle(cfg)`：删旧线→官方全线查询→createLine→setLineProps→批量放站→改名/节点/交路/换乘→四检。
- `OE.buildLine(cfg)`：新建整线（不删线）→整线查询（失败自动逐段拼接）→createLine→配置→分批放站→改名→**尾部缺站自动官方延长补齐**（`autoExtendMissing`，OE 1.1.7；实测苏 11 首轮 24/28，补 4 站）→站台避让节点→默认交路→自动换乘→四检→清客流缺口；`dryRun:true` 只查询。实测苏州 7 号线干跑 28 站/27 段全真实走向。
- `MT.KNOWN_EXTENSIONS`：高德整线未收录的官方延伸站（当前：苏州 2 号线 head 爱格豪路/珍珠湖路/渭中路/朗力福大道、6 号线 tail 华云），`queryLine` 自动补站。
- `MT.queryConstructionLine(city, stationNames, {alias,order,lineName,fallback})`：在建线位置读取——官方站序 + POI 坐标 + **逐段地铁 path**；无 path 段用 `smoothLineNodes` 样条拟合并标记估算。
- `MT.queryLineBySegments(city, no, {stations|stationNames, lineFilter, fallback:'spline'|'straight'})`：**未开通/整线查询漏段的裁线器**——逐对相邻站查询 SUBWAY path，返回 `{stations,nodes,segStatus,fitted,estimated}`；苏州 8 号线实测 27/27 段成功、11 号线 13/27 段、2 号线北延 0/4 段（样条回退）。默认并发 2、失败重试 2 次。
- `OE.autoTransfers(lineId,tolM=350)`：同名且 350m 内自动建换乘。
- `OE.observe()`：全量游戏监测（余额/配额/报价/客流/ledger/排班/通知/模态/可见性）。
- `OE.startMonitor(ms)` / `OE.stopMonitor()`：滚动监测到 `window.__oeMonitor`（最多 40 条）。
- `OE.quotes()`：km/stations/cars/express 当前动态报价。
- `OE.economyPlan()`：综合投资规划（车厢缺口、拥挤、车站+里程包、资金缺口），返回下一步采购建议。
- `OE.startQuotaBuyLoop({quotaKey,targetFree,maxPacks,intervalMs,beforeSettleBuffer})` / `stopQuotaBuyLoop` / `quotaBuyLoopStatus`：官方额度自动购买循环；只用经营余额、保留日结安全线、达标即停，日志见 `quotaBuyLoopStatus().log`。

### 10.0b FL — 票价实验组件（`window.FareLab`，1.0.1）

- `FL.current()` / `FL.setBands(bands)`：读取/应用分段票价。
- `FL.snapshot(label)` / `FL.history(n)` / `FL.exportJson()`：记录规则+整点净额+余额，最多 120 条。
- `FL.latestNet()`：最近一条地铁整点净额（收入/补贴/运营/人次）。
- `FL.candidates()`：官方五段、温和 1.05、中价 2/2.5/3、2.5/3/3.5、高价 3/4/5、官方三段。
- `FL.applyCandidate(id)`：切换并自动记录 before/after。
- `FL.compare(a,b)`：对比净额/票款/补贴/运营/人次。

### 10.1 MT — 查询工具箱（注入 `window.__metroToolkit`，mt-core/node/amap 拆分共享）
`queryLine`🟢 / `queryRingLine`🟢(环线自动闭环) / `queryUnopenedLine`🟢(在建/规划线) / `queryLineStopsByPOI`🟢 / `queryOsmOverpass`🟢 / `queryLineOsm`🟢 / `parseOsmMetroData`🔵 / `resolveCoord`🟢 / `resolveTramCoord`🟢 / `queryTransferStops`🟢 / `queryTramLine`🟢 / `placeSearch`🔵 / `transferSearch`🔵 / `queryAMapSubwayWeb`🔵 / `queryLineByBusAPI`🔵 / `parseAMapSubwayData`🔵 / `compareSources`🔵 / `detectOsmShift`🔵 / `fixOsmShift`🔵 / `fitSegmentNodes`🟢 / `curvatureThin`🟢(权威) / `adaptiveDensity`⚪ / `sampleCatmull`⚪ / `catmullRom`⚪ / `localTurn`⚪ / `straightLineNodes`⚪ / `checkLineCompleteness`🔵 / `verifyMetroPOI`⚪ / `verifyTramPOI`⚪ / `inCityBounds`⚪ / `segInCity`⚪ / `officialColors`⚪ / `matchOfficial`⚪ / `extractLineNo`⚪ / `resolveCityKey`⚪ / `lineSpec`⚪ / `endpointsOf`⚪ / `getLines`⚪ / `findLine`⚪ / `webKey`⚪ / `webApiReady`⚪ / `ensureAmap`⚪ / `extractLngLat`⚪ / `withTimeout`⚪ / `withFallback`⚪ / `formatLineTable`⚪ / `subwayDataUrl`⚪ / `isRingLine`⚪ / `coordToGameNative`⚪ / `mapEngine`⚪ / `engineProfile`⚪(双引擎特调) / `toGameCoords`⚪(高德→游戏原生) / `dataSourceStatus`⚪(引擎策略/数据源体检) / `injectSrhData`⚪(注入 srhdata JSON) / `gcj02ToWgs84`⚪ / `wgs84ToGcj02`⚪ / `outOfChina`⚪ / `isWgsNativeCity`⚪ / `clearQueryCache`🔵 / `_normLineNo`/`_normStopName`/`_parseCoord`/`_parseSrhStops`/`parsePoiTileForLines`/`decodeTileGeom`(内部) / `queryConstructionLine`🟢(在建线逐段拼接) / `queryLineBySegments`🟢(整线漏段修复) / `smoothLineNodes`⚪(无 path 样条拟合) / `padSegmentNodes`⚪(站台避让) / `_distM`/`haversine`⚪ / `log`(内部) / 配置常量 `CITY_ADCODE`/`CITY_ALIASES`/`CITY_BOUNDS`/`LINE_ENDPOINTS`/`NODE_DENSITY`/`RING_LINES`/`RING_STATIONS`⚪ / `__version`(6.5.3) + `__coreVersion`/`__nodeVersion`/`__amapVersion`。
> `tileTemplate` 不在 MT：属可选模块 `window.__metroUnopenedPaths.tileTemplate()`（`metro-unopened-paths.js`）。

### 10.2 OD — 官方绘制封装（注入 `window.__officialDraw` v2.60.0，38 键）
`checkLine3x`🔴 / `verifyLine`🔴(高德/OSM 比对) / `verifyLineOrder`🟢(站序校验) / `drawLine`🔴 / `fastDraw`🔴(快速绘制) / `applyLineData`🔴(统一写线入口) / `createLine`🟢 / `finishEdit`🔴 / `_finalizeLine`🔴(统一收尾) / `rebuildNodesFromAmap`🔴 / `resolveCoordTwice`🟢 / `autoTransfers`🟢 / `autoTransfersBulk`🟢(批量换乘) / `curvatureThin`🟢(委托MT) / `queryLinePaths`🟢 / `_disableSnap`/`_restoreSnap`🟢 / `hasNodeOrderIssue`🟢 / `fixNodeOrder`🟢 / `densifyAnchors`🔴RED / `renameStations`🟢 / `inspect`🟢 / `transferViaAmap`🔵 / `startBranch`🟢 / `applyBranchData`🟢(支线写站/拟合/命名/收尾) / `setBranchAnchors`🟢 / `finishBranch`🟢 / `checkMainLine`🟢(主线判断) / `pickLongest`🟢 / `drawNodes`🔵 / `drawStations`🔵 / `setLineProps`🔵 / `NODE_DENSITY`⚪ / `densityOpts`⚪ / `adaptiveDensity`⚪ / `_projectSort`(内部) / `_rebuildNodesFromAmapImpl`(内部) / `__version`。
> ⚠️ `drawBranchStations`（旧 place 模式）已被 `applyBranchData` 替代；`smoothAnchorsGlobal`、`enableFixTracker` 等已删除，不可调用。悬浮窗/扩展 UI 为废案。
> **建线弹窗两版兼容（2026-11-09 实测）**：新版 `#line-name-input` + `#modal-line-confirm-btn`（“建设”）；旧版 placeholder「如：1号线」+「开始铺设轨道」。`OD.createLine` 已兼容两版；改版后若失败先查弹窗 DOM。

### 10.3 K — 批量管理（62 键，注入 `window.CityMetroKit` v2.9）
`snapshot`/`listSnapshots`/`rollback`/`clearSnapshots`/`clearSnapshotsOnly`/`listAudit`/`clearAudit`/`_auditBefore`🔴(快照审计回滚) / `confirmDangerous`/`allowDangerous`/`resetDangerous`/`riskLevel`/`riskDesc`/`riskRisks`/`confirmRisk`/`showRiskDialog`🔴(风险拦截) / `setOpts`/`opt`/`resetOpts`⚪ / `getLines`/`getLine`/`findCityLine`🟢 / `applyOfficialColors`🟢 / `addNodes`🟢 / `applyStationNames`🟢 / `calibrateCoordinates`🟢 / `calibrateFromAmap`🟢(该线高德校准全站) / `resolveLineCoord`🟢(该线 path 投影坐标) / `calibrateStationToLine`🟢(换乘站校准) / `configureLine`🟢 / `fixLine`🟢 / `fixTransfers`🔴RED(无filter拦截) / `applyTransfer`🟢 / `separateTransferStations`🟢 / `deleteLine`🔴RED / `deleteCityLine`🔴RED / `rebuildGeometry`/`repaint`🟢 / `applyNaming`🟢 / `setLineStatus`🟢 / `regionOf`/`linesByRegion`/`status`/`regions`/`regionKeyOf`/`REGIONS`/`SPECIAL_LINES`⚪ / `placeStations`🟢 / `geocode`🔵 / `log`(内部) / `_copyLine`/`_deepCopy`/`_linesArr`/`_haversineM`/`_distM`/`_snapshots`/`_snapMax`/`_audit`/`_opts`/`_RISK`/`_transferTolM`(内部) / `__version`。

### 10.4 官方接口速查（top.*，已实测）
| 函数 | 说明 |
|---|---|
| `top.deleteLine(id)` | 删除线路 |
| `top.enterStationAddModeOnLine(id)` | 进/退 add-station 模式（传 id 字符串） |
| `top.placeStationInAddModeAtLatLng({lat,lng})` | 放站（需 add-station+`_curvePts`） |
| `top.placeSegmentAnchorInAddModeAtLatLng({lat,lng})` | 放站间节点（需≥2站） |
| `top.startBranchLine(主线,起点站)` | 官方从主线引支线（B 键底层） |
| `top.executePlaceModeStationClick({latlng})` | place 模式放站 |
| `top.onMapRightclick({latlng})` | place 模式加节点（pendingAnchors） |
| `top.completeRingLine(line)` | 环线闭合（isRing=true） |
| `top.confirmCreateLine()` | 完成绘制（固化+退出）；⚠️ 勿用 confirmLine |
| `top.confirmLine()` | 新建线路用（勿用于完成绘制） |
| `top._applyTransferDecision({movedStation,targetStation,kind,primaryLine},true)` | 官方建换乘组（⚠️会拉偏名字/组，换乘坐标独立时禁用） |
| `top._applyAutoPassageTransferBetweenStations(a,b)` | 官方建组不改名（可用） |
| `top._newTransferGroupId()` | 生成换乘组 id |
| `top.getBranchRootLine(line)` | 返回支线组的根（主线） |
| `top.pickLineColor(id,'#hex')` | 官方设色 |
| `top.redrawLine(line)`/`refreshStationDots(line)`/`redrawAllMetroOverlays()` | 官方重绘（勿 location.reload） |
| `top.downloadLocalSave()` | =Ctrl+S 保存存档 |
| `G.map.panTo([lng,lat])`/`setZoomAndCenter(z,[lng,lat])` | 镜头移动（绘制跟随） |
| `setMetroPerformanceMode(true)` | 禁客流重算（防卡死） |
| `line._curvePts` | 吸附曲线点数组（放置前必须写） |
| `line.segmentAnchors` | 段间节点二维数组 |
| `line.pendingAnchors` | 待定节点（confirmCreateLine 固化） |
| `line.branchRootId` | 支线指向主线 id；主线为空 |

### 10.5 MetroOps — 客流运营（注入 `window.MetroOps` v1.3.4，可选）

`hourlyDemand(lineId)`🟢(24h 客流：station.flowByLine[lineId].boardedWindow 1440 分钟聚合) / `recommendSchedule(lineId,opts)`🟢(三档列车数+间隔) / `applySchedule(lineId,rec)`🟡(返回 original) / `restoreSchedule(lineId,original)`🟡 / `readFares()`⚪ / `recommendFares({goal,tiered,ladder})`🟢(官方 fare→demand 弹性；默认温和阶梯 1.05/1.10/1.15/1.20/1.25) / `fareModel(maxFare)`⚪ / `applyFares(rules)`🟡(全网 metro) / `recommendNetwork`🟢(每线排班+快车+短交路建议+全网票价) / `applyExpress(lineId,stops,caps)`🟡(单线快车) / `applyShortTurn(lineId,shortTurn)`🟡(单线小交路) / `applyRevenuePlan`🟡 / `optimizeRevenue`🟡(一键综合) / `revenueSnapshot`/`revenueDelta`⚪ / `flowStatus`⚪(客流加载体检) / `refreshFlow`🟡(重新加载/重绘/重算) / `audit()`⚪。
> **票价（2026-11-10 修正）**：当前版本按整数结算，**小数票价会被截断**（1.2/1.4/1.6/1.8 实测退化），FareLab 1.0.1 起拒绝小数；官方五段 1/2/3/4/5 是当前最优，整数上调 2/3/4/5/6 在早高峰净额腰斩（客流下降）。不要用涨价刷收入；`recommendFares` 的 1.05 阶梯仅作模型参考，不可直接应用。
> **快车/小交路（2026-11-10 实测）**：`OPS.applyExpress` 已给 1/2/9中段/10/12/18 六条线加快车（`expressLines.used=6`，列车 +6）；`OPS.applyShortTurn` 给 2/3/10/12 加小交路（peak 2 / off 0 / low 0），叠加既有 8/1/15/9。18:00–19:00 净额 72.9–77.9 万/小时，零客流 0。快车额度按 `total-used` 计，最多 6 条。
> 排班：`applyRouteLegSlotCount(line,leg,'peak'|'off'|'low','local',n)`；自动模式会覆盖手动值，做确定性优化先关闭 `#line-info-btn-auto`。
> 综合杠杆：票价 + 三档列车数 + 快车（`expressStops/expressCaps`）+ 短交路（`routeLegs` 重叠允许、覆盖必须连续）；配额可用余额购买（`metroQuotaHandlePurchase`）。
> 运营实测手册：`references/operations.md` §8–13（配额购买/快车/交路/阶梯/综合优化器/经营档保存；含上海 3 线经营实战数据）。

### 10.6 高风险操作风险清单（K._RISK 实际键）
RED：`fixTransfers-all`/`deleteLine`/`deleteCityLine`/`densifyAnchors`/`rebuildNodesFromAmap-all`/`fixLine-all`/`placeStations-bulk`。YELLOW：`applyOfficialColors-all`/`addNodes-all`/`applyStationNames-bulk`/`applyNaming-bulk`/`autoTransfers`/`calibrateFromAmap`/`setLineStatus-all`。

---

## §11 高效模式（v3 合并，2026-11-09）

> v3 高效版不再单独存在；其可执行流程合并于此，细节见 `references/efficient-mode.md`。核心：**无数据库（默认不注入 mt-data.js）· MT.queryLine 实时取数 · 聚合执行省 token · 每步返回值必须验证**。

- 实时 `MT.queryLine(city,no,{stationFrom,stationTo})`；环线核对闭合段，端点缺失用 POI+逐段地铁路径，在建线用 `queryUnopenedLine`，不预载本地站库。
- 逐线完成查询→官方创建/延长/支线→配置→放站与节点→命名→换乘→四检；禁止并行绘线。优先 `OE.buildLine`，经营模式不得靠快速导入绕过扣费。
- 聚合查询省输出，不省校验：返回站名差异、颜色、换乘清单、四检 details；节点站台避让≥100m、无空段/绕路/乱序，边界遵守 §0。
- 换乘扫描先核对实际对象、sid、坐标和官方识别结果；共享站可能无 transferGroupId，不凭空值认定缺换乘，不因距离强行移动站台。
- 收尾（失败也做）：`OD.finishEdit`→恢复吸附→局部重绘→核对暂停与客流；默认不开性能模式、不主动存档。详见 `references/efficient-mode.md`，冲突时遵守本文 §0。

---

## §12 全游戏功能覆盖
见 `references/game-features.md`；注入 `scripts/audit-game-features.js` 后 `window.__gameFeatureAudit()` 检查入口与缺失项。已授权的地铁经营购包/交路调整可自动执行；高铁/航空仍只读预留，不虚称写入支持。不代输凭据、不擅自订票/消费真实资金、不修改经济或客流数据；删除和批量改线须确认。
## §13 双地图引擎特调
默认高德数据；AMap 使用 GCJ-02，OSM 用 `MT.toGameCoords` 转 WGS-84。先检查 `MT.dataSourceStatus()`：政策禁止高德渲染时不反复切换，使用合规数据源与 OSM 渲染并说明限制。切引擎后检查 `MT.detectOsmShift`；详细阈值和流程见 `references/map-engines.md`。

---

## 附：v4.2 单技能说明
`city-metro-builder-v3` 已归档；唯一源码为 `scripts/funcs/`，禁注入旧单文件或废弃扩展。使用函数前核对运行时导出；改代码须同步版本、冒烟期望值和实际技能加载入口。

