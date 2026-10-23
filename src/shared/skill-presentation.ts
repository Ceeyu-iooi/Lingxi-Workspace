// Display translations only: original identifiers and source documents are unchanged.
const rows = `
imagegen|图像创作|生成、编辑和调整图片，制作插画、场景与透明背景素材。
review-agent|代码缺陷评审|只读检查代码改动，整理有证据、可修复的问题。
gaokao-essay-writer|高考议论文写作|根据作文题目和参考风格起草高中议论文。
personal-workbench-explorer|工作台需求探索|比较个人工作台想法的价值、使用频率和维护成本。
artifact-template-analytics-dashboard|数据分析看板模板|用表格和图表呈现获客、留存、收入与转化指标。
artifact-template-business-review|经营复盘模板|用演示文稿梳理业绩、指标、战略重点与后续决策。
artifact-template-design-report|设计报告模板|整理设计发现、影响、建议和相关附录。
artifact-template-experiment-analysis|实验分析模板|组织实验假设、方法、结果、局限与下一步计划。
artifact-template-financial-budget|财务预算模板|制作预算、实际支出、情景预测与差异分析表。
artifact-template-investment-committee-memo|投资决策备忘录模板|整理投资逻辑、交易资料、财务分析和风险建议。
artifact-template-legal-memorandum|法律备忘录模板|按争议问题、事实、分析和结论组织法律文稿。
artifact-template-market-trends-report|市场趋势报告模板|用演示文稿呈现市场趋势、证据与应对建议。
artifact-template-minimal-letterhead|简洁信笺模板|制作包含收发件信息、正文与签名的商务信函。
artifact-template-operating-calendar|运营日历模板|按年度和月份规划活动、里程碑和周期性事项。
artifact-template-operating-review|运营周报模板|整理指标、职能进展、风险、决策和行动项。
artifact-template-project-kickoff|项目启动模板|对齐项目目标、范围、分工、里程碑和协作方式。
artifact-template-project-tracker|项目跟踪模板|跟踪任务、负责人、状态、优先级与甘特计划。
artifact-template-sales-pipeline|销售管线模板|跟踪商机阶段、金额、概率、预测和下一步行动。
artifact-template-simple-dark-mode|简洁深色演示模板|制作使用深色背景、清晰排版和图表的演示文稿。
artifact-template-simple-light-mode|简洁浅色演示模板|制作使用浅色背景、清晰分节和图表的演示文稿。
artifact-template-strategy-memorandum|战略备忘录模板|整理战略背景、选项、依据、风险和实施建议。
artifact-template-system-design|系统设计模板|记录架构、需求、组件、数据流、接口和技术取舍。
artifact-template-team-alignment|团队共识模板|组织团队规划中的目标、优先级、决策和行动项。
artifact-template-three-statement-forecast|三表财务预测模板|联动预测利润表、资产负债表与现金流量表。
starter-workflow|工作流起步模板|提供待插件维护者完善的基础工作流骨架。
openai-docs|OpenAI 文档助手|查询 OpenAI 产品与接口的官方文档，协助配置和排错。
skill-creator|技能创作|编写、改进和验证可重复使用的技能。
skill-installer|技能安装|从指定仓库或技能目录安装和管理技能。
novaforge|知识笔记工坊|将学习、科研和项目资料整理成结构化笔记。
stm32 project initial|STM32 工程整理|按分层架构整理 STM32 模块工程，生成使用与学习文档。
agents-sdk|智能体开发|构建有状态智能体、实时对话与持久工作流。
cloudflare|Cloudflare 平台开发|开发和管理云端应用、存储、网络与部署。
cloudflare-email-service|邮件服务开发|配置邮件收发、路由、身份验证与投递。
cloudflare-one|零信任网络|配置访问控制、网关和设备安全策略。
cloudflare-one-migrations|零信任迁移|评估现有网络方案，制定向 Cloudflare One 迁移的计划。
durable-objects|持久对象开发|实现有状态协调、持久存储与实时连接。
sandbox-migrate-to-next|沙箱版本迁移|迁移 Cloudflare 沙箱应用并核对接口兼容性。
sandbox-next|新版沙箱开发|使用预览版沙箱运行代码、文件与开发环境。
sandbox-stable|稳定版沙箱开发|使用稳定版沙箱管理代码执行、文件与运行环境。
turnstile-spin|人机验证接入|为网站接入 Turnstile 并完成服务端验证。
web-perf|网页性能分析|检查网页加载、交互和布局表现，定位性能瓶颈。
workers-best-practices|云端服务规范|检查 Workers 服务的实现、配置与运行风险。
wrangler|云端部署工具|使用 Wrangler 开发、配置和部署 Cloudflare 应用。
beautify-github-readme|项目首页美化|优化 README 的结构、表达和项目展示素材。
canvas-design|平面视觉设计|创作海报、艺术图像和静态视觉文档。
claude-api|Claude 接口助手|查询 Anthropic 接口，协助模型选型、调用与迁移。
claude-vision-skill|图像识读|通过视觉模型分析图片、截图和图中文字。
computer-use|电脑操作|通过授权的界面操作完成电脑应用任务。
doc-coauthoring|文档共创|协作编写技术方案、说明文档和决策材料。
documents|文档编辑|创建、修改和核验 Word 文档及版式。
docx|Word 文档处理|编辑文稿、表格、批注和修订，生成 Word 文件。
electron|桌面应用开发|开发 Electron 桌面应用，处理窗口与进程通信。
electron-egg|桌面工程框架|使用 Electron EGG 组织桌面应用与窗口通信。
find-skills|技能发现|根据任务寻找适合的技能和安装方式。
frontend-design|前端视觉设计|设计网页的布局、排版、配色与视觉细节。
grill-me|方案推敲|通过逐步提问澄清需求、约束和设计取舍。
ideological-self-report|思想汇报写作|整理和撰写季度思想汇报材料。
internal-comms|内部沟通写作|起草团队通知、进度汇报和项目沟通材料。
ko-lesson|课程学习资料|根据课程材料生成系统的学习和复习资料。
mcp-builder|工具服务开发|构建可供智能体调用的 MCP 工具服务。
mineru-precise-parse|精准文档解析|提取文档、图片与复杂表格中的结构化内容。
nature-academic-search|学术文献检索|检索文献、核验引用并整理参考文献与引文资料。
nature-citation|论文引用补充|为论文段落寻找文献支持，建立文字与引用对应关系。
nature-data|科研数据声明|整理数据共享方案、可用性声明和数据引用。
nature-downloader|学术全文获取|使用开放或授权渠道获取并整理学术全文。
nature-experiment-log|实验日志整理|将原始实验材料整理为结构化实验日志。
nature-figure|科研图表制作|制作和核验可用于学术投稿的图表与组图。
nature-literature-pipeline|文献发现流程|检索、筛选、阅读和归档相关学术文献。
nature-paper-to-patent|论文转专利|从科研材料提取技术方案并起草中文专利文件。
nature-paper2ppt|论文汇报制作|将论文整理为中文汇报幻灯片与讲稿。
nature-polishing|学术语言润色|润色和翻译论文内容，调整表达与排版。
nature-reader|论文对照阅读|整理保留图表和来源的中英文对照论文读本。
nature-ref-verifier|参考文献核验|逐项核对作者、年份、标题与文献标识。
nature-response|审稿回复写作|整理逐点回复、修回说明和投稿信。
nature-reviewer|论文模拟评审|从审稿人角度评估论文证据、贡献和改进空间。
nature-writing|学术论文写作|根据研究结果组织和起草论文章节。
oil-frontend|前端交互规范|改进界面组件、交互、状态和数据流的一致性。
oil-tone|自然文案润色|将中文或英文文案改得自然、清楚、易读。
oil-ui|界面视觉规范|改进产品界面的视觉风格、层次与排版。
pdf|PDF 文档处理|读取、编辑、合并和核验 PDF 内容与版式。
pdf2zh-better|文档对照翻译|翻译文档并保留原有布局，输出单语或双语版本。
personal-workbench-builder|个人工作台构建|将长期工作流程组织成可运行的个人工作台。
create-plugin|插件创建|创建包含技能、工具和应用能力的插件。
prepare-plugin-submission|插件发布准备|整理插件提交资料、示例与访问说明。
update-plugin|插件更新|修改已有插件的工具、技能和配置。
plugin-management|插件管理|查找插件并管理连接、安装和访问权限。
pptx|演示文稿处理|创建、修改和检查 PowerPoint 演示文稿。
presentations|幻灯片编辑|编写、编辑和核验演示文稿与图表。
quarkclouddrive|夸克网盘|查询、上传、下载和管理网盘文件与分享。
remotion-best-practices|视频编程制作|使用 React 和 Remotion 制作视频与动画。
researchwrite|科研写作流程|根据论证和证据组织科学写作与质量核验。
reverse-engineer-anything|程序逆向分析|分析软件成品的结构、功能和运行证据。
sites|网站构建|创建、修改和发布网站应用。
sites-remix|网站改作|基于已有网站制作和调整新版本。
slack-gif-creator|动图制作|制作适合团队消息使用的 GIF 动画。
spreadsheets|电子表格处理|创建、计算、编辑和核验电子表格。
excel-live-control|在线表格控制|通过已连接的会话操作当前 Excel 工作簿。
template-creator|可复用模板|将参考文档与视觉资料整理为可重复使用的模板。
theme-factory|主题样式工坊|为文档、演示和网页整理配色与字体主题。
upgrade-link|升级链接管理|创建和配置应用升级链接与更新流程。
vibehub|交互术语助手|将界面效果和软件需求转化为清楚的专业术语。
visualize|交互可视化|通过交互图形展示比较、变化和工作原理。
web-artifacts-builder|网页作品构建|制作包含多个组件和交互状态的网页应用。
webapp-testing|网页交互验证|检查网页操作、页面状态、截图和浏览器错误。
create-pet|动态宠物创作|创建和验证可用于 ChatGPT 的动态宠物。
pets|动态宠物管理|查看、选择和管理 ChatGPT 中的动态宠物。
update-pet|动态宠物更新|修改、修复和核验已有动态宠物。
xlsx|表格文件处理|整理和编辑表格数据、公式、格式与图表。
`;
const catalog=new Map(rows.trim().split("\n").map(row=>{const [id,title,description]=row.split("|");return [id,{title,description}] as const}));
export type SkillPresentation={title:string;description:string};
export function skillPresentation(original:string,description:string,override?:SkillPresentation){
 if(override)return {...override,source:"custom"};
 const id=original.toLowerCase().split(":").pop()!.trim(),known=catalog.get(id);
 const chineseTitle=/[\u3400-\u9fff]/.test(original)?original:known?.title||"自定义技能";
 const chineseDescription=/^[\u3400-\u9fff]/.test(description.trim())?description.trim().split(/(?<=[。！？])\s*/)[0].slice(0,240):known?.description||"暂无中文简介，可在详情中补充。";
 return {title:chineseTitle,description:chineseDescription,source:known?"catalog":/[\u3400-\u9fff]/.test(original)?"source":"untranslated"};
}
