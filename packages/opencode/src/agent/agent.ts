/**
 * Agent 模块：管理各类 AI 代理的配置、权限与运行时信息。
 * 负责内置代理定义、用户配置合并、默认代理选择以及基于描述生成新代理。
 *
 * ## 业务流程概览
 *
 * 1. **状态初始化 (state)**
 *    - 读取 Config、Skill 目录，构造默认权限 (defaults) 与用户权限 (user)。
 *    - 初始化内置代理表：build / plan / general / explore / compaction / title / summary。
 *    - 遍历 cfg.agent：可 disable 删除、覆盖已有字段、或追加新代理（native: false）。
 *    - 对未显式拒绝 Truncate.GLOB 的代理，合并允许该目录的权限。
 *
 * 2. **查询接口**
 *    - get(name)：按名称取单个代理。
 *    - list()：列出所有代理，默认/ build 排前面。
 *    - defaultAgent()：解析默认主代理（cfg.default_agent 或首个非 subagent 且非 hidden 的主代理）。
 *
 * 3. **生成新代理 (generate)**
 *    - 用 input.description + 已有代理名黑名单，调用 LLM 生成 identifier / whenToUse / systemPrompt。
 *    - 使用 generate.txt 系统提示；OpenAI OAuth 时走 streamObject 并注入 SystemPrompt.instructions()。
 */
import { Config } from "../config/config"
import z from "zod"
import { Provider } from "../provider/provider"
import { generateObject, streamObject, type ModelMessage } from "ai"
import { SystemPrompt } from "../session/system"
import { Instance } from "../project/instance"
import { Truncate } from "../tool/truncation"
import { Auth } from "../auth"
import { ProviderTransform } from "../provider/transform"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import { PermissionNext } from "@/permission/next"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@/global"
import path from "path"
import { Plugin } from "@/plugin"
import { Skill } from "../skill"

export namespace Agent {
  /** 代理元信息的 Zod 模式：名称、描述、模式、权限、模型等 */
  export const Info = z
    .object({
      name: z.string(),
      description: z.string().optional(),
      mode: z.enum(["subagent", "primary", "all"]),
      native: z.boolean().optional(),
      hidden: z.boolean().optional(),
      topP: z.number().optional(),
      temperature: z.number().optional(),
      color: z.string().optional(),
      permission: PermissionNext.Ruleset,
      model: z
        .object({
          modelID: z.string(),
          providerID: z.string(),
        })
        .optional(),
      variant: z.string().optional(),
      prompt: z.string().optional(),
      options: z.record(z.string(), z.any()),
      steps: z.number().int().positive().optional(),
    })
    .meta({
      ref: "Agent",
    })
  export type Info = z.infer<typeof Info>

  /**
   * 代理注册表状态：懒加载单例，合并默认权限、内置代理与用户配置。
   * 内置代理：build / plan / general / explore / compaction / title / summary。
   */
  const state = Instance.state(async () => {
    const cfg = await Config.get()

    // // 获取所有技能目录（比如用户安装的插件/技能目录）
    const skillDirs = await Skill.dirs()
    // // 创建白名单列表，包含：
    // // - Truncate.GLOB（可能是全局通配符）
    // // - 每个技能目录下的所有文件 (*)
    const whitelistedDirs = [Truncate.GLOB, ...skillDirs.map((dir) => path.join(dir, "*"))]
    /** 默认权限：多数操作 allow，敏感项（doom_loop、.env、question/plan）按需 ask/deny */
  // 对不同类型的外部资源（文件、目录、特定操作）设置精细化的访问权限，比如哪些允许(allow)，哪些需要询问(ask)，哪些禁止(deny)。
    const defaults = PermissionNext.fromConfig({
      //   "*": "allow",  // 默认所有操作都允许
      "*": "allow",
        // "死循环"相关操作需要询问用户
      doom_loop: "ask",
        // 对外部目录的访问权限
      external_directory: {
        "*": "ask",
        ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
      },
        // 禁止提问相关操作
      question: "deny",
        // 禁止进入计划
      plan_enter: "deny",
        // 禁止退出计划
      plan_exit: "deny",
      // mirrors github.com/github/gitignore Node.gitignore pattern for .env files
      read: {
        "*": "allow",// 默认所有文件允许读取
        "*.env": "ask",// 但环境变量文件需要询问
        "*.env.*": "ask", // 类似的环境变量文件需要询问
        "*.env.example": "allow",// 示例环境变量文件允许读取
      },
    })
    const user = PermissionNext.fromConfig(cfg.permission ?? {})

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
        // 主代理：可执行工具，允许 question / plan_enter
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
        // 计划模式：禁止编辑类工具，仅允许编辑计划相关路径
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
        // 通用代理
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
        // 探索子代理
        mode: "subagent",
        native: true,
      },
      /** 压缩主代理：内部用，隐藏，仅 prompt 无工具 */
      compaction: {
        name: "compaction",
        // 压缩主代理
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
        // 标题主代理
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
        // 摘要主代理
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

    /** 用户配置覆盖：cfg.agent 可禁用、覆盖内置或追加新代理 */
    for (const [key, value] of Object.entries(cfg.agent ?? {})) {
      if (value.disable) {
        delete result[key]
        continue
      }
      let item = result[key]
      if (!item)
        item = result[key] = {
          name: key,
          mode: "all",
          permission: PermissionNext.merge(defaults, user),
          options: {},
          native: false,
        }
      if (value.model) item.model = Provider.parseModel(value.model)
      item.variant = value.variant ?? item.variant
      item.prompt = value.prompt ?? item.prompt
      item.description = value.description ?? item.description
      item.temperature = value.temperature ?? item.temperature
      item.topP = value.top_p ?? item.topP
      item.mode = value.mode ?? item.mode
      item.color = value.color ?? item.color
      item.hidden = value.hidden ?? item.hidden
      item.name = value.name ?? item.name
      item.steps = value.steps ?? item.steps
      item.options = mergeDeep(item.options, value.options ?? {})
      item.permission = PermissionNext.merge(item.permission, PermissionNext.fromConfig(value.permission ?? {}))
    }

    /** 未显式拒绝时，保证 Truncate.GLOB 目录被允许（截断工具所需） */
    for (const name in result) {
      const agent = result[name]
      const explicit = agent.permission.some((r) => {
        if (r.permission !== "external_directory") return false
        if (r.action !== "deny") return false
        return r.pattern === Truncate.GLOB
      })
      if (explicit) continue

      result[name].permission = PermissionNext.merge(
        result[name].permission,
        PermissionNext.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }),
      )
    }

    return result
  })

  /** 按名称取单个代理信息，不存在则为 undefined */
  export async function get(agent: string) {
    return state().then((x) => x[agent])
  }

  /** 列出所有代理，按「是否为默认/ build」降序，便于 UI 把默认放最前 */
  export async function list() {
    const cfg = await Config.get()
    return pipe(
      await state(),
      values(),
      sortBy([(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "build"), "desc"]),
    )
  }

  /** 解析默认主代理名：cfg.default_agent 优先，否则取第一个非 subagent 且非 hidden 的主代理 */
  export async function defaultAgent() {
    const cfg = await Config.get()
    const agents = await state()

    if (cfg.default_agent) {
      const agent = agents[cfg.default_agent]
      if (!agent) throw new Error(`default agent "${cfg.default_agent}" not found`)
      if (agent.mode === "subagent") throw new Error(`default agent "${cfg.default_agent}" is a subagent`)
      if (agent.hidden === true) throw new Error(`default agent "${cfg.default_agent}" is hidden`)
      return agent.name
    }

    const primaryVisible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
    if (!primaryVisible) throw new Error("no primary visible agent found")
    return primaryVisible.name
  }

  /**
   * 根据自然语言描述生成新代理配置（identifier / whenToUse / systemPrompt）。
   * 使用 generate.txt 系统提示 + 已有代理名黑名单；OAuth OpenAI 时走 streamObject + 指令注入。
   */
  export async function generate(input: { description: string; model?: { providerID: string; modelID: string } }) {
    const cfg = await Config.get()
    const defaultModel = input.model ?? (await Provider.defaultModel())
    const model = await Provider.getModel(defaultModel.providerID, defaultModel.modelID)
    const language = await Provider.getLanguage(model)

    const system = [PROMPT_GENERATE]
    await Plugin.trigger("experimental.chat.system.transform", { model }, { system })
    const existing = await list()

    const params: Parameters<typeof generateObject>[0] = {
      experimental_telemetry: {
        isEnabled: cfg.experimental?.openTelemetry,
        metadata: {
          userId: cfg.username ?? "unknown",
        },
      },
      temperature: 0.3,
      messages: [
        ...system.map(
          (item): ModelMessage => ({
            role: "system",
            content: item,
          }),
        ),
        {
          role: "user",
          content: `Create an agent configuration based on this request: \"${input.description}\".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
        },
      ],
      model: language,
      schema: z.object({
        identifier: z.string(),
        whenToUse: z.string(),
        systemPrompt: z.string(),
      }),
    }

    if (defaultModel.providerID === "openai" && (await Auth.get(defaultModel.providerID))?.type === "oauth") {
      const result = streamObject({
        ...params,
        providerOptions: ProviderTransform.providerOptions(model, {
          instructions: SystemPrompt.instructions(),
          store: false,
        }),
        onError: () => {},
      })
      for await (const part of result.fullStream) {
        if (part.type === "error") throw part.error
      }
      return result.object
    }

    const result = await generateObject(params)
    return result.object
  }
}
