/** 临时验证脚本：上游按 Host 头区分响应，验证 node:http.request 的自定义 Host 送达；验证后删 */
import http from "node:http";
http.createServer((req, res) => {
  const host = req.headers["host"] ?? "";
  if (host.includes("tsfullstack")) {
    setTimeout(() => { res.writeHead(200, { "content-type": "image/svg+xml" }); res.end(`<svg host="tsfullstack">${host}</svg>`); }, 2);
  } else {
    res.writeHead(404, { "content-type": "text/plain" }).end("Service not found: " + host);
  }
}).listen(5300, () => console.log("mock upstream ready"));
