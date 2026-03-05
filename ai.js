/** @format */

require('dotenv').config()
const { readFileSync } = require('fs')
const Stream = require('stream')
const { ChatRoleEnum } = require('uniai')
const UniAI = require('uniai').default
const ROOT_PATH = require('app-root-path')
const showdown = require('showdown')
const { logger } = require('./logger')

const {
    GOOGLE_AI_KEY,
    GOOGLE_AI_API,
    ZHIPU_AI_KEY,
    FLY_APP_ID,
    FLY_API_KEY,
    FLY_API_SECRET,
    BAIDU_API_KEY,
    BAIDU_SECRET_KEY,
    GLM_API,
    PROVIDER,
    MODEL
} = process.env

const ai = new UniAI({
    Google: { key: GOOGLE_AI_KEY, proxy: GOOGLE_AI_API },
    Baidu: { apiKey: BAIDU_API_KEY, secretKey: BAIDU_SECRET_KEY },
    IFlyTek: { appId: FLY_APP_ID, apiKey: FLY_API_KEY, apiSecret: FLY_API_SECRET },
    GLM: { key: ZHIPU_AI_KEY },
    Other: { api: GLM_API }
})

let CV_CN = ''
let CV_EN = ''

async function chat(req) {
    const { input, stream, temperature, top, maxLength } = req.body
    const provider = PROVIDER
    const model = MODEL

    logger.info(input)

    if (!Array.isArray(input)) throw new Error('Input is not array')

    if (!CV_CN) CV_CN = (await pdf2md(readFileSync(`${ROOT_PATH}/docs/resume-cn.pdf`))).join('\n')
    if (!CV_EN) CV_EN = readFileSync(`${ROOT_PATH}/docs/README.md`, 'utf-8')

    const prompt = readFileSync(`${ROOT_PATH}/docs/system-prompt.md`, 'utf-8')
    const content = prompt.replace('{{RESUME}}', CV_EN)

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
 * Index page, show your readme
 */
async function index() {
    const converter = new showdown.Converter()
    const text = readFileSync(`${ROOT_PATH}/README.md`, 'utf-8')
    return converter.makeHtml(text)
}

module.exports = { chat, index }
