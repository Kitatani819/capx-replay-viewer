import { remoteName } from '../navigation/site';
import type { RemoteListingStatus } from './api';

/** The age of remote data, rather than the time this browser last read its cache. */
export function remoteListingText(status: RemoteListingStatus): string {
  const fetched = status.fetched_at ? new Date(status.fetched_at) : null;
  const time = fetched && !Number.isNaN(fetched.getTime())
    ? `${fetched.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', hour12: false })} 時点`
    : '未取得';
  return `${remoteName()} の一覧：${time}${status.refreshing ? '（更新中…）' : status.error ? '（更新に失敗）' : ''}`;
}
