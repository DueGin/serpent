"""Greedy BFS: seek reachable food, otherwise prefer more free space."""

from collections import deque

DIRECTIONS = ("up", "right", "down", "left")
DELTAS = ((0, -1), (1, 0), (0, 1), (-1, 0))
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
    # maxHp distinguishes survival rules from historic classic score matches.
    enemy_collision = state["mode"] == "battle" or state.get("maxHp") is not None
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

    # One reverse BFS yields the exact nearest-food distance for every candidate.
    distance = [-1] * total
    queue = deque()
    for point in state.get("foods") or []:
        cell = _cell(point, width, height)
        if cell >= 0 and not blocked[cell] and distance[cell] < 0:
            distance[cell] = 0
            queue.append(cell)
    while queue:
        cell = queue.popleft()
        next_distance = distance[cell] + 1
        for neighbor in _adjacent[cell]:
            if neighbor >= 0 and not blocked[neighbor] and distance[neighbor] < 0:
                distance[neighbor] = next_distance
                queue.append(neighbor)

    areas = [0] * total

    def area_from(start):
        if areas[start]:
            return areas[start]
        component = [start]
        areas[start] = -1
        for cell in component:
            for neighbor in _adjacent[cell]:
                if neighbor >= 0 and not blocked[neighbor] and areas[neighbor] == 0:
                    areas[neighbor] = -1
                    component.append(neighbor)
        area = len(component)
        for cell in component:
            areas[cell] = area
        return area

    hp = you.get("hp") if state.get("maxHp") is not None else None
    best, best_rank = None, None
    for index, direction in enumerate(DIRECTIONS):
        if direction not in state["legalMoves"]:
            continue
        cell = _adjacent[head][index]
        if cell < 0 or blocked[cell]:
            continue
        food_distance = distance[cell]
        reachable = food_distance >= 0
        in_time = reachable and (hp is None or food_distance + 1 <= hp)
        rank = (in_time, reachable, -food_distance if reachable else 0, area_from(cell), direction == you.get("dir"))
        if best_rank is None or rank > best_rank:
            best, best_rank = direction, rank
    return best if best is not None else _fallback(state)
