import { useEffect, useRef, useState } from 'react';
import { ArrowUp, AudioLines, Clock, FileText, Film, ImagePlus, Layers, Loader2, MousePointerClick, Paperclip, Pencil, Plus, Quote, Sparkles, TriangleAlert, Upload, X } from 'lucide-react';
import { client, hosted, type LibraryGroup, type ProjectView } from '../lib/client';
import { refKey, toSend, type Ref } from '../lib/refs';
import { openAssets } from '../lib/assets';
import { finished, isWorking, type RunView } from '../lib/run';
import { Lightbox, type LightItem } from './Lightbox';
import { FilmSettings } from '../components/FilmSettings';
import { reportShort } from '../components/Credits';
import { useT } from '../i18n';
import { track } from '../lib/track';
import { useNow } from '../lib/hooks';

// The message box to the director. Above the words sits a tray of references — the pages, lines and frames picked on
// the workbench, files attached, pasted or dropped — so a change request points at exactly what it means.

const MAX_REFS = 8;
const ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.md,.markdown,.txt,.pdf,.docx,.pptx,.epub';
const isImage = (name: string) => /\.(png|jpe?g|webp|gif)$/i.test(name);

/** a chip in the tray, waiting for its upload, or failed */
type Item = { key: string; ref?: Ref; name?: string; preview?: string; error?: string; ground?: Ground };

/** a logo or an icon is shown whole, on a ground of its own that doesn't follow the theme: a dark logo on a dark tile
 *  (or a light one on white) disappears. The light ground for most, the dark one for a logo made for dark grounds */
type Ground = 'light' | 'dark';
const GROUND: Record<Ground, string> = { light: '#F4F1EA', dark: '#1A1714' };
const groundOf = (kind: string): Ground | undefined => (kind === 'logo-dark' ? 'dark' : kind === 'image' ? undefined : 'light');
const isSvg = (src: string) => /^data:image\/svg|\.svg(?:[?#]|$)/i.test(src);

// While the film is being made, a message waits above the box instead of going in: a note sent mid-run was read only by
// the sessions spoken to after it, and while the pages were drawing that was often none, so it was lost. The queue goes
// to the director as one message when the run comes to rest, and until then it can be edited or removed. It is kept per
// film in this browser, so a reload doesn't lose it (but nothing is sent while no tab is open).
type Queued = { id: string; text: string; refs: Ref[] };
const QUEUE_KEY = (id: string) => `fs:queue:${id}`;
const readQueue = (id: string): Queued[] => { try { return JSON.parse(localStorage.getItem(QUEUE_KEY(id)) || '[]'); } catch { return []; } };
const writeQueue = (id: string, q: Queued[]) => { try { if (q.length) localStorage.setItem(QUEUE_KEY(id), JSON.stringify(q)); else localStorage.removeItem(QUEUE_KEY(id)); } catch { /* private mode */ } };
/** the run has to rest this long before the queue goes: the log of a run under way arrives just after the page opens,
 * and a step can hand over to the next with a beat where nothing runs */
const SETTLE_MS = 1500;

/** a change about pages (a page, a line, a frame of one in the tray) or about the whole film, as a hosted service is told */
const scopeOf = (refs: Ref[]): 'page' | 'film' => (refs.some((r) => r.kind === 'page' || r.kind === 'line' || r.kind === 'frame' || r.kind === 'thing') ? 'page' : 'film');

/** one queued message: its words (edited in place) and what it carries */
function QueuedRow({ q, project, onSave, onRemove }: { q: Queued; project: ProjectView; onSave: (text: string) => void; onRemove: () => void }) {
  const { t } = useT();
  const [draft, setDraft] = useState<string>();
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const el = box.current; if (!el) return; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 120) + 'px'; }, [draft]);
  const save = () => { if (draft != null) onSave(draft.trim()); setDraft(undefined); };
  return (
    <li className="group/q flex items-start gap-2 rounded-xl px-2.5 py-2 hover:bg-ink/[0.035]">
      <div className="min-w-0 flex-1">
        {!!q.refs.length && <div className="mb-1 flex flex-wrap gap-1">{q.refs.map((r) => <RefChip key={refKey(r)} r={r} project={project} />)}</div>}
        {draft != null
          ? <>
              <textarea ref={box} autoFocus value={draft} rows={1} onChange={(e) => setDraft(e.target.value)} onBlur={save} onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)} aria-label={t('conversation.composer.queue.edit')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); save(); }
                  else if (e.key === 'Escape') { e.preventDefault(); setDraft(undefined); }
                }}
                className="block w-full resize-none rounded-lg border border-accent/60 bg-surface px-2 py-1 text-[13px] leading-relaxed text-ink outline-none ring-4 ring-accent/10" />
              <span className="mt-1 block text-[11px] text-ink-3">{t('conversation.composer.queue.save')}</span>
            </>
          : q.text && <p className="line-clamp-3 whitespace-pre-wrap text-[13px] leading-relaxed text-ink-2">{q.text}</p>}
      </div>
      {draft == null && (
        <span className="flex shrink-0 gap-0.5 opacity-60 transition-opacity focus-within:opacity-100 group-hover/q:opacity-100">
          <button type="button" className="flex h-6 w-6 items-center justify-center rounded-md text-ink-3 hover:bg-ink/[0.08] hover:text-ink" onClick={() => setDraft(q.text)} aria-label={t('conversation.composer.queue.edit')} title={t('conversation.composer.queue.edit')}><Pencil size={12} aria-hidden /></button>
          <button type="button" className="flex h-6 w-6 items-center justify-center rounded-md text-ink-3 hover:bg-ink/[0.08] hover:text-ink" onClick={onRemove} aria-label={t('conversation.composer.queue.remove')} title={t('conversation.composer.queue.remove')}><X size={13} aria-hidden /></button>
        </span>
      )}
    </li>
  );
}

/** one reference as a chip: a picture when it has one, else its kind; the label tells which */
export function RefChip({ r, project, onRemove, onOpen, pending, error, name, preview, ground }: {
  r?: Ref; project: ProjectView; onRemove?: () => void; onOpen?: () => void; pending?: boolean; error?: string; name?: string; preview?: string; ground?: Ground;
}) {
  const { t } = useT();
  const img = preview ?? (r?.thumb ? client.fileUrl(project, r.thumb) : r?.kind === 'frame' || (r?.kind === 'thing' && r.path) ? client.fileUrl(project, r.path!) : r?.kind === 'file' && r.image ? client.fileUrl(project, r.path) : undefined);
  const Icon = error ? TriangleAlert : r?.kind === 'page' ? Layers : r?.kind === 'line' ? Quote : r?.kind === 'frame' ? Film : r?.kind === 'thing' ? MousePointerClick : r?.kind === 'voice' ? AudioLines : FileText;
  const label = r ? (r.kind === 'line' ? `${r.label}` : r.label) : name ?? '';
  const full = error ? t('conversation.composer.chipError', { name: name ?? '', error }) : r?.kind === 'line' ? t('conversation.composer.chipLine', { label: r.label, text: r.text }) : label;
  const Body = onOpen ? 'button' : 'span';
  const whole = ground ?? (img && isSvg(img) ? 'light' : undefined);
  return (
    <span className={`group/chip inline-flex h-7 max-w-full animate-pop items-center gap-1.5 rounded-lg border pl-1 text-[12px] ${onRemove ? 'pr-0.5' : 'pr-2'} ${error ? 'border-seal/40 bg-seal/[0.06] text-seal' : 'border-line bg-paper-2 text-ink-2'}`} title={full}>
      <Body type={onOpen ? 'button' : undefined} onClick={onOpen} className="inline-flex min-w-0 items-center gap-1.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent">
        {img && !error
          ? <span className="relative h-5 w-[30px] shrink-0 overflow-hidden rounded-[4px] bg-ink/10" style={whole ? { background: GROUND[whole] } : undefined}><img src={img} alt="" className={`h-full w-full ${whole ? 'object-contain p-px' : 'object-cover'}`} />{pending && <span className="absolute inset-0 flex items-center justify-center bg-black/40"><Loader2 size={11} className="animate-spin text-white" aria-hidden /></span>}</span>
          : <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] bg-ink/[0.06]">{pending ? <Loader2 size={11} className="animate-spin" aria-hidden /> : <Icon size={11} aria-hidden />}</span>}
        <span className="min-w-0 max-w-[180px] truncate">{label}</span>
        {r?.kind === 'file' && r.asset && <span className="shrink-0 rounded-[4px] bg-accent-soft px-1 py-px text-[10px] font-medium leading-tight text-accent-ink">{t('assets.badge')}</span>}
      </Body>
      {onRemove && <button type="button" onClick={onRemove} aria-label={t('conversation.composer.remove', { label })} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-ink/[0.08] hover:text-ink"><X size={12} aria-hidden /></button>}
    </span>
  );
}

/** a brand's file, and the brand it is from */
type LibraryItem = LibraryGroup['items'][number] & { brand: LibraryGroup['brand'] };

/**
 * The attach menu, when the host keeps files for the user (a hosted service's brand kits): upload as before, or pick
 * one of a brand's files, or ask for a whole brand to be applied. Above the composer, like the film's settings.
 */
function AttachMenu({ onUpload, onPick, onApply }: { onUpload: () => void; onPick: (x: LibraryItem) => void; onApply: (g: LibraryGroup) => void }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<LibraryGroup[]>();
  const [error, setError] = useState<string>();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    addEventListener('mousedown', away);
    // read each time it opens: a brand edited in another tab shows up
    let live = true;
    setError(undefined);
    client.library!().then((g) => { if (live) setGroups(g); }).catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; removeEventListener('mousedown', away); };
  }, [open]);
  const close = () => { setOpen(false); root.current?.querySelector<HTMLButtonElement>('button')?.focus(); };
  const row = 'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-ink-2 transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:bg-ink/[0.05] focus-visible:outline-none';
  const shown = groups?.filter((g) => g.items.length);

  return (
    <div ref={root} className="min-w-0">
      <button type="button" className={`fs-icon-btn ${open ? 'bg-ink/[0.07] text-ink' : ''}`} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}
        aria-label={t('conversation.composer.attach')} title={t('conversation.composer.attachTitle')}><Paperclip size={15} /></button>
      {open && (
        <div role="menu" aria-label={t('conversation.composer.attach')} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}
          className="absolute bottom-[calc(100%+8px)] left-0 z-30 w-[min(340px,100%)] overflow-hidden rounded-xl border border-line bg-surface p-1.5 shadow-[0_-12px_32px_-8px_rgb(0_0_0/0.35),0_2px_6px_rgb(0_0_0/0.12)] animate-pop [transform-origin:bottom_left]">
          <button type="button" role="menuitem" autoFocus className={row} onClick={() => { close(); onUpload(); }}>
            <Upload size={14} className="shrink-0 text-ink-3" aria-hidden /><span className="min-w-0 flex-1 truncate">{t('conversation.composer.library.upload')}</span>
          </button>
          <button type="button" role="menuitem" className={row} onClick={() => { setOpen(false); openAssets(); }} title={t('assets.composerEntryTitle')}>
            <ImagePlus size={14} className="shrink-0 text-accent-ink" aria-hidden /><span className="min-w-0 flex-1 truncate">{t('assets.composerEntry')}</span>
          </button>
          <div className="max-h-[min(360px,48vh)] overflow-y-auto">
            {error
              ? <p className="px-2.5 py-2 text-[12px] text-seal" role="alert">{t('conversation.composer.library.failed', { error })}</p>
              : !groups
                ? <p className="flex items-center gap-1.5 px-2.5 py-2 text-[12px] text-ink-3"><Loader2 size={12} className="animate-spin" aria-hidden />{t('conversation.composer.library.loading')}</p>
                : !!shown!.length && <>
                    <p className="mt-1 border-t border-line/70 px-2.5 pb-0.5 pt-2 text-[11px] font-medium uppercase tracking-wide text-ink-3">{t('conversation.composer.library.title')}</p>
                    {shown!.map((g) => (
                    <section key={g.brand.id} className="pt-1" aria-label={t('conversation.composer.library.group', { name: g.brand.name })}>
                      <h4 className="truncate px-2.5 pb-0.5 pt-1 text-[12px] font-semibold text-ink">{g.brand.name}</h4>
                      <button type="button" role="menuitem" className={row} onClick={() => { close(); onApply(g); }} title={t('conversation.composer.library.applyTitle', { name: g.brand.name })}>
                        <Sparkles size={14} className="shrink-0 text-accent-ink" aria-hidden /><span className="min-w-0 flex-1 truncate">{t('conversation.composer.library.apply')}</span>
                      </button>
                      <ul className="grid grid-cols-5 gap-1 px-1.5 pb-1.5 pt-1">
                        {g.items.map((x) => (
                          <li key={x.id}>
                            <button type="button" role="menuitem" onClick={() => { close(); onPick({ ...x, brand: g.brand }); }} title={x.name} aria-label={t('conversation.composer.add', { label: x.name })}
                              style={{ background: GROUND[groundOf(x.kind) ?? 'light'] }}
                              className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-lg border border-line p-1 outline-none transition-colors hover:border-accent/60 focus-visible:ring-2 focus-visible:ring-accent">
                              <img src={x.thumb} alt="" loading="lazy" decoding="async" className="max-h-full max-w-full object-contain" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    </section>
                    ))}
                  </>}
            {groups && !shown!.length && !error && <p className="mt-1 border-t border-line/70 px-2.5 pb-1 pt-2 text-[12px] text-ink-3">{t('conversation.composer.library.empty')}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

/** a message on its way to a film at rest, as the conversation shows it until the film's log has it; `done` once the
 *  film took it (its log may say so a moment later) */
export type Sent = { text: string; items: Item[]; at: number; done?: boolean };

/** a message on its way to a film at rest, in the conversation at once: what it says, and, past a moment, that the film's
 *  workspace is being opened (a film at rest has it put away, and opening it again takes a while) */
export function Sending({ sent, project }: { sent: Sent; project: ProjectView }) {
  const { t } = useT();
  const now = useNow(!sent.done);
  const secs = Math.max(0, Math.round((now - sent.at) / 1000));
  return (
    <div className="ml-auto flex w-fit max-w-[88%] flex-col items-end gap-1.5 animate-rise">
      {!!sent.items.length && <div className="flex flex-wrap justify-end gap-1.5">{sent.items.map((x) => <RefChip key={x.key} r={x.ref} project={project} name={x.name} preview={x.preview} ground={x.ground} />)}</div>}
      {sent.text && <p className="whitespace-pre-wrap rounded-2xl rounded-tr-md bg-accent-soft/70 px-4 py-2.5 text-[13.5px] leading-relaxed text-ink ring-1 ring-accent/15">{sent.text}</p>}
      {!sent.done && (
        <p className="flex items-center gap-1.5 text-[12px] text-ink-3" role="status">
          <Loader2 size={12} className="shrink-0 animate-spin text-accent-ink" aria-hidden />
          {secs < 2 ? t('conversation.composer.outgoing.sending') : t('conversation.composer.outgoing.opening', { n: secs })}
        </p>
      )}
    </div>
  );
}

export function Composer({ run, project, viewing, openSettings, onSent }: { run: RunView; project: ProjectView; viewing?: Ref; openSettings?: (section?: string) => void; onSent?: (s?: Sent) => void }) {
  const { t } = useT();
  const [text, setText] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  // a message to a film at rest, on its way: the box is free at once, and the conversation shows it with what is
  // happening (onSent); what was written comes back if it fails
  const [out, setOut] = useState<Sent>();
  const [drag, setDrag] = useState(false);
  const [note, setNote] = useState<string>();
  const [light, setLight] = useState<LightItem | null>(null);
  const [queue, setQueueState] = useState<Queued[]>(() => readQueue(project.id));
  const [flush, setFlush] = useState<{ sending?: boolean; error?: string }>({});
  const setQueue = (f: (q: Queued[]) => Queued[]) => setQueueState((cur) => { const next = f(cur); writeQueue(project.id, next); return next; });
  const queueRef = useRef(queue); queueRef.current = queue;
  const running = isWorking(run);
  const ref = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  // a change being written, told to a hosted service (lib/track.ts) when it starts (the box taken, a page handed over)
  // and when it goes; refs only. The box taking the focus back after a send is not a new start
  const composing = useRef(false), refocus = useRef(false), projectId = useRef(project.id);
  projectId.current = project.id;
  // a change about to be written to a film at rest: its workspace opened now (a hosted service puts it away while the
  // film rests, and opening it again takes a while), so it is likely open by the time the message goes. Once a minute
  const warmed = useRef(0), resting = useRef(false);
  resting.current = !isWorking(run);
  const warm = () => {
    if (!hosted?.warm || !resting.current || Date.now() - warmed.current < 60_000) return;
    warmed.current = Date.now();
    hosted.warm(projectId.current);
  };
  const startEdit = (scope: 'page' | 'film') => {
    if (refocus.current) return;
    warm();
    if (composing.current) return;
    composing.current = true;
    track('edit-open', { project: projectId.current, scope });
  };
  const takeFocusBack = () => { refocus.current = true; ref.current?.focus(); refocus.current = false; };
  const focus = () => requestAnimationFrame(() => { const el = ref.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });

  const add = (r: Ref) => setItems((cur) => {
    const k = refKey(r);
    if (r.kind === 'voice') return [...cur.filter((x) => x.key !== k), { key: k, ref: r }];   // one voice: the latest choice
    if (cur.some((x) => x.key === k)) return cur;
    if (cur.length >= MAX_REFS) { setNote(t('conversation.composer.maxRefs', { n: MAX_REFS })); return cur; }
    return [...cur, { key: k, ref: r }];
  });
  // the workbench hands over pages, lines and frames; “change this page”-style prompts still prefill the words
  useEffect(() => {
    const onRef = (e: Event) => { const r = (e as CustomEvent<Ref>).detail; startEdit(scopeOf([r])); add(r); focus(); };
    const onCompose = (e: Event) => { const t = (e as CustomEvent<string>).detail; startEdit('page'); setText((cur) => (cur.trim() ? cur : t)); focus(); };
    addEventListener('studio:ref', onRef); addEventListener('studio:compose', onCompose);
    return () => { removeEventListener('studio:ref', onRef); removeEventListener('studio:compose', onCompose); };
  }, []);
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(undefined), 2600); return () => clearTimeout(t); }, [note]);
  useEffect(() => { const el = ref.current; if (!el) return; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 160) + 'px'; }, [text]);

  const upload = (files: File[]) => {
    const room = MAX_REFS - items.length;
    if (files.length > room) setNote(t('conversation.composer.maxRefsDropped', { n: MAX_REFS }));
    for (const f of files.slice(0, Math.max(0, room))) {
      const key = `up:${f.name}:${f.size}:${Math.random().toString(36).slice(2, 7)}`;
      const preview = isImage(f.name) ? URL.createObjectURL(f) : undefined;
      setItems((cur) => [...cur, { key, name: f.name, preview }]);
      client.attach(project.id, f)
        .then((r) => setItems((cur) => cur.map((x) => (x.key === key ? { key: refKey(r), ref: r, preview } : x))))
        .catch((e: Error) => setItems((cur) => cur.map((x) => (x.key === key ? { ...x, error: e.message } : x))));
    }
    focus();
  };

  /** something the host puts into the project (a brand's file, or a whole brand); it waits in the tray like an upload */
  const fromHost = (item: { brand: string; asset?: string }, name: string, preview?: string, ground?: Ground) => {
    if (items.length >= MAX_REFS) { setNote(t('conversation.composer.maxRefs', { n: MAX_REFS })); return; }
    const key = `lib:${item.brand}:${item.asset ?? ''}:${Math.random().toString(36).slice(2, 7)}`;
    setItems((cur) => [...cur, { key, name, preview, ground }]);
    client.attachFrom!(project.id, item)
      .then((r) => setItems((cur) => cur.map((y) => (y.key === key ? { key: refKey(r), ref: r, preview, ground } : y))))
      .catch((e: Error) => setItems((cur) => cur.map((y) => (y.key === key ? { ...y, error: e.message } : y))));
    focus();
  };
  const fromLibrary = (x: LibraryItem) => fromHost({ brand: x.brand.id, asset: x.id }, x.name, x.thumb, groundOf(x.kind));
  /** the whole brand: the request in the box, and in the tray the brand itself (its brief and every file, which the
   *  host puts into the project), shown by its logo, to read over and send */
  const applyBrand = (g: LibraryGroup) => {
    setText((cur) => (cur.trim() ? `${cur.trimEnd()}\n\n` : '') + t('conversation.composer.library.applyText', { name: g.brand.name }));
    const logo = g.items.find((x) => x.kind === 'logo') ?? g.items.find((x) => x.kind === 'mark');
    fromHost({ brand: g.brand.id }, g.brand.name, logo?.thumb, logo ? groundOf(logo.kind) : undefined);
  };

  const refs = items.filter((x) => x.ref && !x.error).map((x) => x.ref!);
  const pending = items.some((x) => !x.ref && !x.error);
  const canSend = (!!text.trim() || refs.length > 0) && !pending;
  const revoke = (xs: Item[]) => { for (const x of xs) if (x.preview?.startsWith('blob:')) URL.revokeObjectURL(x.preview); };
  const clear = () => { setText(''); revoke(items); setItems([]); };
  const send = async () => {
    if (!canSend) return;
    track('edit-submit', { project: project.id, scope: scopeOf(refs), refs: refs.length, queued: running || queue.length > 0 });
    composing.current = false;
    // the film is being made (or a queue, or a message, is still on its way): this one waits too, after the others
    if (running || queue.length || out) {
      setQueue((q) => [...q, { id: Math.random().toString(36).slice(2, 10), text: text.trim(), refs }]);
      clear(); takeFocusBack();
      return;
    }
    const sent = { text: text.trim(), items: items.filter((x) => x.ref && !x.error), at: Date.now() };
    setOut(sent); onSent?.(sent);
    setText(''); setItems([]); takeFocusBack();
    try {
      await client.say(project.id, sent.text, toSend(refs));
      onSent?.({ ...sent, done: true });
      setTimeout(() => revoke(sent.items), 10_000);   // the conversation shows them until the film's log has the message
    } catch (e) {
      onSent?.(undefined);
      // short of credits: the notice above says so; either way what was written comes back to the box to send again,
      // unless something else has been written there meanwhile
      if (!reportShort(project.id, e)) setNote((e as Error).message);
      setText((cur) => (cur.trim() ? cur : sent.text));
      setItems((cur) => (cur.length ? (revoke(sent.items), cur) : sent.items));
    } finally { setOut(undefined); }
  };

  // the run at rest: the queue goes as one message (each would otherwise start a change of its own), the references
  // gathered, the last voice picked winning
  const sendQueue = async () => {
    const q = queueRef.current;
    if (!q.length) return;
    const text = q.map((x) => x.text).filter(Boolean).join('\n\n');
    const all = new Map<string, Ref>();
    for (const r of q.flatMap((x) => x.refs)) { const k = refKey(r); all.delete(k); all.set(k, r); }
    const voices = [...all.values()].filter((r) => r.kind === 'voice');
    const refs = [...all.values()].filter((r) => r.kind !== 'voice' || r === voices.at(-1));
    setFlush({ sending: true });
    try {
      await client.say(project.id, text, toSend(refs));
      setQueue((cur) => cur.filter((x) => !q.some((y) => y.id === x.id)));   // what was queued while it went stays
      setFlush({});
    } catch (e) {
      setFlush({ error: (e as Error).message });
      reportShort(project.id, e);
    }
  };
  useEffect(() => {
    if (running || out || !queue.length || flush.sending || flush.error) return;
    const t = setTimeout(() => void sendQueue(), SETTLE_MS);
    return () => clearTimeout(t);
  }, [running, !!out, queue.length, flush.sending, flush.error]);
  useEffect(() => { if (running) setFlush((f) => (f.error ? {} : f)); }, [running]);

  const open = (x: Item) => {
    const r = x.ref;
    const src = x.preview ?? (r?.kind === 'frame' ? client.fileUrl(project, r.path) : r?.kind === 'file' && r.image ? client.fileUrl(project, r.path) : undefined);
    if (src) setLight({ src, title: r?.label ?? x.name ?? '', caption: r?.kind === 'frame' ? r.text : undefined });
  };
  const suggest = viewing && !items.some((x) => x.key === refKey(viewing)) ? viewing : undefined;
  // the narrator: the one the user last switched to, else the one the film was made with; a switch waiting in the tray
  const voice = run.voice ?? project.voice;
  const switchTo = items.find((x) => x.ref?.kind === 'voice')?.ref as Extract<Ref, { kind: 'voice' }> | undefined;
  const narrated = run.stages.narrate.status === 'done';

  const placeholder = t(run.firstPage ? 'conversation.composer.placeholder.firstPage'
    : run.awaitingApproval ? 'conversation.composer.placeholder.approval'
    : finished(run) && !run.current ? (items.length ? 'conversation.composer.placeholder.finishedWithItems' : 'conversation.composer.placeholder.finished')
    : run.paused ? 'conversation.composer.placeholder.paused'
    : run.current ? 'conversation.composer.placeholder.running'
    : 'conversation.composer.placeholder.idle');

  return (
    <form className="px-4 pb-4" onSubmit={(e) => { e.preventDefault(); void send(); }}
      onDragEnter={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag(false); }}
      onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length) upload([...e.dataTransfer.files]); }}>
      {queue.length > 0 && (
        <section className="mb-2 rounded-2xl border border-line bg-paper px-1.5 pb-1.5 pt-2" aria-label={t('conversation.composer.queue.title', { n: queue.length })}>
          <header className="flex items-center gap-1.5 px-2.5 pb-1 text-[11.5px] text-ink-3">
            {flush.sending ? <Loader2 size={12} className="animate-spin" aria-hidden /> : flush.error ? <TriangleAlert size={12} className="text-seal" aria-hidden /> : <Clock size={12} aria-hidden />}
            <span className="font-medium text-ink-2">{t('conversation.composer.queue.title', { n: queue.length })}</span>
            <span className={`min-w-0 truncate ${flush.error ? 'text-seal' : ''}`} role="status">· {flush.sending ? t('conversation.composer.queue.sending') : flush.error ? t('conversation.composer.queue.failed', { error: flush.error }) : t('conversation.composer.queue.waiting')}</span>
            {flush.error && !running && <button type="button" className="ml-auto shrink-0 rounded-md px-1.5 text-accent-ink hover:bg-ink/[0.06]" onClick={() => void sendQueue()}>{t('conversation.composer.queue.retry')}</button>}
          </header>
          <ol className="max-h-[200px] overflow-y-auto">
            {queue.map((q) => (
              <QueuedRow key={q.id} q={q} project={project}
                onSave={(v) => setQueue((cur) => (v || q.refs.length ? cur.map((x) => (x.id === q.id ? { ...x, text: v } : x)) : cur.filter((x) => x.id !== q.id)))}
                onRemove={() => setQueue((cur) => cur.filter((x) => x.id !== q.id))} />
            ))}
          </ol>
        </section>
      )}
      <div className={`relative rounded-2xl border bg-surface shadow-[var(--fs-shadow-sm)] transition-[border-color,box-shadow] duration-150 focus-within:border-accent/70 focus-within:ring-4 focus-within:ring-accent/10 ${drag ? 'border-accent ring-4 ring-accent/15' : 'border-line'}`}>
        {items.length > 0 && (
          <div className="flex flex-wrap gap-1.5 border-b border-line/70 px-2.5 pb-2 pt-2.5" aria-label={t('conversation.composer.tray')}>
            {items.map((x) => (
              <RefChip key={x.key} r={x.ref} project={project} name={x.name} preview={x.preview} ground={x.ground} pending={!x.ref && !x.error} error={x.error}
                onOpen={(x.preview || x.ref?.kind === 'frame' || (x.ref?.kind === 'file' && x.ref.image)) ? () => open(x) : undefined}
                onRemove={() => setItems((cur) => cur.filter((y) => y.key !== x.key))} />
            ))}
          </div>
        )}
        <label htmlFor="say" className="sr-only">{t('conversation.composer.label')}</label>
        <textarea id="say" ref={ref} rows={2} value={text} onChange={(e) => { setText(e.target.value); warm(); }} placeholder={placeholder} onFocus={() => startEdit(scopeOf(refs))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
            else if (e.key === 'Backspace' && !text && items.length && e.currentTarget.selectionStart === 0) setItems((cur) => cur.slice(0, -1));
          }}
          onPaste={(e) => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); upload(files); } }}
          className="block max-h-[160px] min-h-[52px] w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-[13.5px] leading-relaxed text-ink outline-none placeholder:text-ink-3" />
        <div className="flex items-center gap-1.5 px-2 pb-2">
          {client.library && client.attachFrom
            ? <AttachMenu onUpload={() => picker.current?.click()} onPick={fromLibrary} onApply={applyBrand} />
            : <button type="button" className="fs-icon-btn" onClick={() => picker.current?.click()} aria-label={t('conversation.composer.attach')} title={t('conversation.composer.attachTitle')}><Paperclip size={15} /></button>}
          <button type="button" className="fs-icon-btn" onClick={openAssets} aria-label={t('assets.composerEntry')} title={t('assets.composerEntryTitle')}><ImagePlus size={15} /></button>
          <input ref={picker} type="file" multiple accept={ACCEPT} className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => { upload([...(e.target.files || [])]); e.target.value = ''; }} />
          <FilmSettings project={project} narrated={narrated} current={voice} pending={switchTo} openSettings={openSettings}
            onPick={(v) => {
              if (!v) setItems((cur) => cur.filter((x) => x.ref?.kind !== 'voice'));
              else add({ kind: 'voice', label: t('conversation.composer.voiceTo', { name: v.name }), provider: v.provider, id: v.id, name: v.name });
              focus();
            }} />
          {suggest && (
            <button type="button" onClick={() => { add(suggest); focus(); }} title={t('conversation.composer.add', { label: suggest.label })}
              className="inline-flex h-7 min-w-0 items-center gap-1 rounded-lg border border-dashed border-line-2 px-2 text-[12px] text-ink-3 transition-colors hover:border-accent/60 hover:text-ink">
              <Plus size={12} aria-hidden /><span className="truncate">{suggest.label.split(/[「“]/)[0].trim()}</span>
            </button>
          )}
          <span className="ml-auto truncate px-1 text-[11.5px] text-ink-3" role="status">{note ?? (pending ? t('conversation.composer.attaching') : (running || queue.length) && (text.trim() || refs.length) ? t('conversation.composer.queueHint') : switchTo ? t(narrated ? 'conversation.composer.voiceSend' : 'conversation.composer.voiceSendEarly') : suggest ? t('conversation.composer.sendHint') : t('conversation.composer.sendHintNewline'))}</span>
          <button type="submit" disabled={!canSend} aria-label={t('conversation.composer.send')} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-fg transition-[opacity,transform] duration-150 disabled:opacity-30 active:scale-95">
            <ArrowUp size={16} strokeWidth={2.5} aria-hidden />
          </button>
        </div>
        {drag && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-2xl bg-accent-soft/85 text-[13px] font-medium text-accent-ink backdrop-blur-[2px]">
            {t('conversation.composer.drop')}
          </div>
        )}
      </div>
      {light && <Lightbox items={[light]} index={0} onIndex={() => {}} onClose={() => setLight(null)} />}
    </form>
  );
}
