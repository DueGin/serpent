import { defaultConfig, shutdownRunner, simulate } from './index';

export const BFS_SCRIPT = String.raw`
function move(s) {
  var ds = ['up', 'down', 'left', 'right'], dx = [0, 0, -1, 1], dy = [-1, 1, 0, 0];
  var w = s.width, h = s.height, n = w*h, head = s.you.head, start = head.y*w+head.x;
  var blocked = new Uint8Array(n), goals = new Uint8Array(n), seen = new Uint8Array(n);
  for (var j=0;j<s.snakes.length;j++) {
    var snake=s.snakes[j];
    if (!snake.alive || snake.id!==s.you.id && (s.teams&&snake.team===s.you.team || s.mode==='score'&&s.wrap)) continue;
    for(var k=0;k<snake.body.length-(snake.id===s.you.id?1:0);k++) blocked[snake.body[k].y*w+snake.body[k].x]=1;
    if(snake.id!==s.you.id && snake.length>=s.you.length) for(var d=0;d<4;d++) { var ax=snake.head.x+dx[d],ay=snake.head.y+dy[d]; if(s.wrap){ax=(ax+w)%w;ay=(ay+h)%h;} if(ax>=0&&ay>=0&&ax<w&&ay<h)blocked[ay*w+ax]=1; }
  }
  for(var k=0;k<s.foods.length;k++) goals[s.foods[k].y*w+s.foods[k].x]=1;
  var queue=[start], first=[-1]; seen[start]=1; var safe=[];
  for(var qi=0;qi<queue.length;qi++) {
    var cell=queue[qi], x=cell%w,y=(cell/w)|0;
    for(var d=0;d<4;d++) {
      if(qi===0&&s.legalMoves.indexOf(ds[d])<0)continue;
      var nx=x+dx[d],ny=y+dy[d];
      if(s.wrap){nx=(nx+w)%w;ny=(ny+h)%h;}
      if(nx<0||ny<0||nx>=w||ny>=h)continue;
      var next=ny*w+nx;
      if(blocked[next]||seen[next])continue;
      seen[next]=1;var f=qi===0?d:first[qi];
      if(qi===0)safe.push(d);
      if(goals[next])return ds[f];
      queue.push(next);first.push(f);
    }
  }
  return safe.length?ds[safe[0]]:s.legalMoves[0]||s.you.dir;
}

`;

export async function runBenchmark(): Promise<void> {
  const started = performance.now();
  try {
    const result = await simulate({
      config: defaultConfig('battle', { seed: 132, players: 4, maxTicks: 1000 }),
      participants: Array.from({ length: 4 }, (_, slot) => ({
        slot, name: `BFS-${slot}`, team: null,
        source: { kind: 'script' as const, code: BFS_SCRIPT },
      })),
      captureLogs: false,
    });
    console.log(JSON.stringify({
      seed: 132, ticks: result.ticks, endReason: result.endReason,
      durationMs: result.durationMs, totalMs: Math.round(performance.now() - started),
      participants: result.participants.map(({ slot, score, moves, errors, timeouts, invalidMoves, avgMoveMs, maxMoveMs }) => ({
        slot, score, moves, errors, timeouts, invalidMoves, avgMoveMs, maxMoveMs,
      })),
    }, null, 2));
  } finally { await shutdownRunner(); }
}

if (require.main === module) {
  void runBenchmark().catch(error => { console.error(error); process.exitCode = 1; });
}
