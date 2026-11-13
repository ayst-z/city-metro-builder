# city-metro-builder（beta1.0）

Cities Designers（citiesdesigners.com 城市设计师·地铁模拟）官方接口绘线 + 全自动经营托管 Agent 技能。
Agent skill for drawing metro lines and fully-automatic business-mode operations hosting in Cities Designers, using the game's official interfaces.

## 内容 / Contents
- `SKILL.md` 主指南（全局硬规则/绘线/节点/检查/经营/规划图复刻）。
- `references/` 专题：`plan-map-draw.md`（图纸→几何）、`metro-planning-principles.md`（客观第一规划原理）、`operations.md`（经营与托管）等。
- `scripts/funcs/` 注入工具箱：MT 查询 / OD 绘线 / K 管理 / Ops 运营 / OE 官方编辑 / FareLab 票价 / modes 多模式 / `draw/plan-map.js` / `ops/autopilot.js`（全自动经营托管）。
- `scripts/plan-map.py` 离线图像配准 + 色带追踪。
- `_dev/` 回归（Python + Node VM）。

## 安装 / Install
拷贝本目录到 agent skills 目录；或按序注入 `scripts/funcs/`：mt-core → mt-node → mt-amap → od → k →（可选）plan-map / ops / autopilot / official-edit / fare-lab / modes。
Copy into your agent skills dir, or inject in order mt-core → mt-node → mt-amap → od → k → (optional) plan-map / ops / autopilot / official-edit / fare-lab / modes.

## 全自动经营托管 / Autopilot
仅经营模式（management）。`MetroAutopilot.start({intervalMs,maxTicks,buyPacks,dryRun})` / `stop()` / `status()`。
每 tick：官方五段票价→逐交路排班→额度内快车/小交路→递增报价购配额(留日结)→恢复模拟→营收复核→日志；失败即停、劣化回滚、不存档/不抢前台。
Business-mode only; bounded loop with official five-band fares, per-leg scheduling, quota purchase with daily reserve, revenue verify & rollback; no saving, no foreground grab.

## 测试 / Test
python _dev/test-plan-map.py; node _dev/test-plan-poi.js; node _dev/test-plan-draw.js; node _dev/test-autopilot.js; node _dev/smoke.js; node _dev/lint-static.js

## 许可 / License
MIT（见 LICENSE）。数据与算法来源：docs/THIRD_PARTY.md。

## 赞赏 / Support

如果这个项目对你有帮助，欢迎扫码赞赏（卧龙凤雏 的赞赏码）：

![reward-qr](docs/reward-qr.png)

If this project helps you, feel free to support via the reward QR above.
