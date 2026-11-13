/**
 * K 批量管理工具箱（3.0 完整版）
 * =====================================================================
 * 注入: window.CityMetroKit（K）
 * 职责: 批量管理游戏内地铁线路（查询/新增/删除/修复/换乘/命名/分类/节点重建）
 * 依赖: MT（window.__metroToolkit：getLines/haversine/adaptiveDensity/curvatureThin 等权威实现）
 * 加载顺序: 必须在 MT / OD 之后注入
 * 来源: 迁移自 debug.md 末尾 v2 K 完整源码（零遗漏基线），版本守卫 2.9（2026-09-06 补入 active core 快照/审计/回滚 + 风险确认 UI）。
 * 结构: 单对象字面量（方法用 this 互调 74 处，保持单文件，不拆分——与 OD 同理，
 *       拆分多文件会破坏 this 绑定需重写，非高效）。内部按 13 组分区（见各 ==== 注释）。
 * 公开方法（K 批量管理）:
 *   查询: getLines / getLine / findCityLine
 *   站点/节点: placeStations / addNodes / rebuildGeometry / calibrateCoordinates
 *   命名/配色: configureLine / applyOfficialColors / applyStationNames / applyNaming
 *   修复: fixLine / fixTransfers / separateTransferStations
 *   换乘: applyTransfer
 *   删除: deleteLine / deleteCityLine
 *   状态/分类: setLineStatus / regionOf / regionKeyOf / linesByRegion / status / regions / REGIONS / SPECIAL_LINES
 *   绘制: repaint
 *   选项/风险: opt / setOpts / resetOpts / riskLevel / riskDesc / confirmDangerous / allowDangerous / resetDangerous
 *   内部: _distM / _haversineM
 *   (注: rebuildNodesFromAmap / autoTransfers / queryLinePaths 属 OD，K 经 OD 复用不重复实现)
 * 幂等: 可反复注入（版本守卫 2.7）。
 */

(function () {
  if (window.CityMetroKit && window.CityMetroKit.__version === '2.9') return; // 版本守卫：已有同版本则跳过，旧版/无版本可覆盖注入

  window.CityMetroKit = {
    __version: '2.9',
    _transferTolM: 150,   // 严格检查换乘站：同名站坐标差≤150m 才算真换乘（2026-08-16）
    // ========================================================================
    // 0. 全局选项管理（用户可选的配置项，2026-08 新增）
    // ========================================================================
    // 默认选项：
    //   density   节点密度档：'sparse'|'standard'|'dense'（默认 standard）
    //   dataSource 数据源：'srhdata'|'game'|'auto'（默认 auto，自动按优先级）
    //   drawMode  绘制方式：'official'|'batch'（官方逐步/一次性绘制）
    //   autoTransfers 绘制后是否自动修复换乘（默认 true）
    //   autoSave  完成后是否自动保存存档（默认 false，agent 决定）
    //   checkStrict 检查严格度：'standard'|'strict'（默认 standard；strict 坐标容差更小）
    //   namingRule 命名规则：'cn_metro'|'cn_rail'|'cn_rail2'|'metro'|'plain'|'line'|'en'|模板
    //   deleteOld  绘制前是否删除同名旧线（默认 true）
    //   endPadM    站台避让半径（默认 100，dense 80 / sparse 120）
    _opts: {
      density: 'standard',
      dataSource: 'auto',
      drawMode: 'official',
      autoTransfers: true,
      autoSave: false,
      checkStrict: 'standard',
      namingRule: 'cn_metro',
      deleteOld: true,
      endPadM: 100
    },

    // ========================================================================
    // 0.5 高风险操作风险分类 + 拦截组件（2026-08-16 用户要求：高风险操作停止并询问）
    // ========================================================================
    // 风险分级：
    //   RED   = 可能导致存档损坏/不可逆破坏（必须停止并询问，未确认绝不执行）
    //   YELLOW= 可能造成大范围/连锁影响（先询问确认，确认后才执行）
    //   GREEN = 常规操作（正常执行，但遵循既有"每线必询问"原则）
    // 本分类基于实测教训：
    //   - fixTransfers 全库执行曾因换乘站共享对象引用把全城730站错误并入同一换乘组（存档严重污染）
    //   - densifyAnchors 对 _curvePts 未按段填充的线路会误插全 path 导致节点间距爆炸（48km）
    //   - 全量 redrawAllMetroOverlays/repaint 大存档会卡死/重载
    _RISK: {
      // —— RED：不可逆/易污染存档 ——
      'fixTransfers-all': { level: 'RED', desc: '全库修复换乘（不带 filter），曾致全城换乘组污染', guard: true },
      'deleteLine':       { level: 'RED', desc: '删除线路（不可逆，删后需重画）', guard: true },
      'deleteCityLine':   { level: 'RED', desc: '按城市删除线路（批量删，不可逆）', guard: true },
      'densifyAnchors':   { level: 'RED', desc: '曲率加密节点（_curvePts 未按段填充时节点爆炸）', guard: true },
      'rebuildNodesFromAmap-all': { level: 'RED', desc: '批量重建全部线路节点（大范围覆盖节点，需先确认）', guard: true },
      'fixLine-all':      { level: 'RED', desc: '批量修复全部线路（大范围改动）', guard: true },
      'placeStations-bulk': { level: 'RED', desc: '批量放置站点（覆盖 stations）', guard: true },
      'fastDraw-overwrite':{ level: 'RED', desc: 'fastDraw 覆盖已绘制线路（清空原站/节点重画，不可逆）', guard: true },
      // —— YELLOW：大范围/连锁影响 ——
      'applyOfficialColors-all': { level: 'YELLOW', desc: '批量应用官方配色（影响全部线路外观）', guard: false },
      'addNodes-all':     { level: 'YELLOW', desc: '批量补节点（全部线路，可能触发大量重绘）', guard: false },
      'applyStationNames-bulk': { level: 'YELLOW', desc: '批量改站名（可能影响换乘匹配）', guard: false },
      'applyNaming-bulk': { level: 'YELLOW', desc: '批量重命名线路（影响地区识别/换乘匹配）', guard: false },
      'autoTransfers':    { level: 'YELLOW', desc: '自动修复换乘（高德查询+建组，跨线影响）', guard: false },
      'calibrateFromAmap':{ level: 'YELLOW', desc: '用高德校准线路坐标（移动站台位置）', guard: false },
      'setLineStatus-all':{ level: 'YELLOW', desc: '批量设置分类（影响筛选视图）', guard: false },
      'autoTransfersBulk':{ level: 'YELLOW', desc: '批量合并换乘核对（一次扫描为多线建换乘，跨线影响）', guard: false },
      'drawNodes':        { level: 'YELLOW', desc: '覆盖线路节点（segmentAnchors）', guard: false },
      'separateTransferStations': { level: 'YELLOW', desc: '分离跨线共享换乘站（改动共享站对象引用）', guard: false },
      // —— GREEN：常规 ——
      'drawLine':         { level: 'GREEN', desc: '一次性绘制线路（遵循每线必询问）' },
      'applyStationNames':{ level: 'GREEN', desc: '单条改站名（遵循每线必询问）' },
      'applyOfficialColors': { level: 'GREEN', desc: '单条配色' },
      'addNodes':         { level: 'GREEN', desc: '单条补节点' },
      'fixLine':          { level: 'GREEN', desc: '单条修复线路' },
      'rebuildNodesFromAmap': { level: 'GREEN', desc: '单条重建节点' }
    },

    /** 查询某个操作的风险等级 */
    riskLevel(op) {
      const r = this._RISK[op];
      return r ? r.level : 'GREEN';
    },
    /** 查询某个操作的风险描述 */
    riskDesc(op) {
      const r = this._RISK[op];
      return r ? r.desc : '';
    },

    /** 高风险操作拦截：在 RED/YELLOW 操作执行前调用。
     *  通过 window.__DANGEROUS_CONFIRM 交互桥与 agent 会话通信——
     *  agent 侧在调用高危操作前，必须先用 vscode_askQuestions 询问用户确认，
     *  确认后设置 window.__DANGEROUS_CONFIRM[op]=true 再放行。
     *  若未确认（undefined/false），返回 { blocked:true, risk, message } 并停止执行。
     *  @param {string} op 操作键（见 _RISK）
     *  @param {Object} [ctx] 附加上下文（如线路名/城市）
     *  @returns {{blocked:boolean, level?:string, message?:string, confirmed?:boolean}} */
    confirmDangerous(op, ctx) {
      const risk = this._RISK[op];
      if (!risk || risk.level === 'GREEN') return { blocked: false, level: risk ? risk.level : 'GREEN' };
      // 读取交互桥（agent 侧已询问用户确认）
      let confirmed = false;
      try { const bridge = window.__DANGEROUS_CONFIRM || {}; confirmed = bridge[op] === true; } catch (e) {}
      if (confirmed) return { blocked: false, level: risk.level, confirmed: true };
      // 未确认 → 拦截并停止
      const msg = '【高风险操作拦截】' + (op) + '：' + (risk.desc || '') +
        '（风险等级：' + risk.level + '）。此操作可能导致存档损坏/不可逆破坏，已停止。' +
        (ctx ? ' 上下文：' + JSON.stringify(ctx) : '') + '。请确认后设置 window.__DANGEROUS_CONFIRM["' + op + '"]=true 再重试。';
      return { blocked: true, level: risk.level, message: msg };
    },

    /** 由 agent 在询问用户确认后调用：放行某个高风险操作（写入交互桥） */
    allowDangerous(op) {
      try {
        if (!window.__DANGEROUS_CONFIRM) window.__DANGEROUS_CONFIRM = {};
        window.__DANGEROUS_CONFIRM[op] = true;
      } catch (e) {}
      return true;
    },

    /** 重置所有高风险放行标记（新会话/新任务开始时调用，防误放行） */
    resetDangerous() {
      try { window.__DANGEROUS_CONFIRM = {}; } catch (e) {}
      return true;
    },

    

    // ========================================================================
    // 0.6 快照 / 审计 / 回滚 + 风险确认 UI（2026-09-06 用户要求，自 active core-v2.11 补齐到 v3）
    // ========================================================================
    riskRisks(op) { const r = this._RISK[op]; return (r && r.risks) || []; },

    showRiskDialog(op, ctx) {
      const risk = this._RISK[op];
      if (!risk || risk.level === 'GREEN') return Promise.resolve(true);
      return new Promise(function (resolve) {
        try {
          const rid = 'metroRiskDialog_' + Date.now() + '_' + Math.floor(Math.random() * 1e4);
          let settled = false;
          function finish(val) {
            if (settled) return; settled = true;
            try { const el = document.getElementById(rid); if (el) el.remove(); } catch (e) {}
            resolve(val);
          }
          const ov = document.createElement('div');
          ov.id = rid;
          ov.style.cssText = 'position:fixed;inset:0;z-index:2147483600;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;font-family:"Noto Sans SC","Microsoft YaHei",sans-serif;';
          const card = document.createElement('div');
          const lvlColor = risk.level === 'RED' ? '#e02424' : '#e6a800';
          const lvlTxt = risk.level === 'RED' ? '🔴 高风险' : '🟡 中等风险';
          const risksHtml = (risk.risks || []).map(function (r) { return '<li style="margin:4px 0;line-height:1.55">' + String(r) + '</li>'; }).join('');
          card.style.cssText = 'background:rgba(15,23,42,.97);border:1px solid #334155;border-radius:14px;padding:20px 22px;max-width:500px;width:92%;color:#e2e8f0;box-shadow:0 8px 40px rgba(0,0,0,.55);';
          card.innerHTML =
            '<div style="font-size:18px;font-weight:700;margin-bottom:10px"><span style="color:' + lvlColor + '">' + lvlTxt + '</span> &nbsp;<span style="font-size:13px;color:#94a3b8;font-weight:400">' + op + '</span></div>' +
            '<div style="color:#f8fafc;font-size:14px;margin-bottom:10px">' + String(risk.desc || op) + '</div>' +
            (ctx ? '<div style="font-size:12px;color:#94a3b8;margin-bottom:10px">影响对象：' + String(ctx.label || (JSON.stringify(ctx) || '')).slice(0, 300) + '</div>' : '') +
            '<div style="font-size:13px;font-weight:600;color:#fca5a5;margin-bottom:4px">⚠️ 可能风险：</div>' +
            '<ul style="margin:0 0 6px 0;padding-left:18px;font-size:13px;color:#fcd34d">' + (risksHtml || '<li>未列明</li>') + '</ul>' +
            '<div style="font-size:12px;color:#64748b;margin-top:10px">确认后仅本次放行；点「取消」将拦截并停止，不改动存档。</div>';
          const btns = document.createElement('div');
          btns.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;margin-top:14px;';
          const cancel = document.createElement('button'); cancel.textContent = '✕ 取消';
          cancel.style.cssText = 'background:#334155;color:#e2e8f0;border:none;border-radius:8px;padding:9px 18px;cursor:pointer;';
          const ok = document.createElement('button'); ok.textContent = '确认继续';
          ok.style.cssText = 'background:' + lvlColor + ';color:#fff;border:none;border-radius:8px;padding:9px 18px;cursor:pointer;font-weight:600;';
          cancel.onclick = function () { finish(false); };
          ok.onclick = function () { try { if (!window.__DANGEROUS_CONFIRM) window.__DANGEROUS_CONFIRM = {}; window.__DANGEROUS_CONFIRM[op] = true; } catch (e) {} finish(true); };
          btns.appendChild(cancel); btns.appendChild(ok); card.appendChild(btns); ov.appendChild(card);
          document.body.appendChild(ov);
          setTimeout(function () { finish(false); }, 180000);
        } catch (e) { resolve(false); }
      });
    },

    async confirmRisk(op, ctx) {
      const risk = this._RISK[op];
      if (!risk || risk.level === 'GREEN') return { ok: true, level: 'GREEN' };
      try { if (window.__DANGEROUS_CONFIRM && window.__DANGEROUS_CONFIRM[op] === true) return { ok: true, level: risk.level, confirmed: true }; } catch (e) {}
      const ok = await this.showRiskDialog(op, ctx || {});
      return { ok, level: risk.level, message: ok ? undefined : ('未确认（' + op + '），已拦截，未改动存档。') };
    },

    _snapshots: [],
    _audit: [],
    _snapMax: 40,
    _linesArr() {
      if (typeof G === 'undefined' || !G) return [];
      return Array.isArray(G.lines) ? G.lines : (G.lines ? Object.values(G.lines) : []);
    },
    _deepCopy(v) {
      try { const j = JSON.stringify(v); if (j != null) return JSON.parse(j); } catch (e) {}
      // ⚠️ JSON 失败（存在循环引用/函数等不可序列化字段）时回退「白名单手工拷贝」——只保留可持久化字段，
      //    足够完整还原 站/节点/换乘/属性，绝不静默返回 null（否则 rollback 会把 G.lines 清空，2026-09-06 实测事故）
      if (Array.isArray(v)) return v.map((x) => this._copyLine(x)).filter(Boolean);
      if (v && typeof v === 'object' && v.id != null) return this._copyLine(v);
      return null;
    },
    _copyLine(l) {
      if (!l) return null;
      const cp = { id: l.id, name: l.name, nameEn: l.nameEn, color: l.color, isRing: !!l.isRing, branchRootId: l.branchRootId || null, trainType: l.trainType, trainCars: l.trainCars, maxSpeedKmh: l.maxSpeedKmh, status: l.status, _category: l._category, _lineNameCustomizedByUser: !!l._lineNameCustomizedByUser };
      cp.stations = (l.stations || []).map((s2) => {
        const c = { name: s2.name, idx: s2.idx, isTransfer: !!s2.isTransfer };
        if (s2.nameEn != null) c.nameEn = s2.nameEn;
        if (s2.sid != null) c.sid = s2.sid;
        if (s2.transferGroupId) c.transferGroupId = s2.transferGroupId;
        if (s2.transferType) c.transferType = s2.transferType;
        if (s2.transferSpatiallyUnlinked) c.transferSpatiallyUnlinked = true;
        if (s2.latlng) c.latlng = { lat: s2.latlng.lat, lng: s2.latlng.lng };
        if (s2.latlngWgs) c.latlngWgs = { lat: s2.latlngWgs.lat, lng: s2.latlngWgs.lng };
        return c;
      });
      cp.segmentAnchors = (l.segmentAnchors || []).map((seg) => (seg || []).map((n) => ({ lat: n.lat, lng: n.lng })));
      cp.pendingAnchors = (l.pendingAnchors || []).map((n) => ({ lat: n.lat, lng: n.lng }));
      // 2026-09-06 深审：保留任意其余「可序列化自有字段」（用户自定义数据/附加属性等），
      //    确保 JSON 失败回退白名单路径也不丢用户数据；循环/函数字段（如缓存 _curvePts）跳过（回滚后会重建）
      const CORE = ['id','name','nameEn','color','isRing','branchRootId','trainType','trainCars','maxSpeedKmh','status','_category','_lineNameCustomizedByUser','stations','segmentAnchors','pendingAnchors'];
      Object.keys(l).forEach((k) => {
        if (CORE.indexOf(k) >= 0) return;
        const v = l[k];
        if (typeof v === 'function' || v == null) return;
        try { cp[k] = JSON.parse(JSON.stringify(v)); } catch (e) { /* 循环引用/不可序列化：跳过（缓存类回滚后清空重建） */ }
      });
      return cp;
    },
    snapshot(label) {
      const lines = this._linesArr();
      const snap = {
        id: 'SN_' + Date.now() + '_' + Math.floor(Math.random() * 1e4),
        t: Date.now(), label: label || 'snapshot',
        lineCount: lines.length,
        lines: this._deepCopy(lines),
        stationCount: lines.reduce((a, l) => a + ((l && l.stations) ? l.stations.length : 0), 0)
      };
      this._snapshots.push(snap);
      if (this._snapshots.length > this._snapMax) this._snapshots.shift();
      return snap;
    },
    log(op, detail) {
      const last = this._snapshots.length ? this._snapshots[this._snapshots.length - 1].id : null;
      this._audit.push({ t: Date.now(), op: op || 'modify', detail: detail || null, snapshotId: last });
      if (this._audit.length > 500) this._audit.shift();
      return true;
    },
    _auditBefore(op, ctx) {
      this.snapshot(op + (ctx && ctx.label ? '·' + ctx.label : ''));
      this.log('BEFORE:' + op, ctx || null);
    },
    listSnapshots() {
      return this._snapshots.map(s => ({ id: s.id, t: s.t, label: s.label, lineCount: s.lineCount, stationCount: s.stationCount })).reverse();
    },
    listAudit() {
      return this._audit.map(a => ({ t: a.t, op: a.op, snapshotId: a.snapshotId, detail: a.detail })).reverse();
    },
    rollback(ref) {
      if (!this._snapshots.length) return { ok: false, error: 'no snapshot' };
      let idx;
      if (typeof ref === 'number') idx = this._snapshots.length - 1 - ref;
      else idx = this._snapshots.findIndex(s2 => s2.id === ref);
      if (idx < 0 || idx >= this._snapshots.length) return { ok: false, error: 'bad ref: ' + ref };
      const snap = this._snapshots[idx];
      const clones = this._deepCopy(snap.lines) || [];
      // ⚠️ 空数据防御（2026-09-06 事故修复）：快照不可用 → 中止回滚，绝不 splice 清空线路
      if (!clones.length || clones.length !== snap.lineCount) {
        return { ok: false, error: '回滚中止：快照数据不可用（lineCount=' + snap.lineCount + '，可恢复=' + clones.length + '），未改动任何线路。' };
      }
      if (typeof G === 'undefined' || !G) return { ok: false, error: 'no G' };
      if (Array.isArray(G.lines)) G.lines.splice(0, G.lines.length, ...clones);
      else if (G.lines && typeof G.lines === 'object') {
        Object.keys(G.lines).forEach(k => { delete G.lines[k]; });
        clones.forEach(l => { if (l && l.id != null) G.lines[l.id] = l; });
      }
      (Array.isArray(G.lines) ? G.lines : Object.values(G.lines || {})).forEach(l => {
        ['_curvePts', '_curvePtsWgs', '_segAnchSaveCache', '_curvePtsGcj'].forEach(k => { try { l[k] = null; } catch (e) {} });
      });
      try { if (typeof metroInvalidateTransferVisualGeometryCaches === 'function') metroInvalidateTransferVisualGeometryCaches(); } catch (e) {}
      try { if (typeof redrawAllMetroOverlays === 'function') redrawAllMetroOverlays(); } catch (e) {}
      try { if (typeof refreshStationDots === 'function' && window.refreshStationDots) { } } catch (e) {}
      this.log('ROLLBACK', { to: snap.id, label: snap.label });
      return { ok: true, rolledTo: snap.id, label: snap.label, lineCount: clones.length };
    },
    clearSnapshots() {
      this._snapshots = []; this._audit = [];
      return true;
    },
    clearAudit() {
      this._audit = [];
      return true;
    },
    clearSnapshotsOnly() {
      this._snapshots = [];
      return true;
    },

    /** 读取全局选项（单个键或全部） */
    opt(key) {
      if (key == null) return Object.assign({}, this._opts);
      return this._opts[key];
    },

    /** 设置全局选项（部分合并；无效键忽略） */
    setOpts(patch) {
      if (!patch || typeof patch !== 'object') return this._opts;
      const valid = ['density','dataSource','drawMode','autoTransfers','autoSave','checkStrict','namingRule','deleteOld','endPadM'];
      valid.forEach(k => { if (patch[k] !== undefined) this._opts[k] = patch[k]; });
      return this._opts;
    },

    /** 重置全局选项为默认 */
    resetOpts() {
      this._opts = { density:'standard', dataSource:'auto', drawMode:'official', autoTransfers:true, autoSave:false, checkStrict:'standard', namingRule:'cn_metro', deleteOld:true, endPadM:100 };
      return this._opts;
    },

    // ========================================================================
    // 1. 基础查询
    // ========================================================================

    /** 获取全部线路数组（优先复用 MT.getLines，未注入时本地回退） */
    getLines() {
      const MT = window.__metroToolkit;
      if (MT && typeof MT.getLines === 'function') {
        try { return MT.getLines(); } catch (e) {}
      }
      return (typeof G !== 'undefined' && G.lines) ? G.lines : [];
    },

    /** 按 id/名称/核心名查找线路（优先复用 MT.findLine 超集，未注入时本地精确回退） */
    getLine(idOrName) {
      const MT = window.__metroToolkit;
      if (MT && typeof MT.findLine === 'function') {
        try { const l = MT.findLine(idOrName); if (l) return l; } catch (e) {}
      }
      const lines = this.getLines();
      return lines.find(l => l.id === idOrName || l.name === idOrName) || null;
    },

    /** 两点近似距离（米，参数 {lat,lng} 对象）——addNodes/fixTransfers 共用（合并去重）。
     *  平面近似（111320*cos 投影），高频调用性能优先（换乘/节点检测足够）。 */
    _distM(a, b) {
      const dLat = (a.lat - b.lat) * 111320;
      const dLng = (a.lng - b.lng) * 111320 * Math.cos(a.lat * Math.PI / 180);
      return Math.sqrt(dLat * dLat + dLng * dLng);
    },

    /** 两点球面距离（米，精确，委托 MT.haversine 权威实现）——需精确距离的场景（长距离/跨大区）。
     *  参数 {lat,lng} 对象；MT 未注入时回退 _distM。 */
    _haversineM(a, b) {
      const MT = window.__metroToolkit;
      if (MT && typeof MT.haversine === 'function') {
        try { return MT.haversine([a.lng, a.lat], [b.lng, b.lat]); } catch (e) {}
      }
      return this._distM(a, b);
    },

    /** 换乘站坐标独立（2026-08-16 用户要求，强制）：
     *  把换乘组内被多条线路「共享同一 station/latlng 对象」的站，分离为各线路独立对象
     *  （每条线路持有独立 latlng，可独立校准坐标，不再互相影响）。
     *  保留 name/sid/isTransfer/transferGroupId/transferType 以维持换乘关系。
     *  @param {string|string[]} [filter] 限定线路（id/名/城市前缀数组）；不传=全部
     *  @returns {{separated:number, groups:number}} */
    separateTransferStations(filter) {
      const lines = this.getLines();
      const scope = filter
        ? lines.filter(l => Array.isArray(filter)
            ? filter.some(f => l.id === f || (l.name || '').indexOf(f) >= 0)
            : String(l.name || '').indexOf(filter) >= 0)
        : lines;
      const tgIndex = {}; // transferGroupId -> [{line, station, idx}]
      scope.forEach(l => {
        (l.stations || []).forEach((s, idx) => {
          if (s && s.isTransfer && s.transferGroupId) {
            (tgIndex[s.transferGroupId] = tgIndex[s.transferGroupId] || []).push({ line: l, station: s, idx });
          }
        });
      });
      let separated = 0, groups = 0;
      const affected = new Set(); // 实际发生分离的线路 id（只重绘这些，防卡死）
      Object.keys(tgIndex).forEach(tg => {
        const members = tgIndex[tg];
        if (members.length < 2) return;
        groups++;
        members.forEach(m => {
          const shared = members.some(o => o !== m && o.station === m.station);
          if (shared) {
            const clone = Object.assign({}, m.station);
            clone.latlng = Object.assign({}, m.station.latlng);
            if (m.station.latlngWgs) clone.latlngWgs = Object.assign({}, m.station.latlngWgs);
            m.line.stations[m.idx] = clone;
            separated++;
            affected.add(m.line.id);
          }
        });
      });
      if (separated) {
        try { if (typeof metroInvalidateTransferVisualGeometryCaches === 'function') metroInvalidateTransferVisualGeometryCaches(); } catch (e) {}
        // 防卡死轻量重绘（2026-08-16）：只重绘发生分离的线路，且只 redrawLine+refreshStationDots
        // （绝不触发全量 redrawAllMetroOverlays —— 大存档全量重绘会重算全网客流导致卡死/重载）
        scope.forEach(l => {
          if (!affected.has(l.id)) return;
          ['_curvePts', '_curvePtsWgs', '_segAnchSaveCache'].forEach(k => { try { l[k] = null; } catch (e) {} });
          try { if (typeof window.redrawLine === 'function') window.redrawLine(l); } catch (e) {}
          try { if (typeof window.refreshStationDots === 'function') window.refreshStationDots(l); } catch (e) {}
        });
      }
      return { separated, groups, affected: affected.size };
    },

    // ========================================================================
    // 2. 高德坐标查询（GCJ-02）
    // ========================================================================

    /**
     * 站名 → 坐标（合并 geocode/geocodeMany）。geocode(name, city) 单条 → {lng,lat,addr}|null；
     * geocode([name1,name2], city) 批量（顺序执行）→ [{name,ok,lng,lat,addr}|{name,ok:false}]。
     * 建议使用 "站名地铁站" 格式以区分地铁站台与同名道路/区域。
     * @param {string|string[]} nameOrNames 站名或站名数组
     * @param {string} city 城市名，默认 "上海"
     */
    async geocode(nameOrNames, city = '上海') {
      const one = (name) => new Promise((resolve) => {
        try {
          const geo = new AMap.Geocoder({ city });
          let done = false;
          const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, 7000);
          geo.getLocation(name, (status, result) => {
            if (done) return; done = true; clearTimeout(t);
            const g = (status === 'complete' && result && result.geocodes && result.geocodes[0]) ? result.geocodes[0] : null;
            resolve(g ? { lng: +g.location.lng.toFixed(5), lat: +g.location.lat.toFixed(5), addr: g.formattedAddress } : null);
          });
        } catch (e) { resolve(null); }
      });
      if (Array.isArray(nameOrNames)) {
        const out = [];
        for (const n of nameOrNames) {  // 顺序执行（并发会导致页面导航/上下文销毁）
          const r = await one(n + '地铁站');
          out.push(r ? { name: n, ok: true, lng: r.lng, lat: r.lat, addr: r.addr } : { name: n, ok: false });
        }
        return out;
      }
      return one(nameOrNames);
    },

    // ========================================================================
    // 3. 线路导入 / 站点铺设
    // ========================================================================

    /**
     * 向指定线路批量放置站点（placeStation 内部函数，绕过点击）。
     * 注意：新建线路需先通过 UI（添加地铁线路 → 开始铺设轨道）创建空线路。
     * @param {string} lineId 线路 id
     * @param {Array<{name,lat,lng}>} stations 站点数组
     * @returns {{placed:string[], failed:string[]}}
     */
    placeStations(lineId, stations) {
      const l = this.getLine(lineId);
      if (!l) return { error: 'line not found: ' + lineId };
      if (typeof placeStation !== 'function') return { error: 'placeStation unavailable' };
      const placed = [], failed = [];
      stations.forEach(s => {
        try {
          const r = placeStation(lineId, { lat: s.lat, lng: s.lng }, s.name);
          if (r) placed.push(s.name); else failed.push(s.name);
        } catch (e) { failed.push(s.name + ':' + String(e).substring(0, 30)); }
      });
      // 换乘站坐标独立（2026-08-16）：放置后分离跨线共享站对象，确保各线独立坐标
      this.separateTransferStations(l.id);
      this.repaint(l);
      return { placed, failed };
    },

    /** 重命名线路并设置官方颜色 */
    configureLine(lineId, { name, nameEn, color } = {}) {
      const l = this.getLine(lineId);
      if (!l) return { error: 'line not found' };
      if (name) { l.name = name; l._lineNameCustomizedByUser = true; }
      if (nameEn) l.nameEn = nameEn;
      if (color) l.color = color;
      this.repaint(l);
      return { id: l.id, name: l.name, color: l.color };
    },

    // ========================================================================
    // 4. 官方标准颜色
    // ========================================================================

    /**
     * 一键为一条线路设置官方颜色并重绘。
     * @param {string} lineId 线路 id 或名称
     * @param {string} color 十六进制颜色如 "#007B61"
     */
    /** 一键设置官方颜色：applyOfficialColor(name, color) 单条 或 applyOfficialColors({name:color}) 批量；统一 repaint */
    applyOfficialColors(target, color) {
      // 批量：target 为 {线路名: 颜色} 对象
      if (typeof target === 'object' && target !== null) {
        const results = [];
        Object.keys(target).forEach(lineName => {
          const l = this.getLine(lineName);
          if (l) { l.color = target[lineName]; results.push({ name: lineName, ok: true }); }
          else results.push({ name: lineName, ok: false });
        });
        this.repaint();
        return results;
      }
      // 单条：target 为线路名/id，color 为颜色
      const l = this.getLine(target);
      if (!l) return { error: 'line not found: ' + target };
      l.color = color;
      this.repaint();
      return { ok: true, name: l.name, color };
    },

    // ========================================================================
    // 5. 实际走向节点
    // ========================================================================

    /**
     * 一键为线路所有站间段补充节点。**只补空段**（已有节点的段保留，避免覆盖
     * 一次性绘制写好的高德真实走向节点）；长段三等分 2 节点 / 短段中点 1 节点。
     * @param {string} lineId
     * @param {number} longSeg 长段阈值（米），默认 2500
     * @param {object} opts { density: 'sparse'|'standard'|'dense'(默认standard), tolerance: 容错米(自适应密度,容错越大节点越少), endPadM, light }
     * @returns {{nodes:number, perSeg:number[]}}
     */
    /** 一键补节点（合并 addNodes/addNodesAll/addNodesSafeAll）：
     *  addNodes(id, longSeg, opts) 单条 · addNodes('all', ...) 全部 · addNodes([id1,id2], ...) 批量
     *  批量自动安全模式：light 轻量重绘 + batch 分批暂停 + 最后统一 repaint。 */
    async addNodes(target, longSeg = 2500, opts = {}) {
      const ids = (target === 'all' || target == null)
        ? this.getLines().map(l => l.id)
        : (Array.isArray(target) ? target : [target]);
      const batch = opts.batch || 10, gapMs = opts.gapMs || 250;
      const results = [];
      for (let i = 0; i < ids.length; i++) {
        const l = this.getLine(ids[i]);
        if (!l || (l.stations || []).length < 2) continue;
        try {
          // 单条：完整逻辑（含密度/长段/站台避让/重绘）
          if (ids.length === 1 && !Array.isArray(target)) {
            const density = opts.density || this.opt('density') || 'standard';
            const _OD = window.__officialDraw;
            const _ND = (_OD && _OD.NODE_DENSITY) || {};
            let longSeg, endPadM;
            if (opts.tolerance != null) {
              // 自适应密度（2026-08-16）：容错越大→长段阈值越大→节点越少；站台回避 endPadM 保留（默认100）
              longSeg = opts.longSeg != null ? opts.longSeg : Math.max(1500, Math.min(5000, opts.tolerance * 500));
              endPadM = opts.endPadM != null ? opts.endPadM : 100;
            } else {
              // 密度档位：endPadM 从 OD.NODE_DENSITY 单一来源读取（合并去重），长段阈值本地
              const DENS = {
                sparse:   { longSeg: 3500, endPadM: (_ND.sparse && _ND.sparse.endPadM) || 120 },
                standard: { longSeg: 2500, endPadM: (_ND.standard && _ND.standard.endPadM) || 100 },
                dense:    { longSeg: 1500, endPadM: (_ND.dense && _ND.dense.endPadM) || 80 }
              }[density];
              longSeg = longSeg != null ? longSeg : DENS.longSeg;
              endPadM = opts.endPadM != null ? opts.endPadM : DENS.endPadM;
            }
            const nSt = l.stations.length;
            const existing = Array.isArray(l.segmentAnchors) && l.segmentAnchors.length === nSt - 1 ? l.segmentAnchors : null;
            const newAnchors = [];
            for (let k = 0; k < nSt - 1; k++) {
              if (existing && existing[k] && existing[k].length) { newAnchors.push(existing[k]); continue; }
              const a = l.stations[k], b = l.stations[k + 1];
              const d = this._distM(a.latlng, b.latlng);
              const seg = [];
              const tryPush = (pt) => { if (this._distM(a.latlng, pt) > endPadM && this._distM(b.latlng, pt) > endPadM) seg.push(pt); };
              if (d > longSeg) {
                tryPush({ lat: a.latlng.lat + (b.latlng.lat - a.latlng.lat) / 3, lng: a.latlng.lng + (b.latlng.lng - a.latlng.lng) / 3 });
                tryPush({ lat: a.latlng.lat + (b.latlng.lat - a.latlng.lat) * 2 / 3, lng: a.latlng.lng + (b.latlng.lng - a.latlng.lng) * 2 / 3 });
              } else {
                tryPush({ lat: (a.latlng.lat + b.latlng.lat) / 2, lng: (a.latlng.lng + b.latlng.lng) / 2 });
              }
              if (!seg.length) seg.push({ lat: (a.latlng.lat + b.latlng.lat) / 2, lng: (a.latlng.lng + b.latlng.lng) / 2 });
              newAnchors.push(seg);
            }
            l.segmentAnchors = newAnchors;
            if (opts.light) {
              ['_curvePts', '_curvePtsWgs', '_segAnchSaveCache'].forEach(k => { try { l[k] = null; } catch (e) {} });
              ['redrawLine', 'refreshStationDots'].forEach(fn => { if (typeof window[fn] === 'function') { try { window[fn](l); } catch (e) {} } });
            } else {
              this.rebuildGeometry(l);
            }
            return { nodes: newAnchors.reduce((a, s) => a + s.length, 0), perSeg: newAnchors.map(s => s.length) };
          }
          // 批量：light 轻量重绘 + 分批暂停
          const nd = await this.addNodes(l.id, longSeg, { light: true, density: opts.density });
          results.push({ name: l.name, nodes: nd.nodes });
        } catch (e) { results.push({ name: l.name, error: String(e).substring(0, 40) }); }
        if ((i + 1) % batch === 0) await new Promise(r => setTimeout(r, gapMs));
      }
      try { this.repaint(); } catch (e) {}
      return results;
    },

    // ========================================================================
    // 6. 官方站名
    // ========================================================================

    /**
     * 一键按顺序实施官方站名（坐标保留，站名替换为真实站名）。
     * @param {string} lineId
     * @param {string[]} names 与 stations 等长的真实站名数组
     */
    applyStationNames(lineId, names) {
      const l = this.getLine(lineId);
      if (!l) return { error: 'line not found: ' + lineId };
      if (names.length !== l.stations.length) {
        return { error: `站名数量 ${names.length} != 站点数量 ${l.stations.length}` };
      }
      const changed = [];
      l.stations.forEach((s, i) => {
        const old = s.name;
        if (old !== names[i]) { s.name = names[i]; changed.push(`${old}->${names[i]}`); }
      });
      this.repaint(l);
      return { changed: changed.length };
    },

    /**
     * 一键按坐标校准站点位置（用高德准确坐标）。
     * @param {string} lineId
     * @param {Array<{name,lat,lng}>} coords
     */
    calibrateCoordinates(lineId, coords) {
      const l = this.getLine(lineId);
      if (!l) return { error: 'line not found' };
      // 换乘站坐标独立（2026-08-16 用户要求）：校准前先分离本线换乘站共享对象，
      // 确保只改本线坐标、不影响其他线路同名换乘站（防止跨线联动错位）
      this.separateTransferStations(l.id);
      const updated = [], missing = [];
      coords.forEach(c => {
        const s = l.stations.find(st => st.name === c.name);
        if (s) {
          s.latlng = { lat: c.lat, lng: c.lng };
          if (s.latlngWgs) s.latlngWgs = { lat: c.lat, lng: c.lng };
          updated.push(c.name);
        } else missing.push(c.name);
      });
      this.rebuildGeometry(l);
      return { updated, missing };
    },

    /** 用该线路自己的高德数据（MT.queryLine 该线站点坐标）校准该线所有站（含换乘站）。
     *  ⚠️ 换乘站坐标必须用各线路自己的数据（2026-08-16 用户要求）：禁用通用 resolveCoord 坐标，
     *     因为通用坐标会让各线换乘站坐标趋同，非「线路自己的坐标」。
     *     实测：2号线人民广场 线路自己 121.47265,31.23316 vs 通用 121.47511,31.23269；
     *          2号线江苏路 线路自己 121.43246,31.2199 vs 通用 121.43063,31.22041；
     *          11号线花桥 线路自己 121.10441,31.29879（勿用通用 121.10460）。
     *  @param {string} city 城市名（如 '上海'）
     *  @param {string} lineId 线路 id/名
     *  @returns {Promise<{updated:Array, missing:Array}|{error:string}>} */
    async calibrateFromAmap(city, lineId) {
      const l = this.getLine(lineId);
      if (!l) return { error: 'line not found: ' + lineId };
      // 2026-08-22 风险拦截：校准坐标=移动站台位置（YELLOW 改变操作），须先经 confirmDangerous 报告+询问
      const g = this.confirmDangerous('calibrateFromAmap', { city, line: l.name, st: (l.stations || []).length });
      if (g.blocked) return { blocked: true, level: g.level, message: g.message };
      const MT = window.__metroToolkit;
      if (!MT || typeof MT.queryLine !== 'function') return { error: 'MT.queryLine unavailable' };
      const sts = l.stations || [];
      if (sts.length < 2) return { error: 'too few stations' };
      const noMatch = /(\d+[A-Za-z]*|[A-Za-z]+\d+)号线/.exec(l.name || '');
      const no = (noMatch ? noMatch[1] : '').toUpperCase();
      const from = sts[0].name, to = sts[sts.length - 1].name;
      const r = await MT.queryLine(city, no, { stationFrom: from, stationTo: to });
      if (!r || !r.ok) return { error: (r && r.reason) || 'queryLine failed', warnings: r && r.warnings };
      const coords = (r.stations || [])
        .filter(s => typeof s.lat === 'number' && typeof s.lng === 'number')
        .map(s => ({ name: s.name, lat: s.lat, lng: s.lng }));
      return this.calibrateCoordinates(lineId, coords);
    },

    /** 查询指定线路（该线全线 SUBWAY path 投影）上某站/多站的线路坐标（2026-08-16 用户要求：换乘站查指定线路坐标，禁用通用 resolveCoord）。
     *  方法：复用 `OD.queryLinePaths(city, line, lineNo)` 取全线 path（**普通线单方向整线；环线逐段独立真实 SUBWAY path**，
     *  ——2026-08-23 重写，旧多方向合并 fullPath 有方向歧义致换乘站投影到错误段；
     *  现环线逐段 queryTransferStops 覆盖全圈含闭合段，比旧 4 方向合并更全更准）→ 合并全部 path 点 →
     *  `projIdx` 找每站 path 最近点坐标（该线自身走向位置，devM 应=0）。
     *  @param {string} city 城市名 @param {string} lineId @param {string|string[]} nameOrList 站名或数组
     *  @returns {Promise<{lat,lng,pathIdx,devM}|{name,lat,lng,devM,...}|{error}>} 单站返回对象，数组返回 {站名:对象} */
    async resolveLineCoord(city, lineId, nameOrList) {
      const l = this.getLine(lineId);
      if (!l) return { error: 'line not found: ' + lineId };
      const MT = window.__metroToolkit;
      if (!MT || typeof MT.queryTransferStops !== 'function') return { error: 'MT.queryTransferStops unavailable' };
      const sts = l.stations || [];
      if (sts.length < 2) return { error: 'too few stations' };
      const noMatch = /(\d+[A-Za-z]*|[A-Za-z]+\d+)号线/.exec(l.name || '');
      const no = (noMatch ? noMatch[1] : '').toUpperCase();
      // 复用 OD.queryLinePaths（环线多方向合并，与 rebuildNodesFromAmap 融合不重复）；无 OD 时回退单次查询
      let paths = [];
      const OD = window.__officialDraw;
      if (OD && typeof OD.queryLinePaths === 'function') {
        paths = await OD.queryLinePaths(city, l, no).catch(() => []);
      } else {
        const first = sts[0], last = sts[sts.length - 1];
        const q = await MT.queryTransferStops(city, [first.latlng.lng, first.latlng.lat], [last.latlng.lng, last.latlng.lat], no + '号线');
        if (q && q.path && q.path.length >= 2) paths = [q.path];
      }
      if (!paths.length) return { error: 'no full-line path' };
      const merged = [];
      paths.forEach(p => { if (p) p.forEach(pt => merged.push(pt)); });
      if (!merged.length) return { error: 'no full-line path' };
      function projIdx(lat, lng) { let best = 0, bd = Infinity; for (let j = 0; j < merged.length; j++) { const dd = Math.hypot((lng - merged[j][0]) * 111320 * Math.cos(lat * Math.PI / 180), (lat - merged[j][1]) * 110540); if (dd < bd) { bd = dd; best = j; } } return best; }
      // ⚠️ 2026-09-06 devM 守卫（防叠点复发）：path 未覆盖的站（如含自绘延伸线的官方西段，高德只返回
      //    已收录段 path）会被 projIdx 吸到 path 端点（devM 数百米~公里），若静默返回会致校准写回错误坐标
      //    （实测 4 号线鼓楼/草场门/云南路/龙江曾因 path 起点在鼓楼附近而被全部叠到 path[0]=118.7975）。
      //    devM > maxDevM(默认300m) 判定「该 path 未覆盖此站」→ 返回 error，绝不产出可写坐标。
      const maxDevM = 300;
      const names = Array.isArray(nameOrList) ? nameOrList : [nameOrList];
      const out = {};
      for (const nm of names) {
        const s = sts.find(x => x.name === nm);
        if (!s) { out[nm] = { error: 'station not in line' }; continue; }
        const idx = projIdx(s.latlng.lat, s.latlng.lng);
        const proj = { lat: +merged[idx][1], lng: +merged[idx][0] };
        const devM = Math.round(this._distM(s.latlng, proj));
        if (devM > maxDevM) {
          out[nm] = { name: nm, error: 'out_of_path', devM: devM, note: '该站距整线 path 最近点 ' + devM + 'm（path 未覆盖此站，可能因线路含自绘延伸/高德只回部分段）。勿用投影坐标校准，需改走 resolveCoordTwice/官方站表或确认 path 端点。' };
          continue;
        }
        out[nm] = { name: nm, lat: proj.lat, lng: proj.lng, pathIdx: idx, devM: devM };
      }
      return names.length === 1 ? out[names[0]] : out;
    },

    /** 用指定线路（全线 SUBWAY path 投影）坐标校准换乘站 + 自动重建节点 + 自动刷新 UI（2026-08-16 用户要求）。
     *  @param {string} city 城市名 @param {string} lineId @param {string|string[]} nameOrList 换乘站名或数组
     *  @returns {Promise<{updated,missing,lineCoords}>} */
    async calibrateStationToLine(city, lineId, nameOrList) {
      const names = Array.isArray(nameOrList) ? nameOrList : [nameOrList];
      const r = await this.resolveLineCoord(city, lineId, nameOrList);
      if (r && r.error && !names.some(n => r[n])) return { error: r.error };
      const map = names.length === 1 ? { [names[0]]: r } : r;
      const coords = names.map(nm => map[nm] && map[nm].lat != null ? { name: nm, lat: map[nm].lat, lng: map[nm].lng } : null).filter(Boolean);
      if (!coords.length) return { error: 'no line coords resolved' };
      const res = this.calibrateCoordinates(lineId, coords);
      // 校准后重新生成节点（操作分离：坐标变了节点要重生成）
      const OD = window.__officialDraw;
      if (OD && OD.rebuildNodesFromAmap) { try { await OD.rebuildNodesFromAmap(city, lineId, { density: 'standard' }); } catch (e) {} }
      // 自动刷新 UI（轻量，仅受影响线路）
      this.repaint(this.getLine(lineId));
      return { ...res, lineCoords: map };
    },

    // ========================================================================
    // 7. 修复地铁线路
    // ========================================================================

    /**
     * 一键修复线路（合并 fixLine/fixAllLines）：fixLine(id, opts) 单条 · fixLine('all') 全部。
     * 重建几何、清理缓存、恢复段锚点、保证站名唯一、重绘。
     * @param {string|'all'} target 线路 id/名称 或 'all'
     * @param {object} opts
     */
    fixLine(target, opts = {}) {
      const doOne = (l) => {
        const out = {};
        const need = l.stations.length - 1;
        if (!Array.isArray(l.segmentAnchors) || l.segmentAnchors.length !== need) {
          l.segmentAnchors = Array.from({ length: need }, () => []);
          out.segmentAnchorsFixed = true;
        }
        if (!Array.isArray(l.pendingAnchors)) l.pendingAnchors = [];
        out.geometry = this.rebuildGeometry(l);
        const seen = {};
        l.stations.forEach(s => {
          if (seen[s.name]) { s.name = s.name + '（' + (++seen[s.name].n) + '）'; out.renamedDup = true; }
          else seen[s.name] = { n: 1 };
        });
        this.repaint(l);
        return { ok: true, name: l.name, ...out };
      };
      if (target === 'all') {
        const results = [];
        this.getLines().forEach(l => {
          try { results.push(doOne(l)); }
          catch (e) { results.push({ name: l.name, error: String(e).substring(0, 40) }); }
        });
        return results;
      }
      const l = this.getLine(target);
      if (!l) return { error: 'line not found: ' + target };
      return doOne(l);
    },

    // ========================================================================
    // 8. 修复换乘关系
    // ========================================================================

    /** 一键修复换乘关系（防卡死版，2026-08-16 优化）：
     * ① 同名跨线站 → 标记 isTransfer + 分配统一 transferGroupId（真正建换乘组）
     * ② 邻近(<250m)跨线不同名站 → 补建换乘（识别"唯亭(花桥)"vs"唯亭(苏州新区火车站)"类）
     * 防卡死：① 支持限定范围 filter（城市名/线路名/id 数组），大存档只处理目标；② 末尾只重绘受影响线路（不触发全量 repaint，主提速点）
     * @param {string|string[]} [filter] 可选限定范围：城市名(如 '上海') / 线路名或 id 数组；不传=全部线路
     */
    fixTransfers(filter) {
      const results = [], nearResults = [];
      // ⚠️ 高风险守卫（2026-08-16）：无 filter 全库修复换乘是 RED 级操作，
      //    曾因换乘站共享对象引用把全城730站错误并入同一换乘组（存档严重污染）。
      //    无 filter 时必须先确认，未确认则拦截并停止。
      if (!filter) {
        const g = this.confirmDangerous('fixTransfers-all', { note: '全库 fixTransfers（无 filter）' });
        if (g.blocked) return g;  // 返回 { blocked:true, message }，不执行
      }
      // 范围过滤（防卡死：大存档只处理目标城市/线路）
      const lines = this.getLines();
      const scope = filter
        ? lines.filter(l => Array.isArray(filter)
            ? filter.some(f => l.id === f || l.name === f || (l.name || '').indexOf(f) >= 0)
            : String(l.name || '').indexOf(filter) >= 0)
        : lines;
      const touched = new Set();   // 实际被修改的线路 id（收尾只重绘这些，避免全量 repaint）
      const nameIndex = {};
      scope.forEach(l => {
        (l.stations || []).forEach(s => {
          (nameIndex[s.name] = nameIndex[s.name] || []).push({ lineId: l.id, lineName: l.name, station: s });
        });
      });
      let counter = 0;
      const newTG = () => {
        try { if (typeof top._newTransferGroupId === 'function') return top._newTransferGroupId(); } catch (e) {}
        return 'TG_' + Date.now() + '_' + (counter++);
      };
      // ① 同名跨线 → 统一换乘组（仅同城：用坐标距离硬约束，杜绝跨城市同名误配：常州泰山路 vs 芜湖泰山路）
      // 真同名换乘站坐标相距很近（<800m）；跨城市同名站相距数 km~百 km，regionOf 可能返回共同大地区（华东等）不可靠
      // 严格检查换乘站（2026-08-16 用户要求）：同名站坐标差 ≤150m 才算真换乘（游戏同站合并阈值 SAME_POINT_M=150），
      // 防止把坐标差异大的同名站（如徐家汇 1/11 号线差 ~450m）误建换乘组
      const hasCommonCity = (ga, gb) => {
        try { return this._distM(ga.station.latlng, gb.station.latlng) <= (this._transferTolM || 150); }
        catch (e) { return false; }
      };
      Object.keys(nameIndex).forEach(n => {
        const group = nameIndex[n];
        if (group.length > 1) {
          // 按共同城市聚类：同一城市(地区)的同名站才建换乘
          const clusters = [];
          group.forEach(g => {
            let placed = false;
            for (const cl of clusters) {
              if (cl.some(x => hasCommonCity(x, g))) { cl.push(g); placed = true; break; }
            }
            if (!placed) clusters.push([g]);
          });
          clusters.forEach(cl => {
            if (cl.length > 1) {
              const lines = cl.map(x => x.lineName);
              const tg = newTG();
              cl.forEach(({ station, lineId }) => {
                station.isTransfer = true;
                station.transferGroupId = tg;
                touched.add(lineId);
              });
              results.push({ name: n, lines, count: cl.length });
            }
          });
        }
      });
      // ② 邻近(<250m)跨线不同名站 → 补建换乘（只对候选：已 isTransfer 站找邻近跨线伙伴）
      const all = [];
      scope.forEach(l => (l.stations || []).forEach(s => all.push({ lineId: l.id, lineName: l.name, station: s })));
      const transferStations = all.filter(x => x.station.isTransfer);
      transferStations.forEach(A => {
        if (A.station.transferGroupId) return;
        let best = null;
        for (const B of all) {
          if (B.lineId === A.lineId || B.station.name === A.station.name) continue;
          const d = this._distM(A.station.latlng, B.station.latlng);
          if (d <= 250 && (!best || d < best.d)) best = { b: B, d };
        }
        if (best) {
          const tg = best.b.station.transferGroupId || newTG();
          A.station.transferGroupId = tg;
          best.b.station.isTransfer = true;
          best.b.station.transferGroupId = tg;
          touched.add(A.lineId);
          touched.add(best.b.lineId);
          nearResults.push({ a: A.station.name + '@' + A.lineName.replace(/地铁|轨道交通|轨道/g, ''), b: best.b.station.name + '@' + best.b.lineName.replace(/地铁|轨道交通|轨道/g, ''), d: Math.round(best.d) });
        }
      });
      // 同步换乘组名称
      try { if (typeof syncTransferGroupStationName === 'function') syncTransferGroupStationName(); } catch (e) {}
      // 失效换乘视觉几何缓存
      try { if (typeof metroInvalidateTransferVisualGeometryCaches === 'function') metroInvalidateTransferVisualGeometryCaches(); } catch (e) {}
      // 防卡死收尾：只轻量重绘实际受影响的线路（只 redrawLine+refreshStationDots，
      // 绝不触发全量 redrawAllMetroOverlays —— 大存档全量重绘会重算全网客流导致卡死/重载）
      const repaintLines = scope.filter(l => touched.has(l.id));
      if (repaintLines.length) {
        repaintLines.forEach(l => {
          try { if (typeof window.redrawLine === 'function') window.redrawLine(l); } catch (e) {}
          try { if (typeof window.refreshStationDots === 'function') window.refreshStationDots(l); } catch (e) {}
        });
      }
      // 换乘站坐标独立（2026-08-16 用户要求，强制）：建立换乘组后，分离跨线共享站对象，
      // 确保每条线路持有各自独立坐标（保留 name/sid/transferGroupId 维持换乘），可独立校准
      const sep = this.separateTransferStations(scope.map(l => l.id));
      return { transfers: results, nearTransfers: nearResults, total: results.length + nearResults.length, scope: scope.length, repainted: repaintLines.length, separated: sep.separated };
    },

    /** 手动建立换乘（官方 `_applyTransferDecision`）+ 自动刷新 UI + 分离共享对象（2026-08-16 用户要求：添加换乘时自动刷新 UI）。
     *  @param {string} lineId 本线 id/名 @param {string} stationName 本线换乘站名
     *  @param {string} partnerLineId 伙伴线 id/名 @param {string} partnerStationName 伙伴线站名
     *  @param {string} kind 'passage'|'same-platform'（默认 passage）
     *  @returns {{line,station,partner,tg}|{error}} */
    applyTransfer(lineId, stationName, partnerLineId, partnerStationName, kind) {
      kind = kind || 'passage';
      const l = this.getLine(lineId);
      const pl = this.getLine(partnerLineId);
      if (!l || !pl) return { error: 'line not found' };
      const s = (l.stations || []).find(x => x.name === stationName);
      const ps = (pl.stations || []).find(x => x.name === partnerStationName);
      if (!s || !ps) return { error: 'station not found: ' + stationName + ' / ' + partnerStationName };
      if (typeof top._applyTransferDecision !== 'function') return { error: '_applyTransferDecision unavailable' };
      top._applyTransferDecision({ movedStation: s, targetStation: ps, kind, primaryLine: l.id }, true);
      // 自动刷新 UI（轻量：只重绘受影响两条线，防卡死）
      [l, pl].forEach(x => {
        try { if (typeof window.redrawLine === 'function') window.redrawLine(x); } catch (e) {}
        try { if (typeof window.refreshStationDots === 'function') window.refreshStationDots(x); } catch (e) {}
      });
      // 分离跨线共享对象（各自独立坐标）
      try { this.separateTransferStations([l.id, pl.id]); } catch (e) {}
      return { line: l.name, station: stationName, partner: pl.name + '·' + partnerStationName, kind, tg: s.transferGroupId ? String(s.transferGroupId).slice(0, 10) : null };
    },

    // ========================================================================
    // 9. 删除线路（含安全删除：按城市前缀+线号精确匹配，防误删其他城市，2026-08-16 二次踩坑后固化）
    // ========================================================================
    /** 安全查找某城市某号线（防误删/误匹配）：只匹配「城市前缀 + 线号」开头的线路，绝不匹配其他城市。
     *  @param {string} city 城市名（如 '上海'）——线路名以城市前缀开头
     *  @param {string} no 线号（如 '11'）——匹配 `城市(地铁|轨道交通|轨道|有轨电车)?N号线`
     *  @returns {Array} 匹配的线路数组（可能多条，删除前先列出供确认） */
    findCityLine(city, no) {
      no = String(no || '').replace(/号线/g, '');
      const rx = new RegExp('^' + city + '(地铁|轨道交通|轨道|有轨电车)?' + no + '号线');
      return this.getLines().filter(l => rx.test(l.name || ''));
    },
    /** 安全删除某城市某号线：只删除名字以「城市前缀+线号」开头的线路，绝不删其他城市。
     *  删除前先返回 candidates 供确认；删除用官方 deleteLine。
     *  @param {string} city 城市名  @param {string} no 线号
     *  @returns {{deleted:Array, candidates:Array}} */
    deleteCityLine(city, no) {
      const cands = this.findCityLine(city, no);
      // 2026-08-22 风险拦截：批量删除不可逆，须先经 confirmDangerous 报告+询问（RED），未确认绝不执行
      const g = this.confirmDangerous('deleteCityLine', { city, no, count: cands.length, names: cands.map(l => l.name) });
      if (g.blocked) return { blocked: true, level: g.level, message: g.message, candidates: cands.map(l => ({ id: l.id, name: l.name, st: (l.stations || []).length })) };
      const deleted = [];
      cands.forEach(l => {
        try { if (typeof deleteLine === 'function') { deleteLine(l.id, { suppressNotify: true }); deleted.push({ id: l.id, name: l.name }); } } catch (e) {}
      });
      return { deleted, candidates: cands.map(l => ({ id: l.id, name: l.name, st: (l.stations || []).length })) };
    },

    /** 删除单条线路（高风险：不可逆，删后需重画；依赖全局 deleteLine 函数，带 suppressNotify 静默）。
     *  @param {string} idOrName 线路 id 或名称（经 getLine 解析）
     *  @returns {object} {deleted: 线路名} 成功 或 {error: 原因} 失败 */
    deleteLine(idOrName) {
      const l = this.getLine(idOrName);
      if (!l) return { error: 'line not found: ' + idOrName };
      // 2026-08-22 风险拦截：删除不可逆，须先经 confirmDangerous 报告+询问（RED），未确认绝不执行
      const g = this.confirmDangerous('deleteLine', { line: l.name, st: (l.stations || []).length });
      if (g.blocked) return { blocked: true, level: g.level, message: g.message };
      if (typeof deleteLine !== 'function') return { error: 'deleteLine unavailable' };
      try { deleteLine(l.id, { suppressNotify: true }); return { deleted: l.name }; }
      catch (e) { return { error: String(e).substring(0, 80) }; }
    },

    // ========================================================================
    // 10. 几何重建 / 重绘
    // ========================================================================

    /** 清缓存 + 触发全部几何重建/重绘函数（已验证有效） */
    rebuildGeometry(l) {
      ['_curvePts', '_curvePtsWgs', '_segAnchSaveCache'].forEach(k => { try { l[k] = null; } catch (e) {} });
      const fns = ['_applyLinePostGeometryWork', 'scheduleBuildModeLinePostGeometryWork', 'redrawLine', 'refreshStationDots'];
      const results = [];
      fns.forEach(fn => {
        if (typeof window[fn] === 'function') {
          try { window[fn](l); results.push(fn + ':ok'); } catch (e) { results.push(fn + ':err'); }
        }
      });
      return results;
    },

    /** 重绘线路（合并 repaint/repaintAll）：repaint(line) 单条 · repaint() 全部（最终刷新 UI） */
    repaint(l) {
      // 防卡死轻量重绘（2026-08-16 优化）：传单线 l 时只重绘该线（redrawLine+refreshStationDots），
      // 不做全量 redrawAllMetroOverlays（大存档全量重绘会重算全网客流导致卡顿/重载）。
      // 仅 l 为空（全量刷新）时才调 redrawAllMetroOverlays()。
      const targets = l ? [l] : this.getLines();
      if (l) {
        ['refreshStationDots', 'redrawLine'].forEach(fn => {
          if (typeof window[fn] !== 'function') return;
          try { window[fn](l); } catch (e) {}
        });
        return;
      }
      ['refreshStationDots', 'redrawLine', 'redrawAllMetroOverlays'].forEach(fn => {
        if (typeof window[fn] !== 'function') return;
        try {
          if (window[fn].length === 0) { window[fn](); return; }
          targets.forEach(x => { try { window[fn](x); } catch (e) {} });
        } catch (e) {}
      });
    },
// ========================================================================
    // 11. 线路命名规则（旧版 applyNaming 重构）
    // ========================================================================
    /**
     * 按命名规则生成线路名（合并 applyNaming/applyNamingLines）。
     * applyNaming(city, '1', rule) → 字符串；applyNaming(city, ['1','2'], rule) → 数组 [{no,name,rule}]
     * @param {string} cityName 城市名，如 "上海"
     * @param {string|number|Array} lineNo 线号（"1"/"S1"）或线号数组
     * @param {string} rule 规则：cn_metro / cn_rail / cn_rail2 / metro / plain / line / en / 自定义模板
     */
    applyNaming(cityName, lineNo, rule) {
      rule = rule || 'cn_metro';
      const one = (no) => {
        no = String(no == null ? '' : no).replace(/号线/g, '');
        switch (rule) {
          case 'cn_metro': return (cityName || '') + '地铁' + no + '号线';
          case 'cn_rail': return (cityName || '') + '轨道交通' + no + '号线';
          case 'cn_rail2': return (cityName || '') + '轨道' + no + '号线';
          case 'metro': return '地铁' + no + '号线';
          case 'plain': return no + '号线';
          case 'line': return no + ' Line';
          case 'en': return 'Line ' + no;
          default: return String(rule).replace(/\{city\}/g, cityName || '').replace(/\{no\}/g, no).replace(/\{号线\}/g, no + '号线');
        }
      };
      if (Array.isArray(lineNo)) {
        return lineNo.map(no => ({ no: String(no).replace(/号线/g, ''), name: one(no), rule }));
      }
      return one(lineNo);
    },

    // ========================================================================
    // 12. 线路分类筛选（在建/已建成/规划，旧版 statusFilter/_category 重构）
    // ========================================================================
    /**
     * 线路分类设置/筛选（合并 setLineStatus/filterByStatus）。
     * setLineStatus(id, 'built') 设置单条；setLineStatus('all', 'under') 设置全部；
     * setLineStatus(null, ['built','under']) 按分类筛选 → 返回线路数组。
     * @param {string|object|null} target 线路 id/对象/'all'/null（null=筛选模式）
     * @param {string|string[]} status built=已建成 / under=在建 / planned=规划
     */
    setLineStatus(target, status) {
      // 筛选模式：target 为 null，status 为数组/字符串 → 返回匹配线路
      if (target == null) {
        const filter = (Array.isArray(status) ? status : [status]).map(String);
        return this.getLines().filter(l => filter.includes(l.status || l._category || 'built'));
      }
      // 设置模式
      const list = target === 'all' ? this.getLines() : [ (typeof target === 'string' ? this.getLine(target) : target) ];
      const results = [];
      list.forEach(l => {
        if (!l) return results.push({ error: 'line not found' });
        const st = String(status || 'built').toLowerCase();
        if (!['built', 'under', 'planned'].includes(st)) return results.push({ error: 'invalid status: ' + status, name: l.name });
        l.status = st; l._category = st;
        results.push({ ok: true, name: l.name, status: st });
      });
      return results.length === 1 ? results[0] : results;
    },

    // ========================================================================
    // 13. 地区识别 + 状态报告（旧版 regions/status 重构）
    // ========================================================================
    /** 地区表（城市前缀 → 地区信息） */
    REGIONS() {
      return {
        shanghai: { name: '上海', prefixes: ['上海地铁', '上海市域', '上海磁悬浮'], province: '上海市', group: '长三角' },
        suzhou: { name: '苏州', prefixes: ['苏州轨道交通', '苏州地铁'], province: '江苏省', group: '苏锡常' },
        wuxi: { name: '无锡', prefixes: ['无锡地铁', '无锡轨道交通'], province: '江苏省', group: '苏锡常' },
        changzhou: { name: '常州', prefixes: ['常州地铁', '常州轨道交通'], province: '江苏省', group: '苏锡常' },
        nanjing: { name: '南京', prefixes: ['南京地铁', '南京有轨电车'], province: '江苏省', group: '南京都市圈' },
        yangzhou: { name: '扬州', prefixes: ['扬州地铁', '扬州轨道交通'], province: '江苏省', group: '南京都市圈' },
        zhenjiang: { name: '镇江', prefixes: ['镇江'], province: '江苏省', group: '南京都市圈' },
        maanshan: { name: '马鞍山', prefixes: ['马鞍山轨道交通', '马鞍山地铁'], province: '安徽省', group: '南京都市圈' },
        chuzhou: { name: '滁州', prefixes: ['滁州轨道交通', '滁州地铁'], province: '安徽省', group: '南京都市圈' },
        taizhou: { name: '泰州', prefixes: ['泰州轨道交通', '泰州地铁'], province: '江苏省', group: '苏中' },
        wuhu: { name: '芜湖', prefixes: ['芜湖轨道交通', '芜湖地铁'], province: '安徽省', group: '南京都市圈' }
      };
    },

    /** 跨区/特殊线路归属表 */
    SPECIAL_LINES() {
      return {
        '苏锡快线': ['suzhou', 'wuxi'],
        '河西线': ['nanjing'],
        '宝华线': ['nanjing', 'zhenjiang'],
        '新城线': ['nanjing']
      };
    },

    /** 判断线路属于哪些地区 key（如 ['shanghai'] / ['suzhou','wuxi']） */
    regionOf(lineOrName) {
      const REGIONS = this.REGIONS();
      const SPECIAL = this.SPECIAL_LINES();
      const name = typeof lineOrName === 'string' ? lineOrName : String((lineOrName && lineOrName.name) || '');
      const found = [];
      for (const key in REGIONS) {
        const r = REGIONS[key];
        if ((r.prefixes || []).some(p => name.indexOf(p) === 0)) {
          if (found.indexOf(key) < 0) found.push(key);
        } else if (name.indexOf(r.name) >= 0) {
          if (found.indexOf(key) < 0) found.push(key);
        }
      }
      if (SPECIAL[name]) {
        SPECIAL[name].forEach(k => { if (found.indexOf(k) < 0) found.push(k); });
      }
      return found;
    },

    /** 地区 key 解析：接受 key 或地区名 */
    regionKeyOf(query) {
      if (!query) return null;
      const q = String(query).trim();
      const ql = q.toLowerCase();
      const REGIONS = this.REGIONS();
      if (REGIONS[ql]) return ql;
      for (const k in REGIONS) if (REGIONS[k].name === q) return k;
      return null;
    },

    /** 按城市/省份/都市圈筛选线路 */
    linesByRegion(query) {
      const REGIONS = this.REGIONS();
      const lines = this.getLines();
      if (!query) return lines;
      const q = String(query).trim();
      const key = this.regionKeyOf(q);
      if (key) {
        return lines.filter(l => this.regionOf(l).indexOf(key) >= 0);
      }
      return lines.filter(l => this.regionOf(l).some(k => REGIONS[k].province === q || REGIONS[k].group === q));
    },

    /** 状态报告：按地区分组列出线路（含分类、站数、节点数、环线、换乘） */
    status(city) {
      const REGIONS = this.REGIONS();
      const lines = city ? this.linesByRegion(city) : this.getLines();
      const anchorCount = l => {
        const sa = l && l.segmentAnchors;
        if (!sa || !sa.length) return 0;
        if (Array.isArray(sa[0])) return sa.reduce((n, seg) => n + (Array.isArray(seg) ? seg.length : 0), 0);
        return sa.length;
      };
      const out = { total: lines.length, query: city || 'all', lines: [] };
      lines.forEach(l => {
        out.lines.push({
          id: l.id, name: l.name, color: l.color,
          stations: (l.stations || []).length,
          anchors: anchorCount(l),
          status: l.status || l._category || 'unknown',
          isRing: !!l.isRing,
          transferStations: (l.stations || []).filter(s => s.isTransfer).length,
          region: this.regionOf(l).map(k => REGIONS[k].name).join('/') || 'unknown'
        });
      });
      out.count = out.lines.length;
      return out;
    },

    /** 地区分组总览 */
    regions() {
      const REGIONS = this.REGIONS();
      const lines = this.getLines();
      const out = { total: lines.length, count: 0, regions: {} };
      Object.keys(REGIONS).forEach(key => {
        const list = lines.filter(l => this.regionOf(l).indexOf(key) >= 0);
        if (!list.length) return;
        out.count++;
        out.regions[key] = {
          name: REGIONS[key].name,
          province: REGIONS[key].province,
          group: REGIONS[key].group,
          count: list.length,
          lines: list.map(l => l.name)
        };
      });
      return out;
    }
  };
})();
