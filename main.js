const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs/promises');
const { DatabaseService } = require('./src/main/database');
const { MiaoshouClient } = require('./src/main/miaoshou');
const { OssClient } = require('./src/main/oss');
let databaseService;
let syncTimer;
let syncRunning = false;
let nextSyncAt = null;
let scheduledJobTimer;
let scheduledJobRunning = false;
let aiImageEditTaskSequence = 0;
let folderBuilderBatchRunning = false;
let updateConfigured = false;
let updateState = { status: 'idle', currentVersion: app.getVersion(), availableVersion: '', percent: 0, message: '尚未检查更新。' };

function publishUpdateState(patch = {}) {
  updateState = { ...updateState, ...patch, currentVersion: app.getVersion() };
  BrowserWindow.getAllWindows().forEach((window) => {
    if (!window.isDestroyed()) window.webContents.send('updates:status', updateState);
  });
  return updateState;
}

function configureAutoUpdater() {
  if (updateConfigured) return;
  updateConfigured = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.on('checking-for-update', () => publishUpdateState({ status: 'checking', message: '正在检查更新。' }));
  autoUpdater.on('update-available', (info) => publishUpdateState({ status: 'available', availableVersion: String(info?.version || ''), message: `发现新版本 v${info?.version || ''}。` }));
  autoUpdater.on('update-not-available', () => publishUpdateState({ status: 'latest', availableVersion: '', percent: 0, message: '当前已是最新版本。' }));
  autoUpdater.on('download-progress', (progress) => publishUpdateState({ status: 'downloading', percent: Math.max(0, Math.min(100, Math.round(Number(progress?.percent) || 0))), message: `正在下载更新：${Math.round(Number(progress?.percent) || 0)}%。` }));
  autoUpdater.on('update-downloaded', (info) => publishUpdateState({ status: 'downloaded', availableVersion: String(info?.version || updateState.availableVersion), percent: 100, message: '更新已下载，重启软件即可安装。' }));
  autoUpdater.on('error', (error) => publishUpdateState({ status: 'error', message: `检查更新失败：${String(error?.message || '未知错误').slice(0, 300)}` }));
  if (app.isPackaged) setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 15000);
  else publishUpdateState({ status: 'development', message: '开发模式不检查在线更新。' });
}

const folderBuilderImageTypes = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'], ['.webp', 'image/webp'], ['.gif', 'image/gif'],
]);
const imageTypeExtensions = new Map([
  ['image/jpeg', '.jpg'], ['image/jpg', '.jpg'], ['image/png', '.png'], ['image/webp', '.webp'], ['image/gif', '.gif'],
]);

const WMS_BASE_URL = 'http://localhost:8080';

function normalizeWmsUrl(pathname, baseUrl = WMS_BASE_URL) {
  return new URL(pathname, `${String(baseUrl || WMS_BASE_URL).replace(/\/+$/, '')}/`).toString();
}

function wmsWarehouseIds(wms) {
  const warehouseId = Number(wms?.warehouseId);
  if (!Number.isInteger(warehouseId) || warehouseId <= 0) throw new Error('请先在系统设置填写有效的 WMS 仓库 ID。');
  return [warehouseId];
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try { return JSON.parse(String(value || '{}')); } catch (_) { return {}; }
}

function wmsSizeForSku(labels, index, count) {
  const text = labels.join(' ').toLowerCase();
  if (text.includes('14')) return '40x14.5';
  if (text.includes('19')) return '50x50';
  if (text.includes('29')) return '75x75';
  if (/(小尺寸|小号|small|\bxs\b|\bs\b)/i.test(text)) return '50x50';
  if (/(大尺寸|大号|large|\bxl\b|\bl\b)/i.test(text)) return '75x75';
  // 没有可识别规格时按常见的两档 SKU 顺序预填，仍由用户在确认窗口中确认。
  if (count === 2) return index === 0 ? '50x50' : '75x75';
  return '';
}

function wmsSkuLabels(detail, skuKey) {
  const values = [];
  for (const attribute of Array.isArray(detail?.saleAttributes) ? detail.saleAttributes : []) {
    const matched = (attribute?.values || []).find((value) => String(value?.skuKey || '') === String(skuKey));
    if (matched?.name) values.push(String(matched.name));
  }
  return values;
}

function wmsSkuImageUrl(detail, skuKey, sku, fallbackImages, index) {
  const candidates = [sku?.imgUrl, ...(Array.isArray(sku?.imgUrls) ? sku.imgUrls : [])];
  for (const attribute of Array.isArray(detail?.saleAttributes) ? detail.saleAttributes : []) {
    const matched = (attribute?.values || []).find((value) => String(value?.skuKey || '') === String(skuKey));
    if (matched) candidates.push(matched.imgUrl, ...(Array.isArray(matched.imgUrls) ? matched.imgUrls : []));
  }
  candidates.push(fallbackImages[index], fallbackImages[0]);
  return candidates.map((url) => String(url || '').trim()).find((url) => /^https?:\/\//i.test(url)) || '';
}

async function getWmsStockImportPlan(userId, productId) {
  const detailResult = await databaseService.getProductForEdit(productId, userId);
  if (!detailResult?.ok) return detailResult;
  const product = detailResult.product || {};
  const detail = parseJsonObject(product.raw_data)._miaoshouDetail || {};
  const oldSkuId = String(detail.itemNum || '').trim();
  if (!oldSkuId) return { ok: false, message: '商品未填写产品主编号，无法作为原 SKU。' };
  const skuEntries = Object.entries(detail.skuMap && typeof detail.skuMap === 'object' ? detail.skuMap : {});
  if (!skuEntries.length) return { ok: false, message: '商品没有 SKU 明细，无法入库。' };
  const imageUrls = [...new Set((detailResult.images || []).map((image) => String(image?.image_url || '').trim()).filter((url) => /^https?:\/\//i.test(url)))];
  if (!imageUrls.length) return { ok: false, message: '商品没有可上传的图片，无法入库。' };
  const skus = skuEntries.map(([skuKey, sku], index) => {
    const labels = wmsSkuLabels(detail, skuKey);
    return {
      key: skuKey,
      skuId: String(sku?.itemNum || `${oldSkuId}-${index + 1}`).trim(),
      labels,
      size: wmsSizeForSku(labels, index, skuEntries.length),
      imageUrl: wmsSkuImageUrl(detail, skuKey, sku, imageUrls, index),
    };
  });
  if (skus.some((sku) => !sku.skuId)) return { ok: false, message: '存在未填写 SKU 货号的明细。' };
  if (skus.some((sku) => !sku.imageUrl)) return { ok: false, message: '存在没有可用图片的 SKU，无法入库。' };
  return { ok: true, productId: Number(productId), productTitle: product.title, oldSkuId, skus };
}

async function requestWmsCaptcha() {
  const response = await fetch(normalizeWmsUrl('/captchaImage'));
  const body = await response.json().catch(() => null);
  if (!response.ok || Number(body?.code) !== 200) throw new Error(body?.msg || `读取 WMS 验证码失败（HTTP ${response.status}）`);
  return { ok: true, captchaOn: body.captchaOnOff === true, uuid: String(body.uuid || ''), image: String(body.img || '') };
}

async function loginWms(credentials) {
  const response = await fetch(normalizeWmsUrl('/login', credentials?.baseUrl), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: String(credentials?.username || '').trim(), password: String(credentials?.password || ''), code: String(credentials?.code || '').trim(), uuid: String(credentials?.uuid || '').trim() }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || Number(body?.code) !== 200 || !body?.token) throw new Error(body?.msg || `WMS 登录失败（HTTP ${response.status}）`);
  return String(body.token);
}

async function uploadImageToWms(token, imageUrl, index, baseUrl) {
  const source = await fetch(imageUrl);
  if (!source.ok) throw new Error(`下载第 ${index + 1} 张商品图片失败（HTTP ${source.status}）`);
  const bytes = await source.arrayBuffer();
  if (!bytes.byteLength) throw new Error(`第 ${index + 1} 张商品图片为空。`);
  const contentType = String(source.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  if (!contentType.startsWith('image/')) throw new Error(`第 ${index + 1} 张商品图片不是图片文件。`);
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: contentType }), `product-${index + 1}${downloadedImageExtension(imageUrl, contentType)}`);
  const response = await fetch(normalizeWmsUrl('/common/upload', baseUrl), { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  const body = await response.json().catch(() => null);
  if (response.status === 401 || response.status === 403) { const error = new Error(body?.msg || 'WMS 登录已失效。'); error.code = 'WMS_UNAUTHORIZED'; throw error; }
  if (!response.ok || Number(body?.code) !== 200 || !body?.url) throw new Error(body?.msg || `上传第 ${index + 1} 张商品图片失败（HTTP ${response.status}）`);
  return String(body.url);
}

async function importProductStockToWms(userId, productId, sizes = {}) {
  const plan = await getWmsStockImportPlan(userId, productId);
  if (!plan?.ok) return plan;
  const config = await databaseService.getConfig(); const wms = config?.wms || {};
  if (!String(wms.username || '').trim() || !String(wms.password || '')) return { ok: false, message: '请先在系统设置保存 WMS 用户名和密码。' };
  const warehouseIds = wmsWarehouseIds(wms);
  const initialRequest = { oldSkuId: plan.oldSkuId, warehouseId: warehouseIds, skus: plan.skus.map((sku) => ({ skuId: sku.skuId, size: sizes?.[sku.key] || sku.size || '', sourceImageUrl: sku.imageUrl })) };
  const recordResult = await databaseService.createWmsStockImportRecord(userId, { ...plan, requestData: initialRequest });
  const recordId = recordResult?.recordId;
  let requestData = initialRequest; let responseData = {};
  const saveToken = async (token) => databaseService.saveConfig({ ...config, wms: { ...wms, token, tokenUpdatedAt: new Date().toISOString() } });
  const loginAndSave = async () => { const nextToken = await loginWms({ ...wms, baseUrl: wms.baseUrl }); await saveToken(nextToken); return nextToken; };
  let token = String(wms.token || '').trim() || await loginAndSave();
  const execute = async () => {
    const uploaded = []; const created = []; const payloads = [];
    for (const [index, sku] of plan.skus.entries()) {
      const size = String(sizes?.[sku.key] || sku.size || '').trim();
      if (!['40x14.5', '50x50', '75x75'].includes(size)) throw new Error(`SKU“${sku.skuId}”请选择 40x14.5、50x50 或 75x75 尺寸。`);
      const imageUrl = await uploadImageToWms(token, sku.imageUrl, index, wms.baseUrl);
      uploaded.push({ skuId: sku.skuId, sourceImageUrl: sku.imageUrl, uploadedImageUrl: imageUrl });
      const payload = { id: null, skuId: sku.skuId, stock: null, preStock: null, picData: imageUrl, warehouseId: warehouseIds, oldSkuId: plan.oldSkuId, shelfId: null, status: 'A', size };
      payloads.push(payload);
      const response = await fetch(normalizeWmsUrl('/stock/create', wms.baseUrl), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const body = await response.json().catch(() => null);
      if (response.status === 401 || response.status === 403) { const error = new Error(body?.msg || 'WMS 登录已失效。'); error.code = 'WMS_UNAUTHORIZED'; throw error; }
      if (!response.ok || !Number.isInteger(Number(body))) throw new Error(`SKU“${sku.skuId}”入库失败（HTTP ${response.status}${body?.msg ? `：${body.msg}` : ''}）`);
      created.push({ skuId: sku.skuId, stockId: Number(body), size });
    }
    requestData = { ...initialRequest, uploadedImages: uploaded, stockPayloads: payloads };
    responseData = { created };
    return { created, uploaded: uploaded.length };
  };
  try {
    let result;
    try { result = await execute(); }
    catch (error) {
      if (error?.code !== 'WMS_UNAUTHORIZED' || !String(wms.token || '').trim()) throw error;
      token = await loginAndSave(); result = await execute();
    }
    if (recordId) await databaseService.finishWmsStockImportRecord(recordId, 'succeeded', requestData, responseData);
    return { ok: true, recordId, ...result, message: `已上传 ${result.uploaded} 张图片，并创建 ${result.created.length} 条库存记录。` };
  } catch (error) {
    if (recordId) await databaseService.finishWmsStockImportRecord(recordId, 'failed', requestData, responseData, error?.message || 'WMS 入库失败');
    return { ok: false, recordId, message: error?.message || 'WMS 入库失败。' };
  }
}

async function loginAndSaveWmsToken(credentials = {}) {
  const config = await databaseService.getConfig(); const wms = config?.wms || {};
  if (!String(wms.username || '').trim() || !String(wms.password || '')) return { ok: false, message: '请先保存 WMS 用户名和密码。' };
  try {
    const token = await loginWms({ ...wms, code: credentials.code, uuid: credentials.uuid });
    const saved = await databaseService.saveConfig({ ...config, wms: { ...wms, token, tokenUpdatedAt: new Date().toISOString() } });
    return { ok: true, tokenUpdatedAt: saved.wms?.tokenUpdatedAt || '', message: 'WMS 登录成功，Token 已保存。' };
  } catch (error) { return { ok: false, message: error?.message || 'WMS 登录失败。' }; }
}

function exportFolderSegment(value, fallback = '商品') {
  const cleaned = String(value || '').trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '');
  return (cleaned || fallback).slice(0, 80);
}

async function uniqueExportDirectory(rootDirectory, folderName) {
  const basePath = path.join(rootDirectory, folderName);
  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const candidate = suffix ? `${basePath}_${suffix + 1}` : basePath;
    try {
      await fs.access(candidate);
    } catch (_) {
      await fs.mkdir(candidate, { recursive: true });
      return candidate;
    }
  }
  throw new Error('无法创建导出目录，请更换导出位置后重试。');
}

function downloadedImageExtension(url, contentType) {
  try {
    const extension = path.extname(new URL(String(url)).pathname).toLowerCase();
    if (folderBuilderImageTypes.has(extension)) return extension;
  } catch (_) { /* 使用响应类型继续判断 */ }
  return imageTypeExtensions.get(String(contentType || '').split(';')[0].trim().toLowerCase()) || '.jpg';
}

async function exportProductCarouselImages(input = {}) {
  const urls = [...new Set((Array.isArray(input.urls) ? input.urls : []).map((url) => String(url || '').trim()).filter((url) => /^https?:\/\//i.test(url)))];
  if (!urls.length) return { ok: false, message: '没有可导出的图片。' };
  const selected = await dialog.showOpenDialog({ title: '选择图片导出位置', buttonLabel: '导出到此文件夹', properties: ['openDirectory', 'createDirectory'] });
  if (selected.canceled || !selected.filePaths[0]) return { ok: true, cancelled: true, exported: 0, failed: 0 };
  const imageGroup = String(input.folderLabel || '').trim() || (input.kind === 'ai' ? 'AI生成轮播图' : '商品轮播图');
  const directory = await uniqueExportDirectory(selected.filePaths[0], `${exportFolderSegment(input.productName)}_${imageGroup}`);
  const failures = [];
  let exported = 0;
  for (const [index, url] of urls.entries()) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`);
      const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (contentType && !contentType.startsWith('image/')) throw new Error(`不是图片文件（${contentType}）`);
      const contentLength = Number(response.headers.get('content-length')) || 0;
      if (contentLength > 30 * 1024 * 1024) throw new Error('图片超过 30MB');
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length) throw new Error('图片内容为空');
      if (bytes.length > 30 * 1024 * 1024) throw new Error('图片超过 30MB');
      await fs.writeFile(path.join(directory, `${String(index + 1).padStart(2, '0')}${downloadedImageExtension(url, contentType)}`), bytes);
      exported += 1;
    } catch (error) {
      failures.push({ index: index + 1, message: error?.message || '下载失败' });
    }
  }
  return { ok: true, directory, exported, failed: failures.length, failures };
}

async function exportImageLibraryImages(urls) {
  return exportProductCarouselImages({ urls, productName: '图库', folderLabel: '已选图片' });
}

async function exportImageProductBuilderTaskImages(tasks, folderLabel) {
  const selectedTasks = (Array.isArray(tasks) ? tasks : []).map((task) => {
    const imageUrls = [...new Set((Array.isArray(task?.imageUrls) ? task.imageUrls : []).map((url) => String(url || '').trim()).filter((url) => /^https?:\/\//i.test(url)))];
    return { itemNumber: String(task?.itemNumber || '').trim(), imageUrls };
  }).filter((task) => task.itemNumber && task.imageUrls.length);
  if (!selectedTasks.length) return { ok: false, message: `所选任务没有可下载的${folderLabel}。` };
  const selected = await dialog.showOpenDialog({ title: '选择图片导出位置', buttonLabel: '导出到此文件夹', properties: ['openDirectory', 'createDirectory'] });
  if (selected.canceled || !selected.filePaths[0]) return { ok: true, cancelled: true, exported: 0, failed: 0 };
  const directory = await uniqueExportDirectory(selected.filePaths[0], `桌布任务_${exportFolderSegment(folderLabel)}`);
  let exported = 0;
  const failures = [];
  for (const task of selectedTasks) {
    const taskDirectory = await uniqueExportDirectory(directory, exportFolderSegment(task.itemNumber));
    for (const [index, url] of task.imageUrls.entries()) {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`);
        const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (contentType && !contentType.startsWith('image/')) throw new Error(`不是图片文件（${contentType}）`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (!bytes.length || bytes.length > 30 * 1024 * 1024) throw new Error(!bytes.length ? '图片内容为空' : '图片超过 30MB');
        await fs.writeFile(path.join(taskDirectory, `${String(index + 1).padStart(2, '0')}${downloadedImageExtension(url, contentType)}`), bytes);
        exported += 1;
      } catch (error) { failures.push({ itemNumber: task.itemNumber, index: index + 1, message: error?.message || '下载失败' }); }
    }
  }
  return { ok: true, directory, exported, failed: failures.length, failures };
}

async function listFolderBuilderImages(folderPath, includeBytes = false) {
  const root = path.resolve(String(folderPath || ''));
  const files = [];
  const visit = async (directory, relativeDirectory = '') => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const relativePath = path.join(relativeDirectory, entry.name);
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath, relativePath);
      else if (entry.isFile()) {
        const contentType = folderBuilderImageTypes.get(path.extname(entry.name).toLowerCase());
        if (contentType) files.push({ absolutePath, fileName: entry.name, relativePath, contentType });
      }
    }
  };
  await visit(root);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'zh-CN', { numeric: true }));
  if (!files.length) throw new Error('文件夹内没有可用的 JPG、PNG、WEBP 或 GIF 图片。');
  if (files.length > 15) throw new Error('一个文件夹最多导入 15 张商品轮播图，请拆分后重试。');
  if (!includeBytes) return files;
  return Promise.all(files.map(async (file) => ({
    fileName: file.fileName, relativePath: file.relativePath, contentType: file.contentType, bytes: new Uint8Array(await fs.readFile(file.absolutePath)),
  })));
}

function clearSyncTimer() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = undefined;
  nextSyncAt = null;
}

async function runTargetStoreCollectBoxSync(config, triggerType, userId) {
  if (syncRunning) return { ok: true, skipped: true, message: '上一轮同步尚未完成，已跳过本次同步。' };
  syncRunning = true;
  try {
    const syncConfig = config || await databaseService.getConfig();
    return userId
      ? databaseService.syncMiaoshouTargetStoreCollectBox(syncConfig, triggerType, userId)
      : databaseService.syncAllMiaoshouTargetStoreCollectBoxes(syncConfig, triggerType);
  } finally {
    syncRunning = false;
  }
}

function configureSyncTimer(config) {
  clearSyncTimer();
  // 历史版本的同步配置会迁入数据库任务队列；这里保留空实现，避免两套计时器重复同步。
  nextSyncAt = null;
}

function clearScheduledJobTimer() {
  if (scheduledJobTimer) clearInterval(scheduledJobTimer);
  scheduledJobTimer = undefined;
}

function mysqlDate(date) {
  const value = new Date(date); const pad = (number) => String(number).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}

async function executeScheduledJob(job) {
  const payload = job.payload || {};
  const jobId = Number(job.id);
  const userId = Number(job.user_id) || null;
  const report = async (percent, message, progressStatus = 'running') => {
    const status = progressStatus === 'failed' ? 'failed' : progressStatus === 'succeeded' ? 'succeeded' : 'running';
    return databaseService.updateScheduledJobStatus(jobId, status, { percent, message, error: status === 'failed' ? message : null, itemStatus: status });
  };
  try {
    await report(5, '正在准备执行。');
    let result;
    if (job.job_type === 'target_store_collect_box_sync') {
      result = await runTargetStoreCollectBoxSync(undefined, 'scheduled', userId || undefined);
    } else if (job.job_type === 'image_product_builder') {
      result = await databaseService.runImageProductBuilderTask(userId, Number(payload.builderTaskId), (progress) => report(progress.percent || 10, progress.message || '正在生成桌布图片。', progress.status), {
        configurationMode: payload.executionConfigMode,
        appendResults: payload.rerun === true,
        shouldCancel: () => databaseService.isScheduledJobCancelled(jobId),
      });
    } else if (job.job_type === 'product_image') {
      result = await databaseService.generateProductImages(userId, Number(payload.productId), {
        title: payload.title || '', imageUrls: Array.isArray(payload.imageUrls) ? payload.imageUrls : [], taskId: `scheduled-${jobId}`,
        onProgress: (progress) => report(progress.percent || 40, progress.message || '正在生成商品图片。'),
      });
    } else throw new Error('不支持的定时任务类型。');
    if (!result?.ok || result.skipped) throw new Error(result?.message || '任务执行失败。');
    const isInterval = job.schedule_type === 'interval' && Number(job.interval_seconds) >= 10;
    const nextRunAt = isInterval ? mysqlDate(Date.now() + Number(job.interval_seconds) * 1000) : null;
    await databaseService.updateScheduledJobStatus(jobId, isInterval ? 'active' : 'succeeded', { percent: 100, message: isInterval ? '本轮执行完成，等待下一次执行。' : '任务执行完成。', finishedAt: mysqlDate(new Date()), nextRunAt, itemStatus: 'succeeded' });
    if (job.schedule_type === 'queue') await databaseService.advanceScheduledQueueSettings(userId);
  } catch (error) {
    const isInterval = job.schedule_type === 'interval' && Number(job.interval_seconds) >= 10;
    const nextRunAt = isInterval ? mysqlDate(Date.now() + Number(job.interval_seconds) * 1000) : null;
    await databaseService.updateScheduledJobStatus(jobId, isInterval ? 'active' : 'failed', { percent: 100, message: `任务失败：${error.message || '未知错误'}`, error: error.message || '未知错误', finishedAt: mysqlDate(new Date()), nextRunAt, itemStatus: 'failed' });
  }
}

async function stopRunningScheduledProductImages(jobs = []) {
  for (const job of jobs) {
    if (job?.status !== 'running' || job?.job_type !== 'product_image') continue;
    const productId = Number(job.payload?.productId);
    if (Number.isInteger(productId) && productId > 0) await databaseService.cancelProductImageGeneration(job.user_id, productId, `scheduled-${job.id}`);
  }
}

async function runDueScheduledJobs() {
  if (scheduledJobRunning || !databaseService) return;
  scheduledJobRunning = true;
  try {
    const jobs = await databaseService.claimDueScheduledJobs(100);
    for (const job of jobs) await executeScheduledJob(job);
  } finally { scheduledJobRunning = false; }
}

function configureScheduledJobTimer() {
  clearScheduledJobTimer();
  scheduledJobTimer = setInterval(() => { runDueScheduledJobs().catch(() => {}); }, 10000);
  runDueScheduledJobs().catch(() => {});
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1080, minHeight: 680,
    title: `易绘上架工作台 v${app.getVersion()}`,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.js') }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}
app.whenReady().then(() => {
  databaseService = new DatabaseService(app.getPath('userData'));
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), packaged: app.isPackaged, releasesUrl: 'https://github.com/wumingyuanxxx/test-upload-v2/releases' }));
  ipcMain.handle('updates:status', () => updateState);
  ipcMain.handle('updates:check', async () => {
    if (!app.isPackaged) return publishUpdateState({ status: 'development', message: '开发模式不检查在线更新。' });
    try { await autoUpdater.checkForUpdates(); return updateState; }
    catch (error) { return publishUpdateState({ status: 'error', message: `检查更新失败：${String(error?.message || '未知错误').slice(0, 300)}` }); }
  });
  ipcMain.handle('updates:download', async () => {
    if (updateState.status !== 'available') return { ...updateState, ok: false, message: '当前没有可下载的更新。' };
    try { await autoUpdater.downloadUpdate(); return { ...updateState, ok: true }; }
    catch (error) { return { ...publishUpdateState({ status: 'error', message: `更新下载失败：${String(error?.message || '未知错误').slice(0, 300)}` }), ok: false }; }
  });
  ipcMain.handle('updates:install', () => {
    if (updateState.status !== 'downloaded') return { ok: false, message: '更新尚未下载完成。' };
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return { ok: true, message: '正在重启并安装更新。' };
  });
  ipcMain.handle('updates:open-releases', () => shell.openExternal('https://github.com/wumingyuanxxx/test-upload-v2/releases'));
  ipcMain.handle('config:get', () => databaseService.getConfig());
  ipcMain.handle('config:save', async (_event, config) => {
    const saved = await databaseService.saveConfig(config);
    configureSyncTimer(saved);
    await databaseService.migrateLegacyTargetStoreSync(saved);
    return saved;
  });
  ipcMain.handle('database:test', (_event, config) => databaseService.testConnection(config));
  ipcMain.handle('database:initialize', (_event, config) => databaseService.initializeDatabase(config));
  ipcMain.handle('miaoshou:test', async (_event, config) => new MiaoshouClient(config.miaoshou).testConnection());
  ipcMain.handle('oss:test', async (_event, config) => new OssClient(config.oss).testConnection());
  ipcMain.handle('oss:settings:save', (_event, oss, userId) => databaseService.saveOssSettings(oss, userId));
  ipcMain.handle('templates:categories:common:package-image:upload', (_event, userId, categoryId, file) => databaseService.uploadCommonCategoryPackageImage(userId, categoryId, file));
  ipcMain.handle('products:description-image:upload', (_event, userId, productId, file) => databaseService.uploadProductDescriptionImage(userId, productId, file));
  ipcMain.handle('wms:stock:plan', async (_event, userId, productId) => {
    try { return await getWmsStockImportPlan(userId, productId); }
    catch (error) { return { ok: false, message: error?.message || '读取入库商品失败。' }; }
  });
  ipcMain.handle('wms:captcha', async () => {
    try { return await requestWmsCaptcha(); }
    catch (error) { return { ok: false, message: error?.message || '读取 WMS 验证码失败。' }; }
  });
  ipcMain.handle('wms:login', (_event, credentials) => loginAndSaveWmsToken(credentials));
  ipcMain.handle('wms:stock:import', async (_event, userId, productId, sizes) => {
    try { return await importProductStockToWms(userId, productId, sizes); }
    catch (error) { return { ok: false, message: error?.message || 'WMS 入库失败。' }; }
  });
  ipcMain.handle('wms:stock:records:list', (_event, userId, page, pageSize) => databaseService.listWmsStockImportRecords(userId, page, pageSize));
  ipcMain.handle('wms:stock:records:get', (_event, userId, recordId) => databaseService.getWmsStockImportRecord(userId, recordId));
  ipcMain.handle('wms:stock:products:status', (_event, userId, productIds) => databaseService.getWmsStockImportStatusByProductIds(userId, productIds));
  ipcMain.handle('products:carousel-images:export', async (_event, input) => {
    try { return await exportProductCarouselImages(input); }
    catch (error) { return { ok: false, message: error?.message || '导出图片失败。' }; }
  });
  ipcMain.handle('products:carousel-images:open-directory', async (_event, directory) => {
    const error = await shell.openPath(String(directory || ''));
    return error ? { ok: false, message: error } : { ok: true };
  });
  ipcMain.handle('image-library:upload', (_event, userId, file) => databaseService.uploadLibraryImage(userId, file));
  ipcMain.handle('image-product-builder:settings:get', (_event, userId, builderType) => databaseService.getImageProductBuilderSettings(userId, builderType));
  ipcMain.handle('image-product-builder:settings:save', (_event, userId, setting, builderType) => databaseService.saveImageProductBuilderSettings(userId, setting, builderType));
  ipcMain.handle('image-product-builder:tasks:list', (_event, userId, builderType, options) => databaseService.listImageProductBuilderTasks(userId, builderType, options));
  ipcMain.handle('image-product-builder:tasks:delete', (_event, userId, taskIds, builderType) => databaseService.deleteImageProductBuilderTasks(userId, taskIds, builderType));
  ipcMain.handle('image-product-builder:tasks:export-images', async (_event, userId, taskIds, imageGroup, builderType) => {
    const images = await databaseService.getImageProductBuilderTaskImages(userId, taskIds, imageGroup, builderType);
    if (!images.ok) return images;
    return exportImageProductBuilderTaskImages(images.tasks, imageGroup === 'carousel' ? '轮播图' : '原图');
  });
  ipcMain.handle('image-product-builder:task:image:delete', (_event, userId, taskId, imageGroup, imageUrl, builderType) => databaseService.deleteImageProductBuilderTaskImage(userId, taskId, imageGroup, imageUrl, builderType));
  ipcMain.handle('image-product-builder:task:start', async (event, userId, input, builderType) => {
    const created = await databaseService.createImageProductBuilderTask(userId, input, builderType);
    if (created.ok && input?.scheduleType === 'queue') {
      const childItems = Array.isArray(input?.scheduledItems) && input.scheduledItems.length
        ? input.scheduledItems
        : [{ itemType: 'original_image', title: '生成原图', targetId: created.taskId }, { itemType: 'carousel_image', title: '生成轮播图', targetId: created.taskId }];
      const scheduled = await databaseService.createScheduledJob(userId, {
        jobType: 'image_product_builder', title: created.itemNumber, scheduleType: input.scheduleType || 'once',
        scheduledAt: input.scheduleAt, intervalSeconds: input.intervalSeconds,
        payload: { builderTaskId: created.taskId, builderType: builderType || 'tablecloth' }, items: childItems,
      });
      if (!scheduled.ok) return scheduled;
      return { ...created, scheduled: true, scheduledJobId: scheduled.jobId, message: `${created.itemNumber} 已加入定时任务队列。` };
    }
    if (created.ok) setImmediate(() => databaseService.runImageProductBuilderTask(userId, created.taskId, (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send('image-product-builder:progress', progress);
    }));
    return created;
  });
  ipcMain.handle('scheduled-jobs:create', (_event, userId, input) => databaseService.createScheduledJob(userId, input));
  ipcMain.handle('scheduled-jobs:list', (_event, userId, options) => databaseService.listScheduledJobs(userId, options));
  ipcMain.handle('scheduled-jobs:cancel', async (_event, userId, jobId) => {
    const result = await databaseService.cancelScheduledJob(userId, jobId);
    if (result.ok) await stopRunningScheduledProductImages([result.job]);
    return result;
  });
  ipcMain.handle('scheduled-jobs:cancel-batch', async (_event, userId, jobIds) => {
    const result = await databaseService.cancelScheduledJobs(userId, jobIds);
    if (result.ok) await stopRunningScheduledProductImages(result.jobs);
    return result;
  });
  ipcMain.handle('scheduled-jobs:delete-batch', (_event, userId, jobIds) => databaseService.deleteScheduledJobs(userId, jobIds));
  ipcMain.handle('scheduled-jobs:run-now', async (_event, userId, jobIds, options) => {
    const claimed = await databaseService.claimScheduledJobsNow(userId, jobIds, options);
    if (claimed.ok) setImmediate(() => claimed.jobs.reduce((chain, job) => chain.then(() => executeScheduledJob(job)), Promise.resolve()));
    return { ok: claimed.ok, message: claimed.message, count: claimed.jobs?.length || 0 };
  });
  ipcMain.handle('scheduled-jobs:item:retry', async (event, userId, jobId, itemId) => {
    const context = await databaseService.getScheduledJobItemRetryContext(userId, jobId, itemId);
    if (!context.ok) return context;
    if (context.jobType !== 'image_product_builder' || !['original_image', 'carousel_image'].includes(context.item.itemType)) return { ok: false, message: '当前子任务不支持单独重试。' };
    const builderTaskId = Number(context.jobPayload.builderTaskId);
    if (!Number.isInteger(builderTaskId) || builderTaskId < 1) return { ok: false, message: '未找到对应的以图建品任务。' };
    const group = context.item.itemType === 'carousel_image' ? 'carousel' : 'original';
    if (group === 'carousel' && (!Number.isInteger(Number(context.item.payload?.templateId)) || Number(context.item.payload.templateId) < 1)) return { ok: false, message: '无法识别该旧轮播图任务使用的提示词模板，请在桌布任务中重新执行轮播图。' };
    await databaseService.updateScheduledJobItemStatus(context.item.id, 'running', { percent: 1, message: '正在重新生成。' });
    const result = await databaseService.rerunImageProductBuilderTaskImages(userId, builderTaskId, group, async (progress) => {
      await databaseService.updateScheduledJobItemStatus(context.item.id, progress.status === 'failed' ? 'failed' : progress.status === 'succeeded' ? 'succeeded' : 'running', { percent: progress.percent || 1, message: progress.message || '正在重新生成。' });
      if (!event.sender.isDestroyed()) event.sender.send('image-product-builder:progress', progress);
    }, { templateId: context.item.payload?.templateId });
    if (!result.ok) await databaseService.updateScheduledJobItemStatus(context.item.id, 'failed', { percent: 100, message: result.message || '重新生成失败。', error: result.message });
    return result;
  });
  ipcMain.handle('scheduled-jobs:product-counts', (_event, userId, productIds) => databaseService.countPendingProductImageJobs(userId, productIds));
  ipcMain.handle('scheduled-jobs:queue-settings:get', (_event, userId) => databaseService.getScheduledQueueSettings(userId));
  ipcMain.handle('scheduled-jobs:queue-settings:save', (_event, userId, input) => databaseService.saveScheduledQueueSettings(userId, input));
  ipcMain.handle('image-product-builder:task:rerun-images', async (event, userId, taskId, imageGroup) => databaseService.rerunImageProductBuilderTaskImages(userId, taskId, imageGroup, (progress) => {
    if (!event.sender.isDestroyed()) event.sender.send('image-product-builder:progress', progress);
  }));
  ipcMain.handle('image-product-builder:task:create-product', async (event, userId, taskId, categoryId) => {
    const created = await databaseService.createImageProductBuilderProduct(userId, taskId, categoryId);
    if (created.ok && !created.existing) {
      setImmediate(async () => {
        const sendProgress = (progress) => {
          if (!event.sender.isDestroyed()) event.sender.send('image-product-builder:progress', { ...progress, taskId: Number(taskId), automation: true });
        };
        await databaseService.generateFolderBuilderSkus(userId, created.productId, sendProgress);
        await databaseService.runFolderBuilderAutomation(userId, created.productId, sendProgress);
      });
      return { ...created, automationStarted: true, message: `${created.message} 已按桌布 SKU AI 配置和上架自动化启动后续流程。` };
    }
    return created;
  });
  ipcMain.handle('folder-builder:settings:get', (_event, userId) => databaseService.getFolderBuilderSettings(userId));
  ipcMain.handle('folder-builder:settings:save', (_event, userId, setting) => databaseService.saveFolderBuilderSettings(userId, setting));
  ipcMain.handle('folder-builder:automation-run:latest', (_event, userId) => databaseService.getLatestFolderBuilderAutomationRun(userId));
  ipcMain.handle('folder-builder:automation-runs:list', (_event, userId, options) => databaseService.listFolderBuilderAutomationRuns(userId, options));
  ipcMain.handle('folder-builder:folders:select', async () => {
    const selected = await dialog.showOpenDialog({ title: '选择商品图片文件夹', properties: ['openDirectory', 'multiSelections'] });
    if (selected.canceled) return { ok: true, cancelled: true, folders: [] };
    const folders = await Promise.all(selected.filePaths.map(async (folderPath) => {
      try {
        const files = await listFolderBuilderImages(folderPath);
        return { folderPath, folderName: path.basename(folderPath), imageCount: files.length };
      } catch (error) {
        return { folderPath, folderName: path.basename(folderPath), imageCount: 0, error: error.message || '读取文件夹失败。' };
      }
    }));
    return { ok: true, cancelled: false, folders };
  });
  ipcMain.handle('folder-builder:create', async (event, userId, input) => {
    const send = (progress) => { if (!event.sender.isDestroyed()) event.sender.send('folder-builder:progress', progress); };
    const created = await databaseService.createFolderBuilderProduct(userId, input, send);
    if (created.ok) {
      setImmediate(async () => {
        await databaseService.generateFolderBuilderSkus(userId, created.productId, send);
        await databaseService.runFolderBuilderAutomation(userId, created.productId, send);
      });
    }
    return created;
  });
  ipcMain.handle('folder-builder:create-batch', async (event, userId, input) => {
    if (folderBuilderBatchRunning) return { ok: false, code: 'BATCH_RUNNING', message: '已有文件夹建品批次正在执行，请等待完成。' };
    const folderPaths = [...new Set((Array.isArray(input?.folderPaths) ? input.folderPaths : []).map((value) => String(value || '').trim()).filter(Boolean))];
    const categoryId = Number(input?.categoryId);
    if (!folderPaths.length) return { ok: false, code: 'VALIDATION_ERROR', message: '请至少选择一个图片文件夹。' };
    if (!Number.isInteger(categoryId) || categoryId < 1) return { ok: false, code: 'VALIDATION_ERROR', message: '请先选择常用类目。' };
    const folderNames = folderPaths.map((folderPath) => path.basename(folderPath));
    if (new Set(folderNames).size !== folderNames.length) return { ok: false, code: 'VALIDATION_ERROR', message: '所选文件夹名称存在重复，请重命名后再创建。' };
    const batchId = `folder-batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const send = (progress) => { if (!event.sender.isDestroyed()) event.sender.send('folder-builder:progress', { ...progress, batchId, batchTotal: folderPaths.length }); };
    folderBuilderBatchRunning = true;
    setImmediate(async () => {
      let succeeded = 0;
      let failed = 0;
      try {
        for (let index = 0; index < folderPaths.length; index += 1) {
          const folderPath = folderPaths[index];
          const folderName = folderNames[index];
          const batchContext = { batchIndex: index + 1, folderName };
          const itemSend = (progress) => send({ ...progress, ...batchContext });
          try {
            itemSend({ stage: 'batch_item_preparing', percent: 0, message: `正在读取文件夹 ${folderName}…` });
            const files = await listFolderBuilderImages(folderPath, true);
            const created = await databaseService.createFolderBuilderProduct(userId, { categoryId, productMainId: folderName, folderName, files }, itemSend);
            if (!created.ok) throw new Error(created.message || '创建商品失败。');
            itemSend({ stage: 'batch_item_created', percent: 100, productId: created.productId, message: `${folderName} 已创建商品，正在执行后续任务。` });
            const skuResult = await databaseService.generateFolderBuilderSkus(userId, created.productId, itemSend);
            if (!skuResult.ok && !skuResult.skipped) throw new Error(skuResult.message || 'SKU AI 识别失败。');
            const automationResult = await databaseService.runFolderBuilderAutomation(userId, created.productId, itemSend);
            if (!automationResult.ok && !automationResult.skipped) throw new Error(automationResult.message || '录入自动化失败。');
            succeeded += 1;
            itemSend({ stage: 'batch_item_succeeded', percent: 100, productId: created.productId, message: `${folderName} 已完成。` });
          } catch (error) {
            failed += 1;
            itemSend({ stage: 'batch_item_failed', percent: 100, message: `${folderName} 创建失败：${error.message || '未知错误'}` });
          }
        }
      } finally {
        folderBuilderBatchRunning = false;
        send({ stage: 'batch_completed', percent: 100, message: `批量创建完成：成功 ${succeeded} 个，失败 ${failed} 个。`, succeeded, failed });
      }
    });
    return { ok: true, started: true, batchId, total: folderPaths.length, message: `已开始串行创建 ${folderPaths.length} 个商品。` };
  });
  ipcMain.handle('folder-builder:sku-recognize', async (event, userId, productId, imageSource) => {
    const send = (progress) => { if (!event.sender.isDestroyed()) event.sender.send('folder-builder:progress', progress); };
    return databaseService.generateFolderBuilderSkus(userId, productId, send, { manual: true, imageSource });
  });
  ipcMain.handle('dashboard:overview', (_event, page, pageSize, userId, options) => databaseService.overview(page, pageSize, userId, options));
  ipcMain.handle('dashboard:home', (_event, userId, todoStatus, todoPage, todoPageSize) => databaseService.getHomeDashboard(userId, todoStatus, todoPage, todoPageSize));
  ipcMain.handle('products:edit-data', (_event, productId, userId) => databaseService.getProductForEdit(productId, userId));
  ipcMain.handle('products:update', (_event, product) => databaseService.updateProduct(product));
  ipcMain.handle('products:category-template:apply', (_event, userId, productId, options) => databaseService.applyProductCategoryAttributeTemplate(userId, productId, options));
  ipcMain.handle('products:category:update', (_event, userId, productId, categoryId) => databaseService.updateProductCategory(userId, productId, categoryId));
  ipcMain.handle('products:delete', (_event, productId) => databaseService.deleteProduct(productId));
  ipcMain.handle('products:delete-batch', (_event, productIds) => databaseService.deleteProducts(productIds));
  ipcMain.handle('products:copy-to-current-store', (_event, userId, productId) => databaseService.copyProductToCurrentStore(userId, productId));
  ipcMain.handle('products:remark-tags:add', (_event, userId, productId, tagName) => databaseService.addProductRemarkTag(userId, productId, tagName));
  ipcMain.handle('products:remark-tags:delete', (_event, userId, tagId) => databaseService.deleteProductRemarkTag(userId, tagId));
  ipcMain.handle('todos:create', (_event, userId, title, note) => databaseService.createTodoTask(userId, title, note));
  ipcMain.handle('todos:complete', (_event, userId, todoId) => databaseService.completeTodoTask(userId, todoId));
  ipcMain.handle('field-mappings:get', () => databaseService.getFieldMappings());
  ipcMain.handle('field-mappings:save', (_event, mappings) => databaseService.saveFieldMappings(mappings));
  ipcMain.handle('templates:list', (_event, templateType) => databaseService.listTemplates(templateType));
  ipcMain.handle('templates:save', (_event, template) => databaseService.saveTemplate(template));
  ipcMain.handle('templates:delete', (_event, id) => databaseService.deleteTemplate(id));
  ipcMain.handle('templates:categories:list', () => databaseService.listTemplateCategories());
  ipcMain.handle('templates:categories:search', (_event, keyword, platformCode, page, pageSize) => databaseService.searchTemplateCategories(keyword, platformCode, page, pageSize));
  ipcMain.handle('products:categories:list', (_event, userId) => databaseService.listProductCategoryOptions(userId));
  ipcMain.handle('templates:categories:common:list', (_event, userId) => databaseService.listCommonTemplateCategories(userId));
  ipcMain.handle('templates:categories:common:add', (_event, userId, categoryIds) => databaseService.addCommonTemplateCategories(userId, categoryIds));
  ipcMain.handle('templates:categories:common:remove', (_event, userId, categoryId) => databaseService.removeCommonTemplateCategory(userId, categoryId));
  ipcMain.handle('templates:categories:common:attributes', (_event, userId, categoryId) => databaseService.getCommonTemplateCategoryAttributes(userId, categoryId));
  ipcMain.handle('templates:categories:common:attributes:download', (_event, userId, categoryId) => databaseService.downloadCommonTemplateCategoryAttributes(userId, categoryId));
  ipcMain.handle('templates:categories:common:attributes:save', (_event, userId, categoryId, attributeValues) => databaseService.saveCommonTemplateCategoryAttributes(userId, categoryId, attributeValues));
  ipcMain.handle('templates:categories:origin-options', () => databaseService.getMiaoshouProductOriginOptions());
  ipcMain.handle('templates:categories:temu-full:sync', () => databaseService.syncTemuFullCategories());
  ipcMain.handle('templates:categories:create', (_event, categoryName) => databaseService.createManualCategory(categoryName));
  ipcMain.handle('templates:categories:update', (_event, categoryId, categoryName) => databaseService.updateCategory(categoryId, categoryName));
  ipcMain.handle('templates:categories:delete', (_event, categoryId) => databaseService.deleteCategory(categoryId));
  ipcMain.handle('model-providers:list', () => databaseService.getModelProviders());
  ipcMain.handle('model-providers:test-preview', (_event, provider) => databaseService.previewModelProviderConnection(provider));
  ipcMain.handle('model-providers:test', (_event, provider) => databaseService.testModelProviderConnection(provider));
  ipcMain.handle('model-providers:save', (_event, provider) => databaseService.saveModelProvider(provider));
  ipcMain.handle('model-providers:activate', (_event, id) => databaseService.activateModelProvider(id));
  ipcMain.handle('model-providers:delete', (_event, id) => databaseService.deleteModelProvider(id));
  ipcMain.handle('miaoshou:authorized-shops:get', (_event, userId) => databaseService.getAuthorizedMiaoshouShops(userId));
  ipcMain.handle('miaoshou:authorized-shops:sync', (_event, userId, profileId) => databaseService.syncAuthorizedMiaoshouShops(userId, profileId));
  ipcMain.handle('miaoshou:authorized-shops:sync-all', (_event, userId) => databaseService.syncAllAuthorizedMiaoshouShops(userId));
  ipcMain.handle('automation:publish-settings:get', (_event, userId) => databaseService.getAutomationPublishSettings(userId));
  ipcMain.handle('automation:publish-settings:save', (_event, userId, setting) => databaseService.saveAutomationPublishSettings(userId, setting));
  ipcMain.handle('automation:operation-settings:get', (_event, userId) => databaseService.getAutomationOperationSettings(userId));
  ipcMain.handle('automation:operation-settings:save', (_event, userId, setting) => databaseService.saveAutomationOperationSettings(userId, setting));
  ipcMain.handle('products:generate-title', (_event, userId, productId, input) => databaseService.generateProductTitle(userId, productId, input));
  ipcMain.handle('products:generate-images', (event, userId, productId, input) => databaseService.generateProductImages(userId, productId, {
    ...input,
    onProgress: (progress) => event.sender.send('products:generate-images:progress', progress),
  }));
  ipcMain.handle('products:generate-images:cancel', (_event, userId, productId, taskId) => databaseService.cancelProductImageGeneration(userId, productId, taskId));
  ipcMain.handle('products:generate-sku-images', (event, userId, productId, input) => databaseService.generateProductSkuImages(userId, productId, {
    ...input,
    onProgress: (progress) => event.sender.send('products:generate-images:progress', progress),
  }));
  ipcMain.handle('miaoshou:write-preview', (_event, userId, productIds) => databaseService.getMiaoshouWritePreview(userId, productIds));
  ipcMain.handle('miaoshou:folder-builder:import', (_event, userId, productId) => databaseService.importFolderBuilderProductToMiaoshou(userId, productId));
  ipcMain.handle('miaoshou:write-back', (_event, userId, productIds) => databaseService.writeBackMiaoshouProducts(userId, productIds));
  ipcMain.handle('miaoshou:publish-product', (_event, userId, productId) => databaseService.publishMiaoshouProduct(userId, productId));
  ipcMain.handle('miaoshou:write-records', (_event, userId, page, pageSize, filters) => databaseService.getMiaoshouWriteRecords(userId, page, pageSize, filters));
  ipcMain.handle('miaoshou:folder-import-records', (_event, userId, page, pageSize, filters) => databaseService.getMiaoshouFolderImportRecords(userId, page, pageSize, filters));
  ipcMain.handle('miaoshou:common-collect-box:sync', (_event, userId) => databaseService.syncMiaoshouCommonCollectBox(userId));
  ipcMain.handle('miaoshou:common-collect-box:list', (_event, userId, page, pageSize, filters) => databaseService.getMiaoshouCommonCollectBoxItems(userId, page, pageSize, filters));
  ipcMain.handle('ai:generation-records', (_event, userId, page, pageSize, filters) => databaseService.getAiGenerationRecords(userId, page, pageSize, filters));
  ipcMain.handle('ai:generation-records:retry', (event, userId, recordId) => databaseService.retryAiGenerationRecord(userId, recordId, (progress) => {
    if (!event.sender.isDestroyed()) event.sender.send('products:generate-images:progress', progress);
    if (!event.sender.isDestroyed()) event.sender.send('folder-builder:progress', progress);
  }));
  ipcMain.handle('image-library:sync', (_event, userId) => databaseService.syncImageLibrary(userId));
  ipcMain.handle('image-library:list', (_event, userId, page, pageSize, filters) => databaseService.getImageLibrary(userId, page, pageSize, filters));
  ipcMain.handle('image-library:export', async (_event, userId, itemIds) => {
    const images = await databaseService.getImageLibraryExportItems(userId, itemIds);
    if (!images.ok) return images;
    try {
      const result = await exportImageLibraryImages(images.items.map((item) => item.image_url));
      return { ...result, skipped: images.skipped };
    } catch (error) { return { ok: false, message: error?.message || '导出图库图片失败。' }; }
  });
  ipcMain.handle('image-library:ai-edit:settings:get', (_event, userId) => databaseService.getAiImageEditSettings(userId));
  ipcMain.handle('image-library:ai-edit:settings:save', (_event, userId, setting) => databaseService.saveAiImageEditSettings(userId, setting));
  ipcMain.handle('image-library:ai-edit:start', async (event, userId, input) => {
    const taskId = `image-edit-${Date.now()}-${++aiImageEditTaskSequence}`;
    const send = (payload) => { if (!event.sender.isDestroyed()) event.sender.send('image-library:ai-edit:progress', { taskId, ...payload }); };
    const started = await databaseService.startAiImageEditTask(userId, taskId);
    if (!started.ok) return started;
    setImmediate(async () => {
      send({ stage: 'running', percent: 5, message: '任务已创建，正在准备源图片。' });
      const result = await databaseService.generateLibraryImageEdit(userId, { ...input, taskId, onProgress: send });
      send({ stage: result.ok ? 'succeeded' : 'failed', percent: result.ok ? 100 : undefined, result, message: result.message });
    });
    return { ok: true, taskId, progress: started.progress, message: 'AI 改图任务已在后台启动。' };
  });
  ipcMain.handle('miaoshou:target-store:sync', async (_event, _config, userId) => {
    // 手动刷新只执行同步；同步配置只能由“定时任务”页面保存，避免旧页面表单覆盖间隔设置。
    const saved = await databaseService.getConfig();
    return runTargetStoreCollectBoxSync(saved, 'manual', userId);
  });
  ipcMain.handle('sync:status', async () => ({
    running: syncRunning,
    nextSyncAt,
    config: (await databaseService.getConfig()).sync,
    latestRun: await databaseService.getLatestSyncRun(),
  }));
  ipcMain.handle('auth:login', (_event, credentials) => databaseService.login(credentials));
  databaseService.getConfig().then(async (config) => {
    configureSyncTimer(config);
    await databaseService.migrateLegacyTargetStoreSync(config);
    await databaseService.recoverInterruptedScheduledJobs();
    configureScheduledJobTimer();
  }).catch(() => configureScheduledJobTimer());
  Menu.setApplicationMenu(null); configureAutoUpdater(); createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { clearSyncTimer(); clearScheduledJobTimer(); if (process.platform !== 'darwin') app.quit(); });
