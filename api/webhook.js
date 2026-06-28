const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const supabase = require('../db');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const bot = new TelegramBot(BOT_TOKEN);

// ─── HELPERS ───────────────────────────────────────

async function getSetting(key) {
  const { data } = await supabase
    .from('settings')
    .select('value')
    .eq('key', key)
    .single();
  return data ? data.value : null;
}

async function isAdmin(telegramId) {
  const { data } = await supabase
    .from('admins')
    .select('id')
    .eq('telegram_id', telegramId)
    .single();
  return !!data;
}

async function getUser(telegramId) {
  const { data } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', telegramId)
    .single();
  return data;
}

async function getChannels() {
  const { data } = await supabase
    .from('required_channels')
    .select('*')
    .eq('is_active', true);
  return data || [];
}

async function checkUserInChannel(userId, channelId) {
  try {
    const member = await bot.getChatMember(channelId, userId);
    return ['member', 'administrator', 'creator'].includes(member.status);
  } catch {
    return false;
  }
}

async function verifyAllChannels(userId) {
  const channels = await getChannels();
  for (const ch of channels) {
    const joined = await checkUserInChannel(userId, ch.channel_id);
    if (!joined) return false;
  }
  return true;
}

async function getRank(credits) {
  if (credits >= 500) return 'Diamond 💎';
  if (credits >= 200) return 'Gold 🥇';
  if (credits >= 50) return 'Silver 🥈';
  return 'Bronze 🥉';
}

// ─── SEND VERIFICATION MESSAGE ─────────────────────

async function sendVerification(chatId) {
  const channels = await getChannels();
  const botName = await getSetting('bot_name') || 'LEAKED STUFF';

  let text = `🔒 *CHANNEL VERIFICATION*\n\n`;
  text += `📦 To use *${botName}*, join ALL channels below:\n\n`;

  channels.forEach((ch, i) => {
    text += `📢 [${ch.channel_name}](${ch.channel_link})\n`;
  });

  text += `\n─────────────────\n`;
  text += `⚠️ After joining, tap *Verify Now*.`;

  const buttons = channels.map(ch => ([{
    text: `📢 ${ch.channel_name}`,
    url: ch.channel_link
  }]));

  buttons.push([{
    text: '✅ I\'ve Joined – Verify Now',
    callback_data: 'verify_now'
  }]);

  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons }
  });
}

// ─── SEND MAIN MENU ────────────────────────────────

async function sendMainMenu(chatId, user) {
  const rank = await getRank(user.credits);
  const referralCount = await supabase
    .from('referrals')
    .select('id', { count: 'exact' })
    .eq('referrer_id', user.telegram_id);

  const refs = referralCount.count || 0;

  const text =
    `⭐ *LEAKED STUFF* ⭐\n` +
    `─────────────────\n` +
    `Welcome, *${user.first_name || 'User'}*!\n\n` +
    `👤 *YOUR STATS*\n` +
    `• Rank: ${rank}\n` +
    `• Credits: ${user.credits} 💰\n` +
    `• Referrals: ${refs} 🔗\n` +
    `─────────────────\n` +
    `📱 *MAIN MENU*`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '📦 Browse Files', callback_data: 'browse_files' }],
      [
        { text: '🔗 My Referrals', callback_data: 'my_referrals' },
        { text: '🏆 Leaderboard', callback_data: 'leaderboard' }
      ],
      [
        { text: '💰 My Credits', callback_data: 'my_credits' },
        { text: '❓ Help', callback_data: 'help' }
      ]
    ]
  };

  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: keyboard
  });
}

// ─── /start HANDLER ────────────────────────────────

async function handleStart(msg, referralCode) {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  const username = msg.from.username || null;
  const firstName = msg.from.first_name || 'User';

  let user = await getUser(telegramId);

  if (!user) {
    // New user — check referral
    let referredBy = null;
    if (referralCode && referralCode.startsWith('ref_')) {
      const referrerId = parseInt(referralCode.replace('ref_', ''));
      if (referrerId !== telegramId) {
        referredBy = referrerId;
      }
    }

    await supabase.from('users').insert({
      telegram_id: telegramId,
      username,
      first_name: firstName,
      credits: 0,
      referred_by: referredBy,
      is_verified: false
    });

    user = await getUser(telegramId);
  }

  if (user.is_banned) {
    return bot.sendMessage(chatId, '🚫 You are banned from this bot.');
  }

  if (!user.is_verified) {
    return sendVerification(chatId);
  }

  return sendMainMenu(chatId, user);
}

// ─── VERIFY NOW CALLBACK ───────────────────────────

async function handleVerifyNow(callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const telegramId = callbackQuery.from.id;

  await bot.answerCallbackQuery(callbackQuery.id, { text: 'Checking...' });

  const allJoined = await verifyAllChannels(telegramId);

  if (!allJoined) {
    return bot.sendMessage(chatId,
      '❌ You haven\'t joined all channels yet!\n\nPlease join ALL channels then tap Verify again.'
    );
  }

  // Mark verified
  await supabase
    .from('users')
    .update({ is_verified: true })
    .eq('telegram_id', telegramId);

  // Handle referral reward
  const user = await getUser(telegramId);
  if (user.referred_by) {
    const alreadyRewarded = await supabase
      .from('referrals')
      .select('id')
      .eq('referred_id', telegramId)
      .single();

    if (!alreadyRewarded.data) {
      const refCredits = parseInt(await getSetting('referral_credits') || '5');

      await supabase.from('referrals').insert({
        referrer_id: user.referred_by,
        referred_id: telegramId,
        credits_awarded: refCredits
      });

      await supabase.rpc('increment_credits', {
        user_tid: user.referred_by,
        amount: refCredits
      });

      // Notify referrer
      try {
        await bot.sendMessage(user.referred_by,
          `🎉 Someone joined using your referral link!\n+${refCredits} credits added to your account! 💰`
        );
      } catch {}
    }
  }

  await bot.sendMessage(chatId, '✅ Verified successfully! Welcome!');
  const updatedUser = await getUser(telegramId);
  return sendMainMenu(chatId, updatedUser);
}

// ─── BROWSE FILES ──────────────────────────────────

async function handleBrowseFiles(chatId, telegramId) {
  const { data: files } = await supabase
    .from('files')
    .select('*')
    .eq('is_active', true)
    .order('created_at', { ascending: false });

  if (!files || files.length === 0) {
    return bot.sendMessage(chatId, '📭 No files available yet. Check back later!');
  }

  let text = `📦 *AVAILABLE FILES*\n─────────────────\nTap any file to view:\n\n`;

  const buttons = files.map(f => ([{
    text: `📦 ${f.name} (🔗${f.price_refs} | 💰${f.price_credits})`,
    callback_data: `file_${f.id}`
  }]));

  buttons.push([{ text: '⬅️ Back', callback_data: 'main_menu' }]);

  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons }
  });
}

// ─── VIEW FILE ─────────────────────────────────────

async function handleViewFile(chatId, telegramId, fileId) {
  const { data: file } = await supabase
    .from('files')
    .select('*')
    .eq('id', fileId)
    .single();

  if (!file) return bot.sendMessage(chatId, '❌ File not found.');

  // Check if already purchased
  const { data: purchase } = await supabase
    .from('purchases')
    .select('id')
    .eq('user_telegram_id', telegramId)
    .eq('file_id', fileId)
    .single();

  const user = await getUser(telegramId);

  let text = `📦 *${file.name}*\n─────────────────\n`;
  text += `📝 ${file.description || 'No description'}\n\n`;
  text += `💰 Price: *${file.price_credits} credits*\n`;
  text += `🔗 Alt Price: *${file.price_refs} referrals*\n`;

  const buttons = [];

  if (purchase) {
    text += `\n✅ *Already Unlocked*\n\n${file.content}`;
    buttons.push([{ text: '⬅️ Back to Files', callback_data: 'browse_files' }]);
  } else {
    text += `\nYour credits: *${user.credits}*`;
    buttons.push([{ text: `🔓 Unlock for ${file.price_credits} Credits`, callback_data: `buy_${fileId}` }]);
    buttons.push([{ text: '⬅️ Back to Files', callback_data: 'browse_files' }]);
  }

  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons }
  });
}

// ─── BUY FILE ──────────────────────────────────────

async function handleBuyFile(chatId, telegramId, fileId) {
  const user = await getUser(telegramId);
  const { data: file } = await supabase
    .from('files')
    .select('*')
    .eq('id', fileId)
    .single();

  if (!file) return bot.sendMessage(chatId, '❌ File not found.');

  if (user.credits < file.price_credits) {
    return bot.sendMessage(chatId,
      `❌ Not enough credits!\n\nYou have *${user.credits}* credits but need *${file.price_credits}*.\n\nShare your referral link to earn more!`,
      { parse_mode: 'Markdown' }
    );
  }

  // Deduct credits
  await supabase
    .from('users')
    .update({ credits: user.credits - file.price_credits })
    .eq('telegram_id', telegramId);

  // Save purchase
  await supabase.from('purchases').insert({
    user_telegram_id: telegramId,
    file_id: fileId,
    credits_spent: file.price_credits
  });

  await bot.sendMessage(chatId,
    `✅ *Unlocked Successfully!*\n─────────────────\n📦 *${file.name}*\n\n${file.content}`,
    { parse_mode: 'Markdown' }
  );
}

// ─── MY REFERRALS ──────────────────────────────────

async function handleMyReferrals(chatId, telegramId) {
  const { data: refs, count } = await supabase
    .from('referrals')
    .select('*', { count: 'exact' })
    .eq('referrer_id', telegramId);

  const totalCredits = refs ? refs.reduce((sum, r) => sum + r.credits_awarded, 0) : 0;
  const refCredits = await getSetting('referral_credits') || '5';

  const text =
    `🔗 *MY REFERRALS*\n─────────────────\n\n` +
    `👥 Total people you referred: *${count || 0}*\n` +
    `💰 Credits earned: *${totalCredits}*\n\n` +
    `─────────────────\n` +
    `🔗 *Your Referral Link:*\n` +
    `https://t.me/${process.env.BOT_USERNAME}?start=ref_${telegramId}\n\n` +
    `Share this link — each person who joins gives you *+${refCredits} credits!* 💰`;

  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'main_menu' }]]
    }
  });
}

// ─── LEADERBOARD ───────────────────────────────────

async function handleLeaderboard(chatId) {
  const { data: users } = await supabase
    .from('users')
    .select('first_name, username, credits')
    .eq('is_verified', true)
    .order('credits', { ascending: false })
    .limit(10);

  if (!users || users.length === 0) {
    return bot.sendMessage(chatId, '🏆 No users yet!');
  }

  const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
  let text = `🏆 *LEADERBOARD*\n─────────────────\n\n`;

  users.forEach((u, i) => {
    const name = u.username ? `@${u.username}` : u.first_name || 'User';
    text += `${medals[i]} ${name} — *${u.credits} credits*\n`;
  });

  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'main_menu' }]]
    }
  });
}

// ─── HELP ──────────────────────────────────────────

async function handleHelp(chatId) {
  const text =
    `❓ *HELP*\n─────────────────\n\n` +
    `📦 *Browse Files* — View and unlock files using credits\n\n` +
    `🔗 *Referrals* — Share your link, earn +5 credits per join\n\n` +
    `🏆 *Leaderboard* — Top users by credits\n\n` +
    `💰 *Credits* — Currency to unlock files\n\n` +
    `─────────────────\n` +
    `For support contact admin.`;

  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'main_menu' }]]
    }
  });
}

// ─── ADMIN PANEL ───────────────────────────────────

async function handleAdmin(chatId, telegramId) {
  const admin = await isAdmin(telegramId);
  if (!admin) return bot.sendMessage(chatId, '🚫 Access denied.');

  const text = `⚙️ *ADMIN PANEL*\n─────────────────\nWelcome, Admin!`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '📦 Add File', callback_data: 'admin_add_file' }],
      [{ text: '📋 List Files', callback_data: 'admin_list_files' }],
      [{ text: '📢 Add Channel', callback_data: 'admin_add_channel' }],
      [{ text: '📋 List Channels', callback_data: 'admin_list_channels' }],
      [{ text: '📡 Broadcast', callback_data: 'admin_broadcast' }],
      [{ text: '👥 User Stats', callback_data: 'admin_stats' }],
      [{ text: '⚙️ Set Referral Credits', callback_data: 'admin_set_ref_credits' }]
    ]
  };

  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: keyboard
  });
}

// ─── ADMIN STATS ───────────────────────────────────

async function handleAdminStats(chatId) {
  const { count: totalUsers } = await supabase
    .from('users')
    .select('*', { count: 'exact' });

  const { count: verifiedUsers } = await supabase
    .from('users')
    .select('*', { count: 'exact' })
    .eq('is_verified', true);

  const { count: totalFiles } = await supabase
    .from('files')
    .select('*', { count: 'exact' });

  const { count: totalPurchases } = await supabase
    .from('purchases')
    .select('*', { count: 'exact' });

  const { count: totalReferrals } = await supabase
    .from('referrals')
    .select('*', { count: 'exact' });

  const text =
    `📊 *USER STATS*\n─────────────────\n\n` +
    `👥 Total Users: *${totalUsers || 0}*\n` +
    `✅ Verified: *${verifiedUsers || 0}*\n` +
    `📦 Total Files: *${totalFiles || 0}*\n` +
    `🛒 Total Purchases: *${totalPurchases || 0}*\n` +
    `🔗 Total Referrals: *${totalReferrals || 0}*`;

  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'admin_panel' }]]
    }
  });
}

// ─── ADMIN LIST FILES ──────────────────────────────

async function handleAdminListFiles(chatId) {
  const { data: files } = await supabase
    .from('files')
    .select('*')
    .order('created_at', { ascending: false });

  if (!files || files.length === 0) {
    return bot.sendMessage(chatId, '📭 No files yet.', {
      reply_markup: {
        inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'admin_panel' }]]
      }
    });
  }

  const buttons = files.map(f => ([
    { text: `📦 ${f.name}`, callback_data: `admin_view_file_${f.id}` },
    { text: `🗑️`, callback_data: `admin_delete_file_${f.id}` }
  ]));

  buttons.push([{ text: '⬅️ Back', callback_data: 'admin_panel' }]);

  await bot.sendMessage(chatId, `📋 *ALL FILES*\n─────────────────`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons }
  });
}

// ─── ADMIN LIST CHANNELS ───────────────────────────

async function handleAdminListChannels(chatId) {
  const channels = await getChannels();

  if (!channels || channels.length === 0) {
    return bot.sendMessage(chatId, '📭 No channels yet.', {
      reply_markup: {
        inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'admin_panel' }]]
      }
    });
  }

  const buttons = channels.map(ch => ([
    { text: `📢 ${ch.channel_name}`, callback_data: `noop` },
    { text: `🗑️`, callback_data: `admin_delete_channel_${ch.id}` }
  ]));

  buttons.push([{ text: '⬅️ Back', callback_data: 'admin_panel' }]);

  await bot.sendMessage(chatId, `📋 *REQUIRED CHANNELS*\n─────────────────`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons }
  });
}

// ─── CONVERSATION STATE ────────────────────────────
const userState = {};

// ─── PROCESS ADMIN TEXT INPUT ──────────────────────

async function processAdminInput(chatId, telegramId, text) {
  const state = userState[telegramId];
  if (!state) return false;

  // ADD FILE FLOW
  if (state.step === 'add_file_name') {
    userState[telegramId] = { step: 'add_file_desc', name: text };
    await bot.sendMessage(chatId, '📝 Enter file *description*:', { parse_mode: 'Markdown' });
    return true;
  }

  if (state.step === 'add_file_desc') {
    userState[telegramId] = { ...state, step: 'add_file_content', desc: text };
    await bot.sendMessage(chatId, '📄 Enter file *content* (the actual method/text users will see):', { parse_mode: 'Markdown' });
    return true;
  }

  if (state.step === 'add_file_content') {
    userState[telegramId] = { ...state, step: 'add_file_price', content: text };
    await bot.sendMessage(chatId, '💰 Enter file *price in credits*:', { parse_mode: 'Markdown' });
    return true;
  }

  if (state.step === 'add_file_price') {
    const price = parseInt(text);
    if (isNaN(price)) {
      await bot.sendMessage(chatId, '❌ Invalid number. Enter price again:');
      return true;
    }
    userState[telegramId] = { ...state, step: 'add_file_refs', price };
    await bot.sendMessage(chatId, '🔗 Enter *referral price* (or 0):', { parse_mode: 'Markdown' });
    return true;
  }

  if (state.step === 'add_file_refs') {
    const priceRefs = parseInt(text) || 0;
    const { name, desc, content, price } = state;

    await supabase.from('files').insert({
      name,
      description: desc,
      content,
      price_credits: price,
      price_refs: priceRefs
    });

    delete userState[telegramId];
    await bot.sendMessage(chatId, `✅ File *"${name}"* added successfully!`, { parse_mode: 'Markdown' });
    return true;
  }

  // ADD CHANNEL FLOW
  if (state.step === 'add_channel_id') {
    userState[telegramId] = { step: 'add_channel_name', channel_id: text };
    await bot.sendMessage(chatId, '📢 Enter channel *display name*:', { parse_mode: 'Markdown' });
    return true;
  }

  if (state.step === 'add_channel_name') {
    userState[telegramId] = { ...state, step: 'add_channel_link', channel_name: text };
    await bot.sendMessage(chatId, '🔗 Enter channel *invite link* (https://t.me/...):', { parse_mode: 'Markdown' });
    return true;
  }

  if (state.step === 'add_channel_link') {
    const { channel_id, channel_name } = state;

    await supabase.from('required_channels').insert({
      channel_id,
      channel_name,
      channel_link: text
    });

    delete userState[telegramId];
    await bot.sendMessage(chatId, `✅ Channel *"${channel_name}"* added!`, { parse_mode: 'Markdown' });
    return true;
  }

  // BROADCAST FLOW
  if (state.step === 'broadcast_msg') {
    delete userState[telegramId];
    const { data: users } = await supabase
      .from('users')
      .select('telegram_id')
      .eq('is_verified', true);

    let sent = 0;
    for (const u of (users || [])) {
      try {
        await bot.sendMessage(u.telegram_id, `📡 *BROADCAST*\n\n${text}`, { parse_mode: 'Markdown' });
        sent++;
      } catch {}
    }

    await bot.sendMessage(chatId, `✅ Broadcast sent to *${sent}* users.`, { parse_mode: 'Markdown' });
    return true;
  }

  // SET REFERRAL CREDITS FLOW
  if (state.step === 'set_ref_credits') {
    const val = parseInt(text);
    if (isNaN(val) || val < 0) {
      await bot.sendMessage(chatId, '❌ Invalid number. Try again:');
      return true;
    }
    delete userState[telegramId];
    await supabase
      .from('settings')
      .update({ value: String(val) })
      .eq('key', 'referral_credits');

    await bot.sendMessage(chatId, `✅ Referral credits set to *${val}*!`, { parse_mode: 'Markdown' });
    return true;
  }

  return false;
}

// ─── MAIN WEBHOOK HANDLER ──────────────────────────

app.post('/api/webhook', async (req, res) => {
  res.sendStatus(200);
  const body = req.body;

  try {
    // CALLBACK QUERIES
    if (body.callback_query) {
      const cb = body.callback_query;
      const chatId = cb.message.chat.id;
      const telegramId = cb.from.id;
      const data = cb.data;

      await bot.answerCallbackQuery(cb.id);

      const user = await getUser(telegramId);

      if (data === 'verify_now') return handleVerifyNow(cb);
      if (data === 'main_menu') return sendMainMenu(chatId, user);
      if (data === 'browse_files') return handleBrowseFiles(chatId, telegramId);
      if (data === 'my_referrals') return handleMyReferrals(chatId, telegramId);
      if (data === 'leaderboard') return handleLeaderboard(chatId);
      if (data === 'help') return handleHelp(chatId);
      if (data === 'my_credits') {
        const rank = await getRank(user.credits);
        return bot.sendMessage(chatId,
          `💰 *YOUR CREDITS*\n─────────────────\n\nCredits: *${user.credits}*\nRank: ${rank}`,
          {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'main_menu' }]] }
          }
        );
      }

      if (data.startsWith('file_')) {
        const fileId = data.replace('file_', '');
        return handleViewFile(chatId, telegramId, fileId);
      }

      if (data.startsWith('buy_')) {
        const fileId = data.replace('buy_', '');
        return handleBuyFile(chatId, telegramId, fileId);
      }

      // ADMIN CALLBACKS
      if (data === 'admin_panel') return handleAdmin(chatId, telegramId);
      if (data === 'admin_stats') return handleAdminStats(chatId);
      if (data === 'admin_list_files') return handleAdminListFiles(chatId);
      if (data === 'admin_list_channels') return handleAdminListChannels(chatId);

      if (data === 'admin_add_file') {
        userState[telegramId] = { step: 'add_file_name' };
        return bot.sendMessage(chatId, '📦 Enter file *name*:', { parse_mode: 'Markdown' });
      }

      if (data === 'admin_add_channel') {
        userState[telegramId] = { step: 'add_channel_id' };
        return bot.sendMessage(chatId, '📢 Enter channel *username* (e.g. @MyChannel):', { parse_mode: 'Markdown' });
      }

      if (data === 'admin_broadcast') {
        userState[telegramId] = { step: 'broadcast_msg' };
        return bot.sendMessage(chatId, '📡 Enter *broadcast message*:', { parse_mode: 'Markdown' });
      }

      if (data === 'admin_set_ref_credits') {
        userState[telegramId] = { step: 'set_ref_credits' };
        return bot.sendMessage(chatId, '⚙️ Enter new *referral credits* amount:', { parse_mode: 'Markdown' });
      }

      if (data.startsWith('admin_delete_file_')) {
        const fileId = data.replace('admin_delete_file_', '');
        await supabase.from('files').delete().eq('id', fileId);
        return bot.sendMessage(chatId, '🗑️ File deleted!', {
          reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'admin_list_files' }]] }
        });
      }

      if (data.startsWith('admin_delete_channel_')) {
        const chId = data.replace('admin_delete_channel_', '');
        await supabase.from('required_channels').delete().eq('id', chId);
        return bot.sendMessage(chatId, '🗑️ Channel removed!', {
          reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'admin_list_channels' }]] }
        });
      }

      return;
    }

    // MESSAGES
    if (body.message) {
      const msg = body.message;
      const chatId = msg.chat.id;
      const telegramId = msg.from.id;
      const text = msg.text || '';

      if (text.startsWith('/start')) {
        const parts = text.split(' ');
        const refCode = parts[1] || null;
        return handleStart(msg, refCode);
      }

      if (text === '/admin') {
        return handleAdmin(chatId, telegramId);
      }

      // Check if admin is in input flow
      const isAdminUser = await isAdmin(telegramId);
      if (isAdminUser) {
        const handled = await processAdminInput(chatId, telegramId, text);
        if (handled) return;
      }

      // Default
      const user = await getUser(telegramId);
      if (user && user.is_verified) {
        return sendMainMenu(chatId, user);
      } else {
        return sendVerification(chatId);
      }
    }

  } catch (err) {
    console.error('Webhook error:', err);
  }
});

app.get('/', (req, res) => res.send('Bot is running!'));

module.exports = app;
