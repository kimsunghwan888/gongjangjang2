const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const ENV_PATH = path.join(__dirname, '.env');
try {
  process.loadEnvFile(ENV_PATH);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const PORT = Number(process.env.PORT) || 3000;
const HOST = '127.0.0.1';
const MIN_VIEWS = 50_000_000;
const MAX_RESULTS = 10;
const MAX_BODY_BYTES = 1_000_000;
const SCHEDULE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const INDEX_PATH = path.join(__dirname, 'index.html');
const DATA_DIR = path.join(__dirname, 'data');
const STATE_PATH = path.join(DATA_DIR, 'research-state.json');
const SEARCH_TERMS = ['women weight loss', 'weight loss transformation', 'diet transformation', '여성 다이어트'];
const MAX_SHORT_SECONDS = 180;

const candidates = new Map();
let schedule = {
  enabled: false,
  intervalDays: 7,
  nextRunAt: null,
  lastRunAt: null,
  lastStatus: 'not-started',
  lastMessage: '리서치 검색을 아직 실행하지 않았습니다.'
};
let researchRunning = false;

function saveState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporaryPath = `${STATE_PATH}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify({
    version: 1,
    candidates: [...candidates.values()],
    schedule
  }, null, 2), 'utf8');
  fs.renameSync(temporaryPath, STATE_PATH);
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return;
  let savedState;
  try {
    savedState = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (error) {
    throw new Error(`리서치 상태 파일을 읽을 수 없습니다: ${error.message}`);
  }
  if (!savedState || !Array.isArray(savedState.candidates)) {
    throw new Error('리서치 상태 파일 형식이 올바르지 않습니다.');
  }
  for (const candidate of savedState.candidates) {
    if (validateCandidate(candidate, 0)) {
      throw new Error('리서치 상태 파일에 유효하지 않은 콘텐츠가 있습니다.');
    }
    candidate.tags = normalizeTags(candidate.tags || []);
    candidate.keywords = candidate.tags.length ? candidate.tags : extractTitleKeywords(candidate.caption || '');
    candidate.keywordSource = candidate.tags.length ? 'video-tags' : 'title';
    candidate.comments ||= { status: 'not-fetched', message: '다시 리서치하면 댓글을 가져옵니다.', items: [] };
    candidates.set(candidate.url, candidate);
  }
  if (savedState.schedule && typeof savedState.schedule === 'object') {
    schedule = { ...schedule, ...savedState.schedule };
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(payload));
}

function sendError(res, statusCode, message, details) {
  const payload = { success: false, message };
  if (details) payload.details = details;
  sendJson(res, statusCode, payload);
}

function getTopItems() {
  return [...candidates.values()]
    .sort((left, right) => right.viewCount - left.viewCount)
    .slice(0, MAX_RESULTS);
}

function getPopularKeywords(items = getTopItems()) {
  const keywordTotals = new Map();
  for (const item of items) {
    const keywords = item.tags?.length ? item.tags : item.keywords || [];
    for (const tag of keywords) {
      const key = tag.toLocaleLowerCase();
      const total = keywordTotals.get(key) || { keyword: tag, videoCount: 0, taggedVideoCount: 0, titleVideoCount: 0, totalViews: 0 };
      total.videoCount += 1;
      if (item.tags?.length) total.taggedVideoCount += 1;
      else total.titleVideoCount += 1;
      total.totalViews += item.viewCount;
      keywordTotals.set(key, total);
    }
  }
  return [...keywordTotals.values()]
    .sort((left, right) => right.totalViews - left.totalViews || right.videoCount - left.videoCount)
    .slice(0, 3);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let byteCount = 0;

    req.on('data', chunk => {
      byteCount += chunk.length;
      if (byteCount > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('요청 크기는 1MB 이하여야 합니다.'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('JSON 형식의 요청 본문이 필요합니다.'), { statusCode: 400 }));
      }
    });

    req.on('error', reject);
  });
}

function validateCandidate(item, index) {
  const prefix = `items[${index}]`;
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return `${prefix}는 객체여야 합니다.`;
  }
  if (typeof item.url !== 'string') return `${prefix}.url이 필요합니다.`;

  let parsedUrl;
  try {
    parsedUrl = new URL(item.url);
  } catch {
    return `${prefix}.url 형식이 올바르지 않습니다.`;
  }

  const validHost = ['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(parsedUrl.hostname);
  const videoId = parsedUrl.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{11})\/?$/)?.[1];
  if (parsedUrl.protocol !== 'https:' || !validHost || !videoId) {
    return `${prefix}.url은 YouTube Shorts 주소여야 합니다.`;
  }
  if (!Number.isSafeInteger(item.viewCount) || item.viewCount < MIN_VIEWS) {
    return `${prefix}.viewCount는 50,000,000 이상의 정수여야 합니다.`;
  }
  if (item.topicMatch !== true) {
    return `${prefix}.topicMatch를 true로 확인해야 합니다.`;
  }
  if (!Number.isInteger(item.durationSeconds) || item.durationSeconds < 1 || item.durationSeconds > MAX_SHORT_SECONDS) {
    return `${prefix}.durationSeconds는 1초 이상 180초 이하여야 합니다.`;
  }
  if (item.caption !== undefined && (typeof item.caption !== 'string' || item.caption.length > 3000)) {
    return `${prefix}.caption은 3,000자 이하여야 합니다.`;
  }
  if (item.account !== undefined && (typeof item.account !== 'string' || item.account.length > 120)) {
    return `${prefix}.account는 120자 이하여야 합니다.`;
  }
  if (item.tags !== undefined && (!Array.isArray(item.tags) || item.tags.length > 50 || item.tags.some(tag => typeof tag !== 'string' || tag.length > 100))) {
    return `${prefix}.tags는 100자 이하 문자열을 50개까지 포함할 수 있습니다.`;
  }

  return null;
}

function storeCandidates(items) {
  const errors = items.map(validateCandidate).filter(Boolean);
  if (errors.length > 0) return errors;

  for (const item of items) {
    const canonicalUrl = new URL(item.url).toString();
    const previous = candidates.get(canonicalUrl);
    const tags = normalizeTags(item.tags || []);
    candidates.set(canonicalUrl, {
      id: previous?.id || randomUUID(),
      url: canonicalUrl,
      viewCount: item.viewCount,
      durationSeconds: item.durationSeconds,
      topicMatch: true,
      account: item.account || '',
      caption: item.caption || '',
      tags,
      keywords: tags.length ? tags : extractTitleKeywords(item.caption || ''),
      keywordSource: tags.length ? 'video-tags' : 'title',
      comments: item.comments && Array.isArray(item.comments.items)
        ? {
            status: ['available', 'empty', 'disabled', 'error'].includes(item.comments.status) ? item.comments.status : 'error',
            message: typeof item.comments.message === 'string' ? item.comments.message.slice(0, 500) : '',
            items: item.comments.items.slice(0, 5).flatMap(comment => (
              comment && typeof comment.text === 'string'
                ? [{
                    text: comment.text.slice(0, 1000),
                    author: typeof comment.author === 'string' ? comment.author.slice(0, 100) : '익명',
                    likeCount: Number.isSafeInteger(comment.likeCount) && comment.likeCount >= 0 ? comment.likeCount : 0
                  }]
                : []
            ))
          }
        : { status: 'not-fetched', message: '다시 리서치하면 댓글을 가져옵니다.', items: [] },
      source: item.source || 'manual',
      checkedAt: new Date().toISOString()
    });
  }
  saveState();
  return null;
}

function durationInSeconds(duration) {
  const parts = duration.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!parts) return 0;
  return Number(parts[1] || 0) * 3600 + Number(parts[2] || 0) * 60 + Number(parts[3] || 0);
}

const KEYWORD_STOP_WORDS = new Set([
  'the', 'and', 'with', 'from', 'this', 'that', 'weight', 'loss',
  'shorts', 'short', 'video', '운동', '다이어트', '여성'
]);

function normalizeTags(tags = []) {
  const keywords = [];
  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    const keyword = tag.replace(/^#+/, '').trim();
    if (keyword.length < 2 || keyword.length > 100) continue;
    if (!keywords.some(existing => existing.toLocaleLowerCase() === keyword.toLocaleLowerCase())) keywords.push(keyword);
    if (keywords.length === 3) break;
  }
  return keywords;
}

function extractTitleKeywords(title) {
  const hashtags = [...title.matchAll(/#([\w가-힣-]+)/g)].map(match => match[1]);
  const words = [...hashtags, ...(title.match(/[가-힣]{2,}|[A-Za-z][A-Za-z0-9-]{2,}/g) || [])];
  const keywords = [];
  for (const word of words) {
    if (KEYWORD_STOP_WORDS.has(word.toLowerCase())) continue;
    if (!keywords.some(existing => existing.toLocaleLowerCase() === word.toLocaleLowerCase())) keywords.push(word);
    if (keywords.length === 3) break;
  }
  return keywords;
}

async function youtubeApi(endpoint, params, apiKey) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  for (const [name, value] of Object.entries({ ...params, key: apiKey })) {
    url.searchParams.set(name, value);
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = payload.error?.errors?.[0]?.reason || '';
    const googleMessage = payload.error?.message || '';
    let message = 'YouTube Data API 요청에 실패했습니다. Google Cloud의 API 키와 YouTube Data API v3 설정을 확인해 주세요.';
    if (/API key not valid/i.test(googleMessage) || reason === 'keyInvalid') {
      message = 'Google이 API 키를 유효하지 않다고 거절했습니다. Google Cloud Console에서 키를 다시 발급하고 YouTube Data API v3 및 키 제한을 확인해 주세요.';
    } else if (reason === 'accessNotConfigured' || /has not been used in project|disabled/i.test(googleMessage)) {
      message = '이 키의 Google Cloud 프로젝트에서 YouTube Data API v3를 사용 설정해 주세요.';
    } else if (reason === 'quotaExceeded') {
      message = '오늘 YouTube Data API 할당량을 모두 사용했습니다. 할당량이 초기화된 뒤 다시 시도해 주세요.';
    }
    throw Object.assign(new Error(message), { statusCode: 502, reason });
  }
  return payload;
}

async function collectShorts(apiKey) {
  const searchPages = await Promise.all(SEARCH_TERMS.map(query => youtubeApi('search', {
    part: 'snippet',
    type: 'video',
    order: 'viewCount',
    videoDuration: 'short',
    maxResults: '50',
    q: query
  }, apiKey)));

  const videoIds = [...new Set(searchPages.flatMap(page => (page.items || []).map(item => item.id?.videoId).filter(Boolean)))];
  const videoPages = [];
  for (let offset = 0; offset < videoIds.length; offset += 50) {
    videoPages.push(await youtubeApi('videos', {
      part: 'snippet,statistics,contentDetails',
      id: videoIds.slice(offset, offset + 50).join(',')
    }, apiKey));
  }

  const videos = videoPages.flatMap(page => page.items || [])
    .map(video => {
      const tags = normalizeTags(video.snippet?.tags || []);
      return {
        id: video.id,
        url: `https://www.youtube.com/shorts/${video.id}`,
        viewCount: Number(video.statistics?.viewCount || 0),
        durationSeconds: durationInSeconds(video.contentDetails?.duration || ''),
        topicMatch: true,
        account: video.snippet?.channelTitle || '',
        caption: video.snippet?.title || '',
        tags,
        keywords: tags.length ? tags : extractTitleKeywords(video.snippet?.title || ''),
        keywordSource: tags.length ? 'video-tags' : 'title',
        comments: { status: 'pending', message: '댓글을 불러오는 중입니다.', items: [] },
        source: 'YouTube Data API',
        publishedAt: video.snippet?.publishedAt || '',
        checkedAt: new Date().toISOString()
      };
    })
    .filter(video => video.viewCount >= MIN_VIEWS && video.durationSeconds > 0 && video.durationSeconds <= MAX_SHORT_SECONDS);

  const topVideos = videos.sort((left, right) => right.viewCount - left.viewCount).slice(0, MAX_RESULTS);
  return Promise.all(topVideos.map(async video => {
    try {
      const response = await youtubeApi('commentThreads', {
        part: 'snippet',
        videoId: video.id,
        order: 'relevance',
        maxResults: '100',
        textFormat: 'plainText'
      }, apiKey);
      const comments = (response.items || []).map(thread => {
        const comment = thread.snippet?.topLevelComment?.snippet;
        if (!comment || typeof comment.textDisplay !== 'string') return null;
        return {
          text: comment.textDisplay.trim().slice(0, 1000),
          author: (comment.authorDisplayName || '익명').slice(0, 100),
          likeCount: Number(comment.likeCount || 0)
        };
      }).filter(Boolean).sort((left, right) => right.likeCount - left.likeCount).slice(0, 5);
      video.comments = {
        status: comments.length ? 'available' : 'empty',
        message: comments.length ? '' : '공개된 댓글이 없습니다.',
        items: comments
      };
    } catch (error) {
      const disabled = error.reason === 'commentsDisabled';
      video.comments = {
        status: disabled ? 'disabled' : 'error',
        message: disabled ? '이 영상은 댓글이 비활성화되어 있습니다.' : error.message,
        items: []
      };
    }
    return video;
  }));
}

async function runResearch() {
  if (researchRunning) {
    return { success: false, statusCode: 409, message: '리서치가 이미 실행 중입니다.' };
  }

  researchRunning = true;
  const now = new Date();
  const apiKey = (process.env.YOUTUBE_API_KEY || '').trim();
  schedule.lastRunAt = now.toISOString();

  try {
    if (!apiKey) {
      schedule.lastStatus = 'blocked';
      schedule.lastMessage = 'YOUTUBE_API_KEY가 설정되지 않았습니다. 키를 환경변수로 설정한 뒤 다시 실행하세요.';
      return { success: false, statusCode: 503, message: schedule.lastMessage };
    }

    const foundItems = await collectShorts(apiKey);
    const errors = storeCandidates(foundItems);
    if (errors) throw new Error('YouTube 검색 결과의 형식을 확인할 수 없습니다.');
    schedule.lastStatus = 'completed';
    schedule.lastMessage = foundItems.length
      ? `${foundItems.length}개의 5천만 조회 이상 Shorts 후보를 확인했습니다.`
      : '검색 결과에서 기준에 맞는 Shorts 후보를 찾지 못했습니다.';
    const items = getTopItems();
    return { success: true, statusCode: 200, data: { items, popularKeywords: getPopularKeywords(items), candidateCount: candidates.size, message: schedule.lastMessage } };
  } catch (error) {
    schedule.lastStatus = 'error';
    schedule.lastMessage = error.statusCode === 502 ? error.message : 'YouTube 검색 중 오류가 발생했습니다.';
    return { success: false, statusCode: error.statusCode || 502, message: schedule.lastMessage };
  } finally {
    if (schedule.enabled) schedule.nextRunAt = new Date(Date.now() + SCHEDULE_INTERVAL_MS).toISOString();
    researchRunning = false;
  }
}

async function handleRequest(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = requestUrl.pathname;

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    fs.readFile(INDEX_PATH, (error, html) => {
      if (error) {
        sendError(res, 500, '화면 파일을 읽을 수 없습니다.');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(html);
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, { success: true, data: { status: 'ok', provider: 'YouTube Data API', providerConfigured: Boolean((process.env.YOUTUBE_API_KEY || '').trim()) } });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/research') {
    sendJson(res, 200, {
      success: true,
      data: {
        criteria: { topic: '여성 다이어트', platform: 'YouTube Shorts 후보', minViews: MIN_VIEWS, maxDurationSeconds: MAX_SHORT_SECONDS, limit: MAX_RESULTS },
        items: getTopItems(),
        popularKeywords: getPopularKeywords(),
        candidateCount: candidates.size,
        schedule: { ...schedule }
      }
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/research/items') {
    const body = await readJsonBody(req);
    if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 200) {
      sendError(res, 400, 'items에는 확인된 콘텐츠를 1개 이상 200개 이하로 담아야 합니다.');
      return;
    }
    const errors = storeCandidates(body.items);
    if (errors) {
      sendError(res, 400, '일부 콘텐츠가 기준에 맞지 않아 저장하지 않았습니다.', errors);
      return;
    }
    sendJson(res, 201, { success: true, data: { items: getTopItems(), candidateCount: candidates.size } });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/research/run') {
    const result = await runResearch();
    if (!result.success) {
      sendError(res, result.statusCode, result.message);
      return;
    }
    sendJson(res, 200, { success: true, data: result.data });
    return;
  }

  if (req.method === 'PATCH' && pathname === '/api/schedule') {
    const body = await readJsonBody(req);
    if (typeof body.enabled !== 'boolean') {
      sendError(res, 400, 'enabled에는 true 또는 false가 필요합니다.');
      return;
    }
    if (body.enabled && !(process.env.YOUTUBE_API_KEY || '').trim()) {
      sendError(res, 503, '정기 실행을 켜려면 YOUTUBE_API_KEY 환경변수를 먼저 설정해야 합니다.');
      return;
    }
    schedule.enabled = body.enabled;
    schedule.intervalDays = 7;
    schedule.nextRunAt = body.enabled ? new Date(Date.now() + SCHEDULE_INTERVAL_MS).toISOString() : null;
    schedule.lastStatus = body.enabled ? 'waiting-for-provider' : 'paused';
    schedule.lastMessage = body.enabled
      ? '이 서버가 계속 실행 중일 때 7일 간격으로 YouTube 검색을 실행합니다.'
      : '정기 리서치가 일시 중지되었습니다.';
    saveState();
    sendJson(res, 200, { success: true, data: { ...schedule } });
    return;
  }

  sendError(res, 404, '요청한 경로를 찾을 수 없습니다.');
}

function app(req, res) {
  Promise.resolve(handleRequest(req, res)).catch(error => {
    if (res.headersSent || res.destroyed) return;
    sendError(res, error.statusCode || 500, error.statusCode ? error.message : '요청 처리 중 오류가 발생했습니다.');
  });
}

module.exports = app;

if (require.main === module) {
  loadState();
  const server = http.createServer(app);
  server.listen(PORT, HOST, () => {
    console.log(`여성 다이어트 리서치 서버: http://${HOST}:${PORT}`);
  });

  const scheduleTimer = setInterval(() => {
    if (!schedule.enabled || !schedule.nextRunAt || Date.now() < Date.parse(schedule.nextRunAt)) return;
    runResearch().catch(error => {
      schedule.lastStatus = 'error';
      schedule.lastMessage = '정기 리서치 실행 중 오류가 발생했습니다.';
      console.error(error);
    });
  }, 60_000);
  scheduleTimer.unref();
}