import { useEffect } from 'react';
import { getJson } from '../trace/api';
import { useAsync } from '../trace/hooks';
import { apiRoot, configureSites, currentSiteName, primarySiteName, rememberSite, siteSwitchTarget, type Site } from './site';
import './siteTabs.css';

export function SiteTabsControl({ sites, pathname, current = currentSiteName() }: {
  sites: readonly Site[]; pathname: string; current?: string;
}) {
  if (sites.length < 2) return null;
  return <nav className="site-tabs" aria-label="接続先">
    {sites.map(site => <a key={site.name} href={siteSwitchTarget(site, pathname)}
      aria-current={current === site.name ? 'page' : undefined}
      onClick={() => rememberSite(site.name)}>{site.label}</a>)}
  </nav>;
}

export function SiteTabs() {
  const sites = useAsync(signal => getJson<Site[]>(`${apiRoot(primarySiteName())}/sites`, signal), []);
  useEffect(() => {
    if (Array.isArray(sites.data) && configureSites(sites.data)) window.location.replace('/evals');
  }, [sites.data]);
  return <SiteTabsControl sites={Array.isArray(sites.data) ? sites.data : []} pathname={window.location.pathname} />;
}
