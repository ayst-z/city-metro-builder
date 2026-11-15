# beta1.3.1 发行验收清单（beta2 自检工具，2026-11-15，v4.4.1 已发布）

> 命名说明：**发行版本号是 beta1.3.1**；本文文件名、`scripts/beta2-selfcheck.js`、`__beta2SelfCheck*` API 沿用 beta2 命名，属技术套件名，**不代表发行版本**，两者不可混用。

> 本文只记录**已实际执行**的证据；没有跑过的层，明确标为「待实机」，不写 PASS。
>
> **本轮状态**：层 1 离线回归 7/7；本地构建层（check-sync 0 drift → build-release → privacy 0 命中）已通过；层 2/3/4/5 尚待实机。**beta1.3.1 已于 2026-11-15 公开发布**；层 2/3/4/5 仍未实机验证，发布不改变该门禁缺口；不覆盖 beta1.2 的已发布历史与 hash 证据；此前未发布的 beta2 本地 zip 仅为本过程历史中间件。

## 0. 验收分层

| 层 | 内容 | 入口 | 通过标准 |
|---|---|---|---|
| 1 离线回归 | 静态一致性 + VM 冒烟 + 规划图/POI/托管/支线环线 | `node _dev/run-all.mjs`（7 组一键入口，逐项 PASS/FAIL + 汇总） | 7/7 PASS，fail=0，退出码 0 |
| 2 页面只读自检 | 引擎/票价/排班/快车/额度/客流/营收/换乘组/节点/入口/函数 | 注入 `scripts/beta2-selfcheck.js` → `__beta2SelfCheck()` | fail=0 |
| 3 页面实机往返 | 记录暂停/速度 → 暂停 → 排班往返/票价幂等 → **只读**换乘审计 → `finally` 恢复 | `__beta2SelfCheck({ live: true })` | `livePass=true`，且 `scheduleRestored` / `fareSame` / `stateRestored` / `transferAudit.unchanged` 均为真、`restoreErrors` 为空 |
| 4 UI 入口 | 示意图开/关、运营日报开/关 | `openMetroDiagramView()`/`closeMetroDiagramView()`；`#nav-btn-flow-dashboard`→`closeFlowDashboardPanel()` | 开可见、关后不可见 |
| 5 绘线实机 | 建线→站→节点→命名→换乘→支线→环线→四检→删除/重建 | 需**创意档或无额度压力档**（经营档建线扣额度） | 每步返回值校验 + `OD.inspect` 0 问题 |

**live 的定义（本轮口径）**：不是「跑一遍写接口就算过」，而是在暂停的安全窗口里做可逆往返：排班往返、票价幂等；**换乘只做只读审计/前后对比，绝不调用 `fixTransfers` / `separateTransferStations` / `applyTransfer` 等写接口**；无论成功或异常，都在 `finally` 恢复原暂停状态与模拟速度，并报告恢复证据。该实现正在做离线验证，**本轮尚未实机复跑，因此不记录 livePass 实测值**。

## 1. 运行方法

### 1.0 前置

- 游戏 [Cities Designers](https://www.citiesdesigners.com) 已进入城市；**模式/存档由用户自己选**，AI 不代点。
- 能访问页面：浏览器控制台、CDP `Runtime.evaluate`，或完整仓库 `browser/cdp.mjs` 提供的控制服务（`<cdp-host>:<port>`）。发行 zip 只含技能目录，**不含** `browser/cdp.mjs`；没有兼容桥时按 `SKILL.md` §2.4 手动注入。
- 离线层不需要游戏、账号或存档写入。

### 1.1 层 1：离线回归（技能根目录）

```powershell
cd skills/city-metro-builder
node _dev/run-all.mjs
```

`run-all.mjs` 顺序运行 lint-static / smoke / test-plan-map.py / test-plan-poi / test-plan-draw / test-autopilot / test-branch-ring，逐项 PASS/FAIL + 汇总；任一组失败、超时或无法启动时非 0 退出。单组默认超时 180s（`--timeout <ms>` 或 `RUN_ALL_TIMEOUT_MS` 覆盖），Python 按 `RUN_ALL_PYTHON` → `python` → `python3` → `py -3` 探测。

排障时单独运行：

```powershell
node _dev/lint-static.js
node _dev/smoke.js
python _dev/test-plan-map.py          # 需要 OpenCV
node _dev/test-plan-poi.js
node --test _dev/test-plan-draw.js    # node:test 运行器
node _dev/test-autopilot.js
node _dev/test-branch-ring.js
```

### 1.2 层 2/3：页面自检与实机往返

```js
// 注入 scripts/beta2-selfcheck.js 后（CDP POST /script）
await window.__beta2SelfCheck();                 // 只读 19 项
await window.__beta2SelfCheck({ live: true });   // 实机往返：暂停→快照→往返→只读换乘审计→恢复
window.__beta2SelfCheckText();                   // 人类可读报告文本（只读）
window.__beta2SelfCheckText({ live: true });     // 人类可读报告文本（实机）
window.__beta2SelfCheckReport(result);           // 对已有结果做格式化
```

报告文本会列出通过/失败/跳过、`livePass`、暂停/速度恢复、换乘审计前后对比与关键失败详情；空结果不会被当作「PASS 0 项」。

## 2. 实测记录

### 2.1 本轮（2026-11-15，v4.4.1 / beta1.3.1 已发布）

环境：仓库工作区；Node v24.19.0；Python 3.14.7；离线层不触碰游戏、账号、存档或资金。

| 项 | 实际结果 |
|---|---|
| `node _dev/run-all.mjs` | **7/7 PASS · 0 FAIL · 退出码 0 · 总用时 2.5s**（lint-static / smoke / test-plan-map / test-plan-poi / test-plan-draw / test-autopilot / test-branch-ring） |
| lint-static | PASS：OD export keys=73 / K=91 / MT assigned=84，unresolved=0 |
| smoke | PASS：13 文件；OD 2.60.3 / K 2.9 / OE 1.1.8 / FL 1.0.1 |
| test-plan-map | 10/10 |
| test-plan-poi | 17/17 |
| test-plan-draw | 45/45 |
| test-autopilot | 12/12 |
| test-branch-ring | 3/3 |
| 同步/版本预检 | `node tools/check-sync.mjs --pre-build` **PASS / 0 drift**（安装副本 44/44 应同步文件 sha256 一致；`release.json` v4.4.1/**beta1.3.1** = SKILL 版本行 = GUIDE 版本行；发行素材 10/10）。构建前置预检走默认严格模式，未用 `--skip-install-check` |
| 发行构建 | `node tools/build-release.mjs` 退出码 0：`release/.build/oss` 52 文件 / `repo` 53 文件；构建前 `release/city-metro-builder-beta1.3.1-clean.zip` 不存在，未覆盖、未加 `--force`，beta1.2 zip 与 hash 未触碰；zip 体积与 sha256 见仓库 README（包内不写自引用数字）。未发布的 `city-metro-builder-beta2-oss.zip` 保留为本过程历史中间件，**非正式版、不对外发布** |
| 隐私审核 | `node tools/privacy-audit.mjs` **PRIVACY PASS — 105 文件（oss/repo 2 变体）0 命中**，退出码 0 |
| zip 内容核对 | 解包逐文件 sha256 与真源/`.build/oss` 一致（文件集无缺、无多、无内容差异）；含 13 模块注入器 `scripts/inject-toolbox.js`、自检 `scripts/beta2-selfcheck.js`、7 组回归入口 `_dev/run-all.mjs`；无 `__pycache__`、旧版 `SKILL.pre_rearch.md`/`SKILL.bak_*`、临时/备份文件残留 |
| 实机层 2/3/4/5 | **待实机**（本文不写 PASS；需按 §1.2/§4 逐层复跑） |

> 说明：本轮离线修复（一次性注入依赖顺序、统一 7 组入口、自检文本报告、live 只读化与恢复、同步守卫、zip 防覆盖）已在各自离线测试/临时 fixture 中验证；本文只把可复现的层 1 与本地构建结果列为发版证据，其余按层 2-5 待验证记录。
>
> 版本号调整（2026-11-15，用户要求）：发布前对外版本号由 beta2 调整为 **beta1.3.1**（随后 2026-11-15 发布），`skillVersion` 仍 4.4；**技术内部命名与 API 保持兼容不变**（`scripts/beta2-selfcheck.js`、`__beta2SelfCheck()/__beta2SelfCheckText()/__beta2SelfCheckReport()`、`references/beta2-acceptance.md`），避免既有页面注入脚本与调用方失效。
>
> zip 的 sha256/size **不写进包内**：本文随包发布，写进哈希会改变 zip 自身内容、形成自引用。实际 hash/size 记录在仓库根 `README.md` 与 `release/.build/post-build-evidence-beta1.3.txt`（`.build` 不入库）。

### 2.2 历史证据（2026-11-14，旧 live 实现，仅留档）

> 以下为 2026-11-14 的历史记录（当时内部候选称 beta2，本轮对外版本号已改为 beta1.3.1）。当时的 live 实现包含写操作、且未强制状态恢复；其中 `livePass=true` **只属于旧实现的历史结果，本轮不复用、不作为发版门禁证据**。

环境：上海经营档 24 线 / 647 站，高德引擎，余额约 428 万；配额 km 673.94/680、stations 646/646、cars 1227/1230、express 0/6。

| 项 | 历史结果 |
|---|---|
| 页面只读自检 | 19/19（票价官方五段 1/2/3/4/5、族群五段规则 active、排班 2 交路可读、客流零站 0、换乘组 83、空节点段 0） |
| 脚本化复跑（旧 live） | `__beta2SelfCheck()` pass=19 fail=0；`__beta2SelfCheck({live:true})` 当时报 livePass=true（旧实现，含写操作；仅留档） |
| 额度模型源码核对 | `metroQuotaLineInputRaw`：建线 stationCount=该线站数（换乘不减免）、km=calcLinKm；`metro.line.commit` 额度不足整体失败（原子）；删站 `metro.station.delete.commit` 返还额度；价格随已购量递增（本档车站包 $5,177,298、里程包 $1,519,750），预算必须用 `metroPurchaseQuote` 实时报价 |
| 换乘坐标脚本化 | `__transferCoordAudit()` 24 线；问题仅 1 条：苏州11号线·唯亭（终到站 out_of_path，无相邻两站不做局部回退，保留坐标并标注）；`__separateSharedStations()` 共享对象 8→0；`__transferCoordFix({city:'苏州'})` 后 25 组长通道置 `transferSpatiallyUnlinked`；全部线路站数/换乘数不变、`OD.inspect` 0 问题 |
| UI 入口 | 示意图 `#screen-metro-diagram` 开→`closeMetroDiagramView()` 关；运营日报 `#panel-flow-dashboard` 开→`closeFlowDashboardPanel()` 关 |

## 3. 已知缺口（beta1.3.1 发布前必须关闭）

1. **层 2/3 实机复跑**：页面只读 19 项与新的 live 只读往返（含状态恢复）需在真实页面执行并保存报告文本；本轮未做。
2. **层 4 UI 实机**：示意图/日报开关以本轮构建复验。
3. **层 5 绘线实机**：经营档 quota 用尽，建线会扣费/失败 → 需创意档（`anycity-global_mode_creative` 草稿）跑一次建线→支线→环线→删除，记录每步返回与 `OD.inspect`。
4. **终到站 out_of_path**：苏州11号线·唯亭（与3号线换乘）为线路端点，无相邻两站、局部 path 回退不适用；需用户确认该站独立坐标（POI/图纸）或保留现有共享点。
5. **额度购买实机**：涉及资金（车站包报价 517 万），需用户授权或小额包+快照回滚验证报价/扣款/used 变化。
6. **HSR/航空**：不在「地铁功能」范围，维持 `references/operations.md` 预留说明，不作 beta1.3.1 门禁。
7. **发行**：beta1.3.1 已公开发布：本地构建与隐私审核已完成，公开库 main + annotated tag 与 Release 资产已上传；层 2–5 实机缺口仍待补测。未发布的 beta2 本地 zip 已作为历史中间件保留，不再作为候选。

## 4. beta1.3.1 发版门禁

- [x] 层1 全绿：`node _dev/run-all.mjs` **7/7**（2026-11-15 实跑，退出码 0）
- [ ] 层2 `__beta2SelfCheck()` fail=0（待实机）
- [ ] 层3 `__beta2SelfCheck({live:true})` `livePass=true`，`stateRestored`/`pausedRestored` 为真、`transferAudit.unchanged=true`、`restoreErrors` 为空（待实机；当前只读+恢复实现待复跑）
- [ ] 层4 示意图/日报 开→关 均正常（待实机）
- [ ] 层5 创意档绘线验收通过（建线/支线/环线/删除各 1 次 + inspect 0；待实机）
- [x] 版本与文档同步：`release/release.json` tag=**beta1.3.1** / skillVersion=4.4 / zip=`city-metro-builder-beta1.3.1-clean.zip`，SKILL 版本行与 GUIDE 版本行一致（check-sync 预检）
- [x] `node tools/build-release.mjs` 通过（退出码 0，oss 52 / repo 53 文件）；`node tools/privacy-audit.mjs` 0 命中（105 文件）；beta1.2 zip 与 sha256 未改动
- [x] 公开库 main + annotated tag beta1.3.1；Release 资产上传（2026-11-15 已发布；beta2 仅是过程中间件，不发布）

## 5. 记录纪律

- 每次实机验收把新增证据追加到 §2，写日期/环境/结果/差异；没跑就写「待实机」。
- 发现与文档不符的 API，先改文档/封装，再把该检查项加入 `scripts/beta2-selfcheck.js`，防回归。
- 历史证据只增不改；旧实现的结果必须标注实现版本与「仅留档」，不得挪作本轮 PASS。
