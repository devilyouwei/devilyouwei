/** @format */

const Koa = require('koa')
const parameter = require('koa-parameter')
const bodyParser = require('koa-bodyparser')
const cors = require('@koa/cors') // 引入koa2-cors

const app = new Koa()
// route controllers
const ai = require('./ai')
const { Stream } = require('stream')

app.use(cors()) // 使用cors中间件
app.use(bodyParser())
app.use(parameter(app))

// handle requests
app.use(async ctx => {
    try {
        console.log(ctx.method, ctx.path)
        const action = ctx.path.split('/')[1] || 'index'
        if (!action) throw new Error('Action is null')
        if (!ai[action]) throw new Error('Action not found')

        if (ctx.method.toLowerCase() === 'get') ctx.request.body = ctx.query

        const res = await ai[action](ctx)
        if (typeof res === 'string') ctx.body = res
        else if (res instanceof Stream) {
            ctx.set({
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive'
            })
            ctx.body = res
        } else ctx.body = { status: 1, msg: res.msg, data: res.data }
    } catch (e) {
        console.error(e)
        ctx.body = { status: 0, msg: e.message, data: null }
    }
})

app.listen(3000)
