import { useEffect, useState, useSyncExternalStore } from 'react';
import { ArrowUpRight, Coins, X } from 'lucide-react';
import { hosted, shortOf } from '../lib/client';
import { finished, isWorking, money, type RunView } from '../lib/run';
import { useT } from '../i18n';

/** a hosted service's credits, read on load, every half minute and whenever the tab comes back into view (a film spends
 * as it is made); null without billing or until the first read */
export function useCredits() {
  const credits = hosted?.credits;
  const [state, setState] = useState<{ available: number; perMinute: number; plan?: string; styles?: string[] | null } | null>(null);
  useEffect(() => {
    if (!credits) return;
    let alive = true;
    const read = () => { if (!document.hidden) credits.read().then((s) => { if (alive) setState(s); }, () => {}); };
    read();
    const timer = setInterval(read, 30_000);
    document.addEventListener('visibilitychange', read);
    return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', read); };
  }, [credits]);
  return state && credits ? { ...state, url: credits.url } : null;
}

/** what a film has spent on a hosted service, and what its go-ahead needs (read again every ten seconds while it is
 * being made); null elsewhere, and until the service has answered */
export function useFilmCredits(project: string, run: RunView) {
  const spent = hosted?.credits?.spent;
  const working = isWorking(run);
  const [v, setV] = useState<{ spent: number; goAhead?: number; cost?: number } | null>(null);
  useEffect(() => {
    if (!spent) return;
    let alive = true;
    const read = () => { if (!document.hidden) spent(project).then((r) => { if (alive) setV(r); }, () => {}); };
    read();
    // and once more as it stops: its last charges land a moment after
    const timer = working ? setInterval(read, 10_000) : setTimeout(read, 3_000);
    return () => { alive = false; clearInterval(timer); };
  }, [spent, project, working]);
  return v;
}

/** what a film has spent, as a line of text: on a hosted service its credits, never money; elsewhere what it cost.
 * null until a hosted service has answered, or without billing */
export function useSpent(project: string, run: RunView) {
  const { t, locale } = useT();
  const v = useFilmCredits(project, run);
  if (!hosted) return money(run.cost);
  return v == null ? null : t('common.credits', { n: v.spent.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US') });
}

/** on a hosted service, what this film has spent; its admins also see what it cost the service. Until the film is first
 *  ready it says nothing of credits: a count running up through the storyboard read as a film costing far more than it
 *  does, and a quote reads as a promise of what a film costs, which no one can know before it is made (2026-10-29) */
export function FilmCredits({ project, run }: { project: string; run: RunView }) {
  const { t, locale } = useT();
  const v = useFilmCredits(project, run);
  if (!v) return null;
  const making = !finished(run);
  if (making && v.cost == null) return null;
  const fmt = (n: number) => n.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US');
  const cost = v.cost != null ? money({ amount: v.cost, currency: 'USD' }) : '';
  return (
    <span className="shrink-0 text-[12.5px] text-ink-3 tabular" title={t(making ? 'common.filmCostTitle' : 'common.filmSpentTitle')}>
      {making ? cost : t('common.filmSpent', { n: fmt(v.spent) })}
      {!making && cost && <span title={t('common.filmCostTitle')}>{` · ${cost}`}</span>}
    </span>
  );
}

/** the balance, quiet in the top bar: what is left to spend, only to read (billing is in the account menu); below a
 * minute of film it says so. A div, not a span: the Cloud shell hides the header's titled spans (the email) */
export function Credits() {
  const { t, locale } = useT();
  const state = useCredits();
  const credits = hosted?.credits;
  if (!credits || !state) return null;
  const low = state.available < state.perMinute;
  const fmt = (n: number) => Math.max(0, n).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US');
  return (
    <div title={t('common.creditsTitle')}
      className={`hidden h-8 shrink-0 cursor-default select-none items-center gap-2 rounded-lg border px-2.5 text-[12.5px] tabular-nums sm:inline-flex ${low ? 'border-seal/40 text-seal' : 'border-line text-ink-2'}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${low ? 'bg-seal' : 'bg-accent'}`} aria-hidden />
      {t('common.creditsLeft', { n: fmt(state.available) })}
      {low && <span className="sr-only">{t('common.creditsLow')}</span>}
    </div>
  );
}

// ── not enough credits ──
// A hosted service starts a step of a film (the go-ahead, a change, an export, carrying on) only when the balance covers
// it. What it refused is said once, above the composer, with where to top up, until the balance covers it.

type Short = { project: string; needed: number; available: number };
let short: Short | null = null;
const listeners = new Set<() => void>();
const setShort = (s: Short | null) => { short = s; listeners.forEach((f) => f()); };
const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };

/** a refusal for want of credits is shown in the workbench (true); anything else is the caller's to say (false) */
export function reportShort(project: string, e: unknown) {
  const s = shortOf(e);
  if (s) setShort({ project, ...s });
  return !!s;
}
/** for an action's catch: a refusal for want of credits is shown in the workbench; anything else is thrown on */
export const orShort = (project: string) => (e: unknown) => { if (!reportShort(project, e)) throw e; };

/** what this film can't do for want of credits, with the balance as it is now: the step refused last, else the go-ahead
 * of a storyboard waiting for it. null once the balance covers it (topped up in another tab: read again on coming back) */
export function useShort(project: string, run: RunView) {
  const s = useSyncExternalStore(subscribe, () => short);
  const credits = useCredits();
  const film = useFilmCredits(project, run);
  const have = credits?.available;
  const refused = s?.project === project ? s : null;
  if (refused && (have ?? refused.available) < refused.needed) return { kind: 'step' as const, needed: refused.needed, available: have ?? refused.available };
  const need = film?.goAhead;
  // the storyboard's go-ahead (the first page's comes after it, with the film already under way)
  if (run.awaitingApproval && !run.firstPage && need && have != null && have < need) return { kind: 'goAhead' as const, needed: need, available: have };
  // the film was stopped part-way for want of credits: said until the balance is topped up
  if (run.paused?.reason === 'credits' && (have == null || have <= 0)) return { kind: 'stopped' as const, needed: 0, available: have ?? 0 };
  return null;
}

/** the notice: what it needs, what there is, and the way to top up (in a new tab: the film stays where it is) */
export function ShortNotice({ project, run }: { project: string; run: RunView }) {
  const { t, locale } = useT();
  const s = useShort(project, run);
  const url = hosted?.credits?.url;
  if (!s || !url) return null;
  const fmt = (n: number) => Math.max(0, n).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US');
  const said = t(s.kind === 'goAhead' ? 'common.short.goAhead' : s.kind === 'stopped' ? 'common.short.stopped' : 'common.short.step', { need: fmt(s.needed), have: fmt(s.available) });
  return (
    <div className="flex items-start gap-3 border-b border-line bg-seal-soft/50 px-5 py-3 animate-rise" role="alert">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-seal-soft text-seal" aria-hidden><Coins size={13} /></span>
      <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-ink-2">
        <strong className="mr-1.5 font-semibold text-ink">{t('common.short.title')}</strong>{said}{locale === 'zh' ? '' : ' '}{t('common.short.back')}
      </p>
      <a className="fs-btn fs-btn-accent fs-btn-sm shrink-0" href={url} target="_blank" rel="noopener">{t('common.short.topUp')}<ArrowUpRight size={13} aria-hidden /></a>
      {s.kind === 'step' && (
        <button className="fs-icon-btn -mr-1.5 h-7 w-7 shrink-0" onClick={() => setShort(null)} aria-label={t('common.short.dismiss')} title={t('common.short.dismiss')}><X size={14} aria-hidden /></button>
      )}
    </div>
  );
}
