/**
 * =================================================================================
 * 项目: heck-2api (Cloudflare Worker 单文件版)
 * 版本: 1.0.0 (代号: Ghost Session - 幽灵会话版)
 * 作者: 首席AI执行官 (Principal AI Executive Officer)
 * 协议: 奇美拉协议 · 综合版 (Project Chimera: Synthesis Edition)
 * 日期: 2025-12-01
 * 
 * [核心特性]
 * 1. [自动匿名化] 每次对话自动请求上游创建新会话 (/session/create)，获取 sessionId。
 * 2. [协议转译] 将 Heck.ai 的自定义 SSE 标记 ([REASON_START] 等) 转换为 OpenAI 格式。
 * 3. [深度思考] 支持 DeepSeek R1 等模型的推理过程输出 (reasoning_content)。
 * 4. [全能适配] 完美支持 Cherry Studio, NextChat, LobeChat 及沉浸式翻译。
 * =================================================================================
 */

// --- [第一部分: 核心配置 (Configuration-as-Code)] ---
const CONFIG = {
  // 项目元数据
  PROJECT_NAME: "heck-2api",
  PROJECT_VERSION: "1.0.0",

  // 安全配置 (建议在 Cloudflare 环境变量中设置 API_MASTER_KEY)
  API_MASTER_KEY: "1",

  // 上游服务配置
  UPSTREAM_API_BASE: "https://api.heckai.weight-wave.com/api/ha/v1",
  ORIGIN_URL: "https://heck.ai",
  REFERER_URL: "https://heck.ai/",

  // 伪装头 (模拟 Chrome 142)
  HEADERS: {
    "Host": "api.heckai.weight-wave.com",
    "Origin": "https://heck.ai",
    "Referer": "https://heck.ai/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    "Content-Type": "application/json",
    "Accept": "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "sec-ch-ua": '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "cross-site",
    "priority": "u=1, i"
  },

  // 模型映射 (OpenAI 模型名 -> Heck 模型名)
  // 如果用户请求的 key 不在其中，默认使用 value
  MODEL_MAP: {
    "gpt-4o-mini": "openai/gpt-4o-mini",
    "gpt-4o": "openai/chatgpt-4o-latest",
    "gpt-5-mini": "openai/gpt-5-mini",
    "gpt-5-nano": "openai/gpt-5-nano",
    "deepseek-r1": "deepseek/deepseek-r1",
    "deepseek-v3": "deepseek/deepseek-chat",
    "gemini-2.5-flash": "google/gemini-2.5-flash-preview",
    "claude-3.7-sonnet": "anthropic/claude-3.7-sonnet",
    "grok-3-mini": "x-ai/grok-3-mini-beta",
    "llama-4-scout": "meta-llama/llama-4-scout"
  },
  
  // 默认回退模型
  DEFAULT_MODEL: "openai/gpt-4o-mini"
};

// --- [第二部分: Worker 入口与路由] ---
export default {
  async fetch(request, env, ctx) {
    // 环境变量覆盖
    const apiKey = env.API_MASTER_KEY || CONFIG.API_MASTER_KEY;
    
    request.ctx = { apiKey }; // 注入上下文

    const url = new URL(request.url);

    // 1. CORS 预检
    if (request.method === 'OPTIONS') return handleCorsPreflight();
    
    // 2. 开发者驾驶舱 (Web UI)
    if (url.pathname === '/') return handleUI(request);
    
    // 3. API 路由
    if (url.pathname.startsWith('/v1/')) return handleApi(request);
    
    return createErrorResponse(`路径未找到: ${url.pathname}`, 404, 'not_found');
  }
};

// --- [第三部分: API 代理逻辑] ---

async function handleApi(request) {
  if (!verifyAuth(request)) {
    return createErrorResponse('需要 Bearer Token 认证。', 401, 'unauthorized');
  }

  const url = new URL(request.url);
  const requestId = `req-${crypto.randomUUID()}`;

  if (url.pathname === '/v1/models') {
    return handleModelsRequest();
  } else if (url.pathname === '/v1/chat/completions') {
    return handleChatCompletions(request, requestId);
  } else {
    return createErrorResponse(`不支持的 API 路径: ${url.pathname}`, 404, 'not_found');
  }
}

function verifyAuth(request) {
  const authHeader = request.headers.get('Authorization');
  const validKey = request.ctx.apiKey;
  if (validKey === "1") return true; 
  return authHeader && authHeader === `Bearer ${validKey}`;
}

function handleModelsRequest() {
  const modelsData = {
    object: 'list',
    data: Object.keys(CONFIG.MODEL_MAP).map(modelId => ({
      id: modelId,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'heck-2api',
    })),
  };
  return new Response(JSON.stringify(modelsData), {
    headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}

// --- 核心业务逻辑 ---

/**
 * 步骤 1: 创建匿名会话
 * 每次对话前调用，获取 sessionId
 */
async function createSession(title = "New Chat") {
  try {
    const response = await fetch(`${CONFIG.UPSTREAM_API_BASE}/session/create`, {
      method: "POST",
      headers: CONFIG.HEADERS,
      body: JSON.stringify({ title: title })
    });

    if (!response.ok) {
      throw new Error(`Session creation failed: ${response.status}`);
    }

    const data = await response.json();
    return data.id; // 返回 sessionId
  } catch (e) {
    console.error("Create Session Error:", e);
    throw e;
  }
}

/**
 * 步骤 2: 处理聊天请求
 */
async function handleChatCompletions(request, requestId) {
  try {
    const body = await request.json();
    
    // 1. 模型映射
    let requestModel = body.model || "gpt-4o-mini";
    let upstreamModel = CONFIG.MODEL_MAP[requestModel] || requestModel;
    // 如果用户传的是上游原始ID，直接使用
    if (!Object.values(CONFIG.MODEL_MAP).includes(upstreamModel) && !CONFIG.MODEL_MAP[requestModel]) {
        upstreamModel = CONFIG.DEFAULT_MODEL;
    }

    // 2. 提取最后一条用户消息作为 prompt (Heck 是单轮问答模式或基于 session 的多轮)
    // 由于我们每次都新建 session，我们需要把历史记录拼接一下，或者只发最后一条
    // 为了最佳体验，我们将历史记录拼接为 prompt，或者依赖 session (如果复用 session)
    // 但为了"匿名伪造"，我们每次新建 session。
    // 策略：将 messages 拼接为纯文本 prompt，让模型理解上下文。
    let fullPrompt = "";
    let lastUserMsg = "";
    
    for (const msg of body.messages) {
        if (msg.role === 'system') fullPrompt += `[System]: ${msg.content}\n`;
        else if (msg.role === 'user') {
            fullPrompt += `[User]: ${msg.content}\n`;
            lastUserMsg = msg.content;
        }
        else if (msg.role === 'assistant') fullPrompt += `[Assistant]: ${msg.content}\n`;
    }
    // Heck 的 API 只需要 question 字段。为了上下文，我们发送拼接后的 prompt。
    // 如果 prompt 太长，可能需要截断。这里直接发送。
    const question = fullPrompt.trim();

    // 3. 获取新的 Session ID (幽灵模式)
    // 使用最后一条消息的前10个字作为标题
    const sessionTitle = lastUserMsg.substring(0, 10) || "Chat";
    const sessionId = await createSession(sessionTitle);

    // 4. 构造上游 Payload
    const upstreamPayload = {
      model: upstreamModel,
      question: question,
      language: "Chinese", // 默认中文，可根据 Accept-Language 优化
      sessionId: sessionId,
      previousQuestion: null,
      previousAnswer: null,
      imgUrls: [],
      superSmartMode: false // 深度思考模式开关，可视情况开启
    };

    // 5. 发送请求到 Heck
    // 注意：Heck 有 /chat 和 /search 两个端点。
    // 简单起见，默认用 /chat。如果模型名包含 'search' 或用户意图是搜索，可用 /search
    const endpoint = `${CONFIG.UPSTREAM_API_BASE}/chat`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: CONFIG.HEADERS,
      body: JSON.stringify(upstreamPayload)
    });

    if (!response.ok) {
      return createErrorResponse(`上游服务错误: ${response.status}`, response.status, 'upstream_error');
    }

    // 6. 流式转换 (Transform Stream)
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    // 记录调试信息 (仅 WebUI 可见)
    const debugInfo = {
        sessionId: sessionId,
        upstreamModel: upstreamModel,
        endpoint: endpoint
    };
    
    // 如果是 WebUI 请求 (通过 header 或 body 判断，这里简化为总是发送 debug event，标准客户端会忽略)
    // 为了兼容性，我们只在流的开始发送一个注释或特定的 event
    
    (async () => {
      try {
        const reader = response.body.getReader();
        let buffer = "";
        let isReasoning = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const dataStr = line.slice(6).trim();
              
              // --- Heck 协议解析 ---
              
              // 1. 忽略标记
              if (['[ANSWER_DONE]', '[RELATE_Q_START]', '[RELATE_Q_DONE]'].includes(dataStr)) continue;
              
              // 2. 思考开始
              if (dataStr === '[REASON_START]') {
                  isReasoning = true;
                  continue;
              }
              // 3. 思考结束
              if (dataStr === '[REASON_DONE]') {
                  isReasoning = false;
                  continue;
              }
              // 4. 回答开始
              if (dataStr === '[ANSWER_START]') {
                  continue;
              }
              // 5. 错误处理
              if (dataStr === '[ERROR]') {
                  // 下一行通常是错误 JSON，这里简单处理
                  continue;
              }
              if (dataStr.startsWith('{"error":')) {
                  const errChunk = createChatCompletionChunk(requestId, requestModel, `\n[Error: ${dataStr}]`, "stop");
                  await writer.write(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
                  continue;
              }

              // 6. 内容处理
              // Heck 直接发送文本，不是 JSON
              // 如果是思考阶段，放入 reasoning_content (OpenAI 新标准) 或 content (兼容旧版)
              // 这里我们为了最大兼容性，将思考过程放入 content，但加上标记，或者使用 reasoning_content
              
              let chunk = null;
              if (isReasoning) {
                  // 适配支持 reasoning_content 的客户端 (如 Cherry Studio 新版)
                  chunk = {
                      id: requestId,
                      object: "chat.completion.chunk",
                      created: Math.floor(Date.now() / 1000),
                      model: requestModel,
                      choices: [{ 
                          index: 0, 
                          delta: { reasoning_content: dataStr }, // 深度思考内容
                          finish_reason: null 
                      }]
                  };
              } else {
                  // 普通回答
                  chunk = createChatCompletionChunk(requestId, requestModel, dataStr);
              }

              await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            }
          }
        }
        
        // 发送结束
        await writer.write(encoder.encode('data: [DONE]\n\n'));
      } catch (e) {
        const errChunk = createChatCompletionChunk(requestId, requestModel, `\n[Stream Error: ${e.message}]`, "stop");
        await writer.write(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
      } finally {
        await writer.close();
      }
    })();

    return new Response(readable, {
      headers: corsHeaders({ 
        'Content-Type': 'text/event-stream',
        'X-Heck-Session-Id': sessionId // 在响应头中返回 SessionID 供调试
      })
    });

  } catch (e) {
    return createErrorResponse(e.message, 500, 'internal_error');
  }
}

// --- 辅助函数 ---

function createChatCompletionChunk(id, model, content, finishReason = null) {
  return {
    id: id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{ index: 0, delta: content ? { content: content } : {}, finish_reason: finishReason }]
  };
}

function createErrorResponse(message, status, code) {
  return new Response(JSON.stringify({
    error: { message, type: 'api_error', code }
  }), {
    status,
    headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' })
  });
}

function handleCorsPreflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function corsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// --- [第四部分: 开发者驾驶舱 UI (WebUI)] ---
function handleUI(request) {
  const origin = new URL(request.url).origin;
  const apiKey = request.ctx.apiKey;
  
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${CONFIG.PROJECT_NAME} - 开发者驾驶舱</title>
    <style>
      :root { --bg: #0f172a; --panel: #1e293b; --border: #334155; --text: #e2e8f0; --primary: #3b82f6; --success: #10b981; --error: #ef4444; }
      body { font-family: 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); margin: 0; height: 100vh; display: flex; overflow: hidden; }
      .sidebar { width: 320px; background: var(--panel); border-right: 1px solid var(--border); padding: 20px; display: flex; flex-direction: column; }
      .main { flex: 1; display: flex; flex-direction: column; padding: 20px; position: relative; }
      .box { background: #0f172a; padding: 15px; border-radius: 8px; border: 1px solid var(--border); margin-bottom: 15px; }
      .label { font-size: 12px; color: #94a3b8; margin-bottom: 5px; display: block; font-weight: 600; }
      .code { font-family: monospace; font-size: 12px; color: var(--primary); background: #1e293b; padding: 8px; border-radius: 4px; cursor: pointer; word-break: break-all; }
      input, select, textarea { width: 100%; background: #1e293b; border: 1px solid var(--border); color: #fff; padding: 8px; border-radius: 4px; margin-bottom: 10px; box-sizing: border-box; }
      button { width: 100%; padding: 10px; background: var(--primary); border: none; border-radius: 4px; color: white; font-weight: bold; cursor: pointer; }
      button:disabled { background: #475569; cursor: not-allowed; }
      .chat-box { flex: 1; background: #020617; border: 1px solid var(--border); border-radius: 8px; padding: 20px; overflow-y: auto; margin-bottom: 20px; font-family: 'Segoe UI', sans-serif; }
      .msg { margin-bottom: 15px; line-height: 1.6; }
      .msg.user { color: var(--primary); font-weight: bold; }
      .msg.ai { color: var(--text); }
      .msg.sys { color: #64748b; font-size: 12px; font-style: italic; }
      .log-panel { height: 150px; background: #000; border: 1px solid var(--border); border-radius: 8px; padding: 10px; overflow-y: auto; font-family: monospace; font-size: 11px; color: #22c55e; }
    </style>
</head>
<body>
    <div class="sidebar">
        <h2 style="margin-top:0">👻 ${CONFIG.PROJECT_NAME} <span style="font-size:12px;color:#64748b">v${CONFIG.PROJECT_VERSION}</span></h2>
        
        <div class="box">
            <span class="label">API Endpoint</span>
            <div class="code" onclick="copy('${origin}/v1/chat/completions')">${origin}/v1/chat/completions</div>
        </div>
        
        <div class="box">
            <span class="label">API Key</span>
            <div class="code" onclick="copy('${apiKey}')">${apiKey}</div>
        </div>

        <div class="box">
            <span class="label">模型选择</span>
            <select id="model">
                ${Object.keys(CONFIG.MODEL_MAP).map(m => `<option value="${m}">${m}</option>`).join('')}
            </select>
            <span class="label">提示词</span>
            <textarea id="prompt" rows="4">你好，请介绍一下你自己。</textarea>
            <button id="btn" onclick="send()">🚀 发送请求</button>
        </div>
        
        <div style="font-size:12px; color:#64748b;">
            * 每次请求都会自动创建新的 Session ID 以伪造身份。
        </div>
    </div>

    <div class="main">
        <div class="chat-box" id="chat">
            <div style="text-align:center; color:#64748b; margin-top:50px;">
                <h3>Heck.ai 代理服务就绪</h3>
                <p>支持流式响应、深度思考模型 (R1) 及自动会话管理。</p>
            </div>
        </div>
        <div class="log-panel" id="logs">
            <div>[System] 等待请求...</div>
        </div>
    </div>

    <script>
        const API_KEY = "${apiKey}";
        const URL = "${origin}/v1/chat/completions";

        function copy(text) { navigator.clipboard.writeText(text); alert('已复制'); }
        function log(msg) { 
            const el = document.getElementById('logs');
            el.innerHTML += \`<div>[\${new Date().toLocaleTimeString()}] \${msg}</div>\`;
            el.scrollTop = el.scrollHeight;
        }
        function append(role, text) {
            const el = document.getElementById('chat');
            const div = document.createElement('div');
            div.className = 'msg ' + role;
            div.innerText = text;
            el.appendChild(div);
            el.scrollTop = el.scrollHeight;
            return div;
        }

        async function send() {
            const prompt = document.getElementById('prompt').value;
            const model = document.getElementById('model').value;
            if(!prompt) return;

            const btn = document.getElementById('btn');
            btn.disabled = true;
            btn.innerText = "请求中...";

            if(document.querySelector('.chat-box h3')) document.getElementById('chat').innerHTML = '';
            
            append('user', 'User: ' + prompt);
            const aiMsg = append('ai', 'AI: ');
            
            log(\`发起请求: \${model}\`);

            try {
                const res = await fetch(URL, {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer '+API_KEY, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: model,
                        messages: [{role: 'user', content: prompt}],
                        stream: true
                    })
                });

                // 获取 Session ID 用于调试
                const sessionId = res.headers.get('X-Heck-Session-Id');
                if(sessionId) log(\`Session Created: \${sessionId}\`);

                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let fullText = "";
                let reasoningText = "";

                while(true) {
                    const { done, value } = await reader.read();
                    if(done) break;
                    
                    const chunk = decoder.decode(value);
                    const lines = chunk.split('\\n');
                    
                    for(const line of lines) {
                        if(line.startsWith('data: ')) {
                            const dataStr = line.slice(6);
                            if(dataStr === '[DONE]') break;
                            try {
                                const json = JSON.parse(dataStr);
                                // 处理深度思考内容
                                if(json.choices[0].delta.reasoning_content) {
                                    reasoningText += json.choices[0].delta.reasoning_content;
                                    // 简单展示思考过程
                                    if(!aiMsg.innerText.startsWith('Thinking')) aiMsg.innerText = 'Thinking...\\n';
                                }
                                // 处理普通内容
                                if(json.choices[0].delta.content) {
                                    if(reasoningText && !fullText) {
                                        // 思考结束，展示思考块 (可选)
                                        // fullText += \`> Thinking: \${reasoningText}\\n\\n\`;
                                    }
                                    fullText += json.choices[0].delta.content;
                                    aiMsg.innerText = fullText; // 实时更新
                                }
                            } catch(e) {}
                        }
                    }
                }
                log('响应完成');
            } catch(e) {
                log('Error: ' + e.message);
                append('sys', 'Error: ' + e.message);
            } finally {
                btn.disabled = false;
                btn.innerText = "🚀 发送请求";
            }
        }
    </script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}
