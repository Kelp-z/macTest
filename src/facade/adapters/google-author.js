const GoogleScholarAuthorCrawler = require('../../crawlers/google-scholar-author-crawler');
function createGoogleAuthorCrawlerFacade() {
    const crawler = new GoogleScholarAuthorCrawler();

    return {
        async start(authors, options = {}) {
            await crawler.crawl({ keywords: authors, options });
        },
        async stop() {
            await crawler.stop();
        },
        getState() {
            return crawler.getState();
        },
        resetState() {
             crawler.resetState();
        },
        capabilities: {
            source: 'google-author',
            inputType: 'authors',
            supportsIntervention: true,
            interventionTypes: [ 'captcha-manual']
        }
    };
}

module.exports = {createGoogleAuthorCrawlerFacade};
