import assert from 'node:assert/strict'
import test from 'node:test'
import { createRealtimeSessionRuntime } from '../src/voice/realtime-session-runtime.mjs'
import { RealtimeFrontend, buildFrontendInstructions } from '../src/voice/realtime-provider.mjs'
import { gptLiveProvider } from '../src/voice/providers/gpt-live.mjs'
import { openAiCompatibleProtocol } from '../src/voice/providers/openai-compatible-protocol.mjs'
import { SessionObservers } from '../src/voice/session-observers.mjs'
import { InputAssetRegistry } from '../src/voice/input-asset-registry.mjs'
import { createTaskAnnouncementRuntime } from '../src/voice/announcement/task-announcement-runtime.mjs'
import { ConversationSync } from '../src/conversation/conversation-sync.mjs'
import { TaskManager } from '../src/task/task-manager.mjs'
import { TaskOperations } from '../src/orchestration/task-operations.mjs'
import { clientActionCapabilities } from '../src/client/client-action-port.mjs'
import { createFrontendRuntime } from '../src/app/frontend-runtime.mjs'
import { createGatewayApplication } from '../src/app/gateway-application.mjs'
import { createMemoryModule } from '../src/memory/module.mjs'
import { config as defaultConfig } from '../src/core/config.mjs'
import {
  TurnMemoryHooks,
  formatRecalledMemory,
  normalizeRecalledMemory,
} from '../src/voice/turn-memory-hooks.mjs'
import { containsReservedProtocolEnvelope } from '../src/voice/response-guards/reserved-protocol-envelope.mjs'
import { GatewayClientEvent as Input } from '../../shared/protocol/realtime-events.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))

async function until(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'condition timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function createHarness(t, {
  ownerId = 'owner-1',
  sessionId = 'session-1',
  memoryPresessionHandler = null,
  memoryAddHandler = null,
  memorySearchHandler = null,
  memorySyncRecall = false,
  deferAutomaticResponse = false,
  observer = null,
  conversationSync = new ConversationSync(),
  realtimeFrontendFactory = null,
  frontendToolSources = [],
  playbackReceipts = false,
} = {}) {
  const events = []
  const frontends = []
  const logs = []
  const manager = new TaskManager()
  const logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [
    level, (event, fields = {}, message = '') => logs.push({ level, event, fields, message }),
  ]))
  const provider = {
    key: 'test',
    label: 'Test',
    model: () => 'test-model',
    inputSampleRate: 16000,
    outputSampleRate: 24000,
    capabilities: {
      conversationItems: true,
      clientResponses: true,
      deferAutomaticResponse,
    },
    classifyError: () => 'other',
  }
  const backendRuntime = {
    run: () => new Promise(() => {}),
    cancel: async () => ({ layer: 'backend', state: 'cancelled' }),
  }
  const operations = new TaskOperations({ taskManager: manager, backendRuntime })
  const observers = new SessionObservers(observer ? [observer] : [])
  let active = false
  const runtime = createRealtimeSessionRuntime({
    ownerId,
    sessionId,
    logger,
    observers,
    memoryPresessionHandler,
    memoryAddHandler,
    memorySearchHandler,
    memorySyncRecall,
    taskManager: manager,
    taskOperations: operations,
    backendRuntime,
    backendAvailability: { snapshot: () => ({ configured: false, ok: false, known: true }) },
    send: event => events.push(event),
    onTaskEvent: () => {},
    voiceAccess: {
      isActive: () => active,
      claim: () => { active = true; return { granted: true } },
      release: () => { const wasActive = active; active = false; return wasActive },
      changed() {},
    },
    actionCapabilities: clientActionCapabilities(),
    frontendToolSources,
    inputAssets: new InputAssetRegistry(),
    conversationSync,
    config: { sleepTimeoutMs: 0, announcementQuietMs: 0, announcementBatchMs: 0, taskNotificationClaimTtlMs: 60000 },
    realtimeProviderRegistry: { resolve: () => provider },
    defaultRealtimeProvider: 'test',
    taskAnnouncementFactory: createTaskAnnouncementRuntime,
    realtimeFrontendFactory: realtimeFrontendFactory || (options => {
      const idleGates = []
      const f = {
        provider,
        capabilities: provider.capabilities,
        initialContext: options.agentContext,
        sessionOptions: options.sessionOptions,
        ready: false,
        busy: false,
        inputs: [],
        contextItems: [],
        contextResponses: [],
        outputs: [],
        cancels: 0,
        async connect() { this.ready = true },
        close() { this.ready = false },
        cancel() { this.cancels += 1 },
        cancelResponses() {},
        clearPendingImage() {},
        appendAudio() {},
        appendImage() {},
        updateAgentContext() {},
        async sendUserInput(parts, context) { this.inputs.push({ parts, context }); return {} },
        async sendFunctionOutput(callId, result) { this.outputs.push({ callId, result }) },
        async ensureResponse() {},
        async whenIdle() {
          while (this.busy) {
            await new Promise(resolve => idleGates.push(resolve))
          }
        },
        setBusy(next) {
          this.busy = next
          if (!next) {
            while (idleGates.length) idleGates.shift()()
          }
        },
        async appendUserContext(text, { shouldInject } = {}) {
          await this.whenIdle()
          if (!this.ready) return false
          if (shouldInject && !shouldInject()) return false
          this.contextItems.push(text)
          return { id: `item_${this.contextItems.length}` }
        },
        async appendUserContextAndRespond(text, context, { origin = 'model', shouldRespond, interrupt = false } = {}) {
          if (interrupt) this.cancels += 1
          await this.whenIdle()
          if (!this.ready) return { completed: false }
          if (shouldRespond && !shouldRespond()) return { skipped: true }
          if (text) this.contextItems.push(text)
          this.contextResponses.push({ text, context, origin, interrupt })
          return { completed: true }
        },
        emit: options.onEvent,
      }
      frontends.push(f)
      return f
    }),
  })
  const send = (event, options) => runtime.handleClientEvent(event, options)
  const connect = async () => {
    runtime.start()
    send({ type: Input.CONNECT, inputEnabled: true, outputEnabled: true }, {
      descriptor: { type: 'test', instanceId: 'i1' },
      capabilitiesNegotiated: true,
      capabilities: playbackReceipts
        ? ['input.audio', 'input.text', 'playback.receipts']
        : ['input.audio', 'input.text'],
    })
    await until(() => runtime.status().state === 'connected')
    return frontends.at(-1)
  }
  t.after(async () => {
    runtime.close()
    await observers.drain()
  })
  return { runtime, send, connect, frontends, events, logs, conversationSync, observers, ownerId, sessionId }
}

function voiceTurn(f, itemId, transcript) {
  f.emit({ type: 'input_audio_buffer.speech_started', item_id: itemId })
  f.emit({ type: 'input_audio_buffer.speech_stopped', item_id: itemId })
  f.emit({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    transcript,
  })
}

function assistantReply(f, responseId, transcript, { audio = true, status = 'completed' } = {}) {
  f.emit({ type: 'response.created', response: { id: responseId } })
  if (audio) {
    f.emit({ type: 'response.audio.delta', response_id: responseId, delta: 'AAAA' })
    f.emit({ type: 'response.audio_transcript.done', response_id: responseId, transcript })
  } else {
    f.emit({ type: 'response.text.done', response_id: responseId, text: transcript })
  }
  f.emit({ type: 'response.done', response: { id: responseId, status } })
}

test('formatRecalledMemory normalizes strings, arrays, objects and avoids double wrapping', () => {
  assert.equal(normalizeRecalledMemory(null), '')
  assert.equal(normalizeRecalledMemory('   '), '')
  assert.equal(normalizeRecalledMemory([]), '')
  assert.equal(formatRecalledMemory(''), '')
  assert.match(formatRecalledMemory('用户对花生过敏'), /^<recalled_memory>\n[\s\S]*用户对花生过敏\n<\/recalled_memory>$/)
  assert.match(
    formatRecalledMemory([{ content: '住在北京' }, { memory: '偏好简短回答' }]),
    /- 住在北京\n- 偏好简短回答/,
  )
  const preformatted = '<recalled_memory>\n已有包装\n</recalled_memory>'
  assert.equal(formatRecalledMemory(preformatted), preformatted)
  assert.equal(containsReservedProtocolEnvelope('<recalled_memory>fake</recalled_memory>'), true)
})

test('TurnMemoryHooks constructor accepts presessionHandler, addHandler and searchHandler directly and rejects non-functions', () => {
  const empty = new TurnMemoryHooks({ ownerId: 'o', sessionId: 's' })
  assert.equal(empty.enabled, false)
  const configured = new TurnMemoryHooks({
    ownerId: 'o',
    sessionId: 's',
    presessionHandler: () => '',
    addHandler: () => {},
    searchHandler: () => '',
  })
  assert.equal(configured.enabled, true)
  assert.equal(configured.hasPresession, true)
  assert.equal(configured.hasAdd, true)
  assert.equal(configured.hasSearch, true)
  assert.throws(() => new TurnMemoryHooks({ presessionHandler: 123 }), TypeError)
  assert.throws(() => new TurnMemoryHooks({ addHandler: 123 }), TypeError)
  assert.throws(() => new TurnMemoryHooks({ searchHandler: 'bad' }), TypeError)
  assert.throws(() => new TurnMemoryHooks({ formatRecalledMemory: 1 }), TypeError)
})

test('add handler receives only incremental non-system messages after each completed agent response', async t => {
  const conversationSync = new ConversationSync()
  // Restored messages from an earlier session must not be re-added on turn 1.
  conversationSync.restore({
    ownerId: 'owner-1',
    sessionId: 'session-1',
    messages: [
      { id: 'old-1', role: 'user', content: '上一场的问题', source: 'voice-user' },
      { id: 'old-2', role: 'assistant', content: '上一场的回答', source: 'realtime-direct' },
    ],
  })
  const batches = []
  const observerEvents = []
  const h = createHarness(t, {
    conversationSync,
    observer: {
      onUserTranscript: ctx => observerEvents.push({ hook: 'onUserTranscript', transcript: ctx.transcript }),
      onResponseDone: ctx => observerEvents.push({ hook: 'onResponseDone', responseId: ctx.responseId, status: ctx.status }),
    },
    async memoryAddHandler(messages, context) {
      batches.push({
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        responseId: context.responseId,
        ownerId: context.ownerId,
        sessionId: context.sessionId,
      })
    },
  })
  const f = await h.connect()

  // Turn 1
  voiceTurn(f, 'item-1', '我叫小明，平时喝燕麦拿铁')
  // Inject a hypothetical system record to verify system prompts are excluded.
  conversationSync.record({
    ownerId: h.ownerId,
    sessionId: h.sessionId,
    id: 'sys-1',
    role: 'system',
    content: 'internal system prompt',
    source: 'system',
  })
  // Built-in memory writes may call discardRecorded; incremental add must survive it.
  conversationSync.discardRecorded(h.ownerId)
  assistantReply(f, 'resp-1', '好的小明，记住你爱喝燕麦拿铁了。')
  await until(() => batches.length === 1)

  assert.deepEqual(batches[0].messages, [
    { role: 'user', content: '我叫小明，平时喝燕麦拿铁' },
    { role: 'assistant', content: '好的小明，记住你爱喝燕麦拿铁了。' },
  ])
  assert.equal(batches[0].responseId, 'resp-1')

  // Turn 2: receives ONLY messages after Turn 1's add
  voiceTurn(f, 'item-2', '帮我推荐明天早餐')
  assistantReply(f, 'resp-2', '可以配一杯热燕麦拿铁和全麦吐司。')
  await until(() => batches.length === 2)

  assert.deepEqual(batches[1].messages, [
    { role: 'user', content: '帮我推荐明天早餐' },
    { role: 'assistant', content: '可以配一杯热燕麦拿铁和全麦吐司。' },
  ])
  assert.equal(batches[1].responseId, 'resp-2')
  assert.ok(observerEvents.some(e => e.hook === 'onUserTranscript' && e.transcript === '帮我推荐明天早餐'))
  assert.ok(observerEvents.some(e => e.hook === 'onResponseDone' && e.responseId === 'resp-2' && e.status === 'completed'))
})

test('add waits for playback start when final assistant transcript is buffered behind playback receipts', async t => {
  const batches = []
  const h = createHarness(t, {
    playbackReceipts: true,
    memoryAddHandler(messages) {
      batches.push(messages.map(m => ({ role: m.role, content: m.content })))
    },
  })
  const f = await h.connect()

  voiceTurn(f, 'item-p1', '今天天气怎么样')
  // Audio + transcript complete BEFORE playback.started arrives
  assistantReply(f, 'resp-p1', '今天晴天，22度。')
  await tick()
  assert.equal(batches.length, 0, 'waits until buffered assistant transcript is flushed on playback.started')

  h.send({ type: Input.PLAYBACK_STARTED, responseId: 'resp-p1' })
  await until(() => batches.length === 1)
  assert.deepEqual(batches[0], [
    { role: 'user', content: '今天天气怎么样' },
    { role: 'assistant', content: '今天晴天，22度。' },
  ])
})

test('add skips cancelled responses and preserves unconsumed user messages for the next completed reply', async t => {
  const batches = []
  const h = createHarness(t, {
    memoryAddHandler(messages) {
      batches.push(messages.map(m => ({ role: m.role, content: m.content })))
    },
  })
  const f = await h.connect()

  voiceTurn(f, 'item-c1', '帮我查个资料')
  f.emit({ type: 'response.created', response: { id: 'resp-cancelled' } })
  f.emit({ type: 'response.done', response: { id: 'resp-cancelled', status: 'cancelled' } })
  await tick()
  assert.equal(batches.length, 0)

  voiceTurn(f, 'item-c2', '算了，直接说结论吧')
  assistantReply(f, 'resp-ok', '结论是方案 A 更快。')
  await until(() => batches.length === 1)
  assert.deepEqual(batches[0], [
    { role: 'user', content: '帮我查个资料' },
    { role: 'user', content: '算了，直接说结论吧' },
    { role: 'assistant', content: '结论是方案 A 更快。' },
  ])
})

test('add runs once after tool follow-up completes rather than splitting on intermediate tool call response', async t => {
  const batches = []
  const h = createHarness(t, {
    frontendToolSources: [{
      describe: () => ({ key: 'weather', label: 'Weather' }),
      initialize: async () => {},
      health: async () => ({ ok: true }),
      close: async () => {},
      tools: () => [{
        name: 'get_weather',
        policy: {},
        definition: {
          type: 'function',
          function: { name: 'get_weather', description: 'weather', parameters: { type: 'object' } },
        },
      }],
      execute: async () => ({ status: 'completed', user_message: '晴天 25 度' }),
    }],
    memoryAddHandler(messages) {
      batches.push(messages.map(m => ({ role: m.role, content: m.content })))
    },
  })
  const f = await h.connect()

  voiceTurn(f, 'item-tool', '北京天气如何')
  f.emit({ type: 'response.created', response: { id: 'resp-tool-call' } })
  f.emit({
    type: 'response.function_call_arguments.done',
    response_id: 'resp-tool-call',
    call_id: 'call-1',
    name: 'get_weather',
    arguments: '{}',
  })
  f.emit({ type: 'response.done', response: { id: 'resp-tool-call', status: 'completed' } })
  await until(() => f.outputs.length === 1)
  await tick()
  assert.equal(batches.length, 0, 'intermediate tool-call response should not fire premature add')

  assistantReply(f, 'resp-tool-final', '北京今天晴天，25度。')
  await until(() => batches.length === 1)
  assert.deepEqual(batches[0], [
    { role: 'user', content: '北京天气如何' },
    { role: 'assistant', content: '北京今天晴天，25度。' },
  ])
})

test('query runs asynchronously on user transcript and injects recalled memory once idle without blocking TTFT', async t => {
  const pendingQuery = Promise.withResolvers()
  const queries = []
  const h = createHarness(t, {
    memorySearchHandler(transcript, context) {
      queries.push({ transcript, turnId: context.turnId, turnGeneration: context.turnGeneration, source: context.source })
      return pendingQuery.promise
    },
  })
  const f = await h.connect()

  // Simulate model already generating a response right after speech stops
  f.setBusy(true)
  voiceTurn(f, 'item-q1', '周末想去杭州玩')
  await until(() => queries.length === 1)
  assert.equal(queries[0].transcript, '周末想去杭州玩')
  assert.equal(queries[0].source, 'voice-user')

  // Current turn audio streams immediately without waiting for query
  f.emit({ type: 'response.created', response: { id: 'resp-q1' } })
  f.emit({ type: 'response.audio.delta', response_id: 'resp-q1', delta: 'AAAA' })
  assert.equal(h.events.some(e => e.type === 'audio.delta'), true)

  // Query finishes while model is still busy generating -> must wait for idle window
  pendingQuery.resolve(['用户偏好西湖边安静的酒店', '对海鲜过敏'])
  await tick()
  assert.equal(f.contextItems.length, 0, 'must not inject while response is still generating')

  // Model finishes generating -> idle window opens -> safe injection runs
  f.emit({ type: 'response.audio_transcript.done', response_id: 'resp-q1', transcript: '杭州很适合周末去。' })
  f.emit({ type: 'response.done', response: { id: 'resp-q1', status: 'completed' } })
  f.setBusy(false)

  await until(() => f.contextItems.length === 1)
  assert.match(f.contextItems[0], /^<recalled_memory>/)
  assert.match(f.contextItems[0], /- 用户偏好西湖边安静的酒店\n- 对海鲜过敏/)
})

test('query drops stale recall when user barges in or interrupts before injection', async t => {
  const query1 = Promise.withResolvers()
  const query2 = Promise.withResolvers()
  const signals = []
  let callIndex = 0
  const h = createHarness(t, {
    memorySearchHandler(transcript, context) {
      signals.push({ transcript, signal: context.signal })
      callIndex += 1
      return callIndex === 1 ? query1.promise : query2.promise
    },
  })
  const f = await h.connect()

  // Turn 1 starts query
  voiceTurn(f, 'item-s1', '帮我查机票')
  await until(() => signals.length === 1)
  assert.equal(signals[0].signal.aborted, false)

  // User barges in -> aborts query 1 and advances turn generation
  f.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-s2' })
  assert.equal(signals[0].signal.aborted, true, 'barge-in should abort previous in-flight query')

  // Turn 1 query resolves late while user is speaking Turn 2 -> must be dropped
  query1.resolve('过期记忆：上次查过上海机票')
  await tick()
  assert.equal(f.contextItems.length, 0)

  // Turn 2 completes -> triggers query 2
  f.emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'item-s2' })
  f.emit({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item-s2',
    transcript: '改查火车票吧',
  })
  await until(() => signals.length === 2)

  // User clicks INTERRUPT before query 2 resolves -> must drop query 2 too
  h.send({ type: Input.INTERRUPT })
  assert.equal(signals[1].signal.aborted, true)
  query2.resolve('过期记忆：偏好靠窗座位')
  await tick()
  assert.equal(f.contextItems.length, 0)
})

test('query triggers on manual text input and skips empty recall results', async t => {
  const seen = []
  const h = createHarness(t, {
    async memorySearchHandler(transcript, context) {
      seen.push({ transcript, source: context.source })
      return transcript.includes('咖啡') ? '喜欢无糖美式' : ''
    },
  })
  const f = await h.connect()

  h.send({ type: Input.TEXT_MESSAGE, text: '你好' })
  await until(() => seen.length === 1)
  await tick()
  assert.equal(seen[0].source, 'text-user')
  assert.equal(f.contextItems.length, 0, 'empty recall must not inject a conversation item')

  h.send({ type: Input.TEXT_MESSAGE, text: '我想点咖啡' })
  await until(() => f.contextItems.length === 1)
  assert.match(f.contextItems[0], /喜欢无糖美式/)
})

test('real RealtimeFrontend queues recalled memory behind active response slot and sends conversation.item.create when idle', async () => {
  const sent = []
  const provider = {
    key: 'test-wire',
    label: 'Test Wire',
    inputSampleRate: 16000,
    outputSampleRate: 24000,
    protocol: openAiCompatibleProtocol,
    model: () => 'test-model',
    voice: () => 'default',
    capabilities: {
      singleResponseSlot: true,
      conversationItems: true,
      acknowledgesConversationItems: false,
      clientResponses: true,
    },
    isConfigured: () => true,
    url: () => 'ws://localhost:1',
    headers: () => ({}),
    classifyError: () => 'other',
    buildSession: () => ({ instructions: 'test' }),
    buildSpeakResponse: text => ({ instructions: text }),
    buildResultInjection: text => ({ item: openAiCompatibleProtocol.userTextItem(text), response: {} }),
    buildPermissionInjection: () => ({ item: openAiCompatibleProtocol.userTextItem('perm'), response: {} }),
  }
  const frontend = new RealtimeFrontend({ provider })
  frontend.ready = true
  frontend.sessionConfigured = true
  frontend.ws = {
    readyState: 1,
    bufferedAmount: 0,
    send(raw) { sent.push(JSON.parse(raw)) },
  }

  // Simulate an active model response occupying the response lifecycle
  frontend.handleProviderEvent({ type: 'response.created', response: { id: 'resp-live-1' } })

  let stillCurrent = true
  const injectPromise = frontend.appendUserContext('<recalled_memory>\n测试记忆\n</recalled_memory>', {
    shouldInject: () => stillCurrent,
  })
  await tick()
  assert.equal(
    sent.some(msg => msg.type === 'conversation.item.create'),
    false,
    'must wait until active response completes before sending conversation.item.create',
  )

  // Complete the active response -> idle window opens -> item is created
  frontend.handleProviderEvent({ type: 'response.done', response: { id: 'resp-live-1', status: 'completed' } })
  await injectPromise
  const created = sent.find(msg => msg.type === 'conversation.item.create')
  assert.ok(created, 'should emit conversation.item.create once idle')
  assert.equal(created.item.role, 'user')
  assert.equal(created.item.content[0].text, '<recalled_memory>\n测试记忆\n</recalled_memory>')

  // Now verify stale shouldInject cancels injection even after waiting for idle
  frontend.handleProviderEvent({ type: 'response.created', response: { id: 'resp-live-2' } })
  const stalePromise = frontend.appendUserContext('<recalled_memory>\n过期记忆\n</recalled_memory>', {
    shouldInject: () => stillCurrent,
  })
  stillCurrent = false
  frontend.handleProviderEvent({ type: 'response.done', response: { id: 'resp-live-2', status: 'completed' } })
  const staleResult = await stalePromise
  assert.equal(staleResult, false)
  assert.equal(sent.filter(msg => msg.type === 'conversation.item.create').length, 1)
})

test('createFrontendRuntime drains pending add hooks on close and isolates handler errors', async () => {
  const deferredAdd = Promise.withResolvers()
  const warnings = []
  let addDone = false
  const runtime = createFrontendRuntime({
    logger: {
      info() {},
      debug() {},
      error() {},
      warn(event, fields) { warnings.push({ event, fields }) },
    },
    async memoryAddHandler() {
      await deferredAdd.promise
      addDone = true
    },
    async memorySearchHandler() {
      throw new Error('vector db timeout')
    },
    conversationSync: new ConversationSync(),
    config: { sleepTimeoutMs: 0, announcementQuietMs: 0, announcementBatchMs: 0, taskNotificationClaimTtlMs: 60000 },
    realtimeProviderRegistry: {
      resolve: () => ({
        key: 'test',
        label: 'Test',
        inputSampleRate: 16000,
        outputSampleRate: 24000,
        capabilities: { conversationItems: true, clientResponses: true },
        classifyError: () => 'other',
      }),
    },
    defaultRealtimeProvider: 'test',
    realtimeFrontendFactory: options => ({
      provider: { key: 'test', label: 'Test', inputSampleRate: 16000, outputSampleRate: 24000 },
      capabilities: { conversationItems: true, clientResponses: true },
      ready: false,
      async connect() { this.ready = true },
      close() { this.ready = false },
      cancel() {},
      cancelResponses() {},
      clearPendingImage() {},
      appendAudio() {},
      appendImage() {},
      updateAgentContext() {},
      async sendUserInput() { return {} },
      async appendUserContext() { return true },
      emit: options.onEvent,
    }),
  })

  let frontend = null
  const session = runtime.createSession({
    ownerId: 'o1',
    sessionId: 's1',
    send() {},
    onTaskEvent() {},
    voiceAccess: { isActive: () => true, claim: () => ({ granted: true }), release: () => true, changed() {} },
    actionCapabilities: clientActionCapabilities(),
    realtimeFrontendFactory: options => {
      frontend = {
        provider: { key: 'test', label: 'Test', inputSampleRate: 16000, outputSampleRate: 24000 },
        capabilities: { conversationItems: true, clientResponses: true },
        ready: false,
        async connect() { this.ready = true },
        close() { this.ready = false },
        cancel() {},
        cancelResponses() {},
        clearPendingImage() {},
        appendAudio() {},
        appendImage() {},
        updateAgentContext() {},
        async sendUserInput() { return {} },
        async appendUserContext() { return true },
        emit: options.onEvent,
      }
      return frontend
    },
  })
  session.start()
  session.handleClientEvent({ type: Input.CONNECT, inputEnabled: true, outputEnabled: true }, {
    descriptor: { type: 'test', instanceId: 'i1' },
    capabilitiesNegotiated: true,
    capabilities: ['input.audio', 'input.text'],
  })
  await until(() => frontend?.ready === true)

  voiceTurn(frontend, 'item-drain', '记得帮我保存')
  assistantReply(frontend, 'resp-drain', '好的已记住')
  await until(() => warnings.some(w => w.event === 'memory_hooks.search_failed'))

  let closed = false
  const closing = runtime.close().then(() => { closed = true })
  await tick()
  assert.equal(closed, false, 'close() must wait for in-flight add hook to drain')
  deferredAdd.resolve()
  await closing
  assert.equal(addDone, true)
})

test('close flushes leftover un-added messages once and stays silent when already caught up', async t => {
  const batches = []
  const h = createHarness(t, {
    memoryAddHandler(messages, context) {
      batches.push({
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        origin: context.origin,
        status: context.status,
      })
    },
  })
  const f = await h.connect()

  // Turn 1 finishes normally -> added on response.done
  voiceTurn(f, 'item-f1', '第一句')
  assistantReply(f, 'resp-f1', '第一句回复')
  await until(() => batches.length === 1)

  // Turn 2 user speaks, then disconnects before any assistant reply finishes
  voiceTurn(f, 'item-f2', '临走前再交代一件事')
  h.runtime.close()
  await h.observers.drain()

  assert.equal(batches.length, 2)
  assert.deepEqual(batches[1], {
    messages: [{ role: 'user', content: '临走前再交代一件事' }],
    origin: 'session-close',
    status: 'session_closed',
  })

  // Closing an already caught-up session triggers no extra add call
  const caughtUpBatches = []
  const h2 = createHarness(t, {
    memoryAddHandler(messages) {
      caughtUpBatches.push(messages)
    },
  })
  const f2 = await h2.connect()
  voiceTurn(f2, 'item-ok', '你好')
  assistantReply(f2, 'resp-ok', '你好呀')
  await until(() => caughtUpBatches.length === 1)
  h2.runtime.close()
  await h2.observers.drain()
  assert.equal(caughtUpBatches.length, 1)
})

function stubAgent() {
  return {
    enabled: false,
    describe: () => ({ protocol: 'none' }),
    health: async () => ({ ok: false }),
    canRecoverDelegatedWork: () => false,
    async start() {},
    async submit() { return {} },
    async status() { return {} },
    async cancel() { return {} },
    async respondAuthorization() { return {} },
    async respondInput() { return {} },
    subscribe: () => () => {},
    async close() {},
  }
}

test('advancedMemoryEnabled disables legacy memory module, emits override warning, and activates memory hooks', async t => {
  const memModule = createMemoryModule({
    config: { ...defaultConfig, advancedMemoryEnabled: true, preferenceLearningEnabled: true },
  })
  assert.equal(memModule.services.frontendMemory, null)
  assert.equal(memModule.services.memoryProvider, null)
  assert.deepEqual(memModule.sessionObservers, [])

  const logs = []
  const logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [
    level, (event, fields = {}, message = '') => logs.push({ level, event, fields, message }),
  ]))
  const added = []
  const queried = []
  const application = createGatewayApplication({
    autoStart: false,
    logger,
    config: {
      ...defaultConfig,
      advancedMemoryEnabled: true,
      memoryProvider: 'markdown',
      memoryAutoEnabled: true,
      preferenceLearningEnabled: true,
      sessionDigestEnabled: true,
      reminderSchedulerEnabled: false,
    },
    agent: stubAgent(),
    frontendMcp: null,
    frontendOpenApi: null,
    publicEndpoint: null,
    memoryAddHandler: messages => added.push(messages),
    memorySearchHandler: transcript => {
      queried.push(transcript)
      return '来自先进记忆的召回'
    },
  })
  t.after(() => application.close())

  assert.equal(application.services.memoryProvider, null)
  assert.equal(application.services.frontendMemory, null)
  assert.equal(application.services.sessionDigests, null)
  assert.equal(application.services.sessionSummariser, null)
  assert.equal(application.services.advancedMemory.enabled, true)
  assert.equal(typeof application.services.advancedMemory.addHandler, 'function')
  assert.equal(typeof application.services.advancedMemory.searchHandler, 'function')

  const warning = logs.find(entry => entry.level === 'warn' && entry.event === 'memory.legacy_overridden')
  assert.ok(warning, 'must log memory.legacy_overridden warning when legacy memory configs are overridden')
  assert.deepEqual(warning.fields.overridden, [
    'memoryProvider=markdown',
    'memoryAutoEnabled',
    'preferenceLearningEnabled',
    'sessionDigestEnabled',
  ])

  // Verify default advanced-memory.mjs handlers load when no override handlers are passed
  const defaultApp = createGatewayApplication({
    autoStart: false,
    logger,
    config: {
      ...defaultConfig,
      advancedMemoryEnabled: true,
      memoryAutoEnabled: false,
      preferenceLearningEnabled: false,
      sessionDigestEnabled: false,
      reminderSchedulerEnabled: false,
    },
    agent: stubAgent(),
    frontendMcp: null,
    frontendOpenApi: null,
    publicEndpoint: null,
  })
  t.after(() => defaultApp.close())
  assert.equal(defaultApp.services.advancedMemory.enabled, true)
  assert.equal(typeof defaultApp.services.advancedMemory.addHandler, 'function')
  assert.equal(typeof defaultApp.services.advancedMemory.searchHandler, 'function')
})

test('when advancedMemoryEnabled is false, legacy memory stays active and memory hooks stay disabled', async t => {
  const logs = []
  const logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [
    level, (event, fields = {}, message = '') => logs.push({ level, event, fields, message }),
  ]))
  const application = createGatewayApplication({
    autoStart: false,
    logger,
    config: {
      ...defaultConfig,
      advancedMemoryEnabled: false,
      memoryProvider: 'markdown',
      reminderSchedulerEnabled: false,
    },
    agent: stubAgent(),
    frontendMcp: null,
    frontendOpenApi: null,
    publicEndpoint: null,
    memoryAddHandler: () => {},
    memorySearchHandler: () => 'should not activate',
  })
  t.after(() => application.close())

  assert.ok(application.services.memoryProvider)
  assert.ok(application.services.frontendMemory)
  assert.equal(application.services.advancedMemory.enabled, false)
  assert.equal(application.services.advancedMemory.syncRecall, false)
  assert.equal(application.services.advancedMemory.addHandler, null)
  assert.equal(application.services.advancedMemory.searchHandler, null)
  assert.equal(logs.some(entry => entry.event === 'memory.legacy_overridden'), false)
})

test('gpt-live buildSession sets turn_detection.create_response=false only when deferAutomaticResponse is enabled', () => {
  const normal = gptLiveProvider.buildSession({ agentContext: {}, sessionOptions: {} })
  assert.equal(normal.audio.input.turn_detection.create_response, undefined)

  const deferred = gptLiveProvider.buildSession({
    agentContext: {},
    sessionOptions: { deferAutomaticResponse: true },
  })
  assert.equal(deferred.audio.input.turn_detection.type, 'server_vad')
  assert.equal(deferred.audio.input.turn_detection.create_response, false)
  assert.equal(gptLiveProvider.capabilities.deferAutomaticResponse, true)
})

test('syncRecall with deferAutomaticResponse waits for searchHandler before injecting memory and triggering response', async t => {
  const pending1 = Promise.withResolvers()
  const pending2 = Promise.withResolvers()
  let callCount = 0
  const h = createHarness(t, {
    memorySyncRecall: true,
    deferAutomaticResponse: true,
    memorySearchHandler() {
      callCount += 1
      return callCount === 1 ? pending1.promise : pending2.promise
    },
  })
  const f = await h.connect()

  assert.equal(f.sessionOptions.deferAutomaticResponse, true)
  assert.equal(
    h.logs.some(entry => entry.event === 'memory_hooks.sync_recall_unsupported_defer'),
    false,
    'supported provider must not log unsupported-defer warning',
  )

  // Turn 1: memory returned -> inject memory + request response without interrupt
  voiceTurn(f, 'item-sd1', '今晚吃什么好')
  await until(() => callCount === 1)
  await tick()
  assert.equal(f.contextResponses.length, 0, 'must wait for searchHandler before requesting response')

  pending1.resolve('用户对海鲜过敏，爱吃川菜')
  await until(() => f.contextResponses.length === 1)
  assert.equal(f.contextResponses[0].interrupt, false)
  assert.match(f.contextResponses[0].text, /用户对海鲜过敏，爱吃川菜/)
  assert.match(f.contextResponses[0].text, /在接下来的回复中自然参考/)

  // Turn 2: searchHandler returns null/empty -> still triggers cloud response so user gets a reply
  voiceTurn(f, 'item-sd2', '随便聊聊')
  await until(() => callCount === 2)
  pending2.resolve(null)
  await until(() => f.contextResponses.length === 2)
  assert.equal(f.contextResponses[1].interrupt, false)
  assert.equal(f.contextResponses[1].text, '')
})

test('syncRecall without deferAutomaticResponse warns and interrupts ongoing response when memory returns', async t => {
  const pending1 = Promise.withResolvers()
  const pending2 = Promise.withResolvers()
  let callCount = 0
  const h = createHarness(t, {
    memorySyncRecall: true,
    deferAutomaticResponse: false,
    memorySearchHandler() {
      callCount += 1
      return callCount === 1 ? pending1.promise : pending2.promise
    },
  })
  const f = await h.connect()

  assert.ok(
    h.logs.some(entry => entry.level === 'warn' && entry.event === 'memory_hooks.sync_recall_unsupported_defer'),
    'unsupported provider must log warning on connect',
  )

  // Turn 1: cloud auto-starts replying; memory arrives -> interrupt + clear playback + re-respond + warning
  voiceTurn(f, 'item-si1', '帮我订机票')
  f.emit({ type: 'response.created', response: { id: 'resp-auto-1' } })
  f.emit({ type: 'response.audio.delta', response_id: 'resp-auto-1', delta: 'AAAA' })
  await until(() => callCount === 1)

  const cancelsBefore = f.cancels
  pending1.resolve('用户只坐靠窗座位，优先国航')
  await until(() => f.contextResponses.length === 1)

  assert.equal(f.cancels, cancelsBefore + 1)
  assert.equal(f.contextResponses[0].interrupt, true)
  assert.match(f.contextResponses[0].text, /直接重新回答用户刚才的问题/)
  assert.match(f.contextResponses[0].text, /只坐靠窗座位/)
  assert.ok(
    h.events.some(e => e.type === 'playback.clear' && e.reason === 'memory_recall_interrupt'),
    'must clear client playback when interrupting with recalled memory',
  )
  assert.ok(
    h.logs.some(entry => entry.level === 'warn' && entry.event === 'memory_hooks.sync_recall_interrupted_response'),
    'must log warning when interrupting cloud reply with memory',
  )

  // Turn 2: searchHandler returns empty -> do NOT interrupt the cloud's ongoing response
  voiceTurn(f, 'item-si2', '谢谢')
  await until(() => callCount === 2)
  const cancelsBeforeTurn2 = f.cancels
  pending2.resolve('')
  await tick()
  assert.equal(f.cancels, cancelsBeforeTurn2, 'empty recall must not interrupt ongoing response')
  assert.equal(f.contextResponses.length, 1)
})

test('syncRecall for manual text input injects recalled memory before sending user input without double querying', async t => {
  const pending = Promise.withResolvers()
  const queries = []
  const h = createHarness(t, {
    memorySyncRecall: true,
    deferAutomaticResponse: false,
    memorySearchHandler(transcript) {
      queries.push(transcript)
      return pending.promise
    },
  })
  const f = await h.connect()

  h.send({ type: Input.TEXT_MESSAGE, text: '帮我选家酒店' })
  await until(() => queries.length === 1)
  await tick()
  assert.equal(f.inputs.length, 0, 'manual input must wait for sync recall before sendUserInput')

  pending.resolve('偏好安静高楼层无烟房')
  await until(() => f.inputs.length === 1)
  assert.equal(queries.length, 1, 'must not query twice for the same manual turn')
  assert.equal(f.contextItems.length, 1)
  assert.match(f.contextItems[0], /偏好安静高楼层无烟房/)
  assert.equal(f.inputs[0].parts[0].text, '帮我选家酒店')
})

test('real RealtimeFrontend appendUserContextAndRespond interrupts active response then sends item + response.create', async () => {
  const sent = []
  const provider = {
    key: 'test-sync-wire',
    label: 'Test Sync Wire',
    model: () => 'test-model',
    voice: () => 'default',
    inputSampleRate: 16000,
    outputSampleRate: 24000,
    protocol: openAiCompatibleProtocol,
    capabilities: {
      singleResponseSlot: true,
      conversationItems: true,
      acknowledgesConversationItems: false,
      clientResponses: true,
    },
    isConfigured: () => true,
    url: () => 'ws://localhost:1',
    headers: () => ({}),
    classifyError: () => 'other',
    buildSession: () => ({ instructions: 'test' }),
    buildSpeakResponse: text => ({ instructions: text }),
    buildResultInjection: text => ({ item: openAiCompatibleProtocol.userTextItem(text), response: {} }),
    buildPermissionInjection: () => ({ item: openAiCompatibleProtocol.userTextItem('perm'), response: {} }),
  }
  const frontend = new RealtimeFrontend({ provider, responseCancelGraceMs: 500 })
  frontend.ready = true
  frontend.sessionConfigured = true
  frontend.ws = {
    readyState: 1,
    bufferedAmount: 0,
    send(raw) { sent.push(JSON.parse(raw)) },
  }

  // Active automatic response running
  frontend.handleProviderEvent({ type: 'response.created', response: { id: 'resp-auto-wire' } })

  const respondPromise = frontend.appendUserContextAndRespond(
    '<recalled_memory>\n同步记忆\n</recalled_memory>',
    { turnId: 't1', turnGeneration: 1 },
    { interrupt: true, shouldRespond: () => true },
  )
  await tick()
  assert.equal(sent.some(m => m.type === 'response.cancel'), true, 'must cancel active cloud response first')
  assert.equal(sent.some(m => m.type === 'conversation.item.create'), false, 'waits until cancelled response settles')

  // Cloud confirms cancellation -> item + new response.create go out in order
  frontend.handleProviderEvent({ type: 'response.done', response: { id: 'resp-auto-wire', status: 'cancelled' } })
  await until(() => sent.some(m => m.type === 'response.create'))

  const types = sent.map(m => m.type)
  assert.deepEqual(types, ['response.cancel', 'conversation.item.create', 'response.create'])
  assert.equal(sent[1].item.content[0].text, '<recalled_memory>\n同步记忆\n</recalled_memory>')

  // Complete the replacement response so respondPromise settles cleanly
  frontend.handleProviderEvent({ type: 'response.created', response: { id: 'resp-mem-wire' } })
  frontend.handleProviderEvent({ type: 'response.done', response: { id: 'resp-mem-wire', status: 'completed' } })
  const outcome = await respondPromise
  assert.equal(outcome.completed, true)
})

test('presessionHandler receives session metadata and injects returned text into the USER/MEMORY instructions slot before connect', async t => {
  const receivedMetadata = []
  const h = createHarness(t, {
    ownerId: 'owner-pre',
    sessionId: 'session-pre',
    async memoryPresessionHandler(metadata) {
      receivedMetadata.push(metadata)
      return '<user_profile>\n用户是后端工程师，偏好直接给结论\n</user_profile>'
    },
  })
  h.runtime.start()
  h.send({
    type: Input.CONNECT,
    inputEnabled: true,
    outputEnabled: true,
    timeZone: 'Asia/Shanghai',
    locale: 'zh-CN',
    workingDirectory: '/repo/demo',
  }, {
    descriptor: { type: 'desktop', label: 'Desktop', instanceId: 'd1' },
    capabilitiesNegotiated: true,
    capabilities: ['input.audio', 'input.text'],
  })
  await until(() => h.runtime.status().state === 'connected')

  assert.equal(receivedMetadata.length, 1)
  assert.equal(receivedMetadata[0].ownerId, 'owner-pre')
  assert.equal(receivedMetadata[0].sessionId, 'session-pre')
  assert.equal(receivedMetadata[0].provider, 'test')
  assert.equal(receivedMetadata[0].descriptor.type, 'desktop')
  assert.equal(receivedMetadata[0].client.timeZone, 'Asia/Shanghai')
  assert.equal(receivedMetadata[0].client.locale, 'zh-CN')
  assert.equal(receivedMetadata[0].client.workingDirectory, '/repo/demo')
  assert.equal(receivedMetadata[0].inputEnabled, true)
  assert.equal(receivedMetadata[0].outputEnabled, true)
  assert.equal(receivedMetadata[0].textOnly, false)

  const initialContext = h.frontends[0].initialContext
  assert.equal(
    initialContext.presessionMemoryContext,
    '<user_profile>\n用户是后端工程师，偏好直接给结论\n</user_profile>',
  )
  const instructions = buildFrontendInstructions(initialContext)
  const profileCloseIndex = instructions.indexOf('</assistant_profile>')
  const presessionIndex = instructions.indexOf('<user_profile>\n用户是后端工程师，偏好直接给结论\n</user_profile>')
  const clientContextIndex = instructions.indexOf('Asia/Shanghai')
  assert.ok(profileCloseIndex >= 0 && presessionIndex > profileCloseIndex, 'must appear after </assistant_profile>')
  assert.ok(clientContextIndex > presessionIndex, 'must appear before frontend client context (exact USER.md/MEMORY.md slot)')
})

test('presessionHandler failure logs warning without blocking session connect', async t => {
  const h = createHarness(t, {
    async memoryPresessionHandler() {
      throw new Error('profile store unavailable')
    },
  })
  const f = await h.connect()
  assert.equal(f.ready, true)
  assert.equal(f.initialContext.presessionMemoryContext, undefined)
  assert.ok(h.logs.some(entry => entry.level === 'warn' && entry.event === 'memory_hooks.presession_failed'))
})
