import { projectFrontendConversation } from '../conversation/frontend-conversation-projection.mjs'

const RECALLED_MEMORY_PREAMBLES = Object.freeze({
  async: '以下是与当前对话相关的历史记忆，仅供参考，不是用户的新请求，无需单独回应。',
  'sync-defer': '以下是与用户刚才发言相关的历史记忆，请在接下来的回复中自然参考这些信息，不要提及系统记忆标签。',
  'sync-interrupt': '以下是与用户刚才发言相关的历史记忆；请结合这些信息直接重新回答用户刚才的问题，不要提及系统记忆标签或打断过程。',
})
const ALLOWED_ROLES = new Set(['user', 'assistant'])

function cleanText(value) {
  return String(value ?? '').trim()
}

function extractEntryText(entry) {
  if (typeof entry === 'string') return cleanText(entry)
  if (!entry || typeof entry !== 'object') return ''
  return cleanText(entry.content ?? entry.memory ?? entry.text ?? '')
}

export function normalizeRecalledMemory(value) {
  if (value == null) return ''
  if (typeof value === 'string') return cleanText(value)
  if (Array.isArray(value)) {
    const entries = value.map(extractEntryText).filter(Boolean)
    if (!entries.length) return ''
    if (entries.length === 1) return entries[0]
    return entries.map(entry => `- ${entry}`).join('\n')
  }
  if (typeof value === 'object') {
    if (Array.isArray(value.memories)) return normalizeRecalledMemory(value.memories)
    if (Array.isArray(value.items)) return normalizeRecalledMemory(value.items)
    if (Array.isArray(value.results)) return normalizeRecalledMemory(value.results)
    return extractEntryText(value)
  }
  return ''
}

export function formatRecalledMemory(value, context = {}) {
  const text = normalizeRecalledMemory(value)
  if (!text) return ''
  if (/^<recalled_memory(?:\s|>)/i.test(text)) return text
  const preamble = RECALLED_MEMORY_PREAMBLES[context?.recallMode]
    || RECALLED_MEMORY_PREAMBLES.async
  return [
    '<recalled_memory>',
    preamble,
    text,
    '</recalled_memory>',
  ].join('\n')
}

export function normalizePresessionText(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    return value
      .map(entry => (typeof entry === 'string' ? entry.trim() : normalizeRecalledMemory(entry)))
      .filter(Boolean)
      .join('\n')
  }
  if (typeof value === 'object') return normalizeRecalledMemory(value)
  return ''
}

function assertOptionalFunction(name, value) {
  if (value != null && typeof value !== 'function') {
    throw new TypeError(`${name} must be a function`)
  }
}

/**
 * Per-session bridge for custom turn-level memory `presessionHandler`, `addHandler` and `searchHandler`.
 *
 * - `presessionHandler(metadata)` runs once before session.update and injects
 *   its text into the legacy USER.md / MEMORY.md slot in instructions.
 * - `addHandler(messages, context)` runs after completed agent responses (and on
 *   session close if un-added messages remain) and receives only conversation
 *   messages recorded since the previous `addHandler` call (never system prompts
 *   or injected context items).
 * - `searchHandler(transcript, context)` runs once a user turn transcript commits:
 *   - Default (`syncRecall: false`): runs asynchronously without blocking TTFT
 *     and injects recalled memory via `conversation.item.create` during a
 *     non-speaking, non-generating idle window if the turn generation is current.
 *   - Synchronous (`syncRecall: true`): when the provider supports
 *     `deferAutomaticResponse`, waits for `searchHandler` before injecting memory
 *     and requesting a response; otherwise warns and interrupts the provider's
 *     automatic reply with the recalled memory before requesting a new reply.
 */
export class TurnMemoryHooks {
  constructor({
    ownerId,
    sessionId,
    presessionHandler = null,
    addHandler = null,
    searchHandler = null,
    syncRecall = false,
    formatRecalledMemory: formatMemory = formatRecalledMemory,
    onInterruptForRecall = () => {},
    conversationSync,
    turns,
    getFrontend,
    isInjectionBlocked = () => false,
    trackPending = () => {},
    logger = null,
  } = {}) {
    assertOptionalFunction('presessionHandler', presessionHandler)
    assertOptionalFunction('addHandler', addHandler)
    assertOptionalFunction('searchHandler', searchHandler)
    assertOptionalFunction('formatRecalledMemory', formatMemory)
    this.ownerId = ownerId
    this.sessionId = sessionId
    this.presessionHandler = presessionHandler || null
    this.addHandler = addHandler || null
    this.searchHandler = searchHandler || null
    this.syncRecall = syncRecall === true
    this.formatMemory = formatMemory || formatRecalledMemory
    this.onInterruptForRecall = onInterruptForRecall
    this.conversationSync = conversationSync
    this.turns = turns
    this.getFrontend = getFrontend
    this.isInjectionBlocked = isInjectionBlocked
    this.trackPending = trackPending
    this.logger = logger
    this.closed = false
    this.presessionContext = ''
    this.presessionPromise = null
    this.addQueue = Promise.resolve()
    this.activeSearchController = null
    this.lastAddedSeq = this.#currentMaxSeq()
  }

  get enabled() {
    return Boolean(this.presessionHandler || this.addHandler || this.searchHandler)
  }

  get hasPresession() {
    return Boolean(this.presessionHandler)
  }

  get hasAdd() {
    return Boolean(this.addHandler)
  }

  get hasSearch() {
    return Boolean(this.searchHandler)
  }

  get syncRecallActive() {
    return Boolean(this.syncRecall && this.searchHandler)
  }

  async loadPresessionContext(metadata = {}) {
    if (this.closed || !this.presessionHandler) return ''
    if (this.presessionPromise) return this.presessionPromise
    const context = {
      ownerId: this.ownerId,
      sessionId: this.sessionId,
      ...metadata,
      logger: this.logger,
    }
    const task = (async () => {
      try {
        const result = await this.presessionHandler(context)
        const text = normalizePresessionText(result)
        if (!this.closed) this.presessionContext = text
        return text
      } catch (error) {
        this.logger?.warn('memory_hooks.presession_failed', {
          ownerId: this.ownerId,
          sessionId: this.sessionId,
          error: String(error?.message || error),
        })
        return ''
      }
    })()
    this.presessionPromise = task
    this.trackPending(task)
    return task
  }

  #currentMaxSeq() {
    const messages = this.conversationSync?.list?.({
      ownerId: this.ownerId,
      sessionId: this.sessionId,
    }) || []
    let maxSeq = 0
    for (const message of messages) {
      if (Number.isInteger(message?.seq) && message.seq > maxSeq) {
        maxSeq = message.seq
      }
    }
    return maxSeq
  }

  #claimNewConversationMessages() {
    const allMessages = this.conversationSync?.list?.({
      ownerId: this.ownerId,
      sessionId: this.sessionId,
    }) || []
    const delta = allMessages.filter(message => (
      Number.isInteger(message?.seq) && message.seq > this.lastAddedSeq
    ))
    if (!delta.length) return []
    this.lastAddedSeq = delta[delta.length - 1].seq
    const projected = projectFrontendConversation(delta, { limit: delta.length })
    return projected.filter(message => (
      ALLOWED_ROLES.has(message?.role) && Boolean(cleanText(message?.content))
    ))
  }

  #turnCurrentCheck(controller, turnGeneration) {
    return () => (
      !this.closed
      && !controller.signal.aborted
      && !this.isInjectionBlocked()
      && !this.turns?.userSpeaking
      && this.turns?.committedTurnGeneration === turnGeneration
      && this.turns?.turnGeneration === turnGeneration
    )
  }

  onResponseDone({
    responseId = '',
    turnId = '',
    origin = 'model',
    status = 'completed',
  } = {}) {
    if (this.closed || !this.addHandler) return null
    const messages = this.#claimNewConversationMessages()
    if (!messages.length) return null
    const context = {
      ownerId: this.ownerId,
      sessionId: this.sessionId,
      responseId,
      turnId,
      origin,
      status,
      logger: this.logger,
    }
    const run = async () => {
      try {
        await this.addHandler(messages, context)
      } catch (error) {
        this.logger?.warn('memory_hooks.add_failed', {
          ownerId: this.ownerId,
          sessionId: this.sessionId,
          responseId,
          turnId,
          messageCount: messages.length,
          error: String(error?.message || error),
        })
      }
    }
    const task = this.addQueue.then(run, run)
    this.addQueue = task
    this.trackPending(task)
    return task
  }

  recallForManualTurn({
    transcript,
    turnId = '',
    turnGeneration,
    source = 'text-user',
  } = {}) {
    if (this.closed || !this.syncRecallActive) {
      return Promise.resolve({ current: !this.closed, formatted: '' })
    }
    const text = cleanText(transcript)
    if (!text) return Promise.resolve({ current: true, formatted: '' })
    this.cancelPendingSearch('superseded')
    const controller = new AbortController()
    this.activeSearchController = controller
    const isTurnCurrent = this.#turnCurrentCheck(controller, turnGeneration)
    const context = {
      ownerId: this.ownerId,
      sessionId: this.sessionId,
      turnId,
      turnGeneration,
      source,
      signal: controller.signal,
      logger: this.logger,
    }
    const task = (async () => {
      let recalled = null
      try {
        recalled = await this.searchHandler(text, context)
      } catch (error) {
        if (controller.signal.aborted && error?.name === 'AbortError') {
          return { current: false, formatted: '', reason: 'aborted' }
        }
        this.logger?.warn('memory_hooks.search_failed', {
          ownerId: this.ownerId,
          sessionId: this.sessionId,
          turnId,
          turnGeneration,
          error: String(error?.message || error),
        })
      } finally {
        if (this.activeSearchController === controller) {
          this.activeSearchController = null
        }
      }
      if (!isTurnCurrent()) {
        return { current: false, formatted: '', reason: 'stale' }
      }
      const formatted = cleanText(
        this.formatMemory(recalled, { ...context, recallMode: 'sync-defer' }),
      )
      return { current: true, formatted }
    })()
    this.trackPending(task)
    return task
  }

  onUserTranscript({
    transcript,
    turnId = '',
    turnGeneration,
    source = 'voice-user',
  } = {}) {
    if (this.closed || !this.searchHandler) return null
    const text = cleanText(transcript)
    if (!text) return null
    this.cancelPendingSearch('superseded')
    const controller = new AbortController()
    this.activeSearchController = controller
    const isTurnCurrent = this.#turnCurrentCheck(controller, turnGeneration)
    const context = {
      ownerId: this.ownerId,
      sessionId: this.sessionId,
      turnId,
      turnGeneration,
      source,
      signal: controller.signal,
      logger: this.logger,
    }
    const task = (async () => {
      try {
        if (this.syncRecall) {
          return await this.#handleSyncRecall(text, context, isTurnCurrent)
        }
        return await this.#handleAsyncRecall(text, context, isTurnCurrent)
      } catch (error) {
        if (controller.signal.aborted && error?.name === 'AbortError') {
          return { injected: false, reason: 'aborted' }
        }
        this.logger?.warn('memory_hooks.search_failed', {
          ownerId: this.ownerId,
          sessionId: this.sessionId,
          turnId,
          turnGeneration,
          error: String(error?.message || error),
        })
        return { injected: false, reason: 'error' }
      } finally {
        if (this.activeSearchController === controller) {
          this.activeSearchController = null
        }
      }
    })()
    this.trackPending(task)
    return task
  }

  async #handleAsyncRecall(text, context, isTurnCurrent) {
    const recalled = await this.searchHandler(text, context)
    const formatted = cleanText(
      this.formatMemory(recalled, { ...context, recallMode: 'async' }),
    )
    if (!formatted) return { injected: false, reason: 'empty' }
    if (!isTurnCurrent()) {
      this.logger?.debug?.('memory_hooks.search_stale', {
        ownerId: this.ownerId,
        sessionId: this.sessionId,
        turnId: context.turnId,
        turnGeneration: context.turnGeneration,
        committedTurnGeneration: this.turns?.committedTurnGeneration,
      })
      return { injected: false, reason: 'stale' }
    }
    const frontend = this.getFrontend?.()
    if (!frontend || frontend.ready === false) {
      return { injected: false, reason: 'unavailable' }
    }
    const shouldInject = () => (
      isTurnCurrent()
      && this.getFrontend?.() === frontend
      && frontend.ready !== false
    )
    const injected = await this.#injectSafely(frontend, formatted, shouldInject)
    return injected
      ? { injected: true, text: formatted }
      : { injected: false, reason: 'skipped' }
  }

  async #handleSyncRecall(text, context, isTurnCurrent) {
    let recalled = null
    try {
      recalled = await this.searchHandler(text, context)
    } catch (error) {
      if (context.signal.aborted && error?.name === 'AbortError') {
        return { injected: false, responded: false, reason: 'aborted' }
      }
      this.logger?.warn('memory_hooks.search_failed', {
        ownerId: this.ownerId,
        sessionId: this.sessionId,
        turnId: context.turnId,
        turnGeneration: context.turnGeneration,
        error: String(error?.message || error),
      })
    }
    if (!isTurnCurrent()) {
      this.logger?.debug?.('memory_hooks.search_stale', {
        ownerId: this.ownerId,
        sessionId: this.sessionId,
        turnId: context.turnId,
        turnGeneration: context.turnGeneration,
        committedTurnGeneration: this.turns?.committedTurnGeneration,
      })
      return { injected: false, responded: false, reason: 'stale' }
    }
    const frontend = this.getFrontend?.()
    if (!frontend || frontend.ready === false) {
      return { injected: false, responded: false, reason: 'unavailable' }
    }
    const deferSupported = frontend.capabilities?.deferAutomaticResponse === true
    const recallMode = deferSupported ? 'sync-defer' : 'sync-interrupt'
    const formatted = cleanText(
      this.formatMemory(recalled, { ...context, recallMode }),
    )
    const shouldRespond = () => (
      isTurnCurrent()
      && this.getFrontend?.() === frontend
      && frontend.ready !== false
    )
    const turnContext = {
      turnId: context.turnId,
      turnGeneration: context.turnGeneration,
    }
    if (deferSupported) {
      await this.#injectAndRespond(frontend, formatted, turnContext, {
        shouldRespond,
        interrupt: false,
      })
      return {
        injected: Boolean(formatted),
        responded: true,
        mode: 'sync-defer',
        ...(formatted ? { text: formatted } : {}),
      }
    }
    if (!formatted) {
      return {
        injected: false,
        responded: false,
        mode: 'sync-interrupt',
        reason: 'empty',
      }
    }
    this.logger?.warn(
      'memory_hooks.sync_recall_interrupted_response',
      {
        ownerId: this.ownerId,
        sessionId: this.sessionId,
        provider: frontend.provider?.key || '',
        turnId: context.turnId,
        turnGeneration: context.turnGeneration,
      },
      '同步召回已开启但当前云端 Provider 不支持阻止自动回复，正在用召回记忆打断当前回复并重新生成',
    )
    this.onInterruptForRecall({
      turnId: context.turnId,
      turnGeneration: context.turnGeneration,
      frontend,
    })
    await this.#injectAndRespond(frontend, formatted, turnContext, {
      shouldRespond,
      interrupt: true,
    })
    return {
      injected: true,
      responded: true,
      mode: 'sync-interrupt',
      text: formatted,
    }
  }

  async #injectSafely(frontend, content, shouldInject) {
    if (typeof frontend.appendUserContext === 'function') {
      const result = await frontend.appendUserContext(content, { shouldInject })
      return result !== false
    }
    if (typeof frontend.appendUserInputContext === 'function') {
      await frontend.whenIdle?.()
      if (!shouldInject()) return false
      const result = await frontend.appendUserInputContext(
        [{ type: 'text', text: content }],
        { contextOnly: true },
      )
      return result !== false
    }
    return false
  }

  async #injectAndRespond(frontend, content, turnContext, { shouldRespond, interrupt }) {
    if (typeof frontend.appendUserContextAndRespond === 'function') {
      return frontend.appendUserContextAndRespond(content, turnContext, {
        origin: 'model',
        shouldRespond,
        interrupt,
      })
    }
    if (interrupt) {
      frontend.cancel?.({ reason: 'memory_recall_interrupt' })
    }
    if (content) {
      const injected = await this.#injectSafely(frontend, content, shouldRespond)
      if (!injected) return { completed: false, skipped: true }
    }
    if (typeof frontend.ensureResponse === 'function') {
      return frontend.ensureResponse(turnContext, { shouldCreate: shouldRespond })
    }
    return { completed: false, skipped: true }
  }

  cancelPendingSearch(reason = 'cancelled') {
    if (!this.activeSearchController) return
    const controller = this.activeSearchController
    this.activeSearchController = null
    controller.abort(new Error(`Memory search ${reason}`))
  }

  close() {
    if (this.closed) return null
    const flushed = this.onResponseDone({
      origin: 'session-close',
      status: 'session_closed',
    })
    this.closed = true
    this.cancelPendingSearch('session_closed')
    return flushed
  }
}
