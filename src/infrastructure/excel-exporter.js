// src/infrastructure/excel-exporter.js
const excel = require('excel4node');
const fs = require('fs');
const path = require('path');

class ExcelExporter {
    constructor() {
        this.workbooks = new Map();
    }

    /**
     * 确保目录存在
     */
    _ensureDir(dirPath) {
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
    }

    /**
     * 导出单个列表到 Excel
     * @param {Array} dataList - 数据列表
     * @param {string} filePath - 输出文件路径
     * @param {string} sheetName - 工作表名称
     * @param {Array} headers - 表头配置 [{key, label}]
     * @returns {string} 文件路径
     */
    exportList(dataList, filePath, sheetName, headers) {
        if (!dataList || dataList.length === 0) {
            console.log(`${sheetName} 无数据可写入`);
            return null;
        }

        this._ensureDir(path.dirname(filePath));

        const workbook = new excel.Workbook();
        const worksheet = workbook.addWorksheet(sheetName);

        // 设置表头样式
        const headerStyle = workbook.createStyle({
            font: { bold: true },
            alignment: { horizontal: 'center' }
        });

        // 写入表头
        headers.forEach((header, index) => {
            worksheet.cell(1, index + 1)
                .string(header.label)
                .style(headerStyle);
        });

        // 写入数据
        dataList.forEach((item, rowIndex) => {
            const row = rowIndex + 2;
            headers.forEach((header, colIndex) => {
                const value = item[header.key];
                const cellValue = value !== undefined && value !== null ? String(value) : '';
                worksheet.cell(row, colIndex + 1).string(cellValue);
            });
        });

        // 自动调整列宽（可选）
        headers.forEach((header, index) => {
            worksheet.column(index + 1).setWidth(20);
        });

        workbook.write(filePath);
        console.log(`${sheetName} 已导出到: ${filePath}`);

        return filePath;
    }

    /**
     * 导出 Google Scholar 检索结果
     * @param {Array} successList - 成功列表
     * @param {Array} failedList - 失败列表
     * @param {Object} filePaths - 文件路径配置
     */
    exportGoogleScholarResults(successList, failedList, filePaths) {
        const results = {};

        // 定义 EndNoteInfo 的表头
        const endNoteHeaders = [
            { key: 'recordNumber', label: '记录编号' },
            { key: 'title', label: '标题' },
            { key: 'authors', label: '作者' },
            { key: 'journal', label: '期刊/出版物' },
            { key: 'year', label: '年份' },
            { key: 'volume', label: '卷' },
            { key: 'issue', label: '期' },
            { key: 'pages', label: '页码' },
            { key: 'abstract', label: '摘要' },
            { key: 'doi', label: 'DOI' },
            { key: 'url', label: 'URL链接' },
            { key: 'publicationType', label: '出版类型' },
            { key: 'publisher', label: '出版商' },
            { key: 'citations', label: '引用数' },
            { key: 'citationLink', label: '引用链接' },
            { key: 'remark', label: '备注' },
            { key: 'searchTime', label: '搜索时间' },
            { key: 'resultCountFormatted', label: '结果数量' },
            { key: 'endNoteLink', label: 'EndNote链接' },
            { key: 'downloadedFilePath', label: '下载路径' },
            { key: 'filePath', label: '源文件路径' }
        ];

        // 导出成功列表
        if (successList && successList.length > 0 && filePaths.successExcel) {
            this.exportList(successList, filePaths.successExcel, '成功搜索结果', endNoteHeaders);
            results.successExcel = filePaths.successExcel;
        }

        // 导出失败列表
        if (failedList && failedList.length > 0 && filePaths.failedExcel) {
            this.exportList(failedList, filePaths.failedExcel, '检索失败结果', endNoteHeaders);
            results.failedExcel = filePaths.failedExcel;
        }

        return results;
    }

    /**
     * 导出 EndNote 解析结果
     * @param {Array} endNoteList - EndNote 数据列表
     * @param {string} filePath - 输出文件路径
     * @returns {string|null} 文件路径
     */
    exportEndNoteResults(endNoteList, filePath) {
        if (!endNoteList || endNoteList.length === 0) {
            console.log('EndNote 无数据可写入');
            return null;
        }

        const headers = [
            { key: 'recordNumber', label: '记录编号' },
            { key: 'title', label: '标题' },
            { key: 'authors', label: '作者' },
            { key: 'journal', label: '期刊/出版物' },
            { key: 'year', label: '年份' },
            { key: 'volume', label: '卷' },
            { key: 'issue', label: '期' },
            { key: 'pages', label: '页码' },
            { key: 'abstract', label: '摘要' },
            { key: 'doi', label: 'DOI' },
            { key: 'url', label: 'URL链接' },
            { key: 'publicationType', label: '出版类型' },
            { key: 'publisher', label: '出版商' },
            { key: 'filePath', label: '源文件路径' }
        ];

        return this.exportList(endNoteList, filePath, 'EndNote解析结果', headers);
    }

    /**
     * 导出引用文章列表
     * @param {Array} citingPapers - 引用文章列表
     * @param {string} filePath - 输出文件路径
     * @returns {string|null} 文件路径
     */
    exportCitingPapers(citingPapers, filePath) {
        if (!citingPapers || citingPapers.length === 0) {
            console.log('引用文章无数据可写入');
            return null;
        }

        const headers = [
            { key: 'sourceArticle', label: '源引用文章' },
            { key: 'recordNumber', label: '记录编号' },
            { key: 'title', label: '标题' },
            { key: 'authors', label: '作者' },
            { key: 'journal', label: '期刊/出版物' },
            { key: 'year', label: '年份' },
            { key: 'volume', label: '卷' },
            { key: 'issue', label: '期' },
            { key: 'pages', label: '页码' },
            { key: 'abstract', label: '摘要' },
            { key: 'doi', label: 'DOI' },
            { key: 'url', label: 'URL链接' },
            { key: 'publicationType', label: '出版类型' },
            { key: 'publisher', label: '出版商' },
            { key: 'filePath', label: '源文件路径' }
        ];

        return this.exportList(citingPapers, filePath, '引用文章', headers);
    }

    /**
     * 导出作者信息
     * @param {Array} authorList - 作者列表
     * @param {string} filePath - 输出文件路径
     * @returns {string|null} 文件路径
     */
    exportAuthors(authorList, filePath) {
        if (!authorList || authorList.length === 0) {
            console.log('作者信息无数据可写入');
            return null;
        }

        const headers = [
            { key: 'name', label: '作者姓名' },
            { key: 'affiliation', label: '机构' },
            { key: 'citations', label: '总引用数' },
            { key: 'hIndex', label: 'H指数' },
            { key: 'i10Index', label: 'i10指数' },
            { key: 'publications', label: '论文数量' },
            { key: 'profileUrl', label: '个人主页链接' }
        ];

        return this.exportList(authorList, filePath, '作者信息', headers);
    }

    /**
     * 导出 Google Scholar 作者检索结果
     */
    exportGoogleAuthorResults(authorList, filePath) {
        if (!authorList || authorList.length === 0) {
            console.log('无数据可导出');
            return null;
        }

        this._ensureDir(path.dirname(filePath));

        const workbook = new excel.Workbook();
        const worksheet = workbook.addWorksheet('作者信息');

        // 设置表头样式
        const headerStyle = workbook.createStyle({
            font: { bold: true },
            alignment: { horizontal: 'center' }
        });

        // 定义表头
        const headers = [
            { key: 'searchKeyword', label: '搜索关键词' },
            { key: 'authorName', label: '作者姓名' },
            { key: 'totalHIndex', label: '总计h指数' },
            { key: 'recentHIndex', label: '近期h指数' },
            { key: 'profileUrl', label: '作者档案链接' },
            { key: 'searchTime', label: '检索时间' },
            { key: 'institution', label: '机构名称' },
            { key: 'emailVerified', label: '电子邮件验证' }
        ];

        // 写入表头
        headers.forEach((header, index) => {
            worksheet.cell(1, index + 1).string(header.label).style(headerStyle);
        });

        // 写入数据行
        authorList.forEach((author, rowIndex) => {
            const row = rowIndex + 2; // 从第2行开始（第1行是表头）
            headers.forEach((header, colIndex) => {
                const value = author[header.key];
                const cellValue = value !== undefined && value !== null ? String(value) : '';
                worksheet.cell(row, colIndex + 1).string(cellValue);
            });
        });

        // 自动调整列宽
        headers.forEach((header, index) => {
            worksheet.column(index + 1).setWidth(25);
        });

        workbook.write(filePath);
        console.log(`作者结果已导出到: ${filePath}`);

        return filePath;
    }
    /**
     * 导出 Scopus 作者检索结果
     */
    exportScopusAuthorResults(results, filePath) {
        if (!results || results.length === 0) {
            console.log('Scopus 作者无数据可导出');
            return null;
        }

        this._ensureDir(path.dirname(filePath));

        const workbook = new excel.Workbook();
        const worksheet = workbook.addWorksheet('Scopus作者检索结果');

        // 设置表头样式
        const headerStyle = workbook.createStyle({
            font: { bold: true },
            alignment: { horizontal: 'center' }
        });

        // 定义表头
        const headers = [
            { key: 'seq', label: '序号' },
            { key: 'lastName', label: '检索姓氏 (LastName)' },
            { key: 'firstName', label: '检索名字 (FirstName)' },
            { key: 'totalResults', label: '检索结果总数' },
            { key: 'authorSeq', label: '结果序号' },
            { key: 'authorName', label: '作者姓名' },
            { key: 'scopusId', label: 'Scopus ID' },
            { key: 'orcid', label: 'ORCID' },
            { key: 'hIndex', label: 'H-Index' },
            { key: 'institutionCountry', label: '机构/国家' },
            { key: 'authorUrl', label: '作者链接' }
        ];

        // 写入表头
        headers.forEach((header, index) => {
            worksheet.cell(1, index + 1).string(header.label).style(headerStyle);
        });

        // 写入数据
        let globalSeq = 1;
        let rowIdx = 2;

        for (const search of results) {
            const searchAuthor = search.searchAuthor;
            const totalResults = search.totalResults;
            const authors = search.authors || [];

            if (authors.length === 0) {
                // 无结果
                worksheet.cell(rowIdx, 1).number(globalSeq);
                worksheet.cell(rowIdx, 2).string(searchAuthor.lastName || '');
                worksheet.cell(rowIdx, 3).string(searchAuthor.firstName || '');
                worksheet.cell(rowIdx, 4).number(totalResults);
                worksheet.cell(rowIdx, 5).string('-');
                worksheet.cell(rowIdx, 6).string('-');
                worksheet.cell(rowIdx, 7).string('-');
                worksheet.cell(rowIdx, 8).string('-');
                worksheet.cell(rowIdx, 9).string('-');
                worksheet.cell(rowIdx, 10).string('-');
                worksheet.cell(rowIdx, 11).string('-');
                rowIdx++;
                globalSeq++;
            } else {
                // 有结果
                for (let j = 0; j < authors.length; j++) {
                    const author = authors[j];
                    const details = author.details || {};

                    worksheet.cell(rowIdx, 1).number(globalSeq);
                    worksheet.cell(rowIdx, 2).string(searchAuthor.lastName || '');
                    worksheet.cell(rowIdx, 3).string(searchAuthor.firstName || '');
                    worksheet.cell(rowIdx, 4).number(totalResults);
                    worksheet.cell(rowIdx, 5).number(j + 1);
                    worksheet.cell(rowIdx, 6).string(author.authorName || '');
                    worksheet.cell(rowIdx, 7).string(details.scopusId || '');
                    worksheet.cell(rowIdx, 8).string(details.orcid || '');
                    worksheet.cell(rowIdx, 9).string(details.hIndex || '');
                    worksheet.cell(rowIdx, 10).string(details.institutionCountry || `${author.affiliation} ${author.city} ${author.country}`.trim());
                    worksheet.cell(rowIdx, 11).string(author.authorUrl || '');
                    rowIdx++;
                }
                globalSeq++;
            }
        }

        // 自动调整列宽
        headers.forEach((header, index) => {
            worksheet.column(index + 1).setWidth(20);
        });

        workbook.write(filePath);
        console.log(`Scopus 作者结果已导出到: ${filePath}`);

        return filePath;
    }

    /**
     * 导出 WoS 作者检索结果
     */
    exportWosAuthorResults(authorList, filePath) {
        if (!authorList || authorList.length === 0) {
            console.log('无数据可导出');
            return null;
        }

        this._ensureDir(path.dirname(filePath));

        const workbook = new excel.Workbook();
        const worksheet = workbook.addWorksheet('WoS作者检索结果');

        // 设置表头样式
        const headerStyle = workbook.createStyle({
            font: { bold: true },
            alignment: { horizontal: 'center' }
        });

        // 定义表头
        const headers = [
            { key: 'index', label: '序号' },
            { key: 'familyName', label: '检索姓氏 (LastName)' },
            { key: 'givenName', label: '检索名字 (FirstName)' },
            { key: 'totalResults', label: '检索结果总数' },
            { key: 'authorName', label: '作者姓名' },
            { key: 'authorUrl', label: '作者链接' },
            { key: 'institution', label: '机构' },
            { key: 'location', label: '国家/地区' },
            { key: 'researcherId', label: 'ResearcherID' },
            { key: 'orcid', label: 'ORCID' },
            { key: 'hIndex', label: 'H-Index' }
        ];

        // 写入表头
        headers.forEach((header, index) => {
            worksheet.cell(1, index + 1).string(header.label).style(headerStyle);
        });

        // 写入数据行
        let rowIdx = 2;
        let globalSeq = 1;

        authorList.forEach((searchResult) => {
            const authors = searchResult.authors || [];

            if (authors.length === 0) {
                // 无结果的作者
                worksheet.cell(rowIdx, 1).number(globalSeq);
                worksheet.cell(rowIdx, 2).string(searchResult.familyName || '');
                worksheet.cell(rowIdx, 3).string(searchResult.givenName || '');
                worksheet.cell(rowIdx, 4).number(searchResult.totalResults || 0);
                worksheet.cell(rowIdx, 5).string('-');
                worksheet.cell(rowIdx, 6).string('-');
                worksheet.cell(rowIdx, 7).string('-');
                worksheet.cell(rowIdx, 8).string('-');
                worksheet.cell(rowIdx, 9).string('-');
                worksheet.cell(rowIdx, 10).string('-');
                worksheet.cell(rowIdx, 11).string('-');
                rowIdx++;
                globalSeq++;
            } else {
                // 有结果的作者
                authors.forEach((author, j) => {
                    worksheet.cell(rowIdx, 1).number(globalSeq);
                    worksheet.cell(rowIdx, 2).string(searchResult.familyName || '');
                    worksheet.cell(rowIdx, 3).string(searchResult.givenName || '');
                    worksheet.cell(rowIdx, 4).number(searchResult.totalResults || 0);
                    worksheet.cell(rowIdx, 5).string(author.authorName || '-');
                    worksheet.cell(rowIdx, 6).string(author.authorUrl || '-');
                    worksheet.cell(rowIdx, 7).string(author.institution || '-');
                    worksheet.cell(rowIdx, 8).string(author.location || '-');
                    worksheet.cell(rowIdx, 9).string(author.researcherId || '-');
                    worksheet.cell(rowIdx, 10).string(author.orcid || '-');
                    worksheet.cell(rowIdx, 11).string(author.hIndex || '-');
                    rowIdx++;
                });
                globalSeq++;
            }
        });

        // 自动调整列宽
        headers.forEach((header, index) => {
            worksheet.column(index + 1).setWidth(20);
        });

        workbook.write(filePath);
        console.log(`WoS 作者结果已导出到: ${filePath}`);

        return filePath;
    }


    /**
     * 导出 WoS 收录检测结果
     */
    exportWosResults(results, filePath) {
        this.logger.info(`导出 WoS 结果到: ${filePath}`);

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Web of Science');

        const columnConfig = [
            { key: 'isRecruit', header: '是否收录', width: 10 },
            { key: 'accessionNo', header: '入藏号', width: 20 },
            { key: 'title', header: '论文标题', width: 80 },
            { key: 'searchTime', header: '检索时间', width: 20 },
            { key: 'indexedDate', header: 'Indexed日期', width: 15 }
        ];

        worksheet.columns = columnConfig.map(item => ({
            header: item.header,
            key: item.key,
            width: item.width
        }));

        results.forEach(item => worksheet.addRow(item));

        // 确保目录存在
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        workbook.xlsx.writeFile(filePath)
            .then(() => {
                this.logger.info(`WoS 结果导出成功: ${results.length} 条记录`);
            })
            .catch(err => {
                this.logger.error(`WoS 结果导出失败: ${err.message}`);
                throw err;
            });
    }

    /**
     * 导出 WoS 收录检测结果
     */
    exportWosResults(results, filePath) {
        if (!results || results.length === 0) {
            console.log('WoS 无数据可导出');
            return null;
        }

        this._ensureDir(path.dirname(filePath));

        const workbook = new excel.Workbook();
        const worksheet = workbook.addWorksheet('Web of Science');

        // 设置表头样式
        const headerStyle = workbook.createStyle({
            font: { bold: true },
            alignment: { horizontal: 'center' }
        });

        // 定义表头
        const headers = [
            { key: 'isRecruit', label: '是否收录' },
            { key: 'accessionNo', label: '入藏号' },
            { key: 'title', label: '论文标题' },
            { key: 'searchTime', label: '检索时间' },
            { key: 'indexedDate', label: 'Indexed日期' }
        ];

        // 写入表头
        headers.forEach((header, index) => {
            worksheet.cell(1, index + 1).string(header.label).style(headerStyle);
        });

        // 写入数据行
        results.forEach((item, rowIndex) => {
            const row = rowIndex + 2;
            headers.forEach((header, colIndex) => {
                const value = item[header.key];
                const cellValue = value !== undefined && value !== null ? String(value) : '';
                worksheet.cell(row, colIndex + 1).string(cellValue);
            });
        });

        // 自动调整列宽
        headers.forEach((header, index) => {
            worksheet.column(index + 1).setWidth(25);
        });

        workbook.write(filePath);
        console.log(`WoS 结果已导出到: ${filePath}`);

        return filePath;
    }

    /**
     * 导出 Scopus 收录检测结果
     */
    exportScopusResults(results, filePath) {
        if (!results || results.length === 0) {
            console.log('Scopus 无数据可导出');
            return null;
        }

        this._ensureDir(path.dirname(filePath));

        const workbook = new excel.Workbook();
        const worksheet = workbook.addWorksheet('Scopus');

        // 设置表头样式
        const headerStyle = workbook.createStyle({
            font: { bold: true },
            alignment: { horizontal: 'center' }
        });

        // 定义表头
        const headers = [
            { key: 'eid', label: 'EID' },
            { key: 'isRecruit', label: '是否收录' },
            { key: 'title', label: '论文标题' },
            { key: 'searchTime', label: '检索时间' },
            { key: 'doi', label: 'DOI' },
            { key: 'pubDate', label: '出版日期' }
        ];

        // 写入表头
        headers.forEach((header, index) => {
            worksheet.cell(1, index + 1).string(header.label).style(headerStyle);
        });

        // 写入数据行
        results.forEach((item, rowIndex) => {
            const row = rowIndex + 2;
            headers.forEach((header, colIndex) => {
                const value = item[header.key];
                const cellValue = value !== undefined && value !== null ? String(value) : '';
                worksheet.cell(row, colIndex + 1).string(cellValue);
            });
        });

        // 自动调整列宽
        headers.forEach((header, index) => {
            worksheet.column(index + 1).setWidth(25);
        });

        workbook.write(filePath);
        console.log(`Scopus 结果已导出到: ${filePath}`);

        return filePath;
    }




}

module.exports = ExcelExporter;



