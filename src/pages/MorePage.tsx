import { Card } from '../components/ui';
import { Icon, type IconName } from '../components/icons';
import { useAppStore } from '../state/appStore';
import type { Page } from '../navigation';

/**
 * その他 — every screen that is not one of the four main tabs, by its own name, one tap away.
 * Nothing new here: the same screens that were in the bottom bar or on HOME before.
 */
export function MorePage({ onNavigate, onShowChangelog }: { onNavigate: (page: Page) => void; onShowChangelog: () => void }): React.JSX.Element {
  const store = useAppStore();
  const groups: { title: string; entries: { key: string; icon: IconName; title: string; meta: string; onSelect: () => void }[] }[] = [
    {
      title: 'チーム',
      entries: [
        { key: 'players', icon: 'users', title: 'メンバー', meta: `${store.teamPlayers.length} 名 ・ Rating・PPR・適性`, onSelect: () => onNavigate('players') },
        { key: 'formats', icon: 'format', title: 'フォーマット', meta: `${store.teamFormats.length} 件 ・ ゲーム構成`, onSelect: () => onNavigate('formats') },
        { key: 'pairs', icon: 'pair', title: 'ペア相性', meta: `${store.teamPairs.length} 件設定済み ・ 相性・禁止ペア`, onSelect: () => onNavigate('pairs') },
        { key: 'history', icon: 'history', title: '履歴', meta: `${store.teamOrders.length} 件のオーダー ・ 保存・確定したもの`, onSelect: () => onNavigate('history') },
      ],
    },
    {
      title: 'アプリ',
      entries: [
        { key: 'settings', icon: 'settings', title: '設定 / バックアップ', meta: '重み調整・JSON 入出力', onSelect: () => onNavigate('settings') },
        { key: 'changelog', icon: 'info', title: '更新履歴', meta: `v${__APP_VERSION__} ・ アプリの変更点`, onSelect: onShowChangelog },
      ],
    },
  ];
  return (
    <div className="more-page" data-testid="more-page">
      {groups.map((group) => (
        <Card key={group.title} kicker={group.title === 'チーム' ? 'TEAM' : 'APP'} title={group.title} flush>
          <ul className="list">
            {group.entries.map((entry) => (
              <li key={entry.key}>
                <button type="button" className="list-row" onClick={entry.onSelect}>
                  <span className="lead" aria-hidden="true">
                    <Icon name={entry.icon} size={18} />
                  </span>
                  <span className="grow">
                    <span className="title">{entry.title}</span>
                    <span className="meta">{entry.meta}</span>
                  </span>
                  <Icon name="chevronRight" size={18} className="chevron" />
                </button>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}
