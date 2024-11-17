/** @format */

const Koa = require('koa')
const parameter = require('koa-parameter')
const bodyParser = require('koa-bodyparser')
const cors = require('@koa/cors') // 引入koa2-cors
const logger = require('./logger')

const app = new Koa()
// route controllers
const ai = require('./ai')
const { Stream } = require('stream')

app.use(cors()) // 使用cors中间件
app.use(bodyParser())
app.use(parameter(app))

app.use(async (ctx, next) => {
    const start = new Date()
    await next()
    const ms = new Date() - start
    const clientIP = ctx.headers['x-forwarded-for'] || ctx.request.ip || ctx.ip
    logger.info(`${ctx.method} ${ctx.url} from ${clientIP} - ${ms}ms`)
})

// handle requests
app.use(async ctx => {
    try {
        const action = ctx.path.split('/')[1] || 'index'
        if (!action) throw new Error('Action is null')
        if (!ai[action]) throw new Error('Action not found')

        if (ctx.method.toLowerCase() === 'get') ctx.request.body = ctx.query

        const res = await ai[action](ctx)

        if (typeof res === 'string') ctx.body = res
        else if (res instanceof Stream) {
            ctx.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
            ctx.body = res
        } else ctx.body = { status: 1, msg: res.msg, data: res.data }
    } catch (e) {
        ctx.body = { status: 0, msg: e.message, data: null }
        logger.error(e.toString())
    }
})

const hostname = '0.0.0.0'
const port = process.env.port || 3000
app.listen(port, hostname, () => console.log(`Server running at http://${hostname}:${port}`))
