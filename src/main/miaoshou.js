const crypto = require('crypto');

const DEFAULT_BASE_URL = 'https://openapi-erp.91miaoshou.com';
const PROBE_PATH = '/open/v1/product/collect_box/pddkj_choice/collect_box/get_country_short_name_and_name_map';
const PLATFORM_COLLECT_BOX_PATHS = {
  pddkj: '/open/v1/product/collect_box/pddkj/collect_box/search_collect_box_detail_list',
  pddkjChoice: '/open/v1/product/collect_box/pddkj_choice/collect_box/search_collect_box_detail_list',
  // 妙手的 TikTok 全托管店铺使用 tiktokGs 标识，但采集箱开放接口归属 /tiktok/。
  tiktokGs: '/open/v1/product/collect_box/tiktok/collect_box/search_collect_box_detail_list',
};
const PLATFORM_CLAIM_TO_SHOP_PATHS = {
  pddkj: '/open/v1/product/collect_box/pddkj/collect_box/claim_to_shop',
  tiktok: '/open/v1/product/collect_box/tiktok/collect_box/claim_to_shop',
};
const TEMU_FULL_PUBLISH_PATH = '/open/v1/product/collect_box/pddkj/move_collect/save_move_collect_task';
const COMMON_COLLECT_BOX_CREATE_PATH = '/open/v1/product/common_collect_box/common_collect_box/add_common_collect_box_detail';
const COMMON_COLLECT_BOX_CLAIM_PATH = '/open/v1/product/common_collect_box/common_collect_box/claimed';
const COMMON_COLLECT_BOX_LIST_PATH = '/open/v1/product/common_collect_box/common_collect_box/get_common_collect_box_list';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function maskDebugValue(value) {
  if (Array.isArray(value)) return value.map(maskDebugValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    /secret|token|authorization|signature|sign|password|accesskey/i.test(key) ? '***' : maskDebugValue(item),
  ]));
}

class MiaoshouClient {
  constructor(config) {
    this.appId = config.appId;
    this.appSecret = config.appSecret;
    this.baseUrl = (config.apiBaseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    this.requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
    // process.defaultApp 仅在 `electron .` 这类开发启动方式中为 true；可通过环境变量显式开启或关闭。
    this.debugEnabled = process.env.MIAOSHOU_DEBUG === '1' || (process.env.MIAOSHOU_DEBUG !== '0' && process.defaultApp === false);
  }

  validateCredentials() {
    if (!this.appId || !this.appSecret) throw new Error('请先填写妙手 App ID 和 App Secret。');
  }

  debug(label, payload) {
    if (!this.debugEnabled) return;
    console.log(`[妙手接口][${label}]`, JSON.stringify(maskDebugValue(payload), null, 2));
  }

  async post(path, body) {
    this.validateCredentials();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const bodyJson = body === undefined ? '' : JSON.stringify(body);
    const source = `${this.appSecret}${path}${timestamp}${this.appId}${bodyJson}${this.appSecret}`;
    const sign = crypto.createHmac('sha256', this.appSecret).update(source, 'utf8').digest('hex');
    this.debug('请求', { method: 'POST', url: `${this.baseUrl}${path}`, path, body: body === undefined ? null : body });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-app-key': this.appId, 'x-timestamp': timestamp, 'x-sign': sign },
        ...(bodyJson ? { body: bodyJson } : {}),
        signal: controller.signal,
      });
      const responseText = await response.text();
      let data;
      try { data = JSON.parse(responseText); } catch { data = { raw: responseText }; }
      this.debug('响应', { path, status: response.status, ok: response.ok, data });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${data.message || responseText}`);
      return data;
    } catch (error) {
      if (controller.signal.aborted) {
        const timeoutError = new Error(`妙手接口请求超时（${Math.round(this.requestTimeoutMs / 1000)} 秒）：${path}`);
        timeoutError.code = 'MIAOSHOU_REQUEST_TIMEOUT';
        this.debug('失败', { path, message: timeoutError.message, cause: error.message || null });
        throw timeoutError;
      }
      this.debug('失败', { path, message: error.message, cause: error.cause?.message || null });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async testConnection() {
    try {
      const response = await this.post(PROBE_PATH);
      if (response.result === 'fail' || (response.code && response.code !== 'success')) {
        return { ok: false, code: response.code || 'MIAOSHOU_ERROR', message: response.message || '妙手接口返回失败。', response };
      }
      return { ok: true, code: response.code || 'success', message: response.message || '妙手 API 签名与连通性测试成功。', response };
    } catch (error) {
      return { ok: false, code: error.code || 'MIAOSHOU_CONNECTION_ERROR', message: error.message };
    }
  }

  async getProductOriginCountries() {
    const response = await this.post(PROBE_PATH);
    if (response.result === 'fail' || (response.code && response.code !== 'success')) {
      throw new Error(response.message || response.code || '妙手产地选项读取失败。');
    }
    return Array.isArray(response.data?.productOriginCountries) ? response.data.productOriginCountries : [];
  }

  async getPlatformCollectBoxList(platformCode, pageNo = 0, pageSize = 500) {
    const path = PLATFORM_COLLECT_BOX_PATHS[platformCode];
    if (!path) throw new Error(`暂不支持平台采集箱：${platformCode}`);
    const response = await this.post(path, { pageNo, pageSize, filter: {} });
    if (response.result === 'fail' || (response.code && response.code !== 'success')) {
      throw new Error(response.message || response.code || '妙手店铺采集箱读取失败。');
    }
    const data = response.data || {};
    const items = Array.isArray(data) ? data : data.detailList || data.list || data.records || data.dataList || data.collectBoxDetailList || data.content || (data.collectBoxDetailId ? [data] : []);
    return { response, data, items: Array.isArray(items) ? items : [] };
  }

  async getPlatformCollectBoxShopDetail(platformCode, detailId, shopId, cid = 0) {
    const path = PLATFORM_COLLECT_BOX_PATHS[platformCode]?.replace('search_collect_box_detail_list', 'get_shop_collect_item_info');
    if (!path) throw new Error(`暂不支持平台采集箱：${platformCode}`);
    const response = await this.post(path, { detailId: Number(detailId), shopId: Number(shopId), cid: Number(cid) || 0 });
    if (response.result === 'fail' || (response.code && response.code !== 'success')) {
      throw new Error(response.message || response.code || '妙手店铺采集箱详情读取失败。');
    }
    return response.data || {};
  }

  async getPlatformCategoryTree(platformCode) {
    const path = PLATFORM_COLLECT_BOX_PATHS[platformCode]?.replace('search_collect_box_detail_list', 'get_category_tree_by_site');
    if (!path) throw new Error(`暂不支持平台采集箱：${platformCode}`);
    const response = await this.post(path);
    if (response.result === 'fail' || (response.code && response.code !== 'success')) {
      throw new Error(response.message || response.code || '妙手平台类目树读取失败。');
    }
    return response.data?.cateTree || {};
  }

  async getPlatformCategoryAttributeRules(platformCode, cid, shopIds = []) {
    const path = PLATFORM_COLLECT_BOX_PATHS[platformCode]?.replace('search_collect_box_detail_list', 'get_category_attribute_rules');
    if (!path) throw new Error(`暂不支持平台类目属性：${platformCode}`);
    const numericCid = Number(cid);
    if (!Number.isInteger(numericCid) || numericCid <= 0) throw new Error('类目 ID 无效，无法获取属性规则。');
    const numericShopIds = [...new Set((Array.isArray(shopIds) ? shopIds : []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
    const response = await this.post(path, { cid: numericCid, ...(numericShopIds.length ? { shopIds: numericShopIds } : {}) });
    if (response.result === 'fail' || (response.code && response.code !== 'success')) {
      throw new Error(response.message || response.code || '妙手类目属性规则读取失败。');
    }
    return response.data || {};
  }

  async savePlatformCollectBoxShopDetail(platformCode, detailId, shopId, shopCollectItemInfo) {
    const path = PLATFORM_COLLECT_BOX_PATHS[platformCode]?.replace('search_collect_box_detail_list', 'save_shop_collect_item_info');
    if (!path) throw new Error(`暂不支持平台采集箱：${platformCode}`);
    const response = await this.post(path, { shopCollectItemInfo, detailId: Number(detailId), shopId: Number(shopId) });
    if (response.result === 'fail' || (response.code && response.code !== 'success')) {
      throw new Error(response.message || response.reason || response.code || '妙手店铺采集箱回写失败。');
    }
    return response;
  }

  async createCommonCollectBoxDetail(payload) {
    const response = await this.post(COMMON_COLLECT_BOX_CREATE_PATH, payload);
    const detailId = Number(response?.data?.commonCollectBoxDetailId);
    if (response.result === 'fail' || (response.code && response.code !== 'success') || !Number.isInteger(detailId) || detailId < 1) {
      throw new Error(response.reason || response.message || response.code || '创建公共采集箱产品失败。');
    }
    return { response, commonCollectBoxDetailId: detailId };
  }

  async getCommonCollectBoxList(pageNo = 1, pageSize = 500, filter = {}) {
    const response = await this.post(COMMON_COLLECT_BOX_LIST_PATH, {
      pageNo: Math.max(1, Number(pageNo) || 1),
      pageSize: Math.min(500, Math.max(1, Number(pageSize) || 500)),
      filter: {
        ...(filter?.tabPaneName ? { tabPaneName: String(filter.tabPaneName) } : {}),
        ...(filter?.sourceItemIdKeyword ? { sourceItemIdKeyword: String(filter.sourceItemIdKeyword) } : {}),
      },
    });
    if (response.result === 'fail' || (response.code && response.code !== 'success')) {
      throw new Error(response.reason || response.message || response.code || '获取公共采集箱列表失败。');
    }
    return response?.data || { detailList: [], total: 0 };
  }

  async claimCommonCollectBoxDetails(items) {
    const detailSerialNumberPlatformList = (Array.isArray(items) ? items : []).map((item) => ({
      detailId: Number(item?.detailId), platform: String(item?.platform || ''), serialNumber: Number(item?.serialNumber) || 1,
    })).filter((item) => Number.isInteger(item.detailId) && item.detailId > 0 && item.platform);
    if (!detailSerialNumberPlatformList.length || detailSerialNumberPlatformList.length > 100) throw new Error('认领数据无效，单次最多认领 100 个公共采集箱商品。');
    const response = await this.post(COMMON_COLLECT_BOX_CLAIM_PATH, { detailSerialNumberPlatformList });
    if (response.result === 'fail' || (response.code && response.code !== 'success')) {
      throw new Error(response.reason || response.message || response.code || '认领到平台采集箱失败。');
    }
    return { response, platformCollectBoxDetailIdMap: response?.data?.platformCollectBoxDetailIdMap || {} };
  }

  async claimPlatformCollectBoxToShop(platformCode, shopIds, detailIds) {
    const path = PLATFORM_CLAIM_TO_SHOP_PATHS[platformCode];
    if (!path) throw new Error(`暂不支持平台采集箱认领预发布店铺：${platformCode}`);
    const normalizedShopIds = [...new Set((Array.isArray(shopIds) ? shopIds : []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
    const normalizedDetailIds = [...new Set((Array.isArray(detailIds) ? detailIds : []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
    if (!normalizedShopIds.length || !normalizedDetailIds.length) throw new Error('认领预发布店铺缺少有效的店铺 ID 或采集箱详情 ID。');
    if (normalizedShopIds.length > 200 || normalizedDetailIds.length > 200) throw new Error('单次认领预发布店铺的店铺 ID 和采集箱详情 ID 均不能超过 200 项。');
    const response = await this.post(path, { shopIds: normalizedShopIds, detailIds: normalizedDetailIds });
    if (response.result === 'fail' || (response.code && response.code !== 'success')) {
      throw new Error(response.reason || response.message || response.code || '认领预发布店铺失败。');
    }
    return response;
  }

  async publishTemuFullCollectBoxProducts(shopIds, detailIds) {
    const normalizedShopIds = [...new Set((Array.isArray(shopIds) ? shopIds : []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
    const normalizedDetailIds = [...new Set((Array.isArray(detailIds) ? detailIds : []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
    if (!normalizedShopIds.length || !normalizedDetailIds.length) throw new Error('发布商品缺少有效的店铺 ID 或采集箱详情 ID。');
    if (normalizedShopIds.length > 200 || normalizedDetailIds.length > 200) throw new Error('单次发布的店铺 ID 和采集箱详情 ID 均不能超过 200 项。');
    const response = await this.post(TEMU_FULL_PUBLISH_PATH, { shopIds: normalizedShopIds, detailIds: normalizedDetailIds });
    const succeeded = String(response.result || '').toLowerCase() === 'success' || String(response.code || '').toLowerCase() === 'success';
    if (!succeeded) {
      throw new Error(response.reason || response.message || response.code || '妙手商品发布提交失败。');
    }
    return response;
  }

}

module.exports = { MiaoshouClient, PROBE_PATH, TEMU_FULL_PUBLISH_PATH, COMMON_COLLECT_BOX_CREATE_PATH, COMMON_COLLECT_BOX_CLAIM_PATH, COMMON_COLLECT_BOX_LIST_PATH, PLATFORM_COLLECT_BOX_PATHS, PLATFORM_CLAIM_TO_SHOP_PATHS };
