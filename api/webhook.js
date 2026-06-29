const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

console.log('ENV CHECK:', {
  hasBotToken: !!BOT_TOKEN,
  hasBotUsername: !!BOT_USERNAME,
  hasSupabaseUrl: !!SUPABASE_URL,
  hasSupabaseKey: !!SUPABASE_KEY
});

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function sendMessage(chatId, text, keyboard) {
  const payload = { chat_id: chatId, text, parse_mode: 'Markdown' };
  if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, payload);
  } catch (err) {
    console.error('sendMessage error:', err.response?.data || err.message);
  }
}

async function answerCallback(id) {
  try {
    await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, { callback_query_id: id });
  } catch {}
}

async function getChatMember(channelId, userId) {
  try {
    const res = await axios.post(`${TELEGRAM_API}/getChatMember`, { chat_id: channelId, user_id: userId });
    return res.data.result;
  } catch { return null; }
}

async function getSetting(key) {
  try {
    const { data } = await supabase.from('settings').select('value').eq('key', key).single();
    return data ? data.value : null;
  } catch { return null; }
}

async function isAdmin(telegramId) {
  try {
    const { data } = await supabase.from('admins').select('id').eq('telegram_id', telegramId).single();
    return !!data;
  } catch { return false; }
}

async function getUser(telegramId) {
  try {
    const { data } = await supabase.from('users').select('*').eq('telegram_id', telegramId).single();
    return data;
  } catch { return null; }
}

async function getChannels() {
  try {
    const { data } = await supabase.from('required_channels').select('*').eq('is_active', true);
    return data || [];
  } catch { return []; }
}

async function verifyAllChannels(userId) {
  const channels = await getChannels();
  for (const ch of channels) {
    try {
      const member = await getChatMember(ch.channel_id, userId);
      if (!member || !['member', 'administrator', 'creator'].includes(member.status)) return false;
    } catch { return false; }
  }
  return true;
}

function getRank(credits) {
  if (credits >= 500) return 'Diamond 💎';
  if (credits >= 200) return 'Gold 🥇';
  if (credits >= 50) return 'Silver 🥈';
  return 'Bronze 🥉';
}

async function sendVerification(chatId) {
  const channels = await getChannels();
  const botName = await getSetting('bot_name') || 'LEAKED STUFF';
  let text = `🔒 *CHANNEL VERIFICATION*\n\n`;
  text += `📦 To use *${botName}*, join ALL channels:\n\n`;
  channels.forEach(ch => { text += `📢 [${ch.channel_name}](${ch.channel_link})\n`; });
  text += `\n─────────────────\n⚠️ After joining tap *Verify Now*.`;
  const buttons = channels.map(ch => ([{ text: `📢 ${ch.channel_name}`, url: ch.channel_link }]));
  buttons.push([{ text: "✅ I've Joined – Verify Now", callback_data: 'verify_now' }]);
  await sendMessage(chatId, text, buttons);
}

async function sendMainMenu(chatId, user) {
  const rank = getRank(user.credits);
  const { count: refs } = await supabase.from('referrals').select('id', { count: 'exact' }).eq('referrer_id', user.telegram_id);
  const text =
    `⭐ *LEAKED STUFF* ⭐\n─────────────────\n` +
    `Welcome, *${user.first_name || 'User'}*!\n\n` +
    `👤 *YOUR STATS*\n• Rank: ${rank}\n• Credits: ${user.credits} 💰\n• Referrals: ${refs || 0} 🔗\n` +
    `─────────────────\n📱 *MAIN MENU*`;
  await sendMessage(chatId, text, [
    [{ text: '📦 Browse Files', callback_data: 'browse_files' }],
    [{ text: '🔗 My Referrals', callback_data: 'my_referrals' }, { text: '🏆 Leaderboard', callback_data: 'leaderboard' }],
    [{ text: '💰 My Credits', callback_data: 'my_credits' }, { text: '❓ Help', callback_data: 'help' }]
  ]);
}

async function handleStart(msg, refCode) {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  console.log('handleStart called for:', telegramId);
  try {
    let user = await getUser(telegramId);
    if (!user) {
      let referredBy = null;
      if (refCode && refCode.startsWith('ref_')) {
        const rid = parseInt(refCode.replace('ref_', ''));
        if (rid !== telegramId) referredBy = rid;
      }
      const { error } = await supabase.from('users').insert({
        telegram_id: telegramId,
        username: msg.from.username || null,
        first_name: msg.from.first_name || 'User',
        credits: 0,
        referred_by: referredBy,
        is_verified: false
      });
      if (error) console.error('Insert error:', JSON.stringify(error));
      user = await getUser(telegramId);
    }
    if (!user) return sendMessage(chatId, '❌ Error loading account. Try /start again.');
    if (user.is_banned) return sendMessage(chatId, '🚫 You are banned.');
    if (!user.is_verified) return sendVerification(chatId);
    return sendMainMenu(chatId, user);
  } catch (err) {
    console.error('handleStart error:', err.message);
    return sendMessage(chatId, '❌ Error. Try /start again.');
  }
}

async function handleVerifyNow(chatId, telegramId, callbackId) {
  try {
    await answerCallback(callbackId);
    const allJoined = await verifyAllChannels(telegramId);
    if (!allJoined) return sendMessage(chatId, '❌ You have not joined all channels yet!\n\nJoin ALL then tap Verify again.');
    await supabase.from('users').update({ is_verified: true }).eq('telegram_id', telegramId);
    const user = await getUser(telegramId);
    if (user && user.referred_by) {
      const { data: already } = await supabase.from('referrals').select('id').eq('referred_id', telegramId).single();
      if (!already) {
        const refCredits = parseInt(await getSetting('referral_credits') || '5');
        await supabase.from('referrals').insert({ referrer_id: user.referred_by, referred_id: telegramId, credits_awarded: refCredits });
        await supabase.rpc('increment_credits', { user_tid: user.referred_by, amount: refCredits });
        try { await sendMessage(user.referred_by, `🎉 Someone joined via your link!\n+${refCredits} credits added! 💰`); } catch {}
      }
    }
    await sendMessage(chatId, '✅ Verified! Welcome!');
    const updatedUser = await getUser(telegramId);
    return sendMainMenu(chatId, updatedUser);
  } catch (err) {
    console.error('handleVerifyNow error:', err.message);
    return sendMessage(chatId, '❌ Verification failed. Try again.');
  }
}

async function handleBrowseFiles(chatId) {
  const { data: files } = await supabase.from('files').select('*').eq('is_active', true).order('created_at', { ascending: false });
  if (!files || files.length === 0) return sendMessage(chatId, '📭 No files yet!', [[{ text: '⬅️ Back', callback_data: 'main_menu' }]]);
  const buttons = files.map(f => ([{ text: `📦 ${f.name} (💰${f.price_credits})`, callback_data: `file_${f.id}` }]));
  buttons.push([{ text: '⬅️ Back', callback_data: 'main_menu' }]);
  await sendMessage(chatId, `📦 *AVAILABLE FILES*\n─────────────────\nTap any file to view:`, buttons);
}

async function handleViewFile(chatId, telegramId, fileId) {
  const { data: file } = await supabase.from('files').select('*').eq('id', fileId).single();
  if (!file) return sendMessage(chatId, '❌ File not found.');
  const { data: purchase } = await supabase.from('purchases').select('id').eq('user_telegram_id', telegramId).eq('file_id', fileId).single();
  const user = await getUser(telegramId);
  let text = `📦 *${file.name}*\n─────────────────\n📝 ${file.description || 'No description'}\n💰 Price: *${file.price_credits} credits*\n`;
  const buttons = [];
  if (purchase) {
    text += `\n✅ *Already Unlocked*\n\n${file.content}`;
    buttons.push([{ text: '⬅️ Back', callback_data: 'browse_files' }]);
  } else {
    text += `\nYour credits: *${user.credits}*`;
    buttons.push([{ text: `🔓 Unlock for ${file.price_credits} Credits`, callback_data: `buy_${fileId}` }]);
    buttons.push([{ text: '⬅️ Back', callback_data: 'browse_files' }]);
  }
  await sendMessage(chatId, text, buttons);
}

async function handleBuyFile(chatId, telegramId, fileId) {
  const user = await getUser(telegramId);
  const { data: file } = await supabase.from('files').select('*').eq('id', fileId).single();
  if (!file) return sendMessage(chatId, '❌ File not found.');
  if (user.credits < file.price_credits) return sendMessage(chatId, `❌ Not enough credits!\nYou have *${user.credits}* but need *${file.price_credits}*.\nShare referral link to earn more!`);
  await supabase.from('users').update({ credits: user.credits - file.price_credits }).eq('telegram_id', telegramId);
  await supabase.from('purchases').insert({ user_telegram_id: telegramId, file_id: parseInt(fileId), credits_spent: file.price_credits });
  await sendMessage(chatId, `✅ *Unlocked!*\n─────────────────\n📦 *${file.name}*\n\n${file.content}`);
}

async function handleMyReferrals(chatId, telegramId) {
  const { data: refs, count } = await supabase.from('referrals').select('*', { count: 'exact' }).eq('referrer_id', telegramId);
  const totalCredits = refs ? refs.reduce((s, r) => s + r.credits_awarded, 0) : 0;
  const refCredits = await getSetting('referral_credits') || '5';
  await sendMessage(chatId,
    `🔗 *MY REFERRALS*\n─────────────────\n\n👥 Total referred: *${count || 0}*\n💰 Credits earned: *${totalCredits}*\n\n🔗 *Your Referral Link:*\nhttps://t.me/${BOT_USERNAME}?start=ref_${telegramId}\n\nEach join = *+${refCredits} credits!* 💰`,
    [[{ text: '⬅️ Back', callback_data: 'main_menu' }]]
  );
}

async function handleLeaderboard(chatId) {
  const { data: users } = await supabase.from('users').select('first_name, username, credits').eq('is_verified', true).order('credits', { ascending: false }).limit(10);
  if (!users || users.length === 0) return sendMessage(chatId, '🏆 No users yet!');
  const medals = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
  let text = `🏆 *LEADERBOARD*\n─────────────────\n\n`;
  users.forEach((u, i) => { text += `${medals[i]} ${u.username ? '@' + u.username : u.first_name} — *${u.credits} credits*\n`; });
  await sendMessage(chatId, text, [[{ text: '⬅️ Back', callback_data: 'main_menu' }]]);
}

async function handleHelp(chatId) {
  await sendMessage(chatId,
    `❓ *HELP*\n─────────────────\n\n📦 *Browse Files* — Unlock files using credits\n🔗 *Referrals* — Share link, earn credits\n🏆 *Leaderboard* — Top users\n💰 *Credits* — Used to unlock files\n─────────────────\nContact admin for support.`,
    [[{ text: '⬅️ Back', callback_data: 'main_menu' }]]
  );
}

async function handleAdmin(chatId, telegramId) {
  const admin = await isAdmin(telegramId);
  if (!admin) return sendMessage(chatId, '🚫 Access denied.');
  await sendMessage(chatId, `⚙️ *ADMIN PANEL*\n─────────────────`, [
    [{ text: '📦 Add File', callback_data: 'admin_add_file' }],
    [{ text: '📋 List Files', callback_data: 'admin_list_files' }],
    [{ text: '📢 Add Channel', callback_data: 'admin_add_channel' }],
    [{ text: '📋 List Channels', callback_data: 'admin_list_channels' }],
    [{ text: '📡 Broadcast', callback_data: 'admin_broadcast' }],
    [{ text: '👥 User Stats', callback_data: 'admin_stats' }],
    [{ text: '⚙️ Set Referral Credits', callback_data: 'admin_set_ref_credits' }]
  ]);
}

async function handleAdminStats(chatId) {
  const { count: t } = await supabase.from('users').select('*', { count: 'exact' });
  const { count: v } = await supabase.from('users').select('*', { count: 'exact' }).eq('is_verified', true);
  const { count: f } = await supabase.from('files').select('*', { count: 'exact' });
  const { count: p } = await supabase.from('purchases').select('*', { count: 'exact' });
  const { count: r } = await supabase.from('referrals').select('*', { count: 'exact' });
  await sendMessage(chatId, `📊 *STATS*\n─────────────────\n👥 Total: *${t||0}*\n✅ Verified: *${v||0}*\n📦 Files: *${f||0}*\n🛒 Purchases: *${p||0}*\n🔗 Referrals: *${r||0}*`, [[{ text: '⬅️ Back', callback_data: 'admin_panel' }]]);
}

async function handleAdminListFiles(chatId) {
  const { data: files } = await supabase.from('files').select('*').order('created_at', { ascending: false });
  if (!files || files.length === 0) return sendMessage(chatId, '📭 No files.', [[{ text: '⬅️ Back', callback_data: 'admin_panel' }]]);
  const buttons = files.map(f => ([{ text: `📦 ${f.name}`, callback_data: 'noop' }, { text: '🗑️', callback_data: `admin_delete_file_${f.id}` }]));
  buttons.push([{ text: '⬅️ Back', callback_data: 'admin_panel' }]);
  await sendMessage(chatId, `📋 *ALL FILES*\n─────────────────`, buttons);
}

async function handleAdminListChannels(chatId) {
  const channels = await getChannels();
  if (!channels || channels.length === 0) return sendMessage(chatId, '📭 No channels.', [[{ text: '⬅️ Back', callback_data: 'admin_panel' }]]);
  const buttons = channels.map(ch => ([{ text: `📢 ${ch.channel_name}`, callback_data: 'noop' }, { text: '🗑️', callback_data: `admin_delete_channel_${ch.id}` }]));
  buttons.push([{ text: '⬅️ Back', callback_data: 'admin_panel' }]);
  await sendMessage(chatId, `📋 *REQUIRED CHANNELS*\n─────────────────`, buttons);
}

const userState = {};

async function processAdminInput(chatId, telegramId, text) {
  const state = userState[telegramId];
  if (!state) return false;
  if (state.step === 'add_file_name') { userState[telegramId] = { step: 'add_file_desc', name: text }; await sendMessage(chatId, '📝 Enter file *description*:'); return true; }
  if (state.step === 'add_file_desc') { userState[telegramId] = { ...state, step: 'add_file_content', desc: text }; await sendMessage(chatId, '📄 Enter file *content*:'); return true; }
  if (state.step === 'add_file_content') { userState[telegramId] = { ...state, step: 'add_file_price', content: text }; await sendMessage(chatId, '💰 Enter *price in credits*:'); return true; }
  if (state.step === 'add_file_price') {
    const price = parseInt(text);
    if (isNaN(price)) { await sendMessage(chatId, '❌ Enter a number:'); return true; }
    userState[telegramId] = { ...state, step: 'add_file_refs', price };
    await sendMessage(chatId, '🔗 Enter *referral price* (or 0):'); return true;
  }
  if (state.step === 'add_file_refs') {
    const { name, desc, content, price } = state;
    await supabase.from('files').insert({ name, description: desc, content, price_credits: price, price_refs: parseInt(text) || 0 });
    delete userState[telegramId];
    await sendMessage(chatId, `✅ File *"${name}"* added!`); return true;
  }
  if (state.step === 'add_channel_id') { userState[telegramId] = { step: 'add_channel_name', channel_id: text }; await sendMessage(chatId, '📢 Enter *display name*:'); return true; }
  if (state.step === 'add_channel_name') { userState[telegramId] = { ...state, step: 'add_channel_link', channel_name: text }; await sendMessage(chatId, '🔗 Enter *invite link*:'); return true; }
  if (state.step === 'add_channel_link') {
    const { channel_id, channel_name } = state;
    await supabase.from('required_channels').insert({ channel_id, channel_name, channel_link: text });
    delete userState[telegramId];
    await sendMessage(chatId, `✅ Channel *"${channel_name}"* added!`); return true;
  }
  if (state.step === 'broadcast_msg') {
    delete userState[telegramId];
    const { data: users } = await supabase.from('users').select('telegram_id').eq('is_verified', true);
    let sent = 0;
    for (const u of (users || [])) { try { await sendMessage(u.telegram_id, `📡 *BROADCAST*\n\n${text}`); sent++; } catch {} }
    await sendMessage(chatId, `✅ Sent to *${sent}* users.`); return true;
  }
  if (state.step === 'set_ref_credits') {
    const val = parseInt(text);
    if (isNaN(val)) { await sendMessage(chatId, '❌ Enter a number:'); return true; }
    delete userState[telegramId];
    await supabase.from('settings').update({ value: String(val) }).eq('key', 'referral_credits');
    await sendMessage(chatId, `✅ Referral credits set to *${val}*!`); return true;
  }
  return false;
}

module.exports = async (req, res) => {
  res.status(200).json({ ok: true });
  if (req.method !== 'POST') return;
  const body = req.body;
  console.log('Received update:', JSON.stringify(body).substring(0, 200));
  try {
    if (body.callback_query) {
      const cb = body.callback_query;
      const chatId = cb.message.chat.id;
      const telegramId = cb.from.id;
      const data = cb.data;
      try { await answerCallback(cb.id); } catch {}
      const user = await getUser(telegramId);
      if (data === 'verify_now') return handleVerifyNow(chatId, telegramId, cb.id);
      if (data === 'main_menu') return sendMainMenu(chatId, user);
      if (data === 'browse_files') return handleBrowseFiles(chatId);
      if (data === 'my_referrals') return handleMyReferrals(chatId, telegramId);
      if (data === 'leaderboard') return handleLeaderboard(chatId);
      if (data === 'help') return handleHelp(chatId);
      if (data === 'admin_panel') return handleAdmin(chatId, telegramId);
      if (data === 'admin_stats') return handleAdminStats(chatId);
      if (data === 'admin_list_files') return handleAdminListFiles(chatId);
      if (data === 'admin_list_channels') return handleAdminListChannels(chatId);
      if (data === 'noop') return;
      if (data === 'my_credits') return sendMessage(chatId, `💰 *YOUR CREDITS*\n─────────────────\nCredits: *${user.credits}*\nRank: ${getRank(user.credits)}`, [[{ text: '⬅️ Back', callback_data: 'main_menu' }]]);
      if (data === 'admin_add_file') { userState[telegramId] = { step: 'add_file_name' }; return sendMessage(chatId, '📦 Enter file *name*:'); }
      if (data === 'admin_add_channel') { userState[telegramId] = { step: 'add_channel_id' }; return sendMessage(chatId, '📢 Enter channel *username* (e.g. @MyChannel):'); }
      if (data === 'admin_broadcast') { userState[telegramId] = { step: 'broadcast_msg' }; return sendMessage(chatId, '📡 Enter *broadcast message*:'); }
      if (data === 'admin_set_ref_credits') { userState[telegramId] = { step: 'set_ref_credits' }; return sendMessage(chatId, '⚙️ Enter new *referral credits* amount:'); }
      if (data.startsWith('file_')) return handleViewFile(chatId, telegramId, data.replace('file_', ''));
      if (data.startsWith('buy_')) return handleBuyFile(chatId, telegramId, data.replace('buy_', ''));
      if (data.startsWith('admin_delete_file_')) { await supabase.from('files').delete().eq('id', data.replace('admin_delete_file_', '')); return sendMessage(chatId, '🗑️ Deleted!', [[{ text: '⬅️ Back', callback_data: 'admin_list_files' }]]); }
      if (data.startsWith('admin_delete_channel_')) { await supabase.from('required_channels').delete().eq('id', data.replace('admin_delete_channel_', '')); return sendMessage(chatId, '🗑️ Removed!', [[{ text: '⬅️ Back', callback_data: 'admin_list_channels' }]]); }
      return;
    }
    if (body.message) {
      const msg = body.message;
      const chatId = msg.chat.id;
      const telegramId = msg.from.id;
      const text = msg.text || '';
      console.log(`MSG from ${telegramId}: ${text}`);
      if (text.startsWith('/start')) return handleStart(msg, text.split(' ')[1] || null);
      if (text === '/admin') return handleAdmin(chatId, telegramId);
      const adminUser = await isAdmin(telegramId);
      if (adminUser) { const handled = await processAdminInput(chatId, telegramId, text); if (handled) return; }
      const user = await getUser(telegramId);
      if (user && user.is_verified) return sendMainMenu(chatId, user);
      return sendVerification(chatId);
    }
  } catch (err) {
    console.error('MAIN ERROR:', err.message, err.stack);
  }
};
