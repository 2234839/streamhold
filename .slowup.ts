/** 临时冷路径验证：上游延迟 600ms 才出首字节，触发 padding 模式；验证后删 */
import http from "node:http";
http.createServer((req, res) => {
  const host = req.headers["host"] ?? "";
  setTimeout(() => { res.writeHead(200, { "content-type": "image/svg+xml" }); res.end(`<svg cold="${host}"/>`); }, 600);
}).listen(5300, () => console.log("slow mock ready"));
