# /init 命令执行流程

本文档说明用户执行 `/init` 命令后，OpenCode 从入口到完成「创建/更新 AGENTS.md」及项目已初始化标记的完整流程。

---

## 1. 命令定义与模板

**定义位置**：`packages/opencode/src/command/index.ts`

- **Command.Default.INIT** = `"init"`
- 内置命令表 `state()` 中：
  - **name**: `init`
  - **description**: `"create/update AGENTS.md"`
  - **source**: `"command"`
  - **template**: 来自 `PROMPT_INITIALIZE`（`command/template/initialize.txt`），其中 `${path}` 在 getter 中被替换为 `Instance.worktree`
  - **hints**: 从模板解析出的占位符（含 `$ARGUMENTS`）

**模板内容概要**（`command/template/initialize.txt`）：

- 要求分析代码库并创建 **AGENTS.md**
- 内容包含：构建/lint/测试命令、代码风格（import、格式、类型、命名、错误处理等）、约 150 行、可参考 .cursor/rules/ 或 .github/copilot-instructions.md
- 若已有 AGENTS.md 则改进，路径为 `${path}`（即工作区根目录）
- 末尾有 `$ARGUMENTS`，用户可追加参数（如 `/init` 后跟文字会进入 arguments）

---

## 2. 入口一：用户在聊天中输入 /init

### 2.1 触发方式

- 用户在 Cursor/App 会话输入框中输入 **/init**（或 `/init 一些参数`）。
- 前端或 ACP 将整条消息作为 prompt 发给 OpenCode。

### 2.2 ACP 侧解析（Cursor 等 IDE）

**文件**：`packages/opencode/src/acp/agent.ts`

1. **prompt(params)** 被调用，收到 **PromptRequest**（含 `sessionId`、`prompt` 等）。
2. 将 prompt 转为 **parts**（text/file/image 等）。
3. **解析是否为命令**：
   - 把所有 text part 拼成一条字符串，trim。
   - 若**不以 `/` 开头** → 视为普通消息，调用 `this.sdk.session.prompt({ sessionID, parts, agent, ... })`，流程结束（不走 init）。
   - 若**以 `/` 开头** → 解析为 `cmd = { name, args }`：  
     `name` = 第一个空格前子串（去掉首字符 `/`），`args` = 剩余部分 trim。  
     例如 `/init` → `{ name: "init", args: "" }`，`/init foo` → `{ name: "init", args: "foo" }`。
4. **查找命令**：`this.config.sdk.command.list({ directory }).then(x => x.data.find(c => c.name === cmd.name))`。
5. 若找到 **command**（如 `init`）：
   - 调用 **`this.sdk.session.command({ sessionID, command: command.name, arguments: cmd.args, model, agent, directory })`**  
     即请求 OpenCode 的 **POST `/:sessionID/command`**，body 含 `command: "init"`, `arguments: ""`（或用户跟的参数）。
6. 若未找到命令，则可能走 `switch (cmd.name)`（如 `compact`）或仅发送 usage 更新等。

### 2.3 HTTP：POST /:sessionID/command

**文件**：`packages/opencode/src/server/routes/session.ts`

- 路由：**POST `/:sessionID/command`**
- 校验：**SessionPrompt.CommandInput**（省略 sessionID，因从 path 取），body 含 `command`、`arguments`、可选 `agent`/`model`/`variant`/`parts`。
- 处理：`const msg = await SessionPrompt.command({ ...body, sessionID })`，返回 `msg`（助手消息 + parts）。

此后流程与「入口二」在 **SessionPrompt.command** 内汇合。

---

## 3. 入口二：直接调用会话初始化 API（POST /:sessionID/init）

**文件**：`packages/opencode/src/server/routes/session.ts`、`packages/opencode/src/session/index.ts`

- 路由：**POST `/:sessionID/init`**
- Body：`Session.initialize.schema.omit({ sessionID })`，即 **providerID、modelID、messageID**（均为必填）。
- 处理：`await Session.initialize({ ...body, sessionID })`。

**Session.initialize**（`session/index.ts`）：

- 入参：`sessionID`、`providerID`、`modelID`、`messageID`。
- 内部仅调用一次 **SessionPrompt.command**：
  - **sessionID**、**messageID**：来自入参
  - **command**：`Command.Default.INIT`（`"init"`）
  - **arguments**：`""`
  - **model**：`input.providerID + "/" + input.modelID`（字符串，供 Provider.parseModel 使用）

不传 agent 时，command 内部会用默认 agent（见下）。

---

## 4. SessionPrompt.command 统一流程

**文件**：`packages/opencode/src/session/prompt.ts`（约 1756–1886 行）

无论从「聊天 /init」还是「POST /init」进来，只要走到 **SessionPrompt.command**，都按同一套逻辑执行。

### 4.1 解析命令与模板

1. **Command.get(input.command)**  
   得到 init 的 **Command.Info**（name、template、description、agent、model、subtask 等）。init 未配置 agent/model/subtask，故均为默认。

2. **agentName**  
   `command.agent ?? input.agent ?? (await Agent.defaultAgent())` → 通常为 **defaultAgent()**（如 build）。

3. **input.arguments**  
   用 **argsRegex** 解析出 token 列表，再按 **placeholderRegex** 与 **$ARGUMENTS** 填入模板：
   - init 模板里只有 `$ARGUMENTS`，无 `$1` 等。
   - **template** = `PROMPT_INITIALIZE.replace("${path}", Instance.worktree).replaceAll("$ARGUMENTS", input.arguments)`  
     `/init` 时 `arguments` 为空，则 `$ARGUMENTS` 被替换为空字符串。

4. **ConfigMarkdown.shell(template)**  
   若模板中含 markdown 代码块内联 shell（如 \`!`...`\`），会先执行并把结果写回模板；init 模板通常没有，跳过。

5. **taskModel**  
   init 无 command.model / command.agent，故用 `input.model`（有则 **Provider.parseModel**）或 **lastModel(sessionID)**。

6. **Provider.getModel(taskModel...)**  
   校验模型存在，若不存在则发 **Session.Event.Error** 并抛错。

7. **Agent.get(agentName)**  
   校验代理存在，不存在则发 Event.Error 并抛错。

### 4.2 构造 parts 与调用 prompt

8. **templateParts = await resolvePromptParts(template)**  
   将模板中的 `@file` 等引用展开为 part 列表；init 模板一般只有一段说明文字，得到**一个 text part**（或少量 part）。

9. **isSubtask**  
   init 未设 `subtask: true`，且默认 agent 为 primary → **isSubtask = false**。

10. **parts**  
    - 非 subtask → `parts = [...templateParts, ...(input.parts ?? [])]`  
      即**以模板展开结果为主**（一条「请分析代码库并创建 AGENTS.md」的说明）。

11. **userAgent / userModel**  
    - 非 subtask：userAgent = agentName（默认 agent），userModel = taskModel（上一步解析的模型）。

12. **Plugin.trigger("command.execute.before", ...)**  
    可在此修改 parts 等。

13. **await prompt({ sessionID, messageID, model: userModel, agent: userAgent, parts, variant: input.variant })**  
    用**同一条会话**发一条「用户消息」：内容为 init 的完整说明（+ 可选用户追加的 arguments），然后进入 **SessionPrompt.loop**。

### 4.3 等价效果

- 相当于用户在该会话里**发了一条系统预置的长消息**：「请分析代码库并创建/更新 AGENTS.md，要求…（模板内容）」，可选带 `/init` 后面的参数。
- **loop** 会按正常会话流程：取 lastUser、选 agent、**resolveTools**、**SessionProcessor.process** → **LLM.stream**，模型可调用 **read / grep / write** 等工具分析仓库并写入 **AGENTS.md**。
- 当模型完成回复（可能多轮 tool-calls 后结束），**prompt()** 返回的即该轮助手消息（含 parts）。
- **SessionPrompt.command** 再 **Bus.publish(Command.Event.Executed, { name: "init", sessionID, arguments, messageID: result.info.id })**，并返回 result。

---

## 5. 命令执行完成后的副作用：Project.setInitialized

**文件**：`packages/opencode/src/project/bootstrap.ts`

- **InstanceBootstrap()** 在启动时会 **Bus.subscribe(Command.Event.Executed, async (payload) => { ... })**。
- 若 **payload.properties.name === Command.Default.INIT**（即 `"init"`）：
  - 调用 **Project.setInitialized(Instance.project.id)**。

**Project.setInitialized**（`project/project.ts`）：

- 对当前 **ProjectTable** 的该条记录执行 **update**，设置 **time_initialized = Date.now()**。
- 用于标记「该项目已执行过 /init」，便于 UI 或逻辑上区分「未初始化 / 已初始化」项目。

---

## 6. 数据流小结

```
[入口 A] 用户输入 /init（或 /init 参数）
    → ACP prompt() 解析出 cmd = { name: "init", args: "..." }
    → sdk.session.command({ sessionID, command: "init", arguments: cmd.args, ... })
    → HTTP POST /:sessionID/command

[入口 B] 客户端或自动化调用
    → HTTP POST /:sessionID/init，body: { providerID, modelID, messageID }
    → Session.initialize({ sessionID, providerID, modelID, messageID })
    → SessionPrompt.command({ sessionID, messageID, command: "init", arguments: "", model: "providerID/modelID" })

[汇合] SessionPrompt.command
    → Command.get("init") → template = PROMPT_INITIALIZE(worktree), $ARGUMENTS 替换为 arguments
    → resolvePromptParts(template) → parts（多为一条「创建 AGENTS.md」说明）
    → agent = defaultAgent(), model = input.model ?? lastModel(sessionID)
    → prompt({ sessionID, agent, model, parts }) → createUserMessage → loop()
    → 正常会话循环：LLM 读库、写 AGENTS.md（通过 write 等工具）
    → prompt() 返回助手消息
    → Bus.publish(Command.Event.Executed, { name: "init", sessionID, arguments, messageID })
    → 返回 result 给调用方

[副作用] Bus 订阅（bootstrap）
    → Command.Event.Executed 且 name === "init"
    → Project.setInitialized(projectId) → 更新 project 表 time_initialized
```

---

## 7. 关键文件索引

| 环节           | 路径 |
|----------------|------|
| 命令定义与模板 | `command/index.ts`、`command/template/initialize.txt` |
| ACP 解析 /init | `acp/agent.ts`（prompt 内解析 cmd、调用 sdk.session.command） |
| HTTP 路由      | `server/routes/session.ts`（POST `/:sessionID/command`、POST `/:sessionID/init`） |
| 会话初始化 API | `session/index.ts`（Session.initialize） |
| 命令执行       | `session/prompt.ts`（SessionPrompt.command → prompt → loop） |
| 初始化标记     | `project/bootstrap.ts`（订阅 Command.Event.Executed）、`project/project.ts`（setInitialized） |

---

## 8. 与普通 prompt 的差异

- **普通 prompt**：用户自由输入，parts 完全由前端/ACP 构造，直接 **session.prompt**。
- **/init**：用户输入被解析为「命令名 + 参数」，再走 **session.command**；command 层用**预置模板**生成 parts（init 模板 = 创建/更新 AGENTS.md 的说明），然后**再**调 **session.prompt**。因此 /init 的本质是「用预置的系统说明 + 可选参数，在该会话里发起一次 prompt，并由 Bus + setInitialized 做执行后记账」。
