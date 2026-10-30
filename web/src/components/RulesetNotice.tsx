export function RulesetNotice({ season = false }: { season?: boolean }) {
  return (
    <section className="ruleset-notice" aria-label="survival-64 规则摘要">
      <div className="ruleset-notice-heading">
        <span className="pill valid">SURVIVAL-64</span>
        {season && <strong>新赛季（survival-64）积分已清零</strong>}
      </div>
      <p>64×64 有边界地图 · 初始生命值 100，每拍未进食减 1，吃果实回满 · 果实数为参赛人数 × 4</p>
      <p>撞墙、咬自己或撞到非队友蛇身会出局；头对头长者胜，等长同归于尽；队友仍可互相穿过。</p>
      {season && <span className="ruleset-season-note">历史对局与回放保留，单人基准成绩同步重置。</span>}
    </section>
  );
}
