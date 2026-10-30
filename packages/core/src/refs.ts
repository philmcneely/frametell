// What the user hands the director with a message. The panel sends references (a page, a narration line, a frame of the
// film, an attached file); the director gets them as a block ahead of the message, with paths it can open itself.
import fs from 'node:fs';
import path from 'node:path';
import { USER_ASSETS_DIR, type UserAsset, type UserRef } from '@frametell/agent';
import { kindOf, prepareMaterials } from './materials.js';
import { tr } from './i18n.js';

const MAX_BYTES = 20 << 20;
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
const safe = (p: string) => !path.isAbsolute(p) && !p.split(/[\\/]/).includes('..');

/**
 * Save a file the user attached into the project's refs/ folder. Documents are parsed to markdown next to it (the
 * director reads that); images and text files are used as they are. Returns the reference to send with the message.
 */
export async function attach(dir: string, name: string, data: Uint8Array, lang: 'zh' | 'en' = 'en'): Promise<UserRef> {
  if (data.byteLength > MAX_BYTES) throw new Error(tr(`「${name}」超过 20MB，换个小一点的文件`, `“${name}” is over 20 MB. Try a smaller file.`));
  const kind = kindOf(name);
  if (!kind) throw new Error(tr(`「${name}」的格式还不支持：可以附图片、Markdown / 文本、PDF、Word、PPT、EPUB`, `“${name}” isn't a supported format. Attach images, Markdown / text, PDF, Word, PowerPoint or EPUB.`));
  const refs = path.join(dir, 'refs');
  fs.mkdirSync(refs, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const file = `${stamp}-${path.basename(name).replace(/[\\/:*?"<>|\s]+/g, '_')}`;
  fs.writeFileSync(path.join(refs, file), data);
  let rel = `refs/${file}`;
  if (kind === 'document') {
    const parsed = (await prepareMaterials(refs, lang)).files.find((f) => f.name === file);
    if (!parsed?.parsedTo) throw new Error(tr(`「${name}」没能读出文字${parsed?.warning ? `：${parsed.warning}` : ''}`, `Couldn't read any text from “${name}”${parsed?.warning ? `: ${parsed.warning}` : ''}`));
    rel = `refs/${parsed.parsedTo}`;
  }
  return { kind: 'file', label: name, path: rel, image: kind === 'image' };
}

/** only references whose fields make sense, with paths inside the project */
export function cleanRefs(refs: unknown): UserRef[] {
  if (!Array.isArray(refs)) return [];
  return refs.slice(0, 12).filter((r): r is UserRef => {
    if (!r || typeof r !== 'object' || typeof (r as UserRef).label !== 'string') return false;
    const x = r as UserRef;
    if (x.kind === 'page') return typeof x.page === 'string';
    if (x.kind === 'line') return typeof x.page === 'string' && typeof x.text === 'string' && Number.isFinite(x.at);
    if (x.kind === 'frame') return typeof x.page === 'string' && typeof x.path === 'string' && safe(x.path) && Number.isFinite(x.at);
    if (x.kind === 'thing') {
      const b = x.box as Record<string, unknown> | undefined;
      return typeof x.page === 'string' && Number.isFinite(x.at) && !!b && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(b[k]))
        && (x.fp === undefined || (typeof x.fp === 'string' && x.fp.length <= 200)) && (x.path === undefined || (typeof x.path === 'string' && safe(x.path)));
    }
    if (x.kind === 'file') {
      if (typeof x.path !== 'string' || !safe(x.path)) return false;
      if (x.asset === undefined) return true;
      // one of the film's own pictures: a file right in assets/user/
      return x.asset === false || (x.asset === true && path.posix.dirname(x.path) === USER_ASSETS_DIR);
    }
    if (x.kind === 'voice') return (x.provider === 'volcengine' || x.provider === 'elevenlabs') && typeof x.id === 'string' && /^[\w.-]{1,120}$/.test(x.id) && typeof x.name === 'string';
    return false;
  });
}

/** the message as the director reads it: the references first, then what the user wrote. `assets`: the film's pictures
 *  as its list is now, for a picture's size and note */
export function withRefs(text: string, refs: UserRef[], assets: UserAsset[] = []): string {
  refs = refs.filter((r) => r.kind !== 'voice');   // the server switches the voice itself; the director needs no word of it
  if (!refs.length) return text;
  const lines = refs.map((r) => {
    if (r.kind === 'page') return `<page id="${esc(r.page)}" file="pages/${esc(r.page)}.js">${esc(r.label)}</page>`;
    if (r.kind === 'line') return `<line page="${esc(r.page)}" at="${mmss(r.at)}">${esc(r.text)}</line>`;
    if (r.kind === 'voice') return '';
    if (r.kind === 'thing') {
      // its call, its code's words and which of those (the engine's fp: "text|summer|0"), said as the director reads it
      const [call, words, k] = (r.fp ?? '').split('|');
      const drawn = r.fp ? ` drawn-by="P.${esc(call)}${words ? `(“${esc(words)}”…)` : ''}${Number(k) > 0 ? `, number ${Number(k) + 1} of those calls` : ''}"` : '';
      const box = `${Math.round(r.box.x)},${Math.round(r.box.y)} ${Math.round(r.box.w)}×${Math.round(r.box.h)}`;
      return `<thing page="${esc(r.page)}" file="pages/${esc(r.page)}.js" at="${mmss(r.at)}" box="${box}"${drawn}${r.path ? ` image="${esc(r.path)}"` : ''}>${esc(r.label)}: what the user picked on the picture (box: x,y w×h in stage pixels)${r.path ? '; open the image with read' : ''}</thing>`;
    }
    if (r.kind === 'frame') return `<frame page="${esc(r.page)}" at="${mmss(r.at)}" image="${esc(r.path)}">the film at this moment${r.text ? `, while the narration says “${esc(r.text)}”` : ''}; open the image with read</frame>`;
    if (r.asset) {
      const a = assets.find((x) => `${USER_ASSETS_DIR}/${x.file}` === r.path);
      const size = a?.w && a.h ? ` w="${a.w}" h="${a.h}"` : '';
      return `<asset path="${esc(r.path)}"${size}>${esc(a?.name || r.label)}${a?.note ? ` — ${esc(a.note)}` : ''}; the user wants this in the film: place it with P.img</asset>`;
    }
    return `<file path="${esc(r.path)}"${r.image ? ' image="true"' : ''}>${esc(r.label)}${r.image ? '; open the image with read' : ''}</file>`;
  });
  return `<references>\nThe user is pointing at these (at = time in the film):\n${lines.join('\n')}\n</references>\n\n${text || 'Please look at the above.'}`;
}
