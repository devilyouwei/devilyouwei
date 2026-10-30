/** @format */

import { chatPayload, chatResponse, chatStream } from './chat-adapter.js'

class HttpError extends Error {
    constructor(status, message) {
        super(message)
        this.status = status
    }
}

function integer(value, fallback, minimum = 1) {
    const result = Number(value ?? fallback)
    if (!Number.isSafeInteger(result) || result < minimum) {
        throw new HttpError(503, 'Invalid server limit configuration')
    }
    return result
}

function config(env) {
    if (!env.AI_BASE_URL || !env.AI_API_KEY || !env.AI_MODEL) {
        throw new HttpError(503, 'Configure AI_BASE_URL, AI_API_KEY and AI_MODEL on the server')
    }
    let url
    try {
        url = new URL(env.AI_BASE_URL)
    } catch {
        throw new HttpError(503, 'AI_BASE_URL must be an HTTPS API base URL or matching endpoint')
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
        throw new HttpError(503, 'AI_BASE_URL must be HTTPS without credentials, query or fragment')
    }
    const protocol = env.AI_PROTOCOL || 'responses'
    if (!['responses', 'chat_completions'].includes(protocol)) {
        throw new HttpError(503, 'AI_PROTOCOL must be responses or chat_completions')
    }
    const endpoint = protocol === 'responses' ? '/responses' : '/chat/completions'
    const key = env.AI_API_KEY.trim()
    if (!key || /[^\x21-\x7e]/.test(key)) {
        throw new HttpError(503, 'AI_API_KEY must contain only non-whitespace ASCII characters; re-enter the key')
    }
    url.pathname = url.pathname.replace(/\/+$/, '')
    if (
        ['/chat/completions', '/responses'].some(suffix => url.pathname.endsWith(suffix)) &&
        !url.pathname.endsWith(endpoint)
    ) {
        throw new HttpError(503, 'AI_BASE_URL endpoint does not match AI_PROTOCOL')
    }
    if (!url.pathname.endsWith(endpoint)) url.pathname += endpoint
    return {
        url: url.toString(),
        key,
        protocol,
        endpoint,
        model: env.AI_MODEL,
        outputLimit: integer(env.MAX_OUTPUT_TOKENS, 1024),
        historyLimit: integer(env.MAX_HISTORY_MESSAGES, 12, 0),
        inputLimit: integer(env.MAX_INPUT_CHARS, 24000)
    }
}

function normalizeInput(input, settings) {
    if (typeof input === 'string') {
        if (!input.trim() || input.length > settings.inputLimit) {
            throw new HttpError(400, 'input must be nonempty and within MAX_INPUT_CHARS')
        }
        return input
    }
    if (!Array.isArray(input) || !input.length) {
        throw new HttpError(400, 'input must be a string or an array of text messages')
    }
    let messages = input.map(message => {
        if (
            !message ||
            !['user', 'assistant'].includes(message.role) ||
            (message.type !== undefined && message.type !== 'message')
        ) {
            throw new HttpError(400, 'Only user and assistant text messages are supported')
        }
        let content = message.content
        if (Array.isArray(content)) {
            if (
                !content.length ||
                content.some(
                    part => !part || !['input_text', 'output_text'].includes(part.type) || typeof part.text !== 'string'
                )
            ) {
                throw new HttpError(400, 'Only input_text and output_text content is supported')
            }
            content = content.map(part => part.text).join('\n')
        }
        if (typeof content !== 'string' || !content.trim()) {
            throw new HttpError(400, 'Each message must contain nonempty text')
        }
        return { role: message.role, content }
    })
    if (settings.historyLimit && messages.length > settings.historyLimit) {
        messages = messages.slice(-settings.historyLimit)
        // A truncated conversation should start with a user, not an orphaned answer.
        while (messages[0]?.role === 'assistant') messages.shift()
    }
    if (!messages.length || messages.at(-1).role !== 'user') {
        throw new HttpError(400, 'The last input message must be from the user')
    }
    if (messages.reduce((sum, message) => sum + message.content.length, 0) > settings.inputLimit) {
        throw new HttpError(400, 'Retained input exceeds MAX_INPUT_CHARS; shorten the conversation')
    }
    return messages
}

function payload(body, settings, instructions) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Expected a JSON object')
    const allowed = new Set(['input', 'model', 'stream', 'max_output_tokens', 'temperature', 'top_p'])
    if (Object.keys(body).some(key => !allowed.has(key))) {
        throw new HttpError(400, 'Supported fields: input, model, stream, max_output_tokens, temperature, top_p')
    }
    if (body.model !== undefined && body.model !== settings.model) {
        throw new HttpError(400, 'model must match the server AI_MODEL configuration')
    }
    if (body.stream !== undefined && typeof body.stream !== 'boolean')
        throw new HttpError(400, 'stream must be boolean')
    const maxOutput = body.max_output_tokens ?? settings.outputLimit
    if (!Number.isSafeInteger(maxOutput) || maxOutput < 1)
        throw new HttpError(400, 'max_output_tokens must be a positive integer')
    const result = {
        model: settings.model,
        instructions,
        input: normalizeInput(body.input, settings),
        stream: body.stream ?? false,
        store: false,
        max_output_tokens: Math.min(maxOutput, settings.outputLimit)
    }
    for (const [name, max] of [
        ['temperature', 2],
        ['top_p', 1]
    ]) {
        if (body[name] !== undefined) {
            if (typeof body[name] !== 'number' || !Number.isFinite(body[name]) || body[name] < 0 || body[name] > max) {
                throw new HttpError(400, `${name} must be a number between 0 and ${max}`)
            }
            result[name] = body[name]
        }
    }
    return result
}

async function readJson(request) {
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
        throw new HttpError(415, 'Content-Type must be application/json')
    }
    // Bound actual bytes, including chunked requests that have no Content-Length.
    const reader = request.body?.getReader()
    if (!reader) throw new HttpError(400, 'A JSON body is required')
    const decoder = new TextDecoder()
    let size = 0
    let text = ''
    try {
        while (true) {
            const { value, done } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > 256 * 1024) {
                await reader.cancel()
                throw new HttpError(413, 'Request body exceeds 256 KiB')
            }
            text += decoder.decode(value, { stream: true })
        }
        text += decoder.decode()
        try {
            return JSON.parse(text)
        } catch {
            throw new HttpError(400, 'Invalid JSON body')
        }
    } finally {
        reader.releaseLock()
    }
}

export function createWorker({ instructions, indexHtml, fetchImpl = fetch }) {
    return {
        async fetch(request, env) {
            const headers = new Headers({
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Max-Age': '86400',
                'Cache-Control': 'no-store'
            })
            const json = (data, status) => Response.json(data, { status, headers })
            try {
                const path = new URL(request.url).pathname
                if (!['/', '/responses', '/v1/responses', '/chat'].includes(path)) throw new HttpError(404, 'Not found')
                if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
                if (path === '/' && request.method === 'GET') {
                    headers.set('Content-Type', 'text/html; charset=utf-8')
                    return new Response(indexHtml, { headers })
                }
                if (path === '/' || request.method !== 'POST') {
                    headers.set('Allow', path === '/' ? 'GET, OPTIONS' : 'POST, OPTIONS')
                    throw new HttpError(405, 'Method not allowed')
                }
                const settings = config(env)
                const data = payload(await readJson(request), settings, instructions)
                let upstream
                try {
                    upstream = await fetchImpl(settings.url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.key}` },
                        body: JSON.stringify(settings.protocol === 'chat_completions' ? chatPayload(data) : data),
                        signal: request.signal,
                        redirect: 'manual'
                    })
                } catch (error) {
                    // Classify only: never log exception text, headers, secrets or conversation input.
                    const diagnostic = /dns|resolve|ENOTFOUND/i.test(error.message)
                        ? 'dns_error'
                        : /tls|ssl|certificate/i.test(error.message)
                          ? 'tls_error'
                          : /abort/i.test(error.name)
                            ? 'request_aborted'
                            : 'connection_error'
                    console.error(
                        JSON.stringify({ event: 'upstream_fetch_failed', diagnostic, protocol: settings.protocol })
                    )
                    throw new HttpError(
                        502,
                        `Unable to reach the configured model API (${diagnostic}); check Worker logs and provider connectivity`
                    )
                }
                if (!upstream.ok) {
                    await upstream.body?.cancel()
                    // Do not expose provider diagnostics that may contain credentials or request input.
                    const hint = [404, 405].includes(upstream.status)
                        ? ` Verify that AI_BASE_URL supports POST ${settings.endpoint}.`
                        : upstream.status >= 300 && upstream.status < 400
                          ? ' Redirect refused; configure the final API URL.'
                          : ''
                    return json(
                        {
                            error: {
                                message: `Model provider returned HTTP ${upstream.status}.${hint}`,
                                type: 'upstream_error',
                                code: 'upstream_error',
                                upstream_status: upstream.status
                            }
                        },
                        upstream.status === 429 ? 429 : 502
                    )
                }
                const contentType = upstream.headers.get('content-type') || ''
                const expected = data.stream ? 'text/event-stream' : 'application/json'
                if (!upstream.body || !contentType.toLowerCase().includes(expected)) {
                    await upstream.body?.cancel()
                    throw new HttpError(502, `Model provider must return ${expected}`)
                }
                if (settings.protocol === 'chat_completions') {
                    if (data.stream) {
                        headers.set('Content-Type', 'text/event-stream; charset=utf-8')
                        return new Response(chatStream(upstream.body, settings.model), { headers })
                    }
                    try {
                        return json(chatResponse(await upstream.json(), settings.model), 200)
                    } catch {
                        throw new HttpError(502, 'Provider returned an invalid or unsupported text completion')
                    }
                }
                headers.set('Content-Type', contentType)
                // Forward the stream untouched: no chunk parsing, buffering, or UniAI wrappers.
                return new Response(upstream.body, { status: upstream.status, headers })
            } catch (error) {
                const status = error instanceof HttpError ? error.status : 500
                return json(
                    {
                        error: {
                            message: error instanceof HttpError ? error.message : 'Internal server error',
                            type: status < 500 ? 'invalid_request_error' : 'server_error',
                            code: null
                        }
                    },
                    status
                )
            }
        }
    }
}
