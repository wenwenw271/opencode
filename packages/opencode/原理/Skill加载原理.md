# Skill 加载原理

本文档说明 opencode 如何发现与加载 Skill、相关代码位置，以及是否存在“渐进式加载”及其实现方式。

---

## 1. 结论概览

- **发现与缓存**：所有 Skill 在**首次使用**（第一次调用 `Skill.get()` 或 `Skill.all()`）时，通过 **Skill.state()** 一次性扫描多个来源、解析每个 **SKILL.md**，将 `name/description/location/content` 缓存在内存；之后 `get(name)` 与 `all()` 只读缓存，**不再按需从磁盘读**。
- **注入到对话**：Agent 通过 **skill 工具**按需选择“加载哪个 skill 到当前轮上下文”；工具返回时把**该 skill 的 content（SKILL.md 正文）** 和**技能目录下的文件列表采样**拼进 output，从而**在对话里**是“用到一个再注入一个”的渐进式，但**在代码层**没有“按 name 延迟读 SKILL.md”的渐进式加载。
- **代码位置**：发现与解析在 `skill/skill.ts`，工具在 `tool/skill.ts`，远程拉取在 `skill/discovery.ts`。

---

## 2. 加载流程

### 2.1 入口：Skill.state()

**文件**：`packages/opencode/src/skill/skill.ts`

- **Skill.state** 是 **Instance.state(async () => { ... })** 的返回值，即**按项目目录（Instance.directory）缓存的单例**：同一项目下第一次有人调用 `state()` 时执行传入的 async 函数，之后同一项目内再调用 `state()` 得到同一份结果（Promise 被复用）。
- 该 async 函数内部会：
  1. 扫描多处目录与配置，收集所有 **SKILL.md** 路径；
  2. 对每个路径执行 **addSkill(match)**：用 **ConfigMarkdown.parse(match)** 解析 frontmatter + 正文，把 `name/description`（来自 frontmatter）和 `location/content`（路径 + 正文）写入内存对象 **skills[name]**；
  3. 最后返回 **{ skills, dirs }**，其中 `dirs` 为所有包含 SKILL.md 的目录列表。

因此：**所有 Skill 的 content 都在这次初始化时从磁盘读入并常驻内存**；`Skill.get(name)` / `Skill.all()` 只从这份缓存读，不再访问磁盘。

### 2.2 技能来源（扫描顺序）

| 来源 | 说明 | 代码位置（skill.ts 内） |
|------|------|--------------------------|
| **外部目录（全局）** | `~/.claude`、`~/.agents` 下匹配 **skills/**\***/SKILL.md** | EXTERNAL_DIRS + scanExternal(Global.Path.home) |
| **外部目录（项目）** | 从 Instance.directory 向 worktree 上溯，在每个 .claude/.agents 下扫 skills/**/SKILL.md | Filesystem.up + scanExternal(root) |
| **配置目录** | Config.directories() 下 **{skill,skills}/**\***/SKILL.md** | Glob.scan(OPENCODE_SKILL_PATTERN) |
| **配置路径** | config.skills?.paths（可多条，支持 ~/ 与相对路径）下 **\***\*/SKILL.md** | config.skills?.paths + Glob.scan(SKILL_PATTERN) |
| **配置 URL** | config.skills?.urls：拉取 index.json，按列表下载文件到缓存目录，再在缓存下扫 **\***\*/SKILL.md** | Discovery.pull(url) + Glob.scan |

同名 skill 后扫到的会覆盖先前的（项目级覆盖全局、config 路径/URL 在更后）。

### 2.3 addSkill(match) 在做什么

- 调用 **ConfigMarkdown.parse(match)** 得到 `md = { data: frontmatter, content: 正文 }`。
- 用 **Info.pick({ name, description }).safeParse(md.data)** 校验 frontmatter；失败则跳过。
- 将 **skills[name] = { name, description, location: match, content: md.content }** 写入缓存。  
即：**每个 Skill 的 content（SKILL.md 全文）在 state 初始化时就已经读入**，没有“仅读 name/description，等 get(name) 再读 content”的延迟加载。

---

## 3. 工具侧：skill 工具如何“加载”到对话

**文件**：`packages/opencode/src/tool/skill.ts`

- **init**：根据当前 agent 权限过滤出可用的 skill 列表，生成工具描述（`<available_skills>` 下列出 name/description/location），参数为 **name**。
- **execute(params)**：
  1. **Skill.get(params.name)**：从上述缓存取该 skill（不触发新扫描）；
  2. 请求 **skill** 权限（ctx.ask）；
  3. 取技能目录 **dir = path.dirname(skill.location)**，用 **Ripgrep.files** 列出目录下文件（排除 SKILL.md），**最多 10 个**，拼成 `<skill_files>` 列表；
  4. 返回一段 output：**`<skill_content name="...">`** + 标题 + **skill.content**（SKILL.md 正文）+ base directory 说明 + **`<skill_files>`**（采样文件路径）。

因此：**“加载到对话”** = 把该 skill 的 **content** 和文件列表采样写进工具 output，供后续消息作为上下文；**没有**在工具里再读一次 SKILL.md 或按需读技能内其他文件，content 来自 state 里已有缓存。

---

## 4. Skill 与主 Agent 的绑定（主 agent 如何知道有哪些技能）

主 agent 不需要单独“注册”技能；它通过**拿到的工具列表里自带的 skill 工具 + 该工具描述里的可用技能列表**来知道有哪些技能、并在需要时调用。

### 4.1 结构上的绑定：skill 工具在全局工具列表里

- **ToolRegistry.all()**（`tool/registry.ts`）返回的内置工具列表中包含 **SkillTool**，与 Read、Edit、Task 等一起作为“当前会话可用工具”的候选。
- 每轮构造发给模型的 prompt 时，会调用 **ToolRegistry.tools(model, agent)** 得到**当前 agent 可用的工具定义**（含 description、parameters 等）。  
  这里的 **agent** 就是当前轮的主 agent（例如默认的 build）。

因此：主 agent 天然就拥有一支名为 **skill** 的工具；不需要额外配置“把 skill 绑定到主 agent”。

### 4.2 内容上的绑定：工具描述里带上“当前可用的技能列表”

- **ToolRegistry.tools(model, agent)** 会对每个工具调用 **t.init({ agent })**。  
  对 **SkillTool** 而言，init 会：
  1. 调用 **Skill.all()** 拿到所有已发现的 skill（来自 Skill.state 的缓存）；
  2. 若传入了 **agent**，则用 **PermissionNext.evaluate("skill", skill.name, agent.permission)** 过滤，只保留该 agent 未被 deny 的技能；
  3. 用过滤后的列表拼成工具 **description**：一段说明文字 + **`<available_skills>`**，里面列出每个技能的 **name、description、location**；
  4. 参数为 **name**（从 available_skills 里选一个）。

- 这份 **description** 和 **parameters** 一起，作为 skill 工具的 schema 随 **tools** 传给 **processor.process({ tools, ... })**，即**原样发给模型**。

因此：主 agent（模型）在当轮看到的 skill 工具定义里，已经写明了“当前你可用的技能有哪些”；模型根据任务匹配到某个技能时，调用 `skill(name="...")` 即可加载该技能到对话上下文。

### 4.3 调用链小结

| 步骤 | 位置 | 说明 |
|------|------|------|
| 1 | session/prompt 构造当轮 | 确定当前 **agent**（主 agent），调用 **resolveTools({ agent, model, ... })**。 |
| 2 | resolveTools | 调用 **ToolRegistry.tools(model, input.agent)**，传入主 agent。 |
| 3 | ToolRegistry.tools | 对每个工具（含 SkillTool）执行 **t.init({ agent })**；SkillTool.init 用 Skill.all() + 权限过滤，生成带 **&lt;available_skills&gt;** 的 description。 |
| 4 | resolveTools | 将返回的工具（id、description、parameters、execute）转成模型侧 tool 定义，写入 **tools**。 |
| 5 | processor.process | 把 **tools**（含 skill 工具及其描述里的可用技能列表）发给模型；模型据此知道“有什么技能”并在合适时调用 skill(name)。 |

所以：**主 agent 与 skill 的绑定 = 主 agent 使用的工具列表里包含 skill 工具，且该工具的 description 在 init 时按该 agent 的权限生成了“当前可用技能”列表，模型通过读这段描述就知道有哪些技能、如何按需加载。**

---

## 5. 是否实现“渐进式加载”

### 5.1 代码层（磁盘 / 内存）

- **没有**“按 skill name 渐进式从磁盘加载”：  
  首次使用 Skill 模块时，**所有** SKILL.md 都会被扫描并解析，**content 全部读入内存**。之后 `Skill.get(name)` 只是查表。
- **没有**“只加载 name/description，content 等 get(name) 再读”的实现；**没有**分片或流式读 SKILL.md。

### 5.2 对话层（上下文）

- **有**“按需注入到当前轮”的用法：  
  Agent 在一次对话中可多次调用 skill 工具，每次传一个 **name**，只有**被选中的那个 skill** 的 content 会出现在该次工具调用的 output 里，从而进入后续上下文。因此从**对话上下文**角度看，是“用到一个 skill 再注入一个”的**渐进式使用**，而不是一次性把所有 skill 正文都塞进 prompt。
- 技能目录下的**其他文件**（非 SKILL.md）不会在加载时读入；工具只提供**最多 10 个文件路径**的采样，若需要内容，由 Agent 后续用 read/grep 等工具按路径再读，这也是一种“按需加载”到上下文的方式。

### 5.3 小结

| 层面 | 是否渐进式 | 说明 |
|------|------------|------|
| **Skill 发现与 content 读取** | 否 | 首次访问时一次性扫描并解析所有 SKILL.md，content 全部进内存。 |
| **对话中 skill 的注入** | 是 | 仅当 Agent 调用 skill 工具并传入 name 时，该 skill 的 content 被写入当次 output，进入上下文；一次一个，按需选择。 |
| **技能目录内其他文件** | 是 | 只提供路径采样，不读内容；需要时由 Agent 用 read 等工具按路径加载。 |

---

## 6. 相关代码位置

| 职责 | 文件 | 说明 |
|------|------|------|
| Skill 发现、解析、缓存 | **skill/skill.ts** | Skill.state、addSkill、get、all、dirs；EXTERNAL_DIRS、OPENCODE_SKILL_PATTERN、config.skills?.paths/urls。 |
| 技能工具定义与执行 | **tool/skill.ts** | SkillTool：init 时 all() 生成描述，execute 时 get(name)、拼 output（content + skill_files 采样）。 |
| 从 URL 拉取技能包 | **skill/discovery.ts** | Discovery.pull(url)：拉 index.json、按 files 下载到 cache、返回含 SKILL.md 的目录列表。 |
| 配置与实例状态 | **config/config.ts**（skills?.paths、urls）、**project/instance.ts**（Instance.state）、**project/state.ts**（State.create 缓存）。 |

---

## 7. 数据流简图

```
首次 Skill.get() / Skill.all()
    → Skill.state() 执行
        → 扫描 .claude/.agents、Config.directories、config.skills.paths
        → Discovery.pull(config.skills.urls) 拉取远程并加入扫描
        → 对每个 SKILL.md：ConfigMarkdown.parse → addSkill → skills[name] = { name, description, location, content }
    → 返回 { skills, dirs } 并缓存

Agent 调用 skill 工具(name)
    → Skill.get(name) 从缓存取
    → 取 dir，Ripgrep.files 采样最多 10 个文件路径
    → 返回 output = <skill_content> + content + <skill_files>
    → 该 output 进入当轮消息，作为后续上下文的“已加载 skill”
```

---

*Skill 的 frontmatter 与 SKILL.md 格式约定见 Cursor 技能文档；配置目录与 config 结构见《数据库表与结构》等。*
