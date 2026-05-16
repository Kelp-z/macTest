const { app, BrowserWindow, ipcMain, dialog } = require('electron');

const { startServer, cleanupAllCrawlers} = require('./server');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { machineIdSync  } = require('node-machine-id');
const crypto = require('crypto');
const configManager = require('./src/infrastructure/config-manager');
const {autoUpdater} = require("electron-updater");

// 从配置读取更新源
let updateConfig = null;
let UPDATE_URL =  'http://124.70.184.0:8100/';

// 设置更新源
autoUpdater.setFeedURL({
    provider: 'generic',
    url: UPDATE_URL
});

console.log('更新源已配置:', UPDATE_URL);

// 发现新版本
autoUpdater.on('update-available', (info) => {
    dialog.showMessageBox({
        type: 'info',
        title: '发现新版本',
        message: `发现新版本 ${info.version}，是否下载？`,
        buttons: ['下载', '稍后']
    }).then(({ response }) => {
        if (response === 0) autoUpdater.downloadUpdate();
    });
});

// 下载进度
autoUpdater.on('download-progress', (progressObj) => {
    console.log(`下载进度: ${progressObj.percent}%`);
});

// 下载完成
autoUpdater.on('update-downloaded', () => {
    dialog.showMessageBox({
        type: 'info',
        title: '更新就绪',
        message: '新版本已下载，是否立即安装？',
        buttons: ['安装', '稍后']
    }).then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
    });
});

// 错误处理
autoUpdater.on('error', (err) => {
    console.error('更新检查失败:', err.message);
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

        autoUpdater.setFeedURL({
            provider: 'generic',
            url: UPDATE_URL
        });
        console.log('更新源已配置:', UPDATE_URL);
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
            }, 5000); // 延迟 5 秒，等窗口加载完成
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
