// ============================================================
//  Ni创·AI文游平台 - 后端服务
//  所有API密钥存储在后端，前端通过session token请求AI调用
// ============================================================

// ============================================================
//  【管理员配置区域】- 直接写死配置，部署后不会丢失
// ============================================================
const HARD_CONFIG = {
  // 平台ID: 0=DeepSeek, 1=OpenAI, 2=通义千问, 3=GLM, 4=Moonshot, 5=硅基流动, 6=百炼, 7=自定义
  platformId: 0,
  
  // API Key（直接写死在这里最安全）
  apiKey: process.env.API_KEY || '',
  
  // 自定义API地址（如使用代理）
  customApiUrl: '',
  
  // 使用的模型（如 deepseek-chat）
  model: '',
  
  // 默认兑换码配置（写死后，所有兑换码都使用这个配置）
  // 可选：写一个固定兑换码，或者禁用管理员生成功能
  fixedCode: {
    enabled: true,
    code: 'NI CHUANG',  // 固定兑换码
    totalTurns: 100     // 100回合
  }
};
// ============================================================

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3210;

// ============================================================
//  PostgreSQL 数据库连接
// ============================================================
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:iuudUMlJxAIxTImmXpOoAnbjODWAaOiQ@postgres.railway.internal:5432/railway';

let pool;
try {
  pool = new Pool({ connectionString: DATABASE_URL });
  console.log('✅ PostgreSQL 连接池已创建');
} catch (e) {
  console.error('❌ PostgreSQL 连接失败:', e.message);
}

// 初始化数据库表
async function initDatabase() {
  if (!pool) return false;
  try {
    // 兑换码表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS redeem_codes (
        code VARCHAR(20) PRIMARY KEY,
        platform_id INTEGER DEFAULT 0,
        api_key TEXT,
        custom_url TEXT,
        custom_model TEXT,
        total_turns INTEGER DEFAULT 0,
        used_turns INTEGER DEFAULT 0,
        activated_by TEXT,
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
      )
    `);
    console.log('✅ 兑换码表初始化完成');

    // 头像存储表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS avatars (
        id SERIAL PRIMARY KEY,
        owner_id VARCHAR(50) NOT NULL,  -- 用户标识（session token或设备ID）
        avatar_type VARCHAR(20) NOT NULL,  -- 类型：npc/character/script
        target_name VARCHAR(100) NOT NULL,  -- 对应名称（NPC名/角色ID/剧本ID）
        image_data TEXT NOT NULL,  -- Base64图片数据
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        UNIQUE(owner_id, avatar_type, target_name)
      )
    `);
    console.log('✅ 头像表初始化完成');

    // 剧本存储表（支持自定义剧本共享和审核）
    await pool.query(`
      CREATE TABLE IF NOT EXISTS scripts (
        id VARCHAR(50) PRIMARY KEY,  -- 剧本ID
        title VARCHAR(100) NOT NULL,  -- 剧本标题
        description TEXT,  -- 剧本简介
        tag VARCHAR(30),  -- 剧本类型标签
        start_msg TEXT,  -- 开场白
        quick_actions TEXT,  -- 快速行动（JSON数组字符串）
        attr_config JSONB,  -- 属性配置（JSON）
        author_id VARCHAR(50) NOT NULL,  -- 作者ID
        author_name VARCHAR(50),  -- 作者名称
        status VARCHAR(20) DEFAULT 'pending',  -- 审核状态：pending/approved/rejected
        reviewer_id VARCHAR(50),  -- 审核者ID
        reviewer_name VARCHAR(50),  -- 审核者名称
        review_note TEXT,  -- 审核备注
        play_count INTEGER DEFAULT 0,  -- 游玩次数
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        updated_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
      )
    `);
    console.log('✅ 剧本表初始化完成');

    return true;
  } catch (e) {
    console.error('❌ 数据库初始化失败:', e.message);
    return false;
  }
}

// 异步初始化（不阻塞启动）
initDatabase().then(ok => {
  if (ok) console.log('✅ 数据库就绪');
});

// 中间件 - CORS 支持跨域访问
const corsOptions = {
  origin: process.env.ALLOWED_ORIGIN || true, // 默认允许所有域名，或指定环境变量
  credentials: true
};
app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));

// 静态文件服务 - 前端HTML（兼容多种目录结构）
let staticPath = path.join(__dirname, 'avatars');
if (!fs.existsSync(staticPath)) staticPath = path.join(__dirname, '..', 'avatars');
if (!fs.existsSync(staticPath)) staticPath = __dirname; // 根目录
console.log('静态文件路径:', staticPath);

app.use(express.static(staticPath, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
    }
  }
}));

// 根路径重定向到游戏页面
app.get('/', (req, res) => {
  res.redirect('/index.html');
});

// ============================================================
//  数据存储（JSON文件持久化）
// ============================================================
// 数据存储目录（兼容多种部署结构）
let DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR = __dirname, { recursive: true });
console.log('数据存储路径:', DATA_DIR);

function loadJSON(filename, defaultValue) {
  const fp = path.join(DATA_DIR, filename);
  try {
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch (e) { console.error(`Load ${filename} error:`, e.message); }
  return defaultValue;
}

function saveJSON(filename, data) {
  const fp = path.join(DATA_DIR, filename);
  try {
    fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) { console.error(`Save ${filename} error:`, e.message); }
}

// 管理员配置（优先从环境变量读取API Key）
let adminConfig = loadJSON('admin.json', {
  password: 'nichuang_admin_2024',  // 可通过管理面板修改
  platforms: [
    { id: 0, name: 'DeepSeek',       url: 'https://api.deepseek.com',                    model: 'deepseek-chat' },
    { id: 1, name: 'DeepSeek(R1)',   url: 'https://api.deepseek.com',                    model: 'deepseek-reasoner' },
    { id: 2, name: 'OpenAI',         url: 'https://api.openai.com/v1',                   model: 'gpt-4o-mini' },
    { id: 3, name: 'OpenAI(GPT4o)',  url: 'https://api.openai.com/v1',                   model: 'gpt-4o' },
    { id: 4, name: '通义千问',        url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-turbo' },
    { id: 5, name: '智谱GLM',        url: 'https://open.bigmodel.cn/api/paas/v4',        model: 'glm-4-flash' },
    { id: 6, name: '月之暗面',        url: 'https://api.moonshot.cn/v1',                  model: 'moonshot-v1-8k' },
    { id: 7, name: '硅基流动',        url: 'https://api.siliconflow.cn/v1',               model: 'deepseek-ai/DeepSeek-V3' },
    { id: 8, name: '百炼',           url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    { id: 9, name: '自定义',         url: '',                                            model: '' },
  ],
  defaultPlatform: 0,
  defaultApiKey: '',  // 默认API密钥
  defaultCustomUrl: '',
  defaultCustomModel: ''
});

// 兑换码数据库（文件方式保留作为 fallback）
let redeemCodes = loadJSON('redeem_codes.json', {});  // { code: { platformId, apiKey, customUrl, customModel, totalTurns, usedTurns, activatedBy, createdAt } }

// 数据库操作辅助函数
async function getCodeFromDB(code) {
  if (!pool) return null;
  try {
    const result = await pool.query('SELECT * FROM redeem_codes WHERE code = $1', [code]);
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      platformId: row.platform_id,
      apiKey: row.api_key,
      customUrl: row.custom_url,
      customModel: row.custom_model,
      totalTurns: row.total_turns,
      usedTurns: row.used_turns,
      activatedBy: row.activated_by,
      createdAt: row.created_at
    };
  } catch (e) {
    console.error('查询兑换码失败:', e.message);
    return null;
  }
}

async function getAllCodesFromDB() {
  if (!pool) return {};
  try {
    const result = await pool.query('SELECT * FROM redeem_codes ORDER BY created_at DESC');
    const codes = {};
    for (const row of result.rows) {
      codes[row.code] = {
        platformId: row.platform_id,
        apiKey: row.api_key,
        customUrl: row.custom_url,
        customModel: row.custom_model,
        totalTurns: row.total_turns,
        usedTurns: row.used_turns,
        activatedBy: row.activated_by,
        createdAt: row.created_at
      };
    }
    return codes;
  } catch (e) {
    console.error('查询所有兑换码失败:', e.message);
    return {};
  }
}

async function saveCodeToDB(codeData) {
  if (!pool) return false;
  try {
    await pool.query(`
      INSERT INTO redeem_codes (code, platform_id, api_key, custom_url, custom_model, total_turns, used_turns, activated_by, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (code) DO UPDATE SET
        platform_id = $2, api_key = $3, custom_url = $4, custom_model = $5,
        total_turns = $6, used_turns = $7, activated_by = $8
    `, [codeData.code, codeData.platformId, codeData.apiKey, codeData.customUrl, codeData.customModel, codeData.totalTurns, codeData.usedTurns, codeData.activatedBy, codeData.createdAt]);
    return true;
  } catch (e) {
    console.error('保存兑换码失败:', e.message);
    return false;
  }
}

async function updateCodeUsedInDB(code, usedTurns, activatedBy) {
  if (!pool) return false;
  try {
    await pool.query('UPDATE redeem_codes SET used_turns = $1, activated_by = $2 WHERE code = $3', [usedTurns, activatedBy, code]);
    return true;
  } catch (e) {
    console.error('更新兑换码失败:', e.message);
    return false;
  }
}

async function deleteCodeFromDB(code) {
  if (!pool) return false;
  try {
    await pool.query('DELETE FROM redeem_codes WHERE code = $1', [code]);
    return true;
  } catch (e) {
    console.error('删除兑换码失败:', e.message);
    return false;
  }
}

async function clearAllCodesFromDB() {
  if (!pool) return false;
  try {
    await pool.query('DELETE FROM redeem_codes');
    return true;
  } catch (e) {
    console.error('清空兑换码失败:', e.message);
    return false;
  }
}

// Session存储（内存中，重启后需重新兑换）
let sessions = {};  // { sessionToken: { code, platformId, apiUrl, model, remaining, totalTurns, usedTurns, createdAt } }

// 管理员session（持久化到文件，重启不丢失）
let adminSession = loadJSON('admin_session.json', null);

// 优先从环境变量读取 API Key（Railway 部署时使用）
if (process.env.API_KEY) {
  adminConfig.defaultApiKey = process.env.API_KEY;
  console.log('✅ 使用环境变量 API_KEY');
}
if (process.env.DEFAULT_PLATFORM) {
  adminConfig.defaultPlatform = parseInt(process.env.DEFAULT_PLATFORM) || 0;
}
if (process.env.API_URL) {
  // 自定义 API URL（可选）
  console.log('✅ 使用自定义 API URL:', process.env.API_URL);
}

// 健康检查端点
app.get('/api/health', async (req, res) => {
  const dbCodes = await getAllCodesFromDB();
  res.json({
    status: 'ok',
    version: '1.0.0',
    codes: Object.keys(redeemCodes).length,
    dbCodes: Object.keys(dbCodes).length,
    dbConnected: !!pool
  });
});

// ============================================================
//  头像存储 API
// ============================================================

// 判断头像类型是否需要用户隔离
// NPC头像和剧本封面是公共的（所有用户共享），角色头像是个人化的
function needsUserIsolation(avatarType) {
  return avatarType === 'character'; // 只有角色头像需要按用户隔离
}

// 获取存储用的ownerId
function getOwnerId(req, avatarType) {
  // NPC和剧本封面不区分用户（公共资源），角色头像按用户隔离
  if (!needsUserIsolation(avatarType)) {
    return 'public';
  }
  return req.headers['x-session-token'] || req.headers['x-device-id'] || 'anonymous';
}

// 保存头像
app.post('/api/avatar', async (req, res) => {
  const { avatarType, targetName, imageData } = req.body;

  if (!avatarType || !targetName || !imageData) {
    return res.status(400).json({ error: '缺少必要参数' });
  }

  const ownerId = getOwnerId(req, avatarType);

  try {
    if (!pool) {
      return res.status(503).json({ error: '数据库未连接' });
    }

    await pool.query(`
      INSERT INTO avatars (owner_id, avatar_type, target_name, image_data)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (owner_id, avatar_type, target_name)
      DO UPDATE SET image_data = $4, created_at = EXTRACT(EPOCH FROM NOW())::BIGINT
    `, [ownerId, avatarType, targetName, imageData]);

    res.json({ success: true, message: '头像保存成功' });
  } catch (e) {
    console.error('保存头像失败:', e.message);
    res.status(500).json({ error: '保存失败: ' + e.message });
  }
});

// 获取头像
app.get('/api/avatar', async (req, res) => {
  const { avatarType, targetName } = req.query;

  if (!avatarType || !targetName) {
    return res.status(400).json({ error: '缺少必要参数' });
  }

  const ownerId = getOwnerId(req, avatarType);

  try {
    if (!pool) {
      return res.status(503).json({ error: '数据库未连接' });
    }

    const result = await pool.query(`
      SELECT image_data FROM avatars
      WHERE owner_id = $1 AND avatar_type = $2 AND target_name = $3
    `, [ownerId, avatarType, targetName]);

    if (result.rows.length > 0) {
      res.json({ success: true, imageData: result.rows[0].image_data });
    } else {
      res.json({ success: false, error: '头像不存在' });
    }
  } catch (e) {
    console.error('获取头像失败:', e.message);
    res.status(500).json({ error: '获取失败: ' + e.message });
  }
});

// 获取用户所有头像列表（角色头像返回个人的，NPC/剧本封面返回公共的）
app.get('/api/avatar/list', async (req, res) => {
  // 返回公共头像 + 当前用户的个人头像
  try {
    if (!pool) {
      return res.status(503).json({ error: '数据库未连接' });
    }

    // 获取公共头像（NPC、剧本封面）
    const publicResult = await pool.query(`
      SELECT avatar_type, target_name, created_at FROM avatars
      WHERE owner_id = 'public'
      ORDER BY created_at DESC
    `);

    // 获取当前用户的个人头像
    const userId = req.headers['x-session-token'] || req.headers['x-device-id'] || 'anonymous';
    const userResult = await pool.query(`
      SELECT avatar_type, target_name, created_at FROM avatars
      WHERE owner_id = $1
      ORDER BY created_at DESC
    `, [userId]);

    // 合并结果
    const allAvatars = [...publicResult.rows, ...userResult.rows];
    res.json({ success: true, avatars: allAvatars });
  } catch (e) {
    console.error('获取头像列表失败:', e.message);
    res.status(500).json({ error: '获取失败: ' + e.message });
  }
});

// 删除头像
app.delete('/api/avatar', async (req, res) => {
  const { avatarType, targetName } = req.body;

  if (!avatarType || !targetName) {
    return res.status(400).json({ error: '缺少必要参数' });
  }

  const ownerId = getOwnerId(req, avatarType);

  try {
    if (!pool) {
      return res.status(503).json({ error: '数据库未连接' });
    }

    await pool.query(`
      DELETE FROM avatars
      WHERE owner_id = $1 AND avatar_type = $2 AND target_name = $3
    `, [ownerId, avatarType, targetName]);

    res.json({ success: true, message: '头像已删除' });
  } catch (e) {
    console.error('删除头像失败:', e.message);
    res.status(500).json({ error: '删除失败: ' + e.message });
  }
});

// ============================================================
//  剧本存储 API（支持自定义剧本共享和审核）
// ============================================================

// 获取用户ID
function getUserId(req) {
  return req.headers['x-session-token'] || req.headers['x-device-id'] || 'anonymous';
}

// 获取用户名（从session或header）
function getUserName(req) {
  return req.headers['x-user-name'] || '匿名用户';
}

// 保存或更新剧本
app.post('/api/script', async (req, res) => {
  const { id, title, description, tag, startMsg, quickActions, attrConfig, authorName } = req.body;

  if (!id || !title) {
    return res.status(400).json({ error: '缺少必要参数' });
  }

  const authorId = getUserId(req);
  const author = authorName || getUserName(req);

  try {
    if (!pool) {
      return res.status(503).json({ error: '数据库未连接' });
    }

    // 检查是否已存在剧本
    const existing = await pool.query(`SELECT status FROM scripts WHERE id = $1`, [id]);

    let status = 'pending';
    let message = '剧本已提交审核';

    if (existing.rows.length > 0) {
      // 已存在的剧本，更新内容，状态重置为待审核
      await pool.query(`
        UPDATE scripts SET
          title = $1, description = $2, tag = $3, start_msg = $4,
          quick_actions = $5, attr_config = $6, author_name = $7,
          status = 'pending', updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT
        WHERE id = $8
      `, [title, description, tag, startMsg, JSON.stringify(quickActions), JSON.stringify(attrConfig), author, id]);
      message = '剧本已更新，重新提交审核';
    } else {
      // 新剧本，插入数据库
      await pool.query(`
        INSERT INTO scripts (id, title, description, tag, start_msg, quick_actions, attr_config, author_id, author_name, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
      `, [id, title, description, tag, startMsg, JSON.stringify(quickActions), JSON.stringify(attrConfig), authorId, author]);
    }

    res.json({ success: true, message, status: 'pending' });
  } catch (e) {
    console.error('保存剧本失败:', e.message);
    res.status(500).json({ error: '保存失败: ' + e.message });
  }
});

// 获取剧本列表（返回官方剧本 + 已通过的自定义剧本 + 用户自己的待审核/被拒绝剧本）
app.get('/api/scripts', async (req, res) => {
  const userId = getUserId(req);
  const includeAll = req.query.includeAll === 'true';  // 是否包含所有状态（用于审核）

  try {
    if (!pool) {
      return res.status(503).json({ error: '数据库未连接' });
    }

    let query = '';
    let params = [];

    if (includeAll && (userId === 'admin' || userId === 'nichuang_admin')) {
      // 管理员：返回所有剧本
      query = `SELECT * FROM scripts ORDER BY created_at DESC`;
    } else {
      // 普通用户：返回已通过的剧本 + 自己的待审核/被拒绝剧本
      query = `SELECT * FROM scripts WHERE status = 'approved' OR (author_id = $1) ORDER BY created_at DESC`;
      params = [userId];
    }

    const result = await pool.query(query, params);
    res.json({ success: true, scripts: result.rows });
  } catch (e) {
    console.error('获取剧本列表失败:', e.message);
    res.status(500).json({ error: '获取失败: ' + e.message });
  }
});

// 获取单个剧本详情
app.get('/api/script/:id', async (req, res) => {
  const { id } = req.params;
  const userId = getUserId(req);

  try {
    if (!pool) {
      return res.status(503).json({ error: '数据库未连接' });
    }

    const result = await pool.query(`SELECT * FROM scripts WHERE id = $1`, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: '剧本不存在' });
    }

    const script = result.rows[0];

    // 只有作者本人或审核通过的剧本才能查看详情
    if (script.status !== 'approved' && script.author_id !== userId && userId !== 'admin' && userId !== 'nichuang_admin') {
      return res.status(403).json({ error: '无权查看此剧本' });
    }

    res.json({ success: true, script });
  } catch (e) {
    console.error('获取剧本详情失败:', e.message);
    res.status(500).json({ error: '获取失败: ' + e.message });
  }
});

// 删除剧本（仅作者本人或管理员）
app.delete('/api/script/:id', async (req, res) => {
  const { id } = req.params;
  const userId = getUserId(req);

  try {
    if (!pool) {
      return res.status(503).json({ error: '数据库未连接' });
    }

    // 检查剧本是否存在
    const existing = await pool.query(`SELECT author_id FROM scripts WHERE id = $1`, [id]);

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: '剧本不存在' });
    }

    // 检查权限（作者本人或管理员）
    if (existing.rows[0].author_id !== userId && userId !== 'admin' && userId !== 'nichuang_admin') {
      return res.status(403).json({ error: '无权删除此剧本' });
    }

    await pool.query(`DELETE FROM scripts WHERE id = $1`, [id]);

    res.json({ success: true, message: '剧本已删除' });
  } catch (e) {
    console.error('删除剧本失败:', e.message);
    res.status(500).json({ error: '删除失败: ' + e.message });
  }
});

// ============================================================
//  剧本审核 API（管理员）
// ============================================================

// 获取待审核剧本列表
app.get('/api/admin/scripts/pending', async (req, res) => {
  const userId = getUserId(req);

  // 简单权限检查（实际应使用更严格的认证）
  if (userId !== 'admin' && userId !== 'nichuang_admin') {
    return res.status(403).json({ error: '无审核权限' });
  }

  try {
    if (!pool) {
      return res.status(503).json({ error: '数据库未连接' });
    }

    const result = await pool.query(`
      SELECT * FROM scripts WHERE status = 'pending' ORDER BY created_at ASC
    `);

    res.json({ success: true, scripts: result.rows });
  } catch (e) {
    console.error('获取待审核列表失败:', e.message);
    res.status(500).json({ error: '获取失败: ' + e.message });
  }
});

// 审核剧本（通过/拒绝）
app.post('/api/admin/script/review', async (req, res) => {
  const { id, action, reviewNote } = req.body;  // action: 'approve' | 'reject'
  const userId = getUserId(req);
  const userName = getUserName(req);

  // 权限检查
  if (userId !== 'admin' && userId !== 'nichuang_admin') {
    return res.status(403).json({ error: '无审核权限' });
  }

  if (!id || !action || !['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: '缺少必要参数' });
  }

  try {
    if (!pool) {
      return res.status(503).json({ error: '数据库未连接' });
    }

    const status = action === 'approve' ? 'approved' : 'rejected';

    await pool.query(`
      UPDATE scripts SET
        status = $1, reviewer_id = $2, reviewer_name = $3, review_note = $4, updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT
      WHERE id = $5
    `, [status, userId, userName, reviewNote || '', id]);

    res.json({ success: true, message: action === 'approve' ? '剧本已通过审核' : '剧本已拒绝', status });
  } catch (e) {
    console.error('审核剧本失败:', e.message);
    res.status(500).json({ error: '审核失败: ' + e.message });
  }
});

// 获取审核统计
app.get('/api/admin/scripts/stats', async (req, res) => {
  const userId = getUserId(req);

  if (userId !== 'admin' && userId !== 'nichuang_admin') {
    return res.status(403).json({ error: '无权限' });
  }

  try {
    if (!pool) {
      return res.status(503).json({ error: '数据库未连接' });
    }

    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending') as pending,
        COUNT(*) FILTER (WHERE status = 'approved') as approved,
        COUNT(*) FILTER (WHERE status = 'rejected') as rejected,
        COUNT(*) as total
      FROM scripts
    `);

    res.json({ success: true, stats: result.rows[0] });
  } catch (e) {
    console.error('获取统计失败:', e.message);
    res.status(500).json({ error: '获取失败: ' + e.message });
  }
});

// 更新剧本游玩次数
app.post('/api/script/:id/play', async (req, res) => {
  const { id } = req.params;

  try {
    if (!pool) {
      return res.status(503).json({ error: '数据库未连接' });
    }

    await pool.query(`UPDATE scripts SET play_count = play_count + 1 WHERE id = $1`, [id]);

    res.json({ success: true });
  } catch (e) {
    console.error('更新游玩次数失败:', e.message);
    res.status(500).json({ error: '更新失败: ' + e.message });
  }
});

// ============================================================
//  工具函数
// ============================================================
const SHORT_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateShortCode() {
  const arr = crypto.randomBytes(8);
  let code = 'NC';
  for (let i = 0; i < 8; i++) {
    code += SHORT_CODE_CHARS[arr[i] % SHORT_CODE_CHARS.length];
    if (i === 3) code += '-';
  }
  return code; // NC-XXXX-XXXX
}

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function getPlatformConfig(platformId) {
  return adminConfig.platforms.find(p => p.id === platformId) || adminConfig.platforms[9];
}

function getApiUrlAndModel(platformId, customUrl, customModel) {
  if (platformId === 9 || platformId === undefined) {
    return {
      apiUrl: customUrl || adminConfig.defaultCustomUrl,
      model: customModel || adminConfig.defaultCustomModel || 'deepseek-chat'
    };
  }
  const platform = getPlatformConfig(platformId);
  return { apiUrl: platform.url, model: platform.model };
}

function cleanExpiredSessions() {
  const now = Date.now();
  const MAX_AGE = 24 * 60 * 60 * 1000; // 24小时过期
  let cleaned = 0;
  for (const [token, sess] of Object.entries(sessions)) {
    if (now - sess.createdAt > MAX_AGE) {
      delete sessions[token];
      cleaned++;
    }
  }
  if (cleaned > 0) console.log(`Cleaned ${cleaned} expired sessions`);
}

// 每30分钟清理过期session
setInterval(cleanExpiredSessions, 30 * 60 * 1000);

// ============================================================
//  API 路由 - 玩家端
// ============================================================

// 1. 兑换码激活 → 返回session token（支持数据库）
app.post('/api/redeem', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: '请输入兑换码' });

  const cleanCode = code.trim().toUpperCase().replace(/[-\s]/g, '');
  
  // ========== 优先使用硬编码配置 ==========
  if (HARD_CONFIG.fixedCode && HARD_CONFIG.fixedCode.enabled) {
    const fixed = HARD_CONFIG.fixedCode;
    const fixedClean = fixed.code.trim().toUpperCase().replace(/[-\s]/g, '');
    
    if (cleanCode === fixedClean || code.trim() === fixed.code) {
      // 验证成功，使用硬编码配置
      if (!HARD_CONFIG.apiKey) {
        return res.status(500).json({ error: '服务器未配置API Key，请联系管理员' });
      }
      
      const { apiUrl, model } = getApiUrlAndModel(
        HARD_CONFIG.platformId, 
        HARD_CONFIG.customApiUrl, 
        HARD_CONFIG.model
      );
      
      const sessionToken = generateSessionToken();
      sessions[sessionToken] = {
        code: fixed.code,
        platformId: HARD_CONFIG.platformId,
        apiKey: HARD_CONFIG.apiKey,
        apiUrl,
        model,
        totalTurns: fixed.totalTurns,
        usedTurns: 0,
        remaining: fixed.totalTurns,
        createdAt: Date.now(),
        isFixed: true
      };
      
      console.log(`✅ 固定兑换码激活成功: ${code}, ${fixed.totalTurns}回合`);
      
      return res.json({
        sessionToken,
        remaining: fixed.totalTurns,
        totalTurns: fixed.totalTurns,
        platformName: getPlatformConfig(HARD_CONFIG.platformId)?.name || '自定义'
      });
    }
  }
  // ========== 硬编码配置结束 ==========

  // 尝试多种格式匹配（包括原始输入格式）
  const tryKeys = [
    cleanCode,
    code.trim().toUpperCase().replace(/\s/g, ''),  // 保留原始带-格式
    'NC-' + cleanCode.slice(2, 6) + '-' + cleanCode.slice(6),
    cleanCode.replace(/^NC/, 'NC-').replace(/(.{7})/, '$1-')
  ];

  let codeData = null;
  let matchedKey = null;

  // 优先从数据库查询
  for (const key of tryKeys) {
    const dbCode = await getCodeFromDB(key);
    if (dbCode) {
      codeData = dbCode;
      matchedKey = key;
      break;
    }
  }

  // 如果数据库没有，fallback 到文件
  if (!codeData) {
    for (const key of tryKeys) {
      if (redeemCodes[key]) {
        codeData = redeemCodes[key];
        matchedKey = key;
        break;
      }
    }
  }

  if (!codeData) {
    return res.status(404).json({ error: '无效的兑换码，请检查是否输入正确' });
  }

  // 检查是否已被激活（一次性兑换码）
  if (codeData.activatedBy) {
    return res.status(410).json({ error: '此兑换码已被使用，无法重复激活' });
  }

  // 检查是否已用完
  if (codeData.totalTurns > 0 && codeData.usedTurns >= codeData.totalTurns) {
    return res.status(410).json({ error: '此兑换码已用完', remaining: 0 });
  }

  // 创建session
  const { apiUrl, model } = getApiUrlAndModel(codeData.platformId, codeData.customUrl, codeData.customModel);
  const sessionToken = generateSessionToken();
  const remaining = codeData.totalTurns > 0 ? codeData.totalTurns - codeData.usedTurns : -1;

  sessions[sessionToken] = {
    code: matchedKey,
    platformId: codeData.platformId,
    apiKey: codeData.apiKey,
    apiUrl,
    model,
    totalTurns: codeData.totalTurns,
    usedTurns: codeData.usedTurns,
    remaining,
    createdAt: Date.now()
  };

  // 标记兑换码已被激活（同时更新数据库和文件）
  codeData.activatedBy = true;
  await updateCodeInDB(matchedKey, codeData);
  redeemCodes[matchedKey] = codeData;
  saveJSON('redeem_codes.json', redeemCodes);

  res.json({
    success: true,
    sessionToken,
    remaining,
    totalTurns: codeData.totalTurns,
    platformName: getPlatformConfig(codeData.platformId)?.name || '自定义'
  });
});

// 辅助函数：更新数据库中的兑换码
async function updateCodeInDB(code, codeData) {
  if (!pool) return false;
  try {
    await pool.query(`
      UPDATE redeem_codes SET used_turns = $1, activated_by = $2 WHERE code = $3
    `, [codeData.usedTurns, codeData.activatedBy, code]);
    return true;
  } catch (e) {
    console.error('更新兑换码失败:', e.message);
    return false;
  }
}

// 2. 查询session状态
app.get('/api/session/:token', (req, res) => {
  const sess = sessions[req.params.token];
  if (!sess) return res.status(404).json({ error: '会话不存在或已过期' });

  res.json({
    remaining: sess.totalTurns > 0 ? sess.totalTurns - sess.usedTurns : -1,
    totalTurns: sess.totalTurns,
    usedTurns: sess.usedTurns,
    platformName: getPlatformConfig(sess.platformId)?.name || '自定义'
  });
});

// 3. AI代理调用 - 核心接口
app.post('/api/chat', async (req, res) => {
  const { sessionToken, messages, maxTokens, temperature } = req.body;
  if (!sessionToken) return res.status(401).json({ error: '缺少会话令牌' });

  const sess = sessions[sessionToken];
  if (!sess) return res.status(401).json({ error: '会话不存在或已过期，请重新兑换' });

  // 检查剩余回合
  if (sess.totalTurns > 0 && sess.usedTurns >= sess.totalTurns) {
    return res.status(403).json({ error: '兑换码已用完', remaining: 0 });
  }

  // 构建API请求
  let apiUrl = sess.apiUrl.trim();
  if (apiUrl.endsWith('/')) apiUrl = apiUrl.slice(0, -1);
  if (!apiUrl.endsWith('/chat/completions')) apiUrl += '/chat/completions';

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);

    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + sess.apiKey
      },
      body: JSON.stringify({
        model: sess.model || 'deepseek-chat',
        messages: messages,
        stream: false,
        max_tokens: maxTokens || 4096,
        temperature: temperature || 0.85
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.error('AI API error:', resp.status, errText.substring(0, 200));
      return res.status(resp.status).json({ error: `AI服务请求失败(${resp.status})`, detail: errText.substring(0, 200) });
    }

    const data = await resp.json();
    let aiText = '';
    if (data.choices && data.choices[0]) {
      aiText = data.choices[0].message?.content || data.choices[0].text || '';
    } else if (data.response) {
      aiText = data.response;
    } else if (data.result) {
      aiText = typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
    }

    if (!aiText) {
      return res.status(502).json({ error: 'AI返回了空内容' });
    }

    // 消耗1回合
    sess.usedTurns++;
    const remaining = sess.totalTurns > 0 ? sess.totalTurns - sess.usedTurns : -1;

    // 同步回兑换码数据库
    if (redeemCodes[sess.code]) {
      redeemCodes[sess.code].usedTurns = sess.usedTurns;
      saveJSON('redeem_codes.json', redeemCodes);
    }

    res.json({
      success: true,
      content: aiText,
      remaining
    });

  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: '请求超时，请检查网络' });
    }
    console.error('Chat proxy error:', err);
    res.status(500).json({ error: '服务内部错误: ' + err.message });
  }
});

// 4. 测试API连通性（管理面板用）
app.post('/api/test-connection', async (req, res) => {
  const { apiUrl, apiKey, model } = req.body;
  if (!apiUrl || !apiKey) return res.status(400).json({ error: '缺少参数' });

  let url = apiUrl.trim();
  if (url.endsWith('/')) url = url.slice(0, -1);
  if (!url.endsWith('/chat/completions')) url += '/chat/completions';

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        model: model || 'deepseek-chat',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 5
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (resp.ok) {
      res.json({ success: true, message: '连接成功' });
    } else {
      const t = await resp.text().catch(() => '');
      res.json({ success: false, message: `失败(${resp.status}): ${t.substring(0, 100)}` });
    }
  } catch (e) {
    res.json({ success: false, message: '连接失败: ' + e.message });
  }
});

// ============================================================
//  API 路由 - 管理员端
// ============================================================

// 管理员登录
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== adminConfig.password) {
    return res.status(403).json({ error: '密码错误' });
  }
  adminSession = generateSessionToken();
  saveJSON('admin_session.json', adminSession);
  res.json({ success: true, adminToken: adminSession });
});

// 管理员鉴权中间件
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.adminToken;
  if (!token || token !== adminSession) {
    return res.status(401).json({ error: '请先登录管理后台' });
  }
  next();
}

// 获取管理配置
app.get('/api/admin/config', requireAdmin, (req, res) => {
  res.json({
    platforms: adminConfig.platforms,
    defaultPlatform: adminConfig.defaultPlatform,
    defaultApiKey: adminConfig.defaultApiKey ? adminConfig.defaultApiKey.substring(0, 8) + '...' : '',
    defaultCustomUrl: adminConfig.defaultCustomUrl,
    defaultCustomModel: adminConfig.defaultCustomModel,
    hasApiKey: !!adminConfig.defaultApiKey
  });
});

// 更新管理配置（保存API密钥）
app.post('/api/admin/config', requireAdmin, (req, res) => {
  const { platformId, apiKey, customUrl, customModel, password } = req.body;

  if (platformId !== undefined) adminConfig.defaultPlatform = platformId;
  if (apiKey) adminConfig.defaultApiKey = apiKey;
  if (customUrl !== undefined) adminConfig.defaultCustomUrl = customUrl;
  if (customModel !== undefined) adminConfig.defaultCustomModel = customModel;
  if (password && password.length >= 4) adminConfig.password = password;

  saveJSON('admin.json', adminConfig);
  res.json({ success: true });
});

// 批量生成兑换码（同时保存到数据库）
app.post('/api/admin/generate-codes', requireAdmin, async (req, res) => {
  const { platformId, apiKey, customUrl, customModel, turns, count } = req.body;

  if (!apiKey && !adminConfig.defaultApiKey) {
    return res.status(400).json({ error: '请填写API密钥' });
  }
  if (!turns || turns < 1) {
    return res.status(400).json({ error: '回合数至少为1' });
  }
  const pid = platformId !== undefined ? platformId : adminConfig.defaultPlatform;
  const key = apiKey || adminConfig.defaultApiKey;

  const total = Math.min(count || 1, 500);
  const codes = [];
  const now = Date.now();

  // 先获取所有现有兑换码（从数据库）
  const existingCodes = await getAllCodesFromDB();

  for (let i = 0; i < total; i++) {
    let shortCode;
    // 确保不重复
    do {
      shortCode = generateShortCode();
    } while (existingCodes[shortCode] || redeemCodes[shortCode]);

    const codeData = {
      code: shortCode,
      platformId: pid,
      apiKey: key,
      customUrl: pid === 9 ? (customUrl || '') : '',
      customModel: pid === 9 ? (customModel || '') : '',
      totalTurns: turns,
      usedTurns: 0,
      activatedBy: null,
      createdAt: now
    };

    // 保存到内存和文件
    redeemCodes[shortCode] = codeData;
    existingCodes[shortCode] = codeData;
    // 保存到数据库
    await saveCodeToDB(codeData);

    codes.push(shortCode);
  }

  // 同步更新admin配置中的默认API密钥
  if (key) adminConfig.defaultApiKey = key;
  saveJSON('admin.json', adminConfig);
  saveJSON('redeem_codes.json', redeemCodes);

  console.log(`✅ 生成 ${codes.length} 个兑换码，存入数据库`);
  res.json({ success: true, codes, count: codes.length });
});

// 获取兑换码列表（优先从数据库读取）
app.get('/api/admin/codes', requireAdmin, async (req, res) => {
  // 从数据库获取
  const dbCodes = await getAllCodesFromDB();
  // 合并文件中的（如果有）
  for (const [k, v] of Object.entries(redeemCodes)) {
    if (!dbCodes[k]) dbCodes[k] = v;
  }
  
  const list = Object.entries(dbCodes).map(([code, data]) => ({
    code,
    platformId: data.platformId,
    platformName: getPlatformConfig(data.platformId)?.name || '自定义',
    totalTurns: data.totalTurns,
    usedTurns: data.usedTurns,
    remaining: data.totalTurns > 0 ? data.totalTurns - data.usedTurns : -1,
    activatedBy: data.activatedBy ? '已激活' : '未使用',
    createdAt: new Date(data.createdAt).toLocaleString('zh-CN')
  }));

  // 按创建时间倒序
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(list);
});

// 删除兑换码（同时删除数据库）
app.delete('/api/admin/codes/:code', requireAdmin, async (req, res) => {
  const code = req.params.code.toUpperCase().replace(/[-\s]/g, '');
  // 尝试带前缀格式
  const tryKeys = [
    code,
    'NC-' + code.slice(2, 6) + '-' + code.slice(6)
  ];
  let deleted = false;
  for (const key of tryKeys) {
    if (redeemCodes[key]) {
      delete redeemCodes[key];
      deleted = true;
    }
    // 从数据库删除
    await deleteCodeFromDB(key);
  }
  if (deleted) {
    saveJSON('redeem_codes.json', redeemCodes);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: '兑换码不存在' });
  }
});

// 清空所有兑换码（同时清空数据库）
app.post('/api/admin/clear-codes', requireAdmin, async (req, res) => {
  redeemCodes = {};
  saveJSON('redeem_codes.json', redeemCodes);
  await clearAllCodesFromDB();
  res.json({ success: true });
});

// 修改管理员密码
app.post('/api/admin/change-password', requireAdmin, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (oldPassword !== adminConfig.password) return res.status(403).json({ error: '当前密码错误' });
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: '新密码至少4位' });
  adminConfig.password = newPassword;
  saveJSON('admin.json', adminConfig);
  res.json({ success: true });
});

// 获取统计信息（优先从数据库读取）
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  const dbCodes = await getAllCodesFromDB();
  // 合并文件中的
  for (const [k, v] of Object.entries(redeemCodes)) {
    if (!dbCodes[k]) dbCodes[k] = v;
  }
  
  const totalCodes = Object.keys(dbCodes).length;
  const usedCodes = Object.values(dbCodes).filter(c => c.usedTurns > 0).length;
  const activeSessions = Object.keys(sessions).length;

  res.json({ totalCodes, usedCodes, activeSessions });
});

// ============================================================
//  启动服务
// ============================================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════╗
║  🎮 Ni创·AI文游 后端服务已启动       ║
║  📍 http://localhost:${PORT}            ║
║  📋 管理后台: 前端页面 → 管理员入口   ║
╚══════════════════════════════════════╝
  `);

  // 显示配置状态
  if (adminConfig.defaultApiKey) {
    console.log(`✅ 默认API密钥已配置 (${adminConfig.defaultApiKey.substring(0, 8)}...)`);
  } else {
    console.log('⚠️  尚未配置默认API密钥，请登录管理后台设置');
  }
  console.log(`📦 兑换码数量: ${Object.keys(redeemCodes).length}`);
});
