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
  cors: { origin: "*" }
});

const ROOM_ID = "4221";
const TOTAL_SHIP_CELLS = 20; // 4 + 3+3 + 2+2+2 + 1+1+1+1

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
    ready: false,
    aliveCells: 0
  };
}

function resetGameState() {
  room.gameStarted = false;
  room.turn = null;

  for (const id of Object.keys(room.players)) {
    if (room.players[id]) {
      room.players[id].ready = false;
      room.players[id].shots = Array(100).fill(false);
    }
  }
}

function getActivePlayerIds() {
  return [room.hostId, room.guestId].filter(Boolean);
}

function getOpponentId(socketId) {
  return getActivePlayerIds().find((id) => id !== socketId) || null;
}

function fleetCellCount(ships) {
  return ships.filter(Boolean).length;
}

io.on("connection", (socket) => {
  console.log("Игрок подключился:", socket.id);

  socket.on("createRoom", () => {
    room.hostId = socket.id;
    room.guestId = null;
    room.players = {};
    room.players[socket.id] = createPlayerState();
    room.gameStarted = false;
    room.turn = null;

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
    room.gameStarted = false;
    room.turn = null;

    socket.join(ROOM_ID);

    socket.emit("roomJoined", ROOM_ID);
    socket.emit("statusMessage", "Ты вошёл в комнату 4221. Расставь корабли");

    if (room.hostId) {
      io.to(room.hostId).emit("statusMessage", "Второй игрок подключился. Можно расставлять корабли");
    }

    console.log("Второй игрок вошёл:", socket.id);
  });

  socket.on("setShips", (ships) => {
    const player = room.players[socket.id];
    if (!player) return;
    if (player.ready) return;
    if (!Array.isArray(ships) || ships.length !== 100) return;

    const normalizedShips = ships.map((v) => v === true);
    player.ships = normalizedShips;
    player.aliveCells = fleetCellCount(normalizedShips);

    io.to(socket.id).emit("yourShipsUpdated", player.ships);

    console.log("Корабли обновлены у:", socket.id, "палуб:", player.aliveCells);
  });

  socket.on("playerReady", () => {
    console.log("playerReady от:", socket.id);

    const player = room.players[socket.id];
    if (!player) return;

    const cells = fleetCellCount(player.ships);

    if (cells !== TOTAL_SHIP_CELLS) {
      io.to(socket.id).emit(
        "statusMessage",
        `Некорректная расстановка кораблей. Нужно ${TOTAL_SHIP_CELLS} палуб, сейчас: ${cells}`
      );
      return;
    }

    player.aliveCells = cells;
    player.ready = true;

    const ids = getActivePlayerIds();
    console.log("Активные игроки:", ids);

    if (ids.length !== 2) {
      io.to(socket.id).emit("statusMessage", "Ты готов. Ждём второго игрока");
      return;
    }

    const p1 = room.players[ids[0]];
    const p2 = room.players[ids[1]];

    console.log(
      "Готовность:",
      p1?.ready,
      p2?.ready,
      "палубы:",
      p1?.aliveCells,
      p2?.aliveCells
    );

    if (!p1?.ready || !p2?.ready) {
      io.to(socket.id).emit("statusMessage", "Ты готов. Ждём второго игрока");
      return;
    }

    room.gameStarted = true;
    room.turn = ids[0];

    io.to(ids[0]).emit("battleStarted", { yourTurn: true });
    io.to(ids[1]).emit("battleStarted", { yourTurn: false });

    io.to(ids[0]).emit("statusMessage", "Бой начался. Твой ход");
    io.to(ids[1]).emit("statusMessage", "Бой начался. Ход соперника");

    console.log("СТАРТ БОЯ");
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

    let hit = false;

    if (opponent.ships[index] === true) {
      hit = true;
      opponent.ships[index] = false;
      opponent.aliveCells -= 1;
    }

    io.to(socket.id).emit("shotResult", { index, hit });
    io.to(opponentId).emit("enemyShotResult", { index, hit });

    console.log("Попадание:", hit, "осталось палуб у соперника:", opponent.aliveCells);

    if (opponent.aliveCells <= 0) {
      io.to(socket.id).emit("gameOver", "win");
      io.to(opponentId).emit("gameOver", "lose");

      room.gameStarted = false;
      room.turn = null;

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
      room.gameStarted = false;
      room.turn = null;
      return;
    }

    if (room.guestId === socket.id) {
      room.guestId = null;
      room.gameStarted = false;
      room.turn = null;

      if (room.hostId) {
        const host = room.players[room.hostId];
        if (host) {
          host.ready = false;
          host.shots = Array(100).fill(false);
        }

        io.to(room.hostId).emit("statusMessage", "Второй игрок отключился");
      }
    }
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});