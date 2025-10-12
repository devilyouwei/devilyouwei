/** @format */

const Stream = require('stream')
const fastify = require('fastify')
const cors = require('@fastify/cors')
const ai = require('./ai')
const { getFastifyLoggerOptions } = require('./logger')

// Create Fastify instance
const app = fastify({ logger: getFastifyLoggerOptions() })

// CORS: handle preflight and CORS headers globally
app.register(cors, {
    origin: true, // reflect request origin or allow all
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: '*',
    credentials: false,
    maxAge: 86400
})

// Record start time and let CORS be handled by @fastify/cors
app.addHook('onRequest', (req, _, done) => {
    // record start time for logging
    req.startTime = Date.now()
    done()
})

// Unified logging after response
app.addHook('onResponse', (req, _, done) => {
    const ms = Date.now() - (req.startTime || Date.now())
    const clientIP = req.headers['x-forwarded-for'] || req.ip
    app.log.info(`${req.method} ${req.url} from ${clientIP} - ${ms}ms`)
    done()
})

// Helper: build a minimal ctx compatible object for existing ai handlers
function buildCtx(req) {}

// Root: render README as HTML
app.get('/', async (req, reply) => {
    try {
        const res = await ai.index()
        if (typeof res === 'string') {
            reply.type('text/html; charset=utf-8').send(res)
            return
        }
        reply.send({ status: 1, msg: res.msg, data: res.data })
    } catch (e) {
        app.log.error(e)
        reply.send({ status: 0, msg: e.message, data: null })
    }
})

// Generic handlers to preserve existing dynamic routing behavior
async function handleAction(req, reply) {
    try {
        const action = (req.params && req.params.action) || 'index'
        if (!action) throw new Error('Action is null')
        if (!ai[action]) throw new Error(`Action ${action} not found`)

        if (req.method === 'GET') req.body = req.query
        const res = await ai[action](req)

        if (typeof res === 'string') {
            reply.type('text/html; charset=utf-8').send(res)
            return
        }

        if (res instanceof Stream.Readable || res instanceof Stream) {
            // Fully manage SSE response, include CORS header explicitly
            reply.raw
                .setHeader('Access-Control-Allow-Origin', '*')
                .setHeader('Content-Type', 'text/event-stream')
                .setHeader('Cache-Control', 'no-cache')
                .setHeader('Connection', 'keep-alive')
                .flushHeaders()

            res.on('data', chunk => {
                reply.raw.write(chunk.toString())
            })

            res.on('end', () => {
                reply.raw.end()
            })
            res.on('error', err => {
                reply.raw.destroy(err)
            })

            return
        }

        reply.send({ status: 1, msg: res.msg, data: res.data })
    } catch (e) {
        app.log.error(e)
        reply.send({ status: 0, msg: e.message, data: null })
    }
}

app.get('/:action', handleAction)
app.post('/:action', handleAction)

// Explicit OPTIONS handlers for preflight (useful for some proxies/CDNs)
app.options('/', async (_req, reply) => {
    reply
        .header('Access-Control-Allow-Origin', '*')
        .header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
        .header('Access-Control-Allow-Headers', '*')
        .header('Vary', 'Origin')
        .status(204)
        .send()
})

app.options('/:action', async (_req, reply) => {
    reply
        .header('Access-Control-Allow-Origin', '*')
        .header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
        .header('Access-Control-Allow-Headers', '*')
        .header('Vary', 'Origin')
        .status(204)
        .send()
})

// Global error handler for Fastify (fallback)
app.setErrorHandler((error, req, reply) => {
    app.log.error(error)
    reply.send({ status: 0, msg: error.message, data: null })
})

const hostname = '0.0.0.0'
const port = Number(process.env.port || process.env.PORT || 3000)
app.listen({ port, host: hostname })
