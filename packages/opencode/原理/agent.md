# Agent 模块原理

Agent 模块（`src/agent/agent.ts`）负责管理各类 AI 代理的配置、权限与运行时信息，包括内置代理定义、用户配置合并、默认代理选择以及基于自然语言描述生成新代理。

---

## 1. 状态初始化 (state)

状态通过 `Instance.state` 懒加载单例维护，首次访问时执行一次初始化。

### 1.1 权限基础

- 读取 **Config** 与 **Skill 目录**，得到技能路径白名单。
- 构造 **默认权限 (defaults)**：
  - 多数操作为 `allow`
  - `doom_loop`、`external_directory` 等为 `ask`
  - `question`、`plan_enter`、`plan_exit` 为 `deny`
  - `.env` 相关为 `ask`，`*.env.example` 为 `allow`
- 从 `cfg.permission` 得到 **用户权限 (user)**，后续与各代理的默认权限合并。

### 1.2 内置代理表

| 代理名 | 模式 | 说明 |
|--------|------|------|
| **build** | primary | 默认主代理，可执行工具，允许 question / plan_enter |
| **plan** | primary | 计划模式，禁止编辑类工具，仅允许编辑计划相关路径 |
| **general** | subagent | 通用子代理，多步任务与并行执行，禁用 todoread/todowrite |
| **explore** | subagent | 探索子代理，只读 + grep/glob/list/read 等，用于快速检索代码库 |
| **compaction** | primary, hidden | 内部用，仅 prompt，无工具 |
| **title** | primary, hidden | 内部用，生成会话标题 |
| **summary** | primary, hidden | 内部用，生成会话摘要 |

### 1.3 用户配置覆盖 (cfg.agent)

遍历 `cfg.agent` 的每一项：

- **禁用**：`disable: true` 时从结果中删除该代理。
- **覆盖**：已存在的内置代理可被覆盖字段（model、variant、prompt、description、temperature、topP、mode、color、hidden、name、steps、options、permission）。
- **新增**：若 key 不在内置表中，则新增一条代理，`native: false`，权限为 defaults + user。

### 1.4 Truncate.GLOB 保证

若某代理**未显式**对 `Truncate.GLOB` 做 `external_directory: deny`，则为其合并一条 `external_directory: { [Truncate.GLOB]: "allow" }`，保证截断工具所需目录可用。

---

## 2. 查询接口

| 方法 | 作用 |
|------|------|
| **get(name)** | 按名称取单个代理信息，不存在则为 `undefined` |
| **list()** | 列出所有代理；排序规则：默认代理或 `build` 排最前（desc），便于 UI 展示 |
| **defaultAgent()** | 解析当前默认主代理名：优先 `cfg.default_agent`，否则取第一个「非 subagent 且非 hidden」的主代理；若设为 subagent 或 hidden 会抛错 |

---

## 3. 生成新代理 (generate)

根据自然语言描述生成新代理的配置（identifier / whenToUse / systemPrompt）。

### 3.1 输入与模型

- **input.description**：用户对代理用途的描述。
- **input.model**：可选；不传则使用 Provider 的默认模型。
- 系统提示使用 `generate.txt`，并传入**已有代理名黑名单**，避免 identifier 重复。

### 3.2 输出结构 (Zod schema)

- `identifier`：代理唯一标识
- `whenToUse`：使用场景说明
- `systemPrompt`：系统提示词

### 3.3 OpenAI OAuth 分支

当默认模型为 OpenAI 且该 Provider 为 OAuth 认证时：

- 使用 **streamObject** 调用，并在 `providerOptions` 中注入 `SystemPrompt.instructions()`。
- 通过消费 `fullStream` 在出错时抛出。

否则使用普通的 **generateObject**，直接返回 `result.object`。

---

## 4. 数据流小结

```
Config.get() + Skill.dirs()
        ↓
  defaults + user 权限
        ↓
  内置 7 个代理定义
        ↓
  cfg.agent 覆盖/禁用/新增
        ↓
  Truncate.GLOB 保证
        ↓
  得到最终 Agent 注册表 (state)
        ↓
  get / list / defaultAgent 查询
  generate 生成新代理配置
```

---

## 5. 相关文件

- 实现：`packages/opencode/src/agent/agent.ts`
- 生成代理用系统提示：`packages/opencode/src/agent/generate.txt`
- 各内置代理 prompt：`packages/opencode/src/agent/prompt/*.txt`（compaction、explore、summary、title）

# agent定义及内部实现

## 七个默认agent
```ts
/** 内置代理定义：先写死默认项，再被 cfg.agent 覆盖 */
    const result: Record<string, Info> = {
      /** 默认主代理：可执行工具，允许 question / plan_enter */
      build: {
        name: "build",
        description: "The default agent. Executes tools based on configured permissions.",
        options: {},
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            question: "allow",
            plan_enter: "allow",
          }),
          user,
        ),
        mode: "primary",
        native: true,
      },
      /** 计划模式：禁止编辑类工具，仅允许编辑计划相关路径 */
      plan: {
        name: "plan",
        description: "Plan mode. Disallows all edit tools.",
        options: {},
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            question: "allow",
            plan_exit: "allow",
            external_directory: {
              [path.join(Global.Path.data, "plans", "*")]: "allow",
            },
            edit: {
              "*": "deny",
              [path.join(".opencode", "plans", "*.md")]: "allow",
              [path.relative(Instance.worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]: "allow",
            },
          }),
          user,
        ),
        mode: "primary",
        native: true,
      },
      /** 通用子代理：多步任务与并行执行，禁用 todoread/todowrite */
      general: {
        name: "general",
        description: `General-purpose agent for researching complex questions and executing multiple units of work in parallel.`,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            todoread: "deny",
            todowrite: "deny",
          }),
          user,
        ),
        options: {},
        mode: "subagent",
        native: true,
      },
      /** 探索子代理：只读 + 搜索/列表/读文件，用于快速检索代码库 */
      explore: {
        name: "explore",
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            grep: "allow",
            glob: "allow",
            list: "allow",
            bash: "allow",
            webfetch: "allow",
            websearch: "allow",
            codesearch: "allow",
            read: "allow",
            external_directory: {
              "*": "ask",
              ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
            },
          }),
          user,
        ),
        description: `Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.`,
        prompt: PROMPT_EXPLORE,
        options: {},
        mode: "subagent",
        native: true,
      },
      /** 压缩主代理：内部用，隐藏，仅 prompt 无工具 */
      compaction: {
        name: "compaction",
        mode: "primary",
        native: true,
        hidden: true,
        prompt: PROMPT_COMPACTION,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        options: {},
      },
      /** 标题主代理：内部用，隐藏，生成会话标题 */
      title: {
        name: "title",
        mode: "primary",
        options: {},
        native: true,
        hidden: true,
        temperature: 0.5,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        prompt: PROMPT_TITLE,
      },
      /** 摘要主代理：内部用，隐藏，生成会话摘要 */
      summary: {
        name: "summary",
        mode: "primary",
        options: {},
        native: true,
        hidden: true,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        prompt: PROMPT_SUMMARY,
      },
    }
```

---
