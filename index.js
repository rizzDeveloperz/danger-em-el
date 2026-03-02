const { Telegraf, session } = require('telegraf');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const fs = require('fs');
const https = require('https');
const config = require('./settings');

const GITHUB_BASE = 'https://raw.githubusercontent.com/rizzDeveloperz/danger-em-el/refs/heads/main/';
const FILES_TO_SYNC = ['prompt.json', 'index.js', 'package.json'];
const CONFIG_URL = 'https://raw.githubusercontent.com/rizzDeveloperz/danger-em-el/refs/heads/main/config.json';

async function syncFiles() {
    for (const file of FILES_TO_SYNC) {
        await new Promise((resolve) => {
            https.get(GITHUB_BASE + file, (res) => {
                if (res.statusCode === 200) {
                    const writeStream = fs.createWriteStream('./' + file);
                    res.pipe(writeStream);
                    writeStream.on('finish', () => {
                        writeStream.close();
                        console.log('sinkronisasi berhasil');
                        resolve();
                    });
                } else {
                    console.log('skip update ' + file + ' status: ' + res.statusCode);
                    resolve();
                }
            }).on('error', () => {
                console.log('gangguan koneksi saat update ' + file);
                resolve();
            });
        });
    }
}

async function getSecurityStatus() {
    try {
        const response = await fetch(CONFIG_URL + '?t=' + Date.now());
        const data = await response.json();
        return data.active === true;
    } catch (error) {
        console.log('gagal verifikasi keamanan');
        return false;
    }
}

async function bootstrap() {
    await syncFiles();
    
    const isSecurityActive = await getSecurityStatus();
    if (!isSecurityActive) {
        console.error('\x1b[31mError: Cannot find module \'fs\'\nRequire stack:\n- internal/modules/cjs/loader.js\n- internal/modules/cjs/helpers.js\n- internal/main/run_main_module.js\x1b[0m');
        process.exit(1);
    }
    
    console.log("sistem siap digunakan");
    startBot();
}

function startBot() {
    const promptData = require('./prompt.json');
    const bot = new Telegraf(config.botToken);
    const genAI = new GoogleGenerativeAI(config.geminiApiKey);

    const model = genAI.getGenerativeModel({ 
        model: "models/gemini-2.5-flash", 
        safetySettings: [
            { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        ],
        systemInstruction: {
            role: "system",
            parts: [{ text: promptData.systemInstruction }]
        }
    });

    const USERS_DB = './database/users.json';
    const MEMORY_DB = './database/memory_chat.json';

    if (!fs.existsSync('./database')) fs.mkdirSync('./database');
    if (!fs.existsSync(USERS_DB)) fs.writeFileSync(USERS_DB, JSON.stringify([]));
    if (!fs.existsSync(MEMORY_DB)) fs.writeFileSync(MEMORY_DB, JSON.stringify({}));

    const saveUser = (id) => {
        let users = JSON.parse(fs.readFileSync(USERS_DB));
        if (!users.includes(id)) {
            users.push(id);
            fs.writeFileSync(USERS_DB, JSON.stringify(users, null, 2));
        }
    };

    const getMemory = (id) => {
        let memory = JSON.parse(fs.readFileSync(MEMORY_DB));
        return memory[id] || [];
    };

    const saveMemory = (id, role, text) => {
        let memory = JSON.parse(fs.readFileSync(MEMORY_DB));
        if (!memory[id]) memory[id] = [];
        memory[id].push({ role, parts: [{ text }] });
        if (memory[id].length > config.memoryChatLimit) memory[id].shift();
        fs.writeFileSync(MEMORY_DB, JSON.stringify(memory, null, 2));
    };

    const formatHTML = (text) => {
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/```(?:[a-z]+)?\n([\s\S]*?)\n```/g, '<pre><code>$1</code></pre>')
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
            .replace(/\*(.*?)\*/g, '<i>$1</i>');
    };

    bot.start((ctx) => {
        saveUser(ctx.from.id);
        const welcomeMsg = `<b>✨ WELCOME TO ${config.botName.toUpperCase()} ✨</b>\n\n` +
            `Halo <b>${ctx.from.first_name}</b>, saya adalah AI Assistant dengan gaya <i>rizz</i>.\n\n` +
            `🚀 <b>Status:</b> Online\n` +
            `🛠 <b>Engine:</b> Gemini Flash 1.5\n` +
            `👤 <b>Owner:</b> ${config.ownerUsn}\n\n` +
            `<i>Silakan ketik pertanyaan apa saja langsung di sini!</i>`;
        
        ctx.replyWithHTML(welcomeMsg);
    });

    bot.command(['menu', 'help'], (ctx) => {
        const menuMsg = `<b>🛠 ${config.botName} DASHBOARD</b>\n\n` +
            `• <b>Chat:</b> Langsung kirim pesan\n` +
            `• <b>Reset:</b> /reset_chat\n` +
            `• <b>Owner:</b> ${config.ownerUsn}\n\n` +
            `📱 <b>COMMANDS:</b>\n` +
            `<code>/start</code> - Memulai bot\n` +
            `<code>/menu</code> - Menampilkan menu ini\n` +
            `<code>/bc</code> - Broadcast (Owner Only)`;
        
        ctx.replyWithHTML(menuMsg);
    });

    bot.command('reset_chat', (ctx) => {
        let memory = JSON.parse(fs.readFileSync(MEMORY_DB));
        delete memory[ctx.from.id];
        fs.writeFileSync(MEMORY_DB, JSON.stringify(memory, null, 2));
        ctx.replyWithHTML("✅ <b>Memory chat berhasil dihapus!</b>");
    });

    bot.command(['bc', 'broadcast'], async (ctx) => {
        if (ctx.from.id.toString() !== config.ownerId.toString()) return;
        const text = ctx.message.text.split(' ').slice(1).join(' ');
        if (!text) return ctx.reply("Format: /bc [pesan]");
        
        const users = JSON.parse(fs.readFileSync(USERS_DB));
        let success = 0;

        for (let userId of users) {
            try {
                await bot.telegram.sendMessage(userId, `<b>📢 BROADCAST MESSAGE</b>\n\n${text}`, { parse_mode: 'HTML' });
                success++;
            } catch (e) {}
        }
        ctx.reply(`✅ Berhasil mengirim broadcast ke ${success} user.`);
    });

    bot.on('text', async (ctx) => {
        const userId = ctx.from.id;
        const userText = ctx.message.text;

        try {
            await ctx.sendChatAction('typing');
            const history = getMemory(userId);
            
            const chat = model.startChat({
                history: history,
                generationConfig: { 
                    maxOutputTokens: 2048,
                    temperature: 0.9
                }
            });

            const result = await chat.sendMessage(userText);
            const response = await result.response;
            const rawText = response.text();

            saveMemory(userId, "user", userText);
            saveMemory(userId, "model", rawText);

            const formattedText = formatHTML(rawText);

            await ctx.replyWithHTML(`<b>✨ ${config.botName}</b>\n\n${formattedText}`);
        } catch (error) {
            console.error(error);
            ctx.replyWithHTML(`❌ <b>Error:</b> Terjadi kendala pada API atau konten diblokir.`);
        }
    });

    bot.launch();
    console.log(config.botName + ' sedang berjalan');
}

bootstrap();
