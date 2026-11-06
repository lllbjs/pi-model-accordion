# dsh-model-accordion v0.9.0 → pi-desktop 插件：逐项移植评估

对照对象：`/Users/xinna/Documents/code-me/Agent-Daddy/dsh-model-accordion` 本地 v0.9.0（`lib/client.js` 2874 行 + `vendored/` 四个连接器宿主）。

一个关键前提：原插件自己**也是装饰 DOM，不重写选择器**（其 README 原话：「插件只装饰 DOM，不重写选择器。模型选择、推理等级切换、供应商加载和 `/model` 命令仍然由 `@deepseek-ai/dsh-client-ui-model-selection` 负责」）。所以「在选择器里折叠」用插件路线是可行的，本插件的 `renderer/picker-fold.mjs` 走的正是同一条路；真正无法移植的是它依赖 DSH 私有能力的部分。

## 一、可移植并已实现

| 原插件能力 | pi-desktop 落点 | 状态 |
| --- | --- | --- |
| 手风琴（点标题展开、其他自动收起） | 装饰宿主选择器 DOM | 已实现 |
| 多开（`Ctrl`/`Cmd` + 点击） | 同上 | 已实现 |
| 全部收起（再点已展开的供应商） | 同上 | 已实现 |
| 搜索穿透（输入时全部展开） | 宿主已有搜索框，插件读其值 | 已实现 |
| 清空搜索后收敛回当前模型所在供应商 | 同上 | 已实现 |
| 打开时自动展开当前模型所在供应商 | 同上 | 已实现 |
| 记忆状态（关菜单后保留） | 模块内状态，会话内保留 | 已实现（跨刷新未做） |
| 当前模型标记 | 宿主已渲染 `aria-checked` 与勾选图标 | 宿主原生 |
| 默认档位即折叠 | 设置项 `pickerFoldCollapsedByDefault` | 已实现 |

## 二、插件路线可做、尚未实现

| 原插件能力 | 说明 |
| --- | --- |
| 全部展开 / 收起工具栏按钮 | 需往宿主菜单里注入一个按钮；可做 |
| 记忆状态跨刷新 | 写 `localStorage` 即可 |
| 星标按钮 / 收藏（`★` 分组置顶） | 行内星标可装饰；「置顶分组」要改宿主渲染顺序，会被 React 重渲染冲掉，只能做半个 |
| 标题显示当前模型（`● <模型> · <数量>`） | 可写进分组标题 |
| 中英双语 | 插件可自带文案表，按宿主 locale 切换 |
| 测试模型（真实上游调用） | 插件可用 `net.fetch` 打本机网关的 `chat/completions` 做等价探测 |
| 一键刷新模型列表 | 本插件已有 `modelCatalog.refresh`（拉 `/v1/models`），已等价 |
| 注册自己的连接器 | 本插件设置项 `gatewayEndpoints` 已等价 |

## 三、插件路线做不到（需宿主新增能力）

| 原插件能力 | 障碍 |
| --- | --- |
| 推理等级 chip / `· effort` 字幕 / 提交降级 | pi-desktop 没有插件可用的「设置推理等级」通道；宿主是独立的 `ThinkingLevelSlider` 组件。原插件也没接管这项（依赖 DSH 的模型目录服务） |
| 供应商排序（默认 / A→Z / 数量 ↓） | 顺序由宿主 `modelGroups` 决定，插件改 DOM 顺序会被重渲染还原 |
| 固定高度（菜单高度不跳动） | 宿主菜单自身的高度策略 |
| 键盘操作（`Tab` 到标题、`↑`/`↓` 在标题间、`→`/`←` 展开收起） | 与宿主契约冲突：宿主的方向键在**全量**模型上移动下标（`useComposerModelMenu.ts` 用 `flatModels.length` 取模），不看 DOM 可见性，且只在搜索框聚焦时生效。插件隐藏行后，方向键/`Enter` 仍会走到折叠起来的行上 |
| 顶替模型座位（`ctx.slots.inject("conversation.input.model", …, priority: -1)`） | pi-desktop 渲染端插槽白名单里没有模型选择器插槽 |
| 热重载（改文件一两秒替换） | pi-desktop 的插件模块由宿主加载，需重载插件而非热替换 |

## 四、connector 与统一设置中心（0.9.0 的主体）

原插件 0.8.0 起把 WorkBuddy 5.17.0、Trae 4.6.12、Qoder 1.16.4、OpenCode 0.3.14 四个连接器的**完整代码**复制进 `vendored/`，用 `cordis.patch.yml` 的四行 `insert:` 指向各自 `lib/index.js`，并沿用旧 `entry.id`（因为它们同时是 settings 命名空间、`/plugins/<id>/…` 路由前缀和已保存配置的键）；设置中心通过 `plugins.item` slot 注册一张设置卡，用浏览器 `fetch` 打这四个宿主已有的同源路由。

对照 pi-desktop：

| 该中心的能力 | pi-desktop 现状 | 判定 |
| --- | --- | --- |
| 总览（探测各连接器可达性 / 登录态 / 模型数） | 插件能探测 loopback 的 `/v1/models` 与 `/healthz`；登录态无对应概念 | 部分等价（已实现探测） |
| 账号信息（账号名 / id / 域名 / 区域 / 凭据到期 / 积分 / 签到 / IP 池） | 无账号体系，无对应路由 | 不可移植 |
| 账号配置（Qoder PAT 增删、WorkBuddy 账号切换与 OAuth、Trae 刷新） | 没有 OAuth / PAT 存储与登录流程 API | 不可移植 |
| 模型列表（上下文长度 / 倍率 / 标签 / 区域切换） | 宿主模型目录无倍率、区域字段 | 不可移植（数据不存在） |
| 测试模型（真实上游调用） | 可用 `net.fetch` 自行发起 | 可做 |
| 一键刷新全部模型 | 插件可并发重拉各网关 | 可做（部分已有） |
| 连接器注册（新增一个 provider 入口） | 插件只有 `provider.register`：声明 `baseUrl` + `apiStyle` + `authKind`，模型列表由宿主发现 | 能力不对等，只能声明式接入 |
| 设置卡（`plugins.item` slot） | pi-desktop 插件只有 view + 声明式 settings，没有设置卡插槽 | 不可移植 |

要在 pi-desktop 里达到等价，需要宿主新增：连接器/账号凭据 API、OAuth 流程、模型目录的刷新与排序接口、以及模型选择器插槽。这已超出「只用插件」的边界。

另外，四个 `vendored/` 子包各自随包附带 `LICENSE`（第三方代码）。要复制进 pi-desktop 需逐个核对其许可与 pi-desktop 的 LGPL-3.0 分发要求，这一步没做。

## 五、结论

「原样拷贝、一模一样」在插件路线下不成立：能 1:1 的是折叠交互与搜索行为（已实现并测试），做不到的是推理等级通道、排序/高度、键盘契约、以及整个 connector + 账号体系。折叠这套交互本身在 pi-desktop 是**契约外**做法（用的是宿主自己的类名），宿主改版即可能失效，故留了 `foldPickerProviders` 开关。
