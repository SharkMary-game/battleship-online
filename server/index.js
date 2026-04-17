const path = require("path");
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());

const CLIENT_DIR = path.join(__dirname, "..", "client");

app.use(express.static(CLIENT_DIR));

app.get("/", (req, res) => {
  res.sendFile(path.join(CLIENT_DIR, "index.html"));
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
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
    hits: Array(100).fill(false),
    shots: Array(100).fill(false),
    ready: false,
    shipGroups: []
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

function normalizeShipGroups(shipGroups) {
  if (!Array.isArray(shipGroups)) return [];

  return shipGroups
    .filter((group) => Array.isArray(group) && group.length > 0)
    .map((group) =>
      group
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value >= 0 && value < 100)
    )
    .filter((group) => group.length > 0);
}

function getShipGroupByCell(player, index) {
  if (!player || !Array.isArray(player.shipGroups)) return null;
  return player.shipGroups.find((group) => group.includes(index)) || null;
}

function getAroundIndexes(shipCells) {
  const around = new Set();
  const shipSet = new Set(shipCells);

  for (const cell of shipCells) {
    const row = Math.floor(cell / 10);
    const col = cell % 10;

    for (let dRow = -1; dRow <= 1; dRow++) {
      for (let dCol = -1; dCol <= 1; dCol++) {
        const newRow = row + dRow;
        const newCol = col + dCol;

        if (newRow < 0 || newRow >= 10 || newCol < 0 || newCol >= 10) continue;

        const newIndex = newRow * 10 + newCol;
        if (shipSet.has(newIndex)) continue;

        around.add(newIndex);
      }
    }
  }

  return Array.from(around);
}

function clearRoomCompletely() {
  room.hostId = null;
  room.guestId = null;
  room.players = {};
  resetGameState();
}

io.on("connection", (socket) => {
  console.log("Игрок подключился:", socket.id);

  socket.on("createRoom", () => {
    clearRoomCompletely();

    room.hostId = socket.id;
    room.players[socket.id] = createPlayerState();

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

  socket.on("setShips", (payload) => {
    const player = room.players[socket.id];
    if (!player) return;
    if (player.ready) return;

    const ships = payload && Array.isArray(payload.ships) ? payload.ships : null;
    const shipGroups = payload ? normalizeShipGroups(payload.shipGroups) : [];

    if (!ships || ships.length !== 100) return;

    player.ships = ships.map(Boolean);
    player.shipGroups = shipGroups;
    player.hits = Array(100).fill(false);
    player.shots = Array(100).fill(false);

    io.to(socket.id).emit("yourShipsUpdated", player.ships);
    console.log("Корабли обновлены у:", socket.id);
  });

  socket.on("playerReady", () => {
    console.log("playerReady от:", socket.id);

    const player = room.players[socket.id];
    if (!player) return;

    player.ready = true;

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

    room.gameStarted = true;
    room.turn = ids[0];

    io.to(ids[0]).emit("battleStarted", { yourTurn: true });
    io.to(ids[1]).emit("battleStarted", { yourTurn: false });

    console.log("СТАРТ БОЯ");
  });

  socket.on("shoot", (index) => {
    console.log("Выстрел от:", socket.id, "в клетку:", index);

    if (!room.gameStarted) return;

    if (room.turn !== socket.id) {
      io.to(socket.id).emit("statusMessage", "Сейчас не твой ход");
      return;
    }

    if (!Number.isInteger(index) || index < 0 || index > 99) return;

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
    let sunk = false;
    let sunkShip = [];
    let around = [];

    if (hit) {
      opponent.hits[index] = true;

      const shipGroup = getShipGroupByCell(opponent, index);
      if (shipGroup && shipGroup.every((cell) => opponent.hits[cell])) {
        sunk = true;
        sunkShip = [...shipGroup];
        around = getAroundIndexes(shipGroup);
      }
    }

    io.to(socket.id).emit("shotResult", {
      index,
      hit,
      sunk,
      sunkShip,
      around
    });

    io.to(opponentId).emit("enemyShotResult", {
      index,
      hit,
      sunk,
      sunkShip,
      around
    });

    const opponentShipsLeft = opponent.ships.some((hasShip, cellIndex) => {
      return hasShip && !opponent.hits[cellIndex];
    });

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
      clearRoomCompletely();
      return;
    }

    if (room.guestId === socket.id) {
      room.guestId = null;
      resetGameState();

      if (room.hostId) {
        const host = room.players[room.hostId];
        if (host) {
          host.ready = false;
        }
        io.to(room.hostId).emit("statusMessage", "Второй игрок отключился");
      }
    }
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log("Сервер на", PORT);
});