# 个人学习平台：本地启动

本分支在 OpenMAIC 的课程生成和互动课堂上新增 `/learn` 个人学习入口。首页可输入主题或上传资料生成课程；学习空间展示课程库、最近课程和上次停留的页面。课程及页面位置沿用 OpenMAIC 的存储方式，页面位置不是学习完成率。

## 启动

需要 Node.js 22.19+ 和 Corepack（用于使用仓库锁定的 pnpm 10.28）。进入仓库目录后执行：

```bash
corepack pnpm install --frozen-lockfile
cp .env.example .env.local
corepack pnpm dev
```

打开 `http://localhost:3000`，点击右上角“学习空间”进入个人首页。需要生成新课程时，回到首页输入主题或上传资料。

在 `.env.local` 至少配置一个模型服务商的 API Key，例如 `OPENAI_API_KEY`，或在页面设置中配置可用的模型服务商。不要提交 `.env.local`。未配置模型时，已有课程仍可浏览，但无法生成新的 AI 课程。支持的服务商和其他可选能力参见项目根目录的 `README-zh.md`。

如需使用 OpenRouter 的 Fish Audio 免费配音，在 `.env.local` 填写 `OPENROUTER_API_KEY`；`TTS_OPENROUTER_API_KEY` 会引用这把 Key，模型固定为 `fish-audio/s2.1-pro-free:free`。重启后在“设置 → 模型服务 → 语音合成”选择“OpenRouter · Fish Audio 免费”及音色，并开启语音合成。已有课程不会自动补音频，需在编辑器时间轴点击“全部配音”。免费模型有速率限制，不会自动切换到付费模型。

## 本地数据

默认模式下，课程数据存放在当前浏览器中。换浏览器、清除站点数据或更换设备不会自动同步课程。需要多设备访问、账户或服务端持久化时，应单独配置 OpenMAIC 的 PostgreSQL 持久化和身份认证；本地个人版不包含这些能力。
