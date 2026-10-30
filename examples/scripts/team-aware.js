// 组队策略：穿过队友、分配食物、分散站位，并用距离图评估敌人压力。
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

function isMate(snake, state) {
  return state.teams && state.you && state.you.team !== null && snake.team === state.you.team;
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
    // survival-64 的 score/battle 都会撞非队友身体；classic score 仍穿墙。
    var survivalCombat = state.mode === 'battle' || (state.mode === 'score' && !state.wrap);
    if (!isYou && (!survivalCombat || isMate(snake, state))) {
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

function distanceMapFrom(start, state, blocked) {
  var total = state.width * state.height;
  var distance = new Array(total);
  var queue = new Array(total);
  for (var i = 0; i < total; i += 1) {
    distance[i] = -1;
  }

  var head = 0;
  var tail = 0;
  var startIndex = pointIndex(start.x, start.y, state.width);
  queue[tail] = startIndex;
  tail += 1;
  distance[startIndex] = 0;

  while (head < tail) {
    var current = queue[head];
    head += 1;
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
      distance[nextIndex] = distance[current] + 1;
      queue[tail] = nextIndex;
      tail += 1;
    }
  }
  return distance;
}

function buildSnakeMaps(state, blocked, wantMates) {
  var maps = [];
  var snakes = state.snakes || [];
  for (var i = 0; i < snakes.length; i += 1) {
    var snake = snakes[i];
    if (!snake || !snake.alive || !snake.head || snake.id === state.you.id) {
      continue;
    }
    var mate = isMate(snake, state);
    if ((wantMates && !mate) || (!wantMates && mate)) {
      continue;
    }
    if (!wantMates && !(state.mode === 'battle' || (state.mode === 'score' && !state.wrap))) {
      continue;
    }
    maps.push({
      slot: snake.slot,
      head: snake.head,
      distance: distanceMapFrom(snake.head, state, blocked)
    });
  }
  return maps;
}

function analyzeSpace(start, state, blocked, foodMap, enemyMaps) {
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
  var reachableFoods = 0;
  var narrowCells = 0;
  var secureArea = 0;
  queue[tail] = startIndex;
  tail += 1;
  distance[startIndex] = 0;

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

    var secure = true;
    for (var e = 0; e < enemyMaps.length; e += 1) {
      var enemyDistance = enemyMaps[e].distance[current];
      if (enemyDistance >= 0 && enemyDistance <= distance[current]) {
        secure = false;
        break;
      }
    }
    if (secure) {
      secureArea += 1;
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
      if (distance[nextIndex] >= 0) {
        continue;
      }
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
    narrowCells: narrowCells,
    secureArea: secureArea,
    distance: distance
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
  var survivalCombat = state.mode === 'battle' || (state.mode === 'score' && !state.wrap);
  if (!survivalCombat) {
    return false;
  }
  var snakes = state.snakes || [];
  for (var i = 0; i < snakes.length; i += 1) {
    var snake = snakes[i];
    if (!snake || !snake.alive || !snake.head || snake.id === state.you.id || isMate(snake, state)) {
      continue;
    }
    var incoming = directionBetween(snake.head, point, state);
    // 不短于自己的敌方蛇头对撞会获胜；更短的敌方可迎头。
    if (incoming && OPPOSITE[snake.dir] !== incoming && (snake.length || 0) >= (state.you.length || 0)) {
      return true;
    }
  }
  return false;
}

function foodCooperation(state, analysis, mateMaps) {
  if (!state.teams || mateMaps.length === 0) {
    return 0;
  }
  var score = 0;
  var foods = state.foods || [];
  for (var i = 0; i < foods.length; i += 1) {
    var food = foods[i];
    if (!food || food.x < 0 || food.x >= state.width || food.y < 0 || food.y >= state.height) {
      continue;
    }
    var index = pointIndex(food.x, food.y, state.width);
    var mine = analysis.distance[index];
    if (mine < 0) {
      continue;
    }
    var mateBest = -1;
    var mateSlot = 999;
    for (var m = 0; m < mateMaps.length; m += 1) {
      var mateDistance = mateMaps[m].distance[index];
      if (mateDistance >= 0 && (mateBest < 0 || mateDistance < mateBest)) {
        mateBest = mateDistance;
        mateSlot = mateMaps[m].slot;
      }
    }

    var mineFirst = mateBest < 0 || mine < mateBest || (mine === mateBest && state.you.slot < mateSlot);
    if (mineFirst) {
      // 自己更近（或同距 slot 更小）时认领，降低两人抢同一食物的概率。
      score += 28 + 100 / (mine + 1);
    } else {
      score -= 40 / (mine + 1);
    }
  }
  return score;
}

function mateSpacing(point, state, mateMaps) {
  if (!state.teams || mateMaps.length === 0) {
    return 0;
  }
  var nearest = -1;
  for (var i = 0; i < mateMaps.length; i += 1) {
    var distance = distanceBetween(point, mateMaps[i].head, state);
    if (nearest < 0 || distance < nearest) {
      nearest = distance;
    }
  }
  if (nearest <= 1) {
    return -30;
  }
  if (nearest <= 6) {
    return 14;
  }
  return 0;
}

function enemyPressure(point, state, enemyMaps) {
  var penalty = 0;
  for (var i = 0; i < enemyMaps.length; i += 1) {
    var distance = distanceBetween(point, enemyMaps[i].head, state);
    if (distance <= 2) {
      penalty += (3 - distance) * 45;
    }
  }
  return penalty;
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
  var mateMaps = buildSnakeMaps(state, blocked, true);
  var enemyMaps = buildSnakeMaps(state, blocked, false);
  var neededSpace = Math.max(10, you.length + 3);
  var best = null;

  for (var i = 0; i < DIRECTIONS.length; i += 1) {
    var direction = DIRECTIONS[i];
    if (legal.indexOf(direction) < 0) {
      continue;
    }
    var next = nextPoint(you.head, direction, state);
    if (!next || blocked[pointIndex(next.x, next.y, state.width)]) {
      continue;
    }

    var analysis = analyzeSpace(next, state, blocked, foodMap, enemyMaps);
    var exits = countExits(next, state, blocked);
    var score = 0;

    score += Math.min(analysis.area, neededSpace * 3) * 11;
    score += Math.min(analysis.secureArea, neededSpace * 2) * 5;
    if (analysis.area < neededSpace) {
      score -= (neededSpace - analysis.area) * 170;
    }
    if (state.mode === 'battle' && analysis.secureArea < Math.min(neededSpace, analysis.area)) {
      score -= 60;
    }
    score += exits * 85;
    score -= analysis.narrowCells * 2;
    if (exits === 0) {
      score -= 700;
    }

    if (analysis.nearestFood >= 0) {
      var foodWeight = state.mode === 'score' ? 1.4 : 1;
      score += (500 / (analysis.nearestFood + 1)) * foodWeight;
      score += Math.min(analysis.reachableFoods, 4) * 20;
      if (state.maxHp !== null && you.hp !== null && you.hp <= 25 && analysis.nearestFood < you.hp) {
        score += 4000 / (analysis.nearestFood + 1);
      }
    } else {
      score -= 350;
    }

    score += foodCooperation(state, analysis, mateMaps);
    score += mateSpacing(next, state, mateMaps);
    score -= enemyPressure(next, state, enemyMaps);

    var tailDistance = ownTailDistance(next, state);
    score += Math.max(0, 12 - tailDistance) * 3;
    if (analysis.area < neededSpace * 2 && tailDistance <= 3) {
      score += 45;
    }

    if (hasHeadOnRisk(next, state)) {
      score -= 12000;
    }
    if (direction === you.dir) {
      score += 6;
    }

    if (!best || score > best.score) {
      best = { direction: direction, score: score };
    }
  }

  return best ? best.direction : fallback(state);
}

module.exports = { move: move };
