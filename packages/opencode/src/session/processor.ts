/**
 * SessionProcessor：单条助手消息上的「LLM 流 + 工具」处理。
 * 由 SessionPrompt.loop 创建，负责循环调用 LLM.stream、消费 fullStream 事件（reasoning/tool/text/step），
 * 写 part、执行权限与 doom_loop 检查，并在 tool-calls 时由 AI SDK 执行工具后继续下一轮，直到模型结束或出错。
 */
import { MessageV2 } from "./message-v2"
import { Log } from "@/util/log"
import { Identifier } from "@/id/id"
import { Session } from "."
import { Agent } from "@/agent/agent"
import { Snapshot } from "@/snapshot"
import { SessionSummary } from "./summary"
import { Bus } from "@/bus"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { Plugin } from "@/plugin"
import type { Provider } from "@/provider/provider"
import { LLM } from "./llm"
import { Config } from "@/config/config"
import { SessionCompaction } from "./compaction"
import { PermissionNext } from "@/permission/next"
import { Question } from "@/question"

export namespace SessionProcessor {
  /** 同一工具、同一参数连续调用达到此次数时触发 doom_loop 权限询问，防止死循环 */
  const DOOM_LOOP_THRESHOLD = 3
  const log = Log.create({ service: "session.processor" })

  export type Info = Awaited<ReturnType<typeof create>>
  export type Result = Awaited<ReturnType<Info["process"]>>

  // 封装了与大型语言模型（LLM）的流式交互、工具调用管理、会话状态更新、权限控制以及异常恢复等复杂逻辑，旨在支持单轮或多轮的“LLM → 工具 → LLM”循环
  /** 为一条助手消息创建 processor，持有 toolCallId -> ToolPart 映射，暴露 process(streamInput) 驱动单轮或多轮 LLM+工具 */
  export function create(input: {
    assistantMessage: MessageV2.Assistant
    sessionID: string
    model: Provider.Model
    abort: AbortSignal
  }) {
    // toolcalls：映射表，键为工具调用 ID（由 LLM 生成），值为对应的 ToolPart 对象。用于在流式事件中快速定位需要更新的 Part。
    const toolcalls: Record<string, MessageV2.ToolPart> = {}
    let snapshot: string | undefined
    let blocked = false
    let attempt = 0
    let needsCompaction = false

    // result 是一个对象，包含 message getter、partFromToolCall 方法和 process 方法
    const result = {
      get message() {
        return input.assistantMessage
      },
      partFromToolCall(toolCallID: string) {
        return toolcalls[toolCallID]
      },
      /** 消费 LLM 流：每轮调 LLM.stream，按 fullStream 事件写 part；若有 tool-calls 则由 SDK 执行后下一轮，否则返回 stop/continue/compact */
      /** process 是一个 async 函数，接收 LLM.StreamInput（通常包含消息历史、工具列表、模型参数等），并在一个 while(true) 循环中反复调用 LLM 流，直到满足退出条件。*/
      // {
      //   type: 'step-start',
      //   messageId: 'msg-DJ1azZRazAQfLVBrRlP8Oyzz',
      //   request: {
      //     body: '{"model":"qwen-plus","temperature":0,"messages":[{"role":"user","content":"用一句话介绍北京。然后调用 get_time 工具一次。"}],"tools":[{"type":"function","function":{"name":"get_time","description":"返回当前时间","parameters":{"type":"object","properties":{"tz":{"type":"string"}},"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}}}],"tool_choice":"auto","stream":true,"stream_options":{"include_usage":true}}'
      //   },
      //   warnings: []
      // }
      //   法返回字符串值："compact"、"stop" 或 "continue"
      async process(streamInput: LLM.StreamInput) {
        log.info("process")
        needsCompaction = false
        const shouldBreak = (await Config.get()).experimental?.continue_loop_on_deny !== true
        while (true) {
          try {
            let currentText: MessageV2.TextPart | undefined
            let reasoningMap: Record<string, MessageV2.ReasoningPart> = {}

            // 调用 LLM.stream 开始流式处理
            const stream = await LLM.stream(streamInput)

            for await (const value of stream.fullStream) {
              log.warn("[Web调试] 收到请求 loop stream.fullStream 开始",value)
              input.abort.throwIfAborted()
              switch (value.type) {
                case "start":
                  SessionStatus.set(input.sessionID, { type: "busy" })
                  // 此处是跳出for循环
                  break

                /** 推理块开始：创建 reasoning part 并记入 reasoningMap */
                case "reasoning-start":
                  if (value.id in reasoningMap) {
                    continue
                  }
                  const reasoningPart = {
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "reasoning" as const,
                    text: "",
                    time: {
                      start: Date.now(),
                    },
                    metadata: value.providerMetadata,
                  }
                  reasoningMap[value.id] = reasoningPart
                  // 创建空推理块
                  await Session.updatePart(reasoningPart)
                  break

                /** 推理块增量：追加 text，updatePartDelta */
                case "reasoning-delta":
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    // 拼接完整的内容信息
                    part.text += value.text
                    if (value.providerMetadata) part.metadata = value.providerMetadata
                    // 发布事件
                    await Session.updatePartDelta({
                      sessionID: part.sessionID,
                      messageID: part.messageID,
                      partID: part.id,
                      field: "text",
                      delta: value.text,
                    })
                  }
                  break

                /** 推理块结束：写 end 时间，落库后从 reasoningMap 移除 */
                case "reasoning-end":
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    part.text = part.text.trimEnd()

                    part.time = {
                      ...part.time,
                      end: Date.now(),
                    }
                    if (value.providerMetadata) part.metadata = value.providerMetadata
                    // 更新完整的数据信息
                    await Session.updatePart(part)
                    delete reasoningMap[value.id]
                  }
                  break

                /** 工具调用开始：创建 tool part（pending），callID 与 value.id 对应 */
                case "tool-input-start":
                  const part = await Session.updatePart({
                    id: toolcalls[value.id]?.id ?? Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "tool",
                    tool: value.toolName,
                    callID: value.id,
                    state: {
                      status: "pending",
                      input: {},
                      raw: "",
                    },
                  })
                  toolcalls[value.id] = part as MessageV2.ToolPart
                  break

                case "tool-input-delta":
                  break

                case "tool-input-end":
                  break

                /** 工具名与参数就绪：更新 part 为 running；若最近 N 次同工具同参数则触发 doom_loop 权限询问 */
                //  {
                //   type: 'tool-call',
                //   toolCallId: 'call_d7acb19ecfb0404889321b',
                //   toolName: 'get_time',
                //   args: {}
                // }
                case "tool-call": {
                  const match = toolcalls[value.toolCallId]
                  if (match) {
                    const part = await Session.updatePart({
                      ...match,
                      tool: value.toolName,
                      state: {
                        status: "running",
                        input: value.input,
                        time: {
                          start: Date.now(),
                        },
                      },
                      metadata: value.providerMetadata,
                    })
                    toolcalls[value.toolCallId] = part as MessageV2.ToolPart

                    const parts = await MessageV2.parts(input.assistantMessage.id)
                    const lastThree = parts.slice(-DOOM_LOOP_THRESHOLD)

                    if (
                      lastThree.length === DOOM_LOOP_THRESHOLD &&
                      lastThree.every(
                        (p) =>
                          p.type === "tool" &&
                          p.tool === value.toolName &&
                          p.state.status !== "pending" &&
                          JSON.stringify(p.state.input) === JSON.stringify(value.input),
                      )
                    ) {
                      const agent = await Agent.get(input.assistantMessage.agent)
                      await PermissionNext.ask({
                        permission: "doom_loop",
                        patterns: [value.toolName],
                        sessionID: input.assistantMessage.sessionID,
                        metadata: {
                          tool: value.toolName,
                          input: value.input,
                        },
                        always: [value.toolName],
                        ruleset: agent.permission,
                      })
                    }
                  }
                  break
                }
                /** 工具执行完成：更新 part 为 completed，写入 output/metadata/title/attachments */
                //  {
                //   type: 'tool-result',
                //   toolCallId: 'call_d7acb19ecfb0404889321b',
                //   toolName: 'get_time',
                //   args: {},
                //   result: { now: '2026-03-16T07:09:49.944Z' }
                // }
                case "tool-result": {
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    await Session.updatePart({
                      ...match,
                      state: {
                        status: "completed",
                        input: value.input ?? match.state.input,
                        output: value.output.output,
                        metadata: value.output.metadata,
                        title: value.output.title,
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                        attachments: value.output.attachments,
                      },
                    })

                    delete toolcalls[value.toolCallId]
                  }
                  break
                }

                /** 工具执行失败：更新 part 为 error；若为权限/Question 拒绝且未开 continue_loop_on_deny 则 blocked=true */
                case "tool-error": {
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    await Session.updatePart({
                      ...match,
                      state: {
                        status: "error",
                        input: value.input ?? match.state.input,
                        error: (value.error as any).toString(),
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                      },
                    })

                    if (
                      value.error instanceof PermissionNext.RejectedError ||
                      value.error instanceof Question.RejectedError
                    ) {
                      blocked = shouldBreak
                    }
                    delete toolcalls[value.toolCallId]
                  }
                  break
                }
                case "error":
                  throw value.error

                /** 本步开始：记录 Snapshot，写 step-start part */

                //  type: 'step-start',
                //   messageId: 'msg-8lZ7F8lm4ph9x89HvdedZ80T',
                //   request: {
                //     body: '{"model":"qwen-plus","temperature":0,"messages":[{"role":"user","content":"用一句话介绍北京。然后调用 get_time 工具一次。"},{"role":"assistant","content":"北京是中国的首都，是一座融合了悠久历史与现代文明的国际化大都市。\\n\\n","tool_calls":[{"id":"call_d7acb19ecfb0404889321b","type":"function","function":{"name":"get_time","arguments":"{}"}}]},{"role":"tool","tool_call_id":"call_d7acb19ecfb0404889321b","content":"{\\"now\\":\\"2026-03-16T07:09:49.944Z\\"}"}],"tools":[{"type":"function","function":{"name":"get_time","description":"返回当前时间","parameters":{"type":"object","properties":{"tz":{"type":"string"}},"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}}}],"tool_choice":"auto","stream":true,"stream_options":{"include_usage":true}}'
                //   },
                //   warnings: []
                // }
                case "start-step":
                  snapshot = await Snapshot.track()
                  await Session.updatePart({
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.sessionID,
                    snapshot,
                    type: "step-start",
                  })
                  break

                /** 本步结束：算 usage/cost、写 step-finish、更新助手消息、若有 snapshot 写 patch、触发 summarize；超限则 needsCompaction */
                case "finish-step":
                  const usage = Session.getUsage({
                    model: input.model,
                    usage: value.usage,
                    metadata: value.providerMetadata,
                  })
                  input.assistantMessage.finish = value.finishReason
                  input.assistantMessage.cost += usage.cost
                  input.assistantMessage.tokens = usage.tokens
                  await Session.updatePart({
                    id: Identifier.ascending("part"),
                    reason: value.finishReason,
                    snapshot: await Snapshot.track(),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "step-finish",
                    tokens: usage.tokens,
                    cost: usage.cost,
                  })
                  await Session.updateMessage(input.assistantMessage)
                  if (snapshot) {
                    const patch = await Snapshot.patch(snapshot)
                    if (patch.files.length) {
                      await Session.updatePart({
                        id: Identifier.ascending("part"),
                        messageID: input.assistantMessage.id,
                        sessionID: input.sessionID,
                        type: "patch",
                        hash: patch.hash,
                        files: patch.files,
                      })
                    }
                    snapshot = undefined
                  }
                  SessionSummary.summarize({
                    sessionID: input.sessionID,
                    messageID: input.assistantMessage.parentID,
                  })
                  if (
                    !input.assistantMessage.summary &&
                    (await SessionCompaction.isOverflow({ tokens: usage.tokens, model: input.model }))
                  ) {
                    needsCompaction = true
                  }
                  break

                /** 文本块开始：创建 text part 并赋给 currentText */
                case "text-start":
                  // 创建空的text-part
                  currentText = {
                    // id用于后续更新
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "text",
                    text: "",
                    time: {
                      start: Date.now(),
                    },
                    metadata: value.providerMetadata,
                  }
                  await Session.updatePart(currentText)
                  break

                /** 文本块增量：追加到 currentText，updatePartDelta */
                case "text-delta":
                  if (currentText) {
                    // 拼接每个数据块的内容
                    currentText.text += value.text
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    // 此处只发布事件，没有更新具体的text
                    await Session.updatePartDelta({
                      sessionID: currentText.sessionID,
                      messageID: currentText.messageID,
                      partID: currentText.id,
                      field: "text",
                      delta: value.text,
                    })
                  }
                  // part =  { type: 'text-delta', textDelta: '北京' }
                  // part =  { type: 'text-delta', textDelta: '是中国' }
                  // part =  { type: 'text-delta', textDelta: '的首都，' }
                  // part =  { type: 'text-delta', textDelta: '是一座' }
                  // part =  { type: 'text-delta', textDelta: '融合了悠久历史与现代' }
                  // part =  { type: 'text-delta', textDelta: '文明的国际化大都市。\n\n' }
                  break

                /** 文本块结束：触发 experimental.text.complete 插件，写 end 时间后清空 currentText */
                case "text-end":
                  if (currentText) {
                    // 对 currentText 做 trim、插件等处理。
                    currentText.text = currentText.text.trimEnd()
                    const textOutput = await Plugin.trigger(
                      "experimental.text.complete",
                      {
                        sessionID: input.sessionID,
                        messageID: input.assistantMessage.id,
                        partID: currentText.id,
                      },
                      { text: currentText.text },
                    )
                    currentText.text = textOutput.text
                    currentText.time = {
                      start: Date.now(),
                      end: Date.now(),
                    }
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    // 再 Session.updatePart(currentText) 写一次 DB，
                    // 此时 currentText.text 已经是完整文本，所以 DB 里这条 part 的 data.text 就是完整内容。
                    await Session.updatePart(currentText)
                  }
                  currentText = undefined
                  break

                case "finish":
                  break

                default:
                  log.info("unhandled", {
                    ...value,
                  })
                  continue
              }
              if (needsCompaction) break
            }

          //    request: {
            //     body: '{
            //     "model":"qwen-plus","temperature":0,
            //     "messages":[{"role":"user","content":"用一句话介绍北京。然后调用 get_time 工具一次。"}],
            //     "tools":[{"type":"function","function":{"name":"get_time","description":"返回当前时间","parameters":{"type":"object","properties":{"tz":{"type":"string"}},"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}}}],"tool_choice":"auto","stream":true,"stream_options":{"include_usage":true}}'
            //   },
            //   warnings: []
            // }

            /*
            value数据块的格式
            文本：
              part =  { type: 'text-delta', textDelta: '北京' }
              part =  { type: 'text-delta', textDelta: '是中国' }
              part =  { type: 'text-delta', textDelta: '的首都，' }
              part =  { type: 'text-delta', textDelta: '是一座' }
              part =  { type: 'text-delta', textDelta: '融合了悠久历史与现代' }
              part =  { type: 'text-delta', textDelta: '文明的国际化大都市。\n\n' }

            工具调用
             part =   {
               type: 'tool-call-streaming-start',
               toolCallId: 'call_9378232919bc4d53885335',
               toolName: 'get_time'
             }
             part =  {
             type: 'tool-call',
             toolCallId: 'call_9378232919bc4d53885335',
             toolName: 'get_time',
             args: {}
             }
             part =  {
             type: 'tool-result',
             toolCallId: 'call_9378232919bc4d53885335',
             toolName: 'get_time',
             args: {},
             result: { now: '2026-03-18T06:26:32.843Z' }
             }
             调用工具后得到结果后，再次请求LLM
             part =  {
              type: 'step-start',
              messageId: 'msg-D1JlezJkCjFPtTutS7mqSyJk',
              request: {
                body: '{"model":"qwen-plus","temperature":0,"messages":[
                {"role":"user","content":"用一句话介绍北京。然后调用 get_time 工具一次。"},
                {"role":"assistant","content":"北京是中国的首都，是一座融合了悠久历史与现代文明的国际化大都市。\\n\\n",
                "tool_calls":[
                    {"id":"call_9378232919bc4d53885335","type":"function","function":{"name":"get_time","arguments":"{}"}}]},
                    {"role":"tool","tool_call_id":"call_9378232919bc4d53885335","content":"{\\"now\\":\\"2026-03-18T06:26:32.843Z\\"}"}],
                    "tools":[{"type":"function","function":{"name":"get_time","description":"返回当前时间","parameters":{"type":"object","properties":{"tz":{"type":"string"}},"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}}}],"tool_choice":"auto","stream":true,"stream_options":{"include_usage":true}}'
              },
              warnings: []
            }



            * */


          } catch (e: any) {
            /** 上下文溢出时设 needsCompaction 并发 Event.Error；可重试则 delay 后 continue，否则写 error 并置 idle */
            log.error("process", {
              error: e,
              stack: JSON.stringify(e.stack),
            })
            const error = MessageV2.fromError(e, { providerID: input.model.providerID })
            if (MessageV2.ContextOverflowError.isInstance(error)) {
              //
              needsCompaction = true
              Bus.publish(Session.Event.Error, {
                sessionID: input.sessionID,
                error,
              })
            } else {
              const retry = SessionRetry.retryable(error)
              if (retry !== undefined) {
                attempt++
                const delay = SessionRetry.delay(attempt, error.name === "APIError" ? error : undefined)
                SessionStatus.set(input.sessionID, {
                  type: "retry",
                  attempt,
                  message: retry,
                  next: Date.now() + delay,
                })
                await SessionRetry.sleep(delay, input.abort).catch(() => {})
                continue
              }
              input.assistantMessage.error = error
              Bus.publish(Session.Event.Error, {
                sessionID: input.assistantMessage.sessionID,
                error: input.assistantMessage.error,
              })
              SessionStatus.set(input.sessionID, { type: "idle" })
            }
          }
          /** 异常或 needsCompaction 跳出流后：补写未完成的 snapshot patch，将未完成的 tool part 标为 aborted，更新助手消息并返回 */
          if (snapshot) {
            const patch = await Snapshot.patch(snapshot)
            if (patch.files.length) {
              await Session.updatePart({
                id: Identifier.ascending("part"),
                messageID: input.assistantMessage.id,
                sessionID: input.sessionID,
                type: "patch",
                hash: patch.hash,
                files: patch.files,
              })
            }
            snapshot = undefined
          }
          const p = await MessageV2.parts(input.assistantMessage.id)
          for (const part of p) {
            if (part.type === "tool" && part.state.status !== "completed" && part.state.status !== "error") {
              await Session.updatePart({
                ...part,
                state: {
                  ...part.state,
                  status: "error",
                  error: "Tool execution aborted",
                  time: {
                    start: Date.now(),
                    end: Date.now(),
                  },
                },
              })
            }
          }
          input.assistantMessage.time.completed = Date.now()
          await Session.updateMessage(input.assistantMessage)
          // 压缩标志
          if (needsCompaction) return "compact"
          // 中断
          if (blocked) return "stop"
          // 异常中断
          if (input.assistantMessage.error) return "stop"
          /** 本轮正常结束且无 tool-calls 时由调用方决定是否继续 loop；有 tool-calls 时 streamInput 已更新，下一轮 while 再调 LLM.stream */
          return "continue"
        }
      },
    }
    return result
  }
}
