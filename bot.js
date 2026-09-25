require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────
// ⚙️ CONFIG
// ─────────────────────────────────────────────
const CREATOR_NAME = 'Abhishek';
const CREATOR_TAG  = `🛠 Made with ❤️ by ${CREATOR_NAME}`;

const TOKEN = process.env.BOT_TOKEN || '8807389589:AAHH9jZHVmTPY99vu3gHXRaDVT4Mkk8FY6E';
if (!TOKEN || TOKEN === 'YOUR_BOT_TOKEN_HERE') {
  console.error('❌ Set your BOT_TOKEN in the .env file!');
  process.exit(1);
}

const bot = new Telegraf(TOKEN);

const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

// ─────────────────────────────────────────────
// 🍪 YOUTUBE COOKIES SETUP
// Set YOUTUBE_COOKIES env var on Render with base64 encoded cookies.txt
// ─────────────────────────────────────────────

const COOKIES_PATH = path.join(__dirname, 'cookies.txt');

if (!fs.existsSync(COOKIES_PATH) && process.env.YOUTUBE_COOKIES) {
  try {
    const cookiesData = Buffer.from(process.env.YOUTUBE_COOKIES, 'base64').toString('utf-8');
    fs.writeFileSync(COOKIES_PATH, cookiesData);
    console.log('🍪 YouTube cookies loaded from ENV!');
  } catch (e) {
    console.error('❌ Failed to load cookies:', e.message);
  }
}

// Store pending data per user: { url, formats }
const pendingDownloads = new Map();

// ─────────────────────────────────────────────
// 🔧 HELPERS
// ─────────────────────────────────────────────

function makeProgressBar(percent) {
  const filled = Math.floor(percent / 10);
  const empty  = 10 - filled;
  return '⬛'.repeat(filled) + '⬜'.repeat(empty) + `  ${percent}%`;
}

function detectPlatform(url) {
  if (url.includes('youtube.com') || url.includes('youtu.be')) return '🎬 YouTube';
  if (url.includes('instagram.com'))                            return '📸 Instagram';
  if (url.includes('twitter.com')  || url.includes('x.com'))   return '🐦 Twitter / X';
  if (url.includes('tiktok.com'))                               return '🎵 TikTok';
  if (url.includes('facebook.com') || url.includes('fb.watch')) return '📘 Facebook';
  return '🌐 Website';
}

function cleanupFile(filePath) {
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) {}
}

// ─────────────────────────────────────────────
// 🔍 FETCH AVAILABLE QUALITIES FROM VIDEO URL
// ─────────────────────────────────────────────

function fetchVideoInfo(url) {
  return new Promise((resolve, reject) => {
    const cookiesFlag = fs.existsSync(COOKIES_PATH) ? `--cookies "${COOKIES_PATH}"` : '';
    // yt-dlp -J gives us full JSON info including all available formats
    exec(`yt-dlp -J ${cookiesFlag} --extractor-args "youtube:player_client=mweb,android" --no-playlist "${url}"`, { timeout: 30000 }, (error, stdout, stderr) => {
      if (error) { reject(new Error(stderr || error.message)); return; }

      try {
        const info    = JSON.parse(stdout);
        const formats = info.formats || [];

        // Collect unique video heights that have both video + audio or are combined
        const seenHeights = new Set();
        const qualities   = [];

        formats.forEach(f => {
          // Only include formats that have video
          if (f.height && f.vcodec && f.vcodec !== 'none') {
            if (!seenHeights.has(f.height)) {
              seenHeights.add(f.height);
              qualities.push(f.height);
            }
          }
        });

        // Sort from highest to lowest quality
        qualities.sort((a, b) => b - a);

        resolve({
          title:     info.title     || 'Unknown Title',
          duration:  info.duration  || 0,
          uploader:  info.uploader  || 'Unknown',
          thumbnail: info.thumbnail || null,
          qualities,          // e.g. [1080, 720, 480, 360, 240, 144]
        });

      } catch (e) {
        reject(new Error('Could not read video info.'));
      }
    });
  });
}

// ─────────────────────────────────────────────
// 🎬 YOUTUBE DOWNLOAD — Cloud Bypass Trick
// Uses android player client to avoid bot detection
// ─────────────────────────────────────────────

function downloadYouTube(url, outputPath, quality) {
  return new Promise((resolve, reject) => {
    // Use cookies if available
    const cookiesFlag = fs.existsSync(COOKIES_PATH) ? `--cookies "${COOKIES_PATH}"` : '';
    let cmd;

    if (quality === 'mp3') {
      cmd = `yt-dlp -x --audio-format mp3 --no-playlist \
        ${cookiesFlag} \
        --extractor-args "youtube:player_client=mweb,android" \
        -o "${outputPath}.mp3" "${url}"`;
    } else {
      const fmt = `bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]/best`;
      cmd = `yt-dlp -f "${fmt}" --no-playlist --merge-output-format mp4 \
        ${cookiesFlag} \
        --extractor-args "youtube:player_client=mweb,android" \
        -o "${outputPath}.mp4" "${url}"`;
    }

    exec(cmd, { timeout: 300000 }, (error, stdout, stderr) => {
      if (error) {
        const errLines = (stderr || '')
          .split('\n')
          .filter(l => l.includes('ERROR:'))
          .join('\n');
        reject(new Error(errLines || error.message));
        return;
      }

      const ext      = quality === 'mp3' ? 'mp3' : 'mp4';
      const filePath = `${outputPath}.${ext}`;

      if (fs.existsSync(filePath)) {
        resolve(filePath);
      } else {
        const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith(path.basename(outputPath)));
        if (files.length > 0) resolve(path.join(DOWNLOAD_DIR, files[0]));
        else reject(new Error('Downloaded file not found.'));
      }
    });
  });
}

function findDownloadedFiles(outputPath) {
  const baseName = path.basename(outputPath);
  const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith(baseName));
  return files.map(f => path.join(DOWNLOAD_DIR, f));
}

function downloadMedia(url, outputPath, quality) {
  return new Promise((resolve, reject) => {
    let cmd;

    if (quality === 'mp3') {
      cmd = `yt-dlp -x --audio-format mp3 --no-playlist -o "${outputPath}.mp3" "${url}"`;
    } else {
      const fmt = `bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]/best`;
      cmd = `yt-dlp -f "${fmt}" --no-playlist --merge-output-format mp4 -o "${outputPath}.mp4" "${url}"`;
    }

    exec(cmd, { timeout: 300000 }, (error, stdout, stderr) => {
      if (error) {
        const errStr = (stderr || error.message || '').toLowerCase();
        // Fallback for Instagram Photos / Carousels / Slides
        if (errStr.includes('no video formats') || errStr.includes('requested format is not available') || errStr.includes('no video')) {
          const fallbackCmd = `yt-dlp --no-playlist -o "${outputPath}_%(autonumber)s.%(ext)s" "${url}"`;
          exec(fallbackCmd, { timeout: 300000 }, (err2, stdout2, stderr2) => {
            if (err2) {
              const singleCmd = `yt-dlp --no-playlist -o "${outputPath}.%(ext)s" "${url}"`;
              exec(singleCmd, { timeout: 300000 }, (err3, stdout3, stderr3) => {
                if (err3) { reject(new Error(stderr2 || err2.message)); return; }
                const files = findDownloadedFiles(outputPath);
                if (files.length > 0) resolve(files);
                else reject(new Error('Downloaded file not found.'));
              });
              return;
            }
            const files = findDownloadedFiles(outputPath);
            if (files.length > 0) resolve(files);
            else reject(new Error('Downloaded file not found.'));
          });
          return;
        }
        reject(new Error(stderr || error.message));
        return;
      }

      const files = findDownloadedFiles(outputPath);
      if (files.length > 0) resolve(files);
      else reject(new Error('Downloaded file not found.'));
    });
  });
}

// ─────────────────────────────────────────────
// 📋 SET TELEGRAM COMMANDS MENU
// ─────────────────────────────────────────────

bot.telegram.setMyCommands([
  { command: 'start', description: '🏠 Start the bot'       },
  { command: 'help',  description: '📖 How to use this bot' },
  { command: 'about', description: 'ℹ️ About & Credits'      },
]).catch(err => console.error('setMyCommands error:', err.message));

// ─────────────────────────────────────────────
// ⌨️ PERSISTENT BOTTOM KEYBOARD
// Always visible at bottom of chat!
// ─────────────────────────────────────────────

const mainKeyboard = Markup.keyboard([
  ['🏠 Home',          '📖 Help'],
  ['ℹ️ About',         '📥 How to Download'],
]).resize().persistent();

// ─────────────────────────────────────────────
// 🤖 /start — Welcome Message
// ─────────────────────────────────────────────

bot.start(async (ctx) => {
  const name = ctx.from.first_name;

  // Try local welcome GIF first, else skip
  const localGif = path.join(__dirname, 'welcome.gif');
  if (fs.existsSync(localGif)) {
    try { await ctx.replyWithAnimation({ source: localGif }); } catch (e) {}
  }

  await ctx.replyWithMarkdown(
    `╔══════════════════════╗\n` +
    `     🎬 *Video Downloader Bot*\n` +
    `╚══════════════════════╝\n\n` +
    `👋 Hey *${name}*! Welcome!\n\n` +
    `📥 *What I can do:*\n` +
    `　🎬 Download YouTube videos\n` +
    `　📸 Download Instagram Reels\n` +
    `　🎵 Download TikTok videos\n` +
    `　🐦 Download Twitter / X videos\n` +
    `　🎵 Extract MP3 audio from any video\n\n` +
    `📌 *Just paste any video link below!* 👇\n\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `${CREATOR_TAG}`,
    mainKeyboard
  );
});

// ─────────────────────────────────────────────
// ℹ️ /about
// ─────────────────────────────────────────────

bot.command('about', (ctx) => {
  ctx.replyWithMarkdown(
    `ℹ️ *About This Bot*\n\n` +
    `Built with 💪 by *${CREATOR_NAME}*\n\n` +
    `⚙️ *Tech Stack:*\n` +
    `　• Node.js\n` +
    `　• Telegraf Framework\n` +
    `　• yt-dlp Download Engine\n` +
    `　• ffmpeg\n\n` +
    `🌐 *Supported Sites:*\n` +
    `YouTube, Instagram, TikTok,\n` +
    `Twitter/X, Facebook & 1000+ more!\n\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `${CREATOR_TAG}`
  );
});

// ─────────────────────────────────────────────
// 📖 /help
// ─────────────────────────────────────────────

bot.help((ctx) => {
  ctx.replyWithMarkdown(
    `📖 *How To Use:*\n\n` +
    `1️⃣ Copy any video link\n` +
    `2️⃣ Paste it in this chat\n` +
    `3️⃣ Bot fetches all available qualities\n` +
    `4️⃣ Pick your quality or MP3\n` +
    `5️⃣ Wait for download ⏳\n` +
    `6️⃣ Video arrives in your chat! 🎉\n\n` +
    `📌 *Commands:*\n` +
    `/start - Start the bot\n` +
    `/help - Show this message\n` +
    `/about - About & credits\n\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `${CREATOR_TAG}`
  );
});

// ─────────────────────────────────────────────
// ⌨️ KEYBOARD BUTTON HANDLERS
// ─────────────────────────────────────────────

bot.hears('🏠 Home', async (ctx) => {
  const name = ctx.from.first_name;
  await ctx.replyWithMarkdown(
    `👋 Hey *${name}*!\n\n` +
    `📌 Just paste any video link below and I'll download it!\n\n` +
    `Supported: YouTube, Instagram, TikTok, Twitter & more 🎬\n\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `${CREATOR_TAG}`,
    mainKeyboard
  );
});

bot.hears('📖 Help', (ctx) => {
  ctx.replyWithMarkdown(
    `📖 *How To Use:*\n\n` +
    `1️⃣ Copy any video link\n` +
    `2️⃣ Paste it in this chat\n` +
    `3️⃣ Bot fetches all available qualities\n` +
    `4️⃣ Pick your quality or MP3\n` +
    `5️⃣ Wait for download ⏳\n` +
    `6️⃣ Video arrives in your chat! 🎉\n\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `${CREATOR_TAG}`,
    mainKeyboard
  );
});

bot.hears('ℹ️ About', (ctx) => {
  ctx.replyWithMarkdown(
    `ℹ️ *About This Bot*\n\n` +
    `Built with 💪 by *${CREATOR_NAME}*\n\n` +
    `⚙️ *Tech Stack:*\n` +
    `　• Node.js\n` +
    `　• Telegraf Framework\n` +
    `　• yt-dlp Download Engine\n` +
    `　• ffmpeg\n\n` +
    `🌐 *Supported Sites:*\n` +
    `YouTube, Instagram, TikTok,\n` +
    `Twitter/X, Facebook & 1000+ more!\n\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `${CREATOR_TAG}`,
    mainKeyboard
  );
});

bot.hears('📥 How to Download', (ctx) => {
  ctx.replyWithMarkdown(
    `📥 *Download Steps:*\n\n` +
    `*Step 1* → Go to YouTube / Instagram\n` +
    `*Step 2* → Open any video\n` +
    `*Step 3* → Copy the link from browser\n` +
    `*Step 4* → Come back here & paste it\n` +
    `*Step 5* → Choose quality 📊\n` +
    `*Step 6* → Download arrives! 🎉\n\n` +
    `*Example links:*\n` +
    `\`https://youtube.com/watch?v=...\`\n` +
    `\`https://instagram.com/reel/...\`\n` +
    `\`https://tiktok.com/@user/video/...\`\n\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `${CREATOR_TAG}`,
    mainKeyboard
  );
});

// ─────────────────────────────────────────────
// 🔗 HANDLE VIDEO LINK
// ─────────────────────────────────────────────

// Keyboard button texts — skip these in URL handler
const KEYBOARD_TEXTS = ['🏠 Home', '📖 Help', 'ℹ️ About', '📥 How to Download'];

bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;           // ignore commands
  if (KEYBOARD_TEXTS.includes(text)) return;  // ignore keyboard buttons


  // Validate URL
  try { new URL(text); } catch {
    await ctx.reply('⚠️ Please send a valid video URL!\n\nExample:\nhttps://youtube.com/watch?v=...');
    return;
  }

  const platform = detectPlatform(text);

  // Show "fetching info" message
  const infoMsg = await ctx.replyWithMarkdown(
    `🔍 *Fetching video info...*\n\n` +
    `📌 Platform: ${platform}\n` +
    `_Please wait a moment..._`
  );

  try {
    // ⬇️ Get all available qualities from the URL
    const videoInfo = await fetchVideoInfo(text);
    const { title, duration, uploader, qualities } = videoInfo;

    // Format duration as mm:ss
    const mins = Math.floor(duration / 60);
    const secs = duration % 60;
    const durationStr = duration > 0 ? `${mins}:${secs.toString().padStart(2, '0')}` : 'N/A';

    // Save for later when user picks quality
    pendingDownloads.set(ctx.from.id, { url: text, qualities });

    // ─── Build dynamic quality buttons ───
    // Map each quality height to a button row
    const qualityButtons = qualities.map(h => {
      let label = `📹 ${h}p`;
      if (h >= 2160) label = `🔵 4K (${h}p)`;
      else if (h >= 1440) label = `🟣 2K (${h}p)`;
      else if (h >= 1080) label = `🔴 Full HD (${h}p)`;
      else if (h >= 720)  label = `🟡 HD (${h}p)`;
      else if (h >= 480)  label = `🟢 ${h}p`;
      else                label = `⚪ ${h}p`;
      return [Markup.button.callback(label, `q_${h}`)];
    });

    // Add MP3 and Cancel buttons
    qualityButtons.push([Markup.button.callback('🎵 MP3 — Audio Only', 'q_mp3')]);
    qualityButtons.push([Markup.button.callback('❌ Cancel', 'q_cancel')]);

    // Edit the "fetching" message with video info + quality buttons
    await ctx.telegram.editMessageText(
      ctx.chat.id, infoMsg.message_id, null,
      `✅ *Video Found!*\n\n` +
      `🎬 *Title:* ${title.substring(0, 60)}${title.length > 60 ? '...' : ''}\n` +
      `👤 *By:* ${uploader}\n` +
      `⏱ *Duration:* ${durationStr}\n` +
      `📌 *Platform:* ${platform}\n\n` +
      `*👇 Choose quality to download:*`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(qualityButtons),
      }
    );

  } catch (err) {
    console.error('Info fetch error:', err.message);

    // If fetching info fails, fall back to fixed quality buttons
    pendingDownloads.set(ctx.from.id, { url: text, qualities: null });

    await ctx.telegram.editMessageText(
      ctx.chat.id, infoMsg.message_id, null,
      `✅ *Link received!*\n` +
      `📌 Platform: ${platform}\n\n` +
      `*👇 Choose quality:*`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('📱 360p',  'q_360'),
            Markup.button.callback('💻 720p',  'q_720'),
            Markup.button.callback('🖥 1080p', 'q_1080'),
          ],
          [Markup.button.callback('🎵 MP3 — Audio Only', 'q_mp3')],
          [Markup.button.callback('❌ Cancel', 'q_cancel')],
        ]),
      }
    );
  }
});

// ─────────────────────────────────────────────
// 🎛 PROCESS DOWNLOAD AFTER QUALITY SELECTED
// ─────────────────────────────────────────────

async function processDownload(ctx, quality) {
  await ctx.answerCbQuery('⏳ Starting download...');

  const userId = ctx.from.id;
  const data   = pendingDownloads.get(userId);

  if (!data) {
    return ctx.editMessageText('❌ Session expired. Please send the link again.');
  }

  const { url } = data;
  pendingDownloads.delete(userId);

  const platform     = detectPlatform(url);
  const qualityLabel = quality === 'mp3' ? '🎵 MP3 Audio' : `📹 ${quality}p`;
  const timestamp    = Date.now();
  const outputPath   = path.join(DOWNLOAD_DIR, `file_${timestamp}`);
  const chatId       = ctx.chat.id;
  const msgId        = ctx.callbackQuery.message.message_id;

  // Show initial progress
  await ctx.editMessageText(
    `⏳ Downloading...\n\n` +
    `📌 Platform: ${platform}\n` +
    `📊 Quality: ${qualityLabel}\n\n` +
    `${makeProgressBar(0)}\n\nStarting...`
  );

  // Animate progress while real download happens
  const progressSteps = [10, 20, 35, 50, 65, 78, 90];
  let stepIndex = 0;

  const progressTimer = setInterval(async () => {
    if (stepIndex < progressSteps.length) {
      const pct = progressSteps[stepIndex++];
      try {
        await ctx.telegram.editMessageText(chatId, msgId, null,
          `⏳ Downloading...\n\n` +
          `📌 Platform: ${platform}\n` +
          `📊 Quality: ${qualityLabel}\n\n` +
          `${makeProgressBar(pct)}\n\nPlease wait...`
        );
      } catch (e) {}
    }
  }, 2500);

  try {
    const isYouTube = url.includes('youtube.com') || url.includes('youtu.be');
    let result;

    if (isYouTube) {
      // 🎬 YouTube → android client bypass
      result = await downloadYouTube(url, outputPath, quality);
    } else {
      // 📱 Instagram, TikTok, Twitter etc. → yt-dlp (with photo fallback)
      result = await downloadMedia(url, outputPath, quality);
    }

    const fileList = Array.isArray(result) ? result : [result];
    clearInterval(progressTimer);

    if (fileList.length === 0) {
      throw new Error('Downloaded file not found.');
    }

    // Show 100%
    await ctx.telegram.editMessageText(chatId, msgId, null,
      `✅ Done!\n\n` +
      `${makeProgressBar(100)}\n\n` +
      `📤 Sending your media...`
    );

    for (const filePath of fileList) {
      const ext = path.extname(filePath).toLowerCase();
      const stats = fs.statSync(filePath);
      const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);

      if (stats.size > 50 * 1024 * 1024) {
        cleanupFile(filePath);
        await ctx.reply(`❌ File too large! (${sizeMB}MB)\nTelegram max limit is 50MB.`);
        continue;
      }

      const caption =
        quality === 'mp3' || ['.mp3', '.m4a', '.aac'].includes(ext)
          ? `🎵 *Audio Downloaded!*\n\n📊 Format: MP3\n\n━━━━━━━━━━━━━━━━━━━\n${CREATOR_TAG}`
          : ['.jpg', '.jpeg', '.png', '.webp'].includes(ext)
            ? `📸 *Photo Downloaded!*\n\n📌 Platform: ${platform}\n💾 Size: ${sizeMB}MB\n\n━━━━━━━━━━━━━━━━━━━\n${CREATOR_TAG}`
            : `🎬 *Video Downloaded!*\n\n📌 Platform: ${platform}\n📊 Quality: ${qualityLabel}\n💾 Size: ${sizeMB}MB\n\n━━━━━━━━━━━━━━━━━━━\n${CREATOR_TAG}`;

      if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
        await ctx.replyWithPhoto({ source: filePath }, { caption, parse_mode: 'Markdown' });
      } else if (quality === 'mp3' || ['.mp3', '.m4a', '.aac'].includes(ext)) {
        await ctx.replyWithAudio({ source: filePath }, { caption, parse_mode: 'Markdown' });
      } else {
        await ctx.replyWithVideo({ source: filePath }, { caption, parse_mode: 'Markdown', supports_streaming: true });
      }

      cleanupFile(filePath);
    }

    ctx.telegram.deleteMessage(chatId, msgId).catch(() => {});

  } catch (err) {
    clearInterval(progressTimer);
    console.error('Download error:', err.message);

    let errMsg = '❌ Download Failed!\n\n';
    if (err.message.includes('private'))        errMsg += 'This content is private.';
    else if (err.message.includes('login'))     errMsg += 'This content requires login.';
    else if (err.message.includes('available')) errMsg += 'Not available in your region.';
    else errMsg += `Reason: ${err.message.substring(0, 120)}`;

    ctx.telegram.editMessageText(chatId, msgId, null, errMsg).catch(() => ctx.reply(errMsg));
  }
}

// ─────────────────────────────────────────────
// 🔘 BUTTON ACTIONS — Dynamic quality heights
// ─────────────────────────────────────────────

// Handle any quality button like q_144, q_360, q_720, q_1080, q_1440, q_2160
bot.action(/^q_(\d+)$/, (ctx) => {
  const quality = ctx.match[1]; // e.g. "720"
  return processDownload(ctx, quality);
});

bot.action('q_mp3', (ctx) => processDownload(ctx, 'mp3'));

bot.action('q_cancel', async (ctx) => {
  await ctx.answerCbQuery('Cancelled!');
  pendingDownloads.delete(ctx.from.id);
  await ctx.editMessageText('❌ Download cancelled.');
});

// ─────────────────────────────────────────────
// 🌐 HTTP SERVER (Required for Render hosting)
// ─────────────────────────────────────────────

const http = require('http');
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`🤖 Video Downloader Bot is LIVE!\n🛠 Made by ${CREATOR_NAME}\n✅ Status: Running`);
});

server.listen(PORT, () => {
  console.log(`🌐 Health server running on port ${PORT}`);
});

// ─────────────────────────────────────────────
// 🚀 LAUNCH
// ─────────────────────────────────────────────

// Catch any unhandled promise rejections — prevents crash
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled Rejection:', reason);
});

bot.launch()
  .then(() => console.log('✅ Bot polling started!'))
  .catch(err => console.error('❌ Bot launch error:', err.message));

console.log('🤖 Video Downloader Bot is LIVE!');
console.log(`🛠️  Made by ${CREATOR_NAME}`);
console.log('📥 Supports: YouTube, Instagram, TikTok, Twitter & 1000+ sites!');
console.log('⏹  Press Ctrl+C to stop.\n');

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
