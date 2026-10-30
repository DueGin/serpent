// 贪心 BFS：复用平铺棋盘，从蛇头一次搜索全部候选方向。
var DIRECTIONS = ['up', 'right', 'down', 'left'];
var DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
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
    blocked: new Uint8Array(n), food: new Uint8Array(n), seen: new Uint8Array(n),
    queue: new Int32Array(n), first: new Int8Array(n), distance: new Int16Array(n) };
  return board;
}

function fallback(state) {
  var legal = state && state.legalMoves || [];
  var direction = state && state.you && state.you.dir || 'up';
  return legal.indexOf(direction) >= 0 ? direction : legal[0] || direction;
}

function move(state) {
  var you = state && state.you;
  if (!you || !you.alive || !you.head || !state.legalMoves || !state.legalMoves.length) return fallback(state);
  var b = prepare(state), snakes = state.snakes || [];
  b.blocked.fill(0); b.food.fill(0); b.seen.fill(0);
  var combat = state.mode === 'battle' || state.mode === 'score' && !state.wrap;
  for (var s = 0; s < snakes.length; s++) {
    var snake = snakes[s];
    if (!snake || !snake.alive) continue;
    var own = snake.id === you.id;
    var mate = state.teams && you.team !== null && snake.team === you.team;
    if (!own && (!combat || mate)) continue;
    var body = snake.body || [];
    for (var j = 0; j < body.length - (own ? 1 : 0); j++) {
      var part = body[j];
      if (part && part.x >= 0 && part.x < b.w && part.y >= 0 && part.y < b.h)
        b.blocked[part.y * b.w + part.x] = 1;
    }
  }
  var foods = state.foods || [];
  for (var f = 0; f < foods.length; f++) {
    var food = foods[f];
    if (food && food.x >= 0 && food.x < b.w && food.y >= 0 && food.y < b.h)
      b.food[food.y * b.w + food.x] = 1;
  }
  var start = you.head.y * b.w + you.head.x;
  var queue = b.queue, first = b.first, distance = b.distance;
  var head = 0, end = 1, safe = -1, bestSpace = -1;
  queue[0] = start; b.seen[start] = 1; distance[start] = 0;
  while (head < end && head < 1500) {
    var cell = queue[head++], nextDistance = distance[cell] + 1;
    if (nextDistance > 40) break;
    for (var d = 0; d < 4; d++) {
      if (cell === start && state.legalMoves.indexOf(DIRECTIONS[d]) < 0) continue;
      var next = b.adjacent[cell * 4 + d];
      if (next < 0 || b.blocked[next] || b.seen[next]) continue;
      b.seen[next] = 1;
      first[next] = cell === start ? d : first[cell];
      distance[next] = nextDistance;
      if (cell === start && safe < 0) safe = d;
      if (b.food[next]) return DIRECTIONS[first[next]];
      if (end < b.n) queue[end++] = next;
    }
  }
  // 无可达食物时，选局部出口最多的一步，而不做四次全图 BFS。
  for (var direction = 0; direction < 4; direction++) {
    if (state.legalMoves.indexOf(DIRECTIONS[direction]) < 0) continue;
    var destination = b.adjacent[start * 4 + direction];
    if (destination < 0 || b.blocked[destination]) continue;
    var exits = 0;
    for (var step = 0; step < 4; step++) {
      var neighbor = b.adjacent[destination * 4 + step];
      if (neighbor >= 0 && !b.blocked[neighbor]) exits++;
    }
    var score = exits * 10 + (DIRECTIONS[direction] === you.dir ? 1 : 0);
    if (score > bestSpace) { bestSpace = score; safe = direction; }
  }
  return safe >= 0 ? DIRECTIONS[safe] : fallback(state);
}

module.exports = { move: move };
