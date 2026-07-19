// SPA route watcher.
//
// x.com never reloads: navigating between tweets swaps the DOM under a
// pushState. Polling location is deliberate — a MutationObserver over X's
// document fires constantly on a virtualised timeline, and the Navigation API
// is not something to depend on here.

const POLL_MS = 400;

/** `/<handle>/status/<id>` -> the id. Null on any other page. */
export function focalIdFrom(pathname: string): string | null {
  const match = /^\/[^/]+\/status\/(\d+)/.exec(pathname);
  return match?.[1] ?? null;
}

export interface Route {
  href: string;
  focalId: string | null;
}

export function currentRoute(): Route {
  return {
    href: window.location.href,
    focalId: focalIdFrom(window.location.pathname),
  };
}

/**
 * Call `onChange` whenever the route changes, including once on start.
 * Returns a teardown function.
 */
export function watchRoute(onChange: (route: Route) => void): () => void {
  let previous = '';

  const check = (): void => {
    const route = currentRoute();
    if (route.href === previous) return;
    previous = route.href;
    onChange(route);
  };

  const timer = setInterval(check, POLL_MS);
  window.addEventListener('popstate', check);
  check();

  return () => {
    clearInterval(timer);
    window.removeEventListener('popstate', check);
  };
}
