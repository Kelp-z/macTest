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
    return {
        getCrawlerFacade,
        setActiveFacade,
        removeActiveFacade,
        getExistingFacade,
        listCrawlerFacades: () => Object.keys(facades),
    };
}
module.exports = {createCrawlerRegistry};
