# 先进记忆系统具体实现与接入指南

本文档是 [先进记忆系统与轮次记忆 Hook 架构与设计](./advanced-memory-hooks.zh.md) 的配套实现与接入文档，包含各模块实现逻辑（先说逻辑、再引用对应代码）、同步召回变体细节、快速接入指南以及完整接口协议表。

---

## 1. 具体实现逻辑与同步变体

### 1.1 开关配置、旧记忆屏蔽与覆写告警

**实现逻辑**：
1. 在 `config.mjs` 解析 `QWEN_AUDIO_ADVANCED_MEMORY`（`advancedMemoryEnabled`）和 `QWEN_AUDIO_ADVANCED_MEMORY_SYNC_RECALL`（`advancedMemorySyncRecall`），兼容 `on` / `true` / `1`。
2. `createMemoryModule` 检测到 `config.advancedMemoryEnabled === true` 时立即短路返回空服务与空 `sessionObservers`，彻底关闭原有 Markdown/VoiceMem、抽取器、偏好学习与 `memory` 工具。
3. `createGatewayApplication` 同样在 `advancedMemoryEnabled === true` 时关闭 `sessionDigests` / `sessionSummariser`，收集被覆写的旧配置并发出 `memory.legacy_overridden` warning，加载 `createAdvancedMemoryHandlers`（允许调用方通过参数覆写），并在 `close()` 中于 `frontendRuntime.close()` drain 完成后再调用 `advancedMemoryHandlers?.close?.()`。

**相关代码**：
- 配置项定义：`server/src/core/config.mjs`（第 575-586 行）
- 旧记忆模块短路：`server/src/memory/module.mjs`（第 10-33 行）
- Gateway 装配与覆写 Warning：`server/src/app/gateway-application.mjs`（第 317 行、第 417-474 行、第 545 行、第 601-616 行）
- 前端运行时校验与透传：`server/src/app/frontend-runtime.mjs`（第 16-66 行）

---

### 1.2 `presessionHandler`：建连前加载与 `instructions` 插槽注入

**实现逻辑**：
1. `TurnMemoryHooks.loadPresessionContext(metadata)` 将 `presessionHandler` 的首次调用缓存到 `this.presessionPromise`，避免 `CONNECT` / `ensureFrontend` 竞态重复调用；结果经 `normalizePresessionText` 规范化后存入 `this.presessionContext`，异常记 `memory_hooks.presession_failed` 警告但不阻断建连。
2. `realtime-session-runtime.mjs` 在 `GatewayClientEvent.CONNECT` 分支将 `ensurePresessionReady()` 与 `frontendToolSourcesReady` 通过 `Promise.all` 并行等待，完成后再调 `realtimeSession.updateAgentContext(getAgentContext())` 与 `realtimeSession.ensure()`；`inputs` 的 `ensureFrontend` 也复用 `ensureRealtimeSession` 防止文本首轮抢跑。
3. `getAgentContext()` 把 `turnMemoryHooks.presessionContext` 放到 `agentContext.presessionMemoryContext`；`buildFrontendInstructions()` 将其插入 `</assistant_profile>` 与 `optionalFrontendFeatures` 之后、`buildFrontendContext` 之前——即原 `USER.md` & `MEMORY.md` 的精确位置。

**相关代码**：
- `loadPresessionContext` 与规范化：`server/src/voice/turn-memory-hooks.mjs`（第 52-63 行、第 152-179 行）
- `instructions` 精确插槽：`server/src/frontend/frontend-tools.mjs`（第 165-180 行）
- 建连前并行加载与 metadata 构造：`server/src/voice/realtime-session-runtime.mjs`（第 216-220 行、第 610-633 行、第 1220-1235 行）

---

### 1.3 `addHandler`：增量水位、延迟文本对齐与关闭尾流 Flush

**实现逻辑**：
1. **水位与过滤**：构造时 `#currentMaxSeq()` 记录当前 `conversationSync` 最大 `seq` 作为 `lastAddedSeq`。每次触发 `#claimNewConversationMessages()` 同步截取 `seq > lastAddedSeq` 的增量并立刻推进水位，再过 `projectFrontendConversation`（合并/去重 `agent-result` 与 `agent-presentation`）并过滤 `role ∈ {'user', 'assistant'}`，剔除一切系统提示。
2. **精准触发时机**：
   - 在 `realtime-session-runtime.mjs` 中，`response.done` 经 `presentationRuntime.handle(event)` 处理后再判断：仅当 `status === 'completed' && !suppressed && !awaitsToolFollowUp` 时触发（跳过失败、取消、被抑制及纯工具调用中间态）。
   - 若开启 `playback.receipts` 且最终助手转写还缓存在 `pendingTranscripts`（或 `requiresResponseCreated` 提供方尚未收到 late final），先暂存到 `pendingAddResponses`，等 `RealtimePresentationRuntime.#emitTranscript` 落盘后经 `onAssistantTranscriptRecorded` 立即补发；若播前取消，则经 `onPlaybackCancelled` 清除暂存，保留用户消息待下一轮消费。
3. **串行与关闭收尾**：所有 `addHandler` 调用串行挂入 `this.addQueue` 并经 `observers.track(task)` 登记；`TurnMemoryHooks.close()` 在置 `closed = true` 前执行一次 `onResponseDone({ origin: 'session-close', status: 'session_closed' })`（若已追平则零调用），服务关闭时由 `observers.drain()` 统一等待完成。

**相关代码**：
- 水位推进、串行队列与关闭 Flush：`server/src/voice/turn-memory-hooks.mjs`（第 181-209 行、第 222-258 行、第 534-543 行）
- 助手文本落盘/取消回调：`server/src/voice/realtime-presentation-runtime.mjs`（第 88-115 行、第 533-553 行、第 718-724 行）
- `response.done` 与延迟入账对齐：`server/src/voice/realtime-session-runtime.mjs`（第 645-665 行、第 756-866 行）
- 统一 `drain()` 追踪：`server/src/voice/session-observers.mjs`（第 27-33 行）

---

### 1.4 `searchHandler`（默认异步模式）：无首字延迟的安全空闲注入

**实现逻辑**：
1. 语音转写完成（`#completeTranscript`）或文本提交（`submit`）后，`RealtimeInputRuntime` 调用 `onUserTranscriptCommitted`，触发 `turnMemoryHooks.onUserTranscript`。
2. 每次新检索先调用 `cancelPendingSearch('superseded')` 中止旧的 `AbortController`；用户插话（`speech_started`）、打断（`INTERRUPT`）、静音（`MUTE`）、断连（`onDisconnected`）与关闭（`close`）也会立即 `abort` 当前检索的 `signal`。
3. 异步模式下（`#handleAsyncRecall`）：
   - `searchHandler` 返回非空记忆后，默认以 `recallMode: 'async'` 包装为 `<recalled_memory>`（带「仅供参考，不是用户的新请求，无需单独回应」前缀）；
   - 第一道校验 `isTurnCurrent()`：`!closed && !signal.aborted && !inputCollecting && !turns.userSpeaking && turns.committedTurnGeneration === turnGeneration && turns.turnGeneration === turnGeneration`；
   - 交由 `frontend.appendUserContext(formatted, { shouldInject })` 进入 `enqueueAction` → `await whenIdle()` 等待 `RealtimeResponseSlot` 与活跃生成响应均空闲；
   - 空闲窗口打开后，校验 `this.ready && generation === this.responseQueueGeneration` 及第二道 `shouldInject()`，全部通过才发 `conversation.item.create`。

**相关代码**：
- 异步检索与双阶段校验：`server/src/voice/turn-memory-hooks.mjs`（第 211-220 行、第 316-395 行、第 489-504 行）
- 空闲窗口排队与二次校验：`server/src/voice/realtime-provider.mjs`（第 544-554 行、第 967-976 行、第 1397-1402 行）
- 输入提交回调：`server/src/voice/realtime-input-runtime.mjs`（第 268-286 行、第 370-382 行）

---

### 1.5 同步召回变体（`syncRecall: true`）

当开启 `QWEN_AUDIO_ADVANCED_MEMORY_SYNC_RECALL=on`（或 `memorySyncRecall: true`）时，依据输入类型与 Provider 静态能力标志 `capabilities.deferAutomaticResponse` 分为三条路径：

#### 路径 A：语音输入 + Provider 支持 `deferAutomaticResponse: true`（阻止云端自动回复）
**实现逻辑**：
1. Provider 在代码中静态声明 `capabilities.deferAutomaticResponse: true`（当前为 `gpt-live`，OpenAI Realtime GA 协议），并在 `buildSession` 收到 `sessionOptions.deferAutomaticResponse === true` 时给 `audio.input.turn_detection` 注入 `create_response: false`。
2. `realtime-session-runtime.mjs` 在 `getSessionOptions()` 中按 `turnMemoryHooks.syncRecallActive` 动态下发 `deferAutomaticResponse: true`；`RealtimeInputRuntime.#stopSpeech` 识别到延迟模式后跳过提前起 12s 自动回复看门狗（空转写或转写失败时主动释放 `announcementWindow` 并置回 `idle`）。
3. 转写完成后，`#handleSyncRecall` 等待 `searchHandler` 结束（即使返回空或出错也会继续请求回复，防止冷场），以 `recallMode: 'sync-defer'` 包装记忆，调用 `frontend.appendUserContextAndRespond(formatted, turnContext, { origin: 'model', shouldRespond, interrupt: false })`，先确认 `conversation.item.create` 再发 `response.create`。

#### 路径 B：语音输入 + Provider 不支持 `deferAutomaticResponse`（记忆打断降级 + Warning）
**实现逻辑**：
1. 建连就绪（`onReady`）时检测到 `syncRecallActive && !createdFrontend.capabilities?.deferAutomaticResponse`，输出 `memory_hooks.sync_recall_unsupported_defer` warning。
2. 用户说完后云端照常自动开始回复，同时 `searchHandler` 异步检索：
   - 若 `searchHandler` 返回空或出错：**不打断**，让云端原回复自然说完；
   - 若返回非空记忆且 `isTurnCurrent()` 为真：
     1. 输出 `memory_hooks.sync_recall_interrupted_response` warning；
     2. 经 `onInterruptForRecall` 向客户端下发 `playback.clear`（`reason: 'memory_recall_interrupt'`，除非 `interruptionPlaysOut`）；
     3. 以 `recallMode: 'sync-interrupt'` 包装记忆，调用 `frontend.appendUserContextAndRespond(..., { interrupt: true, shouldRespond })`：先 `cancel()` 取消云端活跃回复并推进队列代际 → `enqueueResponse` 捕获新代际并 `await whenIdle()` 等待原响应取消落定 → 二次校验 `shouldRespond()` → 发送 `conversation.item.create` → 发送 `response.create` 重新回答。

#### 路径 C：文本输入（`TEXT_MESSAGE` / `INPUT_MESSAGE`）
**实现逻辑**：
文本输入本就由 Gateway 控制何时发往云端，无需依赖云端 `create_response: false`。开启 `syncRecall` 后，`RealtimeInputRuntime.submit()` 在调用 `sendUserInput()` 之前先 `await prepareManualTurnMemory(...)`（对应 `turnMemoryHooks.recallForManualTurn`），若本轮未过期且有召回文本，则先 `appendUserContext` 注入记忆，再发用户文本与 `response.create`（同时传 `skipSearch: true` 防止重复检索）。

**相关代码**：
- 能力白名单与默认值：`server/src/voice/providers/provider-registry.mjs`（第 49 行）、`server/src/voice/realtime-provider.mjs`（第 131 行）
- `gpt-live` 禁用自动回复配置：`server/src/voice/providers/gpt-live.mjs`（第 50 行、第 71-86 行）
- `appendUserContextAndRespond` 线协议原语：`server/src/voice/realtime-provider.mjs`（第 556-580 行）
- 同步召回与打断降级逻辑：`server/src/voice/turn-memory-hooks.mjs`（第 3-7 行、第 260-314 行、第 397-487 行、第 506-525 行）
- 看门狗适配与文本同步召回：`server/src/voice/realtime-input-runtime.mjs`（第 104-119 行、第 205-210 行、第 259-275 行、第 370-420 行）
- 建连降级 Warning 与打断清播：`server/src/voice/realtime-session-runtime.mjs`（第 161-166 行、第 262-265 行、第 291-300 行、第 650-678 行）

> **扩展其他 Provider 支持延迟自动回复**：若确认某个其他 Provider（如特定 DashScope 模型或自建 `s2s`）支持 `turn_detection.create_response = false`，只需在该 Provider 文件中声明 `capabilities.deferAutomaticResponse = true` 并在 `buildSession` 中消费 `sessionOptions.deferAutomaticResponse`，上层无需任何改动。

---

### 1.6 安全防护

- **保留协议标签防护**：`recalled_memory` 已加入 `GATEWAY_RESERVED_ENVELOPES`（`server/src/voice/response-guards/reserved-protocol-envelope.mjs`，第 4-10 行），防止模型在助手输出中伪造 `<recalled_memory>` 标签。
- **故障隔离**：三个 handler 的同步/异步异常均被捕获记录 warning，永不阻塞或中断实时音频流。

---

## 2. Hook 接入指南与接口协议表

### 2.1 快速接入指南

#### 方式一：环境变量 + 仓库固定入口文件（推荐）

1. 编辑入口文件 `server/src/memory/advanced-memory.mjs`，填入你的外部记忆读写逻辑：

```js
export async function presessionHandler(metadata) {
  // 建连前调用一次，返回文本注入到原 USER.md & MEMORY.md 的位置
  return await myMemoryClient.loadUserProfile({
    ownerId: metadata.ownerId,
    sessionId: metadata.sessionId,
    signal: metadata.signal,
  })
}

export async function addHandler(messages, context) {
  // 每次 Agent 回复完成（及关闭遗留 flush）时调用
  // messages 仅包含上次 addHandler 之后的 user/assistant 增量消息
  await myMemoryClient.add({
    ownerId: context.ownerId,
    sessionId: context.sessionId,
    messages,
  })
}

export async function searchHandler(transcript, context) {
  // 每次用户转写/文本提交后调用
  return await myMemoryClient.search({
    ownerId: context.ownerId,
    query: transcript,
    signal: context.signal,
  })
}
```

如需在启动时初始化客户端并在进程退出时关闭连接池，可在同文件的 `createAdvancedMemoryHandlers({ config, logger })` 中返回 `{ presessionHandler, addHandler, searchHandler, formatRecalledMemory?, close? }`。

2. 在 `.env` 中开启开关并启动：

```dotenv
# 开启先进记忆系统（自动关闭旧内置记忆逻辑）
QWEN_AUDIO_ADVANCED_MEMORY=on

# 可选：开启同步召回（默认 off，使用异步空闲注入）
# QWEN_AUDIO_ADVANCED_MEMORY_SYNC_RECALL=on
```

#### 方式二：嵌入代码直接传参

```js
import { createGatewayApplication } from 'qwen-audio-agent/gateway-application'

const gateway = createGatewayApplication({
  config: {
    ...defaultConfig,
    advancedMemoryEnabled: true,
    advancedMemorySyncRecall: false, // true 则开启同步召回
  },
  memoryPresessionHandler: async metadata => '...',
  memoryAddHandler: async (messages, context) => { /* ... */ },
  memorySearchHandler: async (transcript, context) => ['记忆1', '记忆2'],
  // 可选：自定义 <recalled_memory> 注入格式
  formatRecalledMemory: (value, context) => `<recalled_memory>\n${value}\n</recalled_memory>`,
})
```

> 若跳过 `createGatewayApplication` 直接调用 `createFrontendRuntime` 或 `createRealtimeSessionRuntime`，同样可直接传入 `memoryPresessionHandler`、`memoryAddHandler`、`memorySearchHandler`、`memorySyncRecall` 与 `formatRecalledMemory`；也可单独从 `qwen-audio-agent/turn-memory-hooks` 导入 `TurnMemoryHooks`。

---

### 2.2 环境变量配置表

| 环境变量 | 对应 `config` 字段 | 默认值 | 可选值 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| `QWEN_AUDIO_ADVANCED_MEMORY` | `config.advancedMemoryEnabled` | `off` (`false`) | `on`/`true`/`1` \| `off` | 开启后关闭原内置记忆逻辑与会话摘要，启用 `advanced-memory.mjs` 与 `TurnMemoryHooks` |
| `QWEN_AUDIO_ADVANCED_MEMORY_SYNC_RECALL` | `config.advancedMemorySyncRecall` | `off` (`false`) | `on`/`true`/`1` \| `off` | 需配合上方开关使用；开启后采用同步召回（支持延迟自动回复则先查再答，否则打断重答并打 warning） |

---

### 2.3 Handler 接口协议表

#### 1) `presessionHandler(metadata)`

| 方向 | 字段 / 类型 | 说明 |
| :--- | :--- | :--- |
| **入参 `metadata`** | `ownerId: string` | 用户唯一标识 |
| | `sessionId: string` | 会话 ID |
| | `provider: string` | 当前 Realtime Provider key（如 `dashscope`、`gpt-live`） |
| | `descriptor: { type?, label?, instanceId? }` | 客户端类型与实例信息 |
| | `client: { timeZone?, locale?, workingDirectory?, states?, actions?, inputCapabilities? }` | 客户端环境上下文 |
| | `inputEnabled: boolean` / `outputEnabled: boolean` / `textOnly: boolean` | 音视频/纯文本模式标志 |
| | `recentMessages: Array<object>` | 会话已有近期消息投影（空数组表示新会话） |
| | `signal: AbortSignal` | 会话关闭时中止 |
| | `logger: object \| null` | 连接级结构化日志器 |
| **返回值** | `string \| string[] \| object \| null \| undefined`（支持 `Promise`） | 非空文本直接原样注入 `instructions` 中原 `USER.md`/`MEMORY.md` 的位置；空值不注入 |

#### 2) `addHandler(messages, context)`

| 方向 | 字段 / 类型 | 说明 |
| :--- | :--- | :--- |
| **入参 1 `messages`** | `Array<ConversationMessage>` | 上次 `addHandler` 后新增的对话消息数组（不含系统提示及注入上下文）。每项包含 `{ id, seq, role: 'user' \| 'assistant', content, source, turnId, taskId, createdAt, ... }` |
| **入参 2 `context`** | `ownerId: string` / `sessionId: string` | 用户与会话标识 |
| | `responseId: string` | 触发本次 `add` 的云端响应 ID（关闭 flush 时为空字符串） |
| | `turnId: string` | 对应轮次 ID（关闭 flush 时为空字符串） |
| | `origin: string` | 触发来源（`'model'`、`'agent'`、`'announcement'` 或关闭兜底 `'session-close'`） |
| | `status: string` | `'completed'` 或关闭兜底 `'session_closed'` |
| | `logger: object \| null` | 连接级结构化日志器 |
| **返回值** | `void \| Promise<void>` | 同一会话串行 `await`，并纳入 `observers.drain()`；异常会被捕获记 warning |

#### 3) `searchHandler(transcript, context)`

| 方向 | 字段 / 类型 | 说明 |
| :--- | :--- | :--- |
| **入参 1 `transcript`** | `string` | 本轮用户的最终转写文本或手动输入文本（已 `trim`，空串不触发） |
| **入参 2 `context`** | `ownerId: string` / `sessionId: string` | 用户与会话标识 |
| | `turnId: string` | 当前用户轮次 ID |
| | `turnGeneration: number` | 当前提交代际号（用于过期判定） |
| | `source: 'voice-user' \| 'text-user'` | 语音转写或手动文本来源 |
| | `signal: AbortSignal` | 新一轮覆盖、用户插话、打断、静音、断连或关闭时自动 `abort` |
| | `logger: object \| null` | 连接级结构化日志器 |
| **返回值** | `string` | 单条文本记忆 |
| | `string[]` | 多条记忆（多于 1 条时自动转为 `- ...` 列表） |
| | `Array<{ content? \| memory? \| text? }>` | 记忆对象数组（兼容常见记忆库返回结构） |
| | `{ memories? \| items? \| results? \| content? \| memory? \| text? }` | 常见包装对象 |
| | `null \| undefined \| '' \| []` | 无相关记忆，跳过注入（同步打断模式下也不打断原回复） |

> 默认格式化函数 `formatRecalledMemory(value, context)` 会自动根据 `context.recallMode`（`'async'` \| `'sync-defer'` \| `'sync-interrupt'`）选择对应提示前缀并包裹在 `<recalled_memory>...</recalled_memory>` 中；若返回值本身已以 `<recalled_memory>` 开头，不会重复包裹。

---

### 2.4 `TurnMemoryHooks` 构造函数与生命周期方法表

| 成员 | 签名 | 说明 |
| :--- | :--- | :--- |
| `constructor` | `new TurnMemoryHooks({ ownerId, sessionId, presessionHandler?, addHandler?, searchHandler?, syncRecall?, formatRecalledMemory?, onInterruptForRecall?, conversationSync, turns, getFrontend, isInjectionBlocked?, trackPending?, logger? })` | 创建会话级实例，初始化 `lastAddedSeq` 水位并校验 handler 类型 |
| `loadPresessionContext` | `(metadata) => Promise<string>` | 执行一次 `presessionHandler` 并缓存结果到 `presessionContext` |
| `onUserTranscript` | `({ transcript, turnId, turnGeneration, source }) => Promise \| null` | 驱动异步或同步 `searchHandler` 与上下文回注 |
| `recallForManualTurn` | `({ transcript, turnId, turnGeneration, source }) => Promise<{ current, formatted }>` | 同步召回模式下供文本输入在 `sendUserInput` 前调用 |
| `onResponseDone` | `({ responseId, turnId, origin, status }) => Promise \| null` | 截取增量对话并串行调度 `addHandler` |
| `cancelPendingSearch` | `(reason) => void` | 中止当前在途 `searchHandler` 的 `AbortController` |
| `close` | `() => Promise \| null` | 尾流 flush 遗留消息 → 置 `closed = true` → 取消在途检索 |

---

### 2.5 关键日志与告警事件表

| 级别 | 事件名 | 触发条件 |
| :--- | :--- | :--- |
| `info` | `memory.advanced_enabled` | `advancedMemoryEnabled=true` 启动完成，记录各 handler 是否就绪及 `syncRecall` 状态 |
| `warn` | `memory.legacy_overridden` | `advancedMemoryEnabled=true` 覆写并关闭了原有记忆配置，列出 `overridden` 明细 |
| `warn` | `memory_hooks.sync_recall_unsupported_defer` | 开启同步召回但当前 Provider 不支持 `deferAutomaticResponse`，提示已降级为打断模式 |
| `warn` | `memory_hooks.sync_recall_interrupted_response` | 降级模式下召回非空记忆，正在打断云端当前自动回复并重新生成 |
| `warn` | `memory_hooks.presession_failed` | `presessionHandler` 抛出异常（不阻塞建连） |
| `warn` | `memory_hooks.add_failed` | `addHandler` 抛出异常（不影响后续轮次） |
| `warn` | `memory_hooks.search_failed` | `searchHandler` 抛出非 `AbortError` 异常（不影响实时对话） |
| `debug` | `memory_hooks.search_stale` | 检索返回时 `turnGeneration` 已过期，丢弃过时记忆 |
