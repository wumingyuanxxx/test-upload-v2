const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const { MiaoshouClient } = require('./miaoshou');
const { OssClient, objectUrl } = require('./oss');
const { ModelClient, seedreamImageGenerationsEndpoint, zhipuChatCompletionsEndpoint, providerCapabilities, providerRequestModes, responseText, chatCompletionText } = require('./model-client');

const modelClient = new ModelClient();

const MIAOSHOU_SHOP_TARGETS = [
  { platformCode: 'pddkjChoice', siteCode: 'PDDKJCHOICE', platformName: 'TEMU', publishMode: 'Temu 半托' },
  { platformCode: 'pddkj', siteCode: 'PDDKJ', platformName: 'TEMU', publishMode: 'Temu 全托管' },
  ...['ID', 'VN', 'TH', 'MY', 'PH', 'BR', 'MX', 'ES', 'FR', 'GB', 'US', 'DE', 'IT', 'JP']
    .map((siteCode) => ({ platformCode: 'tiktok', siteCode, platformName: 'TikTok', publishMode: 'TikTok Shop' })),
  ...['TIKTOKGLOBAL', 'TIKTOKGLOBALUS', 'TIKTOKGLOBALEU']
    .map((siteCode) => ({ platformCode: 'tiktokGlobal', siteCode, platformName: 'TikTok', publishMode: 'TikTok Global' })),
  { platformCode: 'tiktokGs', siteCode: 'TIKTOKGS', platformName: 'TikTok', publishMode: 'TikTok 全托管' },
];

const MIAOSHOU_PACKAGING_OPTIONS = {
  outerPackageShape: [{ key: '1', value: '长方体' }],
  outerPackageType: [{ key: '2', value: '软包装+软物' }],
};

const DEFAULT_CONFIG = {
  database: { host: 'localhost', port: 3306, name: 'yihui-upload-agent', username: 'root', password: '' },
  miaoshou: { appId: '', appSecret: '', apiBaseUrl: 'https://openapi-erp.91miaoshou.com' },
  miaoshouProfiles: [], activeMiaoshouProfileId: '',
  image: { provider: '', apiBaseUrl: '', apiKey: '', model: 'gpt-image-2', timeoutSeconds: 120, maxConcurrency: 2 },
  oss: { endpoint: '', bucket: '', accessKeyId: '', accessKeySecret: '' },
  wms: { baseUrl: 'http://localhost:8080', username: '', password: '', warehouseId: '', token: '', tokenUpdatedAt: '' },
  sync: { enabled: true, intervalSeconds: 10 },
};

function normalizeMiaoshouProfiles(saved = {}) {
  const source = Array.isArray(saved.miaoshouProfiles) && saved.miaoshouProfiles.length
    ? saved.miaoshouProfiles : [saved.miaoshou || DEFAULT_CONFIG.miaoshou];
  const seenAppIds = new Set();
  const profiles = source.reduce((items, profile, index) => {
    const appId = String(profile?.appId || '').trim();
    if (!appId || seenAppIds.has(appId)) return items;
    seenAppIds.add(appId);
    const id = String(profile?.id || '').trim() || `miaoshou-${crypto.createHash('sha256').update(`${appId}:${profile?.apiBaseUrl || ''}`).digest('hex').slice(0, 16)}`;
    items.push({
      id,
      name: String(profile?.name || '').trim() || (index === 0 ? '默认妙手配置' : `妙手配置 ${index + 1}`),
      appId,
      appSecret: String(profile?.appSecret || '').trim(),
      apiBaseUrl: String(profile?.apiBaseUrl || '').trim() || DEFAULT_CONFIG.miaoshou.apiBaseUrl,
    });
    return items;
  }, []);
  if (!profiles.length) {
    profiles.push({ id: 'miaoshou-default', name: '默认妙手配置', ...DEFAULT_CONFIG.miaoshou });
  }
  const requestedActiveId = String(saved.activeMiaoshouProfileId || '').trim();
  const activeProfile = profiles.find((profile) => profile.id === requestedActiveId) || profiles[0];
  return { profiles, activeProfile };
}

function mergeConfig(saved = {}) {
  const { profiles: miaoshouProfiles, activeProfile } = normalizeMiaoshouProfiles(saved);
  return {
    ...DEFAULT_CONFIG,
    ...saved,
    database: { ...DEFAULT_CONFIG.database, ...(saved.database || {}) },
    miaoshou: { appId: activeProfile.appId, appSecret: activeProfile.appSecret, apiBaseUrl: activeProfile.apiBaseUrl },
    miaoshouProfiles,
    activeMiaoshouProfileId: activeProfile.id,
    image: { ...DEFAULT_CONFIG.image, ...(saved.image || {}) },
    oss: { ...DEFAULT_CONFIG.oss, ...(saved.oss || {}) },
    wms: { ...DEFAULT_CONFIG.wms, ...(saved.wms || {}) },
    sync: {
      ...DEFAULT_CONFIG.sync,
      ...(saved.sync || {}),
      enabled: saved.sync?.enabled !== false,
      intervalSeconds: Math.max(10, Number(saved.sync?.intervalSeconds) || DEFAULT_CONFIG.sync.intervalSeconds),
    },
  };
}

function openAiModelsEndpoint(apiBaseUrl, model) {
  let url;
  try {
    url = new URL(String(apiBaseUrl || '').trim());
  } catch (_) {
    throw new Error('API Base URL 格式无效。');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('API Base URL 仅支持 HTTP 或 HTTPS。');
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  const basePath = url.pathname.replace(/\/+$/, '');
  const modelsPath = basePath.endsWith('/models')
    ? basePath
    : `${basePath.endsWith('/v1') ? basePath : `${basePath}/v1`}/models`;
  url.pathname = model ? `${modelsPath}/${encodeURIComponent(model)}` : modelsPath;
  return url.toString();
}


function modelProviderTestPlan(provider) {
  const apiBaseUrl = String(provider?.api_base_url || '').trim();
  const apiKey = String(provider?.api_key_value || '').trim();
  const model = String(provider?.default_model || '').trim();
  if (!apiBaseUrl) throw new Error('请填写 API Base URL。');
  if (!apiKey) throw new Error('请填写 API Key。');

  const providerType = String(provider?.provider_type || 'openai_compatible').trim();
  const testAdapter = String(provider?.test_adapter || 'auto').trim();
  const isZhipu = providerType === 'zhipu';
  const isSeedream = modelClient.imageAdapter(provider) === 'seedream_images';
  const isChatTest = testAdapter === 'chat_completions' || (testAdapter === 'auto' && isZhipu);
  // Image models do not consistently expose GET /models/{model}.  In
  // particular, ApiGoto lists gpt-image-2 in GET /models but returns 404 for
  // the per-model route.  Validate the authenticated model catalog instead;
  // image generation itself continues to use /images/edits.
  const isImageModel = /(?:^|[-_])(?:image|dall-e)|gpt-image/i.test(model);
  return {
    apiKey,
    model,
    isZhipu,
    isSeedream,
    isChatTest,
    isImageModel,
    endpoint: isSeedream ? seedreamImageGenerationsEndpoint(apiBaseUrl) : (isChatTest ? modelClient.chatEndpoint(provider) : openAiModelsEndpoint(apiBaseUrl, isImageModel ? '' : model)),
    method: isSeedream || isChatTest ? 'POST' : 'GET',
    // 空提示词只会触发参数校验，不会创建图片；用于免消耗验证 Seedream 端点与鉴权。
    body: isSeedream ? { model: model || 'doubao-seedream-5-0-pro-260628', prompt: '' } : (isChatTest ? {
      model: model || (isZhipu ? 'glm-4-flash' : ''),
      messages: [{ role: 'user', content: '请仅回复 OK。' }],
      stream: false,
      max_tokens: 8,
    } : null),
  };
}

function maskedApiKey(apiKey) {
  const value = String(apiKey || '');
  return value.length <= 8 ? '****' : `${value.slice(0, 4)}****${value.slice(-4)}`;
}

function modelTimeoutMs(provider) {
  const seconds = Number(provider?.timeout_seconds);
  return (Number.isInteger(seconds) && seconds >= 1 && seconds <= 3600 ? seconds : 300) * 1000;
}

function jsonFromModelText(value) {
  const text = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('模型没有返回可识别的 SKU JSON。');
  try { return JSON.parse(text.slice(start, end + 1)); }
  catch (_) { throw new Error('模型返回的 SKU 数据不是有效 JSON，请调整提示词后重试。'); }
}

class DatabaseService {
  constructor(userDataPath) {
    this.configFile = path.join(userDataPath, 'workbench-config.json');
    this.legacyCommonCollectBoxPurged = false;
    this.productImageTasks = new Map();
  }

  async getBootstrapConfig() {
    let content;
    try {
      content = await fs.readFile(this.configFile, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return mergeConfig();
      throw error;
    }
    try {
      const saved = JSON.parse(content);
      if (!saved || Array.isArray(saved) || typeof saved !== 'object') throw new Error('配置根节点必须是对象');
      return mergeConfig(saved);
    } catch (error) {
      const configError = new Error(`本机数据库配置文件已损坏，无法读取：${this.configFile}。请恢复该文件或在系统设置中重新保存数据库配置。`);
      configError.code = 'BOOTSTRAP_CONFIG_INVALID';
      configError.cause = error;
      throw configError;
    }
  }

  async saveBootstrapConfig(config) {
    const database = mergeConfig(config).database;
    await fs.mkdir(path.dirname(this.configFile), { recursive: true });
    const temporaryFile = `${this.configFile}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(temporaryFile, JSON.stringify({ database }, null, 2), 'utf8');
      await fs.rename(temporaryFile, this.configFile);
    } catch (error) {
      await fs.unlink(temporaryFile).catch(() => {});
      throw error;
    }
  }

  async backupLegacyConfigIfNeeded() {
    const backupFile = `${this.configFile}.before-db-migration.json`;
    try {
      await fs.access(backupFile);
      return;
    } catch (_) { /* 首次迁移继续 */ }
    try {
      const raw = JSON.parse(await fs.readFile(this.configFile, 'utf8'));
      if (Object.keys(raw).some((key) => key !== 'database')) await fs.copyFile(this.configFile, backupFile);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  async ensureMiaoshouApiProfilesTable(connection) {
    await connection.query(`CREATE TABLE IF NOT EXISTS miaoshou_api_profiles (
      profile_id VARCHAR(128) NOT NULL, profile_name VARCHAR(128) NOT NULL, app_id VARCHAR(128) NOT NULL,
      app_secret TEXT NOT NULL, api_base_url VARCHAR(1000) NOT NULL, is_active TINYINT UNSIGNED NOT NULL DEFAULT 0,
      sort_order INT NOT NULL DEFAULT 0, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (profile_id), UNIQUE KEY uk_miaoshou_api_profiles_app_id (app_id),
      KEY idx_miaoshou_api_profiles_active (is_active, sort_order)
    ) ENGINE=InnoDB COMMENT='妙手 API 系统配置'`);
  }

  async readSystemConfigGroup(connection, group) {
    const [rows] = await connection.execute('SELECT config_key, config_value FROM system_configs WHERE config_group = ? AND is_enabled = 1', [group]);
    return Object.fromEntries(rows.map((row) => [row.config_key, row.config_value]));
  }

  async upsertSystemConfigEntries(connection, group, entries, updatedBy = null) {
    for (const [key, value, valueType, description] of entries) {
      await connection.execute(`INSERT INTO system_configs (config_group, config_key, config_value, value_type, description, updated_by)
        VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), value_type = VALUES(value_type), description = VALUES(description), is_enabled = 1, updated_by = VALUES(updated_by)`,
      [group, key, String(value ?? ''), valueType, description, updatedBy || null]);
    }
  }

  async persistRuntimeSettings(connection, config, { onlyMissing = false, updatedBy = null } = {}) {
    await this.ensureMiaoshouApiProfilesTable(connection);
    const saved = mergeConfig(config);
    const [existingProfileRows] = await connection.query('SELECT profile_id FROM miaoshou_api_profiles LIMIT 1');
    if (!onlyMissing || !existingProfileRows.length) {
      const profiles = saved.miaoshouProfiles;
      if (profiles.length) {
        await connection.execute('UPDATE miaoshou_api_profiles SET is_active = 0');
        const profileIds = profiles.map((profile) => profile.id);
        await connection.execute(`DELETE FROM miaoshou_api_profiles WHERE profile_id NOT IN (${profileIds.map(() => '?').join(', ')})`, profileIds);
        for (const [index, profile] of profiles.entries()) {
          await connection.execute(`INSERT INTO miaoshou_api_profiles (profile_id, profile_name, app_id, app_secret, api_base_url, is_active, sort_order)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE profile_name = VALUES(profile_name), app_id = VALUES(app_id), app_secret = VALUES(app_secret), api_base_url = VALUES(api_base_url), is_active = VALUES(is_active), sort_order = VALUES(sort_order)`,
          [profile.id, profile.name, profile.appId, profile.appSecret, profile.apiBaseUrl, profile.id === saved.activeMiaoshouProfileId ? 1 : 0, index]);
        }
      }
    }
    const oss = saved.oss;
    const sync = saved.sync;
    const groups = [
      ['oss', [
        ['endpoint', oss.endpoint, 'string', '阿里云 OSS Endpoint'], ['bucket', oss.bucket, 'string', '阿里云 OSS Bucket'],
        ['access_key_id', oss.accessKeyId, 'string', '阿里云 OSS AccessKey ID'], ['access_key_secret', oss.accessKeySecret, 'string', '阿里云 OSS AccessKey Secret'],
      ]],
      ['sync', [
        ['enabled', sync.enabled ? '1' : '0', 'boolean', '目标店铺采集箱自动同步开关'],
        ['interval_seconds', Math.max(10, Number(sync.intervalSeconds) || 10), 'number', '目标店铺采集箱同步间隔（秒）'],
      ]],
      ['wms', [
        ['base_url', saved.wms.baseUrl, 'string', 'WMS 服务地址'], ['username', saved.wms.username, 'string', 'WMS 登录用户名'],
        ['password', saved.wms.password, 'string', 'WMS 登录密码（按当前设置明文保存）'], ['warehouse_id', saved.wms.warehouseId, 'number', 'WMS 入库仓库 ID'], ['token', saved.wms.token, 'string', 'WMS 登录令牌'],
        ['token_updated_at', saved.wms.tokenUpdatedAt, 'string', 'WMS 登录令牌获取时间'],
      ]],
    ];
    for (const [group, entries] of groups) {
      if (onlyMissing) {
        const existing = await this.readSystemConfigGroup(connection, group);
        const missing = entries.filter(([key]) => existing[key] === undefined);
        if (missing.length) await this.upsertSystemConfigEntries(connection, group, missing, updatedBy);
      } else await this.upsertSystemConfigEntries(connection, group, entries, updatedBy);
    }
  }

  async loadRuntimeSettings(connection, bootstrap) {
    await this.ensureMiaoshouApiProfilesTable(connection);
    const [profiles] = await connection.query('SELECT profile_id, profile_name, app_id, app_secret, api_base_url, is_active FROM miaoshou_api_profiles ORDER BY sort_order, profile_id');
    const oss = await this.readSystemConfigGroup(connection, 'oss');
    const sync = await this.readSystemConfigGroup(connection, 'sync');
    const wms = await this.readSystemConfigGroup(connection, 'wms');
    const profileValues = profiles.length ? profiles.map((profile) => ({ id: profile.profile_id, name: profile.profile_name, appId: profile.app_id, appSecret: profile.app_secret, apiBaseUrl: profile.api_base_url })) : bootstrap.miaoshouProfiles;
    const activeProfile = profiles.find((profile) => Number(profile.is_active) === 1)?.profile_id || bootstrap.activeMiaoshouProfileId;
    return mergeConfig({ ...bootstrap,
      miaoshouProfiles: profileValues,
      activeMiaoshouProfileId: activeProfile,
      oss: Object.keys(oss).length ? { endpoint: oss.endpoint, bucket: oss.bucket, accessKeyId: oss.access_key_id, accessKeySecret: oss.access_key_secret } : bootstrap.oss,
      sync: Object.keys(sync).length ? { enabled: String(sync.enabled) !== '0', intervalSeconds: Number(sync.interval_seconds) } : bootstrap.sync,
      wms: Object.keys(wms).length ? { baseUrl: wms.base_url, username: wms.username, password: wms.password, warehouseId: Number(wms.warehouse_id), token: wms.token, tokenUpdatedAt: wms.token_updated_at } : bootstrap.wms,
    });
  }

  async getConfig() {
    const bootstrap = await this.getBootstrapConfig();
    let connection;
    try {
      connection = await this.openConnection(bootstrap);
      await connection.beginTransaction();
      await this.persistRuntimeSettings(connection, bootstrap, { onlyMissing: true });
      const runtime = await this.loadRuntimeSettings(connection, bootstrap);
      await connection.commit();
      await this.backupLegacyConfigIfNeeded();
      await this.saveBootstrapConfig(bootstrap);
      return runtime;
    } catch (error) {
      if (connection) await connection.rollback().catch(() => {});
      return bootstrap;
    } finally { if (connection) await connection.end(); }
  }

  async saveConfig(config) {
    const saved = mergeConfig(config);
    let connection;
    try {
      connection = await this.openConnection(saved);
      await connection.beginTransaction();
      await this.persistRuntimeSettings(connection, saved);
      const runtime = await this.loadRuntimeSettings(connection, saved);
      await connection.commit();
      await this.backupLegacyConfigIfNeeded();
      await this.saveBootstrapConfig(saved);
      return runtime;
    } catch (error) {
      if (connection) await connection.rollback().catch(() => {});
      throw error;
    } finally { if (connection) await connection.end(); }
  }

  async openConnection(config, includeDatabase = true) {
    const db = mergeConfig(config).database;
    return mysql.createConnection({
      host: db.host,
      port: Number(db.port),
      user: db.username,
      password: db.password,
      ...(includeDatabase ? { database: db.name } : {}),
      connectTimeout: 8000,
      multipleStatements: !includeDatabase,
    });
  }

  async initializeDatabase(config) {
    let connection;
    try {
      const schemaPath = path.join(__dirname, '..', '..', 'database', 'schema.sql');
      const schemaSql = await fs.readFile(schemaPath, 'utf8');
      connection = await this.openConnection(config, false);
      await connection.query(schemaSql);
      await this.ensureAiGenerationRecordsTable(connection);
      await this.ensureImageLibraryTable(connection);
      await this.ensureAiImageEditSettingsTable(connection);
      await this.ensureMiaoshouCommonCollectBoxItemsTable(connection);
      await this.ensureScheduledJobTables(connection);
      await this.ensureWmsStockImportRecordsTable(connection);
      await this.ensureProductRemarkTagsTable(connection);
      await this.ensureTodoTasksTable(connection);
      await this.saveConfig(config);
      return { ok: true, message: '数据库、数据表和默认管理员已初始化。' };
    } catch (error) {
      return { ok: false, code: error.code || 'DATABASE_INIT_ERROR', message: error.message };
    } finally { if (connection) await connection.end(); }
  }

  async testConnection(config) {
    let connection;
    try {
      connection = await this.openConnection(config);
      const [rows] = await connection.query('SELECT DATABASE() AS databaseName, VERSION() AS version');
      return { ok: true, database: rows[0].databaseName, version: rows[0].version };
    } catch (error) {
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message };
    } finally { if (connection) await connection.end(); }
  }

  async saveOssSettings(oss, updatedBy = null) {
    let connection;
    try {
      const settings = {
        endpoint: String(oss?.endpoint || '').trim(),
        bucket: String(oss?.bucket || '').trim(),
        accessKeyId: String(oss?.accessKeyId || '').trim(),
        accessKeySecret: String(oss?.accessKeySecret || '').trim(),
      };
      if (!settings.endpoint || !settings.bucket || !settings.accessKeyId || !settings.accessKeySecret) {
        return { ok: false, code: 'VALIDATION_ERROR', message: '请完整填写 OSS 配置后再保存。' };
      }
      const config = await this.getConfig();
      connection = await this.openConnection(config);
      await connection.beginTransaction();
      const entries = [
        ['endpoint', settings.endpoint, '阿里云 OSS Endpoint'],
        ['bucket', settings.bucket, '阿里云 OSS Bucket'],
        ['access_key_id', settings.accessKeyId, '阿里云 OSS AccessKey ID'],
        ['access_key_secret', settings.accessKeySecret, '阿里云 OSS AccessKey Secret'],
      ];
      for (const [key, value, description] of entries) {
        await connection.execute(`INSERT INTO system_configs (config_group, config_key, config_value, value_type, description, updated_by)
          VALUES ('oss', ?, ?, 'string', ?, ?)
          ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), description = VALUES(description), updated_by = VALUES(updated_by)`, [key, value, description, updatedBy || null]);
      }
      await connection.commit();
      await this.saveConfig({ ...config, oss: settings });
      return { ok: true, oss: settings, message: 'OSS 配置已保存到数据库。' };
    } catch (error) {
      if (connection) { try { await connection.rollback(); } catch (_) { /* transaction may not have started */ } }
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message };
    } finally { if (connection) await connection.end(); }
  }

  async ensureFieldMappingsTable(connection) {
    await connection.query(`CREATE TABLE IF NOT EXISTS field_mappings (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      mapping_key VARCHAR(64) NOT NULL,
      source_value VARCHAR(128) NOT NULL,
      display_value VARCHAR(128) NOT NULL,
      is_enabled TINYINT UNSIGNED NOT NULL DEFAULT 1,
      sort_order INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_field_mappings_key_value (mapping_key, source_value),
      KEY idx_field_mappings_enabled (mapping_key, is_enabled, sort_order)
    ) ENGINE=InnoDB COMMENT='字段映射表'`);
    await connection.query(`INSERT IGNORE INTO field_mappings (mapping_key, source_value, display_value, sort_order) VALUES
      ('target_platform_code', 'temu_semi', 'TEMU', 10),
      ('product_status', 'pending_process', '商品处理中', 10),
      ('product_status', 'image_processing', '图片处理中', 20),
      ('product_status', 'ai_image_completed', 'AI 生图完成', 25),
      ('product_status', 'sku_image_completed', 'SKU 生图完成', 26),
      ('product_status', 'sku_recognizing', 'SKU 识别中', 27),
      ('product_status', 'sku_recognized', 'SKU 识别完成', 28),
      ('product_status', 'sku_recognition_failed', 'SKU 识别失败', 29),
      ('product_status', 'importing_miaoshou', '录入妙手中', 29),
      ('product_status', 'common_collect_box_created', '公共采集箱已创建', 29),
      ('product_status', 'platform_claimed', '平台采集箱已认领', 29),
      ('product_status', 'miaoshou_synced', '妙手同步完成', 29),
      ('product_status', 'import_failed', '录入妙手失败', 29),
      ('product_status', 'ready_to_write', '可写入', 30),
      ('product_status', 'written', '已回写', 40),
      ('product_status', 'publish_submitted', '已提交发布', 45),
      ('product_status', 'publish_failed', '发布失败', 50),
      ('product_status', 'failed', '处理失败', 50)`);
  }

  async ensureSourceDetailColumns(connection) {
    const [columns] = await connection.query('SHOW COLUMNS FROM products');
    const existing = new Set(columns.map((column) => column.Field));
    const definitions = [
      ['source_miaoshou_app_id', "VARCHAR(128) NULL COMMENT '妙手账号 App ID；文件夹建品草稿为空' AFTER source_store_id"],
      ['copy_origin_product_id', "BIGINT UNSIGNED NULL COMMENT '跨店铺复制时的来源商品 ID' AFTER source_miaoshou_app_id"],
      ['source_notes_text', "LONGTEXT NULL COMMENT '妙手店铺采集箱详情 notesText，供后续回写使用' AFTER source_store_id"],
      ['source_price', "DECIMAL(18,4) NULL COMMENT '妙手货源价格' AFTER source_notes_text"],
      ['source_stock', "INT NULL COMMENT '妙手货源库存' AFTER source_price"],
      ['source_weight', "DECIMAL(18,4) NULL COMMENT '妙手货源重量' AFTER source_stock"],
      ['source_package_length', "DECIMAL(18,4) NULL COMMENT '妙手包裹长度' AFTER source_weight"],
      ['source_package_width', "DECIMAL(18,4) NULL COMMENT '妙手包裹宽度' AFTER source_package_length"],
      ['source_package_height', "DECIMAL(18,4) NULL COMMENT '妙手包裹高度' AFTER source_package_width"],
      ['source_size_map', "JSON NULL COMMENT '妙手尺码映射' AFTER source_package_height"],
      ['source_color_map', "JSON NULL COMMENT '妙手颜色映射' AFTER source_size_map"],
      ['generated_title', "VARCHAR(1000) NULL COMMENT '本地生成标题，回写妙手时优先替换产品标题' AFTER title"],
      ['ai_generated_image_urls', "JSON NULL COMMENT 'AI 生成图片的 OSS 路径列表' AFTER generated_title"],
    ];
    for (const [name, definition] of definitions) if (!existing.has(name)) await connection.query(`ALTER TABLE products ADD COLUMN ${name} ${definition}`);
  }

  async ensureProductMiaoshouAccountScope(connection) {
    await this.ensureSourceDetailColumns(connection);
    const [columns] = await connection.query('SHOW COLUMNS FROM products');
    if (!columns.some((column) => column.Field === 'source_miaoshou_app_id')) return;
    const [tables] = await connection.query("SHOW TABLES LIKE 'miaoshou_product_mappings'");
    if (tables.length) await connection.query(`UPDATE products p
        JOIN miaoshou_product_mappings m ON m.product_id = p.id AND m.user_id = p.created_by
          AND m.platform_code = REPLACE(p.source_platform_code, 'miaoshou_', '') AND m.shop_id = p.source_store_id
        SET p.source_miaoshou_app_id = m.miaoshou_app_id
        WHERE p.source_miaoshou_app_id IS NULL AND m.miaoshou_app_id IS NOT NULL`);
    const [importTables] = await connection.query("SHOW TABLES LIKE 'miaoshou_folder_import_records'");
    if (importTables.length) await connection.query(`UPDATE products p
        JOIN miaoshou_folder_import_records r ON r.product_id = p.id AND r.user_id = p.created_by
          AND r.platform_code = REPLACE(p.source_platform_code, 'miaoshou_', '') AND r.shop_id = p.source_store_id
        SET p.source_miaoshou_app_id = r.miaoshou_app_id
        WHERE p.source_miaoshou_app_id IS NULL AND r.miaoshou_app_id IS NOT NULL`);
    const [copyIndexes] = await connection.query("SHOW INDEX FROM products WHERE Key_name = 'uk_products_store_copy_origin'");
    if (!copyIndexes.length) await connection.query('ALTER TABLE products ADD UNIQUE KEY uk_products_store_copy_origin (created_by, copy_origin_product_id, source_miaoshou_app_id, source_store_id)');
  }

  async purgeLegacyCommonCollectBoxData(connection) {
    if (this.legacyCommonCollectBoxPurged) return { productCount: 0, categoryCount: 0 };
    const [tables] = await connection.query('SHOW TABLES');
    const tableNames = new Set(tables.map((row) => Object.values(row)[0]));
    const hasTable = (name) => tableNames.has(name);
    const [legacyProducts] = await connection.execute("SELECT id FROM products WHERE source_platform_code = 'miaoshou_common'");
    const [legacyCategories] = hasTable('categories') && hasTable('category_versions')
      ? await connection.execute("SELECT c.id FROM categories c JOIN category_versions cv ON cv.id = c.category_version_id WHERE cv.platform_code = 'miaoshou_common'")
      : [[]];
    const productIds = legacyProducts.map((row) => Number(row.id));
    const categoryIds = legacyCategories.map((row) => Number(row.id));
    await connection.beginTransaction();
    try {
      if (productIds.length) {
        const placeholders = productIds.map(() => '?').join(',');
        if (hasTable('write_records')) await connection.execute(`DELETE FROM write_records WHERE product_id IN (${placeholders})`, productIds);
        if (hasTable('miaoshou_write_records')) await connection.execute(`DELETE FROM miaoshou_write_records WHERE product_id IN (${placeholders})`, productIds);
        if (hasTable('product_images')) await connection.execute(`DELETE FROM product_images WHERE product_id IN (${placeholders})`, productIds);
        if (hasTable('assets')) await connection.execute(`DELETE FROM assets WHERE product_id IN (${placeholders})`, productIds);
        await connection.execute(`DELETE FROM products WHERE id IN (${placeholders})`, productIds);
      }
      if (categoryIds.length) {
        const placeholders = categoryIds.map(() => '?').join(',');
        for (const table of ['user_common_category_attribute_templates', 'user_common_category_attributes', 'user_common_categories', 'template_categories', 'category_attributes']) {
          if (hasTable(table)) await connection.execute(`DELETE FROM ${table} WHERE category_id IN (${placeholders})`, categoryIds);
        }
        await connection.execute(`UPDATE products SET current_category_id = NULL WHERE current_category_id IN (${placeholders})`, categoryIds);
        await connection.execute(`DELETE FROM categories WHERE id IN (${placeholders})`, categoryIds);
      }
      if (hasTable('category_versions')) await connection.execute("DELETE FROM category_versions WHERE platform_code = 'miaoshou_common'");
      await connection.commit();
      this.legacyCommonCollectBoxPurged = true;
      return { productCount: productIds.length, categoryCount: categoryIds.length };
    } catch (error) {
      try { await connection.rollback(); } catch (_) { /* transaction may not have started */ }
      throw error;
    }
  }

  async ensureMiaoshouAuthorizedShopsTables(connection) {
    await connection.query(`CREATE TABLE IF NOT EXISTS miaoshou_authorized_shops (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, user_id BIGINT UNSIGNED NOT NULL, miaoshou_app_id VARCHAR(128) NOT NULL,
      platform_code VARCHAR(64) NOT NULL, site_code VARCHAR(64) NOT NULL, shop_id VARCHAR(128) NOT NULL, shop_name VARCHAR(255) NOT NULL,
      shop_mode VARCHAR(64) NULL, authorization_status VARCHAR(64) NULL, is_enabled TINYINT UNSIGNED NOT NULL DEFAULT 1, raw_data JSON NULL,
      last_synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id), UNIQUE KEY uk_miaoshou_authorized_shops_identity (user_id, miaoshou_app_id, platform_code, site_code, shop_id),
      KEY idx_miaoshou_authorized_shops_lookup (user_id, miaoshou_app_id, is_enabled),
      CONSTRAINT fk_miaoshou_authorized_shops_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB COMMENT='妙手授权店铺本地缓存'`);
    await connection.query(`CREATE TABLE IF NOT EXISTS automation_publish_settings (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, user_id BIGINT UNSIGNED NOT NULL, miaoshou_app_id VARCHAR(128) NOT NULL,
      platform_code VARCHAR(64) NULL, site_code VARCHAR(64) NULL, shop_id VARCHAR(128) NULL,
      write_target VARCHAR(64) NOT NULL DEFAULT 'miaoshou_unpublished', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id), UNIQUE KEY uk_automation_publish_settings_user_app (user_id, miaoshou_app_id),
      CONSTRAINT fk_automation_publish_settings_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB COMMENT='上架自动化发布目标设置'`);
    await connection.query(`UPDATE miaoshou_authorized_shops
      SET shop_name = COALESCE(NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(raw_data, '$.shopNick')), ''), 'null'), NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(raw_data, '$.platformShopName')), ''), 'null'), shop_name)
      WHERE shop_name IN (shop_id, 'null') AND raw_data IS NOT NULL`);
  }

  async ensureAutomationOperationSettingsTable(connection, preferredAppId = '') {
    await connection.query(`CREATE TABLE IF NOT EXISTS automation_operation_settings (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, user_id BIGINT UNSIGNED NOT NULL,
      title_enabled TINYINT UNSIGNED NOT NULL DEFAULT 1,
      prefer_category_title_templates TINYINT UNSIGNED NOT NULL DEFAULT 0,
      use_miaoshou_category_attributes TINYINT UNSIGNED NOT NULL DEFAULT 1,
      collect_price_multiplier DECIMAL(12,4) NOT NULL DEFAULT 1,
      auto_generate_images TINYINT UNSIGNED NOT NULL DEFAULT 1,
      prefer_category_image_templates TINYINT UNSIGNED NOT NULL DEFAULT 0,
      auto_generate_sku_images TINYINT UNSIGNED NOT NULL DEFAULT 0,
      ai_material_planning TINYINT UNSIGNED NOT NULL DEFAULT 1,
      auto_write_miaoshou TINYINT UNSIGNED NOT NULL DEFAULT 0,
      folder_auto_title TINYINT UNSIGNED NOT NULL DEFAULT 0,
      folder_auto_images TINYINT UNSIGNED NOT NULL DEFAULT 0,
      folder_auto_import TINYINT UNSIGNED NOT NULL DEFAULT 0,
      folder_auto_write_back TINYINT UNSIGNED NOT NULL DEFAULT 0,
      folder_auto_publish TINYINT UNSIGNED NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id), UNIQUE KEY uk_automation_operation_settings_user (user_id),
      CONSTRAINT fk_automation_operation_settings_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB COMMENT='上架自动化操作设置'`);
    const [columns] = await connection.query('SHOW COLUMNS FROM automation_operation_settings');
    if (!columns.some((column) => column.Field === 'auto_generate_sku_images')) {
      await connection.query('ALTER TABLE automation_operation_settings ADD COLUMN auto_generate_sku_images TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER auto_generate_images');
    }
    const existing = new Set(columns.map((column) => column.Field));
    if (!existing.has('prefer_category_title_templates')) {
      await connection.query('ALTER TABLE automation_operation_settings ADD COLUMN prefer_category_title_templates TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER title_enabled');
    }
    if (!existing.has('prefer_category_image_templates')) {
      await connection.query('ALTER TABLE automation_operation_settings ADD COLUMN prefer_category_image_templates TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER auto_generate_images');
    }
    const additions = ['folder_auto_title', 'folder_auto_images', 'folder_auto_import', 'folder_auto_write_back', 'folder_auto_publish'];
    for (const name of additions) if (!existing.has(name)) await connection.query(`ALTER TABLE automation_operation_settings ADD COLUMN ${name} TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER auto_write_miaoshou`);
    await this.migrateAutomationOperationSettingsToUserScope(connection, preferredAppId);
  }

  async ensureFolderBuilderAutomationRunsTable(connection) {
    await connection.query(`CREATE TABLE IF NOT EXISTS folder_builder_automation_runs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, user_id BIGINT UNSIGNED NOT NULL, product_id BIGINT UNSIGNED NOT NULL,
      config_snapshot JSON NOT NULL, run_status VARCHAR(32) NOT NULL DEFAULT 'running', current_stage VARCHAR(64) NOT NULL DEFAULT 'preparing',
      progress_percent TINYINT UNSIGNED NOT NULL DEFAULT 0, progress_message VARCHAR(500) NULL, error_message VARCHAR(2000) NULL,
      started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at DATETIME NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id), KEY idx_folder_automation_user_product (user_id, product_id, started_at),
      CONSTRAINT fk_folder_automation_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
      CONSTRAINT fk_folder_automation_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE
    ) ENGINE=InnoDB COMMENT='文件夹建品自动化运行记录'`);
  }

  async ensureAutomationOperationBindingsTable(connection, preferredAppId = '') {
    await connection.query(`CREATE TABLE IF NOT EXISTS automation_operation_bindings (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, user_id BIGINT UNSIGNED NOT NULL,
      operation_type VARCHAR(32) NOT NULL COMMENT 'title、image 或 sku_image', binding_type VARCHAR(32) NOT NULL COMMENT 'template 或 model',
      target_id BIGINT UNSIGNED NOT NULL, sort_order INT UNSIGNED NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id), UNIQUE KEY uk_automation_operation_binding (user_id, operation_type, binding_type, target_id),
      KEY idx_automation_operation_binding_lookup (user_id, operation_type, binding_type, sort_order),
      CONSTRAINT fk_automation_operation_bindings_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB COMMENT='上架自动化模型与提示词绑定'`);
    await this.migrateAutomationOperationSettingsToUserScope(connection, preferredAppId);
  }

  async ensureProductSkuGeneratedImagesTable(connection) {
    await connection.query(`CREATE TABLE IF NOT EXISTS product_sku_generated_images (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, product_id BIGINT UNSIGNED NOT NULL,
      sku_index INT UNSIGNED NOT NULL, image_url VARCHAR(2048) NOT NULL,
      template_id BIGINT UNSIGNED NULL, model_provider_id BIGINT UNSIGNED NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id), KEY idx_product_sku_generated_images_lookup (product_id, sku_index, created_at),
      CONSTRAINT fk_product_sku_generated_images_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE
    ) ENGINE=InnoDB COMMENT='商品 SKU AI 生成候选图片'`);
  }

  async getAutomationOperationBindings(connection, userId) {
    const [rows] = await connection.execute(`SELECT operation_type, binding_type, target_id, sort_order
      FROM automation_operation_bindings WHERE user_id = ?
      ORDER BY operation_type, binding_type, sort_order, id`, [Number(userId)]);
    return rows;
  }

  async migrateAutomationOperationSettingsToUserScope(connection, preferredAppId = '') {
    const [settingColumns] = await connection.query('SHOW COLUMNS FROM automation_operation_settings');
    const [bindingTables] = await connection.query("SHOW TABLES LIKE 'automation_operation_bindings'");
    const bindingTableExists = bindingTables.length > 0;
    const [bindingColumns] = bindingTableExists ? await connection.query('SHOW COLUMNS FROM automation_operation_bindings') : [[]];
    const settingsAppScoped = settingColumns.some((column) => column.Field === 'miaoshou_app_id');
    const bindingsAppScoped = bindingColumns.some((column) => column.Field === 'miaoshou_app_id');
    if (!settingsAppScoped && !bindingsAppScoped) return;

    const selectedAppIds = new Map();
    if (settingsAppScoped) {
      await connection.query('CREATE TABLE IF NOT EXISTS automation_operation_settings_app_scoped_backup LIKE automation_operation_settings');
      const [[backupCount]] = await connection.query('SELECT COUNT(*) AS count FROM automation_operation_settings_app_scoped_backup');
      if (!Number(backupCount.count)) await connection.query('INSERT INTO automation_operation_settings_app_scoped_backup SELECT * FROM automation_operation_settings');
      const [settingsRows] = await connection.query('SELECT id, user_id, miaoshou_app_id, updated_at FROM automation_operation_settings ORDER BY updated_at DESC, id DESC');
      const preferred = String(preferredAppId || '').trim();
      for (const row of settingsRows) {
        const userId = Number(row.user_id);
        const existing = selectedAppIds.get(userId);
        if (!existing || (!existing.matchesPreferred && String(row.miaoshou_app_id) === preferred)) {
          selectedAppIds.set(userId, { appId: String(row.miaoshou_app_id), matchesPreferred: String(row.miaoshou_app_id) === preferred, id: Number(row.id) });
        }
      }
      const retainedIds = [...selectedAppIds.values()].map((row) => row.id);
      if (retainedIds.length) await connection.query(`DELETE FROM automation_operation_settings WHERE id NOT IN (${retainedIds.map(() => '?').join(', ')})`, retainedIds);
      const [userIndexes] = await connection.query("SHOW INDEX FROM automation_operation_settings WHERE Key_name = 'uk_automation_operation_settings_user'");
      if (!userIndexes.length) await connection.query('ALTER TABLE automation_operation_settings ADD UNIQUE KEY uk_automation_operation_settings_user (user_id)');
      const [indexes] = await connection.query("SHOW INDEX FROM automation_operation_settings WHERE Key_name = 'uk_automation_operation_settings_user_app'");
      if (indexes.length) await connection.query('ALTER TABLE automation_operation_settings DROP INDEX uk_automation_operation_settings_user_app');
      await connection.query('ALTER TABLE automation_operation_settings DROP COLUMN miaoshou_app_id');
    }

    if (bindingsAppScoped) {
      await connection.query('CREATE TABLE IF NOT EXISTS automation_operation_bindings_app_scoped_backup LIKE automation_operation_bindings');
      const [[backupCount]] = await connection.query('SELECT COUNT(*) AS count FROM automation_operation_bindings_app_scoped_backup');
      if (!Number(backupCount.count)) await connection.query('INSERT INTO automation_operation_bindings_app_scoped_backup SELECT * FROM automation_operation_bindings');
      const [bindingRows] = await connection.query('SELECT id, user_id, miaoshou_app_id, updated_at FROM automation_operation_bindings ORDER BY updated_at DESC, id DESC');
      const appByUser = new Map([...selectedAppIds.entries()].map(([userId, entry]) => [userId, entry.appId]));
      const fallbackAppByUser = new Map();
      const preferred = String(preferredAppId || '').trim();
      for (const row of bindingRows) {
        const userId = Number(row.user_id);
        if (!fallbackAppByUser.has(userId) || String(row.miaoshou_app_id) === preferred) fallbackAppByUser.set(userId, String(row.miaoshou_app_id));
      }
      const retainedIds = bindingRows
        .filter((row) => String(row.miaoshou_app_id) === (appByUser.get(Number(row.user_id)) || fallbackAppByUser.get(Number(row.user_id))))
        .map((row) => Number(row.id));
      if (retainedIds.length) await connection.query(`DELETE FROM automation_operation_bindings WHERE id NOT IN (${retainedIds.map(() => '?').join(', ')})`, retainedIds);
      const [temporaryUserIndexes] = await connection.query("SHOW INDEX FROM automation_operation_bindings WHERE Key_name = 'idx_automation_operation_bindings_user_fk'");
      if (!temporaryUserIndexes.length) await connection.query('ALTER TABLE automation_operation_bindings ADD KEY idx_automation_operation_bindings_user_fk (user_id)');
      const [uniqueIndexes] = await connection.query("SHOW INDEX FROM automation_operation_bindings WHERE Key_name = 'uk_automation_operation_binding'");
      if (uniqueIndexes.length) await connection.query('ALTER TABLE automation_operation_bindings DROP INDEX uk_automation_operation_binding');
      const [lookupIndexes] = await connection.query("SHOW INDEX FROM automation_operation_bindings WHERE Key_name = 'idx_automation_operation_binding_lookup'");
      if (lookupIndexes.length) await connection.query('ALTER TABLE automation_operation_bindings DROP INDEX idx_automation_operation_binding_lookup');
      await connection.query('ALTER TABLE automation_operation_bindings DROP COLUMN miaoshou_app_id');
      await connection.query('ALTER TABLE automation_operation_bindings ADD UNIQUE KEY uk_automation_operation_binding (user_id, operation_type, binding_type, target_id)');
      await connection.query('ALTER TABLE automation_operation_bindings ADD KEY idx_automation_operation_binding_lookup (user_id, operation_type, binding_type, sort_order)');
      await connection.query('ALTER TABLE automation_operation_bindings DROP INDEX idx_automation_operation_bindings_user_fk');
    }
  }

  async migrateAutomationOperationSettingsLegacyRelations(connection) {
    const legacyColumns = ['title_source_type', 'title_model_provider_id', 'title_template_id', 'image_source_type', 'image_model_provider_id', 'image_template_id', 'image_template_ids'];
    const [columns] = await connection.query('SHOW COLUMNS FROM automation_operation_settings');
    const existingColumns = new Set(columns.map((column) => column.Field));
    const removableColumns = legacyColumns.filter((column) => existingColumns.has(column));
    if (!removableColumns.length) return;

    const selectedColumns = ['id', 'user_id', 'title_enabled', 'auto_generate_images', ...removableColumns];
    const [settingsRows] = await connection.query(`SELECT ${selectedColumns.join(', ')} FROM automation_operation_settings`);
    const bindingRows = [];
    const addBinding = (setting, operationType, bindingType, targetId, sortOrder = 0) => {
      const id = Number(targetId);
      if (Number.isInteger(id) && id > 0) bindingRows.push([Number(setting.user_id), operationType, bindingType, id, sortOrder]);
    };
    for (const setting of settingsRows) {
      addBinding(setting, 'title', 'template', setting.title_template_id);
      addBinding(setting, 'title', 'model', setting.title_model_provider_id);
      const imageTemplateIds = [...new Set([
        ...this.parseJsonColumn(setting.image_template_ids, []),
        setting.image_template_id,
      ].map(Number).filter((id) => Number.isInteger(id) && id > 0))];
      imageTemplateIds.forEach((id, sortOrder) => addBinding(setting, 'image', 'template', id, sortOrder));
      addBinding(setting, 'image', 'model', setting.image_model_provider_id);
    }
    if (bindingRows.length) {
      await connection.query(`INSERT IGNORE INTO automation_operation_bindings
        (user_id, operation_type, binding_type, target_id, sort_order) VALUES ${bindingRows.map(() => '(?, ?, ?, ?, ?)').join(', ')}`,
      bindingRows.flat());
    }

    const [bindings] = await connection.query(`SELECT user_id, operation_type, binding_type
      FROM automation_operation_bindings`);
    const bindingKeys = new Set(bindings.map((binding) => `${binding.user_id}:${binding.operation_type}:${binding.binding_type}`));
    for (const setting of settingsRows) {
      const prefix = `${setting.user_id}:`;
      if (Number(setting.title_enabled) === 1 && (!bindingKeys.has(`${prefix}title:template`) || !bindingKeys.has(`${prefix}title:model`))) {
        throw new Error('自动标题配置缺少提示词模板或大模型绑定，无法安全删除旧关联字段。');
      }
      if (Number(setting.auto_generate_images) === 1 && (!bindingKeys.has(`${prefix}image:template`) || !bindingKeys.has(`${prefix}image:model`))) {
        throw new Error('自动生图配置缺少提示词模板或大模型绑定，无法安全删除旧关联字段。');
      }
    }
    await connection.query(`ALTER TABLE automation_operation_settings ${removableColumns.map((column) => `DROP COLUMN ${column}`).join(', ')}`);
  }

  async ensureMiaoshouProductMappingsTable(connection) {
    await connection.query(`CREATE TABLE IF NOT EXISTS miaoshou_product_mappings (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, user_id BIGINT UNSIGNED NOT NULL, miaoshou_app_id VARCHAR(128) NOT NULL,
      product_id BIGINT UNSIGNED NOT NULL, source_detail_id VARCHAR(128) NOT NULL, platform_code VARCHAR(64) NULL,
      site_code VARCHAR(64) NULL, shop_id VARCHAR(128) NULL, platform_collect_box_detail_id VARCHAR(128) NULL,
      write_back_status VARCHAR(32) NOT NULL DEFAULT 'pending',
      publish_status VARCHAR(32) NOT NULL DEFAULT 'pending', last_error_message VARCHAR(2000) NULL, request_summary JSON NULL,
      response_summary JSON NULL, last_synced_at DATETIME NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id), UNIQUE KEY uk_miaoshou_product_mapping (user_id, miaoshou_app_id, product_id, platform_code, shop_id),
      KEY idx_miaoshou_product_mapping_source_detail (source_detail_id),
      CONSTRAINT fk_miaoshou_product_mappings_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
      CONSTRAINT fk_miaoshou_product_mappings_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE
    ) ENGINE=InnoDB COMMENT='本地商品与妙手采集箱映射'`);
    const [columns] = await connection.query('SHOW COLUMNS FROM miaoshou_product_mappings');
    const fields = new Set(columns.map((column) => column.Field));
    if (fields.has('common_collect_box_detail_id')) await connection.query('ALTER TABLE miaoshou_product_mappings CHANGE COLUMN common_collect_box_detail_id source_detail_id VARCHAR(128) NOT NULL');
    if (fields.has('claim_status')) await connection.query('ALTER TABLE miaoshou_product_mappings DROP COLUMN claim_status');
    const [oldIndexes] = await connection.query("SHOW INDEX FROM miaoshou_product_mappings WHERE Key_name = 'idx_miaoshou_product_mapping_collect_box'");
    if (oldIndexes.length) await connection.query('ALTER TABLE miaoshou_product_mappings DROP INDEX idx_miaoshou_product_mapping_collect_box');
    const [newIndexes] = await connection.query("SHOW INDEX FROM miaoshou_product_mappings WHERE Key_name = 'idx_miaoshou_product_mapping_source_detail'");
    if (!newIndexes.length) await connection.query('ALTER TABLE miaoshou_product_mappings ADD KEY idx_miaoshou_product_mapping_source_detail (source_detail_id)');
  }

  async ensureMiaoshouFolderImportRecordsTable(connection) {
    await connection.query(`CREATE TABLE IF NOT EXISTS miaoshou_folder_import_records (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, user_id BIGINT UNSIGNED NOT NULL, product_id BIGINT UNSIGNED NOT NULL,
      miaoshou_app_id VARCHAR(128) NOT NULL, platform_code VARCHAR(64) NOT NULL, site_code VARCHAR(64) NULL, shop_id VARCHAR(128) NOT NULL,
      common_collect_box_detail_id BIGINT UNSIGNED NULL, platform_collect_box_detail_id BIGINT UNSIGNED NULL,
      import_status VARCHAR(32) NOT NULL DEFAULT 'pending', current_stage VARCHAR(32) NOT NULL DEFAULT 'pending', error_message VARCHAR(2000) NULL,
      create_request JSON NULL, create_response JSON NULL, claim_request JSON NULL, claim_response JSON NULL,
      pre_publish_shop_claim_request JSON NULL, pre_publish_shop_claim_response JSON NULL, pre_publish_shop_claimed_at DATETIME NULL,
      write_request JSON NULL, write_response JSON NULL,
      started_at DATETIME NULL, finished_at DATETIME NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id), UNIQUE KEY uk_miaoshou_folder_import_target (user_id, product_id, miaoshou_app_id, platform_code, shop_id),
      KEY idx_miaoshou_folder_import_status (user_id, import_status, updated_at),
      CONSTRAINT fk_miaoshou_folder_import_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
      CONSTRAINT fk_miaoshou_folder_import_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE
    ) ENGINE=InnoDB COMMENT='文件夹建品录入妙手三阶段记录'`);
    const [columns] = await connection.query('SHOW COLUMNS FROM miaoshou_folder_import_records');
    const fields = new Set(columns.map((column) => column.Field));
    if (!fields.has('pre_publish_shop_claim_request')) await connection.query('ALTER TABLE miaoshou_folder_import_records ADD COLUMN pre_publish_shop_claim_request JSON NULL AFTER claim_response');
    if (!fields.has('pre_publish_shop_claim_response')) await connection.query('ALTER TABLE miaoshou_folder_import_records ADD COLUMN pre_publish_shop_claim_response JSON NULL AFTER pre_publish_shop_claim_request');
    if (!fields.has('pre_publish_shop_claimed_at')) await connection.query('ALTER TABLE miaoshou_folder_import_records ADD COLUMN pre_publish_shop_claimed_at DATETIME NULL AFTER pre_publish_shop_claim_response');
  }

  async ensureMiaoshouCommonCollectBoxItemsTable(connection) {
    await connection.query(`CREATE TABLE IF NOT EXISTS miaoshou_common_collect_box_items (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, user_id BIGINT UNSIGNED NOT NULL, miaoshou_app_id VARCHAR(128) NOT NULL,
      common_collect_box_detail_id BIGINT UNSIGNED NOT NULL, app_account_id BIGINT UNSIGNED NULL, sub_app_account_id BIGINT UNSIGNED NULL,
      item_num VARCHAR(255) NULL, title VARCHAR(1000) NULL, thumbnail VARCHAR(2048) NULL, list_thumbnail VARCHAR(2048) NULL,
      price DECIMAL(12,4) NULL, min_sku_price DECIMAL(12,4) NULL, max_sku_price DECIMAL(12,4) NULL, stock INT NULL,
      weight DECIMAL(12,4) NULL, min_sku_weight DECIMAL(12,4) NULL, max_sku_weight DECIMAL(12,4) NULL,
      remark VARCHAR(1000) NULL, remote_status VARCHAR(64) NULL, failure_reason VARCHAR(2000) NULL,
      remote_created_at VARCHAR(64) NULL, remote_updated_at VARCHAR(64) NULL, group_id BIGINT UNSIGNED NULL, group_name VARCHAR(255) NULL,
      source_list JSON NULL, owner_sub_account_alias_name VARCHAR(255) NULL, is_mark VARCHAR(64) NULL, raw_data JSON NOT NULL,
      is_active TINYINT UNSIGNED NOT NULL DEFAULT 1, last_sync_token CHAR(36) NULL, last_synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id), UNIQUE KEY uk_miaoshou_common_collect_box_item (user_id, miaoshou_app_id, common_collect_box_detail_id),
      KEY idx_miaoshou_common_collect_box_lookup (user_id, miaoshou_app_id, is_active, remote_status),
      KEY idx_miaoshou_common_collect_box_sync (user_id, miaoshou_app_id, last_synced_at),
      CONSTRAINT fk_miaoshou_common_collect_box_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB COMMENT='妙手公共采集箱列表本地缓存'`);
  }

  async ensureMiaoshouWriteRecordsTable(connection) {
    await connection.query(`CREATE TABLE IF NOT EXISTS miaoshou_write_records (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, user_id BIGINT UNSIGNED NOT NULL, product_id BIGINT UNSIGNED NULL,
      product_title VARCHAR(1000) NOT NULL, source_product_id VARCHAR(128) NOT NULL, platform_code VARCHAR(64) NULL,
      site_code VARCHAR(64) NULL, shop_id VARCHAR(128) NULL, shop_name VARCHAR(255) NULL,
      operation_type VARCHAR(32) NOT NULL DEFAULT 'write_back',
      write_back_status VARCHAR(32) NOT NULL,
      record_status VARCHAR(32) NOT NULL, error_message VARCHAR(2000) NULL, request_summary JSON NULL,
      response_summary JSON NULL, requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at DATETIME NULL,
      PRIMARY KEY (id), KEY idx_miaoshou_write_records_user_time (user_id, requested_at),
      KEY idx_miaoshou_write_records_status (record_status, requested_at),
      CONSTRAINT fk_miaoshou_write_records_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
      CONSTRAINT fk_miaoshou_write_records_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE SET NULL
    ) ENGINE=InnoDB COMMENT='妙手店铺采集箱批量回写历史'`);
    const [columns] = await connection.query('SHOW COLUMNS FROM miaoshou_write_records');
    if (columns.some((column) => column.Field === 'claim_status')) await connection.query('ALTER TABLE miaoshou_write_records DROP COLUMN claim_status');
    if (!columns.some((column) => column.Field === 'operation_type')) await connection.query("ALTER TABLE miaoshou_write_records ADD COLUMN operation_type VARCHAR(32) NOT NULL DEFAULT 'write_back' AFTER shop_name");
  }

  async ensureAiGenerationRecordsTable(connection) {
    await connection.query(`CREATE TABLE IF NOT EXISTS ai_generation_records (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, user_id BIGINT UNSIGNED NOT NULL, product_id BIGINT UNSIGNED NULL,
      product_title VARCHAR(1000) NOT NULL, generation_type VARCHAR(32) NOT NULL, record_status VARCHAR(32) NOT NULL DEFAULT 'running',
      model_provider_id BIGINT UNSIGNED NULL, model_name VARCHAR(255) NULL, templates_snapshot JSON NULL, input_summary JSON NULL,
      output_summary JSON NULL, raw_data JSON NULL COMMENT '本次 AI 生成实际提交参数快照，不含认证密钥和图片二进制',
      success_count INT UNSIGNED NOT NULL DEFAULT 0, failed_count INT UNSIGNED NOT NULL DEFAULT 0, error_message VARCHAR(2000) NULL,
      progress_percent TINYINT UNSIGNED NOT NULL DEFAULT 0, progress_message VARCHAR(500) NULL,
      task_started_at DATETIME NULL, task_finished_at DATETIME NULL,
      requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at DATETIME NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id), KEY idx_ai_generation_records_user_time (user_id, requested_at),
      KEY idx_ai_generation_records_status (record_status, requested_at), KEY idx_ai_generation_records_product (product_id, requested_at),
      CONSTRAINT fk_ai_generation_records_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
      CONSTRAINT fk_ai_generation_records_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE SET NULL
    ) ENGINE=InnoDB COMMENT='大模型生成调用记录'`);
    const [columns] = await connection.query('SHOW COLUMNS FROM ai_generation_records');
    const existing = new Set(columns.map((column) => column.Field));
    const additions = [
      ['progress_percent', 'TINYINT UNSIGNED NOT NULL DEFAULT 0'], ['progress_message', 'VARCHAR(500) NULL'],
      ['task_started_at', 'DATETIME NULL'], ['task_finished_at', 'DATETIME NULL'],
    ];
    for (const [name, definition] of additions) if (!existing.has(name)) await connection.query(`ALTER TABLE ai_generation_records ADD COLUMN ${name} ${definition}`);
  }

  async ensureAiImageEditSettingsTable(connection) {
    await connection.query(`CREATE TABLE IF NOT EXISTS ai_image_edit_settings (
      user_id BIGINT UNSIGNED NOT NULL, template_id BIGINT UNSIGNED NULL, model_provider_id BIGINT UNSIGNED NULL,
      prompt_content TEXT NULL, image_size VARCHAR(64) NULL, active_task_id VARCHAR(128) NULL, generation_record_id BIGINT UNSIGNED NULL,
      generation_status VARCHAR(32) NOT NULL DEFAULT 'idle', progress_percent TINYINT UNSIGNED NOT NULL DEFAULT 0,
      progress_message VARCHAR(500) NULL, task_started_at DATETIME NULL, task_finished_at DATETIME NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id), CONSTRAINT fk_ai_image_edit_settings_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB COMMENT='图库 AI 改图默认配置'`);
    const [columns] = await connection.query('SHOW COLUMNS FROM ai_image_edit_settings');
    const existing = new Set(columns.map((column) => column.Field));
    const additions = [
      ['active_task_id', 'VARCHAR(128) NULL'], ['generation_record_id', 'BIGINT UNSIGNED NULL'],
      ['generation_status', "VARCHAR(32) NOT NULL DEFAULT 'idle'"], ['progress_percent', 'TINYINT UNSIGNED NOT NULL DEFAULT 0'],
      ['progress_message', 'VARCHAR(500) NULL'], ['task_started_at', 'DATETIME NULL'], ['task_finished_at', 'DATETIME NULL'],
      ['image_size', 'VARCHAR(64) NULL'],
    ];
    for (const [name, definition] of additions) if (!existing.has(name)) await connection.query(`ALTER TABLE ai_image_edit_settings ADD COLUMN ${name} ${definition}`);
  }

  async ensureFolderBuilderSettingsTable(connection) {
    await connection.query(`CREATE TABLE IF NOT EXISTS folder_builder_settings (
      user_id BIGINT UNSIGNED NOT NULL, sku_ai_enabled TINYINT UNSIGNED NOT NULL DEFAULT 0,
      model_provider_id BIGINT UNSIGNED NULL, template_id BIGINT UNSIGNED NULL, prompt_content TEXT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id), CONSTRAINT fk_folder_builder_settings_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB COMMENT='文件夹建品 SKU 识别配置'`);
  }

  async ensureImageProductBuilderTables(connection) {
    await connection.query(`CREATE TABLE IF NOT EXISTS image_product_builder_settings (
      user_id BIGINT UNSIGNED NOT NULL, builder_type VARCHAR(32) NOT NULL, original_model_provider_id BIGINT UNSIGNED NULL,
      original_template_id BIGINT UNSIGNED NULL, original_prompt TEXT NULL, carousel_model_provider_id BIGINT UNSIGNED NULL,
      carousel_template_ids JSON NULL, item_number_rule VARCHAR(128) NOT NULL DEFAULT 'TB-{date}-{index}', updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, builder_type), CONSTRAINT fk_image_product_builder_settings_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB COMMENT='以图建品配置'`);
    const [settingColumns] = await connection.query('SHOW COLUMNS FROM image_product_builder_settings');
    const existingSettingColumns = new Set(settingColumns.map((column) => column.Field));
    const settingAdditions = [
      ['sku_ai_enabled', 'TINYINT UNSIGNED NOT NULL DEFAULT 0'],
      ['sku_model_provider_id', 'BIGINT UNSIGNED NULL'],
      ['sku_template_id', 'BIGINT UNSIGNED NULL'],
      ['sku_prompt', 'TEXT NULL'],
    ];
    for (const [name, definition] of settingAdditions) if (!existingSettingColumns.has(name)) await connection.query(`ALTER TABLE image_product_builder_settings ADD COLUMN ${name} ${definition}`);
    await connection.query(`CREATE TABLE IF NOT EXISTS image_product_builder_tasks (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, user_id BIGINT UNSIGNED NOT NULL, builder_type VARCHAR(32) NOT NULL, item_number VARCHAR(128) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'queued', progress_percent TINYINT UNSIGNED NOT NULL DEFAULT 0, progress_message VARCHAR(500) NULL,
      source_image_urls JSON NULL, original_image_urls JSON NULL, carousel_image_urls JSON NULL, config_snapshot JSON NULL, product_id BIGINT UNSIGNED NULL,
      error_message VARCHAR(2000) NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at DATETIME NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id), UNIQUE KEY uk_image_product_builder_task_item (user_id, builder_type, item_number), KEY idx_image_product_builder_tasks_user (user_id, builder_type, created_at),
      CONSTRAINT fk_image_product_builder_tasks_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB COMMENT='以图建品任务'`);
    await connection.query(`CREATE TABLE IF NOT EXISTS image_product_builder_sequences (
      user_id BIGINT UNSIGNED NOT NULL, builder_type VARCHAR(32) NOT NULL, current_value BIGINT UNSIGNED NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, builder_type), CONSTRAINT fk_image_product_builder_sequences_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB COMMENT='以图建品货号序号'`);
  }

  async getImageProductBuilderSettings(userId, builderType = 'tablecloth') {
    let connection;
    try {
      const id = Number(userId); const type = String(builderType || 'tablecloth');
      if (!Number.isInteger(id) || id < 1) throw new Error('请先登录本机用户。');
      const config = await this.getConfig(); connection = await this.openConnection(config);
      await this.ensureImageProductBuilderTables(connection); await this.ensureModelProvidersTable(connection, config); await this.ensureTemplateStorage(connection);
      const [[settings]] = await connection.execute(`SELECT original_model_provider_id, original_template_id, original_prompt, carousel_model_provider_id, carousel_template_ids, item_number_rule,
        sku_ai_enabled, sku_model_provider_id, sku_template_id, sku_prompt
        FROM image_product_builder_settings WHERE user_id = ? AND builder_type = ? LIMIT 1`, [id, type]);
      const [providers] = await connection.execute(`SELECT id, provider_name, default_model, provider_type, image_adapter, image_size FROM model_providers
        WHERE is_enabled = 1 AND default_model IS NOT NULL AND default_model <> '' ORDER BY is_active DESC, sort_order, id`);
      const [templates] = await connection.execute(`SELECT id, template_type, template_name, prompt_content FROM templates
        WHERE status = 'enabled' AND deleted_at IS NULL ORDER BY template_type, updated_at DESC, id DESC`);
      const normalizedProviders = providers.map((provider) => ({ ...provider, capabilities: providerCapabilities(provider) }));
      return { ok: true, settings: settings || { original_model_provider_id: null, original_template_id: null, original_prompt: '', carousel_model_provider_id: null, carousel_template_ids: [], item_number_rule: 'TB-{date}-{index}', sku_ai_enabled: 0, sku_model_provider_id: null, sku_template_id: null, sku_prompt: '' }, providers: normalizedProviders.filter((provider) => provider.capabilities.image), skuProviders: normalizedProviders.filter((provider) => provider.capabilities.text !== false), templates };
    } catch (error) { return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message, settings: null, providers: [], templates: [] }; }
    finally { if (connection) await connection.end(); }
  }

  async saveImageProductBuilderSettings(userId, setting = {}, builderType = 'tablecloth') {
    let connection;
    try {
      const id = Number(userId); const type = String(builderType || 'tablecloth');
      const originalProviderId = Number(setting.originalModelProviderId) || null; const originalTemplateId = Number(setting.originalTemplateId) || null;
      const originalPrompt = String(setting.originalPrompt || '').trim().slice(0, 12000); const carouselProviderId = Number(setting.carouselModelProviderId) || null;
      const carouselTemplateIds = [...new Set((Array.isArray(setting.carouselTemplateIds) ? setting.carouselTemplateIds : []).map(Number).filter((value) => Number.isInteger(value) && value > 0))];
      const itemNumberRule = String(setting.itemNumberRule || 'TB-{date}-{index}').trim().slice(0, 128);
      const skuAiEnabled = setting.skuAiEnabled === true || Number(setting.skuAiEnabled) === 1;
      const skuModelProviderId = Number(setting.skuModelProviderId) || null;
      const skuTemplateId = Number(setting.skuTemplateId) || null;
      const skuPrompt = String(setting.skuPrompt || '').trim().slice(0, 12000);
      if (!Number.isInteger(id) || id < 1) throw new Error('请先登录本机用户。');
      if (!originalProviderId || (!originalTemplateId && !originalPrompt)) throw new Error('请配置原图生成模型，以及原图提示词或提示词模板。');
      if (!carouselProviderId || !carouselTemplateIds.length) throw new Error('请配置轮播图模型并至少选择一个轮播图提示词模板。');
      if (!itemNumberRule.includes('{index}')) throw new Error('货号规则必须包含 {index} 自增占位符。');
      if (skuAiEnabled && !skuModelProviderId) throw new Error('启用 SKU AI 识别后，请选择识别模型。');
      if (skuAiEnabled && !skuTemplateId && !skuPrompt) throw new Error('启用 SKU AI 识别后，请配置提示词模板或补充提示词。');
      connection = await this.openConnection(await this.getConfig()); await this.ensureImageProductBuilderTables(connection);
      for (const providerId of [originalProviderId, carouselProviderId]) {
        const [[provider]] = await connection.execute(`SELECT id, provider_type FROM model_providers WHERE id = ? AND is_enabled = 1 LIMIT 1`, [providerId]);
        if (!provider || provider.provider_type === 'zhipu') throw new Error('所选图片大模型不存在、未启用或不支持图片生成。');
      }
      for (const templateId of [originalTemplateId, ...carouselTemplateIds].filter(Boolean)) {
        const [[template]] = await connection.execute(`SELECT id FROM templates WHERE id = ? AND status = 'enabled' AND deleted_at IS NULL LIMIT 1`, [templateId]);
        if (!template) throw new Error('所选提示词模板不存在或已停用。');
      }
      if (skuModelProviderId) {
        const [[provider]] = await connection.execute(`SELECT id FROM model_providers WHERE id = ? AND is_enabled = 1 LIMIT 1`, [skuModelProviderId]);
        if (!provider) throw new Error('所选 SKU AI 大模型不存在或已停用。');
      }
      if (skuTemplateId) {
        const [[template]] = await connection.execute(`SELECT id FROM templates WHERE id = ? AND status = 'enabled' AND deleted_at IS NULL LIMIT 1`, [skuTemplateId]);
        if (!template) throw new Error('所选 SKU AI 提示词模板不存在或已停用。');
      }
      await connection.execute(`INSERT INTO image_product_builder_settings (user_id, builder_type, original_model_provider_id, original_template_id, original_prompt, carousel_model_provider_id, carousel_template_ids, item_number_rule, sku_ai_enabled, sku_model_provider_id, sku_template_id, sku_prompt)
        VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE original_model_provider_id = VALUES(original_model_provider_id), original_template_id = VALUES(original_template_id), original_prompt = VALUES(original_prompt), carousel_model_provider_id = VALUES(carousel_model_provider_id), carousel_template_ids = VALUES(carousel_template_ids), item_number_rule = VALUES(item_number_rule), sku_ai_enabled = VALUES(sku_ai_enabled), sku_model_provider_id = VALUES(sku_model_provider_id), sku_template_id = VALUES(sku_template_id), sku_prompt = VALUES(sku_prompt), updated_at = NOW()`, [id, type, originalProviderId, originalTemplateId, originalPrompt || null, carouselProviderId, JSON.stringify(carouselTemplateIds), itemNumberRule, skuAiEnabled ? 1 : 0, skuModelProviderId, skuTemplateId, skuPrompt || null]);
      return { ok: true, message: '以图建品配置已保存。' };
    } catch (error) { return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message }; }
    finally { if (connection) await connection.end(); }
  }

  imageProductBuilderItemNumber(rule, index) {
    const now = new Date(); const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    return String(rule || 'TB-{date}-{index}').replaceAll('{date}', date).replaceAll('{index}', String(index));
  }

  async createImageProductBuilderTask(userId, input = {}, builderType = 'tablecloth') {
    let connection;
    try {
      const id = Number(userId); const type = String(builderType || 'tablecloth');
      const files = (Array.isArray(input.files) ? input.files : []).map((file) => ({ fileName: String(file?.fileName || '').trim(), contentType: String(file?.contentType || '').toLowerCase(), bytes: file?.bytes })).filter((file) => file.fileName && file.contentType.startsWith('image/'));
      if (!Number.isInteger(id) || id < 1) throw new Error('请先登录本机用户。');
      if (files.length < 1 || files.length > 6) throw new Error('请上传 1–6 张桌布商品展示图。');
      for (const file of files) { file.buffer = file.bytes instanceof Uint8Array ? Buffer.from(file.bytes) : Buffer.from(Array.isArray(file.bytes) ? file.bytes : []); if (!file.buffer.length || file.buffer.length > 20 * 1024 * 1024) throw new Error(`图片“${file.fileName}”无效或超过 20MB。`); }
      const config = await this.getConfig(); const oss = new OssClient(config.oss); if (!oss.isConfigured()) throw new Error('OSS 未配置。请先在系统设置中保存并测试 OSS 配置。');
      connection = await this.openConnection(config); await this.ensureImageProductBuilderTables(connection);
      const [[settings]] = await connection.execute(`SELECT original_model_provider_id, original_template_id, original_prompt, carousel_model_provider_id, carousel_template_ids, item_number_rule FROM image_product_builder_settings WHERE user_id = ? AND builder_type = ? LIMIT 1`, [id, type]);
      if (!settings?.original_model_provider_id || (!settings.original_template_id && !settings.original_prompt) || !settings.carousel_model_provider_id || !this.parseJsonColumn(settings.carousel_template_ids, []).length) throw new Error('请先完成并保存以图建品配置。');
      await connection.beginTransaction();
      await connection.execute(`INSERT INTO image_product_builder_sequences (user_id, builder_type, current_value) VALUES (?, ?, 0) ON DUPLICATE KEY UPDATE current_value = current_value`, [id, type]);
      const [[sequence]] = await connection.execute(`SELECT current_value FROM image_product_builder_sequences WHERE user_id = ? AND builder_type = ? FOR UPDATE`, [id, type]);
      const nextValue = Number(sequence.current_value) + 1; await connection.execute(`UPDATE image_product_builder_sequences SET current_value = ? WHERE user_id = ? AND builder_type = ?`, [nextValue, id, type]); await connection.commit();
      const itemNumber = this.imageProductBuilderItemNumber(settings.item_number_rule, nextValue);
      const sourceImageUrls = [];
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index]; const uploaded = await oss.uploadLibraryImage({ userId: id, fileName: file.fileName, contentType: file.contentType, buffer: file.buffer, kind: 'image-product-builder-source' });
        if (!uploaded.ok) throw new Error(`图片“${file.fileName}”上传失败：${uploaded.message}`);
        sourceImageUrls.push(uploaded.publicUrl); await this.registerImageLibraryEntry(connection, id, uploaded.publicUrl, { type: 'image_product_builder_source', itemNumber, index });
      }
      const snapshot = { originalModelProviderId: Number(settings.original_model_provider_id), originalTemplateId: Number(settings.original_template_id) || null, originalPrompt: settings.original_prompt || '', carouselModelProviderId: Number(settings.carousel_model_provider_id), carouselTemplateIds: this.parseJsonColumn(settings.carousel_template_ids, []) };
      const [created] = await connection.execute(`INSERT INTO image_product_builder_tasks (user_id, builder_type, item_number, status, progress_percent, progress_message, source_image_urls, config_snapshot)
        VALUES (?, ?, ?, 'queued', 3, '图片已上传，等待生成。', CAST(? AS JSON), CAST(? AS JSON))`, [id, type, itemNumber, JSON.stringify(sourceImageUrls), JSON.stringify(snapshot)]);
      return { ok: true, taskId: Number(created.insertId), itemNumber, message: `已创建任务 ${itemNumber}。` };
    } catch (error) { if (connection) await connection.rollback().catch(() => {}); return { ok: false, code: error.code || 'IMAGE_PRODUCT_BUILDER_ERROR', message: error.message }; }
    finally { if (connection) await connection.end(); }
  }

  async listImageProductBuilderTasks(userId, builderType = 'tablecloth', options = {}) {
    let connection;
    try { const id = Number(userId); const pageSize = 20; const requestedPage = Math.max(1, Number(options?.page) || 1); const focusTaskId = Number(options?.focusTaskId); const type = String(builderType || 'tablecloth'); if (!Number.isInteger(id) || id < 1) throw new Error('请先登录本机用户。'); connection = await this.openConnection(await this.getConfig()); await this.ensureImageProductBuilderTables(connection); await this.ensureFolderBuilderAutomationRunsTable(connection);
      const [[count]] = await connection.execute(`SELECT COUNT(*) AS total FROM image_product_builder_tasks WHERE user_id = ? AND builder_type = ?`, [id, type]);
      const total = Number(count?.total || 0); const totalPages = Math.max(1, Math.ceil(total / pageSize)); let page = Math.min(requestedPage, totalPages); let focusFound = false;
      if (Number.isInteger(focusTaskId) && focusTaskId > 0) {
        const [[focusTask]] = await connection.execute('SELECT created_at, id FROM image_product_builder_tasks WHERE id = ? AND user_id = ? AND builder_type = ? LIMIT 1', [focusTaskId, id, type]);
        if (focusTask) {
          const [[newer]] = await connection.execute(`SELECT COUNT(*) AS total FROM image_product_builder_tasks WHERE user_id = ? AND builder_type = ? AND (created_at > ? OR (created_at = ? AND id > ?))`, [id, type, focusTask.created_at, focusTask.created_at, focusTask.id]);
          page = Math.floor(Number(newer?.total || 0) / pageSize) + 1; focusFound = true;
        }
      }
      const offset = (page - 1) * pageSize;
      const [tasks] = await connection.execute(`SELECT t.id, t.item_number, t.status, t.progress_percent, t.progress_message, t.source_image_urls, t.original_image_urls, t.carousel_image_urls, t.product_id, t.error_message, t.created_at, t.finished_at,
        p.id AS active_product_id,
        r.id AS automation_run_id, r.run_status AS automation_run_status, r.current_stage AS automation_current_stage, r.progress_percent AS automation_progress_percent, r.progress_message AS automation_progress_message, r.error_message AS automation_error_message
        FROM image_product_builder_tasks t LEFT JOIN products p ON p.id = t.product_id AND p.deleted_at IS NULL LEFT JOIN folder_builder_automation_runs r ON r.id = (
          SELECT r2.id FROM folder_builder_automation_runs r2 WHERE r2.user_id = t.user_id AND r2.product_id = t.product_id ORDER BY r2.id DESC LIMIT 1
        ) WHERE t.user_id = ? AND t.builder_type = ? ORDER BY t.created_at DESC, t.id DESC LIMIT ? OFFSET ?`, [id, type, pageSize, offset]);
      return { ok: true, tasks: tasks.map((task) => {
        const activeProductId = Number(task.active_product_id) || null;
        return { ...task, product_id: activeProductId, source_image_urls: this.parseJsonColumn(task.source_image_urls, []), original_image_urls: this.parseJsonColumn(task.original_image_urls, []), carousel_image_urls: this.parseJsonColumn(task.carousel_image_urls, []), automation: activeProductId && task.automation_run_id ? { id: Number(task.automation_run_id), status: task.automation_run_status, stage: task.automation_current_stage, percent: Number(task.automation_progress_percent) || 0, message: task.automation_progress_message, errorMessage: task.automation_error_message } : null };
      }), pagination: { page, pageSize, total, totalPages }, focusFound };
    } catch (error) { return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message, tasks: [], pagination: null }; } finally { if (connection) await connection.end(); }
  }

  async deleteImageProductBuilderTasks(userId, taskIds = [], builderType = 'tablecloth') {
    let connection;
    try {
      const id = Number(userId); const type = String(builderType || 'tablecloth');
      const ids = [...new Set((Array.isArray(taskIds) ? taskIds : []).map(Number).filter((taskId) => Number.isInteger(taskId) && taskId > 0))];
      if (!Number.isInteger(id) || id < 1 || !ids.length) throw new Error('请选择要删除的桌布任务。');
      connection = await this.openConnection(await this.getConfig()); await this.ensureImageProductBuilderTables(connection);
      const placeholders = ids.map(() => '?').join(', ');
      const [tasks] = await connection.execute(`SELECT id, item_number, status FROM image_product_builder_tasks
        WHERE user_id = ? AND builder_type = ? AND id IN (${placeholders})`, [id, type, ...ids]);
      const deletableIds = tasks.filter((task) => task.status !== 'running').map((task) => Number(task.id));
      const runningTasks = tasks.filter((task) => task.status === 'running').map((task) => task.item_number);
      if (deletableIds.length) {
        const deletePlaceholders = deletableIds.map(() => '?').join(', ');
        await connection.execute(`DELETE FROM image_product_builder_tasks WHERE user_id = ? AND builder_type = ? AND id IN (${deletePlaceholders})`, [id, type, ...deletableIds]);
      }
      return { ok: true, deletedIds: deletableIds, skippedRunning: runningTasks, message: `已删除 ${deletableIds.length} 个任务${runningTasks.length ? `；${runningTasks.length} 个生成中的任务未删除。` : '。'} 已创建的商品草稿不会被删除。` };
    } catch (error) { return { ok: false, code: error.code || 'IMAGE_PRODUCT_BUILDER_DELETE_ERROR', message: error.message, deletedIds: [], skippedRunning: [] }; }
    finally { if (connection) await connection.end(); }
  }

  async getImageProductBuilderTaskImages(userId, taskIds = [], imageGroup = 'original', builderType = 'tablecloth') {
    let connection;
    try {
      const id = Number(userId); const type = String(builderType || 'tablecloth');
      const ids = [...new Set((Array.isArray(taskIds) ? taskIds : []).map(Number).filter((taskId) => Number.isInteger(taskId) && taskId > 0))];
      const column = imageGroup === 'carousel' ? 'carousel_image_urls' : 'original_image_urls';
      if (!Number.isInteger(id) || id < 1 || !ids.length) throw new Error('请选择要下载的桌布任务。');
      connection = await this.openConnection(await this.getConfig()); await this.ensureImageProductBuilderTables(connection);
      const placeholders = ids.map(() => '?').join(', ');
      const [tasks] = await connection.execute(`SELECT id, item_number, ${column} AS image_urls FROM image_product_builder_tasks
        WHERE user_id = ? AND builder_type = ? AND id IN (${placeholders}) ORDER BY created_at DESC, id DESC`, [id, type, ...ids]);
      return { ok: true, tasks: tasks.map((task) => ({ id: Number(task.id), itemNumber: task.item_number, imageUrls: this.parseJsonColumn(task.image_urls, []).map((url) => String(url || '').trim()).filter((url) => /^https?:\/\//i.test(url)) })) };
    } catch (error) { return { ok: false, code: error.code || 'IMAGE_PRODUCT_BUILDER_EXPORT_ERROR', message: error.message, tasks: [] }; }
    finally { if (connection) await connection.end(); }
  }

  async deleteImageProductBuilderTaskImage(userId, taskId, imageGroup, imageUrl, builderType = 'tablecloth') {
    let connection;
    try {
      const id = Number(userId); const targetTaskId = Number(taskId); const group = String(imageGroup || ''); const type = String(builderType || 'tablecloth'); const url = String(imageUrl || '').trim();
      if (!Number.isInteger(id) || id < 1 || !Number.isInteger(targetTaskId) || !['original', 'carousel'].includes(group) || !url) throw new Error('删除图片参数无效。');
      connection = await this.openConnection(await this.getConfig()); await this.ensureImageProductBuilderTables(connection);
      const [[task]] = await connection.execute(`SELECT original_image_urls, carousel_image_urls FROM image_product_builder_tasks WHERE id = ? AND user_id = ? AND builder_type = ? LIMIT 1`, [targetTaskId, id, type]);
      if (!task) throw new Error('以图建品任务不存在。');
      const column = group === 'carousel' ? 'carousel_image_urls' : 'original_image_urls'; const imageUrls = this.parseJsonColumn(task[column], []);
      if (!imageUrls.includes(url)) throw new Error('该图片已不存在于当前任务。');
      const remainingUrls = imageUrls.filter((item) => item !== url);
      await connection.execute(`UPDATE image_product_builder_tasks SET ${column} = CAST(? AS JSON), updated_at = NOW() WHERE id = ? AND user_id = ? AND builder_type = ?`, [JSON.stringify(remainingUrls), targetTaskId, id, type]);
      return { ok: true, message: `已从任务中删除该${group === 'carousel' ? '轮播图' : '原图'}。` };
    } catch (error) { return { ok: false, code: error.code || 'IMAGE_PRODUCT_BUILDER_IMAGE_DELETE_ERROR', message: error.message }; }
    finally { if (connection) await connection.end(); }
  }

  async runImageProductBuilderTask(userId, taskId, onProgress = () => {}, options = {}) {
    const id = Number(userId); const targetTaskId = Number(taskId); let task;
    const cancelledError = () => Object.assign(new Error('任务已终止。'), { code: 'TASK_CANCELLED' });
    const throwIfCancelled = async () => { if (await options.shouldCancel?.()) throw cancelledError(); };
    const update = async (status, percent, message, fields = {}) => { let connection; try { connection = await this.openConnection(await this.getConfig()); await connection.execute(`UPDATE image_product_builder_tasks SET status = ?, progress_percent = ?, progress_message = ?, original_image_urls = COALESCE(CAST(? AS JSON), original_image_urls), carousel_image_urls = COALESCE(CAST(? AS JSON), carousel_image_urls), error_message = ?, finished_at = ${status === 'succeeded' || status === 'failed' ? 'NOW()' : 'NULL'}, updated_at = NOW() WHERE id = ? AND user_id = ?`, [status, percent, String(message).slice(0, 500), fields.originalImageUrls ? JSON.stringify(fields.originalImageUrls) : null, fields.carouselImageUrls ? JSON.stringify(fields.carouselImageUrls) : null, fields.errorMessage || null, targetTaskId, id]); } finally { if (connection) await connection.end(); } onProgress({ taskId: targetTaskId, status, percent, message }); };
    try {
      let connection = await this.openConnection(await this.getConfig()); await this.ensureImageProductBuilderTables(connection); const [[row]] = await connection.execute(`SELECT * FROM image_product_builder_tasks WHERE id = ? AND user_id = ? LIMIT 1`, [targetTaskId, id]);
      const useCurrentConfig = options.configurationMode === 'current';
      const [[settings]] = useCurrentConfig && row ? await connection.execute(`SELECT original_model_provider_id, original_template_id, original_prompt, carousel_model_provider_id, carousel_template_ids
        FROM image_product_builder_settings WHERE user_id = ? AND builder_type = ? LIMIT 1`, [id, row.builder_type]) : [[]];
      await connection.end(); if (!row) throw new Error('以图建品任务不存在。'); task = row;
      const snapshot = useCurrentConfig ? {
        originalModelProviderId: Number(settings?.original_model_provider_id) || null,
        originalTemplateId: Number(settings?.original_template_id) || null,
        originalPrompt: settings?.original_prompt || '',
        carouselModelProviderId: Number(settings?.carousel_model_provider_id) || null,
        carouselTemplateIds: this.parseJsonColumn(settings?.carousel_template_ids, []),
      } : this.parseJsonColumn(task.config_snapshot, {});
      const sourceUrls = this.parseJsonColumn(task.source_image_urls, []); if (!sourceUrls.length) throw new Error('任务没有可用的源图片。');
      const existingOriginalUrls = this.parseJsonColumn(task.original_image_urls, []); const existingCarouselUrls = this.parseJsonColumn(task.carousel_image_urls, []);
      await throwIfCancelled();
      await update('running', 10, '正在生成原图。');
      const original = await this.generateLibraryImageEdit(id, { sourceImageUrl: sourceUrls[0], sourceImageUrls: sourceUrls, modelProviderId: snapshot.originalModelProviderId, templateId: snapshot.originalTemplateId, prompt: snapshot.originalPrompt,
        generationType: 'original_image', productTitle: task.item_number, imageProductBuilderTaskId: targetTaskId });
      if (!original.ok || !original.imageUrls?.length) throw new Error(original.message || '原图生成失败。'); const originalUrls = options.appendResults ? [...existingOriginalUrls, ...original.imageUrls] : original.imageUrls;
      const carousel = []; const templateIds = Array.isArray(snapshot.carouselTemplateIds) ? snapshot.carouselTemplateIds : [];
      for (let index = 0; index < templateIds.length; index += 1) { await throwIfCancelled(); await update('running', 35 + Math.round((index / templateIds.length) * 55), `正在生成轮播图 ${index + 1}/${templateIds.length}。`, { originalImageUrls: originalUrls, carouselImageUrls: options.appendResults ? [...existingCarouselUrls, ...carousel] : carousel }); const result = await this.generateLibraryImageEdit(id, { sourceImageUrl: original.imageUrls[0], modelProviderId: snapshot.carouselModelProviderId, templateId: templateIds[index],
        generationType: 'carousel_image', productTitle: task.item_number, imageProductBuilderTaskId: targetTaskId }); if (!result.ok || !result.imageUrls?.length) throw new Error(result.message || `第 ${index + 1} 张轮播图生成失败。`); carousel.push(...result.imageUrls); }
      await throwIfCancelled();
      const carouselUrls = options.appendResults ? [...existingCarouselUrls, ...carousel] : carousel;
      await update('succeeded', 100, options.appendResults ? `任务重新执行完成，已追加原图 ${original.imageUrls.length} 张、轮播图 ${carousel.length} 张。` : `任务完成：原图 ${originalUrls.length} 张，轮播图 ${carouselUrls.length} 张。`, { originalImageUrls: originalUrls, carouselImageUrls: carouselUrls });
      if (options.appendResults) await this.syncImageProductBuilderImagesToProduct(id, targetTaskId, originalUrls, carouselUrls);
      return { ok: true };
    } catch (error) {
      if (error?.code === 'TASK_CANCELLED') { await update('cancelled', 100, '任务已终止。'); return { ok: false, cancelled: true, message: '任务已终止。' }; }
      await update('failed', 100, `任务失败：${error.message || '未知错误'}`, { errorMessage: String(error.message || '未知错误') }); return { ok: false, message: error.message };
    }
  }

  async rerunImageProductBuilderTaskImages(userId, taskId, imageGroup = 'original', onProgress = () => {}, options = {}) {
    const id = Number(userId); const targetTaskId = Number(taskId); const group = String(imageGroup || ''); const type = 'tablecloth'; let previousStatus = '';
    const label = group === 'carousel' ? '轮播图' : '原图';
    const update = async (status, percent, message, fields = {}) => {
      let connection;
      try {
        connection = await this.openConnection(await this.getConfig());
        await connection.execute(`UPDATE image_product_builder_tasks SET status = ?, progress_percent = ?, progress_message = ?, original_image_urls = CAST(? AS JSON), carousel_image_urls = CAST(? AS JSON), error_message = ?, finished_at = CASE WHEN ? THEN NOW() ELSE finished_at END, updated_at = NOW() WHERE id = ? AND user_id = ? AND builder_type = ?`, [
          status, percent, String(message).slice(0, 500), JSON.stringify(fields.originalImageUrls || []), JSON.stringify(fields.carouselImageUrls || []), fields.errorMessage || null,
          status === 'succeeded' || status === 'failed', targetTaskId, id, type
        ]);
      } finally { if (connection) await connection.end(); }
      onProgress({ taskId: targetTaskId, status, percent, message, imageGroup: group, rerun: true });
    };
    try {
      if (!Number.isInteger(id) || id < 1 || !Number.isInteger(targetTaskId) || !['original', 'carousel'].includes(group)) throw new Error('重新执行参数无效。');
      let connection = await this.openConnection(await this.getConfig()); await this.ensureImageProductBuilderTables(connection);
      const [[task]] = await connection.execute(`SELECT * FROM image_product_builder_tasks WHERE id = ? AND user_id = ? AND builder_type = ? LIMIT 1`, [targetTaskId, id, type]);
      const [[settings]] = await connection.execute(`SELECT original_model_provider_id, original_template_id, original_prompt, carousel_model_provider_id, carousel_template_ids FROM image_product_builder_settings WHERE user_id = ? AND builder_type = ? LIMIT 1`, [id, type]);
      await connection.end();
      if (!task) throw new Error('以图建品任务不存在。');
      if (task.status === 'running') throw new Error('该任务正在生成中，请等待当前任务完成后再重新执行。');
      previousStatus = task.status;
      if (!settings) throw new Error('请先保存以图建品配置。');
      const sourceUrls = this.parseJsonColumn(task.source_image_urls, []); const existingOriginalUrls = this.parseJsonColumn(task.original_image_urls, []); const existingCarouselUrls = this.parseJsonColumn(task.carousel_image_urls, []);
      if (!sourceUrls.length) throw new Error('任务没有可用的展示图。');
      if (group === 'original') {
        if (!settings.original_model_provider_id || (!settings.original_template_id && !settings.original_prompt)) throw new Error('请先配置当前原图模型，以及原图提示词或提示词模板。');
        await update('running', 20, '正在重新生成原图。', { originalImageUrls: existingOriginalUrls, carouselImageUrls: existingCarouselUrls });
        const result = await this.generateLibraryImageEdit(id, { sourceImageUrl: sourceUrls[0], sourceImageUrls: sourceUrls, modelProviderId: settings.original_model_provider_id, templateId: settings.original_template_id, prompt: settings.original_prompt, generationType: 'original_image', productTitle: task.item_number, imageProductBuilderTaskId: targetTaskId });
        if (!result.ok || !result.imageUrls?.length) throw new Error(result.message || '原图重新生成失败。');
        const originalImageUrls = [...existingOriginalUrls, ...result.imageUrls];
        await update('succeeded', 100, `原图重新生成完成，已追加 ${result.imageUrls.length} 张。`, { originalImageUrls, carouselImageUrls: existingCarouselUrls });
        await this.syncImageProductBuilderImagesToProduct(id, targetTaskId, originalImageUrls, existingCarouselUrls);
        return { ok: true, message: `已重新生成原图并追加 ${result.imageUrls.length} 张。` };
      }
      const configuredTemplateIds = this.parseJsonColumn(settings.carousel_template_ids, []).map(Number).filter((templateId) => Number.isInteger(templateId) && templateId > 0);
      const requestedTemplateId = Number(options?.templateId);
      const templateIds = Number.isInteger(requestedTemplateId) && requestedTemplateId > 0 ? [requestedTemplateId] : configuredTemplateIds;
      if (requestedTemplateId && !configuredTemplateIds.includes(requestedTemplateId)) throw new Error('该轮播图提示词模板已不存在或未被当前配置选中。');
      if (!settings.carousel_model_provider_id || !templateIds.length) throw new Error('请先配置当前轮播图模型并至少选择一个轮播图提示词模板。');
      const referenceUrl = existingOriginalUrls.at(-1) || sourceUrls[0];
      let carouselImageUrls = [...existingCarouselUrls];
      for (let index = 0; index < templateIds.length; index += 1) {
        await update('running', 15 + Math.round((index / templateIds.length) * 75), `正在重新生成轮播图 ${index + 1}/${templateIds.length}。`, { originalImageUrls: existingOriginalUrls, carouselImageUrls });
        const result = await this.generateLibraryImageEdit(id, { sourceImageUrl: referenceUrl, modelProviderId: settings.carousel_model_provider_id, templateId: templateIds[index], generationType: 'carousel_image', productTitle: task.item_number, imageProductBuilderTaskId: targetTaskId });
        if (!result.ok || !result.imageUrls?.length) throw new Error(result.message || `第 ${index + 1} 张轮播图重新生成失败。`);
        carouselImageUrls = [...carouselImageUrls, ...result.imageUrls];
      }
      await update('succeeded', 100, `轮播图重新生成完成，已追加 ${carouselImageUrls.length - existingCarouselUrls.length} 张。`, { originalImageUrls: existingOriginalUrls, carouselImageUrls });
      await this.syncImageProductBuilderImagesToProduct(id, targetTaskId, existingOriginalUrls, carouselImageUrls);
      return { ok: true, message: `已重新生成轮播图并追加 ${carouselImageUrls.length - existingCarouselUrls.length} 张。` };
    } catch (error) {
      let connection;
      try {
        connection = await this.openConnection(await this.getConfig());
        const [[task]] = await connection.execute(`SELECT status, original_image_urls, carousel_image_urls FROM image_product_builder_tasks WHERE id = ? AND user_id = ? AND builder_type = ? LIMIT 1`, [targetTaskId, id, type]);
        const finalStatus = previousStatus === 'succeeded' ? 'succeeded' : 'failed';
        const originalImageUrls = this.parseJsonColumn(task?.original_image_urls, []); const carouselImageUrls = this.parseJsonColumn(task?.carousel_image_urls, []);
        await connection.end(); connection = null;
        await update(finalStatus, 100, `${label}重新生成失败，已保留原有图片。`, { originalImageUrls, carouselImageUrls, errorMessage: String(error.message || '未知错误') });
      } catch (_) { if (connection) await connection.end(); }
      return { ok: false, message: error.message || '重新生成失败。' };
    }
  }

  async syncImageProductBuilderImagesToProduct(userId, taskId, originalImageUrls, carouselImageUrls) {
    let connection;
    try {
      connection = await this.openConnection(await this.getConfig());
      const [[task]] = await connection.execute('SELECT product_id FROM image_product_builder_tasks WHERE id = ? AND user_id = ? LIMIT 1', [taskId, userId]);
      const productId = Number(task?.product_id);
      if (!Number.isInteger(productId) || productId < 1) return { ok: true, skipped: true };
      const [[product]] = await connection.execute('SELECT raw_data FROM products WHERE id = ? AND deleted_at IS NULL LIMIT 1', [productId]);
      if (!product) return { ok: true, skipped: true };
      const rawData = this.parseJsonColumn(product.raw_data, {}); const detail = rawData._miaoshouDetail && typeof rawData._miaoshouDetail === 'object' ? rawData._miaoshouDetail : {};
      const imageUrls = [...originalImageUrls, ...carouselImageUrls];
      detail.imgUrls = imageUrls;
      detail.goodsLayerDecorationReqs = imageUrls.map((imgUrl) => ({ type: 'image', content: { imgUrl } }));
      rawData._miaoshouDetail = detail;
      rawData._imageProductBuilder = { ...(rawData._imageProductBuilder || {}), taskId, originalImageUrls, carouselImageUrls, updatedAt: new Date().toISOString() };
      await connection.execute('UPDATE products SET ai_generated_image_urls = CAST(? AS JSON), raw_data = CAST(? AS JSON), updated_at = NOW() WHERE id = ?', [JSON.stringify(carouselImageUrls), JSON.stringify(rawData), productId]);
      return { ok: true, productId };
    } catch (error) { return { ok: false, message: error.message }; } finally { if (connection) await connection.end(); }
  }

  async createImageProductBuilderProduct(userId, taskId, categoryId) {
    let connection;
    try {
      const id = Number(userId); const targetTaskId = Number(taskId); const selectedCategoryId = Number(categoryId);
      if (!Number.isInteger(id) || id < 1 || !Number.isInteger(targetTaskId) || !Number.isInteger(selectedCategoryId)) throw new Error('创建商品参数无效。');
      connection = await this.openConnection(await this.getConfig()); await this.ensureImageProductBuilderTables(connection); await this.ensureCategoryTables(connection); await this.ensureCommonTemplateCategoriesTable(connection); await this.ensureCommonCategoryAttributeTemplatesTable(connection);
      const [[task]] = await connection.execute(`SELECT * FROM image_product_builder_tasks WHERE id = ? AND user_id = ? AND status = 'succeeded' LIMIT 1`, [targetTaskId, id]); if (!task) throw new Error('请等待以图建品任务成功后再创建商品。');
      if (task.product_id) {
        const [[existingProduct]] = await connection.execute(`SELECT id FROM products WHERE id = ? AND deleted_at IS NULL LIMIT 1`, [Number(task.product_id)]);
        if (existingProduct) return { ok: true, productId: Number(task.product_id), existing: true, message: '该任务已经创建过商品。' };
        await connection.execute(`UPDATE image_product_builder_tasks SET product_id = NULL, updated_at = NOW() WHERE id = ?`, [targetTaskId]);
        task.product_id = null;
      }
      const [[category]] = await connection.execute(`SELECT c.id, c.category_name, c.full_path, c.external_category_id FROM user_common_categories ucc JOIN categories c ON c.id = ucc.category_id JOIN category_versions cv ON cv.id = c.category_version_id WHERE ucc.user_id = ? AND c.id = ? AND c.status = 1 AND c.is_leaf = 1 AND cv.is_active = 1 LIMIT 1`, [id, selectedCategoryId]); if (!category) throw new Error('请选择有效的常用类目。');
      const originalUrls = this.parseJsonColumn(task.original_image_urls, []); const carouselUrls = this.parseJsonColumn(task.carousel_image_urls, []); const imageUrls = [...originalUrls, ...carouselUrls]; const template = await this.getSavedCommonCategoryAttributeTemplate(connection, id, selectedCategoryId);
      const detail = this.applyCommonCategoryAttributeTemplate({ itemNum: task.item_number, cateList: String(category.full_path || category.category_name || '').split(' / ').map((name) => name.trim()).filter(Boolean), cid: String(category.external_category_id || ''), imgUrls: imageUrls, saleAttributes: [], skuMap: {} }, template);
      detail.itemNum = task.item_number; detail.imgUrls = imageUrls; detail.goodsLayerDecorationReqs = imageUrls.map((imgUrl) => ({ type: 'image', content: { imgUrl } }));
      const rawData = { _miaoshouDetail: detail, _imageProductBuilder: { taskId: targetTaskId, builderType: task.builder_type, itemNumber: task.item_number, sourceImageUrls: this.parseJsonColumn(task.source_image_urls, []), originalImageUrls: originalUrls, carouselImageUrls: carouselUrls, createdAt: new Date().toISOString() } };
      await connection.beginTransaction(); const [created] = await connection.execute(`INSERT INTO products (source_platform_code, source_product_id, target_platform_code, current_category_id, title, ai_generated_image_urls, product_status, raw_data, created_by) VALUES ('image_product_builder', ?, 'local', ?, ?, CAST(? AS JSON), 'pending_process', CAST(? AS JSON), ?)`, [`image-task-${targetTaskId}`, selectedCategoryId, task.item_number, JSON.stringify(carouselUrls), JSON.stringify(rawData), id]);
      await connection.execute(`UPDATE image_product_builder_tasks SET product_id = ?, updated_at = NOW() WHERE id = ?`, [created.insertId, targetTaskId]); await connection.commit(); return { ok: true, productId: Number(created.insertId), message: `商品草稿已创建，并回填 ${Number(detail._localAttributeTemplateApplied) || 0} 项类目模板字段。` };
    } catch (error) { if (connection) await connection.rollback().catch(() => {}); return { ok: false, code: error.code || 'IMAGE_PRODUCT_BUILDER_PRODUCT_ERROR', message: error.message }; } finally { if (connection) await connection.end(); }
  }

  async getFolderBuilderSettings(userId) {
    let connection;
    try {
      const id = Number(userId);
      if (!Number.isInteger(id) || id < 1) throw new Error('请先登录本机用户。');
      const config = await this.getConfig();
      connection = await this.openConnection(config);
      await this.ensureFolderBuilderSettingsTable(connection);
      await this.ensureModelProvidersTable(connection, config);
      await this.ensureTemplateCategoriesTable(connection);
      const [[settings]] = await connection.execute(`SELECT sku_ai_enabled, model_provider_id, template_id, prompt_content
        FROM folder_builder_settings WHERE user_id = ? LIMIT 1`, [id]);
      const [providers] = await connection.execute(`SELECT id, provider_name, default_model, provider_type, image_adapter FROM model_providers
        WHERE is_enabled = 1 ORDER BY is_active DESC, sort_order, id`);
      const [templates] = await connection.execute(`SELECT id, template_name FROM templates
        WHERE status = 'enabled' AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC`);
      return { ok: true, settings: settings || { sku_ai_enabled: 0, model_provider_id: null, template_id: null, prompt_content: '' }, providers: providers.map((provider) => ({ ...provider, capabilities: providerCapabilities(provider) })), templates };
    } catch (error) {
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message, settings: null, providers: [], templates: [] };
    } finally { if (connection) await connection.end(); }
  }

  async saveFolderBuilderSettings(userId, setting = {}) {
    let connection;
    try {
      const id = Number(userId);
      const enabled = setting.skuAiEnabled === true;
      const providerId = Number(setting.modelProviderId) || null;
      const templateId = Number(setting.templateId) || null;
      const prompt = String(setting.promptContent || '').trim().slice(0, 12000);
      if (!Number.isInteger(id) || id < 1) throw new Error('请先登录本机用户。');
      if (enabled && !providerId) throw new Error('启用 SKU AI 识别时，请选择一个大模型。');
      if (enabled && !prompt && !templateId) throw new Error('启用 SKU AI 识别时，请填写提示词或选择提示词模板。');
      const config = await this.getConfig();
      connection = await this.openConnection(config);
      await this.ensureFolderBuilderSettingsTable(connection);
      if (providerId) {
        const [[provider]] = await connection.execute('SELECT id FROM model_providers WHERE id = ? AND is_enabled = 1 LIMIT 1', [providerId]);
        if (!provider) throw new Error('所选大模型不存在或已停用。');
      }
      if (templateId) {
        const [[template]] = await connection.execute("SELECT id FROM templates WHERE id = ? AND status = 'enabled' AND deleted_at IS NULL LIMIT 1", [templateId]);
        if (!template) throw new Error('所选提示词模板不存在或已停用。');
      }
      await connection.execute(`INSERT INTO folder_builder_settings (user_id, sku_ai_enabled, model_provider_id, template_id, prompt_content)
        VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE sku_ai_enabled = VALUES(sku_ai_enabled), model_provider_id = VALUES(model_provider_id),
        template_id = VALUES(template_id), prompt_content = VALUES(prompt_content)`, [id, enabled ? 1 : 0, providerId, templateId, prompt || null]);
      return { ok: true, message: '文件夹建品 SKU 识别设置已保存。' };
    } catch (error) {
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message };
    } finally { if (connection) await connection.end(); }
  }

  async ensureImageLibraryTable(connection) {
    await connection.query(`CREATE TABLE IF NOT EXISTS image_library_items (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, user_id BIGINT UNSIGNED NOT NULL, url_hash CHAR(64) NOT NULL,
      image_url VARCHAR(2048) NOT NULL, storage_source VARCHAR(32) NOT NULL DEFAULT 'external', image_types JSON NULL,
      reference_summary JSON NULL, reference_count INT UNSIGNED NOT NULL DEFAULT 0, is_active TINYINT UNSIGNED NOT NULL DEFAULT 1,
      first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id), UNIQUE KEY uk_image_library_user_url (user_id, url_hash), KEY idx_image_library_user_seen (user_id, is_active, last_seen_at), KEY idx_image_library_user_first_seen (user_id, is_active, first_seen_at),
      CONSTRAINT fk_image_library_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB COMMENT='业务图片图库索引'`);
    const [indexes] = await connection.query("SHOW INDEX FROM image_library_items WHERE Key_name = 'idx_image_library_user_first_seen'");
    if (!indexes.length) await connection.query('ALTER TABLE image_library_items ADD KEY idx_image_library_user_first_seen (user_id, is_active, first_seen_at)');
  }

  imageLibraryUrl(value) {
    const url = String(value || '').trim();
    if (!/^https?:\/\//i.test(url)) return null;
    try { const parsed = new URL(url); parsed.search = ''; parsed.hash = ''; return parsed.toString(); } catch (_) { return url; }
  }

  collectImageUrls(value, entries, reference, key = '') {
    if (typeof value === 'string') {
      const url = this.imageLibraryUrl(value);
      if (url && /(?:img|image|url)/i.test(key) && !/video/i.test(key)) entries.push({ url, reference });
      return;
    }
    if (Array.isArray(value)) { value.forEach((item) => this.collectImageUrls(item, entries, reference, key)); return; }
    if (value && typeof value === 'object') Object.entries(value).forEach(([childKey, childValue]) => this.collectImageUrls(childValue, entries, reference, childKey));
  }

  async registerImageLibraryEntry(connection, userId, url, reference) {
    const imageUrl = this.imageLibraryUrl(url);
    if (!imageUrl) return;
    await this.ensureImageLibraryTable(connection);
    const urlHash = crypto.createHash('sha256').update(imageUrl).digest('hex');
    const storageSource = /aliyuncs\.com|oss-/i.test(imageUrl) ? 'oss' : /miaoshou|kwcdn/i.test(imageUrl) ? 'miaoshou' : 'external';
    await connection.execute(`INSERT INTO image_library_items (user_id, url_hash, image_url, storage_source, image_types, reference_summary, reference_count, is_active, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), 1, 1, NOW(), NOW())
      ON DUPLICATE KEY UPDATE image_types = VALUES(image_types), reference_summary = VALUES(reference_summary), reference_count = GREATEST(reference_count, 1), is_active = 1, last_seen_at = NOW()`,
    [Number(userId), urlHash, imageUrl, storageSource, JSON.stringify([reference.type || 'uploaded_image']), JSON.stringify([reference])]);
  }

  async syncImageLibrary(userId) {
    let connection;
    try {
      const id = Number(userId);
      if (!Number.isInteger(id) || id < 1) throw new Error('请先登录本机用户。');
      connection = await this.openConnection(await this.getConfig());
      await this.ensureImageLibraryTable(connection);
      await this.ensureAiGenerationRecordsTable(connection);
      await this.ensureCommonCategoryAttributeTemplatesTable(connection);
      await this.ensureProductSkuGeneratedImagesTable(connection);
      const entries = [];
      const push = (url, reference) => { const normalized = this.imageLibraryUrl(url); if (normalized) entries.push({ url: normalized, reference }); };
      const [assets] = await connection.execute(`SELECT a.original_url, a.object_key, a.asset_kind, p.id AS product_id, p.title
        FROM assets a JOIN products p ON p.id = a.product_id WHERE p.created_by = ? AND p.deleted_at IS NULL AND a.deleted_at IS NULL`, [id]);
      assets.forEach((asset) => push(asset.original_url, { type: asset.asset_kind || 'source_image', productId: asset.product_id, productTitle: asset.title }));
      const [products] = await connection.execute(`SELECT id, title, raw_data, ai_generated_image_urls FROM products WHERE created_by = ? AND deleted_at IS NULL`, [id]);
      products.forEach((product) => {
        const base = { productId: product.id, productTitle: product.title };
        this.parseJsonColumn(product.ai_generated_image_urls, []).forEach((url) => push(url, { ...base, type: 'ai_generated_image' }));
        this.collectImageUrls(this.parseJsonColumn(product.raw_data, {}), entries, { ...base, type: 'product_detail_image' });
      });
      const [skuImages] = await connection.execute(`SELECT s.image_url, s.sku_index, p.id AS product_id, p.title
        FROM product_sku_generated_images s JOIN products p ON p.id = s.product_id WHERE p.created_by = ? AND p.deleted_at IS NULL`, [id]);
      skuImages.forEach((image) => push(image.image_url, { type: 'sku_generated_image', productId: image.product_id, productTitle: image.title, skuIndex: image.sku_index }));
      const [categoryTemplates] = await connection.execute(`SELECT t.category_id, c.full_path, t.basic_required_fields, t.attribute_values
        FROM user_common_category_attribute_templates t LEFT JOIN categories c ON c.id = t.category_id WHERE t.user_id = ?`, [id]);
      categoryTemplates.forEach((template) => {
        const reference = { type: 'category_template_image', categoryId: template.category_id, categoryName: template.full_path || '' };
        this.collectImageUrls(this.parseJsonColumn(template.basic_required_fields, {}), entries, reference);
        this.collectImageUrls(this.parseJsonColumn(template.attribute_values, {}), entries, reference);
      });
      const [generationRecords] = await connection.execute('SELECT product_id, product_title, generation_type, raw_data, output_summary FROM ai_generation_records WHERE user_id = ?', [id]);
      generationRecords.forEach((record) => {
        const base = { productId: record.product_id, productTitle: record.product_title, generationType: record.generation_type };
        this.collectImageUrls(this.parseJsonColumn(record.raw_data, {}), entries, { ...base, type: 'generation_reference' });
        this.collectImageUrls(this.parseJsonColumn(record.output_summary, {}), entries, { ...base, type: record.generation_type === 'image_edit' ? 'ai_edited_image' : 'generation_output' });
      });
      await connection.execute('UPDATE image_library_items SET is_active = 0 WHERE user_id = ?', [id]);
      const grouped = new Map();
      for (const entry of entries) {
        const key = entry.url;
        const item = grouped.get(key) || { url: entry.url, references: [] };
        item.references.push(entry.reference);
        grouped.set(key, item);
      }
      for (const item of grouped.values()) {
        const uniqueReferences = [...new Map(item.references.map((reference) => [JSON.stringify(reference), reference])).values()];
        const types = [...new Set(uniqueReferences.map((reference) => reference.type))];
        const storageSource = /aliyuncs\.com|oss-/i.test(item.url) ? 'oss' : /miaoshou|kwcdn/i.test(item.url) ? 'miaoshou' : 'external';
        const urlHash = crypto.createHash('sha256').update(item.url).digest('hex');
        await connection.execute(`INSERT INTO image_library_items (user_id, url_hash, image_url, storage_source, image_types, reference_summary, reference_count, is_active, first_seen_at, last_seen_at)
          VALUES (?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), ?, 1, NOW(), NOW())
          ON DUPLICATE KEY UPDATE image_url = VALUES(image_url), storage_source = VALUES(storage_source), image_types = VALUES(image_types),
          reference_summary = VALUES(reference_summary), reference_count = VALUES(reference_count), is_active = 1, last_seen_at = NOW()`,
        [id, urlHash, item.url, storageSource, JSON.stringify(types), JSON.stringify(uniqueReferences.slice(0, 30)), uniqueReferences.length]);
      }
      return { ok: true, scannedReferences: entries.length, imageCount: grouped.size, message: `已同步 ${grouped.size} 张业务图片。` };
    } catch (error) { return { ok: false, code: error.code || 'IMAGE_LIBRARY_SYNC_ERROR', message: error.message }; }
    finally { if (connection) await connection.end(); }
  }

  async getImageLibrary(userId, page = 1, pageSize = 30, filters = {}) {
    let connection;
    try {
      const id = Number(userId); const requestedPage = Math.max(1, Number(page) || 1); const safePageSize = Math.min(100, Math.max(12, Number(pageSize) || 30));
      const type = String(filters.type || '').trim(); const source = ['oss', 'miaoshou', 'external'].includes(String(filters.source || '')) ? String(filters.source) : ''; const keyword = String(filters.keyword || '').trim();
      connection = await this.openConnection(await this.getConfig()); await this.ensureImageLibraryTable(connection);
      const where = ['user_id = ?', 'is_active = 1']; const params = [id];
      if (type) { where.push('JSON_CONTAINS(image_types, JSON_QUOTE(?))'); params.push(type); }
      if (source) { where.push('storage_source = ?'); params.push(source); }
      if (keyword) { where.push('(image_url LIKE ? OR reference_summary LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
      const whereSql = where.join(' AND '); const [[count]] = await connection.execute(`SELECT COUNT(*) AS total FROM image_library_items WHERE ${whereSql}`, params);
      const total = Number(count.total || 0); const totalPages = Math.max(1, Math.ceil(total / safePageSize)); const safePage = Math.min(requestedPage, totalPages);
      const [items] = await connection.execute(`SELECT id, image_url, storage_source, image_types, reference_summary, reference_count, first_seen_at, last_seen_at FROM image_library_items WHERE ${whereSql} ORDER BY first_seen_at DESC, id DESC LIMIT ? OFFSET ?`, [...params, safePageSize, (safePage - 1) * safePageSize]);
      const [types] = await connection.execute('SELECT DISTINCT type_name FROM (SELECT JSON_UNQUOTE(JSON_EXTRACT(image_types, CONCAT(\'$[\', n.n, \']\'))) AS type_name FROM image_library_items JOIN (SELECT 0 n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7) n WHERE user_id = ? AND is_active = 1) t WHERE type_name IS NOT NULL', [id]);
      return { ok: true, items, types: types.map((row) => row.type_name), pagination: { page: safePage, pageSize: safePageSize, total, totalPages } };
    } catch (error) { return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message, items: [], types: [], pagination: null }; }
    finally { if (connection) await connection.end(); }
  }

  async getImageLibraryExportItems(userId, itemIds = []) {
    let connection;
    try {
      const id = Number(userId);
      const ids = [...new Set((Array.isArray(itemIds) ? itemIds : []).map((itemId) => Number(itemId)).filter((itemId) => Number.isInteger(itemId) && itemId > 0))];
      if (!Number.isInteger(id) || id < 1) throw new Error('请先登录本机用户。');
      if (!ids.length) throw new Error('请至少选择一张图片。');
      if (ids.length > 200) throw new Error('一次最多下载 200 张图片。');
      connection = await this.openConnection(await this.getConfig());
      await this.ensureImageLibraryTable(connection);
      const [items] = await connection.execute(`SELECT id, image_url FROM image_library_items
        WHERE user_id = ? AND is_active = 1 AND id IN (${ids.map(() => '?').join(', ')}) ORDER BY id`, [id, ...ids]);
      return { ok: true, items, skipped: ids.length - items.length };
    } catch (error) { return { ok: false, code: error.code || 'IMAGE_LIBRARY_EXPORT_ERROR', message: error.message, items: [], skipped: 0 }; }
    finally { if (connection) await connection.end(); }
  }

  async getAiImageEditSettings(userId) {
    let connection;
    try {
      const id = Number(userId);
      if (!Number.isInteger(id) || id < 1) throw new Error('请先登录本机用户。');
      const config = await this.getConfig();
      connection = await this.openConnection(config);
      await this.ensureAiImageEditSettingsTable(connection);
      await this.ensureModelProvidersTable(connection, config);
      await this.ensureTemplateCategoriesTable(connection);
      let [[settings]] = await connection.execute(`SELECT template_id, model_provider_id, prompt_content, image_size, active_task_id, generation_record_id,
        generation_status, progress_percent, progress_message, task_started_at, task_finished_at
        FROM ai_image_edit_settings WHERE user_id = ? LIMIT 1`, [id]);
      if (settings?.generation_status === 'running' && settings.task_started_at && new Date(settings.task_started_at).getTime() < Date.now() - 10 * 60 * 1000) {
        await connection.execute(`UPDATE ai_image_edit_settings SET generation_status = 'failed', progress_message = '任务已超时或应用已关闭，请重新发起。',
          task_finished_at = NOW(), updated_at = NOW() WHERE user_id = ?`, [id]);
        settings = { ...settings, generation_status: 'failed', progress_message: '任务已超时或应用已关闭，请重新发起。', task_finished_at: new Date() };
      }
      const [providers] = await connection.execute(`SELECT id, provider_name, default_model, provider_type, image_adapter, image_size FROM model_providers
        WHERE is_enabled = 1 AND default_model IS NOT NULL AND default_model <> '' ORDER BY is_active DESC, sort_order, id`);
      const [templates] = await connection.execute(`SELECT id, template_type, template_name FROM templates
        WHERE status = 'enabled' AND deleted_at IS NULL ORDER BY template_type, updated_at DESC, id DESC`);
      return { ok: true, settings: settings || { template_id: null, model_provider_id: null, prompt_content: '', image_size: '', generation_status: 'idle', progress_percent: 0, progress_message: '' }, providers: providers.map((provider) => ({ ...provider, capabilities: providerCapabilities(provider) })).filter((provider) => provider.capabilities.image), templates };
    } catch (error) { return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message, settings: null, providers: [], templates: [] }; }
    finally { if (connection) await connection.end(); }
  }

  async saveAiImageEditSettings(userId, setting = {}) {
    let connection;
    try {
      const id = Number(userId); const templateId = Number(setting.templateId) || null; const providerId = Number(setting.modelProviderId) || null; const prompt = String(setting.prompt || '').trim(); const imageSize = String(setting.imageSize || '').trim().slice(0, 64);
      if (!Number.isInteger(id) || id < 1) throw new Error('请先登录本机用户。');
      connection = await this.openConnection(await this.getConfig());
      await this.ensureAiImageEditSettingsTable(connection);
      if (templateId) {
        const [[template]] = await connection.execute("SELECT id FROM templates WHERE id = ? AND status = 'enabled' AND deleted_at IS NULL LIMIT 1", [templateId]);
        if (!template) throw new Error('所选提示词模板不可用。');
      }
      if (providerId) {
        const [[provider]] = await connection.execute("SELECT id FROM model_providers WHERE id = ? AND is_enabled = 1 AND provider_type <> 'zhipu' LIMIT 1", [providerId]);
        if (!provider) throw new Error('所选图片大模型不可用。');
      }
      await connection.execute(`INSERT INTO ai_image_edit_settings (user_id, template_id, model_provider_id, prompt_content, image_size)
        VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE template_id = VALUES(template_id), model_provider_id = VALUES(model_provider_id), prompt_content = VALUES(prompt_content), image_size = VALUES(image_size), updated_at = NOW()`, [id, templateId, providerId, prompt || null, imageSize || null]);
      return { ok: true, message: 'AI 改图默认配置已保存。' };
    } catch (error) { return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message }; }
    finally { if (connection) await connection.end(); }
  }

  async startAiImageEditTask(userId, taskId) {
    let connection;
    try {
      const id = Number(userId); const safeTaskId = String(taskId || '').trim();
      if (!Number.isInteger(id) || id < 1 || !safeTaskId) throw new Error('AI 改图任务参数无效。');
      connection = await this.openConnection(await this.getConfig());
      await this.ensureAiImageEditSettingsTable(connection);
      await connection.beginTransaction();
      const [[current]] = await connection.execute('SELECT generation_status FROM ai_image_edit_settings WHERE user_id = ? FOR UPDATE', [id]);
      if (current?.generation_status === 'running') throw new Error('已有 AI 改图任务正在执行，请等待完成后再试。');
      await connection.execute(`INSERT INTO ai_image_edit_settings (user_id, active_task_id, generation_status, progress_percent, progress_message, task_started_at, task_finished_at)
        VALUES (?, ?, 'running', 5, '任务已创建，正在准备源图片。', NOW(), NULL)
        ON DUPLICATE KEY UPDATE active_task_id = VALUES(active_task_id), generation_record_id = NULL, generation_status = 'running',
          progress_percent = 5, progress_message = VALUES(progress_message), task_started_at = NOW(), task_finished_at = NULL, updated_at = NOW()`, [id, safeTaskId]);
      await connection.commit();
      return { ok: true, progress: { taskId: safeTaskId, status: 'running', percent: 5, message: '任务已创建，正在准备源图片。' } };
    } catch (error) {
      if (connection) await connection.rollback().catch(() => {});
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message };
    } finally { if (connection) await connection.end(); }
  }

  async updateAiImageEditTaskState(connection, userId, taskId, { status = 'running', percent = 0, message = '', generationRecordId = null, finished = false } = {}) {
    if (!taskId) return;
    await connection.execute(`UPDATE ai_image_edit_settings SET generation_record_id = COALESCE(?, generation_record_id), generation_status = ?,
      progress_percent = ?, progress_message = ?, task_finished_at = ${finished ? 'NOW()' : 'NULL'}, updated_at = NOW()
      WHERE user_id = ? AND active_task_id = ?`, [
      Number(generationRecordId) || null, String(status), Math.max(0, Math.min(100, Number(percent) || 0)), String(message || '').slice(0, 500), Number(userId), String(taskId),
    ]);
  }

  async uploadLibraryImage(userId, file) {
    let connection;
    try {
      const id = Number(userId);
      if (!Number.isInteger(id) || id < 1) return { ok: false, code: 'VALIDATION_ERROR', message: '用户参数无效。' };
      const bytes = file?.bytes instanceof Uint8Array ? Buffer.from(file.bytes) : Buffer.from(Array.isArray(file?.bytes) ? file.bytes : []);
      if (!bytes.length) return { ok: false, code: 'VALIDATION_ERROR', message: '请选择要上传的图片。' };
      const config = await this.getConfig();
      const uploaded = await new OssClient(config.oss).uploadLibraryImage({ userId: id, fileName: file?.fileName, contentType: file?.contentType, buffer: bytes });
      if (!uploaded.ok) return uploaded;
      connection = await this.openConnection(config);
      await this.registerImageLibraryEntry(connection, id, uploaded.publicUrl, { type: String(file?.referenceType || 'library_upload') });
      return { ok: true, publicUrl: uploaded.publicUrl, previewUrl: uploaded.previewUrl, message: '图片已上传到图库。' };
    } catch (error) { return { ok: false, code: error.code || 'OSS_UPLOAD_ERROR', message: error.message }; }
    finally { if (connection) await connection.end(); }
  }

  async createAiGenerationRecord(connection, { userId, productId, productTitle, generationType, modelProviderId = null, modelName = null, templates = [], inputSummary = {}, rawData = {} }) {
    const [created] = await connection.execute(`INSERT INTO ai_generation_records
      (user_id, product_id, product_title, generation_type, record_status, model_provider_id, model_name, templates_snapshot, input_summary, output_summary, raw_data, progress_percent, progress_message, task_started_at)
      VALUES (?, ?, ?, ?, 'running', ?, ?, CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), 0, '任务已创建，等待处理。', NOW())`, [
      Number(userId), Number(productId) || null, String(productTitle || '未命名商品'), String(generationType),
      Number(modelProviderId) || null, modelName ? String(modelName) : null, JSON.stringify(templates || []),
      JSON.stringify(inputSummary || {}), JSON.stringify({}), JSON.stringify(rawData || {}),
    ]);
    return Number(created.insertId);
  }

  async updateAiGenerationRecord(connection, recordId, { status = 'running', successCount = 0, failedCount = 0, errorMessage = null, outputSummary = {}, rawData = {}, progressPercent = null, progressMessage = undefined, finished = false }) {
    if (!Number(recordId)) return;
    await connection.execute(`UPDATE ai_generation_records SET record_status = ?, success_count = ?, failed_count = ?, error_message = ?,
      output_summary = CAST(? AS JSON), raw_data = CAST(? AS JSON), progress_percent = COALESCE(?, progress_percent),
      progress_message = CASE WHEN ? THEN ? ELSE progress_message END, task_finished_at = CASE WHEN ? THEN NOW() ELSE task_finished_at END,
      finished_at = ${finished ? 'NOW()' : 'NULL'}, updated_at = NOW() WHERE id = ?`, [
      String(status), Math.max(0, Number(successCount) || 0), Math.max(0, Number(failedCount) || 0),
      errorMessage ? String(errorMessage).slice(0, 2000) : null, JSON.stringify(outputSummary || {}), JSON.stringify(rawData || {}),
      Number.isFinite(Number(progressPercent)) ? Math.max(0, Math.min(100, Math.round(Number(progressPercent)))) : null,
      progressMessage !== undefined, progressMessage === undefined ? null : String(progressMessage || '').slice(0, 500), Boolean(finished), Number(recordId),
    ]);
  }

  async generateLibraryImageEdit(userId, input = {}) {
    let connection;
    let recordId = null;
    let taskUserId = null;
    let currentProgress = 5;
    const taskId = String(input.taskId || '').trim();
    const notifyProgress = async (percent, message, status = 'running', finished = false) => {
      currentProgress = Math.max(0, Math.min(100, Number(percent) || 0));
      if (connection && taskId) await this.updateAiImageEditTaskState(connection, taskUserId, taskId, { status, percent: currentProgress, message, generationRecordId: recordId, finished });
      input.onProgress?.({ taskId, stage: status, percent: currentProgress, message, generationRecordId: recordId });
    };
    const sourceUrls = [...new Set([input.sourceImageUrl, ...(Array.isArray(input.sourceImageUrls) ? input.sourceImageUrls : [])].map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 6);
    const generationType = ['original_image', 'carousel_image'].includes(String(input.generationType || '')) ? String(input.generationType) : 'image_edit';
    const productTitle = String(input.productTitle || '图库 AI 改图').trim() || '图库 AI 改图';
    const rawData = { sourceImageUrl: sourceUrls[0] || '', sourceImageUrls: sourceUrls, imageProductBuilderTaskId: Number(input.imageProductBuilderTaskId) || null, requests: [] };
    try {
      const id = Number(userId); const sourceUrl = sourceUrls[0]; const templateId = Number(input.templateId) || null;
      const providerId = Number(input.modelProviderId); const customPrompt = String(input.prompt || '').trim(); const requestedImageSize = String(input.imageSize || '').trim().slice(0, 64);
      taskUserId = id;
      const config = await this.getConfig();
      connection = await this.openConnection(config);
      await this.ensureAiGenerationRecordsTable(connection);
      await this.ensureImageLibraryTable(connection);
      await this.ensureAiImageEditSettingsTable(connection);
      if (!Number.isInteger(id) || id < 1 || !sourceUrls.length || sourceUrls.some((url) => !/^https?:\/\//i.test(url))) throw new Error('请选择至少一张有效的源图片。');
      if (!Number.isInteger(providerId) || providerId < 1) throw new Error('请选择图片大模型。');
      const [[provider]] = await connection.execute(`SELECT id, provider_name, provider_type, api_base_url, api_key_value, default_model, failover_models, timeout_seconds, image_adapter, image_size FROM model_providers WHERE id = ? AND is_enabled = 1 LIMIT 1`, [providerId]);
      if (!provider?.api_base_url || !provider?.api_key_value || !provider?.default_model || provider.provider_type === 'zhipu') throw new Error('所选图片大模型不可用或配置不完整。');
      const imageSize = requestedImageSize || modelClient.imageSize(provider);
      let template = null;
      if (templateId) {
        await this.ensureTemplateStorage(connection);
        const [[row]] = await connection.execute(`SELECT t.id, t.template_type, t.template_name, t.prompt_content FROM templates t WHERE t.id = ? AND t.status = 'enabled' AND t.deleted_at IS NULL LIMIT 1`, [templateId]);
        if (!row) throw new Error('所选提示词模板不可用。');
        template = row;
      }
      const prompt = [template && `【提示词模板：${template.template_name}】\n${template.prompt_content}`, customPrompt].filter(Boolean).join('\n\n');
      if (!prompt) throw new Error('请填写提示词或选择提示词模板。');
      recordId = await this.createAiGenerationRecord(connection, { userId: id, productId: null, productTitle, generationType, modelProviderId: providerId, modelName: provider.default_model, templates: template ? [{ id: Number(template.id), name: template.template_name }] : [], inputSummary: { sourceImageUrl: sourceUrl, sourceImageUrls: sourceUrls, promptLength: prompt.length, imageSize }, rawData });
      await notifyProgress(12, '已创建生成记录，正在下载源图片。');
      const timeoutMs = modelTimeoutMs(provider);
      const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const sourceImages = [];
        for (const url of sourceUrls) {
          const sourceResponse = await fetch(url, { signal: controller.signal });
          if (!sourceResponse.ok) throw new Error(`下载源图片失败（HTTP ${sourceResponse.status}）。`);
          const sourceType = String(sourceResponse.headers.get('content-type') || 'image/jpeg').split(';')[0].toLowerCase();
          const sourceBuffer = Buffer.from(await sourceResponse.arrayBuffer());
          if (!sourceType.startsWith('image/') || !sourceBuffer.length || sourceBuffer.length > 20 * 1024 * 1024) throw new Error('源图片无效或超过 20MB。');
          sourceImages.push({ sourceUrl: url, sourceType, sourceBuffer });
        }
        await notifyProgress(25, '源图片已校验，正在准备模型请求。');
        const oss = new OssClient(config.oss); const useSeedream = modelClient.imageAdapter(provider) === 'seedream_images';
        let referenceUrls = [];
        if (useSeedream) {
          for (const [index, source] of sourceImages.entries()) {
            const reference = await oss.uploadLibraryImage({ userId: id, fileName: `ai-edit-source-${index + 1}.jpg`, contentType: source.sourceType, buffer: source.sourceBuffer, kind: 'ai-edit-references' });
            if (!reference.ok) throw new Error(reference.message);
            referenceUrls.push(reference.publicUrl);
          }
        }
        await notifyProgress(35, '已提交图片模型，正在等待生成结果。');
        const requestResult = await this.requestWithModelFailover({
          provider, signal: controller.signal, timeoutMs,
          buildRequest: (model) => {
            const endpoint = modelClient.imageEndpoint(provider);
            if (useSeedream) {
              const request = { model, prompt, image: referenceUrls, size: imageSize, output_format: 'png', response_format: 'url', watermark: false };
              return { endpoint, headers: { Authorization: `Bearer ${provider.api_key_value}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(request), request };
            }
            const form = new FormData(); form.append('model', model); form.append('prompt', prompt); form.append('size', imageSize); sourceImages.forEach((source, index) => form.append('image', new Blob([source.sourceBuffer], { type: source.sourceType }), `source-${index + 1}.${source.sourceType.split('/')[1] || 'jpg'}`));
            const request = { model, prompt, size: imageSize, image: sourceImages.map((source) => ({ sourceUrl: source.sourceUrl, contentType: source.sourceType })) };
            return { endpoint, headers: { Authorization: `Bearer ${provider.api_key_value}`, Accept: 'application/json' }, body: form, request };
          },
          onAttempt: async ({ attempt, totalAttempts, endpoint, request }) => { rawData.requests.push({ attempt, totalAttempts, endpoint, method: 'POST', request, requestedAt: new Date().toISOString() }); await this.updateAiGenerationRecord(connection, recordId, { rawData }); },
          onFailure: async ({ attempt, error }) => { const snapshot = rawData.requests[attempt - 1]; if (snapshot) snapshot.error = String(error?.message || '模型调用失败').slice(0, 1000); await this.updateAiGenerationRecord(connection, recordId, { rawData }); },
        });
        const payload = requestResult.payload;
        const generated = Array.isArray(payload?.data) ? payload.data : [];
        if (!generated.length) throw new Error('模型未返回图片数据，请检查模型是否支持图片编辑。');
        await notifyProgress(70, `模型已返回 ${generated.length} 张图片，正在上传到 OSS。`);
        const imageUrls = [];
        for (let index = 0; index < generated.length; index += 1) {
          const item = generated[index] || {}; let buffer; let contentType = 'image/png';
          if (item.b64_json) buffer = Buffer.from(String(item.b64_json), 'base64');
          else if (item.url && /^https?:\/\//i.test(item.url)) {
            const imageResponse = await fetch(item.url, { signal: controller.signal });
            if (!imageResponse.ok) throw new Error(`下载模型生成图片失败（HTTP ${imageResponse.status}）。`);
            contentType = String(imageResponse.headers.get('content-type') || contentType).split(';')[0].toLowerCase();
            buffer = Buffer.from(await imageResponse.arrayBuffer());
          }
          if (!buffer?.length) throw new Error('模型返回的图片为空。');
          const uploaded = await oss.uploadGeneratedLibraryImage({ userId: id, buffer, contentType, index });
          if (!uploaded.ok) throw new Error(uploaded.message);
          imageUrls.push(uploaded.publicUrl);
          await this.registerImageLibraryEntry(connection, id, uploaded.publicUrl, { type: 'ai_edited_image', generationRecordId: recordId, sourceImageUrl: sourceUrl });
          await notifyProgress(70 + Math.round(((index + 1) / generated.length) * 25), `已上传 ${index + 1}/${generated.length} 张图片到 OSS。`);
        }
        await notifyProgress(97, '正在写入图库和生成记录。');
        await this.updateAiGenerationRecord(connection, recordId, { status: 'succeeded', successCount: imageUrls.length, outputSummary: { generatedImageUrls: imageUrls, sourceImageUrl: sourceUrl, sourceImageUrls: sourceUrls, actualModel: requestResult.model, failoverAttempt: requestResult.attempt }, rawData, finished: true });
        await notifyProgress(100, `AI 改图完成，已保存 ${imageUrls.length} 张图片。`, 'succeeded', true);
        return { ok: true, generationRecordId: recordId, imageUrls, message: `AI 改图完成，已保存 ${imageUrls.length} 张图片。` };
      } finally { clearTimeout(timeout); }
    } catch (error) {
      const message = error?.code === 'MODEL_TIMEOUT' || error.name === 'AbortError' ? '图片生成超时，请检查模型服务和网络。' : (error.message || 'AI 改图失败。');
      if (connection && recordId) { try { await this.updateAiGenerationRecord(connection, recordId, { status: 'failed', failedCount: 1, errorMessage: message, rawData, finished: true }); } catch (_) { /* 保留原始异常 */ } }
      if (connection && taskId && taskUserId) { try { await notifyProgress(currentProgress, message, 'failed', true); } catch (_) { /* 生成失败信息仍需返回 */ } }
      return { ok: false, code: error?.code === 'MODEL_TIMEOUT' || error.name === 'AbortError' ? 'MODEL_IMAGE_TIMEOUT' : (error.code || 'MODEL_IMAGE_ERROR'), message };
    } finally { if (connection) await connection.end(); }
  }

  async ensureProductIssuesTable(connection) {
    await connection.query(`CREATE TABLE IF NOT EXISTS product_issues (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, user_id BIGINT UNSIGNED NOT NULL, product_id BIGINT UNSIGNED NOT NULL,
      issue_type VARCHAR(64) NOT NULL, issue_title VARCHAR(255) NOT NULL, issue_code VARCHAR(128) NULL,
      issue_message VARCHAR(2000) NOT NULL, issue_detail JSON NULL, occurred_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id), UNIQUE KEY uk_product_issues_active (user_id, product_id, issue_type),
      KEY idx_product_issues_user_product (user_id, product_id), KEY idx_product_issues_occurred_at (occurred_at),
      CONSTRAINT fk_product_issues_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
      CONSTRAINT fk_product_issues_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE
    ) ENGINE=InnoDB COMMENT='商品自动化执行中的当前待处理问题'`);
    // 旧版本只记录回写历史；首次升级时将每件商品最近一次失败补进问题表，避免现有错误丢失。
    await connection.query(`INSERT INTO product_issues (user_id, product_id, issue_type, issue_title, issue_code, issue_message, issue_detail, occurred_at)
      SELECT r.user_id, r.product_id, 'miaoshou_write_back', '回写妙手失败', 'MIAOSHOU_WRITE_BACK_FAILED', r.error_message,
        JSON_OBJECT('writeRecordId', r.id, 'writeBackStatus', r.write_back_status), r.requested_at
      FROM miaoshou_write_records r
      INNER JOIN (
        SELECT user_id, product_id, MAX(id) AS latest_id FROM miaoshou_write_records
        WHERE product_id IS NOT NULL GROUP BY user_id, product_id
      ) latest ON latest.latest_id = r.id
      WHERE r.product_id IS NOT NULL AND COALESCE(r.operation_type, 'write_back') = 'write_back' AND r.record_status = 'failed' AND r.error_message IS NOT NULL AND r.error_message <> ''
      ON DUPLICATE KEY UPDATE issue_title = VALUES(issue_title), issue_code = VALUES(issue_code), issue_message = VALUES(issue_message),
        issue_detail = VALUES(issue_detail), occurred_at = VALUES(occurred_at), updated_at = NOW()`);
  }

  async ensureProductRemarkTagsTable(connection) {
    await connection.query(`CREATE TABLE IF NOT EXISTS product_remark_tags (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      product_id BIGINT UNSIGNED NOT NULL,
      tag_name VARCHAR(80) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_product_remark_tag (product_id, tag_name),
      KEY idx_product_remark_tags_product (product_id),
      CONSTRAINT fk_product_remark_tags_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE
    ) ENGINE=InnoDB COMMENT='商品列表备注标签'`);
  }

  async ensureTodoTasksTable(connection) {
    await connection.query(`CREATE TABLE IF NOT EXISTS todo_tasks (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      source VARCHAR(20) NOT NULL DEFAULT 'manual',
      product_id BIGINT UNSIGNED NULL,
      remark_tag_id BIGINT UNSIGNED NULL,
      title VARCHAR(160) NOT NULL,
      note TEXT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      completed_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_todo_tasks_remark_tag (remark_tag_id),
      KEY idx_todo_tasks_user_status (user_id, status, created_at),
      KEY idx_todo_tasks_product (product_id)
    ) ENGINE=InnoDB COMMENT='首页待办任务'`);
  }

  async syncProductTagTodos(connection, userId) {
    await connection.execute(`INSERT IGNORE INTO todo_tasks (user_id, source, product_id, remark_tag_id, title, status, created_at)
      SELECT product.created_by, 'product_tag', product.id, tag.id, tag.tag_name, 'pending', tag.created_at
      FROM product_remark_tags tag INNER JOIN products product ON product.id = tag.product_id
      WHERE product.created_by = ? AND product.deleted_at IS NULL`, [Number(userId)]);
  }

  async addProductRemarkTag(userId, productId, tagName) {
    let connection;
    try {
      const ownerUserId = Number(userId);
      const id = Number(productId);
      const name = String(tagName || '').trim();
      if (!Number.isInteger(ownerUserId) || ownerUserId < 1) return { ok: false, message: '请先登录本机用户。' };
      if (!Number.isInteger(id) || id < 1) return { ok: false, message: '商品编号无效。' };
      if (!name) return { ok: false, message: '请输入备注标签。' };
      if (name.length > 80) return { ok: false, message: '备注标签不能超过 80 个字符。' };
      connection = await this.openConnection(await this.getConfig());
      await this.ensureProductRemarkTagsTable(connection);
      await this.ensureTodoTasksTable(connection);
      const [products] = await connection.execute('SELECT id FROM products WHERE id = ? AND created_by = ? AND deleted_at IS NULL LIMIT 1', [id, ownerUserId]);
      if (!products.length) return { ok: false, message: '商品不存在或无权编辑。' };
      await connection.execute('INSERT IGNORE INTO product_remark_tags (product_id, tag_name) VALUES (?, ?)', [id, name]);
      const [tags] = await connection.execute('SELECT id, product_id, tag_name, created_at FROM product_remark_tags WHERE product_id = ? ORDER BY id', [id]);
      const tag = tags.find((item) => item.tag_name === name);
      if (tag) await connection.execute(`INSERT IGNORE INTO todo_tasks (user_id, source, product_id, remark_tag_id, title, status)
        VALUES (?, 'product_tag', ?, ?, ?, 'pending')`, [ownerUserId, id, tag.id, name]);
      return { ok: true, tags, message: '备注标签已保存。' };
    } catch (error) {
      return { ok: false, code: error.code || 'PRODUCT_REMARK_TAG_ERROR', message: error.message || '保存备注标签失败。' };
    } finally { if (connection) await connection.end(); }
  }

  async deleteProductRemarkTag(userId, tagId) {
    let connection;
    try {
      const ownerUserId = Number(userId);
      const id = Number(tagId);
      if (!Number.isInteger(ownerUserId) || ownerUserId < 1) return { ok: false, message: '请先登录本机用户。' };
      if (!Number.isInteger(id) || id < 1) return { ok: false, message: '备注标签编号无效。' };
      connection = await this.openConnection(await this.getConfig());
      await this.ensureProductRemarkTagsTable(connection);
      await this.ensureTodoTasksTable(connection);
      await connection.execute(`UPDATE todo_tasks SET status = 'cancelled' WHERE user_id = ? AND remark_tag_id = ? AND status = 'pending'`, [ownerUserId, id]);
      const [result] = await connection.execute(`DELETE tag FROM product_remark_tags tag
        INNER JOIN products product ON product.id = tag.product_id
        WHERE tag.id = ? AND product.created_by = ? AND product.deleted_at IS NULL`, [id, ownerUserId]);
      if (!result.affectedRows) return { ok: false, message: '备注标签不存在或无权删除。' };
      return { ok: true, message: '备注标签已删除。' };
    } catch (error) {
      return { ok: false, code: error.code || 'PRODUCT_REMARK_TAG_ERROR', message: error.message || '删除备注标签失败。' };
    } finally { if (connection) await connection.end(); }
  }

  async createTodoTask(userId, title, note = '') {
    let connection;
    try {
      const ownerUserId = Number(userId);
      const taskTitle = String(title || '').trim();
      const taskNote = String(note || '').trim();
      if (!Number.isInteger(ownerUserId) || ownerUserId < 1) return { ok: false, message: '请先登录本机用户。' };
      if (!taskTitle) return { ok: false, message: '请输入待办任务。' };
      if (taskTitle.length > 160) return { ok: false, message: '待办任务不能超过 160 个字符。' };
      if (taskNote.length > 1000) return { ok: false, message: '待办备注不能超过 1000 个字符。' };
      connection = await this.openConnection(await this.getConfig());
      await this.ensureTodoTasksTable(connection);
      const [result] = await connection.execute(`INSERT INTO todo_tasks (user_id, source, title, note, status)
        VALUES (?, 'manual', ?, ?, 'pending')`, [ownerUserId, taskTitle, taskNote || null]);
      return { ok: true, id: Number(result.insertId), message: '待办任务已创建。' };
    } catch (error) {
      return { ok: false, code: error.code || 'TODO_TASK_CREATE_ERROR', message: error.message || '创建待办任务失败。' };
    } finally { if (connection) await connection.end(); }
  }

  async completeTodoTask(userId, todoId) {
    let connection;
    try {
      const ownerUserId = Number(userId);
      const id = Number(todoId);
      if (!Number.isInteger(ownerUserId) || ownerUserId < 1) return { ok: false, message: '请先登录本机用户。' };
      if (!Number.isInteger(id) || id < 1) return { ok: false, message: '待办任务编号无效。' };
      connection = await this.openConnection(await this.getConfig());
      await this.ensureTodoTasksTable(connection);
      const [tasks] = await connection.execute(`SELECT id, source, remark_tag_id FROM todo_tasks
        WHERE id = ? AND user_id = ? AND status = 'pending' LIMIT 1`, [id, ownerUserId]);
      const task = tasks[0];
      if (!task) return { ok: false, message: '待办任务不存在或已完成。' };
      await connection.beginTransaction();
      if (task.source === 'product_tag' && task.remark_tag_id) {
        await connection.execute(`DELETE tag FROM product_remark_tags tag INNER JOIN products product ON product.id = tag.product_id
          WHERE tag.id = ? AND product.created_by = ?`, [task.remark_tag_id, ownerUserId]);
      }
      await connection.execute(`UPDATE todo_tasks SET status = 'completed', completed_at = NOW() WHERE id = ?`, [id]);
      await connection.commit();
      return { ok: true, message: '待办已完成。' };
    } catch (error) {
      if (connection) await connection.rollback().catch(() => {});
      return { ok: false, code: error.code || 'TODO_TASK_COMPLETE_ERROR', message: error.message || '完成待办任务失败。' };
    } finally { if (connection) await connection.end(); }
  }

  async getHomeDashboard(userId, todoStatus = 'pending', todoPage = 1, todoPageSize = 10) {
    let connection;
    try {
      const ownerUserId = Number(userId);
      if (!Number.isInteger(ownerUserId) || ownerUserId < 1) return { ok: false, message: '请先登录本机用户。' };
      const config = await this.getConfig();
      connection = await this.openConnection(config);
      await this.ensureProductRemarkTagsTable(connection);
      await this.ensureTodoTasksTable(connection);
      await this.syncProductTagTodos(connection, ownerUserId);
      await this.ensureScheduledJobTables(connection);
      await this.ensureWmsStockImportRecordsTable(connection);
      await this.ensureMiaoshouAuthorizedShopsTables(connection);
      const [[stats]] = await connection.execute(`SELECT COUNT(*) AS total, SUM(product_status = 'pending_process') AS pendingProcess,
        SUM(product_status = 'image_processing') AS imageProcessing, SUM(product_status = 'ready_to_write') AS readyToWrite,
        SUM(product_status = 'failed') AS failed FROM products WHERE created_by = ? AND deleted_at IS NULL`, [ownerUserId]);
      const [tasks] = await connection.execute(`SELECT id, job_type, title, status, progress_percent, progress_message, last_error, created_at
        FROM scheduled_jobs WHERE (user_id = ? OR user_id IS NULL) AND status IN ('queued', 'active', 'running', 'failed')
        ORDER BY FIELD(status, 'running', 'failed', 'queued', 'active'), updated_at DESC, id DESC LIMIT 5`, [ownerUserId]);
      const activeTodoStatus = todoStatus === 'completed' ? 'completed' : 'pending';
      const [todoCountRows] = await connection.execute(`SELECT status, COUNT(*) AS total FROM todo_tasks
        WHERE user_id = ? AND status IN ('pending', 'completed') GROUP BY status`, [ownerUserId]);
      const todoCounts = Object.fromEntries(todoCountRows.map((row) => [row.status, Number(row.total || 0)]));
      const todoTotal = Number(todoCounts[activeTodoStatus] || 0);
      const normalizedTodoPageSize = Math.max(1, Math.min(50, Number(todoPageSize) || 10));
      const todoTotalPages = Math.max(1, Math.ceil(todoTotal / normalizedTodoPageSize));
      const normalizedTodoPage = Math.max(1, Math.min(todoTotalPages, Number(todoPage) || 1));
      const todoOffset = (normalizedTodoPage - 1) * normalizedTodoPageSize;
      const [todos] = await connection.execute(`SELECT task.id AS todo_id, task.source, task.title AS todo_title, task.note, task.status,
        task.completed_at, task.created_at, task.product_id, product.title, product.generated_title, product.source_product_id, product.raw_data
        FROM todo_tasks task LEFT JOIN products product ON product.id = task.product_id
        WHERE task.user_id = ? AND task.status = ? ORDER BY COALESCE(task.completed_at, task.created_at) DESC, task.id DESC LIMIT ? OFFSET ?`, [ownerUserId, activeTodoStatus, normalizedTodoPageSize, todoOffset]);
      const [todoGroups] = activeTodoStatus === 'pending' ? await connection.execute(`SELECT CASE WHEN source = 'product_tag' THEN title ELSE '手动待办' END AS tag_name, COUNT(*) AS total
        FROM todo_tasks WHERE user_id = ? AND status = 'pending' GROUP BY CASE WHEN source = 'product_tag' THEN title ELSE '手动待办' END
        ORDER BY total DESC, tag_name LIMIT 6`, [ownerUserId]) : [[]];
      const [wmsRecords] = await connection.execute(`SELECT id, product_id, product_title, old_sku_id, import_status, error_message, created_at
        FROM wms_stock_import_records WHERE user_id = ? ORDER BY id DESC LIMIT 5`, [ownerUserId]);
      const profiles = (config.miaoshouProfiles || []).filter((profile) => String(profile.appId || '').trim());
      const appIds = profiles.map((profile) => String(profile.appId).trim());
      const shopRows = appIds.length ? (await connection.execute(`SELECT miaoshou_app_id, platform_code, site_code, shop_id, shop_name, shop_mode,
        authorization_status, is_enabled, last_synced_at FROM miaoshou_authorized_shops WHERE user_id = ? AND miaoshou_app_id IN (${appIds.map(() => '?').join(', ')})
        ORDER BY miaoshou_app_id, platform_code, shop_name, shop_id`, [ownerUserId, ...appIds]))[0] : [];
      const shopProfiles = profiles.map((profile) => {
        const shops = shopRows.filter((shop) => shop.miaoshou_app_id === profile.appId);
        return { profileId: profile.id, profileName: profile.name, appId: profile.appId, isActive: profile.id === config.activeMiaoshouProfileId, shops, lastSyncedAt: shops.reduce((latest, shop) => !latest || new Date(shop.last_synced_at) > new Date(latest) ? shop.last_synced_at : latest, null) };
      });
      const normalizedTodos = todos.map((todo) => {
        const raw = this.parseJsonColumn(todo.raw_data, {});
        return {
          ...todo,
          main_item_number: String(raw?._miaoshouDetail?.itemNum || raw?._imageProductBuilder?.itemNumber || todo.source_product_id || todo.title || ''),
        };
      });
      return {
        ok: true,
        stats: Object.fromEntries(Object.entries(stats).map(([key, value]) => [key, Number(value || 0)])),
        tasks,
        todos: normalizedTodos,
        todoGroups: todoGroups.map((group) => ({ tagName: group.tag_name, total: Number(group.total || 0) })),
        todoCounts: { pending: Number(todoCounts.pending || 0), completed: Number(todoCounts.completed || 0) },
        todoPagination: { page: normalizedTodoPage, pageSize: normalizedTodoPageSize, total: todoTotal, totalPages: todoTotalPages },
        wmsRecords,
        shopProfiles,
        system: { wmsReady: Boolean(config.wms?.token), miaoshouReady: Boolean(config.miaoshou?.appId && config.miaoshou?.appSecret), ossReady: Boolean(config.oss?.endpoint && config.oss?.bucket) },
      };
    } catch (error) {
      return { ok: false, code: error.code || 'HOME_DASHBOARD_ERROR', message: error.message || '读取首页概览失败。' };
    } finally { if (connection) await connection.end(); }
  }

  async saveProductIssue(connection, { userId, productId, issueType, title, message, code = null, detail = {} }) {
    const id = Number(productId);
    if (!Number.isInteger(id) || id < 1 || !String(message || '').trim()) return;
    await connection.execute(`INSERT INTO product_issues (user_id, product_id, issue_type, issue_title, issue_code, issue_message, issue_detail, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON), NOW())
      ON DUPLICATE KEY UPDATE issue_title = VALUES(issue_title), issue_code = VALUES(issue_code), issue_message = VALUES(issue_message),
        issue_detail = VALUES(issue_detail), occurred_at = NOW(), updated_at = NOW()`, [
      Number(userId), id, String(issueType || 'automation'), String(title || '自动化执行失败'), code ? String(code) : null,
      String(message).slice(0, 2000), JSON.stringify(detail || {}),
    ]);
  }

  async clearProductIssue(connection, userId, productId, issueType) {
    const id = Number(productId);
    if (!Number.isInteger(id) || id < 1) return;
    await connection.execute('DELETE FROM product_issues WHERE user_id = ? AND product_id = ? AND issue_type = ?', [Number(userId), id, String(issueType || 'automation')]);
  }

  async saveMiaoshouWriteRecord(connection, { userId, product, target, operationType = 'write_back', writeStatus, recordStatus, errorMessage = null, requestSummary, responseSummary }) {
    await connection.execute(`INSERT INTO miaoshou_write_records (user_id, product_id, product_title, source_product_id, platform_code, site_code,
      shop_id, shop_name, operation_type, write_back_status, record_status, error_message, request_summary, response_summary, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), NOW())`, [
      Number(userId), product.id || null, String(product.title || '未命名商品'), String(product.source_product_id || ''),
      target.platform_code || null, target.site_code || null, target.shop_id || null, target.shopName || null,
      operationType, writeStatus, recordStatus, errorMessage, JSON.stringify(requestSummary || {}), JSON.stringify(responseSummary || {}),
    ]);
  }

  async getMiaoshouWriteRecords(userId, page = 1, pageSize = 20, filters = {}) {
    let connection;
    try {
      const config = await this.getConfig();
      const requestedPage = Math.max(1, Number(page) || 1);
      const safePageSize = Math.min(100, Math.max(10, Number(pageSize) || 20));
      const status = ['succeeded', 'failed'].includes(String(filters.status || '')) ? String(filters.status) : '';
      const operationType = ['write_back', 'publish'].includes(String(filters.operationType || '')) ? String(filters.operationType) : '';
      const keyword = String(filters.keyword || '').trim();
      connection = await this.openConnection(config);
      await this.ensureMiaoshouWriteRecordsTable(connection);
      const where = ['r.user_id = ?'];
      const params = [Number(userId)];
      if (status) { where.push('r.record_status = ?'); params.push(status); }
      if (operationType) { where.push("COALESCE(r.operation_type, 'write_back') = ?"); params.push(operationType); }
      if (keyword) { where.push('(r.product_title LIKE ? OR r.source_product_id LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
      const whereSql = where.join(' AND ');
      const [[count]] = await connection.execute(`SELECT COUNT(*) AS total FROM miaoshou_write_records r WHERE ${whereSql}`, params);
      const total = Number(count.total || 0);
      const totalPages = Math.max(1, Math.ceil(total / safePageSize));
      const safePage = Math.min(requestedPage, totalPages);
      const offset = (safePage - 1) * safePageSize;
      const [records] = await connection.execute(`SELECT r.id, r.product_id, r.product_title, r.source_product_id, r.platform_code, r.site_code,
        r.shop_name, COALESCE(r.operation_type, 'write_back') AS operation_type, r.write_back_status, r.record_status, r.error_message, r.request_summary, r.response_summary, r.requested_at, r.finished_at,
        (SELECT a.object_key FROM product_images pi JOIN assets a ON a.id = pi.asset_id WHERE pi.product_id = r.product_id
          AND pi.image_group = 'source' AND a.asset_kind = 'source_image' AND a.deleted_at IS NULL ORDER BY pi.sort_order, pi.id LIMIT 1) AS image_object_key,
        (SELECT a.original_url FROM product_images pi JOIN assets a ON a.id = pi.asset_id WHERE pi.product_id = r.product_id
          AND pi.image_group = 'source' AND a.asset_kind = 'source_image' AND a.deleted_at IS NULL ORDER BY pi.sort_order, pi.id LIMIT 1) AS source_image_url
        FROM miaoshou_write_records r WHERE ${whereSql} ORDER BY r.requested_at DESC, r.id DESC LIMIT ? OFFSET ?`, [...params, safePageSize, offset]);
      const [[stats]] = await connection.execute(`SELECT COUNT(*) AS total, SUM(DATE(requested_at) = CURDATE()) AS todayTotal,
        SUM(DATE(requested_at) = CURDATE() AND record_status = 'succeeded') AS todaySucceeded,
        SUM(DATE(requested_at) = CURDATE() AND record_status = 'failed') AS todayFailed
        FROM miaoshou_write_records WHERE user_id = ?`, [Number(userId)]);
      const oss = new OssClient(config.oss);
      return { ok: true, stats: Object.fromEntries(Object.entries(stats).map(([key, value]) => [key, Number(value || 0)])),
        records: records.map((record) => ({ ...record, image_url: record.image_object_key ? oss.publicUrl(record.image_object_key) : record.source_image_url })),
        pagination: { page: safePage, pageSize: safePageSize, total, totalPages } };
    } catch (error) {
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message, stats: null, records: [], pagination: null };
    } finally { if (connection) await connection.end(); }
  }

  async getMiaoshouFolderImportRecords(userId, page = 1, pageSize = 20, filters = {}) {
    let connection;
    try {
      const config = await this.getConfig();
      const requestedPage = Math.max(1, Number(page) || 1);
      const safePageSize = Math.min(100, Math.max(10, Number(pageSize) || 20));
      const status = ['running', 'succeeded', 'failed'].includes(String(filters.status || '')) ? String(filters.status) : '';
      const keyword = String(filters.keyword || '').trim();
      connection = await this.openConnection(config);
      await this.ensureMiaoshouFolderImportRecordsTable(connection);
      await this.ensureMiaoshouAuthorizedShopsTables(connection);
      const where = ['r.user_id = ?'];
      const params = [Number(userId)];
      if (status) { where.push('r.import_status = ?'); params.push(status); }
      if (keyword) { where.push('p.title LIKE ?'); params.push(`%${keyword}%`); }
      const whereSql = where.join(' AND ');
      const [[count]] = await connection.execute(`SELECT COUNT(*) AS total FROM miaoshou_folder_import_records r
        JOIN products p ON p.id = r.product_id WHERE ${whereSql}`, params);
      const total = Number(count.total || 0);
      const totalPages = Math.max(1, Math.ceil(total / safePageSize));
      const safePage = Math.min(requestedPage, totalPages);
      const offset = (safePage - 1) * safePageSize;
      const [records] = await connection.execute(`SELECT r.id, r.product_id, r.platform_code, r.site_code, r.shop_id, r.common_collect_box_detail_id,
        r.platform_collect_box_detail_id, r.import_status, r.current_stage, r.error_message, r.started_at, r.finished_at, r.updated_at,
        p.title AS product_title, p.raw_data AS product_raw_data,
        (SELECT s.shop_name FROM miaoshou_authorized_shops s WHERE s.user_id = r.user_id AND s.miaoshou_app_id = r.miaoshou_app_id
          AND s.platform_code = r.platform_code AND s.shop_id = r.shop_id LIMIT 1) AS shop_name,
        (SELECT a.object_key FROM product_images pi JOIN assets a ON a.id = pi.asset_id WHERE pi.product_id = r.product_id
          AND pi.image_group = 'source' AND a.asset_kind = 'source_image' AND a.deleted_at IS NULL ORDER BY pi.sort_order, pi.id LIMIT 1) AS image_object_key,
        (SELECT a.original_url FROM product_images pi JOIN assets a ON a.id = pi.asset_id WHERE pi.product_id = r.product_id
          AND pi.image_group = 'source' AND a.asset_kind = 'source_image' AND a.deleted_at IS NULL ORDER BY pi.sort_order, pi.id LIMIT 1) AS source_image_url
        FROM miaoshou_folder_import_records r JOIN products p ON p.id = r.product_id WHERE ${whereSql}
        ORDER BY r.updated_at DESC, r.id DESC LIMIT ? OFFSET ?`, [...params, safePageSize, offset]);
      const [[stats]] = await connection.execute(`SELECT COUNT(*) AS total, SUM(DATE(updated_at) = CURDATE()) AS todayTotal,
        SUM(DATE(updated_at) = CURDATE() AND import_status = 'succeeded') AS todaySucceeded,
        SUM(DATE(updated_at) = CURDATE() AND import_status = 'failed') AS todayFailed
        FROM miaoshou_folder_import_records WHERE user_id = ?`, [Number(userId)]);
      const oss = new OssClient(config.oss);
      return { ok: true, stats: Object.fromEntries(Object.entries(stats).map(([key, value]) => [key, Number(value || 0)])),
        records: records.map((record) => {
          const rawData = this.parseJsonColumn(record.product_raw_data, {});
          return {
            ...record,
            builder_source: rawData?._imageProductBuilder ? 'image_product_builder' : 'folder_builder',
            image_url: record.image_object_key ? oss.publicUrl(record.image_object_key) : record.source_image_url,
          };
        }),
        pagination: { page: safePage, pageSize: safePageSize, total, totalPages } };
    } catch (error) {
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message, stats: null, records: [], pagination: null };
    } finally { if (connection) await connection.end(); }
  }

  async syncMiaoshouCommonCollectBox(userId, filters = {}) {
    let connection;
    try {
      const id = Number(userId);
      if (!Number.isInteger(id) || id < 1) throw new Error('请先登录本机用户。');
      const config = await this.getConfig();
      const appId = String(config.miaoshou.appId || '').trim();
      if (!appId) throw new Error('请先在系统设置中配置妙手 App ID。');
      connection = await this.openConnection(config);
      await this.ensureMiaoshouCommonCollectBoxItemsTable(connection);
      const client = new MiaoshouClient(config.miaoshou);
      const syncToken = crypto.randomUUID();
      const remoteFilter = {
        tabPaneName: ['all', 'noClaimed', 'claimed', 'collectFail', 'collectSuccess'].includes(String(filters.status || '')) ? String(filters.status) : '',
        sourceItemIdKeyword: String(filters.sourceItemIdKeyword || '').trim(),
      };
      let pageNo = 1;
      let total = 0;
      let synced = 0;
      do {
        const data = await client.getCommonCollectBoxList(pageNo, 500, remoteFilter);
        const items = Array.isArray(data?.detailList) ? data.detailList : [];
        total = Number(data?.total || 0);
        for (const item of items) {
          const detailId = Number(item?.commonCollectBoxDetailId);
          if (!Number.isInteger(detailId) || detailId < 1) continue;
          const numberOrNull = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
          await connection.execute(`INSERT INTO miaoshou_common_collect_box_items
            (user_id, miaoshou_app_id, common_collect_box_detail_id, app_account_id, sub_app_account_id, item_num, title, thumbnail, list_thumbnail,
             price, min_sku_price, max_sku_price, stock, weight, min_sku_weight, max_sku_weight, remark, remote_status, failure_reason,
             remote_created_at, remote_updated_at, group_id, group_name, source_list, owner_sub_account_alias_name, is_mark, raw_data,
             is_active, last_sync_token, last_synced_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, CAST(? AS JSON), 1, ?, NOW())
            ON DUPLICATE KEY UPDATE app_account_id = VALUES(app_account_id), sub_app_account_id = VALUES(sub_app_account_id), item_num = VALUES(item_num),
              title = VALUES(title), thumbnail = VALUES(thumbnail), list_thumbnail = VALUES(list_thumbnail), price = VALUES(price), min_sku_price = VALUES(min_sku_price),
              max_sku_price = VALUES(max_sku_price), stock = VALUES(stock), weight = VALUES(weight), min_sku_weight = VALUES(min_sku_weight),
              max_sku_weight = VALUES(max_sku_weight), remark = VALUES(remark), remote_status = VALUES(remote_status), failure_reason = VALUES(failure_reason),
              remote_created_at = VALUES(remote_created_at), remote_updated_at = VALUES(remote_updated_at), group_id = VALUES(group_id), group_name = VALUES(group_name),
              source_list = VALUES(source_list), owner_sub_account_alias_name = VALUES(owner_sub_account_alias_name), is_mark = VALUES(is_mark), raw_data = VALUES(raw_data),
              is_active = 1, last_sync_token = VALUES(last_sync_token), last_synced_at = NOW()`, [
            id, appId, detailId, numberOrNull(item.appAccountId), numberOrNull(item.subAppAccountId), item.itemNum || null, item.title || null,
            item.thumbnail || null, item.listThumbnail || null, numberOrNull(item.price), numberOrNull(item.minSkuPrice), numberOrNull(item.maxSkuPrice),
            numberOrNull(item.stock), numberOrNull(item.weight), numberOrNull(item.minSkuWeight), numberOrNull(item.maxSkuWeight), item.remark || null,
            item.status || null, item.reason || null, item.gmtCreate || null, item.gmtModified || null, numberOrNull(item.commonCollectBoxGroupId),
            item.commonCollectBoxGroupName || null, JSON.stringify(Array.isArray(item.sourceList) ? item.sourceList : []), item.ownerSubAccountAliasName || null,
            item.isMark || null, JSON.stringify(item), syncToken,
          ]);
          synced += 1;
        }
        if (!items.length || synced >= total) break;
        pageNo += 1;
      } while (true);
      await connection.execute(`UPDATE miaoshou_common_collect_box_items SET is_active = 0
        WHERE user_id = ? AND miaoshou_app_id = ? AND COALESCE(last_sync_token, '') <> ?`, [id, appId, syncToken]);
      return { ok: true, synced, total, message: `已同步 ${synced} 条公共采集箱商品。` };
    } catch (error) {
      return { ok: false, code: error.code || 'MIAOSHOU_COMMON_COLLECT_BOX_SYNC_ERROR', message: error.message };
    } finally { if (connection) await connection.end(); }
  }

  async getMiaoshouCommonCollectBoxItems(userId, page = 1, pageSize = 20, filters = {}) {
    let connection;
    try {
      const id = Number(userId);
      if (!Number.isInteger(id) || id < 1) throw new Error('请先登录本机用户。');
      const config = await this.getConfig();
      const appId = String(config.miaoshou.appId || '').trim();
      const requestedPage = Math.max(1, Number(page) || 1);
      const safePageSize = Math.min(100, Math.max(10, Number(pageSize) || 20));
      const status = String(filters.status || '').trim();
      const keyword = String(filters.keyword || '').trim();
      connection = await this.openConnection(config);
      await this.ensureMiaoshouCommonCollectBoxItemsTable(connection);
      const where = ['user_id = ?', 'miaoshou_app_id = ?', 'is_active = 1'];
      const params = [id, appId];
      if (status) { where.push('remote_status LIKE ?'); params.push(`%${status}%`); }
      if (keyword) { where.push('(title LIKE ? OR item_num LIKE ? OR JSON_SEARCH(source_list, \'one\', ?) IS NOT NULL)'); params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`); }
      const whereSql = where.join(' AND ');
      const [[count]] = await connection.execute(`SELECT COUNT(*) AS total FROM miaoshou_common_collect_box_items WHERE ${whereSql}`, params);
      const total = Number(count.total || 0);
      const totalPages = Math.max(1, Math.ceil(total / safePageSize));
      const safePage = Math.min(requestedPage, totalPages);
      const offset = (safePage - 1) * safePageSize;
      const [items] = await connection.execute(`SELECT common_collect_box_detail_id, item_num, title, thumbnail, list_thumbnail, price, min_sku_price, max_sku_price,
        stock, weight, min_sku_weight, max_sku_weight, remark, remote_status, failure_reason, remote_created_at, remote_updated_at,
        group_name, source_list, owner_sub_account_alias_name, is_mark, last_synced_at
        FROM miaoshou_common_collect_box_items WHERE ${whereSql}
        ORDER BY COALESCE(remote_updated_at, remote_created_at) DESC, id DESC LIMIT ? OFFSET ?`, [...params, safePageSize, offset]);
      const [[summary]] = await connection.execute(`SELECT COUNT(*) AS total, MAX(last_synced_at) AS lastSyncedAt
        FROM miaoshou_common_collect_box_items WHERE user_id = ? AND miaoshou_app_id = ? AND is_active = 1`, [id, appId]);
      return { ok: true, items, summary: { total: Number(summary.total || 0), lastSyncedAt: summary.lastSyncedAt || null },
        pagination: { page: safePage, pageSize: safePageSize, total, totalPages } };
    } catch (error) {
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message, items: [], summary: null, pagination: null };
    } finally { if (connection) await connection.end(); }
  }

  async getAiGenerationRecords(userId, page = 1, pageSize = 20, filters = {}) {
    let connection;
    try {
      const config = await this.getConfig();
      const requestedPage = Math.max(1, Number(page) || 1);
      const safePageSize = Math.min(100, Math.max(10, Number(pageSize) || 20));
      const status = ['running', 'succeeded', 'partial_failed', 'failed'].includes(String(filters.status || '')) ? String(filters.status) : '';
      const generationType = ['title', 'product_image', 'sku_image', 'folder_sku', 'image_edit', 'original_image', 'carousel_image'].includes(String(filters.generationType || '')) ? String(filters.generationType) : '';
      const keyword = String(filters.keyword || '').trim();
      connection = await this.openConnection(config);
      await this.ensureAiGenerationRecordsTable(connection);
      await this.ensureImageProductBuilderTables(connection);
      const where = ['r.user_id = ?'];
      const params = [Number(userId)];
      if (status) { where.push('r.record_status = ?'); params.push(status); }
      if (generationType) { where.push('r.generation_type = ?'); params.push(generationType); }
      if (keyword) { where.push('r.product_title LIKE ?'); params.push(`%${keyword}%`); }
      const whereSql = where.join(' AND ');
      const [[count]] = await connection.execute(`SELECT COUNT(*) AS total FROM ai_generation_records r WHERE ${whereSql}`, params);
      const total = Number(count.total || 0);
      const totalPages = Math.max(1, Math.ceil(total / safePageSize));
      const safePage = Math.min(requestedPage, totalPages);
      const offset = (safePage - 1) * safePageSize;
      const [records] = await connection.execute(`SELECT id, product_id, product_title, generation_type, record_status, model_name, templates_snapshot,
        input_summary, output_summary, raw_data, success_count, failed_count, error_message, progress_percent, progress_message, task_started_at, task_finished_at, requested_at, finished_at
        FROM ai_generation_records r WHERE ${whereSql} ORDER BY r.requested_at DESC, r.id DESC LIMIT ? OFFSET ?`, [...params, safePageSize, offset]);
      const [imageBuilderTasks] = await connection.execute(`SELECT id, item_number, source_image_urls, original_image_urls
        FROM image_product_builder_tasks WHERE user_id = ?`, [Number(userId)]);
      const imageBuilderTasksById = new Map(imageBuilderTasks.map((task) => [Number(task.id), task]));
      const sourceImageTasks = new Map();
      const originalImageTasks = new Map();
      for (const task of imageBuilderTasks) {
        for (const url of this.parseJsonColumn(task.source_image_urls, [])) sourceImageTasks.set(String(url || ''), task);
        for (const url of this.parseJsonColumn(task.original_image_urls, [])) originalImageTasks.set(String(url || ''), task);
      }
      const displayRecords = records.map((record) => {
        const rawData = this.parseJsonColumn(record.raw_data, {});
        let task = imageBuilderTasksById.get(Number(rawData.imageProductBuilderTaskId));
        let inferredType = String(record.generation_type || '');
        if (!task && inferredType === 'image_edit') {
          const sourceUrl = String(rawData.sourceImageUrl || '');
          task = sourceImageTasks.get(sourceUrl) || originalImageTasks.get(sourceUrl);
          if (task) inferredType = sourceImageTasks.has(sourceUrl) ? 'original_image' : 'carousel_image';
        }
        if (task && ['original_image', 'carousel_image'].includes(inferredType)) return { ...record, generation_type: inferredType, product_title: task.item_number || record.product_title };
        return record;
      });
      const [[stats]] = await connection.execute(`SELECT COUNT(*) AS total, SUM(DATE(requested_at) = CURDATE()) AS todayTotal,
        SUM(DATE(requested_at) = CURDATE() AND record_status = 'succeeded') AS todaySucceeded,
        SUM(DATE(requested_at) = CURDATE() AND record_status IN ('partial_failed', 'failed')) AS todayFailed
        FROM ai_generation_records WHERE user_id = ?`, [Number(userId)]);
      return { ok: true, stats: Object.fromEntries(Object.entries(stats).map(([key, value]) => [key, Number(value || 0)])), records: displayRecords,
        pagination: { page: safePage, pageSize: safePageSize, total, totalPages } };
    } catch (error) {
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message, stats: null, records: [], pagination: null };
    } finally { if (connection) await connection.end(); }
  }

  async retryAiGenerationRecord(userId, recordId, onProgress = () => {}) {
    let connection;
    let retryPlan = null;
    try {
      const id = Number(userId); const targetRecordId = Number(recordId);
      if (!Number.isInteger(id) || id < 1 || !Number.isInteger(targetRecordId) || targetRecordId < 1) throw new Error('生成记录参数无效。');
      const config = await this.getConfig();
      connection = await this.openConnection(config);
      await this.ensureAiGenerationRecordsTable(connection);
      const [[record]] = await connection.execute(`SELECT id, product_id, generation_type, record_status FROM ai_generation_records
        WHERE id = ? AND user_id = ? LIMIT 1`, [targetRecordId, id]);
      if (!record) throw new Error('生成记录不存在或无权操作。');
      if (!['failed', 'partial_failed'].includes(String(record.record_status))) throw new Error('仅失败或部分失败的生成记录可重试。');
      if (!['product_image', 'sku_image', 'folder_sku'].includes(String(record.generation_type))) throw new Error('该类型暂不支持从记录页重试。');
      const productId = Number(record.product_id);
      if (!Number.isInteger(productId) || productId < 1) throw new Error('该生成记录没有可重试的关联商品。');
      const [[product]] = await connection.execute('SELECT id, title, raw_data FROM products WHERE id = ? AND deleted_at IS NULL LIMIT 1', [productId]);
      if (!product) throw new Error('关联商品不存在或已删除。');
      retryPlan = { type: String(record.generation_type), productId, title: String(product.title || '') };
      if (retryPlan.type === 'product_image') {
        const [images] = await connection.execute(`SELECT a.original_url FROM product_images pi JOIN assets a ON a.id = pi.asset_id
          WHERE pi.product_id = ? AND pi.image_group = 'source' AND a.deleted_at IS NULL ORDER BY pi.sort_order, pi.id LIMIT 3`, [productId]);
        retryPlan.imageUrls = images.map((item) => String(item.original_url || '').trim()).filter((url) => /^https?:\/\//i.test(url));
        if (!retryPlan.imageUrls.length) throw new Error('关联商品没有可用的原商品图片，无法重试。');
      }
      if (retryPlan.type === 'sku_image') {
        const [skus] = await connection.execute(`SELECT sort_order, draft_data, source_data FROM product_skus WHERE product_id = ? ORDER BY sort_order, id`, [productId]);
        retryPlan.skus = skus.map((sku) => {
          const draft = this.parseJsonColumn(sku.draft_data, {}); const source = this.parseJsonColumn(sku.source_data, {});
          const imageUrl = String(draft.imgUrl || source.imgUrl || '').trim();
          return { skuIndex: Number(sku.sort_order), skuKey: String(draft.skuKey || source.skuKey || ''), imageUrl };
        }).filter((sku) => Number.isInteger(sku.skuIndex) && sku.skuIndex >= 0 && /^https?:\/\//i.test(sku.imageUrl));
        if (!retryPlan.skus.length) throw new Error('关联商品没有可用的 SKU 图片，无法重试。');
      }
    } catch (error) {
      return { ok: false, code: error.code || 'AI_GENERATION_RETRY_ERROR', message: error.message || '重试生成失败。' };
    } finally { if (connection) await connection.end(); }

    if (retryPlan.type === 'product_image') return this.generateProductImages(userId, retryPlan.productId, { title: retryPlan.title, imageUrls: retryPlan.imageUrls, onProgress });
    if (retryPlan.type === 'sku_image') return this.generateProductSkuImages(userId, retryPlan.productId, { title: retryPlan.title, skus: retryPlan.skus, onProgress });
    return this.generateFolderBuilderSkus(userId, retryPlan.productId, onProgress);
  }

  async getMiaoshouWritePreview(userId, productIds) {
    let connection;
    try {
      const config = await this.getConfig();
      const appId = String(config.miaoshou.appId || '').trim();
      const ids = [...new Set((Array.isArray(productIds) ? productIds : []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
      if (!userId) throw new Error('请先登录本机用户。');
      if (!ids.length) throw new Error('请至少选择一件商品。');
      connection = await this.openConnection(config);
      await this.ensureMiaoshouAuthorizedShopsTables(connection);
      await this.ensureMiaoshouProductMappingsTable(connection);
      await this.ensureProductMiaoshouAccountScope(connection);
      const [settings] = await connection.execute('SELECT platform_code, site_code, shop_id, write_target FROM automation_publish_settings WHERE user_id = ? AND miaoshou_app_id = ? LIMIT 1', [Number(userId), appId]);
      if (!settings.length || !settings[0].shop_id) throw new Error('请先在上架与自动化设置中保存发布平台和目标店铺。');
      const setting = settings[0];
      const [shops] = await connection.execute('SELECT shop_name, shop_mode FROM miaoshou_authorized_shops WHERE user_id = ? AND miaoshou_app_id = ? AND platform_code = ? AND site_code = ? AND shop_id = ? AND is_enabled = 1 LIMIT 1', [Number(userId), appId, setting.platform_code, setting.site_code, setting.shop_id]);
      if (!shops.length) throw new Error('目标店铺已失效或不属于当前妙手 App ID，请刷新店铺后重新保存。');
      const placeholders = ids.map(() => '?').join(',');
      const [products] = await connection.execute(`SELECT p.id, p.source_miaoshou_app_id, p.source_product_id, p.source_platform_code, p.source_store_id, p.title, p.source_price, p.source_stock, p.source_weight,
        p.source_notes_text, p.product_status, COUNT(pi.id) AS source_image_count FROM products p
        LEFT JOIN product_images pi ON pi.product_id = p.id AND pi.image_group = 'source'
        WHERE p.id IN (${placeholders}) AND p.created_by = ? AND p.deleted_at IS NULL GROUP BY p.id`, [...ids, Number(userId)]);
      const targetSource = `miaoshou_${setting.platform_code}`;
      const validProducts = products.filter((product) => String(product.source_miaoshou_app_id) === appId && product.source_platform_code === targetSource && String(product.source_store_id) === String(setting.shop_id) && product.source_product_id);
      const skippedProducts = products.filter((product) => !validProducts.includes(product)).map((product) => ({ id: product.id, reason: `该商品不属于当前目标店铺的${setting.platform_code}采集箱。` }));
      if (!validProducts.length) throw new Error('所选商品不属于当前上架设置的目标店铺采集箱。');
      return { ok: true, writeMode: 'target_store', target: { ...setting, shopName: shops[0].shop_name, shopMode: shops[0].shop_mode }, products: validProducts, skippedProducts,
        message: `已生成 ${validProducts.length} 件商品的店铺采集箱回写预览。` };
    } catch (error) {
      return { ok: false, code: error.code || 'MIAOSHOU_WRITE_PREVIEW_ERROR', message: error.message, products: [], skippedProducts: [] };
    } finally { if (connection) await connection.end(); }
  }

  ensureFolderBuilderSkuColorMap(detail) {
    const source = detail && typeof detail === 'object' ? detail : {};
    const skuMap = source.skuMap && typeof source.skuMap === 'object' && !Array.isArray(source.skuMap) ? source.skuMap : {};
    const existingColorMap = source.colorMap && typeof source.colorMap === 'object' && !Array.isArray(source.colorMap) ? source.colorMap : {};
    if (!Object.keys(skuMap).length || Object.keys(existingColorMap).length) return source;
    const colorMap = {};
    for (const [skuKey, sku] of Object.entries(skuMap)) {
      if (!sku || typeof sku !== 'object') continue;
      const colorName = String(sku._folderBuilderCandidate?.color || sku.color || '').trim();
      if (!colorName) continue;
      const imageUrls = [...new Set([...(Array.isArray(sku.imgUrls) ? sku.imgUrls : []), sku.imgUrl]
        .map((url) => String(url || '').trim()).filter((url) => /^https?:\/\//i.test(url)))];
      const color = { name: colorName, color: colorName, value: colorName, skuKey };
      if (imageUrls.length) { color.imgUrl = imageUrls[0]; color.imgUrls = imageUrls; }
      colorMap[skuKey] = color;
    }
    return Object.keys(colorMap).length ? { ...source, colorPropName: String(source.colorPropName || '').trim() || '颜色', colorMap } : source;
  }

  ensureFolderBuilderSaleAttributes(detail) {
    const source = detail && typeof detail === 'object' ? detail : {};
    if (!Array.isArray(source.saleAttributes)) return source;
    const parentSpecIds = { '颜色': 1001, '尺码': 3001, '尺寸': 3001 };
    let changed = false;
    const saleAttributes = source.saleAttributes.map((attribute) => {
      const originalName = String(attribute?.name || '').trim();
      const name = originalName === '尺寸' ? '尺码' : originalName;
      const parentSpecId = Number(attribute?.parentSpecId) || parentSpecIds[originalName] || parentSpecIds[name];
      if (!parentSpecId) return attribute;
      const values = (Array.isArray(attribute?.values) ? attribute.values : []).map((value) => ({
        ...(value || {}),
        vid: value?.vid ?? 0,
        itemNum: value?.itemNum ?? null,
      }));
      if (originalName !== name || attribute?.parentSpecId !== parentSpecId || attribute?.pid === undefined || attribute?.refPid === undefined || attribute?.templatePid === undefined
        || values.some((value, index) => value?.vid !== attribute?.values?.[index]?.vid || value?.itemNum !== attribute?.values?.[index]?.itemNum)) changed = true;
      return { ...(attribute || {}), name, pid: attribute?.pid ?? null, refPid: attribute?.refPid ?? null, templatePid: attribute?.templatePid ?? null, parentSpecId, values };
    });
    return changed ? { ...source, saleAttributes } : source;
  }

  applyFolderBuilderStoreDefaults(payload, platformCode) {
    if (!payload || typeof payload !== 'object') return payload;
    if (!String(payload.editModel || '').trim()) payload.editModel = 'site';
    if (payload.isBasePlate === undefined || payload.isBasePlate === null) payload.isBasePlate = 0;
    if (!String(payload.currency || '').trim()) payload.currency = 'CNY';
    if (!String(payload.outerGoodsUrl || '').trim()) payload.outerGoodsUrl = '';
    if (String(platformCode || '').trim().toLowerCase() === 'pddkj' && !String(payload.site || '').trim()) payload.site = 'PDDKJ';
    return payload;
  }

  buildMiaoshouStoreCollectBoxEdit(product, imageUrls, platformCode = '') {
    let rawData = product.raw_data;
    if (typeof rawData === 'string') { try { rawData = JSON.parse(rawData); } catch (_) { rawData = {}; } }
    const local = ['folder_builder', 'image_product_builder'].includes(product.source_platform_code)
      ? this.ensureFolderBuilderSaleAttributes(this.ensureFolderBuilderSkuColorMap(rawData?._miaoshouDetail || {}))
      : (rawData?._miaoshouDetail || {});
    const syncedDetail = rawData?._miaoshouStoreDetail?.shopCollectItemInfo || {};
    // 回写只使用本地在最近一次同步后保存的完整快照；不在回写时读取妙手详情。
    const payload = { ...syncedDetail, ...local };
    delete payload.sourceAttrs;
    delete payload._localAttributeTemplateApplied;
    // 所有在商品编辑页可修改、且店铺采集箱保存接口可接受的字段均由本地编辑快照覆盖。
    const editable = ['itemNum', 'notesText', 'notes', 'price', 'stock', 'weight', 'packageLength', 'packageWidth', 'packageHeight',
      'imgUrls', 'goodsLayerDecorationReqs', 'productOriginCountry', 'productOriginProvince', 'outerPackageShape', 'outerPackageType',
      'outerPackageImgUrls', 'colorPropName', 'colorMap', 'sizePropName', 'sizeMap', 'saleProp3Name', 'saleProp3Map', 'mainImgVideoUrl',
      'mainImgAppVideoId', 'brandId', 'multiLanguageTitleMap', 'sizeCharts', 'vehicleLibraryRelationList', 'goodsModelReqs', 'attributes',
      'saleAttributes', 'skuMap', 'manufacturingLocationRegionShortNameList'];
    for (const field of editable) {
      const value = local[field] ?? (field === 'attributes' ? local.sourceAttrs : undefined);
      if (value !== undefined) payload[field] = value;
    }
    // 未切换类目时，以妙手同步快照中的规则为准重建属性标识，避免历史模板回填
    // 留下的重复属性或错误 templatePid 被再次提交。切换类目后 local.cid 已是新类目，
    // 属性在切换时已按新类目规则重建，不能再用旧快照覆盖。
    if (String(local.cid ?? syncedDetail.cid ?? '') === String(syncedDetail.cid ?? '')) {
      // 文件夹建品的最小公共采集箱创建不会带回属性规则；空快照不能覆盖本地属性。
      if (Array.isArray(syncedDetail.attributes) && syncedDetail.attributes.length) {
        payload.attributes = this.remapAttributesToCategoryRules(payload.attributes || payload.sourceAttrs, [], syncedDetail.attributes, false);
      }
      if (Array.isArray(syncedDetail.saleAttributes) && syncedDetail.saleAttributes.length) {
        payload.saleAttributes = this.remapAttributesToCategoryRules(payload.saleAttributes, [], syncedDetail.saleAttributes, false);
      }
    }
    // 妙手店铺采集箱要求单品 SKU（skuClassification = 1）必须有分类数量。
    // 历史采集数据会将该字段带回为 null，提交前补齐默认值 1，避免被接口拒绝。
    if (payload.skuMap && typeof payload.skuMap === 'object') {
      for (const sku of Object.values(payload.skuMap)) {
        if (!sku || typeof sku !== 'object') continue;
        if ([1, 2, 3].includes(Number(sku.skuClassification)) && (sku.pieceUnitCode === null || sku.pieceUnitCode === undefined || sku.pieceUnitCode === '')) sku.pieceUnitCode = 1;
        if (Number(sku.skuClassification) === 1 && (sku.numberOfPieces === null || sku.numberOfPieces === undefined || sku.numberOfPieces === '')) sku.numberOfPieces = 1;
      }
    }
    payload.detailId = Number(product.source_product_id);
    payload.shopId = Number(product.source_store_id);
    // 文件夹建品首次录入没有妙手店铺采集箱详情快照；补齐同平台同步商品均携带的基础上下文。
    if (['folder_builder', 'image_product_builder'].includes(product.source_platform_code)) this.applyFolderBuilderStoreDefaults(payload, platformCode);
    payload.cid = String(local.cid ?? syncedDetail.cid ?? '');
    payload.title = this.writeBackProductTitle(product, local.title || syncedDetail.title);
    // 回写图片只使用选定图片源：有 AI 图时全量替换商品原图；没有 AI 图才使用商品原图。
    payload.imgUrls = (Array.isArray(imageUrls) ? imageUrls : []).slice(0, 10);
    // 妙手保存样例中的包装枚举是数字；页面和模板中保留字符串 key 以便展示，提交前再恢复为数字。
    for (const field of ['outerPackageShape', 'outerPackageType']) {
      const value = payload[field];
      if (/^\d+$/.test(String(value ?? '').trim())) payload[field] = Number(value);
    }
    if (!payload.cid || !payload.title || !Array.isArray(payload.imgUrls) || !payload.imgUrls.length) throw new Error('店铺采集箱回写缺少 cid、标题或商品图片。请重新同步商品详情后再试。');
    return payload;
  }

  buildMiaoshouCommonCollectBoxMinimalCreate(product) {
    const rawData = this.parseJsonColumn(product.raw_data, {});
    const detail = rawData?._miaoshouDetail || {};
    const title = this.writeBackProductTitle(product, detail.title);
    if (!title) throw new Error('录入妙手缺少商品标题。');
    // 妙手在无 SKU 的创建分支仍要求 SPU 货源价；这里使用用户确认的默认值。
    // 公共采集箱列表的缩略图由创建时的商品图生成；只带首张图，仍保持最小创建参数。
    const firstImage = (Array.isArray(detail.imgUrls) ? detail.imgUrls : []).map((url) => String(url || '').trim()).find(Boolean);
    return { title, price: 10, ...(firstImage ? { imgUrls: [firstImage] } : {}) };
  }

  extractClaimedPlatformDetailId(platformCollectBoxDetailIdMap, platformCode, commonDetailId) {
    const platformMap = platformCollectBoxDetailIdMap?.[platformCode] || platformCollectBoxDetailIdMap?.[String(platformCode).toLowerCase()] || {};
    const direct = platformMap?.[String(commonDetailId)] ?? platformMap?.[Number(commonDetailId)] ?? platformMap;
    const detailId = Number(direct?.detailId ?? direct?.platformCollectBoxDetailId ?? direct);
    if (!Number.isInteger(detailId) || detailId < 1) throw new Error('妙手认领成功但未返回当前商品的平台采集箱详情 ID，无法继续回写到指定店铺。');
    return detailId;
  }

  async saveMiaoshouFolderImportRecord(connection, record) {
    await connection.execute(`INSERT INTO miaoshou_folder_import_records
      (user_id, product_id, miaoshou_app_id, platform_code, site_code, shop_id, common_collect_box_detail_id, platform_collect_box_detail_id,
        import_status, current_stage, error_message, create_request, create_response, claim_request, claim_response,
        pre_publish_shop_claim_request, pre_publish_shop_claim_response, pre_publish_shop_claimed_at, write_request, write_response, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), ?, CAST(? AS JSON), CAST(? AS JSON), NOW(), ?)
      ON DUPLICATE KEY UPDATE common_collect_box_detail_id = COALESCE(VALUES(common_collect_box_detail_id), common_collect_box_detail_id),
        platform_collect_box_detail_id = COALESCE(VALUES(platform_collect_box_detail_id), platform_collect_box_detail_id), import_status = VALUES(import_status),
        current_stage = VALUES(current_stage), error_message = VALUES(error_message), create_request = COALESCE(VALUES(create_request), create_request),
        create_response = COALESCE(VALUES(create_response), create_response), claim_request = COALESCE(VALUES(claim_request), claim_request),
        claim_response = COALESCE(VALUES(claim_response), claim_response), pre_publish_shop_claim_request = COALESCE(VALUES(pre_publish_shop_claim_request), pre_publish_shop_claim_request),
        pre_publish_shop_claim_response = COALESCE(VALUES(pre_publish_shop_claim_response), pre_publish_shop_claim_response), pre_publish_shop_claimed_at = COALESCE(VALUES(pre_publish_shop_claimed_at), pre_publish_shop_claimed_at), write_request = COALESCE(VALUES(write_request), write_request),
        write_response = COALESCE(VALUES(write_response), write_response), finished_at = COALESCE(VALUES(finished_at), finished_at), updated_at = NOW()`, [
      Number(record.userId), Number(record.productId), String(record.appId), String(record.platformCode), record.siteCode || null, String(record.shopId),
      Number(record.commonDetailId) || null, Number(record.platformDetailId) || null, String(record.status), String(record.stage),
      record.errorMessage ? String(record.errorMessage).slice(0, 2000) : null,
      record.createRequest ? JSON.stringify(record.createRequest) : null, record.createResponse ? JSON.stringify(record.createResponse) : null,
      record.claimRequest ? JSON.stringify(record.claimRequest) : null, record.claimResponse ? JSON.stringify(record.claimResponse) : null,
      record.prePublishShopClaimRequest ? JSON.stringify(record.prePublishShopClaimRequest) : null, record.prePublishShopClaimResponse ? JSON.stringify(record.prePublishShopClaimResponse) : null,
      record.prePublishShopClaimedAt || null,
      record.writeRequest ? JSON.stringify(record.writeRequest) : null, record.writeResponse ? JSON.stringify(record.writeResponse) : null,
      record.finished ? new Date() : null,
    ]);
  }

  async importFolderBuilderProductToMiaoshou(userId, productId) {
    let connection;
    let record;
    let product;
    let target;
    try {
      const id = Number(userId); const localProductId = Number(productId);
      if (!Number.isInteger(id) || id < 1 || !Number.isInteger(localProductId) || localProductId < 1) throw new Error('录入妙手参数无效。');
      const config = await this.getConfig(); const appId = String(config.miaoshou.appId || '').trim();
      if (!appId) throw new Error('请先在系统设置中配置妙手 App ID。');
      connection = await this.openConnection(config);
      await this.ensureMiaoshouAuthorizedShopsTables(connection);
      await this.ensureMiaoshouFolderImportRecordsTable(connection);
      await this.ensureMiaoshouProductMappingsTable(connection);
      await this.ensureProductMiaoshouAccountScope(connection);
      await this.ensureMiaoshouWriteRecordsTable(connection);
      await this.ensureProductIssuesTable(connection);
      await this.ensureFieldMappingsTable(connection);
      const [settings] = await connection.execute(`SELECT platform_code, site_code, shop_id FROM automation_publish_settings
        WHERE user_id = ? AND miaoshou_app_id = ? LIMIT 1`, [id, appId]);
      if (!settings.length || !settings[0].shop_id || !settings[0].platform_code) throw new Error('请先在上架与自动化设置中保存目标平台和店铺。');
      target = settings[0];
      const [shops] = await connection.execute(`SELECT shop_name, shop_mode FROM miaoshou_authorized_shops
        WHERE user_id = ? AND miaoshou_app_id = ? AND platform_code = ? AND site_code = ? AND shop_id = ? AND is_enabled = 1 LIMIT 1`,
      [id, appId, target.platform_code, target.site_code, target.shop_id]);
      if (!shops.length) throw new Error('目标店铺已失效或不属于当前妙手 App ID，请刷新授权店铺。');
      target = { ...target, shopName: shops[0].shop_name, shopMode: shops[0].shop_mode };
      const [products] = await connection.execute(`SELECT id, source_product_id, source_platform_code, source_store_id, current_category_id, title, generated_title, ai_generated_image_urls,
        source_notes_text, source_price, source_stock, source_weight, source_package_length, source_package_width, source_package_height, raw_data
        FROM products p WHERE id = ? AND created_by = ? AND deleted_at IS NULL AND (
          ((source_platform_code = 'folder_builder' AND (source_miaoshou_app_id IS NULL OR (source_miaoshou_app_id = ? AND source_store_id = ?))) OR source_platform_code = 'image_product_builder') OR EXISTS (
            SELECT 1 FROM miaoshou_folder_import_records r WHERE r.user_id = ? AND r.product_id = p.id
              AND r.miaoshou_app_id = ? AND r.platform_code = ? AND r.shop_id = ?
          )
        ) LIMIT 1`, [localProductId, id, appId, String(target.shop_id), id, appId, target.platform_code, target.shop_id]);
      if (!products.length) throw new Error('只有文件夹建品或以图建品本地草稿，以及已有录入记录的商品可以录入妙手。');
      product = products[0];
      const [records] = await connection.execute(`SELECT * FROM miaoshou_folder_import_records WHERE user_id = ? AND product_id = ? AND miaoshou_app_id = ? AND platform_code = ? AND shop_id = ? LIMIT 1`,
      [id, localProductId, appId, target.platform_code, target.shop_id]);
      record = records[0] || {};
      const client = new MiaoshouClient(config.miaoshou);
      const saveRecord = async (updates) => {
        record = { ...record, ...updates, userId: id, productId: localProductId, appId, platformCode: target.platform_code, siteCode: target.site_code, shopId: target.shop_id };
        if (updates.commonDetailId) record.common_collect_box_detail_id = Number(updates.commonDetailId);
        if (updates.platformDetailId) record.platform_collect_box_detail_id = Number(updates.platformDetailId);
        if (updates.status) record.import_status = updates.status;
        if (updates.stage) record.current_stage = updates.stage;
        await this.saveMiaoshouFolderImportRecord(connection, record);
      };
      await connection.execute("UPDATE products SET product_status = 'importing_miaoshou', last_error_code = NULL, last_error_message = NULL, updated_at = NOW() WHERE id = ?", [localProductId]);
      if (!record.common_collect_box_detail_id) {
        const createPayload = this.buildMiaoshouCommonCollectBoxMinimalCreate(product);
        await saveRecord({ status: 'running', stage: 'creating_common', errorMessage: null, createRequest: createPayload });
        const created = await client.createCommonCollectBoxDetail(createPayload);
        await saveRecord({ status: 'running', stage: 'common_created', commonDetailId: created.commonCollectBoxDetailId, createResponse: created.response });
        await connection.execute("UPDATE products SET product_status = 'common_collect_box_created', updated_at = NOW() WHERE id = ?", [localProductId]);
      }
      if (!record.platform_collect_box_detail_id) {
        // serialNumber 表示认领发布平台的序号；当前自动化仅配置一个发布平台，因此固定为 1，而非店铺序号。
        const claimRequest = { detailSerialNumberPlatformList: [{ detailId: Number(record.common_collect_box_detail_id), platform: target.platform_code, serialNumber: 1 }] };
        await saveRecord({ status: 'running', stage: 'claiming_platform', errorMessage: null, claimRequest });
        const claimed = await client.claimCommonCollectBoxDetails(claimRequest.detailSerialNumberPlatformList);
        const platformDetailId = this.extractClaimedPlatformDetailId(claimed.platformCollectBoxDetailIdMap, target.platform_code, record.common_collect_box_detail_id);
        await saveRecord({ status: 'running', stage: 'platform_claimed', platformDetailId, claimResponse: claimed.response });
        await connection.execute("UPDATE products SET product_status = 'platform_claimed', updated_at = NOW() WHERE id = ?", [localProductId]);
      }
      if (!record.pre_publish_shop_claimed_at && !record.prePublishShopClaimedAt) {
        const prePublishShopClaimRequest = { shopIds: [Number(target.shop_id)], detailIds: [Number(record.platform_collect_box_detail_id)] };
        await saveRecord({ status: 'running', stage: 'claiming_pre_publish_shop', errorMessage: null, prePublishShopClaimRequest });
        const prePublishShopClaimResponse = await client.claimPlatformCollectBoxToShop(target.platform_code, prePublishShopClaimRequest.shopIds, prePublishShopClaimRequest.detailIds);
        await saveRecord({ status: 'running', stage: 'pre_publish_shop_claimed', prePublishShopClaimRequest, prePublishShopClaimResponse, prePublishShopClaimedAt: new Date() });
      }
      const localDetail = this.parseJsonColumn(product.raw_data, {})._miaoshouDetail || {};
      const detailRequest = { detailId: Number(record.platform_collect_box_detail_id), shopId: Number(target.shop_id), cid: Number(localDetail.cid) || 0 };
      await saveRecord({ status: 'running', stage: 'syncing_miaoshou_detail', errorMessage: null, writeRequest: detailRequest });
      const detailData = await client.getPlatformCollectBoxShopDetail(target.platform_code, detailRequest.detailId, detailRequest.shopId, detailRequest.cid);
      const [images] = await connection.execute(`SELECT a.original_url FROM product_images pi JOIN assets a ON a.id = pi.asset_id
        WHERE pi.product_id = ? AND pi.image_group = 'source' AND a.deleted_at IS NULL ORDER BY pi.sort_order, pi.id`, [localProductId]);
      const sourceImageUrls = images.map((image) => String(image.original_url || '').trim()).filter((url) => /^https?:\/\//i.test(url));
      const aiImageUrls = [...new Set(this.parseJsonColumn(product.ai_generated_image_urls, []).map((url) => String(url || '').trim()).filter((url) => /^https?:\/\//i.test(url)))];
      const selectedImageUrls = (aiImageUrls.length ? aiImageUrls : sourceImageUrls).slice(0, 10);
      const writeProduct = { ...product, source_product_id: String(record.platform_collect_box_detail_id), source_store_id: String(target.shop_id) };
      const writePayload = this.buildMiaoshouStoreCollectBoxEdit(writeProduct, selectedImageUrls, target.platform_code);
      await saveRecord({ status: 'running', stage: 'writing_product_images', writeRequest: { ...detailRequest, imageSource: aiImageUrls.length ? 'ai_generated' : 'source', imgUrls: writePayload.imgUrls } });
      const writeResponse = await client.savePlatformCollectBoxShopDetail(target.platform_code, detailRequest.detailId, detailRequest.shopId, writePayload);
      await saveRecord({ status: 'running', stage: 'validating_thumbnail', writeResponse: { save: writeResponse.data || writeResponse } });
      const listResult = await client.getPlatformCollectBoxList(target.platform_code, 0, 500);
      const listItem = listResult.items.find((item) => String(item?.collectBoxDetailId ?? item?.detailId ?? item?.id) === String(record.platform_collect_box_detail_id));
      const thumbnail = String(listItem?.thumbnail || listItem?.listThumbnail || '').trim();
      // 此处仅确认妙手已生成目标店铺采集箱详情；文件夹建品的商品内容继续以本地草稿为准。
      // 远端详情快照保留在 raw_data 中用于审计，不参与标题、图片、SKU、类目或属性的回填。
      const localRawData = this.parseJsonColumn(product.raw_data, {});
      const rawData = {
        ...localRawData,
        _miaoshouStoreCollectBox: { platformCode: target.platform_code, siteCode: target.site_code, shopId: String(target.shop_id), collectBoxDetailId: String(record.platform_collect_box_detail_id) },
        _miaoshouStoreDetail: detailData,
        _miaoshouFolderImport: { commonCollectBoxDetailId: Number(record.common_collect_box_detail_id), platformCollectBoxDetailId: Number(record.platform_collect_box_detail_id), platformCode: target.platform_code, shopId: String(target.shop_id), importedAt: new Date().toISOString(), localDataPreserved: true },
      };
      const syncedProduct = { ...product, source_miaoshou_app_id: appId, source_platform_code: `miaoshou_${target.platform_code}`, source_product_id: String(record.platform_collect_box_detail_id), source_store_id: String(target.shop_id), raw_data: rawData };
      await connection.execute(`UPDATE products SET source_miaoshou_app_id = ?, source_platform_code = ?, source_product_id = ?, source_store_id = ?, product_status = 'miaoshou_synced',
        raw_data = CAST(? AS JSON), last_synced_at = NOW(), last_written_at = NULL, last_error_code = NULL, last_error_message = NULL, updated_at = NOW() WHERE id = ?`, [
        syncedProduct.source_miaoshou_app_id, syncedProduct.source_platform_code, syncedProduct.source_product_id, syncedProduct.source_store_id, JSON.stringify(rawData), localProductId,
      ]);
      await this.saveMiaoshouProductMapping(connection, { userId: id, appId, product: syncedProduct, target, writeStatus: 'succeeded',
        platformDetailId: record.platform_collect_box_detail_id, requestSummary: { importedFromFolderBuilder: true, commonDetailId: record.common_collect_box_detail_id, detailId: record.platform_collect_box_detail_id, shopId: target.shop_id, syncedFromMiaoshou: true, localDataPreserved: true }, responseSummary: { detail: detailData } });
      await this.clearProductIssue(connection, id, localProductId, 'miaoshou_folder_import');
      await saveRecord({ status: 'succeeded', stage: 'miaoshou_synced', errorMessage: null, writeResponse: { detail: detailData, save: writeResponse.data || writeResponse, thumbnail: thumbnail || null, localDataPreserved: true }, finished: true });
      const thumbnailHint = thumbnail ? '妙手列表缩略图已生成。' : '商品图片已回写，妙手列表缩略图尚未生成。';
      return { ok: true, productId: localProductId, commonCollectBoxDetailId: Number(record.common_collect_box_detail_id), platformCollectBoxDetailId: Number(record.platform_collect_box_detail_id), target, thumbnailGenerated: Boolean(thumbnail), message: `已创建公共采集箱、认领平台采集箱并回写本地图片；${thumbnailHint}` };
    } catch (error) {
      if (connection && product) {
        const message = String(error.message || '录入妙手失败。');
        try {
          if (record && target) await this.saveMiaoshouFolderImportRecord(connection, { ...record, userId: Number(userId), productId: Number(productId), appId: String((await this.getConfig()).miaoshou.appId || ''), platformCode: target.platform_code, siteCode: target.site_code, shopId: target.shop_id, status: 'failed', stage: record.current_stage || record.stage || 'failed', errorMessage: message, finished: true });
          await connection.execute("UPDATE products SET product_status = 'import_failed', last_error_code = 'MIAOSHOU_FOLDER_IMPORT_FAILED', last_error_message = ?, updated_at = NOW() WHERE id = ?", [message.slice(0, 2000), Number(productId)]);
          await this.saveProductIssue(connection, { userId: Number(userId), productId: Number(productId), issueType: 'miaoshou_folder_import', title: '录入妙手失败', code: error.code || 'MIAOSHOU_FOLDER_IMPORT_FAILED', message, detail: { target } });
        } catch (_) { /* 保留原始错误 */ }
      }
      return { ok: false, code: error.code || 'MIAOSHOU_FOLDER_IMPORT_FAILED', message: error.message || '录入妙手失败。' };
    } finally { if (connection) await connection.end(); }
  }

  writeBackProductTitle(product, fallback = '') {
    const generatedTitle = String(product?.generated_title || '').trim();
    const productTitle = String(product?.title || '').trim();
    return generatedTitle || productTitle || String(fallback || '').trim();
  }

  async writeBackTargetStoreProducts(userId, preview) {
    let connection;
    try {
      const config = await this.getConfig();
      const appId = String(config.miaoshou.appId || '').trim();
      const client = new MiaoshouClient(config.miaoshou);
      connection = await this.openConnection(config);
      await this.ensureMiaoshouProductMappingsTable(connection);
      await this.ensureMiaoshouWriteRecordsTable(connection);
      await this.ensureProductIssuesTable(connection);
      const writtenProducts = [];
      const failures = [];
      for (const previewProduct of preview.products) {
        try {
          const [products] = await connection.execute(`SELECT id, source_product_id, source_platform_code, source_store_id, current_category_id, title, generated_title, ai_generated_image_urls, source_notes_text, source_price, source_stock, source_weight,
            source_package_length, source_package_width, source_package_height, raw_data FROM products WHERE id = ? AND deleted_at IS NULL LIMIT 1`, [previewProduct.id]);
          if (!products.length) throw new Error('本地商品不存在或已删除。');
          const product = products[0];
          const [images] = await connection.execute(`SELECT a.original_url FROM product_images pi JOIN assets a ON a.id = pi.asset_id
            WHERE pi.product_id = ? AND pi.image_group = 'source' AND a.deleted_at IS NULL ORDER BY pi.sort_order, pi.id`, [product.id]);
          const sourceImageUrls = images.map((image) => image.original_url).filter(Boolean);
          const savedAiImageUrls = this.parseJsonColumn(product.ai_generated_image_urls, []);
          const aiImageUrls = [...new Set((Array.isArray(savedAiImageUrls) ? savedAiImageUrls : [])
            .map((url) => String(url || '').trim()).filter((url) => /^https?:\/\//i.test(url)))];
          const imageSource = aiImageUrls.length ? 'ai_generated' : 'source';
          const selectedImageUrls = (aiImageUrls.length ? aiImageUrls : sourceImageUrls).slice(0, 10);
          let raw = product.raw_data;
          if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (_) { raw = {}; } }
          product.raw_data = raw;
          const payload = this.buildMiaoshouStoreCollectBoxEdit(product, selectedImageUrls);
          const response = await client.savePlatformCollectBoxShopDetail(preview.target.platform_code, product.source_product_id, product.source_store_id, payload);
          await this.saveMiaoshouProductMapping(connection, { userId, appId, product, target: preview.target, writeStatus: 'succeeded',
            requestSummary: { detailId: product.source_product_id, shopId: product.source_store_id, editedFields: Object.keys(payload), imageSource, aiImageCount: aiImageUrls.length, sourceImageCount: sourceImageUrls.length, submittedImageCount: selectedImageUrls.length }, responseSummary: { save: response.data || response } });
          await connection.execute(`UPDATE products SET product_status = 'written', last_written_at = NOW(), last_error_code = NULL, last_error_message = NULL, updated_at = NOW() WHERE id = ?`, [product.id]);
          await this.saveMiaoshouWriteRecord(connection, { userId, product, target: preview.target, writeStatus: 'succeeded', recordStatus: 'succeeded',
            requestSummary: { detailId: product.source_product_id, shopId: product.source_store_id, imageSource, aiImageCount: aiImageUrls.length, sourceImageCount: sourceImageUrls.length, submittedImageCount: selectedImageUrls.length }, responseSummary: { save: response.data || response } });
          await this.clearProductIssue(connection, userId, product.id, 'miaoshou_write_back');
          writtenProducts.push(product);
        } catch (error) {
          await this.saveMiaoshouWriteRecord(connection, { userId, product: previewProduct, target: preview.target, writeStatus: 'failed', recordStatus: 'failed', errorMessage: error.message,
            requestSummary: { detailId: previewProduct.source_product_id }, responseSummary: {} });
          await this.saveProductIssue(connection, { userId, productId: previewProduct.id, issueType: 'miaoshou_write_back', title: '回写妙手失败',
            code: error.code || 'MIAOSHOU_WRITE_BACK_FAILED', message: error.message, detail: { sourceProductId: previewProduct.source_product_id, target: preview.target } });
          failures.push({ id: previewProduct.id, title: previewProduct.title, stage: 'write_back', message: error.message });
        }
      }
      return { ok: failures.length === 0, partial: failures.length > 0 && writtenProducts.length > 0, writtenCount: writtenProducts.length, failures,
        message: failures.length ? `已回写 ${writtenProducts.length} 件店铺采集箱商品，${failures.length} 件失败。` : `已回写 ${writtenProducts.length} 件店铺采集箱商品。` };
    } catch (error) {
      return { ok: false, code: error.code || 'MIAOSHOU_STORE_WRITE_ERROR', message: error.message, writtenCount: 0, failures: [] };
    } finally { if (connection) await connection.end(); }
  }

  async saveMiaoshouProductMapping(connection, { userId, appId, product, target, writeStatus, publishStatus = 'pending', platformDetailId = null, errorMessage = null, requestSummary, responseSummary }) {
    await connection.execute(`INSERT INTO miaoshou_product_mappings (user_id, miaoshou_app_id, product_id, source_detail_id, platform_code, site_code, shop_id,
      platform_collect_box_detail_id, write_back_status, publish_status, last_error_message, request_summary, response_summary, last_synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), NOW())
      ON DUPLICATE KEY UPDATE platform_collect_box_detail_id = VALUES(platform_collect_box_detail_id), write_back_status = VALUES(write_back_status),
        publish_status = VALUES(publish_status), last_error_message = VALUES(last_error_message), request_summary = VALUES(request_summary),
        response_summary = VALUES(response_summary), last_synced_at = NOW()`, [
      Number(userId), appId, product.id, String(product.source_product_id), target.platform_code, target.site_code, target.shop_id,
      platformDetailId === null ? null : String(platformDetailId), writeStatus, publishStatus, errorMessage,
      JSON.stringify(requestSummary || {}), JSON.stringify(responseSummary || {}),
    ]);
  }

  async writeBackMiaoshouProducts(userId, productIds) {
    const preview = await this.getMiaoshouWritePreview(userId, productIds);
    if (!preview.ok) return preview;
    return this.writeBackTargetStoreProducts(userId, preview);
  }

  async publishMiaoshouProduct(userId, productId) {
    let connection;
    let preview;
    let config;
    let appId = '';
    let publishRequest = null;
    let publishStage = 'preparing';
    try {
      const id = Number(productId);
      if (!Number.isInteger(id) || id < 1) throw new Error('商品编号无效。');
      preview = await this.getMiaoshouWritePreview(userId, [id]);
      if (!preview.ok) return preview;
      if (preview.target.platform_code !== 'pddkj') {
        return { ok: false, code: 'PUBLISH_PLATFORM_UNSUPPORTED', message: '当前仅支持 TEMU 全托商品发布。' };
      }
      const product = preview.products[0];
      const shopId = Number(product.source_store_id);
      const detailId = Number(product.source_product_id);
      if (!Number.isInteger(shopId) || shopId < 1 || !Number.isInteger(detailId) || detailId < 1) {
        throw new Error('商品缺少有效的妙手店铺 ID 或采集箱详情 ID。');
      }
      publishRequest = { shopIds: [shopId], detailIds: [detailId] };
      config = await this.getConfig();
      appId = String(config.miaoshou.appId || '').trim();
      connection = await this.openConnection(config);
      await this.ensureMiaoshouProductMappingsTable(connection);
      await this.ensureMiaoshouWriteRecordsTable(connection);
      await this.ensureProductIssuesTable(connection);
      publishStage = 'writing_back';
      const writeResult = await this.writeBackTargetStoreProducts(userId, preview);
      if (!writeResult.ok || writeResult.writtenCount !== 1) {
        const error = new Error(`发布前回写失败：${writeResult.message}`);
        error.code = 'MIAOSHOU_WRITE_BEFORE_PUBLISH_FAILED';
        error.writeResult = writeResult;
        throw error;
      }
      await this.saveMiaoshouProductMapping(connection, {
        userId, appId, product, target: preview.target, writeStatus: 'succeeded', publishStatus: 'publishing',
        requestSummary: { saveCollectBox: true, publish: publishRequest }, responseSummary: {},
      });
      publishStage = 'submitting';
      const response = await new MiaoshouClient(config.miaoshou).publishTemuFullCollectBoxProducts(publishRequest.shopIds, publishRequest.detailIds);
      await this.saveMiaoshouProductMapping(connection, {
        userId, appId, product, target: preview.target, writeStatus: 'succeeded', publishStatus: 'submitted',
        requestSummary: { saveCollectBox: true, publish: publishRequest }, responseSummary: { publish: response.data || response },
      });
      await this.saveMiaoshouWriteRecord(connection, {
        userId, product, target: preview.target, operationType: 'publish', writeStatus: 'succeeded', recordStatus: 'succeeded',
        requestSummary: { stage: 'submitted', publish: publishRequest }, responseSummary: { publish: response.data || response },
      });
      await connection.execute(`UPDATE products SET product_status = 'publish_submitted', last_error_code = NULL, last_error_message = NULL, updated_at = NOW() WHERE id = ?`, [id]);
      await this.clearProductIssue(connection, userId, id, 'miaoshou_publish');
      return { ok: true, message: '商品已回写妙手采集箱并提交发布。', response: response.data || response };
    } catch (error) {
      if (connection && preview?.products?.[0] && preview?.target) {
        const product = preview.products[0];
        if (!config) config = await this.getConfig();
        if (!appId) appId = String(config.miaoshou.appId || '').trim();
        await this.ensureMiaoshouProductMappingsTable(connection);
        await this.ensureMiaoshouWriteRecordsTable(connection);
        await this.ensureProductIssuesTable(connection);
        await this.saveMiaoshouProductMapping(connection, {
          userId, appId, product, target: preview.target, writeStatus: publishStage === 'writing_back' ? 'failed' : 'succeeded', publishStatus: 'failed', errorMessage: error.message,
          requestSummary: { publish: publishRequest || { shopIds: [Number(product.source_store_id)], detailIds: [Number(product.source_product_id)] } }, responseSummary: {},
        });
        await this.saveMiaoshouWriteRecord(connection, {
          userId, product, target: preview.target, operationType: 'publish', writeStatus: publishStage === 'writing_back' ? 'failed' : 'succeeded', recordStatus: 'failed', errorMessage: error.message,
          requestSummary: { stage: publishStage, publish: publishRequest || { shopIds: [Number(product.source_store_id)], detailIds: [Number(product.source_product_id)] } }, responseSummary: error.writeResult ? { writeBack: error.writeResult } : {},
        });
        await connection.execute(`UPDATE products SET product_status = 'publish_failed', last_error_code = ?, last_error_message = ?, updated_at = NOW() WHERE id = ?`, [error.code || 'MIAOSHOU_PUBLISH_FAILED', String(error.message || '妙手商品发布失败。').slice(0, 2000), Number(product.id)]);
        await this.saveProductIssue(connection, { userId, productId: product.id, issueType: 'miaoshou_publish', title: '发布妙手商品失败', code: error.code || 'MIAOSHOU_PUBLISH_FAILED', message: error.message, detail: { target: preview.target } });
      }
      return { ok: false, code: error.code || 'MIAOSHOU_PUBLISH_FAILED', message: error.message };
    } finally { if (connection) await connection.end(); }
  }

  async getAuthorizedMiaoshouShops(userId, profileId = null) {
    let connection;
    try {
      const config = await this.getConfig();
      const profile = (config.miaoshouProfiles || []).find((item) => item.id === (profileId || config.activeMiaoshouProfileId))
        || { id: config.activeMiaoshouProfileId || '', name: '当前妙手配置', ...config.miaoshou };
      const appId = String(profile.appId || '').trim();
      if (!userId) throw new Error('请先登录本机用户。');
      if (!appId) throw new Error('请先在系统配置中填写妙手 App ID。');
      connection = await this.openConnection(config);
      await this.ensureMiaoshouAuthorizedShopsTables(connection);
      const [shops] = await connection.execute(`SELECT platform_code, site_code, shop_id, shop_name, shop_mode, authorization_status, last_synced_at
        FROM miaoshou_authorized_shops WHERE user_id = ? AND miaoshou_app_id = ? AND is_enabled = 1
        ORDER BY platform_code, shop_name, shop_id`, [Number(userId), appId]);
      const [[latest]] = await connection.execute(`SELECT MAX(last_synced_at) AS last_synced_at FROM miaoshou_authorized_shops
        WHERE user_id = ? AND miaoshou_app_id = ?`, [Number(userId), appId]);
      return { ok: true, profileId: profile.id, profileName: profile.name, appId, shops, lastSyncedAt: latest.last_synced_at || null };
    } catch (error) {
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message, shops: [] };
    } finally { if (connection) await connection.end(); }
  }

  normalizeMiaoshouShop(shop, target) {
    const shopId = shop.shopId ?? shop.id ?? shop.appAccountId ?? shop.accountId ?? shop.storeId;
    if (shopId === null || shopId === undefined || shopId === '') return null;
    const siteCode = String(shop.siteCode || shop.site || target.siteCode || '').trim();
    if (!siteCode) return null;
    return {
      platformCode: String(shop.platformCode || shop.platform || target.platformCode),
      siteCode,
      shopId: String(shopId),
      shopName: String(shop.shopName || shop.shopNick || shop.platformShopName || shop.name || shop.shopAlias || shop.appAccountName || shopId),
      shopMode: String(shop.shopMode || shop.mode || target.publishMode),
      authorizationStatus: shop.authorizationStatus || shop.status || shop.authStatus || null,
      rawData: shop,
    };
  }

  async syncAuthorizedMiaoshouShops(userId, profileId = null) {
    let connection;
    try {
      const config = await this.getConfig();
      const profile = (config.miaoshouProfiles || []).find((item) => item.id === (profileId || config.activeMiaoshouProfileId))
        || { id: config.activeMiaoshouProfileId || '', name: '当前妙手配置', ...config.miaoshou };
      const appId = String(profile.appId || '').trim();
      if (!userId) throw new Error('请先登录本机用户。');
      if (!appId) throw new Error('请先在系统配置中填写妙手 App ID。');
      const client = new MiaoshouClient(profile);
      const results = [];
      const failures = [];
      for (const [index, target] of MIAOSHOU_SHOP_TARGETS.entries()) {
        try {
          // 妙手店铺接口按账号限频；跨 TikTok 站点轮询时保持请求间隔，避免漏店铺。
          if (index > 0) await new Promise((resolve) => setTimeout(resolve, 1100));
          const response = await client.post('/open/v1/product/shop/shop/get_shop_list', {
            platform: target.platformCode, site: target.siteCode, pageNo: 1, pageSize: 100,
          });
          if (response.result === 'fail' || (response.code && response.code !== 'success')) throw new Error(response.message || response.code || '妙手接口返回失败。');
          const list = response.data?.shopList || response.data?.list || response.data?.records || [];
          results.push({ target, shops: Array.isArray(list) ? list.map((shop) => this.normalizeMiaoshouShop(shop, target)).filter(Boolean) : [] });
        } catch (error) { failures.push(`${target.publishMode}：${error.message}`); }
      }
      if (!results.length) throw new Error(failures.join('；') || '未能读取妙手授权店铺。');
      connection = await this.openConnection(config);
      await this.ensureMiaoshouAuthorizedShopsTables(connection);
      await connection.beginTransaction();
      let syncedCount = 0;
      for (const result of results) {
        await connection.execute(`UPDATE miaoshou_authorized_shops SET is_enabled = 0 WHERE user_id = ? AND miaoshou_app_id = ? AND platform_code = ? AND site_code = ?`,
          [Number(userId), appId, result.target.platformCode, result.target.siteCode]);
        for (const shop of result.shops) {
          await connection.execute(`INSERT INTO miaoshou_authorized_shops (user_id, miaoshou_app_id, platform_code, site_code, shop_id, shop_name, shop_mode, authorization_status, is_enabled, raw_data, last_synced_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, CAST(? AS JSON), NOW())
            ON DUPLICATE KEY UPDATE shop_name = VALUES(shop_name), shop_mode = VALUES(shop_mode), authorization_status = VALUES(authorization_status),
              is_enabled = 1, raw_data = VALUES(raw_data), last_synced_at = NOW()`, [
            Number(userId), appId, shop.platformCode, shop.siteCode, shop.shopId, shop.shopName, shop.shopMode, shop.authorizationStatus, JSON.stringify(shop.rawData),
          ]);
          syncedCount += 1;
        }
      }
      await connection.commit();
      const cached = await this.getAuthorizedMiaoshouShops(userId, profile.id);
      return { ...cached, ok: true, syncedCount, message: `已同步“${profile.name || appId}”下 ${syncedCount} 家授权店铺。`, warnings: failures };
    } catch (error) {
      if (connection) { try { await connection.rollback(); } catch (_) { /* transaction not started */ } }
      return { ok: false, code: error.code || 'MIAOSHOU_SHOP_SYNC_ERROR', message: error.message, shops: [] };
    } finally { if (connection) await connection.end(); }
  }

  async syncAllAuthorizedMiaoshouShops(userId) {
    try {
      const config = await this.getConfig();
      const profiles = (config.miaoshouProfiles || []).filter((profile) => String(profile.appId || '').trim() && String(profile.appSecret || '').trim());
      if (!profiles.length) throw new Error('请先在系统设置中配置至少一个妙手 API 档案。');
      const results = [];
      for (const profile of profiles) results.push(await this.syncAuthorizedMiaoshouShops(userId, profile.id));
      const succeeded = results.filter((result) => result.ok);
      const failed = results.filter((result) => !result.ok);
      return {
        ok: succeeded.length > 0,
        results,
        syncedCount: succeeded.reduce((total, result) => total + Number(result.syncedCount || 0), 0),
        message: failed.length ? `已同步 ${succeeded.length} 个妙手配置，${failed.length} 个失败。` : `已同步 ${succeeded.length} 个妙手配置下的全部店铺。`,
      };
    } catch (error) {
      return { ok: false, code: error.code || 'MIAOSHOU_SHOP_SYNC_ERROR', message: error.message, results: [] };
    }
  }

  async getAutomationPublishSettings(userId) {
    let connection;
    try {
      const config = await this.getConfig();
      const appId = String(config.miaoshou.appId || '').trim();
      if (!userId) throw new Error('请先登录本机用户。');
      connection = await this.openConnection(config);
      await this.ensureMiaoshouAuthorizedShopsTables(connection);
      const [settings] = await connection.execute('SELECT platform_code, site_code, shop_id, write_target FROM automation_publish_settings WHERE user_id = ? AND miaoshou_app_id = ? LIMIT 1', [Number(userId), appId]);
      return { ok: true, settings: settings[0] || null };
    } catch (error) { return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message }; }
    finally { if (connection) await connection.end(); }
  }

  async saveAutomationPublishSettings(userId, setting) {
    let connection;
    try {
      const config = await this.getConfig();
      const appId = String(config.miaoshou.appId || '').trim();
      const shopId = String(setting.shopId || '').trim();
      if (!userId) throw new Error('请先登录本机用户。');
      if (!shopId) throw new Error('请选择妙手授权店铺。');
      connection = await this.openConnection(config);
      await this.ensureMiaoshouAuthorizedShopsTables(connection);
      const [shops] = await connection.execute(`SELECT platform_code, site_code, shop_id FROM miaoshou_authorized_shops
        WHERE user_id = ? AND miaoshou_app_id = ? AND shop_id = ? AND platform_code = ? AND is_enabled = 1 LIMIT 1`,
      [Number(userId), appId, shopId, String(setting.platformCode || '')]);
      if (!shops.length) throw new Error('所选店铺不属于当前登录用户和妙手 App ID，请先刷新授权店铺。');
      const shop = shops[0];
      await connection.execute(`INSERT INTO automation_publish_settings (user_id, miaoshou_app_id, platform_code, site_code, shop_id, write_target)
        VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE platform_code = VALUES(platform_code), site_code = VALUES(site_code),
          shop_id = VALUES(shop_id), write_target = VALUES(write_target)`,
      [Number(userId), appId, shop.platform_code, shop.site_code, shop.shop_id, setting.writeTarget || 'miaoshou_unpublished']);
      return { ok: true, message: '上架发布目标已保存到本地数据库。' };
    } catch (error) { return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message }; }
    finally { if (connection) await connection.end(); }
  }

  async getAutomationOperationSettings(userId) {
    let connection;
    try {
      const config = await this.getConfig();
      const appId = String(config.miaoshou.appId || '').trim();
      if (!userId) throw new Error('请先登录本机用户。');
      connection = await this.openConnection(config);
      await this.ensureAutomationOperationSettingsTable(connection, appId);
      await this.ensureAutomationOperationBindingsTable(connection, appId);
      await this.migrateAutomationOperationSettingsLegacyRelations(connection);
      await this.ensureModelProvidersTable(connection, config);
      await this.ensureTemplateCategoriesTable(connection);
      const [[settings]] = await connection.execute(`SELECT title_enabled, prefer_category_title_templates, use_miaoshou_category_attributes, collect_price_multiplier,
        auto_generate_images, prefer_category_image_templates, auto_generate_sku_images, ai_material_planning, auto_write_miaoshou,
        folder_auto_title, folder_auto_images, folder_auto_import, folder_auto_write_back, folder_auto_publish
        FROM automation_operation_settings WHERE user_id = ? LIMIT 1`, [Number(userId)]);
      const [modelProviders] = await connection.execute(`SELECT id, provider_name, default_model, provider_type, image_adapter FROM model_providers
        WHERE is_enabled = 1 ORDER BY is_active DESC, sort_order, id`);
      const [templates] = await connection.execute(`SELECT id, template_type, template_name FROM templates
        WHERE status = 'enabled' AND deleted_at IS NULL ORDER BY template_type, updated_at DESC, id DESC`);
      const bindings = await this.getAutomationOperationBindings(connection, userId);
      const bindingIds = (operationType, bindingType) => bindings
        .filter((binding) => binding.operation_type === operationType && binding.binding_type === bindingType)
        .map((binding) => Number(binding.target_id)).filter((id) => Number.isInteger(id) && id > 0);
      const configuredSettings = settings && {
        ...settings,
        title_template_ids: bindingIds('title', 'template'),
        title_model_provider_ids: bindingIds('title', 'model'),
        image_template_ids: bindingIds('image', 'template'),
        image_model_provider_ids: bindingIds('image', 'model'),
        sku_image_template_ids: bindingIds('sku_image', 'template'),
        sku_image_model_provider_ids: bindingIds('sku_image', 'model'),
      };
      return { ok: true, settings: configuredSettings || null, modelProviders: modelProviders.map((provider) => ({ ...provider, capabilities: providerCapabilities(provider) })), templates };
    } catch (error) {
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message, settings: null, modelProviders: [], templates: [] };
    } finally { if (connection) await connection.end(); }
  }

  async saveAutomationOperationSettings(userId, setting) {
    let connection;
    let transactionStarted = false;
    try {
      const config = await this.getConfig();
      const appId = String(config.miaoshou.appId || '').trim();
      if (!userId) throw new Error('请先登录本机用户。');
      const normalizeIds = (values) => [...new Set((Array.isArray(values) ? values : [values])
        .map(Number).filter((id) => Number.isInteger(id) && id > 0))];
      const titleEnabledInput = setting.titleEnabled;
      const titleTemplateIds = normalizeIds(setting.titleTemplateIds ?? setting.titleTemplateId);
      const titleModelProviderIds = normalizeIds(setting.titleModelProviderIds ?? setting.titleModelProviderId);
      const preferCategoryTitleTemplates = setting.preferCategoryTitleTemplates === true;
      const imageEnabled = setting.autoGenerateImages !== false;
      const preferCategoryImageTemplates = setting.preferCategoryImageTemplates === true;
      const imageTemplateIds = normalizeIds(setting.imageTemplateIds ?? setting.imageTemplateId);
      const imageModelProviderIds = normalizeIds(setting.imageModelProviderIds ?? setting.imageModelProviderId);
      const skuImageEnabled = setting.autoGenerateSkuImages === true;
      const folderAutoTitle = setting.folderAutoTitle === true;
      const folderAutoImages = setting.folderAutoImages === true;
      const folderAutoPublish = setting.folderAutoPublish === true;
      const folderAutoWriteBack = setting.folderAutoWriteBack === true || folderAutoPublish;
      const folderAutoImport = setting.folderAutoImport === true || folderAutoWriteBack;
      const skuImageTemplateIds = normalizeIds(setting.skuImageTemplateIds ?? setting.skuImageTemplateId);
      const skuImageModelProviderIds = normalizeIds(setting.skuImageModelProviderIds ?? setting.skuImageModelProviderId);
      const multiplier = Number(setting.collectPriceMultiplier);
      if (!Number.isFinite(multiplier) || multiplier < 0) throw new Error('采集价格系数必须是大于或等于 0 的数字。');
      if (imageEnabled && (!imageTemplateIds.length || !imageModelProviderIds.length)) throw new Error('请至少为自动生成图片选择一个提示词模板和一个大模型。');
      if (skuImageEnabled && (!skuImageTemplateIds.length || !skuImageModelProviderIds.length)) throw new Error('请至少为自动生成 SKU 图选择一个提示词模板和一个大模型。');
      connection = await this.openConnection(config);
      await this.ensureAutomationOperationSettingsTable(connection, appId);
      await this.ensureAutomationOperationBindingsTable(connection, appId);
      await this.migrateAutomationOperationSettingsLegacyRelations(connection);
      const [[existingOperationSettings]] = await connection.execute(`SELECT title_enabled FROM automation_operation_settings
        WHERE user_id = ? LIMIT 1`, [Number(userId)]);
      const titleEnabled = titleEnabledInput === true ? true : (titleEnabledInput === false ? false : Number(existingOperationSettings?.title_enabled) !== 0);
      const modelProviderIds = normalizeIds([...titleModelProviderIds, ...imageModelProviderIds, ...skuImageModelProviderIds]);
      const templateIds = normalizeIds([...titleTemplateIds, ...imageTemplateIds, ...skuImageTemplateIds]);
      if (modelProviderIds.length) {
        await this.ensureModelProvidersTable(connection, config);
      }
      if (templateIds.length) {
        await this.ensureTemplateCategoriesTable(connection);
      }
      if (modelProviderIds.length) {
        const [models] = await connection.execute(`SELECT id FROM model_providers WHERE id IN (${modelProviderIds.map(() => '?').join(', ')}) AND is_enabled = 1`, modelProviderIds);
        if (models.length !== modelProviderIds.length) throw new Error('选择的大模型不存在或已停用，请重新选择。');
      }
      if (templateIds.length) {
        const [templates] = await connection.execute(`SELECT id FROM templates WHERE id IN (${templateIds.map(() => '?').join(', ')}) AND status = 'enabled' AND deleted_at IS NULL`, templateIds);
        if (templates.length !== templateIds.length) throw new Error('选择的提示词模板不存在或已停用，请重新选择。');
      }
      await connection.beginTransaction();
      transactionStarted = true;
      await connection.execute(`INSERT INTO automation_operation_settings (user_id, title_enabled, prefer_category_title_templates,
        use_miaoshou_category_attributes, collect_price_multiplier, auto_generate_images, prefer_category_image_templates, auto_generate_sku_images, ai_material_planning, auto_write_miaoshou,
        folder_auto_title, folder_auto_images, folder_auto_import, folder_auto_write_back, folder_auto_publish) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE title_enabled = VALUES(title_enabled),
          prefer_category_title_templates = VALUES(prefer_category_title_templates),
          use_miaoshou_category_attributes = VALUES(use_miaoshou_category_attributes), collect_price_multiplier = VALUES(collect_price_multiplier),
          auto_generate_images = VALUES(auto_generate_images), prefer_category_image_templates = VALUES(prefer_category_image_templates), auto_generate_sku_images = VALUES(auto_generate_sku_images), ai_material_planning = VALUES(ai_material_planning),
          auto_write_miaoshou = VALUES(auto_write_miaoshou), folder_auto_title = VALUES(folder_auto_title), folder_auto_images = VALUES(folder_auto_images),
          folder_auto_import = VALUES(folder_auto_import), folder_auto_write_back = VALUES(folder_auto_write_back), folder_auto_publish = VALUES(folder_auto_publish)`, [
        Number(userId), titleEnabled ? 1 : 0, preferCategoryTitleTemplates ? 1 : 0, setting.useMiaoshouCategoryAttributes !== false ? 1 : 0, multiplier,
        imageEnabled ? 1 : 0,
        preferCategoryImageTemplates ? 1 : 0,
        skuImageEnabled ? 1 : 0,
        setting.aiMaterialPlanning !== false ? 1 : 0,
        setting.autoWriteMiaoshou === true ? 1 : 0,
        folderAutoTitle ? 1 : 0, folderAutoImages ? 1 : 0, folderAutoImport ? 1 : 0, folderAutoWriteBack ? 1 : 0, folderAutoPublish ? 1 : 0,
      ]);
      const bindingRows = [
        ...titleTemplateIds.map((targetId, sortOrder) => ['title', 'template', targetId, sortOrder]),
        ...titleModelProviderIds.map((targetId, sortOrder) => ['title', 'model', targetId, sortOrder]),
        ...imageTemplateIds.map((targetId, sortOrder) => ['image', 'template', targetId, sortOrder]),
        ...imageModelProviderIds.map((targetId, sortOrder) => ['image', 'model', targetId, sortOrder]),
        ...skuImageTemplateIds.map((targetId, sortOrder) => ['sku_image', 'template', targetId, sortOrder]),
        ...skuImageModelProviderIds.map((targetId, sortOrder) => ['sku_image', 'model', targetId, sortOrder]),
      ];
      const [existingBindings] = await connection.execute(`SELECT id, operation_type, binding_type, target_id
        FROM automation_operation_bindings WHERE user_id = ?`, [Number(userId)]);
      const desiredBindingKeys = new Set(bindingRows.map(([operationType, bindingType, targetId]) => `${operationType}:${bindingType}:${targetId}`));
      const staleBindingIds = existingBindings
        .filter((binding) => !desiredBindingKeys.has(`${binding.operation_type}:${binding.binding_type}:${binding.target_id}`))
        .map((binding) => Number(binding.id));
      if (staleBindingIds.length) await connection.execute(`DELETE FROM automation_operation_bindings WHERE id IN (${staleBindingIds.map(() => '?').join(', ')})`, staleBindingIds);
      if (bindingRows.length) {
        await connection.query(`INSERT INTO automation_operation_bindings
          (user_id, operation_type, binding_type, target_id, sort_order) VALUES ${bindingRows.map(() => '(?, ?, ?, ?, ?)').join(', ')}
          ON DUPLICATE KEY UPDATE sort_order = VALUES(sort_order), updated_at = NOW()`,
        bindingRows.flatMap(([operationType, bindingType, targetId, sortOrder]) => [Number(userId), operationType, bindingType, targetId, sortOrder]));
      }
      await connection.commit();
      transactionStarted = false;
      return { ok: true, message: '自动操作设置已保存到本地数据库。' };
    } catch (error) {
      if (transactionStarted) await connection.rollback();
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message };
    } finally { if (connection) await connection.end(); }
  }

  async runFolderBuilderAutomation(userId, productId, onProgress = () => {}) {
    let connection;
    let runId = null;
    let lastActionStage = 'preparing';
    let actionSnapshot = null;
    const report = async (stage, percent, message, status = 'running', errorMessage = null) => {
      if (!['failed', 'completed'].includes(stage)) lastActionStage = stage;
      const failedStage = stage === 'failed' ? lastActionStage : null;
      try { onProgress({ stage: `automation_${stage}`, percent, message, productId: Number(productId), automationRunId: runId, status, failedStage, configSnapshot: actionSnapshot }); } catch (_) { /* 窗口关闭不影响后台任务 */ }
      if (connection && runId) await connection.execute(`UPDATE folder_builder_automation_runs SET current_stage = ?, progress_percent = ?, progress_message = ?, run_status = ?, error_message = ?, finished_at = ? WHERE id = ?`,
        [stage === 'failed' ? `failed_${failedStage}` : stage, Math.max(0, Math.min(100, Number(percent) || 0)), String(message || '').slice(0, 500), status, errorMessage ? String(errorMessage).slice(0, 2000) : null, ['succeeded', 'failed'].includes(status) ? new Date() : null, runId]);
    };
    try {
      const id = Number(userId); const targetProductId = Number(productId);
      if (!Number.isInteger(id) || id < 1 || !Number.isInteger(targetProductId) || targetProductId < 1) throw new Error('文件夹建品自动化参数无效。');
      const config = await this.getConfig(); const appId = String(config.miaoshou.appId || '').trim();
      connection = await this.openConnection(config);
      await this.ensureAutomationOperationSettingsTable(connection, appId);
      await this.ensureAutomationOperationBindingsTable(connection, appId);
      await this.ensureMiaoshouAuthorizedShopsTables(connection);
      await this.ensureFolderBuilderAutomationRunsTable(connection);
      const [[settings]] = await connection.execute(`SELECT folder_auto_title, folder_auto_images, folder_auto_import, folder_auto_write_back, folder_auto_publish
        FROM automation_operation_settings WHERE user_id = ? LIMIT 1`, [id]);
      const actions = { title: Number(settings?.folder_auto_title) === 1, images: Number(settings?.folder_auto_images) === 1,
        import: Number(settings?.folder_auto_import) === 1, writeBack: Number(settings?.folder_auto_write_back) === 1, publish: Number(settings?.folder_auto_publish) === 1 };
      actionSnapshot = actions;
      if (!Object.values(actions).some(Boolean)) return { ok: true, skipped: true, message: '未启用文件夹建品录入自动化。' };
      const [[product]] = await connection.execute('SELECT id, title, generated_title, raw_data FROM products WHERE id = ? AND created_by = ? AND deleted_at IS NULL LIMIT 1', [targetProductId, id]);
      if (!product) throw new Error('文件夹建品商品不存在或无权操作。');
      const [created] = await connection.execute(`INSERT INTO folder_builder_automation_runs (user_id, product_id, config_snapshot, progress_message)
        VALUES (?, ?, CAST(? AS JSON), ?)`, [id, targetProductId, JSON.stringify(actions), '自动化任务已创建，正在执行前检查。']);
      runId = created.insertId;
      const actionBindings = await this.getAutomationOperationBindings(connection, id);
      const ensureAiActionConfigured = async (operationType, label) => {
        const bindings = actionBindings.filter((binding) => binding.operation_type === operationType);
        const templateIds = bindings.filter((binding) => binding.binding_type === 'template').map((binding) => Number(binding.target_id)).filter((value) => value > 0);
        const providerId = Number(bindings.find((binding) => binding.binding_type === 'model')?.target_id);
        if (!templateIds.length || !providerId) throw new Error(`自动${label}未配置提示词模板或大模型。`);
        const [[provider]] = await connection.execute('SELECT id FROM model_providers WHERE id = ? AND is_enabled = 1 LIMIT 1', [providerId]);
        const [templates] = await connection.execute(`SELECT id FROM templates WHERE id IN (${templateIds.map(() => '?').join(', ')}) AND status = 'enabled' AND deleted_at IS NULL`, templateIds);
        if (!provider || templates.length !== templateIds.length) throw new Error(`自动${label}的模型或提示词模板已失效，请在自动化设置中重新配置。`);
      };
      if (actions.title) await ensureAiActionConfigured('title', '标题');
      if (actions.images) await ensureAiActionConfigured('image', '生图');
      if (actions.import || actions.writeBack || actions.publish) {
        const [[target]] = await connection.execute(`SELECT platform_code, site_code, shop_id FROM automation_publish_settings
          WHERE user_id = ? AND miaoshou_app_id = ? LIMIT 1`, [id, appId]);
        if (!target?.platform_code || !target?.shop_id) throw new Error('自动录入、回写或发布前，请先配置目标店铺。');
        const [[shop]] = await connection.execute(`SELECT shop_id FROM miaoshou_authorized_shops
          WHERE user_id = ? AND miaoshou_app_id = ? AND platform_code = ? AND site_code = ? AND shop_id = ? AND is_enabled = 1 LIMIT 1`,
        [id, appId, target.platform_code, target.site_code, target.shop_id]);
        if (!shop) throw new Error('目标店铺已失效，请刷新授权店铺后重新保存。');
      }
      const [images] = await connection.execute(`SELECT a.original_url FROM product_images pi JOIN assets a ON a.id = pi.asset_id
        WHERE pi.product_id = ? AND pi.image_group = 'source' AND a.deleted_at IS NULL ORDER BY pi.sort_order, pi.id`, [targetProductId]);
      let imageUrls = images.map((image) => String(image.original_url || '').trim()).filter((url) => /^https?:\/\//i.test(url));
      if (!imageUrls.length) {
        const builderImages = this.parseJsonColumn(product.raw_data, {})._imageProductBuilder || {};
        imageUrls = [...new Set([...(builderImages.originalImageUrls || []), ...(builderImages.carouselImageUrls || []), ...(builderImages.sourceImageUrls || [])].map((url) => String(url || '').trim()).filter((url) => /^https?:\/\//i.test(url)))];
      }
      let title = String(product.generated_title || product.title || '').trim();
      if (actions.title) { await report('title', 15, '正在自动生成标题…'); const result = await this.generateProductTitle(id, targetProductId, { title, imageUrls }); if (!result.ok) throw new Error(`自动标题失败：${result.message}`); title = result.title || title; }
      if (actions.images) { await report('images', 38, '正在自动生成商品图片…'); const result = await this.generateProductImages(id, targetProductId, { title, imageUrls, fromFolderAutomation: true, onProgress: (progress) => { void report('images', 38, progress.message || '正在自动生成商品图片…'); } }); if (!result.ok) throw new Error(`自动生图失败：${result.message}`); }
      if (actions.import) { await report('import', 62, '正在自动录入妙手…'); const result = await this.importFolderBuilderProductToMiaoshou(id, targetProductId); if (!result.ok) throw new Error(`自动录入失败：${result.message}`); }
      if (actions.writeBack && !actions.publish) { await report('write_back', 82, '正在自动回写妙手…'); const result = await this.writeBackMiaoshouProducts(id, [targetProductId]); if (!result.ok) throw new Error(`自动回写失败：${result.message}`); }
      if (actions.publish) { await report('publish', 92, '正在自动提交发布…'); const result = await this.publishMiaoshouProduct(id, targetProductId); if (!result.ok) throw new Error(`自动发布失败：${result.message}`); }
      await report('completed', 100, '文件夹建品自动化已完成。', 'succeeded');
      return { ok: true, runId, message: '文件夹建品自动化已完成。' };
    } catch (error) {
      await report('failed', 100, error.message || '文件夹建品自动化失败。', 'failed', error.message);
      return { ok: false, runId, code: error.code || 'FOLDER_BUILDER_AUTOMATION_FAILED', message: error.message || '文件夹建品自动化失败。' };
    } finally { if (connection) await connection.end(); }
  }

  async getLatestFolderBuilderAutomationRun(userId) {
    let connection;
    try {
      const id = Number(userId);
      if (!Number.isInteger(id) || id < 1) throw new Error('请先登录本机用户。');
      connection = await this.openConnection(await this.getConfig());
      await this.ensureFolderBuilderAutomationRunsTable(connection);
      const [[run]] = await connection.execute(`SELECT r.id, r.product_id, r.config_snapshot, r.run_status, r.current_stage, r.progress_percent,
        r.progress_message, r.error_message, r.started_at, r.finished_at, p.title
        FROM folder_builder_automation_runs r JOIN products p ON p.id = r.product_id
        WHERE r.user_id = ? ORDER BY r.id DESC LIMIT 1`, [id]);
      return { ok: true, run: run || null };
    } catch (error) { return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message, run: null }; }
    finally { if (connection) await connection.end(); }
  }

  async listFolderBuilderAutomationRuns(userId, options = {}) {
    let connection;
    try {
      const id = Number(userId);
      if (!Number.isInteger(id) || id < 1) throw new Error('请先登录本机用户。');
      const keyword = String(options.keyword || '').trim().slice(0, 255);
      const status = ['running', 'succeeded', 'failed'].includes(String(options.status || '')) ? String(options.status) : '';
      const limit = Math.max(1, Math.min(100, Number(options.limit) || 50));
      const where = ['r.user_id = ?']; const params = [id];
      if (status) { where.push('r.run_status = ?'); params.push(status); }
      if (keyword) { where.push('(p.title LIKE ? OR p.generated_title LIKE ? OR p.source_product_id LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`); }
      connection = await this.openConnection(await this.getConfig());
      await this.ensureFolderBuilderAutomationRunsTable(connection);
      const clause = where.join(' AND ');
      const [[stats]] = await connection.execute(`SELECT COUNT(*) AS total, SUM(run_status = 'running') AS running,
        SUM(run_status = 'succeeded' AND DATE(finished_at) = CURDATE()) AS todaySucceeded,
        SUM(run_status = 'failed' AND DATE(finished_at) = CURDATE()) AS todayFailed
        FROM folder_builder_automation_runs WHERE user_id = ?`, [id]);
      const [runs] = await connection.execute(`SELECT r.id, r.product_id, r.config_snapshot, r.run_status, r.current_stage, r.progress_percent,
        r.progress_message, r.error_message, r.started_at, r.finished_at, r.updated_at,
        p.title, p.generated_title, p.source_product_id,
        (SELECT a.original_url FROM product_images pi JOIN assets a ON a.id = pi.asset_id
          WHERE pi.product_id = p.id AND a.deleted_at IS NULL ORDER BY pi.sort_order, pi.id LIMIT 1) AS image_url
        FROM folder_builder_automation_runs r JOIN products p ON p.id = r.product_id
        WHERE ${clause} ORDER BY r.id DESC LIMIT ?`, [...params, limit]);
      return { ok: true, runs, stats: { total: Number(stats?.total) || 0, running: Number(stats?.running) || 0, todaySucceeded: Number(stats?.todaySucceeded) || 0, todayFailed: Number(stats?.todayFailed) || 0 } };
    } catch (error) { return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message, runs: [], stats: null }; }
    finally { if (connection) await connection.end(); }
  }

  async generateProductTitle(userId, productId, input = {}) {
    let connection;
    let generationRecordId = null;
    let generationRawData = { requests: [] };
    try {
      const config = await this.getConfig();
      const appId = String(config.miaoshou.appId || '').trim();
      const id = Number(productId);
      const currentTitle = String(input.title || '').trim();
      if (!userId) throw new Error('请先登录本机用户。');
      if (!Number.isInteger(id) || id < 1) throw new Error('商品编号无效。');
      if (!currentTitle) throw new Error('请先填写当前商品标题。');
      connection = await this.openConnection(config);
      await this.ensureAiGenerationRecordsTable(connection);
      await this.ensureAutomationOperationSettingsTable(connection, appId);
      await this.ensureAutomationOperationBindingsTable(connection, appId);
      await this.migrateAutomationOperationSettingsLegacyRelations(connection);
      const titleBindings = (await this.getAutomationOperationBindings(connection, userId)).filter((binding) => binding.operation_type === 'title');
      const [[titleSettings]] = await connection.execute(`SELECT prefer_category_title_templates FROM automation_operation_settings
        WHERE user_id = ? LIMIT 1`, [Number(userId)]);
      const titleTemplateIds = titleBindings.filter((binding) => binding.binding_type === 'template').map((binding) => Number(binding.target_id))
        .filter((templateId) => Number.isInteger(templateId) && templateId > 0);
      const titleModelProviderIds = titleBindings.filter((binding) => binding.binding_type === 'model').map((binding) => Number(binding.target_id))
        .filter((providerId) => Number.isInteger(providerId) && providerId > 0);
      if (!titleModelProviderIds.length) throw new Error('请先在自动标题中选择大模型。');
      const [[provider]] = await connection.execute(`SELECT provider_name, provider_type, api_base_url, api_key_value, default_model, failover_models, timeout_seconds, image_adapter, image_size FROM model_providers
        WHERE id = ? AND is_enabled = 1 LIMIT 1`, [titleModelProviderIds[0]]);
      if (!provider?.api_base_url || !provider?.api_key_value || !provider?.default_model) throw new Error('自动标题所选大模型未配置完整，需填写 API Base URL、API Key 和默认模型。');
      await this.ensureTemplateStorage(connection);
      await this.ensureTemplateCategoriesTable(connection);
      const [products] = await connection.execute('SELECT id, title, raw_data, current_category_id FROM products WHERE id = ? AND deleted_at IS NULL LIMIT 1', [id]);
      if (!products.length) throw new Error('商品不存在或已删除。');
      const categoryId = Number(products[0].current_category_id) || 0;
      const [[category]] = await connection.execute('SELECT category_name, full_path FROM categories WHERE id = ? LIMIT 1', [categoryId]);
      const categoryPath = String(category?.full_path || category?.category_name || '未设置类目').trim();
      let selectedTemplates = [];
      let templateSource = 'automation_config';
      if (Number(titleSettings?.prefer_category_title_templates) === 1 && categoryId > 0) {
        const [categoryTemplates] = await connection.execute(`SELECT t.id, t.template_name, t.prompt_content FROM template_categories tc
          JOIN templates t ON t.id = tc.template_id WHERE tc.category_id = ? AND t.template_type = 'title'
          AND t.status = 'enabled' AND t.deleted_at IS NULL AND t.prompt_content <> '' ORDER BY tc.created_at ASC, t.id ASC`, [categoryId]);
        if (categoryTemplates.length) {
          selectedTemplates = categoryTemplates;
          templateSource = 'category_binding';
        }
      }
      if (!selectedTemplates.length) {
        if (!titleTemplateIds.length) throw new Error('当前类目未绑定可用标题提示词，请在自动标题中配置默认提示词模板。');
        const [templates] = await connection.execute(`SELECT t.id, t.template_name, t.prompt_content FROM templates t
          WHERE t.id IN (${titleTemplateIds.map(() => '?').join(', ')}) AND t.status = 'enabled' AND t.deleted_at IS NULL`, titleTemplateIds);
        const templatesById = new Map(templates.map((template) => [Number(template.id), template]));
        selectedTemplates = titleTemplateIds.map((templateId) => templatesById.get(templateId)).filter(Boolean);
        if (selectedTemplates.length !== titleTemplateIds.length || selectedTemplates.some((template) => !template.prompt_content)) throw new Error('自动标题配置的默认提示词模板不存在、已停用或未填写内容。');
      }

      const imageUrls = [...new Set((Array.isArray(input.imageUrls) ? input.imageUrls : []).map((url) => String(url || '').trim())
        .filter((url) => /^https?:\/\//i.test(url)))].slice(0, 3);
      if (!imageUrls.length) throw new Error('当前商品没有可用图片，无法生成标题。');
      const endpoint = modelClient.chatEndpoint(provider);
      const content = [{
        type: 'text',
        text: `${selectedTemplates.map((template, index) => `【提示词模板 ${index + 1}：${template.template_name}】\n${template.prompt_content}`).join('\n\n')}\n\n请综合以上提示词，根据以下当前商品标题、商品类目和商品图片生成新的电商商品标题。仅返回最终标题文本，不要解释、引号、序号或 Markdown。\n当前商品类目：${categoryPath}\n当前商品标题：${currentTitle}`,
      }, ...imageUrls.map((url) => ({ type: 'image_url', image_url: { url } }))];
      try {
        const isZhipu = provider.provider_type === 'zhipu';
        generationRawData = { requests: [] };
        generationRecordId = await this.createAiGenerationRecord(connection, {
          userId, productId: id, productTitle: products[0].title || currentTitle, generationType: 'title',
          modelProviderId: titleModelProviderIds[0], modelName: provider.default_model,
          templates: selectedTemplates.map((template) => ({ id: Number(template.id), name: template.template_name })),
          inputSummary: { imageCount: imageUrls.length, categoryId: categoryId || null, categoryPath, templateSource }, rawData: generationRawData,
        });
        const requestResult = await this.requestWithModelFailover({
          provider,
          timeoutMs: modelTimeoutMs(provider),
          buildRequest: (model) => {
            const requestBody = { model, messages: [{ role: 'user', content }], temperature: 0.3, max_tokens: 10000,
              ...(isZhipu ? { thinking: { type: 'enabled', clear_thinking: true } } : {}) };
            return { endpoint, headers: { Authorization: `Bearer ${provider.api_key_value}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(requestBody), request: requestBody };
          },
          onAttempt: async ({ attempt, totalAttempts, endpoint: requestEndpoint, request }) => {
            generationRawData.requests.push({ attempt, totalAttempts, endpoint: requestEndpoint, method: 'POST', request, requestedAt: new Date().toISOString() });
            await this.updateAiGenerationRecord(connection, generationRecordId, { rawData: generationRawData });
          },
          onFailure: async ({ attempt, error }) => {
            const snapshot = generationRawData.requests[attempt - 1];
            if (snapshot) snapshot.error = String(error?.message || '模型调用失败').slice(0, 1000);
            await this.updateAiGenerationRecord(connection, generationRecordId, { rawData: generationRawData });
          },
        });
        const payload = requestResult.payload;
        const generatedTitle = chatCompletionText(payload).replace(/^['"“”]+|['"“”]+$/g, '').trim().slice(0, 1000);
        const reasoning = responseText(payload?.choices?.[0]?.message?.reasoning_content || payload?.choices?.[0]?.message?.reasoning);
        if (!generatedTitle) {
          throw new Error(reasoning ? '模型仅返回了推理内容，未输出最终标题；请重试，若持续出现请改用非推理模型。' : '模型未返回可用标题，请调整提示词模板后重试。');
        }
        const rawData = this.parseJsonColumn(products[0].raw_data, {});
        const detail = rawData._miaoshouDetail && typeof rawData._miaoshouDetail === 'object' && !Array.isArray(rawData._miaoshouDetail)
          ? rawData._miaoshouDetail : {};
        const multiLanguageTitleMap = detail.multiLanguageTitleMap && typeof detail.multiLanguageTitleMap === 'object' && !Array.isArray(detail.multiLanguageTitleMap)
          ? detail.multiLanguageTitleMap : {};
        rawData._miaoshouDetail = { ...detail, multiLanguageTitleMap: { ...multiLanguageTitleMap, en: generatedTitle } };
        const [saved] = await connection.execute(`UPDATE products
          SET generated_title = ?, raw_data = CAST(? AS JSON), updated_at = NOW() WHERE id = ? AND deleted_at IS NULL`, [generatedTitle, JSON.stringify(rawData), id]);
        if (!saved.affectedRows) throw new Error('商品不存在或已删除，无法保存生成标题。');
        await this.updateAiGenerationRecord(connection, generationRecordId, {
          status: 'succeeded', successCount: 1, outputSummary: { generatedTitle, englishTitle: generatedTitle, englishTitleUpdated: true, actualModel: requestResult.model, failoverAttempt: requestResult.attempt }, rawData: generationRawData, finished: true,
        });
        const failoverHint = requestResult.attempt > 1 ? `，已自动切换至备用模型 ${requestResult.model}` : '';
        return { ok: true, title: generatedTitle, englishTitle: generatedTitle, message: `已使用${provider.provider_name || '所选模型'}生成标题${failoverHint}，并已覆盖英语标题。`, saved: true };
      } finally { /* 模型客户端负责清理超时控制器。 */ }
    } catch (error) {
      if (connection && generationRecordId) {
        try {
          await this.updateAiGenerationRecord(connection, generationRecordId, {
            status: 'failed', failedCount: 1, errorMessage: error.message, rawData: generationRawData, finished: true,
          });
        } catch (_) { /* 生成原始异常优先返回 */ }
      }
      if (error?.code === 'MODEL_TIMEOUT') return { ok: false, code: 'MODEL_TITLE_TIMEOUT', message: '标题生成超时，请检查模型服务和网络。' };
      return { ok: false, code: error.code || 'MODEL_TITLE_ERROR', message: error.message || '标题生成失败。' };
    } finally { if (connection) await connection.end(); }
  }

  async generateProductImages(userId, productId, input = {}) {
    let connection;
    let generationRecordId = null;
    let generationRawData = { requests: [] };
    let generationRecordQueue = Promise.resolve();
    let statusStarted = false;
    let statusProductId = null;
    const controller = new AbortController();
    let timeout;
    let generationTimeoutMs = 300000;
    let progressProductId = null;
    const progressTaskId = String(input.taskId || '').trim();
    const taskKey = `${Number(userId)}:${Number(productId)}`;
    let taskControl = null;
    let previousProductStatus = null;
    const cancelledError = () => Object.assign(new Error('已取消生图任务。'), { code: 'TASK_CANCELLED' });
    const throwIfCancelled = () => { if (taskControl?.cancelled) throw cancelledError(); };
    const reportProgress = (progress) => {
      try { input.onProgress?.({ ...progress, productId: progressProductId, taskId: progressTaskId }); } catch (_) { /* 渲染窗口关闭不影响生图任务 */ }
    };
    try {
      const config = await this.getConfig();
      const appId = String(config.miaoshou.appId || '').trim();
      const id = Number(productId);
      if (!userId) throw new Error('请先登录本机用户。');
      if (!Number.isInteger(id) || id < 1) throw new Error('商品编号无效。');
      progressProductId = id;
      if (progressTaskId) {
        taskControl = { taskId: progressTaskId, controller, cancelled: false, generationRecordId: null };
        this.productImageTasks.set(taskKey, taskControl);
      }
      const imageUrls = [...new Set((Array.isArray(input.imageUrls) ? input.imageUrls : []).map((url) => String(url || '').trim())
        .filter((url) => /^https?:\/\//i.test(url)))].slice(0, 3);
      if (!imageUrls.length) throw new Error('当前商品没有可用图片，无法生图。');
      connection = await this.openConnection(config);
      await this.ensureAiGenerationRecordsTable(connection);
      await this.ensureSourceDetailColumns(connection);
      await this.ensureFieldMappingsTable(connection);
      await this.ensureAutomationOperationSettingsTable(connection, appId);
      await this.ensureAutomationOperationBindingsTable(connection, appId);
      await this.migrateAutomationOperationSettingsLegacyRelations(connection);
      // 手动生图和文件夹自动化生图都直接使用已绑定的模型、提示词；开关只决定自动化任务是否执行该步骤。
      const imageBindings = (await this.getAutomationOperationBindings(connection, userId)).filter((binding) => binding.operation_type === 'image');
      const imageTemplateIds = [...new Set(imageBindings.filter((binding) => binding.binding_type === 'template').map((binding) => binding.target_id)
        .map(Number).filter((templateId) => Number.isInteger(templateId) && templateId > 0))];
      const imageModelProviderIds = imageBindings.filter((binding) => binding.binding_type === 'model').map((binding) => Number(binding.target_id))
        .filter((providerId) => Number.isInteger(providerId) && providerId > 0);
      const [[imageSettings]] = await connection.execute(`SELECT prefer_category_image_templates
        FROM automation_operation_settings WHERE user_id = ? LIMIT 1`, [Number(userId)]);
      if (!imageModelProviderIds.length) throw new Error('请先在自动生成图片中选择大模型。');
      const [[provider]] = await connection.execute(`SELECT provider_name, provider_type, api_base_url, api_key_value, default_model, failover_models, timeout_seconds, image_adapter, image_size FROM model_providers
        WHERE id = ? AND is_enabled = 1 LIMIT 1`, [imageModelProviderIds[0]]);
      if (!provider?.api_base_url || !provider?.api_key_value || !provider?.default_model) throw new Error('自动生成图片所选大模型未配置完整，需填写 API Base URL、API Key 和默认模型。');
      if (provider.provider_type === 'zhipu') throw new Error('当前智谱适配仅支持对话模型；请在自动生成图片中选择支持 OpenAI Images 编辑接口的图片模型。');
      await this.ensureTemplateStorage(connection);
      const [products] = await connection.execute('SELECT id, title, product_status, ai_generated_image_urls, current_category_id FROM products WHERE id = ? AND deleted_at IS NULL LIMIT 1', [id]);
      if (!products.length) throw new Error('商品不存在或已删除。');
      let selectedTemplates = [];
      let templateSource = 'automation_config';
      const categoryId = Number(products[0].current_category_id);
      if (Number(imageSettings?.prefer_category_image_templates) === 1 && Number.isInteger(categoryId) && categoryId > 0) {
        const [categoryTemplates] = await connection.execute(`SELECT t.id, t.template_name, t.prompt_content
          FROM template_categories tc JOIN templates t ON t.id = tc.template_id
          WHERE tc.category_id = ? AND t.template_type IN ('image', 'category')
            AND t.status = 'enabled' AND t.deleted_at IS NULL AND t.prompt_content <> ''
          ORDER BY tc.created_at ASC, t.id ASC`, [categoryId]);
        if (categoryTemplates.length) {
          selectedTemplates = categoryTemplates;
          templateSource = 'category_binding';
        }
      }
      if (!selectedTemplates.length) {
        if (!imageTemplateIds.length) throw new Error('请在自动生成图片中至少配置一个默认提示词模板。');
        const placeholders = imageTemplateIds.map(() => '?').join(', ');
        const [templates] = await connection.execute(`SELECT t.id, t.template_name, t.prompt_content FROM templates t
          WHERE t.id IN (${placeholders}) AND t.status = 'enabled' AND t.deleted_at IS NULL`, imageTemplateIds);
        const templatesById = new Map(templates.map((template) => [Number(template.id), template]));
        selectedTemplates = imageTemplateIds.map((templateId) => templatesById.get(templateId)).filter(Boolean);
        if (selectedTemplates.length !== imageTemplateIds.length || selectedTemplates.some((template) => !template.prompt_content)) throw new Error('自动生成图片所选提示词模板不存在、已停用或未填写内容。');
      }
      previousProductStatus = products[0].product_status;
      generationRecordId = await this.createAiGenerationRecord(connection, {
        userId, productId: id, productTitle: products[0].title, generationType: 'product_image',
        modelProviderId: imageModelProviderIds[0], modelName: provider.default_model,
        templates: selectedTemplates.map((template) => ({ id: Number(template.id), name: template.template_name })),
        inputSummary: { imageCount: imageUrls.length, templateCount: selectedTemplates.length, templateSource, categoryId: Number.isInteger(categoryId) ? categoryId : null }, rawData: generationRawData,
      });
      if (taskControl) taskControl.generationRecordId = generationRecordId;
      throwIfCancelled();
      const saveGenerationRequest = (request) => {
        generationRawData.requests.push(request);
        const snapshot = JSON.parse(JSON.stringify(generationRawData));
        const write = generationRecordQueue.then(() => this.updateAiGenerationRecord(connection, generationRecordId, { rawData: snapshot }));
        generationRecordQueue = write.catch(() => {});
        return write;
      };
      await connection.execute(`UPDATE products SET product_status = 'image_processing', updated_at = NOW() WHERE id = ?`, [id]);
      statusStarted = true;
      statusProductId = id;
      let savedImageUrls = [...new Set(this.parseJsonColumn(products[0].ai_generated_image_urls, []).map((url) => String(url || '').trim()).filter(Boolean))];
      const initialImageUrlSet = new Set(savedImageUrls);
      let imageSaveQueue = Promise.resolve();
      const persistGeneratedImage = (imageUrl) => {
        const save = imageSaveQueue.then(async () => {
          if (savedImageUrls.includes(imageUrl)) return;
          const nextUrls = [...savedImageUrls, imageUrl];
          await connection.execute('UPDATE products SET ai_generated_image_urls = CAST(? AS JSON), updated_at = NOW() WHERE id = ?', [JSON.stringify(nextUrls), id]);
          savedImageUrls = nextUrls;
        });
        imageSaveQueue = save.catch(() => {});
        return save;
      };
      const workerCount = Math.min(3, selectedTemplates.length);
      reportProgress({ type: 'init', threadCount: workerCount, templateCount: selectedTemplates.length });
      reportProgress({ type: 'preparing', message: '正在准备商品参考图…' });

      const useSeedream = modelClient.imageAdapter(provider) === 'seedream_images';
      // 提示词模板并发执行，所有供应商共用单轮 500 秒超时，不按模板数量叠加。
      generationTimeoutMs = modelTimeoutMs(provider);
      timeout = setTimeout(() => controller.abort(), generationTimeoutMs);
      const oss = new OssClient(config.oss);
      const referenceImages = [];
      for (let index = 0; index < imageUrls.length; index += 1) {
        const source = await fetch(imageUrls[index], { signal: controller.signal });
        if (!source.ok) throw new Error(`下载第 ${index + 1} 张商品图片失败（HTTP ${source.status}）。`);
        const contentType = String(source.headers.get('content-type') || 'image/jpeg').split(';')[0].toLowerCase();
        if (!contentType.startsWith('image/')) throw new Error(`第 ${index + 1} 张商品图片不是图片文件。`);
        const buffer = Buffer.from(await source.arrayBuffer());
        const maxBytes = useSeedream ? 30 * 1024 * 1024 : 20 * 1024 * 1024;
        if (!buffer.length || buffer.length > maxBytes) throw new Error(`第 ${index + 1} 张商品图片为空或超过 ${useSeedream ? 30 : 20}MB。`);
        referenceImages.push({ buffer, contentType });
        throwIfCancelled();
      }
      const referenceUrls = [];
      if (useSeedream) {
        for (let index = 0; index < referenceImages.length; index += 1) {
          const uploaded = await oss.uploadGeneratedProductReferenceImage({ userId, productId: id, ...referenceImages[index], index });
          if (!uploaded.ok) throw new Error(uploaded.message);
          referenceUrls.push(uploaded.publicUrl);
          throwIfCancelled();
        }
      }
      // 参考图准备完成后，改由每个生图线程独立计时，避免单个慢请求拖垮已完成的结果。
      clearTimeout(timeout);
      timeout = undefined;
      const generateForTemplate = async (template, templateIndex, threadIndex) => {
        const taskController = new AbortController();
        const taskTimeout = setTimeout(() => taskController.abort(), generationTimeoutMs);
        const abortTask = () => taskController.abort();
        controller.signal.addEventListener('abort', abortTask, { once: true });
        try {
          const prompt = `【提示词模板：${template.template_name}】\n${template.prompt_content}\n\n请根据以上提示词，以输入的商品图片为主体和参考，生成一张适用于电商展示的新商品图片。保留商品关键外观，不要添加文字、水印或品牌标识。当前商品标题：${String(input.title || products[0].title || '').trim()}`;
        const requestResult = await this.requestWithModelFailover({
          provider, signal: taskController.signal, timeoutMs: generationTimeoutMs,
          buildRequest: (model) => {
            const endpoint = modelClient.imageEndpoint(provider);
            if (useSeedream) {
              const requestSnapshot = { model, prompt, image: referenceUrls, size: modelClient.imageSize(provider), output_format: 'png', response_format: 'url', watermark: false };
              return { endpoint, headers: { Authorization: `Bearer ${provider.api_key_value}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(requestSnapshot), request: requestSnapshot };
            }
            const form = new FormData(); form.append('model', model); form.append('prompt', prompt); form.append('size', modelClient.imageSize(provider));
            referenceImages.forEach(({ buffer, contentType }, index) => form.append('image', new Blob([buffer], { type: contentType }), `product-${index + 1}.${contentType.split('/')[1] || 'jpg'}`));
            const requestSnapshot = { model, prompt, size: modelClient.imageSize(provider), image: referenceImages.map(({ contentType }, index) => ({ sourceUrl: imageUrls[index], filename: `product-${index + 1}.${contentType.split('/')[1] || 'jpg'}`, contentType })) };
            return { endpoint, headers: { Authorization: `Bearer ${provider.api_key_value}`, Accept: 'application/json' }, body: form, request: requestSnapshot };
          },
          onAttempt: async ({ attempt, totalAttempts, endpoint, request }) => { try { await saveGenerationRequest({ attempt, totalAttempts, templateId: Number(template.id), templateName: template.template_name, endpoint, method: 'POST', request, requestedAt: new Date().toISOString() }); } catch (_) {} },
          onFailure: async ({ attempt, error }) => { const snapshot = generationRawData.requests.filter((item) => Number(item.templateId) === Number(template.id) && Number(item.attempt) === attempt).at(-1); if (snapshot) snapshot.error = String(error?.message || '模型调用失败').slice(0, 1000); },
        });
        const payload = requestResult.payload;
        throwIfCancelled();
        const generated = Array.isArray(payload?.data) ? payload.data : [];
        if (!generated.length) throw new Error('模型未返回图片数据，请检查所选模型是否支持图片编辑。');
        reportProgress({ type: 'thread', threadIndex, templateName: template.template_name, stage: 'uploading' });
        const templateImageUrls = [];
        for (let imageIndex = 0; imageIndex < generated.length; imageIndex += 1) {
          throwIfCancelled();
          const item = generated[imageIndex] || {};
          let buffer;
          let contentType = 'image/png';
          if (item.b64_json) buffer = Buffer.from(String(item.b64_json), 'base64');
          else if (item.url && /^https?:\/\//i.test(item.url)) {
            const generatedResponse = await fetch(item.url, { signal: taskController.signal });
            if (!generatedResponse.ok) throw new Error(`下载模型生成图片失败（HTTP ${generatedResponse.status}）。`);
            contentType = String(generatedResponse.headers.get('content-type') || contentType).split(';')[0].toLowerCase();
            buffer = Buffer.from(await generatedResponse.arrayBuffer());
          }
          if (!buffer?.length) throw new Error('模型返回的图片为空。');
          const uploaded = await oss.uploadGeneratedProductImage({ userId, productId: id, buffer, contentType, index: templateIndex * 100 + imageIndex });
          if (!uploaded.ok) throw new Error(uploaded.message);
          templateImageUrls.push(uploaded.publicUrl);
          await persistGeneratedImage(uploaded.publicUrl);
          reportProgress({ type: 'image', threadIndex, templateName: template.template_name, imageUrl: uploaded.publicUrl });
        }
        return { imageUrls: templateImageUrls, actualModel: requestResult.model, attempt: requestResult.attempt };
        } catch (error) {
          if (error?.code === 'MODEL_TIMEOUT' || error.name === 'AbortError') throw new Error(`图片生成超时（${Math.round(generationTimeoutMs / 1000)} 秒），请检查模型服务和网络。`);
          throw error;
        } finally {
          clearTimeout(taskTimeout);
          controller.signal.removeEventListener('abort', abortTask);
        }
      };
      const taskResults = Array(selectedTemplates.length);
      let nextTemplateIndex = 0;
      const worker = async (threadIndex) => {
        while (nextTemplateIndex < selectedTemplates.length && !controller.signal.aborted) {
          const templateIndex = nextTemplateIndex;
          nextTemplateIndex += 1;
          const template = selectedTemplates[templateIndex];
          const maxAttempts = this.providerModelCandidates(provider).length;
          try {
            reportProgress({ type: 'thread', threadIndex, templateIndex, templateName: template.template_name, stage: 'generating', attempt: 1, maxAttempts });
            const generated = await generateForTemplate(template, templateIndex, threadIndex);
            taskResults[templateIndex] = { templateName: template.template_name, imageUrls: generated.imageUrls, actualModel: generated.actualModel };
            reportProgress({ type: 'thread', threadIndex, templateIndex, templateName: template.template_name, stage: 'success', attempt: generated.attempt, maxAttempts });
          } catch (error) {
            if (taskControl?.cancelled) { reportProgress({ type: 'thread', threadIndex, templateIndex, templateName: template.template_name, stage: 'cancelled', attempt: 1, maxAttempts, message: '已取消' }); return; }
            taskResults[templateIndex] = { templateName: template.template_name, error: error.message || '未知错误' };
            reportProgress({ type: 'thread', threadIndex, templateIndex, templateName: template.template_name, stage: 'error', attempt: maxAttempts, maxAttempts, message: taskResults[templateIndex].error });
          }
        }
      };
      await Promise.all(Array.from({ length: workerCount }, (_unused, index) => worker(index)));
      await imageSaveQueue;
      throwIfCancelled();
      const failures = taskResults.filter((result) => result?.error);
      const newImageUrls = savedImageUrls.filter((url) => !initialImageUrlSet.has(url));
      if (!newImageUrls.length) throw new Error(failures.map((result) => `“${result.templateName}”：${result.error}`).join('；') || '图片模型未返回可用图片。');
      const partialHint = failures.length ? `；${failures.length} 个模板失败：${failures.map((result) => result.templateName).join('、')}` : '';
      await connection.execute(`UPDATE products SET product_status = 'ai_image_completed', updated_at = NOW() WHERE id = ?`, [id]);
      await generationRecordQueue;
      await this.updateAiGenerationRecord(connection, generationRecordId, {
        status: failures.length ? 'partial_failed' : 'succeeded', successCount: selectedTemplates.length - failures.length, failedCount: failures.length,
        errorMessage: failures.length ? failures.map((result) => `${result.templateName}：${result.error}`).join('；') : null,
        outputSummary: { generatedImageUrls: newImageUrls, generatedImageCount: newImageUrls.length, failedTemplates: failures.filter((result) => result?.error) }, rawData: generationRawData, finished: true,
      });
      return { ok: true, imageUrls: savedImageUrls, newImageUrls, failedTemplateCount: failures.length, message: `已生成并保存 ${newImageUrls.length} 张 AI 图片${partialHint}。` };
    } catch (error) {
      if (taskControl?.cancelled || error?.code === 'TASK_CANCELLED') {
        if (statusStarted && connection && statusProductId) {
          try { await connection.execute('UPDATE products SET product_status = ?, updated_at = NOW() WHERE id = ?', [previousProductStatus || 'draft', statusProductId]); } catch (_) { /* 取消后尽力恢复原状态 */ }
        }
        if (connection && generationRecordId) {
          try {
            await generationRecordQueue;
            await this.updateAiGenerationRecord(connection, generationRecordId, { status: 'cancelled', errorMessage: '用户已取消生图任务。', rawData: generationRawData, finished: true });
          } catch (_) { /* 取消结果不应被记录失败覆盖 */ }
        }
        return { ok: false, cancelled: true, code: 'TASK_CANCELLED', message: '已取消生图任务；已生成并上传的图片已保留。' };
      }
      if (statusStarted && connection && statusProductId) {
        try { await connection.execute(`UPDATE products SET product_status = 'failed', updated_at = NOW() WHERE id = ?`, [statusProductId]); } catch (_) { /* 保留原始生图错误 */ }
      }
      if (connection && generationRecordId) {
        try {
          await generationRecordQueue;
          await this.updateAiGenerationRecord(connection, generationRecordId, { status: 'failed', failedCount: 1, errorMessage: error.message, rawData: generationRawData, finished: true });
        } catch (_) { /* 生成原始异常优先返回 */ }
      }
      if (error.name === 'AbortError') return { ok: false, code: 'MODEL_IMAGE_TIMEOUT', message: `图片生成超时（${Math.round(generationTimeoutMs / 1000)} 秒），请检查模型服务和网络。` };
      return { ok: false, code: error.code || 'MODEL_IMAGE_ERROR', message: error.message || '图片生成失败。' };
    } finally {
      clearTimeout(timeout);
      if (taskControl && this.productImageTasks.get(taskKey) === taskControl) this.productImageTasks.delete(taskKey);
      if (connection) await connection.end();
    }
  }

  async cancelProductImageGeneration(userId, productId, taskId) {
    const userIdNumber = Number(userId);
    const productIdNumber = Number(productId);
    const safeTaskId = String(taskId || '').trim();
    if (!Number.isInteger(userIdNumber) || userIdNumber < 1 || !Number.isInteger(productIdNumber) || productIdNumber < 1 || !safeTaskId) {
      return { ok: false, code: 'VALIDATION_ERROR', message: '取消生图任务参数无效。' };
    }
    const task = this.productImageTasks.get(`${userIdNumber}:${productIdNumber}`);
    if (!task || task.taskId !== safeTaskId) return { ok: false, code: 'TASK_NOT_RUNNING', message: '该生图任务已结束或不在当前应用进程中。' };
    if (task.cancelled) return { ok: true, message: '正在取消生图任务。' };
    task.cancelled = true;
    task.controller.abort();
    return { ok: true, message: '已请求取消生图任务。' };
  }

  async generateProductSkuImages(userId, productId, input = {}) {
    let connection;
    let generationRecordId = null;
    let generationRawData = { requests: [] };
    let generationRecordQueue = Promise.resolve();
    let statusStarted = false;
    let statusProductId = null;
    const taskId = String(input.taskId || '').trim();
    const report = (progress) => { try { input.onProgress?.({ ...progress, productId: Number(productId), taskId, generationKind: 'sku' }); } catch (_) {} };
    try {
      const config = await this.getConfig();
      const appId = String(config.miaoshou.appId || '').trim();
      const id = Number(productId);
      if (!userId) throw new Error('请先登录本机用户。');
      if (!Number.isInteger(id) || id < 1) throw new Error('商品编号无效。');
      const skus = (Array.isArray(input.skus) ? input.skus : []).map((sku) => ({
        skuIndex: Number(sku?.skuIndex), skuKey: String(sku?.skuKey || ''), imageUrl: String(sku?.imageUrl || '').trim(),
      })).filter((sku) => Number.isInteger(sku.skuIndex) && sku.skuIndex >= 0 && /^https?:\/\//i.test(sku.imageUrl));
      if (!skus.length) throw new Error('当前 SKU 没有可用图片，无法生成 SKU 图。');
      connection = await this.openConnection(config);
      await this.ensureAiGenerationRecordsTable(connection);
      await this.ensureFieldMappingsTable(connection);
      await this.ensureAutomationOperationSettingsTable(connection, appId);
      await this.ensureAutomationOperationBindingsTable(connection, appId);
      await this.ensureProductSkuGeneratedImagesTable(connection);
      const bindings = (await this.getAutomationOperationBindings(connection, userId)).filter((binding) => binding.operation_type === 'sku_image');
      const templateIds = [...new Set(bindings.filter((binding) => binding.binding_type === 'template').map((binding) => Number(binding.target_id)).filter((id) => id > 0))];
      const providerId = Number(bindings.find((binding) => binding.binding_type === 'model')?.target_id);
      if (!templateIds.length || !providerId) throw new Error('请先在自动生成 SKU 图中选择提示词模板和大模型。');
      const [[provider]] = await connection.execute(`SELECT id, provider_name, provider_type, api_base_url, api_key_value, default_model, failover_models, timeout_seconds, image_adapter, image_size FROM model_providers WHERE id = ? AND is_enabled = 1 LIMIT 1`, [providerId]);
      if (!provider?.api_base_url || !provider?.api_key_value || !provider?.default_model) throw new Error('自动生成 SKU 图所选大模型未配置完整。');
      if (provider.provider_type === 'zhipu') throw new Error('当前智谱适配仅支持对话模型；请为自动生成 SKU 图选择图片模型。');
      await this.ensureTemplateStorage(connection);
      const [templates] = await connection.execute(`SELECT t.id, t.template_name, t.prompt_content FROM templates t WHERE t.id IN (${templateIds.map(() => '?').join(', ')}) AND t.status = 'enabled' AND t.deleted_at IS NULL`, templateIds);
      const templatesById = new Map(templates.map((template) => [Number(template.id), template]));
      const selectedTemplates = templateIds.map((id) => templatesById.get(id)).filter(Boolean);
      if (selectedTemplates.length !== templateIds.length || selectedTemplates.some((template) => !template.prompt_content)) throw new Error('自动生成 SKU 图的提示词模板不存在、已停用或未填写内容。');
      const [[product]] = await connection.execute('SELECT id, title FROM products WHERE id = ? AND deleted_at IS NULL LIMIT 1', [id]);
      if (!product) throw new Error('商品不存在或已删除。');
      generationRecordId = await this.createAiGenerationRecord(connection, {
        userId, productId: id, productTitle: product.title, generationType: 'sku_image', modelProviderId: providerId, modelName: provider.default_model,
        templates: selectedTemplates.map((template) => ({ id: Number(template.id), name: template.template_name })),
        inputSummary: { skuCount: skus.length, templateCount: selectedTemplates.length, jobCount: skus.length * selectedTemplates.length }, rawData: generationRawData,
      });
      const saveGenerationRequest = (request) => {
        generationRawData.requests.push(request);
        const snapshot = JSON.parse(JSON.stringify(generationRawData));
        const write = generationRecordQueue.then(() => this.updateAiGenerationRecord(connection, generationRecordId, { rawData: snapshot }));
        generationRecordQueue = write.catch(() => {});
        return write;
      };
      await connection.execute(`UPDATE products SET product_status = 'image_processing', updated_at = NOW() WHERE id = ?`, [id]);
      statusStarted = true;
      statusProductId = id;
      const jobs = skus.flatMap((sku) => selectedTemplates.map((template) => ({ sku, template })));
      const workerCount = Math.min(3, jobs.length);
      report({ type: 'init', threadCount: workerCount, templateCount: jobs.length });
      const oss = new OssClient(config.oss);
      const useSeedream = modelClient.imageAdapter(provider) === 'seedream_images';
      const generatedImages = [];
      const results = Array(jobs.length);
      let nextJob = 0;
      const generate = async (job, jobIndex, threadIndex) => {
        const timeoutMs = modelTimeoutMs(provider);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const source = await fetch(job.sku.imageUrl, { signal: controller.signal });
          if (!source.ok) throw new Error(`下载 SKU ${job.sku.skuIndex + 1} 图片失败（HTTP ${source.status}）。`);
          const contentType = String(source.headers.get('content-type') || 'image/jpeg').split(';')[0].toLowerCase();
          const buffer = Buffer.from(await source.arrayBuffer());
          const maxBytes = useSeedream ? 30 * 1024 * 1024 : 20 * 1024 * 1024;
          if (!contentType.startsWith('image/') || !buffer.length || buffer.length > maxBytes) throw new Error(`SKU ${job.sku.skuIndex + 1} 图片无效或超过大小限制。`);
          const prompt = `【提示词模板：${job.template.template_name}】\n${job.template.prompt_content}\n\n请以输入的 SKU 图片为唯一商品参考，生成适用于电商 SKU 展示的新图片。保持该 SKU 的颜色、款式、材质、尺寸比例和细节，不要添加文字、水印、品牌标识或其他商品。商品标题：${String(input.title || product.title || '').trim()}；SKU：${job.sku.skuKey || `第 ${job.sku.skuIndex + 1} 项`}`;
          let referenceUrl = null;
          if (useSeedream) {
            const uploaded = await oss.uploadGeneratedProductReferenceImage({ userId, productId: id, buffer, contentType, index: job.sku.skuIndex });
            if (!uploaded.ok) throw new Error(uploaded.message);
            referenceUrl = uploaded.publicUrl;
          }
          const requestResult = await this.requestWithModelFailover({
            provider, signal: controller.signal, timeoutMs,
            buildRequest: (model) => {
              const endpoint = modelClient.imageEndpoint(provider);
              if (useSeedream) {
                const requestSnapshot = { model, prompt, image: [referenceUrl], size: modelClient.imageSize(provider), output_format: 'png', response_format: 'url', watermark: false };
                return { endpoint, headers: { Authorization: `Bearer ${provider.api_key_value}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(requestSnapshot), request: requestSnapshot };
              }
              const form = new FormData(); form.append('model', model); form.append('prompt', prompt); form.append('size', modelClient.imageSize(provider)); form.append('image', new Blob([buffer], { type: contentType }), `sku-${job.sku.skuIndex + 1}.${contentType.split('/')[1] || 'jpg'}`);
              const requestSnapshot = { model, prompt, size: modelClient.imageSize(provider), image: [{ sourceUrl: job.sku.imageUrl, filename: `sku-${job.sku.skuIndex + 1}.${contentType.split('/')[1] || 'jpg'}`, contentType }] };
              return { endpoint, headers: { Authorization: `Bearer ${provider.api_key_value}`, Accept: 'application/json' }, body: form, request: requestSnapshot };
            },
            onAttempt: async ({ attempt, totalAttempts, endpoint, request }) => { try { await saveGenerationRequest({ attempt, totalAttempts, skuIndex: job.sku.skuIndex, skuKey: job.sku.skuKey || null, templateId: Number(job.template.id), templateName: job.template.template_name, endpoint, method: 'POST', request, requestedAt: new Date().toISOString() }); } catch (_) {} },
            onFailure: async ({ attempt, error }) => { const snapshot = generationRawData.requests.filter((item) => Number(item.skuIndex) === Number(job.sku.skuIndex) && Number(item.templateId) === Number(job.template.id) && Number(item.attempt) === attempt).at(-1); if (snapshot) snapshot.error = String(error?.message || '模型调用失败').slice(0, 1000); },
          });
          const data = requestResult.payload;
          if (!Array.isArray(data?.data) || !data.data.length) throw new Error('模型未返回图片数据。');
          report({ type: 'thread', threadIndex, templateIndex: jobIndex, templateName: `SKU ${job.sku.skuIndex + 1} · ${job.template.template_name}`, stage: 'uploading' });
          const saved = [];
          for (let imageIndex = 0; imageIndex < data.data.length; imageIndex += 1) {
            const item = data.data[imageIndex] || {}; let imageBuffer; let imageType = 'image/png';
            if (item.b64_json) imageBuffer = Buffer.from(String(item.b64_json), 'base64');
            else if (item.url && /^https?:\/\//i.test(item.url)) { const generated = await fetch(item.url, { signal: controller.signal }); if (!generated.ok) throw new Error(`下载模型生成图片失败（HTTP ${generated.status}）。`); imageType = String(generated.headers.get('content-type') || imageType).split(';')[0]; imageBuffer = Buffer.from(await generated.arrayBuffer()); }
            if (!imageBuffer?.length) throw new Error('模型返回的图片为空。');
            const uploaded = await oss.uploadGeneratedProductImage({ userId, productId: id, buffer: imageBuffer, contentType: imageType, index: jobIndex * 100 + imageIndex });
            if (!uploaded.ok) throw new Error(uploaded.message);
            const [inserted] = await connection.execute(`INSERT INTO product_sku_generated_images (product_id, sku_index, image_url, template_id, model_provider_id) VALUES (?, ?, ?, ?, ?)`, [id, job.sku.skuIndex, uploaded.publicUrl, Number(job.template.id), providerId]);
            const candidate = { id: inserted.insertId, sku_index: job.sku.skuIndex, image_url: uploaded.publicUrl, template_id: Number(job.template.id), model_provider_id: providerId };
            generatedImages.push(candidate); saved.push(candidate);
            report({ type: 'image', threadIndex, templateIndex: jobIndex, templateName: `SKU ${job.sku.skuIndex + 1} · ${job.template.template_name}`, candidate });
          }
          return { saved, actualModel: requestResult.model, attempt: requestResult.attempt };
        } catch (error) { if (error?.code === 'MODEL_TIMEOUT' || error.name === 'AbortError') throw new Error(`图片生成超时（${Math.round(timeoutMs / 1000)} 秒），请检查模型服务和网络。`); throw error; }
        finally { clearTimeout(timeout); }
      };
      const worker = async (threadIndex) => {
        while (nextJob < jobs.length) {
          const jobIndex = nextJob++; const job = jobs[jobIndex]; const maxAttempts = this.providerModelCandidates(provider).length;
          try { report({ type: 'thread', threadIndex, templateIndex: jobIndex, templateName: `SKU ${job.sku.skuIndex + 1} · ${job.template.template_name}`, stage: 'generating', attempt: 1, maxAttempts }); const generated = await generate(job, jobIndex, threadIndex); results[jobIndex] = { actualModel: generated.actualModel }; report({ type: 'thread', threadIndex, templateIndex: jobIndex, templateName: `SKU ${job.sku.skuIndex + 1} · ${job.template.template_name}`, stage: 'success', attempt: generated.attempt, maxAttempts }); }
          catch (caught) { results[jobIndex] = { error: caught.message || '未知错误' }; report({ type: 'thread', threadIndex, templateIndex: jobIndex, templateName: `SKU ${job.sku.skuIndex + 1} · ${job.template.template_name}`, stage: 'error', attempt: maxAttempts, maxAttempts, message: results[jobIndex].error }); }
        }
      };
      await Promise.all(Array.from({ length: workerCount }, (_unused, index) => worker(index)));
      if (!generatedImages.length) throw new Error(results.filter((result) => result?.error).map((result) => result.error).join('；') || 'SKU 图片模型未返回可用图片。');
      const failedCount = results.filter((result) => result?.error).length;
      await connection.execute(`UPDATE products SET product_status = 'sku_image_completed', updated_at = NOW() WHERE id = ?`, [id]);
      await generationRecordQueue;
      await this.updateAiGenerationRecord(connection, generationRecordId, {
        status: failedCount ? 'partial_failed' : 'succeeded', successCount: jobs.length - failedCount, failedCount,
        errorMessage: failedCount ? results.filter((result) => result?.error).map((result) => result.error).join('；') : null,
        outputSummary: { generatedImages, generatedImageCount: generatedImages.length, jobCount: jobs.length }, rawData: generationRawData, finished: true,
      });
      return { ok: true, generatedImages, failedTemplateCount: failedCount, message: `已生成并保存 ${generatedImages.length} 张 SKU 候选图${failedCount ? `；${failedCount} 个任务失败` : ''}。` };
    } catch (error) {
      if (statusStarted && connection && statusProductId) {
        try { await connection.execute(`UPDATE products SET product_status = 'failed', updated_at = NOW() WHERE id = ?`, [statusProductId]); } catch (_) { /* 保留原始生图错误 */ }
      }
      if (connection && generationRecordId) {
        try {
          await generationRecordQueue;
          await this.updateAiGenerationRecord(connection, generationRecordId, { status: 'failed', failedCount: 1, errorMessage: error.message, rawData: generationRawData, finished: true });
        } catch (_) { /* 生成原始异常优先返回 */ }
      }
      return { ok: false, code: error.code || 'MODEL_SKU_IMAGE_ERROR', message: error.message || 'SKU 图片生成失败。', generatedImages: [] };
    }
    finally { if (connection) await connection.end(); }
  }

  async ensureCategoryTables(connection) {
    await connection.query(`CREATE TABLE IF NOT EXISTS category_versions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, platform_code VARCHAR(32) NOT NULL, source_name VARCHAR(64) NOT NULL DEFAULT 'miaoshou',
      version_no VARCHAR(64) NOT NULL, source_updated_at DATETIME NULL, imported_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      is_active TINYINT UNSIGNED NOT NULL DEFAULT 0, import_summary JSON NULL, created_by BIGINT UNSIGNED NULL,
      PRIMARY KEY (id), UNIQUE KEY uk_category_versions_platform_version (platform_code, version_no), KEY idx_category_versions_active (platform_code, is_active)
    ) ENGINE=InnoDB COMMENT='类目导入版本'`);
    await connection.query(`CREATE TABLE IF NOT EXISTS categories (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, category_version_id BIGINT UNSIGNED NOT NULL, external_category_id VARCHAR(128) NOT NULL,
      parent_external_category_id VARCHAR(128) NULL, category_name VARCHAR(255) NOT NULL, full_path VARCHAR(2000) NULL,
      tree_level INT UNSIGNED NOT NULL DEFAULT 1, is_leaf TINYINT UNSIGNED NOT NULL DEFAULT 0, status TINYINT UNSIGNED NOT NULL DEFAULT 1,
      raw_data JSON NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id), UNIQUE KEY uk_categories_version_external (category_version_id, external_category_id), KEY idx_categories_parent (category_version_id, parent_external_category_id), KEY idx_categories_name (category_name)
    ) ENGINE=InnoDB COMMENT='平台类目'`);
  }

  async ensureTemuFullCategoryVersion(connection) {
    await this.ensureCategoryTables(connection);
    await connection.execute(`INSERT IGNORE INTO category_versions (platform_code, source_name, version_no, is_active, import_summary)
      VALUES ('temu_full', 'miaoshou_pddkj_category_tree', 'live', 1, CAST(? AS JSON))`, [JSON.stringify({ platform: 'TEMU', publish_mode: 'full_managed', description: '妙手 Temu 全托类目树' })]);
    const [versions] = await connection.execute(`SELECT id FROM category_versions
      WHERE platform_code = 'temu_full' AND version_no = 'live' LIMIT 1`);
    return versions[0].id;
  }

  flattenTemuFullCategoryTree(tree) {
    const nodes = [];
    const visit = (items, parentExternalId = null, parentPath = '', level = 1) => {
      for (const item of Object.values(items || {})) {
        if (!item || typeof item !== 'object' || item.cid === undefined || item.cid === null) continue;
        const externalId = String(item.cid);
        const categoryName = String(item.nameChinese || item.name || '').trim();
        if (!categoryName) continue;
        const children = item.children && typeof item.children === 'object' ? item.children : {};
        const childItems = Object.values(children).filter((child) => child && typeof child === 'object');
        const fullPath = parentPath ? `${parentPath} / ${categoryName}` : categoryName;
        const { children: _children, ...rawData } = item;
        nodes.push({
          externalId,
          parentExternalId,
          categoryName,
          fullPath,
          level,
          isLeaf: String(item.isLastLevel) === '1' || childItems.length === 0,
          rawData: { source: 'miaoshou_pddkj_category_tree', platform_code: 'temu_full', ...rawData },
        });
        visit(children, externalId, fullPath, level + 1);
      }
    };
    visit(tree);
    return nodes;
  }

  async syncTemuFullCategories() {
    let connection;
    try {
      const config = await this.getConfig();
      const client = new MiaoshouClient(config.miaoshou);
      const tree = await client.getPlatformCategoryTree('pddkj');
      const categories = this.flattenTemuFullCategoryTree(tree);
      if (!categories.length) throw new Error('妙手返回的 Temu 全托类目为空。');
      connection = await this.openConnection(config);
      const versionId = await this.ensureTemuFullCategoryVersion(connection);
      await connection.beginTransaction();
      await connection.execute('UPDATE categories SET status = 0, updated_at = NOW() WHERE category_version_id = ?', [versionId]);
      const chunkSize = 250;
      for (let offset = 0; offset < categories.length; offset += chunkSize) {
        const chunk = categories.slice(offset, offset + chunkSize);
        const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))').join(',');
        const values = chunk.flatMap((category) => [versionId, category.externalId, category.parentExternalId, category.categoryName,
          category.fullPath, category.level, category.isLeaf ? 1 : 0, JSON.stringify(category.rawData)]);
        await connection.execute(`INSERT INTO categories (category_version_id, external_category_id, parent_external_category_id, category_name, full_path, tree_level, is_leaf, raw_data)
          VALUES ${placeholders}
          ON DUPLICATE KEY UPDATE parent_external_category_id = VALUES(parent_external_category_id), category_name = VALUES(category_name),
            full_path = VALUES(full_path), tree_level = VALUES(tree_level), is_leaf = VALUES(is_leaf), status = 1, raw_data = VALUES(raw_data), updated_at = NOW()`, values);
      }
      const leafCount = categories.filter((category) => category.isLeaf).length;
      await connection.execute(`UPDATE category_versions SET imported_at = NOW(), is_active = 1, import_summary = CAST(? AS JSON)
        WHERE id = ?`, [JSON.stringify({ platform: 'TEMU', publish_mode: 'full_managed', total_count: categories.length, leaf_count: leafCount }), versionId]);
      await connection.commit();
      return { ok: true, totalCount: categories.length, leafCount, message: `Temu 全托类目已同步：${categories.length} 条，末级类目 ${leafCount} 条。` };
    } catch (error) {
      if (connection) { try { await connection.rollback(); } catch (_) { /* transaction may not have started */ } }
      return { ok: false, code: error.code || 'TEMU_FULL_CATEGORY_SYNC_ERROR', message: error.message };
    } finally { if (connection) await connection.end(); }
  }

  categorySegment(category, index) {
    if (category && typeof category === 'object') {
      const name = category.name || category.categoryName || category.cateName || category.title || category.label || category.value;
      const sourceId = category.categoryId || category.cateId || category.id || category.value;
      return { name: String(name || '').trim(), sourceId: sourceId ? String(sourceId) : '' };
    }
    return { name: String(category || '').trim(), sourceId: '' };
  }

  async ensureTargetStoreCategoryVersion(connection) {
    await this.ensureCategoryTables(connection);
    await connection.execute(`INSERT IGNORE INTO category_versions (platform_code, source_name, version_no, is_active, import_summary)
      VALUES ('miaoshou_store', 'miaoshou_target_store_collect_box', 'live', 1, CAST(? AS JSON))`, [JSON.stringify({ description: '妙手目标店铺采集箱类目归档' })]);
    const [versions] = await connection.execute(`SELECT id FROM category_versions
      WHERE platform_code = 'miaoshou_store' AND version_no = 'live' LIMIT 1`);
    return versions[0].id;
  }

  async upsertTargetStoreCategoryPath(connection, cateList) {
    const pathItems = (Array.isArray(cateList) ? cateList : []).map((category, index) => this.categorySegment(category, index)).filter((category) => category.name);
    if (!pathItems.length) return null;
    const versionId = await this.ensureTargetStoreCategoryVersion(connection);
    const title = pathItems.map((category) => category.name).join(' / ');
    const hash = crypto.createHash('sha1').update(title, 'utf8').digest('hex');
    const externalId = `miaoshou_store_flat_${hash}`;
    await connection.execute(`INSERT INTO categories (category_version_id, external_category_id, parent_external_category_id, category_name, full_path, tree_level, is_leaf, raw_data)
      VALUES (?, ?, NULL, ?, ?, 1, 1, CAST(? AS JSON))
      ON DUPLICATE KEY UPDATE parent_external_category_id = NULL, category_name = VALUES(category_name),
        full_path = VALUES(full_path), tree_level = 1, is_leaf = 1, status = 1, raw_data = VALUES(raw_data), updated_at = NOW()`, [
      versionId, externalId, title, title,
      JSON.stringify({ source: 'miaoshou_target_store_collect_box', source_category_list: cateList, title }),
    ]);
    const [rows] = await connection.execute('SELECT id FROM categories WHERE category_version_id = ? AND external_category_id = ? LIMIT 1', [versionId, externalId]);
    return rows[0].id;
  }

  async ensureManualCategoryVersion(connection) {
    await this.ensureCategoryTables(connection);
    await connection.execute(`INSERT IGNORE INTO category_versions (platform_code, source_name, version_no, is_active, import_summary)
      VALUES ('manual', 'manual_category', 'live', 1, CAST(? AS JSON))`, [JSON.stringify({ description: '用户手动维护的本地类目' })]);
    const [versions] = await connection.execute(`SELECT id FROM category_versions
      WHERE platform_code = 'manual' AND version_no = 'live' LIMIT 1`);
    return versions[0].id;
  }

  normalizeCategoryTitle(title) {
    return String(title || '').replace(/\s+/g, ' ').trim();
  }

  async createManualCategory(categoryName) {
    let connection;
    try {
      const title = this.normalizeCategoryTitle(categoryName);
      if (!title) return { ok: false, code: 'VALIDATION_ERROR', message: '请填写类目名称。' };
      if (title.length > 255) return { ok: false, code: 'VALIDATION_ERROR', message: '类目名称不能超过 255 个字符。' };
      connection = await this.openConnection(await this.getConfig());
      const [existing] = await connection.execute(`SELECT c.id FROM categories c JOIN category_versions cv ON cv.id = c.category_version_id
        WHERE c.category_name = ? AND c.status = 1 AND cv.is_active = 1 LIMIT 1`, [title]);
      if (existing.length) return { ok: false, code: 'DUPLICATE_CATEGORY', message: '同名类目已存在。' };
      const versionId = await this.ensureManualCategoryVersion(connection);
      const externalId = `manual_${crypto.createHash('sha1').update(title, 'utf8').digest('hex')}`;
      const [result] = await connection.execute(`INSERT INTO categories (category_version_id, external_category_id, parent_external_category_id, category_name, full_path, tree_level, is_leaf, raw_data)
        VALUES (?, ?, NULL, ?, ?, 1, 1, CAST(? AS JSON))`, [versionId, externalId, title, title, JSON.stringify({ source: 'manual_category', title })]);
      return { ok: true, id: result.insertId, message: '类目已创建。' };
    } catch (error) {
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message };
    } finally { if (connection) await connection.end(); }
  }

  async updateCategory(categoryId, categoryName) {
    let connection;
    try {
      const id = Number(categoryId);
      const title = this.normalizeCategoryTitle(categoryName);
      if (!Number.isInteger(id) || id <= 0) return { ok: false, code: 'VALIDATION_ERROR', message: '类目 ID 无效。' };
      if (!title) return { ok: false, code: 'VALIDATION_ERROR', message: '请填写类目名称。' };
      if (title.length > 255) return { ok: false, code: 'VALIDATION_ERROR', message: '类目名称不能超过 255 个字符。' };
      connection = await this.openConnection(await this.getConfig());
      const [existing] = await connection.execute('SELECT id FROM categories WHERE id = ? LIMIT 1', [id]);
      if (!existing.length) return { ok: false, code: 'NOT_FOUND', message: '类目不存在或已被删除。' };
      const [duplicate] = await connection.execute(`SELECT c.id FROM categories c JOIN category_versions cv ON cv.id = c.category_version_id
        WHERE c.category_name = ? AND c.status = 1 AND cv.is_active = 1 AND c.id <> ? LIMIT 1`, [title, id]);
      if (duplicate.length) return { ok: false, code: 'DUPLICATE_CATEGORY', message: '同名类目已存在。' };
      await connection.execute('UPDATE categories SET category_name = ?, full_path = ?, parent_external_category_id = NULL, tree_level = 1, is_leaf = 1, updated_at = NOW() WHERE id = ?', [title, title, id]);
      return { ok: true, id, message: '类目已更新。' };
    } catch (error) {
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message };
    } finally { if (connection) await connection.end(); }
  }

  async deleteCategory(categoryId) {
    let connection;
    try {
      const id = Number(categoryId);
      if (!Number.isInteger(id) || id <= 0) return { ok: false, code: 'VALIDATION_ERROR', message: '类目 ID 无效。' };
      connection = await this.openConnection(await this.getConfig());
      const [result] = await connection.execute('DELETE FROM categories WHERE id = ?', [id]);
      if (!result.affectedRows) return { ok: false, code: 'NOT_FOUND', message: '类目不存在或已被删除。' };
      return { ok: true, id, message: '类目已删除。' };
    } catch (error) {
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message };
    } finally { if (connection) await connection.end(); }
  }

  async ensureModelProvidersTable(connection, config) {
    const [existingTables] = await connection.query("SHOW TABLES LIKE 'model_providers'");
    const tableAlreadyExists = existingTables.length > 0;
    await connection.query(`CREATE TABLE IF NOT EXISTS model_providers (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, provider_name VARCHAR(128) NOT NULL, provider_type VARCHAR(32) NOT NULL DEFAULT 'openai_compatible',
      api_base_url VARCHAR(1000) NULL, api_key_value TEXT NULL, default_model VARCHAR(255) NULL, model_catalog JSON NULL, failover_models JSON NULL, timeout_seconds INT UNSIGNED NOT NULL DEFAULT 300, test_adapter VARCHAR(32) NOT NULL DEFAULT 'auto', image_adapter VARCHAR(64) NOT NULL DEFAULT 'openai_images_edits', image_size VARCHAR(64) NULL,
      remark VARCHAR(500) NULL, is_enabled TINYINT UNSIGNED NOT NULL DEFAULT 1, is_active TINYINT UNSIGNED NOT NULL DEFAULT 0,
      sort_order INT NOT NULL DEFAULT 0, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id), UNIQUE KEY uk_model_providers_name (provider_name), KEY idx_model_providers_active (is_active, is_enabled, sort_order)
    ) ENGINE=InnoDB COMMENT='大模型供应商配置'`);
    if (!tableAlreadyExists) {
      const image = mergeConfig(config).image;
      await connection.execute('INSERT INTO model_providers (provider_name, provider_type, api_base_url, api_key_value, default_model, model_catalog, is_active) VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), 1)', [
        image.provider || '默认模型服务', 'openai_compatible', image.apiBaseUrl || null, image.apiKey || null, image.model || 'gpt-image-2', JSON.stringify(image.model ? [image.model] : []),
      ]);
    }
    const [columns] = await connection.query("SHOW COLUMNS FROM model_providers LIKE 'failover_models'");
    if (!columns.length) await connection.query('ALTER TABLE model_providers ADD COLUMN failover_models JSON NULL AFTER model_catalog');
    const [timeoutColumns] = await connection.query("SHOW COLUMNS FROM model_providers LIKE 'timeout_seconds'");
    if (!timeoutColumns.length) await connection.query('ALTER TABLE model_providers ADD COLUMN timeout_seconds INT UNSIGNED NOT NULL DEFAULT 300 AFTER failover_models');
    const [testAdapterColumns] = await connection.query("SHOW COLUMNS FROM model_providers LIKE 'test_adapter'");
    if (!testAdapterColumns.length) await connection.query("ALTER TABLE model_providers ADD COLUMN test_adapter VARCHAR(32) NOT NULL DEFAULT 'auto' AFTER timeout_seconds");
    await connection.execute("UPDATE model_providers SET test_adapter = 'chat_completions' WHERE provider_name = '中转文本' AND test_adapter = 'auto'");
    const [imageAdapterColumns] = await connection.query("SHOW COLUMNS FROM model_providers LIKE 'image_adapter'");
    if (!imageAdapterColumns.length) {
      await connection.query("ALTER TABLE model_providers ADD COLUMN image_adapter VARCHAR(64) NOT NULL DEFAULT 'openai_images_edits' AFTER timeout_seconds");
      await connection.query("UPDATE model_providers SET image_adapter = 'seedream_images' WHERE provider_type = 'seedream'");
    }
    const [imageSizeColumns] = await connection.query("SHOW COLUMNS FROM model_providers LIKE 'image_size'");
    if (!imageSizeColumns.length) await connection.query('ALTER TABLE model_providers ADD COLUMN image_size VARCHAR(64) NULL AFTER image_adapter');
    await connection.query("UPDATE model_providers SET image_size = '2k' WHERE image_size IS NULL AND default_model LIKE '%seedream%'");
  }

  async getModelProviders() {
    let connection;
    try {
      const config = await this.getConfig();
      connection = await this.openConnection(config);
      await this.ensureModelProvidersTable(connection, config);
      const [providers] = await connection.query('SELECT id, provider_name, provider_type, api_base_url, api_key_value, default_model, model_catalog, failover_models, timeout_seconds, test_adapter, image_adapter, image_size, remark, is_enabled, is_active, sort_order, updated_at FROM model_providers ORDER BY is_active DESC, sort_order, id');
      return {
        ok: true,
        providers: providers.map((provider) => {
          let testMode = null;
          try {
            const plan = modelProviderTestPlan(provider);
            testMode = { capability: '连接测试', method: plan.method, endpoint: plan.endpoint, contentType: plan.method === 'POST' ? 'application/json' : null };
          } catch (error) {
            testMode = { capability: '连接测试', method: '—', endpoint: error.message, contentType: null };
          }
          return { ...provider, capabilities: providerCapabilities(provider), request_modes: providerRequestModes(provider), test_mode: testMode };
        }),
      };
    } catch (error) {
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message, providers: [] };
    } finally { if (connection) await connection.end(); }
  }

  async testModelProviderConnection(provider) {
    let plan;
    try {
      plan = modelProviderTestPlan(provider);
    } catch (error) {
      return { ok: false, code: 'VALIDATION_ERROR', message: error.message };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(plan.endpoint, {
        method: plan.method,
        headers: { Authorization: `Bearer ${plan.apiKey}`, Accept: 'application/json', ...(plan.isChatTest || plan.isSeedream ? { 'Content-Type': 'application/json' } : {}) },
        ...(plan.body ? { body: JSON.stringify(plan.body) } : {}),
        signal: controller.signal,
      });
      if (!response.ok) {
        if (plan.isSeedream && response.status === 400) {
          const rawBody = await response.text();
          let payload = null;
          try { payload = JSON.parse(rawBody); } catch (_) { /* 保留文本错误信息 */ }
          const providerMessage = String(payload?.error?.message || payload?.message || payload?.msg || rawBody || '').replace(/\s+/g, ' ').trim().slice(0, 500);
          if (/(?:prompt|提示词|不能为空|required|missing)/i.test(providerMessage)) {
            return { ok: true, model: plan.model || null, message: `已连通并完成 Seedream 鉴权：${plan.model || '默认模型'}。测试仅触发空提示词参数校验，未生成图片，不消耗图片额度。` };
          }
          return { ok: false, code: 'MODEL_CONNECTION_ERROR', message: providerMessage ? `Seedream 参数校验失败：${providerMessage}` : 'Seedream 返回了无法确认的参数错误，请检查模型标识与图片适配器。' };
        }
        const messageByStatus = {
          401: '认证失败，请检查 API Key。',
          403: '没有访问该模型的权限，请检查 API Key 或模型授权。',
          404: '未找到模型或接口，请检查 Base URL 和默认模型。',
          429: '请求过于频繁或额度不足，请稍后重试。',
        };
        return { ok: false, code: 'MODEL_CONNECTION_ERROR', message: messageByStatus[response.status] || `模型服务返回 HTTP ${response.status}。` };
      }
      let payload = null;
      try { payload = await response.json(); } catch (_) { /* Some compatible services return an empty successful body. */ }
      if (payload?.success === false || (Number.isFinite(Number(payload?.code)) && Number(payload.code) >= 400)) {
        const code = Number(payload?.code);
        if (code === 401) return { ok: false, code: 'MODEL_CONNECTION_ERROR', message: '模型服务鉴权失败（令牌已过期或验证不正确）。请更新 API Key 后重试。' };
        const providerMessage = String(payload?.msg || payload?.message || '').trim().slice(0, 500);
        return { ok: false, code: 'MODEL_CONNECTION_ERROR', message: providerMessage ? `模型服务业务失败（代码 ${code || '未知'}）：${providerMessage}` : `模型服务业务失败（代码 ${code || '未知'}）。` };
      }
      return { ok: true, model: plan.model || null, message: plan.isSeedream
        ? `已成功连接 Seedream 图片模型：${plan.model || '默认模型'}。`
        : plan.isChatTest
        ? `已成功通过对话请求验证模型：${plan.model || '默认模型'}`
        : (plan.model ? `已成功连接并验证模型：${plan.model}` : '已成功连接供应商，未填写默认模型，仅验证了接口授权。') };
    } catch (error) {
      if (error.name === 'AbortError') return { ok: false, code: 'MODEL_CONNECTION_TIMEOUT', message: '连接超时（10 秒），请检查网络和 API Base URL。' };
      return { ok: false, code: 'MODEL_CONNECTION_ERROR', message: '无法连接模型服务，请检查网络和 API Base URL。' };
    } finally {
      clearTimeout(timeout);
    }
  }

  async previewModelProviderConnection(provider) {
    try {
      const plan = modelProviderTestPlan(provider);
      return {
        ok: true,
        endpoint: plan.endpoint,
        method: plan.method,
        headers: {
          Authorization: `Bearer ${maskedApiKey(plan.apiKey)}`,
          Accept: 'application/json',
          ...(plan.isChatTest || plan.isSeedream ? { 'Content-Type': 'application/json' } : {}),
        },
        body: plan.body,
      };
    } catch (error) {
      return { ok: false, code: 'VALIDATION_ERROR', message: error.message };
    }
  }

  async saveModelProvider(provider) {
    let connection;
    try {
      const config = await this.getConfig();
      const name = String(provider.provider_name || '').trim();
      if (!name) return { ok: false, code: 'VALIDATION_ERROR', message: '请填写供应商名称。' };
      const normalizeModels = (models) => [...new Set((Array.isArray(models) ? models : []).map((model) => String(model).trim()).filter(Boolean))].slice(0, 20);
      const catalog = normalizeModels(provider.model_catalog);
      const failoverModels = normalizeModels(provider.failover_models).filter((model) => model !== String(provider.default_model || '').trim());
      const timeoutSeconds = Number(provider.timeout_seconds);
      if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) return { ok: false, code: 'VALIDATION_ERROR', message: '模型调用超时需为 1 到 3600 秒之间的整数。' };
      const testAdapter = String(provider.test_adapter || 'auto').trim();
      if (!['auto', 'models', 'chat_completions'].includes(testAdapter)) return { ok: false, code: 'VALIDATION_ERROR', message: '请选择有效的连接测试方式。' };
      const imageAdapter = String(provider.image_adapter || 'openai_images_edits').trim();
      if (!['openai_images_edits', 'seedream_images'].includes(imageAdapter)) return { ok: false, code: 'VALIDATION_ERROR', message: '请选择有效的图片模型适配器。' };
      const imageSize = String(provider.image_size || '').trim().slice(0, 64);
      connection = await this.openConnection(config);
      await this.ensureModelProvidersTable(connection, config);
      await connection.beginTransaction();
      const id = Number(provider.id) || 0;
      const active = provider.is_active === true || provider.is_active === 1;
      if (active) await connection.execute('UPDATE model_providers SET is_active = 0');
      if (id) {
        await connection.execute(`UPDATE model_providers SET provider_name = ?, provider_type = ?, api_base_url = ?, api_key_value = ?, default_model = ?,
          model_catalog = CAST(? AS JSON), failover_models = CAST(? AS JSON), timeout_seconds = ?, test_adapter = ?, image_adapter = ?, image_size = ?, remark = ?, is_enabled = ?, is_active = ?, sort_order = ? WHERE id = ?`, [
          name, provider.provider_type || 'openai_compatible', provider.api_base_url || null, provider.api_key_value || null, provider.default_model || null,
          JSON.stringify(catalog), JSON.stringify(failoverModels), timeoutSeconds, testAdapter, imageAdapter, imageSize || null, provider.remark || null, provider.is_enabled === false ? 0 : 1, active ? 1 : 0, Number(provider.sort_order) || 0, id,
        ]);
      } else {
        const [created] = await connection.execute(`INSERT INTO model_providers (provider_name, provider_type, api_base_url, api_key_value, default_model, model_catalog, failover_models, timeout_seconds, test_adapter, image_adapter, image_size, remark, is_enabled, is_active, sort_order)
          VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), ?, ?, ?, ?, ?, ?, ?, ?)`, [
          name, provider.provider_type || 'openai_compatible', provider.api_base_url || null, provider.api_key_value || null, provider.default_model || null,
          JSON.stringify(catalog), JSON.stringify(failoverModels), timeoutSeconds, testAdapter, imageAdapter, imageSize || null, provider.remark || null, provider.is_enabled === false ? 0 : 1, active ? 1 : 0, Number(provider.sort_order) || 0,
        ]);
        provider.id = created.insertId;
      }
      await connection.commit();
      return { ok: true, id: provider.id || id, message: '大模型供应商配置已保存到数据库。' };
    } catch (error) {
      if (connection) { try { await connection.rollback(); } catch (_) { /* transaction not started */ } }
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message };
    } finally { if (connection) await connection.end(); }
  }

  async activateModelProvider(id) {
    let connection;
    try {
      const config = await this.getConfig();
      connection = await this.openConnection(config);
      await this.ensureModelProvidersTable(connection, config);
      await connection.beginTransaction();
      const [target] = await connection.execute('SELECT id FROM model_providers WHERE id = ? AND is_enabled = 1 LIMIT 1', [Number(id)]);
      if (!target.length) throw new Error('供应商不存在或已禁用。');
      await connection.execute('UPDATE model_providers SET is_active = 0');
      await connection.execute('UPDATE model_providers SET is_active = 1 WHERE id = ?', [Number(id)]);
      await connection.commit();
      return { ok: true, message: '已启用该大模型供应商。' };
    } catch (error) {
      if (connection) { try { await connection.rollback(); } catch (_) { /* transaction not started */ } }
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message };
    } finally { if (connection) await connection.end(); }
  }

  async deleteModelProvider(id) {
    let connection;
    try {
      const providerId = Number(id);
      if (!Number.isInteger(providerId) || providerId <= 0) return { ok: false, code: 'VALIDATION_ERROR', message: '请选择要删除的供应商。' };
      const config = await this.getConfig();
      connection = await this.openConnection(config);
      await this.ensureModelProvidersTable(connection, config);
      await this.ensureAutomationOperationBindingsTable(connection, String(config.miaoshou.appId || '').trim());
      await connection.beginTransaction();
      const [[provider]] = await connection.execute('SELECT id, provider_name, is_active FROM model_providers WHERE id = ? FOR UPDATE', [providerId]);
      if (!provider) throw new Error('供应商不存在或已删除。');
      const [removedBindings] = await connection.execute("DELETE FROM automation_operation_bindings WHERE binding_type = 'model' AND target_id = ?", [providerId]);
      await connection.execute('DELETE FROM model_providers WHERE id = ?', [providerId]);
      let activeProviderId = null;
      if (provider.is_active) {
        const [[replacement]] = await connection.execute('SELECT id FROM model_providers WHERE is_enabled = 1 ORDER BY sort_order, id LIMIT 1');
        if (replacement) {
          activeProviderId = Number(replacement.id);
          await connection.execute('UPDATE model_providers SET is_active = 1 WHERE id = ?', [activeProviderId]);
        }
      }
      await connection.commit();
      const bindingHint = removedBindings.affectedRows ? `，并移除了 ${removedBindings.affectedRows} 条自动化模型关联` : '';
      const activeHint = provider.is_active ? (activeProviderId ? '；已切换到下一个可用供应商。' : '；当前没有已启用的供应商。') : '。';
      return { ok: true, id: providerId, message: `已删除供应商“${provider.provider_name}”${bindingHint}${activeHint}` };
    } catch (error) {
      if (connection) { try { await connection.rollback(); } catch (_) { /* transaction not started */ } }
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message };
    } finally { if (connection) await connection.end(); }
  }

  async getFieldMappings() {
    let connection;
    try {
      connection = await this.openConnection(await this.getConfig());
      await this.ensureFieldMappingsTable(connection);
      const [mappings] = await connection.execute('SELECT id, mapping_key, source_value, display_value, is_enabled, sort_order FROM field_mappings ORDER BY mapping_key, sort_order, id');
      return { ok: true, mappings };
    } catch (error) {
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message, mappings: [] };
    } finally { if (connection) await connection.end(); }
  }

  async saveFieldMappings(mappings) {
    let connection;
    try {
      if (!Array.isArray(mappings)) throw new Error('字段映射格式错误。');
      connection = await this.openConnection(await this.getConfig());
      await this.ensureFieldMappingsTable(connection);
      await connection.beginTransaction();
      for (const mapping of mappings) {
        const sourceValue = String(mapping.source_value || '').trim();
        const displayValue = String(mapping.display_value || '').trim();
        if (!sourceValue || !displayValue) continue;
        const mappingKey = ['target_platform_code', 'product_status'].includes(String(mapping.mapping_key || '')) ? String(mapping.mapping_key) : 'target_platform_code';
        await connection.execute(`INSERT INTO field_mappings (mapping_key, source_value, display_value, is_enabled, sort_order)
          VALUES (?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE display_value = VALUES(display_value), is_enabled = VALUES(is_enabled), sort_order = VALUES(sort_order)`, [mappingKey, sourceValue, displayValue, mapping.is_enabled === false ? 0 : 1, Number(mapping.sort_order) || 0]);
      }
      await connection.commit();
      return this.getFieldMappings();
    } catch (error) {
      if (connection) { try { await connection.rollback(); } catch (_) { /* no transaction started */ } }
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message, mappings: [] };
    } finally { if (connection) await connection.end(); }
  }

  async overview(page = 1, pageSize = 20, userId = null, options = {}) {
    let connection;
    try {
      const config = await this.getConfig();
      const requestedPage = Math.max(1, Number(page) || 1);
      const safePageSize = Math.min(100, Math.max(10, Number(pageSize) || 20));
      const ownerUserId = Number(userId);
      const allProducts = Boolean(options?.allProducts);
      if (!Number.isInteger(ownerUserId) || ownerUserId < 1) return { ok: true, stats: { total: 0, pendingProcess: 0, imageProcessing: 0, readyToWrite: 0, failed: 0 }, products: [], pagination: { page: 1, pageSize: safePageSize, total: 0, totalPages: 1 } };
      connection = await this.openConnection(config);
      await this.ensureSourceDetailColumns(connection);
      await this.ensureCategoryTables(connection);
      await this.ensureCommonTemplateCategoriesTable(connection);
      await this.ensureMiaoshouProductMappingsTable(connection);
      await this.ensureProductMiaoshouAccountScope(connection);
      await this.purgeLegacyCommonCollectBoxData(connection);
      await this.ensureFieldMappingsTable(connection);
      await this.ensureMiaoshouAuthorizedShopsTables(connection);
      await this.ensureMiaoshouWriteRecordsTable(connection);
      await this.ensureProductIssuesTable(connection);
      await this.ensureProductRemarkTagsTable(connection);
      let scopeWhere = 'p.deleted_at IS NULL AND p.created_by = ?';
      let scopeValues = [ownerUserId];
      if (!allProducts) {
        const appId = String(config.miaoshou.appId || '').trim();
        const [settings] = await connection.execute('SELECT platform_code, shop_id FROM automation_publish_settings WHERE user_id = ? AND miaoshou_app_id = ? LIMIT 1', [ownerUserId, appId]);
        if (!settings.length) {
          scopeWhere += ' AND 1 = 0';
        } else {
          const setting = settings[0];
          scopeWhere += " AND ((p.source_miaoshou_app_id = ? AND p.source_store_id = ? AND (p.source_platform_code = ? OR p.source_platform_code = 'folder_builder')) OR p.source_platform_code = 'image_product_builder')";
          scopeValues.push(appId, String(setting.shop_id), `miaoshou_${setting.platform_code}`);
        }
      }
      const sourceOrigin = String(options?.sourceOrigin || '').trim();
      if (sourceOrigin === 'folder_builder') {
        scopeWhere += " AND (p.source_platform_code = 'folder_builder' OR JSON_CONTAINS_PATH(p.raw_data, 'one', '$._miaoshouFolderImport'))";
      } else if (sourceOrigin === 'miaoshou') {
        scopeWhere += " AND p.source_platform_code <> 'folder_builder' AND NOT JSON_CONTAINS_PATH(p.raw_data, 'one', '$._miaoshouFolderImport')";
      }
      const [[stats]] = await connection.execute(`SELECT COUNT(*) AS total, SUM(product_status = 'pending_process') AS pendingProcess, SUM(product_status = 'image_processing') AS imageProcessing, SUM(product_status = 'ready_to_write') AS readyToWrite, SUM(product_status = 'failed') AS failed FROM products p WHERE ${scopeWhere}`, scopeValues);
      const total = Number(stats.total || 0);
      const totalPages = Math.max(1, Math.ceil(total / safePageSize));
      const safePage = Math.min(requestedPage, totalPages);
      const offset = (safePage - 1) * safePageSize;
      const commonCategoryScope = 'common_category.user_id = ?';
      const issueScope = 'issue.user_id = ? AND issue.product_id = p.id';
      const detailParams = [ownerUserId, ownerUserId];
      const [products] = await connection.execute(`SELECT p.id, p.created_by, p.source_miaoshou_app_id, p.source_platform_code, p.source_product_id, p.source_store_id, p.title, p.generated_title, p.target_platform_code, p.current_category_id, p.raw_data,
        COALESCE(target_mapping.display_value, p.target_platform_code) AS target_platform_display, p.product_status,
        COALESCE(status_mapping.display_value, p.product_status) AS product_status_display, p.created_at,
        COALESCE(
          (SELECT shop.shop_name FROM miaoshou_authorized_shops shop
            WHERE shop.user_id = p.created_by AND shop.miaoshou_app_id = p.source_miaoshou_app_id
              AND shop.platform_code = REPLACE(p.source_platform_code, 'miaoshou_', '') AND shop.shop_id = p.source_store_id
            ORDER BY shop.updated_at DESC, shop.id DESC LIMIT 1),
          (SELECT imported_shop.shop_name FROM miaoshou_folder_import_records imported_record
            JOIN miaoshou_authorized_shops imported_shop
              ON imported_shop.user_id = imported_record.user_id AND imported_shop.miaoshou_app_id = imported_record.miaoshou_app_id
              AND imported_shop.platform_code = imported_record.platform_code AND imported_shop.site_code = imported_record.site_code
              AND imported_shop.shop_id = imported_record.shop_id
            WHERE imported_record.user_id = p.created_by AND imported_record.product_id = p.id
            ORDER BY imported_record.updated_at DESC, imported_record.id DESC LIMIT 1)
        ) AS source_shop_name,
        category.category_name AS category_name, category.full_path AS category_path,
        EXISTS(SELECT 1 FROM user_common_categories common_category
          WHERE ${commonCategoryScope} AND common_category.category_id = p.current_category_id) AS is_common_category,
        (SELECT JSON_ARRAYAGG(JSON_OBJECT('type', issue.issue_type, 'title', issue.issue_title, 'code', issue.issue_code,
          'message', issue.issue_message, 'occurredAt', issue.occurred_at))
          FROM product_issues issue WHERE ${issueScope}) AS issues_json,
        (SELECT a.object_key FROM product_images pi JOIN assets a ON a.id = pi.asset_id WHERE pi.product_id = p.id AND a.asset_kind = 'source_image' AND a.deleted_at IS NULL ORDER BY pi.sort_order, pi.id LIMIT 1) AS image_object_key,
        (SELECT a.original_url FROM product_images pi JOIN assets a ON a.id = pi.asset_id WHERE pi.product_id = p.id AND a.asset_kind = 'source_image' AND a.deleted_at IS NULL ORDER BY pi.sort_order, pi.id LIMIT 1) AS source_image_url
        FROM products p LEFT JOIN field_mappings target_mapping ON target_mapping.mapping_key = 'target_platform_code' AND target_mapping.source_value = p.target_platform_code AND target_mapping.is_enabled = 1
        LEFT JOIN field_mappings status_mapping ON status_mapping.mapping_key = 'product_status' AND status_mapping.source_value = p.product_status AND status_mapping.is_enabled = 1
        LEFT JOIN categories category ON category.id = p.current_category_id
        WHERE ${scopeWhere} ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?`, [...detailParams, ...scopeValues, safePageSize, offset]);
      const tagsByProductId = new Map();
      if (products.length) {
        const productIds = products.map((product) => Number(product.id));
        const [tagRows] = await connection.execute(`SELECT id, product_id, tag_name, created_at
          FROM product_remark_tags WHERE product_id IN (${productIds.map(() => '?').join(', ')}) ORDER BY product_id, id`, productIds);
        tagRows.forEach((tag) => {
          const tags = tagsByProductId.get(Number(tag.product_id)) || [];
          tags.push(tag);
          tagsByProductId.set(Number(tag.product_id), tags);
        });
      }
      const oss = new OssClient(config.oss);
      const normalizedProducts = products.map((product) => {
        const raw = this.parseJsonColumn(product.raw_data, {});
        return {
        ...product,
        remark_tags: tagsByProductId.get(Number(product.id)) || [],
        main_item_number: String(raw?._miaoshouDetail?.itemNum || raw?._imageProductBuilder?.itemNumber || product.source_product_id || product.title || ''),
        source_shop_name: product.source_shop_name || raw?._storeCopy?.targetShopName || raw?._miaoshouFolderImport?.shopName || raw?._miaoshouStoreCollectBox?.shopName || null,
        is_image_product_builder_origin: product.source_platform_code === 'image_product_builder' || Boolean(raw?._imageProductBuilder),
        is_folder_builder_origin: product.source_platform_code === 'folder_builder' || Boolean(raw?._folderBuilder || raw?._miaoshouFolderImport),
        is_folder_builder_imported: Boolean(raw?._miaoshouFolderImport),
        issues: (() => {
          const issues = this.parseJsonColumn(product.issues_json, []);
          return Array.isArray(issues) ? issues : [];
        })(),
        image_url: product.image_object_key ? oss.publicUrl(product.image_object_key) : (product.source_image_url || raw?._imageProductBuilder?.originalImageUrls?.[0] || raw?._imageProductBuilder?.carouselImageUrls?.[0] || raw?._miaoshouDetail?.imgUrls?.[0] || null),
        sku_image_url: (() => {
          const detail = raw?._miaoshouDetail || {};
          const colorMap = detail.colorMap || {};
          return Object.values(colorMap).map((color) => color?.imgUrl || color?.imgUrls?.[0]).find(Boolean)
            || (detail.saleAttributes || []).flatMap((attribute) => attribute?.values || []).map((value) => value?.imgUrls?.[0]).find(Boolean)
            || null;
        })(),
        };
      });
      return {
        ok: true,
        stats: Object.fromEntries(Object.entries(stats).map(([key, value]) => [key, Number(value || 0)])),
        products: normalizedProducts,
        scope: allProducts ? 'all' : 'current',
        pagination: { page: safePage, pageSize: safePageSize, total, totalPages },
      };
    } catch (error) {
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message, stats: null, products: [], pagination: null };
    } finally { if (connection) await connection.end(); }
  }

  async getProductForEdit(productId, userId) {
    let connection;
    try {
      const id = Number(productId);
      const ownerUserId = Number(userId);
      if (!Number.isInteger(id) || id < 1) return { ok: false, code: 'INVALID_PRODUCT_ID', message: '商品编号无效。', product: null, images: [] };
      if (!Number.isInteger(ownerUserId) || ownerUserId < 1) return { ok: false, code: 'UNAUTHENTICATED', message: '请先登录本机用户。', product: null, images: [] };
      const config = await this.getConfig();
      connection = await this.openConnection(config);
      await this.ensureFieldMappingsTable(connection);
      await this.ensureSourceDetailColumns(connection);
      await this.ensureProductSkuGeneratedImagesTable(connection);
      await this.ensureAiGenerationRecordsTable(connection);
      const [products] = await connection.execute(`SELECT p.id, p.source_platform_code, p.source_product_id, p.source_store_id, p.title, p.generated_title, p.ai_generated_image_urls,
        p.target_platform_code, COALESCE(target_mapping.display_value, p.target_platform_code) AS target_platform_display,
        p.product_status, COALESCE(status_mapping.display_value, p.product_status) AS product_status_display, p.created_at, p.updated_at, p.last_synced_at, p.source_notes_text, p.source_price, p.source_stock, p.source_weight,
        p.source_package_length, p.source_package_width, p.source_package_height, p.source_size_map, p.source_color_map, p.current_category_id, p.raw_data,
        category.category_name AS category_name, category.full_path AS category_path
        FROM products p LEFT JOIN field_mappings target_mapping ON target_mapping.mapping_key = 'target_platform_code'
          AND target_mapping.source_value = p.target_platform_code AND target_mapping.is_enabled = 1
        LEFT JOIN field_mappings status_mapping ON status_mapping.mapping_key = 'product_status'
          AND status_mapping.source_value = p.product_status AND status_mapping.is_enabled = 1
        LEFT JOIN categories category ON category.id = p.current_category_id
        WHERE p.id = ? AND p.created_by = ? AND p.deleted_at IS NULL LIMIT 1`, [id, ownerUserId]);
      if (!products.length) return { ok: false, code: 'PRODUCT_NOT_FOUND', message: '商品不存在或已删除。', product: null, images: [] };
      const [images] = await connection.execute(`SELECT a.object_key, a.original_url, pi.image_group, pi.sort_order
        FROM product_images pi JOIN assets a ON a.id = pi.asset_id
        WHERE pi.product_id = ? AND pi.image_group = 'source' AND a.asset_kind = 'source_image' AND a.deleted_at IS NULL
        ORDER BY pi.sort_order, pi.id`, [id]);
      const oss = new OssClient(config.oss);
      const seenSourceImages = new Set();
      let sourceImages = images.map((image) => ({ ...image, image_url: image.object_key ? oss.publicUrl(image.object_key) : image.original_url }))
        .filter((image) => {
          const canonical = this.canonicalImageUrl(image.original_url || image.image_url);
          if (seenSourceImages.has(canonical)) return false;
          seenSourceImages.add(canonical);
          return true;
        });
      if (!sourceImages.length && products[0].source_platform_code === 'image_product_builder') {
        const builderImages = this.parseJsonColumn(products[0].raw_data, {})._imageProductBuilder || {};
        sourceImages = [...(builderImages.originalImageUrls || []), ...(builderImages.carouselImageUrls || [])].map((image_url, sort_order) => ({ image_url, original_url: image_url, image_group: 'source', sort_order }));
      }
      let categoryAttributeRules = [];
      const [skuGeneratedImages] = await connection.execute(`SELECT id, sku_index, image_url, template_id, model_provider_id, created_at
        FROM product_sku_generated_images WHERE product_id = ? ORDER BY sku_index, created_at, id`, [id]);
      const [folderSkuRecords] = await connection.execute(`SELECT id, record_status, progress_percent, progress_message, error_message,
        requested_at, task_started_at, task_finished_at, finished_at
        FROM ai_generation_records WHERE product_id = ? AND generation_type = 'folder_sku'
        ORDER BY requested_at DESC, id DESC LIMIT 1`, [id]);
      if (Number.isInteger(ownerUserId) && ownerUserId > 0 && products[0].current_category_id) {
        await this.ensureCommonCategoryAttributesTable(connection);
        const [rules] = await connection.execute(`SELECT product_attribute_rules FROM user_common_category_attributes
          WHERE user_id = ? AND category_id = ? LIMIT 1`, [ownerUserId, Number(products[0].current_category_id)]);
        categoryAttributeRules = this.parseJsonColumn(rules[0]?.product_attribute_rules, []);
      }
      return { ok: true, product: products[0], images: sourceImages, categoryAttributeRules, skuGeneratedImages, folderSkuRecognition: folderSkuRecords[0] || null };
    } catch (error) {
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message, product: null, images: [], skuGeneratedImages: [] };
    } finally { if (connection) await connection.end(); }
  }

  async applyProductCategoryAttributeTemplate(userId, productId, options = {}) {
    let connection;
    try {
      const ownerUserId = Number(userId);
      const id = Number(productId);
      const overwrite = options?.overwrite === true;
      if (!Number.isInteger(ownerUserId) || ownerUserId < 1) throw new Error('请先登录本机用户。');
      if (!Number.isInteger(id) || id < 1) throw new Error('商品编号无效。');
      connection = await this.openConnection(await this.getConfig());
      await this.ensureCommonTemplateCategoriesTable(connection);
      await this.ensureCommonCategoryAttributeTemplatesTable(connection);
      const [[product]] = await connection.execute(`SELECT current_category_id, raw_data FROM products
        WHERE id = ? AND created_by = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE`, [id, ownerUserId]);
      if (!product) throw new Error('商品不存在或不属于当前用户。');
      const categoryId = Number(product.current_category_id);
      if (!Number.isInteger(categoryId) || categoryId < 1) throw new Error('请先为商品设置类目。');
      const [[templateRow]] = await connection.execute(`SELECT attribute_values, basic_required_fields, sku_defaults
        FROM user_common_category_attribute_templates WHERE user_id = ? AND category_id = ? LIMIT 1`, [ownerUserId, categoryId]);
      if (!templateRow) throw new Error('当前类目尚未保存属性模板。');

      const templateValues = this.normalizeCategoryAttributeTemplateValues(this.parseJsonColumn(templateRow.attribute_values, {}));
      const basic = this.normalizeBasicRequiredFields(this.parseJsonColumn(templateRow.basic_required_fields, {}));
      const skuDefaults = this.normalizeSkuDefaults(this.parseJsonColumn(templateRow.sku_defaults, {}));
      const rawData = this.parseJsonColumn(product.raw_data, {});
      const detail = rawData._miaoshouDetail && typeof rawData._miaoshouDetail === 'object' && !Array.isArray(rawData._miaoshouDetail)
        ? { ...rawData._miaoshouDetail } : {};
      const isEmpty = (value) => Array.isArray(value) ? value.length === 0 : value === null || value === undefined || String(value).trim() === '';
      let appliedBasicFields = 0;
      let appliedAttributes = 0;
      let appliedSkuFields = 0;
      let skipped = 0;
      const applyDetailField = (field, value) => {
        if (isEmpty(value)) return;
        if (!overwrite && !isEmpty(detail[field])) { skipped += 1; return; }
        detail[field] = Array.isArray(value) ? [...value] : value;
        appliedBasicFields += 1;
      };
      applyDetailField('productOriginCountry', basic.productOriginCountry);
      applyDetailField('productOriginProvince', basic.productOriginProvince);
      applyDetailField('outerPackageShape', basic.outerPackageShape?.key);
      applyDetailField('outerPackageType', basic.outerPackageType?.key);
      applyDetailField('outerPackageImgUrls', basic.outerPackageImgUrls);
      applyDetailField('manufacturingLocationRegionShortNameList', basic.manufacturingLocationRegionShortNameList);

      const attributes = Array.isArray(detail.attributes) ? detail.attributes.map((attribute) => ({ ...attribute, values: Array.isArray(attribute?.values) ? attribute.values.map((value) => ({ ...value })) : [] }))
        : (Array.isArray(detail.sourceAttrs) ? detail.sourceAttrs.map((attribute) => ({ ...attribute, values: Array.isArray(attribute?.values) ? attribute.values.map((value) => ({ ...value })) : [] })) : []);
      for (const configured of templateValues.productAttributes) {
        const index = attributes.findIndex((attribute) => this.categoryAttributeTemplateKey(attribute) === this.categoryAttributeTemplateKey(configured));
        if (index >= 0 && !overwrite && !isEmpty(attributes[index].values)) { skipped += 1; continue; }
        const next = { ...(index >= 0 ? attributes[index] : {}), ...configured, values: configured.values.map((value) => ({ ...value })) };
        if (index >= 0) attributes[index] = next;
        else attributes.push(next);
        appliedAttributes += 1;
      }
      detail.attributes = attributes;
      detail.sourceAttrs = attributes;

      const skuMap = detail.skuMap && typeof detail.skuMap === 'object' && !Array.isArray(detail.skuMap) ? { ...detail.skuMap } : {};
      const productMainId = String(detail.itemNum || '').trim();
      const skuFields = ['price', 'suggestedPrice', 'stock', 'weight', 'length', 'width', 'height', 'pieceUnitCode'];
      Object.entries(skuMap).forEach(([skuKey, sku], index) => {
        if (!sku || typeof sku !== 'object') return;
        const keyText = String(skuKey || '').toLocaleLowerCase();
        const matchedRule = skuDefaults.rules.find((rule) => {
          const matchValue = String(rule.matchValue || '').toLocaleLowerCase();
          return matchValue && (rule.matchType === 'size_exact'
            ? keyText.split(';').filter(Boolean).some((value) => value === matchValue)
            : keyText.includes(matchValue));
        });
        if (!matchedRule) return;
        const values = matchedRule.values || {};
        const next = { ...sku };
        const applySkuField = (field, value) => {
          if (isEmpty(value)) return;
          if (!overwrite && !isEmpty(next[field])) { skipped += 1; return; }
          next[field] = value;
          appliedSkuFields += 1;
        };
        const skuCode = values.skuCodeRule
          ? String(values.skuCodeRule).replace(/\{productMainId\}/g, productMainId).replace(/\{index\}/g, String(index + 1))
          : null;
        applySkuField('itemNum', skuCode);
        applySkuField('suggestedPriceCurrencyType', values.currency);
        skuFields.forEach((field) => applySkuField(field, values[field]));
        skuMap[skuKey] = next;
      });
      detail.skuMap = skuMap;
      detail._localAttributeTemplateApplied = { categoryId, appliedAt: new Date().toISOString(), overwrite };
      rawData._miaoshouDetail = detail;
      if (appliedBasicFields || appliedAttributes || appliedSkuFields) {
        await connection.execute('UPDATE products SET raw_data = CAST(? AS JSON), updated_at = NOW() WHERE id = ? AND created_by = ? AND deleted_at IS NULL', [JSON.stringify(rawData), id, ownerUserId]);
      }
      return {
        ok: true, categoryId, applied: { basicFields: appliedBasicFields, attributes: appliedAttributes, skuFields: appliedSkuFields }, skipped,
        message: appliedBasicFields || appliedAttributes || appliedSkuFields
          ? `已回填 ${appliedBasicFields} 项基础字段、${appliedAttributes} 项类目属性、${appliedSkuFields} 项 SKU 字段${skipped ? `；跳过 ${skipped} 项已有值` : ''}。`
          : (skipped ? `没有可回填的空字段，已跳过 ${skipped} 项已有值。` : '当前类目模板没有可回填的内容。'),
      };
    } catch (error) {
      return { ok: false, code: error.code || 'CATEGORY_TEMPLATE_APPLY_ERROR', message: error.message || '应用类目模板失败。' };
    } finally { if (connection) await connection.end(); }
  }

  async copyProductToCurrentStore(userId, productId) {
    let connection;
    try {
      const ownerUserId = Number(userId);
      const sourceProductId = Number(productId);
      if (!Number.isInteger(ownerUserId) || ownerUserId < 1 || !Number.isInteger(sourceProductId) || sourceProductId < 1) {
        throw new Error('复制商品参数无效。');
      }
      const config = await this.getConfig();
      const appId = String(config.miaoshou.appId || '').trim();
      if (!appId) throw new Error('请先启用妙手 API 配置。');
      connection = await this.openConnection(config);
      await this.ensureMiaoshouAuthorizedShopsTables(connection);
      await this.ensureMiaoshouProductMappingsTable(connection);
      await this.ensureMiaoshouFolderImportRecordsTable(connection);
      await this.ensureProductMiaoshouAccountScope(connection);
      const [settings] = await connection.execute(`SELECT platform_code, site_code, shop_id FROM automation_publish_settings
        WHERE user_id = ? AND miaoshou_app_id = ? LIMIT 1`, [ownerUserId, appId]);
      if (!settings.length || !settings[0].platform_code || !settings[0].shop_id) throw new Error('请先配置当前妙手账号的目标店铺。');
      const target = settings[0];
      const [shops] = await connection.execute(`SELECT shop_name FROM miaoshou_authorized_shops
        WHERE user_id = ? AND miaoshou_app_id = ? AND platform_code = ? AND site_code = ? AND shop_id = ? AND is_enabled = 1 LIMIT 1`,
      [ownerUserId, appId, target.platform_code, target.site_code, target.shop_id]);
      if (!shops.length) throw new Error('当前目标店铺无效，请刷新授权店铺后重新选择。');
      const [sources] = await connection.execute(`SELECT * FROM products
        WHERE id = ? AND created_by = ? AND deleted_at IS NULL LIMIT 1`, [sourceProductId, ownerUserId]);
      if (!sources.length) throw new Error('来源商品不存在或不属于当前用户。');
      const source = sources[0];
      if (String(source.source_miaoshou_app_id || '') === appId
        && String(source.source_store_id || '') === String(target.shop_id)
        && String(source.source_platform_code || '') === `miaoshou_${target.platform_code}`) {
        throw new Error('来源商品已经属于当前店铺，无需复制。');
      }
      const copyOriginId = Number(source.copy_origin_product_id) || sourceProductId;
      const [existing] = await connection.execute(`SELECT id, title, product_status FROM products
        WHERE created_by = ? AND copy_origin_product_id = ? AND source_miaoshou_app_id = ? AND source_store_id = ? AND deleted_at IS NULL LIMIT 1`,
      [ownerUserId, copyOriginId, appId, String(target.shop_id)]);
      if (existing.length) return { ok: true, existing: true, productId: Number(existing[0].id), message: `当前店铺已存在复制草稿“${existing[0].title}”。` };

      const rawData = this.parseJsonColumn(source.raw_data, {});
      const copyProductId = `copy-${crypto.randomUUID()}`;
      const targetPlatformCode = target.platform_code === 'pddkj' ? 'temu_full' : 'temu_semi';
      const copiedRawData = {
        ...rawData,
        _folderBuilder: { ...(rawData._folderBuilder || {}), copiedAt: new Date().toISOString(), copiedFromProductId: sourceProductId },
        _storeCopy: {
          originProductId: sourceProductId, originAppId: source.source_miaoshou_app_id || null, originStoreId: source.source_store_id || null,
          targetAppId: appId, targetPlatformCode: target.platform_code, targetSiteCode: target.site_code, targetShopId: String(target.shop_id), targetShopName: shops[0].shop_name,
        },
      };
      await connection.beginTransaction();
      const [created] = await connection.execute(`INSERT INTO products
        (source_miaoshou_app_id, copy_origin_product_id, source_platform_code, source_product_id, source_store_id, source_notes_text,
          source_price, source_stock, source_weight, source_package_length, source_package_width, source_package_height, source_size_map, source_color_map,
          target_platform_code, current_category_id, title, generated_title, ai_generated_image_urls, product_status, raw_data, created_by)
        VALUES (?, ?, 'folder_builder', ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), ?, ?, ?, ?, CAST(? AS JSON), 'pending_process', CAST(? AS JSON), ?)`, [
        appId, copyOriginId, copyProductId, String(target.shop_id), source.source_notes_text, source.source_price, source.source_stock, source.source_weight,
        source.source_package_length, source.source_package_width, source.source_package_height, source.source_size_map || null, source.source_color_map || null,
        targetPlatformCode, source.current_category_id, source.title, source.generated_title, source.ai_generated_image_urls || JSON.stringify([]), JSON.stringify(copiedRawData), ownerUserId,
      ]);
      const newProductId = Number(created.insertId);
      const [skus] = await connection.execute(`SELECT id, source_sku_id, sku_code, sku_name, attribute_data, price_amount, currency_code, stock_quantity,
        source_data, draft_data, sort_order, is_enabled FROM product_skus WHERE product_id = ? AND deleted_at IS NULL ORDER BY id`, [sourceProductId]);
      const skuIdMap = new Map();
      for (const sku of skus) {
        const [newSku] = await connection.execute(`INSERT INTO product_skus
          (product_id, source_sku_id, sku_code, sku_name, attribute_data, price_amount, currency_code, stock_quantity, source_data, draft_data, sort_order, is_enabled)
          VALUES (?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), ?, ?)`, [
          newProductId, sku.source_sku_id, sku.sku_code, sku.sku_name, sku.attribute_data || null, sku.price_amount, sku.currency_code, sku.stock_quantity,
          sku.source_data || null, sku.draft_data || null, sku.sort_order, sku.is_enabled,
        ]);
        skuIdMap.set(Number(sku.id), Number(newSku.insertId));
      }
      const [images] = await connection.execute(`SELECT pi.product_sku_id, pi.image_group, pi.sort_order, pi.is_selected_for_draft,
        a.storage_provider, a.bucket_name, a.object_key, a.original_url, a.local_cache_path, a.file_name, a.mime_type, a.file_size_bytes,
        a.content_hash, a.width_px, a.height_px, a.asset_kind, a.process_metadata
        FROM product_images pi JOIN assets a ON a.id = pi.asset_id WHERE pi.product_id = ? AND a.deleted_at IS NULL ORDER BY pi.id`, [sourceProductId]);
      for (const image of images) {
        const [asset] = await connection.execute(`INSERT INTO assets
          (product_id, storage_provider, bucket_name, object_key, original_url, local_cache_path, file_name, mime_type, file_size_bytes,
            content_hash, width_px, height_px, asset_kind, process_metadata)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`, [
          newProductId, image.storage_provider, image.bucket_name, image.object_key, image.original_url, image.local_cache_path, image.file_name, image.mime_type,
          image.file_size_bytes, image.content_hash, image.width_px, image.height_px, image.asset_kind, image.process_metadata || null,
        ]);
        await connection.execute(`INSERT INTO product_images (product_id, product_sku_id, asset_id, image_group, sort_order, is_selected_for_draft)
          VALUES (?, ?, ?, ?, ?, ?)`, [newProductId, skuIdMap.get(Number(image.product_sku_id)) || null, asset.insertId, image.image_group, image.sort_order, image.is_selected_for_draft]);
      }
      await connection.commit();
      return { ok: true, existing: false, productId: newProductId, message: `已复制到当前店铺“${shops[0].shop_name}”，请在商品处理页确认后录入妙手。` };
    } catch (error) {
      if (connection) { try { await connection.rollback(); } catch (_) { /* transaction may not have started */ } }
      return { ok: false, code: error.code || 'PRODUCT_COPY_ERROR', message: error.message || '复制商品失败。' };
    } finally { if (connection) await connection.end(); }
  }

  async updateProduct(product) {
    let connection;
    try {
      const id = Number(product.id);
      const title = String(product.title || '').trim();
      if (!Number.isInteger(id) || id < 1) return { ok: false, code: 'INVALID_PRODUCT_ID', message: '商品编号无效。' };
      if (!title) return { ok: false, code: 'VALIDATION_ERROR', message: '请填写商品标题。' };
      const numberOrNull = (value, label, integer = false) => {
        if (value === '' || value === null || value === undefined) return null;
        const number = Number(value);
        if (!Number.isFinite(number) || number < 0 || (integer && !Number.isInteger(number))) throw new Error(`${label}必须是非负${integer ? '整数' : '数字'}。`);
        return number;
      };
      const price = numberOrNull(product.source_price, '货源价格');
      const stock = numberOrNull(product.source_stock, '库存', true);
      const weight = numberOrNull(product.source_weight, '重量');
      const packageLength = numberOrNull(product.source_package_length, '包裹长度');
      const packageWidth = numberOrNull(product.source_package_width, '包裹宽度');
      const packageHeight = numberOrNull(product.source_package_height, '包裹高度');
      connection = await this.openConnection(await this.getConfig());
      await this.ensureSourceDetailColumns(connection);
      const [existing] = await connection.execute('SELECT raw_data, generated_title, ai_generated_image_urls FROM products WHERE id = ? AND deleted_at IS NULL LIMIT 1', [id]);
      if (!existing.length) return { ok: false, code: 'PRODUCT_NOT_FOUND', message: '商品不存在或已删除。' };
      let rawData = existing[0].raw_data;
      if (typeof rawData === 'string') { try { rawData = JSON.parse(rawData); } catch (_) { rawData = {}; } }
      rawData = rawData && typeof rawData === 'object' ? rawData : {};
      const generatedTitle = product.generated_title === undefined ? existing[0].generated_title : String(product.generated_title || '').trim();
      const aiGeneratedImageUrls = product.ai_generated_image_urls === undefined
        ? this.parseJsonColumn(existing[0].ai_generated_image_urls, [])
        : [...new Set((Array.isArray(product.ai_generated_image_urls) ? product.ai_generated_image_urls : [])
          .map((url) => String(url || '').trim()).filter((url) => /^https?:\/\//i.test(url)))];
      const editedDetail = product.detail && typeof product.detail === 'object' && !Array.isArray(product.detail) ? product.detail : {};
      const detail = { ...(rawData._miaoshouDetail || {}), ...editedDetail, title, price, stock, weight, packageLength, packageWidth, packageHeight };
      if (editedDetail.sourceAttrs !== undefined) detail.attributes = editedDetail.sourceAttrs;
      detail.notesText = product.source_notes_text === undefined ? (detail.notesText || '') : String(product.source_notes_text || '');
      if (Array.isArray(product.img_urls)) detail.imgUrls = product.img_urls.map((url) => String(url || '').trim()).filter(Boolean).slice(0, 15);
      rawData._miaoshouDetail = detail;
      const [updated] = await connection.execute(`UPDATE products SET title = ?, generated_title = ?, source_price = ?, source_stock = ?, source_weight = ?,
        source_package_length = ?, source_package_width = ?, source_package_height = ?, source_notes_text = ?, source_size_map = CAST(? AS JSON),
        source_color_map = CAST(? AS JSON), ai_generated_image_urls = CAST(? AS JSON), raw_data = CAST(? AS JSON), updated_at = NOW() WHERE id = ? AND deleted_at IS NULL`, [
        title, generatedTitle || null, price, stock, weight, packageLength, packageWidth, packageHeight, detail.notesText || null, JSON.stringify(detail.sizeMap || {}),
        JSON.stringify(detail.colorMap || {}), JSON.stringify(aiGeneratedImageUrls), JSON.stringify(rawData), id,
      ]);
      if (!updated.affectedRows) return { ok: false, code: 'PRODUCT_NOT_FOUND', message: '商品不存在或已删除。' };
      // 编辑页新增 SKU 使用独立来源标记同步到本地明细表，不覆盖妙手同步或文件夹识别生成的 SKU 记录。
      const manualSkus = Object.entries(detail.skuMap && typeof detail.skuMap === 'object' ? detail.skuMap : {})
        .filter(([, sku]) => sku && typeof sku === 'object' && sku._manualSkuDraft === true);
      await connection.execute("DELETE FROM product_skus WHERE product_id = ? AND source_sku_id LIKE 'editor-sku-%'", [id]);
      for (let index = 0; index < manualSkus.length; index += 1) {
        const [skuKey, sku] = manualSkus[index];
        const attributeData = (Array.isArray(detail.saleAttributes) ? detail.saleAttributes : []).reduce((values, attribute) => {
          const value = (Array.isArray(attribute?.values) ? attribute.values : []).find((item) => String(item?.skuKey || '') === String(skuKey));
          if (value?.name) values[String(attribute?.name || `规格${Object.keys(values).length + 1}`)] = value.name;
          return values;
        }, {});
        await connection.execute(`INSERT INTO product_skus (product_id, source_sku_id, sku_code, sku_name, attribute_data, source_data, draft_data, sort_order)
          VALUES (?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), ?)`, [
          id, `editor-sku-${index + 1}`, String(sku.itemNum || '').trim() || null,
          Object.values(attributeData).join(' / ') || String(sku.itemNum || `SKU ${index + 1}`),
          JSON.stringify(attributeData), JSON.stringify({ skuKey, manual: true }), JSON.stringify(sku), index,
        ]);
      }
      if (Array.isArray(product.img_urls)) {
        await connection.execute("DELETE FROM product_images WHERE product_id = ? AND image_group = 'source'", [id]);
        for (let index = 0; index < detail.imgUrls.length; index += 1) await this.saveSourceImageAsset(connection, id, `manual-${id}`, detail.imgUrls[index], index);
      }
      return { ok: true, message: '商品信息已保存。' };
    } catch (error) {
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message };
    } finally { if (connection) await connection.end(); }
  }

  async listProductCategoryOptions(userId) {
    let connection;
    try {
      const id = Number(userId);
      if (!Number.isInteger(id) || id <= 0) return { ok: false, code: 'VALIDATION_ERROR', message: '请先登录本机用户。', categories: [] };
      connection = await this.openConnection(await this.getConfig());
      await this.ensureCategoryTables(connection);
      const [categories] = await connection.query(`SELECT c.id, c.category_name, c.full_path, c.external_category_id, cv.platform_code,
        CASE cv.platform_code WHEN 'temu_full' THEN 'TEMU 全托' WHEN 'miaoshou_store' THEN '妙手店铺' WHEN 'manual' THEN '手动类目' ELSE UPPER(cv.platform_code) END AS platform_display
        FROM categories c JOIN category_versions cv ON cv.id = c.category_version_id
        WHERE c.status = 1 AND c.is_leaf = 1 AND cv.is_active = 1 ORDER BY cv.platform_code, c.full_path, c.id`);
      return { ok: true, categories };
    } catch (error) {
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message, categories: [] };
    } finally { if (connection) await connection.end(); }
  }

  async updateProductCategory(userId, productId, categoryId) {
    let connection;
    try {
      const ownerUserId = Number(userId);
      const id = Number(productId);
      const targetCategoryId = Number(categoryId);
      if (!Number.isInteger(ownerUserId) || ownerUserId <= 0 || !Number.isInteger(id) || id <= 0 || !Number.isInteger(targetCategoryId) || targetCategoryId <= 0) {
        return { ok: false, code: 'VALIDATION_ERROR', message: '商品或类目参数无效。' };
      }
      connection = await this.openConnection(await this.getConfig());
      await this.ensureCommonTemplateCategoriesTable(connection);
      await this.ensureCommonCategoryAttributeTemplatesTable(connection);
      await connection.beginTransaction();
      const [[category]] = await connection.execute(`SELECT c.id, c.external_category_id, c.full_path, c.category_name FROM categories c JOIN category_versions cv ON cv.id = c.category_version_id
        WHERE c.id = ? AND c.status = 1 AND c.is_leaf = 1 AND cv.is_active = 1 LIMIT 1`, [targetCategoryId]);
      if (!category) return { ok: false, code: 'CATEGORY_NOT_FOUND', message: '选择的类目不存在、不是末级类目或已停用。' };
      const [[product]] = await connection.execute('SELECT raw_data FROM products WHERE id = ? AND created_by = ? AND deleted_at IS NULL LIMIT 1', [id, ownerUserId]);
      if (!product) return { ok: false, code: 'PRODUCT_NOT_FOUND', message: '商品不存在或无权修改。' };
      let rawData = this.parseJsonColumn(product.raw_data, {});
      rawData = rawData && typeof rawData === 'object' && !Array.isArray(rawData) ? rawData : {};
      let detail = rawData._miaoshouDetail && typeof rawData._miaoshouDetail === 'object' ? rawData._miaoshouDetail : {};
      detail.cateList = String(category.full_path || category.category_name || '').split(' / ').map((name) => name.trim()).filter(Boolean);
      // 类目切换必须同时切换妙手 cid 与属性规则。仅改本地类目会导致旧 cid 搭配
      // 新类目的 templatePid，被妙手判定为“属性不存在”。
      detail.cid = String(category.external_category_id || '');
      const attributeTemplate = await this.getSavedCommonCategoryAttributeTemplate(connection, ownerUserId, targetCategoryId);
      const [[ruleCache]] = await connection.execute(`SELECT sale_attribute_rules, product_attribute_rules FROM user_common_category_attributes
        WHERE user_id = ? AND category_id = ? LIMIT 1`, [ownerUserId, targetCategoryId]);
      const productRules = this.parseJsonColumn(ruleCache?.product_attribute_rules, []);
      const saleRules = this.parseJsonColumn(ruleCache?.sale_attribute_rules, []);
      detail.attributes = this.remapAttributesToCategoryRules(detail.attributes || detail.sourceAttrs, attributeTemplate.productAttributes, productRules);
      detail.sourceAttrs = detail.attributes;
      detail.saleAttributes = this.remapAttributesToCategoryRules(detail.saleAttributes, [], saleRules);
      const basic = this.normalizeBasicRequiredFields(attributeTemplate.basicRequiredFields);
      const appliedBasicFieldCount = Object.values(basic).filter((value) => Array.isArray(value) ? value.length : Boolean(value)).length;
      detail._localAttributeTemplateApplied = (attributeTemplate.productAttributes?.length || 0) + appliedBasicFieldCount;
      detail = {
        ...detail,
        productOriginCountry: basic.productOriginCountry || detail.productOriginCountry,
        productOriginProvince: basic.productOriginProvince || detail.productOriginProvince,
        outerPackageShape: basic.outerPackageShape?.key || detail.outerPackageShape,
        outerPackageType: basic.outerPackageType?.key || detail.outerPackageType,
        outerPackageImgUrls: basic.outerPackageImgUrls.length ? basic.outerPackageImgUrls : detail.outerPackageImgUrls,
        manufacturingLocationRegionShortNameList: basic.manufacturingLocationRegionShortNameList.length ? basic.manufacturingLocationRegionShortNameList : detail.manufacturingLocationRegionShortNameList,
      };
      rawData._miaoshouDetail = detail;
      await connection.execute('UPDATE products SET current_category_id = ?, raw_data = CAST(? AS JSON), updated_at = NOW() WHERE id = ? AND created_by = ? AND deleted_at IS NULL', [targetCategoryId, JSON.stringify(rawData), id, ownerUserId]);
      await connection.commit();
      const appliedCount = Number(detail._localAttributeTemplateApplied) || 0;
      return { ok: true, category: { id: Number(category.id), full_path: category.full_path, category_name: category.category_name }, appliedCount, message: appliedCount ? `商品类目已更新，已回填 ${appliedCount} 项类目模板字段。` : '商品类目已更新；目标类目尚未配置可回填的属性模板字段。' };
    } catch (error) {
      if (connection) { try { await connection.rollback(); } catch (_) { /* transaction may not have started */ } }
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message };
    } finally { if (connection) await connection.end(); }
  }

  async deleteProduct(productId) {
    let connection;
    try {
      const id = Number(productId);
      if (!Number.isInteger(id) || id < 1) return { ok: false, code: 'INVALID_PRODUCT_ID', message: '商品编号无效。' };
      connection = await this.openConnection(await this.getConfig());
      await connection.beginTransaction();
      const [products] = await connection.execute('SELECT id FROM products WHERE id = ? LIMIT 1', [id]);
      if (!products.length) {
        await connection.rollback();
        return { ok: false, code: 'PRODUCT_NOT_FOUND', message: '商品不存在。' };
      }
      await connection.execute('DELETE FROM write_records WHERE product_id = ?', [id]);
      await connection.execute('DELETE FROM product_images WHERE product_id = ?', [id]);
      await connection.execute('DELETE FROM assets WHERE product_id = ?', [id]);
      await connection.execute('DELETE FROM products WHERE id = ?', [id]);
      await connection.commit();
      return { ok: true, message: '商品及关联素材已永久删除，类目数据已保留。' };
    } catch (error) {
      if (connection) { try { await connection.rollback(); } catch (_) { /* transaction may not have started */ } }
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message };
    } finally { if (connection) await connection.end(); }
  }

  async deleteProducts(productIds) {
    let connection;
    try {
      const ids = [...new Set((Array.isArray(productIds) ? productIds : []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
      if (!ids.length) return { ok: false, code: 'INVALID_PRODUCT_IDS', message: '请至少选择一件商品。' };
      connection = await this.openConnection(await this.getConfig());
      await connection.beginTransaction();
      const placeholders = ids.map(() => '?').join(', ');
      const [products] = await connection.execute(`SELECT id FROM products WHERE id IN (${placeholders})`, ids);
      if (products.length !== ids.length) {
        await connection.rollback();
        return { ok: false, code: 'PRODUCT_NOT_FOUND', message: '部分商品不存在，未执行删除。' };
      }
      await connection.execute(`DELETE FROM write_records WHERE product_id IN (${placeholders})`, ids);
      await connection.execute(`DELETE FROM product_images WHERE product_id IN (${placeholders})`, ids);
      await connection.execute(`DELETE FROM assets WHERE product_id IN (${placeholders})`, ids);
      await connection.execute(`DELETE FROM products WHERE id IN (${placeholders})`, ids);
      await connection.commit();
      return { ok: true, deletedCount: ids.length, message: `已永久删除 ${ids.length} 件商品及关联素材，类目数据已保留。` };
    } catch (error) {
      if (connection) { try { await connection.rollback(); } catch (_) { /* transaction may not have started */ } }
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message };
    } finally { if (connection) await connection.end(); }
  }

  async listTemplates(templateType = 'title') {
    let connection;
    try {
      connection = await this.openConnection(await this.getConfig());
      await this.ensureTemplateCategoriesTable(connection);
      const type = String(templateType || 'title');
      const [rows] = await connection.execute(`SELECT t.id, t.template_type, t.template_name, t.prompt_content, t.updated_at,
        (SELECT GROUP_CONCAT(tc.category_id ORDER BY tc.category_id) FROM template_categories tc WHERE tc.template_id = t.id) AS category_ids
        FROM templates t
        WHERE t.template_type = ? AND t.status = 'enabled' AND t.deleted_at IS NULL ORDER BY t.created_at ASC, t.id ASC`, [type]);
      return { ok: true, templates: rows.map((row) => ({ ...row, category_ids: String(row.category_ids || '').split(',').map(Number).filter(Number.isInteger) })) };
    } catch (error) {
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message, templates: [] };
    } finally { if (connection) await connection.end(); }
  }

  async saveTemplate(template) {
    let connection;
    try {
      const templateType = String(template.template_type || 'title').trim();
      const templateName = String(template.template_name || '').trim();
      const promptContent = String(template.prompt_content || '').trim();
      const categoryIds = [...new Set((Array.isArray(template.category_ids) ? template.category_ids : []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
      if (!templateName || !promptContent) return { ok: false, code: 'VALIDATION_ERROR', message: '请填写模板名称和提示词内容。' };
      connection = await this.openConnection(await this.getConfig());
      await this.ensureTemplateCategoriesTable(connection);
      await connection.beginTransaction();
      let templateId = Number(template.id) || 0;
      if (templateId) {
        const [existing] = await connection.execute('SELECT id FROM templates WHERE id = ? AND deleted_at IS NULL LIMIT 1', [templateId]);
        if (!existing.length) throw new Error('模板不存在或已删除。');
        await connection.execute('UPDATE templates SET template_name = ?, prompt_content = ?, updated_at = NOW() WHERE id = ?', [templateName, promptContent, templateId]);
      } else {
        const [created] = await connection.execute("INSERT INTO templates (template_type, template_name, platform_code, category_external_id, prompt_content) VALUES (?, ?, '', '', ?)", [templateType, templateName, promptContent]);
        templateId = created.insertId;
      }
      if (categoryIds.length) {
        const placeholders = categoryIds.map(() => '?').join(',');
        const [categories] = await connection.execute(`SELECT id FROM categories WHERE id IN (${placeholders}) AND status = 1`, categoryIds);
        if (categories.length !== categoryIds.length) throw new Error('选择的类目不存在或已停用，请刷新后重试。');
      }
      await connection.execute('DELETE FROM template_categories WHERE template_id = ?', [templateId]);
      for (const categoryId of categoryIds) await connection.execute('INSERT INTO template_categories (template_id, category_id) VALUES (?, ?)', [templateId, categoryId]);
      await connection.commit();
      return { ok: true, id: templateId, categoryIds, message: '模板及类目绑定已保存到数据库。' };
    } catch (error) {
      if (connection) { try { await connection.rollback(); } catch (_) { /* transaction not started */ } }
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message };
    } finally { if (connection) await connection.end(); }
  }

  async deleteTemplate(id) {
    let connection;
    try {
      const templateId = Number(id);
      if (!Number.isInteger(templateId) || templateId <= 0) return { ok: false, code: 'VALIDATION_ERROR', message: '请选择要删除的提示词模板。' };
      const config = await this.getConfig();
      connection = await this.openConnection(config);
      await this.ensureTemplateCategoriesTable(connection);
      await this.ensureAutomationOperationBindingsTable(connection, String(config.miaoshou.appId || '').trim());
      await connection.beginTransaction();
      const [[template]] = await connection.execute('SELECT id, template_name FROM templates WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [templateId]);
      if (!template) throw new Error('提示词模板不存在或已删除。');
      const [removedBindings] = await connection.execute("DELETE FROM automation_operation_bindings WHERE binding_type = 'template' AND target_id = ?", [templateId]);
      await connection.execute('DELETE FROM template_categories WHERE template_id = ?', [templateId]);
      // 保留版本记录和已生成素材中的 template_id，避免历史数据失去可追溯性。
      await connection.execute("UPDATE templates SET status = 'disabled', deleted_at = NOW(), updated_at = NOW() WHERE id = ?", [templateId]);
      await connection.commit();
      const bindingHint = removedBindings.affectedRows ? `，并移除了 ${removedBindings.affectedRows} 条自动化提示词关联` : '';
      return { ok: true, id: templateId, message: `已删除提示词模板“${template.template_name}”${bindingHint}。` };
    } catch (error) {
      if (connection) { try { await connection.rollback(); } catch (_) { /* transaction not started */ } }
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message };
    } finally { if (connection) await connection.end(); }
  }

  async ensureTemplateStorage(connection) {
    const [promptColumns] = await connection.query("SHOW COLUMNS FROM templates LIKE 'prompt_content'");
    if (!promptColumns.length) await connection.query('ALTER TABLE templates ADD COLUMN prompt_content LONGTEXT NULL AFTER category_external_id');
    const [versionTables] = await connection.query("SHOW TABLES LIKE 'template_versions'");
    if (versionTables.length) {
      // 仅迁移每个模板正在使用的版本，随后按用户要求删除所有提示词版本历史。
      await connection.query(`UPDATE templates t JOIN template_versions v
        ON v.template_id = t.id AND v.version_no = t.current_version_no
        SET t.prompt_content = v.prompt_content
        WHERE t.prompt_content IS NULL OR t.prompt_content = ''`);
      await connection.query('DROP TABLE template_versions');
    }
    await connection.query("UPDATE templates SET prompt_content = '' WHERE prompt_content IS NULL");
    const [versionColumns] = await connection.query("SHOW COLUMNS FROM templates LIKE 'current_version_no'");
    if (versionColumns.length) await connection.query('ALTER TABLE templates DROP COLUMN current_version_no');
  }

  async ensureTemplateCategoriesTable(connection) {
    await this.ensureTemplateStorage(connection);
    await connection.query(`CREATE TABLE IF NOT EXISTS template_categories (
      template_id BIGINT UNSIGNED NOT NULL, category_id BIGINT UNSIGNED NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (template_id, category_id), KEY idx_template_categories_category (category_id),
      CONSTRAINT fk_template_categories_template FOREIGN KEY (template_id) REFERENCES templates (id) ON DELETE CASCADE,
      CONSTRAINT fk_template_categories_category FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE CASCADE
    ) ENGINE=InnoDB COMMENT='智能模板与类目绑定'`);
  }

  async listTemplateCategories() {
    let connection;
    try {
      connection = await this.openConnection(await this.getConfig());
      await this.ensureCategoryTables(connection);
      const [categories] = await connection.query(`SELECT c.id, c.category_name, c.full_path, c.tree_level, c.is_leaf, c.external_category_id, cv.platform_code,
        CASE cv.platform_code WHEN 'temu_full' THEN 'TEMU 全托' WHEN 'manual' THEN '手动类目' ELSE UPPER(cv.platform_code) END AS platform_display
        FROM categories c JOIN category_versions cv ON cv.id = c.category_version_id
        WHERE c.status = 1 AND c.is_leaf = 1 AND cv.is_active = 1 ORDER BY cv.platform_code, c.full_path, c.id`);
      return { ok: true, categories };
    } catch (error) {
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message, categories: [] };
    } finally { if (connection) await connection.end(); }
  }

  async searchTemplateCategories(keyword, platformCode = '', page = 1, pageSize = 50) {
    let connection;
    try {
      const search = String(keyword || '').trim();
      const platform = String(platformCode || '').trim();
      const safePage = Math.max(1, Number(page) || 1);
      const safePageSize = Math.min(50, Math.max(1, Number(pageSize) || 50));
      if (search.length < 2) return { ok: true, categories: [], pagination: { page: safePage, pageSize: safePageSize, total: 0, totalPages: 0 } };
      connection = await this.openConnection(await this.getConfig());
      await this.ensureCategoryTables(connection);
      const filters = ['c.status = 1', 'c.is_leaf = 1', 'cv.is_active = 1', '(c.category_name LIKE ? OR c.full_path LIKE ?)'];
      const values = [`%${search}%`, `%${search}%`];
      if (platform) { filters.push('cv.platform_code = ?'); values.push(platform); }
      const where = filters.join(' AND ');
      const [[count]] = await connection.execute(`SELECT COUNT(*) AS total FROM categories c JOIN category_versions cv ON cv.id = c.category_version_id WHERE ${where}`, values);
      const total = Number(count.total || 0);
      const totalPages = Math.ceil(total / safePageSize);
      const currentPage = totalPages ? Math.min(safePage, totalPages) : 1;
      const [categories] = await connection.execute(`SELECT c.id, c.category_name, c.full_path, c.tree_level, c.is_leaf, c.external_category_id, cv.platform_code,
        CASE cv.platform_code WHEN 'temu_full' THEN 'TEMU 全托' WHEN 'manual' THEN '手动类目' ELSE UPPER(cv.platform_code) END AS platform_display
        FROM categories c JOIN category_versions cv ON cv.id = c.category_version_id
        WHERE ${where} ORDER BY cv.platform_code, c.full_path, c.id LIMIT ? OFFSET ?`, [...values, safePageSize, (currentPage - 1) * safePageSize]);
      return { ok: true, categories, pagination: { page: currentPage, pageSize: safePageSize, total, totalPages } };
    } catch (error) {
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message, categories: [], pagination: null };
    } finally { if (connection) await connection.end(); }
  }

  async ensureCommonTemplateCategoriesTable(connection) {
    await connection.query(`CREATE TABLE IF NOT EXISTS user_common_categories (
      user_id BIGINT UNSIGNED NOT NULL, category_id BIGINT UNSIGNED NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, category_id), KEY idx_user_common_categories_category (category_id),
      CONSTRAINT fk_user_common_categories_category FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE CASCADE
    ) ENGINE=InnoDB COMMENT='用户常用类目'`);
  }

  async isSyncedCategoryCommon(connection, userId, categoryId) {
    const ownerUserId = Number(userId);
    const targetCategoryId = Number(categoryId);
    if (!Number.isInteger(ownerUserId) || ownerUserId < 1 || !Number.isInteger(targetCategoryId) || targetCategoryId < 1) return false;
    const [rows] = await connection.execute('SELECT 1 FROM user_common_categories WHERE user_id = ? AND category_id = ? LIMIT 1', [ownerUserId, targetCategoryId]);
    return rows.length > 0;
  }

  async ensureCommonCategoryAttributesTable(connection) {
    await connection.query(`CREATE TABLE IF NOT EXISTS user_common_category_attributes (
      user_id BIGINT UNSIGNED NOT NULL, category_id BIGINT UNSIGNED NOT NULL,
      platform_code VARCHAR(32) NOT NULL,
      sale_attribute_rules JSON NOT NULL,
      product_attribute_rules JSON NOT NULL,
      category_rule_flags JSON NOT NULL,
      synchronized_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, category_id), KEY idx_user_common_category_attributes_category (category_id),
      CONSTRAINT fk_user_common_category_attributes_category FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE CASCADE
    ) ENGINE=InnoDB COMMENT='用户常用类目的妙手属性规则缓存'`);
  }

  async ensureCommonCategoryAttributeTemplatesTable(connection) {
    await connection.query(`CREATE TABLE IF NOT EXISTS user_common_category_attribute_templates (
      user_id BIGINT UNSIGNED NOT NULL, category_id BIGINT UNSIGNED NOT NULL,
      attribute_values JSON NOT NULL,
      basic_required_fields JSON NULL,
      sku_defaults JSON NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, category_id), KEY idx_user_common_category_attribute_templates_category (category_id),
      CONSTRAINT fk_user_common_category_attribute_templates_category FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE CASCADE
    ) ENGINE=InnoDB COMMENT='用户常用类目的属性填写模板'`);
    const [columns] = await connection.query("SHOW COLUMNS FROM user_common_category_attribute_templates LIKE 'basic_required_fields'");
    if (!columns.length) await connection.query('ALTER TABLE user_common_category_attribute_templates ADD COLUMN basic_required_fields JSON NULL AFTER attribute_values');
    const [skuColumns] = await connection.query("SHOW COLUMNS FROM user_common_category_attribute_templates LIKE 'sku_defaults'");
    if (!skuColumns.length) await connection.query('ALTER TABLE user_common_category_attribute_templates ADD COLUMN sku_defaults JSON NULL AFTER basic_required_fields');
  }

  parseJsonColumn(value, fallback) {
    if (value === null || value === undefined) return fallback;
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch (_) { return fallback; }
  }

  providerModelCandidates(provider) {
    const defaultModel = String(provider?.default_model || '').trim();
    const fallbackModels = this.parseJsonColumn(provider?.failover_models, []);
    return [...new Set([defaultModel, ...(Array.isArray(fallbackModels) ? fallbackModels : [])]
      .map((model) => String(model || '').trim()).filter(Boolean))];
  }

  shouldFailoverModel(error) {
    const status = Number(error?.status);
    if (error?.code === 'MODEL_AUTH_ERROR' || status === 401 || status === 400) return false;
    return error?.retryable === true || [403, 404].includes(status)
      || ['MODEL_CAPABILITY_UNSUPPORTED', 'MODEL_INVALID_RESPONSE'].includes(String(error?.code || ''));
  }

  async requestWithModelFailover({ provider, buildRequest, onAttempt, onFailure, signal, timeoutMs }) {
    const candidates = this.providerModelCandidates(provider);
    if (!candidates.length) throw new Error('所选大模型未配置默认模型。');
    let lastError = null;
    for (let index = 0; index < candidates.length; index += 1) {
      const model = candidates[index];
      const request = await buildRequest(model, index, candidates.length);
      await onAttempt?.({ ...request, model, attempt: index + 1, totalAttempts: candidates.length });
      try {
        const payload = await modelClient.requestJson({ ...request, signal, timeoutMs });
        return { payload, model, attempt: index + 1, totalAttempts: candidates.length };
      } catch (error) {
        lastError = error;
        await onFailure?.({ ...request, model, attempt: index + 1, totalAttempts: candidates.length, error });
        if (index >= candidates.length - 1 || !this.shouldFailoverModel(error)) throw error;
      }
    }
    throw lastError || new Error('模型调用失败。');
  }

  async syncCommonCategoryAttributeRules(connection, config, userId, categories) {
    const syncedCategoryIds = [];
    const skippedCategoryIds = [];
    const failures = [];
    const client = new MiaoshouClient(config.miaoshou);
    let temuRequestCount = 0;
    for (const category of categories) {
      if (category.platform_code !== 'temu_full') {
        skippedCategoryIds.push(Number(category.id));
        continue;
      }
      try {
        if (temuRequestCount) await new Promise((resolve) => setTimeout(resolve, 1100));
        temuRequestCount += 1;
        let rules;
        try {
          rules = await client.getPlatformCategoryAttributeRules('pddkj', category.external_category_id);
        } catch (error) {
          if (!/频率|rate\s*limit/i.test(error.message || '')) throw error;
          await new Promise((resolve) => setTimeout(resolve, 1100));
          rules = await client.getPlatformCategoryAttributeRules('pddkj', category.external_category_id);
        }
        const flags = {
          isSupportBasePlateCategory: Boolean(rules.isSupportBasePlateCategory),
          requiredSizeTemplate: Boolean(rules.requiredSizeTemplate),
          requiredGoodsModel: Boolean(rules.requiredGoodsModel),
          requiredSizeChart: Boolean(rules.requiredSizeChart),
          inputMaxSpecNum: rules.inputMaxSpecNum ?? null,
          isShoesClass: Boolean(rules.isShoesClass),
        };
        await connection.execute(`INSERT INTO user_common_category_attributes
          (user_id, category_id, platform_code, sale_attribute_rules, product_attribute_rules, category_rule_flags, synchronized_at)
          VALUES (?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), NOW())
          ON DUPLICATE KEY UPDATE platform_code = VALUES(platform_code), sale_attribute_rules = VALUES(sale_attribute_rules),
            product_attribute_rules = VALUES(product_attribute_rules), category_rule_flags = VALUES(category_rule_flags), synchronized_at = NOW()`, [
          userId, Number(category.id), category.platform_code, JSON.stringify(Array.isArray(rules.saleAttributeRules) ? rules.saleAttributeRules : []),
          JSON.stringify(Array.isArray(rules.productAttributeRules) ? rules.productAttributeRules : []), JSON.stringify(flags),
        ]);
        syncedCategoryIds.push(Number(category.id));
      } catch (error) {
        failures.push({ categoryId: Number(category.id), message: error.message });
      }
    }
    return { syncedCategoryIds, skippedCategoryIds, failures };
  }

  async listCommonTemplateCategories(userId) {
    let connection;
    try {
      const id = Number(userId);
      if (!Number.isInteger(id) || id <= 0) return { ok: false, code: 'VALIDATION_ERROR', message: '请先登录本机用户。', categories: [] };
      connection = await this.openConnection(await this.getConfig());
      await this.ensureCategoryTables(connection);
      await this.ensureCommonTemplateCategoriesTable(connection);
      const [categories] = await connection.execute(`SELECT c.id, c.category_name, c.full_path, c.tree_level, c.is_leaf, c.external_category_id, cv.platform_code,
        CASE cv.platform_code WHEN 'temu_full' THEN 'TEMU 全托' WHEN 'miaoshou_store' THEN '妙手店铺' WHEN 'manual' THEN '手动类目' ELSE UPPER(cv.platform_code) END AS platform_display
        FROM user_common_categories ucc JOIN categories c ON c.id = ucc.category_id
        JOIN category_versions cv ON cv.id = c.category_version_id
        WHERE ucc.user_id = ? AND c.status = 1 AND c.is_leaf = 1 AND cv.is_active = 1
        ORDER BY cv.platform_code, c.full_path, c.id`, [id]);
      return { ok: true, categories };
    } catch (error) {
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message, categories: [] };
    } finally { if (connection) await connection.end(); }
  }

  async addCommonTemplateCategories(userId, categoryIds) {
    let connection;
    try {
      const id = Number(userId);
      const ids = [...new Set((Array.isArray(categoryIds) ? categoryIds : []).map(Number).filter((categoryId) => Number.isInteger(categoryId) && categoryId > 0))];
      if (!Number.isInteger(id) || id <= 0) return { ok: false, code: 'VALIDATION_ERROR', message: '请先登录本机用户。' };
      if (!ids.length) return { ok: false, code: 'VALIDATION_ERROR', message: '请至少选择一个类目。' };
      connection = await this.openConnection(await this.getConfig());
      await this.ensureCommonTemplateCategoriesTable(connection);
      await this.ensureCommonCategoryAttributesTable(connection);
      await this.ensureCommonCategoryAttributeTemplatesTable(connection);
      const placeholders = ids.map(() => '?').join(',');
      const [categories] = await connection.execute(`SELECT c.id, c.external_category_id, cv.platform_code FROM categories c JOIN category_versions cv ON cv.id = c.category_version_id
        WHERE c.id IN (${placeholders}) AND c.status = 1 AND c.is_leaf = 1 AND cv.is_active = 1`, ids);
      if (categories.length !== ids.length) throw new Error('选择的类目不存在或已停用，请刷新后重试。');
      for (const categoryId of ids) await connection.execute('INSERT IGNORE INTO user_common_categories (user_id, category_id) VALUES (?, ?)', [id, categoryId]);
      const config = await this.getConfig();
      const attributeSync = await this.syncCommonCategoryAttributeRules(connection, config, id, categories);
      const summary = [`已添加 ${ids.length} 个常用类目`];
      if (attributeSync.syncedCategoryIds.length) summary.push(`已下载 ${attributeSync.syncedCategoryIds.length} 个类目的属性规则`);
      if (attributeSync.skippedCategoryIds.length) summary.push(`${attributeSync.skippedCategoryIds.length} 个类目暂未接入属性同步`);
      if (attributeSync.failures.length) summary.push(`${attributeSync.failures.length} 个类目属性下载失败`);
      return { ok: true, addedCount: ids.length, attributeSync, message: `${summary.join('；')}。` };
    } catch (error) {
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message };
    } finally { if (connection) await connection.end(); }
  }

  async removeCommonTemplateCategory(userId, categoryId) {
    let connection;
    try {
      const id = Number(userId);
      const targetCategoryId = Number(categoryId);
      if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(targetCategoryId) || targetCategoryId <= 0) return { ok: false, code: 'VALIDATION_ERROR', message: '常用类目参数无效。' };
      connection = await this.openConnection(await this.getConfig());
      await this.ensureCommonTemplateCategoriesTable(connection);
      await this.ensureCommonCategoryAttributesTable(connection);
      await this.ensureCommonCategoryAttributeTemplatesTable(connection);
      await connection.execute('DELETE FROM user_common_category_attributes WHERE user_id = ? AND category_id = ?', [id, targetCategoryId]);
      await connection.execute('DELETE FROM user_common_category_attribute_templates WHERE user_id = ? AND category_id = ?', [id, targetCategoryId]);
      const [result] = await connection.execute('DELETE FROM user_common_categories WHERE user_id = ? AND category_id = ?', [id, targetCategoryId]);
      if (!result.affectedRows) return { ok: false, code: 'NOT_FOUND', message: '该类目不在常用类目中。' };
      return { ok: true, message: '已从常用类目移除。' };
    } catch (error) {
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message };
    } finally { if (connection) await connection.end(); }
  }

  async getCommonTemplateCategoryAttributes(userId, categoryId) {
    let connection;
    try {
      const id = Number(userId);
      const targetCategoryId = Number(categoryId);
      if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(targetCategoryId) || targetCategoryId <= 0) {
        return { ok: false, code: 'VALIDATION_ERROR', message: '常用类目参数无效。' };
      }
      const config = await this.getConfig();
      connection = await this.openConnection(config);
      await this.ensureCommonTemplateCategoriesTable(connection);
      await this.ensureCommonCategoryAttributesTable(connection);
      await this.ensureCommonCategoryAttributeTemplatesTable(connection);
      const [rows] = await connection.execute(`SELECT c.id, c.category_name, c.full_path, c.external_category_id, cv.platform_code,
        CASE cv.platform_code WHEN 'temu_full' THEN 'TEMU 全托' WHEN 'manual' THEN '手动类目' ELSE UPPER(cv.platform_code) END AS platform_display,
        ucca.sale_attribute_rules, ucca.product_attribute_rules, ucca.category_rule_flags, ucca.synchronized_at,
        uccat.attribute_values AS template_attribute_values, uccat.basic_required_fields AS template_basic_required_fields, uccat.sku_defaults AS template_sku_defaults, uccat.updated_at AS template_updated_at
        FROM user_common_categories ucc JOIN categories c ON c.id = ucc.category_id
        JOIN category_versions cv ON cv.id = c.category_version_id
        LEFT JOIN user_common_category_attributes ucca ON ucca.user_id = ucc.user_id AND ucca.category_id = ucc.category_id
        LEFT JOIN user_common_category_attribute_templates uccat ON uccat.user_id = ucc.user_id AND uccat.category_id = ucc.category_id
        WHERE ucc.user_id = ? AND ucc.category_id = ? LIMIT 1`, [id, targetCategoryId]);
      if (!rows.length) return { ok: false, code: 'NOT_FOUND', message: '该类目不在常用类目中。' };
      const row = rows[0];
      const hasRules = row.synchronized_at !== null && row.synchronized_at !== undefined;
      const basicRequiredFields = this.normalizeBasicRequiredFields(this.parseJsonColumn(row.template_basic_required_fields, {}));
      const oss = new OssClient(config.oss);
      return {
        ok: true,
        category: { id: row.id, category_name: row.category_name, full_path: row.full_path, external_category_id: row.external_category_id, platform_code: row.platform_code, platform_display: row.platform_display },
        attributes: hasRules ? {
          saleAttributeRules: this.parseJsonColumn(row.sale_attribute_rules, []),
          productAttributeRules: this.parseJsonColumn(row.product_attribute_rules, []),
          flags: this.parseJsonColumn(row.category_rule_flags, {}),
          synchronizedAt: row.synchronized_at,
        } : null,
        templateValues: this.parseJsonColumn(row.template_attribute_values, { saleAttributes: [], productAttributes: [] }),
        basicRequiredFields,
        skuDefaults: this.normalizeSkuDefaults(this.parseJsonColumn(row.template_sku_defaults, {})),
        // 原始 URL 仍用于编辑和保存；仅预览使用短期签名，兼容私有 Bucket。
        packageImagePreviewUrls: basicRequiredFields.outerPackageImgUrls.map((url) => oss.previewUrl(url)),
        templateUpdatedAt: row.template_updated_at,
      };
    } catch (error) {
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message };
    } finally { if (connection) await connection.end(); }
  }

  async downloadCommonTemplateCategoryAttributes(userId, categoryId) {
    let connection;
    try {
      const id = Number(userId);
      const targetCategoryId = Number(categoryId);
      if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(targetCategoryId) || targetCategoryId <= 0) {
        return { ok: false, code: 'VALIDATION_ERROR', message: '常用类目参数无效。' };
      }
      const config = await this.getConfig();
      connection = await this.openConnection(config);
      await this.ensureCommonTemplateCategoriesTable(connection);
      await this.ensureCommonCategoryAttributesTable(connection);
      const [categories] = await connection.execute(`SELECT c.id, c.external_category_id, cv.platform_code
        FROM user_common_categories ucc JOIN categories c ON c.id = ucc.category_id
        JOIN category_versions cv ON cv.id = c.category_version_id
        WHERE ucc.user_id = ? AND ucc.category_id = ? AND c.status = 1 AND c.is_leaf = 1 AND cv.is_active = 1 LIMIT 1`, [id, targetCategoryId]);
      if (!categories.length) return { ok: false, code: 'NOT_FOUND', message: '该类目不在常用类目中或已停用。' };
      if (categories[0].platform_code !== 'temu_full') {
        return { ok: false, code: 'UNSUPPORTED_CATEGORY_PLATFORM', message: '当前仅支持下载 TEMU 全托类目的属性规则。' };
      }
      const attributeSync = await this.syncCommonCategoryAttributeRules(connection, config, id, categories);
      if (attributeSync.failures.length) return { ok: false, code: 'CATEGORY_ATTRIBUTE_DOWNLOAD_ERROR', message: attributeSync.failures[0].message || '类目属性下载失败。', attributeSync };
      if (!attributeSync.syncedCategoryIds.length) return { ok: false, code: 'CATEGORY_ATTRIBUTE_DOWNLOAD_EMPTY', message: '未获取到可保存的类目属性规则。', attributeSync };
      return { ok: true, attributeSync, message: '类目属性规则已下载并保存到本地数据库。' };
    } catch (error) {
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message };
    } finally { if (connection) await connection.end(); }
  }

  normalizeCategoryAttributeTemplateValues(attributeValues) {
    const normalizeGroup = (values) => (Array.isArray(values) ? values : []).map((entry) => ({
      key: String(entry?.key || '').trim(), pid: entry?.pid ?? null, refPid: entry?.refPid ?? null,
      templatePid: entry?.templatePid ?? null, parentSpecId: entry?.parentSpecId ?? null,
      name: String(entry?.name || '').trim(), values: Array.isArray(entry?.values) ? entry.values : [],
    })).filter((entry) => entry.key && entry.name && entry.values.length);
    return {
      saleAttributes: normalizeGroup(attributeValues?.saleAttributes),
      productAttributes: normalizeGroup(attributeValues?.productAttributes),
    };
  }

  normalizeBasicRequiredFields(basicFields) {
    const normalizePackagingValue = (field) => {
      const raw = basicFields?.[field];
      const options = MIAOSHOU_PACKAGING_OPTIONS[field] || [];
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const key = String(raw.key ?? raw.code ?? '').trim();
        const option = options.find((item) => item.key === key);
        return key ? { key, value: String(raw.value || option?.value || key).trim() } : null;
      }
      const text = String(raw || '').trim();
      const option = options.find((item) => item.key === text || item.value === text);
      return option ? { ...option } : null;
    };
    return {
      productOriginCountry: String(basicFields?.productOriginCountry || '').trim(),
      productOriginProvince: String(basicFields?.productOriginProvince || '').trim(),
      outerPackageShape: normalizePackagingValue('outerPackageShape'),
      outerPackageType: normalizePackagingValue('outerPackageType'),
      outerPackageImgUrls: [...new Set((Array.isArray(basicFields?.outerPackageImgUrls)
        ? basicFields.outerPackageImgUrls
        : String(basicFields?.outerPackageImgUrls || '').split(/[、,，\n]/)).map((value) => String(value || '').trim()).filter(Boolean))],
      manufacturingLocationRegionShortNameList: [...new Set((Array.isArray(basicFields?.manufacturingLocationRegionShortNameList)
        ? basicFields.manufacturingLocationRegionShortNameList
        : String(basicFields?.manufacturingLocationRegionShortNameList || '').split(/[、,，\n]/)).map((value) => String(value || '').trim()).filter(Boolean))],
    };
  }

  normalizeSkuDefaults(values) {
    const number = (value, { min = 0 } = {}) => {
      if (value === null || value === undefined || String(value).trim() === '') return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= min ? parsed : null;
    };
    const normalizeValues = (source = {}) => {
      const skuCodeRule = String(source?.skuCodeRule || '').trim().slice(0, 255);
      const currency = String(source?.currency || '').trim().toUpperCase().slice(0, 8);
      return {
      skuCodeRule: skuCodeRule || null, currency: currency || null,
      price: number(source?.price, { min: 0.01 }), suggestedPrice: number(source?.suggestedPrice, { min: 0.01 }),
      stock: number(source?.stock), weight: number(source?.weight, { min: 0.01 }),
      length: number(source?.length, { min: 0.01 }), width: number(source?.width, { min: 0.01 }), height: number(source?.height, { min: 0.01 }),
      pieceUnitCode: number(source?.pieceUnitCode, { min: 1 }),
      };
    };
    // 旧配置把默认值直接放在 sku_defaults 顶层；继续保留这种形状，避免已有类目模板失效。
    const defaults = normalizeValues(values?.defaults && typeof values.defaults === 'object' ? values.defaults : values);
    const rules = (Array.isArray(values?.rules) ? values.rules : []).map((rule) => {
      const matchValue = String(rule?.matchValue || '').trim().slice(0, 255);
      if (!matchValue) return null;
      return {
        matchType: rule?.matchType === 'size_exact' ? 'size_exact' : 'size_contains',
        matchValue,
        values: normalizeValues(rule?.values),
      };
    }).filter(Boolean).slice(0, 30);
    return { ...defaults, rules };
  }

  categoryAttributeTemplateKey(attribute) {
    // templatePid 是类目规则 ID；同一业务属性切换类目后会变化。优先用 pid + refPid
    // 识别同一属性，才能在同类目回填时避免重复追加，也能在切换类目时换成目标规则 ID。
    if (attribute?.pid !== null && attribute?.pid !== undefined && attribute.pid !== '') {
      const pid = String(attribute.pid);
      if (attribute?.refPid !== null && attribute?.refPid !== undefined && attribute.refPid !== '') return `pid-ref:${pid}:${attribute.refPid}`;
      return `pid:${pid}`;
    }
    if (attribute?.templatePid !== null && attribute?.templatePid !== undefined && attribute.templatePid !== '') return `template:${attribute.templatePid}`;
    if (attribute?.parentSpecId !== null && attribute?.parentSpecId !== undefined && attribute.parentSpecId !== '') return `spec:${attribute.parentSpecId}`;
    return `name:${String(attribute?.name || '').trim()}`;
  }

  remapAttributesToCategoryRules(existing, configured, rules, filterValues = true) {
    const cloneValues = (values) => Array.isArray(values) ? values.map((value) => ({ ...value })) : [];
    const existingAttributes = Array.isArray(existing) ? existing : [];
    const configuredAttributes = Array.isArray(configured) ? configured : [];
    const categoryRules = Array.isArray(rules) ? rules : [];
    if (!categoryRules.length) return [];
    const findLast = (attributes, key) => {
      for (let index = attributes.length - 1; index >= 0; index -= 1) {
        if (this.categoryAttributeTemplateKey(attributes[index]) === key) return attributes[index];
      }
      return null;
    };
    return categoryRules.map((rule) => {
      const key = this.categoryAttributeTemplateKey(rule);
      // 模板选择优先于商品原值；未配置模板时保留新类目仍认可的原属性值。
      const selected = findLast(configuredAttributes, key) || findLast(existingAttributes, key);
      if (!selected) return null;
      const allowedValueIds = new Set((Array.isArray(rule.values) ? rule.values : [])
        .map((value) => value?.vid).filter((value) => value !== null && value !== undefined && value !== '').map(String));
      const values = cloneValues(selected.values).filter((value) => !filterValues || !allowedValueIds.size || value?.vid === null || value?.vid === undefined || value?.vid === '' || allowedValueIds.has(String(value.vid)));
      if (!values.length) return null;
      return {
        ...selected,
        pid: rule.pid,
        refPid: rule.refPid,
        templatePid: rule.templatePid,
        parentSpecId: rule.parentSpecId,
        name: rule.name,
        values,
      };
    }).filter(Boolean);
  }

  async findPlatformCategoryId(connection, platformCode, externalCategoryId) {
    if (externalCategoryId === null || externalCategoryId === undefined || externalCategoryId === '') return null;
    const [rows] = await connection.execute(`SELECT c.id FROM categories c JOIN category_versions cv ON cv.id = c.category_version_id
      WHERE cv.platform_code = ? AND cv.is_active = 1 AND c.status = 1 AND c.external_category_id = ? LIMIT 1`, [platformCode, String(externalCategoryId)]);
    return rows.length ? Number(rows[0].id) : null;
  }

  async getSavedCommonCategoryAttributeTemplate(connection, userId, categoryId) {
    if (!categoryId) return { saleAttributes: [], productAttributes: [], basicRequiredFields: {} };
    const [rows] = await connection.execute(`SELECT attribute_values, basic_required_fields FROM user_common_category_attribute_templates
      WHERE user_id = ? AND category_id = ? LIMIT 1`, [Number(userId), Number(categoryId)]);
    return {
      ...this.normalizeCategoryAttributeTemplateValues(this.parseJsonColumn(rows[0]?.attribute_values, {})),
      basicRequiredFields: this.normalizeBasicRequiredFields(this.parseJsonColumn(rows[0]?.basic_required_fields, {})),
    };
  }

  applyCommonCategoryAttributeTemplate(detail, templateValues) {
    const merge = (existing, configured, onlyIfMissing) => {
      const result = Array.isArray(existing) ? existing.map((attribute) => ({ ...attribute, values: Array.isArray(attribute?.values) ? attribute.values.map((value) => ({ ...value })) : [] })) : [];
      for (const configuredAttribute of configured || []) {
        const key = this.categoryAttributeTemplateKey(configuredAttribute);
        const index = result.findIndex((attribute) => this.categoryAttributeTemplateKey(attribute) === key);
        if (index >= 0 && onlyIfMissing && result[index].values.length) continue;
        const next = index >= 0
          // 同类目回填仅更新模板选择的值，保留商品原始类目规则 ID。
          ? { ...result[index], name: configuredAttribute.name || result[index].name, values: configuredAttribute.values.map((value) => ({ ...value })) }
          : {
            pid: configuredAttribute.pid, refPid: configuredAttribute.refPid, templatePid: configuredAttribute.templatePid,
            parentSpecId: configuredAttribute.parentSpecId, name: configuredAttribute.name,
            values: configuredAttribute.values.map((value) => ({ ...value })),
          };
        if (index >= 0) result[index] = next;
        else result.push(next);
      }
      return result;
    };
    // 销售属性由采集商品自身的 SKU/规格决定，不参与类目属性模板回填。
    const saleAttributes = Array.isArray(detail.saleAttributes) ? detail.saleAttributes.map((attribute) => ({ ...attribute, values: Array.isArray(attribute?.values) ? attribute.values.map((value) => ({ ...value })) : [] })) : [];
    const productAttributes = merge(detail.attributes || detail.sourceAttrs, templateValues.productAttributes, false);
    const basic = this.normalizeBasicRequiredFields(templateValues.basicRequiredFields);
    const appliedBasicFieldCount = Object.values(basic).filter((value) => Array.isArray(value) ? value.length : Boolean(value)).length;
    const appliedCount = (templateValues.productAttributes?.length || 0) + appliedBasicFieldCount;
    return {
      ...detail, saleAttributes, attributes: productAttributes, sourceAttrs: productAttributes,
      productOriginCountry: basic.productOriginCountry || detail.productOriginCountry,
      productOriginProvince: basic.productOriginProvince || detail.productOriginProvince,
      outerPackageShape: basic.outerPackageShape?.key || detail.outerPackageShape,
      outerPackageType: basic.outerPackageType?.key || detail.outerPackageType,
      outerPackageImgUrls: basic.outerPackageImgUrls.length ? basic.outerPackageImgUrls : detail.outerPackageImgUrls,
      manufacturingLocationRegionShortNameList: basic.manufacturingLocationRegionShortNameList.length ? basic.manufacturingLocationRegionShortNameList : detail.manufacturingLocationRegionShortNameList,
      _localAttributeTemplateApplied: appliedCount,
    };
  }

  async createFolderBuilderProduct(userId, input = {}, onProgress = () => {}) {
    let connection;
    let productId = null;
    try {
      const id = Number(userId);
      const categoryId = Number(input.categoryId);
      const productMainId = String(input.productMainId || '').trim().slice(0, 128);
      const files = (Array.isArray(input.files) ? input.files : []).map((file) => ({
        fileName: String(file?.fileName || '').trim(), contentType: String(file?.contentType || '').toLowerCase(),
        relativePath: String(file?.relativePath || file?.fileName || '').trim(), bytes: file?.bytes,
      })).filter((file) => file.fileName && file.contentType.startsWith('image/'));
      if (!Number.isInteger(id) || id < 1) throw new Error('请先登录本机用户。');
      if (!Number.isInteger(categoryId) || categoryId < 1) throw new Error('请先从常用类目中选择建品类目。');
      if (!productMainId) throw new Error('请填写产品主编号。');
      if (!files.length) throw new Error('请选择至少一张图片。');
      if (files.length > 15) throw new Error('一个文件夹最多导入 15 张商品轮播图，请拆分后重试。');
      for (const file of files) {
        const bytes = file.bytes instanceof Uint8Array ? Buffer.from(file.bytes) : Buffer.from(Array.isArray(file.bytes) ? file.bytes : []);
        if (!bytes.length) throw new Error(`图片“${file.fileName}”内容为空。`);
        if (bytes.length > 20 * 1024 * 1024) throw new Error(`图片“${file.fileName}”超过 20MB。`);
        file.buffer = bytes;
      }
      const config = await this.getConfig();
      const appId = String(config.miaoshou.appId || '').trim();
      if (!appId) throw new Error('请先启用妙手 API 配置。');
      const oss = new OssClient(config.oss);
      if (!oss.isConfigured()) throw new Error('OSS 未配置。请先在系统设置中保存并测试 OSS 配置。');
      connection = await this.openConnection(config);
      await this.ensureSourceDetailColumns(connection);
      await this.ensureMiaoshouAuthorizedShopsTables(connection);
      await this.ensureCategoryTables(connection);
      await this.ensureCommonTemplateCategoriesTable(connection);
      await this.ensureCommonCategoryAttributeTemplatesTable(connection);
      await this.ensureImageLibraryTable(connection);
      const [settings] = await connection.execute(`SELECT platform_code, site_code, shop_id FROM automation_publish_settings
        WHERE user_id = ? AND miaoshou_app_id = ? LIMIT 1`, [id, appId]);
      if (!settings.length || !settings[0].platform_code || !settings[0].site_code || !settings[0].shop_id) {
        throw new Error('请先在上架与自动化设置中保存当前妙手账号的目标店铺。');
      }
      const target = settings[0];
      const [shops] = await connection.execute(`SELECT shop_name FROM miaoshou_authorized_shops
        WHERE user_id = ? AND miaoshou_app_id = ? AND platform_code = ? AND site_code = ? AND shop_id = ? AND is_enabled = 1 LIMIT 1`,
      [id, appId, target.platform_code, target.site_code, target.shop_id]);
      if (!shops.length) throw new Error('当前目标店铺无效，请刷新授权店铺后重新选择。');
      const [[category]] = await connection.execute(`SELECT c.id, c.category_name, c.full_path, c.external_category_id
        FROM user_common_categories ucc JOIN categories c ON c.id = ucc.category_id
        JOIN category_versions cv ON cv.id = c.category_version_id
        WHERE ucc.user_id = ? AND c.id = ? AND c.status = 1 AND c.is_leaf = 1 AND cv.is_active = 1 LIMIT 1`, [id, categoryId]);
      if (!category) throw new Error('所选类目不是当前用户的有效常用类目，请重新选择。');
      const template = await this.getSavedCommonCategoryAttributeTemplate(connection, id, categoryId);
      let detail = this.applyCommonCategoryAttributeTemplate({
        itemNum: productMainId,
        cateList: String(category.full_path || category.category_name || '').split(' / ').map((name) => name.trim()).filter(Boolean),
        cid: String(category.external_category_id || ''), imgUrls: [], saleAttributes: [], skuMap: {},
      }, template);
      detail.itemNum = productMainId;
      const sourceProductId = `folder-${crypto.randomUUID()}`;
      const rawData = {
        _miaoshouDetail: detail,
        _folderBuilder: {
          folderName: String(input.folderName || productMainId).trim().slice(0, 255), productMainId,
          miaoshouAppId: appId, platformCode: target.platform_code, siteCode: target.site_code,
          shopId: String(target.shop_id), shopName: shops[0].shop_name,
          importedAt: new Date().toISOString(), files: files.map((file) => ({ name: file.fileName, relativePath: file.relativePath })),
        },
      };
      await onProgress({ stage: 'creating', percent: 5, message: '正在创建商品草稿。' });
      const [created] = await connection.execute(`INSERT INTO products
        (source_miaoshou_app_id, source_platform_code, source_product_id, source_store_id, target_platform_code, current_category_id, title, product_status, raw_data, created_by)
        VALUES (?, 'folder_builder', ?, ?, ?, ?, ?, 'image_processing', CAST(? AS JSON), ?)`, [
        appId, sourceProductId, String(target.shop_id), target.platform_code === 'pddkj' ? 'temu_full' : 'temu_semi', categoryId, productMainId, JSON.stringify(rawData), id,
      ]);
      productId = Number(created.insertId);
      const imageUrls = [];
      const storedFiles = [];
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        await onProgress({ stage: 'uploading', percent: 8 + Math.round((index / files.length) * 70), message: `正在上传轮播图 ${index + 1}/${files.length}。` });
        const uploaded = await oss.uploadFolderBuilderProductImage({ userId: id, productId, fileName: file.fileName, contentType: file.contentType, buffer: file.buffer, index });
        if (!uploaded.ok) throw new Error(`图片“${file.fileName}”上传失败：${uploaded.message}`);
        const contentHash = crypto.createHash('sha256').update(file.buffer).digest('hex');
        const [asset] = await connection.execute(`INSERT INTO assets
          (product_id, storage_provider, bucket_name, object_key, original_url, file_name, mime_type, file_size_bytes, content_hash, asset_kind)
          VALUES (?, 'oss', ?, ?, ?, ?, ?, ?, ?, 'source_image')`, [productId, config.oss.bucket || null, uploaded.objectKey, uploaded.publicUrl, file.fileName, uploaded.contentType, uploaded.fileSize, contentHash]);
        await connection.execute(`INSERT INTO product_images (product_id, asset_id, image_group, sort_order, is_selected_for_draft)
          VALUES (?, ?, 'source', ?, 1)`, [productId, asset.insertId, index]);
        await this.registerImageLibraryEntry(connection, id, uploaded.publicUrl, { type: 'folder_builder_image', productId, productMainId, relativePath: file.relativePath });
        imageUrls.push(uploaded.publicUrl);
        storedFiles.push({ name: file.fileName, relativePath: file.relativePath, url: uploaded.publicUrl, objectKey: uploaded.objectKey });
      }
      detail.imgUrls = imageUrls;
      const nonImageDescriptionRequests = (Array.isArray(detail.goodsLayerDecorationReqs) ? detail.goodsLayerDecorationReqs : [])
        .filter((request) => request?.type !== 'image');
      detail.goodsLayerDecorationReqs = [
        ...nonImageDescriptionRequests,
        ...imageUrls.map((imgUrl) => ({ type: 'image', content: { imgUrl } })),
      ];
      rawData._miaoshouDetail = detail;
      rawData._folderBuilder.files = storedFiles;
      await connection.execute(`UPDATE products SET product_status = 'pending_process', raw_data = CAST(? AS JSON), updated_at = NOW() WHERE id = ?`, [JSON.stringify(rawData), productId]);
      await onProgress({ stage: 'completed', percent: 100, message: `商品已创建，已导入 ${imageUrls.length} 张轮播图和描述图。` });
      return { ok: true, productId, productMainId, category: { id: Number(category.id), fullPath: category.full_path || category.category_name }, imageUrls,
        appliedCount: Number(detail._localAttributeTemplateApplied) || 0, message: `商品草稿已创建，已上传 ${imageUrls.length} 张轮播图和描述图，并回填 ${Number(detail._localAttributeTemplateApplied) || 0} 项类目模板字段。` };
    } catch (error) {
      if (connection && productId) {
        try { await connection.execute(`UPDATE products SET product_status = 'failed', last_error_code = 'FOLDER_BUILDER_IMPORT_FAILED', last_error_message = ?, updated_at = NOW() WHERE id = ?`, [String(error.message || '文件夹建品失败').slice(0, 2000), productId]); } catch (_) { /* 保留原始导入错误 */ }
      }
      return { ok: false, code: error.code || 'FOLDER_BUILDER_IMPORT_FAILED', productId, message: error.message || '文件夹建品失败。' };
    } finally { if (connection) await connection.end(); }
  }

  async generateFolderBuilderSkus(userId, productId, onProgress = () => {}, options = {}) {
    let connection;
    let generationRecordId = null;
    let rawRecord = { requests: [] };
    try {
      const id = Number(userId); const targetProductId = Number(productId);
      if (!Number.isInteger(id) || id < 1 || !Number.isInteger(targetProductId) || targetProductId < 1) throw new Error('SKU 识别任务参数无效。');
      const config = await this.getConfig();
      connection = await this.openConnection(config);
      await this.ensureFolderBuilderSettingsTable(connection);
      await this.ensureImageProductBuilderTables(connection);
      await this.ensureAiGenerationRecordsTable(connection);
      await this.ensureFieldMappingsTable(connection);
      await this.ensureCommonCategoryAttributeTemplatesTable(connection);
      await onProgress({ stage: 'preparing_sku', percent: 5, message: '正在读取 SKU AI 识别配置。', productId: targetProductId });
      const [[product]] = await connection.execute(`SELECT id, source_platform_code, title, current_category_id, raw_data, ai_generated_image_urls FROM products
        WHERE id = ? AND created_by = ? AND (source_platform_code IN ('folder_builder', 'image_product_builder') OR JSON_CONTAINS_PATH(raw_data, 'one', '$._folderBuilder', '$._imageProductBuilder')) AND deleted_at IS NULL LIMIT 1`, [targetProductId, id]);
      if (!product) throw new Error('仅支持文件夹建品或以图建品商品进行 SKU 识别。');
      const productRawData = this.parseJsonColumn(product.raw_data, {});
      const imageProductBuilder = productRawData._imageProductBuilder || {};
      const isImageProductBuilder = product.source_platform_code === 'image_product_builder' || Boolean(productRawData._imageProductBuilder);
      const [[settings]] = isImageProductBuilder
        ? await connection.execute(`SELECT sku_ai_enabled, sku_model_provider_id AS model_provider_id, sku_template_id AS template_id, sku_prompt AS prompt_content
          FROM image_product_builder_settings WHERE user_id = ? AND builder_type = 'tablecloth' LIMIT 1`, [id])
        : await connection.execute(`SELECT sku_ai_enabled, model_provider_id, template_id, prompt_content
          FROM folder_builder_settings WHERE user_id = ? LIMIT 1`, [id]);
      if (!settings?.sku_ai_enabled && options.manual !== true) return { ok: true, skipped: true, message: isImageProductBuilder ? '未启用桌布以图建品 SKU AI 识别。' : '未启用文件夹建品 SKU AI 识别。' };
      const [[provider]] = await connection.execute(`SELECT id, provider_name, provider_type, api_base_url, api_key_value, default_model, failover_models, timeout_seconds, image_adapter, image_size FROM model_providers
        WHERE id = ? AND is_enabled = 1 LIMIT 1`, [Number(settings.model_provider_id)]);
      if (!provider?.api_base_url || !provider?.api_key_value || !provider?.default_model) throw new Error('SKU AI 所选大模型未配置完整。');
      let template = null;
      if (settings.template_id) {
        await this.ensureTemplateStorage(connection);
        const [[row]] = await connection.execute(`SELECT t.id, t.template_name, t.prompt_content FROM templates t
          WHERE t.id = ? AND t.status = 'enabled' AND t.deleted_at IS NULL LIMIT 1`, [Number(settings.template_id)]);
        if (!row) throw new Error('SKU AI 所选提示词模板不可用。');
        template = row;
      }
      const prompt = [template?.prompt_content, settings.prompt_content].filter(Boolean).join('\n\n').trim();
      if (!prompt) throw new Error('请先配置文件夹建品 SKU AI 的提示词。');
      const [[category]] = await connection.execute('SELECT full_path, category_name FROM categories WHERE id = ? LIMIT 1', [product.current_category_id]);
      const [[categorySkuTemplate]] = await connection.execute(`SELECT sku_defaults FROM user_common_category_attribute_templates
        WHERE user_id = ? AND category_id = ? LIMIT 1`, [id, Number(product.current_category_id) || 0]);
      const skuDefaults = this.normalizeSkuDefaults(this.parseJsonColumn(categorySkuTemplate?.sku_defaults, {}));
      const imageSource = options?.manual && options.imageSource === 'ai_generated' ? 'ai_generated' : 'source';
      let imageUrls;
      if (imageSource === 'ai_generated') {
        const generatedImageUrls = this.parseJsonColumn(product.ai_generated_image_urls, []);
        imageUrls = [...new Set([...(Array.isArray(generatedImageUrls) ? generatedImageUrls : []), ...(imageProductBuilder.carouselImageUrls || [])]
          .map((url) => String(url || '').trim()).filter((url) => /^https?:\/\//i.test(url)))].slice(0, 10);
      } else {
        const [images] = await connection.execute(`SELECT a.original_url FROM product_images pi JOIN assets a ON a.id = pi.asset_id
          WHERE pi.product_id = ? AND pi.image_group = 'source' AND a.deleted_at IS NULL ORDER BY pi.sort_order, pi.id LIMIT 10`, [targetProductId]);
        imageUrls = images.map((image) => String(image.original_url || '').trim()).filter((url) => /^https?:\/\//i.test(url));
        if (!imageUrls.length && isImageProductBuilder) imageUrls = [...new Set([...(imageProductBuilder.originalImageUrls || []), ...(imageProductBuilder.carouselImageUrls || [])]
          .map((url) => String(url || '').trim()).filter((url) => /^https?:\/\//i.test(url)))].slice(0, 10);
      }
      const imageSourceLabel = imageSource === 'ai_generated' ? (isImageProductBuilder ? '任务轮播图' : 'AI 生成轮播图') : (isImageProductBuilder ? '任务原图和轮播图' : '商品轮播图');
      if (!imageUrls.length) throw new Error(`当前商品没有可用于 SKU 识别的${imageSourceLabel}。`);
      await onProgress({ stage: 'preparing_sku', percent: 20, message: `已读取 ${imageUrls.length} 张${imageSourceLabel}，正在准备识别。`, productId: targetProductId });
      const detail = productRawData._miaoshouDetail || {};
      const taskPrompt = `${prompt}\n\n你正在根据${imageSourceLabel}创建 SKU 草稿。商品主编号：${detail.itemNum || product.title}；类目：${category?.full_path || category?.category_name || '未命名'}。\n请只识别图片中的明确尺码规格，尤其是尺寸图；不要创建颜色属性，也不要猜测无法确认的信息。仅返回 JSON：{"skus":[{"size":"尺码必填","imageIndex":1,"name":"可为空"}]}。imageIndex 必须是 1 到 ${imageUrls.length} 的图片序号。`;
      const isZhipu = provider.provider_type === 'zhipu';
      rawRecord = { requests: [] };
      generationRecordId = await this.createAiGenerationRecord(connection, { userId: id, productId: targetProductId, productTitle: product.title, generationType: 'folder_sku', modelProviderId: provider.id, modelName: provider.default_model,
        templates: template ? [{ id: Number(template.id), name: template.template_name }] : [], inputSummary: { imageCount: imageUrls.length, imageSource, categoryId: product.current_category_id }, rawData: rawRecord });
      const reportProgress = async (percent, message, stage = 'generating_sku', finished = false) => {
        await this.updateAiGenerationRecord(connection, generationRecordId, { rawData: rawRecord, progressPercent: percent, progressMessage: message, finished });
        await onProgress({ stage, percent, message, productId: targetProductId, generationRecordId });
      };
      await connection.execute("UPDATE products SET product_status = 'sku_recognizing', updated_at = NOW() WHERE id = ?", [targetProductId]);
      await reportProgress(30, 'SKU 识别任务已创建，正在提交图片和提示词。');
      await reportProgress(45, '已提交模型，正在识别轮播图中的 SKU 规格。');
      const timeoutMs = modelTimeoutMs(provider);
      const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      let requestResult;
      try {
        requestResult = await this.requestWithModelFailover({
          provider, signal: controller.signal, timeoutMs,
          buildRequest: (model) => {
            const requestBody = { model, messages: [{ role: 'user', content: [{ type: 'text', text: taskPrompt }, ...imageUrls.map((url) => ({ type: 'image_url', image_url: { url } }))] }], temperature: isZhipu ? 1 : 0.2, max_tokens: 2048,
              ...(isZhipu ? { thinking: { type: 'enabled', clear_thinking: true } } : {}) };
            return { endpoint: modelClient.chatEndpoint(provider), headers: { Authorization: `Bearer ${provider.api_key_value}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(requestBody), request: requestBody };
          },
          onAttempt: async ({ attempt, totalAttempts, endpoint, request }) => { rawRecord.requests.push({ attempt, totalAttempts, endpoint, method: 'POST', request, requestedAt: new Date().toISOString() }); await this.updateAiGenerationRecord(connection, generationRecordId, { rawData: rawRecord }); },
          onFailure: async ({ attempt, error }) => { const snapshot = rawRecord.requests[attempt - 1]; if (snapshot) snapshot.error = String(error?.message || '模型调用失败').slice(0, 1000); await this.updateAiGenerationRecord(connection, generationRecordId, { rawData: rawRecord }); },
        });
        response = requestResult.payload;
      } finally { clearTimeout(timeout); }
      const payload = response;
      rawRecord.response = payload;
      await reportProgress(75, '模型已返回结果，正在解析 SKU 数据。');
      const result = jsonFromModelText(chatCompletionText(payload));
      const candidates = (Array.isArray(result?.skus) ? result.skus : []).slice(0, 30).map((sku, index) => ({
        size: String(sku?.size || '').trim().slice(0, 255),
        name: String(sku?.name || '').trim().slice(0, 500), imageIndex: Number(sku?.imageIndex), index,
      })).filter((sku) => Number.isInteger(sku.imageIndex) && sku.imageIndex >= 1 && sku.imageIndex <= imageUrls.length && sku.size)
        .filter((sku, index, all) => all.findIndex((candidate) => candidate.size === sku.size) === index);
      if (!candidates.length) throw new Error('模型未识别到可确认的 SKU；已保留商品轮播图，请在编辑页手动填写 SKU。');
      const [existingSkuRows] = await connection.execute(`SELECT attribute_data, draft_data FROM product_skus
        WHERE product_id = ? AND source_sku_id LIKE 'folder-sku-%' AND deleted_at IS NULL`, [targetProductId]);
      const existingSkuBySize = new Map(existingSkuRows.map((row) => {
        const attributes = this.parseJsonColumn(row.attribute_data, {});
        return [String(attributes?.size || '').trim(), this.parseJsonColumn(row.draft_data, {})];
      }).filter(([size]) => size));
      const hasTemplateValues = (values) => Object.entries(values || {}).some(([key, value]) => key !== 'rules' && value !== null && value !== '');
      const templateEnabled = hasTemplateValues(skuDefaults) || skuDefaults.rules.length > 0;
      await reportProgress(90, templateEnabled ? `已识别 ${candidates.length} 个 SKU，正在应用类目 SKU 填充模板。` : `已识别 ${candidates.length} 个 SKU，正在写入商品草稿。`);
      const sizeValues = []; const skuMap = {};
      candidates.forEach((candidate, index) => {
        const skuKey = `;${candidate.size};`; const imageUrl = imageUrls[candidate.imageIndex - 1];
        sizeValues.push({ vid: 0, name: candidate.size, skuKey, imgUrl: imageUrl, imgUrls: [imageUrl], itemNum: null });
        const productMainId = detail.itemNum || product.title;
        const previous = existingSkuBySize.get(candidate.size) || {};
        const matchedRule = skuDefaults.rules.find((rule) => {
          const size = candidate.size.toLocaleLowerCase(); const value = rule.matchValue.toLocaleLowerCase();
          return rule.matchType === 'size_exact' ? size === value : size.includes(value);
        }) || null;
        // 规则仅覆盖类目默认值；已有草稿数据仍有最高优先级，重新识别不会覆盖人工编辑。
        const ruleValues = Object.fromEntries(Object.entries(matchedRule?.values || {}).filter(([, value]) => value !== null && value !== ''));
        const appliedDefaults = { ...skuDefaults, ...ruleValues };
        const templateItemNum = appliedDefaults.skuCodeRule
          ? appliedDefaults.skuCodeRule.replace(/\{productMainId\}/g, String(productMainId)).replace(/\{index\}/g, String(index + 1))
          : `${productMainId}-${index + 1}`;
        skuMap[skuKey] = { itemNum: previous.itemNum || templateItemNum, imgUrl: imageUrl, price: previous.price ?? appliedDefaults.price, suggestedPrice: previous.suggestedPrice ?? appliedDefaults.suggestedPrice ?? '100', suggestedPriceCurrencyType: previous.suggestedPriceCurrencyType || appliedDefaults.currency || 'CNY', stock: previous.stock ?? appliedDefaults.stock, weight: previous.weight ?? appliedDefaults.weight, length: previous.length ?? appliedDefaults.length, width: previous.width ?? appliedDefaults.width, height: previous.height ?? appliedDefaults.height, skuClassification: previous.skuClassification ?? 1, numberOfPieces: previous.numberOfPieces ?? 1, pieceUnitCode: previous.pieceUnitCode ?? appliedDefaults.pieceUnitCode ?? 1, _folderBuilderCandidate: candidate, _categorySkuTemplateApplied: templateEnabled ? { defaults: skuDefaults, matchedRule } : null };
      });
      const saleAttributes = [];
      if (sizeValues.length) saleAttributes.push({ pid: null, name: '尺码', refPid: null, values: sizeValues, templatePid: null, parentSpecId: 3001 });
      const productRaw = productRawData;
      const { colorPropName: _colorPropName, colorMap: _colorMap, ...detailWithoutColor } = detail;
      productRaw._miaoshouDetail = { ...detailWithoutColor, saleAttributes, skuMap };
      if (isImageProductBuilder) productRaw._imageProductBuilder = { ...imageProductBuilder, skuGeneratedAt: new Date().toISOString(), skuCandidates: candidates, skuTemplateSnapshot: templateEnabled ? skuDefaults : null };
      else productRaw._folderBuilder = { ...(productRaw._folderBuilder || {}), skuGeneratedAt: new Date().toISOString(), skuCandidates: candidates, skuTemplateSnapshot: templateEnabled ? skuDefaults : null };
      await connection.beginTransaction();
      await connection.execute("DELETE FROM product_skus WHERE product_id = ? AND source_sku_id LIKE 'folder-sku-%'", [targetProductId]);
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index]; const skuKey = `;${candidate.size};`;
        await connection.execute(`INSERT INTO product_skus (product_id, source_sku_id, sku_code, sku_name, attribute_data, source_data, draft_data, sort_order)
          VALUES (?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), ?)`, [targetProductId, `folder-sku-${index + 1}`, skuMap[skuKey].itemNum, candidate.name || candidate.size || `SKU ${index + 1}`,
          JSON.stringify({ size: candidate.size }), JSON.stringify(candidate), JSON.stringify(skuMap[skuKey]), index]);
      }
      await connection.execute(`UPDATE products SET raw_data = CAST(? AS JSON), product_status = 'sku_recognized', updated_at = NOW() WHERE id = ?`, [JSON.stringify(productRaw), targetProductId]);
      await connection.commit();
      const completionMessage = `已生成 ${candidates.length} 个 SKU 草稿${templateEnabled ? '，已应用类目 SKU 填充模板' : ''}，等待人工确认。`;
      await this.updateAiGenerationRecord(connection, generationRecordId, { status: 'succeeded', successCount: candidates.length, outputSummary: { skuCount: candidates.length, candidates, skuTemplate: templateEnabled ? skuDefaults : null, actualModel: requestResult?.model || provider.default_model, failoverAttempt: requestResult?.attempt || 1 }, rawData: rawRecord, progressPercent: 100, progressMessage: completionMessage, finished: true });
      await onProgress({ stage: 'sku_completed', percent: 100, message: completionMessage, productId: targetProductId, generationRecordId });
      return { ok: true, productId: targetProductId, generationRecordId, skuCount: candidates.length, message: `已生成 ${candidates.length} 个 SKU 草稿。` };
    } catch (error) {
      if (connection && generationRecordId) {
        try {
          const message = error?.code === 'MODEL_TIMEOUT' || error.name === 'AbortError' ? `SKU 识别超时（${Math.round(modelTimeoutMs(provider) / 1000)} 秒），请检查模型服务和网络。` : (error.message || 'SKU 识别失败。');
          await this.updateAiGenerationRecord(connection, generationRecordId, { status: 'failed', failedCount: 1, errorMessage: message, rawData: rawRecord, progressPercent: 100, progressMessage: message, finished: true });
          await connection.execute("UPDATE products SET product_status = 'sku_recognition_failed', last_error_code = 'FOLDER_SKU_ERROR', last_error_message = ?, updated_at = NOW() WHERE id = ?", [String(message).slice(0, 2000), Number(productId)]);
          await onProgress({ stage: 'sku_failed', percent: 100, message, productId: Number(productId), generationRecordId });
        } catch (_) { /* 保留原始错误 */ }
      }
      return { ok: false, code: error?.code === 'MODEL_TIMEOUT' || error.name === 'AbortError' ? 'FOLDER_SKU_TIMEOUT' : (error.code || 'FOLDER_SKU_ERROR'), message: error?.code === 'MODEL_TIMEOUT' || error.name === 'AbortError' ? 'SKU 识别超时，请检查模型服务和网络。' : (error.message || 'SKU 识别失败。') };
    } finally { if (connection) await connection.end(); }
  }

  async uploadCommonCategoryPackageImage(userId, categoryId, file) {
    let connection;
    try {
      const id = Number(userId);
      const targetCategoryId = Number(categoryId);
      if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(targetCategoryId) || targetCategoryId <= 0) {
        return { ok: false, code: 'VALIDATION_ERROR', message: '常用类目参数无效。' };
      }
      const bytes = file?.bytes instanceof Uint8Array ? Buffer.from(file.bytes) : Buffer.from(Array.isArray(file?.bytes) ? file.bytes : []);
      if (!bytes.length) return { ok: false, code: 'VALIDATION_ERROR', message: '请选择要上传的图片。' };
      const config = await this.getConfig();
      const oss = new OssClient(config.oss);
      const uploaded = await oss.uploadCommonCategoryPackageImage({ userId: id, categoryId: targetCategoryId, fileName: file?.fileName, contentType: file?.contentType, buffer: bytes });
      if (!uploaded.ok) return uploaded;
      connection = await this.openConnection(config);
      await this.ensureCommonTemplateCategoriesTable(connection);
      await this.ensureCommonCategoryAttributeTemplatesTable(connection);
      const [memberships] = await connection.execute('SELECT category_id FROM user_common_categories WHERE user_id = ? AND category_id = ? LIMIT 1', [id, targetCategoryId]);
      if (!memberships.length) return { ok: false, code: 'NOT_FOUND', message: '该类目不在常用类目中。' };
      const [templates] = await connection.execute('SELECT attribute_values, basic_required_fields FROM user_common_category_attribute_templates WHERE user_id = ? AND category_id = ? LIMIT 1', [id, targetCategoryId]);
      const existingValues = this.normalizeCategoryAttributeTemplateValues(this.parseJsonColumn(templates[0]?.attribute_values, {}));
      const basicRequiredFields = this.normalizeBasicRequiredFields(this.parseJsonColumn(templates[0]?.basic_required_fields, {}));
      basicRequiredFields.outerPackageImgUrls = [...new Set([...basicRequiredFields.outerPackageImgUrls, uploaded.publicUrl])];
      await connection.execute(`INSERT INTO user_common_category_attribute_templates (user_id, category_id, attribute_values, basic_required_fields)
        VALUES (?, ?, CAST(? AS JSON), CAST(? AS JSON)) ON DUPLICATE KEY UPDATE basic_required_fields = VALUES(basic_required_fields), updated_at = NOW()`,
      [id, targetCategoryId, JSON.stringify(existingValues), JSON.stringify(basicRequiredFields)]);
      await this.registerImageLibraryEntry(connection, id, uploaded.publicUrl, { type: 'category_template_image', categoryId: targetCategoryId });
      return {
        ok: true,
        publicUrl: uploaded.publicUrl,
        outerPackageImgUrls: basicRequiredFields.outerPackageImgUrls,
        packageImagePreviewUrls: basicRequiredFields.outerPackageImgUrls.map((url) => oss.previewUrl(url)),
        message: '外包装图片已上传 OSS 并保存到类目属性模板。',
      };
    } catch (error) {
      return { ok: false, code: error.code || 'OSS_UPLOAD_ERROR', message: error.message };
    } finally { if (connection) await connection.end(); }
  }

  async uploadProductDescriptionImage(userId, productId, file) {
    let connection;
    try {
      const ownerId = Number(userId);
      const id = Number(productId);
      if (!Number.isInteger(ownerId) || ownerId <= 0 || !Number.isInteger(id) || id <= 0) {
        return { ok: false, code: 'VALIDATION_ERROR', message: '商品或用户参数无效。' };
      }
      const bytes = file?.bytes instanceof Uint8Array ? Buffer.from(file.bytes) : Buffer.from(Array.isArray(file?.bytes) ? file.bytes : []);
      if (!bytes.length) return { ok: false, code: 'VALIDATION_ERROR', message: '请选择要上传的图片。' };
      const config = await this.getConfig();
      connection = await this.openConnection(config);
      const [products] = await connection.execute('SELECT id FROM products WHERE id = ? AND deleted_at IS NULL LIMIT 1', [id]);
      if (!products.length) return { ok: false, code: 'PRODUCT_NOT_FOUND', message: '商品不存在或已删除。' };
      const oss = new OssClient(config.oss);
      const uploaded = await oss.uploadProductDescriptionImage({ userId: ownerId, productId: id, fileName: file?.fileName, contentType: file?.contentType, buffer: bytes });
      if (!uploaded.ok) return uploaded;
      await this.registerImageLibraryEntry(connection, ownerId, uploaded.publicUrl, { type: 'uploaded_image', productId: id });
      return {
        ok: true,
        publicUrl: uploaded.publicUrl,
        previewUrl: uploaded.previewUrl,
        message: '产品描述图已上传 OSS；保存商品后会写入回写数据。',
      };
    } catch (error) {
      return { ok: false, code: error.code || 'OSS_UPLOAD_ERROR', message: error.message };
    } finally { if (connection) await connection.end(); }
  }

  async saveCommonTemplateCategoryAttributes(userId, categoryId, attributeValues) {
    let connection;
    try {
      const id = Number(userId);
      const targetCategoryId = Number(categoryId);
      if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(targetCategoryId) || targetCategoryId <= 0) {
        return { ok: false, code: 'VALIDATION_ERROR', message: '常用类目参数无效。' };
      }
      const normalized = this.normalizeCategoryAttributeTemplateValues(attributeValues);
      const basicRequiredFields = this.normalizeBasicRequiredFields(attributeValues?.basicRequiredFields);
      const skuDefaults = this.normalizeSkuDefaults(attributeValues?.skuDefaults);
      connection = await this.openConnection(await this.getConfig());
      await this.ensureCommonTemplateCategoriesTable(connection);
      await this.ensureCommonCategoryAttributeTemplatesTable(connection);
      const [categories] = await connection.execute('SELECT category_id FROM user_common_categories WHERE user_id = ? AND category_id = ? LIMIT 1', [id, targetCategoryId]);
      if (!categories.length) return { ok: false, code: 'NOT_FOUND', message: '该类目不在常用类目中。' };
      // 属性规则里的 parentVidList 表示下级值所依赖的父属性值。模板若只存子属性，
      // 妙手会在回写时拒绝请求；在保存模板时就给出可操作的提示。
      const [[ruleCache]] = await connection.execute(`SELECT product_attribute_rules FROM user_common_category_attributes
        WHERE user_id = ? AND category_id = ? LIMIT 1`, [id, targetCategoryId]);
      const productRules = Array.isArray(this.parseJsonColumn(ruleCache?.product_attribute_rules, []))
        ? this.parseJsonColumn(ruleCache?.product_attribute_rules, []) : [];
      const rulesByTemplatePid = new Map(productRules
        .filter((rule) => rule?.templatePid !== null && rule?.templatePid !== undefined && rule.templatePid !== '')
        .map((rule) => [String(rule.templatePid), rule]));
      const selectedByTemplatePid = new Map(normalized.productAttributes
        .filter((attribute) => attribute?.templatePid !== null && attribute?.templatePid !== undefined && attribute.templatePid !== '')
        .map((attribute) => [String(attribute.templatePid), attribute]));
      for (const selectedAttribute of normalized.productAttributes) {
        const rule = rulesByTemplatePid.get(String(selectedAttribute.templatePid ?? ''));
        const parentTemplatePid = rule?.parentTemplatePid;
        if (!parentTemplatePid) continue;
        const parentRule = rulesByTemplatePid.get(String(parentTemplatePid));
        const parentSelection = selectedByTemplatePid.get(String(parentTemplatePid));
        for (const selectedValue of selectedAttribute.values || []) {
          const parentVidList = Array.isArray(selectedValue?.parentVidList) ? selectedValue.parentVidList.map(String) : [];
          if (!parentVidList.length) continue;
          const selectedParentIds = new Set((parentSelection?.values || []).map((value) => String(value?.vid ?? '')));
          if (parentVidList.some((vid) => selectedParentIds.has(vid))) continue;
          const expectedNames = (parentRule?.values || [])
            .filter((value) => parentVidList.includes(String(value?.vid ?? '')))
            .map((value) => value?.name)
            .filter(Boolean);
          return {
            ok: false,
            code: 'ATTRIBUTE_DEPENDENCY_ERROR',
            message: `属性【${selectedAttribute.name}】选择【${selectedValue?.name || selectedValue?.vid}】时，父属性【${parentRule?.name || parentTemplatePid}】必须选择【${expectedNames.join('、') || parentVidList.join('、')}】。`,
          };
        }
      }
      await connection.execute(`INSERT INTO user_common_category_attribute_templates (user_id, category_id, attribute_values, basic_required_fields, sku_defaults)
        VALUES (?, ?, CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON)) ON DUPLICATE KEY UPDATE attribute_values = VALUES(attribute_values), basic_required_fields = VALUES(basic_required_fields), sku_defaults = VALUES(sku_defaults), updated_at = NOW()`,
      [id, targetCategoryId, JSON.stringify(normalized), JSON.stringify(basicRequiredFields), JSON.stringify(skuDefaults)]);
      return { ok: true, attributeValues: normalized, basicRequiredFields, skuDefaults, message: `已保存 ${normalized.saleAttributes.length + normalized.productAttributes.length} 项类目属性模板、基础字段和 SKU 填充模板。` };
    } catch (error) {
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message };
    } finally { if (connection) await connection.end(); }
  }

  async getMiaoshouProductOriginOptions() {
    try {
      const config = await this.getConfig();
      const countries = await new MiaoshouClient(config.miaoshou).getProductOriginCountries();
      return { ok: true, countries };
    } catch (error) {
      return { ok: false, code: error.code || 'MIAOSHOU_ORIGIN_OPTIONS_ERROR', message: error.message, countries: [] };
    }
  }

  async ensureSyncRunsTable(connection) {
    await connection.query(`CREATE TABLE IF NOT EXISTS sync_runs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      trigger_type VARCHAR(16) NOT NULL COMMENT 'manual/scheduled',
      status VARCHAR(16) NOT NULL COMMENT 'running/succeeded/failed/skipped',
      started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at DATETIME NULL,
      fetched_count INT UNSIGNED NOT NULL DEFAULT 0,
      created_count INT UNSIGNED NOT NULL DEFAULT 0,
      updated_count INT UNSIGNED NOT NULL DEFAULT 0,
      error_code VARCHAR(128) NULL,
      error_message VARCHAR(2000) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_sync_runs_status_started (status, started_at),
      KEY idx_sync_runs_trigger_started (trigger_type, started_at)
    ) ENGINE=InnoDB COMMENT='妙手采集箱同步记录'`);
  }

  async ensureScheduledJobTables(connection) {
    await connection.query(`CREATE TABLE IF NOT EXISTS scheduled_jobs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NULL,
      job_type VARCHAR(48) NOT NULL,
      title VARCHAR(255) NOT NULL,
      migration_key VARCHAR(96) NULL,
      schedule_type VARCHAR(24) NOT NULL DEFAULT 'once',
      scheduled_at DATETIME NOT NULL,
      next_run_at DATETIME NOT NULL,
      interval_seconds INT UNSIGNED NULL,
      status VARCHAR(24) NOT NULL DEFAULT 'queued',
      payload JSON NULL,
      progress_percent TINYINT UNSIGNED NOT NULL DEFAULT 0,
      progress_message VARCHAR(500) NULL,
      last_error VARCHAR(2000) NULL,
      last_started_at DATETIME NULL,
      last_finished_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_scheduled_jobs_migration_key (migration_key),
      KEY idx_scheduled_jobs_due (status, next_run_at),
      KEY idx_scheduled_jobs_user_created (user_id, created_at),
      CONSTRAINT fk_scheduled_jobs_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
    ) ENGINE=InnoDB COMMENT='统一定时任务队列'`);
    const [jobColumns] = await connection.query('SHOW COLUMNS FROM scheduled_jobs');
    if (!jobColumns.some((column) => column.Field === 'migration_key')) {
      await connection.query("ALTER TABLE scheduled_jobs ADD COLUMN migration_key VARCHAR(96) NULL AFTER title");
      await connection.query('ALTER TABLE scheduled_jobs ADD UNIQUE KEY uk_scheduled_jobs_migration_key (migration_key)');
    }
    await connection.query(`CREATE TABLE IF NOT EXISTS scheduled_job_items (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      job_id BIGINT UNSIGNED NOT NULL,
      item_type VARCHAR(48) NOT NULL,
      title VARCHAR(255) NOT NULL,
      target_id BIGINT UNSIGNED NULL,
      status VARCHAR(24) NOT NULL DEFAULT 'queued',
      progress_percent TINYINT UNSIGNED NOT NULL DEFAULT 0,
      progress_message VARCHAR(500) NULL,
      payload JSON NULL,
      error_message VARCHAR(2000) NULL,
      started_at DATETIME NULL,
      finished_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_scheduled_job_items_job (job_id, id),
      CONSTRAINT fk_scheduled_job_items_job FOREIGN KEY (job_id) REFERENCES scheduled_jobs (id) ON DELETE CASCADE
    ) ENGINE=InnoDB COMMENT='定时任务子项'`);
    const [itemColumns] = await connection.query('SHOW COLUMNS FROM scheduled_job_items');
    if (!itemColumns.some((column) => column.Field === 'progress_percent')) await connection.query('ALTER TABLE scheduled_job_items ADD COLUMN progress_percent TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER status');
    if (!itemColumns.some((column) => column.Field === 'progress_message')) await connection.query('ALTER TABLE scheduled_job_items ADD COLUMN progress_message VARCHAR(500) NULL AFTER progress_percent');
    await connection.query(`CREATE TABLE IF NOT EXISTS scheduled_queue_settings (
      user_id BIGINT UNSIGNED NOT NULL,
      enabled TINYINT UNSIGNED NOT NULL DEFAULT 0,
      run_time TIME NULL,
      next_run_at DATETIME NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id),
      CONSTRAINT fk_scheduled_queue_settings_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB COMMENT='生图建品定时队列执行设置'`);
    const [queueColumns] = await connection.query('SHOW COLUMNS FROM scheduled_queue_settings');
    if (!queueColumns.some((column) => column.Field === 'run_time')) await connection.query('ALTER TABLE scheduled_queue_settings ADD COLUMN run_time TIME NULL AFTER enabled');
  }

  scheduledDate(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error('请选择有效的执行时间。');
    return date;
  }

  scheduledMysqlDate(value) {
    const date = this.scheduledDate(value); const pad = (number) => String(number).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  nextScheduledQueueRun(runTime, now = new Date()) {
    const [hours, minutes] = String(runTime).split(':').map(Number);
    const next = new Date(now); next.setHours(hours, minutes, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next;
  }

  async normalizeExpiredScheduledQueueSetting(connection, userId, setting = null) {
    const id = Number(userId);
    const queueSetting = setting || (await connection.execute('SELECT enabled, run_time, next_run_at FROM scheduled_queue_settings WHERE user_id = ? LIMIT 1', [id]))[0][0];
    const runTime = String(queueSetting?.run_time || '');
    const validRunTime = /^([01]\d|2[0-3]):[0-5]\d(?::\d{2})?$/.test(runTime);
    const nextRunAt = queueSetting?.next_run_at ? new Date(queueSetting.next_run_at) : null;
    if (Number(queueSetting?.enabled) !== 1 || !validRunTime || (nextRunAt && nextRunAt > new Date())) return queueSetting;
    const [[pending]] = await connection.execute("SELECT COUNT(*) AS total FROM scheduled_jobs WHERE user_id = ? AND schedule_type = 'queue' AND status = 'queued'", [id]);
    if (Number(pending?.total || 0)) return queueSetting;
    const normalizedNextRunAt = this.scheduledMysqlDate(this.nextScheduledQueueRun(runTime));
    await connection.execute('UPDATE scheduled_queue_settings SET next_run_at = ? WHERE user_id = ?', [normalizedNextRunAt, id]);
    return { ...queueSetting, next_run_at: normalizedNextRunAt };
  }

  async createScheduledJob(userId, input = {}) {
    let connection;
    try {
      const jobType = String(input.jobType || '').trim();
      const supported = new Set(['target_store_collect_box_sync', 'image_product_builder', 'product_image']);
      if (!supported.has(jobType)) throw new Error('不支持的定时任务类型。');
      const numericUserId = Number(userId);
      const ownerId = Number.isInteger(numericUserId) && numericUserId > 0 ? numericUserId : null;
      if (!ownerId && jobType !== 'target_store_collect_box_sync') throw new Error('请先登录本机用户。');
      const scheduleType = ['once', 'interval', 'queue'].includes(String(input.scheduleType)) ? String(input.scheduleType) : 'once';
      const intervalSeconds = scheduleType === 'interval' ? Math.max(10, Number(input.intervalSeconds) || 0) : null;
      if (scheduleType === 'interval' && !intervalSeconds) throw new Error('循环任务请填写至少 10 秒的执行间隔。');
      const scheduledAt = this.scheduledDate(input.scheduledAt || (scheduleType === 'interval' ? new Date(Date.now() + intervalSeconds * 1000) : new Date()));
      const title = String(input.title || '').trim().slice(0, 255);
      if (!title) throw new Error('任务名称不能为空。');
      const payload = input.payload && typeof input.payload === 'object' ? input.payload : {};
      const items = Array.isArray(input.items) ? input.items : [];
      connection = await this.openConnection(await this.getConfig());
      await this.ensureScheduledJobTables(connection);
      let mysqlDate = scheduleType === 'queue' ? '2099-12-31 23:59:59' : this.scheduledMysqlDate(scheduledAt);
      if (scheduleType === 'queue') {
        const [[setting]] = await connection.execute('SELECT enabled, run_time, next_run_at FROM scheduled_queue_settings WHERE user_id = ? LIMIT 1', [ownerId]);
        const queueSetting = await this.normalizeExpiredScheduledQueueSetting(connection, ownerId, setting);
        if (Number(queueSetting?.enabled) === 1 && queueSetting?.next_run_at) mysqlDate = this.scheduledMysqlDate(queueSetting.next_run_at);
      }
      await connection.beginTransaction();
      const [created] = await connection.execute(`INSERT INTO scheduled_jobs (user_id, job_type, title, migration_key, schedule_type, scheduled_at, next_run_at, interval_seconds, status, payload, progress_message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', CAST(? AS JSON), '等待执行。')`, [ownerId, jobType, title, input.migrationKey ? String(input.migrationKey).slice(0, 96) : null, scheduleType, mysqlDate, mysqlDate, intervalSeconds, JSON.stringify(payload)]);
      const jobId = Number(created.insertId);
      for (const [index, item] of items.entries()) {
        await connection.execute(`INSERT INTO scheduled_job_items (job_id, item_type, title, target_id, payload)
          VALUES (?, ?, ?, ?, CAST(? AS JSON))`, [jobId, String(item?.itemType || 'task').slice(0, 48), String(item?.title || `子任务 ${index + 1}`).slice(0, 255), Number(item?.targetId) || null, JSON.stringify(item?.payload && typeof item.payload === 'object' ? item.payload : {})]);
      }
      await connection.commit();
      return { ok: true, jobId, message: `已加入定时任务队列：${title}` };
    } catch (error) {
      if (connection) await connection.rollback().catch(() => {});
      return { ok: false, code: error.code || 'SCHEDULED_JOB_CREATE_ERROR', message: error.message || '创建定时任务失败。' };
    } finally { if (connection) await connection.end(); }
  }

  async getScheduledQueueSettings(userId) {
    let connection;
    try {
      const id = Number(userId); if (!Number.isInteger(id) || id < 1) throw new Error('请先登录本机用户。');
      connection = await this.openConnection(await this.getConfig()); await this.ensureScheduledJobTables(connection);
      const [[savedSetting]] = await connection.execute('SELECT enabled, run_time, next_run_at FROM scheduled_queue_settings WHERE user_id = ? LIMIT 1', [id]);
      const setting = await this.normalizeExpiredScheduledQueueSetting(connection, id, savedSetting);
      return { ok: true, setting: setting || { enabled: 0, run_time: null, next_run_at: null } };
    } catch (error) { return { ok: false, message: error.message, setting: null }; } finally { if (connection) await connection.end(); }
  }

  async saveScheduledQueueSettings(userId, input = {}) {
    let connection;
    try {
      const id = Number(userId); if (!Number.isInteger(id) || id < 1) throw new Error('请先登录本机用户。');
      const enabled = input.enabled !== false;
      const executeNow = input.executeNow === true;
      const runTime = String(input.runTime || '').trim();
      if (enabled && !executeNow && !/^([01]\d|2[0-3]):[0-5]\d$/.test(runTime)) throw new Error('请填写有效的每日执行时间。');
      const nextQueueRun = () => {
        if (executeNow) return new Date();
        const [hours, minutes] = runTime.split(':').map(Number); const date = new Date(); date.setHours(hours, minutes, 0, 0); if (date <= new Date()) date.setDate(date.getDate() + 1); return date;
      };
      const nextRunAt = enabled ? this.scheduledMysqlDate(nextQueueRun()) : null;
      connection = await this.openConnection(await this.getConfig()); await this.ensureScheduledJobTables(connection);
      await connection.beginTransaction();
      await connection.execute(`INSERT INTO scheduled_queue_settings (user_id, enabled, run_time, next_run_at) VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), run_time = VALUES(run_time), next_run_at = VALUES(next_run_at), updated_at = NOW()`, [id, enabled ? 1 : 0, executeNow ? null : runTime, nextRunAt]);
      if (enabled) await connection.execute(`UPDATE scheduled_jobs SET next_run_at = ?, progress_message = '已设置统一队列执行时间，等待执行。', updated_at = NOW()
        WHERE user_id = ? AND schedule_type = 'queue' AND status = 'queued'`, [nextRunAt, id]);
      await connection.commit();
      return { ok: true, message: enabled ? '已保存队列执行时间。' : '已暂停队列执行。' };
    } catch (error) { if (connection) await connection.rollback().catch(() => {}); return { ok: false, message: error.message }; }
    finally { if (connection) await connection.end(); }
  }

  async advanceScheduledQueueSettings(userId) {
    let connection;
    try {
      const id = Number(userId); if (!Number.isInteger(id) || id < 1) return { ok: true };
      connection = await this.openConnection(await this.getConfig()); await this.ensureScheduledJobTables(connection);
      const [[setting]] = await connection.execute('SELECT enabled, run_time FROM scheduled_queue_settings WHERE user_id = ? LIMIT 1', [id]);
      if (Number(setting?.enabled) !== 1) return { ok: true };
      const runTime = String(setting.run_time || '');
      if (!/^([01]\d|2[0-3]):[0-5]\d(?::\d{2})?$/.test(runTime)) {
        await connection.execute('UPDATE scheduled_queue_settings SET enabled = 0, next_run_at = NULL WHERE user_id = ?', [id]);
        return { ok: true };
      }
      const [hours, minutes] = runTime.split(':').map(Number); const next = new Date(); next.setHours(hours, minutes, 0, 0); next.setDate(next.getDate() + 1);
      await connection.execute('UPDATE scheduled_queue_settings SET next_run_at = ? WHERE user_id = ?', [this.scheduledMysqlDate(next), id]);
      return { ok: true };
    } catch (error) { return { ok: false, message: error.message }; } finally { if (connection) await connection.end(); }
  }

  async migrateLegacyTargetStoreSync(config = {}) {
    let connection;
    try {
      const sync = config?.sync || {};
      connection = await this.openConnection(await this.getConfig());
      await this.ensureScheduledJobTables(connection);
      await connection.execute(`UPDATE scheduled_jobs SET status = 'cancelled', progress_message = '已改为统一同步配置管理。', updated_at = NOW()
        WHERE job_type = 'target_store_collect_box_sync' AND migration_key IS NULL AND status IN ('queued', 'active')`);
      if (!sync.enabled) {
        await connection.execute("UPDATE scheduled_jobs SET status = 'cancelled', progress_message = '旧同步配置已关闭。', updated_at = NOW() WHERE migration_key = 'legacy-target-store-sync' AND status IN ('queued', 'active')");
        return { ok: true, skipped: true };
      }
      const intervalSeconds = Math.max(10, Number(sync.intervalSeconds) || 10);
      try {
        const firstRun = this.scheduledMysqlDate(new Date(Date.now() + intervalSeconds * 1000));
        await connection.execute(`INSERT INTO scheduled_jobs (user_id, job_type, title, migration_key, schedule_type, scheduled_at, next_run_at, interval_seconds, status, payload, progress_message)
          VALUES (NULL, 'target_store_collect_box_sync', '目标店铺采集箱同步', 'legacy-target-store-sync', 'interval', ?, ?, ?, 'queued', CAST(? AS JSON), '已从旧同步配置迁移。')
          ON DUPLICATE KEY UPDATE schedule_type = 'interval', interval_seconds = VALUES(interval_seconds), payload = VALUES(payload),
            status = CASE WHEN status IN ('cancelled', 'failed', 'succeeded') THEN 'queued' ELSE status END,
            next_run_at = VALUES(next_run_at), progress_message = '已从同步配置恢复，等待下一次执行。', updated_at = NOW()`, [firstRun, firstRun, intervalSeconds, JSON.stringify({ migratedFromLegacyConfig: true })]);
        const [[legacyJob]] = await connection.execute("SELECT id FROM scheduled_jobs WHERE migration_key = 'legacy-target-store-sync' LIMIT 1");
        if (legacyJob) {
          const [[itemCount]] = await connection.execute('SELECT COUNT(*) AS total FROM scheduled_job_items WHERE job_id = ?', [legacyJob.id]);
          if (!Number(itemCount?.total)) await connection.execute("INSERT INTO scheduled_job_items (job_id, item_type, title) VALUES (?, 'target_store_collect_box_sync', '同步目标店铺采集箱')", [legacyJob.id]);
        }
      } finally { /* connection is closed by the outer finally */ }
      return { ok: true };
    } catch (error) { return { ok: false, message: error.message }; }
    finally { if (connection) await connection.end(); }
  }

  async listScheduledJobs(userId, options = {}) {
    let connection;
    try {
      const numericUserId = Number(userId); const pageSize = Math.max(1, Math.min(100, Number(options.pageSize) || 20)); const requestedPage = Math.max(1, Number(options.page) || 1);
      connection = await this.openConnection(await this.getConfig()); await this.ensureScheduledJobTables(connection);
      const jobTypes = [...new Set((Array.isArray(options.jobTypes) ? options.jobTypes : []).map((value) => String(value || '').trim()).filter(Boolean))];
      const params = []; const conditions = [];
      if (Number.isInteger(numericUserId) && numericUserId > 0) { conditions.push('(j.user_id = ? OR j.user_id IS NULL)'); params.push(numericUserId); }
      if (jobTypes.length) { conditions.push(`j.job_type IN (${jobTypes.map(() => '?').join(', ')})`); params.push(...jobTypes); }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const [[count]] = await connection.execute(`SELECT COUNT(*) AS total FROM scheduled_jobs j ${where}`, params);
      const total = Number(count?.total || 0); const totalPages = Math.max(1, Math.ceil(total / pageSize)); const page = Math.min(requestedPage, totalPages); const offset = (page - 1) * pageSize;
      const [jobs] = await connection.execute(`SELECT j.* FROM scheduled_jobs j ${where} ORDER BY j.created_at DESC, j.id DESC LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
      const ids = jobs.map((job) => Number(job.id));
      const items = ids.length ? (await connection.execute(`SELECT * FROM scheduled_job_items WHERE job_id IN (${ids.map(() => '?').join(', ')}) ORDER BY id ASC`, ids))[0] : [];
      const byJob = new Map(); items.forEach((item) => { const key = Number(item.job_id); if (!byJob.has(key)) byJob.set(key, []); byJob.get(key).push({ ...item, payload: this.parseJsonColumn(item.payload, {}) }); });
      return { ok: true, jobs: jobs.map((job) => ({ ...job, payload: this.parseJsonColumn(job.payload, {}), items: byJob.get(Number(job.id)) || [] })), pagination: { page, pageSize, total, totalPages } };
    } catch (error) { return { ok: false, code: error.code || 'SCHEDULED_JOB_LIST_ERROR', message: error.message, jobs: [], pagination: null }; }
    finally { if (connection) await connection.end(); }
  }

  async updateScheduledJobStatus(jobId, status, fields = {}) {
    let connection;
    try {
      connection = await this.openConnection(await this.getConfig()); await this.ensureScheduledJobTables(connection);
      const id = Number(jobId); if (!Number.isInteger(id) || id < 1) throw new Error('定时任务编号无效。');
      const [result] = await connection.execute(`UPDATE scheduled_jobs SET status = ?, progress_percent = ?, progress_message = ?, last_error = ?, last_started_at = COALESCE(?, last_started_at), last_finished_at = COALESCE(?, last_finished_at), next_run_at = COALESCE(?, next_run_at), updated_at = NOW() WHERE id = ? AND status <> 'cancelled'`, [status, Math.max(0, Math.min(100, Number(fields.percent) || 0)), String(fields.message || '').slice(0, 500) || null, fields.error ? String(fields.error).slice(0, 2000) : null, fields.startedAt || null, fields.finishedAt || null, fields.nextRunAt || null, id]);
      if (result.affectedRows && fields.itemStatus) await connection.execute(`UPDATE scheduled_job_items SET status = ?, progress_percent = ?, progress_message = ?, error_message = ?, started_at = CASE WHEN ? = 'running' THEN NOW() ELSE started_at END, finished_at = CASE WHEN ? IN ('succeeded', 'failed') THEN NOW() ELSE finished_at END WHERE job_id = ?`, [fields.itemStatus, Math.max(0, Math.min(100, Number(fields.percent) || 0)), String(fields.message || '').slice(0, 500) || null, fields.error ? String(fields.error).slice(0, 2000) : null, fields.itemStatus, fields.itemStatus, id]);
      return { ok: true, cancelled: !result.affectedRows };
    } catch (error) { return { ok: false, message: error.message }; } finally { if (connection) await connection.end(); }
  }

  async updateScheduledJobItemStatus(itemId, status, fields = {}) {
    let connection;
    try {
      connection = await this.openConnection(await this.getConfig()); await this.ensureScheduledJobTables(connection);
      const id = Number(itemId); if (!Number.isInteger(id) || id < 1) throw new Error('子任务编号无效。');
      await connection.execute(`UPDATE scheduled_job_items SET status = ?, progress_percent = ?, progress_message = ?, error_message = ?, started_at = CASE WHEN ? = 'running' THEN NOW() ELSE started_at END, finished_at = CASE WHEN ? IN ('succeeded', 'failed') THEN NOW() ELSE finished_at END WHERE id = ?`, [status, Math.max(0, Math.min(100, Number(fields.percent) || 0)), String(fields.message || '').slice(0, 500) || null, fields.error ? String(fields.error).slice(0, 2000) : null, status, status, id]);
      return { ok: true };
    } catch (error) { return { ok: false, message: error.message }; } finally { if (connection) await connection.end(); }
  }

  async isScheduledJobCancelled(jobId) {
    let connection;
    try {
      const id = Number(jobId); if (!Number.isInteger(id) || id < 1) return false;
      connection = await this.openConnection(await this.getConfig()); await this.ensureScheduledJobTables(connection);
      const [[job]] = await connection.execute(`SELECT status FROM scheduled_jobs WHERE id = ? LIMIT 1`, [id]);
      return job?.status === 'cancelled';
    } catch (_) { return false; } finally { if (connection) await connection.end(); }
  }

  async getScheduledJobItemRetryContext(userId, jobId, itemId) {
    let connection;
    try {
      const owner = Number(userId); const job = Number(jobId); const item = Number(itemId);
      if (!Number.isInteger(owner) || owner < 1 || !Number.isInteger(job) || job < 1 || !Number.isInteger(item) || item < 1) throw new Error('重试子任务参数无效。');
      connection = await this.openConnection(await this.getConfig()); await this.ensureScheduledJobTables(connection);
      const [[row]] = await connection.execute(`SELECT j.job_type, j.payload AS job_payload, i.id, i.item_type, i.title, i.payload AS item_payload
        FROM scheduled_jobs j INNER JOIN scheduled_job_items i ON i.job_id = j.id WHERE j.id = ? AND j.user_id = ? AND i.id = ? LIMIT 1`, [job, owner, item]);
      if (!row) throw new Error('子任务不存在或无权操作。');
      const itemPayload = this.parseJsonColumn(row.item_payload, {});
      if (row.item_type === 'carousel_image' && !Number(itemPayload.templateId)) {
        const templateName = String(row.title || '').replace(/^生成轮播图：\s*/, '').trim();
        if (templateName) {
          const [[template]] = await connection.execute("SELECT id FROM templates WHERE template_name = ? AND status = 'enabled' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1", [templateName]);
          if (template) itemPayload.templateId = Number(template.id);
        }
      }
      return { ok: true, jobType: row.job_type, jobPayload: this.parseJsonColumn(row.job_payload, {}), item: { id: Number(row.id), itemType: row.item_type, title: row.title, payload: itemPayload } };
    } catch (error) { return { ok: false, message: error.message }; } finally { if (connection) await connection.end(); }
  }

  async recoverInterruptedScheduledJobs(jobIds = null) {
    let connection;
    try {
      const ids = [...new Set((Array.isArray(jobIds) ? jobIds : []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
      connection = await this.openConnection(await this.getConfig()); await this.ensureScheduledJobTables(connection); await connection.beginTransaction();
      const where = ids.length ? `AND id IN (${ids.map(() => '?').join(', ')})` : '';
      const [jobs] = await connection.execute(`SELECT id, progress_message, last_error FROM scheduled_jobs WHERE status = 'running' ${where} FOR UPDATE`, ids);
      for (const job of jobs) {
        const message = String(job.last_error || job.progress_message || '应用重启时发现任务未正常结束。').slice(0, 2000);
        await connection.execute(`UPDATE scheduled_jobs SET status = 'failed', progress_percent = 100, progress_message = ?, last_error = ?, last_finished_at = NOW(), updated_at = NOW() WHERE id = ?`, [message.slice(0, 500), message, job.id]);
        await connection.execute(`UPDATE scheduled_job_items SET status = 'failed', progress_percent = 100,
          progress_message = COALESCE(NULLIF(error_message, ''), NULLIF(progress_message, ''), ?),
          error_message = COALESCE(NULLIF(error_message, ''), NULLIF(progress_message, ''), ?), finished_at = NOW() WHERE job_id = ?`, [message.slice(0, 500), message, job.id]);
      }
      await connection.commit();
      return { ok: true, recovered: jobs.length };
    } catch (error) {
      if (connection) await connection.rollback().catch(() => {});
      return { ok: false, message: error.message, recovered: 0 };
    } finally { if (connection) await connection.end(); }
  }

  async claimDueScheduledJobs(limit = 3) {
    let connection;
    try {
      connection = await this.openConnection(await this.getConfig()); await this.ensureScheduledJobTables(connection);
      await connection.beginTransaction();
      const [jobs] = await connection.execute(`SELECT j.* FROM scheduled_jobs j LEFT JOIN scheduled_queue_settings q ON q.user_id = j.user_id
        WHERE (j.status IN ('queued', 'active') AND j.schedule_type <> 'queue' AND j.next_run_at <= NOW())
          OR (j.status = 'queued' AND j.schedule_type = 'queue' AND q.enabled = 1 AND q.next_run_at <= NOW())
        ORDER BY j.next_run_at ASC, j.id ASC LIMIT ? FOR UPDATE`, [Math.max(1, Math.min(100, Number(limit) || 1))]);
      for (const job of jobs) {
        await connection.execute(`UPDATE scheduled_jobs SET status = 'running', progress_percent = 1, progress_message = '任务已开始执行。', last_error = NULL, last_started_at = NOW(), updated_at = NOW() WHERE id = ?`, [job.id]);
        await connection.execute(`UPDATE scheduled_job_items SET status = 'running', progress_percent = 1, progress_message = '任务已开始执行。', error_message = NULL, started_at = NOW(), finished_at = NULL WHERE job_id = ?`, [job.id]);
      }
      await connection.commit();
      return jobs.map((job) => ({ ...job, payload: this.parseJsonColumn(job.payload, {}) }));
    } catch (error) { if (connection) await connection.rollback().catch(() => {}); return []; }
    finally { if (connection) await connection.end(); }
  }

  async cancelScheduledJob(userId, jobId) {
    let connection;
    try {
      const id = Number(jobId); const owner = Number(userId);
      if (!Number.isInteger(id) || id < 1 || !Number.isInteger(owner) || owner < 1) throw new Error('取消任务参数无效。');
      connection = await this.openConnection(await this.getConfig()); await this.ensureScheduledJobTables(connection); await connection.beginTransaction();
      const [[job]] = await connection.execute(`SELECT * FROM scheduled_jobs WHERE id = ? AND (user_id = ? OR user_id IS NULL) AND status IN ('queued', 'active', 'running') FOR UPDATE`, [id, owner]);
      if (!job) { await connection.rollback(); return { ok: false, message: '仅可取消待执行或执行中的任务。' }; }
      const message = job.status === 'running' ? '已终止任务。' : '已取消。';
      await connection.execute(`UPDATE scheduled_jobs SET status = 'cancelled', progress_percent = 100, progress_message = ?, last_error = NULL, last_finished_at = NOW(), updated_at = NOW() WHERE id = ?`, [message, id]);
      await connection.execute(`UPDATE scheduled_job_items SET status = 'cancelled', progress_percent = 100, progress_message = ?, error_message = NULL, finished_at = NOW() WHERE job_id = ?`, [message, id]);
      await connection.commit();
      return { ok: true, message: job.status === 'running' ? '任务已终止。' : '定时任务已取消。', job: { ...job, payload: this.parseJsonColumn(job.payload, {}) } };
    } catch (error) { if (connection) await connection.rollback().catch(() => {}); return { ok: false, message: error.message }; } finally { if (connection) await connection.end(); }
  }

  async cancelScheduledJobs(userId, jobIds = []) {
    let connection;
    try {
      const owner = Number(userId); const ids = [...new Set((Array.isArray(jobIds) ? jobIds : []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
      if (!Number.isInteger(owner) || owner < 1 || !ids.length) throw new Error('请选择要取消的任务。');
      connection = await this.openConnection(await this.getConfig()); await this.ensureScheduledJobTables(connection); await connection.beginTransaction();
      const placeholders = ids.map(() => '?').join(', ');
      const [jobs] = await connection.execute(`SELECT * FROM scheduled_jobs WHERE id IN (${placeholders}) AND (user_id = ? OR user_id IS NULL) AND status IN ('queued', 'active', 'running') FOR UPDATE`, [...ids, owner]);
      if (!jobs.length) { await connection.rollback(); return { ok: false, message: '所选任务中没有可取消的任务。' }; }
      const targetIds = jobs.map((job) => Number(job.id)); const targetPlaceholders = targetIds.map(() => '?').join(', ');
      await connection.execute(`UPDATE scheduled_jobs SET status = 'cancelled', progress_percent = 100, progress_message = '已批量取消。', last_error = NULL, last_finished_at = NOW(), updated_at = NOW() WHERE id IN (${targetPlaceholders})`, targetIds);
      await connection.execute(`UPDATE scheduled_job_items SET status = 'cancelled', progress_percent = 100, progress_message = '已批量取消。', error_message = NULL, finished_at = NOW() WHERE job_id IN (${targetPlaceholders})`, targetIds);
      await connection.commit();
      return { ok: true, affected: jobs.length, message: `已取消 ${jobs.length} 个任务。`, jobs: jobs.map((job) => ({ ...job, payload: this.parseJsonColumn(job.payload, {}) })) };
    } catch (error) { if (connection) await connection.rollback().catch(() => {}); return { ok: false, message: error.message }; } finally { if (connection) await connection.end(); }
  }

  async deleteScheduledJobs(userId, jobIds = []) {
    let connection;
    try {
      const owner = Number(userId); const ids = [...new Set((Array.isArray(jobIds) ? jobIds : []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
      if (!Number.isInteger(owner) || owner < 1 || !ids.length) throw new Error('请选择要删除的任务。');
      connection = await this.openConnection(await this.getConfig()); await this.ensureScheduledJobTables(connection);
      const placeholders = ids.map(() => '?').join(', ');
      const [result] = await connection.execute(`DELETE FROM scheduled_jobs WHERE id IN (${placeholders}) AND user_id = ? AND status <> 'running'`, [...ids, owner]);
      return { ok: true, affected: Number(result.affectedRows || 0), message: `已删除 ${Number(result.affectedRows || 0)} 个任务；执行中的任务未删除。` };
    } catch (error) { return { ok: false, message: error.message }; } finally { if (connection) await connection.end(); }
  }

  async claimScheduledJobsNow(userId, jobIds = [], options = {}) {
    let connection;
    try {
      const owner = Number(userId); const ids = [...new Set((Array.isArray(jobIds) ? jobIds : []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
      if (!Number.isInteger(owner) || owner < 1 || !ids.length) throw new Error('请选择要立即执行的任务。');
      connection = await this.openConnection(await this.getConfig()); await this.ensureScheduledJobTables(connection); await connection.beginTransaction();
      const placeholders = ids.map(() => '?').join(', ');
      const executionConfigMode = options?.executionConfigMode === 'current' ? 'current' : 'snapshot';
      const [jobs] = await connection.execute(`SELECT * FROM scheduled_jobs WHERE id IN (${placeholders}) AND user_id = ? AND status IN ('queued', 'active', 'failed', 'succeeded') FOR UPDATE`, [...ids, owner]);
      for (const job of jobs) {
        await connection.execute("UPDATE scheduled_jobs SET status = 'running', progress_percent = 1, progress_message = '已手动开始执行。', last_error = NULL, last_started_at = NOW(), updated_at = NOW() WHERE id = ?", [job.id]);
        await connection.execute("UPDATE scheduled_job_items SET status = 'running', progress_percent = 1, progress_message = '已手动开始执行。', error_message = NULL, started_at = NOW(), finished_at = NULL WHERE job_id = ?", [job.id]);
      }
      await connection.commit();
      return { ok: true, jobs: jobs.map((job) => ({ ...job, payload: { ...this.parseJsonColumn(job.payload, {}), executionConfigMode, rerun: job.status === 'succeeded' } })), message: `已开始执行 ${jobs.length} 个任务。` };
    } catch (error) { if (connection) await connection.rollback().catch(() => {}); return { ok: false, message: error.message, jobs: [] }; }
    finally { if (connection) await connection.end(); }
  }

  async countPendingProductImageJobs(userId, productIds = []) {
    let connection;
    try {
      const ids = [...new Set((Array.isArray(productIds) ? productIds : []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
      if (!ids.length) return { ok: true, counts: {} };
      connection = await this.openConnection(await this.getConfig()); await this.ensureScheduledJobTables(connection);
      const [rows] = await connection.execute(`SELECT JSON_UNQUOTE(JSON_EXTRACT(payload, '$.productId')) AS product_id, COUNT(*) AS total FROM scheduled_jobs WHERE user_id = ? AND job_type = 'product_image' AND status IN ('queued', 'active', 'running') AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.productId')) IN (${ids.map(() => '?').join(', ')}) GROUP BY product_id`, [Number(userId), ...ids.map(String)]);
      return { ok: true, counts: Object.fromEntries(rows.map((row) => [Number(row.product_id), Number(row.total)])) };
    } catch (error) { return { ok: false, message: error.message, counts: {} }; } finally { if (connection) await connection.end(); }
  }

  async getLatestSyncRun() {
    let connection;
    try {
      connection = await this.openConnection(await this.getConfig());
      await this.ensureSyncRunsTable(connection);
      const [rows] = await connection.query('SELECT id, trigger_type, status, started_at, finished_at, fetched_count, created_count, updated_count, error_code, error_message FROM sync_runs ORDER BY id DESC LIMIT 1');
      return { ok: true, run: rows[0] || null };
    } catch (error) {
      return { ok: false, code: error.code || 'DATABASE_ERROR', message: error.message, run: null };
    } finally { if (connection) await connection.end(); }
  }

  canonicalImageUrl(imageUrl) {
    try { const url = new URL(imageUrl); url.search = ''; url.hash = ''; return url.toString(); } catch (_) { return imageUrl; }
  }

  detailImageUrls(detail, fallbackThumbnail) {
    const candidates = [ ...(Array.isArray(detail?.imgUrls) ? detail.imgUrls : []) ];
    for (const color of Object.values(detail?.colorMap || {})) candidates.push(...(Array.isArray(color?.imgUrls) ? color.imgUrls : []), color?.imgUrl);
    for (const attribute of Array.isArray(detail?.saleAttributes) ? detail.saleAttributes : []) {
      for (const value of Array.isArray(attribute?.values) ? attribute.values : []) candidates.push(...(Array.isArray(value?.imgUrls) ? value.imgUrls : []), value?.imgUrl);
    }
    candidates.push(...(Array.isArray(detail?.outerPackageImgUrls) ? detail.outerPackageImgUrls : []));
    candidates.push(fallbackThumbnail);
    const seen = new Set();
    return candidates.filter((url) => {
      if (!url || typeof url !== 'string') return false;
      const canonical = this.canonicalImageUrl(url);
      if (seen.has(canonical)) return false;
      seen.add(canonical);
      return true;
    });
  }

  normalizeStoreCollectDetail(info, listItem) {
    const source = info && typeof info === 'object' && !Array.isArray(info) ? info : {};
    const list = listItem && typeof listItem === 'object' ? listItem : {};
    const firstDefined = (...values) => values.find((value) => value !== undefined && value !== null);
    const arrayValue = (value) => Array.isArray(value) ? value : [];
    return {
      // Keep every API-returned key: new fields from Miaoshou are never discarded by a client upgrade.
      ...source,
      title: firstDefined(source.title, list.title, ''),
      itemNum: firstDefined(source.itemNum, list.itemNum, ''),
      notesText: firstDefined(source.notesText, list.notesText, list.remark, ''),
      remark: firstDefined(source.remark, list.remark, ''),
      gmtCreate: firstDefined(source.gmtCreate, list.gmtCreate, null),
      gmtModified: firstDefined(source.gmtModified, list.gmtModified, null),
      price: firstDefined(source.price, list.price, null),
      stock: firstDefined(source.stock, list.stock, null),
      weight: firstDefined(source.weight, list.weight, null),
      packageLength: firstDefined(source.packageLength, list.packageLength, null),
      packageWidth: firstDefined(source.packageWidth, list.packageWidth, null),
      packageHeight: firstDefined(source.packageHeight, list.packageHeight, null),
      imgUrls: arrayValue(firstDefined(source.imgUrls, list.imgUrls)),
      saleAttributes: arrayValue(firstDefined(source.saleAttributes, list.saleAttributes)),
      // The preview form uses sourceAttrs; retain attributes too so the original field name remains available.
      attributes: arrayValue(firstDefined(source.attributes, list.attributes)),
      sourceAttrs: arrayValue(firstDefined(source.attributes, source.sourceAttrs, list.attributes)),
      skuMap: firstDefined(source.skuMap, list.skuMap, {}),
      sizeCharts: arrayValue(firstDefined(source.sizeCharts, list.sizeCharts)),
      cateList: arrayValue(firstDefined(source.cateList, list.cateList)),
      colorMap: firstDefined(source.colorMap, list.colorMap, {}),
      sizeMap: firstDefined(source.sizeMap, list.sizeMap, {}),
      productOriginCountry: firstDefined(source.productOriginCountry, list.productOriginCountry, ''),
      productOriginProvince: firstDefined(source.productOriginProvince, list.productOriginProvince, ''),
      manufacturingLocationRegionShortNameList: arrayValue(firstDefined(source.manufacturingLocationRegionShortNameList, list.manufacturingLocationRegionShortNameList)),
      outerPackageShape: firstDefined(source.outerPackageShape, list.outerPackageShape, null),
      outerPackageType: firstDefined(source.outerPackageType, list.outerPackageType, null),
      outerPackageImgUrls: arrayValue(firstDefined(source.outerPackageImgUrls, list.outerPackageImgUrls)),
      cid: firstDefined(source.cid, list.cid, list.categoryId, null),
    };
  }

  applyDefaultSuggestedSkuPrice(detail) {
    if (!detail?.skuMap || typeof detail.skuMap !== 'object' || Array.isArray(detail.skuMap)) return detail;
    for (const sku of Object.values(detail.skuMap)) {
      if (!sku || typeof sku !== 'object' || Array.isArray(sku)) continue;
      // 同步入库统一初始化建议售价；用户可以在本地 SKU 编辑表中再单独调整。
      sku.suggestedPrice = '100';
      if (!String(sku.suggestedPriceCurrencyType || '').trim()) sku.suggestedPriceCurrencyType = 'CNY';
    }
    return detail;
  }

  findCategoryPath(categoryTree, targetCid) {
    if (targetCid === undefined || targetCid === null || targetCid === '') return [];
    const wanted = String(targetCid);
    const walk = (nodes, parentPath = []) => {
      for (const node of Object.values(nodes && typeof nodes === 'object' ? nodes : {})) {
        if (!node || typeof node !== 'object') continue;
        const name = String(node.name || node.nameChinese || '').trim();
        const path = name ? [...parentPath, name] : parentPath;
        if (String(node.cid) === wanted) return path;
        const found = walk(node.children, path);
        if (found.length) return found;
      }
      return [];
    };
    return walk(categoryTree);
  }

  async saveSourceImageAsset(connection, productId, sourceProductId, imageUrl, sortOrder) {
    if (!imageUrl) return { skipped: true };
    const [existingAssets] = await connection.execute(
      'SELECT id, object_key, original_url FROM assets WHERE product_id = ? AND asset_kind = \'source_image\' AND deleted_at IS NULL',
      [productId],
    );
    const existing = existingAssets.find((asset) => this.canonicalImageUrl(asset.original_url) === this.canonicalImageUrl(imageUrl));
    let assetId;
    if (existing) {
      assetId = existing.id;
      await connection.execute('UPDATE assets SET storage_provider = \'miaoshou\', bucket_name = NULL, object_key = NULL, original_url = ?, mime_type = NULL, file_size_bytes = NULL WHERE id = ?', [imageUrl, assetId]);
    } else {
      const fileName = (() => { try { return new URL(imageUrl).pathname.split('/').pop() || `source-${sourceProductId}`; } catch (_) { return `source-${sourceProductId}`; } })();
      const [asset] = await connection.execute('INSERT INTO assets (product_id, storage_provider, original_url, file_name, asset_kind) VALUES (?, \'miaoshou\', ?, ?, \'source_image\')', [productId, imageUrl, fileName]);
      assetId = asset.insertId;
    }
    await connection.execute('INSERT INTO product_images (product_id, asset_id, image_group, sort_order) VALUES (?, ?, \'source\', ?) ON DUPLICATE KEY UPDATE sort_order = VALUES(sort_order)', [productId, assetId, sortOrder]);
    return { ok: true, stored: true };
  }

  async ensureTargetCollectBoxIdentity(connection) {
    await this.ensureProductMiaoshouAccountScope(connection);
    const [indexes] = await connection.query("SHOW INDEX FROM products WHERE Key_name = 'uk_products_source'");
    if (indexes.length) await connection.query('ALTER TABLE products DROP INDEX uk_products_source');
    const [targetIndexes] = await connection.query("SHOW INDEX FROM products WHERE Key_name = 'uk_products_target_collect_box_source'");
    if (targetIndexes.length) await connection.query('ALTER TABLE products DROP INDEX uk_products_target_collect_box_source');
    const [accountIndexes] = await connection.query("SHOW INDEX FROM products WHERE Key_name = 'uk_products_target_collect_box_account_source'");
    if (!accountIndexes.length) await connection.query('ALTER TABLE products ADD UNIQUE KEY uk_products_target_collect_box_account_source (source_miaoshou_app_id, source_platform_code, source_product_id, source_store_id, created_by)');
  }

  async syncMiaoshouTargetStoreCollectBox(config, triggerType = 'manual', userId) {
    let connection;
    let syncRunId;
    try {
      const ownerUserId = Number(userId);
      if (!Number.isInteger(ownerUserId) || ownerUserId < 1) throw new Error('请先登录本机用户。');
      const mergedConfig = mergeConfig(config);
      const appId = String(mergedConfig.miaoshou.appId || '').trim();
      if (!appId) throw new Error('请先在系统配置中填写妙手 App ID。');
      connection = await this.openConnection(mergedConfig);
      await this.ensureSyncRunsTable(connection);
      await this.ensureSourceDetailColumns(connection);
      await this.ensureCategoryTables(connection);
      await this.ensureMiaoshouProductMappingsTable(connection);
      await this.ensureMiaoshouFolderImportRecordsTable(connection);
      await this.purgeLegacyCommonCollectBoxData(connection);
      await this.ensureMiaoshouAuthorizedShopsTables(connection);
      await this.ensureTargetCollectBoxIdentity(connection);
      await this.ensureCommonTemplateCategoriesTable(connection);
      await this.ensureCommonCategoryAttributeTemplatesTable(connection);
      const [settings] = await connection.execute(`SELECT s.platform_code, s.site_code, s.shop_id, s.write_target, shop.shop_name, shop.shop_mode
        FROM automation_publish_settings s JOIN miaoshou_authorized_shops shop ON shop.user_id = s.user_id AND shop.miaoshou_app_id = s.miaoshou_app_id
          AND shop.platform_code = s.platform_code AND shop.site_code = s.site_code AND shop.shop_id = s.shop_id AND shop.is_enabled = 1
        WHERE s.user_id = ? AND s.miaoshou_app_id = ? LIMIT 1`, [ownerUserId, appId]);
      if (!settings.length) throw new Error('请先在上架与自动化设置中保存有效的发布平台和目标店铺。');
      const target = settings[0];
      const [run] = await connection.execute('INSERT INTO sync_runs (trigger_type, status) VALUES (?, \'running\')', [triggerType]);
      syncRunId = run.insertId;
      const client = new MiaoshouClient(mergedConfig.miaoshou);
      const { items } = await client.getPlatformCollectBoxList(target.platform_code, 0, 500);
      let categoryTree = {};
      let categoryTreeError = null;
      if (['pddkj', 'pddkjChoice'].includes(target.platform_code)) try {
        categoryTree = await client.getPlatformCategoryTree(target.platform_code);
      }
      catch (error) { categoryTreeError = error.message; }
      const shopId = String(target.shop_id);
      const shopItems = items.filter((item) => (item.collectBoxDetailShopList || []).some((shop) => String(shop.shopId ?? shop.id) === shopId));
      const sourcePlatformCode = `miaoshou_${target.platform_code}`;
      const targetPlatformCode = target.platform_code === 'pddkj'
        ? 'temu_full'
        : (target.platform_code === 'tiktokGs' ? 'tiktok_gs' : 'temu_semi');
      let created = 0;
      let updated = 0;
      let skipped = 0;
      let reconciled = 0;
      const imageCandidates = [];
      await connection.beginTransaction();
      for (const item of shopItems) {
        const sourceProductId = String(item.collectBoxDetailId || '');
        if (!sourceProductId) continue;
        const [existing] = await connection.execute(`SELECT id, current_category_id FROM products WHERE source_miaoshou_app_id = ? AND source_platform_code = ? AND source_product_id = ? AND source_store_id = ? AND created_by = ? LIMIT 1`, [appId, sourcePlatformCode, sourceProductId, shopId, ownerUserId]);
        const [folderImport] = await connection.execute(`SELECT r.product_id, p.raw_data FROM miaoshou_folder_import_records r
          JOIN products p ON p.id = r.product_id AND p.deleted_at IS NULL
          WHERE r.user_id = ? AND r.miaoshou_app_id = ? AND r.platform_code = ? AND r.shop_id = ?
            AND r.platform_collect_box_detail_id = ? ORDER BY r.updated_at DESC, r.id DESC LIMIT 1`,
        [ownerUserId, appId, target.platform_code, shopId, Number(sourceProductId)]);
        if (folderImport.length) {
          const folderProduct = folderImport[0];
          // 认领已成功但后续回写失败时，本地商品仍可能是 folder_builder；不能因此再创建一条妙手副本。
          if (existing.length && Number(existing[0].id) !== Number(folderProduct.product_id)) {
            await connection.execute(`UPDATE products SET deleted_at = NOW(), product_status = 'archived', last_error_code = 'DUPLICATE_FOLDER_IMPORT_RECONCILED',
              last_error_message = '已合并到对应文件夹建品录入记录，保留原文件夹商品。', updated_at = NOW() WHERE id = ? AND deleted_at IS NULL`, [existing[0].id]);
            reconciled += 1;
          }
          const folderRawData = this.parseJsonColumn(folderProduct.raw_data, {});
          await connection.execute(`UPDATE products SET raw_data = CAST(? AS JSON), last_synced_at = NOW(), updated_at = NOW() WHERE id = ?`, [
            JSON.stringify({ ...folderRawData, _miaoshouStoreCollectBox: { platformCode: target.platform_code, siteCode: target.site_code, shopId, collectBoxDetailId: sourceProductId },
              _miaoshouStoreSync: { item, syncedAt: new Date().toISOString(), localDataPreserved: true } }), folderProduct.product_id,
          ]);
          skipped += 1;
          continue;
        }
        if (existing.length) {
          skipped += 1;
          continue;
        } else {
          const rawData = { ...item, _miaoshouStoreCollectBox: { platformCode: target.platform_code, siteCode: target.site_code, shopId, collectBoxDetailId: sourceProductId } };
          const [createdProduct] = await connection.execute(`INSERT INTO products (source_miaoshou_app_id, source_platform_code, source_product_id, source_store_id, target_platform_code, title,
            source_notes_text, source_price, source_stock, product_status, last_synced_at, raw_data, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_process', NOW(), CAST(? AS JSON), ?)`, [appId, sourcePlatformCode, sourceProductId, shopId, targetPlatformCode,
            item.title || `妙手店铺采集商品 ${sourceProductId}`, item.remark || null, item.price ?? null, item.stock ?? null, JSON.stringify(rawData), ownerUserId]);
          created += 1;
          imageCandidates.push({ productId: createdProduct.insertId, sourceProductId, item });
        }
      }
      await connection.execute("UPDATE sync_runs SET status = 'succeeded', finished_at = NOW(), fetched_count = ?, created_count = ?, updated_count = ? WHERE id = ?", [shopItems.length, created, updated, syncRunId]);
      await connection.commit();
      let imageSaved = 0;
      let detailsLoaded = 0;
      let detailFailed = 0;
      const detailErrors = [];
      let categoriesResolved = 0;
      let categoriesUnresolved = 0;
      for (const candidate of imageCandidates) {
        try {
          const detailData = await client.getPlatformCollectBoxShopDetail(target.platform_code, candidate.sourceProductId, shopId, candidate.item.cid ?? candidate.item.categoryId ?? 0);
          const info = detailData.shopCollectItemInfo || {};
          let detail = this.normalizeStoreCollectDetail(info, candidate.item);
          detail = this.applyDefaultSuggestedSkuPrice(detail);
          const categoryPath = detail.cateList.length ? detail.cateList : this.findCategoryPath(categoryTree, detail.cid);
          if (!detail.cateList.length && categoryPath.length) {
            detail.cateList = categoryPath;
            categoriesResolved += 1;
          } else if (!detail.cateList.length && detail.cid) categoriesUnresolved += 1;
          const imageUrls = this.detailImageUrls(detail, candidate.item.thumbnail || candidate.item.listThumbnail);
          for (let index = 0; index < imageUrls.length; index += 1) {
            const result = await this.saveSourceImageAsset(connection, candidate.productId, candidate.sourceProductId, imageUrls[index], index);
            if (result.ok && !result.skipped) imageSaved += 1;
          }
          const categoryId = targetPlatformCode === 'temu_full'
            ? (await this.findPlatformCategoryId(connection, 'temu_full', detail.cid) || await this.upsertTargetStoreCategoryPath(connection, detail.cateList))
            : await this.upsertTargetStoreCategoryPath(connection, detail.cateList);
          const wasCommonBeforeSync = await this.isSyncedCategoryCommon(connection, ownerUserId, categoryId);
          if (wasCommonBeforeSync) {
            const attributeTemplate = await this.getSavedCommonCategoryAttributeTemplate(connection, ownerUserId, categoryId);
            detail = this.applyCommonCategoryAttributeTemplate(detail, attributeTemplate);
          }
          await connection.execute(`UPDATE products SET title = ?, current_category_id = COALESCE(?, current_category_id), source_notes_text = ?, source_price = ?, source_stock = ?, source_weight = ?,
            source_package_length = ?, source_package_width = ?, source_package_height = ?, source_size_map = CAST(? AS JSON), source_color_map = CAST(? AS JSON),
            raw_data = CAST(? AS JSON), last_synced_at = NOW(), updated_at = NOW() WHERE id = ?`, [
            detail.title || candidate.item.title || `妙手店铺采集商品 ${candidate.sourceProductId}`, categoryId, detail.notesText || detail.remark || null,
            detail.price ?? null, detail.stock ?? null, detail.weight ?? null, detail.packageLength ?? null, detail.packageWidth ?? null, detail.packageHeight ?? null,
            JSON.stringify(detail.sizeMap || {}), JSON.stringify(detail.colorMap || {}),
            JSON.stringify({ ...candidate.item, _miaoshouStoreCollectBox: { platformCode: target.platform_code, siteCode: target.site_code, shopId, collectBoxDetailId: candidate.sourceProductId }, _miaoshouDetail: detail, _miaoshouStoreDetail: detailData }), candidate.productId,
          ]);
          detailsLoaded += 1;
        } catch (error) {
          detailFailed += 1;
          detailErrors.push({ productId: candidate.productId, sourceProductId: candidate.sourceProductId, message: error.message || '未知详情同步错误' });
          if (candidate.item.thumbnail) {
            const result = await this.saveSourceImageAsset(connection, candidate.productId, candidate.sourceProductId, candidate.item.thumbnail, 0);
            if (result.ok && !result.skipped) imageSaved += 1;
          }
        }
      }
      const warnings = [];
      if (categoryTreeError) warnings.push(`类目树读取失败：${categoryTreeError}`);
      if (categoriesUnresolved) warnings.push(`未匹配类目 ${categoriesUnresolved} 条`);
      if (detailFailed) warnings.push(`商品详情同步失败 ${detailFailed} 条：${detailErrors.slice(0, 2).map((item) => `商品 ${item.sourceProductId}，${item.message}`).join('；')}`);
      const warningMessage = warnings.join('；').slice(0, 1900) || null;
      await connection.execute('UPDATE sync_runs SET error_code = ?, error_message = ? WHERE id = ?', [
        warningMessage ? 'MIAOSHOU_SYNC_PARTIAL_WARNING' : null, warningMessage, syncRunId,
      ]);
      return { ok: true, created, updated, skipped, reconciled, total: shopItems.length, imageSaved, detailsLoaded, detailFailed, detailErrors, categoriesResolved, categoriesUnresolved, warningMessage, message: `店铺采集箱同步完成：${target.shop_name} 新增 ${created} 条，已跳过 ${skipped} 条本地商品${reconciled ? `，已合并 ${reconciled} 条重复商品` : ''}，按商品 cid 入库类目 ${categoriesResolved} 条，保存图片 ${imageSaved} 张${warnings.length ? `；警告：${warnings.join('；')}` : ''}。` };
    } catch (error) {
      if (connection) {
        try { await connection.rollback(); } catch (_) { /* transaction may not have started */ }
        if (syncRunId) {
          try { await connection.execute("UPDATE sync_runs SET status = 'failed', finished_at = NOW(), error_code = ?, error_message = ? WHERE id = ?", [error.code || 'SYNC_ERROR', error.message, syncRunId]); } catch (_) { /* preserve original error */ }
        }
      }
      return { ok: false, code: error.code || 'SYNC_ERROR', message: error.message };
    } finally { if (connection) await connection.end(); }
  }

  async syncAllMiaoshouTargetStoreCollectBoxes(config, triggerType = 'scheduled') {
    let connection;
    try {
      const mergedConfig = mergeConfig(config);
      const appId = String(mergedConfig.miaoshou.appId || '').trim();
      connection = await this.openConnection(mergedConfig);
      await this.ensureMiaoshouAuthorizedShopsTables(connection);
      const [settings] = await connection.execute('SELECT user_id FROM automation_publish_settings WHERE miaoshou_app_id = ?', [appId]);
      if (!settings.length) return { ok: true, skipped: true, message: '暂无已配置目标店铺，跳过定时同步。' };
      const results = [];
      for (const setting of settings) results.push(await this.syncMiaoshouTargetStoreCollectBox(mergedConfig, triggerType, setting.user_id));
      const successful = results.filter((result) => result.ok);
      const failed = results.filter((result) => !result.ok);
      return { ok: failed.length === 0, partial: successful.length > 0 && failed.length > 0, results, message: failed.length ? `店铺采集箱同步完成：成功 ${successful.length} 个，失败 ${failed.length} 个。` : `已同步 ${successful.length} 个已配置店铺采集箱。` };
    } catch (error) {
      return { ok: false, code: error.code || 'SYNC_ERROR', message: error.message };
    } finally { if (connection) await connection.end(); }
  }

  async ensureWmsStockImportRecordsTable(connection) {
    await connection.query(`CREATE TABLE IF NOT EXISTS wms_stock_import_records (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, user_id BIGINT UNSIGNED NOT NULL, product_id BIGINT UNSIGNED NOT NULL,
      product_title VARCHAR(500) NOT NULL, old_sku_id VARCHAR(255) NOT NULL, import_status VARCHAR(32) NOT NULL DEFAULT 'running',
      request_data JSON NULL, response_data JSON NULL, error_message TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id), KEY idx_wms_stock_import_records_user_created (user_id, created_at), KEY idx_wms_stock_import_records_product (product_id)
    ) ENGINE=InnoDB COMMENT='WMS 入库记录'`);
  }

  async createWmsStockImportRecord(userId, input = {}) {
    let connection;
    try {
      const owner = Number(userId); const productId = Number(input.productId);
      if (!Number.isInteger(owner) || owner < 1 || !Number.isInteger(productId) || productId < 1) throw new Error('入库记录参数无效。');
      connection = await this.openConnection(await this.getConfig()); await this.ensureWmsStockImportRecordsTable(connection);
      const [result] = await connection.execute(`INSERT INTO wms_stock_import_records (user_id, product_id, product_title, old_sku_id, import_status, request_data)
        VALUES (?, ?, ?, ?, 'running', CAST(? AS JSON))`, [owner, productId, String(input.productTitle || '').slice(0, 500), String(input.oldSkuId || '').slice(0, 255), JSON.stringify(input.requestData || {})]);
      return { ok: true, recordId: Number(result.insertId) };
    } catch (error) { return { ok: false, message: error.message }; } finally { if (connection) await connection.end(); }
  }

  async finishWmsStockImportRecord(recordId, status, requestData = {}, responseData = {}, errorMessage = null) {
    let connection;
    try {
      const id = Number(recordId); if (!Number.isInteger(id) || id < 1) return { ok: false, message: '入库记录编号无效。' };
      connection = await this.openConnection(await this.getConfig()); await this.ensureWmsStockImportRecordsTable(connection);
      await connection.execute(`UPDATE wms_stock_import_records SET import_status = ?, request_data = CAST(? AS JSON), response_data = CAST(? AS JSON), error_message = ? WHERE id = ?`,
        [String(status || 'failed'), JSON.stringify(requestData || {}), JSON.stringify(responseData || {}), errorMessage ? String(errorMessage).slice(0, 5000) : null, id]);
      return { ok: true };
    } catch (error) { return { ok: false, message: error.message }; } finally { if (connection) await connection.end(); }
  }

  async listWmsStockImportRecords(userId, page = 1, pageSize = 20) {
    let connection;
    try {
      const owner = Number(userId); const size = Math.max(1, Math.min(100, Number(pageSize) || 20));
      if (!Number.isInteger(owner) || owner < 1) throw new Error('请先登录本机用户。');
      connection = await this.openConnection(await this.getConfig()); await this.ensureWmsStockImportRecordsTable(connection);
      const [[count]] = await connection.execute('SELECT COUNT(*) AS total FROM wms_stock_import_records WHERE user_id = ?', [owner]);
      const total = Number(count.total || 0); const totalPages = Math.max(1, Math.ceil(total / size)); const safePage = Math.min(Math.max(1, Number(page) || 1), totalPages);
      const [records] = await connection.execute(`SELECT id, product_id, product_title, old_sku_id, import_status, error_message, created_at, updated_at
        FROM wms_stock_import_records WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`, [owner, size, (safePage - 1) * size]);
      return { ok: true, records, pagination: { page: safePage, pageSize: size, total, totalPages } };
    } catch (error) { return { ok: false, message: error.message, records: [], pagination: null }; } finally { if (connection) await connection.end(); }
  }

  async getWmsStockImportRecord(userId, recordId) {
    let connection;
    try {
      const owner = Number(userId); const id = Number(recordId);
      if (!Number.isInteger(owner) || owner < 1 || !Number.isInteger(id) || id < 1) throw new Error('入库记录参数无效。');
      connection = await this.openConnection(await this.getConfig()); await this.ensureWmsStockImportRecordsTable(connection);
      const [[record]] = await connection.execute('SELECT * FROM wms_stock_import_records WHERE id = ? AND user_id = ? LIMIT 1', [id, owner]);
      if (!record) return { ok: false, message: '入库记录不存在。', record: null };
      record.request_data = this.parseJsonColumn(record.request_data, {}); record.response_data = this.parseJsonColumn(record.response_data, {});
      return { ok: true, record };
    } catch (error) { return { ok: false, message: error.message, record: null }; } finally { if (connection) await connection.end(); }
  }

  async getWmsStockImportStatusByProductIds(userId, productIds) {
    let connection;
    try {
      const owner = Number(userId); const ids = [...new Set((Array.isArray(productIds) ? productIds : []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
      if (!Number.isInteger(owner) || owner < 1 || !ids.length) return { ok: true, statuses: {} };
      connection = await this.openConnection(await this.getConfig()); await this.ensureWmsStockImportRecordsTable(connection);
      const [rows] = await connection.execute(`SELECT product_id, id, created_at FROM wms_stock_import_records
        WHERE user_id = ? AND import_status = 'succeeded' AND product_id IN (${ids.map(() => '?').join(', ')}) ORDER BY id DESC`, [owner, ...ids]);
      const statuses = {};
      for (const row of rows) if (!statuses[Number(row.product_id)]) statuses[Number(row.product_id)] = { recordId: Number(row.id), importedAt: row.created_at };
      return { ok: true, statuses };
    } catch (error) { return { ok: false, message: error.message, statuses: {} }; } finally { if (connection) await connection.end(); }
  }

  async login({ username, password }) {
    if (!username || !password) return { ok: false, message: '请输入用户名和密码。' };
    let connection;
    try {
      connection = await this.openConnection(await this.getConfig());
      const [rows] = await connection.execute('SELECT id, username, display_name FROM users WHERE username = ? AND password_value = ? AND status = 1 LIMIT 1', [username, password]);
      if (!rows.length) return { ok: false, message: '用户名或密码错误。' };
      await connection.execute('UPDATE users SET last_login_at = NOW() WHERE id = ?', [rows[0].id]);
      return { ok: true, user: rows[0] };
    } catch (error) {
      return { ok: false, message: `无法连接本地数据库：${error.message}`, code: error.code || 'DATABASE_ERROR' };
    } finally { if (connection) await connection.end(); }
  }
}

module.exports = { DatabaseService, DEFAULT_CONFIG };
