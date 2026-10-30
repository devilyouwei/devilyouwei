/** @format */

export function chatPayload(data) {
    const input = typeof data.input === 'string' ? [{ role: 'user', content: data.input }] : data.input
    const result = {
        model: data.model,
        messages: [{ role: 'system', content: data.instructions }, ...input],
        stream: data.stream,
        max_tokens: data.max_output_tokens
    }
    for (const name of ['temperature', 'top_p']) if (data[name] !== undefined) result[name] = data[name]
    return result
}

function usage(value) {
    if (!value) return null
    return {
        input_tokens: value.prompt_tokens,
        input_tokens_details: { cached_tokens: value.prompt_tokens_details?.cached_tokens ?? 0 },
        output_tokens: value.completion_tokens,
        output_tokens_details: { reasoning_tokens: value.completion_tokens_details?.reasoning_tokens ?? 0 },
        total_tokens: value.total_tokens
    }
}

function responseState(model) {
    return {
        id: `resp_${crypto.randomUUID()}`,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        model,
        status: 'in_progress',
        output: [],
        usage: null,
        error: null,
        incomplete_details: null
    }
}
function messageState() {
    return { id: `msg_${crypto.randomUUID()}`, type: 'message', role: 'assistant', status: 'in_progress', content: [] }
}
const part = text => ({ type: 'output_text', text, annotations: [] })
function finish(response, message, text, reason) {
    if (!['stop', 'length', 'content_filter'].includes(reason)) throw new Error('Unsupported finish reason')
    response.status = reason === 'stop' ? 'completed' : 'incomplete'
    response.incomplete_details =
        reason === 'stop' ? null : { reason: reason === 'length' ? 'max_output_tokens' : 'content_filter' }
    message.status = response.status
    message.content = [part(text)]
    response.output = [message]
    return response
}

export function chatResponse(data, model) {
    const choice = data.choices?.[0]
    if (
        data.error ||
        !choice ||
        typeof choice.message?.content !== 'string' ||
        choice.message.tool_calls?.length ||
        choice.message.refusal
    ) {
        throw new Error('Invalid text completion')
    }
    const response = responseState(model)
    response.usage = usage(data.usage)
    return finish(response, messageState(), choice.message.content, choice.finish_reason)
}

// Parse complete SSE frames, not network chunks. Decoding preserves split UTF-8.
async function* frames(reader) {
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
        const { value, done } = await reader.read()
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
        let match
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
            const frame = buffer.slice(0, match.index)
            buffer = buffer.slice(match.index + match[0].length)
            const data = frame
                .split(/\r?\n/)
                .filter(line => line.startsWith('data:'))
                .map(line => line.slice(5).replace(/^ /, ''))
                .join('\n')
            if (data) yield data
        }
        if (buffer.length > 1024 * 1024) throw new Error('Oversized SSE frame')
        if (done) {
            if (buffer.trim()) throw new Error('Truncated SSE frame')
            return
        }
    }
}

export function chatStream(body, model) {
    const reader = body.getReader()
    const response = responseState(model)
    const message = messageState()
    let canceled = false
    let sequence = 0
    const encoder = new TextEncoder()
    const event = (type, data = {}) =>
        encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`)
    async function* convert() {
        let text = ''
        let reason = null
        try {
            yield event('response.created', { response })
            yield event('response.in_progress', { response })
            yield event('response.output_item.added', { output_index: 0, item: message })
            yield event('response.content_part.added', {
                output_index: 0,
                item_id: message.id,
                content_index: 0,
                part: part('')
            })
            for await (const raw of frames(reader)) {
                if (raw === '[DONE]') break
                const chunk = JSON.parse(raw)
                if (chunk.error) throw new Error('Provider stream error')
                if (chunk.usage) response.usage = usage(chunk.usage)
                const choice = chunk.choices?.find(item => item.index === 0)
                if (!choice) continue
                if (choice.delta?.tool_calls?.length || choice.delta?.refusal) throw new Error('Unsupported output')
                const delta = choice.delta?.content
                if (delta !== undefined && delta !== null) {
                    if (typeof delta !== 'string' || reason) throw new Error('Invalid text delta')
                    text += delta
                    if (text.length > 1024 * 1024) throw new Error('Output too large')
                    if (delta)
                        yield event('response.output_text.delta', {
                            output_index: 0,
                            item_id: message.id,
                            content_index: 0,
                            delta,
                            logprobs: []
                        })
                }
                if (choice.finish_reason) reason = choice.finish_reason
            }
            finish(response, message, text, reason)
            yield event('response.output_text.done', {
                output_index: 0,
                item_id: message.id,
                content_index: 0,
                text,
                logprobs: []
            })
            yield event('response.content_part.done', {
                output_index: 0,
                item_id: message.id,
                content_index: 0,
                part: part(text)
            })
            yield event('response.output_item.done', { output_index: 0, item: message })
            yield event(`response.${response.status}`, { response })
        } catch {
            response.status = 'failed'
            response.error = {
                code: 'upstream_stream_error',
                message: 'Provider stream failed, ended prematurely or returned unsupported output'
            }
            message.status = 'incomplete'
            message.content = [part(text)]
            response.output = [message]
            if (!canceled) yield event('response.failed', { response })
        } finally {
            await reader.cancel().catch(() => {})
            reader.releaseLock()
        }
    }
    const iterator = convert()
    return new ReadableStream({
        async pull(controller) {
            const next = await iterator.next()
            if (canceled) return
            if (next.done) controller.close()
            else controller.enqueue(next.value)
        },
        async cancel() {
            canceled = true
            await reader.cancel().catch(() => {})
            await iterator.return()
        }
    })
}
