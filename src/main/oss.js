const crypto = require('crypto');
const OSS = require('ali-oss');

function normalizeEndpoint(endpoint) {
  if (!endpoint) return null;
  const value = /^https?:\/\//i.test(endpoint) ? endpoint : `https://${endpoint}`;
  return new URL(value);
}

function regionFromEndpoint(endpoint) {
  const host = endpoint?.hostname || '';
  const matched = host.match(/(?:^|\.)(oss-[a-z0-9-]+?)(?:-internal)?\.aliyuncs\.com$/i);
  return matched ? matched[1].toLowerCase() : null;
}

function encodeObjectKey(objectKey) {
  return objectKey.split('/').map(encodeURIComponent).join('/');
}

function objectUrl(config, objectKey) {
  const endpoint = normalizeEndpoint(config.endpoint);
  if (!endpoint || !config.bucket || !objectKey) return null;
  const host = endpoint.hostname.startsWith(`${config.bucket}.`)
    ? endpoint.host
    : `${config.bucket}.${endpoint.host}`;
  return `${endpoint.protocol}//${host}/${encodeObjectKey(objectKey)}`;
}

function extensionFor(contentType, sourceUrl) {
  const byType = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
  if (byType[contentType?.split(';')[0].toLowerCase()]) return byType[contentType.split(';')[0].toLowerCase()];
  const matched = sourceUrl.match(/\.([a-zA-Z0-9]{2,5})(?:[?#]|$)/);
  return matched ? matched[1].toLowerCase() : 'jpg';
}

class OssClient {
  constructor(config = {}) { this.config = config; }

  isConfigured() {
    const { endpoint, bucket, accessKeyId, accessKeySecret } = this.config;
    return Boolean(endpoint && bucket && accessKeyId && accessKeySecret);
  }

  publicUrl(objectKey) { return objectUrl(this.config, objectKey); }

  // 私有 Bucket 不能用直接 URL 预览；签名 URL 只用于本机展示，不能写回模板数据库。
  previewUrl(url, expires = 3600) {
    if (!url) return url;
    try {
      const endpoint = normalizeEndpoint(this.config.endpoint);
      if (!endpoint || !this.config.bucket) return url;
      const parsed = new URL(url);
      const bucketHost = `${this.config.bucket}.${endpoint.host}`;
      if (parsed.host !== endpoint.host && parsed.host !== bucketHost) return url;
      const objectKey = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
      return objectKey ? this.client().signatureUrl(objectKey, { expires }) : url;
    } catch (_) { return url; }
  }

  client() {
    const endpoint = normalizeEndpoint(this.config.endpoint);
    if (!endpoint) throw new Error('OSS Endpoint 无效。');
    const region = regionFromEndpoint(endpoint);
    return new OSS({
      endpoint: `${endpoint.protocol}//${endpoint.host}`,
      bucket: this.config.bucket,
      accessKeyId: this.config.accessKeyId,
      accessKeySecret: this.config.accessKeySecret,
      ...(region ? { region } : {}),
      authorizationV4: Boolean(region),
      secure: endpoint.protocol === 'https:',
      // 图片上传可能遇到首次 TLS 握手慢或瞬时网络抖动；Buffer 可安全重放，启用 SDK 的网络错误/超时重试。
      timeout: 60000,
      retryMax: 2,
      cname: endpoint.hostname.startsWith(`${this.config.bucket}.`),
    });
  }

  async testConnection() {
    if (!this.isConfigured()) return { ok: false, message: '请完整填写 Endpoint、Bucket、AccessKey ID 和 AccessKey Secret。' };
    try {
      await this.client().getBucketInfo(this.config.bucket);
      return { ok: true, message: `已成功连接 Bucket：${this.config.bucket}` };
    } catch (error) {
      const status = error.status ? `（HTTP ${error.status}）` : '';
      const requestId = error.requestId ? `，请求 ID：${error.requestId}` : '';
      return { ok: false, message: `Bucket 连接失败${status}${requestId}。${error.message || '请检查 Endpoint、Bucket 和访问权限。'}` };
    }
  }

  async uploadThumbnail({ productId, sourceProductId, sourceUrl }) {
    if (!this.isConfigured()) return { ok: false, skipped: true, message: 'OSS 未配置。' };
    if (!sourceUrl) return { ok: false, skipped: true, message: '商品没有可上传的缩略图。' };
    const sourceResponse = await fetch(sourceUrl);
    if (!sourceResponse.ok) throw new Error(`下载商品图片失败：HTTP ${sourceResponse.status}`);
    const buffer = Buffer.from(await sourceResponse.arrayBuffer());
    if (!buffer.length) throw new Error('下载到的商品图片为空。');
    if (buffer.length > 20 * 1024 * 1024) throw new Error('商品图片超过 20MB，已跳过上传。');
    const contentType = sourceResponse.headers.get('content-type') || 'image/jpeg';
    const sourceHash = crypto.createHash('sha256').update(sourceUrl).digest('hex').slice(0, 16);
    const objectKey = `products/${productId}/source/${sourceProductId}-${sourceHash}.${extensionFor(contentType, sourceUrl)}`;
    const url = this.publicUrl(objectKey);
    // 部分 Bucket 禁止对象级 public-read ACL；对象会继承 Bucket 策略，不能在这里强制设置 ACL。
    await this.client().put(objectKey, buffer, { mime: contentType });
    return { ok: true, objectKey, publicUrl: url, contentType, fileSize: buffer.length };
  }

  async uploadCommonCategoryPackageImage({ userId, categoryId, fileName, contentType, buffer }) {
    if (!this.isConfigured()) return { ok: false, message: 'OSS 未配置。请先在系统设置中保存并测试 OSS 配置。' };
    const content = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
    if (!content.length) return { ok: false, message: '上传图片为空。' };
    if (content.length > 20 * 1024 * 1024) return { ok: false, message: '图片超过 20MB，无法上传。' };
    const mime = String(contentType || 'image/jpeg').toLowerCase();
    if (!mime.startsWith('image/')) return { ok: false, message: '仅支持图片文件。' };
    const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
    const objectKey = `templates/users/${Number(userId)}/categories/${Number(categoryId)}/outer-package/${Date.now()}-${hash}.${extensionFor(mime, String(fileName || 'image.jpg'))}`;
    const publicUrl = this.publicUrl(objectKey);
    // 同上：由 Bucket 的读写策略决定对象访问权限，避免 Put public object acl is not allowed。
    await this.client().put(objectKey, content, { mime });
    return { ok: true, objectKey, publicUrl, contentType: mime, fileSize: content.length };
  }

  async uploadProductDescriptionImage({ userId, productId, fileName, contentType, buffer }) {
    if (!this.isConfigured()) return { ok: false, message: 'OSS 未配置。请先在系统设置中保存并测试 OSS 配置。' };
    const content = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
    if (!content.length) return { ok: false, message: '上传图片为空。' };
    if (content.length > 20 * 1024 * 1024) return { ok: false, message: '图片超过 20MB，无法上传。' };
    const mime = String(contentType || 'image/jpeg').toLowerCase();
    if (!mime.startsWith('image/')) return { ok: false, message: '仅支持图片文件。' };
    const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
    const objectKey = `products/users/${Number(userId)}/${Number(productId)}/description/${Date.now()}-${hash}.${extensionFor(mime, String(fileName || 'image.jpg'))}`;
    const publicUrl = this.publicUrl(objectKey);
    // 对象权限由 Bucket 策略统一决定，避免受限 Bucket 拒绝对象级 ACL。
    await this.client().put(objectKey, content, { mime });
    return { ok: true, objectKey, publicUrl, previewUrl: this.previewUrl(publicUrl), contentType: mime, fileSize: content.length };
  }

  async uploadFolderBuilderProductImage({ userId, productId, fileName, contentType, buffer, index = 0 }) {
    if (!this.isConfigured()) return { ok: false, message: 'OSS 未配置。请先在系统设置中保存并测试 OSS 配置。' };
    const content = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
    if (!content.length) return { ok: false, message: '上传图片为空。' };
    if (content.length > 20 * 1024 * 1024) return { ok: false, message: '图片超过 20MB，无法上传。' };
    const mime = String(contentType || 'image/jpeg').toLowerCase();
    if (!mime.startsWith('image/')) return { ok: false, message: '仅支持图片文件。' };
    const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
    const objectKey = `products/users/${Number(userId)}/${Number(productId)}/folder-source/${String(Number(index) + 1).padStart(3, '0')}-${Date.now()}-${hash}.${extensionFor(mime, String(fileName || 'image.jpg'))}`;
    const publicUrl = this.publicUrl(objectKey);
    await this.client().put(objectKey, content, { mime });
    return { ok: true, objectKey, publicUrl, previewUrl: this.previewUrl(publicUrl), contentType: mime, fileSize: content.length };
  }

  async uploadLibraryImage({ userId, fileName, contentType, buffer, kind = 'uploads' }) {
    if (!this.isConfigured()) return { ok: false, message: 'OSS 未配置。请先在系统设置中保存并测试 OSS 配置。' };
    const content = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
    if (!content.length) return { ok: false, message: '上传图片为空。' };
    if (content.length > 20 * 1024 * 1024) return { ok: false, message: '图片超过 20MB，无法上传。' };
    const mime = String(contentType || 'image/jpeg').toLowerCase();
    if (!mime.startsWith('image/')) return { ok: false, message: '仅支持图片文件。' };
    const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
    const safeKind = String(kind || 'uploads').replace(/[^a-z0-9_-]/gi, '-');
    const objectKey = `library/users/${Number(userId)}/${safeKind}/${Date.now()}-${hash}.${extensionFor(mime, String(fileName || 'image.jpg'))}`;
    const publicUrl = this.publicUrl(objectKey);
    await this.client().put(objectKey, content, { mime });
    return { ok: true, objectKey, publicUrl, previewUrl: this.previewUrl(publicUrl), contentType: mime, fileSize: content.length };
  }

  async uploadGeneratedLibraryImage({ userId, contentType, buffer, index = 0 }) {
    return this.uploadLibraryImage({ userId, contentType, buffer, fileName: `ai-edit-${Number(index) + 1}.png`, kind: 'ai-edits' });
  }

  async uploadGeneratedProductImage({ userId, productId, contentType, buffer, index = 0 }) {
    if (!this.isConfigured()) return { ok: false, message: 'OSS 未配置。请先在系统设置中保存并测试 OSS 配置。' };
    const content = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
    if (!content.length) return { ok: false, message: '模型生成的图片为空。' };
    if (content.length > 20 * 1024 * 1024) return { ok: false, message: '模型生成的图片超过 20MB，无法保存。' };
    const mime = String(contentType || 'image/png').toLowerCase();
    if (!mime.startsWith('image/')) return { ok: false, message: '模型返回的内容不是图片。' };
    const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
    const objectKey = `products/users/${Number(userId)}/${Number(productId)}/ai-generated/${Date.now()}-${Number(index) + 1}-${hash}.${extensionFor(mime, 'generated.png')}`;
    const publicUrl = this.publicUrl(objectKey);
    await this.client().put(objectKey, content, { mime });
    return { ok: true, objectKey, publicUrl, previewUrl: this.previewUrl(publicUrl), contentType: mime, fileSize: content.length };
  }

  async uploadGeneratedProductReferenceImage({ userId, productId, contentType, buffer, index = 0 }) {
    if (!this.isConfigured()) return { ok: false, message: 'OSS 未配置。请先在系统设置中保存并测试 OSS 配置。' };
    const content = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
    if (!content.length) return { ok: false, message: '商品参考图片为空。' };
    if (content.length > 30 * 1024 * 1024) return { ok: false, message: '商品参考图片超过 30MB，无法发送给 Seedream。' };
    const mime = String(contentType || 'image/jpeg').toLowerCase();
    if (!mime.startsWith('image/')) return { ok: false, message: '商品参考图片不是有效图片。' };
    const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
    const objectKey = `products/users/${Number(userId)}/${Number(productId)}/ai-references/${Date.now()}-${Number(index) + 1}-${hash}.${extensionFor(mime, 'reference.jpg')}`;
    const publicUrl = this.publicUrl(objectKey);
    await this.client().put(objectKey, content, { mime });
    return { ok: true, objectKey, publicUrl, previewUrl: this.previewUrl(publicUrl), contentType: mime, fileSize: content.length };
  }
}

module.exports = { OssClient, objectUrl };
