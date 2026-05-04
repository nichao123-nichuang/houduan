// ============================================================
//  Ni创·AI文游平台 - 签到系统模块
//  每日签到领取Ni豆，连续签到获得更多奖励兑换码
// ============================================================

const crypto = require('crypto');

// 签到配置
const CHECKIN_CONFIG = {
  // 连续签到奖励配置（天数: 兑换码回合数）
  rewards: {
    1: 5,   // 第1天: 5回合
    2: 5,   // 第2天: 5回合
    3: 10,  // 第3天: 10回合
    4: 10,  // 第4天: 10回合
    5: 15,  // 第5天: 15回合
    6: 15,  // 第6天: 15回合
    7: 30,  // 第7天: 30回合（周奖励）
  },
  // 超过7天后循环奖励
  cycleReward: 5,
  // 断签后重置
  resetOnBreak: true,
  // 签到冷却时间（小时）- 防止跨天刷签
  cooldownHours: 20
};

// 初始化签到数据表
async function initCheckinTable(pool) {
  if (!pool) return false;
  try {
    // 用户签到记录表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_checkins (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL,  -- 用户标识（设备ID或session）
        checkin_date DATE NOT NULL,     -- 签到日期
        consecutive_days INTEGER DEFAULT 1,  -- 连续签到天数
        reward_turns INTEGER DEFAULT 0,      -- 本次奖励回合数
        reward_code VARCHAR(20),             -- 奖励兑换码
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        UNIQUE(user_id, checkin_date)
      )
    `);

    // 用户签到统计表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_checkin_stats (
        user_id VARCHAR(64) PRIMARY KEY,
        total_checkins INTEGER DEFAULT 0,      -- 总签到次数
        consecutive_days INTEGER DEFAULT 0,    -- 当前连续天数
        last_checkin_date DATE,                -- 最后签到日期
        total_reward_turns INTEGER DEFAULT 0,  -- 累计获得回合
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        updated_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
      )
    `);

    // 签到生成的兑换码表（与主兑换码表关联）
    await pool.query(`
      CREATE TABLE IF NOT EXISTS checkin_codes (
        code VARCHAR(20) PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL,
        checkin_date DATE NOT NULL,
        total_turns INTEGER DEFAULT 0,
        used_turns INTEGER DEFAULT 0,
        activated_by TEXT,
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
      )
    `);

    console.log('✅ 签到系统数据表初始化完成');
    return true;
  } catch (e) {
    console.error('❌ 签到表初始化失败:', e.message);
    return false;
  }
}

// 生成签到兑换码（格式: CK-XXXX-XXXX）
function generateCheckinCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const arr = crypto.randomBytes(8);
  let code = 'CK';
  for (let i = 0; i < 8; i++) {
    code += chars[arr[i] % chars.length];
    if (i === 3) code += '-';
  }
  return code; // CK-XXXX-XXXX
}

// 获取用户ID（从请求头中提取）
function getUserId(req) {
  return req.headers['x-device-id'] ||
         req.headers['x-session-token'] ||
         req.body?.deviceId ||
         'anonymous_' + Math.random().toString(36).slice(2, 10);
}

// 获取今天的日期字符串（YYYY-MM-DD）
function getToday() {
  return new Date().toISOString().split('T')[0];
}

// 获取昨天日期
function getYesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

// 计算连续签到天数
async function calculateConsecutiveDays(pool, userId) {
  try {
    const result = await pool.query(`
      SELECT consecutive_days, checkin_date
      FROM user_checkins
      WHERE user_id = $1
      ORDER BY checkin_date DESC
      LIMIT 1
    `, [userId]);

    if (result.rows.length === 0) {
      return 1; // 首次签到
    }

    const lastRecord = result.rows[0];
    const lastDate = lastRecord.checkin_date;
    const yesterday = getYesterday();
    const today = getToday();

    // 如果今天已经签到过了
    if (lastDate === today) {
      return lastRecord.consecutive_days;
    }

    // 如果昨天签到了，连续天数+1
    if (lastDate === yesterday) {
      return Math.min(lastRecord.consecutive_days + 1, 7); // 最多7天
    }

    // 断签了，重新开始
    return 1;
  } catch (e) {
    console.error('计算连续天数失败:', e.message);
    return 1;
  }
}

// 获取签到奖励回合数
function getRewardTurns(consecutiveDays) {
  const days = Math.min(consecutiveDays, 7);
  return CHECKIN_CONFIG.rewards[days] || CHECKIN_CONFIG.cycleReward;
}

// 执行签到
async function doCheckin(pool, userId, hardConfig) {
  if (!pool) return { success: false, error: '数据库未连接' };

  const today = getToday();

  try {
    // 检查今天是否已经签到
    const existing = await pool.query(`
      SELECT * FROM user_checkins WHERE user_id = $1 AND checkin_date = $2
    `, [userId, today]);

    if (existing.rows.length > 0) {
      return {
        success: false,
        error: '今日已签到',
        alreadyCheckedIn: true,
        data: existing.rows[0]
      };
    }

    // 计算连续签到天数
    const consecutiveDays = await calculateConsecutiveDays(pool, userId);

    // 计算奖励
    const rewardTurns = getRewardTurns(consecutiveDays);

    // 生成兑换码
    const rewardCode = generateCheckinCode();

    // 获取API配置（使用硬编码配置）
    const platformId = hardConfig?.platformId ?? 0;
    const apiKey = hardConfig?.apiKey || '';
    const customUrl = hardConfig?.customApiUrl || '';
    const model = hardConfig?.model || '';

    // 保存签到记录
    await pool.query(`
      INSERT INTO user_checkins (user_id, checkin_date, consecutive_days, reward_turns, reward_code)
      VALUES ($1, $2, $3, $4, $5)
    `, [userId, today, consecutiveDays, rewardTurns, rewardCode]);

    // 保存签到兑换码到兑换码表
    await pool.query(`
      INSERT INTO checkin_codes (code, user_id, checkin_date, total_turns)
      VALUES ($1, $2, $3, $4)
    `, [rewardCode, userId, today, rewardTurns]);

    // 也保存到主兑换码表（兼容原有系统）
    await pool.query(`
      INSERT INTO redeem_codes (code, platform_id, api_key, custom_url, custom_model, total_turns, used_turns)
      VALUES ($1, $2, $3, $4, $5, $6, 0)
      ON CONFLICT (code) DO UPDATE SET
        platform_id = $2, api_key = $3, custom_url = $4, custom_model = $5, total_turns = $6
    `, [rewardCode, platformId, apiKey, customUrl, model, rewardTurns]);

    // 更新用户签到统计
    await pool.query(`
      INSERT INTO user_checkin_stats (user_id, total_checkins, consecutive_days, last_checkin_date, total_reward_turns, updated_at)
      VALUES ($1, 1, $2, $3, $4, EXTRACT(EPOCH FROM NOW())::BIGINT)
      ON CONFLICT (user_id) DO UPDATE SET
        total_checkins = user_checkin_stats.total_checkins + 1,
        consecutive_days = $2,
        last_checkin_date = $3,
        total_reward_turns = user_checkin_stats.total_reward_turns + $4,
        updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT
    `, [userId, consecutiveDays, today, rewardTurns]);

    return {
      success: true,
      data: {
        checkinDate: today,
        consecutiveDays: consecutiveDays,
        rewardTurns: rewardTurns,
        rewardCode: rewardCode,
        message: `签到成功！连续${consecutiveDays}天，获得${rewardTurns}回合兑换码`
      }
    };
  } catch (e) {
    console.error('签到失败:', e.message);
    return { success: false, error: '签到失败: ' + e.message };
  }
}

// 查询签到状态
async function getCheckinStatus(pool, userId) {
  if (!pool) return { success: false, error: '数据库未连接' };

  const today = getToday();

  try {
    // 获取用户统计
    const statsResult = await pool.query(`
      SELECT * FROM user_checkin_stats WHERE user_id = $1
    `, [userId]);

    // 获取今日签到状态
    const todayResult = await pool.query(`
      SELECT * FROM user_checkins WHERE user_id = $1 AND checkin_date = $2
    `, [userId, today]);

    // 获取最近7天签到记录（用于日历显示）
    const recentResult = await pool.query(`
      SELECT checkin_date, consecutive_days, reward_turns, reward_code
      FROM user_checkins
      WHERE user_id = $1 AND checkin_date >= CURRENT_DATE - INTERVAL '30 days'
      ORDER BY checkin_date DESC
      LIMIT 30
    `, [userId]);

    const stats = statsResult.rows[0] || {
      total_checkins: 0,
      consecutive_days: 0,
      total_reward_turns: 0
    };

    // 计算明天可获得的奖励
    const tomorrowDays = Math.min((stats.consecutive_days || 0) + (todayResult.rows.length > 0 ? 0 : 1), 7);
    const tomorrowReward = getRewardTurns(tomorrowDays === 0 ? 1 : tomorrowDays);

    return {
      success: true,
      data: {
        totalCheckins: parseInt(stats.total_checkins) || 0,
        consecutiveDays: parseInt(stats.consecutive_days) || 0,
        totalRewardTurns: parseInt(stats.total_reward_turns) || 0,
        lastCheckinDate: stats.last_checkin_date,
        todayCheckedIn: todayResult.rows.length > 0,
        todayReward: todayResult.rows.length > 0 ? todayResult.rows[0].reward_turns : null,
        todayCode: todayResult.rows.length > 0 ? todayResult.rows[0].reward_code : null,
        tomorrowReward: tomorrowReward,
        recentCheckins: recentResult.rows.map(r => ({
          date: r.checkin_date,
          consecutiveDays: r.consecutive_days,
          rewardTurns: r.reward_turns,
          code: r.reward_code
        }))
      }
    };
  } catch (e) {
    console.error('查询签到状态失败:', e.message);
    return { success: false, error: '查询失败: ' + e.message };
  }
}

// 获取签到配置
function getCheckinConfig() {
  return {
    success: true,
    data: {
      rewards: CHECKIN_CONFIG.rewards,
      cycleReward: CHECKIN_CONFIG.cycleReward,
      maxConsecutiveDays: 7
    }
  };
}

// 验证签到兑换码（用于前端兑换时确认）
async function verifyCheckinCode(pool, code, userId) {
  if (!pool) return { success: false, error: '数据库未连接' };

  try {
    const result = await pool.query(`
      SELECT * FROM checkin_codes WHERE code = $1 AND user_id = $2
    `, [code, userId]);

    if (result.rows.length === 0) {
      return { success: false, error: '兑换码不存在或不属于你' };
    }

    const codeData = result.rows[0];
    return {
      success: true,
      data: {
        code: codeData.code,
        totalTurns: codeData.total_turns,
        usedTurns: codeData.used_turns,
        remaining: codeData.total_turns - codeData.used_turns,
        checkinDate: codeData.checkin_date
      }
    };
  } catch (e) {
    console.error('验证兑换码失败:', e.message);
    return { success: false, error: '验证失败: ' + e.message };
  }
}

// 更新签到兑换码使用次数
async function updateCheckinCodeUsage(pool, code, usedTurns) {
  if (!pool) return false;
  try {
    await pool.query(`
      UPDATE checkin_codes SET used_turns = $1 WHERE code = $2
    `, [usedTurns, code]);
    return true;
  } catch (e) {
    console.error('更新签到码使用次数失败:', e.message);
    return false;
  }
}

module.exports = {
  CHECKIN_CONFIG,
  initCheckinTable,
  generateCheckinCode,
  getUserId,
  getToday,
  calculateConsecutiveDays,
  getRewardTurns,
  doCheckin,
  getCheckinStatus,
  getCheckinConfig,
  verifyCheckinCode,
  updateCheckinCodeUsage
};
