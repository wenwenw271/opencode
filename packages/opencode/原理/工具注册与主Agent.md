# 工具注册与主 Agent

本文档说明 opencode 中工具（如 TaskTool）如何被纳入「主 agent」的可用工具列表，即从 **ToolRegistry** 到 **当前轮主 agent 拿到的 tools** 的完整链路。

---

## 一、结论概览

- **工具不是「按主 agent 单独注册」的**，而是维护在一份**全局工具列表**（ToolRegistry）里。
- **主 agent** 由当前轮次**最后一条用户消息**的 `agent` 决定（如 build、plan）。
- 每轮正常 LLM 分支会为**当前主 agent** 调用 `resolveTools(agent, ...)`，内部通过 `ToolRegistry.tools(model, agent)` 从全局列表取工具，并对每个工具执行 `t.init({ agent })`。
- 因此：**谁在这一轮是主 agent，谁就会拿到同一套全局工具**（含 TaskTool）；TaskTool 通过 `init(agent)` 根据主 agent 的权限生成可调用的子代理列表，从而「挂到」当前主 agent 上。

---

## 二、全局工具列表：ToolRegistry

### 2.1 工具从哪来

所有内置工具（含 TaskTool）在 **ToolRegistry**（`tool/registry.ts`）的 `all()` 中**写死**在一个数组里：

```ts
async function all(): Promise<Tool.Info[]> {
  const custom = await state().then((x) => x.custom)
  const config = await Config.get()
  // ...
  return [
    InvalidTool,
    QuestionTool,   // 按配置/客户端决定
    BashTool,
    ReadTool,
    GlobTool,
    GrepTool,
    EditTool,
    WriteTool,
    TaskTool,      // ← TaskTool 在此，与具体 agent 无关
    WebFetchTool,
    TodoWriteTool,
    WebSearchTool,
    CodeSearchTool,
    SkillTool,
    ApplyPatchTool,
    LspTool,       // 实验性
    BatchTool,     // 实验性
    PlanExitTool,  // 实验性 + CLI
    ...custom,     // .opencode 下及插件注册的工具
  ]
}
```

- **位置**：`packages/opencode/src/tool/registry.ts`
- **含义**：TaskTool 等是「注册在全局列表」里，没有「注册到某个主 agent」的单独步骤。

### 2.2 自定义与插件工具

- **custom**：来自配置目录下 `{tool,tools}/*.{js,ts}` 及 **Plugin** 的 `tool` 定义，通过 `ToolRegistry.register(tool)` 或启动时扫描并入 `state().custom`，最终拼进 `all()` 的 `...custom`。
- 因此主 agent 拿到的工具 = 上述全局列表（按 model 过滤后） + 每个工具的 `init(agent)` 结果。

---

## 三、主 Agent 的确定

### 3.1 当前轮次的主 agent

在 **SessionPrompt.loop** 的「正常分支」（处理完 subtask/compaction 后走 LLM 的分支）里，主 agent 由**最后一条用户消息**决定：

```ts
/** 正常分支：取 agent、插入 plan/build 提醒、创建 processor、解析工具、调 LLM */
const agent = await Agent.get(lastUser.agent)
// ...
const tools = await resolveTools({
  agent,
  session,
  model,
  tools: lastUser.tools,
  processor,
  bypassAgentCheck,
  messages: msgs,
})
```

- **位置**：`session/prompt.ts`，loop 内约 575–629 行。
- **lastUser**：从当前会话消息流里从后往前找出的「最后一条用户消息」；其 `agent` 即当前轮的主 agent（如 build、plan）。
- 因此：**主 agent 是谁，是「当前用户消息说了算」**，不是工具侧单独配置的。

---

## 四、从全局列表到主 Agent 的工具：resolveTools

### 4.1 调用链

1. **resolveTools** 接收当前轮的 `agent`、`session`、`model`、`processor`、`messages` 等。
2. 内部调用 **ToolRegistry.tools(model, input.agent)**，传入当前 model 与当前主 agent。
3. **ToolRegistry.tools**：
   - 调用 **all()** 得到全局工具列表（含 TaskTool）。
   - 按 **model** 做少量过滤（如 codesearch/websearch 的启用条件、apply_patch 与 edit/write 的互斥）。
   - **TaskTool 不会被这里过滤掉**，始终在列表中。
   - 对列表中每个工具执行 **t.init({ agent })**，得到该工具在本轮、针对当前主 agent 的 `description` 和 `parameters`。
4. 将得到的工具集合返回给 loop，作为本轮 LLM 的 **tools** 入参。

### 4.2 关键代码（ToolRegistry.tools）

```ts
export async function tools(
  model: { providerID: string; modelID: string },
  agent?: Agent.Info,
) {
  const tools = await all()
  const result = await Promise.all(
    tools
      .filter((t) => {
        // 仅对部分工具按 model 过滤（codesearch/websearch、apply_patch/edit/write）
        // TaskTool 无过滤，return true
      })
      .map(async (t) => {
        const tool = await t.init({ agent })  // ← 当前主 agent 传入每个工具的 init
        const output = { description: tool.description, parameters: tool.parameters }
        await Plugin.trigger("tool.definition", { toolID: t.id }, output)
        return { id: t.id, ...tool, description: output.description, parameters: output.parameters }
      }),
  )
  return result
}
```

- **位置**：`tool/registry.ts` 约 129–171 行。
- **含义**：**工具「挂到」主 agent 的方式 = 在解析当前轮工具时，把当前主 agent 传给每个工具的 init**；TaskTool 通过 `init(agent)` 按主 agent 的权限生成描述和可调子代理列表。

---

## 五、TaskTool 的 init(agent)：按主 agent 定制

### 5.1 行为

TaskTool 在 **Tool.define("task", async (ctx) => { ... })** 的 init 阶段（即 `ctx` 来自 `t.init({ agent })` 时的 `agent`）：

1. 调用 **Agent.list()**，筛出 `mode !== "primary"` 的子代理（如 explore、general）。
2. 若存在 **caller（当前主 agent）**，再按 **PermissionNext.evaluate("task", a.name, caller.permission)** 过滤，得到当前主 agent **允许调用的**子代理列表 `accessibleAgents`。
3. 将 **task.txt** 中的占位符 **{agents}** 替换为上述子代理的 `name` + `description`，得到最终的 **description**。
4. 返回 **description** 与 **parameters**，供 LLM 使用；**execute** 时再根据 session/权限做具体校验。

### 5.2 关键代码（task.ts）

```ts
export const TaskTool = Tool.define("task", async (ctx) => {
  const agents = await Agent.list().then((x) => x.filter((a) => a.mode !== "primary"))
  const caller = ctx?.agent
  const accessibleAgents = caller
    ? agents.filter((a) => PermissionNext.evaluate("task", a.name, caller.permission).action !== "deny")
    : agents

  const description = DESCRIPTION.replace(
    "{agents}",
    accessibleAgents
      .map((a) => `- ${a.name}: ${a.description ?? "This subagent should only be called manually by the user."}`)
      .join("\n"),
  )
  return {
    description,
    parameters,
    async execute(params, ctx) { ... },
  }
})
```

- **位置**：`packages/opencode/src/tool/task.ts`。
- **含义**：**TaskTool 对「主 agent」的依赖只在 init 时**：用主 agent 的 permission 决定「可展示、可调用的子代理」，从而在主 agent 的 tools 里呈现不同的 Task 描述；执行时再结合 session 权限与 ctx.ask 做最终校验。

---

## 六、流程串联

| 步骤 | 说明 | 位置 |
|------|------|------|
| 1 | **ToolRegistry.all()** 返回全局工具列表，其中包含 TaskTool | `tool/registry.ts` |
| 2 | 会话 loop 取 **lastUser.agent**，得到当前轮**主 agent**（如 build） | `session/prompt.ts`（loop） |
| 3 | 调用 **resolveTools({ agent, session, model, ... })** | `session/prompt.ts` |
| 4 | resolveTools 调用 **ToolRegistry.tools(model, agent)** | `session/prompt.ts` → `tool/registry.ts` |
| 5 | **all()** 取列表，按 model 过滤（Task 不过滤），对每项执行 **t.init({ agent })** | `tool/registry.ts` |
| 6 | **TaskTool.init(agent)** 按主 agent 权限过滤子代理，替换 `{agents}`，返回 description + parameters | `tool/task.ts` |
| 7 | 返回的 **tools** 作为本轮 LLM 的入参，主 agent 在本轮即可使用 Task 等工具 | `session/prompt.ts`（processor.process） |

---

## 七、相关源码位置速查

| 内容 | 文件路径 |
|------|----------|
| 全局工具列表 all()、tools(model, agent) | `packages/opencode/src/tool/registry.ts` |
| 主 agent 的确定与 resolveTools 调用 | `packages/opencode/src/session/prompt.ts`（loop 内） |
| resolveTools 实现 | `packages/opencode/src/session/prompt.ts`（resolveTools） |
| TaskTool 定义与 init(agent) | `packages/opencode/src/tool/task.ts` |
| 工具接口 Tool.define、InitContext | `packages/opencode/src/tool/tool.ts` |

---

## 八、与「子任务」文档的关系

- **子任务流程与配置来源**（`原理/子任务流程与配置来源.md`）侧重：SubtaskPart 的创建、loop 对 subtask 的执行、TaskTool.execute 创建子会话与 cancel 等。
- 本文档侧重：**工具如何从全局注册表「挂到」当前轮主 agent」**，即 TaskTool（及所有工具）如何进入主 agent 的 tools 列表、以及 TaskTool 如何根据主 agent 定制描述与可调子代理。两者结合可完整理解「主 agent 使用 Task 工具调用子 agent」的整条链路。
