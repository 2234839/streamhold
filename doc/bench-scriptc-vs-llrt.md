# streamhold scriptc 重写与性能对比（2026-11-10）

## 对比对象

| 版本 | 文件 | 说明 |
|---|---|---|
| scriptc 0.4.10 原生 | `streamhold.scriptc.ts` → `streamhold-scriptc` (2.5MB) | 100% 静态编译，node:http + 流式 fetch body |
| LLRT（现有生产） | `streamhold.ts` → `streamhold.lrt` (6.2K) | net + 手写 HTTP/1.1（LLRT 无 node:http） |
| bun（参照） | `bun streamhold.ts` | 同一份 LLRT 代码跑 bun |

## 测试方法

- 上游：bun 模拟服务，2ms 延迟返回 ~1KB SVG（`bench/upstream.ts`）
- 压测：`bench/bench.ts`，50 并发 × 3000 请求，本机回环
- 冷路径：3s 慢上游验证 chunked padding 行为

## 结果（热路径，3 轮）

| 目标 | RPS | p50 / p90 / p99 (ms) |
|---|---|---|
| 直连上游（上限参照） | ~17900 | 2.6 / 3.1 / 6 |
| **scriptc 版** | **~11250** | 4.0 / 5.7 / 10 |
| bun 跑 TS 源码 | ~3980 | 9.5~11.7 / 18~21 / 25~29 |
| LLRT 版 | ~3300（存活轮） | 12.9 / 20 / 40 |

- scriptc 版吞吐 ≈ LLRT 版 **3.4 倍**，代理开销仅 37%（11250 vs 17900 直连）
- 延迟 p50：scriptc 4ms vs LLRT 13ms（3 倍+）

## 启动与内存

| 版本 | 启动到 healthz | RSS |
|---|---|---|
| scriptc | 14ms | 4.0 MB |
| LLRT | 11ms | 8.8 MB |

## 稳定性

- **LLRT 版在 50 并发压测下两次段错误（segfault）崩溃**，第二轮压测稳定复现
- scriptc 版 3×3000 请求 + 多轮压测零错误零崩溃

## scriptc 编译注意点

- `res.writeHead` header 值必须显式收窄为 `string`（`?? "xxx"` 后再赋给 `: string` 变量），`string | undefined` / `unknown` 无 lowering
- `res.write` 参数联合类型需先 `instanceof` / `typeof` 收窄
- coverage 工具给出的 hint 很准，按提示改即可到 fully static

## 结论

scriptc 重写在吞吐、延迟、内存上全面优于 LLRT 版，且修复了 LLRT 高并发崩溃问题；代价是产物 2.5MB（vs 6.2K）与 AOT 编译步骤。生产可考虑切换。
