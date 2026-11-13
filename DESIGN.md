---
name: "Agent Family"
description: "Chinese-first multi-agent conversation workspace; warm light Operate design."
colors:
  accent: "#2e6554"
  accent-hover: "#245342"
  tint: "#eaf1eb"
  canvas: "#ffffff"
  surface: "#f6f7f3"
  paper: "#fafbf8"
  text: "#24372f"
  muted: "#5c6c61"
  border: "#e4e8e1"
  error: "#a33e34"
  focus: "#79a991"
  selection: "#dcebdc"
  sage-bg: "#e3eee3"
  sage-text: "#365b43"
  clay-bg: "#f5e8df"
  clay-text: "#985c41"
  blue-bg: "#e3ebf2"
  blue-text: "#506c88"
  violet-bg: "#eee6f4"
  violet-text: "#76598d"
  gold-bg: "#f4edd6"
  gold-text: "#896a2e"
typography:
  display:
    fontFamily: "\"Agent Sans\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "38px"
    fontWeight: 500
    lineHeight: 1.55
    letterSpacing: "0.04em"
  headline:
    fontFamily: "\"Agent Sans\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "clamp(22px, 1.7vw, 27px)"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "0.025em"
  title:
    fontFamily: "\"Agent Sans\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "18px"
    fontWeight: 650
    lineHeight: 1.4
  body:
    fontFamily: "\"Agent Sans\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.65
  conversation:
    fontFamily: "\"Agent Sans\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.9
  label:
    fontFamily: "\"Agent Sans\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "13px"
    fontWeight: 550
    lineHeight: 1.65
  metadata:
    fontFamily: "\"Agent Sans\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.65
  code:
    fontFamily: "Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.7
rounded:
  tag: "5px"
  text-control: "6px"
  icon: "8px"
  control: "9px"
  card: "10px"
  avatar: "11px"
  mobile-composer: "13px"
  composer: "15px"
  modal: "18px"
spacing:
  s4: "4px"
  s8: "8px"
  s12: "12px"
  s16: "16px"
  s20: "20px"
  s24: "24px"
  s30: "30px"
  s40: "40px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.canvas}"
    rounded: "{rounded.control}"
    padding: "8px 15px"
    typography: "{typography.label}"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-secondary:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "8px 15px"
    typography: "{typography.label}"
  button-text:
    textColor: "{colors.muted}"
    rounded: "{rounded.text-control}"
    padding: "6px 8px"
  icon-button:
    rounded: "{rounded.icon}"
    width: "40px"
    height: "40px"
  send-button:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.canvas}"
    rounded: "{rounded.control}"
    width: "44px"
    height: "44px"
  input:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
  avatar-sage:
    backgroundColor: "{colors.sage-bg}"
    textColor: "{colors.sage-text}"
    rounded: "{rounded.avatar}"
    size: "40px"
  modal:
    backgroundColor: "{colors.canvas}"
    rounded: "{rounded.modal}"
    padding: "25px 27px"
    width: "520px"
  composer:
    backgroundColor: "{colors.canvas}"
    rounded: "{rounded.composer}"
    padding: "10px 14px 9px"
---

# Design System: Agent Family

## Overview

**Creative North Star: "围坐一桌，各有所长"**

以一张安静的共同工作桌组织多个 AI 伙伴：白色对话中心、浅色侧栏和森林绿操作，让身份、内容与下一步动作清楚可见。中文优先，密度适中；亲切感来自姓名、字形头像与柔和材质，而不是虚构对话或连接状态。

这是从当前实现提炼的 Operate 视觉系统。用户委托了设计判断；本次文档是实现后的刷新，不代表补做了历史上的 seeded direction gate、QUALITY BAR card 或用户视觉批准。流程缺口见 docs/design/2026-11-13-finish-review.md。生成图 docs/design/concept.png 仅为开发期方向参考；生产界面没有随附栅格图片，标志为内联 SVG，登录图形为 CSS。

**Key Characteristics:**
- 白色主对话，浅绿辅助区域。
- 森林绿标示主要动作与选择，成员颜色只表达身份。
- 真实姓名、模型、连接与任务状态可见。
- 桌面三栏，手机以受控抽屉保留主对话空间。

## Colors

温和的浅色工作区，以森林绿为主要操作色；前置 token 是规范值，源头为 `src/styles.css` 的最终级联。

### Primary
- **森林绿 / accent**：主要动作、发送、链接与输入光标；hover 为更深的同色。
- **浅绿 / tint**：轻量操作悬停和选择提示，避免把大片内容染成强调色。

### Secondary
- **鼠尾草、陶土、蓝色**：主要成员头像的背景/文字配对。
- **紫色、金色**：成员编辑器提供的其他身份配对。保留文字姓名，颜色不单独承载含义。

### Neutral
- **白色 / canvas**：中心对话、输入框和弹窗。
- **浅侧栏 / surface、纸色 / paper**：分别承载群列表与伙伴区域。
- **深绿墨色 / text**：主要文字；**muted** 为次要文字和已修正的占位符。
- **border** 用于区域分隔与列表/文件结构；**error** 表示错误与危险操作；**focus** 表示键盘焦点；**selection** 表示原生文字选择背景。

**The Identity Rule.** 成员颜色表达身份，状态必须另有文字说明。

实现仍有局部字色、提示色和差异比较色；这些不是新增的全局色阶。不要把本表理解为每个 CSS 色值都已归一化，也不要恢复历史 muted 值。

## Typography

字体采用前置 body 字体栈。`Agent Sans` 是声明的首选名，但 `public/fonts/fonts.css` 没有定义字体文件；当前依靠系统字体，中文回退为 PingFang SC / Microsoft YaHei。没有远程字体请求。代码使用 Consolas / monospace。

- **Display**：桌面登录左栏的短句；不是通用页面标题。
- **Headline**：空对话邀请标题；手机为 22px、1.65 行高，超宽桌面为 28px。
- **Title**：桌面群名；手机为 16px。弹窗标题另用 20px，手机为 18px。
- **Body / conversation**：界面基础文字与长回复分别采用较紧/较松行高；手机回复为 14px / 1.85。用户消息正文仍有 14px 局部覆盖。
- **Label / metadata**：控件和模型/时间等辅助信息；手机模型/时间为 10px。登录标题为 27px，手机为 26px，标题上不渲染眉题。
- 中文不强制大写或扩大字符间距；保留模型 ID 原样。长文件路径和模型标签在受限位置截断，正文可换行，代码区域可横向滚动。

## Layout

工作区占据视口高度（100dvh），中间对话独立滚动，输入区位于列底部。桌面列宽为 248px / 弹性 / 278px；从 1600px 起为 266px / 弹性 / 300px。消息容器最大 830px，输入外容器最大 900px，空状态最大 850px。这里只记录实际容器宽度，不假设统一 840px。

在 1180px 及以下，成员栏成为右侧 300px 抽屉，左栏缩为 224px。在 760px 及以下，中心占满宽度，群列表成为左侧 280px 抽屉。抽屉由 Radix Dialog 管理焦点与关闭；移动输入区域保留底部安全区。手机标题允许收缩与省略，不挤占图标点击区域。

设置弹窗桌面为 155px 导航加内容列，手机导航横向滚动。项目文件浏览桌面为 170px 文件列表加内容列，手机为单列并将文件列表改为横向滚动；工具栏换行，分支选择占满一行，差异比较在自身容器滚动。

登录页桌面为等宽两列；手机隐藏故事插图，显示品牌与表单。一般弹窗最大宽度为视口减 32px，最大高度为动态视口减 48px；手机分别减 22px 和 28px，内部滚动。

间距以紧凑控件、充分分离的消息块组织；前置 spacing 是已使用的常用步长，不是宣称所有局部 padding 都符合单一网格。

## Elevation & Depth

主体依靠表面色与细分隔线区分层次。弹窗使用遮罩和阴影，边框为 none；左右抽屉使用朝向内容侧的阴影。输入框保留极轻静态阴影，聚焦时改为浅绿外环；这是真实例外，不宣称所有平面组件完全无阴影。精确阴影、焦点、遮罩及动效值放在 sidecar 的 extensions。

**The Quiet Layer Rule.** 内容表面保持安静；浮层通过遮罩与阴影表达层级，不叠加装饰边框。

按钮和输入状态过渡通常为 0.15s；弹窗进入为 0.18s ease-out。加载图标可旋转，生成状态可轻微呼吸；系统偏好减少动态时禁用动画与过渡，并恢复自动滚动行为。

## Shapes

小圆角用于工具、标签和列表；中等圆角用于输入、按钮和身份头像；较大圆角用于输入区域与弹窗。各角色以 frontmatter 为准，不将旧文档的统一 10px 半径套到所有控件。手机输入区域和弹窗分别使用 13px 与 15px。用户消息靠右，头像在右侧，气泡右上角为直角、其余 12px；Agent 回复保持左侧。标志是三个相交圆，身份头像为带汉字的圆角方形。

## Components

### Buttons

主要按钮是森林绿填充、白字；次要按钮为白底细边框，hover 使用浅绿色；文字按钮用 muted、hover 使用 accent/tint。普通按钮按下下移 1px，禁用时 opacity 0.45 并使用不可用光标。

最终通用 button/select 最小高度为 40px，主要按钮/新群聊至少 44px，发送固定 44px 方形，主要图标按钮固定 40px 方形。此为一般规则，不是全部点击目标已统一的声明：compact 变体的更高优先级仍为 34px，手机建议按钮为 38px，聊天方式为 35px；普通手机按钮为 42px，登录主按钮为 45px。后续改动必须核对级联与具体组件。

### Inputs / Fields

白底细线，hover 加深边框，focus 转森林绿。可聚焦原生控件和链接使用 3px 焦点轮廓并向外偏移 3px；组合输入区以 focus-within 的边框/外环表达焦点。标签通过 Field 关联控件与帮助文本。手机表单与主输入采用 16px 字号。原生选区使用 selection/text，光标使用 accent；普通链接下划线偏移 0.2em，回复 Markdown 链接仍有 3px 局部覆盖。

### Navigation

群列表只呈现实际房间。当前房间以浅绿背景与较深绿字标识；hover 更轻。设置与项目页签使用同样的低饱和选中关系。移动导航保留可关闭抽屉与当前内容，不把侧栏压缩成不可读的一列。

### Chips / Identity

姓名字形头像配对成员色。模型标签、LINE 来源标签、待审查/已批准/已拒绝标签是小型辅助信息；必须与真实数据对应。成员展示名称与模型家族，消息保留完整公开模型 ID（可截断并提供 title）。不以颜色替代文字。

### Cards / Containers

群聊创建模板为可选卡片，白底、细边框、10px 圆角，选中使用浅绿底与更明显边框。弹窗为无边框白面，标准宽 520px，wide 为 820px。设置、笔记与项目复用此容器；不要把每一块普通回复另包成卡片。

### Conversation / Composer

头像、成员名称、模型与时间构成消息身份。AI 回复直接在白面上排版，用户消息有浅色气泡。空状态提供真实可执行的建议，不能预置伪造历史。输入框把聊天方式、文本、附件、发送或停止组织为一个区域；发送遵循中文输入法组合状态。生成、取消、错误和连接中断都有明确显示。

模型明确返回的思考内容与正式回答分离，使用默认收起的原生 details / summary，标题为“思考内容”，辅助文字“模型提供”；支持键盘操作。展开区最大高 280px，内部滚动，浅色背景与细边框。无返回思考内容时不显示该区域，不虚构隐藏思考；复制回答和存为笔记只取正文。

### Project Review / LINE

文件、待审查变更与差异比较分层呈现；新增/删除同时使用颜色与符号。批准并保存与拒绝是独立动作，保留代码尚未执行或验证的说明。LINE 区分已保存凭据、已验证、服务启用与群绑定；真实绑定前不得显示已连接群聊。视觉文档不替代这些功能的实际验收。

## Do's and Don'ts

### Do:
- Do 使用中文行动文案，并保留实际模型标识与状态。
- Do 保持主对话的视觉优先级，用低饱和表面区分区域。
- Do 为图标按钮保留可访问名称、清楚的焦点和可见状态。
- Do 让项目提案、审查、保存和执行边界分别可辨。
- Do 将新增界面从本文件 token 开始；核对响应式与 CSS 优先级后再声称目标尺寸已覆盖。

### Don't:
- Don't 用成员色暗示模型质量、在线状态或权限等级。
- Don't 用概念图中的虚构群聊、计数或连接填充真实空状态。
- Don't 为正文或登录标题添加无意义的眉题。
- Don't 为浮层同时叠加装饰边框与重阴影。
- Don't 把本次视觉修复通过当作真实 LINE、所有模型、后端安全或客户验收通过。
