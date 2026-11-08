# streamhold

[![扫码加入开发者社群](https://streamhold.heartstack.space/svg/tsfullstack/group/gs.svg?from=streamhold)](https://tsfullstack.heartstack.space/group/gs?from=streamhold)

**[English](README.md) | 简体中文**

占位保活反代：让**冷启动上游**的图片请求在**急性子代理**面前永不超时。

## 解决什么问题

被代理的上游是按需冷启动的服务（如 [DynaPM](https://github.com/2234839/DynaPM) 托管的服务），
首次请求要等 2\~4 秒才吐出首字节。中间链路上的代理（GitHub camo 约 3\~12 秒耐心、
各类 CDN/网关的空闲超时）在「已连接但无字节」期间会放弃请求（499/504），
导致 README 图片裂图。

这是一个普遍问题——参见 GitHub 社区讨论 [#143996](https://github.com/orgs/community/discussions/143996)
和 [#183464](https://github.com/orgs/community/discussions/183464)。那两个案例的根因是公共统计卡服务不稳定；
streamhold 针对的是同样的症状、但不同的根因：**自己的后端服务冷启动**。无论哪种，
camo 都会在首字节到来前放弃，streamhold 通过握住流直到上游就绪来根治。

## 工作原理

纯字节搬运，不解析内容：

1. 收到请求 → 立即向上游发起真实请求，等待 **100ms 首字节探测窗口**
2. 窗口内上游开始响应 → **纯透传**，零额外字节（热路径）
3. 窗口超时 → 立即提交 `200 + chunked` 流：写入未闭合的 XML 注释 `<!--`，
   每秒喂一个空格保持链路活跃（渲染器忽略注释，代理的空闲超时被字节喂饱）
4. 上游就绪 → 写入 `-->` 闭合注释，流式转发完整响应体（冷路径）
5. 上游失败/超时 → 闭合注释后返回极小的透明 SVG 占位，保证流完整收尾

padding 字节只是 XML 注释，对 `image/svg+xml` 完全合法；下游缓存（camo/Fastly）
拿到的也是完整合法响应，不会钉死半成品。

## 运行

```bash
cp .env.example .env   # 按需修改（.env 不入库，已 gitignore）
bun run streamhold.ts
```

## 路由规则

请求路径格式：`/<格式>/<规则名>/<实际路径>`，例如：

```
/svg/tsfullstack/group/gs.svg
│   │           └── 转发到上游的实际访问路径（原样拼接 search）
│   └── 规则名，在 ROUTES 环境变量中匹配目标服务域名（作为 Host 头发上游）
└── 格式声明：流式响应的内容类型（svg→image/svg+xml，xml→text/xml），
    决定冷路径 padding 模式提交的 content-type
```

## 配置（.env）

| 变量 | 默认 | 说明 |
|---|---|---|
| `UPSTREAM` | `http://127.0.0.1:5300` | 上游基地址（网关或具体服务） |
| `ROUTES` | — | 路由规则表：`规则名=目标服务Host,规则名2=Host2`，如 `tsfullstack=tsfullstack.heartstack.space` |
| `PORT` | `5310` | 监听端口 |
| `PROBE_MS` | `100` | 热路径探测窗口（ms） |
| `PAD_INTERVAL_MS` | `1000` | padding 心跳间隔，需小于链路最短空闲超时 |
| `MAX_WAIT_MS` | `30000` | 等待上游总上限，超时返回占位图 |

`GET /healthz` 返回 `ok`，供网关健康检查使用。

## 与 DynaPM 配合

本服务启动只需十几毫秒，**直接由 DynaPM 冷托管即可**（无需 keepWarm）：请求到达时网关
把它拉起再转发，冷启动延迟几乎无感；它先向上游探测，上游就绪前用注释 padding 喂饱
链路，所以后面的业务服务冷启动慢完全没关系。前端（nginx location / 图片 URL）指向
本服务端口即可。

## 部署

```bash
# 一条命令：转译 + 编译字节码 + 推服务器（llrt 不支持 TS 语法剥离，必须先转译）
bun run deploy

# 等价分步：
# tsdown                              # TS → streamhold.js（node 平台 cjs，保留 node:net 原生模块）
# llrt compile streamhold.js          # JS → streamhold.lrt（字节码 + zstd）
# scp streamhold.lrt root@<服务器>:/root/app/streamhold/
```

服务器上由 DynaPM 托管：配置好启动命令（`llrt streamhold.lrt`）、环境变量
（.env 不会被 LLRT 自动加载，需由 DynaPM 的 env 注入）和健康检查
（`/healthz`）即可，首次部署或更新只做上面一条命令。注意 `.lrt` 是绑定 llrt
版本的字节码，升级服务器 llrt 版本后需重新编译上传。
