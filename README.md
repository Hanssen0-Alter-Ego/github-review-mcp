# GitHub Review MCP

单账号、可选仓库白名单的 GitHub PR 审查工具，部署到 Cloudflare Workers。Worker 持有 GitHub token，直连 GitHub REST / GraphQL，不运行 `gh`，也不提供通用代理、命令执行或任意 GraphQL。借鉴 [Telegram MCP Bridge](https://github.com/Hanssen0-Alter-Ego/telegram-mcp-bridge) 的独立客户端密钥、可选私有 URL 和 D1 回执。

## 工具

| 阶段 | 工具 |
|---|---|
| 确认身份与目标 | `github_status`、`github_get_pr` |
| 核对改动、CI 和讨论 | `github_list_pr_files`、`github_get_pr_checks`、`github_list_pr_discussion` |
| 开审、进度、结案 | `github_create_pr_comment`、`github_edit_comment` |
| 正式 review | `github_submit_review`：正文和可选行内意见，只发 `COMMENT` |
| 跟进讨论 | `github_list_review_threads`、`github_get_review_thread`、`github_reply_review_comment` |
| 表情与结案处理 | `github_add_reaction`、`github_set_review_thread_resolution` |
| 修正自己开的 PR | `github_edit_pr`：标题和描述 |
| 查写入结果 | `github_write_receipt` |

`github_list_pr_discussion` 的 `kind` 是 `timeline`、`review` 或 `inline`。跟进作者反馈时先读 thread 再决定回复或打表情。resolve/unresolve 限自己发起且 GitHub 授权的 thread。普通评论、行内评论、review 正文也仅能编辑本账号的。工具不会自行订阅、轮询、开审或回复；原有任务仍负责判断和触发。没有 approve、request changes、merge、close、push 或部署接口。文件列表受 GitHub 3,000 文件上限影响；patch 可能被 GitHub 省略，或被桥截短，不能作为大 PR 的完整审查材料。

## 部署

需要 Node 24、Cloudflare Workers 和一份专用 D1 数据库。先测试，再部署：

```sh
npm ci
npm test
npm run build
npx wrangler login
npx wrangler d1 create github-review-mcp
```

在 `wrangler.jsonc` 填返回的 `database_id`，将 `ALLOWED_REPOS` 设为逗号分隔的完整仓库名（例如 `ckb-devrel/ccc,RGBPlusPlus/btc-assets-api`），并填目标 GitHub 账户的数字 ID（Alter Ego 是 `343111139`）。不想维护仓库名单时，设为 `"ALLOWED_REPOS": "*"`，Worker 不额外限制仓库，实际访问仍由 GitHub token 和组织策略决定。空配置仍拒绝操作；`*` 不可与仓库名单混用。仓库移交后请重新核对 GitHub 授权和白名单。单 Worker 只服务一个 GitHub 身份；隔离多个身份或不同仓库权限时，分别部署并用不同 D1 库和客户端密钥。

```sh
npx wrangler d1 migrations apply github-review-mcp --remote
npx wrangler deploy
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put MCP_ACCESS_TOKEN
```

交互提示中粘贴秘密，不放命令参数、项目文件或消息里。优先创建专用于这个 Worker 的 GitHub token，只给所需仓库及权限，设置到期日。典型 fine-grained 权限：Pull requests **Read and write**；读取 CI 增加 Checks、Commit statuses 的 **Read**；如目标组织/端点要求，另加 Issues 相应权限。跨多个组织的授权、组织审核或 SSO 取决于账户，可能需要分开部署。不建议直接复用权限更广的 `gh` 登录 token；若选用已授权的 CLI token，只取 token 字符串作为 Worker secret，不需要把整个 CLI 配置迁过去。GitHub 拒绝权限时，桥返回状态，不会换身份或代理重试。

### 接入客户端

支持 Streamable HTTP。优先在支持请求头的客户端配置 `https://YOUR-WORKER/mcp`，并在客户端的凭据设置中提供 `Authorization: Bearer <MCP_ACCESS_TOKEN>`。客户端密钥用密码管理器生成的 32 字节随机 Base64URL 串（无 padding），和 GitHub token 不同。

如果客户端的自定义 MCP 配置不能添加 Bearer header，可以像 Telegram MCP 一样**显式开启**独立私有 URL：

1. 在 Wrangler `vars` 中加入 `MCP_PUBLIC_ORIGIN`，填部署后的精确 HTTPS origin，不带路径或尾斜线，重新部署。
2. 生成另一把随机 Base64URL key，运行 `npx wrangler secret put MCP_PATH_TOKEN`，在提示中输入。
3. 在你的私有自定义 MCP 配置中直接填 `https://YOUR-WORKER/mcp/<MCP_PATH_TOKEN>`；客户端如果要求选择认证类型，选不注入认证头。Worker 仍会核对 URL 密钥。不要把实际 URL 放进公开包或聊天。
4. 不支持安全储存 URL 或需要组织级授权时，不开启这一路，改用兼容的客户端或在 Worker 前部署 OAuth。这个项目本身不提供 OAuth。

私有 URL 本身就是能以该账号执行允许操作的凭据。关闭 Worker/反代的完整 URL 日志，不用浏览器打开，不截图、不分享。泄漏时立即替换/删除 `MCP_PATH_TOKEN` 并更新客户端。Worker 不记录 token、请求 URL 或评论原文，D1 只保存写入指纹、目标、状态和最小回执；平台与网络层的日志需另行检查。

接入后先调用 `github_status` 核对 GitHub 登录和数字 ID、仓库范围（不限时显示 `["*"]`）、D1 是否就绪，然后对已授权 PR 调用 `github_get_pr`。就绪不代表 GitHub 授予了所有写权限；需要实际验证时只用单独授权的测试 PR，不在生产 PR 发测试评论。

## 写入 / 回执

每次写入传 `repo`、`pr`、完整 `head_sha` 和每个逻辑动作唯一的 `request_id`。例如：`review-start:owner-repo:25:<full-sha>`。同一个 ID 只能重用同样的参数。调用前核对 PR 仍开放、actor 和 head 正确。正式 review 还把 SHA 传给 GitHub 作为 `commit_id`；其他写操作的 head 检查不是 GitHub 原子条件，无法排除检查后瞬时发生的 push。旧 head 的评论不会自动发布到新 head。工具仅提供手动或已授权自动任务所需的操作，不对用户权限作自动推断。

- `succeeded`：可用返回的 GitHub ID/URL 回读。
- `rejected`：确定失败；先修正问题。GitHub HTTP 状态、request ID 和 Retry-After 尽量保留，原始响应不回显。
- `pending` / `unknown`：先查同一回执和对应 PR 的实际讨论/状态，不能换新 ID 盲重发。超时、5xx 或回执写入失败都可能表示 GitHub 其实已写入。三分钟没完成的 pending 显示为 unknown，不会自动接手或重发。这不是跨两个服务的 exactly-once 保证。

参考：[Cloudflare Secrets](https://developers.cloudflare.com/workers/configuration/secrets/) · [GitHub Review REST](https://docs.github.com/en/rest/pulls/reviews) · [GitHub Threads GraphQL](https://docs.github.com/en/graphql/reference/pulls)。
