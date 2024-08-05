/** @format */

// logger.js
const winston = require('winston')
const fs = require('fs')
const path = require('path')

// 确保logs目录存在
const logsDir = 'logs'
fs.existsSync(logsDir) || fs.mkdirSync(logsDir)

// 创建info和error日志器
const infoLogger = new winston.transports.File({
    level: 'info',
    filename: path.join(logsDir, 'info.log'),
    handleExceptions: true,
    json: true,
    maxsize: 5242880, // 5MB
    maxFiles: 5
})

const errorLogger = new winston.transports.File({
    level: 'error',
    filename: path.join(logsDir, 'error.log'),
    handleExceptions: true,
    json: true,
    maxsize: 5242880, // 5MB
    maxFiles: 5
})

// 创建日志器
const logger = winston.createLogger({
    transports: [infoLogger, errorLogger],
    exitOnError: false // do not exit on handled exceptions
})

// 添加日志到Koa中间件
logger.stream = {
    write: function (message, encoding) {
        logger.info(message)
    }
}

module.exports = logger
