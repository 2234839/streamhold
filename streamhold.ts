/**
 * streamhold — 占位保活代理（scriptc 原生编译版）
 *
 * 用 scriptc 编译为自足原生二进制（100% 静态编译，node:http + 流式 fetch body）。
 * 历史背景：早期版本跑在 LLRT 上（无 node:http，需手写 HTTP/1.1 解析等变通），
 * 后实测 50 并发下 LLRT 会 segfault 且吞吐仅为原生版 1/3.4，已切换到 scriptc，
 * 对比报告见 doc/bench-scriptc-vs-llrt.md。
 *
 * 逻辑：
 * 1. 收到请求后 fetch 上游，等待「首字节窗口」PROBE_MS
 * 2. 窗口内上游开始响应 → 纯透传（热路径）
 * 3. 超时未响应 → 200 + chunked，写未闭合 XML 注释 `<!--`，
 *    每秒喂一个空格保持链路活跃（冷路径）
 * 4. 上游就绪 → `-->` 闭合注释，转发完整响应体
 * 5. 上游失败 → 闭合注释后回极小占位 SVG
 *
 * 运行: scriptc build --optimization speed --strip streamhold.ts -o streamhold && ./streamhold
 */

import http from "node:http";
import type { Immutable, Int32, NoThrow } from "@scriptc/types";

/** 上游基地址，请求按路径规则转发到 UPSTREAM + 实际路径 */
const UPSTREAM = process.env.UPSTREAM ?? "http://127.0.0.1:5300";

/** 路径路由规则表：`规则名=目标服务Host`（Map.get 有静态 lowering，Record 索引落在 dynamic tier） */
const ROUTES = new Map<string, string>();
for (const pair of (process.env.ROUTES ?? "").split(",")) {
  const i = pair.indexOf("=");
  if (i > 0) ROUTES.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
}

/** 格式段 → 冷路径提交的 content-type（只收可安全内嵌 XML 注释的格式）；构建后只读，不朽数据 */
const FORMAT_CONTENT_TYPES: Immutable<Map<string, string>> = new Map([
  ["svg", "image/svg+xml"],
  ["xml", "text/xml"],
]);

/** 环境变量数字解析（Number 构造器落在 dynamic tier，手写解析可静态化；契约：不抛异常 + 32 位整数） */
function envInt(name: string, fallback: Int32): NoThrow<Int32> {
  const v = process.env[name] ?? "";
  if (v.length === 0) return fallback;
  let n: Int32 = 0;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 48 || c > 57) return fallback;
    n = (n * 10 + (c - 48)) | 0;
  }
  return n;
}

/** 监听端口 */
const PORT = envInt("PORT", 5310);
/** 热路径探测窗口（ms） */
const PROBE_MS = envInt("PROBE_MS", 100);
/** padding 心跳间隔（ms） */
const PAD_INTERVAL_MS = envInt("PAD_INTERVAL_MS", 1000);
/** 等待上游总上限（ms） */
const MAX_WAIT_MS = envInt("MAX_WAIT_MS", 30000);

/** 上游失败时的兜底响应：极小透明 SVG */
const FALLBACK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>';

/** 判定是否是可安全内嵌注释 padding 的 XML 族响应（纯函数；不用正则 .test，它在 dynamic tier 会击穿 NoThrow） */
function isPaddingSafe(contentType: string | null): NoThrow<boolean> {
  if (contentType === null) return false;
  const lower = contentType.toLowerCase();
  return lower.includes("svg") || lower.includes("xml") || lower.includes("rss");
}

/** 判定上游响应是否可正常透传（纯函数，不抛异常） */
function isPassThrough(status: number, contentType: string | null): NoThrow<boolean> {
  return status >= 200 && status < 300 && !!contentType;
}

const server = http.createServer((req, res) => {
  (async () => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }

    // 路径路由：/<格式>/<规则名>/<实际路径>（捕获组立即收窄为 string，消除 optional slot）
    const m = url.pathname.match(/^\/([a-z0-9_-]+)\/([^/]+)(\/.*)$/i);
    const fmtKey: string = m?.[1]?.toLowerCase() ?? "";
    if (!m || !FORMAT_CONTENT_TYPES.has(fmtKey)) {
      res.writeHead(404, { "content-type": "text/plain", connection: "close" }).end("expected: /<format>/<rule>/<path>");
      return;
    }
    const format: string = m[1] ?? "";
    const rule: string = m[2] ?? "";
    const restPath: string = m[3] ?? "";
    const targetHost = ROUTES.get(rule);
    if (targetHost === undefined) {
      res.writeHead(404, { "content-type": "text/plain", connection: "close" }).end("unknown rule: " + rule);
      return;
    }

    const upstreamUrl = UPSTREAM + restPath + url.search;
    // scriptc 的 fetch 遵循 WHATWG 规范，Host 是 forbidden header 会被丢弃，
    // 而 DynaPM 上游靠 Host 头路由，因此改用 node:http.request 自控 Host
    let upReq: http.ClientRequest | null = null;
    // 客户端提前断开时中止上游请求
    res.on("close", () => upReq?.destroy());

    /** 从 IncomingMessage.headers（string | string[] | undefined）取单值 */
    function headerVal(h: string | string[] | undefined): string {
      if (Array.isArray(h)) return h[0] ?? "";
      return h ?? "";
    }

    /** 上游首字节结果 */
    type FirstByte =
      | { ok: true; upRes: http.IncomingMessage; first: Uint8Array }
      | { ok: false };
    const firstByte: Promise<FirstByte> = new Promise((resolve) => {
      let settled = false;
      const r = (v: FirstByte) => { if (!settled) { settled = true; resolve(v); } };
      upReq = http.request(upstreamUrl, {
        headers: { accept: req.headers["accept"] ?? "*/*", host: targetHost },
      }, (upRes) => {
        // 首 chunk 后立即 pause，等下游挂好 data/end 监听再 resume，
        // 避免单 chunk 响应在 await 恢复前就发射 end 导致流挂起
        upRes.once("data", (chunk: Uint8Array) => { upRes.pause(); r({ ok: true, upRes, first: chunk }); });
        upRes.once("end", () => r({ ok: true, upRes, first: new Uint8Array(0) }));
        upRes.once("error", () => r({ ok: false }));
      });
      upReq.on("error", () => r({ ok: false }));
      upReq.end();
    });

    const probe: FirstByte | "timeout" = await Promise.race([
      firstByte,
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), PROBE_MS)),
    ]);

    // ── 热路径：上游已出首字节，流式透传（边读边写，零缓冲） ──
    if (probe !== "timeout") {
      if (!probe.ok) {
        res.writeHead(502, { "content-type": "text/plain", connection: "close" }).end("upstream error");
        return;
      }
      const { upRes, first } = probe;
      const upContentType: string = headerVal(upRes.headers["content-type"]) || "application/octet-stream";
      const upCacheControl: string = headerVal(upRes.headers["cache-control"]) || "public, max-age=300";
      res.writeHead(upRes.statusCode ?? 502, {
        "content-type": upContentType,
        "cache-control": upCacheControl,
      });
      res.write(first);
      upRes.on("data", (chunk: Uint8Array) => {
        try { res.write(chunk); } catch { /* 客户端断开 */ }
      });
      upRes.on("end", () => res.end());
      upRes.on("error", () => res.end());
      upRes.resume();
      return;
    }

    // ── 冷路径：注释 padding 模式（chunked 流式） ──
    const padContentType: string = FORMAT_CONTENT_TYPES.get(format.toLowerCase()) ?? "image/svg+xml";
    res.writeHead(200, {
      "content-type": padContentType,
      "cache-control": "public, max-age=60",
    });
    res.write("<!-- ");
    const padTimer = setInterval(() => {
      try { res.write(" "); } catch { clearInterval(padTimer); }
    }, PAD_INTERVAL_MS);
    const deadTimer = setTimeout(() => upReq?.destroy(), MAX_WAIT_MS);

    /** 闭合注释并结束流 */
    const finish = (tail: Uint8Array | string | null) => {
      clearInterval(padTimer);
      clearTimeout(deadTimer);
      try {
        if (tail instanceof Uint8Array) res.write(tail);
        else if (typeof tail === "string") res.write(tail);
        res.end();
      } catch {
        /* 客户端可能已断开 */
      }
    };

    const result = await firstByte;
    if (!result.ok) {
      finish(FALLBACK_SVG);
      return;
    }

    const { upRes, first } = result;
    // 先把 Immutable Map 的值复制为普通 string，再与上游头合并，
    // 避免 Immutable 值流入 dynamic 代码（SC7005）
    const formatCt: string = FORMAT_CONTENT_TYPES.get(format.toLowerCase()) ?? "image/svg+xml";
    const contentType: string = headerVal(upRes.headers["content-type"]) || formatCt;
    if (!isPassThrough(upRes.statusCode ?? 0, contentType) || !isPaddingSafe(contentType)) {
      upRes.destroy();
      finish(FALLBACK_SVG);
      return;
    }

    try {
      res.write("-->\n");
      res.write(first);
      upRes.on("data", (chunk: Uint8Array) => {
        try { res.write(chunk); } catch { /* 客户端断开 */ }
      });
      upRes.on("end", () => {
        clearInterval(padTimer);
        clearTimeout(deadTimer);
        res.end();
      });
      upRes.on("error", () => {
        clearInterval(padTimer);
        clearTimeout(deadTimer);
        try { res.end(); } catch { /* ignore */ }
      });
      upRes.resume();
    } catch {
      /* 客户端断开 */
    }
  })().catch(() => {
    try { res.destroy(); } catch { /* ignore */ }
  });
});

server.on("error", (e) => console.error("[streamhold] server error:", e));
process.on("uncaughtException", (e) => console.error("[streamhold] uncaughtException:", e));
process.on("unhandledRejection", (e) => console.error("[streamhold] unhandledRejection:", e));

server.listen(PORT, () => {
  const routeNames: string[] = [];
  for (const k of ROUTES.keys()) routeNames.push(k);
  console.log(`[streamhold] listening on :${PORT}, upstream=${UPSTREAM}, routes=${routeNames.join(",")}, probe=${PROBE_MS}ms`);
});
