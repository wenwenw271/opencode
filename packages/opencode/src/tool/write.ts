/**
 * Write 工具：将一段内容整文件写入指定路径。
 * 文件已存在则覆盖，不存在则新建。写入前做路径校验与 edit 权限询问（带 diff），
 * 写入后发事件、更新 FileTime，并收集 LSP 诊断写入 output 供 agent 修复。
 */
import z from "zod"
import * as path from "path"
import { Tool } from "./tool"
import { LSP } from "../lsp"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./write.txt"
import { Bus } from "../bus"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { FileTime } from "../file/time"
import { Filesystem } from "../util/filesystem"
import { Instance } from "../project/instance"
import { trimDiff } from "./edit"
import { assertExternalDirectory } from "./external-directory"

/** 单个文件最多在 output 中展示的 LSP 错误条数 */
const MAX_DIAGNOSTICS_PER_FILE = 20
/** 除本文件外最多再展示多少个其它文件的 LSP 错误 */
const MAX_PROJECT_DIAGNOSTICS_FILES = 5

/** Write 工具定义：description 来自 write.txt，参数为 content（完整内容）与 filePath（建议绝对路径）。 */
export const WriteTool = Tool.define("write", {
  description: DESCRIPTION,
  parameters: z.object({
    content: z.string().describe("The content to write to the file"),
    filePath: z.string().describe("The absolute path to the file to write (must be absolute, not relative)"),
  }),
  async execute(params, ctx) {
    // 相对路径则基于 Instance.directory 拼成绝对路径；校验是否在允许的目录范围内
    const filepath = path.isAbsolute(params.filePath) ? params.filePath : path.join(Instance.directory, params.filePath)
    await assertExternalDirectory(ctx, filepath)

    // 若文件已存在则读旧内容，并做 FileTime 断言（避免覆盖会话外的新修改）
    const exists = await Filesystem.exists(filepath)
    const contentOld = exists ? await Filesystem.readText(filepath) : ""
    if (exists) await FileTime.assert(ctx.sessionID, filepath)

    // 生成旧内容→新内容的 diff，用 edit 权限询问用户；拒绝则不会执行下方写盘
    const diff = trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, params.content))
    await ctx.ask({
      permission: "edit",
      patterns: [path.relative(Instance.worktree, filepath)],
      always: ["*"],
      metadata: {
        filepath,
        diff,
      },
    })

    // 写盘、发编辑/监视器事件、记录本会话对该文件的读写时间
    await Filesystem.write(filepath, params.content)
    await Bus.publish(File.Event.Edited, {
      file: filepath,
    })
    await Bus.publish(FileWatcher.Event.Updated, {
      file: filepath,
      event: exists ? "change" : "add",
    })
    FileTime.read(ctx.sessionID, filepath)

    // 通知 LSP 文件已更新并拉取诊断；仅取 severity===1（Error），本文件全量提示，其它文件最多 MAX_PROJECT_DIAGNOSTICS_FILES 个
    let output = "Wrote file successfully."
    await LSP.touchFile(filepath, true)
    const diagnostics = await LSP.diagnostics()
    const normalizedFilepath = Filesystem.normalizePath(filepath)
    let projectDiagnosticsCount = 0
    for (const [file, issues] of Object.entries(diagnostics)) {
      const errors = issues.filter((item) => item.severity === 1)
      if (errors.length === 0) continue
      const limited = errors.slice(0, MAX_DIAGNOSTICS_PER_FILE)
      const suffix =
        errors.length > MAX_DIAGNOSTICS_PER_FILE ? `\n... and ${errors.length - MAX_DIAGNOSTICS_PER_FILE} more` : ""
      if (file === normalizedFilepath) {
        // 当前写入的文件：在 output 中追加「本文件 LSP 错误」，便于 agent 后续修复
        output += `\n\nLSP errors detected in this file, please fix:\n<diagnostics file="${filepath}">\n${limited.map(LSP.Diagnostic.pretty).join("\n")}${suffix}\n</diagnostics>`
        continue
      }
      if (projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
      projectDiagnosticsCount++
      // 其它文件：最多再报 MAX_PROJECT_DIAGNOSTICS_FILES 个，避免 output 过长
      output += `\n\nLSP errors detected in other files:\n<diagnostics file="${file}">\n${limited.map(LSP.Diagnostic.pretty).join("\n")}${suffix}\n</diagnostics>`
    }

    // 返回相对 worktree 的 path 作 title，metadata 含原始 diagnostics/filepath/exists，output 供 LLM 阅读
    return {
      title: path.relative(Instance.worktree, filepath),
      metadata: {
        diagnostics,
        filepath,
        exists: exists,
      },
      output,
    }
  },
})
