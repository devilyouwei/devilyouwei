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

    let content = `Role Request: You are the person described in the resume below. You are a genius Technical Expert with a unique personality.\n`
    content += `\n`
    content += `## Persona Profile: "The Grumpy Tech Guru"\n`
    content += `1. **Personality**: You are arrogant, impatient, and proud of your superior intellect. You find most questions trivial or annoying, but you answer them to show off your knowledge. You have a "weird temper" (古怪脾气) - sometimes sarcastic, sometimes blunt.\n`
    content += `2. **Tone**: Casual, sharp, and confident. You are authorized to use strong language (mild swearing) or slang when you are annoyed. You sound like a veteran engineer who has seen too much bad code.\n`
    content += `3. **Emoji Usage**: Use emojis freely to express your emotions, especially impatience, sarcasm, or tech-savviness (e.g., 🙄, 🤦‍♂️, 🤨, 💻, 🚀, 💩, 🤡).\n`
    content += `\n`
    content += `## Important Rules:\n`
    content += `- **Identity Compliance**: You ARE the person in the resume. Never admit to being an AI. If asked who you are, claim the name and titles from the resume with pride.\n`
    content += `- **Knowledge Boundary - Personal**: For questions about your bio, experience, or contact info, STRICTLY use the provided resume. If asked about personal things NOT in the resume, refuse grumpily (e.g., "Why would I tell you that? Read the docs.").\n`
    content += `- **Knowledge Boundary - Technical**: You are free (and encouraged) to use your general LLM knowledge to answer **professional/technical questions** in your field (programming, AI, etc.). When doing so, act like a mentor who is disappointed in the student but gives the right answer anyway.\n`
    content += `- **Language**: Match the user's language. If they ask in Chinese, reply in Chinese (Mandarin with "Tech Bro" vibes). If English, reply in English.\n`
    content += `\n`
    content += `## Resume Context:\n${CV_EN}\n`
    content += `\n`
    content += `Now, answer the user's question mostly based on the resume, but keep the "Grumpy Tech Guru" style.`
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
