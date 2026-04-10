// server.js
const express = require('express');
const http = require('http');
const {Server} = require('socket.io');
const cors = require('cors');
const path = require('path');

// 导入爬虫模块
const googleCrawler = require('./google-scholar-crawler');
const scopusCrawler = require('./scopus-crawler');
const wosCrawler = require('./wos-crawler');
const googleAuthorCrawler = require('./google-scholar-author-crawler');
const scopusAuthorCrawler = require('./scopus-author-crawler');
const wosAuthorCrawler = require('./wos-author-crawler');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {cors: {origin: '*'}});
const { setIo } = require('./crawler-utils');
setIo(io);

const fs = require('fs');
const {ensureDir} = require("./crawler-utils");

// 截图目录配置
const SCREENSHOTS_DIR = path.join(process.cwd(), 'output', 'screenshots');
ensureDir(SCREENSHOTS_DIR); // 确保截图目录存在
console.log(`截图目录: ${SCREENSHOTS_DIR}`);

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
    if (req.path.startsWith('node_modules') ||
        req.path === '/captcha' ||
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

// 验证码图片访问（供 SCOPUS 和 WOS 共用）
const captchaDir = scopusCrawler.CONFIG?.CAPTCHA_DIR || wosCrawler.CONFIG?.CAPTCHA_DIR || path.join(__dirname, 'captcha_temp');
app.use('/captcha', express.static(captchaDir));

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

//  存储各个爬虫的 Promise 控制器
const pendingPromises = {
    scopus: {captcha: null, manual: null},
    wos: {captcha: null, manual: null}
};

app.post('/api/system/shutdown', (req, res) => {
    console.log('用户退出应用');
    // 后续考虑执行清理工作
    res.json({code: 200, msg: '已记录退出事件'});
});

//  生成带回调的启动处理
function createCrawlHandler(crawler, type) {
    return async (req, res) => {
        const {keywords, generateExcel, outputDir} = req.body;
        if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
            return res.status(400).json({code: 400, msg: '关键词数组不能为空'});
        }
        if (crawler.getCrawlerState().isRunning) {
            return res.status(409).json({code: 409, msg: `${type}爬虫正在运行中`});
        }

        const taskId = `${type}_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
        const taskCaptchaDir = path.join(captchaDir, taskId);
        ensureDir(taskCaptchaDir); // 确保目录存在

        const onCaptchaRequired = ({captchaId, imagePath}) => {
            // 提取图片文件名
            const fileName = path.basename(imagePath);
            // 生成完整的 HTTP 访问路径
            const imageUrl = `http://localhost:3000/captcha/${taskId}/${fileName}`;

            // 打印日志，验证生成的 URL 是否正确
            console.log(`生成验证码URL: ${imageUrl}`);
            console.log(`本地图片路径: ${imagePath}`);

            // // 发送给前端的是 HTTP URL，不是本地路径
            // io.emit('captcha-required', {captchaId, imageUrl, type});
            //
            // return new Promise((resolve, reject) => {
            //     pendingPromises[type].captcha = {resolve, reject};
            //     setTimeout(() => reject(new Error('验证码输入超时')), 300000);
            // });

            // 如果已有等待中的 Promise，先 reject
            if (pendingPromises[type].captcha) {
                pendingPromises[type].captcha.reject(new Error('验证码已刷新，请重新输入'));
                pendingPromises[type].captcha = null;
            }

            io.emit('captcha-required', { captchaId, imageUrl, type });
            return new Promise((resolve, reject) => {
                pendingPromises[type].captcha = { resolve, reject };
                setTimeout(() => reject(new Error('验证码输入超时')), 300000);
            });
        };

        const onManualModeRequired = () => {
            io.emit('manual-mode-required', {type});
            return new Promise((resolve, reject) => {
                pendingPromises[type].manual = {resolve, reject};
                // 300s
                setTimeout(() => reject(new Error('手动操作超时')), 300000);

            });
        };


        crawler.crawlWos ?
            crawler.crawlWos(keywords, {
                onCaptchaRequired,
                onManualModeRequired,
                generateExcel,
                captchaDir: taskCaptchaDir,
                outputDir
            }).catch(err => console.error(`${type}爬虫异常:`, err)) :
            crawler.crawlScopus(keywords, {
                onCaptchaRequired,
                onManualModeRequired,
                generateExcel,
                captchaDir: taskCaptchaDir,
                outputDir
            }).catch(err => console.error(`${type}爬虫异常:`, err));

        res.status(202).json({code: 202, msg: `${type}检索已启动`});
    };
}

//  谷歌学术接口（无需回调）
app.post('/api/google/crawl/start', async (req, res) => {
    const {keywords, taskType, generateExcel, outputDir} = req.body; // 参数generateExcel是否生成excel
    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
        return res.status(400).json({code: 400, msg: '关键词数组不能为空'});
    }
    if (googleCrawler.getCrawlerState().isRunning) {
        return res.status(409).json({code: 409, msg: '谷歌爬虫正在运行中'});
    }
    googleCrawler.crawlGoogleScholar(keywords, {
        taskType,
        generateExcel,
        outputDir
    }).catch(err => console.error('谷歌爬虫异常:', err));
    res.status(202).json({code: 202, msg: '谷歌学术检索已启动'});
});

app.post('/api/google/crawl/stop', async (req, res) => {
    try {
        await googleCrawler.stopCrawler();
        res.json({code: 200, msg: '停止信号已发送'});
    } catch (err) {
        res.status(500).json({code: 500, msg: err.message});
    }
});

app.get('/api/google/crawl/status', (req, res) => {
    const state = googleCrawler.getCrawlerState();
    if (state.error) convertErrorScreenshotPath(state.error);
    res.json({code: 200, data: state});
});

app.post('/api/google/crawl/reset', (req, res) => {
    googleCrawler.resetCrawlerState();
    res.json({code: 200, msg: '状态已重置'});
});

app.post('/api/google/crawl/restart', async (req, res) => {
    const {keywords} = req.body;
    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
        return res.status(400).json({code: 400, msg: '关键词数组不能为空'});
    }
    googleCrawler.restartCrawler(keywords).catch(err => console.error('重启异常:', err));
    res.json({code: 200, msg: '已停止当前检索并开始重新执行'});
});

//谷歌学术作者信息检索接口
app.post('/api/google/author/crawl/start', async (req, res) => {
    const {keywords, taskType, generateExcel, outputDir} = req.body;
    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
        return res.status(400).json({code: 400, msg: '作者姓名数组不能为空'});
    }
    if (googleAuthorCrawler.getCrawlerState().isRunning) {
        return res.status(409).json({code: 409, msg: '谷歌学术作者爬虫正在运行中'});
    }
    googleAuthorCrawler.crawlGoogleScholarAuthors(keywords, {
        taskType,
        generateExcel,
        outputDir
    }).catch(err => console.error('谷歌学术作者爬虫异常:', err));
    res.status(202).json({code: 202, msg: '谷歌学术作者检索已启动'});
});

app.post('/api/google/author/crawl/stop', async (req, res) => {
    try {
        await googleAuthorCrawler.stopCrawler();
        res.json({code: 200, msg: '停止信号已发送'});
    } catch (err) {
        res.status(500).json({code: 500, msg: err.message});
    }
});

app.get('/api/google/author/crawl/status', (req, res) => {
    const state = googleAuthorCrawler.getCrawlerState();
    if (state.error) convertErrorScreenshotPath(state.error);
    res.json({code: 200, data: state});
});

app.post('/api/google/author/crawl/reset', (req, res) => {
    googleAuthorCrawler.resetCrawlerState();
    res.json({code: 200, msg: '状态已重置'});
});

//  Scopus 接口
app.post('/api/scopus/crawl/start', createCrawlHandler(scopusCrawler, 'scopus'));

app.post('/api/scopus/crawl/stop', (req, res) => {
    scopusCrawler.stopCrawler();
    if (pendingPromises.scopus.captcha) {
        pendingPromises.scopus.captcha.reject(new Error('用户停止'));
        pendingPromises.scopus.captcha = null;
    }
    if (pendingPromises.scopus.manual) {
        pendingPromises.scopus.manual.reject(new Error('用户停止'));
        pendingPromises.scopus.manual = null;
    }
    res.json({code: 200, msg: '停止信号已发送'});
});

app.get('/api/scopus/crawl/status', (req, res) => {
    const state = scopusCrawler.getCrawlerState();
    if (state.error) convertErrorScreenshotPath(state.error);
    res.json({code: 200, data: state});
});

app.post('/api/scopus/crawl/reset', (req, res) => {
    scopusCrawler.resetCrawlerState();
    res.json({code: 200, msg: '状态已重置'});
});

app.post('/api/scopus/captcha/submit', (req, res) => {
    const {captchaId, captchaCode} = req.body;
    const state = scopusCrawler.getCrawlerState();
    if (state.waitingForCaptcha && state.captchaId === captchaId && pendingPromises.scopus.captcha) {
        pendingPromises.scopus.captcha.resolve(captchaCode);
        pendingPromises.scopus.captcha = null;
        res.json({code: 200, msg: '验证码已提交'});
    } else {
        res.status(404).json({code: 404, msg: '无效的验证码请求'});
    }
});

app.post('/api/scopus/crawl/manual-confirm', (req, res) => {
    const state = scopusCrawler.getCrawlerState();
    if (state.manualModeActive && pendingPromises.scopus.manual) {
        pendingPromises.scopus.manual.resolve();
        pendingPromises.scopus.manual = null;
        res.json({code: 200, msg: '已确认'});
    } else {
        res.status(400).json({code: 400, msg: '未处于手动模式'});
    }
});
// Scopus 作者检索接口
app.post('/api/scopus/author/crawl/start', async (req, res) => {
    const {authors, generateExcel, outputDir} = req.body; // authors 可以是对象数组或字符串数组
    if (!authors || !Array.isArray(authors) || authors.length === 0) {
        return res.status(400).json({code: 400, msg: '作者列表不能为空'});
    }
    if (scopusAuthorCrawler.getCrawlerState().isRunning) {
        return res.status(409).json({code: 409, msg: 'Scopus作者爬虫正在运行中'});
    }
    // 异步执行，不等待结果
    scopusAuthorCrawler.crawlScopusAuthors(authors, {generateExcel, outputDir}).catch(err => {
        console.error('Scopus作者爬虫异常:', err);
    });
    res.status(202).json({code: 202, msg: 'Scopus作者检索已启动'});
});

app.post('/api/scopus/author/crawl/stop', async (req, res) => {
    try {
        await scopusAuthorCrawler.stopCrawler();
        res.json({code: 200, msg: '停止信号已发送'});
    } catch (err) {
        res.status(500).json({code: 500, msg: err.message});
    }
});

app.get('/api/scopus/author/crawl/status', (req, res) => {
    const state = scopusAuthorCrawler.getCrawlerState();
    if (state.error) convertErrorScreenshotPath(state.error);
    res.json({code: 200, data: state});
});

app.post('/api/scopus/author/crawl/reset', (req, res) => {
    scopusAuthorCrawler.resetCrawlerState();
    res.json({code: 200, msg: '状态已重置'});
});
//  WoS 接口
app.post('/api/wos/crawl/start', createCrawlHandler(wosCrawler, 'wos'));

app.post('/api/wos/crawl/stop', (req, res) => {
    wosCrawler.stopCrawler();
    if (pendingPromises.wos.captcha) {
        pendingPromises.wos.captcha.reject(new Error('用户停止'));
        pendingPromises.wos.captcha = null;
    }
    if (pendingPromises.wos.manual) {
        pendingPromises.wos.manual.reject(new Error('用户停止'));
        pendingPromises.wos.manual = null;
    }
    res.json({code: 200, msg: '停止信号已发送'});
});

app.get('/api/wos/crawl/status', (req, res) => {
    const state = wosCrawler.getCrawlerState();
    if (state.error) convertErrorScreenshotPath(state.error);
    res.json({code: 200, data: state});
});

app.post('/api/wos/crawl/reset', (req, res) => {
    wosCrawler.resetCrawlerState();
    res.json({code: 200, msg: '状态已重置'});
});

app.post('/api/wos/captcha/submit', (req, res) => {
    const {captchaId, captchaCode} = req.body;
    const state = wosCrawler.getCrawlerState();
    if (state.waitingForCaptcha && state.captchaId === captchaId && pendingPromises.wos.captcha) {
        pendingPromises.wos.captcha.resolve(captchaCode);
        pendingPromises.wos.captcha = null;
        res.json({code: 200, msg: '验证码已提交'});
    } else {
        res.status(404).json({code: 404, msg: '无效的验证码请求'});
    }
});

app.post('/api/wos/crawl/manual-confirm', (req, res) => {
    const state = wosCrawler.getCrawlerState();
    if (state.manualModeActive && pendingPromises.wos.manual) {
        pendingPromises.wos.manual.resolve();
        pendingPromises.wos.manual = null;
        res.json({code: 200, msg: '已确认'});
    } else {
        res.status(400).json({code: 400, msg: '未处于手动模式'});
    }
});

// WoS 作者检索接口
app.post('/api/wos/author/crawl/start', async (req, res) => {
    const {authors, generateExcel, outputDir} = req.body; // authors 可以是对象数组或字符串数组
    if (!authors || !Array.isArray(authors) || authors.length === 0) {
        return res.status(400).json({code: 400, msg: '作者列表不能为空'});
    }
    if (wosAuthorCrawler.getCrawlerState().isRunning) {
        return res.status(409).json({code: 409, msg: 'WoS作者爬虫正在运行中'});
    }
    // 定义手动登录回调
    const onManualLoginRequired = () => {
        io.emit('manual-login-required', {type: 'wos-author'});
    };
    // 异步执行，不等待结果
    wosAuthorCrawler.crawlWosAuthors(authors, {generateExcel, outputDir, onManualLoginRequired}).catch(err => {
        console.error('WoS作者爬虫异常:', err);
    });
    res.status(202).json({code: 202, msg: 'WoS作者检索已启动'});
});

app.post('/api/wos/author/crawl/stop', async (req, res) => {
    try {
        await wosAuthorCrawler.stopCrawler();
        res.json({code: 200, msg: '停止信号已发送'});
    } catch (err) {
        res.status(500).json({code: 500, msg: err.message});
    }
});

app.get('/api/wos/author/crawl/status', (req, res) => {
    const state = wosAuthorCrawler.getCrawlerState();
    if (state.error) convertErrorScreenshotPath(state.error);
    res.json({code: 200, data: state});
});

app.post('/api/wos/author/crawl/reset', (req, res) => {
    wosAuthorCrawler.resetCrawlerState();
    res.json({code: 200, msg: '状态已重置'});
});

// Socket.io 连接
io.on('connection', (socket) => {
    console.log('前端已连接');
    socket.on('disconnect', () => console.log('前端断开连接'));
});
io.use((socket, next) => {
    const token = socket.handshake.query.token;
    if (token === global.ELECTRON_TOKEN || token === process.env.ELECTRON_TOKEN) {
        return next();
    }
    next(new Error('Authentication error'));
})


// 存储每个干预请求的resolve/reject
const { pendingInterventions } = require('./crawler-utils');
// 手动干预请求处理函数
function requestUserIntervention(socketID, intervention) {
    return new Promise((resolve, reject) => {
        const {id, type, data} = intervention;
        //超时处理(5min)
        const timeout = setTimeout(()=>{
            pendingInterventions.delete(id);
            reject(new Error(`用户干预超时：${type}`));
        },300000);
        pendingInterventions.set(id,{resolve,reject,timeout});
    //     发送统一事件给前端
        io.to(socketID).emit('user-intervention-required',{id,type,data});

    });
}
// 前端完成干预后调用此接口
app.post('/api/user-intervention/complete',(req,res) =>{
    // result可能为验证码字符串（学术猫）或者确认标志（手动确认站点）等
    const {id,result} = req.body;
    const pending = pendingInterventions.get(id);
    if(pending){
        clearTimeout(pending.timeout);
        pendingInterventions.delete(id);
        pending.resolve(result);
        res.json({code:200,msg:'ok'});
    }else {
        res.status(404).json({code:404,msg:'未找到对应的干预请求'});
    }
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
const PORT = process.env.PORT || 3000;

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

module.exports = {app, server, io, startServer};
