# Phòng chat AI

Phòng chat cá nhân: bạn gửi một tin, Gemini, ChatGPT và Claude (cùng agent khác nếu muốn) thảo luận nhiều vòng, đọc và phản biện ý của nhau, rồi chốt ý. Chạy trên máy bạn, chỉ nghe `127.0.0.1`, lưu dữ liệu trong file cục bộ.

- Node.js 20 trở lên, **không cần cài thư viện nào** (`npm install` không bắt buộc).
- Không tự gọi AI khi mở trang, đổi tên, ghim hay chuyển dự án. Không chạy nền.
- Chưa kết nối thì hiện "Chưa kết nối". Kết nối giả lập luôn có chữ "(giả lập)".

## 1. Khởi động

```bash
cp config.example.json config.json     # config.json đã nằm trong .gitignore
npm start                               # mở http://127.0.0.1:8787
```

Thử giao diện không tốn hạn mức: `npm run mock` (3 AI giả lập, dữ liệu riêng ở `data/mock-db.json`).
Chạy kiểm thử: `npm test`.

## 2. Kết nối từng AI

Trạng thái trên giao diện: **Chưa kết nối** (thiếu CLI/khóa) · **Chưa xác minh** (đã cấu hình, chưa có lượt gọi thành công) · **Đã kết nối** · **Lỗi kết nối** (lỗi xác thực/hết hạn mức; AI đó bị ngừng dùng tới khi bạn bấm ⟳ kiểm tra lại).
Nút ⟳ cạnh tên AI gửi **1 lượt gọi ngắn** để xác minh.

| AI | Cách nối | Bạn cần làm | Nguồn hạn mức |
|---|---|---|---|
| ChatGPT | Codex CLI, `codex exec --json --sandbox read-only` | `npm i -g @openai/codex` rồi `codex login` (chọn Sign in with ChatGPT) | Hạn mức gói ChatGPT |
| Claude | Claude Code CLI, `claude -p --tools ""` | Cài Claude Code, chạy `claude` rồi `/login` bằng tài khoản Pro/Max | Hạn mức gói Pro/Max |
| Gemini | Gemini API (`gemini-api`) | Tạo key ở aistudio.google.com, đặt biến môi trường `GEMINI_API_KEY` trước khi `npm start` | Bậc miễn phí (Google được dùng dữ liệu để cải thiện sản phẩm; không gửi thông tin nhạy cảm) |

Lưu ý quan trọng:
- Ứng dụng **xóa** `OPENAI_API_KEY`, `CODEX_API_KEY`, `ANTHROPIC_API_KEY`… khỏi môi trường của CLI, để CLI không âm thầm chuyển sang API trả phí.
- Không có retry tự động. Lỗi xác thực/hết hạn mức thì dừng AI đó và báo rõ. Không tự đổi model.
- Codex CLI và Claude Code là agent lập trình. Ứng dụng chạy chúng trong thư mục tạm trống: Claude Code bị tắt toàn bộ công cụ (`--tools ""`); Codex chạy sandbox chỉ đọc nhưng **vẫn có thể đọc file trên máy** nếu mô hình tự ý làm vậy. Hướng dẫn hệ thống cấm dùng công cụ, nhưng đó không phải rào chắn kỹ thuật.
- Codex không stream từng chữ: nội dung hiện khi xong lượt. Codex và Claude Code không có cờ giới hạn token đầu ra; độ dài chỉ được giới hạn bằng hướng dẫn (60–100 từ). Gemini API có `maxOutputTokens`.
- Điều khoản Claude: đăng nhập thuê bao chỉ dành cho bạn dùng cá nhân qua Claude Code nguyên gốc. **Không chia sẻ ứng dụng này cho người khác dùng chung tài khoản của bạn.**
- Gemini CLI đã ngừng phục vụ gói Google AI Pro/Ultra từ 18/06/2026. Có sẵn preset `agy` (Antigravity CLI, mục `gemini-agy` trong cấu hình mẫu, đang tắt) nhưng điều khoản Antigravity cấm dùng dịch vụ "cùng sản phẩm không do Google cung cấp" → rủi ro khóa tài khoản. Định dạng đầu ra của `agy` **chưa được xác minh**.

Tham số chỉnh trong `config.json`: `model`, `reasoningEffort` (Codex, mặc định `low` để tiết kiệm), `limits.callTimeoutSec`, `limits.maxConcurrentSessions`, `limits.synthesisOrder` (thứ tự ưu tiên AI chốt ý)…

## 3. Sử dụng

- **Thanh bên**: tạo dự án (tên, mô tả, mục tiêu, hướng dẫn chung), tạo cuộc trò chuyện. Nút `⋯` để đổi tên, ghim, lưu trữ, chuyển dự án, xóa. Bấm tên dự án để tạo cuộc trò chuyện mới trong dự án.
- **Ghim dự án/cuộc trò chuyện** = truy cập nhanh. **Ghim tin nhắn làm ngữ cảnh** = đưa tin đó vào các lượt thảo luận sau (trong cả dự án; ngoài dự án thì chỉ cuộc hiện tại).
- **Gửi**: mọi AI đang bật và đã kết nối cùng trả lời vòng 1 song song; các vòng sau đọc phản hồi của vòng trước.
- **Số vòng tối đa**: 1–100, mặc định 3, lưu theo cuộc trò chuyện. Đổi khi đang chạy được; nếu giảm xuống ≤ vòng hiện tại thì xong vòng này sẽ dừng. Là mức trần: dừng sớm khi mọi AI báo không còn ý mới/đã thống nhất, hoặc đều cần bạn quyết định.
- **Dừng**: không tạo yêu cầu mới, hủy tiến trình/kết nối đang chạy, giữ phản hồi đã nhận. Lượt gọi đã bắt đầu vẫn có thể bị tính vào hạn mức.
- **Gửi tin mới khi đang chạy**: phiên cũ dừng, phản hồi đến muộn của phiên cũ bị bỏ.
- **Thảo luận tiếp**: thêm đúng 1 vòng. Một phiên tối đa 100 vòng; sau đó gửi tin mới để mở phiên mới (tóm tắt được giữ).
- **Chốt ý**: dừng tranh luận, chỉ 1 AI tổng hợp (Kết luận / Điểm còn bất đồng / Thông tin cần bổ sung / Bước tiếp theo). Nếu đang chạy, vòng hiện tại xong thì lượt chốt ý thay cho vòng kế tiếp. Lượt này được tính trong bộ đếm. Bản chốt ý dùng luôn làm tóm tắt chung.
- **Bộ đếm**: "Vòng 4/10", tổng lượt gọi thực tế và theo từng AI. Token chỉ hiện khi nhà cung cấp trả về số liệu. Không hiện chi phí hay % hạn mức vì không có dữ liệu đáng tin cậy.

### Ngữ cảnh gửi đi (tiết kiệm hạn mức)
Mỗi lượt gọi chỉ gồm: hướng dẫn chung, mục tiêu/hướng dẫn dự án, tin ghim, bản tóm tắt, tối đa 8 tin gần nhất trước phiên, tin của bạn, phản hồi đầy đủ của vòng trước và các vòng cũ hơn ở dạng rút gọn. Tóm tắt chỉ cập nhật khi phần chưa tóm tắt vượt `summaryThresholdChars` lúc phiên kết thúc tự nhiên (1 lượt gọi, hiện trong chat và bộ đếm), hoặc khi bạn chốt ý. Không trộn ngữ cảnh giữa các dự án.

## 4. Dùng trên điện thoại

Điện thoại **không** vào được `127.0.0.1` của máy tính. Các cách:
1. **Tailscale (khuyên dùng)**: cài trên cả máy tính và điện thoại, đặt trong `config.json`: `"host": "0.0.0.0"` (hoặc IP Tailscale), `"uiPassword": "<mật khẩu mạnh>"`, `"allowedHosts": ["ten-may.tailnet.ts.net"]`. Mở `http://<tên máy Tailscale>:8787`. Kết nối được mã hóa bởi Tailscale.
2. **Mạng LAN**: giống trên với IP LAN. HTTP trong LAN không mã hóa, chỉ dùng trong mạng tin cậy.

Server từ chối chạy ngoài localhost nếu chưa đặt `uiPassword` (hoặc biến `PHONG_CHAT_UI_PASSWORD`). Không mở cổng ra Internet.

## 5. API cho agent khác

Mô tả OpenAPI: [`docs/openapi.json`](docs/openapi.json) (cũng có tại `GET /v1/openapi.json`). Ví dụ chạy được: [`examples/goi-api.sh`](examples/goi-api.sh).

Tạo khóa trong `config.json > apiKeys` (chuỗi ngẫu nhiên ≥ 24 ký tự, ví dụ `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`):

```json
{ "id": "agent-cua-toi", "key": "<chuỗi ngẫu nhiên>", "scopes": ["read", "write", "control"],
  "projects": ["*"], "maxConcurrentSessions": 1, "requestsPerMinute": 30 }
```

- `scopes`: `read` (xem), `write` (tạo cuộc trò chuyện, gửi chủ đề), `control` (dừng, chốt ý).
- `projects`: `["*"]` tất cả; hoặc danh sách ID dự án; thêm `"none"` để dùng cuộc trò chuyện chưa thuộc dự án.

| Phương thức | Đường dẫn | Việc |
|---|---|---|
| GET | `/v1/agents` | AI/agent và trạng thái kết nối |
| GET | `/v1/projects` | Dự án được cấp quyền |
| GET/POST | `/v1/conversations` | Liệt kê / tạo cuộc trò chuyện |
| POST | `/v1/conversations/{id}/sessions` | Gửi chủ đề: `{message, maxRounds (1–100, bắt buộc), participants?}`; header `Idempotency-Key` chống tạo trùng |
| GET | `/v1/sessions/{id}` | Trạng thái, bộ đếm, toàn bộ tin của phiên |
| POST | `/v1/sessions/{id}/stop` | Dừng |
| POST | `/v1/sessions/{id}/synthesize` | Chốt ý |
| GET | `/v1/sessions/{id}/synthesis` | Lấy bản chốt ý |

```bash
curl -X POST http://127.0.0.1:8787/v1/conversations/<ID>/sessions \
  -H "Authorization: Bearer $PHONG_CHAT_KEY" -H 'content-type: application/json' \
  -H 'Idempotency-Key: lan-1' -d '{"message":"Chủ đề","maxRounds":3}'
```

Lỗi luôn có dạng `{"error":{"code","message","details","requestId"}}`. Giới hạn: số vòng 1–100 (sai thì 400, không tự sửa), số phiên đồng thời theo khóa và toàn hệ thống (429), số yêu cầu/phút, tin ≤ 20.000 ký tự. Phiên do API tạo không cắt ngang phiên đang chạy (409).

Giới hạn cần biết:
- Có điểm tích hợp **không** có nghĩa mọi agent tự kết nối được; cần kiểm tra khả năng và quyền của từng agent đích.
- Ứng dụng **không** thể trở thành thành viên của cuộc chat trên website ChatGPT/Claude/Gemini.
- API chỉ trao đổi văn bản. Không cấp quyền chạy lệnh, sửa file, merge hay deploy. Nội dung từ AI/agent là dữ liệu thảo luận, không phải lệnh.
- Chưa có lớp MCP. Nếu cần, có thể viết một server MCP mỏng gọi lại đúng các endpoint `/v1` này.

## 6. Thêm AI/agent mới

**Không cần sửa bộ điều phối hay giao diện.** Có 3 cách, từ dễ tới khó:

1. **Endpoint tương thích OpenAI Chat Completions** (Ollama, LM Studio, agent tự viết): thêm một mục `type: "openai-compat"` vào `agents` (xem [`examples/adapter-ngoai.json`](examples/adapter-ngoai.json)). Chỉ dùng khi bạn đã kiểm tra endpoint thật sự tương thích. `api.openai.com` bị chặn trừ khi đặt `"allowPaidOpenAI": true` sau khi bạn chấp thuận chi phí.
2. **CLI in văn bản ra stdout**: `type: "cli"`, `preset: "text"`, `command`, `args`. Prompt được gửi qua stdin.
3. **Loại mới**: viết class theo giao diện trong [`src/adapters/base.js`](src/adapters/base.js) (`isConfigured()`, `call({system, prompt, maxOutputTokens, signal, onDelta})`, `capabilities: {streaming, cancel}`), đăng ký trong `src/adapters/index.js`. Với CLI JSONL, thêm một preset trong `src/adapters/cli.js`.

Mỗi agent có `id`, `name`, trạng thái kết nối, và khả năng (streaming / hủy được / trả lời một lần) hiển thị khi rê chuột lên tên. Agent không hủy được thì khi bấm Dừng, phản hồi đến muộn sẽ bị bỏ qua.

## 7. Bảo mật
- Khóa và mật khẩu chỉ nằm trong `config.json` hoặc biến môi trường phía server; không gửi xuống trình duyệt; `config.json` và `data/` nằm trong `.gitignore`.
- Log không ghi nội dung tin nhắn hay khóa.
- Giao diện chặn yêu cầu ghi từ trang web lạ (header riêng `X-Phong-Chat`) và Host lạ (chống DNS rebinding).

## 8. Cấu trúc mã

```
server.js               HTTP server, phục vụ giao diện, SSE, định tuyến
src/orchestrator.js     Bộ điều phối nhiều vòng: phiên, vòng, dừng, dừng sớm, chốt ý, tóm tắt
src/context.js          Dựng ngữ cảnh gọn, tách trạng thái nội bộ <<<TRANG_THAI: …>>>
src/adapters/           cli.js (Codex, Claude Code, agy, lệnh tùy chỉnh), http.js (Gemini API, OpenAI-compat), mock.js
src/api-ui.js           API cho giao diện
src/api-v1.js           API cho agent ngoài (xác thực, phạm vi, idempotency, giới hạn)
src/store.js            Lưu file JSON cục bộ (data/db.json)
public/                 Giao diện HTML/CSS/JS thuần
test/                   Kiểm thử bằng kết nối giả lập
```

## 9. Tình trạng xác minh (03/11/2026)

| Hạng mục | Tình trạng |
|---|---|
| Bộ điều phối, dừng, dừng sớm, chốt ý, giới hạn vòng, lưu trữ, API `/v1` | ✅ Đã kiểm tra bằng **kết nối giả lập** (`npm test`, 23 bài) và trình duyệt (máy tính + iPhone 13 giả lập) |
| Bộ đọc đầu ra Claude Code (`stream-json`) và Codex (`--json`) | ✅ Theo tài liệu + `--help`; kiểm tra bằng script giả lập sự kiện mẫu. ❌ **Chưa gọi thật** |
| Gemini API (`streamGenerateContent`, SSE) | ✅ Theo tài liệu. ❌ **Chưa gọi thật** |
| Antigravity CLI (`agy`) | ⚠️ Chỉ theo tài liệu; không tải được CLI để kiểm tra; định dạng sự kiện là giả định; rủi ro điều khoản |
| Endpoint tương thích OpenAI | ⚠️ Phụ thuộc từng endpoint; bạn tự xác minh |
| Chạy trên Windows | ⚠️ Có xử lý gọi `.cmd` qua shell, chưa kiểm tra trên Windows |

Bước xác minh thật trên máy bạn: chạy `npm start`, bấm ⟳ cạnh từng AI (mỗi AI 1 lượt gọi ngắn). Nếu trạng thái chuyển "Đã kết nối" thì kết nối đã hoạt động; nếu lỗi, thông báo lỗi của CLI/API sẽ hiện khi rê chuột lên tên AI.
