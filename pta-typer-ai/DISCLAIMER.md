# 免责声明 / Disclaimer

**最后更新：2026-11-16**

本文件同时提供中文与英文版本。中文为准，英文仅供阅读便利。若两者有歧义，以中文版本为准。

---

## 中文版

### 1. 非官方项目

本项目（下称「本工具」）是个人开发的浏览器扩展，**与 PTA（拼题 A / pintia.cn）、浙江大学、哈尔滨工业大学、DeepSeek 及其任何关联机构没有任何关系**，未获其授权、认可或背书。文中出现的平台名称、商标、界面截图仅用于说明用途，归各自权利人所有。

### 2. 用途限定

本工具面向**个人学习、编程练习与自动化效率研究**。设计目标是减少重复的机械输入劳动，让你把时间放在理解题目和调试逻辑上——**不是**为了跳过学习过程，也**不是**为了在任何考核中取得不当优势。

### 3. 学术诚信

使用本工具提交的每一次作答，其**内容正确性、原创性与合规性由使用者自行负责**。

- 若你所在课程、学校或考试机构的规章禁止使用 AI 辅助工具或自动化提交工具，**请勿使用本工具**。
- 在考试、竞赛、限时测验等场景中使用本工具，可能构成违纪。是否使用，以及由此产生的一切后果（包括但不限于成绩作废、课程处分、学籍处理），**由使用者独立承担**。
- 本工具的 AI 解题功能生成的是**可能出错的参考代码**，不是标准答案。请勿在不理解代码的情况下提交。

### 4. 第三方服务与费用

AI 解题功能需要你自己提供第三方大模型服务的 API Key（默认对接 DeepSeek，也可填任意 OpenAI 兼容端点）。

- **API Key 由你自行申请、自行付费**。调用产生的费用与本项目作者无关。
- 请求从你的浏览器直接发往你配置的服务商，**不经过本项目作者的任何服务器**（本项目没有服务器）。
- 你在请求中提交的题目内容会发送给该服务商，受其隐私政策与服务条款约束。若题目含敏感或涉密信息，请勿使用 AI 功能。
- 服务商的可用性、定价、模型行为、输出内容均不受本项目控制。

### 5. 平台条款

本工具通过 Chrome DevTools Protocol 向页面派发真实键盘事件，用于绕过平台对程序化输入的限制。**这类行为可能违反平台的服务条款。** 平台若因此限制、封禁或处罚你的账号，本项目作者不承担任何责任。

请自行评估风险，并优先遵守你所在平台的使用规则。

### 6. 无担保

本工具按「现状」（AS IS）提供，**不附带任何形式的明示或默示担保**，包括但不限于对适销性、特定用途适用性、不侵权、无错误、不中断的担保。

浏览器版本更新、平台前端改版、编辑器实现变更，都可能导致本工具失效。作者没有义务跟进修复，也不承诺任何形式的支持。

### 7. 责任限制

在适用法律允许的最大范围内，**本项目作者及贡献者对因使用或无法使用本工具而产生的任何直接、间接、偶然、特殊、惩罚性或后果性损害不承担责任**，包括但不限于：数据丢失、账号受限、成绩受影响、API 费用支出、学业或职业损失、第三方索赔。

无论损害基于合同、侵权、严格责任还是其他法律理论，也无论作者是否已被告知此类损害的可能性，本条款均适用。

### 8. 数据处理

本工具**不收集、不上传、不分析任何用户数据**。具体说明：

| 数据 | 存放位置 | 是否外发 |
|---|---|---|
| API Key、接口地址、模型名 | 浏览器 `chrome.storage.local` | 仅发给你配置的服务商 |
| 你输入的代码 | 扩展面板内存 | 否 |
| 页面题面文本 | 内存，仅用于组装 AI 请求 | 仅在你点「AI 解题」时发给你配置的服务商 |
| 使用日志 | 页面内存，刷新即清空 | 否 |

本工具不含任何统计、埋点、遥测或远程配置功能。

### 9. 代码与许可

本项目源代码以 MIT 许可证发布，你可以自由使用、修改、分发，但**须保留许可证与版权声明**。MIT 许可证中的免责条款与本文件共同构成完整免责约定。

若你将本工具再分发、打包进其他产品，或以其他形式提供给第三方，**你有责任一并传递本免责声明**，并确保下游使用者知悉上述限制。

### 10. 变更

本免责声明可能随项目更新而调整。继续使用即视为接受当时生效的版本。

### 11. 同意

下载、安装、运行或以任何方式使用本工具，即表示你已阅读、理解并**同意接受上述全部条款**。如果你不同意其中任何一条，请立即停止使用并删除本工具。

---

## English Version

### 1. Not an official project

This browser extension (the "Tool") is an independent personal project. It is **not affiliated with, authorized, endorsed, or sponsored by** PTA (pintia.cn), Zhejiang University, Harbin Institute of Technology, DeepSeek, or any of their affiliates. Platform names, trademarks, and screenshots are used only for descriptive purposes and remain the property of their respective owners.

### 2. Intended use

The Tool is intended for **personal study, programming practice, and research into input automation**. Its purpose is to remove repetitive mechanical typing so you can spend time on understanding problems and debugging logic. It is **not** intended to bypass learning, nor to gain improper advantage in any assessment.

### 3. Academic integrity

**You are solely responsible** for the correctness, originality, and compliance of anything you submit using the Tool.

- If your course, institution, or examination body prohibits AI-assisted tools or automated submission, **do not use the Tool**.
- Using the Tool during exams, contests, or timed quizzes may constitute academic misconduct. All consequences — including but not limited to voided scores, course sanctions, and disciplinary action — are **borne entirely by you**.
- The AI solver produces **fallible reference code**, not an answer key. Do not submit code you do not understand.

### 4. Third-party services and cost

The AI feature requires an API key from a third-party model provider that you supply yourself (DeepSeek by default; any OpenAI-compatible endpoint also works).

- **You obtain and pay for the key.** Usage costs are unrelated to the author.
- Requests go from your browser directly to the provider you configure. **No server of the author is involved** — this project has no server.
- Problem text you submit is sent to that provider and is subject to its privacy policy and terms of service. Do not use the AI feature on confidential material.
- Provider availability, pricing, model behavior, and output are outside the author's control.

### 5. Platform terms

The Tool dispatches real keyboard events through the Chrome DevTools Protocol in order to work around restrictions on programmatic input. **Such behavior may violate a platform's terms of service.** The author accepts no responsibility if a platform restricts, bans, or otherwise penalizes your account. Assess the risk yourself and prioritize complying with the rules of the platform you use.

### 6. No warranty

The Tool is provided **"AS IS"**, without warranty of any kind, express or implied, including but not limited to warranties of merchantability, fitness for a particular purpose, non-infringement, accuracy, or uninterrupted operation.

Browser updates, front-end redesigns, and editor implementation changes may break the Tool. The author is under no obligation to fix such issues and provides no support commitment.

### 7. Limitation of liability

To the maximum extent permitted by applicable law, **the author and contributors shall not be liable for any direct, indirect, incidental, special, punitive, or consequential damages** arising from the use of or inability to use the Tool, including but not limited to: data loss, account restrictions, academic consequences, API charges, loss of study or employment opportunity, or third-party claims.

This applies regardless of the legal theory (contract, tort, strict liability, or otherwise) and regardless of whether the author was advised of the possibility of such damages.

### 8. Data handling

The Tool **collects, uploads, and analyzes no user data**:

| Data | Stored in | Transmitted |
|---|---|---|
| API key, endpoint, model name | `chrome.storage.local` | Only to the provider you configure |
| Code you type | Panel memory | No |
| Problem text from the page | Memory, used only to build the AI request | Only to your configured provider, only when you click "AI 解题" |
| Runtime log | Page memory, cleared on refresh | No |

There is no analytics, telemetry, tracking, or remote configuration.

### 9. License

Source code is released under the MIT License. You may use, modify, and distribute it, provided you **retain the license and copyright notice**. The warranty disclaimer in the MIT License and this document together form the complete disclaimer.

If you redistribute the Tool, bundle it into another product, or otherwise provide it to third parties, **you are responsible for passing this disclaimer along** so downstream users are aware of these restrictions.

### 10. Changes

This disclaimer may be updated alongside the project. Continued use constitutes acceptance of the version in effect at that time.

### 11. Acceptance

By downloading, installing, running, or otherwise using the Tool, you acknowledge that you have read and understood these terms and **agree to be bound by them in full**. If you disagree with any part, stop using the Tool and delete it immediately.
