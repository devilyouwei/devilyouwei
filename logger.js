/** @format */

const fs = require('fs')
const path = require('path')
const pino = require('pino')

const isProd = process.env.NODE_ENV === 'production'

// Ensure logs dir in production
const logsDir = path.join(process.cwd(), 'logs')
if (isProd && !fs.existsSync(logsDir)) fs.mkdirSync(logsDir)

// Helper to extract callsite (file:line:column)
function getCallsite() {
    const err = new Error()
    if (!err.stack) return undefined
    const lines = err.stack.split('\n').slice(2)
    const skipTokens = ['logger.js', '/node_modules/pino', 'node:internal', '(internal/', 'internal/']
    for (const raw of lines) {
        const line = raw.trim()
        if (skipTokens.some(t => line.includes(t))) continue
        const m = line.match(/^at\s+(?:.+\s+\()?(.+?):(\d+):(\d+)\)?$/)
        if (m) {
            const file = m[1]
            const ln = m[2]
            const col = m[3]
            const rel = path.isAbsolute(file) ? path.relative(process.cwd(), file) : file
            return `${rel}:${ln}:${col}`
        }
    }
    return undefined
}

// Build stream/transport
let destinationOrTransport
if (isProd) {
    // Use synchronous file destinations to avoid losing logs on fast exits
    const streams = [
        { level: 'info', stream: pino.destination({ dest: path.join(logsDir, 'info.log'), sync: true }) },
        { level: 'error', stream: pino.destination({ dest: path.join(logsDir, 'error.log'), sync: true }) }
    ]
    destinationOrTransport = pino.multistream(streams)
} else {
    // Dev: pretty print to console
    destinationOrTransport = pino.transport({
        target: 'pino-pretty',
        options: {
            colorize: true,
            singleLine: false,
            translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
            ignore: 'pid,hostname'
        }
    })
}

const logger = pino(
    {
        level: isProd ? 'info' : 'debug',
        base: undefined,
        formatters: {
            level(label) {
                return { level: label }
            },
            log(obj) {
                if (obj && obj.err instanceof Error) {
                    obj.err = pino.stdSerializers.err(obj.err)
                }
                if (obj && obj.error instanceof Error) {
                    obj.error = pino.stdSerializers.err(obj.error)
                }
                return obj
            }
        },
        hooks: {
            logMethod(args, method) {
                const caller = getCallsite()
                if (args.length === 1 && typeof args[0] === 'string') {
                    args[0] = caller ? `${args[0]} [${caller}]` : args[0]
                    return method.apply(this, args)
                }
                if (args.length >= 1 && typeof args[0] === 'object') {
                    args[0] = { caller, ...args[0] }
                    if (typeof args[1] === 'string' && caller) {
                        args[1] = `${args[1]} [${caller}]`
                    }
                    return method.apply(this, args)
                }
                return method.apply(this, args)
            }
        }
    },
    destinationOrTransport
)

// Stream-style writer compatibility (e.g., morgan-like integrations)
logger.stream = {
    write(message) {
        logger.info(message.trim())
    }
}

// Build Fastify logger options (object only)
function getFastifyLoggerOptions() {
    const isProd = process.env.NODE_ENV === 'production'
    const opts = {
        level: isProd ? 'info' : 'debug',
        base: undefined
    }
    if (isProd) {
        // Write logs to files in production
        opts.transport = {
            targets: [
                { target: 'pino/file', level: 'info', options: { destination: 'logs/info.log' } },
                { target: 'pino/file', level: 'error', options: { destination: 'logs/error.log' } }
            ]
        }
    } else {
        // Pretty console in development
        opts.transport = {
            target: 'pino-pretty',
            options: {
                colorize: true,
                singleLine: true,
                translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
                ignore: 'pid,hostname'
            }
        }
    }
    return opts
}

module.exports = { logger, getFastifyLoggerOptions }
