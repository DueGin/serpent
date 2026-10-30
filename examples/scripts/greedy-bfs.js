// 贪心 BFS：避开当前身体，选择到最近食物的第一步；无路时争取更多空间。
var DIRECTIONS = ['up', 'right', 'down', 'left'];
var DELTAS = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 }
];

function pointIndex(x, y, width) {
  return y * width + x;
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
    // survival-64 的 score 与 battle 都会撞非队友身体；classic score 仍穿墙且互不伤害。
    var survivalCombat = state.mode === 'battle' || (state.mode === 'score' && !state.wrap);
    if (!isYou && (!survivalCombat || isMate)) {
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

function search(start, state, blocked, foodMap) {
  var total = state.width * state.height;
  var distance = new Array(total);
  var queue = new Array(total);
  for (var i = 0; i < total; i += 1) {
    distance[i] = -1;
  }

  var startIndex = pointIndex(start.x, start.y, state.width);
  var head = 0;
  var tail = 0;
  var nearestFood = -1;
  queue[tail] = startIndex;
  tail += 1;
  distance[startIndex] = 0;

  while (head < tail) {
    var current = queue[head];
    head += 1;
    var currentDistance = distance[current];
    if (foodMap[current]) {
      nearestFood = currentDistance;
      break;
    }
    var x = current % state.width;
    var y = Math.floor(current / state.width);
    for (var d = 0; d < DELTAS.length; d += 1) {
      var next = normalize(x + DELTAS[d].x, y + DELTAS[d].y, state);
      if (!next) {
        continue;
      }
      var nextIndex = pointIndex(next.x, next.y, state.width);
      if (blocked[nextIndex] || distance[nextIndex] >= 0) {
        continue;
      }
      distance[nextIndex] = currentDistance + 1;
      queue[tail] = nextIndex;
      tail += 1;
    }
  }

  return { foodDistance: nearestFood, area: tail };
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
  var total = state.width * state.height;
  var foodMap = new Array(total);
  var i;
  for (i = 0; i < total; i += 1) {
    foodMap[i] = false;
  }
  var foods = state.foods || [];
  for (i = 0; i < foods.length; i += 1) {
    var food = foods[i];
    if (food && food.x >= 0 && food.x < state.width && food.y >= 0 && food.y < state.height) {
      foodMap[pointIndex(food.x, food.y, state.width)] = true;
    }
  }

  var best = null;
  for (i = 0; i < DIRECTIONS.length; i += 1) {
    var direction = DIRECTIONS[i];
    if (legal.indexOf(direction) < 0) {
      continue;
    }
    var next = nextPoint(you.head, direction, state);
    if (!next || blocked[pointIndex(next.x, next.y, state.width)]) {
      continue;
    }
    var result = search(next, state, blocked, foodMap);
    var candidate = {
      direction: direction,
      foodDistance: result.foodDistance,
      area: result.area,
      straight: direction === you.dir ? 1 : 0
    };
    if (!best) {
      best = candidate;
      continue;
    }

    // 生命值不足以到达最近食物时，先把食物作为硬目标；classic 的 hp 为 null。
    var lowHpUrgency = state.maxHp !== null && you.hp !== null && you.hp <= 25;
    var hasFoodPath = candidate.foodDistance >= 0;
    if (lowHpUrgency && hasFoodPath && candidate.foodDistance < you.hp) {
      candidate.foodPriority = 1;
    } else {
      candidate.foodPriority = 0;
    }
    var bestFoodPriority = best.foodDistance >= 0 && lowHpUrgency && best.foodDistance < you.hp ? 1 : 0;
    if (candidate.foodPriority !== bestFoodPriority) {
      if (candidate.foodPriority > bestFoodPriority) {
        best = candidate;
      }
      continue;
    }
    var bestHasFoodPath = best.foodDistance >= 0;
    if (hasFoodPath !== bestHasFoodPath) {
      if (hasFoodPath) {
        best = candidate;
      }
    } else if (hasFoodPath && candidate.foodDistance !== best.foodDistance) {
      if (candidate.foodDistance < best.foodDistance) {
        best = candidate;
      }
    } else if (candidate.area !== best.area) {
      if (candidate.area > best.area) {
        best = candidate;
      }
    } else if (candidate.straight > best.straight) {
      best = candidate;
    }
  }

  return best ? best.direction : fallback(state);
}

module.exports = { move: move };
