/** Site selection belongs to this browser tab; the URL always wins over storage. */
export interface Site { name: string; label: string; primary: boolean }

export const SITE_STORAGE_KEY = 'capx-replay-site';
const SITE_NAME = /^[a-z0-9-]{1,32}$/;
let primaryName = 'b300';
let labels = new Map<string, string>();

export function primarySiteName(): string { return primaryName; }

export function rememberSite(name: string): void {
  try { window.sessionStorage.setItem(SITE_STORAGE_KEY, name); } catch { /* Storage may be blocked. */ }
}

/** Also restores the query on links which omitted it, so copied links stay on this site. */
export function currentSiteName(): string {
  if (typeof window === 'undefined') return primaryName;
  const params = new URLSearchParams(window.location.search);
  const explicit = params.get('site');
  let saved: string | null = null;
  try { saved = window.sessionStorage.getItem(SITE_STORAGE_KEY); } catch { /* Private/embedded browsers. */ }
  const name = explicit && SITE_NAME.test(explicit) ? explicit
    : saved && SITE_NAME.test(saved) ? saved : primaryName;
  rememberSite(name);
  params.set('site', name);
  const search = params.toString();
  const url = `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`;
  if (url !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
    window.history.replaceState(null, '', url);
  }
  return name;
}

/** Returns true when a removed site was reset and the page's data must be reloaded. */
export function configureSites(sites: readonly Site[]): boolean {
  labels = new Map(sites.map(site => [site.name, site.label]));
  const primary = sites.find(site => site.primary);
  if (primary && SITE_NAME.test(primary.name)) primaryName = primary.name;
  const selected = currentSiteName();
  if (!sites.length || sites.some(site => site.name === selected)) return false;
  rememberSite(primaryName);
  const params = new URLSearchParams(window.location.search);
  params.set('site', primaryName);
  window.history.replaceState(null, '', `${window.location.pathname}?${params}${window.location.hash}`);
  currentSiteName();
  return true;
}

/** The only place that chooses between the primary and additional API namespaces. */
export function apiRoot(name = currentSiteName()): string {
  return name === primaryName ? '/api' : `/api/sites/${encodeURIComponent(name)}`;
}

/** Page links are explicit too, including links opened in a new browser tab. */
export function siteHref(href: string, name = currentSiteName()): string {
  if (!href.startsWith('/') || href.startsWith('//')) return href;
  const url = new URL(href, 'http://localhost');
  url.searchParams.set('site', name);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** IDs belong to one site, so changing sites leaves evaluation/trial detail pages. */
export function siteSwitchTarget(site: Site, pathname: string): string {
  const path = pathname.replace(/\/$/, '');
  const params = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
  const picker = path === '/traces' && !['run', 'episode', 'legacy_run'].some(key => params.has(key));
  const target = new URL(siteHref(picker ? '/traces' : '/evals', site.name), 'http://localhost');
  // An explicit primary also overrides cloned sessionStorage when opened in a new tab.
  if (site.primary) target.searchParams.set('site', site.name);
  return `${target.pathname}${target.search}`;
}

/** The remote machine in messages: GMO for the primary (B300) site, else the site's label (RTX). */
export function remoteName(name = currentSiteName()): string {
  return name === primaryName ? 'GMO' : labels.get(name) ?? name.toUpperCase();
}
