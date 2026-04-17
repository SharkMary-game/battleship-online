const express = require("express");
const http = require("http");
const cors = require("cors");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
app.use(cors());
app.use(express.json());

const clientPath = path.join(__dirname, "..", "client");
app.use(express.static(clientPath));

app.get("/", (req, res) => {
  res.sendFile(path.join(clientPath, "index.html"));
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

const ROOM_ID = "4221";

const room = {
  hostId: null,
  guestId: null,
  players: {},
  gameStarted: false,
  turn: null
};

function createPlayerState() {
  return {
    ships: Array(100).fill(false),
    shots: Array(100).fill(false),
    ready: false
  };
}

function resetGameState() {
  room.gameStarted = false;
  room.turn = null;
}

function getActivePlayerIds() {
  return [room.hostId, room.guestId].filter(Boolean);
}

function getOpponentId(socketId) {
  return getActivePlayerIds().find((id) => id !== socketId) || null;
}

io.on("connection", (socket) => {
  console.log("Игрок подключился:", socket.id);

  socket.on("createRoom", () => {
    room.hostId = socket.id;
    room.guestId = null;
    room.players = {};
    room.players[socket.id] = createPlayerState();
    resetGameState();

    socket.join(ROOM_ID);

    socket.emit("roomCreated", ROOM_ID);
    socket.emit("statusMessage", "Комната создана. Код: 4221. Ждём второго игрока");

    console.log("Комнату создал:", socket.id);
  });

  socket.on("joinRoom", (code) => {
    console.log("Попытка входа с кодом:", code);

    if (String(code).trim() !== ROOM_ID) {
      socket.emit("statusMessage", "Неверный код комнаты");
      return;
    }

    if (!room.hostId) {
      socket.emit("statusMessage", "Сначала создай комнату в первой вкладке");
      return;
    }

    if (room.guestId && room.guestId !== socket.id) {
      delete room.players[room.guestId];
    }

    room.guestId = socket.id;
    room.players[socket.id] = createPlayerState();
    resetGameState();

    socket.join(ROOM_ID);

    socket.emit("roomJoined", ROOM_ID);
    socket.emit("statusMessage", "Ты вошёл в комнату 4221. Расставь корабли");

    if (room.hostId) {
      io.to(room.hostId).emit("statusMessage", "Второй игрок подключился. Можно расставлять корабли");
    }

    console.log("Второй игрок вошёл:", socket.id);
  });

  socket.on("setShips", (ships) => {
    if (!room.players[socket.id]) return;
    if (room.players[socket.id].ready) return;
    if (!Array.isArray(ships) || ships.length !== 100) return;

    room.players[socket.id].ships = ships.map(Boolean);
    io.to(socket.id).emit("yourShipsUpdated", room.players[socket.id].ships);

    console.log("Корабли обновлены у:", socket.id);
  });

  socket.on("playerReady", () => {
    console.log("playerReady от:", socket.id);

    if (!room.players[socket.id]) return;

    room.players[socket.id].ready = true;

    const ids = getActivePlayerIds();
    console.log("Активные игроки:", ids);

    if (ids.length !== 2) {
      io.to(socket.id).emit("statusMessage", "Ты готов. Ждём второго игрока");
      return;
    }

    const p1 = room.players[ids[0]];
    const p2 = room.players[ids[1]];

    console.log("Готовность:", p1?.ready, p2?.ready);

    if (!p1?.ready || !p2?.ready) {
      io.to(socket.id).emit("statusMessage", "Ты готов. Ждём второго игрока");
      return;
    }

    console.log("СТАРТ БОЯ");

    room.gameStarted = true;
    room.turn = ids[0];

    io.to(ids[0]).emit("battleStarted", { yourTurn: true });
    io.to(ids[1]).emit("battleStarted", { yourTurn: false });
  });

  socket.on("shoot", (index) => {
    console.log("Выстрел от:", socket.id, "в клетку:", index);

    if (!room.gameStarted) return;

    if (room.turn !== socket.id) {
      io.to(socket.id).emit("statusMessage", "Сейчас не твой ход");
      return;
    }

    if (typeof index !== "number" || index < 0 || index > 99) return;

    const opponentId = getOpponentId(socket.id);
    if (!opponentId) return;

    const shooter = room.players[socket.id];
    const opponent = room.players[opponentId];

    if (!shooter || !opponent) return;

    if (shooter.shots[index]) {
      io.to(socket.id).emit("statusMessage", "Ты уже стрелял сюда");
      return;
    }

    shooter.shots[index] = true;

    const hit = opponent.ships[index] === true;
    if (hit) {
      opponent.ships[index] = false;
    }

    io.to(socket.id).emit("shotResult", { index, hit });
    io.to(opponentId).emit("enemyShotResult", { index, hit });

    const opponentShipsLeft = opponent.ships.some(Boolean);

    if (!opponentShipsLeft) {
      io.to(socket.id).emit("gameOver", "win");
      io.to(opponentId).emit("gameOver", "lose");
      resetGameState();
      console.log("Игра окончена");
      return;
    }

    if (!hit) {
      room.turn = opponentId;
    }

    io.to(socket.id).emit("turnUpdate", { yourTurn: room.turn === socket.id });
    io.to(opponentId).emit("turnUpdate", { yourTurn: room.turn === opponentId });
  });

  socket.on("disconnect", () => {
    console.log("Игрок отключился:", socket.id);

    delete room.players[socket.id];

    if (room.hostId === socket.id) {
      room.hostId = null;
      room.guestId = null;
      room.players = {};
      resetGameState();
      return;
    }

    if (room.guestId === socket.id) {
      room.guestId = null;
      resetGameState();
      if (room.hostId) {
        io.to(room.hostId).emit("statusMessage", "Второй игрок отключился");
      }
    }
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});