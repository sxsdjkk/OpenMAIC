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

本轮已发布生成器 `813be1e3-029f-445a-9c41-ce39ec00fb7d` 与网页 `234dc605-1478-47dd-8e84-169e7bd3e9ee`，未改动私有兼容 Worker，分支为 `codex/workers-free-tier-lite`。356 项回归、应用 TypeScript、Next/OpenNext 构建及部署检查通过；14146 个构建文件扫描未发现本地服务或飞书密钥值。

真实长课已生成并保存 **12/12 节课件**，语音保存 **39/95 段** 后因 OpenRouter `free-models-per-day` HTTP 429 耗尽重试，明确进入失败状态，未发布为完整有声课程。39 个已保存音频均可解析为 MP3，累计约 23.06 分钟；R2 断点保留，失败任务不会自动恢复。账号限额接口返回每日免费请求 `used=55, limit=50, remaining=0`。继续使用当前免费模型完成 95 段语音需要跨日恢复能力或更高供应商额度，单纯重新生成整课会再次消耗已有额度。[OpenRouter 限额说明](https://openrouter.ai/docs/api_reference/limits)

本次总任务持续约 34.8 分钟，但已拆为独立消息；生成器观测最大单次墙钟约 189.09 秒、CPU 59.66ms、内存 38.34MiB，没有再次触发 Cloudflare 墙钟或资源限制。最终网页版本观测最大 CPU 7.954ms、内存 2.91MiB。网页指标存在采样，不是所有请求的严格上界，也未验证高并发。无需为本次观察到的负载升级 Cloudflare 套餐；当前阻塞是语音供应商额度。

另建 1 节、关闭语音的补测课程，36.089 秒完成生成、发布和 R2 读取，浏览器成功渲染：[为什么要保存学习进度](https://ai-learning-agent.sxsdjkk.workers.dev/worker-classroom?id=2zwu1IJd4g)。动效已实测条纹移动时百分比保持真实值，失败时停止动效与轮询。详细任务、版本、指标和未覆盖范围见 [独立 Queue 任务验收记录](cloudflare-queue-acceptance.zh-CN.md)。

## OpenRouter 免费语音模型切换（2026-09-30）

按用户指定将模型切为 `deepgram/flux-tts:free`，同步 `.env.local`、示例配置、三个 Worker 的环境配置与浏览器默认模型。默认音色为 `flux-haley-en`，另提供 Heather、Priya、Jack、Bruce、Rufus。原 Fish 音色 ID 与新模型不兼容，服务端收到残留 Fish 选择时使用 Flux 默认音色；不传送未确认支持的合成速度参数，仍请求 MP3，并保持课程原始文字不变。[OpenRouter 模型页](https://openrouter.ai/deepgram/flux-tts:free)标注为英语合成，**未确认中文朗读质量或支持能力**。

按 Wrangler 技能的发布流程保留现有 Secret、重新生成模块作用域的 Workers 类型并验证部署。503 项语音/课堂回归通过，应用 TypeScript、ESLint、格式检查、Next/OpenNext 构建、三个 Worker dry-run 通过。本次 `.open-next`、`.next/server`、`.next/static` 共 11209 个发布相关文件扫描，未发现 6 项本地服务/飞书密钥值；`.env.local` 已恢复。更宽扫描中的旧本地开发缓存含配置值，不在部署目录，本轮未删除缓存或轮换密钥。原有 OpenNext 依赖复制诊断与重复 `tier` 字段警告未扩展修复。

最终线上版本：

- 网页：`9c702536-9cf3-4e1d-bf3c-6fe67852faa5`。
- 生成器：`97644399-8298-4b44-92de-28ceb302136b`。
- 私有兼容 Worker：`88176aa9-27a5-4163-911a-d9bfa264bcf1`。

线上只读复核三个 `TTS_OPENROUTER_MODELS` 均为新模型；已发布 JS 中模型及默认音色正确，服务端 TTS 提供商仍配置有效，旧课堂 `tCt3H_dDVP` 可正常读取。已有课程音频不重生成，先前失败任务不自动续跑。

直接调用新模型及平台 Queue TTS 测试仍返回 HTTP 429：`free-models-per-day` / `RATE_LIMITED`，剩余额度为 0。免费日额度按账号共享，更换免费模型不能绕过。供应商返回重置时间为 **2026-09-30 17:00（America/Los_Angeles）**；没有新增付费模型、充值或升级 Cloudflare 套餐。配置切换验收通过，但**新模型实际音频合成验收仍被额度阻塞**，不能宣称新模型已成功出声。验收原始记录为 `/private/tmp/learning-flux-acceptance.json`、`/private/tmp/learning-flux-regression.json`，临时目录文件不是永久云端存档。[OpenRouter 限额说明](https://openrouter.ai/docs/api_reference/limits)

## 恢复 Fish Audio 与原音色（2026-09-30）

按用户要求恢复 `fish-audio/s2.1-pro-free:free`，同步本地 `.env.local`、示例配置、浏览器默认值与三个 Worker。恢复原音色目录、语言和排列，默认梓轩：

| 音色 | Fish Audio ID |
| --- | --- |
| 梓轩 Zixuan（默认，zh-CN） | `5d29a99739c14d4ca3e4fe42193105b2` |
| 语彤 Yutong（zh-CN） | `74c6aba5cbf94a15bbdc547ffce5cb38` |
| Haoran（zh-CN） | `d675c275d1d44e57b4ef3840c5a23209` |
| Bingbing（zh-CN） | `e98fa6cdad6946bf8d9bb8f9cb8c2532` |
| 承翰 Chenghan（zh-TW） | `1e85fd1e0d3e4cc2b79fbca800e7e3fe` |
| 詩涵 Shihan（zh-TW） | `91ec588cf8ef443a9c0d5b21d0c1fa36` |

服务端继续固定使用免费 Fish 模型，只将残留 `flux-*` 音色回退为梓轩，保留原 Fish 音色及自定义 ID；恢复合成速度参数，保持 MP3。已有课程与音频不重生成，失败长课不自动续跑，场景/语音独立 Queue 与进度动效保持不变。

按 Wrangler 发布流程保留 Secret 与现有绑定，重新生成模块作用域的 Workers 类型。503 项回归、应用 TypeScript、ESLint、格式检查、Next/OpenNext 构建与三个 Worker dry-run 通过。`.open-next`、`.next/server`、`.next/static` 共 11383 个发布相关文件扫描，未发现 6 项本地服务/飞书密钥值；`.env.local` 已恢复且未纳入版本控制。没有新增资源、上传密钥或升级套餐，原有构建警告未扩展修复。

最终线上版本：网页 `ba2f0e4f-af31-42fa-a088-80709e161d64`，生成器 `a23f8a7a-3ac0-4f4c-a01c-40e091a3033e`，私有兼容 Worker `005b3aeb-aeb6-400c-91ac-4ee7442efa2c`。只读检查三个模型绑定均为 Fish；服务端提供商有效、旧课堂 `tCt3H_dDVP` 返回 200、发布 JS 包含全部六个音色。浏览器真实页面显示 Fish 模型、默认梓轩和原六音色目录，未重置用户的其他设置。

一次携带旧 Flux 模型/音色的线上 Queue TTS 测试返回 HTTP 429 / `RATE_LIMITED`，OpenRouter 额度接口仍为 `used=55, limit=50, remaining=0`。因此配置恢复验收通过，但**本轮新音频合成仍受供应商额度阻塞**；换回 Fish 不会重置账号共享免费额度。

- `VERIFICATION_TOOL`: `mcp__cua_repl`，Codex 内置浏览器。
- `VERIFICATION_REASON`: 按浏览器验证路由技能复用已有飞书登录会话，验证真实线上页面而非仅检查代码。
- `VERIFICATION_TARGET`: 学习平台首页角色音色选择及旧课堂 `tCt3H_dDVP`。
- `VERIFICATION_EVIDENCE`: `/private/tmp/learning-fish-restore-voices.png`、`/private/tmp/learning-fish-restore-acceptance.json`、`/private/tmp/learning-fish-restore-regression.json`。
- `VERIFICATION_GAPS`: 本轮未得到新合成音频，不能宣称已成功出声；未自动恢复失败长课或再次执行长课负载测试。临时目录证据不是永久云端存档。

## 飞书账号课程与云端进度（2026-10-02）

原来的飞书登录仅限制访问入口，课程目录与播放位置仍在浏览器。本轮按用户要求，将线上旧课程关联到操作时已登录的飞书账号，并用现有 R2 同步课程目录和播放位置。没有新建付费资源、升级套餐、更换服务密钥或语音模型。

当前状态：旧课程绑定、云端目录和播放进度已上线。最后补查发现 `/api/classroom/` 的兼容路由变体可绕过标准入口的归属校验，已补尾斜杠规范化与敏感 API 别名的兼容转发禁令。通过用户指定的 KeKe Profile 续签已有 Cloudflare 授权后，补丁已发布；两轮独立身份复测中，标准接口及尾斜杠、大小写、编码、重复斜杠变体均返回 404，不再转发到兼容运行时。

- `/api/account` 只返回已验证会话的稳定账号哈希；`/account` 提供可视核对页，不返回 Feishu open_id、Cookie 或令牌。迁移目标由真实浏览器会话确认，而非客户端参数或“第一个登录者”。
- `course-owners/<id>.json` 使用条件创建与不可变归属；`accounts/<account>/courses/<id>.json` 保存课程摘要。列表每页最多 100 条，使用 R2 前缀、游标和元数据，不扫描或解析所有课堂大文件，也不并发读改写一个共享目录文件。
- 新建任务的 ownerId 由服务端会话写入 job，Queue 预留课程时登记归属，完整发布后登记课程目录。客户端传入的 ownerId 不会被采用。
- 课堂、媒体 GET/HEAD/Range、任务状态与进度接口均检查归属；其他账号统一返回 404，匿名 API 返回 401。媒体设置 private/no-store。没有提供公开的认领接口；不具备账号契约的旧课堂 POST 路径在 Workers 返回 405。
- Workers 构建专用 `NEXT_PUBLIC_WORKERS_ACCOUNT=1`，首页和 `/learn` 只读云端当前账号目录。课堂每次先获服务端授权，不能以旧 IndexedDB 缓存绕过归属；本地 Node 运行保留原存储行为，没有启用 PostgreSQL 持久化。
- 播放位置使用独立 R2 对象，条件写入并拒绝乱序旧时间戳覆盖。首次访问、云端位置不存在时，可从该课程旧浏览器游标导入，但不能覆盖已有云端游标。手动换页、暂停状态也保存；恢复完成后才挂载播放器，云端恢复失败会明确报错而不默默重置到第一页。小型进度 PUT 使用 keepalive 保留离页时的提交。

本次迁移先生成明确清单，再由管理员通过现有 Queue 派发 18 条独立 `link-legacy-account` 消息。不存在公开迁移/转移所有权 API。9 份课堂 JSON（4 份完整、5 份 reserved）字节哈希保持一致；9 条旧任务新增归属，原始任务 JSON 在 `account-migrations/<account>/backups/` 留有条件创建备份，任务状态与检查点未被重新生成。4 门完整课程、共 14 页已进入该账号目录；5 个未完成占位不伪装成完整课程。所有记录的归属、回执、数据保留与必需目录项校验通过。

管理脚本 `scripts/migrate-worker-account.mjs` 的 inspect/enqueue/verify 三阶段要求显式账号 ID 与清单路径；属于其他账号的记录会跳过，消费者也拒绝改绑。清单位于本机 `/private/tmp/learning-account-migration.json`，不纳入 Git。

最终已发布版本：网页 `82aa45d9-b20c-43d3-bb5b-030ce0afa596`，生成器 `531cddd7-88e9-4f1f-a7eb-3a60cc555ce1`，私有兼容 Worker `7ed74aee-c53c-45b6-9055-f694e9d1d351`。156 项相关回归、应用类型检查与 Next/OpenNext 构建通过，账号功能与别名防护均已部署。网页脚本压缩后约 43.67KiB。10689 个发布相关 JS/HTML/RSC 文件扫描未发现 7 项候选本地/飞书密钥值。原有 OpenNext 依赖复制诊断、重复 tier 警告和完整 tsc 中 6 个生成路由类型冲突不属于本次改动。

- `VERIFICATION_TOOL`: Codex In-app Browser / CUA；独立会话 HTTP 与只读 R2 校验。
- `VERIFICATION_REASON`: 复用用户真实飞书账号核对归属、目录和课堂，另用已认证测试身份验证账号隔离，不能仅依赖代码推断。
- `VERIFICATION_TARGET`: `/learn`、Transformer 课堂 `ZQZC4Lwc9l`、已存在的课堂/音频/任务/进度接口。
- `VERIFICATION_EVIDENCE`: 真实学习空间显示 4 门课程、14 页；暂停手动换至第 2/11 页，R2 游标实际保存第二页，新标签页恢复到第二页；验收后还原到原第一页面。最终发布后刷新课程目录正常，再次校验全部 18 条迁移记录的归属、回执与数据保留通过。`/private/tmp/learning-account-isolation.mjs` 两轮复测通过：测试账号目录为空，旧课堂、已有音频、任务和进度及 4 类接口路径变体均返回 404，且来自 lite 入口；匿名列表 401。截图 `/private/tmp/learning-account-resume.png`、`/private/tmp/learning-account-courses.png`，云端游标核对 `/private/tmp/learning-account-progress-second-page.json` 和 `/private/tmp/learning-account-progress-restored.json`。
- `VERIFICATION_GAPS`: 发布后首轮大小写变体出现一次 500，随后两轮均为 404，未返回课程内容；没有足够运行日志判断该瞬时错误原因，也未进行高并发或免费档 CPU 负载验收。没有在另一台设备执行新的飞书扫码授权；同账号跨设备契约由云端接口、无本地目录依赖的回归和新标签页实测覆盖。本轮不执行模型/语音生成或完整长课负载，之前失败长课仍不提供自动恢复。文件夹、聊天、笔记、课件编辑和本地删除不是本次云端同步范围；旧本地缓存保留，刷新页面即可使用新版。临时目录证据不是永久云端存档。
