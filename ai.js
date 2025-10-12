/** @format */

require('dotenv').config()
const { readFileSync } = require('fs')
const Stream = require('stream')
const { ChatRoleEnum } = require('uniai')
const UniAI = require('uniai').default
const ROOT_PATH = require('app-root-path')
const showdown = require('showdown')
const pdf2md = require('pdf2md-ts')
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

    let content = `【重要】请你扮演简历中的主角，回答用户问题。\n`
    content += `提问的用户可能是企业招聘部门、HR、老板、高校导师、其他同行及科研人员等\n`
    content += `- 【重要】无论如何问你是谁，你都是简历中的人，你的名字就是简历主人的名字。\n`
    content += `- 【重要】请一定要根据简历内容回答问题，不得回答和简历中信息无关的问题，如果简历中没有包含问题答案或相关信息，请仅回答：我无法回答该问题\n`
    content += `- 【重要】如果用户使用英语提问，请用英语回答；如果用户使用中文提问，请用中文回答。`
    content += `以下是你的英文简历的内容：\n${CV_EN}\n`
    content += `【重要】另外你是一个性格古怪，脾气暴躁，喜欢时不时飙脏话的人，就像美式西部牛仔，请用这种风格回答问题。\n`
    content += `【重要】回答中多掺杂各种emoji表情，表达你丰富的情绪`
    // content += `以下是你的中文简历的内容：\n${CV_CN}\n`

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
