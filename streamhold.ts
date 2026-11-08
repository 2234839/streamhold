/**
 * streamhold — 占位保活代理（LLRT 版，net + 手写 HTTP/1.1 桥）
 *
 * LLRT 官方兼容矩阵中 node:http 为 ✘（未实现），无法用 http.createServer；
 * 本实现沿用 web-font 项目已验证的模式：net.createServer 收 socket，
 * 手写解析 HTTP/1.1 请求头，流式写回响应（含 chunked padding 心跳）。
 *
 * 解决场景：被代理的上游是冷启动服务，首次请求要等 2~4s。中间链路上的
 * 急性子代理（GitHub camo 约 3~12s 耐心、nginx 空闲超时）会在无响应字节
 * 期间放弃（499/504），导致 README 图片裂图。
 *
 * 工作原理（content-agnostic，不解析内容，只做字节搬运）：
 * 1. 收到请求后 fetch 上游，等待「首字节窗口」PROBE_MS
 * 2. 窗口内上游开始响应 → 纯透传，零额外字节（热路径）
 * 3. 超时未响应 → 立即回 200 + chunked：写未闭合 XML 注释 `<!--`，
 *    每秒喂一个空格保持链路活跃（渲染器忽略注释，代理超时被字节喂饱）
 * 4. 上游就绪 → 写 `-->` 闭合注释，转发完整响应体（冷路径）
 * 5. 上游失败 → 闭合注释后回极小占位 SVG，保证流完整收尾不裂
 *
 * 运行: ./llrt streamhold.js
 * 配置: 环境变量（见 README / .env.example）
 */

import net from "node:net";

/**
 * 上游基地址（DynaPM 网关），请求按路径规则转发到 UPSTREAM + 实际路径
 */
const UPSTREAM = process.env.UPSTREAM ?? "http://127.0.0.1:5300";
/**
 * 路径路由规则表。格式：`规则名=目标服务Host,规则名2=目标服务Host2`
 * 请求路径形如 `/<格式>/<规则名>/<实际路径>`，例如：
 *   /svg/tsfullstack/group/gs.svg → 转发到 /group/gs.svg，Host 头为规则匹配的服务域名
 * 「格式」段声明流式响应的内容类型（svg/xml 等可安全内嵌注释 padding 的格式）
 */
const ROUTES: Record<string, string> = {};
for (const pair of (process.env.ROUTES ?? "").split(",")) {
  const i = pair.indexOf("=");
  if (i > 0) ROUTES[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
}
/**
 * 格式段 → 冷路径 padding 模式下提交给客户端的 content-type。
 * 只收可安全内嵌 XML 注释的格式；未声明格式的请求直接 404。
 * @type {Record<string,string>}
 */
const FORMAT_CONTENT_TYPES: Record<string, string> = {
  svg: "image/svg+xml",
  xml: "text/xml",
};
/**
 * 监听端口
 */
const PORT = Number(process.env.PORT ?? 5310);
/**
 * 热路径探测窗口（ms）：窗口内上游开始响应则纯透传
 */
const PROBE_MS = Number(process.env.PROBE_MS ?? 100);
/**
 * padding 心跳间隔（ms），需小于链路上最短的空闲超时
 */
const PAD_INTERVAL_MS = Number(process.env.PAD_INTERVAL_MS ?? 1000);
/**
 * 等待上游总上限（ms），超过则放弃上游返回占位图
 */
const MAX_WAIT_MS = Number(process.env.MAX_WAIT_MS ?? 30000);

/**
 * 上游失败时的兜底响应：极小透明 SVG，保证流完整收尾
 */
const FALLBACK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>';

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

/**
 * 判定是否是需要注释 padding 保护的 XML 族响应（可安全内嵌注释）
 * @param {string | null} contentType
 */
function isPaddingSafe(contentType: string | null) {
  return /image\/svg|text\/xml|application\/xml|application\/rss/i.test(contentType ?? "");
}

/**
 * 判定上游响应是否可正常透传
 * @param {number} status
 * @param {string | null} contentType
 */
function isPassThrough(status: number, contentType: string | null) {
  return status >= 200 && status < 300 && !!contentType;
}

/**
 * @param {number} ms
 */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 从 socket 可读流中读出 HTTP 请求头（及多余的首段 body 字节）。
 * 只支持 streamhold 场景：GET/HEAD 无 body，读到 \r\n\r\n 即完成。
 * @param {import("node:net").Socket} socket
 * @returns {Promise<{ method: string, url: string, headers: Record<string,string> } | null>}
 */
interface HttpRequestHead {
  method: string;
  url: string;
  headers: Record<string, string>;
}

function readHttpRequest(socket: net.Socket): Promise<HttpRequestHead | null> {
  return new Promise((resolve) => {
    let buf: Buffer[] = [];
    let total = 0;
    const onData = (chunk: Buffer) => {
      buf.push(chunk);
      total += chunk.length;
      // 纯字节扫描找 \r\n\r\n（LLRT 的 Buffer.indexOf 对 Buffer 参数不可靠）
      const joined = Buffer.concat(buf, total);
      let idx = -1;
      for (let i = 0; i + 3 < joined.length; i++) {
        if (
          joined[i] === 13 && joined[i + 1] === 10 &&
          joined[i + 2] === 13 && joined[i + 3] === 10
        ) {
          idx = i;
          break;
        }
      }
      if (idx === -1) {
        if (total > 16384) {
          // 头部异常巨大，防滥用直接断
          socket.destroy();
          resolve(null);
        }
        return;
      }
      socket.removeListener("data", onData);
      const headText = joined.toString("utf-8", 0, idx);
      const lines = headText.split("\r\n");
      const [method, url] = (lines[0] ?? "").split(" ");
      const headers: Record<string, string> = {};
      for (let i = 1; i < lines.length; i++) {
        const c = lines[i].indexOf(":");
        if (c === -1) continue;
        headers[lines[i].slice(0, c).trim().toLowerCase()] = lines[i].slice(c + 1).trim();
      }
      resolve({ method, url, headers });
    };
    socket.on("data", onData);
    socket.on("error", () => resolve(null));
    socket.on("close", () => resolve(null));
  });
}

const server = net.createServer((socket) => {
  (async () => {
    const req = await readHttpRequest(socket);
    if (!req) return;
    const url = new URL(req.url, "http://localhost");

    // 健康检查：供网关健康检查使用
    if (url.pathname === "/healthz") {
      // LLRT 的 socket.end 参数签名异常（string/Buffer 都抛 TypeError），统一 write + 延迟 destroy 代替
      socket.write(Buffer.from("HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok"));
      setTimeout(() => socket.destroy(), 50);
      return;
    }

    // 路径路由：/<格式>/<规则名>/<实际路径>
    const m = url.pathname.match(/^\/([a-z0-9_-]+)\/([^/]+)(\/.*)$/i);
    if (!m || !(m[1].toLowerCase() in FORMAT_CONTENT_TYPES)) {
      socket.write(Buffer.from("HTTP/1.1 404 Not Found\r\ncontent-type: text/plain\r\ncontent-length: 33\r\nconnection: close\r\n\r\nexpected: /<format>/<rule>/<path>"));
      setTimeout(() => socket.destroy(), 50);
      return;
  }
    const [, format, rule, restPath] = m;
    const targetHost = ROUTES[rule];
    if (!targetHost) {
      socket.write(Buffer.from(`HTTP/1.1 404 Not Found\r\ncontent-type: text/plain\r\ncontent-length: ${`unknown rule: ${rule}`.length}\r\nconnection: close\r\n\r\nunknown rule: ${rule}`));
      setTimeout(() => socket.destroy(), 50);
      return;
    }

    const upstreamUrl = UPSTREAM + restPath + url.search;
    const ac = new AbortController();

    /**
     * 上游结果统一形态。LLRT 的 fetch 无流式 body（response.body 为 undefined），
     * 只能 arrayBuffer() 整读；有流式 body 的运行时走 reader 逐块读。
     */
    type UpstreamResult =
      | { kind: "first-chunk"; upRes: Response; reader: ReadableStreamDefaultReader<Uint8Array> | null; first?: ReadableStreamDefaultReader<Uint8Array>["read"] extends () => Promise<infer R> ? R : never; whole?: Uint8Array }
      | { kind: "fail"; status: number; error: unknown }
      | { kind: "timeout" };
    const firstByte: Promise<UpstreamResult> = fetch(upstreamUrl, {
      signal: ac.signal,
      headers: {
        accept: req.headers["accept"] ?? "*/*",
        host: targetHost,
      },
    }).then(async (upRes) => {
      const reader = upRes.body?.getReader();
      if (reader) {
        try {
          const first = await reader.read();
          return { kind: "first-chunk" as const, upRes, reader, first };
        } catch (e) {
          return { kind: "fail" as const, status: upRes.status, error: e };
        }
      }
      // LLRT 路径：无流式 body，整读（图片 KB 级，可接受）
      try {
        const ab = await upRes.arrayBuffer();
        return {
          kind: "first-chunk" as const,
          upRes,
          reader: null,
          whole: new Uint8Array(ab),
        };
      } catch (e) {
        return { kind: "fail" as const, status: upRes.status, error: e };
      }
    }).catch((e) => ({ kind: "fail" as const, status: 0, error: e }));

    const probe = await Promise.race([
      firstByte,
      sleep(PROBE_MS).then(() => ({ kind: "timeout" as const })),
    ]);

    // 客户端提前断开（camo 放弃）时中止上游请求，避免空转
    socket.on("close", () => ac.abort());

    // ── 热路径：上游已出首字节，纯透传（Content-Length 已知） ──
    if (probe.kind === "first-chunk") {
      const { upRes, reader, first, whole } = probe;
      // 先读完全部 body 再决定 Content-Length：本实现不写 chunked 透传，
      // 靠先收齐来避免截断。图片是 KB 级，socket 缓存足够。
      /** @type {Uint8Array[]} */
      const chunks = whole ? [whole] : [new Uint8Array(first?.value ?? [])];
      let len = chunks[0].length;
      if (reader) {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(new Uint8Array(value));
            len += value.length;
          }
        } catch {
          /* 上游中断：已收到的部分仍可完整回给客户端 */
        }
      }
      const head =
        `HTTP/1.1 ${upRes.status} OK\r\n` +
        `content-type: ${upRes.headers.get("content-type") ?? "application/octet-stream"}\r\n` +
        `cache-control: ${upRes.headers.get("cache-control") ?? "public, max-age=300"}\r\n` +
        `content-length: ${len}\r\nconnection: close\r\n\r\n`;
      const frame = new Uint8Array(head.length + len);
      frame.set(encoder.encode(head));
      let off = head.length;
      for (const c of chunks) {
        frame.set(c, off);
        off += c.length;
      }
      try {
        socket.write(Buffer.from(frame));
      } catch {
        /* ignore */
      }
      return;
    }

    // ── 冷路径：注释 padding 模式（chunked 流式） ──
    // 提交的 content-type 由格式段决定
    socket.write(
      `HTTP/1.1 200 OK\r\ncontent-type: ${FORMAT_CONTENT_TYPES[format.toLowerCase()]}\r\n` +
        "cache-control: public, max-age=60\r\n" +
        "transfer-encoding: chunked\r\nconnection: close\r\n\r\n",
    );
    /** chunked 编码写一段数据 */
    const writeChunk = (data: Uint8Array | string) => {
      if (typeof data === "string") data = encoder.encode(data);
      // 尺寸行/数据/分隔符合并单次 write：LLRT 多次 write 组合有丢失风险
      const sizeLine = encoder.encode(`${data.length.toString(16)}\r\n`);
      const crlf = encoder.encode("\r\n");
      const frame = new Uint8Array(sizeLine.length + data.length + crlf.length);
      frame.set(sizeLine);
      frame.set(data, sizeLine.length);
      frame.set(crlf, sizeLine.length + data.length);
      socket.write(Buffer.from(frame));
    };
    // 立即开注释：等待上游期间链路上必须一直有字节，
    // 否则中间代理的空闲超时会掐断请求
    writeChunk("<!-- ");
    const padTimer = setInterval(() => {
      try {
        writeChunk(" ");
      } catch {
        clearInterval(padTimer);
      }
    }, PAD_INTERVAL_MS);
    const deadTimer = setTimeout(() => ac.abort(), MAX_WAIT_MS);

    /** 闭合注释并结束流 */
    const finish = (tail: Uint8Array | null) => {
      clearInterval(padTimer);
      clearTimeout(deadTimer);
      try {
        if (tail) writeChunk(tail);
        try { socket.write(Buffer.from("0\r\n\r\n")); } catch {}
        setTimeout(() => socket.destroy(), 50);
      } catch {
        /* 客户端可能已断开 */
      }
    };

    const result = await firstByte;

    if (result.kind !== "first-chunk") {
      // 上游最终失败：闭合注释后给极小占位，保证流完整收尾
      finish(encoder.encode(FALLBACK_SVG));
      return;
    }

    const { upRes, reader, first, whole } = result;
    const contentType = upRes.headers.get("content-type") ?? FORMAT_CONTENT_TYPES[format.toLowerCase()];

    if (!isPassThrough(upRes.status, contentType) || !isPaddingSafe(contentType)) {
      // 非 2xx 或不适合 padding 的内容（流已提交 200 + 注释）：
      // 闭合注释后给极小占位，保证流完整收尾
      finish(encoder.encode(FALLBACK_SVG));
      return;
    }

    // 冷启动成功路径：闭合注释段，转发完整响应体
    try {
      writeChunk("-->\n");
      if (whole) {
        writeChunk(whole);
      } else {
        writeChunk(new Uint8Array(first?.value ?? []));
        for (;;) {
          const { done, value } = await reader!.read();
          if (done) break;
          writeChunk(new Uint8Array(value));
        }
      }
      clearInterval(padTimer);
      clearTimeout(deadTimer);
      try { socket.write(Buffer.from("0\r\n\r\n")); } catch {}
      setTimeout(() => socket.destroy(), 50);
    } catch {
      /* 客户端断开 */
    }
  })().catch(() => {
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
  });
});

server.on("error", (e) => {
  console.error("[streamhold] server error:", e);
});

process.on?.("uncaughtException", (e) => {
  console.error("[streamhold] uncaughtException:", e);
});

process.on?.("unhandledRejection", (e) => {
  console.error("[streamhold] unhandledRejection:", e);
});

server.listen(PORT, () => {
  console.log(`[streamhold] listening on :${PORT}, upstream=${UPSTREAM}, routes=${Object.keys(ROUTES).join(",")}, probe=${PROBE_MS}ms`);
});
