import z from "zod"
import { Tool } from "./tool"
import { Question } from "../question"
import DESCRIPTION from "./question.txt"

// "tool_calls": [
//                     {
//                         "id": "call_81618c85ad8e42bdb750aa08",
//                         "type": "function",
//                         "function": {
//                             "name": "question",
//                             "arguments": "{\"questions\":[{\"question\":\"您希望调查问卷的主题侧重于哪个领域？\",\"header\":\"领域选择\",\"options\":[{\"label\":\"科技\",\"description\":\"如人工智能、区块链、量子计算等\"},{\"label\":\"环境\",\"description\":\"如气候变化、可持续发展、环保政策等\"},{\"label\":\"社会\",\"description\":\"如教育、医疗、职场文化等\"},{\"label\":\"生活\",\"description\":\"如消费习惯、健康生活方式等\"},{\"label\":\"其他\",\"description\":\"请说明：_________\"}],\"multiple\":true}]}"
//                         }
//                     }
//                 ]
export const QuestionTool = Tool.define("question", {
  description: DESCRIPTION,
  parameters: z.object({
    questions: z.array(Question.Info.omit({ custom: true })).describe("Questions to ask"),
  }),
  async execute(params, ctx) {
    // 获取询问用户的结果
    const answers = await Question.ask({
      sessionID: ctx.sessionID,
      questions: params.questions,
      tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
    })

    function format(answer: Question.Answer | undefined) {
      if (!answer?.length) return "Unanswered"
      return answer.join(", ")
    }

    const formatted = params.questions.map((q, i) => `"${q.question}"="${format(answers[i])}"`).join(", ")

    // {
    //   "role": "tool",
    //   "tool_call_id": "call_81618c85ad8e42bdb750aa08",
    //   "content": "User has answered your questions: \"您希望调查问卷的主题侧重于哪个领域？\"=\"科技\". You can now continue with the user's answers in mind."
    // }

    return {
      title: `Asked ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`,
      output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
      metadata: {
        answers,
      },
    }
  },
})
