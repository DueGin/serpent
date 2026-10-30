"""Flood fill: real free-space analysis, food urgency and head-on defense."""

from collections import deque

DIRECTIONS = ("up", "right", "down", "left")
DELTAS = ((0, -1), (1, 0), (0, 1), (-1, 0))
OPPOSITE = {"up": "down", "down": "up", "left": "right", "right": "left"}
_board_key = None
_adjacent = ()


def _prepare(state):
    global _board_key, _adjacent
    width, height = state["width"], state["height"]
    key = (width, height, bool(state.get("wrap")))
    if key == _board_key:
        return
    adjacent = []
    for cell in range(width * height):
        x, y = cell % width, cell // width
        row = []
        for dx, dy in DELTAS:
            nx, ny = x + dx, y + dy
            if key[2]:
                nx, ny = nx % width, ny % height
            row.append(ny * width + nx if 0 <= nx < width and 0 <= ny < height else -1)
        adjacent.append(tuple(row))
    _adjacent = tuple(adjacent)
    _board_key = key


def init(info):
    _prepare(info)


def _cell(point, width, height):
    if point and 0 <= point["x"] < width and 0 <= point["y"] < height:
        return point["y"] * width + point["x"]
    return -1


def _fallback(state):
    legal = state.get("legalMoves") or []
    current = (state.get("you") or {}).get("dir") or "up"
    return current if current in legal else legal[0] if legal else current


def _food_distances(blocked, foods):
    distance = [-1] * len(blocked)
    queue = deque()
    for cell in foods:
        if not blocked[cell]:
            distance[cell] = 0
            queue.append(cell)
    while queue:
        cell = queue.popleft()
        next_distance = distance[cell] + 1
        for neighbor in _adjacent[cell]:
            if neighbor >= 0 and not blocked[neighbor] and distance[neighbor] < 0:
                distance[neighbor] = next_distance
                queue.append(neighbor)
    return distance


def _space(start, blocked, foods, components):
    if components[start] is not None:
        return components[start]
    component = [start]
    components[start] = ()
    narrow, reachable_foods = 0, 0
    for cell in component:
        exits = 0
        if cell in foods:
            reachable_foods += 1
        for neighbor in _adjacent[cell]:
            if neighbor < 0 or blocked[neighbor]:
                continue
            exits += 1
            if components[neighbor] is None:
                components[neighbor] = ()
                component.append(neighbor)
        if exits <= 1:
            narrow += 1
    result = (len(component), reachable_foods, narrow)
    for cell in component:
        components[cell] = result
    return result


def move(state):
    you = state.get("you") or {}
    if not you.get("alive") or not you.get("head") or not state.get("legalMoves"):
        return _fallback(state)
    width, height = state.get("width", 0), state.get("height", 0)
    if width <= 0 or height <= 0:
        return _fallback(state)
    _prepare(state)
    total = width * height
    head = _cell(you["head"], width, height)
    if head < 0:
        return _fallback(state)
    blocked = bytearray(total)
    dangerous_heads = set()
    survival = state.get("maxHp") is not None
    enemy_collision = state["mode"] == "battle" or survival
    for snake in state.get("snakes") or []:
        if not snake or not snake.get("alive"):
            continue
        is_you = snake["id"] == you["id"]
        is_mate = state.get("teams") and you.get("team") is not None and snake.get("team") == you["team"]
        if not is_you and (not enemy_collision or is_mate):
            continue
        for point in snake.get("body") or []:
            cell = _cell(point, width, height)
            if cell >= 0:
                blocked[cell] = 1
        if not is_you and (not survival or snake.get("length", 0) >= you.get("length", 0)):
            enemy_head = _cell(snake.get("head"), width, height)
            if enemy_head >= 0:
                for index, direction in enumerate(DIRECTIONS):
                    cell = _adjacent[enemy_head][index]
                    if cell >= 0 and direction != OPPOSITE.get(snake.get("dir")):
                        dangerous_heads.add(cell)

    foods = {_cell(point, width, height) for point in state.get("foods") or []}
    foods.discard(-1)
    body = you.get("body") or []
    tail = _cell(body[-1], width, height) if body else -1
    hp = you.get("hp") if survival else None
    needed_space = max(10, you.get("length", len(body)) + 3)
    # Cache per connected region, not per direction: keep large maps within budget.
    variants = {}
    best, best_score = None, None
    for index, direction in enumerate(DIRECTIONS):
        if direction not in state["legalMoves"]:
            continue
        cell = _adjacent[head][index]
        if cell < 0:
            continue
        growing = cell in foods
        if growing not in variants:
            obstacles = blocked[:]
            if not growing and tail >= 0:
                obstacles[tail] = 0
            variants[growing] = (obstacles, _food_distances(obstacles, foods), [None] * total)
        obstacles, distances, components = variants[growing]
        if obstacles[cell]:
            continue
        area, reachable_foods, narrow = _space(cell, obstacles, foods, components)
        exits = sum(neighbor >= 0 and not obstacles[neighbor] for neighbor in _adjacent[cell])
        distance = distances[cell]
        score = min(area, needed_space * 3) * 4 + exits * 100 - narrow * 3
        if area < needed_space:
            score -= (needed_space - area) * 240
        if exits == 0:
            score -= 900
        if distance >= 0:
            food_weight = 1.45 if state["mode"] == "score" else 1
            score += 2200 / (distance + 1) * food_weight + min(reachable_foods, 4) * 60
            if hp is not None:
                if distance + 1 > hp:
                    score -= 20000
                elif hp <= max(25, distance + 10):
                    score += 20000 / (distance + 1)
        else:
            score -= 20000 if hp is not None else 1200
        if tail >= 0:
            dx, dy = abs(cell % width - tail % width), abs(cell // width - tail // width)
            if state.get("wrap"):
                dx, dy = min(dx, width - dx), min(dy, height - dy)
            tail_distance = dx + dy
            score += max(0, 12 - tail_distance) * 3
            if area < needed_space * 2 and tail_distance <= 3:
                score += 80
        if cell in dangerous_heads:
            score -= 10000
        if direction == you.get("dir"):
            score += 8
        if best_score is None or score > best_score:
            best, best_score = direction, score
    return best if best is not None else _fallback(state)
