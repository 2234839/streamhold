#!/bin/bash
# 冷路径验证：TTFB 应远小于 600ms（padding 立即提交），total 应约 600ms 且流正常终结
curl -sm5 -o /tmp/cold.out -w "ttfb=%{time_starttransfer}s total=%{time_total}s status=%{http_code}\n" http://127.0.0.1:5310/svg/tsfullstack/group/gs.svg
echo "-- body head:"
head -c 60 /tmp/cold.out
echo ""
echo -n "healthz: "
curl -sm3 http://127.0.0.1:5310/healthz
echo ""
