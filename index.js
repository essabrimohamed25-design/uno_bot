const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config();

// ============================================
// DATABASE SETUP
// ============================================
const db = new sqlite3.Database('./uno_stats.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS stats (user_id TEXT PRIMARY KEY, wins INTEGER DEFAULT 0, games INTEGER DEFAULT 0, cards_played INTEGER DEFAULT 0)`);
});

// ============================================
// CONFIGURATION
// ============================================
const { BOT_TOKEN } = process.env;
if (!BOT_TOKEN) { console.error('❌ Missing BOT_TOKEN'); process.exit(1); }

const COLORS = {
    RED: '🔴',
    BLUE: '🔵',
    GREEN: '🟢',
    YELLOW: '🟡',
    WILD: '🌈'
};

const CARD_TYPES = {
    NUMBER: 'number',
    SKIP: 'skip',
    REVERSE: 'reverse',
    DRAW_TWO: 'draw2',
    WILD: 'wild',
    WILD_DRAW_FOUR: 'wild4'
};

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// ============================================
// GAME STORAGE
// ============================================
const activeGames = new Map();
const cooldowns = new Map();

// ============================================
// CARD DECK
// ============================================
function createDeck() {
    const deck = [];
    const colors = ['red', 'blue', 'green', 'yellow'];
    
    // Number cards 0-9
    for (const color of colors) {
        for (let i = 0; i <= 9; i++) {
            const count = i === 0 ? 1 : 2;
            for (let j = 0; j < count; j++) {
                deck.push({ type: CARD_TYPES.NUMBER, color, value: i, emoji: getCardEmoji(color, i) });
            }
        }
    }
    
    // Action cards (skip, reverse, draw two)
    for (const color of colors) {
        for (let i = 0; i < 2; i++) {
            deck.push({ type: CARD_TYPES.SKIP, color, value: 'skip', emoji: getActionEmoji('skip', color) });
            deck.push({ type: CARD_TYPES.REVERSE, color, value: 'reverse', emoji: getActionEmoji('reverse', color) });
            deck.push({ type: CARD_TYPES.DRAW_TWO, color, value: 'draw2', emoji: getActionEmoji('draw2', color) });
        }
    }
    
    // Wild cards
    for (let i = 0; i < 4; i++) {
        deck.push({ type: CARD_TYPES.WILD, color: 'wild', value: 'wild', emoji: '🌈 Wild' });
        deck.push({ type: CARD_TYPES.WILD_DRAW_FOUR, color: 'wild', value: 'wild4', emoji: '🌈 Wild Draw 4' });
    }
    
    return shuffle(deck);
}

function shuffle(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function getCardEmoji(color, value) {
    const emojis = { red: '🔴', blue: '🔵', green: '🟢', yellow: '🟡' };
    return `${emojis[color]} ${value}`;
}

function getActionEmoji(action, color) {
    const emojis = { red: '🔴', blue: '🔵', green: '🟢', yellow: '🟡' };
    const actionEmojis = { skip: '🚫', reverse: '🔄', draw2: '➕2' };
    return `${emojis[color]} ${actionEmojis[action]}`;
}

function cardToString(card) {
    if (card.type === CARD_TYPES.NUMBER) return `${card.emoji}`;
    if (card.type === CARD_TYPES.SKIP) return `${card.emoji} Skip`;
    if (card.type === CARD_TYPES.REVERSE) return `${card.emoji} Reverse`;
    if (card.type === CARD_TYPES.DRAW_TWO) return `${card.emoji} Draw 2`;
    if (card.type === CARD_TYPES.WILD) return `🌈 Wild`;
    if (card.type === CARD_TYPES.WILD_DRAW_FOUR) return `🌈 Wild Draw 4`;
    return card.emoji;
}

function canPlay(card, topCard) {
    if (card.type === CARD_TYPES.WILD || card.type === CARD_TYPES.WILD_DRAW_FOUR) return true;
    if (card.color === topCard.color) return true;
    if (card.type === topCard.type && card.value === topCard.value) return true;
    return false;
}

function getCardValue(card) {
    if (card.type === CARD_TYPES.SKIP) return { color: card.color, value: 'skip' };
    if (card.type === CARD_TYPES.REVERSE) return { color: card.color, value: 'reverse' };
    if (card.type === CARD_TYPES.DRAW_TWO) return { color: card.color, value: 'draw2' };
    return { color: card.color, value: card.value };
}

// ============================================
// GAME CLASS
// ============================================
class UnoGame {
    constructor(channelId, hostId) {
        this.channelId = channelId;
        this.players = [{ id: hostId, cards: [], unoCalled: false, left: false }];
        this.deck = [];
        this.discardPile = [];
        this.currentPlayerIndex = 0;
        this.direction = 1;
        this.started = false;
        this.drawStack = 0;
        this.lastPlayTime = Date.now();
        this.winner = null;
    }
    
    addPlayer(userId) {
        if (this.players.some(p => p.id === userId)) return false;
        if (this.players.length >= 10) return false;
        this.players.push({ id: userId, cards: [], unoCalled: false, left: false });
        return true;
    }
    
    removePlayer(userId) {
        const index = this.players.findIndex(p => p.id === userId);
        if (index === -1) return false;
        this.players[index].left = true;
        if (this.started && this.players.filter(p => !p.left).length === 1) {
            this.endGame(this.players.find(p => !p.left).id);
        }
        return true;
    }
    
    startGame() {
        if (this.started) return false;
        if (this.players.length < 2) return false;
        
        this.deck = createDeck();
        for (const player of this.players) {
            for (let i = 0; i < 7; i++) {
                player.cards.push(this.deck.pop());
            }
        }
        
        let firstCard = this.deck.pop();
        while (firstCard.type === CARD_TYPES.WILD || firstCard.type === CARD_TYPES.WILD_DRAW_FOUR) {
            this.deck.unshift(firstCard);
            firstCard = this.deck.pop();
        }
        this.discardPile.push(firstCard);
        
        this.started = true;
        return true;
    }
    
    playCard(playerId, cardIndex) {
        const player = this.players.find(p => p.id === playerId);
        if (!player || player.left) return { success: false, error: 'Not your turn or not in game' };
        if (this.players[this.currentPlayerIndex].id !== playerId) return { success: false, error: 'Not your turn!' };
        if (cardIndex >= player.cards.length) return { success: false, error: 'Invalid card' };
        
        const card = player.cards[cardIndex];
        const topCard = this.discardPile[this.discardPile.length - 1];
        
        if (!canPlay(card, topCard)) return { success: false, error: 'You cannot play that card!' };
        
        player.cards.splice(cardIndex, 1);
        this.discardPile.push(card);
        
        let drawAmount = 0;
        let skipNext = false;
        let reverse = false;
        
        if (card.type === CARD_TYPES.SKIP) {
            skipNext = true;
        } else if (card.type === CARD_TYPES.REVERSE) {
            if (this.players.filter(p => !p.left).length === 2) skipNext = true;
            else reverse = true;
        } else if (card.type === CARD_TYPES.DRAW_TWO) {
            drawAmount = 2;
            skipNext = true;
        } else if (card.type === CARD_TYPES.WILD_DRAW_FOUR) {
            drawAmount = 4;
            skipNext = true;
        }
        
        if (reverse) this.direction *= -1;
        
        let nextIndex = this.currentPlayerIndex + this.direction;
        if (nextIndex >= this.players.length) nextIndex = 0;
        if (nextIndex < 0) nextIndex = this.players.length - 1;
        
        while (this.players[nextIndex]?.left) {
            nextIndex += this.direction;
            if (nextIndex >= this.players.length) nextIndex = 0;
            if (nextIndex < 0) nextIndex = this.players.length - 1;
        }
        
        if (skipNext) {
            this.currentPlayerIndex = nextIndex + this.direction;
            if (this.currentPlayerIndex >= this.players.length) this.currentPlayerIndex = 0;
            if (this.currentPlayerIndex < 0) this.currentPlayerIndex = this.players.length - 1;
            
            while (this.players[this.currentPlayerIndex]?.left) {
                this.currentPlayerIndex += this.direction;
                if (this.currentPlayerIndex >= this.players.length) this.currentPlayerIndex = 0;
                if (this.currentPlayerIndex < 0) this.currentPlayerIndex = this.players.length - 1;
            }
        } else {
            this.currentPlayerIndex = nextIndex;
        }
        
        if (drawAmount > 0) {
            this.drawStack += drawAmount;
            const nextPlayer = this.players[this.currentPlayerIndex];
            if (nextPlayer && !nextPlayer.left) {
                for (let i = 0; i < this.drawStack; i++) {
                    if (this.deck.length === 0) this.reshuffle();
                    nextPlayer.cards.push(this.deck.pop());
                }
                this.drawStack = 0;
                this.currentPlayerIndex += this.direction;
                if (this.currentPlayerIndex >= this.players.length) this.currentPlayerIndex = 0;
                if (this.currentPlayerIndex < 0) this.currentPlayerIndex = this.players.length - 1;
            }
        }
        
        if (player.cards.length === 0) {
            this.endGame(playerId);
            return { success: true, gameEnded: true, winner: playerId };
        }
        
        player.unoCalled = false;
        return { success: true, drawAmount, skipNext, reverse };
    }
    
    drawCard(playerId) {
        const player = this.players.find(p => p.id === playerId);
        if (!player || player.left) return { success: false, error: 'Not in game' };
        if (this.players[this.currentPlayerIndex].id !== playerId) return { success: false, error: 'Not your turn!' };
        
        if (this.deck.length === 0) this.reshuffle();
        const card = this.deck.pop();
        player.cards.push(card);
        
        return { success: true, card };
    }
    
    reshuffle() {
        if (this.discardPile.length <= 1) return;
        const topCard = this.discardPile.pop();
        this.deck = shuffle([...this.discardPile]);
        this.discardPile = [topCard];
    }
    
    callUno(playerId) {
        const player = this.players.find(p => p.id === playerId);
        if (!player || player.left) return { success: false, error: 'Not in game' };
        if (player.cards.length !== 1) return { success: false, error: 'You can only call UNO when you have 1 card!' };
        if (player.unoCalled) return { success: false, error: 'You already called UNO!' };
        
        player.unoCalled = true;
        return { success: true };
    }
    
    endGame(winnerId) {
        this.winner = winnerId;
        this.started = false;
        
        db.get(`SELECT * FROM stats WHERE user_id = ?`, [winnerId], (err, row) => {
            if (row) {
                db.run(`UPDATE stats SET wins = wins + 1, games = games + 1 WHERE user_id = ?`, [winnerId]);
            } else {
                db.run(`INSERT INTO stats (user_id, wins, games) VALUES (?, 1, 1)`, [winnerId]);
            }
        });
        
        for (const player of this.players) {
            if (player.id !== winnerId && !player.left) {
                db.get(`SELECT * FROM stats WHERE user_id = ?`, [player.id], (err, row) => {
                    if (row) {
                        db.run(`UPDATE stats SET games = games + 1 WHERE user_id = ?`, [player.id]);
                    } else {
                        db.run(`INSERT INTO stats (user_id, wins, games) VALUES (?, 0, 1)`, [player.id]);
                    }
                });
            }
        }
        
        return true;
    }
    
    getGameState() {
        const currentPlayer = this.players[this.currentPlayerIndex];
        const topCard = this.discardPile[this.discardPile.length - 1];
        
        return {
            players: this.players.map(p => ({
                id: p.id,
                cardCount: p.cards.length,
                isTurn: !this.started ? false : this.players[this.currentPlayerIndex]?.id === p.id,
                unoCalled: p.unoCalled,
                left: p.left
            })),
            topCard: cardToString(topCard),
            currentPlayerId: currentPlayer?.id,
            started: this.started,
            direction: this.direction === 1 ? '➡️ Clockwise' : '⬅️ Counter-clockwise'
        };
    }
    
    isExpired() {
        return Date.now() - this.lastPlayTime > 300000;
    }
}

// ============================================
// HELPER FUNCTIONS
// ============================================
function updateStats(userId, cardsPlayed) {
    db.get(`SELECT * FROM stats WHERE user_id = ?`, [userId], (err, row) => {
        if (row) {
            db.run(`UPDATE stats SET cards_played = cards_played + ? WHERE user_id = ?`, [cardsPlayed, userId]);
        } else {
            db.run(`INSERT INTO stats (user_id, cards_played) VALUES (?, ?)`, [userId, cardsPlayed]);
        }
    });
}

async function createGameEmbed(game, interaction) {
    const state = game.getGameState();
    const topCard = game.discardPile[game.discardPile.length - 1];
    
    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🎴 UNO GAME')
        .setDescription(game.started ? 'Game in progress!' : 'Waiting for players to join...')
        .addFields(
            { name: '🎯 Top Card', value: cardToString(topCard), inline: true },
            { name: '🃏 Cards in Deck', value: `${game.deck.length}`, inline: true },
            { name: '🔄 Direction', value: state.direction, inline: true },
            { name: '👥 Players', value: state.players.filter(p => !p.left).map(p => `<@${p.id}> (${p.cardCount} cards${p.unoCalled ? ' 🎯UNO!' : ''})`).join('\n') || 'None', inline: false }
        )
        .setFooter({ text: game.started ? `Current turn: <@${state.currentPlayerId}>` : `Use !uno join to participate!` })
        .setTimestamp();
    
    return embed;
}

async function createPlayerHandEmbed(game, playerId) {
    const player = game.players.find(p => p.id === playerId);
    if (!player) return null;
    
    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🎴 Your Cards')
        .setDescription(player.cards.map((card, idx) => `${idx + 1}. ${cardToString(card)}`).join('\n') || 'No cards!')
        .addFields(
            { name: '📊 Cards Left', value: `${player.cards.length}`, inline: true },
            { name: '🎯 UNO Called', value: player.unoCalled ? 'Yes' : 'No', inline: true }
        )
        .setFooter({ text: 'Use !uno play <number> to play a card' })
        .setTimestamp();
    
    return embed;
}

// ============================================
// COMMAND HANDLER
// ============================================
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.content.startsWith('!uno')) return;
    
    const args = message.content.slice(4).trim().split(/ +/);
    const subCmd = args[0]?.toLowerCase();
    const userId = message.author.id;
    const channelId = message.channel.id;
    
    // Cooldown check
    const cooldownKey = `${userId}_${subCmd}`;
    if (cooldowns.has(cooldownKey) && Date.now() - cooldowns.get(cooldownKey) < 2000) {
        return message.reply('⏰ Please wait before using this command again!');
    }
    cooldowns.set(cooldownKey, Date.now());
    
    let game = activeGames.get(channelId);
    
    // ========== CREATE ==========
    if (subCmd === 'create') {
        if (game) return message.reply('❌ A game is already active in this channel!');
        game = new UnoGame(channelId, userId);
        activeGames.set(channelId, game);
        
        const embed = await createGameEmbed(game, message);
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder().setCustomId('uno_join').setLabel('Join Game').setEmoji('🎮').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('uno_start').setLabel('Start Game').setEmoji('▶️').setStyle(ButtonStyle.Primary)
            );
        
        await message.reply({ embeds: [embed], components: [row] });
    }
    
    // ========== JOIN ==========
    else if (subCmd === 'join') {
        if (!game) return message.reply('❌ No active game in this channel! Use `!uno create`');
        if (game.started) return message.reply('❌ Game already started!');
        if (game.addPlayer(userId)) {
            const embed = await createGameEmbed(game, message);
            await message.reply({ embeds: [embed] });
        } else {
            message.reply('❌ You are already in the game or game is full!');
        }
    }
    
    // ========== LEAVE ==========
    else if (subCmd === 'leave') {
        if (!game) return message.reply('❌ No active game in this channel!');
        if (game.removePlayer(userId)) {
            if (game.players.filter(p => !p.left).length === 0) {
                activeGames.delete(channelId);
                message.reply('✅ Game ended - no players left!');
            } else {
                const embed = await createGameEmbed(game, message);
                await message.reply({ embeds: [embed] });
            }
        } else {
            message.reply('❌ You are not in this game!');
        }
    }
    
    // ========== START ==========
    else if (subCmd === 'start') {
        if (!game) return message.reply('❌ No active game in this channel!');
        if (game.players[0].id !== userId) return message.reply('❌ Only the host can start the game!');
        if (game.startGame()) {
            const embed = await createGameEmbed(game, message);
            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder().setCustomId('uno_cards').setLabel('Show Cards').setEmoji('🃏').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId('uno_draw').setLabel('Draw Card').setEmoji('🎴').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId('uno_end').setLabel('End Game').setEmoji('🚪').setStyle(ButtonStyle.Danger)
                );
            await message.reply({ embeds: [embed], components: [row] });
        } else {
            message.reply('❌ Cannot start game! Need at least 2 players.');
        }
    }
    
    // ========== CARDS ==========
    else if (subCmd === 'cards') {
        if (!game || !game.started) return message.reply('❌ No active game!');
        const player = game.players.find(p => p.id === userId);
        if (!player || player.left) return message.reply('❌ You are not in this game!');
        
        const embed = await createPlayerHandEmbed(game, userId);
        await message.reply({ embeds: [embed] });
    }
    
    // ========== PLAY ==========
    else if (subCmd === 'play') {
        const cardNumber = parseInt(args[1]);
        if (isNaN(cardNumber)) return message.reply('Usage: `!uno play <card_number>`');
        if (!game || !game.started) return message.reply('❌ No active game!');
        
        const player = game.players.find(p => p.id === userId);
        if (!player || player.left) return message.reply('❌ You are not in this game!');
        
        const result = game.playCard(userId, cardNumber - 1);
        if (result.success) {
            updateStats(userId, 1);
            if (result.gameEnded) {
                activeGames.delete(channelId);
                const embed = new EmbedBuilder()
                    .setColor(0x22C55E)
                    .setTitle('🏆 GAME OVER! 🏆')
                    .setDescription(`<@${result.winner}> won the game!`)
                    .addFields({ name: '🎉 Congratulations!', value: 'Thanks for playing UNO!' })
                    .setTimestamp();
                await message.reply({ embeds: [embed] });
            } else {
                const embed = await createGameEmbed(game, message);
                const row = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder().setCustomId('uno_cards').setLabel('Show Cards').setEmoji('🃏').setStyle(ButtonStyle.Secondary),
                        new ButtonBuilder().setCustomId('uno_draw').setLabel('Draw Card').setEmoji('🎴').setStyle(ButtonStyle.Primary),
                        new ButtonBuilder().setCustomId('uno_end').setLabel('End Game').setEmoji('🚪').setStyle(ButtonStyle.Danger)
                    );
                await message.reply({ embeds: [embed], components: [row] });
            }
        } else {
            message.reply(`❌ ${result.error}`);
        }
    }
    
    // ========== DRAW ==========
    else if (subCmd === 'draw') {
        if (!game || !game.started) return message.reply('❌ No active game!');
        const result = game.drawCard(userId);
        if (result.success) {
            const embed = new EmbedBuilder()
                .setColor(0x22C55E)
                .setTitle('🎴 Card Drawn')
                .setDescription(`You drew: ${cardToString(result.card)}`)
                .setFooter({ text: 'It is still your turn!' })
                .setTimestamp();
            await message.reply({ embeds: [embed] });
        } else {
            message.reply(`❌ ${result.error}`);
        }
    }
    
    // ========== UNO ==========
    else if (subCmd === 'uno') {
        if (!game || !game.started) return message.reply('❌ No active game!');
        const result = game.callUno(userId);
        if (result.success) {
            const embed = new EmbedBuilder()
                .setColor(0xFEE75C)
                .setTitle('🎯 UNO!')
                .setDescription(`<@${userId}> called UNO!`)
                .setTimestamp();
            await message.reply({ embeds: [embed] });
        } else {
            message.reply(`❌ ${result.error}`);
        }
    }
    
    // ========== END ==========
    else if (subCmd === 'end') {
        if (!game) return message.reply('❌ No active game!');
        if (game.players[0].id !== userId && !message.member.permissions.has('Administrator')) {
            return message.reply('❌ Only the host or an admin can end the game!');
        }
        activeGames.delete(channelId);
        message.reply('✅ Game ended by host!');
    }
    
    // ========== STATS ==========
    else if (subCmd === 'stats') {
        const targetId = args[1] || userId;
        db.get(`SELECT * FROM stats WHERE user_id = ?`, [targetId], (err, row) => {
            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('📊 UNO Statistics')
                .setDescription(`Stats for <@${targetId}>`)
                .addFields(
                    { name: '🏆 Wins', value: `${row?.wins || 0}`, inline: true },
                    { name: '🎮 Games Played', value: `${row?.games || 0}`, inline: true },
                    { name: '🃏 Cards Played', value: `${row?.cards_played || 0}`, inline: true },
                    { name: '📈 Win Rate', value: `${row?.games ? Math.round((row.wins / row.games) * 100) : 0}%`, inline: true }
                )
                .setTimestamp();
            message.reply({ embeds: [embed] });
        });
    }
    
    // ========== HELP ==========
    else if (!subCmd || subCmd === 'help') {
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('🎴 UNO Bot Commands')
            .setDescription('**Game Commands:**')
            .addFields(
                { name: '!uno create', value: 'Create a new UNO game', inline: true },
                { name: '!uno join', value: 'Join an existing game', inline: true },
                { name: '!uno start', value: 'Start the game (host only)', inline: true },
                { name: '!uno leave', value: 'Leave the current game', inline: true },
                { name: '!uno cards', value: 'Show your cards', inline: true },
                { name: '!uno play <number>', value: 'Play a card by number', inline: true },
                { name: '!uno draw', value: 'Draw a card', inline: true },
                { name: '!uno uno', value: 'Call UNO when you have 1 card', inline: true },
                { name: '!uno end', value: 'End the game (host only)', inline: true },
                { name: '!uno stats [user]', value: 'View game statistics', inline: true },
                { name: '!uno help', value: 'Show this help menu', inline: true }
            )
            .setFooter({ text: '🎮 Unofficial Discord UNO Game' })
            .setTimestamp();
        message.reply({ embeds: [embed] });
    }
    
    // Clean up expired games
    for (const [id, g] of activeGames) {
        if (g.isExpired()) {
            activeGames.delete(id);
        }
    }
});

// ============================================
// BUTTON HANDLER
// ============================================
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;
    
    const game = activeGames.get(interaction.channelId);
    if (!game) return interaction.reply({ content: '❌ No active game!', ephemeral: true });
    
    if (interaction.customId === 'uno_join') {
        if (game.started) return interaction.reply({ content: '❌ Game already started!', ephemeral: true });
        if (game.addPlayer(interaction.user.id)) {
            const embed = await createGameEmbed(game, interaction);
            await interaction.update({ embeds: [embed] });
        } else {
            interaction.reply({ content: '❌ You are already in the game or game is full!', ephemeral: true });
        }
    }
    
    else if (interaction.customId === 'uno_start') {
        if (game.players[0].id !== interaction.user.id) return interaction.reply({ content: '❌ Only the host can start the game!', ephemeral: true });
        if (game.startGame()) {
            const embed = await createGameEmbed(game, interaction);
            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder().setCustomId('uno_cards').setLabel('Show Cards').setEmoji('🃏').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId('uno_draw').setLabel('Draw Card').setEmoji('🎴').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId('uno_end').setLabel('End Game').setEmoji('🚪').setStyle(ButtonStyle.Danger)
                );
            await interaction.update({ embeds: [embed], components: [row] });
        } else {
            interaction.reply({ content: '❌ Cannot start game! Need at least 2 players.', ephemeral: true });
        }
    }
    
    else if (interaction.customId === 'uno_cards') {
        const player = game.players.find(p => p.id === interaction.user.id);
        if (!player || player.left) return interaction.reply({ content: '❌ You are not in this game!', ephemeral: true });
        const embed = await createPlayerHandEmbed(game, interaction.user.id);
        await interaction.reply({ embeds: [embed], ephemeral: true });
    }
    
    else if (interaction.customId === 'uno_draw') {
        const result = game.drawCard(interaction.user.id);
        if (result.success) {
            const embed = new EmbedBuilder()
                .setColor(0x22C55E)
                .setTitle('🎴 Card Drawn')
                .setDescription(`You drew: ${cardToString(result.card)}`)
                .setFooter({ text: 'It is still your turn!' })
                .setTimestamp();
            await interaction.reply({ embeds: [embed], ephemeral: true });
        } else {
            interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
        }
    }
    
    else if (interaction.customId === 'uno_end') {
        if (game.players[0].id !== interaction.user.id && !interaction.member.permissions.has('Administrator')) {
            return interaction.reply({ content: '❌ Only the host or an admin can end the game!', ephemeral: true });
        }
        activeGames.delete(interaction.channelId);
        await interaction.update({ content: '✅ Game ended!', embeds: [], components: [] });
    }
});

// ============================================
// READY EVENT
// ============================================
client.once('ready', () => {
    console.log(`✅ ${client.user.tag} is online!`);
    console.log(`🎴 UNO Bot ready to play!`);
    console.log(`📋 Commands: !uno help`);
    client.user.setActivity('!uno help | UNO Game', { type: 3 });
});

// ============================================
// ERROR HANDLING
// ============================================
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err.message));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err.message));
process.on('SIGINT', () => { db.close(() => process.exit(0)); });
process.on('SIGTERM', () => { db.close(() => process.exit(0)); });

// ============================================
// START BOT
// ============================================
client.login(BOT_TOKEN);
