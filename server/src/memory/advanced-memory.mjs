/**
 * 先进记忆系统入口文件。
 *
 * 当环境变量 `QWEN_AUDIO_ADVANCED_MEMORY=on`（`config.advancedMemoryEnabled === true`）时：
 * - 原有内置记忆系统（Markdown/VoiceMem、`memory` 工具、会话结束抽取/偏好学习、会话摘要）自动关闭；
 * - Gateway 会加载此模块导出的 `presessionHandler`、`addHandler` 与 `searchHandler`，
 *   由 TurnMemoryHooks 在会话建立及每轮对话中驱动。
 *
 * 你可以直接修改下面的三个 handler，或者在 `createAdvancedMemoryHandlers`
 * 中初始化自己的记忆客户端/连接池并在 `close()` 中释放资源。
 */

/**
 * 在 Realtime 会话建连（`session.update`）前调用一次。
 * 返回的文本会直接注入到系统提示词中原本 `USER.md` & `MEMORY.md` 所在的位置
 *（`</assistant_profile>` 之后、`buildFrontendContext` 之前）。
 *
 * @param {{
 *   ownerId: string,
 *   sessionId: string,
 *   provider: string,
 *   descriptor: { type?: string, label?: string, instanceId?: string | null },
 *   client: { timeZone?: string, locale?: string, workingDirectory?: string, states?: string[], actions?: string[], inputCapabilities?: object | null },
 *   inputEnabled: boolean,
 *   outputEnabled: boolean,
 *   textOnly: boolean,
 *   recentMessages: Array<object>,
 *   signal: AbortSignal,
 *   logger?: object,
 * }} metadata
 * @returns {Promise<string | string[] | null | undefined>}
 */
export async function presessionHandler(_metadata) {
  // TODO: 按 ownerId / sessionId 等 metadata 拉取会话初始画像或长期记忆文本，例如：
  // return await myMemoryClient.loadProfile({ ownerId: _metadata.ownerId, sessionId: _metadata.sessionId })
  return ''
}

/**
 * 每次 Agent 回复完成（以及会话关闭存在遗留消息）时调用。
 *
 * @param {Array<{ id: string, role: 'user' | 'assistant', content: string, source: string, turnId?: string, createdAt?: number }>} messages
 *   自上次 `addHandler` 调用之后新增的对话消息（不含系统提示词）。
 * @param {{ ownerId: string, sessionId: string, responseId: string, turnId: string, origin: string, status: string, logger?: object }} context
 */
export async function addHandler(_messages, _context) {
  // TODO: 写入你的外部/先进记忆系统，例如：
  // await myMemoryClient.add({ ownerId: _context.ownerId, sessionId: _context.sessionId, messages: _messages })
}

/**
 * 每次用户语音转写完成或文本输入提交时异步（或开启同步召回时同步）调用。
 * 返回非空字符串、字符串数组或对象数组时，会在非说话/非生成空闲窗口校验 turnGeneration 后，
 * 通过 `conversation.item.create` 安全注入上下文供模型参考。
 *
 * @param {string} transcript 本轮用户转写/输入文本。
 * @param {{ ownerId: string, sessionId: string, turnId: string, turnGeneration: number, source: string, signal: AbortSignal, logger?: object }} context
 * @returns {Promise<string | string[] | Array<{ content?: string, memory?: string, text?: string }> | null | undefined>}
 */
export async function searchHandler(_transcript, _context) {
  // TODO: 检索你的外部/先进记忆系统并返回需要注入上下文的回忆，例如：
  // return await myMemoryClient.search({ ownerId: _context.ownerId, query: _transcript, signal: _context.signal })
  return null
}

/**
 * Gateway 启动时调用的工厂函数（仅在 `config.advancedMemoryEnabled === true` 时触发）。
 * 如需按 `config` 初始化独立客户端或提供 `close()` 清理逻辑，可在此处返回自定义 handler。
 */
export function createAdvancedMemoryHandlers({ config: _config, logger: _logger } = {}) {
  return {
    presessionHandler,
    addHandler,
    searchHandler,
    // 可选：自定义注入格式（默认包装为 <recalled_memory>...</recalled_memory>）
    // formatRecalledMemory: (value, context) => ...,
    // 可选：Gateway 关闭且所有在途 addHandler drain 完成后调用
    // close: async () => {},
  }
}
