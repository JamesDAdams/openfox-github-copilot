import type {
  ProviderTransportAdapter,
  ProviderRequestContext,
  ProviderAccessContext,
  ModelConfig,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMStreamEvent,
  ToolCall,
  LLMMessage,
  LLMToolDefinition,
} from 'openfox/provider'
import { GitHubCopilotAuthAdapter } from '../auth/github-browser-auth.js'
import { getDefaultModels } from '../catalog/models-default.js'

const GITHUB_CATALOG_API = 'https://models.github.ai/catalog/models'

const LOOKAROUND_RE = /\(\?[=!]|\(\?<[=!]/

function isAuthHttpError(error: string): boolean {
  if (/ \(40[13]\):/.test(error)) return true
  if (!/ \(400\):/.test(error)) return false
  const body = error.replace(/^GitHub Copilot API error \(400\): /, '')
  return /token|auth|credential|unauthorized|forbidden|expired/i.test(body)
}

function signalMerge(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const valid = signals.filter(Boolean) as AbortSignal[]
  if (valid.length === 0) return new AbortController().signal
  if (valid.length === 1) return valid[0]
  if (typeof AbortSignal.any !== 'undefined') return AbortSignal.any(valid)
  const controller = new AbortController()
  for (const s of valid) {
    if (s.aborted) { controller.abort(s.reason); break }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true })
  }
  return controller.signal
}

function sanitizeSchema(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sanitizeSchema)
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (k === 'pattern' && typeof v === 'string' && LOOKAROUND_RE.test(v)) continue
      result[k] = sanitizeSchema(v)
    }
    return result
  }
  return obj
}

function mergeModels(defaults: ModelConfig[], apiModels: ModelConfig[]): ModelConfig[] {
  const seen = new Set<string>()
  const merged: ModelConfig[] = []

  for (const m of apiModels) {
    seen.add(m.id)
    merged.push(m)
  }

  for (const m of defaults) {
    if (!seen.has(m.id)) merged.push(m)
  }

  return merged
}

export class GitHubCopilotTransportAdapter implements ProviderTransportAdapter {
  readonly id = 'github-copilot-transport'

  constructor(private readonly auth: GitHubCopilotAuthAdapter) {}

  private async fetchGitHubCatalog(credentialRef: string): Promise<ModelConfig[]> {
    try {
      const oauthToken = await this.auth.getOAuthToken(credentialRef)
      const res = await fetch(GITHUB_CATALOG_API, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${oauthToken}`,
          'X-GitHub-Api-Version': '2026-03-10',
          'User-Agent': 'OpenFox',
        },
        signal: AbortSignal.timeout(5000),
      })

      if (!res.ok) return []

      const data = await res.json() as Array<{
        id: string
        name?: string
        limits?: { max_input_tokens?: number }
        capabilities?: string[]
      }>

      if (!Array.isArray(data)) return []

      return data.map((m) => ({
        id: m.id.includes('/') ? m.id.slice(m.id.indexOf('/') + 1) : m.id,
        name: m.name ?? m.id,
        contextWindow: m.limits?.max_input_tokens ?? 200000,
        source: 'backend' as const,
        requestBody: { endpoint: '/chat/completions' },
      }))
    } catch {
      return []
    }
  }

  async listModels(context: ProviderRequestContext): Promise<ModelConfig[]> {
    const defaults = getDefaultModels()

    if (!context.credentialRef) return defaults

    let access: ProviderAccessContext
    try {
      access = await this.auth.getAccessContext(context.credentialRef)
    } catch {
      return defaults
    }

    const copilotModels = await this.fetchCopilotModels(access.headers ?? {})

    if (copilotModels.length > 0) {
      return mergeModels(defaults, copilotModels)
    }

    const catalog = await this.fetchGitHubCatalog(context.credentialRef)
    if (catalog.length > 0) {
      return mergeModels(defaults, catalog)
    }

    return defaults
  }

  private async fetchCopilotModels(headers: Record<string, string>): Promise<ModelConfig[]> {
    this.modelEndpoints.clear()
    try {
      const res = await fetch('https://api.githubcopilot.com/models', {
        headers: { ...headers },
        signal: AbortSignal.timeout(5000),
      })

      if (!res.ok) return []

      const data = await res.json() as {
        data?: Array<{
          id: string
          name?: string
          capabilities?: {
            type?: string
            limits?: { max_prompt_tokens?: number; max_context_window_tokens?: number }
          }
          supported_endpoints?: string[]
        }>
      }

      if (!data.data || !Array.isArray(data.data)) return []

      const models: ModelConfig[] = []
      for (const m of data.data) {
        if (m.capabilities?.type !== 'chat') continue
        const endpoints = m.supported_endpoints ?? []
        const hasChat = endpoints.includes('/chat/completions')
        const hasResponses = endpoints.includes('/responses')
        if (!hasChat && !hasResponses) continue

        if (!hasChat && hasResponses) {
          this.modelEndpoints.set(m.id, '/responses')
        }

        const mc: ModelConfig = {
          id: m.id,
          name: m.name || m.id,
          contextWindow: m.capabilities?.limits?.max_prompt_tokens
            ?? m.capabilities?.limits?.max_context_window_tokens
            ?? 128000,
          source: 'backend',
        }
        if (!hasChat && hasResponses) {
          mc.requestBody = { endpoint: '/responses' }
        }
        models.push(mc)
      }
      return models
    } catch {
      return []
    }
  }

  async complete(request: LLMCompletionRequest, context: ProviderRequestContext): Promise<LLMCompletionResponse> {
    let result: LLMCompletionResponse | undefined
    for await (const event of this.stream(request, context)) {
      if (event.type === 'done') result = event.response
      if (event.type === 'error') throw new Error(event.error)
    }
    if (!result) throw new Error('Copilot response completed without a final response')
    return result
  }

  async *stream(request: LLMCompletionRequest, context: ProviderRequestContext): AsyncIterable<LLMStreamEvent> {
    if (!context.credentialRef) {
      yield { type: 'error', error: 'GitHub Copilot account is not connected' }
      return
    }

    const model = context.model || 'gpt-5-mini'
    const endpoint = this.getModelEndpoint(model)

    for (let attempt = 1; attempt <= 2; attempt++) {
      const retrySignal = new AbortController()
      const combined = signalMerge(retrySignal.signal, request.signal)

      let access: ProviderAccessContext
      try {
        access = await this.auth.getAccessContext(context.credentialRef)
      } catch {
        if (attempt === 2) {
          yield { type: 'error', error: 'Failed to authenticate with GitHub Copilot' }
          return
        }
        try {
          await this.auth.refreshCopilotToken(context.credentialRef)
        } catch {
          yield { type: 'error', error: 'Failed to refresh GitHub Copilot token' }
          return
        }
        continue
      }

      const streamGen = endpoint === '/responses'
        ? this.streamResponses(request, access, model)
        : this.streamChatCompletions(request, access, model, combined)

      let shouldRetry = false
      try {
        for await (const event of streamGen) {
          if (attempt === 1 && event.type === 'error' && isAuthHttpError(event.error)) {
            shouldRetry = true
            retrySignal.abort()
            try {
              await this.auth.refreshCopilotToken(context.credentialRef)
            } catch {
              yield { type: 'error', error: 'Failed to refresh GitHub Copilot token' }
              return
            }
            break
          }
          yield event
        }
      } catch (error: any) {
        if (request.signal?.aborted) {
          yield { type: 'error', error: 'Request aborted' }
          return
        }
        yield { type: 'error', error: error.message || String(error) }
        return
      }
      if (!shouldRetry) return
    }
  }

  private getModelEndpoint(modelId: string): string {
    const defaults = getDefaultModels()
    const m = defaults.find(d => d.id === modelId)
    if (m?.requestBody?.endpoint === '/responses') return '/responses'
    const known = this.modelEndpoints.get(modelId)
    if (known === '/responses') return '/responses'
    return '/chat/completions'
  }

  private readonly modelEndpoints = new Map<string, string>()

  private async *streamChatCompletions(
    request: LLMCompletionRequest,
    access: ProviderAccessContext,
    model: string,
    signal?: AbortSignal,
  ): AsyncIterable<LLMStreamEvent> {
    const convertMessage = (m: LLMMessage) => {
      const base: Record<string, unknown> = {
        role: m.role,
        content: m.content === '' ? null : m.content,
      }
      if (m.role === 'assistant' && m.toolCalls?.length) {
        base.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        }))
      }
      if (m.role === 'tool' && m.toolCallId) {
        base.tool_call_id = m.toolCallId
      }
      if (m.name) base.name = m.name
      return base
    }

    const body: Record<string, unknown> = {
      model,
      messages: request.messages.map(convertMessage),
      stream: true,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
    }
    if (request.tools?.length) {
      body.tools = request.tools.map((t: LLMToolDefinition) => ({
        type: 'function',
        function: {
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        },
      }))
    }
    if (request.toolChoice) body.tool_choice = request.toolChoice
    if (request.reasoningEffort) body.reasoning_effort = request.reasoningEffort

    const res = await fetch('https://api.githubcopilot.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...access.headers,
      },
      body: JSON.stringify(body),
      signal,
    })

    if (!res.ok) {
      const errorDetail = await res.text()
      yield { type: 'error', error: `GitHub Copilot API error (${res.status}): ${errorDetail}` }
      return
    }

    if (!res.body) {
      yield { type: 'error', error: 'Response body is empty' }
      return
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    let fullContent = ''
    let fullThinking = ''
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>()
    let finishReason: LLMCompletionResponse['finishReason'] = 'stop'
    let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
    let responseId = 'copilot-response-' + crypto.randomUUID()

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          if (buffer.trim()) {
            buffer = buffer.trim()
            if (buffer.startsWith('data: ')) {
              const dataStr = buffer.slice(6)
              if (dataStr !== '[DONE]') {
                try {
                  const parsed = JSON.parse(dataStr) as {
                    id?: string
                    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
                    choices?: Array<{
                      finish_reason?: string | null
                      delta?: {
                        content?: string | null
                        reasoning_content?: string | null
                        tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>
                      }
                    }>
                  }
                  if (parsed.id) responseId = parsed.id
                  if (parsed.usage) {
                    usage = { promptTokens: parsed.usage.prompt_tokens ?? 0, completionTokens: parsed.usage.completion_tokens ?? 0, totalTokens: parsed.usage.total_tokens ?? 0 }
                  }
                  const choice = parsed.choices?.[0]
                  if (choice?.finish_reason) {
                    switch (choice.finish_reason) {
                      case 'stop': finishReason = 'stop'; break
                      case 'tool_calls': finishReason = 'tool_calls'; break
                      case 'length': finishReason = 'length'; break
                      case 'content_filter': finishReason = 'content_filter'; break
                    }
                  }
                  const delta = choice?.delta as any
                  if (delta) {
                    const thinking = delta.reasoning_content || delta.reasoning || delta.thinking
                    if (thinking) { fullThinking += thinking; yield { type: 'thinking_delta', content: thinking } }
                    if (delta.content) { fullContent += delta.content; yield { type: 'text_delta', content: delta.content } }
                    if (delta.tool_calls) {
                      for (const tc of delta.tool_calls) {
                        const existing = toolCalls.get(tc.index)
                        if (!existing) {
                          toolCalls.set(tc.index, { id: tc.id ?? '', name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '' })
                        } else {
                          if (tc.id) existing.id = tc.id
                          if (tc.function?.name) existing.name += tc.function.name
                          if (tc.function?.arguments) existing.arguments += tc.function.arguments
                        }
                        yield { type: 'tool_call_delta', index: tc.index, ...(tc.id ? { id: tc.id } : {}), ...(tc.function?.name ? { name: tc.function.name } : {}), ...(tc.function?.arguments ? { arguments: tc.function.arguments } : {}) }
                      }
                    }
                  }
                } catch {}
              }
            }
          }
          break
        }

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const cleaned = line.trim()
          if (!cleaned) continue
          if (cleaned === 'data: [DONE]') continue

          if (cleaned.startsWith('data: ')) {
            const dataStr = cleaned.slice(6)
            try {
              const parsed = JSON.parse(dataStr) as {
                id?: string
                usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
                choices?: Array<{
                  finish_reason?: string | null
                  delta?: {
                    content?: string | null
                    reasoning_content?: string | null
                    reasoning?: string | null
                    thinking?: string | null
                    tool_calls?: Array<{
                      index: number
                      id?: string
                      function?: { name?: string; arguments?: string }
                    }>
                  }
                }>
              }

              if (parsed.id) responseId = parsed.id
              if (parsed.usage) {
                usage = {
                  promptTokens: parsed.usage.prompt_tokens ?? 0,
                  completionTokens: parsed.usage.completion_tokens ?? 0,
                  totalTokens: parsed.usage.total_tokens ?? 0,
                }
              }

              const choice = parsed.choices?.[0]
              if (!choice) continue

              if (choice.finish_reason) {
                switch (choice.finish_reason) {
                  case 'stop': finishReason = 'stop'; break
                  case 'tool_calls': finishReason = 'tool_calls'; break
                  case 'length': finishReason = 'length'; break
                  case 'content_filter': finishReason = 'content_filter'; break
                }
              }

              const delta = choice.delta
              if (!delta) continue

              const thinking = delta.reasoning_content || delta.reasoning || delta.thinking
              if (thinking) {
                fullThinking += thinking
                yield { type: 'thinking_delta', content: thinking }
              }

              if (delta.content) {
                fullContent += delta.content
                yield { type: 'text_delta', content: delta.content }
              }

              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const existing = toolCalls.get(tc.index)
                  if (!existing) {
                    toolCalls.set(tc.index, {
                      id: tc.id ?? '',
                      name: tc.function?.name ?? '',
                      arguments: tc.function?.arguments ?? '',
                    })
                  } else {
                    if (tc.id) existing.id = tc.id
                    if (tc.function?.name) existing.name += tc.function.name
                    if (tc.function?.arguments) existing.arguments += tc.function.arguments
                  }

                  yield {
                    type: 'tool_call_delta',
                    index: tc.index,
                    ...(tc.id ? { id: tc.id } : {}),
                    ...(tc.function?.name ? { name: tc.function.name } : {}),
                    ...(tc.function?.arguments ? { arguments: tc.function.arguments } : {}),
                  }
                }
              }
            } catch {
              // Ignore parse errors on incomplete JSON chunks
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    const parsedToolCalls: ToolCall[] = []
    for (const [, tc] of toolCalls) {
      try {
        parsedToolCalls.push({
          id: tc.id,
          name: tc.name,
          arguments: JSON.parse(tc.arguments) as Record<string, unknown>,
        })
      } catch (error) {
        parsedToolCalls.push({
          id: tc.id,
          name: tc.name,
          arguments: {},
          parseError: error instanceof Error ? error.message : 'Unknown JSON parse error',
          rawArguments: tc.arguments,
        })
      }
    }

    yield {
      type: 'done',
      response: {
        id: responseId,
        content: fullContent,
        ...(fullThinking && { thinkingContent: fullThinking }),
        ...(parsedToolCalls.length > 0 && { toolCalls: parsedToolCalls }),
        finishReason,
        usage,
      },
    }
  }

  private async *streamResponses(
    request: LLMCompletionRequest,
    access: ProviderAccessContext,
    model: string,
  ): AsyncIterable<LLMStreamEvent> {
    const input: any[] = []
    for (const m of request.messages) {
      if (m.role === 'assistant' && !m.content && m.toolCalls?.length) continue
      if (m.role === 'tool') {
        input.push({ role: 'user', content: `[Tool result for ${(m.toolCallId || '').slice(0, 64)}]: ${m.content || ''}` })
      } else {
        const msg: any = { role: m.role, content: m.content === '' ? '' : m.content }
        if (m.name) msg.name = m.name
        input.push(msg)
      }
    }

    const body: Record<string, unknown> = {
      model,
      input,
      max_output_tokens: request.maxTokens ?? 100000,
      stream: true,
    }
    if (request.temperature !== undefined) body.temperature = request.temperature
    if (request.tools?.length) {
      body.tools = request.tools.map((t: LLMToolDefinition) => ({
        type: 'function',
        name: t.function.name,
        description: t.function.description,
        parameters: sanitizeSchema(t.function.parameters),
      }))
    }
    if (request.toolChoice) body.tool_choice = request.toolChoice
    if (request.reasoningEffort) body.reasoning_effort = request.reasoningEffort

    const res = await fetch('https://api.githubcopilot.com/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...access.headers,
      },
      body: JSON.stringify(body),
      signal: request.signal,
    })

    if (!res.ok) {
      const errorDetail = await res.text()
      yield { type: 'error', error: `GitHub Copilot API error (${res.status}): ${errorDetail}` }
      return
    }

    if (!res.body) {
      yield { type: 'error', error: 'Response body is empty' }
      return
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    let fullContent = ''
    let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
    let responseId = 'copilot-response-' + crypto.randomUUID()
    const toolCalls = new Map<string, { id: string; name: string; arguments: string }>()
    let pendingToolId = ''
    let pendingToolName = ''
    let pendingToolArgs = ''
    let toolCallIdx = 0
    let currentEvent = ''
    let currentData = ''

    type EventResult = { delta?: string; toolDelta?: LLMStreamEvent; id?: string; pendingState?: { id: string; name: string; args: string; idx: number }; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }

    const flushEvents = (): EventResult[] => {
      if (!currentEvent && !currentData) return []
      const ev = this.processResponsesEvent(currentEvent, currentData, fullContent, toolCalls, { pendingToolId, pendingToolName, pendingToolArgs, toolCallIdx })
      if (!ev) return []
      return [ev]
    }

    const applyResults = function*(events: EventResult[]) {
      for (const ev of events) {
        if (ev?.delta) { fullContent += ev.delta; yield { type: 'text_delta', content: ev.delta } }
        if (ev?.toolDelta) yield ev.toolDelta as any
        if (ev?.id) responseId = ev.id
        if (ev?.pendingState) { pendingToolId = ev.pendingState.id; pendingToolName = ev.pendingState.name; pendingToolArgs = ev.pendingState.args; toolCallIdx = ev.pendingState.idx }
        if (ev?.usage) { usage = ev.usage }
      }
    }

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          if (buffer.trim()) {
            const remaining = buffer.trimEnd()
            if (remaining.startsWith('event: ')) {
              currentEvent = remaining.slice(7)
              currentData = ''
            } else if (remaining.startsWith('data: ')) {
              currentData += remaining.slice(6)
            }
          }
          yield* applyResults(flushEvents())
          break
        }

        buffer += decoder.decode(value, { stream: true })

        let idx
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trimEnd()
          buffer = buffer.slice(idx + 1)

          if (line.startsWith('event: ')) {
            yield* applyResults(flushEvents())
            currentEvent = line.slice(7)
            currentData = ''
          } else if (line.startsWith('data: ')) {
            currentData += line.slice(6)
          } else if (line === '') {
            yield* applyResults(flushEvents())
            currentEvent = ''
            currentData = ''
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    const parsedToolCalls: ToolCall[] = []
    for (const [, tc] of toolCalls) {
      try {
        parsedToolCalls.push({
          id: tc.id,
          name: tc.name,
          arguments: JSON.parse(tc.arguments) as Record<string, unknown>,
        })
      } catch (error) {
        parsedToolCalls.push({
          id: tc.id,
          name: tc.name,
          arguments: {},
          parseError: error instanceof Error ? error.message : 'Unknown JSON parse error',
          rawArguments: tc.arguments,
        })
      }
    }

    yield {
      type: 'done',
      response: {
        id: responseId,
        content: fullContent,
        ...(parsedToolCalls.length > 0 && { toolCalls: parsedToolCalls }),
        finishReason: parsedToolCalls.length > 0 ? 'tool_calls' : 'stop',
        usage,
      },
    }
  }

  private processResponsesEvent(
    event: string, data: string,
    fullContent: string,
    toolCalls: Map<string, { id: string; name: string; arguments: string }>,
    pending: { pendingToolId: string; pendingToolName: string; pendingToolArgs: string; toolCallIdx: number },
  ): { delta?: string; toolDelta?: LLMStreamEvent; id?: string; pendingState?: { id: string; name: string; args: string; idx: number }; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } } | null {
    if (!event || !data) return null
    try {
      const d = JSON.parse(data)
      if (event === 'response.created') {
        if (d.response?.id) return { id: d.response.id }
      } else if (event === 'response.output_text.delta') {
        if (d.delta && typeof d.delta === 'string') return { delta: d.delta }
      } else if (event === 'response.output_item.added') {
        const item = d.item || {}
        if (item.type === 'function_call') {
          const id = item.id || `tc-${pending.toolCallIdx}`
          const name = item.name || ''
          return { pendingState: { id, name, args: '', idx: pending.toolCallIdx } }
        }
      } else if (event === 'response.function_call_arguments.delta') {
        if (d.delta) {
          return {
            toolDelta: { type: 'tool_call_delta' as const, index: pending.toolCallIdx, arguments: d.delta },
            pendingState: { id: pending.pendingToolId, name: pending.pendingToolName, args: pending.pendingToolArgs + d.delta, idx: pending.toolCallIdx },
          }
        }
      } else if (event === 'response.output_item.done') {
        const item = d.item || {}
        if (item.type === 'function_call') {
          const id = item.id || pending.pendingToolId
          toolCalls.set(id, { id, name: item.name || pending.pendingToolName, arguments: item.arguments || pending.pendingToolArgs })
          return { pendingState: { id: '', name: '', args: '', idx: pending.toolCallIdx + 1 } }
        }
      } else if (event === 'response.completed') {
        const resp = d.response || d
        const ud = resp.usage || d.copilot_usage || {}
        let usageUpdate: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined
        if (ud.input_tokens !== undefined) {
          const pt = ud.input_tokens
          const ct = ud.output_tokens ?? 0
          usageUpdate = { promptTokens: pt, completionTokens: ct, totalTokens: pt + ct }
        } else if (ud.token_details) {
          const tokens = ud.token_details || []
          let pt = 0; let ct = 0
          for (const t of tokens) {
            if (t.token_type === 'input' || t.token_type === 'prompt') pt += t.token_count || 0
            if (t.token_type === 'output' || t.token_type === 'completion') ct += t.token_count || 0
          }
          usageUpdate = { promptTokens: pt, completionTokens: ct, totalTokens: pt + ct }
        }
        if (!fullContent && resp.output && Array.isArray(resp.output)) {
          const texts: string[] = []
          for (const item of resp.output) {
            if (item.content && Array.isArray(item.content)) {
              for (const c of item.content) {
                if (c.type === 'output_text' && c.text) texts.push(c.text)
              }
            }
          }
          if (texts.length > 0) return { delta: texts.join(''), ...(usageUpdate && { usage: usageUpdate }) }
        }
        if (usageUpdate) return { usage: usageUpdate }
      }
    } catch {}
    return null
  }
}
