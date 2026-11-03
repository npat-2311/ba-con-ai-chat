#!/usr/bin/env bash
# Ví dụ gọi API của Phòng chat AI từ một agent/công cụ khác.
# Cần: server đang chạy, và PHONG_CHAT_KEY trùng một khóa trong config.json > apiKeys.
set -euo pipefail
BASE="${PHONG_CHAT_URL:-http://127.0.0.1:8787}"
AUTH="Authorization: Bearer ${PHONG_CHAT_KEY:?Đặt biến PHONG_CHAT_KEY}"

# 1. Tạo cuộc trò chuyện (projectId có thể bỏ trống)
CONV=$(curl -sf -X POST "$BASE/v1/conversations" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"title":"Hỏi từ agent"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
echo "Cuộc trò chuyện: $CONV"

# 2. Gửi chủ đề, 3 vòng tối đa. Idempotency-Key giúp gửi lại không tạo phiên trùng.
SES=$(curl -sf -X POST "$BASE/v1/conversations/$CONV/sessions" -H "$AUTH" -H 'content-type: application/json' \
  -H "Idempotency-Key: vi-du-$(date +%Y%m%d%H%M)" \
  -d '{"message":"Ba rủi ro lớn nhất khi mở quán cà phê nhỏ?","maxRounds":3}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
echo "Phiên: $SES"

# 3. Theo dõi trạng thái (mỗi 3 giây, tối đa ~5 phút)
for i in $(seq 1 100); do
  STATUS=$(curl -sf "$BASE/v1/sessions/$SES" -H "$AUTH" | node -pe 'const s=JSON.parse(require("fs").readFileSync(0)); `${s.status} vòng ${s.round}/${s.maxRounds}, ${s.calls.total} lượt gọi`')
  echo "$STATUS"
  case "$STATUS" in running*|stopping*|synthesizing*) sleep 3 ;; *) break ;; esac
done

# 4. Chốt ý (1 lượt gọi thêm) rồi lấy bản tổng hợp
curl -sf -X POST "$BASE/v1/sessions/$SES/synthesize" -H "$AUTH" > /dev/null
for i in $(seq 1 60); do
  OUT=$(curl -s "$BASE/v1/sessions/$SES/synthesis" -H "$AUTH")
  if echo "$OUT" | grep -q '"synthesis"'; then echo "$OUT" | node -pe 'JSON.parse(require("fs").readFileSync(0)).synthesis'; exit 0; fi
  sleep 3
done
echo "Chưa có bản tổng hợp"
