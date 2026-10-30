// 组队策略：队友可穿行，单次 BFS 分配食物，并有界评估出口和敌方威胁。
var DIRECTIONS = ['up', 'right', 'down', 'left'];
var DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
var OPPOSITE = [2, 3, 0, 1];
var board;

function prepare(state) {
  var w = state.width, h = state.height, n = w * h;
  if (board && board.w === w && board.h === h && board.wrap === state.wrap) return board;
  var adjacent = new Int32Array(n * 4);
  for (var cell = 0; cell < n; cell++) {
    var x = cell % w, y = (cell / w) | 0;
    for (var d = 0; d < 4; d++) {
      var nx = x + DX[d], ny = y + DY[d];
      if (state.wrap) { nx = (nx + w) % w; ny = (ny + h) % h; }
      adjacent[cell * 4 + d] = nx < 0 || nx >= w || ny < 0 || ny >= h ? -1 : ny * w + nx;
    }
  }
  board = { w: w, h: h, wrap: state.wrap, n: n, adjacent: adjacent,
    blocked: new Uint8Array(n), food: new Uint8Array(n), danger: new Uint8Array(n),
    seen: new Uint8Array(n), spaceSeen: new Int32Array(n), stamp: 0,
    queue: new Int32Array(n), first: new Int8Array(n), distance: new Int16Array(n) };
  return board;
}

function fillBoard(state, b) {
  b.blocked.fill(0); b.food.fill(0); b.danger.fill(0);
  var you = state.you, combat = state.mode === 'battle' || (state.mode === 'score' && !state.wrap);
  var snakes = state.snakes || [];
  for (var s = 0; s < snakes.length; s++) {
    var snake = snakes[s];
    if (!snake || !snake.alive) continue;
    var own = snake.id === you.id;
    var mate = state.teams && you.team !== null && snake.team === you.team;
    if (own || combat && !mate) {
      var body = snake.body || [];
      for (var j = 0; j < body.length; j++) {
        var part = body[j];
        if (part && part.x >= 0 && part.x < b.w && part.y >= 0 && part.y < b.h)
          b.blocked[part.y * b.w + part.x] = 1;
      }
    }
    if (!combat || own || mate || !snake.head || (snake.length || 0) < (you.length || 0)) continue;
    var head = snake.head.y * b.w + snake.head.x;
    for (var d = 0; d < 4; d++) {
      if (DIRECTIONS[OPPOSITE[d]] === snake.dir) continue;
      var next = b.adjacent[head * 4 + d];
      if (next >= 0) b.danger[next] = 1;
    }
  }
  var foods = state.foods || [];
  for (var f = 0; f < foods.length; f++) {
    var food = foods[f];
    if (food && food.x >= 0 && food.x < b.w && food.y >= 0 && food.y < b.h)
      b.food[food.y * b.w + food.x] = 1;
  }
}

function fallback(state) {
  var legal = state && state.legalMoves || [];
  var current = state && state.you && state.you.dir || 'up';
  return legal.indexOf(current) >= 0 ? current : legal[0] || current;
}

function findFood(state, b) {
  b.seen.fill(0);
  var start = state.you.head.y * b.w + state.you.head.x;
  var queue = b.queue, first = b.first, distance = b.distance;
  var head = 0, end = 1, bestCost = Infinity, bestDirection = -1;
  queue[0] = start; first[0] = -1; distance[start] = 0; b.seen[start] = 1;
  while (head < end && head < 2400) {
    var cell = queue[head], nextDistance = distance[cell] + 1;
    if (distance[cell] >= 100) break;
    for (var d = 0; d < 4; d++) {
      if (head === 0 && state.legalMoves.indexOf(DIRECTIONS[d]) < 0) continue;
      var next = b.adjacent[cell * 4 + d];
      if (next < 0 || b.seen[next] || b.blocked[next] || head === 0 && b.danger[next]) continue;
      var initial = head === 0 ? d : first[head];
      if (b.food[next]) {
        var cost = nextDistance;
        var foodX = next % b.w, foodY = (next / b.w) | 0;
        for (var e = 0; e < state.snakes.length; e++) {
          var enemy = state.snakes[e];
          if (!enemy || !enemy.alive || enemy.id === state.you.id || !enemy.head ||
              state.teams && state.you.team !== null && enemy.team === state.you.team) continue;
          var dx = Math.abs(enemy.head.x - foodX), dy = Math.abs(enemy.head.y - foodY);
          if (b.wrap) { dx = Math.min(dx, b.w - dx); dy = Math.min(dy, b.h - dy); }
          if (dx + dy <= nextDistance) cost += 8;
        }
        if (state.teams) {
          for (var m = 0; m < state.snakes.length; m++) {
            var mate = state.snakes[m];
            if (!mate || !mate.alive || !mate.head || mate.id === state.you.id || mate.team !== state.you.team) continue;
            var mx = Math.abs(mate.head.x - foodX), my = Math.abs(mate.head.y - foodY);
            if (b.wrap) { mx = Math.min(mx, b.w - mx); my = Math.min(my, b.h - my); }
            if (mx + my < nextDistance || mx + my === nextDistance && mate.slot < state.you.slot) cost += 12;
          }
        }
        if (cost < bestCost) { bestCost = cost; bestDirection = initial; }
      }
      b.seen[next] = 1;
      distance[next] = nextDistance;
      if (end < b.n) { queue[end] = next; first[end] = initial; end++; }
    }
    head++;
  }
  return bestDirection;
}

function flood(b, start, tail, ate, limit) {
  var queue = b.queue, stamp = ++b.stamp, head = 0, end = 1;
  queue[0] = start; b.spaceSeen[start] = stamp;
  while (head < end && end < limit) {
    var cell = queue[head++];
    for (var d = 0; d < 4; d++) {
      var next = b.adjacent[cell * 4 + d];
      if (next < 0 || b.spaceSeen[next] === stamp || b.blocked[next] && !(next === tail && !ate)) continue;
      b.spaceSeen[next] = stamp;
      queue[end++] = next;
      if (end >= limit) break;
    }
  }
  return end;
}

function move(state) {
  var you = state && state.you;
  if (!you || !you.alive || !you.head || !state.legalMoves || !state.legalMoves.length) return fallback(state);
  var b = prepare(state);
  fillBoard(state, b);
  var body = you.body || [], last = body[body.length - 1];
  var tail = last ? last.y * b.w + last.x : -1;
  var route = findFood(state, b);
  if (route >= 0 && state.maxHp !== null && state.width >= 64) return DIRECTIONS[route];
  var start = you.head.y * b.w + you.head.x;
  var needed = Math.max(10, (you.length || body.length) + 3);
  var limit = Math.min(b.n, Math.max(64, needed * 2));
  var bestScore = -Infinity, bestDirection = -1;
  for (var d = 0; d < 4; d++) {
    if (state.legalMoves.indexOf(DIRECTIONS[d]) < 0) continue;
    var next = b.adjacent[start * 4 + d];
    if (next < 0 || b.blocked[next] && !(next === tail && !b.food[next])) continue;
    var area = flood(b, next, tail, b.food[next], limit);
    var exits = 0;
    for (var step = 0; step < 4; step++) {
      var neighbor = b.adjacent[next * 4 + step];
      if (neighbor >= 0 && (!b.blocked[neighbor] || neighbor === tail && !b.food[next])) exits++;
    }
    var score = Math.min(area, needed * 2) * 4 + exits * 60;
    if (area < needed) score -= (needed - area) * 260;
    if (exits === 0) score -= 900;
    if (b.danger[next]) score -= 10000;
    if (d === route) score += 2200;
    if (state.teams) {
      var nx = next % b.w, ny = (next / b.w) | 0;
      for (var s = 0; s < state.snakes.length; s++) {
        var snake = state.snakes[s];
        if (!snake || !snake.alive || !snake.head || snake.id === you.id) continue;
        var dx = Math.abs(nx - snake.head.x), dy = Math.abs(ny - snake.head.y);
        if (b.wrap) { dx = Math.min(dx, b.w - dx); dy = Math.min(dy, b.h - dy); }
        var separation = dx + dy;
        if (snake.team === you.team) {
          if (separation <= 1) score -= 30;
          else if (separation <= 6) score += 14;
        } else if (separation <= 2) score -= (3 - separation) * 45;
      }
    }
    if (b.food[next]) score += 500;
    if (DIRECTIONS[d] === you.dir) score += 8;
    if (score > bestScore) { bestScore = score; bestDirection = d; }
  }
  return bestDirection >= 0 ? DIRECTIONS[bestDirection] : fallback(state);
}

module.exports = { move: move };
