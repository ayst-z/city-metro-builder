# 隐私与数据合规说明

> 适用版本：beta1.1 · 审核日期：2026-11-13

## 结论

发行包（`city-metro-builder-beta1.1-oss.zip`）与仓库变体均**不含**个人数据、本机路径、密钥或城市站点数据集；扫描 0 命中。

## 审核范围

对两个发行变体的全部文本文件逐行扫描，并对 screenshots 做人工目检：

| 检查项 | 规则 | 结果 |
|---|---|---|
| 本机绝对路径 | 盘符 + 用户目录 / 系统目录（含正反斜杠写法） | 0 |
| 用户名 / 主机名 | 本机用户名、计算机名 | 0 |
| 邮箱 / 手机号 | 邮箱格式、中国大陆手机号 | 0 |
| 凭据 | GitHub / OpenAI / 云厂商 token 前缀、api_key 赋值、URL 内嵌 key | 0 |
| 本机服务地址 | 回环地址、本地端口 | 0 |
| 私有产物 | 游戏存档、Edge/浏览器 profile、截图缓存 | 0 |
| 第三方数据 | 高德 srhdata 整表、城市站表、版权规划图 | 0（不含数据集） |
| 图片元数据 | PNG/JPEG 文本块、EXIF | 0 |

唯一与「存档」相关的文本出现在 `references/operations.md`，只是说明游戏官方存档文件名 `城市设计师_*.mbenc`，不含任何真实存档。

## 截图说明

- `docs/preview-network.png`、`docs/preview-plan-line.png`、`docs/preview-line-props.png` 均为游戏真实渲染，画面只有线网、站名、地图底图与属性面板；无账号、昵称、存档名、聊天或个人信息。
- 地图底图版权归高德/游戏方，仅作功能展示。
- 仓库变体额外包含 `docs/reward-qr.png`（作者赞赏码），**纯净发行包不含**。

## 数据与算法来源

- 地图与车站数据由高德（AMap）公开接口与 OpenStreetMap 实时查询，**不内置任何城市数据集**；用户侧需遵守各提供方条款。
- 坐标转换（GCJ-02/WGS-84/BD-09）、Catmull-Rom、Douglas-Peucker、Chaikin、A* 为公共领域公式或公共算法的原创实现。
- 详见 [THIRD_PARTY.md](THIRD_PARTY.md)。

## 不含什么

- 个人存档、账号登录态、浏览器 profile；
- 本机路径、用户名、SSH key、API token；
- 城市站点全量数据、版权规划图纸；
- 内部调试脚本、临时文件、评测数据。

## 如何复核

发布前用工作区的 `tools/privacy-audit.mjs` 对 `release/city-metro-builder-oss` 与 `release/city-metro-builder-repo` 全量扫描（文本规则 + 图片元数据），命中即构建失败；截图另做人工目检。
