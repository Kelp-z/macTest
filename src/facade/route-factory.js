const path = require('path');
const fs = require('fs');

function registerCrawlerRoutes({
                                   app,
                                   basePath,
                                   facade,
                                   io,
                                   session,
                                   validateInput,
                                   inputFieldName = 'keywords',
                                   startSuccessMsg = '检索已启动',
                                   convertErrorScreenshotPath
                               }) {
    app.post(`${basePath}/start`, async (req, res) => {
        const inputList = req.body[inputFieldName];
        // 如果传入了validateInput函数，就用它对inputList进行校验，将错误信息赋值给errMsg；如果没有提供校验函数，则errMsg为null。
        const errMsg = validateInput ? validateInput(inputList) : null;

        if (errMsg) return res.status(400).json({code: 400, msg: errMsg});

        const state = await facade.getState();
        if (state.isRunning) {
            return res.status(409).json({code: 409, msg: `${facade.capabilities.source}爬虫正在运行中`})
        }

        const taskId = `${facade.capabilities.source}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        const taskType = req.body.taskType || `${facade.capabilities.source.toUpperCase()}_SEARCH`;

        const callbacks = {};
        let taskCaptchaDir;
        // if (facade.capabilities.supportsCaptcha) {
        //     taskCaptchaDir = path.join(process.cwd(), 'captcha_temp', taskId);
        //     if (!fs.existsSync(taskCaptchaDir)) {
        //         fs.mkdirSync(taskCaptchaDir, {recursive: true});
        //     }
        // }
        // if (facade.capabilities.supportsCaptcha) {
        //     callbacks.onCaptchaRequired = ({captchaId, imagePath}) => {
        //         // const fileName = path.basename(imagePath);
        //         // const imageUrl = `http://localhost:3000/captcha/${taskId}/${fileName}`;
        //         // io.emit('captcha-required', {captchaId, imageUrl, type: facade.capabilities.source});
        //         return session.createCaptchaPromise(facade.capabilities.source, captchaId);
        //     };
        // }
        //
        // if (facade.capabilities.supportsManualMode) {
        //     callbacks.onManualModeRequired = () => {
        //         // io.emit('manual-mode-required', {type: facade.capabilities.source});
        //         return session.createManualPromise(facade.capabilities.source);
        //
        //     }
        // }

        // if (facade.capabilities.supportsManualLogin) {
        //     callbacks.onManualLoginRequired = () => {
        //         io.emit('manual-login-required', {type: facade.capabilities.source});
        //     };
        // }
        const hasIntervention = (type) => {
            return Array.isArray(facade.capabilities.interventionTypes) &&
                facade.capabilities.interventionTypes.includes(type);
        };

        if (hasIntervention('captcha')) {
            taskCaptchaDir = path.join(process.cwd(), 'captcha_temp', taskId);
            if (!fs.existsSync(taskCaptchaDir)) {
                fs.mkdirSync(taskCaptchaDir, {recursive: true});
            }

            callbacks.onCaptchaRequired = ({captchaId, imagePath}) => {
                return session.createCaptchaPromise(facade.capabilities.source, captchaId);
            };
        }

        if (hasIntervention('manual')) {
            callbacks.onManualModeRequired = () => {
                return session.createManualPromise(facade.capabilities.source);
            }
        }

        if (hasIntervention('manual-login')) {
            callbacks.onManualLoginRequired = () => {
                io.emit('manual-login-required', {type: facade.capabilities.source});
            };
        }
        if (hasIntervention('captcha-manual')) {
            callbacks.onManualLoginRequired = () => {
                io.emit('captcha-manual-required', {type: facade.capabilities.source});
            };
        }
        facade.start(inputList, {
            taskId,
            taskType,
            generateExcel: req.body.generateExcel,
            outputDir: req.body.outputDir,
            ...(taskCaptchaDir ? { captchaDir: taskCaptchaDir } : {}),
            // 将定义在 callbacks 对象中的回调函数作为参数,动态地把对应的回调函数注册到任务参数中
            ...callbacks
        }).catch((err) => {
            console.error(`${facade.capabilities.source}爬虫异常:`, err);
        });
        return res.status(202).json({code: 202, msg: startSuccessMsg});
    });

    app.post(`${basePath}/stop`, async (req, res) => {
        try {
            await facade.stop();
            session.cancelSource(facade.capabilities.source, '用户停止');
            res.json({code: 200, msg: '停止信号已发送'});
        } catch (err) {
            res.status(500).json({code: 500, msg: err.message});
        }
    });

    app.post(`${basePath}/reset`, (req, res) => {
        facade.resetState();
        res.json({code: 200, msg: '状态已重置'});
    })

    app.get(`${basePath}/status`, async (req, res) => {
        const state = await facade.getState();
        if (state.error && typeof convertErrorScreenshotPath === 'function') {
            convertErrorScreenshotPath(state.error);
        }
        res.json({code: 200, data: state});
    });
}

module.exports = {registerCrawlerRoutes};
