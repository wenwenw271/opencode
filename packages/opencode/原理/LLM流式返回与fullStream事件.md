# LLM.stream 返回结构与 fullStream 事件

本文档说明 `LLM.stream(streamInput)` 的返回数据结构、`fullStream` 事件类型，以及不同模型供应商的差异。

---

## 1. 概述

- **入口**：`packages/opencode/src/session/llm.ts` 的 `LLM.stream()`
- **实现**：内部调用 Vercel AI SDK 的 `streamText()`
- **消费方**：`SessionProcessor.process()` 通过 `for await (const value of stream.fullStream)` 消费流

---

## 2. 返回类型

```ts
export type StreamOutput = StreamTextResult<ToolSet, unknown>
```

`LLM.stream` 返回的是 Vercel AI SDK 的 `StreamTextResult`，即 `streamText()` 的返回值。

### 2.1 主要属性

| 属性 | 类型 | 说明 |
|------|------|------|
| **fullStream** | `AsyncIterable & ReadableStream` | 包含所有事件的流（文本、工具调用、推理等），OpenCode 主要消费此流 |
| **textStream** | `AsyncIterableStream` | 仅包含生成文本的流 |
| **text** | `Promise<string>` | 完整生成文本（需消费流后才 resolve） |
| **finishReason** | `Promise<string>` | 结束原因（stop/length/tool-calls 等） |
| **usage** | `Promise<LanguageModelUsage>` | token 使用量 |
| **toolCalls** | `Promise<...>` | 工具调用列表 |
| **toolResults** | `Promise<...>` | 工具执行结果 |
| **stop** | `() => void` | 停止流 |

---

## 3. fullStream 事件类型

`fullStream` 是一个异步可迭代流，每次迭代得到 `value`，`value.type` 决定事件类型。

### 3.1 事件类型总览

| type | 含义 | 主要字段 |
|------|------|----------|
| **start** | 流开始 | - |
| **reasoning-start** | 推理块开始 | `id`, `providerMetadata` |
| **reasoning-delta** | 推理块增量 | `id`, `text`, `providerMetadata` |
| **reasoning-end** | 推理块结束 | `id`, `providerMetadata` |
| **tool-input-start** | 工具调用开始 | `id`, `toolName` |
| **tool-input-delta** | 工具参数流式增量 | - |
| **tool-input-end** | 工具参数流结束 | - |
| **tool-call** | 工具名和参数就绪 | `toolCallId`, `toolName`, `input`, `providerMetadata` |
| **tool-result** | 工具执行完成 | `toolCallId`, `input`, `output` |
| **tool-error** | 工具执行失败 | `toolCallId`, `input`, `error` |
| **start-step** | 本步开始 | - |
| **finish-step** | 本步结束 | `usage`, `finishReason`, `providerMetadata` |
| **text-start** | 文本块开始 | `providerMetadata` |
| **text-delta** | 文本增量 | `text`, `providerMetadata` |
| **text-end** | 文本块结束 | `providerMetadata` |
| **finish** | 流结束 | - |
| **error** | 错误 | `error` |

### 3.2 事件结构示例

```ts
// reasoning-delta
{ type: "reasoning-delta", id: string, text: string, providerMetadata?: object }

// tool-call
{ type: "tool-call", toolCallId: string, toolName: string, input: object, providerMetadata?: object }

// tool-result
{
  type: "tool-result",
  toolCallId: string,
  input: object,
  output: {
    output: unknown,
    metadata?: object,
    title?: string,
    attachments?: unknown[],
  },
}

// finish-step
{
  type: "finish-step",
  usage: { inputTokens?, outputTokens?, totalTokens?, ... },
  finishReason: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other",
  providerMetadata?: object,
}

// text-delta
{ type: "text-delta", text: string, providerMetadata?: object }
```

---

## 4. 不同模型供应商的差异

### 4.1 统一 vs 供应商定义

| 层级 | 定义方 | 说明 |
|------|--------|------|
| **事件类型与结构** | **Vercel AI SDK** | `fullStream` 的 `type`、`text`、`toolCallId`、`input` 等字段由 AI SDK 统一定义。各供应商（OpenAI、Anthropic、Google 等）的原始流格式会被 SDK 内部转换为该统一格式。 |
| **providerMetadata** | **各供应商** | 每个供应商可在此字段放入自定义元数据，如 `openai.logprobs`、`anthropic.xxx` 等。OpenCode 将 `providerMetadata` 透传到 `MessageV2` 的 part 的 `metadata` 字段。 |
| **事件是否出现** | **取决于模型能力** | 并非所有事件都会被所有模型触发。 |

### 4.2 事件出现差异

| 事件类型 | 说明 |
|----------|------|
| **reasoning-*** | 仅支持扩展推理（extended thinking）的模型会发出，如 Claude 3.5、o1、部分 Gemini 等。不支持推理的模型不会产生这些事件。 |
| **工具相关** | 支持 function calling 的模型会发出 `tool-*` 事件。 |
| **text-*** | 所有模型都会产生文本输出，通常会有 `text-start`、`text-delta`、`text-end`。 |
| **start-step / finish-step** | AI SDK 的「步骤」概念，多轮工具调用时每步会发出。 |

### 4.3 数据流示意

```
供应商 API (OpenAI / Anthropic / 等)
     │
     │ 原生流格式（各不相同）
     ▼
Vercel AI SDK streamText()
     │
     │ 内部转换为统一 TextStreamPart 格式
     ▼
fullStream (统一事件类型 + 可选 providerMetadata)
     │
     ▼
SessionProcessor 消费 fullStream
```

### 4.4 小结

- **事件类型与结构**：由 AI SDK 统一，不同供应商返回的 `fullStream` 格式一致。
- **providerMetadata**：供应商可自定义，用于透传供应商特有信息。
- **事件是否出现**：取决于模型能力（推理、工具调用等），不是所有模型都会触发所有事件类型。

---

## 5. 相关代码位置

| 位置 | 说明 |
|------|------|
| `packages/opencode/src/session/llm.ts` | `LLM.stream` 定义，调用 `streamText` |
| `packages/opencode/src/session/processor.ts` | 消费 `fullStream`，按 `value.type` 分支处理 |
| `ai` 包（Vercel AI SDK） | `streamText`、`StreamTextResult`、`fullStream` 事件类型定义 |
