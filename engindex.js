const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField, MessageFlags } = require('discord.js');
const { DateTime, Interval } = require('luxon');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
require('dotenv').config();

const { ReadableStream } = require('stream/web');
globalThis.ReadableStream = ReadableStream;

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

const resetConfirmationPending = new Map(); // Stores userId -> timestamp of first press
const RESET_CONFIRMATION_TIMEOUT_MS = 30 * 1000; // 30 seconds

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

const clearUserSleepRecords = (userId, guildId) => {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM sleep_records WHERE user_id = ? AND guild_id = ?', [userId, guildId], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
};


client.on('interactionCreate', async interaction => {
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
          await interaction.reply({ content: 'Unknown command.', flags: MessageFlags.Ephemeral });
          break;
      }
    } catch (error) {
      console.error('Slash command processing error:', error);
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: 'An error occurred while executing the command.', flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: 'An error occurred while executing the command.', flags: MessageFlags.Ephemeral });
      }
    }
    return;
  }

  if (interaction.isButton()) {
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;
    const channel = interaction.channel;
    const time = getJapanTime();

    try {
      switch (interaction.customId) {
        case 'wake_up':
          await updateUserStatus(userId, guildId, '☀️', time, 'wakeup');
          await interaction.reply({ content: `<@${userId}> woke up!`, flags: MessageFlags.Ephemeral });
          // Update status
          await handleStatusCommand(interaction); 
          break;

        case 'sleep':
          await updateUserStatus(userId, guildId, '🌙', time, 'sleep');
          await interaction.reply({ content: `<@${userId}> went to sleep!`, flags: MessageFlags.Ephemeral });
          // Update status
          await handleStatusCommand(interaction); 
          break;

        case 'reset_status':
          const now = Date.now();
          const lastPressTime = resetConfirmationPending.get(userId);

          if (lastPressTime && (now - lastPressTime < RESET_CONFIRMATION_TIMEOUT_MS)) {
            await db.run('DELETE FROM sleep_records WHERE user_id = ? AND guild_id = ?', [userId, guildId]);
            resetConfirmationPending.delete(userId); 
            await interaction.reply({ content: `<@${userId}>'s status has been reset.`, flags: MessageFlags.Ephemeral });
            // Update status
            await handleStatusCommand(interaction); 
          } else {
            resetConfirmationPending.set(userId, now);
            await interaction.reply({ content: `<@${userId}>, are you sure you want to reset your status?\nPress the "🌀 Reset Status" button again to confirm (within ${RESET_CONFIRMATION_TIMEOUT_MS / 1000} seconds).`, flags: MessageFlags.Ephemeral });

            setTimeout(() => {
              if (resetConfirmationPending.get(userId) === now) {
                resetConfirmationPending.delete(userId);
              }
            }, RESET_CONFIRMATION_TIMEOUT_MS);
          }
          break;

        case 'show_stats':
          // Update current status
          await handleStatusCommand(interaction); 
          // Update weekly sleep ranking
          await handleWeeklyStats(interaction); 
          break;
      }
    } catch (error) {
      console.error('Button processing error:', error);
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: 'An error occurred.', flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: 'An error occurred.', flags: MessageFlags.Ephemeral });
      }
    }
    return;
  }
});

async function handleClearCommand(interaction) {
  const member = interaction.member;
  const executor = interaction.user; 
  const executorMention = `<@${executor.id}>`;

  // Permission check
  if (
    !member.permissions.has(PermissionsBitField.Flags.ManageGuild) && 
    !member.roles.cache.has(ALLOWED_ROLE_ID) && 
    !ALLOWED_USERS.includes(member.id)
  ) {
    return await interaction.reply({
      content: '🚫 You do not have permission!',
      ephemeral: false 
    });
  }

  const targetUser = interaction.options.getUser('user');
  const guildId = interaction.guild.id;
  const userId = targetUser.id;

  try {
    await clearUserSleepRecords(userId, guildId);
    await interaction.reply({
      content: `🗑️ <@${userId}>'s sleep tracker records have been reset.\n(Executed by: ${executorMention})`,
      ephemeral: false
    });
    // Update status
    await handleStatusCommand(interaction);
  } catch (error) {
    console.error('❌ User record deletion error:', error);
    await interaction.reply({
      content: '❌ An error occurred while resetting user records.',
      flags: MessageFlags.Ephemeral
    });
  }
}


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

      userSleepStats[userId].sleepStart = null;  
    }
  });

  return userSleepStats;
};

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
    description: 'Starts the sleep tracker.'
  },
  {
    name: 'status',
    description: 'Displays current status.'
  },
  {
    name: 'stats',
    description: 'Displays sleep statistics.'
  },
  {
    name: 'setstatus',
    description: 'Changes a player\'s sleep status (Admin only).',
    options: [
      {
        name: 'user',
        type: 6, 
        description: 'Select the user to change status for.',
        required: true
      },
      {
        name: 'status',
        type: 3, 
        description: 'Status to set (☀️ Awake / 🌙 Asleep).',
        required: true,
        choices: [
          { name: '☀️ Awake', value: '☀️' },
          { name: '🌙 Asleep', value: '🌙' }
        ]
      }
    ]
  },
  {
    name: 'clear', 
    description: 'Resets a user\'s sleep tracker records (Admin only).',
    options: [
      {
        name: 'user',
        type: 6, 
        description: 'Select the user to reset.',
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

  setInterval(async () => {
    const guilds = client.guilds.cache;
    for (const guild of guilds.values()) {
      const members = await guild.members.fetch();
      for (const member of members.values()) {
        const status = await getUserStatus(member.id, guild.id);
        // Only execute reminder function
        if (status && member.presence) {
          await updateStatusMessage(member, guild, status);
        }
      }
    }
  }, 5000); 
});

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  const guild = client.guilds.cache.get('899915374630420540'); // 🛠️ Insert your server ID here
  if (!guild) return console.error('❌ Guild not found.');

  // Register /setstatus (as a guild command)
  const commands = await guild.commands.set([
    {
      name: 'setstatus',
      description: 'Changes a player\'s sleep status (Admin & specific role only).',
      options: [
        {
          name: 'user',
          type: 6, 
          description: 'Select the user to change status for.',
          required: true
        },
        {
          name: 'status',
          type: 3, 
          description: 'Status to set (☀️ Awake / 🌙 Asleep).',
          required: true,
          choices: [
            { name: '☀️ Awake', value: '☀️' },
            { name: '🌙 Asleep', value: '🌙' }
          ]
        }
      ]
    }
  ]);

  console.log('✅ /setstatus command registered.');

  // Set permissions for /setstatus
  const setStatusCommand = commands.find(cmd => cmd.name === 'setstatus');
  if (!setStatusCommand) {
    console.error('❌ /setstatus command not found.');
    return;
  }

  const permissions = [
    {
      id: '899916001070678086', // 🛠️ Admin Role ID
      type: 1, 
      permission: true
    },
    {
      id: '899927837501448242', // 🛠️ Role ID allowed to use /setstatus
      type: 1, 
      permission: true
    },
    {
      id: '1080749882417090590', // 🛠️ Specific User ID allowed to use /setstatus
      type: 2, 
      permission: true
    }
  ];

});

const getJapanTime = () => DateTime.now().setZone('Asia/Tokyo').toFormat('yyyy-MM-dd HH:mm');

const calculateDuration = (startTime, endTime) => {
  try {
    const start = DateTime.fromFormat(startTime, 'yyyy-MM-dd HH:mm', { zone: 'Asia/Tokyo' });
    const end = DateTime.fromFormat(endTime, 'yyyy-MM-dd HH:mm', { zone: 'Asia/Tokyo' });
    const duration = Interval.fromDateTimes(start, end).toDuration(['hours', 'minutes']);
    return `${Math.floor(duration.hours)}h ${Math.floor(duration.minutes)}m`;
  } catch (error) {
    console.error('Duration calculation error:', error);
    return 'N/A';
  }
};

const calculateElapsedTime = (startTime) => {
  try {
    const start = DateTime.fromFormat(startTime, 'yyyy-MM-dd HH:mm', { zone: 'Asia/Tokyo' });
    const now = DateTime.now().setZone('Asia/Tokyo');
    const duration = Interval.fromDateTimes(start, now).toDuration(['hours', 'minutes']);
    return `${Math.floor(duration.hours)}h ${Math.floor(duration.minutes)}m`;
  } catch (error) {
    console.error('Elapsed time calculation error:', error);
    return 'N/A';
  }
};

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

const remindedUsers = new Set();  

const updateStatusMessage = async (member, guild, status) => {
  const lastWake = await getLastRecord(member.id, guild.id, 'wakeup');
  
  let elapsedMinutes = 0;

  if (status && status.status === '☀️' && lastWake) {
    const wakeTime = DateTime.fromFormat(lastWake.timestamp, 'yyyy-MM-dd HH:mm', { zone: 'Asia/Tokyo' });
    elapsedMinutes = DateTime.now().setZone('Asia/Tokyo').diff(wakeTime, 'minutes').minutes;
  }

  // If awake for 12+ hours, send DM reminder
  if (status && status.status === '☀️' && elapsedMinutes >= 720 && !remindedUsers.has(member.id)) {
    try {
      await member.send('You have been awake for more than 12 hours! You should probably go to sleep! 😴');
      remindedUsers.add(member.id);  
      console.log(`Reminder sent: ${member.user.tag}`);
    } catch (error) {
      console.error(`DM sending error (${member.user.tag}):`, error);
    }
  }
};

async function handleStatsCommand(interaction) {
  try {
    const guildId = interaction.guild.id;
    const userId = interaction.user.id;

    const avgSleepTime = await getAverageSleepDuration(userId, guildId);
    const avgAwakeTime = await getAverageAwakeTime(userId, guildId);

    const serverAvgSleep = await getServerAverageSleepTime(guildId);

    const avgSleepText = avgSleepTime ? `${Math.floor(avgSleepTime / 60)}h ${Math.floor(avgSleepTime % 60)}m` : 'N/A';
    const avgAwakeText = avgAwakeTime ? `${Math.floor(avgAwakeTime / 60)}h ${Math.floor(avgAwakeTime % 60)}m` : 'N/A';
    const serverAvgSleepText = serverAvgSleep ? `${Math.floor(serverAvgSleep / 60)}h ${Math.floor(serverAvgSleep % 60)}m` : 'N/A';

    const embed = new EmbedBuilder()
      .setColor(0x00AE86)
      .setTitle('📊 Sleep Statistics')
      .addFields(
        { name: 'Your Average Sleep Duration', value: avgSleepText, inline: true },
        { name: 'Your Average Awake Duration', value: avgAwakeText, inline: true },
        { name: 'Server Average Sleep Duration', value: serverAvgSleepText, inline: false }
      )
      .setFooter({ text: 'Calculated from past records.' });

    await interaction.reply({ embeds: [embed] });
  } catch (error) {
    console.error('Error fetching statistics:', error);
    await interaction.reply('An error occurred while fetching statistics.');
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

async function handleStartCommand(interaction) {
  const embed = new EmbedBuilder()
    .setColor(0x00AE86)
    .setTitle('🐈Super Automaton Tracker🐈')
    .setDescription('😈Press buttons to change status❗');

  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('wake_up')
        .setLabel('☀️ Awake')
        .setStyle(ButtonStyle.Primary),

      new ButtonBuilder()
        .setCustomId('sleep')
        .setLabel('🌙 Asleep')
        .setStyle(ButtonStyle.Danger),

      new ButtonBuilder()
        .setCustomId('reset_status')
        .setLabel('🌀 Reset Status')
        .setStyle(ButtonStyle.Secondary),

      new ButtonBuilder()
        .setCustomId('show_stats')
        .setLabel('🐻 Show Stats')
        .setStyle(ButtonStyle.Success)
    );

  await interaction.reply({ embeds: [embed], components: [row] });
}


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
            resolve(null);  
          } else {
            const avgMinutes = totalSleepDuration / sleepSessions;
            resolve(avgMinutes);  
          }
        }
      }
    );
  });
};

const predictWakeUpTime = (sleepStartTime, avgSleepMinutes) => {
  if (!avgSleepMinutes) {
    return 'N/A';  
  }

  try {
    const sleepStart = DateTime.fromFormat(sleepStartTime, 'yyyy-MM-dd HH:mm', { zone: 'Asia/Tokyo' });
    const predictedWakeUpTime = sleepStart.plus({ minutes: avgSleepMinutes });
    return predictedWakeUpTime.toFormat('yyyy-MM-dd HH:mm');
  } catch (error) {
    console.error('Wake up time prediction error:', error);
    return 'N/A';
  }
};

async function handleStatusCommand(interaction) { 
  const guild = interaction.guild;
  const channel = guild.channels.cache.find(ch => ch.name === 'スーパーオートマトントラッカー');
  if (!channel) {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'The "Super Automaton Tracker" channel was not found.', flags: MessageFlags.Ephemeral });
    } else {
      await interaction.followUp({ content: 'The "Super Automaton Tracker" channel was not found.', flags: MessageFlags.Ephemeral });
    }
    return;
  }

  // Get all user IDs with records in the guild
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
    description = 'No one has recorded yet.';
  } else {
    for (const userId of userRecords) {
      const member = await guild.members.fetch(userId).catch(() => null); 
      if (!member) continue; 

      const status = await getUserStatus(userId, guild.id);
      const lastWake = await getLastRecord(userId, guild.id, 'wakeup');
      const lastSleep = await getLastRecord(userId, guild.id, 'sleep');
      const avgSleep = await getAverageSleepDuration(userId, guild.id);

      let elapsedTime = 'N/A';
      let lastDurationText = 'N/A'; 
      const avgSleepText = avgSleep ? `${Math.floor(avgSleep / 60)}h ${Math.floor(avgSleep % 60)}m` : 'N/A';

      let userCurrentStatus = 'N/A';
      if (status) {
        userCurrentStatus = status.status === '☀️' ? 'Awake' : 'Asleep';
        if (status.status === '☀️' && lastWake) {
          elapsedTime = calculateElapsedTime(lastWake.timestamp);
          if (lastSleep) {
            lastDurationText = calculateDuration(lastSleep.timestamp, lastWake.timestamp);
          } else {
            lastDurationText = 'No previous sleep record';
          }
        } else if (status.status === '🌙' && lastSleep) {
          elapsedTime = calculateElapsedTime(lastSleep.timestamp);
          if (lastWake) {
            lastDurationText = calculateDuration(lastWake.timestamp, lastSleep.timestamp);
          } else {
            lastDurationText = 'No previous wake record';
          }
        }
      }

      description += `<@${userId}> - ${userCurrentStatus}\n`;
      description += `Last Awake: ${lastWake ? lastWake.timestamp : 'N/A'}\n`;
      description += `Last Asleep: ${lastSleep ? lastSleep.timestamp : 'N/A'}\n`;
      description += `${userCurrentStatus === 'Awake' ? 'Sleep Duration' : 'Awake Duration'}: ${lastDurationText}\n`;
      description += `${userCurrentStatus === 'Awake' ? 'Time Since Awake' : 'Time Since Asleep'}: ${elapsedTime}\n`;
      description += `Average Sleep: ${avgSleepText}\n\n`;
    }
  }

  const embed = new EmbedBuilder()
    .setColor(0x00AE86)
    .setTitle('Current Status')
    .setDescription(description);

  const messages = await channel.messages.fetch({ limit: 10 });
  const statusMessage = messages.find(msg => msg.author.id === client.user.id && msg.embeds.length > 0 && msg.embeds[0].title === 'Current Status');

  if (statusMessage) {
    await statusMessage.edit({ embeds: [embed] });
  } else {
    await channel.send({ embeds: [embed] });
  }

  // Send ephemeral reply only if interaction is not yet replied
  // Note: For reactions or /setstatus calls, interaction.isChatInputCommand() or interaction.isButton() will be false,
  // so no ephemeral reply is sent here. This is intended.
  if (interaction && (interaction.isChatInputCommand() || interaction.isButton())) {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Status updated.', flags: MessageFlags.Ephemeral });
    } else if (interaction.deferred) {
      await interaction.followUp({ content: 'Status updated.', flags: MessageFlags.Ephemeral });
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
    description = 'No sleep data for this week.';
  } else {
    for (let i = 0; i < sortedUsers.length; i++) {
      const [userId, stats] = sortedUsers[i];
      const totalHours = Math.floor(stats.totalSleepMinutes / 60);
      const totalMinutes = Math.floor(stats.totalSleepMinutes % 60);
      description += `**#${i + 1}**: <@${userId}> - ${totalHours}h ${totalMinutes}m\n`;
    }
  }

  return new EmbedBuilder()
    .setColor(0x00AE86)
    .setTitle('🛌 Weekly Sleep Ranking')
    .setDescription(description)
    .setFooter({ text: 'Based on total sleep duration over the past 7 days.' });
};

const ALLOWED_ROLE_ID = '123456789012345678'; // Allowed role ID
const ALLOWED_USERS = ['1080749882417090590', '112233445566778899']; // Allowed user IDs

async function handleSetStatusCommand(interaction) {
  let member = interaction.member;
  
  // Fetch latest role info (to prevent caching issues)
  member = await member.fetch();

  // Debug: Log executor info
  console.log('Executor User ID:', member.id);
  console.log('Executor Roles:', member.roles.cache.map(role => `${role.name} (${role.id})`).join(', '));

  // Only callable by administrators, users with specific roles, or specific users
  if (
    !member.permissions.has(PermissionsBitField.Flags.ManageGuild) && 
    !member.roles.cache.has(ALLOWED_ROLE_ID) && 
    !ALLOWED_USERS.includes(member.id)
  ) {
    return await interaction.reply({
      content: '🚫 You do not have permission!',
      ephemeral: false 
    });
  }

  const targetUser = interaction.options.getUser('user');
  const newStatus = interaction.options.getString('status');
  const guildId = interaction.guild.id;
  const userId = targetUser.id;
  const time = getJapanTime();

  if (!targetUser) {
    return await interaction.reply({
      content: '❌ Please specify a target user.',
      flags: MessageFlags.Ephemeral
    });
  }

  if (!['☀️', '🌙'].includes(newStatus)) {
    return await interaction.reply({
      content: '❌ Status can only be ☀️ (Awake) or 🌙 (Asleep).',
      flags: MessageFlags.Ephemeral
    });
  }

  // Update database
  try {
    await updateUserStatus(userId, guildId, newStatus, time, newStatus === '☀️' ? 'wakeup' : 'sleep');

    await interaction.reply({
      content: `✅ <@${userId}>'s status has been changed to **"${newStatus === '☀️' ? 'Awake ☀️' : 'Asleep 🌙'}"**.`,
      ephemeral: false
    });
    // Update status
    await handleStatusCommand(interaction); 
  } catch (error) {
    console.error('❌ Status change error:', error);
    await interaction.reply({
      content: '❌ An error occurred while updating status.',
      flags: MessageFlags.Ephemeral
    });
  }
}

async function handleWeeklyStats(context) {
  try {
    const guildId = context.guild.id;
    const userId = context.user ? context.user.id : context.userId;  

    if (!userId) {
      console.error('User ID could not be retrieved.');
      if (context.reply) {
        await context.reply({ content: 'User ID could not be retrieved.', flags: MessageFlags.Ephemeral });
      } else {
        await context.channel.send('User ID could not be retrieved.');
      }
      return;
    }

    const member = await context.guild.members.fetch(userId);
    const displayName = member ? member.displayName : 'Unknown User';

    const embed = await generateStatsEmbed(guildId); 

    const avgAwakeTime = await getAverageAwakeTime(userId, guildId);
    const serverAvgSleep = await getServerAverageSleepTime(guildId);
    const avgSleepTimeUser = await getAverageSleepDuration(userId, guildId); 

    const avgAwakeText = avgAwakeTime ? `${Math.floor(avgAwakeTime / 60)}h ${Math.floor(avgAwakeTime % 60)}m` : 'N/A';
    const serverAvgSleepText = serverAvgSleep ? `${Math.floor(serverAvgSleep / 60)}h ${Math.floor(serverAvgSleep % 60)}m` : 'N/A';
    const avgSleepText = avgSleepTimeUser ? `${Math.floor(avgSleepTimeUser / 60)}h ${Math.floor(avgSleepTimeUser % 60)}m` : 'N/A'; 

    embed.addFields(
      { name: `😴 Your Average Sleep Duration (${displayName})`, value: avgSleepText, inline: true }, 
      { name: `🕰 Your Average Awake Duration (${displayName})`, value: avgAwakeText, inline: true },
      { name: '🛌 Server Average Sleep Duration', value: serverAvgSleepText, inline: false }
    );

    const channel = context.channel || context.guild.channels.cache.find(ch => ch.name === 'スーパーオートマトントラッカー');
    if (!channel) {
      if (context.reply) {
        await context.reply({ content: 'The "Super Automaton Tracker" channel was not found.', flags: MessageFlags.Ephemeral });
      } else {
        console.error('The "Super Automaton Tracker" channel was not found.');
      }
      return;
    }

    const messages = await channel.messages.fetch({ limit: 10 });
    const weeklyStatsMessage = messages.find(msg => msg.author.id === client.user.id && msg.embeds.length > 0 && msg.embeds[0].title === '🛌 Weekly Sleep Ranking');

    if (weeklyStatsMessage) {
      await weeklyStatsMessage.edit({ embeds: [embed] });
    } else {
      await channel.send({ embeds: [embed] });
    }

    if (context.reply) {
      if (!context.replied && !context.deferred) {
        await context.reply({ content: 'Weekly statistics updated.', flags: MessageFlags.Ephemeral });
      } else if (context.deferred) {
        await context.followUp({ content: 'Weekly statistics updated.', flags: MessageFlags.Ephemeral });
      }
    }

  } catch (error) {
    console.error('Error fetching weekly statistics:', error);
    if (context.replied || context.deferred) {
      return await context.followUp('An error occurred while fetching weekly statistics.');
    } else if (context.reply) {
      return await context.reply('An error occurred while fetching weekly statistics.');
    } else {
      return await context.channel.send('An error occurred while fetching weekly statistics.');
    }
  }
}

client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) await reaction.fetch();

  const channel = reaction.message.channel;

  if (channel.name !== 'スーパーオートマトントラッカー') return;

  const userId = user.id;
  const guild = reaction.message.guild;
  const guildId = guild.id;
  const time = getJapanTime();

  try {
    switch (reaction.emoji.name) {
      case '☀️':
        await updateUserStatus(userId, guildId, '☀️', time, 'wakeup');
        const wakeMsg = await channel.send(`<@${userId}> woke up!`);
        setTimeout(() => wakeMsg.delete().catch(console.error), 30000);
        await handleStatusCommand({ guild: guild, channel: channel, user: user, member: await guild.members.fetch(userId), isChatInputCommand: () => false, isButton: () => false, replied: false, deferred: false, reply: async () => {}, followUp: async () => {} });
        break;

      case '🌙':
        await updateUserStatus(userId, guildId, '🌙', time, 'sleep');
        const sleepMsg = await channel.send(`<@${userId}> went to sleep!`);
        setTimeout(() => sleepMsg.delete().catch(console.error), 30000);
        await handleStatusCommand({ guild: guild, channel: channel, user: user, member: await guild.members.fetch(userId), isChatInputCommand: () => false, isButton: () => false, replied: false, deferred: false, reply: async () => {}, followUp: async () => {} });
        break;

      case '🌀':
        await db.run(
          'DELETE FROM sleep_records WHERE user_id = ? AND guild_id = ?',
          [userId, guildId]
        );
        const resetMsg = await channel.send(`<@${userId}>'s status has been reset.`);
        setTimeout(() => resetMsg.delete().catch(console.error), 30000);
        await handleStatusCommand({ guild: guild, channel: channel, user: user, member: await guild.members.fetch(userId), isChatInputCommand: () => false, isButton: () => false, replied: false, deferred: false, reply: async () => {}, followUp: async () => {} });
        break;

      case '🐻':
        const messages = await channel.messages.fetch({ limit: 20 });

        const statusMessages = messages.filter(msg =>
          msg.author.id === client.user.id && 
          msg.embeds.length > 0 &&
          msg.embeds[0].title === 'Current Status'
        );

        const statsMessages = messages.filter(msg =>
          msg.author.id === client.user.id && 
          msg.embeds.length > 0 &&
          msg.embeds[0].title === '🛌 Weekly Sleep Ranking'
        );

        for (const msg of statusMessages.values()) {
          await msg.delete().catch(console.error);
        }

        for (const msg of statsMessages.values()) {
          await msg.delete().catch(console.error);
        }

        const dummyInteractionForReaction = { guild: guild, channel: channel, user: user, member: await guild.members.fetch(userId), isChatInputCommand: () => false, isButton: () => false, replied: false, deferred: false, reply: async () => {}, followUp: async () => {} };
        await handleStatusCommand(dummyInteractionForReaction); 
        await handleWeeklyStats(dummyInteractionForReaction); 

        break;
    }
  } catch (error) {
    console.error('Reaction handling error:', error);
    const errorMsg = await channel.send('An error occurred.');
    setTimeout(() => errorMsg.delete().catch(console.error), 30000);
  }

  reaction.users.remove(user).catch(console.error);
});

client.login(process.env.DISCORD_TOKEN);
