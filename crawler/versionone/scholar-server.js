const express = require('express');
const path = require('path');
const cors = require('cors');
const { crawlGoogleScholar, getCrawlerState, resetCrawlerState, stopCrawler, restartCrawler } = require('./scholar-crawler');

const app = express();
const PORT = 3001;

// 中间件
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 静态资源托管
const publicPath = path.join(__dirname, 'public');
const fs = require('fs');
if (!fs.existsSync(publicPath)) {
    fs.mkdirSync(publicPath, { recursive: true });
}
app.use(express.static(publicPath));

// 首页
app.get('/', (req, res) => {
    const indexPath = path.join(publicPath, 'index.html');
    if (!fs.existsSync(indexPath)) {
        return res.status(404).send('index.html 文件不存在');
    }
    res.sendFile(indexPath);
});

// 启动检索
app.post('/api/crawl/start', async (req, res) => {
    try {
        const { keywords } = req.body;
        if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
            return res.status(400).json({
                code: 400,
                type: 'PARAM_ERROR',
                msg: '请传入非空的关键词数组',
                data: null
            });
        }

        // 异步启动爬虫
        crawlGoogleScholar(keywords).catch(err => {
            console.error('爬虫执行异常：', err);
        });

        res.status(200).json({
            code: 200,
            type: 'SUCCESS',
            msg: '谷歌学术检索已启动，请等待执行完成',
            data: null
        });

    } catch (err) {
        res.status(500).json({
            code: 500,
            type: 'INTERFACE_ERROR',
            msg: `接口启动失败：${err.message}`,
            data: null
        });
    }
});

// 新增：重启检索接口
app.post('/api/crawl/restart', async (req, res) => {
    try {
        const { keywords } = req.body;
        if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
            return res.status(400).json({
                code: 400,
                type: 'PARAM_ERROR',
                msg: '请传入非空的关键词数组',
                data: null
            });
        }

        // 异步重启爬虫
        restartCrawler(keywords).catch(err => {
            console.error('爬虫重启异常：', err);
        });

        res.status(200).json({
            code: 200,
            type: 'SUCCESS',
            msg: '已停止当前检索并开始重新执行，请等待',
            data: null
        });

    } catch (err) {
        res.status(500).json({
            code: 500,
            type: 'INTERFACE_ERROR',
            msg: `重启检索失败：${err.message}`,
            data: null
        });
    }
});

// 新增：停止检索接口
app.post('/api/crawl/stop', async (req, res) => {
    try {
        await stopCrawler();
        res.status(200).json({
            code: 200,
            type: 'SUCCESS',
            msg: '检索任务已停止',
            data: null
        });
    } catch (err) {
        res.status(500).json({
            code: 500,
            type: 'INTERFACE_ERROR',
            msg: `停止检索失败：${err.message}`,
            data: null
        });
    }
});

// 获取状态
// scholar-server.js 中的状态接口（确保返回所有日志）
app.get('/api/crawl/status', (req, res) => {
    const state = getCrawlerState();
    // 确保返回完整的日志数组
    res.status(200).json({
        code: 200,
        data: {
            isRunning: state.isRunning,
            progress: state.progress,
            logs: state.logs, // 完整日志数组
            result: state.result,
            filePaths: state.filePaths,
            error: state.error,
            currentDir: state.currentDir,
            logIndex: state.logIndex // 日志索引
        }
    });
});

// 重置状态
app.post('/api/crawl/reset', (req, res) => {
    resetCrawlerState();
    res.status(200).json({
        code: 200,
        msg: '爬虫状态已重置',
        data: null
    });
});

// 启动服务
app.listen(PORT, () => {
    console.log(`服务已启动：http://localhost:${PORT}`);
    console.log('前端页面地址：http://localhost:3001');
});
