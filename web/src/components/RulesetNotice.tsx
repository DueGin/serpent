export function RulesetNotice({ season = false }: { season?: boolean }) {
  return (
    <section className="ruleset-notice" aria-label="survival 规则摘要">
      <div className="ruleset-notice-heading">
        <span className="pill valid">SURVIVAL</span>
        {season && <strong>新赛季（survival）积分已清零</strong>}
      </div>
      <p>个人赛（含单人基准）16×16、2v2 团队赛 32×32，有边界 · 初始生命值 100，每拍未进食减 1，吃果实回满 · 果实数为参赛人数 × 4</p>
      <p>撞墙、咬自己或撞到非队友蛇身会出局；头对头长者胜，等长同归于尽；队友仍可互相穿过。生存战与抢分赛都在只剩一方存活时结束。</p>
      {season && <span className="ruleset-season-note">历史对局与回放保留，单人基准成绩同步重置。</span>}
    </section>
  );
}
