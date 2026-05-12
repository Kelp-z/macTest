// server.js
const express = require('express');
const http = require('http');
const {Server} = require('socket.io');
const cors = require('cors');
const path = require('path');
// 导入配置管理
const configManager = require('./src/infrastructure/config-manager');
// 导入外观注册
const { createCrawlerRegistry } = require('./src/facade/registry');
const { createInterventionSession } = require('./src/facade/intervention-session');
const { registerCrawlerRoutes } = require('./src/facade/route-factory');

const registry = createCrawlerRegistry();
const session = createInterventionSession(300000);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    pingInterval: 15000,    // 每 15 秒发送心跳
    pingTimeout: 600000,     //超时
    maxHttpBufferSize: 1e8, // 100MB，防止大数据包被拒绝
    allowEIO3: true,        // 兼容 Socket.IO v3 客户端
    transports: ['websocket', 'polling'] // 优先 WebSocket
});
const { setIo } = require('./src/infrastructure/socket-io-manager');
setIo(io);

const fs = require('fs');
const {ensureDir} = require("./src/utils/common-utils");
// 截图目录配置
const getSafePath = (relativePath) => {
    // 在 Electron 环境中使用 app.getPath('userData')
    if (process.versions.electron) {
        const { app } = require('electron');
        return path.join(app.getPath('userData'), relativePath);
    }
    // 开发环境使用 process.cwd()
    return path.join(process.cwd(), relativePath);
};
const SCREENSHOTS_DIR = getSafePath('output/screenshots');
try {
    ensureDir(SCREENSHOTS_DIR); // 确保截图目录存在
    console.log(`截图目录: ${SCREENSHOTS_DIR}`);
} catch (err) {
    console.error('创建截图目录失败:', err.message);
    // 使用临时目录作为备选方案
    const os = require('os');
    const tempScreenshotsDir = path.join(os.tmpdir(), 'spm_crawler', 'screenshots');
    ensureDir(tempScreenshotsDir);
    console.log(`使用临时截图目录: ${tempScreenshotsDir}`);
}
// 确保前端页面正常被打包
console.log('__dirname =', __dirname);
try {
    const files = fs.readdirSync(__dirname);
    console.log('__dirname 下的内容:', files);
} catch (err) {
    console.log('无法读取 __dirname:', err.message);
}
// 定义 isPkg 变量
const isPkg = !!process.pkg; // 判断是否是pkg打包后的环境

const browsersPath = isPkg
    ? path.join(path.dirname(process.execPath), 'browsers') // 打包后路径
    : path.join(__dirname, 'browsers'); // 开发环境路径


let ELECTRON_TOKEN = null;
// const ELECTRON_TOKEN = process.env.ELECTRON_TOKEN || (()=>{
//     // 从主进程中获取,独立运行server.js会报错
//     throw new Error('ELECTRON_TOKEN must be provided');
// })

function validateToken(req, res, next) {
    // if(req.path.startsWith('node_modules') || req.path === '/'|| req.path === '/captcha'|| req.path.startsWith('/captcha/')|| req.path === '/login'|| req.path === '/index'){
    //     return next();
    // }
    if (req.path.startsWith('/api/user-intervention/complete') ||
        req.path.startsWith('node_modules') ||
        req.path.startsWith('/captcha') ||
        req.path.startsWith('/screenshots') ||
        req.path === '/google' ||
        req.path === '/wos' ||
        req.path === '/scopus' ||
        req.path === '/favicon.ico') {
        return next();
    }

    const token = req.headers['x-electron-token'] || req.query.token;
    if (ELECTRON_TOKEN || token === ELECTRON_TOKEN) {
        return next();
    }
    console.warn(`非法访问尝试:${req.method}${req.path} from ${req.ip}`);
    res.status(403).json({code: 403, msg: 'Forbidden:Invalid token'});
}

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({extended: true}));
app.use(validateToken);


app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/login.html'));
});
app.get('/index', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/index.html'));
});
// 静态文件：存放前端的 HTML 文件
app.use('/google', express.static(path.join(__dirname, 'public/google')));
app.use('/scopus', express.static(path.join(__dirname, 'public/scopus')));
app.use('/wos', express.static(path.join(__dirname, 'public/wos')));
// 允许前端访问 node_modules 中的库文件
app.use('/node_modules', express.static(path.join(__dirname, 'node_modules')));

/// 验证码图片访问（供 SCOPUS 和 WOS 共用）
// const captchaDir = scopusCrawler.CONFIG?.CAPTCHA_DIR || wosCrawler.CONFIG?.CAPTCHA_DIR || path.join(__dirname, 'captcha_temp');
// app.use('/captcha', express.static(captchaDir));
// 验证码图片访问固定配置来源
const captchaDir = path.join(__dirname, 'captcha_temp');
try {
    ensureDir(captchaDir);
    console.log(`验证码目录: ${captchaDir}`);

    app.use('/captcha', express.static(captchaDir, {
        fallthrough: false,  // 如果文件不存在，返回 404 而不是继续匹配其他路由
        maxAge: '1h'         //  缓存1小时
    }));
} catch (err) {
    console.error('创建验证码目录失败:', err.message);
    // 使用临时目录作为备选方案
    const os = require('os');
    const tempCaptchaDir = path.join(os.tmpdir(), 'spm_crawler', 'captcha_temp');
    ensureDir(tempCaptchaDir);
    console.log(`使用临时验证码目录: ${tempCaptchaDir}`);
    app.use('/captcha',express.static(tempCaptchaDir));
}
// 错误截图访问路由
app.use('/screenshots', express.static(SCREENSHOTS_DIR));

// 转换错误对象中的截图返回路径
function convertErrorScreenshotPath(errorObj) {
    if (!errorObj) return errorObj;
    if (errorObj.screenshotPath && typeof errorObj.screenshotPath === 'string') {
        // 将绝对路径转换为路由访问路径
        const filename = path.basename(errorObj.screenshotPath);
        errorObj.screenshotPath = `/screenshots/${filename}`
    }
    return errorObj;
}



app.post('/api/system/shutdown', (req, res) => {
    console.log('用户退出应用');
    // 后续考虑执行清理工作
    res.json({code: 200, msg: '已记录退出事件'});
});

//  统一路由注册（crawler_facade）
function nonEmptyArray(arr, label) {
    return (!Array.isArray(arr) || arr.length === 0) ? `${label}不能为空` : null;
}

registerCrawlerRoutes({
    app,
    basePath: '/api/google/crawl',
    facade: registry.getCrawlerFacade('google'),
    io,
    session,
    validateInput: (input) => nonEmptyArray(input, '关键词数组'),
    inputFieldName: 'keywords',
    startSuccessMsg: '谷歌学术检索已启动',
    convertErrorScreenshotPath
});

registerCrawlerRoutes({
    app,
    basePath: '/api/google/author/crawl',
    facade: registry.getCrawlerFacade('google-author'),
    io,
    session,
    validateInput: (input) => nonEmptyArray(input, '作者姓名数组'),
    inputFieldName: 'keywords',
    startSuccessMsg: '谷歌学术作者检索已启动',
    convertErrorScreenshotPath
});

registerCrawlerRoutes({
    app,
    basePath: '/api/scopus/crawl',
    facade: registry.getCrawlerFacade('scopus'),
    io,
    session,
    validateInput: (input) => nonEmptyArray(input, '关键词数组'),
    inputFieldName: 'keywords',
    startSuccessMsg: 'Scopus检索已启动',
    convertErrorScreenshotPath
});

registerCrawlerRoutes({
    app,
    basePath: '/api/scopus/author/crawl',
    facade: registry.getCrawlerFacade('scopus-author'),
    io,
    session,
    validateInput: (input) => nonEmptyArray(input, '作者列表'),
    inputFieldName: 'authors',
    startSuccessMsg: 'Scopus作者检索已启动',
    convertErrorScreenshotPath
});

registerCrawlerRoutes({
    app,
    basePath: '/api/wos/crawl',
    facade: registry.getCrawlerFacade('wos'),
    io,
    session,
    validateInput: (input) => nonEmptyArray(input, '关键词数组'),
    inputFieldName: 'keywords',
    startSuccessMsg: 'WoS检索已启动',
    convertErrorScreenshotPath
});

registerCrawlerRoutes({
    app,
    basePath: '/api/wos/author/crawl',
    facade: registry.getCrawlerFacade('wos-author'),
    io,
    session,
    validateInput: (input) => nonEmptyArray(input, '作者列表'),
    inputFieldName: 'authors',
    startSuccessMsg: 'WoS作者检索已启动',
    convertErrorScreenshotPath
});

// Google restart 特殊接口（当前 facade restart 为可选能力）
app.post('/api/google/crawl/restart', async (req, res) => {
    const {keywords} = req.body;
    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
        return res.status(400).json({code: 400, msg: '关键词数组不能为空'});
    }
    try {
        const googleFacade = registry.getCrawlerFacade('google');
        if (typeof googleFacade.restart === 'function') {
            googleFacade.restart(keywords).catch(err => console.error('重启异常:', err));
            return res.json({code: 200, msg: '已停止当前检索并开始重新执行'});
        }
        return res.status(501).json({code: 501, msg: '当前爬虫不支持重启'});
    } catch (err) {
        return res.status(500).json({code: 500, msg: err.message});
    }
});

// 验证码提交
app.post('/api/scopus/captcha/submit', (req, res) => {
    const {captchaId, captchaCode} = req.body;
    const result = session.submitCaptcha('scopus', captchaId, captchaCode);
    if (!result.ok) return res.status(404).json({code: 404, msg: result.msg});
    res.json({code: 200, msg: result.msg});
});

app.post('/api/wos/captcha/submit', (req, res) => {
    const {captchaId, captchaCode} = req.body;
    const result = session.submitCaptcha('wos', captchaId, captchaCode);
    if (!result.ok) return res.status(404).json({code: 404, msg: result.msg});
    res.json({code: 200, msg: result.msg});
});

// 手动确认
// app.post('/api/scopus/crawl/manual-confirm', (req, res) => {
//     const result = session.confirmManual('scopus');
//     if (!result.ok) return res.status(400).json({code: 400, msg: result.msg});
//     res.json({code: 200, msg: result.msg});
// });

// app.post('/api/wos/crawl/manual-confirm', (req, res) => {
//     const result = session.confirmManual('wos');
//     if (!result.ok) return res.status(400).json({code: 400, msg: result.msg});
//     res.json({code: 200, msg: result.msg});
// });

// Socket.io 连接
io.on('connection', (socket) => {

    console.log(`前端已连接 (ID: ${socket.id})`);
    console.log(`连接时间: ${new Date().toLocaleString()}`);
    console.log(`传输方式: ${socket.conn.transport.name}`);

    //  记录最后一次心跳时间
    let lastPingTime = Date.now();
    let pingCount = 0;

    socket.on('ping', () => {
        lastPingTime = Date.now();
        pingCount++;
        if (pingCount % 20 === 0) {
            console.log(`Socket已接收 ${pingCount} 次心跳，连接稳定`);
        }
    });

    socket.on('disconnect', (reason) => {
        const idleTime = Date.now() - lastPingTime;
        const connectedDuration = Date.now() - socket.conn.createdAt;

        console.log(`前端断开连接 (ID: ${socket.id})`);
        console.log(`断开原因: ${reason}`);
        console.log(`连接持续时间: ${Math.round(connectedDuration / 1000)} 秒 (${Math.round(connectedDuration / 60000)} 分钟)`);
        console.log(`距离上次心跳: ${Math.round(idleTime / 1000)} 秒`);
        console.log(`总心跳次数: ${pingCount}`);
        console.log(`断开时间: ${new Date().toLocaleString()}`);

        if (idleTime > 60000) {
            console.warn(`警告：客户端空闲时间过长（>${Math.round(idleTime / 1000)}秒）`);
        }

        if (connectedDuration < 60000) {
            console.warn(`警告：连接持续时间过短，可能是瞬时断开`);
        }

        // 如果是服务器主动断开，记录原因
        if (reason === 'server namespace disconnect') {
            console.error(`服务器主动断开连接`);
        }
    });
});
io.use((socket, next) => {
    const token = socket.handshake.query.token;
    if (token === global.ELECTRON_TOKEN || token === process.env.ELECTRON_TOKEN) {
        return next();
    }
    next(new Error('Authentication error'));
})

io.on('connection', (socket) => {
    socket.on('submit-captcha', ({ source, captchaId, captchaCode }) => {
        const crawler = registry.getCrawlerFacade(source);

        if (crawler && crawler.submitCaptcha) {
            const result = crawler.submitCaptcha(captchaId, captchaCode);
            socket.emit('captcha-result', result);
        } else {
            socket.emit('captcha-result', { ok: false, msg: '无效的爬虫源' });
        }
    });

    // 确认手动操作
    socket.on('confirm-manual', ({ source }) => {
        const crawler = registry.getCrawlerFacade(source);

        if (crawler && crawler.confirmManual) {
            const result = crawler.confirmManual();
            socket.emit('manual-result', result);
        }
    });

    // 取消干预
    socket.on('cancel-intervention', ({ source, reason }) => {
        const crawler = registry.getCrawlerFacade(source);

        if (crawler && crawler.cancelIntervention) {
            crawler.cancelIntervention(reason);
        }
    });
});



// 手动干预请求处理函数
function requestUserIntervention(socketID, intervention) {
    return new Promise((resolve, reject) => {
        const {id, type, data} = intervention;
        if (type === 'captcha') {
            const promise = session.createCaptchaPromise('global', id);
            io.to(socketID).emit('user-intervention-required', {id, type, data});

            // 等待结果
            promise.then(resolve).catch(reject);

        } else if (type === 'manual') {
            const promise = session.createManualPromise('global');
            io.to(socketID).emit('user-intervention-required', {id, type, data});

            // 等待确认
            promise.then(resolve).catch(reject);

        } else {
            reject(new Error(`不支持的干预类型: ${type}`));
        }
    });
}
// 前端完成干预后调用此接口
app.post('/api/user-intervention/complete', (req, res) => {
    const { id, result, type, source } = req.body;

    // 如果没传 source，尝试从 session 中兼容
    const facade = registry.getCrawlerFacade(source || 'global');
    if (!facade) {
        return res.status(404).json({ code: 404, msg: '无效的爬虫源' });
    }

    if (type === 'captcha') {
        const response = facade.submitCaptcha(id, result);
        if (response.ok) {
            res.json({ code: 200, msg: '验证码已提交' });
        } else {
            res.status(404).json({ code: 404, msg: response.msg });
        }
    } else if (type === 'manual') {
        const response = facade.confirmManual();
        if (response.ok) {
            res.json({ code: 200, msg: '手动操作已确认' });
        } else {
            res.status(404).json({ code: 404, msg: response.msg });
        }
    } else {
        res.status(400).json({ code: 400, msg: '无效的干预类型' });
    }
});
// 添加配置接口，供前端获取后端服务配置
app.get('/api/config', (req, res) => {
    const backendConfig = configManager.getBackendConfig();
    res.json({
        code: 200,
        data: {
            localPort: backendConfig.LOCAL_PORT,
            springPort: backendConfig.SPRING_PORT,
            localHost: backendConfig.LOCAL_HOST,
            localBaseUrl: backendConfig.LOCAL_BASE_URL,
            springBaseUrl: backendConfig.SPRING_BASE_URL
        }
    });
});

// 加载全局配置
let globalConfig = {};
const globalConfigPath = path.join(__dirname, 'config.json');
if (fs.existsSync(globalConfigPath)) {
    try {
        const raw = fs.readFileSync(globalConfigPath, 'utf8');
        globalConfig = JSON.parse(raw);
    } catch (err) {
        console.warn('读取全局配置文件失败', err.message);
    }
}
const LOG_BASE_DIR = globalConfig.LOG_BASE_DIR || path.join(__dirname, 'logs');

// 清理日志函数
function cleanOldLogs() {
    if (!fs.existsSync(LOG_BASE_DIR)) return;
    const files = fs.readdirSync(LOG_BASE_DIR);
    const now = Date.now();
    const oneWeek = 7 * 24 * 60 * 60 * 1000;
    let deletedCount = 0;
    for (const file of files) {
        const filePath = path.join(LOG_BASE_DIR, file);
        try {
            const stats = fs.statSync(filePath);
            if (stats.isFile() && (now - stats.mtimeMs > oneWeek)) {
                fs.unlinkSync(filePath);
                deletedCount++;
                console.log(`[清理] 已删除旧日志: ${file}`);
            }
        } catch (err) {
            console.warn(`[清理] 无法删除 ${file}: ${err.message}`);
        }
    }
    if (deletedCount > 0) {
        console.log(`[清理] 共删除 ${deletedCount} 个超过7天的日志文件`);
    }
}

// 启动时执行一次清理
cleanOldLogs();

// 适应electron将直接监听改为导出一个启动函数
const DEFAULT_PORT = configManager.getLocalPort() || 3000;
const PORT = process.env.PORT || DEFAULT_PORT;


function startServer(port = PORT, token = null) {
    if (token) {
        process.env.ELECTRON_TOKEN = token;
        ELECTRON_TOKEN = token;
        console.log('ELECTRON_TOKEN 已设置')
    }
    return new Promise((resolve, reject) => {
        server.listen(port, () => {
            console.log(`服务器运行在 http://localhost:${port}`);
            resolve(server);
        }).on('error', (err) => {
            reject(err);
        });
    });
}

// 直接运行 node server.js，则自启动服务器
if (require.main === module) {
    startServer(PORT).catch(err => {
        console.error('服务器启动失败:', err);
        process.exit(1);
    });
}

process.on('SIGINT', async () => {
    console.log('\n收到中断信号，正在清理...');
    await cleanupAllCrawlers();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n收到终止信号，正在清理...');
    await cleanupAllCrawlers();
    process.exit(0);
});
// 未捕获异常的兜底处理
process.on('uncaughtException', async (err) => {
    console.error('未捕获的异常:', err);
    await cleanupAllCrawlers();
    process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
    console.error('未处理的 Promise 拒绝:', reason);
    await cleanupAllCrawlers();
    process.exit(1);
});
/**
 * 清理所有爬虫资源（供进程退出和 API 调用）
 */
async function cleanupAllCrawlers() {

    const sources = ['google', 'google-author', 'scopus', 'scopus-author', 'wos', 'wos-author'];
    let cleanedCount = 0;

    for (const source of sources) {
        try {
            const facade = registry.getExistingFacade(source);
            if (facade) {
                const state = await facade.getState();
                if (state.isRunning) {
                    console.log(`停止 ${source} 爬虫...`);
                    await facade.stop();
                    await facade.resetState();
                    session.cancelSource(source, '服务器关闭');
                    cleanedCount++;
                }
            }
        } catch (err) {
            console.error(` 清理 ${source} 失败:`, err.message);
        }
    }

    // 关闭 Socket.IO
    if (io) {
        console.log('关闭 Socket.IO...');
        io.close();
    }

    // 关闭 HTTP 服务器
    if (server) {
        console.log('关闭 HTTP 服务器...');
        await new Promise((resolve) => {
            server.close(() => {
                console.log('HTTP 服务器已关闭');
                resolve();
            });
        });
    }

    console.log(`清理完成，共停止 ${cleanedCount} 个运行中的爬虫`);
}
module.exports = {app, server, io, startServer,cleanupAllCrawlers};
