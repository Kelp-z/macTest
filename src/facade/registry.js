// 统一注册所有 crawler
const { createGoogleCrawlerFacade } = require('./adapters/google');
const { createScopusCrawlerFacade } = require('./adapters/scopus');
const { createWosCrawlerFacade } = require('./adapters/wos');
const { createGoogleAuthorCrawlerFacade } = require('./adapters/google-author');
const { createScopusAuthorCrawlerFacade } = require('./adapters/scopus-author');
const { createWosAuthorCrawlerFacade } = require('./adapters/wos-author');

function createCrawlerRegistry() {
    const facades={
        google: createGoogleCrawlerFacade,
        scopus: createScopusCrawlerFacade,
        wos: createWosCrawlerFacade,
        'google-author': createGoogleAuthorCrawlerFacade,
        'scopus-author': createScopusAuthorCrawlerFacade,
        'wos-author': createWosAuthorCrawlerFacade,
    };
    // 缓存正在运行的 facade 实例
    const activeInstances = new Map();

    function getCrawlerFacade(source) {
        // 如果有正在运行的实例，直接返回
        if (activeInstances.has(source)) {
            return activeInstances.get(source);
        }
        // 否则创建新实例（这通常发生在启动爬虫时）
        const factory = facades[source];
        if (!factory) {
            throw new Error(`未知爬虫来源: ${source}`);
        }
        const facade = factory();
        activeInstances.set(source, facade);   // 自动缓存
        return facade;
    }
    // 列出当前注册的所有爬虫 facade 名称
    function listCrawlerFacades() {
        return Object.keys(facades);
    }
    // 外部手动注册
    function setActiveFacade(source, facade) {
        activeInstances.set(source, facade);
    }
    // 爬虫结束后移除实例
    function removeActiveFacade(source) {
        activeInstances.delete(source);
    }
    function getExistingFacade(source) {
        return activeInstances.get(source) || null;
    }

    /**
     * 启动某类爬虫前：仅停止其它来源的爬取逻辑，不关浏览器/标签
     * （共享浏览器单窗口多标签：Scholar 标签在切到 WoS 时保留）
     * @param {string} exceptSource
     */
    async function releaseOtherFacades(exceptSource) {
        for (const [source, facade] of activeInstances.entries()) {
            if (source === exceptSource) continue;
            try {
                const state = typeof facade.getState === 'function' ? await facade.getState() : null;
                if (state && state.isRunning && typeof facade.stop === 'function') {
                    console.log(`[registry] 切换任务：停止 ${source} 爬取（浏览器常驻，标签保留）`);
                    await facade.stop().catch(() => {});
                }
                // 不再 resetState / 强制关浏览器
            } catch (e) {
                console.warn(`[registry] 停止 ${source} 失败: ${e.message}`);
            }
        }
    }

    return {
        getCrawlerFacade,
        setActiveFacade,
        removeActiveFacade,
        getExistingFacade,
        releaseOtherFacades,
        listCrawlerFacades: () => Object.keys(facades),
    };
}
module.exports = {createCrawlerRegistry};
