/** @format */
import test from 'node:test'
import assert from 'node:assert/strict'
import { chatResponse, chatStream } from '../chat-adapter.js'
import { createWorker } from '../ai.js'
const env = {
    AI_PROTOCOL: 'chat_completions',
    AI_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4',
    AI_API_KEY: 'test-key',
    AI_MODEL: 'glm-4-flash'
}
const completion = {
    choices: [{ message: { content: '你好' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 }
}
const req = () =>
    new Request('https://api.devil.ren/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: '你好', max_output_tokens: 100 })
    })
const make = fetchImpl => createWorker({ instructions: 'Profile', indexHtml: '', fetchImpl })
test('public GLM proxy maps request and response, retains server key only upstream', async () => {
    const worker = make(async (url, options) => {
        assert.equal(url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions')
        assert.equal(options.headers.Authorization, 'Bearer test-key')
        assert.deepEqual(JSON.parse(options.body), {
            model: 'glm-4-flash',
            messages: [
                { role: 'system', content: 'Profile' },
                { role: 'user', content: '你好' }
            ],
            stream: false,
            max_tokens: 100
        })
        return Response.json(completion)
    })
    const response = await worker.fetch(req(), env)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*')
    const data = await response.json()
    assert.equal(data.status, 'completed')
    assert.equal(data.output[0].content[0].text, '你好')
    assert.equal(data.usage.input_tokens, 20)
    assert.equal(data.usage.total_tokens, 22)
    assert.ok(!JSON.stringify(data).includes('test-key'))
    assert.equal(
        (await worker.fetch(req(), { ...env, AI_BASE_URL: `${env.AI_BASE_URL}/chat/completions` })).status,
        200
    )
})
function upstream(raw) {
    const bytes = new TextEncoder().encode(raw)
    let offset = 0
    return new ReadableStream({
        pull(controller) {
            if (offset < bytes.length) controller.enqueue(bytes.slice(offset, ++offset))
            else controller.close()
        }
    })
}
const frame = data => `data: ${JSON.stringify(data)}\r\n\r\n`
const chunk = (text, reason = null) => ({ choices: [{ index: 0, delta: { content: text }, finish_reason: reason }] })
async function events(raw) {
    const text = await new Response(chatStream(upstream(raw), 'glm-4-flash')).text()
    return text
        .trim()
        .split('\n\n')
        .map(frame => JSON.parse(frame.split('\n')[1].slice(6)))
}
test('one-byte UTF-8/CRLF chunks map to ordered Responses events with usage', async () => {
    const result = await events(
        ': heartbeat\r\n\r\n' +
            frame(chunk('你好')) +
            frame(chunk('', 'stop')) +
            frame({ choices: [], usage: completion.usage }) +
            'data: [DONE]\r\n\r\n'
    )
    assert.deepEqual(
        result.map(e => e.sequence_number),
        result.map((_, i) => i)
    )
    assert.equal(result.find(e => e.type === 'response.output_text.delta').delta, '你好')
    assert.equal(result.at(-1).type, 'response.completed')
    assert.equal(result.at(-1).response.usage.total_tokens, 22)
    assert.equal(result.at(-1).response.output[0].content[0].text, '你好')
})
test('length/content_filter become incomplete, malformed/truncated/tool streams fail without leaking', async () => {
    for (const reason of ['length', 'content_filter']) {
        const data = chatResponse({ choices: [{ message: { content: 'partial' }, finish_reason: reason }] }, 'model')
        assert.equal(data.status, 'incomplete')
        const result = await events(frame(chunk('partial', reason)))
        assert.equal(result.at(-1).type, 'response.incomplete')
    }
    for (const raw of [
        frame(chunk('partial')),
        'data: invalid\n\n',
        frame({ error: { message: 'secret' } }),
        frame(chunk('', 'tool_calls'))
    ]) {
        const result = await events(raw)
        assert.equal(result.at(-1).type, 'response.failed')
        assert.ok(!JSON.stringify(result).includes('secret'))
    }
})
test('stream cancellation propagates to provider', async () => {
    let canceled = false
    const stream = chatStream(
        new ReadableStream({
            cancel() {
                canceled = true
            }
        }),
        'model'
    )
    const reader = stream.getReader()
    await reader.read()
    await reader.cancel()
    assert.equal(canceled, true)
})
test('redirect, malformed provider JSON and key formatting yield safe diagnostic errors', async () => {
    const redirect = await make(
        async () => new Response(null, { status: 302, headers: { Location: 'https://other.example' } })
    ).fetch(req(), env)
    assert.equal(redirect.status, 502)
    assert.match((await redirect.json()).error.message, /Redirect refused/)
    const malformed = await make(async () => Response.json({ error: { message: 'secret' } })).fetch(req(), env)
    assert.equal(malformed.status, 502)
    assert.ok(!(await malformed.text()).includes('secret'))
    const badKey = await make(async () => {
        assert.fail('no request expected')
    }).fetch(req(), { ...env, AI_API_KEY: 'abc\ndef' })
    assert.equal(badKey.status, 503)
})
