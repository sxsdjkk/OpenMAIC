# 场景与语音独立 Queue 任务验收（2026-09-30）

代码与线上部署完成；**完整有声长课验收未通过**，当前阻塞是 OpenRouter 每日免费请求额度，不是 Cloudflare 单次执行限制。已完成的课件、音频与 R2 断点仍保留。没有升级套餐、充值、变更语音模型或删除旧课程。

## 交付与版本

- 分支：`codex/workers-free-tier-lite`。
- 功能提交：`43ea978`；回归与边界说明：`34c154f`；进度页导航修正：`ac27917`。
- 网页：`234dc605-1478-47dd-8e84-169e7bd3e9ee`。
- 生成器：`813be1e3-029f-445a-9c41-ce39ec00fb7d`。
- 私有兼容 Worker 保持 `1662259d-6ba7-446a-802d-8bdedfec6d46`。
- 使用既有 `ai-learning-agent-generation` Queue 和 `ai-learning-agent-classrooms` R2，没有新建资源。

按 Cloudflare 技能的重试边界进行实现：大纲、单场景、媒体、语音准备、单段语音和发布分别是独立消息；R2 保存后才发送下一消息，稳定音频对象用于重投复用。消费者批量、并发均为 1，最多重投 2 次；没有分布式锁，不应直接提高并发。供应商响应尚未成功保存前中断，仍不能保证不重复计费。

进度页新增流动条纹、加载图标、600ms 宽度过渡、四阶段提示与实际课件/语音计数。进度不按时间虚增；减少动态效果偏好会禁用动效，失败终态停止轮询与动效。

## 本地验证

- 回归测试：356/356 通过。
- `tsconfig.build.json` 应用 TypeScript 检查通过；Next 16.3.6 / OpenNext 1.20.7 构建通过。
- 新增进度页、Queue 运行器、生成器与相关测试 ESLint 通过；更宽范围检查只有已有 `workers/web.ts:307` 匿名默认导出警告。
- Prettier、`git diff --check`、网页及生成器 dry-run 通过。
- 构建产物 14146 个文件扫描，未发现 6 项本地服务/飞书密钥值；`.env.local` 已恢复，密钥未提交或打包。
- 12 场景/12 音频模拟流水线验证为 27 条独立消息，每次最多一个场景或音频；覆盖重复投递、保存后发送失败、音频先保存后断点失败、当前片段失败、关闭 TTS 和终态重复投递。

## 线上长课：课件通过，语音配额阻塞

任务 `23fc1479-3e5b-4bd7-bb8c-73c82752d6ce`，预留课堂 ID `K9xeO_6DwV`（未发布，不是已完成课程）。

- `06:43:11.247Z` 开始，`07:17:59.548Z` 观测到失败终态，总计约 34.8 分钟。
- 场景：12/12，全部写入 R2；单场景观测最长约 189.09 秒。
- 语音：39/95；全部 39 个对象 HTTP 200，ffprobe 验证为有效 MP3，合计 1383.864 秒（23.06 分钟）、22142168 字节。
- 第 40 段（索引 39）在 3 次 Queue 投递中均遇到 HTTP 429，耗尽重试后明确失败，页面停在实际 84%，不伪装完整有声课程。
- 诊断请求返回 `Rate limit exceeded: free-models-per-day`，剩余额度头为 0；账号限额接口返回 `used=55, limit=50, remaining=0`。[OpenRouter 限额说明](https://openrouter.ai/docs/api_reference/limits)
- `jobs/23fc1479-3e5b-4bd7-bb8c-73c82752d6ce/checkpoint.json` 保留 12 个场景、95 个音频索引、39 个完成计数，下一任务仍为 `tts/index=39`；检查点 153827 字节。
- 失败任务不会自动续跑；当前没有手动恢复按钮。等待额度恢复本身不会恢复该失败任务。跨日免费生成需要后续恢复入口，或用户自行提高供应商额度后再进行完整有声验收。

## 发布环节补测

关闭 TTS 的单场景任务 `eaf0416a-2c87-48e9-87f6-a53fe9e6204b` 于 `07:24:13.632Z` 开始、`07:24:49.721Z` 完成，共 36.089 秒。大纲、场景、语音准备、发布四条消息均有提交日志；任务为 succeeded/100%，R2 课堂读视图 HTTP 200、轻量入口标记正确，浏览器渲染成功。

验收课程：[为什么要保存学习进度](https://ai-learning-agent.sxsdjkk.workers.dev/worker-classroom?id=2zwu1IJd4g)。该课程明确未启用 TTS，不是完整有声长课通过的替代证据。

## Cloudflare 指标

只读 GraphQL 统计窗口：`2026-09-30T06:43:11.247Z` 至 `07:32:55.385Z`。以下只列最终对应版本，不混合旧版入口。

| Worker | 请求数 | CPU 中位 / 最大 | 最长墙钟 | 峰值内存 | CF 运行错误 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 生成器 `813be1e3…` | 59 | 18.646 / 59.66ms | 189.093 秒 | 38.336MiB | 0 |
| 网页 `234dc605…` | 333 | 1.353 / 7.954ms | 0.555 秒 | 2.908MiB | 0 |

生成器 sampleInterval=1；网页平均 sampleInterval 约 1.152，存在采样，最大值仅表示观测样本，不保证未采样请求或后续负载。统计有延迟，不能据请求总数推导精确消息计数。业务失败由处理器捕获并写入任务状态，CF outcome=ok 不等于课程成功。

日志未出现新的 `exceededWallTime`、`exceededResources` 或运行异常。[Queues 限制](https://developers.cloudflare.com/queues/platform/limits/)与 [HTTP Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)不同；本次观察到的负载不需要升级 Cloudflare 套餐。尚未验证高并发、图片生成、完整有声长课或所有兼容 API，不能据此作无限容量承诺。

## 浏览器证据与缺口

- `VERIFICATION_TOOL`: Codex In-app Browser / CUA。
- `VERIFICATION_REASON`: 复用既有飞书登录会话，验证真实生产进度页、CSS 动效与课堂渲染。
- `VERIFICATION_TARGET`: 上述长课进度 URL、补测课堂及返回首页链接。
- `VERIFICATION_EVIDENCE`: 条纹背景位置从 9.55464px 变为 11.556px，实际百分比均为 60；语音阶段显示 12/12 与实时片段计数；失败显示 39/95、84%，动效停止；首页导航和补测课堂实际渲染通过。
- `VERIFICATION_GAPS`: 未完成 95/95 有声长课；减少动态效果由代码/回归覆盖，未切换系统偏好实测；没有高并发测试。原有 6 个生成路由类型冲突与 4 个 OpenNext 依赖复制诊断未在本任务中扩展修复。

本机原始证据（临时目录，非永久云端存档）：

- `/private/tmp/learning-split-regression.json`
- `/private/tmp/learning-split-course-acceptance.json`
- `/private/tmp/learning-split-course-checkpoint-final.json`
- `/private/tmp/learning-split-course-tail.json`
- `/private/tmp/learning-split-course-metrics.json`
- `/private/tmp/learning-split-tts-limit.json`
- `/private/tmp/learning-split-partial-audio-probe.json`
- `/private/tmp/learning-split-text-acceptance.json`
- `/private/tmp/learning-split-progress-motion.json`
- `/private/tmp/learning-split-progress-tts.png`（生成中的历史截图）
- `/private/tmp/learning-split-course-limit-failure.png`（长课实际失败终态）
- `/private/tmp/learning-split-text-classroom.png`（已发布补测课程）

验收日志监听已停止；线上服务未停止，旧课程与密钥均保留。
