const { app, BrowserWindow, ipcMain, dialog } = require('electron');

const path = require('path');
const fs = require('fs');
const os = require('os');
const { machineIdSync  } = require('node-machine-id');
const crypto = require('crypto');
const configManager = require('./src/infrastructure/config-manager');
const {autoUpdater} = require("electron-updater");
const log = require('electron-log');

// 全局未捕获异常捕获 —— 防止进程崩溃
process.on('uncaughtException', (err) => {
    console.error('[全局] 未捕获的异常:', err.message);
    // 不要调用 app.quit()，让应用继续运行
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('[全局] 未处理的 Promise 拒绝:', reason?.message || reason);
    // 特别处理 playwright-extra 的 CDP 错误
    if (reason && typeof reason.message === 'string' &&
        reason.message.includes('Target page, context or browser has been closed')) {
        console.warn('[全局] 忽略浏览器已关闭的残余 CDP 命令');
        return;  // 吞掉这个错误，不崩溃
    }
});
// 读取配置
const config = configManager.getConfig();

// 计算日志目录：优先用户配置，其次尝试安装目录，最后回退文档目录
let logBaseDir = config.LOG_BASE_DIR;

if (!logBaseDir) {
    // 打包后：安装目录（exe 所在目录）；开发时：项目根目录
    const baseDir = app.isPackaged
        ? path.dirname(process.execPath)   // 如 C:\Program Files\SPM_Crawler 或 D:\SPM_Crawler
        : __dirname;                        // 开发时：项目根目录 D:\springboot\spm\SPM_Retriever

    const installLogDir = path.join(baseDir, 'log');

    try {
        // 尝试创建目录
        if (!fs.existsSync(installLogDir)) {
            fs.mkdirSync(installLogDir, { recursive: true });
        }
        // 关键：测试是否真的有写入权限
        const testFile = path.join(installLogDir, '.write-test');
        fs.writeFileSync(testFile, 'test');
        fs.unlinkSync(testFile);

        logBaseDir = installLogDir;
        console.log(`[system] 日志目录（安装目录）: ${logBaseDir}`);
    } catch (err) {
        // 无权限（如 C:\Program Files），回退到文档目录
        console.warn(`[system] 安装目录无写入权限，回退到文档目录: ${err.message}`);
        logBaseDir = path.join(app.getPath('documents'), 'SPM_Crawler', 'logs');
        fs.mkdirSync(logBaseDir, { recursive: true });
    }
}

// 同步给全局
global.globalConfig = {
    ...config,
    LOG_BASE_DIR: logBaseDir
};
const { startServer, cleanupAllCrawlers} = require('./server');
// 统一文件名
const date = new Date().toISOString().slice(0, 10);
const logFile = path.join(logBaseDir, `app_${date}.log`);

// 配置主进程 electron-log
log.transports.file.resolvePathFn  = () => logFile;

// 替换 console
Object.assign(console, log.functions);

// 标记系统日志
const originalLog = console.log;
console.log = (...args) => {
    originalLog('[system]', ...args);
};

// 渲染进程日志 IPC
ipcMain.handle('log-info', (event, msg) => {
    console.log(`[renderer] ${msg}`);
});
ipcMain.handle('log-error', (event, msg) => {
    console.error(`[renderer] ${msg}`);
});

// 从配置读取更新源
let updateConfig = null;
let UPDATE_URL =  'http://124.70.184.0:8100/';
let AUTO_DOWNLOAD = true;  // 默认自动下载

// 设置更新源
autoUpdater.setFeedURL({
    provider: 'generic',
    url: UPDATE_URL
});

console.log('更新源已配置:', UPDATE_URL);

// 发现新版本
autoUpdater.on('update-available', (info) => {
    console.log('[update] 发现新版本:', info.version);
    if (AUTO_DOWNLOAD) {
        // 自动下载模式：提示用户即将自动下载
        dialog.showMessageBox({
            type: 'info',
            title: '发现新版本',
            message: `发现新版本 ${info.version}，将自动下载。\n下载完成后将提示您安装。`,
            buttons: ['知道了']
        });
        // 自动开始下载（不需要用户点击）
        autoUpdater.downloadUpdate().catch(err => {
            console.error('[update] 自动下载失败:', err);
            dialog.showErrorBox('下载更新失败', err.message || err.toString());
        });
    } else {
        // 手动模式：询问用户是否下载
        dialog.showMessageBox({
            type: 'info',
            title: '发现新版本',
            message: `发现新版本 ${info.version}，是否下载？\n（文件较大，请保持网络畅通）`,
            buttons: ['下载', '稍后'],
            defaultId: 0,
            cancelId: 1
        }).then(({ response }) => {
            if (response === 0) {
                console.log('[update] 用户确认下载');
                autoUpdater.downloadUpdate().catch(err => {
                    console.error('[update] 下载失败:', err);
                    dialog.showErrorBox('下载更新失败', err.message || err.toString());
                });
            } else {
                console.log('[update] 用户选择稍后');
            }
        });
    }
});

// 下载进度（给用户明确反馈）
autoUpdater.on('download-progress', (progressObj) => {
    const percent = progressObj.percent.toFixed(1);
    const mb = (progressObj.transferred / 1024 / 1024).toFixed(1);
    const total = (progressObj.total / 1024 / 1024).toFixed(1);
    console.log(`[update] 进度: ${percent}% (${mb}MB / ${total}MB)`);
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-progress', {
            percent: parseFloat(percent),
            transferred: parseFloat(mb),
            total: parseFloat(total)
        });
    }
});

// 下载完成
autoUpdater.on('update-downloaded', (info) => {
    console.log('[update] 下载完成:', info.version);
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-downloaded', {version: info.version});
    }
    dialog.showMessageBox({
        type: 'info',
        title: '更新就绪',
        message: `新版本 ${info.version} 已下载完成，是否立即安装并重启？`,
        buttons: ['立即安装', '稍后']
    }).then(({ response }) => {
        if (response === 0) {
            console.log('[update] 用户确认安装');
            autoUpdater.quitAndInstall(false, true);
        }
    });
});

// 全局错误捕获
autoUpdater.on('error', (err) => {
    console.error('[update] 全局错误:', err);
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-error', err.message || err.toString());
    }
    dialog.showErrorBox('自动更新错误', err.message || err.toString());
});

let mainWindow;

// 生成一个随机 Token
const ELECTRON_TOKEN = crypto.randomBytes(32).toString('hex');

// 在 preload 中暴露的 API 增加获取 token 的方法
ipcMain.handle('get-electron-token', () => {
    return ELECTRON_TOKEN;
});
function initUpdater() {
    try {
        updateConfig = configManager.getUpdateConfig();
        UPDATE_URL = updateConfig.UPDATE_URL || 'http://124.70.184.0:8100/';
        AUTO_DOWNLOAD = updateConfig.AUTO_DOWNLOAD !== false;  // 默认 true

        autoUpdater.setFeedURL({
            provider: 'generic',
            url: UPDATE_URL
        });
        console.log('[system] 更新源已配置:', UPDATE_URL);
        console.log('[system] 自动下载更新:', AUTO_DOWNLOAD);
    } catch (err) {
        console.error('读取更新配置失败，使用默认地址:', err.message);
        autoUpdater.setFeedURL({
            provider: 'generic',
            url: UPDATE_URL
        });
    }
}
app.whenReady().then(async () => {
    // if (updateConfig.AUTO_CHECK !== false) {
    //     // 启动时检查
    //     setTimeout(() => {
    //         autoUpdater.checkForUpdatesAndNotify().catch(err => {
    //             console.error('检查更新失败:', err.message);
    //         });
    //     }, 3000);
    //
    //     // 定时检查（如果配置了间隔）
    //     if (updateConfig.CHECK_INTERVAL > 0) {
    //         setInterval(() => {
    //             autoUpdater.checkForUpdatesAndNotify().catch(err => {
    //                 console.error('定时检查更新失败:', err.message);
    //             });
    //         }, updateConfig.CHECK_INTERVAL);
    //     }
    // }
    try {
        initUpdater();
        const localPort = configManager.getLocalPort();
        await startServer(localPort, ELECTRON_TOKEN);  // 启动 Express 服务器
        createWindow();
        //  窗口创建后再检查更新（避免更新弹窗在窗口前弹出）
        if (updateConfig?.AUTO_CHECK !== false) {
            setTimeout(() => {
                autoUpdater.checkForUpdatesAndNotify().catch(err => {
                    console.error('检查更新失败:', err.message);
                });
            }, 5000);
        }
    } catch (err) {
        console.error('服务器启动失败:', err);
        app.quit();
    }
});

// 生成机器码
function getHashedMachineId() {
    try {
        const rawId = machineIdSync (); // 原始系统ID
        const salt = 'spm-secret-salt';
        const hashed = crypto.createHash('sha256').update(rawId + salt).digest('hex');
        return hashed;
    } catch (error) {
        console.error('获取机器码失败:', error);
        // 生成随机UUID并持久化到用户数据目录
        const fallbackId = getOrCreateFallbackId();
        return crypto.createHash('sha256').update(fallbackId).digest('hex');
    }
}

// 生成随机UUID并保存到用户数据目录
function getOrCreateFallbackId() {
    const userDataPath = app.getPath('userData');
    const idFile = path.join(userDataPath, 'machine-id');
    if (fs.existsSync(idFile)) {
        return fs.readFileSync(idFile, 'utf8');
    } else {
        const { v4: uuidv4 } = require('uuid');
        const newId = uuidv4();
        fs.writeFileSync(idFile, newId, 'utf8');
        return newId;
    }
}

ipcMain.handle('get-machine-code', () => {
    return getHashedMachineId();
})




function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        autoHideMenuBar: true, // 启用菜单栏自动隐藏
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });
    const localPort = configManager.getLocalPort();
    const url = `http://localhost:${localPort}/?token=${ELECTRON_TOKEN}`
    mainWindow.loadURL(url);
    // mainWindow.webContents.openDevTools(); // 控制台
    // debugger;
    // 监听窗口关闭
    mainWindow.on('close', (e) => {
        e.preventDefault(); // 阻止默认关闭

        dialog.showMessageBox(mainWindow, {
            type: 'question',
            buttons: ['退出', '取消'],
            title: '确认退出',
            message: '你确定要退出应用吗？',
            cancelId: 1,
        }).then(async (result) => {
            if (result.response === 0) { // 用户点击退出
                // 通知渲染进程准备退出
                mainWindow.webContents.send('app-quit-request');

                // 设置超时，防止前端无响应
                const timeout = setTimeout(() => {
                    forceQuit();
                }, 1000); // 1秒超时

                // 等待前端确认
                ipcMain.once('quit-confirmed', async () => {
                    clearTimeout(timeout);
                    try {
                        console.log('清理服务器资源...');
                        await cleanupAllCrawlers();
                    } catch (err) {
                        console.error('清理服务器资源失败:', err);
                    }

                    forceQuit();

                });
            }
        });
    });
}

function forceQuit() {
    mainWindow.removeAllListeners('close');
    mainWindow.close();
    app.quit();
}
// 处理渲染进程的文件夹选择请求
ipcMain.handle('select-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
    });
    if (!result.canceled && result.filePaths.length > 0) {
        return result.filePaths[0];   // 返回选中的目录绝对路径
    }
    return null;
});
ipcMain.handle('show-prompt', async (event, options) => {
    console.log('收到 show-prompt 调用，options:', options);
    const { response, checkboxChecked, inputValue } = await dialog.showMessageBox({
        type: 'question',
        buttons: ['确定', '取消'],
        defaultId: 0,
        cancelId: 1,
        title: options.title || '输入',
        message: options.message || '请输入：',
        detail: options.detail || '',
        input: true,          // 启用输入框
        inputPlaceholder: options.placeholder || '可选',
        inputValue: options.defaultValue || ''
    });
    if (response === 0) {
        return inputValue;    // 用户点击确定，返回输入的内容
    } else {
        return null;          // 用户取消
    }
});

// 显示普通消息框（无输入框）
ipcMain.handle('show-message-box', async (event, options) => {
    const { response } = await dialog.showMessageBox({
        type: options.type || 'info',
        buttons: options.buttons || ['确定'],
        defaultId: 0,
        title: options.title || '提示',
        message: options.message || '',
        detail: options.detail || '',
        //showMessageBox 默认会播放系统提示音
    });
    return response; // 返回按下的按钮索引
});
ipcMain.handle('show-confirm-box', async (event, options) => {
    const { response } = await dialog.showMessageBox({
        type: options.type || 'question',
        buttons: ['确定', '取消'],
        defaultId: 0,
        cancelId: 1,
        title: options.title || '确认',
        message: options.message || '',
        detail: options.detail || ''
    });
    return response === 0; // true 表示确定
});
ipcMain.handle('get-default-output-dir', () => {
    // 获取main.js 所在项目根目录
    const projectDir = __dirname;
    // 上级目录
    const parentDir = path.join(projectDir, '..');
    // 目标 output 目录
    const outputDir = path.join(parentDir, 'output');

    // 确保目录存在（同步创建，如果不存在则递归创建）
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
        console.log(`已创建默认输出目录: ${outputDir}`);
    }

    return outputDir;
});
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
