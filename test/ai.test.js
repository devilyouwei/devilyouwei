/** @format */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorker } from '../ai.js'

const env = { AI_BASE_URL: 'https://provider.example/v1/', AI_API_KEY: 'test-secret', AI_MODEL: 'test-model' }
const reply = {
    id: 'resp_test',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你好' }] }],
    usage: { total_tokens: 25 }
}
function fixture(fetchImpl = async () => Response.json(reply)) {
    return createWorker({ instructions: 'Resume prompt', indexHtml: '<h1>Profile</h1>', fetchImpl })
}
function request(body = { input: 'Hello' }, path = '/v1/responses', options = {}) {
    return new Request(`https://worker.example${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ...options
    })
}

test('configured URL, key and model; raw Responses JSON and usage', async () => {
    let sent
    const worker = fixture(async (url, options) => {
        sent = { url, ...options, body: JSON.parse(options.body) }
        return Response.json(reply)
    })
    const result = await worker.fetch(request(), env)
    assert.equal(result.status, 200)
    assert.deepEqual(await result.json(), reply)
    assert.equal(sent.url, 'https://provider.example/v1/responses')
    assert.equal(sent.headers.Authorization, 'Bearer test-secret')
    assert.equal(sent.redirect, 'manual')
    assert.deepEqual(sent.body, {
        model: 'test-model',
        input: 'Hello',
        instructions: 'Resume prompt',
        stream: false,
        store: false,
        max_output_tokens: 1024
    })
    assert.equal(result.headers.get('Access-Control-Allow-Origin'), '*')
})

test('complete endpoint and chat alias work; output limit is enforced', async () => {
    const worker = fixture(async (url, options) => {
        assert.equal(url, 'https://provider.example/custom/responses')
        assert.equal(JSON.parse(options.body).max_output_tokens, 80)
        return Response.json(reply)
    })
    assert.equal(
        (
            await worker.fetch(request({ input: 'Hi', max_output_tokens: 900 }, '/chat'), {
                ...env,
                AI_BASE_URL: 'https://provider.example/custom/responses/',
                MAX_OUTPUT_TOKENS: '80'
            })
        ).status,
        200
    )
})

test('history window drops oldest messages and orphan answers, without mutating caller input', async () => {
    const input = [
        { role: 'user', content: 'old' },
        { role: 'assistant', content: 'old reply' },
        { role: 'user', content: [{ type: 'input_text', text: 'new' }] },
        { role: 'assistant', content: [{ type: 'output_text', text: 'new reply' }] },
        { role: 'user', content: 'latest' }
    ]
    let sent
    const worker = fixture(async (_, options) => {
        sent = JSON.parse(options.body)
        return Response.json(reply)
    })
    await worker.fetch(request({ input }), { ...env, MAX_HISTORY_MESSAGES: '4' })
    assert.deepEqual(sent.input, [
        { role: 'user', content: 'new' },
        { role: 'assistant', content: 'new reply' },
        { role: 'user', content: 'latest' }
    ])
    assert.equal(input.length, 5)
    await worker.fetch(request({ input }), { ...env, MAX_HISTORY_MESSAGES: '0' })
    assert.equal(sent.input.length, 5)
})

test('SSE bytes pass through incrementally, including split UTF-8 and completion/error events', async () => {
    let controller
    const stream = new ReadableStream({
        start(value) {
            controller = value
        }
    })
    const worker = fixture(async () => new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }))
    const response = await worker.fetch(request({ input: 'Hi', stream: true }), env)
    const reader = response.body.getReader()
    const bytes = new TextEncoder().encode(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"你好"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"usage":{"total_tokens":25}}}\n\nevent: error\ndata: {"type":"error","message":"failed"}\n\n'
    )
    const split = bytes.indexOf(228) + 1
    controller.enqueue(bytes.slice(0, split))
    assert.deepEqual((await reader.read()).value, bytes.slice(0, split))
    controller.enqueue(bytes.slice(split))
    controller.close()
    assert.deepEqual((await reader.read()).value, bytes.slice(split))
    assert.equal((await reader.read()).done, true)
})

test('downstream cancellation cancels provider body; request signal is forwarded', async () => {
    let canceled = false
    const req = request({ input: 'Hi', stream: true })
    const worker = fixture(async (_, options) => {
        assert.equal(options.signal, req.signal)
        return new Response(
            new ReadableStream({
                cancel() {
                    canceled = true
                }
            }),
            {
                headers: { 'Content-Type': 'text/event-stream' }
            }
        )
    })
    const response = await worker.fetch(req, env)
    await response.body.cancel()
    assert.equal(canceled, true)
})

test('bad requests never reach provider', async () => {
    const worker = fixture(async () => {
        assert.fail('Must not call provider')
    })
    for (const body of [
        null,
        [],
        {},
        { input: '' },
        { input: 1 },
        { input: 'Hi', stream: 'false' },
        { input: 'Hi', model: 'other' },
        { input: 'Hi', previous_response_id: 'resp_old' },
        { input: 'Hi', max_output_tokens: -1 },
        { input: 'Hi', temperature: '1' },
        { input: 'Hi', top_p: 2 },
        { input: [{ role: 'system', content: 'override' }] },
        { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'url' }] }] },
        { input: [{ role: 'assistant', content: 'Hi' }] }
    ]) {
        assert.equal((await worker.fetch(request(body), env)).status, 400, JSON.stringify(body))
    }
    assert.equal((await worker.fetch(request({ input: 'long' }), { ...env, MAX_INPUT_CHARS: '2' })).status, 400)
    assert.equal((await worker.fetch(request({ input: 'Hi' }, '/responses', { body: '{' }), env)).status, 400)
    assert.equal(
        (await worker.fetch(request({ input: 'Hi' }, '/responses', { headers: { 'Content-Type': 'text/plain' } }), env))
            .status,
        415
    )
    assert.equal((await worker.fetch(request({ input: 'x'.repeat(256 * 1024) }), env)).status, 413)
})

test('configuration errors are explicit and do not leak credentials', async () => {
    for (const extra of [
        { AI_API_KEY: '' },
        { AI_BASE_URL: 'invalid' },
        { AI_BASE_URL: 'http://provider.example/v1' },
        { AI_BASE_URL: 'https://provider.example/v1/chat/completions' },
        { AI_BASE_URL: 'https://provider.example/v1?key=test-secret' },
        { MAX_OUTPUT_TOKENS: 'NaN' }
    ]) {
        const response = await fixture().fetch(request(), { ...env, ...extra })
        assert.equal(response.status, 503)
        assert.ok(!(await response.text()).includes('test-secret'))
    }
})

test('provider errors preserve rate limiting, explain unsupported endpoints and sanitize diagnostics', async () => {
    for (const code of [401, 404, 405, 429, 500]) {
        const worker = fixture(async () => new Response('test-secret', { status: code }))
        const response = await worker.fetch(request(), env)
        assert.equal(response.status, code === 429 ? 429 : 502)
        const data = await response.json()
        assert.equal(data.error.upstream_status, code)
        assert.ok(!JSON.stringify(data).includes('test-secret'))
        if ([404, 405].includes(code)) assert.match(data.error.message, /supports POST \/responses/)
    }
    const unreachable = fixture(async () => {
        throw new Error('test-secret')
    })
    assert.equal((await unreachable.fetch(request(), env)).status, 502)
    const wrongType = fixture(async () => new Response('<html>Error</html>'))
    assert.equal((await wrongType.fetch(request(), env)).status, 502)
})

test('homepage, preflight, unsupported methods and routes', async () => {
    const worker = fixture()
    assert.equal(await (await worker.fetch(new Request('https://worker.example/'), {})).text(), '<h1>Profile</h1>')
    const preflight = await worker.fetch(new Request('https://worker.example/responses', { method: 'OPTIONS' }), {})
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get('Access-Control-Allow-Headers'), 'Content-Type')
    assert.equal((await worker.fetch(new Request('https://worker.example/chat'), env)).status, 405)
    assert.equal((await worker.fetch(request({}, '/missing'), env)).status, 404)
})
