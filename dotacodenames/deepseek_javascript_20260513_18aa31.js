const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: { origin: "*" }
});

// Хранилище комнат
const rooms = new Map();

// Герои и предметы Dota 2
const HEROES = [
    "Anti-Mage", "Axe", "Bane", "Bloodseeker", "Crystal Maiden", "Drow Ranger",
    "Earthshaker", "Faceless Void", "Grimstroke", "Hoodwink", "Invoker",
    "Juggernaut", "Kunkka", "Lina", "Lion", "Magnus", "Marci", "Naga Siren",
    "Ogre Magi", "Pudge", "Queen of Pain", "Razor", "Shadow Fiend", "Techies",
    "Tinker", "Ursa", "Vengeful Spirit", "Windranger", "Zeus", "Slark"
];

const ITEMS = [
    "Blink Dagger", "Aghanim's Scepter", "Black King Bar", "Manta Style",
    "Divine Rapier", "Heart of Tarrasque", "Butterfly", "Monkey King Bar",
    "Shadow Blade", "Silver Edge", "Diffusal Blade", "Eul's Scepter",
    "Force Staff", "Glimmer Cape", "Hurricane Pike", "Radiance", "Battle Fury",
    "Desolator", "Satanic", "Assault Cuirass", "Shiva's Guard", "Octarine Core",
    "Scythe of Vyse", "Bloodthorn", "Abyssal Blade"
];

function getRandomCards() {
    let shuffledHeroes = [...HEROES];
    let shuffledItems = [...ITEMS];
    for (let i = shuffledHeroes.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffledHeroes[i], shuffledHeroes[j]] = [shuffledHeroes[j], shuffledHeroes[i]];
    }
    for (let i = shuffledItems.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffledItems[i], shuffledItems[j]] = [shuffledItems[j], shuffledItems[i]];
    }
    let heroesCount = Math.random() > 0.5 ? 13 : 12;
    let itemsCount = 25 - heroesCount;
    let pool = [...shuffledHeroes.slice(0, heroesCount), ...shuffledItems.slice(0, itemsCount)];
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool;
}

function generateColorMap() {
    let colors = [];
    let reds = 9, blues = 8, neutrals = 7, assassin = 1;
    for (let i = 0; i < reds; i++) colors.push("red");
    for (let i = 0; i < blues; i++) colors.push("blue");
    for (let i = 0; i < neutrals; i++) colors.push("neutral");
    for (let i = 0; i < assassin; i++) colors.push("assassin");
    for (let i = colors.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [colors[i], colors[j]] = [colors[j], colors[i]];
    }
    return colors;
}

function createGame() {
    return {
        cards: getRandomCards(),
        colors: generateColorMap(),
        revealed: new Array(25).fill(false),
        currentTurn: "red", // red ходит первым
        gameActive: true,
        winner: null,
        redRemaining: 9,
        blueRemaining: 8,
        spymasters: { red: null, blue: null }
    };
}

io.on('connection', (socket) => {
    console.log('Пользователь подключился:', socket.id);

    socket.on('createRoom', (roomId) => {
        if (rooms.has(roomId)) {
            socket.emit('error', 'Комната уже существует');
            return;
        }
        
        const game = createGame();
        // Пересчитываем оставшиеся карты
        game.redRemaining = game.colors.filter(c => c === "red").length;
        game.blueRemaining = game.colors.filter(c => c === "blue").length;
        
        rooms.set(roomId, {
            game: game,
            players: [socket.id],
            roles: { [socket.id]: { team: null, isSpymaster: false } }
        });
        
        socket.join(roomId);
        socket.emit('roomCreated', { roomId, playerId: socket.id });
        console.log(`Комната ${roomId} создана пользователем ${socket.id}`);
    });

    socket.on('joinRoom', (roomId) => {
        const room = rooms.get(roomId);
        if (!room) {
            socket.emit('error', 'Комната не найдена');
            return;
        }
        
        if (room.players.length >= 4) {
            socket.emit('error', 'Комната полна (максимум 4 игрока)');
            return;
        }
        
        room.players.push(socket.id);
        room.roles[socket.id] = { team: null, isSpymaster: false };
        socket.join(roomId);
        socket.emit('joinedRoom', { roomId, playerId: socket.id, gameState: room.game });
        
        // Обновляем всех в комнате
        io.to(roomId).emit('playersUpdate', {
            players: room.players.map(id => ({ id, role: room.roles[id] }))
        });
        
        console.log(`Пользователь ${socket.id} присоединился к комнате ${roomId}`);
    });

    socket.on('chooseRole', ({ roomId, team, isSpymaster }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        
        room.roles[socket.id] = { team, isSpymaster };
        
        if (isSpymaster && team === 'red') room.game.spymasters.red = socket.id;
        if (isSpymaster && team === 'blue') room.game.spymasters.blue = socket.id;
        
        io.to(roomId).emit('playersUpdate', {
            players: room.players.map(id => ({ id, role: room.roles[id] }))
        });
        
        // Проверяем, все ли выбрали роли
        const redPlayers = Object.values(room.roles).filter(r => r.team === 'red').length;
        const bluePlayers = Object.values(room.roles).filter(r => r.team === 'blue').length;
        
        if (redPlayers >= 2 && bluePlayers >= 2) {
            io.to(roomId).emit('gameReady', { gameState: room.game });
        }
    });

    socket.on('revealCard', ({ roomId, index }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        
        const game = room.game;
        if (!game.gameActive) return;
        
        // Проверяем, что ходит правильная команда
        const playerRole = room.roles[socket.id];
        if (!playerRole || playerRole.isSpymaster) return; // Шпионы не открывают карты
        if (playerRole.team !== game.currentTurn) return;
        
        if (game.revealed[index]) return;
        
        const color = game.colors[index];
        game.revealed[index] = true;
        
        if (color === "assassin") {
            game.gameActive = false;
            game.winner = game.currentTurn === "red" ? "blue" : "red";
            io.to(roomId).emit('gameOver', { winner: game.winner });
        } else if (color === "red") {
            game.redRemaining--;
            if (game.redRemaining === 0) {
                game.gameActive = false;
                game.winner = "red";
                io.to(roomId).emit('gameOver', { winner: "red" });
            } else {
                // Продолжают ходить
                io.to(roomId).emit('cardRevealed', { index, color, remaining: { red: game.redRemaining, blue: game.blueRemaining } });
            }
        } else if (color === "blue") {
            game.blueRemaining--;
            if (game.blueRemaining === 0) {
                game.gameActive = false;
                game.winner = "blue";
                io.to(roomId).emit('gameOver', { winner: "blue" });
            } else {
                io.to(roomId).emit('cardRevealed', { index, color, remaining: { red: game.redRemaining, blue: game.blueRemaining } });
            }
        } else if (color === "neutral") {
            // Нейтралка — ход переходит
            game.currentTurn = game.currentTurn === "red" ? "blue" : "red";
            io.to(roomId).emit('cardRevealed', { index, color, remaining: { red: game.redRemaining, blue: game.blueRemaining }, turnChange: game.currentTurn });
        }
        
        io.to(roomId).emit('gameStateUpdate', { revealed: game.revealed, turn: game.currentTurn });
    });

    socket.on('endTurn', ({ roomId }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        
        const game = room.game;
        if (!game.gameActive) return;
        
        game.currentTurn = game.currentTurn === "red" ? "blue" : "red";
        io.to(roomId).emit('turnChanged', { turn: game.currentTurn });
    });

    socket.on('disconnect', () => {
        console.log('Пользователь отключился:', socket.id);
        // Удаляем из комнат
        for (const [roomId, room] of rooms.entries()) {
            const index = room.players.indexOf(socket.id);
            if (index !== -1) {
                room.players.splice(index, 1);
                delete room.roles[socket.id];
                io.to(roomId).emit('playersUpdate', {
                    players: room.players.map(id => ({ id, role: room.roles[id] }))
                });
                if (room.players.length === 0) {
                    rooms.delete(roomId);
                    console.log(`Комната ${roomId} удалена (пуста)`);
                }
                break;
            }
        }
    });
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});