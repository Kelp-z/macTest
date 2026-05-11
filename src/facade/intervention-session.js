// 管理 captcha/manual 的  promise

function createInterventionSession(timeoutMs = 300000) {
    const store = new Map();
    // source => { captcha: { resolve,reject,timeout,captchaId }, manual: { ... } }
    function ensureSource(source) {
        if (!store.has(source)) {
            // 如果该 source 未初始化分组，则新建状态对象
            store.set(source, { captcha: null, manual: null });
        }
        return store.get(source);
    }
    function createCaptchaPromise(source, captchaId) {
        const sourceMap = ensureSource(source);
        if(sourceMap.captcha) {
            sourceMap.captcha.reject(new Error('验证码刷新，请重新输入'));
            clearTimeout(sourceMap.captcha.timeout);
            sourceMap.captcha = null;
        }
        return new Promise((resolve, reject) => {
            const timeout  = setTimeout(() => {
                sourceMap.captcha = null;
                reject(new Error('验证码输入超时'));
            }, timeoutMs);
            sourceMap.captcha = { resolve, reject, timeout, captchaId };

        });
    }
    function submitCaptcha(source, captchaId, captchaCode) {
        const sourceMap = ensureSource(source);
        if(!sourceMap.captcha ) return{ok:false,msg:'无效的验证码请求'};
        if(sourceMap.captcha.captchaId !== captchaId) return{ok:false,msg:'验证码ID不匹配'};
        clearTimeout(sourceMap.captcha.timeout);
        // 通知等待验证码输入的异步操作，输入已完成，并传回验证码结果。
        sourceMap.captcha.resolve(captchaCode);
        sourceMap.captcha = null;
        return {ok:true,msg:'验证码已提交'};
    }
    function createManualPromise(source){
        const sourceMap = ensureSource(source);
        if(sourceMap.manual){
            sourceMap.manual.reject(new Error('新的手动操作已覆盖旧请求'));
            clearTimeout(sourceMap.manual.timeout);
            sourceMap.manual = null;
        }
        return new Promise((resolve,reject)=>{
            const timeout = setTimeout(()=>{
                sourceMap.manual = null;
                reject(new Error('手动操作超时'))
            },timeoutMs);
            sourceMap.manual = {resolve,reject,timeout}
        });
    }
    function confirmManual(source){
        const sourceMap = ensureSource(source);
        if(!sourceMap.manual) return{ok:false,msg:'未处于手动模式'};

        clearTimeout(sourceMap.manual.timeout);
        sourceMap.manual.resolve();
        sourceMap.manual = null;
        return{ok:true,msg:'手动模式已确认'};
    }
    function cancelSource(source,reason='用户停止'){
        const sourceMap = ensureSource(source);
        if(sourceMap.captcha){
            clearTimeout(sourceMap.captcha.timeout);
            sourceMap.captcha.reject(new Error(reason));
            sourceMap.captcha = null;
        }
        if(sourceMap.manual){
            clearTimeout(sourceMap.manual.timeout);
            sourceMap.manual.reject(new Error(reason));
            sourceMap.manual = null;
        }
    }

    return {
        createCaptchaPromise,
        submitCaptcha,
        createManualPromise,
        confirmManual,
        cancelSource
    };

}

module.exports = {createInterventionSession};
