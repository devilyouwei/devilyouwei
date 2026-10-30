/** @format */

import showdown from 'showdown'
import readme from './README.md'
import resume from './docs/README.md'
import prompt from './docs/system-prompt.md'
import { createWorker } from './ai.js'

export default createWorker({
    instructions: prompt.replace('{{RESUME}}', resume),
    indexHtml: new showdown.Converter().makeHtml(readme)
})
