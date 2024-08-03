/** @format */

require('dotenv').config()
const { readFileSync } = require('fs')
const Stream = require('stream')
const { ChatRoleEnum, ChatModelProvider, ChatModel } = require('uniai')
const UniAI = require('uniai').default
const ROOT_PATH = require('app-root-path')
const showdown = require('showdown')
const pdf2md = require('pdf2md-ts')

const { PROVIDER, MODEL, GOOGLE_AI_KEY, ZHIPU_AI_KEY, GLM_API, GOOGLE_AI_API } = process.env

const ai = new UniAI({
    Google: { key: GOOGLE_AI_KEY.split(','), proxy: GOOGLE_AI_API },
    GLM: { key: ZHIPU_AI_KEY, local: GLM_API },
    Other: { api: GLM_API }
})

/**
 * Chat to models
 * @param {import('koa').Context} ctx - Koa Context
 */
async function chat(ctx) {
    const input = ctx.request.body.input
    const stream = ctx.request.body.stream
    const temperature = ctx.request.body.temperature
    const top = ctx.request.body.top
    const maxLength = ctx.request.body.maxLength
    const provider = PROVIDER
    const model = MODEL

    if (!Array.isArray(input)) throw new Error('Input is not array')

    let content = `以下是英文简历的内容：\n`
    content += readFileSync(`${ROOT_PATH}/assets/resume.md`, 'utf-8')
    const md = await pdf2md(readFileSync(`${ROOT_PATH}/assets/resume-cn.pdf`))
    content += `以下是中文简历的内容：${md.join('\n')}\n`
    content += `【重要】现在要求你根据我的简历信息扮演我（黄有为），回答用户问题，你的用户是企业招聘部门，HR，老板等面试你的人\n`
    content += `【重要】你就是黄有为，无论如何问你是谁，你都回到你是黄有为，不得回答无关黄有为简历和个人信息的问题。`
    content += `请一定要根据简历内容，回答面试者，HR的问题，如果简历中没有包含问题答案或不相关信息，请仅回答：我无法回答该问题\n`
    content += `如果用户使用英语提问，请用英语回答，如果用户使用中文提问，请用中文回答。`

    input.unshift({ role: ChatRoleEnum.SYSTEM, content })

    const res = await ai.chat(input, { provider, model, stream, temperature, top, maxLength })

    const data = { status: 1, msg: 'Success to chat to model', data: null }
    // stream return
    if (res instanceof Stream.Readable) {
        const output = new Stream.PassThrough()
        res.on('data', buff => {
            data.data = JSON.parse(buff.toString())
            output.write(`data: ${JSON.stringify(data)}\n\n`)
        })

        res.on('error', e => {
            data.status = 0
            data.msg = e.message
            data.data = null
            output.end(`data: ${JSON.stringify(data)}\n\n`)
        })
        res.on('end', () => output.end())
        return output
    }

    data.data = res
    return data
}

/**
 * Chat to models
 * @param {import('koa').Context} ctx - Koa Context
 */
async function index(ctx) {
    const converter = new showdown.Converter()
    const text = readFileSync(`${ROOT_PATH}/assets/resume.md`, 'utf-8')
    const html = converter.makeHtml(text)

    return html
}

module.exports = { chat, index }
