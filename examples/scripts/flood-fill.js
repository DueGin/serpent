// 洪泛策略：真实计算可达空间、食物与出口，并规避头对头和自困。
var DIRECTIONS = ['up', 'right', 'down', 'left'];
var DELTAS = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 }
];
var OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

function pointIndex(x, y, width) {
  return y * width + x;
}

function samePoint(a, b) {
  return a && b && a.x === b.x && a.y === b.y;
}

function normalize(x, y, state) {
  if (state.wrap) {
    return {
      x: (x + state.width) % state.width,
      y: (y + state.height) % state.height
    };
  }
  if (x < 0 || x >= state.width || y < 0 || y >= state.height) {
    return null;
  }
  return { x: x, y: y };
}

function nextPoint(head, direction, state) {
  var index = DIRECTIONS.indexOf(direction);
  if (index < 0) {
    return null;
  }
  return normalize(head.x + DELTAS[index].x, head.y + DELTAS[index].y, state);
}

function distanceBetween(a, b, state) {
  var dx = Math.abs(a.x - b.x);
  var dy = Math.abs(a.y - b.y);
  if (state.wrap) {
    dx = Math.min(dx, state.width - dx);
    dy = Math.min(dy, state.height - dy);
  }
  return dx + dy;
}

function buildBlocked(state) {
  var total = state.width * state.height;
  var blocked = new Array(total);
  var i;
  for (i = 0; i < total; i += 1) {
    blocked[i] = false;
  }

  var snakes = state.snakes || [];
  var you = state.you;
  for (i = 0; i < snakes.length; i += 1) {
    var snake = snakes[i];
    if (!snake || !snake.alive) {
      continue;
    }
    var isYou = you && snake.id === you.id;
    var isMate = state.teams && you && you.team !== null && snake.team === you.team;
    if (!isYou && (state.mode !== 'battle' || isMate)) {
      continue;
    }
    var body = snake.body || [];
    for (var j = 0; j < body.length; j += 1) {
      var part = body[j];
      if (part && part.x >= 0 && part.x < state.width && part.y >= 0 && part.y < state.height) {
        blocked[pointIndex(part.x, part.y, state.width)] = true;
      }
    }
  }
  return blocked;
}

function buildFoodMap(state) {
  var total = state.width * state.height;
  var foodMap = new Array(total);
  for (var i = 0; i < total; i += 1) {
    foodMap[i] = false;
  }
  var foods = state.foods || [];
  for (i = 0; i < foods.length; i += 1) {
    var food = foods[i];
    if (food && food.x >= 0 && food.x < state.width && food.y >= 0 && food.y < state.height) {
      foodMap[pointIndex(food.x, food.y, state.width)] = true;
    }
  }
  return foodMap;
}

function analyzeSpace(start, state, blocked, foodMap) {
  var total = state.width * state.height;
  var seen = new Array(total);
  var distance = new Array(total);
  var queue = new Array(total);
  for (var i = 0; i < total; i += 1) {
    seen[i] = false;
    distance[i] = 0;
  }

  var startIndex = pointIndex(start.x, start.y, state.width);
  var head = 0;
  var tail = 0;
  var nearestFood = -1;
  var reachableFoods = 0;
  var narrowCells = 0;
  queue[tail] = startIndex;
  tail += 1;
  seen[startIndex] = true;

  while (head < tail) {
    var current = queue[head];
    head += 1;
    var x = current % state.width;
    var y = Math.floor(current / state.width);
    var exits = 0;

    if (foodMap[current]) {
      reachableFoods += 1;
      if (nearestFood < 0) {
        nearestFood = distance[current];
      }
    }

    for (var d = 0; d < DELTAS.length; d += 1) {
      var next = normalize(x + DELTAS[d].x, y + DELTAS[d].y, state);
      if (!next) {
        continue;
      }
      var nextIndex = pointIndex(next.x, next.y, state.width);
      if (blocked[nextIndex]) {
        continue;
      }
      exits += 1;
      if (seen[nextIndex]) {
        continue;
      }
      seen[nextIndex] = true;
      distance[nextIndex] = distance[current] + 1;
      queue[tail] = nextIndex;
      tail += 1;
    }

    if (exits <= 1) {
      narrowCells += 1;
    }
  }

  return {
    area: tail,
    nearestFood: nearestFood,
    reachableFoods: reachableFoods,
    narrowCells: narrowCells
  };
}

function countExits(point, state, blocked) {
  var count = 0;
  for (var d = 0; d < DELTAS.length; d += 1) {
    var next = normalize(point.x + DELTAS[d].x, point.y + DELTAS[d].y, state);
    if (next && !blocked[pointIndex(next.x, next.y, state.width)]) {
      count += 1;
    }
  }
  return count;
}

function directionBetween(from, to, state) {
  for (var d = 0; d < DIRECTIONS.length; d += 1) {
    var point = nextPoint(from, DIRECTIONS[d], state);
    if (samePoint(point, to)) {
      return DIRECTIONS[d];
    }
  }
  return null;
}

function hasHeadOnRisk(point, state) {
  if (state.mode !== 'battle') {
    return false;
  }
  var snakes = state.snakes || [];
  var you = state.you;
  for (var i = 0; i < snakes.length; i += 1) {
    var snake = snakes[i];
    if (!snake || !snake.alive || !snake.head || snake.id === you.id) {
      continue;
    }
    var isMate = state.teams && you.team !== null && snake.team === you.team;
    if (isMate) {
      continue;
    }
    var incoming = directionBetween(snake.head, point, state);
    // 敌人不能 180° 掉头进入该格时，本拍没有这次头对头风险。
    if (incoming && OPPOSITE[snake.dir] !== incoming) {
      return true;
    }
  }
  return false;
}

function ownTailDistance(point, state) {
  var body = state.you.body || [];
  if (body.length < 2) {
    return 0;
  }
  var tail = body[body.length - 1];
  return tail ? distanceBetween(point, tail, state) : 0;
}

function fallback(state) {
  var legal = state && state.legalMoves ? state.legalMoves : [];
  var current = state && state.you && state.you.dir ? state.you.dir : 'up';
  if (legal.indexOf(current) >= 0) {
    return current;
  }
  return legal.length > 0 ? legal[0] : current;
}

function move(state) {
  var you = state && state.you;
  if (!you || !you.alive || !you.head) {
    return fallback(state);
  }
  var legal = state.legalMoves || [];
  if (legal.length === 0) {
    return fallback(state);
  }

  var blocked = buildBlocked(state);
  var foodMap = buildFoodMap(state);
  var neededSpace = Math.max(10, you.length + 3);
  var best = null;

  for (var i = 0; i < DIRECTIONS.length; i += 1) {
    var direction = DIRECTIONS[i];
    if (legal.indexOf(direction) < 0) {
      continue;
    }
    var next = nextPoint(you.head, direction, state);
    if (!next) {
      continue;
    }

    var nextIndex = pointIndex(next.x, next.y, state.width);
    var nextBlocked = blocked.slice();
    var body = you.body || [];
    var tail = body[body.length - 1];
    // 本拍不吃食物时己方尾格会腾空；敌人下一步未知，因此仍保守保留其身体。
    if (!foodMap[nextIndex] && tail) {
      nextBlocked[pointIndex(tail.x, tail.y, state.width)] = false;
    }
    if (nextBlocked[nextIndex]) {
      continue;
    }

    var analysis = analyzeSpace(next, state, nextBlocked, foodMap);
    var exits = countExits(next, state, nextBlocked);
    var headOnRisk = hasHeadOnRisk(next, state);
    var score = 0;

    // 先排除容纳不下身体的区域，安全区域内以有效寻食为主、空间质量为辅。
    score += Math.min(analysis.area, neededSpace * 3) * 4;
    if (analysis.area < neededSpace) {
      score -= (neededSpace - analysis.area) * 240;
    }
    score += exits * 100;
    score -= analysis.narrowCells * 3;
    if (exits === 0) {
      score -= 900;
    }

    if (analysis.nearestFood >= 0) {
      var foodWeight = state.mode === 'score' ? 1.45 : 1;
      score += (2200 / (analysis.nearestFood + 1)) * foodWeight;
      score += Math.min(analysis.reachableFoods, 4) * 60;
    } else {
      score -= 1200;
    }

    var tailDistance = ownTailDistance(next, state);
    score += Math.max(0, 12 - tailDistance) * 3;
    if (analysis.area < neededSpace * 2 && tailDistance <= 3) {
      score += 80;
    }

    if (headOnRisk) {
      score -= 10000;
    }
    if (direction === you.dir) {
      score += 8;
    }

    if (!best || score > best.score) {
      best = { direction: direction, score: score };
    }
  }

  return best ? best.direction : fallback(state);
}

module.exports = { move: move };
