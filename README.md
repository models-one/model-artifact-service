# Model Artifact Service

独立的 Bun / TypeScript 服务。调用方决定提示词、模型、生成参数及调用时间；服务执行一次生成，保存文本与 SVG，并生成 PNG 预览。支持 OpenAI 兼容 Chat Completions、Responses 和 Anthropic Messages。

没有评分、模型调用定时计划、自动重新生成、前端或平台专属逻辑。一次请求只生成一份作品，任务状态通过轮询查询。也可接收调用方已生成的文本，仅执行作品处理。单实例持久化运行，不需要 Redis；不支持共享 SQLite 的多机双活。

## 启动

需要 Bun 1.3.12 或经过验证的更新版本。

```sh
bun install --frozen-lockfile
cp config.example.json config.json
cp .env.example .env
# 编辑 config.json 和 .env，删除不用的连接，并设置真实密钥。
bun start
```

生成服务令牌：`bun -e 'console.log(crypto.randomUUID() + crypto.randomUUID())'`。不要使用示例占位值。`config.json` 和 `.env` 被 Git 忽略。

`base_url` 是 API 根地址，通常包含 `/v1`；例如网关地址可以包含自定义前缀。协议适配器只附加 `chat/completions`、`responses` 或 `messages`，不猜测或改写地址。模型名完全由每次请求决定。

连接仅由部署配置定义，不接受调用者传入任意 URL、请求头或密钥。每个客户端配置自己的令牌环境变量、允许的连接和可选 `expires_at`（UTC ISO 时间）。修改或删除令牌后重启服务即可轮换或撤销；已过期令牌立即失效。上游 HTTP 默认禁止，仅可信本地网络可显式设置 `allow_http: true`。服务对外部署时通过 HTTPS 反向代理访问。

Anthropic 默认使用 `x-api-key` 和兼容版本 `2023-06-01`，支持在连接配置中改为 `auth: "bearer"` 或其他 `anthropic_version`，以匹配实际提供方。

## API

除 `/healthz`、`/openapi.json` 外均要求 `Authorization: Bearer <SERVICE_TOKEN>`。令牌从不放入 URL。调用方只能查询自己的任务和文件；服务没有浏览器 Cookie 会话。

| 方法 | 地址                                              | 用途                              |
| ---- | ------------------------------------------------- | --------------------------------- |
| POST | `/v1/runs`                                        | 创建任务，返回 202 和完整初始记录 |
| GET  | `/v1/runs/:id`                                    | 查询任务、错误及作品引用          |
| GET  | `/v1/runs?model=...&status=...&limit=20&offset=0` | 分页历史，最多 100 条             |
| GET  | `/v1/artifacts/:id`                               | 下载原始文本、SVG 或 PNG          |
| GET  | `/openapi.json`                                   | OpenAPI 3.1 接口契约              |
| GET  | `/healthz`                                        | 健康检查                          |

提交 Anthropic 示例，调用方可任意修改提示词：

```sh
curl http://127.0.0.1:3000/v1/runs \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: pelican-example-001' \
  --data '{
    "connection_id": "claude",
    "model": "YOUR_MODEL",
    "prompt": "Generate an SVG of a pelican riding a bicycle",
    "parameters": {"max_tokens": 8192},
    "output": {"type": "svg", "preview_width": 1024},
    "metadata": {"external_id": "your-platform-task-001"}
  }'
```

`prompt` 必填，`system_prompt` 可选。服务不追加隐藏提示词、不改写提示词。`metadata` 是调用方的关联标签，不参与权限判断。

`parameters` 采用选定协议的原生字段，不自动将不同协议的 token 字段互相转换：

| 协议             | 支持的生成参数                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| openai-chat      | `max_tokens`, `max_completion_tokens`, `temperature`, `top_p`, `seed`, `stop`, `reasoning_effort`, `presence_penalty`, `frequency_penalty` |
| openai-responses | `max_output_tokens`, `temperature`, `top_p`, `reasoning`（effort/summary）, `text`（verbosity）                                            |
| anthropic        | 必填 `max_tokens`；`temperature`, `top_p`, `top_k`, `stop_sequences`, `thinking`, `output_config`（effort）                                |

未知字段会返回 422，不静默忽略。`temperature: 0`、`seed: 0` 等显式零值会原样传递。模型是否支持某种参数最终由上游判定，其底层错误会保留。服务只进行非流式文本生成，不能提交工具执行、批量生成、远程文件或会话续接参数。

任务状态为 `queued → running → succeeded/failed`。`generation` 中记录模型返回的名字、结束原因、上游 usage（原样保存，不做计费换算）、请求 ID、耗时；Responses 另保留 `response_status`、`incomplete_details`，区分输出预算耗尽和内容过滤，即使尚未生成文本也保留这些信息。上游模型名称不是身份验证证明。作品包含 `raw_text`、`svg`、`png`，并提供 MIME、大小、SHA-256 和访问路径。

Responses 带 `phase` 的响应优先使用 `final_answer`，不将 `commentary` 草稿拼入作品；兼容无 `phase` 的响应。`raw_text` 表示用于作品的最终生成文本，不包含模型内部思考或中间消息。作品文本只替换已知配置凭据，不把普通的 Basic/Bearer 单词当作认证信息。

PNG 可直接展示；原始文本和 SVG 强制下载，并带 `nosniff` 与 CSP。浏览器展示需要由接入平台的后端转发或带令牌请求后生成 Blob URL，不能将服务令牌放入图片 URL。

## 调试错误

同步错误含 `request_id`，响应头同时提供 `X-Request-Id`。异步错误位于任务的 `error`：

```json
{
  "code": "upstream_http_error",
  "stage": "generation",
  "message": "Upstream returned HTTP 429",
  "details": {
    "url": "UPSTREAM_API_ROOT/messages",
    "protocol": "anthropic",
    "upstream_status": 429,
    "upstream_headers": {
      "request-id": "provider-request-id",
      "retry-after": "30"
    },
    "response_body": "Original upstream error text with credentials redacted"
  },
  "causes": [
    {
      "name": "ServiceError",
      "message": "Upstream returned HTTP 429",
      "stack": "..."
    }
  ]
}
```

DNS/连接/TLS/超时保留异常链和可用的底层错误码；JSON 解析错误保留正文；渲染错误保留子进程退出码与 stderr。已知服务令牌、上游密钥以及常见认证字段会脱敏；JSON 错误正文先解码，再递归处理键和值，覆盖 Unicode 转义、Cookie 和 refresh token。上游错误正文在脱敏后最多保存 32,000 字符，超出会标记 `response_body_truncated`。只保留必要的上游响应头，Authorization、Cookie 等不进入诊断。详细诊断仅向该任务所属调用方开放，勿将其原样公开给最终用户。

生成因长度限制中止时标记 `generation_incomplete`，保留部分文本及 usage；SVG 提取或渲染失败同样保留已生成的文本。没有输出、拒绝、无效 JSON、HTTP 错误不会伪装成成功作品。

## 运行边界

- 同一客户端的相同 `Idempotency-Key` 和等价请求返回原任务；不同请求返回 409。省略幂等键意味着创建新任务。失败任务也不会因重放幂等键而重新调用上游。
- `queue_limit` 限制排队与执行中的任务总数，满载返回 429 / Retry-After。`concurrency` 控制生成及渲染的并行数量。
- SQLite 与作品目录必须一起挂载、备份。一个数据目录只允许一个服务进程，SQLite 独占锁防止两个执行器重复调用。不要放在网络共享文件系统。
- 重启后继续未执行任务；已经保存原始输出与生成元数据的任务从提取/渲染继续。上游执行结果未知的任务标记失败，不自动重复收费调用。幂等不能保证外部上游的 exactly-once 执行。
- 原始响应最大 4 MiB，SVG 最大 256 KiB / 10,000 节点 / 64 层。PNG 渲染前检查缩放后的尺寸：单边不超过 4096、像素数不超过 4,194,304；渲染后再次检查实际尺寸。渲染有独立超时。
- 首版只接受静态、独立 SVG。脚本、外部文件/图片、动画、HTML、DOCTYPE、CSS import 等会报出具体拒绝原因。支持普通 SVG 样式、渐变与本地 `#id` 引用。预览固定使用随项目提供的 Noto Sans 字体。
- 渲染在独立 Bun 子进程的 resvg WASM 中进行，不提供网络/文件资源解析器，子进程不继承凭据，也不自动加载 `.env`。生产仍需容器 CPU/内存限制。
- 自行生成的作品默认持久保存。导入作品可按客户端配置自动保留策略，见下节；运维仍需监控数据卷容量。

## 平台导入与自动清理

参考 `config.render.example.json` 配置仅渲染客户端，不需要上游连接或密钥。调用方负责渠道、模型、频率及计费，然后通过 `POST /v1/renders` 提交已有输出，必须携带固定 `Idempotency-Key`。`GET /v1/capabilities` 返回当前客户端的导入权限与保留策略。查询和下载继续使用原有接口。

```json
{
  "text": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\">...</svg>",
  "model": "caller-model",
  "prompt": "Generate an SVG of a pelican riding a bicycle",
  "parameters": {},
  "collection_key": "opaque-channel-model-identity",
  "generated_at": "2026-11-16T12:00:00Z",
  "output": { "type": "svg", "preview_width": 1024 },
  "generation": { "duration_ms": 1200, "finish_reason": "stop" },
  "metadata": { "external_id": "caller-run-id" }
}
```

日期仅是格式示例，必须填写实际生成完成时间。结果 `source` 为 `provided`，服务不重新调用模型。`generation.incomplete=true` 时保存原始文本和诊断，不生成预览。原文最大 4 MiB，整个 JSON 最大 8 MiB；不接受上游 URL、请求头或密钥。

`collection_key` 在客户端内隔离；相同模型、不同渠道应使用不同集合。每个 new-api 部署使用自己的服务客户端令牌，配置 `allow_render=true` 和 `retention={"max_items":20,"max_age_seconds":604800}`。其他平台可采用独立策略。

- 保留时间从 `generated_at` 开始，拒绝过期和明显未来时间。重试不能延长窗口。
- 每集合最多保留 `max_items` 份成功作品，按生成时间和 ID 排序。失败输出不占成功作品名额，但同样受 TTL 限制。
- 新作品成功时立即撤销超量旧作品访问；每 60 秒清理过期文本、SVG、PNG，启动时补扫。读取接口始终检查过期时间。
- 先标记删除再删除文件，磁盘错误保留待删除状态与底层诊断，下一轮或重启后重试。TTL 内保留无作品内容的幂等墓碑，旧请求返回 410；TTL 后清除墓碑，旧提交时间仍会被拒绝。
- 正常关闭时，已保存文本的任务重新入队；未知结果的上游生成不会重新调用。未被数据库引用的文件及临时文件超过一小时后自动回收。
- 服务离线时无法删除物理文件，恢复后补清。所有作品访问继续鉴权，不提供公开静态目录。

## Docker

将配置中的 `host` 改为 `0.0.0.0`、`data_dir` 改为 `/app/data`。`.env` 内 `CONFIG_PATH` 改为 `/app/config.json`。

```sh
docker build -t model-artifact-service .
docker run -d --restart unless-stopped -p 127.0.0.1:3000:3000 \
  --env-file .env \
  --mount type=bind,src="$PWD/config.json",dst=/app/config.json,readonly \
  --mount type=volume,src=model-artifact-data,dst=/app/data \
  --memory=512m --cpus=2 --cap-drop=ALL --security-opt=no-new-privileges \
  model-artifact-service
```

单实例下，改进上游吞吐应先调整并发和资源限额。需要多实例时再更换任务持久化/领取实现，不要直接对同一 SQLite 数据卷启动多个容器。

## 开发与扩展

```sh
bun run typecheck
bun run lint
bun test
bun run build
```

`ModelAdapter` 负责协议构造与文本提取，`ArtifactRenderer` 负责格式渲染，`ArtifactStore` 负责作品存储；任务持久化集中在 `RunStore`。增加平台连接不需要修改代码，增加原生协议只扩展协议适配与参数 schema。OpenAPI 的请求结构从 Zod schema 生成。

安全设计参考 OWASP ASVS 5.0.0、Authentication / Session Management / REST Security / SSRF Cheat Sheets：服务端资源授权、强随机令牌及失效、TLS、凭据脱敏和固定上游地址。当前没有用户密码、浏览器会话或 OAuth 流程，未宣称完整 ASVS 认证。部署方仍负责 TLS、上游地址信任、容器限额与密钥轮换。

字体来自 Noto Fonts，许可见 `assets/OFL.txt`。resvg WASM 使用 MPL-2.0；其余依赖许可随包保留。

## 首版验收记录

2026-11-16，Bun 1.3.12：`bun run typecheck`、`bun run lint`、`bun run build` 全部通过；`bun test` 19 项 / 148 次断言通过；`bun audit` 未发现已知漏洞。

Docker Linux arm64 镜像已在 UID 1000、512 MiB / 2 CPU 限制下，通过本地模拟上游验证三种协议、实际 PNG 下载及容器重启持久化：3 条任务保存完整，上游调用总数仍为 3。独立子代理另完成 5 组 / 156 次断言与最新镜像复验，结论通过。测试只覆盖真实接口契约和已复现回归路径；未使用真实上游凭据或发起收费模型调用，实际提供方联调由部署时配置的连接完成。

2026-11-17 集成版收尾：正式测试为 23 项 / 204 次断言，独立复验通过。最终镜像 `model-artifact-service:0.1.0` 在 Linux arm64、UID 1000、512 MiB / 2 CPU、禁用外部网络的容器中完成验证：三种协议生成真实 PNG；导入 21 份作品后保留 20 份；超过 7 天的导入被拒绝；重启后结果保留、幂等不重调上游、旧文件实际清理；不同客户端隔离和 Unicode 编码凭据脱敏通过。全部使用容器内模拟上游，没有调用收费模型。
