# 安装Bun
```bash
# 安装Bun（macOS/Linux）
curl -fsSL https://bun.sh/install | bash

# 验证安装
bun --version  # 应显示 1.3.10 或更高版本
```
# 拉取代码
```bash
# 从GitHub克隆
git clone https://github.com/anomalyco/opencode.git

# 或使用Gitee镜像（国内加速）
git clone https://gitee.com/hitweston/opencode.git

# 进入项目目录
cd opencode
```

# 安装依赖
```bash
# 使用Bun安装所有依赖（Bun workspaces会自动处理）
bun install
```

# 启动项目
```bash
#控制台启动
bun run dev

#web端启动
bun run dev -- web --log-level INFO

```

# 查看日志文件
%USERPROFILE%\.local\share\opencode\log

# 切换成本地模型
全局配置（所有项目生效）：~/.config/opencode/opencode.json
项目配置（仅当前项目）：项目根目录下的 opencode.json


```json

{
  "$schema": "https://opencode.ai/config.json",
  "model": "local/qwen3-8b",
  "provider": {
    "local": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Qwen3-8B",
      "options": {
        "baseURL": "http://192.168.1.194:8082/v1",
        "apiKey": "sk-placeholder"
      },
      "models": {
        "Qwen3-8B": {
          "name": "Qwen3-8B",
          "limit": {
            "context": 32768,
            "output": 8192
          }
        }
      }
    }
  }
}

```
