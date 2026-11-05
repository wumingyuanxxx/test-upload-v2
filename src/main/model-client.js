function endpointFromBase(apiBaseUrl, suffix, acceptedBaseSuffix = '/v1') {
  let url;
  try { url = new URL(String(apiBaseUrl || '').trim()); } catch (_) { throw new Error('API Base URL 格式无效。'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('API Base URL 仅支持 HTTP 或 HTTPS。');
  url.username = ''; url.password = ''; url.search = ''; url.hash = '';
  const basePath = url.pathname.replace(/\/+$/, '');
  url.pathname = basePath.endsWith(acceptedBaseSuffix) ? `${basePath}${suffix}` : `${basePath}${acceptedBaseSuffix}${suffix}`;
  return url.toString();
}

function openAiChatCompletionsEndpoint(apiBaseUrl) { return endpointFromBase(apiBaseUrl, '/chat/completions'); }
function openAiImageEditsEndpoint(apiBaseUrl) { return endpointFromBase(apiBaseUrl, '/images/edits'); }

function seedreamImageGenerationsEndpoint(apiBaseUrl) {
  let url;
  try { url = new URL(String(apiBaseUrl || '').trim()); } catch (_) { throw new Error('API Base URL 格式无效。'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('API Base URL 仅支持 HTTP 或 HTTPS。');
  url.username = ''; url.password = ''; url.search = ''; url.hash = '';
  const basePath = url.pathname.replace(/\/+$/, '');
  url.pathname = basePath.endsWith('/images/generations') ? basePath : `${basePath}/images/generations`;
  return url.toString();
}

function zhipuChatCompletionsEndpoint(apiBaseUrl) {
  let url;
  try { url = new URL(String(apiBaseUrl || '').trim()); } catch (_) { throw new Error('API Base URL 格式无效。'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('API Base URL 仅支持 HTTP 或 HTTPS。');
  url.username = ''; url.password = ''; url.search = ''; url.hash = '';
  const basePath = url.pathname.replace(/\/+$/, '');
  url.pathname = basePath.endsWith('/chat/completions') ? basePath : `${basePath}/chat/completions`;
  return url.toString();
}

function isSeedreamProvider(provider) {
  return String(provider?.provider_type || '').trim() === 'seedream'
    || /seedream/i.test(String(provider?.provider_name || ''))
    || /ark\.cn-beijing\.volces\.com/i.test(String(provider?.api_base_url || ''));
}

const IMAGE_ADAPTERS = {
  openai_images_edits: { endpoint: openAiImageEditsEndpoint, defaultSize: '1024x1024', input: 'multipart' },
  seedream_images: { endpoint: seedreamImageGenerationsEndpoint, defaultSize: '2k', input: 'url_json' },
};

function imageAdapterId(provider) {
  const configured = String(provider?.image_adapter || '').trim();
  if (IMAGE_ADAPTERS[configured]) return configured;
  return isSeedreamProvider(provider) ? 'seedream_images' : 'openai_images_edits';
}

function providerCapabilities(provider) {
  const type = String(provider?.provider_type || 'openai_compatible').trim();
  if (type === 'seedream') return { text: false, image: true, imageInput: 'url' };
  if (type === 'zhipu') return { text: true, image: false, imageInput: null };
  return { text: true, image: true, imageInput: IMAGE_ADAPTERS[imageAdapterId(provider)].input };
}

function providerRequestModes(provider) {
  const capabilities = providerCapabilities(provider);
  const type = String(provider?.provider_type || 'openai_compatible').trim();
  const apiBaseUrl = String(provider?.api_base_url || '').trim();
  const modes = [];
  try {
    if (capabilities.text) modes.push({ capability: '文本 / 标题 / SKU 识别', method: 'POST', endpoint: type === 'zhipu' ? zhipuChatCompletionsEndpoint(apiBaseUrl) : openAiChatCompletionsEndpoint(apiBaseUrl), contentType: 'application/json' });
    if (capabilities.image) {
      const adapter = IMAGE_ADAPTERS[imageAdapterId(provider)];
      modes.push({ capability: capabilities.imageInput === 'url' ? '生图（图片 URL 参考）' : '生图（本地图片参考）', method: 'POST', endpoint: adapter.endpoint(apiBaseUrl), contentType: capabilities.imageInput === 'url' ? 'application/json' : 'multipart/form-data' });
    }
  } catch (_) {
    modes.push({ capability: '请求地址', method: '—', endpoint: '请填写有效的 API Base URL', contentType: '—' });
  }
  return modes;
}

function responseText(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(responseText).filter(Boolean).join('').trim();
  if (value && typeof value === 'object') return responseText(value.text || value.content || value.value || '');
  return '';
}

function chatCompletionText(payload) {
  const choice = payload?.choices?.[0] || {};
  return responseText(choice?.message?.content) || responseText(choice?.text) || responseText(payload?.output_text)
    || responseText(payload?.data?.choices?.[0]?.message?.content) || responseText(payload?.data?.output_text)
    || responseText(payload?.data?.output) || responseText(payload?.output);
}

class ModelClientError extends Error {
  constructor(message, { code = 'MODEL_REQUEST_ERROR', status = null, retryable = false, providerMessage = '' } = {}) {
    super(message); this.name = 'ModelClientError'; this.code = code; this.status = status; this.retryable = retryable; this.providerMessage = providerMessage;
  }
}

function errorFromResponse(status, bodyText, retryAfter = null) {
  let providerMessage = '';
  try { const data = JSON.parse(bodyText); providerMessage = String(data?.error?.message || data?.message || data?.msg || '').replace(/\s+/g, ' ').trim().slice(0, 300); }
  catch (_) { providerMessage = String(bodyText || '').replace(/\s+/g, ' ').trim().slice(0, 300); }
  const retryHint = Number.isFinite(Number(retryAfter)) && Number(retryAfter) > 0 ? ` 建议 ${Math.ceil(Number(retryAfter))} 秒后重试。` : '';
  const messages = { 401: '模型认证失败，请检查 API Key。', 403: '没有调用该模型的权限，请检查模型授权。', 404: '未找到模型接口，请检查 API Base URL、模型和接口能力。', 429: `模型服务限流或额度不足。${retryHint}` };
  const message = messages[status] || `模型服务返回 HTTP ${status}。`;
  return new ModelClientError(`${message}${providerMessage ? ` 供应商说明：${providerMessage}` : ''}`, {
    code: status === 502 ? 'MODEL_UPSTREAM_UNREACHABLE' : 'MODEL_HTTP_ERROR', status, retryable: status === 408 || status === 429 || status >= 500, providerMessage,
  });
}

class ModelClient {
  constructor({ fetchImpl = global.fetch } = {}) { this.fetchImpl = fetchImpl; }

  chatEndpoint(provider) { return provider?.provider_type === 'zhipu' ? zhipuChatCompletionsEndpoint(provider.api_base_url) : openAiChatCompletionsEndpoint(provider.api_base_url); }

  imageAdapter(provider) { return imageAdapterId(provider); }

  imageSize(provider) {
    const configured = String(provider?.image_size || '').trim();
    return configured || IMAGE_ADAPTERS[this.imageAdapter(provider)].defaultSize;
  }

  imageEndpoint(provider) {
    if (provider?.provider_type === 'zhipu') throw new ModelClientError('当前智谱适配仅支持对话模型；请选择支持图片编辑接口的图片模型。', { code: 'MODEL_CAPABILITY_UNSUPPORTED' });
    return IMAGE_ADAPTERS[this.imageAdapter(provider)].endpoint(provider.api_base_url);
  }

  async requestJson({ endpoint, headers, body, timeoutMs, signal }) {
    const controller = signal ? null : new AbortController();
    const requestSignal = signal || controller.signal;
    const timer = controller && Number.isFinite(Number(timeoutMs)) ? setTimeout(() => controller.abort(), Number(timeoutMs)) : null;
    try {
      const response = await this.fetchImpl(endpoint, { method: 'POST', headers, body, signal: requestSignal });
      if (!response.ok) throw errorFromResponse(response.status, await response.text(), response.headers.get('retry-after'));
      let payload;
      try { payload = await response.json(); } catch (_) { throw new ModelClientError('模型服务未返回有效 JSON。', { code: 'MODEL_INVALID_RESPONSE' }); }
      if (payload?.success === false || (Number.isFinite(Number(payload?.code)) && Number(payload.code) >= 400)) {
        const code = Number(payload?.code); const providerMessage = String(payload?.msg || payload?.message || '').trim().slice(0, 500);
        throw new ModelClientError(providerMessage ? `模型服务业务失败（代码 ${code || '未知'}）：${providerMessage}` : `模型服务业务失败（代码 ${code || '未知'}）。`, { code: code === 401 ? 'MODEL_AUTH_ERROR' : 'MODEL_BUSINESS_ERROR', status: code || null, retryable: code === 429 || code >= 500, providerMessage });
      }
      return payload;
    } catch (error) {
      if (error instanceof ModelClientError) throw error;
      if (error?.name === 'AbortError') throw new ModelClientError(`模型调用超时（${Math.round(Number(timeoutMs || 0) / 1000)} 秒）。`, { code: 'MODEL_TIMEOUT', retryable: true });
      if (/fetch failed|network|socket|ECONN/i.test(String(error?.message || ''))) throw new ModelClientError('无法连接模型服务，请检查网络和 API Base URL。', { code: 'MODEL_NETWORK_ERROR', retryable: true });
      throw error;
    } finally { if (timer) clearTimeout(timer); }
  }
}

module.exports = { ModelClient, ModelClientError, openAiChatCompletionsEndpoint, openAiImageEditsEndpoint, seedreamImageGenerationsEndpoint, zhipuChatCompletionsEndpoint, isSeedreamProvider, providerCapabilities, providerRequestModes, responseText, chatCompletionText, IMAGE_ADAPTERS };
