// References: pieces of the film (a page, a narration line, a frame) or files the user hands the director with a
// message, or the narrator to switch to (one at a time: a new choice replaces the last). The workbench offers them
// with the studio:ref window event; the composer collects them as chips.
import type { UserRef } from './client';

/** a reference as the panel holds it: `thumb` is a project-relative image for the chip, never sent */
export type Ref = UserRef & { thumb?: string };

export const refKey = (r: UserRef) =>
  r.kind === 'page' ? `page:${r.page}` : r.kind === 'line' ? `line:${r.page}:${r.at}` : r.kind === 'frame' ? `frame:${r.path}` : r.kind === 'thing' ? `thing:${r.page}:${r.fp ?? r.label}` : r.kind === 'voice' ? 'voice' : `file:${r.path}`;

export const offerRef = (r: Ref) => dispatchEvent(new CustomEvent<Ref>('studio:ref', { detail: r }));

export const toSend = (refs: Ref[]): UserRef[] => refs.map(({ thumb: _, ...r }) => r as UserRef);

export const clip = (s: string, n = 18) => (s.length > n ? s.slice(0, n) + '…' : s);
