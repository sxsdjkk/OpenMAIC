# Cloudflare Workers 第一阶段迁移

已在 `sxsdjkk` 账号创建 R2 bucket 和 Queue，并将网页 Worker `ai-learning-agent`、生成 Worker `ai-learning-agent-generator` 部署到 Workers Free。Queue 由网页、兼容入口和生成器派发任务，生成器作为消费者。**2026-09-30 已通过飞书真实登录、文本建课、Queue 任务进度、R2 课堂读取、Fish Audio 语音生成和课堂页面加载验收；本轮未升级套餐。图片生成仍缺有效服务配置。**

同日后续已在 `codex/workers-free-tier-lite` 分支进行 HTTP 入口轻量化；下方原始验收记录保留作对照，最新架构与限制见末节。

## 范围

- 文本建课提交到 Queue；独立生成 Worker 读取任务，调用现有模型、图片和 TTS 服务，并将课堂 JSON、任务状态、图片和音频存入 R2。
- 网页 Worker 从 R2 读取课堂、查询任务状态，流式返回音频/图片（支持 Range）。本地运行仍使用原文件存储和后台任务。
- Workers 模式拒绝带 PDF 内容或启用视频生成的建课请求。PDF 上传、视频导出及完整 Agent/数据库功能不属于本阶段。
- 网页 Worker 默认启用飞书登录；已在飞书应用中登记 `https://ai-learning-agent.sxsdjkk.workers.dev/auth/callback` 为回调地址。

## 本地代码验证

```bash
corepack pnpm run build:workers
./node_modules/.bin/wrangler deploy --no-autoconfig --dry-run --outdir /private/tmp/ai-learning-web-check --env-file /dev/null
./node_modules/.bin/wrangler deploy --config wrangler.compat.jsonc --dry-run --outdir /private/tmp/ai-learning-compat-check --env-file /dev/null
./node_modules/.bin/wrangler deploy --config wrangler.generator.jsonc --dry-run --outdir /private/tmp/ai-learning-generator-check
```

`build:workers` 临时将 `.env.local` 移到同目录的 `.env.local.workers-backup`，并从构建子进程中清除本地配置和密钥变量，再执行 Next 和 OpenNext 构建；结束后（包括构建失败）会恢复原文件。构建前若发现备份文件，会停止而不覆盖。请勿直接运行 `opennextjs-cloudflare build` 打包现有本地配置：它会把 `.env.local` 的值写入生成代码。若进程被强制终止导致文件未恢复，请先人工确认并将备份文件改回 `.env.local`。构建脚本会检查生成环境文件中是否出现本地密钥值，但仍应在部署前复查整个产物。

## 线上验收状态（2026-09-30）

1. 飞书真实登录已通过：授权页不再返回 20029，完成现有权限重新授权后成功返回首页；进入 `/learn` 并刷新后仍可访问。
2. 网页 Worker 已配置三项飞书 Secret。两个 Worker 均已配置 `OPENAI_API_KEY`、`OPENROUTER_API_KEY` 和 `TTS_OPENROUTER_API_KEY`。早期直接读取本地 TTS 配置时未展开环境变量引用，测试返回 401；本轮已核对 `TTS_OPENROUTER_API_KEY` 引用 `OPENROUTER_API_KEY`，线上 TTS 同步的是后者已验证有效的实际值。非敏感 URL、模型和开关存于 Wrangler `vars`；密钥通过标准输入上传为 Secret，没有写入配置或部署包。对 2046 个构建文件扫描，未发现本地密钥值。
3. 文本建课默认使用 `openai:deepseek-flash`（服务端点为 DeepSeek）。验收任务 `2joR4OeNI6` 经 Queue 执行并完成，结果为课堂 `p-oigbMUl6`，1 个场景，TTS 覆盖 `5/5`。独立 TTS API 也返回 HTTP 200 和有效 MP3。课堂及全部音频写入 R2；抽查音频返回 `audio/mpeg`，MP3 可被 ffprobe 解析，Range `bytes=0-31` 返回 206 和正确的 32 字节内容。浏览器已加载并播放该课堂，当前浏览器的课程语音开关已开启。
4. 提示词作为 53 个 Text 模块加入部署包，Workers 从 `/bundle` 读取。本地 workerd 实测普通、PBL 和应用提示词均可读取。语音传输在 Workers 使用原生 fetch；DNS 校验使用 resolve4/resolve6，保留私网、元数据及重定向检查。184 项相关回归测试、Next/OpenNext 构建和两个 Worker 的 dry-run 均通过。
5. 之前把免费 HTTP 请求的 10ms CPU 限制套用于 Queue 消费者，判断不准确。[当前 Queues 官方文档](https://developers.cloudflare.com/queues/platform/limits/)说明免费与付费方案均适用消费者限制，默认 CPU 时间为 30 秒，墙钟时间最长 15 分钟。本次短课任务执行成功且日志 outcome 为 ok；尚未做长课或高并发压力测试。
6. 图片生成缺有效配置，本次测试未启用图片；PDF/视频导出按第一阶段范围暂不支持。用量统计仍尝试写入本地文件系统，Workers 日志有非致命警告，用量记录尚未迁移。

验收课堂：<https://ai-learning-agent.sxsdjkk.workers.dev/classroom/p-oigbMUl6>。已保留该测试课堂供试听。

本次线上版本：网页 `017003c0-fa99-4ee8-87a8-fc5af2671cd2`，生成 Worker `beae1478-9618-4426-a06a-97851f850a91`。

当前有 6 个已有 API Route 测试导出与 Next 16.3 的生成路由类型检查冲突。构建配置暂时排除 `.next/types`，但仍检查全部应用源码；上线前应拆出这些测试导出并恢复生成路由类型检查。

## 免费档 HTTP 入口轻量化（2026-09-30）

按 Cloudflare 的流式响应和分离重任务原则，核心请求不再加载 Next.js 服务端运行时；保留现有 Next.js 浏览器界面，不另造一套前端。

| 路径 | 当前执行方式 |
| --- | --- |
| 首页、学习空间、课堂、生成进度 | 构建期生成 HTML/RSC，轻量 Worker 验证飞书 Cookie 后从 Assets 返回；JS/CSS/字体由 Assets 直接提供 |
| 建课 POST | 限制请求体 24KB，只写小型任务状态并发送 Queue 消息；浏览器每 5 秒查询任务 |
| 课堂 GET | 直接流式返回 R2 的 `classrooms/<id>/published.json`，不在 HTTP 中解析/清洗整课 |
| 旧课堂 | 首次访问通知 Queue 创建清洗后的读视图，返回 503 + Retry-After；浏览器有限重试 |
| 音频/图片 GET、HEAD、Range | 直接使用 R2 流与范围读取，不将整个文件放入内存 |
| 单句 TTS API | 单句拆为 Queue 小任务，复用原处理器；HTTP 最多等待 30 秒并从 R2 流式返回原 JSON/状态码，不处理音频和大 JSON |
| 图片 API | 复用纯 Request/Response 处理器，当前缺有效服务配置，未验证生成 CPU |
| 关闭状态的访问码/视频能力探测 | 轻量入口直接返回关闭状态，不启动兼容运行时 |
| 其他页面/API | 通过服务绑定访问 `ai-learning-agent-compat`，保留兼容行为，尚未完成免费档优化 |

兼容 Worker 不开放 workers.dev 或预览 URL，只通过同账户服务绑定访问；沿用相同飞书登录 Secret。未经登录的 API 返回 401，页面跳转飞书；原始私有 HTML/RSC 路径不可直接访问。媒体仅设置 private 缓存，不通过公共桶绕过登录。

新课程生成时先在 Queue 中清洗 HTML 并写入读视图，之后查询可直接返回安全内容。该轮 HTTP 轻量化时建课任务仍按整课执行：短课仅约 160ms CPU，相比 Queue 默认 30 秒还有余量；独立调用的单句 TTS 已单独拆分。随后长课触发 15 分钟墙钟限制，现已改为下节所述的场景/语音分片。排队或供应商超时会使独立 TTS 返回 504，可重试；前端成功和供应商错误的原接口保持不变。

线上浏览器已通过“首页输入主题 → 进度轮询 → 自动进入课堂”、旧链接刷新、学习空间继续学习及跨课程跳转。新增验收课堂 [力的作用初识](https://ai-learning-agent.sxsdjkk.workers.dev/classroom/tCt3H_dDVP)：1 个场景，语音覆盖 5/5；独立免费 Fish Audio TTS 返回有效 MP3。连续 60 次核心读取及音频 32 字节 Range 验收通过。

对照指标：原 Next.js 网页入口成功请求中位 CPU 20.283ms，曾出现约 1.3 秒 CPU、145MiB 内存与 exceededResources。轻量化首轮核心请求中位约 1.2ms、最大 7.564ms、峰值内存约 6.4MiB。独立 TTS 首次动态加载曾出现 38.327ms，提前初始化、移除无效文件写入后仍有 12.259ms；因此最终将单句 TTS 也移入 Queue。这些中间版本不能被当成严格满足 10ms 的证据。

最终版本统计窗口截至 `2026-09-30T05:02:03Z`：网页 73 次请求、sampleInterval=1，中位 CPU **1.561ms**、P99/最大 **6.506ms**、峰值内存 **2.902MiB**，Cloudflare 运行错误 0；墙钟最长 4.872 秒（等待 Queue/R2 不等于 CPU 时间）。同批单句 TTS 消费者 CPU **25.544ms**、墙钟 1.730 秒、内存 33.233MiB，仍远低于 Queue 的 30 秒 CPU 上限。此统计只对应最终轻量版本，未混入此前中间版本或兼容 Worker。

最终发布版本：网页 `f30bfd17-f7aa-4423-9fcb-9699df1cdd9b`，生成器 `94f94cdf-8be5-4678-b2e4-556b7cb1f529`，私有兼容接口 `1662259d-6ba7-446a-802d-8bdedfec6d46`。网页脚本压缩后约 **42.3KiB**。26 组相关回归共 **362 项通过**，应用 TypeScript 检查及 Next/OpenNext 构建完成；13773 个构建文件扫描未发现本地服务或飞书密钥值。OpenNext 仍输出 4 个依赖复制诊断，未影响核心原生入口，兼容接口尚未逐项验收。

Workers 中原本无法成功写入本地目录的应用用量记录已跳过，避免无效文件操作和错误堆栈；本地 Node 版本保持原有统计。它不影响 Cloudflare 和模型供应商各自的计量，云端应用用量看板尚未实现。

独立 TTS 结果仅位于 `tts-jobs/`。R2 规则 `tts-job-results-1day` 在 1 天后清理该前缀的临时结果，供短期 Queue 重投复用；不匹配 `classrooms/`，原有分片上传清理规则保持不变。队列任务和轮询会消耗 Queue/R2 免费配额，并非无限用量。

发布顺序：

```bash
node scripts/build-workers.mjs
./node_modules/.bin/wrangler deploy --config wrangler.generator.jsonc --env-file /dev/null
./node_modules/.bin/wrangler deploy --config wrangler.compat.jsonc --env-file /dev/null
./node_modules/.bin/wrangler deploy --no-autoconfig --env-file /dev/null
```

首次创建兼容 Worker 时，须通过标准输入上传已有三项服务密钥和三项飞书 Secret，不把值写入配置或文件。后续部署会保留 Secret。网页发布必须加 `--no-autoconfig`（亦可运行 `corepack pnpm run deploy:workers`），否则 Wrangler 会识别 OpenNext 并接管部署，偏离轻量入口。

本轮未开通或升级付费套餐。HTTP 免费 CPU 标准仍为 [10ms/请求、128MB 内存](https://developers.cloudflare.com/workers/platform/limits/)；短期样本通过不代表长课、高并发、长文本独立 TTS 或兼容 API 一定稳定。图片缺有效服务配置，PDF/视频/完整 Agent 与数据库仍按第一阶段范围延后。相关回归测试及构建结果见最新发布验收记录。

## 场景与语音独立 Queue 任务（2026-09-30）

此前 12 节 Python 长课在同一个消费者中运行，生成 9 节后达到约 900 秒墙钟时间，被 Cloudflare 以 `exceededWallTime` 终止；CPU 仅约 245ms，主要瓶颈是外部模型等待时间，不是 CPU。

现在使用同一条 Queue 分阶段接续，不增加资源或升级套餐：

| 任务 | 每条消息处理的工作 | 下一任务 |
| --- | --- | --- |
| 大纲 | 生成大纲、教师配置、预留课堂 ID | 第 1 节场景 |
| 场景 | 只生成一节的内容与播放动作 | 下一节场景；全部完成后进入配图或语音准备 |
| 配图（可选） | 只处理一个场景的媒体请求 | 下一场景配图或语音准备 |
| 语音准备 | 一次性拆分长讲解，保存稳定的片段索引 | 第 1 段语音；未启用语音则直接发布 |
| 语音 | 只合成一个讲解片段，保存一个音频对象 | 下一段语音或发布 |
| 发布 | 汇总课件与音频，写入清洗后的课堂读视图 | 完成 |

- `jobs/<jobId>/checkpoint.json` 保存大纲、已完成场景、音频索引、已完成语音计数与下一任务。模型密钥不进入消息或断点；服务配置仍从 Worker 环境读取。
- 每完成一段，先写入 R2，再发送下一条 Queue 消息。旧消息重投只接续断点，不再次生成已提交的场景；下一消息发送失败后也可接续。语音对象使用稳定名称，音频已写入而断点尚未提交时，可通过 R2 检查复用。
- 消费者明确配置 `max_batch_size=1`、`max_concurrency=1`、`max_retries=2`。这保证同一断点不会并发读改写，同时照顾语音服务的并发限制；**没有分布式锁，不能直接调高并发**。多用户吞吐量优化需另行设计。
- 大纲/单场景模型调用使用 8 分钟 AbortSignal，单段语音使用 3 分钟 AbortSignal；失败会对当前片段延迟重试，累计 3 次仍失败则记录终态并停止。已保存的断点保留供排查，不提供手动恢复入口。若供应商已处理请求、结果尚未成功存入 R2 就中断，不能保证绝不重复计费。
- 开启语音时，任何片段仍未生成成功，任务都不会伪装成“完整有声课程”；重试耗尽后返回失败。未启用语音的课程可正常发布。图片配置仍有缺口，未在本轮长课测试中启用；视频/PDF 范围不变。
- 进度页加入流动条纹、加载图标、600ms 宽度过渡、四个阶段和课件/语音保存计数。百分比只取服务端实际进度，不用定时器虚增；支持 `prefers-reduced-motion`。失败后停止动效与轮询。对超过 30 分钟没有进展的运行中任务，HTTP 查询返回明确失败而不无限等待；此保护不修改 R2 断点。
- 本地 Node 仍使用原完整生成入口，共用单场景函数，原重试、课堂 ID 防覆盖、模型路由及语音节流回归保持验证。

Workers 类型由 Wrangler 生成，`workers/generator-env.d.ts` 导出必要类型并保持模块作用域，避免污染 Next.js 的 DOM 类型。重新生成后须保留顶部的模块作用域类型导出；应用共享存储边界继续使用原 DOM Stream 契约。

本轮发布生成器与网页，未改动私有兼容 Worker。真实长课验收记录将在本节补充；单元验证不等同于完整线上通过。
