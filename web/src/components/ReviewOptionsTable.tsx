import type { ReviewOption } from '../types';
import { DEATH_LABEL } from '../utils';
import { DIRECTION_LABEL } from './reviewLabels';

export function ReviewOptionsTable({ options }: { options: ReviewOption[] }) {
  if (options.length === 0) return <p className="hint">这一拍没有候选方向。</p>;
  return (
    <div className="review-options-wrap">
      <table className="review-options">
        <thead>
          <tr><th>方向</th><th>合法</th><th>一步结果</th><th>可达空间</th><th>选择</th></tr>
        </thead>
        <tbody>
          {options.map((option) => (
            <tr className={option.chosen ? 'is-chosen' : option.legal && option.death === null ? 'is-safe' : 'is-deadly'} key={option.dir}>
              <td>{DIRECTION_LABEL[option.dir]} <code>{option.dir}</code></td>
              <td>{option.legal ? '是' : '否'}</td>
              <td>{option.death === null ? option.legal ? '存活' : '不可走' : DEATH_LABEL[option.death]}</td>
              <td className="number">{option.space}</td>
              <td>{option.chosen ? '✓ 实际' : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
