const fs = require('fs');
const path = require('path');

class ConfigManager {
  constructor() {
    this.config = null;
    this.configPath = this.findConfigFile();
    this.loadConfig();
  }

  findConfigFile() {
    // 查找配置文件的顺序
    const possiblePaths = [
      path.join(process.cwd(), 'config.json'),
      path.join(path.dirname(process.execPath), 'config.json'),
      path.join(__dirname, 'config.json'),
      path.join(process.cwd(), 'config', 'config.json')
    ];

    for (const configPath of possiblePaths) {
      if (fs.existsSync(configPath)) {
        console.log(`找到配置文件: ${configPath}`);
        return configPath;
      }
    }

    console.log('未找到配置文件，使用默认配置');
    return null;
  }

  loadConfig() {
    const defaultConfig = this.getDefaultConfig();
    
    if (this.configPath && fs.existsSync(this.configPath)) {
      try {
        const configContent = fs.readFileSync(this.configPath, 'utf8');
        const userConfig = JSON.parse(configContent);
        
        // 深度合并配置
        this.config = this.deepMerge(defaultConfig, userConfig);
        console.log('配置文件加载成功');
      } catch (error) {
        console.error('配置文件解析失败，使用默认配置:', error.message);
        this.config = defaultConfig;
      }
    } else {
      this.config = defaultConfig;
      // 创建默认配置文件
      this.createDefaultConfigFile();
    }

    // 初始化路径
    this.initPaths();
  }

  getDefaultConfig() {
    return {
      version: "1.0.0",
      output: {
        baseDir: "./output",
        subDirs: {
          screenshots: "screenshots",
          endnoteDownloads: "endnote_downloads",
          logs: "logs",
          data: "data"
        },
        fileNames: {
          successExcel: "google_scholar_success_data",
          failedExcel: "google_scholar_failed_data",
          endnoteExcel: "endnote_parsed_data"
        },
        useTimestamp: true,
        timestampFormat: "YYYYMMDD_HHmmss"
      },
      search: {
        preciseSearchEnabled: true,
        titleSimilarityThreshold: 0.8,
        maxResults: 10,
        delayBetweenSearches: {
          min: 3000,
          max: 7000
        }
      },
      browser: {
        localBrowserDir: "browsers",
        autoDownloadIfMissing: true,
        headless: false,
        viewport: {
          width: 1920,
          height: 1080
        },
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      },
      debug: {
        enableLogging: true,
        logLevel: "info",
        saveScreenshots: true,
        saveErrorLogs: true
      }
    };
  }

  deepMerge(target, source) {
    const output = Object.assign({}, target);
    
    if (this.isObject(target) && this.isObject(source)) {
      Object.keys(source).forEach(key => {
        if (this.isObject(source[key])) {
          if (!(key in target)) {
            Object.assign(output, { [key]: source[key] });
          } else {
            output[key] = this.deepMerge(target[key], source[key]);
          }
        } else {
          Object.assign(output, { [key]: source[key] });
        }
      });
    }
    
    return output;
  }

  isObject(item) {
    return item && typeof item === 'object' && !Array.isArray(item);
  }

  createDefaultConfigFile() {
    const defaultConfigPath = path.join(process.cwd(), 'config.json');
    try {
      fs.writeFileSync(
        defaultConfigPath,
        JSON.stringify(this.getDefaultConfig(), null, 2),
        'utf8'
      );
      console.log(`已创建默认配置文件: ${defaultConfigPath}`);
      console.log('请修改配置文件后重新运行程序');
    } catch (error) {
      console.error('创建默认配置文件失败:', error.message);
    }
  }

  initPaths() {
    // 生成时间戳
    const now = new Date();
    const timestamp = this.config.output.useTimestamp
      ? now.toISOString().replace(/[-:\.T]/g, '').slice(0, 15)
      : '';

    // 基础输出目录
    this.baseOutputDir = path.resolve(this.config.output.baseDir);
    
    // 如果使用时间戳，创建时间戳子目录
    if (this.config.output.useTimestamp && timestamp) {
      this.baseOutputDir = path.join(this.baseOutputDir, timestamp);
    }

    // 确保所有目录都存在
    this.ensureDirectories();

    // 生成文件路径
    this.filePaths = this.generateFilePaths(timestamp);
  }

  ensureDirectories() {
    const dirs = [
      this.baseOutputDir,
      path.join(this.baseOutputDir, this.config.output.subDirs.screenshots),
      path.join(this.baseOutputDir, this.config.output.subDirs.endnoteDownloads),
      path.join(this.baseOutputDir, this.config.output.subDirs.logs),
      path.join(this.baseOutputDir, this.config.output.subDirs.data)
    ];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`创建目录: ${dir}`);
      }
    }
  }

  generateFilePaths(timestamp) {
    const suffix = this.config.output.useTimestamp && timestamp ? `_${timestamp}` : '';
    
    return {
      successExcel: path.join(
        this.baseOutputDir,
        `${this.config.output.fileNames.successExcel}${suffix}.xlsx`
      ),
      failedExcel: path.join(
        this.baseOutputDir,
        `${this.config.output.fileNames.failedExcel}${suffix}.xlsx`
      ),
      endnoteExcel: path.join(
        this.baseOutputDir,
        `${this.config.output.fileNames.endnoteExcel}${suffix}.xlsx`
      ),
      screenshotDir: path.join(this.baseOutputDir, this.config.output.subDirs.screenshots),
      endnoteDownloadDir: path.join(this.baseOutputDir, this.config.output.subDirs.endnoteDownloads),
      logDir: path.join(this.baseOutputDir, this.config.output.subDirs.logs),
      dataDir: path.join(this.baseOutputDir, this.config.output.subDirs.data)
    };
  }

  get(key, defaultValue = null) {
    const keys = key.split('.');
    let value = this.config;
    
    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = value[k];
      } else {
        return defaultValue;
      }
    }
    
    return value;
  }

  // 动态更新配置（运行时修改）
  update(key, value) {
    const keys = key.split('.');
    let current = this.config;
    
    for (let i = 0; i < keys.length - 1; i++) {
      if (!current[keys[i]] || typeof current[keys[i]] !== 'object') {
        current[keys[i]] = {};
      }
      current = current[keys[i]];
    }
    
    current[keys[keys.length - 1]] = value;
    
    // 保存到文件
    this.saveToFile();
  }

  saveToFile() {
    if (this.configPath) {
      try {
        fs.writeFileSync(
          this.configPath,
          JSON.stringify(this.config, null, 2),
          'utf8'
        );
        console.log('配置已保存到文件');
      } catch (error) {
        console.error('保存配置失败:', error.message);
      }
    }
  }

  // 获取测试数据
  getTestPaperInfoList() {
    // 优先使用配置文件中的测试数据
    if (this.config.testData && this.config.testData.length > 0) {
      return this.config.testData.map(paper => new PaperInfo(
        paper.title,
        paper.authors,
        "", "", "", "", "", "", "", ""
      ));
    }
    
    // 如果没有配置测试数据，使用默认值
    return [
      new PaperInfo(
        "Relationships of knowledge and practice: Teacher learning communities",
        "Cochran-Smith, M., & Lytle, S.",
        "", "", "", "", "", "", "", ""
      ),
      new PaperInfo(
        "Redos and retakes done right",
        "Wormeli, R.",
        "", "", "", "", "", "", "", ""
      ),
      new PaperInfo(
        "Contract grading and peer review",
        "Katopodis, C., & Davidson, C. N.",
        "", "", "", "", "", "", "", ""
      )
    ];
  }
}

module.exports = ConfigManager;