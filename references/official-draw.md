# 官方绘制详细工作流（city-metro-builder）

本文档是 [SKILL.md](../SKILL.md) 的详细实现参考：完整脚本片段、曲率感知抽稀算法、官方接口封装、易错点。全部为 **2026-08 实测验证**（上海5号线主线15站+支线5站、4号线环线26站）。

---

## 1. 工具箱注入（MT 拆分 5 文件）

```js
const B = '<skill-root>/scripts/funcs';
// 顺序：mt-core → mt-node → mt-amap → od → k
// 宿主注入方式见主文档 §2.4（addScriptTag / Playwright evaluate / CDP /script）
```

> 期望版本：MT **6.0.0** / OD **2.60.0** / K **2.9**。注入后校验 `Object.keys(...)`（见主文档 §10）。

MT 关键函数：
- `MT.queryLine(city, lineNo, {stationFrom, stationTo, maxPerSeg})` → `{stations, nodes, color, trainType, trainCars, warnings, table}`
- `MT.resolveCoord(city, name)` → `{ok, poiName, lng, lat, via}`（单站坐标解析，环线补站用）
- `MT.queryTransferStops(city, from, to, lineFilter)` → 单段 path（注意：频繁调用可能触发页面导航，优先用 `queryLine` 逐段查）

---

## 2. 曲率感知节点抽稀（curvatureThin）

**用途**：把高德查询到的原始 path 节点（每段几十个）压缩为"弯道加密、直线稀疏、大角两侧加过渡节点"的最终节点。

**实测效果**：
- 5号线主线：247 → 63 节点（弯道段 8-10、直线段 2-3）
- 4号线环线：249 → 95 节点

**算法实现**（注入页面后 `window.__curvatureThin`）：

```js
function haversine(a, b) { // a,b = [lng,lat]
  const R = 6371000, dLat = (b[1]-a[1])*Math.PI/180, dLng = (b[0]-a[0])*Math.PI/180;
  const s = Math.sin(dLat/2)**2 + Math.cos(a[1]*Math.PI/180)*Math.cos(b[1]*Math.PI/180)*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.sqrt(s));
}
function localTurn(p0, p1, p2) { // 三点局部转角（度），0=直线
  function ang(a, b) {
    const dLat = b[1]-a[1], dLng = b[0]-a[0];
    let deg = Math.atan2(dLng*Math.cos((a[1]+b[1])/2*Math.PI/180), dLat)*180/Math.PI;
    return (deg+360)%360;
  }
  const h1 = ang(p0, p1), h2 = ang(p1, p2);
  let d = Math.abs(h2-h1); d = d%360; if (d>180) d=360-d;
  return d;
}
// opts: { turnKeepDeg, turnAccDeg, turnSoftDeg, maxGapM, minGapM, tinyGapM, maxPerSeg, flankN }
function curvatureThin(pts, opts) {
  opts = opts || {};
  const turnKeep = opts.turnKeepDeg || 12;   // 单点急弯阈值
  const turnAcc = opts.turnAccDeg || 28;     // 缓弯窗口累计转角阈值
  const turnSoft = opts.turnSoftDeg || 4;    // 参与累计/中弯的最小转角
  const maxGapM = opts.maxGapM || 900;       // 直线段最大间隔
  const minGapM = opts.minGapM || 120;       // 直线段最小间隔
  const tinyGapM = opts.tinyGapM || 15;      // 弯道区极近点合并阈值
  const flankN = opts.flankN || 2;           // 急弯两侧过渡节点数（大角两侧加密）
  if (pts.length < 3) return pts.slice();
  const n = pts.length;
  const turns = new Array(n).fill(0);
  for (let i = 1; i < n-1; i++) turns[i] = localTurn(pts[i-1], pts[i], pts[i+1]);
  const keepMask = new Array(n).fill(false);
  keepMask[0] = true; keepMask[n-1] = true;
  // 1) 单点急弯 + 两侧 flankN 过渡点（大角两侧加额外节点）
  for (let i = 1; i < n-1; i++) {
    if (turns[i] >= turnKeep) {
      for (let k = Math.max(1, i-flankN); k <= Math.min(n-2, i+flankN); k++) keepMask[k] = true;
    }
  }
  // 2) 累计转向窗口：连续小转角累计>turnAcc → 整段缓弯保留（曲率越大越密）
  let wStart = -1, wAcc = 0;
  for (let i = 1; i < n-1; i++) {
    if (turns[i] >= turnSoft) {
      if (wStart < 0) wStart = i;
      wAcc += turns[i];
      if (wAcc >= turnAcc) {
        for (let k = Math.max(1, wStart-flankN); k <= Math.min(n-2, i+flankN); k++) keepMask[k] = true;
        wStart = i; wAcc = 0;
      }
    } else { wStart = -1; wAcc = 0; }
  }
  // 3) 直线段按 maxGapM 补点
  let lastKept = 0;
  for (let i = 1; i < n-1; i++) {
    if (keepMask[i]) { lastKept = i; continue; }
    const d = haversine(pts[lastKept], pts[i]);
    if (d >= maxGapM) {
      if (turns[i] >= turnSoft || d >= maxGapM*1.6) { keepMask[i] = true; lastKept = i; }
    }
  }
  // 4) 组装 + 去重（弯道区只合并 tinyGap，直线区按 minGap）
  const raw = [];
  for (let i = 0; i < n; i++) if (keepMask[i]) raw.push(pts[i]);
  const res = [raw[0]];
  for (let i = 1; i < raw.length; i++) {
    const origD = haversine(raw[i-1], raw[i]);
    const threshold = (origD < 50) ? tinyGapM : minGapM;
    if (haversine(res[res.length-1], raw[i]) >= threshold) res.push(raw[i]);
  }
  if (res[res.length-1] !== raw[raw.length-1]) res.push(raw[raw.length-1]);
  // 5) maxPerSeg 上限（等距抽样）
  if (opts.maxPerSeg && res.length > opts.maxPerSeg) {
    const step = (res.length-1)/(opts.maxPerSeg-1);
    const nr = [];
    for (let i=0;i<opts.maxPerSeg;i++) nr.push(res[Math.round(i*step)]);
    return nr;
  }
  return res;
}
```

**推荐参数**：`{ turnKeepDeg:12, turnAccDeg:28, turnSoftDeg:4, maxGapM:900, minGapM:120, tinyGapM:15, maxPerSeg:10, flankN:2 }`

**使用示例**：
```js
const fitNodes = segs.map(seg => window.__curvatureThin(seg, OPTS));
```

**密度档位（2026-08 新增，`OD.curvatureThin` 支持）**——直接传密度名，自动取档位参数，可覆盖微调：
```js
OD.curvatureThin(segs[0], { density: 'sparse' });           // 稀疏·长段少节点
OD.curvatureThin(segs[0], { density: 'dense' });            // 密集·弯道精细
OD.curvatureThin(segs[0], OD.densityOpts('dense', { minGapM: 80 })); // 取档位再覆盖
// 三档：sparse={devM:8,maxSpacing:800,minGapM:200,curveGapM:120}
//       standard={devM:5,maxSpacing:500,minGapM:120,curveGapM:100}（默认）
//       dense={devM:3,maxSpacing:300,minGapM:60,curveGapM:60}

**自适应密度（tolerance 容错，2026-08-16 新增）**——传容错容差（米），在「误差 ≤ 容错」内用最小节点数拟合（容错越大越疏、越小越密）；站台回避 endPadM 保留：
```js
OD.curvatureThin(segs[0], { tolerance: 5 });                        // 标准容错5m
OD.curvatureThin(segs[0], { tolerance: 3 });                        // 密集3m（弯道精细）
OD.curvatureThin(segs[0], OD.adaptiveDensity(8, { endPadM: 120 })); // 较疏8m+站台回避120m
// 参数：devM=容错；maxSpacing≈tol×100；minGapM≈tol×24；curvePadM≈tol×24；curveGapM≈tol×18；endPadM=100（保留）
MT.queryLine('上海','11', { tolerance: 5 });                        // 整线查询按容错自适应
K.addNodes(id, null, { tolerance: 5 });                             // 兜底补节点按容错
```

---

## 3. 官方绘制完整脚本（普通线）

### 3.1 删除旧线
```js
const r = await page.evaluate(() => {
  (G.lines||[]).filter(l => l.name === '5号线').forEach(l => top.deleteLine(l.id));
  return 'deleted';
});
```

### 3.2 官方 UI 创建
用 `click_element` / `type_in_page` 操作：
1. 点"添加地铁线路"按钮
2. `type_in_page` 线路号（如 "5"）
3. 点车型 A/B/C、点编组 2/4/6/8 节
4. 点"更多配色" → 颜色输入框输入 `#944D9A`（Enter 确认）
5. 点"开始铺设轨道"

创建后获取 id：
```js
const r = await page.evaluate(() => {
  const line = (G.lines||[]).find(l => l.name === '5号线' && (l.stations||[]).length === 0);
  if (line) { window.__LINE_ID = line.id; line.color = '#944D9A'; return { id: line.id }; }
});
```

### 3.3 进入 add-station + 写 _curvePts
```js
const r = await page.evaluate(() => {
  const top = window.top, G = window.G;
  top.enterStationAddModeOnLine(window.__LINE_ID);   // 传 id 字符串
  const line = G.lines.find(l => l.id === window.__LINE_ID);
  line._curvePts = chain.map(p => ({ lng: p.lng, lat: p.lat }));  // 站+节点按序链
  top.redrawLine(line);
});
```

### 3.4 逐站绘制 + 放站同步放节点 + 镜头跟随
```js
const r = await page.evaluate(async () => {
  const top = window.top, G = window.G;
  const stations = window.__STATIONS;   // [{name,lng,lat}]
  const fitNodes = window.__FIT_NODES;  // 每段抽稀节点 [[[lng,lat],...],...]
  for (let i = 0; i < stations.length; i++) {
    G.map.setZoomAndCenter(14, [stations[i].lng, stations[i].lat]); // 镜头跟随
    await new Promise(r => setTimeout(r, 100));
    top.placeStationInAddModeAtLatLng({ lat: stations[i].lat, lng: stations[i].lng });
    await new Promise(r => setTimeout(r, 100));
    if (i > 0) {  // ≥2站才能放节点
      const seg = fitNodes[i-1] || [];
      for (const nd of seg) {
        G.map.setZoomAndCenter(14, nd);  // 镜头跟随节点
        await new Promise(r => setTimeout(r, 30));
        top.placeSegmentAnchorInAddModeAtLatLng({ lat: nd[1], lng: nd[0] });
        await new Promise(r => setTimeout(r, 0));
      }
    }
  }
});
```

### 3.5 重命名站名 + 完成
```js
const r = await page.evaluate(() => {
  const line = G.lines.find(l => l.id === window.__LINE_ID);
  officialNames.forEach((n, i) => { if (line.stations[i]) line.stations[i].name = n; });
  top.redrawLine(line);
  top.refreshStationDots(line);
  top.enterStationAddModeOnLine(line.id);   // 退出 add-station（editMode 已为 add-station）
  top.redrawAllMetroOverlays();
});
```

---

## 4. 支线绘制（官方 B 键 / startBranchLine）

### 4.1 主线画完后再引支线
主线（最长支路）绘制完成后，用官方 `startBranchLine` 从主线上某站引出支线：

```js
const r = await page.evaluate(() => {
  const top = window.top, G = window.G;
  const main = G.lines.find(l => l.id === window.__MAIN_ID);
  const startSt = (main.stations||[]).find(s => s.name === '东川路'); // 支线起点站
  top.startBranchLine(main, startSt);
  // 此时自动创建支线 line：同名同色、branchRootId=主线id、首站=东川路、editMode=place
  const branch = (G.lines||[]).find(l => l.branchRootId === main.id);
  window.__BRANCH_ID = branch.id;
});
```

### 4.2 逐站放置支线（place 模式）
```js
const r = await page.evaluate(async () => {
  const top = window.top, G = window.G;
  const branchStations = window.__BRANCH_STATIONS; // 含起点站之后的站 [{name,lng,lat}]
  for (let i = 1; i < branchStations.length; i++) {  // 起点站已由 startBranchLine 放入
    const st = branchStations[i];
    G.map.setZoomAndCenter(13, [st.lng, st.lat]);   // 镜头跟随
    await new Promise(r => setTimeout(r, 150));
    top.executePlaceModeStationClick({ latlng: { lat: st.lat, lng: st.lng } });
    await new Promise(r => setTimeout(r, 250));
  }
});
```

### 4.3 支线节点
两种方式（推荐方式 B 直接写 segmentAnchors，最稳）：
```js
// 方式 B：直接写 segmentAnchors（与主线同结构），清空 pendingAnchors，重绘
const r = await page.evaluate(() => {
  const line = G.lines.find(l => l.id === window.__BRANCH_ID);
  line.segmentAnchors = fitBranch.map(seg => seg.map(nd => ({ lat: nd[1], lng: nd[0] })));
  line.pendingAnchors = [];
  top.redrawLine(line);
});
```
或方式 A（place 模式官方右键）：
```js
top.onMapRightclick({ latlng: { lat: nd[1], lng: nd[0] } });  // 进 pendingAnchors
```

### 4.4 完成支线（重要：用 confirmCreateLine，勿用 confirmLine）
```js
const r = await page.evaluate(async () => {
  const top = window.top, G = window.G;
  const branch = G.lines.find(l => l.id === window.__BRANCH_ID);
  const lastStation = branch.stations[branch.stations.length-1];
  top.startExtendLine(branch, lastStation);   // 重新进入支线 place 模式（保持站点不动）
  await new Promise(r => setTimeout(r, 300));
  top.confirmCreateLine();   // 固化 + 退出编辑（⚠️ 不是 confirmLine！）
});
```

> ⚠️ **易错点**：`confirmLine` 是"新建线路"的确认函数（读取线路配置面板输入值），支线/普通线完成绘制**必须用 `confirmCreateLine`**。误用 `confirmLine` 会创建空线路并改变 currentLineId。

---

## 5. 环线绘制（首尾闭合）

### 5.1 补全环线数据（高德只回部分站）
1. 完整站名列表（如 4号线 26 站）。
2. 逐站 `MT.resolveCoord('上海', name)` 解析坐标。
3. 逐段 `MT.queryLine('上海','4',{stationFrom:name[i], stationTo:name[i+1], maxPerSeg:200})` 查每段节点（`nodes[0]`）。
4. 个别段高德无数据（如 世纪大道↔浦电路↔蓝村路）时，用两站坐标直线插值补（每段 3 个插值点），或从半圈路径截取。
5. 用 `curvatureThin` 对每段抽稀。

### 5.2 绘制（首站任意）
- 首站选宜山路（或任一站）。
- 绘制顺序与普通线相同（放站→放段节点），**但注意环线闭合段**：
  - 放第 2 站后放第 1 段节点（站1→站2）
  - 放第 26 站（上海体育馆）后放第 25 段节点（站25→站26 即上海体育馆→宜山路）
- 镜头跟随每一步。

### 5.3 闭合
```js
const r = await page.evaluate(() => {
  const line = G.lines.find(l => l.id === window.__LINE_ID);
  top.completeRingLine(line);   // 设 isRing=true，补齐闭合段，提示"环线已形成"
  top.redrawLine(line);
  top.refreshStationDots(line);
  top.enterStationAddModeOnLine(line.id);  // 退出 add-station
  top.redrawAllMetroOverlays();
});
```

---

## 5.5 站点坐标两次查询防错（放置错误逻辑）**用途**：单个坐标源可能解析错位（同名不同地/占位符/POI 混淆），绘制前对每站用两种关键词各查一次坐标并交叉校验，**存疑坐标不放置**。

```js
// 单站：两种关键词（XX地铁站 / XX）各查一次并比对
const r = await page.evaluate(() => window.__officialDraw.resolveCoordTwice('上海', '西藏南路'));
// { ok:true, lng, lat, diffM, via, source }  或
// { ok:false, reason:'coords_disagree', diffM, key1, key2 }   → 存疑，不放置
// { ok:false, reason:'not_found' }                            → 缺失

// 批量：同一函数传数组 → { good, suspicious, missing }，只把 good 用于放置
const rr = await page.evaluate(() => window.__officialDraw.resolveCoordTwice('上海',
  ['宜山路','虹桥路','延安西路']));
```

**判定规则**：
- 两次距离偏差 ≤ 容差(120m) → `ok:true`，取高德/游戏优先结果。
- 偏差 > 容差 → `coords_disagree`，**不进 good，不放置**（避免错位），交人工确认。
- 仅一次成功 → `ok:true` + `warn:'single_source'`（单源，绘制后检查重点核对）。
- 两次失败 → `not_found`，跳过。

---

## 5.6 加密节点逻辑（检查后对弯道/贴合不足段补节点）

**用途**：曲率抽稀后若某段贴合不足（弯道处偏离明显），按曲率补插节点。

```js
// 对整条线按偏离阈值加密（devM=80m，maxPerSeg=10）
const r = await page.evaluate(() => window.__officialDraw.densifyAnchors(window.__LINE_ID, { devM: 80, maxPerSeg: 10 }));
// { added, perSeg }   added=新插入节点数

// 只对某段加密（segIdx 指定段）
const r2 = await page.evaluate(() => window.__officialDraw.densifyAnchors(window.__LINE_ID, { segIdx: 5, devM: 60 }));
```

**逻辑**：遍历该段相邻锚点 A→B，找 `_curvePts` 中与线段 AB 垂直偏离最大的 path 点；若偏离 > `devM` 则插入该点（加密弯角），每段上限 `maxPerSeg`。绘制后检查发现空节点段/贴合不足时调用。

---

## 5.7 换乘自动设置（绘制后自动进行，高德查 + 官方建组）

**用途**：绘制完成并退出添加状态后，自动查询高德换乘数据并为线路所有站建立换乘。

```js
// 一步完成：高德查换乘伙伴 + 游戏内同名扫描 + 官方建换乘组
const r = await page.evaluate(() => window.__officialDraw.autoTransfers(
  window.__LINE_ID, { city: '上海', lineNameMatch: '4号线', kind: 'passage' }));
// { transfers:[{station,partner,kind}], fixed:[...], errors:[...] }
// 幂等：已建立换乘（同 transferGroupId）自动跳过，不会重复
```

**自动换乘流程**（`OD.autoTransfers` 内部）：
1. **高德查换乘伙伴**：对每站 `OD.transferViaAmap(city, 本站, 远端站, 本线名)` —— 用 `AMap.Transfer` 查"本站→环线远端站"换乘方案，提取方案中经过的**非本线地铁线路名**（剔除非地铁如公交 + 剔除本线）。
2. **游戏内找伙伴站**：按线路号**精确匹配**（`/(\d+)号线/` 取线号比较，避免 18号线误配8号线、11号线误配1号线；优先城市前缀如"上海地铁"），再找该线**同名站**（首选）或**邻近站**（<250m）。
3. **官方建换乘组**：`top._applyTransferDecision({movedStation, targetStation, kind, primaryLine}, true)` → 两站 `isTransfer=true`、同名、同 `transferGroupId`。
4. **游戏内同名扫描补充**：高德未命中（环线内站间高德倾向给公交/直达方案，如 世纪大道→延安西路 返回公交946路）时，自动扫描**同城线路同名站**作为补充。
5. **修复异常站**：修复本线内 `isTransfer=true` 但无 `transferGroupId` 的异常站。

**实测**（上海4号线，2026-08）：
- 自动建立 3 个新换乘：曹杨路↔14号线、世纪大道↔2号线、世纪大道↔9号线
- 最终 20 个换乘站全部正确：宜山路↔3/9、中山公园↔2/3、金沙江路↔3/13、曹杨路↔11/3/14、镇坪路↔7/3、上海火车站↔3/1、大连路↔12、浦东大道↔14、世纪大道↔2/9、浦电路↔6、蓝村路↔6、西藏南路↔8、鲁班路↔9、大木桥路↔12、东安路↔7/12、上海体育馆↔1

**自动退出添加状态**：绘制完成后用 `OD.finishEdit(lineId)` 统一完成——
- add-station 模式（普通线/环线）：`enterStationAddModeOnLine` 触发退出分支 → `editMode='select'`
- place 模式（支线）：`confirmCreateLine()` 完成
- 最后 `redrawAllMetroOverlays()` 刷新

---

## 6. 三次检查逻辑（checkLine3x）

**用途**：绘制完成后必须做 3 次检查，全部通过才汇报。

```js
const r = await page.evaluate(() => {
  const OD = window.__officialDraw;
  return OD.checkLine3x(window.__LINE_ID, {
    expectStations: 26,
    expectNames: ['宜山路','虹桥路','延安西路','中山公园','金沙江路','曹杨路','镇坪路','中潭路','上海火车站','宝山路','海伦路','临平路','大连路','杨树浦路','浦东大道','世纪大道','浦电路','蓝村路','塘桥','南浦大桥','西藏南路','鲁班路','大木桥路','东安路','上海体育场','上海体育馆'],
    refCoords: window.__REF_COORDS   // {站名: [lng,lat]} 查询基准坐标
  });
});
// r.pass: true/false; r.problems: string[]; r.check1/check2/check3
```

**三次检查内容**：
1. **check1 结构**：站数=期望、站名=官方站序（无占位符）、`isRing`/`branchRootId`/`pending` 正常、节点总数合理。
2. **check2 坐标**：各站坐标与 `refCoords` 偏差 ≤ `tolM`(150m)，超差报 `mismatches`（含实际/期望坐标与距离）。
3. **check3 视觉/贴合**：`redrawLine` 后检测空节点段（`emptySegs`），配合 `read_page`/`screenshot_page` 肉眼抽查弯道贴合；不足段 `densifyAnchors` 后重查。

**检查严格度（2026-08 可选）**：`opts.strict: 'strict'` 时坐标容差收紧到 **100m**（默认 standard 150m），用于高精度校准；与全局选项 `K.setOpts({ checkStrict: 'strict' })` 对应。

任一检查不通过 → 按 `problems` 逐项修复（重写站名/修正坐标/加密节点）→ **重新跑三次检查**直到 `pass === true`。

---

## 7. 检查清单

```js
const r = await page.evaluate(() => {
  const line = G.lines.find(l => l.id === window.__LINE_ID);
  return {
    name: line.name, color: line.color, isRing: !!line.isRing,
    trainType: line.trainType, trainCars: line.trainCars,
    stationCount: (line.stations||[]).length,
    stationNames: (line.stations||[]).map(s => s.name),
    segAnchors: (line.segmentAnchors||[]).map(s => s ? s.length : 0),
    totalAnchors: (line.segmentAnchors||[]).reduce((a,s)=>a+(s?s.length:0),0),
    pending: (line.pendingAnchors||[]).length
  };
});
```

**检查要点**：
- `stationNames` 与官方站序一致（无占位符 站N / 误命名）
- `totalAnchors` 接近抽稀目标；弯道段多、直线段少
- `isRing===true`（环线）、segCount = 站数（含闭合段）
- 支线 `branchRootId` 指向主线
- `pendingAnchors===0`（已固化）
- `editMode==='select'`（已退出编辑）

---

## 8. 易错点汇总（实测踩坑）

1. **`enterStationAddModeOnLine` 必须传 id 字符串**，传对象会污染 `G.currentLineId`。
2. **放置前必须写 `_curvePts`**（坐标链），否则 `placeStationInAddModeAtLatLng` 静默失败（吸附不到曲线）。
3. **≥2 站才能放节点**：放第 1 段节点需先有 2 站。
4. **放置被拒是正常的**：官方"该位置过于靠近车站"返回 undefined，跳过即可，不中断。
5. **完成绘制用 `confirmCreateLine`**，不是 `confirmLine`（后者是新建线路，误用会建空线）。
6. **支线用 `startBranchLine` 从主线引出**，不要单独建线（单独建线的 branchRootId 结构不完整，且非官方）。
7. **环线高德只回部分站**，必须补全站名列表 + 逐站解析 + 逐段查节点。
8. **曲率抽稀**：原始 path 节点过密（每段几十个），必须抽稀（弯道加密、直线稀疏、大角两侧加过渡节点）。
9. **镜头跟随**：`G.map.setZoomAndCenter(zoom, [lng,lat])` 每步放置前调用，确保可视。
10. **不要 `location.reload()`**：刷新画面一律 `redrawAllMetroOverlays()` / `redrawLine()`。
11. **高德逐段查询用 `queryLine`**（`stationFrom/to` 设为相邻两站），不要用 `queryTransferStops` 频繁调用（会触发页面导航，执行上下文被销毁）。
12. **两次查询防错**：站坐标用两关键词交叉校验，`coords_disagree` 存疑坐标不放置。
13. **三次检查**：绘制后必跑 `checkLine3x`，`pass===false` 时按 `problems` 修复后重跑，直到全过。
14. **POI 搜索在建线有噪音**：返回的"X号线X号口 / X站X号西北口"是**其他线地铁站出入口**，须按"号口"后缀 + 线号校验过滤（`queryLineStopsByPOI` 已内置，实测苏州10号线）。
15. **未开通线节点按数据优先级（用户要求 2026-08）**：未开通线节点依据按优先级：①**高德地铁数据**（`queryLineStopsByPOI` 多关键词 + `resolveCoordTwice` 交叉校验站点/走向，`checkLine3x` 检查4 核对绕路/大折线/混入）→ ②**规划图走向**（用户提供规划图时按「规划图绘制」提取）→ ③**线路连续（小曲率）**（样条平滑保证连续、无突兀大折线）→ ④**直线插值**（高德/规划图均无法确认的段，标注"估算"）。**禁止用导航 path（`transferSearch`/`Driving`/`Walking` 道路段）确定线路位置**（绕行非地铁走向）。
16. **跨城规划线用公交反查**：高德专题/POI 无跨城规划线（如苏锡快线）站点时，`transferSearch` 常返回**替代公交线**（如"苏锡公交1号线"），其站点序列可作中间站参考；两端用已有线路终点坐标锚定。
17. **节点密度档位**：`curvatureThin`/`fitSegmentNodes`/`addNodes` 支持 `density`（sparse/standard/dense），用 `OD.densityOpts` 取参数可覆盖微调。
18. **未知线路用网络多平台查询 + 地图校验（强制）**：高德无数据的线路（跨城规划/远期规划），用 `fetch_webpage` 抓百度百科/维基/政府公示/新闻**多平台交叉**取站名/站序/走向/色；**每个站必须经地图校验**（`resolveCoordTwice` 城市范围内、POI 地铁站、多次一致）才可用；定位不到 → 标注"估算"（相邻已确认站插值），定位错配 → 剔除。汇报注明数据源与估算站。
19. **高德 path 可能绕路/数据混入（1号线实测）**：`transferSearch` 对市中心短段可能返回**绕行路线**（非地铁实际走线）——如苏州1号线 桐泾北路→广济南路 直线954m 但高德 path 折线7543m（7.9倍）。**检测**：逐段算 `折线/直线`，>2.2 判定混入；**修复**：绕路段改**直线插值**（市中心直线段贴合实际走向）或重查收紧，修复后重查。
20. **每线完成后询问用户是否有误（用户要求，强制）**：单线/批量绘制每条完成后必须 询问工具询问"这条线是否有误？"，按反馈适配修正（站名/坐标/节点/绕路），确认无误才进入下一条，不静默跳过。
21. **调整线路位置先删全部节点再重绘（用户要求，强制）**：调整线路位置/节点走向时，**先删除该线全部节点**（`segmentAnchors` 置空 + `pendingAnchors` 置空 + `rebuildGeometry`），**不得在旧节点上叠加/部分覆盖**，再按新数据整体重新生成节点并重绘，重跑 `checkLine3x` 确认。
21. **查询车站注意编号配对（高优先级，1号线实测）**：自动命名会产生占位编号（`站316`/`站313`/`惹云桥`）与实际站名错配——查询/绘制后必须**按官方站序替换为真实站名**；POI 返回须属于目标线路编号（过滤"X号口"出入口、跨线同名站）；站序与官方（列车运行方向）不一致需重排。校验在每次查询后、绘制前必做（高优先级）。
22. **数据无法获取必询问（用户要求，强制）**：当某线路/区段数据无法获取（高德地铁数据无、规划图无、多次搜索失败）时，**必须用 询问工具询问用户如何处理**（①直线插值标注估算 ②用规划图 ③用户提供数据 ④跳过该段 ⑤终止），**不得未询问自行插值/估算/决定走向**。
23. **线路命名必问（用户要求，强制）**：**每次绘制/重绘前必须用 询问工具询问线路命名方式**（`cn_metro`/`cn_rail`/`cn_rail2`/`metro`/`plain`/自定义/不重命名），**未询问不得默认命名**；指令明确或 `K.setOpts({ namingRule })` 已记忆时跳过。

