const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField, MessageFlags } = require('discord.js');
const { DateTime, Interval } = require('luxon');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
require('dotenv').config();

// GlobalReadybleStream
const { ReadableStream } = require('stream/web');
globalThis.ReadableStream = ReadableStream;

// SleeptrakcherDb
const db = new sqlite3.Database(path.join(__dirname, 'sleep_tracker.db'), (err) => {
  if (err) {
    console.error('Database connection error:', err);
    process.exit(1);
  }
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers
  ],
  partials: ['MESSAGE', 'REACTION', 'USER', 'GUILD_MEMBER']
});

// リセット確認のためのMapとタイムアウト設定
const resetConfirmationPending = new Map(); // Stores userId -> timestamp of first press
const RESET_CONFIRMATION_TIMEOUT_MS = 30 * 1000; // 30 seconds

//sleepdata
const getWeeklySleepData = async (guildId) => {
  return new Promise((resolve, reject) => {
    const oneWeekAgo = DateTime.now().setZone('Asia/Tokyo').minus({ days: 7 }).toFormat('yyyy-MM-dd HH:mm');
    
    db.all(
      `SELECT * FROM sleep_records 
        WHERE guild_id = ? AND timestamp >= ? 
        ORDER BY user_id, timestamp ASC`,
      [guildId, oneWeekAgo],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
};

// 新しい関数: ユーザーの睡眠記録をクリア
const clearUserSleepRecords = (userId, guildId) => {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM sleep_records WHERE user_id = ? AND guild_id = ?', [userId, guildId], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
};


client.on('interactionCreate', async interaction => {
  // スラッシュコマンドの処理
  if (interaction.isChatInputCommand()) {
    try {
      switch (interaction.commandName) {
        case 'start':
          await handleStartCommand(interaction);
          break;
        case 'status':
          await handleStatusCommand(interaction); 
          break;
        case 'stats':
          await handleStatsCommand(interaction);
          break;
        case 'setstatus':
          await handleSetStatusCommand(interaction);
          break;
        case 'clear':
          await handleClearCommand(interaction);
          break;
        default:
          await interaction.reply({ content: '不明なコマンドです。', flags: MessageFlags.Ephemeral });
          break;
      }
    } catch (error) {
      console.error('スラッシュコマンド処理エラー:', error);
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: 'コマンドの実行中にエラーが発生しました。', flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: 'コマンドの実行中にエラーが発生しました。', flags: MessageFlags.Ephemeral });
      }
    }
    return;
  }

  // ボタンインタラクションの処理 (既存のコード)
  if (interaction.isButton()) {
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;
    const channel = interaction.channel;
    const time = getJapanTime();

    try {
      switch (interaction.customId) {
        case 'wake_up':
          await updateUserStatus(userId, guildId, '☀️', time, 'wakeup');
          await interaction.reply({ content: `<@${userId}> さんは起きました！`, flags: MessageFlags.Ephemeral });
          // メインのステータス表示を更新
          await handleStatusCommand(interaction); // ボタンを押したユーザーのステータスを更新
          break;

        case 'sleep':
          await updateUserStatus(userId, guildId, '🌙', time, 'sleep');
          await interaction.reply({ content: `<@${userId}> さんは寝ました！`, flags: MessageFlags.Ephemeral });
          // メインのステータス表示を更新
          await handleStatusCommand(interaction); // ボタンを押したユーザーのステータスを更新
          break;

        case 'reset_status':
          const now = Date.now();
          const lastPressTime = resetConfirmationPending.get(userId);

          if (lastPressTime && (now - lastPressTime < RESET_CONFIRMATION_TIMEOUT_MS)) {
            // 2回目のクリックがタイムアウト以内
            await db.run('DELETE FROM sleep_records WHERE user_id = ? AND guild_id = ?', [userId, guildId]);
            resetConfirmationPending.delete(userId); // 保留状態をクリア
            await interaction.reply({ content: `<@${userId}> さんの状態はリセットされました。`, flags: MessageFlags.Ephemeral });
            // メインのステータス表示を更新 (リセットされたユーザーのステータスを更新)
            await handleStatusCommand(interaction); 
          } else {
            // 1回目のクリック、またはタイムアウト後のクリック
            resetConfirmationPending.set(userId, now);
            await interaction.reply({ content: `<@${userId}> 本当に状態をリセットするかってきいてｔんだごらああああああ❗❗\nもう一度「🌀 状態リセット」ボタンを押すと確定します🤖（${RESET_CONFIRMATION_TIMEOUT_MS / 1000}秒以内）`, flags: MessageFlags.Ephemeral });

            // タイムアウトを設定し、確認がない場合は保留状態をクリア
            setTimeout(() => {
              if (resetConfirmationPending.get(userId) === now) {
                resetConfirmationPending.delete(userId);
                // タイムアウトしたことをユーザーに知らせるメッセージを送信することも可能
                // interaction.followUp({ content: '状態リセットの確認がタイムアウトしました。', flags: MessageFlags.Ephemeral }).catch(console.error);
              }
            }, RESET_CONFIRMATION_TIMEOUT_MS);
          }
          break;

        case 'show_stats':
          // 「ステータス表示」ボタンが押されたら、両方の表示を更新する
          await handleStatusCommand(interaction); // 現在のステータスを更新
          await handleWeeklyStats(interaction); // 週間睡眠ランキングを更新
          break;
      }
    } catch (error) {
      console.error('ボタン処理エラー:', error);
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: 'エラーが発生しました。', flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: 'エラーが発生しました。', flags: MessageFlags.Ephemeral });
      }
    }
    return;
  }
});

async function handleClearCommand(interaction) {
  const member = interaction.member;
  const executor = interaction.user; // 実行者
  const executorMention = `<@${executor.id}>`;

  // 🛡️ 権限チェック
  if (
    !member.permissions.has(PermissionsBitField.Flags.ManageGuild) && 
    !member.roles.cache.has(ALLOWED_ROLE_ID) && 
    !ALLOWED_USERS.includes(member.id)
  ) {
    return await interaction.reply({
      content: '🚫 お前は権限を持ってないこのぐーばーめ！',
      ephemeral: false // これは管理者用メッセージなのでephemeralではない
    });
  }

  const targetUser = interaction.options.getUser('user');
  const guildId = interaction.guild.id;
  const userId = targetUser.id;

  try {
    await clearUserSleepRecords(userId, guildId);
    await interaction.reply({
      content: `🗑️ <@${userId}> の睡眠トラッカー記録をリセットしました。\n（実行者: ${executorMention}）`,
      ephemeral: false
    });
    // メインのステータス表示を更新
    // handleStatusCommandはinteractionオブジェクトを期待するため、元のinteractionを渡す
    await handleStatusCommand(interaction);
  } catch (error) {
    console.error('❌ ユーザー記録削除エラー:', error);
    await interaction.reply({
      content: '❌ ユーザーの記録をリセット中にエラーが発生しました。',
      flags: MessageFlags.Ephemeral
    });
  }
}


//sleapdatacalacutor
  const calculateWeeklySleepStats = (sleepData) => {
  const userSleepStats = {};

  sleepData.forEach(record => {
    const userId = record.user_id;

    if (!userSleepStats[userId]) {
      userSleepStats[userId] = { totalSleepMinutes: 0, sleepStart: null };
    }

    if (record.record_type === 'sleep') {
      userSleepStats[userId].sleepStart = DateTime.fromFormat(record.timestamp, 'yyyy-MM-dd HH:mm', { zone: 'Asia/Tokyo' });
    } else if (record.record_type === 'wakeup' && userSleepStats[userId].sleepStart) {
      const wakeTime = DateTime.fromFormat(record.timestamp, 'yyyy-MM-dd HH:mm', { zone: 'Asia/Tokyo' });
      const sleepDuration = wakeTime.diff(userSleepStats[userId].sleepStart, 'minutes').minutes;

      if (sleepDuration > 0) {
        userSleepStats[userId].totalSleepMinutes += sleepDuration;
      }

      userSleepStats[userId].sleepStart = null;  // 睡眠開始リセット
    }
  });

  return userSleepStats;
};

// Table
client.once('ready', async () => {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS sleep_records (
      user_id TEXT,
      guild_id TEXT,
      status TEXT,
      timestamp TEXT,
      record_type TEXT,
      PRIMARY KEY (user_id, guild_id, timestamp)
    )`);
  });

  console.log(`Logged in as ${client.user.tag}`);

const commands = [
  {
    name: 'start',
    description: '睡眠トラッカーを開始します'
  },
  {
    name: 'status',
    description: '現在の状態を表示します'
  },
  {
    name: 'stats',
    description: '睡眠統計を表示します'
  },
  {
    name: 'setstatus',
    description: 'プレイヤーの睡眠ステータスを変更します（管理者専用）',
    options: [
      {
        name: 'user',
        type: 6, // USER型
        description: 'ステータスを変更するユーザーを選択',
        required: true
      },
      {
        name: 'status',
        type: 3, // STRING型
        description: '設定するステータス（☀️ 起きている / 🌙 寝ている）',
        required: true,
        choices: [
          { name: '☀️ 起きている', value: '☀️' },
          { name: '🌙 寝ている', value: '🌙' }
        ]
      }
    ]
  },
  {
    name: 'clear', // 🆕 `/clear` コマンドを追加
    description: 'ユーザーの睡眠トラッカー記録をリセットします（管理者専用）',
    options: [
      {
        name: 'user',
        type: 6, // USER型 (数値型でOK)
        description: 'リセットするユーザーを選択',
        required: true
      }
    ]
  }
];

try {
  await client.application.commands.set(commands);
  console.log('✅ Slash commands registered (start, status, stats, setstatus, clear)');
} catch (error) {
  console.error('❌ Error registering slash commands:', error);
}

  // 5秒ごとの定期更新からメインのステータス表示更新を削除
  // リマインダー機能のみ残す
  setInterval(async () => {
    const guilds = client.guilds.cache;
    for (const guild of guilds.values()) {
      const members = await guild.members.fetch();
      for (const member of members.values()) {
        const status = await getUserStatus(member.id, guild.id);
        // updateStatusMessageはリマインダー機能のみを実行する
        if (status && member.presence) {
          await updateStatusMessage(member, guild, status);
        }
      }
    }
  }, 5000); 
});

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  const guild = client.guilds.cache.get('899915374630420540'); // 🛠️ あなたのサーバーIDを入れる
  if (!guild) return console.error('❌ サーバーが見つかりませんでした。');

  // ✅ `/setstatus` を登録（ギルドコマンドとして設定）
  const commands = await guild.commands.set([
    {
      name: 'setstatus',
      description: 'プレイヤーの睡眠ステータスを変更します（管理者 & 特定ロール専用）',
      options: [
        {
          name: 'user',
          type: 6, // USER型
          description: 'ステータスを変更するユーザーを選択',
          required: true
        },
        {
          name: 'status',
          type: 3, // STRING型
          description: '設定するステータス（☀️ 起きている / � 寝ている）',
          required: true,
          choices: [
            { name: '☀️ 起きている', value: '☀️' },
            { name: '🌙 寝ている', value: '🌙' }
          ]
        }
      ]
    }
  ]);

  console.log('✅ /setstatus コマンドを登録しました。');

  // ✅ `/setstatus` の権限を設定
  const setStatusCommand = commands.find(cmd => cmd.name === 'setstatus');
  if (!setStatusCommand) {
    console.error('❌ /setstatus コマンドが見つかりませんでした。');
    return;
  }

  const permissions = [
    {
      id: '899916001070678086', // 🛠️ 管理者ロールID
      type: 1, // ROLE
      permission: true
    },
    {
      id: '899927837501448242', // 🛠️ `/setstatus` を許可するロールのID
      type: 1, // ROLE
      permission: true
    },
    {
      id: '1080749882417090590', // 🛠️ `/setstatus` を許可する特定のユーザーID
      type: 2, // USER
      permission: true
    }
  ];

  // setStatusCommand.permissions.set(permissions); // Deprecated in v14, permissions are set directly in command definition or via guild.commands.permissions.set

});

// Tim
const getJapanTime = () => DateTime.now().setZone('Asia/Tokyo').toFormat('yyyy-MM-dd HH:mm');

const calculateDuration = (startTime, endTime) => {
  try {
    const start = DateTime.fromFormat(startTime, 'yyyy-MM-dd HH:mm', { zone: 'Asia/Tokyo' });
    const end = DateTime.fromFormat(endTime, 'yyyy-MM-dd HH:mm', { zone: 'Asia/Tokyo' });
    const duration = Interval.fromDateTimes(start, end).toDuration(['hours', 'minutes']);
    return `${Math.floor(duration.hours)}時間 ${Math.floor(duration.minutes)}分`;
  } catch (error) {
    console.error('Duration calculation error:', error);
    return '計算できません';
  }
};

const calculateElapsedTime = (startTime) => {
  try {
    const start = DateTime.fromFormat(startTime, 'yyyy-MM-dd HH:mm', { zone: 'Asia/Tokyo' });
    const now = DateTime.now().setZone('Asia/Tokyo');
    const duration = Interval.fromDateTimes(start, now).toDuration(['hours', 'minutes']);
    return `${Math.floor(duration.hours)}時間 ${Math.floor(duration.minutes)}分`;
  } catch (error) {
    console.error('Elapsed time calculation error:', error);
    return '計算できません';
  }
};

// database
const updateUserStatus = (userId, guildId, status, timestamp, recordType) => {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT OR REPLACE INTO sleep_records (user_id, guild_id, status, timestamp, record_type) VALUES (?, ?, ?, ?, ?)',
      [userId, guildId, status, timestamp, recordType],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
};

const getUserStatus = (userId, guildId) => {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT * FROM sleep_records WHERE user_id = ? AND guild_id = ? ORDER BY timestamp DESC LIMIT 1',
      [userId, guildId],
      (err, row) => {
        if (err) reject(err);
        else resolve(row);
      }
    );
  });
};

const getLastRecord = (userId, guildId, recordType) => {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT * FROM sleep_records WHERE user_id = ? AND guild_id = ? AND record_type = ? ORDER BY timestamp DESC LIMIT 1',
      [userId, guildId, recordType],
      (err, row) => {
        if (err) reject(err);
        else resolve(row);
      }
    );
  });
};

const getAverageAwakeTime = async (userId, guildId) => {
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT * FROM sleep_records WHERE user_id = ? AND guild_id = ? ORDER BY timestamp ASC',
      [userId, guildId],
      (err, rows) => {
        if (err) {
          reject(err);
        } else {
          let totalAwakeMinutes = 0;
          let awakeSessions = 0;
          let lastWakeTime = null;

          rows.forEach(record => {
            if (record.record_type === 'wakeup') {
              lastWakeTime = DateTime.fromFormat(record.timestamp, 'yyyy-MM-dd HH:mm', { zone: 'Asia/Tokyo' });
            } else if (record.record_type === 'sleep' && lastWakeTime) {
              const sleepTime = DateTime.fromFormat(record.timestamp, 'yyyy-MM-dd HH:mm', { zone: 'Asia/Tokyo' });
              const awakeDuration = sleepTime.diff(lastWakeTime, 'minutes').minutes;

              if (awakeDuration > 0) {
                totalAwakeMinutes += awakeDuration;
                awakeSessions++;
              }
              lastWakeTime = null;
            }
          });

          if (awakeSessions === 0) {
            resolve(null);
          } else {
            const avgMinutes = totalAwakeMinutes / awakeSessions;
            resolve(avgMinutes);
          }
        }
      }
    );
  });
};

const remindedUsers = new Set();  // reminder check user id

// updateStatusMessageはリマインダー機能のみを実行するように変更
const updateStatusMessage = async (member, guild, status) => {
  const lastWake = await getLastRecord(member.id, guild.id, 'wakeup');
  
  let elapsedMinutes = 0;

  if (status && status.status === '☀️' && lastWake) {
    const wakeTime = DateTime.fromFormat(lastWake.timestamp, 'yyyy-MM-dd HH:mm', { zone: 'Asia/Tokyo' });
    elapsedMinutes = DateTime.now().setZone('Asia/Tokyo').diff(wakeTime, 'minutes').minutes;
  }

  // 12時間以上起きている場合、DMでリマインダーを送信
  if (status && status.status === '☀️' && elapsedMinutes >= 720 && !remindedUsers.has(member.id)) {
    try {
      await member.send('12時間以上起きていますね！そろそろ寝た方がいいですよ！😴');
      remindedUsers.add(member.id);  // 
      console.log(`リマインダーを送信しました: ${member.user.tag}`);
    } catch (error) {
      console.error(`DM送信エラー (${member.user.tag}):`, error);
    }
  }
  // メインのステータス表示を更新するロジックはhandleStatusCommandに集約
};

async function handleStatsCommand(interaction) {
  try {
    const guildId = interaction.guild.id;
    const userId = interaction.user.id;

    // avg slep time personar
    const avgSleepTime = await getAverageSleepDuration(userId, guildId);
    const avgAwakeTime = await getAverageAwakeTime(userId, guildId);

    // server avg slep time
    const serverAvgSleep = await getServerAverageSleepTime(guildId);

    // avg slep text
    const avgSleepText = avgSleepTime ? `${Math.floor(avgSleepTime / 60)}時間 ${Math.floor(avgSleepTime % 60)}分` : '不明';
    const avgAwakeText = avgAwakeTime ? `${Math.floor(avgAwakeTime / 60)}時間 ${Math.floor(avgAwakeTime % 60)}分` : '不明';
    const serverAvgSleepText = serverAvgSleep ? `${Math.floor(serverAvgSleep / 60)}時間 ${Math.floor(serverAvgSleep % 60)}分` : '不明';

    // embed messege
    const embed = new EmbedBuilder()
      .setColor(0x00AE86)
      .setTitle('📊 睡眠統計')
      .addFields(
        { name: 'あなたの平均睡眠時間', value: avgSleepText, inline: true },
        { name: 'あなたの平均起きていた時間', value: avgAwakeText, inline: true },
        { name: 'サーバー全体の平均睡眠時間', value: serverAvgSleepText, inline: false }
      )
      .setFooter({ text: '過去の記録を元に計算しています。' });

    await interaction.reply({ embeds: [embed] });
  } catch (error) {
    console.error('統計データの取得中にエラーが発生しました:', error);
    await interaction.reply('統計データの取得中にエラーが発生しました。');
  }
}

const getServerAverageSleepTime = async (guildId) => {
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT user_id FROM sleep_records WHERE guild_id = ? GROUP BY user_id',
      [guildId],
      async (err, rows) => {
        if (err) {
          reject(err);
        } else {
          let totalSleepMinutes = 0;
          let userCount = 0;

          for (const row of rows) {
            const userId = row.user_id;
            const avgSleep = await getAverageSleepDuration(userId, guildId);
            if (avgSleep) {
              totalSleepMinutes += avgSleep;
              userCount++;
            }
          }

          if (userCount === 0) {
            resolve(null);
          } else {
            resolve(totalSleepMinutes / userCount);
          }
        }
      }
    );
  });
};

// slashcommandhandler


async function handleStartCommand(interaction) {
  const embed = new EmbedBuilder()
    .setColor(0x00AE86)
    .setTitle('🐈スーパーオートマトントラッカー🐈')
    .setDescription('😈ボタンを押してステータスを変更❗');

  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('wake_up')
        .setLabel('☀️ 起きた')
        .setStyle(ButtonStyle.Primary),

      new ButtonBuilder()
        .setCustomId('sleep')
        .setLabel('🌙 寝た')
        .setStyle(ButtonStyle.Danger),

      new ButtonBuilder()
        .setCustomId('reset_status')
        .setLabel('🌀 状態リセット')
        .setStyle(ButtonStyle.Secondary),

      new ButtonBuilder()
        .setCustomId('show_stats')
        .setLabel('🐻ステータス表示')
        .setStyle(ButtonStyle.Success)
    );

  await interaction.reply({ embeds: [embed], components: [row] });
}


// avgslepduration
const getAverageSleepDuration = async (userId, guildId) => {
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT * FROM sleep_records WHERE user_id = ? AND guild_id = ? ORDER BY timestamp ASC',
      [userId, guildId],
      (err, rows) => {
        if (err) {
          reject(err);
        } else {
          let totalSleepDuration = 0;
          let sleepSessions = 0;
          let sleepStart = null;

          rows.forEach(record => {
            if (record.record_type === 'sleep') {
              sleepStart = DateTime.fromFormat(record.timestamp, 'yyyy-MM-dd HH:mm', { zone: 'Asia/Tokyo' });
            } else if (record.record_type === 'wakeup' && sleepStart) {
              const wakeTime = DateTime.fromFormat(record.timestamp, 'yyyy-MM-dd HH:mm', { zone: 'Asia/Tokyo' });
              const duration = wakeTime.diff(sleepStart, 'minutes').minutes;

              if (duration > 0) {
                totalSleepDuration += duration;
                sleepSessions++;
              }
              sleepStart = null;
            }
          });

          if (sleepSessions === 0) {
            resolve(null);  // no data null
          } else {
            const avgMinutes = totalSleepDuration / sleepSessions;
            resolve(avgMinutes);  // min
          }
        }
      }
    );
  });
};

const predictWakeUpTime = (sleepStartTime, avgSleepMinutes) => {
  if (!avgSleepMinutes) {
    return '不明';  // no avg sleep null
  }

  try {
    const sleepStart = DateTime.fromFormat(sleepStartTime, 'yyyy-MM-dd HH:mm', { zone: 'Asia/Tokyo' });
    const predictedWakeUpTime = sleepStart.plus({ minutes: avgSleepMinutes });
    return predictedWakeUpTime.toFormat('yyyy-MM-dd HH:mm');
  } catch (error) {
    console.error('Wake up time prediction error:', error);
    return '不明';
  }
};

// handleStatusCommandを修正し、記録があるすべてのユーザーのステータスを表示するようにする
async function handleStatusCommand(interaction) { 
  const guild = interaction.guild;
  const channel = guild.channels.cache.find(ch => ch.name === 'スーパーオートマトントラッカー');
  if (!channel) {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '「スーパーオートマトントラッカー」チャンネルが見つかりませんでした。', flags: MessageFlags.Ephemeral });
    } else {
      await interaction.followUp({ content: '「スーパーオートマトントラッカー」チャンネルが見つかりませんでした。', flags: MessageFlags.Ephemeral });
    }
    return;
  }

  // ギルド内で記録があるすべてのユーザーIDを取得
  const userRecords = await new Promise((resolve, reject) => {
    db.all(
      'SELECT DISTINCT user_id FROM sleep_records WHERE guild_id = ?',
      [guild.id],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows.map(row => row.user_id));
      }
    );
  });

  let description = '';

  if (userRecords.length === 0) {
    description = 'まだ誰も記録されていません。';
  } else {
    for (const userId of userRecords) {
      const member = await guild.members.fetch(userId).catch(() => null); // メンバーが存在しない場合も考慮
      if (!member) continue; // メンバーがサーバーにいない場合はスキップ

      const status = await getUserStatus(userId, guild.id);
      const lastWake = await getLastRecord(userId, guild.id, 'wakeup');
      const lastSleep = await getLastRecord(userId, guild.id, 'sleep');
      const avgSleep = await getAverageSleepDuration(userId, guild.id);

      let elapsedTime = '未記録';
      let lastDurationText = '未記録'; // 寝ていた時間 / 起きていた時間
      const avgSleepText = avgSleep ? `${Math.floor(avgSleep / 60)}時間 ${Math.floor(avgSleep % 60)}分` : '不明';

      // ユーザーの現在のステータスに基づいて情報を設定
      let userCurrentStatus = '未記録';
      if (status) {
        userCurrentStatus = status.status === '☀️' ? '起きている' : '寝ている';
        if (status.status === '☀️' && lastWake) {
          elapsedTime = calculateElapsedTime(lastWake.timestamp);
          if (lastSleep) {
            lastDurationText = calculateDuration(lastSleep.timestamp, lastWake.timestamp);
          } else {
            lastDurationText = '前回の睡眠記録なし';
          }
        } else if (status.status === '🌙' && lastSleep) {
          elapsedTime = calculateElapsedTime(lastSleep.timestamp);
          if (lastWake) {
            lastDurationText = calculateDuration(lastWake.timestamp, lastSleep.timestamp);
          } else {
            lastDurationText = '前回の起床記録なし';
          }
        }
      }

      description += `<@${userId}> - ${userCurrentStatus}\n`;
      description += `最後に起きた時間: ${lastWake ? lastWake.timestamp : '未記録'}\n`;
      description += `最後に寝た時間: ${lastSleep ? lastSleep.timestamp : '未記録'}\n`;
      description += `${userCurrentStatus === '起きている' ? '寝ていた時間' : '起きていた時間'}: ${lastDurationText}\n`;
      description += `${userCurrentStatus === '起きている' ? '起きてからの経過時間' : '寝てからの経過時間'}: ${elapsedTime}\n`;
      description += `平均睡眠時間: ${avgSleepText}\n\n`;
    }
  }

  const embed = new EmbedBuilder()
    .setColor(0x00AE86)
    .setTitle('現在のステータス')
    .setDescription(description);

  // 既存のメッセージを検索し、編集または新規送信
  const messages = await channel.messages.fetch({ limit: 10 });
  const statusMessage = messages.find(msg => msg.author.id === client.user.id && msg.embeds.length > 0 && msg.embeds[0].title === '現在のステータス');

  if (statusMessage) {
    await statusMessage.edit({ embeds: [embed] });
  } else {
    await channel.send({ embeds: [embed] });
  }

  // interactionがまだ応答されていない場合のみ、ephemeralな返信を送信
  if (interaction && (interaction.isChatInputCommand() || interaction.isButton())) {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'ステータスを更新しました。', flags: MessageFlags.Ephemeral });
    } else if (interaction.deferred) {
      await interaction.followUp({ content: 'ステータスを更新しました。', flags: MessageFlags.Ephemeral });
    }
  }
}

const generateStatsEmbed = async (guildId) => {
  const sleepData = await getWeeklySleepData(guildId);
  const sleepStats = calculateWeeklySleepStats(sleepData);

  const sortedUsers = Object.entries(sleepStats)
    .sort((a, b) => b[1].totalSleepMinutes - a[1].totalSleepMinutes)
    .slice(0, 10);

  let description = '';

  if (sortedUsers.length === 0) {
    description = '今週の睡眠データがありません。';
  } else {
    for (let i = 0; i < sortedUsers.length; i++) {
      const [userId, stats] = sortedUsers[i];
      const totalHours = Math.floor(stats.totalSleepMinutes / 60);
      const totalMinutes = Math.floor(stats.totalMinutes % 60);
      description += `**${i + 1}位**: <@${userId}> - ${totalHours}時間 ${totalMinutes}分\n`;
    }
  }

  return new EmbedBuilder()
    .setColor(0x00AE86)
    .setTitle('🛌 週間睡眠ランキング')
    .setDescription(description)
    .setFooter({ text: '過去7日間の総睡眠時間に基づいています。' });
};

const ALLOWED_ROLE_ID = '123456789012345678'; // 🛠️ 許可するロールのID
const ALLOWED_USERS = ['1080749882417090590', '112233445566778899']; // 🛠️ 許可するユーザーのIDリスト

async function handleSetStatusCommand(interaction) {
  let member = interaction.member;
  
  // 🔍 最新のロール情報を取得（キャッシュの問題を防ぐ）
  member = await member.fetch();

  // 🔍 デバッグ: 実行者の情報をログに出力
  console.log('実行者のユーザーID:', member.id);
  console.log('実行者のロール:', member.roles.cache.map(role => `${role.name} (${role.id})`).join(', '));

  // 🛠️ 「管理者」または「特定のロールを持っているユーザー」または「特定のユーザーのみ」実行可能
  if (
    !member.permissions.has(PermissionsBitField.Flags.ManageGuild) && // 管理者権限がない
    !member.roles.cache.has(ALLOWED_ROLE_ID) && // 許可されたロールを持っていない
    !ALLOWED_USERS.includes(member.id) // 許可されたユーザーリストに入っていない
  ) {
    return await interaction.reply({
      content: '🚫 お前は権限を持ってないこのぐーばーめ！',
      ephemeral: false // 全員に見える（個別にするなら `true`）
    });
  }

  const targetUser = interaction.options.getUser('user');
  const newStatus = interaction.options.getString('status');
  const guildId = interaction.guild.id;
  const userId = targetUser.id;
  const time = getJapanTime();

  if (!targetUser) {
    return await interaction.reply({
      content: '❌ 対象のユーザーを指定してください。',
      flags: MessageFlags.Ephemeral
    });
  }

  if (!['☀️', '🌙'].includes(newStatus)) {
    return await interaction.reply({
      content: '❌ ステータスは ☀️（起きている） または 🌙（寝ている） のみ設定できます。',
      flags: MessageFlags.Ephemeral
    });
  }

  // 🛠️ データベースを更新
  try {
    await updateUserStatus(userId, guildId, newStatus, time, newStatus === '☀️' ? 'wakeup' : 'sleep');

    await interaction.reply({
      content: `✅ <@${userId}> の状態を **「${newStatus === '☀️' ? '起きている ☀️' : '寝ている 🌙'}」** に変更しました。`,
      ephemeral: false
    });
    // メインのステータス表示を更新
    // handleStatusCommandはinteractionオブジェクトを期待するため、元のinteractionを渡す
    await handleStatusCommand(interaction); 
  } catch (error) {
    console.error('❌ ステータス変更エラー:', error);
    await interaction.reply({
      content: '❌ ステータスの更新中にエラーが発生しました。',
      flags: MessageFlags.Ephemeral
    });
  }
}

async function handleWeeklyStats(context) {
  try {
    const guildId = context.guild.id;
    const userId = context.user ? context.user.id : context.userId;  

    if (!userId) {
      console.error('ユーザーIDが取得できませんでした。');
      if (context.reply) {
        await context.reply({ content: 'ユーザーIDが取得できませんでした。', flags: MessageFlags.Ephemeral });
      } else {
        await context.channel.send('ユーザーIDが取得できませんでした。');
      }
      return;
    }

    const member = await context.guild.members.fetch(userId);
    const displayName = member ? member.displayName : '不明なユーザー';

    const embed = await generateStatsEmbed(guildId); // This generates the weekly ranking embed

    const avgAwakeTime = await getAverageAwakeTime(userId, guildId);
    const serverAvgSleep = await getServerAverageSleepTime(guildId);
    const avgSleepTimeUser = await getAverageSleepDuration(userId, guildId); // ユーザーの平均睡眠時間を取得

    const avgAwakeText = avgAwakeTime ? `${Math.floor(avgAwakeTime / 60)}時間 ${Math.floor(avgAwakeTime % 60)}分` : '不明';
    const serverAvgSleepText = serverAvgSleep ? `${Math.floor(serverAvgSleep / 60)}時間 ${Math.floor(serverAvgSleep % 60)}分` : '不明';
    const avgSleepText = avgSleepTimeUser ? `${Math.floor(avgSleepTimeUser / 60)}時間 ${Math.floor(avgSleepTimeUser % 60)}分` : '不明'; // ユーザーの平均睡眠時間テキスト

    embed.addFields(
      { name: `😴 あなたの平均睡眠時間 (${displayName})`, value: avgSleepText, inline: true }, // ユーザーの平均睡眠時間を追加
      { name: `🕰 あなたの平均起きていた時間 (${displayName})`, value: avgAwakeText, inline: true },
      { name: '🛌 サーバー全体の平均睡眠時間', value: serverAvgSleepText, inline: false }
    );

    const channel = context.channel || context.guild.channels.cache.find(ch => ch.name === 'スーパーオートマトントラッカー');
    if (!channel) {
      if (context.reply) {
        await context.reply({ content: '「スーパーオートマトントラッカー」チャンネルが見つかりませんでした。', flags: MessageFlags.Ephemeral });
      } else {
        console.error('「スーパーオートマトントラッカー」チャンネルが見つかりませんでした。');
      }
      return;
    }

    // 既存の週間統計メッセージを検索し、編集または新規送信
    const messages = await channel.messages.fetch({ limit: 10 });
    const weeklyStatsMessage = messages.find(msg => msg.author.id === client.user.id && msg.embeds.length > 0 && msg.embeds[0].title === '🛌 週間睡眠ランキング');

    if (weeklyStatsMessage) {
      await weeklyStatsMessage.edit({ embeds: [embed] });
    } else {
      await channel.send({ embeds: [embed] });
    }

    // interactionからの呼び出しの場合、ephemeralな返信を送信
    if (context.reply) {
      if (!context.replied && !context.deferred) {
        await context.reply({ content: '週間統計を更新しました。', flags: MessageFlags.Ephemeral });
      } else if (context.deferred) {
        await context.followUp({ content: '週間統計を更新しました。', flags: MessageFlags.Ephemeral });
      }
    }

  } catch (error) {
    console.error('週間統計の取得中にエラーが発生しました:', error);
    if (context.replied || context.deferred) {
      return await context.followUp('週間統計の取得中にエラーが発生しました。');
    } else if (context.reply) {
      return await context.reply('週間統計の取得中にエラーが発生しました。');
    } else {
      return await context.channel.send('週間統計の取得中にエラーが発生しました。');
    }
  }
}

client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) await reaction.fetch();

  const channel = reaction.message.channel;

  // 🔽 ここでリアクションのチャンネルが「スーパーオートマトントラッカー」以外なら無視する
  if (channel.name !== 'スーパーオートマトントラッカー') return;

  const userId = user.id;
  const guild = reaction.message.guild;
  const guildId = guild.id;
  const time = getJapanTime();

  try {
    switch (reaction.emoji.name) {
      case '☀️':
        await updateUserStatus(userId, guildId, '☀️', time, 'wakeup');
        const wakeMsg = await channel.send(`<@${userId}>は起きました！`);
        setTimeout(() => wakeMsg.delete().catch(console.error), 30000);
        // メインのステータス表示を更新
        // リアクションからの呼び出しなので、ダミーのinteractionオブジェクトを作成
        await handleStatusCommand({ guild: guild, channel: channel, user: user, member: await guild.members.fetch(userId), isChatInputCommand: () => false, isButton: () => false, replied: false, deferred: false, reply: async () => {}, followUp: async () => {} });
        break;

      case '🌙':
        await updateUserStatus(userId, guildId, '🌙', time, 'sleep');
        const sleepMsg = await channel.send(`<@${userId}>は寝ました！`);
        setTimeout(() => sleepMsg.delete().catch(console.error), 30000);
        // メインのステータス表示を更新
        // リアクションからの呼び出しなので、ダミーのinteractionオブジェクトを作成
        await handleStatusCommand({ guild: guild, channel: channel, user: user, member: await guild.members.fetch(userId), isChatInputCommand: () => false, isButton: () => false, replied: false, deferred: false, reply: async () => {}, followUp: async () => {} });
        break;

      case '🌀':
        // リアクションからのリセットも二段階確認にする場合はここにロジックを追加
        // 現状は即時リセット
        await db.run(
          'DELETE FROM sleep_records WHERE user_id = ? AND guild_id = ?',
          [userId, guildId]
        );
        const resetMsg = await channel.send(`<@${userId}>の状態はリセットされました。`);
        setTimeout(() => resetMsg.delete().catch(console.error), 30000);
        // メインのステータス表示を更新
        // リアクションからの呼び出しなので、ダミーのinteractionオブジェクトを作成
        await handleStatusCommand({ guild: guild, channel: channel, user: user, member: await guild.members.fetch(userId), isChatInputCommand: () => false, isButton: () => false, replied: false, deferred: false, reply: async () => {}, followUp: async () => {} });
        break;

      case '🐻':
        const messages = await channel.messages.fetch({ limit: 20 });

        const statusMessages = messages.filter(msg =>
          msg.author.id === client.user.id && // client.user.id を使用
          msg.embeds.length > 0 &&
          msg.embeds[0].title === '現在のステータス'
        );

        const statsMessages = messages.filter(msg =>
          msg.author.id === client.user.id && // client.user.id を使用
          msg.embeds.length > 0 &&
          msg.embeds[0].title === '🛌 週間睡眠ランキング'
        );

        for (const msg of statusMessages.values()) {
          await msg.delete().catch(console.error);
        }

        for (const msg of statsMessages.values()) {
          await msg.delete().catch(console.error);
        }

        // handleStatusCommandとhandleWeeklyStatsの引数を調整
        // リアクションからの呼び出しなので、ダミーのinteractionオブジェクトを作成
        const dummyInteractionForReaction = { guild: guild, channel: channel, user: user, member: await guild.members.fetch(userId), isChatInputCommand: () => false, isButton: () => false, replied: false, deferred: false, reply: async () => {}, followUp: async () => {} };
        await handleStatusCommand(dummyInteractionForReaction); 
        await handleWeeklyStats(dummyInteractionForReaction); 

        break;
    }
  } catch (error) {
    console.error('Reaction handling error:', error);
    const errorMsg = await channel.send('エラーが発生しました。');
    setTimeout(() => errorMsg.delete().catch(console.error), 30000);
  }

  // チャンネルが「スーパーオートマトントラッカー」の場合、リアクションを削除
  reaction.users.remove(user).catch(console.error);
});

client.login(process.env.DISCORD_TOKEN);
