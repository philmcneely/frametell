// Everything the director reports while it works. The local server streams these to the panel over SSE, so each event
// is small, JSON-serializable and meaningful on its own.
import type { RuntimeEvent, TokenUsage } from './runtime/types.js';
import type { LintIssue, LintKind, Storyboard } from './project.js';

/** `research` runs only when the request points at something to read or may search the web */
export type Stage = 'research' | 'storyboard' | 'script' | 'narrate' | 'pages' | 'review' | 'render';
export type PageStatus = 'queued' | 'drawing' | 'checking' | 'ok' | 'flagged' | 'failed';

/**
 * Something about a page worth telling, by where it comes from. `msg` is always there, in English or in the model's
 * words: what the agents read. A panel words what it knows (lint by `kind` and `data`, the run's own by `kind`) in its
 * language and keeps the rest to itself.
 *   lint: a check's finding, `at` seconds into the page; review: a problem the reviewer sees; agent: the page agent's
 *   reason for leaving the page as it is; run: the page could not be checked (crash), was not drawn (failed), or a
 *   change to it never landed (not-made)
 */
export type PageIssue =
  | { from: 'lint'; kind: LintKind; at: number; msg: string; data?: Record<string, string | number> }
  | { from: 'review'; at: number; msg: string }
  | { from: 'agent'; msg: string }
  | { from: 'run'; kind: 'crash' | 'failed' | 'not-made'; msg: string };

/**
 * A piece of the film or of the user's machine the user handed the director with a message: a page, a narration line,
 * a frame of the film, or a file they attached (saved under refs/); or the narrator to switch to. `label` is how the
 * panel shows it.
 */
export type UserRef =
  | { kind: 'page'; page: string; label: string }
  | { kind: 'line'; page: string; label: string; at: number; text: string }
  | { kind: 'frame'; page: string; label: string; at: number; path: string; text?: string }
  /** a thing the user picked on the picture (in an editor): where it is at `at` (stage px), what draws it (`fp`, the
   *  engine's: the page's builder call, the words its code gives it, which of those it is), the film then (`path`) */
  | { kind: 'thing'; page: string; label: string; at: number; box: { x: number; y: number; w: number; h: number }; fp?: string; path?: string }
  /** `asset`: one of the user's pictures for the film (under assets/user/), to be placed in it rather than read */
  | { kind: 'file'; label: string; path: string; image: boolean; asset?: boolean }
  /** the film's lines were changed by hand (an editor wrote script.js): narrated again, nothing redrawn */
  | { kind: 'revoice'; label: string }
  /** the narrator to use from now on: the server switches the film's voice and narrates it again, nothing is redrawn */
  | { kind: 'voice'; label: string; provider: 'volcengine' | 'elevenlabs'; id: string; name: string };

/** a pause's cause a host names (paused.code) */
export type PauseCode = 'workspace' | 'workspace-lost';

export type StudioEvent =
  | { type: 'stage'; stage: Stage; status: 'start' | 'done' | 'failed' | 'skipped'; detail?: string }
  /** a session's own activity: text, thinking summaries, tool calls, per-turn usage */
  | { type: 'agent'; session: string; event: RuntimeEvent }
  | { type: 'storyboard_check'; round: number; issues: { level: string; page?: string; beat?: number; msg: string }[] }
  /** the storyboard passed its checks and waits for the user (in CLI runs it is approved automatically) */
  | { type: 'approval'; storyboard: Storyboard; /** when the film goes on by itself if the user says nothing (ms since the epoch) */ goOnAt?: number }
  /** this film's own components (kit.ts), written before its pages: `components` the ones the pages get, `sheet` the
   *  check's contact sheet */
  | { type: 'kit'; status: 'start' | 'checking' | 'done' | 'failed'; components?: string[]; round?: number; sheet?: string; detail?: string }
  /** the film's first page is drawn and checked: the run waits (as at the storyboard) for the user to confirm the look,
   *  or say what to change in it, before the other pages are drawn */
  | { type: 'first_page'; page: string; /** when the film goes on by itself if the user says nothing (ms since the epoch) */ goOnAt?: number }
  /** nobody answered a wait (the first page's by its goOnAt, the storyboard's in a panel left open on it): the film
   *  goes on as if approved */
  | { type: 'went_on'; wait: 'storyboard' | 'first_page' }
  /** one of the film's generated pictures (pictures.ts): being drawn, drawn (`file` in the project, its size), or not
   *  had. `sample`: the film's first, which the others are drawn from; `note`: what the user asked of it */
  | { type: 'picture'; id: string; status: 'drawing' | 'done' | 'failed'; what?: string; kind?: string; sample?: boolean; file?: string; w?: number; h?: number; note?: string; detail?: string }
  | { type: 'page'; id: string; status: PageStatus; round?: number; issues?: PageIssue[]; sheet?: string; thumb?: string; note?: string }
  /** something the user said to the director (approval feedback, a note while it works, a change after the film) */
  | { type: 'user'; text: string; refs?: UserRef[] }
  /** a short line from the director that isn't a model message: how a user note will be handled, what a revision redraws */
  | { type: 'note'; text: string }
  /** a change to the finished film is drawn: each page it redrew, by number, with what its agent says it changed (in the
   *  user's language; absent when it said nothing), so a change that looks alike at a glance still says what moved */
  | { type: 'revised'; pages: { id: string; n: number; section?: string; what?: string }[] }
  /** the run stopped: the user paused, the app was closed mid-run, an error, or (a hosted service) the account ran out
   *  of credits; completed work is kept */
  | { type: 'paused'; reason: 'user' | 'interrupted' | 'error' | 'credits'; stage?: string; message?: string; /** what a host knows the
   *  error to be, for a panel to word in its language (`message` stays for any other): `workspace` its workspace (a hosted
   *  service's box) could not be opened just now, `workspace-lost` it was lost while the film was being made */ code?: PauseCode }
  /** a paused run was continued; its next step follows once the director is ready */
  | { type: 'resumed' }
  | { type: 'narrate'; page: string; index: number; total: number; cached: boolean }
  /** the film's narrator from now on (the user switched it) */
  | { type: 'voice'; voice: { provider: 'volcengine' | 'elevenlabs'; id: string; name?: string } }
  | { type: 'render'; line: string }
  | { type: 'gate'; red: boolean; blank: { at: number; seconds: number }[]; report: { name: string; value: number; unit?: string }[] }
  /** the film's running cost after a model turn: `usage` and `amount` are the film's so far; `turn` is the turn that just
   *  ran, on `model` ("provider/id", the one that really took it), for whoever prices turns on their own */
  | { type: 'cost'; usage: TokenUsage; amount: number; currency: 'CNY' | 'USD'; turn?: TokenUsage; model?: string }
  | { type: 'commit'; id: string; message: string }
  /** something a session did that it never should have to, reported as it happens (no step of the film; the call goes
   *  ahead): `source-reading`, a kit or page session reading the engine's source (`detail`: the command or path, ≤ 200
   *  characters; once per session), which means the reference it was handed fell short; `turn-budget`, a session that
   *  took all the turns it may over its life, after which nothing more is sent to it and its page or component stays
   *  as it is (`detail`: how many). A host may alert on these */
  | { type: 'anomaly'; kind: 'source-reading' | 'turn-budget'; session: string; detail: string }
  | { type: 'error'; message: string; stage?: Stage }
  /** the film is drawn and checked: it plays in the live preview. An mp4 is made only on export (then `done`) */
  | { type: 'ready'; duration: number }
  /** the page the exported film opens on was chosen (its first frame); null: the first page. `image`: a picture the
   *  user gave instead (its file in the project). An mp4 made before shows the old cover, so it is out of date */
  | { type: 'cover'; page: string | null; image?: string }
  /** the film was exported to mp4 */
  | { type: 'done'; video: string; videoNoSubs: string; duration: number; /** the copies in the user's export folder */ saved?: { withSubs: string; noSubs: string };
      /** the final plan's segment file names (no `.subs`), when a renderer named them: a hosted export is charged by these.
       *  backend / fallback: where it was drawn ('gpu' | 'render boxes') and why not on the GPU, when the renderer said */
      segments?: string[]; backend?: string; fallback?: string };

export type { LintIssue };
