// 最简示例：能直行就直行，否则选第一个合法方向。
function move(state) {
  var you = state && state.you;
  var current = you && you.dir ? you.dir : 'up';
  var legal = state && state.legalMoves ? state.legalMoves : [];

  if (legal.indexOf(current) >= 0) {
    return current;
  }
  if (legal.length > 0) {
    return legal[0];
  }
  return current;
}

module.exports = { move: move };
